// A responder that fails to write the merged tree into its live data
// must fail the push loudly, not report success.
//
// Regression: /session/ref used to swallow the reconcile error and still
// return 200, leaving the responder's shadow ahead of its live tree. Every
// later sync then saw matching HEADs and no-oped, so both sides reported
// "Synced" while the responder silently stayed stale.
//
// Forces the failure by making A's worlds directory read-only, then has B
// push a new world. Asserts B sees an error banner + toast + structured
// console line, A's ref is rolled back, and A's live tree never claims the
// pushed file.

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
    clickSyncNow,
} from '../_lib/sync.js';

let A, B;

const userRoot = (server) => path.join(server.dataRoot, 'default-user');
const worldsDir = (server) => path.join(userRoot(server), 'worlds');
const shadowRefPath = (server, peerId) => path.join(
    userRoot(server), '.sync', peerId, 'repo.git', 'refs', 'heads', 'main',
);

function readPeerId(server) {
    const statePath = path.join(userRoot(server), '.sync', 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return Object.keys(state.peers)[0];
}

function seedWorld(server, name, side) {
    fs.mkdirSync(worldsDir(server), { recursive: true });
    fs.writeFileSync(
        path.join(worldsDir(server), `${name}.json`),
        JSON.stringify({ name, side }),
    );
}

test.beforeAll(async () => {
    A = await startServer({ batchKey: 'sync', scenarioId: 'reconcile-fail-A' });
    B = await startServer({ batchKey: 'sync', scenarioId: 'reconcile-fail-B' });
    markOnboarded({ dataRoot: A.dataRoot });
    markOnboarded({ dataRoot: B.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — responder reconcile failure', () => {
    test('a failed responder write surfaces an error and rolls back the ref', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        const consoleLines = [];
        pageB.on('console', (msg) => {
            if (msg.type() === 'error') consoleLines.push(msg.text());
        });

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // Identical seeds on both sides give a deterministic first pair:
        // no common ancestor but identical trees, so the merge is clean and
        // both ends settle on the same HEAD.
        seedWorld(A, 'seed-world', 'both');
        seedWorld(B, 'seed-world', 'both');

        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, { label: 'B device', categories: ['worlds'] });
        await openLanSyncPanel(pageB);
        const acceptOutcome = await acceptPairingLink(pageB, link, {
            categories: ['worlds'],
            localLabel: 'A device',
        });
        expect(acceptOutcome).toBe('success');

        const peerId = readPeerId(A);
        const refPath = shadowRefPath(A, peerId);
        const refBefore = fs.readFileSync(refPath, 'utf8').trim();

        // Make A's live worlds directory read-only so the responder
        // reconcile cannot create the file B is about to push.
        fs.chmodSync(worldsDir(A), 0o500);

        try {
            seedWorld(B, 'B-new-world', 'B');

            const syncOutcome = await clickSyncNow(pageB, 'A device');
            expect(syncOutcome).toBe('error');

            // The failure is visible: error banner, an error toast, and a
            // structured console line that lands in the debug-log export.
            await expect(pageB.locator('.lanSyncStatusBanner')).toHaveClass(/error/);
            await expect(pageB.locator('.toast-error')).toBeVisible({ timeout: 5_000 });
            expect(consoleLines.some((line) => line.includes('[lan-sync] pull failed'))).toBe(true);
            // The raw server error, not just the friendly message, is in the
            // log, so a debug-log export names the real cause.
            expect(consoleLines.some((line) => line.includes('EACCES') || line.includes('permission denied'))).toBe(true);

            // A's ref was rolled back, so a later sync retries the
            // reconcile instead of seeing matching HEADs and no-oping.
            const refAfter = fs.readFileSync(refPath, 'utf8').trim();
            expect(refAfter).toBe(refBefore);

            // A's live tree never received B's pushed file.
            expect(fs.existsSync(path.join(worldsDir(A), 'B-new-world.json'))).toBe(false);
        } finally {
            fs.chmodSync(worldsDir(A), 0o700);
        }

        await ctxA.close();
        await ctxB.close();
    });
});
