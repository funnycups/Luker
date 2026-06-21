// #4 — Edit a user message → persist across restart.
//
// Real-user flow: click .mes_edit pencil on the user's message, replace
// the contenteditable text, click .mes_edit_done. Assert against the
// rendered .mes_text DOM and snapshot ctx.chat for cross-restart
// equality.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    editMessageViaUI,
    getChatSnapshot,
    getRenderedChatTexts,
} from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina sets the chart aside and looks at you.* "The wind has shifted. We will walk the outer line in an hour."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'edit-user' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#4 — edit user message', () => {
    test('edited user text persists across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'I will take the outer line at dawn.');

        // Find the user's mesid via DOM (no ctx.chat indexing needed).
        const renderedBefore = await getRenderedChatTexts(page);
        const userIdx = renderedBefore.findIndex(t => /outer line/.test(t || ''));
        expect(userIdx).toBeGreaterThanOrEqual(0);

        const newText = 'I will take the inner line at dawn — the outer one is gutted by the slow swallow.';
        await editMessageViaUI(page, userIdx, newText);

        // DOM-side primary assertion: the rendered mesid's .mes_text now
        // contains the new text.
        await page.waitForFunction(({ id, want }) => {
            const el = document.querySelector(`.mes[mesid="${id}"] .mes_text`);
            return el && (el.innerText || '').includes(want);
        }, { id: userIdx, want: 'inner line' }, { timeout: 10_000 });
        const editedRendered = await page.locator(`.mes[mesid="${userIdx}"] .mes_text`).innerText();
        expect(editedRendered).toContain('inner line');
        expect(editedRendered).not.toContain('outer line at dawn');

        // messageEditDone awaits patchChatMessages, which sync-writes to
        // the server (no debounce). No explicit ctx.saveChat needed.

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 2, { timeout: 15_000 });

        // Post-restart: rendered DOM contains the edit.
        const renderedAfter = await getRenderedChatTexts(page);
        expect(renderedAfter.some(t => /inner line/.test(t))).toBe(true);
        expect(renderedAfter.some(t => /outer line at dawn/.test(t) && !/inner line/.test(t))).toBe(false);

        // Secondary ctx.chat snapshot equality.
        const after = await getChatSnapshot(page);
        const edited = after.messages.find(m => m.is_user && /inner line/.test(m.mes || ''));
        expect(edited, `edited text should be restored after restart; got ${JSON.stringify(after.messages)}`).toBeTruthy();
        expect(edited.mes).toBe(newText);
        const orig = after.messages.find(m => m.is_user && /outer line at dawn/.test(m.mes || '') && !/inner line/.test(m.mes || ''));
        expect(orig).toBeFalsy();
    });
});
