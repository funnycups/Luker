import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { loginAs } from '../_lib/sync.js';
import { awaitMainUI, openUserSettingsDrawer } from '../_lib/page.js';

let fileScope;

test.beforeAll(async ({ workerResources }, testInfo) => {
    fileScope = await workerResources.scenario(testInfo.file);
});

let server;

test.beforeAll(async () => {
    server = await startServer({ scope: fileScope,
        batchKey: 'server',
        scenarioId: 'resource-cache-account',
        extraConfig: { enableUserAccounts: true },
    });
});

test.afterAll(async () => {
});

test('resource metadata keeps account identity across reload and a new login', async ({ page }) => {
    const metadata = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap/metadata');
    const initial = metadata();
    await loginAs(page, server.baseURL, { handle: 'default-user', password: '' });
    expect((await initial).status()).toBe(200);
    expect((await (await initial).json()).account).toBe('default-user');
    const reloaded = metadata();
    await awaitMainUI(page, server.baseURL);
    expect((await reloaded).status()).toBe(200);
    expect((await (await reloaded).json()).account).toBe('default-user');

    await openUserSettingsDrawer(page);
    await page.locator('#logout_button').click();
    await page.waitForURL(/\/login/);

    const afterLogout = await page.request.get(`${server.baseURL}/api/bootstrap/metadata`, {
        maxRedirects: 0,
    });
    expect(afterLogout.status()).toBe(403);

    const renewed = metadata();
    await loginAs(page, server.baseURL, { handle: 'default-user', password: '' });
    expect((await renewed).status()).toBe(200);
    expect((await (await renewed).json()).account).toBe('default-user');
});
