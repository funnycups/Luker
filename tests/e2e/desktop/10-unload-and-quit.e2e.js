import { test, expect } from '@playwright/test';
import { launchLukerDesktop } from '../_lib/desktop.js';
import { awaitMainUI } from '../_lib/page.js';

async function openUserSettingsDrawer(page) {
    await page.locator('#user-settings-button').waitFor({ state: 'visible', timeout: 10_000 });
    const closed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count();
    if (closed > 0) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const el = document.getElementById('user-settings-block');
            return el && !el.classList.contains('closedDrawer');
        }, undefined, { timeout: 5_000 });
    }
}

test('reload prompts when beforeunload guards unsaved input and app quit exits cleanly', async () => {
    const desktop = await launchLukerDesktop({ scenarioId: 'unload-and-quit' });
    let exited = false;

    try {
        await awaitMainUI(desktop.page, desktop.baseURL);

        await desktop.electronApp.evaluate(({ dialog }) => {
            globalThis.__unloadDialogs = [];
            globalThis.__nextUnloadChoice = 1;
            dialog.showMessageBoxSync = (_winOrOpts, maybeOpts) => {
                const opts = maybeOpts ?? _winOrOpts;
                globalThis.__unloadDialogs.push({
                    title: opts.title,
                    detail: opts.detail,
                    buttons: opts.buttons,
                });
                return globalThis.__nextUnloadChoice;
            };
        });

        await desktop.page.locator('#send_textarea').fill('unsaved draft message');
        await openUserSettingsDrawer(desktop.page);

        const reloadButton = desktop.page.locator('#account_controls #app_reload_button');
        await expect(reloadButton).toBeVisible();
        await expect(reloadButton).toBeInViewport();

        // 1. User cancels the confirmation dialog -> page stays put and keeps draft.
        const initialOrigin = await desktop.page.evaluate(() => performance.timeOrigin);
        await reloadButton.click({ noWaitAfter: true });

        await expect.poll(
            () => desktop.electronApp.evaluate(() => globalThis.__unloadDialogs.length),
        ).toBe(1);
        expect(await desktop.page.evaluate(() => performance.timeOrigin)).toBe(initialOrigin);
        expect(await desktop.page.evaluate(() => document.getElementById('send_textarea').value))
            .toBe('unsaved draft message');

        // 2. User confirms leaving -> page reloads.
        await desktop.electronApp.evaluate(() => {
            globalThis.__nextUnloadChoice = 0;
        });
        const box = await desktop.page.evaluate(() => {
            const r = document.getElementById('app_reload_button').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await desktop.page.mouse.click(box.x, box.y);

        await expect.poll(
            () => desktop.page.evaluate(() => performance.timeOrigin).catch(() => initialOrigin),
            { timeout: 15_000 },
        ).not.toBe(initialOrigin);
        await awaitMainUI(desktop.page, desktop.baseURL);

        const afterConfirmDialogs = await desktop.electronApp.evaluate(() => globalThis.__unloadDialogs.length);
        expect(afterConfirmDialogs).toBe(2);

        // 3. Window hidden to tray with unsaved draft -> app.quit() exits the process cleanly without hanging.
        await desktop.page.locator('#send_textarea').fill('draft before tray quit');
        await desktop.electronApp.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].hide();
        });

        const exitPromise = desktop.waitForExit();
        await desktop.electronApp.evaluate(({ app }) => app.quit());
        await exitPromise;
        exited = true;
    } finally {
        if (!exited) {
            const proc = desktop.electronApp?.process?.();
            if (proc && proc.exitCode === null) {
                proc.kill('SIGKILL');
            }
        }
        await desktop.close().catch(() => {});
    }
});
