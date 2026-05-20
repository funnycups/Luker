import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../public/scripts/lib/edits/engine.js';
import { createSetOp } from '../../public/scripts/lib/edits/ops/set.js';
import { createUnsetOp } from '../../public/scripts/lib/edits/ops/unset.js';
import { createStrReplaceOp } from '../../public/scripts/lib/edits/ops/str-replace.js';
import { createStrInsertOp } from '../../public/scripts/lib/edits/ops/str-insert.js';
import { createStrDeleteOp } from '../../public/scripts/lib/edits/ops/str-delete.js';
import { createListInsertOp } from '../../public/scripts/lib/edits/ops/list-insert.js';
import { createListRemoveOp } from '../../public/scripts/lib/edits/ops/list-remove.js';
import { createListMoveOp } from '../../public/scripts/lib/edits/ops/list-move.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

function fullEngine() {
    const e = createEngine(deps);
    e.registerOp('set',          createSetOp());
    e.registerOp('unset',        createUnsetOp());
    e.registerOp('str_replace',  createStrReplaceOp());
    e.registerOp('str_insert',   createStrInsertOp());
    e.registerOp('str_delete',   createStrDeleteOp());
    e.registerOp('list_insert',  createListInsertOp());
    e.registerOp('list_remove',  createListRemoveOp());
    e.registerOp('list_move',    createListMoveOp());
    return e;
}

describe('full apply → inverse → apply round-trip across all built-in ops', () => {
    test('mixed edits round-trip restores original', () => {
        const engine = fullEngine();
        const original = {
            name: 'old',
            text: 'hello world',
            items: ['A', 'B', 'C'],
            temp: 'discard',
        };

        const edits = [
            { op: 'set',         path: 'name', oldValue: 'old', newValue: 'new' },
            { op: 'str_replace', path: 'text', find: 'world', replace: 'PLANET' },
            { op: 'list_insert', path: 'items', anchor: { after_index: 0 }, value: 'A2' },
            { op: 'unset',       path: 'temp', expected_value: 'discard' },
        ];

        const r1 = engine.applyEdits(edits, original);
        expect(r1.conflicts).toEqual([]);

        // Inverse the applied edits in reverse order
        const inverses = r1.clean.slice().reverse().map(edit => engine.inverseEdit(edit));
        const r2 = engine.applyEdits(inverses, r1.newLive);
        expect(r2.conflicts).toEqual([]);
        expect(r2.newLive).toEqual(original);
    });
});

describe('conflict isolation: clean edits apply while conflicting ones surface', () => {
    test('two clean + one conflict → live reflects the two clean', () => {
        const engine = fullEngine();
        const result = engine.applyEdits(
            [
                { op: 'set', path: 'a', oldValue: 1, newValue: 10 },
                { op: 'set', path: 'b', oldValue: 2, newValue: 20 },  // drift!
                { op: 'set', path: 'c', oldValue: 3, newValue: 30 },
            ],
            { a: 1, b: 999, c: 3 },
        );
        expect(result.clean.length).toBe(2);
        expect(result.conflicts.length).toBe(1);
        expect(result.newLive.a).toBe(10);
        expect(result.newLive.b).toBe(999);     // unchanged due to conflict
        expect(result.newLive.c).toBe(30);
    });
});
