import { test, expect } from '../../harness/playwright.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { writeEmbeddedCharacter } from './_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

const AVATAR = 'async-watch.png';
const NAME = 'Keeper of the Patient Watch';
const ENTRY = `export function init(ctx) {
    const out = document.createElement('pre'); out.id = 'async-result';
    const status = document.createElement('pre'); status.id = 'async-status';
    let release; let calls = 0;
    const add = (name, run) => { const button = document.createElement('button'); button.id = 'async-' + name; button.textContent = name; button.onclick = run; ctx.container.append(button); };
    const current = () => { const live = ctx.lukerContext; return { live, id: live.characters.findIndex(c => c.avatar === ${JSON.stringify(AVATAR)}) }; };
    add('start', async () => {
        const { live, id } = current();
        const ok = await live.writeExtensionField(id, 'watch_state', async value => {
            calls++; status.textContent = JSON.stringify({ preparing: true, calls });
            await new Promise(resolve => { release = resolve; });
            return { ...value, prepared: true };
        });
        out.textContent = JSON.stringify({ ok, calls });
    });
    add('release', () => release());
    add('direct', async () => { const {live,id} = current(); await live.writeExtensionField(id, 'watch_state', { bell: 'midnight' }); status.textContent = 'direct saved'; });
    add('local', () => { const {live,id} = current(); live.characters[id].data.extensions.watch_state = { bell: 'unsent' }; status.textContent = 'local edited'; });
    add('identical', async () => { const {live,id} = current(); await live.writeExtensionField(id, 'watch_state', live.characters[id].data.extensions.watch_state); status.textContent = 'identical saved'; });
    add('replace', async () => { const {live,id} = current(); const old = live.characters[id]; await live.getCharacters(); status.textContent = JSON.stringify({ replaced: live.characters[id] !== old }); });
    add('legacy', async () => {
        const {live,id} = current();
        await live.writeExtensionField(id, 'luker', { retained: 'sibling', chat_completion_preset: { name: 'Legacy', preset: { temperature: 0.2 } } });
        const pending = live.character.presets.add(live.characters[id], 'New', { temperature: 0.8 });
        live.character.presets.list(live.characters[id]);
        await pending;
        // A trailing mutation is an actual queue barrier, not a settle sleep.
        await live.writeExtensionField(id, 'luker', value => value);
        out.textContent = 'legacy complete';
    });
    for (const kind of ['schema', 'advanced']) add('remove-' + kind, async () => {
        const {live,id} = current(); const api = live.getExtensionApi('memory-graph'); const avatar = live.characters[id].avatar;
        await live.writeExtensionField(id, 'memory_graph', { retained: 'sibling' });
        const save = kind === 'schema' ? api.persistCharacterSchemaOverride(live, avatar, api.getSchemaScopeInfo(live).schema) : api.persistCharacterAdvancedOverride(live, avatar, {});
        if (document.querySelector('#async-remove-order').value === 'pending') {
            status.textContent = 'save pending'; await new Promise(resolve => { release = resolve; });
        }
        const remove = kind === 'schema' ? api.removeCharacterSchemaOverride(live, avatar) : api.removeCharacterAdvancedOverride(live, avatar);
        out.textContent = JSON.stringify(await Promise.all([save, remove]));
    });
    add('rejection', async () => {
        const {live,id} = current();
        const rejected = live.writeExtensionField(id, 'watch_state', () => { throw new Error('Preparation failed'); }).catch(error => error.message);
        const next = live.writeExtensionField(id, 'watch_state', value => ({ ...value, next: true }));
        out.textContent = JSON.stringify(await Promise.all([rejected, next]));
    });
    add('other-key', async () => { const {live,id} = current(); await live.writeExtensionField(id, 'other_state', value => ({ ...value, saved: true })); status.textContent = 'other saved'; });
    add('other-character', async () => { const {live} = current(); const id = live.characters.findIndex(c => c.avatar === 'independent-watch.png'); await live.writeExtensionField(id, 'watch_state', value => ({ ...value, independent: true })); status.textContent = 'other character saved'; });
    add('direct-then-queued', async () => {
        const { live, id } = current();
        let queuedCalls = 0;
        const first = live.writeExtensionField(id, 'watch_state', { bell: 'reset' });
        const second = live.writeExtensionField(id, 'watch_state', value => {
            queuedCalls++;
            status.textContent = JSON.stringify({ queuedCalls, base: value });
            return { ...value, queued: true };
        });
        out.textContent = JSON.stringify({ outcomes: await Promise.all([first, second]), queuedCalls });
    });
    add('direct-then-direct', async () => {
        const { live, id } = current();
        const first = live.writeExtensionField(id, 'watch_state', { bell: 'first' });
        const second = live.writeExtensionField(id, 'watch_state', { bell: 'second' });
        out.textContent = JSON.stringify(await Promise.all([first, second]));
    });
    const order = document.createElement('select'); order.id = 'async-remove-order'; order.add(new Option('Same tick', 'same')); order.add(new Option('Pending save', 'pending'));
    ctx.container.append(out, status, order);
}`;
let server;
const disk = () => JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', AVATAR)))).data.extensions;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'character', scenarioId: '43-async-mutations' });
    markOnboarded({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: AVATAR, overrides: { name: NAME, extensions: {
        watch_state: { bell: 'dusk' }, card_app: { enabled: true, entry: 'index.js', files: { 'index.js': ENTRY } },
    } } });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'independent-watch.png', overrides: { name: 'Keeper of the Independent Watch', extensions: { watch_state: { bell: 'dawn' } } } });
    const dir = resolve(server.dataRoot, 'default-user', 'card-apps', 'async-watch'); mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, 'index.js'), ENTRY);
});



