import { log } from 'apify';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';

import {
    classifyCommentOwnerUsername,
    dedupeByKey,
    parseCommentTextFromBlock,
} from './comment-utils.js';
import type {
    AmbiguousCommentCandidate,
    CommentEvent,
    CommentScanResult,
    InstagramPost,
    ScrapedVisibleComment,
} from './types.js';

const POST_WAIT_MS = 4_000;
const MAX_AMBIGUOUS_SAMPLES = 10;
const MAX_EXPANSION_SAFETY_STEPS = 100;
const MAX_COMMENT_API_PAGES = 250;
const COMMENT_API_HEADERS = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'X-IG-App-ID': '936619743392459',
    'X-Requested-With': 'XMLHttpRequest',
};

async function countVisibleCommentPermalinks(page: Page): Promise<number> {
    return page.evaluate(() => {
        return Array.from(document.querySelectorAll('main a[href*="/c/"]')).filter((anchor) => {
            const href = anchor.getAttribute('href') ?? '';
            return /^\/p\/[^/]+\/c\/\d+\/$/.test(href) && Boolean(anchor.querySelector('time'));
        }).length;
    });
}

interface RawDomCommentCandidate extends ScrapedVisibleComment {
    rawText: string;
    rawTextLength: number;
}

interface StructuredCommentFetchResult {
    comments: ScrapedVisibleComment[];
    warnings: string[];
    scannedCount: number;
}

interface RefreshedPagePostMetadata {
    ownerUsername: string | null;
    caption: string | null;
    mediaId: string | null;
    mentionedUsernames: string[];
}

interface RawApiComment {
    pk?: string;
    text?: string;
    created_at?: number;
    user?: {
        username?: string;
    };
    child_comment_count?: number;
    preview_child_comments?: RawApiComment[];
    child_comments?: RawApiComment[];
}

function toIsoDate(createdAt: number | undefined): string | null {
    return typeof createdAt === 'number' ? new Date(createdAt * 1000).toISOString() : null;
}

function buildCommentPermalink(shortcode: string, pk: string | undefined): string {
    return pk ? `https://www.instagram.com/p/${shortcode}/c/${pk}/` : `https://www.instagram.com/p/${shortcode}/`;
}

function mapApiComment(comment: RawApiComment, post: InstagramPost, commentKind: 'top_level' | 'reply', replyDepth: number, parentCommentPermalink: string | null): ScrapedVisibleComment | null {
    const ownerUsername = comment.user?.username?.toLowerCase();
    const commentText = comment.text?.trim();
    if (!ownerUsername || !commentText) return null;

    return {
        ownerUsername,
        commentKind,
        replyDepth,
        parentCommentPermalink,
        commentText,
        createdAt: toIsoDate(comment.created_at),
        createdAtLabel: null,
        commentPermalink: buildCommentPermalink(post.shortcode, comment.pk),
    };
}

