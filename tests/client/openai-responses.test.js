// SPDX-License-Identifier: AGPL-3.0-or-later
import { createResponsesEventAdapter, responsesResultToChatCompletion } from '../../public/scripts/openai-responses.js';

describe('createResponsesEventAdapter', () => {
    test('lifecycle events are dropped, output_text deltas become content chunks', () => {
        const adapt = createResponsesEventAdapter();
        expect(adapt({ type: 'response.created', response: {} })).toBeNull();
        expect(adapt({ type: 'response.in_progress', response: {} })).toBeNull();

        const delta = adapt({ type: 'response.output_text.delta', delta: 'Hel' });
        expect(delta).toEqual({ choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] });
    });

    test('reasoning summary deltas become reasoning_content chunks', () => {
        const adapt = createResponsesEventAdapter();
        const delta = adapt({ type: 'response.reasoning_summary_text.delta', delta: 'think' });
        expect(delta.choices[0].delta).toEqual({ reasoning_content: 'think' });
    });

    test('function_call items aggregate arguments by output_index and terminate as tool_calls', () => {
        const adapt = createResponsesEventAdapter();
        const added = adapt({
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '' },
        });
        expect(added.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: 'call_1', type: 'function' });
        expect(added.choices[0].delta.tool_calls[0].function.name).toBe('get_weather');

        const argDelta = adapt({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"ci' });
        expect(argDelta.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, function: { arguments: '{"ci' } });

        const done = adapt({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
        expect(done.choices[0].finish_reason).toBe('tool_calls');
        expect(done.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
    });

    test('completed without tool calls yields stop plus mapped usage', () => {
        const adapt = createResponsesEventAdapter();
        const completed = adapt({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 2 } } });
        expect(completed.choices[0].finish_reason).toBe('stop');
        expect(completed.usage.total_tokens).toBe(9);
    });

    test('incomplete yields length finish reason', () => {
        const adapt = createResponsesEventAdapter();
        const incomplete = adapt({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } });
        expect(incomplete.choices[0].finish_reason).toBe('length');
    });

    test('failed and error events throw', () => {
        const adapt = createResponsesEventAdapter();
        expect(() => adapt({ type: 'response.failed', response: { error: { message: 'boom' } } })).toThrow('boom');
        expect(() => adapt({ type: 'error', message: 'kaboom' })).toThrow('kaboom');
    });
});

describe('responsesResultToChatCompletion', () => {
    test('walks output array into message/reasoning/tool_calls and maps usage', () => {
        const result = responsesResultToChatCompletion({
            id: 'resp_1',
            object: 'response',
            status: 'completed',
            output: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought hard' }] },
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
                { type: 'function_call', call_id: 'call_9', name: 'f', arguments: '{"a":1}' },
            ],
            usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
        });
        expect(result.object).toBe('chat.completion');
        expect(result.choices[0].message.content).toBe('Hello');
        expect(result.choices[0].message.reasoning_content).toBe('thought hard');
        expect(result.choices[0].message.tool_calls).toEqual([
            { id: 'call_9', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
        ]);
        expect(result.choices[0].finish_reason).toBe('tool_calls');
        expect(result.usage).toEqual({ prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
    });

    test('incomplete status maps to length', () => {
        const result = responsesResultToChatCompletion({ status: 'incomplete', output: [] });
        expect(result.choices[0].finish_reason).toBe('length');
    });
});
