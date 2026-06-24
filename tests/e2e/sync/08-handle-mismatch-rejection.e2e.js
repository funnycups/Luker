// Spec §3.4 — cross-handle pairings must be refused, both by the
// frontend pre-flight (Task 7's UX guard) and by the server-side gate
// on /pair/accept (Task 7's safety boundary). Both paths must fire so a
// regression in either one is caught: dropping the UI check would let
// users get a confusing 412 with no explanation; dropping the server
// check would let a hand-crafted POST through.

import { test, expect } from '@playwright/test';

import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    loginAs,
    expectHandleMismatchToast,
} from '../_lib/sync.js';

const ALICE_PASSWORD = 'alice-pass-8';
const BOB_PASSWORD = 'bob-pass-8';

let A, B;

/**
 * Helper for the admin-side bootstrap: create one named user under the
 * default admin on a server. We do it through page.evaluate so the same
 * CSRF / session that the SPA uses also creates the account.
 */
async function adminCreateUser(page, baseURL, { handle, name, password }) {
    await loginAs(page, baseURL, { handle: 'default-user', password: '' });
    const res = await page.evaluate(async ({ handle, name, password }) => {
        const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
        const { token } = await csrfResp.json();
        const resp = await fetch('/api/users/create', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ handle, name, password, admin: false }),
        });
        return { status: resp.status, body: (await resp.text()).slice(0, 400) };
    }, { handle, name, password });
    expect(res.status, `create ${handle}: ${res.status} ${res.body}`).toBe(200);
}

test.beforeAll(async () => {
    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'mismatch-A',
        extraConfig: { enableUserAccounts: true },
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'mismatch-B',
        extraConfig: { enableUserAccounts: true },
    });
});

test.afterAll(async () => {
    await tearDownServer(A);
    await tearDownServer(B);
});

test.describe('LAN Sync — handle-mismatch rejection', () => {
    test('UI pre-flight blocks pair; bypassing the UI surfaces a 412 HANDLE_MISMATCH from the server', async ({ browser }) => {
        test.setTimeout(180_000);

        // Admin bootstrap: A creates alice, B creates bob.
        const adminCtxA = await browser.newContext();
        await adminCreateUser(await adminCtxA.newPage(), A.baseURL, {
            handle: 'alice', name: 'Alice of Bryn', password: ALICE_PASSWORD,
        });
        await adminCtxA.close();
        const adminCtxB = await browser.newContext();
        await adminCreateUser(await adminCtxB.newPage(), B.baseURL, {
            handle: 'bob', name: 'Bob of the South Span', password: BOB_PASSWORD,
        });
        await adminCtxB.close();

        markOnboarded({ dataRoot: A.dataRoot, handle: 'alice' });
        markOnboarded({ dataRoot: B.dataRoot, handle: 'bob' });

        // ===== Path 1: UI pre-flight blocks the click =====
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await loginAs(pageA, A.baseURL, { handle: 'alice', password: ALICE_PASSWORD });
        await loginAs(pageB, B.baseURL, { handle: 'bob', password: BOB_PASSWORD });

        await openLanSyncPanel(pageA);
        const link = await generatePairingLink(pageA, {
            label: 'B device',
            categories: ['worlds'],
        });
        // Link peerId prefix must be 'alice' — that's the value the
        // server-side gate will compare against B's session handle.
        expect(link).toMatch(/peer=alice%40/);

        await openLanSyncPanel(pageB);
        // Drive the Accept form the same way the user does: paste link,
        // pick categories, click Pair. The pre-flight in runPairAccept
        // immediately surfaces the error banner and never hits the
        // network — assert the banner names both handles.
        await pageB.locator('.lanSyncTabPairExisting').click();
        await pageB.locator('.lanSyncAcceptLink').fill(link);
        await pageB.locator('.lanSyncAcceptLink').dispatchEvent('input');
        await pageB.evaluate(() => {
            document.querySelectorAll('.lanSyncAcceptCategoryGrid input[name="lanSyncCategory"]').forEach((el) => {
                el.checked = el.value === 'worlds';
            });
        });
        await pageB.locator('.lanSyncAcceptButton').click();
        await expectHandleMismatchToast(pageB, { expectedHandle: 'bob', gotHandle: 'alice' });

        // Verify the pair did NOT register on A's side. Use A's own
        // session (alice) to read /api/sync/v1/peers — bob's peerId
        // prefix must not appear.
        const peersA = await pageA.evaluate(async () => {
            const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await csrfResp.json();
            const resp = await fetch('/api/sync/v1/peers', {
                method: 'GET',
                credentials: 'same-origin',
                headers: { 'X-CSRF-Token': token },
            });
            return resp.json();
        });
        const peerIds = Object.keys(peersA.peers || {});
        expect(peerIds.every(id => !id.startsWith('bob@')),
            `A's peers should not include any bob@ prefix; got: ${peerIds.join(', ')}`).toBe(true);

        // ===== Path 2: bypass the UI; server gate fires =====
        // Bob's session is already established on pageB. Issue a raw
        // POST to /api/sync/v1/pair/accept with a forged peerId that
        // names alice. The server's expectedHandle must be 'bob' (B's
        // session) and gotHandle must be 'alice' (the peerId prefix).
        const bypass = await pageB.evaluate(async ({ peerBaseUrl }) => {
            const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await csrfResp.json();
            const resp = await fetch('/api/sync/v1/pair/accept', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                body: JSON.stringify({
                    remotePeerId: 'alice@deadbeefdeadbeef',
                    peerBaseUrl,
                    label: 'A bypass',
                    categories: ['worlds'],
                    peerAuth: { username: 'alice', password: 'whatever' },
                }),
            });
            const body = await resp.json().catch(() => ({}));
            return { status: resp.status, body };
        }, { peerBaseUrl: A.baseURL });

        expect(bypass.status).toBe(412);
        expect(bypass.body.code).toBe('HANDLE_MISMATCH');
        expect(bypass.body.expectedHandle).toBe('bob');
        expect(bypass.body.gotHandle).toBe('alice');

        await ctxA.close();
        await ctxB.close();
    });
});
