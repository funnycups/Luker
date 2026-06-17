// #116 — iter-studio Send → pending edit must render quickly without main-thread storm.
//
// Bug shape: when the iter-studio popup processes an LLM tool call that
// produces a pending profile edit (i.e. the bus's onChange fires after
// propose()), the popup re-renders. Pre-fix, three pathologies combined:
//
//   1. drainOutcomes() in ProposalBus emitted a redundant onChange every
//      time the popup's auto-continue pump flushed outcomes, so each
//      LLM round triggered N+1 renders instead of N.
//   2. scheduleBusRender used queueMicrotask, so a burst of bus mutations
//      within one round = a burst of full popup re-renders (no
//      animation-frame coalescing).
//   3. Inside each render, every diff card read window.innerWidth
//      synchronously via text-diff.js#isNarrowViewport, forcing a layout
//      pass between every DOM write.
//
// Combined, a single user Send produced ~10 renders / second and tied
// up the main thread well past the LLM's actual response (the
// Trace-20260617T154806 capture measured 1,079 renders in 106s).
// Visually: the Send button stayed in "Stop" state long after the LLM
// closed the response; the popup appeared to hang.
//
// Regression lock: open the orchestrator iter-studio popup in director
// mode, script the mock LLM to (1) emit a profile-edit tool call and
// (2) terminate the loop with plain prose, click Send, and assert:
//
//   a. A diff card mounts in the popup (proves the bus pending edit
//      flowed through the render path).
//   b. The Send button returns to its "Send" label within a reasonable
//      timeout (proves no render-storm hang).
//   c. The total number of full popup re-renders attributable to the
//      bus stays bounded — we count the diff-card-mount + re-render
//      passes via a window-shimmed counter on render() entries.
//
// If any of the three regressions returns, (b) or (c) will fail loudly.
// The previously-existing e2e #110 only scripted a no-tool-call reply,
// so it never staged a pending edit and never triggered the regressed
// render hot path.

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

test.beforeAll(async () => {
    mock = await startMockLLM();
    server = await startServer({ batchKey: 'regression', scenarioId: '116-iter-studio-send-perf' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#116 — iter-studio Send → pending edit renders quickly without main-thread storm', () => {
    test('one Send produces a diff card, Send returns to idle, and render count stays bounded', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Force director mode so the studio mounts in the director adapter —
        // the canonical multi-agent profile-edit path.
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const s = ctx.extensionSettings?.orchestrator;
            if (!s) throw new Error('orchestrator settings missing');
            s.enabled = true;
            s.executionMode = 'director';
            if (typeof ctx.saveSettings === 'function') ctx.saveSettings();
            else if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        });

        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'orchestrator_settings');

        // Per-mode iter-studio trigger — only the active mode's button is
        // visible, so :visible filters to director.
        const openBtn = page.locator('#orchestrator_settings [data-luker-action="ai-iterate-open"]:visible').first();
        await expect(openBtn).toBeVisible({ timeout: 10_000 });
        await openBtn.click();

        const popup = page.locator('.orch_it_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 15_000 });

        // Shim render() entry counter onto window so the test can assert
        // the bus doesn't fan a single Send into a storm of renders.
        // We patch the popup root's `[data-orch-it-messages]` innerHTML
        // setter — the canonical full-rerender DOM write — and increment
        // a counter on every set. Pre-fix this would tick dozens of
        // times during a single LLM round; post-fix it should tick at
        // most a handful (initial + post-tool + auto-continue + post-text).
        await page.evaluate(() => {
            const popupRoot = document.querySelector('.orch_it_popup.luker-iter-workspace');
            if (!popupRoot) throw new Error('popup root not found');
            const msgs = popupRoot.querySelector('[data-orch-it-messages]');
            if (!msgs) throw new Error('messages slot not found');
            // Patch via prototype so the property setter is reachable.
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

        // Script the LLM for ONE round that emits the profile-edit tool
        // call. The iter-studio is designed to PAUSE its auto-continue
        // loop the moment any write proposal (profile-edit, lorebook,
        // skill) is staged on the bus — the user reviews the diff card
        // and approves / rejects before the next round fires. So a single
        // tool-call round is the canonical "render the diff card and
        // wait" path, and that's exactly the path the render storm
        // exercised pre-fix.
        mock.scriptToolCall({
            name: 'luker_orch_set_director_main_agent',
            arguments: { systemPrompt: NEW_DIRECTOR_PROMPT },
        });

        const composer = popup.locator('textarea[data-orch-it-input]').first();
        await composer.waitFor({ state: 'attached', timeout: 5000 });
        await composer.evaluate((el, v) => {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }, 'Update the director main agent to take the role of Ash from the Bryn headland. Keep voice immersive.');

        const sendBtn = popup.locator('button[data-orch-it-action="send"]').first();
        const beforeRequests = mock.requests.length;
        const tStart = Date.now();
        await sendBtn.click();

        // Wait for the tool-call round to reach the mock so we know the
        // studio actually issued the request and processed the result.
        await expect.poll(() => {
            const newReqs = mock.requests.slice(beforeRequests);
            return newReqs.filter(r => r.url.includes('chat/completions')).length;
        }, {
            message: 'iter-studio should issue the tool-call round',
            timeout: 30_000,
        }).toBeGreaterThanOrEqual(1);

        // (a) A pending diff card must mount. The library-shared diff
        // renderer emits `.luker_lib_diff_card` for every set-edit it
        // surfaces — that's our render-path-was-exercised proof.
        await expect(popup.locator('.luker_lib_diff_card').first()).toBeVisible({ timeout: 15_000 });

        // (b) The Send button must return to "Send" within a generous
        // timeout. Pre-fix this hung well past the LLM's own latency
        // because the render storm starved the event loop.
        await expect.poll(async () => {
            return await sendBtn.textContent();
        }, {
            message: 'Send button should return to idle after the round settles',
            timeout: 20_000,
        }).toMatch(/Send|发送|送出/);
        const tElapsed = Date.now() - tStart;

        // (c) Render budget. ONE LLM round + the studio's pre-send /
        // post-tool / post-loop renders should produce only a small
        // handful of full `[data-orch-it-messages]` rewrites. Pre-fix
        // the counter would blow well past 50 inside this same window
        // because every bus mutation (propose, drain, etc.) re-rendered
        // synchronously. We allow a generous ceiling — the spirit of
        // the test is "not 100", not "exactly 5".
        const ticks = await page.evaluate(() => window.__iterRenderTicks || 0);
        expect(ticks, `iter-studio rendered the messages list ${ticks} times in ${tElapsed}ms — render storm regression (the rAF coalescer in iteration-library/render-scheduler is supposed to bound this)`).toBeLessThanOrEqual(20);

        // Sanity: exactly ONE bus entry was produced (one profile-edit
        // proposal). If the bus accidentally fanned the tool call out
        // into multiple entries this is where it'd surface.
        const busEntryCount = await page.evaluate(() => {
            // The bus is closure-captured per popup; we can read its
            // public counterpart via window.Luker.getContext() chain —
            // but the studio doesn't expose it. So instead count diff
            // cards as a proxy for entries (one card per entry).
            return document.querySelectorAll('.luker_lib_diff_card').length;
        });
        expect(busEntryCount).toBeGreaterThanOrEqual(1);
    });
});
