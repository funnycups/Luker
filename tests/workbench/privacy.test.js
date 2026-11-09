import './_mocks/luker-zh.js';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { redactReaders } from '../../public/scripts/extensions/workbench/model/requests.js';
import { accountScopedStorage } from '../../public/scripts/extensions/lens-shared/account-storage.js';
import { createHistory } from '../../public/scripts/extensions/workbench/model/history.js';
import { createRecorder, createMemoryStorage } from '../../public/scripts/extensions/orchestrator/lens/model/recorder.js';

test('finding 15: every reader goes through redaction when it is on', async () => {
    const secret = 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const readers = { wb_read_chat: async () => ({ messages: [{ text: secret }] }), wb_read_memory: async () => secret };
    const on = redactReaders(readers, true);
    assert.doesNotMatch(JSON.stringify(await on.wb_read_chat()), /sk-abcdefghij/);
    assert.doesNotMatch(await on.wb_read_memory(), /sk-abcdefghij/);
    assert.equal(redactReaders(readers, false), readers);
});

test('finding 3: history is separate per account and legacy data stays unowned', () => {
    const storage = createMemoryStorage();
    storage.setItem('workbench.history.v1', JSON.stringify([{ id: 'legacy' }]));
    let handle = 'alice';
    const scoped = accountScopedStorage(storage, () => handle);
    createHistory(scoped).record({ ws: 'card', title: 'a' });
    assert.equal(createHistory(scoped).list().length, 1);
    handle = 'bob';
    assert.deepEqual(createHistory(scoped).list(), []);
    handle = null;
    createHistory(scoped).record({ ws: 'card', title: 'x' });
    assert.deepEqual(createHistory(scoped).list(), []);
    assert.equal(JSON.parse(storage.getItem('workbench.history.v1'))[0].id, 'legacy');
});

test('finding 3: a recorder reads run history for the account known at first use', () => {
    const storage = createMemoryStorage();
    storage.setItem('orchestraLens.history.v1::alice', JSON.stringify([{ runId: 1 }]));
    let handle = null;
    const recorder = createRecorder({ storage: accountScopedStorage(storage, () => handle) });
    handle = 'alice';
    assert.equal(recorder.history().length, 1);
});
