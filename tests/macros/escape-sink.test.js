import { describe, test, expect } from '@jest/globals';
import {
    unescapeMacroBraces,
    unescapeMacroBracesInMessages,
    unescapeMacroBracesInRequestData,
} from '../../public/scripts/macros/util/escape.js';

// Phase 1 Macro escape lifecycle - sink-stage unescape utilities.
// Spec: docs/superpowers/specs/cardapp-studio-boundaries.md §5

describe('unescapeMacroBraces (I3 sink strip)', () => {
    test('strips backslash before macro opener', () => {
        expect(unescapeMacroBraces('\\{{foo}}')).toBe('{{foo}}');
    });

    test('strips backslash before macro closer', () => {
        expect(unescapeMacroBraces('\\{\\}')).toBe('{}');
    });

    test('strips inside a real-world setvar teaching example', () => {
        const input = '\\{{setvar::app_scene_actors::["白裙女孩","女店员"]}}';
        const expected = '{{setvar::app_scene_actors::["白裙女孩","女店员"]}}';
        expect(unescapeMacroBraces(input)).toBe(expected);
    });

    test('leaves un-escaped {{ alone', () => {
        expect(unescapeMacroBraces('{{foo}}')).toBe('{{foo}}');
    });

    test('handles mixed escaped and un-escaped within same string', () => {
        const input = '示例: \\{{setvar::a::1}} 输出: {{getvar::a}}';
        const expected = '示例: {{setvar::a::1}} 输出: {{getvar::a}}';
        expect(unescapeMacroBraces(input)).toBe(expected);
    });

    test('passes through empty string', () => {
        expect(unescapeMacroBraces('')).toBe('');
    });

    test('passes through string without braces', () => {
        expect(unescapeMacroBraces('plain text')).toBe('plain text');
    });

    test('returns non-string inputs as-is', () => {
        expect(unescapeMacroBraces(null)).toBeNull();
        expect(unescapeMacroBraces(undefined)).toBeUndefined();
        expect(unescapeMacroBraces(42)).toBe(42);
        expect(unescapeMacroBraces({ x: 1 })).toEqual({ x: 1 });
    });

    test('handles multiple escapes in sequence', () => {
        expect(unescapeMacroBraces('\\{\\{a\\}\\}')).toBe('{{a}}');
    });
});

describe('unescapeMacroBracesInMessages (I3 sink, OpenAI messages shape)', () => {
    test('strips in plain string content', () => {
        const messages = [
            { role: 'system', content: 'rule: \\{{setvar::a::1}}' },
            { role: 'user', content: 'do it' },
        ];
        const result = unescapeMacroBracesInMessages(messages);
        expect(result).toEqual([
            { role: 'system', content: 'rule: {{setvar::a::1}}' },
            { role: 'user', content: 'do it' },
        ]);
    });

    test('strips in multimodal text blocks, leaves image blocks alone', () => {
        const messages = [{
            role: 'user',
            content: [
                { type: 'text', text: 'caption: \\{{getvar::name}}' },
                { type: 'image_url', image_url: { url: 'https://x/y.png' } },
            ],
        }];
        const result = unescapeMacroBracesInMessages(messages);
        expect(result).toEqual([{
            role: 'user',
            content: [
                { type: 'text', text: 'caption: {{getvar::name}}' },
                { type: 'image_url', image_url: { url: 'https://x/y.png' } },
            ],
        }]);
    });

    test('does not mutate input array', () => {
        const messages = [{ role: 'user', content: '\\{{x}}' }];
        const snapshot = JSON.parse(JSON.stringify(messages));
        unescapeMacroBracesInMessages(messages);
        expect(messages).toEqual(snapshot);
    });

    test('passes empty array through', () => {
        expect(unescapeMacroBracesInMessages([])).toEqual([]);
    });

    test('returns non-array inputs as-is', () => {
        expect(unescapeMacroBracesInMessages(null)).toBeNull();
        expect(unescapeMacroBracesInMessages(undefined)).toBeUndefined();
        expect(unescapeMacroBracesInMessages('not an array')).toBe('not an array');
    });

    test('preserves messages with non-string non-array content (tool calls etc.)', () => {
        const messages = [{
            role: 'assistant',
            content: null,
            tool_calls: [{ id: '1', type: 'function', function: { name: 'foo', arguments: '{}' } }],
        }];
        const result = unescapeMacroBracesInMessages(messages);
        expect(result[0].content).toBeNull();
        expect(result[0].tool_calls).toEqual(messages[0].tool_calls);
    });
});

