// Cross-handle pairings must be refused, both by the
// frontend pre-flight (the UX guard) and by the server-side gate
// on /pair/accept (the safety boundary). Both paths must fire so a
// regression in either one is caught: dropping the UI check would let
// users get a confusing 412 with no explanation; dropping the server
// check would let a hand-crafted POST through.

import { test, expect } from '@playwright/test';

import { startServer, tearDownServer } from '../_lib/server.js';
import { createUserViaAdminUI } from '../_lib/page.js';
import {
    openLanSyncPanel,
    generatePairingLink,
    loginAs,
    expectHandleMismatchToast,
    fillPairingForm,
    accountWindow,
} from '../_lib/sync.js';

const ALICE_PASSWORD = 'alice-pass-8';
const BOB_PASSWORD = 'bob-pass-8';

let A, B;

/** Configure the actual account through its authenticated admin form. */
async function adminCreateUser(page, baseURL, { handle, name, password }) {
    await loginAs(page, baseURL, { handle: 'default-user', password: '' });
    await createUserViaAdminUI(page, { handle, name, password });
}

test.beforeAll(async () => {
    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'mismatch-A',
        extraConfig: { enableUserAccounts: true, 'sync.allowPrivateAddressesForUsers': true },
    });
    B = await startServer({
        batchKey: 'sync',
        scenarioId: 'mismatch-B',
        extraConfig: { enableUserAccounts: true, 'sync.allowPrivateAddressesForUsers': true },
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
        // Drive the "Connect to another device" form the same way the user
        // does: paste link, pick categories, click Pair and sync. The
        // pre-flight in the Account window surfaces the form error before
        // the pairing request — assert the error names both handles.
        await fillPairingForm(pageB, link, { categories: ['worlds'] });
        await accountWindow(pageB).locator('[data-act="pair-accept"]').click();
        await expectHandleMismatchToast(pageB, { expectedHandle: 'bob', gotHandle: 'alice' });

        // Verify the pair did NOT register on A's side. Use A's own
        // session (alice) to read /api/sync/v1/backends — bob's peerId
        // prefix must not appear.
        const backendsA = await pageA.evaluate(async () => {
            const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await csrfResp.json();
            const resp = await fetch('/api/sync/v1/backends', {
                method: 'GET',
                credentials: 'same-origin',
                headers: { 'X-CSRF-Token': token },
            });
            return resp.json();
        });
        const peerIds = Object.keys(backendsA.backends || {});
        expect(peerIds.every(id => !id.startsWith('bob@')),
            `A's peers should not include any bob@ prefix; got: ${peerIds.join(', ')}`).toBe(true);

        // Fault injection changes the real DOM-originated request after its
        // client preflight, so the independent server gate must reject it.
        await pageB.route('**/api/sync/v1/pair/accept', route => route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), remotePeerId: 'alice@deadbeefdeadbeef' }) }));
        const forged = new URL(link.replace('luker-sync://', 'http://'));
        forged.searchParams.set('peer', 'bob@deadbeefdeadbeef');
        await accountWindow(pageB).locator('[data-model="top.form.link"]').fill(`luker-sync://pair/v1?${forged.searchParams}`);
        const rejected = pageB.waitForResponse(response => new URL(response.url()).pathname === '/api/sync/v1/pair/accept');
        await accountWindow(pageB).locator('[data-act="pair-accept"]').click();
        const actual = await rejected;
        const bypass = { status: actual.status(), body: await actual.json() };

        expect(bypass.status).toBe(412);
        expect(bypass.body.code).toBe('HANDLE_MISMATCH');
        expect(bypass.body.expectedHandle).toBe('bob');
        expect(bypass.body.gotHandle).toBe('alice');

        await ctxA.close();
        await ctxB.close();
    });
});
