import { describe, expect, it } from 'vitest';

import {
    canonicalizeUsernameForMatching,
    classifyCommentOwnerUsername,
    computeConfidenceLevel,
    computeCoverageLevel,
    computeScanState,
    dedupeByKey,
    extractMentionedUsernames,
    parseCommentTextFromBlock,
} from '../src/comment-utils.js';
import { scanCommentsOnCandidatePosts } from '../src/comment-scraper.js';
import {
    buildSearchQueries,
    parseInstagramPostUrlsFromBrave,
    parseInstagramPostMetadataFromHtml,
    parseInstagramPostUrlsFromDuckDuckGo,
} from '../src/candidate-discovery.js';
import { buildTargetHistoryStateKey } from '../src/history-state.js';
import {
    mergeHistoricalObservations,
} from '../src/history-state.js';
import { normalizeUsername, parseInput } from '../src/input.js';
import { buildDegradedDiscoveryPlan } from '../src/instagram-profile.js';
import { scanLikedContentAppearances } from '../src/liked-content-scan.js';
import { scanMentionTaggedAppearances } from '../src/mention-tagged-scan.js';
import {
    inferAuthenticatedSessionFromPageSignals,
    parseUsernamesFromDialogAnchors,
    sessionStateContainsInstagramLogin,
} from '../src/operator-resources.js';
import {
    buildAmbiguousActivityRecord,
    buildHistoricalAppearancePresentation,
    buildResultBucketsRecord,
} from '../src/result-artifacts.js';
import {
    buildDeepInvestigationRuntimeStateKey,
    createInitialDeepInvestigationRuntimeState,
    leaseNextRuntimeJob,
    recoverInterruptedRuntimeJobs,
    runtimeJobCounts,
} from '../src/runtime-state.js';

describe('input parsing', () => {
    it('normalizes usernames with @ and case changes', () => {
        expect(normalizeUsername(' @NASA ')).toBe('nasa');
    });

    it('validates the public username-only contract', () => {
        expect(parseInput({ username: 'NASA' })).toEqual({
            username: 'nasa',
            runMode: 'backfill',
            maxDiscoveryCycles: 5,
            operatorAccounts: [],
            proxyConfiguration: null,
            graphExpansion: {
                maxFollowersToInspect: 25,
                maxFollowingToInspect: 25,
                maxExpandedProfiles: 20,
            },
        });
    });

    it('supports freshness mode defaults', () => {
        expect(parseInput({ username: 'NASA', runMode: 'freshness' })).toEqual({
            username: 'nasa',
            runMode: 'freshness',
            maxDiscoveryCycles: 2,
            operatorAccounts: [],
            proxyConfiguration: null,
            graphExpansion: {
                maxFollowersToInspect: 25,
                maxFollowingToInspect: 25,
                maxExpandedProfiles: 20,
            },
        });
    });

    it('parses operator accounts, proxy configuration, and graph expansion options', () => {
        expect(parseInput({
            username: 'NASA',
            operatorAccounts: [{ username: '@Operator.One', password: 'secret', sessionKey: 'sticky-1' }],
            proxyConfiguration: {
                useApifyProxy: true,
                apifyProxyGroups: ['RESIDENTIAL'],
                apifyProxyCountry: 'US',
            },
            graphExpansion: {
                maxFollowersToInspect: 10,
                maxFollowingToInspect: 12,
                maxExpandedProfiles: 8,
            },
        })).toEqual({
            username: 'nasa',
            runMode: 'backfill',
            maxDiscoveryCycles: 5,
            operatorAccounts: [{ username: 'operator.one', password: 'secret', sessionKey: 'sticky-1' }],
            proxyConfiguration: {
                useApifyProxy: true,
                apifyProxyGroups: ['RESIDENTIAL'],
                apifyProxyCountry: 'US',
                proxyUrls: undefined,
            },
            graphExpansion: {
                maxFollowersToInspect: 10,
                maxFollowingToInspect: 12,
                maxExpandedProfiles: 8,
            },
        });
    });

    it('accepts operator accounts with sessionId and no password', () => {
        expect(parseInput({
            username: 'NASA',
            operatorAccounts: [{ username: '@Operator.One', sessionId: 'abc123', sessionKey: 'sticky-1' }],
        })).toEqual({
            username: 'nasa',
            runMode: 'backfill',
            maxDiscoveryCycles: 5,
            operatorAccounts: [{ username: 'operator.one', password: undefined, sessionId: 'abc123', sessionKey: 'sticky-1' }],
            proxyConfiguration: null,
            graphExpansion: {
                maxFollowersToInspect: 25,
                maxFollowingToInspect: 25,
                maxExpandedProfiles: 20,
            },
        });
    });
});

