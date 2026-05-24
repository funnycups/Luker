// tests/memory-graph/schema-iteration-tools.test.js
//
// Covers the static surface of memory-graph/schema-iteration/tools.js:
//   - buildToolCatalog merges TOOL_DEFS + the two reset control tools
//     (resetToBlank / resetToGlobal). The legacy continue / finalize
//     control tools were removed — the multi-round loop is now program-
//     driven by tool-call presence (any tool call → next round, none → stop).
//   - isMgSchemaControlCall recognizes both reset names; rejects edit tools
//
// These tests are pure ESM with no DOM access — they hit only the exported
// functions of the tools module, which avoids the popup's browser-only deps.

import { describe, test, expect } from '@jest/globals';

import {
    TOOL_DEFS,
    TOOL_DISPLAY,
    CONTROL_TOOL_NAMES,
    buildToolCatalog,
    isMgSchemaControlCall,
    normalizeToolCallToEdit,
} from '../../public/scripts/extensions/memory-graph/schema-iteration/tools.js';

describe('MG schema — buildToolCatalog', () => {
    test('returns TOOL_DEFS plus the two reset control tools', () => {
        const catalog = buildToolCatalog();
        expect(catalog.length).toBe(TOOL_DEFS.length + 2);
        for (const def of catalog) {
            expect(def.type).toBe('function');
            expect(typeof def.function.name).toBe('string');
        }
    });

    test('does NOT include luker_mg_schema_continue_iteration (legacy, removed)', () => {
        const names = buildToolCatalog().map(d => d.function?.name);
        expect(names).not.toContain('luker_mg_schema_continue_iteration');
        expect(CONTROL_TOOL_NAMES.continue).toBeUndefined();
    });

    test('does NOT include luker_mg_schema_finalize_iteration (legacy, removed)', () => {
        const names = buildToolCatalog().map(d => d.function?.name);
        expect(names).not.toContain('luker_mg_schema_finalize_iteration');
        expect(CONTROL_TOOL_NAMES.finalize).toBeUndefined();
    });

    test('includes luker_mg_schema_reset_live_to_blank', () => {
        const names = buildToolCatalog().map(d => d.function?.name);
        expect(names).toContain(CONTROL_TOOL_NAMES.resetToBlank);
        expect(CONTROL_TOOL_NAMES.resetToBlank).toBe('luker_mg_schema_reset_live_to_blank');
    });

    test('includes luker_mg_schema_reset_live_to_global', () => {
        const names = buildToolCatalog().map(d => d.function?.name);
        expect(names).toContain(CONTROL_TOOL_NAMES.resetToGlobal);
        expect(CONTROL_TOOL_NAMES.resetToGlobal).toBe('luker_mg_schema_reset_live_to_global');
    });

    test('every catalog entry has a TOOL_DISPLAY label', () => {
        const catalog = buildToolCatalog();
        for (const def of catalog) {
            expect(TOOL_DISPLAY[def.function.name]).toBeTruthy();
        }
    });

    test('reset tools have minimal parameter schemas', () => {
        const catalog = buildToolCatalog();
        const rBlank = catalog.find(d => d.function?.name === CONTROL_TOOL_NAMES.resetToBlank);
        const rGlobal = catalog.find(d => d.function?.name === CONTROL_TOOL_NAMES.resetToGlobal);
        expect(rBlank?.function?.parameters?.type).toBe('object');
        expect(rGlobal?.function?.parameters?.type).toBe('object');
        expect(rBlank?.function?.parameters?.properties?.reason).toBeTruthy();
        expect(rGlobal?.function?.parameters?.properties?.reason).toBeTruthy();
    });
});

describe('MG schema — isMgSchemaControlCall', () => {
    test('returns true for both current reset control tool names', () => {
        expect(isMgSchemaControlCall({ name: 'luker_mg_schema_reset_live_to_blank' })).toBe(true);
        expect(isMgSchemaControlCall({ name: 'luker_mg_schema_reset_live_to_global' })).toBe(true);
    });

    test('returns false for the legacy continue / finalize tools (regression guard)', () => {
        // If the AI emits a legacy continue/finalize call (e.g. from a
        // stale session replayed after the popup inverted to program-driven
        // auto-continue), the runner routes it through onToolCall (not
        // onControlCall) so the absence of a popup-side handler doesn't
        // silently swallow it. The tools themselves are no longer in the
        // catalog.
        expect(isMgSchemaControlCall({ name: 'luker_mg_schema_continue_iteration' })).toBe(false);
        expect(isMgSchemaControlCall({ name: 'luker_mg_schema_finalize_iteration' })).toBe(false);
    });

    test('returns false for edit tools', () => {
        expect(isMgSchemaControlCall({ name: 'mg_schema_set_node_type' })).toBe(false);
        expect(isMgSchemaControlCall({ name: 'mg_schema_remove_node_type' })).toBe(false);
        expect(isMgSchemaControlCall({ name: 'mg_schema_reorder_node_types' })).toBe(false);
    });

    test('returns false for empty / missing / wrong-namespace names', () => {
        expect(isMgSchemaControlCall({ name: '' })).toBe(false);
        expect(isMgSchemaControlCall({ name: 'luker_cpa_continue_iteration' })).toBe(false);
        expect(isMgSchemaControlCall({})).toBe(false);
        expect(isMgSchemaControlCall(null)).toBe(false);
        expect(isMgSchemaControlCall(undefined)).toBe(false);
    });
});

describe('MG schema — normalizeToolCallToEdit (smoke)', () => {
    // The detailed sandbox-diff behavior is already covered by the legacy
    // adapter tests. These two assertions document that the surface is
    // unchanged after the buildToolCatalog refactor.
    const normalize = (s) => Array.isArray(s) ? s : [];
    test('produces a single set-empty-path edit for an upsert call', async () => {
        const call = {
            function: {
                name: 'mg_schema_set_node_type',
                arguments: JSON.stringify({ node_type: { id: 'character', label: 'Character', tableColumns: ['name'] } }),
            },
        };
        const edits = await normalizeToolCallToEdit(call, {
            live: [],
            normalizeNodeTypeSchema: normalize,
        });
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBe(1);
        expect(edits[0].op).toBe('set');
        expect(edits[0].path).toBe('');
    });

    test('returns [] for an unknown tool name (no-op)', async () => {
        const call = {
            function: {
                name: 'not_a_real_tool',
                arguments: JSON.stringify({}),
            },
        };
        const edits = await normalizeToolCallToEdit(call, {
            live: [],
            normalizeNodeTypeSchema: normalize,
        });
        expect(edits).toEqual([]);
    });
});
