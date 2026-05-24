// tests/orch-iteration/control-tools.test.js
//
// Drift test for the Orchestrator control-tool surface. Pins down the
// four control tools the popup advertises to the runner so a future
// refactor that drops `reset_to_global` or `reset_to_blank` blows up
// here instead of silently changing AI behaviour.
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

describe('Orch control tools', () => {
    it('classifies all 4 control tools (continue / finalize / reset_to_blank / reset_to_global) as control', () => {
        expect(ORCH_TOOL_DISPLAY.luker_orch_continue_iteration?.type).toBe('control');
        expect(ORCH_TOOL_DISPLAY.luker_orch_finalize_iteration?.type).toBe('control');
        expect(ORCH_TOOL_DISPLAY.luker_orch_reset_live_to_blank?.type).toBe('control');
        expect(ORCH_TOOL_DISPLAY.luker_orch_reset_live_to_global?.type).toBe('control');
    });

    it('exposes exactly these 4 control tools (drift guard)', () => {
        const controlNames = Object.entries(ORCH_TOOL_DISPLAY)
            .filter(([, v]) => v?.type === 'control')
            .map(([k]) => k)
            .sort();
        expect(controlNames).toEqual([
            'luker_orch_continue_iteration',
            'luker_orch_finalize_iteration',
            'luker_orch_reset_live_to_blank',
            'luker_orch_reset_live_to_global',
        ]);
    });

    it('provides a non-empty icon + label for each control tool', () => {
        for (const name of [
            'luker_orch_continue_iteration',
            'luker_orch_finalize_iteration',
            'luker_orch_reset_live_to_blank',
            'luker_orch_reset_live_to_global',
        ]) {
            const entry = ORCH_TOOL_DISPLAY[name];
            expect(entry?.icon).toBeTruthy();
            expect(entry?.label).toMatch(/[A-Za-z]/);
        }
    });
});
