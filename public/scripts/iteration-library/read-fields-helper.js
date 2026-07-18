// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Shared read-by-lodash-path helper for iter-studio "read the live
 * working profile" tools. Consumed by orchestrator iter-studio's
 * `luker_orch_read_<mode>_fields` handlers (and by memory-graph's
 * schema-mode equivalent). Pure — never mutates its inputs.
 *
 * Truncation contract: values whose JSON-stringify exceeds 5KB are
 * replaced with a `{__truncated__, length, preview, hint}` envelope so
 * the AI knows to narrow to a subfield instead of trying to consume the
 * whole payload in one round.
 *
 * Invalid_args contract: `paths` MUST be an array; anything else throws
 * `invalid_args`. Non-string / empty-string entries inside the array
 * are silently skipped (they carry no addressable target — reporting
 * them under `missing_paths` gives the AI no actionable retry path and
 * only clutters the response). Unknown paths (lodash resolves to
 * `undefined`) return `null` at their key and append to `missing_paths`.
 *
 * Unserializable-value contract: if `JSON.stringify(value)` throws
 * (circular reference, BigInt, throwing `toJSON`, etc.), the field
 * returns the truncation envelope with `preview: '(unserializable)'`
 * so the downstream tool_result serializer doesn't blow up on
 * JSON.stringify a second time.
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
        let serializedLen = 0;
        let serialized = null;
        try {
            serialized = JSON.stringify(value);
            serializedLen = serialized == null ? 0 : serialized.length;
        } catch {
            // JSON.stringify threw (circular reference, BigInt, throwing
            // toJSON, etc). Return the truncation envelope with an
            // explicit "unserializable" preview so the downstream
            // tool_result serializer doesn't blow up on JSON.stringify a
            // second time. Without this, the raw value would fall
            // through the untruncated branch and re-throw when the
            // executor wrapped its result for the LLM.
            out[p] = {
                __truncated__: true,
                length: 0,
                preview: '(unserializable)',
                hint: 'value could not be JSON-serialized (circular reference or non-serializable type)',
            };
            continue;
        }
        if (serializedLen > TRUNCATE_AT) {
            const previewSource = typeof value === 'string' ? value : (serialized ?? '');
            out[p] = {
                __truncated__: true,
                length: previewSource.length,
                preview: previewSource.slice(0, 200),
                hint: 'value exceeds 5KB, narrow to specific subfield',
            };
        } else {
            out[p] = value;
        }
    }
    return out;
}
