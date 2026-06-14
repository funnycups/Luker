// Case #74 — Capsule injection: main + sub-agents share capsule config
//
// Spec:
//   - Configure director's capsule (e.g. system identity capsule).
//   - Verify (a) main agent prompt includes it.
//   - Verify (b) sub-agents dispatched mid-run also see the same capsule
//     contents.
//
// The "capsule" in orchestrator is the orchestration guidance text
// produced by a prior run, injected into the next generation as either
// a worldInfoBefore / worldInfoAfter block or a depth-anchored entry.
// See capsule-injection.js for the mutator + position logic.
//
// Layering: capsule injection mutates the OpenAI chat-completion payload
// at the point `CHAT_COMPLETION_SETTINGS_READY` fires. The director
// runtime captures that mutated payload (via `directorContentCache`) and
// propagates it verbatim as the `<story_context>` slice in BOTH the main
// agent's taskMessages AND every dispatched sub-agent's taskMessages
// (director-tools.js#runDispatchInternal). So whatever capsule injection
// places in the payload reaches all participating agents.
//
// What unlocked the runtime-driven leg:
//   The director-aware mock LLM router (`scriptDirectorRun`) lets us
//   drive a full main→subagent→finalize loop deterministically. We inject
//   a distinctive sentinel message via the CHAT_COMPLETION_SETTINGS_READY
//   hook (the same surface real capsule injection uses) and then assert
//   the sentinel appears in BOTH the main agent's request body AND the
//   sub-agent's request body in mock.requests.

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
    sendMessageAndAwaitReply,
    installMinimalDirectorProfile,
} from '../_lib/page.js';

