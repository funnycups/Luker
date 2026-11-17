import { test, expect } from '@playwright/test';
import { launchLukerDesktop, spawnLukerDesktop } from '../_lib/desktop.js';
import { awaitMainUI } from '../_lib/page.js';

test('launching a second instance exits immediately and restores the running window', async () => {
    const first = await launchLukerDesktop({ scenarioId: 'single-instance' });

    let second = null;
    try {
        await awaitMainUI(first.page, first.baseURL);

        // Hide the running window (matching close-to-tray state on Windows/macOS).
        await first.electronApp.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].hide();
        });
        expect(
            await first.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
        ).toBe(false);

        // Spawn a second desktop process targeting the exact same userData directory.
        second = spawnLukerDesktop({
            defaultUserData: first.userData,
            extraEnv: { LUKER_DESKTOP_USER_DATA: first.userData },
        });
        const exit = await second.waitForExit();
        expect(exit.code).toBe(0);

        await expect.poll(() => first.electronApp.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible(),
        )).toBe(true);

        // Minimize the running window and verify another launch restores it too.
        await first.electronApp.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].minimize();
        });
        await expect.poll(() => first.electronApp.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized(),
        )).toBe(true);

        second = spawnLukerDesktop({
            defaultUserData: first.userData,
            extraEnv: { LUKER_DESKTOP_USER_DATA: first.userData },
        });
        const secondExit = await second.waitForExit();
        expect(secondExit.code).toBe(0);

        await expect.poll(() => first.electronApp.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized(),
        )).toBe(false);
    } finally {
        if (second?.child?.exitCode === null) {
            second.child.kill('SIGKILL');
        }
        await first.close();
    }
});
