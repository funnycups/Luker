// #35 — CardApp ctx.setOrchestratorOverride switches the card's orchestrator
// preset and saves the card file.
//
// REAL USER FLOW: import a PNG card that carries a loop-mode orchestrator
// preset library (reef_watch active, tide_log available) plus an embedded
// CardApp whose button calls ctx.getOrchestratorOverride() and
// ctx.setOrchestratorOverride({ presetId: 'tide_log' }). Select the card so
// the CardApp loader runs it, click the button, read the CardApp's own
// result, then prove the card file on disk carries the new active preset
// across a server restart.

import { test, expect } from '../../harness/playwright.js';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, appendConnectionProfile } from '../_lib/fixtures.js';
import { awaitMainUI, closeRightNavDrawer, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { dismissAnyPopup, disableTagImportPopup } from './_helpers.js';
import { importCharacterFile } from '../_lib/ui-character.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';
import {
    editOrchAgentField,
    enableOrchestratorMode,
    getOrchRuntimeLimitInput,
    readOrchAgentField,
} from '../_lib/ui-orchestrator.js';
import { closeWorkbench, setOrchMode } from '../_lib/ui-workbench.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const NAME = 'Maren of the Tide House';

// Plain string (no template literal) so the module's own syntax does not
// collide with this file's.
const CARD_APP_ENTRY = [
    'export function init(ctx) {',
    '    const btn = document.createElement("button");',
    '    btn.id = "tide-house-switch";',
    '    btn.textContent = "Open the tide log";',
    '    const out = document.createElement("pre");',
    '    out.id = "tide-house-result";',
    '    btn.addEventListener("click", async () => {',
    '        const before = ctx.getOrchestratorOverride();',
    '        let ok = null;',
    '        let error = "";',
    '        try {',
    '            ok = await ctx.setOrchestratorOverride({ presetId: "tide_log" });',
    '        } catch (err) {',
    '            error = String(err && err.message || err);',
    '        }',
    '        const after = ctx.getOrchestratorOverride();',
    '        out.textContent = JSON.stringify({ before, ok, after, error });',
    '    });',
    '    ctx.container.appendChild(btn);',
    '    ctx.container.appendChild(out);',
    '    const clear = document.createElement("button");',
    '    clear.id = "tide-house-clear";',
    '    clear.textContent = "Return to the common watch";',
    '    clear.addEventListener("click", async () => {',
    '        out.textContent = JSON.stringify({ cleared: await ctx.clearOrchestratorOverride() });',
    '    });',
    '    ctx.container.appendChild(clear);',
    '}',
    '',
].join('\n');

const LOOP_PRESETS = {
    reef_watch: { name: 'Reef watch', system_prompt: 'Narrate the night reef from the tide-house window.', tools: {}, max_rounds: 6, wall_clock_budget_ms: 60000 },
    tide_log: { name: 'Tide log', system_prompt: 'Keep the tide log in Maren\'s clipped hand, one line per bell.', tools: {}, max_rounds: 6, wall_clock_budget_ms: 60000 },
};

let server, mock, tmpDir, pngPath;

async function readCardOrchestrator(page, avatar) {
    return await page.evaluate(async (avatarUrl) => {
        const ctx = window.Luker.getContext();
        const resp = await fetch('/api/characters/get', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatarUrl }),
        });
        const data = await resp.json();
        return data?.data?.extensions?.orchestrator || null;
    }, avatar);
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'character', scenarioId: '35-cardapp-orchestrator-override' });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    tmpDir = (await scope.directory('luker-e2e-35')).path;
    const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
    const v2 = {
        name: NAME,
        description: 'Keeper of the tide house on the western channel. Reads the water by glass and by bell.',
        personality: 'Exacting, patient, wry about anyone who trusts a chart over the water.',
        scenario: 'You share the tide house with Maren through the long night watch.',
        first_mes: '*Maren turns the tide-glass and marks the bell in the log.* "Slack water in a quarter hour. Sit where you can see the channel."',
        mes_example: '',
        creator_notes: 'e2e fixture — CardApp orchestrator preset switch',
        system_prompt: 'You are Maren. Stay in scene.',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {
            card_app: { enabled: true, entry: 'index.js', files: { 'index.js': CARD_APP_ENTRY } },
            orchestrator: {
                override: { mode: 'loop' },
                presetLibraries: { spec: {}, agenda: {}, director: {}, loop: LOOP_PRESETS },
                activePresetIds: { spec: '', agenda: '', loop: 'reef_watch', director: '' },
            },
        },
    };
    pngPath = resolve(tmpDir, 'maren.png');
    writeFileSync(pngPath, writePngCard(seed, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', ...v2, data: v2 })));
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#35 — CardApp setOrchestratorOverride saves the card preset switch', () => {
    test('button click switches loop preset to tide_log and the card file keeps it after restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await importCharacterFile(page, { filePath: pngPath, expectedName: NAME });
        await dismissAnyPopup(page);
        await closeRightNavDrawer(page);
        await selectCharacterByName(page, NAME);
        await dismissAnyPopup(page);

        const avatar = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters?.[ctx.characterId]?.avatar || '';
        });
        expect(avatar).toBeTruthy();
        expect((await readCardOrchestrator(page, avatar))?.activePresetIds?.loop).toBe('reef_watch');

        await page.locator('#card-app-container').waitFor({ state: 'visible', timeout: 30_000 });
        const button = page.locator('#tide-house-switch');
        await button.waitFor({ state: 'visible', timeout: 20_000 });
        await enableOrchestratorMode(page, 'loop', { closeAfter: false });
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(LOOP_PRESETS.reef_watch.system_prompt);
        await editOrchAgentField(page, 'loop_agent', 'Keep the unsent harbor observations in the margin.');
        const maxRounds = await getOrchRuntimeLimitInput(page, /Loop max rounds|Loop 最大轮数|Loop 最大輪數/i);
        await maxRounds.fill('11');
        await maxRounds.press('Tab');
        await expect.poll(async () => (await readCardOrchestrator(page, avatar))?.presetLibraries?.loop?.reef_watch?.max_rounds).toBe(11);
        // A real host refresh follows a mode change; the auto-save must not
        // make that refresh replace the unsaved character draft.
        await setOrchMode(page, 'spec');
        await setOrchMode(page, 'loop');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the unsent harbor observations in the margin.');
        await closeWorkbench(page);
        await button.click();

        const resultEl = page.locator('#tide-house-result');
        await expect(resultEl).not.toBeEmpty({ timeout: 15_000 });
        const result = JSON.parse(await resultEl.textContent());
        expect(result.error).toBe('');
        expect(result.before).toEqual({ mode: 'loop', enabled: true });
        expect(result.ok).toBe(true);
        expect(result.after).toEqual({ mode: 'loop', enabled: true });

        await expect.poll(async () => (await readCardOrchestrator(page, avatar))?.activePresetIds?.loop, { timeout: 15_000 })
            .toBe('tide_log');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(LOOP_PRESETS.tide_log.system_prompt);
        await expect.poll(async () => (await readCardOrchestrator(page, avatar))?.presetLibraries?.loop?.tide_log?.system_prompt)
            .toBe(LOOP_PRESETS.tide_log.system_prompt);
        await closeWorkbench(page);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        const afterRestart = await readCardOrchestrator(page, avatar);
        expect(afterRestart.activePresetIds.loop).toBe('tide_log');
        expect(Object.keys(afterRestart.presetLibraries.loop).sort()).toEqual(['reef_watch', 'tide_log']);
        await selectCharacterByName(page, NAME);
        await enableOrchestratorMode(page, 'loop', { closeAfter: false });
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(LOOP_PRESETS.tide_log.system_prompt);
        await closeWorkbench(page);
        await page.locator('#tide-house-clear').click();
        await expect(page.locator('#tide-house-result')).toContainText('"cleared":true');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).not.toBe(LOOP_PRESETS.tide_log.system_prompt);
        await expect.poll(async () => (await readCardOrchestrator(page, avatar))?.activePresetIds?.loop || '').toBe('');
    });
});
