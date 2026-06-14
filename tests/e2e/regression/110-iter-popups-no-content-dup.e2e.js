// #110 — iter-popups don't copy world-info / sibling prompts (commit 3de0c3ecc)
//
// Bug shape: iter-studio sub-agents (the LLM session that authors /
// edits an orchestration profile) used to transcribe the bound world-
// info entries and other sub-agents' systemPrompts into the agent they
// were writing — verbatim, swelling each sub-agent prompt with content
// the runtime already injects, drifting on edits, and crowding the
// agent's own instructions.
//
// Fix: `buildNoContentDuplicationHint()` is appended to every iter-studio
// system prompt via `appendScopeHintIfNeeded`. The text explicitly
// instructs the model not to paste lorebook entries' bodies, sibling /
// sub-agent prompts, character descriptions, or preset content into
// the agent's systemPrompt — reference by name + uid only.
//
// Regression lock: open the iter-studio popup, send one composer message,
// intercept the mock LLM request, assert the system prompt carries the
// dedup section header `# No content duplication`. If a refactor strips
// the hint, the test fails loudly. (We deliberately check only the
// section header — not specific phrasing — so wordsmithing the body is
// not blocked.)

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook, BRYN_ENTRIES } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        // The iter-studio LLM round just needs a reply — the dedup hint
        // lives in the OUTBOUND system prompt, so we only need to
        // close the loop.
        scriptedReplies: [
            'Acknowledged — no profile changes needed; the runtime already injects lorebook entries and sibling agents own their own prompts.',
        ],
    });
    server = await startServer({ batchKey: 'regression', scenarioId: 'iter-popup-nodup' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // A world book — to give the LLM real lorebook content to potentially
    // transcribe, the kind the hint is supposed to suppress.
    writeWorldBook({
        dataRoot: server.dataRoot,
        name: 'regression-110-bryn',
        entries: BRYN_ENTRIES,
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#110 — iter-popups carry the no-content-duplication hint', () => {
    test('iter-studio system prompt instructs the LLM not to copy WI / sibling prompts', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Open the orchestrator extensions panel + the inline drawer that
        // hosts the "Open AI Iteration Studio" buttons. We use director
        // mode since that's the canonical multi-agent scope where the
        // dedup hint matters most.
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            // Force director mode so the studio opens in the director
            // adapter (the hint applies to all modes, but director is
            // the one with sub-agents).
            const settings = ctx.extensionSettings.orchestrator;
            settings.executionMode = 'director';
            settings.enabled = true;
        });

        // Open the studio popup directly via the orchestrator's exposed
        // action — same code path as clicking the "Open AI Iteration
        // Studio" menu button, but driven from the page without depending
        // on the extensions drawer being expanded.
        const beforeRequests = mock.requests.length;
        const opened = await page.evaluate(async () => {
            // Find any visible AI iteration trigger and click it. Falls
            // back to dispatching the action by hand via the panel root.
            const triggers = Array.from(document.querySelectorAll('[data-luker-action="ai-iterate-open"]'));
            const visible = triggers.find(el => el.offsetParent !== null) || triggers[0];
            if (visible) {
                visible.click();
                return 'clicked';
            }
            return 'no-trigger';
        });

        // If no trigger was found we'd be stuck — but the orchestrator
        // settings panel renders these buttons inline-drawer hidden by
        // default. As a fallback, render the panel programmatically.
        if (opened === 'no-trigger') {
            await page.evaluate(() => {
                // Try expanding the orchestrator settings inline drawer.
                const drawer = document.querySelector('#orchestrator_settings .inline-drawer-toggle');
                if (drawer) drawer.click();
            });
            await page.waitForTimeout(500);
            await page.evaluate(() => {
                const triggers = Array.from(document.querySelectorAll('[data-luker-action="ai-iterate-open"]'));
                const visible = triggers.find(el => el.offsetParent !== null) || triggers[0];
                if (visible) visible.click();
            });
        }

        // The iter-studio popup mounts as `dialog.popup:has(.orch_it_popup)`.
        const popup = page.locator('dialog.popup:has(.orch_it_popup)').first();
        await popup.waitFor({ state: 'visible', timeout: 15_000 });

        // Type into the composer and send. The mock LLM accepts any
        // payload; we only inspect the system prompt it receives.
        const composer = popup.locator('textarea[data-orch-it-input]').first();
        await composer.waitFor({ state: 'attached', timeout: 5000 });
        await composer.evaluate((el, v) => {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }, 'Could you propose any small refinements to the director main agent prompt? Keep it concise.');

        const sendBtn = popup.locator('button[data-orch-it-action="send"]').first();
        await sendBtn.click();

        // Wait until the mock has actually received the request.
        await expect.poll(() => mock.requests.length - beforeRequests, {
            message: 'mock LLM should receive the iter-studio round request',
            timeout: 30_000,
        }).toBeGreaterThan(0);

        const newReqs = mock.requests.slice(beforeRequests);
        const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
        expect(chatReq, 'expected a chat-completion request from iter-studio').toBeTruthy();
        // The system prompt is composed across message[0] (system) typically.
        // Concatenate all system / developer messages so the assertion
        // doesn't depend on per-version message-shape choices.
        const messages = Array.isArray(chatReq.body.messages) ? chatReq.body.messages : [];
        const systemText = messages
            .filter(m => m.role === 'system' || m.role === 'developer')
            .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
            .join('\n');

        // The dedup section header must be present in the system prompt.
        // We assert ONLY on the header (`# No content duplication`),
        // not the body wording, so the team can revise the explanation
        // without breaking this regression lock.
        expect(systemText,
            'iter-studio system prompt must include the dedup section header (commit 3de0c3ecc); if a refactor strips it, the LLM resumes pasting WI / sibling prompts into authored agents',
        ).toContain('# No content duplication');
    });
});
