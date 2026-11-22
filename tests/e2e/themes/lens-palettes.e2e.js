import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'themes', scenarioId: 'lens-palettes' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function installNativeBarSpies(page) {
    await page.addInitScript(() => {
        window.__androidBarCalls = [];
        window.__iosBarCalls = [];
        window.LukerAndroid = {
            setSystemBarsColor(statusColor, navColor) {
                window.__androidBarCalls.push([statusColor, navColor]);
            },
        };
        window.LukerIOS = {
            setSystemBarsColor(topColor, bottomColor) {
                window.__iosBarCalls.push([topColor, bottomColor]);
            },
        };
    });
}

async function openUserSettingsDrawer(page) {
    const closedIcon = page.locator('#user-settings-button .drawer-icon.closedIcon');
    if (await closedIcon.count()) {
        await page.locator('#user-settings-button .drawer-toggle').click();
    }
    await expect(page.locator('#themes')).toBeVisible();
}

async function closeUserSettingsDrawerIfOpen(page) {
    const openIcon = page.locator('#user-settings-button .drawer-icon.openIcon');
    if (await openIcon.count()) {
        await page.locator('#user-settings-button .drawer-toggle').click();
    }
}

async function selectTheme(page, themeName) {
    await openUserSettingsDrawer(page);
    await page.locator('#themes').selectOption(themeName);
    await expect(page.locator('#themes')).toHaveValue(themeName);
    await closeUserSettingsDrawerIfOpen(page);
}

async function openOptionsMenu(page) {
    const options = page.locator('#options');
    if (!(await options.isVisible())) {
        await page.locator('#options_button').click();
    }
    await expect(options).toBeVisible();
}

