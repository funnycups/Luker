// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// origin-aware hasUnsavedOpenAIPresetChanges — exercises the pure helper
// extracted from openai.js so we can assert card-branch vs global-branch
// dispatch without importing the 10k-line openai.js module (whose transitive
// graph pulls jQuery, script.js, and 40+ other modules — see
// tests/character-presets/main-chat-selector.test.js:5-13 for the same
// finding).
//
// Contract asserted here (matches decideSavePresetDispatch in
// public/scripts/character/save-dispatch.js:62-73 — save intent and
// unsaved-change detection stay in lock-step):
//   1. When the resolved ref points at a character origin AND the requested
//      name matches ref.name, compare the live body with the card slot body
//      (fetched via getCharacterBoundPreset).
//   2. Everything else — global origin, name mismatch under a card ref,
//      missing character, missing slot — falls through to the global
//      short-circuit that reads openai_settings[openai_setting_names[name]].
//   3. Explicit `options.selectValue` overrides the DOM read; equivalence
//      with the DOM fallback is required.
//
// Wired-up flow through the real openai.js UI lives in
// tests/e2e/preset/58-hasUnsavedChanges-collision.e2e.js and
// tests/e2e/preset/59-hasUnsavedChanges-name-mismatch.e2e.js.

import { jest } from '@jest/globals';

const mockGetCharacterBoundPreset = jest.fn();
const mockGetChatCompletionPreset = jest.fn();
const mockAreComparableOpenAIPresetBodiesEqual = jest.fn();
const mockGetContext = jest.fn();

// `presets.js` transitively imports openai.js (for stripOpenAIConnectionFieldsFromPreset),
// so we hard-mock it to keep the unit test hermetic. `readSelectedPresetRef` is
// intentionally NOT mocked — it must run for real so the ghost-value decoding
// path is exercised end-to-end, forcing the decoded avatar+name (not a
// hand-rolled shortcut) to drive dispatch.
jest.unstable_mockModule('/scripts/character/presets.js', () => ({
    getCharacterBoundPreset: mockGetCharacterBoundPreset,
}));
jest.unstable_mockModule('/scripts/st-context.js', () => ({
    getContext: mockGetContext,
}));

const { hasUnsavedOpenAIPresetChanges } = await import(
    '/scripts/character/has-unsaved-openai-preset-changes.js'
);
const { encodeCardBoundOptionValue } = await import(
    '/scripts/character/preset-ref-codec.js'
);

// Factory for the openai.js-side deps that hasUnsavedOpenAIPresetChangesImpl
// receives. Kept explicit so each test can drive a specific state without
// pulling openai.js.
function makeDeps(overrides = {}) {
    return {
        openaiSettingNames: overrides.openaiSettingNames ?? { GlobalPreset: 3, MyPreset: 4 },
        openaiSettings: overrides.openaiSettings ?? [
            null, null, null,
            { temperature: 0.5 },     // index 3 → GlobalPreset
            { temperature: 0.5 },     // index 4 → MyPreset
        ],
        oaiSettings: overrides.oaiSettings ?? { temperature: 0.5 },
        getChatCompletionPreset: mockGetChatCompletionPreset,
        areComparableOpenAIPresetBodiesEqual: mockAreComparableOpenAIPresetBodiesEqual,
    };
}

beforeEach(() => {
    mockGetCharacterBoundPreset.mockReset();
    mockGetChatCompletionPreset.mockReset();
    mockAreComparableOpenAIPresetBodiesEqual.mockReset();
    mockGetContext.mockReset();
});

test('case 1 — card-hit-equal → false', () => {
    const character = { avatar: 'Aria.png' };
    mockGetContext.mockReturnValue({ characters: [character] });
    mockGetCharacterBoundPreset.mockReturnValue({ name: 'MyPreset', preset: { temperature: 0.5 } });
    mockGetChatCompletionPreset.mockReturnValue({ temperature: 0.5 });
    mockAreComparableOpenAIPresetBodiesEqual.mockReturnValue(true);
    const deps = makeDeps();

    const ghostValue = encodeCardBoundOptionValue('Aria.png', 'MyPreset');
    const result = hasUnsavedOpenAIPresetChanges('MyPreset', { selectValue: ghostValue }, deps);
    expect(result).toBe(false);
    expect(mockGetCharacterBoundPreset).toHaveBeenCalledWith(character, 'MyPreset');
});

test('case 2 — card-hit-diff → true', () => {
    const character = { avatar: 'Aria.png' };
    mockGetContext.mockReturnValue({ characters: [character] });
    mockGetCharacterBoundPreset.mockReturnValue({ name: 'MyPreset', preset: { temperature: 0.5 } });
    mockGetChatCompletionPreset.mockReturnValue({ temperature: 0.9 });
    mockAreComparableOpenAIPresetBodiesEqual.mockReturnValue(false);
    const deps = makeDeps();

    const ghostValue = encodeCardBoundOptionValue('Aria.png', 'MyPreset');
    const result = hasUnsavedOpenAIPresetChanges('MyPreset', { selectValue: ghostValue }, deps);
    expect(result).toBe(true);
});

