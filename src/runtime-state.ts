import type { KeyValueStore } from 'apify';
import { Actor } from 'apify';

import type {
    ActorInput,
    AmbiguousCommentCandidate,
    CommentEvent,
    CommentScanResult,
    DeepInvestigationJobKind,
    DeepInvestigationJobState,
    DeepInvestigationRuntimeInfo,
    DeepInvestigationRuntimeStatus,
    DeepInvestigationStopReason,
    DiscoveryCounts,
    HistoryIdentityMode,
    InstagramPost,
    OperatorResourcesSummary,
    ResolvedTarget,
    RunSummary,
    RuntimeJobCounts,
    SearchMode,
    TargetCandidateCacheState,
} from './types.js';

export const DEEP_INVESTIGATION_RUNTIME_STORE_NAME = 'deep-investigation-runtime';
const RUNTIME_STATE_KEY_PREFIX = 'RUNTIME_STATE__';
export const DEFAULT_RUNTIME_JOB_LEASE_MS = 30 * 60 * 1000;

export interface RuntimeJobLease {
    leaseId: string;
    leasedAt: string;
    leaseExpiresAt: string;
    heartbeatAt: string;
}

export interface RuntimeJobCheckpoint {
    checkpointedAt: string;
    note: string;
}

export interface TargetResolutionJobPayload {
    kind: 'target_resolution';
    inputUsername: string;
}

export interface DiscoveryCycleJobPayload {
    kind: 'discovery_cycle';
    cycleIndex: number;
}

export interface OperatorResourceBootstrapJobPayload {
    kind: 'operator_resource_bootstrap';
}

export interface GraphRootExpansionJobPayload {
    kind: 'graph_root_expansion';
    searchUsername: string;
}

export interface CommentScanBatchJobPayload {
    kind: 'comment_scan_batch';
    cycleIndex: number;
    searchUsername: string;
    candidateShortcodes: string[];
}

export interface FinalizeRunJobPayload {
    kind: 'finalize_run';
}

export type RuntimeJobPayload =
    | TargetResolutionJobPayload
    | OperatorResourceBootstrapJobPayload
    | GraphRootExpansionJobPayload
    | DiscoveryCycleJobPayload
    | CommentScanBatchJobPayload
    | FinalizeRunJobPayload;

export interface DeepInvestigationRuntimeJob {
    key: string;
    kind: DeepInvestigationJobKind;
    state: DeepInvestigationJobState;
    payload: RuntimeJobPayload;
    attempts: number;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    lastError: string | null;
    lastTransitionReason: string | null;
    lease: RuntimeJobLease | null;
    checkpoint: RuntimeJobCheckpoint | null;
}

export interface RuntimeTargetContext {
    targetResolutionStatus: 'pending' | 'resolved' | 'private' | 'unavailable' | 'not_found';
    targetResolutionMessage: string | null;
    targetResolutionWarnings: string[];
    resolvedTarget: ResolvedTarget | null;
    searchUsername: string;
    searchMode: SearchMode;
    targetProfileUrl: string | null;
    targetIsAvailable: boolean;
    targetIsPrivate: boolean;
    historyIdentityMode: Exclude<HistoryIdentityMode, 'none'> | null;
    historyIdentityValue: string | null;
    historicalCandidatePosts: InstagramPost[];
    historicalFruitfulOwners: string[];
    targetCandidateCache: TargetCandidateCacheState | null;
}

export interface RuntimeCommentScanAggregate extends CommentScanResult {
    events: CommentEvent[];
    ambiguousCandidates: AmbiguousCommentCandidate[];
}

export interface RuntimeProgressState {
    cyclesCompleted: number;
    stoppedBecause: DeepInvestigationStopReason | null;
    noProgressCycles: number;
    aggregatedCandidateProfiles: number;
    aggregatedDiscoveryCounts: DiscoveryCounts;
    aggregatedDiscoveryWarnings: string[];
    aggregatedCommentScanResult: RuntimeCommentScanAggregate;
    ownerExpansionWarnings: string[];
    ownerExpansionProfiles: number;
    ownerExpansionPosts: number;
    knownCandidatePosts: InstagramPost[];
    scannedShortcodes: string[];
}

export interface RuntimeOperatorResourcesState {
    summary: OperatorResourcesSummary;
}

