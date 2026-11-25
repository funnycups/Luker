// tests/orchestrator/custom-tools-sanitize-exports.test.js
import { describe, test, expect } from '@jest/globals';
import {
    CUSTOM_TOOL_NAME_PATTERN,
    isValidCustomToolName,
    compileCustomToolBody,
} from '../../public/scripts/extensions/orchestrator/custom-tools-sanitize.js';
import { isBuiltinToolName } from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import { registerOrchestrationTool } from '../../public/scripts/extensions/orchestrator/register-custom-tool.js';

describe('custom tool name and compile helpers', () => {
    test('CUSTOM_TOOL_NAME_PATTERN accepts letter-led names up to 64 characters', () => {
        expect(CUSTOM_TOOL_NAME_PATTERN.test('tide_lookup')).toBe(true);
        expect(CUSTOM_TOOL_NAME_PATTERN.test('a'.repeat(64))).toBe(true);
        expect(CUSTOM_TOOL_NAME_PATTERN.test('a'.repeat(65))).toBe(false);
        expect(CUSTOM_TOOL_NAME_PATTERN.test('9lives')).toBe(false);
        expect(CUSTOM_TOOL_NAME_PATTERN.test('tide-lookup')).toBe(false);
    });

    test('isValidCustomToolName treats nullish as an invalid empty name', () => {
        expect(isValidCustomToolName(undefined)).toBe(false);
        expect(isValidCustomToolName(null)).toBe(false);
        expect(isValidCustomToolName('reef_chart')).toBe(true);
    });

    test('compileCustomToolBody returns an async function over args and ctx', async () => {
        const fn = compileCustomToolBody('return args.reef + ":" + ctx.tide;');
        await expect(fn({ reef: 'west' }, { tide: 'slack' })).resolves.toBe('west:slack');
    });

    test('compileCustomToolBody treats an empty body as a no-op', async () => {
        await expect(compileCustomToolBody('')({}, {})).resolves.toBeUndefined();
        await expect(compileCustomToolBody(undefined)({}, {})).resolves.toBeUndefined();
    });

    test('compileCustomToolBody throws SyntaxError on invalid source', () => {
        expect(() => compileCustomToolBody('return (;')).toThrow(SyntaxError);
    });

    test('isBuiltinToolName matches the Layer-1 registry and registration rejects builtin names', () => {
        expect(isBuiltinToolName('chat_search')).toBe(true);
        expect(isBuiltinToolName('reef_chart_lookup')).toBe(false);
        expect(() => registerOrchestrationTool({ name: 'chat_search', mode: 'read', exec: async () => null }))
            .toThrow(/conflicts with a builtin tool/);
    });
});
