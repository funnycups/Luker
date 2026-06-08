import { describe, expect, test, jest } from '@jest/globals';
import { runMainAgentLoop } from '../../../public/scripts/extensions/orchestrator/director-runtime.js';
import { createSubagentDispatcher } from '../../../public/scripts/extensions/orchestrator/director-tools.js';
import { createMessageEditorHandle } from '../../../public/scripts/message-takeover.js';

// Abort discipline tests. The main director loop must stop dispatching
// work the moment the caller-provided abortSignal fires:
//   - no more tools execute in the current round
//   - no more rounds start
//   - long-running `await_subagents` returns quickly without waiting
//     for the sub-agents themselves to drain
//
// Without these checks the user clicks stop, sees more requests fire,
// and a fast follow-up regenerate lands on the same chat slot while
// the stale loop is still writing — the dual-write race described in
// the takeover-handle auto-abort tests.

function makeHandle(abortSignal) {
    const chat = [{ mes: '', extra: { reasoning: '' }, is_user: false }];
    const handle = createMessageEditorHandle({
        generationType: 'normal',
        flushIntervalMs: 0,
        abortSignal,
    });
    handle.setOnUpdate((text, reasoning) => {
        chat[0].mes = text;
        chat[0].extra.reasoning = reasoning;
    });
    return { chat, handle };
}

describe('director abort discipline — main-agent tool loop', () => {
    test('signal abort mid-tool stops the loop before the next tool in the same round runs', async () => {
        const ac = new AbortController();
        const { chat, handle } = makeHandle(ac.signal);
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: ac.signal,
        };

        const toolCallsFired = [];
        const fakeStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: [
                { id: 't1', name: 'mark_a', args: {} },
                { id: 't2', name: 'mark_b', args: {} },
                { id: 't3', name: 'mark_c', args: {} },
            ],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));

        const executeLoopTool = jest.fn(async (name) => {
            toolCallsFired.push(name);
            if (name === 'mark_a') {
                // User clicks stop while mark_a is executing.
                ac.abort();
            }
            return { ok: true };
        });

        try {
            await runMainAgentLoop({
                handle,
                profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 5, tools: {} } },
                eventData: ev,
                deps: {
                    generateTaskStreamForMainAgent: fakeStream,
                    generateTask: jest.fn(),
                    executeLoopTool,
                    chat,
                },
            });
        } catch (_) { /* loop may throw or return on abort — both are fine */ }

        // Only mark_a ran. mark_b and mark_c must NOT have been called
        // — the loop saw the aborted signal between iterations and
        // bailed out of the tool loop.
        expect(toolCallsFired).toEqual(['mark_a']);
        // And no second round fired either.
        expect(fakeStream).toHaveBeenCalledTimes(1);
    });

    test('signal abort between rounds prevents the next round-start request', async () => {
        const ac = new AbortController();
        const { chat, handle } = makeHandle(ac.signal);
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: ac.signal,
        };

        // Round 0: one tool that aborts. Round 1 should never fire.
        const fakeStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: [{ id: 't1', name: 'mark_only', args: {} }],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));

        const executeLoopTool = jest.fn(async () => {
            ac.abort();
            return { ok: true };
        });

        try {
            await runMainAgentLoop({
                handle,
                profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 5, tools: {} } },
                eventData: ev,
                deps: {
                    generateTaskStreamForMainAgent: fakeStream,
                    generateTask: jest.fn(),
                    executeLoopTool,
                    chat,
                },
            });
        } catch (_) { /* abort-related throws are fine */ }

        expect(fakeStream).toHaveBeenCalledTimes(1);
    });
});