export interface DeepInvestigationRuntimeState {
    version: 1;
    stateKey: string;
    input: ActorInput;
    status: DeepInvestigationRuntimeStatus;
    createdAt: string;
    updatedAt: string;
    lastCheckpointAt: string | null;
    reusedExistingState: boolean;
    resumedFromCheckpoint: boolean;
    staleRecoveredJobs: number;
    target: RuntimeTargetContext;
    operatorResources: RuntimeOperatorResourcesState;
    progress: RuntimeProgressState;
    jobs: DeepInvestigationRuntimeJob[];
    finalSummary: RunSummary | null;
}

function cloneValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
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

function emptyCommentScanAggregate(): RuntimeCommentScanAggregate {
    return {
        browserAvailable: true,
        scannedPosts: 0,
        visibleCommentsScanned: 0,
        structuredCommentsScanned: 0,
        partialFailures: 0,
        warnings: [],
        events: [],
        ambiguousCandidates: [],
    };
}

function emptyOperatorResourcesSummary(): OperatorResourcesSummary {
    return {
        readiness: 'not_configured',
        configuredAccounts: 0,
        readyAccounts: 0,
        reusedSessions: 0,
        bootstrappedSessions: 0,
        proxyConfigured: false,
        graphExpansion: {
            bioLinkedUsernames: 0,
            followersUsernames: 0,
            followingUsernames: 0,
            expandedProfiles: 0,
            expandedPosts: 0,
        },
        warnings: [],
    };
}

function createRuntimeJob(input: {
    key: string;
    kind: DeepInvestigationJobKind;
    payload: RuntimeJobPayload;
    now: string;
}): DeepInvestigationRuntimeJob {
    const { key, kind, payload, now } = input;
    return {
        key,
        kind,
        state: 'queued',
        payload,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        lastTransitionReason: 'initial_enqueue',
        lease: null,
        checkpoint: null,
    };
}

function buildLeaseExpiry(now: string, leaseMs: number): string {
    return new Date(Date.parse(now) + leaseMs).toISOString();
}

export function buildDeepInvestigationRuntimeStateKey(input: {
    username: string;
    runMode: ActorInput['runMode'];
}): string {
    const { username, runMode } = input;
    return `${RUNTIME_STATE_KEY_PREFIX}${username.toLowerCase()}__${runMode}`;
}

export function createInitialDeepInvestigationRuntimeState(input: ActorInput): DeepInvestigationRuntimeState {
    const now = new Date().toISOString();
    return {
        version: 1,
        stateKey: buildDeepInvestigationRuntimeStateKey({
            username: input.username,
            runMode: input.runMode,
        }),
        input: cloneValue(input),
        status: 'running',
        createdAt: now,
        updatedAt: now,
        lastCheckpointAt: now,
        reusedExistingState: false,
        resumedFromCheckpoint: false,
        staleRecoveredJobs: 0,
        target: {
            targetResolutionStatus: 'pending',
            targetResolutionMessage: null,
            targetResolutionWarnings: [],
            resolvedTarget: null,
            searchUsername: input.username,
            searchMode: 'canonical',
            targetProfileUrl: null,
            targetIsAvailable: false,
            targetIsPrivate: false,
            historyIdentityMode: null,
            historyIdentityValue: null,
            historicalCandidatePosts: [],
            historicalFruitfulOwners: [],
            targetCandidateCache: null,
        },
        operatorResources: {
            summary: {
                ...emptyOperatorResourcesSummary(),
                configuredAccounts: input.operatorAccounts.length,
                proxyConfigured: Boolean(input.proxyConfiguration),
            },
        },
        progress: {
            cyclesCompleted: 0,
            stoppedBecause: null,
            noProgressCycles: 0,
            aggregatedCandidateProfiles: 0,
            aggregatedDiscoveryCounts: emptyDiscoveryCounts(),
            aggregatedDiscoveryWarnings: [],
            aggregatedCommentScanResult: emptyCommentScanAggregate(),
            ownerExpansionWarnings: [],
            ownerExpansionProfiles: 0,
            ownerExpansionPosts: 0,
            knownCandidatePosts: [],
            scannedShortcodes: [],
        },
        jobs: [createRuntimeJob({
            key: 'target_resolution',
            kind: 'target_resolution',
            payload: {
                kind: 'target_resolution',
                inputUsername: input.username,
            },
            now,
        })],
        finalSummary: null,
    };
}

