import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { s3Fixture, backendRow, registryOf, reloadS3Page, createReadyWorldBook, selectReadyWorldBook } from '../_lib/sync-s3.js';
import { addWorldEntry } from '../_lib/ui-worldinfo.js';
import { restoreChatCorpus, editCorpusChat, COMPANIONS } from '../_lib/s3-chat.js';
import { addS3Backend, waitForBackendSync, closeAllPopups, openLanSyncPanel, clickSyncNow, waitForSyncPopup, chooseConflictVersion, waitForStatusChecks, userRootOf, openAddBackend, conflictRow, noticeRow } from '../_lib/sync.js';
import { accountWindow, windowToast } from '../_lib/account-window.js';

const fixture = s3Fixture(test);
test.describe.configure({ timeout: 360_000 });
const checks = page => page.evaluate(() => Number(document.body.dataset.syncStatusChecks || 0));
const status = page => page.evaluate(async () => (await (await fetch('/api/sync/v1/status')).json()));
// The window reads the backend list again after each status check (30 s poll).
const REFRESH_TIMEOUT = 60_000;
const listError = page => accountWindow(page).locator('.dw-banner.error', { hasText: 'refresh sync backends' });
const chosenChips = page => accountWindow(page).locator('[data-act="cat"][data-set="pairNew"].on').evaluateAll(chips => chips.map(chip => chip.dataset.id));
/** Wait until a backend list read of `page` fails the way `mode` injects. */
const failedListRead = (page, mode) => (mode === 'network'
    ? page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/api/sync/v1/backends', timeout: REFRESH_TIMEOUT })
    : page.waitForResponse(response => new URL(response.url()).pathname === '/api/sync/v1/backends' && response.status() === 503, { timeout: REFRESH_TIMEOUT }));

function failedRead(mode) {
    return async route => {
        const response = await route.fetch();
        if (mode === 'network') await route.abort('connectionfailed');
        else await route.fulfill({ response, status: 503, body: 'Injected response-read failure' });
    };
}

test('backend refresh failures retain populated rows and selections through recovery', async ({ browser }) => {
    test.setTimeout(360_000);
    const device = await fixture.device(browser, 'read-state');
    const { page } = device;
    await addS3Backend(page, await fixture.options());
    await waitForBackendSync(page, { label: 'Cloud' });
    for (const mode of ['http', 'network']) {
        // A half-filled pairing form stays as typed while refreshes fail.
        await openAddBackend(page, 'pairNew');
        await accountWindow(page).locator('[data-model="top.label"]').fill('Retained form label');
        const worlds = accountWindow(page).locator('[data-act="cat"][data-set="pairNew"][data-id="worlds"]');
        if (!await worlds.evaluate(chip => chip.classList.contains('on'))) await worlds.click();
        await expect(worlds).toHaveClass(/\bon\b/);
        const chosen = await chosenChips(page);
        const fail = failedRead(mode);
        await page.route('**/api/sync/v1/backends', fail);
        try {
            await failedListRead(page, mode);
            await expect(accountWindow(page).locator('[data-model="top.label"]')).toHaveValue('Retained form label');
            expect(await chosenChips(page)).toEqual(chosen);
            // The list keeps the backends it loaded and says it could not refresh them.
            await openLanSyncPanel(page);
            await expect(listError(page)).toBeVisible({ timeout: REFRESH_TIMEOUT });
            await expect(backendRow(page)).toHaveCount(1);
        } finally { await page.unroute('**/api/sync/v1/backends', fail); }
        await expect(listError(page)).toHaveCount(0, { timeout: REFRESH_TIMEOUT });
        await expect(backendRow(page)).toHaveCount(1);
    }
});

for (const mode of ['http', 'network']) test(`failed categories from ${mode} recover on reopening without a page reload`, async ({ browser }) => {
    test.setTimeout(360_000);
    const { page } = await fixture.device(browser, 'category-read');
    await reloadS3Page(page);
    await waitForStatusChecks(page);
    await closeAllPopups(page);
    const fail = failedRead(mode);
    await page.route('**/api/sync/v1/categories', fail);
    try {
        await openLanSyncPanel(page);
        await expect(accountWindow(page).locator('.dw-empty')).toContainText('Could not load sync categories');
    } finally { await page.unroute('**/api/sync/v1/categories', fail); }
    await closeAllPopups(page);
    await openLanSyncPanel(page);
    await openAddBackend(page, 'pairNew');
    expect(await accountWindow(page).locator('[data-act="cat"]').count()).toBeGreaterThan(0);
});

