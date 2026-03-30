import { log } from 'apify';

import { dedupeByKey } from './comment-utils.js';
import {
    buildDegradedDiscoveryPlan,
    buildDiscoveryPlan,
    type DiscoveryPlan,
    resolveTargetProfile,
} from './instagram-profile.js';
import type { DiscoverySource, InstagramPost, ResolvedTarget, SearchMode } from './types.js';

const SEARCH_HEADERS = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
};

const MAX_EXTERNAL_SEARCH_QUERIES = 3;
const MAX_EXTERNAL_SEARCH_HITS = 18;
const MAX_EXPANDED_OWNER_PROFILES = 6;
const MAX_EXPANDED_OWNER_POSTS = 4;

function buildSearchQueries(username: string): string[] {
    return [
        `site:instagram.com/p/ "${username}"`,
        `site:instagram.com/reel/ "${username}"`,
        `site:instagram.com "${username}" instagram`,
    ].slice(0, MAX_EXTERNAL_SEARCH_QUERIES);
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

function extractMetaContent(html: string, attributeName: 'name' | 'property', attributeValue: string): string | null {
    const regex = new RegExp(`<meta[^>]+${attributeName}="${attributeValue}"[^>]+content="([\\s\\S]*?)"`, 'i');
    const match = html.match(regex);
    return match ? decodeHtmlEntities(match[1]) : null;
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

    return {
        id: `search:${shortcodeMatch[1]}`,
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

async function expandOwnersAroundSearchHits(posts: InstagramPost[], searchUsername: string): Promise<{ expandedPosts: InstagramPost[]; warnings: string[]; expandedOwnerProfiles: number; }> {
    const warnings: string[] = [];
    const expandedPosts: InstagramPost[] = [];
    let expandedOwnerProfiles = 0;

    const ownerUsernames = dedupeByKey(
        posts
            .map((post) => post.ownerUsername)
            .filter((ownerUsername) => Boolean(ownerUsername) && ownerUsername !== searchUsername),
        (ownerUsername) => ownerUsername,
    ).slice(0, MAX_EXPANDED_OWNER_PROFILES);

    for (const ownerUsername of ownerUsernames) {
        try {
            const ownerResolution = await resolveTargetProfile(ownerUsername);
            if (ownerResolution.status !== 'resolved' || !ownerResolution.resolvedTarget) {
                warnings.push(`Skipped owner expansion for @${ownerUsername} because the profile is unavailable or private.`);
                continue;
            }

            expandedOwnerProfiles += 1;
            expandedPosts.push(
                ...ownerResolution.resolvedTarget.posts.slice(0, MAX_EXPANDED_OWNER_POSTS).map((post) => ({
                    ...post,
                    discoverySource: 'expanded_owner_graph' as const,
                    discoveredViaUsername: ownerUsername,
                })),
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown owner expansion error.';
            warnings.push(`Owner expansion failed for @${ownerUsername}: ${message}`);
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
}): Promise<DiscoveryPlan> {
    const { resolvedTarget, inputUsername, searchMode } = input;

    const basePlan = searchMode === 'canonical' && resolvedTarget
        ? await buildDiscoveryPlan(resolvedTarget)
        : buildDegradedDiscoveryPlan(inputUsername);

    const searchUsername = resolvedTarget?.username ?? inputUsername.toLowerCase();
    const externalSearchHits = await fetchExternalSearchHits(searchUsername);
    const externalSearchCandidates = await fetchPostCandidatesFromUrls(externalSearchHits.urls, searchUsername);
    const ownerExpansion = await expandOwnersAroundSearchHits(externalSearchCandidates.posts, searchUsername);

    const candidatePosts = dedupeByKey(
        [
            ...basePlan.candidatePosts,
            ...externalSearchCandidates.posts,
            ...ownerExpansion.expandedPosts,
        ],
        (post) => post.shortcode,
    );

    const plan: DiscoveryPlan = {
        candidateProfiles: basePlan.candidateProfiles + ownerExpansion.expandedOwnerProfiles,
        candidatePosts,
        warnings: [
            ...basePlan.warnings,
            ...externalSearchHits.warnings,
            ...externalSearchCandidates.warnings,
            ...ownerExpansion.warnings,
        ],
        searchMode,
        searchUsername,
        discoveryCounts: {
            targetProfilePosts: basePlan.discoveryCounts.targetProfilePosts,
            relatedProfilePosts: basePlan.discoveryCounts.relatedProfilePosts,
            externalSearchQueries: externalSearchHits.queryCount,
            externalSearchHits: externalSearchHits.hitCount,
            externalSearchCandidatePosts: externalSearchCandidates.posts.length,
            expandedOwnerProfiles: ownerExpansion.expandedOwnerProfiles,
            expandedOwnerPosts: ownerExpansion.expandedPosts.length,
        },
    };

    log.info(`Built candidate discovery plan with ${plan.candidatePosts.length} candidate posts using ${plan.discoveryCounts.externalSearchQueries} external queries.`);
    return plan;
}
