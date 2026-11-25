// #91 — Skill manager: the Installed tab lists a seeded skill, the Browse
// bundled tab installs a shipped skill, and "Move to..." moves the skill
// directory between scopes on disk.
//
// REAL USER-GESTURE flow:
//   1. Seed a global skill `lantern-log` and the Ash card on disk.
//   2. Orchestrator settings → "Manage skills..." → the Installed tab lists
//      lantern-log under global scope.
//   3. Browse bundled tab → every shipped skill is listed as not installed
//      (the seeded global scope skips the first-run populate); "Install
//      this" on one shipped skill copies it into skills/global/.
//   4. Back on Installed: "Move to..." on lantern-log → pick the Default
//      chat completion preset → OK. The skill directory moves from
//      skills/global/ to skills/preset/Default/.
//   5. "Move to..." again → pick the Ash character → OK. The skill
//      directory moves to skills/character/<avatar>/ with the body intact.

import { test, expect } from '../../harness/playwright.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openOrchestratorSkillManager } from '../_lib/ui-orchestrator.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock, avatar;

const SKILL = 'lantern-log';
const SKILL_MD = [
    '---',
    `name: ${SKILL}`,
    'description: Keep the lantern log for the headland watch.',
    '---',
    '',
    'Note the hour each time the lantern is trimmed, and mark fog with a cross.',
    '',
].join('\n');

function skillsRoot() {
    return resolve(server.dataRoot, 'default-user', 'skills');
}

function bundledSkillNames() {
    const root = resolve(import.meta.dirname, '../../../default/skills/global');
    return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
}

async function moveSkillTo(page, popup, pick) {
    await popup.locator(`.luker_skill_row[data-skill-name="${SKILL}"] [data-skill-action="move"]`).click();
    const picker = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_scope_picker') });
    await expect(picker).toBeVisible();
    await pick(picker);
    await picker.locator('.popup-button-ok').click();
    await expect(picker).toBeHidden();
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'orchestrator',
        scenarioId: '91-skill-manager-move-scope',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    avatar = writeEmbeddedCharacter({ dataRoot: server.dataRoot });
    mkdirSync(resolve(skillsRoot(), 'global', SKILL), { recursive: true });
    writeFileSync(resolve(skillsRoot(), 'global', SKILL, 'SKILL.md'), SKILL_MD);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#91 — skill manager tabs and Move to...', () => {
    test('Installed lists the skill, Browse bundled installs a shipped skill, Move to... moves the directory across scopes', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        const popup = await openOrchestratorSkillManager(page);
        const row = popup.locator(`.luker_skill_row[data-skill-name="${SKILL}"]`);
        await expect(row).toBeVisible({ timeout: 15_000 });
        await expect(row).toHaveAttribute('data-skill-scope', JSON.stringify({ kind: 'global' }));

        await popup.locator('[data-skill-tab="bundled"]').click();
        const bundledRows = popup.locator('[data-bundled-row]');
        await expect(bundledRows.first()).toBeVisible({ timeout: 15_000 });
        const shipped = bundledSkillNames();
        expect(shipped.length).toBeGreaterThan(0);
        await expect(bundledRows).toHaveCount(shipped.length);
        for (const name of shipped) {
            await expect(popup.locator(`[data-bundled-row][data-bundled-name="${name}"]`)).toHaveAttribute('data-bundled-state', 'not_installed');
        }
        const [bundledPick] = shipped;
        await popup.locator(`[data-bundled-action="install"][data-bundled-name="${bundledPick}"]`).click();
        await expect(popup.locator(`[data-bundled-row][data-bundled-name="${bundledPick}"]`)).toHaveAttribute('data-bundled-state', 'installed_match', { timeout: 15_000 });
        expect(readFileSync(resolve(skillsRoot(), 'global', bundledPick, 'SKILL.md'), 'utf8'))
            .toBe(readFileSync(resolve(import.meta.dirname, '../../../default/skills/global', bundledPick, 'SKILL.md'), 'utf8'));

        await popup.locator('[data-skill-tab="installed"]').click();
        await expect(row).toBeVisible();
        await expect(popup.locator(`.luker_skill_row[data-skill-name="${bundledPick}"]`)).toBeVisible();

        await moveSkillTo(page, popup, async (picker) => {
            await picker.locator('input[name="luker_skill_scope_kind"][value="preset"]').check();
            await picker.locator('[data-skill-scope-preset]').selectOption('Default');
        });
        await expect(row).toHaveAttribute('data-skill-scope', JSON.stringify({ kind: 'preset', name: 'Default' }), { timeout: 15_000 });
        expect(existsSync(resolve(skillsRoot(), 'global', SKILL))).toBe(false);
        expect(readFileSync(resolve(skillsRoot(), 'preset', 'Default', SKILL, 'SKILL.md'), 'utf8')).toBe(SKILL_MD);

        await moveSkillTo(page, popup, async (picker) => {
            await picker.locator('input[name="luker_skill_scope_kind"][value="character"]').check();
            await picker.locator('[data-skill-scope-character]').selectOption(avatar);
        });
        await expect(row).toHaveAttribute('data-skill-scope', JSON.stringify({ kind: 'character', characterFile: avatar }), { timeout: 15_000 });
        expect(existsSync(resolve(skillsRoot(), 'preset', 'Default', SKILL))).toBe(false);
        expect(readFileSync(resolve(skillsRoot(), 'character', avatar, SKILL, 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    });
});
