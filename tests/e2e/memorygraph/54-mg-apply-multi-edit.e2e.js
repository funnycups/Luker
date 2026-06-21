// tests/e2e/memorygraph/54-mg-apply-multi-edit.e2e.js
//
// #54 — MG schema-iteration Studio: multi-edit batch (across multiple
// LLM rounds) lands every field after Apply.
//
// Memory reference: `known_bug_mg_apply_multi_edit` (was open at the
// time of this rewrite). The batch is a sequence of empty-path sandbox
// diffs the studio emits when the LLM tool-calls `mg_schema_set_node_type`
// repeatedly across rounds. Pre-fix `applyEdits` could silently drop
// earlier diffs in the batch; the contract this test pins is "every
// edit lands once Apply is clicked".
//
// Real-user flow:
//   1. Enable MG via the real checkbox.
//   2. openIterStudio(page, 'mg') — click the "AI Iterate Schema"
//      button in the MG settings panel.
//   3. Send 5 sequential prompts via sendIterPrompt(page, 'mg', ...).
//      The mock LLM router intercepts each request (fingerprint: tools
//      array contains `mg_schema_set_node_type`) and replies with a
//      tool_call adding ONE new field to the `event` node type each
//      round. The studio collects all 5 edits as a single pending batch.
//   4. Click Apply via applyIterBatch.
//   5. Open the regular schema editor UI (real button click) and verify
//      all 5 new fields appear in the event card's tableColumns input.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { openMgSchemaEditor } from '../_lib/ui-mg-varops.js';

let server, mock;

// The five field additions we drive through the studio. Each round, the
// mock responds with the FULL event node-type spec including the new
// field; the studio's executor diffs sandbox state to record the edit.
const NEW_FIELDS = ['tags', 'priority', 'mood', 'location', 'tone'];

