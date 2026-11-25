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
//   3. Foreign-db source without scratch creds — a hand-crafted ZIP whose
//      engine_meta declares a different mysql/postgres kind must 400 with
//      a crossModeScratchRequired payload.
//   4. Corrupt same-engine dump — must 400 and leave the existing data
//      untouched in both merge and overwrite modes.
//   5. Corrupt foreign-engine dump — the cross-mode path must 400 the same
//      way, without a cross-mode rollback report.
//
// The route no longer takes multipart uploads itself: the client first pushes
// the ZIP through the chunked `/restore-backup/uploads` session endpoints and
// then posts the returned `uploadId` as JSON. `/import/data-zip` still takes a
// multer-uploaded file under the field name `avatar` (per
// `multer().single('avatar')` in src/server-main.js), so the test mounts a thin
// shim for that route only.

import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import multer from 'multer';
import request from 'supertest';
import yauzl from 'yauzl';
import archiver from 'archiver';

import { ENDPOINT_HARNESSES, makeEndpointHarness, uploadArchiveToSession } from '../harness/endpoint-harness.js';
import { acquireMysqlDatabase, acquirePostgresDatabase, MYSQL_ROOT_URL, PG_ROOT_URL } from '../../harness/database.js';
import { currentScopeForResources } from '../../harness/storage-scope.js';
import { router as usersPrivateRouter } from '../../../src/endpoints/users-private.js';
import { RestoreDumpInvalidError } from '../../../src/storage/errors.js';
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
    await getNamedDocRepo().save(handle, 'globalStates', 'gs1', { active: true });
    await getPresetRepo().save(handle, 'openai', 'p1', { temperature: 0.5 });
    await getPresetRepo().save(handle, 'openai', 'A.luker-state.n', { prompts: [{ content: 'BACKUP_PRESET' }] });
    await getPresetRepo().setState(handle, 'openai', 'A', 'n', { notes: ['BACKUP_ORPHAN'] });
    await getGroupRepo().save(handle, 'g1', { id: 'g1', name: 'Test', chats: [] });
    await getStatsRepo().save(handle, { totalChats: 7 });
}

async function probeAllRepos(handle) {
    return {
        chat: await getChatRepo().get(handle, 'Alice', 'c1'),
        settings: await getSettingsRepo().get(handle),
        world: await getWorldInfoRepo().get(handle, 'w1'),
        theme: await getNamedDocRepo().get(handle, 'themes', 't1'),
        globalState: await getNamedDocRepo().get(handle, 'globalStates', 'gs1'),
        preset: await getPresetRepo().get(handle, 'openai', 'p1'),
        delimiterPreset: await getPresetRepo().get(handle, 'openai', 'A.luker-state.n'),
        orphanPresetState: await getPresetRepo().getState(handle, 'openai', 'A', 'n'),
        group: await getGroupRepo().get(handle, 'g1'),
        stats: await getStatsRepo().get(handle),
    };
}

function mountMulterShim(app, uploadsDir) {
    // Real multer is the production middleware for /import/data-zip
    // (server-main.js mounts it globally with `single('avatar')` against an
    // uploads dir under the data root). Re-creating it here keeps that
    // request path identical to prod for the kind-mismatch / legacy-fs 400
    // paths exercised end-to-end below.
    fs.mkdirSync(uploadsDir, { recursive: true });
    const upload = multer({
        storage: multer.diskStorage({
            destination: (_req, _file, cb) => cb(null, uploadsDir),
        }),
    }).single('avatar');
    app.use('/api/users/import/data-zip', upload);
}

