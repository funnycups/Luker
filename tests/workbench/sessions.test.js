import './_mocks/luker-zh.js';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { createSessionStore, fitSession, MAX_SESSION_CHARS } from '../../public/scripts/extensions/workbench/model/sessions.js';

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

test('a new store starts empty and leaves the old browser-wide key alone', () => {
    const legacy = memoryStorage({ [KEY]: JSON.stringify([{ id: 'old', updatedAt: 1, turns: [] }]) });
    const account = memoryStorage();
    assert.deepEqual(createSessionStore(account).list(), []);
    assert.notEqual(legacy.getItem(KEY), null);
    assert.equal(account.getItem(KEY), null);
});

test('one huge tool message cannot pass the cap or evict other sessions', () => {
    const storage = memoryStorage();
    const store = createSessionStore(storage);
    const keep = store.create({ kind: 'ask', title: 'keep' });
    const big = store.create({ kind: 'iterate', title: 'big', messages: [] });
    store.update(big.id, { messages: [{ role: 'tool', tool_call_id: 'x', content: 'x'.repeat(1_100_000) }] });
    assert.ok(storage.getItem(KEY).length <= 1_000_000);
    assert.ok(store.get(keep.id));
    assert.ok(store.get(big.id));
});

test('many large turns and changes stay under the per-session budget', () => {
    const store = createSessionStore(memoryStorage());
    const s = store.create({ kind: 'iterate', title: 't' });
    const changes = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, kind: 'change', before: 'b'.repeat(50000), after: 'a'.repeat(50000), sig: 'q' }));
    const saved = store.update(s.id, { turns: Array.from({ length: 30 }, () => ({ role: 'ai', text: 'x'.repeat(30000), changes })) });
    assert.ok(JSON.stringify(saved).length <= MAX_SESSION_CHARS);
    assert.equal(saved.turns.at(-1).changes[0].sig, 'q');
});

test('dropping old messages keeps Answer again pointing at the right place', () => {
    const big = { role: 'user', content: 'x'.repeat(19000) };
    const fitted = fitSession({ id: 'a', turns: [{ role: 'ai', msgKeep: 15 }], messages: Array.from({ length: 20 }, () => big) });
    assert.equal(fitted.turns[0].msgKeep, 15 - (20 - fitted.messages.length));
});

test('oversized read arguments cannot escape the session cap', () => {
    const s = fitSession({ id: 'ask', turns: [{ role: 'ai', answer: 'answer', reads: [{ args: { query: 'x'.repeat(1_100_000) } }] }] });
    assert.ok(JSON.stringify(s).length <= MAX_SESSION_CHARS);
    assert.equal(s.turns[0].answer, 'answer');
});
