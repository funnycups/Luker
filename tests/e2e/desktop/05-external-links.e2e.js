import { test, expect } from '../../harness/playwright.js';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchLukerDesktop } from '../_lib/desktop.js';
import { awaitMainUI } from '../_lib/page.js';

// Chromium hands `window.open` and `target="_blank"` to the embedder, and the
// default is a bare BrowserWindow: no address bar, no back button, nothing the
// user can do with it but close it. The shell routes anything outside the
// app's own origin to the system browser instead. These specs drive real links
// in the real UI against the real Electron shell.

test.describe.configure({ mode: 'serial' });

async function openedExternally(electronApp) {
    return electronApp.evaluate(() => globalThis.__lukerExternalOpens ?? []);
}

test('an external link opens outside the app instead of in a bare window', async ({ resources }) => {
    const desktop = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'external-link',
        extraEnv: { LUKER_DESKTOP_SKIP_OPEN_EXTERNAL: '1' },
    });

    try {
        await awaitMainUI(desktop.page, desktop.baseURL);
        const windowsBefore = desktop.electronApp.windows().length;

        // The AI response configuration drawer carries a help link to the docs.
        await desktop.page.locator('#leftNavDrawerIcon').click();
        const link = desktop.page
            .locator('#left-nav-panel a[target="_blank"][href^="https://"]:visible')
            .first();
        await expect(link).toBeVisible();
        const href = await link.getAttribute('href');

        await link.click();

        await expect
            .poll(async () => (await openedExternally(desktop.electronApp)).length)
            .toBe(1);
        expect(await openedExternally(desktop.electronApp)).toEqual([href]);
        expect(desktop.electronApp.windows()).toHaveLength(windowsBefore);
    } finally {
        await desktop.close();
    }
});

test('a link that would navigate the app window away is handed to the browser instead', async ({ resources }) => {
    const desktop = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'external-navigate',
        extraEnv: { LUKER_DESKTOP_SKIP_OPEN_EXTERNAL: '1' },
    });

    try {
        await awaitMainUI(desktop.page, desktop.baseURL);

        // No shipped page has an external link without target="_blank", so an
        // in-page link is the only way to reach the navigation path. The click
        // and everything after it are real.
        await desktop.page.evaluate(() => {
            const anchor = document.createElement('a');
            anchor.id = 'e2e-external-navigate';
            anchor.href = 'https://example.com/e2e-external-navigate';
            anchor.textContent = 'e2e external navigate';
            anchor.style.cssText =
                'position: fixed; top: 4px; left: 4px; z-index: 2147483647; background: white; padding: 4px;';
            document.body.append(anchor);
        });
        // The navigation is prevented, so Playwright's click would wait for a
        // navigation that never settles; a real mouse click at the element's
        // coordinates does not auto-wait and is still a trusted event.
        const box = await desktop.page.locator('#e2e-external-navigate').boundingBox();
        await desktop.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

        await expect
            .poll(async () => (await openedExternally(desktop.electronApp)).length)
            .toBe(1);
        expect(await openedExternally(desktop.electronApp)).toEqual([
            'https://example.com/e2e-external-navigate',
        ]);
        expect(new URL(desktop.page.url()).origin).toBe(desktop.baseURL);
    } finally {
        await desktop.close();
    }
});

