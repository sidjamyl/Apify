import { log } from 'apify';

import { dedupeByKey } from './comment-utils.js';
import {
    buildDegradedDiscoveryPlan,
    buildDiscoveryPlan,
    type DiscoveryPlan,
    resolveTargetProfile,
} from './instagram-profile.js';
import type { DiscoverySource, InstagramPost, ResolvedTarget, SearchMode, TargetCandidateCacheState } from './types.js';

const SEARCH_HEADERS = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
};

const MAX_EXTERNAL_SEARCH_QUERIES = 10;
const MAX_EXTERNAL_SEARCH_HITS = 100;
const MAX_EXPANDED_DISCOVERY_PROFILES = 50;
const MAX_EXPANDED_PROFILE_POSTS = 24;

export function buildSearchQueries(username: string): string[] {
    return dedupeByKey([
        `site:instagram.com/p/ "${username}"`,
        `site:instagram.com/reel/ "${username}"`,
        `site:instagram.com "${username}" instagram`,
        `site:instagram.com/p/ @${username}`,
        `site:instagram.com/reel/ @${username}`,
        `site:instagram.com ${username} instagram comment`,
        `site:instagram.com ${username} instagram reel`,
        `site:instagram.com ${username}`,
    ], (query) => query).slice(0, MAX_EXTERNAL_SEARCH_QUERIES);
}

function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x2014;/g, '—')
        .replace(/&#x2764;&#xfe0f;/g, '❤️');
}

function normalizeInstagramPostUrl(rawUrl: string): string | null {
    const match = rawUrl.match(/https?:\/\/www\.instagram\.com\/(p|reel)\/([A-Za-z0-9_-]+)\/?/i);
    if (!match) return null;

    return `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/`;
}

