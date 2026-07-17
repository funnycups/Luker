// Case #81 — Dispatch barrier: cache-warmup serialization on concurrent sub-agent fan-out
//
// Spec:
//   The director main-agent sometimes emits multiple `dispatch_subagent`
//   tool calls in a single assistant turn (director-runtime.js runs them
//   as fire-and-forget IIFEs, so all N LLM requests fly concurrently).
//   When those sub-agents share the same resolved connection profile,
//   racing them cold against the provider forces the provider to write
//   N independent prompt-cache entries — burning the per-minute input-
//   token budget on redundant writes and producing back-to-back
//   cache-miss requests instead of one cache-write + N-1 cache-reads.
//
//   The dispatch barrier (dispatch-barrier.js, integrated in
//   director-tools.js runDispatchInternal) serializes the FIRST-CHUNK
//   moment across sibling dispatches sharing a barrier key: the first
//   arrival becomes lead and streams normally; followers await the
//   lead's first upstream chunk before firing their own request. Once
//   the lead's response has begun streaming, the provider has committed
//   to processing and its cache slot is populated, so followers hit
//   cache-read.
//
// What this e2e verifies:
//   (a) Barrier ACTIVE (all sub-agents share apiPresetName='e2e-mock'):
//       followers arrive at the mock only AFTER the lead's first byte —
//       we set the mock to a 300ms first-byte latency and assert
//       follower `receivedAt` timestamps land ~300ms after the lead's.
//   (b) Barrier BYPASSED (sub-agents leave apiPresetName='' — the empty
//       key is the opt-out per dispatch-barrier.js contract): the same
//       fan-out with the same latency has all three requests arriving
//       within a few ms of each other (they weren't serialized).
//
// The two cases together prove the timing difference is caused by the
// barrier, not by network / server / director-runtime plumbing. If the
// barrier were disabled, both cases would look like (b).

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

// Three timing thresholds pin down what "barrier engaged" vs "barrier
// bypassed" looks like on the mock. They are NOT independent —
// correctness requires:
//
//   BYPASSED_MAX_SPREAD_MS  <  ENGAGED_MIN_LEAD_TO_FOLLOWER_MS  <  LATENCY_MS
//
// Concretely: LATENCY_MS is the mock's first-byte delay. When the
// barrier is engaged, followers must wait at least ~LATENCY_MS after
// the lead's arrival — we require ENGAGED_MIN below LATENCY_MS to
// absorb jitter, and well above BYPASSED_MAX so a bypassed run cannot
// accidentally cross the engaged threshold. When bypassed, three
// fire-and-forget IIFEs arrive within a few ms on local loopback;
// BYPASSED_MAX gives ~10x slack for CI. Any triple satisfying the
// inequality with comfortable margins works; the specific numbers
// below are one such point (loopback ≪ 100ms ≪ 200ms ≪ 300ms).

// First-byte latency the mock applies BEFORE writing any response byte
// (see mockLLM.js: `if (latencyMs > 0) await new Promise(...)` sits
// between the request-arrival push and the response handler, so the
// FIRST byte to leave the mock lands at receivedAt + LATENCY_MS).
const LATENCY_MS = 300;

// Minimum gap we require between the lead's arrival and a follower's
// arrival to call the barrier "engaged". Sits between BYPASSED_MAX
// and LATENCY_MS per the inequality above.
const ENGAGED_MIN_LEAD_TO_FOLLOWER_MS = 200;

// Maximum spread we tolerate across three fan-out arrivals when the
// barrier is BYPASSED. Must stay well below ENGAGED_MIN so an engaged
// run cannot mimic a bypassed one under adverse jitter.
const BYPASSED_MAX_SPREAD_MS = 100;

let server, mock;

