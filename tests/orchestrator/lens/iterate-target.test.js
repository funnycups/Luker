/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import './_mocks/luker-zh.js';
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { clearRegistry } from '../../../public/scripts/iteration-library/storage/target-registry.js';
import {
    runIterateTurn,
    createIterateBus,
    buildTurnChanges,
    commitTurnBatch,
} from '../../../public/scripts/workbench/model/iterate.js';
import { diffUnits } from '../../../public/scripts/workbench/model/units.js';
import { LOREBOOK_READ_TOOL_NAMES } from '../../../public/scripts/iteration-library/tools/lorebook-reads.js';
import { LOREBOOK_WRITE_TOOL_NAMES } from '../../../public/scripts/iteration-library/tools/lorebook-writes.js';
import {
    createOrchIterateTarget,
    orchUnits,
    rebuildOrchProfile,
} from '../../../public/scripts/extensions/orchestrator/lens/iterate-target.js';

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function makeSpecProfile(overrides = {}) {
    return {
        spec: {
            stages: [
                { id: 'distill', mode: 'serial', nodes: [{ id: 'distiller', preset: 'distiller', type: 'worker', userPromptTemplate: 'Analyze {{last_user}}' }] },
                { id: 'finalize', mode: 'serial', nodes: [{ id: 'synthesizer', preset: 'synthesizer', type: 'worker', userPromptTemplate: 'Synthesize' }] },
            ],
            defaultTools: { chat: { read_range: true, search: false } },
            customTools: [],
            skills: { visible: ['*'], deny: [] },
            lorebookFilter: { bookPattern: '', entryPattern: '' },
        },
        presets: {
            distiller: { systemPrompt: 'You are distiller.', userPromptTemplate: 'Analyze {{last_user}}', apiPresetName: '', promptPresetName: '' },
            synthesizer: { systemPrompt: 'You are synthesizer.', userPromptTemplate: 'Synthesize', apiPresetName: '', promptPresetName: '' },
        },
        ...overrides,
    };
}

function makeLoopProfile(overrides = {}) {
    return {
        mode: 'loop',
        system_prompt: 'You are loop researcher.',
        apiPresetName: '',
        promptPresetName: '',
        tools: { chat: { read_range: true, search: true }, finalize: true, custom: {} },
        max_rounds: 6,
        wall_clock_budget_ms: 120000,
        customTools: [],
        skills: { visible: ['*'], deny: [] },
        lorebookFilter: { bookPattern: '', entryPattern: '' },
        ...overrides,
    };
}

