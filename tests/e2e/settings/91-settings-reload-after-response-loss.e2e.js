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

const NAME = 'Keeper of the Reloaded Source';
const ENTRY = `import * as core from '/script.js';
import { accountStorage } from '/scripts/util/AccountStorage.js';
export function init(ctx) {
    const live = ctx.lukerContext;
    const output = document.createElement('pre'); output.id = 'reload-results';
    const history = [];
    const add = (name, action) => {
        const button = document.createElement('button'); button.id = 'reload-' + name; button.textContent = name;
        button.onclick = async () => {
            try { await action(); output.textContent = JSON.stringify(history); output.dataset.last = name; }
            catch (error) { output.dataset.error = String(error); }
        };
        ctx.container.append(button);
    };
    const save = async value => {
        if (value) live.extensionSettings.reload_source = { value };
        const before = { accountStorage: accountStorage.getState() };
        const outcome = await live.saveSettings(0, { asyncDiff: false });
        history.push({ before, outcome });
        return outcome;
    };
    add('baseline', () => save('baseline'));
    add('prime', async () => { await core.getSettings(); });
    add('recover', async () => {
        output.dataset.committing = JSON.stringify(accountStorage.getState());
        const failed = await save('committed');
        if (failed.ok) throw new Error('The response-loss attempt unexpectedly succeeded');
        await core.getSettings();
        output.dataset.loaded = JSON.stringify({ settings: core.settings, live: live.extensionSettings.reload_source });
        await save();
    });
    const overlapInputs = [];
    const overlapResults = [];
    let loadedEvents = 0;
    const state = () => JSON.parse(JSON.stringify({ settings: core.settings, extensions: live.extensionSettings, oai: live.chatCompletionSettings }));
    live.eventSource.on(live.eventTypes.SETTINGS_LOADED, () => { output.dataset.loadedEvents = String(++loadedEvents); });
    const overlapSave = async (name, value) => {
        if (value) live.extensionSettings.reload_source = { value };
        overlapInputs.push({ name, before: { ...state(), accountStorage: accountStorage.getState() } }); output.dataset.overlapInputs = JSON.stringify(overlapInputs);
        const outcome = await live.saveSettings();
        overlapResults.push({ name, outcome }); output.dataset.overlapResults = JSON.stringify(overlapResults);
    };
    add('source', async () => {
        live.extensionSettings.reload_sibling = { value: 'before' };
        delete live.extensionSettings.reload_extra;
        await overlapSave('a', 'baseline');
    });
    add('read', async () => {
        const value = await core.getSettings();
        output.dataset.readState = JSON.stringify({ valueType: typeof value, loadedEvents, state: state(), accountStorage: accountStorage.getState() });
    });
    add('write', () => overlapSave('b', 'committed'));
    add('second', () => overlapSave('c', 'second'));
    add('draft', () => { live.extensionSettings.reload_sibling = { value: 'local' }; });
    add('noop', () => overlapSave('later'));
    add('sibling', async () => { live.extensionSettings.reload_extra = { value: 'later' }; await overlapSave('later'); });
    add('inspect', () => { output.dataset.inspected = JSON.stringify({ loadedEvents, state: state(), accountStorage: accountStorage.getState() }); });
    ctx.container.append(output);
}`;
let server;
const disk = () => JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'preset', scenarioId: 'reload-after-response-loss', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'reload-source.png', overrides: { name: NAME, extensions: {
        card_app: { enabled: true, entry: 'index.js', files: { 'index.js': ENTRY } },
    } } });
    const dir = resolve(server.dataRoot, 'default-user', 'card-apps', 'reload-source');
    mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, 'index.js'), ENTRY);
});