test.beforeAll(async () => {
    // Streaming-capable mock with a first-byte latency so we can
    // measure follower-request timing relative to lead first-byte.
    mock = await startMockLLM({ latencyMs: LATENCY_MS });
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '81-dispatch-barrier' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    // The connection profile name here is the barrier key that sub-
    // agents must set apiPresetName to (in the ACTIVE test). Default
    // profile name is 'e2e-mock' (see fixtures.js:150).
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Drive one director turn that fan-outs three sub-agents in a single
 * main-agent tool round, then awaits them and finalizes. Returns the
 * three sub-agent request records observed at the mock.
 */
async function runFanOutTurn(page, { agentApiPresetName }) {
    await selectCharacterByName(page, 'Seraphina');

    // Three sub-agents; whether apiPresetName is populated is the
    // independent variable across the two sub-tests.
    //
    // promptPresetName is pinned to the built-in "Default" chat-
    // completion preset because its body has `stream_openai: true`.
    // The alternative (leaving it blank) causes director-preset-swap
    // to substitute `orchestrator:director-pure`, whose body has
    // `stream_openai: false` (pure-preset-body.js:65 — deliberate
    // for real workloads: sub-agents don't need UI streaming). The
    // barrier is gated on the resolved preset's stream flag; with a
    // non-streaming preset it opts out (there's no first-chunk
    // signal to wait on), which is CORRECT for real workloads but
    // makes this test trivially "pass" without exercising the
    // barrier. Real users hit the barrier when their custom
    // `promptPresetName` targets a streaming preset — the common
    // case for chat-completion presets.
    await installMinimalDirectorProfile(page, {
        mainSystemPrompt: 'Test director for barrier e2e.',
        subAgents: [
            { id: 'sib_a', description: 'sibling a', systemPrompt: 'You are sib_a.', apiPresetName: agentApiPresetName, promptPresetName: 'Default' },
            { id: 'sib_b', description: 'sibling b', systemPrompt: 'You are sib_b.', apiPresetName: agentApiPresetName, promptPresetName: 'Default' },
            { id: 'sib_c', description: 'sibling c', systemPrompt: 'You are sib_c.', apiPresetName: agentApiPresetName, promptPresetName: 'Default' },
        ],
    });

    // Ensure streaming is enabled at runtime. `bootstrapCustomBackend`
    // wrote `stream_openai: true` to settings.json, but the live
    // `oai_settings` singleton gets reset by
    // `installMinimalDirectorProfile`'s `saveSettings({directSave})`
    // call (which round-trips through the server and re-applies the
    // persisted body). Force streaming back on AFTER profile install
    // so `isStreamingPresetEnabled('')` — the fallback path the
    // barrier reads when the sub-agent's `llmPresetName` is empty —
    // returns true. Without this the barrier detects
    // "non-streaming preset" and opts out; the ACTIVE sub-test would
    // pass trivially with `streamEnabled=false, barrierKey=''` and
    // hide any barrier regressions.
    await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        if (ctx?.chatCompletionSettings) ctx.chatCompletionSettings.stream_openai = true;
    });

    // Clear any leftover run state from a prior sub-test.
    await page.evaluate(async () => {
        try {
            const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
            m.clearCurrentRun?.();
        } catch { /* not loaded yet */ }
    });

    // Router: turn 0 fan-out three dispatches in one round; turn 1
    // awaits; turn 2 writes; turn 3 finalizes. Each sub-agent responds
    // with a one-line ack (no tool calls — that terminates the sub-
    // agent's own loop and returns text via await_subagents).
    //
    // scriptDirectorRun's route signature returns EITHER a single
    // tool object `{ tool, arguments }` OR an object with a
    // `toolCalls` array for multi-tool rounds (mockLLM.js#normalizeToolCalls).
    // We use the latter for turn 0 so all three dispatches are issued
    // in the SAME assistant turn — which is the case director-runtime.js
    // runs concurrently as fire-and-forget IIFEs (the exact behavior
    // the barrier targets).
    mock.scriptDirectorRun({
        route: ({ role, turn }) => {
            if (role === 'director-main' && turn === 0) {
                return {
                    toolCalls: [
                        { name: 'dispatch_subagent', arguments: { subagentId: 'sib_a', task: 'ack' } },
                        { name: 'dispatch_subagent', arguments: { subagentId: 'sib_b', task: 'ack' } },
                        { name: 'dispatch_subagent', arguments: { subagentId: 'sib_c', task: 'ack' } },
                    ],
                };
            }
            if (role === 'director-main' && turn === 1) {
                return { tool: 'await_subagents', arguments: { handles: ['subagent-0', 'subagent-1', 'subagent-2'] } };
            }
            if (role === 'director-main' && turn === 2) {
                return { tool: 'write_message', arguments: { text: 'Done.', mode: 'replace' } };
            }
            if (role === 'director-main' && turn === 3) {
                return { tool: 'finalize', arguments: {} };
            }
            if (role === 'subagent') {
                return { text: 'acknowledged.' };
            }
            return null;
        },
    });

    const startIdx = mock.requests.length;

    // Guard against the director-preset-swap "unsaved changes" popup
    // (director-preset-swap.js:141). When the takeover fires and the
    // active openai preset has any diff vs its persisted body, the
    // popup opens and blocks Generate. We auto-click "Discard and
    // continue" — the test's mock backend doesn't care about
    // persisted preset bodies, and picking Discard avoids side-
    // effect writes to the fixture dataRoot. Idempotent: the poll
    // exits either on click success or on generation completion.
    const popupDismisser = (async () => {
        for (let i = 0; i < 300; i++) {
            const btn = page.locator('dialog.popup .popup-button-cancel:visible').last();
            try {
                if (await btn.isVisible({ timeout: 100 })) {
                    await btn.click({ timeout: 500 });
                    return;
                }
            } catch { /* no popup this tick */ }
            await new Promise(r => setTimeout(r, 100));
        }
    })();

    await sendMessageAndAwaitReply(
        page,
        `barrier check ${agentApiPresetName ? 'engaged' : 'bypassed'}`,
        { timeoutMs: 60_000 },
    );
    void popupDismisser; // fire-and-forget; the polling window is bounded

    // Filter to sub-agent requests only. Sub-agent fingerprint = system
    // messages contain <orchestration_role>...</orchestration_role>
    // wrapping the agent's systemPrompt; main-agent requests have the
    // main-only tools (write_message / finalize / dispatch_subagent)
    // in their tools array. See mockLLM.js#classifyRequest for the
    // canonical detection.
    const turnRequests = mock.requests.slice(startIdx).filter(r => /chat\/completions/.test(r.url));
    const subAgentRequests = turnRequests.filter(r => {
        const msgs = Array.isArray(r.body?.messages) ? r.body.messages : [];
        return msgs.some(m => m?.role === 'system' && typeof m.content === 'string' && m.content.includes('<orchestration_role>'));
    });

    // Extract sib_a / sib_b / sib_c specifically — the ONLY three
    // requests we care about for timing. The main agent's requests
    // and any post-fanout sub-agent activity (which shouldn't happen
    // in this scenario since sub-agents ack + terminate immediately)
    // are excluded.
    //
    // Note: multiple system messages may contain the literal string
    // "<orchestration_role>" — the runtime's META_FRAME references
    // the tag by name ("Your identity is defined inside
    // <orchestration_role>") without wrapping any body in it. We
    // want the message that ACTUALLY wraps the systemPrompt, which
    // is a short standalone message of the form
    // "<orchestration_role>\n<systemPrompt>\n</orchestration_role>"
    // (see director-tools.js#runDispatchInternal). Match on the
    // opening tag as the first token so we skip META_FRAME.
    const ROLE_WRAPPER_RE = /^<orchestration_role>\s*([\s\S]*?)\s*<\/orchestration_role>$/;
    const bySib = { sib_a: null, sib_b: null, sib_c: null };
    for (const r of subAgentRequests) {
        const wrapper = r.body.messages.find(m =>
            m?.role === 'system'
            && typeof m.content === 'string'
            && ROLE_WRAPPER_RE.test(m.content.trim()),
        );
        if (!wrapper) continue;
        const body = ROLE_WRAPPER_RE.exec(wrapper.content.trim())?.[1] || '';
        for (const sib of Object.keys(bySib)) {
            if (body.includes(`You are ${sib}.`) && bySib[sib] === null) {
                bySib[sib] = r;
            }
        }
    }

    return bySib;
}

