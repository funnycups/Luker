// LAN Sync e2e — both servers in Postgres storage mode.
//
// Mirror of spec 09 against postgres:16 via testcontainers. The
// per-record materialize/dematerialize path must land worlds rows in
// the right postgres schema under the right handle so a regression in
// pg-side encoding or transactional isolation surfaces here.

import { test, expect } from '@playwright/test';

import { startServer, tearDownServer } from '../_lib/server.js';
import { startPostgresContainer } from '../_lib/db-containers.js';
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
const SEED_WORLD = 'pg-mode-seeded';
const SEED_WORLD_DATA = {
    entries: {
        '0': {
            uid: 0,
            key: ['postgres cross sync'],
            keysecondary: [],
            comment: 'postgres-sync-marker',
            content: 'A wrote this world into postgres; after the LAN sync lands, B reads it back through its own engine.',
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

let pgContainer;
let A, B;

test.beforeAll(async () => {
    pgContainer = await startPostgresContainer({ databases: [A_DB, B_DB] });

    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'pg-A',
        extraConfig: {
            'storage.mode': 'postgres',
            'storage.postgres.url': pgContainer.urlFor(A_DB),
        },
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'pg-B',
        extraConfig: {
            'storage.mode': 'postgres',
            'storage.postgres.url': pgContainer.urlFor(B_DB),
        },
    });
    markOnboarded({ dataRoot: A.dataRoot });
    markOnboarded({ dataRoot: B.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
    if (pgContainer) await pgContainer.stop();
});

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

test.describe('LAN Sync — postgres mode pair and sync', () => {
    test('A seeds a world via the worldinfo API into postgres; B receives it after sync; B reads it back via the worldinfo API', async ({ browser }) => {
        test.setTimeout(300_000);

        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        await saveWorld(pageA, SEED_WORLD, SEED_WORLD_DATA);
        const aPre = await fetchWorld(pageA, SEED_WORLD);
        expect(aPre?.entries?.['0']?.comment).toBe('postgres-sync-marker');
        const bPre = await fetchWorld(pageB, SEED_WORLD);
        expect(bPre?.entries?.['0']).toBeUndefined();

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

        await expect.poll(async () => {
            const w = await fetchWorld(pageB, SEED_WORLD);
            return w?.entries?.['0']?.comment ?? null;
        }, { timeout: 15_000 }).toBe('postgres-sync-marker');

        await ctxA.close();
        await ctxB.close();
    });
});
