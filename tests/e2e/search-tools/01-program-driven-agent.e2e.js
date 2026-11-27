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

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
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
    sendMessageViaUI,
} from '../_lib/page.js';

const AGENT_SEARCH = 'luker_search_agent_search';
const AGENT_UPSERT = 'luker_search_agent_upsert_lorebook_entry';
const AGENT_GET = 'luker_search_agent_get_lorebook_entries';
const PANEL = '.rpdock.rp-dock';
const SHARED_LOREBOOK = '__SEARCH_TOOLS__';
const MAIN_REPLY = '*Seraphina folds the chart and sets the lantern on the sill.* "The tide will tell us more than the glass will tonight. Stay a while."';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'extensions', scenarioId: 'search-tools-agent', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('search-tools program-driven agent', () => {
    test.describe.configure({ mode: 'serial' });

    test('reads all requested managed entries beyond the former limit', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enablePreRequestAgent(page);
        const ids = Array.from({ length: 12 }, (_, index) => `watch_${index}`);
        let round = 0;
        mock.clearScriptedCompletion();
        mock.scriptCompletion(({ toolNames }) => {
            if (!toolNames?.includes(AGENT_SEARCH)) return { text: MAIN_REPLY };
            if (round++ === 0) return { toolCalls: ids.map(id => ({ name: AGENT_UPSERT, arguments: { entry_id: id, title: id, keywords: [id], content: `The harbor watch records ${id}.`, always_inject: false } })) };
            if (round === 2) return { tool: AGENT_GET, arguments: { entry_ids: [...ids, 'missing_watch'] } };
            return { text: 'The harbor records are complete.' };
        });
        await sendMessageViaUI(page, 'Read all the harbor watch records before we sail.');
        await expect(page.locator(PANEL).locator('.rp-status')).toHaveAttribute('data-status', 'committed', { timeout: 90_000 });
        const request = mock.requests.find(record => record.body?.messages?.some(message => message.role === 'tool' && String(message.content).includes('missing_entry_ids')));
        expect(request).toBeTruthy();
        const result = request.body.messages.filter(message => message.role === 'tool').map(message => {
            try { return JSON.parse(message.content); } catch { return null; }
        }).find(value => Array.isArray(value?.missing_entry_ids));
        expect(result.entries.map(entry => entry.entry_id)).toEqual(ids);
        expect(result.missing_entry_ids).toEqual(['missing_watch']);
    });

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

        await sendMessageViaUI(page, '*She taps the chart once.* "Check the logbook before the next watch."');

        // The shared Run Dock auto-opens on the non-quiet RUN_STARTED emitted
        // when the pre-request agent begins.
        const panel = page.locator(PANEL);
        await expect(panel).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
        // The run panel is the only running indicator.
        await expect(page.locator('#toast-container .toast-info')).toHaveCount(0);

        // Enlarge the dock so all rounds and their details are available.
        const enlargeBtn = panel.getByRole('button', { name: /^(Enlarge|放大)$/ });
        await expect(enlargeBtn).toBeVisible();
        await enlargeBtn.click();

        // The run settles into the committed terminal state — the agent stopped
        // on the scripted no-tool-call round.
        await expect(panel.locator('.rp-status')).toHaveAttribute('data-status', 'committed', { timeout: 60_000 });

        const firstHead = panel.locator('.rp-dock-agent-head').first();
        await expect(firstHead).toBeVisible();
        if ((await firstHead.getAttribute('aria-expanded')) !== 'true') {
            await firstHead.click();
        }
        await expect(firstHead).toHaveAttribute('aria-expanded', 'true');

        // At least one step carries a tool_call kind.
        await expect.poll(
            async () => panel.locator('.rp-step[data-kind="tool_call"]').count(),
            { timeout: 30_000 },
        ).toBeGreaterThan(0);

        // The final round exposes the actual no-tool reply, not an absent block.
        const lastBlock = panel.locator('.rp-dock-agent').last();
        await expect(lastBlock).toBeVisible();
        const lastHead = lastBlock.locator('.rp-dock-agent-head');
        if ((await lastHead.getAttribute('aria-expanded')) !== 'true') {
            await lastHead.click();
        }
        await expect(lastHead).toHaveAttribute('aria-expanded', 'true');
        await expect(lastBlock.locator('.rp-step[data-kind="tool_call"]')).toHaveCount(0);
        await expect(lastBlock.locator('.rp-step[data-kind="text"] .rp-textblock'))
            .toHaveText('Existing managed entries already cover this turn; no further search is needed.');

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
            await sendMessageViaUI(page, '*She unrolls a fresh chart.* "Hold the light steady — I want the reef line exact."');

            const panel = page.locator(PANEL);
            await expect(panel).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
            await expect(page.locator('#toast-container .toast-info')).toHaveCount(0);
            const stopButton = panel.locator('button.rp-dock-stop').first();
            await stopButton.waitFor({ state: 'visible', timeout: 30_000 });
            await stopButton.click();

            await expect(panel.locator('.rp-status')).toHaveAttribute('data-status', 'aborted', { timeout: 30_000 });
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
