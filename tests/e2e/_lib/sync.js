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
//   - `success`  — the sync finished and wrote the merged files to disk
//   - `warning`  — the sync recorded conflicts; the sync popup opens
//   - `error`    — peer unreachable / auth fail / etc.
// Helpers return the actual outcome so the caller can branch instead of
// guessing. The interim `info` banner (`Syncing…`) is not a terminal
// state and helpers wait past it.

import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import git from 'isomorphic-git';

import { matchGatedRoute } from '../../../src/sync/in-progress-gate.js';
import { completeOnboarding } from './page.js';

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

/** Tick exactly `wanted` in a category grid, one click per box like a user. */
export async function selectCategories(grid, wanted) {
    const boxes = grid.locator('input[name="lanSyncCategory"]');
    for (const box of await boxes.all()) {
        if (wanted.includes(await box.inputValue())) await box.check();
        else await box.uncheck();
    }
}

/**
 * Generate a pairing link on `page` (which is on Device A). Returns the
 * `luker-sync://...` URL. `label` is what A will call B in its own peers
 * list once B accepts.
 */
export async function generatePairingLink(page, { label, categories }) {
    await page.locator('.lanSyncTabPairNew').click();
    await page.locator('.lanSyncPairLabel').fill(label);
    await selectCategories(page.locator('.lanSyncCategoryGrid'), categories);
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
 * waiting in the sync popup; 'success' means the sync landed cleanly.
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
    await selectCategories(page.locator('.lanSyncAcceptCategoryGrid'), categories);
    await page.locator('.lanSyncAcceptButton').click();
    return waitForTerminalBannerState(page);
}

/**
 * Click "Sync now" against the named peer in the My devices list.
 * Returns the terminal banner state — same shape as `acceptPairingLink`.
 */
