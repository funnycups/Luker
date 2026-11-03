import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Fixture, awaitS3Page, createReadyWorldBook, reloadS3Page } from '../_lib/sync-s3.js';
import { createUserViaAdminUI } from '../_lib/page.js';
import { accountWindow, answerWindowConfirm, closeAccountWindow, formError, openAdminUser } from '../_lib/account-window.js';
import { closeChatPopups as closeAllPopups } from '../_lib/s3-chat.js';
import { startHttpFixture } from '../../sync/_lib/network-fixtures.js';
import { loginAs, openLanSyncPanel, addS3Backend, fillS3Form, waitForBackendSync, setSyncSchedule,
    generatePairingLink, acceptPairingLink, waitForBackgroundSync, openAddBackend } from '../_lib/sync.js';

const fixture = s3Fixture(test);
test.use({ actionTimeout: 30_000 });
const password = 'Task14 account password';
const readBackends = page => page.evaluate(async () => (await fetch('/api/sync/v1/backends')).json());
const readStatus = page => page.evaluate(async () => (await fetch('/api/sync/v1/status')).json());

async function accountServer(browser, name, allowPrivateAddressesForUsers) {
    const device = await fixture.device(browser, name);
    await device.server.restart({ extraConfig: { enableUserAccounts: true, 'sync.allowPrivateAddressesForUsers': allowPrivateAddressesForUsers } });
    await loginAs(device.page, device.server.baseURL, { handle: 'default-user', password: '' });
    await awaitS3Page(device.page);
    return device;
}

async function createUser(admin, handle) {
    await closeAllPopups(admin.page);
    await createUserViaAdminUI(admin.page, { handle, name: handle, password });
    await closeAllPopups(admin.page);
}

async function userPage(browser, device, handle) {
    const context = await browser.newContext({ timezoneId: 'UTC' });
    const page = await context.newPage();
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings/save' && response.request().method() === 'POST');
    const observedSave = saved.then(response => ({ response }), error => ({ error }));
    try {
        await loginAs(page, device.server.baseURL, { handle, password }); await awaitS3Page(page);
        const welcome = page.locator('dialog.popup[open]', { has: page.locator('.onboarding') });
        await expect(welcome).toHaveCount(0);
        const result = await observedSave;
        if (result.error) throw result.error;
        expect(result.response.ok()).toBe(true);
        expect(await page.evaluate(async () => {
            const response = await fetch('/api/settings/get', { method: 'POST', headers: window.Luker.getContext().getRequestHeaders(), body: '{}' });
            if (!response.ok) throw new Error(`Settings read failed: HTTP ${response.status}`);
            return JSON.parse((await response.json()).settings).firstRun;
        })).toBe(false);
        await openLanSyncPanel(page); await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
        return { page, context };
    } catch (primary) {
        const [closed] = await Promise.all([context.close().then(() => ({}), error => ({ error })), observedSave]);
        if (closed.error) throw new globalThis.AggregateError([primary, closed.error], 'User setup and context cleanup failed');
        throw primary;
    }
}

async function role(admin, handle, promoted) {
    await closeAllPopups(admin.page); await openAdminUser(admin.page, handle);
    const toggle = accountWindow(admin.page).locator('[data-act="adm-switch"][data-kind="admin"]');
    const response = admin.page.waitForResponse(value => new URL(value.url()).pathname === `/api/users/${promoted ? 'promote' : 'demote'}`);
    await toggle.click();
    // Demoting asks first; promoting does not.
    if (!promoted) await answerWindowConfirm(admin.page);
    expect((await response).ok()).toBe(true);
    if (promoted) await expect(toggle).toHaveClass(/\bon\b/);
    else await expect(toggle).not.toHaveClass(/\bon\b/);
    await closeAccountWindow(admin.page);
}

test('DOM-created nonadmin accounts keep distinct S3 prefixes and pending status isolated when the switch is enabled', async ({ browser }, testInfo) => {
    test.setTimeout(360_000);
    const admin = await accountServer(browser, 'account-isolation', true);
    const users = [];
    const options = await fixture.options();
    const proxy = await fixture.proxy();
    try {
        for (const handle of ['alice', 'bob']) {
            await createUser(admin, handle);
            const user = await userPage(browser, admin, handle); users.push(user);
            await closeAllPopups(user.page);
            await createReadyWorldBook(user.page, `${handle} private book`);
            await openLanSyncPanel(user.page);
            await addS3Backend(user.page, { ...options, endpoint: proxy.endpoint, prefix: `${handle}/`, label: `${handle} cloud` });
            await waitForBackendSync(user.page, { label: `${handle} cloud` });
        }
        const ids = [];
        for (const [index, handle] of ['alice', 'bob'].entries()) {
            const listed = await readBackends(users[index].page);
            expect(Object.values(listed.backends).map(backend => backend.label)).toEqual([`${handle} cloud`]);
            ids.push(Object.keys(listed.backends)[0]);
            const status = await readStatus(users[index].page);
            expect(status.ok).toBe(true); expect(status.conflicts).toEqual([]); expect(status.notices).toEqual([]);
            expect(Object.keys(status.backends)).toEqual([ids[index]]);
            const own = path.join(admin.server.dataRoot, handle, 'worlds', `${handle} private book.json`);
            const other = path.join(admin.server.dataRoot, handle, 'worlds', `${handle === 'alice' ? 'bob' : 'alice'} private book.json`);
            expect(JSON.parse(fs.readFileSync(own, 'utf8'))).toMatchObject({ entries: {} }); expect(fs.existsSync(other)).toBe(false);
            const remote = await fixture.client().send(new GetObjectCommand({ Bucket: options.bucket, Key: `${handle}/head` }));
            expect((await remote.Body.transformToByteArray()).length).toBeGreaterThan(41);
            for (const secret of [options.passphrase, options.accessKeyId, options.secretAccessKey]) expect(JSON.stringify({ listed, status })).not.toContain(secret);
            await reloadS3Page(users[index].page);
            expect(Object.keys((await readBackends(users[index].page)).backends)).toEqual([ids[index]]);
        }
        expect(new Set(ids).size).toBe(2);
        expect(proxy.requests.some(request => request.relativeKey === 'alice/head' && request.method === 'PUT')).toBe(true);
        expect(proxy.requests.some(request => request.relativeKey === 'bob/head' && request.method === 'PUT')).toBe(true);
        fs.writeFileSync(testInfo.outputPath('isolated-status.json'), JSON.stringify(await Promise.all(users.map(user => readStatus(user.page))), null, 2));
    } finally { for (const user of users) await user.context.close(); }
});

