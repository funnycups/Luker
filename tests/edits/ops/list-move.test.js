import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../../public/scripts/lib/edits/engine.js';
import { createListMoveOp } from '../../../public/scripts/lib/edits/ops/list-move.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

function makeEngine() {
    const engine = createEngine(deps);
    engine.registerOp('list_move', createListMoveOp());
    return engine;
}

describe('list_move op — apply', () => {
    test('moves forward', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_move', path: 'items', from_index: 0, to_index: 2 }],
            { items: ['A', 'B', 'C', 'D'] },
        );
        expect(result.newLive.items).toEqual(['B', 'C', 'A', 'D']);
    });

    test('moves backward', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_move', path: 'items', from_index: 3, to_index: 1 }],
            { items: ['A', 'B', 'C', 'D'] },
        );
        expect(result.newLive.items).toEqual(['A', 'D', 'B', 'C']);
    });

    test('no-op when from === to', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_move', path: 'items', from_index: 1, to_index: 1 }],
            { items: ['A', 'B'] },
        );
        expect(result.alreadyDone.length).toBe(1);
    });
});

describe('list_move op — drift detection', () => {
    test('value_drifted when from out of bounds', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'list_move', path: 'items', from_index: 99, to_index: 0 }],
            { items: ['A', 'B'] },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('value_drifted');
    });

    test('value_drifted when expected_value at from_index does not match', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{
                op: 'list_move', path: 'items',
                from_index: 0, to_index: 1, expected_value: 'A',
            }],
            { items: ['Z', 'B'] },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('value_drifted');
    });
});

describe('list_move op — inverse', () => {
    test('inverse swaps from and to', () => {
        const engine = makeEngine();
        const inv = engine.inverseEdit(
            { op: 'list_move', path: 'items', from_index: 0, to_index: 2, expected_value: 'A' },
        );
        expect(inv).toEqual({
            op: 'list_move', path: 'items',
            from_index: 2, to_index: 0, expected_value: 'A',
        });
    });

    test('round-trip', () => {
        const engine = makeEngine();
        const r1 = engine.applyEdits(
            [{ op: 'list_move', path: 'items', from_index: 0, to_index: 2 }],
            { items: ['A', 'B', 'C', 'D'] },
        );
        const inv = engine.inverseEdit({
            op: 'list_move', path: 'items', from_index: 0, to_index: 2,
        });
        const r2 = engine.applyEdits([inv], r1.newLive);
        expect(r2.newLive.items).toEqual(['A', 'B', 'C', 'D']);
    });
});
