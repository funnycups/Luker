// Unit tests for materializeTransientSource.
//
// Coverage:
//   - fs source: extracts on-disk tree, engine reads expected data, cleanup
//     removes scratch dir.
//   - sqlite source: writes engine_dump to luker-storage.sqlite, engine
//     reads through it, cleanup closes + removes.
//   - mysql/pg source (skipped without LUKER_*_TESTS env): connects to
//     scratch DB, restores dump into scratch handle, cleanup deletes the
//     handle and closes the pool.
//   - Failure: missing _engine_dump.bin on non-fs sources throws.
//   - Failure: invalid scratch creds → CrossModeScratchConnectionError.
//   - Cleanup idempotency: calling cleanup() twice is a no-op.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import archiver from 'archiver';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { materializeTransientSource } from '../../../src/storage/migration/transient-source.js';
import { CrossModeScratchConnectionError } from '../../../src/storage/migration/cross-mode-errors.js';
import { ENGINE_DUMP_ENTRY, ENGINE_META_ENTRY, SCRATCH_HANDLE_PREFIX } from '../../../src/storage/engine-backup-entries.js';
import { FsEngine } from '../../../src/storage/engines/fs-engine.js';
import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';

function makeScratchHandle() {
    return SCRATCH_HANDLE_PREFIX + randomBytes(8).toString('hex');
}

function makeTempDataRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'luker-trsource-'));
}

// Build a fs-source ZIP that mirrors what createBackupArchive would emit
// for an fs server: manifest.json + a fs tree of user files.
async function buildFsSourceZip(zipPath, { handle = 'alice' } = {}) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        arc.append(
            JSON.stringify({ schemaVersion: 1, handle, selection: { chats: true, settings: true, lorebooks: true } }),
            { name: 'manifest.json' },
        );
        arc.append(JSON.stringify({ user_name: 'roundtrip', custom: 'A' }), { name: 'settings.json' });
        arc.append(
            JSON.stringify({ user_name: 'roundtrip' }) + '\n' +
            JSON.stringify({ name: 'User', mes: 'hi 你好 🌍', is_user: true }) + '\n' +
            JSON.stringify({ name: 'Alice', mes: 'hello 世界 ✨', is_user: false }),
            { name: 'chats/Alice/c1.jsonl' },
        );
        arc.append(JSON.stringify({ entries: { '0': { content: 'hi', key: ['x'] } } }), { name: 'worlds/MyWorld.json' });
        arc.finalize();
    });
}

// Build a sqlite-source ZIP: manifest + engine_meta + engine_dump.bin
// (binary copy of a .sqlite file we generate by writing through a real
// SqliteEngine), plus any fs-tree files the test wants (secrets.json).
async function buildSqliteSourceZip(zipPath, { handle = 'alice', dataRoot }) {
    // Seed a real SqliteEngine with data, then capture its dump.
    const userRoot = path.join(dataRoot, 'src');
    fs.mkdirSync(userRoot, { recursive: true });
    const engine = new SqliteEngine({ directoriesByHandle: (h) => {
        if (h !== handle) throw new Error('h mismatch');
        return { root: userRoot };
    } });
    try {
        const chatRepo = new ChatRepo({ engine });
        const settingsRepo = new SettingsRepo({ engine });
        const worldRepo = new WorldInfoRepo({ engine });
        await settingsRepo.save(handle, { user_name: 'roundtrip', custom: 'A' });
        await chatRepo.save(handle, 'Alice', 'c1',
            { user_name: 'roundtrip' },
            [
                { name: 'User', mes: 'hi 你好 🌍', is_user: true },
                { name: 'Alice', mes: 'hello 世界 ✨', is_user: false },
            ], null);
        await worldRepo.save(handle, 'MyWorld', { entries: { '0': { content: 'hi' } } });
    } finally {
        engine.close();
    }
    const dumpPath = path.join(dataRoot, 'src', 'luker-storage.sqlite');
    const dumpBytes = fs.readFileSync(dumpPath);

    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        arc.append(JSON.stringify({ schemaVersion: 1, handle, selection: {} }), { name: 'manifest.json' });
        arc.append(JSON.stringify({ engineKind: 'sqlite', schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle }), { name: ENGINE_META_ENTRY });
        arc.append(dumpBytes, { name: ENGINE_DUMP_ENTRY });
        arc.append('{"openrouter":"xxx"}', { name: 'secrets.json' });
        arc.finalize();
    });
}

