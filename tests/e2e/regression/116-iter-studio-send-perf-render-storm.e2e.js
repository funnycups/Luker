// #116 — iter-studio Send → pending proposal renders quickly without main-thread storm.
//
// Bug shape: when the iter-studio popup processes an LLM tool call that
// produces a pending profile edit, the popup re-renders. Pre-fix three
// pathologies combined:
//   1. drainOutcomes() in ProposalBus emitted a redundant onChange every
//      time the popup's auto-continue pump flushed outcomes.
//   2. scheduleBusRender used queueMicrotask, so a burst of bus mutations
//      = a burst of full popup re-renders.
//   3. Inside each render, every diff card read window.innerWidth
//      synchronously, forcing a layout pass between every DOM write.
//
// Visually: the Send button stayed in "Stop" state long after the LLM
// closed the response; the popup appeared to hang.
//
// REAL USER FLOW: open the orchestrator iter-studio, script a profile-
// edit tool call, click Send, and assert:
//   (a) A pending proposal card mounts in the popup.
//   (b) The Send button returns to its "Send" label within reasonable
//       time (proves no render-storm hang).
//   (c) The total number of full popup re-renders stays bounded.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';

let server, mock;

const NEW_DIRECTOR_PROMPT = '*You are Ash, the cartographer-narrator of the Bryn headland.* '
    + 'Hold the in-scene voice. Frame each scene through the reef chart you carry — '
    + 'no third-wall asides, no meta. End every turn with a tactile beat: the brine on '
    + 'the rail, the verdigris of the spyglass, the cold of the lantern\'s bezel.';

// Local inline helpers — _lib/ui-iter-studio.js helpers are stale
// (legacy apply-batch / discard-batch action attrs vs the new
// proposal-bus model). The brief forbids editing _lib/.

async function setOrchModeToDirector(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const modeSelect = page.locator('#luker_orch_execution_mode');
    await modeSelect.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await modeSelect.inputValue()) !== 'director') {
        await modeSelect.selectOption('director');
        await modeSelect.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });
        await page.waitForFunction(() => {
            const board = document.querySelector('#luker_orch_director_board');
            return board && board.offsetParent !== null;
        }, { timeout: 5000 });
    }
    // Flip the Enabled checkbox via the real settings panel — no
    // internal-state mutation. The drawer is already open (we just
    // toggled execution mode above), so the checkbox is visible.
    // bootstrapCustomBackend already cleared requestApi/LlmPresetName.
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await enabled.isChecked())) {
        await enabled.check();
    }
}

async function openOrchIterStudio(page) {
    const openBtn = page.locator('#luker_orch_director_board [data-luker-action="ai-iterate-open"]:visible').first();
    await openBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await openBtn.click();
    const sendBtn = page.locator('[data-orch-it-action="send"]').last();
    await sendBtn.waitFor({ state: 'visible', timeout: 15_000 });
}

test.beforeAll(async () => {
    mock = await startMockLLM();
    server = await startServer({ batchKey: 'regression', scenarioId: '116-iter-studio-send-perf', extraConfig: { 'storage.mode': 'fs' } });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#116 — iter-studio Send → pending proposal renders quickly without main-thread storm', () => {
    test('one Send produces a proposal card, Send returns to idle, and render count stays bounded', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await setOrchModeToDirector(page);

        await openOrchIterStudio(page);
        const popup = page.locator('.popup:visible:has(.orch_it_popup)').last();

        // Shim render-tick counter — patch the popup's messages slot's
        // innerHTML setter so every full rerender bumps the counter.
        await popup.evaluate((root) => {
            const msgs = root.querySelector('[data-orch-it-messages]');
            if (!msgs) throw new Error('messages slot not found');
            window.__iterRenderTicks = 0;
            const proto = Object.getPrototypeOf(msgs);
            const desc = Object.getOwnPropertyDescriptor(proto, 'innerHTML')
                || Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
            const realSet = desc.set;
            Object.defineProperty(msgs, 'innerHTML', {
                configurable: true,
                get: desc.get,
                set(v) {
                    window.__iterRenderTicks += 1;
                    realSet.call(this, v);
                },
            });
        });

        mock.scriptToolCall({
            name: 'luker_orch_set_director_main_agent',
            arguments: { systemPrompt: NEW_DIRECTOR_PROMPT },
        });

        const composer = popup.locator('textarea[data-orch-it-input]').first();
        await composer.waitFor({ state: 'attached', timeout: 5000 });
        await composer.fill('Update the director main agent to take the role of Ash from the Bryn headland. Keep voice immersive.');

        const sendBtn = popup.locator('button[data-orch-it-action="send"]').first();
        const beforeRequests = mock.requests.length;
        const tStart = Date.now();
        await sendBtn.click();

        // Wait for the tool-call round to reach the mock.
        await expect.poll(() => {
            const newReqs = mock.requests.slice(beforeRequests);
            return newReqs.filter(r => r.url.includes('chat/completions')).length;
        }, {
            message: 'iter-studio should issue the tool-call round',
            timeout: 30_000,
        }).toBeGreaterThanOrEqual(1);

        // (a) A pending proposal card with an Approve button must render.
        const approveBtn = popup.locator('[data-proposal-action="approve"]').first();
        await approveBtn.waitFor({ state: 'visible', timeout: 15_000 });

        // (b) The Send button must return to "Send".
        await expect.poll(async () => {
            return await sendBtn.textContent();
        }, {
            message: 'Send button should return to idle after the round settles',
            timeout: 20_000,
        }).toMatch(/Send|发送|送出/);
        const tElapsed = Date.now() - tStart;

        // (c) Render budget.
        const ticks = await page.evaluate(() => window.__iterRenderTicks || 0);
        expect(ticks,
            `iter-studio rendered the messages list ${ticks} times in ${tElapsed}ms — render storm regression (the rAF coalescer in iteration-library/render-scheduler is supposed to bound this)`,
        ).toBeLessThanOrEqual(20);

        const cardCount = await popup.locator('.iter_proposal_card').count();
        expect(cardCount).toBeGreaterThanOrEqual(1);
    });
});