async function fetchStructuredCommentsForPost(post: InstagramPost): Promise<StructuredCommentFetchResult | null> {
    if (!post.mediaId || !/^\d+$/.test(post.mediaId)) {
        return null;
    }

    const warnings: string[] = [];
    const comments: ScrapedVisibleComment[] = [];
    let scannedCount = 0;
    let nextMinId: string | null = null;

    for (let pageIndex = 0; pageIndex < MAX_COMMENT_API_PAGES; pageIndex++) {
        const endpointUrl = new URL(`https://www.instagram.com/api/v1/media/${post.mediaId}/comments/`);
        endpointUrl.searchParams.set('can_support_threading', 'true');
        endpointUrl.searchParams.set('permalink_enabled', 'false');
        if (nextMinId) {
            endpointUrl.searchParams.set('min_id', nextMinId);
        }

        let responseText: string;
        try {
            const response = await fetch(endpointUrl, {
                headers: {
                    ...COMMENT_API_HEADERS,
                    Referer: post.url,
                },
                signal: AbortSignal.timeout(30_000),
            });

            if (!response.ok) {
                if (pageIndex === 0) return null;
                warnings.push(`Structured comment API returned HTTP ${response.status} for ${post.url}.`);
                break;
            }

            responseText = await response.text();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown structured comment fetch error.';
            if (pageIndex === 0) return null;
            warnings.push(`Structured comment API failed for ${post.url}: ${message}`);
            break;
        }

        let payload: { comments?: RawApiComment[]; next_min_id?: string | null; status?: string; };
        try {
            payload = JSON.parse(responseText) as { comments?: RawApiComment[]; next_min_id?: string | null; status?: string; };
        } catch {
            if (pageIndex === 0) {
                return null;
            }
            warnings.push(`Structured comment API returned a non-JSON payload for ${post.url}.`);
            break;
        }

        const pageComments = payload.comments ?? [];
        for (const comment of pageComments) {
            const topLevelComment = mapApiComment(comment, post, 'top_level', 0, null);
            if (topLevelComment) {
                comments.push(topLevelComment);
                scannedCount += 1;
            }

            const previewChildComments = comment.preview_child_comments ?? comment.child_comments ?? [];
            const parentCommentPermalink = buildCommentPermalink(post.shortcode, comment.pk);
            for (const childComment of previewChildComments) {
                const replyComment = mapApiComment(childComment, post, 'reply', 1, parentCommentPermalink);
                if (replyComment) {
                    comments.push(replyComment);
                    scannedCount += 1;
                }
            }
        }

        nextMinId = payload.next_min_id ?? null;
        if (!nextMinId || pageComments.length === 0) {
            break;
        }
    }

    return {
        comments: dedupeByKey(comments, (comment) => comment.commentPermalink),
        warnings,
        scannedCount,
    };
}

async function refreshPostMetadataFromPage(page: Page): Promise<RefreshedPagePostMetadata> {
    return page.evaluate(() => {
        const metas = Array.from(document.querySelectorAll('meta')).map((meta) => ({
            property: meta.getAttribute('property'),
            name: meta.getAttribute('name'),
            content: meta.getAttribute('content'),
        }));
        const canonical = metas.find((meta) => meta.property === 'og:url')?.content ?? null;
        const description = metas.find((meta) => meta.name === 'description' || meta.property === 'og:description')?.content ?? null;
        const ownerFromDescription = description?.match(/-\s*([A-Za-z0-9._]+)\s+on\s/i)?.[1]?.toLowerCase() ?? null;
        const ownerFromCanonical = canonical?.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel)\//i)?.[1]?.toLowerCase() ?? null;
        const caption = description?.includes(':')
            ? description.split(/:\s*/).slice(1).join(': ').trim().replace(/^"|"\.?\s*$/g, '')
            : null;
        const mentionedUsernames = caption
            ? Array.from(caption.matchAll(/@([A-Za-z0-9._]+)/g)).map((match) => match[1].toLowerCase())
            : [];
        const html = document.documentElement.innerHTML;
        const mediaId = html.match(/instagram:\/\/media\?id=(\d+)/)?.[1] ?? null;

        return {
            ownerUsername: ownerFromDescription ?? ownerFromCanonical,
            caption,
            mediaId,
            mentionedUsernames,
        };
    });
}

async function tryExpandVisibleComments(page: Page): Promise<void> {
    let previousCount = await countVisibleCommentPermalinks(page);

    for (let index = 0; index < MAX_EXPANSION_SAFETY_STEPS; index++) {
        const clicked = await page.evaluate(() => {
            const button = Array.from(document.querySelectorAll('button')).find((element) => {
                return (element.textContent ?? '').trim() === 'Load more comments';
            });

            if (!button) return false;
            button.click();
            return true;
        });

        if (!clicked) return;
        await page.waitForTimeout(1_500);
        const nextCount = await countVisibleCommentPermalinks(page);
        if (nextCount <= previousCount) return;
        previousCount = nextCount;
    }
}

async function tryExpandReplies(page: Page): Promise<void> {
    let previousCount = await countVisibleCommentPermalinks(page);

    for (let index = 0; index < MAX_EXPANSION_SAFETY_STEPS; index++) {
        const clickedCount = await page.evaluate(() => {
            const replyButtons = Array.from(document.querySelectorAll('button')).filter((element) => {
                const text = (element.textContent ?? '').trim();
                if (!text || text === 'Reply') return false;
                return /(view|show|more).*(repl)/i.test(text);
            });

            for (const button of replyButtons) {
                button.click();
            }

            return replyButtons.length;
        });

        if (clickedCount === 0) return;
        await page.waitForTimeout(1_500);
        const nextCount = await countVisibleCommentPermalinks(page);
        if (nextCount <= previousCount) return;
        previousCount = nextCount;
    }
}

