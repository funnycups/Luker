// tests/mg-schema-iteration/tool-display.test.js
import { jest } from '@jest/globals';

// public/lib.js pulls in a browser bundle that can't be resolved under jest.
// Mirror the workaround other mg-schema-iteration tests use when they touch
// modules with transitive lib.js imports.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

let MG_SCHEMA_TOOL_DISPLAY;

beforeAll(async () => {
    ({ MG_SCHEMA_TOOL_DISPLAY } = await import(
        '../../public/scripts/extensions/memory-graph/schema-iteration/tool-display.js'
    ));
});

describe('MG schema tool-display map', () => {
    it('classifies set/remove/reorder as edit type with icons + labels', () => {
        expect(MG_SCHEMA_TOOL_DISPLAY.mg_schema_set_node_type?.type).toBe('edit');
        expect(MG_SCHEMA_TOOL_DISPLAY.mg_schema_set_node_type?.icon).toBeTruthy();
        expect(MG_SCHEMA_TOOL_DISPLAY.mg_schema_set_node_type?.label).toMatch(/[A-Za-z]/);

        expect(MG_SCHEMA_TOOL_DISPLAY.mg_schema_remove_node_type?.type).toBe('edit');
        expect(MG_SCHEMA_TOOL_DISPLAY.mg_schema_reorder_node_types?.type).toBe('edit');
    });

    it('classifies control tools as control type', () => {
        expect(MG_SCHEMA_TOOL_DISPLAY.luker_mg_schema_continue_iteration?.type).toBe('control');
        expect(MG_SCHEMA_TOOL_DISPLAY.luker_mg_schema_finalize_iteration?.type).toBe('control');
    });

    it('covers every MG schema tool name listed in schema-iteration/tools.js', async () => {
        const tools = await import(
            '../../public/scripts/extensions/memory-graph/schema-iteration/tools.js'
        );
        // tools.TOOL_DISPLAY is the authoritative tool-name → label registry
        // the studio already uses. Every key in it must have a
        // MG_SCHEMA_TOOL_DISPLAY entry so the shared renderToolCallChip
        // never falls back to '(tool)' for a known MG schema tool.
        const allNames = Object.keys(tools.TOOL_DISPLAY || {});
        expect(allNames.length).toBeGreaterThan(0);
        for (const name of allNames) {
            expect(MG_SCHEMA_TOOL_DISPLAY[name]).toBeDefined();
        }
    });
});