export function runtimeJobCounts(jobs: DeepInvestigationRuntimeJob[]): RuntimeJobCounts {
    const counts: RuntimeJobCounts = {
        queued: 0,
        leased: 0,
        running: 0,
        checkpointed: 0,
        succeeded: 0,
        failed: 0,
    };

    for (const job of jobs) {
        counts[job.state] += 1;
    }

    return counts;
}

function markCheckpoint(state: DeepInvestigationRuntimeState, now: string): void {
    Object.assign(state, {
        updatedAt: now,
        lastCheckpointAt: now,
    });
}

export function recoverInterruptedRuntimeJobs(input: {
    state: DeepInvestigationRuntimeState;
    now: string;
}): number {
    const { state, now } = input;
    let recoveredJobs = 0;

    for (const job of state.jobs) {
        if (job.state !== 'leased' && job.state !== 'running') continue;

        const leaseExpired = !job.lease || Date.parse(job.lease.leaseExpiresAt) <= Date.parse(now);
        if (!leaseExpired) continue;

        recoveredJobs += 1;
        job.state = 'checkpointed';
        job.updatedAt = now;
        job.lease = null;
        job.lastTransitionReason = 'lease_expired_recovered';
        job.checkpoint = {
            checkpointedAt: now,
            note: 'Recovered automatically after an interrupted or expired lease.',
        };
    }

    if (recoveredJobs > 0) {
        state.resumedFromCheckpoint = true;
        state.staleRecoveredJobs += recoveredJobs;
        markCheckpoint(state, now);
    }

    return recoveredJobs;
}

export function enqueueRuntimeJob(input: {
    state: DeepInvestigationRuntimeState;
    key: string;
    kind: DeepInvestigationJobKind;
    payload: RuntimeJobPayload;
    now: string;
}): DeepInvestigationRuntimeJob {
    const { state, key, kind, payload, now } = input;
    const existingJob = state.jobs.find((job) => job.key === key && job.state !== 'succeeded');
    if (existingJob) {
        return existingJob;
    }

    const nextJob = createRuntimeJob({ key, kind, payload, now });
    state.jobs.push(nextJob);
    markCheckpoint(state, now);
    return nextJob;
}

export function leaseNextRuntimeJob(input: {
    state: DeepInvestigationRuntimeState;
    now: string;
    leaseMs?: number;
}): DeepInvestigationRuntimeJob | null {
    const { state, now, leaseMs = DEFAULT_RUNTIME_JOB_LEASE_MS } = input;
    const nextJob = [...state.jobs]
        .filter((job) => job.state === 'checkpointed' || job.state === 'queued')
        .sort((left, right) => {
            const leftPriority = left.state === 'checkpointed' ? 0 : 1;
            const rightPriority = right.state === 'checkpointed' ? 0 : 1;
            if (leftPriority !== rightPriority) return leftPriority - rightPriority;
            return Date.parse(left.createdAt) - Date.parse(right.createdAt);
        })[0] ?? null;

    if (!nextJob) return null;

    nextJob.state = 'leased';
    nextJob.attempts += 1;
    nextJob.updatedAt = now;
    nextJob.lastTransitionReason = 'leased_for_execution';
    nextJob.lease = {
        leaseId: `${nextJob.key}:${nextJob.attempts}:${Date.parse(now)}`,
        leasedAt: now,
        leaseExpiresAt: buildLeaseExpiry(now, leaseMs),
        heartbeatAt: now,
    };
    nextJob.checkpoint = null;
    markCheckpoint(state, now);
    return nextJob;
}

export function markRuntimeJobRunning(input: {
    state: DeepInvestigationRuntimeState;
    jobKey: string;
    now: string;
    reason?: string;
}): void {
    const { state, jobKey, now, reason = 'job_started' } = input;
    const job = state.jobs.find((candidate) => candidate.key === jobKey);
    if (!job) throw new Error(`Runtime job ${jobKey} was not found.`);

    job.state = 'running';
    job.updatedAt = now;
    job.startedAt ??= now;
    job.lastTransitionReason = reason;
    if (job.lease) {
        job.lease.heartbeatAt = now;
    }
    markCheckpoint(state, now);
}

