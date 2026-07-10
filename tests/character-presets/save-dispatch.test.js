// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// save-dispatch: pure origin-dispatch decision extracted from openai.js's
// saveOpenAIPreset. Tests the helper directly rather than trying to import
// the 10k-line openai.js module (whose transitive graph pulls jQuery,
// script.js, and 40+ other modules that aren't safe to import under jest —
// see main-chat-selector.test.js:5-13 for the same finding).
//
// The e2e spec tests/e2e/preset/41-prompt-manager-card-bound-edit.e2e.js
// exercises the wired-up path through the real openai.js UI.
//
// Contract asserted here:
//   1. readSelectedPresetRef({selectValue, fallbackName}) decodes a
//      __luker_card__:: value to {name, origin:{kind:'character',avatar}}
//      and otherwise returns {name, origin:{kind:'global'}}.
//   2. decideSavePresetDispatch(currentRef, requestedName) returns
//      {mode:'character', avatar} only when the DOM ref is character AND
//      the name matches; otherwise {mode:'global'}.

import { jest } from '@jest/globals';

const {
    readSelectedPresetRef,
    decideSavePresetDispatch,
} = await import('/scripts/character/save-dispatch.js');

const { encodeCardBoundOptionValue } = await import('/scripts/character/preset-ref-codec.js');

// ---------- readSelectedPresetRef ----------

test('readSelectedPresetRef: card-bound value decodes to {kind:character, avatar, name}', () => {
    const raw = encodeCardBoundOptionValue('Aqua.png', 'CardBound');
    const ref = readSelectedPresetRef({ selectValue: raw, fallbackName: 'IgnoreMe' });
    expect(ref).toEqual({ name: 'CardBound', origin: { kind: 'character', avatar: 'Aqua.png' } });
});

test('readSelectedPresetRef: plain global name → {kind:global}', () => {
    const ref = readSelectedPresetRef({ selectValue: 'GlobalName', fallbackName: 'Fallback' });
    expect(ref).toEqual({ name: 'Fallback', origin: { kind: 'global' } });
});

test('readSelectedPresetRef: empty selectValue falls back to fallbackName', () => {
    const ref = readSelectedPresetRef({ selectValue: '', fallbackName: 'Fallback' });
    expect(ref).toEqual({ name: 'Fallback', origin: { kind: 'global' } });
});

test('readSelectedPresetRef: nullish inputs handled', () => {
    const ref = readSelectedPresetRef({ selectValue: null, fallbackName: null });
    expect(ref).toEqual({ name: '', origin: { kind: 'global' } });
});

test('readSelectedPresetRef: card-bound with special-char avatar+name round-trips', () => {
    const raw = encodeCardBoundOptionValue('a b/c::d.png', 'p:re:set!');
    const ref = readSelectedPresetRef({ selectValue: raw, fallbackName: '' });
    expect(ref.origin).toEqual({ kind: 'character', avatar: 'a b/c::d.png' });
    expect(ref.name).toBe('p:re:set!');
});

test('readSelectedPresetRef: malformed card-bound value falls through to global', () => {
    // Prefix present but tail lacks the `::` separator → decode returns
    // null; helper must not throw and must treat as global with name=raw.
    const raw = '__luker_card__::not-encoded-properly';
    const ref = readSelectedPresetRef({ selectValue: raw, fallbackName: 'FB' });
    expect(ref.origin).toEqual({ kind: 'global' });
    // The malformed sentinel is not a usable global name, so we prefer the
    // fallback (oai_settings.preset_settings_openai) rather than surfacing
    // the raw sentinel string as a global preset name.
    expect(ref.name).toBe('FB');
});

// ---------- decideSavePresetDispatch ----------

test('decideSavePresetDispatch: card ref + matching name → character dispatch', () => {
    const currentRef = { name: 'MyPreset', origin: { kind: 'character', avatar: 'Aqua.png' } };
    const decision = decideSavePresetDispatch(currentRef, 'MyPreset');
    expect(decision).toEqual({ mode: 'character', avatar: 'Aqua.png', name: 'MyPreset' });
});

test('decideSavePresetDispatch: card ref + different name → global dispatch (create new global)', () => {
    // User has CardBound selected but typed a new name in the "New Preset"
    // dialog — intent is to create a new GLOBAL preset, not overwrite the
    // card slot.
    const currentRef = { name: 'CardBound', origin: { kind: 'character', avatar: 'Aqua.png' } };
    const decision = decideSavePresetDispatch(currentRef, 'BrandNewGlobal');
    expect(decision).toEqual({ mode: 'global' });
});

test('decideSavePresetDispatch: global ref + any name → global dispatch', () => {
    const currentRef = { name: 'GlobalX', origin: { kind: 'global' } };
    expect(decideSavePresetDispatch(currentRef, 'GlobalX')).toEqual({ mode: 'global' });
    expect(decideSavePresetDispatch(currentRef, 'OtherName')).toEqual({ mode: 'global' });
});

test('decideSavePresetDispatch: nullish currentRef → global', () => {
    expect(decideSavePresetDispatch(null, 'X')).toEqual({ mode: 'global' });
    expect(decideSavePresetDispatch(undefined, 'X')).toEqual({ mode: 'global' });
});

test('decideSavePresetDispatch: card ref with empty avatar → global (defensive)', () => {
    const currentRef = { name: 'MyPreset', origin: { kind: 'character', avatar: '' } };
    expect(decideSavePresetDispatch(currentRef, 'MyPreset')).toEqual({ mode: 'global' });
});
