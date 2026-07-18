// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Pins the contract of `dispatchCeaReadCardFields`, the executor helper
// for the CEA card iter-studio's `cea_read_card_fields` tool.
//
// Unlike the orchestrator's and MG schema's `<mode>_read_fields` (which
// consume lodash-style path strings), CEA card reads use an ENUM-FIELD
// contract: `fields` is an array whose entries MUST be drawn from
// `CEA_CARD_FIELD_ENUM`. The whitelist is the same set the AI is allowed
// to WRITE via `cea_set_card_field` / `cea_str_replace_card_field`, so
// the AI cannot use the read tool to peek at surfaces that have
// dedicated tools of their own (`extensions.world` → `world_book_list`,
// `extensions.regex_scripts` → `regex_list_scripts`, etc.).
//
// Tested here directly (not through studio.js) so we can pin the
// contract without dragging the ST-context / jQuery import graph into
// jest — tools.js only imports `runCharacterEditorHelperToolCall` from
// main.js which triggers the full runtime.

import { jest } from '@jest/globals';

// Stub the one main.js export tools.js imports at module load. The read
// dispatcher never routes through the legacy helper runner, so the
// stub can be a trivial noop.
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/main.js', () => ({
    runCharacterEditorHelperToolCall: async () => ({ result: {} }),
}));

let tools;
beforeAll(async () => {
    tools = await import('../../public/scripts/extensions/character-editor-assistant/editor-iteration/tools.js');
});

// Sample card with a mix of every whitelisted shape (string, array) plus
// an `extensions` blob to prove it stays off-limits.
function makeCard(overrides = {}) {
    return {
        name: 'Ash',
        description: 'The cartographer of the Bryn headland.',
        personality: 'Reserved, precise.',
        scenario: '',
        first_mes: 'The reef chart unfolds on the rail.',
        mes_example: '',
        system_prompt: '',
        post_history_instructions: '',
        creator_notes: 'V2 card imported by user.',
        alternate_greetings: ['A: at dawn.', 'B: at dusk.'],
        // extensions is INTENTIONALLY not in the enum — its sub-surfaces
        // (world, regex_scripts, depth_prompt, …) have dedicated tools.
        extensions: { world: 'secret_book', regex_scripts: [{ id: 'x' }] },
        ...overrides,
    };
}

