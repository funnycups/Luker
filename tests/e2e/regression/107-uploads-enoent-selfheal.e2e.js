// #107 — character import survives _uploads/ being wiped mid-session
// (commit 69ebf6e5d)
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
// REAL USER FLOW: do a character import via the visible import button
// (#character_import_button + setInputFiles on its hidden file input).
// Wait for the new card to appear. Wipe _uploads/ on disk. Do the SAME
// import a second time — assert another card appears. If multer's
// per-request ensureDirectory regresses, the second import 5xx's and
// no card lands; we also watch the toastr stream for any error popups.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { existsSync, rmSync, statSync, copyFileSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SEED_PNG = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');

let server;
let tmpDir;
let firstUploadPath;
let secondUploadPath;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: '107-uploads-enoent', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });

    // Stage two copies of the seed PNG with distinct file names. Same
    // image bytes either way — the regression cares about the upload
    // path, not the contents.
    tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-107-'));
    firstUploadPath = resolve(tmpDir, 'card-warmup.png');
    secondUploadPath = resolve(tmpDir, 'card-post-wipe.png');
    copyFileSync(SEED_PNG, firstUploadPath);
    copyFileSync(SEED_PNG, secondUploadPath);
});

test.afterAll(async () => {
    await tearDownServer(server);
    if (tmpDir) {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
});

test.describe('#107 — character import survives _uploads/ wipe', () => {
    test('second character import after rm -rf _uploads/ still lands a new card', async ({ page }) => {
        const uploadsPath = resolve(server.dataRoot, '_uploads');

        await awaitMainUI(page, server.baseURL);

        // Listen for toastr error popups — pre-fix, a wiped _uploads/
        // surfaces as a toastr error during the second import. Treat
        // ANY toastr-error appearing during the post-wipe import as a
        // failure signal alongside the missing card.
        const toastrErrors = [];
        await page.exposeBinding('__e2e107RecordToastError', (_, msg) => {
            toastrErrors.push(String(msg));
        }).catch(() => { /* may already be exposed */ });
        await page.evaluate(() => {
            try {
                const orig = window.toastr?.error;
                if (typeof orig === 'function' && !window.toastr.__e2e107Wrapped) {
                    window.toastr.error = function (msg, ...rest) {
                        try { window.__e2e107RecordToastError(String(msg || '')); } catch {}
                        return orig.apply(this, [msg, ...rest]);
                    };
                    window.toastr.__e2e107Wrapped = true;
                }
            } catch { /* tolerate */ }
        });

        // 1. First import: drives the real visible button + file input.
        //    The seed PNG embeds Seraphina's card data so the imported
        //    name will be Seraphina (or Seraphina_<n> on dupes); we don't
        //    care about the specific name — only that the card count grows.
        //    Open the right-nav drawer first so the count is observable.
        const drawer = page.locator('#rightNavDrawerIcon');
        if (await drawer.evaluate(el => el.classList.contains('closedIcon')).catch(() => true)) {
            await drawer.click();
            await page.locator('#rm_print_characters_block').waitFor({ state: 'visible', timeout: 10_000 });
        }
        const allCards = page.locator('#rm_print_characters_block .character_select');
        const countBeforeFirst = await allCards.count();
        await page.locator('#character_import_button').click().catch(() => {});
        await page.locator('#character_import_file').setInputFiles(firstUploadPath);
        await expect.poll(async () => await allCards.count(), {
            message: 'first import should add a new character card',
            timeout: 30_000,
        }).toBeGreaterThan(countBeforeFirst);
        expect(existsSync(uploadsPath), '_uploads/ should exist after first multer touch').toBe(true);

        // 2. Wipe _uploads/ while the server is still running. This is
        //    the bug trigger — pre-fix, multer's dest path is cached at
        //    boot and subsequent uploads ENOENT.
        rmSync(uploadsPath, { recursive: true, force: true });
        expect(existsSync(uploadsPath), '_uploads/ should be gone after rm -rf').toBe(false);

        // 3. Second import — the bug-triggering path. We don't care
        //    about the exact name, just that the total card count grew
        //    again (proving the import succeeded).
        const countBeforeSecond = await allCards.count();
        await page.locator('#character_import_button').click().catch(() => {});
        await page.locator('#character_import_file').setInputFiles(secondUploadPath);
        await expect.poll(async () => await allCards.count(), {
            message: 'second import (post-rm -rf _uploads/) must add a new card; ' +
                'if multer\'s per-request ensureDirectory regresses, the upload 5xx\'s and no card lands',
            timeout: 30_000,
        }).toBeGreaterThan(countBeforeSecond);

        // 4. _uploads/ should be back on disk after the per-request
        //    ensureDirectory recreated it.
        expect(existsSync(uploadsPath), '_uploads/ must be re-created by per-request ensureDirectory').toBe(true);
        const st = statSync(uploadsPath);
        expect(st.isDirectory()).toBe(true);

        // 5. No toastr.error should have fired during the post-rm import.
        //    Pre-fix the failure surfaces as an error toast.
        expect(toastrErrors,
            `no toastr.error should fire during the post-wipe import; got: ${JSON.stringify(toastrErrors)}`,
        ).toEqual([]);
    });
});
