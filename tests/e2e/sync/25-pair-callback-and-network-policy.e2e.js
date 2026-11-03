import { test, expect } from '@playwright/test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, createUserViaAdminUI, completeOnboarding } from '../_lib/page.js';
import { openLanSyncPanel, generatePairingLink, acceptPairingLink, listPeers, loginAs, clickSyncNow, closeAllPopups, setSyncSchedule, waitForBackgroundSync, readUserFile, backendCard, pairingLinkField, syncFlash } from '../_lib/sync.js';
import { accountWindow, formError } from '../_lib/account-window.js';
import { createWorldBook } from '../_lib/ui-worldinfo.js';
import { onboardS3Page, awaitS3Page } from '../_lib/sync-s3.js';

test('a failed LAN reverse callback keeps the pairing code usable after a listener restart', async ({ browser }) => {
    test.setTimeout(180000);
    const interfaces = os.networkInterfaces();
    const address = Object.values(interfaces).flat().find(x => x.family === 'IPv4' && !x.internal)?.address;
    expect(address, JSON.stringify(interfaces)).toBeTruthy();
    let A, B;
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
        A = await startServer({ batchKey: 'sync', scenarioId: 'callback-A', extraConfig: { listen: true, securityOverride: true, whitelistMode: false } });
        B = await startServer({ batchKey: 'sync', scenarioId: 'callback-B' });
        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();
        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);
        await openLanSyncPanel(pageA);
        await generatePairingLink(pageA, { label: 'B callback', categories: ['worlds'] });
        await accountWindow(pageA).locator('select[data-act-change="pair-addr"]').selectOption(`http://${address}:${A.port}`);
        const link = await pairingLinkField(pageA).inputValue();
        expect(decodeURIComponent(link)).toContain(`http://${address}:${A.port}`);
        await openLanSyncPanel(pageB);
        expect(await acceptPairingLink(pageB, link, { categories: ['worlds'], localLabel: 'A callback' })).toBe('error');
        await expect(formError(pageB)).toContainText('cannot connect back');
        await expect(syncFlash(pageB)).toHaveCount(0);
        expect(await listPeers(pageB)).toEqual([]);
        const statePath = path.join(B.dataRoot, 'default-user', '.sync', 'state.json');
        if (fs.existsSync(statePath)) expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).backends).toEqual({});
        await B.restart({ extraConfig: { listen: true, securityOverride: true, whitelistMode: false } });
        await pageB.reload();
        await pageB.waitForFunction(() => !document.getElementById('preloader'));
        await openLanSyncPanel(pageB);
        expect(await acceptPairingLink(pageB, link, { categories: ['worlds'], localLabel: 'A callback' })).toBe('success');
        expect(await listPeers(pageB)).toEqual([{ label: 'A callback' }]);
    } finally {
        await contextA.close();
        await contextB.close();
        await tearDownServer(A);
        await tearDownServer(B);
    }
});

for (const enableUserAccounts of [false, true]) test(`local loopback pairing works with user accounts ${enableUserAccounts}`, async ({ browser }) => {
    test.setTimeout(180000);
    let A, B;
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
        A = await startServer({ batchKey: 'sync', scenarioId: 'local-A', extraConfig: { enableUserAccounts } });
        B = await startServer({ batchKey: 'sync', scenarioId: 'local-B', extraConfig: { enableUserAccounts } });
        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();
        if (enableUserAccounts) {
            await loginAs(pageA, A.baseURL, { handle: 'default-user', password: '' });
            await loginAs(pageB, B.baseURL, { handle: 'default-user', password: '' });
        } else {
            await awaitMainUI(pageA, A.baseURL);
            await awaitMainUI(pageB, B.baseURL);
        }
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, { label: 'B local', categories: ['worlds'] });
        await openLanSyncPanel(pageB);
        expect(await acceptPairingLink(pageB, link, { categories: ['worlds'], localLabel: 'A local' })).toBe('success');
    } finally {
        await contextA.close();
        await contextB.close();
        await tearDownServer(A);
        await tearDownServer(B);
    }
});

