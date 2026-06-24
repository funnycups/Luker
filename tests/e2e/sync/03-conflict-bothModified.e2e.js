// Spec §8.3 scenario 5: after pair, both sides edit the SAME file.
// Sync surfaces a `bothModified` conflict; user picks ours; the
// resolution lands on both sides.
//
// This is the "make a difficult choice" path — the spec's note that
// conflicts are always per-file with no line merge means we MUST see a
// concrete pick UI, not a silent auto-merge.

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
        scenarioId: 'bothmod-A',
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'bothmod-B',
    });
    markOnboarded({ dataRoot: A.dataRoot });
    markOnboarded({ dataRoot: B.dataRoot });

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
    test('same file edited on both sides → conflict UI → user picks Local → ours wins on both sides', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // Pair on the seed-identical state. With identical worlds trees
        // and no common ancestor, attemptMerge's identical-trees branch
        // auto-produces a merge commit (no conflict surfaces).
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
        // Trees were identical → auto-merge path returns success.
        // (If the seed had drifted, this would be 'warning' and we'd
        // pick 'theirs' to align the bases. Document both as acceptable
        // since the seed contents are outside this spec's control.)
        if (pairOutcome === 'warning') {
            await resolveAllConflictsAs(pageB, 'theirs');
        }

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

        // B clicks Sync now. Both sides have ONE shared commit (the
        // post-pair merge) and each made one new commit after. The
        // three-way merge finds the shared base, sees the same file
        // edited on both sides → bothModified conflict.
        const syncOutcome = await clickSyncNow(pageB, 'A device');
        expect(syncOutcome).toBe('warning');

        // Inspect the conflict UI: exactly one bothModified conflict on
        // shared.json. The UI's "Type:" annotation is the kind.
        const kinds = await listConflictKinds(pageB);
        expect(kinds['worlds/shared.json']).toBe('bothModified');

        // Pick "Local" (ours) — B's edit wins.
        const resolveOutcome = await applyConflictResolutions(pageB, {
            'worlds/shared.json': 'ours',
        });
        expect(resolveOutcome).toBe('success');

        // B's live file holds B's edit (preserved through reconcile).
        const onB = JSON.parse(fs.readFileSync(
            path.join(B.dataRoot, 'default-user', 'worlds', 'shared.json'),
            'utf8',
        ));
        expect(onB.notes).toBe('B-edit-after-pair');

        // Critical assertion for the responder reconcile: A's live file
        // ALSO shows B's edit, because B's runPull pushed the resolved
        // HEAD back to A via /session/ref, which triggers A's responder
        // reconcile to materialize the merged tree into A's live data.
        await expect.poll(
            () => {
                try {
                    return JSON.parse(fs.readFileSync(
                        path.join(A.dataRoot, 'default-user', 'worlds', 'shared.json'),
                        'utf8',
                    )).notes;
                } catch { return null; }
            },
            { timeout: 10_000 },
        ).toBe('B-edit-after-pair');

        await ctxA.close();
        await ctxB.close();
    });
});
