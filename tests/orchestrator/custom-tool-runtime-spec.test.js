// tests/orchestrator/custom-tool-runtime-spec.test.js
//
// Verifies spec runtime constructs the per-run customToolRegistry at
// orchestration entry and threads it into the per-call executeLoopTool
// ctx. The spec runtime has no deps injection signature, so we only
// stub the LLM (`tool-calling.js`) — the only inherently non-deterministic
// surface. The real loop-tools / loop-runtime / agent-resolution / per-run
// custom-tool registry all run for real. To verify the registry reached
// `executeLoopTool`, the test profile registers a custom tool whose `body`
// records its own dispatch (via a sidecar map) and returns a probe value
// the LLM stub can assert reached the agent on the next round.

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

// spec-runtime.js + defaults.js consume core symbols via
// `Luker.getContext()` after upstream commit 571c529c2. Provide a
// shim with the constants + the shared `extensionSettings` binding the
// runtime captures at module-load time.
const __sillyTavernSettings = {
    orchestrator: { nodeIterationMaxRounds: 3 },
};
globalThis.Luker = {
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

// Stub the connection-manager gate so the real agent-resolution.js can load
// without pulling textgen-models.js → document.addEventListener under Node.
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

// LLM stub — controlled per-test via `llmResponses`. The only legitimate
// mock surface (LLM is slow / non-deterministic). Everything else runs
// the real product modules.
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

let runSpecOrchestration;

// Sidecar the custom-tool body writes into so the test can assert
// the registry actually dispatched my_tool with the LLM's args. The
// real executeLoopTool runs the body and the body has access to a
// global the test reads after the run.
const customToolDispatches = [];
globalThis.__customToolDispatchSink = customToolDispatches;

beforeAll(async () => {
    ({ runSpecOrchestration } = await import('../../public/scripts/extensions/orchestrator/spec-runtime.js'));
});

beforeEach(() => {
    llmResponses.length = 0;
    customToolDispatches.length = 0;
});

describe('spec runtime Layer-3 dispatch', () => {
    test('threads customToolRegistry into the per-call executeLoopTool ctx', async () => {
        // Profile: one stage, one worker node with memory.search enabled
        // and a single custom tool the LLM is told to call. The body
        // records evidence the registry dispatch worked: it pushes the
        // received args plus a registry-presence probe onto the sidecar.
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
                {
                    name: 'my_tool',
                    description: 'd',
                    parameters: {},
                    mode: 'read',
                    body: 'globalThis.__customToolDispatchSink.push({ name: "my_tool", args, hasRegistry: !!(ctx && ctx.__customToolRegistry && ctx.__customToolRegistry.has && ctx.__customToolRegistry.has("my_tool")) }); return { x: args.x };',
                    simulateBody: '',
                },
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

        // The real executeLoopTool dispatched my_tool. The body ran with
        // the LLM's args and saw the per-run customToolRegistry on ctx.
        const myToolCall = customToolDispatches.find(c => c.name === 'my_tool');
        expect(myToolCall).toBeTruthy();
        expect(myToolCall.args).toEqual({ x: 5 });
        expect(myToolCall.hasRegistry).toBe(true);
    });
});
