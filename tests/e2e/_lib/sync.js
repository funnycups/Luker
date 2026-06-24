// LAN Sync e2e helpers — open the panel, drive pair/sync/forget flows,
// extract pairing URLs from the readonly text field.
//
// Per `feedback_e2e_real_user_flow`: every action is a real click on a
// real DOM element. Two real `startServer` instances stand up two
// independent Luker processes on distinct loopback ports / data dirs;
// the helper drives the UI on whichever one the caller's `page` is on.
//
// Outcome model: every sync action resolves to one of three terminal
// states the UI exposes on the status banner:
//   - `success`  — `runPull` completed; reconcile already wrote to disk
//   - `warning`  — conflicts surfaced; conflict panel is now visible
//   - `error`    — peer unreachable / auth fail / etc.
// Helpers return the actual outcome so the caller can branch instead of
// guessing. The interim `info` banner (`Syncing…`) is not a terminal
// state and helpers wait past it.

import { expect } from '@playwright/test';

/**
 * Real `/login` form login for multi-user specs. Selects the named user
 * card (or fills the discreet handle input), types the password, clicks
 * Login, waits for the SPA to come up.
 *
 * Mirrors the `loginViaForm` extracted in `personas/105-…` so both the
 * personas suite and the sync suite drive the same path. Keep this in
 * sync with that copy if either diverges.
 */
export async function loginAs(page, baseURL, { handle, password }) {
    await page.goto(`${baseURL}/login`);
    // Settle on the login form OR auto-redirect to /.
    await page.waitForFunction(() => {
        if (document.querySelector('#preloader') !== null) {
            return /\/(login)?$/.test(location.pathname) || location.pathname === '/';
        }
        const list = document.querySelector('#userList');
        const handleBlock = document.querySelector('#handleEntryBlock');
        if (location.pathname === '/' || location.pathname === '') return true;
        return list && (list.children.length > 0 || (handleBlock && handleBlock.style.display !== 'none'));
    }, { timeout: 30_000 });

    const onMain = await page.evaluate(() => location.pathname === '/' || location.pathname === '');
    if (!onMain) {
        const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const card = page.locator('#userList .userSelect').filter({
            has: page.locator('.userHandle', { hasText: new RegExp(`^${escapeRegex(handle)}$`) }),
        }).first();
        const cardVisible = await card.isVisible({ timeout: 1500 }).catch(() => false);
        if (cardVisible) {
            await card.click();
        } else {
            const handleInput = page.locator('#userHandle');
            await handleInput.waitFor({ state: 'visible', timeout: 5000 });
            await handleInput.fill(handle);
        }
        const passwordInput = page.locator('#userPassword');
        if (await passwordInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            await passwordInput.fill(password);
            const loginBtn = page.locator('#loginButton');
            if (await loginBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                await loginBtn.click();
            }
        }
    }

    await page.waitForFunction(() => document.getElementById('preloader') === null, { timeout: 60_000 });
    await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });
}

/**
 * Assert the LAN Sync status banner shows the handle-mismatch error
 * with BOTH the expected handle (the user's own) and the got handle
 * (the peerId prefix from the link). The exact English text comes from
 * `lan-sync.js` via the `t` tagged template and contains both names in
 * order: "This pairing link is for ${got}, but you're logged in as ${expected}."
 *
 * Locale-neutral: we look for the literal substrings of both handles in
 * the rendered banner text, which survives translation as long as the
 * translator preserves the two `${0}` / `${1}` placeholders verbatim.
 */
export async function expectHandleMismatchToast(page, { expectedHandle, gotHandle }) {
    const banner = page.locator('.lanSyncStatusBanner.error').first();
    await banner.waitFor({ state: 'visible', timeout: 10_000 });
    const text = (await banner.innerText()).trim();
    expect(text, 'banner must contain the link handle').toContain(gotHandle);
    expect(text, 'banner must contain the local handle').toContain(expectedHandle);
}

/**
 * Open Settings → Account → Backup & Restore → LAN Sync.
 *
 * Multi-step popup navigation: User Settings drawer → Account button →
 * Backup & Restore button → LAN Sync button. Each of the inner popups is
 * a `callGenericPopup` modal, so the locators target the actively-visible
 * dialog body.
 *
 * Drawer toggle is idempotent across runs: if a previous step left the
 * User Settings drawer open (e.g. closeAdminPanel only dismisses the
 * popup, not the drawer behind it), a click would TOGGLE it shut. We
 * check the drawer's `closedDrawer` class first and only click when it's
 * actually closed.
 */