test('Lens theme declarative palettes switch styles, persist across reload, sync native bars, and clean up on theme switch', async ({ page }) => {
    await installNativeBarSpies(page);
    await awaitMainUI(page, server.baseURL);

    // Select Lens theme through the real User Settings UI
    await selectTheme(page, 'Lens');

    await expect.poll(() => page.evaluate(() => ({
        active: document.documentElement.classList.contains('theme-palettes-active'),
        palette: document.documentElement.dataset.themePalette,
        meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    }))).toEqual({
        active: true,
        palette: 'night',
        meta: '#07090f',
    });

    // Night ambient layer sits behind #bg1 so user background images remain visible
    const layerOrder = await page.evaluate(() => {
        const before = getComputedStyle(document.body, '::before');
        const bg1 = getComputedStyle(document.getElementById('bg1'));
        return {
            beforeDisplay: before.display,
            beforeZIndex: Number(before.zIndex),
            bg1ZIndex: Number(bg1.zIndex),
        };
    });
    expect(layerOrder.beforeDisplay).toBe('block');
    expect(layerOrder.beforeZIndex).toBeLessThan(layerOrder.bg1ZIndex);

    // Open #options menu and verify 5 palette radios
    await openOptionsMenu(page);
    const strip = page.locator('#theme-palette-strip');
    await expect(strip).toBeVisible();
    const radios = strip.locator('[role="radio"]');
    await expect(radios).toHaveCount(5);

    // Click Mist (light frosted)
    await strip.locator('[data-mode="mist"]').click();
    await expect.poll(() => page.evaluate(() => ({
        palette: document.documentElement.dataset.themePalette,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
        lastAndroid: window.__androidBarCalls.at(-1),
    }))).toEqual({
        palette: 'mist',
        bodyBg: 'rgb(232, 236, 243)',
        meta: '#e8ecf3',
        lastAndroid: ['#e8ecf3', '#e8ecf3'],
    });
    const lastIosMist = await page.evaluate(() => window.__iosBarCalls.at(-1));
    expect(lastIosMist).toBeTruthy();
    const mistRgb = lastIosMist[0].match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(mistRgb).not.toBeNull();
    expect(Number(mistRgb[1])).toBeGreaterThan(200);
    expect(Number(mistRgb[2])).toBeGreaterThan(200);
    expect(Number(mistRgb[3])).toBeGreaterThan(200);

    // Click Paper (flat warm light, 0 backdrop blur, no ambient layer)
    await strip.locator('[data-mode="paper"]').click();
    await expect.poll(() => page.evaluate(() => ({
        palette: document.documentElement.dataset.themePalette,
        meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
        beforeDisplay: getComputedStyle(document.body, '::before').display,
        topBarBlur: getComputedStyle(document.getElementById('top-bar')).backdropFilter,
        lastAndroid: window.__androidBarCalls.at(-1),
    }))).toEqual({
        palette: 'paper',
        meta: '#efece5',
        beforeDisplay: 'none',
        topBarBlur: 'none',
        lastAndroid: ['#efece5', '#efece5'],
    });

    // Keyboard navigation with ArrowLeft moves from Paper -> Ink with roving tabindex
    const paperBtn = strip.locator('[data-mode="paper"]');
    await paperBtn.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(strip.locator('[data-mode="ink"]')).toBeFocused();
    await expect(strip.locator('[data-mode="ink"]')).toHaveAttribute('aria-checked', 'true');
    await expect(strip.locator('[data-mode="ink"]')).toHaveAttribute('tabindex', '0');
    await expect(paperBtn).toHaveAttribute('tabindex', '-1');
    await expect.poll(() => page.evaluate(() => ({
        palette: document.documentElement.dataset.themePalette,
        meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    }))).toEqual({
        palette: 'ink',
        meta: '#0f1219',
    });

    // Wait for debounced settings save before reloading
    await page.waitForTimeout(1500);
    await awaitMainUI(page, server.baseURL);

    await expect.poll(() => page.evaluate(() => ({
        active: document.documentElement.classList.contains('theme-palettes-active'),
        palette: document.documentElement.dataset.themePalette,
        meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
        lastAndroid: window.__androidBarCalls.at(-1),
    }))).toEqual({
        active: true,
        palette: 'ink',
        meta: '#0f1219',
        lastAndroid: ['#0f1219', '#0f1219'],
    });

    // Switch away to Azure: strip hides, attributes clear, and meta + Android receive Azure's blur tint (not stale #333)
    await selectTheme(page, 'Azure');
    await expect.poll(() => page.evaluate(() => ({
        active: document.documentElement.classList.contains('theme-palettes-active'),
        palette: document.documentElement.dataset.themePalette ?? null,
        meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
        lastAndroid: window.__androidBarCalls.at(-1),
    }))).toEqual({
        active: false,
        palette: null,
        meta: 'rgba(23, 30, 33, 0.61)',
        lastAndroid: ['rgba(23, 30, 33, 0.61)', 'rgba(23, 30, 33, 0.61)'],
    });

    await openOptionsMenu(page);
    await expect(page.locator('#theme-palette-strip')).toBeHidden();
});

