// tests/orchestrator/skill-resolution-runtime-plumbing.test.js
//
// Runtime-wire-up regression for the Task 5 Important finding.
//
// Task 5's `buildSkillRuntimeContext(sillyTavernContext, agentProfile, orchPreset)`
// third-arg extension lets orch-preset scope filtering activate at runtime.
// The 3 non-director runtime call sites (agenda / loop / spec) were passing
// `{mode:X, name:''}` because the local `preset` / `profile` variable in scope
// at each site references an INNER config (per-agent config in agenda, sanitized
// loop profile, per-node preset in spec) that never carries the top-level
// orchestrator preset's `.name`. The `.name === ''` branch in
// `buildSkillRuntimeContext` (skill-resolution.js:287-291) then silently omits
// `ctx.orchPreset`, so orch-preset scope filtering no-op'd for 3 of 4 modes.
//
// The fix threads `deps.activeOrchPresetName` (captured once in main.js
// runOrchestration) from each runtime's entry-point deps bag down to the
// buildSkillRuntimeContext call site. These tests spy on
// `buildSkillRuntimeContext` via module mocking and drive each runtime to
// verify the wiring is intact — the 3rd arg must be `{mode:X, name:'nightowl'}`.
//
// Companion to `skill-resolution-scope-precedence.test.js` — that file tests
// the resolver contract (what happens once orchPreset is lifted); this file
// tests that the runtime call sites actually populate the field. Kept
// separate because that file imports the real skill-resolution.js and
// module-level mocking of it here would break the live-import path there.

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

// ─── Ambient ST globals ────────────────────────────────────────────────────
// Same shim shape used by custom-tool-runtime-{spec,agenda,loop}.test.js so
// the shared runtime modules (defaults.js / agenda-runtime.js / spec-runtime.js
// / loop-runtime.js) can consume `Luker.getContext()` constants at load time.
const __sillyTavernSettings = {
    orchestrator: {
        agendaPlannerMaxRounds: 4,
        agendaMaxConcurrentAgents: 2,
        agendaMaxTotalRuns: 12,
        nodeIterationMaxRounds: 3,
    },
};
globalThis.Luker = {
    __settings: __sillyTavernSettings,
    getContext: () => ({
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        },
        lib: {
            yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
        },
        extensionSettings: __sillyTavernSettings,
    }),
};

jest.unstable_mockModule('../../public/lib.js', () => ({
    Popper: {},
    lodash: {},
    yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
    default: {},
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: __sillyTavernSettings,
    getContext: () => ({}),
    writeExtensionField: () => {},
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
}));

jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_info_position: { before: 0, after: 1 },
    wi_anchor_position: {},
}));

jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

// ─── LLM stub for agenda + spec runtimes ────────────────────────────────────
// The only legitimate mock surface. Loop uses its own `sendLlm` deps
// injection so no module mock is needed for the loop test.
const plannerResponses = [];
const agentResponses = [];
const specLlmResponses = [];
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/tool-calling.js', () => ({
    appendStandardToolRoundMessages: () => {},
    requestToolCallsWithRetry: async () => {
        // Spec runtime uses this exclusively; agenda's `runAgendaTextAgent`
        // routes here when the worker has any loop tool enabled.
        if (specLlmResponses.length > 0) return specLlmResponses.shift();
        if (agentResponses.length > 0) return agentResponses.shift();
        throw new Error('requestToolCallsWithRetry stub exhausted');
    },
    requestToolCallWithRetry: async () => {
        // Agenda planner + agenda text-agent single-shot path both route here.
        if (plannerResponses.length > 0) return plannerResponses.shift();
        if (agentResponses.length > 0) return agentResponses.shift();
        throw new Error('requestToolCallWithRetry stub exhausted');
    },
    serializeToolResultContent: (r) => JSON.stringify(r),
    makeRuntimeToolCallId: () => `tc_${Math.random().toString(36).slice(2, 10)}`,
}));

// ─── Spy on skill-resolution.js so we can inspect buildSkillRuntimeContext
//     call args after each runtime run. This is the crux of the fix's
//     regression contract: `orchPreset` third arg must carry
//     `deps.activeOrchPresetName` from main.js down to the resolver.
const buildSkillRuntimeContextMock = jest.fn(() => ({}));
const resolveAgentVisibleSkillsMock = jest.fn(async () => []);
const buildAvailableSkillsBlockMock = jest.fn(() => '');

jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/skill-resolution.js', () => ({
    buildSkillRuntimeContext: buildSkillRuntimeContextMock,
    resolveAgentVisibleSkills: resolveAgentVisibleSkillsMock,
    buildAvailableSkillsBlock: buildAvailableSkillsBlockMock,
    invalidateSkillInventory: () => {},
}));

let runAgendaOrchestration;
let runLoopOrchestration;
let runSpecOrchestration;

