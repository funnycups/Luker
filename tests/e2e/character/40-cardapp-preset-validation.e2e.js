import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { editOrchAgentField, enableOrchestratorMode, readOrchAgentField } from '../_lib/ui-orchestrator.js';
import { closeWorkbench, setOrchMode } from '../_lib/ui-workbench.js';
import { writeEmbeddedCharacter } from './_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

const NAME = 'Maren of the Tide House';
const AVATAR = 'preset-validation.png';
const OTHER = 'other-watch.png';
const EMPTY = 'no-watch.png';
const libraries = () => ({
    override: { mode: 'loop' },
    presetLibraries: { spec: {}, agenda: {}, director: {}, loop: {
        reef_watch: { name: 'Reef watch', system_prompt: 'Keep the reef watch.', tools: {} },
        tide_log: { name: 'Tide log', system_prompt: 'Keep the tide log.', tools: {} },
    } },
    activePresetIds: { spec: '', agenda: '', director: '', loop: 'reef_watch' },
});

// A real CardApp consumer of the registered extension API. The DOM controls
// choose the target avatar and preset; the browser test never invokes it via evaluate.
const ENTRY = `export function init(ctx) {
    const target = document.createElement('select'); target.id = 'watch-target';
    for (const name of ${JSON.stringify([AVATAR, OTHER, EMPTY, 'missing.png', '../invalid.png'])}) target.add(new Option(name, name));
    const preset = document.createElement('select'); preset.id = 'watch-preset';
    for (const name of ['tide_log', 'reef_watch', '', 'storm_drill', 'constructor']) preset.add(new Option(name || 'Common watch', name));
    const button = document.createElement('button'); button.id = 'watch-apply'; button.textContent = 'Change the watch';
    const out = document.createElement('pre'); out.id = 'watch-result';
    button.addEventListener('click', async () => {
        const live = ctx.lukerContext;
        const result = await live.getExtensionApi('orchestrator').setCharacterActivePresetForSavedMode(
            live, live.extensionSettings.orchestrator, target.value, preset.value);
        out.textContent = JSON.stringify(result);
    });
    const clear = document.createElement('button'); clear.id = 'watch-clear'; clear.textContent = 'Return to the common watch';
    clear.addEventListener('click', async () => { out.textContent = JSON.stringify({ ok: await ctx.clearOrchestratorOverride() }); });
    const write = document.createElement('button'); write.id = 'watch-write'; write.textContent = 'Save the watch note';
    write.addEventListener('click', async () => {
        const live = ctx.lukerContext;
        const id = live.characters.findIndex(c => c.avatar === target.value);
        try { out.textContent = JSON.stringify({ ok: await live.writeExtensionField(id, 'watch_note', { bell: 'dusk' }) }); }
        catch (error) { out.textContent = JSON.stringify({ error: error.name }); }
    });
    const later = document.createElement('button'); later.id = 'watch-later'; later.textContent = 'Add the next bell';
    later.addEventListener('click', async () => {
        const live = ctx.lukerContext;
        const card = live.characters.find(c => c.avatar === target.value);
        const current = card.data.extensions.watch_note || {};
        out.textContent = JSON.stringify({ ok: await live.writeExtensionField(live.characters.indexOf(card), 'watch_note', { ...current, bell: 'midnight' }) });
    });
    const overlap = document.createElement('button'); overlap.id = 'watch-overlap'; overlap.textContent = 'Record the changing bells';
    overlap.addEventListener('click', async () => {
        const live = ctx.lukerContext;
        const id = live.characters.findIndex(c => c.avatar === target.value);
        const first = live.writeExtensionField(id, 'watch_overlap', { bell: 'dusk' });
        const second = live.writeExtensionField(id, 'watch_overlap', { bell: 'midnight' });
        out.textContent = JSON.stringify({ results: await Promise.all([first, second]) });
    });
    const read = document.createElement('button'); read.id = 'watch-read'; read.textContent = 'Read the watch state';
    read.addEventListener('click', () => {
        const live = ctx.lukerContext;
        const card = live.characters.find(c => c.avatar === target.value);
        out.textContent = JSON.stringify({ card, mode: live.extensionSettings.orchestrator.executionMode });
    });
    const margin = document.createElement('button'); margin.id = 'watch-margin'; margin.textContent = 'Keep the unsent margin note';
    margin.addEventListener('click', () => {
        const card = ctx.lukerContext.characters.find(c => c.avatar === target.value);
        card.data.extensions.watch_note = { bell: 'midnight', margin: 'unsent' };
    });
    const bulk = document.createElement('button'); bulk.id = 'watch-bulk'; bulk.textContent = 'Save the watch notes';
    bulk.addEventListener('click', async () => {
        try { out.textContent = JSON.stringify(await ctx.lukerContext.writeExtensionFieldBulk([target.value], 'watch_note', { bell: 'dusk' })); }
        catch (error) { out.textContent = JSON.stringify({ error: error.message }); }
    });
    const mg = document.createElement('button'); mg.id = 'watch-memory'; mg.textContent = 'Save the watch memory settings';
    mg.addEventListener('click', async () => {
        const live = ctx.lukerContext;
        try {
            const ok = await live.getExtensionApi('memory-graph').persistCharacterAdvancedOverride(live, target.value, {});
            out.textContent = JSON.stringify({ ok: Boolean(ok) });
        } catch (error) {
            out.textContent = JSON.stringify({ ok: false, error: error.message });
        }
    });
    const update = document.createElement('button'); update.id = 'watch-fields'; update.textContent = 'Save the watch field';
    update.addEventListener('click', async () => {
        try { await ctx.updateCharacterFields({ depth_prompt_prompt: 'Keep the dusk watch.' }); out.textContent = JSON.stringify({ ok: true }); }
        catch (error) { out.textContent = JSON.stringify({ ok: false, error: error.message }); }
    });
    const bind = document.createElement('button'); bind.id = 'watch-binding'; bind.textContent = 'Bind the watch preset';
    bind.addEventListener('click', async () => {
        const live = ctx.lukerContext;
        try { await live.character.presets.add(live.characters.find(c => c.avatar === target.value), 'Watch', { temperature: 0.4 }); out.textContent = JSON.stringify({ ok: true }); }
        catch (error) { out.textContent = JSON.stringify({ ok: false, error: error.message }); }
    });
    ctx.container.append(target, preset, button, clear, write, later, read, margin, overlap, bulk, mg, update, bind, out);
}`;

