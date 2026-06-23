// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Unit coverage for the shared strict-arg accessor that the
// orchestrator's per-tool executors use to validate optional-string
// fields (systemPrompt / apiPresetName / promptPresetName /
// userPromptTemplate / description / type, …).
//
// This helper is load-bearing for the silent-noop fix: previously each
// set_* tool used a `typeof args.X === 'string' ? X : existing.X`
// pattern that silently fell back to the existing value when the AI
// passed the wrong type. The iter-studio's sandbox-diff then saw
// before === after and pushed a misleading "already matches" noop —
// the AI never learned what was wrong and re-emitted the same broken
// call in a loop.
//
// Each `set_*` executor now invokes this helper inside a try/catch and
// surfaces a real `{ok:false, error:'invalid_args', detail}` tool
// reply on throw. The four call sites (set_director_main_agent /
// set_director_subagent / set_agenda_agent / set_node) share the same
// shape so this helper test is the proxy for all of them — the
// executor wiring is straight-line code reading.

import { describe, test, expect } from '@jest/globals';
import {
    readIterationStringArg,
} from '../../public/scripts/extensions/orchestrator/iter-arg-validator.js';

describe('readIterationStringArg — strict optional-string accessor', () => {
    test('returns undefined when the key is absent (caller inherits)', () => {
        expect(readIterationStringArg({}, 'systemPrompt', 'luker_orch_set_director_main_agent')).toBeUndefined();
    });

    test('returns the string verbatim when present with the right type', () => {
        expect(readIterationStringArg({ systemPrompt: 'hello' }, 'systemPrompt', 'tool_x')).toBe('hello');
    });

    test('returns empty string verbatim — explicit empty string is a legitimate AI patch (e.g. clearing a field)', () => {
        // Distinguishing "absent" from "explicit empty string" matters
        // here. The helper preserves the explicit empty so the caller
        // can write '' rather than inheriting the existing value.
        expect(readIterationStringArg({ description: '' }, 'description', 'tool_x')).toBe('');
    });

    test('throws invalid_args with tool prefix when value is a number', () => {
        expect(() => readIterationStringArg({ systemPrompt: 42 }, 'systemPrompt', 'tool_X'))
            .toThrow(/tool_X.*invalid_args.*systemPrompt.*number/);
    });

    test('throws invalid_args when value is null', () => {
        // null isn't a string and isn't a missing-key signal either —
        // explicit null is treated as a typed value the AI intended.
        expect(() => readIterationStringArg({ systemPrompt: null }, 'systemPrompt', 'tool_x'))
            .toThrow(/invalid_args.*systemPrompt/);
    });

    test('throws invalid_args when value is an object', () => {
        expect(() => readIterationStringArg({ systemPrompt: { wrapped: 'x' } }, 'systemPrompt', 'tool_x'))
            .toThrow(/invalid_args.*systemPrompt.*object/);
    });

    test('throws invalid_args when value is a boolean', () => {
        expect(() => readIterationStringArg({ systemPrompt: true }, 'systemPrompt', 'tool_x'))
            .toThrow(/invalid_args.*systemPrompt.*boolean/);
    });

    test('handles null / undefined args gracefully (treats them as empty args)', () => {
        expect(readIterationStringArg(null, 'anything', 'tool_x')).toBeUndefined();
        expect(readIterationStringArg(undefined, 'anything', 'tool_x')).toBeUndefined();
    });

    test('handles non-object args gracefully (no crash on AI sending a string instead of an object)', () => {
        expect(readIterationStringArg('not an object', 'anything', 'tool_x')).toBeUndefined();
        expect(readIterationStringArg(42, 'anything', 'tool_x')).toBeUndefined();
    });

    test('uses Object.hasOwnProperty.call to defend against keys that shadow prototype methods', () => {
        // Defensive: an AI passing args with a `toString` field
        // intentionally shouldn't see the prototype's toString method
        // leak through the accessor.
        expect(readIterationStringArg({}, 'toString', 'tool_x')).toBeUndefined();
        expect(readIterationStringArg({ toString: 'override' }, 'toString', 'tool_x')).toBe('override');
    });
});
