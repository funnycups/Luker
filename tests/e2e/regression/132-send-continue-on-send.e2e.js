// Regression: pressing Send on an empty input with "Press Send to continue"
// enabled must start a continue generation. The guard reads the last chat
// message via `lastMessage`; a refactor dropped the declaration and every
// empty-input send crashed with a ReferenceError before reaching Generate.
//
// Real user flow: open User Settings, check the "Press Send to continue"
// checkbox, load a character with a greeting, click Send with an empty
// textarea, and assert the mock LLM received the continue request.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina keeps her eyes on the reef line and lets the sentence hang.*',
    ] });
    server = await startServer({ batchKey: 'regression', scenarioId: 'send-continue-on-send' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('empty-input send with continue_on_send enabled', () => {
    test('clicks Send on an empty textarea and the continue generation fires', async ({ page }) => {
        const pageErrors = [];
        page.on('pageerror', err => pageErrors.push(String(err)));

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 });

        // Enable "Press Send to continue" through the real settings UI.
        const settingsDrawer = page.locator('#user-settings-button');
        await settingsDrawer.waitFor({ state: 'visible', timeout: 10_000 });
        const drawerClosed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count().then(n => n > 0);
        if (drawerClosed) {
            await page.locator('#user-settings-button .drawer-toggle').click();
            await page.waitForFunction(() => {
                const el = document.getElementById('user-settings-block');
                return el && !el.classList.contains('closedDrawer');
            }, { timeout: 5_000 });
        }
        const continueOnSend = page.locator('#continue_on_send');
        await continueOnSend.check();
        await expect(continueOnSend).toBeChecked();

        // Close the drawer so it doesn't cover the send button.
        const openDrawers = page.locator('#top-settings-holder .drawer-content.openDrawer:not(.pinnedOpen)');
        if (await openDrawers.count() > 0) {
            await page.evaluate(() => {
                for (const drawer of document.querySelectorAll('#top-settings-holder .drawer-content.openDrawer:not(.pinnedOpen)')) {
                    const toggle = drawer.closest('.drawer')?.querySelector(':scope > .drawer-toggle');
                    toggle?.click();
                }
            });
        }

        // Empty textarea, then click Send via the real button.
        await page.locator('#send_textarea').fill('');
        const requestsBefore = mock.requests.length;
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 15_000 });
        await page.locator('#send_but').click();

        // A continue generation must reach the backend. Before the fix the
        // click threw `lastMessage is not defined` and no request fired.
        await expect.poll(() => mock.requests.length, { timeout: 30_000 }).toBeGreaterThan(requestsBefore);

        // No uncaught ReferenceError from the send path.
        expect(pageErrors.filter(e => e.includes('lastMessage'))).toEqual([]);
    });
});
