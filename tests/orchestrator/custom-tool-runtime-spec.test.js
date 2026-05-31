// tests/orchestrator/custom-tool-runtime-spec.test.js
//
// Verifies spec runtime constructs the per-run customToolRegistry at
// orchestration entry and threads it into both the schemas and the per-
// call executeLoopTool ctx. The spec runtime has no deps injection
// signature, so we mock the modules it calls into: tool-calling
// (`requestToolCallsWithRetry`) for the LLM stub and loop-tools
// (`executeLoopTool`) for the spy on ctx.

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../public/lib.js', () => ({
    Popper: {},
    lodash: {},
    yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
    default: {},
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: { orchestrator: { nodeIterationMaxRounds: 3 } },
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

// LLM stub — controlled per-test via `llmResponses`.
const llmResponses = [];
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/tool-calling.js', () => ({
    appendStandardToolRoundMessages: () => {},
    requestToolCallsWithRetry: async () => {
        if (llmResponses.length === 0) {
            throw new Error('LLM stub exhausted');
        }
        return llmResponses.shift();
    },
    requestToolCallWithRetry: async () => ({}),
    serializeToolResultContent: (r) => JSON.stringify(r),
    makeRuntimeToolCallId: () => `tc_${Math.random().toString(36).slice(2, 10)}`,
}));

// executeLoopTool spy — captures the ctx received by each call.
// `getEnabledToolSchemas` is left as a minimal pass-through that exposes
// the customTools entries (mirroring the real shape from Unit 1) so the
// spec runtime advertises them in its node tool list.
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

// loop-runtime exports attachToolContext / ToolError / isStructuredToolError;
// we let the real attachToolContext return a plain object the spec runtime
// can mutate (it adds __customToolRegistry onto whatever's returned). The
// duck-type predicate mirrors the real implementation so cross-module
// tool errors flow through the spec catch path correctly under test.
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

let runSpecOrchestration;

beforeAll(async () => {
    ({ runSpecOrchestration } = await import('../../public/scripts/extensions/orchestrator/spec-runtime.js'));
});

beforeEach(() => {
    llmResponses.length = 0;
    executeLoopToolCalls.length = 0;
});

describe('spec runtime Layer-3 dispatch', () => {
    test('threads customToolRegistry into the per-call executeLoopTool ctx', async () => {
        // Profile: one stage, one worker node with memory.search enabled
        // and a single custom tool the LLM is told to call.
        const profile = {
            mode: 'spec',
            spec: {
                stages: [
                    {
                        id: 's1',
                        mode: 'serial',
                        nodes: [
                            { id: 'n1', preset: 'p1', type: 'worker', tools: { memory: { keyword_search: true } } },
                        ],
                    },
                ],
            },
            presets: { p1: { id: 'p1', systemPrompt: 'sys', userPromptTemplate: 'user' } },
            customTools: [
                { name: 'my_tool', description: 'd', parameters: {}, mode: 'read', body: 'return { x: args.x };', simulateBody: '' },
            ],
        };

        // LLM responses: round 1 calls my_tool, round 2 emits luker_orch_final_guidance.
        llmResponses.push({
            toolCalls: [{ id: 'tc1', name: 'my_tool', args: { x: 5 } }],
            assistantText: '',
            reasoning: '',
        });
        llmResponses.push({
            toolCalls: [{ id: 'tc2', name: 'luker_orch_final_guidance', args: { text: 'done' } }],
            assistantText: '',
            reasoning: '',
        });

        const messages = [];
        await runSpecOrchestration({}, { signal: new AbortController().signal }, messages, profile);

        // executeLoopTool spy was called for my_tool; the ctx it received
        // carries the per-run customToolRegistry with the entry compiled.
        const myToolCall = executeLoopToolCalls.find(c => c.name === 'my_tool');
        expect(myToolCall).toBeTruthy();
        expect(myToolCall.ctx.__customToolRegistry).toBeTruthy();
        expect(myToolCall.ctx.__customToolRegistry.has('my_tool')).toBe(true);
    });
});
