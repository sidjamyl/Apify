import type { KeyValueStore } from 'apify';
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
    dedupeByKey,
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
import {
    expandRootGraphWithOperatorResources,
    prepareOperatorResources,
    summarizeGraphExpansion,
} from './operator-resources.js';
import {
    buildDeepInvestigationRuntimeStateKey,
    buildRuntimeInfo,
    checkpointRuntimeJob,
    completeRuntimeJob,
    createInitialDeepInvestigationRuntimeState,
    type DeepInvestigationRuntimeJob,
    type DeepInvestigationRuntimeState,
    enqueueRuntimeJob,
    heartbeatRuntimeJob,
    leaseNextRuntimeJob,
    loadDeepInvestigationRuntimeState,
    markRuntimeJobRunning,
    openDeepInvestigationRuntimeStore,
    recoverInterruptedRuntimeJobs,
    saveDeepInvestigationRuntimeState,
} from './runtime-state.js';
import type {
    CoverageLevel,
    DiscoveryCounts,
    InstagramPost,
    RunStatus,
    RunSummary,
    ScanState,
    TargetHistoryState,
} from './types.js';

type AbortHandlerSetter = (handler: (() => Promise<void>) | null) => void;

interface HistoryMergeLikeResult {
    historySummary: RunSummary['history'];
    warnings: string[];
}