describe('comment utilities', () => {
    it('extracts mentioned usernames from captions', () => {
        expect(extractMentionedUsernames('Hello @NASAWebb and @ESAWebb.')).toEqual(['nasawebb', 'esawebb']);
    });

    it('canonicalizes punctuation-only username variants', () => {
        expect(canonicalizeUsernameForMatching('john.doe_test')).toBe('johndoetest');
    });

    it('classifies exact, ambiguous, and non-match owner usernames', () => {
        expect(classifyCommentOwnerUsername('nasa', 'nasa')).toBe('confirmed');
        expect(classifyCommentOwnerUsername('john_doe', 'john.doe')).toBe('ambiguous');
        expect(classifyCommentOwnerUsername('nasawebb', 'nasa')).toBe('no_match');
    });

    it('parses comment text from a visible Instagram block', () => {
        const blockText = 'quantum.student\n\u00a0\n7w\nlindo demais\nLike\nReply';
        expect(parseCommentTextFromBlock(blockText, 'quantum.student', '7w')).toBe('lindo demais');
    });

    it('deduplicates comment-like records by permalink', () => {
        const items = [
            { key: 'a', value: 1 },
            { key: 'a', value: 2 },
            { key: 'b', value: 3 },
        ];

        expect(dedupeByKey(items, (item) => item.key)).toEqual([
            { key: 'a', value: 1 },
            { key: 'b', value: 3 },
        ]);
    });

    it('computes qualitative coverage levels', () => {
        expect(computeCoverageLevel({
            browserAvailable: false,
            scannedPosts: 0,
            candidatePosts: 12,
            partialFailures: 0,
        })).toBe('unknown');

        expect(computeCoverageLevel({
            browserAvailable: true,
            scannedPosts: 4,
            candidatePosts: 4,
            partialFailures: 0,
        })).toBe('medium');
    });

    it('computes explicit scan states', () => {
        expect(computeScanState({
            browserAvailable: true,
            partialFailures: 0,
            coverageLevel: 'high',
        })).toBe('complete');

        expect(computeScanState({
            browserAvailable: true,
            partialFailures: 0,
            coverageLevel: 'low',
        })).toBe('low_coverage');

        expect(computeScanState({
            browserAvailable: false,
            partialFailures: 1,
            coverageLevel: 'unknown',
        })).toBe('partial_failure');
    });

    it('computes confidence levels from exact and ambiguous matches', () => {
        expect(computeConfidenceLevel({ exactMatches: 2, ambiguousCandidates: 0 })).toBe('high');
        expect(computeConfidenceLevel({ exactMatches: 1, ambiguousCandidates: 2 })).toBe('medium');
        expect(computeConfidenceLevel({ exactMatches: 0, ambiguousCandidates: 1 })).toBe('low');
        expect(computeConfidenceLevel({ exactMatches: 0, ambiguousCandidates: 0 })).toBe('unknown');
    });
});

