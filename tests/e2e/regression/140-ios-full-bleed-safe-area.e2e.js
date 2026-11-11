import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';

test.use({ browserName: 'webkit', viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'ios-full-bleed-safe-area' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => { await tearDownServer(server); });

async function openApp(page, { bridge = true } = {}) {
    // Desktop WebKit does not enable the iOS-only stylesheet or report device
    // insets. Enable the shipped iOS rules and let each test provide the inset
    // values through the same custom properties the stylesheet reads on device.
    await page.route('**/css/mobile-styles.css', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace(
            '@supports (-webkit-touch-callout: none)', '@supports (display: block)',
        ) });
    });
    if (bridge) {
        await page.addInitScript(() => {
            window.__lukerFullBleedCalls = [];
            window.__lukerSystemBarColors = [];
            window.LukerIOS = {
                setFullBleed(enabled) {
                    window.__lukerFullBleedCalls.push(Boolean(enabled));
                },
                setSystemBarsColor(color) {
                    window.__lukerSystemBarColors.push(String(color));
                },
            };
        });
    }
    await page.goto(server.baseURL);
    await page.waitForFunction(() => !document.getElementById('preloader') && !!window.Luker?.getContext);
}

async function applySimulatedInsets(page) {
    await page.evaluate(() => {
        const root = document.documentElement;
        root.style.setProperty('--luker-safe-top', '62px');
        root.style.setProperty('--luker-safe-bottom', '34px');
        root.style.setProperty('--luker-safe-left', '0px');
        root.style.setProperty('--luker-safe-right', '0px');
    });
}

test('the iOS shell opts into full-bleed layout and the page keeps the safe areas', async ({ page }) => {
    await openApp(page);
    await applySimulatedInsets(page);

    await expect(page.locator('html')).toHaveClass(/luker-ios-full-bleed/);
    expect(await page.evaluate(() => window.__lukerFullBleedCalls)).toEqual([true]);

    const systemBarColors = await page.evaluate(() => window.__lukerSystemBarColors);
    expect(systemBarColors.length).toBeGreaterThan(0);
    expect(systemBarColors[0]).toMatch(/^rgba?\(/);

    const holder = await page.locator('#top-settings-holder').boundingBox();
    expect(holder?.height ?? 0).toBeGreaterThan(62);

    const icon = await page.locator('#leftNavDrawerIcon').boundingBox();
    expect(icon?.y ?? 0).toBeGreaterThanOrEqual(62);

    const sheld = await page.locator('#sheld').boundingBox();
    expect(sheld?.y ?? 0).toBeCloseTo(holder?.height ?? 0, 0);

    const form = await page.locator('#form_sheld').boundingBox();
    expect((form?.y ?? 0) + (form?.height ?? 0)).toBeLessThanOrEqual(898);

    await page.locator('#leftNavDrawerIcon').click();
    await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);
    const panel = await page.locator('#left-nav-panel').boundingBox();
    expect(panel?.y ?? 0).toBeGreaterThanOrEqual(98);
});

test('without the native full-bleed bridge the page keeps the safe-area layout', async ({ page }) => {
    await openApp(page, { bridge: false });

    await expect(page.locator('html')).not.toHaveClass(/luker-ios-full-bleed/);

    const icon = await page.locator('#leftNavDrawerIcon').boundingBox();
    expect(icon?.y ?? 0).toBeLessThan(10);

    const holder = await page.locator('#top-settings-holder').boundingBox();
    const sheld = await page.locator('#sheld').boundingBox();
    expect(sheld?.y ?? 0).toBeCloseTo(holder?.height ?? 0, 0);
});
