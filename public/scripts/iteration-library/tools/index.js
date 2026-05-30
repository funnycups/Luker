// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * iteration-library/tools — shared tool catalogs / executors that multiple
 * iter popups consume.
 *
 * Currently:
 *   - lorebook-reads.js — lorebook discovery + retrieval tools used by the
 *     orchestrator iter-studio and the memory-graph schema iter (and any
 *     future iter popup that needs the AI to read world-book content).
 *   - lorebook-writes.js — lorebook entry edit tools (update + str_replace)
 *     used by popups that need the AI to adjust the active character's
 *     world books while iterating (e.g. orchestrator iter-studio reconciling
 *     output-format constraints across preset and lorebook).
 */

export * as lorebookReads from './lorebook-reads.js';
export * as lorebookWrites from './lorebook-writes.js';
