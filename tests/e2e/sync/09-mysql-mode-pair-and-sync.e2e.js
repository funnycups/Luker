// LAN Sync e2e — both servers in MySQL storage mode.
//
// The SQL engines are fully syncable via per-record
// materialize/dematerialize: instead of shipping a whole-DB blob, each
// side projects its rows into a shadow workdir as one file per record,
// commits that, and the responder dematerializes the merged tree back
// through the engine. The companion in-process test pins the engine
// contract; this e2e drives the full UI pair-and-sync loop against
// real mysql:8 servers spun up via testcontainers so a regression that
// only shows up in real mysql (driver quirks, transaction isolation,
// blob encoding) is caught end-to-end.
//
// Requires Docker. Skipping is NOT an option — the project explicitly
// forbids "skip if env var unset" patterns. If the harness can't bring
// up the container, that's an infrastructure failure to surface, not
// hide.

import { test, expect } from '@playwright/test';

import { startServer, tearDownServer } from '../_lib/server.js';
import { startMysqlContainer } from '../_lib/db-containers.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    resolveAllConflictsAs,
} from '../_lib/sync.js';

const A_DB = 'luker_test_sync_a';
const B_DB = 'luker_test_sync_b';
const SEED_WORLD = 'mysql-mode-seeded';
const SEED_WORLD_DATA = {
    entries: {
        '0': {
            uid: 0,
            key: ['mysql cross sync'],
            keysecondary: [],
            comment: 'mysql-sync-marker',
            content: 'A wrote this world into mysql; after the LAN sync lands, B reads it back through its own engine.',
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
    // One container, two isolated databases. Splitting at the DB layer
    // (not at the schema layer) keeps the test honest: A's connection
    // pool only ever sees A's tables; same for B.
    mysqlContainer = await startMysqlContainer({ databases: [A_DB, B_DB] });

    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'mysql-A',
        extraConfig: {
            'storage.mode': 'mysql',
            'storage.mysql.url': mysqlContainer.urlFor(A_DB),
        },
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'mysql-B',
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
 * Save a world through /api/worldinfo/edit so it lands in mysql via
 * WorldInfoRepo → engine.putResource. Returns the parsed response.
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
 * Read a world back through /api/worldinfo/get so the assertion goes
 * through engine.getResource — proves the row landed in the right table
 * under the right handle, not in a parallel cache the engine ignores.
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

test.describe('LAN Sync — mysql mode pair and sync', () => {
    test('A seeds a world via the worldinfo API into mysql; B receives it after sync; B reads it back via the worldinfo API', async ({ browser }) => {
        test.setTimeout(300_000);

        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // Seed A's mysql with the marker world. After this returns,
        // the row lives in A's mysql DB under `default-user`; B's mysql
        // DB has only the initial seed content (no marker).
        await saveWorld(pageA, SEED_WORLD, SEED_WORLD_DATA);
        const aPre = await fetchWorld(pageA, SEED_WORLD);
        expect(aPre?.entries?.['0']?.comment).toBe('mysql-sync-marker');
        const bPre = await fetchWorld(pageB, SEED_WORLD);
        // B has no entry under that name — the get endpoint returns an
        // empty world per its allowDummy contract.
        expect(bPre?.entries?.['0']).toBeUndefined();

        // Pair on the worlds category. Both sides project their worlds
        // table into the shadow workdir as one .json per row; the merge
        // either auto-succeeds (identical seed) or surfaces conflicts
        // on the seed Eldoria.json. Marker.json is unique to A so it
        // always lands clean.
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

        // The defining assertion: B's worldinfo API reports A's marker.
        // The data path goes pair/accept → runPull → reconcile →
        // dematerialize → WorldInfoRepo.save → MysqlEngine.putResource
        // → SELECT round-trip via /api/worldinfo/get. If any link in
        // that chain regressed under mysql, this returns the empty
        // world from `allowDummy`.
        await expect.poll(async () => {
            const w = await fetchWorld(pageB, SEED_WORLD);
            return w?.entries?.['0']?.comment ?? null;
        }, { timeout: 15_000 }).toBe('mysql-sync-marker');

        await ctxA.close();
        await ctxB.close();
    });
});
