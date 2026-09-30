// #32 — Binding conflicts during a card replace are resolved per category.
//
// The replaced card binds preset "Tidewatch" and persona "dockhand-user";
// the incoming card ships its own "Beacon" preset and "beacon-user"
// persona. The conflict popup must appear once, let the user keep the new
// card's preset (unchecked row) while keeping the local persona (checked
// row), and the unchecked category must not write anything. Keeping the
// local persona must not leak the incoming card's persona into the global
// persona library.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel, writeEmbeddedCharacter, openReplaceWithFile } from './_helpers.js';
import { awaitMainUI } from '../_lib/page.js';
import { write as writePngCard, read as readPngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const OLD_NAME = 'Ash the Cartographer';
const NEW_NAME = 'Briallen the Lighthouse Keeper';
const LOCAL_PRESET = 'Tidewatch';
const INCOMING_PRESET = 'Beacon';
const LOCAL_PERSONA_AVATAR = 'dockhand-user.png';
const INCOMING_PERSONA_AVATAR = 'beacon-user.png';

function writeReplacementPng(outPath) {
    const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
    const data = {
        name: NEW_NAME,
        description: 'A weathered keeper of the eastern light.',
        personality: 'Patient.',
        scenario: 'You climb the spiral stair.',
        first_mes: '*The wick hisses.*',
        mes_example: '',
        creator_notes: 'e2e',
        system_prompt: 'Stay in scene.',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {
            luker: {
                chat_completion_preset: {
                    presets: [{ name: INCOMING_PRESET, preset: { temperature: 0.4 } }],
                    defaultPresetName: INCOMING_PRESET,
                },
                dedicated_personas: [{
                    avatar: INCOMING_PERSONA_AVATAR,
                    name: 'Beacon Keeper',
                    description: 'Tends the lamp.',
                    position: 0,
                    depth: 4,
                    role: 0,
                    lorebook: '',
                    title: '',
                }],
            },
        },
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

test.describe('#32 — replace binding conflict dialog', () => {
    test.beforeAll(async () => {
        mock = await startMockLLM({});
        tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-32-'));
        replacementPath = writeReplacementPng(resolve(tmpDir, 'briallen.png'));
    });

    test.afterAll(async () => {
        await mock?.stop();
        if (tmpDir) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    test('per-category choice: preset uses the new card, persona keeps the local value', async ({ page }) => {
        const server = await startServer({ batchKey: 'character', scenarioId: 'binding-conflict' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'ash-binding-conflict.png',
                overrides: {
                    extensions: {
                        luker: {
                            chat_completion_preset: {
                                presets: [{ name: LOCAL_PRESET, preset: { temperature: 0.7 } }],
                                defaultPresetName: LOCAL_PRESET,
                            },
                            dedicated_personas: [{
                                avatar: LOCAL_PERSONA_AVATAR,
                                name: 'Dockhand',
                                description: 'Waits at the quay.',
                                position: 0,
                                depth: 4,
                                role: 0,
                                lorebook: '',
                                title: '',
                            }],
                        },
                    },
                },
            });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, OLD_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            await openReplaceWithFile(page, replacementPath);

            const dialog = page.locator('dialog.popup[open]', {
                hasText: /Local bindings found on both cards|两张角色卡都有本地绑定|兩張角色卡都有本地繫結/,
            }).last();
            await dialog.waitFor({ state: 'visible', timeout: 15_000 });

            // Preset row: use the new card's value. Persona row: keep local (default).
            await dialog.locator('#card-binding-keep-bound-presets').uncheck();
            await dialog.locator('.popup-button-ok').click();
            await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
            // The CEA world-book popup fires on CHARACTER_REPLACED, which is
            // emitted strictly after the conflict write-back; waiting for it
            // makes the dismissal real and guarantees the kept local persona
            // has already landed on disk.
            const worldBookPopup = page.locator('dialog.popup[open]', { hasText: /Replace:|替换角色卡|替換角色卡/ }).last();
            await worldBookPopup.waitFor({ state: 'visible', timeout: 15_000 });
            await dismissAnyPopup(page, { maxRounds: 5, perRoundTimeoutMs: 2500 });

            const disk = readReplacedCard(server.dataRoot).extensions;
            expect(disk.luker?.chat_completion_preset?.presets?.map(preset => preset.name)).toEqual([INCOMING_PRESET]);
            expect(disk.luker?.dedicated_personas?.map(entry => entry.avatar)).toEqual([LOCAL_PERSONA_AVATAR]);

            const globalPersonaKeys = await page.evaluate(() => Object.keys(window.Luker.getContext().powerUserSettings?.personas || {}));
            expect(globalPersonaKeys).not.toContain(INCOMING_PERSONA_AVATAR);
            expect(globalPersonaKeys).not.toContain(LOCAL_PERSONA_AVATAR);
        } finally {
            await tearDownServer(server);
        }
    });
});
