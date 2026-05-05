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
});
