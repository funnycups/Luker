// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { jest } from '@jest/globals';

const mockStrip = jest.fn(x => (x && typeof x === 'object') ? { ...x, __stripped: true } : x);
const mockGetContext = jest.fn();

jest.unstable_mockModule('/scripts/openai.js', () => ({
    stripOpenAIConnectionFieldsFromPreset: mockStrip,
}));
jest.unstable_mockModule('/scripts/st-context.js', () => ({
    getContext: mockGetContext,
}));

const {
    listCharacterBoundPresets, getCharacterBoundPreset,
    addCharacterBoundPreset, updateCharacterBoundPreset,
    removeCharacterBoundPreset, setCharacterBoundDefault,
    resolveCharacterBoundPresetByName, readCharacterBoundState,
    clearAllCharacterBoundPresets,
} = await import('/scripts/character/presets.js');

const mockCharacter = (avatar = 'Aqua.png') => ({ avatar, data: { extensions: {} } });

let ctx;
beforeEach(() => {
    const chars = [mockCharacter()];
    ctx = {
        characters: chars,
        writeExtensionField: jest.fn(async (id, ns, value) => {
            // Replace semantics — matches production writeExtensionField (see
            // public/scripts/extensions.js:2104-2114). The whole `data.extensions[ns]`
            // is overwritten; callers must pre-spread siblings.
            const c = chars[id];
            c.data.extensions[ns] = value;
        }),
        getPresetManager: () => ({
            getCompletionPresetByName: (name) => name === 'GlobalOnly' ? { temperature: 0.9 } : null,
        }),
    };
    mockGetContext.mockReturnValue(ctx);
    mockStrip.mockClear();
});

test('empty state', () => {
    const c = ctx.characters[0];
    expect(listCharacterBoundPresets(c)).toEqual([]);
    expect(getCharacterBoundPreset(c, 'X')).toBeNull();
    expect(readCharacterBoundState(c)).toEqual({ presets: [], defaultPresetName: null });
});

test('add first preset becomes default', async () => {
    const c = ctx.characters[0];
    await addCharacterBoundPreset(c, 'Foo', { temperature: 0.5 });
    expect(mockStrip).toHaveBeenCalledWith({ temperature: 0.5 });
    const list = listCharacterBoundPresets(c);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Foo');
    expect(list[0].isDefault).toBe(true);
});

test('add second preset does not touch default', async () => {
    const c = ctx.characters[0];
    await addCharacterBoundPreset(c, 'Foo', { temperature: 0.5 });
    await addCharacterBoundPreset(c, 'Bar', { temperature: 0.7 });
    const list = listCharacterBoundPresets(c);
    expect(list.find(p => p.name === 'Foo').isDefault).toBe(true);
    expect(list.find(p => p.name === 'Bar').isDefault).toBe(false);
});

test('add throws on duplicate name', async () => {
    const c = ctx.characters[0];
    await addCharacterBoundPreset(c, 'Foo', {});
    await expect(addCharacterBoundPreset(c, 'Foo', {})).rejects.toThrow(/already exists/);
});

test('add throws on empty name', async () => {
    const c = ctx.characters[0];
    await expect(addCharacterBoundPreset(c, '', {})).rejects.toThrow(/name required/);
    await expect(addCharacterBoundPreset(c, '   ', {})).rejects.toThrow(/name required/);
});

test('update throws when name not found', async () => {
    const c = ctx.characters[0];
    await expect(updateCharacterBoundPreset(c, 'NoSuch', {})).rejects.toThrow(/not found/);
});

test('update replaces body and strips', async () => {
    const c = ctx.characters[0];
    await addCharacterBoundPreset(c, 'Foo', { temperature: 0.5 });
    await updateCharacterBoundPreset(c, 'Foo', { temperature: 0.8, custom_url: 'evil' });
    const got = getCharacterBoundPreset(c, 'Foo');
    // strip runs both on write and on read (defense in depth)
    expect(got.preset.__stripped).toBe(true);
});

test('remove throws when name not found', async () => {
    const c = ctx.characters[0];
    await expect(removeCharacterBoundPreset(c, 'NoSuch')).rejects.toThrow(/not found/);
});

