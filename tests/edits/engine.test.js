import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../public/scripts/lib/edits/engine.js';

const deps = {
    get: lodash.get,
    set: lodash.set,
    unset: lodash.unset,
    isEqual: lodash.isEqual,
    cloneDeep: lodash.cloneDeep,
};

describe('engine.applyEdits — empty input', () => {
    test('returns the live as-is when given empty edits', () => {
        const engine = createEngine(deps);
        const live = { a: { b: 1 } };
        const result = engine.applyEdits([], live);

        expect(result.newLive).toEqual({ a: { b: 1 } });
        expect(result.newLive).not.toBe(live);                  // cloned, not same ref
        expect(result.clean).toEqual([]);
        expect(result.conflicts).toEqual([]);
        expect(result.alreadyDone).toEqual([]);
    });

    test('throws when given non-array edits', () => {
        const engine = createEngine(deps);
        expect(() => engine.applyEdits(null, {})).toThrow(/edits must be an array/);
    });

    test('throws when given an unknown op type', () => {
        const engine = createEngine(deps);
        expect(() => engine.applyEdits([{ op: 'mystery' }], {}))
            .toThrow(/unknown op: mystery/);
    });
});

describe('engine.registerOp', () => {
    test('registerOp + getRegisteredOp round-trip', () => {
        const engine = createEngine(deps);
        const handler = { apply: () => {}, inverse: () => ({}), detectConflict: () => null };
        engine.registerOp('foo', handler);
        expect(engine.getRegisteredOp('foo')).toBe(handler);
    });

    test('listRegisteredOps returns sorted names', () => {
        const engine = createEngine(deps);
        engine.registerOp('zebra', { apply: () => {}, inverse: () => ({}), detectConflict: () => null });
        engine.registerOp('alpha', { apply: () => {}, inverse: () => ({}), detectConflict: () => null });
        expect(engine.listRegisteredOps()).toEqual(['alpha', 'zebra']);
    });

    test('rejects registration without all three required callbacks', () => {
        const engine = createEngine(deps);
        expect(() => engine.registerOp('bad', { apply: () => {} }))
            .toThrow(/missing required callback: inverse/);
    });

    test('rejects double-registration of the same name', () => {
        const engine = createEngine(deps);
        const handler = { apply: () => {}, inverse: () => ({}), detectConflict: () => null };
        engine.registerOp('once', handler);
        expect(() => engine.registerOp('once', handler))
            .toThrow(/already registered: once/);
    });
});