beforeAll(async () => {
    ({ runAgendaOrchestration } = await import('../../public/scripts/extensions/orchestrator/agenda-runtime.js'));
    ({ runLoopOrchestration } = await import('../../public/scripts/extensions/orchestrator/loop-runtime.js'));
    ({ runSpecOrchestration } = await import('../../public/scripts/extensions/orchestrator/spec-runtime.js'));
});

beforeEach(() => {
    plannerResponses.length = 0;
    agentResponses.length = 0;
    specLlmResponses.length = 0;
    buildSkillRuntimeContextMock.mockClear();
    resolveAgentVisibleSkillsMock.mockClear();
    buildAvailableSkillsBlockMock.mockClear();
});

describe('runtime plumbing — deps.activeOrchPresetName threads to buildSkillRuntimeContext', () => {
    test('runLoopOrchestration passes {mode:"loop", name} from deps to buildSkillRuntimeContext', async () => {
        const sendLlm = jest.fn().mockResolvedValueOnce({
            toolCalls: [{ id: 'tc1', name: 'finalize', args: { capsule_text: 'ok' } }],
            assistantText: '',
        });
        const profile = {
            mode: 'loop',
            apiPresetName: '',
            promptPresetName: '',
            system_prompt: 'You are a research agent.',
            tools: { finalize: true },
            max_rounds: 1,
            wall_clock_budget_ms: 60000,
            capsule_inject: { position: 'atDepth', depth: 0, role: 'system', customInstruction: '' },
        };

        await runLoopOrchestration({}, { signal: new AbortController().signal, coreChat: [] }, profile, {
            sendLlm,
            activeOrchPresetName: 'nightowl',
        });

        expect(buildSkillRuntimeContextMock).toHaveBeenCalledTimes(1);
        expect(buildSkillRuntimeContextMock.mock.calls[0][2]).toEqual({
            mode: 'loop',
            name: 'nightowl',
        });
    });

    test('runAgendaOrchestration passes {mode:"agenda", name} from deps to buildSkillRuntimeContext', async () => {
        // Minimal agenda profile: planner dispatches one worker to complete
        // `main`, then finalizes. runAgendaTextAgent is called for both the
        // worker dispatch and the finalize dispatch — each triggers a
        // buildSkillRuntimeContext call.
        const profile = {
            mode: 'agenda',
            planner: { systemPrompt: 'plan', userPromptTemplate: 'plan' },
            agents: {
                writer: {
                    systemPrompt: 'sys',
                    userPromptTemplate: 'user',
                },
            },
            finalAgentId: 'writer',
            limits: { plannerMaxRounds: 2, maxConcurrentAgents: 1, maxTotalRuns: 4 },
        };

        // Planner round 1: dispatch writer.
        plannerResponses.push({
            dispatches: [{ todo_id: 'main', agent: 'writer', task_brief: 'do it', input_run_ids: [] }],
        });
        // Planner round 2: finalize.
        plannerResponses.push({ finalize: 'done.' });
        // Writer single-shot result — no loop tools enabled so the single
        // path is taken. `requestToolCallWithRetry` returns the tool args
        // object directly; agenda-runtime reads `result.text`.
        agentResponses.push({ text: 'writer output' });
        // Finalize dispatch — one more agent call.
        agentResponses.push({ text: 'final composed output' });

        await runAgendaOrchestration({}, { signal: new AbortController().signal }, [], profile, {
            activeOrchPresetName: 'nightowl',
        });

        expect(buildSkillRuntimeContextMock.mock.calls.length).toBeGreaterThan(0);
        // Every runAgendaTextAgent call must pass the orch-preset name.
        for (const call of buildSkillRuntimeContextMock.mock.calls) {
            expect(call[2]).toEqual({ mode: 'agenda', name: 'nightowl' });
        }
    });

    test('runSpecOrchestration passes {mode:"spec", name} from deps to buildSkillRuntimeContext', async () => {
        // Minimal spec: one stage, one worker node whose LLM emits final
        // guidance on round 1 — runWorkerNode's skill resolution runs once
        // per node attempt before the LLM call.
        const profile = {
            mode: 'spec',
            spec: {
                stages: [
                    {
                        id: 's1',
                        mode: 'serial',
                        nodes: [{ id: 'n1', preset: 'p1', type: 'worker' }],
                    },
                ],
            },
            presets: { p1: { id: 'p1', systemPrompt: 'sys', userPromptTemplate: 'user' } },
        };

        specLlmResponses.push({
            toolCalls: [{ id: 'tc1', name: 'luker_orch_final_guidance', args: { text: 'done' } }],
            assistantText: '',
            reasoning: '',
        });

        await runSpecOrchestration({}, { signal: new AbortController().signal }, [], profile, {
            activeOrchPresetName: 'nightowl',
        });

        expect(buildSkillRuntimeContextMock).toHaveBeenCalledTimes(1);
        expect(buildSkillRuntimeContextMock.mock.calls[0][2]).toEqual({
            mode: 'spec',
            name: 'nightowl',
        });
    });
});
