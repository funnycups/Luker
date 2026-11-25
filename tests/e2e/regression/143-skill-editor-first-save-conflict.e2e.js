// #143 — The skill editor refuses its first save when the file changed on
// disk after the editor opened it.
//
// REAL USER-GESTURE flow:
//   1. Seed a global skill `lantern-log` on disk.
//   2. Orchestrator settings → "Manage skills..." → Edit on lantern-log.
//      The editor opens SKILL.md.
//   3. Another writer rewrites lantern-log/SKILL.md on disk.
//   4. Type into the editor and click Save → the "File changed on disk"
//      toast shows and disk keeps the external edit.

import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openOrchestratorSkillManager } from '../_lib/ui-orchestrator.js';

let server, mock;

const FRONTMATTER = [
    '---',
    'name: lantern-log',
    'description: Keep the lantern log for the headland watch.',
    '---',
    '',
].join('\n');
const SEED = `${FRONTMATTER}Note the hour each time the lantern is trimmed.\n`;
const EXTERNAL = `${FRONTMATTER}Note the hour each time the lantern is trimmed. Mark fog with a cross.\n`;
const TYPED = `${FRONTMATTER}Note the hour and the oil level each time the lantern is trimmed.\n`;

function lanternLogPath(dataRoot) {
    return resolve(dataRoot, 'default-user', 'skills', 'global', 'lantern-log', 'SKILL.md');
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'regression',
        scenarioId: '143-skill-editor-first-save-conflict',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    mkdirSync(resolve(lanternLogPath(server.dataRoot), '..'), { recursive: true });
    writeFileSync(lanternLogPath(server.dataRoot), SEED);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#143 — skill editor first save after an external edit', () => {
    test('save is refused with the file-changed toast and disk keeps the external edit', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openOrchestratorSkillManager(page);

        const row = page.locator('.popup:visible .luker_skill_row[data-skill-name="lantern-log"]');
        await row.waitFor({ state: 'visible', timeout: 15_000 });
        await row.locator('[data-skill-action="edit"]').click();

        const textarea = page.locator('.popup:visible [data-editor-textarea]').last();
        await expect(textarea).toHaveValue(SEED, { timeout: 15_000 });

        writeFileSync(lanternLogPath(server.dataRoot), EXTERNAL);
        await textarea.fill(TYPED);
        await page.locator('.popup:visible [data-editor-save]').last().click();

        await expect(page.locator('#toast-container .toast', { hasText: 'File changed on disk' })).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#toast-container .toast', { hasText: 'Saved SKILL.md' })).toHaveCount(0);
        expect(readFileSync(lanternLogPath(server.dataRoot), 'utf8')).toBe(EXTERNAL);
    });
});