test('remove default clears defaultPresetName', async () => {
    const c = ctx.characters[0];
    await addCharacterBoundPreset(c, 'Foo', {});
    await addCharacterBoundPreset(c, 'Bar', {});
    await removeCharacterBoundPreset(c, 'Foo');
    const state = readCharacterBoundState(c);
    expect(state.defaultPresetName).toBeNull();
    expect(state.presets.map(p => p.name)).toEqual(['Bar']);
});

test('remove last preset writes null (clears field entirely)', async () => {
    const c = ctx.characters[0];
    await addCharacterBoundPreset(c, 'Foo', {});
    await removeCharacterBoundPreset(c, 'Foo');
    const last = ctx.writeExtensionField.mock.calls.at(-1);
    expect(last[2].chat_completion_preset).toBeNull();
});

test('setDefault(name) name must be in presets[]', async () => {
    const c = ctx.characters[0];
    await addCharacterBoundPreset(c, 'Foo', {});
    await expect(setCharacterBoundDefault(c, 'NoSuch')).rejects.toThrow(/must be in presets/);
});

test('setDefault(null) clears default without removing presets', async () => {
    const c = ctx.characters[0];
    await addCharacterBoundPreset(c, 'Foo', {});
    await setCharacterBoundDefault(c, null);
    const state = readCharacterBoundState(c);
    expect(state.defaultPresetName).toBeNull();
    expect(state.presets.map(p => p.name)).toEqual(['Foo']);
});

test('resolveByName: card > global > null', () => {
    const c = ctx.characters[0];
    return addCharacterBoundPreset(c, 'Foo', { temperature: 0.5 }).then(() => {
        expect(resolveCharacterBoundPresetByName(c, 'Foo').origin).toBe('card');
        expect(resolveCharacterBoundPresetByName(c, 'GlobalOnly').origin).toBe('global');
        expect(resolveCharacterBoundPresetByName(c, 'NoSuch')).toBeNull();
    });
});

test('sibling luker.* fields survive add/update/remove/setDefault writes', async () => {
    const c = ctx.characters[0];
    c.data.extensions.luker = { embedded_skills_source: 'sentinel-value' };

    await addCharacterBoundPreset(c, 'Foo', { temperature: 0.5 });
    expect(c.data.extensions.luker.embedded_skills_source).toBe('sentinel-value');

    await addCharacterBoundPreset(c, 'Bar', { temperature: 0.7 });
    expect(c.data.extensions.luker.embedded_skills_source).toBe('sentinel-value');

    await updateCharacterBoundPreset(c, 'Foo', { temperature: 0.8 });
    expect(c.data.extensions.luker.embedded_skills_source).toBe('sentinel-value');

    await setCharacterBoundDefault(c, 'Bar');
    expect(c.data.extensions.luker.embedded_skills_source).toBe('sentinel-value');

    await removeCharacterBoundPreset(c, 'Foo');
    expect(c.data.extensions.luker.embedded_skills_source).toBe('sentinel-value');

    // Even the final "clear entirely" write path (last preset removed) must preserve siblings.
    await removeCharacterBoundPreset(c, 'Bar');
    expect(c.data.extensions.luker.embedded_skills_source).toBe('sentinel-value');
    expect(c.data.extensions.luker.chat_completion_preset).toBeNull();
});

test('migration: legacy single-binding {name, preset}', async () => {
    const c = mockCharacter();
    c.data.extensions.luker = { chat_completion_preset: { name: 'Legacy', preset: { temperature: 0.6 } } };
    // Register c in the mock ctx so the migration-flush microtask can find
    // it via `context.characters.indexOf` — readCharacterBoundState now
    // schedules a flush on legacy detection (mirrors listCharacterBoundPresets
    // / getCharacterBoundPreset) so the raw entry point also migrates
    // read-only cards. Without this, the flush's `persistCharacterBoundState`
    // throws `character not found in context.characters`, which surfaces as
    // an unhandled microtask rejection.
    ctx.characters = [c];
    const state = readCharacterBoundState(c);
    expect(state.presets).toHaveLength(1);
    expect(state.presets[0].name).toBe('Legacy');
    expect(state.presets[0].preset.__stripped).toBe(true);
    expect(state.defaultPresetName).toBe('Legacy');
    expect(state._migrated).toBe(true);
    // Drain the scheduled flush microtask so it does not leak into the next test.
    await Promise.resolve();
    await Promise.resolve();
});