test('default-off DOM policy rejects private S3 and LAN then revokes existing owner on the next automatic poll', async ({ browser }, testInfo) => {
    test.setTimeout(480_000);
    const admin = await accountServer(browser, 'policy-owner', false), peer = await accountServer(browser, 'policy-peer', true);
    const users = [];
    const proxy = await fixture.proxy(), options = await fixture.options();
    const lanProxy = await startHttpFixture((req, res) => {
        const upstream = http.request(`${peer.server.baseURL}${req.url}`, { method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
        upstream.on('error', error => res.destroy(error)); req.pipe(upstream);
    });
    try {
        for (const device of [admin, peer]) await createUser(device, 'alice');
        const alice = await userPage(browser, admin, 'alice'), remote = await userPage(browser, peer, 'alice'); users.push(alice, remote);
        // A real generating account supplies a usable code; denial must occur
        // at the accepting owner's connection policy, not a handle mismatch.
        const link = new URL(await generatePairingLink(remote.page, { label: 'Alice owner', categories: ['worlds'] }));
        link.searchParams.set('base', lanProxy.url);
        const beforeS3 = proxy.requests.length, beforeLan = lanProxy.hits.length;
        await openAddBackend(alice.page, 's3'); await fillS3Form(alice.page, { ...options, endpoint: proxy.endpoint, prefix: 'alice/', label: 'Private cloud' });
        const denied = alice.page.waitForResponse(response => new URL(response.url()).pathname === '/api/sync/v1/backends/s3' && response.request().method() === 'POST');
        await accountWindow(alice.page).locator('[data-act="s3-save"]').click();
        expect(await (await denied).json()).toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
        await expect(formError(alice.page)).toContainText('private');
        await closeAllPopups(alice.page); await openLanSyncPanel(alice.page);
        expect(await acceptPairingLink(alice.page, link.toString(), { categories: ['worlds'], localLabel: 'Private LAN' })).toBe('error');
        await expect(formError(alice.page)).toContainText('private');
        expect(proxy.requests).toHaveLength(beforeS3); expect(lanProxy.hits).toHaveLength(beforeLan);
        expect((await readBackends(alice.page)).backends).toEqual({});
        // Default administrator is a positive control for the same real S3 endpoint.
        await openLanSyncPanel(admin.page); await addS3Backend(admin.page, { ...options, endpoint: proxy.endpoint, prefix: 'admin/', label: 'Admin cloud' });
        await waitForBackendSync(admin.page, { label: 'Admin cloud' });
        await role(admin, 'alice', true);
        await addS3Backend(alice.page, { ...options, endpoint: proxy.endpoint, prefix: 'alice/', label: 'Private cloud' });
        await waitForBackendSync(alice.page, { label: 'Private cloud' });
        const since = Date.now();
        expect(await acceptPairingLink(alice.page, link.toString(), { categories: ['worlds'], localLabel: 'Private LAN' })).toBe('success');
        await waitForBackgroundSync(alice.page, { since }); await waitForBackgroundSync(remote.page, { since });
        await role(admin, 'alice', false);
        const revokedAt = Date.now(), s3Hits = proxy.requests.filter(request => request.relativeKey.startsWith('alice/')).length, lanHits = lanProxy.hits.length;
        const manual = [];
        alice.page.on('request', request => { if (request.method() === 'POST' && /\/backends\/[^/]+\/sync$/.test(new URL(request.url()).pathname)) manual.push(request.url()); });
        await setSyncSchedule(alice.page, { idleSeconds: 3600, pollSeconds: 1 });
        await expect.poll(async () => {
            const { backends, running } = await readBackends(alice.page);
            return Object.values(backends).length === 2 && !Object.values(running).some(Boolean)
                && Object.values(backends).every(backend => backend.lastSync.error?.code === 'SYNC_PRIVATE_ADDRESS' && backend.lastSync.error.at >= revokedAt);
        }, { timeout: 60_000 }).toBe(true);
        await openLanSyncPanel(alice.page);
        await expect(accountWindow(alice.page).locator('.dw-card[data-backend] .dw-card-note.bad')).toHaveCount(2);
        expect(manual).toEqual([]);
        expect(proxy.requests.filter(request => request.relativeKey.startsWith('alice/'))).toHaveLength(s3Hits);
        expect(lanProxy.hits).toHaveLength(lanHits);
        fs.writeFileSync(testInfo.outputPath('revoked-status.json'), JSON.stringify(await readStatus(alice.page), null, 2));
        await setSyncSchedule(alice.page, { idleSeconds: 3600, pollSeconds: 3600 });
    } finally { for (const user of users) await user.context.close(); await lanProxy.close(); }
});