async function open(page) {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Keeper of the Independent Watch');
    await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Independent Watch');
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#async-start')).toBeVisible();
}
async function state(page, key) {
    return page.evaluate(({ avatar,key }) => {
        const ctx = window.Luker.getContext(); const card = ctx.characters.find(c => c.avatar === avatar);
        return { live: card.data.extensions[key], json: JSON.parse(card.json_data).data.extensions[key], editor: JSON.parse(document.querySelector('#character_json_data').value).data.extensions[key] };
    }, { avatar: AVATAR,key });
}
for (const change of ['direct', 'identical', 'local', 'replace']) {
    test(`async preparation refuses ${change} conflict without writing its stale value`, async ({ page }) => {
        await open(page);
        const before = disk().watch_state;
        await page.locator('#async-start').click();
        await expect(page.locator('#async-status')).toHaveText('{"preparing":true,"calls":1}');
        const writes = []; const observe = r => { if (r.url().endsWith('/api/characters/merge-attributes')) writes.push(r.postDataJSON()); };
        page.on('request', observe);
        try {
            await page.locator('#async-' + change).click();
            await expect(page.locator('#async-status')).toHaveText(change === 'replace' ? '{"replaced":true}' : change === 'direct' ? 'direct saved' : change === 'identical' ? 'identical saved' : 'local edited');
            const count = writes.length;
            await page.locator('#async-release').click();
            await expect(page.locator('#async-result')).toHaveText('{"ok":false,"calls":1}');
            expect(writes).toHaveLength(count);
            expect(disk().watch_state).toEqual(change === 'direct' ? { bell: 'midnight' } : before);
            const expected = change === 'local' ? { bell: 'unsent' } : disk().watch_state;
            expect(await state(page, 'watch_state')).toEqual({ live: expected, json: disk().watch_state, editor: disk().watch_state });
        } finally { page.off('request', observe); }
    });
}

test('legacy read while addition is pending does not remove the acknowledged new preset', async ({ page }) => {
    await open(page); await page.locator('#async-legacy').click(); await expect(page.locator('#async-result')).toHaveText('legacy complete');
    const expected = { retained: 'sibling', chat_completion_preset: { presets: [{ name: 'Legacy', preset: { temperature: 0.2 } }, { name: 'New', preset: { temperature: 0.8 } }], defaultPresetName: 'Legacy' } };
    expect(disk().luker).toEqual(expected); expect(await state(page, 'luker')).toEqual({ live: expected, json: expected, editor: expected });
});

for (const kind of ['schema', 'advanced']) {
    test(`same-tick ${kind} save then remove leaves the override absent`, async ({ page }) => {
        await open(page); await page.locator('#async-remove-' + kind).click(); await expect(page.locator('#async-result')).toHaveText('[true,true]');
        const expected = { retained: 'sibling' }; expect(disk().memory_graph).toEqual(expected); expect(await state(page, 'memory_graph')).toEqual({ live: expected, json: expected, editor: expected });
    });

    test(`pending ${kind} save then remove leaves the override absent`, async ({ page, context }) => {
        await open(page); await page.locator('#async-remove-order').selectOption('pending');
        const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 2000, downloadThroughput: -1, uploadThroughput: -1 });
        try {
            await page.locator('#async-remove-' + kind).click(); await expect(page.locator('#async-status')).toHaveText('save pending');
            await page.locator('#async-release').click(); await expect(page.locator('#async-result')).toHaveText('[true,true]');
            const expected = { retained: 'sibling' }; expect(disk().memory_graph).toEqual(expected); expect(await state(page, 'memory_graph')).toEqual({ live: expected, json: expected, editor: expected });
        } finally { await cdp.detach(); }
    });
}

