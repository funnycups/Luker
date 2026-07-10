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
    '- Editable fields: system_prompt (string), apiPresetName (string), promptPresetName (string), max_rounds (1-50), wall_clock_budget_ms (>= 10000), tools.note.open, tools.note.close, tools.chat.read_range, tools.chat.search, tools.lorebook.world_book_list, tools.lorebook.list, tools.lorebook.search, tools.lorebook.get, tools.lorebook.force_activate, tools.memory.schema, tools.memory.list_candidates, tools.memory.edge_summary, tools.memory.node_brief, tools.memory.expand_seeds, tools.memory.keyword_search, tools.memory.vector_search, tools.memory.find_by_name, tools.memory.compaction_candidates, tools.memory.node_create, tools.memory.node_edit, tools.memory.node_delete, tools.memory.link_upsert, tools.memory.link_delete, tools.memory.compact_nodes, tools.search.search, tools.search.visit (all boolean).',
    '- Use luker_orch_set_loop_profile to update one or more fields. Pass only the fields you intend to change; omitted fields are inherited from the current profile.',
    '- For incremental edits to a long system_prompt, prefer `luker_orch_patch_loop_system_prompt` over resending the whole field. `oldString` must be unique unless `replaceAll: true`.',
    '- The finalize tool is always enabled — it is the only loop terminator. Do not propose disabling tools.finalize; the schema will ignore that field.',
    '- If the user describes a workflow, infer which tool namespaces they need (note / chat / lorebook / memory / search) and propose enabling those while keeping the other tools default-on unless the user explicitly asks to disable them.',
    '- Leave apiPresetName and promptPresetName empty unless the user explicitly requests loop-specific routing. Empty means fallback to the global orchestration API / chat-completion preset.',
    '- If you set apiPresetName, use only a name from available_connection_profiles. If you set promptPresetName, use only a name from available_local_global_chat_completion_presets or available_card_bound_chat_completion_presets. Card-bound names only resolve on the currently active character card and travel with the card on export; local-global names are portable. Prefer local-global names for a portable loop profile; use a card-bound name only when the profile is meant to ship with the same card.',
    '- Anti-duplication (loop-mode consequences of the shared mental model): the principle was already established — system_prompt is identity, not runtime data; the agent sees raw activated entries with no metadata; uid is a runtime handle. Loop-specific violations: pasting lorebook bodies into system_prompt instead of naming the entry by display name and letting the agent resolve it via `lorebook_list` + `lorebook_get` at runtime; mirroring the user\'s latest message (it lands in the per-turn user brief, not the persistent system_prompt); mirroring chat / character-card / scene context. **Never write a literal `uid: N` into system_prompt** — refer to entries by display name (`comment`) or stable `entry_key` only.',
    '',
    '## Runtime agent lorebook tools (what the loop agent actually has)',
    '',
    'The loop agent — the one that runs when this profile dispatches — has these lorebook tools, gated by tools.lorebook.{world_book_list, list, search, get, force_activate}:',
    '',
    '- `world_book_list` — lists visible world books with scope tags and entry counts.',
    '- `lorebook_list({book_name, range?})` — entry index lines "[{book}] uid={n} name={comment} key={k1|k2}". Skips entries the main flow already injected this turn.',
    '- `lorebook_search({pattern, flags?, book?})` — regex over entry content. Output is grep -n format "[{book}] {entry_name}:{lineno}: {line}". Also skips already-injected entries.',
    '- `lorebook_get({uid OR entry_key, book?})` — fetches one entry. Returns {book, uid, name, key, content}. Does NOT skip already-injected entries.',
    '- `lorebook_force_activate({book_name, uids[]})` — **WRITE-mode, on by default.** Forces dormant entries into the main model\'s <world_info> channel for THIS turn. Bypasses the WI token budget and does not trigger recursive key scanning. The intended use is the agent curating per-turn lore — `lorebook_list` to find candidates, then force only what the turn needs (pushing too much will silently evict chat history). Works in loop / spec / agenda; director cannot use it (timing — director\'s main agent runs after WI is baked into the prompt).',
    '',
    'The runtime DOES NOT have: a keyword-search tool (compose `list` + `search`); any way to enumerate disabled / constant entries. `lorebook_force_activate` is the one write tool; everything else is read.',
    '',
    '**Authoring note for you (iter-studio AI)**: the `uid` field above is a runtime handle that appears in the loop agent\'s TOOL RESULTS at runtime, not in the system_prompt you author. The agent learns uids by calling `lorebook_list` itself. Never write a literal `uid: N` into system_prompt text — reference entries by display name (`comment`) or stable `entry_key` instead.',
    '',
    '## No meta-narration in the loop agent\'s system_prompt',
    '',
    'The loop agent reads what is in its context. Do NOT explain the runtime to it. NEVER write into the loop agent\'s system_prompt any of: "the world-info system injects activated entries...", "don\'t call lorebook_search because uid N is already in your context", "use `lorebook_get(uid=N)` to read entry X" (or any literal uid; uid is a runtime handle, not a profile-time identifier), "the runtime will provide X — so you don\'t need to...", "lorebook entries with constant=true are auto-injected...", or any "the agent sees / does not see / will be given" framing. If you want the agent to use a tool, name the tool and the purpose. If you want it NOT to chase something already in context, just don\'t mention it. The only legitimate "runtime info" in the loop agent\'s system_prompt is: which tools exist, what each does, what output shape to produce.',
    '- Prefer targeted edits — bumping max_rounds should not rewrite the entire system_prompt.',
    '- If user asks to test, call luker_orch_simulate with suitable input.',
    'The luker_orch_simulate tool now opens a popup so the user can review the actual orchestration run (per-round agent turns) produced under the current chat, world-info, and preset. The user may annotate parts they\'re unhappy with. The tool result you receive will be a tagged text envelope:',
    '- <simulation_chain> contains the full chain of rounds and tool calls. Spans wrapped in <<<ANNOTATION id=N>>>...<<</ANNOTATION>>> are flagged by the user.',
    '- <annotations> lists each [#N] with its location, snippet, and the user\'s comment.',
    '- <status submitted="false"/> means the user cancelled without annotating.',
    'Annotations are SYMPTOMS, not patch targets. When you see a <<<ANNOTATION id=N>>>...<<</ANNOTATION>>> span:',
    '1. Ask: WHY did the model produce that span? Trace it back to a root cause — an underspecified or contradictory directive in the loop system_prompt, missing termination guidance (so the agent stops early or rambles), a tool namespace the agent needed but lacks (note / chat / lorebook / memory / search), or budget limits (max_rounds / wall_clock_budget_ms) too tight to let the agent self-correct.',
    '2. Fix at the ROOT level. Edit the loop system_prompt directive, enable the missing tool namespace, or adjust budget limits so the same class of issue won\'t recur in a different scene. Prefer general directives over hyper-specific ones. NEVER add a literal countermand to the exact annotated phrase ("do not say X", "avoid \'Y\' when …"); that\'s whack-a-mole and signals you skipped diagnosis.',
    '3. Simulate again after the fix to verify the root cause was addressed.',
    'Symptom-level patches are explicitly off-limits when they target the annotated text. If the only viable fix really is local, explain to the user why a structural fix isn\'t possible before reaching for the patch.',
    '- Multi-round iteration control: the popup auto-continues whenever you emit any tool call this round, so tool results become context for the next round. To end the iteration, respond with plain text and emit no tool calls.',
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
/**
 * Helpers for `applyLoopProfilePatchArgs`'s strict arg validation.
 *
 * Each field-level check distinguishes three cases:
 *   - missing key       → inherit current value (partial-merge semantics)
 *   - present + correct → adopt patch value
 *   - present + wrong   → throw `invalid_args` so the executor can
 *                         surface a real `{ok:false, error, detail}`
 *                         tool reply (mirrors the anchor-patch contract
 *                         in system-prompt-patch.js)
 *
 * Without the throw the typeof guard used to silently fall back to the
 * current value, the executor reported `{ok:true, changed:false}`, and
 * the iter-studio's sandbox-diff saw no change → "already matches"
 * noop. The AI never learned its arg was the wrong type and looped
 * trying variants until it gave up.
 */