test('case 3 — no-options + no DOM → readSelectedPresetRef falls back to fallbackName as a global ref', () => {
    // The jest node testEnvironment does not define `document`. So when
    // options is undefined AND typeof document === 'undefined', the helper
    // must treat the ref as global with name = normalizedName and hit the
    // global-library short-circuit.
    mockGetContext.mockReturnValue({ characters: [] });
    mockGetChatCompletionPreset.mockReturnValue({ temperature: 0.5 });
    mockAreComparableOpenAIPresetBodiesEqual.mockReturnValue(true);
    const deps = makeDeps();

    expect(typeof document).toBe('undefined');
    const result = hasUnsavedOpenAIPresetChanges('GlobalPreset', undefined, deps);
    // Global branch, body equal → false.
    expect(result).toBe(false);
    expect(mockGetCharacterBoundPreset).not.toHaveBeenCalled();
});

test('case 4 — character-missing → false', () => {
    // Decoded avatar not present in getContext().characters → dispatch must
    // bail out with `false` and MUST NOT call getCharacterBoundPreset.
    mockGetContext.mockReturnValue({ characters: [] });
    const deps = makeDeps();

    const ghostValue = encodeCardBoundOptionValue('Missing.png', 'MyPreset');
    const result = hasUnsavedOpenAIPresetChanges('MyPreset', { selectValue: ghostValue }, deps);
    expect(result).toBe(false);
    expect(mockGetCharacterBoundPreset).not.toHaveBeenCalled();
});

test('case 5 — slot-missing → false', () => {
    const character = { avatar: 'Aria.png' };
    mockGetContext.mockReturnValue({ characters: [character] });
    mockGetCharacterBoundPreset.mockReturnValue(null);
    const deps = makeDeps();

    const ghostValue = encodeCardBoundOptionValue('Aria.png', 'MyPreset');
    const result = hasUnsavedOpenAIPresetChanges('MyPreset', { selectValue: ghostValue }, deps);
    expect(result).toBe(false);
});

test('case 6 — explicit selectValue and DOM fallback produce equal results', () => {
    // Same ghost value delivered via two channels; both paths must land on
    // the same branch and same result.
    const character = { avatar: 'Aria.png' };
    mockGetContext.mockReturnValue({ characters: [character] });
    mockGetCharacterBoundPreset.mockReturnValue({ name: 'MyPreset', preset: { temperature: 0.5 } });
    mockGetChatCompletionPreset.mockReturnValue({ temperature: 0.5 });
    mockAreComparableOpenAIPresetBodiesEqual.mockReturnValue(true);

    const ghostValue = encodeCardBoundOptionValue('Aria.png', 'MyPreset');
    const deps = makeDeps();

    // Path A: explicit options.selectValue.
    const resultExplicit = hasUnsavedOpenAIPresetChanges('MyPreset', { selectValue: ghostValue }, deps);

    // Path B: DOM fallback. Install a minimal document.getElementById stub
    // so the helper's `typeof document !== 'undefined'` branch is taken.
    const priorDocument = globalThis.document;
    globalThis.document = {
        getElementById: (id) => id === 'settings_preset_openai' ? { value: ghostValue } : null,
    };
    try {
        const resultDom = hasUnsavedOpenAIPresetChanges('MyPreset', undefined, deps);
        expect(resultDom).toBe(resultExplicit);
    } finally {
        if (priorDocument === undefined) delete globalThis.document;
        else globalThis.document = priorDocument;
    }
});

test('case 7 (bonus) — name mismatch under card-bound selection → global-branch dispatch', () => {
    // ghost selection points at name = X while the caller asks about a
    // different name — save-dispatch.js:70-72 defines this as "user typing a
    // new global-preset name while a card slot is active"; hasUnsavedChanges
    // must mirror that decision and consult the global library.
    const character = { avatar: 'Aria.png' };
    mockGetContext.mockReturnValue({ characters: [character] });
    mockGetChatCompletionPreset.mockReturnValue({ temperature: 0.5 });
    mockAreComparableOpenAIPresetBodiesEqual.mockReturnValue(true);
    const deps = makeDeps();

    const ghostValue = encodeCardBoundOptionValue('Aria.png', 'X');
    const result = hasUnsavedOpenAIPresetChanges('GlobalPreset', { selectValue: ghostValue }, deps);
    // Global GlobalPreset exists, body equal → false; character branch must
    // have been short-circuited without touching the card slot.
    expect(result).toBe(false);
    expect(mockGetCharacterBoundPreset).not.toHaveBeenCalled();
});
