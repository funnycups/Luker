/**
 * Tests for memory-graph external-api.
 *
 * Covers the injection-observation surface exposed to other extensions:
 * the snapshot of currently-injected node id sets and the change-listener
 * subscription. Richer read access lives in `read-api.js`; see
 * `tests/memory-graph/read-api.test.js`.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

import {
    getCurrentlyInjectedNodeIds,
    __recordInjectedNodeIds,
    __setInjectedForTest,
    __resetInjectedForTest,
} from '../../public/scripts/extensions/memory-graph/external-api.js';

describe('getCurrentlyInjectedNodeIds', () => {
    beforeEach(() => {
        __resetInjectedForTest();
    });

    test('returns empty sets when no injection has happened', () => {
        const result = getCurrentlyInjectedNodeIds({});
        expect(result.alwaysInjectIds).toBeInstanceOf(Set);
        expect(result.recallSelectedIds).toBeInstanceOf(Set);
        expect(result.alwaysInjectIds.size).toBe(0);
        expect(result.recallSelectedIds.size).toBe(0);
    });

    test('returns the recorded alwaysInject and recall sets', () => {
        __setInjectedForTest({
            alwaysInjectIds: new Set(['a1', 'a2']),
            recallSelectedIds: new Set(['r1']),
        });
        const result = getCurrentlyInjectedNodeIds({});
        expect(Array.from(result.alwaysInjectIds).sort()).toEqual(['a1', 'a2']);
        expect(Array.from(result.recallSelectedIds)).toEqual(['r1']);
    });

    test('returned sets are defensive copies (mutating result does not change state)', () => {
        __setInjectedForTest({
            alwaysInjectIds: new Set(['a1']),
            recallSelectedIds: new Set(['r1']),
        });
        const r1 = getCurrentlyInjectedNodeIds({});
        r1.alwaysInjectIds.add('mutated');
        r1.recallSelectedIds.add('mutated');
        const r2 = getCurrentlyInjectedNodeIds({});
        expect(r2.alwaysInjectIds.has('mutated')).toBe(false);
        expect(r2.recallSelectedIds.has('mutated')).toBe(false);
    });

    test('__recordInjectedNodeIds accepts iterables and missing fields', () => {
        __recordInjectedNodeIds({ alwaysInjectIds: ['a1', 'a2'], recallSelectedIds: ['r1'] });
        const r = getCurrentlyInjectedNodeIds({});
        expect(Array.from(r.alwaysInjectIds).sort()).toEqual(['a1', 'a2']);

        __recordInjectedNodeIds({}); // both missing -> empty sets
        const r2 = getCurrentlyInjectedNodeIds({});
        expect(r2.alwaysInjectIds.size).toBe(0);
        expect(r2.recallSelectedIds.size).toBe(0);
    });
});