test('turning the setting off keeps an external link inside the app', async ({ resources }) => {
    const desktop = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'external-link-toggle-off',
        extraEnv: { LUKER_DESKTOP_SKIP_OPEN_EXTERNAL: '1' },
    });

    try {
        await awaitMainUI(desktop.page, desktop.baseURL);

        const drawerClosed = await desktop.page
            .locator('#user-settings-button .drawer-icon.closedIcon')
            .count()
            .then((count) => count > 0);
        if (drawerClosed) {
            await desktop.page.locator('#user-settings-button .drawer-toggle').click();
        }
        await desktop.page.locator('#luker_open_external_links_in_browser').uncheck();

        const windowsBefore = desktop.electronApp.windows().length;

        await desktop.page.locator('#leftNavDrawerIcon').click();
        const link = desktop.page
            .locator('#left-nav-panel a[target="_blank"][href^="https://"]:visible')
            .first();
        await expect(link).toBeVisible();
        const href = await link.getAttribute('href');
        await link.click();

        // With the setting off the request stays in the app, so a window opens
        // instead of the system browser being handed the URL. The new window
        // still has to land on the link that was clicked.
        await expect.poll(() => desktop.electronApp.windows().length).toBe(windowsBefore + 1);
        const popup = desktop.electronApp.windows().find((page) => page !== desktop.page);
        await expect.poll(() => popup?.url() ?? '').toBe(href);
        expect(await openedExternally(desktop.electronApp)).toEqual([]);
    } finally {
        await desktop.close();
    }
});

test('a blank popup is never handed to the browser', async ({ resources }) => {
    const desktop = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'external-blank-popup',
        extraEnv: { LUKER_DESKTOP_SKIP_OPEN_EXTERNAL: '1' },
    });

    try {
        await awaitMainUI(desktop.page, desktop.baseURL);

        await desktop.page.evaluate(() => {
            const button = document.createElement('button');
            button.id = 'e2e-open-blank';
            button.textContent = 'e2e open blank';
            button.style.cssText = 'position: fixed; top: 4px; left: 4px; z-index: 2147483647;';
            button.addEventListener('click', () => {
                window.__e2eBlankHandle = window.open('about:blank', '_blank');
            });
            document.body.append(button);
        });
        const box = await desktop.page.locator('#e2e-open-blank').boundingBox();
        await desktop.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

        await expect
            .poll(() => desktop.page.evaluate(() => Boolean(window.__e2eBlankHandle)))
            .toBe(true);
        expect(await openedExternally(desktop.electronApp)).toEqual([]);
    } finally {
        await desktop.close();
    }
});

test('a feature popup opens as an app window that can talk to its opener', async ({ resources }) => {
    const desktop = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'external-popup',
        extraEnv: { LUKER_DESKTOP_SKIP_OPEN_EXTERNAL: '1' },
    });

    try {
        await awaitMainUI(desktop.page, desktop.baseURL);
        const windowsBefore = desktop.electronApp.windows().length;

        // No shipped page opens a window with window features, so the trigger is
        // injected; the click itself, and everything after it, is real.
        await desktop.page.evaluate(() => {
            window.__e2ePopupResult = null;
            window.addEventListener('message', (event) => {
                window.__e2ePopupResult = {
                    data: event.data,
                    sourceMatches: event.source === window.__e2ePopupHandle,
                };
            });
            const button = document.createElement('button');
            button.id = 'e2e-open-popup';
            button.textContent = 'e2e open popup';
            button.style.cssText = 'position: fixed; top: 4px; left: 4px; z-index: 2147483647;';
            button.addEventListener('click', () => {
                const popup = window.open('about:blank', 'e2e-popup', 'width=420,height=520');
                window.__e2ePopupHandle = popup;
                window.__e2ePopupOpenerMatches = popup.opener === window;
                popup.document.write(
                    '<script>window.opener.postMessage("popup-ready", "*");</script>',
                );
            });
            document.body.append(button);
        });

        const box = await desktop.page.locator('#e2e-open-popup').boundingBox();
        await desktop.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

        await expect
            .poll(() => desktop.page.evaluate(() => window.__e2ePopupResult !== null))
            .toBe(true);

        const result = await desktop.page.evaluate(() => ({
            openerPresent: window.__e2ePopupOpenerMatches,
            ...window.__e2ePopupResult,
        }));

        expect(result).toEqual({ openerPresent: true, data: 'popup-ready', sourceMatches: true });
        expect(desktop.electronApp.windows()).toHaveLength(windowsBefore + 1);
        expect(await openedExternally(desktop.electronApp)).toEqual([]);

        // An app window is a child of the main window, sized from the request.
        const popupWindow = await desktop.electronApp.evaluate(({ BrowserWindow }) => {
            const popup = BrowserWindow.getAllWindows().find(
                (window) => window.webContents.getURL() === 'about:blank',
            );
            if (!popup) {
                throw new Error('the popup window is gone');
            }
            const [width, height] = popup.getSize();
            return {
                hasParent: popup.getParentWindow() !== null,
                width,
                height,
            };
        });
        expect(popupWindow).toEqual({ hasParent: true, width: 420, height: 520 });
    } finally {
        await desktop.close();
    }
});

