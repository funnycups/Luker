// #28 — Bind WI to chat (chat lore) via real UI gestures
//
// A chat lore book is stored in `chat_metadata.world_info` (per
// METADATA_KEY in world-info.js). It's scoped to a specific chat
// file — switching chats detaches it; switching back reattaches.
//
// Real-user flow:
//   1. Select Ash, re-open the right nav so the character editor's
//      `.chat_lorebook_button` is visible.
//   2. Click `.chat_lorebook_button` → the popup `chatLorebook.html`
//      template opens with a `<select class="chat_world_info_selector">`
//      multi-select. Pick "harbor-chat-lore" via the underlying native
//      select + change event, then confirm the popup. This routes
//      through `assignLorebookToChat` → `setChatWorldInfoSelection` →
//      `saveMetadata` — same as the user clicking the icon.
//   3. Send a turn whose user text contains the chat-lore key
//      ("harbor"). Capture the chat-completion body; CHAT_HARBOR_LORE
//      must appear.
//   4. Open the options dropdown and click "Start new chat" → confirm.
//      The chat metadata resets, so CHAT_HARBOR_LORE must NOT appear
//      in the next turn.
//   5. Open the options dropdown and click "Manage chat files",
//      double-click the original chat in the past-chats list. The
//      chat lore reattaches; CHAT_HARBOR_LORE must reappear.
//
// Restart between sub-steps locks the on-disk metadata persistence.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, openOptionsAndClick } from '../_lib/page.js';
import { writeCharacterWithBinding, startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

const CHAT_LORE_ENTRIES = [
    {
        key: ['harbor', 'harbour'],
        comment: 'chat-bound-harbor',
        content: 'CHAT_HARBOR_LORE: This is a chat-only secret: the harbor watch passes a coded knock against the lantern post when the tide reverses unexpectedly.',
        order: 100,
    },
];

function scrubPresetPrompts(dataRoot, handle = 'default-user') {
    const path = resolve(dataRoot, handle, 'settings.json');
    if (!existsSync(path)) return;
    const s = JSON.parse(readFileSync(path, 'utf8'));
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.preset_settings_openai = 'Default';
    s.oai_settings.prompts = [];
    s.oai_settings.prompt_order = [];
    s.oai_settings.main_prompt = '';
    s.oai_settings.nsfw_prompt = '';
    s.oai_settings.jailbreak_prompt = '';
    s.oai_settings.impersonation_prompt = '';
    s.oai_settings.new_chat_prompt = '';
    s.oai_settings.new_group_chat_prompt = '';
    s.oai_settings.new_example_chat_prompt = '';
    s.oai_settings.continue_nudge_prompt = '';
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.orchestrator = { ...(s.extension_settings.orchestrator || {}), enabled: false };
    s.extensionSettings = s.extensionSettings || {};
    s.extensionSettings.orchestrator = { ...(s.extensionSettings.orchestrator || {}), enabled: false };
    writeFileSync(path, JSON.stringify(s, null, 4));
}

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: Array.from({ length: 16 }, (_, i) =>
            `*A patient reply, watching the water.* Acknowledged turn ${i + 1}.`,
        ),
    });
    server = await startWorldInfoServer({ specBaseName: '28-chat-lore-binding', scenarioId: 'chat-lore' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    scrubPresetPrompts(server.dataRoot);

    writeWorldBook({ dataRoot: server.dataRoot, name: 'harbor-chat-lore', entries: CHAT_LORE_ENTRIES });
    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-unbound.png',
        name: 'Ash Unbound',
        // No worldBook: character has no primary book; lore comes from chat metadata.
    });
});

test.afterAll(async () => {
    await tearDownWorldInfoServer(server);
    await mock?.stop();
});

async function sendAndCaptureBody(page, text) {
    const before = mock.requests.length;
    await sendMessageAndAwaitReply(page, text);
    const newReqs = mock.requests.slice(before);
    const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
    expect(chatReq, 'expected a chat-completion request after sending').toBeTruthy();
    return JSON.stringify(chatReq.body.messages);
}

