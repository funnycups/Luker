// Undo of the last sync is a forward commit that reaches the other device;
// deletions, renames and a large background image travel between devices.
//
// Two real servers; every edit goes through the Luker UI.

import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, renameCurrentChatViaUI, selectCharacterByName } from '../_lib/page.js';
import { addWorldEntry, createWorldBook, selectWorldBook, deleteSelectedWorldBook } from '../_lib/ui-worldinfo.js';
import { writeCharacterPng } from '../groups/_helpers.js';
import {
    openLanSyncPanel, generatePairingLink, acceptPairingLink, clickSyncNow, clickUndoLastSync, setSyncSchedule, closeAllPopups,
    openChatByName, readUserFile, userRootOf, backendIdOf, shadowMain, waitForBackgroundSync, syncFlash,
} from '../_lib/sync.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
let A;
let B;
let contexts = [];

test.beforeEach(async ({}, testInfo) => {
    A = await startServer({ batchKey: 'sync', scenarioId: `undo-${testInfo.testId}-A` });
    B = await startServer({ batchKey: 'sync', scenarioId: `undo-${testInfo.testId}-B` });
    for (const server of [A, B]) {
        writeCharacterPng({ dataRoot: server.dataRoot, avatarFile: 'Seraphina.png', card: { name: 'Seraphina', first_mes: 'Welcome back to the glade.' } });
        fs.mkdirSync(path.join(userRootOf(server), 'chats', 'Seraphina'), { recursive: true });
        fs.writeFileSync(path.join(userRootOf(server), 'chats', 'Seraphina', 'Moonlit Walk.jsonl'), [
            { user_name: 'User', character_name: 'Seraphina', create_date: '2026-10-01@10h00m00s', chat_metadata: { integrity: '1c9e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' } },
            { name: 'Seraphina', is_user: false, mes: 'The moon is bright tonight.', send_date: '2026-10-01@10h00m01s' },
        ].map(line => JSON.stringify(line)).join('\n'));
    }
    await testInfo.attach('actual-server-argv', { body: JSON.stringify([A, B].map(server => ({ port: server.port, dataRoot: server.dataRoot, argv: server.execArgv }))), contentType: 'application/json' });
});

test.afterEach(async () => {
    for (const ctx of contexts) await ctx.close();
    contexts = [];
    await tearDownServer(A);
    await tearDownServer(B);
});

async function pairedPages(browser, { idleA = 3600 } = {}) {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    contexts = [ctxA, ctxB];
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await awaitMainUI(pageA, A.baseURL);
    await awaitMainUI(pageB, B.baseURL);
    const categories = ['worlds', 'characters', 'chats', 'backgrounds'];
    const pairedSince = Date.now();
    await openLanSyncPanel(pageA);
    const link = await generatePairingLink(pageA, { label: 'B device', categories });
    await openLanSyncPanel(pageB);
    expect(await acceptPairingLink(pageB, link, { categories, localLabel: 'A device' })).toBe('success');
    await setSyncSchedule(pageB, { idleSeconds: 3600, pollSeconds: 3600 });
    await closeAllPopups(pageA);
    await openLanSyncPanel(pageA);
    await setSyncSchedule(pageA, { idleSeconds: idleA, pollSeconds: 3600 });
    await closeAllPopups(pageA);
    await closeAllPopups(pageB);
    // A syncs in the background on B's notify; edit only after both
    // devices finished their runs.
    await waitForBackgroundSync(pageA, { since: pairedSince });
    await waitForBackgroundSync(pageB, { since: pairedSince });
    return { pageA, pageB };
}

