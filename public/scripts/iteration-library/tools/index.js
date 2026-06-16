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
 *   - skill-iter-studio.js — skill management tool catalog (inventory +
 *     authoring proposals + policy binding + migration helpers). Used by
 *     the orchestrator iter-studio and by CPA's preset iteration studio;
 *     authoring tools return `pendingSkillEdit` blobs the popups park for
 *     per-card user review and commit at Apply time.
 */

export * as lorebookReads from './lorebook-reads.js';
export * as lorebookWrites from './lorebook-writes.js';
export * as skillIterStudio from './skill-iter-studio.js';
