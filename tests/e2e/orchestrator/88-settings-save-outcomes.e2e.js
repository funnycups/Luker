import { test, expect } from '../../harness/playwright.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';
import {
    clickOrchSetupBarButton,
    editOrchAgentField,
    enableOrchestratorMode,
    getOrchRuntimeLimitInput,
    openOrchAddCustomToolPopup,
    readOrchAgentField,
    saveOrchDrafts,
} from '../_lib/ui-orchestrator.js';
import { closeWorkbench, openOrchWorkspace, setOrchMode } from '../_lib/ui-workbench.js';
import { configureMg, openMemoryWorkspace, openMgSchemaEditor } from '../_lib/ui-mg-varops.js';
import { applyPatch } from '../../../public/scripts/util/fast-json-patch.js';

const NAME = 'Keeper of the Settings Ledger';
const ENTRY = `export function init(ctx) {
    const live = ctx.lukerContext;
    const result = document.createElement('pre'); result.id = 'settings-results';
    const history = []; let events = 0;
    const input = document.createElement('input'); input.id = 'settings-value';
    const add = (name, run) => { const b = document.createElement('button'); b.id = 'settings-' + name; b.textContent = name; b.onclick = run; ctx.container.append(b); };
    live.eventSource.on(live.eventTypes.SETTINGS_UPDATED, () => { result.dataset.events = String(++events); });
    const save = async (directSave = false, asyncDiff = true, value = input.value) => {
        live.extensionSettings.settings_ledger = { value };
        const outcome = await live.saveSettings(0, { directSave, asyncDiff });
        history.push({ value, outcome, events }); result.textContent = JSON.stringify(history);
        return outcome;
    };
    add('save', () => save()); add('direct', () => save(true));
    add('sync', () => save(false, false)); add('direct-sync', () => save(true, false));
    const repair = async (value = input.value) => {
        live.extensionSettings.settings_ledger = { value: 'baseline' };
        if (value === 'different') live.extensionSettings.ledger_sibling = { value: 'new' };
        const outcome = await live.saveSettings();
        history.push({ value, outcome, events }); result.textContent = JSON.stringify(history);
    };
    add('repair', () => repair());
    add('ordinary-recovery', () => live.saveSettingsDebounced());
    add('save-repair', async () => {
        const value = input.value;
        if (!(await save(false, true, 'committed')).ok) await repair(value);
    });
    add('recovery-source', async () => {
        live.extensionSettings.ledger_sibling = { value: 'old', retained: { enabled: true } };
        await save(true);
    });
    add('shared', async () => {
        const schema = { type: 'object', properties: { ledger: { type: 'string' } } };
        live.extensionSettings.settings_ledger = { first: schema, second: schema };
        history.push({ value: 'shared', outcome: await live.saveSettings(0, { directSave: true }), events }); result.textContent = JSON.stringify(history);
    });
    add('deferred', async () => {
        const listener = async () => {
            live.eventSource.removeListener(live.eventTypes.GENERATION_STARTED, listener);
            live.extensionSettings.settings_ledger = { value: 'deferred' };
            const outcome = await live.saveSettings();
            history.push({ value: 'deferred', outcome, events }); result.textContent = JSON.stringify(history);
        };
        live.eventSource.on(live.eventTypes.GENERATION_STARTED, listener);
        try { await live.generateQuietPrompt({ quietPrompt: 'Read the ledger.', responseLength: 77 }); }
        catch (error) { result.dataset.generationError = String(error); }
    });
    add('recursive', async () => {
        const listener = async () => {
            live.eventSource.removeListener(live.eventTypes.SETTINGS_UPDATED, listener);
            live.extensionSettings.settings_ledger = { value: 'nested' };
            const outcome = await live.saveSettings();
            history.push({ value: 'nested', outcome, events }); result.textContent = JSON.stringify(history);
        };
        live.eventSource.on(live.eventTypes.SETTINGS_UPDATED, listener);
        await save(true);
    });
    ctx.container.append(input, result);
}`;
let server;
const disk = () => JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));
const results = page => page.locator('#settings-results').evaluate(el => JSON.parse(el.textContent || '[]'));

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'orchestrator', scenarioId: '88-settings-outcomes', extraConfig: { storage: { mode: 'fs' } } });
    markOnboarded({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'settings-ledger.png', overrides: { name: NAME, extensions: {
        card_app: { enabled: true, entry: 'index.js', files: { 'index.js': ENTRY } },
    } } });
    const dir = resolve(server.dataRoot, 'default-user', 'card-apps', 'settings-ledger');
    mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, 'index.js'), ENTRY);
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'matching-ledger.png', overrides: { name: 'Keeper of the Matching Ledger', extensions: { orchestrator: {
        override: { mode: 'loop' }, presetLibraries: { loop: { default: { name: 'Card ledger', system_prompt: 'Keep the distinct matching card ledger.', max_rounds: 7, customTools: [], seededDefaultCustomTools: true } } },
        activePresetIds: { loop: 'default' },
    } } } });
});



test('an early consumer receives not-ready rather than a persistence acknowledgement', async ({ page, context }) => {
    // Immutable pre-load consumer invoked by the actual settings-loading event.
    // The real deferred scheduler must eventually persist its live edit.
    // Hold the settings payload until the early consumer has called
    // saveSettings. script.js is already evaluated, but getSettings() has not
    // run, so settingsReady is false when the save returns not_ready.
    await page.route('**/api/settings/bootstrap', async route => {
        await page.waitForFunction(() => !!document.querySelector('#early-settings-save')?.dataset.result, null, { polling: 50, timeout: 30_000 });
        await route.continue();
    });
    await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
            const output = document.createElement('pre');
            output.id = 'early-settings-save';
            document.body.append(output);
            import('/scripts/events.js').then(async ({ eventSource, event_types }) => {
                // The settings payload is still held, so this listener runs
                // before the first SETTINGS_LOADED.
                const ready = async () => {
                    eventSource.removeListener(event_types.SETTINGS_LOADED, ready);
                    const { extension_settings } = await import('/scripts/extensions.js');
                    extension_settings.settings_ledger = { value: 'ready' };
                    output.dataset.ready = 'true';
                };
                eventSource.on(event_types.SETTINGS_LOADED, ready);
                const bootstrapped = () => {
                    eventSource.removeListener(event_types.APP_READY, bootstrapped);
                    output.dataset.bootstrapped = 'true';
                };
                eventSource.on(event_types.APP_READY, bootstrapped);
                const core = await import('/script.js');
                const { extension_settings } = await import('/scripts/extensions.js');
                extension_settings.settings_ledger = { value: 'early' };
                output.dataset.result = JSON.stringify(await core.saveSettings());
            });
        }, { once: true });
    });
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1000, downloadThroughput: -1, uploadThroughput: -1 });
    try {
        const scheduled = page.waitForResponse(r => r.url().endsWith('/api/settings/save') && r.request().postDataJSON()?.extension_settings?.settings_ledger?.value === 'ready');
        const bootstrap = page.waitForRequest(r => r.url().endsWith('/api/bootstrap'));
        await page.goto(server.baseURL, { waitUntil: 'domcontentloaded' }); await bootstrap;
        await expect(page.locator('#early-settings-save')).toHaveAttribute('data-result', JSON.stringify({ ok: false, status: 'deferred', reason: 'not_ready' }));
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await expect(page.locator('#early-settings-save')).toHaveAttribute('data-ready', 'true');
        expect((await scheduled).ok()).toBe(true);
        await expect(page.locator('#early-settings-save')).toHaveAttribute('data-bootstrapped', 'true');
        await expect(page.locator('#early-settings-save')).toHaveAttribute('data-result', JSON.stringify({ ok: false, status: 'deferred', reason: 'not_ready' }));
        await expect.poll(() => disk().extension_settings.settings_ledger).toEqual({ value: 'ready' });
    } finally { await cdp.detach(); }
});

