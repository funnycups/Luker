// tests/cpa-iteration/tools.test.js
import { describe, test, expect, beforeAll, jest } from '@jest/globals';

// public/lib.js pulls in a browser bundle that can't be resolved under jest.
// Mirror the same workaround used by tests/iteration-studio-adapters/cpa-smoke.test.js:
// stub the facade to a thin { lodash } re-export.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

let buildToolCatalog;
let EDITABLE_TOOL_NAMES;
let READ_TOOL_NAMES;
let classifyToolCall;
let normalizeToolCallToEdit;
let TOOL_DISPLAY;
let isCpaControlCall;
let runCpaReadTool;

beforeAll(async () => {
    ({
        buildToolCatalog,
        EDITABLE_TOOL_NAMES,
        READ_TOOL_NAMES,
        classifyToolCall,
        normalizeToolCallToEdit,
        TOOL_DISPLAY,
        isCpaControlCall,
        runCpaReadTool,
    } = await import('../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/tools.js'));
});

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

describe('CPA — tools', () => {
    test('buildToolCatalog returns at least 17 tools, all with display labels', () => {
        // The full 17-tool catalog appears when hasReference=true. With
        // hasReference=false the catalog is 15 tools (preset_copy_from_reference
        // and preset_read_reference_fields are gated behind a selected reference).
        const catalog = buildToolCatalog({ hasReference: true });
        expect(catalog.length).toBeGreaterThanOrEqual(17);
        for (const def of catalog) {
            expect(def.type).toBe('function');
            expect(TOOL_DISPLAY[def.function.name]).toBeTruthy();
        }
    });

    test('buildToolCatalog includes reference-only tools when hasReference=true', () => {
        const base = buildToolCatalog({ hasReference: false });
        const withRef = buildToolCatalog({ hasReference: true });
        expect(withRef.length).toBeGreaterThanOrEqual(base.length);
    });

    test('preset_set_field → set edit with lodash.get oldValue', async () => {
        const live = { temperature: 0.7, deep: { nested: 'old' } };
        const edits = await normalizeToolCallToEdit(call('preset_set_field', { path: 'deep.nested', value: 'new' }), { live });
        expect(edits).toEqual([{ op: 'set', path: 'deep.nested', oldValue: 'old', newValue: 'new' }]);
    });

    test('preset_set_field accepts value_json for non-primitives', async () => {
        const live = { tools_array: [] };
        const edits = await normalizeToolCallToEdit(
            call('preset_set_field', { path: 'tools_array', value_json: '[{"id":1}]' }),
            { live },
        );
        expect(edits).toEqual([{ op: 'set', path: 'tools_array', oldValue: [], newValue: [{ id: 1 }] }]);
    });

    test('preset_str_replace → str_replace edit with expected_count', async () => {
        const edits = await normalizeToolCallToEdit(
            call('preset_str_replace', { path: 'main', find: 'old', replace: 'new', expected_count: 2 }),
            { live: {} },
        );
        expect(edits).toEqual([{ op: 'str_replace', path: 'main', find: 'old', replace: 'new', expected_count: 2 }]);
    });

    test('preset_str_insert → str_insert edit', async () => {
        const edits = await normalizeToolCallToEdit(
            call('preset_str_insert', { path: 'main', after_text: 'foo', insert_text: 'bar' }),
            { live: { main: 'this has foo in it' } },
        );
        expect(edits[0]).toMatchObject({ op: 'str_insert', path: 'main', after_text: 'foo', insert_text: 'bar' });
    });

    test('classifyToolCall returns "editable" for editable tools, "control" otherwise', () => {
        expect(classifyToolCall(call('preset_set_field', {}))).toBe('editable');
        const allTools = buildToolCatalog({ hasReference: true }).map(d => d.function.name);
        const nonEditable = allTools.find(n => !EDITABLE_TOOL_NAMES.has(n));
        if (nonEditable) {
            expect(classifyToolCall(call(nonEditable, {}))).toBe('control');
        }
    });

    test('malformed JSON args → returns null', async () => {
        const bad = { function: { name: 'preset_set_field', arguments: '{not json' } };
        const edits = await normalizeToolCallToEdit(bad, { live: {} });
        expect(edits).toBeNull();
    });
});

describe('CPA control tools — multi-round support', () => {
    test('buildToolCatalog includes luker_cpa_continue_iteration', () => {
        const catalog = buildToolCatalog({ hasReference: true });
        const names = catalog.map(d => d.function?.name);
        expect(names).toContain('luker_cpa_continue_iteration');
    });

    test('buildToolCatalog includes luker_cpa_finalize_iteration', () => {
        const catalog = buildToolCatalog({ hasReference: true });
        const names = catalog.map(d => d.function?.name);
        expect(names).toContain('luker_cpa_finalize_iteration');
    });

    test('control tools appear even when hasReference=false (always available)', () => {
        const catalog = buildToolCatalog({ hasReference: false });
        const names = catalog.map(d => d.function?.name);
        expect(names).toContain('luker_cpa_continue_iteration');
        expect(names).toContain('luker_cpa_finalize_iteration');
    });

    test('isCpaControlCall returns true for control tools and false for edit tools', () => {
        expect(isCpaControlCall({ name: 'luker_cpa_continue_iteration' })).toBe(true);
        expect(isCpaControlCall({ name: 'luker_cpa_finalize_iteration' })).toBe(true);
        expect(isCpaControlCall({ name: 'preset_set_field' })).toBe(false);
        expect(isCpaControlCall({ name: '' })).toBe(false);
        expect(isCpaControlCall({})).toBe(false);
        expect(isCpaControlCall(null)).toBe(false);
        expect(isCpaControlCall(undefined)).toBe(false);
    });
});

