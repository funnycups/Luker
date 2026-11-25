import { test, expect } from '../../harness/playwright.js';
import { launchLukerDesktop, spawnLukerDesktop } from '../_lib/desktop.js';
import { awaitMainUI } from '../_lib/page.js';

test('launching a second instance exits immediately and restores the running window', async ({ resources }) => {
    const first = await launchLukerDesktop({ scope: resources, scenarioId: 'single-instance' });

    let second = null;
    try {
        await awaitMainUI(first.page, first.baseURL);

        await first.electronApp.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].hide();
        });
        expect(
            await first.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
        ).toBe(false);

        second = await spawnLukerDesktop({
            scope: resources,
            defaultUserData: first.userDataDirectory,
            extraEnv: { LUKER_DESKTOP_USER_DATA: first.userData },
        });
        const exit = await second.waitForExit();
        expect(exit.code).toBe(0);

        await expect.poll(() => first.electronApp.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible(),
        )).toBe(true);

        await first.electronApp.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].minimize();
        });
        await expect.poll(() => first.electronApp.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized(),
        )).toBe(true);

        second = await spawnLukerDesktop({
            scope: resources,
            defaultUserData: first.userDataDirectory,
            extraEnv: { LUKER_DESKTOP_USER_DATA: first.userData },
        });
        const secondExit = await second.waitForExit();
        expect(secondExit.code).toBe(0);

        await expect.poll(() => first.electronApp.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized(),
        )).toBe(false);
    } finally {
        await second?.stop();
        await first.close();
    }
});
