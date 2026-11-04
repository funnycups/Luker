// Account window e2e helpers — the floating window opened from
// User Settings → Account (public/scripts/account-window.js on top of
// luker-window.js). It holds the profile, sync, backup, restore, migrate,
// device settings, snapshots, storage, user management and reset pages.
//
// Every action is a real click on a real DOM element. Pages are found by
// the `data-view` of the page heading and controls by their `data-act` /
// `data-model`, which the window renders for its own event delegation.

import { expect } from '@playwright/test';

/** The open Account window (a `<dialog class="dw-layer">` in the top layer). */
export const accountWindow = page => page.locator('dialog.dw-layer[open] .dw-win');

/** Heading of the page shown in the window; its `data-view` names the page. */
export const pageHead = page => accountWindow(page).locator('.dw-pagehead');

/** Error text of the form on the current page. */
export const formError = page => accountWindow(page).locator('.dw-err');

/** In-window confirmation drawn by `LukerWindow.confirm`. */
export const windowConfirm = page => accountWindow(page).locator('.dw-modal');

/** Toast drawn inside the window. */
export const windowToast = (page, text, { error = false } = {}) => accountWindow(page)
    .locator(error ? '.dw-toast.error' : '.dw-toast:not(.error)', text === undefined ? {} : { hasText: text });

/** Open the User Settings drawer unless it is open already. */
export async function openUserSettingsDrawer(page) {
    const drawer = page.locator('#user-settings-button');
    await drawer.waitFor({ state: 'visible', timeout: 10_000 });
    const closed = await page.locator('#user-settings-block').evaluate(el => el.classList.contains('closedDrawer'));
    if (closed) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => !document.getElementById('user-settings-block')?.classList.contains('closedDrawer'), null, { timeout: 5_000 });
    }
}

/**
 * Open the Account window through User Settings → Account, unless it is
 * open already. Resolves once the window shows a page.
 */
export async function openAccountWindow(page) {
    if (await accountWindow(page).count() > 0) return;
    await openUserSettingsDrawer(page);
    await page.locator('#account_button').click();
    await pageHead(page).waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Show the root page of a tab of the Account window: click the tab in the
 * side navigation, then Back until the tab's first page shows.
 * @param {import('@playwright/test').Page} page
 * @param {string} tab profile, sync, backup, restore, migrate, settings, snapshots, storage, users or reset
 */
export async function openAccountTab(page, tab) {
    await openAccountWindow(page);
    const button = accountWindow(page).locator(`.dw-tab[data-tab="${tab}"]`);
    await button.click();
    await expect(button).toHaveAttribute('aria-selected', 'true');
    const back = pageHead(page).locator('[data-act="back"]');
    while (await back.count() > 0) await back.click();
}

/** Click the in-window confirmation's confirm (or cancel) button. */
export async function answerWindowConfirm(page, { confirm = true, text } = {}) {
    const modal = windowConfirm(page);
    await modal.waitFor({ state: 'visible', timeout: 10_000 });
    if (text !== undefined) await expect(modal).toContainText(text);
    // Another confirm can open right after this one, so wait on this element.
    const handle = await modal.elementHandle();
    await modal.locator(`[data-r="${confirm ? 1 : 0}"]`).click();
    await page.waitForFunction(el => !el.isConnected, handle, { timeout: 10_000 });
    await handle.dispose();
}

/**
 * Close the Account window with its close button, confirming the
 * "close anyway" question a running job asks.
 */
export async function closeAccountWindow(page) {
    if (await accountWindow(page).count() === 0) return;
    await accountWindow(page).locator('.dw-titlebar [data-act="close"]').click();
    const modal = windowConfirm(page);
    if (await modal.isVisible().catch(() => false)) await modal.locator('[data-r="1"]').click();
    await expect(page.locator('dialog.dw-layer')).toHaveCount(0, { timeout: 10_000 });
}

/**
 * Open the user management page (admin only) of the Account window, from
 * User Settings → Admin Panel.
 */
export async function openUserManagement(page) {
    if (await accountWindow(page).count() > 0) {
        await openAccountTab(page, 'users');
    } else {
        await openUserSettingsDrawer(page);
        const adminButton = page.locator('#admin_button');
        await adminButton.waitFor({ state: 'visible', timeout: 10_000 });
        await adminButton.click();
        await expect(pageHead(page)).toHaveAttribute('data-view', 'users', { timeout: 10_000 });
    }
    await showAdminSegment(page, 'users');
    // The user list loads after the page opens.
    await accountWindow(page).locator('[data-act="adm-user"]').first().waitFor({ state: 'visible', timeout: 15_000 });
}

/** Switch the user management page between its Users and Server segments. */
export async function showAdminSegment(page, seg) {
    const button = accountWindow(page).locator(`[data-act="adm-seg"][data-seg="${seg}"]`);
    await button.click();
    await expect(button).toHaveAttribute('aria-selected', 'true');
}

/**
 * Open one of the server pages listed on the user management page.
 * @param {import('@playwright/test').Page} page
 * @param {'adminOverview'|'adminSecurity'|'adminAuth'|'adminNotices'|'adminPlugins'|'adminConfig'|'adminBackend'|'adminStorage'} view
 */
export async function openAdminPage(page, view) {
    await openUserManagement(page);
    await showAdminSegment(page, 'server');
    await accountWindow(page).locator(`[data-act="adm-push"][data-view="${view}"]`).click();
    await expect(pageHead(page)).toHaveAttribute('data-view', view, { timeout: 10_000 });
}

/** Open the detail page of a user from the user management list. */
export async function openAdminUser(page, handle) {
    await openUserManagement(page);
    await accountWindow(page).locator(`[data-act="adm-user"][data-handle="${handle}"]`).first().click();
    await expect(pageHead(page)).toHaveAttribute('data-view', 'adminUser', { timeout: 10_000 });
}

/**
 * Open Account → Storage on the server or browser inspector and wait for
 * it to finish its first load. Returns the inspector container.
 * @param {import('@playwright/test').Page} page
 * @param {'server'|'browser'} kind
 */
export async function openStorageInspectorPage(page, kind) {
    await openAccountTab(page, 'storage');
    const seg = accountWindow(page).locator(`[data-act="storage-kind"][data-kind="${kind}"]`);
    await seg.click();
    await expect(seg).toHaveAttribute('aria-selected', 'true');
    const inspector = accountWindow(page).locator('.dw-inspector .storageInspectorContainer').first();
    await inspector.waitFor({ state: 'visible', timeout: 10_000 });
    await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });
    return inspector;
}
