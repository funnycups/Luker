// Moonshot / Kimi fixed sampling — full-chain e2e over the Moonshot source.
//
// Every active Kimi model fixes temperature, top_p, presence_penalty and
// frequency_penalty server-side (platform.kimi.ai/docs/api/models-overview);
// passing any other value returns an error. So the client must both:
//   - hide those four controls when chat_completion_source = 'moonshot'
//     (data-source gating in public/index.html, applied by
//     toggleChatCompletionForms in public/scripts/openai.js), and
//   - strip them from the outgoing body (createGenerationParameters).
//
// This test asserts both: with a supporting source the controls are visible,
// with moonshot they are hidden, and the last /chat/completions request the
// mock received carries none of the four keys.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapMoonshotBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

const MOCK_REPLY = 'The tide chart reads slack water at dawn; we row then, before the wind turns.';

let server;
let mock;

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

/** Open the API Connections drawer (holds #chat_completion_source). */
async function openApiDrawer(page) {
    const panel = page.locator('#rm_api_block');
    if (await isDrawerOpen(panel)) return;
    await closeConfigDrawer(page);
    await page.locator('#API-status-top').click();
    await panel.waitFor({ state: 'visible', timeout: 5000 });
}

/** Open the AI Response Configuration drawer (holds the sampling controls). */
async function openConfigDrawer(page) {
    const panel = page.locator('#left-nav-panel');
    const isOpen = await panel.evaluate(el => el && !el.classList.contains('closedDrawer')).catch(() => false);
    if (isOpen) return;
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

/** The last chat-completions request the mock received. */
function lastChatRequest() {
    return [...mock.requests].reverse().find(r => r.url.endsWith('/chat/completions'));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [MOCK_REPLY, MOCK_REPLY] });
    server = await startServer({ scope, batchKey: 'generation', scenarioId: 'moonshot-fixed-sampling' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapMoonshotBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, model: 'kimi-k3' });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe.serial('Moonshot fixed sampling', () => {
    test('UI hides sampling controls and the wire body drops them', async ({ page }) => {
        test.setTimeout(120_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        const controls = ['#temp_openai', '#top_p_openai', '#freq_pen_openai', '#pres_pen_openai'];

        // Positive control: a source that supports sampling shows all four.
        await openApiDrawer(page);
        await page.locator('#chat_completion_source').selectOption('openai');
        await openConfigDrawer(page);
        await expandGenerationParameters(page);
        for (const sel of controls) {
            await expect(page.locator(sel)).toBeVisible();
        }

        // Switch to moonshot — every block must hide.
        await openApiDrawer(page);
        await page.locator('#chat_completion_source').selectOption('moonshot');
        await openConfigDrawer(page);
        await expandGenerationParameters(page);
        for (const sel of controls) {
            await expect(page.locator(sel)).toBeHidden();
        }

        // Real send: flush settings, then assert the wire body drops the four.
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            await ctx.saveSettings?.(0, { directSave: true });
        });
        await sendMessageAndAwaitReply(page, 'Read me the tide chart for the morning row.');

        const gen = lastChatRequest();
        expect(gen, 'no /chat/completions request was recorded').toBeTruthy();
        const body = gen.body || {};
        expect(body.model).toBe('kimi-k3');
        expect(Array.isArray(body.messages)).toBe(true);
        expect(body.temperature).toBeUndefined();
        expect(body.top_p).toBeUndefined();
        expect(body.frequency_penalty).toBeUndefined();
        expect(body.presence_penalty).toBeUndefined();
    });
});
