import { describe, expect, test, jest } from '@jest/globals';
import {
    createSubagentDispatcher,
    renderSubSystemPromptWithNotes,
    loadSubAgentOpenNotesBlock,
} from '../../../public/scripts/extensions/orchestrator/director-tools.js';

/**
 * Sub-agent dispatch builds taskMessages in this shape:
 *
 *   [meta_frame,
 *    system_open, ...payload.messages, system_close,
 *    meta_reminder,
 *    <orchestration_role>,
 *    <task>,
 *    (optional, user role) <runtime_state>]
 *
 * meta_frame is a fixed-text system message that tells the model
 * <story_context> is read-only narrative material and identity lives
 * inside <orchestration_role>, work in <task>. The agent's persona sits
 * inside <orchestration_role>, placed AFTER </story_context> so the
 * model reads the RP setup, then immediately reads "but you are an
 * orchestration agent", then executes the task.
 *
 * Per-dispatch volatile context (open notes, available skills catalog,
 * main-agent digest, current draft snapshot) lives in a trailing
 * user-role `<runtime_state>` message so the system prefix can be
 * byte-stable across dispatches for upstream prompt-cache reuse.
 * `<runtime_state>` is omitted entirely when all four sources are empty.
 */
function makeDispatcherFixture({ payloadMessages = [{ role: 'user', content: 'chat user 0' }, { role: 'assistant', content: 'chat assistant 0' }], handle = null } = {}) {
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
        handle,
    });
    return { dispatcher, generateTask, capturedSubMessages: captured };
}

