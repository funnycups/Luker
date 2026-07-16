// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Refactor goal: unify `characterBoundPresetState.active`'s two prior
 * meanings ("restore-armed" vs "ghost DOM-selected") onto a single
 * "ghost DOM-selected" semantic that mirrors
 * `isCharacterBoundPresetOptionSelected()` at every settle point.
 *
 * Invariant I:  after this runs, `state.active` ≡ `usingCharacterBoundPreset`
 *               (which is itself the DOM ground-truth signal read from
 *               `#settings_preset_openai option[data-luker-char-bound="1"]:checked`).
 * Invariant III: exiting ghost selection MUST NOT clear `previousPreset` —
 *                the restore path (`maybeApplyCharacterBoundPreset` in
 *                openai.js, both its `selected_group` branch and its empty-
 *                `boundList` branch) is the sole consumer + clearer.
 *                Leaving it populated lets a user toggle ghost → global →
 *                ghost with the same stashed restore target.
 *
 * The `resolveExistingOpenAIPresetName` normaliser is passed as an
 * injected function so this module never has to import openai.js
 * (which would create a cycle).
 *
 * @param {object} args
 * @param {{active: boolean, previousPreset: string, runtimeOptions: Map}} args.state
 *   The shared `characterBoundPresetState` object; mutated in place.
 * @param {boolean} args.usingCharacterBoundPreset
 *   Whether the currently selected `<option>` in `#settings_preset_openai`
 *   is a ghost card-bound option (`data-luker-char-bound="1"`).
 * @param {string} args.oaiSettingsPresetName
 *   The current `oai_settings.preset_settings_openai` value. When we first
 *   enter ghost selection, this is the stale global name we stash so that
 *   the restore path (invariant III) can bring the UI back to a real
 *   global preset on the way out.
 * @param {(name: string) => string} args.resolveExistingOpenAIPresetName
 *   Normalises the stashed name against the current global preset library
 *   (canonical casing / accent handling). Returning '' means "no match" —
 *   we keep the prior `previousPreset` instead of overwriting it with ''.
 */
export function updateCharacterBoundPresetActiveState({
    state,
    usingCharacterBoundPreset,
    oaiSettingsPresetName,
    resolveExistingOpenAIPresetName,
}) {
    if (usingCharacterBoundPreset) {
        if (!state.active) {
            // First entry into ghost selection this cycle: stash the current
            // stale global name as the restore fallback. Normalise so that
            // a later restoreOpenAIPresetAfterCharacterBound() can find it
            // in openai_setting_names without case / accent drift. If the
            // normaliser returns '' (stale name no longer in the global
            // library), preserve whatever we had — losing a stale-but-known
            // fallback for a definite blank is strictly worse.
            state.previousPreset =
                resolveExistingOpenAIPresetName(String(oaiSettingsPresetName ?? '').trim())
                || state.previousPreset;
        }
        state.active = true;
    } else {
        state.active = false;
        // Deliberately do NOT clear previousPreset here. See invariant III
        // in the module header: the restore path inside
        // maybeApplyCharacterBoundPreset (openai.js) is the sole consumer
        // + clearer. A user flipping ghost → global → ghost within the
        // same character session still wants the original stashed name
        // available for the eventual restore.
    }
}

/**
 * Fix Round 1 helper. Called from the fall-through (empty-`previousPreset`)
 * arm of both restore-path gates in `maybeApplyCharacterBoundPreset`
 * (openai.js). The caller has just invoked `removeCharacterBoundRuntimeOptions()`
 * to strip ghost DOM; Invariant I then demands `state.active` land on false
 * to match the freshly-stripped DOM signal. Without this clear, a fresh-
 * boot ghost auto-apply against an unresolvable stale global name (which
 * leaves `previousPreset=''`) would strand `active=true` after a subsequent
 * character switch to a non-bound character.
 *
 * Kept separate from the restore-arm's own field clears because the
 * restore arm also needs to blank `previousPreset` (it just consumed it)
 * whereas this arm has no previousPreset to clear.
 *
 * @param {{active: boolean, previousPreset: string, runtimeOptions: Map}} state
 */
export function clearCharacterBoundActiveAfterRemoval(state) {
    state.active = false;
}
