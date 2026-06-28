// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

/**
 * Pure helpers controlling per-type extraction cadence and prompt assembly.
 *
 * Lives outside main.js so unit tests can import without dragging the whole
 * SillyTavern script.js / lib.js runtime in. main.js re-exports the
 * symbols for the public API surface.
 */

import { DEFAULT_PER_TYPE_INSTRUCTIONS as _DEFAULT_PER_TYPE_INSTRUCTIONS } from './default-prompts.js';

export const DEFAULT_PER_TYPE_INSTRUCTIONS = _DEFAULT_PER_TYPE_INSTRUCTIONS;

export function computeActiveExtractionTypes(schema, currentSeq) {
    const active = new Set();
    const seq = Math.max(0, Math.floor(Number.isFinite(Number(currentSeq)) ? Number(currentSeq) : 0));
    for (const entry of Array.isArray(schema) ? schema : []) {
        const typeId = String(entry?.id || '').trim().toLowerCase();
        if (!typeId) continue;
        const everyN = Math.max(1, Math.floor(Number(entry?.extractEveryN ?? 1)) || 1);
        if (seq % everyN === 0) {
            active.add(typeId);
        }
    }
    return active;
}

export function buildPerTypeRulesBlock(schema, activeTypes) {
    const sections = [];
    const activeSet = activeTypes instanceof Set ? activeTypes : new Set();
    for (const entry of Array.isArray(schema) ? schema : []) {
        const typeId = String(entry?.id || '').trim().toLowerCase();
        if (!typeId || !activeSet.has(typeId)) continue;
        const instructions = String(entry?.extractionInstructions || '').trim();
        if (!instructions) continue;
        sections.push(`[${typeId}]\n${instructions}`);
    }
    if (sections.length === 0) return '';
    return `=== Per-type extraction rules (active this round) ===\n\n${sections.join('\n\n')}`;
}

/**
 * Trivially returns the base prompt. Kept as a wrapper so existing callers
 * and the public API surface re-export don't churn; per-type rules are now
 * appended to the user prompt via {@link buildPerTypeRulesBlock} so the
 * system prompt remains byte-stable across cadence rounds (Anthropic
 * prompt-cache friendliness).
 *
 * @param {string} basePrompt
 * @returns {string}
 */
export function assembleExtractionSystemPrompt(basePrompt) {
    return String(basePrompt || '').trim();
}
