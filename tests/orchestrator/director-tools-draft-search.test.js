import { describe, test, expect } from '@jest/globals';
import {
    DRAFT_SEARCH_TOOL,
    executeDraftSearchTool,
    buildSubAgentToolSchemas,
    buildMainAgentToolSchemas,
    GET_DRAFT_TOOL,
} from '../../public/scripts/extensions/orchestrator/director-tools.js';

function makeHandle(text) {
    return { getText: () => String(text ?? '') };
}

describe('DRAFT_SEARCH_TOOL schema', () => {
    test('declares pattern (required) and flags (optional, default gm)', () => {
        const fn = DRAFT_SEARCH_TOOL.function;
        expect(fn.name).toBe('draft_search');
        expect(fn.parameters.required).toEqual(['pattern']);
        expect(fn.parameters.properties.pattern.type).toBe('string');
        expect(fn.parameters.properties.flags.type).toBe('string');
        expect(fn.parameters.properties.flags.default).toBe('gm');
    });

    test('description mentions escape-for-literal and prefer non-greedy', () => {
        const desc = DRAFT_SEARCH_TOOL.function.parameters.properties.pattern.description;
        expect(desc).toMatch(/escape/i);
        expect(desc).toMatch(/non-greedy/i);
    });
});

describe('executeDraftSearchTool', () => {
    test('returns grep -n shape on match', async () => {
        const handle = makeHandle('line one\nline two\nline three');
        const result = await executeDraftSearchTool(handle, { pattern: 'line t' });
        expect(result).toEqual({ ok: true, output: '2: line two\n3: line three' });
    });

    test('returns empty output on no match', async () => {
        const handle = makeHandle('nothing here');
        const result = await executeDraftSearchTool(handle, { pattern: 'absent' });
        expect(result).toEqual({ ok: true, output: '' });
    });

    test('returns ok=false with escape hint on invalid regex', async () => {
        const handle = makeHandle('whatever');
        const result = await executeDraftSearchTool(handle, { pattern: '[bad' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/invalid regex/);
        expect(result.error).toMatch(/escape regex metacharacters/);
    });

    test('returns ok=false when handle has no getText', async () => {
        const result = await executeDraftSearchTool(null, { pattern: 'x' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/no handle/i);
    });

    test('returns ok=false when pattern is empty or missing', async () => {
        const handle = makeHandle('text');
        const result = await executeDraftSearchTool(handle, {});
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/pattern/i);
    });

    test('respects flags argument for case-insensitive', async () => {
        const handle = makeHandle('Hello\nHELLO');
        const result = await executeDraftSearchTool(handle, { pattern: 'hello', flags: 'gmi' });
        expect(result).toEqual({ ok: true, output: '1: Hello\n2: HELLO' });
    });
});

describe('tool inclusion in agent schema lists', () => {
    test('sub-agent schemas include both get_draft and draft_search', () => {
        const list = buildSubAgentToolSchemas({ tools: {} });
        const names = list.map(s => s.function.name);
        expect(names).toContain('get_draft');
        expect(names).toContain('draft_search');
    });

    test('main-agent schemas include both get_draft and draft_search', () => {
        const list = buildMainAgentToolSchemas({ subAgents: [], tools: {} });
        const names = list.map(s => s.function.name);
        expect(names).toContain('get_draft');
        expect(names).toContain('draft_search');
    });
});
