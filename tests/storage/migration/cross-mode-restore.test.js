// crossModeRestore orchestrator + extractFsTreeCategories tests.
//
// Coverage:
//   1. Happy path: sqlite-source ZIP → fs live engine → all data lands
//      at the real handle on the live engine, scratch is gone, snapshot is
//      gone.
//   2. Selection honored: only `chats` selected → only chats land; settings
//      that were in the source dump don't appear on live.
//   3. Overwrite vs merge: overwrite snapshots, merge does not.
//   4. Rollback: dest engine throws mid-copy → snapshot is restored, live
//      data returns to pre-restore state.
//   5. Scratch creds gate: mysql/pg ZIP without creds → 400 typed error.
//   6. Lock contention: a held lock causes the new call to throw with
//      code='MIGRATION_LOCKED'.
//   7. extractFsTreeCategories: handles secrets / characters / vectors,
//      skips engine sentinels, skips path traversal attempts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';

import {
    crossModeRestore,
    extractFsTreeCategories,
    _internals,
} from '../../../src/storage/migration/cross-mode-restore.js';
import {
    CrossModeScratchCredsRequiredError,
    CrossModeConversionFailedError,
} from '../../../src/storage/migration/cross-mode-errors.js';
import {
    ENGINE_DUMP_ENTRY, ENGINE_META_ENTRY,
} from '../../../src/storage/engine-backup-entries.js';
import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { acquireMigrationLock, releaseMigrationLock, makeHolderId } from '../../../src/storage/migration/lock.js';
import { setReadOnly, isReadOnly } from '../../../src/storage/read-only-mode.js';
import { RestoreDumpInvalidError } from '../../../src/storage/errors.js';
import { snapshotUser } from '../../../src/storage/migration/backup.js';
import { makeMultiHandleFsEngine } from '../harness/contract-harness.js';

function makeTempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'luker-cmr-'));
}

// Build a sqlite-source ZIP from a real engine harness.
async function buildSqliteSourceZip(zipPath, srcRoot, handle) {
    fs.mkdirSync(srcRoot, { recursive: true });
    const engine = new SqliteEngine({ directoriesByHandle: (h) => {
        if (h !== handle) throw new Error('bad handle');
        return { root: srcRoot };
    } });
    try {
        const chats = new ChatRepo({ engine });
        const settings = new SettingsRepo({ engine });
        const worlds = new WorldInfoRepo({ engine });
        await settings.save(handle, { user_name: 'crossModeUser', custom: 'val' });
        await chats.save(handle, 'Alice', 'c1',
            { user_name: 'crossModeUser' },
            [{ name: 'User', mes: 'cross-mode 你好 🌍', is_user: true }], null);
        await worlds.save(handle, 'world1', { entries: { '0': { content: 'lore' } } });
    } finally {
        engine.close();
    }
    const dumpBytes = fs.readFileSync(path.join(srcRoot, 'luker-storage.sqlite'));
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        arc.append(JSON.stringify({ schemaVersion: 1, handle }), { name: 'manifest.json' });
        arc.append(JSON.stringify({ engineKind: 'sqlite', schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle }), { name: ENGINE_META_ENTRY });
        arc.append(dumpBytes, { name: ENGINE_DUMP_ENTRY });
        // Include a fs-tree entry too so the extract step has something to do.
        arc.append('{"openrouter":"xxx"}', { name: 'secrets.json' });
        arc.finalize();
    });
}

