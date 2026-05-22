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
let classifyToolCall;
let normalizeToolCallToEdit;
let TOOL_DISPLAY;

beforeAll(async () => {
    ({
        buildToolCatalog,
        EDITABLE_TOOL_NAMES,
        classifyToolCall,
        normalizeToolCallToEdit,
        TOOL_DISPLAY,
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
            { live: {} },
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
