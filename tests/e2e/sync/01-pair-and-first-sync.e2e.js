// Pair new device, B accepts, success after
// resolving the seed-data no-common-ancestor conflict.
//
// Per `feedback_e2e_real_user_flow`: two real `startServer` instances
// on distinct loopback ports / data dirs, a real Playwright browser
// driving each side, real toastr / popup gestures. No LLM calls in
// this flow, so nothing to mock.
//
// These specs run in default (single-user) mode. Multi-user pairings
// are exercised by separate specs in the same directory.

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
    listPeers,
} from '../_lib/sync.js';

let A, B;

test.beforeAll(async () => {
    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'pair-A',
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'pair-B',
    });
    markOnboarded({ dataRoot: A.dataRoot });
    markOnboarded({ dataRoot: B.dataRoot });

    // Seed A with a world (lorebook). JSON files in `worlds/` go through
    // a straight read/write path with no schema validation that would
    // reject arbitrary content, so we can place an obviously test-only
    // file here without tripping the character-loader's PNG validation.
    const aWorlds = path.join(A.dataRoot, 'default-user', 'worlds');
    fs.mkdirSync(aWorlds, { recursive: true });
    fs.writeFileSync(
        path.join(aWorlds, 'A-paired-this.json'),
        JSON.stringify({ entries: {}, name: 'A-paired-this' }),
    );
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — pair and first sync', () => {
    test('A generates link → B accepts → B receives A\'s seeded world', async ({ browser }) => {
        // Two contexts so each browser carries its own cookies; sharing
        // would let B's page accidentally inherit A's session.
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await awaitMainUI(pageA, A.baseURL);
        await awaitMainUI(pageB, B.baseURL);

        // A generates the pairing link. `label` is what A will call B
        // in A's own peer list (it's also embedded in the URL as a hint
        // for B's auto-fill, but B is expected to override it locally).
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, {
            label: 'B device',
            categories: ['worlds'],
        });
        // The link must embed A's actual base URL so B's server-side
        // /pair/accept knows where to call /session/offer.
        expect(link).toContain(encodeURIComponent(A.baseURL.replace(/\/$/, '')));

        // B accepts the link. `localLabel: 'A device'` overrides the
        // auto-populated value (the URL would have left "B device" in
        // the field, which is what A calls B — confusing on B's screen).
        await openLanSyncPanel(pageB);
        const acceptOutcome = await acceptPairingLink(pageB, link, {
            categories: ['worlds'],
            localLabel: 'A device',
        });

        // Two valid terminal states:
        //   - 'warning' — conflicts (the seed `data/` ships worlds on
        //     both sides, no common ancestor, so every worlds file
        //     surfaces as a conflict per `attemptMerge`'s
        //     MergeNotSupportedError fallback).
        //   - 'success' — clean sync (would happen only if B's seed
        //     worlds dir was somehow empty; not the realistic case).
        expect(['warning', 'success']).toContain(acceptOutcome);

        if (acceptOutcome === 'warning') {
            // Pick A's version for every conflict — that's the "I want
            // what A has" user intent for a fresh pair.
            const finalOutcome = await resolveAllConflictsAs(pageB, 'theirs');
            expect(finalOutcome).toBe('success');
        }

        // The reconcile step at the end of runPull writes the resolved
        // tree to disk. Verify A's seeded file landed in B's live data.
        await expect.poll(
            () => fs.existsSync(path.join(B.dataRoot, 'default-user', 'worlds', 'A-paired-this.json')),
            { timeout: 10_000 },
        ).toBe(true);

        // The file's content matches what A wrote — proves reconcile
        // didn't truncate or scramble the bytes.
        const onB = JSON.parse(fs.readFileSync(
            path.join(B.dataRoot, 'default-user', 'worlds', 'A-paired-this.json'),
            'utf8',
        ));
        expect(onB.name).toBe('A-paired-this');

        // A is now registered in B's peer list under the label we
        // explicitly set via localLabel.
        const peers = await listPeers(pageB);
        expect(peers.some(p => p.label === 'A device')).toBe(true);

        await ctxA.close();
        await ctxB.close();
    });
});
