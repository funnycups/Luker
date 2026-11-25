import { describe, test, expect, beforeAll, jest } from '@jest/globals';

// Spec preset keys, stage ids and node ids outside `[A-Za-z0-9_-]` (CJK,
// spaces) are stored verbatim by pure editor/tool/reference transforms.
// Real character/global persistence and rollback are covered in iterstudio/98.

const skillsApi = { list: jest.fn(async () => []) };
globalThis.Luker = {
    getContext: () => ({
        skills: skillsApi,
        translate: (s) => String(s ?? ''),
        saveSettings: async () => {},
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
            unset: Symbol('unset'),
        },
        lib: {
            yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
        },
    }),
};

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash, yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) } };
});
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: {},
    getContext: () => ({}),
    writeExtensionField: async () => {},
    UNSET_VALUE: Symbol('unset'),
}));
jest.unstable_mockModule('../../public/script.js', () => ({
    saveSettingsDebounced: () => {},
    saveSettings: async () => {},
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1 },
    substituteParams: (s) => s,
    chat_metadata: {},
    this_chid: 0,
    characters: [],
    getRequestHeaders: () => ({}),
    saveCharacterDebounced: () => {},
    menu_type: '',
    eventSource: { on: () => {}, off: () => {}, emit: () => {} },
    event_types: {},
    getExtensionPromptByName: () => '',
    saveMetadata: async () => {},
    getCurrentChatId: () => '',
    create_save: {},
    name1: '',
    buildObjectPatchOperations: () => [],
    buildObjectPatchOperationsAsync: async () => [],
    requestAsyncDiffForNextSettingsSave: () => {},
    getOneCharacter: () => null,
    select_selected_character: () => {},
    user_avatar: '',
    processDroppedFiles: () => {},
}));
jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_info_position: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
    wi_anchor_position: {},
}));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({}));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {},
    translate: (s) => String(s ?? ''),
    t: (s) => String(s ?? ''),
}));

let getActivePreset;
let createIterationEditorFromWorkingProfile;
let sanitizePresetMap;
let createSpecStructureToolExecutor;
let executeAgendaAgentTool;

describe('iteration missing-id error codes', () => {
    test.each(['luker_orch_set_agenda_agent', 'luker_orch_remove_agenda_agent', 'luker_orch_set_agenda_final_agent', 'luker_orch_set_agenda_agent_tools', 'luker_orch_clear_agenda_agent_tools'])('%s reports invalid_args without changing state', name => {
        const session = { workingProfile: { agents: {} } };
        const results = [];
        expect(executeAgendaAgentTool(session, name, {}, { actions: [], pushToolResult: result => results.push(result) })).toBe(false);
        expect(results[0]).toMatchObject({ ok: false, error: 'invalid_args', action: expect.any(String) });
        expect(session.workingProfile).toEqual({ agents: {} });
    });
    test.each(['luker_orch_remove_agenda_agent', 'luker_orch_set_agenda_agent_tools', 'luker_orch_clear_agenda_agent_tools'])('%s reports not_found for an absent agent', name => {
        const results = [];
        executeAgendaAgentTool({ workingProfile: { agents: {} } }, name, { agent_id: 'absent' }, { actions: [], pushToolResult: result => results.push(result) });
        expect(results[0]).toMatchObject({ ok: false, error: 'not_found', action: expect.any(String) });
    });
});

beforeAll(async () => {
    ({ getActivePreset } = await import('../../public/scripts/extensions/orchestrator/preset-library.js'));
    ({ createIterationEditorFromWorkingProfile, sanitizePresetMap } = await import('../../public/scripts/extensions/orchestrator/editable-spec.js'));
    ({ createSpecStructureToolExecutor } = await import('../../public/scripts/extensions/orchestrator/iter-studio/spec-structure-tools.js'));
    ({ executeAgendaAgentTool } = await import('../../public/scripts/extensions/orchestrator/iter-studio/agenda-agent-tools.js'));
});

const LOOKOUT = '瞭望 员';
const LOOKOUT_BARE = '瞭望';
const NIGHT = '守夜';
const STAGE = '守望 阶段';
const LOOKOUT_NODE = '瞭望 节点';
const MODES = { SPEC: 'spec', LOOP: 'loop', AGENDA: 'agenda', DIRECTOR: 'director' };

function storedProfile() {
    return {
        name: 'Watch',
        spec: {
            stages: [{
                id: STAGE,
                mode: 'serial',
                nodes: [
                    { id: LOOKOUT_NODE, preset: LOOKOUT },
                    { id: NIGHT, preset: NIGHT, tools: { lorebook: { search: true } } },
                ],
            }],
        },
        presets: {
            [LOOKOUT]: { systemPrompt: 'Keep the lookout log.', userPromptTemplate: 'Next bell.' },
            [LOOKOUT_BARE]: { systemPrompt: 'Spare lookout.', userPromptTemplate: 'Spare bell.' },
            [NIGHT]: { systemPrompt: 'Keep the night watch.', userPromptTemplate: 'Next watch.' },
        },
    };
}