test('failed status reads keep the open conflict unknown rather than resolved and restore its selected choice after recovery', async ({ browser }) => {
    test.setTimeout(360_000);
    const a = await fixture.device(browser, 'status-a');
    const b = await fixture.device(browser, 'status-b');
    const options = await fixture.options();
    await addS3Backend(a.page, options); await waitForBackendSync(a.page, { label: 'Cloud' });
    await closeAllPopups(a.page);
    await createReadyWorldBook(a.page, 'Read Failure Grove');
    await openLanSyncPanel(a.page); expect(await clickSyncNow(a.page, 'Cloud')).toBe('success');
    await addS3Backend(b.page, options); await waitForBackendSync(b.page, { label: 'Cloud' });
    for (const [device, text] of [[a, 'Desk independent value'], [b, 'Tablet independent value']]) {
        await closeAllPopups(device.page); await reloadS3Page(device.page); await waitForStatusChecks(device.page); await closeAllPopups(device.page);
        await selectReadyWorldBook(device.page, 'Read Failure Grove'); await addWorldEntry(device.page, { key: text, content: text });
    }
    await openLanSyncPanel(a.page); expect(await clickSyncNow(a.page, 'Cloud')).toBe('success');
    await openLanSyncPanel(b.page); expect(await clickSyncNow(b.page, 'Cloud')).toBe('warning');
    await waitForSyncPopup(b.page);
    const rel = 'worlds/Read Failure Grove.json';
    const row = () => conflictRow(b.page, rel);
    const current = () => row().locator('.dw-version[data-v="current"]');
    const titleStatus = accountWindow(b.page).locator('[data-region="status"]');
    await chooseConflictVersion(b.page, rel, 'current');
    for (const mode of ['http', 'network']) {
        const fail = failedRead(mode);
        await b.page.route('**/api/sync/v1/status', fail);
        try {
            await waitForStatusChecks(b.page, await checks(b.page) + 1);
            // Unknown: every version is disabled; nothing reports it resolved.
            for (const version of await row().locator('.dw-version').all()) await expect(version).toBeDisabled();
            await expect(windowToast(b.page, 'already handled on another device')).toHaveCount(0);
            await expect(current()).toHaveClass(/\bon\b/);
            await expect(current()).toBeDisabled();
            await expect(titleStatus).toContainText('Can\'t read sync status');
        } finally { await b.page.unroute('**/api/sync/v1/status', fail); }
        await waitForStatusChecks(b.page, await checks(b.page) + 1);
        await expect(current()).toBeEnabled();
        await expect(current()).toHaveClass(/\bon\b/);
        await expect(titleStatus).not.toContainText('Can\'t read sync status');
    }
});

test('partial grouped notice dismissal retains an unknown row until the unreadable side recovers', async ({ browser }, testInfo) => {
    test.setTimeout(360_000);
    const a = await fixture.device(browser, 'notice-a');
    const b = await fixture.device(browser, 'notice-b');
    const options = await fixture.options(['characters', 'chats']);
    const ready = async (device, label) => {
        try { await waitForBackendSync(device.page, { label }); } catch (error) {
            const diagnostic = JSON.stringify(await status(device.page));
            fs.writeFileSync(testInfo.outputPath('notice-sync-status.json'), diagnostic);
            fs.writeFileSync(testInfo.outputPath('notice-server-output.txt'), device.server.output);
            await testInfo.attach('notice-sync-status', { body: diagnostic, contentType: 'application/json' });
            await testInfo.attach('notice-server-output', { body: device.server.output, contentType: 'text/plain' });
            throw error;
        }
    };
    await restoreChatCorpus(a, testInfo, { companions: { iter_studio: COMPANIONS.iter_studio } });
    await openLanSyncPanel(a.page); await addS3Backend(a.page, options); await ready(a, 'Cloud');
    await addS3Backend(b.page, options); await ready(b, 'Cloud');
    const rel = 'chats/Seraphina/Forest Path.jsonl';
    await editCorpusChat(a, rel, 'Notice from desk'); await editCorpusChat(b, rel, 'Notice from tablet');
    for (const device of [a, b]) {
        await closeAllPopups(device.page); await openLanSyncPanel(device.page); await clickSyncNow(device.page, 'Cloud');
    }
    await waitForSyncPopup(b.page);
    await closeAllPopups(b.page); await openLanSyncPanel(b.page);
    await addS3Backend(b.page, { ...options, label: 'Mirror' }); await ready(b, 'Mirror');
    await reloadS3Page(b.page);
    await waitForSyncPopup(b.page);
    const pending = await status(b.page);
    const notice = pending.notices.find(entry => entry.backends.length === 2);
    expect(notice).toBeTruthy();
    const [broken] = notice.backends;
    const gitdir = path.join(userRootOf(b.server), '.sync', broken, 'repo.git');
    const head = await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' });
    const { oid } = await git.readBlob({ fs, gitdir, oid: head, filepath: '.luker-sync/notices.json' });
    const file = path.join(gitdir, 'objects', oid.slice(0, 2), oid.slice(2));
    const original = fs.readFileSync(file);
    const row = () => noticeRow(b.page, notice.path);
    const dismiss = () => row().locator('[data-act="notice-x"]');
    fs.writeFileSync(file, 'unreadable grouped notice object');
    try {
        const response = b.page.waitForResponse(response => response.url().endsWith('/notices/dismiss'));
        await dismiss().click();
        const result = await (await response).json();
        expect(result).toMatchObject({ ok: false, errors: { [broken]: expect.any(Object) }, results: [{ applied: false, committedBackends: notice.backends.filter(id => id !== broken) }] });
        await expect(row()).toHaveCount(1);
        // Unknown until the unreadable side recovers: it cannot be dismissed.
        await expect(dismiss()).toBeDisabled();
        expect((await status(b.page)).notices).toEqual([]);
        expect(Object.keys(registryOf(b.server).backends)).toHaveLength(2);
    } finally { fs.writeFileSync(file, original); }
    await waitForStatusChecks(b.page, await checks(b.page) + 1);
    await expect(dismiss()).toBeEnabled();
    const response = b.page.waitForResponse(response => response.url().endsWith('/notices/dismiss'));
    await dismiss().click();
    expect(await (await response).json()).toMatchObject({ ok: true, results: [{ applied: true, committedBackends: [broken] }] });
    await expect(row()).toHaveCount(0);
});
