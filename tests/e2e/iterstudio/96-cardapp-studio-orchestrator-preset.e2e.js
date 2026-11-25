// #96 — CardApp Studio AI `character_update_orchestrator` switches the card
// preset and saves the card file.
//
// REAL USER-GESTURE flow:
//   1. Seed a card whose orchestrator loop library holds reef_watch (active)
//      and tide_log.
//   2. Select the card, open Extensions → Character Editor Assistant →
//      "CardApp Studio", type a request and click Send.
//   3. The mock LLM answers round 1 with
//      character_update_orchestrator({ presetId: 'tide_log' }) and round 2
//      with plain text.
//   4. The tool result the model receives reports success; the card file on
//      disk carries activePresetIds.loop = 'tide_log' across a restart.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName, openExtensionsDrawer, openInlineDrawer, closeExtensionsDrawer } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeCharacterPng } from '../groups/_helpers.js';

const NAME = 'Maren of the Tide House';
const AVATAR = 'maren-tide-house.png';
const CONFIRM = 'The tide log is now the active loop preset for Maren; the reef watch preset stays in the card library.';

let server, mock;

async function readCardOrchestrator(page) {
    return await page.evaluate(async (avatarUrl) => {
        const ctx = window.Luker.getContext();
        const resp = await fetch('/api/characters/get', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatarUrl }),
        });
        const data = await resp.json();
        return data?.data?.extensions?.orchestrator || null;
    }, AVATAR);
}

function chatRequests() {
    return mock.requests.filter(r => String(r.url || '').includes('/chat/completions'));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '96-cardapp-studio-orchestrator-preset',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    writeCharacterPng({ dataRoot: server.dataRoot, avatarFile: AVATAR, card: {
        name: NAME,
        description: 'Keeper of the tide house on the western channel. Reads the water by glass and by bell.',
        personality: 'Exacting, patient, wry about anyone who trusts a chart over the water.',
        scenario: 'You share the tide house with Maren through the long night watch.',
        first_mes: '*Maren turns the tide-glass and marks the bell in the log.* "Slack water in a quarter hour. Sit where you can see the channel."',
        creator_notes: '',
        system_prompt: 'You are Maren. Stay in scene.',
        tags: ['rp', 'fixture'],
        extensions: {
            orchestrator: {
                override: { mode: 'loop' },
                presetLibraries: {
                    spec: {}, agenda: {}, director: {},
                    loop: {
                        reef_watch: { name: 'Reef watch', system_prompt: 'Narrate the night reef from the tide-house window.', tools: {}, max_rounds: 6, wall_clock_budget_ms: 60000 },
                        tide_log: { name: 'Tide log', system_prompt: 'Keep the tide log in Maren\'s clipped hand, one line per bell.', tools: {}, max_rounds: 6, wall_clock_budget_ms: 60000 },
                    },
                },
                activePresetIds: { spec: '', agenda: '', loop: 'reef_watch', director: '' },
            },
        },
    } });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#96 — CardApp Studio character_update_orchestrator saves the card preset switch', () => {
    test('file paths containing quotes remain selectable attributes', async ({ page }) => {
        const path = 'notes/harbor"watch.md';
        const content = 'The tide house keeps its lantern records here.';
        mock.scriptCompletion(({ turn }) => turn === 0
            ? { tool: 'cardapp_write_file', arguments: { path, content } }
            : { text: 'The lantern records are in the harbor watch file.' });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, NAME);
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'character_editor_assistant_settings');
        await page.locator('#cea_open_cardapp_studio').click();
        await closeExtensionsDrawer(page);
        await page.locator('.card-app-studio-auto-apply').click();
        await expect(page.locator('[data-studio-toggle="auto-apply"]')).toBeChecked();
        await page.locator('[data-studio-input]').fill('Add a file for the tide house lantern records.');
        await page.locator('[data-studio-action="send"]').click();
        await expect(page.locator('[data-studio-chat]')).toContainText('The lantern records are in the harbor watch file.', { timeout: 30_000 });
        const row = page.locator('[data-studio-file]').filter({ hasText: 'harbor"watch.md' }).first();
        await expect(row).toHaveAttribute('data-studio-file', path, { timeout: 30_000 });
        await row.click();
        await expect(page.locator('[data-studio-tabs]')).toContainText('harbor"watch.md');
        await page.locator('[data-studio-action="close"]').first().click();
        mock.clearScriptedCompletion();
    });
    test('Studio AI tool call switches loop preset to tide_log on disk', async ({ page }) => {
        mock.scriptCompletion(({ turn }) => (turn === 0
            ? { tool: 'character_update_orchestrator', arguments: { presetId: 'tide_log' } }
            : { text: CONFIRM }));

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, NAME);
        expect((await readCardOrchestrator(page))?.activePresetIds?.loop).toBe('reef_watch');

        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'character_editor_assistant_settings');
        await page.locator('#cea_open_cardapp_studio').click();
        const input = page.locator('[data-studio-input]');
        await input.waitFor({ state: 'visible', timeout: 20_000 });
        await closeExtensionsDrawer(page);

        await input.fill('Switch Maren to the tide log preset for her loop orchestration.');
        await page.locator('[data-studio-action="send"]').click();

        await expect(page.locator('[data-studio-chat]')).toContainText(CONFIRM, { timeout: 30_000 });

        const second = chatRequests()[1];
        expect(second, 'round 2 request reached the mock').toBeTruthy();
        const toolMessage = (second.body.messages || []).find(m => m.role === 'tool');
        expect(toolMessage, 'round 2 carries the tool result').toBeTruthy();
        const toolResult = JSON.parse(String(toolMessage.content));
        expect(toolResult).toMatchObject({ ok: true, mode: 'loop', presetId: 'tide_log' });

        await expect.poll(async () => (await readCardOrchestrator(page))?.activePresetIds?.loop, { timeout: 15_000 })
            .toBe('tide_log');

        await page.locator('[data-studio-action="close"]').first().click();
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        const afterRestart = await readCardOrchestrator(page);
        expect(afterRestart.activePresetIds.loop).toBe('tide_log');
        expect(Object.keys(afterRestart.presetLibraries.loop).sort()).toEqual(['reef_watch', 'tide_log']);
    });
});
