import './_mocks/luker-zh.js';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { createSessionStore, migrateLegacySessions } from '../../public/scripts/extensions/workbench/model/sessions.js';

const KEY = 'workbench.sessions.v1';

function memoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

test('two stores on one storage keep each other\'s sessions', () => {
    const storage = memoryStorage();
    const ask = createSessionStore(storage);
    const iterate = createSessionStore(storage);
    ask.list();
    iterate.list();
    const a = ask.create({ kind: 'ask', title: 'a' });
    const b = iterate.create({ kind: 'iterate', title: 'b' });
    ask.update(a.id, { title: 'a2' });
    const stored = JSON.parse(storage.getItem(KEY));
    assert.deepEqual(stored.map(s => s.id).sort(), [a.id, b.id].sort());
    assert.equal(iterate.get(a.id).title, 'a2');
});

test('migration keeps the browser copy until settings are saved', () => {
    const legacy = memoryStorage({ [KEY]: JSON.stringify([{ id: 'old', updatedAt: 1, turns: [] }]) });
    const account = memoryStorage({ [KEY]: JSON.stringify([{ id: 'mine', updatedAt: 2, turns: [] }]) });
    let saved = null;
    migrateLegacySessions({ account, legacy, persist: (cb) => { saved = cb; } });
    assert.deepEqual(JSON.parse(account.getItem(KEY)).map(s => s.id), ['mine', 'old']);
    assert.notEqual(legacy.getItem(KEY), null);
    saved();
    assert.equal(legacy.getItem(KEY), null);
});

test('migration leaves unreadable data alone and is a no-op with no legacy key', () => {
    const legacy = memoryStorage({ [KEY]: 'not json' });
    const account = memoryStorage();
    migrateLegacySessions({ account, legacy, persist: () => assert.fail('nothing to save') });
    assert.equal(legacy.getItem(KEY), 'not json');
    assert.equal(account.getItem(KEY), null);
    migrateLegacySessions({ account, legacy: memoryStorage(), persist: () => assert.fail('nothing to save') });
});