test('preparation rejection releases the next mutation and another key is not blocked', async ({ page }) => {
    await open(page); await page.locator('#async-start').click(); await expect(page.locator('#async-status')).toHaveText('{"preparing":true,"calls":1}');
    await page.locator('#async-other-key').click(); await expect(page.locator('#async-status')).toHaveText('other saved');
    expect(disk().other_state).toEqual({ saved: true });
    await page.locator('#async-other-character').click(); await expect(page.locator('#async-status')).toHaveText('other character saved');
    const other = JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', 'independent-watch.png')))).data.extensions.watch_state;
    expect(other).toEqual({ bell: 'dawn', independent: true });
    await page.locator('#async-release').click(); await expect(page.locator('#async-result')).toHaveText('{"ok":true,"calls":1}');
    await page.locator('#async-rejection').click(); await expect(page.locator('#async-result')).toHaveText('["Preparation failed",true]');
    expect(disk().watch_state).toHaveProperty('next', true);
});

test('queued mutation waits for an in-flight direct write before reading its base', async ({ page, context }) => {
    await open(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/characters/merge-attributes', requestStage: 'Response' }] });
    const paused = [];
    cdp.on('Fetch.requestPaused', event => paused.push(event));
    const requests = [];
    const onRequest = req => { if (req.url().endsWith('/api/characters/merge-attributes')) requests.push(req.postDataJSON()); };
    page.on('request', onRequest);
    try {
        await page.locator('#async-direct-then-queued').click();
        await expect.poll(() => paused.length).toBe(1);
        expect(requests).toHaveLength(1);
        expect(requests[0].data.extensions.watch_state).toEqual({ bell: 'reset' });
        await expect(page.locator('#async-status')).not.toContainText('queuedCalls');
        const first = paused.shift();
        await cdp.send('Fetch.continueRequest', { requestId: first.requestId });
        await expect.poll(() => paused.length).toBe(1);
        expect(requests).toHaveLength(2);
        expect(requests[1].data.extensions.watch_state).toEqual({ bell: 'reset', queued: true });
        await cdp.send('Fetch.continueRequest', { requestId: paused.shift().requestId });
        await expect(page.locator('#async-result')).toHaveText('{"outcomes":[true,true],"queuedCalls":1}');
        const expected = { bell: 'reset', queued: true };
        expect(disk().watch_state).toEqual(expected);
        expect(await state(page, 'watch_state')).toEqual({ live: expected, json: expected, editor: expected });
    } finally {
        page.off('request', onRequest);
        for (const event of paused) await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
        await cdp.detach();
    }
});

test('overlapping direct writes serialize and keep committed first state when second fails', async ({ page, context }) => {
    await open(page);
    const cardPath = resolve(server.dataRoot, 'default-user', 'characters', AVATAR);
    const held = cardPath + '.held';
    const cdp = await context.newCDPSession(page);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/characters/merge-attributes', requestStage: 'Response' }] });
    const paused = [];
    cdp.on('Fetch.requestPaused', event => paused.push(event));
    const requests = [];
    const onRequest = req => { if (req.url().endsWith('/api/characters/merge-attributes')) requests.push(req.postDataJSON()); };
    page.on('request', onRequest);
    let moved = false;
    try {
        await page.locator('#async-direct-then-direct').click();
        await expect.poll(() => paused.length).toBe(1);
        expect(requests).toHaveLength(1);
        expect(requests[0].data.extensions.watch_state).toEqual({ bell: 'first' });
        renameSync(cardPath, held);
        moved = true;
        await cdp.send('Fetch.continueRequest', { requestId: paused.shift().requestId });
        await expect.poll(() => paused.length).toBe(1);
        expect(paused[0].responseStatusCode).toBe(500);
        await cdp.send('Fetch.continueRequest', { requestId: paused.shift().requestId });
        await expect(page.locator('#async-result')).toHaveText('[true,false]');
        renameSync(held, cardPath);
        moved = false;
        const expected = { bell: 'first' };
        expect(disk().watch_state).toEqual(expected);
        expect(await state(page, 'watch_state')).toEqual({ live: expected, json: expected, editor: expected });
    } finally {
        if (moved) renameSync(held, cardPath);
        page.off('request', onRequest);
        for (const event of paused) await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
        await cdp.detach();
    }
});
