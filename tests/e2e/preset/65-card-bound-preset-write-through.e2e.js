// #65 — Card-bound presets must accept writes through the upstream
// preset API.
//
// Upstream consumers (JS-Slash-Runner, TavernHelper, per-preset variable
// schemas) read `getPresetList().presets[index]`, mutate the body, then
// call `presetManager.savePreset(name, body)`. For a global preset this
// mutates the live preset cache and persists through the normal save
// path.
//
// Card-bound presets previously returned a fresh structuredClone on every
// read, so the mutation was written to a throwaway object. `savePreset`
// also always went to the global preset file, even when the selected
// preset was a card-bound slot.
//
// This asserts the full contract:
//   - repeated reads return the same live body reference;
//   - mutating it and saving persists to the character card;
//   - the change is visible in the active settings immediately;
//   - no global preset file is created;
//   - the value survives a reload.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let fileScope;

test.beforeAll(async ({ workerResources }, testInfo) => {
    fileScope = await workerResources.scenario(testInfo.file);
});

let server, mock;

const CHAR_NAME = 'Wren Write Through';
const CHAR_AVATAR = 'wren-write-through.png';
const CARD_PRESET_NAME = 'CardBoundWriteThrough';
const INITIAL_TEMP = 0.37;
const NEXT_TEMP = 0.91;
const INITIAL_SCRIPT = { name: 'InitialScript', code: 'return "initial"' };
const NEXT_SCRIPT = { name: 'WriteThroughScript', code: 'return "written"' };

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ scope: fileScope,
        batchKey: 'preset',
        scenarioId: 'card-bound-preset-write-through',
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
                                temperature: INITIAL_TEMP,
                                chat_completion_source: 'openai',
                                extensions: {
                                    tavern_helper: { scripts: [INITIAL_SCRIPT] },
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

async function openCardBoundCharacter(page) {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, CHAR_NAME);
    await page.waitForFunction(() => {
        const opt = document.querySelector('#settings_preset_openai option:checked');
        return opt && opt.getAttribute('data-luker-char-bound') === '1';
    }, { timeout: 15_000 });
}

test.describe('#65 — card-bound preset write-through', () => {
    test('mutating the live body and saving persists to the card and applies immediately', async ({ page }) => {
        await openCardBoundCharacter(page);

        const result = await page.evaluate(async ({ presetName, nextTemp, nextScript }) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const { getChatCompletionPreset, oai_settings } = await import('/scripts/openai.js');
            const pm = getPresetManager('openai');

            const first = pm.getPresetList();
            const selectedId = Number(pm.getSelectedPreset());
            const body = first.presets[selectedId];

            const second = pm.getPresetList();
            const sameReference = second.presets[Number(pm.getSelectedPreset())] === body;

            body.temperature = nextTemp;
            body.extensions = body.extensions || {};
            body.extensions.tavern_helper = body.extensions.tavern_helper || {};
            body.extensions.tavern_helper.scripts = [nextScript];

            await pm.savePreset(presetName, body, { skipUpdate: true });

            const after = pm.getPresetList();
            const afterBody = after.presets[Number(pm.getSelectedPreset())];
            const raw = pm.getPresetListRaw();
            const activeBody = getChatCompletionPreset(oai_settings, { includeConnectionFields: false });

            return {
                sameReference,
                afterBodyIsSameReference: afterBody === body,
                bodyTemp: afterBody?.temperature,
                activeTemp: activeBody?.temperature,
                bodyScript: afterBody?.extensions?.tavern_helper?.scripts?.[0]?.name,
                activeScript: activeBody?.extensions?.tavern_helper?.scripts?.[0]?.name,
                globalPresetExists: Object.hasOwn(raw.preset_names || {}, presetName),
            };
        }, { presetName: CARD_PRESET_NAME, nextTemp: NEXT_TEMP, nextScript: NEXT_SCRIPT });

        expect(result.sameReference, 'repeated getPresetList() reads must return the same live body').toBe(true);
        expect(result.afterBodyIsSameReference, 'save must not replace the live body reference').toBe(true);
        expect(result.bodyTemp, 'saved body must retain the new value').toBe(NEXT_TEMP);
        expect(result.activeTemp, 'saved change must apply to oai_settings immediately').toBe(NEXT_TEMP);
        expect(result.bodyScript, 'saved body must retain the new extension value').toBe(NEXT_SCRIPT.name);
        expect(result.activeScript, 'saved extension change must apply to oai_settings immediately').toBe(NEXT_SCRIPT.name);
        expect(result.globalPresetExists, 'card-bound save must not create a global preset').toBe(false);

        // Reload: the value must come back from the character card, not
        // from the previous page's in-memory state.
        await page.reload();
        await openCardBoundCharacter(page);

        const persisted = await page.evaluate(async ({ presetName }) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const pm = getPresetManager('openai');
            const body = pm.getCompletionPresetByName(presetName);
            return {
                temp: body?.temperature,
                script: body?.extensions?.tavern_helper?.scripts?.[0]?.name,
            };
        }, { presetName: CARD_PRESET_NAME });

        expect(persisted.temp, 'temperature must survive a reload').toBe(NEXT_TEMP);
        expect(persisted.script, 'extension value must survive a reload').toBe(NEXT_SCRIPT.name);
    });
});
