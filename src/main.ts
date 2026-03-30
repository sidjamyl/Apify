import { setTimeout } from 'node:timers/promises';

import { Actor, log } from 'apify';

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
import { buildDiscoveryPlan, resolveTargetProfile } from './instagram-profile.js';
import { scanLikedContentAppearances } from './liked-content-scan.js';
import { scanMentionTaggedAppearances } from './mention-tagged-scan.js';
import type { CoverageLevel, RunStatus, RunSummary, ScanState } from './types.js';

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
            storeName: TARGET_HISTORY_STORE_NAME,
            stateKey: null,
            reusedPriorState: false,
            visibleEvents: 0,
            historicalTombstones: 0,
            historicalUnconfirmed: 0,
            newlyObservedEvents: 0,
            tombstonedThisRun: 0,
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

async function run(): Promise<void> {
    const input = parseInput(await Actor.getInput());
    log.info(`Starting best-effort public comment discovery for @${input.username}.`);

    const targetResolution = await resolveTargetProfile(input.username);

    if (targetResolution.status === 'unavailable') {
        const summary = buildNoScanSummary({
            status: 'partial_coverage',
            message: targetResolution.message,
            inputUsername: input.username,
            resolvedUsername: null,
            profileUrl: null,
            isAvailable: false,
            isPrivate: false,
            reason: 'The target lookup was blocked or temporarily unavailable on public Instagram surfaces.',
            warnings: targetResolution.warnings,
            partialFailures: 1,
        });

        await Actor.setValue('RUN_SUMMARY', summary);
        log.warning(summary.message);
        return;
    }

    if (targetResolution.status === 'not_found' || !targetResolution.resolvedTarget) {
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

    if (targetResolution.status === 'private') {
        const summary = buildNoScanSummary({
            status: 'target_private',
            message: targetResolution.message,
            inputUsername: input.username,
            resolvedUsername: targetResolution.resolvedTarget.username,
            profileUrl: targetResolution.resolvedTarget.profileUrl,
            isAvailable: true,
            isPrivate: true,
            reason: 'The resolved target is private and cannot be scanned through public surfaces.',
            warnings: targetResolution.warnings,
            partialFailures: 0,
        });

        await Actor.setValue('RUN_SUMMARY', summary);
        log.warning(summary.message);
        return;
    }

    const { resolvedTarget } = targetResolution;
    const discoveryPlan = await buildDiscoveryPlan(resolvedTarget);
    const commentScanResult = await scanCommentsOnCandidatePosts({
        candidatePosts: discoveryPlan.candidatePosts,
        resolvedUsername: resolvedTarget.username,
    });
    const likedContentScanResult = scanLikedContentAppearances({
        candidatePosts: discoveryPlan.candidatePosts,
        resolvedUsername: resolvedTarget.username,
    });
    const mentionTaggedScanResult = scanMentionTaggedAppearances({
        candidatePosts: discoveryPlan.candidatePosts,
        resolvedUsername: resolvedTarget.username,
    });

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
    const targetHistoryStore = await openTargetHistoryStore();
    const previousHistoryState = await loadTargetHistoryState(targetHistoryStore, resolvedTarget.id);
    const historyMergeResult = mergeHistoricalObservations({
        targetId: resolvedTarget.id,
        resolvedUsername: resolvedTarget.username,
        profileUrl: resolvedTarget.profileUrl,
        currentEvents,
        previousState: previousHistoryState,
        commentsCanTombstone: scanState === 'complete',
        mentionTaggedCanTombstone: mentionTaggedCoverage.scanState === 'complete',
        likedContentCanTombstone: false,
        now: new Date().toISOString(),
    });
    await saveTargetHistoryState(targetHistoryStore, historyMergeResult.nextState);

    if (historyMergeResult.outputEvents.length > 0) {
        await Actor.pushData(historyMergeResult.outputEvents);
    }

    const status: RunStatus = (() => {
        if (scanState === 'partial_failure') {
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

    const warnings = [...targetResolution.warnings, ...discoveryPlan.warnings, ...commentScanResult.warnings];
    const summary: RunSummary = {
        status,
        message: (() => {
            if (status === 'resolved_with_results') {
                return `Resolved @${resolvedTarget.username} and found ${currentEvents.length} current public activity events across comments, liked content, mentions, and tagged appearances.`;
            }

            if (status === 'resolved_no_results') {
                if (historyMergeResult.historySummary.historicalTombstones > 0 || historyMergeResult.historySummary.historicalUnconfirmed > 0) {
                    return `Resolved @${resolvedTarget.username}, found no current public activity events, and returned ${historyMergeResult.historySummary.historicalTombstones + historyMergeResult.historySummary.historicalUnconfirmed} historical observations from prior runs.`;
                }

                return `Resolved @${resolvedTarget.username}, but found no public comments, liked-content signals, mentions, or tagged appearances in the inspected discovery scope.`;
            }

            return `Resolved @${resolvedTarget.username}, but comment discovery completed with partial coverage.`;
        })(),
        resultState,
        target: {
            inputUsername: input.username,
            resolvedUsername: resolvedTarget.username,
            profileUrl: resolvedTarget.profileUrl,
            isAvailable: true,
            isPrivate: false,
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

    await Actor.setValue('RUN_SUMMARY', summary);
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
