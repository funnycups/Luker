// #46 — Multi-user data isolation.
//
// Boot a server with enableUserAccounts=true (via env var, which getConfigValue
// honors via SILLYTAVERN_ENABLEUSERACCOUNTS). The bundled default user is the
// admin. Use the admin session to create users alice + bob (POST
// /api/users/create). Log in as alice, create character "AshA". Log out.
// Log in as bob, create character "AshB". Verify bob does not see AshA and
// alice does not see AshB. Restart and re-verify the isolation persists.

import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { awaitMainUI } from '../_lib/page.js';
import { write as embedCardData } from '../../../src/character-card-parser.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    // Spawn server with SILLYTAVERN_ENABLEUSERACCOUNTS=true. NB: getConfigValue
    // reads the env var via keyToEnv() which uppercases the config key:
    //   `enableUserAccounts` → `SILLYTAVERN_ENABLEUSERACCOUNTS`
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'multi-user',
        extraEnv: { SILLYTAVERN_ENABLEUSERACCOUNTS: 'true' },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

// Get a CSRF token and login in one request context. Returns { csrfToken,
// cookieHeader } for subsequent calls in the same browser context.
async function loginAs(page, handle, password) {
    return await page.evaluate(async ({ handle, password }) => {
        const csrfResp = await fetch('/csrf-token', { credentials: 'same-origin' });
        const { token } = await csrfResp.json();
        const loginResp = await fetch('/api/users/login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ handle, password }),
        });
        return { status: loginResp.status, body: (await loginResp.text()).slice(0, 400) };
    }, { handle, password });
}

async function createUserAsAdmin(page, { handle, name, password }) {
    return await page.evaluate(async ({ handle, name, password }) => {
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

test.describe('#46 — multi-user data isolation', () => {
    test('alice and bob characters do not cross-contaminate; isolation survives restart', async ({ browser }) => {
        // -- ADMIN BOOTSTRAP (in default-user context) --
        const adminCtx = await browser.newContext();
        const adminPage = await adminCtx.newPage();
        // Default user has no password by convention; the login page just
        // requires picking the handle. Go through the login flow to bind the
        // session.
        await adminPage.goto(`${server.baseURL}/login`);
        // Older flow: hit the public login API.
        const adminLogin = await loginAs(adminPage, 'default-user', '');
        expect(adminLogin.status, `admin login status (got ${adminLogin.status}, body=${adminLogin.body})`).toBe(200);

        // Create alice + bob.
        const createA = await createUserAsAdmin(adminPage, { handle: 'alice', name: 'Alice', password: 'alice-pw' });
        expect(createA.status, `create alice: ${createA.status} ${createA.body}`).toBe(200);
        const createB = await createUserAsAdmin(adminPage, { handle: 'bob', name: 'Bob', password: 'bob-pw' });
        expect(createB.status, `create bob: ${createB.status} ${createB.body}`).toBe(200);
        await adminCtx.close();

        // Sanity: directories exist on disk.
        expect(existsSync(resolve(server.dataRoot, 'alice'))).toBe(true);
        expect(existsSync(resolve(server.dataRoot, 'bob'))).toBe(true);

        // -- ALICE: create AshA on disk + verify via API --
        const aliceCtx = await browser.newContext();
        const alicePage = await aliceCtx.newPage();
        await alicePage.goto(`${server.baseURL}/login`);
        const aliceLogin = await loginAs(alicePage, 'alice', 'alice-pw');
        expect(aliceLogin.status, `alice login: ${aliceLogin.status} ${aliceLogin.body}`).toBe(200);

        // Write a character card directly to alice's character dir. (Programmatic
        // is sufficient — we are testing data isolation, not the upload UI.)
        // Server reads ONLY PNG-embedded chara/ccv3 chunks (sidecar JSON is
        // ignored), so we must stamp card data into the PNG itself.
        const aliceChar = resolve(server.dataRoot, 'alice', 'characters', 'AshA.png');
        // Seed from the bundled Seraphina PNG.
        const seedPng = resolve(server.dataRoot.replace(/\/[^/]+$/, ''), '..', '..', 'default', 'content', 'default_Seraphina.png');
        // The seed path varies by where the worktree is; just pick the first
        // existing PNG under data/default-user/characters as a fallback.
        const fallbackDir = resolve(server.dataRoot, 'default-user', 'characters');
        const fallbackList = existsSync(fallbackDir) ? readdirSync(fallbackDir).filter(f => f.endsWith('.png')) : [];
        const pngSource = existsSync(seedPng) ? seedPng : (fallbackList.length ? resolve(fallbackDir, fallbackList[0]) : null);
        expect(pngSource, 'no PNG available to seed AshA card').toBeTruthy();
        const ashACard = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'AshA',
            description: 'Alice-owned cartographer.',
            personality: 'isolated',
            scenario: 'alice scope',
            first_mes: 'Test.',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: [],
            creator: '',
            character_version: '1.0',
            extensions: {},
        };
        writeFileSync(aliceChar, embedCardData(readFileSync(pngSource), JSON.stringify(ashACard)));

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
        expect(aliceList).not.toContain('AshB');
        await aliceCtx.close();

        // -- BOB: create AshB; cannot see AshA --
        const bobCtx = await browser.newContext();
        const bobPage = await bobCtx.newPage();
        await bobPage.goto(`${server.baseURL}/login`);
        const bobLogin = await loginAs(bobPage, 'bob', 'bob-pw');
        expect(bobLogin.status, `bob login: ${bobLogin.status} ${bobLogin.body}`).toBe(200);

        const bobChar = resolve(server.dataRoot, 'bob', 'characters', 'AshB.png');
        const ashBCard = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'AshB',
            description: 'Bob-owned cartographer.',
            personality: 'isolated',
            scenario: 'bob scope',
            first_mes: 'Test.',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: [],
            creator: '',
            character_version: '1.0',
            extensions: {},
        };
        writeFileSync(bobChar, embedCardData(readFileSync(pngSource), JSON.stringify(ashBCard)));

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
        expect(bobList, `bob should not see alice's AshA; saw: ${bobList.join(',')}`).not.toContain('AshA');
        await bobCtx.close();

        // -- Restart + re-verify isolation --
        await server.restart();

        const alice2 = await browser.newContext();
        const alice2Page = await alice2.newPage();
        await alice2Page.goto(`${server.baseURL}/login`);
        await loginAs(alice2Page, 'alice', 'alice-pw');
        const aliceListAfter = await alice2Page.evaluate(async () => {
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
        expect(aliceListAfter).toContain('AshA');
        expect(aliceListAfter).not.toContain('AshB');
        await alice2.close();
    });
});
