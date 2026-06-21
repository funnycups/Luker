// #105-ui — Sibling UI test for per-user isolation
//
// Companion to #105 (which is a server-side API integration test). This
// one drives two real BrowserContexts each logging in via the real
// /login form. After login, each user verifies their character list
// shows only their own character. Proves the user-visible UI surface
// honours the same scoping as the API contract that #105 locks.

import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { write as embedCardData } from '../../../src/character-card-parser.js';

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'personas',
        scenarioId: 'isolation-ui',
        extraConfig: { enableUserAccounts: true },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

/**
 * Real /login form login. Selects user card or fills handle, types
 * password, clicks Login button. Waits for the SPA to come up.
 *
 * Handles three cases:
 *  - GET /login auto-redirected to / because the single user has no
 *    password and tryAutoLogin promoted them (server-side
 *    singleUserLogin). We land directly on the main UI.
 *  - Normal login: the user list is populated; click the .userSelect
 *    card matching `handle` (rendered as a `<small class="userHandle">`
 *    inside the userSelect block — the markup has no data-handle attr).
 *  - Discreet login: #userList is hidden, #handleEntryBlock visible; fill
 *    the #userHandle input then submit.
 */
async function loginViaForm(page, baseURL, handle, password) {
    await page.goto(`${baseURL}/login`);
    // Wait until either we landed on the login page (userList / handle
    // block present) OR we got auto-redirected to /. Either is a valid
    // settled state.
    await page.waitForFunction(() => {
        // Auto-redirected to main UI.
        if (document.querySelector('#preloader') !== null) {
            // Still loading the main UI; let the standard wait-for-Luker
            // path below pick it up.
            return /\/(login)?$/.test(location.pathname) || location.pathname === '/';
        }
        const list = document.querySelector('#userList');
        const handleBlock = document.querySelector('#handleEntryBlock');
        // On login page when either userList has children OR handleBlock
        // is visible. Allow `/` URL as also-settled (auto-login redirect).
        if (location.pathname === '/' || location.pathname === '') return true;
        return list && (list.children.length > 0 || (handleBlock && handleBlock.style.display !== 'none'));
    }, { timeout: 30_000 });

    // If we're already on the main UI (auto-login), nothing else to do.
    const onMain = await page.evaluate(() => location.pathname === '/' || location.pathname === '');
    if (!onMain) {
        // Try to find the user card by the small.userHandle text. The
        // login markup is `<div class="userSelect"><div class="avatar">…</div>
        // <span class="userName">…</span><small class="userHandle">HANDLE</small></div>`.
        const card = page.locator('#userList .userSelect').filter({
            has: page.locator('.userHandle', { hasText: new RegExp(`^${escapeRegex(handle)}$`) }),
        }).first();
        const cardVisible = await card.isVisible({ timeout: 1500 }).catch(() => false);
        if (cardVisible) {
            await card.click();
        } else {
            const handleInput = page.locator('#userHandle');
            await handleInput.waitFor({ state: 'visible', timeout: 5000 });
            await handleInput.fill(handle);
        }

        // Password entry block appears after user selection when the user
        // has a password (or always in discreet mode).
        const passwordInput = page.locator('#userPassword');
        if (await passwordInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            await passwordInput.fill(password);
            const loginBtn = page.locator('#loginButton');
            if (await loginBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                await loginBtn.click();
            }
        }
        // For password-less users, onUserSelected → performLogin fires
        // automatically (no Login button click needed).
    }

    // Settle on main UI.
    await page.waitForFunction(() => document.getElementById('preloader') === null, { timeout: 60_000 });
    await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reload the SPA so its character list reflects what's on disk. Characters
 * are seeded after login, so the initial boot snapshot misses them. A real
 * user-level "press F5 because data on disk changed" is the only honest way
 * to re-hydrate; no backdoor that imports /script.js and pokes module
 * internals.
 */
async function refreshCharactersList(page, { timeoutMs = 30_000 } = {}) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('preloader') === null, { timeout: timeoutMs });
    await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: timeoutMs });
    await page.waitForFunction(() => {
        const ctx = window.Luker?.getContext?.();
        return Array.isArray(ctx?.characters) && ctx.characters.length > 0;
    }, { timeout: timeoutMs });
}

async function createUserAsAdmin(page, baseURL, { handle, name, password }) {
    await loginViaForm(page, baseURL, 'default-user', '');
    return page.evaluate(async ({ handle, name, password }) => {
        const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
        const { token } = await csrfResp.json();
        const resp = await fetch('/api/users/create', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Function': token, 'X-CSRF-Token': token },
            body: JSON.stringify({ handle, name, password, admin: false }),
        });
        return { status: resp.status, body: (await resp.text()).slice(0, 400) };
    }, { handle, name, password });
}

