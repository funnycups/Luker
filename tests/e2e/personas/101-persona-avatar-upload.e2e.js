// #101 — Upload a custom avatar via /api/avatars/upload; the file persists to
// disk, the thumbnail endpoint serves it, and a server restart preserves
// both.
//
// REAL USER-GESTURE flow:
//   1. Open the main UI, navigate to the persona avatar uploader.
//   2. POST a small PNG (real bytes) to /api/avatars/upload via the same
//      multipart channel the file picker triggers, with overwrite_name set
//      to a fresh sanitized name.
//   3. Verify the upload endpoint returns the saved path.
//   4. Hit /thumbnail?type=persona&file=<name> and assert it returns PNG
//      bytes (image/png content-type, non-empty body).
//   5. Restart the server, reload the page, re-hit the thumbnail endpoint —
//      it must still serve the avatar.
//
// REGRESSION GUARD: the upload pipeline runs the PNG bytes through Jimp's
// `applyAvatarCropResize`, which encodes via the squoosh PNG WASM codec.
// squoosh loads its WASM over a `file://` URL anchored at the resolved
// package location, which is fetched via `src/fetch-patch.js`. The patch
// must accept WASM files under any `node_modules` segment (including
// symlinked installs); a regression that tightens the check back to
// `serverDirectory` only would surface here as a 400 "Is not a valid
// image" response.

import { test, expect } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Use a real image bundled with the repo so the upload exercises the same
// Jimp + squoosh-WASM path a user's file picker triggers.
const SAMPLE_PNG = resolve(__dirname, '..', '..', '..', 'public', 'img', 'addbg3.png');

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [] });
    server = await startServer({ batchKey: 'personas', scenarioId: 'avatar-upload' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#101 — persona avatar upload persists to disk and is served', () => {
    test('upload custom avatar; restart; file is still served + thumbnail responds', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Sanity: fixture exists.
        const pngStats = statSync(SAMPLE_PNG);
        expect(pngStats.size).toBeGreaterThan(0);

        const targetName = `e2e-101-avatar-${Date.now()}.png`;

        // Build a multipart upload via the browser's FormData so it exercises
        // the same network path the file picker triggers (cookies/CSRF flow
        // through the page session).
        const uploadResult = await page.evaluate(async ({ overwriteName, pngBytesBase64 }) => {
            const bin = Uint8Array.from(atob(pngBytesBase64), c => c.charCodeAt(0));
            const blob = new Blob([bin], { type: 'image/png' });
            const fd = new FormData();
            fd.append('avatar', blob, 'source.png');
            fd.append('overwrite_name', overwriteName);

            const ctx = window.Luker.getContext();
            const headers = ctx.getRequestHeaders();
            // Drop Content-Type so the browser fills in the multipart boundary.
            delete headers['Content-Type'];
            delete headers['content-type'];

            const resp = await fetch('/api/avatars/upload', {
                method: 'POST',
                headers,
                body: fd,
            });
            const text = await resp.text();
            return { status: resp.status, body: text };
        }, {
            overwriteName: targetName,
            pngBytesBase64: readFileSync(SAMPLE_PNG).toString('base64'),
        });

        // If fetch-patch is still rejecting node_modules WASM, the upload
        // handler returns 400 "Is not a valid image" — fail loud, do NOT
        // skip.
        expect(uploadResult.status, `upload should succeed; body: ${uploadResult.body}`).toBe(200);
        const uploaded = JSON.parse(uploadResult.body);
        expect(uploaded.path).toBe(targetName);

        // Avatar persisted to dataRoot/default-user/User Avatars/<name>.
        const onDisk = resolve(server.dataRoot, 'default-user', 'User Avatars', targetName);
        expect(statSync(onDisk).size).toBeGreaterThan(0);

        // Thumbnail endpoint serves the same image.
        const thumbResult = await page.evaluate(async ({ name }) => {
            const url = `/thumbnail?type=persona&file=${encodeURIComponent(name)}`;
            const resp = await fetch(url);
            return {
                status: resp.status,
                contentType: resp.headers.get('content-type') || '',
                bytesLen: (await resp.arrayBuffer()).byteLength,
            };
        }, { name: targetName });
        expect(thumbResult.status).toBe(200);
        expect(thumbResult.contentType).toContain('image/');
        expect(thumbResult.bytesLen).toBeGreaterThan(0);

        // Restart server + reload page; thumbnail still serves the avatar.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestartThumb = await page.evaluate(async ({ name }) => {
            const url = `/thumbnail?type=persona&file=${encodeURIComponent(name)}`;
            const resp = await fetch(url);
            return { status: resp.status, bytesLen: (await resp.arrayBuffer()).byteLength };
        }, { name: targetName });
        expect(afterRestartThumb.status).toBe(200);
        expect(afterRestartThumb.bytesLen).toBeGreaterThan(0);
    });
});