describe('cea_read_card_fields — enum-whitelist contract', () => {
    test('reads whitelisted string and array fields', async () => {
        const out = await tools.dispatchCeaReadCardFields({
            state: { live: { character: makeCard() } },
            args: { fields: ['name', 'personality', 'alternate_greetings'] },
        });
        expect(out.name).toBe('Ash');
        expect(out.personality).toBe('Reserved, precise.');
        expect(out.alternate_greetings).toEqual(['A: at dawn.', 'B: at dusk.']);
    });

    test('unset whitelisted field returns null and lands in missing_fields', async () => {
        const out = await tools.dispatchCeaReadCardFields({
            state: { live: { character: makeCard({ scenario: undefined }) } },
            args: { fields: ['scenario', 'system_prompt'] },
        });
        // Empty-string default from makeCard stays empty; explicit
        // `undefined` becomes null + missing.
        expect(out.scenario).toBeNull();
        expect(out.system_prompt).toBe('');
        expect(out.missing_fields).toContain('scenario');
        expect(out.missing_fields).not.toContain('system_prompt');
    });

    test('rejects non-whitelist field (extensions)', async () => {
        await expect(
            tools.dispatchCeaReadCardFields({
                state: { live: { character: makeCard() } },
                args: { fields: ['extensions'] },
            }),
        ).rejects.toThrow(/invalid_args.*extensions/);
    });

    test('rejects extensions subkey attempt (belt-and-suspenders)', async () => {
        // Even if the AI hallucinates a dotted subkey it must be rejected —
        // the enum is FLAT, no `extensions.world` etc. is legal.
        await expect(
            tools.dispatchCeaReadCardFields({
                state: { live: { character: makeCard() } },
                args: { fields: ['extensions.world'] },
            }),
        ).rejects.toThrow(/invalid_args/);
    });

    test('rejects mixed valid+invalid field list', async () => {
        await expect(
            tools.dispatchCeaReadCardFields({
                state: { live: { character: makeCard() } },
                args: { fields: ['name', 'made_up_field'] },
            }),
        ).rejects.toThrow(/invalid_args/);
    });

    test('rejects non-array fields arg', async () => {
        await expect(
            tools.dispatchCeaReadCardFields({
                state: { live: { character: makeCard() } },
                args: { fields: 'name' },
            }),
        ).rejects.toThrow(/invalid_args/);
        await expect(
            tools.dispatchCeaReadCardFields({
                state: { live: { character: makeCard() } },
                args: {},
            }),
        ).rejects.toThrow(/invalid_args/);
    });

    test('rejects non-string entries inside fields[]', async () => {
        await expect(
            tools.dispatchCeaReadCardFields({
                state: { live: { character: makeCard() } },
                args: { fields: ['name', 42] },
            }),
        ).rejects.toThrow(/invalid_args/);
    });

    test('field > 5KB returns truncation envelope with preview and length', async () => {
        const big = 'x'.repeat(6000);
        const out = await tools.dispatchCeaReadCardFields({
            state: { live: { character: makeCard({ description: big }) } },
            args: { fields: ['description'] },
        });
        expect(out.description).toEqual(expect.objectContaining({
            __truncated__: true,
            length: 6000,
        }));
        expect(typeof out.description.preview).toBe('string');
        expect(out.description.preview.length).toBeLessThanOrEqual(200);
    });

    test('missing state.live.character resolves every field to null and populates missing_fields', async () => {
        // Defensive shape — the dispatcher must never crash when the
        // caller forgot to pass a live snapshot. Every requested field
        // resolves to null and lands in missing_fields so the AI knows
        // to give up on those fields (not silently re-issue the same
        // call).
        const out = await tools.dispatchCeaReadCardFields({
            state: {},
            args: { fields: ['name', 'description'] },
        });
        expect(out.name).toBeNull();
        expect(out.description).toBeNull();
        expect(out.missing_fields.sort()).toEqual(['description', 'name']);
    });

    test('never surfaces extensions in the response envelope (defense-in-depth)', async () => {
        // Response construction MUST NOT project `extensions` onto the
        // output even if a whitelisted field pass happens to include the
        // enum in some odd future refactor — the response object's own
        // keys are the fields requested, nothing more.
        const out = await tools.dispatchCeaReadCardFields({
            state: { live: { character: makeCard() } },
            args: { fields: ['name'] },
        });
        expect(Object.keys(out).sort()).toEqual(['missing_fields', 'name']);
        expect('extensions' in out).toBe(false);
    });
});

describe('cea_read_card_fields — tool catalog registration', () => {
    test('appears in buildCeaEditorToolSet as a read tool', () => {
        const toolSet = tools.buildCeaEditorToolSet(null, null, { hasSearchTools: false });
        const readTool = toolSet.find(t => t?.function?.name === 'cea_read_card_fields');
        expect(readTool).toBeDefined();
        expect(readTool.type).toBe('function');
    });

    test('schema declares fields as string[] with enum items', () => {
        const toolSet = tools.buildCeaEditorToolSet(null, null, { hasSearchTools: false });
        const readTool = toolSet.find(t => t?.function?.name === 'cea_read_card_fields');
        const fieldsProp = readTool.function.parameters.properties.fields;
        expect(fieldsProp.type).toBe('array');
        expect(fieldsProp.items.type).toBe('string');
        // Enum must include every writable field so read/write surfaces
        // stay in lockstep.
        expect(fieldsProp.items.enum).toEqual([...tools.CEA_CARD_FIELD_ENUM]);
        expect(readTool.function.parameters.required).toContain('fields');
    });

    test('classified as a read tool by isCeaEditorReadTool', () => {
        expect(tools.isCeaEditorReadTool('cea_read_card_fields')).toBe(true);
    });

    test('extensions and its subkeys are absent from the enum', () => {
        expect(tools.CEA_CARD_FIELD_ENUM).not.toContain('extensions');
        expect(tools.CEA_CARD_FIELD_ENUM).not.toContain('extensions.world');
        expect(tools.CEA_CARD_FIELD_ENUM).not.toContain('extensions.regex_scripts');
    });
});
