export type RunStatus =
    | 'resolved_with_results'
    | 'resolved_no_results'
    | 'target_not_found_or_renamed'
    | 'partial_coverage';

export type CoverageLevel = 'low' | 'medium' | 'high' | 'unknown';
export type ScanState = 'complete' | 'low_coverage' | 'partial_failure';
export type ObservationState = 'visible' | 'historical_tombstone' | 'historical_unconfirmed';
export type SearchMode = 'canonical' | 'degraded';
export type HistoryIdentityMode = 'none' | 'canonical_target' | 'input_username';
export type RunMode = 'backfill' | 'freshness';
export type DeepInvestigationRuntimeStatus = 'running' | 'completed' | 'failed';
export type DeepInvestigationStopReason = 'completed_all_cycles' | 'saturated' | 'no_candidates';
export type DeepInvestigationJobKind = 'target_resolution' | 'operator_resource_bootstrap' | 'graph_root_expansion' | 'discovery_cycle' | 'comment_scan_batch' | 'finalize_run';
export type DeepInvestigationJobState = 'queued' | 'leased' | 'running' | 'checkpointed' | 'succeeded' | 'failed';
export type VisibilityClass = 'public' | 'session_visible' | 'historical_only' | 'ambiguous';
export type ResultBucket = 'confirmed_comments' | 'supporting_activity' | 'historical_only' | 'ambiguous_candidates';

export type DiscoverySource = 'target_profile' | 'related_profile' | 'external_search' | 'expanded_owner_graph';
export type MatchConfidence = 'exact_username_visible';
export type CommentKind = 'top_level' | 'reply';
export type AppearanceType = 'comment' | 'mention' | 'tagged_appearance' | 'liked_content';

export interface ProxyConfigurationInput {
    useApifyProxy?: boolean;
    apifyProxyGroups?: string[];
    apifyProxyCountry?: string;
    proxyUrls?: string[];
}

export interface OperatorAccountInput {
    username: string;
    password?: string;
    sessionKey?: string;
    sessionId?: string;
}

export interface GraphExpansionInput {
    maxFollowersToInspect: number;
    maxFollowingToInspect: number;
    maxExpandedProfiles: number;
}

export interface ActorInput {
    username: string;
    runMode: RunMode;
    maxDiscoveryCycles: number;
    operatorAccounts: OperatorAccountInput[];
    proxyConfiguration: ProxyConfigurationInput | null;
    graphExpansion: GraphExpansionInput;
}

export interface InstagramPost {
    id: string;
    mediaId: string | null;
    shortcode: string;
    url: string;
    ownerUsername: string;
    caption: string | null;
    mentionedUsernames: string[];
    taggedUsernames: string[];
    coauthorUsernames: string[];
    discoverableLikerUsernames: string[];
    takenAtTimestamp: number | null;
    discoverySource: DiscoverySource;
    discoveredViaUsername: string | null;
}

export interface ResolvedTarget {
    id: string;
    username: string;
    fullName: string | null;
    isPrivate: boolean;
    biography: string | null;
    profileUrl: string;
    postCount: number;
    posts: InstagramPost[];
}

export interface CommentEvent {
    type: 'comment';
    visibilityClass: VisibilityClass;
    resultBucket: ResultBucket;
    targetUsername: string;
    resolvedUsername: string;
    commentOwnerUsername: string;
    commentKind: CommentKind;
    replyDepth: number;
    parentCommentPermalink: string | null;
    commentText: string | null;
    createdAt: string | null;
    createdAtLabel: string | null;
    commentPermalink: string;
    postUrl: string;
    postShortcode: string;
    postOwnerUsername: string;
    sourceSurface: 'instagram_post_comment_thread';
    sourceUrl: string;
    discoverySource: DiscoverySource;
    discoveredViaUsername: string | null;
    matchConfidence: MatchConfidence;
    matchReason: string;
}

export interface MentionEvent {
    type: 'mention';
    visibilityClass: VisibilityClass;
    resultBucket: ResultBucket;
    targetUsername: string;
    resolvedUsername: string;
    appearanceText: string | null;
    createdAt: string | null;
    postUrl: string;
    postShortcode: string;
    postOwnerUsername: string;
    sourceSurface: 'instagram_post_caption_mention';
    sourceUrl: string;
    discoverySource: DiscoverySource;
    discoveredViaUsername: string | null;
    matchConfidence: MatchConfidence;
    matchReason: string;
}

