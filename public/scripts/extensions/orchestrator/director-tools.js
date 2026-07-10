/**
 * Director mode tools — schemas + executors.
 *
 * Three groups:
 *   1. Loop-inherited tools (chat / lorebook / memory / note / search) —
 *      available to both main and sub-agents, gated by the same
 *      `profile.tools.<ns>.<verb>` nested flag schema loop mode uses.
 *   2. Collaboration tools (dispatch_subagent / await_subagents /
 *      cancel_subagent) — main agent only.
 *   3. Message-production tools:
 *        - write_message / apply_message_patches — gated by
 *          `tools.message.<verb>` for BOTH roles (no role-based special-
 *          casing). Shipping default: main agent has an explicit
 *          override that enables them (see
 *          `buildDefaultMainAgentToolsOverride` in director-defaults.js);
 *          sub-agents inherit the profile default (both off). Either
 *          role can be flipped in its Tools override panel.
 *        - finalize — main agent only, unconditional. Sub-agents cannot
 *          commit / end the turn regardless.
 *        - get_draft / draft_search — available to both, unconditional
 *          (read-only, symmetric across roles).
 *
 * The executors are pure async functions that take a handle (or
 * dispatcher) plus parsed args, and return `{ ok, error?, ... }` for
 * the tool-result envelope. They never throw — runtime errors are
 * surfaced as tool errors so the main agent can recover.
 *
 * Tool-flag interop with loop: director shares loop's `profile.tools`
 * shape (sanitized via `sanitizeAgentToolFlags`) so `getEnabledToolSchemas`
 * is called directly with no schema translation. The only post-step is
 * stripping loop's own `finalize` from the result — director has a
 * same-named `finalize` tool with a different signature, and both
 * appearing in the LLM tools array would be ambiguous.
 */

import { FINALIZE_TOOL_SCHEMA, getEnabledToolSchemas, resolveToolSource } from './loop-tools.js';
import { resolveAgentToolFlags } from './persistence.js';
import { resolveCardFirstPresetName } from './agent-preset-resolver.js';
import {
    appendText,
    applyPatch,
    EditorOpsError,
} from './editor-ops.js';
import { gatherGrepMatches } from './grep-tool.js';
import { isAbortError, raceAbortSignal, throwIfAborted } from './abort-utils.js';
import { canonicalStringifyArgs } from './canonical-stringify.js';
import {
    appendRound, appendToSection, ensureSection, setRoundStatus, setSectionStatus, addTokenUsage,
} from './run-state/store.js';
import { i18n, i18nFormat } from './i18n.js';

// Skill-resolution helpers are loaded lazily so the transitive import chain
// (skill-resolution → skillsApi → script.js → lib.js) stays out of module
// evaluation. Same pattern as director-runtime.js.
let _skillResolutionPromise = null;
async function loadSkillResolution() {
    if (!_skillResolutionPromise) {
        _skillResolutionPromise = import('./skill-resolution.js');
    }
    return _skillResolutionPromise;
}

/**
 * Resolve the connection-profile name for a director sub-agent: per-spec
 * setting wins; falls back to the orchestrator's global LLM-node setting
 * (`settings.llmNodeApiPresetName`). Card-first — an embedded card
 * preset with the same name overrides a same-named local global preset,
 * matching the orchestrator's card-first binding rule shared with the
 * loop / agenda / spec modes.
 * Delegates to `resolveCardFirstPresetName` so all orchestrator modes
 * share one resolution path; kept as a local string-returning wrapper
 * because callers feed the result into `runDispatchInternal` which
 * threads it straight into `generateTask({apiPresetName, llmPresetName})`.
 * `resolveByName` + character are pulled from the ctx layer lazily so
 * this module stays Jest-clean.
 */
function resolveAgentApiPresetName(settings, agentConfig) {
    const ctx = (typeof Luker !== 'undefined') ? Luker.getContext() : null;
    const character = ctx?.characters?.[ctx?.characterId] ?? null;
    const resolveByName = ctx?.character?.presets?.resolveByName;
    const resolved = resolveCardFirstPresetName({
        explicitName: agentConfig?.apiPresetName,
        fallbackName: settings?.llmNodeApiPresetName,
        character,
        resolveByName,
    });
    return resolved?.name || '';
}

/**
 * Mirror of `resolveAgentApiPresetName` for chat-completion prompt
 * presets. Per-spec setting wins; falls back to
 * `settings.llmNodePresetName`. Card-first via
 * `resolveCardFirstPresetName`.
 */
function resolveAgentPromptPresetName(settings, agentConfig) {
    const ctx = (typeof Luker !== 'undefined') ? Luker.getContext() : null;
    const character = ctx?.characters?.[ctx?.characterId] ?? null;
    const resolveByName = ctx?.character?.presets?.resolveByName;
    const resolved = resolveCardFirstPresetName({
        explicitName: agentConfig?.promptPresetName,
        fallbackName: settings?.llmNodePresetName,
        character,
        resolveByName,
    });
    return resolved?.name || '';
}

function loopToolSchemasFor(tools, customToolRegistry = null) {
    const all = getEnabledToolSchemas({ tools }, customToolRegistry);
    const loopFinalizeName = FINALIZE_TOOL_SCHEMA?.function?.name || 'finalize';
    return all.filter(s => s?.function?.name !== loopFinalizeName);
}

// ── Tool schemas ──

export const DISPATCH_SUBAGENT_TOOL = {
    type: 'function',
    function: {
        name: 'dispatch_subagent',
        description: 'Dispatch one of the profile-configured sub-agents (selected by id). The sub-agent\'s role is fixed by its system prompt in the profile — you cannot override it here. Returns a handle id; pair with await_subagents to read the result.',
        parameters: {
            type: 'object',
            properties: {
                subagentId: { type: 'string', description: 'Id of a configured sub-agent.' },
                task: { type: 'string', description: 'Task brief for the sub-agent (becomes a user message on top of its system prompt).' },
            },
            required: ['subagentId', 'task'],
        },
    },
};

export const DISPATCH_INLINE_SUBAGENT_TOOL = {
    type: 'function',
    function: {
        name: 'dispatch_inline_subagent',
        description: 'Dispatch a sub-agent with a role you define inline at call time. Use when you need a one-off analysis that doesn\'t match any profile-configured sub-agent, or when no sub-agents are configured. The systemPrompt you provide IS the sub-agent\'s entire role definition — write it as you would write a fresh system prompt for an LLM. Sub-agent sees: your systemPrompt + the same story context / chat history you see + your task brief + the same loop tools you have + get_draft. Sub-agent does NOT see: this profile\'s other sub-agents, the live draft beyond a get_draft call, or any context from prior sub-agent dispatches. Returns a handle id; pair with await_subagents to read the result.',
        parameters: {
            type: 'object',
            properties: {
                systemPrompt: { type: 'string', description: 'The full system prompt that defines this sub-agent\'s role / viewpoint / constraints.' },
                task: { type: 'string', description: 'Task brief for the sub-agent (becomes a user message on top of systemPrompt).' },
                apiPresetName: { type: 'string', description: 'Optional. Connection profile to use for this sub-agent. Empty = inherit main agent\'s.' },
                promptPresetName: { type: 'string', description: 'Optional. Chat completion preset for this sub-agent. Empty = inherit main agent\'s.' },
            },
            required: ['systemPrompt', 'task'],
        },
    },
};

export const AWAIT_SUBAGENTS_TOOL = {
    type: 'function',
    function: {
        name: 'await_subagents',
        description: 'Block until the listed dispatch_subagent handles all complete. Returns each one\'s output text or error.',
        parameters: {
            type: 'object',
            properties: {
                handles: { type: 'array', items: { type: 'string' } },
            },
            required: ['handles'],
        },
    },
};

export const WRITE_MESSAGE_TOOL = {
    type: 'function',
    function: {
        name: 'write_message',
        description: 'Write into the assistant message. mode="append" (default) appends; mode="replace" overwrites the entire body. "replace" is forbidden during continue generation.',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string' },
                mode: { type: 'string', enum: ['append', 'replace'] },
            },
            required: ['text'],
        },
    },
};

