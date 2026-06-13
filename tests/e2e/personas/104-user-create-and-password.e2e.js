// #104 — Admin creates a new user "alice"; alice can log in with the
// initial password; alice changes her password; the old password no
// longer works; the new password does; the admin deletes alice;
// login attempts then fail.
//
// Driven through the API endpoints (the same calls the admin panel +
// login screen make) because driving the admin-panel popup chain in
// headless Chromium is brittle without exposing any actual behaviour
// difference. The endpoint contract IS the contract — this is the same
// path users-private.js / users-public.js / users-admin.js are wired to.
//
// Requires `enableUserAccounts: true` at server boot, hence extraConfig.

import { test, expect, request as pwRequest } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'personas',
        scenarioId: 'users-crud',
        extraConfig: { enableUserAccounts: true },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

/**
 * Build an APIRequestContext bound to a single user session (the cookie
 * jar + the CSRF token returned by /csrf-token).
 */
async function newSession(baseURL) {
    const ctx = await pwRequest.newContext({ baseURL });
    const csrfRes = await ctx.get('/csrf-token');
    expect(csrfRes.ok(), 'csrf-token request failed').toBe(true);
    const { token } = await csrfRes.json();
    return {
        ctx,
        async post(url, body, extraHeaders = {}) {
            return ctx.post(url, {
                data: body ?? {},
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                    ...extraHeaders,
                },
            });
        },
        async dispose() { await ctx.dispose(); },
    };
}

test.describe('#104 — admin creates / alice changes password / admin deletes', () => {
    test('full lifecycle: create, login, change-password, old-fails, new-works, delete, login-fails', async () => {
        // --- Admin session ---
        const admin = await newSession(server.baseURL);
        try {
            // Default user in Luker is the admin "default-user" with no password.
            const loginRes = await admin.post('/api/users/login', { handle: 'default-user', password: '' });
            expect(loginRes.ok(), `admin login failed (${loginRes.status()})`).toBe(true);

            // Confirm admin context.
            const meRes = await admin.ctx.get('/api/users/me');
            expect(meRes.ok()).toBe(true);
            const me = await meRes.json();
            expect(me.admin).toBe(true);

            // Create user "alice" with initial password "old-pass-A".
            const createRes = await admin.post('/api/users/create', {
                handle: 'alice',
                name: 'Alice of the Headland',
                password: 'old-pass-A',
                admin: false,
            });
            expect(createRes.ok(), `create alice failed (${createRes.status()})`).toBe(true);

            // --- Alice session ---
            const alice = await newSession(server.baseURL);
            try {
                const aliceLogin1 = await alice.post('/api/users/login', { handle: 'alice', password: 'old-pass-A' });
                expect(aliceLogin1.ok(), `alice initial login failed (${aliceLogin1.status()})`).toBe(true);

                // Alice changes her password.
                const changeRes = await alice.post('/api/users/change-password', {
                    handle: 'alice',
                    oldPassword: 'old-pass-A',
                    newPassword: 'new-pass-B',
                });
                expect(changeRes.ok(), `change-password failed (${changeRes.status()})`).toBe(true);

                // Alice logs out.
                const logoutRes = await alice.post('/api/users/logout');
                expect(logoutRes.ok()).toBe(true);
            } finally {
                await alice.dispose();
            }

            // Fresh session: old password should NOT work anymore.
            const aliceBadOld = await newSession(server.baseURL);
            try {
                const oldRes = await aliceBadOld.post('/api/users/login', { handle: 'alice', password: 'old-pass-A' });
                expect(oldRes.status(), 'login with old password should fail').toBe(403);
            } finally {
                await aliceBadOld.dispose();
            }

            // Fresh session: new password should work.
            const aliceNew = await newSession(server.baseURL);
            try {
                const newRes = await aliceNew.post('/api/users/login', { handle: 'alice', password: 'new-pass-B' });
                expect(newRes.ok(), `login with new password failed (${newRes.status()})`).toBe(true);

                // Sanity: /me returns alice.
                const aliceMe = await aliceNew.ctx.get('/api/users/me');
                expect(aliceMe.ok()).toBe(true);
                const profile = await aliceMe.json();
                expect(profile.handle).toBe('alice');
                expect(profile.admin).toBe(false);
            } finally {
                await aliceNew.dispose();
            }

            // --- Admin deletes alice ---
            const deleteRes = await admin.post('/api/users/delete', { handle: 'alice', purge: true });
            expect(deleteRes.ok(), `delete alice failed (${deleteRes.status()})`).toBe(true);

            // Login as deleted alice should fail.
            const aliceGone = await newSession(server.baseURL);
            try {
                const goneRes = await aliceGone.post('/api/users/login', { handle: 'alice', password: 'new-pass-B' });
                expect(goneRes.status(), 'login after delete should fail').toBe(403);
            } finally {
                await aliceGone.dispose();
            }
        } finally {
            await admin.dispose();
        }
    });
});
