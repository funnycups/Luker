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
 *   - ctx-and-docs-discovery.js — pure async executors for ctx
 *     introspection (listCtxKeys / describeCtxPath) and Luker doc lookup
 *     (listLukerDocs / readLukerDoc). Used by CardApp Studio AI chat and
 *     the orchestrator iter-studio. Callers pick their own tool names +
 *     JSON-Schemas around these executors.
 *   - character-presets-reads.js — `inspect_bound_preset` read tool that
 *     lets iter popups (orchestrator iter-studio, CEA editor) enumerate
 *     or fetch presets embedded on the active character card. Delegates
 *     to the Task 2 ctx surface `context.character.presets.*`.
 */

export * as lorebookReads from './lorebook-reads.js';
export * as lorebookWrites from './lorebook-writes.js';
export * as skillIterStudio from './skill-iter-studio.js';
export * as ctxAndDocsDiscovery from './ctx-and-docs-discovery.js';
export * as characterPresetsReads from './character-presets-reads.js';
