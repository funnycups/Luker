import { describe, expect, test } from '@jest/globals';

import {
    buildFunctionCallRetryAddendum,
    buildPlainTextToolProtocolMessage,
    extractAllFunctionCallsFromText,
    extractDisplayTextFromPlainTextFunctionResponse,
    isToolCallMandatory,
    resolveFunctionCallMode,
    TOOL_PROTOCOL_STYLE,
} from '../public/scripts/extensions/function-call-runtime.js';

describe('buildPlainTextToolProtocolMessage', () => {
    test('renders JSON_SCHEMA mode as human-readable parameter guidance', () => {
        const prompt = buildPlainTextToolProtocolMessage([
            {
                type: 'function',
                function: {
                    name: 'lookup_facts',
                    description: 'Look up facts with strict filters.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query text.',
                                minLength: 3,
                            },
                            safe_search: {
                                type: 'string',
                                enum: ['off', 'moderate', 'strict'],
                                default: 'moderate',
                            },
                            max_results: {
                                type: 'integer',
                                minimum: 1,
                                maximum: 5,
                            },
                            tags: {
                                type: 'array',
                                items: { type: 'string' },
                            },
                        },
                        required: ['query'],
                        additionalProperties: false,
                    },
                },
            },
        ], {
            style: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
            triggerSignal: '<Function_Test_Start/>',
        });

        expect(prompt).toContain('Required parameters: query');
        expect(prompt).toContain('Optional parameters: safe_search, max_results, tags');
        expect(prompt).toContain('Parameter details:');
        expect(prompt).toContain('- query:');
        expect(prompt).toContain('  - required: Yes');
        expect(prompt).toContain('  - constraints: {"minLength":3}');
        expect(prompt).toContain('  - enum: ["off","moderate","strict"]');
        expect(prompt).toContain('Schema rules: additionalProperties=false');
        expect(prompt).not.toContain('<parameters_schema>');
    });
});

describe('buildFunctionCallRetryAddendum', () => {
    test('includes explicit failure patterns and a corrected skeleton', () => {
        const addendum = buildFunctionCallRetryAddendum({
            rawResponse: 'I will call a tool now.',
            errorDetails: 'Missing <function_calls> tag after trigger signal.',
            triggerSignal: '<Function_Test_Start/>',
            requiredFunctionName: 'lookup_facts',
            plainTextMode: true,
        });

        expect(addendum).toContain('Common invalid patterns to avoid:');
        expect(addendum).toContain('Correct skeleton:');
        expect(addendum).toContain('<Function_Test_Start/>');
        expect(addendum).toContain('<function_calls>');
        expect(addendum).toContain('Required function name: lookup_facts.');
    });
});

describe('isToolCallMandatory', () => {
    test('returns false for optional tool usage', () => {
        expect(isToolCallMandatory()).toBe(false);
        expect(isToolCallMandatory({ toolChoice: 'auto' })).toBe(false);
    });

    test('returns true when tool_choice or required function enforces a call', () => {
        expect(isToolCallMandatory({ toolChoice: 'required' })).toBe(true);
        expect(isToolCallMandatory({ requiredFunctionName: 'lookup_facts' })).toBe(true);
    });
});

describe('resolveFunctionCallMode', () => {
    test('"auto" + plain-text enabled resolves to prompt_xml so extensions honor the setting', () => {
        expect(resolveFunctionCallMode({ requestedMode: 'auto', plainTextEnabled: true })).toBe('prompt_xml');
    });

    test('"auto" + plain-text disabled resolves to native', () => {
        expect(resolveFunctionCallMode({ requestedMode: 'auto', plainTextEnabled: false })).toBe('native');
    });

    test('"native" forces native even when plain-text setting is enabled', () => {
        expect(resolveFunctionCallMode({ requestedMode: 'native', plainTextEnabled: true })).toBe('native');
        expect(resolveFunctionCallMode({ requestedMode: 'native', plainTextEnabled: false })).toBe('native');
    });

    test('"prompt_xml" forces prompt_xml regardless of setting', () => {
        expect(resolveFunctionCallMode({ requestedMode: 'prompt_xml', plainTextEnabled: false })).toBe('prompt_xml');
        expect(resolveFunctionCallMode({ requestedMode: 'prompt_xml', plainTextEnabled: true })).toBe('prompt_xml');
    });

    test('unknown mode strings (including removed alias) fall back to auto behavior', () => {
        expect(resolveFunctionCallMode({ requestedMode: 'prompt_json', plainTextEnabled: false })).toBe('native');
        expect(resolveFunctionCallMode({ requestedMode: 'prompt_json', plainTextEnabled: true })).toBe('prompt_xml');
    });

    test('missing/empty requestedMode behaves like "auto"', () => {
        expect(resolveFunctionCallMode({ plainTextEnabled: true })).toBe('prompt_xml');
        expect(resolveFunctionCallMode({ plainTextEnabled: false })).toBe('native');
        expect(resolveFunctionCallMode({ requestedMode: '', plainTextEnabled: true })).toBe('prompt_xml');
        expect(resolveFunctionCallMode()).toBe('native');
    });
});

