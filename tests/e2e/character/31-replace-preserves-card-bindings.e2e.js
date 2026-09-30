// #31 — Replacing a character card keeps every local Luker binding.
//
// Before this feature the replace flow imported the new PNG verbatim:
// every binding stored in `data.extensions.*` died with the old card.
// This test drives the real More-menu replace gesture with a card that
// carries a binding in all five registered categories, replaces it with a
// binding-free card, and asserts every binding was silently inherited —
// on disk, after a server restart + reload, and in the preset selector
// (the card-bound "ghost" option must be live again).

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel, writeEmbeddedCharacter, openReplaceWithFile } from './_helpers.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { write as writePngCard, read as readPngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const OLD_NAME = 'Ash the Cartographer';
const OLD_AVATAR = 'ash-binding-preserve.png';
const NEW_NAME = 'Briallen the Lighthouse Keeper';
const BOUND_PRESET = 'Tidewatch';
const PERSONA_AVATAR = 'dockhand-user.png';

const OLD_BINDINGS = {
    luker: {
        chat_completion_preset: {
            presets: [{ name: BOUND_PRESET, preset: { temperature: 0.7 } }],
            defaultPresetName: BOUND_PRESET,
        },
        dedicated_personas: [{
            avatar: PERSONA_AVATAR,
            name: 'Dockhand',
            description: 'Waits at the quay.',
            position: 0,
            depth: 4,
            role: 0,
            lorebook: '',
            title: '',
        }],
    },
    orchestrator: {
        presetLibraries: { spec: { default: { name: 'Tidewatch Plan' } } },
        activePresetIds: { spec: 'default' },
        override: { mode: 'spec' },
    },
    memory_graph: {
        schemaOverride: [{ id: 'tide', label: 'Tide', tableColumns: ['title'] }],
        advancedOverride: { recallTopN: 7 },
    },
    card_app: { enabled: true, entry: 'index.js' },
};

function writeReplacementPng(outPath) {
    const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
    const data = {
        name: NEW_NAME,
        description: 'A weathered keeper of the eastern light.',
        personality: 'Patient.',
        scenario: 'You climb the spiral stair.',
        first_mes: '*The wick hisses.* "Close the hatch."',
        mes_example: '',
        creator_notes: 'e2e',
        system_prompt: 'Stay in scene.',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {},
    };
    const payload = { spec: 'chara_card_v2', spec_version: '2.0', ...data, data };
    writeFileSync(outPath, writePngCard(seed, JSON.stringify(payload)));
    return outPath;
}

function readReplacedCard(dataRoot) {
    const charsDir = resolve(dataRoot, 'default-user/characters');
    for (const file of readdirSync(charsDir).filter(name => name.endsWith('.png'))) {
        try {
            const meta = JSON.parse(readPngCard(readFileSync(resolve(charsDir, file))));
            if ((meta?.data?.name || meta?.name) === NEW_NAME) {
                return meta.data;
            }
        } catch { /* not a card */ }
    }
    throw new Error(`replacement card ${NEW_NAME} not found on disk`);
}

let mock, tmpDir, replacementPath;

test.describe('#31 — replace keeps every local binding', () => {
    test.beforeAll(async () => {
        mock = await startMockLLM({});
        tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-31-'));
        replacementPath = writeReplacementPng(resolve(tmpDir, 'briallen.png'));
    });

    test.afterAll(async () => {
        await mock?.stop();
        if (tmpDir) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    test('all five binding categories survive a replace with a binding-free card', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: 'binding-preserve' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: OLD_AVATAR,
                overrides: { extensions: OLD_BINDINGS },
            });
            // A valid CardApp entry so activation succeeds instead of showing
            // the error container while the test drives the UI.
            const cardAppDir = resolve(server.dataRoot, 'default-user/card-apps/ash-binding-preserve');
            mkdirSync(cardAppDir, { recursive: true });
            writeFileSync(resolve(cardAppDir, 'index.js'), 'export function init() {}\n');

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, OLD_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            await openReplaceWithFile(page, replacementPath);

            // `setInputFiles` only hands the file to the hidden input; the
            // import + preservation chain runs asynchronously afterwards.
            // Wait for every preserved binding to land on disk — this is
            // the contract the test locks. The CEA world-book popup fires
            // strictly after the writes, so once the disk is complete the
            // popup is (about to be) on screen.
            await expect.poll(() => {
                try {
                    const ext = readReplacedCard(server.dataRoot).extensions || {};
                    return [
                        ext.luker?.chat_completion_preset?.defaultPresetName || '',
                        ext.luker?.dedicated_personas?.[0]?.avatar || '',
                        ext.orchestrator?.override?.mode || '',
                        ext.memory_graph?.schemaOverride?.[0]?.id || '',
                        ext.card_app?.enabled === true ? 'on' : '',
                    ].join('|');
                } catch {
                    return 'pending';
                }
            }, { timeout: 30_000 }).toBe(`${BOUND_PRESET}|${PERSONA_AVATAR}|spec|tide|on`);

            // The silent path shows no binding dialog. The CEA world-book
            // popup still fires on every replace — dismiss it.
            const worldBookPopup = page.locator('dialog.popup[open]', { hasText: /Replace:|替换角色卡|替換角色卡/ }).last();
            await worldBookPopup.waitFor({ state: 'visible', timeout: 15_000 });
            await dismissAnyPopup(page, { maxRounds: 5, perRoundTimeoutMs: 2500 });

            // On-disk card carries every binding.
            const disk = readReplacedCard(server.dataRoot).extensions;
            expect(disk.luker?.chat_completion_preset?.presets?.[0]?.name).toBe(BOUND_PRESET);
            expect(disk.luker?.chat_completion_preset?.defaultPresetName).toBe(BOUND_PRESET);
            expect(disk.luker?.dedicated_personas?.[0]?.avatar).toBe(PERSONA_AVATAR);
            expect(disk.orchestrator?.override?.mode).toBe('spec');
            expect(disk.orchestrator?.activePresetIds?.spec).toBe('default');
            expect(Array.isArray(disk.memory_graph?.schemaOverride)).toBe(true);
            expect(disk.memory_graph?.schemaOverride?.[0]?.id).toBe('tide');
            expect(disk.memory_graph?.advancedOverride).toBeTruthy();
            expect(disk.card_app?.enabled).toBe(true);
            expect(disk.card_app?.entry).toBe('index.js');

            // Survives a server restart + page reload, and the card-bound
            // preset ghost option is live again.
            await server.restart();
            await reloadAndAwait(page, server.baseURL);
            await clickCharacterCard(page, NEW_NAME);
            const contextProbe = await page.evaluate(() => ({
                registerFn: typeof window.Luker?.getContext?.().registerCardBindingSlot,
            }));
            expect(contextProbe.registerFn).toBe('function');
            await page.waitForFunction((name) => {
                const optgroup = document.querySelector('#settings_preset_openai optgroup[data-luker-card-bound="1"]');
                return !!optgroup && Array.from(optgroup.querySelectorAll('option')).some(option => option.textContent === name);
            }, BOUND_PRESET, { timeout: 15_000 });
        } finally {
            await tearDownServer(server);
        }
    });
});
