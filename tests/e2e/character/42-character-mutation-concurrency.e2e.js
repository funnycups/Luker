import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { editOrchAgentField, enableOrchestratorMode, readOrchAgentField } from '../_lib/ui-orchestrator.js';
import { closeWorkbench, setOrchMode } from '../_lib/ui-workbench.js';
import { writeEmbeddedCharacter } from './_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

const AVATAR = 'mutation-watch.png';
const NAME = 'Keeper of the Changing Watch';
const ADVANCED = {
    updateEvery: 2, persistentInjectionMaxSeqDistance: 5, llmVisibleRecentMessages: 7,
    recallMaxIterations: 4, toolCallRetryMax: 2, extractExcludeRecentTurns: 2,
    extractContextTurns: 8, recallQueryMessages: 3, extractBatchTurns: 2, rpmLimit: 0,
    extractMode: 'oneshot', extractConcurrent: false, extractTemplate: '', extractEdgeRules: '',
    extractCrawlMaxRounds: 2, extractCrawlCandidateLimit: 20, extractCrawlMaxReads: 5,
    extractCrawlSystemPrompt: 'Read the ledger.', configIterSystemPrompt: 'Describe the schema.',
    graphIterSystemPrompt: 'Describe the graph.', recallRouteSystemPrompt: 'Find the watch.', recallFinalizeSystemPrompt: 'Return the watch.',
    ragRewriteSystemPrompt: 'Find related entries.', extractIncludeWorldInfo: true, recallIncludeWorldInfo: true,
    promptDefaultsInitialized: true,
};
const CROSS_ADVANCED = { ...ADVANCED, extractContextTurns: 11 };
const EXT = {
    override: { mode: 'loop' },
    presetLibraries: { spec: {}, agenda: {}, director: {}, loop: {
        a: { name: 'Reef', system_prompt: 'Keep the reef watch.', max_rounds: 4, customTools: [], seededDefaultCustomTools: true },
        b: { name: 'Tide', system_prompt: 'Keep the tide watch.', max_rounds: 6, customTools: [], seededDefaultCustomTools: true },
    } }, activePresetIds: { spec: '', agenda: '', director: '', loop: 'a' },
};
const ENTRY = `export async function init(ctx) {
    const live = ctx.lukerContext;
    const persist = await import('/scripts/extensions/orchestrator/editor-persist.js');
    const result = document.createElement('pre'); result.id = 'mutation-result';
    const history = document.createElement('pre'); history.id = 'mutation-history'; const outcomes = [];
    const saveResult = value => { outcomes.push(value); history.textContent = JSON.stringify(outcomes); result.textContent = JSON.stringify(value); };
    for (const kind of ['switch', 'presets', 'memory', 'cross', 'limits', 'tools']) {
        const button = document.createElement('button'); button.id = 'mutate-' + kind; button.textContent = 'Change ' + kind;
        button.addEventListener('click', async () => {
            const avatar = live.characters[live.characterId].avatar;
            try {
                if (kind === 'switch') saveResult(await live.getExtensionApi('orchestrator').setCharacterActivePresetForSavedMode(live, live.extensionSettings.orchestrator, avatar, document.querySelector('#mutation-preset').value));
                if (kind === 'presets') {
                    const card = live.characters[live.characterId];
                    await Promise.all([live.character.presets.add(card, 'Reef', { temperature: 0.3 }), live.character.presets.add(card, 'Tide', { temperature: 0.7 })]);
                    result.textContent = JSON.stringify({ ok: true });
                }
                if (kind === 'memory') {
                    const api = live.getExtensionApi('memory-graph');
                    const schema = api.getSchemaScopeInfo(live).schema;
                    result.textContent = JSON.stringify(await Promise.all([api.persistCharacterSchemaOverride(live, avatar, schema), api.persistCharacterAdvancedOverride(live, avatar, ${JSON.stringify(ADVANCED)})]));
                }
                if (kind === 'cross') {
                    const api = live.getExtensionApi('memory-graph');
                    result.textContent = JSON.stringify(await Promise.all([
                        api.persistCharacterAdvancedOverride(live, avatar, ${JSON.stringify(CROSS_ADVANCED)}),
                        live.writeExtensionField(live.characterId, 'luker', previous => ({ ...previous, retained: 'Dawn watch' })),
                    ]));
                }
                if (kind === 'limits') result.textContent = JSON.stringify({ ok: await persist.persistRuntimeLimitsKeepingDrafts(live, live.extensionSettings.orchestrator, 'loop', 'character', { max_rounds: Number(document.querySelector('#mutation-rounds').value) }, { avatar }) });
                if (kind === 'tools') result.textContent = JSON.stringify({ ok: await persist.persistCustomToolsKeepingDrafts(live, live.extensionSettings.orchestrator, 'loop', 'character', [], { avatar }) });
            } catch (error) { result.textContent = JSON.stringify({ error: error.message }); }
        });
        ctx.container.append(button);
    }
    const rounds = document.createElement('input'); rounds.id = 'mutation-rounds'; rounds.value = '9'; ctx.container.append(rounds);
    const preset = document.createElement('select'); preset.id = 'mutation-preset'; preset.add(new Option('Reef', 'a')); preset.add(new Option('Tide', 'b')); preset.value = 'b';
    ctx.container.append(result, history, preset);
}`;
let server;
const cardPath = () => resolve(server.dataRoot, 'default-user', 'characters', AVATAR);
const disk = () => JSON.parse(readPngCard(readFileSync(cardPath()))).data.extensions;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'character', scenarioId: '42-mutation-concurrency' });
    markOnboarded({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: AVATAR, overrides: {
        name: NAME, extensions: { orchestrator: EXT, luker: { retained: 'sibling' }, memory_graph: { retained: 'sibling' }, card_app: { enabled: true, entry: 'index.js', files: { 'index.js': ENTRY } } },
    } });
    const dir = resolve(server.dataRoot, 'default-user', 'card-apps', 'mutation-watch');
    mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, 'index.js'), ENTRY);
});



