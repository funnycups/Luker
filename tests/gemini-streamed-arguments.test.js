// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from '@jest/globals';
import { createProtocolStreamParser, ProtocolParseError } from '../public/scripts/lib/protocol-parser/index.js';

function fixture() {
    const parser = createProtocolStreamParser('makersuite');
    const feed = (parts, finishReason) => parser.feedFrame(JSON.stringify({
        candidates: [{ content: { role: 'model', parts }, finishReason }],
    }));
    const fn = (fc, extra) => feed([{ functionCall: fc, ...extra }]);
    return { parser, feed, fn };
}

describe('Gemini streamed function arguments', () => {
    test('previews growing reply text and commits one signed, replayable call only when it closes', () => {
        const { parser, feed, fn } = fixture();
        fn({ name: 'reply', id: 'c1', willContinue: true }, { thoughtSignature: 'signed' });
        fn({ partialArgs: [{ jsonPath: '$.body', stringValue: '纸', willContinue: true }], willContinue: true });
        expect(parser.getToolCallPreview('reply', 'body')).toBe('纸');
        expect(parser.getSnapshot().toolCalls).toEqual([]);
        expect(parser.getSnapshot().nativeParts).toBeNull();
        fn({ partialArgs: [{ jsonPath: '$.body', stringValue: '上\n"花"' }, { jsonPath: '$.note', stringValue: 'other field' }], willContinue: true });
        expect(parser.getToolCallPreview('reply', 'body')).toBe('纸上\n"花"');
        fn({ partialArgs: [{ jsonPath: '$.body', stringValue: '' }], willContinue: true });
        fn({});
        feed([{ text: '' }], 'STOP');
        const turn = parser.finish();
        const args = { body: '纸上\n"花"', note: 'other field' };
        expect(turn.toolCalls).toEqual([{ id: 'c1', type: 'function', signature: 'signed', function: { name: 'reply', arguments: JSON.stringify(args) } }]);
        expect(turn.nativeParts[0]).toEqual({ functionCall: { id: 'c1', name: 'reply', args }, thoughtSignature: 'signed' });
        expect(turn.parts.filter(p => p.type === 'tool_call')).toHaveLength(1);
        expect(turn.text).toBe('');
    });

    test('previews nested object and array paths via dot and JSONPath notation', () => {
        const { parser, feed, fn } = fixture();
        fn({
            name: 'reply',
            id: 'c_nested',
            partialArgs: [{ jsonPath: '$.payload.paragraphs[0].text', stringValue: '第一段', willContinue: true }],
            willContinue: true,
        });
        expect(parser.getToolCallPreview('reply', 'payload.paragraphs[0].text')).toBe('第一段');
        expect(parser.getToolCallPreview('reply', '$.payload.paragraphs[0].text')).toBe('第一段');
        fn({ partialArgs: [{ jsonPath: '$.payload.paragraphs[0].text', stringValue: '续写' }] });
        expect(parser.getToolCallPreview('reply', 'payload.paragraphs[0].text')).toBe('第一段续写');
        feed([], 'STOP');
        const turn = parser.finish();
        expect(JSON.parse(turn.toolCalls[0].function.arguments)).toEqual({
            payload: { paragraphs: [{ text: '第一段续写' }] },
        });
    });

    test('interleaved IDs, nested array paths and later full arguments keep call order and types', () => {
        const { parser, feed, fn } = fixture();
        fn({ name: 'a', id: '1', willContinue: true });
        fn({ name: 'b', id: '2', willContinue: true });
        fn({ id: '2', args: { x: true } });
        fn({ id: '1', partialArgs: [
            { jsonPath: '$.items[1]["a.b"]', boolValue: false },
            { jsonPath: '$.items[0][\'a.b\']', numberValue: 0 },
            { jsonPath: '$.maybe', nullValue: 'NULL_VALUE' },
        ] });
        feed([], 'STOP');
        const turn = parser.finish();
        expect(turn.toolCalls.map(c => c.id)).toEqual(['1', '2']);
        expect(turn.nativeParts[0].functionCall.args).toEqual({ items: [{ 'a.b': 0 }, { 'a.b': false }], maybe: null });
        expect(turn.nativeParts[1].functionCall.args).toEqual({ x: true });
    });

    test('final empty args object does not wipe out previously streamed partialArgs', () => {
        const { parser, feed, fn } = fixture();
        fn({ name: 'reply', id: 'c_keep', partialArgs: [{ jsonPath: '$.body', stringValue: 'hello' }], willContinue: true });
        fn({ id: 'c_keep', args: {} });
        feed([], 'STOP');
        const turn = parser.finish();
        expect(JSON.parse(turn.toolCalls[0].function.arguments)).toEqual({ body: 'hello' });
        expect(parser.getToolCallPreview('reply', 'body')).toBe('hello');
    });

    test('supports snake_case partial_args and will_continue aliases', () => {
        const { parser, feed } = fixture();
        feed([{
            function_call: {
                name: 'reply',
                id: 'c_snake',
                partial_args: [{ json_path: '$.body', string_value: '你好', will_continue: true }],
                will_continue: true,
            },
            thought_signature: 'sig-snake',
        }]);
        expect(parser.getToolCallPreview('reply', 'body')).toBe('你好');
        feed([{
            function_call: {
                id: 'c_snake',
                partial_args: [{ json_path: '$.body', string_value: '世界' }],
                will_continue: false,
            },
        }]);
        feed([], 'STOP');
        const turn = parser.finish();
        expect(turn.toolCalls).toEqual([{
            id: 'c_snake',
            type: 'function',
            signature: 'sig-snake',
            function: { name: 'reply', arguments: JSON.stringify({ body: '你好世界' }) },
        }]);
    });

    test('truncation preserves the preview and excludes unfinished invocations from replay', () => {
        const { parser, feed, fn } = fixture();
        fn({ name: 'reply', partialArgs: [{ jsonPath: '$.body', stringValue: 'draft' }], willContinue: true });
        feed([], 'MAX_TOKENS');
        expect(parser.getToolCallPreview('reply', 'body')).toBe('draft');
        expect(parser.finish()).toMatchObject({ toolCalls: [], nativeParts: null, finishReason: 'length' });
    });

    test('rejects ambiguous continuations, non-array partialArgs, and malformed termination', () => {
        const { parser, feed, fn } = fixture();
        fn({ name: 'a', id: '1', willContinue: true });
        fn({ name: 'b', id: '2', willContinue: true });
        expect(() => fn({})).toThrow(ProtocolParseError);
        expect(() => fn({ id: '1', partialArgs: { jsonPath: '$.x' } })).toThrow(ProtocolParseError);
        feed([], 'STOP');
        expect(() => parser.finish()).toThrow(ProtocolParseError);
    });
});
