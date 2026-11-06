// Sync e2e helpers — drive the Sync pages of the Account window
// (public/scripts/data-window.js): pair, sync, undo, remove, S3 storage,
// device settings and the Sync issues page that replaced the sync popup.
//
// Per `feedback_e2e_real_user_flow`: every action is a real click on a
// real DOM element. Two real `startServer` instances stand up two
// independent Luker processes on distinct loopback ports / data dirs;
// the helper drives the UI on whichever one the caller's `page` is on.
//
// Outcome model: every sync action resolves to one of three terminal
// states the window shows in the result banner of the Sync page:
//   - `success`  — the sync finished and wrote the merged files to disk
//   - `warning`  — the sync recorded conflicts or kept files it could not
//                  update; they wait on the Sync issues page
//   - `error`    — peer unreachable / auth fail / etc.
// Helpers return the actual outcome so the caller can branch instead of
// guessing.

import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import git from 'isomorphic-git';

import { matchGatedRoute } from '../../../src/sync/in-progress-gate.js';
import { completeOnboarding } from './page.js';
import { accountWindow, answerWindowConfirm, closeAccountWindow, formError, openAccountTab, pageHead, windowConfirm, windowToast } from './account-window.js';

export { accountWindow, pageHead } from './account-window.js';

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

    await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext
        && performance.getEntriesByName('[init] complete').length > 0, null, { timeout: 60_000 });
    await completeOnboarding(page);
}

/**
 * Assert the pairing form shows the handle-mismatch error with BOTH the
 * expected handle (the user's own) and the got handle (the peerId prefix
 * from the link).
 *
 * Locale-neutral: we look for the literal substrings of both handles in
 * the rendered error text, which survives translation as long as the
 * translator preserves the placeholders verbatim.
 */
export async function expectHandleMismatchToast(page, { expectedHandle, gotHandle }) {
    const error = formError(page);
    await error.waitFor({ state: 'visible', timeout: 10_000 });
    const text = (await error.innerText()).trim();
    expect(text, 'error must contain the link handle').toContain(gotHandle);
    expect(text, 'error must contain the local handle').toContain(expectedHandle);
}

/**
 * Open User Settings → Account and show the Sync page with the list of
 * sync backends. Reuses the open Account window and goes back to the list
 * from any page under Sync.
 */
export async function openLanSyncPanel(page) {
    const fresh = await accountWindow(page).count() === 0;
    const loaded = fresh ? page.waitForResponse(r => new URL(r.url()).pathname === '/api/sync/v1/backends' && r.request().method() === 'GET', { timeout: 30_000 }).catch(() => null) : null;
    await openAccountTab(page, 'sync');
    await expect(pageHead(page)).toHaveAttribute('data-view', 'list');
    await loaded;
}

/** The card of a sync backend on the Sync page, by its label. */
export const backendCard = (page, label) => accountWindow(page).locator('.dw-card[data-backend]')
    .filter({ has: page.locator('.dw-card-name', { hasText: label }) });

/** Result banner of the last sync action on the Sync page. */
export const syncFlash = page => accountWindow(page).locator('[data-flash]');

/** Remove the result banner of an earlier action so the next one is not mistaken for it. */
async function clearFlash(page) {
    const close = syncFlash(page).locator('[data-act="flash-x"]');
    if (await close.count() > 0) await close.first().click();
    await expect(syncFlash(page)).toHaveCount(0);
}

/**
 * Wait for the result of a sync action: the result banner of the Sync
 * page ('success' | 'warning' | 'error') or the error of the form the
 * action was started from ('error').
 */
async function waitForSyncOutcome(page, timeoutMs = 30_000) {
    const state = await page.waitForFunction(() => {
        const win = document.querySelector('dialog.dw-layer[open] .dw-win');
        if (!win) return null;
        if (win.querySelector('.dw-err')) return 'error';
        return win.querySelector('[data-flash]')?.dataset.flash || null;
    }, null, { timeout: timeoutMs });
    return /** @type {'success' | 'warning' | 'error'} */ (await state.jsonValue());
}

/** Open the menu of a backend card and click one of its entries (`data-act`). */
export async function clickBackendMenu(page, label, act) {
    await openLanSyncPanel(page);
    const card = backendCard(page, label);
    await card.locator('[data-act="menu"]').click();
    await card.locator(`.dw-menu [data-act="${act}"]`).click();
}

