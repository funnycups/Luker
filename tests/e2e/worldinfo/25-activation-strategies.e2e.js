// #25 — Activation strategies all inject correctly
//
// Build a single world book with one entry per strategy:
//   a) constant       — always injected (no key needed)
//   b) selective AND_ANY (single primary key) — injected on key match
//   c) selective AND_ANY (no secondary)  — "blue" / forced primary-key-only
//   d) selective AND_ALL (primary + secondary required) — "green" / AND-logic
//   e) vectorized     — flagged for semantic injection
//
// For each strategy we send a turn whose user text exercises that path
// via the real #send_textarea + #send_but gesture (sendMessageAndAwaitReply),
// and assert the entry's content appears in the next chat-completion
// request body the server sends to the mock backend. mock.requests
// captures the raw body — that's the load-bearing source of truth for
// "what reached the LLM" (the only way the WI activation graph can be
// observed end-to-end).
//
// Vectorized verification: we also confirm the vectorized flag is
// reflected in the WI editor itself — open the drawer, pick the book
// in #world_editor_select, and read `select[name="entryStateSelector"]`
// (the same control the user clicks to toggle constant / normal /
// vectorized). This proves the flag is round-tripped through the editor
// UI, not just on disk.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { openWorldInfoDrawer } from '../_lib/ui-worldinfo.js';
import { writeCharacterWithBinding, startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

/**
 * The shared dev seed at `data/default-user/settings.json` may carry an
 * orchestrator-flavored preset selection (e.g. `plugin-only-...`) whose
 * giant system prompt would dominate the chat-completion body and crowd
 * the WI-injected entries out of the budget assertion. Drop the preset
 * pointer + the prompts array so the prompt body the WI activation
 * injects into is small and predictable. Idempotent.
 */
function scrubPresetPrompts(dataRoot, handle = 'default-user') {
    const path = resolve(dataRoot, handle, 'settings.json');
    if (!existsSync(path)) return;
    const s = JSON.parse(readFileSync(path, 'utf8'));
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.preset_settings_openai = 'Default';
    s.oai_settings.prompts = [];
    s.oai_settings.prompt_order = [];
    s.oai_settings.main_prompt = '';
    s.oai_settings.nsfw_prompt = '';
    s.oai_settings.jailbreak_prompt = '';
    s.oai_settings.impersonation_prompt = '';
    s.oai_settings.new_chat_prompt = '';
    s.oai_settings.new_group_chat_prompt = '';
    s.oai_settings.new_example_chat_prompt = '';
    s.oai_settings.continue_nudge_prompt = '';
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.orchestrator = { ...(s.extension_settings.orchestrator || {}), enabled: false };
    s.extensionSettings = s.extensionSettings || {};
    s.extensionSettings.orchestrator = { ...(s.extensionSettings.orchestrator || {}), enabled: false };
    writeFileSync(path, JSON.stringify(s, null, 4));
}

test.describe.configure({ mode: 'serial' });

let server, mock;

const STRATEGY_ENTRIES = [
    {
        key: [],
        keysecondary: [],
        comment: 'constant-always',
        content: 'CONSTANT_LORE: The lighthouse on Bryn cliff has burned every night since the great surge of 1899.',
        constant: true,
        order: 100,
    },
    {
        key: ['quartermaster', 'quartermasters'],
        keysecondary: [],
        comment: 'selective-single-primary',
        content: 'SELECTIVE_LORE: The quartermaster of Bryn keeps tallow candles in a locked cedar chest, rationed to one per night.',
        order: 110,
    },
    {
        key: ['drifter', 'drifters'],
        keysecondary: [],
        comment: 'blue-primary-only',
        content: 'BLUE_LORE: Drifters of the salt mark trail kelp lines behind their skiffs to mark safe water for those who come after.',
        order: 120,
    },
    {
        key: ['signal', 'signals'],
        keysecondary: ['lantern'],
        comment: 'green-and-all',
        content: 'GREEN_LORE: When the keeper raises and lowers the lantern three times, drifters answer by trimming their sails to half.',
        selectiveLogic: 3, // AND_ALL
        order: 130,
    },
    {
        key: ['kelp', 'reef-kelp'],
        keysecondary: [],
        comment: 'vectorized-flag',
        content: 'VECTOR_LORE: Kelp dies in fresh water within a tide; the green ribbons on the south reef tell of a hidden spring.',
        vectorized: true,
        order: 140,
    },
];

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: Array.from({ length: 8 }, (_, i) =>
            `*Ash answers measuredly, eyes still on the chart.* Reply ${i + 1} acknowledged.`,
        ),
    });
    server = await startWorldInfoServer({ specBaseName: '25-activation-strategies', scenarioId: 'activation-strategies' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    scrubPresetPrompts(server.dataRoot);

    const bookName = writeWorldBook({
        dataRoot: server.dataRoot,
        name: 'activation-strategies-book',
        entries: STRATEGY_ENTRIES,
    });

    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-strategies.png',
        name: 'Ash Strategies',
        worldBook: bookName,
    });
});