async function openOverlap(page) {
    await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
            const marker = document.createElement('pre'); marker.id = 'overlap-ready'; document.body.append(marker);
            import('/scripts/events.js').then(({ eventSource, event_types }) => eventSource.on(event_types.APP_READY, () => { marker.dataset.ready = 'true'; }));
        });
    });
    await awaitMainUI(page, server.baseURL);
    await expect(page.locator('#overlap-ready')).toHaveAttribute('data-ready', 'true');
    await selectCharacterByName(page, NAME);
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().extensionSettings.quickReplyV2.characterConfigs['reload-source.png']?.setList)).toEqual([]);
    await page.locator('#reload-source').click();
    await expect(page.locator('#reload-results')).toHaveAttribute('data-last', 'source');
    const source = await overlapResult(page, 'a');
    expect(source).toMatchObject({ ok: true, status: 'saved' });
    expect(disk()).toEqual(source.payload);
    return source.payload;
}

const overlapInputs = page => page.locator('#reload-results').evaluate(el => JSON.parse(el.dataset.overlapInputs));
const overlapResult = async (page, name) => page.locator('#reload-results').evaluate((el, name) => JSON.parse(el.dataset.overlapResults || '[]').find(entry => entry.name === name)?.outcome, name);
async function inspected(page) {
    await page.locator('#reload-inspect').click();
    await expect(page.locator('#reload-results')).toHaveAttribute('data-last', 'inspect');
    return page.locator('#reload-results').evaluate(el => JSON.parse(el.dataset.inspected));
}

function desired(source, input, { value = 'committed', draft = false, sibling = false } = {}) {
    const expected = structuredClone(source);
    expected.accountStorage = input.before.accountStorage;
    expected.extension_settings.reload_source = { value };
    if (draft) expected.extension_settings.reload_sibling = { value: 'local' };
    if (sibling) expected.extension_settings.reload_extra = { value: 'later' };
    return expected;
}

async function observeOverlap(page, scope, testInfo) {
    const requests = [];
    const sources = new Map();
    const responses = new Map();
    const observer = await observeOperations({
        page,
        scope,
        baseURL: server.baseURL,
        patterns: [
            ...['Request', 'Response'].map(requestStage => ({ urlPattern: '*/api/settings/fields*', requestStage })),
            ...['save', 'patch'].flatMap(method => ['Request', 'Response'].map(requestStage => ({ urlPattern: '*/api/settings/' + method, requestStage }))),
        ],
        networkFilter: event => {
            const pathname = new URL(event.request.url).pathname;
            return (pathname === '/api/settings/fields' && event.request.method === 'GET') || /^\/api\/settings\/(save|patch)$/.test(pathname);
        },
        readStored: disk,
        recordBodies: true,
        enableDebugger: false,
        onFetchPaused: async ({ event, response, row, stored }) => {
            const pathname = new URL(event.request.url).pathname;
            const isFieldsRead = pathname === '/api/settings/fields' && event.request.method === 'GET';
            const body = isFieldsRead ? null : JSON.parse(event.request.postData);
            if (!response) {
                sources.set(event.networkId, { id: event.networkId, body, before: stored });
                const net = row.request;
                if (net && !requests.some(r => r.id === event.networkId)) {
                    requests.push({
                        id: event.networkId,
                        method: isFieldsRead ? 'fields' : pathname.split('/').at(-1),
                        body,
                        source: net.initiator,
                    });
                }
                return false;
            }
            const responseRow = { id: event.networkId, body, status: event.responseStatusCode, stored };
            if (isFieldsRead && event.responseStatusCode === 200 && row.responseBody) {
                responseRow.read = JSON.parse(row.responseBody);
            }
            responses.set(event.networkId, responseRow);
            return false;
        },
    });
    const readHold = observer.hold('overlap-fields-read', ({ response, event }) => (
        response
        && new URL(event.request.url).pathname === '/api/settings/fields'
        && event.request.method === 'GET'
    ));
    const writeHold = observer.hold('overlap-committed-write', ({ response, event }) => {
        if (!response) return false;
        const pathname = new URL(event.request.url).pathname;
        if (!/^\/api\/settings\/(save|patch)$/.test(pathname)) return false;
        const body = JSON.parse(event.request.postData);
        return body?.extension_settings?.reload_source?.value === 'committed'
            || body?.operations?.some(operation => operation.path === '/extension_settings/reload_source/value' && operation.value === 'committed');
    });
    return {
        observer,
        read: readHold.paused(),
        write: writeHold.paused(),
        requests,
        sources,
        responses,
        async release(pausedEvent, options) {
            return observer.release(pausedEvent, options);
        },
        async finish(states) {
            await observer.close();
            const path = testInfo.outputPath('overlapping-read-states.json');
            writeFileSync(path, JSON.stringify({ states, requests, sources: [...sources.values()], responses: [...responses.values()] }, null, 2));
            await testInfo.attach('overlapping-read-states', { path, contentType: 'application/json' });
        },
    };
}

