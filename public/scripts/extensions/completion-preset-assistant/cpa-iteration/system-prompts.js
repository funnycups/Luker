// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * CPA — plugin-owned system-prompt builders + session-mode constants.
 *
 * Ported verbatim from cpa-iteration-adapter.js (the shell-driven adapter
 * that Stage 3 retires). This module exposes only the static, side-effect-
 * free pieces that build text strings for the LLM:
 *
 *   - SESSION_MODES / SESSION_MODE_DEFAULT / sanitizeSessionMode
 *   - buildModelSystemPrompt:                main system prompt for the AI
 *   - buildOrchestratorOptimizeModeBlock:    mode-specific tail block
 *   - buildJailbreakOnlyModeBlock:           mode-specific tail block
 *   - buildPresetStructureGuideText:         static structure description
 *   - buildPresetSettingsOutlineText:        renders a preset's generation/
 *                                            context settings as a text list
 *   - buildPresetPromptOutlineText:          renders a preset's prompts[] +
 *                                            prompt_order[] as a text outline
 *   - formatPromptPreview:                   short preview of a prompt body
 *   - getPresetPromptEntries:                normalized prompts[] view
 *   - getPresetPromptOrderGroups:            normalized prompt_order[] view
 *
 * Pure string-building. No DOM, no lodash, no Luker globals.
 */

/**
 * Surface-meaning session modes. Each maps to a system-prompt block that
 * tells the AI WHAT KIND of preset it's editing: a generic RP preset, an
 * orchestrator agent preset, or a jailbreak-only preset for internal
 * tool-style LLM callers. The dead pre-Plan-2 dialog had these blocks
 * but the adapter dropped them — restored here so mode actually means
 * something.
 */
export const SESSION_MODES = Object.freeze(['general', 'orchestrator-optimize', 'jailbreak-only']);
export const SESSION_MODE_DEFAULT = 'general';

