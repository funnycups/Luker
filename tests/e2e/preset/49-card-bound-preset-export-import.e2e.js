// #49 — Card-bound preset export → re-import round-trip.
//
// Exports a character card carrying multi-slot card-bound presets, deletes
// the source, re-imports the exported PNG, and asserts every observable
// property of the card-bound state survived intact:
//
//   1. Ghost `<optgroup data-luker-card-bound="1">` renders both slots
//      in #settings_preset_openai.
//   2. The default preset (Slot1) auto-applied to the DOM inputs
//      (#temp_counter_openai) on character-select.
//   3. `ctx.character.presets.list(...)` returns both slot entries.
//   4. On-disk parse of the newly-imported PNG confirms the shape
//      `data.extensions.luker.chat_completion_preset = { presets:[...],
//      defaultPresetName:'Slot1' }` survived the round-trip.
//
// Real UI throughout — right-drawer + character-edit panel + visible
// `#export_button` + PNG format button; import via the visible
// `#character_import_button` icon + hidden `#character_import_file` input
// (the standard Playwright pattern for file pickers). Only mock is
// mockLLM (a no-op here — this test doesn't do LLM work).

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter, disableTagImportPopup, clickCharacterCard, openCharacterEditPanel } from '../character/_helpers.js';
import { importCharacterFile, deleteSelectedCharacter } from '../_lib/ui-character.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

let server, mock;

const SRC_CHAR_NAME = 'Elyra the Emissary';
const SRC_CHAR_AVATAR = 'elyra-the-emissary.png';

