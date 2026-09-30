// e2e/storage/cross-mode-recovery/14-fs-restore-abort-cleanup.e2e.js
//
// A restore whose POST /api/users/restore-backup never reaches the server
// (transport-level failure) must not leak the chunked-upload session: the
// server only deletes the session in its own finally block, so a request
// that dies before the server sees it would leave a multi-GB archive on
// disk until the 24h TTL sweep. This test drives the real Backup Manager
// UI on a real fs server, downloads the fabricated seed as a backup ZIP,
// aborts ONLY the restore POST via page.route, asserts the failure toast,
// and then asserts `_uploads/restore-sessions` is empty.

import { test, expect } from '@playwright/test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer, tearDownServer } from '../../_lib/server.js';
import { startMockLLM } from '../../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../../_lib/fixtures.js';
import { awaitMainUI } from '../../_lib/page.js';
import { openBackupManagerViaUI } from './_lib/recovery-flow.js';

test('restore failure drops the server-side upload session', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-fs-restore-abort-'));
    const mock = await startMockLLM();
    let server = null;

    // Abort only POST /api/users/restore-backup; every upload-session route
    // (create / chunk / finalize / probe / delete) must stay live.
    const isRestorePostPath = (url) => url.pathname === '/api/users/restore-backup';
    const abortRestorePost = (route) => {
        if (route.request().method() === 'POST') {
            return route.abort('failed');
        }
        return route.continue();
    };

    try {
        server = await startServer({
            batchKey: 'xmode',
            scenarioId: '14-fs-restore-abort',
            extraConfig: { 'storage.mode': 'fs' },
        });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

        await awaitMainUI(page, server.baseURL);

        // Open the Backup Manager and download the fabricated default-user
        // corpus as a backup ZIP through the real UI; the popup stays open
        // for the restore below.
        await openBackupManagerViaUI(page);
        const backupZipPath = path.join(tempDir, 'backup.zip');
        const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 30_000 }),
            page.locator('.backupDownloadButton').last().click(),
        ]);
        await download.saveAs(backupZipPath);
        expect(statSync(backupZipPath).size).toBeGreaterThan(1024);

        // Observe the upload-session create request (read-only) so the
        // final assertion can't pass vacuously: the session exists on disk
        // at some point after this request is acknowledged.
        const sessionCreates = [];
        const recordRequest = (req) => {
            if (req.method() === 'POST' && isRestorePostPath(new URL(req.url()))) {
                sessionCreates.push(req.url());
            }
        };
        page.on('request', recordRequest);
        await page.route(isRestorePostPath, abortRestorePost);

        try {
            await page.locator('input[name="backupRestoreMode"][value="overwrite"]').last().click();
            await page.locator('.backupRestoreFileInput').last().setInputFiles(backupZipPath);

            const openPopups = page.locator('dialog.popup[open]');
            const baseCount = await openPopups.count();

            await page.locator('.backupRestoreButton').last().click();
            await expect(openPopups).toHaveCount(baseCount + 1, { timeout: 15_000 });
            const confirmOk = openPopups.last().locator('.popup-button-ok');
            await expect(confirmOk).toBeVisible({ timeout: 10_000 });
            await confirmOk.click();

            // The client uploads + assembles the archive, then the aborted
            // restore POST rejects with a network error.
            await expect(page.locator('.toast-error', { hasText: 'Failed to restore backup' }).last())
                .toBeVisible({ timeout: 60_000 });
            expect(sessionCreates.length).toBeGreaterThanOrEqual(1);

            // The session directory must not linger on disk. Without the
            // client-side abort it survives until the 24h TTL sweep.
            const sessionsRoot = path.join(server.dataRoot, '_uploads', 'restore-sessions');
            await expect.poll(() => {
                try {
                    return readdirSync(sessionsRoot).length;
                } catch (err) {
                    if (err?.code === 'ENOENT') return 0;
                    throw err;
                }
            }, {
                timeout: 15_000,
                message: 'restore upload session directory should be removed after a failed restore request',
            }).toBe(0);
        } finally {
            page.off('request', recordRequest);
            await page.unroute(isRestorePostPath, abortRestorePost);
        }
    } finally {
        await tearDownServer(server);
        await mock?.stop();
        rmSync(tempDir, { recursive: true, force: true });
    }
});
