// #64b — Verify the real JS-Slash-Runner (TavernHelper) extension can
// read regex_scripts embedded in a card-bound preset.
//
// This is a live-integration test: the ext bundle is served from the
// repo's own `public/scripts/extensions/third-party/JS-Slash-Runner/`
// path (which every scratch server inherits), boots via
// `initTavernHelperObject` at ext-startup, then exposes a `TavernHelper`
// global. We wait for that global, open a card with a card-bound preset
// that embeds a regex script under `preset.extensions.regex_scripts`,
// and call `TavernHelper.getTavernRegexes({type:'preset', name})` — the
// same function 3rd-party consumers call — asserting it returns the
// card's script.
//
// The ext's `getTavernRegexes({type, name})` resolves the preset body
// via `preset_manager.getCompletionPresetByName(name)`. Before the
// synth-row fix, the card slot name is not a key in the global
// `openai_setting_names`, so `getCompletionPresetByName(name)` returns
// undefined and `getTavernRegexes` returns []. After the fix, the
// active card-bound ghost body is exposed under its slot name and
// `getTavernRegexes` returns the card scripts.
//
// Skips gracefully if TavernHelper's ext dir + built bundle are not
// present in the repo (e.g. cold clones without local vendor copies).

import { test, expect } from '@playwright/test';
import { existsSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

const REPO_ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const HOST_TH_DIR = resolve(REPO_ROOT, 'public/scripts/extensions/third-party/JS-Slash-Runner');

const HAS_TAVERN_HELPER = existsSync(resolve(HOST_TH_DIR, 'dist/index.js'));

let server, mock;

const CHAR_NAME = 'Regexer with Bound Card';
const CHAR_AVATAR = 'regexer-with-bound-card.png';
const CARD_PRESET_NAME = 'CardBoundRegexBody';

// A regex script the ext should be able to see through its own read API.
const CARD_REGEX = {
    id: '99999999-9999-4999-8999-999999999999',
    scriptName: 'CardBoundEcho',
    findRegex: '/echo/gi',
    replaceString: '<<ECHOED>>',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    pluginOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
};

test.skip(!HAS_TAVERN_HELPER, 'JS-Slash-Runner (TavernHelper) not installed in host third-party dir; skipping live-integration');

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'jsr-live-integration',
        extraConfig: { 'storage.mode': 'fs' },
    });

    // Symlink the ext into the scratch dataRoot's global-extensions
    // discovery path (the host directory the server serves from is the
    // repo's own `public/scripts/extensions/third-party/` — which
    // scratchServers inherit through the repo checkout, so no per-worker
    // symlink is needed. This is a no-op assertion that it's really there).
    expect(existsSync(HOST_TH_DIR), 'JS-Slash-Runner dir must exist in repo').toBe(true);
    expect(existsSync(resolve(HOST_TH_DIR, 'dist/index.js')), 'JS-Slash-Runner dist/index.js must be built').toBe(true);

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
                                temperature: 0.42,
                                chat_completion_source: 'openai',
                                extensions: {
                                    regex_scripts: [CARD_REGEX],
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
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#64b — JS-Slash-Runner live-integration reads card-bound preset regex_scripts', () => {
    test('TavernHelper.getTavernRegexes({type:"preset", name}) returns the card body scripts', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Wait for TavernHelper's global to appear (its own bootstrap
        // runs during ext-init on APP_READY).
        await page.waitForFunction(
            () => typeof globalThis.TavernHelper === 'object' && globalThis.TavernHelper !== null && typeof globalThis.TavernHelper.getTavernRegexes === 'function',
            { timeout: 30_000 },
        );

        await selectCharacterByName(page, CHAR_NAME);

        // Wait for the ghost card-bound option to become selected.
        await page.waitForFunction(() => {
            const opt = document.querySelector('#settings_preset_openai option:checked');
            return opt && opt.getAttribute('data-luker-char-bound') === '1';
        }, { timeout: 15_000 });

        // Give the ext a beat to react to PRESET_CHANGED / CHAT_CHANGED.
        await page.waitForTimeout(1000);

        // Snapshot three ext-level surfaces:
        //   (a) getTavernRegexes({type:'preset'})                 — default name is 'in_use'
        //   (b) getTavernRegexes({type:'preset', name:'in_use'})  — explicit in_use
        //   (c) getTavernRegexes({type:'preset', name:<slot>})    — resolves via getCompletionPresetByName(name)
        //
        // (a) and (b) both read `oai_settings.extensions.regex_scripts` — which
        // onSettingsPresetChange populates from the ghost body regardless of the
        // synth fix. These are our sanity checks.
        //
        // (c) is what the fix targets: without the synth, name lookup misses.
        const view = await page.evaluate(async ({ slot }) => {
            const th = globalThis.TavernHelper;
            const asArr = v => Array.isArray(v) ? v : [];
            let defaultQ, inUseQ, bySlotQ, err;
            try {
                defaultQ = asArr(await th.getTavernRegexes({ type: 'preset' }));
                inUseQ = asArr(await th.getTavernRegexes({ type: 'preset', name: 'in_use' }));
                bySlotQ = asArr(await th.getTavernRegexes({ type: 'preset', name: slot }));
            } catch (e) {
                err = e && (e.message || String(e));
            }
            return {
                hasTavernHelper: typeof th === 'object' && th !== null,
                hasFn: typeof th?.getTavernRegexes === 'function',
                error: err || null,
                defaultCount: defaultQ?.length ?? -1,
                defaultNames: defaultQ?.map(s => s?.script_name) ?? [],
                inUseCount: inUseQ?.length ?? -1,
                inUseNames: inUseQ?.map(s => s?.script_name) ?? [],
                bySlotCount: bySlotQ?.length ?? -1,
                bySlotNames: bySlotQ?.map(s => s?.script_name) ?? [],
            };
        }, { slot: CARD_PRESET_NAME });

        console.log('TavernHelper view:', JSON.stringify(view, null, 2));

        expect(view.hasTavernHelper, 'TavernHelper global must be defined once ext bootstraps').toBe(true);
        expect(view.hasFn, 'TavernHelper.getTavernRegexes must be a function').toBe(true);
        expect(view.error, 'TavernHelper.getTavernRegexes must not throw').toBeNull();

        // Sanity: in_use path reads oai_settings — must always see the script.
        expect(view.inUseCount, 'ext must see the card regex via in_use lookup (via oai_settings)').toBeGreaterThan(0);
        expect(view.inUseNames, 'ext must see the CardBoundEcho script via in_use').toContain('CardBoundEcho');

        // The fix-critical assertion: name-based lookup via the ext's public
        // API must also resolve to the card body.
        expect(view.bySlotCount, 'ext must see the card regex via slot-name lookup (via getCompletionPresetByName synth)').toBeGreaterThan(0);
        expect(view.bySlotNames, 'ext must see the CardBoundEcho script via slot-name lookup').toContain('CardBoundEcho');
    });
});
