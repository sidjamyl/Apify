import { setTimeout } from 'node:timers/promises';

import { Actor, log } from 'apify';

import {
    loadCachedCandidatePosts,
    loadTargetCandidateCache,
    openCandidateDiscoveryCacheStore,
    persistCandidateDiscoveryCache,
} from './candidate-cache.js';
import { buildCandidateDiscoveryPlan, expandPublicProfiles } from './candidate-discovery.js';
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
import type { CoverageLevel, HistoryIdentityMode, ResolvedTarget, RunStatus, RunSummary, ScanState } from './types.js';

Actor.on('aborting', async () => {
    await setTimeout(1_000);
    await Actor.exit();
});

await Actor.init();

function buildNoScanSummary(input: {
    status: RunStatus;
    message: string;
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

    const candidateCacheStore = await openCandidateDiscoveryCacheStore();
    const targetCandidateCache = await loadTargetCandidateCache({
        store: candidateCacheStore,
        targetUsername: searchUsername,
    });
    const cachedCandidatePosts = await loadCachedCandidatePosts({
        store: candidateCacheStore,
        shortcodes: targetCandidateCache?.candidateShortcodes ?? [],
    });

    const discoveryPlan = await buildCandidateDiscoveryPlan({
        resolvedTarget,
        inputUsername: input.username,
        searchMode,
        cachedCandidatePosts,
        cachedFruitfulOwnerUsernames: targetCandidateCache?.fruitfulOwnerUsernames ?? [],
    });
    searchUsername = discoveryPlan.searchUsername;
    log.info(`Candidate discovery finished with ${discoveryPlan.candidatePosts.length} candidate posts.`);

    const commentScanResult = await scanCommentsOnCandidatePosts({
        candidatePosts: discoveryPlan.candidatePosts,
        resolvedUsername: searchUsername,
    });
    const confirmedCommentOwners = [...new Set(
        commentScanResult.events
            .map((event) => event.postOwnerUsername)
            .filter((ownerUsername) => ownerUsername && ownerUsername !== searchUsername),
    )];

    let ownerExpansionWarnings: string[] = [];
    let ownerExpansionProfiles = 0;
    let ownerExpansionPosts = 0;

    if (confirmedCommentOwners.length > 0) {
        const expandedCommentOwnerProfiles = await expandPublicProfiles({
            profileUsernames: confirmedCommentOwners,
            searchUsername,
            discoverySource: 'expanded_owner_graph',
        });

        ownerExpansionWarnings = expandedCommentOwnerProfiles.warnings;
        ownerExpansionProfiles = expandedCommentOwnerProfiles.expandedOwnerProfiles;

        const extraCandidatePosts = expandedCommentOwnerProfiles.expandedPosts.filter((post) => {
            return !discoveryPlan.candidatePosts.some((existingPost) => existingPost.shortcode === post.shortcode);
        });
        ownerExpansionPosts = extraCandidatePosts.length;

        if (extraCandidatePosts.length > 0) {
            log.info(`Confirmed-comment owner expansion added ${extraCandidatePosts.length} new candidate posts.`);
            const extraCommentScanResult = await scanCommentsOnCandidatePosts({
                candidatePosts: extraCandidatePosts,
                resolvedUsername: searchUsername,
            });

            commentScanResult.scannedPosts += extraCommentScanResult.scannedPosts;
            commentScanResult.visibleCommentsScanned += extraCommentScanResult.visibleCommentsScanned;
            commentScanResult.partialFailures += extraCommentScanResult.partialFailures;
            commentScanResult.warnings.push(...extraCommentScanResult.warnings);
            commentScanResult.events.push(...extraCommentScanResult.events);
            commentScanResult.ambiguousCandidates.push(...extraCommentScanResult.ambiguousCandidates);

            discoveryPlan.candidatePosts.push(...extraCandidatePosts);
        }
    }

    await persistCandidateDiscoveryCache({
        store: candidateCacheStore,
        targetUsername: searchUsername,
        candidatePosts: discoveryPlan.candidatePosts,
        fruitfulOwnerUsernames: confirmedCommentOwners,
        previousState: targetCandidateCache,
    });

    const likedContentScanResult = scanLikedContentAppearances({
        candidatePosts: discoveryPlan.candidatePosts,
        resolvedUsername: searchUsername,
    });
    const mentionTaggedScanResult = scanMentionTaggedAppearances({
        candidatePosts: discoveryPlan.candidatePosts,
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
        candidatePosts: discoveryPlan.candidatePosts.length,
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
            const targetHistoryStore = await openTargetHistoryStore();
            const previousHistoryState = await loadTargetHistoryState({
                store: targetHistoryStore,
                identityMode: historyIdentityMode,
                identityValue: historyIdentityValue,
            });
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
        if (scanState === 'partial_failure' || discoveryPlan.searchMode === 'degraded') {
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
        if (discoveryPlan.searchMode === 'degraded' && discoveryPlan.candidatePosts.length === 0) {
            return 'Canonical target resolution was temporarily unavailable. The Actor continued in degraded mode using the input username only, but the current discovery plan had no candidate public posts to inspect yet.';
        }

        if (discoveryPlan.searchMode === 'degraded') {
            return 'Canonical target resolution was temporarily unavailable. The Actor continued in degraded mode using public discovery signals and external public search, so coverage remains best-effort and partial.';
        }

        if (targetIsPrivate && discoveryPlan.candidatePosts.length === 0) {
            return 'The target is private. The Actor continued in public comment hunting mode, but the current discovery plan had no candidate public posts to inspect yet.';
        }

        if (discoveryPlan.candidatePosts.length === 0) {
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

    const warnings = [...targetResolution.warnings, ...discoveryPlan.warnings, ...ownerExpansionWarnings, ...commentScanResult.warnings];
    const summary: RunSummary = {
        status,
        message: (() => {
            if (discoveryPlan.searchMode === 'degraded') {
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
                candidatePosts: discoveryPlan.candidatePosts.length,
                scannedPosts: commentScanResult.scannedPosts,
                visibleCommentsScanned: commentScanResult.visibleCommentsScanned,
                confirmedComments: commentScanResult.events.length,
                confirmedReplies: matchedReplies,
                ambiguousCandidates: commentScanResult.ambiguousCandidates.length,
            },
        },
        discovery: {
            searchMode: discoveryPlan.searchMode,
            searchUsername: discoveryPlan.searchUsername,
            counts: {
                ...discoveryPlan.discoveryCounts,
                expandedOwnerProfiles: discoveryPlan.discoveryCounts.expandedOwnerProfiles + ownerExpansionProfiles,
                expandedOwnerPosts: discoveryPlan.discoveryCounts.expandedOwnerPosts + ownerExpansionPosts,
            },
            warnings: [...discoveryPlan.warnings, ...ownerExpansionWarnings],
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
            candidateProfiles: discoveryPlan.candidateProfiles,
            candidatePosts: discoveryPlan.candidatePosts.length,
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