export async function openLanSyncPanel(page) {
    const drawerContent = page.locator('#user-settings-button .drawer-content');
    const isClosed = await drawerContent.evaluate((el) => el.classList.contains('closedDrawer'));
    if (isClosed) {
        await page.locator('#user-settings-button .drawer-toggle').click();
    }
    await page.locator('#account_button').click();
    await page.locator('.userBackupButton').first().click();
    await page.locator('.backupLanSyncOpenButton').click();
    await page.locator('.userLanSync').waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Resolve to one of: 'success' | 'warning' | 'error'. The interim 'info'
 * state (which renders during the in-flight fetch) is not terminal and
 * is waited past — without this, helpers would resolve the moment
 * `Syncing…` shows up and try to assert against an unfinished sync.
 *
 * Polled rather than waited-on because waitForFunction's expression
 * cannot read jQuery-mediated class manipulations until they've
 * propagated to the DOM, which `showStatusBanner` does synchronously
 * but inside an async fetch chain — polling is the simpler primitive.
 */
async function waitForTerminalBannerState(page, timeoutMs = 30_000) {
    const state = await page.waitForFunction(() => {
        const el = document.querySelector('.lanSyncStatusBanner');
        if (!el || el.classList.contains('displayNone')) return null;
        for (const kind of ['success', 'warning', 'error']) {
            if (el.classList.contains(kind)) return kind;
        }
        return null;  // still 'info' or transitioning — keep polling
    }, null, { timeout: timeoutMs });
    return /** @type {'success' | 'warning' | 'error'} */ (await state.jsonValue());
}

/**
 * Generate a pairing link on `page` (which is on Device A). Returns the
 * `luker-sync://...` URL. `label` is what A will call B in its own peers
 * list once B accepts.
 */
export async function generatePairingLink(page, { label, categories }) {
    await page.locator('.lanSyncTabPairNew').click();
    await page.locator('.lanSyncPairLabel').fill(label);
    // Toggle only the requested categories on. The label.click() pattern
    // would simulate a user gesture but jQuery's checkbox-in-label
    // re-toggles on bubble; setting `.checked` directly is the cleaner
    // test-only path (the click handler on the label fires on Generate,
    // which reads the live `.checked` state via :checked anyway).
    await page.evaluate((cats) => {
        document.querySelectorAll('.lanSyncCategoryGrid input[name="lanSyncCategory"]').forEach((el) => {
            const input = /** @type {HTMLInputElement} */ (el);
            input.checked = cats.includes(input.value);
        });
    }, categories);
    await page.locator('.lanSyncGenerateLinkButton').click();
    await page.locator('.lanSyncPairNewResult').waitFor({ state: 'visible', timeout: 10_000 });
    const link = await page.locator('.lanSyncGeneratedLink').inputValue();
    expect(link).toMatch(/^luker-sync:/);
    return link;
}

/**
 * Paste a pairing link into B's "Pair with existing device" tab and click
 * Pair and sync. Returns the terminal banner state ('success' | 'warning'
 * | 'error') so the caller can branch: 'warning' means conflicts are
 * waiting in the conflict panel; 'success' means the sync landed cleanly.
 *
 * The URL-paste handler in `lan-sync.js` is bound to `'input'`, which
 * `.fill` already fires on Playwright (`page.fill` triggers input AND
 * change). The explicit `dispatchEvent('input')` is a belt-and-suspenders
 * for browser engines where fill semantics are inconsistent.
 *
 * `localLabel` overrides the auto-populated label so the test can call
 * the OTHER device whatever makes sense locally (typically the opposite
 * of what the URL contained, since the URL embeds the GENERATOR's idea
 * of what the receiver is called).
 *
 * `peerAuth` (optional `{ username, password }`) is typed into the basic-
 * auth fields on the Accept form for specs that pair across multi-user
 * Luker installs where /api routes are basic-auth-gated. Pass `null` (or
 * leave the field off) when the peer is a single-user / no-auth install.
 */
export async function acceptPairingLink(page, link, { categories, localLabel, peerAuth = null }) {
    await page.locator('.lanSyncTabPairExisting').click();
    await page.locator('.lanSyncAcceptLink').fill(link);
    await page.locator('.lanSyncAcceptLink').dispatchEvent('input');
    if (localLabel) {
        await page.locator('.lanSyncAcceptLabel').fill(localLabel);
    }
    if (peerAuth?.username) {
        await page.locator('.lanSyncAcceptUsername').fill(peerAuth.username);
    }
    if (peerAuth?.password) {
        await page.locator('.lanSyncAcceptPassword').fill(peerAuth.password);
    }
    await page.evaluate((cats) => {
        document.querySelectorAll('.lanSyncAcceptCategoryGrid input[name="lanSyncCategory"]').forEach((el) => {
            const input = /** @type {HTMLInputElement} */ (el);
            input.checked = cats.includes(input.value);
        });
    }, categories);
    await page.locator('.lanSyncAcceptButton').click();
    return waitForTerminalBannerState(page);
}

/**
 * Click "Sync now" against the named peer in the My devices list.
 * Returns the terminal banner state — same shape as `acceptPairingLink`.
 */
export async function clickSyncNow(page, peerLabel) {
    await page.locator('.lanSyncTabPeers').click();
    const row = page.locator('.lanSyncPeerRow', { hasText: peerLabel });
    await row.locator('.lanSyncPeerSyncButton').click();
    return waitForTerminalBannerState(page);
}

/**
 * Pick the same side ('ours' | 'theirs') for every visible conflict row,
 * then click Apply resolutions. Returns the post-Apply terminal banner
 * state — typically 'success', but the caller can check for 'error' if a
 * resolution-time failure (peer disconnected, etc.) is plausible.
 *
 * Uses Playwright's `.check()` which dispatches a real click — important
 * because the conflict UI's pre-checked "ours" radio means a synthetic
 * `.checked = true` on the "theirs" radio would silently fail to clear
 * the "ours" one in the same radio group.
 */
export async function resolveAllConflictsAs(page, side) {
    const radios = page.locator(`.lanSyncConflictRow input[type="radio"][value="${side}"]`);
    const count = await radios.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
        await radios.nth(i).check();
    }
    await page.locator('.lanSyncApplyResolutionsButton').click();
    return waitForTerminalBannerState(page);
}

