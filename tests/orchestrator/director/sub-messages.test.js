import { describe, expect, test, jest } from '@jest/globals';
import { createSubagentDispatcher } from '../../../public/scripts/extensions/orchestrator/director-tools.js';

/**
 * Sub-agent dispatch builds taskMessages in the same shape main agent
 * uses (see `buildAgentTaskMessages`):
 *
 *   [system_open, ...payload.messages, system_close,
 *    (optional) <main_agent_digest>, <task>]
 *
 * `<main_agent_digest>` only appears when `__parentMessages` contains
 * post-prefix rounds; `<task>` is always present and is emitted as a
 * system-role message with XML-wrapped content (no user-role hardcoding —
 * if the user wants a user turn, they wire it via their prompt preset).
 */
function makeDispatcherFixture({ payloadMessages = [{ role: 'user', content: 'chat user 0' }, { role: 'assistant', content: 'chat assistant 0' }] } = {}) {
    const captured = [];
    const generateTask = jest.fn(async ({ taskMessages }) => {
        captured.push(taskMessages.slice());
        return { assistantText: 'sub output', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
    });
    const payload = { messages: payloadMessages };
    const dispatcher = createSubagentDispatcher({
        subAgents: [
            { id: 'brainstormer', description: '', systemPrompt: 'You are a brainstormer.' },
        ],
        limits: { maxConcurrentSubagents: 4, maxTotalSubagentRuns: 10 },
        generateTask,
        getContentPayload: () => payload,
        abortSignal: new AbortController().signal,
    });
    return { dispatcher, generateTask, capturedSubMessages: captured };
}

describe('director-tools — sub-agent message assembly', () => {
    test('dispatch produces [system_open, ...payload, system_close, digest, task] when parentMessages has rounds', async () => {
        const { dispatcher, capturedSubMessages } = makeDispatcherFixture();

        // parentMessages shape mirrors what runMainAgentLoop snapshots:
        // [system_open, ...payload, system_close, ...rounds]
        // Here payload has 2 messages, so prefix length = 4. Rounds = 2.
        const parent = [
            { role: 'system', content: 'You are the main director agent.\n\n<story_context>' },
            { role: 'user', content: 'chat user 0' },
            { role: 'assistant', content: 'chat assistant 0' },
            { role: 'system', content: '</story_context>' },
            { role: 'assistant', content: 'main thinking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'dispatch_subagent', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: '{"outputText":"curator briefing"}' },
        ];
        const h = await dispatcher.dispatch({ subagentId: 'brainstormer', task: 'tension up', __parentMessages: parent });
        await dispatcher.awaitAll([h]);

        const msgs = capturedSubMessages[0];
        // [system_open, payload0, payload1, system_close, digest, task] = 6
        expect(msgs).toHaveLength(6);

        // Sub-agent system_open wraps role prompt + <story_context> tag.
        expect(msgs[0].role).toBe('system');
        expect(msgs[0].content).toContain('You are a brainstormer.');
        expect(msgs[0].content).toContain('<story_context>');
        expect(msgs[0].content.trimEnd().endsWith('<story_context>')).toBe(true);

        // Payload spliced verbatim.
        expect(msgs[1]).toEqual({ role: 'user', content: 'chat user 0' });
        expect(msgs[2]).toEqual({ role: 'assistant', content: 'chat assistant 0' });

        // </story_context> close.
        expect(msgs[3]).toEqual({ role: 'system', content: '</story_context>' });

        // Digest is a system-role message wrapped in <main_agent_digest>.
        expect(msgs[4].role).toBe('system');
        expect(msgs[4].content.startsWith('<main_agent_digest>')).toBe(true);
        expect(msgs[4].content.endsWith('</main_agent_digest>')).toBe(true);
        expect(msgs[4].content).toContain('## Main agent context');
        expect(msgs[4].content).toContain('curator briefing');

        // Task is a system-role message wrapped in <task>.
        expect(msgs[5]).toEqual({ role: 'system', content: '<task>\ntension up\n</task>' });
    });

    test('digest is one system message — no raw assistant/tool from main are spliced in', async () => {
        const { dispatcher, capturedSubMessages } = makeDispatcherFixture();

        const parent = [
            { role: 'system', content: 'main system_open' },
            { role: 'user', content: 'chat user 0' },
            { role: 'assistant', content: 'chat assistant 0' },
            { role: 'system', content: '</story_context>' },
            { role: 'assistant', content: 'main thinking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'dispatch_subagent', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: 'result1' },
        ];
        const h = await dispatcher.dispatch({ subagentId: 'brainstormer', task: 'x', __parentMessages: parent });
        await dispatcher.awaitAll([h]);

        const msgs = capturedSubMessages[0];
        // Only assistant in sub's array = chat history's pre-existing one
        // spliced from payload. No assistant from main's rounds, no tool messages.
        const subAssistants = msgs.filter(m => m.role === 'assistant');
        expect(subAssistants).toHaveLength(1);
        expect(subAssistants[0].content).toBe('chat assistant 0');
        expect(msgs.some(m => m.role === 'tool')).toBe(false);
    });

    test('first-round dispatch (no main rounds yet) omits the digest entirely', async () => {
        const { dispatcher, capturedSubMessages } = makeDispatcherFixture();

        // parentMessages = just the prefix — no rounds yet.
        const parent = [
            { role: 'system', content: 'main system_open' },
            { role: 'user', content: 'chat user 0' },
            { role: 'assistant', content: 'chat assistant 0' },
            { role: 'system', content: '</story_context>' },
        ];
        const h = await dispatcher.dispatch({ subagentId: 'brainstormer', task: 'first task', __parentMessages: parent });
        await dispatcher.awaitAll([h]);

        const msgs = capturedSubMessages[0];
        // [system_open, payload0, payload1, system_close, task] = 5 — NO digest.
        expect(msgs).toHaveLength(5);
        expect(msgs[4]).toEqual({ role: 'system', content: '<task>\nfirst task\n</task>' });
        // Confirm no <main_agent_digest> anywhere.
        expect(msgs.every(m => !String(m.content || '').includes('<main_agent_digest>'))).toBe(true);
    });

    test('fallback — missing __parentMessages produces same shape minus the digest', async () => {
        const { dispatcher, capturedSubMessages } = makeDispatcherFixture();

        const h = await dispatcher.dispatch({ subagentId: 'brainstormer', task: 'legacy' });
        await dispatcher.awaitAll([h]);

        const msgs = capturedSubMessages[0];
        // [system_open, payload0, payload1, system_close, task] = 5
        expect(msgs).toHaveLength(5);
        expect(msgs[4]).toEqual({ role: 'system', content: '<task>\nlegacy\n</task>' });
        expect(msgs.every(m => !String(m.content || '').includes('<main_agent_digest>'))).toBe(true);
    });

    test("sub agent system_open has '## Previous Notes' block when notes exist", async () => {
        const captured = [];
        const generateTask = jest.fn(async ({ taskMessages }) => {
            captured.push(taskMessages.slice());
            return { assistantText: 'sub output', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 'brainstormer', description: '', systemPrompt: 'You are a brainstormer.' }],
            limits: { maxConcurrentSubagents: 4, maxTotalSubagentRuns: 10 },
            generateTask,
            getContentPayload: () => ({ messages: [] }),
            abortSignal: new AbortController().signal,
            contextForNotes: {
                __floorStateForNotes: {
                    listAcrossFloors: async () => ([
                        { id: 'n1', text: 'foreshadowing X planted in chapter 3' },
                        { id: 'n2', text: 'character Y owes a favor to Z' },
                    ]),
                },
            },
        });

        const h = await dispatcher.dispatch({ subagentId: 'brainstormer', task: 't' });
        await dispatcher.awaitAll([h]);

        const msgs = captured[0];
        expect(msgs[0].role).toBe('system');
        expect(msgs[0].content).toContain('## Previous Notes');
        expect(msgs[0].content).toContain('1. foreshadowing X planted in chapter 3');
        expect(msgs[0].content).toContain('2. character Y owes a favor to Z');
        // Open tag still terminates the open system message.
        expect(msgs[0].content.trimEnd().endsWith('<story_context>')).toBe(true);
    });

    test("sub agent system_open has NO '## Previous Notes' block when there are no notes", async () => {
        const captured = [];
        const generateTask = jest.fn(async ({ taskMessages }) => {
            captured.push(taskMessages.slice());
            return { assistantText: 'sub output', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });
        const dispatcher = createSubagentDispatcher({
            subAgents: [{ id: 'brainstormer', description: '', systemPrompt: 'You are a brainstormer.' }],
            limits: { maxConcurrentSubagents: 4, maxTotalSubagentRuns: 10 },
            generateTask,
            getContentPayload: () => ({ messages: [] }),
            abortSignal: new AbortController().signal,
            contextForNotes: {
                __floorStateForNotes: {
                    listAcrossFloors: async () => ([]),
                },
            },
        });

        const h = await dispatcher.dispatch({ subagentId: 'brainstormer', task: 't' });
        await dispatcher.awaitAll([h]);

        const msgs = captured[0];
        expect(msgs[0].content).not.toContain('## Previous Notes');
    });
});
