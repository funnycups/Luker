// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-browser UI preferences (window box, theme, last page). Settings that
// should follow the account (AI connections, rules) live in Luker's
// extensionSettings instead — see source-luker.js.

const KEY = 'workbench.prefs.v1';

export function loadPrefs() {
    try {
        const value = JSON.parse(globalThis.localStorage?.getItem(KEY) || '{}');
        return value && typeof value === 'object' ? value : {};
    } catch {
        return {};
    }
}

export function savePrefs(patch) {
    try {
        const next = { ...loadPrefs(), ...patch };
        globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
        return next;
    } catch {
        return null;
    }
}