let server;
function readCard(avatar = AVATAR) {
    return JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', avatar)))).data.extensions.orchestrator;
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'character', scenarioId: '40-cardapp-preset-validation', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    for (const [avatar, name, orchestrator] of [[AVATAR, NAME, libraries()], [OTHER, 'Keeper of the Outer Watch', libraries()], [EMPTY, 'Keeper without a Watch', {}]]) {
        writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: avatar, overrides: {
            name, extensions: { orchestrator, ...(avatar === AVATAR ? { card_app: { enabled: true, entry: 'index.js', files: { 'index.js': ENTRY } } } : {}) },
        } });
    }
    const appDir = resolve(server.dataRoot, 'default-user', 'card-apps', 'preset-validation');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(resolve(appDir, 'index.js'), ENTRY);
});



for (const action of ['switch', 'clear', 'write', 'memory', 'fields', 'binding']) {
    test(`HTTP 500 ${action} reports failure and restores the live card`, async ({ page }) => {
        await open(page);
        await setOrchMode(page, 'loop');
        await editOrchAgentField(page, 'loop_agent', 'Keep the unsent harbor observations.', /Role prompt|角色提示/i, { closeAfter: true });
        const snapshot = () => page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return { card: ctx.characters[ctx.characterId], mode: ctx.extensionSettings.orchestrator.executionMode, json: document.querySelector('#character_json_data').value };
        });
        const liveBefore = await snapshot();
        const path = resolve(server.dataRoot, 'default-user', 'characters', AVATAR);
        const held = `${path}.held`;
        const bytes = readFileSync(path);
        renameSync(path, held);
        try {
            const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
            const controls = { switch: '#watch-apply', clear: '#watch-clear', write: '#watch-write', memory: '#watch-memory', fields: '#watch-fields', binding: '#watch-binding' };
            await page.locator('#watch-preset').selectOption('tide_log');
            await page.locator(controls[action]).click();
            const response = await responsePromise;
            expect(response.status()).toBe(500);
            await expect.poll(async () => JSON.parse(await page.locator('#watch-result').textContent() || '{}')).toMatchObject({ ok: false });
            expect(await snapshot()).toEqual(liveBefore);
            expect(readFileSync(held)).toEqual(bytes);
            await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the unsent harbor observations.');
            await closeWorkbench(page);
        } finally { renameSync(held, path); }
    });
}

test('the existing writer returns HTTP success and missing-character failure and propagates network rejection', async ({ page, context }) => {
    await open(page);
    await page.locator('#watch-write').click();
    await expect(page.locator('#watch-result')).toHaveText('{"ok":true}');
    await page.locator('#watch-target').selectOption('missing.png');
    await page.locator('#watch-write').click();
    await expect(page.locator('#watch-result')).toHaveText('{"ok":false}');
    await page.locator('#watch-target').selectOption(AVATAR);
    await context.setOffline(true);
    try {
        await page.locator('#watch-write').click();
        await expect(page.locator('#watch-result')).toHaveText('{"error":"TypeError"}');
    } finally { await context.setOffline(false); }
});