describe('crossModeRestore — happy path sqlite→fs', () => {
    let dataRoot, dstRoot, dstEngine, dirsForHandle;
    beforeEach(() => {
        dataRoot = makeTempRoot();
        dstRoot = path.join(dataRoot, 'dst');
        ({ engine: dstEngine, dirsForHandle } = makeMultiHandleFsEngine({ root: dstRoot }));
        // Pre-create the live user dir tree so snapshotUser can cpSync it.
        dirsForHandle('realuser');
    });
    afterEach(async () => {
        setReadOnly(false);
        try { await dstEngine.close(); } catch { /* ignore */ }
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    test('end-to-end: sqlite-source ZIP restored into fs live engine', async () => {
        const zipPath = path.join(dataRoot, 'src.zip');
        await buildSqliteSourceZip(zipPath, path.join(dataRoot, 'src'), 'alice');

        const selection = {
            settings: true, secrets: true, chats: true, lorebooks: true,
            presets: false, characters: false, assets: false, extensions: false,
            globalExtensions: false, vectors: false,
        };
        const liveDirs = dirsForHandle('realuser');

        const events = [];
        const result = await crossModeRestore(
            zipPath,
            { engineKind: 'sqlite', handle: 'alice' },
            liveDirs,
            selection,
            'overwrite',
            {
                dataRoot,
                currentEngine: dstEngine,
                onProgress: (event) => events.push(event),
            },
        );

        expect(result.restoredCount).toBeGreaterThanOrEqual(1); // secrets.json
        expect(result.crossMode.sourceKind).toBe('sqlite');
        expect(result.crossMode.destKind).toBe('fs');
        expect(result.crossMode.converted.settings).toBe(1);
        expect(result.crossMode.converted.chats).toBe(1);
        expect(result.crossMode.converted.worlds).toBe(1);

        // Live data now contains the source's records under the real handle.
        const liveSettings = new SettingsRepo({ engine: dstEngine });
        expect((await liveSettings.get('realuser'))?.user_name).toBe('crossModeUser');
        const liveChats = new ChatRepo({ engine: dstEngine });
        const chat = await liveChats.get('realuser', 'Alice', 'c1');
        expect(chat.body[0].mes).toBe('cross-mode 你好 🌍');
        const liveWorlds = new WorldInfoRepo({ engine: dstEngine });
        expect(await liveWorlds.get('realuser', 'world1')).toBeTruthy();
        // secrets.json was extracted into the live user dir
        expect(fs.existsSync(path.join(liveDirs.root, 'secrets.json'))).toBe(true);

        // Snapshot directory is gone after success.
        const backupRoot = path.join(dataRoot, '_storage-migrations');
        const remaining = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : [];
        // The only entries left should be empty (scratch dir was cleaned).
        for (const e of remaining) {
            expect(e).not.toMatch(/^[0-9-]+T.*alice$/); // no snapshot dir
            expect(e).not.toMatch(/^_xrestore_/);       // no scratch dir
        }

        // Read-only mode is cleared after the call.
        expect(isReadOnly()).toBe(false);

        // Progress events include the convert stages.
        const convertStages = events
            .filter(e => e.phase === 'convert')
            .map(e => e.stage);
        for (const expected of ['settings-copied', 'worlds-copied', 'chats-copied', 'done']) {
            expect(convertStages).toContain(expected);
        }
    });

    test('selection honored: chats only — settings does not appear on live', async () => {
        const zipPath = path.join(dataRoot, 'src.zip');
        await buildSqliteSourceZip(zipPath, path.join(dataRoot, 'src'), 'alice');
        const selection = {
            chats: true,
            settings: false, secrets: false, lorebooks: false,
            presets: false, characters: false, assets: false, extensions: false,
            globalExtensions: false, vectors: false,
        };
        const liveDirs = dirsForHandle('realuser');

        await crossModeRestore(
            zipPath,
            { engineKind: 'sqlite', handle: 'alice' },
            liveDirs,
            selection,
            'overwrite',
            { dataRoot, currentEngine: dstEngine },
        );

        const liveSettings = new SettingsRepo({ engine: dstEngine });
        expect(await liveSettings.get('realuser')).toBeNull();
        const liveWorlds = new WorldInfoRepo({ engine: dstEngine });
        expect(await liveWorlds.get('realuser', 'world1')).toBeNull();
        const liveChats = new ChatRepo({ engine: dstEngine });
        const chat = await liveChats.get('realuser', 'Alice', 'c1');
        expect(chat).not.toBeNull();
        expect(chat.body[0].mes).toBe('cross-mode 你好 🌍');
        // secrets was off — no fs-tree extract
        expect(fs.existsSync(path.join(liveDirs.root, 'secrets.json'))).toBe(false);
    });
});

describe('crossModeRestore — error paths', () => {
    test('typed failures cannot conceal a real snapshot rollback failure', async () => {
        const { recoverCrossModeFailure } = await import('../../../src/storage/migration/cross-mode-restore.js');
        const dirs = dirsForHandle('realuser');
        const backupPath = await snapshotUser({ handle: 'realuser', userRoot: dirs.root, backupRoot: path.join(dataRoot, 'backups'), engine: dstEngine });
        const held = backupPath + '-held';
        fs.renameSync(backupPath, held);
        const original = new RestoreDumpInvalidError('typed failure after destination mutation');
        const error = await recoverCrossModeFailure(original, {
            destinationStarted: true, snapshotPath: backupPath, handle: 'realuser', dirs, currentEngine: dstEngine,
        }).then(() => null, err => err);
        expect(error).toBeInstanceOf(CrossModeConversionFailedError);
        expect(error.cause).toBe(original);
        expect(error.rollback).toBe('partial');
        expect(error.snapshotPath).toBe(backupPath);
        expect(fs.existsSync(held)).toBe(true);
    });

    test('typed failures remain typed when real rollback succeeds', async () => {
        const { recoverCrossModeFailure } = await import('../../../src/storage/migration/cross-mode-restore.js');
        const dirs = dirsForHandle('realuser');
        const settings = new SettingsRepo({ engine: dstEngine });
        await settings.save('realuser', { protected: true });
        const backupPath = await snapshotUser({ handle: 'realuser', userRoot: dirs.root, backupRoot: path.join(dataRoot, 'backups'), engine: dstEngine });
        await settings.save('realuser', { changed: true });
        const original = new RestoreDumpInvalidError('typed failure after destination mutation');
        await expect(recoverCrossModeFailure(original, {
            destinationStarted: true, snapshotPath: backupPath, handle: 'realuser', dirs, currentEngine: dstEngine,
        })).rejects.toBe(original);
        expect(await settings.get('realuser')).toEqual({ protected: true });
    });
    test.each(['overwrite', 'merge'])('real destination filesystem failure reports %s recovery state', async (mode) => {
        const zipPath = path.join(dataRoot, 'src.zip');
        await buildSqliteSourceZip(zipPath, path.join(dataRoot, 'src'), 'alice');
        const settings = new SettingsRepo({ engine: dstEngine });
        await settings.save('realuser', { protected: true });
        const dirs = dirsForHandle('realuser');
        const blocker = path.join(dirs.chats, 'Alice');
        fs.writeFileSync(blocker, 'not a directory');
        const error = await crossModeRestore(zipPath, { engineKind: 'sqlite', handle: 'alice' }, dirs,
            { settings: true, chats: true }, mode, { dataRoot, currentEngine: dstEngine }).then(() => null, err => err);
        expect(error).toBeInstanceOf(CrossModeConversionFailedError);
        expect(error.rollback).toBe(mode === 'overwrite' ? 'ok' : 'merge-no-snapshot');
        expect(await settings.get('realuser')).toEqual(mode === 'overwrite' ? { protected: true } : { user_name: 'crossModeUser', custom: 'val' });
        expect(isReadOnly()).toBe(false);
    });

    test('a real rollback filesystem failure preserves the recovery path and partial warning', async () => {
        const zipPath = path.join(dataRoot, 'src.zip');
        await buildSqliteSourceZip(zipPath, path.join(dataRoot, 'src'), 'alice');
        const dirs = dirsForHandle('realuser');
        fs.writeFileSync(path.join(dirs.chats, 'Alice'), 'not a directory');
        let movedSnapshot;
        const error = await crossModeRestore(zipPath, { engineKind: 'sqlite', handle: 'alice' }, dirs,
            { settings: true, chats: true }, 'overwrite', { dataRoot, currentEngine: dstEngine,
                onProgress: event => {
                    if (event.stage !== 'settings-copied') return;
                    const backupRoot = path.join(dataRoot, '_storage-migrations');
                    const snapshot = fs.readdirSync(backupRoot).find(name => name.endsWith('-realuser'));
                    movedSnapshot = path.join(backupRoot, snapshot + '-held');
                    fs.renameSync(path.join(backupRoot, snapshot), movedSnapshot);
                },
            }).then(() => null, err => err);
        expect(error.rollback).toBe('partial');
        expect(error.rollbackError).toBeInstanceOf(Error);
        expect(error.snapshotPath).toBeTruthy();
        expect(fs.existsSync(movedSnapshot)).toBe(true);
        expect(isReadOnly()).toBe(false);
    });

    test('a real snapshot copy failure leaves destination data untouched', async () => {
        const zipPath = path.join(dataRoot, 'src.zip');
        await buildSqliteSourceZip(zipPath, path.join(dataRoot, 'src'), 'alice');
        const settings = new SettingsRepo({ engine: dstEngine });
        await settings.save('realuser', { protected: true });
        const dirs = dirsForHandle('realuser');
        fs.writeFileSync(path.join(dirs.root, 'luker-storage.sqlite'), 'unreadable SQLite database');
        const brokenEngine = new SqliteEngine({ directoriesByHandle: () => dirs });
        try {
            const error = await crossModeRestore(zipPath, { engineKind: 'sqlite', handle: 'alice' }, dirs,
                { settings: true }, 'overwrite', { dataRoot, currentEngine: brokenEngine }).then(() => null, err => err);
            expect(error.rollback).toBe('not-started');
            expect(error.snapshotPath).toBeNull();
            expect(await settings.get('realuser')).toEqual({ protected: true });
            expect(isReadOnly()).toBe(false);
        } finally { brokenEngine.close(); }
    });
    test.each(['overwrite', 'merge'])('generic materialization failure leaves %s destination untouched', async (mode) => {
        const live = new SettingsRepo({ engine: dstEngine });
        await live.save('realuser', { protected: true });
        const error = await crossModeRestore(path.join(dataRoot, 'missing.zip'),
            { engineKind: 'sqlite', handle: 'source' }, dirsForHandle('realuser'),
            { settings: true }, mode, { dataRoot, currentEngine: dstEngine }).then(() => null, err => err);
        expect(error).toBeInstanceOf(CrossModeConversionFailedError);
        expect(error.rollback).toBe('not-started');
        expect(error.snapshotPath).toBeNull();
        expect(await live.get('realuser')).toEqual({ protected: true });
        expect(isReadOnly()).toBe(false);
    });
    let dataRoot, dstRoot, dstEngine, dirsForHandle;
    beforeEach(() => {
        dataRoot = makeTempRoot();
        dstRoot = path.join(dataRoot, 'dst');
        ({ engine: dstEngine, dirsForHandle } = makeMultiHandleFsEngine({ root: dstRoot }));
        dirsForHandle('realuser');
    });
    afterEach(async () => {
        setReadOnly(false);
        try { await dstEngine.close(); } catch { /* ignore */ }
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    test('mysql ZIP without scratch creds throws CrossModeScratchCredsRequiredError', async () => {
        const zipPath = path.join(dataRoot, 'mysql.zip');
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append('{}', { name: 'manifest.json' });
            arc.append(JSON.stringify({ engineKind: 'mysql', schemaVersion: 1, handle: 'x' }), { name: ENGINE_META_ENTRY });
            arc.append('placeholder', { name: ENGINE_DUMP_ENTRY });
            arc.finalize();
        });

        await expect(crossModeRestore(
            zipPath,
            { engineKind: 'mysql', handle: 'x' },
            dirsForHandle('realuser'),
            { chats: true },
            'merge',
            { dataRoot, currentEngine: dstEngine, scratchCreds: null },
        )).rejects.toThrow(CrossModeScratchCredsRequiredError);

        // Read-only flag must NOT linger after the throw.
        expect(isReadOnly()).toBe(false);
    });

    test('postgres ZIP without scratch creds throws CrossModeScratchCredsRequiredError', async () => {
        const zipPath = path.join(dataRoot, 'pg.zip');
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append('{}', { name: 'manifest.json' });
            arc.append(JSON.stringify({ engineKind: 'postgres', schemaVersion: 1, handle: 'x' }), { name: ENGINE_META_ENTRY });
            arc.append('placeholder', { name: ENGINE_DUMP_ENTRY });
            arc.finalize();
        });

        await expect(crossModeRestore(
            zipPath,
            { engineKind: 'postgres', handle: 'x' },
            dirsForHandle('realuser'),
            { chats: true },
            'merge',
            { dataRoot, currentEngine: dstEngine, scratchCreds: null },
        )).rejects.toThrow(CrossModeScratchCredsRequiredError);
    });

    test('lock contention → MIGRATION_LOCKED', async () => {
        const zipPath = path.join(dataRoot, 'src.zip');
        await buildSqliteSourceZip(zipPath, path.join(dataRoot, 'src'), 'alice');

        // Pre-acquire the lock from a "different" holder.
        const otherHolder = makeHolderId();
        fs.mkdirSync(dataRoot, { recursive: true });
        await acquireMigrationLock({ dataRoot, holderId: otherHolder });

        try {
            const err = await crossModeRestore(
                zipPath,
                { engineKind: 'sqlite', handle: 'alice' },
                dirsForHandle('realuser'),
                { chats: true },
                'overwrite',
                { dataRoot, currentEngine: dstEngine },
            ).then(() => null, e => e);
            expect(err).not.toBeNull();
            expect(err.code).toBe('MIGRATION_LOCKED');
        } finally {
            await releaseMigrationLock({ dataRoot, holderId: otherHolder });
        }
    });

    test('rollback: dest write failure restores live data from snapshot', async () => {
        const zipPath = path.join(dataRoot, 'src.zip');
        await buildSqliteSourceZip(zipPath, path.join(dataRoot, 'src'), 'alice');

        // Seed live data so the snapshot has something to restore back to.
        const liveSettings = new SettingsRepo({ engine: dstEngine });
        const liveChats = new ChatRepo({ engine: dstEngine });
        await liveSettings.save('realuser', { user_name: 'PRE_RESTORE', protected: true });
        await liveChats.save('realuser', 'OldChar', 'oldChat',
            { user_name: 'PRE_RESTORE' },
            [{ name: 'Pre', mes: 'pre-restore message', is_user: true }], null);

        // Sabotage the live engine so any chat.save during migration throws.
        // We wrap currentEngine.withTransaction to fail when a chat-kind put
        // arrives. Easier: monkey-patch the ChatRepo write boundary.
        const originalSave = dstEngine.withTransaction.bind(dstEngine);
        const sabotagedEngine = {
            kind: dstEngine.kind,
            withTransaction(handle, fn) {
                return originalSave(handle, async (tx) => {
                    const origPutResource = tx.putResource ? tx.putResource.bind(tx) : null;
                    if (origPutResource) {
                        tx.putResource = async (key, value) => {
                            if (key && key.kind === 'chat') {
                                throw new Error('intentional chat write failure for rollback test');
                            }
                            return origPutResource(key, value);
                        };
                    }
                    return fn(tx);
                });
            },
            ping: (...args) => dstEngine.ping(...args),
            dumpUser: (...args) => dstEngine.dumpUser(...args),
            restoreUser: (...args) => dstEngine.restoreUser(...args),
            deleteUser: (...args) => dstEngine.deleteUser(...args),
            close: (...args) => dstEngine.close(...args),
        };

        const selection = {
            settings: true, chats: true, lorebooks: true,
            secrets: false, presets: false, characters: false, assets: false,
            extensions: false, globalExtensions: false, vectors: false,
        };
        const liveDirs = dirsForHandle('realuser');

        const err = await crossModeRestore(
            zipPath,
            { engineKind: 'sqlite', handle: 'alice' },
            liveDirs,
            selection,
            'overwrite',
            { dataRoot, currentEngine: sabotagedEngine },
        ).then(() => null, e => e);

        expect(err).toBeInstanceOf(CrossModeConversionFailedError);
        expect(err.rollback).toBe('ok');
        // Live data is back to PRE_RESTORE state.
        expect((await liveSettings.get('realuser'))?.user_name).toBe('PRE_RESTORE');
        const oldChat = await liveChats.get('realuser', 'OldChar', 'oldChat');
        expect(oldChat?.body[0]?.mes).toBe('pre-restore message');
    });

    test('merge mode: no snapshot is taken; partial state warned', async () => {
        const zipPath = path.join(dataRoot, 'src.zip');
        await buildSqliteSourceZip(zipPath, path.join(dataRoot, 'src'), 'alice');

        // Sabotage so the conversion fails.
        const originalSave = dstEngine.withTransaction.bind(dstEngine);
        const sabotagedEngine = {
            kind: dstEngine.kind,
            withTransaction(handle, fn) {
                return originalSave(handle, async (tx) => {
                    const origPutResource = tx.putResource ? tx.putResource.bind(tx) : null;
                    if (origPutResource) {
                        tx.putResource = async (key, value) => {
                            if (key && key.kind === 'settings') {
                                throw new Error('merge-mode failure');
                            }
                            return origPutResource(key, value);
                        };
                    }
                    return fn(tx);
                });
            },
            ping: (...args) => dstEngine.ping(...args),
            dumpUser: (...args) => dstEngine.dumpUser(...args),
            restoreUser: (...args) => dstEngine.restoreUser(...args),
            deleteUser: (...args) => dstEngine.deleteUser(...args),
            close: (...args) => dstEngine.close(...args),
        };

        const err = await crossModeRestore(
            zipPath,
            { engineKind: 'sqlite', handle: 'alice' },
            dirsForHandle('realuser'),
            { settings: true },
            'merge',
            { dataRoot, currentEngine: sabotagedEngine },
        ).then(() => null, e => e);

        expect(err).toBeInstanceOf(CrossModeConversionFailedError);
        expect(err.rollback).toBe('merge-no-snapshot');
        expect(err.snapshotPath).toBeNull();
    });
});

