// Cross-mode restore error mapping: every typed error from the orchestrator
// must produce the right HTTP status code and a structured payload the UI
// can react to.

import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import request from 'supertest';

import { makeEndpointHarness, uploadArchiveToSession } from '../harness/endpoint-harness.js';
import { router as usersPrivateRouter } from '../../../src/endpoints/users-private.js';
import { ENGINE_DUMP_ENTRY, ENGINE_META_ENTRY } from '../../../src/storage/engine-backup-entries.js';
import { acquireMigrationLock, releaseMigrationLock, makeHolderId } from '../../../src/storage/migration/lock.js';

const ALL_SELECTION = {
    settings: true, secrets: true, characters: true, chats: true,
    lorebooks: true, presets: true, assets: true, extensions: true,
    globalExtensions: false, vectors: true,
};

async function buildForeignDbSourceZip(zipPath, sourceKind, handle) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        arc.append('{}', { name: 'manifest.json' });
        arc.append(JSON.stringify({ engineKind: sourceKind, schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle }), { name: ENGINE_META_ENTRY });
        arc.append('placeholder', { name: ENGINE_DUMP_ENTRY });
        arc.finalize();
    });
}

describe('cross-mode restore error mapping (on fs server)', () => {
    let harness;
    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode: 'fs',
            mount: (app) => {
                app.use('/api/users', usersPrivateRouter);
            },
        });
        globalThis.DATA_ROOT = harness.dataRoot;
    });
    afterEach(async () => { if (harness) await harness.cleanup(); });

    test('400 + crossModeScratchRequired when mysql ZIP arrives without creds', async () => {
        const zipPath = path.join(harness.dataRoot, 'mysql.zip');
        await buildForeignDbSourceZip(zipPath, 'mysql', harness.handle);
        const zipBytes = fs.readFileSync(zipPath);

        const uploadId = await uploadArchiveToSession(harness.app, zipBytes, { handle: harness.handle });
        const res = await request(harness.app)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: 'merge', selection: ALL_SELECTION });
        expect(res.status).toBe(400);
        expect(res.body?.crossModeScratchRequired?.kind).toBe('mysql');
        expect(res.body?.error).toMatch(/scratch mysql/i);
    });

    test('400 + crossModeScratchConnection when scratch URL is unreachable', async () => {
        const zipPath = path.join(harness.dataRoot, 'mysql-bad.zip');
        await buildForeignDbSourceZip(zipPath, 'mysql', harness.handle);
        const zipBytes = fs.readFileSync(zipPath);

        const uploadId = await uploadArchiveToSession(harness.app, zipBytes, { handle: harness.handle });
        const res = await request(harness.app)
            .post('/api/users/restore-backup')
            .send({
                uploadId,
                handle: harness.handle,
                mode: 'merge',
                selection: ALL_SELECTION,
                scratchMysqlUrl: 'mysql://nobody:wrong@127.0.0.1:1/none',
            });
        expect(res.status).toBe(400);
        expect(res.body?.crossModeScratchConnection?.kind).toBe('mysql');
        expect(res.body?.error).toMatch(/scratch mysql/i);
    });

    test('409 when the migration lock is already held', async () => {
        const zipPath = path.join(harness.dataRoot, 'sqlite.zip');
        // Build a minimal sqlite-source ZIP with a valid (empty) sqlite dump.
        const Database = (await import('better-sqlite3')).default;
        const tmpDb = path.join(harness.dataRoot, 'tmp.sqlite');
        const db = new Database(tmpDb);
        try { db.prepare('CREATE TABLE x (y INT)').run(); } finally { db.close(); }
        const dumpBytes = fs.readFileSync(tmpDb);
        await new Promise((res, rej) => {
            const out = fs.createWriteStream(zipPath);
            const arc = archiver('zip');
            arc.on('error', rej);
            out.on('close', res);
            arc.pipe(out);
            arc.append('{}', { name: 'manifest.json' });
            arc.append(JSON.stringify({ engineKind: 'sqlite', schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle: harness.handle }), { name: ENGINE_META_ENTRY });
            arc.append(dumpBytes, { name: ENGINE_DUMP_ENTRY });
            arc.finalize();
        });
        const zipBytes = fs.readFileSync(zipPath);

        // Acquire the lock from a "different" holder so the orchestrator's
        // acquireMigrationLock returns the EEXIST contention path.
        const otherHolder = makeHolderId();
        fs.mkdirSync(harness.dataRoot, { recursive: true });
        await acquireMigrationLock({ dataRoot: harness.dataRoot, holderId: otherHolder });

        try {
            const uploadId = await uploadArchiveToSession(harness.app, zipBytes, { handle: harness.handle });
            const res = await request(harness.app)
                .post('/api/users/restore-backup')
                .send({ uploadId, handle: harness.handle, mode: 'overwrite', selection: ALL_SELECTION });
            expect(res.status).toBe(409);
        } finally {
            await releaseMigrationLock({ dataRoot: harness.dataRoot, holderId: otherHolder });
        }
    });
});