test('bulk non-OK rejects rather than reporting an empty success summary', async ({ page }) => {
    await open(page);
    await page.locator('#watch-bulk').click();
    await expect.poll(async () => JSON.parse(await page.locator('#watch-result').textContent() || '{}')).toEqual({ updated: [AVATAR], skipped: [], failed: [] });
    await page.locator('#watch-target').selectOption('missing.png');
    await page.locator('#watch-bulk').click();
    await expect.poll(async () => JSON.parse(await page.locator('#watch-result').textContent() || '{}')).toEqual({ updated: [], skipped: [], failed: ['missing.png'] });
    await page.locator('#watch-target').selectOption('../invalid.png');
    const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
    await page.locator('#watch-bulk').click();
    expect((await responsePromise).status()).toBe(400);
    await expect.poll(async () => JSON.parse(await page.locator('#watch-result').textContent() || '{}')).toHaveProperty('error');
});

test('a successful write after an HTTP failure stores and publishes the new value', async ({ page, context }) => {
    await open(page);
    const path = resolve(server.dataRoot, 'default-user', 'characters', AVATAR);
    const held = `${path}.held`;
    renameSync(path, held);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 3000, downloadThroughput: -1, uploadThroughput: -1 });
    let restored = false;
    try {
        const failedResponse = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
        await page.locator('#watch-write').click();
        const response = await failedResponse;
        expect(response.status()).toBe(500);
        // The real non-OK response headers have arrived but latency can still
        // hold its body. Restore only this test's card for the next real save.
        renameSync(held, path);
        restored = true;
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await expect(page.locator('#watch-result')).toHaveText('{"ok":false}');
        await page.locator('#watch-later').click();
        await expect(page.locator('#watch-result')).toHaveText('{"ok":true}');
        await page.locator('#watch-read').click();
        await expect.poll(async () => JSON.parse(await page.locator('#watch-result').textContent()).card.data.extensions.watch_note).toEqual({ bell: 'midnight' });
        const stored = JSON.parse(readPngCard(readFileSync(path))).data.extensions.watch_note;
        expect(stored).toEqual({ bell: 'midnight' });
    } finally {
        if (!restored) renameSync(held, path);
        await cdp.detach();
    }
});

for (const outcome of ['success', 'failure']) {
    test(`a pending ${outcome} write preserves a subsequent live extension edit`, async ({ page, context }) => {
        await open(page);
        const path = resolve(server.dataRoot, 'default-user', 'characters', AVATAR);
        const held = `${path}.held`;
        if (outcome === 'failure') renameSync(path, held);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 3000, downloadThroughput: -1, uploadThroughput: -1 });
        try {
            let settled = false;
            const response = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes')).then(r => { settled = true; return r; });
            const sent = page.waitForRequest(r => r.url().endsWith('/api/characters/merge-attributes'));
            await page.locator('#watch-write').click();
            await sent;
            await page.locator('#watch-margin').click();
            expect(settled).toBe(false);
            expect((await response).status()).toBe(outcome === 'success' ? 200 : 500);
            await expect(page.locator('#watch-result')).toHaveText(JSON.stringify({ ok: outcome === 'success' }));
            await page.locator('#watch-read').click();
            await expect.poll(async () => JSON.parse(await page.locator('#watch-result').textContent()).card.data.extensions.watch_note).toEqual({ bell: 'midnight', margin: 'unsent' });
        } finally {
            if (outcome === 'failure') renameSync(held, path);
            await cdp.detach();
        }
    });
}

test('overlapping writes publish the latest requested value rather than the first acknowledgement', async ({ page }) => {
    await open(page);
    await page.locator('#watch-overlap').click();
    await expect(page.locator('#watch-result')).toHaveText('{"results":[true,true]}');
    await page.locator('#watch-read').click();
    await expect.poll(async () => JSON.parse(await page.locator('#watch-result').textContent()).card.data.extensions.watch_overlap).toEqual({ bell: 'midnight' });
});