describe('extractFsTreeCategories', () => {
    let dataRoot;
    beforeEach(() => { dataRoot = makeTempRoot(); });
    afterEach(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

    function buildDirs(root) {
        return {
            root,
            backups: path.join(root, 'backups'),
            characters: path.join(root, 'characters'),
            avatars: path.join(root, 'User Avatars'),
            backgrounds: path.join(root, 'backgrounds'),
            assets: path.join(root, 'assets'),
            files: path.join(root, 'user', 'files'),
            userImages: path.join(root, 'user', 'images'),
            comfyWorkflows: path.join(root, 'user', 'workflows'),
            extensions: path.join(root, 'extensions'),
            vectors: path.join(root, 'vectors'),
        };
    }

    test('extracts selected categories, skips engine sentinels and unselected', async () => {
        const zipPath = path.join(dataRoot, 'tree.zip');
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append('{}', { name: 'manifest.json' });
            arc.append(JSON.stringify({ engineKind: 'sqlite' }), { name: ENGINE_META_ENTRY });
            arc.append('dump', { name: ENGINE_DUMP_ENTRY });
            arc.append('{"k":"v"}', { name: 'secrets.json' });
            arc.append('PNGDATA', { name: 'characters/Alice.png' });
            arc.append('VECDATA', { name: 'vectors/foo.bin' });
            arc.append('IGNORE', { name: 'assets/should-skip.bin' });
            arc.finalize();
        });

        const liveRoot = path.join(dataRoot, 'live');
        const dirs = buildDirs(liveRoot);
        // Pre-create at least the root.
        fs.mkdirSync(liveRoot, { recursive: true });

        const result = await extractFsTreeCategories(zipPath, dirs, {
            secrets: true, characters: true, vectors: true, assets: false,
        }, {});
        expect(result.restoredCount).toBe(3);
        expect(fs.existsSync(path.join(liveRoot, 'secrets.json'))).toBe(true);
        expect(fs.existsSync(path.join(dirs.characters, 'Alice.png'))).toBe(true);
        expect(fs.existsSync(path.join(dirs.vectors, 'foo.bin'))).toBe(true);
        // assets was off — skipped.
        expect(fs.existsSync(path.join(dirs.assets, 'should-skip.bin'))).toBe(false);
        // Engine sentinels never appear on disk.
        expect(fs.existsSync(path.join(liveRoot, ENGINE_META_ENTRY))).toBe(false);
        expect(fs.existsSync(path.join(liveRoot, ENGINE_DUMP_ENTRY))).toBe(false);
    });

    test('overwrites a pre-existing read-only file', async () => {
        const zipPath = path.join(dataRoot, 'tree.zip');
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append('{}', { name: 'manifest.json' });
            arc.append('NEW', { name: 'extensions/repo/.git/objects/aa/bb' });
            arc.finalize();
        });

        const liveRoot = path.join(dataRoot, 'live');
        const dirs = buildDirs(liveRoot);
        const gitObject = path.join(dirs.extensions, 'repo', '.git', 'objects', 'aa', 'bb');
        fs.mkdirSync(path.dirname(gitObject), { recursive: true });
        fs.writeFileSync(gitObject, 'OLD');
        fs.chmodSync(gitObject, 0o444);

        const result = await extractFsTreeCategories(zipPath, dirs, { extensions: true }, {});
        expect(result.restoredCount).toBe(1);
        expect(fs.readFileSync(gitObject, 'utf8')).toBe('NEW');
    });

    test('refuses path-traversal entries', () => {
        // Pure unit on matchFsTreeRule for clarity.
        const rules = _internals.buildFsTreeRules(
            new Set(['characters']),
            buildDirs('/tmp/fake'),
        );
        expect(_internals.matchFsTreeRule('characters/../../etc/passwd', rules)).toBeNull();
        expect(_internals.matchFsTreeRule('/etc/passwd', rules)).toBeNull();
        expect(_internals.matchFsTreeRule('characters\0sneaky', rules)).toBeNull();
        expect(_internals.matchFsTreeRule('characters/Alice.png', rules)).toBe(path.resolve('/tmp/fake/characters/Alice.png'));
    });

    test('empty selection returns immediately', async () => {
        const zipPath = path.join(dataRoot, 'tree.zip');
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append('{}', { name: 'manifest.json' });
            arc.finalize();
        });
        const result = await extractFsTreeCategories(zipPath, buildDirs(path.join(dataRoot, 'x')), {}, {});
        expect(result.restoredCount).toBe(0);
    });

    test('rejects cleanly on obstructed write path without hanging or leaking open zip handle', async () => {
        const zipPath = path.join(dataRoot, 'obstructed.zip');
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append('{"k":"v"}', { name: 'secrets.json' });
            arc.finalize();
        });
        const liveRoot = path.join(dataRoot, 'live-obstructed');
        const dirs = buildDirs(liveRoot);
        fs.mkdirSync(path.join(liveRoot, 'secrets.json'), { recursive: true });

        await expect(extractFsTreeCategories(zipPath, dirs, { secrets: true }, {})).rejects.toThrow(/EISDIR|directory/i);
    });

    test('extracts backups/ entries according to chats, settings, and secrets selection', async () => {
        const zipPath = path.join(dataRoot, 'backups-split.zip');
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append('{"chat_metadata":{}}\n{"name":"Alice","mes":"hi"}\n', { name: 'backups/chat_alice_20260101-120000.jsonl' });
            arc.append('{"user_name":"snap"}', { name: 'backups/settings_default-user_20260101-120000.json' });
            arc.append('{"name":"sys"}', { name: 'backups/_sysprompt/default.json' });
            arc.append('{"api_key":"secret"}', { name: 'backups/secrets_migration_1700000000000.json' });
            arc.finalize();
        });

        const chatsOnlyRoot = path.join(dataRoot, 'chats-only');
        const chatsOnlyDirs = buildDirs(chatsOnlyRoot);
        fs.mkdirSync(chatsOnlyRoot, { recursive: true });
        const chatsResult = await extractFsTreeCategories(zipPath, chatsOnlyDirs, { chats: true }, {});
        expect(chatsResult.restoredCount).toBe(1);
        expect(fs.existsSync(path.join(chatsOnlyDirs.backups, 'chat_alice_20260101-120000.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(chatsOnlyDirs.backups, 'settings_default-user_20260101-120000.json'))).toBe(false);
        expect(fs.existsSync(path.join(chatsOnlyDirs.backups, '_sysprompt', 'default.json'))).toBe(false);
        expect(fs.existsSync(path.join(chatsOnlyDirs.backups, 'secrets_migration_1700000000000.json'))).toBe(false);

        const settingsOnlyRoot = path.join(dataRoot, 'settings-only');
        const settingsOnlyDirs = buildDirs(settingsOnlyRoot);
        fs.mkdirSync(settingsOnlyRoot, { recursive: true });
        const settingsResult = await extractFsTreeCategories(zipPath, settingsOnlyDirs, { settings: true }, {});
        expect(settingsResult.restoredCount).toBe(2);
        expect(fs.existsSync(path.join(settingsOnlyDirs.backups, 'chat_alice_20260101-120000.jsonl'))).toBe(false);
        expect(fs.existsSync(path.join(settingsOnlyDirs.backups, 'settings_default-user_20260101-120000.json'))).toBe(true);
        expect(fs.existsSync(path.join(settingsOnlyDirs.backups, '_sysprompt', 'default.json'))).toBe(true);
        expect(fs.existsSync(path.join(settingsOnlyDirs.backups, 'secrets_migration_1700000000000.json'))).toBe(false);

        const secretsOnlyRoot = path.join(dataRoot, 'secrets-only');
        const secretsOnlyDirs = buildDirs(secretsOnlyRoot);
        fs.mkdirSync(secretsOnlyRoot, { recursive: true });
        const secretsResult = await extractFsTreeCategories(zipPath, secretsOnlyDirs, { secrets: true }, {});
        expect(secretsResult.restoredCount).toBe(1);
        expect(fs.existsSync(path.join(secretsOnlyDirs.backups, 'secrets_migration_1700000000000.json'))).toBe(true);
    });
});

