import { test, expect } from '../../harness/playwright.js';
import { readFileSync, renameSync } from 'node:fs';
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
import { closeWorkbench, setOrchMode } from '../_lib/ui-workbench.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

const AVATAR = 'failed-watch.png';
const OTHER = 'waiting-watch.png';
const NAME = 'Keeper of the Reef Watch';
const OTHER_NAME = 'Keeper of the Tide Watch';
let server;

function readCard(avatar) {
    return JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', avatar)))).data.extensions.orchestrator;
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'orchestrator', scenarioId: '87-character-save-failures' });
    markOnboarded({ dataRoot: server.dataRoot });
    for (const [avatar, name] of [[AVATAR, NAME], [OTHER, OTHER_NAME]]) {
        writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: avatar, overrides: {
            name, extensions: { orchestrator: {
                override: { mode: 'loop' },
                presetLibraries: { spec: {}, agenda: {}, director: {}, loop: {
                    watch: { name: 'Watch', system_prompt: `Keep the watch for ${name}.`, max_rounds: 4, customTools: [], seededDefaultCustomTools: true },
                } }, activePresetIds: { spec: '', agenda: '', director: '', loop: 'watch' },
            } },
        } });
    }
});

async function prepare(page, kind, toolName) {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, OTHER_NAME);
    await expect.poll(async () => (await liveCard(page, OTHER)).json?.activePresetIds?.loop).toBe('watch');
    await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_NAME);
    await selectCharacterByName(page, NAME);
    await expect.poll(() => selectedAvatar(page)).toBe(AVATAR);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await enableOrchestratorMode(page, 'loop', { closeAfter: false });
    await setOrchMode(page, 'spec');
    await setOrchMode(page, 'loop');
    await editOrchAgentField(page, 'loop_agent', 'Keep the unsent reef observations.');
    if (kind === 'limits') {
        const field = await getOrchRuntimeLimitInput(page, /Loop max rounds|Loop 最大轮数|Loop 最大輪數/i);
        return async () => {
            await field.fill(String(Number(await field.inputValue()) + 1));
            await field.press('Tab');
        };
    }
    const popup = await openOrchAddCustomToolPopup(page);
    await popup.locator('[data-orch-ct-name]').fill(toolName);
    await popup.locator('[data-orch-ct-description]').fill('Read the watch ledger.');
    return async () => {
        await popup.locator('.popup-button-ok').click();
        await popup.waitFor({ state: 'detached' });
    };
}

async function selectedAvatar(page) {
    return page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return ctx.characters[ctx.characterId]?.avatar;
    });
}

async function liveCard(page, avatar) {
    return page.evaluate(target => {
        const ctx = window.Luker.getContext();
        const card = ctx.characters.find(c => c.avatar === target);
        return { ext: card?.data?.extensions?.orchestrator, json: card?.json_data ? JSON.parse(card.json_data).data.extensions.orchestrator : null };
    }, avatar);
}

async function hostRefreshAndPrompt(page, expected) {
    await setOrchMode(page, 'spec');
    await setOrchMode(page, 'loop');
    await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(expected);
}