async function capturedRead(trace) {
    const response = await trace.read;
    expect([200, 304]).toContain(response.responseStatusCode);
    await expect.poll(() => trace.requests.some(request => request.id === response.networkId)).toBe(true);
    const source = trace.sources.get(response.networkId);
    const actual = trace.responses.get(response.networkId);
    if (response.responseStatusCode === 200) {
        expect(Array.isArray(actual.read?.fields)).toBe(true);
    }
    expect(trace.requests.find(request => request.id === response.networkId).body).toEqual(source.body);
    return { response, source: source.before };
}

async function verifyOverlapWrites(trace) {
    for (const request of trace.requests) {
        await expect.poll(() => trace.responses.has(request.id)).toBe(true);
        const source = trace.sources.get(request.id);
        const response = trace.responses.get(request.id);
        expect(request.method === 'fields' ? [200, 304] : [200]).toContain(response.status);
        expect(source.body).toEqual(request.body);
        expect(response.body).toEqual(request.body);
        if (request.method !== 'fields') {
            expect(request.source.stack.callFrames.some(frame => frame.functionName === 'saveSettingsInternal')).toBe(true);
            const captured = request.method === 'save' ? request.body : applyPatch(source.before, request.body.operations, true, false).newDocument;
            expect(response.stored).toEqual(captured);
        }
    }
    expect([...trace.sources.keys()]).toEqual(trace.requests.map(request => request.id));
    expect([...trace.responses.keys()]).toEqual(trace.requests.map(request => request.id));
}

function expectedDiscardedRead(trace, states, input) {
    const before = states.beforeDelivery;
    let acknowledged = before.state.settings;
    if (!isDeepStrictEqual(acknowledged, states.loaded.state.settings)) {
        // A real queued ordinary repair can acknowledge B while A's response
        // is being delivered. Identify it from independent live inputs and its
        // complete request/response source, not from the old read or its position.
        const accounts = [input.before.accountStorage, before.accountStorage, states.loaded.accountStorage];
        const drafts = states.action === 'sibling' ? [false, true] : [false];
        const candidates = accounts.flatMap(accountStorage => drafts.map(draft => desired(states.a, { before: { accountStorage } }, { draft })));
        acknowledged = candidates.find(candidate => isDeepStrictEqual(candidate, states.loaded.state.settings));
        expect(acknowledged).toBeDefined();
        const bIndex = trace.requests.findIndex(request => request.id === states.writeId);
        const repair = trace.requests.find((request, index) => index > bIndex && request.method !== 'fields' && isDeepStrictEqual(trace.responses.get(request.id)?.stored, acknowledged));
        expect(repair).toBeDefined();
        states.interveningAcknowledgementId = repair.id;
    }
    return { valueType: 'undefined', loadedEvents: before.loadedEvents, state: { ...before.state, settings: acknowledged } };
}

