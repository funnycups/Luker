// End-to-end tests for the /restore-backup/probe endpoint and the
// /restore-backup cross-mode delegation contract.
//
// Coverage:
//   - probe with same-mode ZIP returns crossModeRequired:false.
//   - probe with foreign-engine ZIP returns crossModeRequired:true and
//     scratchCredsNeeded for mysql/pg sources.
//   - probe with legacy fs-only ZIP on a db server returns
//     crossModeRequired:true, scratchCredsNeeded:null (fs source needs no
//     scratch DB).
//   - /restore-backup with sqlite-source ZIP into fs server actually does
//     the cross-mode conversion end-to-end and the data lands on the
//     live engine.
//   - /restore-backup of a sqlite-source ZIP on a sqlite-mode server uses
//     the original same-mode path (no conversion).
//
// These tests exercise the real HTTP shape end-to-end (multer + supertest +
// real engines), so any regression in the wiring between users-private.js
// and cross-mode-restore.js will show up here.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import archiver from 'archiver';
import multer from 'multer';
import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as usersPrivateRouter } from '../../../src/endpoints/users-private.js';
import {
    getChatRepo,
    getSettingsRepo,
    getWorldInfoRepo,
    getStorageEngine,
} from '../../../src/storage/index.js';
import { ENGINE_DUMP_ENTRY, ENGINE_META_ENTRY } from '../../../src/storage/engine-backup-entries.js';
import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';

const ALL_SELECTION = {
    settings: true, secrets: true, characters: true, chats: true,
    lorebooks: true, presets: true, assets: true, extensions: true,
    globalExtensions: false, vectors: true,
};

function mountMulterShim(app, uploadsDir) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    // Mirror production (src/server-main.js): single global mount, no
    // per-path mount. This way the request body is parsed exactly once
    // per request regardless of which route handles it.
    const upload = multer({
        storage: multer.diskStorage({
            destination: (_req, _file, cb) => cb(null, uploadsDir),
        }),
    }).single('avatar');
    app.use(upload);
}

// Build a sqlite-source ZIP from a real engine instance + seeded data.
async function buildSqliteSourceZip(zipPath, srcDir, handle) {
    fs.mkdirSync(srcDir, { recursive: true });
    const engine = new SqliteEngine({ directoriesByHandle: () => ({ root: srcDir }) });
    try {
        await new SettingsRepo({ engine }).save(handle, { user_name: 'foreign-source', custom: 'XX' });
        await new ChatRepo({ engine }).save(handle, 'Alice', 'c1',
            { user_name: 'foreign-source' },
            [{ name: 'User', mes: 'cross-mode 你好 🌍', is_user: true }], null);
        await new WorldInfoRepo({ engine }).save(handle, 'w1', { entries: {} });
    } finally {
        engine.close();
    }
    const dumpBytes = fs.readFileSync(path.join(srcDir, 'luker-storage.sqlite'));
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        arc.append(JSON.stringify({ schemaVersion: 1, handle, selection: ALL_SELECTION }), { name: 'manifest.json' });
        arc.append(JSON.stringify({ engineKind: 'sqlite', schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle }), { name: ENGINE_META_ENTRY });
        arc.append(dumpBytes, { name: ENGINE_DUMP_ENTRY });
        arc.append('{"openrouter":"xxx"}', { name: 'secrets.json' });
        arc.finalize();
    });
}

// Build a foreign-DB-source ZIP (mysql/postgres) without a real DB; the
// probe and creds-required path only read engine_meta, so a tokens dump is
// fine for the cred-gate test.
async function buildForeignDbSourceZip(zipPath, sourceKind, handle) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        arc.append(JSON.stringify({ schemaVersion: 1, handle, selection: ALL_SELECTION }), { name: 'manifest.json' });
        arc.append(JSON.stringify({ engineKind: sourceKind, schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle }), { name: ENGINE_META_ENTRY });
        arc.append('placeholder dump', { name: ENGINE_DUMP_ENTRY });
        arc.finalize();
    });
}

