// #107a — Login-page default avatar resolves to a real file.
//
// Background: getUserAvatar() falls back to PUBLIC_USER_AVATAR for
// every user without a custom avatar (no avatar:<handle> datum, no
// persona / user_avatar in settings). The constant pointed at
// /img/default-user.png, but the shipped file is public/img/user-default.png
// (user-default, not default-user) — the login page's /api/users/list
// served a URL that 404'd, so every avatarless user rendered a broken
// image.
//
// The seed data's default-user carries a persona avatar, so this file
// seeds a bare user (no settings.json, no avatar datum — exactly the
// state a fresh OAuth or admin-created user is in) and proves:
//   1. /api/users/list returns the fallback avatar URL for that user.
//   2. The URL actually resolves (200 + image content type) on the
//      live server.

import { test, expect, request as pwRequest } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCRATCH_ROOT = resolve(REPO_ROOT, 'tests/.e2e-scratch');

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'personas',
        scenarioId: 'default-avatar-url',
        extraConfig: { enableUserAccounts: true },
        useExistingDataRoot: await seedDataRoot(),
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

/**
 * Build a scratch dataRoot with one bare user: a user record (node-persist
 * datum, same storage layer the endpoints read) plus a settings.json that
 * has neither a default persona nor a user_avatar, and no avatar datum —
 * the avatarless state the fallback exists for. (A user with NO
 * settings.json gets one auto-seeded on boot, which sets user_avatar —
 * so the fallback state must be seeded explicitly.)
 */
async function seedDataRoot() {
    const dataRoot = resolve(SCRATCH_ROOT, 'personas-default-avatar-url');
    mkdirSync(resolve(dataRoot, '_storage'), { recursive: true });
    mkdirSync(resolve(dataRoot, 'bare-user'), { recursive: true });

    writeFileSync(
        resolve(dataRoot, '_storage', storageFile('user:bare-user')),
        JSON.stringify({
            key: 'user:bare-user',
            value: {
                handle: 'bare-user',
                name: 'Bare User',
                created: Date.now(),
                password: '',
                salt: '',
                admin: false,
                enabled: true,
            },
        }),
    );

    // Pre-existing settings with no persona / avatar fields: boot-time
    // content seeding leaves it alone, and getUserAvatar falls through
    // to PUBLIC_USER_AVATAR.
    writeFileSync(resolve(dataRoot, 'bare-user/settings.json'), JSON.stringify({ username: 'Bare User' }));

    return dataRoot;
}

/** node-persist stores datums at sha256(key) under _storage. */
function storageFile(key) {
    return createHash('sha256').update(key).digest('hex');
}

async function newSession() {
    const ctx = await pwRequest.newContext({ baseURL: server.baseURL });
    const csrfRes = await ctx.get('/csrf-token');
    expect(csrfRes.ok(), 'csrf-token request failed').toBe(true);
    const { token } = await csrfRes.json();
    return {
        ctx,
        async post(url, body) {
            return ctx.post(url, {
                data: body ?? {},
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            });
        },
        async dispose() { await ctx.dispose(); },
    };
}

test('avatarless user in /api/users/list serves a default avatar URL that resolves', async () => {
    const s = await newSession();
    try {
        const res = await s.post('/api/users/list');
        expect(res.ok(), `users list failed (${res.status()})`).toBe(true);
        const users = await res.json();
        const bareUser = users.find(u => u.handle === 'bare-user');
        expect(bareUser, 'bare-user missing from users list').toBeTruthy();

        // The fallback path is the regression target: it must point at
        // the file that actually ships in public/img.
        expect(bareUser.avatar, 'expected the avatarless-user fallback avatar path').toBe('/img/user-default.png');

        // The URL must resolve on the live server — the old constant
        // pointed at a nonexistent file (default-user.png) and 404'd.
        const avatarRes = await s.ctx.get('/img/user-default.png');
        expect(avatarRes.status(), '/img/user-default.png must resolve').toBe(200);
        const contentType = avatarRes.headers()['content-type'] || '';
        expect(contentType.startsWith('image/'), `expected image content-type, got "${contentType}"`).toBe(true);
    } finally {
        await s.dispose();
    }
});

test('the misspelled default-user.png does not exist in the repo', async () => {
    // Belt-and-suspenders: the shipped file must be user-default.png.
    expect(existsSync(resolve(REPO_ROOT, 'public/img/user-default.png')), 'public/img/user-default.png must exist').toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'public/img/default-user.png')), 'public/img/default-user.png must not exist').toBe(false);
});
