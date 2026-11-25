import { test, expect } from '../../harness/playwright.js';
import { observeOperations } from '../../harness/observations.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { applyPatch } from '../../../public/scripts/util/fast-json-patch.js';

const NAME = 'Keeper of the Snapshot Source';
const ENTRY = `import * as core from '/script.js';
import { accountStorage } from '/scripts/util/AccountStorage.js';
export function init(ctx) {
    const live = ctx.lukerContext;
    const result = document.createElement('pre'); result.id = 'snapshot-result';
    const input = document.createElement('input'); input.id = 'snapshot-value';
    let last;
    const add = (name, run) => {
        const button = document.createElement('button'); button.id = 'snapshot-' + name; button.textContent = name;
        button.onclick = async () => {
            result.textContent = 'pending';
            const before = { accountStorage: accountStorage.getState() };
            try { const value = await run(); result.textContent = JSON.stringify({ before, value, settings: core.settings }); }
            catch (error) { result.textContent = JSON.stringify({ error: String(error) }); }
            result.dataset.last = name;
        };
        ctx.container.append(button);
    };
    const save = async options => { last = await live.saveSettings(0, options); return last; };
    add('save', () => save());
    add('direct', () => save({ directSave: true }));
    add('root', () => live.getPresetManager('openai').writePresetExtensionField({ path: '', value: { replacement: true } }));
    add('sibling', () => { live.chatCompletionSettings.extensions.sibling = input.value; return save(); });
    add('ordinary', () => { live.chatCompletionSettings.extensions.sibling = input.value; live.saveSettingsDebounced(); });
    const load = async options => {
        const value = input.value;
        let loaded = false;
        const listener = settings => {
            live.eventSource.removeListener(live.eventTypes.SETTINGS_LOADED_BEFORE, listener);
            loaded = true;
            settings.oai_settings.extensions.sibling = value;
        };
        live.eventSource.on(live.eventTypes.SETTINGS_LOADED_BEFORE, listener);
        try { await core.getSettings(options); }
        finally { live.eventSource.removeListener(live.eventTypes.SETTINGS_LOADED_BEFORE, listener); }
        return { loaded, live: structuredClone(live.chatCompletionSettings) };
    };
    add('load', () => load());
    add('bootstrap', () => load({ bootstrap: true }));
    add('supplied', async () => {
        const response = await fetch('/api/settings/get', { method: 'POST', headers: live.getRequestHeaders(), body: '{}' });
        if (!response.ok) throw new Error('Settings read failed: ' + response.status);
        const data = await response.json();
        const draft = JSON.parse(data.settings); draft.oai_settings.extensions.sibling = input.value;
        await core.getSettings({ payload: { ...data, settings: JSON.stringify(draft) } });
    });
    add('mutate-result', () => { last.payload.oai_settings.extensions.sibling = input.value; live.chatCompletionSettings.extensions.sibling = input.value; return save({ asyncDiff: false }); });
    add('mutate-export', () => { core.settings.oai_settings.extensions.sibling = input.value; live.chatCompletionSettings.extensions.sibling = input.value; return save({ asyncDiff: false }); });
    ctx.container.append(input, result);
}`;
let server;
const disk = () => JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));
const result = page => page.locator('#snapshot-result').evaluate(el => JSON.parse(el.textContent));

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'preset', scenarioId: 'snapshot-source', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'snapshot-source.png', overrides: { name: NAME, extensions: {
        card_app: { enabled: true, entry: 'index.js', files: { 'index.js': ENTRY } },
    } } });
    const dir = resolve(server.dataRoot, 'default-user', 'card-apps', 'snapshot-source');
    mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, 'index.js'), ENTRY);
});



test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', async () => {
            const output = document.createElement('pre'); output.id = 'snapshot-initialization'; document.body.append(output);
            const { eventSource, event_types } = await import('/scripts/events.js');
            const core = await import('/script.js');
            const { oai_settings } = await import('/scripts/openai.js');
            const states = [];
            for (const event of ['SETTINGS_LOADED_BEFORE', 'SETTINGS_LOADED_AFTER', 'SETTINGS_LOADED']) eventSource.on(event_types[event], () => {
                states.push({ event, settings: structuredClone(core.settings), live: structuredClone(oai_settings), sharedExtensions: core.settings?.oai_settings?.extensions === oai_settings.extensions });
                output.textContent = JSON.stringify(states);
            });
            eventSource.on(event_types.APP_READY, () => { output.dataset.ready = 'true'; });
        });
    });
});

