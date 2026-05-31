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

    test('sub-agent set includes get_draft + submit + loop tools, excludes collaboration / message-editing tools', () => {
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
        // Included: submit (the required terminator), get_draft (always),
        // plus enabled loop tools.
        expect(names).toContain('submit');
        expect(names).toContain('get_draft');
        expect(names.some(n => n.startsWith('chat_'))).toBe(true);
        // Sub-agent submit has a required `output: string` parameter —
        // the dispatcher reads it as the sub-agent's final response.
        const submit = schemas.find(s => s.function.name === 'submit');
        expect(submit.function.parameters.required).toEqual(['output']);
        expect(submit.function.parameters.properties.output.type).toBe('string');
    });

    test('main-agent set does NOT include submit (main owns the message via finalize, not submit)', () => {
        const schemas = buildMainAgentToolSchemas({
            subAgents: [{ id: 'critic', description: 'crit' }],
            tools: {},
        });
        const names = schemas.map(s => s.function.name);
        expect(names).not.toContain('submit');
        // finalize is still how the main agent terminates.
        expect(names).toContain('finalize');
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

    // ── collab.* gating (main-agent sub-agent dispatchers) ──
    //
    // The two dispatcher tools (`dispatch_subagent` by id and
    // `dispatch_inline_subagent`) are user-toggleable from the main-agent
    // tool grid via `tools.collab.<verb>`. `await_subagents` /
    // `cancel_subagent` are companion tools — they only make sense when at
    // least one dispatcher is enabled (without either, there are no
    // handles to wait for or cancel). They auto-hide when both
    // dispatchers are off, auto-show when at least one is on.
    //
    // Default (missing collab namespace) preserves legacy behavior:
    // both dispatchers enabled. Only an explicit `false` disables.

    test('collab.dispatch_subagent: false hides dispatch_subagent even when subAgents are configured', () => {
        const schemas = buildMainAgentToolSchemas({
            subAgents: [{ id: 'critic', description: 'crit' }],
            tools: { collab: { dispatch_subagent: false } },
        });
        const names = schemas.map(s => s.function.name);
        expect(names).not.toContain('dispatch_subagent');
        // inline + companions still present (inline not disabled)
        expect(names).toContain('dispatch_inline_subagent');
        expect(names).toContain('await_subagents');
        expect(names).toContain('cancel_subagent');
    });

    test('collab.dispatch_inline_subagent: false hides dispatch_inline_subagent', () => {
        const schemas = buildMainAgentToolSchemas({
            subAgents: [{ id: 'critic', description: 'crit' }],
            tools: { collab: { dispatch_inline_subagent: false } },
        });
        const names = schemas.map(s => s.function.name);
        expect(names).not.toContain('dispatch_inline_subagent');
        // by-id dispatch + companions still present
        expect(names).toContain('dispatch_subagent');
        expect(names).toContain('await_subagents');
        expect(names).toContain('cancel_subagent');
    });

    test('both dispatchers disabled hides await_subagents and cancel_subagent (no live handles to act on)', () => {
        const schemas = buildMainAgentToolSchemas({
            subAgents: [{ id: 'critic', description: 'crit' }],
            tools: { collab: { dispatch_subagent: false, dispatch_inline_subagent: false } },
        });
        const names = schemas.map(s => s.function.name);
        expect(names).not.toContain('dispatch_subagent');
        expect(names).not.toContain('dispatch_inline_subagent');
        expect(names).not.toContain('await_subagents');
        expect(names).not.toContain('cancel_subagent');
        // Message-production tools unaffected.
        expect(names).toContain('write_message');
        expect(names).toContain('finalize');
    });

    test('only inline disabled: by-id dispatch + await + cancel still present', () => {
        const schemas = buildMainAgentToolSchemas({
            subAgents: [{ id: 'critic', description: 'crit' }],
            tools: { collab: { dispatch_inline_subagent: false, dispatch_subagent: true } },
        });
        const names = schemas.map(s => s.function.name);
        expect(names).toContain('dispatch_subagent');
        expect(names).not.toContain('dispatch_inline_subagent');
        expect(names).toContain('await_subagents');
        expect(names).toContain('cancel_subagent');
    });

    test('missing collab namespace preserves legacy default (both dispatchers + companions enabled)', () => {
        const schemas = buildMainAgentToolSchemas({
            subAgents: [{ id: 'critic', description: 'crit' }],
            tools: {},
        });
        const names = schemas.map(s => s.function.name);
        expect(names).toContain('dispatch_subagent');
        expect(names).toContain('dispatch_inline_subagent');
        expect(names).toContain('await_subagents');
        expect(names).toContain('cancel_subagent');
    });

    test('sub-agent schemas never include collab tools, regardless of flag values', () => {
        const subSchemas = buildSubAgentToolSchemas({
            tools: { collab: { dispatch_subagent: true, dispatch_inline_subagent: true } },
        });
        const subNames = subSchemas.map(s => s.function.name);
        expect(subNames).not.toContain('dispatch_subagent');
        expect(subNames).not.toContain('dispatch_inline_subagent');
        expect(subNames).not.toContain('await_subagents');
        expect(subNames).not.toContain('cancel_subagent');
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
        // The sub-agent must terminate via the `submit` tool (no-tool-call
        // rounds are treated as failed attempts and retried — see
        // SUBMIT_TOOL in director-tools.js).
        const fakeGenerate = jest.fn(async () => {
            return {
                assistantText: '',
                toolCalls: [{ id: 't_submit', name: 'submit', args: { output: 'sub-agent output' } }],
                reasoning: null,
                finishReason: 'tool_calls',
                usage: null,
                raw: null,
            };
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
        const fakeGenerate = jest.fn(async () => ({
            assistantText: '',
            toolCalls: [{ id: 't_submit', name: 'submit', args: { output: 'x' } }],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));
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
        const fakeGenerate = jest.fn(async () => ({
            assistantText: '',
            toolCalls: [{ id: 't_submit', name: 'submit', args: { output: 'done' } }],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        }));
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
            generateTask: jest.fn(async () => ({
                assistantText: '',
                toolCalls: [{ id: 't_submit', name: 'submit', args: { output: 'x' } }],
                reasoning: null,
                finishReason: 'tool_calls',
            })),
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
        const fakeGenerate = jest.fn(async () => ({
            assistantText: '',
            toolCalls: [{ id: 't_submit', name: 'submit', args: { output: 'done' } }],
            reasoning: null,
            finishReason: 'tool_calls',
        }));
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
            // Round 0: call get_draft to read the draft body.
            { assistantText: '', toolCalls: [{ id: 't1', name: 'get_draft', args: {} }], reasoning: null, finishReason: 'tool_calls' },
            // Round 1: terminate via submit, with output referencing the draft length.
            { assistantText: '', toolCalls: [{ id: 't2', name: 'submit', args: { output: 'I saw the draft (14 chars).' } }], reasoning: null, finishReason: 'tool_calls' },
        ];
        let i = 0;
        const fakeGenerate = jest.fn(async () => calls[i++] || { assistantText: '', toolCalls: [{ id: 'tF', name: 'submit', args: { output: 'fallback' } }], reasoning: null, finishReason: 'tool_calls' });

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
            // Snapshot taskMessages because the dispatcher mutates the
            // live array after the fake returns (pushing the assistant
            // turn + tool result for submit). Capturing a slice freezes
            // what the model actually saw on this request.
            seenCallOpts.push({ ...opts, taskMessages: opts.taskMessages.slice() });
            return {
                assistantText: '',
                toolCalls: [{ id: 't_submit', name: 'submit', args: { output: 'inline output' } }],
                reasoning: null,
                finishReason: 'tool_calls',
            };
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
        // dispatcher now wraps the caller-provided systemPrompt in a
        // dedicated <orchestration_role> system message AFTER
        // </story_context> (identity-last: recency bias keeps the role
        // fresh right before <task>; the meta-frame at index 0 tells
        // the model where to look). The story_context open + close are
        // clean boundary tags.
        const firstCall = seenCallOpts[0];
        const metaFrame = firstCall.taskMessages[0];
        expect(metaFrame.role).toBe('system');
        expect(metaFrame.content).toMatch(/orchestration agent/i);
        expect(metaFrame.content).toMatch(/READ-ONLY/);
        const systemOpen = firstCall.taskMessages[1];
        expect(systemOpen).toEqual({ role: 'system', content: '<story_context>' });
        const taskMsg = firstCall.taskMessages[firstCall.taskMessages.length - 1];
        expect(taskMsg).toEqual({ role: 'system', content: '<task>\ngo\n</task>' });
        const roleMsg = firstCall.taskMessages[firstCall.taskMessages.length - 2];
        expect(roleMsg.role).toBe('system');
        expect(roleMsg.content.startsWith('<orchestration_role>')).toBe(true);
        expect(roleMsg.content.endsWith('</orchestration_role>')).toBe(true);
        expect(roleMsg.content).toContain('You are an ad-hoc auditor. Find any continuity errors.');
        const closeMsg = firstCall.taskMessages[firstCall.taskMessages.length - 3];
        expect(closeMsg).toEqual({ role: 'system', content: '</story_context>' });
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
        const fakeGenerate = jest.fn(async () => ({
            assistantText: '',
            toolCalls: [{ id: 't_submit', name: 'submit', args: { output: 'ok' } }],
            reasoning: null,
            finishReason: 'tool_calls',
        }));
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

    test('contextForSession overlay reaches executeLoopTool so memory_* tools find the session', async () => {
        // Sub-agent calls memory_list_candidates once, then terminates via submit.
        const calls = [
            { assistantText: '', toolCalls: [{ id: 't1', name: 'memory_list_candidates', args: {} }], reasoning: null, finishReason: 'tool_calls' },
            { assistantText: '', toolCalls: [{ id: 't2', name: 'submit', args: { output: 'done' } }], reasoning: null, finishReason: 'tool_calls' },
        ];
        let i = 0;
        const fakeGenerate = jest.fn(async () => calls[i++] || { assistantText: '', toolCalls: [{ id: 'tF', name: 'submit', args: { output: 'fallback' } }], reasoning: null, finishReason: 'tool_calls' });

        const seenToolCtx = [];
        const executeLoopTool = jest.fn(async (_name, _args, ctx) => {
            seenToolCtx.push(ctx);
            return { candidates: [{ id: 'n1', type: 'event', title: 'a bird' }] };
        });

        const memCtx = { __memoryGraphSession: { listVisibleCandidates: () => [] } };
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
            tools: { memory: { list_candidates: true } },
            executeLoopTool,
            chat: [],
            contextForSession: memCtx,
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        await dispatcher.awaitAll([h]);

        expect(executeLoopTool).toHaveBeenCalledTimes(1);
        expect(executeLoopTool.mock.calls[0][0]).toBe('memory_list_candidates');
        // The per-call context must carry the memory session the dispatcher
        // was wired with — without this, requireSession() throws MEMORY_DISABLED
        // even when memory-graph is enabled.
        expect(seenToolCtx[0].__memoryGraphSession).toBe(memCtx.__memoryGraphSession);
        // And chat is still forwarded (not clobbered by the overlay).
        expect(seenToolCtx[0].chat).toBeDefined();
    });

    test('contextForNotes overlay reaches executeLoopTool so note_* tools find the floor-state adapter', async () => {
        // Symmetric to the contextForSession overlay: the dispatcher
        // owns contextForNotes for system-prompt "## Open Notes"
        // rendering and must also spread it into the per-tool-call ctx
        // so note_open / note_close can reach `__floorStateForNotes`.
        // Without the spread, sub-agents lose write access to notes
        // even when the adapter is wired by main.js.
        const calls = [
            { assistantText: '', toolCalls: [{ id: 't1', name: 'note_open', args: { text: 'pending' } }], reasoning: null, finishReason: 'tool_calls' },
            { assistantText: '', toolCalls: [{ id: 't2', name: 'submit', args: { output: 'done' } }], reasoning: null, finishReason: 'tool_calls' },
        ];
        let i = 0;
        const fakeGenerate = jest.fn(async () => calls[i++] || { assistantText: '', toolCalls: [{ id: 'tF', name: 'submit', args: { output: 'fallback' } }], reasoning: null, finishReason: 'tool_calls' });

        const seenToolCtx = [];
        const executeLoopTool = jest.fn(async (_name, _args, ctx) => {
            seenToolCtx.push(ctx);
            return { id: 'n1' };
        });

        const notesCtx = {
            __floorStateForNotes: {
                appendForFloor: async () => 'n1',
                listAcrossFloors: async () => [],
                updateStatusById: async () => ({ ok: true }),
            },
        };
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
            tools: { note: { open: true } },
            executeLoopTool,
            chat: [],
            contextForNotes: notesCtx,
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        await dispatcher.awaitAll([h]);

        expect(executeLoopTool).toHaveBeenCalledTimes(1);
        expect(executeLoopTool.mock.calls[0][0]).toBe('note_open');
        expect(seenToolCtx[0].__floorStateForNotes).toBe(notesCtx.__floorStateForNotes);
        expect(seenToolCtx[0].chat).toBeDefined();
    });

    test('without contextForSession, executeLoopTool sees no __memoryGraphSession (regression guard)', async () => {
        const calls = [
            { assistantText: '', toolCalls: [{ id: 't1', name: 'memory_list_candidates', args: {} }], reasoning: null, finishReason: 'tool_calls' },
            { assistantText: '', toolCalls: [{ id: 't2', name: 'submit', args: { output: 'done' } }], reasoning: null, finishReason: 'tool_calls' },
        ];
        let i = 0;
        const fakeGenerate = jest.fn(async () => calls[i++] || { assistantText: '', toolCalls: [{ id: 'tF', name: 'submit', args: { output: 'fallback' } }], reasoning: null, finishReason: 'tool_calls' });

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
            // contextForSession deliberately omitted.
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        await dispatcher.awaitAll([h]);

        expect(seenToolCtx[0].__memoryGraphSession).toBeUndefined();
        expect(seenToolCtx[0].chat).toBeDefined();
    });

    test('sub-agent with tools override gets its own schemas; sub-agent without override inherits profile defaults', async () => {
        // Capture the `tools` schema array passed to generateTask so we can
        // assert what each sub-agent dispatch actually saw.
        const seenSchemas = [];
        const fakeGenerate = jest.fn(async (opts) => {
            const names = (opts.tools || []).map(s => s?.function?.name).filter(Boolean).sort();
            seenSchemas.push(names);
            return {
                assistantText: '',
                toolCalls: [{ id: 't_submit', name: 'submit', args: { output: 'ok' } }],
                reasoning: null,
                finishReason: 'tool_calls',
            };
        });

        const profileTools = {
            chat: { read_range: true, search: true },
            lorebook: { search: true, get: true },
            memory: { node_brief: true },
            note: { open: false, close: false },
            search: { search: false, visit: false },
            finalize: false,
        };
        const dispatcher = createSubagentDispatcher({
            subAgents: [
                // Inheriting sub-agent: should see chat_* + lorebook_* + memory_node_brief + get_draft.
                { id: 'inheritor', description: '', systemPrompt: 's' },
                // Override sub-agent: ONLY note tools enabled, nothing else.
                {
                    id: 'overrider',
                    description: '',
                    systemPrompt: 's',
                    tools: {
                        note: { open: true, close: true },
                        chat: { read_range: false, search: false },
                        lorebook: { search: false, get: false },
                        memory: {},
                        search: { search: false, visit: false },
                    },
                },
            ],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
            tools: profileTools,
        });

        const h1 = await dispatcher.dispatch({ subagentId: 'inheritor', task: 't' });
        const h2 = await dispatcher.dispatch({ subagentId: 'overrider', task: 't' });
        await dispatcher.awaitAll([h1, h2]);

        const [inheritorSchemas, overriderSchemas] = seenSchemas;
        // Inheritor sees the profile-level tools.
        expect(inheritorSchemas).toContain('chat_read_range');
        expect(inheritorSchemas).toContain('lorebook_search');
        expect(inheritorSchemas).toContain('memory_node_brief');
        expect(inheritorSchemas).not.toContain('note_open');
        // Overrider sees only its own tools (note) + the always-on
        // submit + get_draft.
        expect(overriderSchemas).toContain('note_open');
        expect(overriderSchemas).toContain('note_close');
        expect(overriderSchemas).toContain('submit');
        expect(overriderSchemas).toContain('get_draft');
        expect(overriderSchemas).not.toContain('chat_read_range');
        expect(overriderSchemas).not.toContain('lorebook_search');
        expect(overriderSchemas).not.toContain('memory_node_brief');
    });

    test('inline dispatch uses profile default tools (no per-agent override field)', async () => {
        const seenSchemas = [];
        const fakeGenerate = jest.fn(async (opts) => {
            seenSchemas.push((opts.tools || []).map(s => s?.function?.name).filter(Boolean).sort());
            return {
                assistantText: '',
                toolCalls: [{ id: 't_submit', name: 'submit', args: { output: 'ok' } }],
                reasoning: null,
                finishReason: 'tool_calls',
            };
        });

        const dispatcher = createSubagentDispatcher({
            subAgents: [],
            limits: { maxTotalSubagentRuns: 3 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
            tools: { chat: { read_range: true, search: false }, finalize: false },
        });

        const h = await dispatcher.dispatchInline({ systemPrompt: 'inline role', task: 't' });
        await dispatcher.awaitAll([h]);

        expect(seenSchemas[0]).toContain('chat_read_range');
        expect(seenSchemas[0]).not.toContain('chat_search');
    });

    // ── submit-contract + no-tool-call retry semantics ──
    //
    // Sub-agents must terminate via the `submit` tool. A round emitting
    // plain text without any tool call is treated as a failed attempt —
    // discarded from history (so the failed text cannot mislead later
    // rounds) and retried up to `settings.toolCallRetryMax`. These
    // tests pin that contract.

    test('submit() with valid output ends the dispatch and returns output as outputText', async () => {
        const fakeGenerate = jest.fn(async () => ({
            assistantText: '',
            toolCalls: [{ id: 't1', name: 'submit', args: { output: 'final answer for main' } }],
            reasoning: null,
            finishReason: 'tool_calls',
        }));
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        const [awaited] = await dispatcher.awaitAll([h]);
        expect(awaited.outputText).toBe('final answer for main');
        expect(awaited.error).toBeUndefined();
        expect(fakeGenerate).toHaveBeenCalledTimes(1);
    });

    test('no-tool-call attempt is discarded from subMessages and retried; submit on retry succeeds', async () => {
        // Round 0: model emits plain text with NO tool call — must be
        // discarded and retried.
        // Round 1: model emits submit — dispatch converges.
        // The second request's taskMessages MUST NOT contain the failed
        // round-0 assistant text (otherwise the failed reply would
        // mislead later rounds — exactly what this contract prevents).
        const calls = [
            // round 0: balk — no tool call.
            { assistantText: 'Sure, let me roleplay that scene...', toolCalls: [], reasoning: null, finishReason: 'stop' },
            // round 1 (retry): submit properly.
            { assistantText: '', toolCalls: [{ id: 'tS', name: 'submit', args: { output: 'real answer' } }], reasoning: null, finishReason: 'tool_calls' },
        ];
        let idx = 0;
        const seenTaskMessages = [];
        const fakeGenerate = jest.fn(async (opts) => {
            seenTaskMessages.push(opts.taskMessages.map(m => ({ role: m.role, content: m.content })));
            return calls[idx++];
        });
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            settings: { toolCallRetryMax: 2 }, // allow up to 2 retries
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        const [awaited] = await dispatcher.awaitAll([h]);
        // Dispatch succeeds with the submit's output.
        expect(awaited.outputText).toBe('real answer');
        expect(awaited.error).toBeUndefined();
        // Both rounds were requested (1 balk + 1 submit).
        expect(fakeGenerate).toHaveBeenCalledTimes(2);
        // Round 1 request's history must NOT include the round-0 balk
        // assistant text. The dispatcher discards failed attempts —
        // they never reach subMessages — so the retry request looks
        // identical to the initial request.
        const round0Messages = seenTaskMessages[0];
        const round1Messages = seenTaskMessages[1];
        expect(round1Messages).toEqual(round0Messages);
        expect(round1Messages.some(m => String(m.content || '').includes('Sure, let me roleplay'))).toBe(false);
        // No assistant turn was pushed during the discarded round.
        expect(round1Messages.every(m => m.role !== 'assistant')).toBe(true);
    });

    test('no-tool-call retry exhausts: dispatch fails with descriptive error after toolCallRetryMax+1 attempts', async () => {
        // Model always balks — never calls a tool. With toolCallRetryMax=2,
        // we get 3 attempts (initial + 2 retries) before giving up.
        const fakeGenerate = jest.fn(async () => ({
            assistantText: 'no tools here, just vibes',
            toolCalls: [],
            reasoning: null,
            finishReason: 'stop',
        }));
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            settings: { toolCallRetryMax: 2 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        const [awaited] = await dispatcher.awaitAll([h]);
        expect(awaited.outputText).toBeUndefined();
        expect(awaited.error).toMatch(/no tool call after 3 attempt/);
        // Exactly toolCallRetryMax+1 = 3 model requests.
        expect(fakeGenerate).toHaveBeenCalledTimes(3);
        // Completion notification reflects the failure.
        const notifs = dispatcher.drainCompletionNotifications();
        const mine = notifs.find(n => n.handleId === h);
        expect(mine.status).toBe('failed');
        expect(mine.summary).toMatch(/no tool call/);
    });

    test('submit alongside another tool in the same round: tool is still executed, submit ends the loop', async () => {
        // Round 0: model emits chat_read_range AND submit in the same
        // round. Both tools execute; submit's output is the final answer.
        const executeLoopTool = jest.fn(async () => ({ snippets: ['line1', 'line2'] }));
        const fakeGenerate = jest.fn(async () => ({
            assistantText: '',
            toolCalls: [
                { id: 'tA', name: 'chat_read_range', args: { start: 0, end: 2 } },
                { id: 'tB', name: 'submit', args: { output: 'answer with chat lookup baked in' } },
            ],
            reasoning: null,
            finishReason: 'tool_calls',
        }));
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
            tools: { chat: { read_range: true } },
            executeLoopTool,
            chat: [],
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        const [awaited] = await dispatcher.awaitAll([h]);
        expect(awaited.outputText).toBe('answer with chat lookup baked in');
        // The non-submit tool was actually executed.
        expect(executeLoopTool).toHaveBeenCalledTimes(1);
        expect(executeLoopTool.mock.calls[0][0]).toBe('chat_read_range');
        // Only ONE model request — the loop converged on the first round.
        expect(fakeGenerate).toHaveBeenCalledTimes(1);
    });

    test('submit with invalid args (non-string output) surfaces as tool error and does NOT converge; model retries next round', async () => {
        // Round 0: submit with bad args (number instead of string).
        // The submit executor returns a tool error; loop continues.
        // Round 1: submit properly; convergence.
        const calls = [
            { assistantText: '', toolCalls: [{ id: 'tBad', name: 'submit', args: { output: 12345 } }], reasoning: null, finishReason: 'tool_calls' },
            { assistantText: '', toolCalls: [{ id: 'tGood', name: 'submit', args: { output: 'fixed' } }], reasoning: null, finishReason: 'tool_calls' },
        ];
        let idx = 0;
        const seenTaskMessages = [];
        const fakeGenerate = jest.fn(async (opts) => {
            seenTaskMessages.push(opts.taskMessages);
            return calls[idx++];
        });
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 's', description: '', systemPrompt: 's' }],
            limits: { maxTotalSubagentRuns: 5 },
            generateTask: fakeGenerate,
            abortSignal: new AbortController().signal,
        });
        const h = await dispatcher.dispatch({ subagentId: 's', task: 't' });
        const [awaited] = await dispatcher.awaitAll([h]);
        expect(awaited.outputText).toBe('fixed');
        expect(fakeGenerate).toHaveBeenCalledTimes(2);
        // Round 1's history contains the round-0 assistant turn AND the
        // round-0 tool error response (so the model can self-correct on
        // the retry). This is different from the no-tool-call discard
        // path — submit-with-bad-args IS a tool call, it just failed.
        const round1Messages = seenTaskMessages[1];
        const errorToolMsg = round1Messages.find(m => m.role === 'tool' && m.tool_call_id === 'tBad');
        expect(errorToolMsg).toBeDefined();
        const parsed = JSON.parse(errorToolMsg.content);
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toMatch(/output must be a string/);
    });
});
