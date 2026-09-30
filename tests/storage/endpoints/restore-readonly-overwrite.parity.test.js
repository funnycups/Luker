/* global globalThis */
// Endpoint-level regression: restoring an archive over an existing read-only
// file must overwrite it instead of aborting the whole restore.
//
// Real-world trigger: a backup ZIP contains `extensions/<repo>/.git/objects/**`
// entries, and the live user dir already has a git-installed extension whose
// object files are chmod 0444 (git's default object mode). In merge mode the
// target file is not snapshotted away first, so opening it with the write
// stream's `w` flag hits EACCES on POSIX and the restore handler reports a
// write failure for that entry — failing the operation instead of replacing
// the file. Same bug class as the already-fixed cross-mode extraction path.
//
// This drives the real `/api/users/restore-backup` route (chunked upload
// session included) rather than the extraction helper directly.

import fs from 'node:fs';
import path from 'node:path';

import archiver from 'archiver';
import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness, uploadArchiveToSession } from '../harness/endpoint-harness.js';
import { router as usersPrivateRouter } from '../../../src/endpoints/users-private.js';
import { ENGINE_META_ENTRY } from '../../../src/storage/engine-backup-entries.js';

const EXTENSIONS_ONLY = {
    settings: false,
    secrets: false,
    characters: false,
    chats: false,
    lorebooks: false,
    presets: false,
    assets: false,
    extensions: true,
    globalExtensions: false,
    vectors: false,
};

const READONLY_ENTRY = 'extensions/repo/.git/objects/aa/bb';

function buildArchive(zipPath, { mode, handle }) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        arc.append(JSON.stringify({ schemaVersion: 1, handle, selection: EXTENSIONS_ONLY }), { name: 'manifest.json' });
        if (mode !== 'fs') {
            // Same-kind engine meta keeps the restore on the same-mode path
            // instead of delegating to the cross-mode orchestrator. No dump
            // entry is needed — the fs-tree category is what this test drives.
            arc.append(JSON.stringify({
                engineKind: mode,
                schemaVersion: 1,
                createdAt: new Date().toISOString(),
                handle,
            }), { name: ENGINE_META_ENTRY });
        }
        arc.append('NEW-BYTES', { name: READONLY_ENTRY });
        arc.finalize();
    });
}

describe.each(ENDPOINT_HARNESSES)('same-mode restore over read-only file on $name', ({ mode }) => {
    let harness;
    let previousDataRoot;

    beforeEach(async () => {
        previousDataRoot = globalThis.DATA_ROOT;
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => { app.use('/api/users', usersPrivateRouter); },
        });
        globalThis.DATA_ROOT = harness.dataRoot;
    });

    afterEach(async () => {
        globalThis.DATA_ROOT = previousDataRoot;
        if (harness) await harness.cleanup();
    });

    test('REGRESSION: merge restore overwrites a pre-existing read-only file', async () => {
        const target = path.join(harness.dirs.extensions, 'repo', '.git', 'objects', 'aa', 'bb');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'OLD');
        fs.chmodSync(target, 0o444);

        const zipPath = path.join(harness.dataRoot, 'readonly-target.zip');
        await buildArchive(zipPath, { mode, handle: harness.handle });

        const uploadId = await uploadArchiveToSession(harness.app, fs.readFileSync(zipPath), { handle: harness.handle });
        const res = await request(harness.app)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: 'merge', selection: EXTENSIONS_ONLY });

        expect(res.status).toBe(200);
        expect(res.body.restoredCount).toBe(1);
        expect(res.body.failedCount).toBe(0);
        expect(fs.readFileSync(target, 'utf8')).toBe('NEW-BYTES');
    });
});