test('migration: legacy bare string form', async () => {
    const c = mockCharacter();
    c.data.extensions.luker = { chat_completion_preset: 'BareName' };
    ctx.characters = [c];
    const state = readCharacterBoundState(c);
    expect(state.presets).toEqual([]);
    expect(state.defaultPresetName).toBe('BareName');
    expect(state._migrated).toBe(true);
    // Drain the scheduled flush microtask.
    await Promise.resolve();
    await Promise.resolve();
});

test('migration flush is coalesced per microtask', async () => {
    ctx.characters = [mockCharacter('X.png')];
    ctx.characters[0].data.extensions.luker = { chat_completion_preset: { name: 'L', preset: { t: 1 } } };
    mockGetContext.mockReturnValue(ctx);
    listCharacterBoundPresets(ctx.characters[0]);
    listCharacterBoundPresets(ctx.characters[0]);
    listCharacterBoundPresets(ctx.characters[0]);
    // Wait for the microtask queue to drain.
    await Promise.resolve();
    await Promise.resolve();
    const writes = ctx.writeExtensionField.mock.calls;
    expect(writes.length).toBe(1);      // coalesced
    expect(writes[0][2].chat_completion_preset).toEqual({
        presets: [{ name: 'L', preset: expect.any(Object) }],
        defaultPresetName: 'L',
    });
});

test('readCharacterBoundState on a legacy read-only card triggers persisted new-shape', async () => {
    // Regression: readCharacterBoundState is consumed by openai.js /
    // maybeApplyCharacterBoundPreset without a subsequent bind/save. If
    // this read did not schedule the migration flush, a legacy-shape card
    // that is only ever read (never written through the higher-level
    // add/update/remove/setDefault APIs) would never migrate. Verify a
    // single raw read schedules a write, and the persisted shape is the
    // new BoundState form.
    ctx.characters = [mockCharacter('ReadOnly.png')];
    ctx.characters[0].data.extensions.luker = { chat_completion_preset: { name: 'RO', preset: { t: 2 } } };
    mockGetContext.mockReturnValue(ctx);
    // Single raw read — no follow-on list/get/add/update/remove.
    const state = readCharacterBoundState(ctx.characters[0]);
    expect(state._migrated).toBe(true);
    // Drain scheduled microtask.
    await Promise.resolve();
    await Promise.resolve();
    const writes = ctx.writeExtensionField.mock.calls;
    expect(writes.length).toBe(1);
    expect(writes[0][2].chat_completion_preset).toEqual({
        presets: [{ name: 'RO', preset: expect.any(Object) }],
        defaultPresetName: 'RO',
    });
});

test('clearAll on empty state writes null', async () => {
    const c = ctx.characters[0];
    await clearAllCharacterBoundPresets(c);
    const last = ctx.writeExtensionField.mock.calls.at(-1);
    expect(last[2].chat_completion_preset).toBeNull();
});

test('clearAll preserves sibling luker.* fields', async () => {
    const c = ctx.characters[0];
    c.data.extensions.luker = { embedded_skills_source: 'sentinel-value' };
    await addCharacterBoundPreset(c, 'Foo', { temperature: 0.5 });
    expect(c.data.extensions.luker.embedded_skills_source).toBe('sentinel-value');
    await clearAllCharacterBoundPresets(c);
    const last = ctx.writeExtensionField.mock.calls.at(-1);
    expect(last[2].chat_completion_preset).toBeNull();
    expect(c.data.extensions.luker.embedded_skills_source).toBe('sentinel-value');
});

test('clearAll from populated state (2 presets + default) empties everything', async () => {
    const c = ctx.characters[0];
    await addCharacterBoundPreset(c, 'Foo', { temperature: 0.5 });
    await addCharacterBoundPreset(c, 'Bar', { temperature: 0.7 });
    await setCharacterBoundDefault(c, 'Bar');
    await clearAllCharacterBoundPresets(c);
    expect(readCharacterBoundState(c)).toEqual({ presets: [], defaultPresetName: null });
});
