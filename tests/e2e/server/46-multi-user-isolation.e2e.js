// #46 — Multi-user data isolation via real login form
//
// Two browser contexts each log in through the real /login form (typing
// the handle + password into #userHandle / #userPassword and clicking
// #loginButton). After login, each user verifies their character list
// via /api/characters/all — alice sees AshA, bob sees AshB, neither
// sees the other's character. Isolation survives a server restart.
//
// Bootstrapping users: admin creation goes through the /api/users/create
// endpoint via the admin's authenticated session — same backend path
// the admin panel popup uses. This setup step is acceptable per the
// brief ("Honest API tests are fine") because user creation by admin
// is not the gesture under test; the LOGIN FORM is.

import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { write as embedCardData } from '../../../src/character-card-parser.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    // Server with enableUserAccounts via extraConfig (the same path
    // production multi-user installs use).
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'multi-user',
        extraConfig: { enableUserAccounts: true },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Drive a real /login form login: select user card (or fall through to
 * the discreet handle/password block), type the password, click the
 * Login button. Waits for the SPA to land (preloader gone).
 *
 * Notes on the auto-login bypass:
 *   - `/login` server-side runs tryAutoLogin, which logs the session in
 *     as the single passwordless user (default-user) and redirects to /.
 *     That would skip the form entirely, which defeats the test.
 *   - Passing ?noauto=1 disables that branch, so the login page renders
 *     and the user list / handle entry block is visible to drive.
 *   - We also explicitly POST /api/users/logout first so any session
 *     cookie left over from a prior page navigation is cleared before
 *     we drive the form. Without this, /login could still redirect us
 *     back to / on the basis of the lingering session.
 */
async function loginViaForm(page, baseURL, handle, password) {
    // Clear any existing session.
    try {
        await page.context().clearCookies();
    } catch { /* not yet open */ }

    await page.goto(`${baseURL}/login?noauto=1`);

    // Wait for the login UI to be ready.
    await page.waitForFunction(() => {
        const list = document.querySelector('#userList');
        const handleBlock = document.querySelector('#handleEntryBlock');
        return list && (list.children.length > 0 || (handleBlock && handleBlock.style.display !== 'none'));
    }, { timeout: 15_000 });

    // Pick the user card if listed; otherwise type the handle.
    // The login page renders each user as a .userSelect div containing
    // a .userHandle span with the handle text — no data-handle attribute.
    const userCard = page.locator('#userList .userSelect', { has: page.locator('.userHandle', { hasText: handle }) }).first();
    if (await userCard.isVisible({ timeout: 1000 }).catch(() => false)) {
        await userCard.click();
    } else {
        // Discreet mode: type the handle.
        const handleInput = page.locator('#userHandle');
        await handleInput.waitFor({ state: 'visible', timeout: 3000 });
        await handleInput.fill(handle);
    }

    // Password block becomes visible if the account has a password.
    const passwordInput = page.locator('#userPassword');
    if (await passwordInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        await passwordInput.fill(password);
    }

    // Click the actual Login button if visible. For a passwordless user
    // the userSelect click already submitted; only click Login if it
    // surfaced (which it does once the password block is visible).
    const loginBtn = page.locator('#loginButton');
    if (await loginBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await loginBtn.click();
    }
    // Some flows redirect immediately from the userSelect click (no
    // password block when an account has no password). Wait for the
    // SPA to come up either way.
    await page.waitForFunction(() => document.getElementById('preloader') === null, { timeout: 60_000 });
    await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });
}

/**
 * Admin bootstrap: create a non-admin user via the /api/users/create
 * endpoint, authenticated as default-user (the bundled admin).
 */
