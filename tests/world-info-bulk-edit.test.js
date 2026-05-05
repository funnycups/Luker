import { describe, test, expect } from '@jest/globals';

import {
    inferCommonValue,
    BULK_PATCH_KEEP_SENTINEL,
} from '../public/scripts/world-info-bulk-edit.js';

describe('inferCommonValue', () => {
    const entries = {
        '1': { uid: 1, depth: 4, comment: 'a', preventRecursion: true },
        '2': { uid: 2, depth: 4, comment: 'b', preventRecursion: false },
        '3': { uid: 3, depth: 0, comment: 'c' },
    };

    test('returns the shared value when all selected entries agree', () => {
        expect(inferCommonValue(entries, ['1', '2'], 'depth')).toEqual({ kind: 'common', value: 4 });
    });

    test('returns mixed when selected entries disagree', () => {
        expect(inferCommonValue(entries, ['1', '3'], 'depth')).toEqual({ kind: 'mixed' });
    });

    test('returns mixed when any selected entry is missing the field', () => {
        expect(inferCommonValue(entries, ['1', '3'], 'preventRecursion')).toEqual({ kind: 'mixed' });
    });

    test('returns common when single entry has the value', () => {
        expect(inferCommonValue(entries, ['1'], 'depth')).toEqual({ kind: 'common', value: 4 });
    });

    test('returns mixed for empty selection (no shared truth)', () => {
        expect(inferCommonValue(entries, [], 'depth')).toEqual({ kind: 'mixed' });
    });

    test('treats unknown uids as if they were missing the field', () => {
        expect(inferCommonValue(entries, ['1', '99'], 'depth')).toEqual({ kind: 'mixed' });
    });

    test('exports a unique BULK_PATCH_KEEP_SENTINEL', () => {
        expect(typeof BULK_PATCH_KEEP_SENTINEL).toBe('symbol');
    });

    test('treats arrays with the same elements as common', () => {
        const e = { '1': { key: ['a', 'b'] }, '2': { key: ['a', 'b'] } };
        expect(inferCommonValue(e, ['1', '2'], 'key')).toEqual({ kind: 'common', value: ['a', 'b'] });
    });

    test('treats arrays of different lengths as mixed', () => {
        const e = { '1': { key: ['a'] }, '2': { key: ['a', 'b'] } };
        expect(inferCommonValue(e, ['1', '2'], 'key')).toEqual({ kind: 'mixed' });
    });
});

import {
    buildBulkFieldPatchSnapshot,
    applyPatchToEntries,
    restoreEntriesFromSnapshot,
} from '../public/scripts/world-info-bulk-edit.js';

describe('buildBulkFieldPatchSnapshot', () => {
    function freshEntries() {
        return {
            '1': { uid: 1, depth: 4, preventRecursion: false },
            '2': { uid: 2, depth: 0, preventRecursion: false },
            '3': { uid: 3, depth: 4, preventRecursion: true },
        };
    }

    test('records changedUids only for entries whose value differs', () => {
        const result = buildBulkFieldPatchSnapshot(freshEntries(), ['1', '2', '3'], { depth: 4 });
        expect(result.changedUids).toEqual(['2']);
        expect(result.snapshot).toEqual([{ uid: '2', oldValues: { depth: 0 } }]);
    });

    test('captures multiple fields per uid in oldValues', () => {
        const result = buildBulkFieldPatchSnapshot(freshEntries(), ['1', '2'], { depth: 9, preventRecursion: true });
        expect(result.changedUids.sort()).toEqual(['1', '2']);
        const byUid = Object.fromEntries(result.snapshot.map(s => [s.uid, s.oldValues]));
        expect(byUid['1']).toEqual({ depth: 4, preventRecursion: false });
        expect(byUid['2']).toEqual({ depth: 0, preventRecursion: false });
    });

    test('skips entries that already match every patch field', () => {
        const result = buildBulkFieldPatchSnapshot(freshEntries(), ['1', '3'], { depth: 4 });
        expect(result.changedUids).toEqual([]);
        expect(result.snapshot).toEqual([]);
    });

    test('skips uids that are missing from entries map', () => {
        const result = buildBulkFieldPatchSnapshot(freshEntries(), ['1', '99'], { depth: 99 });
        expect(result.changedUids).toEqual(['1']);
    });

    test('strips BULK_PATCH_KEEP_SENTINEL fields from the patch', () => {
        const result = buildBulkFieldPatchSnapshot(
            freshEntries(),
            ['1', '2'],
            { depth: 9, preventRecursion: BULK_PATCH_KEEP_SENTINEL },
        );
        expect(result.snapshot.find(s => s.uid === '1').oldValues).toEqual({ depth: 4 });
        expect(result.snapshot.find(s => s.uid === '2').oldValues).toEqual({ depth: 0 });
    });

    test('treats missing field on entry as a different value (writes new value, snapshots undefined)', () => {
        const entries = { '1': { uid: 1 } };
        const result = buildBulkFieldPatchSnapshot(entries, ['1'], { depth: 4 });
        expect(result.changedUids).toEqual(['1']);
        expect(result.snapshot).toEqual([{ uid: '1', oldValues: { depth: undefined } }]);
    });
});

