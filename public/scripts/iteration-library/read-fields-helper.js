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
 * Both variants call `truncateForRead(value)` only to guard against a
 * value that cannot be JSON-serialized (circular reference, throwing
 * `toJSON`, BigInt, …). In that case the caller stores an
 * `{__truncated__, length: 0, preview: '(unserializable)', hint}`
 * envelope under the field's key so the downstream `tool_result`
 * serializer doesn't blow up on JSON.stringify a second time.
 *
 * Size-based truncation is intentionally NOT applied. An earlier
 * revision capped values at 5 KB and returned a 200-char preview
 * envelope with `hint: 'value exceeds 5KB, narrow to specific subfield'`.
 * That cap was pulled from thin air (no downstream context-window /
 * transport / storage requirement forced it) and produced a
 * pathological failure mode: an AI that read a >5 KB `systemPrompt`
 * for anchor-based patching only ever saw the 200-char preview, so
 * every `str_replace` anchor missed, every re-read returned the same
 * preview, and the loop wedged. Strings have no "subfield" the AI
 * could narrow to. The read tool is already a NARROW contract — the
 * caller names the exact path(s) it wants — and it is the caller's
 * judgement, not this helper's, whether to read one big field or
 * several small ones. See `.opencode/memory/feedback_no_arbitrary_max_limits.md`
 * for the general rule this violated.
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
 * Wrap one field's value for placement in an iter-studio read tool's
 * response object. Returns:
 *   - `{ take: 'raw', value }` — the caller stores `value` directly.
 *     This is the normal path. There is NO size-based truncation:
 *     read tools are narrow contracts (caller names the exact path)
 *     and it is the CALLER's judgement, not this helper's, whether
 *     a given path is too big to read.
 *   - `{ take: 'envelope', envelope }` — only when `JSON.stringify`
 *     throws (circular reference, BigInt, throwing `toJSON`). The
 *     envelope keeps downstream `tool_result` serialization from
 *     blowing up on a second stringify. Shape:
 *     `{__truncated__: true, length: 0, preview: '(unserializable)', hint}`.
 *
 * Shared by `readFieldsByPaths` and `readFieldsByEnum` so the
 * unserializable-guard behaviour is identical across studios.
 */
export function truncateForRead(value) {
    try {
        JSON.stringify(value);
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
 *   - Values that cannot be JSON-serialized get an unserializable
 *     envelope via `truncateForRead` (defense against a downstream
 *     `JSON.stringify` throwing on the response). Size-based
 *     truncation is intentionally absent — see the file header for
 *     the rationale.
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
