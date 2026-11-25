// tests/e2e/server/57-backup-config-ui.e2e.js
//
// End-to-end verification of the admin Backup Settings UI:
//   1. Shortcut from Account → Backup and entry from User management → Server
//      open `adminBackups`; client validation blocks invalid integers; saving
//      persists all six keys to config.yaml with comments intact, invalidates
//      raw Config cache, syncs the Backup download banner, and survives reload.
//   2. Live runtime reload without restarting the server: disabling
//      `backups.chat.enabled` stops chat backup creation on real chat edits,
//      and re-enabling with `numberOfBackups: 1` and `throttleInterval: 0`
//      resumes backups and enforces the retention cap immediately.
//   3. Active environment variable overrides are surfaced in the UI without
//      overwriting config.yaml's on-disk value when saving other fields.
//   4. Non-admin users in multi-user mode do not see the Backup Settings
//      shortcut and receive HTTP 403 from both backup config endpoints.

import { test, expect } from '../../harness/playwright.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { startServer } from '../../harness/server.js';
import { awaitMainUI, createUserViaAdminUI, selectCharacterByName } from '../_lib/page.js';
import { markOnboarded } from '../_lib/fixtures.js';
import {
    accountWindow,
    closeAccountWindow,
    formError,
    openAccountTab,
    openAdminPage,
    pageHead,
    windowToast,
} from '../_lib/account-window.js';
import { createBlankCharacter } from '../_lib/ui-character.js';
import { loginAs } from '../_lib/sync.js';

/** Lists chat backup filenames for default-user on disk. */
function listChatBackups(dataRoot) {
    const dir = path.join(dataRoot, 'default-user', 'backups');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(name => name.startsWith('chat_') && name.endsWith('.jsonl'));
}

/** Edits message 0 through the real chat UI and awaits POST /api/chats/{save,patch}. */
async function editFirstMessageViaUI(page, nextText) {
    const firstMes = page.locator('#chat .mes').first();
    await firstMes.waitFor({ state: 'visible', timeout: 15_000 });
    await firstMes.locator('.mes_edit').click({ force: true });
    const editBox = firstMes.locator('.edit_textarea');
    await editBox.waitFor({ state: 'visible', timeout: 10_000 });
    await editBox.fill(nextText);
    const savePromise = page.waitForResponse(
        res => /\/api\/chats\/(save|patch)\b/.test(res.url()) && res.request().method() === 'POST',
        { timeout: 20_000 },
    );
    await firstMes.locator('.mes_edit_done').click();
    const res = await savePromise;
    expect(res.status()).toBe(200);
}

