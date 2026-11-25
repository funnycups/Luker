// #39 — Character card export bundles the character's skills on Include,
// and the exported card installs them again on import.
//
// REAL USER-GESTURE flow:
//   1. Seed the Ash card and a global skill on disk.
//   2. Orchestrator settings → "Manage skills..." → "Move to..." the skill
//      into Ash's character scope.
//   3. Open Ash → Export and Download → PNG → the confirm popup lists the
//      skill → Include. The downloaded PNG carries the skill payload; the
//      stored card does not.
//   4. Export JSON → Include → same; export PNG → Skip → no payload.
//   5. Delete Ash with its chats (the character-scope skill goes with it),
//      import the Include PNG, open the card, Install in the skill import
//      dialog → the skill is back on disk in the new card's scope.
//   6. Import a card that already carries a bundled skill, decline the
//      install dialog → exporting shows no confirm and the file carries no
//      bundled skills. Move another skill into its scope → JSON Skip carries
//      none; PNG Include carries only the installed skill. The stored card
//      keeps its original payload throughout.
//   7. Same for a card whose card-bound chat completion preset carries a
//      bundled skill: no export carries it, and Include carries only the
//      installed character-scope skill.

import { test, expect } from '../../harness/playwright.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openOrchestratorSkillManager } from '../_lib/ui-orchestrator.js';
import { closeWorkbench } from '../_lib/ui-workbench.js';
import { importCharacterFile, deleteSelectedCharacter } from '../_lib/ui-character.js';
import { writeEmbeddedCharacter, disableTagImportPopup, clickCharacterCard, openCharacterEditPanel } from './_helpers.js';
import { read as readPngCard, write as writePngCard } from '../../../src/character-card-parser.js';
import { writeCharacterPng } from '../groups/_helpers.js';

const CHARACTER_NAME = 'Ash the Cartographer';
const SKILL = 'reef-soundings';
const SKILL_BODY = 'Read the reef by the colour of the swell before naming a channel safe for the drifters.';
const SKILL_MD = [
    '---',
    `name: ${SKILL}`,
    'description: How Ash reads the night reef from the headland watchpost.',
    '---',
    '',
    SKILL_BODY,
    '',
].join('\n');

const STALE_SKILL = 'drifter-signals';
const SECOND_SKILL = 'lantern-codes';
const IMPORTED_NAME = 'Maren the Harbour Pilot';
const BOUND_CARD_NAME = 'Oswin the Ferryman';
const BOUND_PRESET_SKILL = 'crossing-pace';
const THIRD_SKILL = 'fog-bell';

function skillMd(name, description, body) {
    return ['---', `name: ${name}`, `description: ${description}`, '---', '', body, ''].join('\n');
}

const THIRD_SKILL_MD = skillMd(THIRD_SKILL, 'When Oswin rings the fog bell on the crossing.', 'Ring twice at the midpoint and once more when the far jetty light shows.');

const SECOND_SKILL_MD = skillMd(SECOND_SKILL, 'The lantern codes Maren flashes to boats at the harbour mouth.', 'Two long flashes mean the bar is passable; three short mean hold off until the flood.');

let server, mock, avatar, scratchDir;

function userRoot() {
    return resolve(server.dataRoot, 'default-user');
}

function characterSkillPath(characterFile, name = SKILL) {
    return resolve(userRoot(), 'skills', 'character', characterFile, name, 'SKILL.md');
}

function seedGlobalSkill(name, md) {
    const dir = resolve(userRoot(), 'skills', 'global', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), md);
}

// Dotted paths of every `embedded_skills_source` key inside `value`.
function embedPaths(value, prefix = '') {
    if (!value || typeof value !== 'object') return [];
    const out = [];
    for (const [key, child] of Object.entries(value)) {
        const here = prefix ? `${prefix}.${key}` : key;
        if (key === 'embedded_skills_source') out.push(here);
        out.push(...embedPaths(child, here));
    }
    return out;
}

