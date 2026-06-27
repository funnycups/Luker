// Round-trip parity: backup → wipe → restore across all 4 storage engines.
//
// Previously the backup ZIP captured only the on-disk file tree, so users
// running sqlite/mysql/postgres ended up with archives that round-tripped to
// empty databases. The ZIP must also carry an opaque
// `_engine_dump.bin` produced by `engine.dumpUser`, accompanied by an
// `_engine_meta.json` descriptor whose `engineKind` is validated on restore
// and consumed by `engine.restoreUser` instead of being written to disk.
// fs mode skips the engine-dump payload entirely; its directory tree IS the
// backup.
//
// Test bundle:
//   1. ZIP shape — db engines emit `_engine_meta.json` + `_engine_dump.bin`;
//      fs does not.
//   2. End-to-end backup → engine.deleteUser → restore-backup → every Repo
//      probe matches the seeded values.
//   3. Engine-kind mismatch — a hand-crafted ZIP whose engine_meta declares
//      a foreign kind must 400.
//
// The route accepts a multer-uploaded file under the field name `avatar` (per
// `multer().single('avatar')` in src/server-main.js — see
// public/scripts/user.js:776 for the real client). The test mounts a thin
// shim that delegates multipart parsing to real multer pointed at a temp
// uploads dir, so the request-handling path is exercised end-to-end.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import multer from 'multer';
import request from 'supertest';
import yauzl from 'yauzl';
import archiver from 'archiver';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as usersPrivateRouter } from '../../../src/endpoints/users-private.js';
import {
    getChatRepo,
    getSettingsRepo,
    getWorldInfoRepo,
    getNamedDocRepo,
    getPresetRepo,
    getGroupRepo,
    getStatsRepo,
    getStorageEngine,
} from '../../../src/storage/index.js';

const HEADER = { user_name: 'tester', character_name: 'Alice', chat_metadata: {} };
// Multi-byte UTF-8 in seeded messages guards against silent mojibake in the
// engine's restore stream decoder: CJK chars are 3 bytes and emoji are 4, so
// a buggy decoder that falls back to `chunk.toString('utf8')` at chunk
// boundaries would emit U+FFFD here. End-to-end coverage; the dedicated
// chunk-split boundary test lives in tests/storage/engines/dump-restore.parity.test.js.
const MESSAGES = [
    { name: 'User', is_user: true, mes: 'hi 你好 🌍' },
    { name: 'Alice', is_user: false, mes: 'hello 世界 ✨' },
];

// Matches USER_BACKUP_SELECTION_DEFAULTS in src/users.js plus admin-only
// globalExtensions left off. normalizeUserBackupSelection drops unknown keys
// silently, so the surface is deliberately small.
const ALL_SELECTION = {
    settings: true,
    secrets: true,
    characters: true,
    chats: true,
    lorebooks: true,
    presets: true,
    assets: true,
    extensions: true,
    globalExtensions: false,
    vectors: true,
};

async function seedAllRepos(handle) {
    await getChatRepo().save(handle, 'Alice', 'c1', HEADER, MESSAGES, null);
    await getSettingsRepo().save(handle, { user_name: 'roundtrip', custom: 'A' });
    await getWorldInfoRepo().save(handle, 'w1', { entries: {} });
    await getNamedDocRepo().save(handle, 'themes', 't1', { accent: '#abc' });
    await getPresetRepo().save(handle, 'openai', 'p1', { temperature: 0.5 });
    await getGroupRepo().save(handle, 'g1', { id: 'g1', name: 'Test', chats: [] });
    await getStatsRepo().save(handle, { totalChats: 7 });
}

async function probeAllRepos(handle) {
    return {
        chat: await getChatRepo().get(handle, 'Alice', 'c1'),
        settings: await getSettingsRepo().get(handle),
        world: await getWorldInfoRepo().get(handle, 'w1'),
        theme: await getNamedDocRepo().get(handle, 'themes', 't1'),
        preset: await getPresetRepo().get(handle, 'openai', 'p1'),
        group: await getGroupRepo().get(handle, 'g1'),
        stats: await getStatsRepo().get(handle),
    };
}

