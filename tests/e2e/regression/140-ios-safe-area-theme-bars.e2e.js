import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';

test.use({ browserName: 'webkit', viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'ios-safe-area-theme-bars' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => { await tearDownServer(server); });

async function openApp(page, { bridge = true } = {}) {
    // Desktop WebKit cannot enable the iOS-only stylesheet. Enable the shipped
    // iOS rules with the same custom-property values the device reports; the
    // native safe area stays outside the page, so the page must not compensate.
    await page.route('**/css/mobile-styles.css', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace(
            '@supports (-webkit-touch-callout: none)', '@supports (display: block)',
        ) });
    });
    if (bridge) {
        await page.addInitScript(() => {
            window.__lukerSystemBarColors = [];
            window.LukerIOS = {
                setSystemBarsColor(color) {
                    window.__lukerSystemBarColors.push(String(color));
                },
            };
        });
    }
    await page.goto(server.baseURL);
    await page.waitForFunction(() => !document.getElementById('preloader') && !!window.Luker?.getContext);
}

test('the iOS shell themes the system bars and keeps the page inside the safe area', async ({ page }) => {
    await openApp(page);

    const colors = await page.evaluate(() => window.__lukerSystemBarColors);
    expect(colors.length).toBeGreaterThan(0);
    expect(colors[0]).toMatch(/^rgba?\(/);

    // The page never claims the status bar or the home indicator: the native
    // shell owns those strips, so full-screen extensions keep their top
    // controls reachable below the Dynamic Island.
    await expect(page.locator('html')).not.toHaveClass(/luker-ios-full-bleed/);

    const holder = await page.locator('#top-settings-holder').boundingBox();
    expect(holder?.height ?? 0).toBeGreaterThan(30);
    expect(holder?.height ?? 0).toBeLessThan(45);

    const icon = await page.locator('#leftNavDrawerIcon').boundingBox();
    expect(icon?.y ?? 0).toBeLessThan(10);

    const sheld = await page.locator('#sheld').boundingBox();
    expect(sheld?.y ?? 0).toBeCloseTo(holder?.height ?? 0, 0);

    await page.locator('#leftNavDrawerIcon').click();
    await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);
    const panel = await page.locator('#left-nav-panel').boundingBox();
    expect(panel?.y ?? 0).toBeGreaterThanOrEqual(35);
    expect(panel?.y ?? 0).toBeLessThan(60);
});

test('without the native bridge the page keeps the safe-area layout and skips the color call', async ({ page }) => {
    await openApp(page, { bridge: false });

    await expect(page.locator('html')).not.toHaveClass(/luker-ios-full-bleed/);

    const icon = await page.locator('#leftNavDrawerIcon').boundingBox();
    expect(icon?.y ?? 0).toBeLessThan(10);

    const holder = await page.locator('#top-settings-holder').boundingBox();
    const sheld = await page.locator('#sheld').boundingBox();
    expect(sheld?.y ?? 0).toBeCloseTo(holder?.height ?? 0, 0);
});
