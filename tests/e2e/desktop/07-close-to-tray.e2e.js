import { test, expect } from '../../harness/playwright.js';
import { launchLukerDesktop } from '../_lib/desktop.js';
import { awaitMainUI } from '../_lib/page.js';

// Closing the window hides it on macOS and Windows instead of quitting. The
// backend runs inside the shell process, so the app has to outlive a close for
// a generation in flight to finish, and the page keeps its state because it is
// never unloaded. Each of those platforms keeps a way back to the hidden
// window: Windows a tray icon, macOS the Dock and an application menu carrying
// the data directory command. Linux has neither, so a close destroys the
// window and the app exits.

const LINUX = process.platform === 'linux';

test.describe.configure({ mode: 'serial' });

let desktop;
let exited = false;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    desktop = await launchLukerDesktop({
        scope,
        scenarioId: 'close-to-tray',
        extraEnv: { LUKER_DESKTOP_SKIP_OPEN_DATA_DIR: '1' },
    });
    await awaitMainUI(desktop.page, desktop.baseURL);
});

test.afterAll(async () => {
    // The Linux case closes the app under test, so there is nothing left to
    // close here.
    if (!exited) {
        await desktop?.close();
    }
});

test('closing the window hides it and leaves the backend serving', async () => {
    test.skip(LINUX, 'Linux destroys the window and exits on close');

    const { electronApp, port } = desktop;

    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());

    const windowState = await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return { destroyed: win.isDestroyed(), visible: win.isVisible() };
    });
    expect(windowState.destroyed).toBe(false);
    expect(windowState.visible).toBe(false);

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.ok).toBe(true);
});

test('closing the window destroys it and exits the app', async () => {
    test.skip(!LINUX, 'macOS and Windows hide the window instead of exiting');

    const { electronApp } = desktop;

    // Linux keeps no application menu and no tray, so a hidden window would be
    // unreachable; the shell lets the close through. Electron quits once the
    // last window is closed, so the app exiting means the close destroyed the
    // window rather than hiding it.
    const hasApplicationMenu = await electronApp.evaluate(
        ({ Menu }) => Menu.getApplicationMenu() !== null,
    );
    expect(hasApplicationMenu).toBe(false);

    const closed = electronApp.waitForEvent('close');
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;
    exited = true;
});

test('showing the window again lands on the same page', async () => {
    test.skip(LINUX, 'Linux destroys the window on close, so there is nothing to show again');

    const { electronApp, page } = desktop;
    const url = page.url();
    await page.evaluate(() => { window.__lukerCloseProbe = 'kept'; });
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);

    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());

    await expect.poll(() => electronApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible(),
    )).toBe(true);

    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => window.__lukerCloseProbe)).toBe('kept');
    // A reload would reset the document's time origin, so this rules out the
    // window coming back as a fresh boot.
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    await expect(page.locator('#chat')).toBeVisible();
});

test('the app comes back from the Dock on macOS', async () => {
    test.skip(LINUX, 'Linux has no Dock and the close already exited the app');

    const { electronApp } = desktop;

    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    // Clicking the Dock icon makes macOS emit `activate` on the app, which is
    // as close as a test can get to that click.
    await electronApp.evaluate(({ app }) => app.emit('activate'));

    const visible = await electronApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible(),
    );
    if (process.platform === 'darwin') {
        expect(visible).toBe(true);
    } else {
        expect(visible).toBe(false);
    }
});

test('the data directory command reaches the configured data root', async () => {
    test.skip(LINUX, 'Linux carries the command nowhere and the close already exited the app');

    const { electronApp, userData } = desktop;

    if (process.platform !== 'darwin') {
        // Windows carries the command in the tray menu, and Electron exposes no
        // handle for a tray, so what this run can assert is the platform split
        // itself.
        const hasApplicationMenu = await electronApp.evaluate(
            ({ Menu }) => Menu.getApplicationMenu() !== null,
        );
        expect(hasApplicationMenu).toBe(false);
        return;
    }

    const labels = await electronApp.evaluate(({ Menu }) => {
        const appMenu = Menu.getApplicationMenu().items[0].submenu;
        const item = appMenu.items.find(entry => !entry.role && entry.type === 'normal');
        // Calling the item's own handler is what the native menu does.
        item.click();
        return appMenu.items.filter(entry => entry.type === 'normal').map(entry => entry.label);
    });

    const opened = await electronApp.evaluate(() => globalThis.__lukerDataDirectoryOpens);
    expect(opened).toEqual([userData]);
    expect(labels.length).toBeGreaterThan(1);
});