describe('mention and tagged scan', () => {
    it('emits separate mention and tagged appearance events from non-owned posts', () => {
        const result = scanMentionTaggedAppearances({
            resolvedUsername: 'nasa',
            candidatePosts: [
                {
                    id: '1',
                    shortcode: 'abc',
                    url: 'https://www.instagram.com/p/abc/',
                    ownerUsername: 'esa',
                    caption: 'Hello @nasa',
                    mentionedUsernames: ['nasa'],
                    taggedUsernames: ['nasa'],
                    coauthorUsernames: [],
                    discoverableLikerUsernames: [],
                    takenAtTimestamp: 1700000000,
                    discoverySource: 'related_profile',
                    discoveredViaUsername: 'esa',
                },
                {
                    id: '2',
                    shortcode: 'def',
                    url: 'https://www.instagram.com/p/def/',
                    ownerUsername: 'nasa',
                    caption: '@nasa self mention',
                    mentionedUsernames: ['nasa'],
                    taggedUsernames: ['nasa'],
                    coauthorUsernames: [],
                    discoverableLikerUsernames: [],
                    takenAtTimestamp: 1700000001,
                    discoverySource: 'target_profile',
                    discoveredViaUsername: null,
                },
            ],
        });

        expect(result.scannedPosts).toBe(1);
        expect(result.events.map((event) => event.type)).toEqual(['mention', 'tagged_appearance']);
        expect(result.events.every((event) => event.postShortcode === 'abc')).toBe(true);
    });
});

describe('issue 10 target handling groundwork', () => {
    it('builds a degraded discovery plan from the raw input username', () => {
        const plan = buildDegradedDiscoveryPlan('NASA');

        expect(plan.searchMode).toBe('degraded');
        expect(plan.searchUsername).toBe('nasa');
        expect(plan.candidatePosts).toEqual([]);
        expect(plan.warnings.length).toBeGreaterThan(0);
    });

    it('returns a no-op comment scan result when no candidate posts exist', async () => {
        const result = await scanCommentsOnCandidatePosts({
            candidatePosts: [],
            resolvedUsername: 'nasa',
        });

        expect(result.browserAvailable).toBe(true);
        expect(result.scannedPosts).toBe(0);
        expect(result.structuredCommentsScanned).toBe(0);
        expect(result.events).toEqual([]);
        expect(result.warnings.some((warning) => warning.includes('No candidate public posts'))).toBe(true);
    });
});

describe('candidate discovery parsing', () => {
    it('extracts normalized Instagram post URLs from DuckDuckGo result HTML', () => {
        const html = `
            <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instagram.com%2Fp%2FDKfFrcRuXnK%2F&amp;rut=x">Instagram</a>
            <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instagram.com%2Freel%2FABC123xyz%2F&amp;rut=y">Instagram</a>
        `;

        expect(parseInstagramPostUrlsFromDuckDuckGo(html)).toEqual([
            'https://www.instagram.com/p/DKfFrcRuXnK/',
            'https://www.instagram.com/reel/ABC123xyz/',
        ]);
    });

    it('extracts Instagram post URLs from Brave HTML', () => {
        const html = `
            <script type="application/json">{"url":"https://www.instagram.com/reel/DJm-gBwh8To/"}</script>
            <a href="https://www.instagram.com/p/DWS7mttEime/">Instagram</a>
        `;

        expect(parseInstagramPostUrlsFromBrave(html)).toEqual([
            'https://www.instagram.com/reel/DJm-gBwh8To/',
            'https://www.instagram.com/p/DWS7mttEime/',
        ]);
    });

    it('parses public post metadata from HTML meta tags', () => {
        const html = `
            <meta property="og:url" content="https://www.instagram.com/nasa/p/DKfFrcRuXnK/" />
            <meta name="description" content="575K likes, 1,314 comments - nasa on June 4, 2025: &quot;Hello @ESA from space&quot;. " />
        `;

        const result = parseInstagramPostMetadataFromHtml({
            url: 'https://www.instagram.com/p/DKfFrcRuXnK/',
            html,
            discoverySource: 'external_search',
            discoveredViaUsername: 'nasa',
        });

        expect(result?.shortcode).toBe('DKfFrcRuXnK');
        expect(result?.ownerUsername).toBe('nasa');
        expect(result?.caption).toContain('Hello @ESA from space');
        expect(result?.mentionedUsernames).toEqual(['esa']);
    });

    it('parses owner metadata even when meta attribute order varies', () => {
        const html = `
            <meta content="https://www.instagram.com/paleblood0/reel/C4a4Faqs-Nc/" property="og:url" />
            <meta content="2,661 likes, 45 comments - paleblood0 on March 12, 2024: &quot;#midir @marlboroswitch&quot;. " name="description" />
        `;

        const result = parseInstagramPostMetadataFromHtml({
            url: 'https://www.instagram.com/reel/C4a4Faqs-Nc/',
            html,
            discoverySource: 'external_search',
            discoveredViaUsername: 'marlboroswitch',
        });

        expect(result?.ownerUsername).toBe('paleblood0');
        expect(result?.mentionedUsernames).toEqual(['marlboroswitch']);
    });

    it('builds broader search query variants', () => {
        const queries = buildSearchQueries('nasa');
        expect(queries.length).toBe(8);
        expect(queries.some((query) => query.includes('instagram comment'))).toBe(true);
        expect(queries.some((query) => query.includes('@nasa'))).toBe(true);
    });
});