for (const kind of ['limits', 'tools']) {
    for (const failure of ['http', 'network']) {
        test(`${kind} ${failure} failure preserves unsaved content and the live and stored source`, async ({ page, context }) => {
            const trigger = await prepare(page, kind, `read_${kind}_${failure}`);
            const before = readCard(AVATAR);
            const liveBefore = await liveCard(page, AVATAR);
            const path = resolve(server.dataRoot, 'default-user', 'characters', AVATAR);
            const held = `${path}.held`;
            if (failure === 'http') renameSync(path, held);
            else await context.setOffline(true);
            try {
                const settled = failure === 'http'
                    ? page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'))
                    : page.waitForEvent('requestfailed', { predicate: r => r.url().endsWith('/api/characters/merge-attributes') });
                await trigger();
                const outcome = await settled;
                if (failure === 'http') expect(outcome.status()).toBe(500);
                await expect.poll(() => liveCard(page, AVATAR)).toEqual(liveBefore);
            } finally {
                if (failure === 'http') renameSync(held, path);
                else await context.setOffline(false);
            }
            expect(readCard(AVATAR)).toEqual(before);
            await hostRefreshAndPrompt(page, 'Keep the unsent reef observations.');
        });
    }

    for (const outcome of ['success', 'failure']) {
        test(`${kind} delayed ${outcome} for a previous avatar cannot acknowledge or replace the selected draft`, async ({ page, context }) => {
            const trigger = await prepare(page, kind, `read_${kind}_${outcome}`);
            const path = resolve(server.dataRoot, 'default-user', 'characters', AVATAR);
            const held = `${path}.held`;
            const before = readCard(AVATAR);
            const otherBefore = readCard(OTHER);
            if (outcome === 'failure') renameSync(path, held);
            const cdp = await context.newCDPSession(page);
            await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*merge-attributes*', requestStage: 'Response' }] });
            try {
                const sent = page.waitForRequest(r => r.url().endsWith('/api/characters/merge-attributes'));
                const paused = new Promise(resolve => cdp.once('Fetch.requestPaused', resolve));
                let settled = false;
                const response = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes')).then(result => { settled = true; return result; });
                await trigger();
                await sent;
                await closeWorkbench(page);
                await selectCharacterByName(page, OTHER_NAME);
                await expect.poll(() => selectedAvatar(page)).toBe(OTHER);
                await expect.poll(async () => (await liveCard(page, OTHER)).ext?.activePresetIds?.loop).toBe('watch');
                await enableOrchestratorMode(page, 'loop', { closeAfter: false });
                await setOrchMode(page, 'spec');
                await setOrchMode(page, 'loop');
                await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(`Keep the watch for ${OTHER_NAME}.`);
                await editOrchAgentField(page, 'loop_agent', 'Keep the unsent tide observations.');
                expect(settled, 'the original avatar write is still pending after the new draft is edited').toBe(false);
                const heldResponse = await paused;
                await cdp.send('Fetch.continueResponse', { requestId: heldResponse.requestId });
                expect((await response).status()).toBe(outcome === 'success' ? 200 : 500);
                await hostRefreshAndPrompt(page, 'Keep the unsent tide observations.');
                expect(readCard(OTHER)).toEqual(otherBefore);
            } finally {
                await cdp.send('Fetch.disable').catch(() => {});
                await cdp.detach();
                if (outcome === 'failure') renameSync(held, path);
            }
            if (outcome === 'failure') expect(readCard(AVATAR)).toEqual(before);
            else if (kind === 'limits') expect(readCard(AVATAR).presetLibraries.loop.watch.max_rounds).toBe(before.presetLibraries.loop.watch.max_rounds + 1);
            else expect(readCard(AVATAR).presetLibraries.loop.watch.customTools.map(t => t.name)).toContain(`read_${kind}_${outcome}`);
        });
    }

    test(`${kind} successful auto-save preserves the unsaved draft at host refresh`, async ({ page }) => {
        const trigger = await prepare(page, kind, `read_${kind}_preserved`);
        const before = readCard(AVATAR);
        const response = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
        await trigger();
        expect((await response).ok()).toBe(true);
        await expect.poll(() => readCard(AVATAR).presetLibraries.loop.watch.system_prompt).toBe(before.presetLibraries.loop.watch.system_prompt);
        await hostRefreshAndPrompt(page, 'Keep the unsent reef observations.');
        if (kind === 'limits') expect(readCard(AVATAR).presetLibraries.loop.watch.max_rounds).toBe(before.presetLibraries.loop.watch.max_rounds + 1);
        else expect(readCard(AVATAR).presetLibraries.loop.watch.customTools.map(t => t.name)).toContain(`read_${kind}_preserved`);
    });
}
