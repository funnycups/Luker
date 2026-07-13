// Case #79 — Orchestrator LOOP mode: profile.lorebookFilter blocks entries
//                                    from both context injection AND every
//                                    lorebook tool the loop agent calls.
//
// Spec:
//   - Two lorebooks bound to the chat via the global selection channel:
//       'e2e-filter-private' — two entries whose comments are `entry_a` /
//         `entry_b` and whose keys are `PRIVATE_TRIGGER_A` / `_B`. Both
//         entries carry `constant:true` so they always land in the WI
//         payload for this turn (avoids the "did any key trigger?" race).
//       'e2e-filter-public'  — two entries: `secret_key` (constant) and
//         `public_info` (constant). Same constant:true reason.
//   - Loop profile's `lorebookFilter`:
//         bookPattern:  `^e2e-filter-private$`   → hides the whole book
//         entryPattern: `^secret_`               → hides `secret_key` in
//                                                   `public` by comment
//   - Contract to verify at run-time (Tasks 3 + 4 of the plan):
//       (A) Context injection: neither PRIVATE_CONTENT_* nor SECRET_CONTENT
//           appears in the main-model chat-completion request body; the
//           unfiltered PUBLIC_CONTENT DOES appear.
//       (B) Loop tools: when the loop agent calls `lorebook_get` on the
//           filtered book / `lorebook_list` on the public book, the
//           filtered rows are indistinguishable-from-absent (get → error,
//           list → row missing).
//
// Assertion strategy:
//   - The mock LLM's router is invoked once per /chat/completions call.
//     Node-side `expect` throws inside the router are surfaced as HTTP
//     500s to the runtime, which produces a mode of test failure that's
//     hard to read (the loop retries + eventually gives up). Instead the
//     router captures request bodies and tool-result messages into an
//     `observed` bag; assertions run at the end.
//
//   - Two chat-completion requests are relevant per turn:
//       (i)  Loop agent — driven by our router; classified as
//            'director-main' by mockLLM.js because `finalize` is a
//            main-only tool marker.
//       (ii) Main model — the reply generator; falls through the router
//            (returns null for role !== director-main / subagent) and
//            gets the default queued or echo reply.
//
//   - Context-injection assertion runs against the MAIN-MODEL request
//     body (the one that carries `worldInfoBefore/After` — the loop
//     agent's request instead carries just the loop system prompt and
//     the tool schema).
//
// Env / dependencies covered by this e2e:
//   Task 1 (helper: sanitize + compileLorebookFilter, activated-entry
//     keys) — indirectly, because filter is set on the profile via
//     writeActivePreset which runs the sanitizer.
//   Task 2 (profile-level sanitizer wiring) — same.
//   Task 3 (onWorldInfoFinalized hook mutates payload) — covered by (A).
//   Task 4 (source-side filter in every lorebook tool) — covered by (B).

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
} from '../_lib/page.js';
import { writeCharacterWithBinding } from '../worldinfo/_helpers.js';

const CHARACTER_NAME = 'Ash Filter Loop';
const CHARACTER_AVATAR = 'ash-filter-loop.png';
const PRIVATE_BOOK = 'e2e-filter-private';
const PUBLIC_BOOK = 'e2e-filter-public';

