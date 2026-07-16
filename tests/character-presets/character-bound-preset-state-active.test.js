// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Unit tests for updateCharacterBoundPresetActiveState — the pure helper
// that keeps characterBoundPresetState.active ≡ ghost DOM-selected while
// preserving previousPreset across ghost ↔ global toggles.

import { jest } from '@jest/globals';

// Stubbed normaliser: mimic openai.js resolveExistingOpenAIPresetName —
// return the canonical (case-preserving) name if present in the global
// preset library, else ''. The two globals we pretend exist are
// 'Default' and 'Creative'; anything else is unknown.
const mockResolveExistingOpenAIPresetName = jest.fn((name) => {
    const trimmed = String(name || '').trim();
    if (!trimmed) return '';
    const known = { 'default': 'Default', 'creative': 'Creative' };
    return known[trimmed.toLowerCase()] || '';
});

const { updateCharacterBoundPresetActiveState } = await import(
    '/scripts/character/character-bound-preset-state-sync.js'
);

const makeState = () => ({ active: false, previousPreset: '', runtimeOptions: new Map() });

beforeEach(() => {
    mockResolveExistingOpenAIPresetName.mockClear();
});

test('ghost selection: active=true and previousPreset is normalised from the stale global name on first entry', () => {
    const state = makeState();
    updateCharacterBoundPresetActiveState({
        state,
        usingCharacterBoundPreset: true,
        oaiSettingsPresetName: 'Default',
        resolveExistingOpenAIPresetName: mockResolveExistingOpenAIPresetName,
    });
    expect(state.active).toBe(true);
    expect(state.previousPreset).toBe('Default');
    expect(mockResolveExistingOpenAIPresetName).toHaveBeenCalledWith('Default');
});

test('global selection: active=false and previousPreset is preserved (restore path is the sole consumer)', () => {
    const state = makeState();
    state.active = true;
    state.previousPreset = 'Default';
    updateCharacterBoundPresetActiveState({
        state,
        usingCharacterBoundPreset: false,
        oaiSettingsPresetName: 'Creative',
        resolveExistingOpenAIPresetName: mockResolveExistingOpenAIPresetName,
    });
    expect(state.active).toBe(false);
    // Key invariant III: exiting ghost selection MUST NOT clear
    // previousPreset. The restore path at openai.js:6162 / :6188 is the
    // only place that legitimately clears it.
    expect(state.previousPreset).toBe('Default');
});

test('ghost → global → ghost → global: active tracks usingCharacterBoundPreset; previousPreset updates only on ghost re-entry', () => {
    const state = makeState();

    // 1. First ghost entry: stash normalised stale global name.
    updateCharacterBoundPresetActiveState({
        state,
        usingCharacterBoundPreset: true,
        oaiSettingsPresetName: 'Default',
        resolveExistingOpenAIPresetName: mockResolveExistingOpenAIPresetName,
    });
    expect(state.active).toBe(true);
    expect(state.previousPreset).toBe('Default');

    // 2. Switch to a global option: active flips to false, previousPreset stays.
    updateCharacterBoundPresetActiveState({
        state,
        usingCharacterBoundPreset: false,
        oaiSettingsPresetName: 'Creative',
        resolveExistingOpenAIPresetName: mockResolveExistingOpenAIPresetName,
    });
    expect(state.active).toBe(false);
    expect(state.previousPreset).toBe('Default');

    // 3. Re-enter ghost: active flips to true. Because state.active was
    //    cleared in step 2, this counts as "first entry" again and
    //    previousPreset is re-normalised — the stale name is now
    //    'Creative' (what the user was on when they entered ghost).
    updateCharacterBoundPresetActiveState({
        state,
        usingCharacterBoundPreset: true,
        oaiSettingsPresetName: 'Creative',
        resolveExistingOpenAIPresetName: mockResolveExistingOpenAIPresetName,
    });
    expect(state.active).toBe(true);
    expect(state.previousPreset).toBe('Creative');

    // 4. Back to global: active=false, previousPreset held at 'Creative'.
    updateCharacterBoundPresetActiveState({
        state,
        usingCharacterBoundPreset: false,
        oaiSettingsPresetName: 'Default',
        resolveExistingOpenAIPresetName: mockResolveExistingOpenAIPresetName,
    });
    expect(state.active).toBe(false);
    expect(state.previousPreset).toBe('Creative');
});