export function parseInstagramPostUrlsFromDuckDuckGo(html: string): string[] {
    const urls = new Set<string>();
    for (const match of html.matchAll(/uddg=([^"&]+)/g)) {
        const decoded = decodeURIComponent(match[1]);
        const normalized = normalizeInstagramPostUrl(decoded);
        if (normalized) urls.add(normalized);
    }

    for (const match of html.matchAll(/https?:\/\/www\.instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/?/g)) {
        const normalized = normalizeInstagramPostUrl(match[0]);
        if (normalized) urls.add(normalized);
    }

    return [...urls];
}

export function parseInstagramPostUrlsFromBing(html: string): string[] {
    const urls = new Set<string>();
    for (const match of html.matchAll(/https?:\/\/www\.instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/?/g)) {
        const normalized = normalizeInstagramPostUrl(match[0]);
        if (normalized) urls.add(normalized);
    }

    return [...urls];
}

export function parseInstagramPostUrlsFromBrave(html: string): string[] {
    const urls = new Set<string>();
    for (const match of html.matchAll(/https?:\/\/www\.instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/?/g)) {
        const normalized = normalizeInstagramPostUrl(match[0]);
        if (normalized) urls.add(normalized);
    }

    return [...urls];
}

function buildProfileFrontier(input: {
    posts: InstagramPost[];
    searchUsername: string;
    cachedTargetState: TargetCandidateCacheState | null;
}): string[] {
    const { posts, searchUsername, cachedTargetState } = input;
    const ownerStats = new Map((cachedTargetState?.ownerStats ?? []).map((ownerStat) => [ownerStat.username, ownerStat]));
    const uniqueCandidates = dedupeByKey(
        [
            ...(cachedTargetState?.frontierUsernames ?? []),
            ...posts.flatMap((post) => [post.ownerUsername, ...post.mentionedUsernames]),
            ...(cachedTargetState?.fruitfulOwnerUsernames ?? []),
        ].filter((username) => Boolean(username) && username !== searchUsername),
        (username) => username,
    );

    return uniqueCandidates
        .map((username) => {
            const ownerStat = ownerStats.get(username);
            const postsFromCandidateSet = posts.filter((post) => post.ownerUsername === username).length;
            const mentionHits = posts.filter((post) => post.mentionedUsernames.includes(username)).length;
            const score = (ownerStat?.successfulCommentCount ?? 0) * 100
                + (ownerStat?.successfulRunCount ?? 0) * 50
                + postsFromCandidateSet * 10
                + mentionHits * 5
                - (ownerStat?.expandedPostCount ?? 0);

            return { username, score };
        })
        .sort((left, right) => right.score - left.score)
        .map((entry) => entry.username)
        .slice(0, MAX_EXPANDED_DISCOVERY_PROFILES);
}

function extractMetaContent(html: string, attributeName: 'name' | 'property', attributeValue: string): string | null {
    for (const match of html.matchAll(/<meta\s+[^>]*>/gi)) {
        const tag = match[0];
        const attributes: Record<string, string> = {};
        for (const attributeMatch of tag.matchAll(/([A-Za-z_:.-]+)="([\s\S]*?)"/g)) {
            attributes[attributeMatch[1]] = decodeHtmlEntities(attributeMatch[2]);
        }

        if (attributes[attributeName] === attributeValue && attributes.content) {
            return attributes.content;
        }
    }

    return null;
}

export function parseInstagramPostMetadataFromHtml(input: { url: string; html: string; discoverySource: DiscoverySource; discoveredViaUsername: string | null; }): InstagramPost | null {
    const { url, html, discoverySource, discoveredViaUsername } = input;
    const canonicalUrl = extractMetaContent(html, 'property', 'og:url') ?? url;
    const normalizedUrl = normalizeInstagramPostUrl(canonicalUrl) ?? normalizeInstagramPostUrl(url);
    if (!normalizedUrl) return null;

    const shortcodeMatch = normalizedUrl.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)\//i);
    if (!shortcodeMatch) return null;

    const description = extractMetaContent(html, 'name', 'description') ?? extractMetaContent(html, 'property', 'og:description');
    const ownerFromDescription = description?.match(/-\s*([A-Za-z0-9._]+)\s+on\s/i)?.[1]?.toLowerCase() ?? null;
    const ownerFromOgUrl = canonicalUrl.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel)\//i)?.[1]?.toLowerCase() ?? null;
    const ownerUsername = ownerFromDescription ?? ownerFromOgUrl ?? discoveredViaUsername ?? '';
    const caption = description?.includes(':')
        ? description.split(/:\s*/).slice(1).join(': ').trim().replace(/^"|"\.?\s*$/g, '')
        : null;
    const mediaId = html.match(/instagram:\/\/media\?id=(\d+)/)?.[1] ?? null;

    return {
        id: `search:${shortcodeMatch[1]}`,
        mediaId,
        shortcode: shortcodeMatch[1],
        url: normalizedUrl,
        ownerUsername,
        caption,
        mentionedUsernames: caption ? Array.from(caption.matchAll(/@([A-Za-z0-9._]+)/g)).map((match) => match[1].toLowerCase()) : [],
        taggedUsernames: [],
        coauthorUsernames: [],
        discoverableLikerUsernames: [],
        takenAtTimestamp: null,
        discoverySource,
        discoveredViaUsername,
    };
}

async function fetchExternalSearchHits(username: string): Promise<{ urls: string[]; warnings: string[]; queryCount: number; hitCount: number; }> {
    const warnings: string[] = [];
    const urls = new Set<string>();
    let queryCount = 0;
    let hitCount = 0;

    for (const query of buildSearchQueries(username)) {
        queryCount += 1;

        try {
            const ddgResponse = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
                headers: SEARCH_HEADERS,
                signal: AbortSignal.timeout(30_000),
            });

            if (!ddgResponse.ok) {
                warnings.push(`DuckDuckGo search returned HTTP ${ddgResponse.status} for query "${query}".`);
            } else {
                const ddgHtml = await ddgResponse.text();
                const ddgUrls = parseInstagramPostUrlsFromDuckDuckGo(ddgHtml);
                hitCount += ddgUrls.length;
                for (const url of ddgUrls) urls.add(url);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown DuckDuckGo search error.';
            warnings.push(`DuckDuckGo search failed for query "${query}": ${message}`);
        }

        try {
            const bingResponse = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
                headers: SEARCH_HEADERS,
                signal: AbortSignal.timeout(30_000),
            });

            if (!bingResponse.ok) {
                warnings.push(`Bing search returned HTTP ${bingResponse.status} for query "${query}".`);
                continue;
            }

            const bingHtml = await bingResponse.text();
            if (bingHtml.includes('challenges.cloudflare.com') || bingHtml.includes('/challenge/verify')) {
                warnings.push(`Bing search was blocked by an anti-bot challenge for query "${query}".`);
                continue;
            }

            const bingUrls = parseInstagramPostUrlsFromBing(bingHtml);
            hitCount += bingUrls.length;
            for (const url of bingUrls) urls.add(url);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown Bing search error.';
            warnings.push(`Bing search failed for query "${query}": ${message}`);
        }

        try {
            const braveResponse = await fetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, {
                headers: SEARCH_HEADERS,
                signal: AbortSignal.timeout(30_000),
            });

            if (!braveResponse.ok) {
                warnings.push(`Brave search returned HTTP ${braveResponse.status} for query "${query}".`);
            } else {
                const braveHtml = await braveResponse.text();
                const braveUrls = parseInstagramPostUrlsFromBrave(braveHtml);
                hitCount += braveUrls.length;
                for (const url of braveUrls) urls.add(url);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown Brave search error.';
            warnings.push(`Brave search failed for query "${query}": ${message}`);
        }
    }

    if (hitCount === 0) {
        warnings.push(`External public search returned no Instagram post hits for @${username} in the current bounded query set.`);
    }

    return {
        urls: [...urls].slice(0, MAX_EXTERNAL_SEARCH_HITS),
        warnings,
        queryCount,
        hitCount,
    };
}

