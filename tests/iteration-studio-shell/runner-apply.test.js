/**
 * Tests for runner.js editable apply path (Task 6).
 *
 * runner.js imports `../lib/edits/index.js` (which transitively loads the
 * browser-only `public/lib.js` bundle) and `../lib/edits/conflict-ui.js`
 * (which loads `popup.js`). We can't load those in Node, so we mock the
 * edits-lib entry point with a real engine instance built from the
 * pure ESM `engine.js` + npm `lodash` — exercising the actual applyEdits
 * / inverseEdit behavior, just routed around the browser bundle.
 *
 * `conflict-ui.js` is mocked to a no-op (these tests never trigger
 * conflicts, so the callback is never invoked).
 */

import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../public/scripts/lib/edits/engine.js';
import { createSetOp }         from '../../public/scripts/lib/edits/ops/set.js';
import { createUnsetOp }       from '../../public/scripts/lib/edits/ops/unset.js';
import { createStrReplaceOp }  from '../../public/scripts/lib/edits/ops/str-replace.js';
import { createStrInsertOp }   from '../../public/scripts/lib/edits/ops/str-insert.js';
import { createStrDeleteOp }   from '../../public/scripts/lib/edits/ops/str-delete.js';
import { createListInsertOp }  from '../../public/scripts/lib/edits/ops/list-insert.js';
import { createListRemoveOp }  from '../../public/scripts/lib/edits/ops/list-remove.js';
import { createListMoveOp }    from '../../public/scripts/lib/edits/ops/list-move.js';

const engine = createEngine({
    get:       lodash.get,
    set:       lodash.set,
    unset:     lodash.unset,
    isEqual:   lodash.isEqual,
    cloneDeep: lodash.cloneDeep,
});
engine.registerOp('set',          createSetOp());
engine.registerOp('unset',        createUnsetOp());
engine.registerOp('str_replace',  createStrReplaceOp());
engine.registerOp('str_insert',   createStrInsertOp());
engine.registerOp('str_delete',   createStrDeleteOp());
engine.registerOp('list_insert',  createListInsertOp());
engine.registerOp('list_remove',  createListRemoveOp());
engine.registerOp('list_move',    createListMoveOp());

jest.unstable_mockModule('../../public/scripts/lib/edits/index.js', () => ({
    applyEdits:  engine.applyEdits,
    inverseEdit: engine.inverseEdit,
}));

jest.unstable_mockModule('../../public/scripts/lib/edits/conflict-ui.js', () => ({
    showConflictResolution: jest.fn(async () => ({ resolutions: [], aborted: false })),
}));

jest.unstable_mockModule('../../public/scripts/iteration-studio/i18n.js', () => ({
    i18n: (k) => String(k || ''),
    i18nFormat: (k, ...args) => String(k) + ':' + args.join('|'),
}));

let createStubAdapter;
let executeToolCalls;

beforeAll(async () => {
    ({ createStubAdapter } = await import('./helpers/stub-adapter.js'));
    ({ executeToolCalls } = await import('../../public/scripts/iteration-studio/runner.js'));
});

describe('executeToolCalls (auto-apply)', () => {
    test('control-only turn records continue/finalize signals, no edits', async () => {
        const adapter = createStubAdapter({ a: 1 });
        const session = { id: 's', messages: [], pendingApproval: null, updatedAt: 0 };
        const result = await executeToolCalls(adapter, session, [
            { id: 'c1', name: 'iter_continue', args: { reason: 'more' } },
            { id: 'c2', name: 'iter_finalize', args: { summary: 'done' } },
        ], null);
        expect(result.continueRequested).toBe(true);
        expect(result.finalized).toBe(true);
        expect(result.finalizeSummary).toBe('done');
        expect(result.changed).toBe(false);
        expect(result.appliedEdits).toEqual([]);
        expect(adapter._state.commitHistory).toEqual([]);
    });

    test('editable set edit lands in live + appliedEdits', async () => {
        const adapter = createStubAdapter({ a: 1 });
        const session = { id: 's', messages: [], pendingApproval: null, updatedAt: 0 };
        const result = await executeToolCalls(adapter, session, [
            { id: 'e1', name: 'stub_set', args: { path: 'b', oldValue: undefined, newValue: 2 } },
        ], null);
        expect(result.changed).toBe(true);
        expect(result.appliedEdits).toHaveLength(1);
        expect(result.appliedEdits[0]).toMatchObject({ op: 'set', path: 'b', newValue: 2 });
        expect(adapter._state.commitHistory).toHaveLength(1);
        expect(adapter._state.commitHistory[0]).toEqual({ a: 1, b: 2 });
    });

    test('malformed edit (normalize returns null) records failure but does not commit', async () => {
        const adapter = createStubAdapter({ a: 1 });
        const session = { id: 's', messages: [], pendingApproval: null, updatedAt: 0 };
        const result = await executeToolCalls(adapter, session, [
            { id: 'e2', name: 'stub_unknown_tool', args: {} },
        ], null);
        expect(result.changed).toBe(false);
        expect(adapter._state.commitHistory).toEqual([]);
        expect(result.toolResults[0].content).toContain('ok');   // shell still emits a tool_result
    });

    test('mixed control + editable: edit applies and continueRequested propagates', async () => {
        const adapter = createStubAdapter({ greeting: 'hi' });
        const session = { id: 's', messages: [], pendingApproval: null, updatedAt: 0 };
        const result = await executeToolCalls(adapter, session, [
            { id: '1', name: 'stub_str_replace', args: { path: 'greeting', find: 'hi', replace: 'hello' } },
            { id: '2', name: 'iter_continue', args: { reason: 'next round' } },
        ], null);
        expect(result.continueRequested).toBe(true);
        expect(result.changed).toBe(true);
        expect(adapter._state.commitHistory[0]).toEqual({ greeting: 'hello' });
    });
});
