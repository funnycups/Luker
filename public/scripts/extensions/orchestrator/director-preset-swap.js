// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Director-mode preset swap.
 *
 * Director-mode generation needs a clean Chat-Completion preset while
 * ST composes the captured `prompt` array so it carries no user
 * preset-level content (NSFW prompt, jailbreak, custom prompt_order,
 * etc.). This module owns that swap.
 *
 * The swap routes through a registered synthetic preset
 * (`orchestrator:director-pure`), not in-place key replacement on
 * oai_settings. Apply and restore both delegate to
 * `ctx.openai.applyByName(name)` so the swap goes through the same
 * `onSettingsPresetChange` code path that runs when the user manually
 * picks a preset from the dropdown — that path only touches keys listed
 * in `settingsToUpdate`, leaving settings-only state (e.g. the
 * `bias_presets` dictionary, in-memory UI flags) untouched. The earlier
 * hand-rolled `delete + Object.assign` restore wiped any key that the
 * user's preset body did not contain, which destroyed `bias_presets` on
 * every director turn and produced
 * `Cannot read properties of undefined (reading 'Default (none)')`
 * the next time a sub-agent dispatched with
 * `chat_completion_source: openai`.
 *
 * Even if restore leaks, the active preset name during the swap is the
 * synthetic one, so ST's unsaved-changes detector cannot diff against
 * the user's original and cannot offer to overwrite it.
 *
 * An additional guard at the apply entry: if the active preset has
 * unsaved changes when director is about to run, prompt the user
 * (Save / Discard / Cancel director). Cancel throws to abort.
 */

import { DIRECTOR_PURE_PRESET_NAME, DIRECTOR_PURE_PRESET_BODY } from './pure-preset-body.js';
import { i18n, i18nFormat } from './i18n.js';

let pendingPresetSnapshot = null;

function cloneForSettings(value) {
    try {
        return structuredClone(value);
    } catch (_) {
        return JSON.parse(JSON.stringify(value));
    }
}

/**
 * Idempotent. Pushes the pure body into `openai_settings`, registers
 * the name in `openai_setting_names`, and appends an `<option>` to
 * `#settings_preset_openai`. Never writes to disk.
 *
 * Re-registration (same name already present) replaces the cache slot
 * in place so dropdown order is preserved.
 */
export function ensureDirectorPureSyntheticPreset(ctx) {
    const settings = ctx?.openai?.settings;
    const settingNames = ctx?.openai?.settingNames;
    if (!Array.isArray(settings) || !settingNames || typeof settingNames !== 'object') {
        console.warn('[orchestrator] cannot register synthetic preset: openai settings/settingNames missing');
        return;
    }
    const bodyClone = cloneForSettings(DIRECTOR_PURE_PRESET_BODY);
    const existingIdx = settingNames[DIRECTOR_PURE_PRESET_NAME];
    if (Number.isInteger(existingIdx) && existingIdx >= 0 && existingIdx < settings.length) {
        settings[existingIdx] = bodyClone;
        return;
    }
    settings.push(bodyClone);
    const idx = settings.length - 1;
    settingNames[DIRECTOR_PURE_PRESET_NAME] = idx;
    if (typeof document !== 'undefined') {
        const select = document.getElementById('settings_preset_openai');
        if (select) {
            const existing = Array.from(select.options).find(opt => opt.innerText === DIRECTOR_PURE_PRESET_NAME);
            if (!existing) {
                const option = document.createElement('option');
                option.value = String(idx);
                option.innerText = DIRECTOR_PURE_PRESET_NAME;
                select.appendChild(option);
            } else {
                existing.value = String(idx);
            }
        }
    }
}

/**
 * Apply the swap. Async because the unsaved-changes guard may show a
 * popup. Throws if the user cancels.
 *
 * Defensive entry: if a prior swap leaked (snapshot still set), restore
 * it first so the guard reads a clean baseline.
 */
export async function applyDirectorPresetSwap(ctx) {
    if (pendingPresetSnapshot !== null) {
        restoreDirectorPresetSwap(ctx);
    }

    const oaiSettings = ctx?.chatCompletionSettings;
    const settingNames = ctx?.openai?.settingNames;
    const applyByName = ctx?.openai?.applyByName;
    if (!oaiSettings || !settingNames || typeof applyByName !== 'function') {
        throw new Error('[orchestrator] cannot apply preset swap: openai context missing');
    }
    if (!Number.isInteger(settingNames[DIRECTOR_PURE_PRESET_NAME])) {
        throw new Error('[orchestrator] synthetic preset not registered; call ensureDirectorPureSyntheticPreset at init');
    }

    const activeName = oaiSettings.preset_settings_openai;

    if (typeof ctx?.openai?.hasUnsavedChanges === 'function' && ctx.openai.hasUnsavedChanges(activeName)) {
        const result = await ctx.callGenericPopup(
            i18nFormat('Director will switch to a synthetic preset for prompt composition. The active preset "${0}" has unsaved changes.', activeName),
            ctx.POPUP_TYPE.CONFIRM,
            '',
            {
                okButton: i18n('Save and continue'),
                cancelButton: i18n('Discard and continue'),
                customButtons: [{
                    text: i18n('Cancel director run'),
                    result: ctx.POPUP_RESULT.CANCELLED,
                    appendAtEnd: true,
                }],
            },
        );
        if (result === ctx.POPUP_RESULT.CANCELLED || result === null) {
            try {
                if (typeof toastr !== 'undefined') {
                    toastr.error(i18n('Director cancelled: resolve unsaved preset changes first.'));
                }
            } catch (_) { /* toastr unavailable */ }
            throw new Error('[orchestrator] director cancelled (unsaved preset changes)');
        }
        if (result === ctx.POPUP_RESULT.AFFIRMATIVE) {
            await ctx.openai.savePreset(activeName, oaiSettings, false);
        }
        // POPUP_RESULT.NEGATIVE → Discard: fall through; the swap below
        // overwrites the dirty oai_settings via applyByName, and the
        // cache (clean disk copy) backs the restore later.
    }

    applyByName(DIRECTOR_PURE_PRESET_NAME, { forceChange: true });
    pendingPresetSnapshot = { activeName };
}

/**
 * Restore the original preset by delegating to the core's
 * `applyPresetByName`. Idempotent — no-op when no swap is pending. Safe
 * to call from multiple unrelated event hooks.
 */
export function restoreDirectorPresetSwap(ctx) {
    if (pendingPresetSnapshot === null) return;
    const { activeName } = pendingPresetSnapshot;
    pendingPresetSnapshot = null;

    const applyByName = ctx?.openai?.applyByName;
    if (typeof applyByName !== 'function') {
        console.warn('[orchestrator] cannot restore preset swap: ctx.openai.applyByName missing');
        return;
    }

    applyByName(activeName, { forceChange: true });
}

// Test-only: reset module state between unit tests.
export function __resetDirectorPresetSwapForTests() {
    pendingPresetSnapshot = null;
}

export function __getPendingDirectorPresetSnapshotForTests() {
    return pendingPresetSnapshot;
}
