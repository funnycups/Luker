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
 */

export * as lorebookReads from './lorebook-reads.js';
