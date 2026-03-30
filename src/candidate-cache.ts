import type { KeyValueStore } from 'apify';
import { Actor } from 'apify';

import { dedupeByKey } from './comment-utils.js';
import type { InstagramPost, TargetCandidateCacheState } from './types.js';

export const CANDIDATE_DISCOVERY_CACHE_STORE_NAME = 'candidate-discovery-cache';
const POST_KEY_PREFIX = 'POST__';
const TARGET_KEY_PREFIX = 'TARGET__';

function buildPostKey(shortcode: string): string {
    return `${POST_KEY_PREFIX}${shortcode}`;
}

function buildTargetKey(targetUsername: string): string {
    return `${TARGET_KEY_PREFIX}${targetUsername.toLowerCase()}`;
}

export async function openCandidateDiscoveryCacheStore(): Promise<KeyValueStore> {
    return Actor.openKeyValueStore(CANDIDATE_DISCOVERY_CACHE_STORE_NAME);
}

export async function loadTargetCandidateCache(input: {
    store: KeyValueStore;
    targetUsername: string;
}): Promise<TargetCandidateCacheState | null> {
    const { store, targetUsername } = input;
    return store.getValue<TargetCandidateCacheState>(buildTargetKey(targetUsername));
}

export async function loadCachedCandidatePosts(input: {
    store: KeyValueStore;
    shortcodes: string[];
}): Promise<InstagramPost[]> {
    const { store, shortcodes } = input;
    const posts: InstagramPost[] = [];

    for (const shortcode of shortcodes) {
        const post = await store.getValue<InstagramPost>(buildPostKey(shortcode));
        if (post) {
            posts.push(post);
        }
    }

    return dedupeByKey(posts, (post) => post.shortcode);
}

export async function persistCandidateDiscoveryCache(input: {
    store: KeyValueStore;
    targetUsername: string;
    candidatePosts: InstagramPost[];
    fruitfulOwnerUsernames: string[];
    previousState: TargetCandidateCacheState | null;
}): Promise<TargetCandidateCacheState> {
    const {
        store,
        targetUsername,
        candidatePosts,
        fruitfulOwnerUsernames,
        previousState,
    } = input;

    for (const candidatePost of candidatePosts) {
        await store.setValue(buildPostKey(candidatePost.shortcode), candidatePost);
    }

    const nextState: TargetCandidateCacheState = {
        version: 1,
        targetUsername: targetUsername.toLowerCase(),
        updatedAt: new Date().toISOString(),
        candidateShortcodes: dedupeByKey(
            [
                ...(previousState?.candidateShortcodes ?? []),
                ...candidatePosts.map((post) => post.shortcode),
            ],
            (shortcode) => shortcode,
        ),
        fruitfulOwnerUsernames: dedupeByKey(
            [
                ...(previousState?.fruitfulOwnerUsernames ?? []),
                ...fruitfulOwnerUsernames.map((username) => username.toLowerCase()),
            ],
            (username) => username,
        ),
    };

    await store.setValue(buildTargetKey(targetUsername), nextState);
    return nextState;
}
