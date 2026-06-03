// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * iter-studio system prompt augmentation: skills catalog + extraction
 * discipline.
 *
 * Plan 2 Unit 7. The iter-studio AI now has 15 skill-management tools. This
 * module appends a fixed "discipline" block plus a dynamic catalog of
 * currently-visible skills to the iter-studio system prompt at the start of
 * each turn. The catalog uses `resolveAgentVisibleSkills` from Plan 1
 * Unit 6 to compute mode-level visibility against the live profile, then
 * lists each skill as `name: description`.
 *
 * The block is appended ONLY when the working profile has at least one
 * agent whose systemPrompt exceeds the heuristic threshold OR the
 * profile has at least one visible skill — otherwise the augmentation is
 * pure noise. (An empty-skill + short-prompt profile means the user
 * hasn't installed anything yet and there's nothing to extract.)
 *
 * The "intensity preservation" warning is the load-bearing piece for the
 * migration helpers (skill_propose_extraction → skill_extract_from_text →
 * skill_replace_in_systemprompt). Without it, the iter-studio AI defaults
 * to summarizing as it extracts, which silently reduces prompt strength.
 *
 * Pure module — no orchestrator state held. studio.js owns the call site:
 * one invocation per turn inside runIterationTurn, threading the helper
 * session's working profile.
 */

import { resolveAgentVisibleSkills } from './skill-resolution.js';

export const LONG_PROMPT_HEURISTIC_CHARS = 1000;

function* walkAgentSystemPrompts(profile) {
    if (!profile || typeof profile !== 'object') return;
    if (profile.mainAgent && typeof profile.mainAgent === 'object') {
        yield { agentId: 'main', systemPrompt: String(profile.mainAgent.systemPrompt || '') };
    }
    if (Array.isArray(profile.subAgents)) {
        for (const a of profile.subAgents) {
            if (!a) continue;
            yield { agentId: String(a.id || ''), systemPrompt: String(a.systemPrompt || '') };
        }
    }
    if (profile.agents && typeof profile.agents === 'object' && !Array.isArray(profile.agents)) {
        for (const [id, a] of Object.entries(profile.agents)) {
            if (!a || typeof a !== 'object') continue;
            yield { agentId: id, systemPrompt: String(a.systemPrompt || '') };
        }
    }
    if (typeof profile.system_prompt === 'string') {
        yield { agentId: 'loop', systemPrompt: profile.system_prompt };
    }
    if (profile.presets && typeof profile.presets === 'object') {
        for (const [id, p] of Object.entries(profile.presets)) {
            if (!p || typeof p !== 'object') continue;
            if (typeof p.systemPrompt === 'string') {
                yield { agentId: id, systemPrompt: p.systemPrompt };
            }
        }
    }
}

/**
 * Detect whether the working profile has any agent whose systemPrompt
 * exceeds the long-prompt heuristic threshold. Used to decide whether to
 * append the extraction discipline block.
 *
 * Exported for unit tests.
 *
 * @param {object} profile
 * @param {{minChars?: number}} [opts]
 * @returns {Array<{agentId: string, length: number}>}
 */
export function detectLongSystemPromptAgents(profile, opts = {}) {
    const min = Number.isFinite(opts.minChars) ? opts.minChars : LONG_PROMPT_HEURISTIC_CHARS;
    const out = [];
    for (const { agentId, systemPrompt } of walkAgentSystemPrompts(profile)) {
        if (systemPrompt.length >= min) out.push({ agentId, length: systemPrompt.length });
    }
    return out;
}

/**
 * Format the discipline + catalog block as plain text. Pure — no I/O. The
 * `visibleSkills` argument is the resolver's output (SkillIndexEntry[]).
 *
 * Exported for unit tests; the live call site in studio.js wires it through
 * augmentIterStudioPromptWithSkills below.
 *
 * @param {Array<{name: string, description: string}>} visibleSkills
 * @param {Array<{agentId: string, length: number}>} longAgents
 * @returns {string}
 */
export function formatSkillsAugmentation(visibleSkills, longAgents) {
    const lines = [];
    lines.push('## Skill management (iter-studio extension)');
    lines.push('');
    if (longAgents.length > 0) {
        const labels = longAgents
            .map(a => `${a.agentId} (${a.length} chars)`)
            .join(', ');
        lines.push(`Current orchestrator profile has agent systemPrompts that may benefit from skill extraction: ${labels}.`);
    } else {
        lines.push('Current orchestrator profile has no agents with long systemPrompts — extraction is unlikely to be needed this turn.');
    }
    lines.push('');
    lines.push('Discipline for skill manipulation:');
    lines.push('1. Adding reusable rules → prefer creating a skill via `skill_create`. Do not bloat systemPrompt.');
    lines.push('2. Modifying rules → prefer modifying the skill (`skill_update_content` / `skill_edit_content`), not the systemPrompt.');
    lines.push('3. Migrating long systemPrompts → use `skill_propose_extraction` → `skill_extract_from_text` → `skill_replace_in_systemprompt`.');
    lines.push('   ⚠ Do NOT reduce prompt intensity during migration. Content must be VERBATIM, not paraphrased or compressed. If the original text says "你必须" three times, the extracted skill must say "你必须" three times — preserve repetition, emphasis, and original wording.');
    lines.push('');
    lines.push('Currently visible skills for this profile:');
    const named = (visibleSkills || []).filter(s => s && typeof s.name === 'string');
    if (named.length === 0) {
        lines.push('- (none installed for this profile)');
    } else {
        for (const s of named) {
            lines.push(`- ${s.name}: ${String(s.description || '')}`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * Augment the iter-studio system prompt with the skills catalog + discipline
 * block. Returns the base prompt unchanged when neither long systemPrompts
 * nor visible skills are present (no value in appending the block).
 *
 * The catalog is computed via `resolveAgentVisibleSkills` against the mode
 * profile (no agentConfig — we want the mode-level visibility set, not a
 * specific agent's narrowed view, since the iter-studio AI may bind skills
 * to any agent).
 *
 * @param {string} basePrompt
 * @param {object} workingProfile - mode profile being edited
 * @param {object} runtimeContext - { presetApiId?, presetName?, characterFile? }
 * @param {{
 *   resolveVisibleSkills?: (args: object) => Promise<Array>,
 *   minChars?: number,
 * }} [opts] - test seam; default uses resolveAgentVisibleSkills from skill-resolution.js
 * @returns {Promise<string>}
 */
export async function augmentIterStudioPromptWithSkills(
    basePrompt,
    workingProfile,
    runtimeContext = {},
    opts = {},
) {
    const longAgents = detectLongSystemPromptAgents(workingProfile, opts);
    const resolver = typeof opts.resolveVisibleSkills === 'function'
        ? opts.resolveVisibleSkills
        : resolveAgentVisibleSkills;
    let visibleSkills = [];
    try {
        visibleSkills = await resolver({
            modeProfile: workingProfile,
            agentConfig: null,
            runtimeContext: runtimeContext || {},
        });
    } catch (e) {
        // Failing closed (empty list) is correct — the augmentation
        // would otherwise lie about what's available. Log so a broken
        // inventory call shows up in dev logs.
        // eslint-disable-next-line no-console
        console.warn('[skill-iter-studio-prompt] failed to resolve visible skills:', e?.message || e);
        visibleSkills = [];
    }
    if (longAgents.length === 0 && (!Array.isArray(visibleSkills) || visibleSkills.length === 0)) {
        return basePrompt;
    }
    const block = formatSkillsAugmentation(visibleSkills, longAgents);
    return `${basePrompt}\n\n${block}`;
}
