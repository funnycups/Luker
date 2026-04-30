import { describe, test, expect } from '@jest/globals';
import {
    rebuildVariables,
    getTrackedKeys,
    computeReplayedState,
} from '../../public/scripts/variable-op-log/rebuilder.js';

const setOp = (key, value) => ({ op: 'setvar', key, value });
const incOp = (key) => ({ op: 'incvar', key });
const decOp = (key) => ({ op: 'decvar', key });
const delOp = (key) => ({ op: 'deletevar', key });

const msg = (...ops) => ({ extra: { var_ops: ops } });
const blank = () => ({});

describe('rebuilder: rebuildVariables', () => {
    test('does nothing when chat has no ops', () => {
        const chat = [blank(), blank(), blank()];
        const state = { weather: 'sunny', hp: '100' };
        rebuildVariables(chat, state);
        expect(state).toEqual({ weather: 'sunny', hp: '100' });
    });

    test('applies a single op', () => {
        const chat = [msg(setOp('hp', '50'))];
        const state = {};
        const stats = rebuildVariables(chat, state);
        expect(state).toEqual({ hp: '50' });
        expect(stats).toEqual({ touchedMessages: 1, totalOps: 1, trackedKeys: 1 });
    });

    test('applies ops in chat order across messages', () => {
        const chat = [
            msg(setOp('hp', '100')),
            msg(setOp('hp', '50')),
            msg(setOp('hp', '10')),
        ];
        const state = {};
        rebuildVariables(chat, state);
        expect(state.hp).toBe('10');
    });

    test('does not touch keys outside surviving ops', () => {
        // Simulate WI, QR, legacy values living in the same cache
        const state = {
            weather: 'sunny',     // from WI
            quest_step: '3',      // from QR
            legacy_token: 'abc',  // from old chat
            hp: 'stale',          // stale value from a previous (now-deleted) op
        };
        const chat = [msg(setOp('mp', '20'))];
        rebuildVariables(chat, state);

        expect(state).toEqual({
            weather: 'sunny',
            quest_step: '3',
            legacy_token: 'abc',
            hp: 'stale',          // unchanged: not in tracked keys
            mp: '20',
        });
    });

    test('removes a key tracked by ops if all ops are deletevar', () => {
        const state = { hp: '50', other: 'stays' };
        const chat = [msg(delOp('hp'))];
        rebuildVariables(chat, state);
        expect('hp' in state).toBe(false);
        expect(state.other).toBe('stays');
    });

    test('removes a key when ops resolve to undefined (set then delete)', () => {
        const state = { hp: 'stale' };
        const chat = [
            msg(setOp('hp', '50')),
            msg(delOp('hp')),
        ];
        rebuildVariables(chat, state);
        expect('hp' in state).toBe(false);
    });

    test('respects ordering of inc/dec arithmetic', () => {
        const state = {};
        const chat = [
            msg(setOp('turn', '5')),
            msg(incOp('turn')),
            msg(incOp('turn')),
            msg(decOp('turn')),
        ];
        rebuildVariables(chat, state);
        expect(state.turn).toBe(6);
    });

    test('reproduces the WI=10/AI=50/AI=10 deletion scenario correctly', () => {
        // Setup: WI has written hp=10, then AI msg#1 sets hp=50, then AI msg#2 sets hp=10.
        // After deleting msg#2, we expect hp=50 (replayed from msg#1).
        const state = { hp: '10' };
        const chat = [
            msg(setOp('hp', '50')),  // msg#1
            // msg#2 was deleted
        ];
        rebuildVariables(chat, state);
        expect(state.hp).toBe('50');
    });

    test('skips messages without var_ops', () => {
        const chat = [
            blank(),
            msg(setOp('a', '1')),
            { extra: {} },  // extra without var_ops
            msg(setOp('b', '2')),
            { extra: { var_ops: null } },  // null var_ops
        ];
        const state = {};
        const stats = rebuildVariables(chat, state);
        expect(state).toEqual({ a: '1', b: '2' });
        expect(stats.touchedMessages).toBe(2);
    });

    test('ignores ops missing key', () => {
        const chat = [{ extra: { var_ops: [{ op: 'setvar' }, setOp('x', '1')] } }];
        const state = {};
        rebuildVariables(chat, state);
        expect(state).toEqual({ x: '1' });
    });

    test('null/invalid inputs do not throw', () => {
        expect(() => rebuildVariables(null, {})).not.toThrow();
        expect(() => rebuildVariables([], null)).not.toThrow();
        expect(() => rebuildVariables(undefined, undefined)).not.toThrow();
    });

    test('returns rebuild stats', () => {
        const chat = [
            msg(setOp('a', '1'), incOp('b')),
            blank(),
            msg(setOp('a', '2')),
        ];
        const stats = rebuildVariables(chat, {});
        expect(stats.touchedMessages).toBe(2);
        expect(stats.totalOps).toBe(3);
        expect(stats.trackedKeys).toBe(2); // a and b
    });
});

describe('rebuilder: getTrackedKeys', () => {
    test('returns empty set for empty chat', () => {
        expect(getTrackedKeys([]).size).toBe(0);
        expect(getTrackedKeys(null).size).toBe(0);
    });

    test('collects all keys mentioned in var_ops', () => {
        const chat = [
            msg(setOp('a', '1')),
            msg(setOp('b', '2'), incOp('c')),
            msg(delOp('a')),
        ];
        const keys = getTrackedKeys(chat);
        expect(keys).toEqual(new Set(['a', 'b', 'c']));
    });

    test('does not include malformed ops', () => {
        const chat = [
            msg({ op: 'setvar' }, setOp('valid', '1')),
        ];
        expect(getTrackedKeys(chat)).toEqual(new Set(['valid']));
    });
});

describe('rebuilder: computeReplayedState', () => {
    test('returns fresh state without mutating inputs', () => {
        const chat = [msg(setOp('a', '1'))];
        const result = computeReplayedState(chat);
        expect(result).toEqual({ a: '1' });
    });

    test('full replay independent of caller state', () => {
        const chat = [
            msg(setOp('hp', '100')),
            msg(decOp('hp')),
            msg(decOp('hp')),
        ];
        expect(computeReplayedState(chat)).toEqual({ hp: 98 });
    });

    test('handles chats with no ops', () => {
        expect(computeReplayedState([])).toEqual({});
        expect(computeReplayedState([blank(), blank()])).toEqual({});
    });
});
