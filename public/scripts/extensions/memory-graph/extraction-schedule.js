// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

/**
 * Pure helpers controlling per-type extraction cadence and prompt assembly.
 *
 * Lives outside main.js so unit tests can import without dragging the whole
 * SillyTavern script.js / lib.js runtime in. main.js re-exports the
 * symbols for the public API surface.
 */

export const DEFAULT_PER_TYPE_INSTRUCTIONS = {
    event: [
        'Event decision (event/event_table): create or skip, and why.',
        'Event strict policy: each extraction batch may create AT MOST ONE event node.',
        'If multiple sub-events happened in one batch, merge them into one coherent event summary instead of creating multiple event rows.',
        'If no meaningful event progression occurred, do not fabricate an event; explain the skip clearly.',
    ].join('\n'),
    character_sheet: [
        'Character decision (character_sheet/character_table): create/edit/delete/skip with evidence.',
        'Character consistency hard rule: for any mentioned character grounded by card/world-info baseline, if no character_sheet node exists, create one; if an existing character_sheet conflicts with baseline facts, emit edit to align it.',
        'Alias quality rule: when dialogue uses nicknames/short names/titles, fill aliases.',
    ].join('\n'),
    location_state: [
        'Location decision (location_state/location_table): create/edit/delete/skip with evidence.',
        'State quality rule: keep state/status fields updated when progression changes (e.g. ongoing/resolved/blocked).',
    ].join('\n'),
};

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

export function assembleExtractionSystemPrompt(basePrompt, schema, activeTypes) {
    const base = String(basePrompt || '').trim();
    const sections = [];
    const activeSet = activeTypes instanceof Set ? activeTypes : new Set();
    for (const entry of Array.isArray(schema) ? schema : []) {
        const typeId = String(entry?.id || '').trim().toLowerCase();
        if (!typeId || !activeSet.has(typeId)) continue;
        const instructions = String(entry?.extractionInstructions || '').trim();
        if (!instructions) continue;
        sections.push(`[${typeId}]\n${instructions}`);
    }
    if (sections.length === 0) return base;
    return `${base}\n\n=== Per-type extraction rules (active this round) ===\n\n${sections.join('\n\n')}`;
}