/**
 * Pick per-file resolutions. Each entry: filepath → 'ours' | 'theirs'.
 * Returns the post-Apply terminal banner state.
 */
export async function applyConflictResolutions(page, picks) {
    for (const [filepath, side] of Object.entries(picks)) {
        const row = page.locator('.lanSyncConflictRow', { hasText: filepath });
        await row.locator(`input[type="radio"][value="${side}"]`).check();
    }
    await page.locator('.lanSyncApplyResolutionsButton').click();
    return waitForTerminalBannerState(page);
}

/**
 * List the filepaths of every currently-rendered conflict row. Useful for
 * asserting "the right files conflicted" before picking resolutions.
 */
export async function listConflictFilepaths(page) {
    return page.evaluate(() => {
        const out = [];
        document.querySelectorAll('.lanSyncConflictRow .lanSyncConflictTitle').forEach((el) => {
            out.push((el.textContent || '').trim());
        });
        return out;
    });
}

/**
 * Read the "kind" annotation on each conflict row. Returns a map of
 * filepath → kind ('bothModified' | 'deleteByUs' | 'deleteByTheirs').
 * The kind label in the DOM is `Type: <kind>` — we strip the prefix.
 */
export async function listConflictKinds(page) {
    return page.evaluate(() => {
        /** @type {Record<string, string>} */
        const out = {};
        document.querySelectorAll('.lanSyncConflictRow').forEach((row) => {
            const title = row.querySelector('.lanSyncConflictTitle')?.textContent?.trim() || '';
            const kindNode = row.querySelector('.menu_button_note');
            const kindText = kindNode?.textContent?.trim() || '';
            // Format: "Type: <kind>" — strip the prefix tolerant of locale.
            const match = kindText.match(/[:：]\s*(\S+)/);
            if (title && match) out[title] = match[1];
        });
        return out;
    });
}

/**
 * Click "Undo last sync" against the named peer and confirm the popup.
 * Returns the terminal banner state.
 */
export async function clickUndoLastSync(page, peerLabel) {
    await page.locator('.lanSyncTabPeers').click();
    const row = page.locator('.lanSyncPeerRow', { hasText: peerLabel });
    await row.locator('.lanSyncPeerUndoButton').click();
    // The confirm popup is a sibling `callGenericPopup`; its OK button has
    // the standard `.popup-button-ok` class.
    await page.locator('.popup-button-ok').last().click();
    return waitForTerminalBannerState(page);
}

/**
 * Click "Forget" against the named peer, confirm the popup, and wait for
 * the row to disappear from the My devices list.
 */
export async function clickForgetPeer(page, peerLabel) {
    await page.locator('.lanSyncTabPeers').click();
    const row = page.locator('.lanSyncPeerRow', { hasText: peerLabel });
    await row.locator('.lanSyncPeerForgetButton').click();
    await page.locator('.popup-button-ok').last().click();
    await row.waitFor({ state: 'detached', timeout: 10_000 });
}

/**
 * Read the list of peers currently displayed in the My devices tab.
 * Returns an array of { label } objects — extend as more columns get
 * exposed.
 */
export async function listPeers(page) {
    await page.locator('.lanSyncTabPeers').click();
    return page.evaluate(() => {
        const out = [];
        document.querySelectorAll('.lanSyncPeerRow').forEach((row) => {
            const label = row.querySelector('.lanSyncPeerLabel')?.textContent?.trim() || '';
            if (label) out.push({ label });
        });
        return out;
    });
}
