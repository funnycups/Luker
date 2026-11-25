// #6b — Delete a message with "Confirm message deletion" turned off.
//
// REAL USER-GESTURE flow:
//   1. Send a turn from the composer.
//   2. Open User Settings and untick "Confirm message deletion".
//   3. Delete the reply via pencil → delete icon. No dialog appears; the
//      message is removed at once, and the deletion survives a reload.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    deleteMessageViaUI,
    closeAnyOpenTopSettingsDrawer,
    getRenderedChatTexts,
} from '../_lib/page.js';

const REPLY = '*Seraphina pinches out the spare wick.* "One lantern is enough for the two of us tonight."';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [REPLY] });
    server = await startServer({ scope, batchKey: 'chat', scenarioId: 'delete-without-confirmation' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#6b — delete without the confirmation dialog', () => {
    test('with "Confirm message deletion" off, the pencil delete removes the message without a dialog', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        const { replyId, text } = await sendMessageAndAwaitReply(page, '*I hold up the spare lantern.* "Should I light this one too?"');
        expect(text).toContain('One lantern is enough');

        await page.locator('#user-settings-button .drawer-toggle').click();
        const confirmToggle = page.locator('#confirm_message_delete');
        await expect(confirmToggle).toBeChecked();
        await confirmToggle.uncheck();
        await closeAnyOpenTopSettingsDrawer(page);
        // The checkbox handler must have switched the setting off; otherwise
        // the delete below would go through the dialog branch unnoticed.
        expect(await page.evaluate(() => window.Luker.getContext().powerUserSettings.confirm_message_delete)).toBe(false);

        // deleteMessageViaUI reads the flag the UI just changed and expects
        // no dialog on this branch.
        await deleteMessageViaUI(page, replyId);
        await expect(page.locator('dialog.popup[open]'), 'no confirmation dialog may open').toHaveCount(0);

        const textsAfterDelete = await getRenderedChatTexts(page);
        expect(textsAfterDelete.some((t) => t.includes('One lantern is enough'))).toBe(false);

        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await expect(page.locator('#chat .mes').last()).toContainText('Should I light this one too?');
        const textsAfterReload = await getRenderedChatTexts(page);
        expect(textsAfterReload.some((t) => t.includes('One lantern is enough'))).toBe(false);
    });
});