async function extractVisibleComments(page: Page): Promise<ScrapedVisibleComment[]> {
    const rawCandidates = await page.evaluate(() => {
        const normalizeHref = (href: string | null) => href ?? '';
        const isProfileHref = (href: string) => /^\/[A-Za-z0-9._]+\/$/.test(href);
        const isCommentPermalink = (href: string) => /^\/p\/[^/]+\/c\/\d+\/$/.test(href);

        const findCandidateContainer = (anchor: HTMLAnchorElement): HTMLElement | null => {
            let currentElement: HTMLElement | null = anchor.parentElement;

            while (currentElement && currentElement.tagName !== 'MAIN') {
                const innerText = (currentElement.innerText ?? '').trim();
                const profileAnchors = Array.from(currentElement.querySelectorAll('a')).filter((candidateAnchor) => {
                    const href = normalizeHref(candidateAnchor.getAttribute('href'));
                    const text = (candidateAnchor.textContent ?? '').trim();
                    return Boolean(text) && isProfileHref(href);
                });

                if (
                    innerText.includes('Like')
                    && innerText.includes('Reply')
                    && profileAnchors.length > 0
                    && innerText.length < 320
                ) {
                    return currentElement;
                }

                currentElement = currentElement.parentElement;
            }

            return null;
        };

        const permalinkAnchors = Array.from(document.querySelectorAll('main a[href*="/c/"]'))
            .filter((anchor): anchor is HTMLAnchorElement => {
                const href = normalizeHref(anchor.getAttribute('href'));
                return isCommentPermalink(href) && Boolean(anchor.querySelector('time'));
            });

        const candidateEntries = permalinkAnchors
            .map((permalinkAnchor) => {
                const commentPermalink = new URL(permalinkAnchor.getAttribute('href') ?? '', window.location.origin).toString();
                const candidateContainer = findCandidateContainer(permalinkAnchor);
                if (!candidateContainer) return null;

                const anchors = Array.from(candidateContainer.querySelectorAll('a')).map((anchor) => ({
                    href: normalizeHref(anchor.getAttribute('href')),
                    text: (anchor.textContent ?? '').trim(),
                }));
                const usernameAnchor = anchors.find((anchor) => anchor.text && isProfileHref(anchor.href));
                if (!usernameAnchor) return null;

                const timeElement = permalinkAnchor.querySelector('time');
                if (!timeElement) return null;

                return {
                    commentPermalink,
                    container: candidateContainer,
                    ownerUsername: usernameAnchor.text.toLowerCase(),
                    rawText: (candidateContainer.innerText ?? '').trim(),
                    rawTextLength: (candidateContainer.innerText ?? '').trim().length,
                    createdAt: timeElement.getAttribute('datetime') ?? null,
                    createdAtLabel: (permalinkAnchor.textContent ?? '').trim() || null,
                };
            })
            .filter((candidate): candidate is {
                commentPermalink: string;
                container: HTMLElement;
                ownerUsername: string;
                rawText: string;
                rawTextLength: number;
                createdAt: string | null;
                createdAtLabel: string | null;
            } => candidate !== null)
            .sort((left, right) => left.rawTextLength - right.rawTextLength);

        const dedupedEntries = new Map<string, typeof candidateEntries[number]>();
        for (const candidateEntry of candidateEntries) {
            if (!dedupedEntries.has(candidateEntry.commentPermalink)) {
                dedupedEntries.set(candidateEntry.commentPermalink, candidateEntry);
            }
        }

        const uniqueEntries = [...dedupedEntries.values()];

        return uniqueEntries.map((entry) => {
            const parentCandidates = uniqueEntries.filter((candidate) => {
                return candidate.commentPermalink !== entry.commentPermalink
                    && candidate.container.contains(entry.container);
            });

            const directParent = parentCandidates
                .sort((left, right) => left.rawTextLength - right.rawTextLength)[0] ?? null;
            const parentCommentPermalink = directParent?.commentPermalink ?? null;

            let replyDepth = 0;
            let currentParent = directParent;
            while (currentParent) {
                replyDepth += 1;
                const currentParentPermalink = currentParent.commentPermalink;
                const currentParentContainer = currentParent.container;
                currentParent = uniqueEntries
                    .filter((candidate) => {
                        return candidate.commentPermalink !== currentParentPermalink
                            && candidate.container.contains(currentParentContainer);
                    })
                    .sort((left, right) => left.rawTextLength - right.rawTextLength)[0] ?? null;
            }

            return {
                ownerUsername: entry.ownerUsername,
                commentKind: replyDepth > 0 ? 'reply' : 'top_level',
                replyDepth,
                parentCommentPermalink,
                rawText: entry.rawText,
                commentText: entry.rawText,
                createdAt: entry.createdAt,
                createdAtLabel: entry.createdAtLabel,
                commentPermalink: entry.commentPermalink,
                rawTextLength: entry.rawTextLength,
            } satisfies RawDomCommentCandidate;
        });
    });

    return dedupeByKey(rawCandidates, (candidate) => candidate.commentPermalink).map((candidate) => ({
        ownerUsername: candidate.ownerUsername,
        commentKind: candidate.commentKind,
        replyDepth: candidate.replyDepth,
        parentCommentPermalink: candidate.parentCommentPermalink,
        commentText: parseCommentTextFromBlock(
            candidate.rawText,
            candidate.ownerUsername,
            candidate.createdAtLabel,
        ),
        createdAt: candidate.createdAt,
        createdAtLabel: candidate.createdAtLabel,
        commentPermalink: candidate.commentPermalink,
    }));
}

