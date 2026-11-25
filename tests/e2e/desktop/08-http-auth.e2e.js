import { test, expect } from '../../harness/playwright.js';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchLukerDesktop } from '../_lib/desktop.js';
import { materializeSeed } from '../../harness/seed.js';
import { awaitMainUI } from '../_lib/page.js';

const USERNAME = 'e2e-user';
const PASSWORD = 'e2e-password';

async function prepareUserData(scope) {
    const directory = await scope.directory('desktop http-auth');
    const userData = directory.path;
    const seeded = await materializeSeed(scope, { settingsOverrides: { firstRun: false, power_user: { auto_connect: false } } });
    renameSync(seeded.dataRoot, resolve(userData, 'data'));
    writeFileSync(resolve(userData, 'config.yaml'), [
        'basicAuthMode: true',
        'basicAuthUser:',
        `  username: ${USERNAME}`,
        `  password: ${PASSWORD}`,
        'listen: true',
        'listenAddress:',
        '  ipv4: 127.0.0.1',
        'protocol:',
        '  ipv4: true',
        '  ipv6: false',
        '',
    ].join('\n'));
    return directory;
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

test('the shell prompts for HTTP Basic credentials and retries after a rejection', async ({ resources }) => {
    const userData = await prepareUserData(resources);
    const desktop = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'http-auth',
        userData,
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
