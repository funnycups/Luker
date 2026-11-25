// #92 — A skill attached through the orchestration editor's mode-level
// skill chips is visible to the director, and skill_read hands its on-disk
// body back to the main agent mid-turn.
//
// REAL USER-GESTURE flow:
//   1. Seed a global skill `lantern-log` on disk. Install a minimal director
//      profile with no visible skills.
//   2. Open the orchestration editor popup → Tools & Skills → pick
//      lantern-log in the mode-level skills "Add..." dropdown → General →
//      Save To Global. settings.json holds lantern-log in the mode-level
//      visible list.
//   3. Send a chat message. The mock LLM answers the director main agent
//      with skill_read(lantern-log), then write_message, then finalize.
//   4. Assert the main agent's first request lists lantern-log in its
//      <available_skills> block, the follow-up request carries the skill
//      body as the skill_read tool result, and the reply bubble shows the
//      written message.

import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { installMinimalDirectorProfile, saveOrchDrafts } from '../_lib/ui-orchestrator.js';
import { openOrchWorkspace } from '../_lib/ui-workbench.js';

let server, mock;

const SKILL = 'lantern-log';
const SKILL_BODY = 'Trim the wick at slack water and enter the hour in the log before the bell rings twice.';
const SKILL_MD = [
    '---',
    `name: ${SKILL}`,
    'description: Keep the lantern log for the headland watch.',
    '---',
    '',
    SKILL_BODY,
    '',
].join('\n');
const FINAL_TEXT = '*Seraphina trims the wick, then writes the hour into the lantern log in a small, careful hand.* "Two bells. The light holds."';

function readActiveDirectorEntry() {
    const s = JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));
    const orch = s?.extension_settings?.orchestrator;
    const activeId = orch?.activePresetIds?.director || '';
    return activeId ? (orch?.presetLibraries?.director?.[activeId] || null) : null;
}

function isMainRequest(record) {
    const tools = Array.isArray(record.body?.tools) ? record.body.tools : [];
    return tools.some(t => t?.function?.name === 'finalize');
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'orchestrator',
        scenarioId: '92-director-skill-chip-skill-read',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    const skillDir = resolve(server.dataRoot, 'default-user', 'skills', 'global', SKILL);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, 'SKILL.md'), SKILL_MD);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#92 — director reads a skill attached through the skill chips', () => {
    test('chip-attached skill is listed to the main agent and skill_read returns its body', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await installMinimalDirectorProfile(page, {
            modeSkills: { visible: [], deny: [] },
            agentSkills: { visible: ['+'], deny: [] },
        });

        const lens = await openOrchWorkspace(page, 'setup');
        const skillsSection = lens.locator('section.ol-setup-section').filter({
            has: page.locator('.lw-sec-title', { hasText: /^(Skills|技能)$/i }),
        }).first();
        const modeChips = skillsSection.locator('.ol-setup-chips').first();
        const addSelect = modeChips.locator('[data-skill-chip-add-select]');
        await expect(addSelect).toBeVisible({ timeout: 15_000 });
        await addSelect.selectOption(SKILL);
        await expect(modeChips.locator(`.luker_skill_chip[data-skill-chip-name="${SKILL}"]`)).toBeVisible();

        await saveOrchDrafts(page, { closeAfter: true });
        await expect.poll(() => readActiveDirectorEntry()?.skills?.visible || [], { timeout: 15_000 }).toEqual([SKILL]);

        const requestStart = mock.requests.length;
        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role !== 'director-main') return null;
                if (turn === 0) return { tool: 'skill_read', arguments: { name: SKILL } };
                if (turn === 1) return { tool: 'write_message', arguments: { text: FINAL_TEXT, mode: 'replace' } };
                if (turn === 2) return { tool: 'finalize', arguments: {} };
                return null;
            },
        });

        await sendMessageAndAwaitReply(page, '*She glances at the guttering lantern.* "Is it time to log the hour?"', { timeoutMs: 60_000 });
        await expect(page.locator('#chat .mes').last().locator('.mes_text')).toContainText('The light holds.', { timeout: 30_000 });

        const mainRequests = mock.requests.slice(requestStart)
            .filter(r => /chat\/completions/.test(String(r.url || '')) && isMainRequest(r));
        expect(mainRequests.length).toBeGreaterThanOrEqual(2);

        const first = mainRequests[0].body;
        const firstMessages = first.messages.map(m => String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
        const catalogStart = firstMessages.indexOf('<available_skills>');
        expect(catalogStart, `main agent request carries <available_skills>; roles: ${first.messages.map(m => m.role).join(',')}`).toBeGreaterThanOrEqual(0);
        const catalog = firstMessages.slice(catalogStart, firstMessages.indexOf('</available_skills>', catalogStart));
        expect(catalog).toContain(SKILL);
        expect(first.tools.map(t => t.function.name)).toContain('skill_read');

        const toolResults = mainRequests[1].body.messages.filter(m => m.role === 'tool').map(m => String(m.content));
        expect(toolResults.some(c => c.includes(SKILL_BODY))).toBe(true);
    });
});
