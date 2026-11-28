// Regression: onboarding "Import Global Extensions ZIP" must overwrite a
// pre-existing read-only file inside the target extension folder.
//
// Real-world trigger: re-importing an extension ZIP over a git-installed
// extension whose `.git/objects/**` files are chmod 0444 (git's default
// object mode). The extraction pipeline opens each target with the write
// stream's `w` flag, which EACCESes on a read-only file and fails the whole
// import. Mirrors the cross-mode-restore extraction fix.
//
// Drives the real admin route + real multer middleware + real archive write;
// only the global-extensions target directory is redirected to a temp dir so
// the test never touches the repo tree.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import archiver from 'archiver';
import multer from 'multer';
import request from 'supertest';

import { makeEndpointHarness } from '../storage/harness/endpoint-harness.js';
import { router as usersAdminRouter } from '../../src/endpoints/users-admin.js';
import { PUBLIC_DIRECTORIES, setGlobalExtensionsDirectory } from '../../src/constants.js';

const ZIP_ENTRY = 'extensions/third-party/repo/assets/data.bin';

function mountUploadMiddleware(app, uploadsDir) {
    // Mirrors server-main.js: multer.diskStorage + `.single('avatar')` is the
    // production upload middleware for admin import routes.
    fs.mkdirSync(uploadsDir, { recursive: true });
    app.use('/api/users/import/global-extensions', multer({
        storage: multer.diskStorage({
            destination: (_req, _file, cb) => cb(null, uploadsDir),
        }),
    }).single('avatar'));
}

function buildExtensionsZip(zipPath, entries = [{ name: ZIP_ENTRY, content: 'NEW-BYTES' }]) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        for (const item of entries) {
            arc.append(item.content, { name: item.name });
        }
        arc.finalize();
    });
}

describe('users-admin /import/global-extensions', () => {
    let harness;
    let previousGlobalExtensions;
    let globalExtensionsDir;

    beforeEach(async () => {
        previousGlobalExtensions = PUBLIC_DIRECTORIES.globalExtensions;
        globalExtensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-global-ext-'));
        setGlobalExtensionsDirectory(globalExtensionsDir);

        harness = await makeEndpointHarness({
            mode: 'fs',
            mount: (app, { dirs }) => {
                mountUploadMiddleware(app, path.join(dirs.root, 'admin-uploads'));
                app.use('/api/users', usersAdminRouter);
            },
        });
        globalThis.DATA_ROOT = harness.dataRoot;
    });

    afterEach(async () => {
        setGlobalExtensionsDirectory(previousGlobalExtensions);
        fs.rmSync(globalExtensionsDir, { recursive: true, force: true });
    });

    test('REGRESSION: overwrites a pre-existing read-only file', async () => {
        const target = path.join(globalExtensionsDir, 'repo', 'assets', 'data.bin');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'OLD');
        fs.chmodSync(target, 0o444);

        const zipPath = path.join(harness.dataRoot, 'extensions.zip');
        await buildExtensionsZip(zipPath);

        const res = await request(harness.server)
            .post('/api/users/import/global-extensions')
            .attach('avatar', zipPath);

        expect(res.status).toBe(200);
        expect(res.body.importedCount).toBe(1);
        expect(fs.readFileSync(target, 'utf8')).toBe('NEW-BYTES');
    });

    test('rejects .git metadata entries in uploaded extensions ZIP', async () => {
        const zipPath = path.join(harness.dataRoot, 'extensions-with-git.zip');
        await buildExtensionsZip(zipPath, [
            { name: 'extensions/third-party/demo/manifest.json', content: '{"display_name":"Demo"}' },
            { name: 'extensions/third-party/demo/.git/config', content: '[core]\n\tfsmonitor = evil\n' },
            { name: 'extensions/third-party/demo/.GIT/HEAD', content: 'ref: refs/heads/main\n' },
            { name: 'extensions/third-party/demo/.git./hooks/pre-commit', content: '#!/bin/sh\nevil\n' },
            { name: 'extensions/third-party/pointer/.git', content: 'gitdir: /tmp/evil\n' },
        ]);

        const res = await request(harness.server)
            .post('/api/users/import/global-extensions')
            .attach('avatar', zipPath);

        expect(res.status).toBe(200);
        expect(res.body.importedCount).toBe(1);
        expect(res.body.rejectedCount).toBe(4);
        expect(fs.existsSync(path.join(globalExtensionsDir, 'demo', 'manifest.json'))).toBe(true);
        expect(fs.existsSync(path.join(globalExtensionsDir, 'demo', '.git'))).toBe(false);
        expect(fs.existsSync(path.join(globalExtensionsDir, 'demo', '.GIT'))).toBe(false);
        expect(fs.existsSync(path.join(globalExtensionsDir, 'demo', '.git.'))).toBe(false);
        expect(fs.existsSync(path.join(globalExtensionsDir, 'pointer', '.git'))).toBe(false);
    });
});
