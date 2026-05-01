/**
 * Pure-function tests for floor-state/core.js.
 *
 * These tests exercise the algorithm layer in isolation: log normalization,
 * commit validation, swipe-map construction, target-state computation,
 * truncate / remove-swipe transformations, commit-target inference.
 *
 * The instance layer (floor-state.js) is tested separately via mocked deps
 * in tests/floor-state/instance.test.js.
 */

import { describe, test, expect } from '@jest/globals';
import {
    LOG_VERSION,
    isValidCommit,
    normalizeLog,
    buildSwipeMapFromChat,
    shouldKeepCommit,
    computeTargetState,
    truncateCommits,
    removeSwipeFromCommits,
    inferCommitTargetFromChat,
} from '../../public/scripts/floor-state/core.js';

describe('isValidCommit', () => {
    test('accepts well-formed commit', () => {
        expect(isValidCommit({
            floor: 0, swipeId: 0,
            patches: [{ op: 'add', path: '/a', value: 1 }],
        })).toBe(true);
    });

    test('rejects non-object', () => {
        expect(isValidCommit(null)).toBe(false);
        expect(isValidCommit('string')).toBe(false);
        expect(isValidCommit(42)).toBe(false);
    });

    test('rejects non-integer or negative floor', () => {
        const base = { swipeId: 0, patches: [{ op: 'add', path: '/a', value: 1 }] };
        expect(isValidCommit({ ...base, floor: -1 })).toBe(false);
        expect(isValidCommit({ ...base, floor: 1.5 })).toBe(false);
        expect(isValidCommit({ ...base, floor: '0' })).toBe(false);
    });

    test('rejects non-integer or negative swipeId', () => {
        const base = { floor: 0, patches: [{ op: 'add', path: '/a', value: 1 }] };
        expect(isValidCommit({ ...base, swipeId: -1 })).toBe(false);
        expect(isValidCommit({ ...base, swipeId: 1.5 })).toBe(false);
    });

    test('rejects empty or non-array patches', () => {
        expect(isValidCommit({ floor: 0, swipeId: 0, patches: [] })).toBe(false);
        expect(isValidCommit({ floor: 0, swipeId: 0, patches: 'string' })).toBe(false);
        expect(isValidCommit({ floor: 0, swipeId: 0 })).toBe(false);
    });
});