/**
 * Re-open the right nav drawer (selectCharacterByName closes it) so
 * the character-editor panel's `.chat_lorebook_button` is on screen.
 */
async function reopenRightNav(page) {
    await page.evaluate(() => {
        const i = document.querySelector('#rightNavDrawerIcon');
        if (i && i.classList.contains('closedIcon')) {
            (i.closest('.drawer-toggle') || i).click();
        }
    });
    // Wait for the editor panel (mounted by select_selected_character) to be visible.
    await page.waitForFunction(() => {
        const block = document.querySelector('#rm_ch_create_block');
        return block && window.getComputedStyle(block).display !== 'none';
    }, { timeout: 10_000 });
}

async function closeRightNavIfOpen(page) {
    await page.evaluate(() => {
        const i = document.querySelector('#rightNavDrawerIcon');
        if (i && i.classList.contains('openIcon')) {
            (i.closest('.drawer-toggle') || i).click();
        }
    });
    await page.waitForFunction(() => {
        const i = document.querySelector('#rightNavDrawerIcon');
        return i && i.classList.contains('closedIcon');
    }, { timeout: 5000 }).catch(() => {});
}

/**
 * Click the character editor's `.chat_lorebook_button` and pick the
 * supplied book in the popup's select. The select2 wrapper hides the
 * native select; we set the value directly + dispatch the change event
 * the bound on('change') handler listens to. Then confirm the popup.
 */
async function bindChatLorebook(page, bookName) {
    const btn = page.locator('.form_create_bottom_buttons_block .chat_lorebook_button').first();
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    await btn.click();
    // The chatLorebook template renders inside a Popup. The select is
    // multi-select; .chat_world_info_selector is the canonical class.
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    const select = popup.locator('select.chat_world_info_selector').first();
    await select.waitFor({ state: 'attached', timeout: 5000 });
    // Pick the book via jQuery + trigger change (matches the user's
    // select2 click → change dispatch path).
    await page.evaluate((wantedBook) => {
        const jq = window.jQuery || window.$;
        const sel = jq('select.chat_world_info_selector').last();
        // The option text is the world name; pick by value (which is
        // the same string).
        sel.val([wantedBook]).trigger('change');
    }, bookName);
    // Confirm the popup.
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    // Wait for chat_metadata.world_info to be set (saveMetadata is debounced
    // but `setChatWorldInfoSelection` mutates the in-memory object first).
    await page.waitForFunction((wanted) => {
        const ctx = window.Luker?.getContext?.();
        const wi = ctx?.chatMetadata?.world_info;
        if (!wi) return false;
        if (Array.isArray(wi)) return wi.includes(wanted);
        return wi === wanted;
    }, bookName, { timeout: 10_000 });
}

/**
 * Open the options dropdown → click "Start new chat" → confirm the
 * Popup.show.confirm. This is the canonical real-user gesture to
 * create a fresh chat for the active character.
 */
async function startNewChatViaUI(page) {
    await openOptionsAndClick(page, 'option_start_new_chat');
    // The confirm popup carries newChatConfirm template; the OK button
    // is the affirmative.
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    // Wait for CHAT_CHANGED to fire (new chat id).
    await page.waitForFunction(() => {
        const ctx = window.Luker.getContext();
        return Array.isArray(ctx.chat) && ctx.chat.length >= 0;
    }, { timeout: 10_000 });
}

/**
 * Open "Manage chat files" via the options dropdown and click the
 * supplied chat row by file_name. select_chat_div is populated by
 * displayPastChats; .select_chat_block rows carry a file_name attribute.
 */
