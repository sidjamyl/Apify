import { describe, expect, it } from 'vitest';

import {
    canonicalizeUsernameForMatching,
    classifyCommentOwnerUsername,
    computeConfidenceLevel,
    computeCoverageLevel,
    computeScanState,
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

    it('canonicalizes punctuation-only username variants', () => {
        expect(canonicalizeUsernameForMatching('john.doe_test')).toBe('johndoetest');
    });

    it('classifies exact, ambiguous, and non-match owner usernames', () => {
        expect(classifyCommentOwnerUsername('nasa', 'nasa')).toBe('confirmed');
        expect(classifyCommentOwnerUsername('john_doe', 'john.doe')).toBe('ambiguous');
        expect(classifyCommentOwnerUsername('nasawebb', 'nasa')).toBe('no_match');
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

    it('computes explicit scan states', () => {
        expect(computeScanState({
            browserAvailable: true,
            partialFailures: 0,
            coverageLevel: 'high',
        })).toBe('complete');

        expect(computeScanState({
            browserAvailable: true,
            partialFailures: 0,
            coverageLevel: 'low',
        })).toBe('low_coverage');

        expect(computeScanState({
            browserAvailable: false,
            partialFailures: 1,
            coverageLevel: 'unknown',
        })).toBe('partial_failure');
    });

    it('computes confidence levels from exact and ambiguous matches', () => {
        expect(computeConfidenceLevel({ exactMatches: 2, ambiguousCandidates: 0 })).toBe('high');
        expect(computeConfidenceLevel({ exactMatches: 1, ambiguousCandidates: 2 })).toBe('medium');
        expect(computeConfidenceLevel({ exactMatches: 0, ambiguousCandidates: 1 })).toBe('low');
        expect(computeConfidenceLevel({ exactMatches: 0, ambiguousCandidates: 0 })).toBe('unknown');
    });
});