export const APPLY_MESSAGE_PATCHES_TOOL = {
    type: 'function',
    function: {
        name: 'apply_message_patches',
        description: 'Apply context_replace patches. Each patch finds an exact byte-for-byte substring in the current message and replaces it. The `oldString` MUST be unique in the current message body — include enough surrounding context (typically 1–3 lines before and/or after the target) to make it so. If `oldString` matches multiple locations, the call fails — extend the context until it is unique. No fuzzy / heuristic matching: whitespace, case, indentation, line endings, and Unicode form must all match exactly.',
        parameters: {
            type: 'object',
            properties: {
                patches: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            kind: { type: 'string', enum: ['context_replace'] },
                            oldString: { type: 'string', description: 'Exact substring (with surrounding context for uniqueness).' },
                            newString: { type: 'string', description: 'Replacement text.' },
                        },
                        required: ['kind', 'oldString', 'newString'],
                    },
                },
            },
            required: ['patches'],
        },
    },
};

export const FINALIZE_TOOL = {
    type: 'function',
    function: {
        name: 'finalize',
        description: 'Commit the assistant message and end the turn.',
        parameters: { type: 'object', properties: {} },
    },
};

export const GET_DRAFT_TOOL = {
    type: 'function',
    function: {
        name: 'get_draft',
        description: 'Return the current text of the in-flight assistant message (the "draft"). The draft is mutated by write_message and apply_message_patches; calling get_draft returns whatever is in the message body at the moment of the call. Use to re-read the draft between edits, or — for sub-agents — to see what the main agent has written so far.',
        parameters: { type: 'object', properties: {} },
    },
};

export const DRAFT_SEARCH_TOOL = {
    type: 'function',
    function: {
        name: 'draft_search',
        description: 'Regex search across the current draft (the in-flight assistant message). Returns grep -n style output: one matched line per result as "{lineno}: {line_content}". Use this for systematic vocabulary scans instead of re-reading the full draft via get_draft — eye-reading misses things.',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'JavaScript RegExp source. To match literal text, escape regex metacharacters (\\. \\[ \\( \\\\). Prefer non-greedy quantifiers (.*?  \\w+?) by default; switch to greedy only when you genuinely need the longest match — greedy can blow up on large corpora.',
                },
                flags: {
                    type: 'string',
                    description: 'RegExp flags. \'gm\' by default (global + multiline) to mirror grep semantics. Add \'i\' for case-insensitive, \'s\' for dotall. \'g\' is auto-injected if you omit it. Note: scan is line-oriented like grep; multi-line patterns that require literal \\n cannot match.',
                    default: 'gm',
                },
            },
            required: ['pattern'],
        },
    },
};

export const CANCEL_SUBAGENT_TOOL = {
    type: 'function',
    function: {
        name: 'cancel_subagent',
        description: 'Abort an in-flight sub-agent. Use when you realize the dispatch was misdirected, the sub-agent is looping, or its output is no longer needed. The handle\'s entry in await_subagents will resolve to an error result and its reasoning-fold section is marked cancelled. No-op if the handle already completed.',
        parameters: {
            type: 'object',
            properties: {
                handle: { type: 'string', description: 'Handle id returned by dispatch_subagent.' },
            },
            required: ['handle'],
        },
    },
};

export function buildMainAgentToolSchemas({ subAgents, tools, customToolRegistry = null }) {
    const hasSubAgents = Array.isArray(subAgents) && subAgents.length > 0;
    // Each dispatcher tool can be turned off via `tools.collab.<verb>` from
    // the main-agent override panel. Missing namespace (or missing key)
    // preserves the legacy default — both dispatchers on. Only an explicit
    // `false` disables. `await_subagents` / `cancel_subagent` are companion
    // tools: they only appear when at least one dispatcher is enabled
    // (without either, there are no handles to wait on or cancel).
    // `dispatch_subagent` (the by-id variant) further requires that the
    // profile actually has configured sub-agents — an enabled flag with an
    // empty subAgents list is still hidden because there are no valid
    // targets.
    const collabFlags = tools && typeof tools === 'object' && tools.collab && typeof tools.collab === 'object'
        ? tools.collab
        : {};
    const dispatchSubagentEnabled = hasSubAgents && collabFlags.dispatch_subagent !== false;
    const dispatchInlineEnabled = collabFlags.dispatch_inline_subagent !== false;
    const anyDispatcherEnabled = dispatchSubagentEnabled || dispatchInlineEnabled;
    const collab = [
        ...(dispatchSubagentEnabled ? [DISPATCH_SUBAGENT_TOOL] : []),
        ...(dispatchInlineEnabled ? [DISPATCH_INLINE_SUBAGENT_TOOL] : []),
        ...(anyDispatcherEnabled ? [AWAIT_SUBAGENTS_TOOL, CANCEL_SUBAGENT_TOOL] : []),
    ];
    // Message-editing tools (write_message / apply_message_patches) are
    // gated by `tools.message.<verb>` — the SAME flag namespace sub-
    // agents use, no role-based special-casing. The shipping default
    // main agent has an explicit tools override
    // (see `buildDefaultMainAgentToolsOverride` in director-defaults.js)
    // that enables both flags, so out-of-the-box behavior is unchanged.
    // Users who want a pure-orchestrator main agent (sub-agents produce
    // the message body, main agent only dispatches / commits) can
    // uncheck these toggles in the main-agent Tools override panel.
    //
    // finalize / get_draft / draft_search remain unconditional:
    // finalize is the main agent's turn-terminator ownership (sub-
    // agents cannot commit / end the turn regardless); get_draft /
    // draft_search are read-only and symmetric across roles.
    const messageFlags = tools && typeof tools === 'object' && tools.message && typeof tools.message === 'object'
        ? tools.message
        : {};
    const messageProduction = [
        ...(messageFlags.write_message === true ? [WRITE_MESSAGE_TOOL] : []),
        ...(messageFlags.apply_message_patches === true ? [APPLY_MESSAGE_PATCHES_TOOL] : []),
        GET_DRAFT_TOOL,
        DRAFT_SEARCH_TOOL,
        FINALIZE_TOOL,
    ];
    const loop = loopToolSchemasFor(tools, customToolRegistry);
    return [...collab, ...messageProduction, ...loop];
}

export function buildSubAgentToolSchemas({ tools, customToolRegistry = null }) {
    // Sub-agents always get get_draft / draft_search (read-only draft
    // access) plus whichever loop tools the profile enables. The two
    // message-editing tools (write_message / apply_message_patches) are
    // gated by `tools.message.<verb>` — the SAME flag namespace the
    // main agent uses, no role-based special-casing. Default profile
    // ships with sub-agent inheritance off (see `buildFullDirectorTools`
    // in director-defaults.js), so out-of-the-box sub-agents never see
    // them unless the user explicitly ticks the toggles per sub-agent
    // or profile-wide.
    //
    // Dispatch / cancel / finalize remain main-agent-only regardless of
    // flag value: sub-agents cannot recurse and cannot commit / end the
    // turn (that decision belongs to the main agent).
    const messageFlags = tools && typeof tools === 'object' && tools.message && typeof tools.message === 'object'
        ? tools.message
        : {};
    const optionalMessageTools = [
        ...(messageFlags.write_message === true ? [WRITE_MESSAGE_TOOL] : []),
        ...(messageFlags.apply_message_patches === true ? [APPLY_MESSAGE_PATCHES_TOOL] : []),
    ];
    return [GET_DRAFT_TOOL, DRAFT_SEARCH_TOOL, ...optionalMessageTools, ...loopToolSchemasFor(tools, customToolRegistry)];
}

// ── Tool executors ──

