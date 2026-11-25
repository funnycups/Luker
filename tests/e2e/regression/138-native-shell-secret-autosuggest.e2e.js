import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { markOnboarded } from '../_lib/fixtures.js';

let fileScope;

test.beforeAll(async ({ workerResources }, testInfo) => {
    fileScope = await workerResources.scenario(testInfo.file);
});

// The saved-key autosuggest hangs a <datalist> off every API key input, one
// <option> per saved key, whose value is the secret's opaque uuid. Both native
// app shells surface that datalist as a full-screen list of uuids over the
// input, so neither shell may receive the datalist. Mobile web browsers keep it.

const SECRET_ID = 'c27acabf-e34d-4096-96a8-b422f90ba499';
const ANDROID_MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

let server;

test.beforeAll(async () => {
    server = await startServer({ scope: fileScope, batchKey: 'regression', scenarioId: 'native-shell-secret-autosuggest' });
    markOnboarded({ dataRoot: server.dataRoot });
    seedOpenAiKey(server.dataRoot);
});

function seedOpenAiKey(dataRoot) {
    const secretsPath = resolve(dataRoot, 'default-user', 'secrets.json');
    let secrets = {};
    try { secrets = JSON.parse(readFileSync(secretsPath, 'utf8')); } catch { /* first seed */ }
    secrets['api_key_openai'] = [{ id: SECRET_ID, value: 'sk-e2e-autosuggest', label: 'e2e-autosuggest', active: true }];
    writeFileSync(secretsPath, JSON.stringify(secrets, null, 4));
}

async function openApp(page) {
    await page.goto(server.baseURL);
    await page.waitForFunction(() => !document.getElementById('preloader') && !!window.Luker?.getContext);
}

function readAutosuggest(page) {
    return page.evaluate(() => {
        const input = document.getElementById('api_key_openai');
        const listId = input?.getAttribute('list') ?? null;
        const list = listId ? document.getElementById(listId) : null;
        return {
            listId,
            optionValues: list ? [...list.querySelectorAll('option')].map(option => option.value) : [],
            containerChildren: document.getElementById('secrets_datalists')?.children.length ?? 0,
        };
    });
}

test.describe('desktop browser', () => {
    test('attaches the saved-key autosuggest to the API key input', async ({ page }) => {
        await openApp(page);

        const state = await readAutosuggest(page);
        expect(state.listId).toBe('api_key_openai_datalist');
        expect(state.optionValues).toContain(SECRET_ID);
    });
});

test.describe('mobile web browser', () => {
    test.use({
        userAgent: ANDROID_MOBILE_UA,
        viewport: { width: 412, height: 915 },
        isMobile: true,
        hasTouch: true,
    });

    test('keeps the saved-key autosuggest on the mobile web', async ({ page }) => {
        await openApp(page);

        const state = await readAutosuggest(page);
        expect(await page.evaluate(() => navigator.userAgent)).toContain('Mobile');
        expect(state.listId).toBe('api_key_openai_datalist');
        expect(state.optionValues).toContain(SECRET_ID);
    });
});

test.describe('native app shells', () => {
    test('leaves the API key input free-form inside the HarmonyOS app', async ({ page }) => {
        await page.addInitScript(() => {
            window.LukerHarmony = {
                setGenerationActive() {},
                setImmersiveModeEnabled() {},
                openExternalUrl() {},
            };
        });
        await openApp(page);

        const state = await readAutosuggest(page);
        expect(state.listId).toBeNull();
        expect(state.containerChildren).toBe(0);
    });

    test('leaves the API key input free-form inside the Android app', async ({ page }) => {
        await page.addInitScript(() => {
            window.LukerAndroid = {
                setImmersiveModeEnabled() {},
                setSystemBarsColor() {},
                setBackgroundKeepAliveEnabled() {},
                notifyMessageProgress() {},
                notifyMessageFinished() {},
                clearMessageProgressNotification() {},
            };
        });
        await openApp(page);

        const state = await readAutosuggest(page);
        expect(state.listId).toBeNull();
        expect(state.containerChildren).toBe(0);
    });
});
