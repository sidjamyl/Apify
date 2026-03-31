import { setTimeout } from 'node:timers/promises';

import { Actor, log } from 'apify';

import {
    loadCachedCandidatePosts,
    loadTargetCandidateCache,
    openCandidateDiscoveryCacheStore,
    persistCandidateDiscoveryCache,
} from './candidate-cache.js';
import { buildCandidateDiscoveryPlan, expandPublicProfiles, refreshCandidatePostsMetadata } from './candidate-discovery.js';
import { scanCommentsOnCandidatePosts } from './comment-scraper.js';
import {
    computeConfidenceLevel,
    computeCoverageLevel,
    computeScanState,
} from './comment-utils.js';
import {
    loadTargetHistoryState,
    mergeHistoricalObservations,
    openTargetHistoryStore,
    saveTargetHistoryState,
    TARGET_HISTORY_STORE_NAME,
} from './history-state.js';
import { parseInput } from './input.js';
import { resolveTargetProfile } from './instagram-profile.js';
import { scanLikedContentAppearances } from './liked-content-scan.js';
import { scanMentionTaggedAppearances } from './mention-tagged-scan.js';
import type {
    AmbiguousCommentCandidate,
    CommentEvent,
    CoverageLevel,
    HistoryIdentityMode,
    ResolvedTarget,
    RunStatus,
    RunSummary,
    ScanState,
} from './types.js';

Actor.on('aborting', async () => {
    await setTimeout(1_000);
    await Actor.exit();
});

await Actor.init();

function buildNoScanSummary(input: {
    status: RunStatus;
    message: string;
    runMode: 'backfill' | 'freshness';
    maxDiscoveryCycles: number;
    inputUsername: string;
    resolvedUsername: string | null;
    profileUrl: string | null;
    isAvailable: boolean;
    isPrivate: boolean;
    reason: string;
    warnings: string[];
    partialFailures: number;
}): RunSummary {
    const {
        status,
        message,
        inputUsername,
        resolvedUsername,
        profileUrl,
        isAvailable,
        isPrivate,
        reason,
        warnings,
        partialFailures,
    } = input;

    return {
        status,
        message,
        resultState: 'nothing_found',
        operation: {
            runMode: input.runMode,
            maxDiscoveryCycles: input.maxDiscoveryCycles,
            cyclesCompleted: 0,
            stoppedBecause: 'no_candidates',
        },
        target: {
            inputUsername,
            resolvedUsername,
            profileUrl,
            isAvailable,
            isPrivate,
        },
        comments: {
            resultState: 'no_comments_found',
            ambiguousRecordKey: null,
            counts: {
                candidatePosts: 0,
                scannedPosts: 0,
                visibleCommentsScanned: 0,
                structuredCommentsScanned: 0,
                confirmedComments: 0,
                confirmedReplies: 0,
                ambiguousCandidates: 0,
            },
        },
        discovery: {
            searchMode: 'canonical',
            searchUsername: inputUsername,
            counts: {
                targetProfilePosts: 0,
                relatedProfilePosts: 0,
                cachedCandidatePosts: 0,
                cachedFruitfulOwnerProfiles: 0,
                frontierProfilesQueued: 0,
                externalSearchQueries: 0,
                externalSearchHits: 0,
                externalSearchCandidatePosts: 0,
                expandedOwnerProfiles: 0,
                expandedOwnerPosts: 0,
            },
            warnings: [],
        },
        coverage: {
            level: 'unknown',
            scanState: 'partial_failure',
            reason,
        },
        confidence: {
            level: 'unknown',
            reason: 'Confidence cannot be evaluated because no visible comment scan was completed.',
            exactMatches: 0,
            ambiguousCandidates: 0,
            ambiguousSamples: [],
        },
        mentionTagged: {
            coverage: {
                level: 'unknown',
                scanState: 'partial_failure',
                reason: 'Mention and tagged discovery was not attempted because the target could not be scanned successfully.',
            },
            counts: {
                scannedPosts: 0,
                mentionEvents: 0,
                taggedAppearanceEvents: 0,
                partialFailures: partialFailures > 0 ? 1 : 0,
                warnings: 0,
            },
            warnings: [],
        },
        likedContent: {
            coverage: {
                level: 'unknown',
                scanState: 'partial_failure',
                reason: 'Liked-content discovery was not attempted because the target could not be scanned successfully.',
            },
            confidence: {
                level: 'unknown',
                reason: 'Liked-content confidence cannot be evaluated because no public like-signal scan was completed.',
                exactMatches: 0,
                ambiguousCandidates: 0,
                ambiguousSamples: [],
            },
            counts: {
                scannedPosts: 0,
                discoverableSignals: 0,
                likedContentEvents: 0,
                ambiguousCandidates: 0,
                partialFailures: partialFailures > 0 ? 1 : 0,
                warnings: 0,
            },
            warnings: [],
        },
        history: {
            ...emptyHistorySummary(),
        },
        counts: {
            candidateProfiles: isAvailable ? 1 : 0,
            candidatePosts: 0,
            scannedPosts: 0,
            visibleCommentsScanned: 0,
            matchedComments: 0,
            matchedReplies: 0,
            mentionEvents: 0,
            taggedAppearanceEvents: 0,
            likedContentEvents: 0,
            likedContentAmbiguousCandidates: 0,
            ambiguousCandidates: 0,
            partialFailures,
            warnings: warnings.length,
        },
        warnings,
    };
}

