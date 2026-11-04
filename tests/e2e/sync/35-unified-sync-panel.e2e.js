import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import git from 'isomorphic-git';
import { S3Client, CreateBucketCommand, GetObjectCommand, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { startRustfsContainer } from '../_lib/s3-container.js';
import { startS3Proxy } from '../_lib/s3-proxy.js';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { createWorldBook, selectWorldBook, addWorldEntry } from '../_lib/ui-worldinfo.js';
import {
    openLanSyncPanel, closeAllPopups, addS3Backend, editSyncBackend, unlockS3Backend,
    setSyncDeviceLabel, setSyncSchedule, waitForBackendSync, generatePairingLink,
    acceptPairingLink, clickSyncNow, clickForgetPeer,
    readUserFile, userRootOf, clickUndoLastSync, waitForSyncPopup,
    chooseConflictVersion, applyConflictChoices, waitForStatusChecks,
    backendCard, clickBackendMenu, conflictRow, openAddBackend, syncFlash,
} from '../_lib/sync.js';
import { accountWindow, answerWindowConfirm, formError, pageHead, windowConfirm, windowToast } from '../_lib/account-window.js';

let storage;
let servers = [];
let contexts = [];
let proxies = [];

test.beforeAll(async () => { storage = await startRustfsContainer(); });

test.afterEach(async () => {
    for (const context of contexts) await context.close();
    contexts = [];
    for (const server of servers) await tearDownServer(server);
    servers = [];
    for (const proxy of proxies) await proxy.close();
    proxies = [];
});

test.afterAll(async () => { await storage?.stop(); });

async function device(browser, name, extraEnv = {}) {
    const server = await startServer({ batchKey: 'sync', scenarioId: `unified-${name}-${randomBytes(4).toString('hex')}`, extraEnv });
    servers.push(server);
    if (process.env.LUKER_TASK11_ACTUAL_JITLESS === '1') {
        // Packaged deployments supply these genuine webpack outputs. Build
        // on normal Node, then serve the same bytes in the jitless process.
        const cache = path.join(server.dataRoot, '_webpack');
        const bundles = fs.readdirSync(cache).map(dir => path.join(cache, dir, 'output')).find(dir => fs.existsSync(path.join(dir, 'lib.core.bundle.js')));
        expect(bundles).toBeTruthy();
        await server.restart({ jitless: true, extraEnv: { LUKER_FORCE_JITLESS: '1', LUKER_PREBUILT_BUNDLES_DIR: bundles } });
    }
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await awaitMainUI(page, server.baseURL);
    await openLanSyncPanel(page);
    return { page, server };
}
async function bucket() {
    const name = `unified-${randomBytes(8).toString('hex')}`;
    const client = new S3Client({ endpoint: storage.endpoint, region: storage.region, forcePathStyle: true,
        credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey }, maxAttempts: 1 });
    try { await client.send(new CreateBucketCommand({ Bucket: name })); } finally { client.destroy(); }
    return name;
}
const row = (page, label) => backendCard(page, label);
/** Failure reason a backend card shows after a failed sync. */
const cardError = (page, label) => row(page, label).locator('.dw-card-note.bad');
/** Leave the form on the current Sync page with its Cancel button. */
async function cancelForm(page) {
    await accountWindow(page).locator('.dw-foot [data-act="back"]').click();
    await expect(pageHead(page)).toHaveAttribute('data-view', 'list');
}
/** True when an input anywhere in the document still holds `value`. */
const inputHolds = (page, value) => page.evaluate(wanted => [...document.querySelectorAll('input')].some(input => input.value === wanted), value);
/** Remove the result banner of an earlier action, then click Sync now on the card. */
async function clickCardSyncNow(page, label) {
    const close = syncFlash(page).locator('[data-act="flash-x"]');
    if (await close.count() > 0) await close.first().click();
    await expect(syncFlash(page)).toHaveCount(0);
    await row(page, label).locator('[data-act="sync-now"]').click();
}
/**
 * Fire every action of a backend card and its menu, as queued clicks would,
 * answering the confirmations they ask. A locked backend must admit none.
 */
async function fireCardActions(page, label) {
    for (const act of ['sync-now', 'undo', 'edit', 'unlock', 'remove']) {
        const card = row(page, label);
        if (act !== 'sync-now' && await card.locator('.dw-menu').count() === 0) await card.locator('[data-act="menu"]').click();
        const control = card.locator(`[data-act="${act}"]`);
        if (await control.count() === 0) continue;
        // Edit and Unlock of a locked backend are disabled controls.
        if (act === 'edit' || act === 'unlock') {
            await expect(control).toBeDisabled();
            continue;
        }
        await control.dispatchEvent('click');
        if ((act === 'undo' || act === 'remove') && await windowConfirm(page).count() > 0) await answerWindowConfirm(page);
        if (await card.locator('.dw-menu').count() > 0) await card.locator('[data-act="menu"]').click();
    }
}
const registry = server => JSON.parse(fs.readFileSync(path.join(userRootOf(server), '.sync/state.json'), 'utf8'));
const status = page => page.evaluate(async () => (await (await fetch('/api/sync/v1/status')).json()));
const checks = page => page.evaluate(() => Number(document.body.dataset.syncStatusChecks || 0));
async function corruptMetadata(server, backendId) {
    const gitdir = path.join(userRootOf(server), '.sync', backendId, 'repo.git');
    const oid = await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' });
    const { oid: blob } = await git.readBlob({ fs, gitdir, oid, filepath: '.luker-sync/conflicts.json' });
    const file = path.join(gitdir, 'objects', blob.slice(0, 2), blob.slice(2));
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, 'explicit corrupt pending metadata');
    return () => fs.writeFileSync(file, bytes);
}

