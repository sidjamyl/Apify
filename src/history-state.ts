import type { KeyValueStore } from 'apify';
import { Actor } from 'apify';

import type {
    AppearanceEvent,
    HistoricalAppearanceEvent,
    HistoryMergeResult,
    StoredHistoricalEvent,
    TargetHistoryState,
} from './types.js';

export const TARGET_HISTORY_STORE_NAME = 'TARGET_HISTORY';
const TARGET_STATE_KEY_PREFIX = 'TARGET_STATE__';

function cloneEvent<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function buildEventKey(event: AppearanceEvent): string {
    switch (event.type) {
        case 'comment':
            return `comment:${event.commentPermalink}`;
        case 'mention':
            return `mention:${event.postShortcode}`;
        case 'tagged_appearance':
            return `tagged_appearance:${event.postShortcode}`;
        case 'liked_content':
            return `liked_content:${event.postShortcode}`;
        default:
            throw new Error('Unsupported event type for history tracking.');
    }
}

function shouldAllowTombstone(input: {
    event: AppearanceEvent;
    commentsCanTombstone: boolean;
    mentionTaggedCanTombstone: boolean;
    likedContentCanTombstone: boolean;
}): boolean {
    const {
        event,
        commentsCanTombstone,
        mentionTaggedCanTombstone,
        likedContentCanTombstone,
    } = input;

    if (event.type === 'comment') return commentsCanTombstone;
    if (event.type === 'mention' || event.type === 'tagged_appearance') return mentionTaggedCanTombstone;
    if (event.type === 'liked_content') return likedContentCanTombstone;
    return false;
}

function toHistoricalOutputEvent(storedEvent: StoredHistoricalEvent): HistoricalAppearanceEvent {
    const payload = cloneEvent(storedEvent.payload);

    if (storedEvent.observationState !== 'visible') {
        if ('commentText' in payload) {
            payload.commentText = null;
        }

        if ('appearanceText' in payload) {
            payload.appearanceText = null;
        }
    }

    return {
        ...payload,
        eventKey: storedEvent.eventKey,
        observationState: storedEvent.observationState,
        firstSeenAt: storedEvent.firstSeenAt,
        lastSeenAt: storedEvent.lastSeenAt,
        disappearedAt: storedEvent.disappearedAt,
    };
}

export function mergeHistoricalObservations(input: {
    targetId: string;
    resolvedUsername: string;
    profileUrl: string;
    currentEvents: AppearanceEvent[];
    previousState: TargetHistoryState | null;
    commentsCanTombstone: boolean;
    mentionTaggedCanTombstone: boolean;
    likedContentCanTombstone: boolean;
    now: string;
}): HistoryMergeResult {
    const {
        targetId,
        resolvedUsername,
        profileUrl,
        currentEvents,
        previousState,
        commentsCanTombstone,
        mentionTaggedCanTombstone,
        likedContentCanTombstone,
        now,
    } = input;

    const previousByKey = new Map<string, StoredHistoricalEvent>(
        (previousState?.events ?? []).map((event) => [event.eventKey, event]),
    );
    const currentByKey = new Map<string, AppearanceEvent>(currentEvents.map((event) => [buildEventKey(event), event]));
    const mergedEvents: StoredHistoricalEvent[] = [];
    const warnings: string[] = [];
    let newlyObservedEvents = 0;
    let tombstonedThisRun = 0;

    for (const [eventKey, currentEvent] of currentByKey.entries()) {
        const previousEvent = previousByKey.get(eventKey);
        if (!previousEvent) {
            newlyObservedEvents += 1;
        }

        mergedEvents.push({
            eventKey,
            observationState: 'visible',
            firstSeenAt: previousEvent?.firstSeenAt ?? now,
            lastSeenAt: now,
            disappearedAt: null,
            payload: cloneEvent(currentEvent),
        });
    }

    for (const [eventKey, previousEvent] of previousByKey.entries()) {
        if (currentByKey.has(eventKey)) continue;

        if (previousEvent.observationState === 'historical_tombstone') {
            mergedEvents.push(previousEvent);
            continue;
        }

        const canTombstone = shouldAllowTombstone({
            event: previousEvent.payload,
            commentsCanTombstone,
            mentionTaggedCanTombstone,
            likedContentCanTombstone,
        });

        if (canTombstone) {
            tombstonedThisRun += 1;
            mergedEvents.push({
                ...previousEvent,
                observationState: 'historical_tombstone',
                disappearedAt: previousEvent.disappearedAt ?? now,
            });
            continue;
        }

        mergedEvents.push({
            ...previousEvent,
            observationState: 'historical_unconfirmed',
        });
    }

    if (!commentsCanTombstone && mergedEvents.some((event) => event.payload.type === 'comment' && event.observationState === 'historical_unconfirmed')) {
        warnings.push('Some historical comment events could not be tombstoned because current comment coverage was not strong enough to infer disappearance safely.');
    }

    if (!mentionTaggedCanTombstone && mergedEvents.some((event) => (event.payload.type === 'mention' || event.payload.type === 'tagged_appearance') && event.observationState === 'historical_unconfirmed')) {
        warnings.push('Some historical mention/tagged events remain historically observed because supporting-surface coverage was not strong enough to infer disappearance safely.');
    }

    if (!likedContentCanTombstone && mergedEvents.some((event) => event.payload.type === 'liked_content' && event.observationState === 'historical_unconfirmed')) {
        warnings.push('Historical liked-content events are never auto-tombstoned, because public like signals are too weak to infer disappearance safely.');
    }

    const outputEvents = mergedEvents
        .map(toHistoricalOutputEvent)
        .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));

    const nextState: TargetHistoryState = {
        version: 1,
        targetId,
        resolvedUsername,
        profileUrl,
        updatedAt: now,
        events: mergedEvents,
    };

    return {
        outputEvents,
        nextState,
        historySummary: {
            storeName: TARGET_HISTORY_STORE_NAME,
            stateKey: `${TARGET_STATE_KEY_PREFIX}${targetId}`,
            reusedPriorState: Boolean(previousState),
            visibleEvents: outputEvents.filter((event) => event.observationState === 'visible').length,
            historicalTombstones: outputEvents.filter((event) => event.observationState === 'historical_tombstone').length,
            historicalUnconfirmed: outputEvents.filter((event) => event.observationState === 'historical_unconfirmed').length,
            newlyObservedEvents,
            tombstonedThisRun,
        },
        warnings,
    };
}

export async function openTargetHistoryStore(): Promise<KeyValueStore> {
    return Actor.openKeyValueStore(TARGET_HISTORY_STORE_NAME);
}

export async function loadTargetHistoryState(store: KeyValueStore, targetId: string): Promise<TargetHistoryState | null> {
    return store.getValue<TargetHistoryState>(`${TARGET_STATE_KEY_PREFIX}${targetId}`);
}

export async function saveTargetHistoryState(store: KeyValueStore, state: TargetHistoryState): Promise<void> {
    await store.setValue(`${TARGET_STATE_KEY_PREFIX}${state.targetId}`, state);
}
