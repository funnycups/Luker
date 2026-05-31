import { describe, expect, test, jest } from '@jest/globals';
import { createSubagentDispatcher, renderSubSystemPromptWithNotes } from '../../../public/scripts/extensions/orchestrator/director-tools.js';

/**
 * Sub-agent dispatch builds taskMessages in this shape (note the
 * anti-RP framing and the identity-last ordering — recency bias keeps
 * the agent's role fresh right before <task>; the payload's own
 * "You are {{char}}…" system message inside <story_context> would
 * otherwise pull the model into in-character prose):
 *
 *   [meta_frame,
 *    system_open, ...payload.messages, system_close,
 *    <orchestration_role>+notes,
 *    (optional) <main_agent_digest>, <task>]
 *
 * meta_frame is a fixed-text system message that tells the model
 * <story_context> is read-only narrative material and identity lives
 * inside <orchestration_role>, work in <task>. The agent's persona +
 * "## Open Notes" sit inside <orchestration_role>, placed AFTER
 * </story_context> so the model reads the RP setup, then immediately
 * reads "but you are an orchestration agent", then executes the task.
 * `<main_agent_digest>` only appears when `__parentMessages` contains
 * post-prefix rounds; `<task>` is always last.
 */
function makeDispatcherFixture({ payloadMessages = [{ role: 'user', content: 'chat user 0' }, { role: 'assistant', content: 'chat assistant 0' }] } = {}) {
    const captured = [];
    const generateTask = jest.fn(async ({ taskMessages }) => {
        captured.push(taskMessages.slice());
        // Sub-agents must terminate via the `submit` tool — no-tool-call
        // rounds are now treated as failed attempts and retried (see
        // SUBMIT_TOOL in director-tools.js). The fixture's fake therefore
        // submits a single-round answer so each dispatch converges
        // cleanly and we can inspect the captured initial-request shape.
        return {
            assistantText: '',
            toolCalls: [{ id: 't_submit', name: 'submit', args: { output: 'sub output' } }],
            reasoning: null,
            finishReason: 'tool_calls',
            usage: null,
            raw: null,
        };
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
    test('dispatch produces [meta, open, ...payload, close, role, digest, task] when parentMessages has rounds', async () => {
        const { dispatcher, capturedSubMessages } = makeDispatcherFixture();

        // parentMessages shape mirrors what runMainAgentLoop snapshots:
        // [system_open, ...payload, system_close+role, ...rounds]
        // (Main agent still uses the legacy close+role join; only the
        // sub-agent dispatch path splits them out and moves role after
        // story_context. The digest prefix-skip accounting at
        // director-tools.js around the renderMainAgentDigest call
        // references the main-agent shape so it doesn't change.)
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
        // [meta, open, payload0, payload1, close, role, digest, task] = 8
        expect(msgs).toHaveLength(8);

        // [0] meta-frame: anti-RP framing + submit contract. Tells the
        // model story_context is read-only, its real work is inside
        // <task>, AND that it MUST terminate via `submit`.
        expect(msgs[0].role).toBe('system');
        expect(msgs[0].content).toMatch(/orchestration agent/i);
        expect(msgs[0].content).toMatch(/READ-ONLY/);
        expect(msgs[0].content).toMatch(/<story_context>/);
        expect(msgs[0].content).toMatch(/<orchestration_role>/);
        expect(msgs[0].content).toMatch(/<task>/);
        // Submit-tool contract is part of META_FRAME.
        expect(msgs[0].content).toMatch(/CONTRACT/);
        expect(msgs[0].content).toMatch(/submit/);
        expect(msgs[0].content).toMatch(/failed attempt/i);

        // [1] story_context open.
        expect(msgs[1]).toEqual({ role: 'system', content: '<story_context>' });

        // [2..3] Payload spliced verbatim.
        expect(msgs[2]).toEqual({ role: 'user', content: 'chat user 0' });
        expect(msgs[3]).toEqual({ role: 'assistant', content: 'chat assistant 0' });

        // [4] story_context close — clean tag with no role text appended.
        expect(msgs[4]).toEqual({ role: 'system', content: '</story_context>' });

        // [5] <orchestration_role> wraps the agent's persona (sub-agent
        // systemPrompt, plus optional Open Notes appended). Placed
        // AFTER </story_context> so identity sits fresh right before
        // the task instruction (recency bias).
        expect(msgs[5].role).toBe('system');
        expect(msgs[5].content.startsWith('<orchestration_role>')).toBe(true);
        expect(msgs[5].content.endsWith('</orchestration_role>')).toBe(true);
        expect(msgs[5].content).toContain('You are a brainstormer.');

        // [6] digest is a system-role message wrapped in <main_agent_digest>.
        expect(msgs[6].role).toBe('system');
        expect(msgs[6].content.startsWith('<main_agent_digest>')).toBe(true);
        expect(msgs[6].content.endsWith('</main_agent_digest>')).toBe(true);
        expect(msgs[6].content).toContain('## Main agent context');
        expect(msgs[6].content).toContain('curator briefing');

        // [7] Task is a system-role message wrapped in <task>.
        expect(msgs[7]).toEqual({ role: 'system', content: '<task>\ntension up\n</task>' });
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
        // [meta, open, payload0, payload1, close, role, task] = 7 — NO digest.
        expect(msgs).toHaveLength(7);
        expect(msgs[6]).toEqual({ role: 'system', content: '<task>\nfirst task\n</task>' });
        // Confirm no <main_agent_digest> anywhere.
        expect(msgs.every(m => !String(m.content || '').includes('<main_agent_digest>'))).toBe(true);
    });

    test('fallback — missing __parentMessages produces same shape minus the digest', async () => {
        const { dispatcher, capturedSubMessages } = makeDispatcherFixture();

        const h = await dispatcher.dispatch({ subagentId: 'brainstormer', task: 'legacy' });
        await dispatcher.awaitAll([h]);

        const msgs = capturedSubMessages[0];
        // [meta, open, payload0, payload1, close, role, task] = 7
        expect(msgs).toHaveLength(7);
        expect(msgs[6]).toEqual({ role: 'system', content: '<task>\nlegacy\n</task>' });
        expect(msgs.every(m => !String(m.content || '').includes('<main_agent_digest>'))).toBe(true);
    });

    test("<orchestration_role> wrapper carries '## Open Notes' block when notes exist", async () => {
        const captured = [];
        const generateTask = jest.fn(async ({ taskMessages }) => {
            captured.push(taskMessages.slice());
            return {
                assistantText: '',
                toolCalls: [{ id: 't_submit', name: 'submit', args: { output: 'sub output' } }],
                reasoning: null,
                finishReason: 'tool_calls',
                usage: null,
                raw: null,
            };
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
        // Empty payload → [meta, open, close, role, task] = 5
        expect(msgs).toHaveLength(5);
        const roleMsg = msgs[3];
        expect(roleMsg.role).toBe('system');
        expect(roleMsg.content.startsWith('<orchestration_role>')).toBe(true);
        expect(roleMsg.content.endsWith('</orchestration_role>')).toBe(true);
        expect(roleMsg.content).toContain('You are a brainstormer.');
        expect(roleMsg.content).toContain('## Open Notes');
        expect(roleMsg.content).toContain('[n1] foreshadowing X planted in chapter 3');
        expect(roleMsg.content).toContain('[n2] character Y owes a favor to Z');
        // Close tag stays clean — no role / notes concatenated.
        expect(msgs[2]).toEqual({ role: 'system', content: '</story_context>' });
    });

    test("<orchestration_role> wrapper has NO '## Open Notes' block when there are no notes", async () => {
        const captured = [];
        const generateTask = jest.fn(async ({ taskMessages }) => {
            captured.push(taskMessages.slice());
            return {
                assistantText: '',
                toolCalls: [{ id: 't_submit', name: 'submit', args: { output: 'sub output' } }],
                reasoning: null,
                finishReason: 'tool_calls',
                usage: null,
                raw: null,
            };
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
