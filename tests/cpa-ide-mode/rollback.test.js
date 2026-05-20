import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../public/scripts/lib/edits/engine.js';
import { createSetOp } from '../../public/scripts/lib/edits/ops/set.js';
import { createStrReplaceOp } from '../../public/scripts/lib/edits/ops/str-replace.js';
import { createListInsertOp } from '../../public/scripts/lib/edits/ops/list-insert.js';
import { createListRemoveOp } from '../../public/scripts/lib/edits/ops/list-remove.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

function makeEngine() {
    const e = createEngine(deps);
    e.registerOp('set', createSetOp());
    e.registerOp('str_replace', createStrReplaceOp());
    e.registerOp('list_insert', createListInsertOp());
    e.registerOp('list_remove', createListRemoveOp());
    return e;
}

describe('CPA IDE-mode rollback — surgical inverse via appliedEdits', () => {
    test('two messages applied; rollback to first restores live to between-state', () => {
        const engine = makeEngine();
        const initial = { name: 'v0', items: ['A'] };

        // Message 1 applies one set
        const r1 = engine.applyEdits(
            [{ op: 'set', path: 'name', oldValue: 'v0', newValue: 'v1' }],
            initial,
        );
        const m1 = { id: 'm1', appliedEdits: r1.clean };

        // Message 2 applies another set + list_insert
        const r2 = engine.applyEdits(
            [
                { op: 'set', path: 'name', oldValue: 'v1', newValue: 'v2' },
                { op: 'list_insert', path: 'items', anchor: { after_index: 0 }, value: 'B' },
            ],
            r1.newLive,
        );
        const m2 = { id: 'm2', appliedEdits: r2.clean };

        // Now rollback to m2: undo m2's edits in reverse
        const inverses = [];
        for (let i = m2.appliedEdits.length - 1; i >= 0; i -= 1) {
            inverses.push(engine.inverseEdit(m2.appliedEdits[i]));
        }
        const r3 = engine.applyEdits(inverses, r2.newLive);
        expect(r3.conflicts).toEqual([]);
        expect(r3.newLive).toEqual({ name: 'v1', items: ['A'] });

        // Rollback further to m1 (undo m1's edits too)
        const inverses2 = [];
        for (let i = m1.appliedEdits.length - 1; i >= 0; i -= 1) {
            inverses2.push(engine.inverseEdit(m1.appliedEdits[i]));
        }
        const r4 = engine.applyEdits(inverses2, r3.newLive);
        expect(r4.newLive).toEqual(initial);
    });
});
