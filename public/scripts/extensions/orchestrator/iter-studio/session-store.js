// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Orchestrator — plugin-owned session store.
 *
 * Stage 5 sibling to studio.js. Thin wrapper around Stage 1's
 * createExtensionSettingsSessionStorage scoped to
 *
 *     extension_settings.luker_orchestrator[SESSIONS_BUCKET_KEY][mode][scope]
 *
 * Both the iteration mode (spec / loop / agenda / director) and the dynamic
 * scope (global vs character_<avatar>) are baked into the wrapper's closure so
 * the popup gets the simple `list / load / save / delete` surface the other
 * plugin-owned popups expose — without having to remember to thread the mode
 * + scope through every call site.
 *
 * `clearObsolete` strips the legacy `global_iteration_history` key the
 * pre-v2 schema used; the v2 bucket lives under SESSIONS_BUCKET_KEY and is
 * unaffected.
 *
 * Pure ESM. No DOM, no jQuery, no globals.
 */

import { createExtensionSettingsSessionStorage } from '../../../iteration-library/storage.js';

const SESSIONS_BUCKET_KEY = 'iterStudioV2';
const LEGACY_GLOBAL_HISTORY_KEY = 'global_iteration_history';

/**
 * @param {object} args
 * @param {string} args.mode
 *        One of 'spec' | 'loop' | 'agenda' | 'director'. Each mode keeps its
 *        own session bucket so switching execution modes in the host UI does
 *        not pollute the other modes' history lists.
 * @param {() => object} args.getOrchestratorSettingsRoot
 *        Returns the mutable orchestrator extension settings root. The
 *        wrapper lazy-creates `[SESSIONS_BUCKET_KEY][mode][scope]` on first
 *        access; the caller does not need to pre-seed it.
 * @param {() => void} args.persistSettings
 *        Called after every mutating op (save / delete) so the host can
 *        flush extension_settings (e.g. via saveSettingsDebounced).
 * @param {() => string} args.computeScope
 *        Returns the current scope key (typically 'global' or
 *        `character_<avatar>`). Evaluated lazily on each bucket access so
 *        switching characters mid-session routes new writes to the right
 *        bucket without restarting the popup.
 * @returns {{
 *   list: () => Promise<Array<{ id: string, title: string, updatedAt: number }>>,
 *   load: (id: string) => Promise<object|null>,
 *   save: (session: object) => Promise<void>,
 *   delete: (id: string) => Promise<void>,
 *   clearObsolete: () => Promise<void>,
 * }}
 */
export function createOrchestratorIterationSessionStore({
    mode,
    getOrchestratorSettingsRoot,
    persistSettings,
    computeScope,
}) {
    if (!mode) {
        throw new TypeError('createOrchestratorIterationSessionStore: mode is required');
    }
    if (typeof getOrchestratorSettingsRoot !== 'function') {
        throw new TypeError('createOrchestratorIterationSessionStore: getOrchestratorSettingsRoot must be a function');
    }
    if (typeof persistSettings !== 'function') {
        throw new TypeError('createOrchestratorIterationSessionStore: persistSettings must be a function');
    }
    if (typeof computeScope !== 'function') {
        throw new TypeError('createOrchestratorIterationSessionStore: computeScope must be a function');
    }

    // Single fixed scope inside the underlying storage wrapper; the real
    // dynamic mode + scope are resolved per-call inside getBucket.
    const innerScope = '__bound__';

    const inner = createExtensionSettingsSessionStorage({
        getBucket: () => {
            const root = getOrchestratorSettingsRoot() || {};
            if (!root[SESSIONS_BUCKET_KEY] || typeof root[SESSIONS_BUCKET_KEY] !== 'object') {
                root[SESSIONS_BUCKET_KEY] = {};
            }
            if (!root[SESSIONS_BUCKET_KEY][mode] || typeof root[SESSIONS_BUCKET_KEY][mode] !== 'object') {
                root[SESSIONS_BUCKET_KEY][mode] = {};
            }
            const scope = computeScope() || 'global';
            if (!root[SESSIONS_BUCKET_KEY][mode][scope] || typeof root[SESSIONS_BUCKET_KEY][mode][scope] !== 'object') {
                root[SESSIONS_BUCKET_KEY][mode][scope] = {};
            }
            return root[SESSIONS_BUCKET_KEY][mode][scope];
        },
        persistSettings,
    });

    return {
        list: () => inner.listSessions(innerScope),
        load: (id) => inner.loadSession(innerScope, id),
        save: (session) => inner.saveSession(innerScope, session),
        delete: (id) => inner.deleteSession(innerScope, id),
        clearObsolete: async () => {
            const root = getOrchestratorSettingsRoot();
            if (root && Object.hasOwn(root, LEGACY_GLOBAL_HISTORY_KEY)) {
                delete root[LEGACY_GLOBAL_HISTORY_KEY];
                persistSettings();
            }
        },
    };
}
