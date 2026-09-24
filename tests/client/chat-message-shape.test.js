// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, test, expect } from '@jest/globals';
import { shapeChatMessagePayload } from '../../public/scripts/chat-message-shape.js';

function makeMessage(overrides = {}) {
    return {
        role: 'assistant',
        content: 'hello',
        ...overrides,
    };
}

describe('shapeChatMessagePayload', () => {
    test('keeps all reasoning sidecars for non-Claude sources', () => {
        const message = makeMessage({
            signature: 'sig',
            reasoning: 'thought-text',
            reasoning_blocks: [{ type: 'thinking', thinking: 't', signature: 's' }],
            reasoning_details: [{ type: 'reasoning', text: 'd' }],
        });
        const shaped = shapeChatMessagePayload(message, false);
        expect(shaped.signature).toBe('sig');
        expect(shaped.reasoning).toBe('thought-text');
        expect(shaped.reasoning_blocks).toEqual([{ type: 'thinking', thinking: 't', signature: 's' }]);
        expect(shaped.reasoning_details).toEqual([{ type: 'reasoning', text: 'd' }]);
    });

    test('for Claude drops root signature/reasoning/reasoning_details but keeps reasoning_blocks', () => {
        // Anthropic /v1/messages rejects schema-external root properties; Extended
        // Thinking signatures travel inside `thinking` blocks, reconstructed
        // server-side from `reasoning_blocks` alone.
        const message = makeMessage({
            signature: 'sig',
            reasoning: 'thought-text',
            reasoning_blocks: [{ type: 'thinking', thinking: 't', signature: 's' }],
            reasoning_details: [{ type: 'reasoning', text: 'd' }],
        });
        const shaped = shapeChatMessagePayload(message, true);
        expect(shaped.signature).toBeUndefined();
        expect(shaped.reasoning).toBeUndefined();
        expect(shaped.reasoning_details).toBeUndefined();
        expect(shaped.reasoning_blocks).toEqual([{ type: 'thinking', thinking: 't', signature: 's' }]);
    });

    test('omits name and tool_calls when absent', () => {
        const shaped = shapeChatMessagePayload(makeMessage(), false);
        expect('name' in shaped).toBe(false);
        expect('tool_calls' in shaped).toBe(false);
        expect('tool_call_id' in shaped).toBe(false);
    });

    test('carries name and tool_calls when present', () => {
        const toolCalls = [{ id: 'tc1', function: { name: 'search', arguments: '{}' } }];
        const shaped = shapeChatMessagePayload(makeMessage({ name: 'Narrator', tool_calls: toolCalls }), false);
        expect(shaped.name).toBe('Narrator');
        expect(shaped.tool_calls).toBe(toolCalls);
    });

    test('maps identifier to tool_call_id for tool role', () => {
        const shaped = shapeChatMessagePayload(makeMessage({ role: 'tool', content: 'result', identifier: 'tc_abc' }), false);
        expect(shaped.tool_call_id).toBe('tc_abc');
    });

    test('omits empty reasoning sidecars entirely', () => {
        const shaped = shapeChatMessagePayload(makeMessage({
            signature: null,
            reasoning: '',
            reasoning_blocks: [],
            reasoning_details: [],
        }), false);
        expect('signature' in shaped).toBe(false);
        expect('reasoning' in shaped).toBe(false);
        expect('reasoning_blocks' in shaped).toBe(false);
        expect('reasoning_details' in shaped).toBe(false);
    });

    test('keeps role and content untouched', () => {
        const shaped = shapeChatMessagePayload(makeMessage({ role: 'user', content: 'hi' }), true);
        expect(shaped.role).toBe('user');
        expect(shaped.content).toBe('hi');
    });
});