function buildEventSpec(activeFields) {
    return {
        id: 'event',
        label: 'Event',
        tableName: 'event_table',
        tableColumns: ['summary', ...activeFields],
        embeddingColumns: ['summary'],
        requiredColumns: ['summary'],
        primaryKeyColumns: [],
        forceUpdate: true,
        editable: false,
        level: 'semantic',
        extractHint: '',
        extractionInstructions: '',
        keywords: [],
        alwaysInject: true,
        latestOnly: false,
        compression: { mode: 'hierarchical', threshold: 9, fanIn: 3, maxDepth: 10, keepRecentLeaves: 6, summarizeInstruction: '' },
    };
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    // Pre-queue one mg_schema_set_node_type tool call per sendIterPrompt.
    // Each round's spec is cumulative: round i carries fields[0..i]. The
    // mock's queue (tools[]) is consumed one entry per /chat/completions
    // call, which matches one entry per sendIterPrompt — the iter studio
    // makes exactly one LLM call per send (no automatic iteration here).
    for (let i = 0; i < NEW_FIELDS.length; i++) {
        const activeSoFar = NEW_FIELDS.slice(0, i + 1);
        mock.scriptToolCall({
            name: 'mg_schema_set_node_type',
            arguments: { node_type: buildEventSpec(activeSoFar) },
        });
    }
    // Tail reply: after the 5 tool calls drain, the studio's auto-iterate
    // loop fires one more LLM round expecting either a tool call or
    // terminal text. Provide the terminal text so the loop exits cleanly
    // and the Apply button surfaces.
    mock.scriptReply('All five fields have been added to the event node type. Click Apply to commit.');
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'mg-multi-edit' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function enableMgViaCheckbox(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    await page.evaluate(() => {
        const el = document.getElementById('luker_rpg_memory_enabled');
        if (el && !el.checked) {
            el.checked = true;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Clear the iter-studio connection-profile bindings so the LLM
        // call routes through the active oai_settings (our mock) instead
        // of the dev's "Claude" connection profile which points at the
        // real Claude API.
        const ctx = window.Luker.getContext();
        const s = ctx.extensionSettings?.memory_graph;
        if (s) {
            s.requestApiPresetName = '';
            s.requestLlmPresetName = '';
            s.schemaIterationApiPresetName = '';
            s.schemaIterationLlmPresetName = '';
            s.recallApiPresetName = '';
            s.recallLlmPresetName = '';
            s.extractApiPresetName = '';
            s.extractLlmPresetName = '';
        }
    });
}

test.describe('#54 — MG schema-iter Studio: 5 set-node-type rounds land every field after Apply', () => {
    test.setTimeout(360_000);

    // The bug this spec locks: when the user batches multiple AI turns
    // (here 5 cumulative set-node-type calls across 5 sendIterPrompts)
    // and then approves through them in order, every approved entry must
    // commit and land its newSchema. The pre-fix bus snapshot was always
    // state.live at propose time; state.live only advances on approve,
    // so entries 2..N all stored the same initial fingerprint, and
    // approving entry N>=2 tripped readCurrent's drift check and parked
    // it in `conflict` instead of committing. Fix: snapshot chains off
    // the last pending entry's newValue so the fingerprint of each
    // proposal matches the live state the user will see when they reach
    // that card via in-order approves. Memory:
    // `known_bug_mg_apply_multi_edit`.

    test('5 sendIterPrompts add 5 distinct fields; Apply persists them; schema editor shows all', async ({ page }) => {
        test.setTimeout(360_000);
        await awaitMainUI(page, server.baseURL);
        // Force the runtime values to match what we actually want here so
        // the iter studio's generate path routes through our mock. Dev
        // settings include a Claude API + custom base_url from the dev's
        // pollution that bootstrapCustomBackend doesn't fully neutralize.
        await page.evaluate((mockURL) => {
            const ctx = window.Luker.getContext();
            const s = ctx.chatCompletionSettings;
            if (!s) return;
            s.chat_completion_source = 'custom';
            s.custom_url = mockURL;
            s.stream_openai = false;
            s.openai_model = 'mock-gpt-4o';
            s.custom_model = 'mock-gpt-4o';
            s.base_url = '';
            s.reverse_proxy = '';
            s.proxy_password = '';
            // Clear the connection-manager selected profile so iter
            // studio's profile-lookup doesn't override our chat completion
            // source back to "Claude" → real Claude API. Iter studio
            // resolves the active connection profile and overrides
            // chat_completion_source / custom_url from it before
            // dispatching. The dev's settings has 3 profiles all pointing
            // at real APIs; with no selectedProfile, the studio falls
            // through to oai_settings directly (our mock).
            const cm = ctx.extensionSettings?.connectionManager;
            if (cm) {
                cm.selectedProfile = '';
            }
        }, mock.baseURL);

        // Verify the setting took effect.
        const verifyState = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const s = ctx.chatCompletionSettings;
            return { source: s?.chat_completion_source, url: s?.custom_url, stream: s?.stream_openai };
        });
        if (verifyState.source !== 'custom') {
            throw new Error(`Settings override failed: source=${verifyState.source}`);
        }
        await selectCharacterByName(page, 'Seraphina');
        await enableMgViaCheckbox(page);

        // RE-apply our settings override after character switch (which
        // can trigger settings reload from the active preset).
        await page.evaluate((mockURL) => {
            const ctx = window.Luker.getContext();
            const s = ctx.chatCompletionSettings;
            if (!s) return;
            s.chat_completion_source = 'custom';
            s.custom_url = mockURL;
            s.stream_openai = false;
            s.openai_model = 'mock-gpt-4o';
            s.custom_model = 'mock-gpt-4o';
            s.base_url = '';
            s.reverse_proxy = '';
            s.proxy_password = '';
            // Also clear the active connection profile so resolveProfile
            // doesn't pull from the (dev's polluted) Claude profile.
            const cm = ctx.extensionSettings?.connectionManager;
            if (cm) cm.selectedProfile = null;
        }, mock.baseURL);

        await openIterStudio(page, 'mg');

        // Drive 5 sendIterPrompts — one per cumulative field add. The
        // iter studio's auto-iterate loop breaks as soon as any tool call
        // lands a proposal in the bus (bus.hasOutstanding=true), so each
        // Send maps to exactly one LLM round / one bus proposal. After 5
        // sends the bus holds 5 pending proposals — ALL must commit when
        // Apply is clicked. That's the multi-edit contract.
        for (let i = 0; i < NEW_FIELDS.length; i++) {
            await sendIterPrompt(page, 'mg', `Add the ${NEW_FIELDS[i]} field to the event node type.`);
        }

        // Click Apply.
        await applyIterBatch(page, 'mg');

        // The iter studio's `persistSession` + `render` chain in the
        // post-apply finally block calls a few server endpoints that
        // can be slow when the mock LLM is busy. Wait briefly and tolerate
        // page being unresponsive for a moment.
        await page.waitForTimeout(500).catch(() => {});

        // Cross-check via settings before opening the editor: the event
        // node type's tableColumns should now include all 5 new fields.
        // The studio's commitLiveToSchema writes to the active character's
        // schemaOverride when one is selected (Seraphina here), so read
        // the per-character override path first and fall back to global.
        const persistedColumns = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const character = ctx?.characters?.[ctx?.characterId];
            const override = character?.data?.extensions?.memory_graph?.schemaOverride;
            const overrideEvent = Array.isArray(override)
                ? override.find(x => x?.id === 'event')
                : null;
            if (overrideEvent && Array.isArray(overrideEvent.tableColumns)) {
                return overrideEvent.tableColumns.slice();
            }
            const s = ctx.extensionSettings?.memory_graph;
            const eventSpec = (s?.nodeTypeSchema || []).find(x => x?.id === 'event');
            return Array.isArray(eventSpec?.tableColumns) ? eventSpec.tableColumns.slice() : [];
        });
        for (const f of NEW_FIELDS) {
            expect(persistedColumns, `event tableColumns should include ${f}`).toContain(f);
        }

        // Open the real schema editor and verify the rendered input for
        // the event card's Table Columns shows every new field. Close the
        // iter-studio popup first so the MG settings panel underneath is
        // hit-testable for the schema-editor open button.
        await closeIterStudio(page);
        await openMgSchemaEditor(page);
        const editorTableColumns = await page.evaluate(() => {
            // The editor renders one .luker-schema-card per node type;
            // each card has an input[data-field="tableColumns"] with the
            // comma-separated column list.
            const cards = Array.from(document.querySelectorAll('.luker-schema-card'));
            for (const card of cards) {
                const idInput = card.querySelector('[data-field="id"]');
                if (!idInput || idInput.value !== 'event') continue;
                const colsInput = card.querySelector('[data-field="tableColumns"]');
                return colsInput ? String(colsInput.value || '') : '';
            }
            return '';
        });
        for (const f of NEW_FIELDS) {
            expect(
                editorTableColumns,
                `editor's event Table Columns input should contain ${f}; saw: ${editorTableColumns}`,
            ).toContain(f);
        }
        await page.locator('.popup:visible .popup-button-cancel, .popup:visible .popup-button-close, .popup:visible .popup-button-ok').first().click().catch(() => {});
    });
});