/**
 * Select exactly `wanted` in a sync content picker, one click per chip
 * like a user. `scope` is a locator holding the picker (the Account
 * window); `set` narrows it to one picker (pairNew, pairExist, s3, lanEdit).
 */
export async function selectCategories(scope, wanted, set) {
    const selector = `[data-act="cat"]${set ? `[data-set="${set}"]` : ''}`;
    await scope.locator(selector).first().waitFor({ state: 'visible', timeout: 10_000 });
    const ids = await scope.locator(selector).evaluateAll(chips => chips.map(chip => chip.dataset.id));
    for (const id of ids) {
        const chip = scope.locator(`${selector}[data-id="${id}"]`);
        const on = await chip.evaluate(el => el.classList.contains('on'));
        if (on === wanted.includes(id)) continue;
        await chip.click();
        if (wanted.includes(id)) await expect(chip).toHaveClass(/\bon\b/);
        else await expect(chip).not.toHaveClass(/\bon\b/);
    }
}

/** Open Sync → Add → one of the add options (pairNew, pairExist, s3). */
export async function openAddBackend(page, view) {
    await openLanSyncPanel(page);
    await accountWindow(page).locator('[data-act="push"][data-view="add"]').first().click();
    await accountWindow(page).locator(`.dw-option[data-view="${view}"]`).click();
    await expect(pageHead(page)).toHaveAttribute('data-view', view);
}

/** The readonly pairing link field shown after a link is generated. */
export const pairingLinkField = page => accountWindow(page).locator('.dw-linkbox input[readonly]');

/**
 * Generate a pairing link on `page` (which is on Device A). Returns the
 * `luker-sync://...` URL. `label` is what A will call B in its own sync
 * list once B accepts. The window stays on the generated link.
 */
export async function generatePairingLink(page, { label, categories }) {
    await openAddBackend(page, 'pairNew');
    await accountWindow(page).locator('[data-model="top.label"]').fill(label);
    await selectCategories(accountWindow(page), categories, 'pairNew');
    await accountWindow(page).locator('[data-act="pair-gen"]').click();
    await pairingLinkField(page).waitFor({ state: 'visible', timeout: 10_000 });
    const link = await pairingLinkField(page).inputValue();
    expect(link).toMatch(/^luker-sync:/);
    return link;
}

/**
 * Fill the "Connect to another device" form with a pairing link without
 * submitting it. Pasting the link fills the address, device ID, name and
 * sync content; `localLabel` and `peerAuth` are typed into the manual
 * section afterwards.
 */
export async function fillPairingForm(page, link, { categories, localLabel, peerAuth = null } = {}) {
    await openAddBackend(page, 'pairExist');
    const win = accountWindow(page);
    await win.locator('[data-model="top.form.link"]').fill(link);
    if (categories) await selectCategories(win, categories, 'pairExist');
    if (localLabel || peerAuth?.username || peerAuth?.password) {
        const more = win.locator('details:has(summary.dw-more)');
        if (!await more.evaluate(el => el.open)) await more.locator('summary.dw-more').click();
        if (localLabel) await win.locator('[data-model="top.form.label"]').fill(localLabel);
        if (peerAuth?.username) await win.locator('[data-model="top.form.user"]').fill(peerAuth.username);
        if (peerAuth?.password) await win.locator('[data-model="top.form.pass"]').fill(peerAuth.password);
    }
}

/**
 * Paste a pairing link into B's "Connect to another device" form and click
 * Pair and sync. Returns 'success' | 'warning' | 'error' so the caller can
 * branch: 'warning' means the first sync left conflicts or files it could
 * not update (they wait on the Sync issues page); 'error' means the pairing
 * or its first sync failed.
 *
 * `localLabel` overrides the label taken from the link so the test can call
 * the OTHER device whatever makes sense locally.
 *
 * `peerAuth` (optional `{ username, password }`) is typed into the login
 * fields of the form for specs that pair across multi-user Luker installs
 * where /api routes are basic-auth-gated.
 */
