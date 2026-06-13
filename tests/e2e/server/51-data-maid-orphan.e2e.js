// #51 — data-maid orphan cleanup.
//
// Create an orphan resource — a character avatar thumbnail whose source
// character PNG has been deleted. The data-maid scan should flag that
// thumbnail under `avatarThumbnails` (per src/endpoints/data-maid.js
// #collectAvatarThumbnails). Calling /api/data-maid/delete with the
// orphan's hash + token should remove just the orphan and leave the rest
// of the user's data untouched.

import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'server', scenarioId: 'data-maid' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#51 — data-maid orphan cleanup', () => {
    test('orphan avatar thumbnail flagged and deleted; live files preserved', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const userRoot = resolve(server.dataRoot, 'default-user');
        const charactersDir = resolve(userRoot, 'characters');
        const thumbsDir = resolve(userRoot, 'thumbnails', 'avatar');
        mkdirSync(thumbsDir, { recursive: true });

        // Pick any existing PNG byte stream we can clone as the thumbnail
        // body — content doesn't matter, only the filename matters for the
        // orphan detection.
        const realCharPng = readdirSync(charactersDir).find(f => f.endsWith('.png'));
        expect(realCharPng, 'no seed character PNG found in default-user/characters').toBeTruthy();
        const realCharBytes = readFileSync(resolve(charactersDir, realCharPng));

        // (1) Create an orphan thumbnail — a PNG in thumbnails/avatar with no
        //     matching character of the same name.
        const orphanName = 'orphan-deleted-char.png';
        const orphanPath = resolve(thumbsDir, orphanName);
        writeFileSync(orphanPath, realCharBytes);
        expect(existsSync(orphanPath)).toBe(true);

        // (2) Also create a NON-orphan thumbnail — a thumb that DOES have a
        //     matching character PNG (the seed character). This one should
        //     survive the cleanup.
        const liveThumbPath = resolve(thumbsDir, realCharPng);
        writeFileSync(liveThumbPath, realCharBytes);
        expect(existsSync(liveThumbPath)).toBe(true);

        // (3) Run /api/data-maid/report. It returns:
        //       { report: { avatarThumbnails: [{ name, hash, ... }, ...], ... }, token }
        const reportResult = await page.evaluate(async () => {
            const tokenResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await tokenResp.json();
            const resp = await fetch('/api/data-maid/report', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'X-CSRF-Token': token },
            });
            return { status: resp.status, body: await resp.text() };
        });
        expect(reportResult.status, `report status ${reportResult.status}; body=${reportResult.body.slice(0,200)}`).toBe(200);
        const { report, token: maidToken } = JSON.parse(reportResult.body);
        expect(report).toBeTruthy();
        expect(Array.isArray(report.avatarThumbnails)).toBe(true);

        // Find the orphan entry and the live entry in the report.
        const orphanEntry = report.avatarThumbnails.find(e => e.name === orphanName);
        const liveEntry = report.avatarThumbnails.find(e => e.name === realCharPng);
        expect(orphanEntry, `orphan ${orphanName} should be flagged; report.avatarThumbnails=${JSON.stringify(report.avatarThumbnails.map(e => e.name))}`).toBeTruthy();
        // Live thumbnail (matching character PNG) should NOT appear as loose.
        expect(liveEntry, `live thumbnail ${realCharPng} should NOT be flagged as loose; report.avatarThumbnails=${JSON.stringify(report.avatarThumbnails.map(e => e.name))}`).toBeFalsy();

        // (4) Delete just the orphan via /api/data-maid/delete with its hash.
        const deleteResult = await page.evaluate(async ({ token: maidToken, hash }) => {
            const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token: csrfTok } = await csrfResp.json();
            const resp = await fetch('/api/data-maid/delete', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfTok },
                body: JSON.stringify({ token: maidToken, hashes: [hash] }),
            });
            return { status: resp.status, body: (await resp.text()).slice(0, 200) };
        }, { token: maidToken, hash: orphanEntry.hash });
        expect(deleteResult.status, `delete status ${deleteResult.status}; body=${deleteResult.body}`).toBe(204);

        // (5) Verify on disk: orphan gone, live thumb still present, character
        //     PNG untouched.
        expect(existsSync(orphanPath), 'orphan should be deleted').toBe(false);
        expect(existsSync(liveThumbPath), 'live thumbnail should be untouched').toBe(true);
        expect(existsSync(resolve(charactersDir, realCharPng)), 'character PNG should be untouched').toBe(true);
    });
});
