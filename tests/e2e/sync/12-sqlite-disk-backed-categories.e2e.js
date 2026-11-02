// SQLite-mode LAN Sync e2e — disk-backed categories.
//
// Test 06 covers a SQL-backed category (chats) in SQLite mode: the row is
// projected into the shadow workdir as a per-record file and the merged
// tree dematerializes back through the engine. This test covers the other
// half of the category split: disk-backed categories (characters) stay on
// the live filesystem in every engine, so the SQL-mode snapshot must read
// them from the live root while it reads the SQL-backed categories from
// the workdir. Before the per-category snapshot plan, SQL mode anchored
// every category at the workdir, so characters silently never entered the
// snapshot — the pair reported success with zero movement, and the
// reconcile deletion sweep wiped the live character files.
//
// The test drives the real pair/accept flow with worlds + characters
// enabled. A holds a unique character and a unique world; B has only the
// seed content. A's unique files are additions only A made, so they
// merge cleanly — B receiving the character is itself proof that the
// disk-backed category entered the snapshot, and A must keep its own
// character. Then A deletes its character and world and B syncs: both
// deletions must propagate (the stale-workdir sweep for SQL-backed
// records, the live walk for disk-backed ones) and hold on A.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { importWorldDocument, selectWorldBook, deleteSelectedWorldBook } from '../_lib/ui-worldinfo.js';
import { migrateViaAdminUI, fetchStorageStatus, closeAdminPanel } from '../_lib/storage-ui.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    clickSyncNow,
    waitForBackgroundSync,
    backendIdOf,
    shadowMain,
    closeAllPopups,
} from '../_lib/sync.js';

const A_CHAR = 'alpha-character.png';
const A_WORLD = 'alpha-world';

let A, B;

function worldDoc(marker) {
    return {
        entries: {
            '0': {
                uid: 0,
                key: [marker],
                keysecondary: [],
                comment: marker,
                content: `${marker} body`,
                constant: true,
                selective: true,
                order: 100,
                position: 0,
                disable: false,
                displayIndex: 0,
                probability: 100,
            },
        },
    };
}

async function saveWorld(page, name) {
    await importWorldDocument(page, name, worldDoc(name));
}

async function fetchWorld(page, name) {
    return page.evaluate(async ({ name }) => {
        const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
        const { token } = await csrfResp.json();
        const res = await fetch('/api/worldinfo/get', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error(`/api/worldinfo/get failed: ${res.status}`);
        return res.json();
    }, { name });
}

async function deleteWorld(page, name) {
    await selectWorldBook(page, name);
    await deleteSelectedWorldBook(page);
}

function listDir(dir) {
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

test.beforeAll(async () => {
    A = await startServer({ batchKey: 'sync', scenarioId: 'sqlite-chars-A' });
    B = await startServer({ batchKey: 'sync', scenarioId: 'sqlite-chars-B' });
});

test.afterAll(async () => {
    for (const context of ownedContexts.splice(0)) await context.close();
    await tearDownServer(A);
    await tearDownServer(B);
});

const ownedContexts = [];

test.describe('LAN Sync — SQLite mode with disk-backed categories', () => {
    test('characters and worlds both move across a sqlite pair; deleted character and world propagate on the next sync', async ({ browser }) => {
        test.setTimeout(300_000);

        const ctxA = await browser.newContext();
        ownedContexts.push(ctxA);
        const ctxB = await browser.newContext();
        ownedContexts.push(ctxB);
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // Both sides migrate fs → sqlite through the real admin UI.
        await migrateViaAdminUI(pageA, 'sqlite');
        expect((await fetchStorageStatus(pageA)).currentMode).toBe('sqlite');
        await closeAdminPanel(pageA);

        await migrateViaAdminUI(pageB, 'sqlite');
        expect((await fetchStorageStatus(pageB)).currentMode).toBe('sqlite');
        await closeAdminPanel(pageB);

        const aChars = path.join(A.dataRoot, 'default-user', 'characters');
        const bChars = path.join(B.dataRoot, 'default-user', 'characters');

        // Seed A with a unique character (disk-backed) and a unique world
        // (SQL-backed, through the worldinfo API into sqlite). B keeps only
        // the seed content both sides cloned from `data/`.
        fs.mkdirSync(aChars, { recursive: true });
        fs.writeFileSync(path.join(aChars, A_CHAR), Buffer.from('fake-png-alpha'));
        await saveWorld(pageA, A_WORLD);

        // Pair on worlds + characters. The seed worlds are byte-identical
        // on both sides (same fs → sqlite migration), so the only
        // differences are A's unique files, which merge cleanly. Before
        // the fix the shadow held only worlds and the character never
        // moved.
        const pairedSince = Date.now();
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, {
            label: 'B device',
            categories: ['worlds', 'characters'],
        });

        await openLanSyncPanel(pageB);
        expect(await acceptPairingLink(pageB, link, {
            categories: ['worlds', 'characters'],
            localLabel: 'A device',
        })).toBe('success');

        // B receives A's character and world; A keeps its own character
        // (before the fix A's reconcile wiped it).
        await expect.poll(() => listDir(bChars), { timeout: 15_000 }).toContain(A_CHAR);
        expect(listDir(aChars)).toContain(A_CHAR);
        await expect.poll(async () => {
            const w = await fetchWorld(pageB, A_WORLD);
            return w?.entries?.['0']?.comment ?? null;
        }, { timeout: 15_000 }).toBe(A_WORLD);
        expect((await fetchWorld(pageA, A_WORLD))?.entries?.['0']?.comment).toBe(A_WORLD);

        // Both devices hold the same main once a sync finished.
        const sameMain = async () => await shadowMain(A, backendIdOf(A)) === await shadowMain(B, backendIdOf(B));

        // A syncs in the background on B's notify; a deletion made during
        // that run would race it.
        await waitForBackgroundSync(pageA, { since: pairedSince });
        expect(listDir(aChars)).toContain(A_CHAR);

        // Deletion propagation, disk-backed: A deletes its character file,
        // B syncs, and the deletion must reach B's live tree.
        fs.unlinkSync(path.join(aChars, A_CHAR));
        const charOutcome = await clickSyncNow(pageB, 'A device');
        expect(charOutcome).toBe('success');
        await expect.poll(() => listDir(bChars), { timeout: 30_000 }).not.toContain(A_CHAR);
        await expect.poll(sameMain, { timeout: 30_000 }).toBe(true);
        expect(listDir(aChars)).not.toContain(A_CHAR);

        // Deletion propagation, SQL-backed: A deletes its world through the
        // editor, B syncs, and B's engine must no longer know the row. Without
        // the stale-workdir sweep the materializer would leave
        // alpha-world.json in the workdir and the deletion would never be
        // committed.
        await closeAllPopups(pageA);
        await deleteWorld(pageA, A_WORLD);
        const worldOutcome = await clickSyncNow(pageB, 'A device');
        expect(worldOutcome).toBe('success');
        await expect.poll(async () => {
            const w = await fetchWorld(pageB, A_WORLD);
            return w?.entries?.['0']?.comment ?? null;
        }, { timeout: 30_000 }).toBe(null);
        await expect.poll(sameMain, { timeout: 30_000 }).toBe(true);
        expect((await fetchWorld(pageA, A_WORLD))?.entries?.['0']?.comment ?? null).toBe(null);
        expect(listDir(aChars)).not.toContain(A_CHAR);

        await ctxA.close();
        await ctxB.close();
    });
});