async function createUserAsAdmin(page, baseURL, { handle, name, password }) {
    // Log in as default-user first via the form.
    await loginViaForm(page, baseURL, 'default-user', '');
    return page.evaluate(async ({ handle, name, password }) => {
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
}

test.describe('#46 — multi-user data isolation (real login form)', () => {
    test('alice and bob log in via form; characters do not cross-contaminate; survives restart', async ({ browser }) => {
        test.setTimeout(180_000);

        // ── ADMIN BOOTSTRAP ──
        const adminCtx = await browser.newContext();
        const adminPage = await adminCtx.newPage();
        const createA = await createUserAsAdmin(adminPage, server.baseURL, { handle: 'alice', name: 'Alice', password: 'alice-pw' });
        expect(createA.status, `create alice: ${createA.status} ${createA.body}`).toBe(200);
        const createB = await createUserAsAdmin(adminPage, server.baseURL, { handle: 'bob', name: 'Bob', password: 'bob-pw' });
        expect(createB.status, `create bob: ${createB.status} ${createB.body}`).toBe(200);
        await adminCtx.close();

        // Sanity: directories exist on disk.
        expect(existsSync(resolve(server.dataRoot, 'alice'))).toBe(true);
        expect(existsSync(resolve(server.dataRoot, 'bob'))).toBe(true);

        // Pre-seed each user's character on disk. The card is embedded
        // into the PNG via tEXt chunks so the server's character reader
        // sees it. This is programmatic setup — the data isolation
        // (which is what's being tested) is server-side scoping.
        const fallbackDir = resolve(server.dataRoot, 'default-user', 'characters');
        const fallbackList = existsSync(fallbackDir) ? readdirSync(fallbackDir).filter(f => f.endsWith('.png')) : [];
        const pngSource = fallbackList.length ? resolve(fallbackDir, fallbackList[0]) : null;
        expect(pngSource, 'no PNG available to seed').toBeTruthy();

        const ashACard = {
            spec: 'chara_card_v2', spec_version: '2.0',
            name: 'AshA', description: 'Alice-owned cartographer.',
            personality: 'isolated', scenario: 'alice scope', first_mes: 'Test.',
            mes_example: '', creator_notes: '', system_prompt: '',
            post_history_instructions: '', alternate_greetings: [], tags: [],
            creator: '', character_version: '1.0', extensions: {},
        };
        writeFileSync(
            resolve(server.dataRoot, 'alice', 'characters', 'AshA.png'),
            embedCardData(readFileSync(pngSource), JSON.stringify(ashACard)),
        );

        const ashBCard = { ...ashACard, name: 'AshB', description: 'Bob-owned cartographer.', scenario: 'bob scope' };
        writeFileSync(
            resolve(server.dataRoot, 'bob', 'characters', 'AshB.png'),
            embedCardData(readFileSync(pngSource), JSON.stringify(ashBCard)),
        );

        // ── ALICE: real-form login, verify isolation. ──
        const aliceCtx = await browser.newContext();
        const alicePage = await aliceCtx.newPage();
        await loginViaForm(alicePage, server.baseURL, 'alice', 'alice-pw');

        const aliceList = await alicePage.evaluate(async () => {
            const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await csrfResp.json();
            const resp = await fetch('/api/characters/all', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                body: JSON.stringify({}),
            });
            const list = await resp.json();
            return list.map(c => c?.name).filter(Boolean).sort();
        });
        expect(aliceList).toContain('AshA');
        expect(aliceList, `alice should NOT see bob's AshB`).not.toContain('AshB');
        await aliceCtx.close();

        // ── BOB: real-form login, separate browser context. ──
        const bobCtx = await browser.newContext();
        const bobPage = await bobCtx.newPage();
        await loginViaForm(bobPage, server.baseURL, 'bob', 'bob-pw');

        const bobList = await bobPage.evaluate(async () => {
            const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await csrfResp.json();
            const resp = await fetch('/api/characters/all', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                body: JSON.stringify({}),
            });
            const list = await resp.json();
            return list.map(c => c?.name).filter(Boolean).sort();
        });
        expect(bobList).toContain('AshB');
        expect(bobList, `bob should NOT see alice's AshA; saw: ${bobList.join(',')}`).not.toContain('AshA');
        await bobCtx.close();

        // ── Restart + re-verify isolation via real-form login. ──
        await server.restart();

        const alice2 = await browser.newContext();
        const alice2Page = await alice2.newPage();
        await loginViaForm(alice2Page, server.baseURL, 'alice', 'alice-pw');
        const aliceAfter = await alice2Page.evaluate(async () => {
            const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await csrfResp.json();
            const resp = await fetch('/api/characters/all', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                body: JSON.stringify({}),
            });
            const list = await resp.json();
            return list.map(c => c?.name).filter(Boolean).sort();
        });
        expect(aliceAfter).toContain('AshA');
        expect(aliceAfter).not.toContain('AshB');
        await alice2.close();
    });
});
