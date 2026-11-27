import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';

test.use({ browserName: 'webkit', viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });

// Minimal valid 1x1 opaque PNG.
const SAMPLE_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

let server;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'regression', scenarioId: 'ios-background-mobile-menu' });
    markOnboarded({ dataRoot: server.dataRoot });
});

async function openBackgroundsDrawer(page) {
    await page.goto(server.baseURL);
    await page.waitForFunction(() => !document.getElementById('preloader') && !!window.Luker?.getContext);
    await page.locator('#backgrounds-drawer-toggle').tap();
    await expect(page.locator('#Backgrounds')).toHaveClass(/openDrawer/);
    await expect(page.locator('#bg_menu_content .bg_example').first()).toBeVisible({ timeout: 15_000 });
}

test('WebKit mobile background menu deletes selected and unselected uploaded backgrounds', async ({ page }) => {
    await openBackgroundsDrawer(page);

    const backgroundsDir = path.join(server.dataRoot, 'default-user', 'backgrounds');

    // Upload a background via the real file input; upload selects it automatically.
    await page.locator('#add_bg_button').setInputFiles({
        name: 'sunset-harbor.png',
        mimeType: 'image/png',
        buffer: SAMPLE_PNG,
    });

    const uploadedCard = page.locator('#bg_menu_content .bg_example[bgfile="sunset-harbor.png"]');
    await expect(uploadedCard).toBeVisible({ timeout: 15_000 });
    await expect(uploadedCard).toHaveClass(/selected-background/);
    expect(fs.existsSync(path.join(backgroundsDir, 'sunset-harbor.png'))).toBe(true);

    // Open the mobile action menu and tap Delete.
    await uploadedCard.locator('.mobile-only-menu-toggle').tap();
    await expect(uploadedCard).toHaveClass(/mobile-menu-open/);
    await expect(uploadedCard.locator('.jg-menu')).toHaveCSS('display', 'flex');
    await expect(uploadedCard.locator('.jg-menu')).toHaveCSS('opacity', '1');
    await expect(uploadedCard.locator('.jg-menu')).toHaveCSS('visibility', 'visible');

    await uploadedCard.locator('.jg-button.jg-delete').tap();
    const deletePopup = page.locator('.popup:visible').last();
    await expect(deletePopup).toBeVisible({ timeout: 5_000 });
    await deletePopup.locator('.popup-button-ok').tap();

    await expect(uploadedCard).toHaveCount(0);
    await expect.poll(() => fs.existsSync(path.join(backgroundsDir, 'sunset-harbor.png'))).toBe(false);

    // Upload a second background, switch selection away, verify tapping outside
    // closes the menu, and deleting it neither selects it nor drops the click.
    await page.locator('#add_bg_button').setInputFiles({
        name: 'moonlit-garden.png',
        mimeType: 'image/png',
        buffer: SAMPLE_PNG,
    });
    const secondCard = page.locator('#bg_menu_content .bg_example[bgfile="moonlit-garden.png"]');
    await expect(secondCard).toBeVisible({ timeout: 15_000 });

    const otherCard = page.locator('#bg_menu_content .bg_example[bgfile="_black.jpg"]');
    await otherCard.tap();
    await expect(otherCard).toHaveClass(/selected-background/);
    await expect(secondCard).not.toHaveClass(/selected-background/);

    await secondCard.locator('.mobile-only-menu-toggle').tap();
    await expect(secondCard).toHaveClass(/mobile-menu-open/);

    // Tapping outside closes the open mobile menu.
    await page.locator('#bg-header-fixed h3').tap();
    await expect(secondCard).not.toHaveClass(/mobile-menu-open/);

    // Re-open menu and delete without accidentally selecting secondCard.
    await secondCard.locator('.mobile-only-menu-toggle').tap();
    await expect(secondCard).toHaveClass(/mobile-menu-open/);
    await secondCard.locator('.jg-button.jg-delete').tap();

    const secondPopup = page.locator('.popup:visible').last();
    await expect(secondPopup).toBeVisible({ timeout: 5_000 });
    await expect(secondCard).not.toHaveClass(/selected-background/);
    await secondPopup.locator('.popup-button-ok').tap();

    await expect(secondCard).toHaveCount(0);
    await expect.poll(() => fs.existsSync(path.join(backgroundsDir, 'moonlit-garden.png'))).toBe(false);
});

test('WebKit mobile background menu stays visible without hover and folder menus dismiss outside', async ({ page }) => {
    await openBackgroundsDrawer(page);

    // Open via keyboard Enter on the toggle (no pointer :hover on the card) and
    // confirm .mobile-menu-open keeps .jg-menu visible on its own.
    const firstCard = page.locator('#bg_menu_content .bg_example').first();
    const firstToggle = firstCard.locator('.mobile-only-menu-toggle');
    await firstToggle.focus();
    await page.keyboard.press('Enter');
    await expect(firstCard).toHaveClass(/mobile-menu-open/);
    await firstToggle.blur();
    const states = await firstCard.evaluate((el) => ({
        hover: el.matches(':hover'),
        focusWithin: el.matches(':focus-within'),
    }));
    expect(states).toEqual({ hover: false, focusWithin: false });
    await expect(firstCard.locator('.jg-menu')).toHaveCSS('display', 'flex');
    await expect(firstCard.locator('.jg-menu')).toHaveCSS('opacity', '1');
    await expect(firstCard.locator('.jg-menu')).toHaveCSS('visibility', 'visible');

    // Dismiss the card menu before creating a folder.
    await page.locator('#bg-header-fixed h3').tap();
    await expect(firstCard).not.toHaveClass(/mobile-menu-open/);

    // Create a folder, open its mobile menu, dismiss by tapping outside, then delete it.
    await page.locator('#bg_add_folder_button').tap();
    const createPopup = page.locator('.popup:visible').last();
    await expect(createPopup).toBeVisible({ timeout: 5_000 });
    await createPopup.locator('.popup-input').fill('Harbor Scenes');
    await createPopup.locator('.popup-button-ok').tap();

    const folderTile = page.locator('#bg_folder_grid .bg_folder_tile').filter({ hasText: 'Harbor Scenes' });
    await expect(folderTile).toBeVisible({ timeout: 10_000 });

    await folderTile.locator('.mobile-only-menu-toggle').tap();
    await expect(folderTile).toHaveClass(/mobile-menu-open/);

    await page.locator('#bg-header-fixed h3').tap();
    await expect(folderTile).not.toHaveClass(/mobile-menu-open/);

    await folderTile.locator('.mobile-only-menu-toggle').tap();
    await expect(folderTile).toHaveClass(/mobile-menu-open/);
    await folderTile.locator('[data-action="delete-folder"]').tap();

    const confirmFolderDelete = page.locator('.popup:visible').last();
    await expect(confirmFolderDelete).toBeVisible({ timeout: 5_000 });
    await confirmFolderDelete.locator('.popup-button-ok').tap();

    await expect(folderTile).toHaveCount(0);
});
