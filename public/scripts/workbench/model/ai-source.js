// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Resolve which value a workbench AI field actually uses and where it came
// from. The order matches the request path: per-target override, the plugin's
// own iteration AI, the shared workbench value, then the implicit fallback.

const SCOPES = new Set(['target', 'plugin', 'shared', 'current']);

/**
 * @param {{ own?: string, native?: string, shared?: string,
 *   fallback?: { scope: 'target'|'plugin'|'shared'|'current', value?: string, implicit?: boolean } | null }} opts
 * @returns {{ scope: 'target'|'plugin'|'shared'|'current', value: string, implicit?: boolean } | null}
 */
export function resolveAiField({ own = '', native = '', shared = '', fallback = null } = {}) {
    const value = (raw) => String(raw || '').trim();
    if (value(own)) return { scope: 'target', value: value(own) };
    if (value(native)) return { scope: 'plugin', value: value(native) };
    if (value(shared)) return { scope: 'shared', value: value(shared) };
    if (fallback && SCOPES.has(fallback.scope)) {
        return {
            scope: fallback.scope,
            value: value(fallback.value),
            ...(fallback.implicit ? { implicit: true } : {}),
        };
    }
    return null;
}

/** Resolve both fields of one target row. */
export function resolveAiRow({ own = {}, native = {}, shared = {}, fallbackConnection = null, fallbackPreset = null } = {}) {
    return {
        connection: resolveAiField({
            own: own.connection,
            native: native.connection,
            shared: shared.connection,
            fallback: fallbackConnection,
        }),
        preset: resolveAiField({
            own: own.preset,
            native: native.preset,
            shared: shared.preset,
            fallback: fallbackPreset,
        }),
    };
}
