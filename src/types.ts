export type RunStatus =
    | 'resolved_with_results'
    | 'resolved_no_results'
    | 'target_private'
    | 'target_not_found_or_renamed'
    | 'partial_coverage';

export type CoverageLevel = 'low' | 'medium' | 'high' | 'unknown';
export type ScanState = 'complete' | 'low_coverage' | 'partial_failure';

export type DiscoverySource = 'target_profile' | 'related_profile';
export type MatchConfidence = 'exact_username_visible';
export type CommentKind = 'top_level' | 'reply';
export type AppearanceType = 'comment' | 'mention' | 'tagged_appearance';

export interface ActorInput {
    username: string;
}

export interface InstagramPost {
    id: string;
    shortcode: string;
    url: string;
    ownerUsername: string;
    caption: string | null;
    mentionedUsernames: string[];
    taggedUsernames: string[];
    coauthorUsernames: string[];
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
    targetUsername: string;
    resolvedUsername: string;
    commentOwnerUsername: string;
    commentKind: CommentKind;
    replyDepth: number;
    parentCommentPermalink: string | null;
    commentText: string;
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

export type AppearanceEvent = CommentEvent | MentionEvent | TaggedAppearanceEvent;

export interface CoverageSummary {
    level: CoverageLevel;
    scanState: ScanState;
    reason: string;
}

export interface AmbiguousCommentCandidate {
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
    target: TargetSnapshot;
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
    counts: {
        candidateProfiles: number;
        candidatePosts: number;
        scannedPosts: number;
        visibleCommentsScanned: number;
        matchedComments: number;
        matchedReplies: number;
        mentionEvents: number;
        taggedAppearanceEvents: number;
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