function computeMentionTaggedCoverage(input: {
    scannedPosts: number;
    mentionEvents: number;
    taggedAppearanceEvents: number;
    partialFailures: number;
}): { level: CoverageLevel; scanState: ScanState; reason: string } {
    const {
        scannedPosts,
        mentionEvents,
        taggedAppearanceEvents,
        partialFailures,
    } = input;

    if (partialFailures > 0) {
        return {
            level: 'low',
            scanState: 'partial_failure',
            reason: 'The mention/tagged branch encountered failures, so supporting-surface coverage is incomplete.',
        };
    }

    if (scannedPosts === 0) {
        return {
            level: 'unknown',
            scanState: 'low_coverage',
            reason: 'No non-owned public candidate posts were available for mention or tagged-appearance discovery.',
        };
    }

    if (scannedPosts >= 8) {
        return {
            level: 'high',
            scanState: 'complete',
            reason: 'The Actor inspected a broader supporting-post sample for caption mentions and tagged appearances.',
        };
    }

    if (scannedPosts >= 4) {
        return {
            level: 'medium',
            scanState: 'complete',
            reason: 'The Actor inspected multiple non-owned public posts for mentions and tagged appearances.',
        };
    }

    if (mentionEvents > 0 || taggedAppearanceEvents > 0) {
        return {
            level: 'low',
            scanState: 'low_coverage',
            reason: 'The Actor found supporting mention/tagged appearances, but only in a narrow public supporting-post sample.',
        };
    }

    return {
        level: 'low',
        scanState: 'low_coverage',
        reason: 'Only a narrow public supporting-post sample was available for mention/tagged discovery.',
    };
}

function computeLikedContentCoverage(input: {
    scannedPosts: number;
    discoverableSignals: number;
    likedContentEvents: number;
    partialFailures: number;
}): { level: CoverageLevel; scanState: ScanState; reason: string } {
    const {
        scannedPosts,
        discoverableSignals,
        likedContentEvents,
        partialFailures,
    } = input;

    if (partialFailures > 0) {
        return {
            level: 'low',
            scanState: 'partial_failure',
            reason: 'The liked-content branch encountered failures, so experimental like coverage is incomplete.',
        };
    }

    if (scannedPosts === 0) {
        return {
            level: 'unknown',
            scanState: 'low_coverage',
            reason: 'No eligible non-owned candidate posts were available for liked-content discovery.',
        };
    }

    if (discoverableSignals === 0) {
        return {
            level: 'unknown',
            scanState: 'low_coverage',
            reason: 'Instagram did not expose attributable public liker usernames on the scanned candidate posts.',
        };
    }

    if (likedContentEvents > 0) {
        return {
            level: 'low',
            scanState: 'complete',
            reason: 'The Actor found attributable public liker signals, but this surface remains highly incomplete and experimental.',
        };
    }

    return {
        level: 'low',
        scanState: 'low_coverage',
        reason: 'Attributable public liker signals were scanned, but none matched the resolved target exactly.',
    };
}

function emptyHistorySummary(): RunSummary['history'] {
    return {
        storeName: TARGET_HISTORY_STORE_NAME,
        stateKey: null,
        identityMode: 'none',
        identityValue: null,
        reusedPriorState: false,
        visibleEvents: 0,
        historicalTombstones: 0,
        historicalUnconfirmed: 0,
        newlyObservedEvents: 0,
        tombstonedThisRun: 0,
    };
}

