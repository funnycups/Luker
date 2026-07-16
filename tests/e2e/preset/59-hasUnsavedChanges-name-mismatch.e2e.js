// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #59 — hasUnsavedOpenAIPresetChanges falls back to the global-library
//        short-circuit when the ghost option is DOM-selected but the caller
//        asks about a DIFFERENT name — the same policy the save-dispatch
//        helper uses (save-dispatch.js:70-72). Wired-up counterpart to
//        openai-has-unsaved-changes.test.js case 7.
//
// This mirrors the "user opens New Preset dialog while a card slot is
// active" flow: intent is to talk about the global preset library, not
// the currently-selected card slot. Old code always used the global
// library regardless of the selection, so this test's `false` result also
// matches old behaviour — but only for THIS specific dispatch case. The
// asymmetric test (58) is what proves the origin-branch actually fires;
// this test locks the fallback so a future refactor doesn't turn every
// call under a ghost selection into a character-branch lookup.
//
// REAL USER-GESTURE flow:
//   1. Seed a card with card-bound slot `X { temperature: 0.5 }` (default).
//   2. Seed a global preset `OtherName { temperature: 0.5 }` on disk.
//   3. Load Luker; select the card so the ghost auto-applies → live
//      oai_settings.temperature = 0.5.
//   4. Call `ctx.openai.hasUnsavedChanges('OtherName')`. Ref decodes to
//      `{name: 'X', origin: character}` — name mismatch → global-branch
//      dispatch. Global body (0.5) equals live (0.5) → false.
//   5. Call with a name that exists in NEITHER library → false (global
//      branch short-circuits on missing settingName index).

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CARD_NAME = 'Name Mismatch Card';
const CARD_AVATAR = 'name-mismatch-card.png';
const SLOT_NAME = 'X';
const OTHER_GLOBAL_NAME = 'OtherName';
const SHARED_TEMPERATURE = 0.5;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'hasUnsaved-name-mismatch',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const globalPresetPath = path.join(
        server.dataRoot,
        'default-user',
        'OpenAI Settings',
        `${OTHER_GLOBAL_NAME}.json`,
    );
    fs.mkdirSync(path.dirname(globalPresetPath), { recursive: true });
    fs.writeFileSync(globalPresetPath, JSON.stringify({
        temperature: SHARED_TEMPERATURE,
        chat_completion_source: 'openai',
    }, null, 4));

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CARD_AVATAR,
        overrides: {
            name: CARD_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            { name: SLOT_NAME, preset: { temperature: SHARED_TEMPERATURE, chat_completion_source: 'openai' } },
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

test.describe('#59 — hasUnsavedChanges under a ghost selection with a name mismatch falls through to global-library dispatch', () => {
    test('ref.name ≠ requested name → global branch; unknown name early-exits false', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CARD_NAME);

        // Card default auto-applied → ghost active, live temp settled.
        await page.waitForFunction(
            () => typeof window.__characterBoundPresetState !== 'undefined'
                && window.__characterBoundPresetState.active === true,
            { timeout: 15_000 },
        );
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(SHARED_TEMPERATURE, 5);

        // Confirm both libraries carry what the setup demands so a bogus
        // pass (e.g. missing global) can't sneak through.
        const librarySanity = await page.evaluate(({ otherName }) => {
            const ctx = window.Luker?.getContext?.();
            const settingNames = ctx?.openai?.settingNames;
            const settings = ctx?.openai?.settings;
            const idx = settingNames?.[otherName];
            return {
                otherIndex: Number.isInteger(idx) ? idx : null,
                otherTemp: (Number.isInteger(idx) && settings?.[idx]) ? settings[idx].temperature : null,
            };
        }, { otherName: OTHER_GLOBAL_NAME });
        expect(librarySanity.otherIndex).not.toBeNull();
        expect(librarySanity.otherTemp).toBeCloseTo(SHARED_TEMPERATURE, 5);

        // Ref decodes to {name: 'X', origin: character}. Caller asks about
        // 'OtherName' → name mismatch → global branch. Global body ==
        // live body → false.
        const unsavedOther = await page.evaluate((name) => {
            const ctx = window.Luker?.getContext?.();
            return ctx?.openai?.hasUnsavedChanges?.(name);
        }, OTHER_GLOBAL_NAME);
        expect(unsavedOther).toBe(false);

        // Unknown name → global branch short-circuits on missing index → false.
        const unsavedUnknown = await page.evaluate(() => {
            const ctx = window.Luker?.getContext?.();
            return ctx?.openai?.hasUnsavedChanges?.('DefinitelyNotAPreset');
        });
        expect(unsavedUnknown).toBe(false);
    });
});
