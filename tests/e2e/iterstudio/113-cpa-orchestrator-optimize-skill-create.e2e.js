// #113 — CPA "Adapt for orchestrator" mode authors a skill into the edited
// preset's scope.
//
// REAL USER-GESTURE flow:
//   1. Select the Default chat completion preset and open the Completion
//      Preset Assistant.
//   2. Switch the session mode dropdown to orchestrator-optimize.
//   3. Send a prompt. The mock LLM answers round 1 with skill_create
//      targeting the Default preset scope; later rounds are plain text.
//   4. The round-1 request offers the skill tools; the skill card renders
//      with an Approve button and nothing is written yet.
//   5. "Approve all pending" → skills/preset/Default/<name>/SKILL.md holds
//      the authored body, and nothing lands in global scope.

import { test, expect } from '../../harness/playwright.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch } from '../_lib/ui-iter-studio.js';
import { selectPresetByName, normalizeIterStudioSettings } from '../preset/_helpers.js';

let server, mock;

const PRESET = 'Default';
const SKILL = 'slow-tide-pacing';
const SKILL_BODY = 'Hold each scene through one full turn of the tide before the reef or the keeper changes course.';
const AFTER_APPROVE = 'The slow-tide pacing skill now travels with the Default preset.';

function presetSkillPath() {
    return resolve(server.dataRoot, 'default-user', 'skills', 'preset', PRESET, SKILL, 'SKILL.md');
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '113-cpa-orchestrator-optimize-skill-create',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#113 — CPA orchestrator-optimize skill_create', () => {
    test('skill_create lands in the edited preset scope after Approve', async ({ page }) => {
        mock.scriptCompletion(({ turn }) => {
            if (turn === 0) {
                return {
                    toolCalls: [{
                        name: 'skill_create',
                        arguments: {
                            name: SKILL,
                            scope: { kind: 'preset', name: PRESET },
                            description: 'Scene pacing that waits on the tide.',
                            body: SKILL_BODY,
                        },
                    }],
                };
            }
            return { text: AFTER_APPROVE };
        });

        await awaitMainUI(page, server.baseURL);
        await selectPresetByName(page, PRESET);
        await openIterStudio(page, 'cpa');

        const popup = page.locator('.wbench .wb-win');
        const modeSelect = popup.locator('[data-wb-preset-control="mode"]');
        await modeSelect.selectOption('orchestrator-optimize');
        await expect(modeSelect).toHaveValue('orchestrator-optimize');

        const requestStart = mock.requests.length;
        await sendIterPrompt(page, 'cpa', 'Lift the slow tide pacing rule out of this preset into a skill the orchestrator agents can read.');

        const firstRequest = mock.requests.slice(requestStart).find(r => /chat\/completions/.test(String(r.url || '')));
        expect((firstRequest.body.tools || []).map(t => t?.function?.name)).toContain('skill_create');
        await expect(popup.locator('.wb-chg.is-pending .wb-chg-line')).toHaveCount(1);
        expect(existsSync(presetSkillPath())).toBe(false);

        await applyIterBatch(page, 'cpa');
        await expect.poll(() => existsSync(presetSkillPath()), { timeout: 15_000 }).toBe(true);
        expect(readFileSync(presetSkillPath(), 'utf8')).toContain(SKILL_BODY);
        expect(existsSync(resolve(server.dataRoot, 'default-user', 'skills', 'global', SKILL))).toBe(false);
        await expect(popup).toContainText(AFTER_APPROVE, { timeout: 15_000 });
    });
});