export async function acceptPairingLink(page, link, { categories, localLabel, peerAuth = null }) {
    await fillPairingForm(page, link, { categories, localLabel, peerAuth });
    await accountWindow(page).locator('[data-act="pair-accept"]').click();
    const outcome = await waitForSyncOutcome(page);
    // A warning after pairing means it was saved but the first sync failed.
    if (outcome !== 'success') return 'error';
    const attention = await page.evaluate(async () => {
        const status = await (await fetch('/api/sync/v1/status', { credentials: 'same-origin' })).json();
        return (status.conflicts?.length ?? 0) > 0
            || Object.values(status.backends ?? {}).some(backend => backend.lastSync?.stalled?.length);
    });
    return attention ? 'warning' : 'success';
}

/**
 * Click "Sync now" on the card of the named backend. Returns the result
 * banner state: 'success', 'warning' (conflicts or files not updated) or
 * 'error'.
 */
export async function clickSyncNow(page, peerLabel, timeoutMs = 30_000) {
    await openLanSyncPanel(page);
    await clearFlash(page);
    await backendCard(page, peerLabel).locator('[data-act="sync-now"]').click();
    return waitForSyncOutcome(page, timeoutMs);
}

/**
 * Click "Undo last sync" in the menu of the named backend and confirm.
 * Returns the result banner state.
 */
export async function clickUndoLastSync(page, peerLabel) {
    await openLanSyncPanel(page);
    await clearFlash(page);
    await clickBackendMenu(page, peerLabel, 'undo');
    await answerWindowConfirm(page);
    return waitForSyncOutcome(page);
}

/**
 * Click "Remove" in the menu of the named backend, confirm, and wait for
 * its card to disappear from the Sync page.
 */
export async function clickForgetPeer(page, peerLabel) {
    await clickBackendMenu(page, peerLabel, 'remove');
    await answerWindowConfirm(page);
    await expect(backendCard(page, peerLabel)).toHaveCount(0, { timeout: 10_000 });
}

/**
 * Read the backends listed on the Sync page. Returns an array of
 * { label } objects — extend as more columns get exposed.
 */
export async function listPeers(page) {
    await openLanSyncPanel(page);
    return accountWindow(page).locator('.dw-card[data-backend] .dw-card-name')
        .evaluateAll(names => names.map(name => ({ label: name.textContent.trim() })).filter(peer => peer.label));
}

/**
 * Close the Account window and every Luker popup, newest first. The window
 * can open again by itself when a status check finds sync issues, so this
 * repeats until nothing is open.
 */
export async function closeAllPopups(page) {
    const popups = page.locator('dialog.popup[open]');
    for (let round = 0; round < 20; round++) {
        if (await popups.count() > 0) {
            const id = await popups.last().getAttribute('data-id');
            await page.keyboard.press('Escape');
            // Assert removal of the actual dialog, not a racing count.
            await expect(page.locator(`dialog.popup[data-id="${id}"]`), 'Escape must close the newest popup').toHaveCount(0, { timeout: 5_000 });
            continue;
        }
        if (await accountWindow(page).count() > 0) {
            await closeAccountWindow(page);
            continue;
        }
        return;
    }
    throw new Error('closeAllPopups: popups kept opening');
}

/** Open Account → Device settings. */
async function openDeviceSettings(page) {
    await openAccountTab(page, 'settings');
    await expect(pageHead(page)).toHaveAttribute('data-view', 'settings');
}

/** Save the sync schedule on Account → Device settings. */
export async function setSyncSchedule(page, { idleSeconds, pollSeconds }) {
    await openDeviceSettings(page);
    const win = accountWindow(page);
    await win.locator('[data-model="schedule.idle"]').fill(String(idleSeconds));
    await win.locator('[data-model="schedule.poll"]').fill(String(pollSeconds));
    const saved = page.waitForResponse(r => r.url().endsWith('/api/sync/v1/schedule') && r.request().method() === 'POST');
    await win.locator('[data-act="save-local"]').click();
    expect((await saved).ok()).toBe(true);
    await windowToast(page).first().waitFor({ state: 'visible', timeout: 10_000 });
}

/** Save the device name on Account → Device settings. */
export async function setSyncDeviceLabel(page, label) {
    await openDeviceSettings(page);
    await accountWindow(page).locator('[data-model="device.label"]').fill(label);
    const saved = page.waitForResponse(r => r.url().endsWith('/api/sync/v1/device') && r.request().method() === 'POST');
    await accountWindow(page).locator('[data-act="save-local"]').click();
    expect((await saved).ok()).toBe(true);
}

