// #44 — Save To Character Override detects unembedded preset refs in
//        the orchestrator profile and offers Embed all / Save names only
//        / Cancel; grouped optgroup renders card-bound presets first.
//
// Feature contract — orchestrator agent selectors group card-bound
// presets under a dedicated <optgroup> above the local global list.  On
// Save To Character Override, the orchestrator inspects the editor draft
// (loop / agenda / director) for preset names that live only in the
// local global set and pops a summary dialog:
//
//   [Embed all]           — calls ctx.character.presets.add(...) for each
//   [Save names only]     — persists profile as-is, no embed
//   [Cancel]              — bails; no orchestrator or preset writes
//
// REAL USER-GESTURE flow (three tests, each fresh card):
//   T1 Embed all      — pick a global preset via the loop editor's
//                       agent-preset selector, click Save To Character
//                       Override, click Embed all → assert card
//                       chat_completion_preset.presets contains the
//                       referenced name.
//   T2 Save names     — same setup, choose Save names only → assert card
//                       still has no embedded presets AND orchestrator
//                       character override was persisted.
//   T3 Cancel         — choose Cancel → assert nothing was persisted
//                       (no card presets, no character orchestrator
//                       override entry).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    openExtensionsDrawer,
    openInlineDrawer,
    selectCharacterByName,
} from '../_lib/page.js';
import {
    normalizeIterStudioSettings,
    selectPresetByName,
    savePresetAsViaButton,
    setCounterInput,
} from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CHAR_NAME = 'Orley the Orchestrator';
const CHAR_AVATAR = 'orley-the-orchestrator.png';
const EMBED_PRESET_NAME = 'EmbedMe';
const EMBED_PRESET_TEMP = 0.37;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'orch-save-embed-summary',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CHAR_AVATAR,
        overrides: { name: CHAR_NAME },
    });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function readCardBoundState(page) {
    return page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const chid = ctx?.characterId ?? window.this_chid;
        const c = ctx?.characters?.[chid];
        const raw = c?.data?.extensions?.luker?.chat_completion_preset ?? null;
        if (!raw) return { presets: [], defaultPresetName: null, isNull: true };
        if (Array.isArray(raw?.presets)) {
            return {
                presets: raw.presets.map(p => ({ name: p.name, temperature: p?.preset?.temperature ?? null })),
                defaultPresetName: raw.defaultPresetName ?? null,
                isNull: false,
            };
        }
        return { raw, isNull: false };
    });
}

async function readCharacterOrchestratorOverride(page) {
    return page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const chid = ctx?.characterId ?? window.this_chid;
        const c = ctx?.characters?.[chid];
        return c?.data?.extensions?.orchestrator ?? null;
    });
}

/** Reset the card's on-disk state so each test starts clean (no
 *  embedded presets, no orchestrator override). */
async function resetCharacterOnDisk({ dataRoot, avatarFile }) {
    const { resolve } = await import('node:path');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { read: readPngCard, write: writePngCard } = await import('../../../src/character-card-parser.js');
    const path = resolve(dataRoot, 'default-user', 'characters', avatarFile);
    const png = readFileSync(path);
    const card = JSON.parse(readPngCard(png));
    if (card.data) {
        if (card.data.extensions?.luker) delete card.data.extensions.luker.chat_completion_preset;
        if (card.data.extensions) delete card.data.extensions.orchestrator;
    }
    if (card.extensions) {
        if (card.extensions.luker) delete card.extensions.luker.chat_completion_preset;
        delete card.extensions.orchestrator;
    }
    writeFileSync(path, writePngCard(png, JSON.stringify(card)));
}

/** Switch execution mode to loop via the orchestrator drawer, then open
 *  the Orchestration Editor popup so the loop workspace's preset
 *  selector is present in the DOM (drawer view hides it under a tab
 *  host that hydrates on-demand). */