function buildCommentEvents(input: {
    post: InstagramPost;
    comments: ScrapedVisibleComment[];
    resolvedUsername: string;
}): CommentEvent[] {
    const { post, comments, resolvedUsername } = input;

    return comments.map((comment) => ({
        type: 'comment',
        visibilityClass: 'public',
        resultBucket: 'confirmed_comments',
        targetUsername: resolvedUsername,
        resolvedUsername,
        commentOwnerUsername: comment.ownerUsername,
        commentKind: comment.commentKind,
        replyDepth: comment.replyDepth,
        parentCommentPermalink: comment.parentCommentPermalink,
        commentText: comment.commentText,
        createdAt: comment.createdAt,
        createdAtLabel: comment.createdAtLabel,
        commentPermalink: comment.commentPermalink,
        postUrl: post.url,
        postShortcode: post.shortcode,
        postOwnerUsername: post.ownerUsername,
        sourceSurface: 'instagram_post_comment_thread',
        sourceUrl: comment.commentPermalink,
        discoverySource: post.discoverySource,
        discoveredViaUsername: post.discoveredViaUsername,
        matchConfidence: 'exact_username_visible',
        matchReason: comment.commentKind === 'reply'
            ? 'Visible Instagram reply owner username matched the resolved target username exactly.'
            : 'Visible Instagram comment owner username matched the resolved target username exactly.',
    }));
}

