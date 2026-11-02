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
    syncPopup, chooseConflictVersion, applyConflictChoices, waitForStatusChecks, closeSyncPopup,
} from '../_lib/sync.js';

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
const row = (page, label) => page.locator('.lanSyncPeerRow').filter({ has: page.locator('.lanSyncPeerLabel', { hasText: label }) });
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
        await expect(a.locator('.userLanSync h3')).toHaveText('Sync');
        await setSyncDeviceLabel(a, 'Desk');
        await setSyncDeviceLabel(a, '');
        await expect(a.locator('.syncDeviceLabel')).toHaveValue('');
        await expect(a.locator('.syncDeviceLabelResolved')).not.toHaveText('');
        await setSyncSchedule(a, { idleSeconds: 3600, pollSeconds: 3600 });
        const options = { ...storage, bucket: await bucket(), prefix: 'shared/', label: 'Cloud',
            passphrase: 'unified test phrase', forcePathStyle: true, categories: ['worlds'] };
        const added = a.waitForResponse(r => r.url().endsWith('/backends/s3'));
        await addS3Backend(a, options);
        const publicBody = JSON.stringify(await (await added).json());
        for (const secret of [options.accessKeyId, options.secretAccessKey, options.passphrase]) expect(publicBody).not.toContain(secret);
        await waitForBackendSync(a, { label: 'Cloud' });
        await expect(row(a, 'Cloud')).toHaveAttribute('data-kind', 's3');
        await expect(row(a, 'Cloud').locator('.syncBackendKind')).toHaveText('S3');
        await row(a, 'Cloud').locator('.syncBackendEditButton').click();
        await expect(a.locator('.syncS3Region')).toHaveJSProperty('tagName', 'SELECT');
        for (const field of ['AccessKeyId', 'SecretAccessKey', 'Passphrase']) await expect(a.locator(`.syncS3${field}`)).toHaveValue('');
        await expect(a.locator('.syncS3Bucket')).toHaveAttribute('readonly', '');
        await expect(a.locator('.syncS3Prefix')).toHaveAttribute('readonly', '');
        await a.locator('.syncS3SecretAccessKey').fill('cancelled-secret');
        const cancelledSecret = await a.locator('.syncS3SecretAccessKey').elementHandle();
        await a.locator('.syncS3Passphrase').fill('cancelled-phrase');
        const cancelledPhrase = await a.locator('.syncS3Passphrase').elementHandle();
        await a.keyboard.press('Escape');
        expect(await cancelledSecret.evaluate(input => input.value)).toBe('');
        expect(await cancelledPhrase.evaluate(input => input.value)).toBe('');
        const hostile = '<img src=x onerror="window.__syncXss=1">';
        await editSyncBackend(a, 'Cloud', { label: hostile });
        await expect(row(a, hostile).locator('img')).toHaveCount(0);
        expect(await a.evaluate(() => window.__syncXss)).toBeUndefined();
        await row(a, hostile).locator('.syncBackendUnlockButton').click();
        await expect(a.locator('.syncS3Endpoint')).toBeHidden();
        await a.locator('.syncS3Passphrase').fill('wrong phrase');
        const wrongPhrase = await a.locator('.syncS3Passphrase').elementHandle();
        await a.locator('.syncS3SaveButton').click();
        await expect(a.locator('.syncS3Error')).toContainText('passphrase');
        await a.keyboard.press('Escape');
        expect(await wrongPhrase.evaluate(input => input.value)).toBe('');
        await unlockS3Backend(a, hostile, options.passphrase);
        await addS3Backend(b, { ...options, label: 'Shared cloud' });
        await waitForBackendSync(b, { label: 'Shared cloud' });
        const link = await generatePairingLink(a, { label: 'Tablet', categories: ['worlds'] });
        expect(await acceptPairingLink(b, link, { localLabel: 'Desk', categories: ['worlds'] })).toBe('success');
        await closeAllPopups(a);
        await openLanSyncPanel(a);
        await expect(a.locator('.lanSyncPanelPeers')).toBeVisible();
        await expect(row(a, 'Tablet')).toHaveAttribute('data-kind', 'lan');
        await editSyncBackend(a, 'Tablet', { label: 'LAN tablet', categories: ['worlds'] });
        expect(await clickSyncNow(a, 'LAN tablet')).toBe('success');
        expect(await clickSyncNow(a, hostile)).toBe('success');
        await row(a, hostile).locator('.lanSyncPeerForgetButton').click();
        await expect(a.locator('dialog[open]').last()).toContainText('bucket');
        await expect(a.locator('dialog[open]').last().locator('.popup-content img')).toHaveCount(0);
        await a.locator('.popup-button-cancel').last().click();
        await clickForgetPeer(a, hostile);
        await clickForgetPeer(a, 'LAN tablet');
        await expect(a.locator('.lanSyncPeerRow')).toHaveCount(0);
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
        await expect(b.locator('.toast-success', { hasText: 'Reverted the last sync' })).toHaveCount(0);
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
            // Dismiss only the status overlay; keep the panel that received
            // this run rather than allowing a fresh run to replace its state.
            await waitForSyncPopup(b);
            await closeSyncPopup(b);
            await expect(row(b, 'Cloud').locator('.lanSyncPeerStalledPath')).toHaveText(stalledRel);
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
            ['zh-cn', { title: '同步', add: '添加 S3 后端', label: '保存设备名称', invalid: '此后端的密钥标识无效或已更改。请移除后重新添加。解锁不能更改其标识。', name: '后续编辑使用的名称：Glade', save: '保存', remove: '移除' }],
            ['zh-tw', { title: '同步', add: '新增 S3 後端', label: '儲存裝置名稱', invalid: '此後端的金鑰識別無效或已變更。請移除後重新新增。解鎖不能變更其識別。', name: '後續編輯使用的名稱：Glade', save: '儲存', remove: '移除' }],
            ['en', { title: 'Sync', add: 'Add S3 backend', label: 'Save device label', invalid: 'This backend\'s key identity is invalid or changed. Remove it and add it again. Unlock cannot change its identity.', name: 'Name for future edits: Glade', save: 'Save', remove: 'Remove' }],
        ]) {
            await closeAllPopups(page);
            // The panel navigation leaves the settings drawer open.
            await Promise.all([page.waitForEvent('load'), page.locator('#ui_language_select').selectOption(locale)]);
            await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext);
            await openLanSyncPanel(page);
            await expect(page.locator('.userLanSync h3')).toHaveText(words.title);
            await expect(page.locator('.syncAddS3Button')).toHaveText(words.add);
            await expect(page.locator('.syncSaveDeviceLabelButton')).toHaveText(words.label);
            await setSyncDeviceLabel(page, 'Glade');
            await expect(page.locator('.syncDeviceLabelResolved')).toHaveText(words.name);
            await page.locator('.syncAddS3Button').click();
            await expect(page.locator('.syncS3SaveButton')).toHaveText(words.save);
            await page.locator('.syncS3SaveButton').click();
            await expect(page.locator('.syncS3Error')).not.toHaveClass(/displayNone/);
            await page.keyboard.press('Escape');
            await row(page, 'Locale cloud').locator('.syncBackendUnlockButton').click();
            await page.locator('.syncS3Passphrase').fill('locale phrase');
            await page.locator('.syncS3SaveButton').click();
            await expect(page.locator('.syncS3Error')).toHaveText(words.invalid);
            await page.keyboard.press('Escape');
            await expect(row(page, 'Locale cloud').locator('.lanSyncPeerForgetButton')).toHaveText(words.remove);
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
        const conflict = rel => syncPopup(b).locator(`.syncConflictRow[data-path=${JSON.stringify(rel)}]`);
        try {
            await waitForStatusChecks(b, await checks(b) + 1);
            const pending = await status(b);
            expect(pending).toMatchObject({ ok: false, errors: { [cloudId]: { code: 'PENDING_READ_FAILED' } } });
            expect(pending.conflicts.find(entry => entry.path === lanPath).recordVersions).toBeTruthy();
            await expect(conflict(cloudPath).locator('.syncConflictUnknownNote')).toBeVisible();
            await expect(conflict(cloudPath).locator('.syncConflictResolvedNote')).toHaveCount(0);
            await expect(conflict(lanPath).locator('input[value="current"]')).toBeEnabled();
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
            await expect(b.locator('.toast-success', { hasText: 'Choices applied.' })).toHaveCount(0);
            await closeSyncPopup(b);
            await expect(row(b, 'Cloud').locator('.lanSyncPeerError')).toContainText('pending sync records');
            // A real list refresh after an action must retain the pending error overlay.
            await editSyncBackend(b, 'LAN A', { label: 'LAN A renamed' });
            await expect(row(b, 'Cloud').locator('.lanSyncPeerError')).toContainText('pending sync records');
        } finally { restore(); }
        await waitForStatusChecks(b, await checks(b) + 1);
        await waitForSyncPopup(b);
        await expect(conflict(cloudPath).locator('input[value="current"]')).toBeEnabled();
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
        await row(page, 'Identity cloud').locator('.syncBackendUnlockButton').click();
        await page.locator('.syncS3Passphrase').fill('identity phrase');
        const response = page.waitForResponse(r => r.url().endsWith('/unlock'));
        await page.locator('.syncS3SaveButton').click();
        expect(await (await response).json()).toMatchObject({ code: 'S3_LOCAL_KEY_ID_INVALID' });
        await expect(page.locator('.syncS3Error')).toContainText('Remove it and add it again');
        expect(registry(server).backends[id].s3.keyId).toBe('invalid');
        await page.keyboard.press('Escape');
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
        await row(page, 'Slow cloud').locator('.lanSyncPeerSyncButton').click();
        await held.reached;
        await expect(row(page, 'Slow cloud').locator('.lanSyncPeerRunning')).toBeVisible({ timeout: 15_000 });
        held.release();
        await expect(page.locator('.lanSyncStatusBanner.success')).toBeVisible({ timeout: 60_000 });
        await proxy.close();
        proxies = [];
        expect(await clickSyncNow(page, 'Slow cloud')).toBe('error');
        await expect(row(page, 'Slow cloud').locator('.lanSyncPeerError')).toContainText('Last sync failed');
        await expect(row(page, 'Slow cloud').locator('.lanSyncPeerMeta')).toContainText('Last sync:');
    });

    for (const action of ['sync', 'undo', 'edit', 'remove']) test(`pending ${action} cannot admit backend actions after list and status refresh`, async ({ browser }) => {
        const { page } = await device(browser, `pending-${action}`);
        await addS3Backend(page, { ...storage, bucket: await bucket(), prefix: 'pending-action/', label: 'Pending cloud', passphrase: 'pending action phrase', forcePathStyle: true, categories: ['worlds'] });
        await waitForBackendSync(page, { label: 'Pending cloud' });
        await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
        const id = await row(page, 'Pending cloud').getAttribute('data-backend-id');
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
            await primary.locator('.syncBackendEditButton').click();
            await page.locator('.syncS3SaveButton').click();
        } else if (action === 'remove' || action === 'undo') {
            await primary.locator(action === 'remove' ? '.lanSyncPeerForgetButton' : '.lanSyncPeerUndoButton').click();
            await page.locator('.popup-button-ok').last().click();
        } else await primary.locator('.lanSyncPeerSyncButton').click();
        await held;
        const originalRow = await primary.elementHandle();
        const refreshed = page.waitForResponse(response => response.url().endsWith('/api/sync/v1/status') && response.ok());
        await refreshed;
        await expect.poll(() => originalRow.evaluate(node => node.isConnected)).toBe(false);
        try {
            await expect(primary.locator('.backupActionRow')).toHaveClass(/disabled/);
            for (const selector of ['.lanSyncPeerSyncButton', '.lanSyncPeerUndoButton', '.syncBackendEditButton', '.syncBackendUnlockButton', '.lanSyncPeerForgetButton']) {
                // Exercise handlers as well as disabled rendering, including
                // clicks already queued when a status render replaces a row.
                await primary.locator(selector).dispatchEvent('click');
            }
            await expect(page.locator('.userSyncS3')).toHaveCount(action === 'edit' ? 1 : 0);
            const nextRefresh = page.waitForResponse(response => response.url().endsWith('/api/sync/v1/backends') && response.ok());
            await nextRefresh;
            await expect(primary.locator('.backupActionRow')).toHaveClass(/disabled/);
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
        const primary = row(page, 'Cancel cloud');
        const id = await primary.getAttribute('data-backend-id');
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
        await primary.locator(mode === 'edit' ? '.syncBackendEditButton' : '.syncBackendUnlockButton').click();
        await page.locator('.syncS3Passphrase').fill(phrase);
        const secret = await page.locator('.syncS3Passphrase').elementHandle();
        await page.locator('.syncS3SaveButton').click();
        await held;
        try {
            if (close === 'Escape') await page.keyboard.press('Escape');
            else await page.locator('dialog.popup[open]').last().locator('.popup-button-ok').click();
            expect(await secret.evaluate(input => input.value)).toBe('');
            await expect(page.locator('.userSyncS3')).toHaveCount(0);
            const original = await primary.elementHandle();
            await page.waitForResponse(response => response.url().endsWith('/api/sync/v1/status') && response.ok());
            await expect.poll(() => original.evaluate(node => node.isConnected)).toBe(false);
            await expect(primary.locator('.backupActionRow')).toHaveClass(/disabled/);
            for (const selector of ['.lanSyncPeerSyncButton', '.lanSyncPeerUndoButton', '.syncBackendEditButton', '.syncBackendUnlockButton', '.lanSyncPeerForgetButton']) await primary.locator(selector).dispatchEvent('click');
            await page.waitForResponse(response => response.url().endsWith('/api/sync/v1/backends') && response.ok());
            await expect(primary.locator('.backupActionRow')).toHaveClass(/disabled/);
            expect(writes).toHaveLength(1);
            await expect(page.locator('.userSyncS3')).toHaveCount(0);
            const completed = page.waitForResponse(response => new URL(response.url()).pathname === endpoint);
            release();
            expect((await completed).status()).toBe(statusCode);
            await expect(primary.locator('.backupActionRow')).not.toHaveClass(/disabled/);
            await primary.locator('.syncBackendEditButton').click();
            await expect(page.locator('.syncS3Passphrase')).toHaveValue('');
            await page.keyboard.press('Escape');
            await closeAllPopups(page);
            await openLanSyncPanel(page);
            await expect(primary.locator('.backupActionRow')).not.toHaveClass(/disabled/);
            expect(pageErrors).toEqual([]);
        } finally { release(); }
    });

    test('S3 runtime Sync and Undo failures show actionable locale text in the banner and list', async ({ browser }) => {
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
        for (const [locale, message, lastSync, auth, missing, failurePrefix] of [
            ['en', 'The S3 endpoint could not be reached.', 'Last sync failed: The S3 endpoint could not be reached.', 'S3 authentication failed. Check the credentials and bucket permissions.', 'The encryption metadata is missing. Restore it before syncing.', 'Last sync failed: '],
            ['zh-cn', '无法连接 S3 端点。', '上次同步失败：无法连接 S3 端点。', 'S3 身份验证失败。请检查凭据及存储桶权限。', '缺少加密元数据。请恢复后再同步。', '上次同步失败：'],
            ['zh-tw', '無法連線至 S3 端點。', '上次同步失敗：無法連線至 S3 端點。', 'S3 驗證失敗。請檢查憑證及儲存桶權限。', '缺少加密中繼資料。請還原後再同步。', '上次同步失敗：'],
        ]) {
            await closeAllPopups(page);
            await closeAllPopups(publisher);
            await createWorldBook(publisher, `Runtime ${locale}`);
            await openLanSyncPanel(publisher);
            expect(await clickSyncNow(publisher, 'Runtime cloud')).toBe('success');
            await openLanSyncPanel(page);
            await row(page, 'Runtime cloud').locator('.lanSyncPeerSyncButton').click();
            await expect(page.locator('.lanSyncStatusBanner.success')).toBeVisible({ timeout: 60_000 });
            await closeAllPopups(page);
            await Promise.all([page.waitForEvent('load'), page.locator('#ui_language_select').selectOption(locale)]);
            await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext);
            await openLanSyncPanel(page);
            proxy.addFault({ match: { method: 'GET', keySuffix: '/keyinfo.json' }, dropConnection: true });
            const sync = page.waitForResponse(response => response.url().endsWith('/sync'));
            await row(page, 'Runtime cloud').locator('.lanSyncPeerSyncButton').click();
            expect(await (await sync).json()).toMatchObject({ ok: false, code: 'UNREACHABLE' });
            await expect(page.locator('.lanSyncStatusBanner.error')).toHaveText(message);
            await expect(row(page, 'Runtime cloud').locator('.lanSyncPeerError')).toHaveText(lastSync);
            proxy.addFault({ match: { method: 'GET', keySuffix: '/keyinfo.json' }, invalidSignature: true });
            const authResponse = page.waitForResponse(response => response.url().endsWith('/sync'));
            await row(page, 'Runtime cloud').locator('.lanSyncPeerSyncButton').click();
            expect(await (await authResponse).json()).toMatchObject({ code: 'AUTH_FAILED' });
            await expect(page.locator('.lanSyncStatusBanner.error')).toHaveText(auth);
            await expect(row(page, 'Runtime cloud').locator('.lanSyncPeerError')).toHaveText(failurePrefix + auth);
            // Narrow remote-corruption fixture: preserve exact keyinfo bytes.
            const key = 'runtime/keyinfo.json';
            const object = await fixture.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
            const bytes = await object.Body.transformToByteArray();
            await fixture.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
            try {
                const missingResponse = page.waitForResponse(response => response.url().endsWith('/sync'));
                await row(page, 'Runtime cloud').locator('.lanSyncPeerSyncButton').click();
                expect(await (await missingResponse).json()).toMatchObject({ code: 'S3_KEYINFO_MISSING' });
                await expect(page.locator('.lanSyncStatusBanner.error')).toHaveText(missing);
                await expect(row(page, 'Runtime cloud').locator('.lanSyncPeerError')).toHaveText(failurePrefix + missing);
            } finally { await fixture.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: bytes })); }
            // A genuine local Undo commits before the forwarding proxy drops
            // propagation's authentication read. It must not toast success.
            proxy.addFault({ match: { method: 'GET', keySuffix: '/keyinfo.json' }, dropConnection: true });
            const undo = page.waitForResponse(response => response.url().endsWith('/undo'));
            await row(page, 'Runtime cloud').locator('.lanSyncPeerUndoButton').click();
            await page.locator('.popup-button-ok').last().click();
            expect(await (await undo).json()).toMatchObject({ ok: false, committed: true, propagation: { ok: false, code: 'UNREACHABLE' } });
            await expect(page.locator('.lanSyncStatusBanner.error')).toHaveText(message);
            await expect(row(page, 'Runtime cloud').locator('.lanSyncPeerError')).toHaveText(lastSync);
            await closeAllPopups(page);
            await Promise.all([page.waitForEvent('load'), page.locator('#ui_language_select').selectOption('en')]);
            await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext);
            await openLanSyncPanel(page);
        }
        fixture.destroy();
    });
});
