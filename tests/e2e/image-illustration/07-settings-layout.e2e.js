import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';

test.describe.configure({ mode: 'default' });
test.use({ viewport: { width: 390, height: 844 } });

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'image-illustration', scenarioId: '07-settings-layout' });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

for (const locale of ['en', 'zh-cn', 'zh-tw']) {
    test(`illustration settings keep labels readable in ${locale}`, async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await page.locator('#user-settings-button .drawer-toggle').click();
        await Promise.all([
            page.waitForEvent('load'),
            page.locator('#ui_language_select').selectOption(locale),
        ]);
        await page.waitForFunction(() => document.getElementById('preloader') === null
            && performance.getEntriesByName('[init] complete').length > 0);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_illustration_container');

        // Cover a narrow phone, a standard phone, and the desktop settings drawer.
        for (const width of [320, 390, 1280]) {
            await page.setViewportSize({ width, height: 844 });
            const rows = await page.locator('#sd_illustration_container .sd_illustration_row').evaluateAll(elements => elements.map(row => {
                const label = row.querySelector('label');
                const control = row.querySelector('select, input');
                return {
                    id: control.id,
                    row: row.getBoundingClientRect().toJSON(),
                    label: label.getBoundingClientRect().toJSON(),
                    control: control.getBoundingClientRect().toJSON(),
                };
            }));

            expect(rows).toHaveLength(8);
            for (const { id, row, label, control } of rows) {
                const context = `${locale}, ${width}px, ${id}`;
                // Allow one CSS pixel for subpixel layout rounding.
                expect(label.width, `${context}: label uses the available row width`).toBeGreaterThanOrEqual(row.width - 1);
                expect(control.top, `${context}: control is below its label`).toBeGreaterThanOrEqual(label.bottom - 1);
                expect(control.left, `${context}: control stays inside the row`).toBeGreaterThanOrEqual(row.left - 1);
                expect(control.right, `${context}: control stays inside the row`).toBeLessThanOrEqual(row.right + 1);
            }
        }
    });
}