async function open(page) {
    const browser = [], stages = [];
    const onConsole = message => browser.push({ type: message.type(), text: message.text(), location: message.location() });
    const onError = error => browser.push({ type: 'pageerror', message: error.message, stack: error.stack });
    page.on('console', onConsole); page.on('pageerror', onError);
    const initialization = () => page.evaluate(() => {
        const context = window.Luker.getContext();
        return { marks: performance.getEntriesByType('mark').map(entry => ({ name: entry.name, startTime: entry.startTime })), characterId: context.characterId, character: context.characters[context.characterId], cardApp: document.querySelector('#card-app-container')?.outerHTML };
    });
    try {
        await awaitMainUI(page, server.baseURL);
        stages.push({ name: 'main-ui', state: await initialization() });
        await expect.poll(() => page.evaluate(() => performance.getEntriesByName('[init] complete').some(entry => entry.entryType === 'mark'))).toBe(true);
        stages.push({ name: 'initialized', state: await initialization() });
        await selectCharacterByName(page, NAME);
        await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
        await expect(page.locator('#settings-save')).toBeVisible();
        await page.locator('#settings-value').fill('baseline');
        await page.locator('#settings-direct').click();
        await expect.poll(async () => (await results(page)).length).toBe(1);
    } finally {
        stages.push({ name: 'completed', state: await initialization() });
        page.off('console', onConsole); page.off('pageerror', onError);
        const observationPath = test.info().outputPath('settings-initialization.json'); writeFileSync(observationPath, JSON.stringify({ browser, stages }, null, 2));
        await test.info().attach('settings-initialization', { path: observationPath, contentType: 'application/json' });
    }
}

test('successful immediate save acknowledges its captured payload after the settings event', async ({ page }) => {
    await open(page);
    const [entry] = await results(page);
    expect(entry.outcome).toMatchObject({ ok: true, status: 'saved', payload: { extension_settings: { settings_ledger: { value: 'baseline' } } } });
    expect(entry.events).toBeGreaterThan(0);
    expect(disk().extension_settings.settings_ledger).toEqual({ value: 'baseline' });
});

test('capturing settings preserves repeated object values in the acknowledged and stored payload', async ({ page }) => {
    await open(page); await page.locator('#settings-shared').click();
    await expect.poll(async () => (await results(page)).length).toBe(2);
    const schema = { type: 'object', properties: { ledger: { type: 'string' } } };
    const expected = { first: schema, second: schema };
    expect((await results(page))[1].outcome.payload.extension_settings.settings_ledger).toEqual(expected);
    expect(disk().extension_settings.settings_ledger).toEqual(expected);
});

for (const [repair, next] of [['baseline', 'consumer'], ['baseline', 'ordinary'], ['different', 'consumer'], ['different', 'ordinary']]) {
    test(`lost committed response requires a real full repair for ${repair} through ${next} recovery`, async ({ page, context }, testInfo) => {
        await open(page);
        await page.locator('#settings-recovery-source').click();
        await expect.poll(async () => (await results(page)).length).toBe(2);
        const cdp = await context.newCDPSession(page);
        const writes = [];
        const sources = new Map();
        const responses = new Map();
        const deliveries = [];
        let lost;
        let resolveLost;
        const paused = new Promise(resolve => { resolveLost = resolve; });
        cdp.on('Network.requestWillBeSent', event => {
            if (!/\/api\/settings\/(save|patch)$/.test(event.request.url)) return;
            writes.push({ id: event.requestId, method: event.request.url.split('/').at(-1), body: JSON.parse(event.request.postData), source: event.initiator });
        });
        cdp.on('Fetch.requestPaused', event => {
            // Network and Fetch are separate event streams. Record each side
            // independently, then require their exact request-id correlation.
            const write = { id: event.networkId, body: JSON.parse(event.request.postData) };
            if (event.responseStatusCode === undefined && event.responseErrorReason === undefined) {
                // Observe the real source before dispatch, not when a later
                // Network notification happens to reach the test process.
                sources.set(event.networkId, { ...write, before: disk() });
                deliveries.push(cdp.send('Fetch.continueRequest', { requestId: event.requestId }));
                return;
            }
            write.status = event.responseStatusCode;
            write.stored = disk();
            responses.set(event.networkId, write);
            // Correlate the lost response to this consumer's actual patch,
            // not an earlier ordinary save using the same endpoint.
            if (!lost && write.body.operations?.some(op => op.path === '/extension_settings/settings_ledger/value' && op.value === 'committed')) {
                lost = write;
                resolveLost(event);
            } else deliveries.push(cdp.send('Fetch.continueRequest', { requestId: event.requestId }));
        });
        await cdp.send('Network.enable');
        // CDP gates only the source observation and real response delivery.
        // failRequest never supplies bytes or bypasses real server/storage.
        await cdp.send('Fetch.enable', { patterns: ['save', 'patch'].flatMap(method => ['Request', 'Response'].map(requestStage => ({ urlPattern: '*/api/settings/' + method, requestStage }))) });
        try {
            await page.locator('#settings-value').fill(next === 'consumer' ? repair : 'committed');
            await page.locator(next === 'consumer' ? '#settings-save-repair' : '#settings-save').click();
            const response = await paused;
            expect(response.responseStatusCode).toBe(200);
            await expect.poll(() => writes.some(write => write.id === lost.id)).toBe(true);
            const lostRequest = writes.find(write => write.id === lost.id);
            expect(lostRequest.method).toBe('patch');
            expect(lostRequest.body).toEqual(lost.body);
            expect(sources.get(lost.id).body).toEqual(lost.body);
            expect(applyPatch(sources.get(lost.id).before, lost.body.operations, true, false).newDocument).toEqual(lost.stored);
            expect(lost.stored.extension_settings.settings_ledger).toEqual({ value: 'committed' });
            expect(lost.stored.extension_settings.ledger_sibling).toEqual({ value: 'old', retained: { enabled: true } });
            const sibling = repair === 'different' ? { value: 'new' } : { value: 'old', retained: { enabled: true } };
            const boundary = writes.indexOf(lostRequest) + 1;
            const events = Number(await page.locator('#settings-results').getAttribute('data-events'));
            await cdp.send('Fetch.failRequest', { requestId: response.requestId, errorReason: 'ConnectionReset' });
            await expect.poll(async () => (await results(page)).length).toBeGreaterThanOrEqual(3);
            expect((await results(page))[2].outcome).toMatchObject({ ok: false, status: 'failed' });
            if (next === 'ordinary') await page.locator('#settings-ordinary-recovery').click();
            await expect.poll(() => writes.length).toBeGreaterThan(boundary);
            const firstRequest = writes[boundary];
            // The next actual persistence attempt must invalidate the uncertain
            // baseline even when it belongs to the ordinary debouncer.
            expect(firstRequest.method).toBe('save');
            await expect.poll(() => responses.has(firstRequest.id)).toBe(true);
            const first = { ...firstRequest, ...responses.get(firstRequest.id) };
            expect(first.status).toBe(200);
            expect(firstRequest.body).toEqual(first.body);
            expect(first.body).toEqual(first.stored);
            expect(first.source.stack.callFrames.some(frame => frame.functionName === 'saveSettingsInternal')).toBe(true);
            const ordinaryFirst = first.body.extension_settings.settings_ledger.value === 'committed';
            expect(first.body.extension_settings.settings_ledger).toEqual({ value: ordinaryFirst ? 'committed' : 'baseline' });
            expect(first.body.extension_settings.ledger_sibling).toEqual(ordinaryFirst ? { value: 'old', retained: { enabled: true } } : sibling);
            expect(first.source.stack.callFrames.some(frame => frame.url.startsWith(server.baseURL + '/api/card-app/settings-ledger/index.js'))).toBe(!ordinaryFirst);
            if (next === 'ordinary') {
                expect(ordinaryFirst).toBe(true);
                await expect.poll(async () => Number(await page.locator('#settings-results').getAttribute('data-events'))).toBeGreaterThan(events);
                await page.locator('#settings-value').fill(repair); await page.locator('#settings-repair').click();
            }
            await expect.poll(async () => (await results(page)).length).toBe(4);
            const outcome = (await results(page))[3].outcome;
            expect(outcome).toMatchObject({ ok: true, status: 'saved' });
            const acknowledged = writes.slice(boundary).map(request => {
                const source = sources.get(request.id);
                const response = responses.get(request.id);
                expect(source.body).toEqual(request.body);
                expect(response.body).toEqual(request.body);
                expect(response.status).toBe(200);
                const payload = request.method === 'save' ? request.body : applyPatch(source.before, request.body.operations, true, false).newDocument;
                expect(response.stored).toEqual(payload);
                return { ...request, before: source.before, stored: response.stored, payload };
            });
            // Match the explicit captured acknowledgement to its complete real
            // request/storage result, not to every endpoint call after a click.
            const explicit = acknowledged.find(write => isDeepStrictEqual(write.payload, outcome.payload));
            expect(explicit).toBeDefined();
            expect(explicit.method).toBe(ordinaryFirst ? 'patch' : 'save');
            if (ordinaryFirst) {
                expect(explicit.before.extension_settings.settings_ledger).toEqual({ value: 'committed' });
                expect(explicit.body.operations).toContainEqual({ op: 'test', path: '/extension_settings/settings_ledger/value', value: 'committed' });
            }
            expect(outcome).toEqual({ ok: true, status: 'saved', payload: explicit.payload });
            expect(explicit.stored).toEqual(outcome.payload);
            expect(outcome.payload.extension_settings.settings_ledger).toEqual({ value: 'baseline' });
            expect(outcome.payload.extension_settings.ledger_sibling).toEqual(sibling);
            expect(disk().extension_settings.settings_ledger).toEqual({ value: 'baseline' });
            expect(disk().extension_settings.ledger_sibling).toEqual(sibling);
            expect([...sources.keys()]).toEqual(writes.map(write => write.id));
            expect([...responses.keys()]).toEqual(writes.map(write => write.id));
        } finally {
            try {
                const path = testInfo.outputPath('settings-response-loss-attempts.json');
                writeFileSync(path, JSON.stringify({ writes, sources: [...sources.values()], responses: [...responses.values()] }, null, 2));
                await testInfo.attach('settings-response-loss-attempts', { path, contentType: 'application/json' });
                await cdp.send('Fetch.disable');
                await Promise.all(deliveries);
            } finally { await cdp.detach(); }
        }
    });
}