describe('normalizeLog', () => {
    test('returns empty log on null/undefined/non-object', () => {
        const empty = { version: LOG_VERSION, commits: [] };
        expect(normalizeLog(null)).toEqual(empty);
        expect(normalizeLog(undefined)).toEqual(empty);
        expect(normalizeLog('string')).toEqual(empty);
        expect(normalizeLog(42)).toEqual(empty);
    });

    test('returns empty log on object without commits array', () => {
        expect(normalizeLog({})).toEqual({ version: LOG_VERSION, commits: [] });
        expect(normalizeLog({ commits: 'not array' })).toEqual({ version: LOG_VERSION, commits: [] });
    });

    test('filters out invalid commits', () => {
        const valid = { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/a', value: 1 }] };
        const log = normalizeLog({
            commits: [
                valid,
                null,
                { floor: -1, swipeId: 0, patches: [{ op: 'add', path: '/b', value: 2 }] },
                { floor: 0, swipeId: 0 },
                valid,
            ],
        });
        expect(log.commits).toHaveLength(2);
        expect(log.commits[0]).toBe(valid);
    });

    test('always sets version to current LOG_VERSION', () => {
        expect(normalizeLog({ version: 999, commits: [] }).version).toBe(LOG_VERSION);
    });
});

describe('buildSwipeMapFromChat', () => {
    test('returns empty map for empty / non-array chat', () => {
        expect(Object.keys(buildSwipeMapFromChat([]))).toHaveLength(0);
        expect(Object.keys(buildSwipeMapFromChat(null))).toHaveLength(0);
        expect(Object.keys(buildSwipeMapFromChat(undefined))).toHaveLength(0);
    });

    test('reads swipe_id from each message', () => {
        const map = buildSwipeMapFromChat([
            { swipe_id: 0 },
            { swipe_id: 2 },
            { swipe_id: 1 },
        ]);
        expect(map[0]).toBe(0);
        expect(map[1]).toBe(2);
        expect(map[2]).toBe(1);
    });

    test('coerces missing or invalid swipe_id to 0', () => {
        const map = buildSwipeMapFromChat([
            {},
            { swipe_id: -1 },
            { swipe_id: 'oops' },
            { swipe_id: 1.5 },
            null,
        ]);
        expect(map[0]).toBe(0);
        expect(map[1]).toBe(0);
        expect(map[2]).toBe(0);
        expect(map[3]).toBe(0);
        expect(map[4]).toBe(0);
    });
});

describe('shouldKeepCommit', () => {
    test('keeps commit when swipeId matches active swipe', () => {
        const swipeMap = { 0: 0, 1: 2 };
        expect(shouldKeepCommit({ floor: 0, swipeId: 0 }, swipeMap)).toBe(true);
        expect(shouldKeepCommit({ floor: 1, swipeId: 2 }, swipeMap)).toBe(true);
    });

    test('drops commit when swipeId differs from active swipe', () => {
        const swipeMap = { 0: 0, 1: 2 };
        expect(shouldKeepCommit({ floor: 0, swipeId: 1 }, swipeMap)).toBe(false);
        expect(shouldKeepCommit({ floor: 1, swipeId: 0 }, swipeMap)).toBe(false);
    });

    test('drops commit whose floor is no longer in chat', () => {
        const swipeMap = { 0: 0 };
        expect(shouldKeepCommit({ floor: 5, swipeId: 0 }, swipeMap)).toBe(false);
    });
});

describe('computeTargetState', () => {
    test('returns empty object when no commits', () => {
        expect(computeTargetState([], {})).toEqual({});
    });

    test('replays single commit', () => {
        const commits = [{
            floor: 0, swipeId: 0,
            patches: [{ op: 'add', path: '/x', value: 1 }],
        }];
        expect(computeTargetState(commits, { 0: 0 })).toEqual({ x: 1 });
    });

    test('replays commits in order', () => {
        const commits = [
            { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] },
            { floor: 1, swipeId: 0, patches: [{ op: 'add', path: '/y', value: 2 }] },
            { floor: 2, swipeId: 0, patches: [{ op: 'replace', path: '/x', value: 99 }] },
        ];
        expect(computeTargetState(commits, { 0: 0, 1: 0, 2: 0 })).toEqual({ x: 99, y: 2 });
    });

    test('skips commits whose swipeId no longer matches', () => {
        const commits = [
            { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] },
            { floor: 1, swipeId: 0, patches: [{ op: 'add', path: '/y', value: 2 }] },
            { floor: 1, swipeId: 1, patches: [{ op: 'add', path: '/y', value: 999 }] },
        ];
        // active swipe on floor 1 is 1, so commit-on-swipe-0 must be skipped
        expect(computeTargetState(commits, { 0: 0, 1: 1 })).toEqual({ x: 1, y: 999 });
    });

    test('skips commits whose floor is gone', () => {
        const commits = [
            { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/x', value: 1 }] },
            { floor: 5, swipeId: 0, patches: [{ op: 'add', path: '/y', value: 2 }] },
        ];
        expect(computeTargetState(commits, { 0: 0 })).toEqual({ x: 1 });
    });

    test('handles remove and replace operations', () => {
        const commits = [
            { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/a', value: { b: 1, c: 2 } }] },
            { floor: 1, swipeId: 0, patches: [{ op: 'remove', path: '/a/b' }] },
        ];
        expect(computeTargetState(commits, { 0: 0, 1: 0 })).toEqual({ a: { c: 2 } });
    });
});

describe('truncateCommits', () => {
    const c0 = { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/a', value: 1 }] };
    const c1 = { floor: 1, swipeId: 0, patches: [{ op: 'add', path: '/b', value: 2 }] };
    const c5 = { floor: 5, swipeId: 0, patches: [{ op: 'add', path: '/c', value: 3 }] };

    test('keeps all commits when newChatLength is greater', () => {
        expect(truncateCommits([c0, c1, c5], 10)).toEqual([c0, c1, c5]);
    });

    test('drops commits at or beyond newChatLength', () => {
        expect(truncateCommits([c0, c1, c5], 5)).toEqual([c0, c1]);
        expect(truncateCommits([c0, c1, c5], 1)).toEqual([c0]);
        expect(truncateCommits([c0, c1, c5], 0)).toEqual([]);
    });

    test('returns shallow copy on bad input', () => {
        const input = [c0, c1];
        expect(truncateCommits(input, -1)).toEqual([c0, c1]);
        expect(truncateCommits(input, NaN)).toEqual([c0, c1]);
        expect(truncateCommits(input, 'oops')).toEqual([c0, c1]);
    });
});

describe('removeSwipeFromCommits', () => {
    test('drops commits on target floor with deleted swipeId', () => {
        const commits = [
            { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/a', value: 1 }] },
            { floor: 1, swipeId: 1, patches: [{ op: 'add', path: '/b', value: 2 }] },
            { floor: 2, swipeId: 0, patches: [{ op: 'add', path: '/c', value: 3 }] },
        ];
        const out = removeSwipeFromCommits(commits, 1, 1);
        expect(out).toHaveLength(2);
        expect(out.map((c) => c.floor)).toEqual([0, 2]);
    });

    test('shifts swipeId down for higher swipes on the same floor', () => {
        const commits = [
            { floor: 1, swipeId: 0, patches: [{ op: 'add', path: '/a', value: 1 }] },
            { floor: 1, swipeId: 2, patches: [{ op: 'add', path: '/b', value: 2 }] },
            { floor: 1, swipeId: 3, patches: [{ op: 'add', path: '/c', value: 3 }] },
        ];
        const out = removeSwipeFromCommits(commits, 1, 1);
        // swipe 1 didn't have any commits in this set; swipes 2 and 3 shift to 1 and 2.
        expect(out).toHaveLength(3);
        expect(out.map((c) => c.swipeId)).toEqual([0, 1, 2]);
    });

    test('does not touch other floors', () => {
        const commits = [
            { floor: 0, swipeId: 2, patches: [{ op: 'add', path: '/x', value: 1 }] },
            { floor: 1, swipeId: 1, patches: [{ op: 'add', path: '/y', value: 2 }] },
        ];
        const out = removeSwipeFromCommits(commits, 1, 1);
        expect(out[0]).toEqual(commits[0]); // floor 0 commit untouched
    });

    test('returns shallow copy on bad input', () => {
        const c = { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/a', value: 1 }] };
        expect(removeSwipeFromCommits([c], NaN, 0)).toEqual([c]);
        expect(removeSwipeFromCommits([c], 0, 'oops')).toEqual([c]);
    });
});

describe('inferCommitTargetFromChat', () => {
    test('returns null on empty / non-array chat', () => {
        expect(inferCommitTargetFromChat([])).toBeNull();
        expect(inferCommitTargetFromChat(null)).toBeNull();
        expect(inferCommitTargetFromChat(undefined)).toBeNull();
    });

    test('returns last index and that message swipe_id', () => {
        const chat = [{ swipe_id: 0 }, { swipe_id: 0 }, { swipe_id: 3 }];
        expect(inferCommitTargetFromChat(chat)).toEqual({ floor: 2, swipeId: 3 });
    });

    test('coerces missing swipe_id to 0', () => {
        expect(inferCommitTargetFromChat([{}])).toEqual({ floor: 0, swipeId: 0 });
        expect(inferCommitTargetFromChat([{}, { swipe_id: -1 }])).toEqual({ floor: 1, swipeId: 0 });
    });

    test('coerces non-integer swipe_id to 0', () => {
        expect(inferCommitTargetFromChat([{ swipe_id: 1.7 }])).toEqual({ floor: 0, swipeId: 0 });
        expect(inferCommitTargetFromChat([{ swipe_id: 'oops' }])).toEqual({ floor: 0, swipeId: 0 });
    });
});
