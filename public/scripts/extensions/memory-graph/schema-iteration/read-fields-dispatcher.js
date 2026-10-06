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
 * Sanitization boundary — CALL-OUT: `state.live` is
 * `normalizeNodeTypeSchema`'d user-authored data. The normalizer emits a
 * superset of the editable surface (e.g. `compression.rule`, `ragPerTypeK`,
 * `recordsFloorRange`), and the set tool's JSON schema rejects those via
 * `additionalProperties: false`. Surfacing them here would hand the AI
 * fields it cannot write back, so every entry is projected onto the set
 * tool's writable surface (`projectNodeTypeForRead`) before reading. This
 * keeps read ⊆ write by construction; a future normalizer field is dropped
 * automatically unless it is also added to `nodeTypeSchemaParams()`.
 *
 * Tested directly in tests/mg-schema-iteration/read-fields.test.js so
 * this module (and its shared helper) can be pinned without dragging
 * studio.js's ST-context / jQuery import graph into jest.
 */

import { readFieldsByPaths } from '../../../iteration-library/read-fields-helper.js';
import { projectNodeTypeForRead } from './tools.js';

/**
 * @param {object} params
 * @param {any[]} [params.liveSchema] — the current live schema array
 *        (each entry is a node-type definition). When omitted or falsy,
 *        the dispatcher treats it as an empty array (`length === 0`,
 *        every indexed path resolves to `missing_paths`).
 * @param {{paths?: any}} params.args — must contain a `paths` array of
 *        lodash-style path strings.
 * @returns {object} `{[path]: value|null, missing_paths: string[]}` —
 *          throws `invalid_args` when
 *          `args.paths` is not an array (contract enforced by
 *          `readFieldsByPaths`).
 */
export async function dispatchMgSchemaReadFields({ liveSchema, args } = {}) {
    const root = Array.isArray(liveSchema) ? liveSchema : [];
    return readFieldsByPaths(root.map(projectNodeTypeForRead), args?.paths);
}
