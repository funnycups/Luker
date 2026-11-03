// A peer whose own reconcile fails keeps main and live consistent: the
// pushed commit waits in its journal and lands once the failure is gone.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { createWorldBook } from '../_lib/ui-worldinfo.js';
import { openLanSyncPanel, generatePairingLink, acceptPairingLink, clickSyncNow, closeAllPopups, backendCard, backendIdOf, readUserFile, shadowMain, userRootOf } from '../_lib/sync.js';

const WORLD = 'Ember Ward';
const THROW_ENV = { LUKER_SYNC_THROWPOINT: 'reconcile-write', LUKER_SYNC_THROWPOINT_MATCH: `worlds/${WORLD}.json` };
let A;
let B;

test.beforeAll(async () => {
    A = await startServer({ batchKey: 'sync', scenarioId: 'reconcile-fail-A', extraEnv: THROW_ENV });
    B = await startServer({ batchKey: 'sync', scenarioId: 'reconcile-fail-B' });
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

async function mainHas(server, rel) {
    const id = backendIdOf(server);
    const gitdir = path.join(userRootOf(server), '.sync', id, 'repo.git');
    const { commit } = await git.readCommit({ fs, gitdir, oid: await shadowMain(server, id) });
    const parts = rel.split('/');
    let tree = commit.tree;
    for (const [index, part] of parts.entries()) {
        const entry = (await git.readTree({ fs, gitdir, oid: tree })).tree.find(e => e.path === part);
        if (!entry) return false;
        if (index === parts.length - 1) return true;
        tree = entry.oid;
    }
    return false;
}

test('a failed peer reconcile leaves main and live without the pushed file until it succeeds', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, { label: 'B device', categories: ['worlds'] });
        await openLanSyncPanel(pageB);
        expect(await acceptPairingLink(pageB, link, { categories: ['worlds'], localLabel: 'A device' })).toBe('success');
        await closeAllPopups(pageB);

        await createWorldBook(pageB, WORLD);
        await openLanSyncPanel(pageB);
        expect(await clickSyncNow(pageB, 'A device')).toBe('success');

        const statePath = path.join(userRootOf(A), '.sync', 'state.json');
        await expect.poll(() => JSON.parse(fs.readFileSync(statePath, 'utf8')).backends[backendIdOf(A)].lastSync.error?.code, { timeout: 30_000 }).toBe('THROWPOINT');
        expect(readUserFile(A, `worlds/${WORLD}.json`)).toBeNull();
        expect(await mainHas(A, `worlds/${WORLD}.json`)).toBe(false);
        await closeAllPopups(pageA);
        await openLanSyncPanel(pageA);
        await expect(backendCard(pageA, 'B device').locator('.dw-card-note.bad')).toContainText('luker-sync-throwpoint');

        await tearDownServer(A, { removeData: false });
        A = await startServer({ batchKey: 'sync', scenarioId: 'reconcile-fail-A', useExistingDataRoot: A.dataRoot });
        await expect.poll(() => readUserFile(A, `worlds/${WORLD}.json`) !== null, { timeout: 60_000 }).toBe(true);
        await expect.poll(() => mainHas(A, `worlds/${WORLD}.json`), { timeout: 60_000, message: 'recovery advances main after applying live data' }).toBe(true);
    } finally {
        await ctxA.close();
        await ctxB.close();
    }
});