async function click(page, name) {
    await page.locator('#snapshot-' + name).click();
    await expect(page.locator('#snapshot-result')).toHaveAttribute('data-last', name);
    await expect(page.locator('#snapshot-result')).not.toHaveText('pending');
    const value = await result(page);
    expect(value.error).toBeUndefined();
    return value;
}

async function open(page) {
    await awaitMainUI(page, server.baseURL);
    await expect(page.locator('#snapshot-initialization')).toHaveAttribute('data-ready', 'true');
    await page.locator('#main_api').selectOption('openai', { force: true });
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#snapshot-save')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().extensionSettings.quickReplyV2.characterConfigs['snapshot-source.png']?.setList)).toEqual([]);
}

async function observe(page, scope, testInfo) {
    const requests = [];
    const sources = new Map();
    const responses = new Map();
    const observer = await observeOperations({
        page,
        scope,
        baseURL: server.baseURL,
        patterns: ['save', 'patch'].flatMap(method => ['Request', 'Response'].map(requestStage => ({ urlPattern: '*/api/settings/' + method, requestStage }))),
        networkFilter: event => /\/api\/settings\/(save|patch)$/.test(event.request.url),
        readStored: disk,
        enableDebugger: false,
        onFetchPaused: async ({ event, response, stored }) => {
            const write = { id: event.networkId, body: JSON.parse(event.request.postData) };
            if (!response) {
                sources.set(event.networkId, { ...write, before: stored });
                const net = observer.network.get(event.networkId)?.request;
                if (net && !requests.some(r => r.id === event.networkId)) {
                    requests.push({ id: event.networkId, method: event.request.url.split('/').at(-1), body: write.body, source: net.initiator });
                }
            } else {
                responses.set(event.networkId, { ...write, status: event.responseStatusCode, stored });
            }
            return false;
        },
    });
    return {
        requests, sources, responses,
        async finish(states) {
            await observer.close();
            for (const row of observer.network.values()) {
                if (row.request && !requests.some(r => r.id === row.networkId)) {
                    requests.push({ id: row.networkId, method: row.request.request.url.split('/').at(-1), body: JSON.parse(row.request.request.postData), source: row.request.initiator });
                }
            }
            const path = testInfo.outputPath('snapshot-source-states.json');
            writeFileSync(path, JSON.stringify({ states, requests, sources: [...sources.values()], responses: [...responses.values()] }, null, 2));
            await testInfo.attach('snapshot-source-states', { path, contentType: 'application/json' });
        },
    };
}

async function acknowledgedRequestIds(trace, expected, { startIndex = 0 } = {}) {
    const matching = [];
    for (let index = 0; index < trace.requests.length; index++) {
        const request = trace.requests[index];
        await expect.poll(() => trace.responses.has(request.id)).toBe(true);
        const source = trace.sources.get(request.id);
        const response = trace.responses.get(request.id);
        expect(source.body).toEqual(request.body);
        expect(response.body).toEqual(request.body);
        expect(response.status).toBe(200);
        expect(request.source.stack.callFrames.some(frame => frame.functionName === 'saveSettingsInternal')).toBe(true);
        const captured = request.method === 'save' ? request.body : applyPatch(source.before, request.body.operations, true, false).newDocument;
        expect(response.stored).toEqual(captured);
        if (index >= startIndex && isDeepStrictEqual(captured, expected)) matching.push(request.id);
    }
    expect(matching.length).toBeGreaterThan(0);
    expect([...trace.sources.keys()]).toEqual(trace.requests.map(request => request.id));
    expect([...trace.responses.keys()]).toEqual(trace.requests.map(request => request.id));
    return matching;
}

async function rootSource(page, states) {
    await open(page);
    const baseline = (await click(page, 'save')).value;
    expect(baseline).toMatchObject({ ok: true, status: 'saved' });
    states.baseline = { expected: baseline.payload, actual: disk() };
    expect.soft(states.baseline.actual).toEqual(baseline.payload);
    const expected = structuredClone(baseline.payload);
    expected.oai_settings.extensions = { replacement: true };
    const root = await click(page, 'root');
    expected.accountStorage = root.before.accountStorage;
    states.root = { expected, consumer: root, actual: disk() };
    expect.soft(root.settings).toEqual(expected);
    expect.soft(states.root.actual).toEqual(expected);
    return expected;
}

