import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['ok'] });
    server = await startServer({ batchKey: 'extensions', scenarioId: 'search-providers' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

function readSearchToolsSettings(dataRoot) {
    const path = resolve(dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    return settings?.extension_settings?.search_tools || {};
}

test.describe('search providers settings panel', () => {
    test('every provider renders its fields and persists a change', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openExtensionsDrawer(page);
        await page.locator('#search_tools_settings .inline-drawer-toggle').first().click();
        await page.locator('#search_tools_settings .inline-drawer-content').first().waitFor({ state: 'visible' });

        const providerSelect = page.locator('#search_tools_provider');
        await providerSelect.waitFor({ state: 'visible' });

        const ids = await providerSelect.locator('option').evaluateAll(options => options.map(o => o.value));
        expect(ids).toEqual(expect.arrayContaining(['ddg', 'searxng', 'brave', 'tavily', 'exa', 'serper', 'serpapi', 'zai']));

        // Providers with a secret key show the API-key row.
        for (const id of ['tavily', 'exa', 'serper', 'serpapi', 'zai', 'brave']) {
            await providerSelect.selectOption(id);
            await expect(page.locator('#search_tools_provider_settings .manage-api-keys')).toHaveCount(1);
        }

        // Safe search is shown only where supported.
        for (const [id, expected] of [['tavily', 1], ['serper', 0], ['zai', 0]]) {
            await providerSelect.selectOption(id);
            await expect(page.locator('#search_tools_provider_settings [data-provider-field="safeSearch"]')).toHaveCount(expected);
        }

        // Change a field and confirm it persists to settings.json.
        await providerSelect.selectOption('tavily');
        await page.locator('#search_tools_provider_settings [data-provider-field="searchDepth"]').selectOption('advanced');
        await page.waitForTimeout(1500);
        const stored = readSearchToolsSettings(server.dataRoot);
        expect(stored?.providers?.tavily?.searchDepth).toBe('advanced');
    });

    test('POST /api/search/query runs a real DuckDuckGo search', async ({ page }) => {
        // CSRF protection is enabled, so the request carries the same
        // session-bound token the browser client sends on every write.
        const csrfResp = await page.request.get(`${server.baseURL}/csrf-token`);
        const { token } = await csrfResp.json();
        const response = await page.request.post(`${server.baseURL}/api/search/query`, {
            data: { provider: 'ddg', query: 'capybara', max_results: 3 },
            headers: { 'X-CSRF-Token': token },
        });
        expect(response.ok()).toBe(true);
        const payload = await response.json();
        expect(payload.provider).toBe('ddg');
        expect(typeof payload.result_count).toBe('number');
        expect(Array.isArray(payload.results)).toBe(true);
        for (const result of payload.results) {
            expect(typeof result.title).toBe('string');
            expect(result.url).toMatch(/^https?:\/\//);
        }
    });
});
