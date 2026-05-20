import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../../public/scripts/lib/edits/engine.js';
import { createStrInsertOp } from '../../../public/scripts/lib/edits/ops/str-insert.js';
import { createStrDeleteOp } from '../../../public/scripts/lib/edits/ops/str-delete.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

function makeEngine() {
    const engine = createEngine(deps);
    engine.registerOp('str_insert', createStrInsertOp());
    engine.registerOp('str_delete', createStrDeleteOp());
    return engine;
}

describe('str_insert op — apply', () => {
    test('inserts after a unique anchor', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_insert', path: 'text', after_text: 'hello', insert_text: ' world' }],
            { text: 'hello' },
        );
        expect(result.newLive.text).toBe('hello world');
    });

    test('inserts into middle of string', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_insert', path: 'text', after_text: 'foo', insert_text: ' BAR' }],
            { text: 'foo end' },
        );
        expect(result.newLive.text).toBe('foo BAR end');
    });
});

describe('str_insert op — drift detection', () => {
    test('anchor_missing when after_text not in string', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_insert', path: 'text', after_text: 'missing', insert_text: 'X' }],
            { text: 'no match' },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('anchor_missing');
    });

    test('anchor_ambiguous when after_text appears multiple times', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_insert', path: 'text', after_text: 'foo', insert_text: 'X' }],
            { text: 'foo bar foo' },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('anchor_ambiguous');
    });
});

describe('str_insert op — inverse', () => {
    test('inverse is str_delete of inserted text (relative to anchor)', () => {
        const engine = makeEngine();
        const inv = engine.inverseEdit(
            { op: 'str_insert', path: 't', after_text: 'A', insert_text: 'B' },
        );
        expect(inv).toEqual({ op: 'str_delete', path: 't', find: 'B' });
    });

    // Round-trip is deferred to Task 7 (needs full str_delete impl).
});