function globalSettings() {
    return {
        presetLibraries: { spec: { watch: storedProfile() }, agenda: {}, loop: {}, director: {} },
        activePresetIds: { spec: 'watch', agenda: '', loop: '', director: '' },
    };
}

function readGlobal(settings) {
    return getActivePreset(settings, MODES.SPEC, { scope: 'global' }).state;
}

describe('read path keeps non-slug ids verbatim', () => {
    test('active preset read keeps stage ids, node ids, node refs and preset keys as stored', () => {
        const state = readGlobal(globalSettings());
        expect(Object.keys(state.presets)).toEqual([LOOKOUT, LOOKOUT_BARE, NIGHT]);
        expect(state.spec.stages[0].id).toBe(STAGE);
        expect(state.spec.stages[0].nodes.map(n => [n.id, n.preset])).toEqual([[LOOKOUT_NODE, LOOKOUT], [NIGHT, NIGHT]]);
    });

    test('ids that differ only in non-slug characters stay distinct', () => {
        const map = sanitizePresetMap({ '瞭望': { systemPrompt: 'a' }, '守夜': { systemPrompt: 'b' }, 'a b': { systemPrompt: 'c' }, 'a_b': { systemPrompt: 'd' } });
        expect(Object.keys(map)).toEqual(['瞭望', '守夜', 'a b', 'a_b']);
        expect(Object.values(map).map(p => p.systemPrompt)).toEqual(['a', 'b', 'c', 'd']);
    });
});

describe('spec iteration edit tools address non-slug ids as stored', () => {
    function runTools(calls) {
        const session = { mode: MODES.SPEC, workingProfile: readGlobal(globalSettings()) };
        const actions = [];
        const toolResults = [];
        const executor = createSpecStructureToolExecutor(session, { actions, toolResults });
        const results = [];
        for (const { name, args } of calls) {
            executor.execute(name, args, (payload) => {
                results.push(payload);
                toolResults.push({ tool_call_id: name, content: JSON.stringify(payload) });
            });
        }
        executor.finalize();
        return { profile: session.workingProfile, results, toolResults };
    }

    test('set_preset edits the original preset instead of creating a slug sibling', () => {
        const { profile, results } = runTools([{ name: 'luker_orch_set_preset', args: { preset_id: LOOKOUT, systemPrompt: 'Log every bell.', userPromptTemplate: 'Bell.' } }]);
        expect(results[0]).toMatchObject({ ok: true, preset_id: LOOKOUT });
        expect(Object.keys(profile.presets)).toEqual([LOOKOUT, LOOKOUT_BARE, NIGHT]);
        expect(profile.presets[LOOKOUT].systemPrompt).toBe('Log every bell.');
    });

    test('remove_preset removes an unreferenced non-slug preset and keeps a referenced one', () => {
        const { profile, toolResults } = runTools([
            { name: 'luker_orch_remove_preset', args: { preset_id: LOOKOUT_BARE } },
            { name: 'luker_orch_remove_preset', args: { preset_id: LOOKOUT } },
        ]);
        expect(Object.keys(profile.presets)).toEqual([LOOKOUT, NIGHT]);
        expect(JSON.parse(toolResults[0].content)).toMatchObject({ ok: true, action: `Preset "${LOOKOUT_BARE}" removed.` });
        expect(JSON.parse(toolResults[1].content)).toMatchObject({ ok: false, error: `Skipped preset removal: "${LOOKOUT}" is still used by nodes.` });
    });

    test('set_stage and set_node edit the existing stage and node', () => {
        const { profile, results } = runTools([
            { name: 'luker_orch_set_stage', args: { stage_id: STAGE, mode: 'parallel' } },
            { name: 'luker_orch_set_node', args: { stage_id: STAGE, node_id: LOOKOUT_NODE, preset: NIGHT } },
        ]);
        expect(results.every(r => r.ok)).toBe(true);
        expect(profile.spec.stages.map(s => [s.id, s.mode])).toEqual([[STAGE, 'parallel']]);
        expect(profile.spec.stages[0].nodes.map(n => [n.id, n.preset])).toEqual([[LOOKOUT_NODE, NIGHT], [NIGHT, NIGHT]]);
        expect(Object.keys(profile.presets)).toEqual([LOOKOUT, LOOKOUT_BARE, NIGHT]);
    });

    test('node tools find the non-slug node', () => {
        const { profile, results } = runTools([
            { name: 'luker_orch_set_spec_node_tools', args: { stage_id: STAGE, node_id: LOOKOUT_NODE, tools: { lorebook: { search: true } } } },
            { name: 'luker_orch_clear_spec_node_tools', args: { stage_id: STAGE, node_id: NIGHT } },
        ]);
        expect(results.map(r => r.ok)).toEqual([true, true]);
        expect(results[1].changed).toBe(true);
        const [lookout, night] = profile.spec.stages[0].nodes;
        expect(lookout.tools.lorebook.search).toBe(true);
        expect(night.tools).toBeNull();
    });

    test('remove_node and remove_stage remove the non-slug entries', () => {
        const { profile, results } = runTools([
            { name: 'luker_orch_set_stage', args: { stage_id: '收尾 阶段' } },
            { name: 'luker_orch_set_node', args: { stage_id: '收尾 阶段', node_id: '收尾', preset: NIGHT } },
            { name: 'luker_orch_remove_node', args: { stage_id: STAGE, node_id: LOOKOUT_NODE } },
            { name: 'luker_orch_remove_stage', args: { stage_id: '收尾 阶段' } },
        ]);
        expect(results.map(r => r.ok)).toEqual([true, true, true, true]);
        expect(profile.spec.stages.map(s => s.id)).toEqual([STAGE]);
        expect(profile.spec.stages[0].nodes.map(n => n.id)).toEqual([NIGHT]);
    });
});