test.describe('LAN Sync — undo and change propagation', () => {
    // Playwright budget for pairing plus the sync round trips of one test;
    // the image test alone waits up to 120 s for its transfer.
    test.describe.configure({ timeout: 5 * 60_000 });

    test('undo on B is a forward commit that A receives', async ({ browser }) => {
        const { pageA, pageB } = await pairedPages(browser);
        await createWorldBook(pageA, 'Starfall');
        const syncedSince = Date.now();
        await openLanSyncPanel(pageA);
        expect(await clickSyncNow(pageA, 'B device')).toBe('success');
        await expect.poll(() => readUserFile(B, 'worlds/Starfall.json') !== null, { timeout: 60_000 }).toBe(true);
        // B applies A's push in the run the notify started.
        await waitForBackgroundSync(pageB, { since: syncedSince });
        await openLanSyncPanel(pageB);
        expect(await clickUndoLastSync(pageB, 'A device')).toBe('success');
        expect(readUserFile(B, 'worlds/Starfall.json')).toBeNull();
        await expect.poll(() => readUserFile(A, 'worlds/Starfall.json'), { timeout: 60_000 }).toBeNull();
        const id = backendIdOf(B);
        const gitdir = path.join(userRootOf(B), '.sync', id, 'repo.git');
        const log = await git.log({ fs, gitdir, ref: await shadowMain(B, id) });
        expect(log.some(entry => entry.commit.message.startsWith('undo sync sync-backup-'))).toBe(true);
    });

    test('undo with an offline peer reports an error instead of a success message', async ({ browser }) => {
        const { pageA, pageB } = await pairedPages(browser);
        await createWorldBook(pageA, 'Starfall');
        const since = Date.now();
        await openLanSyncPanel(pageA);
        expect(await clickSyncNow(pageA, 'B device')).toBe('success');
        await waitForBackgroundSync(pageB, { since });
        await tearDownServer(A);
        await openLanSyncPanel(pageB);
        expect(await clickUndoLastSync(pageB, 'A device')).toBe('error');
        await expect(syncFlash(pageB)).toHaveAttribute('data-flash', 'error');
        await expect(syncFlash(pageB).filter({ hasText: 'Undid the last sync' })).toHaveCount(0);
        expect(readUserFile(B, 'worlds/Starfall.json')).toBeNull();
    });

    test('all-kept Undo reports the retained DOM edit and consumes the matching undo point', async ({ browser }) => {
        const { pageA, pageB } = await pairedPages(browser);
        await createWorldBook(pageA, 'Retained Grove');
        const since = Date.now();
        await openLanSyncPanel(pageA);
        expect(await clickSyncNow(pageA, 'B device')).toBe('success');
        await waitForBackgroundSync(pageB, { since });
        await closeAllPopups(pageB);
        await pageB.reload(); await awaitMainUI(pageB, B.baseURL);
        await selectWorldBook(pageB, 'Retained Grove');
        await addWorldEntry(pageB, { key: 'retained', content: 'Later complete retained edit' });
        await expect.poll(() => readUserFile(B, 'worlds/Retained Grove.json')).toContain('Later complete retained edit');
        const live = readUserFile(B, 'worlds/Retained Grove.json');
        await openLanSyncPanel(pageB);
        const response = pageB.waitForResponse(r => r.url().endsWith('/undo'));
        expect(await clickUndoLastSync(pageB, 'A device')).toBe('warning');
        expect(await (await response).json()).toMatchObject({ ok: true, committed: true, reverted: [], keptEdited: ['worlds/Retained Grove.json'], propagation: { ok: true } });
        await expect(syncFlash(pageB).filter({ hasText: 'were edited after the sync and kept their current version' })).toContainText('worlds/Retained Grove.json');
        expect(readUserFile(B, 'worlds/Retained Grove.json')).toBe(live);
        await expect.poll(() => readUserFile(A, 'worlds/Retained Grove.json'), { timeout: 60_000 }).toBe(live);
        const id = backendIdOf(B);
        const gitdir = path.join(userRootOf(B), '.sync', id, 'repo.git');
        const log = await git.log({ fs, gitdir, ref: await shadowMain(B, id) });
        const undo = log.find(({ commit }) => commit.message.startsWith('undo sync sync-backup-'));
        expect(undo).toBeTruthy();
        const parent = await git.readCommit({ fs, gitdir, oid: undo.commit.parent[0] });
        expect(undo.commit.tree).toBe(parent.commit.tree);
        expect((await git.listTags({ fs, gitdir })).filter(tag => tag.startsWith('sync-backup-'))).toEqual([]);
    });

    test('deletions and renames propagate', async ({ browser }) => {
        const { pageA } = await pairedPages(browser, { idleA: 2 });
        await createWorldBook(pageA, 'Fading Isle');
        await expect.poll(() => readUserFile(B, 'worlds/Fading Isle.json') !== null, { timeout: 60_000 }).toBe(true);
        await selectWorldBook(pageA, 'Fading Isle');
        await deleteSelectedWorldBook(pageA);
        await expect.poll(() => readUserFile(B, 'worlds/Fading Isle.json'), { timeout: 60_000 }).toBeNull();
        await selectCharacterByName(pageA, 'Seraphina');
        await openChatByName(pageA, 'Moonlit Walk');
        await renameCurrentChatViaUI(pageA, 'Moonlit Walk by the River');
        await expect.poll(() => [
            readUserFile(B, 'chats/Seraphina/Moonlit Walk.jsonl'),
            readUserFile(B, 'chats/Seraphina/Moonlit Walk by the River.jsonl') !== null,
        ], { timeout: 60_000 }).toEqual([null, true]);
    });

    test('a large background image round trips byte for byte', async ({ browser }) => {
        const { pageA } = await pairedPages(browser, { idleA: 2 });
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-e2e-bg-'));
        try {
            const file = path.join(tmp, 'starlit-glade.png');
            // A real PNG followed by 8 MiB after IEND: decoders ignore trailing bytes,
            // and the size makes the transfer span many object chunks.
            fs.writeFileSync(file, Buffer.concat([fs.readFileSync(path.join(REPO_ROOT, 'default/content/default_Seraphina.png')), crypto.randomBytes(8 * 1024 * 1024)]));
            await pageA.locator('#add_bg_button').setInputFiles(file);
            const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
            const target = path.join(userRootOf(B), 'backgrounds', 'starlit-glade.png');
            // The wait covers an 8 MiB LAN transfer plus the idle delay.
            await expect.poll(() => fs.existsSync(target) && sha(target) === sha(file), { timeout: 120_000 }).toBe(true);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