describe('extractAllFunctionCallsFromText', () => {
    const TRIGGER = '<Function_Tst1_Start/>';

    function makeResponse(content) {
        return { choices: [{ message: { role: 'assistant', content } }] };
    }

    test('parses calls from a trigger-scoped <function_calls> payload', () => {
        const content = [
            'Let me check that.',
            TRIGGER,
            '<function_calls>',
            '  <function_call>',
            '    <tool>lookup_facts</tool>',
            '    <args_json><![CDATA[{"query":"alpha"}]]></args_json>',
            '  </function_call>',
            '</function_calls>',
        ].join('\n');
        const calls = extractAllFunctionCallsFromText(makeResponse(content), null, {
            triggerSignal: TRIGGER,
            triggerRequired: true,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('lookup_facts');
        expect(calls[0].args).toEqual({ query: 'alpha' });
    });

    test('a trigger-less response stays classified as no-tool even when it contains a <function_calls> payload', () => {
        // The trigger signal is the sole intent marker of the strict
        // plain-text contract; a payload without it is a protocol
        // violation the caller sees as an ordinary text reply — the
        // payload must not be executed.
        const content = [
            '<function_calls>',
            '  <function_call>',
            '    <tool>lookup_facts</tool>',
            '    <args_json><![CDATA[{"query":"alpha"}]]></args_json>',
            '  </function_call>',
            '</function_calls>',
        ].join('\n');
        expect(() => extractAllFunctionCallsFromText(makeResponse(content), null, {
            triggerSignal: TRIGGER,
            triggerRequired: true,
        })).toThrow('Model text output did not include the required trigger signal.');
    });
});

describe('extractDisplayTextFromPlainTextFunctionResponse', () => {
    const TRIGGER = '<Function_Tst1_Start/>';

    test('returns the preamble before the trigger when the trigger is present', () => {
        const payload = [
            '<function_calls>',
            '  <function_call>',
            '    <tool>lookup_facts</tool>',
            '  </function_call>',
            '</function_calls>',
        ].join('\n');
        const source = `Answer text.\n${TRIGGER}\n${payload}`;
        expect(extractDisplayTextFromPlainTextFunctionResponse(source, { triggerSignal: TRIGGER }))
            .toBe('Answer text.');
    });

    test('returns trigger-less text verbatim, keeping an unparsed <function_calls> payload visible', () => {
        // If the pipeline did not parse the payload as tool calls, it has
        // no business removing it from the visible reply: the model's
        // protocol violation must stay 1:1 in the assistant text.
        const source = [
            'About to edit the preset.',
            '<function_calls>',
            '  <function_call>',
            '    <tool>apply_edits</tool>',
            '    <args_json><![CDATA[{"edits":[]}]]></args_json>',
            '  </function_call>',
            '</function_calls>',
        ].join('\n');
        expect(extractDisplayTextFromPlainTextFunctionResponse(source, { triggerSignal: TRIGGER }))
            .toBe(source);
    });

    test('returns plain prose unchanged', () => {
        expect(extractDisplayTextFromPlainTextFunctionResponse('Just a normal reply.', { triggerSignal: TRIGGER }))
            .toBe('Just a normal reply.');
    });
});