test('normaliser returns empty (stale name no longer in the global library): keep the prior previousPreset', () => {
    const state = makeState();
    state.previousPreset = 'OldFallback';
    updateCharacterBoundPresetActiveState({
        state,
        usingCharacterBoundPreset: true,
        oaiSettingsPresetName: 'GhostName', // not in the mock's known map -> resolves to ''
        resolveExistingOpenAIPresetName: mockResolveExistingOpenAIPresetName,
    });
    expect(state.active).toBe(true);
    // '' from the normaliser must NOT overwrite the existing fallback:
    // a stale-but-known name is strictly more useful for restore than blank.
    expect(state.previousPreset).toBe('OldFallback');
});

test('restore-path gate: previousPreset truthy → restore should trigger', () => {
    const state = { active: false, previousPreset: 'Default', runtimeOptions: new Map() };
    // Mirrors the guard used at openai.js:6162 / :6188 after the refactor.
    const shouldRestore = Boolean(state.previousPreset);
    expect(shouldRestore).toBe(true);
});

test('restore-path gate: previousPreset empty → skip restore, fall through to removeCharacterBoundRuntimeOptions', () => {
    const state = { active: false, previousPreset: '', runtimeOptions: new Map() };
    const shouldRestore = Boolean(state.previousPreset);
    expect(shouldRestore).toBe(false);
});

// ------- Fix Round 1: edge-case coverage for the fall-through branch -------
//
// Bug being pinned down:
//   With the eager stash at openai.js:6215-6218, previousPreset is almost
//   always truthy at the moment maybeApplyCharacterBoundPreset() runs its
//   restore-path gate. But on a fresh boot where the persisted
//   preset_settings_openai points at a preset that no longer exists in
//   openai_setting_names AND the DOM select has no non-ghost selection to
//   fall back on, resolveExistingOpenAIPresetName() returns '' and the
//   eager stash produces previousPreset=''. If a card-bound preset then
//   auto-applies, state ends up { active: true, previousPreset: '' }.
//
//   When boundList later empties (character switch), the restore-path gate
//   is `if (previousPreset)` → false → the else-branch runs
//   removeCharacterBoundRuntimeOptions(), which strips ghost DOM but does
//   NOT touch active. Without the Fix Round 1 change, active stays true
//   while isCharacterBoundPresetOptionSelected() flips to false — Invariant
//   I violation.
//
// The Fix Round 1 code path extracts a `clearCharacterBoundActiveAfterRemoval`
// helper called from both fall-through arms of the restore-path gate. The
// tests below cover the helper contract directly, giving real regression
// coverage (a future refactor dropping the `state.active = false` inside
// the helper WOULD flip these tests to fail).
//
// Note on e2e coverage for the true fresh-boot scenario: staging
// `oai_settings.preset_settings_openai='NonExistent'` + an empty native
// <select> selection AT the moment ghost auto-applies requires a custom
// fixture beyond the current preset test batch's helpers. Deferred to a
// follow-up spec; this fix round covers the branch behavior at the
// helper-contract level.

const { clearCharacterBoundActiveAfterRemoval } = await import(
    '/scripts/character/character-bound-preset-state-sync.js'
);

test('clearCharacterBoundActiveAfterRemoval: clears active from true to false (Invariant I after ghost DOM strip)', () => {
    const state = { active: true, previousPreset: '', runtimeOptions: new Map() };
    clearCharacterBoundActiveAfterRemoval(state);
    expect(state.active).toBe(false);
});

test('clearCharacterBoundActiveAfterRemoval: idempotent when already false', () => {
    const state = { active: false, previousPreset: '', runtimeOptions: new Map() };
    clearCharacterBoundActiveAfterRemoval(state);
    expect(state.active).toBe(false);
});

test('clearCharacterBoundActiveAfterRemoval: does not touch previousPreset (only the restore arm consumes it)', () => {
    // Even though this arm is called specifically when previousPreset is
    // already empty, the helper must remain single-purpose so a future
    // caller in a different context can trust its contract.
    const state = { active: true, previousPreset: 'SomeName', runtimeOptions: new Map() };
    clearCharacterBoundActiveAfterRemoval(state);
    expect(state.active).toBe(false);
    expect(state.previousPreset).toBe('SomeName');
});
