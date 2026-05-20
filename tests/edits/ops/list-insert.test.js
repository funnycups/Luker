import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../../public/scripts/lib/edits/engine.js';
import { createListInsertOp } from '../../../public/scripts/lib/edits/ops/list-insert.js';
import { createListRemoveOp } from '../../../public/scripts/lib/edits/ops/list-remove.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

function makeEngine() {
    const engine = createEngine(deps);
    engine.registerOp('list_insert', createListInsertOp());
    engine.registerOp('list_remove', createListRemoveOp());
    return engine;
}

describe('list_insert op — apply', () => {
    test('inserts at end via after_index=last', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_insert', path: 'items', anchor: { after_index: 2 }, value: 'D' }],
            { items: ['A', 'B', 'C'] },
        );
        expect(result.newLive.items).toEqual(['A', 'B', 'C', 'D']);
    });

    test('inserts at beginning via before_index=0', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_insert', path: 'items', anchor: { before_index: 0 }, value: 'Z' }],
            { items: ['A', 'B'] },
        );
        expect(result.newLive.items).toEqual(['Z', 'A', 'B']);
    });

    test('inserts after a specific anchor_value', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_insert', path: 'items', anchor: { after_value: 'A' }, value: 'A2' }],
            { items: ['A', 'B', 'C'] },
        );
        expect(result.newLive.items).toEqual(['A', 'A2', 'B', 'C']);
    });
});

describe('list_insert op — drift detection', () => {
    test('value_drifted when path is not an array', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_insert', path: 'x', anchor: { after_index: 0 }, value: 'V' }],
            { x: 'string' },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('value_drifted');
    });

    test('anchor_missing when after_value not found', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_insert', path: 'items', anchor: { after_value: 'GONE' }, value: 'V' }],
            { items: ['A', 'B'] },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('anchor_missing');
    });

    test('anchor_ambiguous when after_value appears multiple times', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_insert', path: 'items', anchor: { after_value: 'A' }, value: 'V' }],
            { items: ['A', 'B', 'A'] },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('anchor_ambiguous');
    });
});

describe('list_insert op — inverse', () => {
    test('inverse is list_remove at the inserted index with expected_value', () => {
        const engine = makeEngine();
        const r1 = engine.applyEdits(
            [{ op: 'list_insert', path: 'items', anchor: { after_index: 1 }, value: 'NEW' }],
            { items: ['A', 'B', 'C'] },
        );
        const applied = r1.clean[0];
        const inv = engine.inverseEdit(applied);
        expect(inv).toEqual({
            op: 'list_remove',
            path: 'items',
            index: 2,
            expected_value: 'NEW',
        });
    });
});
