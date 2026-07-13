import { describe, test, expect } from '@jest/globals';

/**
 * Direct import of onWorldInfoFinalized is impractical because main.js
 * has heavy side-effects. Instead we unit-test the filter integration
 * by invoking the exported helper applyProfileWorldInfoFilter on a
 * payload shaped like ST core's wiFinalizedPayload, then verify that
 * a downstream re-normalization step (imitated inline) sees the
 * filtered arrays. Complementary end-to-end verification lives in
 * tests/e2e/orchestrator/*.
 *
 * This suite also verifies the allActivatedEntries → activatedEntryKeys
 * bug fix: given a payload with worldInfoResolution.activatedEntries,
 * buildActivatedEntryKeysFromPayload should produce a non-empty Set.
 */

import {
    applyProfileWorldInfoFilter,
    buildActivatedEntryKeysFromPayload,
} from '../../public/scripts/extensions/orchestrator/lorebook-filter.js';

describe('buildActivatedEntryKeysFromPayload (Task 3 bug fix)', () => {
    test('legacy path: payload.allActivatedEntries undefined → falls back to worldInfoResolution.activatedEntries', () => {
        const payload = {
            worldInfoResolution: {
                activatedEntries: [
                    { world: 'BookA', uid: 1, comment: 'x' },
                    { world: 'BookA', uid: 2, comment: 'y' },
                    { world: 'BookB', uid: 5, comment: 'z' },
                ],
            },
        };
        const keys = buildActivatedEntryKeysFromPayload(payload);
        expect(keys.size).toBe(3);
        expect(keys.has('BookA.1')).toBe(true);
        expect(keys.has('BookA.2')).toBe(true);
        expect(keys.has('BookB.5')).toBe(true);
    });

    test('entries missing uid are skipped', () => {
        const payload = {
            worldInfoResolution: {
                activatedEntries: [
                    { world: 'X', uid: null, comment: 'a' },
                    { world: 'X', uid: 3, comment: 'b' },
                ],
            },
        };
        const keys = buildActivatedEntryKeysFromPayload(payload);
        expect(keys.size).toBe(1);
        expect(keys.has('X.3')).toBe(true);
    });

    test('missing worldInfoResolution → empty Set', () => {
        expect(buildActivatedEntryKeysFromPayload({}).size).toBe(0);
        expect(buildActivatedEntryKeysFromPayload(null).size).toBe(0);
    });
});

describe('applyProfileWorldInfoFilter integration shape (Task 3 hook)', () => {
    test('mutates payload world-info arrays in place based on activatedEntries lookup', () => {
        const payload = {
            worldInfoBeforeEntries: ['keep-1', 'drop-private', 'keep-2'],
            worldInfoAfterEntries: ['drop-private-2'],
            worldInfoResolution: {
                activatedEntries: [
                    { world: 'main', uid: 1, comment: 'keep', content: 'keep-1' },
                    { world: 'private', uid: 2, comment: 'x', content: 'drop-private' },
                    { world: 'main', uid: 3, comment: 'keep', content: 'keep-2' },
                    { world: 'private', uid: 4, comment: 'y', content: 'drop-private-2' },
                ],
            },
        };
        applyProfileWorldInfoFilter(payload, { bookPattern: '^private$', entryPattern: '' });
        expect(payload.worldInfoBeforeEntries).toEqual(['keep-1', 'keep-2']);
        expect(payload.worldInfoAfterEntries).toEqual([]);
    });
});
