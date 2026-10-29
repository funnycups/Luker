import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { loginAs } from '../_lib/sync.js';

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'resource-cache-account',
        extraConfig: { enableUserAccounts: true },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test('resource metadata keeps account identity across session renewal and logout', async ({ page }) => {
    await loginAs(page, server.baseURL, { handle: 'default-user', password: '' });

    await page.locator('dialog.popup[open] .popup-button-ok').first().click({ timeout: 2000 }).catch(() => {});

    const readAccount = () => page.evaluate(async () => {
        const response = await fetch('/api/bootstrap/metadata');
        const payload = await response.json();
        return { status: response.status, account: payload.account };
    });

    expect(await readAccount()).toEqual({ status: 200, account: 'default-user' });

    const renewed = await page.evaluate(async () => {
        const tokenResponse = await fetch('/csrf-token');
        const { token } = await tokenResponse.json();
        return fetch('/api/ping?extend=1', {
            method: 'POST',
            headers: { 'X-CSRF-Token': token },
        }).then(response => response.status);
    });
    expect(renewed).toBe(204);
    expect(await readAccount()).toEqual({ status: 200, account: 'default-user' });

    await page.locator('#user-settings-button .drawer-toggle').click();
    await page.locator('#logout_button').click();
    await page.waitForURL(/\/login/);

    const afterLogout = await page.request.get(`${server.baseURL}/api/bootstrap/metadata`, {
        maxRedirects: 0,
    });
    expect(afterLogout.status()).toBe(403);
});
