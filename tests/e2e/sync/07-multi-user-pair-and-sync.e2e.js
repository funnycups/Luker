// Multi-user LAN Sync e2e — paired alice@A and alice@B without any
// basic-auth credentials.
//
// This is the load-bearing test that proves the multi-user flow works.
// With `enableUserAccounts: true` a cross-server `/session/offer` has no
// session cookie; previously it demanded basic-auth credentials that
// ordinary multi-user accounts never had. The pairing link now carries a
// one-time pairing code; the first offer consumes it and returns a
// durable peer secret that both sides store, so the pair and every later
// "Sync now" authenticate without the user typing anything.
//
// Server-side bootstrap user is `default-user` (admin, no password) on
// both servers; both admins then create `alice` with the same password
// so the cross-handle gate never fires.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { createUserViaAdminUI } from '../_lib/page.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    clickSyncNow,
    loginAs,
} from '../_lib/sync.js';

const ALICE_PASSWORD = 'alice-pass-7';
const SEED_WORLD = 'multi-user-seeded';
const SEED_WORLD_BODY = {
    name: SEED_WORLD,
    entries: {
        '0': {
            uid: 0,
            key: ['multi user seed'],
            keysecondary: [],
            comment: 'multi-user-pair-marker',
            content: 'This world was seeded on A by alice. After the pair lands, alice on B should see it under her own handle.',
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

let A, B;

test.beforeAll(async ({ browser }) => {
    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'multiuser-A',
        extraConfig: { enableUserAccounts: true, 'sync.allowPrivateAddressesForUsers': true },
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'multiuser-B',
        extraConfig: { enableUserAccounts: true, 'sync.allowPrivateAddressesForUsers': true },
    });

    for (const server of [A, B]) {
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            await loginAs(page, server.baseURL, { handle: 'default-user', password: '' });
            await createUserViaAdminUI(page, { handle: 'alice', name: 'Alice of Bryn', password: ALICE_PASSWORD });
        } finally {
            await context.close();
        }
    }

    // Seed A's alice with a distinctive world so we can assert it lands
    // verbatim on B after the sync.
    const aliceWorldsA = path.join(A.dataRoot, 'alice', 'worlds');
    fs.mkdirSync(aliceWorldsA, { recursive: true });
    fs.writeFileSync(
        path.join(aliceWorldsA, `${SEED_WORLD}.json`),
        JSON.stringify(SEED_WORLD_BODY, null, 2),
    );
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — multi-user pair and sync', () => {
    test('alice@A pairs with alice@B without credentials, seeded world lands on B, follow-up Sync now reuses the stored secret', async ({ browser }) => {
        test.setTimeout(180_000);

        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await loginAs(pageA, A.baseURL, { handle: 'alice', password: ALICE_PASSWORD });
        await loginAs(pageB, B.baseURL, { handle: 'alice', password: ALICE_PASSWORD });

        // A generates the link. peerId prefix will be 'alice' because the
        // session belongs to alice — that's the contract the
        // gate checks against.
        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, {
            label: 'B device',
            categories: ['worlds'],
        });
        expect(link).toMatch(/^luker-sync:.*peer=alice%40/);
        // The link carries the one-time pairing code, not a durable
        // credential.
        expect(link).toMatch(/[?&]code=[a-f0-9]{64}/);

        // B accepts with NO credentials. The one-time code authenticates
        // the outbound offer on this multi-user install where alice has
        // no basic-auth password to type.
        await openLanSyncPanel(pageB);
        const acceptOutcome = await acceptPairingLink(pageB, link, {
            categories: ['worlds'],
            localLabel: 'A device',
        });

        // Alice's worlds on A and B come from the same default content, so
        // they match byte for byte and the first sync merges cleanly.
        expect(acceptOutcome).toBe('success');

        // The sync writes A's seeded world into B's live data
        // UNDER ALICE'S HANDLE — not default-user. If the multi-user
        // resolution had degenerated to "treat all callers as
        // default-user", the file would land in B's `default-user/worlds/`
        // instead.
        const expectedPath = path.join(B.dataRoot, 'alice', 'worlds', `${SEED_WORLD}.json`);
        await expect.poll(
            () => fs.existsSync(expectedPath),
            { timeout: 10_000 },
        ).toBe(true);
        const onB = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
        expect(onB.name).toBe(SEED_WORLD);
        expect(onB.entries['0'].comment).toBe('multi-user-pair-marker');

        // No basic-auth credentials were stored (none were supplied), but
        // the durable pairing secret is on B's peer entry.
        const bState = JSON.parse(fs.readFileSync(path.join(B.dataRoot, 'alice', '.sync', 'state.json'), 'utf8'));
        const peerEntry = Object.values(bState.backends).find(p => p.label === 'A device');
        expect(peerEntry).toBeTruthy();
        expect(peerEntry.lan.syncSecret).toMatch(/^[a-f0-9]{64}$/);
        expect(peerEntry.lan.peerAuth).toBeNull();

        // Follow-up "Sync now" must succeed without any credential
        // prompt: with no basic-auth credentials stored, the secret alone
        // authenticates the offer and the push.
        const syncAgain = await clickSyncNow(pageB, 'A device');
        expect(syncAgain).toBe('success');

        await ctxA.close();
        await ctxB.close();
    });
});