function mountMulterShim(app, uploadsDir) {
    // Real multer is the production middleware (server-main.js mounts it
    // globally with `single('avatar')` against an uploads dir under the data
    // root). Re-creating it here keeps the request path identical to prod.
    // /import/data-zip uses the same multer instance in prod (also keyed on
    // 'avatar'); mount it on both routes so the kind-mismatch / legacy-fs
    // 400 paths can be exercised end-to-end.
    fs.mkdirSync(uploadsDir, { recursive: true });
    const upload = multer({
        storage: multer.diskStorage({
            destination: (_req, _file, cb) => cb(null, uploadsDir),
        }),
    }).single('avatar');
    app.use('/api/users/restore-backup', upload);
    app.use('/api/users/import/data-zip', upload);
}

async function postBackup(harness, { handle = harness.handle, selection = ALL_SELECTION } = {}) {
    return await new Promise((resolve, reject) => {
        request(harness.app)
            .post('/api/users/backup')
            .send({ handle, selection })
            .buffer(true)
            // supertest+superagent treat ZIP responses as text by default; install
            // a binary parser that concatenates the raw bytes.
            .parse((res, cb) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => cb(null, Buffer.concat(chunks)));
                res.on('error', cb);
            })
            .end((err, res) => {
                if (err) reject(err);
                else resolve(res);
            });
    });
}

function listZipEntries(zipPath) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
            if (err) return reject(err);
            const names = [];
            zip.readEntry();
            zip.on('entry', (entry) => { names.push(entry.fileName); zip.readEntry(); });
            zip.on('end', () => resolve(names));
            zip.on('error', reject);
        });
    });
}

function readZipFile(zipPath, fileName) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
            if (err) return reject(err);
            let found = false;
            zip.readEntry();
            zip.on('entry', (entry) => {
                if (entry.fileName !== fileName) {
                    zip.readEntry();
                    return;
                }
                found = true;
                zip.openReadStream(entry, (streamErr, stream) => {
                    if (streamErr) return reject(streamErr);
                    const chunks = [];
                    stream.on('data', (c) => chunks.push(c));
                    stream.on('end', () => resolve(Buffer.concat(chunks)));
                    stream.on('error', reject);
                });
            });
            zip.on('end', () => {
                if (!found) resolve(null);
            });
            zip.on('error', reject);
        });
    });
}

