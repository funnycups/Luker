// Concurrency: both devices syncing at once converge, an edit made while
// a run talks to the peer is kept and synced by the follow-up run, and a
// save during a snapshot waits for it instead of failing.
//
// Two real servers. B runs with test pausepoints that hold a sync at an
// exact step; each pause is armed right before the click it pauses, so
// the pairing and earlier syncs pass through. Edits go through the World
// Info UI.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { createWorldBook, addWorldEntry, selectWorldBook } from '../_lib/ui-worldinfo.js';
import { openLanSyncPanel, backendCard, generatePairingLink, acceptPairingLink, clickSyncNow, setSyncSchedule, closeAllPopups, readUserFile, waitForSyncPopup, listPopupConflicts, waitForBackgroundSync, conflictChoiceShowing, chooseConflictVersion, applyConflictChoices } from '../_lib/sync.js';

let A;
let B;
let pauseDir;
let contexts = [];

async function pairedPages(browser, { idleA, pollA, idleB, pollB }) {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    contexts = [ctxA, ctxB];
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await awaitMainUI(pageA, A.baseURL);
    await awaitMainUI(pageB, B.baseURL);
    const pairedSince = Date.now();
    await openLanSyncPanel(pageA);
    const link = await generatePairingLink(pageA, { label: 'B device', categories: ['worlds'] });
    await openLanSyncPanel(pageB);
    expect(await acceptPairingLink(pageB, link, { categories: ['worlds'], localLabel: 'A device' })).toBe('success');
    await setSyncSchedule(pageB, { idleSeconds: idleB, pollSeconds: pollB });
    await closeAllPopups(pageA);
    await openLanSyncPanel(pageA);
    await setSyncSchedule(pageA, { idleSeconds: idleA, pollSeconds: pollA });
    await closeAllPopups(pageA);
    await closeAllPopups(pageB);
    // A syncs in the background on B's notify; edit only after both
    // devices finished their runs.
    await waitForBackgroundSync(pageA, { since: pairedSince });
    await waitForBackgroundSync(pageB, { since: pairedSince });
    return { pageA, pageB };
}

async function start(testInfo, envB = {}) {
    pauseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-e2e-pause-'));
    A = await startServer({ batchKey: 'sync', scenarioId: `conc-${testInfo.testId}-A` });
    B = await startServer({ batchKey: 'sync', scenarioId: `conc-${testInfo.testId}-B`, extraEnv: { LUKER_SYNC_PAUSE_DIR: pauseDir, ...envB } });
}
const arm = name => fs.writeFileSync(path.join(pauseDir, `${name}.arm`), '');
const reached = name => expect.poll(() => fs.existsSync(path.join(pauseDir, `${name}.reached`)), { timeout: 60_000 }).toBe(true);
const release = name => fs.writeFileSync(path.join(pauseDir, `${name}.release`), '');
// A world save request whose body carries `text`.
const worldSave = text => request => ['/api/worldinfo/edit', '/api/worldinfo/patch'].includes(new URL(request.url()).pathname) && (request.postData() ?? '').includes(text);
const worldSaved = text => response => worldSave(text)(response.request());

test.afterEach(async () => {
    for (const ctx of contexts) await ctx.close();
    contexts = [];
    await tearDownServer(A);
    await tearDownServer(B);
    fs.rmSync(pauseDir, { recursive: true, force: true });
});

