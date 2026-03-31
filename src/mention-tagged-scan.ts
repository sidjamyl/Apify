import { dedupeByKey } from './comment-utils.js';
import type {
    InstagramPost,
    MentionEvent,
    MentionTaggedScanResult,
    TaggedAppearanceEvent,
} from './types.js';

function toIsoTimestamp(unixTimestamp: number | null): string | null {
    return unixTimestamp ? new Date(unixTimestamp * 1000).toISOString() : null;
}

function buildMentionEvent(post: InstagramPost, resolvedUsername: string): MentionEvent {
    return {
        type: 'mention',
        visibilityClass: 'public',
        resultBucket: 'supporting_activity',
        targetUsername: resolvedUsername,
        resolvedUsername,
        appearanceText: post.caption,
        createdAt: toIsoTimestamp(post.takenAtTimestamp),
        postUrl: post.url,
        postShortcode: post.shortcode,
        postOwnerUsername: post.ownerUsername,
        sourceSurface: 'instagram_post_caption_mention',
        sourceUrl: post.url,
        discoverySource: post.discoverySource,
        discoveredViaUsername: post.discoveredViaUsername,
        matchConfidence: 'exact_username_visible',
        matchReason: 'The resolved target username appears as an exact public @mention in the post caption.',
    };
}

function buildTaggedAppearanceEvent(post: InstagramPost, resolvedUsername: string): TaggedAppearanceEvent {
    return {
        type: 'tagged_appearance',
        visibilityClass: 'public',
        resultBucket: 'supporting_activity',
        targetUsername: resolvedUsername,
        resolvedUsername,
        appearanceText: post.caption,
        createdAt: toIsoTimestamp(post.takenAtTimestamp),
        postUrl: post.url,
        postShortcode: post.shortcode,
        postOwnerUsername: post.ownerUsername,
        sourceSurface: 'instagram_post_tagged_user',
        sourceUrl: post.url,
        discoverySource: post.discoverySource,
        discoveredViaUsername: post.discoveredViaUsername,
        matchConfidence: 'exact_username_visible',
        matchReason: 'The resolved target username appears in the public tagged-user metadata of the post.',
    };
}

export function scanMentionTaggedAppearances(input: {
    candidatePosts: InstagramPost[];
    resolvedUsername: string;
}): MentionTaggedScanResult {
    const { candidatePosts, resolvedUsername } = input;
    const scannedPosts = candidatePosts.filter((post) => post.ownerUsername !== resolvedUsername).length;
    const events: (MentionEvent | TaggedAppearanceEvent)[] = [];
    const warnings: string[] = [];

    for (const post of candidatePosts) {
        if (post.ownerUsername === resolvedUsername) {
            continue;
        }

        if (post.mentionedUsernames.includes(resolvedUsername)) {
            events.push(buildMentionEvent(post, resolvedUsername));
        }

        if (post.taggedUsernames.includes(resolvedUsername)) {
            events.push(buildTaggedAppearanceEvent(post, resolvedUsername));
        }
    }

    if (scannedPosts === 0) {
        warnings.push('No non-owned public candidate posts were available for mention or tagged-appearance discovery.');
    }

    return {
        scannedPosts,
        partialFailures: 0,
        warnings,
        events: dedupeByKey(events, (event) => `${event.type}:${event.postShortcode}`),
    };
}
