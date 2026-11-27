// #64 — Card-bound preset must be resolvable via the upstream third-party
// consumer idiom.
//
// Upstream SillyTavern's implicit contract is that the currently-selected
// preset body is always reachable via BOTH of:
//
//   pm.getPresetList().presets[Number(pm.getSelectedPreset())]
//   pm.getPresetList().presets[pm.getPresetList().preset_names[pm.getSelectedPresetName()]]
//
// Third-party extensions rely on this — JS-Slash-Runner's
// `usePresetSettingsStore` / `usePresetScriptsStore`
// (src/store/settings/preset.ts) uses the numeric-index idiom, per-preset
// variable schemas use the name-lookup idiom, and TavernHelper's
// `tavern_regex` module reads `preset.extensions.regex_scripts` after
// resolving the preset by name.
//
// Luker's card-bound preset is rendered as a ghost `<option>` whose value
// is an opaque encoded sentinel (`__luker_card__::<enc(avatar)>::<enc(name)>`)
// and whose textContent is the card-slot name (which is NOT a key in
// `openai_setting_names`). Without the compatibility layer:
//
//   - `Number(pm.getSelectedPreset())` → `NaN`
//   - `presets[NaN]` → `undefined`
//   - `preset_names[name]` → `undefined`
//   - `presets[preset_names[name]]` → `undefined`
//
// Third-party stores then silently drop their per-preset state.
//
// The fix synthesizes a read-only row for the active ghost body into
// `getPresetList().presets` + `preset_names`, and `getSelectedPreset()`
// returns the synthesized numeric index. This asserts BOTH idioms
// resolve to the card body when a card-bound preset is active.
//
// Also asserts the specific field third-party consumers most commonly
// read (`preset.extensions.<field>`) is reachable and equals what the
// card stored, so a regression in the synth wiring is caught at the
// consumer surface rather than only at the plumbing layer.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CHAR_NAME = 'Wren the Third-Party Consumer';
const CHAR_AVATAR = 'wren-the-third-party-consumer.png';
const CARD_PRESET_NAME = 'CardBoundBody';
const CARD_TEMP = 0.37;
// Sentinel value under `extensions.tavern_helper.scripts` mirrors what
// JS-Slash-Runner writes at `preset.extensions.tavern_helper.scripts`
// — resolving to this proves the compat layer works end-to-end for the
// exact field the reported bug is about.
const SENTINEL_SCRIPT = { name: 'ExampleScript', code: 'return "ok"' };

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'preset',
        scenarioId: 'card-bound-third-party-compat',
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
                        presets: [{
                            name: CARD_PRESET_NAME,
                            preset: {
                                temperature: CARD_TEMP,
                                chat_completion_source: 'openai',
                                extensions: {
                                    tavern_helper: { scripts: [SENTINEL_SCRIPT] },
                                },
                            },
                        }],
                        defaultPresetName: CARD_PRESET_NAME,
                    },
                },
            },
        },
    });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#64 — card-bound preset resolves via upstream third-party idioms', () => {
    test('both numeric-index and name-lookup idioms resolve to the card body', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        // Wait for the card-bound preset to auto-apply (ghost option
        // becomes the currently-selected option on #settings_preset_openai).
        await page.waitForFunction(() => {
            const opt = document.querySelector('#settings_preset_openai option:checked');
            return opt && opt.getAttribute('data-luker-char-bound') === '1';
        }, { timeout: 15_000 });

        // Snapshot the third-party consumer surface. This is READ-ONLY
        // state inspection via page.evaluate (allowed per e2e rules —
        // no product behavior is triggered from evaluate, only observed).
        const consumerView = await page.evaluate(async ({ presetName }) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const pm = getPresetManager('openai');

            const selectedId = pm.getSelectedPreset();
            const selectedName = pm.getSelectedPresetName();
            const list = pm.getPresetList();

            // Idiom A: numeric-index. Upstream contract:
            //   presets[Number(getSelectedPreset())] === active body.
            const numericIdx = Number(selectedId);
            const bodyViaIndex = list.presets[numericIdx];

            // Idiom B: name-lookup. Upstream contract:
            //   presets[preset_names[getSelectedPresetName()]] === active body.
            const namedIdx = list.preset_names?.[selectedName];
            const bodyViaName = Number.isInteger(namedIdx) ? list.presets[namedIdx] : undefined;

            // Idiom C: getCompletionPresetByName (used by TavernHelper
            // `tavern_regex.js` and elsewhere). Should also resolve to
            // the card body.
            const bodyViaCompletionApi = pm.getCompletionPresetByName(selectedName);

            return {
                selectedId: String(selectedId ?? ''),
                selectedName: String(selectedName ?? ''),
                numericIdxIsInt: Number.isInteger(numericIdx),
                indexFound: bodyViaIndex !== undefined && bodyViaIndex !== null,
                nameFound: bodyViaName !== undefined && bodyViaName !== null,
                completionApiFound: bodyViaCompletionApi !== undefined && bodyViaCompletionApi !== null,
                // Concrete asserts on the reachable body so a regression
                // that returns the WRONG body still fails.
                indexBodyTemp: bodyViaIndex?.temperature,
                indexBodyScriptName: bodyViaIndex?.extensions?.tavern_helper?.scripts?.[0]?.name,
                nameBodyTemp: bodyViaName?.temperature,
                nameBodyScriptName: bodyViaName?.extensions?.tavern_helper?.scripts?.[0]?.name,
                // The selected-name string itself must equal the card slot
                // (not the encoded ghost value); already asserted implicitly
                // by other card-bound e2es, we cross-check here too.
                selectedNameMatchesCardSlot: selectedName === presetName,
            };
        }, { presetName: CARD_PRESET_NAME });

        console.log('third-party consumer view:', JSON.stringify(consumerView, null, 2));

        expect(consumerView.selectedNameMatchesCardSlot, 'ghost option textContent must equal card slot name').toBe(true);
        expect(consumerView.numericIdxIsInt, 'Number(getSelectedPreset()) must produce a valid array index (bug#3 root)').toBe(true);
        expect(consumerView.indexFound, 'presets[Number(getSelectedPreset())] must resolve to the card body').toBe(true);
        expect(consumerView.nameFound, 'presets[preset_names[name]] must resolve to the card body').toBe(true);
        expect(consumerView.completionApiFound, 'getCompletionPresetByName(name) must resolve to the card body').toBe(true);

        // Concrete body content checks — proves the resolved body is
        // actually the card body (not some collided global preset).
        expect(consumerView.indexBodyTemp, 'numeric-index resolution must return the card body (temperature)').toBe(CARD_TEMP);
        expect(consumerView.indexBodyScriptName, 'numeric-index resolution must reach preset.extensions.tavern_helper.scripts[0].name').toBe(SENTINEL_SCRIPT.name);
        expect(consumerView.nameBodyTemp, 'name-lookup resolution must return the card body (temperature)').toBe(CARD_TEMP);
        expect(consumerView.nameBodyScriptName, 'name-lookup resolution must reach preset.extensions.tavern_helper.scripts[0].name').toBe(SENTINEL_SCRIPT.name);
    });

    test('reverting to a non-card-bound selection removes the synthesized row', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        await page.waitForFunction(() => {
            const opt = document.querySelector('#settings_preset_openai option:checked');
            return opt && opt.getAttribute('data-luker-char-bound') === '1';
        }, { timeout: 15_000 });

        // Baseline: synth row present.
        const withGhost = await page.evaluate(async ({ presetName }) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const list = getPresetManager('openai').getPresetList();
            return {
                hasSynthRow: presetName in (list.preset_names || {}),
                presetsLength: list.presets.length,
            };
        }, { presetName: CARD_PRESET_NAME });
        expect(withGhost.hasSynthRow).toBe(true);

        // Pick a global preset (any one that isn't the ghost) via a real
        // DOM change on the selector, then re-check.
        const switched = await page.evaluate(() => {
            const $sel = jQuery('#settings_preset_openai');
            const opts = $sel.find('option').filter(function () {
                const el = /** @type {HTMLOptionElement} */ (this);
                return el.getAttribute('data-luker-char-bound') !== '1'
                    && !isNaN(Number(el.value))
                    && el.value !== '';
            });
            if (!opts.length) return { switched: false };
            const target = opts.first().val();
            $sel.val(target).trigger('change');
            return { switched: true, targetValue: String(target) };
        });
        expect(switched.switched, 'test setup: at least one non-card global preset must exist to switch to').toBe(true);

        // Give OAI_PRESET_CHANGED_AFTER + settling a beat.
        await page.waitForTimeout(500);

        const withoutGhost = await page.evaluate(async ({ presetName }) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const list = getPresetManager('openai').getPresetList();
            return {
                hasSynthRow: presetName in (list.preset_names || {}),
                presetsLength: list.presets.length,
            };
        }, { presetName: CARD_PRESET_NAME });

        expect(withoutGhost.hasSynthRow, 'synth row must be removed when ghost is no longer selected').toBe(false);
        // presets length should shrink back by exactly 1 (the synth row).
        expect(withoutGhost.presetsLength, 'presets array must shrink to non-synth length after ghost is deselected').toBe(withGhost.presetsLength - 1);
    });

    test('same-name collision with a global preset exposes active card-bound body and restores global body on switch', async ({ page }) => {
        // When a global preset shares the same name as the active card-bound
        // preset, getPresetList() must expose the active card-bound body at
        // that name slot (never the inactive global preset), while keeping the
        // raw global store intact and restoring the global body once the user
        // switches to the global preset.
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        await page.waitForFunction(() => {
            const opt = document.querySelector('#settings_preset_openai option:checked');
            return opt && opt.getAttribute('data-luker-char-bound') === '1';
        }, { timeout: 15_000 });

        // Create a global preset with the SAME name as the active card slot,
        // keeping the card-bound ghost selected (select: false).
        const created = await page.evaluate(async ({ collideName }) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const pm = getPresetManager('openai');
            const currentBody = pm.getCompletionPresetByName(pm.getSelectedPresetName());
            const globalBody = JSON.parse(JSON.stringify(currentBody || {}));
            globalBody.temperature = 0.99; // distinct from card-bound temperature
            globalBody.extensions = globalBody.extensions || {};
            globalBody.extensions.tavern_helper = { scripts: [{ name: 'GlobalDifferent', code: 'return "global"' }] };
            await pm.savePreset(collideName, globalBody, { skipUpdate: false, select: false });

            const raw = pm.getPresetListRaw();
            const rawIdx = raw.preset_names[collideName];
            const list = pm.getPresetList();
            const activeIdx = list.preset_names[collideName];
            const selectedValue = pm.getSelectedPreset();
            return {
                stillCardBound: document.querySelector('#settings_preset_openai option:checked')?.getAttribute('data-luker-char-bound') === '1',
                rawTemp: raw.presets[rawIdx]?.temperature,
                rawScriptName: raw.presets[rawIdx]?.extensions?.tavern_helper?.scripts?.[0]?.name,
                activeTemp: list.presets[activeIdx]?.temperature,
                activeScriptName: list.presets[activeIdx]?.extensions?.tavern_helper?.scripts?.[0]?.name,
                bySelectedIdxTemp: list.presets[Number(selectedValue)]?.temperature,
            };
        }, { collideName: CARD_PRESET_NAME });

        expect(created.stillCardBound, 'card-bound ghost must stay selected when creating colliding global preset with select: false').toBe(true);
        expect(created.rawTemp, 'raw global preset store keeps the global preset intact').toBe(0.99);
        expect(created.rawScriptName).toBe('GlobalDifferent');
        expect(created.activeTemp, 'active card-bound preset must shadow the colliding global slot in getPresetList()').toBe(CARD_TEMP);
        expect(created.activeScriptName).toBe(SENTINEL_SCRIPT.name);
        expect(created.bySelectedIdxTemp).toBe(CARD_TEMP);

        // Switching the dropdown to the global option exposes the global body.
        const afterSwitchToGlobal = await page.evaluate(async ({ collideName }) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const pm = getPresetManager('openai');
            const raw = pm.getPresetListRaw();
            const globalOptionValue = String(raw.preset_names[collideName]);
            const sel = document.querySelector('#settings_preset_openai');
            sel.value = globalOptionValue;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 100));

            const list = pm.getPresetList();
            const idx = list.preset_names[collideName];
            return {
                isCardBound: document.querySelector('#settings_preset_openai option:checked')?.getAttribute('data-luker-char-bound') === '1',
                temp: list.presets[idx]?.temperature,
                scriptName: list.presets[idx]?.extensions?.tavern_helper?.scripts?.[0]?.name,
            };
        }, { collideName: CARD_PRESET_NAME });

        expect(afterSwitchToGlobal.isCardBound).toBe(false);
        expect(afterSwitchToGlobal.temp, 'switching to the global preset must expose the global body').toBe(0.99);
        expect(afterSwitchToGlobal.scriptName).toBe('GlobalDifferent');
    });
});