function makeHarness({
    mode = 'spec',
    avatar = 'alice.png',
    charName = 'Alice',
    hasCharOverride = false,
    globalProfile = null,
    charProfile = null,
    books = {},
} = {}) {
    const gProf = globalProfile || (mode === 'loop' ? makeLoopProfile() : makeSpecProfile());
    const cProf = charProfile || (hasCharOverride ? clone(gProf) : null);

    const orchSettings = {
        enabled: true,
        executionMode: mode,
        requestApiPresetName: 'my-api',
        requestLlmPresetName: 'my-preset',
        requestSystemPrompt: 'Base iter prompt',
        iterModePromptSpec: 'Spec mode block',
        iterModePromptLoop: 'Loop mode block',
        iterModePromptDirector: 'Director mode block',
        iterModePromptAgenda: 'Agenda mode block',
        activePresetIds: { [mode]: 'default' },
        presetLibraries: {
            [mode]: { default: { name: 'Default', ...clone(gProf) } },
        },
    };

    const characters = avatar ? [{
        avatar,
        name: charName,
        data: {
            extensions: {
                world: Object.keys(books)[0] || '',
                orchestrator: hasCharOverride ? {
                    activePresetIds: { [mode]: 'default' },
                    presetLibraries: { [mode]: { default: { name: 'Default', ...clone(cProf) } } },
                } : {},
            },
        },
    }] : [];

    const skillsDb = new Map();
    const saveSettingsMock = jest.fn(async (_d, opts) => { opts?.onSaved?.(); });
    const writeExtMock = jest.fn(async (idx, key, val) => {
        characters[idx].data.extensions[key] = clone(val);
    });
    const saveWorldInfoMock = jest.fn(async (bookName, data) => {
        books[bookName] = clone(data);
    });

    const ctx = {
        groupId: null,
        characterId: avatar ? 0 : -1,
        characters,
        constants: {
            unset: Symbol.for('unset'),
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        },
        extensionSettings: { orchestrator: orchSettings },
        translate: s => String(s ?? ''),
        getCurrentLocale: () => 'en',
        saveSettings: saveSettingsMock,
        saveSettingsDebounced: jest.fn(),
        writeExtensionField: writeExtMock,
        loadWorldInfo: jest.fn(async (bookName) => (books[bookName] ? clone(books[bookName]) : null)),
        saveWorldInfo: saveWorldInfoMock,
        runPanel: {
            getRunRecorder: () => ({
                history: () => [{
                    runId: 'run_1',
                    source: 'orchestrator',
                    mode,
                    status: 'done',
                    startedAt: 1000,
                    endedAt: 2500,
                    rounds: [],
                }],
                currents: () => [],
            }),
        },
        skills: {
            list: jest.fn(async () => [...skillsDb.values()]),
            get: jest.fn(async ({ name }) => skillsDb.get(name) || null),
            install: jest.fn(async ({ scope, payload }) => {
                const skillMd = payload?.files?.find(f => f.path === 'SKILL.md')?.content || '';
                const m = /^name:\s*(\S+)/m.exec(skillMd);
                const name = m ? m[1] : 'unknown';
                skillsDb.set(name, { name, scope, files: payload?.files || [] });
                return { ok: true, name };
            }),
            readFile: jest.fn(async ({ name }) => ({ content: skillsDb.get(name)?.files?.[0]?.content || '', sha256: 'abc' })),
        },
    };
    const prevGetContext = globalThis.Luker.getContext;
    globalThis.Luker.getContext = () => ({ ...prevGetContext(), ...ctx });

    const deps = {
        getSettings: () => orchSettings,
        getDefaultRequestSystemPrompt: () => 'Default base prompt',
        ITERATION_MODE_PROMPT_DEFAULTS: {
            spec: 'Default spec block',
            loop: 'Default loop block',
            director: 'Default director block',
            agenda: 'Default agenda block',
        },
        getIterationDefaultScope: (c) => (c?.characters?.[c?.characterId]?.avatar ? 'character' : 'global'),
        getRuntimePresetScope: (c, av, m) => (c?.characters?.find(ch => ch.avatar === av)?.data?.extensions?.orchestrator?.activePresetIds?.[m] ? 'character' : 'global'),
        getCharacterActivePresetId: (c, av, m) => c?.characters?.find(ch => ch.avatar === av)?.data?.extensions?.orchestrator?.activePresetIds?.[m] || '',
        getCharacterDisplayNameByAvatar: (c, av) => c?.characters?.find(ch => ch.avatar === av)?.name || av,
        getCharacterExtensionDataByAvatar: (c, av) => c?.characters?.find(ch => ch.avatar === av)?.data?.extensions?.orchestrator || {},
        getCharacterIndexByAvatar: (c, av) => (c?.characters || []).findIndex(ch => ch.avatar === av),
        persistOrchestratorCharacterExtension: async (c, idx, payload) => {
            await c.writeExtensionField(idx, 'orchestrator', payload, { requireSaved: true });
            return true;
        },
        clearCharacterExtensionForMode: (prev, m) => {
            const next = clone(prev || {});
            if (next.presetLibraries) delete next.presetLibraries[m];
            if (next.activePresetIds) delete next.activePresetIds[m];
            return next;
        },
        getActivePreset: (s, m, opts = {}) => {
            const owner = opts.scope === 'character'
                ? opts.context?.characters?.find(ch => ch.avatar === opts.avatar)?.data?.extensions?.orchestrator
                : s;
            const id = owner?.activePresetIds?.[m];
            const entry = id ? owner?.presetLibraries?.[m]?.[id] : null;
            return { ok: true, state: entry ? clone(entry) : null };
        },
        getActivePresetId: (s, m, opts = {}) => {
            const owner = opts.scope === 'character'
                ? opts.context?.characters?.find(ch => ch.avatar === opts.avatar)?.data?.extensions?.orchestrator
                : s;
            return owner?.activePresetIds?.[m] || '';
        },
        writeActivePreset: (s, m, sc, payload, opts = {}) => {
            const owner = sc === 'character'
                ? opts.context?.characters?.find(ch => ch.avatar === opts.avatar)?.data?.extensions?.orchestrator
                : s;
            if (!owner) return { ok: false, reason: 'missing' };
            owner.presetLibraries ||= {};
            owner.presetLibraries[m] ||= {};
            owner.activePresetIds ||= {};
            const id = owner.activePresetIds[m] || 'default';
            owner.activePresetIds[m] = id;
            owner.presetLibraries[m][id] = { name: owner.presetLibraries[m][id]?.name || 'Default', ...clone(payload) };
            return { ok: true, id };
        },
        sanitizeSpec: (sp) => clone(sp || { stages: [] }),
        sanitizePresetMap: (pm) => clone(pm || {}),
        sanitizeLoopProfile: (lp) => ({ ...makeLoopProfile(), ...clone(lp || {}) }),
        sanitizeAgendaWorkingProfile: (ap) => ({ planner: {}, agents: {}, finalAgentId: '', ...clone(ap || {}) }),
        sanitizeDirectorProfile: (dp) => ({ mainAgent: {}, subAgents: [], ...clone(dp || {}) }),
        sanitizePresetEntry: (_m, entry) => clone(entry),
        buildAiIterationToolSet: (session) => {
            const m = session?.mode || mode;
            return [
                { type: 'function', function: { name: `luker_orch_read_${m}_fields`, description: 'read fields', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } } },
                { type: 'function', function: { name: 'luker_orch_set_preset', description: 'set preset', parameters: { type: 'object', properties: { preset_id: { type: 'string' }, systemPrompt: { type: 'string' } }, required: ['preset_id'] } } },
                { type: 'function', function: { name: 'luker_orch_set_loop_profile', description: 'set loop', parameters: { type: 'object', properties: { system_prompt: { type: 'string' }, max_rounds: { type: 'integer' } } } } },
                { type: 'function', function: { name: 'luker_orch_simulate', description: 'simulate', parameters: { type: 'object', properties: {} } } },
            ];
        },
        buildAiIterationSystemPrompt: (_s, session) => `System for ${session?.mode || mode}`,
        executeAiIterationToolCalls: async (_c, session, calls) => {
            const toolResults = [];
            for (const call of calls) {
                if (call.name === 'luker_orch_set_preset') {
                    const id = String(call.args?.preset_id || '');
                    if (!session.workingProfile.presets?.[id]) {
                        toolResults.push({ tool_call_id: call.id, content: JSON.stringify({ ok: false, error: 'not_found', detail: `Preset ${id} not found` }) });
                        continue;
                    }
                    session.workingProfile.presets[id].systemPrompt = String(call.args.systemPrompt ?? '');
                    toolResults.push({ tool_call_id: call.id, content: JSON.stringify({ ok: true, changed: true }) });
                } else if (call.name === 'luker_orch_set_loop_profile') {
                    if (call.args?.system_prompt !== undefined) session.workingProfile.system_prompt = String(call.args.system_prompt);
                    if (call.args?.max_rounds !== undefined) session.workingProfile.max_rounds = Number(call.args.max_rounds);
                    toolResults.push({ tool_call_id: call.id, content: JSON.stringify({ ok: true, changed: true }) });
                } else if (call.name === 'luker_orch_simulate') {
                    toolResults.push({ tool_call_id: call.id, content: JSON.stringify({ ok: true, simulation: { summary: 'sim ok' } }) });
                }
            }
            return { toolResults, actions: [], simulations: [] };
        },
    };

    const target = createOrchIterateTarget(() => ctx, deps);
    return { ctx, deps, target, orchSettings, characters, books, skillsDb, saveSettingsMock, writeExtMock, saveWorldInfoMock };
}