describe.each(ENDPOINT_HARNESSES)('backup/restore roundtrip on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app, { dirs }) => {
                const uploadsDir = path.join(dirs.root, 'bk-uploads');
                mountMulterShim(app, uploadsDir);
                app.use('/api/users', usersPrivateRouter);
            },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('REGRESSION: backup ZIP includes engine dump iff kind !== fs', async () => {
        await seedAllRepos(harness.handle);

        const res = await postBackup(harness);
        expect(res.status).toBe(200);

        const zipBytes = res.body;
        expect(zipBytes).toBeInstanceOf(Buffer);
        expect(zipBytes.length).toBeGreaterThan(0);

        const zipPath = path.join(harness.dataRoot, `bk-${randomBytes(4).toString('hex')}.zip`);
        fs.writeFileSync(zipPath, zipBytes);

        const names = await listZipEntries(zipPath);
        expect(names).toContain('manifest.json');

        if (mode === 'fs') {
            expect(names).not.toContain('_engine_dump.bin');
            expect(names).not.toContain('_engine_meta.json');
        } else {
            expect(names).toContain('_engine_meta.json');
            expect(names).toContain('_engine_dump.bin');

            const metaBuf = await readZipFile(zipPath, '_engine_meta.json');
            expect(metaBuf).not.toBeNull();
            const meta = JSON.parse(metaBuf.toString('utf8'));
            expect(meta.engineKind).toBe(mode);
            expect(meta.schemaVersion).toBe(1);
            expect(meta.handle).toBe(harness.handle);
            expect(typeof meta.createdAt).toBe('string');

            const dumpBuf = await readZipFile(zipPath, '_engine_dump.bin');
            expect(dumpBuf).not.toBeNull();
            expect(dumpBuf.length).toBeGreaterThan(0);
        }
    });

    test('REGRESSION: backup → wipe → restore round-trips every Repo', async () => {
        if (mode === 'fs') return; // fs path round-trips via the existing directory-tree extract

        await seedAllRepos(harness.handle);
        const beforeProbe = await probeAllRepos(harness.handle);
        expect(beforeProbe.chat).not.toBeNull();
        expect(beforeProbe.settings.user_name).toBe('roundtrip');

        const backupRes = await postBackup(harness);
        expect(backupRes.status).toBe(200);
        const zipBytes = backupRes.body;
        expect(zipBytes.length).toBeGreaterThan(0);

        // Wipe via engine.deleteUser — simulates a corrupted DB the operator
        // wants to restore from backup. sqlite.deleteUser only closes the
        // cached handle (per spec §4.1 it leaves the file intact — purge is
        // the admin handler's responsibility), so we additionally remove the
        // file to make the precondition observable for sqlite too. mysql/pg
        // deleteUser truly wipes rows.
        await getStorageEngine().deleteUser(harness.handle);
        if (mode === 'sqlite') {
            const sqlitePath = path.join(harness.dirs.root, 'luker-storage.sqlite');
            if (fs.existsSync(sqlitePath)) fs.rmSync(sqlitePath);
        }
        const wipedChat = await getChatRepo().get(harness.handle, 'Alice', 'c1');
        expect(wipedChat).toBeNull();
        const wipedSettings = await getSettingsRepo().get(harness.handle);
        // settings may legitimately be null OR an empty object depending on
        // repo defaults — what matters is the seeded `user_name: 'roundtrip'`
        // is gone.
        expect(wipedSettings?.user_name).not.toBe('roundtrip');

        const restoreRes = await request(harness.app)
            .post('/api/users/restore-backup')
            .field('handle', harness.handle)
            .field('mode', 'merge')
            .field('selection', JSON.stringify(ALL_SELECTION))
            .attach('avatar', zipBytes, 'backup.zip');
        expect(restoreRes.status).toBe(200);

        const afterProbe = await probeAllRepos(harness.handle);
        expect(afterProbe.chat?.body).toEqual(MESSAGES);
        expect(afterProbe.settings?.user_name).toBe('roundtrip');
        expect(afterProbe.world?.entries).toEqual({});
        expect(afterProbe.theme?.accent).toBe('#abc');
        expect(afterProbe.preset?.temperature).toBe(0.5);
        expect(afterProbe.group?.id).toBe('g1');
        expect(afterProbe.stats?.totalChats).toBe(7);
    });

    test('REGRESSION: restore demands scratch creds when backup engine is foreign db', async () => {
        if (mode === 'fs') return; // fs has no engine_meta-driven validation path

        // Hand-craft a minimal ZIP with engine_meta declaring a foreign db kind
        // (mysql or postgres — both require operator scratch DB conn). The
        // sqlite-source-on-foreign-db case CAN succeed when the engine dump is
        // a valid .sqlite file, so we deliberately use a foreign DB kind here
        // for the "creds missing" assertion. The cross-mode delegation
        // detects mysql/postgres source without creds and returns 400 with
        // crossModeScratchRequired payload.
        const otherKind = 'postgres';
        const meta = {
            engineKind: otherKind,
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            handle: harness.handle,
        };
        const zipPath = path.join(harness.dataRoot, `bk-mismatch-${randomBytes(4).toString('hex')}.zip`);
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append(JSON.stringify({ schemaVersion: 1, handle: harness.handle, selection: ALL_SELECTION }, null, 2),
                { name: 'manifest.json' });
            arc.append(JSON.stringify(meta, null, 2), { name: '_engine_meta.json' });
            arc.append(Buffer.from('not a real dump'), { name: '_engine_dump.bin' });
            arc.finalize();
        });
        const zipBytes = fs.readFileSync(zipPath);

        const restoreRes = await request(harness.app)
            .post('/api/users/restore-backup')
            .field('handle', harness.handle)
            .field('mode', 'merge')
            .field('selection', JSON.stringify(ALL_SELECTION))
            .attach('avatar', zipBytes, 'backup.zip');
        expect(restoreRes.status).toBe(400);
        // The body must signal cross-mode-scratch-required so the UI knows
        // to prompt for a scratch DB URL and re-submit.
        expect(restoreRes.body?.crossModeScratchRequired?.kind).toBe(otherKind);
        expect(String(restoreRes.body?.error || '')).toMatch(/scratch postgres/i);
    });

    test('REGRESSION: legacy fs-only backup on db-mode server is now cross-mode-restored', async () => {
        // Previously a legacy fs-only ZIP on a db-mode server returned 400 with
        // "Run storage-migrate to convert the backup first." After cross-mode
        // recovery, the orchestrator synthesizes an `engineMeta = {engineKind:'fs'}`
        // and ingests the fs tree from the ZIP into a transient FsEngine, then
        // copies it through MigrationRunner into the live db engine. The
        // operator no longer has to drop to the CLI for the most common case.
        if (mode === 'fs') return; // fs is the legacy format's native home — extracts cleanly.

        const zipPath = path.join(harness.dataRoot, `bk-legacy-${randomBytes(4).toString('hex')}.zip`);
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append(JSON.stringify({ schemaVersion: 1, handle: harness.handle, selection: ALL_SELECTION }, null, 2),
                { name: 'manifest.json' });
            arc.append(Buffer.from(JSON.stringify(HEADER) + '\n' + MESSAGES.map(m => JSON.stringify(m)).join('\n')),
                { name: 'chats/Alice/c1.jsonl' });
            arc.finalize();
        });
        const zipBytes = fs.readFileSync(zipPath);

        const restoreRes = await request(harness.app)
            .post('/api/users/restore-backup')
            .field('handle', harness.handle)
            .field('mode', 'merge')
            .field('selection', JSON.stringify(ALL_SELECTION))
            .attach('avatar', zipBytes, 'backup.zip');
        // Cross-mode delegation succeeds — the orchestrator built a transient
        // FsEngine, ingested the chats/Alice/c1.jsonl tree, and copied it
        // into the live db engine. The response carries the crossMode envelope
        // so the client can render the conversion-specific UI.
        expect(restoreRes.status).toBe(200);
        expect(restoreRes.body?.crossMode?.sourceKind).toBe('fs');
        expect(restoreRes.body?.crossMode?.destKind).toBe(mode);
    });

    test('REGRESSION: /import/data-zip demands scratch creds on db-engine mismatch', async () => {
        // Parallel of the /restore-backup mismatch test under the new
        // cross-mode semantics: a foreign-db ZIP without scratch creds
        // returns 400 with crossModeScratchRequired payload.
        if (mode === 'fs') return; // fs has no engine_meta-driven validation path

        const otherKind = 'postgres';
        const meta = {
            engineKind: otherKind,
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            handle: harness.handle,
        };
        const zipPath = path.join(harness.dataRoot, `bk-mismatch-import-${randomBytes(4).toString('hex')}.zip`);
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append(JSON.stringify({ schemaVersion: 1, handle: harness.handle, selection: ALL_SELECTION }, null, 2),
                { name: 'manifest.json' });
            arc.append(JSON.stringify(meta, null, 2), { name: '_engine_meta.json' });
            arc.append(Buffer.from('not a real dump'), { name: '_engine_dump.bin' });
            arc.finalize();
        });
        const zipBytes = fs.readFileSync(zipPath);

        const importRes = await request(harness.app)
            .post('/api/users/import/data-zip')
            .field('mode', 'merge')
            .attach('avatar', zipBytes, 'backup.zip');
        expect(importRes.status).toBe(400);
        expect(importRes.body?.crossModeScratchRequired?.kind).toBe(otherKind);
        expect(String(importRes.body?.error || '')).toMatch(/scratch postgres/i);
    });
});
