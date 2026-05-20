/**
 * Tests for runner.js pending-approval sandbox projection (Task 8).
 *
 * Same mock pattern as runner-apply.test.js: real edits engine + no-op
 * conflict-ui + no-op i18n.
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
let stagePendingApproval;
let applyPendingApproval;

beforeAll(async () => {
    ({ createStubAdapter } = await import('./helpers/stub-adapter.js'));
    const runner = await import('../../public/scripts/iteration-studio/runner.js');
    stagePendingApproval = runner.stagePendingApproval;
    applyPendingApproval = runner.applyPendingApproval;
});

describe('stagePendingApproval', () => {
    test('stores proposedEdits + projects new-live without committing', async () => {
        const adapter = createStubAdapter({ a: 1, b: 'hi' });
        const session = { id: 's', messages: [], pendingApproval: null, updatedAt: 0 };
        const projection = await stagePendingApproval(adapter, session, {
            messageId: 'm1',
            assistantText: 'I propose:',
            calls: [
                { id: 'c1', name: 'stub_set', args: { path: 'a', oldValue: 1, newValue: 99 } },
                { id: 'c2', name: 'stub_str_replace', args: { path: 'b', find: 'hi', replace: 'hello' } },
            ],
        });
        expect(session.pendingApproval).not.toBeNull();
        expect(session.pendingApproval.proposedEdits).toHaveLength(2);
        expect(projection.projectedLive).toEqual({ a: 99, b: 'hello' });
        // Live unchanged:
        expect(adapter.live()).toEqual({ a: 1, b: 'hi' });
        expect(adapter._state.commitHistory).toEqual([]);
    });
});

describe('applyPendingApproval', () => {
    test('runs the stored proposedEdits via apply path + records message + clears pending', async () => {
        const adapter = createStubAdapter({ a: 1 });
        const session = {
            id: 's',
            messages: [{ id: 'm1', role: 'assistant', content: 'proposal', at: 1, toolState: 'pending' }],
            pendingApproval: {
                messageId: 'm1',
                assistantText: 'proposal',
                toolCalls: [{ id: 'c1', name: 'stub_set', args: { path: 'a', oldValue: 1, newValue: 5 } }],
                executionToolCalls: [{ id: 'c1', name: 'stub_set', args: { path: 'a', oldValue: 1, newValue: 5 } }],
                proposedEdits: [{ op: 'set', path: 'a', oldValue: 1, newValue: 5 }],
                createdAt: 1,
            },
            updatedAt: 1,
        };
        const result = await applyPendingApproval(adapter, session);
        expect(result.ok).toBe(true);
        expect(adapter._state.commitHistory).toEqual([{ a: 5 }]);
        expect(session.messages[0].appliedEdits).toEqual([{ op: 'set', path: 'a', oldValue: 1, newValue: 5 }]);
        expect(session.messages[0].toolState).toBe('completed');
        expect(session.pendingApproval).toBeNull();
    });
});