describe('runtime id lookups match non-slug ids', () => {
    test('review rerun targets resolve a non-slug prior worker node', async () => {
        const { extractReviewDecision, resolveReviewTargetEntries } = await import('../../public/scripts/extensions/orchestrator/spec-runtime.js');
        const stages = [{ id: STAGE, nodes: [{ id: LOOKOUT_NODE, preset: LOOKOUT }, { id: '复核', preset: NIGHT, type: 'review' }] }];
        const decision = extractReviewDecision([{ name: 'luker_orch_request_rerun', args: { target_node_ids: [` ${LOOKOUT_NODE} `], review_feedback: 'Tighten the log.' } }], '复核');
        expect(decision.targetNodeIds).toEqual([LOOKOUT_NODE]);
        const [entry] = resolveReviewTargetEntries(stages, 0, 1, decision.targetNodeIds);
        expect(entry).toMatchObject({ nodeId: LOOKOUT_NODE, preset: LOOKOUT });
    });

    test('agenda dispatch reaches a non-slug agent and keeps distinct todo ids apart', async () => {
        const { applyAgendaPlannerOps, normalizeAgendaDispatches } = await import('../../public/scripts/extensions/orchestrator/agenda-runtime.js');
        const state = { todos: [], runs: [] };
        applyAgendaPlannerOps(state, { todo_ops: [{ op: 'add', todo_id: '巡夜', goal: 'Walk the wall.' }, { op: 'add', todo_id: '守灯', goal: 'Tend the lamp.' }] });
        expect(state.todos.map(t => t.id)).toEqual(['巡夜', '守灯']);
        const profile = { agents: { [LOOKOUT]: { systemPrompt: 'x' }, [NIGHT]: { systemPrompt: 'y' } } };
        const dispatches = normalizeAgendaDispatches(state, { dispatches: [{ todo_id: '巡夜', agent: LOOKOUT, task_brief: 'Walk the wall.' }] }, profile, {});
        expect(dispatches.map(d => [d.todoId, d.agent])).toEqual([['巡夜', LOOKOUT]]);
    });
});