for (const loss of [false, true]) {
    for (const action of ['noop', 'sibling']) test(`held full source cannot replace an intervening write with response loss ${loss} before ${action}`, async ({ page, resources }, testInfo) => {
        const initial = await openOverlap(page);
        const trace = await observeOverlap(page, resources, testInfo);
        const states = { initial, loss, action };
        try {
            await page.locator('#reload-read').click();
            const read = await capturedRead(trace);
            states.a = read.source;
            states.readId = read.response.networkId;
            await page.locator('#reload-write').click();
            const write = await trace.write;
            expect(write.responseStatusCode).toBe(200);
            states.writeId = write.networkId;
            const bInput = (await overlapInputs(page)).find(input => input.name === 'b');
            states.bInput = bInput;
            states.b = desired(states.a, bInput);
            expect(trace.responses.get(write.networkId).stored).toEqual(states.b);
            await trace.release(write, { failReason: loss ? 'ConnectionReset' : null });
            await expect.poll(() => overlapResult(page, 'b')).toBeDefined();
            states.bOutcome = await overlapResult(page, 'b');
            if (loss) {
                expect(states.bOutcome).toMatchObject({ ok: false, status: 'failed' });
                const toast = page.locator('#toast-container .toast-error').filter({ hasText: 'Settings could not be saved' });
                await expect(toast).toBeVisible();
                await toast.click();
                await expect(toast).toHaveCount(0);
            } else expect(states.bOutcome).toEqual({ ok: true, status: 'saved', payload: states.b });
            if (action === 'sibling') {
                await page.locator('#reload-draft').click();
                await expect(page.locator('#reload-results')).toHaveAttribute('data-last', 'draft');
            }
            states.beforeDelivery = await inspected(page);
            expect(states.beforeDelivery.state.extensions.reload_source).toEqual({ value: 'committed' });
            await trace.release(read.response);
            await expect(page.locator('#reload-results')).toHaveAttribute('data-last', 'read');
            states.loaded = await page.locator('#reload-results').evaluate(el => JSON.parse(el.dataset.readState));
            states.expectedLoaded = expectedDiscardedRead(trace, states, bInput);
            expect.soft({ valueType: states.loaded.valueType, loadedEvents: states.loaded.loadedEvents, state: states.loaded.state }).toEqual(states.expectedLoaded);
            await page.locator('#reload-' + action).click();
            await expect.poll(() => overlapResult(page, 'later')).toBeDefined();
            const laterInput = (await overlapInputs(page)).find(input => input.name === 'later');
            states.laterInput = laterInput;
            states.expected = desired(states.a, laterInput, { draft: action === 'sibling', sibling: action === 'sibling' });
            states.outcome = await overlapResult(page, 'later');
            states.actual = disk();
            expect(states.outcome).toEqual({ ok: true, status: 'saved', payload: states.expected });
            expect(states.actual).toEqual(states.expected);
            await verifyOverlapWrites(trace);
            const writesAfterB = trace.requests.filter(request => request.method !== 'fields' && trace.requests.indexOf(request) > trace.requests.findIndex(request => request.id === states.writeId));
            if (loss) expect(writesAfterB[0]?.method).toBe('save');
            else expect(writesAfterB.every(request => request.method === 'patch')).toBe(true);
        } finally { await trace.finish(states); }
    });
}

test('a completed nonstale full read remains usable by later ordinary writes', async ({ page, resources }, testInfo) => {
    const initial = await openOverlap(page);
    const trace = await observeOverlap(page, resources, testInfo);
    const states = { initial };
    try {
        await page.locator('#reload-read').click();
        const read = await capturedRead(trace);
        states.a = read.source;
        states.readId = read.response.networkId;
        const before = await inspected(page);
        await trace.release(read.response);
        await expect(page.locator('#reload-results')).toHaveAttribute('data-last', 'read');
        states.loaded = await page.locator('#reload-results').evaluate(el => JSON.parse(el.dataset.readState));
        expect(states.loaded.state.settings).toEqual(states.a);
        expect(states.loaded.loadedEvents).toBe(before.loadedEvents + 1);
        await page.locator('#reload-write').click();
        const write = await trace.write;
        const bInput = (await overlapInputs(page)).find(input => input.name === 'b');
        states.bInput = bInput;
        states.expected = desired(states.a, bInput);
        expect(trace.responses.get(write.networkId).stored).toEqual(states.expected);
        await trace.release(write);
        await expect.poll(() => overlapResult(page, 'b')).toBeDefined();
        states.outcome = await overlapResult(page, 'b');
        states.actual = disk();
        expect(states.outcome).toEqual({ ok: true, status: 'saved', payload: states.expected });
        expect(states.actual).toEqual(states.expected);
        expect(trace.requests.find(request => request.id === write.networkId).method).toBe('patch');
        await verifyOverlapWrites(trace);
    } finally { await trace.finish(states); }
});

