import { describe, expect, test, jest } from '@jest/globals';
import {
    buildAgentTaskMessages,
    readOpenNotesFromContextForNotes,
    renderMainAgentSystemPromptWithOpenNotes,
    runMainAgentLoop,
} from '../../../public/scripts/extensions/orchestrator/director-runtime.js';

describe('buildAgentTaskMessages', () => {
    const agentProfile = {
        systemPrompt: 'You are the main director agent.',
    };
    const contentPayload = {
        messages: [
            { role: 'system', content: 'Alice the warrior — description.' },
            { role: 'system', content: 'Bob the user — persona.' },
            { role: 'user', content: 'previous user line' },
            { role: 'assistant', content: 'previous assistant line' },
        ],
    };

    test('returns [system_open, ...payload.messages, system_close+instruction] shape', () => {
        const result = buildAgentTaskMessages(agentProfile, contentPayload);
        // 1 open + 4 payload + 1 close = 6
        expect(result).toHaveLength(6);

        expect(result[0]).toEqual({ role: 'system', content: '<story_context>' });

        expect(result[1]).toEqual({ role: 'system', content: 'Alice the warrior — description.' });
        expect(result[2]).toEqual({ role: 'system', content: 'Bob the user — persona.' });
        expect(result[3]).toEqual({ role: 'user', content: 'previous user line' });
        expect(result[4]).toEqual({ role: 'assistant', content: 'previous assistant line' });

        // Instruction is appended AFTER </story_context> close, so the
        // agent's task framing is the most recent thing the model sees.
        expect(result[5].role).toBe('system');
        expect(result[5].content.startsWith('</story_context>')).toBe(true);
        expect(result[5].content).toContain('You are the main director agent.');
    });

    test('with empty payload, returns [system_open, system_close+instruction] (2 messages)', () => {
        const result = buildAgentTaskMessages(agentProfile, { messages: [] });
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('<story_context>');
        expect(result[1].content.startsWith('</story_context>')).toBe(true);
        expect(result[1].content).toContain('You are the main director agent.');
    });

    test('handles null content payload — boundary tags still emitted, no payload spliced', () => {
        const result = buildAgentTaskMessages(agentProfile, null);
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('<story_context>');
        expect(result[1].content.startsWith('</story_context>')).toBe(true);
        expect(result[1].content).toContain('You are the main director agent.');
    });

    test('handles payload with missing messages array gracefully', () => {
        const result = buildAgentTaskMessages(agentProfile, {});
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('<story_context>');
        expect(result[1].content.startsWith('</story_context>')).toBe(true);
    });

    test('agentProfile without systemPrompt: close system message is just </story_context>', () => {
        const result = buildAgentTaskMessages({}, contentPayload);
        expect(result[result.length - 1]).toEqual({ role: 'system', content: '</story_context>' });
        // No instruction text leaks anywhere.
        expect(result.every(m => !String(m.content || '').includes('You are the main director agent.'))).toBe(true);
    });

    test('payload messages are spliced verbatim (object identity not required, value equality is)', () => {
        const payload = {
            messages: [
                { role: 'user', content: 'u1' },
                { role: 'assistant', content: 'a1' },
                { role: 'user', content: 'u2' },
            ],
        };
        const result = buildAgentTaskMessages(agentProfile, payload);
        // 1 open + 3 payload + 1 close = 5
        expect(result).toHaveLength(5);
        expect(result.slice(1, 4)).toEqual(payload.messages);
    });

    test('non-array messages field on payload is treated as empty', () => {
        const result = buildAgentTaskMessages(agentProfile, { messages: 'not an array' });
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('<story_context>');
        expect(result[1].content.startsWith('</story_context>')).toBe(true);
    });
});

describe('readOpenNotesFromContextForNotes', () => {
    test('returns [] when contextForNotes is missing / null / no adapter', async () => {
        expect(await readOpenNotesFromContextForNotes(null)).toEqual([]);
        expect(await readOpenNotesFromContextForNotes(undefined)).toEqual([]);
        expect(await readOpenNotesFromContextForNotes({})).toEqual([]);
        expect(await readOpenNotesFromContextForNotes({ __floorStateForNotes: {} })).toEqual([]);
    });

    test('filters closed entries; legacy entries without status default to open', async () => {
        const ctx = {
            __floorStateForNotes: {
                listAcrossFloors: async () => ([
                    { id: 'a', text: 'open thread', status: 'open' },
                    { id: 'b', text: 'done thread', status: 'closed', closure_reason: 'paid off' },
                    { id: 'c', text: 'legacy thread' },
                ]),
            },
        };
        const result = await readOpenNotesFromContextForNotes(ctx);
        expect(result).toEqual([
            { id: 'a', text: 'open thread' },
            { id: 'c', text: 'legacy thread' },
        ]);
    });

    test('returns [] when listAcrossFloors throws', async () => {
        const ctx = {
            __floorStateForNotes: {
                listAcrossFloors: async () => { throw new Error('boom'); },
            },
        };
        expect(await readOpenNotesFromContextForNotes(ctx)).toEqual([]);
    });

    test('returns [] when listAcrossFloors returns a non-array', async () => {
        const ctx = {
            __floorStateForNotes: {
                listAcrossFloors: async () => null,
            },
        };
        expect(await readOpenNotesFromContextForNotes(ctx)).toEqual([]);
    });
});

