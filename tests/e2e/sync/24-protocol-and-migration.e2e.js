// Real UI pairing and sync against two Luker routers. Only the protocol-1
// health endpoint is stubbed; the legacy files are installed while stopped.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import git from 'isomorphic-git';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { createWorldBook, addWorldEntry } from '../_lib/ui-worldinfo.js';
import {
    openLanSyncPanel, generatePairingLink, acceptPairingLink, clickSyncNow,
    setSyncSchedule, closeAllPopups, readUserFile, userRootOf, backendIdOf,
    shadowMain, waitForBackgroundSync, listPeers,
} from '../_lib/sync.js';
import { formError } from '../_lib/account-window.js';

let A;
let B;
const registryOf = server => JSON.parse(readUserFile(server, '.sync/state.json') || '{"backends":{}}');

function installLegacyRegistry(server, id, entry, addressFields = {}) {
    const peer = { label: entry.label, categories: entry.categories, pairedAt: Date.parse(entry.createdAt), syncSecret: entry.lan.syncSecret, ...addressFields };
    fs.writeFileSync(path.join(userRootOf(server), '.sync', 'state.json'), JSON.stringify({ peers: { [id]: peer } }, null, 2), { mode: 0o600 });
    fs.rmSync(path.join(userRootOf(server), '.sync', id, 'snapshot-categories.json'), { force: true });
}

async function openDevice(browser, contexts, server) {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await awaitMainUI(page, server.baseURL);
    return page;
}

async function closeContexts(contexts) {
    await Promise.all(contexts.splice(0).map(context => context.close()));
}

async function writeLore(page, server, name, content) {
    await createWorldBook(page, name);
    await addWorldEntry(page, { key: 'glade', content });
    // Wait for the real editor's debounced save before starting a sync.
    await expect.poll(() => readUserFile(server, `worlds/${name}.json`), { timeout: 30_000 }).toContain(content);
}

test.beforeEach(async ({}, testInfo) => {
    A = undefined;
    B = undefined;
    A = await startServer({ batchKey: 'sync', scenarioId: `${testInfo.testId}-A` });
    B = await startServer({ batchKey: 'sync', scenarioId: `${testInfo.testId}-B` });
});

test.afterEach(async () => {
    await Promise.all([tearDownServer(A), tearDownServer(B)]);
});

test('pairing with a protocol 1 peer shows the upgrade message without registering a backend', async ({ browser }) => {
    const contexts = [];
    const requests = [];
    // Approved exception: v1 health omitted the protocol field.
    const stub = http.createServer((req, res) => {
        requests.push(req.url);
        res.setHeader('Content-Type', 'application/json');
        res.end(req.url.startsWith('/api/sync/v1/health') ? '{"ok":true}' : '{}');
    });
    try {
        await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
        const pageA = await openDevice(browser, contexts, A);
        const pageB = await openDevice(browser, contexts, B);
        const before = registryOf(B).backends;
        expect(before).toEqual({});
        await openLanSyncPanel(pageA);
        const real = new URL((await generatePairingLink(pageA, { label: 'B device', categories: ['worlds'] })).replace('luker-sync://', 'http://'));
        real.searchParams.set('base', `http://127.0.0.1:${stub.address().port}`);
        await openLanSyncPanel(pageB);
        expect(await acceptPairingLink(pageB, `luker-sync://pair/v1?${real.searchParams.toString()}`, { categories: ['worlds'], localLabel: 'Old device' })).toBe('error');
        await expect(formError(pageB)).toContainText('The peer\'s Luker version is too old. Upgrade it and sync again.');
        expect(await listPeers(pageB)).toEqual([]);
        expect(registryOf(B).backends).toEqual(before);
        expect(requests).toEqual(['/api/sync/v1/health']);
    } finally {
        try {
            await closeContexts(contexts);
        } finally {
            await new Promise(resolve => stub.close(resolve));
        }
    }
});

