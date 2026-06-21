// #14 — Export chat as JSONL from the Manage Chat Files UI → Import into
// a different character via the same UI's Import Chat button.
// Roundtrip the chat content and assert all turns are equal across a
// server restart.
//
// Real-user gestures:
//   1. Send 3 turns via #send_textarea + #send_but.
//   2. Open the options dropdown, click "Manage chat files"
//      (option_select_chat). For the current chat's row, click the
//      .exportRawChatButton (JSONL icon). Catch the Playwright download
//      and read its file contents.
//   3. Switch to a second character (Iyana, pre-seeded on disk at boot
//      time as an embedded PNG card) via the character drawer.
//   4. Open Manage chat files for Iyana, click .chat_import_button → it
//      triggers the hidden <input type=file id="chat_import_file">.
//      We use setInputFiles to upload the JSONL bytes from step 2.
//   5. The imported chat appears in Iyana's chats directory.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openOptionsAndClick,
    getRenderedChatTexts,
    getChatSnapshot,
} from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * After a previous selectCharacterByName, the right-nav drawer's
 * "character editor" sub-panel is showing instead of the character
 * list. Navigate back to the list (via the real .rm_button_characters
 * tab) before re-opening the drawer for a different character.
 */
async function navigateBackToCharacterList(page) {
    await page.evaluate(() => {
        const i = document.querySelector('#rightNavDrawerIcon');
        if (i?.classList.contains('closedIcon')) {
            const toggle = i.closest('.drawer-toggle') || i;
            toggle?.click();
        }
        const btn = document.querySelector('#rm_button_characters');
        if (btn) btn.click();
    });
    await page.locator('#rm_print_characters_block').waitFor({ state: 'visible', timeout: 5_000 });
}