describe('renderMainAgentSystemPromptWithOpenNotes', () => {
    test('returns the systemPrompt unchanged when no open notes', () => {
        expect(renderMainAgentSystemPromptWithOpenNotes('You are a director.', [])).toBe('You are a director.');
        expect(renderMainAgentSystemPromptWithOpenNotes('You are a director.', null)).toBe('You are a director.');
        expect(renderMainAgentSystemPromptWithOpenNotes('You are a director.', undefined)).toBe('You are a director.');
    });

    test('appends "## Open Notes" block with id prefix and double newline separator', () => {
        const out = renderMainAgentSystemPromptWithOpenNotes(
            'You are a director.',
            [{ id: 'o_a3f2', text: 'planted key' }, { id: 'o_b8c1', text: 'sanctum oath' }],
        );
        expect(out).toContain('You are a director.\n\n## Open Notes');
        expect(out).toContain('- [o_a3f2] planted key');
        expect(out).toContain('- [o_b8c1] sanctum oath');
    });

    test('renders block as-is when systemPrompt is empty', () => {
        const out = renderMainAgentSystemPromptWithOpenNotes('', [{ id: 'x', text: 'thread' }]);
        expect(out.startsWith('## Open Notes')).toBe(true);
        expect(out).toContain('- [x] thread');
    });
});

describe('runMainAgentLoop injects ## Open Notes into the main agent system prompt', () => {
    function makeStream(toolCallsForFirstCall) {
        let called = 0;
        return jest.fn(async ({ taskMessages }) => {
            captureRef.taskMessages = taskMessages.slice();
            called++;
            if (called === 1) {
                return {
                    assistantText: '',
                    toolCalls: toolCallsForFirstCall,
                    reasoning: null,
                    finishReason: 'tool_calls',
                    usage: null,
                    raw: null,
                };
            }
            return { assistantText: '', toolCalls: [], reasoning: null, finishReason: 'stop', usage: null, raw: null };
        });
    }
    const captureRef = { taskMessages: null };

    test('main agent system_close contains "## Open Notes" when contextForNotes carries open entries', async () => {
        captureRef.taskMessages = null;
        const fakeStream = makeStream([{ id: 'tf', name: 'finalize', args: {} }]);

        const chat = [{ mes: '', extra: { reasoning: '' }, is_user: false }];
        // Minimal handle stub matching the surface the loop uses: setText
        // gives finalize something non-empty to commit, complete._settled
        // gates the auto-commit branch, and reasoning ops are no-ops here.
        const handle = {
            getDraft: () => 'placeholder',
            setText: () => {},
            getText: () => 'placeholder',
            setReasoning: () => {},
            getReasoning: () => '',
            commit: async () => ({ ok: true }),
            complete: Object.assign(Promise.resolve({ status: 'committed' }), { _settled: false }),
        };
        // Pre-seed something so finalize sees a non-empty draft.
        handle.setText('placeholder');

        const profile = {
            mode: 'director',
            director: {
                mainAgent: { systemPrompt: 'You are the main director.' },
                subAgents: [],
                maxRounds: 3,
                tools: { finalize: true },
            },
        };
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };
        const contextForNotes = {
            __floorStateForNotes: {
                listAcrossFloors: async () => ([
                    { id: 'o_a3f2', text: 'planted key', status: 'open' },
                    { id: 'closed_z', text: 'old payoff', status: 'closed' },
                ]),
            },
        };

        await runMainAgentLoop({
            handle,
            profile,
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                contextForNotes,
            },
        });

        expect(captureRef.taskMessages).not.toBeNull();
        // The instruction is appended after </story_context> in the last
        // system message; that's where the ## Open Notes block lands.
        const closeMsg = captureRef.taskMessages[captureRef.taskMessages.length - 1];
        expect(closeMsg.role).toBe('system');
        expect(closeMsg.content.startsWith('</story_context>')).toBe(true);
        expect(closeMsg.content).toContain('You are the main director.');
        expect(closeMsg.content).toContain('## Open Notes');
        expect(closeMsg.content).toContain('[o_a3f2] planted key');
        // Closed entries must NOT appear.
        expect(closeMsg.content).not.toContain('old payoff');
    });

    test('main agent system_close has NO "## Open Notes" block when there are no open notes', async () => {
        captureRef.taskMessages = null;
        const fakeStream = makeStream([{ id: 'tf', name: 'finalize', args: {} }]);

        const chat = [{ mes: '', extra: { reasoning: '' }, is_user: false }];
        const handle = {
            getDraft: () => 'placeholder',
            setText: () => {},
            getText: () => 'placeholder',
            setReasoning: () => {},
            getReasoning: () => '',
            commit: async () => ({ ok: true }),
            complete: Object.assign(Promise.resolve({ status: 'committed' }), { _settled: false }),
        };
        handle.setText('placeholder');

        const profile = {
            mode: 'director',
            director: {
                mainAgent: { systemPrompt: 'You are the main director.' },
                subAgents: [],
                maxRounds: 3,
                tools: { finalize: true },
            },
        };
        const ev = {
            type: 'normal',
            placeholderMessageId: 0,
            takeoverHandle: handle,
            abortSignal: new AbortController().signal,
        };
        // adapter returns only closed entries — open-notes list is empty.
        const contextForNotes = {
            __floorStateForNotes: {
                listAcrossFloors: async () => ([
                    { id: 'c1', text: 'already closed', status: 'closed' },
                ]),
            },
        };

        await runMainAgentLoop({
            handle,
            profile,
            eventData: ev,
            deps: {
                generateTaskStreamForMainAgent: fakeStream,
                generateTask: jest.fn(),
                chat,
                contextForNotes,
            },
        });

        const msgs = captureRef.taskMessages;
        expect(msgs.every(m => !String(m.content || '').includes('## Open Notes'))).toBe(true);
    });
});