test.afterAll(async () => {
    await tearDownWorldInfoServer(server);
    await mock?.stop();
});

/**
 * Drive the #world_editor_select dropdown to the supplied book name and
 * wait for the rendered entry rows to appear. select2 wraps the native
 * select, so we route through the canonical jQuery `.val(...).trigger('change')`
 * channel (the same path the user's pointer click ultimately triggers
 * on a dropdown item).
 */
async function openBookInEditor(page, bookName) {
    await openWorldInfoDrawer(page);
    await page.locator('#world_editor_select').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction((wanted) => {
        const select = document.querySelector('#world_editor_select');
        if (!select) return false;
        return Array.from(select.options).some(o => String(o.textContent || '').trim() === wanted);
    }, bookName, { timeout: 15_000 });
    const optionValue = await page.evaluate((wanted) => {
        const select = document.querySelector('#world_editor_select');
        if (!select) return null;
        for (const option of Array.from(select.options)) {
            if (String(option.textContent || '').trim() === wanted) return option.value;
        }
        return null;
    }, bookName);
    if (!optionValue) throw new Error(`no editor-dropdown option matches "${bookName}"`);
    let rendered = false;
    for (let attempt = 0; attempt < 3 && !rendered; attempt++) {
        await page.evaluate((value) => {
            const jq = window.jQuery || window.$;
            if (!jq) throw new Error('jQuery missing');
            jq('#world_editor_select').val(value).trigger('change');
        }, optionValue);
        try {
            await page.locator('#world_popup_entries_list .world_entry').first().waitFor({ state: 'visible', timeout: 6_000 });
            rendered = true;
        } catch { /* retry */ }
    }
    if (!rendered) throw new Error(`book "${bookName}" entries did not render after 3 retries`);
}

