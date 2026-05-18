import { describe, expect, test, jest } from '@jest/globals';
import { createSubagentDispatcher, renderSubSystemPromptWithNotes } from '../../../public/scripts/extensions/orchestrator/director-tools.js';

/**
 * Sub-agent dispatch builds taskMessages in the same shape main agent
 * uses (see `buildAgentTaskMessages`):
 *
 *   [system_open, ...payload.messages, system_close+systemPrompt,
 *    (optional) <main_agent_digest>, <task>]
 *
 * The sub-agent's role description is appended onto the `</story_context>`
 * close so the model reads chat context first and the task framing
 * last (recency bias). `<main_agent_digest>` only appears when
 * `__parentMessages` contains post-prefix rounds; `<task>` is always
 * present and is emitted as a system-role message with XML-wrapped
 * content (no user-role hardcoding — if the user wants a user turn,
 * they wire it via their prompt preset).
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
    test('dispatch produces [system_open, ...payload, system_close+role, digest, task] when parentMessages has rounds', async () => {
        const { dispatcher, capturedSubMessages } = makeDispatcherFixture();

        // parentMessages shape mirrors what runMainAgentLoop snapshots:
        // [system_open, ...payload, system_close+role, ...rounds]
        // Here payload has 2 messages, so prefix length = 4. Rounds = 2.
        const parent = [
            { role: 'system', content: '<story_context>' },
            { role: 'user', content: 'chat user 0' },
            { role: 'assistant', content: 'chat assistant 0' },
            { role: 'system', content: '</story_context>\n\nYou are the main director agent.' },
            { role: 'assistant', content: 'main thinking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'dispatch_subagent', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: '{"outputText":"curator briefing"}' },
        ];
        const h = await dispatcher.dispatch({ subagentId: 'brainstormer', task: 'tension up', __parentMessages: parent });
        await dispatcher.awaitAll([h]);

        const msgs = capturedSubMessages[0];
        // [system_open, payload0, payload1, system_close+role, digest, task] = 6
        expect(msgs).toHaveLength(6);

        // system_open is just the <story_context> tag — no role prompt.
        expect(msgs[0]).toEqual({ role: 'system', content: '<story_context>' });

        // Payload spliced verbatim.
        expect(msgs[1]).toEqual({ role: 'user', content: 'chat user 0' });
        expect(msgs[2]).toEqual({ role: 'assistant', content: 'chat assistant 0' });

        // </story_context> close carries the agent's role description AFTER
        // the boundary tag, so the model reads context first and task framing last.
        expect(msgs[3].role).toBe('system');
        expect(msgs[3].content.startsWith('</story_context>')).toBe(true);
        expect(msgs[3].content).toContain('You are a brainstormer.');

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
            { role: 'system', content: '<story_context>' },
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
            { role: 'system', content: '<story_context>' },
            { role: 'user', content: 'chat user 0' },
            { role: 'assistant', content: 'chat assistant 0' },
            { role: 'system', content: '</story_context>' },
        ];
        const h = await dispatcher.dispatch({ subagentId: 'brainstormer', task: 'first task', __parentMessages: parent });
        await dispatcher.awaitAll([h]);

        const msgs = capturedSubMessages[0];
        // [system_open, payload0, payload1, system_close+role, task] = 5 — NO digest.
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
        // [system_open, payload0, payload1, system_close+role, task] = 5
        expect(msgs).toHaveLength(5);
        expect(msgs[4]).toEqual({ role: 'system', content: '<task>\nlegacy\n</task>' });
        expect(msgs.every(m => !String(m.content || '').includes('<main_agent_digest>'))).toBe(true);
    });

    test("sub agent system_close has '## Open Notes' block when notes exist", async () => {
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
        // Empty payload → [open, close+role, task] = 3
        const closeMsg = msgs[1];
        expect(closeMsg.role).toBe('system');
        expect(closeMsg.content.startsWith('</story_context>')).toBe(true);
        expect(closeMsg.content).toContain('## Open Notes');
        expect(closeMsg.content).toContain('[n1] foreshadowing X planted in chapter 3');
        expect(closeMsg.content).toContain('[n2] character Y owes a favor to Z');
    });

    test("sub agent system_close has NO '## Open Notes' block when there are no notes", async () => {
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
        expect(msgs.every(m => !String(m.content || '').includes('## Open Notes'))).toBe(true);
    });

    test('renderSubSystemPromptWithNotes renders ## Open Notes with id prefix, filters closed', async () => {
        const fs = {
            listAcrossFloors: async () => [
                { id: 'a', text: 'open one', status: 'open' },
                { id: 'b', text: 'closed one', status: 'closed', closure_reason: 'done' },
                { id: 'c', text: 'another open' /* legacy no status */ },
            ],
        };
        const result = await renderSubSystemPromptWithNotes('You are a scout.', { __floorStateForNotes: fs });
        expect(result).toContain('## Open Notes');
        expect(result).toContain('[a] open one');
        expect(result).toContain('[c] another open');
        expect(result).not.toContain('closed one');
        expect(result).not.toContain('done');
    });
});