for (const failure of ['http', 'network']) {
    test(`${failure} failure is not acknowledged and a later successful request has its own outcome`, async ({ page, context }) => {
        await open(page);
        const root = resolve(server.dataRoot, 'default-user');
        const mode = statSync(root).mode;
        if (failure === 'http') chmodSync(root, 0o555);
        else await context.setOffline(true);
        try {
            await page.locator('#settings-value').fill('unsaved');
            await page.locator('#settings-direct').click();
            await expect.poll(async () => (await results(page)).length).toBe(2);
            expect((await results(page))[1].outcome).toMatchObject({ ok: false, status: 'failed' });
            expect(disk().extension_settings.settings_ledger).toEqual({ value: 'baseline' });
        } finally {
            if (failure === 'http') chmodSync(root, mode);
            else await context.setOffline(false);
        }
        await page.locator('#settings-value').fill('retry');
        await page.locator('#settings-direct').click();
        await expect.poll(async () => (await results(page)).length).toBe(3);
        expect((await results(page))[2].outcome).toMatchObject({ ok: true, payload: { extension_settings: { settings_ledger: { value: 'retry' } } } });
        expect(disk().extension_settings.settings_ledger).toEqual({ value: 'retry' });
    });
}

test('queued callers acknowledge different captured payloads rather than the previous request', async ({ page, context }) => {
    await open(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1000, downloadThroughput: -1, uploadThroughput: -1 });
    try {
        const sent = page.waitForRequest(r => r.url().endsWith('/api/settings/save'));
        await page.locator('#settings-value').fill('first'); await page.locator('#settings-direct').click(); await sent;
        await page.locator('#settings-value').fill('second'); await page.locator('#settings-direct').click();
        await page.locator('#settings-value').fill('third'); await page.locator('#settings-direct').click();
        await expect.poll(async () => (await results(page)).length).toBe(4);
        const history = (await results(page)).slice(1);
        expect(history.map(e => [e.value, e.outcome?.payload?.extension_settings?.settings_ledger?.value])).toEqual([['first', 'first'], ['second', 'second'], ['third', 'third']]);
        expect(history.every(e => e.outcome.ok)).toBe(true);
        expect(disk().extension_settings.settings_ledger).toEqual({ value: 'third' });
    } finally { await cdp.detach(); }
});

test('mixed queued patch and direct saves retain their own sync and async options', async ({ page, context }) => {
    await open(page);
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1000, downloadThroughput: -1, uploadThroughput: -1 });
    const writes = []; const observe = r => { if (/\/api\/settings\/(save|patch)$/.test(r.url())) writes.push(r.url().split('/').at(-1)); };
    page.on('request', observe);
    try {
        const sent = page.waitForRequest(r => r.url().endsWith('/api/settings/patch'));
        for (const [value, button] of [['async-patch', 'save'], ['sync-full', 'direct-sync'], ['sync-patch', 'sync'], ['async-full', 'direct']]) {
            await page.locator('#settings-value').fill(value); await page.locator('#settings-' + button).click();
            if (value === 'async-patch') await sent;
        }
        await expect.poll(async () => (await results(page)).length).toBe(5);
        expect(writes).toEqual(['patch', 'save', 'patch', 'save']);
        expect((await results(page)).slice(1).map(e => e.outcome.payload.extension_settings.settings_ledger.value)).toEqual(['async-patch', 'sync-full', 'sync-patch', 'async-full']);
        expect(disk()).toEqual((await results(page))[4].outcome.payload);
    } finally { page.off('request', observe); await cdp.detach(); }
});

test('a settings listener can await another real save without blocking the persistence queue', async ({ page }) => {
    await open(page);
    await page.locator('#settings-value').fill('outer'); await page.locator('#settings-recursive').click();
    await expect.poll(async () => (await results(page)).length).toBe(3);
    expect((await results(page)).slice(1).map(e => [e.value, e.outcome?.ok])).toEqual([['nested', true], ['outer', true]]);
    expect(disk().extension_settings.settings_ledger).toEqual({ value: 'nested' });
});

test('temporary generation values defer acknowledgement while preserving the scheduled edit', async ({ page }) => {
    await open(page);
    const before = disk();
    await page.locator('#settings-deferred').click();
    await expect.poll(async () => (await results(page)).length).toBe(2);
    expect((await results(page))[1].outcome).toEqual({ ok: false, status: 'deferred', reason: 'temporary_response_length' });
    await expect.poll(() => disk().extension_settings.settings_ledger).toEqual({ value: 'deferred' });
    expect(disk().amount_gen).toBe(before.amount_gen);
    expect(disk().oai_settings.openai_max_tokens).toBe(before.oai_settings.openai_max_tokens);
});

