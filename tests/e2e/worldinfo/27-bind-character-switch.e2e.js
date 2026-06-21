// #27 — Bind WI to character → switch character
//
// Each character carries its own primary book pointer at
// character.data.extensions.world. When the active character changes,
// the WI pipeline must (a) detach the old book and (b) attach the new.
//
// Scenario:
//   - Char1 (Ash) bound to bookA — contains entry "OAKWOOD_LORE" on key "oakwood"
//   - Char2 (Rhonin) bound to bookB — contains entry "STONEPATH_LORE" on key "stonepath"
//
// Real-user flow:
//   1. Click Ash's card in the right nav (real card click via
//      selectCharacterByName). After selection the character editor
//      panel mounts inside the right drawer; the editor's `#world_button`
//      gains the `.world_set` class iff the bound primary book name is
//      registered in world_names. We verify that — the same affordance
//      a real user sees showing "Ash is linked to a lorebook".
//   2. Send a turn with the bound key ("oakwood") via the real send
//      button. Capture the mock LLM's chat-completion body — OAKWOOD_LORE
//      must appear, STONEPATH_LORE must not.
//   3. Click Rhonin's card (another real card click). Verify
//      `#world_button` reflects the new binding, then send a turn with
//      "stonepath" → STONEPATH_LORE present, OAKWOOD_LORE absent.
//   4. Restart the server and repeat both via the same real card-click
//      gestures — bindings persist on disk and the WI pipeline
//      reattaches correctly post-restart.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, sendMessageAndAwaitReply, selectCharacterByName } from '../_lib/page.js';
import { writeCharacterWithBinding, startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

const BOOK_A_ENTRIES = [
    {
        key: ['oakwood', 'oak-grove'],
        comment: 'ash-private-lore',
        content: 'OAKWOOD_LORE: Ash learned to read tide-charts at her aunt\'s oakwood cottage, where the gulls always nested over the eastern window.',
        order: 100,
    },
];

const BOOK_B_ENTRIES = [
    {
        key: ['stonepath', 'stone-path'],
        comment: 'rhonin-private-lore',
        content: 'STONEPATH_LORE: Rhonin walks the stonepath each dawn to count the herring traps along the inner cove, never trusting the count to apprentices.',
        order: 100,
    },
];

/**
 * Drop the seed's heavyweight orchestrator preset stack so the WI
 * content has room in the chat-completion request body. Same rationale
 * as 25-activation-strategies.e2e.js#scrubPresetPrompts.
 */
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
        scriptedReplies: Array.from({ length: 10 }, (_, i) =>
            `*A measured reply, eyes on the horizon.* Acknowledged (${i + 1}).`,
        ),
    });
    server = await startWorldInfoServer({ specBaseName: '27-bind-character-switch', scenarioId: 'char-bind-switch' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    scrubPresetPrompts(server.dataRoot);

    const bookA = writeWorldBook({ dataRoot: server.dataRoot, name: 'ash-private-book', entries: BOOK_A_ENTRIES });
    const bookB = writeWorldBook({ dataRoot: server.dataRoot, name: 'rhonin-private-book', entries: BOOK_B_ENTRIES });

    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-cartographer.png',
        name: 'Ash Cartographer',
        worldBook: bookA,
    });
    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'rhonin-warden.png',
        name: 'Rhonin Warden',
        worldBook: bookB,
        extras: {
            description: 'A coastal warden in his late forties. Greying beard, deliberate movements, never raises his voice. Charges the morning herring count himself.',
            personality: 'Quiet, exacting, generous with rules and stingy with praise.',
            scenario: 'You meet Rhonin at the cove gate where he is examining the night\'s trap-lines.',
            first_mes: '*Rhonin straightens from the trap-rope, salt on his sleeves.* "Early. Walk with me along the stonepath — the inner cove was unsettled at the third bell."',
        },
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
 * Confirm the character editor's `#world_button` carries the `.world_set`
 * class — the canonical user-visible signal that the bound primary
 * world book is registered (setWorldInfoButtonClass toggles it after
 * character load). Polls a few times because the class is set by an
 * async sequence (character-load → resolve world_names → setClass).
 *
 * The button lives in `rm_ch_create_block`, which is `display:none`
 * unless the right drawer is open. We do NOT require the drawer to be
 * visible — only that the class is present in DOM, which is the
 * load-bearing piece (drawer can be open or closed; the user sees the
 * "world_set" glow when they open the drawer).
 */