describe('unescapeMacroBracesInRequestData (I3 sink, generation request body)', () => {
    test('unescapes chat-completion-shape body (messages)', () => {
        const data = {
            messages: [
                { role: 'system', content: 'rule: \\{{setvar::a::1}}' },
                { role: 'user', content: 'do' },
            ],
            max_tokens: 100,
            temperature: 0.7,
        };
        const result = unescapeMacroBracesInRequestData(data);
        expect(result.messages[0].content).toBe('rule: {{setvar::a::1}}');
        expect(result.max_tokens).toBe(100);
        expect(result.temperature).toBe(0.7);
    });

    test('unescapes text-completion-shape body (prompt)', () => {
        const data = {
            prompt: 'instruction: \\{{addvar::hp::-5}}',
            max_tokens: 50,
            stream: true,
        };
        const result = unescapeMacroBracesInRequestData(data);
        expect(result.prompt).toBe('instruction: {{addvar::hp::-5}}');
        expect(result.max_tokens).toBe(50);
        expect(result.stream).toBe(true);
    });

    test('handles a body that has both prompt and messages (rare but possible)', () => {
        const data = {
            messages: [{ role: 'user', content: '\\{{a}}' }],
            prompt: '\\{{b}}',
        };
        const result = unescapeMacroBracesInRequestData(data);
        expect(result.messages[0].content).toBe('{{a}}');
        expect(result.prompt).toBe('{{b}}');
    });

    test('does not mutate input', () => {
        const data = {
            messages: [{ role: 'user', content: '\\{{x}}' }],
            prompt: '\\{{y}}',
        };
        const snapshot = JSON.parse(JSON.stringify(data));
        unescapeMacroBracesInRequestData(data);
        expect(data).toEqual(snapshot);
    });

    test('passes through body without prompt or messages fields', () => {
        const data = { foo: 'bar', baz: 42 };
        const result = unescapeMacroBracesInRequestData(data);
        expect(result).toEqual({ foo: 'bar', baz: 42 });
    });

    test('returns non-object inputs as-is', () => {
        expect(unescapeMacroBracesInRequestData(null)).toBeNull();
        expect(unescapeMacroBracesInRequestData(undefined)).toBeUndefined();
        expect(unescapeMacroBracesInRequestData('string')).toBe('string');
        expect(unescapeMacroBracesInRequestData(42)).toBe(42);
    });
});

describe('Round-trip: escape lifecycle (I1+I2+I3)', () => {
    test('source \\{{...}} survives multiple substituteParams stages and is stripped by sink', () => {
        // Simulates the world-info.js pipeline:
        //   source entry content has \{{setvar::a::1}}
        //   intermediate substitute (with keepEscapes:true) preserves \{{
        //   final sink strips backslash → {{setvar::a::1}}
        //   model receives literal {{ that it can copy back without escape
        const sourceContent = 'state: \\{{setvar::a::1}}';

        // Stage 1: keepEscapes intermediate (simulated — no real macro engine here,
        // we just verify the contract: \{ is preserved through any number of passes
        // that don't unescape).
        const intermediate = sourceContent;

        // Stage 2: sink unescape
        const final = unescapeMacroBraces(intermediate);
        expect(final).toBe('state: {{setvar::a::1}}');

        // Now an LLM that copies the literal `{{setvar::a::1}}` form (no backslash)
        // is exactly what op-log scanner expects to find and apply.
    });
});
