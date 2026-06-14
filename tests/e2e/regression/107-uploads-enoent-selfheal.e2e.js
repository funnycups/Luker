// #107 — `_uploads/` ENOENT self-heal (commit 69ebf6e5d)
//
// Bug shape: server boots and creates `<dataRoot>/_uploads/`. If anything
// deletes that directory while the server is still running, subsequent
// POSTs that try to land a multipart file (avatar import, world-info
// import via attachment, etc.) ENOENT permanently — multer's `dest:`
// option is evaluated at boot and never re-checked. Restarting the
// process is the only recovery.
//
// Fix: multer uses `diskStorage({ destination: cb })` which now calls
// `ensureDirectory(uploadsPath)` per request, so the dir is re-created
// before the file lands.
//
// Regression lock:
//   1. Boot server, open the page so CSRF / cookies are negotiated.
//   2. Issue a character import POST through the live HTTP surface so
//      multer touches `_uploads/` once and creates it (or so we can
//      observe its first-touch state).
//   3. `rm -rf` the dir while the server is still running.
//   4. Issue a second character-import POST — this is the path that
//      pre-fix ENOENT'd and 5xx'd. Assert the second request succeeds
//      AND the dir is back on disk.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { existsSync, rmSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SEED_PNG = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'uploads-enoent' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#107 — _uploads/ ENOENT self-heal', () => {
    test('character import after rm -rf _uploads/ still succeeds and re-creates the dir', async ({ page }) => {
        const uploadsPath = resolve(server.dataRoot, '_uploads');

        // 1. Open the page so the session has a valid CSRF token / cookie.
        //    Server-issued multipart routes require the token to be passed
        //    via `getRequestHeaders()`; we drive the upload from inside the
        //    page to inherit those headers.
        await awaitMainUI(page, server.baseURL);

        // 2. First import: nudges multer to touch _uploads/. This both
        //    creates the dir (if not already) AND proves the baseline
        //    happy path works — so the second-pass assertion isolates the
        //    re-ensure behavior under test.
        const pngBytesB64 = readFileSync(SEED_PNG).toString('base64');

        async function doImport(label) {
            return await page.evaluate(async ({ b64, name }) => {
                const ctx = window.Luker.getContext();
                const headers = ctx.getRequestHeaders();
                // Drop content-type so the browser sets the multipart boundary.
                delete headers['Content-Type'];
                delete headers['content-type'];
                const form = new FormData();
                const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                form.append('avatar', new Blob([bin], { type: 'image/png' }), name);
                form.append('file_type', 'png');
                const res = await fetch('/api/characters/import', {
                    method: 'POST',
                    headers,
                    body: form,
                });
                const text = await res.text();
                let body;
                try { body = JSON.parse(text); } catch { body = { raw: text }; }
                return { status: res.status, body };
            }, { b64: pngBytesB64, name: `regression-107-${label}.png` });
        }

        const firstImport = await doImport('warmup');
        expect(firstImport.status, `warmup import should succeed (got body=${JSON.stringify(firstImport.body)})`).toBe(200);
        expect(firstImport.body?.error, `warmup import should not report error`).not.toBe(true);
        expect(existsSync(uploadsPath), '_uploads/ should exist after first multer touch').toBe(true);

        // 3. Wipe _uploads/ while the server is still running. This is
        //    the bug trigger — pre-fix, multer's `dest:` path is cached
        //    at boot and subsequent uploads ENOENT.
        rmSync(uploadsPath, { recursive: true, force: true });
        expect(existsSync(uploadsPath), '_uploads should be gone after rm -rf').toBe(false);

        // 4. Issue another import — this is the bug-triggering path. The
        //    fix's per-request `ensureDirectory(uploadsPath)` should make
        //    this succeed and recreate the dir.
        const secondImport = await doImport('post-rm');
        expect(secondImport.status,
            `second import after rm -rf must succeed (commit 69ebf6e5d); ` +
            `got status=${secondImport.status} body=${JSON.stringify(secondImport.body)}`,
        ).toBe(200);
        expect(secondImport.body?.error,
            `second import must not report error after re-ensure`,
        ).not.toBe(true);

        // 5. The uploads dir should be back on disk after the fix.
        expect(existsSync(uploadsPath), '_uploads/ must be re-created by per-request ensureDirectory').toBe(true);
        const st = statSync(uploadsPath);
        expect(st.isDirectory()).toBe(true);
    });
});