test.describe('Unified Sync panel', () => {
    test.describe.configure({ timeout: 300_000 });

    test('LAN and S3 setup retains credentials privately and edits immutable identity', async ({ browser }) => {
        const { page: a } = await device(browser, 'a');
        const { page: b } = await device(browser, 'b');
        await expect(pageHead(a).locator('.dw-h2')).toHaveText('Sync');
        await setSyncDeviceLabel(a, 'Desk');
        await setSyncDeviceLabel(a, '');
        await expect(accountWindow(a).locator('[data-model="device.label"]')).toHaveValue('');
        // A blank name falls back to the resolved host name, shown as the placeholder.
        await expect(accountWindow(a).locator('[data-model="device.label"]')).toHaveAttribute('placeholder', /\S/);
        await setSyncSchedule(a, { idleSeconds: 3600, pollSeconds: 3600 });
        const options = { ...storage, bucket: await bucket(), prefix: 'shared/', label: 'Cloud',
            passphrase: 'unified test phrase', forcePathStyle: true, categories: ['worlds'] };
        const added = a.waitForResponse(r => r.url().endsWith('/backends/s3'));
        await addS3Backend(a, options);
        const publicBody = JSON.stringify(await (await added).json());
        for (const secret of [options.accessKeyId, options.secretAccessKey, options.passphrase]) expect(publicBody).not.toContain(secret);
        await waitForBackendSync(a, { label: 'Cloud' });
        await expect(row(a, 'Cloud')).toHaveAttribute('data-kind', 's3');
        await expect(row(a, 'Cloud').locator('.dw-kind')).toHaveText('S3');
        await clickBackendMenu(a, 'Cloud', 'edit');
        const form = accountWindow(a);
        // The region is free text with the known regions offered as suggestions.
        await expect(form.locator('[data-model="top.form.region"]')).toHaveAttribute('list', 'dw-regions');
        for (const field of ['accessKey', 'secretKey', 'passphrase']) await expect(form.locator(`[data-model="top.form.${field}"]`)).toHaveValue('');
        await expect(form.locator('[data-model="top.form.bucket"]')).toBeDisabled();
        await expect(form.locator('[data-model="top.form.prefix"]')).toBeDisabled();
        await form.locator('[data-model="top.form.secretKey"]').fill('cancelled-secret');
        await form.locator('[data-model="top.form.passphrase"]').fill('cancelled-phrase');
        await cancelForm(a);
        expect(await inputHolds(a, 'cancelled-secret')).toBe(false);
        expect(await inputHolds(a, 'cancelled-phrase')).toBe(false);
        const hostile = '<img src=x onerror="window.__syncXss=1">';
        await editSyncBackend(a, 'Cloud', { label: hostile });
        await expect(row(a, hostile).locator('img')).toHaveCount(0);
        expect(await a.evaluate(() => window.__syncXss)).toBeUndefined();
        await clickBackendMenu(a, hostile, 'unlock');
        await expect(accountWindow(a).locator('[data-model="top.form.endpoint"]')).toHaveCount(0);
        await accountWindow(a).locator('[data-model="top.form.pass"]').fill('wrong phrase');
        await accountWindow(a).locator('[data-act="unlock-save"]').click();
        await expect(formError(a)).toContainText('passphrase');
        await cancelForm(a);
        expect(await inputHolds(a, 'wrong phrase')).toBe(false);
        await unlockS3Backend(a, hostile, options.passphrase);
        await addS3Backend(b, { ...options, label: 'Shared cloud' });
        await waitForBackendSync(b, { label: 'Shared cloud' });
        const link = await generatePairingLink(a, { label: 'Tablet', categories: ['worlds'] });
        expect(await acceptPairingLink(b, link, { localLabel: 'Desk', categories: ['worlds'] })).toBe('success');
        await closeAllPopups(a);
        await openLanSyncPanel(a);
        await expect(pageHead(a)).toHaveAttribute('data-view', 'list');
        await expect(row(a, 'Tablet')).toHaveAttribute('data-kind', 'lan');
        await editSyncBackend(a, 'Tablet', { label: 'LAN tablet', categories: ['worlds'] });
        expect(await clickSyncNow(a, 'LAN tablet')).toBe('success');
        expect(await clickSyncNow(a, hostile)).toBe('success');
        await clickBackendMenu(a, hostile, 'remove');
        await expect(windowConfirm(a)).toContainText('bucket');
        await expect(windowConfirm(a).locator('img')).toHaveCount(0);
        await answerWindowConfirm(a, { confirm: false });
        await clickForgetPeer(a, hostile);
        await clickForgetPeer(a, 'LAN tablet');
        await expect(accountWindow(a).locator('.dw-card[data-backend]')).toHaveCount(0);
    });

    test('S3 Undo rejects an obstructed local apply without propagation and retains its undo point', async ({ browser }) => {
        const { page: a, server: serverA } = await device(browser, 'undo-a');
        const pause = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-task11-stalled-'));
        const { page: b, server: serverB } = await device(browser, 'undo-b', { LUKER_SYNC_PAUSEPOINT: 'local-edit-before-reconcile', LUKER_SYNC_PAUSE_DIR: pause });
        const options = { ...storage, bucket: await bucket(), prefix: 'undo/', label: 'Cloud', passphrase: 'undo phrase', forcePathStyle: true, categories: ['worlds'] };
        await addS3Backend(a, options);
        await waitForBackendSync(a, { label: 'Cloud' });
        await addS3Backend(b, options);
        await waitForBackendSync(b, { label: 'Cloud' });
        for (const page of [a, b]) await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
        await closeAllPopups(a);
        await createWorldBook(a, 'Undo Grove');
        await openLanSyncPanel(a);
        expect(await clickSyncNow(a, 'Cloud')).toBe('success');
        expect(await clickSyncNow(b, 'Cloud')).toBe('success');
        await closeAllPopups(a);
        await selectWorldBook(a, 'Undo Grove');
        await addWorldEntry(a, { key: 'oak', content: 'arrived from cloud' });
        await openLanSyncPanel(a);
        expect(await clickSyncNow(a, 'Cloud')).toBe('success');
        expect(await clickSyncNow(b, 'Cloud')).toBe('success');
        const rel = 'worlds/Undo Grove.json';
        expect(readUserFile(serverB, rel)).toContain('arrived from cloud');
        // Obstruct the admitted reconcile, not the snapshot's current user state.
        const file = path.join(userRootOf(serverB), rel);
        const bytes = fs.readFileSync(file);
        fs.writeFileSync(path.join(pause, 'local-edit-before-reconcile.arm'), '');
        const response = b.waitForResponse(r => r.url().endsWith('/undo'));
        const undo = clickUndoLastSync(b, 'Cloud');
        await expect.poll(() => fs.existsSync(path.join(pause, 'local-edit-before-reconcile.reached')), { timeout: 60_000 }).toBe(true);
        fs.unlinkSync(file);
        fs.mkdirSync(file);
        fs.writeFileSync(path.join(pause, 'local-edit-before-reconcile.release'), '');
        expect(await undo).toBe('error');
        const failed = await response;
        expect(failed.status()).toBe(409);
        expect(await failed.json()).toMatchObject({ ok: false, committed: false, propagation: null, code: 'UNDO_NOT_COMMITTED' });
        await expect(syncFlash(b).filter({ hasText: 'Undid the last sync' })).toHaveCount(0);
        expect(readUserFile(serverA, rel)).toContain('arrived from cloud');
        fs.rmdirSync(file);
        fs.writeFileSync(file, bytes);
        const retry = b.waitForResponse(r => r.url().endsWith('/undo'));
        expect(await clickUndoLastSync(b, 'Cloud')).toBe('success');
        expect(await (await retry).json()).toMatchObject({ committed: true, propagation: { ok: true } });
        expect(readUserFile(serverB, rel)).not.toContain('arrived from cloud');
        expect(await clickSyncNow(a, 'Cloud')).toBe('success');
        expect(readUserFile(serverA, rel)).not.toContain('arrived from cloud');
        await closeAllPopups(a);
        await serverB.restart({ extraEnv: { LUKER_SYNC_PAUSEPOINT: 'after-snapshot' } });
        // A new remote path isolates stalled live-CAS from the Undo history.
        await createWorldBook(a, 'Stalled Grove');
        await openLanSyncPanel(a);
        expect(await clickSyncNow(a, 'Cloud')).toBe('success');
        const stalledRel = 'worlds/Stalled Grove.json';
        const stalledFile = path.join(userRootOf(serverB), stalledRel);
        expect(fs.existsSync(stalledFile)).toBe(false);
        fs.writeFileSync(path.join(pause, 'after-snapshot.arm'), '');
        const stalledResponse = b.waitForResponse(response => response.url().endsWith('/sync'));
        const stalledSync = clickSyncNow(b, 'Cloud');
        await expect.poll(() => fs.existsSync(path.join(pause, 'after-snapshot.reached')), { timeout: 60_000 }).toBe(true);
        fs.mkdirSync(stalledFile);
        fs.writeFileSync(path.join(pause, 'after-snapshot.release'), '');
        try {
            expect(await stalledSync).toBe('warning');
            expect((await (await stalledResponse).json()).stalled).toContain(stalledRel);
            // Leave only the Sync issues page; keep the window that received
            // this run rather than allowing a fresh run to replace its state.
            await waitForSyncPopup(b);
            await pageHead(b).locator('[data-act="back"]').click();
            await expect(pageHead(b)).toHaveAttribute('data-view', 'list');
            await expect(row(b, 'Cloud').locator('.dw-stalled code')).toHaveText(stalledRel);
        } finally {
            fs.rmdirSync(stalledFile);
        }
    });

    test('Sync controls and errors translate through the language selector', async ({ browser }) => {
        const { page, server } = await device(browser, 'locales');
        await addS3Backend(page, { ...storage, bucket: await bucket(), prefix: 'locale/', label: 'Locale cloud', passphrase: 'locale phrase', forcePathStyle: true, categories: ['worlds'] });
        await waitForBackendSync(page, { label: 'Locale cloud' });
        await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
        const state = registry(server);
        Object.values(state.backends)[0].s3.keyId = 'invalid';
        fs.writeFileSync(path.join(userRootOf(server), '.sync/state.json'), JSON.stringify(state));
        for (const [locale, words] of [
            ['zh-cn', { title: '同步', add: '添加', s3: '使用 S3 存储', invalid: '此后端的密钥标识无效或已更改。请移除后重新添加。解锁不能更改其标识。', name: '本机名称', save: '保存', remove: '移除' }],
            ['zh-tw', { title: '同步', add: '新增', s3: '使用 S3 儲存', invalid: '此後端的金鑰識別無效或已變更。請移除後重新新增。解鎖不能變更其識別。', name: '本機名稱', save: '儲存', remove: '移除' }],
            ['en', { title: 'Sync', add: 'Add', s3: 'Use S3 storage', invalid: 'This backend\'s key identity is invalid or changed. Remove it and add it again. Unlock cannot change its identity.', name: 'Device name', save: 'Save', remove: 'Remove' }],
        ]) {
            await closeAllPopups(page);
            // The panel navigation leaves the settings drawer open.
            await Promise.all([page.waitForEvent('load'), page.locator('#ui_language_select').selectOption(locale)]);
            await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext);
            await openLanSyncPanel(page);
            await expect(pageHead(page).locator('.dw-h2')).toHaveText(words.title);
            await expect(pageHead(page).locator('[data-act="push"][data-view="add"]')).toHaveText(words.add);
            await setSyncDeviceLabel(page, 'Glade');
            await expect(accountWindow(page).locator('.dw-setrow', { has: page.locator('[data-model="device.label"]') }).locator('span').first()).toHaveText(words.name);
            await expect(accountWindow(page).locator('[data-act="save-local"]')).toHaveText(words.save);
            await openLanSyncPanel(page);
            await pageHead(page).locator('[data-act="push"][data-view="add"]').click();
            await expect(accountWindow(page).locator('.dw-option[data-view="s3"]')).toHaveText(words.s3);
            await openAddBackend(page, 's3');
            await expect(accountWindow(page).locator('[data-act="s3-save"]')).toHaveText(words.save);
            await accountWindow(page).locator('[data-act="s3-save"]').click();
            await expect(formError(page)).toBeVisible();
            await cancelForm(page);
            await clickBackendMenu(page, 'Locale cloud', 'unlock');
            await accountWindow(page).locator('[data-model="top.form.pass"]').fill('locale phrase');
            await accountWindow(page).locator('[data-act="unlock-save"]').click();
            await expect(formError(page)).toHaveText(words.invalid);
            await cancelForm(page);
            await row(page, 'Locale cloud').locator('[data-act="menu"]').click();
            await expect(row(page, 'Locale cloud').locator('.dw-menu [data-act="remove"]')).toHaveText(words.remove);
            await row(page, 'Locale cloud').locator('[data-act="menu"]').click();
        }
    });

    test('readable LAN choices survive S3 pending errors and backend refreshes', async ({ browser }) => {
        const { page: a } = await device(browser, 'pending-a');
        const { page: b, server: serverB } = await device(browser, 'pending-b');
        const { page: c } = await device(browser, 'pending-c');
        const options = { ...storage, bucket: await bucket(), prefix: 'pending/', label: 'Cloud', passphrase: 'pending phrase', forcePathStyle: true, categories: ['worlds'] };
        const link = await generatePairingLink(a, { label: 'B', categories: ['worlds'] });
        expect(await acceptPairingLink(b, link, { localLabel: 'LAN A', categories: ['worlds'] })).toBe('success');
        await addS3Backend(b, options);
        await waitForBackendSync(b, { label: 'Cloud' });
        await addS3Backend(c, options);
        await waitForBackendSync(c, { label: 'Cloud' });
        for (const page of [a, b, c]) await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
        for (const page of [a, b, c]) await closeAllPopups(page);
        await createWorldBook(a, 'LAN Grove');
        await openLanSyncPanel(a);
        expect(await clickSyncNow(a, 'B')).toBe('success');
        await closeAllPopups(a);
        await reloadAndAwait(b, serverB.baseURL);
        for (const [page, side] of [[a, 'A'], [b, 'B']]) {
            await selectWorldBook(page, 'LAN Grove');
            await addWorldEntry(page, { key: side, content: `LAN version ${side}` });
        }
        await openLanSyncPanel(b);
        expect(await clickSyncNow(b, 'LAN A')).toBe('warning');
        await closeAllPopups(b);
        await createWorldBook(c, 'Cloud Grove');
        await openLanSyncPanel(c);
        expect(await clickSyncNow(c, 'Cloud')).toBe('success');
        await openLanSyncPanel(b);
        expect(await clickSyncNow(b, 'Cloud')).toBe('success');
        await closeAllPopups(b);
        await reloadAndAwait(b, serverB.baseURL);
        await closeAllPopups(b);
        await closeAllPopups(c);
        for (const [page, side] of [[b, 'B'], [c, 'C']]) {
            await selectWorldBook(page, 'Cloud Grove');
            await addWorldEntry(page, { key: side, content: `cloud version ${side}` });
        }
        await openLanSyncPanel(c);
        expect(await clickSyncNow(c, 'Cloud')).toBe('success');
        await openLanSyncPanel(b);
        expect(await clickSyncNow(b, 'Cloud')).toBe('warning');
        await waitForSyncPopup(b);
        const cloudId = Object.entries(registry(serverB).backends).find(([, entry]) => entry.kind === 's3')[0];
        const restore = await corruptMetadata(serverB, cloudId);
        const lanPath = 'worlds/LAN Grove.json';
        const cloudPath = 'worlds/Cloud Grove.json';
        const conflict = rel => conflictRow(b, rel);
        try {
            await waitForStatusChecks(b, await checks(b) + 1);
            const pending = await status(b);
            expect(pending).toMatchObject({ ok: false, errors: { [cloudId]: { code: 'PENDING_READ_FAILED' } } });
            expect(pending.conflicts.find(entry => entry.path === lanPath).recordVersions).toBeTruthy();
            // A conflict whose records could not be read offers no choice.
            for (const version of await conflict(cloudPath).locator('.dw-version').all()) await expect(version).toBeDisabled();
            await expect(windowToast(b, 'already handled on another device')).toHaveCount(0);
            await expect(conflict(lanPath).locator('.dw-version[data-v="current"]')).toBeEnabled();
            await chooseConflictVersion(b, lanPath, 'current');
            const response = b.waitForResponse(r => r.url().endsWith('/conflicts/resolve'));
            expect(await applyConflictChoices(b)).toBe('error');
            const actual = await response;
            expect(actual.status()).toBe(200);
            const resolved = await actual.json();
            expect(resolved.ok).toBe(false);
            expect(resolved.errors[cloudId].code).toBe('PENDING_READ_FAILED');
            const lanId = Object.entries(registry(serverB).backends).find(([, entry]) => entry.kind === 'lan')[0];
            expect(resolved.results[0].committedBackends).toEqual([lanId]);
            await expect(windowToast(b, 'Applied')).toHaveCount(0);
            await openLanSyncPanel(b);
            await expect(row(b, 'Cloud')).toHaveAttribute('data-state', 'unknown');
            await expect(row(b, 'Cloud').locator('.dw-card-meta')).toContainText('Pending records could not be read');
            // A real list refresh after an action must retain the pending error state.
            await editSyncBackend(b, 'LAN A', { label: 'LAN A renamed' });
            await expect(row(b, 'Cloud')).toHaveAttribute('data-state', 'unknown');
            await expect(row(b, 'Cloud').locator('.dw-card-meta')).toContainText('Pending records could not be read');
        } finally { restore(); }
        await waitForStatusChecks(b, await checks(b) + 1);
        await waitForSyncPopup(b);
        await expect(conflict(cloudPath).locator('.dw-version[data-v="current"]')).toBeEnabled();
        await chooseConflictVersion(b, cloudPath, 'current');
        expect(await applyConflictChoices(b)).toBe('success');
    });

    test('invalid local S3 key identity requires Remove and Add rather than Unlock adoption', async ({ browser }) => {
        const { page, server } = await device(browser, 'identity');
        await addS3Backend(page, { ...storage, bucket: await bucket(), prefix: 'identity/', label: 'Identity cloud', passphrase: 'identity phrase', forcePathStyle: true, categories: ['worlds'] });
        await waitForBackendSync(page, { label: 'Identity cloud' });
        await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
        const file = path.join(userRootOf(server), '.sync/state.json');
        const state = registry(server);
        const id = Object.keys(state.backends)[0];
        // Explicit identity-corruption fixture, not a setup shortcut.
        state.backends[id].s3.keyId = 'invalid';
        fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
        await clickBackendMenu(page, 'Identity cloud', 'unlock');
        await accountWindow(page).locator('[data-model="top.form.pass"]').fill('identity phrase');
        const response = page.waitForResponse(r => r.url().endsWith('/unlock'));
        await accountWindow(page).locator('[data-act="unlock-save"]').click();
        expect(await (await response).json()).toMatchObject({ code: 'S3_LOCAL_KEY_ID_INVALID' });
        await expect(formError(page)).toContainText('Remove it and add it again');
        expect(registry(server).backends[id].s3.keyId).toBe('invalid');
        await cancelForm(page);
        await clickForgetPeer(page, 'Identity cloud');
    });

    test('list refresh shows a running S3 backend and a real provider failure', async ({ browser }) => {
        const proxy = await startS3Proxy({ upstream: storage.endpoint, region: storage.region,
            credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey } });
        proxies.push(proxy);
        const { page } = await device(browser, 'running');
        await addS3Backend(page, { ...storage, endpoint: proxy.endpoint, bucket: await bucket(), prefix: 'running/', label: 'Slow cloud', passphrase: 'running phrase', forcePathStyle: true, categories: ['worlds'] });
        await waitForBackendSync(page, { label: 'Slow cloud' });
        await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
        const held = proxy.addFault({ match: { method: 'GET', keySuffix: '/head' }, hold: 'before-forward' });
        await openLanSyncPanel(page);
        await clickCardSyncNow(page, 'Slow cloud');
        await held.reached;
        await expect(row(page, 'Slow cloud')).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
        held.release();
        await expect(syncFlash(page)).toHaveAttribute('data-flash', 'success', { timeout: 60_000 });
        await proxy.close();
        proxies = [];
        expect(await clickSyncNow(page, 'Slow cloud')).toBe('error');
        await expect(row(page, 'Slow cloud')).toHaveAttribute('data-state', 'error');
        await expect(cardError(page, 'Slow cloud')).toBeVisible();
        // The card still shows when the last sync happened.
        await expect(row(page, 'Slow cloud').locator('.dw-card-meta')).not.toContainText('Never synced');
    });

    for (const action of ['sync', 'undo', 'edit', 'remove']) test(`pending ${action} cannot admit backend actions after list and status refresh`, async ({ browser }) => {
        const { page } = await device(browser, `pending-${action}`);
        await addS3Backend(page, { ...storage, bucket: await bucket(), prefix: 'pending-action/', label: 'Pending cloud', passphrase: 'pending action phrase', forcePathStyle: true, categories: ['worlds'] });
        await waitForBackendSync(page, { label: 'Pending cloud' });
        await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
        await openLanSyncPanel(page);
        const id = await row(page, 'Pending cloud').getAttribute('data-backend');
        const endpoint = `/api/sync/v1/backends/${id}${action === 'edit' ? '/s3' : action === 'remove' ? '' : `/${action}`}`;
        let release;
        let reached;
        const barrier = new Promise(resolve => { release = resolve; });
        const held = new Promise(resolve => { reached = resolve; });
        const writes = [];
        const capture = request => {
            if (new URL(request.url()).pathname.startsWith(`/api/sync/v1/backends/${id}`) && request.method() !== 'GET') writes.push(request);
        };
        page.on('request', capture);
        // Hold a genuine browser request, then forward it to the real route.
        // Remove is held before forwarding so the row still exists to refresh.
        await page.route(`**${endpoint}`, async route => {
            reached();
            await barrier;
            const response = await route.fetch();
            await route.fulfill({ response });
        });
        const primary = row(page, 'Pending cloud');
        if (action === 'edit') {
            await clickBackendMenu(page, 'Pending cloud', 'edit');
            await accountWindow(page).locator('[data-act="s3-save"]').click();
        } else if (action === 'remove' || action === 'undo') {
            await clickBackendMenu(page, 'Pending cloud', action);
            await answerWindowConfirm(page);
        } else await primary.locator('[data-act="sync-now"]').click();
        await held;
        // The edit form stays open while its save is pending; go back to the
        // list, which keeps the backend's action lock until the save settles.
        if (action === 'edit') await cancelForm(page);
        const originalRow = await primary.elementHandle();
        const refreshed = page.waitForResponse(response => response.url().endsWith('/api/sync/v1/status') && response.ok());
        await refreshed;
        await expect.poll(() => originalRow.evaluate(node => node.isConnected)).toBe(false);
        try {
            await expect(primary).toHaveClass(/\blocked\b/);
            // Exercise handlers as well as disabled rendering, including
            // clicks already queued when a status render replaces a card.
            await fireCardActions(page, 'Pending cloud');
            await expect(pageHead(page)).toHaveAttribute('data-view', 'list');
            const nextRefresh = page.waitForResponse(response => response.url().endsWith('/api/sync/v1/backends') && response.ok());
            await nextRefresh;
            await expect(primary).toHaveClass(/\blocked\b/);
            expect(writes).toHaveLength(1);
            const completed = page.waitForResponse(response => new URL(response.url()).pathname === endpoint);
            release();
            const response = await completed;
            // Undo has no point yet; its genuine 404 is still a pending action.
            expect(response.status()).toBe(action === 'remove' ? 204 : action === 'undo' ? 404 : 200);
        } finally {
            release();
            page.off('request', capture);
        }
    });

    for (const { mode, phrase, statusCode, close } of [
        // Escape closes the whole Account window; Cancel leaves only the form.
        { mode: 'edit', phrase: 'cancel phrase', statusCode: 200, close: 'Escape' },
        { mode: 'edit', phrase: 'wrong phrase', statusCode: 422, close: 'Cancel' },
        { mode: 'unlock', phrase: 'cancel phrase', statusCode: 200, close: 'Cancel' },
        { mode: 'unlock', phrase: 'wrong phrase', statusCode: 422, close: 'Escape' },
    ]) test(`cancel pending ${mode} with HTTP ${statusCode} retains admission until settlement`, async ({ browser }) => {
        const { page } = await device(browser, `cancel-${mode}-${statusCode}`);
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        await addS3Backend(page, { ...storage, bucket: await bucket(), prefix: 'cancel/', label: 'Cancel cloud', passphrase: 'cancel phrase', forcePathStyle: true, categories: ['worlds'] });
        await waitForBackendSync(page, { label: 'Cancel cloud' });
        await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
        await openLanSyncPanel(page);
        const primary = row(page, 'Cancel cloud');
        const id = await primary.getAttribute('data-backend');
        const endpoint = `/api/sync/v1/backends/${id}/${mode === 'edit' ? 's3' : 'unlock'}`;
        let release;
        let reached;
        const barrier = new Promise(resolve => { release = resolve; });
        const held = new Promise(resolve => { reached = resolve; });
        const writes = [];
        page.on('request', request => {
            if (new URL(request.url()).pathname.startsWith(`/api/sync/v1/backends/${id}`) && request.method() !== 'GET') writes.push(request.url());
        });
        await page.route(`**${endpoint}`, async route => {
            reached();
            await barrier;
            const response = await route.fetch();
            await route.fulfill({ response });
        });
        await clickBackendMenu(page, 'Cancel cloud', mode);
        const passphrase = accountWindow(page).locator(`[data-model="top.form.${mode === 'edit' ? 'passphrase' : 'pass'}"]`);
        await passphrase.fill(phrase);
        await accountWindow(page).locator(`[data-act="${mode === 'edit' ? 's3-save' : 'unlock-save'}"]`).click();
        await held;
        try {
            if (close === 'Escape') {
                await page.keyboard.press('Escape');
                await expect(accountWindow(page)).toHaveCount(0);
                await openLanSyncPanel(page);
            } else await cancelForm(page);
            expect(await inputHolds(page, phrase)).toBe(false);
            await expect(pageHead(page)).toHaveAttribute('data-view', 'list');
            const original = await primary.elementHandle();
            await page.waitForResponse(response => response.url().endsWith('/api/sync/v1/status') && response.ok());
            await expect.poll(() => original.evaluate(node => node.isConnected)).toBe(false);
            await expect(primary).toHaveClass(/\blocked\b/);
            await fireCardActions(page, 'Cancel cloud');
            await page.waitForResponse(response => response.url().endsWith('/api/sync/v1/backends') && response.ok());
            await expect(primary).toHaveClass(/\blocked\b/);
            expect(writes).toHaveLength(1);
            await expect(pageHead(page)).toHaveAttribute('data-view', 'list');
            const completed = page.waitForResponse(response => new URL(response.url()).pathname === endpoint);
            release();
            expect((await completed).status()).toBe(statusCode);
            await expect(primary).not.toHaveClass(/\blocked\b/);
            await clickBackendMenu(page, 'Cancel cloud', 'edit');
            await expect(accountWindow(page).locator('[data-model="top.form.passphrase"]')).toHaveValue('');
            await cancelForm(page);
            await closeAllPopups(page);
            await openLanSyncPanel(page);
            await expect(primary).not.toHaveClass(/\blocked\b/);
            expect(pageErrors).toEqual([]);
        } finally { release(); }
    });

    test('S3 runtime Sync and Undo failures show actionable locale text in the result banner and backend card', async ({ browser }) => {
        const proxy = await startS3Proxy({ upstream: storage.endpoint, region: storage.region,
            credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey } });
        proxies.push(proxy);
        const { page } = await device(browser, 'runtime-locales');
        const options = { ...storage, bucket: await bucket(), prefix: 'runtime/', label: 'Runtime cloud', passphrase: 'runtime phrase', forcePathStyle: true, categories: ['worlds'] };
        const fixture = new S3Client({ endpoint: storage.endpoint, region: storage.region, forcePathStyle: true, credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey }, maxAttempts: 1 });
        await addS3Backend(page, { ...options, endpoint: proxy.endpoint });
        await waitForBackendSync(page, { label: 'Runtime cloud' });
        await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
        const { page: publisher } = await device(browser, 'runtime-publisher');
        await addS3Backend(publisher, options);
        await waitForBackendSync(publisher, { label: 'Runtime cloud' });
        await setSyncSchedule(publisher, { idleSeconds: 3600, pollSeconds: 3600 });
        // The result banner wraps the reason in "Sync with … failed: …"; the
        // card shows the reason of the last failed sync on its own.
        for (const [locale, message, auth, missing] of [
            ['en', 'The S3 endpoint could not be reached.', 'S3 authentication failed. Check the credentials and bucket permissions.', 'The encryption metadata is missing. Restore it before syncing.'],
            ['zh-cn', '无法连接 S3 端点。', 'S3 身份验证失败。请检查凭据及存储桶权限。', '缺少加密元数据。请恢复后再同步。'],
            ['zh-tw', '無法連線至 S3 端點。', 'S3 驗證失敗。請檢查憑證及儲存桶權限。', '缺少加密中繼資料。請還原後再同步。'],
        ]) {
            await closeAllPopups(page);
            await closeAllPopups(publisher);
            await createWorldBook(publisher, `Runtime ${locale}`);
            await openLanSyncPanel(publisher);
            expect(await clickSyncNow(publisher, 'Runtime cloud')).toBe('success');
            await openLanSyncPanel(page);
            await clickCardSyncNow(page, 'Runtime cloud');
            await expect(syncFlash(page)).toHaveAttribute('data-flash', 'success', { timeout: 60_000 });
            await closeAllPopups(page);
            await Promise.all([page.waitForEvent('load'), page.locator('#ui_language_select').selectOption(locale)]);
            await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext);
            await openLanSyncPanel(page);
            proxy.addFault({ match: { method: 'GET', keySuffix: '/keyinfo.json' }, dropConnection: true });
            const sync = page.waitForResponse(response => response.url().endsWith('/sync'));
            await clickCardSyncNow(page, 'Runtime cloud');
            expect(await (await sync).json()).toMatchObject({ ok: false, code: 'UNREACHABLE' });
            await expect(syncFlash(page)).toHaveAttribute('data-flash', 'error');
            await expect(syncFlash(page)).toContainText(message);
            await expect(cardError(page, 'Runtime cloud')).toHaveText(message);
            proxy.addFault({ match: { method: 'GET', keySuffix: '/keyinfo.json' }, invalidSignature: true });
            const authResponse = page.waitForResponse(response => response.url().endsWith('/sync'));
            await clickCardSyncNow(page, 'Runtime cloud');
            expect(await (await authResponse).json()).toMatchObject({ code: 'AUTH_FAILED' });
            await expect(syncFlash(page)).toHaveAttribute('data-flash', 'error');
            await expect(syncFlash(page)).toContainText(auth);
            await expect(cardError(page, 'Runtime cloud')).toHaveText(auth);
            // Narrow remote-corruption fixture: preserve exact keyinfo bytes.
            const key = 'runtime/keyinfo.json';
            const object = await fixture.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
            const bytes = await object.Body.transformToByteArray();
            await fixture.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
            try {
                const missingResponse = page.waitForResponse(response => response.url().endsWith('/sync'));
                await clickCardSyncNow(page, 'Runtime cloud');
                expect(await (await missingResponse).json()).toMatchObject({ code: 'S3_KEYINFO_MISSING' });
                await expect(syncFlash(page)).toHaveAttribute('data-flash', 'error');
                await expect(syncFlash(page)).toContainText(missing);
                await expect(cardError(page, 'Runtime cloud')).toHaveText(missing);
            } finally { await fixture.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: bytes })); }
            // A genuine local Undo commits before the forwarding proxy drops
            // propagation's authentication read. It must not report success.
            proxy.addFault({ match: { method: 'GET', keySuffix: '/keyinfo.json' }, dropConnection: true });
            const undo = page.waitForResponse(response => response.url().endsWith('/undo'));
            await syncFlash(page).locator('[data-act="flash-x"]').click();
            await clickBackendMenu(page, 'Runtime cloud', 'undo');
            await answerWindowConfirm(page);
            expect(await (await undo).json()).toMatchObject({ ok: false, committed: true, propagation: { ok: false, code: 'UNREACHABLE' } });
            await expect(syncFlash(page)).toHaveAttribute('data-flash', 'error');
            await expect(syncFlash(page)).toContainText(message);
            await expect(cardError(page, 'Runtime cloud')).toHaveText(message);
            await closeAllPopups(page);
            await Promise.all([page.waitForEvent('load'), page.locator('#ui_language_select').selectOption('en')]);
            await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext);
            await openLanSyncPanel(page);
        }
        fixture.destroy();
    });
});
