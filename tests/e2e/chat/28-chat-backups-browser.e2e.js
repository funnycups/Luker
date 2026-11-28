// #28 — Manage Chat Files → Backups browser UI & real error/empty states.
//
// Verifies end-to-end against a real Luker server and browser:
//   1. When no chat backups exist (even if backups/ is absent), opening Backups
//      visibly shows the empty-state message instead of silently hiding the panel.
//   2. Sending a real message creates a chat backup on disk; opening Backups
//      lists it, View displays its messages, and deleting the last backup removes
//      the file and shows the empty-state message.
//   3. When /api/backups/chat/get fails with HTTP 500 (e.g. obstructed backups
//      path), the browser displays both an error toast and a visible error row
//      inside the Backups list instead of silently swallowing the failure.

import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openOptionsAndClick,
} from '../_lib/page.js';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina checks the harbor lantern.* "The beacon is lit and the logbook is backed up."',
        ],
    });
    server = await startServer({
        scope,
        batchKey: 'chat',
        scenarioId: 'chat-backups-browser',
        extraConfig: {
            backups: {
                chat: {
                    throttleInterval: 0,
                },
            },
        },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await mock?.stop();
});

test.describe('#28 — Manage Chat Files Backups browser', () => {
    test('displays empty state, lists/views/deletes real backups, and surfaces server errors', async ({ page }) => {
        const backupsDir = path.resolve(server.dataRoot, 'default-user', 'backups');

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        // Remove backups/ created during initial character load to verify missing-dir ENOENT shows a clean empty state.
        fs.rmSync(backupsDir, { recursive: true, force: true });

        const backupsButton = page.locator('#select_chat_popup button.menu_button:has(.fa-box-open)');
        const backupsList = page.locator('#select_chat_popup .chatBackupsList');

        // 1. Empty state when backups/ directory does not exist yet.
        await openOptionsAndClick(page, 'option_select_chat');
        await backupsButton.waitFor({ state: 'visible', timeout: 10_000 });
        await backupsButton.click();
        await expect(backupsList).toBeVisible({ timeout: 10_000 });
        await expect(backupsList.locator('.chatBackupsListEmpty')).toBeVisible({ timeout: 10_000 });

        // Close Backups panel and Manage Chat Files popup before chatting.
        await backupsButton.click();
        await page.locator('#select_chat_cross').click();
        await page.locator('#select_chat_popup').waitFor({ state: 'hidden', timeout: 10_000 });

        // 2. Send a real message and verify a chat backup file is written on disk.
        await sendMessageAndAwaitReply(page, 'Check the harbor beacon before nightfall.');
        await expect.poll(() => {
            if (!fs.existsSync(backupsDir)) return [];
            return fs.readdirSync(backupsDir).filter(f => f.startsWith('chat_') && f.endsWith('.jsonl'));
        }, { timeout: 15_000 }).not.toHaveLength(0);

        const backupFiles = fs.readdirSync(backupsDir).filter(f => f.startsWith('chat_') && f.endsWith('.jsonl'));
        const expectedBackupName = backupFiles[0];

        // Open Manage Chat Files → Backups; the created backup should be listed.
        await openOptionsAndClick(page, 'option_select_chat');
        await backupsButton.waitFor({ state: 'visible', timeout: 10_000 });
        await backupsButton.click();
        const item = backupsList.locator('.chatBackupsListItem', { hasText: expectedBackupName }).first();
        await expect(item).toBeVisible({ timeout: 10_000 });

        // Click View and verify the backup content textarea contains the assistant reply.
        await item.locator('.fa-eye').click();
        const viewPopup = page.locator('dialog.popup[open]').last();
        const viewTextArea = viewPopup.locator('textarea[readonly]');
        await expect(viewTextArea).toBeVisible({ timeout: 10_000 });
        await expect(viewTextArea).toHaveValue(/logbook is backed up/);
        await viewPopup.locator('.popup-button-ok').click();
        await viewPopup.waitFor({ state: 'hidden', timeout: 10_000 });

        // Delete every listed backup and confirm the list transitions cleanly to empty state.
        while (await backupsList.locator('.chatBackupsListItem').count() > 0) {
            const firstItem = backupsList.locator('.chatBackupsListItem').first();
            await firstItem.locator('.fa-trash').click();
            const confirmPopup = page.locator('dialog.popup[open]').last();
            await confirmPopup.locator('.popup-button-ok').click();
            await confirmPopup.waitFor({ state: 'hidden', timeout: 10_000 });
            await expect(firstItem).toHaveCount(0, { timeout: 10_000 });
        }
        await expect(backupsList.locator('.chatBackupsListEmpty')).toBeVisible({ timeout: 10_000 });
        expect(fs.readdirSync(backupsDir).filter(f => f.startsWith('chat_') && f.endsWith('.jsonl'))).toHaveLength(0);

        // Close Backups panel & popup.
        await backupsButton.click();
        await page.locator('#select_chat_cross').click();
        await page.locator('#select_chat_popup').waitFor({ state: 'hidden', timeout: 10_000 });

        // 3. Trigger a real server-side 500 by obstructing backups/ with a regular file.
        fs.rmSync(backupsDir, { recursive: true, force: true });
        fs.writeFileSync(backupsDir, 'obstructed');
        try {
            await openOptionsAndClick(page, 'option_select_chat');
            await backupsButton.waitFor({ state: 'visible', timeout: 10_000 });
            await backupsButton.click();
            await expect(backupsList).toBeVisible({ timeout: 10_000 });
            await expect(backupsList.locator('.chatBackupsListError')).toBeVisible({ timeout: 10_000 });
            await expect(page.locator('#toast-container .toast-error').last()).toBeVisible({ timeout: 10_000 });
        } finally {
            fs.rmSync(backupsDir, { recursive: true, force: true });
            fs.mkdirSync(backupsDir, { recursive: true });
        }
    });
});
