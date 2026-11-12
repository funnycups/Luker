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

test('full-bleed iOS layout extends edge to edge while keeping bars, windows, and fullscreen plugins inside the safe area', async ({ page }) => {
    await openApp(page);
    await applySimulatedInsets(page);

    await expect(page.locator('html')).toHaveClass(/luker-ios-full-bleed/);
    expect(await page.evaluate(() => window.__lukerFullBleedCalls)).toEqual([true]);

    const systemBarColors = await page.evaluate(() => window.__lukerSystemBarColors);
    expect(systemBarColors.length).toBeGreaterThan(0);
    expect(systemBarColors[0]).toMatch(/^rgba?\(/);

    const topBar = await page.locator('#top-bar').boundingBox();
    expect(Math.round(topBar?.y ?? -1)).toBe(0);
    expect(topBar?.height ?? 0).toBeGreaterThan(62);

    const holder = await page.locator('#top-settings-holder').boundingBox();
    expect(holder?.height ?? 0).toBeGreaterThan(62);

    const icon = await page.locator('#leftNavDrawerIcon').boundingBox();
    expect(icon?.y ?? 0).toBeGreaterThanOrEqual(62);

    const sheld = await page.locator('#sheld').boundingBox();
    expect(sheld?.y ?? 0).toBeCloseTo(holder?.height ?? 0, 0);

    // #send_form reaches the bottom edge of the screen, while its inner controls
    // stay above the 34px home-indicator inset.
    const sendForm = await page.locator('#send_form').boundingBox();
    expect(Math.round((sendForm?.y ?? 0) + (sendForm?.height ?? 0))).toBe(932);
    const formItems = await page.locator('#nonQRFormItems').boundingBox();
    expect((formItems?.y ?? 0) + (formItems?.height ?? 0)).toBeLessThanOrEqual(898);

    // Built-in Luker Window (Admin Panel) stays clear of the status bar and home indicator.
    await page.locator('#user-settings-button').click();
    await expect(page.locator('#user-settings-block')).toHaveClass(/openDrawer/);
    const drawer = await page.locator('#user-settings-block').boundingBox();
    expect(drawer?.y ?? 0).toBeGreaterThanOrEqual(98);

    await page.locator('#admin_button').click();
    const adminWin = page.locator('.dw-win');
    await expect(adminWin).toBeVisible();
    const adminBox = await adminWin.boundingBox();
    expect(adminBox?.y ?? 0).toBeGreaterThanOrEqual(62);
    expect((adminBox?.y ?? 0) + (adminBox?.height ?? 0)).toBeLessThanOrEqual(898);
    const adminClose = page.locator('.dw-win [data-act="close"]');
    const adminCloseBox = await adminClose.boundingBox();
    expect(adminCloseBox?.y ?? 0).toBeGreaterThanOrEqual(62);
    await adminClose.click();
    await expect(adminWin).toBeHidden();

    // Third-party full-screen fixed overlay keeps its background edge-to-edge
    // while its top toolbar and close button move below the status bar.
    await page.evaluate(() => {
        const overlay = document.createElement('div');
        overlay.id = 'third-party-ccm-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#f8f9fa;display:flex;flex-direction:column;justify-content:space-between;';
        const header = document.createElement('div');
        header.id = 'third-party-ccm-header';
        header.style.cssText = 'height:44px;display:flex;align-items:center;justify-content:flex-end;';
        const closeBtn = document.createElement('button');
        closeBtn.id = 'third-party-ccm-close';
        closeBtn.textContent = '×';
        closeBtn.onclick = () => overlay.remove();
        header.appendChild(closeBtn);
        const footer = document.createElement('div');
        footer.id = 'third-party-ccm-footer';
        footer.style.cssText = 'height:36px;';
        overlay.append(header, footer);
        document.body.appendChild(overlay);
    });

    const overlay = page.locator('#third-party-ccm-overlay');
    await expect(overlay).toHaveAttribute('data-luker-ios-safe-fullscreen', '1');
    const overlayBox = await overlay.boundingBox();
    expect(Math.round(overlayBox?.y ?? -1)).toBe(0);
    expect(Math.round(overlayBox?.height ?? 0)).toBe(932);

    const headerBox = await page.locator('#third-party-ccm-header').boundingBox();
    expect(headerBox?.y ?? 0).toBeGreaterThanOrEqual(62);
    const footerBox = await page.locator('#third-party-ccm-footer').boundingBox();
    expect((footerBox?.y ?? 0) + (footerBox?.height ?? 0)).toBeLessThanOrEqual(898);

    await expect.poll(() => page.evaluate(() => window.__lukerSystemBarColors.at(-1)))
        .toBe('rgb(248, 249, 250)');

    await page.locator('#third-party-ccm-close').click();
    await expect(overlay).toHaveCount(0);
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
