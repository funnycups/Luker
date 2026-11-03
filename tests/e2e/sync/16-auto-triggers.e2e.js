// Automatic sync triggers: an edit syncs after the idle delay, a peer's
// change arrives on the next poll, and a Sync now on one device brings
// its edits to the other through the notify.
//
// Two real servers; the schedules are set in Account → Device settings and the
// world books are created through the World Info UI.

import { test, expect } from '@playwright/test';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { createWorldBook } from '../_lib/ui-worldinfo.js';
import { openLanSyncPanel, generatePairingLink, acceptPairingLink, clickSyncNow, setSyncSchedule, closeAllPopups, readUserFile, waitForBackgroundSync } from '../_lib/sync.js';

let A;
let B;
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

test.beforeEach(async ({}, testInfo) => {
    A = await startServer({ batchKey: 'sync', scenarioId: `auto-${testInfo.testId}-A` });
    B = await startServer({ batchKey: 'sync', scenarioId: `auto-${testInfo.testId}-B` });
});

test.afterEach(async () => {
    for (const ctx of contexts) await ctx.close();
    contexts = [];
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — automatic triggers', () => {
    test('an edit on A arrives on B with no clicks after the idle delay', async ({ browser }) => {
        const { pageA } = await pairedPages(browser, { idleA: 2, pollA: 3600, idleB: 3600, pollB: 3600 });
        await createWorldBook(pageA, 'Glade Ward');
        await expect.poll(() => readUserFile(B, 'worlds/Glade Ward.json') !== null, { timeout: 60_000 }).toBe(true);
    });

    test('a change on A appears on B after B polls', async ({ browser }) => {
        const { pageA } = await pairedPages(browser, { idleA: 3600, pollA: 3600, idleB: 3600, pollB: 3 });
        await createWorldBook(pageA, 'Moonwell Notes');
        await expect.poll(() => readUserFile(B, 'worlds/Moonwell Notes.json') !== null, { timeout: 60_000 }).toBe(true);
    });

    test('disjoint edits on both devices merge cleanly', async ({ browser }) => {
        const { pageA, pageB } = await pairedPages(browser, { idleA: 3600, pollA: 3600, idleB: 3600, pollB: 3600 });
        await createWorldBook(pageA, 'Thornwatch');
        await createWorldBook(pageB, 'Rivermouth');
        await openLanSyncPanel(pageB);
        expect(await clickSyncNow(pageB, 'A device')).toBe('success');
        expect(readUserFile(B, 'worlds/Thornwatch.json')).not.toBeNull();
        // A applies B's push in the run the notify started.
        await expect.poll(() => readUserFile(A, 'worlds/Rivermouth.json') !== null, { timeout: 30_000 }).toBe(true);
    });
});