test('a full read cannot load over pending queued writes and a later closed read still loads', async ({ page, resources }, testInfo) => {
    const initial = await openOverlap(page);
    const trace = await observeOverlap(page, resources, testInfo);
    const states = { initial };
    try {
        await page.locator('#reload-write').click();
        const write = await trace.write;
        await page.locator('#reload-second').click();
        await expect.poll(async () => (await overlapInputs(page)).some(input => input.name === 'c')).toBe(true);
        await page.locator('#reload-draft').click();
        await expect(page.locator('#reload-results')).toHaveAttribute('data-last', 'draft');
        states.beforeDelivery = await inspected(page);
        await page.locator('#reload-read').click();
        const read = await capturedRead(trace);
        states.readId = read.response.networkId;
        states.writeId = write.networkId;
        states.readSource = read.source;
        await trace.release(read.response);
        await expect(page.locator('#reload-results')).toHaveAttribute('data-last', 'read');
        states.loaded = await page.locator('#reload-results').evaluate(el => JSON.parse(el.dataset.readState));
        states.expectedLoaded = { valueType: 'undefined', loadedEvents: states.beforeDelivery.loadedEvents, state: states.beforeDelivery.state };
        expect.soft({ valueType: states.loaded.valueType, loadedEvents: states.loaded.loadedEvents, state: states.loaded.state }).toEqual(states.expectedLoaded);
        await trace.release(write);
        await expect.poll(() => overlapResult(page, 'c')).toBeDefined();
        const inputs = await overlapInputs(page);
        states.inputs = inputs;
        states.b = desired(initial, inputs.find(input => input.name === 'b'));
        states.c = desired(initial, inputs.find(input => input.name === 'c'), { value: 'second' });
        expect(await overlapResult(page, 'b')).toEqual({ ok: true, status: 'saved', payload: states.b });
        expect(await overlapResult(page, 'c')).toEqual({ ok: true, status: 'saved', payload: states.c });
        await page.locator('#reload-noop').click();
        await expect.poll(() => overlapResult(page, 'later')).toBeDefined();
        states.laterInput = (await overlapInputs(page)).find(input => input.name === 'later');
        states.expected = desired(initial, states.laterInput, { value: 'second', draft: true });
        states.outcome = await overlapResult(page, 'later');
        states.actual = disk();
        expect(states.outcome).toEqual({ ok: true, status: 'saved', payload: states.expected });
        expect(states.actual).toEqual(states.expected);
        await page.locator('#reload-read').click();
        await expect(page.locator('#reload-results')).toHaveAttribute('data-last', 'read');
        states.fresh = await page.locator('#reload-results').evaluate(el => JSON.parse(el.dataset.readState));
        expect(states.fresh.loadedEvents).toBe(states.beforeDelivery.loadedEvents + 1);
        expect(states.fresh.state.settings).toEqual(states.expected);
        await verifyOverlapWrites(trace);
    } finally { await trace.finish(states); }
});



