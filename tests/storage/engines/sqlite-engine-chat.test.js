import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';
import { NotFoundError } from '../../../src/storage/errors.js';

describe('SqliteEngine chat handler', () => {
    let tmpDir, engine;
    const handle = 'u';
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sqlite-chat-'));
        engine = new SqliteEngine({
            directoriesByHandle: () => ({ root: path.join(tmpDir, handle) }),
        });
    });
    afterEach(() => {
        engine.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const chatKey = (overrides = {}) => ({
        kind: 'chat', handle, charDir: 'TestChar', name: 'chat1',
        isGroup: false, groupId: undefined, ...overrides,
    });

    test('put then get round-trips header + body + integrity', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(chatKey(), {
                header: { chat_metadata: { foo: 'bar' } },
                body: [{ name: 'User', mes: 'hi' }],
                integrity: 'abc-123',
                updatedAt: 100,
                createdAt: 50,
            });
        });
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(chatKey()));
        expect(got.header.chat_metadata.foo).toBe('bar');
        expect(got.header.chat_metadata.integrity).toBe('abc-123');
        expect(got.body).toEqual([{ name: 'User', mes: 'hi' }]);
        expect(got.integrity).toBe('abc-123');
        expect(got.updatedAt).toBe(100);
        expect(got.createdAt).toBe(50);
    });

    test('get returns null when missing', async () => {
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(chatKey()));
        expect(got).toBeNull();
    });

    test('put overwrites existing and preserves created_at', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [], integrity: 'v1',
                updatedAt: 1, createdAt: 1,
            });
        });
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [{ mes: 'x' }], integrity: 'v2',
                updatedAt: 2, createdAt: 1,
            });
        });
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(chatKey()));
        expect(got.integrity).toBe('v2');
        expect(got.body).toEqual([{ mes: 'x' }]);
        expect(got.createdAt).toBe(1);
    });

    test('delete returns true when present, false when missing', async () => {
        const missing = await engine.withTransaction(handle, async (tx) => tx.deleteResource(chatKey()));
        expect(missing).toBe(false);
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [], integrity: 'x',
                updatedAt: 1, createdAt: 1,
            }));
        const present = await engine.withTransaction(handle, async (tx) => tx.deleteResource(chatKey()));
        expect(present).toBe(true);
    });

    test('delete cascades chat_states via FK', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [], integrity: 'x',
                updatedAt: 1, createdAt: 1,
            });
            tx.putChatState(chatKey(), 'memory-graph', { items: [1, 2, 3] });
            tx.putChatState(chatKey(), 'floor-state', { current: 2 });
        });
        await engine.withTransaction(handle, async (tx) => tx.deleteResource(chatKey()));
        const namespaces = await engine.withTransaction(handle, async (tx) =>
            tx.listChatStateNamespaces(chatKey()));
        expect(namespaces).toEqual([]);
    });

    test('list returns sorted by updatedAt desc by default', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(chatKey({ name: 'a' }), {
                header: { chat_metadata: {} }, body: [], integrity: '1',
                updatedAt: 100, createdAt: 100,
            });
            tx.putResource(chatKey({ name: 'b' }), {
                header: { chat_metadata: {} }, body: [], integrity: '2',
                updatedAt: 200, createdAt: 100,
            });
            tx.putResource(chatKey({ name: 'c' }), {
                header: { chat_metadata: {} }, body: [], integrity: '3',
                updatedAt: 150, createdAt: 100,
            });
        });
        const list = await engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'chat', handle, orderBy: 'updatedAt' }));
        expect(list.map((r) => r.key.name)).toEqual(['b', 'c', 'a']);
        expect(list[0].header).toBeUndefined();
    });

    test('list respects limit', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(chatKey({ name: 'a' }), {
                header: { chat_metadata: {} }, body: [], integrity: '1',
                updatedAt: 100, createdAt: 100,
            });
            tx.putResource(chatKey({ name: 'b' }), {
                header: { chat_metadata: {} }, body: [], integrity: '2',
                updatedAt: 200, createdAt: 100,
            });
        });
        const list = await engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'chat', handle, orderBy: 'updatedAt', limit: 1 }));
        expect(list).toHaveLength(1);
        expect(list[0].key.name).toBe('b');
    });

    test('group chat uses groupId as primary identifier', async () => {
        const groupKey = chatKey({
            isGroup: true, groupId: 'group-42', charDir: undefined, name: 'whatever',
        });
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(groupKey, {
                header: { chat_metadata: {} }, body: [], integrity: 'g',
                updatedAt: 1, createdAt: 1,
            }));
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(groupKey));
        expect(got).not.toBeNull();
        expect(got.integrity).toBe('g');
    });

    test('putChatState round-trips', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [], integrity: 'x',
                updatedAt: 1, createdAt: 1,
            }));
        await engine.withTransaction(handle, async (tx) =>
            tx.putChatState(chatKey(), 'memory-graph', { nodes: ['a', 'b'] }));
        const got = await engine.withTransaction(handle, async (tx) =>
            tx.getChatState(chatKey(), 'memory-graph'));
        expect(got).toEqual({ nodes: ['a', 'b'] });
    });

    test('putChatState throws NotFoundError when parent chat missing (matches FS via Repo)', async () => {
        await expect(engine.withTransaction(handle, async (tx) =>
            tx.putChatState(chatKey(), 'memory-graph', { x: 1 }),
        )).rejects.toBeInstanceOf(NotFoundError);
    });

    test('deleteChatState returns boolean', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [], integrity: 'x',
                updatedAt: 1, createdAt: 1,
            }));
        const missing = await engine.withTransaction(handle, async (tx) =>
            tx.deleteChatState(chatKey(), 'absent'));
        expect(missing).toBe(false);
        await engine.withTransaction(handle, async (tx) =>
            tx.putChatState(chatKey(), 'present', { v: 1 }));
        const present = await engine.withTransaction(handle, async (tx) =>
            tx.deleteChatState(chatKey(), 'present'));
        expect(present).toBe(true);
    });

    test('listChatStateNamespaces returns all namespaces for a chat', async () => {
        await engine.withTransaction(handle, async (tx) => {
            tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [], integrity: 'x',
                updatedAt: 1, createdAt: 1,
            });
            tx.putChatState(chatKey(), 'mg', { x: 1 });
            tx.putChatState(chatKey(), 'fs', { y: 2 });
        });
        const ns = await engine.withTransaction(handle, async (tx) =>
            tx.listChatStateNamespaces(chatKey()));
        expect(ns.sort()).toEqual(['fs', 'mg']);
    });

    test('putResourceIfMatch updates only on integrity match', async () => {
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [], integrity: 'v1',
                updatedAt: 1, createdAt: 1,
            }));
        const mismatch = await engine.withTransaction(handle, async (tx) =>
            tx.putResourceIfMatch(chatKey(), 'WRONG', {
                header: { chat_metadata: {} }, body: [], integrity: 'v2',
                updatedAt: 2, createdAt: 1,
            }));
        expect(mismatch.updated).toBe(false);
        const match = await engine.withTransaction(handle, async (tx) =>
            tx.putResourceIfMatch(chatKey(), 'v1', {
                header: { chat_metadata: {} }, body: [], integrity: 'v2',
                updatedAt: 2, createdAt: 1,
            }));
        expect(match.updated).toBe(true);
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(chatKey()));
        expect(got.integrity).toBe('v2');
    });
});
