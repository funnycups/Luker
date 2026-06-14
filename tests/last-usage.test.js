import { describe, expect, test } from '@jest/globals';

import {
    setLastUsage,
    consumeLastUsage,
    peekLastUsage,
} from '../public/scripts/last-usage.js';

describe('last-usage module — single-slot hand-off from request to writer', () => {
    test('peek without prior set returns null', () => {
        setLastUsage(null);
        expect(peekLastUsage()).toBeNull();
    });

    test('set then peek returns the stored object without clearing', () => {
        const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
        setLastUsage(usage);
        expect(peekLastUsage()).toEqual(usage);
        expect(peekLastUsage()).toEqual(usage);
    });

    test('consume returns the stored object then clears the slot', () => {
        const usage = { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 };
        setLastUsage(usage);
        expect(consumeLastUsage()).toEqual(usage);
        expect(peekLastUsage()).toBeNull();
        expect(consumeLastUsage()).toBeNull();
    });

    test('setLastUsage(null) clears the slot', () => {
        setLastUsage({ completion_tokens: 1 });
        setLastUsage(null);
        expect(peekLastUsage()).toBeNull();
    });

    test('second set replaces (does not merge)', () => {
        setLastUsage({ completion_tokens: 1, total_tokens: 1 });
        setLastUsage({ completion_tokens: 99, total_tokens: 99 });
        expect(consumeLastUsage()).toEqual({ completion_tokens: 99, total_tokens: 99 });
    });

    test('setLastUsage(undefined) is treated as a clear (null), not stored verbatim', () => {
        setLastUsage({ completion_tokens: 5 });
        setLastUsage(undefined);
        expect(peekLastUsage()).toBeNull();
    });
});