for (const action of ['save', 'sibling', 'ordinary']) {
    test(`root-only save followed by initialization persists normalized source through ${action}`, async ({ page, resources }, testInfo) => {
        const trace = await observe(page, resources, testInfo);
        const states = {};
        try {
            const root = await rootSource(page, states);
            await open(page);
            states.initialization = await page.locator('#snapshot-initialization').evaluate(el => JSON.parse(el.textContent));
            const expected = structuredClone(root);
            expected.accountStorage.Personas_LastGlobalAvatar = root.user_avatar;
            if (action !== 'save') expected.oai_settings.extensions.sibling = 'dawn';
            states.expected = expected;
            await page.locator('#snapshot-value').fill('dawn');
            const boundary = trace.requests.length;
            states.consumer = await click(page, action);
            if (action === 'ordinary') {
                states.scheduled = states.consumer;
                await expect.poll(() => disk().oai_settings.extensions.sibling).toBe('dawn');
                const ordinaryIds = () => trace.requests.slice(boundary).filter(request => trace.responses.get(request.id)?.stored.oai_settings.extensions.sibling === 'dawn').map(request => request.id);
                await expect.poll(() => ordinaryIds().length).toBeGreaterThan(0);
                states.ordinaryRequestIds = ordinaryIds();
                states.consumer = await click(page, 'save');
                // A debounced save captures when it executes. Account storage
                // can acquire its validation entry before or after that point;
                // retain both independently observed inputs instead of assuming
                // the scheduled gesture or the later explicit call owns it.
                const inputs = [states.scheduled.before.accountStorage, states.consumer.before.accountStorage];
                states.ordinaryAcknowledgements = states.ordinaryRequestIds.map(id => {
                    const candidates = inputs.map(accountStorage => ({ ...structuredClone(expected), accountStorage }));
                    const intended = candidates.find(candidate => isDeepStrictEqual(candidate, trace.responses.get(id).stored));
                    expect(intended).toBeDefined();
                    expect(trace.requests.find(request => request.id === id).source.stack.callFrames.some(frame => frame.url.includes('/api/card-app/snapshot-source/index.js'))).toBe(false);
                    return { id, expected: intended };
                });
            }
            expected.accountStorage = states.consumer.before.accountStorage;
            states.actual = disk();
            expect(states.consumer.value).toEqual({ ok: true, status: 'saved', payload: expected });
            expect(states.consumer.settings).toEqual(expected);
            expect(states.actual).toEqual(expected);
            states.acknowledgedRequestIds = await acknowledgedRequestIds(trace, expected);
            await open(page);
            states.reloaded = await page.evaluate(async () => {
                const { settings } = await import('/script.js');
                return { settings, live: JSON.parse(JSON.stringify(window.Luker.getContext().chatCompletionSettings)) };
            });
            expect(states.reloaded).toEqual({ settings: expected, live: expected.oai_settings });
            expect(disk()).toEqual(expected);
        } finally { await trace.finish(states); }
    });
}

