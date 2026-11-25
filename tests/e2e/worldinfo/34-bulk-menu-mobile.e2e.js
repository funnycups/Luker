// #34 — World Info bulk-set-field menu on a touch viewport
//
// Guards the menu's mobile behaviour. The menu is a body-mounted dropdown, so
// it must not overflow the viewport, its rows must be fully opaque (the shared
// .list-group styling dimmed every row to opacity 0.5, which read as a dead,
// washed-out grey panel), a touch tap on a row must open the field dialog, and
// the World Info drawer must stay open behind the menu.

import { test, expect } from '../../harness/playwright.js';
import { devices } from '@playwright/test';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openWorldInfoDrawer } from '../_lib/ui-worldinfo.js';
import { startServer } from '../../harness/server.js';

test.describe.configure({ mode: 'serial' });
test.use({ ...devices['Pixel 5'] });

let server, mock;

const BULK_ENTRIES = [
    { key: ['mountain'], comment: 'mountain-pass', content: 'The northern pass is closed from first snow until thaw.', depth: 4, order: 100 },
    { key: ['coastal'], comment: 'coastal-route', content: 'The coastal route runs fast in summer but freezes the carts in winter.', depth: 4, order: 110 },
    { key: ['fenland'], comment: 'fenland-ford', content: 'Fenland ford is impassable after three days of rain.', depth: 0, order: 120 },
];

const BOOK_NAME = 'bulk-menu-mobile';

async function openBookInEditor(page, bookName) {
    await openWorldInfoDrawer(page);
    await page.locator('#world_editor_select').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction((wanted) => {
        const select = document.querySelector('#world_editor_select');
        if (!select) return false;
        return Array.from(select.options).some(o => String(o.textContent || '').trim() === wanted);
    }, bookName, { timeout: 15_000 });
    const optionValue = await page.evaluate((wanted) => {
        const select = document.querySelector('#world_editor_select');
        for (const option of Array.from(select.options)) {
            if (String(option.textContent || '').trim() === wanted) return option.value;
        }
        return null;
    }, bookName);
    if (!optionValue) throw new Error(`no editor-dropdown option matches "${bookName}"`);
    let rendered = false;
    for (let attempt = 0; attempt < 3 && !rendered; attempt++) {
        await page.evaluate((value) => {
            const jq = window.jQuery || window.$;
            jq('#world_editor_select').val(value).trigger('change');
        }, optionValue);
        try {
            await page.locator('#world_popup_entries_list .world_entry').first().waitFor({ state: 'visible', timeout: 6_000 });
            rendered = true;
        } catch { /* retry */ }
    }
    if (!rendered) throw new Error(`book "${bookName}" entries did not render after 3 retries`);
}

/** Select the whole page and open the bulk-set-field menu. Returns the menu locator. */
async function openBulkMenu(page) {
    await page.locator('#world_entries_select_page').tap();
    await page.waitForFunction(() => {
        const status = document.querySelector('#world_entry_bulk_status');
        return status && /\d/.test(String(status.textContent || ''));
    }, { timeout: 5000 });
    await page.locator('#world_entries_bulk_set_field').tap();
    const menu = page.locator('#world_bulk_set_field_menu');
    await menu.waitFor({ state: 'visible', timeout: 5000 });
    return menu;
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM();
    server = await startServer({ scope, batchKey: 'worldinfo', scenarioId: 'bulk-menu-mobile' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeWorldBook({ dataRoot: server.dataRoot, name: BOOK_NAME, entries: BULK_ENTRIES });
});

test.afterAll(async () => {
    await mock?.stop();
});

test.describe('#34 — WI bulk-set-field menu on a touch viewport', () => {
    test('menu stays inside the viewport and rows render fully opaque', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openBookInEditor(page, BOOK_NAME);
        await openBulkMenu(page);

        const geometry = await page.evaluate(() => {
            const el = document.querySelector('#world_bulk_set_field_menu');
            const rect = el.getBoundingClientRect();
            const rows = Array.from(el.querySelectorAll('.world_bulk_field_menu_item'));
            return {
                left: rect.left,
                right: rect.right,
                innerWidth: window.innerWidth,
                rowOpacities: rows.map(r => getComputedStyle(r).opacity),
                rowCount: rows.length,
            };
        });

        expect(geometry.rowCount).toBeGreaterThan(0);
        // A left-aligned menu anchored to a button near the right edge would run
        // off-screen; it must be clamped inside the viewport.
        expect(geometry.left, 'menu left edge inside the viewport').toBeGreaterThanOrEqual(0);
        expect(geometry.right, 'menu right edge inside the viewport').toBeLessThanOrEqual(geometry.innerWidth + 0.5);
        // Every row fully opaque — the shared .list-group styling dimmed them.
        for (const opacity of geometry.rowOpacities) {
            expect(Number(opacity), 'each menu row is fully opaque').toBe(1);
        }
    });

    test('tapping a row opens the field dialog and keeps the drawer open', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openBookInEditor(page, BOOK_NAME);
        const menu = await openBulkMenu(page);

        const depthLeaf = menu.locator('.world_bulk_field_menu_item', { hasText: 'Injection Depth' }).first();
        await depthLeaf.tap();

        const popup = page.locator('.popup:visible').last();
        await popup.waitFor({ state: 'visible', timeout: 5000 });
        // The value dialog proves the tap reached the row's click handler.
        await expect(popup).toContainText('Injection Depth');
        // The drawer must not auto-close from the tap that selected the row.
        await expect(page.locator('#WorldInfo')).toHaveClass(/openDrawer/);
    });

    test('tapping a submenu header expands it', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openBookInEditor(page, BOOK_NAME);
        const menu = await openBulkMenu(page);

        const header = menu.locator('.world_bulk_field_menu_submenu_header', { hasText: 'Placement' }).first();
        await header.tap();
        const body = menu.locator('.world_bulk_field_menu_submenu_body').first();
        await expect(body).toBeVisible();
    });
});