async function expectWorldButtonBound(page, expectedBookName) {
    await page.waitForFunction(() => {
        const btn = document.querySelector('#world_button');
        return btn && btn.classList.contains('world_set');
    }, { timeout: 10_000 }).catch(() => { throw new Error(`#world_button did not gain .world_set after binding to ${expectedBookName}`); });
}

async function openListAndSelect(page, name) {
    // First make sure the right nav drawer is open.
    await page.evaluate(() => {
        const i = document.querySelector('#rightNavDrawerIcon');
        if (i && i.classList.contains('closedIcon')) {
            (i.closest('.drawer-toggle') || i).click();
        }
    });
    await page.locator('#right-nav-panel').waitFor({ state: 'visible', timeout: 10_000 });
    // If the character editor panel is currently shown (selecting a
    // character routes selectRightMenuWithAnimation to
    // `rm_ch_create_block`), click the "Select/Create Characters"
    // button — this is the canonical real-user gesture to return to
    // the character LIST view (rm_button_back is hidden in editor
    // mode; the user instead uses the list icon at the top of the
    // right nav).
    const isEditorShown = await page.evaluate(() => {
        const block = document.querySelector('#rm_ch_create_block');
        return block && window.getComputedStyle(block).display !== 'none';
    });
    if (isEditorShown) {
        await page.locator('#rm_button_characters').click({ force: true });
        await page.locator('#rm_print_characters_block').waitFor({ state: 'visible', timeout: 10_000 });
    }
    // Now the shared helper can find the card and click it.
    await selectCharacterByName(page, name);
}

test.describe('#27 — Bind WI to character → switch character', () => {
    test('each character pulls only its own bound book', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // --- Ash turn: only OAKWOOD_LORE ---
        await openListAndSelect(page, 'Ash Cartographer');
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'ash-private-book';
        }, { timeout: 10_000 });
        await expectWorldButtonBound(page, 'ash-private-book');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        const ashBody = await sendAndCaptureBody(page, 'The oakwood is restless tonight; the gulls are silent.');
        expect(ashBody).toContain('OAKWOOD_LORE');
        expect(ashBody).not.toContain('STONEPATH_LORE');

        // --- Switch to Rhonin via another REAL card click ---
        await openListAndSelect(page, 'Rhonin Warden');
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'rhonin-private-book';
        }, { timeout: 10_000 });
        await expectWorldButtonBound(page, 'rhonin-private-book');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        const rhoninBody = await sendAndCaptureBody(page, 'The stonepath narrows past the mill at the third bend.');
        expect(rhoninBody).toContain('STONEPATH_LORE');
        expect(rhoninBody).not.toContain('OAKWOOD_LORE');
    });

    test('bindings persist across server restart', async ({ page }) => {
        await server.restart();
        await awaitMainUI(page, server.baseURL);

        // Real card click again post-restart — same gesture as the
        // first test, no programmatic shortcut.
        await openListAndSelect(page, 'Ash Cartographer');
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'ash-private-book';
        }, { timeout: 10_000 });
        await expectWorldButtonBound(page, 'ash-private-book');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        const ashBody = await sendAndCaptureBody(page, 'The oakwood cottage still stands on the eastern bluff.');
        expect(ashBody).toContain('OAKWOOD_LORE');
        expect(ashBody).not.toContain('STONEPATH_LORE');

        await openListAndSelect(page, 'Rhonin Warden');
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'rhonin-private-book';
        }, { timeout: 10_000 });
        await expectWorldButtonBound(page, 'rhonin-private-book');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        const rhoninBody = await sendAndCaptureBody(page, 'Two of the stonepath traps showed broken lines this dawn.');
        expect(rhoninBody).toContain('STONEPATH_LORE');
        expect(rhoninBody).not.toContain('OAKWOOD_LORE');
    });
});