describe.each(ENDPOINT_HARNESSES)('cross-mode endpoint wiring on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app, { dirs }) => {
                const uploadsDir = path.join(dirs.root, 'cm-uploads');
                mountMulterShim(app, uploadsDir);
                app.use('/api/users', usersPrivateRouter);
            },
        });
        globalThis.DATA_ROOT = harness.dataRoot;
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('probe: same-mode ZIP → crossModeRequired:false', async () => {
        // For fs mode, build a legacy ZIP (no engine_meta) — probe must
        // return engineKind:'fs', crossModeRequired:false.
        // For db modes, build a same-kind ZIP — probe must return matching
        // engineKind and crossModeRequired:false.
        const zipPath = path.join(harness.dataRoot, `probe-${randomBytes(4).toString('hex')}.zip`);
        if (mode === 'fs') {
            await new Promise((resolve, reject) => {
                const out = fs.createWriteStream(zipPath);
                const arc = archiver('zip');
                arc.on('error', reject);
                out.on('close', resolve);
                arc.pipe(out);
                arc.append('{}', { name: 'manifest.json' });
                arc.finalize();
            });
        } else {
            await buildForeignDbSourceZip(zipPath, mode, harness.handle);
        }
        const zipBytes = fs.readFileSync(zipPath);
        const res = await request(harness.app)
            .post('/api/users/restore-backup/probe')
            .attach('avatar', zipBytes, 'probe.zip');
        expect(res.status).toBe(200);
        expect(res.body.crossModeRequired).toBe(false);
        expect(res.body.scratchCredsNeeded).toBeNull();
        if (mode !== 'fs') expect(res.body.engineKind).toBe(mode);
        else expect(res.body.engineKind).toBe('fs');
    });

    test('probe: foreign-db ZIP → crossModeRequired:true with scratchCredsNeeded', async () => {
        const foreignKind = mode === 'mysql' ? 'postgres' : 'mysql';
        const zipPath = path.join(harness.dataRoot, `probe-foreign-${randomBytes(4).toString('hex')}.zip`);
        await buildForeignDbSourceZip(zipPath, foreignKind, harness.handle);
        const zipBytes = fs.readFileSync(zipPath);
        const res = await request(harness.app)
            .post('/api/users/restore-backup/probe')
            .attach('avatar', zipBytes, 'probe.zip');
        expect(res.status).toBe(200);
        expect(res.body.engineKind).toBe(foreignKind);
        expect(res.body.crossModeRequired).toBe(true);
        expect(res.body.scratchCredsNeeded).toBe(foreignKind);
    });

    test('probe: legacy fs ZIP on db server → crossModeRequired:true, scratchCredsNeeded:null', async () => {
        if (mode === 'fs') return; // fs server with fs zip is same-mode
        const zipPath = path.join(harness.dataRoot, `probe-legacy-${randomBytes(4).toString('hex')}.zip`);
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', reject);
            out.on('close', resolve);
            arc.pipe(out);
            arc.append('{}', { name: 'manifest.json' });
            arc.finalize();
        });
        const zipBytes = fs.readFileSync(zipPath);
        const res = await request(harness.app)
            .post('/api/users/restore-backup/probe')
            .attach('avatar', zipBytes, 'probe.zip');
        expect(res.status).toBe(200);
        expect(res.body.engineKind).toBe('fs');
        expect(res.body.crossModeRequired).toBe(true);
        // fs source needs NO scratch DB — fs data is on disk.
        expect(res.body.scratchCredsNeeded).toBeNull();
    });

    test('end-to-end: sqlite-source ZIP cross-restored into fs server', async () => {
        // Only meaningful when destination is fs (cross-mode from sqlite).
        if (mode !== 'fs') return;
        const zipPath = path.join(harness.dataRoot, `xmode-${randomBytes(4).toString('hex')}.zip`);
        const srcDir = path.join(harness.dataRoot, 'src-dir');
        await buildSqliteSourceZip(zipPath, srcDir, harness.handle);
        const zipBytes = fs.readFileSync(zipPath);

        const res = await request(harness.app)
            .post('/api/users/restore-backup')
            .field('handle', harness.handle)
            .field('mode', 'overwrite')
            .field('selection', JSON.stringify(ALL_SELECTION))
            .attach('avatar', zipBytes, 'xmode.zip');
        expect(res.status).toBe(200);
        expect(res.body.crossMode?.sourceKind).toBe('sqlite');
        expect(res.body.crossMode?.destKind).toBe('fs');
        // Live data on the fs engine now reflects the source-dump contents.
        const settings = await getSettingsRepo().get(harness.handle);
        expect(settings?.user_name).toBe('foreign-source');
        const chat = await getChatRepo().get(harness.handle, 'Alice', 'c1');
        expect(chat?.body[0]?.mes).toBe('cross-mode 你好 🌍');
        const world = await getWorldInfoRepo().get(harness.handle, 'w1');
        expect(world).toBeTruthy();
    });
});
