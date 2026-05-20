/**
 * Tests for runner.js rollback path (Task 7).
 *
 * Mirrors the mock setup from runner-apply.test.js: routes the lib/edits
 * entry point through a real engine instance (so applyEdits / inverseEdit
 * run for real), stubs conflict-ui and i18n.
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
let rollbackToMessage;

beforeAll(async () => {
    ({ createStubAdapter } = await import('./helpers/stub-adapter.js'));
    ({ rollbackToMessage } = await import('../../public/scripts/iteration-studio/runner.js'));
});

function makeSession(adapter) {
    return {
        id: 'sess', messages: [], pendingApproval: null, updatedAt: 0,
        mode: adapter.mode, sourceScope: 'test', sourceAvatar: '', sourceName: 'Test',
        createdAt: 0,
    };
}

describe('rollbackToMessage', () => {
    test('inverses single appliedEdits message', async () => {
        const adapter = createStubAdapter({ a: 1 });
        await adapter.commit({ a: 2 });   // simulate previously applied
        const session = makeSession(adapter);
        session.messages = [
            { id: 'u1', role: 'user', content: 'set a=2', at: 1 },
            {
                id: 'a1', role: 'assistant', content: 'done', at: 2,
                appliedEdits: [{ op: 'set', path: 'a', oldValue: 1, newValue: 2 }],
            },
        ];
        await rollbackToMessage(adapter, session, 'a1');
        expect(adapter._state.commitHistory.at(-1)).toEqual({ a: 1 });
        expect(session.messages[1].rolledBack).toBe(true);
    });

    test('inverses multiple messages in reverse order', async () => {
        const adapter = createStubAdapter({ x: '' });
        await adapter.commit({ x: 'ab' });
        const session = makeSession(adapter);
        session.messages = [
            {
                id: 'a1', role: 'assistant', content: 'add a', at: 1,
                appliedEdits: [{ op: 'set', path: 'x', oldValue: '', newValue: 'a' }],
            },
            {
                id: 'a2', role: 'assistant', content: 'add b', at: 2,
                appliedEdits: [{ op: 'set', path: 'x', oldValue: 'a', newValue: 'ab' }],
            },
        ];
        await rollbackToMessage(adapter, session, 'a1');
        expect(adapter._state.commitHistory.at(-1)).toEqual({ x: '' });
        expect(session.messages[0].rolledBack).toBe(true);
        expect(session.messages[1].rolledBack).toBe(true);
    });

    test('messages without appliedEdits in range are still marked rolledBack', async () => {
        const adapter = createStubAdapter({ a: 'x' });
        await adapter.commit({ a: 'y' });   // simulate state after a2 applied
        const session = makeSession(adapter);
        session.messages = [
            { id: 'a1', role: 'assistant', content: 'thinking...', at: 1 },
            {
                id: 'a2', role: 'assistant', content: 'done', at: 2,
                appliedEdits: [{ op: 'set', path: 'a', oldValue: 'x', newValue: 'y' }],
            },
        ];
        await rollbackToMessage(adapter, session, 'a1');
        expect(session.messages[0].rolledBack).toBe(true);
        expect(session.messages[1].rolledBack).toBe(true);
        expect(adapter._state.commitHistory.at(-1)).toEqual({ a: 'x' });
    });
});
