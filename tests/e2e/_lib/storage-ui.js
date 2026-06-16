// Helpers for storage-backend admin UI flow in Playwright e2e specs.
//
// All three storage specs (sanity-sqlite, migrate-fs-to-sqlite,
// migrate-sqlite-to-fs) drive the same UI sequence to swap engines:
//   1. Open Admin Panel popup
//   2. Click the Storage Backend tab
//   3. Choose a target radio
//   4. Click Migrate Now
//   5. Accept the confirm popup
//   6. Wait for the toast / for the status panel to report the new mode
//
// The flow runs ENTIRELY through the live UI — no direct fetches, no
// JS-level shortcuts — so a regression in any of the admin-panel
// renderers, the popup component, or the status endpoint would surface
// here, exactly like a real admin would observe it.

import { expect } from '@playwright/test';

/**
 * Run the migration to the requested mode through the actual admin UI
 * affordances. Returns the post-migration status object as reported by
 * `/api/users/storage/status` (which is itself fetched via the same
 * admin-panel re-render, but exposed via the storage endpoint for
 * deterministic assertions on call sites).
 *
 * Pre: the test has reached the main UI on a server booted in the
 * opposite mode and currentUser.admin is truthy (single-user mode
 * is automatically admin).
 *
 * @param {import('@playwright/test').Page} page
 * @param {'fs' | 'sqlite'} targetMode
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] Migration wall time. Includes a
 *   user fixture with no chat data, so 60s is generous.
 */
export async function migrateViaAdminUI(page, targetMode, { timeoutMs = 60_000 } = {}) {
    // 0. The admin button lives inside the User Settings drawer
    //    (`#user-settings-button`), which is collapsed by default. Open
    //    the drawer first via its toggle so the admin button becomes
    //    visible and clickable.
    const settingsDrawer = page.locator('#user-settings-button');
    await settingsDrawer.waitFor({ state: 'visible', timeout: 10_000 });
    const drawerClosed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count().then(n => n > 0);
    if (drawerClosed) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        // Wait for the drawer to open by checking the drawer-content stops being closed.
        await page.waitForFunction(() => {
            const el = document.getElementById('user-settings-block');
            return el && !el.classList.contains('closedDrawer');
        }, { timeout: 5_000 });
    }

    // 1. Open the admin panel popup.
    const adminButton = page.locator('#admin_button');
    await adminButton.waitFor({ state: 'visible', timeout: 10_000 });
    await adminButton.click();

    // 2. Click the Storage Backend tab. The popup template uses
    //    `data-target-tab="storageBackendTab"` on the nav button — match
    //    that exact element so we don't grab a stale popup from a
    //    prior open/close cycle.
    const storageTabBtn = page.locator('button[data-target-tab="storageBackendTab"]').last();
    await storageTabBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await storageTabBtn.click();

    // The Storage Backend section is now visible. Wait for status to
    // load (Current Mode field flips from "Loading..." to a concrete value).
    const currentModeEl = page.locator('.storageBackendCurrentMode').last();
    await expect(currentModeEl).not.toHaveText(/Loading/i, { timeout: 10_000 });

    // 3. Pick the target radio. The other one is auto-disabled by
    //    renderStorageBackend() when it matches the current mode.
    const targetRadio = page.locator(`.storageBackendTargetMode[value="${targetMode}"]`).last();
    await targetRadio.waitFor({ state: 'visible', timeout: 5_000 });
    await targetRadio.click();

    // 4. Click Migrate Now. This pops a CONFIRM dialog.
    const migrateButton = page.locator('.storageBackendMigrateButton').last();
    await migrateButton.click();

    // 5. The confirm popup is the top-most popup in the DOM — when
    //    callGenericPopup opens a CONFIRM on top of the admin panel
    //    popup, it gets appended as a sibling `<dialog class="popup">`.
    //    Match its OK button via :last-of-type so we don't click the
    //    admin panel's "Close" button.
    const confirmOk = page.locator('dialog.popup .popup-button-ok').last();
    await confirmOk.waitFor({ state: 'visible', timeout: 5_000 });
    await confirmOk.click();

    // 6. Wait for the panel to repaint with the new current mode (the
    //    migrate handler calls renderStorageBackend() in its finally
    //    block on completion). We re-locate the element because the
    //    admin panel re-renders the section.
    await expect(currentModeEl).toHaveText(new RegExp(`^${targetMode}$`, 'i'), { timeout: timeoutMs });
}

/**
 * Close the admin panel popup by clicking its top-level Close button,
 * leaving the chat UI accessible again.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function closeAdminPanel(page) {
    // The admin panel popup's own OK button reads "Close" (set via the
    // openAdminPanel callGenericPopup options); it's the last visible
    // .popup-button-ok in the DOM after any nested popups have closed.
    const closeBtn = page.locator('dialog.popup .popup-button-ok').last();
    await closeBtn.click({ trial: false }).catch(() => { /* already closed */ });
}

/**
 * Fetch storage status by directly exercising the admin endpoint. Useful
 * for pre-test assertions ("server actually booted in mode X") and for
 * verifying mode AFTER the page has been navigated away from the admin
 * panel. CSRF token is read from the page via getRequestHeaders so this
 * works inside a regular logged-in single-user session.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ currentMode: 'fs'|'sqlite', readOnly: boolean, lastMigration: string|null, migrationInProgress: boolean }>}
 */
export async function fetchStorageStatus(page) {
    return page.evaluate(async () => {
        const mod = await import('/script.js').catch(() => null);
        const headers = (typeof mod?.getRequestHeaders === 'function')
            ? mod.getRequestHeaders()
            : { 'Content-Type': 'application/json' };
        const res = await fetch('/api/users/storage/status', { method: 'POST', headers });
        if (!res.ok) throw new Error(`storage/status failed: ${res.status}`);
        return res.json();
    });
}