test('nonadmin default policy refuses pairing and the administrator switch permits the same code', async ({ browser }) => {
    test.setTimeout(240000);
    let A, B;
    const contexts = [];
    try {
        for (const side of ['A', 'B']) {
            const server = await startServer({ batchKey: 'sync', scenarioId: `policy-${side}`, extraConfig: { enableUserAccounts: true, 'sync.allowPrivateAddressesForUsers': side === 'A' } });
            if (side === 'A') A = server;
            else B = server;
            const admin = await browser.newContext();
            contexts.push(admin);
            const page = await admin.newPage();
            await loginAs(page, server.baseURL, { handle: 'default-user', password: '' });
            await createUserViaAdminUI(page, { handle: 'alice', name: 'Alice', password: 'policy-password' });
            await admin.close();
        }
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        contexts.push(ctxA, ctxB);
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        for (const [page, server] of [[pageA, A], [pageB, B]]) {
            await loginAs(page, server.baseURL, { handle: 'alice', password: 'policy-password' });
            await completeOnboarding(page);
            await openLanSyncPanel(page);
        }
        const link = await generatePairingLink(pageA, { label: 'B policy', categories: ['worlds'] });
        expect(await acceptPairingLink(pageB, link, { categories: ['worlds'], localLabel: 'A policy' })).toBe('error');
        await expect(formError(pageB)).toContainText('private addresses');
        expect(await listPeers(pageB)).toEqual([]);
        await B.restart({ extraConfig: { 'sync.allowPrivateAddressesForUsers': true } });
        await pageB.reload();
        await pageB.waitForFunction(() => !document.getElementById('preloader'));
        await openLanSyncPanel(pageB);
        expect(await acceptPairingLink(pageB, link, { categories: ['worlds'], localLabel: 'A policy' })).toBe('success');
    } finally {
        for (const context of contexts) await context.close();
        await tearDownServer(A);
        await tearDownServer(B);
    }
});