const REPLIES = [
    '*Seraphina answers with the brisk patience of a watchwoman.* "Roundtrip reply A."',
    '*Seraphina half-smiles.* "Roundtrip reply B."',
    '*Seraphina folds her arms.* "Roundtrip reply C."',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'chat', scenarioId: 'export-import' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    // Seed Iyana as a real PNG card on disk so the boot-time character
    // scan picks her up alongside the bundled Seraphina. This is the same
    // pattern as #13c — and lets the spec switch to her via the real
    // character drawer without driving the "Create New Character" UI as
    // a side-quest (which is exercised by #19).
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'iyana-the-watchwoman.png',
        overrides: {
            name: 'Iyana the Watchwoman',
            description: 'A second watchwoman who walks the eastern stretch of the Bryn headland. Quiet, careful, used to keeping silent vigils.',
            personality: 'Reserved and steady; keeps her hands in her sleeves.',
            scenario: 'You are sharing the eastern watch with Iyana.',
            first_mes: '*Iyana lifts a hand in greeting and does not speak first.*',
            mes_example: '',
            creator_notes: 'e2e fixture',
            system_prompt: '',
            post_history_instructions: '',
            talkativeness: '0.5',
            fav: false,
        },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Open Manage Chat Files (option_select_chat) and wait for the popup
 * to be visible.
 */
async function openManageChats(page) {
    await openOptionsAndClick(page, 'option_select_chat');
    await page.locator('#select_chat_popup .select_chat_block_wrapper').first()
        .waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Close Manage Chat Files popup.
 */
async function closeManageChats(page) {
    const cross = page.locator('#select_chat_cross');
    if (await cross.isVisible({ timeout: 1000 }).catch(() => false)) {
        await cross.click();
    }
    await page.waitForTimeout(300);
}

test.describe('#14 — export/import roundtrip', () => {
    test('Export → Import via real DOM gestures preserves turns across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        // Iyana is seeded as a PNG card in `beforeAll`. The boot-time
        // /api/characters/all scan should have picked her up — wait for
        // the ctx.characters list to include her before we try to switch.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters.some(c => c?.name === 'Iyana the Watchwoman');
        }, { timeout: 10_000 });

        // Real user gesture: send 3 turns via #send_textarea + #send_but.
        await sendMessageAndAwaitReply(page, 'Roundtrip turn A.');
        await sendMessageAndAwaitReply(page, 'Roundtrip turn B.');
        await sendMessageAndAwaitReply(page, 'Roundtrip turn C.');

        const chatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId?.());
        expect(chatId).toBeTruthy();

        // Real user gesture: open Manage Chat Files, click the JSONL
        // export icon on the row for the current chat. ST's handler
        // calls `download(...)` which triggers a browser download.
        await openManageChats(page);
        const row = page.locator('.select_chat_block_wrapper', { has: page.locator('.select_chat_block_filename', { hasText: chatId }) }).first();
        await row.waitFor({ state: 'visible', timeout: 10_000 });

        const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
        await row.locator('.exportRawChatButton').click();
        const download = await downloadPromise;
        const downloadPath = await download.path();
        expect(downloadPath, 'download should land on disk').toBeTruthy();
        const exportedJsonl = readFileSync(downloadPath, 'utf8');
        expect(exportedJsonl.split('\n').length).toBeGreaterThan(3);
        expect(exportedJsonl).toContain('Roundtrip turn A');
        expect(exportedJsonl).toContain('Roundtrip reply A');

        await closeManageChats(page);

        // Real user gesture: switch to Iyana via the character drawer.
        await navigateBackToCharacterList(page);
        await selectCharacterByName(page, 'Iyana the Watchwoman');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        // Real user gesture: open Manage Chat Files for Iyana.
        await openManageChats(page);
        // The Import Chat button triggers the hidden file picker. We
        // set the file directly on #chat_import_file (Playwright's
        // setInputFiles bypasses the OS file dialog which is the
        // intended use for hidden file inputs).
        const iyanaChatsDir = resolve(server.dataRoot, 'default-user', 'chats', 'iyana-the-watchwoman');
        const filesBeforeImport = existsSync(iyanaChatsDir)
            ? readdirSync(iyanaChatsDir).filter(f => f.endsWith('.jsonl'))
            : [];
        const importFile = page.locator('#chat_import_file');
        // Write the JSONL to a temp file so setInputFiles can read it.
        const tmpJsonl = resolve(tmpdir(), `luker-e2e-roundtrip-${Date.now()}.jsonl`);
        writeFileSync(tmpJsonl, exportedJsonl, 'utf8');
        await importFile.setInputFiles(tmpJsonl);

        // Wait for the imported chat file to land on disk. The import
        // handler doesn't highlight the new row (highlight=true is the
        // CURRENTLY-selected chat, which is still Iyana's greeting), so
        // we identify the new file by diffing the chats dir.
        await page.waitForTimeout(1500);
        const filesAfterImport = readdirSync(iyanaChatsDir).filter(f => f.endsWith('.jsonl'));
        const newFiles = filesAfterImport.filter(f => !filesBeforeImport.includes(f));
        expect(newFiles.length, `expected exactly one new .jsonl in iyana chats after import; got ${JSON.stringify({ before: filesBeforeImport, after: filesAfterImport })}`).toBe(1);
        const importedFileJsonl = newFiles[0];
        const importedFile = importedFileJsonl.replace(/\.jsonl$/, '');

        // Disk-side: confirm the imported chat exists and contains
        // the roundtripped turns.
        expect(existsSync(iyanaChatsDir)).toBe(true);
        const filesInIyana = filesAfterImport;
        expect(filesInIyana).toContain(importedFileJsonl);

        const importedContent = readFileSync(resolve(iyanaChatsDir, importedFileJsonl), 'utf8');
        for (const tag of ['Roundtrip turn A', 'Roundtrip turn B', 'Roundtrip turn C', 'Roundtrip reply A', 'Roundtrip reply B', 'Roundtrip reply C']) {
            expect(importedContent, `${tag} should appear in imported chat`).toContain(tag);
        }

        // Click on the imported chat row to load it. Use the
        // .select_chat_block row click which is bound to load the chat
        // via openCharacterChat under the hood.
        const importedRow = page.locator('.select_chat_block_wrapper', {
            has: page.locator('.select_chat_block_filename', { hasText: importedFile }),
        }).first();
        await importedRow.locator('.select_chat_block').click();
        await page.waitForFunction((wantId) => {
            const ctx = window.Luker.getContext();
            return ctx.getCurrentChatId?.() === wantId;
        }, importedFile, { timeout: 15_000 });

        // DOM-side: the imported chat is loaded and contains the
        // roundtripped turns.
        const renderedAfterImport = await getRenderedChatTexts(page);
        expect(renderedAfterImport.some(t => /Roundtrip turn A/.test(t))).toBe(true);
        expect(renderedAfterImport.some(t => /Roundtrip reply C/.test(t))).toBe(true);

        // Restart and verify the imported file survives.
        await server.restart();
        const stillThere = readdirSync(iyanaChatsDir).filter(f => f.endsWith('.jsonl'));
        expect(stillThere).toContain(importedFileJsonl);
        const reloadedContent = readFileSync(resolve(iyanaChatsDir, importedFileJsonl), 'utf8');
        for (const tag of ['Roundtrip turn A', 'Roundtrip reply C']) {
            expect(reloadedContent).toContain(tag);
        }

        // Real user gesture: reload, pick Iyana, open the imported chat
        // via the Manage Chat Files popup → click the row.
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Iyana the Watchwoman');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});
        await openManageChats(page);
        const reopenRow = page.locator('.select_chat_block_wrapper', {
            has: page.locator('.select_chat_block_filename', { hasText: importedFile }),
        }).first();
        await reopenRow.locator('.select_chat_block').click();
        await page.waitForFunction((wantId) => {
            const ctx = window.Luker.getContext();
            return ctx.getCurrentChatId?.() === wantId;
        }, importedFile, { timeout: 15_000 });

        const renderedFinal = await getRenderedChatTexts(page);
        expect(renderedFinal.some(t => /Roundtrip turn A/.test(t))).toBe(true);
        expect(renderedFinal.some(t => /Roundtrip reply C/.test(t))).toBe(true);

        // Secondary: ctx.chat structural snapshot.
        const finalSnap = await getChatSnapshot(page);
        expect(finalSnap.messages.some(m => /Roundtrip turn A/.test(m.mes || ''))).toBe(true);
        expect(finalSnap.messages.some(m => /Roundtrip reply C/.test(m.mes || ''))).toBe(true);
    });
});
