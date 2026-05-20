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

describe('CPA IDE-mode apply — happy path (no conflict)', () => {
    test('clean apply: live updated, appliedEdits stashed on source message', () => {
        const engine = makeEngine();
        const live = { name: 'old', prompts: [{ content: 'hello world' }] };
        const draft = {
            edits: [
                { op: 'set', path: 'name', oldValue: 'old', newValue: 'new' },
                { op: 'str_replace', path: 'prompts[0].content', find: 'world', replace: 'PLANET' },
            ],
        };
        const sourceMessage = { id: 'm1', role: 'assistant', text: 'changes proposed' };

        // Simulate the CPA handleApplyDraft logic
        const result = engine.applyEdits(draft.edits, live);
        expect(result.conflicts).toEqual([]);
        sourceMessage.appliedEdits = result.clean;

        expect(result.newLive.name).toBe('new');
        expect(result.newLive.prompts[0].content).toBe('hello PLANET');
        expect(sourceMessage.appliedEdits.length).toBe(2);
    });
});
