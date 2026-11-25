// A deletes a file, B edits the same file.
// The Sync issues page lists the file; B picks its own edit, which survives
// on both sides.

import { test, expect } from '../../harness/playwright.js';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

import { startServer } from '../../harness/server.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    clickSyncNow,
    waitForBackgroundSync,
    waitForSyncPopup,
    listPopupConflicts,
    conflictSideFromShadow,
    chooseConflictVersion,
    applyConflictChoices,
    readUserFile,
    userRootOf,
    backendIdOf,
} from '../_lib/sync.js';

let A, B;

const sharedBook = content => JSON.stringify({
    entries: { 0: { uid: 0, displayIndex: 0, comment: 'Doomed', content, key: ['doomed'], keysecondary: [] } },
});
const sharedContent = file => Object.values(JSON.parse(file).entries)[0].content;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    A = await startServer({ scope,
        batchKey: 'sync',
        scenarioId: 'delvs-A',
    });
    B = await startServer({ scope,
        batchKey: 'sync',
        scenarioId: 'delvs-B',
    });

    // Pre-seed both sides with the same world book so pairing puts it in the
    // shared history before A deletes / B edits it.
    const initial = sharedBook('pre-pair');
    const aWorlds = path.join(A.dataRoot, 'default-user', 'worlds');
    const bWorlds = path.join(B.dataRoot, 'default-user', 'worlds');
    fs.mkdirSync(aWorlds, { recursive: true });
    fs.mkdirSync(bWorlds, { recursive: true });
    fs.writeFileSync(path.join(aWorlds, 'doomed.json'), initial);
    fs.writeFileSync(path.join(bWorlds, 'doomed.json'), initial);
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
            sharedBook('B-saved-it'),
        );

        // B syncs: one side edited what the other deleted.
        const syncOutcome = await clickSyncNow(pageB, 'A device');
        expect(syncOutcome).toBe('warning');

        await waitForSyncPopup(pageB);
        expect(await listPopupConflicts(pageB)).toEqual([{ path: 'worlds/doomed.json', stale: false }]);
        // The merge decides which device is `ours`, so find B's version by its content.
        const bChoice = await conflictSideFromShadow(B, pageB, 'worlds/doomed.json', 'B-saved-it');
        const pending = await pageB.evaluate(async () => {
            const status = await (await fetch('/api/sync/v1/status')).json();
            return status.conflicts.find(conflict => conflict.path === 'worlds/doomed.json');
        });
        const gitdir = path.join(userRootOf(B), '.sync', backendIdOf(B), 'repo.git');
        const blob = await git.readBlob({ fs, gitdir, oid: pending[bChoice] });
        const object = path.join(gitdir, 'objects', blob.oid.slice(0, 2), blob.oid.slice(2));
        const original = fs.readFileSync(object);
        try {
            fs.writeFileSync(object, 'corrupt shadow object');
            await expect(conflictSideFromShadow(B, pageB, 'worlds/doomed.json', 'B-saved-it')).rejects.toThrow(/Cannot read conflict shadow.*worlds\/doomed\.json/);
        } finally {
            fs.writeFileSync(object, original);
        }
        await chooseConflictVersion(pageB, 'worlds/doomed.json', bChoice);
        expect(await applyConflictChoices(pageB)).toBe('success');
        expect(sharedContent(readUserFile(B, 'worlds/doomed.json'))).toBe('B-saved-it');
        // B pushes the resolution and A applies it from the notify-driven run.
        await expect.poll(() => { try { return sharedContent(readUserFile(A, 'worlds/doomed.json')); } catch { return null; } }, { timeout: 30_000 }).toBe('B-saved-it');

        await ctxA.close();
        await ctxB.close();
    });
});
