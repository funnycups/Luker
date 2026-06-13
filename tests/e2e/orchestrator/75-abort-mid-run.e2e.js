// Case #75 — Abort mid-run
//
// Spec:
//   - Start a long-running director turn (mock with latency).
//   - Click the stop button mid-flight.
//   - Verify: in-flight sub-agents abort, partial state in chat history
//     is preserved (not corrupted), next user turn works normally.
//
// Approach:
//   We exercise the RunStateStore abort path directly, since the user-
//   visible stop button drives the runner's abortFn. This gives us:
//     (a) `startRun` registers an abortFn (callable on stop)
//     (b) `finishRun({ status: 'aborted' })` updates the store
//     (c) `clearCurrentRun` puts the store back to a usable state for
//         the next turn
//
//   Driving the full director-mid-run flow needs the same mock-LLM-tool-
//   calls infrastructure the other director tests need (fixme).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*ack*'] });
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '75-abort' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#75 — Abort mid-run', () => {
    test('RunStateStore abort path: startRun → user stop → finishRun(aborted) → clearCurrentRun → next run starts', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const result = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/run-state/store.js');

            // Make sure no prior run is lingering.
            mod.clearCurrentRun();

            // Simulate a runner: it registers an abortFn the user clicks
            // to stop the in-flight loop.
            let abortCalled = false;
            const runId = mod.startRun({
                mode: 'director',
                chatKey: 'char:test.png:scenario-75',
                abortFn: () => { abortCalled = true; },
            });

            const running = mod.getCurrentRun();
            const startedStatus = running.status;

            // User clicks stop. In production, the stop button invokes
            // currentRun.abortFn(). We simulate that:
            const stopReturn = running.abortFn?.();
            // ...and the runner's exception handler eventually calls finishRun
            // with status='aborted'.
            mod.finishRun({
                runId,
                status: 'aborted',
                finalText: null,
                error: null,
            });

            const stopped = mod.getCurrentRun();
            const stoppedStatus = stopped?.status;

            // Clean up for next user turn (production does this on
            // RUN_CLEARED — the panel listens for it).
            mod.clearCurrentRun();
            const cleared = mod.getCurrentRun();

            // Start a fresh run, which would throw if abort hadn't fully
            // cleared the singleton.
            const nextRunId = mod.startRun({
                mode: 'director',
                chatKey: 'char:test.png:scenario-75',
                abortFn: null,
            });
            const nextRunStatus = mod.getCurrentRun()?.status;
            mod.clearCurrentRun();

            return {
                abortCalled,
                startedStatus,
                stoppedStatus,
                cleared,
                nextRunId,
                nextRunStatus,
            };
        });

        // The abortFn was invoked (proving the wiring).
        expect(result.abortCalled).toBe(true);
        // The run transitioned through running → aborted.
        expect(result.startedStatus).toBe('running');
        expect(result.stoppedStatus).toBe('aborted');
        // After clear, getCurrentRun returns null.
        expect(result.cleared).toBeNull();
        // A fresh run starts cleanly.
        expect(typeof result.nextRunId).toBe('string');
        expect(result.nextRunStatus).toBe('running');
    });

    test('chat history is unaffected by an aborted run (the chat array is not corrupted)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Capture the chat state before any orchestration runs, abort a
        // run, and verify the chat array is still parseable + same length.
        const result = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/run-state/store.js');
            const ctx = window.SillyTavern.getContext();

            const chatBefore = Array.isArray(ctx.chat) ? ctx.chat.length : 0;

            // Open a run and abort it without committing anything.
            mod.clearCurrentRun();
            const runId = mod.startRun({
                mode: 'loop',
                chatKey: 'char:test.png:scenario-75-chat',
                abortFn: () => {},
            });
            mod.finishRun({ runId, status: 'aborted', finalText: null });
            mod.clearCurrentRun();

            const chatAfter = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
            return { chatBefore, chatAfter };
        });

        // The chat array is not mutated by the abort path.
        expect(result.chatAfter).toBe(result.chatBefore);
    });

    test.fixme('full mid-run abort: director main loop + 2 in-flight sub-agents all cancel; chat bubble shows partial', async () => {
        // Requires a real director dispatch with mock-tool-calls + latency
        // injection in the mock LLM, plus a way to click the actual stop
        // button while sub-agent requests are in flight. Blocked by the
        // director-runtime test infrastructure gap.
    });
});
