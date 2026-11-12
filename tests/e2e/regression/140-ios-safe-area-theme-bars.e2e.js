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
    await page.route('**/css/mobile-styles.css', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace(
            '@supports (-webkit-touch-callout: none)', '@supports (display: block)',
        ) });
    });
    if (bridge) {
        await page.addInitScript(() => {
            window.__lukerSystemBarCalls = [];
            window.LukerIOS = {
                setSystemBarsColor(topColor, bottomColor) {
                    window.__lukerSystemBarCalls.push({
                        top: String(topColor),
                        bottom: bottomColor == null ? String(topColor) : String(bottomColor),
                    });
                },
            };
        });
    }
    await page.goto(server.baseURL);
    await page.waitForFunction(() => !document.getElementById('preloader') && !!window.Luker?.getContext);
}

test('the iOS shell syncs top and bottom bar colors and keeps layout inside the safe area', async ({ page }) => {
    await openApp(page);

    await expect(page.locator('html')).toHaveClass(/luker-ios-app/);
    await expect(page.locator('html')).not.toHaveClass(/luker-ios-full-bleed/);

    await expect.poll(() => page.evaluate(() => window.__lukerSystemBarCalls.length)).toBeGreaterThan(0);
    const initialCall = await page.evaluate(() => window.__lukerSystemBarCalls.at(-1));
    expect(initialCall.top).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(initialCall.bottom).toMatch(/^rgb\(\d+, \d+, \d+\)$/);

    const holder = await page.locator('#top-settings-holder').boundingBox();
    expect(holder?.y ?? -1).toBe(0);
    expect(holder?.height ?? 0).toBeGreaterThan(30);
    expect(holder?.height ?? 0).toBeLessThan(45);

    const sheld = await page.locator('#sheld').boundingBox();
    expect(sheld?.y ?? 0).toBeCloseTo(holder?.height ?? 0, 0);
    expect(Math.round((sheld?.y ?? 0) + (sheld?.height ?? 0))).toBe(932);

    const sendFormStyle = await page.locator('#send_form').evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
            bottom: Math.round(el.getBoundingClientRect().bottom),
            borderBottomWidth: cs.borderBottomWidth,
            borderBottomLeftRadius: cs.borderBottomLeftRadius,
            borderBottomRightRadius: cs.borderBottomRightRadius,
        };
    });
    expect(sendFormStyle.bottom).toBe(932);
    expect(sendFormStyle.borderBottomWidth).toBe('0px');
    expect(sendFormStyle.borderBottomLeftRadius).toBe('0px');
    expect(sendFormStyle.borderBottomRightRadius).toBe('0px');

    // Opening User Settings -> Custom CSS updates top and bottom bar colors
    // independently and preserves safe-area geometry even when CSS uses !important.
    await page.locator('#user-settings-button').click();
    await expect(page.locator('#user-settings-block')).toHaveClass(/openDrawer/);

    const customCss = [
        ':root { --topBarBlockSize: 30px !important; }',
        '#top-bar { display: none !important; height: 0 !important; }',
        '#top-settings-holder { position: fixed !important; top: 0 !important; height: 30px !important; min-height: 30px !important; max-height: 30px !important; background-color: rgb(239, 236, 230) !important; }',
        '#sheld { position: fixed !important; top: 30px !important; height: calc(100dvh - 30px) !important; max-height: calc(100dvh - 30px) !important; }',
        '#send_form { background-color: rgb(30, 41, 59) !important; }',
        '#left-nav-panel, #user-settings-block { position: fixed !important; top: 30px !important; max-height: calc(100dvh - 30px) !important; }',
    ].join('\n');

    await page.locator('#customCSS').fill(customCss);
    await expect.poll(() => page.evaluate(() => window.__lukerSystemBarCalls.at(-1)))
        .toEqual({ top: 'rgb(239, 236, 230)', bottom: 'rgb(30, 41, 59)' });

    const themedHolder = await page.locator('#top-settings-holder').boundingBox();
    expect(Math.round(themedHolder?.y ?? -1)).toBe(0);
    expect(Math.round(themedHolder?.height ?? 0)).toBe(30);

    const themedSheld = await page.locator('#sheld').boundingBox();
    expect(Math.round(themedSheld?.y ?? -1)).toBe(30);
    expect(Math.round((themedSheld?.y ?? 0) + (themedSheld?.height ?? 0))).toBe(932);

    // Translucent bar colors composite against the underlying opaque body color.
    await page.locator('#customCSS').fill([
        'html, body { background-color: rgb(20, 20, 25) !important; }',
        '#top-bar { display: none !important; }',
        '#top-settings-holder { background-color: rgba(255, 255, 255, 0.15) !important; }',
        '#send_form { background-color: rgba(255, 255, 255, 0.2) !important; }',
    ].join('\n'));
    await expect.poll(() => page.evaluate(() => window.__lukerSystemBarCalls.at(-1)))
        .toEqual({ top: 'rgb(55, 55, 60)', bottom: 'rgb(67, 67, 71)' });

    // Close settings drawer, open left nav drawer, and verify its bounds stay in-viewport.
    await page.locator('#leftNavDrawerIcon').click();
    await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);
    const panel = await page.locator('#left-nav-panel').boundingBox();
    expect(panel?.y ?? -1).toBeGreaterThanOrEqual(30);
    expect((panel?.y ?? 0) + (panel?.height ?? 0)).toBeLessThanOrEqual(932);
});

test('without the native bridge the page keeps standard layout and skips iOS bar styling', async ({ page }) => {
    await openApp(page, { bridge: false });

    await expect(page.locator('html')).not.toHaveClass(/luker-ios-app/);
    await expect(page.locator('html')).not.toHaveClass(/luker-ios-full-bleed/);

    const borderBottom = await page.locator('#send_form').evaluate((el) => getComputedStyle(el).borderBottomWidth);
    expect(borderBottom).toBe('1px');
});