export function sanitizeSessionMode(value) {
    const v = String(value || '').trim();
    return SESSION_MODES.includes(v) ? v : SESSION_MODE_DEFAULT;
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizePromptIdentifier(value, fallback = '') {
    return String(value ?? fallback ?? '').trim();
}

export function getPresetPromptEntries(body) {
    if (!Array.isArray(body?.prompts)) return [];
    return body.prompts.map((entry, index) => {
        const s = entry && typeof entry === 'object' ? entry : {};
        const identifier = normalizePromptIdentifier(s.identifier, s.id);
        if (!identifier) return null;
        return {
            identifier, index,
            content: String(s.content ?? ''),
            role: String(s.role ?? '').trim(),
            enabled: s.enabled !== false,
            name: String(s.name ?? '').trim(),
            marker: Boolean(s.marker),
            injection_position: s.injection_position ?? null,
            injection_depth: s.injection_depth ?? null,
            injection_order: s.injection_order ?? null,
        };
    }).filter(Boolean);
}

export function getPresetPromptOrderGroups(body) {
    if (!Array.isArray(body?.prompt_order)) return [];
    return body.prompt_order.map((group) => {
        const s = group && typeof group === 'object' ? group : {};
        const characterId = String(s.character_id ?? '').trim();
        const order = Array.isArray(s.order)
            ? s.order.map((item) => {
                const o = item && typeof item === 'object' ? item : {};
                const identifier = normalizePromptIdentifier(o.identifier);
                if (!identifier) return null;
                return { identifier, enabled: o.enabled !== false };
            }).filter(Boolean)
            : [];
        return { character_id: characterId, order };
    });
}

export function formatPromptPreview(content) {
    const norm = String(content ?? '').replace(/\r\n/g, '\n').trim();
    if (!norm) return '(empty)';
    const lines = norm.split('\n').slice(0, 3).map((l) => l.trim()).filter(Boolean);
    const preview = lines.join(' / ');
    return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
}

/**
 * Render the live preset's prompts and prompt_order as a textual outline
 * for the AI to read alongside its task. Highlights the prompts[] entries
 * that DO NOT appear in any prompt_order group — those are the silent
 * "exists but does nothing" entries that the bug used to produce.
 */
export function buildPresetPromptOutlineText(body) {
    const entries = getPresetPromptEntries(body);
    const promptMap = new Map(entries.map((e) => [e.identifier, e]));
    const orderedIds = new Set();
    const groups = getPresetPromptOrderGroups(body);

    const sections = [
        'Prompt layout:',
        `- new_chat_prompt: ${formatPromptPreview(body?.new_chat_prompt)}`,
        `- new_group_chat_prompt: ${formatPromptPreview(body?.new_group_chat_prompt)}`,
    ];
    if (groups.length === 0) {
        sections.push('- ordered prompt groups: none');
    } else {
        sections.push('- ordered prompt groups:');
        for (const g of groups) {
            sections.push(`  character_id=${g.character_id || '(empty)'}`);
            if (g.order.length === 0) { sections.push('    (empty)'); continue; }
            g.order.forEach((item, i) => {
                orderedIds.add(item.identifier);
                const promptEntry = promptMap.get(item.identifier) || { content: '', role: '' };
                sections.push(
                    `  ${i + 1}. ${item.identifier} [${item.enabled ? 'enabled' : 'disabled'}] role=${promptEntry.role || 'n/a'}`,
                );
                sections.push(`     ${formatPromptPreview(promptEntry.content)}`);
            });
        }
    }

    const orphans = entries.filter((e) => !orderedIds.has(e.identifier));
    if (orphans.length > 0) {
        sections.push('- prompts NOT in any prompt_order (will be silently ignored at generation time):');
        for (const e of orphans) {
            sections.push(`  - ${e.identifier} [${e.enabled ? 'enabled' : 'disabled'}] role=${e.role || 'n/a'}`);
            sections.push(`    ${formatPromptPreview(e.content)}`);
        }
    }
    return sections.join('\n');
}

export function buildPresetSettingsOutlineText(body) {
    const src = isPlainObject(body) ? body : {};
    const keys = [
        ['temperature', 'temperature'],
        ['top_p', 'top_p'],
        ['top_k', 'top_k'],
        ['min_p', 'min_p'],
        ['presence_penalty', 'presence_penalty'],
        ['frequency_penalty', 'frequency_penalty'],
        ['openai_max_context', 'context_limit'],
        ['openai_max_tokens', 'output_tokens'],
        ['names_behavior', 'names_behavior'],
        ['send_if_empty', 'send_if_empty'],
        ['impersonation_prompt', 'impersonation_prompt'],
        ['continue_nudge_prompt', 'continue_nudge_prompt'],
        ['stream_openai', 'stream_openai'],
        ['use_sysprompt', 'use_sysprompt'],
        ['assistant_prefill', 'assistant_prefill'],
        ['continue_prefill', 'continue_prefill'],
        ['continue_postfix', 'continue_postfix'],
        ['function_calling', 'function_calling'],
        ['show_thoughts', 'show_thoughts'],
        ['reasoning_effort', 'reasoning_effort'],
        ['verbosity', 'verbosity'],
        ['enable_web_search', 'enable_web_search'],
        ['seed', 'seed'],
        ['n', 'n'],
    ];
    const lines = [];
    for (const [k, label] of keys) {
        if (!Object.hasOwn(src, k)) continue;
        const v = src[k];
        if (v === '' || v === null || v === undefined) continue;
        const text = typeof v === 'string' ? v : JSON.stringify(v);
        lines.push(`- ${label}: ${text}`);
    }
    return lines.length > 0
        ? ['Generation/context settings:', ...lines].join('\n')
        : 'Generation/context settings: none';
}

export function buildPresetStructureGuideText() {
    return [
        'OpenAI preset structure:',
        '- prompts[]: catalog of prompt entries. Each: {identifier, name?, content, role?, enabled?, marker?, injection_position?, injection_depth?, injection_order?}.',
        '- prompt_order[]: per-character activation lists. Each: {character_id, order:[{identifier, enabled}, ...]}.',
        '- An entry that exists in prompts[] but is NOT referenced in any prompt_order[*].order is silently ignored at generation time — it never reaches the model.',
        '- Top-level prompt fields: new_chat_prompt, new_group_chat_prompt, continue_nudge_prompt, impersonation_prompt, assistant_prefill, continue_prefill, continue_postfix, send_if_empty, wi_format, scenario_format, personality_format, group_nudge_prompt, use_sysprompt, squash_system_messages.',
        '- Common generation/context fields: temperature, top_p, top_k, min_p, presence_penalty, frequency_penalty, openai_max_context, openai_max_tokens, names_behavior, function_calling, show_thoughts, reasoning_effort, verbosity, seed, n.',
    ].join('\n');
}

export function buildOrchestratorOptimizeModeBlock() {
    return [
        '',
        'Mode: orchestrator-optimize.',
        '',
        'The user is editing this preset for use with a multi-agent orchestrator',
        '(director / loop / iteration). The model consuming this preset will be an',
        'agent that issues tool calls, not a narrator producing a single textual',
        'response. Three patterns in typical RP presets actively interfere:',
        '',
        '1. Hard output-format constraints. A preset that prescribes a literal',
        '   output schema (any structural shape the model is forced to produce)',
        '   is incompatible with tool-calling — the agent cannot satisfy the',
        '   schema and emit tool calls in the same response. Rewrite these',
        '   directives to express the cognitive intent (think before acting,',
        '   plan structure, consider tradeoffs) without prescribing a literal',
        '   output format.',
        '',
        '2. Final-product-only directives. Anything that should appear only in',
        '   the final committed assistant message must be conditioned on that',
        '   stage in the directive itself. The orchestrator runs many sub-agent',
        '   rounds and iterations; these directives should not fire every round.',
        '   Rewrite the directive\'s content so it explicitly conditions itself',
        '   on "the final committed message" or equivalent — the consuming',
        '   agent then decides per round whether it applies.',
        '',
        '3. Duplicate-injection placeholders. The orchestrator\'s main path',
        '   already injects character / persona / worldbook content into the',
        '   chat context the agent sees. Preset items that splice the same',
        '   content double the injection.',
        '',
        '   Disable: character card fields (description / personality /',
        '   scenario / first message / example messages), user persona,',
        '   worldbook splice nodes (any explicit worldInfo entries in the',
        '   preset).',
        '',
        '   Must stay enabled:',
        '   - chat history — the channel through which the agent\'s prompt',
        '     reaches the LLM; disabling it silences the agent. If the original',
        '     preset has it off, enable it.',
        '   - writing style / anti-cliché instructions — read by the main',
        '     agent when drafting and when briefing critic sub-agents.',
        '   - jailbreak / bypass instructions — a mid-loop refusal stalls the',
        '     scout → draft → critique chain before finalize can fire.',
        '',
        'Preserve everything else not covered above. NSFW permissions, RP voice',
        'rules, character-writing instructions, content directives — they are',
        'not the problem.',
        '',
        'Approach:',
        '- Inspect the live preset with read tools to identify entries matching',
        '  the patterns above before proposing changes.',
        '- Default to suggesting derivation via preset_clone_to_new: propose a',
        '  new preset name (e.g., `<original>-orchestrator`), explain why, await',
        '  user consent. Only edit the live preset directly if the user opts in.',
        '- Prefer minimal edits — rewrite offending lines / sections inside an',
        '  entry rather than removing the entry, when possible.',
        '- When unsure whether a directive is format constraint vs writing',
        '  style, err toward preserving and ask the user.',
    ].join('\n');
}

export function buildJailbreakOnlyModeBlock() {
    return [
        '',
        'Mode: jailbreak-only.',
        '',
        'The user is editing this preset for use by a tool-style LLM caller — an',
        'internal Luker subsystem (memory graph curator, preset assistant,',
        'other LLM-driven plugins) running structured tasks, not producing',
        'narrative RP. To such a caller, the user\'s preset is valuable solely',
        'as a jailbreak / uncensoring layer; everything else is noise that',
        'biases the model toward writing prose when it should be emitting',
        'structured output.',
        '',
        'Goals:',
        '1. Identify and preserve jailbreak / uncensoring directives. The',
        '   standard `jailbreak` field is the obvious one, but jailbreak content',
        '   commonly lives in custom-named entries or as inline sections inside',
        '   larger entries. Recognize them by semantic intent — directives that',
        '   grant permission to handle restricted content, override default',
        '   safety posture, or operate as an uncensored persona. When in doubt,',
        '   preserve and flag for user confirmation.',
        '2. Disable everything that exists to shape narrative RP output —',
        '   writing style, voice rules, character-writing guidance, output',
        '   schemas, NSFW writing rules, narrative meta-rules. Heuristic: if',
        '   removing this directive would change *how the model writes a story*',
        '   but not *what the model is permitted to write*, disable it.',
        '3. Do not touch the ST-filled content slots (charDescription /',
        '   personaDescription / scenario / worldInfoBefore / worldInfoAfter /',
        '   chatHistory and the like). The host plugin decides at call time',
        '   whether it wants those slots populated; this mode should not',
        '   preempt that decision. Leave their enabled/disabled state as the',
        '   original preset has it.',
        '',
        'Approach:',
        '- Default to suggesting derivation via preset_clone_to_new: propose a',
        '  new preset name (e.g., `<original>-jailbreak`), explain why, await',
        '  user consent.',
        '- Inspect the live preset with read tools before proposing disables.',
        '  Decide by semantic intent, not by entry name.',
        '- Disable by removing from prompt order, not by deleting the',
        '  underlying prompt entry. The user can revert by re-adding to order.',
        '- When an entry contains BOTH jailbreak content AND other content',
        '  interleaved, edit the entry to isolate the jailbreak section rather',
        '  than disabling the whole entry — losing the jailbreak portion would',
        '  defeat the mode\'s purpose.',
    ].join('\n');
}

export function buildModelSystemPrompt({ hasReference = false, mode = SESSION_MODE_DEFAULT } = {}) {
    const baseLines = [
        'You are the AI assistant for the Completion Preset Assistant.',
        'You are editing one Luker chat completion preset (OpenAI-style).',
        'Edit prompt-related preset content only.',
        'Do not modify API connection, provider routing, endpoint selection, proxy settings, transport settings, or credential fields. Chat completion presets and API profiles are decoupled.',
        '',
        buildPresetStructureGuideText(),
        '',
        'CRITICAL — adding a new prompt entry that should actually take effect:',
        '- Use preset_upsert_prompt_entry. By default it appends the new identifier to every existing prompt_order group so the entry is immediately active. Pass `position` (1-based) on the same call to drop it at a precise slot instead of the tail — no follow-up preset_upsert_prompt_order_item needed for the common case.',
        '- Adding to prompts[] alone (e.g., raw preset_list_insert on prompts[]) leaves the entry inert until you also insert into every prompt_order[*].order. Prefer preset_upsert_prompt_entry to avoid this trap.',
        '- If the user wants the new entry NOT to be in prompt_order yet, pass auto_add_to_order: false to preset_upsert_prompt_entry, or use preset_upsert_prompt_order_item later to place it explicitly.',
        '',
        'Tool preferences:',
        '- Long-string fields (e.g., prompts[*].content): use preset_str_replace / preset_str_insert / preset_str_delete instead of resetting the whole field via preset_set_field. Sends only the changed substring and surfaces drift if surrounding text changed externally. `find` / `after_text` must occur exactly `expected_count` times (default 1).',
        '- Object fields: prefer preset_set_field("parent.child", value) over preset_set_field("parent", wholeObject) — finer paths surface conflicts only on actually-overlapping fields.',
        '- Array fields: prefer preset_list_insert / preset_list_remove / preset_list_move over rewriting the whole array via preset_set_field. For the special prompts[] / prompt_order[] arrays, prefer the prompt-specific tools (preset_upsert_prompt_entry, preset_upsert_prompt_order_item, preset_remove_prompt_entry, preset_remove_prompt_order_item).',
        '- For preset_upsert_prompt_order_item, position is 1-based within the target character_id group.',
        '',
        'Inspection tools (read-only, no edits proposed):',
        '- preset_read_live_fields — exact values from the current live preset by lodash-style paths.',
        hasReference
            ? '- preset_read_reference_fields — exact values from the selected reference preset.'
            : '- (preset_read_reference_fields unavailable — no reference preset is selected.)',
        hasReference
            ? '- preset_diff_reference — structural diff of prompt layout between live and the selected reference.'
            : '- (preset_diff_reference unavailable — no reference preset is selected.)',
        '- preset_simulate — simulate prompt assembly for the current preset. Prefer the `text` argument so the tool appends one user message to the current chat context.',
        '- preset_clone_to_new — clone the current live preset under a new name and switch the dialog target to it. Use when the user agrees to derive a new preset rather than editing the original. Fails if the name already exists.',
        '',
        'Behavior:',
        '- Use tool calls when proposing actual preset changes.',
        '- If you call any read-only inspection tool in a round, do not emit edit tool calls in that same round — wait for the next round to act on what you learned.',
        '- Prefer minimal edits over broad rewrites unless the user explicitly asks for a rewrite.',
        '- Use lodash-style paths like new_chat_prompt or prompts[0].content for preset_set_field / preset_str_*.',
        '- For preset_set_field, value_json must be valid JSON text.',
        hasReference
            ? '- Use preset_copy_from_reference only when the selected reference preset already contains the desired content.'
            : '- (preset_copy_from_reference unavailable — no reference preset is selected.)',
        '- If no changes are needed, reply briefly without tool calls.',
    ];

    const safeMode = sanitizeSessionMode(mode);
    const modeBlock = safeMode === 'orchestrator-optimize'
        ? buildOrchestratorOptimizeModeBlock()
        : safeMode === 'jailbreak-only'
            ? buildJailbreakOnlyModeBlock()
            : '';

    return modeBlock
        ? `${baseLines.join('\n')}\n${modeBlock}`
        : baseLines.join('\n');
}
