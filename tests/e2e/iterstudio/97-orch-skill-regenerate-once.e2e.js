// #97 — Regenerate after approving skill proposals does not replay them.
//
// REAL USER-GESTURE flow:
//   1. Seed a global skill `reef-watch` on disk and a stored spec preset in
//      the legacy raw shape: its agent carries only the prompt fields.
//   2. Open the orchestrator iter-studio. The mock LLM answers round 1 with
//      skill_create(tide-ledger), skill_edit_content(reef-watch) and a spec
//      preset edit (luker_orch_set_preset); later rounds are plain text.
//   3. "Approve all pending" → tide-ledger installed, reef-watch edited,
//      spec preset written.
//   4. Click Regenerate on the round-1 assistant message. The preset edit
//      rolls back to the stored preset in its committed shape; the skill
//      commits stay as they are
//      and the turn is re-sent to the model. A replayed skill_edit_content
//      (its oldString is gone) or a drifting profile rollback aborts
//      regenerate with a "Regenerate aborted" toast.
//   5. Restart, reload, re-assert disk.

import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from './_helpers.js';

let server, mock;

const PRESET_ID = 'tide_narrator';
const PRESET_PROMPT = 'You narrate the Bryn headland watch. Anchor every line to the tide bell and the lantern.';
const OLD_LINE = 'Read the reef at slack water';
const NEW_LINE = 'Read the reef at the turn of the ebb';
const SKILL_MD = [
    '---',
    'name: reef-watch',
    'description: Night-watch routine for reading the Bryn reef from the headland lantern.',
    '---',
    '',
    `${OLD_LINE}, when the breakers north of the gull rocks show their true line.`,
    '',
].join('\n');
const STORED_AGENT_ID = 'lookout';
const STORED_AGENT = {
    systemPrompt: 'You keep the headland lookout log in short bell-by-bell lines.',
    userPromptTemplate: 'Log the next bell of the watch.',
};
const AFTER_APPROVE = 'The tide ledger skill is installed and the reef-watch routine now waits for the turn of the ebb.';
const AFTER_REGENERATE = 'Second pass on the watch notes: the ledger and the reef routine already match the tide bell.';

function skillsRoot(dataRoot) {
    return resolve(dataRoot, 'default-user', 'skills', 'global');
}

function readReefWatch(dataRoot) {
    return readFileSync(resolve(skillsRoot(dataRoot), 'reef-watch', 'SKILL.md'), 'utf8');
}

function readSpecPreset(dataRoot) {
    const s = JSON.parse(readFileSync(resolve(dataRoot, 'default-user', 'settings.json'), 'utf8'));
    const ext = s?.extension_settings?.orchestrator;
    const activeId = ext?.activePresetIds?.spec || '';
    return activeId ? (ext?.presetLibraries?.spec?.[activeId] || null) : null;
}

