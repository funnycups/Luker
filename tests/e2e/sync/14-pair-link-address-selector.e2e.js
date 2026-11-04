// The generated pairing link must default to an address the other device
// can reach, not the loopback address the mobile app opens with. The test
// boots A with `listen: true` so the server actually exposes its interface
// addresses, then drives the address selector through the real UI.
//
// Per `feedback_e2e_real_user_flow`: one real `startServer` instance, a real
// Playwright browser, real DOM events on the selector. The link itself is
// rebuilt client-side, so no peer fetch is needed here — the pair-over-LAN
// path is covered by `01-pair-and-first-sync`.

import { test, expect } from '@playwright/test';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { openLanSyncPanel, generatePairingLink, pairingLinkField, accountWindow } from '../_lib/sync.js';

/** Warning the window shows while the selected address is loopback. */
const loopbackWarning = page => accountWindow(page).locator('.dw-banner.warning', { hasText: 'Only this device can reach this address' });

let A;

test.beforeAll(async () => {
    A = await startServer({
        batchKey: 'sync',
        scenarioId: 'pair-address',
        // `listen: true` binds the interfaces so the server can report LAN
        // addresses; `securityOverride` keeps the startup security check from
        // exiting the process on this test-only non-localhost bind.
        extraConfig: { listen: true, securityOverride: true },
    });
});

test.afterAll(async () => {
    await tearDownServer(A);
});

test.describe('LAN Sync — pairing link address selector', () => {
    test('defaults to an interface address and rebuilds the link on change', async ({ browser }) => {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await awaitMainUI(page, A.baseURL);

        await openLanSyncPanel(page);
        await generatePairingLink(page, { label: 'B device', categories: ['worlds'] });

        const select = accountWindow(page).locator('select[data-act-change="pair-addr"]');
        await select.waitFor({ state: 'visible' });
        const options = await select.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
        expect(options.length).toBeGreaterThan(0);

        // The loopback origin is always offered, labeled as this-device-only.
        const loopback = options.find(value => /127\.0\.0\.1|localhost/.test(value));
        expect(loopback, 'loopback option present').toBeTruthy();

        // The server binds its interfaces, so at least one LAN address is
        // detected and the default must not be the loopback one.
        await expect(select).not.toHaveValue(loopback);
        const selected = await select.inputValue();

        // The generated link embeds the selected address.
        const link = decodeURIComponent(await pairingLinkField(page).inputValue());
        expect(link).toContain(selected);

        // Selecting loopback rebuilds the link and surfaces the warning.
        await select.selectOption(loopback);
        await expect(loopbackWarning(page)).toBeVisible();
        const loopbackLink = decodeURIComponent(await pairingLinkField(page).inputValue());
        expect(loopbackLink).toContain(loopback);

        // Selecting a LAN address hides the warning again and rebuilds the link.
        const lan = options.find(value => value !== loopback);
        await select.selectOption(lan);
        await expect(loopbackWarning(page)).toBeHidden();
        const lanLink = decodeURIComponent(await pairingLinkField(page).inputValue());
        expect(lanLink).toContain(lan);

        await ctx.close();
    });
});