describe('read path relinks node refs that v2.8.0 left dangling', () => {
    // v2.8.0 "apply to global" stored preset keys through its slug
    // transform (trim, whitespace → `_`, `[^a-zA-Z0-9_-]` → `_`) and kept
    // node refs raw. This entry is that literal shape.
    function v280Settings() {
        const profile = {
            name: 'Legacy',
            spec: {
                stages: [{
                    id: 'watch',
                    mode: 'serial',
                    nodes: [
                        { id: 'lookout', preset: 'Lookout 甲' },
                        { id: 'first', preset: '瞭望' },
                        { id: 'second', preset: '守夜' },
                        { id: 'night', preset: 'Night 乙' },
                        { id: 'night_direct', preset: 'Night__' },
                    ],
                }],
            },
            presets: {
                'Lookout__': { systemPrompt: 'Keep the lookout log.' },
                '__': { systemPrompt: 'Merged watch.' },
                'Night__': { systemPrompt: 'Keep the night watch.' },
            },
        };
        return {
            presetLibraries: { spec: { legacy: profile }, agenda: {}, loop: {}, director: {} },
            activePresetIds: { spec: 'legacy', agenda: '', loop: '', director: '' },
        };
    }

    function refs(state) {
        return Object.fromEntries(state.spec.stages[0].nodes.map(n => [n.id, n.preset]));
    }

    test('a dangling ref whose v2.8.0 slug is a key is relinked to it', () => {
        const state = readGlobal(v280Settings());
        expect(refs(state).lookout).toBe('Lookout__');
        expect(state.presets[refs(state).lookout].systemPrompt).toBe('Keep the lookout log.');
    });

    test('refs whose keys v2.8.0 merged into one slug key stay unrepaired', () => {
        const state = readGlobal(v280Settings());
        expect([refs(state).first, refs(state).second]).toEqual(['瞭望', '守夜']);
    });

    test('a ref whose slug key is referenced directly by another node stays unrepaired', () => {
        const state = readGlobal(v280Settings());
        expect([refs(state).night, refs(state).night_direct]).toEqual(['Night 乙', 'Night__']);
    });

    test('a ref shared with a string-form node stays unrepaired on every node', () => {
        const settings = v280Settings();
        const stored = settings.presetLibraries.spec.legacy;
        stored.spec.stages[0].nodes = ['Watch 丙', { id: 'relief', preset: 'Watch 丙' }];
        stored.presets = { 'Watch__': { systemPrompt: 'Keep the watch.' } };
        const nodes = readGlobal(settings).spec.stages[0].nodes;
        expect(nodes[0]).toBe('Watch 丙');
        expect(nodes[1].preset).toBe('Watch 丙');
    });

    test('preset keys are never renamed', () => {
        const state = readGlobal(v280Settings());
        expect(Object.keys(state.presets)).toEqual(['Lookout__', '__', 'Night__']);
    });

    test('profiles without dangling refs are read unchanged', async () => {
        const { sanitizeSpec } = await import('../../public/scripts/extensions/orchestrator/spec-schema.js');
        const raw = storedProfile();
        const state = readGlobal(globalSettings());
        expect(state.spec).toEqual(sanitizeSpec(raw.spec));
        expect(state.presets).toEqual(sanitizePresetMap(raw.presets));
    });

    test('a relinked profile builds a lossless editor', () => {
        const settings = v280Settings();
        const stored = settings.presetLibraries.spec.legacy;
        stored.spec.stages[0].nodes = stored.spec.stages[0].nodes.filter(n => n.id === 'lookout');
        const before = readGlobal(settings);
        expect(refs(before).lookout).toBe('Lookout__');
        const editor = createIterationEditorFromWorkingProfile(before);
        expect(editor.spec.stages[0].nodes.map(n => [n.id, n.preset])).toEqual(before.spec.stages[0].nodes.map(n => [n.id, n.preset]));
        expect(editor.presets).toEqual(before.presets);
    });
});