test('a full settings reload after response loss reads the real source instead of reviving its cached predecessor', async ({ page, resources }, testInfo) => {
    await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
            const marker = document.createElement('pre'); marker.id = 'reload-ready'; document.body.append(marker);
            import('/scripts/events.js').then(({ eventSource, event_types }) => {
                eventSource.on(event_types.APP_READY, () => { marker.dataset.ready = 'true'; });
            });
        });
    });
    const reads = [];
    page.on('request', request => {
        if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/settings/fields') reads.push(request.url());
    });
    await awaitMainUI(page, server.baseURL);
    await expect(page.locator('#reload-ready')).toHaveAttribute('data-ready', 'true');
    await selectCharacterByName(page, NAME);
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().extensionSettings.quickReplyV2.characterConfigs['reload-source.png']?.setList)).toEqual([]);
    const output = page.locator('#reload-results');
    await page.locator('#reload-baseline').click();
    await expect(output).toHaveAttribute('data-last', 'baseline');
    const baseline = await output.evaluate(el => JSON.parse(el.textContent)[0].outcome.payload);
    expect(disk()).toEqual(baseline);
    const primed = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/settings/fields');
    await page.locator('#reload-prime').click();
    expect([200, 304]).toContain((await primed).status());
    await expect(output).toHaveAttribute('data-last', 'prime');
    const boundary = reads.length;
    const requests = [];
    const writes = [];
    const observer = await observeOperations({
        page,
        scope: resources,
        baseURL: server.baseURL,
        patterns: [{ urlPattern: '*/api/settings/patch', requestStage: 'Response' }, { urlPattern: '*/api/settings/save', requestStage: 'Response' }],
        networkFilter: event => /\/api\/settings\/(save|patch)$/.test(event.request.url),
        readStored: disk,
        enableDebugger: false,
        onFetchPaused: async ({ event, response, row, stored }) => {
            if (!response) return false;
            const body = JSON.parse(event.request.postData);
            writes.push({ id: event.networkId, body, stored, status: event.responseStatusCode });
            if (row.request && !requests.some(r => r.id === event.networkId)) {
                requests.push({ id: event.networkId, body, source: row.request.initiator });
            }
            return false;
        },
    });
    const held = observer.hold('reload-committed-loss', ({ response, event }) => {
        if (!response) return false;
        const body = JSON.parse(event.request.postData);
        return body.extension_settings?.reload_source?.value === 'committed'
            || body.operations?.some(operation => operation.path === '/extension_settings/reload_source/value' && operation.value === 'committed');
    });
    const states = { baseline };
    try {
        await page.locator('#reload-recover').click();
        const response = await held.paused();
        expect(response.responseStatusCode).toBe(200);
        const intended = structuredClone(baseline);
        intended.accountStorage = await output.evaluate(el => JSON.parse(el.dataset.committing));
        intended.extension_settings.reload_source = { value: 'committed' };
        states.committed = disk();
        expect(states.committed).toEqual(intended);
        await expect.poll(() => requests.some(request => request.id === response.networkId)).toBe(true);
        const committedRequest = requests.find(request => request.id === response.networkId);
        const committedResponse = writes.find(write => write.id === response.networkId);
        expect(committedResponse.body).toEqual(committedRequest.body);
        expect(committedResponse.stored).toEqual(intended);
        expect(committedRequest.source.stack.callFrames.some(frame => frame.functionName === 'saveSettingsInternal')).toBe(true);
        await observer.release(response, { failReason: 'ConnectionReset' });
        await expect(output).toHaveAttribute('data-last', 'recover');
        expect(await output.getAttribute('data-error')).toBeNull();
        states.history = await output.evaluate(el => JSON.parse(el.textContent));
        states.loaded = await output.evaluate(el => JSON.parse(el.dataset.loaded));
        states.reads = reads.slice(boundary);
        expect.soft(states.history[1].outcome).toMatchObject({ ok: false, status: 'failed' });
        expect.soft(states.reads.map(url => new URL(url).pathname)).toEqual(['/api/settings/fields']);
        expect.soft(states.loaded.live).toEqual({ value: 'committed' });
        expect.soft(states.loaded.settings).toEqual(intended);
        const expected = structuredClone(intended);
        expected.accountStorage = states.history[2].before.accountStorage;
        states.expected = expected;
        states.actual = disk();
        expect(states.history[2].outcome).toEqual({ ok: true, status: 'saved', payload: expected });
        expect(states.actual).toEqual(expected);
    } finally {
        await observer.close();
        const path = testInfo.outputPath('reload-source-states.json');
        writeFileSync(path, JSON.stringify({ states, requests, writes }, null, 2));
        await testInfo.attach('reload-source-states', { path, contentType: 'application/json' });
    }
});