describe('crossModeRestore — fs ZIP to sqlite preserves chat backups', () => {
    let dataRoot;
    let sqliteEngine;

    beforeEach(() => {
        dataRoot = makeTempRoot();
    });

    afterEach(async () => {
        setReadOnly(false);
        try { await sqliteEngine?.close(); } catch { /* ignore */ }
        sqliteEngine = null;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    test('restoring a legacy fs backup ZIP into sqlite restores backups/chat_*.jsonl when chats is selected', async () => {
        const zipPath = path.join(dataRoot, 'legacy-fs.zip');
        const chatBackupContent = '{"chat_metadata":{}}\n{"name":"Alice","mes":"from backup"}\n';
        const settingsBackupContent = '{"theme":"classic"}';
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append('{"chat_metadata":{}}\n{"name":"Alice","mes":"live chat"}\n', { name: 'chats/Alice/c1.jsonl' });
            arc.append(chatBackupContent, { name: 'backups/chat_alice_20260101-120000.jsonl' });
            arc.append(settingsBackupContent, { name: 'backups/settings_default-user_20260101-120000.json' });
            arc.finalize();
        });

        const liveRoot = path.join(dataRoot, 'realuser');
        const liveDirs = {
            root: liveRoot,
            backups: path.join(liveRoot, 'backups'),
            characters: path.join(liveRoot, 'characters'),
            avatars: path.join(liveRoot, 'User Avatars'),
            backgrounds: path.join(liveRoot, 'backgrounds'),
            assets: path.join(liveRoot, 'assets'),
            files: path.join(liveRoot, 'user', 'files'),
            userImages: path.join(liveRoot, 'user', 'images'),
            comfyWorkflows: path.join(liveRoot, 'user', 'workflows'),
            extensions: path.join(liveRoot, 'extensions'),
            vectors: path.join(liveRoot, 'vectors'),
        };
        fs.mkdirSync(liveDirs.backups, { recursive: true });
        sqliteEngine = new SqliteEngine({ directoriesByHandle: () => liveDirs });

        await crossModeRestore(
            zipPath,
            { engineKind: 'fs' },
            liveDirs,
            { chats: true, settings: false },
            'merge',
            { dataRoot, currentEngine: sqliteEngine },
        );

        const chatBackupPath = path.join(liveDirs.backups, 'chat_alice_20260101-120000.jsonl');
        const settingsBackupPath = path.join(liveDirs.backups, 'settings_default-user_20260101-120000.json');
        expect(fs.existsSync(chatBackupPath)).toBe(true);
        expect(fs.readFileSync(chatBackupPath, 'utf8')).toBe(chatBackupContent);
        expect(fs.existsSync(settingsBackupPath)).toBe(false);
    });
});