async function open(page) {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Keeper of the Outer Watch');
    await expect.poll(() => page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return ctx.characters[ctx.characterId]?.avatar;
    })).toBe(OTHER);
    await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Outer Watch');
    await selectCharacterByName(page, NAME);
    await expect.poll(() => page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return ctx.characters[ctx.characterId]?.avatar;
    })).toBe(AVATAR);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await enableOrchestratorMode(page, 'loop', { closeAfter: false });
    await setOrchMode(page, 'spec');
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().extensionSettings.orchestrator.executionMode)).toBe('spec');
    await closeWorkbench(page);
    await expect(page.locator('#watch-apply')).toBeVisible();
}
async function apply(page, avatar, preset, expected) {
    await page.locator('#watch-target').selectOption(avatar);
    await page.locator('#watch-preset').selectOption(preset);
    await page.locator('#watch-apply').click();
    await expect.poll(async () => JSON.parse(await page.locator('#watch-result').textContent() || 'null')).toEqual(expected);
}

function observeCardWrites(page) {
    const writes = [];
    const observe = request => {
        if (request.url().endsWith('/api/characters/merge-attributes')) writes.push(request.postDataJSON());
    };
    page.on('request', observe);
    return { writes, dispose: () => page.off('request', observe) };
}

test('selected and unselected card switches persist while clearing preserves the library', async ({ page }) => {
    await open(page);
    const preserved = readCard().presetLibraries;
    const otherPreserved = readCard(OTHER).presetLibraries;
    await apply(page, AVATAR, 'tide_log', { ok: true, mode: 'loop' });
    await expect.poll(() => readCard().activePresetIds.loop).toBe('tide_log');
    expect(readCard().override).toEqual({ mode: 'loop' });
    expect(readCard().presetLibraries).toEqual(preserved);
    await expect.poll(() => JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'))).extension_settings?.orchestrator?.executionMode).toBe('loop');
    await apply(page, OTHER, 'tide_log', { ok: true, mode: 'loop' });
    await expect.poll(() => readCard(OTHER).activePresetIds.loop).toBe('tide_log');
    expect(readCard(OTHER).presetLibraries).toEqual(otherPreserved);
    expect(readCard().activePresetIds.loop).toBe('tide_log');
    await apply(page, AVATAR, '', { ok: true, mode: 'loop' });
    await expect.poll(() => readCard().activePresetIds.loop).toBe('');
    expect(readCard().presetLibraries).toEqual(preserved);
});

test('invalid ids and avatars reject without card mutation', async ({ page }) => {
    await open(page);
    const before = readCard();
    const liveState = () => page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return { active: ctx.characters[ctx.characterId].data.extensions.orchestrator.activePresetIds.loop, mode: ctx.extensionSettings.orchestrator.executionMode };
    });
    const liveBefore = await liveState();
    const { writes, dispose } = observeCardWrites(page);
    try {
        for (const [avatar, preset, reason, mode] of [
            [AVATAR, 'storm_drill', 'preset_not_found', 'loop'],
            [AVATAR, 'constructor', 'preset_not_found', 'loop'],
            [EMPTY, 'tide_log', 'no_saved_mode', ''],
            ['missing.png', 'tide_log', 'character_not_found', ''],
        ]) {
            await apply(page, avatar, preset, { ok: false, mode, reason });
            expect(readCard()).toEqual(before);
            expect(await liveState()).toEqual(liveBefore);
            expect(writes).toEqual([]);
        }
        expect(readCard(EMPTY)).toEqual({});
    } finally {
        dispose();
    }
});

test('real offline selected and unselected switches preserve cards and execution mode', async ({ page, context }) => {
    await open(page);
    const before = readCard();
    const otherBefore = readCard(OTHER);
    await context.setOffline(true);
    try {
        await apply(page, AVATAR, 'reef_watch', { ok: false, mode: 'loop', reason: 'persist_failed' });
        const live = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return { active: ctx.characters[ctx.characterId].data.extensions.orchestrator.activePresetIds.loop, mode: ctx.extensionSettings.orchestrator.executionMode };
        });
        expect(live).toEqual({ active: before.activePresetIds.loop, mode: 'spec' });
        expect(readCard()).toEqual(before);
        await apply(page, OTHER, 'reef_watch', { ok: false, mode: 'loop', reason: 'persist_failed' });
        expect(readCard(OTHER)).toEqual(otherBefore);
        expect(readCard()).toEqual(before);
    } finally { await context.setOffline(false); }
});

test('a real offline clear reports failure without changing stored libraries or execution mode', async ({ page, context }) => {
    await open(page);
    const before = readCard();
    await context.setOffline(true);
    try {
        await page.locator('#watch-clear').click();
        await expect(page.locator('#watch-result')).toHaveText('{"ok":false}');
        expect(readCard()).toEqual(before);
        expect(await page.evaluate(() => window.Luker.getContext().extensionSettings.orchestrator.executionMode)).toBe('spec');
    } finally { await context.setOffline(false); }
});
