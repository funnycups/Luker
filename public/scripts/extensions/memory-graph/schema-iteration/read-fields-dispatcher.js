// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Memory Graph Schema — thin dispatcher for the iter-studio's
 * `mg_schema_read_fields` tool. Pure — no ST context, no jQuery, no
 * side effects. Wraps `readFieldsByPaths` against the live schema
 * array (an ordered list of node-type definitions).
 *
 * Path semantics: root is the schema ARRAY, so paths use lodash-style
 * numeric-index notation:
 *   - `[N].id`                   →  id of the Nth node type
 *   - `[N].tableColumns`         →  its columns array
 *   - `[N].tableColumns[K]`      →  Kth column name
 *   - `length`                   →  number of node types
 *
 * Sanitization boundary — CALL-OUT: MG schema currently has NO
 * per-mode sanitizer analogous to the orchestrator's `sanitizeLoopProfile`
 * / `sanitizeDirectorProfile` / etc. `state.live` is `normalizeNodeTypeSchema`'d
 * user-authored data — every field is meaningful and there is no
 * documented "scratch" / "debug" slot to strip. Consequently this
 * dispatcher passes the live schema through directly. If a future
 * change adds a debug slot to the schema shape, a caller-side
 * sanitizer must land before that slot ships (mirroring
 * orchestrator/iter-studio/read-fields-dispatcher.js's contract).
 *
 * Tested directly in tests/mg-schema-iteration/read-fields.test.js so
 * this module (and its shared helper) can be pinned without dragging
 * studio.js's ST-context / jQuery import graph into jest.
 */

import { readFieldsByPaths } from '../../../iteration-library/read-fields-helper.js';

/**
 * @param {object} params
 * @param {any[]} [params.liveSchema] — the current live schema array
 *        (each entry is a node-type definition). When omitted or falsy,
 *        the dispatcher treats it as an empty array (`length === 0`,
 *        every indexed path resolves to `missing_paths`).
 * @param {{paths?: any}} params.args — must contain a `paths` array of
 *        lodash-style path strings.
 * @returns {object} `{[path]: value|null|{__truncated__,length,preview,hint},
 *          missing_paths: string[]}` — throws `invalid_args` when
 *          `args.paths` is not an array (contract enforced by
 *          `readFieldsByPaths`).
 */
export async function dispatchMgSchemaReadFields({ liveSchema, args } = {}) {
    const root = Array.isArray(liveSchema) ? liveSchema : [];
    return readFieldsByPaths(root, args?.paths);
}
