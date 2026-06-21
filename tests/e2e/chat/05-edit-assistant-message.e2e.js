// #5 — Edit an assistant message → persist across restart.
//
// Real-user flow: click .mes_edit pencil on the assistant message,
// replace the contenteditable text, click .mes_edit_done. Assert against
// the rendered .mes_text DOM and snapshot ctx.chat for cross-restart
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
        '*Seraphina speaks before you have finished the question.* "The reef has moved since last night — I do not trust the old chart any more."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'edit-asst' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#5 — edit assistant message', () => {
    test('edited assistant text persists across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        const { replyId } = await sendMessageAndAwaitReply(page, 'How fresh is the chart you are working from?');
        expect(typeof replyId === 'number').toBe(true);

        const newText = '*Seraphina sets the brass spyglass down quietly.* "Edited reply: I no longer trust any chart older than four days on this stretch of coast."';
        await editMessageViaUI(page, replyId, newText);

        // DOM-side primary assertion: the assistant mesid now renders with
        // the new text body. The literal asterisks are markdown so they
        // wrap to <em>; we just check the substring lands.
        await page.waitForFunction(({ id, want }) => {
            const el = document.querySelector(`.mes[mesid="${id}"] .mes_text`);
            return el && (el.innerText || '').includes(want);
        }, { id: replyId, want: 'Edited reply' }, { timeout: 10_000 });
        const editedRendered = await page.locator(`.mes[mesid="${replyId}"] .mes_text`).innerText();
        expect(editedRendered).toContain('Edited reply');
        // Old wording should be gone.
        expect(editedRendered).not.toContain('reef has moved');

        // messageEditDone awaits patchChatMessages, which sync-writes to
        // the server (no debounce). No explicit ctx.saveChat needed.

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 2, { timeout: 15_000 });

        // Post-restart: rendered DOM contains the edit.
        const renderedAfter = await getRenderedChatTexts(page);
        expect(renderedAfter.some(t => /Edited reply/.test(t))).toBe(true);
        expect(renderedAfter.some(t => /reef has moved/.test(t) && !/Edited reply/.test(t))).toBe(false);

        // Secondary ctx.chat snapshot equality.
        const after = await getChatSnapshot(page);
        const edited = after.messages.find(m => !m.is_user && /Edited reply/.test(m.mes || ''));
        expect(edited, `edited assistant text should survive restart; got ${JSON.stringify(after.messages.map(m => m.mes?.slice(0, 60)))}`).toBeTruthy();
        expect(edited.mes).toBe(newText);
        const stale = after.messages.find(m => !m.is_user && /reef has moved/.test(m.mes || '') && !/Edited reply/.test(m.mes || ''));
        expect(stale).toBeFalsy();
    });
});
