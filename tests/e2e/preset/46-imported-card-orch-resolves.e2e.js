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
//   3. Open Workbench -> Orchestration -> Flow view in loop mode and click
//      the loop agent card to open its Inspector.
//   4. Assert the Generation preset dropdown lists the Card-bound preset name.
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

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { setOrchMode, setOrchEnabled, openOrchWorkspace, closeWorkbench } from '../_lib/ui-workbench.js';
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

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'preset',
        scenarioId: 'card-embedded-orch-loop-resolve',
        extraConfig: { storage: { mode: 'fs' } },
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

    await mock?.stop();
});

async function openLoopEditorPopup(page) {
    await setOrchMode(page, 'loop');
    await setOrchEnabled(page, true);
    const lens = await openOrchWorkspace(page, 'flow');
    await lens.locator('button.ol-card').first().click();
    return lens;
}

test.describe('#46 — imported card with orchestrator loop override + card-embedded prompt preset is self-contained', () => {
    test('card-only prompt preset surfaces in main card-bound optgroup and is pinned in Orchestra Lens loop inspector', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        // Wait for the card-bound optgroup to render in the main preset selector.
        await page.waitForFunction((name) => {
            const optgroup = document.querySelector('#settings_preset_openai optgroup[data-luker-card-bound="1"]');
            if (!optgroup) return false;
            return Array.from(optgroup.querySelectorAll('option[data-luker-char-bound="1"]'))
                .some(o => o.textContent === name);
        }, CARD_PROMPT_PRESET, { timeout: 15_000 });

        const lens = await openLoopEditorPopup(page);

        const presetSel = lens.locator('.ol-inspector dl.ol-routing dt').filter({
            hasText: /Generation preset|生成预设/i,
        }).locator('+ dd select.ol-select').first();
        await expect(presetSel).toBeVisible({ timeout: 10_000 });
        await expect(presetSel).toHaveValue(CARD_PROMPT_PRESET);

        const globalOptions = await page.evaluate(() => {
            const sel = document.querySelector('#settings_preset_openai');
            if (!sel) return [];
            return Array.from(sel.querySelectorAll('option'))
                .filter((o) => !o.closest('optgroup[data-luker-card-bound="1"]'))
                .map((o) => o.textContent.trim());
        });
        expect(globalOptions).not.toContain(CARD_PROMPT_PRESET);
        await closeWorkbench(page);
    });
});