test('a real missing-parent patch failure falls back to the captured full payload', async ({ page }) => {
    await open(page);
    const path = resolve(server.dataRoot, 'default-user', 'settings.json'); const held = path + '.held';
    // Removing the test-owned file makes patching a nested existing field fail
    // against the empty repository. Full replacement must recreate it.
    renameSync(path, held);
    try {
        const patch = page.waitForResponse(r => r.url().endsWith('/api/settings/patch'));
        const full = page.waitForResponse(r => r.url().endsWith('/api/settings/save'));
        await page.locator('#settings-value').fill('fallback'); await page.locator('#settings-save').click();
        expect((await patch).status()).toBe(409); expect((await full).status()).toBe(200);
        await expect.poll(async () => (await results(page)).length).toBe(2);
        expect((await results(page))[1].outcome).toMatchObject({ ok: true, payload: { extension_settings: { settings_ledger: { value: 'fallback' } } } });
        expect(disk().extension_settings.settings_ledger).toEqual({ value: 'fallback' });
    } finally { renameSync(held, path); }
});

for (const order of ['failure-success', 'success-failure']) {
    test(`queued ${order} returns the outcome of each actual request`, async ({ page, context }) => {
        await open(page);
        const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
        const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1000, downloadThroughput: -1, uploadThroughput: -1 });
        const requestIds = new Set();
        cdp.on('Network.requestWillBeSent', e => { if (e.request.url.endsWith('/api/settings/save')) requestIds.add(e.requestId); });
        const firstStatus = new Promise(resolve => {
            cdp.on('Network.responseReceivedExtraInfo', e => { if (requestIds.has(e.requestId)) resolve(e.statusCode); });
        });
        if (order === 'failure-success') chmodSync(root, 0o555);
        try {
            const sent = page.waitForRequest(r => r.url().endsWith('/api/settings/save'));
            await page.locator('#settings-value').fill('first'); await page.locator('#settings-direct').click(); await sent;
            await page.locator('#settings-value').fill('second'); await page.locator('#settings-direct').click();
            expect(await firstStatus).toBe(order === 'failure-success' ? 500 : 200);
            chmodSync(root, order === 'failure-success' ? mode : 0o555);
            await expect.poll(async () => (await results(page)).length).toBe(3);
            const history = (await results(page)).slice(1);
            expect(history.map(e => [e.value, e.outcome.ok])).toEqual([['first', order !== 'failure-success'], ['second', order === 'failure-success']]);
            expect(disk().extension_settings.settings_ledger).toEqual({ value: order === 'failure-success' ? 'second' : 'first' });
        } finally { chmodSync(root, mode); await cdp.detach(); }
    });
}

async function prepareDraft(page, kind) {
    await open(page);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await enableOrchestratorMode(page, 'loop');
    // Ensure the seeded loop preset library and activePresetIds are persisted on disk
    // before capturing `before` or making the user directory read-only.
    const hasPersistedLoopSource = () => {
        const orch = disk().extension_settings?.orchestrator;
        const activeId = orch?.activePresetIds?.loop;
        return Boolean(activeId && orch?.presetLibraries?.loop?.[activeId]);
    };
    if (!hasPersistedLoopSource()) {
        await page.locator('#settings-direct').click();
        await expect.poll(hasPersistedLoopSource, { timeout: 15_000 }).toBe(true);
    }
    await editOrchAgentField(page, 'loop_agent', 'Keep the unwritten ledger observations.');
    if (kind === 'save') {
        return async () => saveOrchDrafts(page);
    }
    if (kind === 'limits') {
        const field = await getOrchRuntimeLimitInput(page, /Loop max rounds|Loop 最大轮数|Loop 最大輪數/i);
        const trigger = async () => {
            trigger.expectedLimit = Number(await field.inputValue()) + 1;
            await field.fill(String(trigger.expectedLimit)); await field.press('Tab');
        };
        return trigger;
    }
    const popup = await openOrchAddCustomToolPopup(page);
    const toolName = `read_ledger_${randomUUID().replaceAll('-', '_')}`;
    await popup.locator('[data-orch-ct-name]').fill(toolName);
    await popup.locator('[data-orch-ct-description]').fill('Read the ledger.');
    const trigger = async () => { await popup.locator('.popup-button-ok').click(); await popup.waitFor({ state: 'detached' }); };
    trigger.expectedTool = { name: toolName, displayName: '', description: 'Read the ledger.', mode: 'write', parameters: { type: 'object' }, body: '', simulateBody: '' };
    return trigger;
}

for (const kind of ['save', 'limits', 'tools']) {
    test(`global ${kind} failed save retains unrelated unsaved draft through a real host refresh`, async ({ page }) => {
        const trigger = await prepareDraft(page, kind);
        const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
        const before = disk().extension_settings.orchestrator.presetLibraries.loop;
        chmodSync(root, 0o555);
        try {
            const response = page.waitForResponse(r => r.url().endsWith('/api/settings/save'));
            await trigger(); await response;
            await expect(page.locator('#toast-container')).toContainText('Settings could not be saved');
            await setOrchMode(page, 'spec');
            await setOrchMode(page, 'loop');
            await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the unwritten ledger observations.');
            expect(disk().extension_settings.orchestrator.presetLibraries.loop).toEqual(before);
            await expect(page.locator('#toast-container')).not.toContainText('Global orchestration profile saved.');
        } finally { chmodSync(root, mode); }
    });
}

for (const kind of ['limits', 'tools']) {
    test(`global ${kind} successful auto-save preserves unrelated unsaved editor content`, async ({ page }) => {
        const trigger = await prepareDraft(page, kind);
        const before = JSON.parse(JSON.stringify(activeLoop()));
        const sent = page.waitForResponse(r => r.url().endsWith('/api/settings/patch') || r.url().endsWith('/api/settings/save'));
        await trigger(); expect((await sent).ok()).toBe(true);
        await setOrchMode(page, 'spec');
        await setOrchMode(page, 'loop');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the unwritten ledger observations.');
        const orch = disk().extension_settings.orchestrator;
        const saved = orch.presetLibraries.loop[orch.activePresetIds.loop];
        expect(saved).toEqual(kind === 'limits'
            ? { ...before, max_rounds: trigger.expectedLimit }
            : { ...before, customTools: [...before.customTools, trigger.expectedTool] });
    });
}

test('forcesave never reports settings success after a real storage failure', async ({ page }) => {
    await open(page);
    await selectCharacterByName(page, 'Seraphina');
    await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
    const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
    chmodSync(root, 0o555);
    try {
        await page.locator('#send_textarea').fill('/forcesave'); await page.locator('#send_but').click();
        await expect(page.locator('#toast-container')).toContainText('Settings could not be saved');
        await expect(page.locator('#toast-container')).not.toContainText('Chat and settings saved.');
    } finally { chmodSync(root, mode); }
});

test('global Memory Graph schema failure keeps the edited popup without a success notification', async ({ page }) => {
    await open(page);
    await configureMg(page, { enabled: true, closeAfter: false });
    const schema = await openMgSchemaEditor(page);
    await schema.locator('.ml-schema-list .ml-schema-type').first().click();
    await schema.locator('.ml-schema-additem').first().click();
    const field = schema.locator('.ml-schema-item .ml-schema-itemname').last();
    await field.fill('ledger_note');
    await expect(schema.locator('.ml-schema-state.is-dirty')).toBeVisible();
    const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
    const before = disk().extension_settings.memory_graph.nodeTypeSchema;
    chmodSync(root, 0o555);
    try {
        const response = page.waitForResponse(r => r.url().endsWith('/api/settings/save'));
        await schema.locator('.ml-schema-bar').getByRole('button', { name: /^(Save|保存|儲存)$/ }).click();
        const modal = page.locator('.wbench .mlens .ml-dialog-backdrop').last();
        await expect(modal).toBeVisible();
        await modal.locator('.ml-schema-modal-foot button').last().click();
        expect((await response).status()).toBe(500);
        await expect(field).toHaveValue('ledger_note');
        await expect(schema.locator('.ml-schema-state.is-dirty')).toBeVisible();
        await expect(schema.locator('.ml-schema-toast')).not.toHaveText(/^(Saved|已保存|已儲存)$/);
        expect(disk().extension_settings.memory_graph.nodeTypeSchema).toEqual(before);
    } finally { chmodSync(root, mode); }
});

