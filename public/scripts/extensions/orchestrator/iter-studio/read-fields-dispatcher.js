// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Thin dispatcher for the orchestrator iter-studio's per-mode
 * `luker_orch_read_<director|loop|agenda|spec>_fields` tools. Pure — no
 * ST context, no jQuery, no side effects. Wraps `readFieldsByPaths`
 * against a *pre-sanitized* per-mode working profile.
 *
 * Why pre-sanitized: the plan interface (Task 2, contract line 33)
 * specified `_.get(sanitizedWorkingProfile, path)`. Working profiles
 * happen to be sanitized on every mutation today, but nothing
 * guarantees a future scratch field / debug-only slot won't leak
 * straight into the LLM's response envelope. Mode-aware sanitization
 * is the executor's responsibility (director / loop / agenda / spec
 * each have a different sanitizer + a different "safe" surface), so
 * the dispatcher can't do it in one line here — the executor call
 * site pre-sanitizes and passes the result in.
 *
 * Tested directly in tests/orch-iteration/read-fields.test.js so this
 * module (and its shared helper) can be pinned without dragging main.js's
 * huge import graph into jest.
 */

import { readFieldsByPaths } from '../../../iteration-library/read-fields-helper.js';

/**
 * @param {object} params
 * @param {object} params.sanitizedProfile — the mode-specific working
 *        profile AFTER passing through its sanitizer
 *        (`sanitizeDirectorProfile` / `sanitizeLoopProfile` /
 *        `sanitizeAgendaWorkingProfile` / `sanitizeSpec`). The
 *        dispatcher does NOT re-sanitize; the caller owns that step
 *        because only the executor knows the session's mode.
 * @param {{paths?: any}} params.args — must contain a `paths` array of
 *        lodash-style path strings.
 * @returns {object} `{[path]: value|null, missing_paths: string[]}` —
 *          throws `invalid_args` when
 *          `args.paths` is not an array (contract enforced by
 *          `readFieldsByPaths`).
 */
export async function dispatchReadFields({ sanitizedProfile, args }) {
    return readFieldsByPaths(sanitizedProfile || {}, args?.paths);
}