// A feature-bearing window request from the app page is a real popup: the
// page keeps the handle the authorization flow depends on. Even though the
// target is external, the request has to open inside the app instead of being
// handed to the system browser.
test('an external feature popup opens in an app window instead of the browser', async ({ resources }) => {
    const desktop = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'external-popup-external',
        extraEnv: { LUKER_DESKTOP_SKIP_OPEN_EXTERNAL: '1' },
    });

    const server = createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><meta charset="utf-8"><title>auth probe</title><p>auth probe</p>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const target = `http://127.0.0.1:${server.address().port}/auth`;

    try {
        await awaitMainUI(desktop.page, desktop.baseURL);
        const windowsBefore = desktop.electronApp.windows().length;

        await desktop.page.evaluate((url) => {
            const button = document.createElement('button');
            button.id = 'e2e-open-external-popup';
            button.textContent = 'e2e open external popup';
            button.style.cssText = 'position: fixed; top: 4px; left: 4px; z-index: 2147483647;';
            button.addEventListener('click', () => {
                window.open(url, 'e2e-external-popup', 'width=420,height=520');
            });
            document.body.append(button);
        }, target);

        const box = await desktop.page.locator('#e2e-open-external-popup').boundingBox();
        await desktop.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

        await expect.poll(() => desktop.electronApp.windows().length).toBe(windowsBefore + 1);
        await expect
            .poll(() => desktop.electronApp.windows().find((page) => page !== desktop.page)?.url() ?? '')
            .toBe(target);
        expect(await openedExternally(desktop.electronApp)).toEqual([]);
    } finally {
        await desktop.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

// A form post that opens a new window has to reach that window with its body
// intact. The system browser only receives a URL, so the request stays in the
// app even though its target is external.
test('a form post that opens a new window keeps its body in the app', async ({ resources }) => {
    const desktop = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'external-form-post-popup',
        extraEnv: { LUKER_DESKTOP_SKIP_OPEN_EXTERNAL: '1' },
    });

    const server = createServer((request, response) => {
        if (request.method !== 'POST') {
            response.writeHead(405, { 'Content-Type': 'text/plain' });
            response.end('post only');
            return;
        }
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(
                '<!doctype html><meta charset="utf-8"><title>posted</title>'
                + `<pre id="payload">${request.method} ${Buffer.concat(chunks).toString()}</pre>`,
            );
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const target = `http://127.0.0.1:${server.address().port}/submit`;

    try {
        await awaitMainUI(desktop.page, desktop.baseURL);
        const windowsBefore = desktop.electronApp.windows().length;

        await desktop.page.evaluate((action) => {
            const form = document.createElement('form');
            form.id = 'e2e-post-popup-form';
            form.method = 'post';
            form.target = '_blank';
            form.action = action;
            form.style.cssText = 'position: fixed; top: 4px; left: 4px; z-index: 2147483647;';
            const input = document.createElement('input');
            input.name = 'probe';
            input.value = 'luker-form-post';
            const submit = document.createElement('button');
            submit.type = 'submit';
            submit.id = 'e2e-submit-post-popup';
            submit.textContent = 'e2e submit post popup';
            form.append(input, submit);
            document.body.append(form);
        }, target);

        await desktop.page.locator('#e2e-submit-post-popup').click();

        await expect.poll(() => desktop.electronApp.windows().length).toBe(windowsBefore + 1);
        const popup = desktop.electronApp.windows().find((page) => page !== desktop.page);
        await expect.poll(() => popup?.url() ?? '').toBe(target);
        await expect(popup.locator('#payload')).toHaveText('POST probe=luker-form-post');
        expect(await openedExternally(desktop.electronApp)).toEqual([]);
    } finally {
        await desktop.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

// The window can be showing a page from another origin once external links are
// allowed to replace the app page. That page reaches the same preload bridge,
// so the installer has to check the sender frame before it downloads anything.
test('an external page cannot drive the desktop update installer', async ({ resources }) => {
    const desktop = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'external-update-sender',
        extraEnv: {
            LUKER_DESKTOP_SKIP_OPEN_EXTERNAL: '1',
            LUKER_DESKTOP_SKIP_OPEN_INSTALLER: '1',
        },
    });

    const server = createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><meta charset="utf-8"><title>outside the app</title><p>outside</p>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const serverUrl = `http://127.0.0.1:${server.address().port}/`;

    try {
        await awaitMainUI(desktop.page, desktop.baseURL);

        await desktop.electronApp.evaluate(
            ({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url),
            serverUrl,
        );
        await expect.poll(() => desktop.page.url()).toBe(serverUrl);

        const outcome = await desktop.page.evaluate(async () => {
            try {
                await window.LukerDesktop.installUpdateFromUrl('https://example.invalid/x', 'x');
                return { resolved: true, message: '' };
            } catch (error) {
                return { resolved: false, message: String(error?.message || error) };
            }
        });

        expect(outcome.resolved).toBe(false);
        expect(outcome.message).toContain('outside the app');
        expect(existsSync(join(desktop.userData, 'updates', 'x'))).toBe(false);

        const policyOutcome = await desktop.page.evaluate(async () => {
            try {
                await window.LukerDesktop.setOpenExternalLinksInBrowser(true);
                return 'resolved';
            } catch (error) {
                return String(error?.message || error);
            }
        });
        expect(policyOutcome).toContain('outside the app');
    } finally {
        await desktop.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

// A server redirect into a third-party sign-in page is admitted by the app
// window on purpose. Everything the admitted page then does — its own links,
// its own form posts — has to stay in that page: it is already showing, the
// app page is gone from the window, and the system browser would break the
// session mid-way. The window reaches that state through a programmatic load
// here because `will-navigate` does not fire for programmatic loads, which is
// exactly how the shell admits a redirect.
test('a page that is already outside the app keeps its own navigation in the window', async ({ resources }) => {
    const desktop = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'external-off-site-navigation',
        extraEnv: { LUKER_DESKTOP_SKIP_OPEN_EXTERNAL: '1' },
    });

    const target = 'https://example.invalid/e2e-off-site-navigate';
    const server = createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(
            '<!doctype html><meta charset="utf-8"><title>off site</title>'
            + `<a id="off-site-link" href="${target}">off site link</a>`,
        );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const serverUrl = `http://127.0.0.1:${server.address().port}/`;

    try {
        await awaitMainUI(desktop.page, desktop.baseURL);

        await desktop.electronApp.evaluate(
            ({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url),
            serverUrl,
        );
        await expect.poll(() => desktop.page.url()).toBe(serverUrl);

        // The shell's own `will-navigate` handler is registered first, so once
        // the click is recorded here the routing decision has already been
        // made. Without this a click that never became a navigation would pass
        // silently.
        await desktop.electronApp.evaluate(({ BrowserWindow }) => {
            const contents = BrowserWindow.getAllWindows()[0].webContents;
            const events = (globalThis.__lukerE2eNavigationEvents = []);
            contents.on('will-navigate', (_event, url) => events.push(url));
        });

        const box = await desktop.page.locator('#off-site-link').boundingBox();
        await desktop.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

        await expect
            .poll(() => desktop.electronApp.evaluate(() => globalThis.__lukerE2eNavigationEvents))
            .toEqual([target]);

        expect(await openedExternally(desktop.electronApp)).toEqual([]);
        expect(desktop.page.url()).toBe(serverUrl);
    } finally {
        await desktop.close();
        await new Promise((resolve) => server.close(resolve));
    }
});
