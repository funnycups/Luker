// #131 — Manage Chat Files must highlight the currently open chat.
//
// Bug shape: POST /api/chats/search returns `file_name` with the `.jsonl`
// extension baked in, while the front-end (upstream contract) stores the
// open chat pointer as an extensionless id (`characters[].chat` /
// `group.chat_id`) and compares the two directly. Result: no row ever
// gets the `highlight` attribute — the current chat looks like every
// other row, and `/delchat` (which locates the row via
// `.select_chat_block[highlight="true"]`) has nothing to click.
//
// Real-user flow locked here:
//   1. Open a character chat, then start a second chat from the options
//      dropdown so there are two rows in the manager.
//   2. Open Manage Chat Files (options → "Manage chat files").
//   3. The current chat's row must be the only one carrying `highlight`,
//      and its `file_name` attribute must be the extensionless chat id
//      so the row stays click-able (character and group paths).
//   4. Same assertions for a group chat, plus clicking the other row
//      must actually switch the open chat.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    createNewChatViaUI,
    openOptionsAndClick,
} from '../_lib/page.js';
import {
    seedThreeCartographers,
    createGroupViaApi,
    openGroupForChat,
    sendUserAndAwaitGroupTurn,
    openPastChatsPopupForGroup,
} from '../groups/_helpers.js';

let server, mock, trio;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina sets the spyglass on the sill and taps the rim twice.* "The tide book says the night watch starts when the gulls settle — that is our cue."',
        '*Seraphina pulls the lantern shutter a finger\'s width wider.* "Keep the log open; the second bell will want a line of its own."',
    ] });
    server = await startServer({ batchKey: 'regression', scenarioId: 'chat-manager-highlight' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    trio = seedThreeCartographers(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Read the manager's rendered rows as { id, highlighted } entries.
 * @param {import('@playwright/test').Page} page
 */
async function readManagerRows(page) {
    return page.evaluate(() => {
        return Array.from(document.querySelectorAll('#select_chat_div .select_chat_block')).map((el) => ({
            attr: el.getAttribute('file_name'),
            label: el.querySelector('.select_chat_block_filename')?.textContent || '',
            highlighted: el.getAttribute('highlight') === 'true',
        }));
    });
}

test.describe('#131 — current chat highlight in Manage Chat Files', () => {
    test('character: the open chat is the only highlighted row', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await sendMessageAndAwaitReply(page, 'Note the bell and the state of the cove in the log.');

        const firstChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        const secondChatId = await createNewChatViaUI(page);
        expect(secondChatId).toBeTruthy();
        expect(secondChatId).not.toBe(firstChatId);
        await sendMessageAndAwaitReply(page, 'Start the second watch entry.');

        await openOptionsAndClick(page, 'option_select_chat');
        await page.locator('#select_chat_div .select_chat_block').first().waitFor({ state: 'visible', timeout: 10_000 });
        await expect.poll(async () => (await readManagerRows(page)).length).toBeGreaterThanOrEqual(2);

        const rows = await readManagerRows(page);
        const highlighted = rows.filter(row => row.highlighted);
        expect(highlighted, `exactly the open chat must be highlighted; rows=${JSON.stringify(rows)}`).toHaveLength(1);
        expect(highlighted[0].label, 'highlighted row must be the open chat').toContain(secondChatId);
        expect(highlighted[0].attr, 'file_name attribute must be the extensionless chat id').toBe(secondChatId);
    });

    test('group: the open group chat is highlighted and sibling rows switch chats', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        const group = await createGroupViaApi(page, {
            name: 'Bryn Headland Watch',
            members: trio.map(c => c.avatar),
            activation_strategy: 1,
            generation_mode: 0,
        });
        await openGroupForChat(page, group.id);

        await sendUserAndAwaitGroupTurn(page, 'First bell — read the cove and log it.');
        const firstChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(firstChatId).toBeTruthy();

        const secondChatId = await createNewChatViaUI(page);
        expect(secondChatId).toBeTruthy();
        expect(secondChatId).not.toBe(firstChatId);
        await sendUserAndAwaitGroupTurn(page, 'Second bell — fresh log line.');

        await openPastChatsPopupForGroup(page);
        await expect.poll(async () => (await readManagerRows(page)).length).toBeGreaterThanOrEqual(2);

        const rows = await readManagerRows(page);
        const highlighted = rows.filter(row => row.highlighted);
        expect(highlighted, `exactly the open group chat must be highlighted; rows=${JSON.stringify(rows)}`).toHaveLength(1);
        expect(highlighted[0].label, 'highlighted row must be the open group chat').toContain(secondChatId);
        expect(highlighted[0].attr, 'file_name attribute must be the extensionless chat id').toBe(secondChatId);

        // Clicking the sibling row must actually switch the open chat —
        // this exercises the group membership check in openGroupChat,
        // which receives the row's file_name attribute.
        const sibling = page.locator(`#select_chat_div .select_chat_block[file_name="${firstChatId}"]`).first();
        await sibling.click();
        await page.waitForFunction((want) => window.Luker.getContext().getCurrentChatId() === want, firstChatId, { timeout: 15_000 });
    });
});