describe('director abort discipline — long-running tools race the signal', () => {
    test('signal abort during a hanging tool unblocks the loop instead of waiting for the tool to resolve', async () => {
        // A tool whose promise never resolves on its own — e.g. a
        // sub-agent dispatcher whose transport is ignoring the abort
        // signal, or a remote fetch that has stalled mid-stream. The
        // loop must not be hostage to it: once the user-side signal
        // aborts, the loop should unwind within a small bounded delay
        // rather than blocking on the dead promise until Jest times
        // out at 5s.
        const ac = new AbortController();
        const { chat, handle } = makeHandle(ac.signal);
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            finalPrompt: '',
            generateData: {},
            takeoverHandle: handle,
            abortSignal: ac.signal,
        };

        // Round 0: one tool call that hangs forever.
        const fakeStream = jest.fn(async () => ({
            assistantText: '',
            toolCalls: [{ id: 't1', name: 'hang_forever', args: {} }],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));

        const executeLoopTool = jest.fn(() => new Promise(() => { /* never resolves */ }));

        // Fire abort once we are clearly inside the hanging tool.
        setTimeout(() => ac.abort(), 50);

        const startedAt = Date.now();
        try {
            await runMainAgentLoop({
                handle,
                profile: { mode: 'director', director: { mainAgent: {}, subAgents: [], maxRounds: 5, tools: {} } },
                eventData: ev,
                deps: {
                    generateTaskStreamForMainAgent: fakeStream,
                    generateTask: jest.fn(),
                    executeLoopTool,
                    chat,
                },
            });
        } catch (_) { /* abort-related throws are fine */ }
        const elapsed = Date.now() - startedAt;

        // If the loop is held hostage by the hanging tool, this hits
        // Jest's default 5s timeout and the test fails as "exceeded
        // timeout". A working signal race unwinds in a small multiple
        // of the 50ms abort delay.
        expect(elapsed).toBeLessThan(2000);
    });
});

describe('director abort discipline — sub-agent tool loop', () => {
    test('sub-agent dispatched then aborted unwinds its own tool loop instead of dangling on a hung tool', async () => {
        // Drive createSubagentDispatcher directly so the test exercises
        // the sub-agent's internal abort discipline without depending on
        // the main loop's awaitAll race (which would unblock the parent
        // anyway, masking whether the sub-agent itself cleaned up).
        // Without the sub-agent's `throwIfAborted` + raceAbortSignal
        // around `executeLoopTool`, the sub-agent promise would dangle
        // forever even after the parent signal aborted.
        const ac = new AbortController();
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            flushIntervalMs: 0,
            abortSignal: ac.signal,
        });

        // Single tool-call round that calls a never-resolving tool.
        const fakeSubStream = jest.fn(() => {
            const stream = (async function* () { /* no chunks */ })();
            const result = Promise.resolve({
                assistantText: '',
                toolCalls: [{ id: 'h1', name: 'hang_forever', args: {} }],
                reasoning: null,
                finishReason: 'tool_calls',
                usage: null,
                raw: null,
            });
            return { stream, result };
        });

        let toolCallCount = 0;
        const executeLoopTool = jest.fn(() => {
            toolCallCount++;
            return new Promise(() => { /* never resolves */ });
        });

        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 'slowpoke', description: 'd', systemPrompt: 's' }],
            directorProfile: { subAgents: [{ id: 'slowpoke' }], skills: {} },
            limits: { maxRounds: 5, maxConcurrentSubagents: 2, maxTotalSubagentRuns: 5 },
            settings: { toolCallRetryMax: 0 },
            generateTask: jest.fn(),
            generateTaskStream: fakeSubStream,
            handle,
            getContentPayload: () => ({ messages: [] }),
            abortSignal: ac.signal,
            tools: {},
            executeLoopTool,
            chat: [],
            contextForNotes: null,
            customToolRegistry: null,
        });

        // Fire abort once the sub-agent has plausibly entered its
        // hanging tool. 100ms is generous on every platform Jest runs on.
        setTimeout(() => ac.abort(), 100);

        const startedAt = Date.now();
        const handleId = await dispatcher.dispatch({ subagentId: 'slowpoke', task: 'wait' });
        const [result] = await dispatcher.awaitAll([handleId]);
        const elapsed = Date.now() - startedAt;

        // The sub-agent must reach its tool loop (otherwise the test
        // proves nothing about the tool-loop fix). On failure, inspect
        // `result.error` to see why the sub-agent bailed early.
        expect(toolCallCount).toBe(1);
        // The sub-agent promise must settle within a small multiple of
        // the abort delay — not hang on the never-resolving tool.
        expect(elapsed).toBeLessThan(2500);
        // And it must end in cancelled state, not as a completed reply.
        expect(result).toMatchObject({ handleId, error: 'cancelled' });
    });
});