test.describe('#105-ui — UI sibling: two BrowserContexts log in via real form and see only their own data', () => {
    test('A and B in separate contexts; each sees only own character via ctx.characters', async ({ browser }) => {
        test.setTimeout(180_000);

        // Admin bootstrap.
        const adminCtx = await browser.newContext();
        const adminPage = await adminCtx.newPage();
        const a = await createUserAsAdmin(adminPage, server.baseURL, { handle: 'userone', name: 'User One', password: 'pwA' });
        expect(a.status, `create userone: ${a.status} ${a.body}`).toBe(200);
        const b = await createUserAsAdmin(adminPage, server.baseURL, { handle: 'usertwo', name: 'User Two', password: 'pwB' });
        expect(b.status, `create usertwo: ${b.status} ${b.body}`).toBe(200);
        await adminCtx.close();

        // Seed each user's character on disk so the UI lists them.
        const fallbackDir = resolve(server.dataRoot, 'default-user', 'characters');
        const fallbackList = existsSync(fallbackDir) ? readdirSync(fallbackDir).filter(f => f.endsWith('.png')) : [];
        const pngSource = fallbackList.length ? resolve(fallbackDir, fallbackList[0]) : null;
        expect(pngSource).toBeTruthy();
        const seedBytes = readFileSync(pngSource);

        const cardA = {
            spec: 'chara_card_v2', spec_version: '2.0',
            name: 'AshA', description: 'User One owned.', personality: '', scenario: 'one-scope',
            first_mes: '*AshA looks up.* "You came earlier than the wind."',
            mes_example: '', creator_notes: '', system_prompt: '',
            post_history_instructions: '', alternate_greetings: [], tags: [],
            creator: '', character_version: '1.0', extensions: {},
        };
        const cardB = { ...cardA, name: 'AshB', description: 'User Two owned.', scenario: 'two-scope' };
        // Ensure the characters/ subdir exists. The server's
        // checkForNewContent only creates it on demand when seeding
        // content; with forceCategories=['settings'] it skips characters,
        // so we make the dir ourselves before stamping the cards.
        const charsADir = resolve(server.dataRoot, 'userone', 'characters');
        const charsBDir = resolve(server.dataRoot, 'usertwo', 'characters');
        mkdirSync(charsADir, { recursive: true });
        mkdirSync(charsBDir, { recursive: true });
        writeFileSync(resolve(charsADir, 'AshA.png'), embedCardData(seedBytes, JSON.stringify(cardA)));
        writeFileSync(resolve(charsBDir, 'AshB.png'), embedCardData(seedBytes, JSON.stringify(cardB)));

        // ── Browser context A: log in via real form, verify list. ──
        const ctxA = await browser.newContext();
        const pageA = await ctxA.newPage();
        await loginViaForm(pageA, server.baseURL, 'userone', 'pwA');

        // The SPA's boot-time getCharacters() races with character file
        // creation: in this spec we wrote the user's character to disk
        // AFTER `createUserAsAdmin` and BEFORE the user logs in. By the
        // time the boot bootstrap snapshot lands, the file is on disk,
        // but at least sometimes the snapshot returns 0 characters
        // anyway (cache/race). Force a refresh so the test asserts on
        // a definitive list rather than the racy boot snapshot.
        await refreshCharactersList(pageA);
        const aNames = await pageA.evaluate(() => {
            const ctx = window.Luker.getContext();
            return (ctx.characters || []).map(c => c?.name).filter(Boolean).sort();
        });
        expect(aNames, `user A character list via ctx.characters`).toContain('AshA');
        expect(aNames, `user A should NOT see user B's character`).not.toContain('AshB');
        await ctxA.close();

        // ── Browser context B: log in via real form, verify isolation. ──
        const ctxB = await browser.newContext();
        const pageB = await ctxB.newPage();
        await loginViaForm(pageB, server.baseURL, 'usertwo', 'pwB');

        await refreshCharactersList(pageB);
        const bNames = await pageB.evaluate(() => {
            const ctx = window.Luker.getContext();
            return (ctx.characters || []).map(c => c?.name).filter(Boolean).sort();
        });
        expect(bNames).toContain('AshB');
        expect(bNames, `user B should NOT see user A's character`).not.toContain('AshA');
        await ctxB.close();
    });
});