test.describe('#25 — Activation strategies all inject correctly', () => {
    test('constant + selective + AND_ALL all route content into the prompt', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Strategies');

        // Wait for the character card to finish loading so the bound book pointer resolves.
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world;
        }, { timeout: 10_000 });

        // Settle: first_mes greeting populates ctx.chat before our /send.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Lobby gesture: confirm the bound book is visible in the WI
        // editor dropdown by opening the drawer and selecting it. This
        // proves the book reached the editor pipeline through the same
        // selector a real user would use, not just `loadWorldInfo` under
        // the hood. We then close the drawer so the chat composer is
        // unobstructed for the send turns below.
        await openBookInEditor(page, 'activation-strategies-book');
        const editorEntryCount = await page.locator('#world_popup_entries_list .world_entry').count();
        expect(editorEntryCount, 'expected the editor to render all 5 strategy entries on open').toBe(5);

        // Helper: send a turn and return the body of the resulting chat-completion request.
        async function sendAndCaptureBody(text) {
            const before = mock.requests.length;
            await sendMessageAndAwaitReply(page, text);
            const newReqs = mock.requests.slice(before);
            const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
            expect(chatReq, 'expected a chat-completion request after sending').toBeTruthy();
            return JSON.stringify(chatReq.body.messages);
        }

        // (a) Constant: any message triggers it; use a message with no triggers
        //     for the other entries to keep the assertion clean.
        const bodyA = await sendAndCaptureBody('I came up the cliff path before the wind shifted.');
        expect(bodyA, 'constant entry should always appear').toContain('CONSTANT_LORE');
        expect(bodyA).not.toContain('SELECTIVE_LORE');
        expect(bodyA).not.toContain('BLUE_LORE');
        expect(bodyA).not.toContain('GREEN_LORE');

        // (b) Selective single-primary: mention "quartermaster" → SELECTIVE_LORE injected.
        const bodyB = await sendAndCaptureBody('Have you spoken with the quartermaster about the candles tonight?');
        expect(bodyB).toContain('CONSTANT_LORE'); // constant always
        expect(bodyB).toContain('SELECTIVE_LORE');
        expect(bodyB).not.toContain('BLUE_LORE');
        expect(bodyB).not.toContain('GREEN_LORE');

        // (c) Blue (primary-key only — no secondary): mention "drifters" → BLUE_LORE injected.
        const bodyC = await sendAndCaptureBody('The drifters were seen north of the gull rocks at dusk.');
        expect(bodyC).toContain('CONSTANT_LORE');
        expect(bodyC).toContain('BLUE_LORE');
        expect(bodyC).not.toContain('GREEN_LORE'); // signal+lantern not both present

        // (d) Green (AND_ALL): "signal" alone is not enough; both "signal" and "lantern" must appear.
        const bodyD1 = await sendAndCaptureBody('I think I saw a signal flicker against the rocks.');
        expect(bodyD1).toContain('CONSTANT_LORE');
        expect(bodyD1).not.toContain('GREEN_LORE'); // missing "lantern"

        const bodyD2 = await sendAndCaptureBody('The signal from the lantern was clear: three quick raises and a hold.');
        expect(bodyD2).toContain('CONSTANT_LORE');
        expect(bodyD2).toContain('GREEN_LORE'); // both primary + secondary present
    });

    test('vectorized entry exposes the flag in the editor and remains keyword-active', async ({ page }) => {
        // The vectorized flag does NOT exempt an entry from keyword matching;
        // it only ADDS the entry to the vectors extension's semantic pool.
        // So a vectorized entry whose primary key is in the user message
        // still fires via the keyword path — and its content lands in the
        // prompt the same way a normal selective entry would. This sub-case
        // locks both behaviors: flag round-trips into the editor UI's
        // `entryStateSelector` AND keyword activation isn't suppressed by
        // the flag.

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Strategies');

        // Read the vectorized flag from the same `entryStateSelector`
        // widget the user would click to change it. The selector lives in
        // the entry HEADER (visible even before the inline drawer body
        // expands), so we don't need to expand the entry first.
        await openBookInEditor(page, 'activation-strategies-book');
        const states = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('#world_popup_entries_list .world_entry'));
            return rows.map(r => {
                const commentEl = r.querySelector('input[name="comment"], textarea[name="comment"]');
                const stateEl = r.querySelector('select[name="entryStateSelector"]');
                return {
                    comment: commentEl?.value || '',
                    state: stateEl?.value || '',
                };
            });
        });
        const vectorRow = states.find(s => s.comment === 'vectorized-flag');
        expect(vectorRow, 'vectorized entry should be present in the editor').toBeTruthy();
        expect(vectorRow.state, 'vectorized entry should expose the "vectorized" state in the entry selector').toBe('vectorized');

        // Now drive a real send turn whose user text mentions the
        // vectorized entry's primary key ("kelp"). VECTOR_LORE must
        // appear in the prompt — the vectorized flag does NOT block
        // keyword activation.
        const before = mock.requests.length;
        await sendMessageAndAwaitReply(page, 'The kelp on the south reef looked thinner today than last week.');
        const newReqs = mock.requests.slice(before);
        const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
        const body = JSON.stringify(chatReq.body.messages);
        expect(body, 'vectorized entry should still inject via keyword path when its primary key is matched').toContain('VECTOR_LORE');
    });
});