export async function clickSyncNow(page, peerLabel, timeoutMs = 30_000) {
    await page.locator('.lanSyncTabPeers').click();
    const row = page.locator('.lanSyncPeerRow', { hasText: peerLabel });
    await row.locator('.lanSyncPeerSyncButton').click();
    return waitForTerminalBannerState(page, timeoutMs);
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

/** Close every open popup, newest first (panel stacks: Account → Backup → LAN Sync). */
export async function closeAllPopups(page) {
    const open = page.locator('dialog.popup[open]');
    while (await open.count() > 0) {
        const id = await open.last().getAttribute('data-id');
        await page.keyboard.press('Escape');
        // Status can legitimately open a new popup as the previous one
        // closes. Assert removal of the actual dialog, not a racing count.
        await expect(page.locator(`dialog.popup[data-id="${id}"]`), 'Escape must close the newest popup').toHaveCount(0, { timeout: 5_000 });
    }
}

export async function setSyncSchedule(page, { idleSeconds, pollSeconds }) {
    await page.locator('.lanSyncTabPeers').click();
    await page.locator('.lanSyncIdleSeconds').fill(String(idleSeconds));
    await page.locator('.lanSyncPollSeconds').fill(String(pollSeconds));
    await page.locator('.lanSyncSaveScheduleButton').click();
    await page.locator('.toast-success', { hasText: 'Schedule saved.' }).first().waitFor({ state: 'visible', timeout: 10_000 });
}

export async function setSyncDeviceLabel(page, label) {
    await page.locator('.lanSyncTabPeers').click();
    await page.locator('.syncDeviceLabel').fill(label);
    const saved = page.waitForResponse(r => r.url().endsWith('/api/sync/v1/device') && r.request().method() === 'POST');
    await page.locator('.syncSaveDeviceLabelButton').click();
    expect((await saved).ok()).toBe(true);
}

export async function addS3Backend(page, options) {
    await page.locator('.syncAddS3Button').click();
    await fillS3Form(page, options);
    await saveS3Form(page);
}

export async function fillS3Form(page, options) {
    for (const field of ['endpoint', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey', 'passphrase', 'label']) {
        if (options[field] !== undefined) await page.locator(`.syncS3${field[0].toUpperCase()}${field.slice(1)}`).fill(options[field]);
    }
    if (options.region !== undefined) await page.locator('.syncS3Region').selectOption(options.region);
    if (options.forcePathStyle !== undefined) await page.locator('.syncS3ForcePathStyle').setChecked(options.forcePathStyle);
    if (options.categories) await selectCategories(page.locator('.syncS3CategoryGrid'), options.categories);
}

async function saveS3Form(page) {
    await page.locator('.syncS3SaveButton').click();
    await expect(page.locator('.userSyncS3')).toHaveCount(0, { timeout: 60_000 });
}

export async function editSyncBackend(page, label, patch) {
    await page.locator('.lanSyncTabPeers').click();
    await page.locator('.lanSyncPeerRow').filter({ has: page.locator('.lanSyncPeerLabel', { hasText: label }) }).locator('.syncBackendEditButton').click();
    await fillS3Form(page, patch);
    await saveS3Form(page);
}

export async function unlockS3Backend(page, label, phrase) {
    await page.locator('.lanSyncPeerRow', { hasText: label }).locator('.syncBackendUnlockButton').click();
    await page.locator('.syncS3Passphrase').fill(phrase);
    await saveS3Form(page);
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

export const syncPopup = page => page.locator('.syncConflictsPopup');

export async function waitForSyncPopup(page, timeout = 60_000) {
    await syncPopup(page).waitFor({ state: 'visible', timeout });
    return syncPopup(page);
}

/** Wait until the page finished `count` status checks (a DOM counter the popup module keeps). */
export async function waitForStatusChecks(page, count = 1) {
    await page.waitForFunction(n => Number(document.body.dataset.syncStatusChecks || 0) >= n, count, { timeout: 60_000 });
}

const rowOf = (page, rel) => syncPopup(page).locator(`.syncConflictRow[data-path=${JSON.stringify(rel)}]`);

/**
 * The merge role (`ours` or `theirs`) of the device version whose preview
 * shows `text`. Both e2e servers share a host name, so the card titles do
 * not tell the devices apart.
 */
export async function conflictChoiceShowing(page, rel, text) {
    const card = rowOf(page, rel).locator('.syncConflictCard:not([data-choice="current"])', { has: page.locator('.syncConflictPreview', { hasText: text }) });
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    return card.getAttribute('data-choice');
}

export async function chooseConflictVersion(page, rel, choice) {
    await rowOf(page, rel).locator(`input[type="radio"][value="${choice}"]`).check();
}

/**
 * Click Apply and answer the Overwrite confirm the popup opens for each
 * picked stale row, one after another. Resolves to 'success' (popup
 * closed), 'error' (popup shows an error) or 'confirm-cancelled'.
 */
export async function applyConflictChoices(page, { confirmOverwrite = false } = {}) {
    // A new popup can open as soon as this one closes, so wait on this one by id.
    const dialogId = await page.locator('dialog.popup[open]', { has: syncPopup(page) }).getAttribute('data-id');
    await syncPopup(page).locator('.syncConflictsApplyButton').click();
    const confirm = page.locator('dialog.popup[open]', { hasText: 'Overwrite the current version', hasNot: syncPopup(page) });
    const settle = () => Promise.race([
        page.locator(`dialog.popup[data-id="${dialogId}"]`).waitFor({ state: 'detached', timeout: 60_000 }).then(() => 'success'),
        syncPopup(page).locator('.syncConflictsError').waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'error'),
    ]);
    const next = () => Promise.race([settle(), confirm.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'confirm')]);
    let result = await next();
    while (result === 'confirm') {
        if (!confirmOverwrite) {
            await confirm.locator('.popup-button-cancel').click();
            return 'confirm-cancelled';
        }
        // The next confirm opens as soon as this one is removed, so wait on this one by id.
        const id = await confirm.getAttribute('data-id');
        await confirm.locator('.popup-button-ok').click();
        await page.locator(`dialog.popup[data-id="${id}"]`).waitFor({ state: 'detached', timeout: 10_000 });
        result = await next();
    }
    return result;
}

/**
 * Pick `side` for every conflict in the popup and apply. `ours` and
 * `theirs` are the merge roles the cards are titled with by device label;
 * which device holds which role is decided by the merge, not by which
 * device runs the page.
 */
export async function resolveAllConflictsAs(page, side) {
    await waitForSyncPopup(page);
    const paths = await syncPopup(page).locator('.syncConflictRow').evaluateAll(rows => rows.map(r => r.dataset.path));
    expect(paths.length, 'the sync popup must list at least one conflict').toBeGreaterThan(0);
    for (const rel of paths) await chooseConflictVersion(page, rel, side);
    return applyConflictChoices(page, { confirmOverwrite: true });
}

export async function listPopupConflicts(page) {
    return syncPopup(page).locator('.syncConflictRow').evaluateAll(rows => rows.map(r => ({ path: r.dataset.path, stale: !!r.querySelector('.syncConflictStale') })));
}

export async function listPopupNotices(page) {
    return syncPopup(page).locator('.syncNoticeRow').evaluateAll(rows => rows.map(r => ({ path: r.dataset.path, text: r.querySelector('.syncNoticeText')?.textContent ?? '' })));
}

export async function openBranchFromNotice(page, rel, branchName) {
    await syncPopup(page).locator(`.syncNoticeRow[data-path=${JSON.stringify(rel)}] .syncNoticeOpenButton`).click();
    await page.waitForFunction(name => window.Luker.getContext().getCurrentChatId() === name, branchName, { timeout: 30_000 });
}

export async function dismissNotice(page, rel) {
    const row = syncPopup(page).locator(`.syncNoticeRow[data-path=${JSON.stringify(rel)}]`);
    await row.locator('.syncNoticeDismissButton').click();
    await row.waitFor({ state: 'detached', timeout: 30_000 });
}

export async function closeSyncPopup(page) {
    await page.locator('dialog.popup[open]', { has: syncPopup(page) }).locator('.popup-button-ok').click();
    await syncPopup(page).waitFor({ state: 'detached', timeout: 10_000 });
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
