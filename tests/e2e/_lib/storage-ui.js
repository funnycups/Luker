// Helpers for storage-backend admin UI flow in Playwright e2e specs.
//
// The storage specs (sanity-sqlite, migrate-fs-to-sqlite,
// migrate-sqlite-to-fs, ...) drive the same UI sequence to swap engines:
//   1. Open user management in the Account window (#admin_button)
//   2. Open Server → Storage Backend
//   3. Choose a target mode
//   4. Click Migrate Now
//   5. Accept the in-window confirm
//   6. Wait for the page to report the new current mode
//
// The flow runs ENTIRELY through the live UI — no direct fetches, no
// JS-level shortcuts — so a regression in any of the admin page
// renderers, the confirm, or the status endpoint would surface here,
// exactly like a real admin would observe it.

import { expect } from '@playwright/test';
import { accountWindow, answerWindowConfirm, closeAccountWindow, openAdminPage } from './account-window.js';

/**
 * Run the migration to the requested mode through the actual admin UI
 * affordances.
 *
 * Pre: the test has reached the main UI on a server booted in the
 * opposite mode and currentUser.admin is truthy (single-user mode
 * is automatically admin).
 *
 * @param {import('@playwright/test').Page} page
 * @param {'fs' | 'sqlite' | 'mysql' | 'postgres'} targetMode
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] Migration wall time. Includes a
 *   user fixture with no chat data, so 60s is generous.
 */
export async function migrateViaAdminUI(page, targetMode, { timeoutMs = 60_000 } = {}) {
    // 1-2. Open Server → Storage Backend; the status loads after the page opens.
    await openAdminPage(page, 'adminBackend');
    const win = accountWindow(page);
    const currentModeEl = win.locator('[data-current-mode]');
    await currentModeEl.waitFor({ state: 'visible', timeout: 10_000 });

    // 3. Pick the target. The current mode is disabled.
    const target = win.locator(`[data-act="adm-backend-target"][data-mode="${targetMode}"]`);
    await target.click();
    await expect(target).toHaveClass(/\bon\b/);

    // 4-5. Migrate Now asks for confirmation inside the window.
    await win.locator('[data-act="adm-migrate"]').click();
    await answerWindowConfirm(page);

    // 6. The page reloads the status when the migration finishes.
    await expect(currentModeEl).toHaveAttribute('data-current-mode', targetMode, { timeout: timeoutMs });
}

/**
 * Close the Account window that holds user management, leaving the chat
 * UI accessible again.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function closeAdminPanel(page) {
    await closeAccountWindow(page);
}

/**
 * Fetch storage status by directly exercising the admin endpoint. Useful
 * for pre-test assertions ("server actually booted in mode X") and for
 * verifying mode AFTER the page has been navigated away from the admin
 * panel. CSRF token is read from the page via getRequestHeaders so this
 * works inside a regular logged-in single-user session.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ currentMode: 'fs'|'sqlite'|'mysql'|'postgres', readOnly: boolean, lastMigration: string|null, migrationInProgress: boolean }>}
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
