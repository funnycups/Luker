// LAN Sync e2e — cross-engine pair-and-sync (A on sqlite, B on mysql).
//
// Specs 09 / 10 cover same-engine pairs (mysql↔mysql, postgres↔postgres);
// spec 06 covers same-engine sqlite. None of them prove the architectural
// promise documented in `docs/development/lan-sync.md`: the shadow
// workdir is an engine-neutral JSON intermediate, so a pair between two
// different storage engines must round-trip cleanly. This spec drives
// that path end-to-end — A's sqlite rows materialize to per-record
// workdir files, transfer over the LAN sync, and dematerialize through
// B's mysql engine into mysql tables that the `/api/worldinfo/get`
// endpoint reads back exactly as A wrote.
//
// Combo choice: sqlite for A, mysql for B. Neither side is fs, so both
// directions exercise materialize + dematerialize (not the fs shortcut
// that writes the workdir tree directly). The two engines have wildly
// different on-disk shapes (file-backed sqlite vs networked mysql), so
// any leaked engine-specific assumption in the per-record projection
// breaks loudly. A is migrated fs → sqlite through the real admin UI
// (boot-time sqlite is not a proven pattern in the e2e harness); B
// boots straight into mysql via configured URL.
//
// Requires Docker for the mysql:8.0 testcontainer. Skipping is NOT an
// option; if the container can't come up, that's an infra failure to
// surface, not hide.

import { test, expect } from '@playwright/test';

import { startServer, tearDownServer } from '../_lib/server.js';
import { startMysqlContainer } from '../_lib/db-containers.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { migrateViaAdminUI, fetchStorageStatus, closeAdminPanel } from '../_lib/storage-ui.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    resolveAllConflictsAs,
} from '../_lib/sync.js';

const B_DB = 'luker_test_cross';
const SEED_WORLD = 'cross-engine-seeded';
const SEED_WORLD_DATA = {
    entries: {
        '0': {
            uid: 0,
            key: ['cross engine sync'],
            keysecondary: [],
            comment: 'cross-engine-marker',
            content: 'A wrote this world through sqlite. After the LAN sync lands on B, B reads it back through its mysql engine — proving the workdir intermediate is engine-neutral.',
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

let mysqlContainer;
let A, B;

test.beforeAll(async () => {
    // Only B needs the container. A runs entirely on sqlite (file-backed,
    // no external dependency) once it migrates via the admin UI.
    mysqlContainer = await startMysqlContainer({ databases: [B_DB] });

    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'cross-A-sqlite',
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'cross-B-mysql',
        extraConfig: {
            'storage.mode': 'mysql',
            'storage.mysql.url': mysqlContainer.urlFor(B_DB),
        },
    });
    markOnboarded({ dataRoot: A.dataRoot });
    markOnboarded({ dataRoot: B.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
    if (mysqlContainer) await mysqlContainer.stop();
});

/**
 * Save a world via /api/worldinfo/edit. Whatever storage engine the
 * server is running, the row lands in that engine through the repo.
 */
async function saveWorld(page, name, data) {
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
    }, { name, data });
}

/**
 * Read a world through /api/worldinfo/get so the assertion goes through
 * the responder's real engine — proves the row landed in mysql tables,
 * not in a parallel cache the engine ignores.
 */
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

test.describe('LAN Sync — cross-engine pair and sync', () => {
    test('A on sqlite seeds a world; B on mysql receives it via LAN sync and reads it back through its mysql engine', async ({ browser }) => {
        test.setTimeout(300_000);

        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // Flip A from fs to sqlite through the admin UI. After this
        // returns, every storage call on A routes through SqliteEngine.
        // B is already in mysql from the boot config; sanity-check both.
        await migrateViaAdminUI(pageA, 'sqlite');
        expect((await fetchStorageStatus(pageA)).currentMode).toBe('sqlite');
        await closeAdminPanel(pageA);

        expect((await fetchStorageStatus(pageB)).currentMode).toBe('mysql');

        // Seed A's sqlite with the marker world. After this returns,
        // the row lives in A's sqlite under default-user; B's mysql has
        // only the initial seed content (no marker).
        await saveWorld(pageA, SEED_WORLD, SEED_WORLD_DATA);
        const aPre = await fetchWorld(pageA, SEED_WORLD);
        expect(aPre?.entries?.['0']?.comment).toBe('cross-engine-marker');
        const bPre = await fetchWorld(pageB, SEED_WORLD);
        expect(bPre?.entries?.['0']).toBeUndefined();

        // Pair on the worlds category. A materializes its sqlite worlds
        // table into per-record JSON files in the shadow workdir; B
        // does the same with its mysql worlds table. The merge surfaces
        // either auto-clean (the unique marker.json always lands clean)
        // or a per-record conflict on shared seed worlds.
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, {
            label: 'B device',
            categories: ['worlds'],
        });

        await openLanSyncPanel(pageB);
        const outcome = await acceptPairingLink(pageB, link, {
            categories: ['worlds'],
            localLabel: 'A device',
        });
        expect(['warning', 'success']).toContain(outcome);
        if (outcome === 'warning') {
            const resolved = await resolveAllConflictsAs(pageB, 'theirs');
            expect(resolved).toBe('success');
        }

        // The defining assertion. Data path:
        //   A.SqliteEngine.getResource -> materialize -> workdir JSON
        //   -> git commit/transfer/merge
        //   -> B.dematerialize -> WorldInfoRepo.save -> MysqlEngine.putResource
        //   -> SELECT round-trip via /api/worldinfo/get.
        // If the workdir's JSON shape leaks any sqlite-specific encoding
        // (or mysql can't ingest a record written by sqlite), this
        // returns the empty world from `allowDummy` and the poll fails.
        await expect.poll(async () => {
            const w = await fetchWorld(pageB, SEED_WORLD);
            return w?.entries?.['0']?.comment ?? null;
        }, { timeout: 15_000 }).toBe('cross-engine-marker');

        await ctxA.close();
        await ctxB.close();
    });
});
