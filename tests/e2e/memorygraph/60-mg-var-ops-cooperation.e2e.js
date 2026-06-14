// tests/e2e/memorygraph/60-mg-var-ops-cooperation.e2e.js
//
// #60 — MG + var_ops co-operation.
//
// MG does not read chat metadata variables directly — it does not call
// `ctx.getVariable` anywhere in the extension. The integration point
// between MG and var_ops is via SillyTavern's MACRO engine
// (`substituteParams` / `substituteParamsExtended`), which evaluates
// `{{getvar::name}}` in any string that flows through the standard
// prompt pipeline.
//
// MG node-type schema fields that the extraction / compression /
// recall LLM consumes — `extractHint`, `extractionInstructions`,
// `columnHints`, `summarizeInstruction`, the `description` field on
// per-column schema entries — all surface in those LLM prompts. The
// MG schema-iteration system prompt is explicit about this contract
// (see `schema-iteration/system-prompt.js` line 62: "Fields like
// extractHint, … may contain {{user}}, {{char}}, {{getvar::xxx}}…").
//
// What this case pins:
//   1. Set a chat-scoped variable via `ctx.setVariable(name, value)`
//      against a specific FLOOR (the only working path; see "Real bug"
//      below).
//   2. The variable lands in the floor's `extra.var_ops` and replays
//      into `chatMetadata.variables`.
//   3. `substituteParams` evaluates `{{getvar::<name>}}` against the
//      replayed variable — the same eval path MG fields go through
//      when the extraction pipeline assembles its prompt.
//   4. An MG node whose summary embeds `{{getvar::<name>}}` stores the
//      token verbatim and expands correctly via `substituteParams`,
//      proving the cross-component contract: MG stores raw macro
//      tokens, var_ops supplies the values, the macro engine joins
//      them at prompt-assembly time.
//
// Real bug surfaced by writing this test:
//   `ctx.setVariable(name, value)` with NO floor option (the chat-
//   scoped path) calls a `saveMetadataDebounced()` symbol that is
//   never imported in public/script.js — see the second sub-case
//   below, wrapped in `test.fail`. The floor-scoped path is fine
//   because it routes through `pushFloorVarOp` + `saveChatConditional`.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina watches the lantern flame for a moment.* "We will know by the third bell."',
            '*She marks a faint line on the chart.* "Note that — the wind shifted east an hour ago."',
            '*A measured nod.* "Hold this watch. The drifters will come when the tide turns."',
        ],
    });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'mg-var-ops' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#60 — MG + var_ops co-operation via macro evaluation', () => {
    test('floor-scoped setVariable + {{getvar::X}} in MG summary fields expands via substituteParams, survives restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // 3 RP turns so the chat has a real tail to attach floor-scoped
        // var_ops to.
        for (const t of [
            'I climbed the cliff path before dusk. The lantern is steady.',
            'The wind has shifted east — a slow swallow night.',
            'Hold the watch. I will fetch the chart.',
        ]) {
            await sendMessageAndAwaitReply(page, t);
        }

        // Set a chat variable via the floor-scoped path (push setvar op
        // onto floor N's `extra.var_ops`; the op log apply step then
        // mirrors it into `chatMetadata.variables`).
        const setResult = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            if (typeof ctx.setVariable !== 'function') {
                return { error: 'ctx.setVariable not exposed' };
            }
            if (typeof ctx.substituteParams !== 'function') {
                return { error: 'ctx.substituteParams not exposed' };
            }
            // Target the latest assistant message id as the floor anchor.
            const latestId = ctx.chat.length - 1;
            await ctx.setVariable('current_omen_threshold', '7.5', { floor: latestId });

            // Round-trip: floor-scoped var_ops re-apply into
            // chatMetadata.variables before the next substituteParams call.
            // Force a reapply by calling getVariable (which goes through the
            // same evaluator).
            const directMeta = ctx.chatMetadata?.variables?.current_omen_threshold;
            const viaGetVar = typeof ctx.getVariable === 'function'
                ? ctx.getVariable('current_omen_threshold')
                : null;
            const macroExpanded = ctx.substituteParams('{{getvar::current_omen_threshold}}');
            const fieldShaped = ctx.substituteParams(
                'Only log a reef-shudder event if the recorded amplitude exceeds the current omen threshold ({{getvar::current_omen_threshold}}).',
            );
            return {
                ok: true,
                directMeta,
                viaGetVar,
                macroExpanded,
                fieldShaped,
            };
        });
        expect(setResult.error, `setVariable / substituteParams probe error: ${setResult.error}`).toBeUndefined();
        // chatMetadata.variables should have the value after the floor op
        // applies — either directly, or via getVariable (the public
        // accessor that the var-op-log apply step feeds).
        expect(
            setResult.directMeta || setResult.viaGetVar,
            'setVariable with a floor should land in chat metadata (directly or via the var-op-log apply step)',
        ).toBe('7.5');
        expect(
            setResult.macroExpanded,
            '{{getvar::current_omen_threshold}} should expand to "7.5"',
        ).toBe('7.5');
        expect(
            setResult.fieldShaped,
            'MG-field-shaped string with a getvar macro should round-trip the variable value',
        ).toBe('Only log a reef-shudder event if the recorded amplitude exceeds the current omen threshold (7.5).');

        // Write an MG record whose summary field embeds the same macro
        // pattern. After saveChat + restart, the variable should still
        // expand correctly — the cross-component persistence contract:
        // chat metadata variables outlive the server process.
        const wroteWithMacro = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const settings = ctx.extensionSettings?.memory_graph;
            if (settings) settings.enabled = true;
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            if (!session) return { error: 'no session' };
            const node = await session.createNode({
                // character_sheet preserves the supplied title verbatim;
                // event normalizes to "Summary N" so we can't match by title
                // post-restart. The summary field embeds the macro token.
                type: 'character_sheet',
                title: 'Reef-shudder watch threshold tracker',
                fields: {
                    title: 'Reef-shudder watch threshold tracker',
                    identity: '负责礁石回响阈值监测的夜哨；阈值为 {{getvar::current_omen_threshold}}。',
                },
            });
            await ctx.saveChat();
            return { ok: true, nodeId: node?.id || '' };
        });
        expect(wroteWithMacro.error, `write-with-macro error: ${wroteWithMacro.error}`).toBeUndefined();
        expect(wroteWithMacro.nodeId).toBeTruthy();

        // Persistence across server restart — the load-bearing piece for
        // "director extraction fires after reload and still sees the var".
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        const afterRestart = await page.evaluate(async ({ nodeId }) => {
            const ctx = window.SillyTavern.getContext();
            // The var-op log apply step runs on CHAT_CHANGED. After a hard
            // reload, the chat reloads; we wait a tick for the listener to
            // settle, then force a manual rebuild as belt-and-suspenders
            // (some test fixture flows fire CHAT_CHANGED before the chat
            // array is fully hydrated).
            await new Promise(r => setTimeout(r, 500));
            const varOpLog = await import('/scripts/variable-op-log/index.js').catch(() => null);
            try { varOpLog?.rebuildVariablesFromChat?.(); } catch { /* ignore */ }

            const viaGetVar = typeof ctx.getVariable === 'function'
                ? ctx.getVariable('current_omen_threshold')
                : null;
            const metaValue = ctx.chatMetadata?.variables?.current_omen_threshold;
            const macroExpanded = ctx.substituteParams('{{getvar::current_omen_threshold}}');

            // Diagnostic: dump the chat tail's var_ops so we can see whether
            // the op landed in message.extra.var_ops at all.
            const lastWithOps = ctx.chat
                .map((m, i) => ({ i, var_ops: m?.extra?.var_ops || null }))
                .filter(x => Array.isArray(x.var_ops) && x.var_ops.length > 0);

            const settings = ctx.extensionSettings?.memory_graph;
            if (settings) settings.enabled = true;
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            if (!session) return { error: 'no session post-restart' };
            const cands = session.listVisibleCandidates({});
            const node = cands.find(n => n.id === nodeId);
            const rawIdentity = node?.fields?.identity || '';
            const expandedIdentity = ctx.substituteParams(rawIdentity);
            return {
                ok: true,
                viaGetVar,
                metaValue,
                macroExpanded,
                rawIdentity,
                expandedIdentity,
                allCandidateTitles: cands.map(n => n.title),
                allChatVarOps: lastWithOps,
                allMetaKeys: Object.keys(ctx.chatMetadata?.variables || {}),
            };
        }, { nodeId: wroteWithMacro.nodeId });
        expect(afterRestart.error, `post-restart inspection error: ${afterRestart.error}`).toBeUndefined();
        expect(
            afterRestart.viaGetVar || afterRestart.metaValue,
            `current_omen_threshold must survive server restart via the floor-scoped var_ops persistence path; ` +
            `metaKeys=${JSON.stringify(afterRestart.allMetaKeys)} ` +
            `chatVarOps=${JSON.stringify(afterRestart.allChatVarOps).slice(0, 500)}`,
        ).toBe('7.5');
        expect(
            afterRestart.macroExpanded,
            '{{getvar::*}} should expand correctly after restart — confirms the macro engine wires up to the persisted variable',
        ).toBe('7.5');
        // The MG node's identity should still carry the raw macro tokens
        // (storage is verbatim); evaluating it via substituteParams should
        // now embed "7.5" — the same path the LLM prompt builder takes
        // when it surfaces this field in extraction or recall context.
        expect(
            afterRestart.rawIdentity,
            `MG stores macro tokens verbatim — does not pre-expand on write. titles=${JSON.stringify(afterRestart.allCandidateTitles)}`,
        ).toContain('{{getvar::current_omen_threshold}}');
        expect(
            afterRestart.expandedIdentity,
            'an MG field carrying a {{getvar::*}} token should expand to the post-restart variable value (7.5) when evaluated via substituteParams',
        ).toContain('7.5');
        expect(
            afterRestart.expandedIdentity,
            'post-expansion string should NOT still contain the raw macro token',
        ).not.toContain('{{getvar::');
    });

    test(
        'ctx.setVariable(name, value) chat-scoped (no floor) persists via saveMetadataDebounced',
        async ({ page }) => {
            await awaitMainUI(page, server.baseURL);
            await selectCharacterByName(page, 'Seraphina');
            // Bare chat-scoped setVariable (no floor option). The
            // implementation in public/script.js#setVariable (line 11946)
            // calls `saveMetadataDebounced()` after mutating
            // chatMetadata.variables — but that symbol is exported from
            // public/scripts/extensions.js and never imported into
            // script.js. Result: a ReferenceError aborts the call and
            // the variable never actually persists (best case) or the
            // calling context catches the throw (worst case, silent
            // partial state).
            //
            // Expected post-fix: the call resolves cleanly. Under the
            // bug, this `expect(...).resolves` rejects with the
            // ReferenceError.
            const result = await page.evaluate(async () => {
                try {
                    const ctx = window.SillyTavern.getContext();
                    await ctx.setVariable('bare_scope_test', 'expected-value');
                    return { ok: true, value: ctx.chatMetadata?.variables?.bare_scope_test };
                } catch (err) {
                    return { ok: false, error: String(err?.message || err) };
                }
            });
            expect(
                result.ok,
                `bare chat-scoped setVariable should resolve cleanly; got error: ${result.error}`,
            ).toBe(true);
            expect(result.value, 'value should land in chatMetadata.variables').toBe('expected-value');
        },
    );
});