const SLOT1_NAME = 'Slot1';
const SLOT2_NAME = 'Slot2';
const SLOT1_TEMP = 0.23;
const SLOT2_TEMP = 0.77;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'card-bound-preset-export-import',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: SRC_CHAR_AVATAR,
        overrides: {
            name: SRC_CHAR_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            { name: SLOT1_NAME, preset: { temperature: SLOT1_TEMP, chat_completion_source: 'openai' } },
                            { name: SLOT2_NAME, preset: { temperature: SLOT2_TEMP, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: SLOT1_NAME,
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

/**
 * Export the currently-selected character as PNG via the real
 * `#export_button` (character edit panel) → `.export_format[data-format=png]`
 * gesture. Returns a Playwright Download object.
 */
async function exportSelectedCharacterAsPng(page) {
    const dl = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator('#export_button').click();
    // The Popper-mounted export format popup renders with the PNG /
    // JSON options; click the PNG format entry.
    const pngOption = page.locator('.export_format[data-format="png"]').first();
    await pngOption.waitFor({ state: 'visible', timeout: 5000 });
    await pngOption.click();
    return dl;
}

/**
 * Read the card-bound state for the currently-selected character via
 * the ctx surface. page.evaluate is used for state
 * observation only.
 */
async function readCardBoundStateForActive(page) {
    return page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const chid = ctx?.characterId ?? window.this_chid;
        const c = ctx?.characters?.[chid];
        const listApi = ctx?.character?.presets?.list;
        return {
            name: c?.name || null,
            avatar: c?.avatar || null,
            presetsFromCtxApi: typeof listApi === 'function'
                ? listApi(c).map(e => ({ name: e.name, isDefault: !!e.isDefault, hasBody: !!e.preset }))
                : null,
            raw: c?.data?.extensions?.luker?.chat_completion_preset ?? null,
        };
    });
}

test.describe('#49 — card-bound preset export/import round-trip preserves shape', () => {
    test('export PNG → delete source → import PNG → ghost optgroup + default auto-apply + on-disk shape survive', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // ── Step 1: select source character and verify baseline ────────
        await selectCharacterByName(page, SRC_CHAR_NAME);
        // Card-bound optgroup renders on select; wait for it.
        await page.waitForFunction(() => {
            const sel = document.querySelector('#settings_preset_openai');
            const opt = sel?.querySelector('option[data-luker-char-bound="1"]');
            return Boolean(opt) && String(sel.value) === String(opt.value);
        }, { timeout: 15_000 });
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(SLOT1_TEMP, 5);

        // ── Step 2: open edit panel for the source and export as PNG ──
        // selectCharacterByName closes the right drawer after picking; the
        // export button (#export_button) lives inside the character edit
        // panel and is display:none until the drawer + edit view are
        // both open. openCharacterEditPanel re-opens the drawer and
        // switches to the edit view.
        await openCharacterEditPanel(page);
        const download = await exportSelectedCharacterAsPng(page);
        const exportedPath = resolve(server.dataRoot, '_e2e_exported_character.png');
        await download.saveAs(exportedPath);

        // Sanity: the exported PNG carries the expected chat_completion_preset
        // block (proves export DOESN'T strip Layer 1 fields).
        const exportedPng = readFileSync(exportedPath);
        const exportedCard = JSON.parse(readPngCard(exportedPng));
        const exportedBoundState = exportedCard?.data?.extensions?.luker?.chat_completion_preset;
        expect(exportedBoundState).toBeTruthy();
        expect(exportedBoundState.defaultPresetName).toBe(SLOT1_NAME);
        expect(Array.isArray(exportedBoundState.presets)).toBe(true);
        expect(exportedBoundState.presets.map(p => p.name)).toEqual([SLOT1_NAME, SLOT2_NAME]);

        // ── Step 3: delete the source character ────────────────────────
        // Re-open the edit panel first — the export flow's popper popup
        // dismissal can inadvertently close the right drawer.
        await openCharacterEditPanel(page);
        await deleteSelectedCharacter(page);
        // Wait until the character is truly gone from the ctx list to
        // confirm delete propagated (list reflection is async through
        // getCharacters()).
        await page.waitForFunction((n) => {
            const ctx = window.Luker?.getContext?.();
            return Array.isArray(ctx?.characters) && !ctx.characters.some(c => c?.name === n);
        }, SRC_CHAR_NAME, { timeout: 15_000 });

        // ── Step 4: re-import the exported PNG via real gestures ──────
        await importCharacterFile(page, {
            filePath: exportedPath,
            expectedName: SRC_CHAR_NAME,
        });

        // ── Step 5: select the imported character and re-assert state ─
        await clickCharacterCard(page, SRC_CHAR_NAME);
        // Wait for a chat-open + auto-select preset to finish. The card
        // click routes through openCharacterChat which triggers
        // autoSelectPreset; wait until the ghost option is selected.
        await page.waitForFunction(() => {
            const sel = document.querySelector('#settings_preset_openai');
            const opt = sel?.querySelector('option[data-luker-char-bound="1"]');
            return Boolean(opt) && String(sel.value) === String(opt.value);
        }, { timeout: 20_000 });

        // Assertion 1: ghost optgroup carries BOTH slot options.
        const optgroupSlotNames = await page.evaluate(() => {
            const sel = document.querySelector('#settings_preset_openai');
            const group = sel?.querySelector('optgroup[data-luker-card-bound="1"]');
            if (!group) return null;
            return Array.from(group.querySelectorAll('option')).map(o => o.textContent.trim());
        });
        expect(optgroupSlotNames).toContain(SLOT1_NAME);
        expect(optgroupSlotNames).toContain(SLOT2_NAME);

        // Assertion 2: default preset auto-applied (temperature matches
        // Slot1 seed value).
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(SLOT1_TEMP, 5);

        // Assertion 3: ctx.character.presets.list returns both slots.
        const state = await readCardBoundStateForActive(page);
        expect(state.name).toBe(SRC_CHAR_NAME);
        expect(state.presetsFromCtxApi).not.toBeNull();
        const byName = Object.fromEntries(state.presetsFromCtxApi.map(e => [e.name, e]));
        expect(byName[SLOT1_NAME]).toEqual({ name: SLOT1_NAME, isDefault: true, hasBody: true });
        expect(byName[SLOT2_NAME]).toEqual({ name: SLOT2_NAME, isDefault: false, hasBody: true });

        // Assertion 4: on-disk parse of the NEWLY-IMPORTED PNG (Luker's
        // uploader materializes the file back into characters/), confirms
        // the chat_completion_preset shape survived import.
        const importedAvatar = state.avatar;
        expect(importedAvatar).toBeTruthy();
        const importedPath = resolve(server.dataRoot, 'default-user', 'characters', importedAvatar);
        const importedPng = readFileSync(importedPath);
        const importedCard = JSON.parse(readPngCard(importedPng));
        const importedBound = importedCard?.data?.extensions?.luker?.chat_completion_preset;
        expect(importedBound).toBeTruthy();
        expect(importedBound.defaultPresetName).toBe(SLOT1_NAME);
        expect(Array.isArray(importedBound.presets)).toBe(true);
        expect(importedBound.presets.map(p => p.name)).toEqual([SLOT1_NAME, SLOT2_NAME]);
        expect(importedBound.presets.find(p => p.name === SLOT1_NAME)?.preset?.temperature)
            .toBeCloseTo(SLOT1_TEMP, 5);
        expect(importedBound.presets.find(p => p.name === SLOT2_NAME)?.preset?.temperature)
            .toBeCloseTo(SLOT2_TEMP, 5);
    });
});
