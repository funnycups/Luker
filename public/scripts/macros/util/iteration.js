/**
 * Helpers for {{each}} block iteration.
 *
 * Kept pure so they can be node-tested without the macro runtime.
 */

import { resolveVarPath } from './var-path.js';

/**
 * Try to parse a string as a JSON object or array.
 *
 * Only returns the parsed value when it's a non-null object (which covers
 * arrays). Returns `null` when the string isn't a JSON object/array literal
 * — including for plain numeric strings like "42", which JSON.parse would
 * accept but aren't useful as iteration containers.
 *
 * @param {string} text
 * @returns {object|null} The parsed object/array or null.
 */
export function tryParseJsonContainer(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    // Cheap shape check before we pay for JSON.parse — avoids accepting
    // plain numbers / booleans / strings as containers.
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
    try {
        const parsed = JSON.parse(trimmed);
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Coerce an arbitrary value into a usable iteration container, or null.
 *
 * - Live objects/arrays pass through.
 * - Strings are parsed via {@link tryParseJsonContainer}.
 * - Anything else (numbers, undefined, booleans) yields null.
 *
 * @param {unknown} value
 * @returns {object|null}
 */
export function coerceContainer(value) {
    if (value && typeof value === 'object') return /** @type {object} */ (value);
    if (typeof value === 'string') return tryParseJsonContainer(value);
    return null;
}

/**
 * Resolve an each-collection reference to a usable container.
 *
 * Resolution order:
 *   1. JSON literal — `{...}` / `[...]` parses directly.
 *   2. Local variable lookup (with dotted-path support via resolveVarPath).
 *   3. Global variable lookup (same).
 *
 * Returns `null` if no path produces an iterable object.
 *
 * @param {string} ref - The (already macro-resolved) reference string.
 * @param {{ local: (name: string) => any, global: (name: string) => any }} getters
 * @returns {object|null}
 */
export function resolveEachContainer(ref, getters) {
    if (typeof ref !== 'string' || !ref.trim()) return null;
    const trimmed = ref.trim();

    const direct = tryParseJsonContainer(trimmed);
    if (direct !== null) return direct;

    const fromLocal = resolveVarPath(getters.local, trimmed);
    const local = coerceContainer(fromLocal);
    if (local !== null) return local;

    const fromGlobal = resolveVarPath(getters.global, trimmed);
    return coerceContainer(fromGlobal);
}

/**
 * Walk a dotted path into a value (no JSON parsing — the caller has already
 * produced a live object). Used by `{{loop_value::path}}` so that authors
 * can drill into the current iteration value without going back through
 * the variable store.
 *
 * @param {unknown} value - The current iteration value (object, array, primitive).
 * @param {string} path - Dotted path. Empty path returns the value itself.
 * @returns {unknown} The value at the path, or undefined.
 */
export function walkLoopValuePath(value, path) {
    if (!path) return value;
    if (value == null) return undefined;
    const parts = String(path).split('.');
    let cur = value;
    for (const k of parts) {
        if (cur == null) return undefined;
        cur = cur[k];
    }
    return cur;
}