async function fetchPostCandidatesFromUrls(urls: string[], searchUsername: string): Promise<{ posts: InstagramPost[]; warnings: string[]; }> {
    const warnings: string[] = [];
    const posts: InstagramPost[] = [];

    for (const url of urls) {
        try {
            const response = await fetch(url, {
                headers: SEARCH_HEADERS,
                signal: AbortSignal.timeout(30_000),
            });

            if (!response.ok) {
                warnings.push(`Failed to fetch public post candidate ${url}: HTTP ${response.status}.`);
                continue;
            }

            const html = await response.text();
            const candidatePost = parseInstagramPostMetadataFromHtml({
                url,
                html,
                discoverySource: 'external_search',
                discoveredViaUsername: searchUsername,
            });

            if (candidatePost) {
                posts.push(candidatePost);
            } else {
                warnings.push(`Public post metadata could not be parsed from search hit ${url}.`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown public post fetch error.';
            warnings.push(`Failed to inspect search-hit post ${url}: ${message}`);
        }
    }

    return { posts, warnings };
}

export async function refreshCandidatePostsMetadata(posts: InstagramPost[]): Promise<{ posts: InstagramPost[]; warnings: string[]; }> {
    const warnings: string[] = [];
    const refreshedPosts: InstagramPost[] = [];

    for (const post of posts) {
        const shouldRefresh = !post.mediaId
            || !post.caption
            || !post.ownerUsername
            || (post.discoverySource === 'external_search' && post.discoveredViaUsername === post.ownerUsername);

        if (!shouldRefresh) {
            refreshedPosts.push(post);
            continue;
        }

        try {
            const response = await fetch(post.url, {
                headers: SEARCH_HEADERS,
                signal: AbortSignal.timeout(30_000),
            });

            if (!response.ok) {
                warnings.push(`Failed to refresh metadata for ${post.url}: HTTP ${response.status}.`);
                refreshedPosts.push(post);
                continue;
            }

            const html = await response.text();
            const refreshedPost = parseInstagramPostMetadataFromHtml({
                url: post.url,
                html,
                discoverySource: post.discoverySource,
                discoveredViaUsername: post.discoveredViaUsername,
            });

            if (!refreshedPost) {
                warnings.push(`Could not refresh metadata for ${post.url}; keeping cached version.`);
                refreshedPosts.push(post);
                continue;
            }

            refreshedPosts.push({
                ...post,
                ...refreshedPost,
                discoverySource: post.discoverySource,
                discoveredViaUsername: post.discoveredViaUsername,
                takenAtTimestamp: post.takenAtTimestamp ?? refreshedPost.takenAtTimestamp,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown metadata refresh error.';
            warnings.push(`Failed to refresh metadata for ${post.url}: ${message}`);
            refreshedPosts.push(post);
        }
    }

    return {
        posts: dedupeByKey(refreshedPosts, (post) => post.shortcode),
        warnings,
    };
}

export async function expandPublicProfiles(input: {
    profileUsernames: string[];
    searchUsername: string;
    discoverySource: DiscoverySource;
}): Promise<{ expandedPosts: InstagramPost[]; warnings: string[]; expandedOwnerProfiles: number; }> {
    const warnings: string[] = [];
    const expandedPosts: InstagramPost[] = [];
    let expandedOwnerProfiles = 0;

    const { profileUsernames, searchUsername, discoverySource } = input;

    const uniqueProfileUsernames = dedupeByKey(
        profileUsernames.filter((username) => Boolean(username) && username !== searchUsername),
        (username) => username,
    ).slice(0, MAX_EXPANDED_DISCOVERY_PROFILES);

    for (const profileUsername of uniqueProfileUsernames) {
        try {
            const ownerResolution = await resolveTargetProfile(profileUsername);
            if (ownerResolution.status !== 'resolved' || !ownerResolution.resolvedTarget) {
                warnings.push(`Skipped profile expansion for @${profileUsername} because the profile is unavailable or private.`);
                continue;
            }

            expandedOwnerProfiles += 1;
            expandedPosts.push(
                ...ownerResolution.resolvedTarget.posts.slice(0, MAX_EXPANDED_PROFILE_POSTS).map((post) => ({
                    ...post,
                    discoverySource,
                    discoveredViaUsername: profileUsername,
                })),
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown owner expansion error.';
            warnings.push(`Profile expansion failed for @${profileUsername}: ${message}`);
        }
    }

    return {
        expandedPosts,
        warnings,
        expandedOwnerProfiles,
    };
}

export async function buildCandidateDiscoveryPlan(input: {
    resolvedTarget: ResolvedTarget | null;
    inputUsername: string;
    searchMode: SearchMode;
    cachedCandidatePosts?: InstagramPost[];
    cachedFruitfulOwnerUsernames?: string[];
    cachedTargetState?: TargetCandidateCacheState | null;
}): Promise<DiscoveryPlan> {
    const {
        resolvedTarget,
        inputUsername,
        searchMode,
        cachedCandidatePosts = [],
        cachedFruitfulOwnerUsernames = [],
        cachedTargetState = null,
    } = input;

    const basePlan = searchMode === 'canonical' && resolvedTarget
        ? await buildDiscoveryPlan(resolvedTarget)
        : buildDegradedDiscoveryPlan(inputUsername);

    const searchUsername = resolvedTarget?.username ?? inputUsername.toLowerCase();
    const externalSearchHits = await fetchExternalSearchHits(searchUsername);
    const externalSearchCandidates = await fetchPostCandidatesFromUrls(externalSearchHits.urls, searchUsername);
    const frontierProfileUsernames = buildProfileFrontier({
        posts: [...externalSearchCandidates.posts, ...cachedCandidatePosts],
        searchUsername,
        cachedTargetState,
    });
    const ownerExpansion = await expandPublicProfiles({
        profileUsernames: frontierProfileUsernames,
        searchUsername,
        discoverySource: 'expanded_owner_graph',
    });
    const cachedOwnerExpansion = await expandPublicProfiles({
        profileUsernames: cachedFruitfulOwnerUsernames,
        searchUsername,
        discoverySource: 'expanded_owner_graph',
    });

    const candidatePosts = dedupeByKey(
        [
            ...basePlan.candidatePosts,
            ...cachedCandidatePosts,
            ...externalSearchCandidates.posts,
            ...ownerExpansion.expandedPosts,
            ...cachedOwnerExpansion.expandedPosts,
        ],
        (post) => post.shortcode,
    );

    const plan: DiscoveryPlan = {
        candidateProfiles: basePlan.candidateProfiles + ownerExpansion.expandedOwnerProfiles,
        candidatePosts,
        warnings: [
            ...basePlan.warnings,
            ...(cachedCandidatePosts.length > 0 ? [`Loaded ${cachedCandidatePosts.length} cached candidate posts for @${searchUsername}.`] : []),
            ...externalSearchHits.warnings,
            ...externalSearchCandidates.warnings,
            ...ownerExpansion.warnings,
            ...cachedOwnerExpansion.warnings,
        ],
        searchMode,
        searchUsername,
        discoveryCounts: {
            targetProfilePosts: basePlan.discoveryCounts.targetProfilePosts,
            relatedProfilePosts: basePlan.discoveryCounts.relatedProfilePosts,
            cachedCandidatePosts: cachedCandidatePosts.length,
            cachedFruitfulOwnerProfiles: cachedOwnerExpansion.expandedOwnerProfiles,
            frontierProfilesQueued: frontierProfileUsernames.length,
            externalSearchQueries: externalSearchHits.queryCount,
            externalSearchHits: externalSearchHits.hitCount,
            externalSearchCandidatePosts: externalSearchCandidates.posts.length,
            expandedOwnerProfiles: ownerExpansion.expandedOwnerProfiles + cachedOwnerExpansion.expandedOwnerProfiles,
            expandedOwnerPosts: ownerExpansion.expandedPosts.length + cachedOwnerExpansion.expandedPosts.length,
        },
    };

    log.info(`Built candidate discovery plan with ${plan.candidatePosts.length} candidate posts using ${plan.discoveryCounts.externalSearchQueries} external queries.`);
    log.info(`Discovery plan details: cachedCandidates=${cachedCandidatePosts.length}, frontierProfiles=${frontierProfileUsernames.length}, externalHits=${externalSearchHits.hitCount}, externalCandidates=${externalSearchCandidates.posts.length}, expandedOwnerProfiles=${plan.discoveryCounts.expandedOwnerProfiles}, expandedOwnerPosts=${plan.discoveryCounts.expandedOwnerPosts}.`);
    if (externalSearchHits.hitCount === 0) {
        log.warning(`External search produced zero Instagram hits for @${searchUsername} in this discovery pass.`);
    }
    return plan;
}
