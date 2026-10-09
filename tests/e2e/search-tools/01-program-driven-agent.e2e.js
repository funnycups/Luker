// Search-tools e2e — the program-driven pre-request search agent.
//
// Spec:
//   - Enable "Run pre-request search agent" through the real settings UI.
//   - Send a chat turn. The plugin's GENERATION_AFTER_WORLD_INFO_SCAN handler
//     drives the agent loop: real `/api/search/query` against the default
//     DuckDuckGo provider, real world-info reads/writes — only the LLM is the
//     mock.
//   - Assert the run panel auto-opens, accumulates a tool_call section, the
//     shared lorebook `__SEARCH_TOOLS__` gains a managed entry, and the run
//     stops on the scripted no-tool-call round (status committed).
//   - Second scenario: stop the run from the panel mid-flight; assert aborted.
//
// The mock LLM is scripted by tool-set fingerprint: every request carrying the
// agent's `luker_search_agent_*` tools is answered from a fixed agent sequence;
// anything else (the main generation) gets the plain reply. Determinism comes
// from the scripted sequence, not from the live search results.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    openExtensionsDrawer,
    closeExtensionsDrawer,
} from '../_lib/page.js';

const AGENT_SEARCH = 'luker_search_agent_search';
const AGENT_UPSERT = 'luker_search_agent_upsert_lorebook_entry';
const PANEL = '#luker-search-tools-run-panel';
const SHARED_LOREBOOK = '__SEARCH_TOOLS__';
const MAIN_REPLY = '*Seraphina folds the chart and sets the lantern on the sill.* "The tide will tell us more than the glass will tonight. Stay a while."';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'extensions', scenarioId: 'search-tools-agent' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('search-tools program-driven agent', () => {
    test.describe.configure({ mode: 'serial' });

    test('runs the agent, auto-opens the run panel, writes the shared lorebook, and stops on a no-tool-call round', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enablePreRequestAgent(page);

        const agentTurns = [];
        mock.clearScriptedCompletion();
        mock.scriptCompletion(({ toolNames }) => {
            const isAgent = Array.isArray(toolNames) && toolNames.includes(AGENT_SEARCH);
            if (!isAgent) {
                return { text: MAIN_REPLY };
            }
            const turn = agentTurns.length;
            agentTurns.push(turn);
            if (turn === 0) {
                return { tool: AGENT_SEARCH, arguments: { query: 'lighthouse keeper logbook tide record' } };
            }
            if (turn === 1) {
                return {
                    tool: AGENT_UPSERT,
                    arguments: {
                        title: 'Watchpost Logbook',
                        content: 'The Bryn watchpost logbook records the reef tide cycle and the nightly lantern trimming schedule.',
                        always_inject: true,
                    },
                };
            }
            return { text: 'Existing managed entries already cover this turn; no further search is needed.' };
        });

        await sendChat(page, '*She taps the chart once.* "Check the logbook before the next watch."');

        // The run panel auto-opens on the non-quiet RUN_STARTED emitted when the
        // pre-request agent begins.
        const panel = page.locator(PANEL);
        await expect(panel).toHaveAttribute('data-state', 'open', { timeout: 30_000 });

        // At least one round carries a tool_call section.
        await expect.poll(
            async () => panel.locator('.section[data-kind="tool_call"]').count(),
            { timeout: 30_000 },
        ).toBeGreaterThan(0);

        // The run settles into the committed terminal state — the agent stopped
        // on the scripted no-tool-call round.
        await expect(panel.locator('.status-dot')).toHaveAttribute('data-status', 'committed', { timeout: 60_000 });

        // The final round is the scripted plain-text response: a text section and
        // no tool_call section.
        const lastRound = panel.locator('.round').last();
        await expect(lastRound.locator('.section[data-kind="text"]')).toHaveCount(1);
        await expect(lastRound.locator('.section[data-kind="tool_call"]')).toHaveCount(0);

        // The shared lorebook gained a managed entry, read back through the
        // app's own world-info API.
        const managed = await readSharedManagedEntries(page);
        expect(managed.length).toBeGreaterThan(0);
        expect(managed.some(entry => entry.content.includes('watchpost logbook'))).toBe(true);
    });

    test('stopping the run from the panel aborts it', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enablePreRequestAgent(page);

        // Delay every agent LLM round-trip so the run is still in flight when we
        // reach for the panel's Stop button.
        mock.setLatencyMs((_req, parsed) => {
            const names = (parsed?.tools || []).map(tool => String(tool?.function?.name || tool?.name || ''));
            return names.some(name => name.startsWith('luker_search_agent_')) ? 4000 : 0;
        });
        mock.clearScriptedCompletion();
        mock.scriptCompletion(({ toolNames }) => {
            const isAgent = Array.isArray(toolNames) && toolNames.includes(AGENT_SEARCH);
            if (!isAgent) {
                return { text: MAIN_REPLY };
            }
            return { tool: AGENT_SEARCH, arguments: { query: 'tide tables for the bryn reef' } };
        });

        try {
            await sendChat(page, '*She unrolls a fresh chart.* "Hold the light steady — I want the reef line exact."');

            const panel = page.locator(PANEL);
            await expect(panel).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
            const stopButton = panel.locator('[data-action="stop"]');
            await stopButton.waitFor({ state: 'visible', timeout: 30_000 });
            await stopButton.click();

            await expect(panel.locator('.status-dot')).toHaveAttribute('data-status', 'aborted', { timeout: 30_000 });
        } finally {
            mock.setLatencyMs(0);
        }
    });
});

async function enablePreRequestAgent(page) {
    await openExtensionsDrawer(page);
    await page.locator('#search_tools_settings').waitFor({ state: 'attached', timeout: 10_000 });
    await page.locator('#search_tools_settings .inline-drawer-toggle').first().click();
    await page.locator('#search_tools_settings .inline-drawer-content').first().waitFor({ state: 'visible' });

    // Point the agent at the current backend / current preset. A dev data
    // clone can carry a persisted agent-level connection profile + prompt
    // preset that routes the agent LLM away from the e2e mock; the "(Current
    // ...)" options clear both through the same selects a user drives.
    await page.locator('#search_tools_agent_api_preset_name').selectOption('');
    await page.locator('#search_tools_agent_preset_name').selectOption('');

    const checkbox = page.locator('#search_tools_pre_request_enabled');
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await closeExtensionsDrawer(page);
}

async function sendChat(page, text) {
    await page.evaluate((prompt) => {
        const ta = document.getElementById('send_textarea');
        ta.value = prompt;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send_but').click();
    }, text);
}

async function readSharedManagedEntries(page) {
    return await page.evaluate(async (bookName) => {
        const ctx = window.Luker.getContext();
        const data = await ctx.loadWorldInfo(bookName);
        const entries = data && typeof data.entries === 'object' ? Object.values(data.entries) : [];
        return entries
            .filter(entry => String(entry?.comment || '').startsWith('SEARCH_TOOLS::'))
            .map(entry => ({ comment: entry.comment, content: String(entry?.content || '') }));
    }, SHARED_LOREBOOK);
}
