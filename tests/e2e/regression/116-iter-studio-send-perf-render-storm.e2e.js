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
import { awaitMainUI } from '../_lib/page.js';
import { openIterStudio } from '../_lib/ui-iter-studio.js';
import { setOrchMode, setOrchEnabled } from '../_lib/ui-workbench.js';

let server, mock;

const NEW_DIRECTOR_PROMPT = '*You are Ash, the cartographer-narrator of the Bryn headland.* '
    + 'Hold the in-scene voice. Frame each scene through the reef chart you carry — '
    + 'no third-wall asides, no meta. End every turn with a tactile beat: the brine on '
    + 'the rail, the verdigris of the spyglass, the cold of the lantern\'s bezel.';

async function setOrchModeToDirector(page) {
    await setOrchMode(page, 'director');
    await setOrchEnabled(page, true);
}

async function openOrchIterStudio(page) {
    await openIterStudio(page, 'orch', { scope: 'global' });
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
        const win = page.locator('.wbench .wb-win').first();

        // Count full body rebuilds inside `.wb-chat-body` via MutationObserver.
        await win.evaluate((root) => {
            const msgs = root.querySelector('.wb-chat-body');
            if (!msgs) throw new Error('.wb-chat-body not found');
            window.__iterRenderTicks = 0;
            new MutationObserver((records) => {
                if (records.some((r) => r.removedNodes.length > 0 || r.addedNodes.length > 0)) {
                    window.__iterRenderTicks += 1;
                }
            }).observe(msgs, { childList: true });
        });

        mock.scriptToolCall({
            name: 'luker_orch_set_director_main_agent',
            arguments: { systemPrompt: NEW_DIRECTOR_PROMPT },
        });

        const composer = win.locator('.wb-composer textarea.wb-input').first();
        await composer.waitFor({ state: 'attached', timeout: 5000 });
        await composer.fill('Update the director main agent to take the role of Ash from the Bryn headland. Keep voice immersive.');

        const sendBtn = win.locator('.wb-composer button.wb-send').first();
        const beforeRequests = mock.requests.length;
        const tStart = Date.now();
        await sendBtn.click();

        // Wait for the tool-call round to reach the mock.
        await expect.poll(() => {
            const newReqs = mock.requests.slice(beforeRequests);
            return newReqs.filter(r => r.url.includes('chat/completions')).length;
        }, {
            message: 'Workbench should issue the tool-call round',
            timeout: 30_000,
        }).toBeGreaterThanOrEqual(1);

        // (a) A pending diff card with Apply selected must render.
        const applyBtn = win.locator('.wb-chg.is-pending .wb-chg-foot button.is-primary').first();
        await applyBtn.waitFor({ state: 'visible', timeout: 15_000 });

        // (b) Live status bar disappears and composer Send is enabled.
        await expect(win.locator('.wb-reads.is-live')).toHaveCount(0, { timeout: 20_000 });
        await expect(sendBtn).toBeEnabled({ timeout: 20_000 });
        const tElapsed = Date.now() - tStart;

        // (c) Render budget.
        const ticks = await page.evaluate(() => window.__iterRenderTicks || 0);
        expect(ticks,
            `Workbench rebuilt .wb-chat-body ${ticks} times in ${tElapsed}ms — render storm regression`,
        ).toBeLessThanOrEqual(20);

        const cardCount = await win.locator('.wb-chg.is-pending').count();
        expect(cardCount).toBeGreaterThanOrEqual(1);
    });
});
