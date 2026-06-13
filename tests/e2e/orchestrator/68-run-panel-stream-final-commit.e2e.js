// Case #68 — Run Panel: stream → final commit 1:1
//
// Spec:
//   - Open the run panel (auto-mounts on RUN_STARTED in production).
//   - Trigger a director-mode turn.
//   - Verify the panel auto-opens, sections appear (streaming progress),
//     and after completion the final committed text in chat equals the
//     content visible in the panel's final-output section.
//   - Expand each step → raw content visible exactly as model produced.
//
// As with #67, the director runtime requires real tool_calls to commit,
// so this test is marked fixme — the contract test is genuinely
// interesting but it would need either a more sophisticated mock LLM
// (one that responds to tool_call protocol) or a real LLM.

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
} from '../_lib/page.js';

const FINAL_REPLY =
    '*She does not look up from the chart, but her voice carries.* '
    + '"The reef has answered. Three hulls north. Wind\'s against them — they\'ll take an hour. We have that long, no more."';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [FINAL_REPLY, FINAL_REPLY, FINAL_REPLY, FINAL_REPLY, FINAL_REPLY],
    });
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '68-run-panel-stream' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#68 — Run Panel: stream → final commit 1:1', () => {
    test.fixme('run panel auto-opens on RUN_STARTED, streams content, commits final 1:1 to chat bubble', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            const s = ctx.extensionSettings?.orchestrator;
            s.enabled = true;
            s.executionMode = 'director';
            ctx.saveSettingsDebounced?.();
        });

        // Pre-clear any stale RunStateStore from a prior run.
        await page.evaluate(async () => {
            try {
                const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
                m.clearCurrentRun?.();
            } catch { /* not loaded */ }
        });

        // Send via the production input + send button so RUN_STARTED fires.
        await page.evaluate(async (prompt) => {
            const ta = document.getElementById('send_textarea');
            ta.value = prompt;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            const btn = document.getElementById('send_but');
            btn.click();
        }, '*She steps to the rail, lantern raised against the salt-spray.* "What did the courier see?"');

        // Panel auto-opens on RUN_STARTED. Timeout is generous since the
        // mock backend is fast but director startup has its own latency.
        const panel = page.locator('#luker-orch-run-panel');
        await expect(panel).toHaveAttribute('data-state', 'open', { timeout: 30_000 });

        // At least one section <pre> should accumulate streamed bytes.
        await expect.poll(async () => {
            const lens = await panel.locator('.section pre').evaluateAll(
                els => els.map(e => (e.textContent || '').length),
            );
            return lens.reduce((s, n) => s + n, 0);
        }, { timeout: 60_000 }).toBeGreaterThan(0);

        // Wait for the runner to settle into a terminal state.
        const finalState = await page.evaluate(async () => {
            const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
            const settled = new Set(['committed', 'aborted', 'error']);
            const deadline = 300_000;
            const start = Date.now();
            while (Date.now() - start < deadline) {
                const s = m.getCurrentRun();
                if (s && settled.has(String(s.status || ''))) {
                    return JSON.parse(JSON.stringify(s, (k, v) => (k === 'abortFn' ? undefined : v)));
                }
                await new Promise(r => setTimeout(r, 500));
            }
            return null;
        });

        expect(finalState).toBeTruthy();
        expect(finalState.status).toBe('committed');
        expect(typeof finalState.finalText).toBe('string');
        expect(finalState.finalText.length).toBeGreaterThan(0);

        // Last chat bubble's visible text must equal the committed finalText.
        const lastBubble = page.locator('#chat .mes').last();
        const bubbleText = (await lastBubble.locator('.mes_text').innerText()).trim();
        expect(bubbleText).toBe(String(finalState.finalText).trim());
        expect(bubbleText).toBe(FINAL_REPLY.trim());
    });
});
