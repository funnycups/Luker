// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Thin dispatcher for the orchestrator iter-studio's per-mode
 * `luker_orch_read_<director|loop|agenda|spec>_fields` tools. Pure — no
 * ST context, no jQuery, no side effects. Wraps `readFieldsByPaths`
 * against the session's mode-specific working profile.
 *
 * Tested directly in tests/orch-iteration/read-fields.test.js so this
 * module (and its shared helper) can be pinned without dragging main.js's
 * huge import graph into jest.
 */

import { readFieldsByPaths } from '../../../iteration-library/read-fields-helper.js';

/**
 * @param {object} params
 * @param {{workingProfile?: object}} params.session — the iter session; the
 *        mode-specific working profile is the read root.
 * @param {{paths?: any}} params.args — must contain a `paths` array of
 *        lodash-style path strings.
 * @returns {object} `{[path]: value|null|{__truncated__,length,preview,hint},
 *          missing_paths: string[]}` — throws `invalid_args` when
 *          `args.paths` is not an array (contract enforced by
 *          `readFieldsByPaths`).
 */
export async function dispatchReadFields({ session, args }) {
    return readFieldsByPaths(session?.workingProfile || {}, args?.paths);
}
