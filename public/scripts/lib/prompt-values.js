// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/** Validate an editable stored prompt without changing its content. */
export function requireStoredPrompt(value, emptyMessage) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(emptyMessage);
    }
    return value;
}

/** Initialize legacy blank values in a caller-owned settings scope. */
export function initializePromptDefaults(settings, defaults, { sparse = false } = {}) {
    if (settings.promptDefaultsInitialized === true) return false;
    for (const [key, value] of Object.entries(defaults)) {
        if (sparse && !Object.hasOwn(settings, key)) continue;
        if (!String(settings[key] ?? '').trim()) settings[key] = value;
    }
    settings.promptDefaultsInitialized = true;
    return true;
}