function patchStringField(patch, key, current, toolName) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) return current;
    const value = patch[key];
    if (typeof value !== 'string') {
        throw new Error(`${toolName}: invalid_args — ${key} must be a string, got ${typeof value}.`);
    }
    return value;
}

function patchNumberField(patch, key, current, toolName) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) return current;
    const value = patch[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${toolName}: invalid_args — ${key} must be a finite number, got ${typeof value === 'number' ? 'non-finite number' : typeof value}.`);
    }
    return value;
}

/**
 * Apply a `luker_orch_set_loop_profile` tool-call patch on top of the
 * caller's current profile. Returns the canonical V3 profile envelope
 * (sanitized — see `sanitizeLoopProfile`). Partial: keys absent from
 * `args` inherit from `currentProfile` unchanged. Keys present with the
 * wrong type throw `invalid_args` instead of silently falling back,
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
    if (args !== undefined && args !== null && typeof args !== 'object') {
        throw new Error('luker_orch_set_loop_profile: invalid_args — args must be an object.');
    }
    const patch = args && typeof args === 'object' ? args : {};
    const TOOL = 'luker_orch_set_loop_profile';
    const next = {
        apiPresetName: patchStringField(patch, 'apiPresetName', current.apiPresetName, TOOL),
        promptPresetName: patchStringField(patch, 'promptPresetName', current.promptPresetName, TOOL),
        system_prompt: patchStringField(patch, 'system_prompt', current.system_prompt, TOOL),
        max_rounds: patchNumberField(patch, 'max_rounds', current.max_rounds, TOOL),
        wall_clock_budget_ms: patchNumberField(patch, 'wall_clock_budget_ms', current.wall_clock_budget_ms, TOOL),
        capsule_inject: current.capsule_inject,
        tools: structuredClone(current.tools),
    };
    if (Object.prototype.hasOwnProperty.call(patch, 'tools')) {
        const incomingTools = patch.tools;
        if (incomingTools === null || typeof incomingTools !== 'object' || Array.isArray(incomingTools)) {
            throw new Error(`${TOOL}: invalid_args — tools must be an object keyed by namespace.`);
        }
        const merge = (group, key) => {
            const incoming = incomingTools[group];
            if (incoming === undefined) return;
            if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
                throw new Error(`${TOOL}: invalid_args — tools.${group} must be an object.`);
            }
            if (!Object.prototype.hasOwnProperty.call(incoming, key)) return;
            const value = incoming[key];
            if (typeof value !== 'boolean') {
                throw new Error(`${TOOL}: invalid_args — tools.${group}.${key} must be a boolean, got ${typeof value}.`);
            }
            if (next.tools[group] && typeof next.tools[group] === 'object') {
                next.tools[group][key] = value;
            }
        };
        // Legacy memory + search namespaces translate into custom entries
        // (see sanitizeAgentToolFlags). Route their verbs into
        // `tools.custom.<ns>_<verb>` so a partial-merge patch flips the
        // post-translation keys instead of trying to mutate the now-
        // dropped legacy subtree.
        const mergeLegacyAsCustom = (legacyGroup, prefix, verb) => {
            const incoming = incomingTools[legacyGroup];
            if (incoming === undefined) return;
            if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
                throw new Error(`${TOOL}: invalid_args — tools.${legacyGroup} must be an object.`);
            }
            if (!Object.prototype.hasOwnProperty.call(incoming, verb)) return;
            const value = incoming[verb];
            if (typeof value !== 'boolean') {
                throw new Error(`${TOOL}: invalid_args — tools.${legacyGroup}.${verb} must be a boolean, got ${typeof value}.`);
            }
            if (!next.tools.custom || typeof next.tools.custom !== 'object') {
                next.tools.custom = {};
            }
            next.tools.custom[`${prefix}${verb}`] = value;
        };
        // Patches addressed directly at `tools.custom.<name>` merge wholesale.
        if (Object.prototype.hasOwnProperty.call(incomingTools, 'custom')) {
            const incomingCustom = incomingTools.custom;
            if (incomingCustom === null || typeof incomingCustom !== 'object' || Array.isArray(incomingCustom)) {
                throw new Error(`${TOOL}: invalid_args — tools.custom must be an object keyed by tool name.`);
            }
            if (!next.tools.custom || typeof next.tools.custom !== 'object') {
                next.tools.custom = {};
            }
            for (const [k, v] of Object.entries(incomingCustom)) {
                next.tools.custom[String(k)] = v !== false;
            }
        }
        merge('note', 'open');
        merge('note', 'close');
        merge('chat', 'read_range');
        merge('chat', 'search');
        merge('lorebook', 'world_book_list');
        merge('lorebook', 'list');
        merge('lorebook', 'search');
        merge('lorebook', 'get');
        mergeLegacyAsCustom('memory', 'memory_', 'schema');
        mergeLegacyAsCustom('memory', 'memory_', 'list_candidates');
        mergeLegacyAsCustom('memory', 'memory_', 'edge_summary');
        mergeLegacyAsCustom('memory', 'memory_', 'node_brief');
        mergeLegacyAsCustom('memory', 'memory_', 'expand_seeds');
        mergeLegacyAsCustom('memory', 'memory_', 'keyword_search');
        mergeLegacyAsCustom('memory', 'memory_', 'vector_search');
        mergeLegacyAsCustom('memory', 'memory_', 'find_by_name');
        mergeLegacyAsCustom('memory', 'memory_', 'compaction_candidates');
        mergeLegacyAsCustom('memory', 'memory_', 'node_create');
        mergeLegacyAsCustom('memory', 'memory_', 'node_edit');
        mergeLegacyAsCustom('memory', 'memory_', 'node_delete');
        mergeLegacyAsCustom('memory', 'memory_', 'link_upsert');
        mergeLegacyAsCustom('memory', 'memory_', 'link_delete');
        mergeLegacyAsCustom('memory', 'memory_', 'compact_nodes');
        mergeLegacyAsCustom('search', 'search_', 'search');
        mergeLegacyAsCustom('search', 'search_', 'visit');
        // tools.finalize is ignored — sanitizer forces it back to true.
    }
    return sanitizeLoopProfile(next);
}
