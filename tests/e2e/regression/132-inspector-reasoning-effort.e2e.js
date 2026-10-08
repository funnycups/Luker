// Regression — Request Inspector must surface the reasoning effort that
// actually went on the wire.
//
// Bug shape: the inspector captured the outbound wire body (including the
// provider-native reasoning-effort field) but the chat detail never rendered
// it, so "what effort did we actually send upstream?" was only answerable by
// digging through the raw Other Params JSON.
//
// REAL USER FLOW: boot the server + mock LLM, set the CUSTOM source's
// reasoning effort through the real settings drawer, drive a real chat turn
// through #send_textarea / #send_but, then open the inspector via
// #request_inspector_button and click the chat row. Assert the displayed
// value equals the value the mock upstream actually received.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

const EFFORT = 'high';
const REPLY = '*Ash lowers the spyglass and marks the chart.* "The reef holds. We keep the lantern lit."';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [REPLY] });
    server = await startServer({ batchKey: 'regression', scenarioId: '132-inspector-reasoning-effort' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    // Keep the memory-graph extractor from firing its own LLM calls so the
    // inspector list holds exactly the chat turn driven here.
    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.memory_graph = {
        ...(settings.extension_settings.memory_graph || {}),
        enabled: false,
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('inspector shows the outbound reasoning effort for a real chat request', async ({ page }) => {
    test.setTimeout(180_000);
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');

    // Let the first_mes greeting settle so the reply we await is the user turn.
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    // Set the reasoning effort for the CUSTOM source through the real
    // settings drawer. bootstrapCustomBackend already made CUSTOM the active
    // source, so the dropdown is populated for it.
    await page.locator('#leftNavDrawerIcon').click();
    await expect(page.locator('#openai_reasoning_effort')).toBeVisible();
    await page.locator('#openai_reasoning_effort').selectOption(EFFORT);
    await expect(page.locator('#openai_reasoning_effort')).toHaveValue(EFFORT);

    // Real generation through the chat composer.
    const before = mock.requests.length;
    await sendMessageAndAwaitReply(page, 'Log tonight\'s tide reading before the lantern gutters.');

    // The mock upstream must have received the effort we selected through the
    // settings UI. This ties the displayed value to the real outbound payload.
    const chatCall = mock.requests.slice(before).find(r => (r.url || '').includes('/chat/completions'));
    expect(chatCall, 'mock upstream must have received the chat request').toBeTruthy();
    const wireEffort = chatCall.body?.reasoning_effort;
    expect(wireEffort).toBe(EFFORT);

    // Open the inspector through real DOM clicks. The button lives in the
    // user-settings drawer (under #account_controls), so open that first.
    await page.locator('#user-settings-button .drawer-toggle').click();
    await page.waitForFunction(() => {
        const el = document.getElementById('user-settings-block');
        return el && !el.classList.contains('closedDrawer');
    }, { timeout: 5000 });
    await page.locator('#request_inspector_button').click();
    const chatRow = page.locator('.ri-row').first();
    await chatRow.waitFor({ state: 'visible', timeout: 10_000 });
    await chatRow.click();

    const effortRow = page.locator('.ri-kv tr', { hasText: 'Reasoning Effort' }).first();
    await effortRow.waitFor({ state: 'visible', timeout: 10_000 });
    const displayed = (await effortRow.locator('td').nth(1).innerText()).trim();
    expect(displayed).toBe(wireEffort);
});
