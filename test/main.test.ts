import { describe, expect, it } from 'vitest';

import {
    computeCoverageLevel,
    dedupeByKey,
    extractMentionedUsernames,
    parseCommentTextFromBlock,
} from '../src/comment-utils.js';
import { normalizeUsername, parseInput } from '../src/input.js';

describe('input parsing', () => {
    it('normalizes usernames with @ and case changes', () => {
        expect(normalizeUsername(' @NASA ')).toBe('nasa');
    });

    it('validates the public username-only contract', () => {
        expect(parseInput({ username: 'NASA' })).toEqual({ username: 'nasa' });
    });
});

describe('comment utilities', () => {
    it('extracts mentioned usernames from captions', () => {
        expect(extractMentionedUsernames('Hello @NASAWebb and @ESAWebb.')).toEqual(['nasawebb', 'esawebb']);
    });

    it('parses comment text from a visible Instagram block', () => {
        const blockText = 'quantum.student\n\u00a0\n7w\nlindo demais\nLike\nReply';
        expect(parseCommentTextFromBlock(blockText, 'quantum.student', '7w')).toBe('lindo demais');
    });

    it('deduplicates comment-like records by permalink', () => {
        const items = [
            { key: 'a', value: 1 },
            { key: 'a', value: 2 },
            { key: 'b', value: 3 },
        ];

        expect(dedupeByKey(items, (item) => item.key)).toEqual([
            { key: 'a', value: 1 },
            { key: 'b', value: 3 },
        ]);
    });

    it('computes qualitative coverage levels', () => {
        expect(computeCoverageLevel({
            browserAvailable: false,
            scannedPosts: 0,
            candidatePosts: 12,
            partialFailures: 0,
        })).toBe('unknown');

        expect(computeCoverageLevel({
            browserAvailable: true,
            scannedPosts: 4,
            candidatePosts: 4,
            partialFailures: 0,
        })).toBe('medium');
    });
});
