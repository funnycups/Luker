// #9 — Regenerate from the options dropdown
//
// Real user clicks the "Regenerate" item in the #options dropdown. Per
// the original audit: Luker's Regenerate is "redo this message" — it
// REPLACES the in-flight assistant turn's body with a new variant.
//
// We send turn 1 (variant A), swipe right once to land on variant B,
// then click Regenerate from the options dropdown. The last bubble's
// rendered body becomes Variant C and chat length is unchanged.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    regenerateViaUI,
    getChatSnapshot,
} from '../_lib/page.js';

const REPLIES = [
    '*Seraphina answers calmly.* "Variant A: the watch is steady."',
    '*Seraphina answers more sharply.* "Variant B: the watch is wrong."',
    '*Seraphina speaks barely above a whisper.* "Variant C: regenerated answer — the watch is quiet."',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'chat', scenarioId: 'regenerate' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Click .swipe_right on the last message (dispatched via el.click() to
 * bypass the `.fade` transition) and wait for the swipes-counter to
 * advance to the target. See 03-multi-swipe for full rationale.
 */
async function swipeRightToVariant(page, targetCounter, marker, { timeoutMs = 30_000 } = {}) {
    // Wait for any pending generation to settle.
    await page.waitForFunction(() => {
        const stop = document.querySelector('#mes_stop');
        const stopHidden = !stop || getComputedStyle(stop).display === 'none';
        const swiping = document.body.dataset.swiping === 'true';
        return stopHidden && !swiping;
    }, { timeout: timeoutMs });
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

test.describe('#9 — Regenerate from the options dropdown', () => {
    test('Regenerate replaces last assistant message at current swipe in place', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        const first = await sendMessageAndAwaitReply(page, 'Watch report?');
        expect(first.text).toContain('Variant A');
        // Swipe right once → variant B lands.
        await swipeRightToVariant(page, '2/2', 'Variant B');

        const beforeCount = await page.locator('#chat .mes').count();

        // Real user gesture: Regenerate from the options dropdown.
        const { text } = await regenerateViaUI(page);
        expect(text, `regenerated message should be Variant C; got=${text?.slice(0, 120)}`).toContain('Variant C');

        // Chat length unchanged — regenerate replaces in place.
        const afterCount = await page.locator('#chat .mes').count();
        expect(afterCount, `chat length should be unchanged by Regenerate`).toBe(beforeCount);

        // DOM-side: last bubble body is Variant C.
        const lastBody = await page.locator('#chat .last_mes .mes_text').innerText();
        expect(lastBody).toContain('Variant C');

        // Secondary ctx.chat: exactly one assistant message carries Variant C.
        const after = await getChatSnapshot(page);
        const cCount = after.messages.filter(m => !m.is_user && /Variant C/.test(m.mes || '')).length;
        expect(cCount).toBe(1);
    });
});
