// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { jest } from '@jest/globals';

const mockStrip = jest.fn(x => x);
const mockGetContext = jest.fn();
const mockWriteExtensionField = jest.fn(async () => {});

jest.unstable_mockModule('/scripts/openai.js', () => ({
    stripOpenAIConnectionFieldsFromPreset: mockStrip,
}));
jest.unstable_mockModule('/scripts/st-context.js', () => ({
    getContext: mockGetContext,
}));

const { renameCharacterBoundPreset, readCharacterBoundState } = await import(
    '/scripts/character/presets.js'
);

function makeCharacter(presets, defaultPresetName = null) {
    return {
        avatar: 'aria.png',
        name: 'Aria',
        data: {
            extensions: {
                luker: {
                    chat_completion_preset: { presets: presets.slice(), defaultPresetName },
                },
            },
        },
    };
}

beforeEach(() => {
    mockGetContext.mockReset();
    mockWriteExtensionField.mockReset();
    mockWriteExtensionField.mockImplementation(async (id, ns, value) => {
        // Replicate real writeExtensionField replace semantics so
        // readCharacterBoundState post-write reflects the new value.
        const ctx = mockGetContext();
        const c = ctx.characters[id];
        c.data.extensions[ns] = value;
    });
    mockStrip.mockClear();
});

test('case 1 — normal rename: X → Y, card slot 名改成 Y, body 保留原对象引用', async () => {
    const body = { temperature: 0.5, chat_completion_source: 'openai' };
    const character = makeCharacter([{ name: 'X', preset: body }], 'X');
    mockGetContext.mockReturnValue({
        characters: [character],
        writeExtensionField: mockWriteExtensionField,
    });

    await renameCharacterBoundPreset(character, 'X', 'Y');

    const state = readCharacterBoundState(character);
    expect(state.presets).toHaveLength(1);
    expect(state.presets[0].name).toBe('Y');
    expect(state.presets[0].preset).toEqual(body);
    // default 联动
    expect(state.defaultPresetName).toBe('Y');
    // 只 write 一次(原子)
    expect(mockWriteExtensionField).toHaveBeenCalledTimes(1);
});

test('case 2 — no-op: trim 后 oldName === newName → 不调 persist', async () => {
    const character = makeCharacter([{ name: 'X', preset: {} }], 'X');
    mockGetContext.mockReturnValue({
        characters: [character],
        writeExtensionField: mockWriteExtensionField,
    });

    await renameCharacterBoundPreset(character, '  X  ', 'X');

    expect(mockWriteExtensionField).not.toHaveBeenCalled();
});

test('case 3 — oldName not found → throw, 不调 persist', async () => {
    const character = makeCharacter([{ name: 'X', preset: {} }], 'X');
    mockGetContext.mockReturnValue({
        characters: [character],
        writeExtensionField: mockWriteExtensionField,
    });

    await expect(renameCharacterBoundPreset(character, 'Nope', 'Y')).rejects.toThrow(/not found/i);
    expect(mockWriteExtensionField).not.toHaveBeenCalled();
});

test('case 4 — newName 已在同一 card → throw, 不调 persist', async () => {
    const character = makeCharacter([
        { name: 'X', preset: { temperature: 0.5 } },
        { name: 'Y', preset: { temperature: 0.9 } },
    ], 'X');
    mockGetContext.mockReturnValue({
        characters: [character],
        writeExtensionField: mockWriteExtensionField,
    });

    await expect(renameCharacterBoundPreset(character, 'X', 'Y')).rejects.toThrow(/already exists/i);
    expect(mockWriteExtensionField).not.toHaveBeenCalled();
});

test('case 5 — rename 掉的不是 default slot: defaultPresetName 不动', async () => {
    const character = makeCharacter([
        { name: 'X', preset: { temperature: 0.5 } },
        { name: 'Y', preset: { temperature: 0.9 } },
    ], 'Y');
    mockGetContext.mockReturnValue({
        characters: [character],
        writeExtensionField: mockWriteExtensionField,
    });

    await renameCharacterBoundPreset(character, 'X', 'Z');

    const state = readCharacterBoundState(character);
    expect(state.presets.map(p => p.name)).toEqual(['Z', 'Y']);
    expect(state.defaultPresetName).toBe('Y');
    expect(mockWriteExtensionField).toHaveBeenCalledTimes(1);
});

test('bonus — 空 name 参数 → throw', async () => {
    const character = makeCharacter([{ name: 'X', preset: {} }], 'X');
    mockGetContext.mockReturnValue({
        characters: [character],
        writeExtensionField: mockWriteExtensionField,
    });

    await expect(renameCharacterBoundPreset(character, '', 'Y')).rejects.toThrow(/required/i);
    await expect(renameCharacterBoundPreset(character, 'X', '   ')).rejects.toThrow(/required/i);
    expect(mockWriteExtensionField).not.toHaveBeenCalled();
});