// Build a mysql or postgres source ZIP from a live DB harness, using the
// engine's own dumpUser to produce _engine_dump.bin.
async function buildDbSourceZip(zipPath, { handle, engine, kind }) {
    const dumpStream = await engine.dumpUser(handle);
    const tmpDump = path.join(os.tmpdir(), `luker-trsource-dump-${randomBytes(4).toString('hex')}.bin`);
    await pipeline(dumpStream, fs.createWriteStream(tmpDump));
    const dumpBytes = fs.readFileSync(tmpDump);
    fs.rmSync(tmpDump, { force: true });

    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        arc.append(JSON.stringify({ schemaVersion: 1, handle, selection: {} }), { name: 'manifest.json' });
        arc.append(JSON.stringify({ engineKind: kind, schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle }), { name: ENGINE_META_ENTRY });
        arc.append(dumpBytes, { name: ENGINE_DUMP_ENTRY });
        arc.finalize();
    });
}

describe('materializeTransientSource — fs', () => {
    let dataRoot;
    beforeEach(() => { dataRoot = makeTempDataRoot(); });
    afterEach(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

    test('fs source extracts the tree and engine reads expected data', async () => {
        const zipPath = path.join(dataRoot, 'fs.zip');
        await buildFsSourceZip(zipPath);

        const scratchHandle = makeScratchHandle();
        const transient = await materializeTransientSource(
            { engineKind: 'fs', handle: 'alice' },
            zipPath,
            { dataRoot, scratchHandle, scratchCreds: null },
        );
        try {
            // scratchRoot should contain settings.json and chats/
            expect(fs.existsSync(path.join(transient.scratchDirs.root, 'settings.json'))).toBe(true);
            expect(fs.existsSync(path.join(transient.scratchDirs.root, 'chats', 'Alice', 'c1.jsonl'))).toBe(true);
            expect(fs.existsSync(path.join(transient.scratchDirs.root, 'worlds', 'MyWorld.json'))).toBe(true);
            // Engine reads through it
            const settings = new SettingsRepo({ engine: transient.engine });
            expect((await settings.get(scratchHandle)).user_name).toBe('roundtrip');
            const chats = new ChatRepo({ engine: transient.engine });
            const chat = await chats.get(scratchHandle, 'Alice', 'c1');
            expect(chat.body[0].mes).toBe('hi 你好 🌍');
        } finally {
            await transient.cleanup();
        }
        // Cleanup removes the scratch dir.
        expect(fs.existsSync(transient.scratchDirs.root)).toBe(false);
    });

    test('cleanup() is idempotent', async () => {
        const zipPath = path.join(dataRoot, 'fs.zip');
        await buildFsSourceZip(zipPath);
        const scratchHandle = makeScratchHandle();
        const transient = await materializeTransientSource(
            { engineKind: 'fs', handle: 'alice' }, zipPath,
            { dataRoot, scratchHandle, scratchCreds: null },
        );
        await transient.cleanup();
        // Second cleanup should not throw.
        await expect(transient.cleanup()).resolves.toBeUndefined();
    });

    test('rejects scratchHandle without the required prefix', async () => {
        const zipPath = path.join(dataRoot, 'fs.zip');
        await buildFsSourceZip(zipPath);
        await expect(materializeTransientSource(
            { engineKind: 'fs' }, zipPath,
            { dataRoot, scratchHandle: 'realuser', scratchCreds: null },
        )).rejects.toThrow(/scratchHandle/);
    });

    test('rejects unknown engineKind', async () => {
        const zipPath = path.join(dataRoot, 'fs.zip');
        await buildFsSourceZip(zipPath);
        await expect(materializeTransientSource(
            { engineKind: 'oracle' }, zipPath,
            { dataRoot, scratchHandle: makeScratchHandle(), scratchCreds: null },
        )).rejects.toThrow(/unsupported engineKind/);
    });
});

describe('materializeTransientSource — sqlite', () => {
    let dataRoot;
    beforeEach(() => { dataRoot = makeTempDataRoot(); });
    afterEach(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

    test('sqlite source restores the .sqlite file, engine reads through it', async () => {
        const zipPath = path.join(dataRoot, 'sqlite.zip');
        await buildSqliteSourceZip(zipPath, { handle: 'alice', dataRoot });

        const scratchHandle = makeScratchHandle();
        const transient = await materializeTransientSource(
            { engineKind: 'sqlite', handle: 'alice' },
            zipPath,
            { dataRoot, scratchHandle, scratchCreds: null },
        );
        try {
            // The .sqlite file lands at scratchRoot/luker-storage.sqlite.
            expect(fs.existsSync(path.join(transient.scratchDirs.root, 'luker-storage.sqlite'))).toBe(true);
            // fs-tree entries (secrets.json) are also extracted.
            expect(fs.existsSync(path.join(transient.scratchDirs.root, 'secrets.json'))).toBe(true);
            // The transient rewrites every `handle` column to scratchHandle so
            // the engine's WHERE-handle queries see the imported rows. Reads
            // at the source handle ('alice') now return nothing — only
            // scratchHandle works.
            const settings = new SettingsRepo({ engine: transient.engine });
            expect((await settings.get(scratchHandle))?.user_name).toBe('roundtrip');
            const chats = new ChatRepo({ engine: transient.engine });
            const chat = await chats.get(scratchHandle, 'Alice', 'c1');
            expect(chat.body[1].mes).toBe('hello 世界 ✨');
        } finally {
            await transient.cleanup();
        }
        expect(fs.existsSync(transient.scratchDirs.root)).toBe(false);
    });

    test('sqlite source missing _engine_dump.bin throws', async () => {
        const zipPath = path.join(dataRoot, 'bad-sqlite.zip');
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append(JSON.stringify({ schemaVersion: 1 }), { name: 'manifest.json' });
            arc.append(JSON.stringify({ engineKind: 'sqlite', schemaVersion: 1 }), { name: ENGINE_META_ENTRY });
            arc.finalize();
        });

        await expect(materializeTransientSource(
            { engineKind: 'sqlite', handle: 'x' },
            zipPath,
            { dataRoot, scratchHandle: makeScratchHandle(), scratchCreds: null },
        )).rejects.toThrow(/_engine_dump.bin/);
    });
});

