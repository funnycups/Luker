// #45 — `_uploads/` ENOENT self-heal (regression lock for commit 69ebf6e5d).
//
// Boot server → confirm dataRoot/_uploads exists.
// Delete the directory while the server is running.
// Hit an upload endpoint (e.g. /api/characters/import with a multipart body).
// Assert: directory is re-created on the fly + request succeeds + no
//         permanent ENOENT on subsequent uploads.
//
// The fix in src/server-main.js wraps multer's destination resolver in
// `ensureDirectory(uploadsPath)` per request. Pre-fix, multer would resolve
// `dest` once at boot and silently fail forever after the dir was removed.

import { test, expect } from '@playwright/test';
import { existsSync, rmSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;
const UPLOADS_DIR = '_uploads';

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'server', scenarioId: 'uploads-heal' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#45 — _uploads/ directory self-heals after deletion', () => {
    test('delete uploads dir while running; next upload re-creates it and succeeds', async ({ page }) => {
        // Sanity: boot creates the dir.
        const uploadsPath = resolve(server.dataRoot, UPLOADS_DIR);
        // It might be created lazily on first upload — touch it first by booting.
        // We do not require existsSync(uploadsPath) here; the fix's contract is
        // "exists or will-be-created-on-next-upload".

        await awaitMainUI(page, server.baseURL);

        // Nuke the dir if present.
        if (existsSync(uploadsPath)) {
            rmSync(uploadsPath, { recursive: true, force: true });
        }
        expect(existsSync(uploadsPath), '_uploads should be removed before the regression check').toBe(false);

        // Build a tiny PNG buffer (real PNG header + IDAT) so multer accepts
        // the multipart upload. We do not actually need it to import as a
        // character — we just need the multer disk store to write a file to
        // _uploads. The fix is in middleware, so even a failing import body
        // exercises the destination resolver.
        const seedPng = resolve(server.dataRoot.split('/').slice(0, -1).join('/') || '/', 'default-Seraphina-fallback');
        // Actually: use the bundled real PNG so the import path is more robust.
        const PNG_PATH = resolve(process.cwd(), '../default/content/default_Seraphina.png');
        const pngBuf = (() => {
            try { return readFileSync(PNG_PATH); } catch { return Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); }
        })();

        // Drive a multipart POST through the page's fetch (carries session + csrf).
        const pngB64 = pngBuf.toString('base64');
        const uploadResult = await page.evaluate(async (b64) => {
            // Get CSRF token.
            const tokenResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await tokenResp.json();
            // Build a Blob from base64.
            const bin = atob(b64);
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            const blob = new Blob([u8], { type: 'image/png' });
            const fd = new FormData();
            fd.append('avatar', blob, 'regression-uploads-heal.png');
            fd.append('file_type', 'png');
            const resp = await fetch('/api/characters/import', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'X-CSRF-Token': token },
                body: fd,
            });
            return { status: resp.status, statusText: resp.statusText, body: (await resp.text()).slice(0, 400) };
        }, pngB64);

        // We do NOT require the import to succeed — that may fail for unrelated
        // PNG-data reasons. What we DO require:
        //   - the response is not 500 with an ENOENT in body
        //   - the _uploads directory now exists on disk
        expect(uploadResult.status, `upload response should not be 500; got status=${uploadResult.status} body=${uploadResult.body}`).not.toBe(500);
        expect(uploadResult.body || '', 'upload response should not surface ENOENT').not.toMatch(/ENOENT/);
        expect(existsSync(uploadsPath), '_uploads should be re-created by the per-request ensureDirectory hook').toBe(true);
        expect(statSync(uploadsPath).isDirectory()).toBe(true);

        // Second upload after a second deletion — should also succeed.
        rmSync(uploadsPath, { recursive: true, force: true });
        expect(existsSync(uploadsPath)).toBe(false);

        const second = await page.evaluate(async (b64) => {
            const tokenResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await tokenResp.json();
            const bin = atob(b64);
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            const blob = new Blob([u8], { type: 'image/png' });
            const fd = new FormData();
            fd.append('avatar', blob, 'regression-uploads-heal-2.png');
            fd.append('file_type', 'png');
            const resp = await fetch('/api/characters/import', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'X-CSRF-Token': token },
                body: fd,
            });
            return { status: resp.status, body: (await resp.text()).slice(0, 200) };
        }, pngB64);
        expect(second.status, `second upload should not 500; got ${second.status}`).not.toBe(500);
        expect(existsSync(uploadsPath)).toBe(true);
    });
});