/** Sync → Add → Use S3 storage, fill the form and save it. */
export async function addS3Backend(page, options) {
    await openAddBackend(page, 's3');
    // The fixture storage requires path-style requests.
    await fillS3Form(page, { forcePathStyle: true, ...options });
    await saveS3Form(page);
}

const S3_FIELDS = { endpoint: 'endpoint', region: 'region', bucket: 'bucket', prefix: 'prefix', accessKeyId: 'accessKey', secretAccessKey: 'secretKey', passphrase: 'passphrase', label: 'label' };

/** Fill the S3 storage form (add or edit) shown in the Account window. */
export async function fillS3Form(page, options) {
    const win = accountWindow(page);
    for (const [option, model] of Object.entries(S3_FIELDS)) {
        if (options[option] !== undefined) await win.locator(`[data-model="top.form.${model}"]`).fill(options[option]);
    }
    if (options.forcePathStyle !== undefined) {
        const toggle = win.locator('[data-act="toggle-path"]');
        const on = await toggle.evaluate(el => el.classList.contains('on'));
        if (on !== options.forcePathStyle) await toggle.click();
    }
    if (options.categories) await selectCategories(win, options.categories, 's3');
}

/** Save the S3 form and wait for the window to return to the Sync list. */
export async function saveS3Form(page) {
    await accountWindow(page).locator('[data-act="s3-save"]').click();
    await expect(pageHead(page)).toHaveAttribute('data-view', 'list', { timeout: 60_000 });
}

/**
 * Edit a backend from its card menu: the S3 form for S3 storage, the name
 * and sync content for a LAN device.
 */
export async function editSyncBackend(page, label, patch) {
    await clickBackendMenu(page, label, 'edit');
    await expect(pageHead(page)).toHaveAttribute('data-view', /^(s3|lanEdit)$/);
    if (await pageHead(page).getAttribute('data-view') === 's3') {
        await fillS3Form(page, patch);
        await saveS3Form(page);
        return;
    }
    const win = accountWindow(page);
    if (patch.label !== undefined) await win.locator('[data-model="top.label"]').fill(patch.label);
    if (patch.categories) await selectCategories(win, patch.categories, 'lanEdit');
    await win.locator('[data-act="lan-save"]').click();
    await expect(pageHead(page)).toHaveAttribute('data-view', 'list', { timeout: 60_000 });
}

/** Unlock an S3 backend from its card menu with the passphrase. */
export async function unlockS3Backend(page, label, phrase) {
    await clickBackendMenu(page, label, 'unlock');
    await accountWindow(page).locator('[data-model="top.form.pass"]').fill(phrase);
    await accountWindow(page).locator('[data-act="unlock-save"]').click();
    await expect(pageHead(page)).toHaveAttribute('data-view', 'list', { timeout: 60_000 });
}

export async function waitForBackendSync(page, { label, since = 0 }) {
    await expect.poll(() => page.evaluate(async ({ label, since }) => {
        const { backends, running } = await (await fetch('/api/sync/v1/backends')).json();
        const entry = Object.entries(backends).find(([, b]) => b.label === label);
        return entry && !running[entry[0]] && entry[1].lastSync?.at > since && !entry[1].lastSync.error;
    }, { label, since }), { timeout: 60_000 }).toBe(true);
}

/**
 * Wait until the device of `page` holds a successful sync of every LAN
 * backend newer than `since` (ms epoch) and runs none. After a pairing the
 * other device syncs in the background on the notify; edits made while
 * that run is in progress race it.
 */
export async function waitForBackgroundSync(page, { since = 0 } = {}) {
    await expect.poll(() => page.evaluate(async after => {
        const response = await fetch('/api/sync/v1/backends', { credentials: 'same-origin' });
        if (!response.ok) return `HTTP ${response.status}`;
        const { backends, running } = await response.json();
        const lan = Object.entries(backends).filter(([, b]) => b.kind === 'lan');
        if (lan.length === 0) return 'no LAN backend';
        const pending = lan.filter(([id, b]) => running[id] || !(b.lastSync?.at > after)).map(([id]) => id);
        return pending.length ? `waiting for ${pending.join(', ')}` : 'settled';
    }, since), { timeout: 60_000 }).toBe('settled');
}

