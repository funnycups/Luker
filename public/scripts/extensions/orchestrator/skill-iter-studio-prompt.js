// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * iter-studio system prompt augmentation: skills catalog + extraction
 * discipline.
 *
 * The iter-studio AI has 16 skill-management tools. This
 * module appends a fixed "discipline" block plus a dynamic catalog of
 * currently-visible skills to the iter-studio system prompt at the start of
 * each turn. The catalog uses `resolveAgentVisibleSkills` to compute
 * mode-level visibility against the live profile, then lists each skill as
 * `name: description`.
 *
 * The block is appended ONLY when the working profile has at least one
 * agent whose systemPrompt exceeds the length-notification threshold OR
 * the profile has at least one visible skill — otherwise the augmentation
 * is pure noise. (An empty-skill + short-prompt profile means the user
 * hasn't installed anything yet and there's nothing to extract.)
 *
 * The "intensity preservation" warning is the load-bearing piece for
 * `skill_extract_from_text`. Without it, the iter-studio AI defaults to
 * summarizing as it extracts, which silently reduces prompt strength.
 *
 * No code in this module — or in iteration-library/tools/skill-iter-studio.js — decides
 * what counts as an "extraction candidate." That judgment is the AI's:
 * the agent's `systemPrompt` is supplied verbatim in `working_state` each
 * turn, and the AI selects the slice itself based on the discipline text
 * below. A previous version surfaced regex-filtered "candidates" through
 * a `skill_propose_extraction` tool; that has been removed because it
 * encouraged the AI to laze on the regex's guess instead of reading the
 * source material.
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
 * @param {{defaultScope?: {kind:string, mode?:string, name?:string}|null}} [opts]
 * @returns {string}
 */
export function formatSkillsAugmentation(visibleSkills, longAgents, opts = {}) {
    const defaultScope = opts && opts.defaultScope && typeof opts.defaultScope === 'object'
        ? opts.defaultScope
        : null;
    const lines = [];
    lines.push('## Skill management (iter-studio extension)');
    lines.push('');
    if (longAgents.length > 0) {
        const labels = longAgents
            .map(a => `${a.agentId} (${a.length} chars)`)
            .join(', ');
        lines.push(`Agent systemPrompts above ${LONG_PROMPT_HEURISTIC_CHARS} chars in this working profile: ${labels}. Length is a signal, not a verdict — whether any of these actually warrant extraction is your judgment (see step 3 below).`);
    } else {
        lines.push(`No agent systemPrompt in this working profile exceeds ${LONG_PROMPT_HEURISTIC_CHARS} chars. Extraction is unlikely to be needed this turn.`);
    }
    lines.push('');
    lines.push('Discipline for skill manipulation:');
    lines.push('1. Adding reusable rules → prefer creating a skill via `skill_create`. Do not bloat systemPrompt.');
    lines.push('2. Modifying rules → prefer modifying the skill (`skill_update_content` / `skill_edit_content`), not the systemPrompt.');
    lines.push('3. Migrating rules out of a long systemPrompt — done by YOU, not by any candidate-proposer tool. The agent\'s `systemPrompt` is in `working_state`; read it directly and pick the slice yourself.');
    lines.push('   a. Choose a self-contained rule block (a `## section`, a ban-list with ✗/✓ pairs, a voice contract, a finalize schema) that another agent in this orchestrator would benefit from reading independently. Skip single-line directives ("be concise") and scaffolding wrappers.');
    lines.push('   b. `skill_extract_from_text` — `sourceText` must be VERBATIM. No paraphrase, no compression, no rewording, no token savings. If the original says "你必须" three times, the extracted skill says "你必须" three times. Preserve repetition, emphasis, and exact wording. Intensity reduction is a separate explicit user ask, never a silent side-effect of extraction.');
    lines.push('   c. `skill_replace_in_systemprompt` — `insertText` is the pointer that stays in the systemPrompt. Compose it from scratch for THIS specific skill, as a complete imperative instruction containing three pieces: (i) a trigger condition (when the running agent should consult the skill), (ii) the skill name, (iii) a one-line hint about what it covers. Every pointer is per-skill — never reuse one template across multiple extractions in the same preset. The running agent decides whether to call `skill_read_content` based on the pointer alone, so the pointer must read as a complete actionable sentence, not a fragment like `参考 skill X`.');
    lines.push('   Pointer examples spanning different rule types (do NOT copy verbatim — these illustrate the structure, not the wording):');
    lines.push('   - 涉及亲密戏码或 NSFW 场景时，请按 skill `nsfw-voice-contract` 中的尺度与文风约束执行。');
    lines.push('   - 写作正文前，请按 skill `anti-cliche-rules` 列出的反套路清单核对一遍，避免其中标注的陈词。');
    lines.push('   - 产出最终回复前，请按 skill `finalize-output-shape` 定义的字段顺序与字段约束组织输出。');
    lines.push('   - 推断与决策环节，请按 skill `reasoning-discipline` 的步骤要求显式分解。');
    lines.push('');
    lines.push('Skill scope for authoring tools:');
    if (defaultScope && defaultScope.kind === 'orch-preset' && defaultScope.mode && defaultScope.name) {
        lines.push(`- Default when \`scope\` is omitted: \`{kind:"orch-preset", mode:"${defaultScope.mode}", name:"${defaultScope.name}"}\` — the orchestrator preset currently being edited. Skills created / edited without an explicit \`scope\` will belong to this preset and travel with it on export / import.`);
        lines.push('- Only pass an explicit `scope` when the skill genuinely does not belong to this preset (e.g. a truly cross-preset utility skill → `{kind:"global"}`, a character-bound persona skill → `{kind:"character", characterFile}`). Do NOT default to `global` "just in case" — that pollutes shared inventory.');
    } else {
        lines.push('- Default when `scope` is omitted: `{kind:"global"}`. Skills you create without an explicit scope go into the shared global inventory.');
        lines.push('- Prefer scoping skills narrowly when they are only relevant to one preset (`{kind:"preset", name}` for chat-completion presets, `{kind:"orch-preset", mode, name}` for orchestrator presets) or one character (`{kind:"character", characterFile}`).');
    }
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
 *   defaultScope?: {kind:string, mode?:string, name?:string}|null,
 * }} [opts] - test seam; default uses resolveAgentVisibleSkills from skill-resolution.js.
 *   `defaultScope` (when set) is surfaced in the prompt so the AI knows which
 *   scope its authoring tools default to when it omits `scope`.
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
    const block = formatSkillsAugmentation(visibleSkills, longAgents, { defaultScope: opts.defaultScope || null });
    return `${basePrompt}\n\n${block}`;
}
