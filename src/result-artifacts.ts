import { dedupeByKey } from './comment-utils.js';
import type {
    AmbiguousCommentCandidate,
    AmbiguousLikedContentCandidate,
    AppearanceEvent,
    HistoricalAppearanceEvent,
    ObservationState,
    ResultBucket,
    VisibilityClass,
} from './types.js';

export const RESULT_BUCKETS_RECORD_KEY = 'RESULT_BUCKETS';
export const AMBIGUOUS_ACTIVITY_RECORD_KEY = 'AMBIGUOUS_ACTIVITY_CANDIDATES';

export interface AmbiguousActivityRecord {
    generatedAt: string;
    counts: {
        comments: number;
        likedContent: number;
        total: number;
    };
    comments: AmbiguousCommentCandidate[];
    likedContent: AmbiguousLikedContentCandidate[];
}

export interface ResultBucketsRecord {
    generatedAt: string;
    readingOrder: ResultBucket[];
    visibilityClasses: Record<VisibilityClass, string>;
    counts: {
        totalActivityEvents: number;
        byVisibilityClass: Record<Exclude<VisibilityClass, 'ambiguous'>, number> & { ambiguous: number };
        byResultBucket: Record<ResultBucket, number>;
        byEventType: Record<AppearanceEvent['type'], number>;
    };
}

export function classifyVisibilityClass(input: {
    observationState: ObservationState;
    visibilityClass?: VisibilityClass;
}): VisibilityClass {
    if (input.observationState !== 'visible') {
        return 'historical_only';
    }

    return input.visibilityClass ?? 'public';
}

export function classifyResultBucket(input: {
    eventType: AppearanceEvent['type'];
    observationState: ObservationState;
}): ResultBucket {
    if (input.observationState !== 'visible') {
        return 'historical_only';
    }

    return input.eventType === 'comment' ? 'confirmed_comments' : 'supporting_activity';
}

export function buildAppearanceEventPresentationFields<T extends AppearanceEvent>(event: T): T {
    return {
        ...event,
        visibilityClass: event.visibilityClass ?? 'public',
        resultBucket: event.resultBucket ?? (event.type === 'comment' ? 'confirmed_comments' : 'supporting_activity'),
    };
}

export function buildHistoricalAppearancePresentation(event: HistoricalAppearanceEvent): HistoricalAppearanceEvent {
    return {
        ...event,
        visibilityClass: classifyVisibilityClass({
            observationState: event.observationState,
            visibilityClass: event.visibilityClass,
        }),
        resultBucket: classifyResultBucket({
            eventType: event.type,
            observationState: event.observationState,
        }),
    };
}

export function buildAmbiguousActivityRecord(input: {
    generatedAt: string;
    commentCandidates: AmbiguousCommentCandidate[];
    likedContentCandidates: AmbiguousLikedContentCandidate[];
}): AmbiguousActivityRecord {
    const { generatedAt, commentCandidates, likedContentCandidates } = input;
    const comments = dedupeByKey(commentCandidates, (candidate) => candidate.commentPermalink);
    const likedContent = dedupeByKey(likedContentCandidates, (candidate) => `${candidate.postShortcode}:${candidate.likerUsername}`);
    return {
        generatedAt,
        counts: {
            comments: comments.length,
            likedContent: likedContent.length,
            total: comments.length + likedContent.length,
        },
        comments,
        likedContent,
    };
}

export function buildResultBucketsRecord(input: {
    generatedAt: string;
    events: HistoricalAppearanceEvent[];
    ambiguousRecord: AmbiguousActivityRecord | null;
}): ResultBucketsRecord {
    const { generatedAt, ambiguousRecord } = input;
    const events = input.events.map(buildHistoricalAppearancePresentation);

    const byVisibilityClass = {
        public: 0,
        session_visible: 0,
        historical_only: 0,
        ambiguous: ambiguousRecord?.counts.total ?? 0,
    } satisfies Record<VisibilityClass, number>;

    const byResultBucket = {
        confirmed_comments: 0,
        supporting_activity: 0,
        historical_only: 0,
        ambiguous_candidates: ambiguousRecord?.counts.total ?? 0,
    } satisfies Record<ResultBucket, number>;

    const byEventType = {
        comment: 0,
        mention: 0,
        tagged_appearance: 0,
        liked_content: 0,
    } satisfies Record<AppearanceEvent['type'], number>;

    for (const event of events) {
        byVisibilityClass[event.visibilityClass] += 1;
        byResultBucket[event.resultBucket] += 1;
        byEventType[event.type] += 1;
    }

    return {
        generatedAt,
        readingOrder: ['confirmed_comments', 'ambiguous_candidates', 'supporting_activity', 'historical_only'],
        visibilityClasses: {
            public: 'Visible on public surfaces scanned by the Actor.',
            session_visible: 'Visible only through a legitimate operator-backed session.',
            historical_only: 'Observed in earlier runs but not confirmed as currently visible in this run.',
            ambiguous: 'Kept separate because the Actor saw a near-match instead of a confirmed identity match.',
        },
        counts: {
            totalActivityEvents: events.length,
            byVisibilityClass,
            byResultBucket,
            byEventType,
        },
    };
}