describe('iteration tools resolve trimmed-equal ids unambiguously', () => {
    function runOn(workingProfile, calls) {
        const session = { mode: MODES.SPEC, workingProfile };
        const actions = [];
        const toolResults = [];
        const executor = createSpecStructureToolExecutor(session, { actions, toolResults });
        for (const { name, args } of calls) {
            executor.execute(name, args, (payload) => toolResults.push({ tool_call_id: name, content: JSON.stringify(payload) }));
        }
        executor.finalize();
        return { profile: session.workingProfile, results: toolResults.map(r => JSON.parse(r.content)) };
    }

    function profileWith({ presets = {}, stages }) {
        return {
            spec: { stages: stages || [{ id: 'watch', mode: 'serial', nodes: [{ id: 'lookout', preset: 'lookout' }] }] },
            presets: { lookout: { systemPrompt: 'Look out.' }, ...presets },
        };
    }

    test('resolveStoredIdToken prefers an exact key, then a unique trimmed-equal key', async () => {
        const { resolveStoredIdToken } = await import('../../public/scripts/extensions/orchestrator/editable-spec.js');
        expect(resolveStoredIdToken(['x', ' x'], 'x')).toEqual({ status: 'found', id: 'x', index: 0 });
        expect(resolveStoredIdToken(['x', ' x'], ' x')).toEqual({ status: 'found', id: ' x', index: 1 });
        expect(resolveStoredIdToken(['y', ' x'], 'x ')).toEqual({ status: 'found', id: ' x', index: 1 });
        expect(resolveStoredIdToken([' x', 'x '], 'x')).toEqual({ status: 'ambiguous', id: 'x', matches: [' x', 'x '] });
        expect(resolveStoredIdToken(['a', 'a'], 'a')).toEqual({ status: 'ambiguous', id: 'a', matches: ['a', 'a'] });
        expect(resolveStoredIdToken(['y'], ' x ')).toEqual({ status: 'missing', id: 'x' });
        expect(resolveStoredIdToken(['y'], '  ')).toEqual({ status: 'empty' });
    });

    test('set_preset edits the unique trimmed-equal key instead of adding a sibling', () => {
        const { profile, results } = runOn(profileWith({ presets: { ' 守夜': { systemPrompt: 'old' } } }), [
            { name: 'luker_orch_set_preset', args: { preset_id: '守夜', systemPrompt: 'Keep the night watch.' } },
        ]);
        expect(results[0]).toMatchObject({ ok: true, preset_id: ' 守夜' });
        expect(Object.keys(profile.presets)).toEqual(['lookout', ' 守夜']);
        expect(profile.presets[' 守夜'].systemPrompt).toBe('Keep the night watch.');
    });

    test('set_preset edits the exact key when a trimmed-equal sibling exists', () => {
        const { profile, results } = runOn(profileWith({ presets: { '守夜': { systemPrompt: 'a' }, '守夜 ': { systemPrompt: 'b' } } }), [
            { name: 'luker_orch_set_preset', args: { preset_id: '守夜', systemPrompt: 'exact' } },
        ]);
        expect(results[0]).toMatchObject({ ok: true, preset_id: '守夜' });
        expect([profile.presets['守夜'].systemPrompt, profile.presets['守夜 '].systemPrompt]).toEqual(['exact', 'b']);
    });

    test('preset tools report ambiguity instead of picking the first trimmed-equal key', () => {
        const presets = { ' 守夜': { systemPrompt: 'a' }, '守夜 ': { systemPrompt: 'b' } };
        const { profile, results } = runOn(profileWith({ presets }), [
            { name: 'luker_orch_set_preset', args: { preset_id: '守夜', systemPrompt: 'changed' } },
            { name: 'luker_orch_remove_preset', args: { preset_id: '守夜' } },
            { name: 'luker_orch_set_node', args: { stage_id: 'watch', node_id: 'night', preset: '守夜' } },
        ]);
        expect(results.map(r => r.ok)).toEqual([false, false, false]);
        for (const result of results) {
            expect(result).toMatchObject({ error: 'multiple_matches', matches: [' 守夜', '守夜 '] });
        }
        expect(Object.keys(profile.presets)).toEqual(['lookout', ' 守夜', '守夜 ']);
        expect(Object.values(profile.presets).map(p => p.systemPrompt)).toEqual(['Look out.', 'a', 'b']);
        expect(profile.spec.stages[0].nodes.map(n => n.id)).toEqual(['lookout']);
    });

    test('remove_preset removes the unique trimmed-equal key', () => {
        const { profile, results } = runOn(profileWith({ presets: { ' 守夜': { systemPrompt: 'a' } } }), [
            { name: 'luker_orch_remove_preset', args: { preset_id: '守夜' } },
        ]);
        expect(results[0]).toMatchObject({ ok: true, preset_id: ' 守夜' });
        expect(Object.keys(profile.presets)).toEqual(['lookout']);
    });

    test('set_node references a whitespace-padded preset key its trimmed id resolves to', () => {
        const { profile, results } = runOn(profileWith({ presets: { ' 守夜': { systemPrompt: 'a' } } }), [
            { name: 'luker_orch_set_node', args: { stage_id: 'watch', node_id: 'night', preset: '守夜' } },
        ]);
        expect(results[0]).toMatchObject({ ok: true, preset_id: ' 守夜' });
        const editor = createIterationEditorFromWorkingProfile(profile);
        expect(editor.spec.stages[0].nodes.map(n => [n.id, n.preset])).toEqual([['lookout', 'lookout'], ['night', ' 守夜']]);
        expect(Object.keys(editor.presets)).toEqual(['lookout', ' 守夜']);
    });

    test('set_node refuses a whitespace-padded preset key whose trimmed id resolves to a sibling', () => {
        const { profile, results } = runOn(profileWith({ presets: { '守夜': { systemPrompt: 'a' }, ' 守夜': { systemPrompt: 'b' } } }), [
            { name: 'luker_orch_set_node', args: { stage_id: 'watch', node_id: 'night', preset: ' 守夜' } },
        ]);
        expect(results[0]).toMatchObject({ ok: false, error: 'invalid_args', preset_id: ' 守夜' });
        expect(profile.spec.stages[0].nodes.map(n => n.id)).toEqual(['lookout']);
    });

    test('stage and node tools report ambiguity for duplicate ids', () => {
        const stages = [
            { id: '守望', mode: 'serial', nodes: [{ id: 'lookout', preset: 'lookout' }] },
            { id: '守望', mode: 'serial', nodes: [{ id: 'lookout', preset: 'lookout' }] },
            { id: 'single', mode: 'serial', nodes: [{ id: '瞭望', preset: 'lookout' }, { id: '瞭望', preset: 'lookout' }] },
        ];
        const before = structuredClone(stages);
        const { profile, results } = runOn(profileWith({ stages }), [
            { name: 'luker_orch_set_stage', args: { stage_id: '守望', mode: 'parallel' } },
            { name: 'luker_orch_remove_stage', args: { stage_id: '守望' } },
            { name: 'luker_orch_set_node', args: { stage_id: '守望', node_id: 'lookout', preset: 'lookout' } },
            { name: 'luker_orch_remove_node', args: { stage_id: 'single', node_id: '瞭望' } },
            { name: 'luker_orch_set_spec_node_tools', args: { stage_id: 'single', node_id: '瞭望', tools: { lorebook: { search: true } } } },
            { name: 'luker_orch_clear_spec_node_tools', args: { stage_id: '守望', node_id: 'lookout' } },
        ]);
        expect(results.map(r => r.ok)).toEqual([false, false, false, false, false, false]);
        expect(results.map(r => r.error)).toEqual(Array(6).fill('multiple_matches'));
        expect(results.map(r => r.matches)).toEqual([
            ['守望', '守望'], ['守望', '守望'], ['守望', '守望'], ['瞭望', '瞭望'], ['瞭望', '瞭望'], ['守望', '守望'],
        ]);
        expect(profile.spec.stages).toEqual(before);
    });
});