/**
 * The Sync issues page of the Account window (conflicts, notices and files
 * not updated). It replaced the sync popup.
 */
export const syncPopup = page => accountWindow(page).locator('.dw-body', { has: page.locator('.dw-pagehead[data-view="conflicts"]') });

/**
 * Wait until the Sync issues page shows by itself: on page load and after a
 * status check that found new issues while the window was closed, the
 * Account window opens on it.
 */
export async function waitForSyncIssuesPage(page, timeout = 60_000) {
    await syncPopup(page).waitFor({ state: 'visible', timeout });
    return syncPopup(page);
}

/**
 * Wait for the Sync issues page. When the Account window is already open on
 * another page, an open window lists new issues without moving the user, so
 * this clicks the Resolve button (or the title status) the window shows for
 * them, like a user would.
 */
export async function waitForSyncPopup(page, timeout = 60_000) {
    await expect.poll(async () => {
        if (await syncPopup(page).count() > 0) return true;
        const resolve = accountWindow(page).locator('[data-act="conflicts"]');
        if (await resolve.count() > 0) await resolve.first().click({ timeout: 2_000 }).catch(() => {});
        return syncPopup(page).count().then(n => n > 0);
    }, { timeout, intervals: [250, 500, 1000] }).toBe(true);
    return syncPopup(page);
}

/** Wait until the page finished `count` status checks (a DOM counter the status module keeps). */
export async function waitForStatusChecks(page, count = 1) {
    await page.waitForFunction(n => Number(document.body.dataset.syncStatusChecks || 0) >= n, count, { timeout: 60_000 });
}

/** The conflict of a file on the Sync issues page. */
export const conflictRow = (page, rel) => syncPopup(page).locator(`.dw-conflict[data-path=${JSON.stringify(rel)}]`);

/** The notice of a chat on the Sync issues page. */
export const noticeRow = (page, rel) => syncPopup(page).locator(`.dw-notice[data-path=${JSON.stringify(rel)}]`);

/**
 * Open the conflict panel of `rel` and every closed section, entry and
 * field inside it. Values load only when a field opens, so a caller that
 * needs to read a value must expand first. Repeats until no closed
 * details remain, because opening a section renders its children.
 *
 * @returns {import('@playwright/test').Locator} the opened panel
 */
export async function expandConflictDiff(page, rel, { index = 0 } = {}) {
    const diff = await openConflictPanel(page, rel, index);
    await readConflictDiff(page, rel, { index });
    return diff;
}

/**
 * The conflict panel of one row, opened and waiting for its summary to
 * leave the loading state.
 */
async function openConflictPanel(page, rel, index) {
    const diff = conflictRow(page, rel).locator('.syncConflictDiff').nth(index);
    await expect(diff).toBeVisible({ timeout: 30_000 });
    await expect(diff.locator('.syncConflictDiffSummary')).not.toHaveText('Comparing versions…', { timeout: 30_000 });
    if (!(await diff.evaluate(element => element.open))) {
        await diff.locator('.syncConflictDiffSummary').click();
    }
    return diff;
}

/**
 * Open every section, entry and field of one conflict panel and return a
 * snapshot of its rendered text and value cells.
 *
 * Expansion runs inside the page: a status refresh can replace the row
 * while a value request is in flight, and Playwright's actionability
 * checks would then wait on a detached panel forever. Each step still
 * clicks the visible summary, so the same toggle handlers and value
 * requests run as when a user opens the tree.
 */
