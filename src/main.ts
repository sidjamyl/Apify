import { setTimeout } from 'node:timers/promises';

import { Actor, log } from 'apify';

import { scanCommentsOnCandidatePosts } from './comment-scraper.js';
import { computeCoverageLevel } from './comment-utils.js';
import { parseInput } from './input.js';
import { buildDiscoveryPlan, resolveTargetProfile } from './instagram-profile.js';
import type { RunStatus,RunSummary } from './types.js';

Actor.on('aborting', async () => {
    await setTimeout(1_000);
    await Actor.exit();
});

await Actor.init();

async function run(): Promise<void> {
    const input = parseInput(await Actor.getInput());
    log.info(`Starting best-effort public comment discovery for @${input.username}.`);

    const targetResolution = await resolveTargetProfile(input.username);

    if (targetResolution.status === 'unavailable') {
        const summary: RunSummary = {
            status: 'partial_coverage',
            message: targetResolution.message,
            target: {
                inputUsername: input.username,
                resolvedUsername: null,
                profileUrl: null,
                isAvailable: false,
                isPrivate: false,
            },
            coverage: {
                level: 'unknown',
                reason: 'The target lookup was blocked or temporarily unavailable on public Instagram surfaces.',
            },
            counts: {
                candidateProfiles: 0,
                candidatePosts: 0,
                scannedPosts: 0,
                visibleCommentsScanned: 0,
                matchedComments: 0,
                partialFailures: 1,
                warnings: targetResolution.warnings.length,
            },
            warnings: targetResolution.warnings,
        };

        await Actor.setValue('RUN_SUMMARY', summary);
        log.warning(summary.message);
        return;
    }

    if (targetResolution.status === 'not_found' || !targetResolution.resolvedTarget) {
        const summary: RunSummary = {
            status: 'target_not_found_or_renamed',
            message: targetResolution.message,
            target: {
                inputUsername: input.username,
                resolvedUsername: null,
                profileUrl: null,
                isAvailable: false,
                isPrivate: false,
            },
            coverage: {
                level: 'unknown',
                reason: 'Target could not be resolved on public Instagram surfaces.',
            },
            counts: {
                candidateProfiles: 0,
                candidatePosts: 0,
                scannedPosts: 0,
                visibleCommentsScanned: 0,
                matchedComments: 0,
                partialFailures: 0,
                warnings: targetResolution.warnings.length,
            },
            warnings: targetResolution.warnings,
        };

        await Actor.setValue('RUN_SUMMARY', summary);
        log.warning(summary.message);
        return;
    }

    if (targetResolution.status === 'private') {
        const summary: RunSummary = {
            status: 'target_private',
            message: targetResolution.message,
            target: {
                inputUsername: input.username,
                resolvedUsername: targetResolution.resolvedTarget.username,
                profileUrl: targetResolution.resolvedTarget.profileUrl,
                isAvailable: true,
                isPrivate: true,
            },
            coverage: {
                level: 'unknown',
                reason: 'The resolved target is private and cannot be scanned through public surfaces.',
            },
            counts: {
                candidateProfiles: 1,
                candidatePosts: 0,
                scannedPosts: 0,
                visibleCommentsScanned: 0,
                matchedComments: 0,
                partialFailures: 0,
                warnings: targetResolution.warnings.length,
            },
            warnings: targetResolution.warnings,
        };

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

    if (commentScanResult.events.length > 0) {
        await Actor.pushData(commentScanResult.events);
    }

    const coverageLevel = computeCoverageLevel({
        browserAvailable: commentScanResult.browserAvailable,
        scannedPosts: commentScanResult.scannedPosts,
        candidatePosts: discoveryPlan.candidatePosts.length,
        partialFailures: commentScanResult.partialFailures,
    });

    const status: RunStatus = (() => {
        if (!commentScanResult.browserAvailable || commentScanResult.partialFailures > 0) {
            return 'partial_coverage';
        }

        if (commentScanResult.events.length > 0) {
            return 'resolved_with_results';
        }

        return 'resolved_no_results';
    })();

    const coverageReason = (() => {
        if (!commentScanResult.browserAvailable) {
            return 'Browser-based public comment extraction could not start in the current runtime.';
        }

        if (coverageLevel === 'high') {
            return 'The Actor scanned a larger recent post sample without runtime failures, but coverage remains best-effort.';
        }

        if (coverageLevel === 'medium') {
            return 'The Actor scanned multiple recent public posts, but Instagram only exposed a limited visible comment window.';
        }

        if (coverageLevel === 'low') {
            return 'The Actor scanned only a narrow or partially degraded visible-comment window.';
        }

        return 'Coverage could not be estimated reliably.';
    })();

    const warnings = [...targetResolution.warnings, ...discoveryPlan.warnings, ...commentScanResult.warnings];
    const summary: RunSummary = {
        status,
        message: (() => {
            if (status === 'resolved_with_results') {
                return `Resolved @${resolvedTarget.username} and found ${commentScanResult.events.length} matched public comments.`;
            }

            if (status === 'resolved_no_results') {
                return `Resolved @${resolvedTarget.username}, but found no matched public comments in the inspected discovery scope.`;
            }

            return `Resolved @${resolvedTarget.username}, but comment discovery completed with partial coverage.`;
        })(),
        target: {
            inputUsername: input.username,
            resolvedUsername: resolvedTarget.username,
            profileUrl: resolvedTarget.profileUrl,
            isAvailable: true,
            isPrivate: false,
        },
        coverage: {
            level: coverageLevel,
            reason: coverageReason,
        },
        counts: {
            candidateProfiles: discoveryPlan.candidateProfiles,
            candidatePosts: discoveryPlan.candidatePosts.length,
            scannedPosts: commentScanResult.scannedPosts,
            visibleCommentsScanned: commentScanResult.visibleCommentsScanned,
            matchedComments: commentScanResult.events.length,
            partialFailures: commentScanResult.partialFailures,
            warnings: warnings.length,
        },
        warnings,
    };

    await Actor.setValue('RUN_SUMMARY', summary);
    log.info(summary.message);
    if (warnings.length > 0) {
        log.warning(`Run completed with ${warnings.length} warning(s).`);
    }
}

try {
    await run();
} finally {
    await Actor.exit();
}