async function orchPresetSelect(page) {
    const lens = await openOrchWorkspace(page, 'setup');
    const select = lens.locator('.ol-setup-bar select[aria-label]').first();
    await expect(select).toBeVisible({ timeout: 10_000 });
    return { lens, select };
}

test('switching the active global preset during a save cannot overwrite the newly selected draft', async ({ page, context }) => {
    await open(page);
    await enableOrchestratorMode(page, 'loop', { closeAfter: false });
    await presetAction(page, 'new', 'Evening Ledger');
    const { select } = await orchPresetSelect(page);
    await expect(select.locator('option')).not.toHaveCount(1);
    await expect.poll(async () => select.locator('option:checked').textContent()).toBe('Evening Ledger');
    const eveningValue = await select.inputValue();
    const evening = eveningValue.replace(/^global:/, '');
    const otherValue = await select.locator('option').evaluateAll((options, current) => options.find(o => o.value !== current && o.value.startsWith('global:'))?.value, eveningValue);
    expect(otherValue).toBeTruthy();
    const other = otherValue.replace(/^global:/, '');
    await select.selectOption(otherValue);
    await expect.poll(() => page.evaluate(async () => {
        const { uiState } = await import('/scripts/extensions/orchestrator/editor-state.js');
        return uiState.globalActivePresetIds.loop;
    })).toBe(other);
    await editOrchAgentField(page, 'loop_agent', 'Keep the old watch ledger.');
    await setOrchMode(page, 'director');
    await editOrchAgentField(page, 'main', 'Keep the unsent director ledger.');
    await setOrchMode(page, 'loop');
    await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the old watch ledger.');
    const { select: loopSelect } = await orchPresetSelect(page);
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
    try {
        const sent = page.waitForRequest(r => r.url().endsWith('/api/settings/patch') || r.url().endsWith('/api/settings/save'));
        await saveOrchDrafts(page); await sent;
        await loopSelect.selectOption(eveningValue);
        await expect.poll(() => disk().extension_settings.orchestrator.activePresetIds.loop).toBe(evening);
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).not.toBe('Keep the old watch ledger.');
        expect(disk().extension_settings.orchestrator.presetLibraries.loop[other].system_prompt).toBe('Keep the old watch ledger.');
        await setOrchMode(page, 'director');
        await expect.poll(() => readOrchAgentField(page, 'main')).toBe('Keep the unsent director ledger.');
    } finally { await cdp.detach(); }
});

test('a delayed explicit global save does not replace edits made after its captured payload', async ({ page, context }) => {
    const trigger = await prepareDraft(page, 'save');
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
    try {
        const sent = page.waitForRequest(r => r.url().endsWith('/api/settings/patch') || r.url().endsWith('/api/settings/save'));
        const response = page.waitForResponse(r => r.url().endsWith('/api/settings/patch') || r.url().endsWith('/api/settings/save'));
        await trigger(); await sent;
        await editOrchAgentField(page, 'loop_agent', 'Keep the later unsent ledger observations.');
        expect((await response).ok()).toBe(true);
        const orch = disk().extension_settings.orchestrator;
        expect(orch.presetLibraries.loop[orch.activePresetIds.loop].system_prompt).toBe('Keep the unwritten ledger observations.');
        await setOrchMode(page, 'spec');
        await setOrchMode(page, 'loop');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the later unsent ledger observations.');
    } finally { await cdp.detach(); }
});

const ACTION_TITLE_PATTERNS = {
    new: /^(New|新建)$/i,
    duplicate: /^(Duplicate|复制|複製)$/i,
    rename: /^(Rename|重命名|重新命名)$/i,
    delete: /^(Delete|删除|刪除)$/i,
};

async function presetAction(page, action, name) {
    const lens = await openOrchWorkspace(page, 'setup');
    const pattern = ACTION_TITLE_PATTERNS[action];
    const buttons = lens.locator('.ol-setup-bar button');
    const count = await buttons.count();
    let clicked = false;
    for (let i = 0; i < count; i++) {
        const b = buttons.nth(i);
        const label = (await b.getAttribute('aria-label')) || (await b.getAttribute('title')) || '';
        if (pattern.test(label.trim())) {
            await b.click();
            clicked = true;
            break;
        }
    }
    expect(clicked, `preset bar button for ${action}`).toBe(true);
    const dialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    if (action !== 'delete') {
        await dialog.locator('input.ol-input').first().fill(name);
        await dialog.locator('.ol-dialog-foot button.is-primary').first().click();
    } else {
        await dialog.locator('.ol-dialog-foot button.is-danger').first().click();
    }
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
}

