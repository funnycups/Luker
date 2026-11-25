// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// CEA editor read-tool dispatch for shared `inspect_bound_preset`:
// runCeaEditorReadTool hands the call to runCharacterPresetReadTool with
// the editor's avatar and returns the shared executor's envelope unchanged.

import { describe, expect, test } from '@jest/globals';
import { STATE_ERROR_REASONS } from '../../public/scripts/lib/state-errors.js';

const { runCeaEditorReadTool } = await import(
    '../../public/scripts/workbench/targets/card-tools.js'
);

const presetsBody = {
    A: { temperature: 0.4, char_name: 'Inspect' },
    B: { temperature: 0.9 },
};

function makeContext() {
    const character = {
        avatar: 'Inspect.png',
        data: { extensions: { luker: { chat_completion_preset: { presets: [
            { name: 'A', preset: presetsBody.A },
            { name: 'B', preset: presetsBody.B },
        ], defaultPresetName: 'A' } } } },
    };
    return {
        characters: [character],
        characterId: 0,
        character: {
            presets: {
                list: (_c) => [
                    { name: 'A', preset: presetsBody.A, isDefault: true },
                    { name: 'B', preset: presetsBody.B, isDefault: false },
                ],
                get: (_c, name) => (presetsBody[name] ? { name, preset: presetsBody[name] } : null),
            },
        },
    };
}

describe('CEA editor read dispatch — inspect_bound_preset', () => {
    test('action=list returns every card-bound preset', async () => {
        const out = await runCeaEditorReadTool(
            { id: 'c1', name: 'inspect_bound_preset', args: { action: 'list' } },
            { context: makeContext(), avatar: 'Inspect.png' },
        );
        expect(out).toEqual({
            ok: true,
            result: [
                { name: 'A', isDefault: true, hasBody: true },
                { name: 'B', isDefault: false, hasBody: true },
            ],
        });
    });

    test('action=get returns one preset body', async () => {
        const out = await runCeaEditorReadTool(
            { id: 'c2', name: 'inspect_bound_preset', args: { action: 'get', name: 'B' } },
            { context: makeContext(), avatar: 'Inspect.png' },
        );
        expect(out).toEqual({ ok: true, result: { name: 'B', preset: presetsBody.B } });
    });

    test('an unknown avatar returns the executor failure envelope', async () => {
        const out = await runCeaEditorReadTool(
            { id: 'c3', name: 'inspect_bound_preset', args: { action: 'list' } },
            { context: makeContext(), avatar: 'Missing.png' },
        );
        expect(out.ok).toBe(false);
        expect(out.reason).toBe(STATE_ERROR_REASONS.VALIDATION_TARGET);
        expect(typeof out.error).toBe('string');
    });
});