for (const source of ['load', 'bootstrap', 'supplied']) {
    test(`${source} settings preparation cannot acknowledge normalization or an unsaved draft`, async ({ page, resources }, testInfo) => {
        const trace = await observe(page, resources, testInfo);
        const states = {};
        try {
            const root = await rootSource(page, states);
            await page.locator('#snapshot-value').fill('dawn');
            const boundary = trace.requests.length;
            states.beforePreparation = await page.evaluate(() => ({ live: structuredClone(window.Luker.getContext().chatCompletionSettings), events: JSON.parse(document.querySelector('#snapshot-initialization').textContent) }));
            states.prepared = await click(page, source);
            if (source !== 'supplied' && !states.prepared.value.loaded) {
                states.discarded = states.prepared;
                expect(states.discarded.value.live).toEqual(states.beforePreparation.live);
                expect(await page.locator('#snapshot-initialization').evaluate(element => JSON.parse(element.textContent))).toEqual(states.beforePreparation.events);
                states.preparationBarrier = await click(page, 'save');
                expect(states.preparationBarrier.value).toEqual({ ok: true, status: 'saved', payload: { ...root, accountStorage: states.preparationBarrier.before.accountStorage } });
                states.prepared = await click(page, source);
            }
            if (source !== 'supplied') expect(states.prepared.value.loaded).toBe(true);
            // The loader's deferred rendering validates the active story
            // template and schedules account-storage persistence. Capture the
            // consumer only after that real input is established; retain the
            // strict complete outcome/file assertions below.
            await expect.poll(() => page.evaluate(async () => {
                const { accountStorage } = await import('/scripts/util/AccountStorage.js');
                const { getStringHash } = await import('/scripts/utils.js');
                const template = window.Luker.getContext().powerUserSettings.context.story_string;
                const cache = accountStorage.getItem('StoryStringValidationCache');
                return cache ? JSON.parse(cache).hashCache[getStringHash(template)] ?? null : null;
            })).not.toBeNull();
            const expected = structuredClone(root);
            expected.accountStorage.Personas_LastGlobalAvatar = root.user_avatar;
            expected.oai_settings.extensions.sibling = 'dawn';
            states.expected = expected;
            states.consumer = await click(page, 'save');
            // Account storage can acquire a story-validation entry during the
            // real loader's deferred rendering. Its invocation-time input is
            // observed separately from the saved outcome and the file.
            expected.accountStorage = states.consumer.before.accountStorage;
            states.actual = disk();
            expect(states.consumer.value).toEqual({ ok: true, status: 'saved', payload: expected });
            expect(states.actual).toEqual(expected);
            states.acknowledgedRequestIds = await acknowledgedRequestIds(trace, expected, { startIndex: boundary });
            const writes = trace.requests.slice(boundary);
            if (source === 'load') {
                expect(writes.some(request => request.method === 'patch')).toBe(true);
            } else {
                // A real ordinary full write can establish authority during
                // loading, before the explicit consumer's subsequent patch.
                const full = writes.find(request => request.method === 'save');
                expect(full).toBeDefined();
                states.authorityRequestId = full.id;
                for (const id of states.acknowledgedRequestIds) expect(trace.requests.findIndex(request => request.id === id)).toBeGreaterThanOrEqual(trace.requests.indexOf(full));
            }
        } finally { await trace.finish(states); }
    });
}

for (const target of ['result', 'export']) {
    test(`mutating a public ${target} does not establish a stored source`, async ({ page, resources }, testInfo) => {
        await open(page);
        const baseline = (await click(page, 'direct')).value.payload;
        expect(disk()).toEqual(baseline);
        const trace = await observe(page, resources, testInfo);
        const states = { baseline };
        try {
            const value = target + '-dawn';
            await page.locator('#snapshot-value').fill(value);
            const expected = structuredClone(baseline);
            expected.oai_settings.extensions.sibling = value;
            states.expected = expected;
            states.consumer = await click(page, 'mutate-' + target);
            states.actual = disk();
            expect(states.consumer.value).toEqual({ ok: true, status: 'saved', payload: expected });
            expect(states.actual).toEqual(expected);
            states.acknowledgedRequestIds = await acknowledgedRequestIds(trace, expected);
        } finally { await trace.finish(states); }
    });
}

test('explicit full save persists an unchanged payload instead of treating it as a no-op', async ({ page, resources }, testInfo) => {
    await open(page);
    const baseline = (await click(page, 'direct')).value.payload;
    expect(disk()).toEqual(baseline);
    const trace = await observe(page, resources, testInfo);
    const states = { expected: baseline };
    try {
        states.consumer = await click(page, 'direct');
        states.actual = disk();
        expect(states.consumer.value).toEqual({ ok: true, status: 'saved', payload: baseline });
        expect(states.actual).toEqual(baseline);
        states.acknowledgedRequestIds = await acknowledgedRequestIds(trace, baseline);
        expect(trace.requests.filter(request => request.source.stack.callFrames.some(frame => frame.url.includes('/api/card-app/snapshot-source/index.js'))).map(request => ({ method: request.method, body: request.body }))).toEqual([{ method: 'save', body: baseline }]);
    } finally { await trace.finish(states); }
});
