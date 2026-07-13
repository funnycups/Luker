// Case #80 — Orchestrator DIRECTOR mode: profile.lorebookFilter blocks
//                                        entries from both context
//                                        injection AND every lorebook
//                                        tool called by the director
//                                        main agent AND sub-agents.
//
// Spec:
//   - Same two lorebooks as #79 (via the global-selection channel):
//       'e2e-filter-private' — two entries with `constant:true` so they
//         always activate.
//       'e2e-filter-public'  — two entries: `secret_key` (constant) and
//         `public_info` (constant).
//   - Director profile's `lorebookFilter`:
//         bookPattern:  `^e2e-filter-private$`
//         entryPattern: `^secret_`
//   - Contract to verify (Tasks 3 + 4 threaded into director-runtime.js
//     and director-tools.js#runDispatchInternal):
//       (A) Context injection: the main-agent's chat-completion request
//           body must NOT contain PRIVATE_CONTENT_* / SECRET_CONTENT
//           yet MUST contain PUBLIC_CONTENT. Sub-agent request bodies
//           MUST also carry the same filtered context (director's
//           <story_context> propagates verbatim to every sub-agent per
//           director-tools.js#runDispatchInternal — cf. case #74).
//       (B) Loop-lorebook tools invoked BY the sub-agent (sub-agents
//           inherit the loop lorebook tool set) enforce the same
//           source-side filter — `lorebook_get` on the filtered book
//           returns not_found, `lorebook_list` on the public book omits
//           `secret_key`.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
    writeWorldBook,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    installMinimalDirectorProfile,
} from '../_lib/page.js';
import { writeCharacterWithBinding } from '../worldinfo/_helpers.js';

const CHARACTER_NAME = 'Ash Filter Director';
const CHARACTER_AVATAR = 'ash-filter-director.png';
const PRIVATE_BOOK = 'e2e-filter-private-d';
const PUBLIC_BOOK = 'e2e-filter-public-d';

