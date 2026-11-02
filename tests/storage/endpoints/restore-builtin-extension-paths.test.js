// REGRESSION: a backup ZIP built from a source tree (e.g. zipping
// `SillyTavern/public` or the whole repo) carries the built-in extensions at
// `public/scripts/extensions/<name>/...`. The restore path classifier used to
// strip `public/scripts/` and land those entries in the user's per-user
// extensions directory, where `/api/extensions/discover` then reported them as
// local `third-party/<name>` extensions. The client requests those under
// `/scripts/extensions/third-party/<name>/index.js`, but their relative imports
// (`../../../script.js`) resolve to `/scripts/script.js` — 404 — so every
// built-in fails with "Failed to fetch dynamically imported module".
//
// The invariant: built-in source-tree paths (`scripts/extensions/<name>/...`,
// `public/scripts/extensions/<name>/...`) must never be written into a user
// extensions directory, while a genuine user extension entry
// (`extensions/<name>/...`) still restores.
//
// The second test pins the other half of the contract: global third-party
// extensions under `public/scripts/extensions/third-party/...` must still land
// in the global extensions directory (never nested into the user's).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import multer from 'multer';
import request from 'supertest';
import archiver from 'archiver';

import { makeEndpointHarness, uploadArchiveToSession } from '../harness/endpoint-harness.js';
import { router as usersPrivateRouter } from '../../../src/endpoints/users-private.js';
import { setGlobalExtensionsDirectory } from '../../../src/constants.js';

function mountMulterShim(app, uploadsDir) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    const upload = multer({
        storage: multer.diskStorage({
            destination: (_req, _file, cb) => cb(null, uploadsDir),
        }),
    }).single('avatar');
    app.use('/api/users/import/data-zip', upload);
}

function writeZip(zipPath, entries) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const archive = archiver('zip');
        archive.on('error', reject);
        out.on('error', reject);
        out.on('close', resolve);
        archive.pipe(out);
        for (const [name, content] of Object.entries(entries)) {
            archive.append(content, { name });
        }
        archive.finalize();
    });
}

function extensionEntries(prefix, name) {
    return {
        [`${prefix}${name}/manifest.json`]: JSON.stringify({ display_name: name, js: 'index.js' }),
        [`${prefix}${name}/index.js`]: 'export const x = 1;\n',
    };
}

const FULL_SELECTION = {
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

describe('restore path classifier: built-in extension paths', () => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode: 'fs',
            mount: (app, { dirs }) => {
                mountMulterShim(app, path.join(dirs.root, 'bk-uploads'));
                app.use('/api/users', usersPrivateRouter);
            },
        });
        globalThis.DATA_ROOT = harness.dataRoot;
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('source-tree built-in extension paths are not imported as user extensions', async () => {
        const zipPath = path.join(harness.dataRoot, `src-tree-${randomBytes(4).toString('hex')}.zip`);
        await writeZip(zipPath, {
            ...extensionEntries('public/scripts/extensions/', 'translate'),
            ...extensionEntries('public/scripts/extensions/', 'regex'),
            ...extensionEntries('scripts/extensions/', 'mine'),
            ...extensionEntries('extensions/', 'legit'),
        });

        const res = await request(harness.server)
            .post('/api/users/import/data-zip')
            .field('mode', 'merge')
            .attach('avatar', zipPath);
        expect(res.status).toBe(200);

        // Built-in source-tree paths must NOT be written into the user's
        // extensions directory.
        expect(fs.existsSync(path.join(harness.dirs.extensions, 'translate'))).toBe(false);
        expect(fs.existsSync(path.join(harness.dirs.extensions, 'regex'))).toBe(false);
        expect(fs.existsSync(path.join(harness.dirs.extensions, 'mine'))).toBe(false);

        // A genuine user extension entry still restores.
        expect(fs.existsSync(path.join(harness.dirs.extensions, 'legit', 'manifest.json'))).toBe(true);
    });

    test('global third-party extensions still restore into the global extensions directory', async () => {
        const globalExtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-global-ext-'));
        setGlobalExtensionsDirectory(globalExtDir);
        try {
            const zipPath = path.join(harness.dataRoot, `global-ext-${randomBytes(4).toString('hex')}.zip`);
            await writeZip(zipPath, {
                ...extensionEntries('public/scripts/extensions/third-party/', 'MyExt'),
                ...extensionEntries('scripts/extensions/third-party/', 'OtherExt'),
                ...extensionEntries('third-party/', 'BareExt'),
                ...extensionEntries('public/scripts/extensions/', 'translate'),
                ...extensionEntries('extensions/', 'legit'),
            });

            const zipBytes = fs.readFileSync(zipPath);
            const uploadId = await uploadArchiveToSession(harness.server, zipBytes, { handle: harness.handle });
            const res = await request(harness.server)
                .post('/api/users/restore-backup')
                .send({
                    uploadId,
                    handle: harness.handle,
                    mode: 'merge',
                    selection: { ...FULL_SELECTION, globalExtensions: true },
                });
            expect(res.status).toBe(200);

            // Every global-extension archive shape lands in the global dir.
            expect(fs.existsSync(path.join(globalExtDir, 'MyExt', 'manifest.json'))).toBe(true);
            expect(fs.existsSync(path.join(globalExtDir, 'OtherExt', 'manifest.json'))).toBe(true);
            expect(fs.existsSync(path.join(globalExtDir, 'BareExt', 'manifest.json'))).toBe(true);

            // The built-in source-tree path is still skipped, and the global
            // third-party entries are not nested into the user's extensions dir.
            expect(fs.existsSync(path.join(harness.dirs.extensions, 'translate'))).toBe(false);
            expect(fs.existsSync(path.join(harness.dirs.extensions, 'third-party'))).toBe(false);
            expect(fs.existsSync(path.join(harness.dirs.extensions, 'legit', 'manifest.json'))).toBe(true);
        } finally {
            fs.rmSync(globalExtDir, { recursive: true, force: true });
        }
    });
});
