// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Shared iter-studio read tool `inspect_bound_preset`. Consumers
// (orchestrator iter-studio + CEA editor) let the AI list / fetch presets
// embedded on the active character card while iterating its artifact.
//
// The executor threads `context.character.presets.list` / `.get` (the
// ctx surface — Layer 1 in disguise). Layer 1 already strips
// OpenAI-connection fields on read, so the tool returns raw preset objects
// without a second strip step.

import { jest } from '@jest/globals';

const character = {
    avatar: 'X.png',
    data: { extensions: {} },
};

const presetsBody = {
    A: { temperature: 0.4, char_name: 'X' },
    B: { temperature: 0.9 },
};

const ctx = {
    characters: [character],
    characterId: 0,
    character: {
        presets: {
            list: jest.fn(_c => [
                { name: 'A', preset: presetsBody.A, isDefault: true },
                { name: 'B', preset: presetsBody.B, isDefault: false },
            ]),
            get: jest.fn((_c, name) => (presetsBody[name] ? { name, preset: presetsBody[name] } : null)),
        },
    },
};

const {
    CHARACTER_PRESET_READ_TOOL_NAMES,
    isCharacterPresetReadTool,
    CHARACTER_PRESET_READ_TOOL_DEFS,
    runCharacterPresetReadTool,
} = await import('/scripts/iteration-library/tools/character-presets-reads.js');

const { STATE_ERROR_REASONS } = await import('/scripts/state-errors.js');

beforeEach(() => {
    ctx.character.presets.list.mockClear();
    ctx.character.presets.get.mockClear();
});

test('exports tool name registry with inspect_bound_preset', () => {
    expect(CHARACTER_PRESET_READ_TOOL_NAMES).toContain('inspect_bound_preset');
    expect(isCharacterPresetReadTool('inspect_bound_preset')).toBe(true);
    expect(isCharacterPresetReadTool('foo')).toBe(false);
    expect(isCharacterPresetReadTool('')).toBe(false);
    expect(isCharacterPresetReadTool(null)).toBe(false);
});

test('exports OpenAI-style tool defs describing action/name arguments', () => {
    expect(Array.isArray(CHARACTER_PRESET_READ_TOOL_DEFS)).toBe(true);
    const def = CHARACTER_PRESET_READ_TOOL_DEFS.find(d => d.function?.name === 'inspect_bound_preset');
    expect(def).toBeDefined();
    expect(def.type).toBe('function');
    const params = def.function.parameters;
    expect(params.properties.action).toBeDefined();
    expect(params.properties.action.enum).toEqual(expect.arrayContaining(['list', 'get']));
    expect(params.properties.name).toBeDefined();
    expect(params.required).toEqual(['action']);
});

test('action=list returns names with isDefault + hasBody flags', async () => {
    const res = await runCharacterPresetReadTool(
        { id: 'c1', name: 'inspect_bound_preset', args: { action: 'list' } },
        { context: ctx, avatar: 'X.png' },
    );
    expect(res).toEqual({
        ok: true,
        result: [
            { name: 'A', isDefault: true, hasBody: true },
            { name: 'B', isDefault: false, hasBody: true },
        ],
    });
    // Layer 1's list is fed the raw character record resolved via avatar.
    expect(ctx.character.presets.list).toHaveBeenCalledWith(character);
});

test('action=get returns { name, preset } for a known preset', async () => {
    const res = await runCharacterPresetReadTool(
        { name: 'inspect_bound_preset', args: { action: 'get', name: 'A' } },
        { context: ctx, avatar: 'X.png' },
    );
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ name: 'A', preset: presetsBody.A });
    expect(ctx.character.presets.get).toHaveBeenCalledWith(character, 'A');
});

test('action=get for an unknown name returns null result (not an error)', async () => {
    const res = await runCharacterPresetReadTool(
        { name: 'inspect_bound_preset', args: { action: 'get', name: 'Missing' } },
        { context: ctx, avatar: 'X.png' },
    );
    expect(res).toEqual({ ok: true, result: null });
});

test('action=get without a name argument returns an error result', async () => {
    const res = await runCharacterPresetReadTool(
        { name: 'inspect_bound_preset', args: { action: 'get' } },
        { context: ctx, avatar: 'X.png' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(STATE_ERROR_REASONS.VALIDATION_ARGS);
    expect(typeof res.hint).toBe('string');
    expect(res.hint.length).toBeGreaterThan(0);
});

test('missing action returns an error result', async () => {
    const res = await runCharacterPresetReadTool(
        { name: 'inspect_bound_preset', args: {} },
        { context: ctx, avatar: 'X.png' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(STATE_ERROR_REASONS.VALIDATION_ARGS);
});

test('unknown action returns an error result', async () => {
    const res = await runCharacterPresetReadTool(
        { name: 'inspect_bound_preset', args: { action: 'wtf' } },
        { context: ctx, avatar: 'X.png' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(STATE_ERROR_REASONS.VALIDATION_ARGS);
});

test('avatar with no matching character returns a target-missing error', async () => {
    const res = await runCharacterPresetReadTool(
        { name: 'inspect_bound_preset', args: { action: 'list' } },
        { context: ctx, avatar: 'Missing.png' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(STATE_ERROR_REASONS.VALIDATION_TARGET);
});

test('avatar omitted falls back to context.characterId', async () => {
    const res = await runCharacterPresetReadTool(
        { name: 'inspect_bound_preset', args: { action: 'list' } },
        { context: ctx },
    );
    expect(res.ok).toBe(true);
    expect(ctx.character.presets.list).toHaveBeenCalledWith(character);
});

test('rejects when called with a non-preset tool name', async () => {
    const res = await runCharacterPresetReadTool(
        { name: 'not_a_preset_tool', args: { action: 'list' } },
        { context: ctx, avatar: 'X.png' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(STATE_ERROR_REASONS.VALIDATION_ARGS);
});

test('reports missing context as an error', async () => {
    const res = await runCharacterPresetReadTool(
        { name: 'inspect_bound_preset', args: { action: 'list' } },
        { avatar: 'X.png' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(STATE_ERROR_REASONS.VALIDATION_ARGS);
});

test('reports missing ctx.character.presets surface as an error', async () => {
    const brokenCtx = { characters: [character], characterId: 0 };
    const res = await runCharacterPresetReadTool(
        { name: 'inspect_bound_preset', args: { action: 'list' } },
        { context: brokenCtx, avatar: 'X.png' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(STATE_ERROR_REASONS.VALIDATION_ARGS);
});
