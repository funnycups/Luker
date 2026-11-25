// #141 — generation-scoped background keep-alive is released once every
// generation has settled.
//
// On a mobile browser with **Background keep-alive on mobile** set to
// Audio, every generation holds the keep-alive mode while it runs. The
// hold must be released when the generation settles, whatever path it
// ends through:
//   - a slash command typed into the input box, which ends without a reply,
//   - a reply that a background auto-select quiet generation overlaps.
// A read-only probe observes the generation ownership used by keep-alive;
// the mode itself cannot enter Audio in headless Chromium.

import { test, expect } from '../../harness/playwright.js';
import { devices } from '@playwright/test';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageViaUI,
    sendMessageAndAwaitReply,
    closeAnyOpenTopSettingsDrawer,
} from '../_lib/page.js';

// eslint-disable-next-line no-unused-vars
const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
test.use({ ...pixel });

const REPLY = '*Seraphina pulls her shawl tighter against the wind.* "The tide will turn soon. We should be off the rocks by then."';
const OVERLAPPED_REPLY = '*Seraphina points at the far headland.* "There. That is where the path comes down."';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'regression', scenarioId: '141-keep-alive-release' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

/** @param {import('@playwright/test').Page} page */
function readGenerationInFlight(page) {
    return page.evaluate(async () => (await import('/scripts/power-user.js')).scopedKeepAliveShouldHold());
}

/** @param {import('@playwright/test').Page} page */
async function enableAudioKeepAlive(page) {
    await closeAnyOpenTopSettingsDrawer(page);
    await page.locator('#user-settings-button .drawer-toggle').click();
    const checkbox = page.locator('#luker_mobile_keep_alive');
    await checkbox.scrollIntoViewIfNeeded();
    await checkbox.click();
    const dialog = page.locator('dialog.popup[open]', { hasText: 'Background keep-alive' });
    await dialog.locator('.popup-button-custom', { hasText: 'Audio' }).click();
    await expect(dialog).toBeHidden();
    await expect(checkbox).toBeChecked();
    await closeAnyOpenTopSettingsDrawer(page);
}

test.describe('#141 — generation-scoped keep-alive release', () => {
    test('every settled generation releases its keep-alive hold', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableAudioKeepAlive(page);
        expect(await readGenerationInFlight(page)).toBe(false);

        // A slash command from the input box runs through Generate and
        // ends without a reply.
        await sendMessageViaUI(page, '/echo The lantern is lit.');
        const echoToast = page.locator('#toast-container .toast', { hasText: 'The lantern is lit.' });
        await expect(echoToast).toBeVisible({ timeout: 10_000 });
        // Dismiss the toast so it does not overlay drawer buttons on mobile viewports.
        await echoToast.click();
        await expect(echoToast).toHaveCount(0, { timeout: 10_000 });
        await expect.poll(() => readGenerationInFlight(page), { timeout: 10_000 }).toBe(false);

        mock.scriptReply(REPLY);
        await sendMessageAndAwaitReply(page, '"How long until the tide turns?"', { timeoutMs: 60_000 });
        await expect.poll(() => readGenerationInFlight(page), { timeout: 10_000 }).toBe(false);

        // A reply overlapped by a background auto-select quiet generation.
        // The held reply takes its queued text only once released, after
        // the quiet generation has taken the background title.
        const replyHold = mock.holdNextQueuedRequest();
        mock.scriptReply('bedroom red');
        mock.scriptReply(OVERLAPPED_REPLY);
        await sendMessageViaUI(page, '"Which way down from here?"');
        await replyHold.requested;
        expect(await readGenerationInFlight(page)).toBe(true);
        await page.locator('#backgrounds-drawer-toggle').click();
        await expect(page.locator('#Backgrounds')).toHaveClass(/\bopenDrawer\b/, { timeout: 5000 });
        await page.locator('#auto_background').click();
        await expect(page.locator('#bg_menu_content .bg_example[bgfile="bedroom red.jpg"]'))
            .toHaveClass(/\bselected-background\b/, { timeout: 30_000 });
        expect(await readGenerationInFlight(page)).toBe(true);
        replyHold.release();
        await expect(page.locator('#chat .last_mes .mes_text')).toContainText('far headland', { timeout: 30_000 });
        await expect(page.locator('#mes_stop')).toBeHidden();
        await expect.poll(() => readGenerationInFlight(page), { timeout: 10_000 }).toBe(false);
    });
});