async function importLoop(page) {
    const name = 'Imported ' + randomUUID();
    const lens = await openOrchWorkspace(page, 'setup');
    const importBtn = lens.locator('.ol-setup-bar button').filter({ hasText: /^(Import|导入|導入)$/i }).first();
    const chooser = page.waitForEvent('filechooser');
    await importBtn.click();
    await (await chooser).setFiles({ name: name + '.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'luker_orchestrator_profile_v4', mode: 'loop', name, profile: { mode: 'loop', system_prompt: 'Keep the imported ledger.', max_rounds: 9 } })) });
    const dialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.locator('input.ol-input').first().fill(name);
    await dialog.locator('.ol-dialog-foot button.is-primary').first().click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
}

async function globalSetup(page) {
    await open(page); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await enableOrchestratorMode(page, 'loop');
    if (!disk().extension_settings?.orchestrator?.activePresetIds?.loop) {
        await page.locator('#settings-direct').click();
    }
    await expect.poll(() => disk().extension_settings.orchestrator?.activePresetIds?.loop).toBeTruthy();
    const initialId = disk().extension_settings.orchestrator.activePresetIds.loop;
    await selectGlobalPreset(page, initialId);
    await expect.poll(() => page.evaluate(() => {
        const c = window.Luker.getContext(); return c.characters[c.characterId]?.data?.extensions?.orchestrator?.activePresetIds?.loop || '';
    })).toBe('');
    const name = 'First ' + randomUUID();
    await presetAction(page, 'new', name);
    await expect.poll(() => activeLoop().name).toBe(name);
    const globalId = disk().extension_settings.orchestrator.activePresetIds.loop;
    await selectGlobalPreset(page, globalId);
    await expect.poll(() => page.evaluate(() => {
        const c = window.Luker.getContext(); return c.characters[c.characterId]?.data?.extensions?.orchestrator?.activePresetIds?.loop || '';
    })).toBe('');
    const { select } = await orchPresetSelect(page);
    await expect.poll(() => select.locator('option:checked').textContent()).toBe(name);
    await editOrchAgentField(page, 'loop_agent', 'Keep the first ledger.');
    await saveOrchDrafts(page);
    await expect.poll(() => activeLoop().system_prompt).toBe('Keep the first ledger.');
    return globalId;
}
async function selectGlobalPreset(page, id) {
    const { select } = await orchPresetSelect(page);
    await select.selectOption(`global:${id}`);
}
function activeLoop() { const orch = disk().extension_settings.orchestrator; return orch.presetLibraries.loop[orch.activePresetIds.loop]; }

for (const failure of [false, true]) {
    test(`card to already-active global binds the requested source with storage failure ${failure}`, async ({ page }) => {
        await globalSetup(page);
        const global = JSON.parse(JSON.stringify(activeLoop()));
        const globalId = disk().extension_settings.orchestrator.activePresetIds.loop;
        await editOrchAgentField(page, 'loop_agent', 'Keep the separate card ledger.');
        await clickOrchSetupBarButton(page, /Save To Character Override|保存为角色覆盖|儲存為角色覆寫/i);
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/extensions/orchestrator/editor-state.js')).uiState.characterLoopEditor.system_prompt)).toBe('Keep the separate card ledger.');
        const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
        if (failure) chmodSync(root, 0o555);
        try {
            await selectGlobalPreset(page, globalId);
            await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(global.system_prompt);
            if (failure) await expect(page.locator('#toast-container')).toContainText('Settings could not be saved');
        } finally { chmodSync(root, mode); }
        await editOrchAgentField(page, 'loop_agent', 'Keep the later global ledger.');
        await saveOrchDrafts(page);
        await expect.poll(() => activeLoop()).toEqual({ ...global, system_prompt: 'Keep the later global ledger.' });
    });
}

test('equal card and global opaque ids still select the explicit global source', async ({ page }) => {
    await open(page);
    await selectCharacterByName(page, 'Keeper of the Matching Ledger');
    await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Matching Ledger');
    await enableOrchestratorMode(page, 'loop', { closeAfter: false });
    await selectGlobalPreset(page, 'default');
    await expect.poll(() => disk().extension_settings.orchestrator.activePresetIds.loop).toBe('default');
    const global = JSON.parse(JSON.stringify(activeLoop()));
    const { select } = await orchPresetSelect(page);
    await select.selectOption('character:default');
    await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the distinct matching card ledger.');
    const card = JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', 'matching-ledger.png')))).data.extensions.orchestrator;
    expect(card.activePresetIds.loop).toBe(disk().extension_settings.orchestrator.activePresetIds.loop);
    expect(card.activePresetIds.loop).toBe('default');
    await selectGlobalPreset(page, 'default');
    await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(global.system_prompt);
    await clickOrchSetupBarButton(page, /Save To Character Override|保存为角色覆盖|儲存為角色覆寫/i);
    await selectGlobalPreset(page, 'default');
    await expect.poll(() => activeLoop()).toEqual(global);
});

for (const action of ['rename', 'delete']) {
    for (const move of ['selection', 'avatar']) {
        test(`held ${action} retains skill operation ownership across unrelated ${move}`, async ({ page, context }) => {
            await globalSetup(page);
            const original = activeLoop(); const id = disk().extension_settings.orchestrator.activePresetIds.loop;
            const before = JSON.parse(JSON.stringify(disk().extension_settings.orchestrator.presetLibraries.loop));
            const other = Object.keys(before).find(key => key !== id);
            const name = 'Renamed ' + randomUUID();
            const scopeDir = resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', original.name);
            const content = '---\nname: ledger\ndescription: Read ledger\n---\nKeep the ledger.\n';
            mkdirSync(resolve(scopeDir, 'ledger'), { recursive: true }); writeFileSync(resolve(scopeDir, 'ledger', 'SKILL.md'), content);
            const cdp = await context.newCDPSession(page);
            await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/settings/patch', requestStage: 'Response' }] });
            try {
                const paused = new Promise(resolve => cdp.once('Fetch.requestPaused', resolve));
                await presetAction(page, action, name); const pending = await paused;
                expect(pending.responseStatusCode).toBe(200);
                expect(existsSync(scopeDir)).toBe(true);
                if (move === 'selection') {
                    await selectGlobalPreset(page, other);
                    await expect.poll(() => page.evaluate(() => {
                        const c = window.Luker.getContext(); return c.characters[c.characterId]?.data?.extensions?.orchestrator?.activePresetIds?.loop || '';
                    })).toBe('');
                } else {
                    await closeWorkbench(page);
                    await selectCharacterByName(page, 'Seraphina');
                    await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
                    await enableOrchestratorMode(page, 'loop', { closeAfter: false });
                }
                await editOrchAgentField(page, 'loop_agent', 'Keep the unrelated unsaved ledger.');
                await cdp.send('Fetch.continueRequest', { requestId: pending.requestId }); await cdp.send('Fetch.disable');
                await expect.poll(() => existsSync(scopeDir)).toBe(false);
                const expected = { ...before }; if (action === 'rename') expected[id] = { ...original, name }; else delete expected[id];
                expect(disk().extension_settings.orchestrator.presetLibraries.loop).toEqual(expected);
                if (action === 'rename') expect(readFileSync(resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', name, 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
                await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the unrelated unsaved ledger.');
            } finally { await cdp.detach(); }
        });
    }
}

for (const action of ['select', 'new', 'duplicate', 'import']) {
    test(`failed global ${action} cannot attach the old draft to the desired target`, async ({ page }) => {
        const first = await globalSetup(page);
        await presetAction(page, 'new', 'Second ' + randomUUID());
        await expect.poll(() => activeLoop().name.startsWith('Second ')).toBe(true);
        const { select } = await orchPresetSelect(page);
        const second = (await select.inputValue()).replace(/^global:/, '');
        await selectGlobalPreset(page, first);
        await expect.poll(() => disk().extension_settings.orchestrator.activePresetIds.loop).toBe(first);
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/extensions/orchestrator/editor-state.js')).uiState.globalLoopEditor.system_prompt)).toBe('Keep the first ledger.');
        const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
        chmodSync(root, 0o555);
        try {
            if (action === 'select') await selectGlobalPreset(page, second);
            else if (action === 'import') await importLoop(page);
            else await presetAction(page, action, 'Target ' + randomUUID());
            await expect(page.locator('#toast-container')).toContainText('Settings could not be saved');
        } finally { chmodSync(root, mode); }
        const desired = await page.evaluate(() => { const s = window.Luker.getContext().extensionSettings.orchestrator; return s.presetLibraries.loop[s.activePresetIds.loop]; });
        await setOrchMode(page, 'spec'); await setOrchMode(page, 'loop');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe(desired.system_prompt);
        await closeWorkbench(page);
        await page.locator('#settings-direct').click();
        await expect.poll(() => activeLoop()).toEqual(desired);
    });
}

for (const finalAction of ['rename', 'delete']) {
    test(`same-target acknowledged rename chain composes through ${finalAction}`, async ({ page, context }) => {
        await globalSetup(page);
        const original = activeLoop(); const id = disk().extension_settings.orchestrator.activePresetIds.loop;
        const middle = 'Middle ' + randomUUID(); const last = 'Last ' + randomUUID();
        const scope = name => resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', name);
        const content = '---\nname: ledger\ndescription: Read ledger\n---\nKeep ledger.\n';
        mkdirSync(resolve(scope(original.name), 'ledger'), { recursive: true }); writeFileSync(resolve(scope(original.name), 'ledger', 'SKILL.md'), content);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/settings/patch', requestStage: 'Response' }] });
        try {
            const paused = new Promise(resolve => cdp.once('Fetch.requestPaused', resolve));
            await presetAction(page, 'rename', middle); const pending = await paused;
            await presetAction(page, finalAction, last);
            expect(existsSync(scope(original.name))).toBe(true);
            await cdp.send('Fetch.continueRequest', { requestId: pending.requestId }); await cdp.send('Fetch.disable');
            await expect.poll(() => existsSync(scope(original.name))).toBe(false);
            await expect.poll(() => existsSync(scope(middle))).toBe(false);
            if (finalAction === 'rename') {
                await expect.poll(() => existsSync(scope(last))).toBe(true);
                expect(disk().extension_settings.orchestrator.presetLibraries.loop[id]).toEqual({ ...original, name: last });
                expect(readFileSync(resolve(scope(last), 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
            } else expect(disk().extension_settings.orchestrator.presetLibraries.loop[id]).toBeUndefined();
        } finally { await cdp.detach(); }
    });
}

test('failed rename followed by an acknowledged rename uses the last real skill scope', async ({ page }) => {
    await globalSetup(page);
    const original = activeLoop(); const id = disk().extension_settings.orchestrator.activePresetIds.loop;
    const middle = 'Unwritten ' + randomUUID(); const last = 'Written ' + randomUUID();
    const scope = name => resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', name);
    const content = '---\nname: ledger\ndescription: Read ledger\n---\nKeep ledger.\n';
    mkdirSync(resolve(scope(original.name), 'ledger'), { recursive: true }); writeFileSync(resolve(scope(original.name), 'ledger', 'SKILL.md'), content);
    const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
    chmodSync(root, 0o555);
    try { await presetAction(page, 'rename', middle); await expect(page.locator('#toast-container')).toContainText('Settings could not be saved'); }
    finally { chmodSync(root, mode); }
    expect(existsSync(scope(original.name))).toBe(true);
    await presetAction(page, 'rename', last);
    await expect.poll(() => existsSync(scope(last))).toBe(true);
    expect(existsSync(scope(original.name))).toBe(false); expect(existsSync(scope(middle))).toBe(false);
    expect(disk().extension_settings.orchestrator.presetLibraries.loop[id]).toEqual({ ...original, name: last });
    expect(readFileSync(resolve(scope(last), 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
});

for (const rename of ['failed', 'held']) {
    test(`duplicate resolves its actual source after a ${rename} rename`, async ({ page, context }) => {
        const sourceId = await globalSetup(page);
        const original = JSON.parse(JSON.stringify(activeLoop()));
        const before = JSON.parse(JSON.stringify(disk().extension_settings.orchestrator.presetLibraries.loop));
        const renamed = 'Source ' + randomUUID(); const duplicate = 'Copy ' + randomUUID();
        const scope = name => resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', name);
        const content = '---\nname: ledger\ndescription: Read the source ledger\n---\nRetain the exact source ledger.\n';
        mkdirSync(resolve(scope(original.name), 'ledger'), { recursive: true });
        writeFileSync(resolve(scope(original.name), 'ledger', 'SKILL.md'), content);
        const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
        const cdp = await context.newCDPSession(page);
        try {
            if (rename === 'failed') {
                chmodSync(root, 0o555);
                try { await presetAction(page, 'rename', renamed); await expect(page.locator('#toast-container')).toContainText('Settings could not be saved'); }
                finally { chmodSync(root, mode); }
            } else {
                await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/settings/patch', requestStage: 'Response' }] });
            }
            const paused = rename === 'held' ? new Promise(resolve => cdp.once('Fetch.requestPaused', resolve)) : null;
            if (rename === 'held') await presetAction(page, 'rename', renamed);
            const pending = paused ? await paused : null;
            if (pending) expect(pending.responseStatusCode).toBe(200);
            expect(readFileSync(resolve(scope(original.name), 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
            expect(existsSync(scope(renamed))).toBe(false);
            await presetAction(page, 'duplicate', duplicate);
            const { select } = await orchPresetSelect(page);
            await expect(select).not.toHaveValue(`global:${sourceId}`);
            const destinationId = (await select.inputValue()).replace(/^global:/, '');
            if (pending) {
                expect(existsSync(scope(duplicate))).toBe(false);
                await cdp.send('Fetch.continueRequest', { requestId: pending.requestId }); await cdp.send('Fetch.disable');
            }
            await expect.poll(() => existsSync(resolve(scope(duplicate), 'ledger', 'SKILL.md'))).toBe(true);
            expect(readFileSync(resolve(scope(duplicate), 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
            expect(disk().extension_settings.orchestrator.presetLibraries.loop).toEqual({
                ...before, [sourceId]: { ...original, name: renamed }, [destinationId]: { ...original, name: duplicate },
            });
            expect(readFileSync(resolve(scope(rename === 'held' ? renamed : original.name), 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
        } finally { chmodSync(root, mode); await cdp.detach(); }
    });
}

for (const action of ['rename', 'new', 'import']) {
    test(`delayed global ${action} completion preserves a later same-mode edit`, async ({ page, context }) => {
        await globalSetup(page);
        const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
        try {
            const sent = page.waitForRequest(r => /\/api\/settings\/(save|patch)$/.test(r.url()));
            const settled = page.waitForResponse(r => /\/api\/settings\/(save|patch)$/.test(r.url()));
            if (action === 'import') await importLoop(page);
            else await presetAction(page, action, 'Later ' + randomUUID());
            await sent;
            await editOrchAgentField(page, 'loop_agent', 'Keep the later unsaved ledger.');
            expect((await settled).ok()).toBe(true);
            await openOrchWorkspace(page, 'setup');
            await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the later unsaved ledger.');
        } finally { await cdp.detach(); }
    });
}

test('overlapping desired selections keep the latest owned draft while requests settle', async ({ page, context }) => {
    await globalSetup(page);
    const first = disk().extension_settings.orchestrator.activePresetIds.loop;
    await presetAction(page, 'new', 'Second ' + randomUUID());
    const { select } = await orchPresetSelect(page);
    const second = (await select.inputValue()).replace(/^global:/, '');
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
    try {
        await select.selectOption(`global:${first}`);
        await select.selectOption(`global:${second}`);
        await select.selectOption(`global:${first}`);
        await editOrchAgentField(page, 'loop_agent', 'Keep the latest selected unsaved ledger.');
        await expect.poll(() => disk().extension_settings.orchestrator.activePresetIds.loop).toBe(first);
        await openOrchWorkspace(page, 'setup');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the latest selected unsaved ledger.');
    } finally { await cdp.detach(); }
});

test('pending global rename cannot reload a new avatar draft after its unsaved edit', async ({ page, context }) => {
    await globalSetup(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/settings/patch', requestStage: 'Response' }] });
    try {
        let settled = false;
        const name = 'Renamed ' + randomUUID();
        const requested = page.waitForRequest(r => r.url().endsWith('/api/settings/patch') && r.postData().includes(JSON.stringify(name)));
        const response = requested.then(async request => {
            const renamed = await request.response();
            expect(renamed).not.toBeNull();
            await renamed.finished();
            settled = true;
            return renamed;
        });
        const paused = new Promise(resolve => cdp.once('Fetch.requestPaused', resolve));
        await presetAction(page, 'rename', name); const pending = await paused;
        expect(pending.request.postData).toBe((await requested).postData());
        await closeWorkbench(page);
        await selectCharacterByName(page, 'Seraphina');
        await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
        await enableOrchestratorMode(page, 'loop', { closeAfter: false });
        await editOrchAgentField(page, 'loop_agent', 'Keep the new watch unsaved ledger.');
        expect(settled).toBe(false);
        await cdp.send('Fetch.continueRequest', { requestId: pending.requestId }); await cdp.send('Fetch.disable');
        expect((await response).ok()).toBe(true);
        await openOrchWorkspace(page, 'setup');
        await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the new watch unsaved ledger.');
    } finally { await cdp.detach(); }
});

for (const action of ['rename', 'delete']) {
    test(`failed global ${action} leaves the dependent real skill directory unchanged`, async ({ page }) => {
        await globalSetup(page);
        const original = activeLoop();
        const skillDir = resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', original.name, 'ledger');
        const content = '---\nname: ledger\ndescription: Read the ledger\n---\nKeep the watch ledger.\n';
        mkdirSync(skillDir, { recursive: true }); writeFileSync(resolve(skillDir, 'SKILL.md'), content);
        const root = resolve(server.dataRoot, 'default-user'); const mode = statSync(root).mode;
        chmodSync(root, 0o555);
        try {
            await presetAction(page, action, 'Renamed ' + randomUUID());
            await expect(page.locator('#toast-container')).toContainText('Settings could not be saved');
            expect(existsSync(resolve(skillDir, 'SKILL.md'))).toBe(true);
            expect(readFileSync(resolve(skillDir, 'SKILL.md'), 'utf8')).toBe(content);
            expect(Object.values(disk().extension_settings.orchestrator.presetLibraries.loop)).toContainEqual(original);
        } finally { chmodSync(root, mode); }
    });
}

for (const action of ['rename', 'delete']) {
    test(`acknowledged global ${action} runs its dependent real skill operation afterward`, async ({ page }) => {
        await globalSetup(page);
        const original = activeLoop(); const name = 'Renamed ' + randomUUID();
        const scopeDir = resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', original.name);
        const skillDir = resolve(scopeDir, 'ledger'); const content = '---\nname: ledger\ndescription: Read the ledger\n---\nKeep the ledger.\n';
        mkdirSync(skillDir, { recursive: true }); writeFileSync(resolve(skillDir, 'SKILL.md'), content);
        await presetAction(page, action, name);
        await expect.poll(() => existsSync(scopeDir)).toBe(false);
        if (action === 'rename') {
            expect(activeLoop().name).toBe(name);
            expect(readFileSync(resolve(server.dataRoot, 'default-user', 'skills', 'orch-preset', 'loop', name, 'ledger', 'SKILL.md'), 'utf8')).toBe(content);
        } else expect(Object.values(disk().extension_settings.orchestrator.presetLibraries.loop).some(p => p.name === original.name)).toBe(false);
    });
}

async function openMgTechnicalPanel(page) {
    const lens = await openMemoryWorkspace(page, { subview: 'settings' });
    const panel = lens.locator('.ml-settings').first();
    const details = panel.locator('[data-settings-section="technical"]').first();
    await details.waitFor({ state: 'visible', timeout: 15_000 });
    if (!(await details.evaluate(el => el.hasAttribute('open')))) {
        await details.locator('summary.ml-settings-summary').first().click();
    }
    return panel;
}

test('a delayed advanced save cannot clear a later editor revision through host hydration', async ({ page, context }) => {
    await open(page);
    await configureMg(page, { enabled: true, closeAfter: false });
    let panel = await openMgTechnicalPanel(page);
    let field = panel.locator('[data-field-key="recallQueryMessages"] input');
    await field.fill('7'); await field.press('Tab');
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
    try {
        const sent = page.waitForRequest(r => /\/api\/settings\/(save|patch)$/.test(r.url()));
        const response = page.waitForResponse(r => /\/api\/settings\/(save|patch)$/.test(r.url()));
        await panel.locator('.ml-settings-sticky button').filter({ hasText: /^(Save Advanced to Global|保存高级到全局|儲存進階到全域)$/ }).first().click();
        await sent;
        await field.fill('8'); await field.press('Tab');
        expect((await response).ok()).toBe(true);
        expect(disk().extension_settings.memory_graph.recallQueryMessages).toBe(7);
        await expect(panel.locator('.ml-settings-dirty-pill')).toBeVisible();
        await expect(field).toHaveValue('8');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await closeWorkbench(page);
        await selectCharacterByName(page, 'Seraphina');
        await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
        panel = await openMgTechnicalPanel(page);
        field = panel.locator('[data-field-key="recallQueryMessages"] input');
        await field.fill('9'); await field.press('Tab');
        await closeWorkbench(page);
        panel = await openMgTechnicalPanel(page);
        await expect(panel.locator('.ml-settings-dirty-pill')).toBeVisible();
        await expect(panel.locator('[data-field-key="recallQueryMessages"] input')).toHaveValue('9');
    } finally { await cdp.detach(); }
});

test('clear card override then global tool auto-save supplies the actual inherited tools to character copy', async ({ page }) => {
    await globalSetup(page);
    await clickOrchSetupBarButton(page, /Save To Character Override|保存为角色覆盖|儲存為角色覆寫/i);
    await expect.poll(() => page.evaluate(() => {
        const c = window.Luker.getContext(); return c.characters[c.characterId].data.extensions.orchestrator?.activePresetIds?.loop;
    })).toBeTruthy();
    const storedCard = JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', 'settings-ledger.png'))));
    expect(storedCard.data.extensions.orchestrator.activePresetIds.loop).toBeTruthy();
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/extensions/orchestrator/editor-state.js')).uiState.characterLoopEditor.enabled)).toBe(true);
    const originalPopup = await openOrchAddCustomToolPopup(page);
    const cardTool = 'read_card_' + randomUUID().replaceAll('-', '_');
    await originalPopup.locator('[data-orch-ct-name]').fill(cardTool); await originalPopup.locator('[data-orch-ct-description]').fill('Read the card ledger.');
    await originalPopup.locator('.popup-button-ok').click(); await originalPopup.waitFor({ state: 'detached' });
    await expect.poll(() => JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', 'settings-ledger.png')))).data.extensions.orchestrator.presetLibraries.loop).toBeTruthy();
    await closeWorkbench(page);
    await selectCharacterByName(page, 'Seraphina');
    await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
    await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await enableOrchestratorMode(page, 'loop', { closeAfter: false });
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/extensions/orchestrator/editor-state.js')).uiState.characterLoopEditor.customTools.map(t => t.name))).toContain(cardTool);
    const lens = await openOrchWorkspace(page, 'setup');
    await clickOrchSetupBarButton(page, /Clear presets from this card|清除此卡预设|清除此卡預設/i);
    const confirmDialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
    await expect(confirmDialog).toBeVisible({ timeout: 10_000 });
    await confirmDialog.locator('.ol-dialog-foot button.is-danger').first().click();
    await confirmDialog.waitFor({ state: 'hidden', timeout: 5000 });
    await expect.poll(() => page.evaluate(() => {
        const c = window.Luker.getContext(); return c.characters[c.characterId].data.extensions.orchestrator?.activePresetIds?.loop || '';
    })).toBe('');
    const popup = await openOrchAddCustomToolPopup(page);
    const name = 'read_inherited_' + randomUUID().replaceAll('-', '_');
    await popup.locator('[data-orch-ct-name]').fill(name); await popup.locator('[data-orch-ct-description]').fill('Read inherited ledger.');
    await popup.locator('.popup-button-ok').click(); await popup.waitFor({ state: 'detached' });
    await expect.poll(() => activeLoop().customTools.map(t => t.name)).toContain(name);
    const intended = activeLoop().customTools;
    await clickOrchSetupBarButton(page, /Save To Character Override|保存为角色覆盖|儲存為角色覆寫/i);
    await expect.poll(() => page.evaluate(() => {
        const c = window.Luker.getContext(); const s = c.characters[c.characterId].data.extensions.orchestrator;
        return s?.presetLibraries?.loop?.[s?.activePresetIds?.loop]?.customTools;
    })).toEqual(intended);
    const savedCard = JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', 'settings-ledger.png')))).data.extensions.orchestrator;
    expect(savedCard.presetLibraries.loop[savedCard.activePresetIds.loop].customTools).toEqual(intended);
});
