/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import './_mocks/luker-zh.js';
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

let currentListExtensions = ['orchestrator'];
let disabledExtensions = [];

jest.unstable_mockModule('../../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

jest.unstable_mockModule('../../../public/scripts/extensions/orchestrator/main.js', () => ({
    getSettings: () => globalThis.Luker.getContext().extensionSettings.orchestrator,
    getDefaultRequestSystemPrompt: () => 'Default base',
    ITERATION_MODE_PROMPT_DEFAULTS: { spec: '', loop: '', director: '', agenda: '' },
    buildAiIterationToolSet: () => [],
    buildAiIterationSystemPrompt: () => 'sys',
    executeAiIterationToolCalls: async () => ({ toolResults: [] }),
}));

const { createLukerSource } = await import('../../../public/scripts/extensions/orchestrator/lens/source-luker.js');
const { initOrchestraLens } = await import('../../../public/scripts/extensions/orchestrator/lens/index.js');
const { createOrchAskProvider, createOrchSuggestRuleProvider } = await import('../../../public/scripts/extensions/orchestrator/lens/providers.js');

function makeContext({ settings = {}, characters = [], chat = [] } = {}) {
    const workspaces = [];
    const askProviders = [];
    const suggestProviders = [];
    const iterateTargets = [];
    const attachDockMock = jest.fn();
    const openWorkbenchMock = jest.fn();

    const ctx = {
        groupId: null,
        characterId: characters.length ? 0 : -1,
        characters,
        chat,
        chatId: 'chat_1',
        name2: characters[0]?.name || '',
        constants: { promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 }, wiPosition: { atDepth: 6 } },
        extensionSettings: {
            disabledExtensions,
            orchestrator: {
                enabled: true,
                executionMode: 'spec',
                activePresetIds: { spec: 'default' },
                presetLibraries: {
                    spec: {
                        default: {
                            name: 'Default',
                            spec: { stages: [{ id: 'distill', mode: 'serial', nodes: ['distiller'] }] },
                            presets: { distiller: { systemPrompt: 's', userPromptTemplate: 't' } },
                        },
                    },
                },
                ...settings,
            },
        },
        listExtensionNames: () => currentListExtensions,
        addLocaleData: () => {},
        translate: s => String(s ?? ''),
        getCurrentLocale: () => 'en',
        getExtensionApi: (name) => (name === 'orchestrator' ? { loadSkillInventory: async () => [], listExtensionTools: () => [] } : null),
        eventSource: { on() {}, removeListener() {} },
        eventTypes: {},
        saveSettingsDebounced: jest.fn(),
        workbench: {
            registerWorkspace: (def) => { workspaces.push(def); return () => {}; },
            registerAskProvider: (def) => { askProviders.push(def); return () => {}; },
            registerSuggestRuleProvider: (def) => { suggestProviders.push(def); return () => {}; },
            registerIterateTarget: (def) => { iterateTargets.push(def); return () => {}; },
            open: openWorkbenchMock,
        },
        runPanel: {
            attachDock: attachDockMock,
            openRunDock: jest.fn(),
            toggleRunDock: jest.fn(),
            getRunRecorder: () => ({
                history: () => [{
                    runId: 'run_fail',
                    source: 'orchestrator',
                    mode: 'spec',
                    status: 'error',
                    error: 'rate limited',
                    startedAt: 1000,
                    endedAt: 29000,
                    rounds: [],
                }],
                currents: () => [],
                subscribe: () => () => {},
            }),
        },
    };
    return { ctx, workspaces, askProviders, suggestProviders, iterateTargets, attachDockMock, openWorkbenchMock };
}

beforeEach(() => {
    currentListExtensions = ['orchestrator'];
    disabledExtensions = [];
});

describe('orchestrator/lens/index.js & source-luker.js', () => {
    test('initOrchestraLens registers workspace, providers, iterateTarget, and attaches dock', () => {
        const harness = makeContext();
        globalThis.Luker.getContext = () => harness.ctx;

        initOrchestraLens();

        expect(harness.workspaces.map(w => w.id)).toEqual(['orch']);
        expect(harness.askProviders.map(p => p.id)).toEqual(['orch']);
        expect(harness.suggestProviders.map(p => p.id)).toEqual(['orch']);
        expect(harness.iterateTargets.map(t => t.id)).toEqual(['orch']);
        expect(harness.attachDockMock).toHaveBeenCalledTimes(1);
        expect(harness.attachDockMock.mock.calls[0][1].source).toBe('orchestrator');

        // Diagnose from dock opens Workbench AI page on orch workspace
        harness.attachDockMock.mock.calls[0][1].onDiagnose('orchestrator:run_fail');
        expect(harness.openWorkbenchMock).toHaveBeenCalledWith(expect.objectContaining({
            page: 'ai',
            ws: 'orch',
            draft: expect.stringContaining('orchestrator:run_fail'),
        }));
    });

    test('source-luker load() invokes getRuntimePresetScope for lazy character card migration', async () => {
        const harness = makeContext({
            characters: [{ avatar: 'alice.png', name: 'Alice', data: { extensions: { orchestrator: {} } } }],
        });
        const scopeSpy = jest.fn(() => 'global');
        const source = createLukerSource({
            getContext: () => harness.ctx,
            getRuntimePresetScope: scopeSpy,
        });

        await source.load();
        expect(scopeSpy).toHaveBeenCalledWith(harness.ctx, 'alice.png', 'spec');
    });

    test('source-luker load() surfaces getPreset and readAnchors failures instead of silent fallback', async () => {
        const harness = makeContext();
        const failingPresetSource = createLukerSource({
            getContext: () => harness.ctx,
            getPreset: () => { throw new Error('corrupt preset'); },
        });
        await expect(failingPresetSource.load()).rejects.toThrow('corrupt preset');

        const failingAnchorSource = createLukerSource({
            getContext: () => harness.ctx,
            getLoadedAnchorMap: () => { throw new Error('anchor storage broken'); },
        });
        await expect(failingAnchorSource.load()).rejects.toThrow('anchor storage broken');
    });

    test('AskProvider and SuggestRuleProvider build snapshot and surface failed/slow run suggestions', async () => {
        const harness = makeContext();
        const ask = createOrchAskProvider(() => harness.ctx, { getSettings: () => harness.ctx.extensionSettings.orchestrator });
        const snap = await ask.getSnapshot(harness.ctx);
        expect(snap.enabled).toBe(true);
        expect(snap.lastRun.runId).toBe('run_fail');
        expect(snap.lastRun.duration).toBe(28000);
        expect(ask.overviewKey).toBe('Orchestration');
        expect(await ask.getOverview(harness.ctx)).toMatchObject({
            Enabled: true,
            Mode: 'spec',
            Scope: 'global',
        });
        const uninstalledAsk = createOrchAskProvider(() => ({ extensionSettings: {} }), {});
        expect(await uninstalledAsk.readers.wb_read_orch({ part: 'summary' })).toEqual({
            error: 'Orchestrator is not installed',
        });

        const suggest = createOrchSuggestRuleProvider();
        const failedRule = suggest.rules.find(r => r.id === 'orch.failedRun');
        const slowRule = suggest.rules.find(r => r.id === 'orch.slowRun');
        expect(failedRule.check({ orch: snap })).toBeTruthy();
        expect(slowRule.check({ orch: snap })).toBeTruthy();
    });
});