describe('director-tools — sub-agent message assembly', () => {
    test('dispatch produces [meta, open, ...payload, close, reminder, role, task, runtime_state] when parentMessages has rounds', async () => {
        const { dispatcher, capturedSubMessages } = makeDispatcherFixture();

        // parentMessages shape mirrors what runMainAgentLoop snapshots:
        // [system_open, ...payload, system_close+role, ...rounds]
        // (Main agent's parentMessages still uses the legacy
        // close+role join in the slice it hands to renderMainAgentDigest;
        // only the sub-agent dispatch path splits role / digest / task
        // apart and moves volatile per-dispatch context into a trailing
        // user-role runtime_state block.)
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
        // [meta, open, payload0, payload1, close, reminder, role, task, runtime_state] = 9
        expect(msgs).toHaveLength(9);

        // [0] meta-frame: anti-RP framing. Tells the model story_context
        // is read-only and its real work is inside <task>. Now also
        // enumerates the forbidden RP modalities (prose / dialogue /
        // narration / sign-offs) explicitly.
        expect(msgs[0].role).toBe('system');
        expect(msgs[0].content).toMatch(/orchestration agent/i);
        expect(msgs[0].content).toMatch(/READ-ONLY/);
        expect(msgs[0].content).toMatch(/<story_context>/);
        expect(msgs[0].content).toMatch(/<orchestration_role>/);
        expect(msgs[0].content).toMatch(/<task>/);
        // Explicit RP modalities enumerated.
        expect(msgs[0].content).toMatch(/dialogue/i);
        expect(msgs[0].content).toMatch(/narration/i);
        expect(msgs[0].content).toMatch(/sign-offs/i);
        // Termination protocol (no-tool-call round = final report).
        expect(msgs[0].content).toMatch(/no tool calls/i);
        expect(msgs[0].content).toMatch(/structured report/i);

        // [1] story_context open.
        expect(msgs[1]).toEqual({ role: 'system', content: '<story_context>' });

        // [2..3] Payload spliced verbatim.
        expect(msgs[2]).toEqual({ role: 'user', content: 'chat user 0' });
        expect(msgs[3]).toEqual({ role: 'assistant', content: 'chat assistant 0' });

        // [4] story_context close — clean tag with no role text appended.
        expect(msgs[4]).toEqual({ role: 'system', content: '</story_context>' });

        // [5] META_REMINDER — short anti-RP reset placed RIGHT AFTER
        // </story_context> so the model gets the framing back in its
        // recency window after consuming a potentially huge payload of
        // RP material (character card + world info + chat history).
        expect(msgs[5].role).toBe('system');
        expect(msgs[5].content).toMatch(/^Reminder:/);
        expect(msgs[5].content).toMatch(/<story_context>/);
        expect(msgs[5].content).toMatch(/operating ON the story, not a character IN it/);
        expect(msgs[5].content).toMatch(/structured report/);

        // [6] <orchestration_role> wraps the agent's persona (sub-agent
        // systemPrompt only — Open Notes / skills no longer concatenated
        // here; they live in the trailing runtime_state user message).
        expect(msgs[6].role).toBe('system');
        expect(msgs[6].content.startsWith('<orchestration_role>')).toBe(true);
        expect(msgs[6].content.endsWith('</orchestration_role>')).toBe(true);
        expect(msgs[6].content).toContain('You are a brainstormer.');
        expect(msgs[6].content).not.toContain('## Open Notes');

        // [7] Task is a system-role message wrapped in <task>.
        expect(msgs[7]).toEqual({ role: 'system', content: '<task>\ntension up\n</task>' });

        // [8] runtime_state is a user-role message that carries the
        // per-dispatch volatile context — main_agent_digest in this case.
        expect(msgs[8].role).toBe('user');
        expect(msgs[8].content.startsWith('<runtime_state>')).toBe(true);
        expect(msgs[8].content.endsWith('</runtime_state>')).toBe(true);
        expect(msgs[8].content).toContain('<main_agent_digest>');
        expect(msgs[8].content).toContain('## Main agent context');
        expect(msgs[8].content).toContain('curator briefing');
    });

    test('digest is one user-role runtime_state message — no raw assistant/tool from main are spliced in', async () => {
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

    test('first-round dispatch (no main rounds yet) omits runtime_state entirely', async () => {
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
        // [meta, open, payload0, payload1, close, reminder, role, task] = 8 — NO runtime_state.
        expect(msgs).toHaveLength(8);
        expect(msgs[7]).toEqual({ role: 'system', content: '<task>\nfirst task\n</task>' });
        // Confirm no <main_agent_digest> anywhere.
        expect(msgs.every(m => !String(m.content || '').includes('<main_agent_digest>'))).toBe(true);
        // No user-role runtime_state message (META_FRAME mentions the tag
        // by name in its system-side schema doc — that's fine; what
        // matters is whether a user-role runtime_state was actually
        // emitted).
        expect(msgs.some(m => m.role === 'user' && String(m.content || '').includes('<runtime_state>'))).toBe(false);
    });

    test('fallback — missing __parentMessages produces same shape without runtime_state', async () => {
        const { dispatcher, capturedSubMessages } = makeDispatcherFixture();

        const h = await dispatcher.dispatch({ subagentId: 'brainstormer', task: 'legacy' });
        await dispatcher.awaitAll([h]);

        const msgs = capturedSubMessages[0];
        // [meta, open, payload0, payload1, close, reminder, role, task] = 8
        expect(msgs).toHaveLength(8);
        expect(msgs[7]).toEqual({ role: 'system', content: '<task>\nlegacy\n</task>' });
        expect(msgs.every(m => !String(m.content || '').includes('<main_agent_digest>'))).toBe(true);
        expect(msgs.some(m => m.role === 'user' && String(m.content || '').includes('<runtime_state>'))).toBe(false);
    });

    test("runtime_state carries '## Open Notes' block when notes exist", async () => {
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
        // Empty payload → [meta, open, close, reminder, role, task, runtime_state] = 7
        expect(msgs).toHaveLength(7);
        const roleMsg = msgs[4];
        expect(roleMsg.role).toBe('system');
        expect(roleMsg.content.startsWith('<orchestration_role>')).toBe(true);
        expect(roleMsg.content.endsWith('</orchestration_role>')).toBe(true);
        expect(roleMsg.content).toContain('You are a brainstormer.');
        // Role block stays clean — no Open Notes concatenated.
        expect(roleMsg.content).not.toContain('## Open Notes');

        // runtime_state is the trailing user message — carries Open Notes.
        const runtimeStateMsg = msgs[6];
        expect(runtimeStateMsg.role).toBe('user');
        expect(runtimeStateMsg.content.startsWith('<runtime_state>')).toBe(true);
        expect(runtimeStateMsg.content.endsWith('</runtime_state>')).toBe(true);
        expect(runtimeStateMsg.content).toContain('## Open Notes');
        expect(runtimeStateMsg.content).toContain('[n1] foreshadowing X planted in chapter 3');
        expect(runtimeStateMsg.content).toContain('[n2] character Y owes a favor to Z');

        // Close tag and reminder stay clean.
        expect(msgs[2]).toEqual({ role: 'system', content: '</story_context>' });
        expect(msgs[3].role).toBe('system');
        expect(msgs[3].content).toMatch(/^Reminder:/);
    });

    test('runtime_state is OMITTED when there are no notes, no digest, no draft, no skills', async () => {
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
        expect(msgs.some(m => m.role === 'user' && String(m.content || '').includes('<runtime_state>'))).toBe(false);
    });

    test('loadSubAgentOpenNotesBlock renders ## Open Notes with id prefix, filters closed', async () => {
        const fs = {
            listAcrossFloors: async () => [
                { id: 'a', text: 'open one', status: 'open' },
                { id: 'b', text: 'closed one', status: 'closed', closure_reason: 'done' },
                { id: 'c', text: 'another open' /* legacy no status */ },
            ],
        };
        const result = await loadSubAgentOpenNotesBlock({ __floorStateForNotes: fs });
        expect(result).toContain('## Open Notes');
        expect(result).toContain('[a] open one');
        expect(result).toContain('[c] another open');
        expect(result).not.toContain('closed one');
        expect(result).not.toContain('done');
    });

    test('renderSubSystemPromptWithNotes (back-compat) still concatenates Open Notes into the prompt', async () => {
        const fs = {
            listAcrossFloors: async () => [
                { id: 'a', text: 'open one', status: 'open' },
            ],
        };
        const result = await renderSubSystemPromptWithNotes('You are a scout.', { __floorStateForNotes: fs });
        expect(result).toContain('You are a scout.');
        expect(result).toContain('## Open Notes');
        expect(result).toContain('[a] open one');
    });

    test('dispatch injects <current_draft> into runtime_state when handle has draft text', async () => {
        const handle = { getText: () => 'PROSE BODY snapshot at dispatch' };
        const { dispatcher, capturedSubMessages } = makeDispatcherFixture({ handle });

        const parent = [
            { role: 'system', content: '<story_context>' },
            { role: 'user', content: 'chat user 0' },
            { role: 'assistant', content: 'chat assistant 0' },
            { role: 'system', content: '</story_context>' },
            { role: 'assistant', content: 'main thinking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_message', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: '{"ok":true,"currentLength":31}' },
        ];
        const h = await dispatcher.dispatch({ subagentId: 'brainstormer', task: 'critique', __parentMessages: parent });
        await dispatcher.awaitAll([h]);

        const msgs = capturedSubMessages[0];
        // [meta, open, p0, p1, close, reminder, role, task, runtime_state] = 9
        expect(msgs).toHaveLength(9);
        // task is the second-to-last; runtime_state is last.
        expect(msgs[7]).toEqual({ role: 'system', content: '<task>\ncritique\n</task>' });
        const runtimeStateMsg = msgs[8];
        expect(runtimeStateMsg.role).toBe('user');
        expect(runtimeStateMsg.content).toContain('<current_draft');
        expect(runtimeStateMsg.content).toContain('PROSE BODY snapshot at dispatch');
        expect(runtimeStateMsg.content).toContain('call get_draft to re-read');
        expect(runtimeStateMsg.content).toContain('</current_draft>');
        // Digest also rides in the same runtime_state block.
        expect(runtimeStateMsg.content).toContain('<main_agent_digest>');
    });

    test('dispatch OMITS <current_draft> when handle is missing or draft is empty (pre-draft scouts)', async () => {
        // Case 1: no handle at all.
        const noHandle = makeDispatcherFixture();
        const h1 = await noHandle.dispatcher.dispatch({ subagentId: 'brainstormer', task: 'pre-draft scout', __parentMessages: null });
        await noHandle.dispatcher.awaitAll([h1]);
        expect(noHandle.capturedSubMessages[0].every(m => !String(m.content || '').includes('<current_draft'))).toBe(true);

        // Case 2: handle exists but draft is empty (main agent hasn't written yet).
        const emptyHandle = makeDispatcherFixture({ handle: { getText: () => '' } });
        const h2 = await emptyHandle.dispatcher.dispatch({ subagentId: 'brainstormer', task: 'pre-draft scout', __parentMessages: null });
        await emptyHandle.dispatcher.awaitAll([h2]);
        expect(emptyHandle.capturedSubMessages[0].every(m => !String(m.content || '').includes('<current_draft'))).toBe(true);
    });
});
