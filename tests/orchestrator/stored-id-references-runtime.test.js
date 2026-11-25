// Agent and preset keys are stored verbatim; agenda dispatch and final
// agent ids and spec node preset refs resolve against them with
// `resolveStoredIdToken`. Only the LLM (`tool-calling.js`) is stubbed;
// each stub call records its arguments so a test can read which preset
// prompt reached the model.

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
const agentRequests = [];
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/tool-calling.js', () => ({
    appendStandardToolRoundMessages: () => {},
    requestToolCallsWithRetry: async (...args) => {
        agentRequests.push(JSON.stringify(args));
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
let runSpecOrchestration;

beforeAll(async () => {
    ({ runAgendaOrchestration } = await import('../../public/scripts/extensions/orchestrator/agenda-runtime.js'));
    ({ runSpecOrchestration } = await import('../../public/scripts/extensions/orchestrator/spec-runtime.js'));
});

beforeEach(() => {
    plannerResponses.length = 0;
    agentResponses.length = 0;
    agentRequests.length = 0;
});

const PADDED = ' 守夜';
const submit = text => ({ toolCalls: [{ id: `tc_${text}`, name: 'luker_orch_submit_result', args: { text } }], assistantText: '', reasoning: '' });
const finalGuidance = text => ({ toolCalls: [{ id: `tc_${text}`, name: 'luker_orch_final_guidance', args: { text } }], assistantText: '', reasoning: '' });

function agendaProfile(agents, finalAgentId) {
    return {
        mode: 'agenda',
        planner: { systemPrompt: 'plan', userPromptTemplate: 'plan' },
        agents,
        finalAgentId,
        limits: { plannerMaxRounds: 2, maxConcurrentAgents: 1, maxTotalRuns: 4 },
    };
}

describe('agenda runtime resolves agent references against stored keys', () => {
    test('a trimmed dispatch agent id and final agent id reach a padded agent', async () => {
        const profile = agendaProfile({ [PADDED]: { systemPrompt: 'NIGHT-WATCH-PROMPT', userPromptTemplate: 'watch', tools: { chat: { read_range: true } } } }, '守夜');
        plannerResponses.push({ dispatches: [{ todo_id: 'watch', agent: '守夜', task_brief: 'Keep the watch.', input_run_ids: [] }] });
        plannerResponses.push({ finalize: 'done.' });
        agentResponses.push(submit('watched'), submit('finalized'));
        await runAgendaOrchestration({}, { signal: new AbortController().signal }, [], profile);
        expect(agentRequests).toHaveLength(2);
        expect(agentRequests.every(request => request.includes('NIGHT-WATCH-PROMPT'))).toBe(true);
    });

    test('an ambiguous final agent id is not resolved', async () => {
        const profile = agendaProfile({ ' 守夜': { systemPrompt: 'a' }, '守夜 ': { systemPrompt: 'b' } }, '守夜');
        plannerResponses.push({ finalize: 'done.' });
        await expect(runAgendaOrchestration({}, { signal: new AbortController().signal }, [], profile))
            .rejects.toThrow('Agenda final agent \'守夜\' is not configured.');
        expect(agentRequests).toEqual([]);
    });
});

describe('spec runtime resolves node preset refs against stored keys', () => {
    function specProfile(mode, presets) {
        return {
            mode: 'spec',
            spec: { stages: [{ id: 'watch', mode, nodes: [{ id: 'night', preset: '守夜', type: 'worker' }] }] },
            presets,
        };
    }

    test.each(['serial', 'parallel'])('a %s node reaches a padded preset by its trimmed ref', async (mode) => {
        agentResponses.push(finalGuidance('watched'));
        await runSpecOrchestration({}, { signal: new AbortController().signal }, [], specProfile(mode, { [PADDED]: { systemPrompt: 'NIGHT-WATCH-PROMPT', userPromptTemplate: 'watch' } }));
        expect(agentRequests).toHaveLength(1);
        expect(agentRequests[0]).toContain('NIGHT-WATCH-PROMPT');
    });

    test('a node ref matching several padded presets runs without either', async () => {
        agentResponses.push(finalGuidance('watched'));
        await runSpecOrchestration({}, { signal: new AbortController().signal }, [], specProfile('serial', {
            ' 守夜': { systemPrompt: 'NIGHT-A' },
            '守夜 ': { systemPrompt: 'NIGHT-B' },
        }));
        expect(agentRequests).toHaveLength(1);
        expect(agentRequests[0]).not.toMatch(/NIGHT-[AB]/);
    });
});