test.describe('#81 — Dispatch barrier serializes concurrent same-profile sub-agents', () => {
    test('barrier ACTIVE: three sub-agents on same apiPresetName arrive at the mock serialized on first-byte', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const bySib = await runFanOutTurn(page, { agentApiPresetName: 'e2e-mock' });

        expect(bySib.sib_a, 'sib_a request captured').toBeTruthy();
        expect(bySib.sib_b, 'sib_b request captured').toBeTruthy();
        expect(bySib.sib_c, 'sib_c request captured').toBeTruthy();

        // Order arrivals in chronological order (director's dispatch
        // for-loop is synchronous, but which sub-agent wins the barrier
        // "lead" slot is a race between three fire-and-forget IIFEs —
        // we don't hardcode which sibling leads, only that the OTHER
        // two follow the lead).
        const arrivals = [bySib.sib_a, bySib.sib_b, bySib.sib_c].sort((a, b) => a.receivedAt - b.receivedAt);
        const lead = arrivals[0];
        const follower1 = arrivals[1];
        const follower2 = arrivals[2];

        // Barrier contract: followers may only fire AFTER the lead's
        // first upstream chunk. Mock's first byte is delayed by
        // LATENCY_MS from the lead's `receivedAt`, so followers'
        // `receivedAt` must be at least ~LATENCY_MS after the lead's.
        const gap1 = follower1.receivedAt - lead.receivedAt;
        const gap2 = follower2.receivedAt - lead.receivedAt;
        expect(gap1, `follower1 must arrive after lead's first byte (LATENCY_MS=${LATENCY_MS}); observed gap ${gap1}ms`).toBeGreaterThanOrEqual(ENGAGED_MIN_LEAD_TO_FOLLOWER_MS);
        expect(gap2, `follower2 must arrive after lead's first byte (LATENCY_MS=${LATENCY_MS}); observed gap ${gap2}ms`).toBeGreaterThanOrEqual(ENGAGED_MIN_LEAD_TO_FOLLOWER_MS);

        // Sanity: lead's first byte was actually delayed (guards
        // against the mock's latency knob silently breaking, which
        // would erase our discriminator between engaged and bypassed).
        expect(lead.firstByteAt).not.toBeNull();
        const leadWait = lead.firstByteAt - lead.receivedAt;
        expect(leadWait, `mock latency knob is applying ~${LATENCY_MS}ms; observed ${leadWait}ms`).toBeGreaterThanOrEqual(LATENCY_MS - 50);
    });

    test('barrier BYPASSED: three sub-agents on empty apiPresetName arrive at the mock concurrently', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Empty apiPresetName = falsy barrier key = opt-out (see
        // dispatch-barrier.js#acquire). Every dispatch becomes a solo
        // lead; the three fire-and-forget IIFEs from director-runtime's
        // for-loop should all reach the mock within a few ms.
        const bySib = await runFanOutTurn(page, { agentApiPresetName: '' });

        expect(bySib.sib_a, 'sib_a request captured').toBeTruthy();
        expect(bySib.sib_b, 'sib_b request captured').toBeTruthy();
        expect(bySib.sib_c, 'sib_c request captured').toBeTruthy();

        const arrivals = [bySib.sib_a, bySib.sib_b, bySib.sib_c].map(r => r.receivedAt).sort((a, b) => a - b);
        const spread = arrivals[2] - arrivals[0];
        expect(spread, `all three sub-agent requests should arrive within ${BYPASSED_MAX_SPREAD_MS}ms of each other (barrier bypassed); observed spread ${spread}ms across ${JSON.stringify(arrivals)}`).toBeLessThanOrEqual(BYPASSED_MAX_SPREAD_MS);
    });
});