export async function executeWriteMessageTool(handle, args) {
    try {
        const text = String(args?.text ?? '');
        const mode = args?.mode === 'replace' ? 'replace' : 'append';
        if (mode === 'replace') {
            handle.setText(text);  // kernel enforces continue prefix rule
        } else {
            appendText(handle, text);
        }
        return { ok: true, currentLength: handle.getText().length };
    } catch (err) {
        return { ok: false, error: String(err?.message || err) };
    }
}

export async function executeApplyPatchesTool(handle, args) {
    const patches = Array.isArray(args?.patches) ? args.patches : [];
    if (patches.length === 0) {
        return { ok: false, error: 'apply_message_patches requires patches array' };
    }
    // Snapshot current text so we can roll back on partial failure.
    const snapshot = handle.getText();
    try {
        applyPatch(handle, patches);
        return { ok: true, appliedCount: patches.length };
    } catch (err) {
        // Roll back to snapshot — half-applied patches break critic
        // feedback loops because the agent's next round sees a partially
        // mutated body it did not predict.
        handle.setText(snapshot);
        const code = err instanceof EditorOpsError ? err.code : 'unknown';
        // Prefix the error code into the message so agents that only read
        // `result.error` still see the structured failure category. The
        // `code` field is also available for callers that switch on it.
        const baseMessage = String(err?.message || err);
        return {
            ok: false,
            error: `[${code}] ${baseMessage}`,
            code,
        };
    }
}

export async function executeFinalizeTool(handle) {
    try {
        await handle.commit();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: String(err?.message || err) };
    }
}

export async function executeGetDraftTool(handle) {
    try {
        if (!handle || typeof handle.getText !== 'function') {
            return { ok: false, error: 'no handle available' };
        }
        return { ok: true, text: handle.getText() };
    } catch (err) {
        return { ok: false, error: String(err?.message || err) };
    }
}

export async function executeDraftSearchTool(handle, args) {
    try {
        if (!handle || typeof handle.getText !== 'function') {
            return { ok: false, error: 'no handle available' };
        }
        const pattern = String(args?.pattern ?? '');
        if (!pattern) {
            return { ok: false, error: 'draft_search requires a non-empty pattern. To match literal text, escape regex metacharacters.' };
        }
        const flags = typeof args?.flags === 'string' && args.flags.length > 0 ? args.flags : 'gm';
        return gatherGrepMatches([{ prefix: '', content: handle.getText() }], pattern, flags);
    } catch (err) {
        return { ok: false, error: String(err?.message || err) };
    }
}

// ── Sub-agent dispatcher ──

/**
 * Default cap on the sub-agent's own tool-call mini-loop. Used when a
 * sub-agent profile does not pin its own `maxRounds`. Independent from
 * the main agent's `maxRounds` — sub-agents are expected to converge in
 * modest rounds (gather context, then emit a final text response). The
 * cap is a runaway safety net; in practice a short critic finishes in
 * 1-3 rounds, and a recall-style sub-agent (memory_scout /
 * memory_curator) doing schema + a few find_by_name + brief + 1-2 drill
 * calls fits in ~10-12 rounds. 40 gives even long-running recall +
 * multi-step edit workflows comfortable headroom without letting a
 * runaway burn the whole turn. Users / AI iteration can override per
 * sub-agent via `subAgents[].maxRounds` (any integer >= 1 after the
 * sanitizer); `null` keeps this default.
 */
const SUB_AGENT_MAX_ROUNDS = 40;

// Re-export so the value is a single source of truth. Tests
// (tests/orchestrator/director/subagent-max-rounds.test.js) and any
// future consumers that want the "default cap" number should read it
// from here rather than duplicating the literal — a raise (16→40 in
// commit 488505cb2 shipped without the test picking it up; export
// prevents that class of drift).
export { SUB_AGENT_MAX_ROUNDS };

/**
 * Creates the per-turn sub-agent dispatcher used by director-runtime.
 *
 * Each sub-agent runs its own tool-call mini-loop (NOT a single-shot
 * completion). The loop terminates when:
 *   - The sub-agent emits a round with zero tool calls — that round's
 *     text is the sub-agent's output, returned to the main agent.
 *   - The cap (`SUB_AGENT_MAX_ROUNDS`) is hit — surfaced as an error in
 *     both the await-result and the section status so the user can see
 *     the sub-agent looped.
 *   - The shared `abortSignal` fires.
 *
 * Tool access (sub-agents): the same enabled loop tools the main agent
 * has (chat / lorebook / memory / note / search, gated by
 * `profile.tools.<ns>.<verb>`), plus get_draft / draft_search
 * unconditionally. Sub-agents CANNOT call `dispatch_subagent`,
 * `dispatch_inline_subagent`, `await_subagents`, `cancel_subagent`, or
 * `finalize` — those stay main-agent-only regardless of flag values.
 * `write_message` and `apply_message_patches` are gated by
 * `tools.message.<verb>` (same flag namespace the main agent uses) —
 * default off on every fresh sub-agent profile; a user can flip them
 * on per sub-agent or profile-wide. `buildSubAgentToolSchemas`
 * enforces the gating.
 *
 * Deps:
 *   - subAgents: profile.subAgents — id → spec lookup.
 *   - limits: { maxTotalSubagentRuns } — budget for the entire turn.
 *   - generateTask: non-streaming fallback (takes opts, returns terminal
 *     result). Always required (used when no stream provider is given,
 *     or as a last resort).
 *   - generateTaskStream: optional streaming provider (takes opts,
 *     returns { stream, result }). Forwarded unconditionally — the
 *     dispatcher consumes its chunks only when the per-call preset
 *     opts in (see `isStreamingPresetEnabled`).
 *   - isStreamingPresetEnabled: optional `(presetName) => boolean`
 *     probe. Returns true when the named preset's `stream_openai` flag
 *     enables live chunk delivery for this dispatch. When absent or
 *     false the dispatcher awaits the terminal `generateTask` result
 *     and writes the section once.
 *   - handle: MessageEditorHandle for the in-flight assistant message.
 *     Used only for `getText()` (snapshot of the live draft injected
 *     into the sub-agent's prompt) and as a settle-state probe to bail
 *     mid-stream when the parent takeover commits/aborts. The dispatcher
 *     never writes to the chat-message reasoning fold; all live activity
 *     is routed through RunStateStore.
 *   - runId: the active director run id (from `startRun` in main.js).
 *     Required — each sub-agent dispatch gets its own top-level round in
 *     the store and streams text/reasoning into named sections.
 *   - getContentPayload: () => contentPayload|null callback returning the
 *     cached director content payload (captured at
 *     GENERATE_TAKEOVER_DISPATCH from ST's skeleton-preset assembly).
 *     The dispatcher flattens it on each dispatch to produce the chat
 *     history shared with sub-agents (same history the main agent sees
 *     — single source of truth post-takeover). Sub-agents do not see
 *     each other's outputs (per spec).
 *   - abortSignal: shared with the main agent's abort signal.
 *   - tools: profile.tools — gates which loop tools the sub-agent can
 *     see (same flag tree the main agent uses).
 *   - executeLoopTool: (name, args, ctx) => result — the central loop
 *     tool dispatcher (typically the one from loop-tools.js, wired in
 *     by main.js). Receives the sub-agent's tool calls.
 *   - chat: live chat array, forwarded as `ctx.chat` to executeLoopTool
 *     so chat-reading tools work.
 */
