// #48 — Legacy single-binding (`chat_completion_preset.preset`) and current
// multi-preset embedded skills import & export runtime coverage.
//
// REAL USER-GESTURE flows (zero mocks — no LLM required):
//   1. Legacy nameless single-binding (`chat_completion_preset: { preset }`)
//      remains unmigrated at `chat_completion_preset.preset` on disk:
//      - Decline install → no-confirm PNG & JSON exports strip the legacy
//        preset's `embedded_skills_source`, keep preset fields intact, and
//        leave the stored PNG byte-identical.
//      - Install into character scope + move a second skill into character
//        scope via Skill Manager → Skip PNG & JSON strip every embedded
//        skills payload; Include PNG & JSON carry ONLY freshly packed
//        installed character skills at `data.extensions.luker.embedded_skills_source`
//        (never the legacy preset slot), and stored card PNG + skill files
//        stay byte-identical to the post-selection pre-export baseline.
//   2. Legacy named single-binding (`chat_completion_preset: { name, preset }`):
//      - Import → verify legacy shape on disk before selection → select card →
//        install legacy preset skill → wait for selection-time binding
//        migration (`presets[]`) to settle → capture post-selection pre-export
//        baseline → Skip & Include PNG/JSON behave cleanly without mutating
//        the post-selection stored card or installed skill files.
//   3. Current multi-preset binding (`chat_completion_preset: { presets }`) +
//      card-level skill regression check.

import { test, expect } from '../../harness/playwright.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { importCharacterFile } from '../_lib/ui-character.js';
import { openOrchestratorSkillManager } from '../_lib/ui-orchestrator.js';
import { closeWorkbench } from '../_lib/ui-workbench.js';
import { disableTagImportPopup, clickCharacterCard, openCharacterEditPanel } from './_helpers.js';
import { read as readPngCard, write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const NAMELESS_LEGACY_SKILL = 'harbour-soundings';
const NAMELESS_LEGACY_BODY = 'Call the soundings from the bow before entering the inner shoal.';
const MOVED_SKILL = 'storm-lantern';
const MOVED_SKILL_BODY = 'Hang the storm lantern on the windward rail whenever the barometer drops.';
const NAMED_LEGACY_SKILL = 'beacon-cadence';
const NAMED_LEGACY_BODY = 'Flash two long intervals and one short whenever fog hides the breakwater.';
const CURRENT_OWN_SKILL = 'chart-margins';
const CURRENT_OWN_BODY = 'Mark current drift in pencil along the outer chart margin after every watch.';
const CURRENT_PRESET_SKILL = 'night-bell';
const CURRENT_PRESET_BODY = 'Strike the brass bell twice at the turning of the ebb tide.';

let server, scratchDir;

function userRoot() {
    return resolve(server.dataRoot, 'default-user');
}

function skillsRoot() {
    return resolve(userRoot(), 'skills');
}

function characterSkillPath(avatar, name) {
    return resolve(skillsRoot(), 'character', avatar, name, 'SKILL.md');
}

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

function seedGlobalSkill(name, description, body) {
    const dir = resolve(skillsRoot(), 'global', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), skillMd(name, description, body));
}

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

function buildCardPng({ name, fileName, lukerExtensions }) {
    const data = {
        name,
        description: `${name} watches the reef channel and records tide signals at the headland post.`,
        personality: 'Steady, observant, methodical with charts and lanterns.',
        scenario: 'Night watch begins at the headland signal tower.',
        first_mes: '*Sets the brass logbook beside the lamp.* "Keep an eye on the outer buoy."',
        mes_example: '',
        creator_notes: 'e2e fixture — legacy single-binding embedded skills',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {
            luker: lukerExtensions,
        },
    };
    const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
    const filePath = resolve(scratchDir, fileName);
    writeFileSync(filePath, writePngCard(seed, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...data, data })));
    return filePath;
}

