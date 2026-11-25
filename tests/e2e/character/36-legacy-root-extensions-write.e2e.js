// #36 — A card file placed straight into the characters folder with both a
// root-level `extensions` copy and `data.extensions` keeps the first
// extension write made through the server.
//
// REAL USER FLOW: drop a PNG whose root `extensions` and `data.extensions`
// both carry a loop-mode orchestrator preset library (reef_watch active) and
// a CardApp, plus the CardApp entry file in the user's card-apps folder, the
// way a copied data folder arrives. Select the card, click the CardApp button that calls
// ctx.setOrchestratorOverride({ presetId: 'tide_log' }), restart the server,
// then read the PNG from disk: `data.extensions` carries tide_log and the
// root copy is gone. A second card of the same shape clears the orchestrator
// data through ctx.clearOrchestratorOverride() as its first write; the disk
// shows the orchestrator key removed rather than restored from the root copy.

import { test, expect } from '../../harness/playwright.js';
import { resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, appendConnectionProfile } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { dismissAnyPopup } from './_helpers.js';
import { writeCharacterPng } from '../groups/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

const NAME = 'Maren of the Tide House';
const AVATAR = 'maren-tide-house.png';
const CLEAR_NAME = 'Oskar of the Lower Lock';
const CLEAR_AVATAR = 'oskar-lower-lock.png';

// Plain strings (no template literal) so the module's own syntax does not
// collide with this file's.
const cardAppEntry = (label, call) => [
    'export function init(ctx) {',
    '    const btn = document.createElement("button");',
    '    btn.id = "tide-house-switch";',
    '    btn.textContent = ' + JSON.stringify(label) + ';',
    '    const out = document.createElement("pre");',
    '    out.id = "tide-house-result";',
    '    btn.addEventListener("click", async () => {',
    '        let ok = null;',
    '        let error = "";',
    '        try {',
    '            ok = await ' + call + ';',
    '        } catch (err) {',
    '            error = String(err && err.message || err);',
    '        }',
    '        out.textContent = JSON.stringify({ ok, error });',
    '    });',
    '    ctx.container.appendChild(btn);',
    '    ctx.container.appendChild(out);',
    '}',
    '',
].join('\n');

const LOOP_PRESETS = {
    reef_watch: { name: 'Reef watch', system_prompt: 'Narrate the night reef from the tide-house window.', tools: {}, max_rounds: 6, wall_clock_budget_ms: 60000 },
    tide_log: { name: 'Tide log', system_prompt: 'Keep the tide log in Maren\'s clipped hand, one line per bell.', tools: {}, max_rounds: 6, wall_clock_budget_ms: 60000 },
};

let server, mock;

function readCardFromDisk(avatar = AVATAR) {
    const pngPath = resolve(server.dataRoot, 'default-user', 'characters', avatar);
    return JSON.parse(readPngCard(readFileSync(pngPath)));
}

function seedCard({ name, avatar, description, personality, scenario, firstMes, entry }) {
    writeCharacterPng({
        dataRoot: server.dataRoot,
        avatarFile: avatar,
        card: {
            name,
            description,
            personality,
            scenario,
            first_mes: firstMes,
            system_prompt: `You are ${name}. Stay in scene.`,
            tags: ['rp', 'fixture'],
            extensions: {
                card_app: { enabled: true, entry: 'index.js' },
                orchestrator: {
                    override: { mode: 'loop' },
                    presetLibraries: { spec: {}, agenda: {}, director: {}, loop: LOOP_PRESETS },
                    activePresetIds: { spec: '', agenda: '', loop: 'reef_watch', director: '' },
                },
            },
        },
    });
    const appDir = resolve(server.dataRoot, 'default-user', 'card-apps', avatar.replace('.png', ''));
    mkdirSync(appDir, { recursive: true });
    writeFileSync(resolve(appDir, 'index.js'), entry);
}

async function clickCardAppButton(page, name) {
    await selectCharacterByName(page, name);
    await dismissAnyPopup(page);
    await page.locator('#card-app-container').waitFor({ state: 'visible', timeout: 30_000 });
    const button = page.locator('#tide-house-switch');
    await button.waitFor({ state: 'visible', timeout: 20_000 });
    await button.click();
    const resultEl = page.locator('#tide-house-result');
    await expect(resultEl).not.toBeEmpty({ timeout: 15_000 });
    expect(JSON.parse(await resultEl.textContent())).toEqual({ ok: true, error: '' });
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'character',
        scenarioId: '36-legacy-root-extensions-write',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    seedCard({
        name: NAME,
        avatar: AVATAR,
        description: 'Keeper of the tide house on the western channel. Reads the water by glass and by bell.',
        personality: 'Exacting, patient, wry about anyone who trusts a chart over the water.',
        scenario: 'You share the tide house with Maren through the long night watch.',
        firstMes: '*Maren turns the tide-glass and marks the bell in the log.* "Slack water in a quarter hour. Sit where you can see the channel."',
        entry: cardAppEntry('Open the tide log', 'ctx.setOrchestratorOverride({ presetId: "tide_log" })'),
    });
    seedCard({
        name: CLEAR_NAME,
        avatar: CLEAR_AVATAR,
        description: 'Lock-keeper at the lower gate of the western channel. Works the sluices by hand and by habit.',
        personality: 'Taciturn, careful with the gates, generous with tea.',
        scenario: 'You wait out the flood tide with Oskar in the lock-keeper\'s hut.',
        firstMes: '*Oskar sets the kettle on and checks the gate chain.* "The water decides tonight. We just keep the log."',
        entry: cardAppEntry('Let the water decide', 'ctx.clearOrchestratorOverride()'),
    });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#36 — first extension write on a card with a legacy root extensions copy', () => {
    test('CardApp preset switch survives on disk across a restart', async ({ page }) => {
        const seeded = readCardFromDisk();
        expect(seeded.extensions?.orchestrator?.activePresetIds?.loop).toBe('reef_watch');
        expect(seeded.data.extensions.orchestrator.activePresetIds.loop).toBe('reef_watch');

        await awaitMainUI(page, server.baseURL);
        await clickCardAppButton(page, NAME);

        await expect.poll(() => readCardFromDisk().data?.extensions?.orchestrator?.activePresetIds?.loop, { timeout: 15_000 })
            .toBe('tide_log');

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        const onDisk = readCardFromDisk();
        expect(onDisk.data.extensions.orchestrator.activePresetIds.loop).toBe('tide_log');
        expect(Object.keys(onDisk.data.extensions.orchestrator.presetLibraries.loop).sort()).toEqual(['reef_watch', 'tide_log']);
        expect(onDisk.extensions).toBeUndefined();
    });

    test('CardApp orchestrator clear stays removed on disk across a restart', async ({ page }) => {
        const seeded = readCardFromDisk(CLEAR_AVATAR);
        expect(seeded.extensions?.orchestrator).toBeDefined();
        expect(seeded.data.extensions.orchestrator).toBeDefined();

        await awaitMainUI(page, server.baseURL);
        await clickCardAppButton(page, CLEAR_NAME);

        await expect.poll(() => readCardFromDisk(CLEAR_AVATAR).extensions, { timeout: 15_000 }).toBeUndefined();

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        const onDisk = readCardFromDisk(CLEAR_AVATAR);
        expect(onDisk.data.extensions).not.toHaveProperty('orchestrator');
        expect(onDisk.data.extensions.card_app).toEqual({ enabled: true, entry: 'index.js' });
        expect(onDisk.extensions).toBeUndefined();
    });
});
