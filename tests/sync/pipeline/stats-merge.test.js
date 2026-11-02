import { describe, test, expect } from '@jest/globals';
import { mergeStatsDocuments } from '../../../src/sync/pipeline/stats-merge.js';

const char = extra => ({ total_gen_time: 10, user_word_count: 5, non_user_word_count: 7, user_msg_count: 1, non_user_msg_count: 1,
    total_swipe_count: 0, chat_size: 100, date_last_chat: 1000, date_first_chat: 500, ...extra });

describe('stats.json merge', () => {
    test('counters take the larger value and dates the later or earlier one', () => {
        expect(mergeStatsDocuments(
            { Seraphina: char(), timestamp: 1 },
            { Seraphina: char({ user_word_count: 9, date_last_chat: 2000, date_first_chat: 0 }), timestamp: 5 },
            { Seraphina: char({ non_user_word_count: 30, date_last_chat: 1500, date_first_chat: 400 }), timestamp: 7 },
        )).toEqual({ timestamp: 7, Seraphina: char({ user_word_count: 9, non_user_word_count: 30, date_last_chat: 2000, date_first_chat: 400 }) });
    });
    test('a character on one side only is kept', () => {
        expect(mergeStatsDocuments({ timestamp: 1 }, { timestamp: 2, A: char() }, { timestamp: 3, B: char({ chat_size: 1 }) }))
            .toEqual({ timestamp: 3, A: char(), B: char({ chat_size: 1 }) });
    });
    test('a character removed on one side is removed', () => {
        expect(mergeStatsDocuments({ timestamp: 1, A: char() }, { timestamp: 2 }, { timestamp: 3, A: char({ chat_size: 9 }) })).toEqual({ timestamp: 3 });
    });
    test('unknown fields take ours', () => {
        expect(mergeStatsDocuments(null, { A: char({ extra: 'o' }) }, { A: char({ extra: 't' }) }).A.extra).toBe('o');
    });
    test('a side that is not an object counts as empty', () => {
        expect(mergeStatsDocuments(null, 'oops', { timestamp: 3, A: char() })).toEqual({ timestamp: 3, A: char() });
    });
    test('key order is deterministic', () => {
        const merged = mergeStatsDocuments({}, { timestamp: 1, B: char() }, { A: char(), timestamp: 2 });
        expect(Object.keys(merged)).toEqual(['A', 'B', 'timestamp']);
    });
    test('character names that match object built-ins are ordinary keys', () => {
        const ours = JSON.parse(`{"timestamp":2,"__proto__":${JSON.stringify(char())}}`);
        const merged = mergeStatsDocuments({ timestamp: 1, constructor: char() }, ours, { timestamp: 3, constructor: char({ chat_size: 9 }) });
        expect(Object.keys(merged)).toEqual(['__proto__', 'timestamp']);
        expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
        expect(merged.__proto__).toEqual(char());
    });
});
