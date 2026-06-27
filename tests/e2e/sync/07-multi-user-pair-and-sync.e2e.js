// Multi-user LAN Sync e2e — paired alice@A and alice@B with basic-auth
// across the wire.
//
// This is the load-bearing test that proves the multi-user workaround is
// dead. With `enableUserAccounts: true` the responder's /session/offer
// route demands a basic-auth header; the requester's
// /pair/accept route persists the offered peerAuth so subsequent Sync
// now calls don't need it supplied again. Both pieces have
// dedicated in-process tests; this e2e drives the full UI loop and
// confirms the pair, the live-data reconcile, and the stored-credential
// affordance all land on a real browser pair.
//
// Server-side bootstrap user is `default-user` (admin, no password) on
// both servers; both admins then create `alice` with the same password
// so the cross-handle gate never fires.

import { test, expect, request as pwRequest } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    acceptPairingLink,
    resolveAllConflictsAs,
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

/**
 * Bind an APIRequestContext to the bootstrap admin's session on a server
 * so we can call /api/users/create as the admin without driving the
 * admin-panel popup. Returns a `{ post, dispose }` shape matching the
 * persona helpers.
 */
async function bootstrapAdminSession(baseURL) {
    const ctx = await pwRequest.newContext({ baseURL });
    const csrfRes = await ctx.get('/csrf-token');
    expect(csrfRes.ok(), 'csrf-token request failed').toBe(true);
    const { token } = await csrfRes.json();
    const loginRes = await ctx.post('/api/users/login', {
        data: { handle: 'default-user', password: '' },
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    });
    expect(loginRes.ok(), `admin login failed (${loginRes.status()})`).toBe(true);
    return {
        async post(url, body) {
            return ctx.post(url, {
                data: body ?? {},
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            });
        },
        async dispose() { await ctx.dispose(); },
    };
}

test.beforeAll(async () => {
    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'multiuser-A',
        extraConfig: { enableUserAccounts: true },
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'multiuser-B',
        extraConfig: { enableUserAccounts: true },
    });

    for (const server of [A, B]) {
        const admin = await bootstrapAdminSession(server.baseURL);
        try {
            const createRes = await admin.post('/api/users/create', {
                handle: 'alice',
                name: 'Alice of Bryn',
                password: ALICE_PASSWORD,
                admin: false,
            });
            expect(createRes.ok(), `create alice failed on ${server.baseURL} (${createRes.status()})`).toBe(true);
        } finally {
            await admin.dispose();
        }
        markOnboarded({ dataRoot: server.dataRoot, handle: 'alice' });
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
    test('alice@A pairs with alice@B over basic-auth, seeded world lands on B, stored creds drive a follow-up Sync now', async ({ browser }) => {
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

        // B accepts WITH basic-auth credentials. Without this, A's
        // /session/offer 401s in multi-user mode (the multi-user shim only allows
        // a sync session when the caller passes valid Basic creds; it never
        // grants anonymous cross-handle access).
        await openLanSyncPanel(pageB);
        const acceptOutcome = await acceptPairingLink(pageB, link, {
            categories: ['worlds'],
            localLabel: 'A device',
            peerAuth: { username: 'alice', password: ALICE_PASSWORD },
        });

        // Same dual outcome as spec 01: if alice's seed worlds dirs on A
        // and B happen to share content (both got the same Eldoria seed
        // from default/content), attemptMerge's identical-trees path
        // gives 'success'; if any byte diverged it surfaces 'warning'
        // and we pick A's side.
        expect(['warning', 'success']).toContain(acceptOutcome);
        if (acceptOutcome === 'warning') {
            const resolved = await resolveAllConflictsAs(pageB, 'theirs');
            expect(resolved).toBe('success');
        }

        // The reconcile step writes A's seeded world into B's live data
        // UNDER ALICE'S HANDLE — not default-user. If the multi-user shim
        // had degenerated to "treat all callers as default-user", the
        // file would land in B's `default-user/worlds/` instead.
        const expectedPath = path.join(B.dataRoot, 'alice', 'worlds', `${SEED_WORLD}.json`);
        await expect.poll(
            () => fs.existsSync(expectedPath),
            { timeout: 10_000 },
        ).toBe(true);
        const onB = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
        expect(onB.name).toBe(SEED_WORLD);
        expect(onB.entries['0'].comment).toBe('multi-user-pair-marker');

        // Stored-credentials affordance: the peer row's "Clear
        // credentials" button only renders when /peers reported
        // hasStoredCredentials === true for this peer. The server side
        // is pinned by in-process tests; here we prove the UI consumed it.
        await pageB.locator('.lanSyncTabPeers').click();
        const peerRow = pageB.locator('.lanSyncPeerRow', { hasText: 'A device' });
        await expect(peerRow.locator('.lanSyncPeerClearAuthButton')).toBeVisible({ timeout: 5_000 });

        // Follow-up "Sync now" must succeed without re-prompting for
        // credentials — proves the stored peerAuth blob is consulted on
        // every /peers/:peerId/sync call. The outcome 'success' (or
        // 'warning' if the responder ever ships another byte under
        // alice/worlds after first pair; we accept both like spec 01).
        const syncAgain = await clickSyncNow(pageB, 'A device');
        expect(['success', 'warning']).toContain(syncAgain);
        if (syncAgain === 'warning') {
            const resolveAgain = await resolveAllConflictsAs(pageB, 'theirs');
            expect(resolveAgain).toBe('success');
        }

        await ctxA.close();
        await ctxB.close();
    });
});
