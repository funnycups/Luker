// #114 — Legacy iter-studio sessions stored in settings.json drain into
// their current stores the first time each studio opens.
//
// REAL USER-GESTURE flow, with one fixture-planting step (the legacy
// buckets can only be produced by pre-migration builds):
//   1. Plant a legacy session for the Seraphina card in each bucket of
//      settings.json: orchestrator iterStudioV2 (per character),
//      character_editor_assistant unified_cea_editor_sessions (per
//      character) and memory_graph iterStudioV2Schema (flat).
//   2. Select Seraphina, open the orchestrator iter-studio, the CEA editor
//      studio and the MG schema studio, closing each.
//   3. Assert on disk: the orchestrator and CEA sessions live in Seraphina's
//      Workbench state, the MG session lives in global Workbench state,
//      and settings.json no longer holds a retired session bucket.

import { test, expect } from '../../harness/playwright.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings, sessionBodyNamespace } from './_helpers.js';

let server, mock, avatar;

const ORCH_SESSION = { id: 's-legacy-orch', title: 'Night watch director tuning', mode: 'director', messages: [] };
const CEA_SESSION = { id: 's-legacy-cea', title: 'Glade ledger card pass', messages: [] };
const MG_SESSION = { id: 's-legacy-mg', title: 'Glade memory schema pass', messages: [] };

function settingsPath() {
    return resolve(server.dataRoot, 'default-user', 'settings.json');
}

function readExtensionSettings() {
    return JSON.parse(readFileSync(settingsPath(), 'utf8')).extension_settings || {};
}

