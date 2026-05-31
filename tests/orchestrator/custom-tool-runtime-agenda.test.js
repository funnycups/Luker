// tests/orchestrator/custom-tool-runtime-agenda.test.js
//
// Verifies agenda runtime constructs the per-run customToolRegistry at
// orchestration entry and threads it into both the agent schemas and
// the per-call executeLoopTool ctx. Same mocking strategy as the spec
// runtime test: heavy module mocks let us drive runAgendaOrchestration
// end-to-end without a real LLM or live floor-state adapter.

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

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

jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/agent-resolution.js', () => ({
    getPresetApiPresetName: () => '',
    getPresetPromptPresetName: () => '',
    resolveAgentToolFlags: (override, fallback) => override || fallback || null,
    resolveOrchestrationAgentApiPresetName: () => '',
    resolveOrchestrationAgentPromptPresetName: () => '',
    resolveOrchestrationRuntimeWorldInfo: async () => null,
}));

// LLM stub — controlled per-test via `llmResponses`. The agenda runtime
// has two distinct LLM call surfaces: `requestToolCallWithRetry` for the
// single-shot planner step + finalizer dispatch, and
// `requestToolCallsWithRetry` for the multi-round agent loop. The first
// is per-call programmable via `plannerResponses`; the second is
// per-call programmable via `agentResponses`.
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

// executeLoopTool spy — captures the ctx received by each call.
const executeLoopToolCalls = [];
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/loop-tools.js', () => ({
    executeLoopTool: async (name, args, ctx) => {
        executeLoopToolCalls.push({ name, args, ctx });
        return { ok: true, captured: true };
    },
    getEnabledToolSchemas: (_profile, customToolRegistry) => {
        if (!customToolRegistry) return [];
        const out = [];
        for (const [, entry] of customToolRegistry) {
            out.push(entry.schema);
        }
        return out;
    },
    // Mock mirrors the real precedence (Layer-3 → Layer-1 → Layer-2) at the
    // level this test cares about: any name present in the per-run registry
    // wins as 'profile'; everything else falls back to 'unknown' (this test
    // doesn't register Layer-1/2 entries).
    resolveToolSource: (name, ctx) => {
        const reg = ctx?.__customToolRegistry;
        if (reg && typeof reg.get === 'function' && reg.get(String(name || ''))) return 'profile';
        return 'unknown';
    },
}));

jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/loop-runtime.js', () => ({
    attachToolContext: async () => ({}),
    ToolError: class ToolError extends Error {
        constructor(message, code, hint) { super(message); this.code = code; this.hint = hint; }
    },
    isStructuredToolError: (err) => Boolean(
        err && typeof err === 'object'
        && err.name === 'ToolError' && typeof err.code === 'string',
    ),
}));

let runAgendaOrchestration;
beforeAll(async () => {
    ({ runAgendaOrchestration } = await import('../../public/scripts/extensions/orchestrator/agenda-runtime.js'));
});

beforeEach(() => {
    plannerResponses.length = 0;
    agentResponses.length = 0;
    executeLoopToolCalls.length = 0;
});

describe('agenda runtime Layer-3 dispatch', () => {
    test('threads customToolRegistry into the per-call executeLoopTool ctx', async () => {
        // Profile: one agent (writer) with chat.read_range enabled so
        // `hasAnyToolEnabled` triggers the multi-round path. One custom
        // tool the agent calls before finalizing.
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
                { name: 'my_tool', description: 'd', parameters: {}, mode: 'read', body: 'return { x: 1 };', simulateBody: '' },
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

        const myToolCall = executeLoopToolCalls.find(c => c.name === 'my_tool');
        expect(myToolCall).toBeTruthy();
        expect(myToolCall.ctx.__customToolRegistry).toBeTruthy();
        expect(myToolCall.ctx.__customToolRegistry.has('my_tool')).toBe(true);
    });
});
