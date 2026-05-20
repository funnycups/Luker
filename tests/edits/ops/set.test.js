import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../../public/scripts/lib/edits/engine.js';
import { createSetOp } from '../../../public/scripts/lib/edits/ops/set.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

function makeEngine() {
    const engine = createEngine(deps);
    engine.registerOp('set', createSetOp());
    return engine;
}

describe('set op — apply', () => {
    test('sets a top-level field', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'set', path: 'name', oldValue: 'old', newValue: 'new' }],
            { name: 'old' },
        );
        expect(result.newLive).toEqual({ name: 'new' });
        expect(result.clean.length).toBe(1);
        expect(result.conflicts).toEqual([]);
    });

    test('sets a nested path, creating intermediate objects', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'set', path: 'a.b.c', oldValue: undefined, newValue: 42 }],
            {},
        );
        expect(result.newLive).toEqual({ a: { b: { c: 42 } } });
    });

    test('sets an array element by path', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'set', path: 'items[1]', oldValue: 'b', newValue: 'B' }],
            { items: ['a', 'b', 'c'] },
        );
        expect(result.newLive.items).toEqual(['a', 'B', 'c']);
    });
});

describe('set op — drift detection', () => {
    test('value_drifted when current is neither oldValue nor newValue', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'set', path: 'name', oldValue: 'old', newValue: 'new' }],
            { name: 'external_edit' },
        );
        expect(result.clean).toEqual([]);
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('value_drifted');
        expect(result.conflicts[0].baseline).toBe('old');
        expect(result.conflicts[0].current).toBe('external_edit');
    });

    test('alreadyDone when current already equals newValue', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'set', path: 'name', oldValue: 'old', newValue: 'new' }],
            { name: 'new' },
        );
        expect(result.clean).toEqual([]);
        expect(result.conflicts).toEqual([]);
        expect(result.alreadyDone.length).toBe(1);
    });

    test('clean apply when current equals oldValue (the normal case)', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'set', path: 'name', oldValue: 'old', newValue: 'new' }],
            { name: 'old' },
        );
        expect(result.clean.length).toBe(1);
    });

    test('deep-equality on oldValue (objects)', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'set', path: 'cfg', oldValue: { x: 1 }, newValue: { x: 2 } }],
            { cfg: { x: 1 } },
        );
        expect(result.clean.length).toBe(1);
        expect(result.newLive.cfg).toEqual({ x: 2 });
    });
});

describe('set op — inverse', () => {
    test('inverse swaps oldValue and newValue', () => {
        const engine = makeEngine();
        const inv = engine.inverseEdit(
            { op: 'set', path: 'name', oldValue: 'old', newValue: 'new' },
        );
        expect(inv).toEqual({
            op: 'set', path: 'name', oldValue: 'new', newValue: 'old',
        });
    });

    test('round-trip: apply then apply inverse returns original', () => {
        const engine = makeEngine();
        const edit = { op: 'set', path: 'name', oldValue: 'old', newValue: 'new' };

        const r1 = engine.applyEdits([edit], { name: 'old' });
        const r2 = engine.applyEdits([engine.inverseEdit(edit)], r1.newLive);
        expect(r2.newLive).toEqual({ name: 'old' });
    });
});
