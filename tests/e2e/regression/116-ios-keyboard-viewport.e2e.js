import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';

test.use({ browserName: 'webkit', viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'ios-keyboard-viewport' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => { await tearDownServer(server); });

async function openApp(page, { ios = true, visualViewport = true } = {}) {
    // Desktop WebKit cannot open an iPhone keyboard or enable iOS-only CSS.
    // Exercise the shipped iOS rules with the size/pan events that it reports;
    // real-device keyboard animation and safe-area behavior still need a smoke test.
    if (ios) {
        await page.route('**/css/mobile-styles.css', async route => {
            const response = await route.fetch();
            await route.fulfill({ response, body: (await response.text()).replace(
                '@supports (-webkit-touch-callout: none)', '@supports (display: block)',
            ) });
        });
    }
    await page.addInitScript(({ ios, visualViewport }) => {
        const supports = CSS.supports.bind(CSS);
        CSS.supports = (...args) => args[0] === '-webkit-touch-callout' ? ios : supports(...args);
        const viewport = Object.assign(new EventTarget(), { height: 852, offsetTop: 0, scale: 1 });
        let layoutHeight = 852;
        Object.defineProperty(window, 'innerHeight', { get: () => layoutHeight });
        Object.defineProperty(window, 'visualViewport', { value: visualViewport ? viewport : undefined });
        Object.defineProperty(navigator, 'standalone', { value: true });
        window.__setTestViewport = ({ height, offsetTop = 0, scale = 1, innerHeight = 852, event = 'resize' }) => {
            Object.assign(viewport, { height, offsetTop, scale });
            layoutHeight = innerHeight;
            (visualViewport ? viewport : window).dispatchEvent(new Event(event));
        };
    }, { ios, visualViewport });
    await page.goto(server.baseURL);
    await page.waitForFunction(() => !document.getElementById('preloader') && !!window.Luker?.getContext);
}

async function expectComposerAtBottom(page, height, offsetTop = 0) {
    await expect.poll(() => page.locator('#form_sheld').evaluate((form, offset) => {
        return Math.round(form.getBoundingClientRect().bottom - offset);
    }, offsetTop)).toBeGreaterThanOrEqual(height - 50); // Leave room for the PWA home indicator.
    await expect.poll(() => page.locator('#form_sheld').evaluate((form, offset) => {
        return Math.round(form.getBoundingClientRect().bottom - offset);
    }, offsetTop)).toBeLessThanOrEqual(height + 1);
}

test('iOS PWA composer follows keyboard size and pan without losing the draft', async ({ page }) => {
    await openApp(page);
    await expectComposerAtBottom(page, 852);
    const input = page.locator('#send_textarea');
    await input.tap();
    await input.fill('我把地图放在桌上，等你看完再继续。');

    // iOS pans the native viewport to reveal the composer. Its dvh-sized layout
    // stays intact, while innerHeight can already exclude the software keyboard.
    await page.evaluate(() => window.__setTestViewport({ height: 430, innerHeight: 430, offsetTop: 422 }));
    await expectComposerAtBottom(page, 430, 422);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('我把地图放在桌上，等你看完再继续。');

    // Candidate-bar height changes must not shrink the layout a second time.
    await page.evaluate(() => window.__setTestViewport({ height: 390, innerHeight: 390, offsetTop: 462 }));
    await expectComposerAtBottom(page, 390, 462);

    await input.blur();
    await page.evaluate(() => window.__setTestViewport({ height: 852 }));
    await expectComposerAtBottom(page, 852);
    await expect(input).toHaveValue('我把地图放在桌上，等你看完再继续。');
});

test('iOS retains native layout positioning when zooming', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__setTestViewport({ height: 426, offsetTop: 100, scale: 2 }));
    await expectComposerAtBottom(page, 852);
    await expect(page.locator('body')).toHaveCSS('position', 'fixed');
    await expect(page.locator('body')).toHaveCSS('transform', 'none');
});

test('layout-resizing browsers keep the composer visible without iOS positioning', async ({ page }) => {
    await openApp(page, { ios: false });
    await page.evaluate(() => window.__setTestViewport({ height: 430, innerHeight: 430 }));
    await expectComposerAtBottom(page, 430);
    await expect(page.locator('body')).toHaveCSS('position', 'fixed');
});

test('browsers without VisualViewport continue using window resize', async ({ page }) => {
    await openApp(page, { ios: false, visualViewport: false });
    await page.evaluate(() => window.__setTestViewport({ innerHeight: 430 }));
    await expectComposerAtBottom(page, 430);
    await page.evaluate(() => window.__setTestViewport({ innerHeight: 852 }));
    await expectComposerAtBottom(page, 852);
    await expect(page.locator('body')).toHaveCSS('position', 'fixed');
});
