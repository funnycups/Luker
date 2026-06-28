import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsEngine } from '../../../src/storage/engines/fs-engine.js';

describe('FsEngine chat handler — corrupt-doc tolerance', () => {
    let tmpDir, engine;
    const handle = 'u';
    let chatsDir;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-fs-chat-'));
        const userDir = path.join(tmpDir, handle);
        chatsDir = path.join(userDir, 'chats', 'TestChar');
        fs.mkdirSync(chatsDir, { recursive: true });
        engine = new FsEngine({
            directoriesByHandle: () => ({
                root: userDir,
                chats: path.join(userDir, 'chats'),
                groupChats: path.join(userDir, 'group chats'),
            }),
        });
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const chatKey = (overrides = {}) => ({
        kind: 'chat', handle, charDir: 'TestChar', name: 'chat1',
        isGroup: false, groupId: undefined, ...overrides,
    });

    const plant = (name, raw) => fs.writeFileSync(path.join(chatsDir, `${name}.jsonl`), raw);

    test('get returns null for corrupt/non-conformant docs (no throw)', async () => {
        plant('corrupt-header', '{not json\n');
        plant('corrupt-body', `${JSON.stringify({ chat_metadata: {} })}\n{not json\n`);
        plant('header-array', `${JSON.stringify([1, 2, 3])}\n`);
        plant('header-string', `${JSON.stringify('hi')}\n`);
        plant('empty-file', '');

        for (const name of ['corrupt-header', 'corrupt-body', 'header-array', 'header-string', 'empty-file']) {
            const got = await engine.withTransaction(handle, async (tx) => tx.getResource(chatKey({ name })));
            expect(got).toBeNull();
        }
    });

    test('get returns null when chat file is missing', async () => {
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(chatKey({ name: 'never-written' })));
        expect(got).toBeNull();
    });

    test('deleteSidecar returns boolean', async () => {
        // Seed a parent chat so putChatState is allowed (FS doesn't enforce
        // this, but the test reads more honestly when the chat exists).
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
});