describe('agenda agent tools resolve trimmed-equal agent ids unambiguously', () => {
    function runOn(agents, calls, finalAgentId = 'finalizer') {
        const session = { mode: MODES.AGENDA, workingProfile: { agents, finalAgentId } };
        const actions = [];
        const results = [];
        for (const { name, args } of calls) {
            executeAgendaAgentTool(session, name, args, { actions, pushToolResult: payload => results.push(payload) });
        }
        return { profile: session.workingProfile, results };
    }

    const agents = () => ({
        finalizer: { systemPrompt: 'Finalize.' },
        ' 守夜': { systemPrompt: 'old' },
        '瞭望': { systemPrompt: 'exact' },
        '瞭望 ': { systemPrompt: 'padded' },
    });

    test('set_agenda_agent edits the unique trimmed-equal key instead of adding a sibling', () => {
        const { profile, results } = runOn(agents(), [
            { name: 'luker_orch_set_agenda_agent', args: { agent_id: '守夜', systemPrompt: 'Keep the night watch.' } },
        ]);
        expect(results[0]).toMatchObject({ ok: true, agent_id: ' 守夜' });
        expect(Object.keys(profile.agents)).toEqual(['finalizer', ' 守夜', '瞭望', '瞭望 ']);
        expect(profile.agents[' 守夜'].systemPrompt).toBe('Keep the night watch.');
    });

    test('agent tools edit the exact key when a trimmed-equal sibling exists', () => {
        const { profile, results } = runOn(agents(), [
            { name: 'luker_orch_patch_agenda_agent_system_prompt', args: { agent_id: '瞭望', oldString: 'exact', newString: 'patched' } },
            { name: 'luker_orch_set_agenda_agent_tools', args: { agent_id: '瞭望', tools: { lorebook: { search: true } } } },
        ]);
        expect(results.map(r => [r.ok, r.agent_id ?? null])).toEqual([[true, '瞭望'], [true, null]]);
        expect(profile.agents['瞭望'].systemPrompt).toBe('patched');
        expect(profile.agents['瞭望'].tools.lorebook.search).toBe(true);
        expect(profile.agents['瞭望 ']).toMatchObject({ systemPrompt: 'padded', tools: null });
    });

    test('patch, tools and remove reach a whitespace-padded key by its trimmed id', () => {
        const { profile, results } = runOn(agents(), [
            { name: 'luker_orch_patch_agenda_agent_system_prompt', args: { agent_id: '守夜', oldString: 'old', newString: 'new' } },
            { name: 'luker_orch_set_agenda_agent_tools', args: { agent_id: '守夜', tools: { lorebook: { search: true } } } },
            { name: 'luker_orch_clear_agenda_agent_tools', args: { agent_id: '守夜' } },
            { name: 'luker_orch_remove_agenda_agent', args: { agent_id: '守夜' } },
        ]);
        expect(results.map(r => r.ok)).toEqual([true, true, true, true]);
        expect(results.map(r => r.changed)).toEqual([true, true, true, true]);
        expect(Object.keys(profile.agents)).toEqual(['finalizer', '瞭望', '瞭望 ']);
    });

    test('agent tools report ambiguity instead of picking the first trimmed-equal key', () => {
        const ambiguous = { finalizer: { systemPrompt: 'Finalize.' }, ' 守夜': { systemPrompt: 'a' }, '守夜 ': { systemPrompt: 'b' } };
        const before = structuredClone(ambiguous);
        const { profile, results } = runOn(ambiguous, [
            { name: 'luker_orch_set_agenda_agent', args: { agent_id: '守夜', systemPrompt: 'changed' } },
            { name: 'luker_orch_patch_agenda_agent_system_prompt', args: { agent_id: '守夜', oldString: 'a', newString: 'c' } },
            { name: 'luker_orch_remove_agenda_agent', args: { agent_id: '守夜' } },
            { name: 'luker_orch_set_agenda_final_agent', args: { agent_id: '守夜' } },
            { name: 'luker_orch_set_agenda_agent_tools', args: { agent_id: '守夜', tools: { lorebook: { search: true } } } },
            { name: 'luker_orch_clear_agenda_agent_tools', args: { agent_id: '守夜' } },
        ]);
        expect(results.map(r => r.error)).toEqual(Array(6).fill('multiple_matches'));
        expect(results.map(r => r.matches)).toEqual(Array(6).fill([' 守夜', '守夜 ']));
        expect(profile.agents).toEqual(before);
        expect(profile.finalAgentId).toBe('finalizer');
    });

    test('set_agenda_final_agent accepts a whitespace-padded key and an exact one', () => {
        const first = runOn(agents(), [{ name: 'luker_orch_set_agenda_final_agent', args: { agent_id: '守夜' } }]);
        expect(first.results[0]).toMatchObject({ ok: true, agent_id: ' 守夜' });
        expect(first.profile.finalAgentId).toBe(' 守夜');
        const second = runOn(agents(), [{ name: 'luker_orch_set_agenda_final_agent', args: { agent_id: '瞭望 ' } }]);
        expect(second.results[0]).toMatchObject({ ok: true, agent_id: '瞭望 ' });
        expect(second.profile.finalAgentId).toBe('瞭望 ');
    });
});