const PRIVATE_CONTENT_A = '__ORCH_FILTER_DIR_E2E__PRIVATE_CONTENT_A__DO_NOT_LEAK__';
const PRIVATE_CONTENT_B = '__ORCH_FILTER_DIR_E2E__PRIVATE_CONTENT_B__DO_NOT_LEAK__';
const SECRET_CONTENT = '__ORCH_FILTER_DIR_E2E__SECRET_CONTENT__DO_NOT_LEAK__';
const PUBLIC_CONTENT = '__ORCH_FILTER_DIR_E2E__PUBLIC_CONTENT__EXPECTED_TO_LEAK__';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '80-lorebook-filter-director' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    writeWorldBook({
        dataRoot: server.dataRoot,
        name: PRIVATE_BOOK,
        entries: [
            { comment: 'entry_a', key: ['PRIVATE_TRIGGER_A'], content: PRIVATE_CONTENT_A, constant: true },
            { comment: 'entry_b', key: ['PRIVATE_TRIGGER_B'], content: PRIVATE_CONTENT_B, constant: true },
        ],
    });
    writeWorldBook({
        dataRoot: server.dataRoot,
        name: PUBLIC_BOOK,
        entries: [
            { comment: 'secret_key', key: ['SECRET_TRIGGER'], content: SECRET_CONTENT, constant: true },
            { comment: 'public_info', key: ['PUBLIC_TRIGGER'], content: PUBLIC_CONTENT, constant: true },
        ],
    });

    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: CHARACTER_AVATAR,
        name: CHARACTER_NAME,
        worldBook: PRIVATE_BOOK,
    });

    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.world_info = s.world_info || {};
    s.world_info.charLore = [
        { name: CHARACTER_AVATAR.replace(/\.png$/, ''), extraBooks: [PUBLIC_BOOK] },
    ];
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#80 — Director mode lorebookFilter blocks context injection and lorebook tools (main + sub-agent)', () => {
    test('filtered content stays out of main + sub-agent request bodies; sub-agent lorebook tools enforce the same source-side filter', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHARACTER_NAME);

        // Bind PUBLIC_BOOK as the character's aux book at runtime.
        // See #79 for the rationale: writing `world_info.charLore` to
        // disk during beforeAll gets clobbered by the settings-load
        // roundtrip before any character is selected.
        await page.evaluate(async ({ publicBook }) => {
            const worldInfoMod = await import('/scripts/world-info.js');
            const ctx = Luker.getContext();
            const avatarFile = ctx.characters?.[ctx.characterId]?.avatar || '';
            const fileNameNoExt = avatarFile.replace(/\.[^/.]+$/, '');
            const wi = worldInfoMod.world_info;
            if (!Array.isArray(wi.charLore)) wi.charLore = [];
            const existing = wi.charLore.find(e => e?.name === fileNameNoExt);
            if (existing) {
                if (!existing.extraBooks?.includes(publicBook)) {
                    existing.extraBooks = [...(existing.extraBooks || []), publicBook];
                }
            } else {
                wi.charLore.push({ name: fileNameNoExt, extraBooks: [publicBook] });
            }
            ctx.saveSettingsDebounced?.();
            try { await ctx.saveSettings?.(0, { directSave: true }); } catch { /* best-effort */ }
        }, { publicBook: PUBLIC_BOOK });

        // Install a minimal director profile with one sub-agent, then
        // stamp `lorebookFilter` onto the profile at the director-level.
        // We also enable the loop lorebook tools at the profile-tools
        // layer so the sub-agent's schema (built via
        // `buildSubAgentToolSchemas` → `loopToolSchemasFor`) actually
        // exposes `lorebook_get` / `lorebook_list` — without that flag
        // the sub-agent would try to call unknown tool names and the
        // runtime would reject them.
        //
        // director-tools.js:1127 threads the lorebookFilter object onto
        // the sub-agent's tool context so its lorebook_get /
        // lorebook_list calls hit the source-side filter identically to
        // the main agent's tool calls.
        await installMinimalDirectorProfile(page, {
            mainSystemPrompt: 'You are the test director. Use dispatch_subagent then write_message + finalize.',
            subAgents: [
                {
                    id: 'lore_scout',
                    description: 'A sub-agent that probes lorebooks to verify filter behavior.',
                    systemPrompt: 'You are the lore scout sub-agent. Reply with a one-line acknowledgment after your tool calls.',
                },
            ],
            tools: {
                collab: { dispatch_subagent: true, dispatch_inline_subagent: true },
                lorebook: { world_book_list: true, list: true, search: true, get: true },
            },
        });

        await page.evaluate(async ({ privateBook }) => {
            const ctx = window.Luker.getContext();
            const settings = ctx.extensionSettings.orchestrator;
            const [presetLib, dirDefaults] = await Promise.all([
                import('/scripts/extensions/orchestrator/preset-library.js'),
                import('/scripts/extensions/orchestrator/director-defaults.js'),
            ]);
            const currentResult = presetLib.getActivePreset(settings, 'director', { scope: 'global', context: ctx });
            const current = (currentResult.ok && currentResult.state) ? currentResult.state : {};
            const next = dirDefaults.sanitizeDirectorProfile({
                ...current,
                lorebookFilter: {
                    bookPattern: `^${privateBook}$`,
                    entryPattern: '^secret_',
                },
            });
            const write = presetLib.writeActivePreset(settings, 'director', 'global', next);
            if (!write.ok) throw new Error(`writeActivePreset(director) failed: ${write.reason}: ${write.hint}`);
            try { await ctx.saveSettings?.(0, { directSave: true }); } catch { /* best-effort */ }
            ctx.saveSettingsDebounced?.();

            // Pre-save the active OpenAI chat-completion preset so
            // `director-preset-swap.applyDirectorPresetSwap` doesn't
            // hit the "unsaved changes" confirm popup at run-start.
            // `bootstrapCustomBackend` mutates `oai_settings.*` fields
            // (chat_completion_source / custom_url / etc.) — those
            // count as unsaved changes against the shipped "Default"
            // preset, which is what freezes the run behind a modal in
            // headless Playwright. Saving flushes the deltas so the
            // swap proceeds silently, mirroring the path a user takes
            // by clicking "Save" once before enabling director mode.
            try {
                const openai = ctx.openai;
                if (openai && typeof openai.savePreset === 'function') {
                    const activeName = ctx.chatCompletionSettings?.preset_settings_openai;
                    if (activeName) {
                        await openai.savePreset(activeName, ctx.chatCompletionSettings, false);
                    }
                }
            } catch { /* best-effort; if it errors the popup will surface with a clear failure */ }
        }, { privateBook: PRIVATE_BOOK });

        const observed = {
            mainRequests: [],       // director-main chat-completion bodies
            subAgentRequests: [],   // sub-agent chat-completion bodies
            toolMessageContents: [], // tool-role message content strings
        };
        // Track sub-agent local turn count. mockLLM's global `subagent`
        // counter is shared across all dispatched agents in the whole
        // spec; here there is only one sub-agent so per-role turn = local
        // turn for it.
        let subagentLocalTurn = 0;

        function collectToolMessages(body) {
            const messages = Array.isArray(body?.messages) ? body.messages : [];
            for (const m of messages) {
                if (!m || m.role !== 'tool') continue;
                observed.toolMessageContents.push(
                    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                );
            }
        }

        mock.scriptDirectorRun({
            route: (req) => {
                if (req.role === 'director-main') {
                    observed.mainRequests.push(req.body);
                    // Main agent script:
                    //   turn 0: dispatch the lore_scout sub-agent
                    //   turn 1: await it
                    //   turn 2: write_message
                    //   turn 3: finalize
                    if (req.turn === 0) {
                        return {
                            tool: 'dispatch_subagent',
                            arguments: { subagentId: 'lore_scout', task: 'probe both lorebooks for filter behavior' },
                        };
                    }
                    if (req.turn === 1) {
                        return { tool: 'await_subagents', arguments: { handles: ['subagent-0'] } };
                    }
                    if (req.turn === 2) {
                        return {
                            tool: 'write_message',
                            arguments: { text: '*She sets the chart down.* "The lorebook probe returned."', mode: 'replace' },
                        };
                    }
                    if (req.turn === 3) {
                        return { tool: 'finalize', arguments: {} };
                    }
                    // Overrun guard.
                    return { tool: 'finalize', arguments: {} };
                }
                if (req.role === 'subagent') {
                    observed.subAgentRequests.push(req.body);
                    collectToolMessages(req.body);
                    const localTurn = subagentLocalTurn++;
                    // Sub-agent script:
                    //   local turn 0: lorebook_get on the FILTERED
                    //                  entry_a → LOREBOOK_NOT_FOUND
                    //                  (source-side filter drops the
                    //                  entry before the lookup completes).
                    //   local turn 1: world_book_list → PRIVATE book
                    //                  absent, PUBLIC book count
                    //                  reduced by the filtered
                    //                  `secret_key` entry.
                    //   local turn 2: lorebook_get on the UNFILTERED
                    //                  `public_info` entry → succeeds,
                    //                  proving the filter doesn't
                    //                  over-block.
                    //   local turn 3+: no tool call → sub-agent
                    //                  terminates and its text becomes
                    //                  the outputText returned to main.
                    if (localTurn === 0) {
                        return { tool: 'lorebook_get', arguments: { entry_key: 'PRIVATE_TRIGGER_A', book: PRIVATE_BOOK } };
                    }
                    if (localTurn === 1) {
                        return { tool: 'world_book_list', arguments: {} };
                    }
                    if (localTurn === 2) {
                        return { tool: 'lorebook_get', arguments: { entry_key: 'PUBLIC_TRIGGER', book: PUBLIC_BOOK } };
                    }
                    return { text: 'lore scout done.' };
                }
                return null;
            },
        });

        await sendMessageAndAwaitReply(
            page,
            '*She looks up from the chart, waiting.* "What did the scout find?"',
            { timeoutMs: 90_000 },
        );

        // --- Assertions ------------------------------------------------

        expect(observed.mainRequests.length, 'main director agent was called').toBeGreaterThanOrEqual(3);
        expect(observed.subAgentRequests.length, 'sub-agent was dispatched and called at least 3 rounds').toBeGreaterThanOrEqual(3);

        // (A) Context injection into the main-agent request body.
        //     director-tools.js#runDispatchInternal propagates the same
        //     <story_context> to every sub-agent, so BOTH main and sub
        //     requests should carry PUBLIC_CONTENT and NEITHER should
        //     carry the filtered contents.
        //
        //     Read the LAST main-agent request (the write_message /
        //     finalize round — by then any WI-driven context injection
        //     for the turn is fully baked in).
        const lastMainBodyStr = JSON.stringify(observed.mainRequests[observed.mainRequests.length - 1]);
        expect(lastMainBodyStr, 'main-agent request body carries PUBLIC unfiltered content').toContain(PUBLIC_CONTENT);
        expect(lastMainBodyStr, 'main-agent request body must NOT contain PRIVATE_CONTENT_A').not.toContain(PRIVATE_CONTENT_A);
        expect(lastMainBodyStr, 'main-agent request body must NOT contain PRIVATE_CONTENT_B').not.toContain(PRIVATE_CONTENT_B);
        expect(lastMainBodyStr, 'main-agent request body must NOT contain SECRET_CONTENT').not.toContain(SECRET_CONTENT);

        const firstSubBodyStr = JSON.stringify(observed.subAgentRequests[0]);
        expect(firstSubBodyStr, 'sub-agent request body carries PUBLIC unfiltered content (story_context propagation)').toContain(PUBLIC_CONTENT);
        expect(firstSubBodyStr, 'sub-agent request body must NOT contain PRIVATE_CONTENT_A').not.toContain(PRIVATE_CONTENT_A);
        expect(firstSubBodyStr, 'sub-agent request body must NOT contain PRIVATE_CONTENT_B').not.toContain(PRIVATE_CONTENT_B);
        expect(firstSubBodyStr, 'sub-agent request body must NOT contain SECRET_CONTENT').not.toContain(SECRET_CONTENT);

        // (B) Sub-agent lorebook tools enforce the source-side filter.
        //     Same shape assertions as #79's tool-message check, driven
        //     off the tool-role messages the sub-agent saw in its later
        //     rounds.
        const allToolMessages = observed.toolMessageContents.join('\n---\n');
        expect(allToolMessages.length, 'sub-agent saw at least one tool-result message').toBeGreaterThan(0);
        // Filtered book: lorebook_get returns not_found
        expect(allToolMessages, 'no filtered PRIVATE content leaks through sub-agent lorebook_get output').not.toContain(PRIVATE_CONTENT_A);
        expect(allToolMessages, 'sub-agent lorebook_get error indicates not_found for the filtered entry').toMatch(/not.?found|LOREBOOK_NOT_FOUND/);
        // world_book_list: PRIVATE hidden entirely, PUBLIC's count is
        // one less than reality. As in #79 we locate the specific
        // world_book_list result payload to avoid matching PRIVATE_BOOK
        // in a subsequent tool_call's argument echo.
        const worldBookListPayload = observed.toolMessageContents
            .find(c => /\[character_aux\]|\[global\]|\[character\]|\[chat\]|\[unknown\]/.test(c));
        expect(worldBookListPayload, 'sub-agent world_book_list produced a result payload').toBeTruthy();
        expect(worldBookListPayload, 'sub-agent world_book_list surfaces the public book').toContain(PUBLIC_BOOK);
        expect(worldBookListPayload, 'sub-agent world_book_list must NOT surface the filtered private book').not.toContain(PRIVATE_BOOK);
        expect(worldBookListPayload, 'sub-agent world_book_list per-book count reflects the filtered entry drop')
            .toMatch(new RegExp(`${PUBLIC_BOOK}[^\\n]*\\(1 entry\\)`));
        // Unfiltered lookup: succeeds
        expect(allToolMessages, 'sub-agent lorebook_get on the unfiltered public_info entry returns its content').toContain(PUBLIC_CONTENT);
        // No filtered SECRET content anywhere
        expect(allToolMessages, 'no filtered SECRET content leaks through any tool output').not.toContain(SECRET_CONTENT);
    });
});
