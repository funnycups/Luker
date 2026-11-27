import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import yaml from 'yaml';

const __extensionSettings = {
    orchestrator: {
        agendaPlannerMaxRounds: 6,
        agendaMaxConcurrentAgents: 3,
        agendaMaxTotalRuns: 24,
        nodeIterationMaxRounds: 3,
        reviewRerunMaxRounds: 1,
    },
};

globalThis.Luker = {
    __settings: __extensionSettings,
    getContext: () => ({
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        },
        lib: { yaml },
        extensionSettings: __extensionSettings,
        connectionProfiles: { list: () => [] },
        skills: { list: async () => [] },
        stopGeneration: () => {},
    }),
};

const plannerCalls = [];
const agentCalls = [];
const plannerResponses = [];
const agentResponses = [];

let callSeq = 0;
function makeGenerateTaskStub() {
    return async (opts) => {
        const requiredName = opts?.functionCallOptions?.requiredFunctionName || opts?.toolChoice?.function?.name || '';
        callSeq += 1;
        if (requiredName === 'luker_orch_planner_step') {
            plannerCalls.push(opts);
            if (plannerResponses.length === 0) {
                throw new Error('Planner LLM stub exhausted');
            }
            return {
                toolCalls: [{ id: `tc_plan_${callSeq}`, name: requiredName, args: plannerResponses.shift() }],
            };
        }
        agentCalls.push(opts);
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
    };
}

let resolveAgendaLimits;
let buildAgendaSharedContextText;
let normalizeAgendaDispatches;
let runAgendaOrchestration;
let clearCurrentRun;

beforeAll(async () => {
    ({
        resolveAgendaLimits,
        buildAgendaSharedContextText,
        normalizeAgendaDispatches,
        runAgendaOrchestration,
    } = await import('../../public/scripts/extensions/orchestrator/agenda-runtime.js'));
    ({ clearCurrentRun } = await import('../../public/scripts/extensions/orchestrator/run-state/store.js'));
});

beforeEach(() => {
    __extensionSettings.orchestrator.agendaPlannerMaxRounds = 6;
    __extensionSettings.orchestrator.agendaMaxConcurrentAgents = 3;
    __extensionSettings.orchestrator.agendaMaxTotalRuns = 24;
    __extensionSettings.orchestrator.nodeIterationMaxRounds = 3;
    __extensionSettings.orchestrator.reviewRerunMaxRounds = 1;
    plannerCalls.length = 0;
    agentCalls.length = 0;
    plannerResponses.length = 0;
    agentResponses.length = 0;
    clearCurrentRun();
});