describe('liked content scan', () => {
    it('emits confirmed liked-content events and separates ambiguous signals', () => {
        const result = scanLikedContentAppearances({
            resolvedUsername: 'john.doe',
            candidatePosts: [
                {
                    id: '1',
                    shortcode: 'abc',
                    url: 'https://www.instagram.com/p/abc/',
                    ownerUsername: 'esa',
                    caption: 'A public post',
                    mentionedUsernames: [],
                    taggedUsernames: [],
                    coauthorUsernames: [],
                    discoverableLikerUsernames: ['john.doe', 'john_doe'],
                    takenAtTimestamp: 1700000000,
                    discoverySource: 'related_profile',
                    discoveredViaUsername: 'esa',
                },
                {
                    id: '2',
                    shortcode: 'def',
                    url: 'https://www.instagram.com/p/def/',
                    ownerUsername: 'nasa',
                    caption: 'Another public post',
                    mentionedUsernames: [],
                    taggedUsernames: [],
                    coauthorUsernames: [],
                    discoverableLikerUsernames: ['john_doe'],
                    takenAtTimestamp: 1700000001,
                    discoverySource: 'related_profile',
                    discoveredViaUsername: 'nasa',
                },
            ],
        });

        expect(result.scannedPosts).toBe(2);
        expect(result.discoverableSignals).toBe(2);
        expect(result.events.map((event) => event.type)).toEqual(['liked_content']);
        expect(result.events[0]?.postShortcode).toBe('abc');
        expect(result.ambiguousCandidates.length).toBe(1);
        expect(result.ambiguousCandidates[0]?.likerUsername).toBe('john_doe');
    });

    it('warns when no attributable public liker usernames are exposed', () => {
        const result = scanLikedContentAppearances({
            resolvedUsername: 'nasa',
            candidatePosts: [
                {
                    id: '1',
                    shortcode: 'abc',
                    url: 'https://www.instagram.com/p/abc/',
                    ownerUsername: 'esa',
                    caption: 'A public post',
                    mentionedUsernames: [],
                    taggedUsernames: [],
                    coauthorUsernames: [],
                    discoverableLikerUsernames: [],
                    takenAtTimestamp: 1700000000,
                    discoverySource: 'related_profile',
                    discoveredViaUsername: 'esa',
                },
            ],
        });

        expect(result.events).toHaveLength(0);
        expect(result.warnings.some((warning) => warning.includes('No attributable public liker usernames'))).toBe(true);
    });
});