function buildCardBoundPresetPng() {
    const data = {
        name: BOUND_CARD_NAME,
        description: `${BOUND_CARD_NAME} rows the night ferry between the Bryn headland and the salt flats.`,
        personality: 'Quiet, steady, counts strokes under his breath.',
        scenario: 'You sit in the bow while Oswin pulls into the fog.',
        first_mes: '*Oswin leans into the oars.* "Sit low. The fog will lift by the midpoint, or it will not."',
        mes_example: '',
        creator_notes: 'e2e fixture — card-bound preset that ships with bundled skills',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {
            luker: {
                chat_completion_preset: {
                    presets: [{
                        name: 'Night Crossing',
                        preset: {
                            temperature: 0.7,
                            extensions: {
                                luker: {
                                    embedded_skills_source: {
                                        version: 1,
                                        items: [{
                                            bundleFormat: 'inline-files-v1',
                                            name: BOUND_PRESET_SKILL,
                                            files: [{ path: 'SKILL.md', encoding: 'utf8', content: skillMd(BOUND_PRESET_SKILL, 'Pacing for the night crossing.', 'Let each scene last one hundred strokes of the oars.') }],
                                        }],
                                    },
                                },
                            },
                        },
                    }],
                    defaultPresetName: 'Night Crossing',
                },
            },
        },
    };
    const seed = readFileSync(resolve(import.meta.dirname, '../../../default/content/default_Seraphina.png'));
    const filePath = resolve(scratchDir, 'oswin.png');
    writeFileSync(filePath, writePngCard(seed, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...data, data })));
    return filePath;
}

function buildCardWithStoredSkillsPng() {
    const data = {
        name: IMPORTED_NAME,
        description: `${IMPORTED_NAME} guides fishing boats across the shifting bar at the mouth of Bryn harbour.`,
        personality: 'Blunt, weathered, and patient with anyone who listens to the tide.',
        scenario: 'You wait on the pilot boat while Maren studies the swell over the bar.',
        first_mes: '*Maren squints at the bar.* "Not yet. Watch the third wave, then we go."',
        mes_example: '',
        creator_notes: 'e2e fixture — card that ships with bundled skills',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {
            luker: {
                embedded_skills_source: {
                    version: 1,
                    items: [{
                        bundleFormat: 'inline-files-v1',
                        name: STALE_SKILL,
                        files: [{ path: 'SKILL.md', encoding: 'utf8', content: skillMd(STALE_SKILL, 'Signals the drifters use at night.', 'A red lamp swung low means the drifters are close inshore.') }],
                    }],
                },
            },
        },
    };
    const seed = readFileSync(resolve(import.meta.dirname, '../../../default/content/default_Seraphina.png'));
    const filePath = resolve(scratchDir, 'maren.png');
    writeFileSync(filePath, writePngCard(seed, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...data, data })));
    return filePath;
}

function embeddedSkills(card) {
    return card?.data?.extensions?.luker?.embedded_skills_source;
}

function storedCard() {
    return JSON.parse(readPngCard(readFileSync(resolve(userRoot(), 'characters', avatar))));
}

