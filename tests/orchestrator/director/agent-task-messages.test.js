import { describe, expect, test } from '@jest/globals';
import { buildAgentTaskMessages } from '../../../public/scripts/extensions/orchestrator/director-runtime.js';

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