export function createSubagentDispatcher({
    subAgents,
    directorProfile = null,
    limits,
    settings,
    generateTask,
    generateTaskStream,
    isStreamingPresetEnabled = null,
    handle,
    runId = null,
    getContentPayload,
    abortSignal,
    tools,
    executeLoopTool,
    chat,
    contextForNotes,
    customToolRegistry = null,
}) {
    const list = Array.isArray(subAgents) ? subAgents : [];
    const byId = new Map(list.map(a => [a.id, a]));
    const inflight = new Map();  // handleId -> Promise<{ outputText, error? }>
    // Per-sub-agent abort controller. Each dispatch creates a child
    // controller chained off the shared abortSignal; cancel(handleId)
    // fires only that child, leaving siblings running.
    const childAborts = new Map();  // handleId -> AbortController
    // Sub-agent completions queue. Each completed (or failed, or
    // cancelled) sub-agent pushes one entry here; the main-loop runtime
    // drains and converts them to system-message notifications at the
    // top of each round so the main agent learns about completions
    // without polling. Entries are pushed exactly once per handle.
    const completionNotifications = [];
    let nextHandleId = 0;
    let totalRuns = 0;

    const maxTotalSubagentRuns = Number.isFinite(limits?.maxTotalSubagentRuns)
        ? Number(limits.maxTotalSubagentRuns)
        : 16;

    function newHandleId() {
        return `subagent-${nextHandleId++}`;
    }

    function roundIdFor(handleId, subagentId) {
        // Flat naming: one top-level round per sub-agent dispatch,
        // id `sub-<subagentId>-<handleId-tail>` so the panel can show each
        // dispatch as a sibling of the main rounds. The handleId tail (the
        // numeric suffix of `subagent-N`) keeps the round id unique when
        // the same sub-agent is dispatched multiple times in a turn.
        const tail = String(handleId || '').replace(/^subagent-/, '');
        return `sub-${subagentId}-${tail}`;
    }

    function roundLabelFor(subagentId, handleId) {
        const tail = String(handleId || '').replace(/^subagent-/, '');
        return i18nFormat('Sub-agent ${0} · dispatch ${1}', subagentId, tail);
    }

    // Per-dispatch round/section bookkeeping. The dispatch promise lives
    // on its own micro-task chain; when it tries to write into the store
    // we have to defend against the run already being cleared (e.g. the
    // user navigated away, the next run started). All store calls below
    // are wrapped in try/catch so a cleared store cannot crash the
    // sub-agent's mini-loop.
    function panelEnsureRound(handleId, subagentId) {
        if (!runId) return null;
        const roundId = roundIdFor(handleId, subagentId);
        try {
            appendRound({ runId, round: { id: roundId, label: roundLabelFor(subagentId, handleId) } });
        } catch (_) { /* store may be cleared, or round already exists */ }
        return roundId;
    }

    function panelEnsureSection(roundId, sectionId, kind, title, meta) {
        if (!runId || !roundId) return null;
        try {
            ensureSection({
                runId,
                roundId,
                section: { id: sectionId, kind, title, meta: meta == null ? null : meta },
            });
            return sectionId;
        } catch (_) {
            return null;
        }
    }

    function panelAppendToSection(roundId, sectionId, delta) {
        if (!runId || !roundId || !sectionId) return;
        if (delta == null || String(delta).length === 0) return;
        try { appendToSection({ runId, roundId, sectionId, delta: String(delta) }); } catch (_) { /* store may be cleared */ }
    }

    function panelSetSectionStatus(roundId, sectionId, status, meta) {
        if (!runId || !roundId || !sectionId) return;
        try { setSectionStatus({ runId, roundId, sectionId, status, meta }); } catch (_) { /* store may be cleared */ }
    }

    function panelSetRoundStatus(roundId, status) {
        if (!runId || !roundId) return;
        try { setRoundStatus({ runId, roundId, status }); } catch (_) { /* store may be cleared */ }
    }

    // ── Trace recording helpers ──
    function makeChildAbort() {
        const ctrl = new AbortController();
        if (abortSignal) {
            if (abortSignal.aborted) {
                ctrl.abort();
            } else {
                const onAbort = () => {
                    ctrl.abort();
                };
                abortSignal.addEventListener('abort', onAbort, { once: true });
            }
        }
        return ctrl;
    }

    async function runOneRound(subMessages, panelCtx, baseOpts, subToolSchemas) {
        const callOpts = {
            ...baseOpts,
            taskMessages: subMessages,
            tools: subToolSchemas,
            toolChoice: subToolSchemas.length > 0 ? 'auto' : undefined,
        };
        const { roundId, textSectionId, reasoningSectionId } = panelCtx || {};
        // Transport-error retry honors `settings.toolCallRetryMax` —
        // same convention as `requestToolCallsWithRetry` (loop / agenda /
        // spec). User-initiated aborts re-throw without retry.
        const transportRetries = Math.max(0, Math.floor(Number(settings?.toolCallRetryMax) || 0));
        let transportAttempt = 0;
        while (true) {
            let roundText = '';
            let roundReasoning = '';
            let roundResult;
            try {
                const streamChunks = typeof generateTaskStream === 'function'
                    && typeof isStreamingPresetEnabled === 'function'
                    && isStreamingPresetEnabled(callOpts?.llmPresetName || '');
                if (streamChunks) {
                    const { stream, result } = generateTaskStream(callOpts);
                    for await (const chunk of stream) {
                        // Bail the moment the takeover handle has settled
                        // (user pressed stop, parent committed, etc.). The
                        // upstream stream may keep yielding chunks for a
                        // few hundred ms after — without this guard each
                        // chunk would keep firing store writes after the
                        // run has been finalized, which is wasted work
                        // (the writes are best-effort no-ops at that
                        // point anyway).
                        if (handle && typeof handle.isSettled === 'function' && handle.isSettled()) {
                            break;
                        }
                        if (!chunk || typeof chunk !== 'object') continue;
                        if (typeof chunk.delta !== 'string') continue;
                        if (chunk.type === 'text') {
                            roundText += chunk.delta;
                            panelAppendToSection(roundId, textSectionId, chunk.delta);
                        } else if (chunk.type === 'reasoning') {
                            roundReasoning += chunk.delta;
                            panelAppendToSection(roundId, reasoningSectionId, chunk.delta);
                        }
                    }
                    roundResult = await result;
                } else {
                    roundResult = await generateTask(callOpts);
                    roundText = String(roundResult?.assistantText ?? '');
                    roundReasoning = String(roundResult?.reasoning ?? '');
                    if (roundText) panelAppendToSection(roundId, textSectionId, roundText);
                    if (roundReasoning) panelAppendToSection(roundId, reasoningSectionId, roundReasoning);
                }
            } catch (transportErr) {
                if (isAbortError(transportErr, baseOpts?.abortSignal)) throw transportErr;
                transportAttempt += 1;
                if (transportAttempt > transportRetries) throw transportErr;
                console.warn(`[orchestrator-director] sub-agent transport attempt ${transportAttempt}/${transportRetries + 1} failed; retrying:`, transportErr);
                continue;
            }
            if (runId && roundResult?.usage) {
                try { addTokenUsage({ runId, usage: roundResult.usage }); } catch (_) { /* store may have been cleared */ }
            }
            const roundToolCalls = Array.isArray(roundResult?.toolCalls)
                ? roundResult.toolCalls.filter(tc => String(tc?.name || '').trim().length > 0)
                : [];
            const roundAssistantText = String(roundResult?.assistantText ?? roundText);
            const roundReasoningText = roundReasoning || String(roundResult?.reasoning ?? '');
            const roundReasoningBlocks = Array.isArray(roundResult?.reasoningBlocks) && roundResult.reasoningBlocks.length > 0
                ? roundResult.reasoningBlocks
                : null;
            const roundReasoningDetails = Array.isArray(roundResult?.reasoningDetails) && roundResult.reasoningDetails.length > 0
                ? roundResult.reasoningDetails
                : null;
            return { roundAssistantText, roundToolCalls, roundReasoningText, roundReasoningBlocks, roundReasoningDetails };
        }
    }

    async function dispatch({ subagentId, task, __parentMessages }) {
        const handleId = newHandleId();
        if (totalRuns >= maxTotalSubagentRuns) {
            const roundId = panelEnsureRound(handleId, subagentId);
            const sectionId = panelEnsureSection(roundId, 'sub_agent', 'sub_agent', i18n('Sub-agent'));
            const errMsg = `subagent budget exhausted (maxTotalSubagentRuns=${maxTotalSubagentRuns})`;
            panelSetSectionStatus(roundId, sectionId, 'failed', { err: errMsg });
            panelSetRoundStatus(roundId, 'failed');
            inflight.set(handleId, Promise.resolve({
                handleId,
                subagentId,
                error: errMsg,
            }));
            completionNotifications.push({ handleId, subagentId, status: 'failed', summary: errMsg });
            return handleId;
        }
        const spec = byId.get(subagentId);
        if (!spec) {
            const roundId = panelEnsureRound(handleId, subagentId);
            const sectionId = panelEnsureSection(roundId, 'sub_agent', 'sub_agent', i18n('Sub-agent'));
            const errMsg = `unknown sub-agent id: ${subagentId}`;
            panelSetSectionStatus(roundId, sectionId, 'failed', { err: errMsg });
            panelSetRoundStatus(roundId, 'failed');
            inflight.set(handleId, Promise.resolve({
                handleId,
                subagentId,
                error: errMsg,
            }));
            completionNotifications.push({ handleId, subagentId, status: 'failed', summary: errMsg });
            return handleId;
        }
        return runDispatchInternal({
            handleId,
            displayId: subagentId,
            isInline: false,
            systemPrompt: String(spec.systemPrompt || ''),
            apiPresetName: resolveAgentApiPresetName(settings, spec),
            promptPresetName: resolveAgentPromptPresetName(settings, spec),
            task,
            parentMessages: Array.isArray(__parentMessages) ? __parentMessages : null,
            agentTools: spec?.tools ?? null,
            agentMaxRounds: Number.isFinite(Number(spec?.maxRounds)) && Number(spec.maxRounds) > 0
                ? Math.floor(Number(spec.maxRounds))
                : null,
            // Pass the sub-agent spec through so the dispatcher can resolve
            // per-agent skill visibility (its `skills` field layered on
            // top of the mode-level default in `directorProfile.skills`).
            agentConfig: spec,
        });
    }

    async function dispatchInline({ systemPrompt, task, apiPresetName, promptPresetName, __parentMessages }) {
        const handleId = newHandleId();
        // For inline (ad-hoc) dispatches we tag the round / display id as
        // `(inline)` rather than a profile-configured sub-agent id, so
        // the user can tell at a glance which dispatches are reusable
        // roles vs. one-off scratchpads.
        const displayId = '(inline)';
        if (totalRuns >= maxTotalSubagentRuns) {
            const roundId = panelEnsureRound(handleId, displayId);
            const sectionId = panelEnsureSection(roundId, 'sub_agent', 'sub_agent', i18n('Sub-agent'));
            const errMsg = `subagent budget exhausted (maxTotalSubagentRuns=${maxTotalSubagentRuns})`;
            panelSetSectionStatus(roundId, sectionId, 'failed', { err: errMsg });
            panelSetRoundStatus(roundId, 'failed');
            inflight.set(handleId, Promise.resolve({
                handleId,
                subagentId: displayId,
                error: errMsg,
            }));
            completionNotifications.push({ handleId, subagentId: displayId, status: 'failed', summary: errMsg });
            return handleId;
        }
        const trimmedPrompt = String(systemPrompt || '').trim();
        if (!trimmedPrompt) {
            const roundId = panelEnsureRound(handleId, displayId);
            const sectionId = panelEnsureSection(roundId, 'sub_agent', 'sub_agent', i18n('Sub-agent'));
            const errMsg = 'dispatch_inline_subagent requires non-empty systemPrompt';
            panelSetSectionStatus(roundId, sectionId, 'failed', { err: errMsg });
            panelSetRoundStatus(roundId, 'failed');
            inflight.set(handleId, Promise.resolve({
                handleId,
                subagentId: displayId,
                error: errMsg,
            }));
            completionNotifications.push({ handleId, subagentId: displayId, status: 'failed', summary: errMsg });
            return handleId;
        }
        return runDispatchInternal({
            handleId,
            displayId,
            isInline: true,
            systemPrompt: trimmedPrompt,
            apiPresetName: resolveAgentApiPresetName(settings, { apiPresetName }),
            promptPresetName: resolveAgentPromptPresetName(settings, { promptPresetName }),
            task,
            parentMessages: Array.isArray(__parentMessages) ? __parentMessages : null,
            agentTools: null,
            agentMaxRounds: null,
            // Inline sub-agents have no profile-stored `skills` config —
            // they inherit the mode-level default.
            agentConfig: null,
        });
    }

    async function runDispatchInternal({ handleId, displayId, isInline, systemPrompt, apiPresetName, promptPresetName, task, parentMessages, agentTools, agentMaxRounds, agentConfig = null }) {
        totalRuns++;
        // Flat naming: one top-level round per sub-agent dispatch.
        // Inside that round we anchor a `reasoning` section and a `text`
        // section — same shape the main agent uses for its rounds, so the
        // panel renders both with the same component.
        const roundId = panelEnsureRound(handleId, displayId);
        const reasoningSectionId = panelEnsureSection(roundId, 'reasoning', 'reasoning', i18n('Reasoning'), { isInline, task });
        const textSectionId = panelEnsureSection(roundId, 'text', 'text', i18n('Text'), { isInline });
        // Effective per-dispatch round cap: per-agent override if pinned,
        // otherwise the module-level default. Already floored at 1
        // by the sanitizer for configured agents and by the inline-dispatch
        // tool schema for inline ones; the > 0 guard keeps a defensive
        // floor in case a caller passes 0 / negative.
        const effectiveMaxRounds = Number.isFinite(Number(agentMaxRounds)) && Number(agentMaxRounds) > 0
            ? Math.floor(Number(agentMaxRounds))
            : SUB_AGENT_MAX_ROUNDS;

        // Per-dispatch tool schemas: agent's own tools override (object)
        // wins; null/undefined falls back to profile.tools default.
        const resolvedTools = resolveAgentToolFlags(agentTools, tools);
        const subToolSchemas = buildSubAgentToolSchemas({ tools: resolvedTools || {}, customToolRegistry });

        // Splice the takeover-captured messages verbatim between
        // <story_context> open/close system messages. Director hard-codes
        // only the XML boundary tags; the captured payload (whatever the
        // user's chat-completion preset produced under takeover — chat
        // history, character info, world info, the user's latest input)
        // passes through as discrete messages with their original roles.
        // Mirrors `buildAgentTaskMessages` in director-runtime.js.
        const contentPayload = typeof getContentPayload === 'function' ? getContentPayload() : null;
        const payloadMessages = Array.isArray(contentPayload?.messages) ? contentPayload.messages : [];

        // Main-agent digest reflects rounds that happened AFTER the
        // shared prefix. The sub-agent prefix (before this change) was
        // [system_open, ...payload, system_close]. With the
        // <orchestration_role> wrapper now sitting BEFORE the
        // story_context, the prefix length grew by 2 (META_FRAME +
        // <orchestration_role>). Main agent's parentMessages still uses
        // the old [system_open, ...payload, system_close+role] shape —
        // so the prefix we ask `renderMainAgentDigest` to skip is still
        // `payload.length + 1` (the +1 accounts for the </story_context>
        // close; the open is the first system message that
        // renderMainAgentDigest already skips via its built-in
        // `startIndex = 1 + chatHistoryLength` semantics).
        const mainRoundsDigest = parentMessages
            ? renderMainAgentDigest(parentMessages, payloadMessages.length + 1)
            : null;

        // Read the per-dispatch open-notes block. Notes flip status as
        // earlier sub-agents call note_open / note_close in this director
        // session, so this is re-read on every dispatch and lives in the
        // trailing `<runtime_state>` user message instead of being
        // concatenated into the orchestration-role system prompt. Empty
        // when no adapter is mounted or all notes are closed.
        const openNotesBlock = await loadSubAgentOpenNotesBlock(contextForNotes);

        // Resolve visible skills for this sub-agent. Mode-level default
        // lives on `directorProfile.skills`; per-sub-agent `skills` (when
        // present on `agentConfig`) layers via the `+` inheritance idiom.
        // Failure falls back to an empty list — the agent runs without a
        // catalog and any skill_* tool call rejects (the exec requires a
        // populated __visibleSkillsForAgent).
        let visibleSkillsForSubAgent = [];
        let availableSkillsBlock = '';
        if (directorProfile) {
            try {
                const skillRes = await loadSkillResolution();
                visibleSkillsForSubAgent = await skillRes.resolveAgentVisibleSkills({
                    modeProfile: directorProfile,
                    agentConfig,
                    runtimeContext: skillRes.buildSkillRuntimeContext(
                        contextForNotes || null,
                        agentConfig,
                        { mode: 'director', name: String(directorProfile?.name || '').trim() },
                    ),
                });
                availableSkillsBlock = skillRes.buildAvailableSkillsBlock(visibleSkillsForSubAgent) || '';
            } catch (e) {
                console.warn('[orchestrator-director] sub-agent skill resolution failed:', e?.message || e);
            }
        }

        // Frame the sub-agent's prompt so it knows where its identity
        // ends and the roleplay material begins. Without this anti-RP
        // framing the model sometimes drifts into in-character prose
        // because the <story_context> block looks like a roleplay setup
        // and the role description (which used to be concatenated onto
        // the </story_context> close tag, unwrapped) read like another
        // scenario line rather than a meta-instruction.
        //
        // Order — identity-last so recency bias keeps the agent's role
        // fresh right before <task>. The payload's chat-completion
        // preset typically renders its own "You are {{char}}…" system
        // message inside <story_context>; placing <orchestration_role>
        // AFTER </story_context> lets it act as the corrective —
        // model reads the RP setup, then immediately reads "but you
        // are an orchestration agent", then executes the task. The
        // top-of-prompt meta-frame still tells the model where to
        // look for identity / task; it sets the frame, not the order.
        //
        // Defense against long story_context: when the chat-completion
        // payload is large (multi-thousand-token character cards, world
        // info, chat history), the META_FRAME at index 0 gets pushed
        // out of the model's recency window before it reaches the task.
        // META_REMINDER bridges </story_context> and <orchestration_role>
        // — a short anti-RP reset that reads "the story is over, you
        // are NOT a character in it, write a report TO the main agent".
        //
        //   1. META_FRAME — full anti-RP framing + termination protocol
        //      (story_context is read-only, identity is in
        //      <orchestration_role>, work is in <task>, terminate with
        //      a no-tool-call round that contains your final report).
        //   2. <story_context> ... </story_context> — chat history,
        //      character card, world info, last user turn (whatever
        //      the user's preset assembled).
        //   3. META_REMINDER — short anti-RP reset, fresh right after
        //      the RP material so recency bias works in our favor.
        //   4. <orchestration_role> — agent's persona / job
        //      description (stable across dispatches; volatile per-
        //      dispatch context moves to the trailing runtime_state).
        //   5. <task> — what to do (changes every dispatch by design).
        //   6. <runtime_state> (user role, optional) — Open Notes,
        //      available skills catalog, main-agent digest, current
        //      draft snapshot. All four are per-dispatch volatile, so
        //      they're packed into one user message at the tail to keep
        //      everything above byte-identical across dispatches for
        //      prompt-cache reuse.
        const META_FRAME = [
            'You are an orchestration agent embedded inside a roleplay session. The <story_context> block below is READ-ONLY narrative material — DO NOT continue the roleplay, do NOT emit any in-character prose, dialogue, or narration, and do NOT write "leaving the scene now"-style sign-offs. Your identity is defined inside <orchestration_role>; the specific work you must do is inside <task>. Volatile per-dispatch context (open notes, available skills catalog, main-agent digest, current draft snapshot) is delivered in a trailing <runtime_state> user message. Treat story_context only as background that informs how you carry out the task.',
            '',
            'Your reply is a structured report / analysis / recommendation written TO the main orchestration agent — never in-character prose. When the task is complete, write the report as your final assistant text and emit no tool calls; that text is what the runtime returns to the main agent. While you still need more information, call the appropriate read tools — the loop continues until you produce a no-tool-call round.',
        ].join('\n');

        const META_REMINDER = 'Reminder: the <story_context> above is reference material, not a scene to continue. You are an orchestration agent operating ON the story, not a character IN it. Your reply is a structured report written TO the main orchestration agent — not in-character prose, dialogue, or narration.';

        // Snapshot the in-flight assistant draft at dispatch time so sub-
        // agents that analyze the draft (critics, image_director,
        // notes_curator, memory_curator) can see it on round 1 without a
        // wasted get_draft round-trip. Empty draft → omitted from the
        // runtime_state block; sub-agents can still call get_draft to
        // read live state if the main agent mutates between dispatch and
        // their first round.
        const draftAtDispatch = handle && typeof handle.getText === 'function' ? handle.getText() : '';
        const currentDraftBlock = draftAtDispatch
            ? '<current_draft note="snapshot at dispatch; call get_draft to re-read if needed">\n' + draftAtDispatch + '\n</current_draft>'
            : '';
        const mainAgentDigestBlock = mainRoundsDigest
            ? '<main_agent_digest>\n' + mainRoundsDigest + '\n</main_agent_digest>'
            : '';
        const runtimeStateBody = [
            openNotesBlock,
            availableSkillsBlock,
            mainAgentDigestBlock,
            currentDraftBlock,
        ].filter(Boolean).join('\n\n');

        const subMessages = [
            { role: 'system', content: META_FRAME },
            { role: 'system', content: '<story_context>' },
            ...payloadMessages,
            { role: 'system', content: '</story_context>' },
            { role: 'system', content: META_REMINDER },
            { role: 'system', content: '<orchestration_role>\n' + (systemPrompt || '') + '\n</orchestration_role>' },
            { role: 'system', content: '<task>\n' + String(task || '') + '\n</task>' },
            ...(runtimeStateBody
                ? [{ role: 'user', content: '<runtime_state>\n' + runtimeStateBody + '\n</runtime_state>' }]
                : []),
        ];

        const childCtrl = makeChildAbort();
        childAborts.set(handleId, childCtrl);
        const childSignal = childCtrl.signal;

        const baseOpts = {
            apiPresetName,
            llmPresetName: promptPresetName,
            includeCharacterCard: false,
            worldInfoSource: 'none',
            customWorldInfoMessages: null,
            runtimeWorldInfo: null,
            abortSignal: childSignal,
        };

        const promise = (async () => {
            // Panel context for runOneRound — the dispatch round and
            // its reasoning + text sections were ensured at the top of
            // runDispatchInternal. We pass these ids per call so chunks
            // stream into the right slot even though the dispatch may be
            // pumping rounds in a loop.
            const panelCtx = { roundId, textSectionId, reasoningSectionId };
            try {
                let finalText = '';
                let converged = false;
                for (let r = 0; r < effectiveMaxRounds; r++) {
                    if (childSignal.aborted) {
                        break;
                    }
                    const { roundAssistantText, roundToolCalls, roundReasoningText, roundReasoningBlocks, roundReasoningDetails } = await runOneRound(subMessages, panelCtx, baseOpts, subToolSchemas);
                    if (roundToolCalls.length === 0) {
                        finalText = roundAssistantText;
                        converged = true;
                        // The terminator round has no tool calls and no
                        // assistant push (the runtime contract says final
                        // text returns to the main agent, not the
                        // conversation). Stamp `_round` on a synthetic
                        // assistant entry so the round-card renderer
                        // surfaces the final reply + reasoning under
                        // `Round r`. Without this, the user sees
                        // (rounds-1) cards even though the agent did r
                        // rounds.
                        subMessages.push({
                            role: 'assistant',
                            content: roundAssistantText || '',
                            reasoning: roundReasoningText || '',
                            ...(roundReasoningBlocks ? { reasoning_blocks: roundReasoningBlocks } : {}),
                            ...(roundReasoningDetails ? { reasoning_details: roundReasoningDetails } : {}),
                            _round: r,
                        });
                        break;
                    }
                    // Reshape `{name, args, raw}` → OpenAI-compatible
                    // `{id, type: 'function', function: {name, arguments}}`
                    // so the backend's OpenAI→Anthropic compat layer can
                    // pair the assistant `tool_use` block with the
                    // matching `tool_result` block by id. Without this,
                    // the id falls through as `undefined` / the tool
                    // name, breaking pairing and triggering 400
                    // "unexpected tool_use_id" from Anthropic. Same fix
                    // as the main-agent loop in director-runtime.js.
                    // `source` tags each call with the dispatch layer so
                    // the simulation-review popup can render a layer chip
                    // (builtin / extension / profile / st-bridge).
                    const assistantToolCallEntries = roundToolCalls.map(tc => ({
                        id: String(tc?.raw?.id || tc?.id || makeSubagentToolCallId()),
                        type: 'function',
                        function: {
                            name: String(tc?.name || ''),
                            arguments: safeStringifyArgs(tc?.args),
                        },
                        source: resolveToolSource(String(tc?.name || ''), { __customToolRegistry: customToolRegistry }),
                    }));
                    subMessages.push({
                        role: 'assistant',
                        content: roundAssistantText || null,
                        reasoning: roundReasoningText || '',
                        ...(roundReasoningBlocks ? { reasoning_blocks: roundReasoningBlocks } : {}),
                        ...(roundReasoningDetails ? { reasoning_details: roundReasoningDetails } : {}),
                        tool_calls: assistantToolCallEntries,
                        _round: r,
                    });
                    for (let i = 0; i < roundToolCalls.length; i += 1) {
                        // Mirror the main-agent loop's abort discipline:
                        // throw between tool iterations so a stop click
                        // unwinds this sub-agent's tool stream instead of
                        // running every queued tool to completion before
                        // the next round-boundary check. The parent
                        // signal is chained into childSignal at dispatch
                        // time, so this also catches main-level aborts.
                        throwIfAborted(childSignal);
                        const call = roundToolCalls[i];
                        const callId = assistantToolCallEntries[i].id;
                        const name = String(call?.name || '');
                        const args = call?.args;
                        // Record each sub-agent tool invocation as a
                        // section in this dispatch's round so the panel
                        // can show the same "tool: X" / "tool result: X"
                        // breakdown the main agent's rounds have. Section
                        // ids include round + tool index to keep them
                        // unique across the mini-loop's multi-round
                        // tool-call history.
                        const callSource = assistantToolCallEntries[i].source;
                        const toolCallSectionId = panelEnsureSection(
                            roundId,
                            `tool-${r}-${i}`,
                            'tool_call',
                            i18nFormat('Tool: ${0}', name),
                            { args, source: callSource },
                        );
                        panelAppendToSection(roundId, toolCallSectionId, stringifyForSection(args));
                        let toolResult;
                        if (name === 'get_draft') {
                            toolResult = await executeGetDraftTool(handle);
                        } else if (name === 'draft_search') {
                            toolResult = await executeDraftSearchTool(handle, args);
                        } else if (name === 'write_message') {
                            // Only reachable when tools.message.write_message
                            // is enabled — buildSubAgentToolSchemas gates the
                            // schema on the same flag. Reuses the same
                            // executor as the main agent, so both roles
                            // mutate the shared draft via the same handle.
                            toolResult = await executeWriteMessageTool(handle, args);
                        } else if (name === 'apply_message_patches') {
                            // Same gating as write_message. Roll-back-on-
                            // failure semantics are inherited from
                            // executeApplyPatchesTool.
                            toolResult = await executeApplyPatchesTool(handle, args);
                        } else if (typeof executeLoopTool === 'function') {
                            try {
                                // Inherit from `contextForNotes` so
                                // prototype-resolved methods (e.g.
                                // `updateChatState`, needed by Layer-2
                                // tools that lazily open chat-scoped
                                // state) survive on the dispatched ctx.
                                // See director-runtime.js's main-agent
                                // path for the matching pattern.
                                const toolCtx = Object.create(contextForNotes || null);
                                toolCtx.chat = chat;
                                toolCtx.__customToolRegistry = customToolRegistry;
                                // Mirror director-runtime.js main-agent path:
                                // give custom tools a stable sync way to read
                                // the in-flight draft body without round-tripping
                                // through the built-in `get_draft` tool.
                                toolCtx.director = {
                                    getDraft() {
                                        try {
                                            if (handle && typeof handle.getText === 'function') return handle.getText();
                                        } catch (_) { /* fall through */ }
                                        return '';
                                    },
                                };
                                // Sub-agent scoped skill visibility — see
                                // director-runtime.js main-agent path for
                                // matching wiring.
                                toolCtx.__visibleSkillsForAgent = visibleSkillsForSubAgent;
                                // Race against childSignal so a hanging
                                // tool can't pin this sub-agent open
                                // after stop. Same pattern + reasoning
                                // as the main-agent loop.
                                const raw = await raceAbortSignal(
                                    executeLoopTool(name, args, toolCtx),
                                    childSignal,
                                );
                                toolResult = { ok: true, result: raw };
                            } catch (err) {
                                // Let abort errors propagate to the
                                // outer try / catch which routes the
                                // sub-agent into the `cancelled` status
                                // exit; swallowing them here would mask
                                // the cancel as a generic tool failure
                                // in the messages stream and let the
                                // round loop charge ahead.
                                if (isAbortError(err, childSignal)) throw err;
                                toolResult = { ok: false, error: String(err?.message || err) };
                            }
                        } else {
                            toolResult = { ok: false, error: `tool execution unavailable: ${name}` };
                        }
                        subMessages.push({
                            role: 'tool',
                            tool_call_id: callId,
                            content: JSON.stringify(toolResult),
                            _round: r,
                        });
                        // Pair the tool-call section with a tool-result
                        // section so the panel renders both halves the
                        // same way the main agent's rounds render them.
                        const toolResultSectionId = panelEnsureSection(
                            roundId,
                            `tool-result-${r}-${i}`,
                            'tool_result',
                            i18nFormat('Tool result: ${0}', name),
                            { ok: !!toolResult?.ok, err: toolResult?.error || null },
                        );
                        panelAppendToSection(roundId, toolResultSectionId, stringifyForSection(toolResult));
                        panelSetSectionStatus(roundId, toolResultSectionId, toolResult?.ok ? 'done' : 'failed');
                        panelSetSectionStatus(roundId, toolCallSectionId, toolResult?.ok ? 'done' : 'failed');
                    }
                }
                if (childSignal.aborted && !converged) {
                    const msg = 'cancelled';
                    panelSetSectionStatus(roundId, reasoningSectionId, 'failed', { err: msg });
                    panelSetSectionStatus(roundId, textSectionId, 'failed', { err: msg });
                    panelSetRoundStatus(roundId, 'failed');
                    completionNotifications.push({ handleId, subagentId: displayId, status: 'cancelled', summary: msg });
                    return { handleId, subagentId: displayId, error: msg };
                }
                if (!converged) {
                    const msg = `did not converge within ${effectiveMaxRounds} rounds`;
                    panelSetSectionStatus(roundId, reasoningSectionId, 'failed', { err: msg });
                    panelSetSectionStatus(roundId, textSectionId, 'failed', { err: msg });
                    panelSetRoundStatus(roundId, 'failed');
                    completionNotifications.push({ handleId, subagentId: displayId, status: 'failed', summary: msg });
                    return { handleId, subagentId: displayId, error: msg };
                }
                panelSetSectionStatus(roundId, reasoningSectionId, 'done');
                panelSetSectionStatus(roundId, textSectionId, 'done');
                panelSetRoundStatus(roundId, 'done');
                completionNotifications.push({
                    handleId,
                    subagentId: displayId,
                    status: 'completed',
                    summary: `output: ${finalText.length} chars`,
                });
                return { handleId, subagentId: displayId, outputText: finalText };
            } catch (err) {
                const isAbort = err?.name === 'AbortError' || childSignal.aborted;
                const status = isAbort ? 'cancelled' : 'failed';
                const msg = isAbort ? 'cancelled' : String(err?.message || err);
                panelSetSectionStatus(roundId, reasoningSectionId, 'failed', { err: msg });
                panelSetSectionStatus(roundId, textSectionId, 'failed', { err: msg });
                panelSetRoundStatus(roundId, 'failed');
                completionNotifications.push({ handleId, subagentId: displayId, status, summary: msg });
                return { handleId, subagentId: displayId, error: msg };
            } finally {
                childAborts.delete(handleId);
            }
        })();
        inflight.set(handleId, promise);
        return handleId;
    }

    function cancel(handleId) {
        const id = String(handleId || '');
        const ctrl = childAborts.get(id);
        if (!ctrl) {
            // Already completed / never existed — no-op.
            return { ok: true, alreadyDone: true };
        }
        if (!ctrl.signal.aborted) {
            ctrl.abort();
        }
        return { ok: true };
    }

    async function awaitAll(handles) {
        const ids = Array.isArray(handles) ? handles : [];
        const promises = ids.map(h => {
            const p = inflight.get(h);
            if (!p) {
                return Promise.resolve({ handleId: h, error: 'unknown handle' });
            }
            return p;
        });
        return Promise.all(promises);
    }

    function drainCompletionNotifications() {
        // Splice = drain (in-place clear). Each completion is reported
        // exactly once; subsequent drains return the new completions only.
        return completionNotifications.splice(0);
    }

    return { dispatch, dispatchInline, awaitAll, cancel, drainCompletionNotifications };
}

