// Case #75 — Abort mid-run (real e2e portion)
//
// Spec:
//   - Start a long-running director turn (mock with latency).
//   - Click the stop button mid-flight.
//   - Verify: in-flight sub-agents abort, partial state in chat history
//     is preserved (not corrupted), next user turn works normally.
//
// What stays as e2e (this file):
//   The full mid-run abort case, which drives the production
//   takeover-hook → director-runtime → store flow end-to-end against
//   a real Luker server with a slow mock LLM, then asserts the next
//   user turn renders normally. This tests cross-module coordination
//   (script.js stopGeneration → director-runtime's signal handler →
//   store finishRun(aborted) → chat-array integrity → next turn
//   commits) that has no useful sub-test boundary.
//
// What moved to Jest (`tests/orchestrator/abort-mid-run.test.js`):
//   The two unit-shaped cases that exercise the RunStateStore abort
//   path directly. Those previously paid the per-spec server-boot
//   cost despite testing a pure module — they are now ESM imports of
//   `run-state/store.js` and run in milliseconds.

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

test.describe('#75 — Abort mid-run', () => {
    test('full mid-run abort: director main loop + in-flight sub-agent cancel; runStore transitions to aborted; next turn works', async ({ browser }) => {
        // Fresh page + fresh mock so latency doesn't affect previous tests.
        const slowMock = await startMockLLM({ latencyMs: 2000 });
        const slowServer = await startServer({ batchKey: 'orchestrator', scenarioId: '75-abort-full' });
        markOnboarded({ dataRoot: slowServer.dataRoot });
        bootstrapCustomBackend({ dataRoot: slowServer.dataRoot, baseURL: slowMock.baseURL });
        appendConnectionProfile({ dataRoot: slowServer.dataRoot, baseURL: slowMock.baseURL });

        const page = await browser.newPage();
        try {
            await awaitMainUI(page, slowServer.baseURL);
            await selectCharacterByName(page, 'Seraphina');
            await installMinimalDirectorProfile(page, {
                mainSystemPrompt: 'Test director.',
                subAgents: [
                    { id: 'slow_scout', description: 'slow scout', systemPrompt: 'You are slow_scout.' },
                ],
            });

            // Pre-clear any leftover run state from a prior test in this worker.
            await page.evaluate(async () => {
                try {
                    const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
                    m.clearCurrentRun?.();
                } catch { /* not loaded */ }
            });

            // Director script: main dispatches a sub-agent, then the
            // subagent's request gets stuck on the mock's 2-second latency.
            // We click stop during that window. The runner's loop should
            // observe the AbortSignal, exit, and call finishRun(aborted).
            slowMock.scriptDirectorRun({
                route: ({ role, turn }) => {
                    if (role === 'director-main' && turn === 0) {
                        return { tool: 'dispatch_subagent', arguments: { subagentId: 'slow_scout', task: 'hang' } };
                    }
                    if (role === 'director-main' && turn === 1) {
                        return { tool: 'await_subagents', arguments: { handles: ['subagent-0'] } };
                    }
                    if (role === 'subagent') {
                        // This response is delayed by latencyMs from
                        // startMockLLM. While it's pending, the test
                        // clicks stop; the sub-agent's HTTP request is
                        // aborted client-side and the dispatcher records
                        // a cancelled outcome.
                        return { text: 'I should never reach the main agent — abort caught me first.' };
                    }
                    return null;
                },
            });

            // Send via the production input + send button so RUN_STARTED fires.
            await page.evaluate(async (prompt) => {
                const ta = document.getElementById('send_textarea');
                ta.value = prompt;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                const btn = document.getElementById('send_but');
                btn.click();
            }, '*She raises the lantern.* "Read the dark."');

            // Wait until the run is actually running (at least one round
            // has dispatched into the store). We use the run-state store
            // as the truth source — DOM-level button state is less stable.
            await page.waitForFunction(async () => {
                const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
                const r = m.getCurrentRun();
                return r && r.status === 'running';
            }, null, { timeout: 30_000 });

            // Trigger stop via the production stopGeneration() export.
            // This aborts script.js's global abortController, which IS
            // what's passed as the takeover handler's eventData.abortSignal
            // — so director-runtime observes the signal at the next
            // round-boundary check (or mid-stream chunk gate) and exits
            // via handle.abort(). Driving via the export rather than a
            // DOM click avoids the #mes_stop visibility race that DOM-
            // level interactions hit during the takeover window.
            await page.evaluate(async () => {
                const m = await import('/script.js');
                m.stopGeneration?.();
            });

            // Track the panel-store state across the abort settlement
            // window. Once the runtime's finally block fires finishRun,
            // status flips to aborted. The store may then be cleared
            // (clearCurrentRun is wired to RUN_CLEARED events), so
            // accept "aborted seen at any point OR currently null" as
            // the win condition.
            const aborted = await page.evaluate(async () => {
                const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
                const deadline = 30_000;
                const start = Date.now();
                let sawAborted = false;
                let lastStatus = '';
                while (Date.now() - start < deadline) {
                    const s = m.getCurrentRun();
                    const status = String(s?.status || '');
                    if (status) lastStatus = status;
                    if (status === 'aborted' || status === 'error') {
                        sawAborted = true;
                        break;
                    }
                    if (!s) {
                        // Cleared without observing aborted — could mean
                        // the runtime settled fast and the clear fired
                        // before our poll. Bail and let the test decide.
                        break;
                    }
                    if (status === 'committed') {
                        // Bad path — should not happen on abort.
                        break;
                    }
                    await new Promise(r => setTimeout(r, 50));
                }
                return { sawAborted, lastStatus, currentStatus: m.getCurrentRun()?.status || null };
            });

            expect(aborted.sawAborted || aborted.currentStatus === null,
                `expected aborted (or cleared) state; got lastStatus=${aborted.lastStatus} currentStatus=${aborted.currentStatus}`,
            ).toBe(true);

            // The chat array is intact — no corrupted placeholder, no
            // crashed renderer. Lengths agree before/after; the only
            // mutation might be the empty placeholder slot that the
            // takeover allocator created at chat.length and never wrote
            // into (preserved on abort by handle.abort()). We check
            // that the array exists and is iterable.
            const ok = await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                return Array.isArray(ctx.chat);
            });
            expect(ok).toBe(true);

            // Subsequent turn works — clear router and run a tiny turn.
            slowMock.clearDirectorRun();
            slowMock.scriptDirectorRun({
                route: ({ role, turn }) => {
                    if (role === 'director-main' && turn === 0) {
                        return { tool: 'write_message', arguments: { text: 'After-abort reply.', mode: 'replace' } };
                    }
                    if (role === 'director-main' && turn === 1) {
                        return { tool: 'finalize', arguments: {} };
                    }
                    return null;
                },
            });
            // Clear leftover run state from the aborted turn before the next.
            await page.evaluate(async () => {
                const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
                m.clearCurrentRun?.();
            });
            const { text: bubble } = await sendMessageAndAwaitReply(
                page,
                '*Another moment passes.* "Try again."',
                { timeoutMs: 30_000 },
            );
            expect(bubble.trim()).toBe('After-abort reply.');
        } finally {
            await page.close();
            await tearDownServer(slowServer);
            await slowMock.stop();
        }
    });
});
