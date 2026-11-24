// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure live behavioral summary model for Character Editor Assistant.
// No DOM dependencies.

function defaultTranslate(text) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? '')) : String(text ?? '');
}

function clampInt(raw, min, max, fallback) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const parsed = isBlank ? NaN : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}

/**
 * Builds the 1-row behavioral summary model for Character Editor Assistant
 * settings (fallback connection, fallback preset, tool-call retries, and
 * Workbench Settings precedence note).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildCeaSummaryModel(state = {}) {
    const i18n = typeof state.i18n === 'function' ? state.i18n : defaultTranslate;
    const apiPreset = String(state.requestApiPresetName || '').trim();
    const llmPreset = String(state.requestLlmPresetName || '').trim();
    const retries = clampInt(state.toolCallRetryMax, 0, 10, 2);

    return {
        tone: 'active',
        rows: [{
            role: i18n('Fallback AI'),
            template: i18n('Fallback AI uses ${requestApiPresetName} + ${requestLlmPresetName} with up to ${toolCallRetryMax} tool-call retries — Workbench → Settings overrides connection and preset inside Workbench.'),
            tokens: {
                requestApiPresetName: {
                    field: 'requestApiPresetName',
                    text: apiPreset || i18n('(Current API config)'),
                    tone: 'active',
                },
                requestLlmPresetName: {
                    field: 'requestLlmPresetName',
                    text: llmPreset || i18n('(Current preset)'),
                    tone: 'active',
                },
                toolCallRetryMax: {
                    field: 'toolCallRetryMax',
                    text: String(retries),
                    tone: retries > 0 ? 'active' : 'off',
                },
            },
        }],
        warnings: [],
        dormantFields: [],
    };
}
