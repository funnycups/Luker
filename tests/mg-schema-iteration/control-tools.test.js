// tests/mg-schema-iteration/control-tools.test.js
//
// Drift test for the MG schema control-tool surface. Pins down the two
// reset control tools (reset_to_blank / reset_to_global) so a future refactor
// that drops one blows up here instead of silently changing AI behaviour.
// The legacy continue / finalize tools have been removed — the multi-round
// loop is program-driven by tool-call presence (any tool call → next round,
// none → stop).
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
    it('exposes only reset tools in CONTROL_TOOL_NAMES (no continue / finalize)', () => {
        expect(CONTROL_TOOL_NAMES.continue).toBeUndefined();
        expect(CONTROL_TOOL_NAMES.finalize).toBeUndefined();
        expect(CONTROL_TOOL_NAMES.resetToBlank).toBe('luker_mg_schema_reset_live_to_blank');
        expect(CONTROL_TOOL_NAMES.resetToGlobal).toBe('luker_mg_schema_reset_live_to_global');
    });

    it('classifies both reset tools as control type in tool-display (no continue / finalize)', () => {
        expect(MG_SCHEMA_TOOL_DISPLAY.luker_mg_schema_continue_iteration).toBeUndefined();
        expect(MG_SCHEMA_TOOL_DISPLAY.luker_mg_schema_finalize_iteration).toBeUndefined();
        expect(MG_SCHEMA_TOOL_DISPLAY.luker_mg_schema_reset_live_to_blank?.type).toBe('control');
        expect(MG_SCHEMA_TOOL_DISPLAY.luker_mg_schema_reset_live_to_global?.type).toBe('control');
    });

    it('exposes exactly these 2 control tools (drift guard)', () => {
        const controlNames = Object.entries(MG_SCHEMA_TOOL_DISPLAY)
            .filter(([, v]) => v?.type === 'control')
            .map(([k]) => k)
            .sort();
        expect(controlNames).toEqual([
            'luker_mg_schema_reset_live_to_blank',
            'luker_mg_schema_reset_live_to_global',
        ]);
    });

    it('provides a non-empty icon + label for each control tool', () => {
        for (const name of [
            'luker_mg_schema_reset_live_to_blank',
            'luker_mg_schema_reset_live_to_global',
        ]) {
            const entry = MG_SCHEMA_TOOL_DISPLAY[name];
            expect(entry?.icon).toBeTruthy();
            expect(entry?.label).toMatch(/[A-Za-z]/);
        }
    });
});