async function setOrchModeToLoopAndOpenEditor(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const modeSelect = page.locator('#luker_orch_execution_mode');
    await modeSelect.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await modeSelect.inputValue()) !== 'loop') {
        await modeSelect.selectOption('loop');
        await modeSelect.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });
    }
    const enabled = page.locator('#luker_orch_enabled');
    await enabled.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await enabled.isChecked())) {
        await enabled.check();
    }
    // Open the popup — the drawer's tab hosts hydrate lazily and the
    // Agents tab does not render the loop workspace until activated.
    // The popup emits the full workspace synchronously across all tabs
    // (per injectWorkspaceIntoTabHost), so the loop selector becomes
    // accessible without further UI dance.
    const openBtn = page.locator('[data-luker-action="open-orch-editor-popup"]:visible').first();
    await openBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await openBtn.click();
    const popup = page.locator('.popup:visible:has(.luker_orch_editor_popup)').last();
    await popup.waitFor({ state: 'visible', timeout: 15_000 });
    // Switch to the Agents tab so the loop workspace's preset selector
    // becomes visible to Playwright locators (the tab injection puts
    // renderLoopWorkspace output into the Agents-tab host).
    const agentsTab = popup.locator('button.luker-tabs-tab[data-luker-tab-key="agents"]').first();
    if (await agentsTab.isVisible({ timeout: 1000 }).catch(() => false)) {
        await agentsTab.click();
    }
    await page.waitForFunction(() => {
        const sel = document.querySelector('#luker_orch_loop_prompt_preset');
        // Native <select> is hidden by select2 (display:none), so
        // offsetParent-based visibility checks would false-negative.
        // Populated <optgroup> presence is the load-bearing signal.
        return sel && sel.querySelectorAll('optgroup').length > 0;
    }, { timeout: 15_000 });
    return popup;
}

/** Drive the loop mode prompt-preset selector to the given name.  The
 *  <select> is hidden by select2, so we drive the native element via
 *  jQuery `.val(...).trigger('change')` (mirrors the pattern used by
 *  the existing preset e2e helpers).  We deliberately pick the option
 *  from the Local global optgroup — if a card-bound optgroup exists
 *  with a same-named entry, we still want the global one so the save
 *  flow's detection sees an unembedded name. */
async function selectLoopPromptPresetGlobal(page, name) {
    await page.evaluate(({ target }) => {
        const $sel = window.jQuery?.('#luker_orch_loop_prompt_preset');
        if (!$sel?.length) throw new Error('#luker_orch_loop_prompt_preset not found');
        const nativeSel = $sel[0];
        // Find the option whose ancestor optgroup is NOT the card-bound
        // group (Card-bound optgroup renders first).  When there is no
        // card group at all, every option qualifies.
        const options = Array.from(nativeSel.querySelectorAll('optgroup > option'));
        const opt = options.find((el) => {
            if (el.textContent.trim() !== target) return false;
            const grp = el.closest('optgroup');
            // The card-bound optgroup renders first in DOM order; the
            // local global is the next sibling.  A single-optgroup DOM
            // (no card entries yet) means "global" by definition.
            const isFirstOptgroup = grp && grp === nativeSel.querySelector('optgroup');
            const hasSecondOptgroup = !!grp?.nextElementSibling && grp.nextElementSibling.tagName === 'OPTGROUP';
            return !(isFirstOptgroup && hasSecondOptgroup);
        });
        if (!opt) throw new Error(`loop prompt preset (global) option not found: ${target}`);
        $sel.val(String(opt.value)).trigger('change');
    }, { target: name });
    await page.waitForTimeout(200);
}

/** Click the currently-visible Save To Character Override button in the
 *  General tab of the orchestration editor popup. Switches tabs first
 *  if necessary — the Save button lives in the mode-row action bar,
 *  which is inside the General tab. */
async function clickSaveToCharacterOverride(page, popup) {
    const generalTab = popup.locator('button.luker-tabs-tab[data-luker-tab-key="general"]').first();
    if (await generalTab.isVisible({ timeout: 1000 }).catch(() => false)) {
        await generalTab.click();
    }
    const btn = popup.locator('[data-luker-action="save-character"]:visible').first();
    await btn.waitFor({ state: 'visible', timeout: 10_000 });
    await btn.click();
}

/** Wait for the summary popup to appear, then return its dialog locator.
 *  Matches the topmost dialog (the summary opens on top of the editor
 *  popup) whose body mentions the seed preset name. */
async function awaitSummaryPopup(page) {
    // dialog.popup[open] locator matches every open ST dialog; .last()
    // returns the newest (topmost) one, which is the summary popup.
    const dialog = page.locator('dialog.popup[open]').last();
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(dialog).toContainText(EMBED_PRESET_NAME, { timeout: 10_000 });
    return dialog;
}

test.describe.configure({ mode: 'serial' });

