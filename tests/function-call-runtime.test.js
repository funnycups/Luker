import { describe, expect, test } from '@jest/globals';

import {
    buildFunctionCallRetryAddendum,
    buildPlainTextToolProtocolMessage,
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

    test('"prompt_json" forces prompt_json regardless of setting', () => {
        expect(resolveFunctionCallMode({ requestedMode: 'prompt_json', plainTextEnabled: false })).toBe('prompt_json');
        expect(resolveFunctionCallMode({ requestedMode: 'prompt_json', plainTextEnabled: true })).toBe('prompt_json');
    });

    test('missing/empty requestedMode behaves like "auto"', () => {
        expect(resolveFunctionCallMode({ plainTextEnabled: true })).toBe('prompt_xml');
        expect(resolveFunctionCallMode({ plainTextEnabled: false })).toBe('native');
        expect(resolveFunctionCallMode({ requestedMode: '', plainTextEnabled: true })).toBe('prompt_xml');
        expect(resolveFunctionCallMode()).toBe('native');
    });
});
