// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Origin-aware `hasUnsavedOpenAIPresetChanges` — extracted from openai.js so
// the origin-dispatch decision can be exercised without loading the 10k-line
// openai.js module (jQuery / script.js / 40+ transitive imports; see
// tests/character-presets/main-chat-selector.test.js:5-13 for the same
// finding). openai.js keeps the outer function name and simply forwards to
// this helper with its live singletons plugged in.
//
// Why this matters: the pre-refactor implementation compared the live
// (possibly card-slot-authored) body against `openai_settings[global-index]`.
// When a card slot shares the name of a global preset — or a card slot is
// active while a stale `preset_settings_openai` name lingers — that
// comparison is guaranteed to be false-negative, the user sees a spurious
// "unsaved changes" popup, and clicking "Save and continue" writes the card
// body into the wrong global preset. This helper routes the comparison
// through `readSelectedPresetRef` so a card-bound selection compares against
// the card slot body instead.
//
// Dispatch policy mirrors save-dispatch.js:62-73 (decideSavePresetDispatch)
// so save intent and unsaved-change detection stay in lock-step.

import { readSelectedPresetRef } from './save-dispatch.js';
import { getCharacterBoundPreset } from './presets.js';
import { getContext } from '/scripts/st-context.js';

/**
 * @param {string} presetName
 *   The name whose in-flight edits we're testing for. When the caller is
 *   `onSettingsPresetChange`, this is `presetNameBefore` (the outgoing
 *   preset), not the incoming one — see openai.js:7278 caller.
 * @param {{selectValue?: string} | undefined} options
 *   `selectValue` overrides the `#settings_preset_openai` DOM read. This is
 *   required for callers that mutate the DOM before checking (again, see
 *   openai.js `onSettingsPresetChange` — by the time we get there the
 *   dropdown already reflects the new selection, so we have to feed it the
 *   captured `previousSelectValue`).
 * @param {{
 *   openaiSettingNames: Record<string, number>,
 *   openaiSettings: Array<object>,
 *   oaiSettings: object,
 *   getChatCompletionPreset: (settings: object, opts?: object) => object,
 *   areComparableOpenAIPresetBodiesEqual: (a: object, b: object) => boolean,
 * }} deps
 *   openai.js-side singletons, passed as arguments so this module doesn't
 *   have to reach back into openai.js (which would form an import cycle
 *   through save-dispatch.js → preset-ref-codec.js → openai.js).
 * @returns {boolean}
 */
export function hasUnsavedOpenAIPresetChanges(presetName, options, deps) {
    const normalizedName = String(presetName || '').trim();
    if (!normalizedName) return false;

    // Explicit `options.selectValue` wins so callers that already know the
    // ghost-value they care about (typically because they captured it before
    // the DOM mutated) do not race the dropdown. Fallback path reads the
    // dropdown so third-party callers (director-preset-swap, ext scripts via
    // ctx.openai.hasUnsavedChanges) get origin-aware behaviour automatically.
    const selectValueRaw = (options && typeof options.selectValue === 'string')
        ? options.selectValue
        : (typeof document !== 'undefined'
            ? String(document.getElementById('settings_preset_openai')?.value ?? '')
            : '');

    const ref = readSelectedPresetRef({
        selectValue: selectValueRaw,
        fallbackName: normalizedName,
    });

    if (ref.origin?.kind === 'character' && String(ref.name || '') === normalizedName) {
        // Character branch: compare the live body against the card slot body.
        // A missing character (deleted / not-yet-loaded) or missing slot is
        // not a change — treat as clean so the caller doesn't pop a
        // "unsaved changes" dialog for something we can't compare.
        const character = getContext()?.characters?.find(c => c && c.avatar === ref.origin.avatar);
        if (!character) return false;
        const hit = getCharacterBoundPreset(character, normalizedName);
        if (!hit || !hit.preset) return false;
        const live = deps.getChatCompletionPreset(deps.oaiSettings, {
            clone: false,
            includeConnectionFields: false,
        });
        return !deps.areComparableOpenAIPresetBodiesEqual(live, hit.preset);
    }

    // Global branch — original fast path. Covers:
    //   • ref.origin.kind === 'global' (plain global selection)
    //   • ref.origin.kind === 'character' but ref.name !== normalizedName
    //     (user opened the "New Preset" dialog while a card slot was
    //     selected → save-dispatch.js:70-72 treats this as create-new-global,
    //     so hasUnsavedChanges must ask about the global library, not the
    //     card slot).
    const presetIndex = deps.openaiSettingNames?.[normalizedName];
    if (!Number.isInteger(presetIndex)) return false;
    const savedPresetBody = deps.openaiSettings?.[presetIndex];
    if (!savedPresetBody || typeof savedPresetBody !== 'object') return false;
    return !deps.areComparableOpenAIPresetBodiesEqual(
        deps.getChatCompletionPreset(deps.oaiSettings, { clone: false }),
        savedPresetBody,
    );
}
