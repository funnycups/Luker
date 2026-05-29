/**
 * Unit tests for simulation-payload-adapter.js — pure trace → per-mode
 * payload reshape. The adapter is the only orchestrator-side translation
 * between the runtime-trace's bookkeeping shape and the simulation-review
 * renderers' display shape.
 *
 * Field-name notes (vs. the brief's initial sketch):
 *   - Agenda worker attempts don't carry `dispatchTodoId` / `dispatchAgentName`
 *     / `dispatchTaskBrief`. Real shape: `nodeId = "${agent}:${todoId}"`,
 *     `preset = agent`, and `taskBrief` lives on `trace.agenda.runs[]`
 *     (synced state) — the adapter joins by `(agent, todoId)`.
 *   - Round-grouping comes from `stageIndex` for planner/worker (the
 *     runtime uses `round - 1` as `stageIndex`). `final` uses a tail
 *     stageIndex but is identified by `runKind === 'final'`.
 *   - Director subagent success status is `'completed'`, not `'success'`.
 *     COMPLETED_STATUSES = {'completed', 'success'} covers both legacy
 *     director rounds (which were observed to default to 'success' when
 *     unset) and the real runtime's `'completed'` finish status.
 */

import { describe, it, expect } from '@jest/globals';

import {
    exportSpecPayload,
    exportAgendaPayload,
    exportLoopPayload,
    exportDirectorPayload,
} from '../../public/scripts/extensions/orchestrator/simulation-payload-adapter.js';

describe('exportSpecPayload', () => {
    it('builds stages and filters failed tool calls', () => {
        const trace = {
            mode: 'spec',
            stages: [{
                stageIndex: 0,
                id: 's1',
                mode: 'serial',
                nodes: [{
                    stageIndex: 0,
                    nodeIndex: 0,
                    slotKey: '0:0:research',
                    id: 'research',
                    preset: 'p',
                    type: 'worker',
                }],
            }],
            attempts: [
                {
                    stageIndex: 0,
                    nodeIndex: 0,
                    nodeId: 'research',
                    preset: 'p',
                    nodeType: 'worker',
                    runKind: 'worker',
                    status: 'completed',
                    output: 'final-output',
                    conversation: {
                        messages: [
                            {
                                role: 'assistant',
                                content: 'turn1 text',
                                reasoning: 'r1',
                                tool_calls: [
                                    { id: 'a', name: 'read_card', args: { id: 'x' } },
                                    { id: 'b', name: 'bad_tool', args: {} },
                                ],
                            },
                            { role: 'tool', tool_call_id: 'a', content: '{"ok":true,"data":"card"}', name: 'read_card' },
                            { role: 'tool', tool_call_id: 'b', content: '{"ok":false,"error":"boom"}', name: 'bad_tool' },
                        ],
                    },
                },
            ],
        };
        const out = exportSpecPayload(trace);
        expect(out.stages).toHaveLength(1);
        expect(out.stages[0].nodes[0].id).toBe('research');
        expect(out.stages[0].nodes[0].output).toBe('final-output');
        expect(out.stages[0].nodes[0].turns).toHaveLength(1);
        expect(out.stages[0].nodes[0].turns[0].reasoning).toBe('r1');
        expect(out.stages[0].nodes[0].turns[0].toolCalls).toHaveLength(1);
        expect(out.stages[0].nodes[0].turns[0].toolCalls[0].name).toBe('read_card');
        expect(out.stages[0].nodes[0].turns[0].toolCalls[0].result).toEqual({ ok: true, data: 'card' });
    });

    it('drops failed attempts entirely', () => {
        const trace = {
            mode: 'spec',
            stages: [{
                stageIndex: 0,
                id: 's',
                mode: 'serial',
                nodes: [{
                    stageIndex: 0,
                    nodeIndex: 0,
                    slotKey: '0:0:n',
                    id: 'n',
                    preset: 'p',
                    type: 'worker',
                }],
            }],
            attempts: [
                {
                    stageIndex: 0,
                    nodeIndex: 0,
                    nodeId: 'n',
                    preset: 'p',
                    nodeType: 'worker',
                    runKind: 'worker',
                    status: 'failed',
                    conversation: { messages: [] },
                },
                {
                    stageIndex: 0,
                    nodeIndex: 0,
                    nodeId: 'n',
                    preset: 'p',
                    nodeType: 'worker',
                    runKind: 'worker',
                    status: 'completed',
                    output: 'ok',
                    conversation: { messages: [] },
                },
            ],
        };
        const out = exportSpecPayload(trace);
        expect(out.stages[0].nodes[0].output).toBe('ok');
        expect(out.stages[0].nodes[0].turns).toHaveLength(0);
    });
});

