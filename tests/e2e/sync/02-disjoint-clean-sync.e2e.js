// After pair, disjoint edits on each side
// become visible after one sync round-trip.
//
// Tests the "Sync now" path against an already-paired peer (using the
// stored peerBaseUrl, no re-prompt), plus the responder reconcile that
// pushes B's edit back to A's live tree via /session/ref.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    resolveAllConflictsAs,
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
    markOnboarded({ dataRoot: A.dataRoot });
    markOnboarded({ dataRoot: B.dataRoot });
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
        // The seed `data/` ships worlds files on both sides — the first pair
        // has the no-common-ancestor case, resolve all to A's version so the
        // post-pair state is well-defined (both sides match A's seed exactly).
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
        if (acceptOutcome === 'warning') {
            const finalOutcome = await resolveAllConflictsAs(pageB, 'theirs');
            expect(finalOutcome).toBe('success');
        }

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

        // B clicks Sync now. The orchestrator:
        //   1. Snapshots B's live → shadow (commits B-only-edit.json).
        //   2. Fetches A's HEAD via /session/offer (which snapshots A's
        //      live first → commits A-only-edit.json).
        //   3. Merges. The two new files are on disjoint paths, so this
        //      auto-merges cleanly with no conflict.
        //   4. Pushes the merged HEAD back to A via /session/ref, which
        //      triggers A's responder reconcile.
        const syncOutcome = await clickSyncNow(pageB, 'A device');
        expect(syncOutcome).toBe('success');

        // Both new files now exist on B (puller reconcile) AND on A
        // (responder reconcile triggered by /session/ref).
        await expect.poll(
            () => fs.existsSync(path.join(B.dataRoot, 'default-user', 'worlds', 'A-only-edit.json')),
            { timeout: 10_000 },
        ).toBe(true);
        await expect.poll(
            () => fs.existsSync(path.join(A.dataRoot, 'default-user', 'worlds', 'B-only-edit.json')),
            { timeout: 10_000 },
        ).toBe(true);

        // Content integrity on both sides.
        const onB = JSON.parse(fs.readFileSync(
            path.join(B.dataRoot, 'default-user', 'worlds', 'A-only-edit.json'),
            'utf8',
        ));
        expect(onB.side).toBe('A');
        const onA = JSON.parse(fs.readFileSync(
            path.join(A.dataRoot, 'default-user', 'worlds', 'B-only-edit.json'),
            'utf8',
        ));
        expect(onA.side).toBe('B');

        await ctxA.close();
        await ctxB.close();
    });
});