// mysql / pg tests: skip without local test DB. Both follow the same shape:
// seed a real engine with data, build a ZIP from its dumpUser, then
// materialize and assert the scratch handle on the engine reads through it.
const skipMysql = !!process.env.LUKER_DISABLE_MYSQL_TESTS;
const describeMysql = skipMysql ? describe.skip : describe;
describeMysql('materializeTransientSource — mysql', () => {
    let makeTempMysqlEngineHarness;
    let dataRoot;
    beforeAll(async () => {
        ({ makeTempMysqlEngineHarness } = await import('../harness/mysql-harness.js'));
    });
    beforeEach(() => { dataRoot = makeTempDataRoot(); });
    afterEach(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

    test('mysql source restores under scratch handle (handle rewrite verified)', async () => {
        const srcHarness = await makeTempMysqlEngineHarness();
        try {
            const settingsRepo = new SettingsRepo({ engine: srcHarness.engine });
            const chatRepo = new ChatRepo({ engine: srcHarness.engine });
            await settingsRepo.save(srcHarness.handle, { custom: 'mysql-test', extra: 'value' });
            await chatRepo.save(srcHarness.handle, 'Alice', 'c1',
                { user_name: 'mysql' },
                [{ name: 'User', mes: 'hi 你好 🌍', is_user: true }], null);

            const zipPath = path.join(dataRoot, 'mysql.zip');
            await buildDbSourceZip(zipPath, { handle: srcHarness.handle, engine: srcHarness.engine, kind: 'mysql' });

            const scratchHandle = makeScratchHandle();
            const transient = await materializeTransientSource(
                { engineKind: 'mysql', handle: srcHarness.handle },
                zipPath,
                {
                    dataRoot,
                    scratchHandle,
                    // Re-use the harness DB as the operator's scratch DB.
                    scratchCreds: { mysqlUrl: srcHarness.engine._pool?.config?.connectionConfig?.uri || `mysql://root:root@127.0.0.1:53306/${srcHarness.dbName}` },
                },
            );
            try {
                // Rows must be visible at scratchHandle, NOT srcHandle on the
                // dst-side reads (handle rewrite is the contract).
                const settingsAtScratch = new SettingsRepo({ engine: transient.engine });
                const got = await settingsAtScratch.get(scratchHandle);
                expect(got).toEqual({ custom: 'mysql-test', extra: 'value' });
                const chatAtScratch = new ChatRepo({ engine: transient.engine });
                const chat = await chatAtScratch.get(scratchHandle, 'Alice', 'c1');
                expect(chat.body[0].mes).toBe('hi 你好 🌍');
            } finally {
                await transient.cleanup();
            }
            // After cleanup, scratch handle is gone from the DB.
            const settingsAfter = new SettingsRepo({ engine: srcHarness.engine });
            expect(await settingsAfter.get(scratchHandle)).toBeNull();
        } finally {
            await srcHarness.cleanup();
        }
    });

    test('mysql source with bad connection URL throws CrossModeScratchConnectionError', async () => {
        const zipPath = path.join(dataRoot, 'mysql-bad.zip');
        // Build a minimal zip with just engine_meta + a token dump
        // (the connection failure short-circuits before we use the dump).
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append(JSON.stringify({ schemaVersion: 1 }), { name: 'manifest.json' });
            arc.append(JSON.stringify({ engineKind: 'mysql', schemaVersion: 1 }), { name: ENGINE_META_ENTRY });
            arc.append('placeholder', { name: ENGINE_DUMP_ENTRY });
            arc.finalize();
        });
        await expect(materializeTransientSource(
            { engineKind: 'mysql', handle: 'x' },
            zipPath,
            {
                dataRoot,
                scratchHandle: makeScratchHandle(),
                scratchCreds: { mysqlUrl: 'mysql://nobody:wrong@127.0.0.1:1/none' },
            },
        )).rejects.toThrow(CrossModeScratchConnectionError);
    });
});