describe('history merge', () => {
    it('builds distinct history state keys for canonical and provisional identities', () => {
        expect(buildTargetHistoryStateKey({
            identityMode: 'canonical_target',
            identityValue: '123',
        })).toBe('TARGET_STATE__canonical_target__123');

        expect(buildTargetHistoryStateKey({
            identityMode: 'input_username',
            identityValue: 'nasa',
        })).toBe('TARGET_STATE__input_username__nasa');
    });

    it('keeps current events visible and tombstones safely missing comment events', () => {
        const now = '2026-03-30T12:00:00.000Z';
        const previousState = {
            version: 1 as const,
            targetId: 'user-1',
            resolvedUsername: 'nasa',
            profileUrl: 'https://www.instagram.com/nasa/',
            updatedAt: '2026-03-29T12:00:00.000Z',
            events: [
                {
                    eventKey: 'comment:https://www.instagram.com/p/abc/c/1/',
                    observationState: 'visible' as const,
                    firstSeenAt: '2026-03-29T10:00:00.000Z',
                    lastSeenAt: '2026-03-29T12:00:00.000Z',
                    disappearedAt: null,
                    payload: {
                        type: 'comment' as const,
                        targetUsername: 'nasa',
                        resolvedUsername: 'nasa',
                        commentOwnerUsername: 'nasa',
                        commentKind: 'top_level' as const,
                        replyDepth: 0,
                        parentCommentPermalink: null,
                        commentText: 'hello',
                        createdAt: '2026-03-29T09:00:00.000Z',
                        createdAtLabel: '1d',
                        commentPermalink: 'https://www.instagram.com/p/abc/c/1/',
                        postUrl: 'https://www.instagram.com/p/abc/',
                        postShortcode: 'abc',
                        postOwnerUsername: 'esa',
                        sourceSurface: 'instagram_post_comment_thread' as const,
                        sourceUrl: 'https://www.instagram.com/p/abc/c/1/',
                        discoverySource: 'related_profile' as const,
                        discoveredViaUsername: 'esa',
                        matchConfidence: 'exact_username_visible' as const,
                        matchReason: 'exact',
                    },
                },
            ],
        };

        const result = mergeHistoricalObservations({
            targetId: 'user-1',
            identityMode: 'canonical_target',
            resolvedUsername: 'nasa',
            profileUrl: 'https://www.instagram.com/nasa/',
            currentEvents: [],
            previousState,
            commentsCanTombstone: true,
            mentionTaggedCanTombstone: false,
            likedContentCanTombstone: false,
            now,
        });

        expect(result.outputEvents).toHaveLength(1);
        expect(result.outputEvents[0]?.observationState).toBe('historical_tombstone');
        expect(result.outputEvents[0]?.commentText).toBeNull();
        expect(result.historySummary.tombstonedThisRun).toBe(1);
        expect(result.historySummary.identityMode).toBe('canonical_target');
    });

    it('keeps weak-surface historical items as unconfirmed instead of tombstoning them', () => {
        const now = '2026-03-30T12:00:00.000Z';
        const previousState = {
            version: 1 as const,
            targetId: 'user-2',
            resolvedUsername: 'nasa',
            profileUrl: 'https://www.instagram.com/nasa/',
            updatedAt: '2026-03-29T12:00:00.000Z',
            events: [
                {
                    eventKey: 'liked_content:abc',
                    observationState: 'visible' as const,
                    firstSeenAt: '2026-03-29T10:00:00.000Z',
                    lastSeenAt: '2026-03-29T12:00:00.000Z',
                    disappearedAt: null,
                    payload: {
                        type: 'liked_content' as const,
                        targetUsername: 'nasa',
                        resolvedUsername: 'nasa',
                        appearanceText: 'caption',
                        createdAt: null,
                        postUrl: 'https://www.instagram.com/p/abc/',
                        postShortcode: 'abc',
                        postOwnerUsername: 'esa',
                        sourceSurface: 'instagram_post_public_like_signal' as const,
                        sourceUrl: 'https://www.instagram.com/p/abc/',
                        discoverySource: 'related_profile' as const,
                        discoveredViaUsername: 'esa',
                        matchConfidence: 'exact_username_visible' as const,
                        matchReason: 'exact',
                    },
                },
            ],
        };

        const result = mergeHistoricalObservations({
            targetId: 'user-2',
            identityMode: 'input_username',
            resolvedUsername: 'nasa',
            profileUrl: 'https://www.instagram.com/nasa/',
            currentEvents: [],
            previousState,
            commentsCanTombstone: false,
            mentionTaggedCanTombstone: false,
            likedContentCanTombstone: false,
            now,
        });

        expect(result.outputEvents[0]?.observationState).toBe('historical_unconfirmed');
        expect(result.historySummary.historicalUnconfirmed).toBe(1);
        expect(result.historySummary.identityMode).toBe('input_username');
        expect(result.warnings.some((warning) => warning.includes('provisional'))).toBe(true);
    });
});