test('imported themes honor declarative palettes without leaking palettes from Lens', async ({ page }) => {
    await installNativeBarSpies(page);
    await awaitMainUI(page, server.baseURL);

    // Start with Lens active so power_user.palettes is populated
    await selectTheme(page, 'Lens');
    await openUserSettingsDrawer(page);

    // Import a plain theme without palettes while Lens is active
    const plainTheme = {
        name: 'Plain Imported',
        blur_tint_color: 'rgba(18, 24, 32, 1)',
        custom_css: '',
    };
    await page.locator('#ui_preset_import_file').setInputFiles({
        name: 'plain-imported.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(plainTheme), 'utf8'),
    });
    await expect(page.locator('#themes option[value="Plain Imported"]')).toHaveCount(1);

    // Import a third-party theme with its own 2-palette declaration
    const dualTheme = {
        name: 'Dual Tone',
        blur_tint_color: 'rgba(42, 31, 22, 1)',
        palettes: {
            default: 'warm',
            items: [
                { id: 'warm', label: 'Warm', title: 'Warm Mode', theme_color: '#2a1f16', swatch: '#d99b66' },
                { id: 'cool', label: 'Cool', title: 'Cool Mode', theme_color: '#14202b', swatch: '#5fa8d3' },
            ],
        },
        custom_css: ':root[data-theme-palette="cool"] { --SmartThemeBodyColor: rgba(210, 230, 255, 1) !important; }',
    };
    await page.locator('#ui_preset_import_file').setInputFiles({
        name: 'dual-tone.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(dualTheme), 'utf8'),
    });
    await expect(page.locator('#themes option[value="Dual Tone"]')).toHaveCount(1);

    // Selecting Plain Imported must NOT inherit Lens palettes
    await page.locator('#themes').selectOption('Plain Imported');
    await expect.poll(() => page.evaluate(() => ({
        active: document.documentElement.classList.contains('theme-palettes-active'),
        palette: document.documentElement.dataset.themePalette ?? null,
        meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    }))).toEqual({
        active: false,
        palette: null,
        meta: 'rgba(18, 24, 32, 1)',
    });

    // Selecting Dual Tone renders its own 2-button strip (no Auto) and switches cleanly
    await page.locator('#themes').selectOption('Dual Tone');
    await closeUserSettingsDrawerIfOpen(page);
    await openOptionsMenu(page);
    const strip = page.locator('#theme-palette-strip');
    await expect(strip).toBeVisible();
    await expect(strip.locator('[role="radio"]')).toHaveCount(2);

    await strip.locator('[data-mode="cool"]').click();
    await expect.poll(() => page.evaluate(() => ({
        palette: document.documentElement.dataset.themePalette,
        bodyColor: getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBodyColor').trim(),
        meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
        lastAndroid: window.__androidBarCalls.at(-1),
    }))).toEqual({
        palette: 'cool',
        bodyColor: 'rgba(210, 230, 255, 1)',
        meta: '#14202b',
        lastAndroid: ['#14202b', '#14202b'],
    });
});

test('palette strip stays within viewport and mobile drawers disable backdrop blur on narrow screens', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await awaitMainUI(page, server.baseURL);
    await selectTheme(page, 'Lens');

    // Open User Settings drawer on mobile and confirm full-screen drawer disables blur
    await openUserSettingsDrawer(page);
    const drawerBlur = await page.evaluate(() => {
        const drawer = document.querySelector('#user-settings-block')?.closest('.drawer-content');
        return drawer ? getComputedStyle(drawer).backdropFilter : null;
    });
    expect(drawerBlur).toBe('none');
    await closeUserSettingsDrawerIfOpen(page);

    // Open #options menu and verify every palette radio fits inside #options and viewport
    await openOptionsMenu(page);
    const layout = await page.evaluate(() => {
        const options = document.getElementById('options');
        const strip = document.getElementById('theme-palette-strip');
        const optionsRect = options.getBoundingClientRect();
        const stripRect = strip.getBoundingClientRect();
        const items = Array.from(strip.querySelectorAll('[role="radio"]')).map((btn) => {
            const r = btn.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
                mode: btn.dataset.mode,
                width: r.width,
                height: r.height,
                hitOk: Boolean(hit && btn.contains(hit)),
            };
        });
        return {
            viewportWidth: window.innerWidth,
            optionsLeft: optionsRect.left,
            optionsRight: optionsRect.right,
            stripLeft: stripRect.left,
            stripRight: stripRect.right,
            items,
        };
    });

    expect(layout.optionsLeft).toBeGreaterThanOrEqual(0);
    expect(layout.optionsRight).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.stripLeft).toBeGreaterThanOrEqual(layout.optionsLeft - 1);
    expect(layout.stripRight).toBeLessThanOrEqual(layout.optionsRight + 1);
    expect(layout.items).toHaveLength(5);
    for (const item of layout.items) {
        expect(item.width).toBeGreaterThan(0);
        expect(item.height).toBeGreaterThanOrEqual(40);
        expect(item.hitOk).toBe(true);
    }
});
