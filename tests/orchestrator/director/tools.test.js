import { describe, expect, test, jest } from '@jest/globals';
import { createMessageEditorHandle } from '../../../public/scripts/message-takeover.js';
import {
    buildMainAgentToolSchemas,
    buildSubAgentToolSchemas,
    executeWriteMessageTool,
    executeApplyPatchesTool,
    executeFinalizeTool,
    executeGetDraftTool,
    createSubagentDispatcher,
} from '../../../public/scripts/extensions/orchestrator/director-tools.js';

function setupHandle({ initialText = '', generationType = 'normal' } = {}) {
    const chat = [{ mes: initialText, extra: { reasoning: '' }, is_user: false }];
    const emit = jest.fn(async () => {});
    const handle = createMessageEditorHandle({ generationType, originalText: initialText, flushIntervalMs: 0 });
    handle.setOnUpdate((text, reasoning) => {
        chat[0].mes = text;
        chat[0].extra.reasoning = reasoning;
    });
    return { chat, handle };
}

describe('tool schemas', () => {
    test('main-agent set includes collaboration + message-production + loop tools', () => {
        const schemas = buildMainAgentToolSchemas({
            subAgents: [{ id: 'critic', description: 'crit' }],
            tools: {
                chat: { read_range: true, search: true },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                note: { add: false, delete: false },
                search: { search: false, visit: false },
                finalize: false,
            },
        });
        const names = schemas.map(s => s.function.name).sort();
        expect(names).toContain('dispatch_subagent');
        expect(names).toContain('await_subagents');
        expect(names).toContain('cancel_subagent');
        expect(names).toContain('write_message');
        expect(names).toContain('apply_message_patches');
        expect(names).toContain('get_draft');
        expect(names).toContain('finalize');
        // chat tools enabled, others disabled
        expect(names.some(n => n.startsWith('chat_'))).toBe(true);
        expect(names.some(n => n.startsWith('lorebook_'))).toBe(false);
    });

    test('sub-agent set includes get_draft + loop tools, excludes collaboration / message-editing tools', () => {
        const schemas = buildSubAgentToolSchemas({
            tools: {
                chat: { read_range: true, search: true },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                note: { add: false, delete: false },
                search: { search: false, visit: false },
                finalize: false,
            },
        });
        const names = schemas.map(s => s.function.name);
        // Excluded: dispatch / await / cancel / write / patches / finalize
        expect(names).not.toContain('dispatch_subagent');
        expect(names).not.toContain('await_subagents');
        expect(names).not.toContain('cancel_subagent');
        expect(names).not.toContain('write_message');
        expect(names).not.toContain('apply_message_patches');
        expect(names).not.toContain('finalize');
        // Included: get_draft (always) + enabled loop tools
        expect(names).toContain('get_draft');
        expect(names.some(n => n.startsWith('chat_'))).toBe(true);
    });

    test('main agent without configured sub-agents still gets inline-dispatch + await/cancel + message-production', () => {
        const schemas = buildMainAgentToolSchemas({ subAgents: [], tools: {} });
        const names = schemas.map(s => s.function.name);
        // dispatch_subagent (by id) only when there ARE configured sub-agents.
        expect(names).not.toContain('dispatch_subagent');
        // dispatch_inline_subagent, await_subagents, cancel_subagent are always
        // available — they work with any handle regardless of how it was
        // dispatched, so withholding them when no sub-agents are configured
        // would leave the main agent unable to use the inline path at all.
        expect(names).toContain('dispatch_inline_subagent');
        expect(names).toContain('await_subagents');
        expect(names).toContain('cancel_subagent');
        expect(names).toContain('get_draft');
        expect(names).toContain('write_message');
        expect(names).toContain('finalize');
    });

    test('dispatch_subagent appears only when subAgents.length > 0; dispatch_inline_subagent always appears', () => {
        const withSubs = buildMainAgentToolSchemas({ subAgents: [{ id: 'c', description: 'crit' }], tools: {} });
        const namesWith = withSubs.map(s => s.function.name);
        expect(namesWith).toContain('dispatch_subagent');
        expect(namesWith).toContain('dispatch_inline_subagent');

        const withoutSubs = buildMainAgentToolSchemas({ subAgents: [], tools: {} });
        const namesWithout = withoutSubs.map(s => s.function.name);
        expect(namesWithout).not.toContain('dispatch_subagent');
        expect(namesWithout).toContain('dispatch_inline_subagent');
    });

    test('sub-agent schema set does NOT include dispatch_inline_subagent (sub-agents cannot recurse)', () => {
        const subSchemas = buildSubAgentToolSchemas({ tools: { chat: { read_range: true } } });
        const subNames = subSchemas.map(s => s.function.name);
        expect(subNames).not.toContain('dispatch_subagent');
        expect(subNames).not.toContain('dispatch_inline_subagent');
        expect(subNames).not.toContain('await_subagents');
        expect(subNames).not.toContain('cancel_subagent');
    });

    test('apply_message_patches schema has no occurrence field', () => {
        const schemas = buildMainAgentToolSchemas({
            subAgents: [],
            tools: {},
        });
        const apply = schemas.find(s => s.function.name === 'apply_message_patches');
        expect(apply).toBeDefined();
        const itemProps = apply.function.parameters.properties.patches.items.properties;
        expect(itemProps).toHaveProperty('kind');
        expect(itemProps).toHaveProperty('find');
        expect(itemProps).toHaveProperty('replaceWith');
        expect(itemProps).not.toHaveProperty('occurrence');
        // Description should instruct the model on context-uniqueness.
        expect(apply.function.description).toMatch(/(unique|surrounding context)/i);
    });
});

