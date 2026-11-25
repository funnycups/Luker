// #112 — Approving skill delete, skill create and new-file proposals after
// the skill changed on disk keeps the external state and retains the reviews.
//
// REAL USER-GESTURE flow:
//   1. Seed a global skill `reef-watch` on disk.
//   2. Open orchestration iteration and stage separate pending turns for
//      skill_delete(reef-watch), skill_create(tide-ledger) and
//      skill_update_content(reef-watch, references/tides.md) for a file that
//      does not exist yet.
//   3. Another writer edits reef-watch with a broken frontmatter, installs
//      tide-ledger, and creates references/tides.md.
//   4. Apply the pending turns → each review reports its conflict and disk keeps
//      the external state.

import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from './_helpers.js';

let server, mock;

const SEED = [
    '---',
    'name: reef-watch',
    'description: Night-watch routine for reading the Bryn reef from the headland lantern.',
    '---',
    '',
    'Read the reef at slack water.',
    '',
].join('\n');
const EXTERNAL_REEF = 'Read the reef at slack water. Ring the bell twice if the gull rocks go under.\n';
const EXTERNAL_LEDGER = '---\nname: tide-ledger\ndescription: Tide ledger kept by hand at the lantern.\n---\n\nWrite the hour of each turn.\n';
const EXTERNAL_TIDES = 'Low water at the second bell.\n';
const AFTER_APPROVE = 'None of the reef changes could be applied because the skills changed meanwhile.';

function globalSkills(dataRoot) {
    return resolve(dataRoot, 'default-user', 'skills', 'global');
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '112-orch-skill-delete-create-external-edit-conflict',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    mkdirSync(resolve(globalSkills(server.dataRoot), 'reef-watch'), { recursive: true });
    writeFileSync(resolve(globalSkills(server.dataRoot), 'reef-watch', 'SKILL.md'), SEED);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#112 — Orchestrator iter-studio skill delete, create and new-file proposals after external edits', () => {
    test('approval reports every conflict and retains pending reviews while disk keeps the external state', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openIterStudio(page, 'orch');
        const requests = [
            {
                prompt: 'Retire the reef-watch routine.',
                call: { name: 'skill_delete', arguments: { name: 'reef-watch', scope: { kind: 'global' } } },
                error: 'reef-watch changed on disk',
            },
            {
                prompt: 'Start a tide ledger beside the lantern.',
                call: { name: 'skill_create', arguments: {
                    name: 'tide-ledger',
                    scope: { kind: 'global' },
                    description: 'Log tide turns at the Bryn headland.',
                    body: 'Record each turn of the tide against the lantern bell.',
                } },
                error: 'tide-ledger changed on disk',
            },
            {
                prompt: 'Add tide notes to the reef-watch routine.',
                call: { name: 'skill_update_content', arguments: {
                    name: 'reef-watch', scope: { kind: 'global' }, path: 'references/tides.md', content: 'High water at the first bell.\n',
                } },
                error: 'reef-watch/references/tides.md changed on disk',
            },
        ];
        for (const request of requests) {
            mock.scriptToolCall(request.call);
            mock.scriptReply(AFTER_APPROVE);
            await sendIterPrompt(page, 'orch', request.prompt);
        }

        const popup = page.locator('.wbench .wb-win');
        const cards = popup.locator('.wb-chg.is-pending');
        await expect(cards).toHaveCount(3);
        await expect(cards.locator('.wb-chg-line')).toHaveCount(3);

        const root = globalSkills(server.dataRoot);
        writeFileSync(resolve(root, 'reef-watch', 'SKILL.md'), EXTERNAL_REEF);
        mkdirSync(resolve(root, 'reef-watch', 'references'), { recursive: true });
        writeFileSync(resolve(root, 'reef-watch', 'references', 'tides.md'), EXTERNAL_TIDES);
        mkdirSync(resolve(root, 'tide-ledger'), { recursive: true });
        writeFileSync(resolve(root, 'tide-ledger', 'SKILL.md'), EXTERNAL_LEDGER);

        for (const [index, request] of requests.entries()) {
            await cards.nth(index).locator('.wb-chg-foot button.is-primary').click();
            await expect(page.locator('.wbench .wb-toast')).toContainText(request.error);
            await expect(cards.nth(index)).toHaveClass(/is-pending/);
        }
        await expect(cards).toHaveCount(3);
        await expect(popup.locator('.wb-chg.is-applied')).toHaveCount(0);
        await expect(popup).toContainText(AFTER_APPROVE, { timeout: 15_000 });

        expect(readFileSync(resolve(root, 'reef-watch', 'SKILL.md'), 'utf8')).toBe(EXTERNAL_REEF);
        expect(readFileSync(resolve(root, 'reef-watch', 'references', 'tides.md'), 'utf8')).toBe(EXTERNAL_TIDES);
        expect(readFileSync(resolve(root, 'tide-ledger', 'SKILL.md'), 'utf8')).toBe(EXTERNAL_LEDGER);
    });
});
