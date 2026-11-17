import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsEngine } from '../../../src/storage/engines/fs-engine.js';

describe('FsEngine chat handler — selected document validation', () => {
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

    test('get exposes corrupt/non-conformant documents without changing their bytes', async () => {
        plant('corrupt-header', '{not json\n');
        plant('corrupt-body', `${JSON.stringify({ chat_metadata: {} })}\n{not json\n`);
        plant('header-array', `${JSON.stringify([1, 2, 3])}\n`);
        plant('header-string', `${JSON.stringify('hi')}\n`);
        plant('empty-file', '');

        for (const name of ['corrupt-header', 'corrupt-body', 'header-array', 'header-string', 'empty-file']) {
            const original = fs.readFileSync(path.join(chatsDir, `${name}.jsonl`));
            await expect(engine.withTransaction(handle, async tx => tx.getResource(chatKey({ name })))).rejects.toThrow(name);
            expect(fs.readFileSync(path.join(chatsDir, `${name}.jsonl`))).toEqual(original);
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

// Emulated external storage on Android (FUSE + SELinux) and FAT/exFAT volumes
// deny hard links (link(2) -> EACCES / EPERM / ENOTSUP) while supporting
// same-directory rename(2). Run real FsEngine + ChatRepo against real disk in
// a child process whose link(2) entry points reject with EACCES.
describe('FsEngine chat handler — filesystems that deny hard links', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-fs-no-hardlink-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const engineModule = new URL('../../../src/storage/engines/fs-engine.js', import.meta.url).href;
    const repoModule = new URL('../../../src/storage/repositories/chat-repo.js', import.meta.url).href;
    const errorsModule = new URL('../../../src/storage/errors.js', import.meta.url).href;
    const endpointHarnessModule = new URL('../harness/endpoint-harness.js', import.meta.url).href;
    const chatsEndpointModule = new URL('../../../src/endpoints/chats.js', import.meta.url).href;
    const storageIndexModule = new URL('../../../src/storage/index.js', import.meta.url).href;
    const utilModule = new URL('../../../src/util.js', import.meta.url).href;
    const defaultConfigPath = fileURLToPath(new URL('../../../default/config.yaml', import.meta.url));

    function runWithoutHardLinks(scriptBody) {
        const resultFile = path.join(tmpDir, 'result.json');
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
            import fs from 'node:fs';
            import path from 'node:path';
            const denyLink = (src, dest) => {
                throw Object.assign(
                    new Error(\`EACCES: permission denied, link '\${src}' -> '\${dest}'\`),
                    { errno: -13, code: 'EACCES', syscall: 'link', path: String(src), dest: String(dest) },
                );
            };
            fs.linkSync = denyLink;
            fs.link = (src, dest, cb) => queueMicrotask(() => cb(denyLink(src, dest)));
            fs.promises.link = async (src, dest) => denyLink(src, dest);

            const { FsEngine } = await import(${JSON.stringify(engineModule)});
            const { ChatRepo } = await import(${JSON.stringify(repoModule)});
            const { ConflictError } = await import(${JSON.stringify(errorsModule)});
            const userDir = ${JSON.stringify(path.join(tmpDir, 'default-user'))};
            const dirs = {
                root: userDir,
                chats: path.join(userDir, 'chats'),
                groupChats: path.join(userDir, 'group chats'),
            };
            fs.mkdirSync(dirs.chats, { recursive: true });
            fs.mkdirSync(dirs.groupChats, { recursive: true });
            const engine = new FsEngine({ directoriesByHandle: () => dirs });
            const repo = new ChatRepo({ engine });
            const writeResult = (data) => fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(data));
            ${scriptBody}
        `], { encoding: 'utf8' });
        return {
            status: child.status,
            stderr: child.stderr,
            result: fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null,
        };
    }

    test('renames character and group chats with state namespaces without calling link(2)', () => {
        const child = runWithoutHardLinks(`
            const updatedAt = 1700000000000;
            await repo.saveRaw('default-user', 'TestChar', 'source', {
                header: { user_name: 'U', character_name: 'TestChar', chat_metadata: { note: 'keep' } },
                body: [{ name: 'U', is_user: true, mes: 'hello' }],
                integrity: 'orig-integrity',
                updatedAt,
                createdAt: updatedAt,
            });
            await repo.setState('default-user', 'TestChar', 'source', 'memory_graph', { nodes: [{ id: 'n1' }] });
            await repo.setState('default-user', 'TestChar', 'source', 'variables', { count: 3 });

            await repo.rename('default-user', 'TestChar', 'source', 'renamed');

            const moved = await repo.get('default-user', 'TestChar', 'renamed');
            const old = await repo.get('default-user', 'TestChar', 'source');
            const mg = await repo.getState('default-user', 'TestChar', 'renamed', 'memory_graph');
            const vars = await repo.getState('default-user', 'TestChar', 'renamed', 'variables');
            const charEntries = fs.readdirSync(path.join(dirs.chats, 'TestChar')).sort();

            await repo.saveRaw('default-user', '', 'group-old', {
                header: { user_name: 'U', chat_metadata: { is_group_chat: true } },
                body: [{ name: 'U', is_user: true, mes: 'group msg' }],
                integrity: 'group-integrity',
                updatedAt,
                createdAt: updatedAt,
            }, { isGroup: true, groupId: 'group-old' });
            await repo.setState('default-user', '', 'group-old', 'notes', { pinned: true }, { isGroup: true, groupId: 'group-old' });
            await repo.rename('default-user', '', 'group-old', 'group-new', { isGroup: true, groupId: 'group-old' });

            const movedGroup = await repo.get('default-user', '', 'group-new', { isGroup: true, groupId: 'group-new' });
            const groupEntries = fs.readdirSync(dirs.groupChats).sort();

            writeResult({
                old,
                movedBody: moved.body,
                movedIntegrity: moved.integrity,
                movedUpdatedAt: moved.updatedAt,
                mg,
                vars,
                charEntries,
                movedGroupBody: movedGroup.body,
                groupEntries,
            });
        `);

        expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
        expect(child.result).toEqual({
            old: null,
            movedBody: [{ name: 'U', is_user: true, mes: 'hello' }],
            movedIntegrity: 'orig-integrity',
            movedUpdatedAt: 1700000000000,
            mg: { nodes: [{ id: 'n1' }] },
            vars: { count: 3 },
            charEntries: [
                'renamed.jsonl',
                'renamed.luker-state.memory_graph.json',
                'renamed.luker-state.variables.json',
            ],
            movedGroupBody: [{ name: 'U', is_user: true, mes: 'group msg' }],
            groupEntries: [
                'group-new.jsonl',
                'group-new.luker-state.notes.json',
            ],
        });
    });

    test('insert-only publication preserves occupied targets and cleans up staging files without link(2)', () => {
        const child = runWithoutHardLinks(`
            const key = { kind: 'chat', handle: 'default-user', charDir: 'TestChar', name: 'fresh', isGroup: false };
            const first = await engine.withTransaction('default-user', (tx) =>
                tx.putResourceIfMatch(key, null, {
                    header: { chat_metadata: {} },
                    body: [{ mes: 'first' }],
                    integrity: 'v1',
                    updatedAt: 1700000000000,
                    createdAt: 1700000000000,
                }));
            const second = await engine.withTransaction('default-user', (tx) =>
                tx.putResourceIfMatch(key, null, {
                    header: { chat_metadata: {} },
                    body: [{ mes: 'second' }],
                    integrity: 'v2',
                    updatedAt: 1700000001000,
                    createdAt: 1700000001000,
                }));

            await engine.withTransaction('default-user', (tx) =>
                tx.putChatState(key, 'ns1', { ok: 1 }, { ifAbsent: true }));
            let duplicateStateCode = null;
            try {
                await engine.withTransaction('default-user', (tx) =>
                    tx.putChatState(key, 'ns1', { ok: 2 }, { ifAbsent: true }));
            } catch (err) {
                duplicateStateCode = err instanceof ConflictError ? err.code : String(err);
            }

            // Occupied dangling symlink target must also be refused without overwrite.
            const symlinkTarget = path.join(dirs.chats, 'TestChar', 'dangling.jsonl');
            fs.symlinkSync(path.join(dirs.chats, 'TestChar', 'missing-target'), symlinkTarget);
            const onSymlink = await engine.withTransaction('default-user', (tx) =>
                tx.putResourceIfMatch({ ...key, name: 'dangling' }, null, {
                    header: { chat_metadata: {} },
                    body: [],
                    integrity: 'v3',
                    updatedAt: 1700000000000,
                    createdAt: 1700000000000,
                }));

            const readBack = await repo.get('default-user', 'TestChar', 'fresh');
            const stateBack = await repo.getState('default-user', 'TestChar', 'fresh', 'ns1');
            const danglingStillSymlink = fs.lstatSync(symlinkTarget).isSymbolicLink();
            const stagingRemnants = fs.readdirSync(path.join(dirs.chats, 'TestChar'))
                .filter((name) => name.startsWith('.luker-staging-'));

            writeResult({
                first,
                second,
                duplicateStateCode,
                onSymlink,
                readBackBody: readBack.body,
                readBackIntegrity: readBack.integrity,
                stateBack,
                danglingStillSymlink,
                stagingRemnants,
            });
        `);

        expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
        expect(child.result).toEqual({
            first: { updated: true },
            second: { updated: false },
            duplicateStateCode: 'rename_target_exists',
            onSymlink: { updated: false },
            readBackBody: [{ mes: 'first' }],
            readBackIntegrity: 'v1',
            stateBack: { ok: 1 },
            danglingStillSymlink: true,
            stagingRemnants: [],
        });
    });

    test('POST /api/chats/rename succeeds for character chats when link(2) fails with EACCES', () => {
        const child = runWithoutHardLinks(`
            const { setConfigFilePath, reloadConfigCache } = await import(${JSON.stringify(utilModule)});
            setConfigFilePath(${JSON.stringify(defaultConfigPath)});
            reloadConfigCache();
            globalThis.DATA_ROOT = userDir;
            const { makeEndpointHarness } = await import(${JSON.stringify(endpointHarnessModule)});
            const { router: chatsRouter } = await import(${JSON.stringify(chatsEndpointModule)});
            const { getChatRepo } = await import(${JSON.stringify(storageIndexModule)});
            const h = await makeEndpointHarness({
                mode: 'fs',
                mount: (app) => app.use('/api/chats', chatsRouter),
            });
            try {
                const chatRepo = getChatRepo();
                await chatRepo.save(h.handle, 'TestChar', 'source', {
                    user_name: 'U',
                    character_name: 'TestChar',
                    chat_metadata: { note: 'persisted' },
                }, [{ name: 'U', is_user: true, mes: 'route message' }], null);
                await chatRepo.setState(h.handle, 'TestChar', 'source', 'memory_graph', { version: 1 });

                const baseUrl = \`http://127.0.0.1:\${h.server.address().port}\`;
                const res = await fetch(\`\${baseUrl}/api/chats/rename\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        is_group: false,
                        avatar_url: 'TestChar.png',
                        original_file: 'source.jsonl',
                        renamed_file: 'renamed.jsonl',
                    }),
                });
                const renameBody = await res.json();
                const moved = await chatRepo.get(h.handle, 'TestChar', 'renamed');
                const old = await chatRepo.get(h.handle, 'TestChar', 'source');
                const movedState = await chatRepo.getState(h.handle, 'TestChar', 'renamed', 'memory_graph');

                writeResult({
                    httpStatus: res.status,
                    renameBody,
                    old,
                    movedMessages: moved?.body,
                    movedState,
                });
            } finally {
                await h.cleanup();
            }
        `);

        expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
        expect(child.result).toEqual({
            httpStatus: 200,
            renameBody: { ok: true, sanitizedFileName: 'renamed' },
            old: null,
            movedMessages: [{ name: 'U', is_user: true, mes: 'route message' }],
            movedState: { version: 1 },
        });
    });
});
