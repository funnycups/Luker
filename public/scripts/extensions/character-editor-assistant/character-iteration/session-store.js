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