test.describe('#44 — Save To Character Override embed-summary popup', () => {
    test('Embed all: unembedded preset is added to card.chat_completion_preset.presets', async ({ page }) => {
        await resetCharacterOnDisk({ dataRoot: server.dataRoot, avatarFile: CHAR_AVATAR });
        await awaitMainUI(page, server.baseURL);

        // Seed the global preset that the orchestrator agent will
        // reference. Distinct temperature makes the embed detection
        // observable in the card body assertion below.
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', EMBED_PRESET_TEMP);
        await savePresetAsViaButton(page, EMBED_PRESET_NAME);

        await selectCharacterByName(page, CHAR_NAME);
        const popup = await setOrchModeToLoopAndOpenEditor(page);
        await selectLoopPromptPresetGlobal(page, EMBED_PRESET_NAME);

        await clickSaveToCharacterOverride(page, popup);

        const dialog = await awaitSummaryPopup(page);
        // Click "Embed all" — the OK button hosts the primary action.
        await dialog.locator('.popup-button-ok').first().click();
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});

        // Poll for the card slot to appear — the writeExtensionField
        // roundtrip is async through Layer 1's persist path.
        await expect.poll(async () => {
            const state = await readCardBoundState(page);
            return state.presets.map(p => p.name);
        }, { timeout: 15_000 }).toEqual([EMBED_PRESET_NAME]);

        const state = await readCardBoundState(page);
        expect(state.presets[0].temperature).toBeCloseTo(EMBED_PRESET_TEMP, 5);
        // First-add bootstraps the default (Layer 1 contract).
        expect(state.defaultPresetName).toBe(EMBED_PRESET_NAME);
        // Orchestrator character override was also persisted.
        const override = await readCharacterOrchestratorOverride(page);
        expect(override).not.toBeNull();
    });

    test('Save names only: orchestrator persisted without embedding preset body', async ({ page }) => {
        await resetCharacterOnDisk({ dataRoot: server.dataRoot, avatarFile: CHAR_AVATAR });
        await awaitMainUI(page, server.baseURL);

        // Same seed as Embed-all path — preset is created if not present.
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', EMBED_PRESET_TEMP);
        // Preset from previous test may already exist; savePresetAsViaButton
        // handles the confirm dialog in that path.
        const alreadyExists = await page.evaluate((n) => {
            const opts = Array.from(document.querySelectorAll('#settings_preset_openai option'));
            return opts.some(o => o.textContent.trim() === n);
        }, EMBED_PRESET_NAME);
        if (!alreadyExists) {
            await savePresetAsViaButton(page, EMBED_PRESET_NAME);
        }

        await selectCharacterByName(page, CHAR_NAME);
        const popup = await setOrchModeToLoopAndOpenEditor(page);
        await selectLoopPromptPresetGlobal(page, EMBED_PRESET_NAME);

        await clickSaveToCharacterOverride(page, popup);

        const dialog = await awaitSummaryPopup(page);
        // "Save names only" is the customButton — ST tags custom popup
        // buttons with the `.popup-button-custom` class in addition to
        // the default `.menu_button`.
        const namesOnlyBtn = dialog.locator('.popup-button-custom', { hasText: /Save names only/i }).first();
        await namesOnlyBtn.waitFor({ state: 'visible', timeout: 5000 });
        await namesOnlyBtn.click();
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});

        // Card should NOT have the preset embedded.
        const state = await readCardBoundState(page);
        expect(state.presets).toEqual([]);
        // But the orchestrator character override should be persisted.
        await expect.poll(async () => {
            const override = await readCharacterOrchestratorOverride(page);
            return override !== null;
        }, { timeout: 15_000 }).toBe(true);
    });

    test('Cancel: nothing persisted (no card presets, no orchestrator override)', async ({ page }) => {
        await resetCharacterOnDisk({ dataRoot: server.dataRoot, avatarFile: CHAR_AVATAR });
        await awaitMainUI(page, server.baseURL);

        // Ensure the preset exists globally.
        const alreadyExists = await page.evaluate((n) => {
            const opts = Array.from(document.querySelectorAll('#settings_preset_openai option'));
            return opts.some(o => o.textContent.trim() === n);
        }, EMBED_PRESET_NAME);
        if (!alreadyExists) {
            await selectPresetByName(page, 'Default');
            await setCounterInput(page, '#temp_counter_openai', EMBED_PRESET_TEMP);
            await savePresetAsViaButton(page, EMBED_PRESET_NAME);
        }

        await selectCharacterByName(page, CHAR_NAME);
        const popup = await setOrchModeToLoopAndOpenEditor(page);
        await selectLoopPromptPresetGlobal(page, EMBED_PRESET_NAME);

        await clickSaveToCharacterOverride(page, popup);

        const dialog = await awaitSummaryPopup(page);
        // The preflight popup's Cancel is a trailing custom button
        // (not the built-in `.popup-button-cancel`) so the button order
        // reads [Embed all] [Save names only] [Cancel] left-to-right.
        await dialog.locator('.popup-button-custom', { hasText: /^Cancel$/ }).first().click();
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});

        // Neither card presets nor orchestrator override should be set.
        await page.waitForTimeout(500);
        const cardState = await readCardBoundState(page);
        expect(cardState.presets).toEqual([]);
        const override = await readCharacterOrchestratorOverride(page);
        expect(override).toBeNull();
    });
});
