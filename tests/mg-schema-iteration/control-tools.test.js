// tests/mg-schema-iteration/control-tools.test.js
//
// Drift test for the MG schema control-tool surface. Pins down the four
// control tools (continue / finalize / reset_to_blank / reset_to_global)
// so a future refactor that drops one blows up here instead of silently
// changing AI behaviour.
//
// The actual reset behaviour (state.live mutation in onControlCall) is
// closure-private inside `openSchemaIterationStudio`; full coverage
// happens in a browser verify run. This drift test is the jest-reachable
// safety net.

import { jest } from '@jest/globals';

// public/lib.js pulls in a browser bundle that can't be resolved under
// jest. Mirror the workaround other mg-schema-iteration tests use.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

let MG_SCHEMA_TOOL_DISPLAY;
let CONTROL_TOOL_NAMES;

beforeAll(async () => {
    ({ MG_SCHEMA_TOOL_DISPLAY } = await import(
        '../../public/scripts/extensions/memory-graph/schema-iteration/tool-display.js'
    ));
    ({ CONTROL_TOOL_NAMES } = await import(
        '../../public/scripts/extensions/memory-graph/schema-iteration/tools.js'
    ));
});

describe('MG schema control tools', () => {
    it('exposes resetToBlank + resetToGlobal in the CONTROL_TOOL_NAMES freeze', () => {
        expect(CONTROL_TOOL_NAMES.continue).toBe('luker_mg_schema_continue_iteration');
        expect(CONTROL_TOOL_NAMES.finalize).toBe('luker_mg_schema_finalize_iteration');
        expect(CONTROL_TOOL_NAMES.resetToBlank).toBe('luker_mg_schema_reset_live_to_blank');
        expect(CONTROL_TOOL_NAMES.resetToGlobal).toBe('luker_mg_schema_reset_live_to_global');
    });

    it('classifies all 4 control tools as control type in tool-display', () => {
        expect(MG_SCHEMA_TOOL_DISPLAY.luker_mg_schema_continue_iteration?.type).toBe('control');
        expect(MG_SCHEMA_TOOL_DISPLAY.luker_mg_schema_finalize_iteration?.type).toBe('control');
        expect(MG_SCHEMA_TOOL_DISPLAY.luker_mg_schema_reset_live_to_blank?.type).toBe('control');
        expect(MG_SCHEMA_TOOL_DISPLAY.luker_mg_schema_reset_live_to_global?.type).toBe('control');
    });

    it('exposes exactly these 4 control tools (drift guard)', () => {
        const controlNames = Object.entries(MG_SCHEMA_TOOL_DISPLAY)
            .filter(([, v]) => v?.type === 'control')
            .map(([k]) => k)
            .sort();
        expect(controlNames).toEqual([
            'luker_mg_schema_continue_iteration',
            'luker_mg_schema_finalize_iteration',
            'luker_mg_schema_reset_live_to_blank',
            'luker_mg_schema_reset_live_to_global',
        ]);
    });

    it('provides a non-empty icon + label for each control tool', () => {
        for (const name of [
            'luker_mg_schema_continue_iteration',
            'luker_mg_schema_finalize_iteration',
            'luker_mg_schema_reset_live_to_blank',
            'luker_mg_schema_reset_live_to_global',
        ]) {
            const entry = MG_SCHEMA_TOOL_DISPLAY[name];
            expect(entry?.icon).toBeTruthy();
            expect(entry?.label).toMatch(/[A-Za-z]/);
        }
    });
});