export interface TaggedAppearanceEvent {
    type: 'tagged_appearance';
    visibilityClass: VisibilityClass;
    resultBucket: ResultBucket;
    targetUsername: string;
    resolvedUsername: string;
    appearanceText: string | null;
    createdAt: string | null;
    postUrl: string;
    postShortcode: string;
    postOwnerUsername: string;
    sourceSurface: 'instagram_post_tagged_user';
    sourceUrl: string;
    discoverySource: DiscoverySource;
    discoveredViaUsername: string | null;
    matchConfidence: MatchConfidence;
    matchReason: string;
}

export interface LikedContentEvent {
    type: 'liked_content';
    visibilityClass: VisibilityClass;
    resultBucket: ResultBucket;
    targetUsername: string;
    resolvedUsername: string;
    appearanceText: string | null;
    createdAt: string | null;
    postUrl: string;
    postShortcode: string;
    postOwnerUsername: string;
    sourceSurface: 'instagram_post_public_like_signal';
    sourceUrl: string;
    discoverySource: DiscoverySource;
    discoveredViaUsername: string | null;
    matchConfidence: MatchConfidence;
    matchReason: string;
}

export type AppearanceEvent = CommentEvent | MentionEvent | TaggedAppearanceEvent | LikedContentEvent;

export type HistoricalAppearanceEvent = AppearanceEvent & {
    eventKey: string;
    observationState: ObservationState;
    firstSeenAt: string;
    lastSeenAt: string;
    disappearedAt: string | null;
};

export interface CoverageSummary {
    level: CoverageLevel;
    scanState: ScanState;
    reason: string;
}

export interface DiscoveryCounts {
    targetProfilePosts: number;
    relatedProfilePosts: number;
    cachedCandidatePosts: number;
    cachedFruitfulOwnerProfiles: number;
    frontierProfilesQueued: number;
    externalSearchQueries: number;
    externalSearchHits: number;
    externalSearchCandidatePosts: number;
    expandedOwnerProfiles: number;
    expandedOwnerPosts: number;
}

export interface RuntimeJobCounts {
    queued: number;
    leased: number;
    running: number;
    checkpointed: number;
    succeeded: number;
    failed: number;
}

export interface DeepInvestigationRuntimeInfo {
    storeName: string;
    stateKey: string | null;
    reusedExistingState: boolean;
    resumedFromCheckpoint: boolean;
    staleRecoveredJobs: number;
    lastCheckpointAt: string | null;
    activeJobKey: string | null;
    jobCounts: RuntimeJobCounts;
}

export interface OperatorResourcesSummary {
    readiness: 'not_configured' | 'proxy_missing' | 'not_ready' | 'partial' | 'ready';
    configuredAccounts: number;
    readyAccounts: number;
    providedSessions: number;
    reusedSessions: number;
    bootstrappedSessions: number;
    proxyConfigured: boolean;
    graphExpansion: {
        bioLinkedUsernames: number;
        followersUsernames: number;
        followingUsernames: number;
        expandedProfiles: number;
        expandedPosts: number;
    };
    warnings: string[];
}

export interface ResultArtifactsSummary {
    resultBucketsRecordKey: string;
    ambiguousActivityRecordKey: string | null;
    diagnosticTraceRecordKey: string;
}

export interface OperatorAccountDiagnostic {
    username: string;
    sessionKey: string;
    hadPersistedSession: boolean;
    proxyUrlGenerated: boolean;
    sessionSource: 'provided' | 'reused' | 'bootstrapped' | null;
    outcome: 'provided_session' | 'reused_session' | 'bootstrapped_session' | 'bootstrap_failed' | 'missing_credentials' | 'proxy_unavailable' | 'proxy_configuration_unavailable';
    warning: string | null;
}

export interface TargetResolutionDiagnostic {
    attemptedAt: string;
    inputUsername: string;
    status: 'pending' | 'resolved' | 'private' | 'unavailable' | 'not_found';
    resolvedUsername: string | null;
    searchMode: SearchMode;
    isPrivate: boolean;
    cachedCandidatePosts: number;
    historicalCandidatePosts: number;
    warningSample: string[];
}

