// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Shared read helpers for iter-studio "read the live working profile"
 * tools. Two variants live here:
 *
 *   - `readFieldsByPaths(root, paths)` — lodash-path variant. Consumed
 *     by orchestrator iter-studio's `luker_orch_read_<mode>_fields`
 *     handlers and by memory-graph's schema-mode equivalent. `paths`
 *     is a string[] of lodash-style path expressions (`agent.name`,
 *     `[0].tableColumns[1]`, `length`, …). Arbitrary nesting.
 *
 *   - `readFieldsByEnum(root, fields, whitelist)` — enum-field variant.
 *     Consumed by the CEA card iter-studio's `cea_read_card_fields`
 *     handler. `fields` is a string[] of TOP-LEVEL field names, each of
 *     which MUST appear in `whitelist`. Deliberately does NOT descend:
 *     `character.extensions` has dedicated tools (`world_book_list`,
 *     `regex_list_scripts`, …) and must stay off-limits here.
 *
 * Both variants share `truncateForRead(value)` for the 5KB envelope
 * contract: values whose JSON-stringify exceeds 5KB become
 * `{__truncated__, length, preview, hint}` so the AI narrows to a
 * subfield instead of trying to consume the whole payload in one round.
 * If JSON.stringify throws (circular reference, BigInt, throwing
 * `toJSON`, …), both variants return the same envelope with
 * `preview: '(unserializable)'` so the downstream tool_result serializer
 * doesn't blow up on JSON.stringify a second time.
 *
 * Invalid_args contract (both variants):
 *   - non-array `paths` / `fields` throws `invalid_args`.
 *   - path variant: non-string / empty-string entries silently skipped
 *     (they carry no addressable target; reporting them under
 *     `missing_paths` gives the AI no actionable retry).
 *   - enum variant: non-string entries AND non-whitelisted names throw
 *     `invalid_args` fail-closed BEFORE any read — the read surface is
 *     small and the whitelist enforcement is the tool's core promise.
 */

const TRUNCATE_AT = 5 * 1024;

function _basicLodashGet(obj, path) {
    if (obj == null || !path) return undefined;
    const parts = String(path).split(/[.[\]]/).filter(Boolean);
    let cur = obj;
    for (const key of parts) {
        if (cur == null) return undefined;
        cur = cur[key];
    }
    return cur;
}

/**
 * Truncate one field's value into the shared 5KB envelope shape used by
 * every iter-studio read tool. Returns:
 *   - `{ take: 'raw', value }` when the value is small enough — the
 *     caller stores `value` under the field's key directly.
 *   - `{ take: 'envelope', envelope }` when the value's JSON exceeds
 *     5KB or JSON-stringify throws (circular, BigInt, throwing toJSON) —
 *     the caller stores `envelope` under the field's key so downstream
 *     `tool_result` serialization can't blow up on a second stringify.
 *
 * Extracted so `readFieldsByPaths` (lodash-path variant) and
 * `readFieldsByEnum` (whitelisted-flat-field variant) share the exact
 * same truncation semantics. Changing the byte budget here changes it
 * for every iter-studio read tool at once.
 */
export function truncateForRead(value) {
    let serialized = null;
    let serializedLen = 0;
    try {
        serialized = JSON.stringify(value);
        serializedLen = serialized == null ? 0 : serialized.length;
    } catch {
        return {
            take: 'envelope',
            envelope: {
                __truncated__: true,
                length: 0,
                preview: '(unserializable)',
                hint: 'value could not be JSON-serialized (circular reference or non-serializable type)',
            },
        };
    }
    if (serializedLen > TRUNCATE_AT) {
        const previewSource = typeof value === 'string' ? value : (serialized ?? '');
        return {
            take: 'envelope',
            envelope: {
                __truncated__: true,
                length: previewSource.length,
                preview: previewSource.slice(0, 200),
                hint: 'value exceeds 5KB, narrow to specific subfield',
            },
        };
    }
    return { take: 'raw', value };
}

export function readFieldsByPaths(root, paths) {
    if (!Array.isArray(paths)) {
        throw new Error('invalid_args: paths must be an array of lodash-style path strings.');
    }
    const out = { missing_paths: [] };
    for (const path of paths) {
        // Skip non-string / empty entries silently instead of polluting
        // the response with `out[''] = null`. A caller that hands us `''`
        // has no valid target — reporting it under `missing_paths` gives
        // the AI no actionable path to retry with and clutters every
        // batch that happens to include a trailing comma.
        if (typeof path !== 'string' || path === '') continue;
        const p = path;
        const value = _basicLodashGet(root, p);
        if (value === undefined) {
            out[p] = null;
            out.missing_paths.push(p);
            continue;
        }
        const trunc = truncateForRead(value);
        out[p] = trunc.take === 'envelope' ? trunc.envelope : trunc.value;
    }
    return out;
}

