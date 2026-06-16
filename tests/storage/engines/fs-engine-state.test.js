import fs from 'node:fs';
import path from 'node:path';
import { makeTempFsEngine } from '../harness/fs-harness.js';

describe('FsEngine — chat state (sidecar) operations', () => {
    let h;
    beforeEach(async () => { h = await makeTempFsEngine(); });
    afterEach(() => h.cleanup());

    const chatKey = (overrides = {}) => ({
        kind: 'chat', handle: 'u', charDir: 'Alice', name: 'c1', ...overrides,
    });

    async function makeChat(integrity = 'INT0') {
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource(chatKey(), {
                header: {}, body: [], integrity, updatedAt: 1, createdAt: 1,
            });
        });
    }

    test('getChatState returns null when sidecar missing', async () => {
        await makeChat();
        await h.engine.withTransaction(h.handle, async (tx) => {
            const r = await tx.getChatState(chatKey(), 'memory_graph__meta');
            expect(r).toBeNull();
        });
    });

    test('putChatState then getChatState round-trips', async () => {
        await makeChat();
        const doc = { anchors: [1, 2, 3], integrity: 'S1' };
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putChatState(chatKey(), 'memory_graph__meta', doc);
        });
        await h.engine.withTransaction(h.handle, async (tx) => {
            const read = await tx.getChatState(chatKey(), 'memory_graph__meta');
            expect(read).toEqual(doc);
        });
    });

    test('listChatStateNamespaces returns all sidecar namespaces for the chat', async () => {
        await makeChat();
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putChatState(chatKey(), 'a__meta', { x: 1 });
            await tx.putChatState(chatKey(), 'b__meta', { y: 2 });
        });
        await h.engine.withTransaction(h.handle, async (tx) => {
            const ns = (await tx.listChatStateNamespaces(chatKey())).sort();
            expect(ns).toEqual(['a__meta', 'b__meta']);
        });
    });

    test('deleteChatState removes one namespace, others remain', async () => {
        await makeChat();
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putChatState(chatKey(), 'keep', { v: 1 });
            await tx.putChatState(chatKey(), 'drop', { v: 2 });
        });
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.deleteChatState(chatKey(), 'drop');
        });
        await h.engine.withTransaction(h.handle, async (tx) => {
            expect(await tx.getChatState(chatKey(), 'drop')).toBeNull();
            expect(await tx.getChatState(chatKey(), 'keep')).toEqual({ v: 1 });
        });
    });

    test('deleteResource cascades all chat_state sidecars', async () => {
        await makeChat();
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putChatState(chatKey(), 'a', { v: 1 });
            await tx.putChatState(chatKey(), 'b', { v: 2 });
        });
        const sidecarA = path.join(h.chatsDir, 'Alice', 'c1.luker-state.a.json');
        const sidecarB = path.join(h.chatsDir, 'Alice', 'c1.luker-state.b.json');
        expect(fs.existsSync(sidecarA)).toBe(true);
        expect(fs.existsSync(sidecarB)).toBe(true);

        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.deleteResource(chatKey());
        });
        expect(fs.existsSync(sidecarA)).toBe(false);
        expect(fs.existsSync(sidecarB)).toBe(false);
    });
});