async function open(page) {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await enableOrchestratorMode(page, 'loop');
}
async function live(page) {
    return page.evaluate(() => {
        const ctx = window.Luker.getContext(); const card = ctx.characters[ctx.characterId];
        return { ext: card.data.extensions, json: JSON.parse(card.json_data).data.extensions, editor: JSON.parse(document.querySelector('#character_json_data').value).data.extensions };
    });
}

test('concurrent distinct preset additions compose the complete bound state', async ({ page }) => {
    await open(page);
    await page.locator('#mutate-presets').click();
    await expect(page.locator('#mutation-result')).toHaveText('{"ok":true}');
    const expected = { retained: 'sibling', chat_completion_preset: { presets: [{ name: 'Reef', preset: { temperature: 0.3 } }, { name: 'Tide', preset: { temperature: 0.7 } }], defaultPresetName: 'Reef' } };
    expect(disk().luker).toEqual(expected);
    const state = await live(page);
    expect(state.ext.luker).toEqual(expected); expect(state.json.luker).toEqual(expected); expect(state.editor.luker).toEqual(expected);
});

test('concurrent memory schema and advanced overrides preserve both siblings', async ({ page }) => {
    await open(page);
    const expectedSchema = await page.evaluate(() => {
        const ctx = window.Luker.getContext(); return ctx.getExtensionApi('memory-graph').getSchemaScopeInfo(ctx).schema;
    });
    await page.locator('#mutate-memory').click();
    await expect(page.locator('#mutation-result')).toHaveText('[true,true]');
    const state = disk().memory_graph;
    expect(state.retained).toBe('sibling');
    expect(Object.keys(state).sort()).toEqual(['advancedOverride', 'retained', 'schemaOverride']);
    expect(state.schemaOverride).toEqual(expectedSchema); expect(state.advancedOverride).toEqual(ADVANCED);
    const current = await live(page);
    expect(current.ext.memory_graph).toEqual(state); expect(current.json.memory_graph).toEqual(state); expect(current.editor.memory_graph).toEqual(state);
});

test('concurrent extension namespaces preserve their acknowledged values across restart', async ({ page }) => {
    await open(page);
    await expect.poll(async () => {
        const onDisk = disk();
        const slot = onDisk.luker?.chat_completion_preset?.presets?.[0]?.preset;
        if (slot && !Object.hasOwn(slot, 'prompts')) return false;
        const current = await live(page);
        return JSON.stringify(current.ext) === JSON.stringify(onDisk)
            && JSON.stringify(current.json) === JSON.stringify(onDisk)
            && JSON.stringify(current.editor) === JSON.stringify(onDisk);
    }, { timeout: 15_000 }).toBe(true);
    const before = disk();
    const expected = {
        ...before,
        memory_graph: { ...before.memory_graph, advancedOverride: CROSS_ADVANCED },
        luker: { ...before.luker, retained: 'Dawn watch' },
    };
    await page.locator('#mutate-cross').click();
    await expect(page.locator('#mutation-result')).toHaveText('[true,true]');
    expect(disk()).toEqual(expected);
    const current = await live(page);
    expect(current.ext).toEqual(expected);
    expect(current.json).toEqual(expected);
    expect(current.editor).toEqual(expected);

    await server.restart();
    await reloadAndAwait(page, server.baseURL);
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    expect(disk()).toEqual(expected);
    const restored = await live(page);
    expect(restored.ext).toEqual(expected);
    expect(restored.json).toEqual(expected);
    expect(restored.editor).toEqual(expected);
});

