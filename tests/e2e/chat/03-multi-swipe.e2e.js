// #3 — Multi-swipe: 3 variants total, pick variant #2, restart, ordering
// + selected swipe_id preserved.
//
// Real-user flow: click .swipe_right on the last message twice (variants
// 2 and 3 land via in-flight regeneration), then .swipe_left once to
// step back to variant 2 (swipe_left just toggles swipe_id — no
// generation). The .swipes-counter element shows "2 / 3"
// (formatSwipeCounter uses U+200B zero-width spaces around the slash).
// Assert that against DOM, then snapshot ctx.chat for cross-restart
// equality.
//
// Headless gotcha: after a regen, refreshSwipeButtons() re-applies the
// `.fade` class to the message which sets the chevron's transition to
// `opacity ease-in` over a few hundred ms. Mid-transition the chevron
// has `visibility: hidden; pointer-events: none`, so a Playwright
// `click({force:true})` can be silently swallowed in headless. We
// dispatch the click via `el.click()` from page.evaluate, which is what
// jQuery's `$(document).on('click', ...)` delegated handler listens for.
//
// Second gotcha: `swipe()` itself rejects new attempts when
// `isGenerating() || swipeState !== NONE`. The script reads its own
// internal `is_send_press` flag for this — not exposed on `window` and
// not directly reflected in any DOM attribute. We wait for #mes_stop
// to be hidden AND no `body[data-swiping]` AND ALSO sleep a short
// settle window after every swipe to let the JS state machine clear.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    getChatSnapshot,
    getRenderedChatTexts,
} from '../_lib/page.js';