export async function scanCommentsOnCandidatePosts(input: {
    candidatePosts: InstagramPost[];
    resolvedUsername: string;
}): Promise<CommentScanResult> {
    const { candidatePosts, resolvedUsername } = input;

    if (candidatePosts.length === 0) {
        return {
            browserAvailable: true,
            scannedPosts: 0,
            visibleCommentsScanned: 0,
            structuredCommentsScanned: 0,
            partialFailures: 0,
            warnings: ['No candidate public posts were available for comment scanning.'],
            events: [],
            ambiguousCandidates: [],
        };
    }

    const warnings: string[] = [
        'Comment coverage is limited to visible public comment blocks available without Instagram login.',
    ];
    const ambiguousCandidates: AmbiguousCommentCandidate[] = [];

    let browser: Browser | null = null;
    let page: Page | null = null;
    let scannedPosts = 0;
    let visibleCommentsScanned = 0;
    let structuredCommentsScanned = 0;
    let partialFailures = 0;
    const matchedEvents: CommentEvent[] = [];

    for (const post of candidatePosts) {
        try {
            scannedPosts += 1;
            let visibleComments: ScrapedVisibleComment[] = [];

            const structuredComments = await fetchStructuredCommentsForPost(post);
            if (structuredComments) {
                visibleComments = structuredComments.comments;
                structuredCommentsScanned += structuredComments.scannedCount;
                warnings.push(...structuredComments.warnings);
            } else {
                if (!browser) {
                    try {
                        browser = await chromium.launch({ headless: true });
                        page = await browser.newPage({ viewport: { width: 1280, height: 2200 } });
                    } catch (error) {
                        const message = error instanceof Error ? error.message : 'Unknown browser launch error.';
                        warnings.push(`Browser fallback is unavailable in the current runtime: ${message}`);
                        return {
                            browserAvailable: false,
                            scannedPosts,
                            visibleCommentsScanned,
                            structuredCommentsScanned,
                            partialFailures: partialFailures + 1,
                            warnings,
                            events: dedupeByKey(matchedEvents, (event) => event.commentPermalink),
                            ambiguousCandidates,
                        };
                    }
                }

                if (!page) {
                    throw new Error('Browser page is not available for DOM fallback.');
                }

                await page.goto(post.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
                await page.waitForTimeout(POST_WAIT_MS);
                const refreshedMetadata = await refreshPostMetadataFromPage(page);
                post.ownerUsername = refreshedMetadata.ownerUsername ?? post.ownerUsername;
                post.caption = refreshedMetadata.caption ?? post.caption;
                post.mediaId = refreshedMetadata.mediaId ?? post.mediaId;
                post.mentionedUsernames = refreshedMetadata.mentionedUsernames.length > 0
                    ? refreshedMetadata.mentionedUsernames
                    : post.mentionedUsernames;
                await tryExpandVisibleComments(page);
                await tryExpandReplies(page);
                visibleComments = await extractVisibleComments(page);
                visibleCommentsScanned += visibleComments.length;
            }

            const matchedComments = visibleComments.filter((comment) => {
                const classification = classifyCommentOwnerUsername(comment.ownerUsername, resolvedUsername);

                if (classification === 'ambiguous' && ambiguousCandidates.length < MAX_AMBIGUOUS_SAMPLES) {
                    ambiguousCandidates.push({
                        type: 'comment',
                        visibilityClass: 'ambiguous',
                        resultBucket: 'ambiguous_candidates',
                        commentOwnerUsername: comment.ownerUsername,
                        commentKind: comment.commentKind,
                        replyDepth: comment.replyDepth,
                        parentCommentPermalink: comment.parentCommentPermalink,
                        commentTextPreview: comment.commentText.slice(0, 180),
                        createdAt: comment.createdAt,
                        createdAtLabel: comment.createdAtLabel,
                        commentPermalink: comment.commentPermalink,
                        postUrl: post.url,
                        postShortcode: post.shortcode,
                        postOwnerUsername: post.ownerUsername,
                        discoverySource: post.discoverySource,
                        discoveredViaUsername: post.discoveredViaUsername,
                        ambiguityReason: 'Visible comment owner username is similar after punctuation normalization, but does not exactly equal the resolved target username.',
                    });
                }

                return classification === 'confirmed';
            });

            matchedEvents.push(...buildCommentEvents({
                post,
                comments: matchedComments,
                resolvedUsername,
            }));
        } catch (error) {
            partialFailures += 1;
            const message = error instanceof Error ? error.message : 'Unknown comment scan error.';
            warnings.push(`Failed to inspect visible comments for ${post.url}: ${message}`);
            log.warning(`Failed to inspect ${post.url}: ${message}`);
        }
    }

    await page?.close();
    await browser?.close();

    return {
        browserAvailable: true,
        scannedPosts,
        visibleCommentsScanned,
        structuredCommentsScanned,
        partialFailures,
        warnings: ambiguousCandidates.length > 0
            ? [
                ...warnings,
                `Flagged ${ambiguousCandidates.length} ambiguous comment candidate(s) separately from confirmed matches.`,
            ]
            : warnings,
        events: dedupeByKey(
            matchedEvents.sort((left, right) => {
                const leftTimestamp = left.createdAt ? Date.parse(left.createdAt) : 0;
                const rightTimestamp = right.createdAt ? Date.parse(right.createdAt) : 0;
                return rightTimestamp - leftTimestamp;
            }),
            (event) => event.commentPermalink,
        ),
        ambiguousCandidates,
    };
}
