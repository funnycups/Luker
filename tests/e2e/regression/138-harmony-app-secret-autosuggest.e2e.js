import { test, expect } from '../../harness/playwright.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';

// The saved-key autosuggest hangs a <datalist> off every API key input, one
// <option> per saved key, whose value is the secret's opaque uuid. The HarmonyOS
// app shell surfaces that datalist as a full-screen list of uuids over the input,
// so the shell must not receive the datalist at all.

const SECRET_ID = 'c27acabf-e34d-4096-96a8-b422f90ba499';

let server;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'regression', scenarioId: 'harmony-app-secret-autosuggest' });
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

test('attaches the saved-key autosuggest to the API key input', async ({ page }) => {
    await openApp(page);

    const state = await readAutosuggest(page);
    expect(state.listId).toBe('api_key_openai_datalist');
    expect(state.optionValues).toContain(SECRET_ID);
});

test('leaves the API key input free-form inside the HarmonyOS app shell', async ({ page }) => {
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
