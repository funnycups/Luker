/**
 * CEA Character — per-character session store.
 *
 * Thin wrapper around `iterationLibrary.storage.createExtensionSettingsSessionStorage`
 * that binds the bucket path
 *   extension_settings.character_editor_assistant.popupSessionsV2[char_<avatar>]
 * so each character keeps its own iteration history.
 *
 * The wrapper exists for two reasons:
 *   1. Each plugin owns its own bucket layout — Stage 1's factory is scope-agnostic,
 *      so the CEA character popup needs a small shim that knows about the
 *      `popupSessionsV2[char_<avatar>]` shape.
 *   2. Earlier versions of CEA wrote to `lorebookSyncHistory` and `popupSessions`
 *      directly on the extension settings root. `clearObsolete()` is here so the
 *      popup-redo can sweep those keys when a character is first opened against
 *      the new schema.
 */

import { createExtensionSettingsSessionStorage } from '../../../iteration-library/storage.js';

/**
 * Generate a stable per-message id. The studio renders messages keyed by
 * id (so re-renders are stable), and persisted messages keep their id
 * across reloads. The shape — `cea_charit_msg_<timestamp36>_<rand>` —
 * mirrors the session id format used elsewhere and is recognized as
 * CEA-char-origin by downstream consumers (mirrors the `orch_msg_*` /
 * `cpa_msg_*` / `mg_msg_*` conventions of sibling popups).
 */
export function makeMessageId() {
    return `cea_charit_msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize a message read from disk into the shape rendered today.
 * Legacy sessions persisted only `{role, content}`; the upgraded schema
 * adds `id`, `at`, optional `toolCalls`, `edits`, `appliedAt`,
 * `appliedTarget`, `rolledBackAt`, and an `auto` flag for synthetic
 * auto-continue user messages.
 *
 * Tolerance: missing `id` regenerates one, missing `at` falls back to
 * the session's updatedAt, missing arrays stay undefined (renderer
 * uses Array.isArray as the visibility gate).
 */
export function normalizeMessageShape(m, fallbackAt = Date.now()) {
    if (!m || typeof m !== 'object') return m;
    const out = {
        id: typeof m.id === 'string' && m.id ? m.id : makeMessageId(),
        role: String(m.role || 'user'),
        content: String(m.content ?? ''),
        at: typeof m.at === 'number' ? m.at : Number(fallbackAt) || Date.now(),
    };
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) out.toolCalls = m.toolCalls;
    if (Array.isArray(m.edits) && m.edits.length > 0) out.edits = m.edits;
    if (typeof m.appliedAt === 'number') out.appliedAt = m.appliedAt;
    if (m.appliedTarget) out.appliedTarget = String(m.appliedTarget);
    if (typeof m.rolledBackAt === 'number') out.rolledBackAt = m.rolledBackAt;
    if (m.auto) out.auto = true;
    return out;
}

export function createCharacterIterationSessionStore({ getSettings, persistSettings, avatar }) {
    if (typeof getSettings !== 'function') {
        throw new TypeError('createCharacterIterationSessionStore: getSettings must be a function');
    }
    if (typeof persistSettings !== 'function') {
        throw new TypeError('createCharacterIterationSessionStore: persistSettings must be a function');
    }
    if (!avatar) {
        throw new TypeError('createCharacterIterationSessionStore: avatar is required');
    }

    const scope = `char_${avatar}`;

    const inner = createExtensionSettingsSessionStorage({
        getBucket: () => {
            const settings = getSettings();
            if (!settings.popupSessionsV2 || typeof settings.popupSessionsV2 !== 'object') {
                settings.popupSessionsV2 = {};
            }
            if (!settings.popupSessionsV2[scope] || typeof settings.popupSessionsV2[scope] !== 'object') {
                settings.popupSessionsV2[scope] = {};
            }
            return settings.popupSessionsV2[scope];
        },
        persistSettings,
    });

    return {
        list: () => inner.listSessions(scope),
        load: (id) => inner.loadSession(scope, id),
        save: (session) => inner.saveSession(scope, session),
        delete: (id) => inner.deleteSession(scope, id),
        clearObsolete: async () => {
            const settings = getSettings();
            delete settings.lorebookSyncHistory;
            delete settings.popupSessions;
            persistSettings();
        },
    };
}