async function importCard(page, { name, fileName, lukerExtensions }) {
    const before = new Set(listCharacters({ dataRoot: server.dataRoot }));
    await importCharacterFile(page, { filePath: buildCardPng({ name, fileName, lukerExtensions }), expectedName: name });
    const added = listCharacters({ dataRoot: server.dataRoot }).filter(file => !before.has(file));
    expect(added, `exactly one imported card on disk for ${name}`).toHaveLength(1);
    return added[0];
}

function readStoredCardBytes(avatar) {
    return readFileSync(resolve(userRoot(), 'characters', avatar));
}

function readStoredCardJson(avatar) {
    return JSON.parse(readPngCard(readStoredCardBytes(avatar)));
}

async function openCardAndRespondToSkillDialog(page, avatar, expectedSkills, decision) {
    await clickCharacterCard(page, { avatar });
    const dialog = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_import_dialog') });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    for (const skillName of expectedSkills) {
        await expect(dialog.locator(`tr[data-skill-import-name="${skillName}"]`)).toHaveAttribute('data-skill-import-conflict', 'new');
    }
    await dialog.locator(decision === 'install' ? '.popup-button-ok' : '.popup-button-cancel').click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
}

async function moveGlobalSkillToCharacter(page, skillName, characterFile) {
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

async function exportCard(page, { tag, format, decision, listed = [] }) {
    await openCharacterEditPanel(page);
    await page.locator('#export_button').click();
    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator(`#export_format_popup .export_format[data-format="${format}"]`).click();
    const confirm = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_export_confirm') });
    if (decision !== 'none') {
        await expect(confirm).toBeVisible({ timeout: 15_000 });
        await expect(confirm.locator('.luker_skill_export_confirm_list li')).toHaveText(listed);
        await confirm.locator(decision === 'include' ? '.popup-button-ok' : '.popup-button-cancel').click();
        await expect(confirm).toBeHidden({ timeout: 15_000 });
    }
    const file = await download;
    await expect(confirm).toHaveCount(0);
    const target = resolve(scratchDir, `${tag}-${decision}-${format}.${format}`);
    await file.saveAs(target);
    const bytes = readFileSync(target);
    return format === 'png' ? JSON.parse(readPngCard(bytes)) : JSON.parse(bytes.toString('utf8'));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({
        scope,
        batchKey: 'character',
        scenarioId: '48-legacy-single-binding-embedded-skills',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    seedGlobalSkill(MOVED_SKILL, 'Storm lantern signalling protocol.', MOVED_SKILL_BODY);
    scratchDir = (await scope.directory('legacy-single-binding-skills')).path;
});

test.describe('#48 — legacy single-binding embedded skills import and export', () => {
    const namelessLegacyLuker = () => ({
        chat_completion_preset: {
            preset: {
                temperature: 0.62,
                extensions: {
                    luker: {
                        embedded_skills_source: embedPayload([
                            { name: NAMELESS_LEGACY_SKILL, description: 'Soundings before entering the shoal.', body: NAMELESS_LEGACY_BODY },
                        ]),
                        retained_preset_marker: 'shoal-v1',
                    },
                },
            },
        },
    });

    test('nameless legacy chat_completion_preset.preset declined install exports without confirm or stored skills and keeps PNG byte-identical', async ({ page }) => {
        test.setTimeout(120_000);
        await awaitMainUI(page, server.baseURL);

        const declinedAvatar = await importCard(page, {
            name: 'Caleb of the Outer Shoal',
            fileName: 'caleb-legacy-declined.png',
            lukerExtensions: namelessLegacyLuker(),
        });
        expect(embedPaths(readStoredCardJson(declinedAvatar))).toEqual([
            'data.extensions.luker.chat_completion_preset.preset.extensions.luker.embedded_skills_source',
        ]);

        await openCardAndRespondToSkillDialog(page, declinedAvatar, [NAMELESS_LEGACY_SKILL], 'cancel');
        expect(existsSync(characterSkillPath(declinedAvatar, NAMELESS_LEGACY_SKILL))).toBe(false);

        // Capture post-selection pre-export byte baseline on disk.
        const declinedBaselineBytes = readStoredCardBytes(declinedAvatar);
        expect(embedPaths(readStoredCardJson(declinedAvatar))).toEqual([
            'data.extensions.luker.chat_completion_preset.preset.extensions.luker.embedded_skills_source',
        ]);

        const noConfirmPng = await exportCard(page, { tag: 'nameless-declined', format: 'png', decision: 'none' });
        const noConfirmJson = await exportCard(page, { tag: 'nameless-declined', format: 'json', decision: 'none' });
        for (const exported of [noConfirmPng, noConfirmJson]) {
            expect(embedPaths(exported)).toEqual([]);
            expect(exported.data.extensions.luker.chat_completion_preset.preset.temperature).toBe(0.62);
            expect(exported.data.extensions.luker.chat_completion_preset.preset.extensions.luker.retained_preset_marker).toBe('shoal-v1');
        }
        expect(readStoredCardBytes(declinedAvatar).equals(declinedBaselineBytes)).toBe(true);
    });

    test('nameless legacy chat_completion_preset.preset installs via real UI, strips on Skip, and packs fresh installed skills on Include without mutating stored assets', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);

        const installedAvatar = await importCard(page, {
            name: 'Nora of the Inner Bar',
            fileName: 'nora-legacy-installed.png',
            lukerExtensions: namelessLegacyLuker(),
        });
        await openCardAndRespondToSkillDialog(page, installedAvatar, [NAMELESS_LEGACY_SKILL], 'install');
        await expect.poll(() => existsSync(characterSkillPath(installedAvatar, NAMELESS_LEGACY_SKILL)), { timeout: 15_000 }).toBe(true);
        const expectedLegacyMd = skillMd(NAMELESS_LEGACY_SKILL, 'Soundings before entering the shoal.', NAMELESS_LEGACY_BODY);
        expect(readFileSync(characterSkillPath(installedAvatar, NAMELESS_LEGACY_SKILL), 'utf8')).toBe(expectedLegacyMd);
        expect(existsSync(resolve(skillsRoot(), 'global', NAMELESS_LEGACY_SKILL))).toBe(false);
        expect(existsSync(resolve(skillsRoot(), 'preset'))).toBe(false);

        await moveGlobalSkillToCharacter(page, MOVED_SKILL, installedAvatar);
        const expectedMovedMd = skillMd(MOVED_SKILL, 'Storm lantern signalling protocol.', MOVED_SKILL_BODY);
        expect(readFileSync(characterSkillPath(installedAvatar, MOVED_SKILL), 'utf8')).toBe(expectedMovedMd);

        // Post-selection, pre-export baseline for stored card and installed skill files.
        const installedBaselineBytes = readStoredCardBytes(installedAvatar);
        const legacySkillBaseline = readFileSync(characterSkillPath(installedAvatar, NAMELESS_LEGACY_SKILL));
        const movedSkillBaseline = readFileSync(characterSkillPath(installedAvatar, MOVED_SKILL));
        expect(embedPaths(readStoredCardJson(installedAvatar))).toEqual([
            'data.extensions.luker.chat_completion_preset.preset.extensions.luker.embedded_skills_source',
        ]);

        const listed = [NAMELESS_LEGACY_SKILL, MOVED_SKILL];
        const skipPng = await exportCard(page, { tag: 'nameless-installed', format: 'png', decision: 'skip', listed });
        const skipJson = await exportCard(page, { tag: 'nameless-installed', format: 'json', decision: 'skip', listed });
        for (const exported of [skipPng, skipJson]) {
            expect(embedPaths(exported)).toEqual([]);
            expect(exported.data.extensions.luker.chat_completion_preset.preset.temperature).toBe(0.62);
        }

        const includePng = await exportCard(page, { tag: 'nameless-installed', format: 'png', decision: 'include', listed });
        const includeJson = await exportCard(page, { tag: 'nameless-installed', format: 'json', decision: 'include', listed });
        for (const exported of [includePng, includeJson]) {
            expect(embedPaths(exported)).toEqual(['data.extensions.luker.embedded_skills_source']);
            const items = exported.data.extensions.luker.embedded_skills_source.items;
            expect(items.map(item => item.name)).toEqual([NAMELESS_LEGACY_SKILL, MOVED_SKILL]);
            expect(items.find(item => item.name === NAMELESS_LEGACY_SKILL).files.find(f => f.path === 'SKILL.md').content).toBe(expectedLegacyMd);
            expect(items.find(item => item.name === MOVED_SKILL).files.find(f => f.path === 'SKILL.md').content).toBe(expectedMovedMd);
            expect(exported.data.extensions.luker.chat_completion_preset.preset.extensions.luker.retained_preset_marker).toBe('shoal-v1');
        }

        // Stored card and skill files remain byte-identical after every export.
        expect(readStoredCardBytes(installedAvatar).equals(installedBaselineBytes)).toBe(true);
        expect(readFileSync(characterSkillPath(installedAvatar, NAMELESS_LEGACY_SKILL)).equals(legacySkillBaseline)).toBe(true);
        expect(readFileSync(characterSkillPath(installedAvatar, MOVED_SKILL)).equals(movedSkillBaseline)).toBe(true);
    });

    test('named legacy chat_completion_preset { name, preset } installs skills, settles selection migration before baseline, and exports without mutating post-selection assets', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);

        const avatar = await importCard(page, {
            name: 'Rowan of the Breakwater',
            fileName: 'rowan-named-legacy.png',
            lukerExtensions: {
                chat_completion_preset: {
                    name: 'Breakwater Watch',
                    preset: {
                        temperature: 0.65,
                        extensions: {
                            luker: {
                                embedded_skills_source: embedPayload([
                                    { name: NAMED_LEGACY_SKILL, description: 'Fog beacon cadence.', body: NAMED_LEGACY_BODY },
                                ]),
                            },
                        },
                    },
                },
            },
        });
        expect(embedPaths(readStoredCardJson(avatar))).toEqual([
            'data.extensions.luker.chat_completion_preset.preset.extensions.luker.embedded_skills_source',
        ]);

        await openCardAndRespondToSkillDialog(page, avatar, [NAMED_LEGACY_SKILL], 'install');
        await expect.poll(() => existsSync(characterSkillPath(avatar, NAMED_LEGACY_SKILL)), { timeout: 15_000 }).toBe(true);
        const expectedMd = skillMd(NAMED_LEGACY_SKILL, 'Fog beacon cadence.', NAMED_LEGACY_BODY);
        expect(readFileSync(characterSkillPath(avatar, NAMED_LEGACY_SKILL), 'utf8')).toBe(expectedMd);

        // Wait for selection-time legacy `{ name, preset }` -> `{ presets[], defaultPresetName }` migration to settle.
        await expect.poll(() => {
            const binding = readStoredCardJson(avatar)?.data?.extensions?.luker?.chat_completion_preset;
            return Array.isArray(binding?.presets) && binding.presets[0]?.name === 'Breakwater Watch';
        }, { timeout: 15_000 }).toBe(true);

        // Capture post-selection, pre-export baseline.
        const postSelectionBytes = readStoredCardBytes(avatar);
        const skillBaseline = readFileSync(characterSkillPath(avatar, NAMED_LEGACY_SKILL));

        const skipPng = await exportCard(page, { tag: 'named-legacy', format: 'png', decision: 'skip', listed: [NAMED_LEGACY_SKILL] });
        const skipJson = await exportCard(page, { tag: 'named-legacy', format: 'json', decision: 'skip', listed: [NAMED_LEGACY_SKILL] });
        for (const exported of [skipPng, skipJson]) {
            expect(embedPaths(exported)).toEqual([]);
            expect(exported.data.extensions.luker.chat_completion_preset.presets.map(p => p.name)).toEqual(['Breakwater Watch']);
        }

        const includePng = await exportCard(page, { tag: 'named-legacy', format: 'png', decision: 'include', listed: [NAMED_LEGACY_SKILL] });
        const includeJson = await exportCard(page, { tag: 'named-legacy', format: 'json', decision: 'include', listed: [NAMED_LEGACY_SKILL] });
        for (const exported of [includePng, includeJson]) {
            expect(embedPaths(exported)).toEqual(['data.extensions.luker.embedded_skills_source']);
            const items = exported.data.extensions.luker.embedded_skills_source.items;
            expect(items.map(item => item.name)).toEqual([NAMED_LEGACY_SKILL]);
            expect(items[0].files.find(f => f.path === 'SKILL.md').content).toBe(expectedMd);
        }

        expect(readStoredCardBytes(avatar).equals(postSelectionBytes)).toBe(true);
        expect(readFileSync(characterSkillPath(avatar, NAMED_LEGACY_SKILL)).equals(skillBaseline)).toBe(true);
    });

    test('current multi-preset binding installs both card and bound-preset skills and strips bound-preset embeds on export', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);

        const avatar = await importCard(page, {
            name: 'Tamsin of the Headland',
            fileName: 'tamsin-current-multi.png',
            lukerExtensions: {
                embedded_skills_source: embedPayload([
                    { name: CURRENT_OWN_SKILL, description: 'Chart margin drift annotations.', body: CURRENT_OWN_BODY },
                ]),
                chat_completion_preset: {
                    presets: [{
                        name: 'Headland Watch',
                        preset: {
                            temperature: 0.71,
                            extensions: {
                                luker: {
                                    embedded_skills_source: embedPayload([
                                        { name: CURRENT_PRESET_SKILL, description: 'Brass bell strikes.', body: CURRENT_PRESET_BODY },
                                    ]),
                                },
                            },
                        },
                    }],
                    defaultPresetName: 'Headland Watch',
                },
            },
        });

        await openCardAndRespondToSkillDialog(page, avatar, [CURRENT_OWN_SKILL, CURRENT_PRESET_SKILL], 'install');
        await expect.poll(() => existsSync(characterSkillPath(avatar, CURRENT_OWN_SKILL))
            && existsSync(characterSkillPath(avatar, CURRENT_PRESET_SKILL)), { timeout: 15_000 }).toBe(true);
        const ownMd = skillMd(CURRENT_OWN_SKILL, 'Chart margin drift annotations.', CURRENT_OWN_BODY);
        const presetMd = skillMd(CURRENT_PRESET_SKILL, 'Brass bell strikes.', CURRENT_PRESET_BODY);
        expect(readFileSync(characterSkillPath(avatar, CURRENT_OWN_SKILL), 'utf8')).toBe(ownMd);
        expect(readFileSync(characterSkillPath(avatar, CURRENT_PRESET_SKILL), 'utf8')).toBe(presetMd);

        const postSelectionBytes = readStoredCardBytes(avatar);
        const listed = [CURRENT_OWN_SKILL, CURRENT_PRESET_SKILL];

        const skipJson = await exportCard(page, { tag: 'current-multi', format: 'json', decision: 'skip', listed });
        expect(embedPaths(skipJson)).toEqual([]);

        const includePng = await exportCard(page, { tag: 'current-multi', format: 'png', decision: 'include', listed });
        expect(embedPaths(includePng)).toEqual(['data.extensions.luker.embedded_skills_source']);
        const items = includePng.data.extensions.luker.embedded_skills_source.items;
        expect(items.map(item => item.name)).toEqual([CURRENT_OWN_SKILL, CURRENT_PRESET_SKILL]);
        expect(items.find(item => item.name === CURRENT_OWN_SKILL).files.find(f => f.path === 'SKILL.md').content).toBe(ownMd);
        expect(items.find(item => item.name === CURRENT_PRESET_SKILL).files.find(f => f.path === 'SKILL.md').content).toBe(presetMd);

        expect(readStoredCardBytes(avatar).equals(postSelectionBytes)).toBe(true);
    });
});