test('paired maintenance rejects symmetric offers with 409 and a later DOM Sync now converges', async ({ browser }) => {
    // Budget covers two real server boots, browser pairing and transport barriers.
    test.setTimeout(240_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-maintenance-dom-'));
    const name = 'offer-before-admission';
    const contexts = [];
    const servers = [];
    const folders = [];
    const owned = [];
    const failures = [];
    try {
        for (const side of ['A', 'B']) {
            const pauseRoot = path.join(root, side);
            const folder = path.join(pauseRoot, 'default-user'); fs.mkdirSync(folder, { recursive: true }); folders.push(folder);
            const server = await startServer({ batchKey: 'sync', scenarioId: `maintenance-${side}`, extraEnv: { LUKER_SYNC_PAUSEPOINT: name, LUKER_SYNC_PAUSE_DIR: pauseRoot } });
            servers.push(server);
        }
        const pages = [];
        for (const server of servers) {
            const context = await browser.newContext(); contexts.push(context);
            const page = await context.newPage(); pages.push(page); await onboardS3Page(page, server.baseURL);
        }
        const [a, b] = pages;
        const since = Date.now();
        await openLanSyncPanel(a);
        const link = await generatePairingLink(a, { label: 'B maintenance', categories: ['worlds'] });
        await openLanSyncPanel(b);
        // Stored outgoing HTTP credentials expose the real "Clear saved account" menu entry.
        expect(await acceptPairingLink(b, link, { categories: ['worlds'], localLabel: 'A maintenance', peerAuth: { username: 'fixture-user', password: 'fixture-password' } })).toBe('success');
        await waitForBackgroundSync(a, { since }); await waitForBackgroundSync(b, { since });
        // Paste an existing paired identity with B's address. Authentication uses the
        // stored sync secret; no pairing code or registry edit is needed.
        const reverseLink = new URL(link); reverseLink.searchParams.set('base', servers[1].baseURL); reverseLink.searchParams.delete('code');
        expect(await acceptPairingLink(a, reverseLink.toString(), { categories: ['worlds'], localLabel: 'B maintenance', peerAuth: { username: 'fixture-user', password: 'fixture-password' } })).toBe('success');
        for (const page of pages) await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
        for (const page of pages) await closeAllPopups(page);
        await createWorldBook(a, 'Maintenance North'); await createWorldBook(b, 'Maintenance South');
        for (const page of pages) await openLanSyncPanel(page);
        const rows = pages.map((page, i) => backendCard(page, i ? 'A maintenance' : 'B maintenance'));
        // The tab owning a pending Sync intentionally locks its backend card.
        // Finish independent callers' startup before holding their real offers.
        const maintenancePages = [];
        for (const [index, server] of servers.entries()) {
            const control = await contexts[index].newPage();
            await control.goto(server.baseURL); await awaitS3Page(control);
            await openLanSyncPanel(control); maintenancePages.push(control);
        }
        const maintenanceRows = maintenancePages.map((page, i) => backendCard(page, i ? 'A maintenance' : 'B maintenance'));
        for (const folder of folders) fs.writeFileSync(path.join(folder, `${name}.arm`), '');
        const responses = pages.map(page => page.waitForResponse(r => /\/backends\/[^/]+\/sync$/.test(new URL(r.url()).pathname)));
        owned.push(Promise.allSettled(responses));
        await Promise.all(rows.map(row => row.locator('[data-act="sync-now"]').click()));
        await Promise.all(folders.map(folder => expect.poll(() => fs.existsSync(path.join(folder, `${name}.reached`))).toBe(true)));
        for (const row of rows) await expect(row).toHaveClass(/\blocked\b/);
        for (const row of maintenanceRows) await expect(row).not.toHaveClass(/\blocked\b/);
        const settings = maintenancePages.map(page => page.waitForResponse(r => r.request().method() === 'DELETE' && new URL(r.url()).pathname.endsWith('/auth')));
        const requests = maintenancePages.map(page => page.waitForRequest(r => r.method() === 'DELETE' && new URL(r.url()).pathname.endsWith('/auth')));
        owned.push(Promise.allSettled([...settings, ...requests]));
        await Promise.all(maintenanceRows.map(async row => {
            await row.locator('[data-act="menu"]').click();
            await row.locator('.dw-menu [data-act="clear-auth"]').click();
        }));
        await Promise.all(requests);
        for (const folder of folders) fs.writeFileSync(path.join(folder, `${name}.release`), '');
        for (const response of await Promise.all(responses)) {
            expect(response.status()).toBe(409); expect(await response.json()).toMatchObject({ ok: false, code: 'SYNC_BACKEND_MAINTENANCE' });
        }
        for (const response of await Promise.all(settings)) expect(response.status()).toBe(200);
        for (const page of pages) await expect(syncFlash(page)).toHaveAttribute('data-flash', 'error');
        for (const row of rows) {
            await expect(row).not.toHaveClass(/\blocked\b/);
            await row.locator('[data-act="menu"]').click();
            await expect(row.locator('.dw-menu')).toBeVisible();
            await expect(row.locator('.dw-menu [data-act="clear-auth"]')).toHaveCount(0);
            await row.locator('[data-act="menu"]').click();
        }
        expect(await clickSyncNow(a, 'B maintenance')).toBe('success');
        expect(await clickSyncNow(b, 'A maintenance')).toBe('success');
        await expect.poll(() => readUserFile(servers[0], 'worlds/Maintenance South.json')).not.toBeNull();
        await expect.poll(() => readUserFile(servers[1], 'worlds/Maintenance North.json')).not.toBeNull();
    } catch (error) {
        failures.push(error);
    } finally {
        for (const folder of folders) fs.writeFileSync(path.join(folder, `${name}.release`), '');
        const closed = await Promise.allSettled(contexts.map(context => context.close()));
        await Promise.all(owned);
        const stopped = await Promise.allSettled(servers.map(server => tearDownServer(server)));
        failures.push(...[...closed, ...stopped].filter(result => result.status === 'rejected').map(result => result.reason));
        fs.rmSync(root, { recursive: true, force: true });
    }
    // eslint-disable-next-line playwright/no-conditional-in-test -- Preserve real verification and cleanup errors after every owned resource settles.
    if (failures.length) throw new AggregateError(failures, 'Paired maintenance verification or cleanup failed', { cause: failures[0] });
});