async function openChatByName(page, chatFileName) {
    await openOptionsAndClick(page, 'option_select_chat');
    // The popup container is #shadow_select_chat_popup; the rows
    // mount inside #select_chat_div. Wait for them to render.
    await page.locator(`#select_chat_div .select_chat_block[file_name="${chatFileName}.jsonl"], #select_chat_div .select_chat_block[file_name="${chatFileName}"]`).first().waitFor({ state: 'visible', timeout: 10_000 });
    // Click the row's filename text or the row itself.
    await page.locator(`#select_chat_div .select_chat_block[file_name="${chatFileName}.jsonl"], #select_chat_div .select_chat_block[file_name="${chatFileName}"]`).first().click();
    // Wait for the chat to load.
    await page.waitForFunction((wanted) => {
        const ctx = window.Luker.getContext();
        return ctx.getCurrentChatId?.() === wanted;
    }, chatFileName, { timeout: 10_000 });
}

test.describe('#28 — Chat lore binding follows the chat, not the character', () => {
    test('chat lore detaches on new chat and reattaches on chat reopen', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Unbound');
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            return (typeof id === 'number' || typeof id === 'string') && Array.isArray(ctx.chat);
        }, { timeout: 10_000 });
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Step 1: re-open the right nav, bind harbor-chat-lore via the
        // real chat-lorebook button + popup. Record current chat id so
        // we can come back to it after the new-chat detour.
        await reopenRightNav(page);
        await bindChatLorebook(page, 'harbor-chat-lore');
        const firstChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(firstChatId, 'should have a current chat id after binding').toBeTruthy();

        // Close the right nav so the chat composer is unobstructed for sending.
        await closeRightNavIfOpen(page);

        const bodyWithLore = await sendAndCaptureBody(page, 'I just checked the harbor — the lantern post is unlit at the second bell.');
        expect(bodyWithLore).toContain('CHAT_HARBOR_LORE');

        // Step 2: start a new chat via the options dropdown. The chat
        // metadata resets so the lore should detach.
        await startNewChatViaUI(page);
        // Wait for chat_metadata.world_info to clear.
        await page.waitForFunction(() => {
            const wi = window.Luker?.getContext?.().chatMetadata?.world_info;
            return !wi || (Array.isArray(wi) && wi.length === 0);
        }, { timeout: 10_000 });

        const newChatBody = await sendAndCaptureBody(page, 'The harbor was calm tonight — gulls quiet, no signs of trouble.');
        expect(newChatBody, 'new chat should not inherit the previous chat\'s lore').not.toContain('CHAT_HARBOR_LORE');

        // Step 3: reopen the original chat — lore reattaches.
        await openChatByName(page, firstChatId);
        await page.waitForFunction((wanted) => {
            const ctx = window.Luker?.getContext?.();
            const wi = ctx?.chatMetadata?.world_info;
            if (ctx?.getCurrentChatId?.() !== wanted) return false;
            if (Array.isArray(wi)) return wi.includes('harbor-chat-lore');
            return wi === 'harbor-chat-lore';
        }, firstChatId, { timeout: 10_000 });

        const reopenBody = await sendAndCaptureBody(page, 'Looking back at the harbor again — what about the knock signal?');
        expect(reopenBody, 'chat lore should reattach when the original chat is reopened').toContain('CHAT_HARBOR_LORE');
    });

    test('chat lore binding survives server restart', async ({ page }) => {
        // Server restart wipes in-memory state. The current chat's
        // metadata must persist to disk (chat .jsonl METADATA_KEY) for
        // the lore to reattach on reload.
        await server.restart();
        await awaitMainUI(page, server.baseURL);

        await selectCharacterByName(page, 'Ash Unbound');

        // The most recent chat for Ash Unbound is the one we just
        // reopened, which carries the harbor-chat-lore metadata.
        await page.waitForFunction(() => {
            const wi = window.Luker?.getContext?.().chatMetadata?.world_info;
            if (!wi) return false;
            if (Array.isArray(wi)) return wi.includes('harbor-chat-lore');
            return wi === 'harbor-chat-lore';
        }, { timeout: 15_000 });

        const body = await sendAndCaptureBody(page, 'Returning to the harbor after the rebuild — the knock should still hold.');
        expect(body).toContain('CHAT_HARBOR_LORE');
    });
});
