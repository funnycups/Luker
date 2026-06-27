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
 * Earlier revisions did in-place key replacement on `oai_settings` and
 * relied on three events (GENERATE_TAKEOVER_DISPATCH head,
 * GENERATION_ENDED, GENERATION_STOPPED) to restore the original keys.
 * If all three were missed, `oai_settings.prompts` / `prompt_order`
 * stayed pinned to the pure body. ST's `hasUnsavedOpenAIPresetChanges`
 * then reported the dirty `oai_settings` as "unsaved changes" against
 * the clean cache; the user clicked Save, and the pure body was
 * persisted to the original preset's disk file. Data loss.
 *
 * The new design registers `orchestrator:director-pure` as a session-
 * only synthetic Chat-Completion preset (cache + dropdown option, no
 * disk persistence) and routes the swap through it. Even if restore
 * leaks, the active preset name is now the synthetic one, so ST's
 * unsaved-changes detector cannot diff against the user's original
 * and cannot offer to overwrite it.
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

function getSelectElement() {
    if (typeof document === 'undefined') return null;
    return document.getElementById('settings_preset_openai');
}

function selectOptionByValue(value) {
    const select = getSelectElement();
    if (!select) return;
    const target = String(value);
    for (const option of select.options) {
        option.selected = option.value === target;
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
    const select = getSelectElement();
    if (select && typeof document !== 'undefined') {
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
    const settings = ctx?.openai?.settings;
    const settingNames = ctx?.openai?.settingNames;
    if (!oaiSettings || !Array.isArray(settings) || !settingNames) {
        throw new Error('[orchestrator] cannot apply preset swap: openai context missing');
    }

    const activeName = oaiSettings.preset_settings_openai;
    const activeIdx = settingNames[activeName];

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
        // POPUP_RESULT.NEGATIVE → Discard: fall through; swap below
        // overwrites the dirty oai_settings, and cache (clean disk
        // copy) backs the restore later.
    }

    const pureIdx = settingNames[DIRECTOR_PURE_PRESET_NAME];
    if (!Number.isInteger(pureIdx)) {
        throw new Error('[orchestrator] synthetic preset not registered; call ensureDirectorPureSyntheticPreset at init');
    }

    const bodyClone = cloneForSettings(DIRECTOR_PURE_PRESET_BODY);
    for (const key of Object.keys(bodyClone)) {
        oaiSettings[key] = bodyClone[key];
    }
    oaiSettings.preset_settings_openai = DIRECTOR_PURE_PRESET_NAME;
    selectOptionByValue(pureIdx);

    pendingPresetSnapshot = { activeName, activeIdx };
}

/**
 * Restore the original preset by copying its cached body back into
 * `oai_settings`. Idempotent — no-op when no swap is pending. Safe to
 * call from multiple unrelated event hooks.
 *
 * Reads from `openai_settings[idx]` cache rather than a frozen
 * snapshot so that any user "Save and continue" choice during the
 * unsaved-changes guard is preserved at restore time.
 */
export function restoreDirectorPresetSwap(ctx) {
    if (pendingPresetSnapshot === null) return;
    const { activeName, activeIdx } = pendingPresetSnapshot;
    pendingPresetSnapshot = null;

    const oaiSettings = ctx?.chatCompletionSettings;
    const settings = ctx?.openai?.settings;
    const settingNames = ctx?.openai?.settingNames;
    if (!oaiSettings || !Array.isArray(settings) || !settingNames) {
        console.warn('[orchestrator] cannot restore preset swap: openai context missing');
        return;
    }

    const resolvedIdx = Number.isInteger(settingNames[activeName])
        ? settingNames[activeName]
        : activeIdx;
    const origBody = Number.isInteger(resolvedIdx) ? settings[resolvedIdx] : null;

    if (!origBody || typeof origBody !== 'object') {
        console.warn(`[orchestrator] cannot restore preset "${activeName}": cache entry missing. Resetting active preset name only.`);
        oaiSettings.preset_settings_openai = activeName;
        return;
    }

    const orig = cloneForSettings(origBody);
    for (const key of Object.keys(oaiSettings)) {
        if (!Object.prototype.hasOwnProperty.call(orig, key) && key !== 'preset_settings_openai') {
            try { delete oaiSettings[key]; } catch (_) { /* best-effort */ }
        }
    }
    Object.assign(oaiSettings, orig);
    oaiSettings.preset_settings_openai = activeName;

    if (Number.isInteger(resolvedIdx)) {
        selectOptionByValue(resolvedIdx);
    }

    try {
        ctx?.openai?.promptManager?.render?.(false);
    } catch (err) {
        console.warn('[orchestrator] promptManager render after restore failed:', err);
    }
}

// Test-only: reset module state between unit tests.
export function __resetDirectorPresetSwapForTests() {
    pendingPresetSnapshot = null;
}

export function __getPendingDirectorPresetSnapshotForTests() {
    return pendingPresetSnapshot;
}
