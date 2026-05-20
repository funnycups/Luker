import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../../public/scripts/lib/edits/engine.js';
import { createSetOp } from '../../../public/scripts/lib/edits/ops/set.js';
import { createUnsetOp } from '../../../public/scripts/lib/edits/ops/unset.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

function makeEngine() {
    const engine = createEngine(deps);
    engine.registerOp('set', createSetOp());
    engine.registerOp('unset', createUnsetOp());
    return engine;
}

describe('unset op — apply', () => {
    test('removes a top-level field (key gone, not just undefined)', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'unset', path: 'temp', expected_value: 'discard_me' }],
            { keep: 1, temp: 'discard_me' },
        );
        expect(result.newLive).toEqual({ keep: 1 });
        expect(Object.hasOwn(result.newLive, 'temp')).toBe(false);
    });

    test('removes a nested field', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'unset', path: 'a.b.c' }],
            { a: { b: { c: 1, d: 2 } } },
        );
        expect(result.newLive).toEqual({ a: { b: { d: 2 } } });
    });
});

describe('unset op — drift detection', () => {
    test('value_drifted when expected_value mismatches current', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'unset', path: 'temp', expected_value: 'old' }],
            { temp: 'externally_changed' },
        );
        expect(result.clean).toEqual([]);
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('value_drifted');
    });

    test('already_done when path is already absent', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'unset', path: 'missing' }],
            { keep: 1 },
        );
        expect(result.alreadyDone.length).toBe(1);
        expect(result.newLive).toEqual({ keep: 1 });
    });

    test('clean apply when expected_value omitted (no anchor check)', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'unset', path: 'temp' }],
            { temp: 'anything' },
        );
        expect(result.clean.length).toBe(1);
    });
});

describe('unset op — inverse', () => {
    test('inverse is a set restoring expected_value', () => {
        const engine = makeEngine();
        const inv = engine.inverseEdit({
            op: 'unset', path: 'temp', expected_value: 'saved',
        });
        expect(inv).toEqual({
            op: 'set', path: 'temp', oldValue: undefined, newValue: 'saved',
        });
    });

    test('round-trip: unset then re-set restores the original', () => {
        const engine = makeEngine();
        const original = { temp: 'preserved', keep: 1 };
        const r1 = engine.applyEdits(
            [{ op: 'unset', path: 'temp', expected_value: 'preserved' }],
            original,
        );
        expect(Object.hasOwn(r1.newLive, 'temp')).toBe(false);
        const inv = engine.inverseEdit({
            op: 'unset', path: 'temp', expected_value: 'preserved',
        });
        const r2 = engine.applyEdits([inv], r1.newLive);
        expect(r2.newLive).toEqual(original);
    });
});