export interface GraphRootExpansionDiagnostic {
    attemptedAt: string;
    operatorUsername: string | null;
    bioLinkedUsernames: string[];
    followersUsernames: string[];
    followingUsernames: string[];
    expandedUsernames: string[];
    expandedProfiles: number;
    expandedPosts: number;
    warnings: string[];
}

export interface DiscoveryCycleDiagnostic {
    cycleIndex: number;
    searchUsername: string;
    searchMode: SearchMode;
    candidateProfiles: number;
    candidatePosts: number;
    selectedCandidatePosts: number;
    selectedPostSamples: {
        shortcode: string;
        ownerUsername: string;
        discoverySource: DiscoverySource;
    }[];
    cachedCandidatePosts: number;
    cachedFruitfulOwnerProfiles: number;
    externalSearchQueries: number;
    externalSearchHits: number;
    externalSearchCandidatePosts: number;
    warnings: string[];
}

export interface CommentScanBatchDiagnostic {
    cycleIndex: number;
    candidateShortcodes: string[];
    candidateOwners: string[];
    scannedPosts: number;
    structuredCommentsScanned: number;
    visibleCommentsScanned: number;
    confirmedComments: number;
    ambiguousCandidates: number;
    partialFailures: number;
    expandedOwnerProfiles: number;
    expandedOwnerPosts: number;
    warnings: string[];
}

export interface FinalizationDiagnostic {
    generatedAt: string;
    finalCandidatePosts: number;
    confirmedComments: number;
    confirmedReplies: number;
    supportingEvents: number;
    ambiguousCommentCandidates: number;
    ambiguousLikedContentCandidates: number;
    partialFailures: number;
    stoppedBecause: DeepInvestigationStopReason | null;
    coverageLevel: CoverageLevel;
    scanState: ScanState;
    warningCount: number;
}

export interface DiagnosticTrace {
    generatedAt: string;
    input: {
        username: string;
        runMode: RunMode;
        maxDiscoveryCycles: number;
        operatorAccountCount: number;
        proxyConfigured: boolean;
        graphExpansion: GraphExpansionInput;
    };
    runtime: DeepInvestigationRuntimeInfo;
    targetResolution: TargetResolutionDiagnostic | null;
    operatorAccounts: OperatorAccountDiagnostic[];
    graphRootExpansion: GraphRootExpansionDiagnostic | null;
    discoveryCycles: DiscoveryCycleDiagnostic[];
    commentScanBatches: CommentScanBatchDiagnostic[];
    finalization: FinalizationDiagnostic | null;
}

export interface AmbiguousCommentCandidate {
    type: 'comment';
    visibilityClass: 'ambiguous';
    resultBucket: 'ambiguous_candidates';
    commentOwnerUsername: string;
    commentKind: CommentKind;
    replyDepth: number;
    parentCommentPermalink: string | null;
    commentTextPreview: string;
    createdAt: string | null;
    createdAtLabel: string | null;
    commentPermalink: string;
    postUrl: string;
    postShortcode: string;
    postOwnerUsername: string;
    discoverySource: DiscoverySource;
    discoveredViaUsername: string | null;
    ambiguityReason: string;
}

export interface AmbiguousLikedContentCandidate {
    type: 'liked_content';
    visibilityClass: 'ambiguous';
    resultBucket: 'ambiguous_candidates';
    likerUsername: string;
    postUrl: string;
    postShortcode: string;
    postOwnerUsername: string;
    discoverySource: DiscoverySource;
    discoveredViaUsername: string | null;
    ambiguityReason: string;
}

export interface ConfidenceSummary {
    level: 'high' | 'medium' | 'low' | 'unknown';
    reason: string;
    exactMatches: number;
    ambiguousCandidates: number;
    ambiguousSamples: AmbiguousCommentCandidate[];
}

export interface TargetSnapshot {
    inputUsername: string;
    resolvedUsername: string | null;
    profileUrl: string | null;
    isAvailable: boolean;
    isPrivate: boolean;
}

