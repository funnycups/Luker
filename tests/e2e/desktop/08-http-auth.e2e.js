import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchLukerDesktop } from '../_lib/desktop.js';
import { cloneDataDir, SCRATCH_ROOT } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';

const USERNAME = 'e2e-user';
const PASSWORD = 'e2e-password';

// The shell runs the backend itself, so the credential gate is the backend's
// own basic auth. The test drives the real login window the shell opens in
// response to Electron's login event.

function prepareUserData() {
    const userData = resolve(SCRATCH_ROOT, `desktop-http-auth-${Date.now()}`);
    mkdirSync(userData, { recursive: true });
    cloneDataDir(resolve(userData, 'data'));
    writeFileSync(resolve(userData, 'config.yaml'), [
        'basicAuthMode: true',
        'basicAuthUser:',
        `  username: ${USERNAME}`,
        `  password: ${PASSWORD}`,
        // Basic auth middleware is only mounted when the server listens
        // beyond the loopback default.
        'listen: true',
        'listenAddress:',
        '  ipv4: 127.0.0.1',
        'protocol:',
        '  ipv4: true',
        '  ipv6: false',
        '',
    ].join('\n'));
    return userData;
}

async function waitForAuthDialog(electronApp, expectedPassword) {
    let found = null;
    await expect.poll(async () => {
        for (const window of electronApp.windows()) {
            if (window.isClosed() || !window.url().includes('http-auth.html')) {
                continue;
            }
            const value = await window.locator('#password').inputValue().catch(() => null);
            if (value === expectedPassword) {
                found = window;
                return true;
            }
        }
        return false;
    }, { timeout: 60_000 }).toBe(true);
    return found;
}

test('the shell prompts for HTTP Basic credentials and retries after a rejection', async () => {
    const desktop = await launchLukerDesktop({
        scenarioId: 'http-auth',
        userData: prepareUserData(),
        waitForSettle: false,
    });

    try {
        const firstDialog = await waitForAuthDialog(desktop.electronApp, '');
        await expect(firstDialog.locator('#username')).toBeVisible();
        await expect(firstDialog.locator('#endpoint')).toContainText(':');
        await firstDialog.locator('#username').fill(USERNAME);
        await firstDialog.locator('#password').fill('wrong-password');
        await firstDialog.locator('#login').click();

        const retryDialog = await waitForAuthDialog(desktop.electronApp, 'wrong-password');
        await expect(retryDialog.locator('#username')).toHaveValue(USERNAME);
        await retryDialog.locator('#password').fill(PASSWORD);
        await retryDialog.locator('#login').click();

        await expect.poll(() => desktop.page.url(), { timeout: 60_000 })
            .toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+\//);
        const baseURL = new URL(desktop.page.url()).origin;
        await awaitMainUI(desktop.page, baseURL);

        const stored = JSON.parse(readFileSync(resolve(desktop.userData, 'http-auth.json'), 'utf8'));
        expect(Object.values(stored)).toContainEqual({ username: USERNAME, password: PASSWORD });

        const dialogs = desktop.electronApp.windows()
            .filter((window) => !window.isClosed() && window.url().includes('http-auth.html'));
        expect(dialogs).toHaveLength(0);
    } finally {
        await desktop.close();
    }
});