async function moveSkillIntoCharacterScope(page, skillName = SKILL, characterFile = avatar) {
    const manager = await openOrchestratorSkillManager(page);
    const row = manager.locator(`.luker_skill_row[data-skill-name="${skillName}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator('[data-skill-action="move"]').click();
    const picker = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_scope_picker') });
    await expect(picker).toBeVisible();
    await picker.locator('input[name="luker_skill_scope_kind"][value="character"]').check();
    await picker.locator('[data-skill-scope-character]').selectOption(characterFile);
    await picker.locator('.popup-button-ok').click();
    await expect(picker).toBeHidden();
    await expect(row).toHaveAttribute('data-skill-scope', JSON.stringify({ kind: 'character', characterFile }), { timeout: 15_000 });
    await manager.locator('.popup-button-ok').click();
    await expect(manager).toBeHidden();
    await closeWorkbench(page);
}

// decision 'none' expects the export to download without any confirm.
async function exportCard(page, format, decision, listed = [SKILL]) {
    await openCharacterEditPanel(page);
    await page.locator('#export_button').click();
    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator(`#export_format_popup .export_format[data-format="${format}"]`).click();
    const confirm = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_export_confirm') });
    if (decision !== 'none') {
        await expect(confirm).toBeVisible({ timeout: 15_000 });
        await expect(confirm.locator('.luker_skill_export_confirm_list li')).toHaveText(listed);
        const displayName = await page.evaluate(() => {
            const context = window.Luker.getContext();
            return context.characters[context.characterId].name;
        });
        await expect(confirm.locator('.luker_skill_export_confirm_scope')).toContainText(displayName);
        await confirm.locator(decision === 'include' ? '.popup-button-ok' : '.popup-button-cancel').click();
        await expect(confirm).toBeHidden();
    }
    const file = await download;
    await expect(confirm).toHaveCount(0);
    const target = resolve(scratchDir, `${listed.join('_')}-${decision}-${format}.${format}`);
    await file.saveAs(target);
    return target;
}

function readExportedCard(path, format) {
    const bytes = readFileSync(path);
    return format === 'png' ? JSON.parse(readPngCard(bytes)) : JSON.parse(bytes.toString('utf8'));
}

function expectSkillPayload(card) {
    const payload = embeddedSkills(card);
    expect(payload?.version).toBe(1);
    expect(payload.items.map(item => item.name)).toEqual([SKILL]);
    expect(payload.items[0].files.find(f => f.path === 'SKILL.md').content).toBe(SKILL_MD);
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'character',
        scenarioId: '39-export-embedded-skills',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    avatar = writeEmbeddedCharacter({ dataRoot: server.dataRoot });
    const globalDir = resolve(userRoot(), 'skills', 'global', SKILL);
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(resolve(globalDir, 'SKILL.md'), SKILL_MD);
    seedGlobalSkill(SECOND_SKILL, SECOND_SKILL_MD);
    seedGlobalSkill(THIRD_SKILL, THIRD_SKILL_MD);
    scratchDir = (await scope.directory('embedded skills export files')).path;
    writeCharacterPng({ dataRoot: server.dataRoot, avatarFile: 'missing-world.png', card: {
        name: 'Keeper of the Lost Atlas', description: 'Keeps the lost coastal atlas.', first_mes: 'The atlas is missing from its shelf.',
        extensions: { world: '失落海图🌊' },
    } });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#39 — character card export bundles character-scope skills', () => {
    test('a missing CJK world book name remains intact in the real export warning', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await clickCharacterCard(page, 'Keeper of the Lost Atlas');
        await exportCard(page, 'json', 'none', []);
        await expect(page.locator('#toast-container .toast-warning').last()).toContainText('失落海图🌊');
    });
    test('Include bundles the skill into PNG and JSON exports, Skip leaves it out, and the exported card installs it on import', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);
        await moveSkillIntoCharacterScope(page);
        expect(readFileSync(characterSkillPath(avatar), 'utf8')).toBe(SKILL_MD);

        await clickCharacterCard(page, CHARACTER_NAME);

        const includePng = await exportCard(page, 'png', 'include');
        expectSkillPayload(readExportedCard(includePng, 'png'));
        expect(embeddedSkills(storedCard()), 'stored card is not changed by the export').toBeUndefined();

        const includeJson = await exportCard(page, 'json', 'include');
        expectSkillPayload(readExportedCard(includeJson, 'json'));

        const skipPng = await exportCard(page, 'png', 'skip');
        expect(embeddedSkills(readExportedCard(skipPng, 'png'))).toBeUndefined();
        expect(embeddedSkills(storedCard())).toBeUndefined();

        await openCharacterEditPanel(page);
        await deleteSelectedCharacter(page);
        await expect.poll(() => existsSync(characterSkillPath(avatar)), { timeout: 15_000 }).toBe(false);

        const before = new Set(listCharacters({ dataRoot: server.dataRoot }));
        await importCharacterFile(page, { filePath: includePng, expectedName: CHARACTER_NAME });
        const added = listCharacters({ dataRoot: server.dataRoot }).filter(f => !before.has(f));
        expect(added, 'exactly one imported card on disk').toHaveLength(1);
        const importedAvatar = added[0];

        await clickCharacterCard(page, { avatar: importedAvatar });
        const dialog = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_import_dialog') });
        await expect(dialog).toBeVisible({ timeout: 15_000 });
        await expect(dialog.locator(`tr[data-skill-import-name="${SKILL}"]`)).toHaveAttribute('data-skill-import-conflict', 'new');
        await dialog.locator('.popup-button-ok').click();
        await expect(dialog).toBeHidden({ timeout: 15_000 });

        await expect.poll(() => existsSync(characterSkillPath(importedAvatar)), { timeout: 15_000 }).toBe(true);
        expect(readFileSync(characterSkillPath(importedAvatar), 'utf8')).toBe(SKILL_MD);
    });

    test('a card imported with bundled skills exports them only on Include, freshly packed from the installed skills', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);

        const before = new Set(listCharacters({ dataRoot: server.dataRoot }));
        await importCharacterFile(page, { filePath: buildCardWithStoredSkillsPng(), expectedName: IMPORTED_NAME });
        const added = listCharacters({ dataRoot: server.dataRoot }).filter(f => !before.has(f));
        expect(added).toHaveLength(1);
        const marenAvatar = added[0];
        const marenStored = () => JSON.parse(readPngCard(readFileSync(resolve(userRoot(), 'characters', marenAvatar))));
        const storedPayload = embeddedSkills(marenStored());
        expect(storedPayload.items.map(item => item.name)).toEqual([STALE_SKILL]);

        await clickCharacterCard(page, { avatar: marenAvatar });
        const dialog = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_import_dialog') });
        await expect(dialog).toBeVisible({ timeout: 15_000 });
        await dialog.locator('.popup-button-cancel').click();
        await expect(dialog).toBeHidden();
        expect(existsSync(characterSkillPath(marenAvatar, STALE_SKILL))).toBe(false);

        const noConfirmPng = await exportCard(page, 'png', 'none', []);
        expect(embeddedSkills(readExportedCard(noConfirmPng, 'png'))).toBeUndefined();
        const noConfirmJson = await exportCard(page, 'json', 'none', []);
        expect(embeddedSkills(readExportedCard(noConfirmJson, 'json'))).toBeUndefined();

        await moveSkillIntoCharacterScope(page, SECOND_SKILL, marenAvatar);
        expect(readFileSync(characterSkillPath(marenAvatar, SECOND_SKILL), 'utf8')).toBe(SECOND_SKILL_MD);

        const skipJson = await exportCard(page, 'json', 'skip', [SECOND_SKILL]);
        expect(embeddedSkills(readExportedCard(skipJson, 'json'))).toBeUndefined();

        const includePng = await exportCard(page, 'png', 'include', [SECOND_SKILL]);
        const fresh = embeddedSkills(readExportedCard(includePng, 'png'));
        expect(fresh.items.map(item => item.name)).toEqual([SECOND_SKILL]);
        expect(fresh.items[0].files.find(f => f.path === 'SKILL.md').content).toBe(SECOND_SKILL_MD);

        expect(embeddedSkills(marenStored())).toEqual(storedPayload);
    });

    test('skills bundled in a card-bound preset never reach the exported card', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);

        const before = new Set(listCharacters({ dataRoot: server.dataRoot }));
        await importCharacterFile(page, { filePath: buildCardBoundPresetPng(), expectedName: BOUND_CARD_NAME });
        const added = listCharacters({ dataRoot: server.dataRoot }).filter(f => !before.has(f));
        expect(added).toHaveLength(1);
        const oswinAvatar = added[0];
        const oswinStored = () => JSON.parse(readPngCard(readFileSync(resolve(userRoot(), 'characters', oswinAvatar))));
        const storedEmbedPath = 'data.extensions.luker.chat_completion_preset.presets.0.preset.extensions.luker.embedded_skills_source';
        const storedBoundPayload = oswinStored().data.extensions.luker.chat_completion_preset.presets[0].preset.extensions.luker.embedded_skills_source;
        expect(embedPaths(oswinStored())).toEqual([storedEmbedPath]);

        await clickCharacterCard(page, { avatar: oswinAvatar });
        const dialog = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_import_dialog') });
        await expect(dialog).toBeVisible({ timeout: 15_000 });
        await expect(dialog.locator(`tr[data-skill-import-name="${BOUND_PRESET_SKILL}"]`)).toBeVisible();
        await dialog.locator('.popup-button-cancel').click();
        await expect(dialog).toBeHidden();

        const noConfirmPng = await exportCard(page, 'png', 'none', [BOUND_CARD_NAME]);
        const noConfirmCard = readExportedCard(noConfirmPng, 'png');
        expect(embedPaths(noConfirmCard)).toEqual([]);
        expect(noConfirmCard.data.extensions.luker.chat_completion_preset.presets.map(p => p.name)).toEqual(['Night Crossing']);

        await moveSkillIntoCharacterScope(page, THIRD_SKILL, oswinAvatar);

        const skipJson = await exportCard(page, 'json', 'skip', [THIRD_SKILL]);
        expect(embedPaths(readExportedCard(skipJson, 'json'))).toEqual([]);

        const includePng = await exportCard(page, 'png', 'include', [THIRD_SKILL]);
        const included = readExportedCard(includePng, 'png');
        expect(embedPaths(included)).toEqual(['data.extensions.luker.embedded_skills_source']);
        expect(embeddedSkills(included).items.map(item => item.name)).toEqual([THIRD_SKILL]);

        // Selecting the card applies its bound preset, which writes the full
        // preset body back to the card; the bundled skills stay stored.
        expect(embedPaths(oswinStored())).toEqual([storedEmbedPath]);
        expect(oswinStored().data.extensions.luker.chat_completion_preset.presets[0].preset.extensions.luker.embedded_skills_source).toEqual(storedBoundPayload);
    });
});
