// Case #102 — Regex plugin lanes: request vs reply save shape.
//
// Contract:
//   - A rule with Plugin Requests ticked and no message type selected is
//     saved, warns, and stores `pluginLanes: ['request']` with an empty
//     placement list.
//   - A rule with Plugin Replies ticked and no message type selected is
//     saved without the request warning and stores `pluginLanes: ['reply']`.
//   - A legacy `pluginOnly` rule loads as both lanes and saves as
//     `pluginLanes: ['request', 'reply']`; the old field is dropped.
//
// Real-UI version: open the regex editor through the Extensions drawer,
// drive the real checkboxes, save through the popup, and read the stored
// settings.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

const REPLY = 'The lantern flame settles to a steady blue.';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [REPLY] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '102-regex-plugin-lanes' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.regex = [
        ...(settings.extension_settings.regex || []),
        {
            id: 'e2e-legacy-plugin-only',
            scriptName: 'e2e-legacy-plugin-only',
            findRegex: '/legacy/g',
            replaceString: 'legacy',
            placement: [1],
            disabled: false,
            pluginOnly: true,
            minDepth: null,
            maxDepth: null,
        },
    ];
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function openEditor(page) {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'regex_container');
}

async function openNewScript(page) {
    await page.locator('#open_regex_editor').click();
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    return popup;
}

async function clearPlacements(popup) {
    const allPlacements = popup.locator('input[name="replace_position"]');
    const count = await allPlacements.count();
    for (let i = 0; i < count; i++) {
        const cb = allPlacements.nth(i);
        if (await cb.isChecked()) await cb.uncheck();
    }
}

async function setChecked(popup, selector, want) {
    const cb = popup.locator(selector);
    await cb.waitFor({ state: 'visible', timeout: 5000 });
    const checked = await cb.isChecked();
    if (want && !checked) await cb.check();
    if (!want && checked) await cb.uncheck();
}

async function savePopup(popup) {
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

async function readSaved(page, scriptName) {
    return page.evaluate((name) => {
        const list = window.Luker.getContext().extensionSettings?.regex ?? [];
        const found = list.find(s => s && s.scriptName === name);
        return found ? {
            pluginLanes: Array.isArray(found.pluginLanes) ? found.pluginLanes : null,
            placement: Array.isArray(found.placement) ? found.placement : null,
            hasPluginOnly: Object.prototype.hasOwnProperty.call(found, 'pluginOnly'),
        } : null;
    }, scriptName);
}

test.describe('#102 — Regex plugin lanes in the editor', () => {
    test('request lane without placement saves and warns', async ({ page }) => {
        test.setTimeout(180_000);
        await openEditor(page);
        const popup = await openNewScript(page);

        await popup.locator('input.regex_script_name').fill('e2e-request-no-placement');
        await popup.locator('input.find_regex').fill('/requestonly/g');
        await popup.locator('textarea.regex_replace_string').fill('requestonly');
        await clearPlacements(popup);
        await setChecked(popup, 'input[name="only_format_display"]', false);
        await setChecked(popup, 'input[name="plugin_request"]', true);
        await savePopup(popup);

        await expect(
            page.locator('#toast-container .toast').filter({ hasText: 'plugin requests' }),
        ).toBeVisible({ timeout: 5000 });

        const saved = await readSaved(page, 'e2e-request-no-placement');
        expect(saved).toEqual({
            pluginLanes: ['request'],
            placement: [],
            hasPluginOnly: false,
        });
    });

    test('reply lane without placement saves', async ({ page }) => {
        test.setTimeout(180_000);
        await openEditor(page);
        const popup = await openNewScript(page);

        await popup.locator('input.regex_script_name').fill('e2e-reply-no-placement');
        await popup.locator('input.find_regex').fill('/replyonly/g');
        await popup.locator('textarea.regex_replace_string').fill('replyonly');
        await clearPlacements(popup);
        await setChecked(popup, 'input[name="only_format_display"]', false);
        await setChecked(popup, 'input[name="plugin_reply"]', true);
        await savePopup(popup);

        const saved = await readSaved(page, 'e2e-reply-no-placement');
        expect(saved).toEqual({
            pluginLanes: ['reply'],
            placement: [],
            hasPluginOnly: false,
        });
    });

    test('legacy pluginOnly loads as both lanes and saves as pluginLanes', async ({ page }) => {
        test.setTimeout(180_000);
        await openEditor(page);

        const globalBlock = page.locator('#global_scripts_block');
        const globalOpen = await globalBlock.evaluate(el => {
            const content = el.querySelector(':scope > .inline-drawer-content');
            return Boolean(content) && window.getComputedStyle(content).display !== 'none';
        });
        if (!globalOpen) {
            await globalBlock.locator(':scope > .inline-drawer-toggle').first().click();
        }
        await page.locator('#saved_regex_scripts .regex-script-label').first()
            .waitFor({ state: 'visible', timeout: 5000 });

        const legacyRow = page.locator('#saved_regex_scripts .regex-script-label')
            .filter({ hasText: 'e2e-legacy-plugin-only' });
        await legacyRow.waitFor({ state: 'visible', timeout: 5000 });
        await legacyRow.locator('.edit_existing_regex').click();

        const popup = page.locator('.popup:visible').last();
        await popup.waitFor({ state: 'visible', timeout: 5000 });
        await expect(popup.locator('input[name="plugin_request"]')).toBeChecked();
        await expect(popup.locator('input[name="plugin_reply"]')).toBeChecked();

        await savePopup(popup);

        const saved = await readSaved(page, 'e2e-legacy-plugin-only');
        expect(saved.pluginLanes).toEqual(['request', 'reply']);
        expect(saved.hasPluginOnly).toBe(false);
    });
});
