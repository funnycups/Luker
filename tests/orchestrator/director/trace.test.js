import { describe, expect, test, jest } from '@jest/globals';
import { runMainAgentLoop } from '../../../public/scripts/extensions/orchestrator/director-runtime.js';
import { createMessageEditorHandle } from '../../../public/scripts/message-takeover.js';

/**
 * Director runtime trace lifecycle.
 *
 * The director runtime threads an optional `trace` object through
 * runMainAgentLoop (and into the dispatcher). When present, each main-
 * agent round and each sub-agent dispatch is recorded into
 * `trace.director` so the runtime-trace popup can render a useful view.
 *
 * These tests exercise the shape contract using the same scripted
 * fakes the rest of director integration uses, plus a hand-built
 * trace object that mirrors what `createOrchestrationRuntimeTrace` +
 * `attachOrchestrationRuntimeDirectorState` would produce in
 * production. We don't import runtime-trace.js directly because it
 * transitively pulls in lib.js (browser-only).
 */
function makeHandle() {
    const chat = [{ mes: '', extra: { reasoning: '' }, is_user: false }];
    const emit = jest.fn(async () => {});
    const handle = createMessageEditorHandle({ generationType: 'normal', flushIntervalMs: 0 });
    handle.setOnUpdate((text, reasoning) => {
        chat[0].mes = text;
        chat[0].extra.reasoning = reasoning;
    });
    return { chat, handle };
}

function makeDirectorTrace() {
    return {
        runId: 'test',
        chatKey: '',
        status: 'running',
        mode: 'director',
        director: {
            mainAgent: { conversation: { messages: [] }, failedRounds: [] },
            subagents: [],
        },
        events: [],
        nextEventSeq: 1,
        attempts: [],
        reviewRerunCount: 0,
    };
}

