// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #46 — Imported card carries an orchestrator loop profile whose agent
//        prompt-preset reference points at a name that lives ONLY on the
//        card (no matching local global preset). Opening the loop editor's
//        prompt-preset picker must surface that name inside the Card-bound
//        optgroup — this is the read side of card-first agent preset
//        resolution the shipped feature relies on.
//
// REAL USER-GESTURE flow:
//   1. Seed a card with:
//        - data.extensions.luker.chat_completion_preset =
//            { presets: [{ name:'CardOnlyPromptPreset', preset:{...} }],
//              defaultPresetName:'CardOnlyPromptPreset' }
//        - data.extensions.orchestrator = loop mode override referencing
//          the card-embedded preset by name.
//   2. Boot Luker; select the character via the visible character list.
//   3. Open the orchestrator drawer, ensure loop mode, open the
//      Orchestration Editor popup so the loop workspace mounts.
//   4. Assert #luker_orch_loop_prompt_preset contains a Card-bound
//      <optgroup> and the card-only preset name is inside it.
//   5. Assert the same name does NOT appear in the Local global optgroup.
//   6. Assert the loop editor's currently-selected preset name matches
//      the card-embedded name (the card orchestrator override pinned it).
//
// This locks two invariants:
//   - listCardBoundPresets is wired into renderOpenAIPresetOptions so
//     the option renders under Card-bound even without any local preset
//     of the same name.
//   - Importing a card with an orchestrator override + a card-embedded
//     preset does not require the recipient to ALSO have a matching
//     local preset — the whole set is self-contained on the card.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CHAR_NAME = 'Ilya the Rider';
const CHAR_AVATAR = 'ilya-the-rider.png';

const CARD_PROMPT_PRESET = 'CardOnlyPromptPreset';
const CARD_PROMPT_TEMP = 0.42;

// A valid loop profile in the shape sanitizeLoopProfile emits (see
// public/scripts/extensions/orchestrator/persistence.js sanitizeLoopProfile).
const CARD_LOOP_PRESET_ID = 'default';
const CARD_LOOP_PROFILE = {
    name: 'Default',
    mode: 'loop',
    apiPresetName: '',
    promptPresetName: CARD_PROMPT_PRESET,
    system_prompt: 'You loop tool-agent for Ilya the Rider.',
    tools: {},
    max_rounds: 4,
    wall_clock_budget_ms: 0,
    capsule_inject: true,
    customTools: [],
    skills: { visible: [], deny: [] },
};

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'card-embedded-orch-loop-resolve',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CHAR_AVATAR,
        overrides: {
            name: CHAR_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            { name: CARD_PROMPT_PRESET, preset: { temperature: CARD_PROMPT_TEMP, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: CARD_PROMPT_PRESET,
                    },
                },
                orchestrator: {
                    override: { mode: 'loop' },
                    presetLibraries: {
                        loop: { [CARD_LOOP_PRESET_ID]: CARD_LOOP_PROFILE },
                    },
                    activePresetIds: { loop: CARD_LOOP_PRESET_ID },
                    overrideEnabled: { loop: true },
                },
            },
        },
    });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function openLoopEditorPopup(page) {
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
    const openBtn = page.locator('[data-luker-action="open-orch-editor-popup"]:visible').first();
    await openBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await openBtn.click();
    const popup = page.locator('.popup:visible:has(.luker_orch_editor_popup)').last();
    await popup.waitFor({ state: 'visible', timeout: 15_000 });
    const agentsTab = popup.locator('button.luker-tabs-tab[data-luker-tab-key="agents"]').first();
    if (await agentsTab.isVisible({ timeout: 1000 }).catch(() => false)) {
        await agentsTab.click();
    }
    // Wait for the loop selector to render populated optgroups.
    await page.waitForFunction(() => {
        const sel = document.querySelector('#luker_orch_loop_prompt_preset');
        return sel && sel.querySelectorAll('optgroup').length > 0;
    }, { timeout: 15_000 });
    return popup;
}

