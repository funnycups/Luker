// Case #100 — Regex slow-script (ReDoS) popup: "Allow anyway" must persist on the
// script itself, so an enable/disable toggle does not re-arm the auto-pause and
// the popup does not come back on the next slow render.
//
// Real-UI version:
//   - Open Extensions → Regex → "+ Global", create a script whose pattern
//     backtracks catastrophically against the mock reply text.
//   - Send a real user turn; the mock replies with a long run of `a`s with no
//     trailing `b`, so `/(a+)+b/g` blows past the 500ms hard threshold and the
//     slow-script popup surfaces.
//   - Click "Allow anyway" (data-result 1001) in the real popup.
//   - Assert `extensionSettings.regex` now carries `allowSlow: true` for the
//     script (the decision lives on the script, not just a session set).
//   - Toggle the script off then on via the real list checkbox (this calls
//     saveRegexScript → resetRegexScriptState, which used to wipe the decision).
//   - Send another turn; assert the popup does NOT reappear.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openExtensionsDrawer,
} from '../_lib/page.js';

// `(a+)+b` against a run of `a`s with no `b` backtracks exponentially; 28 `a`s
// lands comfortably past the 500ms hard threshold on both fast and slow hosts.
const SLOW_REPLY = 'a'.repeat(28);

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [SLOW_REPLY, SLOW_REPLY, SLOW_REPLY, SLOW_REPLY] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '100-regex-slow' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function openRegexDrawer(page) {
    const regexDrawer = page.locator('#regex_container .inline-drawer').first();
    const regexContent = regexDrawer.locator('> .inline-drawer-content');
    const hidden = await regexContent.evaluate(el => {
        if (!el) return true;
        return window.getComputedStyle(el).display === 'none';
    }).catch(() => true);
    if (hidden) {
        await regexDrawer.locator('> .inline-drawer-toggle').first().click();
        await regexContent.waitFor({ state: 'visible', timeout: 5000 });
    }
}

async function expandGlobalSection(page) {
    const block = page.locator('#global_scripts_block');
    const content = block.locator('> .regex-section-content');
    const hidden = await content.evaluate(el => {
        if (!el) return true;
        return window.getComputedStyle(el).display === 'none';
    }).catch(() => true);
    if (hidden) {
        await block.locator('> .regex-section-header').click();
        await content.waitFor({ state: 'visible', timeout: 5000 });
    }
}

async function createGlobalRegexScript(page, { name, findRegex, replaceString, placements }) {
    await page.locator('#open_regex_editor').click();
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });

    await popup.locator('input.regex_script_name').fill(name);
    await popup.locator('input.find_regex').fill(findRegex);
    await popup.locator('textarea.regex_replace_string').fill(replaceString);

    const allPlacements = popup.locator('input[name="replace_position"]');
    const count = await allPlacements.count();
    for (let i = 0; i < count; i++) {
        const cb = allPlacements.nth(i);
        if (await cb.isChecked()) await cb.uncheck();
    }
    for (const value of placements) {
        await popup.locator(`input[name="replace_position"][value="${value}"]`).check();
    }

    const setBox = async (selector, want) => {
        const cb = popup.locator(selector);
        const checked = await cb.isChecked();
        if (want && !checked) await cb.check();
        else if (!want && checked) await cb.uncheck();
    };
    await setBox('input[name="only_format_display"]', false);
    await setBox('input[name="only_format_prompt"]', false);
    await setBox('input[name="plugin_request"]', false);
    await setBox('input[name="plugin_reply"]', false);
    await setBox('input[name="run_on_edit"]', false);

    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

async function readRegexScript(page, name) {
    return page.evaluate((scriptName) => {
        const list = window.Luker.getContext().extensionSettings?.regex ?? [];
        const found = list.find(s => s && s.scriptName === scriptName);
        return found ? { id: String(found.id), allowSlow: Boolean(found.allowSlow), disabled: Boolean(found.disabled) } : null;
    }, name);
}

test.describe('#100 — Regex slow-script allow-anyway persistence', () => {
    test('"Allow anyway" persists on the script and survives an enable/disable toggle', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await openExtensionsDrawer(page);
        await openRegexDrawer(page);

        await createGlobalRegexScript(page, {
            name: 'e2e-slow-redos',
            findRegex: '/(a+)+b/g',
            replaceString: 'X',
            placements: [2], // AI_OUTPUT
        });

        const created = await readRegexScript(page, 'e2e-slow-redos');
        expect(created, 'script should be persisted after save').toBeTruthy();
        expect(created.allowSlow).toBe(false);

        // Send a turn; the mock reply triggers the catastrophic pattern.
        const firstSend = sendMessageAndAwaitReply(page, 'first trigger');

        const popup = page.locator('.popup:visible', { hasText: 'Regex script is slow' }).last();
        await popup.waitFor({ state: 'visible', timeout: 60_000 });

        // Real click on the "Allow anyway" custom button.
        await popup.locator('[data-result="1001"]').click();
        await popup.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
        await firstSend;

        // The decision is persisted on the script itself.
        await page.waitForFunction((scriptName) => {
            const list = window.Luker.getContext().extensionSettings?.regex ?? [];
            return list.some(s => s && s.scriptName === scriptName && s.allowSlow === true);
        }, 'e2e-slow-redos', { timeout: 15_000 });

        const allowed = await readRegexScript(page, 'e2e-slow-redos');
        expect(allowed.allowSlow).toBe(true);

        // Toggle the script off then on through the real list toggles.
        // The drawers were closed by the send helper; re-open them.
        await openExtensionsDrawer(page);
        await openRegexDrawer(page);
        await expandGlobalSection(page);
        const itemSelector = `[id="${allowed.id}"]`;

        await page.locator(`${itemSelector} .regex-toggle-on`).click();
        await page.waitForFunction((scriptId) => {
            const list = window.Luker.getContext().extensionSettings?.regex ?? [];
            const s = list.find(x => x && String(x.id) === scriptId);
            return s && s.disabled === true;
        }, allowed.id, { timeout: 10_000 });

        await openExtensionsDrawer(page);
        await openRegexDrawer(page);
        await expandGlobalSection(page);
        await page.locator(`${itemSelector} .regex-toggle-off`).click();
        await page.waitForFunction((scriptId) => {
            const list = window.Luker.getContext().extensionSettings?.regex ?? [];
            const s = list.find(x => x && String(x.id) === scriptId);
            return s && s.disabled === false && s.allowSlow === true;
        }, allowed.id, { timeout: 10_000 });

        // Another turn runs the slow script again; it must NOT re-prompt.
        await sendMessageAndAwaitReply(page, 'second trigger');
        const popupReappeared = await page
            .locator('.popup:visible', { hasText: 'Regex script is slow' })
            .waitFor({ state: 'visible', timeout: 8000 })
            .then(() => true)
            .catch(() => false);
        expect(popupReappeared, 'slow-script popup must not re-fire after an enable/disable toggle').toBe(false);

        const stillAllowed = await readRegexScript(page, 'e2e-slow-redos');
        expect(stillAllowed.allowSlow).toBe(true);
    });
});