describe('CPA — preset_clone_to_new (restored as side-effecting read tool)', () => {
    test('buildToolCatalog exposes preset_clone_to_new with or without reference', () => {
        for (const hasReference of [false, true]) {
            const names = buildToolCatalog({ hasReference }).map(d => d.function?.name);
            expect(names).toContain('preset_clone_to_new');
        }
    });

    test('schema is strict (additionalProperties: false) and requires new_name', () => {
        const def = buildToolCatalog({ hasReference: false })
            .find(d => d.function?.name === 'preset_clone_to_new');
        expect(def).toBeDefined();
        expect(def.function.parameters.required).toEqual(['new_name']);
        expect(def.function.parameters.additionalProperties).toBe(false);
        expect(def.function.parameters.properties).toHaveProperty('new_name');
        expect(def.function.parameters.properties).toHaveProperty('reason');
    });

    test('TOOL_DISPLAY contains preset_clone_to_new', () => {
        expect(TOOL_DISPLAY.preset_clone_to_new).toBeTruthy();
    });

    test('READ_TOOL_NAMES contains preset_clone_to_new (routed through read dispatcher)', () => {
        expect(READ_TOOL_NAMES.has('preset_clone_to_new')).toBe(true);
    });

    test('runCpaReadTool calls ctx.cloneAndSwitchTarget with the new name on success', async () => {
        let receivedName = null;
        const ctx = {
            cloneAndSwitchTarget: async (name) => {
                receivedName = name;
                return { ok: true };
            },
        };
        const out = await runCpaReadTool({ name: 'preset_clone_to_new', args: { new_name: 'foo' } }, ctx);
        expect(receivedName).toBe('foo');
        expect(out).toEqual({ ok: true, result: { new_name: 'foo', cloned: true } });
    });

    test('runCpaReadTool reports unavailable when ctx.cloneAndSwitchTarget is missing', async () => {
        const out = await runCpaReadTool({ name: 'preset_clone_to_new', args: { new_name: 'foo' } }, {});
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/not wired/);
    });

    test('runCpaReadTool returns an error when new_name is missing or empty', async () => {
        const ctx = { cloneAndSwitchTarget: async () => ({ ok: true }) };
        const noName = await runCpaReadTool({ name: 'preset_clone_to_new', args: {} }, ctx);
        expect(noName.ok).toBe(false);
        expect(noName.error).toMatch(/non-empty new_name/);

        const empty = await runCpaReadTool({ name: 'preset_clone_to_new', args: { new_name: '   ' } }, ctx);
        expect(empty.ok).toBe(false);
        expect(empty.error).toMatch(/non-empty new_name/);
    });

    test('runCpaReadTool surfaces the host-stub error path to the AI', async () => {
        // Mirror the production main.js stub that returns { ok: false, error: ... }
        // (auto-clone wiring is not yet implemented). The dispatcher must
        // propagate the host's error verbatim instead of throwing.
        const ctx = {
            cloneAndSwitchTarget: async () => ({
                ok: false,
                error: 'Auto-clone is not wired yet. Please save a copy manually via the preset dropdown\'s Save As button, then re-run.',
            }),
        };
        const out = await runCpaReadTool({ name: 'preset_clone_to_new', args: { new_name: 'foo' } }, ctx);
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/Auto-clone is not wired yet/);
    });

    test('runCpaReadTool catches synchronous throws from cloneAndSwitchTarget', async () => {
        const ctx = {
            cloneAndSwitchTarget: async () => { throw new Error('boom'); },
        };
        const out = await runCpaReadTool({ name: 'preset_clone_to_new', args: { new_name: 'foo' } }, ctx);
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/boom/);
    });
});

describe('CPA — preset_str_insert / preset_str_delete expected_count (CPA-9)', () => {
    test('preset_str_insert enforces uniqueness — throws on ambiguous anchor', async () => {
        await expect(normalizeToolCallToEdit(
            call('preset_str_insert', { path: 'main', after_text: 'foo', insert_text: 'bar' }),
            { live: { main: 'foo foo' } },
        )).rejects.toThrow(/expected 1 match.*found 2/);
    });

    test('preset_str_insert enforces uniqueness — throws when anchor missing', async () => {
        await expect(normalizeToolCallToEdit(
            call('preset_str_insert', { path: 'main', after_text: 'missing', insert_text: 'x' }),
            { live: { main: 'no anchor here' } },
        )).rejects.toThrow(/expected 1 match.*found 0/);
    });

    test('preset_str_delete enforces uniqueness — throws on ambiguous anchor', async () => {
        await expect(normalizeToolCallToEdit(
            call('preset_str_delete', { path: 'main', find: 'dup' }),
            { live: { main: 'dup dup' } },
        )).rejects.toThrow(/expected 1 match.*found 2/);
    });

    test('preset_str_insert / preset_str_delete reject expected_count > 1 (engine only supports unique anchors)', async () => {
        await expect(normalizeToolCallToEdit(
            call('preset_str_insert', { path: 'main', after_text: 'foo', insert_text: 'x', expected_count: 2 }),
            { live: { main: 'foo foo' } },
        )).rejects.toThrow(/expected_count = 1/);
    });

    test('preset_str_delete with unique anchor → str_delete edit', async () => {
        const edits = await normalizeToolCallToEdit(
            call('preset_str_delete', { path: 'main', find: 'gone' }),
            { live: { main: 'before gone after' } },
        );
        expect(edits[0]).toMatchObject({ op: 'str_delete', path: 'main', find: 'gone' });
    });
});
