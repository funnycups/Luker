// tests/cea-character-iteration/control-tools.test.js
//
// Cover the control-tool surface added to CEA char-iter for the multi-round
// auto-continue loop. The studio splices `CONTROL_TOOL_DEFS` alongside the
// static `TOOL_DEFS` when calling the runner, and routes them through
// `onControlCall` (via `isCeaCharControlCall`) so they never reach
// `normalizeToolCallToEdit`.

import { describe, test, expect } from '@jest/globals';
import {
    TOOL_DEFS,
    CONTROL_TOOL_DEFS,
    CONTROL_TOOL_NAMES,
    isCeaCharControlCall,
    normalizeToolCallToEdit,
} from '../../public/scripts/extensions/character-editor-assistant/character-iteration/tools.js';

describe('CEA char-iter — control tools', () => {
    test('CONTROL_TOOL_DEFS shape: 2 entries, OpenAI-style', () => {
        expect(Array.isArray(CONTROL_TOOL_DEFS)).toBe(true);
        expect(CONTROL_TOOL_DEFS).toHaveLength(2);
        for (const def of CONTROL_TOOL_DEFS) {
            expect(def.type).toBe('function');
            expect(typeof def.function.name).toBe('string');
            expect(def.function.parameters.type).toBe('object');
        }
    });

    test('CONTROL_TOOL_NAMES.continue is luker_cea_charit_continue_iteration', () => {
        expect(CONTROL_TOOL_NAMES.continue).toBe('luker_cea_charit_continue_iteration');
    });

    test('CONTROL_TOOL_NAMES.finalize is luker_cea_charit_finalize_iteration', () => {
        expect(CONTROL_TOOL_NAMES.finalize).toBe('luker_cea_charit_finalize_iteration');
    });

    test('control tools sit alongside (not inside) the static TOOL_DEFS catalog', () => {
        const editNames = new Set(TOOL_DEFS.map(d => d.function.name));
        for (const def of CONTROL_TOOL_DEFS) {
            expect(editNames.has(def.function.name)).toBe(false);
        }
    });

    test('isCeaCharControlCall returns true for control tools', () => {
        expect(isCeaCharControlCall({ name: 'luker_cea_charit_continue_iteration' })).toBe(true);
        expect(isCeaCharControlCall({ name: 'luker_cea_charit_finalize_iteration' })).toBe(true);
    });

    test('isCeaCharControlCall returns false for edit tools, empty, null, undefined', () => {
        expect(isCeaCharControlCall({ name: 'cea_set_card_field' })).toBe(false);
        expect(isCeaCharControlCall({ name: 'cea_add_lorebook_entry' })).toBe(false);
        expect(isCeaCharControlCall({ name: '' })).toBe(false);
        expect(isCeaCharControlCall({})).toBe(false);
        expect(isCeaCharControlCall(null)).toBe(false);
        expect(isCeaCharControlCall(undefined)).toBe(false);
    });

    test('control tools route around normalizeToolCallToEdit (return [] on direct call)', async () => {
        // The studio's runner wiring routes control tools to onControlCall
        // rather than the executor; but even if a control tool somehow
        // reached normalizeToolCallToEdit (older runner version etc.), the
        // function should not crash — it returns [] for unknown names.
        const live = { card: { name: 'Alice' }, lorebook: { entries: {} } };
        const continueCall = {
            function: {
                name: 'luker_cea_charit_continue_iteration',
                arguments: JSON.stringify({ note: 'more please' }),
            },
        };
        const finalizeCall = {
            function: {
                name: 'luker_cea_charit_finalize_iteration',
                arguments: JSON.stringify({ summary: 'done' }),
            },
        };
        expect(await normalizeToolCallToEdit(continueCall, { live })).toEqual([]);
        expect(await normalizeToolCallToEdit(finalizeCall, { live })).toEqual([]);
    });
});
