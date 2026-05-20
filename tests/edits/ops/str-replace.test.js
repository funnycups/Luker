import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../../public/scripts/lib/edits/engine.js';
import { createStrReplaceOp } from '../../../public/scripts/lib/edits/ops/str-replace.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

function makeEngine() {
    const engine = createEngine(deps);
    engine.registerOp('str_replace', createStrReplaceOp());
    return engine;
}

describe('str_replace op — apply', () => {
    test('replaces a unique substring', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_replace', path: 'text', find: 'foo', replace: 'BAR' }],
            { text: 'hello foo world' },
        );
        expect(result.newLive.text).toBe('hello BAR world');
        expect(result.clean.length).toBe(1);
    });

    test('replaces all occurrences when expected_count matches', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_replace', path: 'text', find: 'x', replace: 'Y', expected_count: 3 }],
            { text: 'x-x-x' },
        );
        expect(result.newLive.text).toBe('Y-Y-Y');
    });

    test('handles regex-special characters literally', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_replace', path: 'text', find: 'a.b', replace: 'a_b' }],
            { text: 'foo a.b bar' },
        );
        expect(result.newLive.text).toBe('foo a_b bar');
    });
});

describe('str_replace op — drift detection', () => {
    test('anchor_missing when find not in string', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_replace', path: 'text', find: 'gone', replace: 'X' }],
            { text: 'no match here' },
        );
        expect(result.clean).toEqual([]);
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('anchor_missing');
    });

    test('anchor_ambiguous when find appears multiple times and expected_count is unset', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_replace', path: 'text', find: 'foo', replace: 'X' }],
            { text: 'foo foo foo' },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('anchor_ambiguous');
        expect(result.conflicts[0].current).toBe(3);     // actual count
    });

    test('count mismatch when expected_count differs from actual', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_replace', path: 'text', find: 'foo', replace: 'X', expected_count: 5 }],
            { text: 'foo foo foo' },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('anchor_ambiguous');
    });

    test('value_drifted when path holds non-string', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_replace', path: 'n', find: 'a', replace: 'b' }],
            { n: 42 },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('value_drifted');
    });
});

describe('str_replace op — inverse', () => {
    test('inverse swaps find and replace', () => {
        const engine = makeEngine();
        const inv = engine.inverseEdit(
            { op: 'str_replace', path: 't', find: 'A', replace: 'B' },
        );
        expect(inv).toMatchObject({ op: 'str_replace', path: 't', find: 'B', replace: 'A' });
    });

    test('round-trip', () => {
        const engine = makeEngine();
        const edit = { op: 'str_replace', path: 't', find: 'cat', replace: 'dog' };
        const r1 = engine.applyEdits([edit], { t: 'a cat is here' });
        const r2 = engine.applyEdits([engine.inverseEdit(edit)], r1.newLive);
        expect(r2.newLive).toEqual({ t: 'a cat is here' });
    });
});
