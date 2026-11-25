import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import {
    editOrchAgentField,
    enableOrchestratorMode,
    getOrchRuntimeLimitInput,
    openOrchAddCustomToolPopup,
    readOrchAgentField,
} from '../_lib/ui-orchestrator.js';
import { closeWorkbench } from '../_lib/ui-workbench.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

const AVATAR = 'source-race.png';
const NAME = 'Keeper of the Channel';
const ENTRY = `export function init(ctx) {
    const button = document.createElement('button'); button.id = 'change-watch'; button.textContent = 'Open the tide log';
    const out = document.createElement('pre'); out.id = 'change-result';
    const reset = document.createElement('button'); reset.id = 'reef-watch'; reset.textContent = 'Return to the reef watch';
    reset.addEventListener('click', async () => { out.textContent = JSON.stringify(await ctx.setOrchestratorOverride({ presetId: 'reef' })); });
    button.addEventListener('click', async () => { out.textContent = JSON.stringify(await ctx.setOrchestratorOverride({ presetId: 'tide' })); });
    ctx.container.append(button, reset, out);
}`;
let server;
function readCard() {
    return JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', AVATAR)))).data.extensions.orchestrator;
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'orchestrator', scenarioId: '86-source-race' });
    markOnboarded({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: AVATAR, overrides: {
        name: NAME, extensions: {
            card_app: { enabled: true, entry: 'index.js', files: { 'index.js': ENTRY } },
            orchestrator: {
                override: { mode: 'loop' },
                presetLibraries: { spec: {}, agenda: {}, director: {}, loop: {
                    reef: { name: 'Reef', system_prompt: 'Keep the reef watch.', max_rounds: 4, customTools: [], seededDefaultCustomTools: true },
                    tide: { name: 'Tide', system_prompt: 'Keep the tide log.', max_rounds: 6, customTools: [], seededDefaultCustomTools: true },
                } }, activePresetIds: { spec: '', agenda: '', director: '', loop: 'reef' },
            },
        },
    } });
    const dir = resolve(server.dataRoot, 'default-user', 'card-apps', 'source-race');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'index.js'), ENTRY);
});

for (const kind of ['limits', 'tools']) {
    test(`${kind} completion must not acknowledge a concurrent preset source on the same draft`, async ({ page, context }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, NAME);
        await enableOrchestratorMode(page, 'loop');
        await page.locator('#reef-watch').click();
        await expect(page.locator('#change-result')).toHaveText('true');
        await editOrchAgentField(page, 'loop_agent', 'Keep these unsent reef observations.');
        let maxRoundsInput = null;
        if (kind === 'tools') {
            const popup = await openOrchAddCustomToolPopup(page);
            await popup.locator('[data-orch-ct-name]').fill('read_tide');
            await popup.locator('[data-orch-ct-description]').fill('Read the tide ledger.');
        } else {
            maxRoundsInput = await getOrchRuntimeLimitInput(page, /Loop max rounds|Loop 最大轮数|Loop 最大輪數/i);
        }
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 3000, downloadThroughput: -1, uploadThroughput: -1 });
        try {
            const firstRequest = page.waitForRequest(r => r.url().endsWith('/api/characters/merge-attributes'));
            if (kind === 'limits') {
                await maxRoundsInput.fill('9');
                await maxRoundsInput.press('Tab');
            } else {
                await page.locator('.popup:visible:has(.luker_orch_ct_editor) .popup-button-ok').click();
            }
            await firstRequest;
            const secondRequest = page.waitForRequest(r => r.url().endsWith('/api/characters/merge-attributes') && r.postDataJSON()?.data?.extensions?.orchestrator?.activePresetIds?.loop === 'tide');
            await closeWorkbench(page);
            const switched = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.request().postDataJSON()?.data?.extensions?.orchestrator?.activePresetIds?.loop === 'tide');
            await page.locator('#change-watch').click();
            await secondRequest;
            await switched;
            await expect(page.locator('#change-result')).toHaveText('true', { timeout: 15000 });
            await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the tide log.');
            expect(readCard().activePresetIds.loop).toBe('tide');
            expect(readCard().presetLibraries.loop.tide.system_prompt).toBe('Keep the tide log.');
            expect(readCard().presetLibraries.loop.reef.system_prompt).toBe('Keep the reef watch.');
        } finally {
            await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
            await cdp.detach();
        }
    });
}