// Run scenarios serially inside this test file so three Luker servers do not
// contend on disk/CPU during `/api/users/create` content seeding.
test.describe.serial('admin backup settings UI', () => {
    test('saves config.yaml preserving comments, syncs cross-views, and applies live without restart', async ({ page, resources }) => {
        test.setTimeout(180_000);
        const server = await startServer({
            scope: resources,
            batchKey: 'server',
            scenarioId: 'backup-config-ui',
            extraConfig: { enableUserAccounts: false },
        });
        markOnboarded({ dataRoot: server.dataRoot });

        try {
            await awaitMainUI(page, server.baseURL);

            // 1. Admin shortcut on Account → Backup jumps straight to adminBackups,
            // and Back returns to User management → Server.
            await openAccountTab(page, 'backup');
            const win = accountWindow(page);
            const shortcut = win.locator('[data-act="backup-settings"]');
            await expect(shortcut).toBeVisible();
            await shortcut.click();
            await expect(pageHead(page)).toHaveAttribute('data-view', 'adminBackups', { timeout: 10_000 });

            await pageHead(page).locator('[data-act="back"]').click();
            await expect(pageHead(page)).toHaveAttribute('data-view', 'users', { timeout: 10_000 });
            await expect(win.locator('[data-act="adm-seg"][data-seg="server"]')).toHaveAttribute('aria-selected', 'true');

            // 2. Re-open from Server menu and verify client-side validation blocks bad input.
            await win.locator('[data-act="adm-push"][data-view="adminBackups"]').click();
            await expect(pageHead(page)).toHaveAttribute('data-view', 'adminBackups', { timeout: 10_000 });

            const numInput = win.locator('[data-model="top.form.numberOfBackups"]');
            await expect(numInput).toHaveValue('50');

            const yamlBefore = readFileSync(server.configPath, 'utf8');
            await numInput.fill('-5');
            await win.locator('[data-act="adm-backups-save"]').click();
            await expect(formError(page)).toBeVisible();
            expect(readFileSync(server.configPath, 'utf8')).toBe(yamlBefore);

            // 3. Configure all six fields and save.
            await numInput.fill('2');
            await win.locator('[data-act="adm-toggle"][data-path="top.form.unlimitedTotal"]').click();
            const maxTotalInput = win.locator('[data-model="top.form.maxTotalBackups"]');
            await expect(maxTotalInput).toBeVisible();
            await maxTotalInput.fill('3');
            await win.locator('[data-model="top.form.throttleInterval"]').fill('0');
            await win.locator('[data-act="adm-toggle"][data-path="top.form.checkIntegrity"]').click();
            await win.locator('[data-act="adm-toggle"][data-path="top.form.allowFullDataBackup"]').click();

            const saveResPromise = page.waitForResponse(
                res => res.url().includes('/api/users/backups/config/save') && res.request().method() === 'POST',
            );
            await win.locator('[data-act="adm-backups-save"]').click();
            const saveRes = await saveResPromise;
            expect(saveRes.status()).toBe(200);
            await expect(windowToast(page)).toBeVisible();

            // 4. Verify on-disk config.yaml updated AND original comments survived.
            const yamlAfter = readFileSync(server.configPath, 'utf8');
            expect(yamlAfter).toContain('## BACKUP CONFIGURATION');
            expect(yamlAfter).toContain('# Number of backups to keep for each chat and settings file');
            expect(yamlAfter).toMatch(/allowFullDataBackup:\s*false/);
            expect(yamlAfter).toMatch(/numberOfBackups:\s*2/);
            expect(yamlAfter).toMatch(/checkIntegrity:\s*false/);
            expect(yamlAfter).toMatch(/maxTotalBackups:\s*3/);
            expect(yamlAfter).toMatch(/throttleInterval:\s*0/);

            // 5. Switching to Account → Backup reflects disabled full-data downloads immediately.
            await openAccountTab(page, 'backup');
            await expect(win.locator('[data-act="backup-go"]')).toBeDisabled();

            // 6. Opening raw Config page shows the newly saved YAML (cache invalidated),
            // and re-enabling allowFullDataBackup there immediately unblocks Account → Backup.
            await openAdminPage(page, 'adminConfig');
            const rawConfigInput = win.locator('[data-model="top.content"]');
            const rawConfigText = await rawConfigInput.inputValue();
            expect(rawConfigText).toMatch(/numberOfBackups:\s*2/);
            expect(rawConfigText).toMatch(/maxTotalBackups:\s*3/);

            await rawConfigInput.fill(rawConfigText.replace(/allowFullDataBackup:\s*false/, 'allowFullDataBackup: true'));
            await win.locator('[data-act="adm-config-save"]').click();
            await expect(windowToast(page)).toBeVisible();

            await openAccountTab(page, 'backup');
            await expect(win.locator('[data-act="backup-go"]')).toBeEnabled();

            // 7. Full browser reload preserves all saved settings in the Backup Settings form.
            await page.reload();
            await awaitMainUI(page, server.baseURL);
            await openAdminPage(page, 'adminBackups');
            await expect(win.locator('[data-model="top.form.numberOfBackups"]')).toHaveValue('2');
            await expect(win.locator('[data-model="top.form.maxTotalBackups"]')).toHaveValue('3');
            await expect(win.locator('[data-model="top.form.throttleInterval"]')).toHaveValue('0');
            await expect(win.locator('[data-act="adm-toggle"][data-path="top.form.checkIntegrity"]')).not.toHaveClass(/\bon\b/);
            await expect(win.locator('[data-act="adm-toggle"][data-path="top.form.allowFullDataBackup"]')).toHaveClass(/\bon\b/);

            // 8. Live runtime effect WITHOUT restarting the server:
            // Turn off automatic chat backups -> editing chat creates zero backups.
            await win.locator('[data-act="adm-toggle"][data-path="top.form.chatEnabled"]').click();
            await expect(win.locator('[data-model="top.form.throttleInterval"]')).toHaveCount(0);
            // Check integrity stays visible independently of auto-backup toggle.
            await expect(win.locator('[data-act="adm-toggle"][data-path="top.form.checkIntegrity"]')).toBeVisible();
            await win.locator('[data-act="adm-backups-save"]').click();
            await expect(windowToast(page)).toBeVisible();
            await closeAccountWindow(page);

            await createBlankCharacter(page, { name: 'Lyra', firstmes: 'The lantern flickers softly.' });
            await selectCharacterByName(page, 'Lyra');
            const beforeDisabledCount = listChatBackups(server.dataRoot).length;
            await editFirstMessageViaUI(page, 'The lantern steadies against the draft.');
            expect(listChatBackups(server.dataRoot).length).toBe(beforeDisabledCount);

            // Re-enable automatic chat backups with numberOfBackups = 1, throttleInterval = 0 ->
            // subsequent real chat edits create backups and stay capped at 1 without server restart.
            await openAdminPage(page, 'adminBackups');
            await win.locator('[data-act="adm-toggle"][data-path="top.form.chatEnabled"]').click();
            await win.locator('[data-model="top.form.numberOfBackups"]').fill('1');
            await win.locator('[data-model="top.form.throttleInterval"]').fill('0');
            await win.locator('[data-act="adm-backups-save"]').click();
            await expect(windowToast(page)).toBeVisible();
            await closeAccountWindow(page);

            await editFirstMessageViaUI(page, 'Rain taps quietly against the tall window.');
            await expect.poll(() => listChatBackups(server.dataRoot).length, { timeout: 10_000 }).toBe(1);

            // Wait past generateTimestamp()'s 1-second resolution so the next save produces a distinct filename.
            await page.waitForTimeout(1150);
            await editFirstMessageViaUI(page, 'Footsteps echo along the stone corridor.');
            await expect.poll(() => {
                const files = listChatBackups(server.dataRoot);
                if (files.length !== 1) return false;
                const text = readFileSync(path.join(server.dataRoot, 'default-user', 'backups', files[0]), 'utf8');
                return text.includes('Footsteps echo along the stone corridor.');
            }, { timeout: 10_000 }).toBe(true);
        } finally {
            await server.stop();
        }
    });

    test('surfaces active env override and does not overwrite file value when saving another field', async ({ page, resources }) => {
        const server = await startServer({
            scope: resources,
            batchKey: 'server',
            scenarioId: 'backup-config-env-override',
            extraConfig: { enableUserAccounts: false },
            extraEnv: { LUKER_BACKUPS_COMMON_NUMBEROFBACKUPS: '7' },
        });
        markOnboarded({ dataRoot: server.dataRoot });

        try {
            await awaitMainUI(page, server.baseURL);
            await openAdminPage(page, 'adminBackups');
            const win = accountWindow(page);

            await expect(win.locator('[data-role="env-overrides-banner"]')).toBeVisible();
            const envHint = win.locator('[data-env-key="backups.common.numberOfBackups"]');
            await expect(envHint).toContainText('LUKER_BACKUPS_COMMON_NUMBEROFBACKUPS');
            await expect(envHint).toContainText('7');

            // Form input stays bound to config.yaml's file value (50), not env value (7).
            await expect(win.locator('[data-model="top.form.numberOfBackups"]')).toHaveValue('50');

            // Toggle another field and save -> config.yaml retains numberOfBackups: 50.
            await win.locator('[data-act="adm-toggle"][data-path="top.form.allowFullDataBackup"]').click();
            await win.locator('[data-act="adm-backups-save"]').click();
            await expect(windowToast(page)).toBeVisible();

            const onDisk = readFileSync(server.configPath, 'utf8');
            expect(onDisk).toMatch(/numberOfBackups:\s*50/);
            expect(onDisk).toMatch(/allowFullDataBackup:\s*false/);
        } finally {
            await server.stop();
        }
    });

    test('non-admin sees no Backup Settings shortcut and gets 403 from backup config endpoints', async ({ browser, page, resources }) => {
        const server = await startServer({
            scope: resources,
            batchKey: 'server',
            scenarioId: 'backup-config-non-admin',
            extraConfig: { enableUserAccounts: true },
        });

        try {
            const adminCtx = await browser.newContext();
            const adminPage = await adminCtx.newPage();
            try {
                await awaitMainUI(adminPage, server.baseURL);
                await createUserViaAdminUI(adminPage, { handle: 'alice', name: 'Alice', password: 'pw-alice' });
            } finally {
                await adminCtx.close();
            }

            await loginAs(page, server.baseURL, { handle: 'alice', password: 'pw-alice' });
            await openAccountTab(page, 'backup');
            const win = accountWindow(page);

            await expect(win.locator('[data-act="backup-settings"]')).toHaveCount(0);
            await expect(win.locator('.dw-tab[data-tab="users"]')).toHaveCount(0);

            const statuses = await page.evaluate(async () => {
                const csrf = await fetch('/csrf-token').then(r => r.json()).then(d => d.token);
                const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
                const getRes = await fetch('/api/users/backups/config/get', { method: 'POST', headers, body: '{}' });
                const saveRes = await fetch('/api/users/backups/config/save', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        allowFullDataBackup: true,
                        common: { numberOfBackups: 10 },
                        chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 },
                    }),
                });
                return { get: getRes.status, save: saveRes.status };
            });

            expect(statuses).toEqual({ get: 403, save: 403 });
        } finally {
            await server.stop();
        }
    });
});