describe('agent and preset references resolve against stored ids', () => {
    const PADDED = ' 守夜';
    const AMBIGUOUS = { ' 守夜': { systemPrompt: 'a' }, '守夜 ': { systemPrompt: 'b' } };

    test('resolveStoredIdReference returns the stored key, else the trimmed reference', async () => {
        const { resolveStoredIdReference } = await import('../../public/scripts/extensions/orchestrator/editable-spec.js');
        expect(resolveStoredIdReference({ [PADDED]: {} }, '守夜')).toBe(PADDED);
        expect(resolveStoredIdReference({ '守夜': {}, [PADDED]: {} }, PADDED)).toBe(PADDED);
        expect(resolveStoredIdReference(AMBIGUOUS, '守夜')).toBe('守夜');
        expect(resolveStoredIdReference({}, ' 守夜 ')).toBe('守夜');
    });

    test('the agenda final agent resolves to a padded key and falls back when ambiguous', async () => {
        const { sanitizeAgendaWorkingProfile } = await import('../../public/scripts/extensions/orchestrator/agenda-profile.js');
        const finalizer = { systemPrompt: 'Finalize.' };
        expect(sanitizeAgendaWorkingProfile({ agents: { finalizer, [PADDED]: {} }, finalAgentId: '守夜' }).finalAgentId).toBe(PADDED);
        expect(sanitizeAgendaWorkingProfile({ agents: { finalizer, ...AMBIGUOUS }, finalAgentId: '守夜' }).finalAgentId).toBe('finalizer');
        expect(sanitizeAgendaWorkingProfile({ agents: { '守夜': {}, [PADDED]: {} }, finalAgentId: PADDED }).finalAgentId).toBe(PADDED);
    });

    test('the agenda editor final agent select keeps the stored key', async () => {
        const { setAgendaEditorFinalAgent } = await import('../../public/scripts/extensions/orchestrator/agenda-profile.js');
        const editor = { agents: { finalizer: {}, [PADDED]: {} }, finalAgentId: 'finalizer' };
        setAgendaEditorFinalAgent(editor, PADDED);
        expect(editor.finalAgentId).toBe(PADDED);
        setAgendaEditorFinalAgent(editor, '');
        expect(editor.finalAgentId).toBe(PADDED);
    });

    test('agenda dispatch reaches a padded agent by its trimmed id and drops an ambiguous one', async () => {
        const { normalizeAgendaDispatches } = await import('../../public/scripts/extensions/orchestrator/agenda-runtime.js');
        const dispatch = { todo_id: 'watch', agent: '守夜', task_brief: 'Keep the watch.' };
        const reached = normalizeAgendaDispatches({ todos: [], runs: [] }, { dispatches: [dispatch] }, { agents: { [PADDED]: {} } }, {});
        expect(reached.map(d => d.agent)).toEqual([PADDED]);
        expect(normalizeAgendaDispatches({ todos: [], runs: [] }, { dispatches: [dispatch] }, { agents: AMBIGUOUS }, {})).toEqual([]);
    });

    test('spec editor node refs resolve to a padded preset without adding a sibling', async () => {
        const { ensureEditorIntegrity, setEditorNodePreset } = await import('../../public/scripts/extensions/orchestrator/editor-state.js');
        const editor = createIterationEditorFromWorkingProfile({
            spec: { stages: [{ id: 'watch', mode: 'serial', nodes: [{ id: 'night', preset: '守夜' }, { id: 'lookout', preset: 'lookout' }] }] },
            presets: { lookout: {}, [PADDED]: { systemPrompt: 'Keep the night watch.' } },
        });
        expect(editor.spec.stages[0].nodes[0].preset).toBe(PADDED);
        setEditorNodePreset(editor, editor.spec.stages[0].nodes[1], PADDED);
        ensureEditorIntegrity(editor);
        expect(editor.spec.stages[0].nodes.map(n => n.preset)).toEqual([PADDED, PADDED]);
        expect(Object.keys(editor.presets)).toEqual(['lookout', PADDED]);

        const ambiguous = createIterationEditorFromWorkingProfile({
            spec: { stages: [{ id: 'watch', mode: 'serial', nodes: [{ id: 'night', preset: '守夜' }] }] },
            presets: AMBIGUOUS,
        });
        expect(ambiguous.spec.stages[0].nodes[0].preset).toBe('守夜');
        expect(Object.keys(ambiguous.presets)).toEqual(Object.keys(AMBIGUOUS));
    });

    test('copying agenda agents into a spec editor keeps a padded final agent', async () => {
        const { copyAgendaAgentsIntoSpecEditor } = await import('../../public/scripts/extensions/orchestrator/editor-state.js');
        const agendaEditor = { agents: { lookout: {}, [PADDED]: { systemPrompt: 'Keep the night watch.' } }, finalAgentId: PADDED };
        const specEditor = { spec: null, presets: {} };
        copyAgendaAgentsIntoSpecEditor(agendaEditor, specEditor);
        const finalStage = specEditor.spec.stages.at(-1);
        expect(finalStage.nodes.map(n => n.preset)).toEqual([PADDED]);
        expect(Object.keys(specEditor.presets)).toEqual(['lookout', PADDED]);
    });

    test('the preset removal guard follows resolved refs', async () => {
        const { isPresetReferencedInSpec } = await import('../../public/scripts/extensions/orchestrator/editable-spec.js');
        const spec = { stages: [{ id: 'watch', nodes: [{ id: 'night', preset: '守夜' }] }] };
        const withExact = { '守夜': {}, [PADDED]: {} };
        expect([isPresetReferencedInSpec(spec, '守夜', withExact), isPresetReferencedInSpec(spec, PADDED, withExact)]).toEqual([true, false]);
        expect(Object.keys(AMBIGUOUS).map(id => isPresetReferencedInSpec(spec, id, AMBIGUOUS))).toEqual([true, true]);
    });

    test('the legacy slug repair leaves a ref that resolves to a padded key', () => {
        const profile = {
            name: 'Legacy',
            spec: { stages: [{ id: 'watch', mode: 'serial', nodes: [{ id: 'night', preset: 'Night 乙' }] }] },
            presets: { 'Night 乙 ': { systemPrompt: 'Padded.' }, 'Night__': { systemPrompt: 'Slug.' } },
        };
        const state = readGlobal({
            presetLibraries: { spec: { legacy: profile }, agenda: {}, loop: {}, director: {} },
            activePresetIds: { spec: 'legacy', agenda: '', loop: '', director: '' },
        });
        expect(state.spec.stages[0].nodes[0].preset).toBe('Night 乙');
    });

    test('skill export reads the padded preset a node refers to', async () => {
        const { collectResolvedSkillsForOrchPreset } = await import('../../public/scripts/extensions/orchestrator/collect-active-skills.js');
        skillsApi.list.mockImplementation(async () => [{ name: 'night-log', description: 'd', scope: { kind: 'preset', name: 'night-preset' } }]);
        try {
            const payload = (presets) => ({
                mode: 'spec',
                name: 'Watch',
                profile: {
                    skills: { visible: [], deny: [] },
                    spec: { stages: [{ id: 'watch', nodes: [{ id: 'night', preset: '守夜', skills: { visible: ['night-log'], deny: [] } }] }] },
                    presets,
                },
            });
            const resolved = await collectResolvedSkillsForOrchPreset(payload({ [PADDED]: { promptPresetName: 'night-preset' } }));
            expect([...resolved.values()].flatMap(group => group.names)).toEqual(['night-log']);
            const ambiguous = await collectResolvedSkillsForOrchPreset(payload({
                ' 守夜': { promptPresetName: 'night-preset' },
                '守夜 ': { promptPresetName: 'night-preset' },
            }));
            expect([...ambiguous.values()].flatMap(group => group.names)).toEqual([]);
        } finally {
            skillsApi.list.mockImplementation(async () => []);
        }
    });
});
