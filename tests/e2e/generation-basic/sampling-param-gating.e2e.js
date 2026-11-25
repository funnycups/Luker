// Sampling-parameter gating across chat-completion sources.
//
// Channel-level parameter support is expressed through the `data-source`
// attribute on each settings block (public/index.html), applied by
// toggleChatCompletionForms() in public/scripts/openai.js: a block whose
// data-source omits a source is hidden for that source. This test drives the
// real source <select> and asserts which blocks are shown or hidden, covering
// the whole-channel cases (moonshot swipes and sampling, groq/deepseek/ai21/
// perplexity penalties, perplexity/aimlapi top_k) and the capability
// additions (mistralai/siliconflow/ai21/workers_ai).

import { test, expect } from '../../harness/playwright.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

async function isDrawerOpen(locator) {
    return await locator.evaluate(el => el && !el.classList.contains('closedDrawer')).catch(() => false);
}

/** The AI config panel overlaps the API icon; close it before reaching that icon. */
async function closeConfigDrawer(page) {
    const panel = page.locator('#left-nav-panel');
    if (!(await isDrawerOpen(panel))) return;
    const viewport = page.viewportSize();
    await page.mouse.click(viewport.width - 10, Math.floor(viewport.height / 2));
    await expect(panel).toBeHidden();
}

async function openApiDrawer(page) {
    const panel = page.locator('#rm_api_block');
    if (await isDrawerOpen(panel)) return;
    await closeConfigDrawer(page);
    await page.locator('#API-status-top').click();
    await panel.waitFor({ state: 'visible', timeout: 5000 });
}

async function openConfigDrawer(page) {
    const panel = page.locator('#left-nav-panel');
    if (await isDrawerOpen(panel)) return;
    await page.locator('#leftNavDrawerIcon').click();
    await panel.waitFor({ state: 'visible', timeout: 5000 });
}

/** Expand the collapsed "Generation Parameters" inline drawer. */
async function expandGenerationParameters(page) {
    const header = page.locator('#left-nav-panel .inline-drawer-header', { hasText: 'Generation Parameters' }).first();
    await header.waitFor({ state: 'visible', timeout: 5000 });
    const content = header.locator('..').locator('> .inline-drawer-content');
    if (!(await content.isVisible().catch(() => false))) {
        await header.click();
    }
    await content.waitFor({ state: 'visible', timeout: 5000 });
}

// source, then whether each control is expected to be shown.
const CASES = [
    { source: 'openai', n: true, temperature: true, frequency: true, presence: true, topK: false, minP: false },
    { source: 'moonshot', n: false, temperature: false, frequency: false, presence: false, topK: false, minP: false },
    { source: 'groq', n: false, temperature: true, frequency: false, presence: false, topK: false, minP: false },
    { source: 'perplexity', n: false, temperature: true, frequency: false, presence: false, topK: false, minP: false },
    { source: 'aimlapi', n: true, temperature: true, frequency: true, presence: true, topK: false, minP: false },
    { source: 'chutes', n: false, temperature: true, frequency: true, presence: true, topK: true, minP: true },
    { source: 'deepseek', n: false, temperature: true, frequency: false, presence: false, topK: false, minP: false },
    { source: 'mistralai', n: true, temperature: true, frequency: true, presence: true, topK: true, minP: false },
    { source: 'siliconflow', n: true, temperature: true, frequency: true, presence: true, topK: true, minP: true },
    { source: 'ai21', n: true, temperature: true, frequency: false, presence: false, topK: false, minP: false },
    { source: 'workers_ai', n: true, temperature: true, frequency: true, presence: true, topK: true, minP: false },
];

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'generation', scenarioId: 'sampling-param-gating' });
    markOnboarded({ dataRoot: server.dataRoot });
    // The deterministic seed ships koboldhorde as the main API; the source
    // selector this suite drives lives in the OpenAI block.
    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.main_api = 'openai';
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
});



test.describe.serial('Sampling-parameter gating', () => {
    test('source selection shows or hides the sampling blocks', async ({ page }) => {
        test.setTimeout(120_000);
        await awaitMainUI(page, server.baseURL);

        const controls = {
            n: '#n_openai',
            temperature: '#temp_openai',
            frequency: '#freq_pen_openai',
            presence: '#pres_pen_openai',
            topK: '#top_k_openai',
            minP: '#min_p_openai',
        };

        for (const testCase of CASES) {
            await openApiDrawer(page);
            await page.locator('#chat_completion_source').selectOption(testCase.source);
            await openConfigDrawer(page);
            await expandGenerationParameters(page);

            const shown = Object.entries(controls).filter(([key]) => testCase[key]).map(([, selector]) => selector);
            const hidden = Object.entries(controls).filter(([key]) => !testCase[key]).map(([, selector]) => selector);
            for (const selector of shown) {
                await expect(page.locator(selector), `${testCase.source} shows ${selector}`).toBeVisible();
            }
            for (const selector of hidden) {
                await expect(page.locator(selector), `${testCase.source} hides ${selector}`).toBeHidden();
            }
        }
    });
});
