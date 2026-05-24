/**
 * AI Iteration Studio helpers specific to V3 loop profiles.
 *
 * This module hosts the pure pieces of the loop-mode iteration flow that
 * `main.js` consumes — kept out of `main.js` to keep them easy to unit
 * test in isolation (no jQuery / DOM dependencies):
 *
 *   - `LOOP_ITERATION_CONTRACT_LINES` — the iteration-mode contract
 *     appended to the user-configurable iteration system prompt. Telling
 *     the AI what fields exist, that finalize is forced on, which tool
 *     to use for partial updates, and when to call continue/finalize.
 *   - `applyLoopProfilePatchArgs` — merges a partial loop-profile patch
 *     on top of a current loop profile and re-sanitizes. Used by both
 *     the diff preview path (`buildLoopIterationPendingDiffState`) and
 *     the executor path (`executeLoopIterationToolCalls`).
 *
 * The sanitizer is `sanitizeLoopProfile` from `persistence.js`. The
 * partial-merge contract intentionally inherits omitted fields from the
 * current profile so the AI can do surgical edits ("just bump
 * max_rounds") without rewriting the whole shape.
 */

import { sanitizeLoopProfile } from './persistence.js';

/**
 * The contract block appended to the iteration system prompt when
 * `session.mode === 'loop'`. Kept as an array of lines so the prompt
 * builder can join with the base prompt, and so it stays grep-able for
 * tests that assert key fields are mentioned (system_prompt /
 * tools.note.open / finalize tool is always enabled / etc.).
 */
export const LOOP_ITERATION_CONTRACT_LINES = Object.freeze([
    'Iteration mode contract (loop profile):',
    '- You are editing an existing loop-mode orchestration profile.',
    '- The profile drives a single agent that calls tools in a loop and finalizes when ready; there are no stages, nodes, or presets to manage.',
    '- Editable fields: system_prompt (string), apiPresetName (string), promptPresetName (string), max_rounds (1-50), wall_clock_budget_ms (>= 10000), tools.note.open, tools.note.close, tools.chat.read_range, tools.chat.search, tools.lorebook.search, tools.lorebook.get, tools.memory.schema, tools.memory.list_candidates, tools.memory.edge_summary, tools.memory.node_brief, tools.memory.expand_seeds, tools.memory.keyword_search, tools.memory.vector_search, tools.memory.find_by_name, tools.memory.compaction_candidates, tools.memory.node_create, tools.memory.node_edit, tools.memory.node_delete, tools.memory.link_upsert, tools.memory.link_delete, tools.memory.compact_nodes, tools.search.search, tools.search.visit (all boolean).',
    '- Use luker_orch_set_loop_profile to update one or more fields. Pass only the fields you intend to change; omitted fields are inherited from the current profile.',
    '- The finalize tool is always enabled — it is the only loop terminator. Do not propose disabling tools.finalize; the schema will ignore that field.',
    '- If the user describes a workflow, infer which tool namespaces they need (note / chat / lorebook / memory / search) and propose enabling those while keeping the other tools default-on unless the user explicitly asks to disable them.',
    '- Leave apiPresetName and promptPresetName empty unless the user explicitly requests loop-specific routing. Empty means fallback to the global orchestration API / chat-completion preset.',
    '- If you set apiPresetName, use only a name from available_connection_profiles. If you set promptPresetName, use only a name from available_chat_completion_presets.',
    '- Prefer targeted edits — bumping max_rounds should not rewrite the entire system_prompt.',
    '- If user asks to test, call luker_orch_simulate with suitable input.',
    '- If you need one more autonomous step right after current execution, call luker_orch_continue_iteration.',
    '- If you need user decision or clarification, do not call continue or finalize. Stop and wait for user.',
    '- When iteration is complete, call luker_orch_finalize_iteration.',
    '- If you call both luker_orch_continue_iteration and luker_orch_finalize_iteration in the same round, finalize wins.',
    '- Keep output practical and concise for real RP usage.',
]);

/**
 * Merge a partial loop-profile patch on top of `currentProfile` and
 * re-sanitize via `sanitizeLoopProfile`. Only fields the caller passes
 * are touched — undefined fields are inherited from the current profile,
 * including individual tool-flag entries inside `tools.{namespace}`.
 *
 * `tools.finalize` is intentionally ignored: `sanitizeLoopProfile`
 * always coerces it back to true, so passing it through here would be
 * misleading.
 *
 * @param {object} currentProfile — Any input the sanitizer accepts.
 * @param {object} args — Partial patch from the AI tool call.
 * @returns {ReturnType<typeof sanitizeLoopProfile>} fully-sanitized V3 profile.
 */
export function applyLoopProfilePatchArgs(currentProfile, args) {
    const current = sanitizeLoopProfile(currentProfile);
    const patch = args && typeof args === 'object' ? args : {};
    const next = {
        apiPresetName: typeof patch.apiPresetName === 'string' ? patch.apiPresetName : current.apiPresetName,
        promptPresetName: typeof patch.promptPresetName === 'string' ? patch.promptPresetName : current.promptPresetName,
        system_prompt: typeof patch.system_prompt === 'string' ? patch.system_prompt : current.system_prompt,
        max_rounds: Object.prototype.hasOwnProperty.call(patch, 'max_rounds')
            ? patch.max_rounds
            : current.max_rounds,
        wall_clock_budget_ms: Object.prototype.hasOwnProperty.call(patch, 'wall_clock_budget_ms')
            ? patch.wall_clock_budget_ms
            : current.wall_clock_budget_ms,
        capsule_inject: current.capsule_inject,
        tools: structuredClone(current.tools),
    };
    const incomingTools = patch.tools && typeof patch.tools === 'object' ? patch.tools : null;
    if (incomingTools) {
        const merge = (group, key) => {
            const incoming = incomingTools[group];
            if (incoming && typeof incoming === 'object'
                && Object.prototype.hasOwnProperty.call(incoming, key)) {
                next.tools[group][key] = incoming[key];
            }
        };
        merge('note', 'open');
        merge('note', 'close');
        merge('chat', 'read_range');
        merge('chat', 'search');
        merge('lorebook', 'search');
        merge('lorebook', 'get');
        merge('memory', 'schema');
        merge('memory', 'list_candidates');
        merge('memory', 'edge_summary');
        merge('memory', 'node_brief');
        merge('memory', 'expand_seeds');
        merge('memory', 'keyword_search');
        merge('memory', 'vector_search');
        merge('memory', 'find_by_name');
        merge('memory', 'compaction_candidates');
        merge('memory', 'node_create');
        merge('memory', 'node_edit');
        merge('memory', 'node_delete');
        merge('memory', 'link_upsert');
        merge('memory', 'link_delete');
        merge('memory', 'compact_nodes');
        merge('search', 'search');
        merge('search', 'visit');
        // tools.finalize is ignored — sanitizer forces it back to true.
    }
    return sanitizeLoopProfile(next);
}