export async function readConflictDiff(page, rel, { index = 0 } = {}) {
    await openConflictPanel(page, rel, index);
    return page.evaluate(async ({ rel, index }) => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const panelOf = () => [...document.querySelectorAll('.dw-conflict')]
            .find(row => row.dataset.path === rel)
            ?.querySelectorAll('.syncConflictDiff')[index];
        const readValues = (panel, side) => [...panel.querySelectorAll(`.syncDiffValue[data-side="${side}"] .syncDiffValueText`)]
            .map(element => element.textContent);
        for (let guard = 0; guard < 100; guard++) {
            const panel = panelOf();
            if (!panel) return { text: '', ours: [], theirs: [], current: [], kept: [], missing: true };
            const closed = [...panel.querySelectorAll('details:not([open])')];
            if (closed.length > 0) {
                for (const details of closed) details.querySelector(':scope > summary')?.click();
                await sleep(50);
                continue;
            }
            if (panel.querySelector('.syncDiffLoading')) {
                await sleep(50);
                continue;
            }
            // A summary click opens the details on the next task, which can
            // render children and start a value request after this pass.
            // Return only after a second pass sees the same settled state.
            await sleep(100);
            const settled = panelOf();
            if (settled && !settled.querySelectorAll('details:not([open])').length && !settled.querySelector('.syncDiffLoading')) {
                return {
                    text: settled.textContent,
                    ours: readValues(settled, 'ours'),
                    theirs: readValues(settled, 'theirs'),
                    current: readValues(settled, 'current'),
                    kept: readValues(settled, 'kept'),
                };
            }
        }
        const panel = panelOf();
        return { text: panel?.textContent ?? '', ours: [], theirs: [], current: [], kept: [], timeout: true };
    }, { rel, index });
}

/**
 * The merge role (`ours` or `theirs`) of the device version whose value
 * shows `text`. Both e2e servers share a host name, so the card titles do
 * not tell the devices apart. Every field is opened first because values
 * are fetched only on demand.
 */
export async function conflictChoiceShowing(page, rel, text) {
    let outcome = null;
    await expect.poll(async () => {
        const snapshot = await readConflictDiff(page, rel);
        const count = values => values.filter(value => value.includes(text)).length;
        const ours = count(snapshot.ours);
        const theirs = count(snapshot.theirs);
        if (ours === 1 && theirs === 0) outcome = 'ours';
        else if (theirs === 1 && ours === 0) outcome = 'theirs';
        else outcome = `ambiguous:${ours}:${theirs}`;
        return outcome;
    }, { timeout: 30_000 }).toMatch(/^(ours|theirs)$/);
    return outcome;
}

export async function chooseConflictVersion(page, rel, choice) {
    const version = conflictRow(page, rel).locator(`.dw-version[data-v="${choice}"]`);
    await version.click();
    await expect(version).toHaveClass(/\bon\b/);
}

/**
 * Click Apply choices and answer the Overwrite confirm the window asks for
 * each picked stale file, one after another. Resolves to 'success' (the
 * choices were applied), 'error' (a choice failed or the apply request
 * failed) or 'confirm-cancelled'.
 */
export async function applyConflictChoices(page, { confirmOverwrite = false } = {}) {
    await syncPopup(page).locator('[data-act="apply"]').click();
    const next = () => page.waitForFunction(() => {
        const win = document.querySelector('dialog.dw-layer[open] .dw-win');
        if (!win) return 'done';
        if (win.querySelector('.dw-modal')) return 'confirm';
        const onIssues = win.querySelector('.dw-pagehead[data-view="conflicts"]');
        if (onIssues && win.querySelector('[data-act="apply"].busy')) return null;
        return 'done';
    }, null, { timeout: 60_000 }).then(handle => handle.jsonValue());
    let result = await next();
    while (result === 'confirm') {
        await expect(windowConfirm(page)).toContainText('Overwrite');
        if (!confirmOverwrite) {
            await answerWindowConfirm(page, { confirm: false });
            return 'confirm-cancelled';
        }
        await answerWindowConfirm(page);
        result = await next();
    }
    const failed = await accountWindow(page).locator('.dw-conflict.is-failed, .dw-toast.error').count();
    return failed > 0 ? 'error' : 'success';
}

/**
 * Pick `side` for every conflict on the Sync issues page and apply. `ours`
 * and `theirs` are the merge roles the versions are titled with by device
 * label; which device holds which role is decided by the merge, not by
 * which device runs the page.
 */
export async function resolveAllConflictsAs(page, side) {
    await waitForSyncPopup(page);
    const paths = await syncPopup(page).locator('.dw-conflict').evaluateAll(rows => rows.map(r => r.dataset.path));
    expect(paths.length, 'the Sync issues page must list at least one conflict').toBeGreaterThan(0);
    for (const rel of paths) await chooseConflictVersion(page, rel, side);
    return applyConflictChoices(page, { confirmOverwrite: true });
}

