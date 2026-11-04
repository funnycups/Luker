// "Sync now" tells the user about conflicts that are still undecided, also
// when the run it started merged nothing: the result banner shows the warning
// and leads back to the Sync issues page after the user closed it.
//
// Two real servers; the conflicting edits are written straight to disk as
// in spec 02, everything else goes through the Sync pages of the Account
// window.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    clickSyncNow,
    waitForBackgroundSync,
    waitForSyncPopup,
    closeSyncPopup,
    listPopupConflicts,
} from '../_lib/sync.js';

const WORLD = 'worlds/pending-conflict.json';

let A, B;
const worldFile = server => path.join(server.dataRoot, 'default-user', ...WORLD.split('/'));

test.beforeAll(async () => {
    A = await startServer({ batchKey: 'sync', scenarioId: 'pending-A' });
    B = await startServer({ batchKey: 'sync', scenarioId: 'pending-B' });
    fs.writeFileSync(worldFile(A), JSON.stringify({ name: 'pending-conflict', note: 'base' }));
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — pending conflicts after Sync now', () => {
    test('Sync now warns and leads back to the Sync issues page while a conflict is undecided', async ({ browser }) => {
        test.setTimeout(180_000);
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        const pairedSince = Date.now();
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, { label: 'B device', categories: ['worlds'] });
        await openLanSyncPanel(pageB);
        expect(await acceptPairingLink(pageB, link, { categories: ['worlds'], localLabel: 'A device' })).toBe('success');
        await waitForBackgroundSync(pageA, { since: pairedSince });
        await waitForBackgroundSync(pageB, { since: pairedSince });

        fs.writeFileSync(worldFile(A), JSON.stringify({ name: 'pending-conflict', note: 'edited on A' }));
        fs.writeFileSync(worldFile(B), JSON.stringify({ name: 'pending-conflict', note: 'edited on B' }));
        const editedSince = Date.now();

        // B's run records the conflict and the Sync issues page lists it.
        expect(await clickSyncNow(pageB, 'A device')).toBe('warning');
        await waitForSyncPopup(pageB);
        expect((await listPopupConflicts(pageB)).map(c => c.path)).toEqual([WORLD]);
        await closeSyncPopup(pageB);

        // The next run merges nothing. The conflict is still undecided, so
        // the banner warns and its Resolve button opens the Sync issues page again.
        expect(await clickSyncNow(pageB, 'A device')).toBe('warning');
        await waitForSyncPopup(pageB, 10_000);
        expect((await listPopupConflicts(pageB)).map(c => c.path)).toEqual([WORLD]);
        await closeSyncPopup(pageB);

        // A gets the conflict through the run B's push started. Reloading
        // shows it once; after the user closes it, Sync now warns and
        // leads to it again.
        await waitForBackgroundSync(pageA, { since: editedSince });
        await awaitMainUI(pageA, A.baseURL);
        await waitForSyncPopup(pageA);
        await closeSyncPopup(pageA);
        await openLanSyncPanel(pageA);
        expect(await clickSyncNow(pageA, 'B device')).toBe('warning');
        await waitForSyncPopup(pageA, 10_000);
        expect((await listPopupConflicts(pageA)).map(c => c.path)).toEqual([WORLD]);

        await ctxA.close();
        await ctxB.close();
    });
});
