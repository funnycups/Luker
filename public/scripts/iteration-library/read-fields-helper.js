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
 * `invalid_args`. Empty strings inside paths are reported in
 * `missing_paths`. Unknown paths (lodash resolves to `undefined`)
 * return `null` at their key and append to `missing_paths`.
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
        const p = String(path || '');
        if (!p) {
            out.missing_paths.push(p);
            out[p] = null;
            continue;
        }
        const value = _basicLodashGet(root, p);
        if (value === undefined) {
            out[p] = null;
            out.missing_paths.push(p);
            continue;
        }
        let serializedLen = 0;
        try { serializedLen = JSON.stringify(value).length; } catch { serializedLen = 0; }
        if (serializedLen > TRUNCATE_AT) {
            const previewSource = typeof value === 'string' ? value : JSON.stringify(value);
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