export async function listPopupConflicts(page) {
    return syncPopup(page).locator('.dw-conflict').evaluateAll(rows => rows.map(r => ({ path: r.dataset.path, stale: r.dataset.stale === 'true' })));
}

export async function listPopupNotices(page) {
    return syncPopup(page).locator('.dw-notice').evaluateAll(rows => rows.map(r => ({ path: r.dataset.path, text: r.querySelector('small')?.textContent ?? '' })));
}

/** Click the open button of a chat notice; the window closes and the chat opens. */
export async function openBranchFromNotice(page, rel, branchName) {
    await noticeRow(page, rel).locator('[data-act="notice-open"]').click();
    await page.waitForFunction(name => window.Luker.getContext().getCurrentChatId() === name, branchName, { timeout: 30_000 });
}

export async function dismissNotice(page, rel) {
    const row = noticeRow(page, rel);
    await row.locator('[data-act="notice-x"]').click();
    await row.waitFor({ state: 'detached', timeout: 30_000 });
}

/** Close the Account window that shows the Sync issues page. */
export async function closeSyncPopup(page) {
    await syncPopup(page).waitFor({ state: 'visible', timeout: 10_000 });
    await closeAccountWindow(page);
}

/** Open a chat of the selected character by file name through Manage chat files. */
export async function openChatByName(page, name) {
    await page.locator('#options_button').click();
    await page.locator('#option_select_chat').click();
    const chatId = name.replace(/\.jsonl$/i, '');
    const escaped = chatId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exact = new RegExp(`^\\s*${escaped}(\\.jsonl)?\\s*$`);
    const row = page.locator('.select_chat_block_wrapper', { has: page.locator('.select_chat_block_filename', { hasText: exact }) }).first();
    await row.locator('.select_chat_block').click();
    await page.waitForFunction(wanted => window.Luker.getContext().getCurrentChatId() === wanted, chatId, { timeout: 30_000 });
    // The chat loader covers the page until the past chats popup closes.
    await page.locator('#shadow_select_chat_popup').waitFor({ state: 'hidden', timeout: 30_000 });
}

export const userRootOf = server => path.join(server.dataRoot, 'default-user');
export const readUserFile = (server, rel) => {
    const abs = path.join(userRootOf(server), ...rel.split('/'));
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};
export async function shadowMain(server, backendId) {
    const gitdir = path.join(userRootOf(server), '.sync', backendId, 'repo.git');
    return git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' });
}
export const backendIdOf = server => Object.keys(JSON.parse(fs.readFileSync(path.join(userRootOf(server), '.sync', 'state.json'), 'utf8')).backends)[0];

/**
 * Request routes whose handlers mark the user dirty through `runGatedWrite`
 * without a `GATED_ROUTES` entry (grep `runGatedWrite(` in `src/`).
 * `/api/stats/update` changes the in-memory stats the flush timer later
 * saves with a dirty mark, so it counts too.
 */
const RUN_GATED_WRITE_ROUTES = [
    /^\/api\/vector\/insert\/?$/,
    /^\/api\/skills\/import-from-url\/?$/,
    /^\/api\/extensions\/(install|update)\/?$/,
    /^\/api\/assets\/download\/?$/,
    /^\/api\/stats\/update\/?$/,
];
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const mayMarkDirty = (method, pathname) => (WRITE_METHODS.has(method) && matchGatedRoute(pathname)?.dirty === true)
    || RUN_GATED_WRITE_ROUTES.some(pattern => pattern.test(pathname));

/**
 * Record every response of `page` that can set the dirty mark of its user:
 * a 2xx write to a gated route the gate marks dirty, a request route that
 * marks dirty through `runGatedWrite`, and the first `/api/skills` request
 * of the server process, whose bundled-skill populate marks dirty. Such
 * requests still in flight and the time the last one was sent are kept
 * too, so a save sent before an edit but answered after it is seen.
 */
