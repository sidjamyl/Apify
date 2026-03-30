export type RunStatus =
    | 'resolved_with_results'
    | 'resolved_no_results'
    | 'target_private'
    | 'target_not_found_or_renamed'
    | 'partial_coverage';

export type CoverageLevel = 'low' | 'medium' | 'high' | 'unknown';

export type DiscoverySource = 'target_profile' | 'related_profile';

export interface ActorInput {
    username: string;
}

export interface InstagramPost {
    id: string;
    shortcode: string;
    url: string;
    ownerUsername: string;
    caption: string | null;
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
    matchConfidence: 'exact_username_visible';
    matchReason: string;
}

export interface CoverageSummary {
    level: CoverageLevel;
    reason: string;
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
    target: TargetSnapshot;
    coverage: CoverageSummary;
    counts: {
        candidateProfiles: number;
        candidatePosts: number;
        scannedPosts: number;
        visibleCommentsScanned: number;
        matchedComments: number;
        partialFailures: number;
        warnings: number;
    };
    warnings: string[];
}

export interface ScrapedVisibleComment {
    ownerUsername: string;
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
}
