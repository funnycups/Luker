// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * CPA skill discipline + catalog block.
 *
 * Mirrors `orchestrator/skill-iter-studio-prompt.js` but adapted for CPA's
 * preset-editing surface. The block is built only when the session is in
 * `orchestrator-optimize` mode — the other modes (general, jailbreak-only)
 * don't benefit from the skill workflow.
 *
 * The block contains:
 *   1. A discipline block telling the AI when to prefer authoring a skill
 *      over inline preset edits, and what the splice-in-reference workflow
 *      looks like with CPA's preset-editing tools.
 *   2. A dynamic catalog of skills currently visible in the preset scope
 *      chain — what's already installed for the preset being edited, so
 *      the AI can recommend reusing an existing skill instead of authoring
 *      a duplicate.
 *
 * The block is now appended to the LAST user message (caller's job) rather
 * than the system prompt, so the base system prompt stays byte-stable across
 * rounds — Anthropic prompt cache is a prefix match and the catalog changes
 * every time a skill is created / renamed / deleted, which would invalidate
 * the whole system cache otherwise. The catalog appearing on the user side
 * is fine: the AI reads it once per turn either way.
 *
 * Pure module — no DOM, no Luker globals, no Skill API call inline. The
 * catalog fetch is plumbed via `opts.listSkillsInScope` so studio.js owns
 * the caller-side error handling and this module stays trivial to test.
 */

/**
 * Format the discipline + catalog block as plain text. Pure — given the
 * scope chain text + the skills list, returns the block to embed. Exported
 * for unit tests; the live call site is `buildCpaSkillsBlock`.
 *
 * The skill list is sorted by `name` (lexicographic, locale-aware) so a
 * registry order change (skill install / uninstall reordering the array)
 * doesn't float through into the prompt bytes — important for Anthropic
 * prompt cache stability on the user-message side.
 *
 * @param {Array<{name: string, description: string, scope?: object}>} visibleSkills
 * @param {{ presetName: string }} scopeHint
 * @returns {string}
 */
export function formatCpaSkillsAugmentation(visibleSkills, scopeHint = {}) {
    const presetName = String(scopeHint.presetName || '').trim();
    const presetScopeLine = presetName
        ? `Skills you create with scope { kind: 'preset', name: '${presetName}' } travel with this preset on export. Skills with scope { kind: 'global' } stay on this user only.`
        : 'Skills you create with scope { kind: \'preset\', name } travel with the matching preset on export. Skills with scope { kind: \'global\' } stay on this user only.';

    const lines = [];
    lines.push('## Skill management (CPA orchestrator-optimize extension)');
    lines.push('');
    lines.push('You also have skill-authoring tools (`skill_create`, `skill_inspect`, `skill_read_content`, `skill_edit_content`, `skill_update_content`, `skill_update_frontmatter`, `skill_rename`, `skill_change_scope`, `skill_delete`, `skill_extract_from_text`, `skill_list_visible`, `skill_search_content`).');
    lines.push('');
    lines.push('### Proactive sweep — REQUIRED on every adapt request');
    lines.push('');
    lines.push('When the user asks you to adapt this preset for the orchestrator (your default task in this mode), an extraction sweep is part of the adapt — not optional, not "if I notice something". You MUST do one of the following in your reply, every adapt round:');
    lines.push('');
    lines.push('(a) Propose at least one skill extraction as part of the same round (the steps below), OR');
    lines.push('(b) State explicitly in your assistant text: "I scanned all prompts[].content for extractable reusable rules and found none worth lifting" — with a brief 1-sentence reason. Silence is forbidden; the user has no way to tell whether you swept or skipped, and skipping silently defeats the whole point of having skill tools in this mode.');
    lines.push('');
    lines.push('Skip the sweep entirely (no proposals AND no scanned-but-nothing-found line) only when the user request is a focused one-off tweak: "tighten this sentence", "raise temperature to 1.1", "fix this typo". Or when the user explicitly said "no skills". Or when you swept in an earlier round of this same session and the user rejected the candidates.');
    lines.push('');
    lines.push('### What counts as a strong extraction candidate');
    lines.push('');
    lines.push('Scan `prompts[].content` (and `impersonation_prompt`, `new_chat_prompt` etc. on the preset root if they\'re substantive) for self-contained, reusable rules that a sub-agent elsewhere in the orchestrator would benefit from reading independently. Strong signals:');
    lines.push('- Multi-paragraph blocks with named ## headings inside an entry (e.g. `## 反 meta 写作纪律`, `## NSFW 写作风格`)');
    lines.push('- Imperative discipline language: "禁止 / 必须 / 永远 / 绝不 / never / always / forbidden"');
    lines.push('- Listed rules with ✗/✓ pairs, ban-lists, do/don\'t guidance');
    lines.push('- Anti-cliché / anti-meta / writing-discipline sections');
    lines.push('- NSFW writing-style or permission contracts');
    lines.push('- Voice rules / character-voice contracts');
    lines.push('- Finalize-format schemas / output-shape rules (the "final committed reply" variants, not process coercion)');
    lines.push('');
    lines.push('Weak candidates (skip): single-line directives ("be concise"), framework / scaffolding entries, content that only makes sense for this one preset.');
    lines.push('');
    lines.push('### The three-step extraction sequence');
    lines.push('');
    lines.push('For each strong candidate, in the SAME round, propose all three:');
    lines.push('1. `skill_create` (or `skill_extract_from_text`) at PRESET scope, body VERBATIM from the entry — no paraphrase, no compression, no rewording, no token savings.');
    lines.push('2. `preset_str_delete_in_prompt` to remove the slice from the source entry.');
    lines.push('3. `preset_str_insert_in_prompt` to splice in a pointer at the same anchor. The pointer is the only thing the running agent sees in place of the removed rules, so it must read as a complete imperative instruction containing three pieces: (i) a trigger condition (when the running agent should consult the skill), (ii) the skill name, (iii) a one-line hint about what it covers. Compose a different pointer for every extraction — never reuse one template across slices. The pointer alone determines whether the agent calls `skill_read_content`, so a fragment like `参考 skill X` is not enough; it must be an actionable sentence.');
    lines.push('   Pointer examples spanning different rule types (do NOT copy verbatim — these illustrate the structure, not the wording):');
    lines.push('   - 涉及亲密戏码或 NSFW 场景时，请按 skill `nsfw-voice-contract` 中的尺度与文风约束执行。');
    lines.push('   - 写作正文前，请按 skill `anti-cliche-rules` 列出的反套路清单核对一遍，避免其中标注的陈词。');
    lines.push('   - 产出最终回复前，请按 skill `finalize-output-shape` 定义的字段顺序与字段约束组织输出。');
    lines.push('   - 推断与决策环节，请按 skill `reasoning-discipline` 的步骤要求显式分解。');
    lines.push('');
    lines.push('In your assistant text, name each candidate before the tool calls land — for example: "Reusable rules I noticed and prepared as extraction proposals: [name + 1-line reason each]. Each card is reviewable independently — approve / reject per your call." This lets the user veto a candidate before reading the diff.');
    lines.push('');
    lines.push('Modifying an existing rule that already lives in a skill → call `skill_edit_content` / `skill_update_content` on the skill; do not duplicate the rule back into the preset entry.');
    lines.push('');
    lines.push('⚠ Extraction MUST be verbatim. Do NOT paraphrase, compress, or reword as you extract. If the original prompt entry says "你必须" three times, the extracted skill body says "你必须" three times — preserve repetition, emphasis, and original wording. Reduction is for a separate, explicit user ask, not a silent side-effect of extraction.');
    lines.push('');
    lines.push('Scope default — author the skill at preset scope unless the user asks for global. ' + presetScopeLine);
    lines.push('');
    lines.push('Binding the skill to an agent (making it visible to a specific orchestrator sub-agent) lives in the orchestrator iter-studio, NOT here. Author the skill in this session; the user (or the orchestrator iter-studio AI) will attach it from that side.');
    lines.push('');
    lines.push('Currently visible skills for this preset scope:');
    const named = Array.isArray(visibleSkills) ? visibleSkills.filter(s => s && typeof s.name === 'string') : [];
    const sorted = named.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    if (sorted.length === 0) {
        lines.push('- (none installed for this scope chain yet)');
    } else {
        for (const s of sorted) {
            const scopeLabel = s.scope && s.scope.kind ? ` [${s.scope.kind}]` : '';
            lines.push(`- ${s.name}${scopeLabel}: ${String(s.description || '')}`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * Build the skill discipline + catalog block. Returns the block string ready
 * for the caller to splice into the LAST user message (or empty string when
 * mode is not orchestrator-optimize).
 *
 * The block is appended to the user message rather than the system prompt so
 * the base system stays byte-stable across rounds — the catalog mutates every
 * time the AI creates / renames / deletes a skill, and putting it in the
 * system would invalidate Anthropic's prefix cache for every later round.
 *
 * `listSkillsInScope` errors propagate — silent fallback to an empty catalog
 * would lie to the model ("(none installed)") and risk it duplicating an
 * existing skill. The caller (studio.js) surfaces the failure and refuses
 * the round.
 *
 * @param {string} mode  current session mode ('general' / 'orchestrator-optimize' / 'jailbreak-only')
 * @param {{ presetName: string }} scopeHint
 * @param {{
 *   listSkillsInScope?: () => Promise<Array<{ name: string, description: string, scope?: object }>>,
 * }} [opts]
 * @returns {Promise<string>} the catalog block, or empty string when augmentation doesn't apply
 */
export async function buildCpaSkillsBlock(mode, scopeHint = {}, opts = {}) {
    if (String(mode || '') !== 'orchestrator-optimize') return '';
    let visible = [];
    if (typeof opts.listSkillsInScope === 'function') {
        visible = await opts.listSkillsInScope();
        if (!Array.isArray(visible)) visible = [];
    }
    return formatCpaSkillsAugmentation(visible, scopeHint);
}
