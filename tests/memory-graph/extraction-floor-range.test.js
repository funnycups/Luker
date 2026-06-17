/**
 * Verifies that the extraction pipeline writes `floorRange = {start, end}`
 * onto newly created semantic nodes whose type-schema entry opts in via
 * `recordsFloorRange: true` (event by default), and leaves it absent for
 * types that don't opt in.
 *
 * Contract:
 *   - applyExtractionOpsImpl({ maxSeq, minSeq, settings }) propagates minSeq
 *     to upsertSemanticNode via the options bag.
 *   - upsertSemanticNode looks up the type's schema entry; if
 *     `recordsFloorRange` is true and a valid minSeq <= seqTo is in scope,
 *     it asks createNode to record floorRange.
 *   - Edits never touch an existing floorRange.
 *   - Defensive guards: missing minSeq, or minSeq > maxSeq, yield no
 *     floorRange (rather than a corrupt one).
 *   - Invariant: when written, floorRange.end equals the created node's
 *     seqTo (both are pinned to the extraction window's upper bound).
 *
 * Forward note: the LLM never sees or specifies floorRange — it is derived
 * by the builder from the extraction window passed in by the batch
 * processor (Change 1 in the task), which is what calls into here.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import './_mocks/main-module-stack.js';

let createEmptyStore;
let applyExtractionOpsImpl;
let getDefaultNodeTypeSchema;

beforeAll(async () => {
    const persistence = await import('../../public/scripts/extensions/memory-graph/persistence.js');
    createEmptyStore = persistence.createEmptyStore;
    const main = await import('../../public/scripts/extensions/memory-graph/main.js');
    applyExtractionOpsImpl = main.applyExtractionOpsImpl;
    getDefaultNodeTypeSchema = main.getDefaultNodeTypeSchema;
});

// Under jest, character-overrides.js' configure() is never called (it runs
// inside the jQuery(...) DOM-ready handler, which the test mock swallows).
// That leaves its `normalizeNodeTypeSchema` dep as an identity stub, so the
// schema-aware lookup pulls `settings.nodeTypeSchema` straight through —
// providing the full default schema explicitly is the cleanest fixture.
// The default schema sets `recordsFloorRange: true` on `event` only.
function settingsWithDefaultSchema() {
    return { nodeTypeSchema: getDefaultNodeTypeSchema() };
}

describe('extraction floor-range writes', () => {
    test('event-type create writes floorRange={minSeq, maxSeq}', () => {
        const store = createEmptyStore();
        const ops = [{
            op: 'create', type: 'event',
            fields: { summary: 'something happened' },
        }];
        applyExtractionOpsImpl(store, ops, {
            maxSeq: 17, minSeq: 12, settings: settingsWithDefaultSchema(),
        });
        const created = Object.values(store.nodes).find(n => n.type === 'event');
        expect(created).toBeDefined();
        expect(created.floorRange).toEqual({ start: 12, end: 17 });
        expect(created.seqTo).toBe(17);
    });

    test('non-event type (character_sheet) does NOT get floorRange under default schema', () => {
        const store = createEmptyStore();
        const ops = [{
            op: 'create', type: 'character_sheet', title: 'Alice',
            fields: { name: 'Alice' },
        }];
        applyExtractionOpsImpl(store, ops, {
            maxSeq: 17, minSeq: 12, settings: settingsWithDefaultSchema(),
        });
        const created = Object.values(store.nodes).find(n => n.type === 'character_sheet');
        expect(created).toBeDefined();
        expect(created.floorRange).toBeUndefined();
    });

    test('omitted minSeq produces a valid event node without floorRange (legacy / fresh call path)', () => {
        const store = createEmptyStore();
        const ops = [{ op: 'create', type: 'event', fields: { summary: 'x' } }];
        applyExtractionOpsImpl(store, ops, {
            maxSeq: 17, settings: settingsWithDefaultSchema(),
        });
        const created = Object.values(store.nodes).find(n => n.type === 'event');
        expect(created).toBeDefined();
        expect(created.seqTo).toBe(17);
        expect(created.floorRange).toBeUndefined();
    });

    test('edit op does not touch an existing floorRange', () => {
        const store = createEmptyStore();
        applyExtractionOpsImpl(store, [{
            op: 'create', type: 'event', fields: { summary: 'first' },
        }], { maxSeq: 10, minSeq: 5, settings: settingsWithDefaultSchema() });
        const created = Object.values(store.nodes).find(n => n.type === 'event');
        const originalRange = { ...created.floorRange };
        applyExtractionOpsImpl(store, [{
            op: 'edit', nodeId: created.id, type: 'event',
            setFields: { summary: 'updated' },
        }], { maxSeq: 20, minSeq: 15, settings: settingsWithDefaultSchema() });
        expect(created.floorRange).toEqual(originalRange);
    });

    test('invariant: floorRange.end equals created.seqTo', () => {
        const store = createEmptyStore();
        applyExtractionOpsImpl(store, [{
            op: 'create', type: 'event', fields: { summary: 'x' },
        }], { maxSeq: 42, minSeq: 30, settings: settingsWithDefaultSchema() });
        const created = Object.values(store.nodes).find(n => n.type === 'event');
        expect(created.floorRange.end).toBe(created.seqTo);
    });

    test('minSeq > maxSeq yields no floorRange (defensive; should not happen in practice)', () => {
        const store = createEmptyStore();
        applyExtractionOpsImpl(store, [{
            op: 'create', type: 'event', fields: { summary: 'x' },
        }], { maxSeq: 10, minSeq: 99, settings: settingsWithDefaultSchema() });
        const created = Object.values(store.nodes).find(n => n.type === 'event');
        expect(created.floorRange).toBeUndefined();
    });
});