/**
 * Enum-field read helper — the CEA card iter-studio variant. Unlike
 * `readFieldsByPaths` (lodash-path, arbitrary nesting), this walks a
 * FIXED WHITELIST of top-level field names and never descends into
 * sub-objects. Used when the reading surface is deliberately narrow —
 * the CEA card, for example, hides `character.extensions` behind
 * dedicated tools (`world_book_list`, `regex_list_scripts`, …) so the
 * read tool must NOT expose it even if the AI names it.
 *
 * Contract:
 *   - `fields` MUST be a string[]. Any other shape throws `invalid_args`.
 *   - Every entry MUST be a member of `whitelist`. Any deviation throws
 *     `invalid_args` before ANY value is read (fail-closed).
 *   - Non-string entries inside the array (e.g. `42`, `null`) throw
 *     `invalid_args` — silently coercing them (as `readFieldsByPaths`
 *     does for empty strings) would hide LLM protocol drift under the
 *     rug. The read surface is small enough that a bad entry is
 *     actionable feedback.
 *   - Requested-but-unset fields (whitelisted, but the object holds
 *     `undefined`) return `null` at their key AND land in
 *     `missing_fields`, mirroring `readFieldsByPaths`' `missing_paths`
 *     convention so the AI has one uniform "I asked but got nothing"
 *     signal across studios. Empty-string / empty-array / `0` are NOT
 *     missing — those are legitimate concrete values the AI must be
 *     able to observe (an empty `system_prompt` is different from an
 *     unset one only for author intent, but the AI's read tool need
 *     not care about that distinction).
 *   - Values > 5KB get the same truncation envelope as
 *     `readFieldsByPaths` (via `truncateForRead`).
 *   - The response object's own key set is `fields[]` + `missing_fields`
 *     and NOTHING else. Even if `whitelist` grew to include a new
 *     sensitive-looking name, only fields the caller EXPLICITLY
 *     requested get projected onto the response — defense in depth
 *     against a future refactor that widens the whitelist without
 *     updating the response construction.
 *
 * @param {object} root       — the source object to read (`character` in CEA).
 * @param {any}    fields     — MUST be a string[]; validated.
 * @param {readonly string[]} whitelist — legal field names (typically a frozen enum).
 * @returns {object} `{[field]: value|null|envelope, missing_fields: string[]}`
 */
export function readFieldsByEnum(root, fields, whitelist) {
    if (!Array.isArray(fields)) {
        throw new Error('invalid_args: fields must be an array of strings.');
    }
    if (!Array.isArray(whitelist)) {
        throw new Error('invalid_args: whitelist must be an array of strings (programmer error).');
    }
    const allowed = new Set(whitelist.map((s) => String(s)));
    // Fail-closed validation BEFORE reading anything: bad entries and
    // non-whitelisted names both throw before the response object is
    // constructed. This keeps the response's own key set free of any
    // field the AI shouldn't see (belt-and-suspenders against a future
    // refactor that adds a `missing_fields.push(name)` on invalid).
    const invalid = [];
    for (const f of fields) {
        if (typeof f !== 'string') {
            invalid.push(String(f));
            continue;
        }
        if (!allowed.has(f)) invalid.push(f);
    }
    if (invalid.length > 0) {
        const allowedList = Array.from(allowed).join(', ');
        throw new Error(
            `invalid_args: unknown field(s) [${invalid.join(', ')}] not in whitelist. Allowed: [${allowedList}].`,
        );
    }
    const source = (root && typeof root === 'object') ? root : {};
    const out = { missing_fields: [] };
    for (const field of fields) {
        // Only project explicitly-requested keys onto the response —
        // never fall through to `for (const k of whitelist)`, even if
        // whitelist ⊂ requested.
        if (!Object.prototype.hasOwnProperty.call(source, field) || source[field] === undefined) {
            out[field] = null;
            out.missing_fields.push(field);
            continue;
        }
        const value = source[field];
        const trunc = truncateForRead(value);
        out[field] = trunc.take === 'envelope' ? trunc.envelope : trunc.value;
    }
    return out;
}