async function postBackup(harness, { handle = harness.handle, selection = ALL_SELECTION } = {}) {
    return await new Promise((resolve, reject) => {
        request(harness.server)
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

/**
 * Hand-crafted backup ZIP carrying `_engine_meta.json` with the given
 * engine kind and an arbitrary `_engine_dump.bin` payload, or no dump entry
 * when `dumpBytes` is null.
 */
async function buildEngineDumpZip(harness, engineKind, dumpBytes) {
    const meta = {
        engineKind,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        handle: harness.handle,
    };
    const zipPath = path.join(harness.dataRoot, `bk-engine-${randomBytes(4).toString('hex')}.zip`);
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        arc.append(JSON.stringify({ schemaVersion: 1, handle: harness.handle, selection: ALL_SELECTION }, null, 2),
            { name: 'manifest.json' });
        arc.append(JSON.stringify(meta, null, 2), { name: '_engine_meta.json' });
        if (dumpBytes) arc.append(dumpBytes, { name: '_engine_dump.bin' });
        arc.finalize();
    });
    return fs.readFileSync(zipPath);
}

// `sqlite` is a foreign source on every harness but sqlite; `db` is the
// mysql/postgres source that needs a scratch database. `dump` is a garbage
// payload or a ZIP without the dump entry.
const FOREIGN_INVALID_CASES = ['sqlite', 'db'].flatMap((sourceGroup) =>
    ['merge', 'overwrite'].flatMap((restoreMode) =>
        [['garbage', Buffer.from('not a real dump')], ['missing', null]].map(([dumpCase, dumpBytes]) =>
            ({ sourceGroup, restoreMode, dumpCase, dumpBytes }))));

describe.each(ENDPOINT_HARNESSES)('backup/restore roundtrip on $name', ({ mode }) => {
    let harness;
    let uploadsDir;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            handle: `backup-${randomBytes(6).toString('hex')}`,
            mount: (app, { dirs }) => {
                uploadsDir = path.join(dirs.root, 'bk-uploads');
                mountMulterShim(app, uploadsDir);
                app.use('/api/users', usersPrivateRouter);
            },
        });
        globalThis.DATA_ROOT = harness.dataRoot;
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

    test('backup restore preserves a delimiter document and its independent orphan state', async () => {
        const preset = { prompts: [{ content: 'BACKUP_PRESET' }] };
        const state = { notes: ['BACKUP_ORPHAN'] };
        await getPresetRepo().save(harness.handle, 'openai', 'A.luker-state.n', preset);
        await getPresetRepo().setState(harness.handle, 'openai', 'A', 'n', state);
        const backup = await postBackup(harness);
        expect(backup.status).toBe(200);
        await getPresetRepo().delete(harness.handle, 'openai', 'A.luker-state.n');
        await getPresetRepo().deleteState(harness.handle, 'openai', 'A', 'n');
        expect(await getPresetRepo().listWithDocs(harness.handle, 'openai')).toEqual([]);
        const uploadId = await uploadArchiveToSession(harness.server, backup.body, { handle: harness.handle });
        const restored = await request(harness.server).post('/api/users/restore-backup').send({ uploadId, handle: harness.handle, mode: 'merge', selection: ALL_SELECTION });
        expect(restored.status).toBe(200);
        expect(await getPresetRepo().get(harness.handle, 'openai', 'A.luker-state.n')).toEqual(preset);
        expect(await getPresetRepo().getState(harness.handle, 'openai', 'A', 'n')).toEqual(state);
        expect(await getPresetRepo().listWithDocs(harness.handle, 'openai')).toEqual([{ name: 'A.luker-state.n', doc: preset }]);
        expect(await getPresetRepo().get(harness.handle, 'openai', 'A')).toBeNull();
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

        const uploadId = await uploadArchiveToSession(harness.server, zipBytes, { handle: harness.handle });
        const restoreRes = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: 'merge', selection: ALL_SELECTION });
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

    test('imports a ZIP with large settings without stalling', async () => {
        // Incompressible content spans multiple ZIP read buffers and exercises
        // backpressure, unlike tiny settings fixtures or repeated padding.
        const settings = { username: 'roundtrip', custom: randomBytes(256 * 1024).toString('base64') };
        const zipPath = path.join(harness.dataRoot, 'large-settings.zip');
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const archive = archiver('zip');
            archive.on('error', reject);
            out.on('error', reject);
            out.on('close', resolve);
            archive.pipe(out);
            archive.append(JSON.stringify(settings), { name: 'settings.json' });
            archive.finalize();
        });
        await getSettingsRepo().save(harness.handle, { username: 'fresh' });

        const restoreRes = await request(harness.server)
            .post('/api/users/import/data-zip')
            .attach('avatar', zipPath)
            // Fail and close the HTTP socket before Jest's 15s test deadline
            // if extraction stalls.
            .timeout({ response: 10000 });
        expect(restoreRes.status).toBe(200);
        expect(restoreRes.body.failedCount).toBe(0);
        expect(await getSettingsRepo().get(harness.handle)).toEqual(settings);
    });

    test('REGRESSION: restore demands scratch creds when backup engine is foreign db', async () => {
        if (mode === 'fs') return; // fs has no engine_meta-driven validation path

        // The ZIP declares a mysql/postgres source that differs from the
        // harness engine, so restore takes the cross-mode path, which needs
        // operator-supplied scratch DB creds for that kind. A sqlite source
        // converts without creds, so it cannot exercise this check.
        const otherKind = mode === 'postgres' ? 'mysql' : 'postgres';
        const zipBytes = await buildEngineDumpZip(harness, otherKind, Buffer.from('not a real dump'));

        const uploadId = await uploadArchiveToSession(harness.server, zipBytes, { handle: harness.handle });
        const restoreRes = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: 'merge', selection: ALL_SELECTION });
        expect(restoreRes.status).toBe(400);
        // The body must signal cross-mode-scratch-required so the UI knows
        // to prompt for a scratch DB URL and re-submit.
        expect(restoreRes.body?.crossModeScratchRequired?.kind).toBe(otherKind);
        expect(String(restoreRes.body?.error || '')).toMatch(new RegExp(`scratch ${otherKind}`, 'i'));
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

        const uploadId = await uploadArchiveToSession(harness.server, zipBytes, { handle: harness.handle });
        const restoreRes = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: 'merge', selection: ALL_SELECTION });
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

        const otherKind = mode === 'postgres' ? 'mysql' : 'postgres';
        const zipBytes = await buildEngineDumpZip(harness, otherKind, Buffer.from('not a real dump'));

        const importRes = await request(harness.server)
            .post('/api/users/import/data-zip')
            .field('mode', 'merge')
            .attach('avatar', zipBytes, 'backup.zip');
        expect(importRes.status).toBe(400);
        expect(importRes.body?.crossModeScratchRequired?.kind).toBe(otherKind);
        expect(String(importRes.body?.error || '')).toMatch(new RegExp(`scratch ${otherKind}`, 'i'));
    });

    test.each(['merge', 'overwrite'])('REGRESSION: corrupt same-engine dump on /restore-backup (%s) returns 400 and keeps existing data', async (restoreMode) => {
        if (mode === 'fs') return; // fs backups carry no engine dump

        await seedAllRepos(harness.handle);
        const beforeProbe = await probeAllRepos(harness.handle);
        expect(beforeProbe.chat?.body).toEqual(MESSAGES);

        const zipBytes = await buildEngineDumpZip(harness, mode, Buffer.from('not a real dump'));
        const uploadId = await uploadArchiveToSession(harness.app, zipBytes, { handle: harness.handle });
        const restoreRes = await request(harness.app)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: restoreMode, selection: ALL_SELECTION });
        expect(await probeAllRepos(harness.handle)).toEqual(beforeProbe);
        expect(restoreRes.status).toBe(400);
    });

    test.each(['merge', 'overwrite'])('REGRESSION: corrupt same-engine dump on /import/data-zip (%s) returns 400 and keeps existing data', async (importMode) => {
        if (mode === 'fs') return; // fs backups carry no engine dump

        await seedAllRepos(harness.handle);
        const beforeProbe = await probeAllRepos(harness.handle);
        expect(beforeProbe.chat?.body).toEqual(MESSAGES);

        const zipBytes = await buildEngineDumpZip(harness, mode, Buffer.from('not a real dump'));
        const importRes = await request(harness.app)
            .post('/api/users/import/data-zip')
            .field('mode', importMode)
            .attach('avatar', zipBytes, 'backup.zip');
        expect(await probeAllRepos(harness.handle)).toEqual(beforeProbe);
        expect(importRes.status).toBe(400);
    });

    for (const { sourceGroup, restoreMode, dumpCase, dumpBytes } of FOREIGN_INVALID_CASES) {
        // A sqlite source on the sqlite harness is the same-engine path,
        // covered by the corrupt same-engine dump tests above.
        if (sourceGroup === 'sqlite' && mode === 'sqlite') continue;
        const sourceKind = foreignSourceKind(sourceGroup, mode);
        if (!sourceKind) {
            continue;
        }
        test(`REGRESSION: ${dumpCase} ${sourceGroup}-engine dump on /restore-backup (${restoreMode}) returns 400 and keeps existing data`, async () => {
            await seedAllRepos(harness.handle);
            const beforeProbe = await probeAllRepos(harness.handle);
            expect(beforeProbe.chat?.body).toEqual(MESSAGES);

            const scratch = await makeScratchDb(sourceKind);
            try {
                const zipBytes = await buildEngineDumpZip(harness, sourceKind, dumpBytes);
                const uploadId = await uploadArchiveToSession(harness.app, zipBytes, { handle: harness.handle });
                const restoreRes = await request(harness.app)
                    .post('/api/users/restore-backup')
                    .send({ uploadId, handle: harness.handle, mode: restoreMode, selection: ALL_SELECTION, ...scratch.fields });
                expect(await probeAllRepos(harness.handle)).toEqual(beforeProbe);
                expect(restoreRes.status).toBe(400);
                expect(restoreRes.body?.crossModeFailure).toBeUndefined();
            } finally {
                await scratch.teardown();
            }
        });
    }

    test('REGRESSION: pure FS category selection on DB mode does not overwrite DB tables', async () => {
        if (mode === 'fs') return;

        // Seed state #1 and take a full backup ZIP (includes _engine_dump.bin + extensions).
        await seedAllRepos(harness.handle);
        const extFile = path.join(harness.dirs.extensions, 'demo-ext', 'index.js');
        fs.mkdirSync(path.dirname(extFile), { recursive: true });
        fs.writeFileSync(extFile, 'console.log("from-backup");', 'utf8');

        const backupRes = await postBackup(harness);
        expect(backupRes.status).toBe(200);
        const zipBytes = backupRes.body;

        // Mutate live DB state and overwrite extension on disk.
        await getSettingsRepo().save(harness.handle, { user_name: 'live-after-backup', custom: 'LIVE' });
        await getWorldInfoRepo().save(harness.handle, 'w1', { entries: { '1': { content: 'live-world' } } });
        fs.writeFileSync(extFile, 'console.log("live-modified");', 'utf8');

        // Restore ONLY the pure FS category `extensions` (no DB categories selected).
        const pureFsSelection = {
            settings: false, secrets: false, characters: false, chats: false,
            lorebooks: false, presets: false, assets: false, extensions: true,
            globalExtensions: false, vectors: false,
        };
        const uploadId = await uploadArchiveToSession(harness.server, zipBytes, { handle: harness.handle });
        const restoreRes = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: 'overwrite', selection: pureFsSelection });

        expect(restoreRes.status).toBe(200);
        // Extension file restored from backup, while live DB tables remained untouched.
        expect(fs.readFileSync(extFile, 'utf8')).toBe('console.log("from-backup");');
        expect(await getSettingsRepo().get(harness.handle)).toEqual({ user_name: 'live-after-backup', custom: 'LIVE' });
        expect(await getWorldInfoRepo().get(harness.handle, 'w1')).toEqual({ entries: { '1': { content: 'live-world' } } });
    });

    test.each(['merge', 'overwrite'])('REGRESSION: FS extraction failure during same-mode DB restore (%s) leaves DB and FS intact', async (restoreMode) => {
        if (mode === 'fs') return;

        // Seed backup state #1 and collect a real DB dump from state #1.
        await seedAllRepos(harness.handle);
        const dumpStream = await getStorageEngine().dumpUser(harness.handle);
        const dumpChunks = [];
        for await (const chunk of dumpStream) {
            dumpChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const validDumpBuf = Buffer.concat(dumpChunks);

        const secretsPath = path.join(harness.dirs.root, 'secrets.json');
        const extKeepPath = path.join(harness.dirs.extensions, 'keep-ext', 'index.js');
        fs.mkdirSync(path.dirname(extKeepPath), { recursive: true });
        fs.writeFileSync(secretsPath, '{"token":"backup"}', 'utf8');
        fs.writeFileSync(extKeepPath, 'live-ext', 'utf8');

        // Mutate live DB to state #2 so an overwritten DB would be distinguishable.
        await getSettingsRepo().save(harness.handle, { user_name: 'live-protected', custom: 'KEEP' });
        const liveBefore = await probeAllRepos(harness.handle);
        fs.writeFileSync(secretsPath, '{"token":"live"}', 'utf8');

        // Build an archive with a VALID same-engine DB dump plus colliding FS entries:
        // creating file `extensions/clash` followed by `extensions/clash/child.txt` fails
        // during extraction (after overwrite snapshotting already succeeded).
        const zipPath = path.join(harness.dataRoot, `fs-extract-fail-${restoreMode}-${randomBytes(4).toString('hex')}.zip`);
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append(JSON.stringify({ schemaVersion: 1, handle: harness.handle, selection: ALL_SELECTION }), { name: 'manifest.json' });
            arc.append(JSON.stringify({ engineKind: mode, schemaVersion: 1, createdAt: new Date().toISOString(), handle: harness.handle }), { name: '_engine_meta.json' });
            arc.append(validDumpBuf, { name: '_engine_dump.bin' });
            arc.append('{"token":"incoming"}', { name: 'secrets.json' });
            arc.append('file-blocking-dir', { name: 'extensions/clash' });
            arc.append('nested-under-file', { name: 'extensions/clash/child.txt' });
            arc.finalize();
        });

        const uploadId = await uploadArchiveToSession(harness.server, fs.readFileSync(zipPath), { handle: harness.handle });
        const restoreRes = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: restoreMode, selection: ALL_SELECTION });

        expect(restoreRes.status).toBe(500);
        // Live DB must not have been rolled back to state #1.
        expect(await probeAllRepos(harness.handle)).toEqual(liveBefore);
        // Live FS state must have been restored cleanly.
        expect(fs.readFileSync(secretsPath, 'utf8')).toBe('{"token":"live"}');
        expect(fs.readFileSync(extKeepPath, 'utf8')).toBe('live-ext');
        expect(fs.existsSync(path.join(harness.dirs.extensions, 'clash'))).toBe(false);
    });

    test.each(['merge', 'overwrite'])('REGRESSION: corrupt DB dump with valid FS entries (%s) returns 400 and leaves both FS and DB untouched', async (restoreMode) => {
        if (mode === 'fs') return;

        await seedAllRepos(harness.handle);
        const beforeProbe = await probeAllRepos(harness.handle);
        const extFile = path.join(harness.dirs.extensions, 'keep-ext', 'app.js');
        fs.mkdirSync(path.dirname(extFile), { recursive: true });
        fs.writeFileSync(extFile, 'original-ext-content', 'utf8');

        const zipPath = path.join(harness.dataRoot, `corrupt-with-fs-${randomBytes(4).toString('hex')}.zip`);
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append(JSON.stringify({ schemaVersion: 1, handle: harness.handle, selection: ALL_SELECTION }), { name: 'manifest.json' });
            arc.append(JSON.stringify({ engineKind: mode, schemaVersion: 1, createdAt: new Date().toISOString(), handle: harness.handle }), { name: '_engine_meta.json' });
            arc.append(Buffer.from('not a valid engine dump'), { name: '_engine_dump.bin' });
            arc.append('incoming-ext-content', { name: 'extensions/keep-ext/app.js' });
            arc.append('brand-new-file', { name: 'extensions/keep-ext/new.js' });
            arc.finalize();
        });

        const uploadId = await uploadArchiveToSession(harness.server, fs.readFileSync(zipPath), { handle: harness.handle });
        const restoreRes = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: restoreMode, selection: ALL_SELECTION });

        expect(restoreRes.status).toBe(400);
        expect(await probeAllRepos(harness.handle)).toEqual(beforeProbe);
        expect(fs.readFileSync(extFile, 'utf8')).toBe('original-ext-content');
        expect(fs.existsSync(path.join(harness.dirs.extensions, 'keep-ext', 'new.js'))).toBe(false);
    });

    test('REGRESSION: overwrite rollback deletes previously absent targetFiles and targetDirectories', async () => {
        const secretsPath = path.join(harness.dirs.root, 'secrets.json');
        const extDir = harness.dirs.extensions;
        fs.rmSync(secretsPath, { force: true });
        fs.rmSync(extDir, { recursive: true, force: true });
        expect(fs.existsSync(secretsPath)).toBe(false);
        expect(fs.existsSync(extDir)).toBe(false);

        const zipPath = path.join(harness.dataRoot, `overwrite-absent-rollback-${randomBytes(4).toString('hex')}.zip`);
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append(JSON.stringify({ schemaVersion: 1, handle: harness.handle, selection: ALL_SELECTION }), { name: 'manifest.json' });
            if (mode !== 'fs') {
                arc.append(JSON.stringify({ engineKind: mode, schemaVersion: 1, createdAt: new Date().toISOString(), handle: harness.handle }), { name: '_engine_meta.json' });
                arc.append(Buffer.from('invalid-engine-dump'), { name: '_engine_dump.bin' });
                arc.append('{"token":"created-then-rolled-back"}', { name: 'secrets.json' });
                arc.append('created-ext', { name: 'extensions/new-ext/index.js' });
            } else {
                arc.append('{"token":"created-then-rolled-back"}', { name: 'secrets.json' });
                arc.append('created-ext', { name: 'extensions/new-ext/index.js' });
                arc.append('file-blocking-dir', { name: 'extensions/clash' });
                arc.append('nested-under-file', { name: 'extensions/clash/child.txt' });
            }
            arc.finalize();
        });

        const uploadId = await uploadArchiveToSession(harness.server, fs.readFileSync(zipPath), { handle: harness.handle });
        const restoreRes = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: 'overwrite', selection: ALL_SELECTION });

        expect(restoreRes.status).toBe(mode === 'fs' ? 500 : 400);
        expect(fs.existsSync(secretsPath)).toBe(false);
        expect(fs.existsSync(extDir)).toBe(false);
    });

    test('REGRESSION: early reject from engine.restoreUser destroys yauzl readStream and closes FD', async () => {
        if (mode === 'fs') return;

        const zipBytes = await buildEngineDumpZip(harness, mode, Buffer.from('unconsumed-dump-payload'));
        const uploadId = await uploadArchiveToSession(harness.server, zipBytes, { handle: harness.handle });

        let observedStream = null;
        const restoreSpy = jest.spyOn(getStorageEngine(), 'restoreUser').mockImplementationOnce(async (_handle, readStream) => {
            observedStream = readStream;
            throw new RestoreDumpInvalidError('rejected before reading stream');
        });

        const fdDirExists = fs.existsSync('/dev/fd');
        const fdCountBefore = fdDirExists ? fs.readdirSync('/dev/fd').length : 0;
        try {
            const restoreRes = await request(harness.server)
                .post('/api/users/restore-backup')
                .send({ uploadId, handle: harness.handle, mode: 'merge', selection: ALL_SELECTION });
            expect(restoreRes.status).toBe(400);
        } finally {
            restoreSpy.mockRestore();
        }

        expect(observedStream).not.toBeNull();
        expect(observedStream.destroyed).toBe(true);
        // Allow fs.close callback from fd-slicer to settle.
        await new Promise(resolve => setTimeout(resolve, 25));
        const fdCountAfter = fdDirExists ? fs.readdirSync('/dev/fd').length : 0;
        expect(fdCountAfter).toBeLessThanOrEqual(fdCountBefore);
    });

    test('REGRESSION: /import/data-zip cleans up uploaded temp file when rejecting non-.zip extension', async () => {
        const importRes = await request(harness.server)
            .post('/api/users/import/data-zip')
            .attach('avatar', Buffer.from('not a zip'), 'backup.txt');

        expect(importRes.status).toBe(400);
        expect(importRes.body.error).toMatch(/\.zip/i);
        expect(fs.readdirSync(uploadsDir)).toEqual([]);
    });
});

