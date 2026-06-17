/**
 * Verifies that `createRollupWithChildren` (hierarchical compaction) rolls
 * up child `floorRange` anchors into the parent.
 *
 * Contract:
 *   - When at least one child has a valid `floorRange = {start, end}`, the
 *     parent gets `floorRange = { start: min(child.start), end: max(child.end) }`.
 *   - Children without a floorRange are SKIPPED, not treated as a veto
 *     ("partial coverage" policy — legacy children pre-dating A3 must not
 *     kill the floor anchor on their rolled-up parent).
 *   - When NO child has a floorRange, the parent has no floorRange field.
 *
 * Forward note: write-api.js::compactNodes delegates to this same function,
 * so the agent-driven compaction path picks up the rollup union for free.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import './_mocks/main-module-stack.js';

let createEmptyStore;
let applyExtractionOpsImpl;
let createRollupWithChildren;
let getDefaultNodeTypeSchema;

beforeAll(async () => {
    const persistence = await import('../../public/scripts/extensions/memory-graph/persistence.js');
    createEmptyStore = persistence.createEmptyStore;
    const main = await import('../../public/scripts/extensions/memory-graph/main.js');
    applyExtractionOpsImpl = main.applyExtractionOpsImpl;
    createRollupWithChildren = main._createRollupWithChildrenForTest;
    getDefaultNodeTypeSchema = main.getDefaultNodeTypeSchema;
});

function settingsWithDefaultSchema() {
    return { nodeTypeSchema: getDefaultNodeTypeSchema() };
}

function makeEvent(store, summary, minSeq, maxSeq) {
    applyExtractionOpsImpl(store, [{
        op: 'create', type: 'event', fields: { summary },
    }], { maxSeq, minSeq, settings: settingsWithDefaultSchema() });
    const all = Object.values(store.nodes).filter(n => n.type === 'event');
    return all[all.length - 1];
}

describe('rollup floor-range union', () => {
    test('parent.floorRange unions child ranges when all children have them', () => {
        const store = createEmptyStore();
        const c1 = makeEvent(store, 'a', 5, 10);
        const c2 = makeEvent(store, 'b', 11, 14);
        const c3 = makeEvent(store, 'c', 15, 20);
        const parent = createRollupWithChildren(store, {
            type: 'event', childIds: [c1.id, c2.id, c3.id], summary: 'rolled', label: 'event',
        });
        expect(parent.floorRange).toEqual({ start: 5, end: 20 });
    });

    test('parent.floorRange covers only children that have a range (skipping legacy)', () => {
        const store = createEmptyStore();
        const c1 = makeEvent(store, 'a', 5, 10);
        const c2 = makeEvent(store, 'b', 11, 14);
        // simulate legacy child without floorRange (the middle one)
        delete c2.floorRange;
        const c3 = makeEvent(store, 'c', 15, 20);
        const parent = createRollupWithChildren(store, {
            type: 'event', childIds: [c1.id, c2.id, c3.id], summary: 'rolled', label: 'event',
        });
        expect(parent.floorRange).toEqual({ start: 5, end: 20 });
    });

    test('parent has no floorRange when no child has one', () => {
        const store = createEmptyStore();
        const c1 = makeEvent(store, 'a', 5, 10); delete c1.floorRange;
        const c2 = makeEvent(store, 'b', 11, 14); delete c2.floorRange;
        const parent = createRollupWithChildren(store, {
            type: 'event', childIds: [c1.id, c2.id], summary: 'rolled', label: 'event',
        });
        expect(parent.floorRange).toBeUndefined();
    });

    test('out-of-order children still produce min/max correctly', () => {
        const store = createEmptyStore();
        // Pass children to rollup in non-monotonic order to make sure the
        // implementation uses min/max, not first/last.
        const c1 = makeEvent(store, 'a', 30, 35);
        const c2 = makeEvent(store, 'b', 5, 10);
        const c3 = makeEvent(store, 'c', 20, 25);
        const parent = createRollupWithChildren(store, {
            type: 'event', childIds: [c1.id, c2.id, c3.id], summary: 'rolled', label: 'event',
        });
        expect(parent.floorRange).toEqual({ start: 5, end: 35 });
    });

    test('single child range is preserved verbatim', () => {
        const store = createEmptyStore();
        const c1 = makeEvent(store, 'a', 5, 10);
        const parent = createRollupWithChildren(store, {
            type: 'event', childIds: [c1.id], summary: 'rolled', label: 'event',
        });
        expect(parent.floorRange).toEqual({ start: 5, end: 10 });
    });
});
