import { test, expect } from '../../harness/playwright.js';
import { launchLukerDesktop } from '../_lib/desktop.js';
import { awaitMainUI } from '../_lib/page.js';

// Electron installs a default application menu on its own. Windows and Linux
// draw it as an in-window bar, which the shell clears; macOS keeps it, because
// the standard Edit roles there also carry the clipboard accelerators. Only the
// running platform's expectation can be asserted here.

test('the application menu matches what the platform needs', async ({ resources }) => {
    const desktop = await launchLukerDesktop({ scope: resources, scenarioId: 'window-menu' });

    try {
        await awaitMainUI(desktop.page, desktop.baseURL);

        const hasApplicationMenu = await desktop.electronApp.evaluate(
            ({ Menu }) => Menu.getApplicationMenu() !== null,
        );

        if (process.platform === 'darwin') {
            expect(hasApplicationMenu).toBe(true);
            const hasReloadRole = await desktop.electronApp.evaluate(({ Menu }) => {
                const roles = Menu.getApplicationMenu().items
                    .flatMap(item => item.submenu ? item.submenu.items : [])
                    .map(item => item.role);
                return roles.includes('reload') && roles.includes('forcereload');
            });
            expect(hasReloadRole).toBe(true);
        } else {
            expect(hasApplicationMenu).toBe(false);
            const before = await desktop.page.evaluate(() => performance.timeOrigin);
            await desktop.page.keyboard.press('F5');
            await expect.poll(
                () => desktop.page.evaluate(() => performance.timeOrigin).catch(() => before),
                { timeout: 15_000 },
            ).not.toBe(before);
        }
    } finally {
        await desktop.close();
    }
});