function readStateFile(namespace) {
    const base = avatar.replace(/\.png$/, '');
    const path = resolve(server.dataRoot, 'default-user', 'characters', `${base}.state.${namespace}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function plantLegacyBuckets() {
    const s = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    const ext = (s.extension_settings = s.extension_settings || {});
    const updatedAt = Date.now();
    ext.orchestrator = ext.orchestrator || {};
    ext.orchestrator.iterStudioV2 = {
        director: { [`character_${avatar}`]: { [ORCH_SESSION.id]: { ...ORCH_SESSION, updatedAt } } },
    };
    ext.character_editor_assistant = ext.character_editor_assistant || {};
    ext.character_editor_assistant.unified_cea_editor_sessions = {
        [`char_${avatar}`]: { [CEA_SESSION.id]: { ...CEA_SESSION, updatedAt } },
    };
    ext.memory_graph = ext.memory_graph || {};
    ext.memory_graph.iterStudioV2Schema = { [MG_SESSION.id]: { ...MG_SESSION, updatedAt } };
    writeFileSync(settingsPath(), JSON.stringify(s, null, 4));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '114-legacy-sessions-drain-on-open',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    avatar = listCharacters({ dataRoot: server.dataRoot }).find(f => /Seraphina/.test(f));
    plantLegacyBuckets();
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#114 — legacy iter-studio sessions drain on first open', () => {
    test('orchestrator, CEA and MG schema studios move their legacy sessions out of settings.json', async ({ page }) => {
        expect(avatar, 'Seraphina card on disk').toBeTruthy();
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        const legacy = readExtensionSettings().orchestrator.iterStudioV2;
        const pattern = '**/api/characters/state/patch';
        let refused = false;
        const failImport = async route => {
            const body = route.request().postDataJSON();
            if (!refused && body.namespace === 'workbench_sessions'
                && JSON.stringify(body.operations).includes('orch')) {
                refused = true;
                await route.abort('failed');
                return;
            }
            await route.continue();
        };
        await page.route(pattern, failImport);
        try {
            await openIterStudio(page, 'orch', { scope: 'character' });
            await expect.poll(() => refused).toBe(true);
            await expect(page.locator('.wbench .wb-toast')).toContainText('workbench_sessions');
            expect(readExtensionSettings().orchestrator.iterStudioV2).toEqual(legacy);
            expect(readStateFile('workbench_sessions')?.legacyImported?.orch).toBeUndefined();
        } finally {
            await page.unroute(pattern, failImport);
            await closeIterStudio(page);
        }

        for (const [variant, scope, title] of [
            ['orch', 'character', ORCH_SESSION.title],
            ['cea', 'character', CEA_SESSION.title],
            ['mg', 'global', MG_SESSION.title],
        ]) {
            await openIterStudio(page, variant, { scope });
            await expect(page.locator('.wbench .wb-sess-item', { hasText: title })).toBeVisible();
            await closeIterStudio(page);
        }

        const characterState = readStateFile('workbench_sessions');
        const globalState = JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'states', 'workbench_sessions.json'), 'utf8'));
        for (const [ws, session] of [['orch', ORCH_SESSION], ['card', CEA_SESSION]]) {
            const matched = characterState.sessions.filter(saved => saved.ws === ws && saved.legacyId === session.id);
            expect(matched).toEqual([expect.objectContaining({ title: session.title, importedFromLegacy: true })]);
            expect(readStateFile(sessionBodyNamespace(matched[0].id)))
                .toEqual(expect.objectContaining({ title: session.title, messages: [], turns: [] }));
            expect(characterState.legacyImported[ws]).toBeTruthy();
        }
        const matchedMg = globalState.sessions.filter(saved => saved.ws === 'memory' && saved.legacyId === MG_SESSION.id);
        expect(matchedMg).toEqual([expect.objectContaining({ title: MG_SESSION.title, importedFromLegacy: true })]);
        expect(JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'states', `${sessionBodyNamespace(matchedMg[0].id)}.json`), 'utf8')))
            .toEqual(expect.objectContaining({ title: MG_SESSION.title, messages: [], turns: [] }));
        expect(globalState.legacyImported.memory).toBeTruthy();

        await expect.poll(() => {
            const ext = readExtensionSettings();
            return {
                orchLegacy: ext.orchestrator?.iterStudioV2 ?? null,
                ceaLegacy: ext.character_editor_assistant?.unified_cea_editor_sessions ?? null,
                mgLegacy: ext.memory_graph?.iterStudioV2Schema ?? null,
                intermediateGlobal: ext.memory_graph?.schema_iter_global_sessions ?? null,
            };
        }, { timeout: 15_000 }).toEqual({
            orchLegacy: null,
            ceaLegacy: null,
            mgLegacy: null,
            intermediateGlobal: null,
        });

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        expect(readStateFile('workbench_sessions')).toEqual(characterState);
        expect(JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'states', 'workbench_sessions.json'), 'utf8'))).toEqual(globalState);
    });

    test('an unreadable legacy namespace preserves acknowledged history and remains retryable after repair', async ({ resources, page }) => {
        const faultServer = await startServer({ scope: resources, batchKey: 'iterstudio', scenarioId: 'legacy-namespace-read-error' });
        markOnboarded({ dataRoot: faultServer.dataRoot });
        bootstrapCustomBackend({ dataRoot: faultServer.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: faultServer.dataRoot, baseURL: mock.baseURL });
        normalizeIterStudioSettings(faultServer.dataRoot);
        const selectedAvatar = listCharacters({ dataRoot: faultServer.dataRoot }).find(file => /Seraphina/.test(file));
        const base = selectedAvatar.replace(/\.png$/, '');
        const statePath = resolve(faultServer.dataRoot, 'default-user', 'characters', `${base}.state.workbench_sessions.json`);
        const legacyPath = resolve(faultServer.dataRoot, 'default-user', 'characters', `${base}.state.character_editor_assistant_iter_sessions.json`);
        await awaitMainUI(page, faultServer.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'cea', { scope: 'character', newSession: true });
        await sendIterPrompt(page, 'cea', 'Keep the glade ledger close to Seraphina.');
        await closeIterStudio(page);
        await faultServer.stop();
        const baseline = JSON.parse(readFileSync(statePath, 'utf8'));
        delete baseline.legacyImported.card;
        writeFileSync(statePath, JSON.stringify(baseline));
        const before = readFileSync(statePath);
        writeFileSync(legacyPath, '{"sessions":');
        await faultServer.restart();
        const failedRead = page.waitForResponse(response =>
            response.url().includes('/api/characters/state/get?')
            && new URL(response.url()).searchParams.get('namespace') === 'character_editor_assistant_iter_sessions');
        await reloadAndAwait(page, faultServer.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'cea', { scope: 'character' });
        expect((await failedRead).status()).toBe(500);
        await expect(page.locator('.wbench .wb-toast')).toContainText('character_editor_assistant_iter_sessions');
        expect(readFileSync(statePath)).toEqual(before);
        await expect(page.locator('.wbench .wb-sess-item', { hasText: 'Keep the glade ledger' })).toBeVisible();

        const recovered = {
            id: 's-recovered-cea',
            title: 'Watchpost ledger recollections',
            messages: [
                { role: 'user', content: 'Keep the names beside the lantern.' },
                { role: 'assistant', content: 'The ledger keeps the names in the order of the watch.' },
            ],
        };
        writeFileSync(legacyPath, JSON.stringify({ version: 1, sessions: { [recovered.id]: recovered } }));
        await closeIterStudio(page);
        await openIterStudio(page, 'cea', { scope: 'character' });
        await expect(page.locator('.wbench .wb-sess-item', { hasText: recovered.title })).toBeVisible();
        const actual = JSON.parse(readFileSync(statePath, 'utf8'));
        expect(actual.sessions.filter(session => !session.importedFromLegacy)).toEqual(baseline.sessions);
        const matchedRecovered = actual.sessions.filter(session => session.legacyId === recovered.id);
        expect(matchedRecovered).toEqual([expect.objectContaining({ title: recovered.title, importedFromLegacy: true })]);
        const recoveredBodyPath = resolve(faultServer.dataRoot, 'default-user', 'characters', `${base}.state.${sessionBodyNamespace(matchedRecovered[0].id)}.json`);
        expect(JSON.parse(readFileSync(recoveredBodyPath, 'utf8')))
            .toEqual(expect.objectContaining({
                title: recovered.title,
                messages: recovered.messages.map(message => expect.objectContaining(message)),
            }));
        expect(actual.legacyImported.card).toBeTruthy();
    });

    test('an unacknowledged legacy settings cleanup retains its source for retry', async ({ resources, page }) => {
        const cleanupServer = await startServer({ scope: resources, batchKey: 'iterstudio', scenarioId: 'legacy-settings-cleanup-error', extraConfig: { storage: { mode: 'fs' } } });
        markOnboarded({ dataRoot: cleanupServer.dataRoot });
        bootstrapCustomBackend({ dataRoot: cleanupServer.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: cleanupServer.dataRoot, baseURL: mock.baseURL });
        normalizeIterStudioSettings(cleanupServer.dataRoot);
        const path = resolve(cleanupServer.dataRoot, 'default-user', 'settings.json');
        const canonicalPath = resolve(cleanupServer.dataRoot, 'default-user', 'states', 'workbench_sessions.json');
        const legacySession = { id: 's-cleanup-orch', title: 'Tide-watch preparation notes', mode: 'director', messages: [], updatedAt: Date.now() };
        const legacy = { director: { global: { [legacySession.id]: legacySession } } };
        const settings = JSON.parse(readFileSync(path, 'utf8'));
        settings.extension_settings = settings.extension_settings || {};
        settings.extension_settings.orchestrator = settings.extension_settings.orchestrator || {};
        settings.extension_settings.orchestrator.iterStudioV2 = legacy;
        writeFileSync(path, JSON.stringify(settings));
        const readCanonical = () => JSON.parse(readFileSync(canonicalPath, 'utf8'));
        const imported = () => readCanonical().sessions.filter(session => session.ws === 'orch' && session.legacyId === legacySession.id);
        const failedWrites = [];
        const pattern = '**/api/settings/*';
        const refuseCleanup = async route => {
            const request = route.request();
            if (request.method() !== 'POST') {
                await route.continue();
                return;
            }
            const body = request.postDataJSON();
            const removesSource = body.operations?.some(operation =>
                operation.op === 'remove' && operation.path === '/extension_settings/orchestrator/iterStudioV2'
                || ['add', 'replace'].includes(operation.op) && operation.path === '/extension_settings/orchestrator'
                    && !Object.hasOwn(operation.value, 'iterStudioV2'))
                || body.extension_settings?.orchestrator && !Object.hasOwn(body.extension_settings.orchestrator, 'iterStudioV2');
            if (removesSource) {
                failedWrites.push({ body, imported: imported() });
                await route.abort('failed');
                return;
            }
            await route.continue();
        };
        await page.route(pattern, refuseCleanup);
        let saved, acknowledgedAt;
        try {
            await awaitMainUI(page, cleanupServer.baseURL);
            await openIterStudio(page, 'orch', { scope: 'global' });
            await expect.poll(() => failedWrites.length).toBeGreaterThan(0);
            await expect(page.locator('.wbench .wb-toast')).toContainText('Could not confirm cleanup');
            expect(imported()).toEqual([expect.objectContaining({ title: legacySession.title, scope: 'global', importedFromLegacy: true })]);
            [saved] = imported();
            const savedBodyPath = resolve(cleanupServer.dataRoot, 'default-user', 'states', `${sessionBodyNamespace(saved.id)}.json`);
            expect(JSON.parse(readFileSync(savedBodyPath, 'utf8')))
                .toEqual(expect.objectContaining({ title: legacySession.title, messages: [], turns: [], scope: 'global' }));
            acknowledgedAt = readCanonical().legacyImported.orch;
            expect(acknowledgedAt).toBeTruthy();
            for (const write of failedWrites) expect(write.imported).toEqual([saved]);
            expect(JSON.parse(readFileSync(path, 'utf8')).extension_settings.orchestrator.iterStudioV2).toEqual(legacy);
            expect(await page.evaluate(() => window.Luker.getContext().extensionSettings.orchestrator.iterStudioV2)).toEqual(legacy);
        } finally {
            await page.unroute(pattern, refuseCleanup);
            await closeIterStudio(page);
        }
        await openIterStudio(page, 'orch', { scope: 'global' });
        await expect(page.locator('.wbench .wb-sess-item', { hasText: legacySession.title })).toBeVisible();
        await expect.poll(() => JSON.parse(readFileSync(path, 'utf8')).extension_settings.orchestrator.iterStudioV2).toBeUndefined();
        expect(imported()).toEqual([saved]);
        expect(readCanonical().legacyImported.orch).toBe(acknowledgedAt);
        await cleanupServer.restart();
        await reloadAndAwait(page, cleanupServer.baseURL);
        expect(imported()).toEqual([saved]);
        expect(readCanonical().legacyImported.orch).toBe(acknowledgedAt);
        expect(JSON.parse(readFileSync(path, 'utf8')).extension_settings.orchestrator.iterStudioV2).toBeUndefined();
    });
});
