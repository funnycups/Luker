// Connection profile network proxy — real UI path.
//
// The profile is seeded without a proxy. The test fills the Advanced drawer's
// Network Proxy field, verifies the value reaches settings.json, sends a real
// chat turn, and proves the outbound request traversed the recording proxy
// before reaching the mock LLM. The value must survive a reload and clearing
// the field must remove the profile key (fall back to the global proxy).

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { startRecordingProxy } from '../_lib/recording-proxy.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    closeAnyOpenTopSettingsDrawer,
    openInlineDrawer,
    reloadAndAwait,
} from '../_lib/page.js';

let server, mock, proxy;
const PROFILE_NAME = 'e2e-network-proxy';
const REPLY = '*Ash checks the line, then nods.* "The proxy kept the lantern lit."';

async function openAdvancedProfileSettings(page) {
    const apiBlock = page.locator('#rm_api_block');
    const isApiOpen = await apiBlock.evaluate(el => el.classList.contains('openDrawer')).catch(() => false);
    if (!isApiOpen) {
        await page.locator('#API-status-top').click();
        await page.waitForFunction(() => document.getElementById('rm_api_block')?.classList.contains('openDrawer'), null, { timeout: 10_000 });
    }
    await openInlineDrawer(page, 'rm_api_block');
}

function readProfileFromDisk(dataRoot) {
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return (settings.extension_settings?.connectionManager?.profiles || []).find(profile => profile.name === PROFILE_NAME);
}

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [REPLY] });
    proxy = await startRecordingProxy();
    server = await startServer({ batchKey: 'server', scenarioId: 'profile-network-proxy' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, name: PROFILE_NAME });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await proxy?.stop();
    await mock?.stop();
});

test('Advanced Network Proxy persists on the profile and routes the chat request through it', async ({ page }) => {
    test.setTimeout(180_000);

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    await openAdvancedProfileSettings(page);
    const input = page.locator('#connection_profile_network_proxy');
    await input.waitFor({ state: 'attached', timeout: 10_000 });
    await page.locator('#connection_profile_network_proxy_block').scrollIntoViewIfNeeded();
    await expect(input).toHaveValue('');

    await input.fill(proxy.baseURL);
    await input.dispatchEvent('change');

    await expect.poll(() => readProfileFromDisk(server.dataRoot)?.['network-proxy'], { timeout: 10_000 }).toBe(proxy.baseURL);

    await closeAnyOpenTopSettingsDrawer(page);
    const proxyHitsBefore = proxy.requests.length;
    const { text } = await sendMessageAndAwaitReply(page, 'The tide turned; did the relay hold?');
    expect(text).toContain('proxy kept the lantern lit');
    await expect.poll(() => proxy.requests.length, { timeout: 10_000 }).toBeGreaterThan(proxyHitsBefore);

    const chatHits = proxy.requests.filter(request => request.url.includes('/v1/chat/completions'));
    expect(chatHits.length, `expected the chat completion to traverse the proxy; observed=${JSON.stringify(proxy.requests)}`).toBeGreaterThan(0);

    await server.restart();
    await reloadAndAwait(page, server.baseURL);
    await openAdvancedProfileSettings(page);
    await expect(page.locator('#connection_profile_network_proxy')).toHaveValue(proxy.baseURL);

    await page.locator('#connection_profile_network_proxy').fill('');
    await page.locator('#connection_profile_network_proxy').dispatchEvent('change');
    await expect.poll(() => {
        const profile = readProfileFromDisk(server.dataRoot);
        return profile ? Object.hasOwn(profile, 'network-proxy') : true;
    }, { timeout: 10_000 }).toBe(false);
});
