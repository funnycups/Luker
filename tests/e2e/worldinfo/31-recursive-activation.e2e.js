// #31 — Recursive activation boundaries via the real WI settings panel
//
// Recursion: when WI activates entry A whose CONTENT contains the key
// of entry B, on the next scan pass B activates from A's content. Cap
// is controlled by world_info_max_recursion_steps (0 = unlimited).
//
// Real-user flow:
//   - Open the WI drawer.
//   - Expand the "Global World Info/Lorebook activation settings"
//     inline drawer (the activation settings live inside its body).
//   - Toggle the #world_info_recursive checkbox via Playwright's
//     check() / uncheck() — the bound handler is `.on('input', ...)`,
//     which fires natively for checkboxes on user interaction.
//   - Fill #world_info_max_recursion_steps via Playwright's fill() +
//     dispatch input to mirror the slider's canonical write path.
//
// Each sub-case sends a turn via the real send button (no slash) and
// asserts the mock LLM's chat-completion body — same load-bearing
// pattern as 25/27.
//
// Scenarios:
//   (a) chain A → B: user mentions "ocean", A keys "ocean" and its content
//       mentions "tide", entry B keys "tide". Recursion enabled → both fire.
//   (b) recursion off (world_info_recursive=false): only A fires.
//   (c) max_recursion_steps=1: only A fires (recursion loop terminates
//       after the initial pass).
//   (d) mutual A↔B cycle: terminates deterministically (no infinite loop).

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { openWorldInfoDrawer } from '../_lib/ui-worldinfo.js';
import { writeCharacterWithBinding, startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

const RECURSION_ENTRIES = [
    {
        key: ['ocean'],
        comment: 'A-ocean-entry',
        content: 'RECURSION_A: The ocean off Bryn turns black on tide nights when the harbor bell rings hollow.',
        order: 100,
    },
    {
        key: ['tide'],
        comment: 'B-tide-entry',
        content: 'RECURSION_B: Tides in the eastern bay run a 19-day cycle; mariners track them by the carving on the harbor post.',
        order: 110,
    },
    {
        key: ['lantern'],
        comment: 'C-lantern-entry',
        content: 'RECURSION_C: Lantern oil for the Bryn light is rationed to one cask per fortnight.',
        order: 120,
    },
];

const CYCLE_ENTRIES = [
    {
        key: ['alpha'],
        comment: 'cycle-alpha',
        content: 'CYCLE_ALPHA: Alpha leads to beta, the chart says.',
        order: 100,
    },
    {
        key: ['beta'],
        comment: 'cycle-beta',
        content: 'CYCLE_BETA: Beta leads to alpha, the chart says.',
        order: 110,
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
        scriptedReplies: Array.from({ length: 12 }, (_, i) =>
            `*A reply, mapping winds against the dark.* Acknowledged (${i + 1}).`,
        ),
    });
    server = await startWorldInfoServer({ specBaseName: '31-recursive-activation', scenarioId: 'recursion-bounds' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    scrubPresetPrompts(server.dataRoot);

    writeWorldBook({ dataRoot: server.dataRoot, name: 'recursion-chain-book', entries: RECURSION_ENTRIES });
    writeWorldBook({ dataRoot: server.dataRoot, name: 'recursion-cycle-book', entries: CYCLE_ENTRIES });

    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-recursion.png',
        name: 'Ash Recursion',
        worldBook: 'recursion-chain-book',
    });
    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-cycle.png',
        name: 'Ash Cycle',
        worldBook: 'recursion-cycle-book',
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

async function settleFirstMes(page) {
    await page.waitForFunction(() => {
        const ctx = window.Luker.getContext();
        return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
    }, { timeout: 10_000 }).catch(() => {});
}

/**
 * Open the WI drawer + expand the "Global World Info/Lorebook
 * activation settings" inline-drawer body so the recursion controls
 * are interactable. The body starts collapsed (display:none) per
 * .inline-drawer-content CSS; the header has the
 * .inline-drawer-toggle class.
 */
async function openWIActivationSettings(page) {
    await openWorldInfoDrawer(page);
    await page.waitForFunction(() => !!document.querySelector('#world_info_recursive'), { timeout: 5000 });
    // Expand the activation-settings inline drawer if its content is hidden.
    await page.evaluate(() => {
        const recursive = document.querySelector('#world_info_recursive');
        if (!recursive) return;
        const drawerContent = recursive.closest('.inline-drawer-content');
        if (drawerContent && window.getComputedStyle(drawerContent).display === 'none') {
            const drawer = drawerContent.closest('.inline-drawer');
            const header = drawer?.querySelector('.inline-drawer-toggle');
            header?.click();
        }
    });
    // Wait for the body to be visible.
    await page.waitForFunction(() => {
        const recursive = document.querySelector('#world_info_recursive');
        if (!recursive) return false;
        const drawerContent = recursive.closest('.inline-drawer-content');
        return drawerContent && window.getComputedStyle(drawerContent).display !== 'none';
    }, { timeout: 5000 });
}

/**
 * Toggle the #world_info_recursive checkbox via real Playwright
 * check() / uncheck(). The bound handler is `.on('input', ...)`, which
 * fires when the user clicks the checkbox.
 */
async function setRecursive(page, value) {
    const cb = page.locator('#world_info_recursive');
    if (value) await cb.check();
    else await cb.uncheck();
    // Belt-and-suspenders: dispatch 'input' explicitly in case the
    // bound handler hangs on jQuery's expected event. Playwright's
    // check/uncheck normally dispatches both 'change' and 'input',
    // but native click on a checkbox isn't always identical to user
    // interaction across browsers, so re-fire to be safe.
    await page.evaluate(() => {
        const el = document.querySelector('#world_info_recursive');
        el?.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/**
 * Fill #world_info_max_recursion_steps via real Playwright fill() +
 * dispatch 'input' to match the slider's canonical write path. The
 * range slider and the counter input are linked — setting the counter
 * via fill triggers the same setting writer.
 */
async function setMaxRecursionSteps(page, value) {
    // The number-input counter is paired with the slider; setting it
    // via .fill() is the user-equivalent gesture.
    const input = page.locator('#world_info_max_recursion_steps_counter');
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await input.fill(String(value));
    await page.evaluate((val) => {
        const slider = document.querySelector('#world_info_max_recursion_steps');
        const counter = document.querySelector('#world_info_max_recursion_steps_counter');
        if (slider) { slider.value = String(val); slider.dispatchEvent(new Event('input', { bubbles: true })); }
        if (counter) { counter.value = String(val); counter.dispatchEvent(new Event('input', { bubbles: true })); }
    }, value);
}

/**
 * Close the WI drawer so the chat composer (send-button area) is
 * unobstructed. Symmetric with openWorldInfoDrawer.
 */
async function closeWIDrawerIfOpen(page) {
    await page.evaluate(() => {
        const i = document.querySelector('#WIDrawerIcon');
        if (i && i.classList.contains('openIcon')) {
            (i.closest('.drawer-toggle') || i).click();
        }
    });
    await page.locator('#world_popup').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

test.describe('#31 — Recursive activation boundaries', () => {
    test('recursion on: A → B chain fires both entries', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Recursion');
        await settleFirstMes(page);

        await openWIActivationSettings(page);
        await setRecursive(page, true);
        await setMaxRecursionSteps(page, 0);
        await closeWIDrawerIfOpen(page);

        const body = await sendAndCaptureBody(page, 'I watched the ocean from the cliff path until first light.');
        expect(body, 'A fires off "ocean" key').toContain('RECURSION_A');
        expect(body, 'B should recurse off A\'s content mentioning "tide"').toContain('RECURSION_B');
        expect(body, 'C should NOT fire — no lantern mention in user msg or A/B content').not.toContain('RECURSION_C');
    });

    test('recursion off: A fires but B does not', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Recursion');
        await settleFirstMes(page);

        await openWIActivationSettings(page);
        await setRecursive(page, false);
        await closeWIDrawerIfOpen(page);

        const body = await sendAndCaptureBody(page, 'I watched the ocean again, eyes still on the horizon line.');
        expect(body).toContain('RECURSION_A');
        expect(body, 'B should NOT fire — recursion is off, user msg does not contain "tide"').not.toContain('RECURSION_B');
    });

    test('max_recursion_steps=1 stops the chain after the initial pass', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Recursion');
        await settleFirstMes(page);

        await openWIActivationSettings(page);
        await setRecursive(page, true);
        await setMaxRecursionSteps(page, 1);
        await closeWIDrawerIfOpen(page);

        const body = await sendAndCaptureBody(page, 'I watched the ocean one more time, hoping to spot the southern sails.');
        expect(body).toContain('RECURSION_A');
        // max_recursion_steps=1 caps the recursion loop count at 1.
        expect(body, 'B should NOT recurse when max_recursion_steps=1 gates further recursion').not.toContain('RECURSION_B');
    });

    test('mutual cycle: terminates deterministically with both entries', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Cycle');
        await settleFirstMes(page);

        await openWIActivationSettings(page);
        await setRecursive(page, true);
        await setMaxRecursionSteps(page, 0); // unlimited; entries-already-activated guard should still terminate.
        await closeWIDrawerIfOpen(page);

        const body = await sendAndCaptureBody(page, 'The chart begins at alpha, which is what the keeper said to study first.');
        expect(body).toContain('CYCLE_ALPHA');
        expect(body, 'beta should activate via recursion from alpha\'s content').toContain('CYCLE_BETA');
    });
});