describe('director runtime trace', () => {
    test('main agent rounds are visible via conversation messages with _round + reasoning', async () => {
        const { chat, handle } = makeHandle();
        const trace = makeDirectorTrace();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };
        const calls = [
            [{ id: 't1', name: 'write_message', args: { text: 'Hi.', mode: 'append' } }],
            [{ id: 't2', name: 'finalize', args: {} }],
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => ({
            assistantText: i === 0 ? 'thinking before action' : '',
            toolCalls: calls[i++] || [],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));

        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', mainAgent: {}, subAgents: [], maxRounds: 5, tools: {} },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                trace,
            },
        });

        const msgs = trace.director.mainAgent.conversation.messages;
        // Two LLM calls → two assistant turns in the conversation,
        // tagged with sequential `_round` numbers.
        const assistantTurns = msgs.filter(m => m.role === 'assistant');
        expect(assistantTurns).toHaveLength(2);
        expect(assistantTurns[0]).toEqual(expect.objectContaining({
            _round: 0,
            content: 'thinking before action',
        }));
        expect(assistantTurns[0].tool_calls[0]).toEqual(expect.objectContaining({
            function: expect.objectContaining({ name: 'write_message' }),
        }));
        expect(assistantTurns[1]).toEqual(expect.objectContaining({
            _round: 1,
        }));
        expect(assistantTurns[1].tool_calls[0]).toEqual(expect.objectContaining({
            function: expect.objectContaining({ name: 'finalize' }),
        }));
        // Successful runs leave failedRounds empty.
        expect(trace.director.mainAgent.failedRounds).toEqual([]);
    });

    test('main agent conversation alias mirrors the live messages array', async () => {
        const { chat, handle } = makeHandle();
        const trace = makeDirectorTrace();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };
        const fakeStream = jest.fn(async () => ({
            assistantText: 'done',
            toolCalls: [{ id: 't1', name: 'finalize', args: {} }],
            reasoning: null,
            finishReason: 'tool_calls',
        }));

        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', mainAgent: {}, subAgents: [], maxRounds: 5, tools: {} },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                trace,
            },
        });

        // The conversation alias should now point at the runtime's
        // messages array — which includes a system prompt at minimum.
        const msgs = trace.director.mainAgent.conversation?.messages;
        expect(Array.isArray(msgs)).toBe(true);
        expect(msgs.length).toBeGreaterThan(0);
        expect(msgs[0]?.role).toBe('system');
        // Tool-call round must have pushed an assistant turn + tool result.
        expect(msgs.some(m => m.role === 'assistant' && Array.isArray(m.tool_calls))).toBe(true);
        expect(msgs.some(m => m.role === 'tool')).toBe(true);
    });

    test('sub-agent dispatches are recorded with completed status + output text', async () => {
        const { chat, handle } = makeHandle();
        const trace = makeDirectorTrace();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };
        const mainCalls = [
            [{ id: 't1', name: 'dispatch_subagent', args: { subagentId: 'critic', task: 'critique pacing' } }],
            [{ id: 't2', name: 'await_subagents', args: { handles: ['subagent-0'] } }],
            [{ id: 't3', name: 'finalize', args: {} }],
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: mainCalls[i++] || [],
            reasoning: null,
            finishReason: 'tool_calls',
        }));
        const fakeSubagent = jest.fn(async () => ({
            assistantText: 'pacing reads OK',
            toolCalls: [],
            reasoning: null,
            finishReason: 'stop',
        }));

        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                mainAgent: {},
                subAgents: [{ id: 'critic', description: 'c', systemPrompt: 'c' }],
                maxRounds: 5,
                maxConcurrentSubagents: 2,
                maxTotalSubagentRuns: 5,
                tools: {},
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: fakeSubagent,
                chat,
                trace,
            },
        });

        expect(trace.director.subagents).toHaveLength(1);
        const entry = trace.director.subagents[0];
        expect(entry).toEqual(expect.objectContaining({
            handleId: 'subagent-0',
            subagentId: 'critic',
            isInline: false,
            task: 'critique pacing',
            status: 'completed',
            outputText: 'pacing reads OK',
        }));
        // Conversation alias is populated by the dispatcher (sub-agent's
        // own messages array).
        expect(Array.isArray(entry.conversation?.messages)).toBe(true);
        expect(entry.conversation.messages.length).toBeGreaterThan(0);
        // The dispatch entry's task brief lands as the last system-role
        // message wrapped in <task>.
        const taskMsg = entry.conversation.messages[entry.conversation.messages.length - 1];
        expect(taskMsg?.role).toBe('system');
        expect(taskMsg?.content).toMatch(/<task>[\s\S]*critique pacing[\s\S]*<\/task>/);
    });

    test('inline dispatch shows up with isInline=true + systemPromptPreview', async () => {
        const { chat, handle } = makeHandle();
        const trace = makeDirectorTrace();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };
        const mainCalls = [
            [{ id: 't1', name: 'dispatch_inline_subagent', args: { systemPrompt: 'You are a temporary specialist that examines tone shifts.', task: 'check the last paragraph' } }],
            [{ id: 't2', name: 'await_subagents', args: { handles: ['subagent-0'] } }],
            [{ id: 't3', name: 'finalize', args: {} }],
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: mainCalls[i++] || [],
            reasoning: null,
            finishReason: 'tool_calls',
        }));
        const fakeSubagent = jest.fn(async () => ({
            assistantText: 'tone is fine',
            toolCalls: [],
            reasoning: null,
            finishReason: 'stop',
        }));

        await runMainAgentLoop({
            handle,
            profile: {
                mode: 'director',
                mainAgent: {},
                subAgents: [],
                maxRounds: 5,
                maxTotalSubagentRuns: 5,
                tools: {},
            },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: fakeSubagent,
                chat,
                trace,
            },
        });

        expect(trace.director.subagents).toHaveLength(1);
        expect(trace.director.subagents[0]).toEqual(expect.objectContaining({
            isInline: true,
            subagentId: '(inline)',
            status: 'completed',
            outputText: 'tone is fine',
        }));
        expect(trace.director.subagents[0].systemPromptPreview).toContain('temporary specialist');
    });

    test('synthetic-error paths (unknown id, budget exhausted, empty inline prompt) also record entries', async () => {
        const { chat, handle } = makeHandle();
        const trace = makeDirectorTrace();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };
        const mainCalls = [
            // Unknown id — synthetic error.
            [{ id: 't1', name: 'dispatch_subagent', args: { subagentId: 'no_such_role', task: 't' } }],
            // Empty inline systemPrompt — synthetic error.
            [{ id: 't2', name: 'dispatch_inline_subagent', args: { systemPrompt: '   ', task: 't' } }],
            [{ id: 't3', name: 'finalize', args: {} }],
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: mainCalls[i++] || [],
            reasoning: null,
            finishReason: 'tool_calls',
        }));

        await runMainAgentLoop({
            handle,
            profile: { mode: 'director', mainAgent: {}, subAgents: [], maxRounds: 5, tools: {} },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                trace,
            },
        });

        // Both synthetic-error dispatches should still appear in the
        // trace — users debugging via the trace popup need to see them.
        expect(trace.director.subagents).toHaveLength(2);
        for (const entry of trace.director.subagents) {
            expect(entry.status).toBe('failed');
            expect(entry.error.length).toBeGreaterThan(0);
        }
    });

    test('no-tool-call exhaustion records a failed round in failedRounds before throwing', async () => {
        // Regression: previously the push to `trace.director.mainAgent.rounds`
        // happened only after the retry loop broke (success path). When the
        // agent never produced a tool call and `noToolRetries > maxNoToolRetries`
        // triggered, the throw skipped the push entirely, leaving the trace
        // popup with zero rounds even though `### [main-N] (failed: no tool
        // call)` was already in the reasoning fold. After the round-card
        // unification, success rounds live on `conversation.messages` and
        // failure rounds live on `failedRounds[]` — the renderer interleaves
        // them by `round`. This test guards the sidecar push path.
        const { chat, handle } = makeHandle();
        const trace = makeDirectorTrace();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };
        // Agent always returns assistantText but never tool_calls. Default
        // settings give maxNoToolRetries=0, so the runtime calls the model
        // exactly once, then throws.
        const fakeStream = jest.fn(async () => ({
            assistantText: 'reasoning-only reply, no tool call',
            toolCalls: [],
            reasoning: null,
            finishReason: 'stop',
            usage: null,
            raw: null,
        }));

        await expect(runMainAgentLoop({
            handle,
            profile: { mode: 'director', mainAgent: {}, subAgents: [], maxRounds: 5, tools: {} },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                trace,
            },
        })).rejects.toThrow(/Main agent produced no tool call after/);

        // The failed round lives on the sidecar; messages stays free of
        // the failed assistant turn (the retry contract requires the
        // history get re-requested).
        expect(trace.director.mainAgent.failedRounds).toHaveLength(1);
        const r = trace.director.mainAgent.failedRounds[0];
        expect(r.round).toBe(0);
        expect(r.reason).toBe('no-tool-call');
        expect(r.assistantText).toBe('reasoning-only reply, no tool call');
        // No assistant turn pushed to messages.
        expect(trace.director.mainAgent.conversation.messages.some(m => m.role === 'assistant')).toBe(false);
        // And reasoning fold still has the `(failed: no tool call)` section
        // header — proving the two recording paths (reasoning + trace) are
        // consistent.
        expect(chat[0].extra.reasoning).toContain('### [main-0] (failed: no tool call)');
    });

    test('no-tool-call exhaustion after a successful prior round splits cleanly across messages + failedRounds', async () => {
        // Reinforces the contract: when round 0 succeeds (tool call) and
        // round 1 exhausts retries (no tool call), the successful round
        // sits in conversation.messages with `_round: 0`, and the failed
        // round sits in failedRounds with `round: 1` — the renderer
        // interleaves them in order.
        const { chat, handle } = makeHandle();
        const trace = makeDirectorTrace();
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };
        const calls = [
            // round 0: agent writes a draft, doesn't finalize
            [{ id: 't1', name: 'write_message', args: { text: 'draft body', mode: 'append' } }],
            // round 1: agent goes silent — no tool calls
            [],
        ];
        let i = 0;
        const fakeStream = jest.fn(async () => ({
            assistantText: i === 0 ? 'I will draft something.' : 'just thinking out loud',
            toolCalls: calls[i++] || [],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));

        await expect(runMainAgentLoop({
            handle,
            profile: { mode: 'director', mainAgent: {}, subAgents: [], maxRounds: 5, tools: {} },
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                trace,
            },
        })).rejects.toThrow(/Main agent produced no tool call after/);

        // Successful round 0 → on messages.
        const assistantTurns = trace.director.mainAgent.conversation.messages.filter(m => m.role === 'assistant');
        expect(assistantTurns).toHaveLength(1);
        expect(assistantTurns[0]._round).toBe(0);
        expect(assistantTurns[0].tool_calls[0]).toEqual(expect.objectContaining({
            function: expect.objectContaining({ name: 'write_message' }),
        }));
        // Failed round 1 → on sidecar.
        expect(trace.director.mainAgent.failedRounds).toHaveLength(1);
        expect(trace.director.mainAgent.failedRounds[0].round).toBe(1);
        expect(trace.director.mainAgent.failedRounds[0].reason).toBe('no-tool-call');
        expect(trace.director.mainAgent.failedRounds[0].assistantText).toBe('just thinking out loud');
    });
});
