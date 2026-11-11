import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openUserSettingsDrawer } from '../_lib/page.js';

test.use({ browserName: 'webkit', viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'ios-external-link-policy' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => { await tearDownServer(server); });

test('the iOS shell receives the external link policy from the user setting', async ({ page }) => {
    await page.addInitScript(() => {
        window.__lukerExternalLinkPolicy = [];
        window.LukerIOS = {
            setFullBleed() {},
            setSystemBarsColor() {},
            setOpenExternalLinksInBrowser(enabled) {
                window.__lukerExternalLinkPolicy.push(enabled === true);
            },
        };
    });
    await awaitMainUI(page, server.baseURL);
    await openUserSettingsDrawer(page);

    const checkbox = page.locator('#luker_open_external_links_in_browser');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toBeChecked();
    expect(await page.evaluate(() => window.__lukerExternalLinkPolicy[0])).toBe(true);

    await checkbox.uncheck();
    await expect.poll(() => page.evaluate(() => window.__lukerExternalLinkPolicy.at(-1))).toBe(false);
    expect(await page.evaluate(
        () => window.Luker.getContext().powerUserSettings.luker_open_external_links_in_browser,
    )).toBe(false);

    await checkbox.check();
    await expect.poll(() => page.evaluate(() => window.__lukerExternalLinkPolicy.at(-1))).toBe(true);
});