test.describe('LAN Sync — concurrency', () => {
    test.describe.configure({ timeout: 240_000 });

    test('both devices pushing at once converge', async ({ browser }, testInfo) => {
        await start(testInfo);
        const { pageA, pageB } = await pairedPages(browser, { idleA: 3600, pollA: 3600, idleB: 3600, pollB: 3600 });
        await createWorldBook(pageA, 'North Gate');
        await createWorldBook(pageB, 'South Gate');
        await openLanSyncPanel(pageA);
        await openLanSyncPanel(pageB);
        const [ra, rb] = await Promise.all([clickSyncNow(pageA, 'B device'), clickSyncNow(pageB, 'A device')]);
        expect([ra, rb]).toEqual(['success', 'success']);
        await expect.poll(() => [readUserFile(A, 'worlds/South Gate.json') !== null, readUserFile(B, 'worlds/North Gate.json') !== null], { timeout: 60_000 }).toEqual([true, true]);
    });

    test('an edit made while the network step runs is kept and synced by the follow-up run', async ({ browser }, testInfo) => {
        await start(testInfo, { LUKER_SYNC_PAUSEPOINT: 'after-remote-head' });
        const { pageA, pageB } = await pairedPages(browser, { idleA: 3600, pollA: 3600, idleB: 3600, pollB: 3600 });
        await createWorldBook(pageA, 'Ash Road');
        const firstSince = Date.now();
        await openLanSyncPanel(pageA);
        expect(await clickSyncNow(pageA, 'B device')).toBe('success');
        await expect.poll(() => readUserFile(B, 'worlds/Ash Road.json') !== null, { timeout: 60_000 }).toBe(true);
        // B syncs in the background on A's notify; arm only after that run.
        await waitForBackgroundSync(pageB, { since: firstSince });
        await closeAllPopups(pageA);
        await selectWorldBook(pageA, 'Ash Road');
        const savedOnA = pageA.waitForResponse(worldSaved('Carts pass'));
        await addWorldEntry(pageA, { key: 'carts', content: 'Carts pass the Ash Road at dawn.' });
        expect((await savedOnA).status()).toBe(200);
        await reloadAndAwait(pageB, B.baseURL);
        await openLanSyncPanel(pageB);
        arm('after-remote-head');
        await backendCard(pageB, 'A device').locator('[data-act="sync-now"]').click();
        await reached('after-remote-head');
        await closeAllPopups(pageB);
        await selectWorldBook(pageB, 'Ash Road');
        const savedOnB = pageB.waitForResponse(worldSaved('burns blue'));
        await addWorldEntry(pageB, { key: 'lantern', content: 'The lantern at Ash Road burns blue.' });
        expect((await savedOnB).status()).toBe(200);
        release('after-remote-head');
        // B's snapshot predates its edit and A changed the same file, so the
        // reconcile skips it and asks for a rerun; only that rerun can merge
        // B's edit with A's, which records the conflict asserted below. The
        // merge roles decide which version stays live; both are offered.
        await reloadAndAwait(pageB, B.baseURL);
        await waitForSyncPopup(pageB);
        expect(await listPopupConflicts(pageB)).toEqual([{ path: 'worlds/Ash Road.json', stale: false }]);
        expect(await conflictChoiceShowing(pageB, 'worlds/Ash Road.json', 'Carts pass')).not.toBe(await conflictChoiceShowing(pageB, 'worlds/Ash Road.json', 'burns blue'));
        await chooseConflictVersion(pageB, 'worlds/Ash Road.json', await conflictChoiceShowing(pageB, 'worlds/Ash Road.json', 'burns blue'));
        expect(await applyConflictChoices(pageB)).toBe('success');
        expect(readUserFile(B, 'worlds/Ash Road.json')).toContain('burns blue');
        await expect.poll(() => readUserFile(A, 'worlds/Ash Road.json') ?? '', { timeout: 60_000 }).toContain('burns blue');
    });

    test('a save during a snapshot waits instead of failing', async ({ browser }, testInfo) => {
        await start(testInfo, { LUKER_SYNC_PAUSEPOINT: 'inside-snapshot-lock' });
        const { pageB } = await pairedPages(browser, { idleA: 3600, pollA: 3600, idleB: 3600, pollB: 3600 });
        await createWorldBook(pageB, 'Fen Lantern');
        await openLanSyncPanel(pageB);
        arm('inside-snapshot-lock');
        await backendCard(pageB, 'A device').locator('[data-act="sync-now"]').click();
        await reached('inside-snapshot-lock');
        await closeAllPopups(pageB);
        const saving = pageB.waitForRequest(worldSave('Marsh lights'));
        const saved = pageB.waitForResponse(worldSaved('Marsh lights'));
        await addWorldEntry(pageB, { key: 'fen', content: 'Marsh lights gather at the Fen Lantern.' });
        await saving;
        // The save request is held by the gate while the snapshot is paused.
        expect(readUserFile(B, 'worlds/Fen Lantern.json') ?? '').not.toContain('Marsh lights');
        release('inside-snapshot-lock');
        expect((await saved).status()).toBe(200);
        await expect.poll(() => readUserFile(B, 'worlds/Fen Lantern.json') ?? '', { timeout: 30_000 }).toContain('Marsh lights');
        await expect.poll(() => Object.values(JSON.parse(readUserFile(B, 'worlds/Fen Lantern.json')).entries).map(entry => entry.key), { timeout: 30_000 }).toEqual([['fen']]);
        await expect(pageB.locator('.toast-error')).toHaveCount(0);
    });
});
