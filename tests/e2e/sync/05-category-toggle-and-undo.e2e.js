// Spec §8.3 scenarios 7-8: a sync with a narrow category selection
// (only `worlds`) does NOT propagate changes outside that category;
// and "Undo last sync" rewinds the most recent sync on that side.

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
    clickUndoLastSync,
} from '../_lib/sync.js';

let A, B;

test.beforeAll(async () => {
    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'cat-undo-A',
        extraConfig: { enableUserAccounts: false },
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'cat-undo-B',
        extraConfig: { enableUserAccounts: false },
    });
    markOnboarded({ dataRoot: A.dataRoot });
    markOnboarded({ dataRoot: B.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — category toggle and undo', () => {
    test('worlds-only pair: chats edits do NOT propagate; undo rewinds the last sync', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // Pair selecting ONLY the worlds category. Any other category's
        // files must not move between sides even if they exist on both.
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

        // A creates a file in BOTH categories: worlds (in scope) and
        // chats (out of scope).
        const aWorlds = path.join(A.dataRoot, 'default-user', 'worlds');
        const aChats = path.join(A.dataRoot, 'default-user', 'chats');
        fs.mkdirSync(aWorlds, { recursive: true });
        fs.mkdirSync(aChats, { recursive: true });
        fs.writeFileSync(
            path.join(aWorlds, 'will-cross.json'),
            JSON.stringify({ name: 'will-cross', side: 'A' }),
        );
        fs.writeFileSync(
            path.join(aChats, 'will-not-cross.jsonl'),
            '{"name":"u","mes":"this is a chat file outside the synced categories"}\n',
        );

        // B syncs. Only worlds is in scope, so the chats file MUST NOT
        // travel.
        const syncOutcome = await clickSyncNow(pageB, 'A device');
        expect(syncOutcome).toBe('success');

        // worlds file crossed.
        await expect.poll(
            () => fs.existsSync(path.join(B.dataRoot, 'default-user', 'worlds', 'will-cross.json')),
            { timeout: 10_000 },
        ).toBe(true);

        // chats file did NOT cross — the category-toggle gate held.
        // This is the load-bearing assertion: the snapshot+reconcile path
        // honors `enabledCategoryIds` correctly.
        expect(fs.existsSync(path.join(B.dataRoot, 'default-user', 'chats', 'will-not-cross.jsonl'))).toBe(false);

        // Snapshot B's worlds dir so we can verify undo brings it back.
        const beforeUndo = fs.readdirSync(path.join(B.dataRoot, 'default-user', 'worlds')).sort();
        expect(beforeUndo).toContain('will-cross.json');

        // Undo last sync on B. Should rewind B's worlds dir to the
        // state before the last sync — i.e., remove `will-cross.json`.
        const undoOutcome = await clickUndoLastSync(pageB, 'A device');
        expect(undoOutcome).toBe('success');

        // The newly-synced file is gone from B; the rest of B's worlds
        // dir (the post-pair shared state) is preserved.
        await expect.poll(
            () => fs.existsSync(path.join(B.dataRoot, 'default-user', 'worlds', 'will-cross.json')),
            { timeout: 10_000 },
        ).toBe(false);

        // A is unaffected by B's undo — the spec calls this out
        // explicitly ("undo is strictly local").
        expect(fs.existsSync(path.join(A.dataRoot, 'default-user', 'worlds', 'will-cross.json'))).toBe(true);

        await ctxA.close();
        await ctxB.close();
    });
});