describe('deep investigation runtime state', () => {
    it('builds a stable runtime state key from username and run mode', () => {
        expect(buildDeepInvestigationRuntimeStateKey({ username: 'NASA', runMode: 'backfill' })).toBe('RUNTIME_STATE__nasa__backfill');
        expect(buildDeepInvestigationRuntimeStateKey({ username: 'NASA', runMode: 'freshness' })).toBe('RUNTIME_STATE__nasa__freshness');
    });

    it('leases the next queued runtime job and exposes job counts', () => {
        const state = createInitialDeepInvestigationRuntimeState({
            username: 'nasa',
            runMode: 'backfill',
            maxDiscoveryCycles: 5,
            operatorAccounts: [],
            proxyConfiguration: null,
            graphExpansion: {
                maxFollowersToInspect: 25,
                maxFollowingToInspect: 25,
                maxExpandedProfiles: 20,
            },
        });

        const leasedJob = leaseNextRuntimeJob({
            state,
            now: '2026-03-31T12:00:00.000Z',
            leaseMs: 60_000,
        });

        expect(leasedJob?.key).toBe('target_resolution');
        expect(leasedJob?.state).toBe('leased');
        expect(runtimeJobCounts(state.jobs)).toEqual({
            queued: 0,
            leased: 1,
            running: 0,
            checkpointed: 0,
            succeeded: 0,
            failed: 0,
        });
    });

    it('recovers interrupted leased jobs back to checkpointed state', () => {
        const state = createInitialDeepInvestigationRuntimeState({
            username: 'nasa',
            runMode: 'freshness',
            maxDiscoveryCycles: 2,
            operatorAccounts: [],
            proxyConfiguration: null,
            graphExpansion: {
                maxFollowersToInspect: 25,
                maxFollowingToInspect: 25,
                maxExpandedProfiles: 20,
            },
        });

        leaseNextRuntimeJob({
            state,
            now: '2026-03-31T12:00:00.000Z',
            leaseMs: 60_000,
        });

        const recoveredJobs = recoverInterruptedRuntimeJobs({
            state,
            now: '2026-03-31T12:02:00.000Z',
        });

        expect(recoveredJobs).toBe(1);
        expect(state.jobs[0]?.state).toBe('checkpointed');
        expect(state.resumedFromCheckpoint).toBe(true);
        expect(state.staleRecoveredJobs).toBe(1);
        expect(state.jobs[0]?.checkpoint?.note).toContain('Recovered automatically');
    });
});

describe('operator resource helpers', () => {
    it('extracts normalized usernames from relationship dialog anchors', () => {
        const result = parseUsernamesFromDialogAnchors([
            { href: '/ESA/', text: 'ESA' },
            { href: '/nasa/', text: 'NASA' },
            { href: null, text: 'jane.doe' },
        ], 5);

        expect(result).toEqual(['esa', 'nasa', 'jane.doe']);
    });

    it('detects persisted Instagram session cookies', () => {
        expect(sessionStateContainsInstagramLogin({
            cookies: [{
                name: 'sessionid',
                value: 'abc',
                domain: '.instagram.com',
                path: '/',
                expires: -1,
                httpOnly: true,
                secure: true,
                sameSite: 'Lax',
            }],
            origins: [],
        })).toBe(true);
    });

    it('accepts session pages that expose logged_in markers without the old nav selectors', () => {
        expect(inferAuthenticatedSessionFromPageSignals({
            pageUrl: 'https://www.instagram.com/accounts/edit/',
            bodyText: 'Instagram settings page',
            html: '<script>"logged_in"</script>',
            loginFieldVisible: false,
            challengePage: false,
        })).toEqual({
            isAuthenticated: true,
            reason: null,
        });
    });
});

