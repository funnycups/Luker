// Case #68 — Run Panel: stream → final commit 1:1
//
// Spec:
//   - Open the run panel (auto-mounts on RUN_STARTED in production).
//   - Trigger a director-mode turn.
//   - Verify the panel auto-opens, sections appear (text + tool sections),
//     and after completion the final committed text in chat equals the
//     content the runner reports as `finalText`.
//
// What unlocked this:
//   The mock LLM's director-aware router (`scriptDirectorRun`) lets us
//   answer each director-main call with whatever sequence drives the
//   loop to a clean finalize. We stream text alongside the write_message
//   tool call so the panel's text section gets non-zero bytes (mock
//   supports both — see `_lib/mockLLM.js`#respondFromRouter).

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
    installMinimalDirectorProfile,
} from '../_lib/page.js';

const FINAL_REPLY =
    '*She does not look up from the chart, but her voice carries.* '
    + '"The reef has answered. Three hulls north. Wind\'s against them — they\'ll take an hour. We have that long, no more."';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({});
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
    test('run panel auto-opens on RUN_STARTED, accumulates section bytes, commits final 1:1 to chat bubble', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await installMinimalDirectorProfile(page);

        // Pre-clear any stale RunStateStore from a prior run.
        await page.evaluate(async () => {
            try {
                const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
                m.clearCurrentRun?.();
            } catch { /* not loaded */ }
        });

        // Drive the director: emit a brief planning note alongside the
        // write_message call so the panel's TEXT section accumulates
        // bytes (assistantText flows into the panel's `text` section via
        // the no-chunk fallback in director-runtime.js). Then finalize.
        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role === 'director-main' && turn === 0) {
                    return {
                        text: 'Drafting the reply now.',
                        tool: 'write_message',
                        arguments: { text: FINAL_REPLY, mode: 'replace' },
                    };
                }
                if (role === 'director-main' && turn === 1) {
                    return { tool: 'finalize', arguments: {} };
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
        }, '*She steps to the rail, lantern raised against the salt-spray.* "What did the courier see?"');

        // Panel auto-opens on RUN_STARTED.
        const panel = page.locator('#luker-orch-run-panel');
        await expect(panel).toHaveAttribute('data-state', 'open', { timeout: 30_000 });

        // At least one section <pre> should accumulate bytes. With our
        // router emitting text alongside write_message, the round's
        // `text` section gets the announcement string.
        await expect.poll(async () => {
            const lens = await panel.locator('.section pre').evaluateAll(
                els => els.map(e => (e.textContent || '').length),
            );
            return lens.reduce((s, n) => s + n, 0);
        }, { timeout: 30_000 }).toBeGreaterThan(0);

        // Wait for the runner to settle into a terminal state.
        const finalState = await page.evaluate(async () => {
            const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
            const settled = new Set(['committed', 'aborted', 'error']);
            const deadline = 60_000;
            const start = Date.now();
            while (Date.now() - start < deadline) {
                const s = m.getCurrentRun();
                if (s && settled.has(String(s.status || ''))) {
                    return JSON.parse(JSON.stringify(s, (k, v) => (k === 'abortFn' ? undefined : v)));
                }
                await new Promise(r => setTimeout(r, 200));
            }
            return null;
        });

        expect(finalState).toBeTruthy();
        expect(finalState.status).toBe('committed');
        expect(typeof finalState.finalText).toBe('string');
        expect(finalState.finalText.length).toBeGreaterThan(0);

        // Last chat bubble's raw `mes` text must equal the committed
        // finalText byte-for-byte. We compare against the chat array
        // entry (not the rendered DOM .mes_text) because the renderer
        // strips markdown asterisks while displaying — the 1:1
        // contract is about what got persisted, not the rendered form.
        const lastMes = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            const chat = ctx.chat || [];
            for (let i = chat.length - 1; i >= 0; i--) {
                if (!chat[i]?.is_user) return chat[i]?.mes || '';
            }
            return '';
        });
        expect(lastMes.trim()).toBe(String(finalState.finalText).trim());
        expect(lastMes.trim()).toBe(FINAL_REPLY.trim());
    });
});
