import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'resource-settings',
        extraConfig: { 'storage.mode': 'fs' },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test('revalidates unchanged settings fields after a real toggle', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    const network = [];
    const requestHeaders = new Map();
    cdp.on('Network.requestWillBeSentExtraInfo', event => {
        requestHeaders.set(event.requestId, event.headers);
    });
    cdp.on('Network.responseReceived', event => {
        network.push({
            url: event.response.url,
            requestId: event.requestId,
            status: event.response.status,
            fromDiskCache: event.response.fromDiskCache,
        });
    });

    await awaitMainUI(page, server.baseURL);
    await page.locator('dialog.popup[open] .popup-button-ok').first().click({ timeout: 2000 }).catch(() => {});

    const drawer = page.locator('#advanced-formatting-button');
    if (await drawer.locator('.drawer-icon.closedIcon').count()) {
        await drawer.locator('.drawer-toggle').click();
    }
    const toggle = page.locator('#trim_spaces');
    await toggle.scrollIntoViewIfNeeded();

    const initiallyChecked = await toggle.isChecked();
    const saveResponse = page.waitForResponse(response =>
        response.url().includes('/api/settings/') && response.request().method() === 'POST');
    await toggle.setChecked(!initiallyChecked);
    expect((await saveResponse).ok()).toBe(true);

    const reloadMarker = network.length;
    await reloadAndAwait(page, server.baseURL);

    await expect(toggle).toBeChecked({ checked: !initiallyChecked });
    const reloadNetwork = network.slice(reloadMarker);
    expect(reloadNetwork.some(entry => entry.url.includes('/api/settings/fields?'))).toBe(true);
    const reloadFields = reloadNetwork.filter(entry => entry.url.includes('/api/settings/field?'));
    expect(reloadFields.length).toBeGreaterThan(0);
    expect(reloadFields.some(entry => {
        const headers = requestHeaders.get(entry.requestId) || {};
        return entry.fromDiskCache || Boolean(headers['If-None-Match']);
    })).toBe(true);
    expect(reloadNetwork.some(entry => entry.url.endsWith('/api/settings/get'))).toBe(false);
});