test.describe('v1 registry migration', () => {
    // Covers server restarts, UI loads, saves and bidirectional sync waits.
    test.describe.configure({ timeout: 300_000 });

    test('a v1 registry retains its secrets and shadow history and syncs both ways without pairing again', async ({ browser }) => {
        const contexts = [];
        try {
            let pageA = await openDevice(browser, contexts, A);
            let pageB = await openDevice(browser, contexts, B);
            await writeLore(pageA, A, 'Glade Ledger', 'Seraphina keeps a ledger of the paths through the glade.');
            await openLanSyncPanel(pageA);
            const link = await generatePairingLink(pageA, { label: 'B device', categories: ['worlds'] });
            await openLanSyncPanel(pageB);
            const pairedSince = Date.now();
            expect(await acceptPairingLink(pageB, link, { categories: ['worlds'], localLabel: 'A device' })).toBe('success');
            await waitForBackgroundSync(pageA, { since: pairedSince });
            await waitForBackgroundSync(pageB, { since: pairedSince });
            const id = backendIdOf(B);
            expect(backendIdOf(A)).toBe(id);
            expect(readUserFile(B, 'worlds/Glade Ledger.json')).toBe(readUserFile(A, 'worlds/Glade Ledger.json'));

            // No live page may save settings or content during fixture conversion.
            await closeContexts(contexts);
            await Promise.all([A.stop(), B.stop()]);
            const originals = [];
            for (const server of [A, B]) {
                const entry = registryOf(server).backends[id];
                const head = await shadowMain(server, id);
                originals.push({ server, entry, head, baseURL: server.baseURL, dataRoot: server.dataRoot });
                expect(entry.lan.syncSecret).toMatch(/^[a-f0-9]{64}$/);
            }
            const bEntry = originals[1].entry;
            expect(bEntry.lastSync.at).toBeGreaterThan(pairedSince);
            expect(bEntry.lastSync.head).toBeTruthy();
            installLegacyRegistry(A, id, originals[0].entry);
            installLegacyRegistry(B, id, bEntry, { peerBaseUrl: bEntry.lan.peerBaseUrl, lastSyncAt: bEntry.lastSync.at, lastSyncedOid: bEntry.lastSync.head });
            expect(Object.keys(registryOf(A).peers[id]).sort()).toEqual(['label', 'categories', 'pairedAt', 'syncSecret'].sort());
            expect(Object.keys(registryOf(B).peers[id]).sort()).toEqual(['label', 'categories', 'pairedAt', 'syncSecret', 'peerBaseUrl', 'lastSyncAt', 'lastSyncedOid'].sort());
            for (const server of [A, B]) {
                expect(fs.existsSync(path.join(userRootOf(server), '.sync', id, 'snapshot-categories.json'))).toBe(false);
            }
            expect(originals[0].entry.lan.syncSecret).toBe(originals[1].entry.lan.syncSecret);
            await A.restart();
            // HTTP readiness precedes scheduler initialization. This read
            // requests migration while B is still stopped.
            const migrated = await fetch(`${A.baseURL}/api/sync/v1/backends`);
            expect(migrated.ok).toBe(true);
            expect(registryOf(A).backends[id].lan.peerBaseUrl).toBe('');
            expect(registryOf(A).backends[id].lastSync.at).toBeNull();
            const aSnapshot = JSON.parse(readUserFile(A, `.sync/${id}/snapshot-categories.json`));
            expect(aSnapshot.categories).toEqual(['worlds']);
            expect(aSnapshot.syncedAt.worlds).toBe(originals[0].head);
            pageA = await openDevice(browser, contexts, A);
            await openLanSyncPanel(pageA);
            await setSyncSchedule(pageA, { idleSeconds: 3600, pollSeconds: 3600 });
            const restartedSince = Date.now();
            await B.restart();
            for (const original of originals) {
                expect(original.server.baseURL).toBe(original.baseURL);
                expect(original.server.dataRoot).toBe(original.dataRoot);
            }
            pageB = await openDevice(browser, contexts, B);
            await waitForBackgroundSync(pageB, { since: restartedSince });
            expect(registryOf(A).backends[id].lan.peerBaseUrl).toBe(B.baseURL);
            expect(registryOf(B).backends[id].lan.peerBaseUrl).toBe(A.baseURL);
            for (const { server, head } of originals) {
                const snapshot = JSON.parse(readUserFile(server, `.sync/${id}/snapshot-categories.json`));
                expect(snapshot.categories).toEqual(['worlds']);
                expect((await git.readCommit({ fs, gitdir: path.join(userRootOf(server), '.sync', id, 'repo.git'), oid: head })).oid).toBe(head);
            }
            await openLanSyncPanel(pageB);
            await setSyncSchedule(pageB, { idleSeconds: 3600, pollSeconds: 3600 });

            await closeAllPopups(pageB);
            await writeLore(pageB, B, 'Birch Path', 'The birch path leads travelers back to Seraphina’s glade.');
            await openLanSyncPanel(pageB);
            const pushedSince = Date.now();
            expect(await clickSyncNow(pageB, 'A device')).toBe('success');
            await expect.poll(() => readUserFile(A, 'worlds/Birch Path.json'), { timeout: 60_000 }).toBe(readUserFile(B, 'worlds/Birch Path.json'));
            // B's authenticated offer teaches the address-less v1 generator A
            // its callback. No second pairing link or acceptance is performed.
            expect(registryOf(A).backends[id].lan.peerBaseUrl).toBe(B.baseURL);
            await waitForBackgroundSync(pageA, { since: pushedSince });
            await closeAllPopups(pageA);
            await writeLore(pageA, A, 'Moonlit Stones', 'Moonlight marks the stones beside Seraphina’s woodland home.');
            await openLanSyncPanel(pageA);
            expect(await clickSyncNow(pageA, 'B device')).toBe('success');
            await expect.poll(() => readUserFile(B, 'worlds/Moonlit Stones.json'), { timeout: 60_000 }).toBe(readUserFile(A, 'worlds/Moonlit Stones.json'));
            for (const { server, entry, head } of originals) {
                const registry = registryOf(server);
                expect(registry.version).toBe(2);
                expect(Object.keys(registry.backends)).toEqual([id]);
                expect(registry.backends[id].lan.syncSecret).toBe(entry.lan.syncSecret);
                expect(registry.backends[id].createdAt).toBe(entry.createdAt);
                expect(registry.backends[id].label).toBe(entry.label);
                const history = await git.log({ fs, gitdir: path.join(userRootOf(server), '.sync', id, 'repo.git'), ref: 'refs/heads/main' });
                expect(history.map(commit => commit.oid)).toContain(head);
                expect(readUserFile(server, 'worlds/Glade Ledger.json')).toContain('Seraphina keeps a ledger');
            }
        } finally {
            await closeContexts(contexts);
        }
    });
});
