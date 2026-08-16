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

    test('put preserves caller-supplied updatedAt as file mtime', async () => {
        // saveRaw / migration path: a numeric updatedAt should land as the
        // file mtime so the source's "last edited" time survives a copy.
        const updatedAt = 1700000000000; // 2023-11-14 22:13:20 UTC, in ms
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(chatKey(), {
                header: { chat_metadata: {} }, body: [], integrity: 'x',
                updatedAt, createdAt: updatedAt,
            }));
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(chatKey()));
        expect(got.updatedAt).toBe(updatedAt);
    });
});

// Regression: legacy chats written before the 128-byte length limit was
// introduced must still flow through save/get/rename/append/patch. The
// endpoint layer enforces 128 bytes on fresh user input, but the engine
// put path only enforces the character / suffix shape check so old data
// remains reachable end-to-end (not just readable/deletable).
describe('FsEngine chat handler — legacy long name (>128 bytes) round-trip', () => {
    let tmpDir, engine;
    const handle = 'u';
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-fs-chat-long-'));
        const userDir = path.join(tmpDir, handle);
        fs.mkdirSync(path.join(userDir, 'chats'), { recursive: true });
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

    // Two long-name variants: ASCII 129 bytes and CJK 129 bytes (43 * 3). Both
    // are just over the endpoint's 128-byte cap, which is exactly the
    // legacy-data boundary users report ("chat.name exceeds 128 bytes" when
    // renaming a character that owns an old chat).
    const longAscii = 'a'.repeat(129);
    const longCjk = '我'.repeat(43);

    for (const [label, longName] of [['ASCII 129 bytes', longAscii], ['CJK 129 bytes', longCjk]]) {
        test(`put + get round-trip for legacy chat.name (${label})`, async () => {
            const key = { kind: 'chat', handle, charDir: 'LegacyChar', name: longName, isGroup: false };
            await engine.withTransaction(handle, async (tx) =>
                tx.putResource(key, {
                    header: { chat_metadata: {} }, body: [], integrity: 'x',
                    updatedAt: 1700000000000, createdAt: 1700000000000,
                }));
            const got = await engine.withTransaction(handle, async (tx) => tx.getResource(key));
            expect(got).not.toBeNull();
            expect(got.integrity).toBe('x');
        });
    }

    test('put succeeds when charDir also exceeds 128 bytes', async () => {
        // renameCharDir stays byte-for-byte on charDir; a legacy long charDir
        // must round-trip too so the migration from oldCharDir to newCharDir
        // doesn't stall on either half of the key.
        const key = { kind: 'chat', handle, charDir: 'c'.repeat(150), name: 'chat1', isGroup: false };
        await engine.withTransaction(handle, async (tx) =>
            tx.putResource(key, {
                header: { chat_metadata: {} }, body: [], integrity: 'x',
                updatedAt: 1, createdAt: 1,
            }));
        const got = await engine.withTransaction(handle, async (tx) => tx.getResource(key));
        expect(got).not.toBeNull();
    });

    test('still rejects sanitize-unsafe chat.name even when long', async () => {
        // Length is not the shape check's job, but shape must still hold:
        // a 200-char name that also contains a slash must be refused.
        const key = { kind: 'chat', handle, charDir: 'LegacyChar', name: `${'a'.repeat(150)}/oops`, isGroup: false };
        await expect(engine.withTransaction(handle, async (tx) =>
            tx.putResource(key, {
                header: { chat_metadata: {} }, body: [], integrity: 'x',
                updatedAt: 1, createdAt: 1,
            }))).rejects.toThrow();
    });
});
