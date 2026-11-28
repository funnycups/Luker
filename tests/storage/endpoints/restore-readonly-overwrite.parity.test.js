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
import yauzl from 'yauzl';

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

const READONLY_ENTRY = 'extensions/repo/assets/data.bin';

function buildArchive(zipPath, { mode, handle, entries = [{ name: READONLY_ENTRY, content: 'NEW-BYTES' }] }) {
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
        for (const item of entries) {
            arc.append(item.content, { name: item.name });
        }
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
            handle: `u-${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            mount: (app) => { app.use('/api/users', usersPrivateRouter); },
        });
        globalThis.DATA_ROOT = harness.dataRoot;
    });

    afterEach(async () => {
        globalThis.DATA_ROOT = previousDataRoot;
    });

    test('REGRESSION: merge restore overwrites a pre-existing read-only file', async () => {
        const target = path.join(harness.dirs.extensions, 'repo', 'assets', 'data.bin');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'OLD');
        fs.chmodSync(target, 0o444);

        const zipPath = path.join(harness.dataRoot, 'readonly-target.zip');
        await buildArchive(zipPath, { mode, handle: harness.handle });

        const uploadId = await uploadArchiveToSession(harness.server, fs.readFileSync(zipPath), { handle: harness.handle });
        const res = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: 'merge', selection: EXTENSIONS_ONLY });

        expect(res.status).toBe(200);
        expect(res.body.restoredCount).toBe(1);
        expect(res.body.failedCount).toBe(0);
        expect(fs.readFileSync(target, 'utf8')).toBe('NEW-BYTES');
    });

    test('rejects .git metadata entries under extensions during backup restore', async () => {
        const zipPath = path.join(harness.dataRoot, 'git-metadata.zip');
        await buildArchive(zipPath, {
            mode,
            handle: harness.handle,
            entries: [
                { name: 'extensions/demo/manifest.json', content: '{"display_name":"Demo"}' },
                { name: 'extensions/demo/.git/config', content: '[core]\n\tfsmonitor = evil\n' },
                { name: 'extensions/demo/.GIT/HEAD', content: 'ref: refs/heads/main\n' },
                { name: 'extensions/demo/.git./config', content: 'dot\n' },
                { name: 'extensions/pointer/.git', content: 'gitdir: /tmp/evil\n' },
            ],
        });

        const uploadId = await uploadArchiveToSession(harness.server, fs.readFileSync(zipPath), { handle: harness.handle });
        const res = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: 'merge', selection: EXTENSIONS_ONLY });

        expect(res.status).toBe(200);
        expect(res.body.restoredCount).toBe(1);
        expect(res.body.rejectedCount).toBe(4);
        expect(fs.existsSync(path.join(harness.dirs.extensions, 'demo', 'manifest.json'))).toBe(true);
        expect(fs.existsSync(path.join(harness.dirs.extensions, 'demo', '.git'))).toBe(false);
        expect(fs.existsSync(path.join(harness.dirs.extensions, 'demo', '.GIT'))).toBe(false);
        expect(fs.existsSync(path.join(harness.dirs.extensions, 'demo', '.git.'))).toBe(false);
        expect(fs.existsSync(path.join(harness.dirs.extensions, 'pointer', '.git'))).toBe(false);
    });

    test('backup archive creation omits .git metadata under extensions', async () => {
        const extDir = path.join(harness.dirs.extensions, 'demo');
        fs.mkdirSync(path.join(extDir, '.git'), { recursive: true });
        fs.writeFileSync(path.join(extDir, 'manifest.json'), '{"display_name":"Demo"}');
        fs.writeFileSync(path.join(extDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

        const res = await request(harness.server)
            .post('/api/users/backup')
            .buffer(true)
            .parse((response, callback) => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => callback(null, Buffer.concat(chunks)));
            })
            .send({ handle: harness.handle, selection: EXTENSIONS_ONLY });

        expect(res.status).toBe(200);
        const zipEntries = await new Promise((resolve, reject) => {
            const names = [];
            yauzl.fromBuffer(res.body, { lazyEntries: true }, (err, zipfile) => {
                if (err) return reject(err);
                zipfile.readEntry();
                zipfile.on('entry', (entry) => {
                    names.push(entry.fileName);
                    zipfile.readEntry();
                });
                zipfile.on('end', () => resolve(names));
                zipfile.on('error', reject);
            });
        });

        expect(zipEntries).toContain('extensions/demo/manifest.json');
        expect(zipEntries.some(name => name.includes('.git'))).toBe(false);
    });
});