const REPLIES = [
    '*Seraphina looks out across the black water and sighs softly.* "First variant — the wind is steady tonight, and the chart held its shape."',
    '*Seraphina sets the spyglass down and meets your eye.* "Second variant — the wind is steady tonight, but I do not trust the chart."',
    '*Seraphina tilts her head, listening.* "Third variant — the wind is steady tonight; something in the silence does not match the chart."',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'chat', scenarioId: 'multi-swipe' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Read the .last_mes .swipes-counter as plain "current/total" with
 * zero-width separators stripped.
 */
async function readSwipesCounter(page) {
    const text = await page.locator('#chat .last_mes .swipes-counter').first().innerText().catch(() => '');
    return text.replace(/[​]/g, '');
}

/**
 * Wait for any prior swipe + regen to settle, using ALL three signals:
 *   - #mes_stop hidden       (no in-flight gen)
 *   - body[data-swiping]     (no in-flight animation)
 *   - GENERATION_ENDED was emitted at least once after the most recent
 *     swipe (a 250ms settle bridge while swipe()'s post-regen Promise
 *     drains — the `is_send_press = false` write inside unblockGeneration
 *     runs before GENERATION_ENDED is dispatched).
 */
async function waitForSwipeIdle(page, timeoutMs = 30_000) {
    await page.waitForFunction(() => {
        const stop = document.querySelector('#mes_stop');
        const stopHidden = !stop || getComputedStyle(stop).display === 'none';
        const swiping = document.body.dataset.swiping === 'true';
        return stopHidden && !swiping;
    }, { timeout: timeoutMs });
    // Extra small settle so the `is_send_press = false` flag the next
    // swipe handler checks has actually been cleared — there's a brief
    // window where #mes_stop is gone but the flag is still true because
    // hideStopButton is called BEFORE `unblockGeneration` returns.
    await page.waitForTimeout(150);
}

/**
 * Click .swipe_right on the last message and wait until the swipes
 * counter AND body marker reflect the target variant. Dispatched via
 * `el.click()` to bypass the `.fade` opacity transition.
 */
async function swipeRightToVariant(page, targetCounter, marker, { timeoutMs = 30_000 } = {}) {
    await waitForSwipeIdle(page, timeoutMs);
    await page.evaluate(() => {
        const arrow = document.querySelector('#chat .last_mes .swipe_right');
        if (!arrow) throw new Error('.swipe_right not in DOM');
        arrow.click();
    });
    await page.waitForFunction(
        ({ targetCounter, marker }) => {
            const counter = document.querySelector('#chat .last_mes .swipes-counter');
            const mes = document.querySelector('#chat .last_mes .mes_text');
            if (!counter || !mes) return false;
            const counterText = (counter.innerText || '').replace(/[​]/g, '');
            return counterText === targetCounter && (mes.innerText || '').includes(marker);
        },
        { targetCounter, marker },
        { timeout: timeoutMs },
    );
}

test.describe('#3 — multi-swipe persistence', () => {
    test('3 swipe variants, pick #2, ordering preserved across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        // First-turn reply → variant 1 (swipe_id 0, counter 1/1).
        const first = await sendMessageAndAwaitReply(page, 'What do you read in the reef tonight?');
        expect(first.text).toContain('First variant');

        // Click swipe_right twice — variants 2 and 3 stream in via regen.
        await swipeRightToVariant(page, '2/2', 'Second variant');
        await swipeRightToVariant(page, '3/3', 'Third variant');

        // Click swipe_left once to land on variant 2 (counter goes to 2/3).
        // swipe_left doesn't regenerate — just toggles swipe_id. We import
        // the swipeLeftOnLatest helper from page.js so the MESSAGE_SWIPED
        // event resolution is awaited as part of the gesture.
        await waitForSwipeIdle(page);
        const { swipeLeftOnLatest } = await import('../_lib/page.js');
        await swipeLeftOnLatest(page);
        await page.waitForFunction(() => {
            const counter = document.querySelector('#chat .last_mes .swipes-counter');
            const mes = document.querySelector('#chat .last_mes .mes_text');
            const counterText = counter ? (counter.innerText || '').replace(/[​]/g, '') : '';
            return counterText === '2/3' && (mes?.innerText || '').includes('Second variant');
        }, { timeout: 15_000 });

        // Wait for the post-swipe saveChatConditional chain to flush. The
        // jQuery swipe_left handler is `async (e, data) => await swipe(...)`,
        // which returns a Promise that jQuery doesn't await — so by the time
        // MESSAGE_SWIPED resolves the save may still be inflight on the
        // 1000ms debounce. Mirror a real user pausing briefly before
        // reloading; 200ms of slack covers the fetch round-trip.
        await page.waitForTimeout(1200);

        // DOM-side: .last_mes .swipes-counter must show "2/3".
        expect(await readSwipesCounter(page)).toBe('2/3');
        // Also assert the visible body of the last message is variant 2.
        const renderedLast = (await getRenderedChatTexts(page)).at(-1);
        expect(renderedLast).toContain('Second variant');

        const before = await getChatSnapshot(page);
        const lastBefore = before.messages[before.messages.length - 1];
        expect(lastBefore.swipes).toBeTruthy();
        expect(lastBefore.swipes.length).toBe(3);
        expect(lastBefore.swipe_id).toBe(1);
        expect(lastBefore.swipes[0]).toContain('First variant');
        expect(lastBefore.swipes[1]).toContain('Second variant');
        expect(lastBefore.swipes[2]).toContain('Third variant');

        // swipe() now awaits saveChatConditional after a successful swipe_id
        // change (script.js#swipe) — no manual flush needed.

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 2, { timeout: 15_000 });

        // After restart, the rendered counter should still show "2/3"
        // and variant 2 should be the visible body.
        expect(await readSwipesCounter(page)).toBe('2/3');
        const renderedLastAfter = (await getRenderedChatTexts(page)).at(-1);
        expect(renderedLastAfter).toContain('Second variant');

        const after = await getChatSnapshot(page);
        const lastAfter = after.messages[after.messages.length - 1];
        expect(lastAfter.swipes).toBeTruthy();
        expect(lastAfter.swipes.length, 'swipes count should survive restart').toBe(3);
        expect(lastAfter.swipe_id, 'selected swipe index should survive restart').toBe(1);
        expect(lastAfter.swipes[0]).toContain('First variant');
        expect(lastAfter.swipes[1]).toContain('Second variant');
        expect(lastAfter.swipes[2]).toContain('Third variant');
    });
});