describe('get_draft executor', () => {
    test('returns current handle text', async () => {
        const { handle } = setupHandle({ initialText: 'hello world' });
        const result = await executeGetDraftTool(handle);
        expect(result.ok).toBe(true);
        expect(result.text).toBe('hello world');
    });

    test('returns empty string when handle has no text yet', async () => {
        const { handle } = setupHandle({ initialText: '' });
        const result = await executeGetDraftTool(handle);
        expect(result.ok).toBe(true);
        expect(result.text).toBe('');
    });

    test('reflects later mutations (live snapshot, not cached)', async () => {
        const { handle } = setupHandle({ initialText: 'a' });
        const r1 = await executeGetDraftTool(handle);
        await executeWriteMessageTool(handle, { text: 'b', mode: 'append' });
        const r2 = await executeGetDraftTool(handle);
        expect(r1.text).toBe('a');
        expect(r2.text).toBe('ab');
    });

    test('returns error if handle missing', async () => {
        const result = await executeGetDraftTool(null);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/no handle/i);
    });
});

describe('write_message executor', () => {
    test('append mode concatenates', async () => {
        const { chat, handle } = setupHandle({ initialText: 'pre: ' });
        const result = await executeWriteMessageTool(handle, { text: 'after', mode: 'append' });
        expect(result.ok).toBe(true);
        expect(chat[0].mes).toBe('pre: after');
    });

    test('replace mode overwrites', async () => {
        const { chat, handle } = setupHandle({ initialText: 'pre' });
        await executeWriteMessageTool(handle, { text: 'new', mode: 'replace' });
        expect(chat[0].mes).toBe('new');
    });

    test('replace during continue surfaces error in tool result', async () => {
        const { handle } = setupHandle({ initialText: 'prefix', generationType: 'continue' });
        const result = await executeWriteMessageTool(handle, { text: '', mode: 'replace' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/continue/);
    });
});

describe('apply_message_patches executor', () => {
    test('valid context_replace patches succeed', async () => {
        const { chat, handle } = setupHandle({ initialText: 'The cat sat.' });
        const result = await executeApplyPatchesTool(handle, {
            patches: [{ kind: 'context_replace', find: 'cat', replaceWith: 'dog' }],
        });
        expect(result.ok).toBe(true);
        expect(chat[0].mes).toBe('The dog sat.');
    });

    test('ambiguous patch returns error in tool result (no throw)', async () => {
        const { chat, handle } = setupHandle({ initialText: 'cat cat cat' });
        const result = await executeApplyPatchesTool(handle, {
            patches: [{ kind: 'context_replace', find: 'cat', replaceWith: 'dog' }],
        });
        expect(result.ok).toBe(false);
        // Strict structured-failure assertion: rely on the code field, not
        // on prose wording. The error string also carries a `[code]` prefix
        // for agents that only read `result.error`, but the source of truth
        // is the code.
        expect(result.code).toBe('patch_ambiguous');
        expect(result.error).toMatch(/^\[patch_ambiguous\]/);
        // message must not be partially mutated
        expect(chat[0].mes).toBe('cat cat cat');
    });
});

describe('finalize executor', () => {
    test('calls handle.commit and returns ok', async () => {
        const { chat, handle } = setupHandle({ initialText: 'final.' });
        const result = await executeFinalizeTool(handle);
        expect(result.ok).toBe(true);
        const completionResult = await handle.complete;
        expect(completionResult.status).toBe('committed');
        expect(chat[0].mes).toBe('final.');
    });
});

describe('subagent dispatcher', () => {
    test('dispatch returns a handle id, await resolves to fake output', async () => {
        // Inject a fake generateTaskStream so tests do not need real LLM.
        const fakeGenerate = jest.fn(async () => {
            return { assistantText: 'sub-agent output', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });

        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 'critic', description: 'crit', systemPrompt: 'be a critic' }],
            limits: { maxConcurrentSubagents: 2, maxTotalSubagentRuns: 10 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
        });

        const handleA = await dispatcher.dispatch({ subagentId: 'critic', task: 'review this' });
        expect(typeof handleA).toBe('string');

        const awaited = await dispatcher.awaitAll([handleA]);
        expect(awaited).toHaveLength(1);
        expect(awaited[0]).toEqual(expect.objectContaining({
            handleId: handleA,
            subagentId: 'critic',
            outputText: 'sub-agent output',
        }));
        expect(fakeGenerate).toHaveBeenCalledTimes(1);
    });

    test('dispatch with unknown subagentId returns synthetic-error result via await', async () => {
        const dispatcher = createSubagentDispatcher({
            subAgents: [],
            limits: { maxConcurrentSubagents: 1, maxTotalSubagentRuns: 5 },
            generateTask: jest.fn(),
            abortSignal: new AbortController().signal,
        });
        const handleId = await dispatcher.dispatch({ subagentId: 'nope', task: 't' });
        const awaited = await dispatcher.awaitAll([handleId]);
        expect(awaited[0].error).toMatch(/unknown.*sub-?agent|nope/i);
    });

    test('budget exhaustion: dispatch returns budget-exhausted result on Nth + 1 call', async () => {
        const fakeGenerate = jest.fn(async () => ({ assistantText: 'x', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null }));
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxConcurrentSubagents: 1, maxTotalSubagentRuns: 2 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
        });
        const h1 = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        const h2 = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        const h3 = await dispatcher.dispatch({ subagentId: 's', task: 't' });

        const awaited = await dispatcher.awaitAll([h1, h2, h3]);
        const errors = awaited.filter(r => r.error && /budget/i.test(r.error));
        expect(errors).toHaveLength(1);
    });

    test('completion notifications: each successful sub-agent pushes one entry, drained after read', async () => {
        const fakeGenerate = jest.fn(async () => ({ assistantText: 'done', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null }));
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
        });
        const h1 = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        const h2 = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        // Let promises resolve.
        await dispatcher.awaitAll([h1, h2]);

        const notifs = dispatcher.drainCompletionNotifications();
        expect(notifs).toHaveLength(2);
        expect(notifs.every(n => n.status === 'completed')).toBe(true);
        expect(notifs.map(n => n.handleId).sort()).toEqual([h1, h2].sort());

        // Drained set is empty next call.
        const second = dispatcher.drainCompletionNotifications();
        expect(second).toEqual([]);
    });

    test('completion notifications: failed / unknown / budget-exhausted also push entries', async () => {
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 1 },
            generateTask: jest.fn(async () => ({ assistantText: 'x', toolCalls: [], reasoning: null, finishReason: 'stop' })),
            abortSignal: new AbortController().signal,
        });
        const h1 = await dispatcher.dispatch({ subagentId: 's', task: 't' });           // succeeds
        const h2 = await dispatcher.dispatch({ subagentId: 'nope', task: 't' });        // unknown
        const h3 = await dispatcher.dispatch({ subagentId: 's', task: 't' });           // budget exhausted
        await dispatcher.awaitAll([h1, h2, h3]);

        const notifs = dispatcher.drainCompletionNotifications();
        expect(notifs).toHaveLength(3);
        const statusByHandle = Object.fromEntries(notifs.map(n => [n.handleId, n.status]));
        expect(statusByHandle[h1]).toBe('completed');
        expect(statusByHandle[h2]).toBe('failed');
        expect(statusByHandle[h3]).toBe('failed');
    });

    test('cancel: aborts an in-flight sub-agent and pushes a cancelled notification', async () => {
        // Sub-agent that waits long enough to give us a chance to cancel.
        // We yield to the microtask queue and check the signal each round.
        let rounds = 0;
        const fakeGenerate = jest.fn(async (opts) => {
            rounds++;
            // Honour the abort signal — simulate a generation that
            // notices abort mid-flight.
            await new Promise((resolve, reject) => {
                if (opts.abortSignal?.aborted) {
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                    return;
                }
                const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                opts.abortSignal?.addEventListener('abort', onAbort, { once: true });
                setTimeout(() => {
                    opts.abortSignal?.removeEventListener('abort', onAbort);
                    resolve();
                }, 50);
            });
            return { assistantText: 'partial', toolCalls: [], reasoning: null, finishReason: 'stop' };
        });

        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        // Cancel before the timer fires.
        const cancelResult = dispatcher.cancel(h);
        expect(cancelResult.ok).toBe(true);

        const [awaited] = await dispatcher.awaitAll([h]);
        expect(awaited.error).toMatch(/cancel|abort/i);

        const notifs = dispatcher.drainCompletionNotifications();
        const mine = notifs.find(n => n.handleId === h);
        expect(mine).toBeDefined();
        expect(mine.status).toBe('cancelled');
    });

    test('cancel: no-op when handle already completed or unknown', async () => {
        const fakeGenerate = jest.fn(async () => ({ assistantText: 'done', toolCalls: [], reasoning: null, finishReason: 'stop' }));
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        await dispatcher.awaitAll([h]);
        // Now cancel — should not throw, should report alreadyDone.
        const result = dispatcher.cancel(h);
        expect(result).toEqual({ ok: true, alreadyDone: true });
        // Unknown handle also no-ops cleanly.
        const result2 = dispatcher.cancel('no-such-handle');
        expect(result2).toEqual({ ok: true, alreadyDone: true });
    });

    test('sub-agent can call get_draft and see the current draft', async () => {
        const { chat, handle } = setupHandle({ initialText: 'pre-draft body' });
        const calls = [
            // Round 0: call get_draft
            { assistantText: '', toolCalls: [{ id: 't1', name: 'get_draft', args: {} }], reasoning: null, finishReason: 'tool_calls' },
            // Round 1: terminate with output that references the draft length
            { assistantText: 'I saw the draft (14 chars).', toolCalls: [], reasoning: null, finishReason: 'stop' },
        ];
        let i = 0;
        const fakeGenerate = jest.fn(async () => calls[i++] || { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop' });

        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            handle,
            abortSignal: new AbortController().signal,
            // No loop tools enabled — get_draft is wired by the dispatcher itself.
            tools: {},
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        const [awaited] = await dispatcher.awaitAll([h]);
        expect(awaited.outputText).toBe('I saw the draft (14 chars).');
        // Two rounds: one tool-using, one terminating.
        expect(fakeGenerate).toHaveBeenCalledTimes(2);
        // The tool-result chunk for get_draft should have been pushed
        // into the messages — easiest way to verify is that the second
        // round's call opts has the prior round's tool message.
        const secondCallOpts = fakeGenerate.mock.calls[1][0];
        const toolMsg = secondCallOpts.taskMessages.find(m => m.role === 'tool' && m.tool_call_id === 't1');
        expect(toolMsg).toBeDefined();
        const parsed = JSON.parse(toolMsg.content);
        expect(parsed.ok).toBe(true);
        expect(parsed.text).toBe(chat[0].mes);
    });

    test('dispatchInline: runs with caller-provided system prompt + works with empty subAgents list', async () => {
        // Capture the system message the sub-agent actually receives so
        // we can assert it is the INLINE systemPrompt (not silently
        // overridden by a missing profile spec).
        const seenCallOpts = [];
        const fakeGenerate = jest.fn(async (opts) => {
            seenCallOpts.push(opts);
            return { assistantText: 'inline output', toolCalls: [], reasoning: null, finishReason: 'stop' };
        });
        const dispatcher = createSubagentDispatcher({
            // Crucially: NO sub-agents configured. Inline path must still work.
            subAgents: [],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
        });
        const h = await dispatcher.dispatchInline({
            systemPrompt: 'You are an ad-hoc auditor. Find any continuity errors.',
            task: 'go',
        });
        const [awaited] = await dispatcher.awaitAll([h]);
        expect(awaited).toEqual(expect.objectContaining({
            handleId: h,
            subagentId: '(inline)',
            outputText: 'inline output',
        }));
        // System prompt was the inline one (not whatever a missing spec
        // would have produced — which would have been empty). The
        // dispatcher folds the caller-provided systemPrompt onto the
        // `</story_context>` close tag, so it lives in the system message
        // immediately before <task> rather than at the very start.
        const firstCall = seenCallOpts[0];
        const systemOpen = firstCall.taskMessages[0];
        expect(systemOpen).toEqual({ role: 'system', content: '<story_context>' });
        const taskMsg = firstCall.taskMessages[firstCall.taskMessages.length - 1];
        expect(taskMsg).toEqual({ role: 'system', content: '<task>\ngo\n</task>' });
        const closeMsg = firstCall.taskMessages[firstCall.taskMessages.length - 2];
        expect(closeMsg.role).toBe('system');
        expect(closeMsg.content.startsWith('</story_context>')).toBe(true);
        expect(closeMsg.content).toContain('You are an ad-hoc auditor. Find any continuity errors.');
    });

    test('dispatchInline: empty systemPrompt is rejected with error result', async () => {
        const fakeGenerate = jest.fn();
        const dispatcher = createSubagentDispatcher({
            subAgents: [],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
        });
        const h = await dispatcher.dispatchInline({ systemPrompt: '   ', task: 'x' });
        const [awaited] = await dispatcher.awaitAll([h]);
        expect(awaited.error).toMatch(/non-empty systemPrompt/i);
        // LLM never invoked.
        expect(fakeGenerate).not.toHaveBeenCalled();
    });

    test('dispatchInline: shares the totalSubagentRuns budget with dispatch by id', async () => {
        const fakeGenerate = jest.fn(async () => ({ assistantText: 'ok', toolCalls: [], reasoning: null, finishReason: 'stop' }));
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 2 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
        });
        const h1 = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        const h2 = await dispatcher.dispatchInline({ systemPrompt: 'role', task: 't' });
        const h3 = await dispatcher.dispatchInline({ systemPrompt: 'role', task: 't' });  // budget should be hit
        const awaited = await dispatcher.awaitAll([h1, h2, h3]);
        const budgetErrors = awaited.filter(r => r.error && /budget/i.test(r.error));
        expect(budgetErrors).toHaveLength(1);
    });

    test('contextForMemory overlay reaches executeLoopTool so memory_* tools find the store', async () => {
        // Sub-agent calls memory_list_candidates once, then terminates.
        const calls = [
            { assistantText: '', toolCalls: [{ id: 't1', name: 'memory_list_candidates', args: {} }], reasoning: null, finishReason: 'tool_calls' },
            { assistantText: 'done', toolCalls: [], reasoning: null, finishReason: 'stop' },
        ];
        let i = 0;
        const fakeGenerate = jest.fn(async () => calls[i++] || { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop' });

        const seenToolCtx = [];
        const executeLoopTool = jest.fn(async (_name, _args, ctx) => {
            seenToolCtx.push(ctx);
            return { candidates: [{ id: 'n1', type: 'event', title: 'a bird' }] };
        });

        const memCtx = { __memoryStore: { nodes: new Map(), edges: new Map() } };
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
            tools: { memory: { list_candidates: true } },
            executeLoopTool,
            chat: [],
            contextForMemory: memCtx,
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        await dispatcher.awaitAll([h]);

        expect(executeLoopTool).toHaveBeenCalledTimes(1);
        expect(executeLoopTool.mock.calls[0][0]).toBe('memory_list_candidates');
        // The per-call context must carry the memory store the dispatcher
        // was wired with — without this, requireStore() throws MEMORY_DISABLED
        // even when memory-graph is enabled.
        expect(seenToolCtx[0].__memoryStore).toBe(memCtx.__memoryStore);
        // And chat is still forwarded (not clobbered by the overlay).
        expect(seenToolCtx[0].chat).toBeDefined();
    });

    test('without contextForMemory, executeLoopTool sees no __memoryStore (regression guard)', async () => {
        const calls = [
            { assistantText: '', toolCalls: [{ id: 't1', name: 'memory_list_candidates', args: {} }], reasoning: null, finishReason: 'tool_calls' },
            { assistantText: 'done', toolCalls: [], reasoning: null, finishReason: 'stop' },
        ];
        let i = 0;
        const fakeGenerate = jest.fn(async () => calls[i++] || { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop' });

        const seenToolCtx = [];
        const executeLoopTool = jest.fn(async (_name, _args, ctx) => {
            seenToolCtx.push(ctx);
            return { nodes: [] };
        });

        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
            tools: { memory: { list_candidates: true } },
            executeLoopTool,
            chat: [],
            // contextForMemory deliberately omitted.
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        await dispatcher.awaitAll([h]);

        expect(seenToolCtx[0].__memoryStore).toBeUndefined();
        expect(seenToolCtx[0].chat).toBeDefined();
    });
});
