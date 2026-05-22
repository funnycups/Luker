/**
 * iteration-library — session storage factories.
 *
 * Each plugin (orchestrator / memory-graph / CEA / CPA) used to inline the
 * same four-method storage pattern (listSessions / loadSession / saveSession
 * / deleteSession) against extension_settings. This factory captures the
 * shape so future plugin-owned popups can wire storage in three lines
 * instead of forty.
 *
 * Stage 1 does NOT migrate existing adapters — they keep their inline
 * implementations until each plugin's UI redo (Stages 2–5). This factory
 * is here for the new code paths the redos introduce.
 *
 * `getBucket(scope)` is the plugin's accessor that returns the mutable
 * object holding `{ [sessionId]: session }`. It must:
 *   - lazy-create the bucket if missing (do not return null/undefined)
 *   - return the SAME reference every call (mutations are persisted by
 *     `persistSettings()`, not by re-assigning the bucket)
 *
 * `persistSettings()` is whatever the plugin uses to flush extension_settings
 * (`saveSettingsDebounced` from the host, typically).
 */

export function createExtensionSettingsSessionStorage({ getBucket, persistSettings }) {
    if (typeof getBucket !== 'function') {
        throw new TypeError('createExtensionSettingsSessionStorage: getBucket must be a function');
    }
    if (typeof persistSettings !== 'function') {
        throw new TypeError('createExtensionSettingsSessionStorage: persistSettings must be a function');
    }

    return {
        listSessions: async (scope) => {
            const bucket = getBucket(scope);
            return Object.values(bucket)
                .filter(s => s && typeof s === 'object' && s.id)
                .map(s => ({
                    id: String(s.id),
                    title: String(s.title || s.id),
                    updatedAt: Number(s.updatedAt || 0),
                }))
                .sort((a, b) => b.updatedAt - a.updatedAt);
        },
        loadSession: async (scope, id) => {
            const bucket = getBucket(scope);
            const stored = bucket[String(id)];
            return stored ? structuredClone(stored) : null;
        },
        saveSession: async (scope, session) => {
            if (!session?.id) return;
            const bucket = getBucket(scope);
            bucket[String(session.id)] = structuredClone(session);
            persistSettings();
        },
        deleteSession: async (scope, id) => {
            const bucket = getBucket(scope);
            delete bucket[String(id)];
            persistSettings();
        },
    };
}