const CAPSULE_TEXT =
    '[Orchestration Capsule from prior turn]\n'
    + 'Established facts: the lantern flame is steady; the salt-mark drifters\' skiffs '
    + 'are visible at 3 leagues out, holding position; Ash has chosen to wait until dawn.\n'
    + 'Open threads: the courier from the northern garrison has not yet arrived.';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '74-capsule-inject' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#74 — Capsule injection', () => {
    test('injectCapsuleToPayload mutates payload regardless of caller; same call works for main + sub-agent payloads', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // The mutator is position-driven. Settings dictate where the
        // capsule lands. We exercise three documented positions (before /
        // after / atDepth) to prove the helper is robust to the three
        // shapes a payload may take.
        //
        // Internals note (verified against world-info.js):
        //   appendUniqueWorldInfoBlock(payload, 'worldInfoBefore', text)
        //   writes into `payload.worldInfoBeforeEntries[]`, NOT the
        //   `worldInfoBefore` string field. The string field is a legacy
        //   accumulator; the entries array is what the runtime reads.
        const results = await page.evaluate(async (capsuleText) => {
            const mod = await import('/scripts/extensions/orchestrator/capsule-injection.js');
            const inj = mod.injectCapsuleToPayload;

            const constants = Luker.getContext().constants;
            const wi = constants.wiPosition;
            const roles = constants.promptRoles;

            // Three independent payload "tasks" simulate: main agent and
            // two sub-agents each having their own draft of the OpenAI
            // chat-completion payload. The capsule injector mutates each
            // identically — there is no per-agent gating in the helper.
            const payloadMain = { worldInfoBefore: '', worldInfoAfter: '' };
            const payloadSub1 = { worldInfoBefore: '', worldInfoAfter: '' };
            const payloadSub2 = { worldInfoBefore: '', worldInfoAfter: '' };

            // (1) `before` position: stamps into worldInfoBeforeEntries[].
            const settingsBefore = {
                capsuleInjectPosition: wi.before,
                capsuleInjectDepth: 0,
                capsuleInjectRole: roles.SYSTEM,
            };
            const retMain = inj(payloadMain, capsuleText, settingsBefore);
            const retSub1 = inj(payloadSub1, capsuleText, settingsBefore);
            const retSub2 = inj(payloadSub2, capsuleText, settingsBefore);

            // (2) `atDepth` position: stamps into worldInfoDepth[].
            const payloadDepthMain = {};
            const payloadDepthSub = {};
            const settingsDepth = {
                capsuleInjectPosition: wi.atDepth,
                capsuleInjectDepth: 2,
                capsuleInjectRole: roles.SYSTEM,
            };
            inj(payloadDepthMain, capsuleText, settingsDepth);
            inj(payloadDepthSub, capsuleText, settingsDepth);

            // (3) Empty / whitespace capsule is a no-op — the helper
            //     returns false and leaves the payload untouched.
            const payloadNoop = { worldInfoBefore: '' };
            const noopReturn = inj(payloadNoop, '   ', settingsBefore);

            return {
                main: payloadMain,
                sub1: payloadSub1,
                sub2: payloadSub2,
                depthMain: payloadDepthMain,
                depthSub: payloadDepthSub,
                noopReturn,
                noopPayload: payloadNoop,
                wiBefore: wi.before,
                wiAtDepth: wi.atDepth,
                returns: { main: retMain, sub1: retSub1, sub2: retSub2 },
            };
        }, CAPSULE_TEXT);

        // (1) `before` position — all three payloads contain the capsule
        //     in worldInfoBeforeEntries. The relationship across main /
        //     sub1 / sub2 is the cross-agent capsule sharing the case demands.
        expect(results.returns.main).toBe(true);
        expect(results.returns.sub1).toBe(true);
        expect(results.returns.sub2).toBe(true);
        expect(Array.isArray(results.main.worldInfoBeforeEntries)).toBe(true);
        expect(results.main.worldInfoBeforeEntries).toContain(CAPSULE_TEXT);
        expect(results.sub1.worldInfoBeforeEntries).toContain(CAPSULE_TEXT);
        expect(results.sub2.worldInfoBeforeEntries).toContain(CAPSULE_TEXT);

        // All three got the SAME capsule text.
        expect(results.main.worldInfoBeforeEntries).toEqual(results.sub1.worldInfoBeforeEntries);
        expect(results.sub1.worldInfoBeforeEntries).toEqual(results.sub2.worldInfoBeforeEntries);

        // (2) `atDepth` position — both payloads carry the depth-anchored
        //     entry with the same depth / role.
        expect(Array.isArray(results.depthMain.worldInfoDepth)).toBe(true);
        expect(Array.isArray(results.depthSub.worldInfoDepth)).toBe(true);
        const mainDepth = results.depthMain.worldInfoDepth[0];
        const subDepth = results.depthSub.worldInfoDepth[0];
        expect(mainDepth.depth).toBe(2);
        expect(subDepth.depth).toBe(2);
        expect(mainDepth.entries).toContain(CAPSULE_TEXT);
        expect(subDepth.entries).toContain(CAPSULE_TEXT);

        // (3) Empty capsule is a no-op (no entries appended).
        expect(results.noopReturn).toBe(false);
        // worldInfoBeforeEntries should not have been created when the
        // injector early-returned on an empty input.
        expect(results.noopPayload.worldInfoBeforeEntries).toBeUndefined();
    });

    test('director run dispatches sub-agent and the capsule sentinel appears in BOTH main + sub-agent request payloads', async ({ page }) => {
        // We don't have a stored snapshot from a prior turn here (one
        // would require running an orchestration first), so we drive
        // the capsule-equivalent injection through the same hook the
        // production capsule injector uses:
        // CHAT_COMPLETION_SETTINGS_READY mutates the messages array of
        // the takeover payload before director captures it (see
        // script.js line 8473-8476 in the takeover branch). The
        // director runtime then propagates that same payload verbatim
        // into BOTH main agent taskMessages AND every dispatched
        // sub-agent's taskMessages, which is the contract under test.
        //
        // The sentinel is a magic substring chosen to be impossible to
        // appear by accident — assertions become trivial.
        const SENTINEL = '[CAPSULE-74-SENTINEL]';
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await installMinimalDirectorProfile(page, {
            mainSystemPrompt: 'Test director.',
            subAgents: [
                { id: 'scout', description: 'noop scout', systemPrompt: 'You are scout. Reply with one line.' },
            ],
        });

        // Wire the capsule injector. The hook runs once per takeover
        // dispatch — exactly the moment production capsule injection
        // also runs.
        await page.evaluate((sentinel) => {
            const ctx = Luker.getContext();
            // Idempotent installer — ignore if already attached from
            // an earlier test in this worker.
            if (window.__test74Hook) {
                ctx.eventSource.removeListener(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, window.__test74Hook);
            }
            const hook = (data) => {
                if (!data || !Array.isArray(data.messages)) return;
                data.messages.unshift({ role: 'system', content: sentinel });
            };
            window.__test74Hook = hook;
            ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, hook);
        }, SENTINEL);

        // Reset mock.requests so we count only this turn's traffic.
        const requestStartIdx = mock.requests.length;

        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role === 'director-main' && turn === 0) {
                    return { tool: 'dispatch_subagent', arguments: { subagentId: 'scout', task: 'one-line acknowledgment' } };
                }
                if (role === 'subagent') {
                    return { text: 'acknowledged.' };
                }
                if (role === 'director-main' && turn === 1) {
                    return { tool: 'await_subagents', arguments: { handles: ['subagent-0'] } };
                }
                if (role === 'director-main' && turn === 2) {
                    return { tool: 'write_message', arguments: { text: 'Test reply.', mode: 'replace' } };
                }
                if (role === 'director-main' && turn === 3) {
                    return { tool: 'finalize', arguments: {} };
                }
                return null;
            },
        });

        await sendMessageAndAwaitReply(
            page,
            '*She studies the chart.* "Any movement on the reef?"',
            { timeoutMs: 60_000 },
        );

        // Categorize the chat-completion requests since this turn began.
        const turnRequests = mock.requests.slice(requestStartIdx).filter(r => /chat\/completions/.test(r.url));
        const mainRequests = [];
        const subAgentRequests = [];
        for (const r of turnRequests) {
            const body = r.body || {};
            const msgs = Array.isArray(body.messages) ? body.messages : [];
            const toolDefs = Array.isArray(body.tools) ? body.tools : [];
            const toolNames = toolDefs.map(t => t?.function?.name || '');
            const sysContents = msgs
                .filter(m => m && m.role === 'system')
                .map(m => typeof m.content === 'string' ? m.content : '');
            const isSubagent = sysContents.some(c => c.includes('<orchestration_role>'));
            const isMain = !isSubagent && toolNames.some(n => ['write_message', 'finalize', 'dispatch_subagent'].includes(n));
            if (isMain) mainRequests.push(r);
            else if (isSubagent) subAgentRequests.push(r);
        }

        expect(mainRequests.length, 'at least one main-agent request fired').toBeGreaterThan(0);
        expect(subAgentRequests.length, 'at least one sub-agent request fired').toBeGreaterThan(0);

        const mainHasSentinel = mainRequests.every(r => JSON.stringify(r.body).includes(SENTINEL));
        const subHasSentinel = subAgentRequests.every(r => JSON.stringify(r.body).includes(SENTINEL));

        expect(mainHasSentinel, 'every main-agent request body contains the capsule sentinel').toBe(true);
        expect(subHasSentinel, 'every sub-agent request body contains the capsule sentinel').toBe(true);

        // Cleanup hook so subsequent tests aren't polluted.
        await page.evaluate(() => {
            const ctx = Luker.getContext();
            if (window.__test74Hook) {
                ctx.eventSource.removeListener(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, window.__test74Hook);
                window.__test74Hook = null;
            }
        });
    });
});
