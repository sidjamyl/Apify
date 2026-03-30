import { log } from 'apify';

import { dedupeByKey, extractMentionedUsernames } from './comment-utils.js';
import type { DiscoverySource, InstagramPost, ResolvedTarget, SearchMode } from './types.js';

const INSTAGRAM_WEB_APP_ID = '936619743392459';
const PROFILE_HEADERS = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'X-IG-App-ID': INSTAGRAM_WEB_APP_ID,
    'X-Requested-With': 'XMLHttpRequest',
};

const MAX_OWN_POSTS = 12;
const MAX_RELATED_PROFILES = 5;
const MAX_RELATED_PROFILE_POSTS = 4;

interface RawProfileResponse {
    data?: {
        user?: RawInstagramUser | null;
    };
    status?: string;
}

interface RawInstagramUser {
    id: string;
    username: string;
    full_name?: string;
    is_private: boolean;
    biography?: string;
    edge_owner_to_timeline_media?: {
        count?: number;
        edges?: RawInstagramEdge[];
    };
}

interface RawInstagramEdge {
    node: RawInstagramNode;
}

interface RawInstagramNode {
    id: string;
    shortcode: string;
    taken_at_timestamp?: number;
    edge_media_to_caption?: {
        edges?: {
            node?: {
                text?: string;
            };
        }[];
    };
    owner?: {
        username?: string;
    };
    edge_liked_by?: Record<string, unknown>;
    edge_media_preview_like?: Record<string, unknown>;
    coauthor_producers?: {
        username?: string;
    }[];
    edge_media_to_tagged_user?: {
        edges?: {
            node?: {
                user?: {
                    username?: string;
                };
            };
        }[];
    };
}

function collectNestedUsernames(value: unknown): string[] {
    const usernames = new Set<string>();

    const visit = (node: unknown): void => {
        if (!node) return;

        if (Array.isArray(node)) {
            for (const item of node) visit(item);
            return;
        }

        if (typeof node !== 'object') return;

        const record = node as Record<string, unknown>;
        const { username } = record;
        if (typeof username === 'string' && username.length > 0) {
            usernames.add(username.toLowerCase());
        }

        for (const nestedValue of Object.values(record)) {
            visit(nestedValue);
        }
    };

    visit(value);
    return [...usernames];
}

export interface TargetResolutionResult {
    resolvedTarget: ResolvedTarget | null;
    status: 'resolved' | 'private' | 'not_found' | 'unavailable';
    message: string;
    warnings: string[];
}

export interface DiscoveryPlan {
    candidateProfiles: number;
    candidatePosts: InstagramPost[];
    warnings: string[];
    searchMode: SearchMode;
    searchUsername: string;
}

export function buildDegradedDiscoveryPlan(username: string, reason?: string): DiscoveryPlan {
    return {
        candidateProfiles: 0,
        candidatePosts: [],
        warnings: [
            reason ?? `Canonical target resolution is temporarily unavailable. Continuing in degraded search mode using the input username @${username}.`,
            'The current discovery engine has not yet produced public candidate posts for degraded-mode search.',
        ],
        searchMode: 'degraded',
        searchUsername: username.toLowerCase(),
    };
}

function buildProfileUrl(username: string): string {
    return `https://www.instagram.com/${username}/`;
}

function mapPosts(
    edges: RawInstagramEdge[] | undefined,
    discoverySource: DiscoverySource,
    discoveredViaUsername: string | null,
): InstagramPost[] {
    return (edges ?? []).map((edge) => {
        const caption = edge.node.edge_media_to_caption?.edges?.[0]?.node?.text ?? null;
        const ownerUsername = edge.node.owner?.username ?? discoveredViaUsername ?? '';
        const mentionedUsernames = extractMentionedUsernames(caption);
        const taggedUsernames = (edge.node.edge_media_to_tagged_user?.edges ?? [])
            .map((taggedUser) => taggedUser.node?.user?.username?.toLowerCase())
            .filter((username): username is string => Boolean(username));
        const coauthorUsernames = (edge.node.coauthor_producers ?? [])
            .map((coauthor) => coauthor.username?.toLowerCase())
            .filter((username): username is string => Boolean(username));
        const discoverableLikerUsernames = dedupeByKey(
            [
                ...collectNestedUsernames(edge.node.edge_media_preview_like),
                ...collectNestedUsernames(edge.node.edge_liked_by),
            ],
            (username) => username,
        );

        return {
            id: edge.node.id,
            shortcode: edge.node.shortcode,
            url: `https://www.instagram.com/p/${edge.node.shortcode}/`,
            ownerUsername: ownerUsername.toLowerCase(),
            caption,
            mentionedUsernames,
            taggedUsernames,
            coauthorUsernames,
            discoverableLikerUsernames,
            takenAtTimestamp: edge.node.taken_at_timestamp ?? null,
            discoverySource,
            discoveredViaUsername,
        };
    });
}

function getRelatedUsernames(posts: InstagramPost[], rawEdges: RawInstagramEdge[], targetUsername: string): string[] {
    const usernames = new Set<string>();

    for (const post of posts) {
        for (const username of extractMentionedUsernames(post.caption)) {
            if (username !== targetUsername) usernames.add(username);
        }
    }

    for (const edge of rawEdges) {
        for (const coauthor of edge.node.coauthor_producers ?? []) {
            const username = coauthor.username?.toLowerCase();
            if (username && username !== targetUsername) usernames.add(username);
        }

        for (const taggedUser of edge.node.edge_media_to_tagged_user?.edges ?? []) {
            const username = taggedUser.node?.user?.username?.toLowerCase();
            if (username && username !== targetUsername) usernames.add(username);
        }
    }

    return [...usernames].slice(0, MAX_RELATED_PROFILES);
}

