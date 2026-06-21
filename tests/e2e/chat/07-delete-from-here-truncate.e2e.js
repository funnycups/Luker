// #7 — Delete-from-here (truncate). After 4 turns, delete the turn-2
// user message AND every assistant/user message after it via the .mes_edit
// pencil flow, leaving only turn-1.
//
// Real-user flow: iterate from the LAST message backwards down to the
// turn-2 user message, clicking the .mes_edit → .mes_edit_delete on each.
// Bottom-up order matters because deleting a middle message renumbers
// the mesids of everything below it; deleting from the top would land
// on the wrong message.

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

/**
 * Delete a message via the real pencil → delete-icon → confirm flow.
 *
 * Note: page.js's deleteMessageViaUI uses `.popup:visible` to find the
 * confirm dialog, which is unreliable for ST's `<dialog>` element popup.
 * We poll for an open dialog via the DOM API directly and click the
 * delete-button via `el.click()` — same path a real tap takes.
 */
async function deleteMessageViaUI(page, mesid) {
    const mes = page.locator(`.mes[mesid="${mesid}"]`);
    await mes.waitFor({ state: 'visible', timeout: 10_000 });
    await mes.locator('.mes_edit').first().click({ force: true });
    await mes.locator('.mes_edit_delete').first().waitFor({ state: 'visible', timeout: 5000 });

    const deletePromise = page.evaluate(() => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('delete timeout')), 20_000);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_DELETED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_DELETED, off); } catch {}
            resolve(id);
        });
    }));

    await mes.locator('.mes_edit_delete').first().click();
    await page.waitForFunction(() => {
        return Array.from(document.querySelectorAll('dialog.popup')).some(d => d.hasAttribute('open'));
    }, { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => {
        const openDlg = Array.from(document.querySelectorAll('dialog.popup')).reverse().find(d => d.hasAttribute('open'));
        if (openDlg) {
            const ok = openDlg.querySelector('.popup-button-ok');
            if (ok) ok.click();
        }
    });
    await deletePromise;
}

const REPLIES = [
    '*Seraphina nods.* "Reply A — keep going."',
    '*Seraphina taps the chart.* "Reply B — and now the second line."',
    '*Seraphina exhales.* "Reply C — the third question is the right one."',
    '*Seraphina smiles wryly.* "Reply D — we have run out of charts."',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'chat', scenarioId: 'truncate-from-here' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#7 — delete-from-here truncate', () => {
    test('deleting turn-2 onward via pencil leaves only turn-1 after restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'Turn 1 user: walk me through the eastern stretch.');
        await sendMessageAndAwaitReply(page, 'Turn 2 user: now the western.');
        await sendMessageAndAwaitReply(page, 'Turn 3 user: and the deeps.');
        await sendMessageAndAwaitReply(page, 'Turn 4 user: anything else worth noting?');

        const renderedBefore = await getRenderedChatTexts(page);
        // First message with "Turn 2 user" is the truncation anchor.
        const truncateStart = renderedBefore.findIndex(t => /Turn 2 user/.test(t || ''));
        expect(truncateStart).toBeGreaterThanOrEqual(0);
        const lenBefore = renderedBefore.length;

        // Delete from the END down to truncateStart (inclusive) using the
        // pencil. After each delete the indices below shift, but indices
        // at or above the deleted id are unaffected when deleting the
        // last bubble — so deleting `lenBefore-1`, then `lenBefore-2`,
        // ..., down to `truncateStart` reaches every message.
        for (let id = lenBefore - 1; id >= truncateStart; id--) {
            await deleteMessageViaUI(page, id);
            await page.waitForFunction(({ wantLen }) => {
                return document.querySelectorAll('#chat .mes').length === wantLen;
            }, { wantLen: id }, { timeout: 10_000 });
        }

        await page.waitForTimeout(400);

        // DOM-side: only greeting + turn 1 remain.
        const renderedAfter = await getRenderedChatTexts(page);
        expect(renderedAfter.length).toBe(truncateStart);
        expect(renderedAfter.some(t => /Turn 1 user/.test(t))).toBe(true);
        expect(renderedAfter.some(t => /Reply A/.test(t))).toBe(true);
        for (const tag of ['Turn 2 user', 'Turn 3 user', 'Turn 4 user', 'Reply B', 'Reply C', 'Reply D']) {
            expect(renderedAfter.some(t => t.includes(tag)), `${tag} should be gone`).toBe(false);
        }

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 15_000 });

        // Post-restart: same DOM state.
        const renderedRestored = await getRenderedChatTexts(page);
        expect(renderedRestored.length, `expected only greeting + turn 1 to remain; got ${JSON.stringify(renderedRestored.map(t => t?.slice(0, 40)))}`)
            .toBe(truncateStart);
        expect(renderedRestored.some(t => /Turn 1 user/.test(t))).toBe(true);
        expect(renderedRestored.some(t => /Reply A/.test(t))).toBe(true);

        // Secondary ctx.chat structural check.
        const after = await getChatSnapshot(page);
        expect(after.length).toBe(truncateStart);
        for (const tag of ['Turn 2 user', 'Turn 3 user', 'Turn 4 user', 'Reply B', 'Reply C', 'Reply D']) {
            expect(after.messages.some(m => (m.mes || '').includes(tag)), `${tag} should be gone from ctx.chat`).toBe(false);
        }
    });
});
