// tests/mg-config-iteration/control-tools.test.js
//
// Drift test for the MG schema control-tool surface. Pins down the two
// reset control tools (reset_to_blank / reset_to_global) so a future refactor
// that drops one blows up here instead of silently changing AI behaviour.
// The legacy continue / finalize tools have been removed — the multi-round
// loop is program-driven by tool-call presence (any tool call → next round,
// none → stop).
//
// The actual reset behaviour (state.live mutation in onControlCall) is
// closure-private inside `openConfigIterationStudio`; full coverage
// happens in a browser verify run. This drift test is the jest-reachable
// safety net.

import { jest } from '@jest/globals';

// public/lib.js pulls in a browser bundle that can't be resolved under
// jest. Mirror the workaround other mg-config-iteration tests use.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

let CONTROL_TOOL_NAMES;

beforeAll(async () => {
    ({ CONTROL_TOOL_NAMES } = await import(
        '../../public/scripts/extensions/memory-graph/config-iteration/tools.js'
    ));
});

describe('MG schema control tools', () => {
    it('exposes only reset tools in CONTROL_TOOL_NAMES (no continue / finalize)', () => {
        expect(CONTROL_TOOL_NAMES.continue).toBeUndefined();
        expect(CONTROL_TOOL_NAMES.finalize).toBeUndefined();
        expect(CONTROL_TOOL_NAMES.resetToBlank).toBe('luker_mg_schema_reset_live_to_blank');
        expect(CONTROL_TOOL_NAMES.resetToGlobal).toBe('luker_mg_schema_reset_live_to_global');
    });
});