function emptyDiscoveryCounts(): DiscoveryCounts {
    return {
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

function buildNoScanSummary(input: {
    status: RunStatus;
    message: string;
    state: DeepInvestigationRuntimeState;
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
        state,
        resolvedUsername,
        profileUrl,
        isAvailable,
        isPrivate,
        reason,
        warnings,
        partialFailures,
    } = input;

    const combinedWarnings = [...warnings, ...state.operatorResources.summary.warnings];

    return {
        status,
        message,
        resultState: 'nothing_found',
        operation: {
            runMode: state.input.runMode,
            maxDiscoveryCycles: state.input.maxDiscoveryCycles,
            cyclesCompleted: state.progress.cyclesCompleted,
            stoppedBecause: state.progress.stoppedBecause ?? 'no_candidates',
            runtime: buildRuntimeInfo({ state }),
        },
        target: {
            inputUsername: state.input.username,
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
            searchMode: state.target.searchMode,
            searchUsername: state.target.searchUsername,
            counts: emptyDiscoveryCounts(),
            warnings: [],
        },
        operatorResources: state.operatorResources.summary,
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
            warnings: combinedWarnings.length,
        },
        warnings: combinedWarnings,
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

function buildHistoricalCandidatePosts(previousHistoryState: TargetHistoryState | null) {
    return previousHistoryState
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
}

function buildHistoricalFruitfulOwners(previousHistoryState: TargetHistoryState | null, searchUsername: string): string[] {
    return previousHistoryState
        ? [...new Set(
            previousHistoryState.events
                .filter((event) => event.payload.type === 'comment')
                .map((event) => event.payload.postOwnerUsername)
                .filter((ownerUsername) => ownerUsername && ownerUsername !== searchUsername),
        )]
        : [];
}

function mergeKnownCandidatePosts(existingPosts: InstagramPost[], nextPosts: InstagramPost[]) {
    return dedupeByKey([...existingPosts, ...nextPosts], (post) => post.shortcode);
}

async function hydrateRuntimeState(input: ReturnType<typeof parseInput>, runtimeStore: KeyValueStore): Promise<DeepInvestigationRuntimeState> {
    const stateKey = buildDeepInvestigationRuntimeStateKey({ username: input.username, runMode: input.runMode });
    const existingState = await loadDeepInvestigationRuntimeState({ store: runtimeStore, stateKey });

    const isCompatibleExistingState = existingState
        && 'operatorResources' in existingState
        && Array.isArray(existingState.input.operatorAccounts)
        && 'graphExpansion' in existingState.input;

    if (isCompatibleExistingState && existingState.status === 'running' && existingState.input.maxDiscoveryCycles === input.maxDiscoveryCycles) {
        existingState.reusedExistingState = true;
        recoverInterruptedRuntimeJobs({ state: existingState, now: new Date().toISOString() });
        await saveDeepInvestigationRuntimeState({ store: runtimeStore, state: existingState });
        return existingState;
    }

    const freshState = createInitialDeepInvestigationRuntimeState(input);
    await saveDeepInvestigationRuntimeState({ store: runtimeStore, state: freshState });
    return freshState;
}

async function executeTargetResolutionJob(input: {
    state: DeepInvestigationRuntimeState;
    targetHistoryStore: KeyValueStore;
    candidateCacheStore: KeyValueStore;
    job: DeepInvestigationRuntimeJob;
}): Promise<void> {
    const { state, targetHistoryStore, candidateCacheStore, job } = input;
    const targetResolution = await resolveTargetProfile(state.input.username);

    state.target.targetResolutionStatus = targetResolution.status;
    state.target.targetResolutionMessage = targetResolution.message;
    state.target.targetResolutionWarnings = targetResolution.warnings;

    if (targetResolution.status === 'not_found') {
        state.target.searchUsername = state.input.username;
        state.target.searchMode = 'canonical';
        state.progress.stoppedBecause = 'no_candidates';
        enqueueRuntimeJob({
            state,
            key: 'finalize_run',
            kind: 'finalize_run',
            payload: { kind: 'finalize_run' },
            now: new Date().toISOString(),
        });
        return;
    }

    if (targetResolution.status === 'unavailable') {
        state.target.searchMode = 'degraded';
        state.target.searchUsername = state.input.username;
        state.target.resolvedTarget = null;
        state.target.targetProfileUrl = null;
        state.target.targetIsAvailable = false;
        state.target.targetIsPrivate = false;
        state.target.historyIdentityMode = 'input_username';
        state.target.historyIdentityValue = state.input.username;
    } else {
        const canonicalTarget = targetResolution.resolvedTarget;
        if (!canonicalTarget) {
            throw new Error('Expected a resolved target for canonical search mode.');
        }

        state.target.searchMode = 'canonical';
        state.target.searchUsername = canonicalTarget.username;
        state.target.resolvedTarget = canonicalTarget;
        state.target.targetProfileUrl = canonicalTarget.profileUrl;
        state.target.targetIsAvailable = true;
        state.target.targetIsPrivate = canonicalTarget.isPrivate;
        state.target.historyIdentityMode = 'canonical_target';
        state.target.historyIdentityValue = canonicalTarget.id;
    }

    const previousHistoryState = state.target.historyIdentityMode && state.target.historyIdentityValue
        ? await loadTargetHistoryState({
            store: targetHistoryStore,
            identityMode: state.target.historyIdentityMode,
            identityValue: state.target.historyIdentityValue,
        })
        : null;

    state.target.historicalCandidatePosts = buildHistoricalCandidatePosts(previousHistoryState);
    state.target.historicalFruitfulOwners = buildHistoricalFruitfulOwners(previousHistoryState, state.target.searchUsername);

    const targetCandidateCache = await loadTargetCandidateCache({
        store: candidateCacheStore,
        targetUsername: state.target.searchUsername,
    });
    const cachedCandidatePosts = await loadCachedCandidatePosts({
        store: candidateCacheStore,
        shortcodes: targetCandidateCache?.candidateShortcodes ?? [],
    });

    state.target.targetCandidateCache = targetCandidateCache;
    state.progress.aggregatedDiscoveryCounts.cachedCandidatePosts = cachedCandidatePosts.length;
    state.progress.knownCandidatePosts = mergeKnownCandidatePosts(cachedCandidatePosts, state.target.historicalCandidatePosts);

    enqueueRuntimeJob({
        state,
        key: 'operator_resource_bootstrap',
        kind: 'operator_resource_bootstrap',
        payload: {
            kind: 'operator_resource_bootstrap',
        },
        now: new Date().toISOString(),
    });
    log.info(`Initialized deep investigation runtime for @${state.target.searchUsername}.`);
    void job;
}

async function executeOperatorResourceBootstrapJob(input: {
    state: DeepInvestigationRuntimeState;
}): Promise<void> {
    const { state } = input;
    const preparedResources = await prepareOperatorResources({
        actorInput: state.input,
    });

    state.operatorResources.summary = preparedResources.summary;

    if (preparedResources.readyAccounts.length > 0) {
        enqueueRuntimeJob({
            state,
            key: 'graph_root_expansion',
            kind: 'graph_root_expansion',
            payload: {
                kind: 'graph_root_expansion',
                searchUsername: state.target.searchUsername,
            },
            now: new Date().toISOString(),
        });
        return;
    }

    enqueueRuntimeJob({
        state,
        key: 'discovery_cycle:0',
        kind: 'discovery_cycle',
        payload: {
            kind: 'discovery_cycle',
            cycleIndex: 0,
        },
        now: new Date().toISOString(),
    });
}

async function executeGraphRootExpansionJob(input: {
    state: DeepInvestigationRuntimeState;
    job: DeepInvestigationRuntimeJob;
}): Promise<void> {
    const { state, job } = input;
    if (job.payload.kind !== 'graph_root_expansion') {
        throw new Error(`Expected graph_root_expansion payload for ${job.key}.`);
    }

    const preparedResources = await prepareOperatorResources({
        actorInput: state.input,
    });
    state.operatorResources.summary = preparedResources.summary;

    if (preparedResources.readyAccounts.length === 0) {
        enqueueRuntimeJob({
            state,
            key: 'discovery_cycle:0',
            kind: 'discovery_cycle',
            payload: {
                kind: 'discovery_cycle',
                cycleIndex: 0,
            },
            now: new Date().toISOString(),
        });
        return;
    }

    const graphExpansion = await expandRootGraphWithOperatorResources({
        actorInput: state.input,
        targetUsername: job.payload.searchUsername,
        biography: state.target.resolvedTarget?.biography ?? null,
        preparedResources,
    });

    const expandedUsernames = dedupeByKey(
        [
            ...graphExpansion.bioLinkedUsernames,
            ...graphExpansion.followersUsernames,
            ...graphExpansion.followingUsernames,
        ].filter((username) => username !== state.target.searchUsername),
        (username) => username,
    ).slice(0, state.input.graphExpansion.maxExpandedProfiles);

    let expandedProfiles = 0;
    let expandedPosts = 0;
    if (expandedUsernames.length > 0) {
        const expandedProfilesResult = await expandPublicProfiles({
            profileUsernames: expandedUsernames,
            searchUsername: state.target.searchUsername,
            discoverySource: 'expanded_owner_graph',
        });

        state.progress.knownCandidatePosts = mergeKnownCandidatePosts(state.progress.knownCandidatePosts, expandedProfilesResult.expandedPosts);
        state.progress.aggregatedDiscoveryWarnings.push(...expandedProfilesResult.warnings);
        state.progress.aggregatedDiscoveryCounts.expandedOwnerProfiles += expandedProfilesResult.expandedOwnerProfiles;
        state.progress.aggregatedDiscoveryCounts.expandedOwnerPosts += expandedProfilesResult.expandedPosts.length;
        expandedProfiles = expandedProfilesResult.expandedOwnerProfiles;
        expandedPosts = expandedProfilesResult.expandedPosts.length;
    }

    state.operatorResources.summary = summarizeGraphExpansion({
        previousSummary: state.operatorResources.summary,
        expansion: graphExpansion,
        expandedProfiles,
        expandedPosts,
    });

    enqueueRuntimeJob({
        state,
        key: 'discovery_cycle:0',
        kind: 'discovery_cycle',
        payload: {
            kind: 'discovery_cycle',
            cycleIndex: 0,
        },
        now: new Date().toISOString(),
    });
}

async function executeDiscoveryCycleJob(input: {
    state: DeepInvestigationRuntimeState;
    job: DeepInvestigationRuntimeJob;
}): Promise<void> {
    const { state, job } = input;
    if (job.payload.kind !== 'discovery_cycle') {
        throw new Error(`Expected discovery_cycle payload for ${job.key}.`);
    }

    if (state.progress.cyclesCompleted >= state.input.maxDiscoveryCycles) {
        state.progress.stoppedBecause = 'completed_all_cycles';
        enqueueRuntimeJob({
            state,
            key: 'finalize_run',
            kind: 'finalize_run',
            payload: { kind: 'finalize_run' },
            now: new Date().toISOString(),
        });
        return;
    }

    const discoveryPlan = await buildCandidateDiscoveryPlan({
        resolvedTarget: state.target.resolvedTarget,
        inputUsername: state.input.username,
        searchMode: state.target.searchMode,
        cachedCandidatePosts: state.progress.knownCandidatePosts,
        cachedFruitfulOwnerUsernames: [
            ...(state.target.targetCandidateCache?.fruitfulOwnerUsernames ?? []),
            ...state.target.historicalFruitfulOwners,
        ],
        cachedTargetState: state.target.targetCandidateCache,
    });

    heartbeatRuntimeJob({ state, jobKey: job.key, now: new Date().toISOString() });
    const refreshedDiscoveryCandidates = await refreshCandidatePostsMetadata(discoveryPlan.candidatePosts);
    discoveryPlan.candidatePosts = refreshedDiscoveryCandidates.posts;
    state.target.searchUsername = discoveryPlan.searchUsername;
    state.target.searchMode = discoveryPlan.searchMode;
    state.progress.cyclesCompleted += 1;
    state.progress.aggregatedCandidateProfiles = Math.max(state.progress.aggregatedCandidateProfiles, discoveryPlan.candidateProfiles);
    state.progress.aggregatedDiscoveryCounts.targetProfilePosts = Math.max(state.progress.aggregatedDiscoveryCounts.targetProfilePosts, discoveryPlan.discoveryCounts.targetProfilePosts);
    state.progress.aggregatedDiscoveryCounts.relatedProfilePosts += discoveryPlan.discoveryCounts.relatedProfilePosts;
    state.progress.aggregatedDiscoveryCounts.cachedCandidatePosts = Math.max(state.progress.aggregatedDiscoveryCounts.cachedCandidatePosts, discoveryPlan.discoveryCounts.cachedCandidatePosts);
    state.progress.aggregatedDiscoveryCounts.cachedFruitfulOwnerProfiles = Math.max(state.progress.aggregatedDiscoveryCounts.cachedFruitfulOwnerProfiles, discoveryPlan.discoveryCounts.cachedFruitfulOwnerProfiles);
    state.progress.aggregatedDiscoveryCounts.frontierProfilesQueued = Math.max(state.progress.aggregatedDiscoveryCounts.frontierProfilesQueued, discoveryPlan.discoveryCounts.frontierProfilesQueued);
    state.progress.aggregatedDiscoveryCounts.externalSearchQueries += discoveryPlan.discoveryCounts.externalSearchQueries;
    state.progress.aggregatedDiscoveryCounts.externalSearchHits += discoveryPlan.discoveryCounts.externalSearchHits;
    state.progress.aggregatedDiscoveryCounts.externalSearchCandidatePosts += discoveryPlan.discoveryCounts.externalSearchCandidatePosts;
    state.progress.aggregatedDiscoveryCounts.expandedOwnerProfiles += discoveryPlan.discoveryCounts.expandedOwnerProfiles;
    state.progress.aggregatedDiscoveryCounts.expandedOwnerPosts += discoveryPlan.discoveryCounts.expandedOwnerPosts;
    state.progress.aggregatedDiscoveryWarnings.push(...discoveryPlan.warnings, ...refreshedDiscoveryCandidates.warnings);
    state.progress.knownCandidatePosts = mergeKnownCandidatePosts(state.progress.knownCandidatePosts, discoveryPlan.candidatePosts);

    const scannedShortcodes = new Set(state.progress.scannedShortcodes);
    const cycleCandidatePosts = discoveryPlan.candidatePosts
        .filter((post) => !scannedShortcodes.has(post.shortcode))
        .slice(0, state.input.runMode === 'freshness' ? 10 : 30);

    log.info(`Deep cycle ${job.payload.cycleIndex + 1}/${state.input.maxDiscoveryCycles}: ${cycleCandidatePosts.length} new candidate posts selected.`);

    if (cycleCandidatePosts.length === 0) {
        state.progress.stoppedBecause = state.progress.cyclesCompleted === 1 ? 'no_candidates' : 'saturated';
        enqueueRuntimeJob({
            state,
            key: 'finalize_run',
            kind: 'finalize_run',
            payload: { kind: 'finalize_run' },
            now: new Date().toISOString(),
        });
        return;
    }

    enqueueRuntimeJob({
        state,
        key: `comment_scan_batch:${job.payload.cycleIndex}`,
        kind: 'comment_scan_batch',
        payload: {
            kind: 'comment_scan_batch',
            cycleIndex: job.payload.cycleIndex,
            searchUsername: discoveryPlan.searchUsername,
            candidateShortcodes: cycleCandidatePosts.map((post) => post.shortcode),
        },
        now: new Date().toISOString(),
    });
}

async function executeCommentScanBatchJob(input: {
    state: DeepInvestigationRuntimeState;
    candidateCacheStore: KeyValueStore;
    job: DeepInvestigationRuntimeJob;
}): Promise<void> {
    const { state, candidateCacheStore, job } = input;
    if (job.payload.kind !== 'comment_scan_batch') {
        throw new Error(`Expected comment_scan_batch payload for ${job.key}.`);
    }

    const currentCycleSearchUsername = job.payload.searchUsername;
    const knownCandidatePostsByShortcode = new Map(state.progress.knownCandidatePosts.map((post) => [post.shortcode, post]));
    const cycleCandidatePosts = job.payload.candidateShortcodes
        .map((shortcode) => knownCandidatePostsByShortcode.get(shortcode))
        .filter((post): post is NonNullable<typeof post> => Boolean(post));

    if (cycleCandidatePosts.length === 0) {
        state.progress.noProgressCycles += 1;
    } else {
        heartbeatRuntimeJob({ state, jobKey: job.key, now: new Date().toISOString() });
        const cycleCommentScanResult = await scanCommentsOnCandidatePosts({
            candidatePosts: cycleCandidatePosts,
            resolvedUsername: currentCycleSearchUsername,
        });

        const scannedShortcodes = new Set(state.progress.scannedShortcodes);
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
                searchUsername: state.target.searchUsername,
                discoverySource: 'expanded_owner_graph',
            });

            cycleOwnerExpansionWarnings = expandedCommentOwnerProfiles.warnings;
            cycleOwnerExpansionProfiles = expandedCommentOwnerProfiles.expandedOwnerProfiles;

            const extraCandidatePosts = expandedCommentOwnerProfiles.expandedPosts.filter((post) => {
                return !scannedShortcodes.has(post.shortcode) && !cycleCandidatePosts.some((existingPost) => existingPost.shortcode === post.shortcode);
            });
            cycleOwnerExpansionPosts = extraCandidatePosts.length;

            if (extraCandidatePosts.length > 0) {
                log.info(`Cycle ${job.payload.cycleIndex + 1}: confirmed-comment owner expansion added ${extraCandidatePosts.length} new candidate posts.`);
                state.progress.knownCandidatePosts = mergeKnownCandidatePosts(state.progress.knownCandidatePosts, extraCandidatePosts);

                const extraCommentScanResult = await scanCommentsOnCandidatePosts({
                    candidatePosts: extraCandidatePosts,
                    resolvedUsername: state.target.searchUsername,
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

        state.progress.scannedShortcodes = [...scannedShortcodes];
        state.progress.aggregatedCommentScanResult.scannedPosts += cycleCommentScanResult.scannedPosts;
        state.progress.aggregatedCommentScanResult.visibleCommentsScanned += cycleCommentScanResult.visibleCommentsScanned;
        state.progress.aggregatedCommentScanResult.structuredCommentsScanned += cycleCommentScanResult.structuredCommentsScanned;
        state.progress.aggregatedCommentScanResult.partialFailures += cycleCommentScanResult.partialFailures;
        state.progress.aggregatedCommentScanResult.warnings.push(...cycleCommentScanResult.warnings);
        state.progress.aggregatedCommentScanResult.events.push(...cycleCommentScanResult.events);
        state.progress.aggregatedCommentScanResult.ambiguousCandidates.push(...cycleCommentScanResult.ambiguousCandidates);
        state.progress.ownerExpansionWarnings.push(...cycleOwnerExpansionWarnings);
        state.progress.ownerExpansionProfiles += cycleOwnerExpansionProfiles;
        state.progress.ownerExpansionPosts += cycleOwnerExpansionPosts;

        state.target.targetCandidateCache = await persistCandidateDiscoveryCache({
            store: candidateCacheStore,
            targetUsername: state.target.searchUsername,
            candidatePosts: state.progress.knownCandidatePosts,
            fruitfulOwnerUsernames: cycleConfirmedCommentOwners,
            frontierUsernames: state.progress.knownCandidatePosts
                .flatMap((post) => [post.ownerUsername, ...post.mentionedUsernames])
                .filter((username) => Boolean(username) && username !== currentCycleSearchUsername),
            ownerStatUpdates: cycleConfirmedCommentOwners.map((ownerUsername) => ({
                username: ownerUsername.toLowerCase(),
                successfulCommentCountDelta: cycleCommentScanResult.events.filter((event) => event.postOwnerUsername === ownerUsername).length,
                successfulRunIncrement: 1,
                expandedPostCountDelta: state.progress.knownCandidatePosts.filter((post) => post.ownerUsername === ownerUsername).length,
                lastSuccessfulAt: new Date().toISOString(),
            })),
            previousState: state.target.targetCandidateCache,
        });

        if (cycleCommentScanResult.events.length === 0 && cycleOwnerExpansionPosts === 0) {
            state.progress.noProgressCycles += 1;
        } else {
            state.progress.noProgressCycles = 0;
        }
    }

    const saturationThreshold = state.input.runMode === 'freshness' ? 1 : 2;
    if (state.progress.noProgressCycles >= saturationThreshold) {
        state.progress.stoppedBecause = 'saturated';
        enqueueRuntimeJob({
            state,
            key: 'finalize_run',
            kind: 'finalize_run',
            payload: { kind: 'finalize_run' },
            now: new Date().toISOString(),
        });
        return;
    }

    if (state.progress.cyclesCompleted >= state.input.maxDiscoveryCycles) {
        state.progress.stoppedBecause = 'completed_all_cycles';
        enqueueRuntimeJob({
            state,
            key: 'finalize_run',
            kind: 'finalize_run',
            payload: { kind: 'finalize_run' },
            now: new Date().toISOString(),
        });
        return;
    }

    enqueueRuntimeJob({
        state,
        key: `discovery_cycle:${job.payload.cycleIndex + 1}`,
        kind: 'discovery_cycle',
        payload: {
            kind: 'discovery_cycle',
            cycleIndex: job.payload.cycleIndex + 1,
        },
        now: new Date().toISOString(),
    });
}

async function finalizeRuntime(input: {
    state: DeepInvestigationRuntimeState;
    targetHistoryStore: KeyValueStore;
}): Promise<RunSummary> {
    const { state, targetHistoryStore } = input;

    if (state.target.targetResolutionStatus === 'not_found') {
        const summary = buildNoScanSummary({
            status: 'target_not_found_or_renamed',
            message: state.target.targetResolutionMessage ?? `No public Instagram profile could be resolved for "${state.input.username}". It may be missing, renamed, or unavailable.`,
            state,
            resolvedUsername: null,
            profileUrl: null,
            isAvailable: false,
            isPrivate: false,
            reason: 'Target could not be resolved on public Instagram surfaces.',
            warnings: state.target.targetResolutionWarnings,
            partialFailures: 0,
        });
        state.finalSummary = summary;
        state.status = 'completed';
        await Actor.setValue('RUN_SUMMARY', summary);
        log.warning(summary.message);
        return summary;
    }

    const commentScanResult = state.progress.aggregatedCommentScanResult;
    const finalCandidatePosts = state.progress.knownCandidatePosts;
    const likedContentScanResult = scanLikedContentAppearances({
        candidatePosts: finalCandidatePosts,
        resolvedUsername: state.target.searchUsername,
    });
    const mentionTaggedScanResult = scanMentionTaggedAppearances({
        candidatePosts: finalCandidatePosts,
        resolvedUsername: state.target.searchUsername,
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
        await Actor.setValue('AMBIGUOUS_COMMENT_CANDIDATES', commentScanResult.ambiguousCandidates);
    }

    const previousHistoryState = state.target.historyIdentityMode && state.target.historyIdentityValue
        ? await loadTargetHistoryState({
            store: targetHistoryStore,
            identityMode: state.target.historyIdentityMode,
            identityValue: state.target.historyIdentityValue,
        })
        : null;

    let historyMergeResult: HistoryMergeLikeResult = {
        historySummary: emptyHistorySummary(),
        warnings: [],
    };

    if (state.target.historyIdentityMode && state.target.historyIdentityValue) {
        const mergedHistory = mergeHistoricalObservations({
            targetId: state.target.historyIdentityValue,
            identityMode: state.target.historyIdentityMode,
            resolvedUsername: state.target.searchUsername,
            profileUrl: state.target.targetProfileUrl ?? '',
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

        historyMergeResult = mergedHistory;
        log.info(`History merge finished with ${mergedHistory.historySummary.visibleEvents} visible events and ${mergedHistory.historySummary.historicalTombstones} tombstones.`);
    }

    const status: RunStatus = (() => {
        if (scanState === 'partial_failure' || state.target.searchMode === 'degraded') {
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
        if (state.target.searchMode === 'degraded' && finalCandidatePosts.length === 0) {
            return 'Canonical target resolution was temporarily unavailable. The Actor continued in degraded mode using the input username only, but the current discovery plan had no candidate public posts to inspect yet.';
        }

        if (state.target.searchMode === 'degraded') {
            return 'Canonical target resolution was temporarily unavailable. The Actor continued in degraded mode using public discovery signals and external public search, so coverage remains best-effort and partial.';
        }

        if (state.target.targetIsPrivate && finalCandidatePosts.length === 0) {
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

    const warnings = [
        ...state.target.targetResolutionWarnings,
        ...state.operatorResources.summary.warnings,
        ...state.progress.aggregatedDiscoveryWarnings,
        ...state.progress.ownerExpansionWarnings,
        ...commentScanResult.warnings,
    ];

    const summary: RunSummary = {
        status,
        message: (() => {
            if (state.target.searchMode === 'degraded') {
                if (commentScanResult.events.length > 0) {
                    return `Canonical target resolution for @${state.input.username} was unavailable, but the Actor continued in degraded mode and found ${commentScanResult.events.length} confirmed public comments or replies.`;
                }

                return currentEvents.length > 0
                    ? `Canonical target resolution for @${state.input.username} was unavailable. The Actor found no confirmed public comments in the current discovery scope, but it did return ${currentEvents.length} supporting activity events from secondary surfaces.`
                    : `Canonical target resolution for @${state.input.username} was unavailable. The Actor continued in degraded mode, but found no confirmed public comments in the current discovery scope.`;
            }

            if (status === 'resolved_with_results') {
                if (commentScanResult.events.length > 0) {
                    return state.target.targetIsPrivate
                        ? `Resolved private target @${state.target.searchUsername} and found ${commentScanResult.events.length} confirmed public comments or replies.`
                        : `Resolved @${state.target.searchUsername} and found ${commentScanResult.events.length} confirmed public comments or replies.`;
                }

                return state.target.targetIsPrivate
                    ? `Resolved private target @${state.target.searchUsername}. The Actor found no confirmed public comments in the inspected discovery scope, but it did return ${currentEvents.length} supporting activity events from secondary surfaces.`
                    : `Resolved @${state.target.searchUsername}. The Actor found no confirmed public comments in the inspected discovery scope, but it did return ${currentEvents.length} supporting activity events from secondary surfaces.`;
            }

            if (status === 'resolved_no_results') {
                if (historyMergeResult.historySummary.historicalTombstones > 0 || historyMergeResult.historySummary.historicalUnconfirmed > 0) {
                    return `Resolved @${state.target.searchUsername}, found no confirmed public comments in the current discovery scope, and returned ${historyMergeResult.historySummary.historicalTombstones + historyMergeResult.historySummary.historicalUnconfirmed} historical observations from prior runs.`;
                }

                return state.target.targetIsPrivate
                    ? `Resolved private target @${state.target.searchUsername}. The Actor continued in public comment hunting mode, but found no confirmed public comments in the inspected discovery scope.`
                    : `Resolved @${state.target.searchUsername}, but found no confirmed public comments in the inspected discovery scope.`;
            }

            return `Resolved @${state.target.searchUsername}, but confirmed public comment discovery completed with partial coverage.`;
        })(),
        resultState,
        operation: {
            runMode: state.input.runMode,
            maxDiscoveryCycles: state.input.maxDiscoveryCycles,
            cyclesCompleted: state.progress.cyclesCompleted,
            stoppedBecause: state.progress.stoppedBecause ?? 'completed_all_cycles',
            runtime: buildRuntimeInfo({ state, activeJobKey: 'finalize_run' }),
        },
        target: {
            inputUsername: state.input.username,
            resolvedUsername: state.target.resolvedTarget?.username ?? null,
            profileUrl: state.target.targetProfileUrl,
            isAvailable: state.target.targetIsAvailable,
            isPrivate: state.target.targetIsPrivate,
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
            searchMode: state.target.searchMode,
            searchUsername: state.target.searchUsername,
            counts: {
                ...state.progress.aggregatedDiscoveryCounts,
                expandedOwnerProfiles: state.progress.aggregatedDiscoveryCounts.expandedOwnerProfiles + state.progress.ownerExpansionProfiles,
                expandedOwnerPosts: state.progress.aggregatedDiscoveryCounts.expandedOwnerPosts + state.progress.ownerExpansionPosts,
            },
            warnings: [...state.progress.aggregatedDiscoveryWarnings, ...state.progress.ownerExpansionWarnings],
        },
        operatorResources: state.operatorResources.summary,
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
            candidateProfiles: state.progress.aggregatedCandidateProfiles,
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

    await Actor.setValue('RUN_SUMMARY', summary);
    state.finalSummary = summary;
    state.status = 'completed';
    log.info(summary.message);
    if (summary.warnings.length > 0) {
        log.warning(`Run completed with ${summary.warnings.length} warning(s).`);
    }
    return summary;
}

export async function runActor(input: {
    setAbortHandler: AbortHandlerSetter;
}): Promise<void> {
    const actorInput = parseInput(await Actor.getInput());
    log.info(`Starting deep investigation runtime for @${actorInput.username}.`);

    const runtimeStore = await openDeepInvestigationRuntimeStore();
    const candidateCacheStore = await openCandidateDiscoveryCacheStore();
    const targetHistoryStore = await openTargetHistoryStore();

    const runtimeState = await hydrateRuntimeState(actorInput, runtimeStore);
    while (runtimeState.status === 'running') {
        const nextJob = leaseNextRuntimeJob({ state: runtimeState, now: new Date().toISOString() });
        if (!nextJob) {
            if (runtimeState.finalSummary) break;
            throw new Error(`Deep investigation runtime ${runtimeState.stateKey} has no executable jobs while still marked as running.`);
        }

        const leasedJobKey = nextJob.key;
        await saveDeepInvestigationRuntimeState({ store: runtimeStore, state: runtimeState });

        input.setAbortHandler(async () => {
            if (runtimeState.status !== 'running') return;
            checkpointRuntimeJob({
                state: runtimeState,
                jobKey: leasedJobKey,
                now: new Date().toISOString(),
                note: 'Checkpointed because the Actor received an abort signal.',
                error: 'Actor abort requested before the current job could finish.',
            });
            await saveDeepInvestigationRuntimeState({ store: runtimeStore, state: runtimeState });
        });

        markRuntimeJobRunning({ state: runtimeState, jobKey: nextJob.key, now: new Date().toISOString() });
        await saveDeepInvestigationRuntimeState({ store: runtimeStore, state: runtimeState });

        try {
            switch (nextJob.kind) {
                case 'target_resolution':
                    await executeTargetResolutionJob({
                        state: runtimeState,
                        targetHistoryStore,
                        candidateCacheStore,
                        job: nextJob,
                    });
                    break;
                case 'operator_resource_bootstrap':
                    await executeOperatorResourceBootstrapJob({
                        state: runtimeState,
                    });
                    break;
                case 'graph_root_expansion':
                    await executeGraphRootExpansionJob({
                        state: runtimeState,
                        job: nextJob,
                    });
                    break;
                case 'discovery_cycle':
                    await executeDiscoveryCycleJob({
                        state: runtimeState,
                        job: nextJob,
                    });
                    break;
                case 'comment_scan_batch':
                    await executeCommentScanBatchJob({
                        state: runtimeState,
                        candidateCacheStore,
                        job: nextJob,
                    });
                    break;
                case 'finalize_run': {
                    await finalizeRuntime({
                        state: runtimeState,
                        targetHistoryStore,
                    });
                    break;
                }
                default:
                    throw new Error('Unsupported runtime job kind.');
            }

            completeRuntimeJob({ state: runtimeState, jobKey: nextJob.key, now: new Date().toISOString() });

            if (nextJob.kind === 'finalize_run' && runtimeState.finalSummary) {
                runtimeState.finalSummary.operation.runtime = buildRuntimeInfo({ state: runtimeState });
                await Actor.setValue('RUN_SUMMARY', runtimeState.finalSummary);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown deep investigation runtime error.';
            checkpointRuntimeJob({
                state: runtimeState,
                jobKey: nextJob.key,
                now: new Date().toISOString(),
                note: 'Checkpointed after an unexpected runtime error.',
                error: message,
            });
            await saveDeepInvestigationRuntimeState({ store: runtimeStore, state: runtimeState });
            throw error;
        } finally {
            input.setAbortHandler(null);
        }

        await saveDeepInvestigationRuntimeState({ store: runtimeStore, state: runtimeState });
    }

    input.setAbortHandler(null);

    if (!runtimeState.finalSummary) {
        throw new Error(`Deep investigation runtime ${runtimeState.stateKey} completed without producing RUN_SUMMARY.`);
    }
}