// Sentinel contents chosen to be impossible to appear by accident, so
// the substring assertions on the main-model chat-completion body can
// never false-positive on stray tokens from another turn.
const PRIVATE_CONTENT_A = '__ORCH_FILTER_E2E__PRIVATE_CONTENT_A__DO_NOT_LEAK__';
const PRIVATE_CONTENT_B = '__ORCH_FILTER_E2E__PRIVATE_CONTENT_B__DO_NOT_LEAK__';
const SECRET_CONTENT = '__ORCH_FILTER_E2E__SECRET_CONTENT__DO_NOT_LEAK__';
const PUBLIC_CONTENT = '__ORCH_FILTER_E2E__PUBLIC_CONTENT__EXPECTED_TO_LEAK__';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '79-lorebook-filter-loop' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Write the two lorebooks to disk before first UI paint. Both entries
    // in both books are `constant:true` so they always activate for the
    // turn — takes key-scan timing out of the equation.
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

    // Create a character whose primary world is PRIVATE_BOOK. PUBLIC_BOOK
    // is bound as an additional (aux) book via `world_info.charLore` in
    // settings.json — that's the same channel the WI panel writes to when
    // a user opens "Additional Lore Books" on the character editor.
    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: CHARACTER_AVATAR,
        name: CHARACTER_NAME,
        worldBook: PRIVATE_BOOK,
    });

    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.world_info = s.world_info || {};
    // charLore[i] = { name: <avatarFileNameWithoutExtension>, extraBooks: [<bookName>...] }
    // This is the format read by world-info.js:2124 to pull additional
    // books when computing per-character enabled entries. `name` matches
    // `getCharaFilename()`, which strips the .png extension.
    s.world_info.charLore = [
        { name: CHARACTER_AVATAR.replace(/\.png$/, ''), extraBooks: [PUBLIC_BOOK] },
    ];
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#79 — Loop mode lorebookFilter blocks context injection and lorebook tools', () => {
    test('filtered book and entry are invisible in both context AND loop tools; public unfiltered entry remains visible', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHARACTER_NAME);

        // Bind PUBLIC_BOOK as the character's aux book at runtime.
        // We can't rely on writing `settings.world_info.charLore` to
        // disk during beforeAll — Luker's `getSettings` /
        // `saveSettings` roundtrip resets `world_info.charLore` to `[]`
        // when the client-side `world_info` module hasn't populated it
        // yet, so the disk value gets clobbered before any character is
        // selected. Instead, mutate the live module state after the
        // character is loaded (that's the same channel the WI editor's
        // "Additional Lore Books" toggle uses), then persist so
        // subsequent bootstrap reads see it too.
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

        // Sanity: confirm both books are actually loaded / activatable
        // before we drive the turn. Character has PRIVATE_BOOK as its
        // primary via `data.extensions.world`; PUBLIC_BOOK is bound as
        // an aux via `world_info.charLore` (runtime patch above). If
        // either binding didn't land, fail fast with a specific message
        // so downstream WI assertions aren't debugged as filter regressions.
        const worldInfoSanity = await page.evaluate(async ({ privateBook, publicBook }) => {
            const worldInfoMod = await import('/scripts/world-info.js');
            const ctx = Luker.getContext();
            const character = ctx.characters?.[ctx.characterId];
            const primary = character?.data?.extensions?.world || '';
            let sortedEntries = [];
            try {
                const getSorted = ctx.worldInfoEntry?.getSorted;
                if (typeof getSorted === 'function') {
                    sortedEntries = await getSorted();
                }
            } catch { /* leave empty */ }
            const worlds = new Set(sortedEntries.map(e => String(e?.world || '')));
            return {
                primaryBinding: primary,
                worldNamesInEntries: Array.from(worlds).sort(),
                entryCountByBook: {
                    [privateBook]: sortedEntries.filter(e => e?.world === privateBook).length,
                    [publicBook]: sortedEntries.filter(e => e?.world === publicBook).length,
                },
            };
        }, { privateBook: PRIVATE_BOOK, publicBook: PUBLIC_BOOK });
        expect(worldInfoSanity.primaryBinding, 'character.data.extensions.world binds PRIVATE_BOOK').toBe(PRIVATE_BOOK);
        expect(worldInfoSanity.worldNamesInEntries, 'both lorebooks are enabled for this chat')
            .toEqual(expect.arrayContaining([PRIVATE_BOOK, PUBLIC_BOOK]));
        expect(worldInfoSanity.entryCountByBook[PRIVATE_BOOK], 'PRIVATE_BOOK has 2 entries loaded').toBe(2);
        expect(worldInfoSanity.entryCountByBook[PUBLIC_BOOK], 'PUBLIC_BOOK has 2 entries loaded').toBe(2);

        // Configure the loop profile: enable orchestrator, switch to loop
        // mode, and write an active loop preset whose lorebookFilter
        // hides `PRIVATE_BOOK` (whole book, by book-pattern) plus any
        // entry whose comment starts with `secret_` (in any book).
        await page.evaluate(async ({ privateBook }) => {
            const ctx = window.Luker.getContext();
            const settings = ctx.extensionSettings?.orchestrator;
            if (!settings) throw new Error('orchestrator settings missing — extension not loaded');
            settings.enabled = true;
            settings.executionMode = 'loop';
            settings.singleAgentModeEnabled = false;
            settings.toolCallRetryMax = 1;
            // Nuke per-agent connection overrides — mirror the reasoning
            // in `installMinimalDirectorProfile`: dev settings.json may
            // leave a real-provider name in llmNodeApiPresetName and
            // send agent traffic AWAY from the mock.
            settings.llmNodeApiPresetName = '';
            settings.llmNodePresetName = '';
            settings.requestApiPresetName = '';
            settings.requestLlmPresetName = '';

            const [presetLib, persistence] = await Promise.all([
                import('/scripts/extensions/orchestrator/preset-library.js'),
                import('/scripts/extensions/orchestrator/persistence.js'),
            ]);

            const loopProfile = persistence.sanitizeLoopProfile({
                system_prompt: 'You are the test loop agent. Call finalize with a short capsule when you have enough context.',
                lorebookFilter: {
                    bookPattern: `^${privateBook}$`,
                    entryPattern: '^secret_',
                },
                // Force max_rounds low so a misbehaving router can't wedge
                // the loop into infinite retries.
                max_rounds: 6,
                wall_clock_budget_ms: 60000,
            });

            const write = presetLib.writeActivePreset(settings, 'loop', 'global', loopProfile);
            if (!write.ok) throw new Error(`writeActivePreset(loop) failed: ${write.reason}: ${write.hint}`);

            try { await ctx.saveSettings?.(0, { directSave: true }); } catch { /* best-effort */ }
            ctx.saveSettingsDebounced?.();
        }, { privateBook: PRIVATE_BOOK });

        // Observed state for post-run assertions. The router captures
        // loop-agent bodies and the tool-message contents it saw so we
        // can assert AFTER the whole exchange completes, avoiding
        // router-side `expect` throws (which surface as HTTP 500s that
        // the loop treats as retriable failures).
        //
        // The main-model reply request classifies as `role: 'unknown'`
        // in mockLLM.js (no `finalize` / no META_FRAME), so it bypasses
        // the router entirely. We read it back from `mock.requests`
        // after the turn instead of trying to intercept it here.
        const observed = {
            mainAgentBodies: [],       // loop-agent request bodies
            toolMessageContents: [],   // string content of every tool msg
                                        // the loop agent saw in a subsequent turn
        };
        // Snapshot the pre-turn request cursor so the post-turn scan
        // only walks THIS turn's traffic — the beforeAll bootstrap may
        // have sent /v1/models probes that are irrelevant here.
        const requestStartIdx = mock.requests.length;

        // Extract every tool-role message from an incoming request. Loop
        // tool results are fed back to the agent as `role: 'tool'` chat
        // messages in the next round; that's where we read the actual
        // shape the agent saw for filter+notfound branches.
        function collectToolMessages(body) {
            const messages = Array.isArray(body?.messages) ? body.messages : [];
            for (const m of messages) {
                if (!m || m.role !== 'tool') continue;
                observed.toolMessageContents.push(
                    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                );
            }
        }

        // Driver: three rounds against the loop agent, then main model
        // gets an echo reply. Rounds:
        //   turn 0: lorebook_get on the FILTERED book's entry_a
        //           → LOREBOOK_NOT_FOUND (filter drops the entry BEFORE
        //           the lookup completes; indistinguishable from absent)
        //   turn 1: world_book_list
        //           → PUBLIC_BOOK present, PRIVATE_BOOK absent AND the
        //           entry count for PUBLIC_BOOK is one less than reality
        //           (the filtered `secret_key` row silently drops out of
        //           the per-book count). Uses world_book_list (not
        //           lorebook_list) because lorebook_list dedups against
        //           already-activated entries — with all entries
        //           constant:true, lorebook_list output is always empty
        //           and cannot distinguish "filter working" from "all
        //           entries already injected".
        //   turn 2: lorebook_get on the PUBLIC book's `public_info`
        //           entry → succeeds, proving unfiltered access is
        //           intact (baseline / not-over-filtering assertion).
        //   turn 3: finalize with a short capsule.
        mock.scriptDirectorRun({
            route: (req) => {
                if (req.role === 'director-main') {
                    // The classifier tags loop-agent requests as
                    // 'director-main' because they carry `finalize` in
                    // their tools array — same fingerprint bucket.
                    observed.mainAgentBodies.push(req.body);
                    collectToolMessages(req.body);
                    if (req.turn === 0) {
                        return { tool: 'lorebook_get', arguments: { entry_key: 'PRIVATE_TRIGGER_A', book: PRIVATE_BOOK } };
                    }
                    if (req.turn === 1) {
                        return { tool: 'world_book_list', arguments: {} };
                    }
                    if (req.turn === 2) {
                        return { tool: 'lorebook_get', arguments: { entry_key: 'PUBLIC_TRIGGER', book: PUBLIC_BOOK } };
                    }
                    if (req.turn === 3) {
                        return { tool: 'finalize', arguments: { capsule_text: 'Test capsule — loop agent verified filter behavior end-to-end.' } };
                    }
                    // Guard-rail: if the loop somehow keeps calling us
                    // past finalize, return finalize again rather than
                    // return null (which would fall through to the
                    // deterministic queue echo and confuse the loop).
                    return { tool: 'finalize', arguments: { capsule_text: 'Test capsule (overrun-guard).' } };
                }
                // Non-director-main / non-subagent requests are the
                // main-model reply. Fall through to the queue-based
                // echo path — we capture those bodies from
                // `mock.requests` after the turn completes.
                return null;
            },
        });

        // Trigger the turn through the real send composer. Because both
        // lorebooks are constant:true, every one of their entries lands
        // in worldInfoResolution.activatedEntries and any that survive
        // the filter shows up in the WI-injection channels the main
        // model reads from.
        await sendMessageAndAwaitReply(
            page,
            '*She glances at the chart, waiting.* "What have you found?"',
            { timeoutMs: 60_000 },
        );

        // --- Assertions ------------------------------------------------

        // Post-turn: pull main-model reply bodies from mock.requests.
        // These are the /chat/completions requests whose role is
        // `unknown` — i.e. carry neither the sub-agent META_FRAME nor
        // any of the main-only director tools — and that arrived
        // AFTER we snapshotted the cursor.
        const turnRequests = mock.requests
            .slice(requestStartIdx)
            .filter(r => /\/chat\/completions$/.test(r.url) || /\/v1\/chat\/completions$/.test(r.url));
        const mainModelBodies = turnRequests
            .map(r => r.body || {})
            .filter(body => {
                const toolDefs = Array.isArray(body?.tools) ? body.tools : [];
                const toolNames = toolDefs.map(t => String(t?.function?.name || t?.name || ''));
                // A main-model reply request has NO orchestrator-tool
                // schema attached — no `finalize`, no `dispatch_subagent`,
                // no lorebook_* etc. That's how we distinguish it from
                // the loop-agent request in the same request array.
                const hasOrchTool = toolNames.some(n => n === 'finalize' || n === 'dispatch_subagent' || n === 'write_message' || n === 'lorebook_get' || n === 'lorebook_list');
                return !hasOrchTool;
            });

        // We saw at least four loop rounds AND at least one main-model
        // reply (otherwise the turn didn't complete through both stages).
        expect(observed.mainAgentBodies.length, 'loop agent was called at least 4 rounds').toBeGreaterThanOrEqual(4);
        expect(mainModelBodies.length, 'main-model reply request was made').toBeGreaterThanOrEqual(1);

        // (A) Context-injection contract: the LAST main-model request
        //     body — the one prepared with WI baked in — must contain
        //     PUBLIC_CONTENT and MUST NOT contain any of the three
        //     filtered contents.
        //
        //     Why serialize the whole body: WI content lands in multiple
        //     channels (worldInfoBefore / worldInfoAfter / worldInfoDepth
        //     buckets / anBefore / anAfter / examples). Rather than
        //     enumerate all of them, we JSON.stringify the payload and
        //     scan for the sentinels. Contamination in ANY channel is a
        //     failure; presence of PUBLIC_CONTENT anywhere is proof of
        //     WI actually being wired up (baseline sanity).
        const mainModelBodyStr = JSON.stringify(mainModelBodies[mainModelBodies.length - 1]);
        expect(mainModelBodyStr, 'main-model request body carries PUBLIC unfiltered content (WI wiring sanity)').toContain(PUBLIC_CONTENT);
        expect(mainModelBodyStr, 'main-model request body must NOT contain PRIVATE_CONTENT_A (filtered by book pattern)').not.toContain(PRIVATE_CONTENT_A);
        expect(mainModelBodyStr, 'main-model request body must NOT contain PRIVATE_CONTENT_B (filtered by book pattern)').not.toContain(PRIVATE_CONTENT_B);
        expect(mainModelBodyStr, 'main-model request body must NOT contain SECRET_CONTENT (filtered by entry pattern)').not.toContain(SECRET_CONTENT);

        // (B) Loop-tool contract. Look at the tool-messages the loop
        //     agent saw in later rounds. Three tool calls we scripted:
        //       - lorebook_get on the FILTERED entry_a → not_found
        //         (source-side filter drops the entry BEFORE the "did
        //         we find a match?" check, so filtered = absent).
        //       - world_book_list → PUBLIC_BOOK listed, PRIVATE_BOOK
        //         absent, and PUBLIC_BOOK's entry-count is one less
        //         than reality (filtered secret_key row silently drops
        //         from the per-book count).
        //       - lorebook_get on the UNFILTERED public_info entry →
        //         succeeds, proving the filter doesn't over-block.
        //
        //     We JSON-serialize each captured tool-message content and
        //     check by substring; the three shapes (LOREBOOK_NOT_FOUND
        //     error JSON, grep-style world_book_list output, and the
        //     structured lorebook_get success payload) all survive.
        const allToolMessages = observed.toolMessageContents.join('\n---\n');
        expect(allToolMessages.length, 'loop agent saw at least one tool-result message across its later rounds').toBeGreaterThan(0);
        // Filtered book: not_found
        expect(allToolMessages, 'lorebook_get on filtered book surfaced as not_found (no PRIVATE_CONTENT leaked through tool output)').not.toContain(PRIVATE_CONTENT_A);
        expect(allToolMessages, 'lorebook_get error message references not_found for the filtered entry').toMatch(/not.?found|LOREBOOK_NOT_FOUND/);
        // world_book_list: PUBLIC listed, PRIVATE hidden entirely.
        // Locate the world_book_list result payload specifically —
        // asserting on the whole tool-message stream can't distinguish
        // `PRIVATE_BOOK` appearing in a subsequent tool_call's argument
        // echo (which is fine) from it appearing in world_book_list's
        // output (which would be a filter regression).
        const worldBookListPayload = observed.toolMessageContents
            .find(c => /world_book_list result|\[character_aux\]|\[global\]|\[character\]|\[chat\]|\[unknown\]/.test(c));
        expect(worldBookListPayload, 'world_book_list produced a result payload in the tool-message stream').toBeTruthy();
        expect(worldBookListPayload, 'world_book_list output surfaces the public book').toContain(PUBLIC_BOOK);
        expect(worldBookListPayload, 'world_book_list output must NOT surface the filtered private book').not.toContain(PRIVATE_BOOK);
        // world_book_list: PUBLIC's per-book count is 1, not 2, because
        // the filtered `secret_key` entry silently drops out. Assertion
        // shape: the grep line is `[<scope>] <book_name> (1 entry)`.
        expect(worldBookListPayload, 'world_book_list per-book count for public book reflects the filtered entry drop')
            .toMatch(new RegExp(`${PUBLIC_BOOK}[^\\n]*\\(1 entry\\)`));
        // Unfiltered entry: lorebook_get succeeds
        expect(allToolMessages, 'lorebook_get on the unfiltered public_info entry returns its content (baseline non-over-filtering)').toContain(PUBLIC_CONTENT);
        // Filtered entry content must not leak anywhere in tool output.
        expect(allToolMessages, 'no SECRET content leaks through any tool result').not.toContain(SECRET_CONTENT);
    });
});
