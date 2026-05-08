import { describe, expect, test } from '@jest/globals';

import { estimateTotalTokensFromCache } from '../public/scripts/util/prompt-token-estimate.js';

describe('estimateTotalTokensFromCache', () => {
    test('returns 0 for empty inputs', () => {
        expect(estimateTotalTokensFromCache([], {})).toBe(0);
    });

    test('returns 0 when promptOrder is not an array', () => {
        expect(estimateTotalTokensFromCache(null, { a: 100 })).toBe(0);
        expect(estimateTotalTokensFromCache(undefined, { a: 100 })).toBe(0);
        expect(estimateTotalTokensFromCache({}, { a: 100 })).toBe(0);
    });

    test('returns 0 when counts is not a non-null object', () => {
        const order = [{ identifier: 'a', enabled: true }];
        expect(estimateTotalTokensFromCache(order, null)).toBe(0);
        expect(estimateTotalTokensFromCache(order, undefined)).toBe(0);
    });

    test('sums positive cached values for enabled prompts', () => {
        const order = [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
            { identifier: 'c', enabled: true },
        ];
        const counts = { a: 100, b: 50, c: 25 };
        expect(estimateTotalTokensFromCache(order, counts)).toBe(175);
    });

    test('skips disabled prompts even when cached value is positive', () => {
        const order = [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: false },
        ];
        const counts = { a: 100, b: 50 };
        expect(estimateTotalTokensFromCache(order, counts)).toBe(100);
    });

    test('skips never-tokenized prompts (undefined cache) — first-time enable contributes 0', () => {
        const order = [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
        ];
        const counts = { a: 100 };
        expect(estimateTotalTokensFromCache(order, counts)).toBe(100);
    });

    test('skips null cached values', () => {
        const order = [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
        ];
        const counts = { a: 100, b: null };
        expect(estimateTotalTokensFromCache(order, counts)).toBe(100);
    });

    test('skips zero cached values (treated as not-yet-tokenized for display purposes)', () => {
        const order = [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
        ];
        const counts = { a: 100, b: 0 };
        expect(estimateTotalTokensFromCache(order, counts)).toBe(100);
    });

    test('skips NaN and Infinity cached values', () => {
        const order = [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
            { identifier: 'c', enabled: true },
        ];
        const counts = { a: 100, b: NaN, c: Infinity };
        expect(estimateTotalTokensFromCache(order, counts)).toBe(100);
    });

    test('skips entries missing identifier or with falsy entry value', () => {
        const order = [
            { enabled: true },
            null,
            undefined,
            { identifier: 'a', enabled: true },
        ];
        const counts = { a: 100, undefined: 999 };
        expect(estimateTotalTokensFromCache(order, counts)).toBe(100);
    });

    test('respects enabled flag interpreted as truthy/falsy', () => {
        const order = [
            { identifier: 'a', enabled: 1 },
            { identifier: 'b', enabled: 0 },
            { identifier: 'c' }, // missing enabled treated as disabled
        ];
        const counts = { a: 10, b: 20, c: 30 };
        expect(estimateTotalTokensFromCache(order, counts)).toBe(10);
    });

    test('order of entries does not matter (commutative sum)', () => {
        const order = [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
        ];
        const reversed = [...order].reverse();
        const counts = { a: 7, b: 13 };
        expect(estimateTotalTokensFromCache(order, counts)).toBe(20);
        expect(estimateTotalTokensFromCache(reversed, counts)).toBe(20);
    });

    test('handles a group toggle-all flipping multiple prompts at once', () => {
        // Simulates the prompt-group toggle-all path: several prompts in a group
        // flip enabled state in one synchronous batch (toggleGroupPrompts loop),
        // then the header estimate is recomputed once.
        const order = [
            { identifier: 'g1', enabled: true },
            { identifier: 'g2', enabled: true },
            { identifier: 'g3', enabled: true },
            { identifier: 'outside', enabled: true },
        ];
        const groupIndexes = [0, 1, 2];
        const counts = { g1: 100, g2: 200, g3: 300, outside: 50 };
        const flipMembers = (newState) => {
            for (const i of groupIndexes) {
                order[i].enabled = newState;
            }
        };

        expect(estimateTotalTokensFromCache(order, counts)).toBe(650);

        flipMembers(false);
        expect(estimateTotalTokensFromCache(order, counts)).toBe(50);

        flipMembers(true);
        expect(estimateTotalTokensFromCache(order, counts)).toBe(650);
    });
});
