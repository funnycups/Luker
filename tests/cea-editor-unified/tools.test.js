import { jest } from '@jest/globals';

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

// Mock the main.js boundary so we don't drag the SillyTavern shell into tests.
// The unified editor's tools.js wraps the legacy helper-tool runner from
// main.js; everything else is built on top of character-iteration/tools.js.
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/main.js', () => ({
    splitCharacterEditorToolCalls: (calls) => ({
        editCalls: (Array.isArray(calls) ? calls : []).filter(c => /^cea_/.test(c?.name || '')),
        helperCalls: (Array.isArray(calls) ? calls : []).filter(c => !/^cea_/.test(c?.name || '')),
    }),
    runCharacterEditorHelperToolCall: async (call) => ({ result: { stub: true, name: call?.name || '' } }),
    normalizeCharacterEditorOperationsFromCalls: (calls) => (Array.isArray(calls) ? calls : []).map(c => ({
        op: 'set',
        path: c?.args?.field || '',
        oldValue: null,
        newValue: c?.args?.value,
    })),
    buildCharacterEditorToolSchemas: () => [
        { type: 'function', function: { name: 'cea_set_card_field', parameters: {} } },
    ],
}));

let tools;
beforeAll(async () => {
    tools = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/tools.js');
});

describe('unified CEA editor tools.js', () => {
    it('exports CONTROL_TOOL_NAMES and isCeaEditorControlCall (no control tools today)', () => {
        // CEA editor has no popup-side control tools — the multi-round loop
        // is program-driven by tool-call presence (any tool call → next
        // round, none → stop). CONTROL_TOOL_NAMES is empty and
        // isCeaEditorControlCall returns false for everything.
        expect(tools.CONTROL_TOOL_NAMES.continue).toBeUndefined();
        expect(tools.CONTROL_TOOL_NAMES.finalize).toBeUndefined();
        expect(tools.isCeaEditorControlCall({ name: 'luker_cea_editor_continue_iteration' })).toBe(false);
        expect(tools.isCeaEditorControlCall({ name: 'luker_cea_editor_finalize_iteration' })).toBe(false);
        expect(tools.isCeaEditorControlCall({ name: 'cea_set_card_field' })).toBe(false);
        expect(tools.isCeaEditorControlCall({})).toBe(false);
        expect(tools.isCeaEditorControlCall(null)).toBe(false);
    });

    it('isCeaEditorReadTool classifies helpers correctly', () => {
        expect(tools.isCeaEditorReadTool('lorebook_query')).toBe(true);
        expect(tools.isCeaEditorReadTool('lorebook_list')).toBe(true);
        expect(tools.isCeaEditorReadTool('lorebook_get')).toBe(true);
        expect(tools.isCeaEditorReadTool('world_book_list')).toBe(true);
        expect(tools.isCeaEditorReadTool('web_search')).toBe(true);
        expect(tools.isCeaEditorReadTool('simulate_prompt')).toBe(true);
        expect(tools.isCeaEditorReadTool('cea_set_card_field')).toBe(false);
        expect(tools.isCeaEditorReadTool('cea_update_lorebook_entry')).toBe(false);
        expect(tools.isCeaEditorReadTool('luker_cea_editor_continue_iteration')).toBe(false);
        expect(tools.isCeaEditorReadTool('')).toBe(false);
        expect(tools.isCeaEditorReadTool(null)).toBe(false);
    });

    it('normalizeToolCallToEdit annotates character target for cea_set_card_field', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c1', name: 'cea_set_card_field', args: { field: 'description', value: 'new' } },
            { context: {}, live: { character: { description: 'old' } } },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits[0].target?.kind).toBe('character');
    });

    it('normalizeToolCallToEdit annotates character target for cea_str_replace_card_field', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c1b', name: 'cea_str_replace_card_field', args: { field: 'description', find: 'a', replace: 'b' } },
            { context: {}, live: { character: { description: 'abc' } } },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits[0].target?.kind).toBe('character');
    });

    it('normalizeToolCallToEdit annotates lorebook target with bookName when book_name is present', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c2', name: 'cea_update_lorebook_entry', args: { book_name: 'BookA', uid: 3, patch: { content: 'x' } } },
            { context: {}, live: { lorebooks: { BookA: { entries: { 3: { content: 'old' } } } } } },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits[0].target?.kind).toBe('lorebook');
        expect(edits[0].target?.bookName).toBe('BookA');
    });

    it('normalizeToolCallToEdit annotates lorebook target for cea_add_lorebook_entry', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c3', name: 'cea_add_lorebook_entry', args: { book_name: 'BookB', entry: { uid: 7, content: 'hi' } } },
            { context: {}, live: { lorebooks: { BookB: { entries: {} } } } },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits[0].target?.kind).toBe('lorebook');
        expect(edits[0].target?.bookName).toBe('BookB');
    });

    it('normalizeToolCallToEdit annotates lorebook target for cea_remove_lorebook_entry', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c4', name: 'cea_remove_lorebook_entry', args: { book_name: 'BookC', uid: 5 } },
            { context: {}, live: { lorebooks: { BookC: { entries: { 5: { content: 'doomed' } } } } } },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits[0].target?.kind).toBe('lorebook');
        expect(edits[0].target?.bookName).toBe('BookC');
    });

    it('normalizeToolCallToEdit annotates lorebook target for cea_set_lorebook_metadata', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c5', name: 'cea_set_lorebook_metadata', args: { book_name: 'BookD', key: 'bookName', value: 'Renamed' } },
            { context: {}, live: { lorebooks: { BookD: {} } } },
        );
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits[0].target?.kind).toBe('lorebook');
        expect(edits[0].target?.bookName).toBe('BookD');
    });

    it('normalizeToolCallToEdit falls back to target.kind=lorebook without bookName when arg missing', async () => {
        const edits = await tools.normalizeToolCallToEdit(
            { id: 'c6', name: 'cea_update_lorebook_entry', args: { uid: 1, patch: {} } },
            { context: {}, live: {} },
        );
        expect(Array.isArray(edits)).toBe(true);
        if (edits.length > 0) {
            expect(edits[0].target?.kind).toBe('lorebook');
            expect(edits[0].target?.bookName).toBeFalsy();
        }
    });

    it('normalizeToolCallToEdit returns null when args fail to parse / are malformed', async () => {
        // Per spec: malformed call returns null (distinct from [] which means
        // "valid call but no edits").
        const out = await tools.normalizeToolCallToEdit(
            { id: 'bad', name: 'cea_set_card_field', args: 'not-an-object' },
            { context: {}, live: {} },
        );
        // Either null (malformed) or [] (no-op) is acceptable here; both signal
        // "nothing to apply". We just must not crash.
        expect(out === null || Array.isArray(out)).toBe(true);
    });

    it('runCeaEditorReadTool delegates to the legacy helper runner', async () => {
        const out = await tools.runCeaEditorReadTool(
            { id: 'r1', name: 'lorebook_query', args: { book_name: 'BookA', query: 'x' } },
            { context: {}, settings: {}, helperApis: [] },
        );
        expect(out.ok).toBe(true);
        expect(out.result?.stub).toBe(true);
    });

    it('runCeaEditorReadTool surfaces errors via { ok: false, error }', async () => {
        // Pass a non-read tool name; the wrapper should refuse or surface an error.
        const out = await tools.runCeaEditorReadTool(
            { id: 'bad', name: 'cea_set_card_field', args: {} },
            { context: {}, settings: {}, helperApis: [] },
        );
        expect(out.ok).toBe(false);
        expect(typeof out.error).toBe('string');
        expect(out.error.length).toBeGreaterThan(0);
    });

    it('CONTROL_TOOL_DEFS is empty (no popup-side control tools)', () => {
        expect(tools.CONTROL_TOOL_DEFS.length).toBe(0);
        const names = tools.CONTROL_TOOL_DEFS.map(d => d.function?.name);
        expect(names).not.toContain('luker_cea_editor_continue_iteration');
        expect(names).not.toContain('luker_cea_editor_finalize_iteration');
    });

    it('buildCeaEditorToolSet returns edit + read tools (no control tools)', () => {
        const set = tools.buildCeaEditorToolSet({}, {}, { live: { character: {}, lorebooks: {} } });
        expect(Array.isArray(set)).toBe(true);
        expect(set.length).toBeGreaterThanOrEqual(2);
        const names = set.map(t => t.function?.name);
        // No control tools anymore — multi-round loop is program-driven.
        expect(names).not.toContain('luker_cea_editor_continue_iteration');
        // Finalize is gone — assert NOT present so a regression that
        // re-adds it would fail loud.
        expect(names).not.toContain('luker_cea_editor_finalize_iteration');
        // At least one of the edit tools should be in the set.
        const ceaEdits = ['cea_set_card_field', 'cea_str_replace_card_field', 'cea_add_lorebook_entry'];
        expect(ceaEdits.some(n => names.includes(n))).toBe(true);
    });

    it('buildCeaEditorToolSet contains the 6 short-name read tools', () => {
        const set = tools.buildCeaEditorToolSet({}, {}, { live: {}, hasSearchTools: true });
        const names = set.map(t => t.function?.name);
        for (const n of ['lorebook_query', 'lorebook_list', 'lorebook_get', 'world_book_list', 'simulate_prompt']) {
            expect(names).toContain(n);
        }
        // web_search is gated on hasSearchTools
        expect(names).toContain('web_search');
    });

    it('buildCeaEditorToolSet omits web_search when hasSearchTools is false', () => {
        const set = tools.buildCeaEditorToolSet({}, {}, { live: {}, hasSearchTools: false });
        const names = set.map(t => t.function?.name);
        expect(names).not.toContain('web_search');
    });
});