async function run(): Promise<void> {
    const input = parseInput(await Actor.getInput());
    log.info(`Starting best-effort public comment discovery for @${input.username}.`);

    const targetResolution = await resolveTargetProfile(input.username);

    if (targetResolution.status === 'not_found') {
        const summary = buildNoScanSummary({
            status: 'target_not_found_or_renamed',
            message: targetResolution.message,
            runMode: input.runMode,
            maxDiscoveryCycles: input.maxDiscoveryCycles,
            inputUsername: input.username,
            resolvedUsername: null,
            profileUrl: null,
            isAvailable: false,
            isPrivate: false,
            reason: 'Target could not be resolved on public Instagram surfaces.',
            warnings: targetResolution.warnings,
            partialFailures: 0,
        });

        await Actor.setValue('RUN_SUMMARY', summary);
        log.warning(summary.message);
        return;
    }

    const { resolvedTarget: initialResolvedTarget } = targetResolution;
    let resolvedTarget: ResolvedTarget | null = initialResolvedTarget;
    let searchUsername = input.username;
    let targetProfileUrl: string | null = null;
    let targetIsAvailable = false;
    let targetIsPrivate = false;
    let historyIdentityMode: Exclude<HistoryIdentityMode, 'none'> | null = null;
    let historyIdentityValue: string | null = null;
    let searchMode: 'canonical' | 'degraded' = 'canonical';

    if (targetResolution.status === 'unavailable') {
        searchMode = 'degraded';
        resolvedTarget = null;
    } else {
        const canonicalTarget = targetResolution.resolvedTarget;
        if (!canonicalTarget) {
            throw new Error('Expected a resolved target for canonical search mode.');
        }

        resolvedTarget = canonicalTarget;
        searchUsername = canonicalTarget.username;
        targetProfileUrl = canonicalTarget.profileUrl;
        targetIsAvailable = true;
        targetIsPrivate = canonicalTarget.isPrivate;
        historyIdentityMode = 'canonical_target';
        historyIdentityValue = canonicalTarget.id;
    }

    if (!historyIdentityMode || !historyIdentityValue) {
        historyIdentityMode = 'input_username';
        historyIdentityValue = input.username;
    }

    const targetHistoryStore = await openTargetHistoryStore();
    const previousHistoryState = historyIdentityMode && historyIdentityValue
        ? await loadTargetHistoryState({
            store: targetHistoryStore,
            identityMode: historyIdentityMode,
            identityValue: historyIdentityValue,
        })
        : null;

    const historicalCandidatePosts = previousHistoryState
        ? [...new Map(
            previousHistoryState.events
                .filter((event) => event.payload.type === 'comment')
                .map((event) => {
                    const { payload } = event;
                    return [payload.postShortcode, {
                        id: `history:${payload.postShortcode}`,
                        mediaId: null,
                        shortcode: payload.postShortcode,
                        url: payload.postUrl,
                        ownerUsername: payload.postOwnerUsername,
                        caption: null,
                        mentionedUsernames: [],
                        taggedUsernames: [],
                        coauthorUsernames: [],
                        discoverableLikerUsernames: [],
                        takenAtTimestamp: payload.createdAt ? Math.floor(Date.parse(payload.createdAt) / 1000) : null,
                        discoverySource: payload.discoverySource,
                        discoveredViaUsername: payload.discoveredViaUsername,
                    }];
                }),
        ).values()]
        : [];
    const historicalFruitfulOwners = previousHistoryState
        ? [...new Set(
            previousHistoryState.events
                .filter((event) => event.payload.type === 'comment')
                .map((event) => event.payload.postOwnerUsername)
                .filter((ownerUsername) => ownerUsername && ownerUsername !== searchUsername),
        )]
        : [];

    const candidateCacheStore = await openCandidateDiscoveryCacheStore();
    let targetCandidateCache = await loadTargetCandidateCache({
        store: candidateCacheStore,
        targetUsername: searchUsername,
    });
    const cachedCandidatePosts = await loadCachedCandidatePosts({
        store: candidateCacheStore,
        shortcodes: targetCandidateCache?.candidateShortcodes ?? [],
    });

    const knownCandidatePosts = new Map<string, typeof cachedCandidatePosts[number]>();
    for (const post of [...cachedCandidatePosts, ...historicalCandidatePosts]) {
        knownCandidatePosts.set(post.shortcode, post);
    }

    const scannedShortcodes = new Set<string>();
    let cyclesCompleted = 0;
    let stoppedBecause: 'completed_all_cycles' | 'saturated' | 'no_candidates' = 'completed_all_cycles';
    let noProgressCycles = 0;
    let aggregatedCandidateProfiles = 0;
    let lastDiscoverySearchMode: 'canonical' | 'degraded' = searchMode;
    let lastDiscoverySearchUsername = searchUsername;
    const aggregatedDiscoveryCounts = {
        targetProfilePosts: 0,
        relatedProfilePosts: 0,
        cachedCandidatePosts: cachedCandidatePosts.length,
        cachedFruitfulOwnerProfiles: 0,
        frontierProfilesQueued: 0,
        externalSearchQueries: 0,
        externalSearchHits: 0,
        externalSearchCandidatePosts: 0,
        expandedOwnerProfiles: 0,
        expandedOwnerPosts: 0,
    };
    const aggregatedDiscoveryWarnings: string[] = [];
    const aggregatedCommentScanResult = {
        browserAvailable: true,
        scannedPosts: 0,
        visibleCommentsScanned: 0,
        structuredCommentsScanned: 0,
        partialFailures: 0,
        warnings: [] as string[],
        events: [] as CommentEvent[],
        ambiguousCandidates: [] as AmbiguousCommentCandidate[],
    };
    const ownerExpansionWarnings: string[] = [];
    let ownerExpansionProfiles = 0;
    let ownerExpansionPosts = 0;

    for (let cycleIndex = 0; cycleIndex < input.maxDiscoveryCycles; cycleIndex++) {
        const discoveryPlan = await buildCandidateDiscoveryPlan({
            resolvedTarget,
            inputUsername: input.username,
            searchMode,
            cachedCandidatePosts: [...knownCandidatePosts.values()],
            cachedFruitfulOwnerUsernames: [
                ...(targetCandidateCache?.fruitfulOwnerUsernames ?? []),
                ...historicalFruitfulOwners,
            ],
            cachedTargetState: targetCandidateCache,
        });
        const refreshedDiscoveryCandidates = await refreshCandidatePostsMetadata(discoveryPlan.candidatePosts);
        discoveryPlan.candidatePosts = refreshedDiscoveryCandidates.posts;
        searchUsername = discoveryPlan.searchUsername;
        lastDiscoverySearchMode = discoveryPlan.searchMode;
        lastDiscoverySearchUsername = discoveryPlan.searchUsername;
        cyclesCompleted += 1;
        aggregatedCandidateProfiles = Math.max(aggregatedCandidateProfiles, discoveryPlan.candidateProfiles);
        aggregatedDiscoveryCounts.targetProfilePosts = Math.max(aggregatedDiscoveryCounts.targetProfilePosts, discoveryPlan.discoveryCounts.targetProfilePosts);
        aggregatedDiscoveryCounts.relatedProfilePosts += discoveryPlan.discoveryCounts.relatedProfilePosts;
        aggregatedDiscoveryCounts.cachedCandidatePosts = Math.max(aggregatedDiscoveryCounts.cachedCandidatePosts, discoveryPlan.discoveryCounts.cachedCandidatePosts);
        aggregatedDiscoveryCounts.cachedFruitfulOwnerProfiles = Math.max(aggregatedDiscoveryCounts.cachedFruitfulOwnerProfiles, discoveryPlan.discoveryCounts.cachedFruitfulOwnerProfiles);
        aggregatedDiscoveryCounts.frontierProfilesQueued = Math.max(aggregatedDiscoveryCounts.frontierProfilesQueued, discoveryPlan.discoveryCounts.frontierProfilesQueued);
        aggregatedDiscoveryCounts.externalSearchQueries += discoveryPlan.discoveryCounts.externalSearchQueries;
        aggregatedDiscoveryCounts.externalSearchHits += discoveryPlan.discoveryCounts.externalSearchHits;
        aggregatedDiscoveryCounts.externalSearchCandidatePosts += discoveryPlan.discoveryCounts.externalSearchCandidatePosts;
        aggregatedDiscoveryCounts.expandedOwnerProfiles += discoveryPlan.discoveryCounts.expandedOwnerProfiles;
        aggregatedDiscoveryCounts.expandedOwnerPosts += discoveryPlan.discoveryCounts.expandedOwnerPosts;
        aggregatedDiscoveryWarnings.push(...discoveryPlan.warnings, ...refreshedDiscoveryCandidates.warnings);

        for (const post of discoveryPlan.candidatePosts) {
            if (!knownCandidatePosts.has(post.shortcode)) {
                knownCandidatePosts.set(post.shortcode, post);
            }
        }

        const cycleCandidatePosts = discoveryPlan.candidatePosts.filter((post) => !scannedShortcodes.has(post.shortcode)).slice(0, input.runMode === 'freshness' ? 10 : 30);
        log.info(`Cycle ${cycleIndex + 1}/${input.maxDiscoveryCycles}: ${cycleCandidatePosts.length} new candidate posts selected.`);

        if (cycleCandidatePosts.length === 0) {
            stoppedBecause = cyclesCompleted === 1 ? 'no_candidates' : 'saturated';
            break;
        }

        const cycleCommentScanResult = await scanCommentsOnCandidatePosts({
            candidatePosts: cycleCandidatePosts,
            resolvedUsername: searchUsername,
        });
        const currentCycleSearchUsername = searchUsername;
        for (const post of cycleCandidatePosts) {
            scannedShortcodes.add(post.shortcode);
        }

        const cycleConfirmedCommentOwners = [...new Set(
            cycleCommentScanResult.events
                .map((event) => event.postOwnerUsername)
                .filter((ownerUsername) => ownerUsername && ownerUsername !== currentCycleSearchUsername),
        )];

        let cycleOwnerExpansionWarnings: string[] = [];
        let cycleOwnerExpansionProfiles = 0;
        let cycleOwnerExpansionPosts = 0;

        if (cycleConfirmedCommentOwners.length > 0) {
            const expandedCommentOwnerProfiles = await expandPublicProfiles({
                profileUsernames: cycleConfirmedCommentOwners,
                searchUsername,
                discoverySource: 'expanded_owner_graph',
            });

            cycleOwnerExpansionWarnings = expandedCommentOwnerProfiles.warnings;
            cycleOwnerExpansionProfiles = expandedCommentOwnerProfiles.expandedOwnerProfiles;

            const extraCandidatePosts = expandedCommentOwnerProfiles.expandedPosts.filter((post) => {
                return !scannedShortcodes.has(post.shortcode) && !cycleCandidatePosts.some((existingPost) => existingPost.shortcode === post.shortcode);
            });
            cycleOwnerExpansionPosts = extraCandidatePosts.length;

            if (extraCandidatePosts.length > 0) {
                log.info(`Cycle ${cycleIndex + 1}: confirmed-comment owner expansion added ${extraCandidatePosts.length} new candidate posts.`);
                for (const post of extraCandidatePosts) {
                    knownCandidatePosts.set(post.shortcode, post);
                }

                const extraCommentScanResult = await scanCommentsOnCandidatePosts({
                    candidatePosts: extraCandidatePosts,
                    resolvedUsername: searchUsername,
                });

                for (const post of extraCandidatePosts) {
                    scannedShortcodes.add(post.shortcode);
                }

                cycleCommentScanResult.scannedPosts += extraCommentScanResult.scannedPosts;
                cycleCommentScanResult.visibleCommentsScanned += extraCommentScanResult.visibleCommentsScanned;
                cycleCommentScanResult.structuredCommentsScanned += extraCommentScanResult.structuredCommentsScanned;
                cycleCommentScanResult.partialFailures += extraCommentScanResult.partialFailures;
                cycleCommentScanResult.warnings.push(...extraCommentScanResult.warnings);
                cycleCommentScanResult.events.push(...extraCommentScanResult.events);
                cycleCommentScanResult.ambiguousCandidates.push(...extraCommentScanResult.ambiguousCandidates);
            }
        }

        aggregatedCommentScanResult.scannedPosts += cycleCommentScanResult.scannedPosts;
        aggregatedCommentScanResult.visibleCommentsScanned += cycleCommentScanResult.visibleCommentsScanned;
        aggregatedCommentScanResult.structuredCommentsScanned += cycleCommentScanResult.structuredCommentsScanned;
        aggregatedCommentScanResult.partialFailures += cycleCommentScanResult.partialFailures;
        aggregatedCommentScanResult.warnings.push(...cycleCommentScanResult.warnings);
        aggregatedCommentScanResult.events.push(...cycleCommentScanResult.events);
        aggregatedCommentScanResult.ambiguousCandidates.push(...cycleCommentScanResult.ambiguousCandidates);
        ownerExpansionWarnings.push(...cycleOwnerExpansionWarnings);
        ownerExpansionProfiles += cycleOwnerExpansionProfiles;
        ownerExpansionPosts += cycleOwnerExpansionPosts;

        targetCandidateCache = await persistCandidateDiscoveryCache({
            store: candidateCacheStore,
            targetUsername: searchUsername,
            candidatePosts: [...knownCandidatePosts.values()],
            fruitfulOwnerUsernames: cycleConfirmedCommentOwners,
            frontierUsernames: [...knownCandidatePosts.values()]
                .flatMap((post) => [post.ownerUsername, ...post.mentionedUsernames])
                .filter((username) => Boolean(username) && username !== currentCycleSearchUsername),
            ownerStatUpdates: cycleConfirmedCommentOwners.map((ownerUsername) => ({
                username: ownerUsername.toLowerCase(),
                successfulCommentCountDelta: cycleCommentScanResult.events.filter((event) => event.postOwnerUsername === ownerUsername).length,
                successfulRunIncrement: 1,
                expandedPostCountDelta: [...knownCandidatePosts.values()].filter((post) => post.ownerUsername === ownerUsername).length,
                lastSuccessfulAt: new Date().toISOString(),
            })),
            previousState: targetCandidateCache,
        });

        if (cycleCommentScanResult.events.length === 0 && cycleOwnerExpansionPosts === 0) {
            noProgressCycles += 1;
        } else {
            noProgressCycles = 0;
        }

        if (noProgressCycles >= (input.runMode === 'freshness' ? 1 : 2)) {
            stoppedBecause = 'saturated';
            break;
        }
    }

    const commentScanResult = aggregatedCommentScanResult;

    const finalCandidatePosts = [...knownCandidatePosts.values()];

    const likedContentScanResult = scanLikedContentAppearances({
        candidatePosts: finalCandidatePosts,
        resolvedUsername: searchUsername,
    });
    const mentionTaggedScanResult = scanMentionTaggedAppearances({
        candidatePosts: finalCandidatePosts,
        resolvedUsername: searchUsername,
    });
    log.info(`Comment scan finished with ${commentScanResult.events.length} confirmed comments and ${commentScanResult.ambiguousCandidates.length} ambiguous comment candidates.`);

    const currentEvents = [
        ...commentScanResult.events,
        ...likedContentScanResult.events,
        ...mentionTaggedScanResult.events,
    ].sort((left, right) => {
        const leftTimestamp = left.createdAt ? Date.parse(left.createdAt) : 0;
        const rightTimestamp = right.createdAt ? Date.parse(right.createdAt) : 0;
        return rightTimestamp - leftTimestamp;
    });

    const coverageLevel = computeCoverageLevel({
        browserAvailable: commentScanResult.browserAvailable,
        scannedPosts: commentScanResult.scannedPosts,
        candidatePosts: finalCandidatePosts.length,
        partialFailures: commentScanResult.partialFailures,
    });
    const scanState = computeScanState({
        browserAvailable: commentScanResult.browserAvailable,
        partialFailures: commentScanResult.partialFailures,
        coverageLevel,
    });
    const likedContentEvents = likedContentScanResult.events.length;
    const likedContentConfidenceLevel = computeConfidenceLevel({
        exactMatches: likedContentEvents,
        ambiguousCandidates: likedContentScanResult.ambiguousCandidates.length,
    });
    const likedContentCoverage = computeLikedContentCoverage({
        scannedPosts: likedContentScanResult.scannedPosts,
        discoverableSignals: likedContentScanResult.discoverableSignals,
        likedContentEvents,
        partialFailures: likedContentScanResult.partialFailures,
    });
    const mentionEvents = mentionTaggedScanResult.events.filter((event) => event.type === 'mention').length;
    const taggedAppearanceEvents = mentionTaggedScanResult.events.filter((event) => event.type === 'tagged_appearance').length;
    const mentionTaggedCoverage = computeMentionTaggedCoverage({
        scannedPosts: mentionTaggedScanResult.scannedPosts,
        mentionEvents,
        taggedAppearanceEvents,
        partialFailures: mentionTaggedScanResult.partialFailures,
    });
    const commentResultState = commentScanResult.events.length > 0 ? 'comments_found' : 'no_comments_found';
    const ambiguousCommentRecordKey = commentScanResult.ambiguousCandidates.length > 0
        ? 'AMBIGUOUS_COMMENT_CANDIDATES'
        : null;

    if (commentScanResult.ambiguousCandidates.length > 0) {
        try {
            await Actor.setValue('AMBIGUOUS_COMMENT_CANDIDATES', commentScanResult.ambiguousCandidates);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown ambiguous comment bucket write error.';
            log.warning(`Failed to persist ambiguous comment bucket: ${message}`);
        }
    }
    const historyMergeResult = historyIdentityMode && historyIdentityValue
        ? (() => {
            const now = new Date().toISOString();
            return mergeHistoricalObservations({
                targetId: historyIdentityValue,
                identityMode: historyIdentityMode,
                resolvedUsername: searchUsername,
                profileUrl: targetProfileUrl ?? '',
                currentEvents,
                previousState: null,
                commentsCanTombstone: scanState === 'complete',
                mentionTaggedCanTombstone: mentionTaggedCoverage.scanState === 'complete',
                likedContentCanTombstone: false,
                now,
            });
        })()
        : {
            outputEvents: [],
            nextState: null,
            historySummary: emptyHistorySummary(),
            warnings: [] as string[],
        };

    if (historyIdentityMode && historyIdentityValue) {
        try {
            const mergedHistory = mergeHistoricalObservations({
                targetId: historyIdentityValue,
                identityMode: historyIdentityMode,
                resolvedUsername: searchUsername,
                profileUrl: targetProfileUrl ?? '',
                currentEvents,
                previousState: previousHistoryState,
                commentsCanTombstone: scanState === 'complete',
                mentionTaggedCanTombstone: mentionTaggedCoverage.scanState === 'complete',
                likedContentCanTombstone: false,
                now: new Date().toISOString(),
            });

            await saveTargetHistoryState({
                store: targetHistoryStore,
                state: mergedHistory.nextState,
            });

            if (mergedHistory.outputEvents.length > 0) {
                await Actor.pushData(mergedHistory.outputEvents);
            }

            Object.assign(historyMergeResult, mergedHistory);
            log.info(`History merge finished with ${mergedHistory.historySummary.visibleEvents} visible events and ${mergedHistory.historySummary.historicalTombstones} tombstones.`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown history merge error.';
            historyMergeResult.warnings.push(`Failed to persist or reuse historical state: ${message}`);
            log.warning(`History merge failed: ${message}`);
        }
    }

    const status: RunStatus = (() => {
        if (scanState === 'partial_failure' || lastDiscoverySearchMode === 'degraded') {
            return 'partial_coverage';
        }

        if (currentEvents.length > 0) {
            return 'resolved_with_results';
        }

        return 'resolved_no_results';
    })();

    const resultState = currentEvents.length > 0 ? 'results_found' : 'nothing_found';
    const matchedReplies = commentScanResult.events.filter((event) => event.commentKind === 'reply').length;
    const confidenceLevel = computeConfidenceLevel({
        exactMatches: commentScanResult.events.length,
        ambiguousCandidates: commentScanResult.ambiguousCandidates.length,
    });

    const coverageReason = (() => {
        if (lastDiscoverySearchMode === 'degraded' && finalCandidatePosts.length === 0) {
            return 'Canonical target resolution was temporarily unavailable. The Actor continued in degraded mode using the input username only, but the current discovery plan had no candidate public posts to inspect yet.';
        }

        if (lastDiscoverySearchMode === 'degraded') {
            return 'Canonical target resolution was temporarily unavailable. The Actor continued in degraded mode using public discovery signals and external public search, so coverage remains best-effort and partial.';
        }

        if (targetIsPrivate && finalCandidatePosts.length === 0) {
            return 'The target is private. The Actor continued in public comment hunting mode, but the current discovery plan had no candidate public posts to inspect yet.';
        }

        if (finalCandidatePosts.length === 0) {
            return 'The current discovery plan produced no candidate public posts to inspect.';
        }

        if (!commentScanResult.browserAvailable) {
            return 'Browser-based public comment extraction could not start in the current runtime.';
        }

        if (scanState === 'partial_failure') {
            return 'At least one branch of visible comment discovery failed, so results may be incomplete.';
        }

        if (scanState === 'low_coverage') {
            return commentScanResult.events.length > 0
                ? 'The Actor found results, but only within a narrow visible public comment window.'
                : 'The Actor completed without runtime failures, but only a narrow visible public comment window was available.';
        }

        return 'The Actor scanned a broader recent post sample without runtime failures, but coverage remains best-effort.';
    })();

    const confidenceReason = (() => {
        if (commentScanResult.events.length > 0 && commentScanResult.ambiguousCandidates.length === 0) {
            return 'All confirmed matches in this run use exact visible owner-username equality against the resolved target username.';
        }

        if (commentScanResult.events.length > 0 && commentScanResult.ambiguousCandidates.length > 0) {
            return 'Confirmed matches use exact visible owner-username equality, and similar near-matches were flagged separately as ambiguous candidates.';
        }

        if (commentScanResult.ambiguousCandidates.length > 0) {
            return 'No confirmed exact matches were found, but similar visible owner usernames were flagged separately as ambiguous candidates.';
        }

        return 'No confirmed or ambiguous comment matches were found in the inspected visible thread scope.';
    })();

    const likedContentConfidenceReason = (() => {
        if (likedContentEvents > 0 && likedContentScanResult.ambiguousCandidates.length === 0) {
            return 'All liked-content matches in this run came from exact attributable public liker-username signals.';
        }

        if (likedContentEvents > 0 && likedContentScanResult.ambiguousCandidates.length > 0) {
            return 'Confirmed liked-content matches used exact attributable public liker-username signals, and similar near-matches were flagged separately as ambiguous.';
        }

        if (likedContentScanResult.ambiguousCandidates.length > 0) {
            return 'No confirmed liked-content matches were found, but similar public liker usernames were flagged separately as ambiguous.';
        }

        return 'No attributable public liker usernames were confirmed for the resolved target in the scanned public surfaces.';
    })();

    const warnings = [...targetResolution.warnings, ...aggregatedDiscoveryWarnings, ...ownerExpansionWarnings, ...commentScanResult.warnings];
    const summary: RunSummary = {
        status,
        message: (() => {
            if (lastDiscoverySearchMode === 'degraded') {
                if (commentScanResult.events.length > 0) {
                    return `Canonical target resolution for @${input.username} was unavailable, but the Actor continued in degraded mode and found ${commentScanResult.events.length} confirmed public comments or replies.`;
                }

                return currentEvents.length > 0
                    ? `Canonical target resolution for @${input.username} was unavailable. The Actor found no confirmed public comments in the current discovery scope, but it did return ${currentEvents.length} supporting activity events from secondary surfaces.`
                    : `Canonical target resolution for @${input.username} was unavailable. The Actor continued in degraded mode, but found no confirmed public comments in the current discovery scope.`;
            }

            if (status === 'resolved_with_results') {
                if (commentScanResult.events.length > 0) {
                    return targetIsPrivate
                        ? `Resolved private target @${searchUsername} and found ${commentScanResult.events.length} confirmed public comments or replies.`
                        : `Resolved @${searchUsername} and found ${commentScanResult.events.length} confirmed public comments or replies.`;
                }

                return targetIsPrivate
                    ? `Resolved private target @${searchUsername}. The Actor found no confirmed public comments in the inspected discovery scope, but it did return ${currentEvents.length} supporting activity events from secondary surfaces.`
                    : `Resolved @${searchUsername}. The Actor found no confirmed public comments in the inspected discovery scope, but it did return ${currentEvents.length} supporting activity events from secondary surfaces.`;
            }

            if (status === 'resolved_no_results') {
                if (historyMergeResult.historySummary.historicalTombstones > 0 || historyMergeResult.historySummary.historicalUnconfirmed > 0) {
                    return `Resolved @${searchUsername}, found no confirmed public comments in the current discovery scope, and returned ${historyMergeResult.historySummary.historicalTombstones + historyMergeResult.historySummary.historicalUnconfirmed} historical observations from prior runs.`;
                }

                return targetIsPrivate
                    ? `Resolved private target @${searchUsername}. The Actor continued in public comment hunting mode, but found no confirmed public comments in the inspected discovery scope.`
                    : `Resolved @${searchUsername}, but found no confirmed public comments in the inspected discovery scope.`;
            }

            return `Resolved @${searchUsername}, but confirmed public comment discovery completed with partial coverage.`;
        })(),
        resultState,
        operation: {
            runMode: input.runMode,
            maxDiscoveryCycles: input.maxDiscoveryCycles,
            cyclesCompleted,
            stoppedBecause,
        },
        target: {
            inputUsername: input.username,
            resolvedUsername: resolvedTarget?.username ?? null,
            profileUrl: targetProfileUrl,
            isAvailable: targetIsAvailable,
            isPrivate: targetIsPrivate,
        },
        comments: {
            resultState: commentResultState,
            ambiguousRecordKey: ambiguousCommentRecordKey,
            counts: {
                candidatePosts: finalCandidatePosts.length,
                scannedPosts: commentScanResult.scannedPosts,
                visibleCommentsScanned: commentScanResult.visibleCommentsScanned,
                structuredCommentsScanned: commentScanResult.structuredCommentsScanned,
                confirmedComments: commentScanResult.events.length,
                confirmedReplies: matchedReplies,
                ambiguousCandidates: commentScanResult.ambiguousCandidates.length,
            },
        },
        discovery: {
            searchMode: lastDiscoverySearchMode,
            searchUsername: lastDiscoverySearchUsername,
            counts: {
                ...aggregatedDiscoveryCounts,
                expandedOwnerProfiles: aggregatedDiscoveryCounts.expandedOwnerProfiles + ownerExpansionProfiles,
                expandedOwnerPosts: aggregatedDiscoveryCounts.expandedOwnerPosts + ownerExpansionPosts,
            },
            warnings: [...aggregatedDiscoveryWarnings, ...ownerExpansionWarnings],
        },
        coverage: {
            level: coverageLevel,
            scanState,
            reason: coverageReason,
        },
        confidence: {
            level: confidenceLevel,
            reason: confidenceReason,
            exactMatches: commentScanResult.events.length,
            ambiguousCandidates: commentScanResult.ambiguousCandidates.length,
            ambiguousSamples: commentScanResult.ambiguousCandidates,
        },
        mentionTagged: {
            coverage: mentionTaggedCoverage,
            counts: {
                scannedPosts: mentionTaggedScanResult.scannedPosts,
                mentionEvents,
                taggedAppearanceEvents,
                partialFailures: mentionTaggedScanResult.partialFailures,
                warnings: mentionTaggedScanResult.warnings.length,
            },
            warnings: mentionTaggedScanResult.warnings,
        },
        likedContent: {
            coverage: likedContentCoverage,
            confidence: {
                level: likedContentConfidenceLevel,
                reason: likedContentConfidenceReason,
                exactMatches: likedContentEvents,
                ambiguousCandidates: likedContentScanResult.ambiguousCandidates.length,
                ambiguousSamples: likedContentScanResult.ambiguousCandidates,
            },
            counts: {
                scannedPosts: likedContentScanResult.scannedPosts,
                discoverableSignals: likedContentScanResult.discoverableSignals,
                likedContentEvents,
                ambiguousCandidates: likedContentScanResult.ambiguousCandidates.length,
                partialFailures: likedContentScanResult.partialFailures,
                warnings: likedContentScanResult.warnings.length,
            },
            warnings: likedContentScanResult.warnings,
        },
        history: historyMergeResult.historySummary,
        counts: {
            candidateProfiles: aggregatedCandidateProfiles,
            candidatePosts: finalCandidatePosts.length,
            scannedPosts: commentScanResult.scannedPosts,
            visibleCommentsScanned: commentScanResult.visibleCommentsScanned,
            matchedComments: commentScanResult.events.length,
            matchedReplies,
            mentionEvents,
            taggedAppearanceEvents,
            likedContentEvents,
            likedContentAmbiguousCandidates: likedContentScanResult.ambiguousCandidates.length,
            ambiguousCandidates: commentScanResult.ambiguousCandidates.length,
            partialFailures: commentScanResult.partialFailures + mentionTaggedScanResult.partialFailures + likedContentScanResult.partialFailures,
            warnings: warnings.length + mentionTaggedScanResult.warnings.length + likedContentScanResult.warnings.length + historyMergeResult.warnings.length,
        },
        warnings: [...warnings, ...likedContentScanResult.warnings, ...mentionTaggedScanResult.warnings, ...historyMergeResult.warnings],
    };

    log.info('Persisting RUN_SUMMARY.');
    await Actor.setValue('RUN_SUMMARY', summary);
    log.info('RUN_SUMMARY persisted successfully.');
    log.info(summary.message);
    if (summary.warnings.length > 0) {
        log.warning(`Run completed with ${summary.warnings.length} warning(s).`);
    }
}

try {
    await run();
} finally {
    await Actor.exit();
}
