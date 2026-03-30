import {
    canonicalizeUsernameForMatching,
    classifyCommentOwnerUsername,
    dedupeByKey,
} from './comment-utils.js';
import type {
    AmbiguousLikedContentCandidate,
    InstagramPost,
    LikedContentEvent,
    LikedContentScanResult,
} from './types.js';

const MAX_AMBIGUOUS_SAMPLES = 10;

function buildLikedContentEvent(post: InstagramPost, resolvedUsername: string): LikedContentEvent {
    return {
        type: 'liked_content',
        targetUsername: resolvedUsername,
        resolvedUsername,
        appearanceText: post.caption,
        createdAt: null,
        postUrl: post.url,
        postShortcode: post.shortcode,
        postOwnerUsername: post.ownerUsername,
        sourceSurface: 'instagram_post_public_like_signal',
        sourceUrl: post.url,
        discoverySource: post.discoverySource,
        discoveredViaUsername: post.discoveredViaUsername,
        matchConfidence: 'exact_username_visible',
        matchReason: 'The resolved target username appeared in a publicly attributable liker signal exposed on the post.',
    };
}

export function scanLikedContentAppearances(input: {
    candidatePosts: InstagramPost[];
    resolvedUsername: string;
}): LikedContentScanResult {
    const { candidatePosts, resolvedUsername } = input;
    const ambiguousCandidates: AmbiguousLikedContentCandidate[] = [];
    const events: LikedContentEvent[] = [];
    const warnings: string[] = [
        'Liked-content recovery is experimental and depends on Instagram exposing attributable liker usernames on scanned public surfaces.',
    ];

    const eligiblePosts = candidatePosts.filter((post) => post.ownerUsername !== resolvedUsername);
    let discoverableSignals = 0;

    for (const post of eligiblePosts) {
        const likerUsernames = dedupeByKey(post.discoverableLikerUsernames, (username) => username);
        if (likerUsernames.length > 0) {
            discoverableSignals += 1;
        }

        for (const likerUsername of likerUsernames) {
            const classification = classifyCommentOwnerUsername(likerUsername, resolvedUsername);
            if (classification === 'confirmed') {
                events.push(buildLikedContentEvent(post, resolvedUsername));
                break;
            }

            if (classification === 'ambiguous' && ambiguousCandidates.length < MAX_AMBIGUOUS_SAMPLES) {
                ambiguousCandidates.push({
                    likerUsername,
                    postUrl: post.url,
                    postShortcode: post.shortcode,
                    postOwnerUsername: post.ownerUsername,
                    discoverySource: post.discoverySource,
                    discoveredViaUsername: post.discoveredViaUsername,
                    ambiguityReason: canonicalizeUsernameForMatching(likerUsername) === canonicalizeUsernameForMatching(resolvedUsername)
                        ? 'A public liker username signal was similar only after punctuation normalization, so it was kept as ambiguous instead of confirmed.'
                        : 'A weak public liker signal was observed but could not be confirmed exactly.',
                });
            }
        }
    }

    if (discoverableSignals === 0) {
        warnings.push('No attributable public liker usernames were exposed on the scanned candidate posts, so liked-content results may be empty even when likes exist.');
    }

    if (ambiguousCandidates.length > 0) {
        warnings.push(`Flagged ${ambiguousCandidates.length} ambiguous liked-content candidate(s) separately from confirmed results.`);
    }

    return {
        scannedPosts: eligiblePosts.length,
        discoverableSignals,
        partialFailures: 0,
        warnings,
        events: dedupeByKey(events, (event) => `${event.type}:${event.postShortcode}`),
        ambiguousCandidates,
    };
}