test.describe('#46 — imported card with orchestrator loop override + card-embedded prompt preset is self-contained', () => {
    test('card-only prompt preset appears in loop editor Card-bound optgroup and is the pinned selection', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        // Wait for the card-bound optgroup to render in the main preset
        // selector — this proves the character-change handler processed the
        // card's chat_completion_preset embed before we open the orch editor.
        await page.waitForFunction((name) => {
            const optgroup = document.querySelector('#settings_preset_openai optgroup[data-luker-card-bound="1"]');
            if (!optgroup) return false;
            return Array.from(optgroup.querySelectorAll('option[data-luker-char-bound="1"]'))
                .some(o => o.textContent === name);
        }, CARD_PROMPT_PRESET, { timeout: 15_000 });

        await openLoopEditorPopup(page);

        // Inspect the loop prompt-preset selector's DOM. The card-embedded
        // name must appear inside a Card-bound optgroup and be marked
        // selected (the card orchestrator override pinned promptPresetName
        // to CARD_PROMPT_PRESET, so renderOpenAIPresetOptions should have
        // selected the card option per the card-first rule).
        const selectorState = await page.evaluate((name) => {
            const sel = document.querySelector('#luker_orch_loop_prompt_preset');
            if (!sel) return { hasSelector: false };
            // Layout: [empty option], [Card-bound optgroup?], [Local global optgroup?],
            //         [orphan missing option?]. Card-bound is always first if present.
            const optgroups = Array.from(sel.querySelectorAll('optgroup'));
            const cardGroup = optgroups.find(g => (g.getAttribute('label') || '').toLowerCase().includes('card')
                || g.getAttribute('label') === '本卡内嵌' || g.getAttribute('label') === '本卡內嵌');
            const globalGroups = optgroups.filter(g => g !== cardGroup);
            const cardOpts = cardGroup
                ? Array.from(cardGroup.querySelectorAll('option')).map(o => ({
                    value: o.value, text: o.textContent, selected: o.selected,
                }))
                : [];
            const globalOpts = globalGroups.flatMap(g => Array.from(g.querySelectorAll('option')).map(o => ({
                value: o.value, text: o.textContent, selected: o.selected,
                groupLabel: g.getAttribute('label') || '',
            })));
            return {
                hasSelector: true,
                cardGroupLabel: cardGroup?.getAttribute('label') || null,
                cardOptions: cardOpts,
                globalOptions: globalOpts,
                selectedValue: sel.value,
                rawHtml: sel.innerHTML,
            };
        }, CARD_PROMPT_PRESET);

        expect(selectorState.hasSelector).toBe(true);
        // The Card-bound optgroup exists and holds the card preset.
        expect(selectorState.cardGroupLabel).toBeTruthy();
        const cardEntry = selectorState.cardOptions.find(o => o.value === CARD_PROMPT_PRESET);
        expect(cardEntry, `card options: ${JSON.stringify(selectorState.cardOptions)} / raw:\n${selectorState.rawHtml}`).toBeTruthy();
        // The card preset shows "(Default)" suffix in its label because the
        // card marked it as the default slot. The value stays the raw name.
        expect(cardEntry.text).toContain(CARD_PROMPT_PRESET);
        // The selected option resolves to the card-only name; no local
        // global with this name exists to shadow it.
        expect(selectorState.selectedValue).toBe(CARD_PROMPT_PRESET);
        expect(cardEntry.selected).toBe(true);
        // The Local global optgroup does NOT carry this preset — the
        // recipient's local library has no matching name.
        const localMatch = selectorState.globalOptions.find(o => o.text.trim() === CARD_PROMPT_PRESET);
        expect(localMatch, `unexpected local match; global options: ${JSON.stringify(selectorState.globalOptions)}`).toBeUndefined();
    });
});