describe('agenda-runtime profile limits resolution and enforcement', () => {
    test('resolveAgendaLimits uses profile.limits and falls back to canonical defaults when omitted or invalid', () => {
        expect(resolveAgendaLimits(
            { limits: { plannerMaxRounds: 2, maxConcurrentAgents: 1, maxTotalRuns: 5 } },
        )).toEqual({
            plannerMaxRounds: 2,
            maxConcurrentAgents: 1,
            maxTotalRuns: 5,
        });

        expect(resolveAgendaLimits(
            { limits: { maxConcurrentAgents: 1 } },
        )).toEqual({
            plannerMaxRounds: 6,
            maxConcurrentAgents: 1,
            maxTotalRuns: 24,
        });

        expect(resolveAgendaLimits(
            { limits: { plannerMaxRounds: 0, maxConcurrentAgents: -2, maxTotalRuns: Number.NaN } },
        )).toEqual({
            plannerMaxRounds: 6,
            maxConcurrentAgents: 3,
            maxTotalRuns: 24,
        });

        expect(resolveAgendaLimits(null)).toEqual({
            plannerMaxRounds: 6,
            maxConcurrentAgents: 3,
            maxTotalRuns: 24,
        });
    });

    test('buildAgendaSharedContextText emits profile.limits values rather than legacy globals', () => {
        const profile = {
            limits: {
                plannerMaxRounds: 2,
                maxConcurrentAgents: 1,
                maxTotalRuns: 5,
            },
        };
        const text = buildAgendaSharedContextText(
            {},
            {},
            [{ is_user: true, mes: 'Hello there' }],
            profile,
        );

        expect(text).toContain('planner_max_rounds: 2');
        expect(text).toContain('max_concurrent_agents: 1');
        expect(text).toContain('max_total_runs: 5');
    });

    test('normalizeAgendaDispatches slices dispatches using profile.limits.maxConcurrentAgents and remaining maxTotalRuns', () => {
        const profile = {
            agents: {
                scout: { systemPrompt: 's' },
                analyst: { systemPrompt: 'a' },
            },
            limits: {
                plannerMaxRounds: 4,
                maxConcurrentAgents: 1,
                maxTotalRuns: 5,
            },
        };
        const state = { todos: [], runs: [] };
        const step = {
            dispatches: [
                { todo_id: 't1', agent: 'scout', task_brief: 'first', input_run_ids: [] },
                { todo_id: 't2', agent: 'analyst', task_brief: 'second', input_run_ids: [] },
                { todo_id: 't3', agent: 'scout', task_brief: 'third', input_run_ids: [] },
            ],
        };

        const firstBatch = normalizeAgendaDispatches(state, step, profile, __extensionSettings.orchestrator);
        expect(firstBatch).toHaveLength(1);
        expect(firstBatch[0].todoId).toBe('t1');

        // Raise concurrency to 4, but with 4 prior runs and maxTotalRuns=5 only 1 budget slot remains.
        const nearCapProfile = {
            ...profile,
            limits: { plannerMaxRounds: 4, maxConcurrentAgents: 4, maxTotalRuns: 5 },
        };
        const nearCapState = {
            todos: [],
            runs: [{ runId: 'r1' }, { runId: 'r2' }, { runId: 'r3' }, { runId: 'r4' }],
        };
        const secondBatch = normalizeAgendaDispatches(nearCapState, step, nearCapProfile, __extensionSettings.orchestrator);
        expect(secondBatch).toHaveLength(1);
        expect(secondBatch[0].todoId).toBe('t1');
    });

    test('runAgendaOrchestration enforces profile.limits.maxConcurrentAgents and maxTotalRuns loop cap', async () => {
        const profile = {
            mode: 'agenda',
            planner: { systemPrompt: 'Plan carefully.', userPromptTemplate: 'Plan turn.' },
            agents: {
                worker: { systemPrompt: 'Work.', userPromptTemplate: '' },
                finalizer: { systemPrompt: 'Finalize.', userPromptTemplate: '' },
            },
            finalAgentId: 'finalizer',
            limits: {
                plannerMaxRounds: 5,
                maxConcurrentAgents: 1,
                maxTotalRuns: 2,
            },
        };

        // Round 1 proposes 2 dispatches; maxConcurrentAgents=1 caps execution to 1 run.
        plannerResponses.push({
            dispatches: [
                { todo_id: 't1', agent: 'worker', task_brief: 'task 1', input_run_ids: [] },
                { todo_id: 't2', agent: 'worker', task_brief: 'task 2', input_run_ids: [] },
            ],
        });
        // Round 2 proposes 2 more; maxConcurrentAgents=1 caps to 1 run -> totalRuns reaches 2 === maxTotalRuns -> loop stops before round 3.
        plannerResponses.push({
            dispatches: [
                { todo_id: 't3', agent: 'worker', task_brief: 'task 3', input_run_ids: [] },
                { todo_id: 't4', agent: 'worker', task_brief: 'task 4', input_run_ids: [] },
            ],
        });
        // Should never be reached because maxTotalRuns=2 stops the loop after round 2.
        plannerResponses.push({
            dispatches: [
                { todo_id: 't5', agent: 'worker', task_brief: 'task 5', input_run_ids: [] },
            ],
        });

        agentResponses.push(
            { text: 'worker output 1' },
            { text: 'worker output 2' },
            { text: 'final guidance capsule' },
        );

        const context = {
            chat: [{ is_user: true, mes: 'Go.' }],
            chatId: 'agenda-limits-chat',
            generateTask: makeGenerateTaskStub(),
        };
        const payload = { type: 'normal', signal: new AbortController().signal };

        const result = await runAgendaOrchestration(context, payload, context.chat, profile);

        expect(plannerCalls).toHaveLength(2);
        const plannerUserText = plannerCalls[0].taskMessages.find(m => m.role === 'user')?.content || '';
        expect(plannerUserText).toContain('max_concurrent_agents: 1');
        expect(plannerUserText).toContain('max_total_runs: 2');

        expect(result.agendaState.runs.filter(r => r.kind === 'agent')).toHaveLength(2);
        expect(result.agendaState.finalGuidance).toBe('final guidance capsule');
        expect(result.stageOutputs[0].nodes[0].output).toBe('final guidance capsule');
    });
});
