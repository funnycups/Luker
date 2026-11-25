// #144 — "+ New file" in the skill editor refuses a path that already
// exists instead of emptying that file.
//
// REAL USER-GESTURE flow:
//   1. Seed a global skill `lantern-log` with references/notes.md.
//   2. Orchestrator settings → "Manage skills..." → Edit on lantern-log.
//   3. Click "+ New file", type references/notes.md, click Create.
//   4. The "Create failed" toast shows and references/notes.md keeps its
//      content.

import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openOrchestratorSkillManager } from '../_lib/ui-orchestrator.js';

let server, mock;

const SKILL_MD = '---\nname: lantern-log\ndescription: Keep the lantern log for the headland watch.\n---\n\nNote the hour each time the lantern is trimmed.\n';
const NOTES = 'Fog came in at the third bell; the lantern was trimmed twice.\n';

function skillDir(dataRoot) {
    return resolve(dataRoot, 'default-user', 'skills', 'global', 'lantern-log');
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'regression',
        scenarioId: '144-skill-editor-new-file-existing-path',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    mkdirSync(resolve(skillDir(server.dataRoot), 'references'), { recursive: true });
    writeFileSync(resolve(skillDir(server.dataRoot), 'SKILL.md'), SKILL_MD);
    writeFileSync(resolve(skillDir(server.dataRoot), 'references', 'notes.md'), NOTES);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#144 — skill editor "+ New file" with an existing path', () => {
    test('create is refused with the Create failed toast and the file keeps its content', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openOrchestratorSkillManager(page);

        const row = page.locator('.popup:visible .luker_skill_row[data-skill-name="lantern-log"]');
        await row.waitFor({ state: 'visible', timeout: 15_000 });
        await row.locator('[data-skill-action="edit"]').click();

        await expect(page.locator('.popup:visible [data-editor-textarea]').last()).toHaveValue(SKILL_MD, { timeout: 15_000 });
        await page.locator('.popup:visible [data-editor-action="new-file"]').last().click();

        const input = page.locator('dialog.popup[open] .popup-input').last();
        await input.waitFor({ state: 'visible', timeout: 10_000 });
        await input.fill('references/notes.md');
        await page.locator('dialog.popup[open] .popup-button-ok').last().click();

        await expect(page.locator('#toast-container .toast', { hasText: 'Create failed' })).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#toast-container .toast', { hasText: 'Created references/notes.md' })).toHaveCount(0);
        expect(readFileSync(resolve(skillDir(server.dataRoot), 'references', 'notes.md'), 'utf8')).toBe(NOTES);
    });
});
