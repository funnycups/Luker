// #25 — Arrow key swipes toggle.
//
// Real user flow: open User Settings, uncheck "Arrow key swipes", close the
// drawer, press ArrowRight with the chat focused, and confirm no swipe starts.
// Reload to confirm the setting persisted. Then re-check the option, press
// ArrowRight again, and confirm the last reply swipes to a new variant through
// the real keydown handler.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName, sendMessageAndAwaitReply, getChatSnapshot } from '../_lib/page.js';

let fileScope;

test.beforeAll(async ({ workerResources }, testInfo) => {
    fileScope = await workerResources.scenario(testInfo.file);
});

const FIRST_REPLY = '*Seraphina traces the reef line on the chart.* "The tide turned an hour ago. We have until dawn."';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [FIRST_REPLY] });
    server = await startServer({ scope: fileScope, batchKey: 'chat', scenarioId: 'arrow-key-swipe-toggle' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await mock?.stop();
});

async function openUserSettings(page) {
    const drawerClosed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count().then(n => n > 0);
    if (drawerClosed) {
        await page.locator('#user-settings-button .drawer-toggle').click();
    }
    await page.waitForFunction(() => {
        const el = document.getElementById('user-settings-block');
        return el && !el.classList.contains('closedDrawer');
    }, { timeout: 5_000 });
}

async function closeOpenDrawers(page) {
    const openDrawers = page.locator('#top-settings-holder .drawer-content.openDrawer:not(.pinnedOpen)');
    if (await openDrawers.count() > 0) {
        await page.evaluate(() => {
            for (const drawer of document.querySelectorAll('#top-settings-holder .drawer-content.openDrawer:not(.pinnedOpen)')) {
                const toggle = drawer.closest('.drawer')?.querySelector(':scope > .drawer-toggle');
                toggle?.click();
            }
        });
    }
}

async function focusChat(page) {
    // Move focus out of the settings checkbox without touching any app state.
    await page.locator('#chat .last_mes .mes_text').click();
}

async function waitForGenerationIdle(page, timeoutMs = 30_000) {
    await page.waitForFunction(() => {
        const stop = document.querySelector('#mes_stop');
        return !stop || getComputedStyle(stop).display === 'none';
    }, { timeout: timeoutMs });
}

async function readSwipeCounter(page) {
    const text = await page.locator('#chat .last_mes .swipes-counter').first().innerText().catch(() => '');
    return text.replace(/[\u200b]/g, '');
}

async function readLastMessageSwipeState(page) {
    const snapshot = await getChatSnapshot(page);
    const last = snapshot.messages.at(-1);
    return { swipes: last.swipes?.length ?? 0, swipeId: last.swipe_id };
}

test.describe('#25 — arrow key swipes setting', () => {
    test('ArrowRight only swipes when the setting is enabled', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 });
        await sendMessageAndAwaitReply(page, 'What do you read in the reef tonight?');
        await waitForGenerationIdle(page);
        await expect.poll(() => readSwipeCounter(page), { timeout: 10_000 }).toBe('1/1');

        // Turn the setting off through the real User Settings checkbox.
        await openUserSettings(page);
        await expect(page.locator('#arrow-key-swipes')).toBeVisible();
        await expect(page.locator('#gestures-checkbox')).toBeHidden();
        const arrowKeySwipes = page.locator('#arrow-key-swipes');
        await arrowKeySwipes.uncheck();
        await expect(arrowKeySwipes).not.toBeChecked();
        await closeOpenDrawers(page);

        const before = await readLastMessageSwipeState(page);
        expect(before).toEqual({ swipes: 1, swipeId: 0 });
        await focusChat(page);
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(1_500);
        expect(await readLastMessageSwipeState(page), 'disabled arrow key must not add a swipe').toEqual({ swipes: 1, swipeId: 0 });
        expect(await readSwipeCounter(page)).toBe('1/1');

        // The setting is saved, not just live in memory.
        await page.waitForTimeout(1_200);
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 2, { timeout: 15_000 });
        await waitForGenerationIdle(page);
        await openUserSettings(page);
        await expect(page.locator('#arrow-key-swipes')).not.toBeChecked();

        // Re-enable it and swipe through the real ArrowRight keydown.
        await page.locator('#arrow-key-swipes').check();
        await expect(page.locator('#arrow-key-swipes')).toBeChecked();
        await closeOpenDrawers(page);

        await waitForGenerationIdle(page);
        await focusChat(page);
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => readSwipeCounter(page), { timeout: 30_000 }).toBe('2/2');
        expect(await readLastMessageSwipeState(page)).toEqual({ swipes: 2, swipeId: 1 });
    });

    test('shows the swipe gestures switch on mobile and hides the keyboard switch', async ({ browser }) => {
        const context = await browser.newContext({
            userAgent: MOBILE_UA,
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        const mobilePage = await context.newPage();
        try {
            await awaitMainUI(mobilePage, server.baseURL);
            await openUserSettings(mobilePage);
            await expect(mobilePage.locator('#gestures-checkbox')).toBeVisible();
            await expect(mobilePage.locator('#arrow-key-swipes')).toBeHidden();
        } finally {
            await context.close();
        }
    });
});
