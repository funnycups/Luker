// Case #101 — Regex scope: "Alter Chat Display" and the plugin application
// points are independent switches and may be ticked together on one script.
//
// Regression: the editor used to disable and clear "Alter Chat Display" while
// the plugin scope was ticked, so an existing rule that cleaned the chat
// display could not be reused for plugin traffic.
//
// Real-UI version:
//   - Open Extensions → Regex → "+ Global".
//   - Tick "Plugin Requests" and "Plugin Replies" through real clicks and
//     assert "Alter Chat Display" stays enabled and checked.
//   - Tick "Alter Outgoing Prompt" too, fill the script, save via the popup.
//   - Assert the stored script carries `pluginLanes` and no `pluginOnly`.
//   - Send a real turn; assert the rendered bubble carries the substitution
//     (the display lane is live for a rule that also carries plugin lanes).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

const REPLY = 'The lantern flame settles to a steady blue.';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [REPLY] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '101-regex-display-plugin' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#101 — Regex display and plugin scope coexist', () => {
    test('ticking Plugin Messages keeps Alter Chat Display enabled, and both persist', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'regex_container');

        await page.locator('#open_regex_editor').click();
        const popup = page.locator('.popup:visible').last();
        await popup.waitFor({ state: 'visible', timeout: 5000 });

        await popup.locator('input.regex_script_name').fill('e2e-display-and-plugin');
        await popup.locator('input.find_regex').fill('/lantern/g');
        await popup.locator('textarea.regex_replace_string').fill('LANTERN');

        const allPlacements = popup.locator('input[name="replace_position"]');
        const count = await allPlacements.count();
        for (let i = 0; i < count; i++) {
            const cb = allPlacements.nth(i);
            if (await cb.isChecked()) await cb.uncheck();
        }
        await popup.locator('input[name="replace_position"][value="2"]').check(); // AI_OUTPUT

        const display = popup.locator('input[name="only_format_display"]');
        const prompt = popup.locator('input[name="only_format_prompt"]');
        const request = popup.locator('input[name="plugin_request"]');
        const reply = popup.locator('input[name="plugin_reply"]');

        // The editor seeds "Alter Chat Display" for a new script.
        await expect(display).toBeChecked();

        // Real clicks on the plugin lanes. They must not disable or clear
        // the display box.
        await expect(request).toBeVisible({ timeout: 5000 });
        await expect(reply).toBeVisible({ timeout: 5000 });
        await request.check();
        await reply.check();
        await expect(display, 'Alter Chat Display must stay enabled while plugin lanes are ticked').toBeEnabled();
        await expect(display, 'Alter Chat Display must stay checked while plugin lanes are ticked').toBeChecked();

        // The original user scenario: the rule also cleaned the outgoing prompt.
        await prompt.check();

        await popup.locator('.popup-button-ok').first().click();
        await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

        const saved = await page.evaluate(() => {
            const list = window.Luker.getContext().extensionSettings?.regex ?? [];
            const found = list.find(s => s && s.scriptName === 'e2e-display-and-plugin');
            return found ? {
                markdownOnly: Boolean(found.markdownOnly),
                promptOnly: Boolean(found.promptOnly),
                pluginLanes: Array.isArray(found.pluginLanes) ? found.pluginLanes : null,
                hasPluginOnly: Object.prototype.hasOwnProperty.call(found, 'pluginOnly'),
            } : null;
        });
        expect(saved, 'script should be persisted after save').toBeTruthy();
        expect(saved.markdownOnly).toBe(true);
        expect(saved.promptOnly).toBe(true);
        expect(saved.pluginLanes).toEqual(['request', 'reply']);
        expect(saved.hasPluginOnly).toBe(false);

        // Display lane is live: the rendered bubble carries the substitution.
        const { text } = await sendMessageAndAwaitReply(page, 'I trimmed the wick.');
        expect(text).toMatch(/LANTERN/);
    });
});