test('failed first identical selection cannot undo the pending successful selection', async ({ page, context }) => {
    await open(page);
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    const path = cardPath(); const held = path + '.held'; renameSync(path, held);
    let restored = false;
    let notifyFailure;
    const serverFailed = new Promise(resolve => { notifyFailure = resolve; });
    const mergeIds = new Set();
    const observeRequest = event => { if (event.request.url.endsWith('/api/characters/merge-attributes')) mergeIds.add(event.requestId); };
    const observeHeaders = event => { if (mergeIds.has(event.requestId) && event.statusCode === 500) notifyFailure(); };
    cdp.on('Network.requestWillBeSent', observeRequest);
    cdp.on('Network.responseReceivedExtraInfo', observeHeaders);
    try {
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
        const first = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
        await page.locator('#mutate-switch').click();
        // ExtraInfo observes actual server headers before transport latency
        // delivers the response to fetch. Restore the test-owned file only
        // after the first real request has failed on the server.
        await serverFailed;
        renameSync(held, path); restored = true;
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 3000, downloadThroughput: -1, uploadThroughput: -1 });
        await page.locator('#mutate-switch').click();
        expect((await first).status()).toBe(500);
        await expect(page.locator('#mutation-result')).toHaveText('{"ok":true,"mode":"loop"}');
        await expect(page.locator('#mutation-history')).toHaveText('[{"ok":false,"mode":"loop","reason":"persist_failed"},{"ok":true,"mode":"loop"}]');
        const expected = { ...EXT, activePresetIds: { ...EXT.activePresetIds, loop: 'b' } };
        expect(disk().orchestrator).toEqual(expected);
        const state = await live(page);
        expect(state.ext.orchestrator).toEqual(expected); expect(state.json.orchestrator).toEqual(expected); expect(state.editor.orchestrator).toEqual(expected);
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(EXT.presetLibraries.loop.b.system_prompt);
        await closeWorkbench(page);
    } finally {
        if (!restored) renameSync(held, path);
        cdp.off('Network.responseReceivedExtraInfo', observeHeaders);
        cdp.off('Network.requestWillBeSent', observeRequest);
        await cdp.detach();
    }
});

test('alternating A to B to A to B requests retain the latest owned selection', async ({ page }) => {
    await open(page);
    await page.locator('#mutation-preset').selectOption('b'); await page.locator('#mutate-switch').click();
    await page.locator('#mutation-preset').selectOption('a'); await page.locator('#mutate-switch').click();
    await page.locator('#mutation-preset').selectOption('b'); await page.locator('#mutate-switch').click();
    await expect.poll(async () => JSON.parse(await page.locator('#mutation-history').textContent() || '[]').length).toBe(3);
    const expected = { ...EXT, activePresetIds: { ...EXT.activePresetIds, loop: 'b' } };
    expect(disk().orchestrator).toEqual(expected);
    const state = await live(page);
    expect(state.ext.orchestrator).toEqual(expected); expect(state.json.orchestrator).toEqual(expected); expect(state.editor.orchestrator).toEqual(expected);
});

for (const second of ['limits', 'tools']) {
    for (const order of ['first-first', 'second-first']) {
        test(`failed limits and ${second} restore acknowledged source in ${order} settlement order`, async ({ page, context }) => {
            await open(page);
            await editOrchAgentField(page, 'loop_agent', 'Keep the unsent reef observations.', /Role prompt|角色提示/i, { closeAfter: true });
            const before = await live(page);
            const bytes = readFileSync(cardPath()); const held = cardPath() + '.held'; renameSync(cardPath(), held);
            const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
            try {
                const responses = [];
                const observe = r => { if (r.url().endsWith('/api/characters/merge-attributes')) responses.push(r); };
                page.on('response', observe);
                await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: order === 'first-first' ? 1500 : 3000, downloadThroughput: -1, uploadThroughput: -1 });
                const firstSent = page.waitForRequest(r => r.url().endsWith('/api/characters/merge-attributes'));
                await page.locator('#mutate-limits').click(); await firstSent;
                await page.locator('#mutation-rounds').fill('10');
                await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: order === 'first-first' ? 3000 : 1000, downloadThroughput: -1, uploadThroughput: -1 });
                const secondSent = page.waitForRequest(r => r.url().endsWith('/api/characters/merge-attributes'));
                await page.locator('#mutate-' + second).click(); await secondSent;
                await expect.poll(() => responses.length).toBe(2);
                expect(responses.map(r => r.status())).toEqual([500, 500]);
                await expect.poll(() => live(page)).toEqual(before);
                expect(readFileSync(held)).toEqual(bytes);
                page.off('response', observe);
            } finally { renameSync(held, cardPath()); await cdp.detach(); }
            await setOrchMode(page, 'spec');
            await setOrchMode(page, 'loop');
            await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the unsent reef observations.');
            await closeWorkbench(page);
        });
    }
}
