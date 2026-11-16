// Connection profile network proxy — Request Inspector row.
//
// The profile proxy is already proven to route traffic. This test proves the
// inspector explains that route: a real chat turn under a profile proxy, then
// the detail view reports which proxy carried it, with credentials stripped.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { startRecordingProxy } from '../_lib/recording-proxy.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock, proxy;
const PROFILE_NAME = 'e2e-inspector-proxy';
const REPLY = '*Ash taps the lantern frame.* "The relay held, and the log shows the route."';
const PROXY_USER = 'relay-user';
const PROXY_SECRET = 'relay-secret';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [REPLY] });
    proxy = await startRecordingProxy();
    server = await startServer({ batchKey: 'regression', scenarioId: 'inspector-network-proxy' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({
        dataRoot: server.dataRoot,
        baseURL: mock.baseURL,
        name: PROFILE_NAME,
        api: 'custom',
        profileOverrides: {
            'network-proxy': proxy.baseURL.replace('http://', `http://${PROXY_USER}:${PROXY_SECRET}@`),
        },
    });

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
    await proxy?.stop();
    await mock?.stop();
});

test('inspector reports the profile network proxy without credentials', async ({ page }) => {
    test.setTimeout(180_000);
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    const proxyHitsBefore = proxy.requests.length;
    await sendMessageAndAwaitReply(page, 'Log which relay carried this tide report.');
    expect(proxy.requests.length, 'the chat turn must go through the profile proxy').toBeGreaterThan(proxyHitsBefore);

    await page.locator('#user-settings-button .drawer-toggle').click();
    await page.waitForFunction(() => {
        const el = document.getElementById('user-settings-block');
        return el && !el.classList.contains('closedDrawer');
    }, { timeout: 5000 });
    await page.locator('#request_inspector_button').click();
    const chatRow = page.locator('.ri-row').first();
    await chatRow.waitFor({ state: 'visible', timeout: 10_000 });
    await chatRow.click();

    const proxyRow = page.locator('.ri-kv tr', { hasText: 'Network Proxy' }).first();
    await proxyRow.waitFor({ state: 'visible', timeout: 10_000 });
    const displayed = (await proxyRow.locator('td').nth(1).innerText()).trim();

    expect(displayed).toBe(`Profile proxy \u00B7 ${proxy.baseURL}`);
    expect(displayed).not.toContain(PROXY_SECRET);
    expect(displayed).not.toContain(PROXY_USER);
});
