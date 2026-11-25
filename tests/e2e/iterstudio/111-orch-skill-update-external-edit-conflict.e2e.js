// #111 — Approving a full-file skill proposal after the file changed on
// disk keeps the external edit and retains the pending review.
//
// REAL USER-GESTURE flow:
//   1. Seed a global skill `reef-watch` on disk.
//   2. Open the orchestrator iter-studio. The mock LLM answers round 1 with
//      skill_update_content(reef-watch) without expectedSha256, the call
//      shape the model uses; later rounds are plain text.
//   3. Another writer rewrites reef-watch/SKILL.md on disk.
//   4. Click Apply on the pending turn → the review reports the conflict, the
//      file on disk keeps the external edit.
//   5. Restart, reload, re-assert disk.

import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from './_helpers.js';

let server, mock;

const FRONTMATTER = [
    '---',
    'name: reef-watch',
    'description: Night-watch routine for reading the Bryn reef from the headland lantern.',
    '---',
    '',
].join('\n');
const SEED = `${FRONTMATTER}Read the reef at slack water, when the breakers north of the gull rocks show their true line.\n`;
const PROPOSED = `${FRONTMATTER}Read the reef at the turn of the ebb and log the breaker line against the lantern bell.\n`;
const EXTERNAL = `${FRONTMATTER}Read the reef at slack water. Ring the bell twice if the gull rocks go under.\n`;
const AFTER_APPROVE = 'The reef-watch rewrite could not be applied because the routine changed meanwhile.';

function reefWatchPath(dataRoot) {
    return resolve(dataRoot, 'default-user', 'skills', 'global', 'reef-watch', 'SKILL.md');
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '111-orch-skill-update-external-edit-conflict',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    mkdirSync(resolve(reefWatchPath(server.dataRoot), '..'), { recursive: true });
    writeFileSync(reefWatchPath(server.dataRoot), SEED);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#111 — Orchestrator iter-studio skill_update_content after an external edit', () => {
    test('approval reports the conflict and retains the pending review while disk keeps the external edit', async ({ page }) => {
        mock.scriptCompletion(({ turn }) => {
            if (turn === 0) {
                return {
                    toolCalls: [{
                        name: 'skill_update_content',
                        arguments: { name: 'reef-watch', scope: { kind: 'global' }, path: 'SKILL.md', content: PROPOSED },
                    }],
                };
            }
            return { text: AFTER_APPROVE };
        });

        await awaitMainUI(page, server.baseURL);
        await openIterStudio(page, 'orch');
        await sendIterPrompt(page, 'orch', 'Rewrite the reef-watch routine around the turn of the ebb.');

        const popup = page.locator('.wbench .wb-win');
        const card = popup.locator('.wb-chg');
        await expect(card).toHaveCount(1);
        await expect(card).toHaveClass(/is-pending/);
        expect(readFileSync(reefWatchPath(server.dataRoot), 'utf8')).toBe(SEED);

        writeFileSync(reefWatchPath(server.dataRoot), EXTERNAL);
        await card.locator('.wb-chg-foot button.is-primary').click();

        await expect(page.locator('.wbench .wb-toast')).toContainText('reef-watch/SKILL.md changed on disk');
        await expect(card).toHaveClass(/is-pending/);
        await expect(popup.locator('.wb-chg.is-applied')).toHaveCount(0);
        await expect(popup).toContainText(AFTER_APPROVE, { timeout: 15_000 });
        expect(readFileSync(reefWatchPath(server.dataRoot), 'utf8')).toBe(EXTERNAL);

        await closeIterStudio(page);
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        expect(readFileSync(reefWatchPath(server.dataRoot), 'utf8')).toBe(EXTERNAL);
    });
});
