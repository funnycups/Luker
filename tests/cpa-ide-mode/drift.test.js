import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../public/scripts/lib/edits/engine.js';
import { createSetOp } from '../../public/scripts/lib/edits/ops/set.js';
import { createStrReplaceOp } from '../../public/scripts/lib/edits/ops/str-replace.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

function makeEngine() {
    const e = createEngine(deps);
    e.registerOp('set', createSetOp());
    e.registerOp('str_replace', createStrReplaceOp());
    return e;
}

describe('CPA IDE-mode — external drift handling', () => {
    test('drift on unrelated path: apply succeeds, untouched fields preserved', () => {
        const engine = makeEngine();
        const beforeApply = { name: 'old', external: 'untouched' };
        // External code modifies `external` between AI propose and user apply
        const liveAfterExternalEdit = { name: 'old', external: 'CHANGED BY USER' };

        const draft = [{ op: 'set', path: 'name', oldValue: 'old', newValue: 'new' }];

        const result = engine.applyEdits(draft, liveAfterExternalEdit);
        expect(result.conflicts).toEqual([]);
        expect(result.newLive).toEqual({ name: 'new', external: 'CHANGED BY USER' });
    });

    test('drift on the same path: apply surfaces conflict, live preserved', () => {
        const engine = makeEngine();
        const liveAfterExternalEdit = { name: 'externally_changed' };

        const draft = [{ op: 'set', path: 'name', oldValue: 'old', newValue: 'new' }];

        const result = engine.applyEdits(draft, liveAfterExternalEdit);
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('value_drifted');
        expect(result.newLive).toEqual({ name: 'externally_changed' });   // unchanged
    });

    test('str_replace drift: anchor still findable → clean apply', () => {
        const engine = makeEngine();
        // External edit added text before AND after our target
        const liveAfterExternalEdit = { prompts: [{ content: 'PREFIX hello world SUFFIX' }] };

        const draft = [{
            op: 'str_replace',
            path: 'prompts[0].content',
            find: 'world',
            replace: 'PLANET',
        }];

        const result = engine.applyEdits(draft, liveAfterExternalEdit);
        expect(result.conflicts).toEqual([]);
        expect(result.newLive.prompts[0].content).toBe('PREFIX hello PLANET SUFFIX');
    });

    test('str_replace drift: anchor erased externally → conflict', () => {
        const engine = makeEngine();
        const liveAfterExternalEdit = { prompts: [{ content: 'totally different' }] };

        const draft = [{
            op: 'str_replace',
            path: 'prompts[0].content',
            find: 'world',
            replace: 'PLANET',
        }];

        const result = engine.applyEdits(draft, liveAfterExternalEdit);
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('anchor_missing');
    });
});
