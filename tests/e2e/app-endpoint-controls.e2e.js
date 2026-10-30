// The native app shells expose refresh and endpoint entries inside the User
// Settings drawer. The web side only reveals them when a shell bridge exists,
// and desktop shells get refresh alone. Each case injects a bridge shape
// before the page boots, opens the real drawer, and clicks the real buttons.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from './_lib/server.js';
import { markOnboarded } from './_lib/fixtures.js';
import { awaitMainUI } from './_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'chat', scenarioId: 'drawer' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

/** Open the User Settings drawer through its real toggle. */
async function openUserSettingsDrawer(page) {
    await page.locator('#user-settings-button').waitFor({ state: 'visible', timeout: 10_000 });
    const closed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count();
    if (closed > 0) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const el = document.getElementById('user-settings-block');
            return el && !el.classList.contains('closedDrawer');
        }, undefined, { timeout: 5_000 });
    }
}

test('android bridge reveals both entries and forwards clicks', async ({ page }) => {
    await page.addInitScript(() => {
        window.__lukerBridgeCalls = [];
        window.LukerAndroid = {
            reloadWebView() { window.__lukerBridgeCalls.push('reload'); },
            openEndpointSettings() { window.__lukerBridgeCalls.push('endpoint'); },
        };
    });
    await awaitMainUI(page, server.baseURL);
    await openUserSettingsDrawer(page);

    const reloadButton = page.locator('#app_reload_button');
    const endpointButton = page.locator('#app_endpoint_button');
    await expect(reloadButton).toBeVisible();
    await expect(endpointButton).toBeVisible();

    await reloadButton.click();
    await endpointButton.click();

    expect(await page.evaluate(() => window.__lukerBridgeCalls)).toEqual(['reload', 'endpoint']);
});

test('desktop bridge reveals refresh only', async ({ page }) => {
    await page.addInitScript(() => {
        window.__lukerBridgeCalls = [];
        window.LukerDesktop = {
            reloadWebView() { window.__lukerBridgeCalls.push('reload'); },
        };
    });
    await awaitMainUI(page, server.baseURL);
    await openUserSettingsDrawer(page);

    const reloadButton = page.locator('#app_reload_button');
    const endpointButton = page.locator('#app_endpoint_button');
    await expect(reloadButton).toBeVisible();
    await expect(endpointButton).toHaveCount(1);
    await expect(endpointButton).toBeHidden();

    await reloadButton.click();

    expect(await page.evaluate(() => window.__lukerBridgeCalls)).toEqual(['reload']);
});

test('plain browser keeps both entries hidden', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openUserSettingsDrawer(page);

    const reloadButton = page.locator('#app_reload_button');
    const endpointButton = page.locator('#app_endpoint_button');
    await expect(reloadButton).toHaveCount(1);
    await expect(reloadButton).toBeHidden();
    await expect(endpointButton).toHaveCount(1);
    await expect(endpointButton).toBeHidden();
});
