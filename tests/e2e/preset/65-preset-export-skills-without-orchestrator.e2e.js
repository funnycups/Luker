// #65 — Chat completion preset export bundles preset-scope skills with the
// Multi-Agent Orchestrator extension disabled.
//
// REAL USER-GESTURE flow:
//   1. Seed a skill in the Default preset's scope on disk.
//   2. Extensions drawer → Manage extensions → untick the orchestrator →
//      close the popup; the page reloads without the orchestrator.
//   3. AI Response Configuration → Export preset → the confirm popup lists
//      the skill → Include. The downloaded JSON carries the skill payload.

import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer } from '../_lib/page.js';
import { selectPresetByName, openAiResponseConfigDrawer } from './_helpers.js';

const PRESET = 'Default';
const SKILL = 'tide-pacing';
const SKILL_MD = [
    '---',
    `name: ${SKILL}`,
    'description: Pace night-watch scenes by the turn of the tide.',
    '---',
    '',
    'Let each scene close on the next turn of the tide rather than on a cliffhanger.',
    '',
].join('\n');

let server, mock, scratchDir;

async function disableOrchestratorViaUI(page) {
    await openExtensionsDrawer(page);
    await page.locator('#extensions_details').click();
    const popup = page.locator('dialog.popup[open]', { has: page.locator('.extensions_info') });
    await expect(popup).toBeVisible({ timeout: 15_000 });
    const toggle = popup.locator('.extension_block[data-name="orchestrator"] .extension_toggle input[type="checkbox"]');
    await expect(toggle).toBeChecked({ timeout: 15_000 });
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    const reloaded = page.waitForEvent('load', { timeout: 30_000 });
    await popup.locator('.popup-button-ok').click();
    await reloaded;
    await awaitMainUI(page, server.baseURL);
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'preset',
        scenarioId: '65-preset-export-skills-without-orchestrator',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    const skillDir = resolve(server.dataRoot, 'default-user', 'skills', 'preset', PRESET, SKILL);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, 'SKILL.md'), SKILL_MD);
    scratchDir = (await scope.directory('preset skills export files')).path;
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#65 — preset export bundles skills without the orchestrator', () => {
    test('Include bundles the preset-scope skill while the orchestrator extension is disabled', async ({ page }) => {
        test.setTimeout(120_000);
        await awaitMainUI(page, server.baseURL);
        await disableOrchestratorViaUI(page);
        await expect.poll(() => page.evaluate(() => Boolean(window.Luker.getContext().getExtensionApi?.('orchestrator')))).toBe(false);

        await selectPresetByName(page, PRESET);
        await openAiResponseConfigDrawer(page);
        const download = page.waitForEvent('download', { timeout: 30_000 });
        await page.locator('#export_oai_preset').click();
        const confirm = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_export_confirm') });
        await expect(confirm).toBeVisible({ timeout: 15_000 });
        await expect(confirm.locator('.luker_skill_export_confirm_list li')).toHaveText([SKILL]);
        await confirm.locator('.popup-button-ok').click();
        const target = resolve(scratchDir, 'exported-preset.json');
        await (await download).saveAs(target);

        const exported = JSON.parse(readFileSync(target, 'utf8'));
        const payload = exported?.extensions?.luker?.embedded_skills_source;
        expect(payload?.version).toBe(1);
        expect(payload.items.map(item => item.name)).toEqual([SKILL]);
        expect(payload.items[0].files.find(f => f.path === 'SKILL.md').content).toBe(SKILL_MD);
    });
});