function makeSubagentToolCallId() {
    return `subagent_tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeStringifyArgs(value) {
    return canonicalStringifyArgs(value);
}

function stringifyForSection(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/**
 * Append an "## Open Notes" block to a sub-agent's system prompt
 * if the notes adapter on contextForNotes returns any open entries.
 * Mirrors loop-runtime's injection so curator-style sub-agents
 * reading persisted notes get the same `[id] text` block format.
 *
 * Closed entries (status === 'closed') are filtered out — only open
 * threads are surfaced. Legacy entries without a status field default
 * to open (matching loop-runtime's `(status ?? 'open') === 'open'`
 * semantics).
 *
 * Each entry is rendered as `- [id] text` so the model can reference
 * notes by id (e.g., to close them via `note_close`).
 *
 * Called on every dispatch (not cached) so notes written by earlier
 * sub-agents in the same director session show up for later ones.
 * If no adapter is mounted, or it returns empty / only-closed, the
 * system prompt is returned unchanged.
 *
 * @internal exported for tests; consumers should call through the
 *           dispatcher's system_close assembly path.
 */
/**
 * Read the open-notes block for a sub-agent dispatch. Returns an empty
 * string when no notes adapter is mounted, the adapter throws, or the
 * filtered list is empty so callers can compose it into a runtime-state
 * body without conditional guards. Format matches the loop-runtime and
 * main-agent renderers (`- [id] text` per entry) so the same close-by-id
 * contract applies everywhere notes appear in the prompt stack.
 *
 * Closed entries (status === 'closed') are filtered out — only open
 * threads are surfaced. Legacy entries without a status field default
 * to open (matching loop-runtime's `(status ?? 'open') === 'open'`
 * semantics).
 *
 * Called on every dispatch (not cached) so notes written by earlier
 * sub-agents in the same director session show up for later ones.
 *
 * @internal exported for tests; consumers should call through the
 *           dispatcher's runtime-state assembly path.
 */
export async function loadSubAgentOpenNotesBlock(contextForNotes) {
    const fs = contextForNotes && contextForNotes.__floorStateForNotes;
    if (!fs || typeof fs.listAcrossFloors !== 'function') return '';
    let all;
    try {
        all = await fs.listAcrossFloors();
    } catch (_) {
        return '';
    }
    if (!Array.isArray(all) || all.length === 0) return '';
    const open = all.filter(e => e && typeof e === 'object' && (e.status ?? 'open') === 'open');
    if (open.length === 0) return '';
    const lines = ['## Open Notes (your plot-author threads — close with note_close when deployed)'];
    for (const e of open) {
        lines.push(`- [${String(e.id || '')}] ${String(e.text || '')}`);
    }
    return lines.join('\n');
}

/**
 * Back-compat wrapper around `loadSubAgentOpenNotesBlock` kept for tests
 * that still target the prior "concat into systemPrompt" shape. New call
 * sites should use `loadSubAgentOpenNotesBlock` and place the block in a
 * trailing `<runtime_state>` user message instead.
 *
 * @internal exported for tests; consumers should call through the
 *           dispatcher's runtime-state assembly path.
 */
export async function renderSubSystemPromptWithNotes(systemPrompt, contextForNotes) {
    const block = await loadSubAgentOpenNotesBlock(contextForNotes);
    if (!block) return systemPrompt;
    return `${systemPrompt}\n\n${block}`;
}

/**
 * Render main agent's orchestration history (rounds past the main
 * system prompt and chat history) into a single labeled string for
 * inclusion as ONE user-role message in a sub-agent's view.
 *
 * Returns null if there are no main rounds to render (round 0
 * dispatch — main has done nothing yet — has nothing to surface).
 *
 * The `chatHistoryLength` parameter is the count of messages between the
 * leading system message and the main agent's own tool-using rounds. The
 * main agent assembles its messages array as
 * `[system_open, ...contentPayload.messages, system_close, ...rounds]`,
 * so callers pass `contentPayload.messages.length + 1` (the +1 accounts
 * for the `</story_context>` close — the open is the leading system
 * message that `startIndex = 1 + chatHistoryLength` already skips).
 * `startIndex = 1 + chatHistoryLength` then resolves to the first
 * post-prefix round.
 *
 * The digest deliberately renders structural tool_calls / tool
 * messages as plain text under "### Main agent reasoning" / "###
 * Tool result" headings rather than splicing them in as real
 * `assistant` / `tool` messages. This prevents the sub-agent from
 * mistaking main's history for its own dialogue and from mimicking
 * main's tool-call rhythm (see spec section "Why a digest container").
 */
export function renderMainAgentDigest(parentMessages, chatHistoryLength) {
    if (!Array.isArray(parentMessages) || parentMessages.length === 0) return null;
    const startIndex = 1 + Math.max(0, Number(chatHistoryLength) || 0);
    const rounds = parentMessages.slice(startIndex);
    if (rounds.length === 0) return null;

    // Only assistant + tool messages are rendered into the digest. The
    // main agent's task-brief user message (and any other user-role
    // entries that might slip into the slice) carries no orchestration
    // history. If the slice contains only such entries, there's nothing
    // worth rendering — return null so callers omit the digest message
    // entirely (round-0 dispatch behavior).
    const hasRenderable = rounds.some(m => m && typeof m === 'object' && (m.role === 'assistant' || m.role === 'tool'));
    if (!hasRenderable) return null;

    const lines = [];
    lines.push('## Main agent context (background, not dialogue)');
    lines.push('The following is the main orchestrating agent\'s reasoning and tool-result history up to the moment it dispatched you. This is BACKGROUND for understanding your task — not a conversation you are continuing. Your actual task is in the next message.');
    lines.push('');

    for (const msg of rounds) {
        if (!msg || typeof msg !== 'object') continue;
        if (msg.role === 'assistant') {
            const text = String(msg.content || '').trim();
            const toolNames = Array.isArray(msg.tool_calls)
                ? msg.tool_calls.map(tc => tc?.function?.name || '').filter(Boolean)
                : [];
            if (!text && toolNames.length === 0) continue;
            lines.push('### Main agent reasoning');
            if (text) lines.push(text);
            if (toolNames.length > 0) {
                lines.push(`[Main agent invoked tools: ${toolNames.join(', ')}]`);
            }
            lines.push('');
        } else if (msg.role === 'tool') {
            lines.push('### Tool result');
            lines.push(String(msg.content || ''));
            lines.push('');
        }
    }

    return lines.join('\n').trimEnd();
}
