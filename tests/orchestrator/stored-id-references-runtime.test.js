// Agent and preset keys are stored verbatim; agenda dispatch and final
// agent ids and spec node preset refs resolve against them with
// `resolveStoredIdToken`. Only `context.generateTask` (the upstream LLM
// boundary) is stubbed; the real orchestrator and tool-calling pipeline run
// end to end.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

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
        connectionProfiles: { list: () => [] },
        skills: { list: async () => [] },
    }),
};

const plannerResponses = [];
const agentResponses = [];
const agentRequests = [];
let callSeq = 0;

function makeRuntimeContext() {
    return {
        generateTask: async (opts) => {
            const requiredName = opts?.functionCallOptions?.requiredFunctionName || opts?.toolChoice?.function?.name || '';
            callSeq += 1;
            if (requiredName === 'luker_orch_planner_step') {
                if (plannerResponses.length === 0) {
                    throw new Error('Planner LLM stub exhausted');
                }
                return {
                    toolCalls: [{ id: `tc_plan_${callSeq}`, name: requiredName, args: plannerResponses.shift() }],
                };
            }
            agentRequests.push(JSON.stringify(opts));
            if (agentResponses.length === 0) {
                throw new Error('Agent LLM stub exhausted');
            }
            const next = agentResponses.shift();
            if (Array.isArray(next?.toolCalls)) {
                return next;
            }
            return {
                toolCalls: [{ id: `tc_agent_${callSeq}`, name: requiredName || 'luker_orch_submit_result', args: next }],
            };
        },
    };
}

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
const submit = text => ({ toolCalls: [{ id: `tc_${text}`, name: 'luker_orch_submit_result', args: { text } }], text: '', reasoning: '' });
const finalGuidance = text => ({ toolCalls: [{ id: `tc_${text}`, name: 'luker_orch_final_guidance', args: { text } }], text: '', reasoning: '' });

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
        await runAgendaOrchestration(makeRuntimeContext(), { signal: new AbortController().signal }, [], profile);
        expect(agentRequests).toHaveLength(2);
        expect(agentRequests.every(request => request.includes('NIGHT-WATCH-PROMPT'))).toBe(true);
    });

    test('an ambiguous final agent id is not resolved', async () => {
        const profile = agendaProfile({ ' 守夜': { systemPrompt: 'a' }, '守夜 ': { systemPrompt: 'b' } }, '守夜');
        plannerResponses.push({ finalize: 'done.' });
        await expect(runAgendaOrchestration(makeRuntimeContext(), { signal: new AbortController().signal }, [], profile))
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
        await runSpecOrchestration(makeRuntimeContext(), { signal: new AbortController().signal }, [], specProfile(mode, { [PADDED]: { systemPrompt: 'NIGHT-WATCH-PROMPT', userPromptTemplate: 'watch' } }));
        expect(agentRequests).toHaveLength(1);
        expect(agentRequests[0]).toContain('NIGHT-WATCH-PROMPT');
    });

    test('a node ref matching several padded presets runs without either', async () => {
        agentResponses.push(finalGuidance('watched'));
        await runSpecOrchestration(makeRuntimeContext(), { signal: new AbortController().signal }, [], specProfile('serial', {
            ' 守夜': { systemPrompt: 'NIGHT-A' },
            '守夜 ': { systemPrompt: 'NIGHT-B' },
        }));
        expect(agentRequests).toHaveLength(1);
        expect(agentRequests[0]).not.toMatch(/NIGHT-[AB]/);
    });
});
