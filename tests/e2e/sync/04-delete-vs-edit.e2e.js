// A deletes a file, B edits the same file.
// The Sync issues page lists the file; B picks its own edit, which survives
// on both sides.

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
    listPopupConflicts,
    conflictChoiceShowing,
    chooseConflictVersion,
    applyConflictChoices,
    readUserFile,
} from '../_lib/sync.js';

let A, B;

test.beforeAll(async () => {
    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'delvs-A',
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'delvs-B',
    });

    // Pre-seed both sides with the same file so pairing puts it in the
    // shared history before A deletes / B edits it.
    const initial = JSON.stringify({ name: 'doomed', notes: 'pre-pair' });
    const aWorlds = path.join(A.dataRoot, 'default-user', 'worlds');
    const bWorlds = path.join(B.dataRoot, 'default-user', 'worlds');
    fs.mkdirSync(aWorlds, { recursive: true });
    fs.mkdirSync(bWorlds, { recursive: true });
    fs.writeFileSync(path.join(aWorlds, 'doomed.json'), initial);
    fs.writeFileSync(path.join(bWorlds, 'doomed.json'), initial);
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — delete vs edit conflict', () => {
    test('A deletes, B edits → Sync issues page → B picks its edit → file kept on both sides', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // Pair on the seed-identical state.
        const pairedSince = Date.now();
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, {
            label: 'B device',
            categories: ['worlds'],
        });
        await openLanSyncPanel(pageB);
        expect(await acceptPairingLink(pageB, link, {
            categories: ['worlds'],
            localLabel: 'A device',
        })).toBe('success');
        // A syncs in the background on B's notify; edits made during that
        // run would race it.
        await waitForBackgroundSync(pageA, { since: pairedSince });
        await waitForBackgroundSync(pageB, { since: pairedSince });

        // A deletes the file.
        fs.unlinkSync(path.join(A.dataRoot, 'default-user', 'worlds', 'doomed.json'));

        // B edits the file (different content from the pre-pair snapshot).
        fs.writeFileSync(
            path.join(B.dataRoot, 'default-user', 'worlds', 'doomed.json'),
            JSON.stringify({ name: 'doomed', notes: 'B-saved-it' }),
        );

        // B syncs: one side edited what the other deleted.
        const syncOutcome = await clickSyncNow(pageB, 'A device');
        expect(syncOutcome).toBe('warning');

        await waitForSyncPopup(pageB);
        expect(await listPopupConflicts(pageB)).toEqual([{ path: 'worlds/doomed.json', stale: false }]);
        // The merge decides which device is `ours`, so find B's version by its content.
        const bChoice = await conflictChoiceShowing(pageB, 'worlds/doomed.json', 'B-saved-it');
        await chooseConflictVersion(pageB, 'worlds/doomed.json', bChoice);
        expect(await applyConflictChoices(pageB)).toBe('success');
        expect(JSON.parse(readUserFile(B, 'worlds/doomed.json')).notes).toBe('B-saved-it');
        // B pushes the resolution and A applies it from the notify-driven run.
        await expect.poll(() => { try { return JSON.parse(readUserFile(A, 'worlds/doomed.json')).notes; } catch { return null; } }, { timeout: 30_000 }).toBe('B-saved-it');

        await ctxA.close();
        await ctxB.close();
    });
});