export interface RunSummary {
    status: RunStatus;
    message: string;
    resultState: 'results_found' | 'nothing_found';
    operation: {
        runMode: RunMode;
        maxDiscoveryCycles: number;
        cyclesCompleted: number;
        stoppedBecause: DeepInvestigationStopReason;
        runtime: DeepInvestigationRuntimeInfo;
    };
    target: TargetSnapshot;
    comments: {
        resultState: 'comments_found' | 'no_comments_found';
        ambiguousRecordKey: string | null;
        counts: {
            candidatePosts: number;
            scannedPosts: number;
            visibleCommentsScanned: number;
            structuredCommentsScanned: number;
            confirmedComments: number;
            confirmedReplies: number;
            ambiguousCandidates: number;
        };
    };
    discovery: {
        searchMode: SearchMode;
        searchUsername: string;
        counts: DiscoveryCounts;
        warnings: string[];
    };
    operatorResources: OperatorResourcesSummary;
    artifacts: ResultArtifactsSummary;
    coverage: CoverageSummary;
    confidence: ConfidenceSummary;
    mentionTagged: {
        coverage: CoverageSummary;
        counts: {
            scannedPosts: number;
            mentionEvents: number;
            taggedAppearanceEvents: number;
            partialFailures: number;
            warnings: number;
        };
        warnings: string[];
    };
    likedContent: {
        coverage: CoverageSummary;
        confidence: {
            level: 'high' | 'medium' | 'low' | 'unknown';
            reason: string;
            exactMatches: number;
            ambiguousCandidates: number;
            ambiguousSamples: AmbiguousLikedContentCandidate[];
        };
        counts: {
            scannedPosts: number;
            discoverableSignals: number;
            likedContentEvents: number;
            ambiguousCandidates: number;
            partialFailures: number;
            warnings: number;
        };
        warnings: string[];
    };
    history: {
        storeName: string;
        stateKey: string | null;
        identityMode: HistoryIdentityMode;
        identityValue: string | null;
        reusedPriorState: boolean;
        visibleEvents: number;
        historicalTombstones: number;
        historicalUnconfirmed: number;
        newlyObservedEvents: number;
        tombstonedThisRun: number;
    };
    counts: {
        candidateProfiles: number;
        candidatePosts: number;
        scannedPosts: number;
        visibleCommentsScanned: number;
        matchedComments: number;
        matchedReplies: number;
        mentionEvents: number;
        taggedAppearanceEvents: number;
        likedContentEvents: number;
        likedContentAmbiguousCandidates: number;
        ambiguousCandidates: number;
        partialFailures: number;
        warnings: number;
    };
    warnings: string[];
}

export interface ScrapedVisibleComment {
    ownerUsername: string;
    commentKind: CommentKind;
    replyDepth: number;
    parentCommentPermalink: string | null;
    commentText: string;
    createdAt: string | null;
    createdAtLabel: string | null;
    commentPermalink: string;
}

export interface CommentScanResult {
    browserAvailable: boolean;
    scannedPosts: number;
    visibleCommentsScanned: number;
    structuredCommentsScanned: number;
    partialFailures: number;
    warnings: string[];
    events: CommentEvent[];
    ambiguousCandidates: AmbiguousCommentCandidate[];
}

export interface MentionTaggedScanResult {
    scannedPosts: number;
    partialFailures: number;
    warnings: string[];
    events: (MentionEvent | TaggedAppearanceEvent)[];
}

export interface LikedContentScanResult {
    scannedPosts: number;
    discoverableSignals: number;
    partialFailures: number;
    warnings: string[];
    events: LikedContentEvent[];
    ambiguousCandidates: AmbiguousLikedContentCandidate[];
}

export interface StoredHistoricalEvent {
    eventKey: string;
    observationState: ObservationState;
    firstSeenAt: string;
    lastSeenAt: string;
    disappearedAt: string | null;
    payload: AppearanceEvent;
}

export interface TargetHistoryState {
    version: 1;
    targetId: string;
    identityMode: Exclude<HistoryIdentityMode, 'none'>;
    resolvedUsername: string;
    profileUrl: string;
    updatedAt: string;
    events: StoredHistoricalEvent[];
}

export interface HistoryMergeResult {
    outputEvents: HistoricalAppearanceEvent[];
    nextState: TargetHistoryState;
    historySummary: RunSummary['history'];
    warnings: string[];
}

export interface TargetCandidateCacheState {
    version: 1;
    targetUsername: string;
    updatedAt: string;
    candidateShortcodes: string[];
    fruitfulOwnerUsernames: string[];
    frontierUsernames: string[];
    ownerStats: {
        username: string;
        successfulCommentCount: number;
        successfulRunCount: number;
        expandedPostCount: number;
        lastSuccessfulAt: string | null;
    }[];
}