describe('applyPatchToEntries', () => {
    test('writes patch fields to all changedUids', () => {
        const entries = {
            '1': { uid: 1, depth: 4 },
            '2': { uid: 2, depth: 0 },
        };
        applyPatchToEntries(entries, ['1', '2'], { depth: 9 });
        expect(entries['1'].depth).toBe(9);
        expect(entries['2'].depth).toBe(9);
    });

    test('writes multiple fields atomically', () => {
        const entries = { '1': { uid: 1, depth: 4, preventRecursion: false } };
        applyPatchToEntries(entries, ['1'], { depth: 9, preventRecursion: true });
        expect(entries['1']).toMatchObject({ depth: 9, preventRecursion: true });
    });

    test('strips BULK_PATCH_KEEP_SENTINEL fields', () => {
        const entries = { '1': { uid: 1, depth: 4, preventRecursion: false } };
        applyPatchToEntries(entries, ['1'], { depth: 9, preventRecursion: BULK_PATCH_KEEP_SENTINEL });
        expect(entries['1'].depth).toBe(9);
        expect(entries['1'].preventRecursion).toBe(false);
    });

    test('skips uids that have been deleted between snapshot and apply', () => {
        const entries = { '1': { uid: 1, depth: 4 } };
        applyPatchToEntries(entries, ['1', '99'], { depth: 9 });
        expect(entries['1'].depth).toBe(9);
        expect(entries['99']).toBeUndefined();
    });
});

describe('restoreEntriesFromSnapshot', () => {
    test('restores original values', () => {
        const entries = { '1': { uid: 1, depth: 9 }, '2': { uid: 2, depth: 9 } };
        const snapshot = [
            { uid: '1', oldValues: { depth: 4 } },
            { uid: '2', oldValues: { depth: 0 } },
        ];
        restoreEntriesFromSnapshot(entries, snapshot);
        expect(entries['1'].depth).toBe(4);
        expect(entries['2'].depth).toBe(0);
    });

    test('skips snapshot entries whose uid no longer exists', () => {
        const entries = { '1': { uid: 1, depth: 9 } };
        const snapshot = [
            { uid: '1', oldValues: { depth: 4 } },
            { uid: '99', oldValues: { depth: 0 } },
        ];
        expect(() => restoreEntriesFromSnapshot(entries, snapshot)).not.toThrow();
        expect(entries['1'].depth).toBe(4);
    });

    test('restores undefined fields by deleting the property', () => {
        const entries = { '1': { uid: 1, depth: 9 } };
        const snapshot = [{ uid: '1', oldValues: { depth: undefined } }];
        restoreEntriesFromSnapshot(entries, snapshot);
        expect(Object.hasOwn(entries['1'], 'depth')).toBe(false);
    });
});
