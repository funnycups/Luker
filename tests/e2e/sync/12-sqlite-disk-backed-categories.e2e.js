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
// seed content. The pair must surface A's unique files as conflicts
// (deleteByUs from B's perspective) — their presence in the conflict list
// is itself proof that the disk-backed category entered the snapshot.
// Resolving them to A's side must land both on B, and A must keep its own
// character. Then A deletes its character and world and B syncs: both
// deletions must propagate (the stale-workdir sweep for SQL-backed
// records, the live walk for disk-backed ones).

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { migrateViaAdminUI, fetchStorageStatus, closeAdminPanel } from '../_lib/storage-ui.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    resolveAllConflictsAs,
    listConflictKinds,
    clickSyncNow,
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
    return page.evaluate(async ({ name, data }) => {
        const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
        const { token } = await csrfResp.json();
        const res = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ name, data }),
        });
        if (!res.ok) throw new Error(`/api/worldinfo/edit failed: ${res.status}`);
        return res.json();
    }, { name, data: worldDoc(name) });
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
    return page.evaluate(async ({ name }) => {
        const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
        const { token } = await csrfResp.json();
        const res = await fetch('/api/worldinfo/delete', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error(`/api/worldinfo/delete failed: ${res.status}`);
        return res.status;
    }, { name });
}

function listDir(dir) {
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

test.beforeAll(async () => {
    A = await startServer({ batchKey: 'sync', scenarioId: 'sqlite-chars-A' });
    B = await startServer({ batchKey: 'sync', scenarioId: 'sqlite-chars-B' });
    markOnboarded({ dataRoot: A.dataRoot });
    markOnboarded({ dataRoot: B.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — SQLite mode with disk-backed categories', () => {
    test('characters and worlds both move across a sqlite pair; deleted character and world propagate on the next sync', async ({ browser }) => {
        test.setTimeout(300_000);

        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
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
        // symmetric-diff entries are A's unique files. Their presence in
        // the conflict list proves the disk-backed character entered the
        // SQL-mode snapshot; before the fix the shadow held only worlds,
        // the trees were identical, and the pair reported success with
        // zero movement.
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, {
            label: 'B device',
            categories: ['worlds', 'characters'],
        });

        await openLanSyncPanel(pageB);
        const acceptOutcome = await acceptPairingLink(pageB, link, {
            categories: ['worlds', 'characters'],
            localLabel: 'A device',
        });
        expect(acceptOutcome).toBe('warning');

        const kinds = await listConflictKinds(pageB);
        expect(kinds['characters/alpha-character.png']).toBe('deleteByUs');
        expect(kinds['worlds/alpha-world.json']).toBe('deleteByUs');

        // Take A's side everywhere: A's unique files land on B.
        const resolved = await resolveAllConflictsAs(pageB, 'theirs');
        expect(resolved).toBe('success');

        // B receives A's character and world; A keeps its own character
        // (before the fix the responder reconcile wiped it).
        await expect.poll(() => listDir(bChars), { timeout: 15_000 }).toContain(A_CHAR);
        expect(listDir(aChars)).toContain(A_CHAR);
        await expect.poll(async () => {
            const w = await fetchWorld(pageB, A_WORLD);
            return w?.entries?.['0']?.comment ?? null;
        }, { timeout: 15_000 }).toBe(A_WORLD);
        expect((await fetchWorld(pageA, A_WORLD))?.entries?.['0']?.comment).toBe(A_WORLD);

        // Deletion propagation, disk-backed: A deletes its character file,
        // B syncs, and the deletion must reach B's live tree.
        fs.unlinkSync(path.join(aChars, A_CHAR));
        const charOutcome = await clickSyncNow(pageB, 'A device');
        expect(['success', 'warning']).toContain(charOutcome);
        if (charOutcome === 'warning') {
            const again = await resolveAllConflictsAs(pageB, 'theirs');
            expect(again).toBe('success');
        }
        await expect.poll(() => listDir(bChars), { timeout: 15_000 }).not.toContain(A_CHAR);

        // Deletion propagation, SQL-backed: A deletes its world through the
        // API, B syncs, and B's engine must no longer know the row. Without
        // the stale-workdir sweep the materializer would leave
        // alpha-world.json in the workdir and the deletion would never be
        // committed.
        await deleteWorld(pageA, A_WORLD);
        const worldOutcome = await clickSyncNow(pageB, 'A device');
        expect(['success', 'warning']).toContain(worldOutcome);
        if (worldOutcome === 'warning') {
            const again = await resolveAllConflictsAs(pageB, 'theirs');
            expect(again).toBe('success');
        }
        await expect.poll(async () => {
            const w = await fetchWorld(pageB, A_WORLD);
            return w?.entries?.['0']?.comment ?? null;
        }, { timeout: 15_000 }).toBe(null);

        await ctxA.close();
        await ctxB.close();
    });
});