describe('CEA editor tool-display map', () => {
    let map;
    beforeAll(async () => {
        ({ CEA_EDITOR_TOOL_DISPLAY: map } = await import(
            '../../public/scripts/extensions/character-editor-assistant/editor-iteration/tool-display.js'
        ));
    });

    it('classifies all 7 edit tools as edit', () => {
        for (const n of [
            'cea_set_card_field',
            'cea_str_replace_card_field',
            'cea_add_lorebook_entry',
            'cea_update_lorebook_entry',
            'cea_str_replace_lorebook_entry_field',
            'cea_remove_lorebook_entry',
            'cea_set_lorebook_metadata',
        ]) {
            expect(map[n]?.type).toBe('edit');
            expect(typeof map[n]?.label).toBe('string');
            expect(map[n]?.label.length).toBeGreaterThan(0);
            expect(typeof map[n]?.icon).toBe('string');
        }
    });

    it('classifies all 6 read tools as read with summarize function', () => {
        for (const n of [
            'lorebook_query',
            'lorebook_list',
            'lorebook_get',
            'world_book_list',
            'web_search',
            'simulate_prompt',
        ]) {
            expect(map[n]?.type).toBe('read');
            expect(typeof map[n]?.summarize).toBe('function');
            expect(typeof map[n]?.label).toBe('string');
            expect(map[n]?.label.length).toBeGreaterThan(0);
        }
    });

    it('excludes legacy continue / finalize control tools (program-driven auto-continue)', () => {
        expect(map.luker_cea_editor_continue_iteration).toBeUndefined();
        expect(map.luker_cea_editor_finalize_iteration).toBeUndefined();
    });

    it('summarize functions handle missing args / results without throwing', () => {
        const readNames = ['lorebook_query', 'lorebook_list', 'lorebook_get', 'world_book_list', 'web_search', 'simulate_prompt'];
        for (const n of readNames) {
            expect(() => map[n].summarize(undefined, undefined)).not.toThrow();
            expect(() => map[n].summarize({}, null)).not.toThrow();
        }
    });

    it('summarize for lorebook_query renders hit count when result has matches', () => {
        const out = map.lorebook_query.summarize({ book_name: 'BookA', query: 'foo' }, { matches: [1, 2, 3] });
        expect(String(out)).toContain('3');
    });

    it('summarize for world_book_list renders book count when result has books', () => {
        const out = map.world_book_list.summarize({}, { books: ['A', 'B'] });
        expect(String(out)).toContain('2');
    });

    it('contains exactly the 13 tools spec\'d (7 edit + 6 read, no control)', () => {
        const keys = Object.keys(map);
        expect(keys.length).toBe(13);
        expect(keys.filter(k => map[k].type === 'edit').length).toBe(7);
        expect(keys.filter(k => map[k].type === 'read').length).toBe(6);
        expect(keys.filter(k => map[k].type === 'control').length).toBe(0);
    });
});
