// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * CPA — plugin-owned per-preset session store.
 *
 * Backed by ctx.presets.state (the Plan 1 sidecar that CPA already uses
 * for its in-memory iteration state). This module exposes the
 * { list, load, save, delete, clearObsolete } surface the new Stage 3
 * popup expects, plus the { getCurrentSessionId, setCurrentSessionId }
 * pair the popup uses to remember which session was last open per preset.
 *
 * Ported verbatim from cpa-iteration-adapter.js (the shell-driven adapter
 * that Stage 3 retires):
 *
 *   - SESSION_NAMESPACE      (top-of-file constant)
 *   - migrateLegacySession   (Plan 2 surfaceState shim)
 *   - readStore / writeStore (presets.state get/update wrappers)
 *   - list/load/save/delete  (adapter listSessions/loadSession/...)
 *
 * Rules of the road:
 *   - Every state.get / state.update call passes `target: getTargetRef()`.
 *     The preset target can change between calls (user clicks another
 *     preset in the dropdown), so the ref is fetched fresh each time
 *     instead of being cached at factory time.
 *   - clearObsolete() is a no-op: Plan 1 already wiped pre-sidecar
 *     journal-era data. Kept as a method so the popup can call the same
 *     lifecycle hook against every backend.
 *
 * Pure ESM. No DOM, no jQuery, no globals.
 */

const SESSION_NAMESPACE = 'completion_preset_assistant_session';

/**
 * Lift legacy top-level fields (referencePresetName, mode) into the
 * surfaceState bag introduced in Plan 2. Idempotent: returns the input
 * unchanged once surfaceState is present, or when no legacy fields are
 * found. Surface modes that fail validation in newer code are still
 * preserved here — the dropdown renders them as 'general' when
 * unrecognized; we keep the stored value so a future revert wouldn't
 * drop user state.
 */
function migrateLegacySession(clone) {
    if (!clone || typeof clone !== 'object') return clone;
    if (clone.surfaceState) return clone;
    const legacyRef = clone.referencePresetName;
    const legacyMode = clone.mode;
    const surfaceModeValues = new Set(['free', 'guided', 'explore', 'general', 'orchestrator-optimize', 'jailbreak-only']);
    const isLegacySurfaceMode = surfaceModeValues.has(legacyMode);
    if (!legacyRef && !isLegacySurfaceMode) return clone;
    clone.surfaceState = {
        ...(legacyRef ? { referencePresetName: legacyRef } : {}),
        ...(isLegacySurfaceMode ? { sessionMode: legacyMode } : {}),
    };
    if (legacyRef) delete clone.referencePresetName;
    if (isLegacySurfaceMode) delete clone.mode;
    return clone;
}

/**
 * @param {object} args
 * @param {() => any} args.getContext       SillyTavern context accessor
 * @param {() => { collection: string, name: string }} args.getTargetRef
 *        Returns the current preset target (collection + preset name).
 *        Called on every read/write — never cache the ref at factory time.
 * @returns {{
 *   list: () => Promise<Array<{ id: string, title: string, updatedAt: number, summary: string }>>,
 *   load: (id: string) => Promise<object|null>,
 *   save: (session: object) => Promise<void>,
 *   delete: (id: string) => Promise<void>,
 *   clearObsolete: () => Promise<void>,
 *   getCurrentSessionId: () => Promise<string|null>,
 *   setCurrentSessionId: (id: string|null) => Promise<void>,
 * }}
 */
export function createCpaIterationSessionStore({ getContext, getTargetRef }) {
    async function readStore() {
        const ref = getTargetRef();
        const ctx = getContext();
        const store = await ctx.presets.state.get(SESSION_NAMESPACE, { target: ref });
        return store && Array.isArray(store.sessions)
            ? store
            : { version: 1, currentSessionId: null, sessions: [] };
    }

    async function writeStore(store) {
        const ref = getTargetRef();
        const ctx = getContext();
        await ctx.presets.state.update(SESSION_NAMESPACE, () => store, { target: ref });
    }

    return {
        list: async () => {
            const store = await readStore();
            return store.sessions
                .map(s => ({ id: s.id, title: s.title || '', updatedAt: s.updatedAt || 0, summary: s.summary || '' }))
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        },

        load: async (id) => {
            const store = await readStore();
            const s = store.sessions.find(x => x.id === id);
            if (!s) return null;
            const clone = structuredClone(s);
            return migrateLegacySession(clone);
        },

        save: async (session) => {
            const store = await readStore();
            const idx = store.sessions.findIndex(x => x.id === session.id);
            const clone = structuredClone(session);
            if (idx >= 0) store.sessions[idx] = clone;
            else store.sessions.push(clone);
            store.currentSessionId = session.id;
            await writeStore(store);
        },

        delete: async (id) => {
            const store = await readStore();
            store.sessions = store.sessions.filter(s => s.id !== id);
            if (store.currentSessionId === id) store.currentSessionId = null;
            await writeStore(store);
        },

        clearObsolete: async () => {
            // Plan 1 already wiped legacy journal-era data; nothing to do here.
        },

        getCurrentSessionId: async () => {
            const store = await readStore();
            return store.currentSessionId ?? null;
        },

        setCurrentSessionId: async (id) => {
            const store = await readStore();
            store.currentSessionId = id ?? null;
            await writeStore(store);
        },
    };
}
