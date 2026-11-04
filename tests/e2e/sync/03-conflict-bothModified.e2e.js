// After pair, both sides edit the SAME file.
// Sync records a conflict and offers it on the Sync issues page; B picks its own
// version; the resolution lands on both sides.
//
// This is the "make a difficult choice" path — by design
// conflicts are always per-file with no line merge, so we MUST see a
// concrete pick UI, not a silent auto-merge.

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
        scenarioId: 'bothmod-A',
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'bothmod-B',
    });

    // Seed a shared file with the SAME content on both sides BEFORE the
    // pair. After pairing it'll be in the shared history; subsequent
    // divergent edits will register as the bothModified case rather than
    // the no-common-ancestor case.
    const aWorlds = path.join(A.dataRoot, 'default-user', 'worlds');
    const bWorlds = path.join(B.dataRoot, 'default-user', 'worlds');
    fs.mkdirSync(aWorlds, { recursive: true });
    fs.mkdirSync(bWorlds, { recursive: true });
    const initial = JSON.stringify({ name: 'shared', notes: 'pre-pair' });
    fs.writeFileSync(path.join(aWorlds, 'shared.json'), initial);
    fs.writeFileSync(path.join(bWorlds, 'shared.json'), initial);
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — bothModified conflict', () => {
    test('same file edited on both sides → Sync issues page → B picks its own version → it wins on both sides', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // Pair on the seed-identical state: identical worlds trees merge
        // without a conflict.
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

        // Now diverge: each side rewrites shared.json with a different note.
        // Use distinguishable note strings so the assertion can prove
        // which side's content survived.
        fs.writeFileSync(
            path.join(A.dataRoot, 'default-user', 'worlds', 'shared.json'),
            JSON.stringify({ name: 'shared', notes: 'A-edit-after-pair' }),
        );
        fs.writeFileSync(
            path.join(B.dataRoot, 'default-user', 'worlds', 'shared.json'),
            JSON.stringify({ name: 'shared', notes: 'B-edit-after-pair' }),
        );

        // B clicks Sync now. Both sides share the post-pair commit and
        // each made one new commit after it, so the merge finds the same
        // file edited on both sides and records a conflict.
        const syncOutcome = await clickSyncNow(pageB, 'A device');
        expect(syncOutcome).toBe('warning');

        await waitForSyncPopup(pageB);
        expect(await listPopupConflicts(pageB)).toEqual([{ path: 'worlds/shared.json', stale: false }]);
        // The merge decides which device is `ours`, so find B's version by its content.
        const bChoice = await conflictChoiceShowing(pageB, 'worlds/shared.json', 'B-edit-after-pair');
        await chooseConflictVersion(pageB, 'worlds/shared.json', bChoice);
        expect(await applyConflictChoices(pageB)).toBe('success');
        expect(JSON.parse(readUserFile(B, 'worlds/shared.json')).notes).toBe('B-edit-after-pair');
        // B pushes the resolution and A applies it from the notify-driven run.
        await expect.poll(() => { try { return JSON.parse(readUserFile(A, 'worlds/shared.json')).notes; } catch { return null; } }, { timeout: 30_000 }).toBe('B-edit-after-pair');

        await ctxA.close();
        await ctxB.close();
    });
});