export function heartbeatRuntimeJob(input: {
    state: DeepInvestigationRuntimeState;
    jobKey: string;
    now: string;
    leaseMs?: number;
}): void {
    const { state, jobKey, now, leaseMs = DEFAULT_RUNTIME_JOB_LEASE_MS } = input;
    const job = state.jobs.find((candidate) => candidate.key === jobKey);
    if (!job || !job.lease) return;

    job.lease.heartbeatAt = now;
    job.lease.leaseExpiresAt = buildLeaseExpiry(now, leaseMs);
    job.updatedAt = now;
    job.lastTransitionReason = 'heartbeat';
    markCheckpoint(state, now);
}

export function checkpointRuntimeJob(input: {
    state: DeepInvestigationRuntimeState;
    jobKey: string;
    now: string;
    note: string;
    error?: string | null;
}): void {
    const { state, jobKey, now, note, error = null } = input;
    const job = state.jobs.find((candidate) => candidate.key === jobKey);
    if (!job) throw new Error(`Runtime job ${jobKey} was not found.`);

    job.state = 'checkpointed';
    job.updatedAt = now;
    job.lease = null;
    job.lastError = error;
    job.lastTransitionReason = 'checkpointed';
    job.checkpoint = {
        checkpointedAt: now,
        note,
    };
    markCheckpoint(state, now);
}

export function completeRuntimeJob(input: {
    state: DeepInvestigationRuntimeState;
    jobKey: string;
    now: string;
    reason?: string;
}): void {
    const { state, jobKey, now, reason = 'job_succeeded' } = input;
    const job = state.jobs.find((candidate) => candidate.key === jobKey);
    if (!job) throw new Error(`Runtime job ${jobKey} was not found.`);

    job.state = 'succeeded';
    job.updatedAt = now;
    job.finishedAt = now;
    job.lease = null;
    job.lastTransitionReason = reason;
    job.checkpoint = null;
    markCheckpoint(state, now);
}

export function failRuntimeJob(input: {
    state: DeepInvestigationRuntimeState;
    jobKey: string;
    now: string;
    error: string;
}): void {
    const { state, jobKey, now, error } = input;
    const job = state.jobs.find((candidate) => candidate.key === jobKey);
    if (!job) throw new Error(`Runtime job ${jobKey} was not found.`);

    job.state = 'failed';
    job.updatedAt = now;
    job.finishedAt = now;
    job.lease = null;
    job.lastError = error;
    job.lastTransitionReason = 'job_failed';
    markCheckpoint(state, now);
}

export function buildRuntimeInfo(input: {
    state: DeepInvestigationRuntimeState;
    activeJobKey?: string | null;
}): DeepInvestigationRuntimeInfo {
    const { state, activeJobKey = null } = input;
    return {
        storeName: DEEP_INVESTIGATION_RUNTIME_STORE_NAME,
        stateKey: state.stateKey,
        reusedExistingState: state.reusedExistingState,
        resumedFromCheckpoint: state.resumedFromCheckpoint,
        staleRecoveredJobs: state.staleRecoveredJobs,
        lastCheckpointAt: state.lastCheckpointAt,
        activeJobKey,
        jobCounts: runtimeJobCounts(state.jobs),
    };
}

export async function openDeepInvestigationRuntimeStore(): Promise<KeyValueStore> {
    return Actor.openKeyValueStore(DEEP_INVESTIGATION_RUNTIME_STORE_NAME);
}

export async function loadDeepInvestigationRuntimeState(input: {
    store: KeyValueStore;
    stateKey: string;
}): Promise<DeepInvestigationRuntimeState | null> {
    const { store, stateKey } = input;
    const state = await store.getValue<DeepInvestigationRuntimeState>(stateKey);
    return state ? cloneValue(state) : null;
}

export async function saveDeepInvestigationRuntimeState(input: {
    store: KeyValueStore;
    state: DeepInvestigationRuntimeState;
}): Promise<void> {
    const { store, state } = input;
    await store.setValue(state.stateKey, state);
}

export async function deleteDeepInvestigationRuntimeState(input: {
    store: KeyValueStore;
    stateKey: string;
}): Promise<void> {
    const { store, stateKey } = input;
    await store.setValue(stateKey, null);
}
