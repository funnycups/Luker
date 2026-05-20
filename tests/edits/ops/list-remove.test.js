import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../../public/scripts/lib/edits/engine.js';
import { createListRemoveOp } from '../../../public/scripts/lib/edits/ops/list-remove.js';
import { createListInsertOp } from '../../../public/scripts/lib/edits/ops/list-insert.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

function makeEngine() {
    const engine = createEngine(deps);
    engine.registerOp('list_remove', createListRemoveOp());
    engine.registerOp('list_insert', createListInsertOp());
    return engine;
}

describe('list_remove op — apply', () => {
    test('removes element at index', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_remove', path: 'items', index: 1, expected_value: 'B' }],
            { items: ['A', 'B', 'C'] },
        );
        expect(result.newLive.items).toEqual(['A', 'C']);
    });

    test('removes without expected_value (no anchor check)', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_remove', path: 'items', index: 0 }],
            { items: ['A', 'B'] },
        );
        expect(result.newLive.items).toEqual(['B']);
    });
});

describe('list_remove op — drift detection', () => {
    test('value_drifted when path is not an array', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_remove', path: 'x', index: 0 }],
            { x: 'not array' },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('value_drifted');
    });

    test('value_drifted when expected_value does not match', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_remove', path: 'items', index: 1, expected_value: 'B' }],
            { items: ['A', 'Z', 'C'] },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('value_drifted');
    });

    test('value_drifted when index out of bounds', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_remove', path: 'items', index: 99 }],
            { items: ['A', 'B'] },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('value_drifted');
    });
});

describe('list_remove op — inverse', () => {
    test('inverse is list_insert at the same position with the removed value', () => {
        const engine = makeEngine();
        const r1 = engine.applyEdits(
            [{ op: 'list_remove', path: 'items', index: 1, expected_value: 'B' }],
            { items: ['A', 'B', 'C'] },
        );
        const applied = r1.clean[0];
        const inv = engine.inverseEdit(applied);
        expect(inv.op).toBe('list_insert');
        expect(inv.value).toBe('B');
        expect(inv.anchor).toEqual({ before_index: 1 });
    });

    test('round-trip', () => {
        const engine = makeEngine();
        const original = { items: ['A', 'B', 'C'] };
        const r1 = engine.applyEdits(
            [{ op: 'list_remove', path: 'items', index: 1, expected_value: 'B' }],
            original,
        );
        const inv = engine.inverseEdit(r1.clean[0]);
        const r2 = engine.applyEdits([inv], r1.newLive);
        expect(r2.newLive.items).toEqual(['A', 'B', 'C']);
    });
});