async function fetchProfileResponse(username: string): Promise<RawProfileResponse> {
    const profileResponse = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        {
            headers: PROFILE_HEADERS,
            signal: AbortSignal.timeout(30_000),
        },
    );

    if (!profileResponse.ok) {
        throw new Error(`Instagram profile lookup failed with HTTP ${profileResponse.status}.`);
    }

    const text = await profileResponse.text();
    try {
        return JSON.parse(text) as RawProfileResponse;
    } catch {
        throw new Error('Instagram profile lookup returned a non-JSON response.');
    }
}

export async function resolveTargetProfile(username: string): Promise<TargetResolutionResult> {
    try {
        const response = await fetchProfileResponse(username);
        const user = response.data?.user;

        if (!user) {
            return {
                resolvedTarget: null,
                status: 'not_found',
                message: `No public Instagram profile could be resolved for "${username}". It may be missing, renamed, or unavailable.`,
                warnings: [],
            };
        }

        const posts = mapPosts(
            user.edge_owner_to_timeline_media?.edges?.slice(0, MAX_OWN_POSTS),
            'target_profile',
            null,
        );

        const resolvedTarget: ResolvedTarget = {
            id: user.id,
            username: user.username.toLowerCase(),
            fullName: user.full_name ?? null,
            isPrivate: user.is_private,
            biography: user.biography ?? null,
            profileUrl: buildProfileUrl(user.username),
            postCount: user.edge_owner_to_timeline_media?.count ?? posts.length,
            posts,
        };

        if (resolvedTarget.isPrivate) {
            return {
                resolvedTarget,
                status: 'private',
                message: `Resolved private target @${resolvedTarget.username}. The Actor will continue searching for public comment traces on public surfaces.`,
                warnings: [],
            };
        }

        return {
            resolvedTarget,
            status: 'resolved',
            message: `Resolved public target @${resolvedTarget.username}.`,
            warnings: [],
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown resolution error.';
        log.warning(`Failed to resolve target profile @${username}: ${message}`);

        if (message.includes('HTTP 404')) {
            return {
                resolvedTarget: null,
                status: 'not_found',
                message: `No public Instagram profile could be resolved for "${username}". It may be missing, renamed, or unavailable.`,
                warnings: [],
            };
        }

        return {
            resolvedTarget: null,
            status: 'unavailable',
            message: `Unable to resolve a public Instagram profile for "${username}" right now. ${message}`,
            warnings: [message],
        };
    }
}

export async function buildDiscoveryPlan(target: ResolvedTarget): Promise<DiscoveryPlan> {
    const warnings: string[] = [];

    if (target.isPrivate) {
        return {
            candidateProfiles: 1,
            candidatePosts: [],
            warnings: [
                `Resolved target @${target.username} is private. Target-profile posts are not available, so the current discovery plan has no public candidate posts yet.`,
            ],
            searchMode: 'canonical',
            searchUsername: target.username,
        };
    }

    let ownEdges: RawInstagramEdge[] = [];
    let ownPosts = target.posts;

    try {
        const ownProfileResponse = await fetchProfileResponse(target.username);
        ownEdges = ownProfileResponse.data?.user?.edge_owner_to_timeline_media?.edges?.slice(0, MAX_OWN_POSTS) ?? [];
        ownPosts = mapPosts(ownEdges, 'target_profile', null);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown profile refresh error.';
        warnings.push(`Could not refresh recent posts for @${target.username}; using resolved profile snapshot instead. ${message}`);
    }

    const relatedUsernames = getRelatedUsernames(ownPosts, ownEdges, target.username);

    const relatedPosts: InstagramPost[] = [];
    for (const relatedUsername of relatedUsernames) {
        try {
            const response = await fetchProfileResponse(relatedUsername);
            const relatedUser = response.data?.user;

            if (!relatedUser || relatedUser.is_private) {
                warnings.push(`Skipped related profile @${relatedUsername} because it is unavailable or private.`);
                continue;
            }

            relatedPosts.push(
                ...mapPosts(
                    relatedUser.edge_owner_to_timeline_media?.edges?.slice(0, MAX_RELATED_PROFILE_POSTS),
                    'related_profile',
                    relatedUser.username.toLowerCase(),
                ),
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown related-profile error.';
            warnings.push(`Failed to inspect related profile @${relatedUsername}: ${message}`);
        }
    }

    const candidatePosts = dedupeByKey(
        [...ownPosts, ...relatedPosts].sort((left, right) => (right.takenAtTimestamp ?? 0) - (left.takenAtTimestamp ?? 0)),
        (post) => post.shortcode,
    );

    log.info(`Built discovery plan with ${candidatePosts.length} candidate posts across ${1 + relatedUsernames.length} profiles.`);

    return {
        candidateProfiles: 1 + relatedUsernames.length,
        candidatePosts,
        warnings,
        searchMode: 'canonical',
        searchUsername: target.username,
    };
}