function seedLegacySpecPreset(dataRoot) {
    const sp = resolve(dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    const orch = (s.extension_settings.orchestrator = s.extension_settings.orchestrator || {});
    orch.presetLibraries = {
        spec: {
            default: {
                name: 'Default',
                spec: { stages: [{ id: 'watch', mode: 'serial', nodes: [{ id: STORED_AGENT_ID, preset: STORED_AGENT_ID }] }] },
                presets: { [STORED_AGENT_ID]: { ...STORED_AGENT } },
            },
        },
        agenda: {},
        loop: {},
        director: {},
    };
    orch.activePresetIds = { spec: 'default', agenda: '', loop: '', director: '' };
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

function chatRequestCount() {
    return mock.requests.filter(r => String(r.url || '').includes('/chat/completions')).length;
}

function countOccurrences(haystack, needle) {
    return haystack.split(needle).length - 1;
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '97-orch-skill-regenerate-once',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    seedLegacySpecPreset(server.dataRoot);
    mkdirSync(resolve(skillsRoot(server.dataRoot), 'reef-watch'), { recursive: true });
    writeFileSync(resolve(skillsRoot(server.dataRoot), 'reef-watch', 'SKILL.md'), SKILL_MD);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#97 — Orchestrator iter-studio regenerate rolls back the preset edit and keeps approved skill commits single', () => {
    test('regenerate rolls back the preset edit, keeps skills as committed once, and re-sends the turn', async ({ page }) => {
        mock.scriptCompletion(({ turn }) => {
            if (turn === 0) {
                return {
                    toolCalls: [
                        {
                            name: 'skill_create',
                            arguments: {
                                name: 'tide-ledger',
                                scope: { kind: 'global' },
                                description: 'Log tide turns at the Bryn headland.',
                                body: 'Record each turn of the tide against the lantern bell.',
                            },
                        },
                        {
                            name: 'skill_edit_content',
                            arguments: { name: 'reef-watch', scope: { kind: 'global' }, path: 'SKILL.md', oldString: OLD_LINE, newString: NEW_LINE },
                        },
                        {
                            name: 'luker_orch_set_preset',
                            arguments: {
                                preset_id: PRESET_ID,
                                systemPrompt: PRESET_PROMPT,
                                userPromptTemplate: 'Continue the headland watch narration.',
                            },
                        },
                    ],
                };
            }
            return { text: turn === 1 ? AFTER_APPROVE : AFTER_REGENERATE };
        });

        await awaitMainUI(page, server.baseURL);
        await openIterStudio(page, 'orch');
        await sendIterPrompt(page, 'orch', 'Give the night watch a tide ledger skill, move the reef routine to the turn of the ebb, and add a tide narrator preset.');

        const popup = page.locator('.wbench .wb-win');
        await expect(popup.locator('.wb-chg.is-pending .wb-chg-line')).toHaveCount(3);
        expect(readSpecPreset(server.dataRoot)?.presets).toEqual({ [STORED_AGENT_ID]: STORED_AGENT });
        await applyIterBatch(page, 'orch');

        await expect.poll(() => existsSync(resolve(skillsRoot(server.dataRoot), 'tide-ledger', 'SKILL.md')), { timeout: 15_000 }).toBe(true);
        await expect.poll(() => readReefWatch(server.dataRoot), { timeout: 15_000 }).toContain(NEW_LINE);
        await expect.poll(() => readSpecPreset(server.dataRoot)?.presets?.[PRESET_ID]?.systemPrompt || '', { timeout: 15_000 }).toBe(PRESET_PROMPT);
        await expect(popup).toContainText(AFTER_APPROVE, { timeout: 15_000 });
        // Approve writes the committed shape: the stored agent gains the
        // empty connection and prompt preset slots and inherits tools.
        const committedAgent = { ...STORED_AGENT, apiPresetName: '', promptPresetName: '', tools: null };
        const approvedPreset = readSpecPreset(server.dataRoot);
        expect(approvedPreset.presets[STORED_AGENT_ID]).toEqual(committedAgent);
        const storedPreset = {
            ...approvedPreset,
            presets: { [STORED_AGENT_ID]: committedAgent },
        };

        const requestsBeforeRegenerate = chatRequestCount();
        await popup.locator('.wb-msg-acts button.wb-msg-act', { hasText: 'Answer again' }).last().click();

        await expect.poll(chatRequestCount, { timeout: 30_000 }).toBeGreaterThan(requestsBeforeRegenerate);
        await expect(popup).toContainText(AFTER_REGENERATE, { timeout: 30_000 });
        await expect(page.locator('#toast-container', { hasText: 'Regenerate aborted' })).toHaveCount(0);

        await expect.poll(() => readSpecPreset(server.dataRoot)?.presets?.[PRESET_ID] ?? null, { timeout: 15_000 }).toBeNull();
        expect(readSpecPreset(server.dataRoot)).toEqual(storedPreset);
        const reef = readReefWatch(server.dataRoot);
        expect(countOccurrences(reef, NEW_LINE)).toBe(1);
        expect(reef).not.toContain(OLD_LINE);
        expect(readdirSync(skillsRoot(server.dataRoot)).filter(n => n.includes('tide-ledger'))).toEqual(['tide-ledger']);

        await closeIterStudio(page);
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        expect(countOccurrences(readReefWatch(server.dataRoot), NEW_LINE)).toBe(1);
        expect(existsSync(resolve(skillsRoot(server.dataRoot), 'tide-ledger', 'SKILL.md'))).toBe(true);
        expect(readSpecPreset(server.dataRoot)).toEqual(storedPreset);
    });
});