beforeEach(() => {
    clearRegistry();
});

afterEach(() => {
    clearRegistry();
});

describe('orchestrator/lens/iterate-target.js', () => {
    test('registers id=orch, supports global & character scopes, and exposes native AI / promptInfo', async () => {
        const { ctx, target } = makeHarness();
        expect(target.id).toBe('orch');
        expect(target.tone).toBe('orch');
        expect(await target.scopes(ctx)).toEqual({ global: true, character: true });
        expect(target.getNativeAi(ctx)).toEqual({ connection: 'my-api', preset: 'my-preset' });
        const info = await target.promptInfo(ctx);
        expect(info.custom).toBe(true);
        expect(info.text).toContain('Spec mode block');
    });

    test('character scope exposes lorebook writes and reset tools gated by hasOverride; global omits them', async () => {
        const gHarness = makeHarness({ hasCharOverride: false });
        const gTools = (await gHarness.target.tools(makeSpecProfile(), 'global', gHarness.ctx)).map(t => t.function.name);
        expect(gTools).toContain(LOREBOOK_READ_TOOL_NAMES[0]);
        expect(gTools).toContain('inspect_bound_preset');
        expect(gTools).not.toContain(LOREBOOK_WRITE_TOOL_NAMES[0]);
        expect(gTools).not.toContain('luker_orch_reset_live_to_blank');
        expect(gTools).not.toContain('luker_orch_reset_live_to_global');

        const cNoOverride = makeHarness({ hasCharOverride: false });
        const cToolsNo = (await cNoOverride.target.tools(makeSpecProfile(), 'character', cNoOverride.ctx)).map(t => t.function.name);
        expect(cToolsNo).toContain(LOREBOOK_WRITE_TOOL_NAMES[0]);
        expect(cToolsNo).toContain('luker_orch_reset_live_to_blank');
        expect(cToolsNo).not.toContain('luker_orch_reset_live_to_global');

        const cWithOverride = makeHarness({ hasCharOverride: true });
        const cToolsYes = (await cWithOverride.target.tools(makeSpecProfile(), 'character', cWithOverride.ctx)).map(t => t.function.name);
        expect(cToolsYes).toContain('luker_orch_reset_live_to_blank');
        expect(cToolsYes).toContain('luker_orch_reset_live_to_global');
    });

    test('runs unbounded tool-call loop (> 8 rounds) and commits profile edits + undo cleanly', async () => {
        const { ctx, target, orchSettings } = makeHarness({ mode: 'spec' });
        const loaded = await target.load('global', ctx);
        const tools = await target.tools(loaded.live, 'global', ctx);

        let round = 0;
        const result = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'tune distiller' }],
            live: loaded.live,
            tools,
            isRead: target.isRead,
            runRead: target.runRead,
            runEdit: target.runEdit,
            proposalKinds: target.proposalKinds,
            request: async () => {
                round++;
                if (round <= 10) {
                    return {
                        text: '',
                        calls: [{ id: `c${round}`, name: 'luker_orch_read_spec_fields', args: { paths: ['presets.distiller.systemPrompt'] } }],
                    };
                }
                if (round === 11) {
                    return {
                        text: '',
                        calls: [{ id: 'c11', name: 'luker_orch_set_preset', args: { preset_id: 'distiller', systemPrompt: 'Updated distiller prompt' } }],
                    };
                }
                return { text: 'Updated.', calls: [] };
            },
        });

        expect(round).toBe(12);
        expect(result.reads).toHaveLength(10);
        expect(result.edits).toHaveLength(1);

        const changes = buildTurnChanges({ base: loaded.live, ai: result.live, units: target.units, bus: result.bus, proposalIds: result.proposalIds, kindAdapters: target.proposalKinds });
        expect(changes.some(c => c.key === 'preset:distiller')).toBe(true);

        const handle = await commitTurnBatch({
            target,
            targetRef: loaded.target,
            base: loaded.live,
            ai: result.live,
            keys: changes.map(c => c.key),
            bus: result.bus,
            proposalIds: result.proposalIds,
            kindAdapters: target.proposalKinds,
        });

        expect(orchSettings.presetLibraries.spec.default.presets.distiller.systemPrompt).toBe('Updated distiller prompt');
        await handle.undo();
        expect(orchSettings.presetLibraries.spec.default.presets.distiller.systemPrompt).toBe('You are distiller.');
    });

    test('supports custom-tool compile error feedback, dry-run, and ProposalBus commit', async () => {
        const { ctx, target, orchSettings } = makeHarness({ mode: 'loop' });
        const loaded = await target.load('global', ctx);
        const tools = await target.tools(loaded.live, 'global', ctx);
        const bus = createIterateBus({ proposalKinds: target.proposalKinds });

        let round = 0;
        const result = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'add helper tool' }],
            live: loaded.live,
            tools,
            bus,
            isRead: target.isRead,
            runRead: target.runRead,
            runEdit: target.runEdit,
            request: async () => {
                round++;
                if (round === 1) {
                    return {
                        text: '',
                        calls: [{
                            id: 'bad_syntax',
                            name: 'luker_orch_set_custom_tool',
                            args: { name: 'my_helper', description: 'desc', mode: 'read', parameters: { type: 'object' }, body: 'return (((' },
                        }],
                    };
                }
                if (round === 2) {
                    return {
                        text: '',
                        calls: [{
                            id: 'dry',
                            name: 'luker_orch_dry_run_custom_tool',
                            args: { body: 'return { echoed: args.x };', args: { x: 42 } },
                        }],
                    };
                }
                if (round === 3) {
                    return {
                        text: '',
                        calls: [{
                            id: 'good_set',
                            name: 'luker_orch_set_custom_tool',
                            args: { name: 'my_helper', description: 'echo tool', mode: 'read', parameters: { type: 'object' }, body: 'return { echoed: args.x };' },
                        }],
                    };
                }
                return { text: 'Proposed custom tool.', calls: [] };
            },
        });

        expect(result.failed).toHaveLength(1);
        expect(result.reads).toHaveLength(1);
        expect(result.toolCalls.find(c => c.id === 'dry').result.dryRun.result).toEqual({ echoed: 42 });
        expect(result.proposalIds).toHaveLength(1);

        const changes = buildTurnChanges({ base: loaded.live, ai: result.live, units: target.units, bus: result.bus, proposalIds: result.proposalIds, kindAdapters: target.proposalKinds });
        expect(changes.some(c => c.proposalKind === 'custom-tool-author')).toBe(true);

        await commitTurnBatch({
            target,
            targetRef: loaded.target,
            base: loaded.live,
            ai: result.live,
            keys: changes.map(c => c.key),
            bus: result.bus,
            proposalIds: result.proposalIds,
            kindAdapters: target.proposalKinds,
        });

        expect(orchSettings.presetLibraries.loop.default.customTools.some(t => t.name === 'my_helper')).toBe(true);
    });

    test('custom-tool-author in spec mode reads, dry-runs, patches, and commits to profile.spec.customTools', async () => {
        const existingSpecTool = {
            name: 'existing_spec_tool',
            displayName: 'Existing',
            description: 'Reads note',
            mode: 'read',
            parameters: { type: 'object', properties: {} },
            body: 'return { v: 1 };',
            simulateBody: '',
        };
        const gSpec = makeSpecProfile();
        gSpec.spec.customTools = [existingSpecTool];
        const { ctx, target, orchSettings } = makeHarness({ mode: 'spec', globalProfile: gSpec });
        const loaded = await target.load('global', ctx);
        const tools = await target.tools(loaded.live, 'global', ctx);
        const bus = createIterateBus({ proposalKinds: target.proposalKinds });

        let round = 0;
        const result = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'inspect and patch spec custom tools' }],
            live: loaded.live,
            tools,
            bus,
            isRead: target.isRead,
            runRead: target.runRead,
            runEdit: target.runEdit,
            request: async () => {
                round++;
                if (round === 1) {
                    return {
                        text: '',
                        calls: [
                            { id: 'ls', name: 'luker_orch_list_custom_tools', args: {} },
                            { id: 'gt', name: 'luker_orch_get_custom_tool', args: { name: 'existing_spec_tool' } },
                            { id: 'dr', name: 'luker_orch_dry_run_custom_tool', args: { name: 'existing_spec_tool', args: {} } },
                            {
                                id: 'pb',
                                name: 'luker_orch_patch_custom_tool_body',
                                args: { name: 'existing_spec_tool', oldString: 'v: 1', newString: 'v: 2' },
                            },
                            {
                                id: 'add',
                                name: 'luker_orch_set_custom_tool',
                                args: {
                                    name: 'spec_helper',
                                    description: 'Spec helper',
                                    mode: 'read',
                                    parameters: { type: 'object', properties: {} },
                                    body: 'return { spec: true };',
                                },
                            },
                        ],
                    };
                }
                return { text: 'Updated spec custom tools.', calls: [] };
            },
        });

        expect(result.failed).toEqual([]);
        const listCall = result.toolCalls.find(c => c.id === 'ls');
        expect(listCall.result.count).toBe(1);
        expect(listCall.result.tools[0].name).toBe('existing_spec_tool');
        expect(result.toolCalls.find(c => c.id === 'gt').result.body).toBe('return { v: 1 };');
        expect(result.toolCalls.find(c => c.id === 'dr').result.dryRun.result).toEqual({ v: 1 });

        const changes = buildTurnChanges({ base: loaded.live, ai: result.live, units: target.units, bus: result.bus, proposalIds: result.proposalIds, kindAdapters: target.proposalKinds });
        await commitTurnBatch({
            target,
            targetRef: loaded.target,
            base: loaded.live,
            ai: result.live,
            keys: changes.map(c => c.key),
            bus: result.bus,
            proposalIds: result.proposalIds,
            kindAdapters: target.proposalKinds,
        });

        const savedSpec = orchSettings.presetLibraries.spec.default.spec;
        expect(savedSpec.customTools.find(t => t.name === 'existing_spec_tool')?.body).toBe('return { v: 2 };');
        expect(savedSpec.customTools.find(t => t.name === 'spec_helper')?.body).toBe('return { spec: true };');
        expect(savedSpec.defaultTools?.custom?.spec_helper).toBe(true);
        expect(orchSettings.presetLibraries.spec.default.customTools).toBeUndefined();
    });

    test('custom-tool-author in character scope without an existing override preserves seeded global profile fields', async () => {
        const gLoop = makeLoopProfile({
            system_prompt: 'Seeded global loop prompt',
            max_rounds: 9,
            wall_clock_budget_ms: 90000,
        });
        const { ctx, target } = makeHarness({ mode: 'loop', hasCharOverride: false, globalProfile: gLoop });
        const loaded = await target.load('character', ctx);
        const tools = await target.tools(loaded.live, 'character', ctx);
        const bus = createIterateBus({ proposalKinds: target.proposalKinds });

        let round = 0;
        const result = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'add char custom tool' }],
            live: loaded.live,
            tools,
            bus,
            isRead: target.isRead,
            runRead: target.runRead,
            runEdit: target.runEdit,
            request: async () => {
                round++;
                if (round === 1) {
                    return {
                        text: '',
                        calls: [{
                            id: 'ct1',
                            name: 'luker_orch_set_custom_tool',
                            args: {
                                name: 'char_helper',
                                description: 'Character helper',
                                mode: 'read',
                                parameters: { type: 'object', properties: {} },
                                body: 'return { ok: true };',
                            },
                        }],
                    };
                }
                return { text: 'Staged character custom tool.', calls: [] };
            },
        });

        expect(result.failed).toEqual([]);
        const changes = buildTurnChanges({ base: loaded.live, ai: result.live, units: target.units, bus: result.bus, proposalIds: result.proposalIds, kindAdapters: target.proposalKinds });
        await commitTurnBatch({
            target,
            targetRef: loaded.target,
            base: loaded.live,
            ai: result.live,
            keys: changes.map(c => c.key),
            bus: result.bus,
            proposalIds: result.proposalIds,
            kindAdapters: target.proposalKinds,
        });

        const savedChar = ctx.characters[0].data.extensions.orchestrator.presetLibraries.loop.default;
        expect(savedChar.customTools.some(t => t.name === 'char_helper')).toBe(true);
        expect(savedChar.system_prompt).toBe('Seeded global loop prompt');
        expect(savedChar.max_rounds).toBe(9);
        expect(savedChar.wall_clock_budget_ms).toBe(90000);
    });

    test('supports skill-author and lorebook-write proposals in character scope', async () => {
        const books = {
            AliceBook: { entries: { 1: { uid: 1, comment: 'Format Rule', content: 'Always use <thinking> tags.', disable: false } } },
        };
        const { ctx, target, skillsDb, saveWorldInfoMock } = makeHarness({ mode: 'spec', hasCharOverride: true, books });
        const loaded = await target.load('character', ctx);
        const tools = await target.tools(loaded.live, 'character', ctx);
        const bus = createIterateBus({ proposalKinds: target.proposalKinds });

        let round = 0;
        const result = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'create skill and fix lorebook' }],
            live: loaded.live,
            tools,
            bus,
            isRead: target.isRead,
            runRead: target.runRead,
            runEdit: target.runEdit,
            request: async () => {
                round++;
                if (round === 1) {
                    return {
                        text: '',
                        calls: [
                            { id: 'sk1', name: 'skill_create', args: { name: 'voice-guide', description: 'Voice rules', body: 'Keep tone sharp.' } },
                            { id: 'lb1', name: 'lorebook_update_entry', args: { book_name: 'AliceBook', uid: 1, patch: { disable: true } } },
                        ],
                    };
                }
                return { text: 'Proposed skill and lorebook update.', calls: [] };
            },
        });

        expect(result.failed).toEqual([]);
        expect(result.proposalIds).toHaveLength(2);
        const changes = buildTurnChanges({ base: loaded.live, ai: result.live, units: target.units, bus: result.bus, proposalIds: result.proposalIds, kindAdapters: target.proposalKinds });
        expect(changes.map(c => c.proposalKind).sort()).toEqual(['lorebook-write', 'skill-author']);

        await commitTurnBatch({
            target,
            targetRef: loaded.target,
            base: loaded.live,
            ai: result.live,
            keys: changes.map(c => c.key),
            bus: result.bus,
            proposalIds: result.proposalIds,
            kindAdapters: target.proposalKinds,
        });

        expect(skillsDb.has('voice-guide')).toBe(true);
        expect(saveWorldInfoMock).toHaveBeenCalled();
        expect(books.AliceBook.entries[1].disable).toBe(true);
    });

    test('reset_to_blank and reset_to_global enforce character scope and override presence', async () => {
        const gHarness = makeHarness({ mode: 'spec', hasCharOverride: false });
        await gHarness.target.load('global', gHarness.ctx);
        await expect(gHarness.target.runEdit({ id: 'r1', name: 'luker_orch_reset_live_to_blank', args: {} }, makeSpecProfile())).rejects.toThrow(/not_allowed/i);

        const cNoOverride = makeHarness({ mode: 'spec', hasCharOverride: false });
        const loadedNo = await cNoOverride.target.load('character', cNoOverride.ctx);
        const blank = await cNoOverride.target.runEdit({ id: 'r2', name: 'luker_orch_reset_live_to_blank', args: {} }, loadedNo.live);
        expect(blank.spec.stages).toEqual([]);
        await expect(cNoOverride.target.runEdit({ id: 'r3', name: 'luker_orch_reset_live_to_global', args: {} }, loadedNo.live)).rejects.toThrow(/not_allowed/i);

        const cWithOverride = makeHarness({
            mode: 'spec',
            hasCharOverride: true,
            charProfile: makeSpecProfile({ presets: { distiller: { systemPrompt: 'Custom char prompt', userPromptTemplate: '', apiPresetName: '', promptPresetName: '' }, synthesizer: { systemPrompt: 'S', userPromptTemplate: '', apiPresetName: '', promptPresetName: '' } } }),
        });
        const loadedYes = await cWithOverride.target.load('character', cWithOverride.ctx);
        const resetGlobal = await cWithOverride.target.runEdit({ id: 'r4', name: 'luker_orch_reset_live_to_global', args: {} }, loadedYes.live);
        expect(resetGlobal.presets.distiller.systemPrompt).toBe('You are distiller.');
    });

    test('orchUnits + rebuildOrchProfile + renderPreview work cleanly', () => {
        const base = makeSpecProfile();
        const ai = makeSpecProfile();
        ai.presets.distiller.systemPrompt = 'Changed';
        const diff = diffUnits(orchUnits(base, 'spec'), orchUnits(ai, 'spec'));
        expect(diff.map(d => d.key)).toEqual(['preset:distiller']);

        const rebuilt = rebuildOrchProfile(base, ai, ['preset:distiller'], 'spec');
        expect(rebuilt.presets.distiller.systemPrompt).toBe('Changed');

        const { target } = makeHarness({ mode: 'spec' });
        const preview = target.renderPreview({ base, ai, target: { mode: 'spec' } });
        expect(preview).toBeInstanceOf(Node);
        expect(preview.textContent).toContain('distill');
    });

    test('surfaces reset-global and reset-blank errors via onError/toastr instead of unhandled rejections', async () => {
        const { ctx, deps } = makeHarness({ mode: 'spec', hasCharOverride: true });
        const onError = jest.fn();
        const toastrError = jest.fn();
        globalThis.toastr = { error: toastrError };
        deps.persistOrchestratorCharacterExtension = jest.fn(async () => false);
        const target = createOrchIterateTarget(() => ctx, { ...deps, onError });
        const loaded = await target.load('character', ctx);

        const controls = target.renderControls({
            live: loaded.live,
            scope: 'character',
            settings: {},
            onReload: async () => { throw new Error('orch reload failed'); },
        });
        const blankBtn = controls.querySelector('[data-wb-orch-control="reset-blank"]');
        const globalBtn = controls.querySelector('[data-wb-orch-control="reset-global"]');

        blankBtn.click();
        await new Promise(r => setTimeout(r, 0));
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('orch reload failed'));

        onError.mockClear();
        globalBtn.click();
        await new Promise(r => setTimeout(r, 0));
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('Failed to persist character override.'));

        // Without deps.onError, falls back to toastr.error
        const targetToast = createOrchIterateTarget(() => ctx, deps);
        const controlsToast = targetToast.renderControls({ live: loaded.live, scope: 'character', settings: {}, onReload: jest.fn() });
        controlsToast.querySelector('[data-wb-orch-control="reset-global"]').click();
        await new Promise(r => setTimeout(r, 0));
        expect(toastrError).toHaveBeenCalled();
    });

    test('isolates mode/scope/hasOverride metadata per loaded target across concurrent load() calls and cloned live docs', async () => {
        const gSpec = makeSpecProfile();
        const cSpec = makeSpecProfile({
            presets: {
                distiller: { systemPrompt: 'Char custom distiller', userPromptTemplate: '', apiPresetName: '', promptPresetName: '' },
                synthesizer: { systemPrompt: 'S', userPromptTemplate: '', apiPresetName: '', promptPresetName: '' },
            },
        });
        const h = makeHarness({ mode: 'spec', hasCharOverride: true, globalProfile: gSpec, charProfile: cSpec });
        h.orchSettings.presetLibraries.loop = { default: { name: 'Default', ...makeLoopProfile() } };
        h.orchSettings.activePresetIds.loop = 'default';

        const charLoaded = await h.target.load('character', h.ctx);

        // Background switch to global loop mode + load/tools
        h.orchSettings.executionMode = 'loop';
        const globalLoaded = await h.target.load('global', h.ctx);
        await h.target.tools(globalLoaded.live, 'global', h.ctx);

        // Earlier spec/character session must NOT have its mode/scope/hasOverride clobbered (via WeakMap on loaded.live)
        const readRes = await h.target.runRead({
            id: 'r1',
            name: 'luker_orch_read_spec_fields',
            args: { paths: ['presets.distiller.systemPrompt'] },
        }, charLoaded.live);
        expect(readRes['presets.distiller.systemPrompt']).toBe('Char custom distiller');

        const resetGlobal = await h.target.runEdit({ id: 'rg1', name: 'luker_orch_reset_live_to_global', args: {} }, charLoaded.live);
        expect(resetGlobal.presets.distiller.systemPrompt).toBe('You are distiller.');

        expect([...h.target.units(charLoaded.live).keys()]).toContain('preset:distiller');
        const rebuilt = h.target.rebuild(charLoaded.live, resetGlobal, ['preset:distiller']);
        expect(rebuilt.presets.distiller.systemPrompt).toBe('You are distiller.');

        // Also works when live is JSON-cloned (as workbench/pages/iterate.js does) and targetRef is passed
        const clonedChar = clone(charLoaded.live);
        const clonedTools = (await h.target.tools(clonedChar, 'character', h.ctx, { target: charLoaded.target })).map(t => t.function.name);
        expect(clonedTools).toContain('luker_orch_reset_live_to_global');
        const resetViaTarget = await h.target.runEdit(
            { id: 'rg2', name: 'luker_orch_reset_live_to_global', args: {} },
            clonedChar,
            { target: charLoaded.target },
        );
        expect(resetViaTarget.presets.distiller.systemPrompt).toBe('You are distiller.');
        expect([...h.target.units(clonedChar, charLoaded.target).keys()]).toContain('preset:distiller');
        const rebuiltViaTarget = h.target.rebuild(clonedChar, resetViaTarget, ['preset:distiller'], charLoaded.target);
        expect(rebuiltViaTarget.presets.distiller.systemPrompt).toBe('You are distiller.');
    });
});
