// After pair, disjoint edits on each side
// become visible after one sync round-trip.
//
// Tests the "Sync now" path against an already-paired peer (using the
// stored peerBaseUrl, no re-prompt): B pushes the merged commit to its
// incoming ref on A and notifies A, whose own sync run then applies it
// to A's live tree.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    readUserFile,
    waitForBackgroundSync,
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    clickSyncNow,
} from '../_lib/sync.js';

let A, B;

test.beforeAll(async () => {
    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'disjoint-A',
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'disjoint-B',
    });
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — disjoint edits clean sync', () => {
    test('A edit and B edit both land on both sides after Sync now', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // Pair so both sides share a sync history before the disjoint edits.
        // Both servers start from the same seed `data/`, so the first sync
        // is clean and no conflict is pending before the edits.
        const pairedSince = Date.now();
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, {
            label: 'B device',
            categories: ['worlds'],
        });
        await openLanSyncPanel(pageB);
        const acceptOutcome = await acceptPairingLink(pageB, link, {
            categories: ['worlds'],
            localLabel: 'A device',
        });
        expect(acceptOutcome).toBe('success');
        // A syncs in the background on B's notify; edit only after both
        // devices finished their runs.
        await waitForBackgroundSync(pageA, { since: pairedSince });
        await waitForBackgroundSync(pageB, { since: pairedSince });

        // Disjoint edits: A creates one file, B creates a different file.
        // These edits land directly on disk — the test is about the sync
        // round-trip, not about UI-driven file creation.
        fs.writeFileSync(
            path.join(A.dataRoot, 'default-user', 'worlds', 'A-only-edit.json'),
            JSON.stringify({ name: 'A-only-edit', side: 'A' }),
        );
        fs.writeFileSync(
            path.join(B.dataRoot, 'default-user', 'worlds', 'B-only-edit.json'),
            JSON.stringify({ name: 'B-only-edit', side: 'B' }),
        );

        // B clicks Sync now. B's sync run:
        //   1. Snapshots B's live tree (commits B-only-edit.json).
        //   2. Reads A's head through /session/offer, which snapshots A's
        //      live tree first (commits A-only-edit.json).
        //   3. Merges. The two new files are on disjoint paths, so this
        //      merges cleanly with no conflict.
        //   4. Pushes the merged commit to B's incoming ref on A through
        //      /session/ref and notifies A, which runs its own sync and
        //      applies the commit to A's live tree.
        const syncOutcome = await clickSyncNow(pageB, 'A device');
        expect(syncOutcome).toBe('success');

        // A's file is on B as soon as B's run finished.
        const onB = readUserFile(B, 'worlds/A-only-edit.json');
        expect(onB).not.toBeNull();
        expect(JSON.parse(onB).side).toBe('A');

        // A applies B's push in the run the notify started.
        await expect.poll(
            () => readUserFile(A, 'worlds/B-only-edit.json'),
            { timeout: 30_000 },
        ).toBe(JSON.stringify({ name: 'B-only-edit', side: 'B' }));

        await ctxA.close();
        await ctxB.close();
    });
});
