import type { CoverageLevel } from './types.js';

const USERNAME_MENTION_REGEX = /@([A-Za-z0-9._]*[A-Za-z0-9_])/g;

export function extractMentionedUsernames(value: string | null | undefined): string[] {
    if (!value) return [];

    const usernames = new Set<string>();
    for (const match of value.matchAll(USERNAME_MENTION_REGEX)) {
        usernames.add(match[1].toLowerCase());
    }

    return [...usernames];
}

export function parseCommentTextFromBlock(
    rawText: string,
    ownerUsername: string,
    createdAtLabel: string | null,
): string {
    const ignoredLines = new Set(['Like', 'Reply', 'Edited']);
    const lines = rawText
        .replace(/\u00a0/g, ' ')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !ignoredLines.has(line))
        .filter((line) => line !== ownerUsername)
        .filter((line) => line !== createdAtLabel);

    return lines.join('\n').trim();
}

export function dedupeByKey<T>(items: T[], keySelector: (item: T) => string): T[] {
    const dedupedItems = new Map<string, T>();

    for (const item of items) {
        const key = keySelector(item);
        if (!dedupedItems.has(key)) {
            dedupedItems.set(key, item);
        }
    }

    return [...dedupedItems.values()];
}

export function computeCoverageLevel(input: {
    browserAvailable: boolean;
    scannedPosts: number;
    candidatePosts: number;
    partialFailures: number;
}): CoverageLevel {
    const {
        browserAvailable,
        scannedPosts,
        candidatePosts,
        partialFailures,
    } = input;

    if (!browserAvailable || scannedPosts === 0) {
        return 'unknown';
    }

    if (partialFailures > 0) {
        return 'low';
    }

    if (candidatePosts >= 10 && scannedPosts >= 10) {
        return 'high';
    }

    if (candidatePosts >= 4 && scannedPosts >= 4) {
        return 'medium';
    }

    return 'low';
}
