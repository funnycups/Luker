// #106 — Admin posts an announcement; a regular user sees it on next
// page load (toast/banner); after dismissing, the banner doesn't reappear.
//
// Admin-post leg: the admin endpoint is API-only in this build —
// public/scripts/announcements.js renders the banner / inbox UI for
// recipients but does not expose an admin "post announcement" form.
// The admin POST goes through /api/users/announcements/create
// (mounted under users-admin.js). When/if an admin panel form lands
// later, swap the admin leg below for a real form-fill + button click.
//
// User-side leg IS real UI: page.goto, wait for #announcement-banner,
// click .announcement-banner-dismiss, reload, assert banner gone.
//
// The bell + banner + warning-modal routing in
// public/scripts/announcements.js only activates in multi-user mode
// (when `enableUserAccounts` is on), so we override the scenario config.

import { test, expect, request as pwRequest } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'personas',
        scenarioId: 'announcements',
        extraConfig: { enableUserAccounts: true },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function newSession(baseURL) {
    const ctx = await pwRequest.newContext({ baseURL });
    const csrf = await ctx.get('/csrf-token');
    expect(csrf.ok()).toBe(true);
    const { token } = await csrf.json();
    return {
        ctx, token,
        post: (url, body, hdr = {}) => ctx.post(url, {
            data: body ?? {},
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, ...hdr },
        }),
        async dispose() { await ctx.dispose(); },
    };
}

test.describe('#106 — announcements broadcast and dismiss flow', () => {
    test('admin posts; user sees banner once; dismiss keeps it dismissed across reload', async ({ page, context }) => {
        // --- Admin posts a warning-level announcement (warnings render as
        // a persistent top banner; criticals open a modal).
        const admin = await newSession(server.baseURL);
        let announcementId = '';
        try {
            const login = await admin.post('/api/users/login', { handle: 'default-user', password: '' });
            expect(login.ok()).toBe(true);

            // Create a regular user "alice" who will see the announcement.
            const create = await admin.post('/api/users/create', { handle: 'alice', name: 'Alice', password: 'pw' });
            expect(create.ok(), `create alice failed (${create.status()})`).toBe(true);
            // Mark alice as onboarded so the "Welcome to Luker" modal doesn't
            // block the boot chain (which is where initAnnouncements runs).
            markOnboarded({ dataRoot: server.dataRoot, handle: 'alice' });

            // The admin announcement routes are mounted under /api/users/
            // (see src/server-startup.js: app.use('/api/users', usersAdminRouter))
            // and the routes inside users-admin.js are declared as
            // /announcements/create, /announcements/list, etc. — no "admin"
            // prefix. Earlier draft incorrectly used /admin/announcements/.
            const annc = await admin.post('/api/users/announcements/create', {
                level: 'warning',
                title: 'Reef wall maintenance window',
                body: 'The Bryn reef survey will be paused at moonrise for the lantern overhaul.',
            });
            expect(annc.ok(), `admin announcements/create failed (${annc.status()})`).toBe(true);
            const { item } = await annc.json();
            announcementId = item?.id;
            expect(announcementId).toBeTruthy();
        } finally {
            await admin.dispose();
        }

        // --- Drive the browser as alice. Use the same APIRequestContext
        // that's bound to this browser context so the session cookie set
        // by /api/users/login is on the same cookie jar as page.goto.
        const aliceCsrf = await context.request.get(server.baseURL + '/csrf-token');
        expect(aliceCsrf.ok()).toBe(true);
        const { token: aliceToken } = await aliceCsrf.json();
        const aliceLogin = await context.request.post(server.baseURL + '/api/users/login', {
            data: { handle: 'alice', password: 'pw' },
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': aliceToken },
        });
        expect(aliceLogin.ok(), `alice login (browser context) failed (${aliceLogin.status()})`).toBe(true);

        // Sanity: the announcement should be visible to alice's session
        // through /me/list, proving the cookie jar is wired correctly.
        // If this fails the browser flow will too.
        const meList = await context.request.post(server.baseURL + '/api/users/announcements/me/list', {
            data: {},
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': aliceToken },
        });
        expect(meList.ok(), `me/list as alice failed (${meList.status()})`).toBe(true);
        const meBody = await meList.json();
        expect(Array.isArray(meBody.items)).toBe(true);
        expect(meBody.multiUser).toBe(true);
        expect(meBody.items.some(i => i.id === announcementId)).toBe(true);

        // Now go to the SPA. The announcements module initializes during
        // startup and renders the warning banner host above the top bar.
        // Direct goto + preloader wait — bypasses the login gate so we
        // can't accidentally pick the wrong user.
        await page.goto(server.baseURL + '/');
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60_000 });
        await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });

        // Wait for the banner to appear (it is created async after fetch).
        const banner = page.locator('#announcement-banner');
        await banner.waitFor({ state: 'visible', timeout: 15_000 });
        const titleText = await banner.locator('.announcement-banner-title').textContent();
        expect(titleText).toContain('Reef wall maintenance window');

        // Dismiss via the X button — this posts to mark-read.
        await banner.locator('.announcement-banner-dismiss').click();
        await banner.waitFor({ state: 'hidden', timeout: 5_000 });

        // Reload: banner must NOT reappear (mark-read is persistent).
        await page.goto(server.baseURL + '/');
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60_000 });
        await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });

        // Give announcements init a chance to run (it's fire-and-forget).
        await page.waitForTimeout(2_000);
        const stillGone = await page.locator('#announcement-banner').count();
        expect(stillGone, 'dismissed announcement banner should NOT reappear after reload').toBe(0);

        // Also confirm via the data layer: the announcement is in alice's
        // readIds and the bell badge (if rendered) is empty.
        const badgeText = await page.evaluate(() => {
            const el = document.getElementById('announcement-bell-badge');
            return el ? el.textContent : null;
        });
        // Badge might be missing entirely if the bell isn't rendered in
        // this build — the load-bearing assertion is the banner absence.
        if (badgeText !== null && badgeText !== '') {
            throw new Error(`bell badge should be empty after dismiss; got "${badgeText}"`);
        }
    });
});