describe('result artifacts', () => {
    it('maps visible and historical events into explicit presentation fields', () => {
        const visibleEvent = buildHistoricalAppearancePresentation({
            type: 'comment',
            visibilityClass: 'public',
            resultBucket: 'confirmed_comments',
            eventKey: 'comment:1',
            observationState: 'visible',
            firstSeenAt: '2026-03-31T10:00:00.000Z',
            lastSeenAt: '2026-03-31T10:00:00.000Z',
            disappearedAt: null,
            targetUsername: 'nasa',
            resolvedUsername: 'nasa',
            commentOwnerUsername: 'nasa',
            commentKind: 'top_level',
            replyDepth: 0,
            parentCommentPermalink: null,
            commentText: 'hello',
            createdAt: '2026-03-31T09:00:00.000Z',
            createdAtLabel: '1h',
            commentPermalink: 'https://www.instagram.com/p/abc/c/1/',
            postUrl: 'https://www.instagram.com/p/abc/',
            postShortcode: 'abc',
            postOwnerUsername: 'esa',
            sourceSurface: 'instagram_post_comment_thread',
            sourceUrl: 'https://www.instagram.com/p/abc/c/1/',
            discoverySource: 'related_profile',
            discoveredViaUsername: 'esa',
            matchConfidence: 'exact_username_visible',
            matchReason: 'exact',
        });

        const historicalEvent = buildHistoricalAppearancePresentation({
            ...visibleEvent,
            observationState: 'historical_tombstone',
        });

        expect(visibleEvent.visibilityClass).toBe('public');
        expect(visibleEvent.resultBucket).toBe('confirmed_comments');
        expect(historicalEvent.visibilityClass).toBe('historical_only');
        expect(historicalEvent.resultBucket).toBe('historical_only');
    });

    it('builds unified ambiguous activity records and result bucket counts', () => {
        const ambiguousRecord = buildAmbiguousActivityRecord({
            generatedAt: '2026-03-31T10:00:00.000Z',
            commentCandidates: [{
                type: 'comment',
                visibilityClass: 'ambiguous',
                resultBucket: 'ambiguous_candidates',
                commentOwnerUsername: 'nasa_',
                commentKind: 'top_level',
                replyDepth: 0,
                parentCommentPermalink: null,
                commentTextPreview: 'hello',
                createdAt: null,
                createdAtLabel: null,
                commentPermalink: 'https://www.instagram.com/p/abc/c/1/',
                postUrl: 'https://www.instagram.com/p/abc/',
                postShortcode: 'abc',
                postOwnerUsername: 'esa',
                discoverySource: 'related_profile',
                discoveredViaUsername: 'esa',
                ambiguityReason: 'similar',
            }],
            likedContentCandidates: [{
                type: 'liked_content',
                visibilityClass: 'ambiguous',
                resultBucket: 'ambiguous_candidates',
                likerUsername: 'nasa_',
                postUrl: 'https://www.instagram.com/p/def/',
                postShortcode: 'def',
                postOwnerUsername: 'esa',
                discoverySource: 'related_profile',
                discoveredViaUsername: 'esa',
                ambiguityReason: 'similar',
            }],
        });

        const buckets = buildResultBucketsRecord({
            generatedAt: '2026-03-31T10:00:00.000Z',
            events: [],
            ambiguousRecord,
        });

        expect(ambiguousRecord.counts.total).toBe(2);
        expect(buckets.counts.byVisibilityClass.ambiguous).toBe(2);
        expect(buckets.counts.byResultBucket.ambiguous_candidates).toBe(2);
    });
});
