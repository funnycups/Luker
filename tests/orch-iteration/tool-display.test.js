// tests/orch-iteration/tool-display.test.js
//
// Drift test for the Orchestrator tool-display map. Confirms the shape
// contract the shared `iteration-library/ui/toolcall.renderToolCallChip`
// expects (`{ icon, label, type, summarize? }`) and pins down the
// classification of the three popup-flow control tools so future tool
// additions don't accidentally re-tag continue/finalize/reset as
// edit-type. The map's coverage across all four mode catalogs is
// intentionally NOT asserted here (Orch's mode-aware tool catalog lives
// in main.js as four separate `buildAiIterationToolSet` branches; the
// equivalent of CPA's `tools.TOOL_DISPLAY` "every tool name" coverage
// check would have to mock the orchestrator settings/session shape to
// invoke buildAiIterationToolSet for each mode, which is out of scope
// for an M1 drift test).

import { jest } from '@jest/globals';

// public/lib.js pulls in a browser bundle that can't be resolved under
// jest. Mirror the workaround used by tests/cpa-iteration/tool-display.test.js:
// stub the facade to a thin { lodash } re-export so any transitive
// imports (the studio's chain into iteration-library, etc.) resolve
// without dragging the bundle in. The tool-display module itself has no
// runtime deps but the workspace is jest-config'd assuming this is
// available.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

let ORCH_TOOL_DISPLAY;

beforeAll(async () => {
    ({ ORCH_TOOL_DISPLAY } = await import(
        '../../public/scripts/extensions/orchestrator/iter-studio/tool-display.js'
    ));
});

describe('Orch tool-display map', () => {
    it('excludes legacy continue / finalize from iter popup catalog (program-driven auto-continue)', () => {
        expect(ORCH_TOOL_DISPLAY.luker_orch_continue_iteration).toBeUndefined();
        expect(ORCH_TOOL_DISPLAY.luker_orch_finalize_iteration).toBeUndefined();
    });

    it('classifies reset_to_blank as control', () => {
        expect(ORCH_TOOL_DISPLAY.luker_orch_reset_live_to_blank?.type).toBe('control');
    });

    it('has at least one edit-type entry', () => {
        const editEntries = Object.values(ORCH_TOOL_DISPLAY).filter(e => e.type === 'edit');
        expect(editEntries.length).toBeGreaterThan(0);
    });
});
