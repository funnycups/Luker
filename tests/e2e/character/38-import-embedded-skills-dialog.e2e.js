// #38 — Importing a card with embedded skills surfaces the skill import
// dialog on first open; Install materializes the card's own skills and its
// card-bound preset's skills into the character scope, and the Skip / Replace
// radios decide a same-name skill whose content differs.
//
// REAL USER-GESTURE flow (one card per branch):
//   1. Build a PNG card whose data.extensions.luker carries an
//      embedded_skills_source payload (a new skill + a same-name skill with
//      different content) and a card-bound chat completion preset whose
//      body carries its own embedded_skills_source payload.
//   2. Import the PNG via #character_import_button.
//   3. Another writer installs the same-name skill into the character scope
//      with the original content.
//   4. Click the card → the skill import dialog lists the new skill, the
//      card-bound preset skill and the conflicting skill.
//   5. Pick Skip (or Replace) on the conflicting row and click Install.
//   6. Assert on disk: the new skill and the card-bound preset skill live in
//      skills/character/<avatar>/; the conflicting skill keeps the original
//      body on Skip and carries the card's body on Replace; nothing lands in
//      global or preset scope.

import { test, expect } from '../../harness/playwright.js';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { importCharacterFile } from '../_lib/ui-character.js';
import { disableTagImportPopup, clickCharacterCard } from './_helpers.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const LEDGER_SKILL = 'tide-ledger';
const VOICE_SKILL = 'keeper-voice';
const BOUND_PRESET_SKILL = 'lantern-pacing';

const LEDGER_BODY = 'Record each turn of the tide against the lantern bell before the next watch begins.';
const BOUND_PRESET_BODY = 'Let each scene breathe through one full sweep of the lantern before the reef answers.';
const VOICE_ORIGINAL_BODY = 'Speak in the clipped cadence of a keeper who has not slept since the last storm.';
const VOICE_CARD_BODY = 'Speak softly and in long sentences, the way the keeper talks to the lamp at slack water.';

let server, mock, scratchDir;

function skillMd(name, description, body) {
    return ['---', `name: ${name}`, `description: "${description}"`, '---', '', body, ''].join('\n');
}

function embedPayload(items) {
    return {
        version: 1,
        items: items.map(({ name, description, body }) => ({
            bundleFormat: 'inline-files-v1',
            name,
            files: [{ path: 'SKILL.md', encoding: 'utf8', content: skillMd(name, description, body) }],
        })),
    };
}

function buildCardPng(name, fileName) {
    const data = {
        name,
        description: `${name} keeps the eastern light above the Bryn reef and logs every ship that rounds the gull rocks.`,
        personality: 'Patient, watchful, slow to speak and quick to notice a lantern that should not be there.',
        scenario: 'You climb the spiral stair while the keeper trims the wick and the reef grows restless below.',
        first_mes: '*The keeper does not turn from the lantern.* "Close the hatch behind you. The wick is fickle tonight."',
        mes_example: '',
        creator_notes: 'e2e fixture — embedded skills import dialog',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {
            luker: {
                embedded_skills_source: embedPayload([
                    { name: LEDGER_SKILL, description: 'Tide ledger kept by the lighthouse keeper.', body: LEDGER_BODY },
                    { name: VOICE_SKILL, description: 'How the keeper speaks on the night watch.', body: VOICE_CARD_BODY },
                ]),
                chat_completion_preset: {
                    presets: [{
                        name: 'Night Watch',
                        preset: {
                            temperature: 0.8,
                            extensions: {
                                luker: {
                                    embedded_skills_source: embedPayload([
                                        { name: BOUND_PRESET_SKILL, description: 'Scene pacing for the lighthouse watch.', body: BOUND_PRESET_BODY },
                                    ]),
                                },
                            },
                        },
                    }],
                    defaultPresetName: 'Night Watch',
                },
            },
        },
    };
    const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
    const png = writePngCard(seed, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...data, data }));
    const filePath = resolve(scratchDir, fileName);
    writeFileSync(filePath, png);
    return filePath;
}

function skillsRoot() {
    return resolve(server.dataRoot, 'default-user', 'skills');
}

function characterSkillPath(avatar, name) {
    return resolve(skillsRoot(), 'character', avatar, name, 'SKILL.md');
}