export function recordDirtyWrites(page) {
    const writes = [];
    writes.inFlight = new Set();
    writes.lastSentAt = 0;
    let skillsSeen = false;
    const pathOf = request => new URL(request.url()).pathname;
    page.on('request', request => {
        const pathname = pathOf(request);
        if (!pathname.startsWith('/api/')) return;
        if (mayMarkDirty(request.method(), pathname) || pathname.startsWith('/api/skills')) {
            writes.inFlight.add(request);
            writes.lastSentAt = Date.now();
        }
    });
    const settled = request => writes.inFlight.delete(request);
    page.on('requestfinished', settled);
    page.on('requestfailed', settled);
    page.on('response', response => {
        const pathname = pathOf(response.request());
        if (!pathname.startsWith('/api/')) return;
        const method = response.request().method();
        const ok = response.status() >= 200 && response.status() < 300;
        const firstSkills = pathname.startsWith('/api/skills') && !skillsSeen;
        if (pathname.startsWith('/api/skills')) skillsSeen = true;
        if (ok && (mayMarkDirty(method, pathname) || firstSkills)) writes.push({ path: pathname, method, at: Date.now() });
    });
    return writes;
}

async function lanBackend(page) {
    return page.evaluate(async () => {
        const { backends, running } = await (await fetch('/api/sync/v1/backends', { credentials: 'same-origin' })).json();
        const [id, backend] = Object.entries(backends).find(([, b]) => b.kind === 'lan');
        return { running: Boolean(running[id]), lastSyncAt: backend.lastSync?.at ?? 0 };
    });
}

/**
 * One category step on `page`, whose LAN backend syncs `idleMs` after the
 * last dirty mark: run `prepare`, wait until the sync of every dirty mark
 * it set finished, run `edit`, and poll `arrived` on the other device. The
 * step passes only when the edit's own route set a dirty mark and no other
 * dirty mark landed between the edit and the start of the next sync, so
 * the idle sync that carried the edit was started by it. With `dirtyTrace`,
 * require the own route's actual notification instead of excluding other
 * writes; the trace reader returns notifications recorded by the server.
 */
export function categoryStep(page, writes, { idleMs, dirtyTrace = null }) {
    return async (label, { prepare, edit, ownRoute, arrived }) => {
        if (prepare) await prepare();
        const preparedAt = Date.now();
        // A preparation keeps writing after its clicks return (a chat load
        // saves chat state and settings), so wait until the idle delay passed
        // with no write sent or answered and none in flight, and a sync ended
        // an idle delay after the last write.
        await expect.poll(async () => {
            const lastWrite = writes.at(-1)?.at ?? 0;
            const { running, lastSyncAt } = await lanBackend(page);
            const quiet = writes.inFlight.size === 0 && Date.now() - Math.max(lastWrite, writes.lastSentAt, preparedAt) >= idleMs;
            return quiet && !running && (lastWrite === 0 || lastSyncAt >= lastWrite + idleMs);
        }, { timeout: 60_000, message: `${label}: the syncs of the preparation finish` }).toBe(true);
        const from = writes.length;
        const traceFrom = dirtyTrace ? dirtyTrace().length : 0;
        const editStartedAt = Date.now();
        let syncStartedAt = null;
        const syncStarted = expect.poll(async () => {
            const { running, lastSyncAt } = await lanBackend(page);
            if (running) syncStartedAt = Date.now();
            else if (lastSyncAt > editStartedAt) syncStartedAt = lastSyncAt;
            return syncStartedAt !== null;
        }, { timeout: 60_000, intervals: [100], message: `${label}: an idle sync starts after the edit` }).toBe(true);
        syncStarted.catch(() => {});
        await edit();
        await syncStarted;
        await expect.poll(arrived, { timeout: 60_000, message: label }).toBe(true);
        if (dirtyTrace) {
            const marks = dirtyTrace().slice(traceFrom);
            expect(marks.filter(mark => mark.path && ownRoute.test(mark.path)), `${label}: the edit's own route emitted a real dirty notification (${JSON.stringify(marks)})`).not.toEqual([]);
            return;
        }
        const beforeSync = writes.slice(from).filter(write => write.at <= syncStartedAt);
        expect(beforeSync.filter(write => ownRoute.test(write.path)), `${label}: the edit's own route set a dirty mark`).not.toEqual([]);
        const timeline = writes.slice(from).map(write => `${write.method} ${write.path} +${write.at - editStartedAt} ms`).join(', ');
        expect(beforeSync.filter(write => !ownRoute.test(write.path)), `${label}: inconclusive, another write set a dirty mark before the sync started at +${syncStartedAt - editStartedAt} ms (${timeline})`).toEqual([]);
    };
}
