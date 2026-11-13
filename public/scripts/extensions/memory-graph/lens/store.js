// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal observable state container + persisted UI preferences.

const PREF_KEY = 'memoryLens.prefs.v1';
const PERSISTED = ['theme', 'view', 'graphLayout', 'sidebarOpen', 'inspectorOpen', 'timelineOrder'];

export function loadPrefs() {
    try {
        const raw = globalThis.localStorage?.getItem(PREF_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function savePrefs(state) {
    try {
        const out = {};
        for (const key of PERSISTED) out[key] = state[key];
        globalThis.localStorage?.setItem(PREF_KEY, JSON.stringify(out));
    } catch {
        // Storage may be unavailable (private mode); preferences are optional.
    }
}

export function createStore(initial) {
    let state = { ...initial };
    const listeners = new Set();
    return {
        get: () => state,
        set(patch) {
            const next = typeof patch === 'function' ? patch(state) : patch;
            const changed = Object.keys(next).filter(key => state[key] !== next[key]);
            if (!changed.length) return;
            state = { ...state, ...next };
            if (changed.some(key => PERSISTED.includes(key))) savePrefs(state);
            const changedSet = new Set(changed);
            for (const fn of [...listeners]) fn(state, changedSet);
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
