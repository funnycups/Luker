// #103 — Preset regex import preview keys duplicates by plugin lane.
//
// The reimport popup compares the preset's stored source snapshot against
// the scripts already present in the preset. A request-only rule and a
// reply-only rule must not collapse into the same duplicate signature.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { ensureOaiDrawerOpen, selectPresetByName } from './_helpers.js';

const PRESET_NAME = 'LanePreview';

const REQUEST_SCRIPT = {
    id: 'lane-preview-request',
    scriptName: 'Request lane',
    findRegex: '/REQUESTLANE/g',
    replaceString: 'REQUESTCOOKED',
    trimStrings: [],
    placement: [1, 2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    pluginLanes: ['request'],
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
};

const REPLY_SCRIPT = {
    ...REQUEST_SCRIPT,
    id: 'lane-preview-reply',
    pluginLanes: ['reply'],
};

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: '103-regex-lane-preview',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const presetsDir = resolve(server.dataRoot, 'default-user', 'OpenAI Settings');
    if (!existsSync(presetsDir)) {
        mkdirSync(presetsDir, { recursive: true });
    }
    writeFileSync(resolve(presetsDir, `${PRESET_NAME}.json`), JSON.stringify({
        temperature: 0.7,
        chat_completion_source: 'openai',
        extensions: {
            regex_scripts: [REQUEST_SCRIPT],
            luker: {
                embedded_regex_scripts_source: [REQUEST_SCRIPT, REPLY_SCRIPT],
            },
        },
    }, null, 4));

    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.preset_allowed_regex = { openai: [PRESET_NAME] };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#103 — preset regex import preview', () => {
    test('marks only the matching lane as a duplicate', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await ensureOaiDrawerOpen(page);
        await selectPresetByName(page, PRESET_NAME);

        const reimport = page.locator('[data-preset-manager-reimport-regex="openai"]');
        await expect(reimport).toBeVisible();
        await reimport.click();

        const preview = page.locator('.regex-preset-embedded-preview');
        await expect(preview).toBeVisible({ timeout: 10_000 });

        const items = preview.locator('.regex-preset-embedded-preview__item');
        await expect(items).toHaveCount(2);
        await expect(items.nth(0).locator('.regex-preset-embedded-preview__badge--duplicate')).toHaveCount(1);
        await expect(items.nth(1).locator('.regex-preset-embedded-preview__badge--duplicate')).toHaveCount(0);
        await expect(items.nth(0)).toContainText('Plugin Requests');
        await expect(items.nth(1)).toContainText('Plugin Replies');

        await page.locator('.popup:visible .popup-button-cancel').last().click();
    });
});
