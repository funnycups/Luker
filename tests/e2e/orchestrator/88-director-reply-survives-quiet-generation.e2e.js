// Case #88 — a quiet generation during a director run must not drop the
// committed reply.
//
// The Backgrounds drawer's auto-select button asks the model for a
// background through a quiet generation. The test holds the director's
// finalize call in the mock LLM and auto-selects a background twice.
// Each quiet generation completes while the director run is in flight,
// and Stop stays available. After finalize is released, the committed
// reply must be written to the chat file, and after a server restart
// and reload it is still the last assistant message.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageViaUI,
    closeAnyOpenTopSettingsDrawer,
    reloadAndAwait,
    getChatSnapshot,
} from '../_lib/page.js';
import { installMinimalDirectorProfile } from '../_lib/ui-orchestrator.js';

const FINAL_REPLY =
    '*Ash sets the lantern on the crate between you and studies the swaying shadows.*\n\n'
    + '"Wind\'s turning east. If the boats are coming, they come before dawn."';

let server, mock;

/**
 * Read the persisted messages of a chat file, without its header line.
 * @param {string} chatId
 * @returns {Array<{is_user?: boolean, mes?: string}>}
 */
function readChatFileMessages(chatId) {
    const file = resolve(server.dataRoot, 'default-user', 'chats', 'default_Seraphina', `${chatId}.jsonl`);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(1).map(line => JSON.parse(line));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'orchestrator', scenarioId: '88-quiet-generation' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#88 — director reply survives a quiet generation mid-run', () => {
    test('reply committed after a background auto-select is persisted across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await installMinimalDirectorProfile(page);

        let markFinalizeRequested;
        const finalizeRequested = new Promise((resolve) => { markFinalizeRequested = resolve; });
        let releaseFinalize;
        const finalizeReleased = new Promise((resolve) => { releaseFinalize = resolve; });
        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role === 'director-main' && turn === 0) {
                    return { tool: 'write_message', arguments: { text: FINAL_REPLY, mode: 'replace' } };
                }
                if (role === 'director-main' && turn === 1) {
                    markFinalizeRequested();
                    return finalizeReleased.then(() => ({ tool: 'finalize', arguments: {} }));
                }
                return null;
            },
        });

        await sendMessageViaUI(page, '*I hold the lantern up to the window.* "Do you think they will come tonight?"');
        await finalizeRequested;
        const chatId = (await getChatSnapshot(page)).chatId;

        // The director run is in flight. Auto-select a background twice;
        // each pick runs a quiet generation that the mock answers with a
        // background title.
        await closeAnyOpenTopSettingsDrawer(page);
        await page.locator('#backgrounds-drawer-toggle').click();
        await expect(page.locator('#Backgrounds')).toHaveClass(/\bopenDrawer\b/, { timeout: 5000 });
        for (const background of ['bedroom red', 'bedroom clean']) {
            mock.scriptReply(background);
            await page.locator('#auto_background').click();
            await expect(page.locator(`#bg_menu_content .bg_example[bgfile="${background}.jpg"]`))
                .toHaveClass(/\bselected-background\b/, { timeout: 30_000 });
            await expect(page.locator('#mes_stop')).toBeVisible();
        }

        releaseFinalize();

        await expect.poll(() => {
            const last = readChatFileMessages(chatId).at(-1);
            return last && !last.is_user ? String(last.mes || '').trim() : '';
        }, { timeout: 30_000 }).toBe(FINAL_REPLY.trim());

        const before = await getChatSnapshot(page);
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction((id) => {
            const ctx = window.Luker?.getContext?.();
            return ctx?.getCurrentChatId?.() === id && Array.isArray(ctx.chat) && ctx.chat.length > 0;
        }, chatId, { timeout: 30_000 });

        const after = await getChatSnapshot(page);
        const lastAfter = after.messages[after.messages.length - 1];
        expect(after.messages).toHaveLength(before.length);
        expect(lastAfter.is_user).toBe(false);
        expect(lastAfter.mes.trim()).toBe(FINAL_REPLY.trim());
    });
});
