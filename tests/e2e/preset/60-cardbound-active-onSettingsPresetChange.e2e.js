// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #60 — After Task 1's semantic-split root fix, the in-memory field
// `characterBoundPresetState.active` MUST equal ghost DOM-selected at
// every settle point (Invariant I) and `previousPreset` MUST survive
// a ghost ↔ global toggle so the eventual restore path has a target
// (Invariant III).
//
// REAL USER-GESTURE flow:
//   1. Seed a card with one embedded card-bound preset (default set → auto-
//      applies on card selection, so the ghost option is DOM-selected).
//   2. Load Luker; select the card via the visible list.
//   3. Assert (a): ghost option is selected AND
//                  window.__characterBoundPresetState.active === true AND
//                  previousPreset is non-empty (was stashed from the initial
//                  'Default' global preset before ghost-select).
//   4. Switch to the global 'Default' preset via a jQuery-driven change
//      (Playwright selectOption rejects select2's hidden native select).
//      Assert (b): active === false AND previousPreset is UNCHANGED
//      (restore path has not fired yet — that only fires on group
//      switch / boundList clearing).
//   5. Switch back to the ghost option. Assert (c): active === true and
//      previousPreset is again non-empty (it was re-stashed from 'Default'
//      on the second ghost entry).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CARD_NAME = 'Preset Identity Aria';
const CARD_AVATAR = 'preset-identity-aria.png';
const SLOT_NAME = 'CardSlotOnly';
const SLOT_TEMPERATURE = 0.42;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'active-onSettingsPresetChange',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CARD_AVATAR,
        overrides: {
            name: CARD_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            { name: SLOT_NAME, preset: { temperature: SLOT_TEMPERATURE, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: SLOT_NAME,
                    },
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

test.describe('#60 — characterBoundPresetState.active ≡ ghost DOM-selected (Invariant I / III)', () => {
    test('active tracks ghost DOM selection; previousPreset survives ghost → global toggle', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CARD_NAME);

        // (a) Default slot auto-applied → ghost option DOM-selected → active
        // should be true; previousPreset should have been normalised from
        // the pre-ghost 'Default' global preset that normalizeIterStudioSettings
        // seeded as oai_settings.preset_settings_openai.
        await page.waitForFunction(
            () => typeof window.__characterBoundPresetState !== 'undefined'
                && window.__characterBoundPresetState.active === true,
            { timeout: 15_000 },
        );
        const afterAutoApply = await page.evaluate(() => ({
            active: window.__characterBoundPresetState.active,
            previousPreset: window.__characterBoundPresetState.previousPreset,
            ghostSelected: !!document.querySelector(
                '#settings_preset_openai option[data-luker-char-bound="1"]:checked',
            ),
        }));
        expect(afterAutoApply.active).toBe(true);
        expect(afterAutoApply.ghostSelected).toBe(true);
        expect(typeof afterAutoApply.previousPreset).toBe('string');
        expect(afterAutoApply.previousPreset.length).toBeGreaterThan(0);

        const stashedPrevious = afterAutoApply.previousPreset;

        // (b) Manually switch to the global 'Default' preset. Use jQuery
        // .val().trigger('change') because select2 hides the native
        // <select>, and Playwright's selectOption refuses hidden targets.
        // This IS a real DOM change event — the handler under test fires.
        await page.evaluate(() => {
            const $ = window.jQuery;
            const opts = Array.from(document.querySelectorAll('#settings_preset_openai option'));
            const target = opts.find(o =>
                o.textContent.trim() === 'Default'
                && o.getAttribute('data-luker-char-bound') !== '1',
            );
            if (!target) throw new Error('global Default option not found');
            $('#settings_preset_openai').val(target.value).trigger('change');
        });
        await page.waitForFunction(
            () => window.__characterBoundPresetState.active === false,
            { timeout: 10_000 },
        );
        const afterSwitchToGlobal = await page.evaluate(() => ({
            active: window.__characterBoundPresetState.active,
            previousPreset: window.__characterBoundPresetState.previousPreset,
            ghostSelected: !!document.querySelector(
                '#settings_preset_openai option[data-luker-char-bound="1"]:checked',
            ),
        }));
        expect(afterSwitchToGlobal.active).toBe(false);
        expect(afterSwitchToGlobal.ghostSelected).toBe(false);
        // Invariant III: exiting ghost selection MUST NOT clear
        // previousPreset. The restore path inside
        // maybeApplyCharacterBoundPreset (openai.js) hasn't run — we
        // didn't switch groups or clear the boundList.
        expect(afterSwitchToGlobal.previousPreset).toBe(stashedPrevious);

        // (c) Switch back to the ghost option. The card only has one slot,
        // so we can find the single ghost <option> directly.
        await page.evaluate(() => {
            const $ = window.jQuery;
            const ghost = document.querySelector(
                '#settings_preset_openai option[data-luker-char-bound="1"]',
            );
            if (!ghost) throw new Error('ghost option not found');
            $('#settings_preset_openai').val(ghost.value).trigger('change');
        });
        await page.waitForFunction(
            () => window.__characterBoundPresetState.active === true,
            { timeout: 10_000 },
        );
        const afterSwitchBack = await page.evaluate(() => ({
            active: window.__characterBoundPresetState.active,
            previousPreset: window.__characterBoundPresetState.previousPreset,
            ghostSelected: !!document.querySelector(
                '#settings_preset_openai option[data-luker-char-bound="1"]:checked',
            ),
        }));
        expect(afterSwitchBack.active).toBe(true);
        expect(afterSwitchBack.ghostSelected).toBe(true);
        // previousPreset was re-stashed on the second ghost entry from
        // the now-stale 'Default' name. Assert it's still non-empty; we
        // don't demand literal equality with stashedPrevious because the
        // resolver may return the canonical global-library casing which
        // happens to equal 'Default' but expressing that as a literal
        // makes the test brittle to future casing / accent changes.
        expect(afterSwitchBack.previousPreset.length).toBeGreaterThan(0);
    });
});
