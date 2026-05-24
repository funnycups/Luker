// tests/memory-graph/schema-iteration-tools.test.js
//
// Covers the static surface of memory-graph/schema-iteration/tools.js:
//   - buildToolCatalog merges TOOL_DEFS + the four control tools
//     (continue / finalize / resetToBlank / resetToGlobal)
//   - isMgSchemaControlCall recognizes all four control names; rejects edit tools
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
    test('returns TOOL_DEFS plus the four control tools', () => {
        const catalog = buildToolCatalog();
        expect(catalog.length).toBe(TOOL_DEFS.length + 4);
        for (const def of catalog) {
            expect(def.type).toBe('function');
            expect(typeof def.function.name).toBe('string');
        }
    });

    test('includes luker_mg_schema_continue_iteration', () => {
        const names = buildToolCatalog().map(d => d.function?.name);
        expect(names).toContain(CONTROL_TOOL_NAMES.continue);
        expect(CONTROL_TOOL_NAMES.continue).toBe('luker_mg_schema_continue_iteration');
    });

    test('includes luker_mg_schema_finalize_iteration', () => {
        const names = buildToolCatalog().map(d => d.function?.name);
        expect(names).toContain(CONTROL_TOOL_NAMES.finalize);
        expect(CONTROL_TOOL_NAMES.finalize).toBe('luker_mg_schema_finalize_iteration');
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

    test('control tools have minimal parameter schemas', () => {
        const catalog = buildToolCatalog();
        const cont = catalog.find(d => d.function?.name === CONTROL_TOOL_NAMES.continue);
        const fin = catalog.find(d => d.function?.name === CONTROL_TOOL_NAMES.finalize);
        const rBlank = catalog.find(d => d.function?.name === CONTROL_TOOL_NAMES.resetToBlank);
        const rGlobal = catalog.find(d => d.function?.name === CONTROL_TOOL_NAMES.resetToGlobal);
        expect(cont?.function?.parameters?.type).toBe('object');
        expect(fin?.function?.parameters?.type).toBe('object');
        expect(rBlank?.function?.parameters?.type).toBe('object');
        expect(rGlobal?.function?.parameters?.type).toBe('object');
        // `note` is the only continue arg; `summary` is the only finalize arg.
        // Both reset tools take an optional `reason` for parity with Orch.
        expect(cont?.function?.parameters?.properties?.note).toBeTruthy();
        expect(fin?.function?.parameters?.properties?.summary).toBeTruthy();
        expect(rBlank?.function?.parameters?.properties?.reason).toBeTruthy();
        expect(rGlobal?.function?.parameters?.properties?.reason).toBeTruthy();
    });
});

describe('MG schema — isMgSchemaControlCall', () => {
    test('returns true for all four control tool names', () => {
        expect(isMgSchemaControlCall({ name: 'luker_mg_schema_continue_iteration' })).toBe(true);
        expect(isMgSchemaControlCall({ name: 'luker_mg_schema_finalize_iteration' })).toBe(true);
        expect(isMgSchemaControlCall({ name: 'luker_mg_schema_reset_live_to_blank' })).toBe(true);
        expect(isMgSchemaControlCall({ name: 'luker_mg_schema_reset_live_to_global' })).toBe(true);
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
