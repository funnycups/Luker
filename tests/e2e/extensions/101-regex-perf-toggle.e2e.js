// Case #101 — Regex performance-detection toggle.
//
// Real-UI version:
//   - Open Extensions → Regex. Performance detection is on by default.
//   - Turn it off through the checkbox.
//   - Create a script whose pattern backtracks catastrophically against the
//     mock reply text.
//   - Send a real user turn. The script runs but must not raise the slow-script
//     warning while detection is off.
//   - Turn detection back on and send another turn. The same script must now
//     surface the warning, proving the toggle gates detection without a reload.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openExtensionsDrawer,
} from '../_lib/page.js';

const SLOW_REPLY = 'a'.repeat(28);

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [SLOW_REPLY, SLOW_REPLY, SLOW_REPLY, SLOW_REPLY] });
    // Memory-graph extraction also consumes mock replies. Route the two chat
    // turns explicitly so the main reply is always the catastrophic pattern.
    mock.scriptCompletion(({ userMessages }) => {
        const lastUser = userMessages[userMessages.length - 1] || '';
        if (lastUser.includes('first trigger') || lastUser.includes('second trigger')) {
            return { text: SLOW_REPLY };
        }
        return null;
    });
    server = await startServer({ batchKey: 'extensions', scenarioId: '101-regex-perf-toggle' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function openRegexDrawer(page) {
    const regexDrawer = page.locator('#regex_container .inline-drawer').first();
    const regexContent = regexDrawer.locator('> .inline-drawer-content');
    const hidden = await regexContent.evaluate(el => {
        if (!el) return true;
        return window.getComputedStyle(el).display === 'none';
    }).catch(() => true);
    if (hidden) {
        await regexDrawer.locator('> .inline-drawer-toggle').first().click();
        await regexContent.waitFor({ state: 'visible', timeout: 5000 });
    }
}

async function createGlobalRegexScript(page, { name, findRegex, replaceString, placements }) {
    await page.locator('#open_regex_editor').click();
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });

    await popup.locator('input.regex_script_name').fill(name);
    await popup.locator('input.find_regex').fill(findRegex);
    await popup.locator('textarea.regex_replace_string').fill(replaceString);

    const allPlacements = popup.locator('input[name="replace_position"]');
    const count = await allPlacements.count();
    for (let i = 0; i < count; i++) {
        const cb = allPlacements.nth(i);
        if (await cb.isChecked()) await cb.uncheck();
    }
    for (const value of placements) {
        await popup.locator(`input[name="replace_position"][value="${value}"]`).check();
    }

    const setBox = async (selector, want) => {
        const cb = popup.locator(selector);
        const checked = await cb.isChecked();
        if (want && !checked) await cb.check();
        else if (!want && checked) await cb.uncheck();
    };
    await setBox('input[name="only_format_display"]', false);
    await setBox('input[name="only_format_prompt"]', false);
    await setBox('input[name="plugin_request"]', false);
    await setBox('input[name="plugin_reply"]', false);
    await setBox('input[name="run_on_edit"]', false);

    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

test.describe('#101 — Regex performance-detection toggle', () => {
    test('turning detection off suppresses the slow-script warning until turned back on', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await openExtensionsDrawer(page);
        await openRegexDrawer(page);

        const detectionToggle = page.locator('#regex_perf_detection_toggle');
        await detectionToggle.waitFor({ state: 'visible', timeout: 5000 });
        await expect(detectionToggle, 'performance detection should be on by default').toBeChecked();

        await page.locator('#regex_perf_detection_help').click();
        const helpPopup = page.locator('.popup:visible', { hasText: 'Every regex script run is timed.' }).last();
        await helpPopup.waitFor({ state: 'visible', timeout: 5000 });
        await expect(helpPopup).toContainText('500 ms');
        await helpPopup.locator('.popup-button-ok').first().click();
        await helpPopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

        await detectionToggle.uncheck();
        await page.waitForFunction(() => window.Luker.getContext().extensionSettings?.regex_perf_detection === false, { timeout: 10_000 });

        await createGlobalRegexScript(page, {
            name: 'e2e-perf-toggle',
            findRegex: '/(a+)+b/g',
            replaceString: 'X',
            placements: [2], // AI_OUTPUT
        });

        // Detection is off: the slow script runs, but no warning may appear.
        await sendMessageAndAwaitReply(page, 'first trigger');
        const popupWhileOff = await page
            .locator('.popup:visible', { hasText: 'Regex script is slow' })
            .waitFor({ state: 'visible', timeout: 5000 })
            .then(() => true)
            .catch(() => false);
        expect(popupWhileOff, 'slow-script popup must stay hidden while detection is off').toBe(false);

        // Turn detection back on through the real checkbox.
        await openExtensionsDrawer(page);
        await openRegexDrawer(page);
        await page.locator('#regex_perf_detection_toggle').check();
        await page.waitForFunction(() => window.Luker.getContext().extensionSettings?.regex_perf_detection === true, { timeout: 10_000 });

        // The next slow execution must surface the warning again.
        await sendMessageAndAwaitReply(page, 'second trigger');
        const popup = page.locator('.popup:visible', { hasText: 'Regex script is slow' }).last();
        await popup.waitFor({ state: 'visible', timeout: 60_000 });
        await popup.locator('.popup-button-ok').first().click();
        await popup.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    });
});
