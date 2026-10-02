// Regression: when the auto-loaded chat fails to load (corrupted file), the
// only startup alert must be the load failure. Background writers (persona
// sync at APP_READY) used to trip the chat-write integrity guard one second
// after the failed load and raise a spurious "Chat save aborted" toast on top
// of the load-failure toast.
//
// Real user flow:
//   1. Open a character so a chat file exists on disk.
//   2. Enable "Auto-load chat" via the real User Settings checkbox.
//   3. Corrupt the chat file, reload the page.
//   4. Auto-load fails → "Chat load failed" toast. No "Chat save aborted"
//      toast may follow.

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [] });
    server = await startServer({ batchKey: 'regression', scenarioId: 'startup-corrupted-chat-toast' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Open the drawer whose toggle button has id=drawerButtonId, if closed.
 * Same pattern as personas/102-settings-panels-persist.
 */
async function ensureDrawerOpen(page, drawerButtonId) {
    const button = page.locator(`#${drawerButtonId}`);
    await button.waitFor({ state: 'attached', timeout: 5000 });
    const closed = await page.locator(`#${drawerButtonId} .drawer-icon.closedIcon`).count();
    if (closed > 0) {
        await page.locator(`#${drawerButtonId} .drawer-toggle`).click();
        await page.waitForFunction((id) => {
            const icon = document.querySelector(`#${id} .drawer-icon`);
            return icon && icon.classList.contains('openIcon');
        }, drawerButtonId, { timeout: 5000 }).catch(() => {});
    }
}

test.describe('corrupted auto-loaded chat does not raise a save-aborted toast', () => {
    test('startup shows only the load failure', async ({ page }) => {
        test.setTimeout(180_000);

        const toasts = [];
        await page.exposeFunction('__recordToast', (entry) => toasts.push(entry));
        await page.addInitScript(() => {
            const iv = setInterval(() => {
                if (window.toastr && !window.__toastHooked) {
                    window.__toastHooked = true;
                    for (const level of ['error', 'info', 'warning', 'success']) {
                        const orig = window.toastr[level].bind(window.toastr);
                        window.toastr[level] = (...args) => {
                            window.__recordToast?.([level, ...args.map(String)]);
                            return orig(...args);
                        };
                    }
                    clearInterval(iv);
                }
            }, 10);
        });

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 });

        // Positive control: on a healthy load the persona tracker still
        // writes its metadata (the fix must not disable the feature).
        await expect.poll(
            () => page.evaluate(() => window.Luker.getContext().chatMetadata?.last_user_persona?.avatar || null),
            { timeout: 10_000 },
        ).toBeTruthy();

        const chatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(chatId, 'opening the character must yield an active chat id').toBeTruthy();
        const chatFile = resolve(server.dataRoot, 'default-user', 'chats', 'default_Seraphina', `${chatId}.jsonl`);
        await expect.poll(() => existsSync(chatFile), { timeout: 10_000 }).toBe(true);
        expect(readFileSync(chatFile, 'utf8')).toContain('chat_metadata');

        // Enable auto-load via the real User Settings checkbox.
        await ensureDrawerOpen(page, 'user-settings-button');
        const autoLoad = page.locator('#auto-load-chat-checkbox');
        await autoLoad.scrollIntoViewIfNeeded().catch(() => {});
        await autoLoad.check();
        await expect(autoLoad).toBeChecked();
        // Let the 1000ms saveSettingsDebounced flush persist the toggle.
        await page.waitForTimeout(1500);

        // Corrupt the chat file the card points at, then reboot the client.
        writeFileSync(chatFile, 'THIS IS NOT JSON AT ALL');
        toasts.length = 0;

        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60_000 });
        await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });

        // The failed load must surface its own alert.
        await expect.poll(
            () => toasts.some(t => t.includes('Chat load failed')),
            { timeout: 30_000 },
        ).toBe(true);

        // Give the persona-sync debounce (1s) plus the save round-trip time
        // to fire; no save-aborted alert may appear.
        await page.waitForTimeout(6000);
        const abortToasts = toasts.filter(t => t.includes('Chat save aborted'));
        expect(abortToasts, `unexpected save-aborted toasts: ${JSON.stringify(abortToasts)}`).toEqual([]);

        // The failed load leaves the chat half-loaded; the write guards must
        // have dropped the background write instead of saving.
        const integrity = await page.evaluate(() => window.Luker.getContext().chatMetadata?.integrity ? 'present' : 'MISSING');
        expect(integrity).toBe('MISSING');
    });
});
