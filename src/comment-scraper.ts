import { log } from 'apify';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';

import { dedupeByKey, parseCommentTextFromBlock } from './comment-utils.js';
import type {
    CommentEvent,
    CommentScanResult,
    InstagramPost,
    ScrapedVisibleComment,
} from './types.js';

const POST_WAIT_MS = 4_000;
const MAX_COMMENT_EXPANSION_STEPS = 2;

interface RawDomCommentCandidate extends ScrapedVisibleComment {
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

async function extractVisibleComments(page: Page): Promise<ScrapedVisibleComment[]> {
    const rawCandidates = await page.evaluate(() => {
        const normalizeHref = (href: string | null) => href ?? '';
        const isProfileHref = (href: string) => /^\/[A-Za-z0-9._]+\/$/.test(href);
        const isCommentPermalink = (href: string) => /^\/p\/[^/]+\/c\/\d+\/$/.test(href);

        return Array.from(document.querySelectorAll('main div'))
            .map((element) => {
                const innerText = ((element as HTMLElement).innerText ?? '').trim();
                const anchors = Array.from(element.querySelectorAll('a')).map((anchor) => ({
                    href: normalizeHref(anchor.getAttribute('href')),
                    text: (anchor.textContent ?? '').trim(),
                }));

                const usernameAnchor = anchors.find((anchor) => anchor.text && isProfileHref(anchor.href));
                const commentPermalinkAnchor = anchors.find((anchor) => isCommentPermalink(anchor.href));
                const timeElement = commentPermalinkAnchor
                    ? element.querySelector(`a[href="${commentPermalinkAnchor.href}"] time`)
                    : null;

                if (!innerText.includes('Like') || !innerText.includes('Reply')) return null;
                if (!usernameAnchor || !commentPermalinkAnchor) return null;
                if (innerText.length < 15 || innerText.length > 300) return null;

                const createdAtLabel = commentPermalinkAnchor.text || null;
                const commentText = (() => {
                    const ignoredLines = new Set(['Like', 'Reply', 'Edited']);
                    return innerText
                        .replace(/\u00a0/g, ' ')
                        .split('\n')
                        .map((line: string) => line.trim())
                        .filter(Boolean)
                        .filter((line: string) => !ignoredLines.has(line))
                        .filter((line: string) => line !== usernameAnchor.text)
                        .filter((line: string) => line !== createdAtLabel)
                        .join('\n')
                        .trim();
                })();

                if (!commentText) return null;

                return {
                    ownerUsername: usernameAnchor.text.toLowerCase(),
                    commentText,
                    createdAt: timeElement?.getAttribute('datetime') ?? null,
                    createdAtLabel,
                    commentPermalink: new URL(commentPermalinkAnchor.href, window.location.origin).toString(),
                    rawTextLength: innerText.length,
                };
            })
            .filter((candidate): candidate is RawDomCommentCandidate => candidate !== null)
            .sort((left, right) => left.rawTextLength - right.rawTextLength);
    });

    return dedupeByKey(rawCandidates, (candidate) => candidate.commentPermalink).map((candidate) => ({
        ownerUsername: candidate.ownerUsername,
        commentText: parseCommentTextFromBlock(
            `${candidate.ownerUsername}\n${candidate.createdAtLabel ?? ''}\n${candidate.commentText}\nLike\nReply`,
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
        matchReason: 'Visible Instagram comment owner username matched the resolved target username exactly.',
    }));
}

export async function scanCommentsOnCandidatePosts(input: {
    candidatePosts: InstagramPost[];
    resolvedUsername: string;
}): Promise<CommentScanResult> {
    const { candidatePosts, resolvedUsername } = input;
    const warnings: string[] = [
        'Comment coverage is limited to visible public comment blocks available without Instagram login.',
    ];

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

            const visibleComments = await extractVisibleComments(page);
            scannedPosts += 1;
            visibleCommentsScanned += visibleComments.length;

            const matchedComments = visibleComments.filter((comment) => comment.ownerUsername === resolvedUsername);
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
        warnings,
        events: dedupeByKey(
            matchedEvents.sort((left, right) => {
                const leftTimestamp = left.createdAt ? Date.parse(left.createdAt) : 0;
                const rightTimestamp = right.createdAt ? Date.parse(right.createdAt) : 0;
                return rightTimestamp - leftTimestamp;
            }),
            (event) => event.commentPermalink,
        ),
    };
}
