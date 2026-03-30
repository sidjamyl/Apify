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
const MAX_COMMENT_EXPANSION_STEPS = 2;
const MAX_REPLY_EXPANSION_STEPS = 2;
const MAX_AMBIGUOUS_SAMPLES = 10;

interface RawDomCommentCandidate extends ScrapedVisibleComment {
    rawText: string;
    rawTextLength: number;
}

async function tryExpandVisibleComments(page: Page): Promise<void> {
    for (let index = 0; index < MAX_COMMENT_EXPANSION_STEPS; index++) {
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
    }
}

async function tryExpandReplies(page: Page): Promise<void> {
    for (let index = 0; index < MAX_REPLY_EXPANSION_STEPS; index++) {
        const clickedCount = await page.evaluate(() => {
            const replyButtons = Array.from(document.querySelectorAll('button')).filter((element) => {
                const text = (element.textContent ?? '').trim();
                if (!text || text === 'Reply') return false;
                return /(view|show|more).*(repl)/i.test(text);
            });

            for (const button of replyButtons.slice(0, 10)) {
                button.click();
            }

            return replyButtons.length;
        });

        if (clickedCount === 0) return;
        await page.waitForTimeout(1_500);
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
    try {
        browser = await chromium.launch({ headless: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown browser launch error.';
        warnings.push(`Browser fallback is unavailable in the current runtime: ${message}`);

        return {
            browserAvailable: false,
            scannedPosts: 0,
            visibleCommentsScanned: 0,
            partialFailures: candidatePosts.length > 0 ? 1 : 0,
            warnings,
            events: [],
            ambiguousCandidates,
        };
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 2200 } });
    let scannedPosts = 0;
    let visibleCommentsScanned = 0;
    let partialFailures = 0;
    const matchedEvents: CommentEvent[] = [];

    for (const post of candidatePosts) {
        try {
            await page.goto(post.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            await page.waitForTimeout(POST_WAIT_MS);
            await tryExpandVisibleComments(page);
            await tryExpandReplies(page);

            const visibleComments = await extractVisibleComments(page);
            scannedPosts += 1;
            visibleCommentsScanned += visibleComments.length;

            const matchedComments = visibleComments.filter((comment) => {
                const classification = classifyCommentOwnerUsername(comment.ownerUsername, resolvedUsername);

                if (classification === 'ambiguous' && ambiguousCandidates.length < MAX_AMBIGUOUS_SAMPLES) {
                    ambiguousCandidates.push({
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

    await page.close();
    await browser.close();

    return {
        browserAvailable: true,
        scannedPosts,
        visibleCommentsScanned,
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
