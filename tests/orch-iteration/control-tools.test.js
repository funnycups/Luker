// tests/orch-iteration/control-tools.test.js
//
// Drift test for the Orchestrator iter-popup control-tool surface. Pins
// down the two reset control tools (reset_to_blank / reset_to_global) so a
// future refactor that drops one blows up here instead of silently changing
// AI behaviour. The legacy continue / finalize control tools were removed
// from the iter popup — the multi-round loop is now program-driven by
// tool-call presence (any tool call → next round, none → stop).
// (Autonomous orchestrator runs in main.js still expose finalize at runtime;
// this test scope is iter-popup only.)
//
// The actual reset behaviour (state.live mutation in onControlCall) is
// closure-private inside `openOrchestratorIterationStudio`; full coverage
// happens in a browser verify run. This drift test is the jest-reachable
// safety net.

import { jest } from '@jest/globals';

// public/lib.js pulls in a browser bundle that can't be resolved under
// jest. Mirror the workaround other orch-iteration tests use.
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

describe('Orch iter-popup control tools', () => {
    it('classifies reset_to_blank / reset_to_global as control type', () => {
        expect(ORCH_TOOL_DISPLAY.luker_orch_reset_live_to_blank?.type).toBe('control');
        expect(ORCH_TOOL_DISPLAY.luker_orch_reset_live_to_global?.type).toBe('control');
    });

    it('does NOT include legacy continue / finalize tools in tool-display', () => {
        expect(ORCH_TOOL_DISPLAY.luker_orch_continue_iteration).toBeUndefined();
        expect(ORCH_TOOL_DISPLAY.luker_orch_finalize_iteration).toBeUndefined();
    });

    it('exposes exactly these 2 control tools in the iter popup (drift guard)', () => {
        const controlNames = Object.entries(ORCH_TOOL_DISPLAY)
            .filter(([, v]) => v?.type === 'control')
            .map(([k]) => k)
            .sort();
        expect(controlNames).toEqual([
            'luker_orch_reset_live_to_blank',
            'luker_orch_reset_live_to_global',
        ]);
    });

    it('provides a non-empty icon + label for each control tool', () => {
        for (const name of [
            'luker_orch_reset_live_to_blank',
            'luker_orch_reset_live_to_global',
        ]) {
            const entry = ORCH_TOOL_DISPLAY[name];
            expect(entry?.icon).toBeTruthy();
            expect(entry?.label).toMatch(/[A-Za-z]/);
        }
    });
});
