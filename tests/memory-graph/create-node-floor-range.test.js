/**
 * Verifies that the data-layer `createNode` primitive accepts an optional
 * `floorRange = { start, end }` payload and stores it on the node when valid.
 *
 * Validation rules:
 *   - Both bounds must already be typed `number` (no silent coercion of
 *     null, '', true, [5], or numeric strings).
 *   - Both bounds must be finite.
 *   - start >= 0, end >= start.
 *   - Fractional inputs are floored.
 *   - Anything else is silently omitted.
 *
 * Schema-awareness lives in callers (A3) — `createNode` mechanically records
 * what's passed and does not check the node-type schema.
 *
 * main.js transitively pulls script.js / lib.js / popup.js etc. at module
 * load. The shared mock stack at `./_mocks/main-module-stack.js` registers
 * the jest.unstable_mockModule calls at import time so main.js loads under
 * jest. That side-effect import MUST come before any SUT import.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import './_mocks/main-module-stack.js';

// ---- SUT imports ----
let createEmptyStore;
let createNode;

beforeAll(async () => {
    const persistence = await import('../../public/scripts/extensions/memory-graph/persistence.js');
    createEmptyStore = persistence.createEmptyStore;
    const main = await import('../../public/scripts/extensions/memory-graph/main.js');
    createNode = main._createNodeForTest;
});

describe('createNode: floorRange', () => {
    test('writes floorRange when passed valid {start, end}', () => {
        const store = createEmptyStore();
        const node = createNode(store, {
            type: 'event', title: 'T', seqTo: 10,
            floorRange: { start: 5, end: 10 },
        });
        expect(node.floorRange).toEqual({ start: 5, end: 10 });
    });

    test('omits floorRange when not passed', () => {
        const store = createEmptyStore();
        const node = createNode(store, { type: 'event', title: 'T', seqTo: 10 });
        expect(node.floorRange).toBeUndefined();
    });

    test('ignores floorRange with non-numeric start or end', () => {
        const store = createEmptyStore();
        const a = createNode(store, { type: 'event', title: 'A', seqTo: 10, floorRange: { start: 'x', end: 10 } });
        const b = createNode(store, { type: 'event', title: 'B', seqTo: 10, floorRange: { start: 5, end: 'y' } });
        expect(a.floorRange).toBeUndefined();
        expect(b.floorRange).toBeUndefined();
    });

    test('ignores floorRange with numeric-string bounds (no silent coercion)', () => {
        const store = createEmptyStore();
        // Number('5') === 5 is finite, but the input wasn't already typed
        // `number`, so we refuse to coerce. Same for the other shapes below.
        const numericString = createNode(store, {
            type: 'event', title: 'N', seqTo: 10,
            floorRange: { start: '5', end: '10' },
        });
        expect(numericString.floorRange).toBeUndefined();
    });

    test('ignores floorRange with null bound', () => {
        const store = createEmptyStore();
        // Number(null) === 0 silently — we must NOT accept this.
        const node = createNode(store, {
            type: 'event', title: 'T', seqTo: 10,
            floorRange: { start: null, end: 10 },
        });
        expect(node.floorRange).toBeUndefined();
    });

    test('ignores floorRange with empty-string bound', () => {
        const store = createEmptyStore();
        // Number('') === 0 silently — we must NOT accept this.
        const node = createNode(store, {
            type: 'event', title: 'T', seqTo: 10,
            floorRange: { start: '', end: 10 },
        });
        expect(node.floorRange).toBeUndefined();
    });

    test('ignores floorRange with boolean bound', () => {
        const store = createEmptyStore();
        // Number(true) === 1 silently — we must NOT accept this.
        const node = createNode(store, {
            type: 'event', title: 'T', seqTo: 10,
            floorRange: { start: true, end: 10 },
        });
        expect(node.floorRange).toBeUndefined();
    });

    test('ignores floorRange with single-element-array bound', () => {
        const store = createEmptyStore();
        // Number([5]) === 5 silently — we must NOT accept this.
        const node = createNode(store, {
            type: 'event', title: 'T', seqTo: 10,
            floorRange: { start: [5], end: 10 },
        });
        expect(node.floorRange).toBeUndefined();
    });

    test('ignores floorRange with inverted bounds (start > end)', () => {
        const store = createEmptyStore();
        const node = createNode(store, {
            type: 'event', title: 'T', seqTo: 10,
            floorRange: { start: 12, end: 10 },
        });
        expect(node.floorRange).toBeUndefined();
    });

    test('ignores floorRange with negative start', () => {
        const store = createEmptyStore();
        const node = createNode(store, {
            type: 'event', title: 'T', seqTo: 10,
            floorRange: { start: -1, end: 10 },
        });
        expect(node.floorRange).toBeUndefined();
    });

    test('accepts equal start and end (single-floor event)', () => {
        const store = createEmptyStore();
        const node = createNode(store, {
            type: 'event', title: 'T', seqTo: 7,
            floorRange: { start: 7, end: 7 },
        });
        expect(node.floorRange).toEqual({ start: 7, end: 7 });
    });

    test('floors fractional bounds', () => {
        const store = createEmptyStore();
        const node = createNode(store, {
            type: 'event', title: 'T', seqTo: 10,
            floorRange: { start: 5.7, end: 10.3 },
        });
        expect(node.floorRange).toEqual({ start: 5, end: 10 });
    });
});