describe('exportAgendaPayload', () => {
    it('partitions attempts into planner / dispatches / finalizer', () => {
        // Real runtime shape: agenda dispatch metadata is split across
        //   - attempt.preset           → agent id
        //   - attempt.nodeId           → "${agent}:${todoId}"
        //   - trace.agenda.runs[].taskBrief → task brief, joined by (agent, todoId)
        // and round grouping comes from attempt.stageIndex (round - 1).
        const trace = {
            mode: 'agenda',
            agenda: {
                plannerRounds: 1,
                todos: [],
                runs: [{
                    runId: 'r1',
                    todoId: 't1',
                    agent: 'writer',
                    taskBrief: 'do it',
                    inputRunIds: [],
                    outputText: 'worker out',
                    kind: 'agent',
                }],
                finalGuidance: 'composed',
            },
            attempts: [
                {
                    runKind: 'planner',
                    stageIndex: 0,
                    nodeIndex: 0,
                    nodeId: 'agenda_planner',
                    preset: 'agenda_planner',
                    nodeType: 'worker',
                    status: 'completed',
                    output: 'plan',
                    conversation: { messages: [{ role: 'assistant', content: 'p text', reasoning: 'p-r', tool_calls: [] }] },
                },
                {
                    runKind: 'worker',
                    stageIndex: 0,
                    nodeIndex: 0,
                    nodeId: 'writer:t1',
                    preset: 'writer',
                    nodeType: 'worker',
                    status: 'completed',
                    output: 'worker out',
                    conversation: { messages: [{ role: 'assistant', content: 'w text', reasoning: '', tool_calls: [] }] },
                },
                {
                    runKind: 'final',
                    stageIndex: 1,
                    nodeIndex: 0,
                    nodeId: 'finalizer',
                    preset: 'finalizer',
                    nodeType: 'worker',
                    status: 'completed',
                    output: 'composed',
                    conversation: { messages: [{ role: 'assistant', content: 'f', reasoning: '', tool_calls: [] }] },
                },
            ],
        };
        const out = exportAgendaPayload(trace);
        expect(out.rounds).toHaveLength(1);
        expect(out.rounds[0].planner.output).toBe('plan');
        expect(out.rounds[0].dispatches).toHaveLength(1);
        expect(out.rounds[0].dispatches[0].agentName).toBe('writer');
        expect(out.rounds[0].dispatches[0].todoId).toBe('t1');
        expect(out.rounds[0].dispatches[0].taskBrief).toBe('do it');
        expect(out.rounds[0].dispatches[0].output).toBe('worker out');
        expect(out.finalizer.output).toBe('composed');
        expect(out.finalComposedOutput).toBe('composed');
    });
});

describe('exportLoopPayload', () => {
    it('reads live conversation aliased on trace.loop.conversation', () => {
        const trace = {
            mode: 'loop',
            loop: {
                conversation: {
                    messages: [
                        { role: 'user', content: 'u' },
                        {
                            role: 'assistant',
                            content: 'a1',
                            reasoning: 'r1',
                            tool_calls: [{ id: 'tc1', name: 'read_card', args: {} }],
                        },
                        { role: 'tool', tool_call_id: 'tc1', content: '{"ok":true,"data":"foo"}', name: 'read_card' },
                        {
                            role: 'assistant',
                            content: 'a2',
                            reasoning: '',
                            tool_calls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'cap' } }],
                        },
                    ],
                },
            },
            events: [{ type: 'budget_exhausted' }],
            capsuleText: 'cap',
        };
        const out = exportLoopPayload(trace);
        expect(out.rounds).toHaveLength(2);
        expect(out.rounds[0].assistantText).toBe('a1');
        expect(out.rounds[0].reasoning).toBe('r1');
        expect(out.rounds[0].toolCalls[0].name).toBe('read_card');
        expect(out.rounds[0].toolCalls[0].result).toEqual({ ok: true, data: 'foo' });
        expect(out.capsule).toBe('cap');
        expect(out.terminationReason).toBe('budget');
    });
});

describe('exportDirectorPayload', () => {
    it('reshapes mainAgent rounds + subagents from trace.director', () => {
        const trace = {
            mode: 'director',
            director: {
                mainAgent: {
                    rounds: [
                        {
                            round: 1,
                            assistantText: 'hi',
                            reasoningText: 'r',
                            toolCalls: [{ name: 'await_subagents', args: { handles: ['h1'] }, result: { ok: true } }],
                            // status omitted → treated as success by adapter
                        },
                    ],
                },
                subagents: [
                    {
                        subagentId: 'writer',
                        isInline: false,
                        task: 'go',
                        outputText: 'so',
                        reasoningText: 'sr',
                        // status: 'completed' (real runtime) and 'success' (legacy fixture) both pass
                        status: 'completed',
                    },
                ],
            },
            finalMessage: 'fm',
        };
        const out = exportDirectorPayload(trace);
        expect(out.mainAgent.rounds[0].roundIndex).toBe(0);
        expect(out.mainAgent.rounds[0].assistantText).toBe('hi');
        expect(out.mainAgent.rounds[0].reasoning).toBe('r');
        expect(out.mainAgent.rounds[0].toolCalls[0].name).toBe('await_subagents');
        expect(out.subagents[0].subagentId).toBe('writer');
        expect(out.subagents[0].output).toBe('so');
        expect(out.subagents[0].reasoning).toBe('sr');
        expect(out.finalMessage).toBe('fm');
    });
});
