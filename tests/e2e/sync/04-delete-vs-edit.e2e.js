// A deletes a file, B edits the same file.
// Conflict UI shows the delete-vs-edit shape; user picks Local (B's
// edit survives); the file remains on both sides.

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
    listConflictKinds,
    applyConflictResolutions,
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
    markOnboarded({ dataRoot: A.dataRoot });
    markOnboarded({ dataRoot: B.dataRoot });

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
    test('A deletes, B edits → conflict shape correct → B picks Local → file kept on both sides', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // Pair on the seed-identical state.
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, {
            label: 'B device',
            categories: ['worlds'],
        });
        await openLanSyncPanel(pageB);
        const pairOutcome = await acceptPairingLink(pageB, link, {
            categories: ['worlds'],
            localLabel: 'A device',
        });
        if (pairOutcome === 'warning') {
            await resolveAllConflictsAs(pageB, 'theirs');
        }

        // A deletes the file.
        fs.unlinkSync(path.join(A.dataRoot, 'default-user', 'worlds', 'doomed.json'));

        // B edits the file (different content from the pre-pair snapshot).
        fs.writeFileSync(
            path.join(B.dataRoot, 'default-user', 'worlds', 'doomed.json'),
            JSON.stringify({ name: 'doomed', notes: 'B-saved-it' }),
        );

        // B syncs. The conflict from B's perspective is:
        //   - ours (B): file edited
        //   - theirs (A): file deleted
        // → kind = 'deleteByTheirs' (the other side deleted what we
        // edited).
        const syncOutcome = await clickSyncNow(pageB, 'A device');
        expect(syncOutcome).toBe('warning');

        const kinds = await listConflictKinds(pageB);
        expect(kinds['worlds/doomed.json']).toBe('deleteByTheirs');

        // B picks Local — keep B's edit, override A's delete.
        const resolveOutcome = await applyConflictResolutions(pageB, {
            'worlds/doomed.json': 'ours',
        });
        expect(resolveOutcome).toBe('success');

        // B's live file holds B's edit.
        const onB = JSON.parse(fs.readFileSync(
            path.join(B.dataRoot, 'default-user', 'worlds', 'doomed.json'),
            'utf8',
        ));
        expect(onB.notes).toBe('B-saved-it');

        // A's live file gets restored to B's edit via the responder
        // reconcile — A's delete was overridden by B's pick.
        await expect.poll(
            () => fs.existsSync(path.join(A.dataRoot, 'default-user', 'worlds', 'doomed.json')),
            { timeout: 10_000 },
        ).toBe(true);
        const onA = JSON.parse(fs.readFileSync(
            path.join(A.dataRoot, 'default-user', 'worlds', 'doomed.json'),
            'utf8',
        ));
        expect(onA.notes).toBe('B-saved-it');

        await ctxA.close();
        await ctxB.close();
    });
});
