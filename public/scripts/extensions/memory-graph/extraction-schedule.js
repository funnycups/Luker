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
        'Event decision: MANDATORY — exactly ONE event node per batch. Even routine turns (路过/休整/闲聊/单次场景) produce a one-line event; compression\'s KEEP/FOLD/DROP filter handles noise at rollup.',
        'If multiple sub-events happened, merge into one coherent summary.',
        'High-consequence events (契约/誓言/婚约/师徒关系 建立或破裂、不可逆物理状态变化、长期身份/立场变更、新角色登场并被命名、新地点建立长期 controller、获得/转让重要物品) get full causal detail.',
        'Routine events (单次场景姿态/当前心情/临时性服务关系/对话氛围/被某 KEEP 包含的子动作) get a brief one-line summary so the timeline is continuous; their detail will be dropped at compression.',
        'Summary must start with "时间：<具体时间>；" using complete in-world date/time and follow the event style standard.',
        'Never copy quoted dialogue verbatim into summary — paraphrase to action description.',
    ].join('\n'),
    character_sheet: [
        'Character decision: SKIP unless the character\'s long-term traits/identity/goal/aliases changed in this batch.',
        'Character consistency rule: if a character is grounded by card/world-info baseline and no character_sheet exists for them, create one. If an existing sheet conflicts with baseline, emit edit to align.',
        'Alias quality: when dialogue uses nicknames/short names/titles, fill aliases.',
        'language_sample edit rule: existing samples are scene templates. Scan before editing. Only rewrite the whole sample group on identity/stance reversal (faction switch, brainwashing, awakening, long-term role transition). A new scene materially different from all logged ones can ADD (cap at 3 total); already-logged scene samples are not rewritten to match the current scene\'s mood.',
        'Single-scene tone shifts, intimate-mode dialogue, situational politeness = SKIP for language_sample.',
        'identity rule: long-term identity only. Temporary roles (服侍员, 临时随从, 患者) = SKIP.',
    ].join('\n'),
    location_state: [
        'Location decision: SKIP unless controller / danger / resources changed in this batch.',
        '"Entering a new location" alone = SKIP — that\'s event territory. Only create / edit when the location\'s long-term properties shifted.',
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
