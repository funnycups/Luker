// #6 — Delete a single message via the .mes_edit → .mes_edit_delete
// pencil flow. After the delete, the chat should re-pack to the
// surrounding turns, and that delete persists.

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
    '*Seraphina draws an X on the chart with a thumbnail.* "Reply 1: that line is gone since the spring tide."',
    '*Seraphina circles a small atoll.* "Reply 2: the rocks here are new, two days old at most."',
    '*Seraphina shrugs and smiles.* "Reply 3: the lantern will see us through the rest of the night."',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'chat', scenarioId: 'delete-single' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Delete a message via the real pencil → delete-icon → confirm flow.
 *
 * Note: page.js's deleteMessageViaUI uses `.popup:visible` to find the
 * confirm dialog, which is unreliable for ST's `<dialog>` element popup.
 * We poll for an open dialog via the DOM API directly and click the
 * delete-button via `el.click()` — same path a real tap takes.
 */
async function deleteMessageRealUI(page, mesid) {
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

    // ST's `power_user.confirm_message_delete` defaults to true → a
    // `<dialog class="popup" open>` renders. Poll for an open dialog
    // with a result-control button and click the ok variant.
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

test.describe('#6 — delete single message via pencil', () => {
    test('deleting a middle assistant message leaves the others intact across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'Turn one: what is gone from the chart?');
        await sendMessageAndAwaitReply(page, 'Turn two: any new rocks?');
        await sendMessageAndAwaitReply(page, 'Turn three: how long will the lantern hold?');

        // Locate the message containing "Reply 2" in DOM (the second turn's
        // assistant reply). DOM-first: don't reach into ctx.chat to find ids.
        const renderedBefore = await getRenderedChatTexts(page);
        const targetIdx = renderedBefore.findIndex(t => /Reply 2/.test(t || ''));
        expect(targetIdx).toBeGreaterThanOrEqual(0);
        const lenBefore = renderedBefore.length;

        await deleteMessageRealUI(page, targetIdx);
        await page.waitForFunction(({ wantLen }) => {
            return document.querySelectorAll('#chat .mes').length === wantLen;
        }, { wantLen: lenBefore - 1 }, { timeout: 10_000 });

        // DOM-side: Reply 2 is gone, Reply 1 and 3 are still rendered.
        const renderedAfterDelete = await getRenderedChatTexts(page);
        expect(renderedAfterDelete.length).toBe(lenBefore - 1);
        expect(renderedAfterDelete.some(t => /Reply 2/.test(t))).toBe(false);
        expect(renderedAfterDelete.some(t => /Reply 1/.test(t))).toBe(true);
        expect(renderedAfterDelete.some(t => /Reply 3/.test(t))).toBe(true);

        await page.waitForTimeout(400);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 2, { timeout: 15_000 });

        // Post-restart: same DOM state.
        const renderedRestored = await getRenderedChatTexts(page);
        expect(renderedRestored.length).toBe(lenBefore - 1);
        expect(renderedRestored.some(t => /Reply 2/.test(t))).toBe(false);
        expect(renderedRestored.some(t => /Reply 1/.test(t))).toBe(true);
        expect(renderedRestored.some(t => /Reply 3/.test(t))).toBe(true);

        // Secondary ctx.chat structural check.
        const after = await getChatSnapshot(page);
        expect(after.length).toBe(lenBefore - 1);
        expect(after.messages.some(m => !m.is_user && /Reply 2/.test(m.mes || ''))).toBe(false);
        expect(after.messages.some(m => !m.is_user && /Reply 1/.test(m.mes || ''))).toBe(true);
        expect(after.messages.some(m => !m.is_user && /Reply 3/.test(m.mes || ''))).toBe(true);
    });
});