function seedOriginalVoiceSkill(avatar) {
    const path = characterSkillPath(avatar, VOICE_SKILL);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, skillMd(VOICE_SKILL, 'How the keeper speaks on the night watch.', VOICE_ORIGINAL_BODY));
}

async function importCard(page, name, fileName) {
    const before = new Set(listCharacters({ dataRoot: server.dataRoot }));
    await importCharacterFile(page, { filePath: buildCardPng(name, fileName), expectedName: name });
    const added = listCharacters({ dataRoot: server.dataRoot }).filter(f => !before.has(f));
    expect(added, `exactly one new card on disk for ${name}`).toHaveLength(1);
    return added[0];
}

async function openCardAndInstall(page, name, decision) {
    await clickCharacterCard(page, name);
    const dialog = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_import_dialog') });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.locator(`tr[data-skill-import-name="${LEDGER_SKILL}"]`)).toHaveAttribute('data-skill-import-conflict', 'new');
    await expect(dialog.locator(`tr[data-skill-import-name="${BOUND_PRESET_SKILL}"]`)).toHaveAttribute('data-skill-import-conflict', 'new');
    const voiceRow = dialog.locator(`tr[data-skill-import-name="${VOICE_SKILL}"]`);
    await expect(voiceRow).toHaveAttribute('data-skill-import-conflict', 'different');
    await voiceRow.locator(`input[type="radio"][value="${decision}"]`).check();
    await dialog.locator('.popup-button-ok').click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('#toast-container .toast', { hasText: 'Skills imported' })).toBeVisible({ timeout: 15_000 });
}

function assertNothingOutsideCharacterScope() {
    for (const name of [LEDGER_SKILL, VOICE_SKILL, BOUND_PRESET_SKILL]) {
        expect(existsSync(resolve(skillsRoot(), 'global', name)), `${name} not in global scope`).toBe(false);
    }
    expect(existsSync(resolve(skillsRoot(), 'preset')), 'no preset scope created').toBe(false);
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'character',
        scenarioId: '38-import-embedded-skills-dialog',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    scratchDir = (await scope.directory('embedded skills import files')).path;
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#38 — embedded skills import dialog on a newly imported card', () => {
    test('Skip keeps the local same-name skill; new and card-bound preset skills install into character scope', async ({ page }) => {
        const name = 'Briallen the Lighthouse Keeper';
        await awaitMainUI(page, server.baseURL);
        const avatar = await importCard(page, name, 'briallen.png');
        seedOriginalVoiceSkill(avatar);

        await openCardAndInstall(page, name, 'skip');

        await expect.poll(() => existsSync(characterSkillPath(avatar, LEDGER_SKILL)), { timeout: 15_000 }).toBe(true);
        expect(readFileSync(characterSkillPath(avatar, LEDGER_SKILL), 'utf8')).toContain(LEDGER_BODY);
        expect(readFileSync(characterSkillPath(avatar, BOUND_PRESET_SKILL), 'utf8')).toContain(BOUND_PRESET_BODY);
        const voice = readFileSync(characterSkillPath(avatar, VOICE_SKILL), 'utf8');
        expect(voice).toContain(VOICE_ORIGINAL_BODY);
        expect(voice).not.toContain(VOICE_CARD_BODY);
        assertNothingOutsideCharacterScope();
    });

    test('Replace overwrites the local same-name skill with the card body', async ({ page }) => {
        const name = 'Teodor the Ferry Keeper';
        await awaitMainUI(page, server.baseURL);
        const avatar = await importCard(page, name, 'teodor.png');
        seedOriginalVoiceSkill(avatar);

        await openCardAndInstall(page, name, 'replace');

        await expect.poll(() => readFileSync(characterSkillPath(avatar, VOICE_SKILL), 'utf8'), { timeout: 15_000 }).toContain(VOICE_CARD_BODY);
        expect(readFileSync(characterSkillPath(avatar, VOICE_SKILL), 'utf8')).not.toContain(VOICE_ORIGINAL_BODY);
        expect(readFileSync(characterSkillPath(avatar, LEDGER_SKILL), 'utf8')).toContain(LEDGER_BODY);
        expect(readFileSync(characterSkillPath(avatar, BOUND_PRESET_SKILL), 'utf8')).toContain(BOUND_PRESET_BODY);
        assertNothingOutsideCharacterScope();
    });
});