const skipPg = !!process.env.LUKER_DISABLE_POSTGRES_TESTS;
const describePg = skipPg ? describe.skip : describe;
describePg('materializeTransientSource — postgres', () => {
    let makeTempPgEngineHarness;
    let dataRoot;
    beforeAll(async () => {
        ({ makeTempPgEngineHarness } = await import('../harness/pg-harness.js'));
    });
    beforeEach(() => { dataRoot = makeTempDataRoot(); });
    afterEach(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

    test('postgres source restores under scratch handle', async () => {
        const srcHarness = await makeTempPgEngineHarness();
        try {
            const settingsRepo = new SettingsRepo({ engine: srcHarness.engine });
            await settingsRepo.save(srcHarness.handle, { custom: 'pg-test' });

            const zipPath = path.join(dataRoot, 'pg.zip');
            await buildDbSourceZip(zipPath, { handle: srcHarness.handle, engine: srcHarness.engine, kind: 'postgres' });

            const scratchHandle = makeScratchHandle();
            // We need the same connection URL the harness used; reuse the harness's engine config.
            const scratchUrl = srcHarness.engine._pool?.options?.connectionString
                || `postgresql://luker:postgres@127.0.0.1:55432/luker_test?options=-csearch_path%3D${encodeURIComponent(srcHarness.schemaName)}`;
            const transient = await materializeTransientSource(
                { engineKind: 'postgres', handle: srcHarness.handle },
                zipPath,
                { dataRoot, scratchHandle, scratchCreds: { postgresUrl: scratchUrl } },
            );
            try {
                const got = await new SettingsRepo({ engine: transient.engine }).get(scratchHandle);
                expect(got).toEqual({ custom: 'pg-test' });
            } finally {
                await transient.cleanup();
            }
            const after = await new SettingsRepo({ engine: srcHarness.engine }).get(scratchHandle);
            expect(after).toBeNull();
        } finally {
            await srcHarness.cleanup();
        }
    });

    test('postgres source with bad connection URL throws CrossModeScratchConnectionError', async () => {
        const zipPath = path.join(dataRoot, 'pg-bad.zip');
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append(JSON.stringify({ schemaVersion: 1 }), { name: 'manifest.json' });
            arc.append(JSON.stringify({ engineKind: 'postgres', schemaVersion: 1 }), { name: ENGINE_META_ENTRY });
            arc.append('placeholder', { name: ENGINE_DUMP_ENTRY });
            arc.finalize();
        });
        await expect(materializeTransientSource(
            { engineKind: 'postgres', handle: 'x' },
            zipPath,
            {
                dataRoot,
                scratchHandle: makeScratchHandle(),
                scratchCreds: { postgresUrl: 'postgresql://nobody:wrong@127.0.0.1:1/none' },
            },
        )).rejects.toThrow(CrossModeScratchConnectionError);
    });
});
