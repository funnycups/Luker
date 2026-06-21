// Case #89 — Regex extension: pre-process input + post-process output
//
// Real-UI version:
//   - Open the Extensions panel → expand the Regex inline-drawer.
//   - For each of the two scripts:
//       * Click "+ Global" (#open_regex_editor) to open the editor popup.
//       * Fill in the real inputs in the popup template
//         (input.regex_script_name, input.find_regex,
//         textarea.regex_replace_string).
//       * Check the matching placement checkbox(es) via real .check().
//       * Click .popup-button-ok to save.
//   - Send a real user turn. Assert:
//       (a) the mock LLM saw the substituted text (USER_INPUT regex ran);
//       (b) the rendered .mes_text bubble carries the AI-OUTPUT
//           substitution.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash trims the lantern wick and the lantern flame settles to a steady blue.* "The lantern will hold another hour."',
    ] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '89-regex' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Drive the Regex Editor popup that opens after clicking #open_regex_editor.
 * Fills name + find + replace, ticks the requested placement checkboxes,
 * clicks the popup OK button to save.
 */
async function createGlobalRegexScript(page, { name, findRegex, replaceString, placements, ephemerality = {} }) {
    await page.locator('#open_regex_editor').click();
    // The popup mounts a clone of #regex_editor_template inside a .popup
    // element. Match the most recently opened popup so this works for
    // both the first script (popup only) and the second (popup may
    // overlay the previous extensions drawer state).
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });

    await popup.locator('input.regex_script_name').fill(name);
    await popup.locator('input.find_regex').fill(findRegex);
    await popup.locator('textarea.regex_replace_string').fill(replaceString);
    // Uncheck all placement boxes first (the editor seeds replace_position=1
    // by default for new scripts), then check the requested ones.
    const allPlacements = popup.locator('input[name="replace_position"]');
    const count = await allPlacements.count();
    for (let i = 0; i < count; i++) {
        const cb = allPlacements.nth(i);
        if (await cb.isChecked()) await cb.uncheck();
    }
    for (const value of placements) {
        await popup.locator(`input[name="replace_position"][value="${value}"]`).check();
    }
    // The editor pre-seeds only_format_display=true and run_on_edit=true
    // for new scripts (regex/index.js:1332-1342). markdownOnly=true means
    // the engine only fires the script in markdown render path, never on
    // persisted chat content / outgoing prompts. Normalize both flags
    // explicitly so the caller's ephemerality choice (default: persist
    // changes to chat content + outgoing prompt) is what actually runs.
    const setBox = async (selector, want) => {
        const cb = popup.locator(selector);
        const checked = await cb.isChecked();
        if (want && !checked) await cb.check();
        else if (!want && checked) await cb.uncheck();
    };
    await setBox('input[name="only_format_display"]', !!ephemerality.markdownOnly);
    await setBox('input[name="only_format_prompt"]', !!ephemerality.promptOnly);
    await setBox('input[name="only_format_plugin"]', !!ephemerality.pluginOnly);
    await setBox('input[name="run_on_edit"]', !!ephemerality.runOnEdit);
    // Save via the popup OK button.
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

test.describe('#89 — Regex pre+post process applied via real UI', () => {
    test('user-input regex replaces [BR] before send; AI-output regex transforms reply', async ({ page }) => {
        test.setTimeout(120_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for greeting so MESSAGE_RECEIVED later is the real reply.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Open Extensions → Regex inline drawer → "+ Global" twice.
        await openExtensionsDrawer(page);
        // The regex drawer's container has the inline-drawer; open it.
        // The inline-drawer is the only child of #regex_container.
        const regexDrawer = page.locator('#regex_container .inline-drawer').first();
        const regexContent = regexDrawer.locator('> .inline-drawer-content');
        const regexHidden = await regexContent.evaluate(el => {
            if (!el) return true;
            const cs = window.getComputedStyle(el);
            return cs.display === 'none';
        }).catch(() => true);
        if (regexHidden) {
            await regexDrawer.locator('> .inline-drawer-toggle').first().click();
            await regexContent.waitFor({ state: 'visible', timeout: 5000 });
        }

        // Script 1: USER_INPUT — replace `[BR]` with `<br>`.
        await createGlobalRegexScript(page, {
            name: 'e2e-pre-br',
            findRegex: '/\\[BR\\]/g',
            replaceString: '<br>',
            placements: [1], // USER_INPUT
        });

        // Script 2: AI_OUTPUT — replace `lantern` with `LANTERN`.
        await createGlobalRegexScript(page, {
            name: 'e2e-post-lantern',
            findRegex: '/lantern/g',
            replaceString: 'LANTERN',
            placements: [2], // AI_OUTPUT
        });

        // Sanity: extensionSettings.regex now lists both entries.
        const regexCount = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const r = ctx.extensionSettings?.regex;
            return Array.isArray(r) ? r.length : 0;
        });
        expect(regexCount).toBeGreaterThanOrEqual(2);

        const before = mock.requests.length;

        // Real send with [BR] sentinel.
        const userInput = 'I walked the cliff path.[BR]The wind was steady and the lantern still burned.';
        const { text: replyText } = await sendMessageAndAwaitReply(page, userInput);

        // ===== Pre-process assertion: mock saw `<br>`, not `[BR]`. =====
        const newReqs = mock.requests.slice(before);
        const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
        expect(chatReq, 'mock should have received the user turn').toBeTruthy();
        const payload = JSON.stringify(chatReq.body.messages);
        expect(payload).toMatch(/<br>/);
        expect(payload).not.toMatch(/\[BR\]/);

        // ===== Post-process assertion: reply text shows the substitution. =====
        expect(replyText).toMatch(/LANTERN/);
        expect(replyText).not.toMatch(/\blantern\b/);
    });
});