function foreignSourceKind(sourceGroup, mode) {
    if (sourceGroup === 'sqlite') return 'sqlite';
    if (mode !== 'postgres' && !process.env.LUKER_DISABLE_POSTGRES_TESTS) return 'postgres';
    if (mode !== 'mysql' && !process.env.LUKER_DISABLE_MYSQL_TESTS) return 'mysql';
    return null;
}

/**
 * Throwaway scratch namespace for a mysql/postgres source restore, passed as
 * the operator scratch DB fields. Other source kinds need none.
 */
async function makeScratchDb(kind) {
    const scope = currentScopeForResources();
    if (kind === 'mysql') {
        const lease = await acquireMysqlDatabase(scope, MYSQL_ROOT_URL, { fresh: true, label: 'backup roundtrip scratch mysql' });
        return {
            fields: { scratchMysqlUrl: lease.url },
            teardown: async () => { await scope.release(lease.resourceId); },
        };
    }
    if (kind === 'postgres') {
        const lease = await acquirePostgresDatabase(scope, PG_ROOT_URL, { fresh: true, label: 'backup roundtrip scratch postgres' });
        return {
            fields: { scratchPostgresUrl: lease.url },
            teardown: async () => { await scope.release(lease.resourceId); },
        };
    }
    return { fields: {}, teardown: async () => {} };
}
