import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../../public/scripts/lib/edits/engine.js';
import { createStrDeleteOp } from '../../../public/scripts/lib/edits/ops/str-delete.js';
import { createStrInsertOp } from '../../../public/scripts/lib/edits/ops/str-insert.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

function makeEngine() {
    const engine = createEngine(deps);
    engine.registerOp('str_delete', createStrDeleteOp());
    engine.registerOp('str_insert', createStrInsertOp());
    return engine;
}

describe('str_delete op — apply', () => {
    test('deletes unique find text', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_delete', path: 'text', find: 'BAR' }],
            { text: 'fooBARbaz' },
        );
        expect(result.newLive.text).toBe('foobaz');
    });
});

describe('str_delete op — drift detection', () => {
    test('anchor_missing when find not present', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_delete', path: 'text', find: 'missing' }],
            { text: 'no match' },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('anchor_missing');
    });

    test('anchor_ambiguous when find appears multiple times', () => {
        const engine = makeEngine();
        const result = engine.applyEdits(
            [{ op: 'str_delete', path: 'text', find: 'foo' }],
            { text: 'foo bar foo' },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('anchor_ambiguous');
    });
});

describe('str_delete op — inverse', () => {
    test('inverse re-inserts the deleted text using surrounding context', () => {
        // For inverse, str_delete needs to know WHERE the deletion happened
        // so the inverse str_insert can find a unique anchor. The op captures
        // the surrounding context at apply time and stores it on the edit
        // copy carried into appliedEdits. (Consumers should call applyEdits
        // and read result.clean to get the augmented edits with context.)
        const engine = makeEngine();
        const r1 = engine.applyEdits(
            [{ op: 'str_delete', path: 'text', find: 'BAR' }],
            { text: 'fooBARbaz' },
        );
        // The clean array carries back the augmented edit with _anchor_context.
        const applied = r1.clean[0];
        const inv = engine.inverseEdit(applied);
        const r2 = engine.applyEdits([inv], r1.newLive);
        expect(r2.newLive.text).toBe('fooBARbaz');
    });
});
