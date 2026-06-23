// tests/orchestrator/custom-tool-runtime-agenda.test.js
//
// Verifies agenda runtime constructs the per-run customToolRegistry at
// orchestration entry and threads it into the per-call executeLoopTool
// ctx. Same strategy as the spec runtime test: only the LLM is mocked
// (legitimate non-deterministic surface). The real loop-tools /
// loop-runtime / agent-resolution / per-run custom-tool registry all
// run for real. To verify the registry reached `executeLoopTool`, the
// test profile registers a custom tool whose `body` records its own
// dispatch onto a sidecar.

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

// agenda-runtime.js + defaults.js consume core symbols via
// `Luker.getContext()` after upstream commit 571c529c2. Provide a
// shim with the constants + the shared `extensionSettings` binding the
// runtime captures at module-load time. Mutating
// `globalThis.Luker.__settings.orchestrator` in beforeEach
// propagates because the runtime stores the live object reference.
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
    extension_settings: {
        orchestrator: {
            agendaPlannerMaxRounds: 4,
            agendaMaxConcurrentAgents: 2,
            agendaMaxTotalRuns: 12,
            nodeIterationMaxRounds: 3,
        },
    },
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

// Stub the connection-manager gate so the real agent-resolution.js can load
// without pulling textgen-models.js → document.addEventListener under Node.
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

// LLM stub — controlled per-test via `plannerResponses` / `agentResponses`.
// The only legitimate mock surface (LLM is slow / non-deterministic).
// Everything else runs the real product modules.
const plannerResponses = [];
const agentResponses = [];
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/tool-calling.js', () => ({
    appendStandardToolRoundMessages: () => {},
    requestToolCallsWithRetry: async () => {
        if (agentResponses.length === 0) {
            throw new Error('Agent LLM stub exhausted');
        }
        return agentResponses.shift();
    },
    requestToolCallWithRetry: async () => {
        if (plannerResponses.length === 0) {
            throw new Error('Planner LLM stub exhausted');
        }
        return plannerResponses.shift();
    },
    serializeToolResultContent: (r) => JSON.stringify(r),
    makeRuntimeToolCallId: () => `tc_${Math.random().toString(36).slice(2, 10)}`,
}));

let runAgendaOrchestration;

// Sidecar the custom-tool body writes into so the test can assert
// the registry actually dispatched my_tool. The real executeLoopTool
// runs the body which has access to a global the test reads after the run.
const customToolDispatches = [];
globalThis.__customToolDispatchSink = customToolDispatches;

beforeAll(async () => {
    ({ runAgendaOrchestration } = await import('../../public/scripts/extensions/orchestrator/agenda-runtime.js'));
});

beforeEach(() => {
    plannerResponses.length = 0;
    agentResponses.length = 0;
    customToolDispatches.length = 0;
});

describe('agenda runtime Layer-3 dispatch', () => {
    test('threads customToolRegistry into the per-call executeLoopTool ctx', async () => {
        // Profile: one agent (writer) with chat.read_range enabled so
        // `hasAnyToolEnabled` triggers the multi-round path. One custom
        // tool the agent calls before finalizing. Body records evidence
        // the registry reached executeLoopTool.
        const profile = {
            mode: 'agenda',
            planner: { systemPrompt: 'plan', userPromptTemplate: 'plan' },
            agents: {
                writer: {
                    systemPrompt: 'sys',
                    userPromptTemplate: 'user',
                    tools: { chat: { read_range: true } },
                },
            },
            finalAgentId: 'writer',
            limits: { plannerMaxRounds: 2, maxConcurrentAgents: 1, maxTotalRuns: 4 },
            customTools: [
                {
                    name: 'my_tool',
                    description: 'd',
                    parameters: {},
                    mode: 'read',
                    body: 'globalThis.__customToolDispatchSink.push({ name: "my_tool", args, hasRegistry: !!(ctx && ctx.__customToolRegistry && ctx.__customToolRegistry.has && ctx.__customToolRegistry.has("my_tool")) }); return { x: 1 };',
                    simulateBody: '',
                },
            ],
        };

        // Planner step #1: dispatch writer for the main todo.
        plannerResponses.push({
            dispatches: [
                { todo_id: 'main', agent: 'writer', task_brief: 'do it', input_run_ids: [] },
            ],
        });
        // Planner step #2: finalize (after writer produced output).
        plannerResponses.push({
            finalize: 'done.',
        });

        // Writer round 1: call custom tool. Round 2: emit agenda result tool.
        agentResponses.push({
            toolCalls: [{ id: 'tc1', name: 'my_tool', args: { x: 7 } }],
            assistantText: '',
            reasoning: '',
        });
        agentResponses.push({
            toolCalls: [{ id: 'tc2', name: 'luker_orch_submit_result', args: { text: 'agent finished' } }],
            assistantText: '',
            reasoning: '',
        });
        // Finalizer dispatch (writer reused). Single round result.
        agentResponses.push({
            toolCalls: [{ id: 'tc3', name: 'luker_orch_submit_result', args: { text: 'finalized' } }],
            assistantText: '',
            reasoning: '',
        });

        const messages = [];
        await runAgendaOrchestration({}, { signal: new AbortController().signal }, messages, profile);

        const myToolCall = customToolDispatches.find(c => c.name === 'my_tool');
        expect(myToolCall).toBeTruthy();
        expect(myToolCall.args).toEqual({ x: 7 });
        expect(myToolCall.hasRegistry).toBe(true);
    });
});
