/**
 * Director mode tools — schemas + executors.
 *
 * Three groups:
 *   1. Loop-inherited tools (chat / lorebook / memory / note / search) —
 *      available to both main and sub-agents, gated by the same
 *      `profile.tools.<ns>.<verb>` nested flag schema loop mode uses.
 *   2. Collaboration tools (dispatch_subagent / await_subagents) —
 *      main agent only.
 *   3. Message-production tools (write_message / apply_message_patches /
 *      finalize) — main agent only.
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
import {
    appendText,
    applyPatch,
    EditorOpsError,
    ensureReasoningSection,
    appendToReasoningSection,
    markReasoningSectionStatus,
} from './editor-ops.js';
import { isAbortError } from './abort-utils.js';

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
 * (`settings.llmNodeApiPresetName`). Mirrors loop/agenda/spec convention
 * (`resolveOrchestrationAgentApiPresetName` in `agent-resolution.js`) but
 * inlined here because that module transitively imports `extensions.js`
 * → `lib.js`, which can't be loaded under Node test env.
 */
function resolveAgentApiPresetName(settings, agentConfig) {
    return String(agentConfig?.apiPresetName || '').trim()
        || String(settings?.llmNodeApiPresetName || '').trim();
}

/**
 * Mirror of `resolveOrchestrationAgentPromptPresetName` for chat-
 * completion preset names. Per-spec setting wins; falls back to the
 * orchestrator's global LLM-node setting (`settings.llmNodePresetName`).
 */
function resolveAgentPromptPresetName(settings, agentConfig) {
    return String(agentConfig?.promptPresetName || '').trim()
        || String(settings?.llmNodePresetName || '').trim();
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
        description: 'Apply context_replace patches. Each patch finds an exact byte-for-byte substring in the current message and replaces it. The `find` string MUST be unique in the current message body — include enough surrounding context (typically 1–3 lines before and/or after the target) to make it so. If `find` matches multiple locations, the call fails — extend the context until it is unique. No fuzzy / heuristic matching: whitespace, case, indentation, line endings, and Unicode form must all match exactly.',
        parameters: {
            type: 'object',
            properties: {
                patches: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            kind: { type: 'string', enum: ['context_replace'] },
                            find: { type: 'string', description: 'Exact substring (with surrounding context for uniqueness).' },
                            replaceWith: { type: 'string', description: 'Replacement text.' },
                        },
                        required: ['kind', 'find', 'replaceWith'],
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
    const messageProduction = [WRITE_MESSAGE_TOOL, APPLY_MESSAGE_PATCHES_TOOL, GET_DRAFT_TOOL, FINALIZE_TOOL];
    const loop = loopToolSchemasFor(tools, customToolRegistry);
    return [...collab, ...messageProduction, ...loop];
}

export function buildSubAgentToolSchemas({ tools, customToolRegistry = null }) {
    // Sub-agents always get get_draft (lets analysts read the in-flight
    // draft) plus whichever loop tools the profile enables. They do NOT
    // get the message-editing tools or the dispatch/cancel collaboration
    // tools — only the main agent writes the message and only the main
    // agent dispatches.
    return [GET_DRAFT_TOOL, ...loopToolSchemasFor(tools, customToolRegistry)];
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

// ── Sub-agent dispatcher ──

/**
 * Default cap on the sub-agent's own tool-call mini-loop. Used when a
 * sub-agent profile does not pin its own `maxRounds`. Independent from
 * the main agent's `maxRounds` — sub-agents are expected to converge in
 * modest rounds (gather context, then emit a final text response). The
 * cap is a runaway safety net; in practice a short critic finishes in
 * 1-3 rounds, and a recall-style sub-agent (memory_scout /
 * memory_curator) doing schema + a few find_by_name + brief + 1-2 drill
 * calls fits in ~10-12 rounds. 16 gives those a comfortable headroom
 * without letting a runaway burn the whole turn. Users / AI iteration
 * can override per sub-agent via `subAgents[].maxRounds` (clamped to
 * [1, 50] by the sanitizer); `null` keeps this default.
 */
const SUB_AGENT_MAX_ROUNDS = 16;

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
 * `profile.tools.<ns>.<verb>`). Sub-agents CANNOT call
 * `dispatch_subagent` (no recursion) or the message-editing tools
 * (`write_message` / `apply_message_patches` / `finalize`) — only the
 * main agent owns the message body. `buildSubAgentToolSchemas` enforces
 * this by returning only the loop-tool subset.
 *
 * Deps:
 *   - subAgents: profile.subAgents — id → spec lookup.
 *   - limits: { maxTotalSubagentRuns } — budget for the entire turn.
 *   - generateTask: non-streaming fallback (takes opts, returns terminal
 *     result). Always required (used when no stream provider is given,
 *     or as a last resort).
 *   - generateTaskStream: optional streaming provider (takes opts,
 *     returns { stream, result }). When provided, sub-agent text deltas
 *     pipe chunk-by-chunk into the reasoning fold's named section so
 *     the user sees them grow live. When absent, the dispatcher falls
 *     back to generateTask and the section gets each round's text in
 *     one shot.
 *   - handle: MessageEditorHandle for the in-flight assistant message.
 *     Required when live streaming is desired; if omitted, sections are
 *     not surfaced and the inflight promise still resolves to the
 *     terminal output (legacy callers that don't care about visibility).
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
    handle,
    getContentPayload,
    abortSignal,
    tools,
    executeLoopTool,
    chat,
    trace,
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

    function sectionLabel(handleId, subagentId) {
        return `${handleId}: ${subagentId}`;
    }

    function safeEnsureSection(label) {
        if (!handle) return;
        try { ensureReasoningSection(handle, label); }
        catch (e) { console.debug('[orchestrator-director] ensureReasoningSection failed:', e); }
    }

    function safeAppendToSection(label, delta) {
        if (!handle) return;
        try { appendToReasoningSection(handle, label, delta); }
        catch (e) { console.debug('[orchestrator-director] appendToReasoningSection failed:', e); }
    }

    function safeMarkSectionStatus(label, status) {
        if (!handle) return;
        try { markReasoningSectionStatus(handle, label, status); }
        catch (e) { console.debug('[orchestrator-director] markReasoningSectionStatus failed:', e); }
    }

    // ── Trace recording helpers ──
    // Each dispatch (preconfigured or inline) is recorded as one entry
    // in trace.director.subagents the moment it starts. The entry's
    // `conversation.messages` aliases the live subMessages array so the
    // trace popup can render the sub-agent's full mini-loop conversation
    // when it's opened. Finish updates status + outputText / error.
    function recordSubagentStart({ handleId, subagentId, isInline, task, systemPrompt, subMessages }) {
        if (!trace || typeof trace !== 'object') return null;
        if (!trace.director || typeof trace.director !== 'object') return null;
        if (!Array.isArray(trace.director.subagents)) {
            trace.director.subagents = [];
        }
        const entry = {
            handleId: String(handleId || ''),
            subagentId: String(subagentId || ''),
            isInline: Boolean(isInline),
            task: String(task || ''),
            systemPromptPreview: isInline ? String(systemPrompt || '').slice(0, 240) : '',
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: '',
            outputText: '',
            reasoningText: '',
            error: '',
            conversation: { messages: subMessages },
        };
        trace.director.subagents.push(entry);
        return entry;
    }

    function recordSubagentFinish(entry, { status, outputText, error, reasoningText }) {
        if (!entry) return;
        entry.status = String(status || 'completed');
        entry.finishedAt = new Date().toISOString();
        if (typeof outputText === 'string') entry.outputText = outputText;
        if (typeof error === 'string') entry.error = error;
        if (typeof reasoningText === 'string') entry.reasoningText = reasoningText;
    }

    function recordSubagentSyntheticFailure({ handleId, subagentId, isInline, task, status, error }) {
        if (!trace || typeof trace !== 'object') return;
        if (!trace.director || typeof trace.director !== 'object') return;
        if (!Array.isArray(trace.director.subagents)) {
            trace.director.subagents = [];
        }
        const now = new Date().toISOString();
        trace.director.subagents.push({
            handleId: String(handleId || ''),
            subagentId: String(subagentId || ''),
            isInline: Boolean(isInline),
            task: String(task || ''),
            systemPromptPreview: '',
            status: String(status || 'failed'),
            startedAt: now,
            finishedAt: now,
            outputText: '',
            reasoningText: '',
            error: String(error || ''),
            conversation: { messages: [] },
        });
    }

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

    async function runOneRound(subMessages, sectionLabelForChunks, baseOpts, subToolSchemas) {
        const callOpts = {
            ...baseOpts,
            taskMessages: subMessages,
            tools: subToolSchemas,
            toolChoice: subToolSchemas.length > 0 ? 'auto' : undefined,
        };
        // Transport-error retry honors `settings.toolCallRetryMax` —
        // same convention as `requestToolCallsWithRetry` (loop / agenda /
        // spec). User-initiated aborts re-throw without retry.
        const transportRetries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
        let transportAttempt = 0;
        while (true) {
            let roundText = '';
            let roundReasoning = '';
            let roundResult;
            try {
                if (typeof generateTaskStream === 'function') {
                    const { stream, result } = generateTaskStream(callOpts);
                    for await (const chunk of stream) {
                        if (!chunk || typeof chunk !== 'object') continue;
                        if (typeof chunk.delta !== 'string') continue;
                        if (chunk.type === 'text') {
                            roundText += chunk.delta;
                            safeAppendToSection(sectionLabelForChunks, chunk.delta);
                        } else if (chunk.type === 'reasoning') {
                            // Reasoning is captured for the trace popup only,
                            // not the message reasoning fold. The labeled
                            // section in the fold keeps only the sub-agent's
                            // assistant output, free of interleaved thinking.
                            roundReasoning += chunk.delta;
                        }
                    }
                    roundResult = await result;
                } else {
                    roundResult = await generateTask(callOpts);
                    roundText = String(roundResult?.assistantText ?? '');
                    roundReasoning = String(roundResult?.reasoning ?? '');
                    if (roundText) safeAppendToSection(sectionLabelForChunks, roundText);
                }
            } catch (transportErr) {
                if (isAbortError(transportErr, baseOpts?.abortSignal)) throw transportErr;
                transportAttempt += 1;
                if (transportAttempt > transportRetries) throw transportErr;
                console.warn(`[orchestrator-director] sub-agent transport attempt ${transportAttempt}/${transportRetries + 1} failed; retrying:`, transportErr);
                continue;
            }
            const roundToolCalls = Array.isArray(roundResult?.toolCalls)
                ? roundResult.toolCalls.filter(tc => String(tc?.name || '').trim().length > 0)
                : [];
            const roundAssistantText = String(roundResult?.assistantText ?? roundText);
            const roundReasoningText = roundReasoning || String(roundResult?.reasoning ?? '');
            return { roundAssistantText, roundToolCalls, roundReasoningText };
        }
    }

    async function dispatch({ subagentId, task, __parentMessages }) {
        const handleId = newHandleId();
        const label = sectionLabel(handleId, subagentId);
        if (totalRuns >= maxTotalSubagentRuns) {
            safeEnsureSection(label);
            safeMarkSectionStatus(label, `error: budget exhausted (max=${maxTotalSubagentRuns})`);
            const errMsg = `subagent budget exhausted (maxTotalSubagentRuns=${maxTotalSubagentRuns})`;
            inflight.set(handleId, Promise.resolve({
                handleId,
                subagentId,
                error: errMsg,
            }));
            completionNotifications.push({ handleId, subagentId, status: 'failed', summary: errMsg });
            recordSubagentSyntheticFailure({ handleId, subagentId, isInline: false, task, status: 'failed', error: errMsg });
            return handleId;
        }
        const spec = byId.get(subagentId);
        if (!spec) {
            safeEnsureSection(label);
            const errMsg = `unknown sub-agent id: ${subagentId}`;
            safeMarkSectionStatus(label, `error: ${errMsg}`);
            inflight.set(handleId, Promise.resolve({
                handleId,
                subagentId,
                error: errMsg,
            }));
            completionNotifications.push({ handleId, subagentId, status: 'failed', summary: errMsg });
            recordSubagentSyntheticFailure({ handleId, subagentId, isInline: false, task, status: 'failed', error: errMsg });
            return handleId;
        }
        return runDispatchInternal({
            handleId,
            displayId: subagentId,
            isInline: false,
            label,
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
        // For inline (ad-hoc) dispatches we tag the section label as
        // `(inline)` rather than a profile-configured sub-agent id, so
        // the user can tell at a glance which dispatches are reusable
        // roles vs. one-off scratchpads.
        const displayId = '(inline)';
        const label = sectionLabel(handleId, displayId);
        if (totalRuns >= maxTotalSubagentRuns) {
            safeEnsureSection(label);
            safeMarkSectionStatus(label, `error: budget exhausted (max=${maxTotalSubagentRuns})`);
            const errMsg = `subagent budget exhausted (maxTotalSubagentRuns=${maxTotalSubagentRuns})`;
            inflight.set(handleId, Promise.resolve({
                handleId,
                subagentId: displayId,
                error: errMsg,
            }));
            completionNotifications.push({ handleId, subagentId: displayId, status: 'failed', summary: errMsg });
            recordSubagentSyntheticFailure({ handleId, subagentId: displayId, isInline: true, task, status: 'failed', error: errMsg });
            return handleId;
        }
        const trimmedPrompt = String(systemPrompt || '').trim();
        if (!trimmedPrompt) {
            safeEnsureSection(label);
            const errMsg = 'dispatch_inline_subagent requires non-empty systemPrompt';
            safeMarkSectionStatus(label, `error: ${errMsg}`);
            inflight.set(handleId, Promise.resolve({
                handleId,
                subagentId: displayId,
                error: errMsg,
            }));
            completionNotifications.push({ handleId, subagentId: displayId, status: 'failed', summary: errMsg });
            recordSubagentSyntheticFailure({ handleId, subagentId: displayId, isInline: true, task, status: 'failed', error: errMsg });
            return handleId;
        }
        return runDispatchInternal({
            handleId,
            displayId,
            isInline: true,
            label,
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

    async function runDispatchInternal({ handleId, displayId, isInline, label, systemPrompt, apiPresetName, promptPresetName, task, parentMessages, agentTools, agentMaxRounds, agentConfig = null }) {
        totalRuns++;
        safeEnsureSection(label);
        // Effective per-dispatch round cap: per-agent override if pinned,
        // otherwise the module-level default. Already clamped to [1, 50]
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

        // Augment sub-agent system prompt with the "## Open Notes"
        // block (mirrors loop-runtime). Re-read on every dispatch so
        // notes written by earlier sub-agents in this session show up
        // for later ones. No-op when the adapter isn't mounted.
        const baseSystemPrompt = await renderSubSystemPromptWithNotes(systemPrompt, contextForNotes);

        // Resolve visible skills for this sub-agent. Mode-level default
        // lives on `directorProfile.skills`; per-sub-agent `skills` (when
        // present on `agentConfig`) layers via the `+` inheritance idiom.
        // Failure falls back to an empty list — the dispatch proceeds, the
        // tools resolve via the global fallback in agent-tools.js, and the
        // catalog block is omitted.
        let visibleSkillsForSubAgent = [];
        let baseSystemPromptWithSkills = baseSystemPrompt;
        if (directorProfile) {
            try {
                const skillRes = await loadSkillResolution();
                visibleSkillsForSubAgent = await skillRes.resolveAgentVisibleSkills({
                    modeProfile: directorProfile,
                    agentConfig,
                    runtimeContext: skillRes.buildSkillRuntimeContext(contextForNotes || null, agentConfig),
                });
                const block = skillRes.buildAvailableSkillsBlock(visibleSkillsForSubAgent);
                if (block) baseSystemPromptWithSkills = baseSystemPrompt + '\n\n' + block;
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
        //      description (plus Open Notes if any), sitting right
        //      before the task instruction so the model reads its
        //      identity last.
        //   5. <main_agent_digest> (optional) and <task> — what to do.
        const META_FRAME = [
            'You are an orchestration agent embedded inside a roleplay session. The <story_context> block below is READ-ONLY narrative material — DO NOT continue the roleplay, do NOT emit any in-character prose, dialogue, or narration, and do NOT write "leaving the scene now"-style sign-offs. Your identity is defined inside <orchestration_role>; the specific work you must do is inside <task>. Treat story_context only as background that informs how you carry out the task.',
            '',
            'Your reply is a structured report / analysis / recommendation written TO the main orchestration agent — never in-character prose. When the task is complete, write the report as your final assistant text and emit no tool calls; that text is what the runtime returns to the main agent. While you still need more information, call the appropriate read tools — the loop continues until you produce a no-tool-call round.',
        ].join('\n');

        const META_REMINDER = 'Reminder: the <story_context> above is reference material, not a scene to continue. You are an orchestration agent operating ON the story, not a character IN it. Your reply is a structured report written TO the main orchestration agent — not in-character prose, dialogue, or narration.';

        // Snapshot the in-flight assistant draft at dispatch time and inject
        // it as a system block so sub-agents that analyze the draft (critics,
        // image_director, notes_curator, memory_curator) can see it on round
        // 1 without a wasted get_draft round-trip. Empty draft → omit the
        // block; sub-agents can still call get_draft to read live state if
        // the main agent mutates between dispatch and their first round.
        const draftAtDispatch = handle && typeof handle.getText === 'function' ? handle.getText() : '';
        const draftBlock = draftAtDispatch
            ? [{ role: 'system', content: '<current_draft note="snapshot at dispatch; call get_draft to re-read if needed">\n' + draftAtDispatch + '\n</current_draft>' }]
            : [];

        const subMessages = [
            { role: 'system', content: META_FRAME },
            { role: 'system', content: '<story_context>' },
            ...payloadMessages,
            { role: 'system', content: '</story_context>' },
            { role: 'system', content: META_REMINDER },
            { role: 'system', content: '<orchestration_role>\n' + (baseSystemPromptWithSkills || '') + '\n</orchestration_role>' },
            ...(mainRoundsDigest ? [{ role: 'system', content: '<main_agent_digest>\n' + mainRoundsDigest + '\n</main_agent_digest>' }] : []),
            ...draftBlock,
            { role: 'system', content: '<task>\n' + String(task || '') + '\n</task>' },
        ];

        // Record the dispatch in the trace BEFORE kicking off the
        // background promise — the trace popup can show "running"
        // entries as soon as it's opened.
        const traceEntry = recordSubagentStart({
            handleId,
            subagentId: displayId,
            isInline,
            task,
            systemPrompt: baseSystemPrompt,
            subMessages,
        });

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
            // Declared outside the try so the catch arm can include any
            // reasoning the sub-agent emitted before the throw — without
            // this, a transport / abort error after the first round
            // tripped a ReferenceError in the catch's recordSubagentFinish
            // call (try-block `let` is not visible in catch).
            let aggregatedReasoning = '';
            try {
                let finalText = '';
                let converged = false;
                for (let r = 0; r < effectiveMaxRounds; r++) {
                    if (childSignal.aborted) {
                        break;
                    }
                    const { roundAssistantText, roundToolCalls, roundReasoningText } = await runOneRound(subMessages, label, baseOpts, subToolSchemas);
                    if (roundReasoningText) {
                        if (aggregatedReasoning) aggregatedReasoning += '\n\n';
                        aggregatedReasoning += roundReasoningText;
                    }
                    if (roundToolCalls.length === 0) {
                        finalText = roundAssistantText;
                        converged = true;
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
                        tool_calls: assistantToolCallEntries,
                        _round: r,
                    });
                    for (let i = 0; i < roundToolCalls.length; i += 1) {
                        const call = roundToolCalls[i];
                        const callId = assistantToolCallEntries[i].id;
                        const name = String(call?.name || '');
                        const args = call?.args;
                        let toolResult;
                        if (name === 'get_draft') {
                            toolResult = await executeGetDraftTool(handle);
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
                                // Sub-agent scoped skill visibility — see
                                // director-runtime.js main-agent path for
                                // matching wiring.
                                toolCtx.__visibleSkillsForAgent = visibleSkillsForSubAgent;
                                const raw = await executeLoopTool(name, args, toolCtx);
                                toolResult = { ok: true, result: raw };
                            } catch (err) {
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
                    }
                }
                if (childSignal.aborted && !converged) {
                    const msg = 'cancelled';
                    safeMarkSectionStatus(label, `error: ${msg}`);
                    completionNotifications.push({ handleId, subagentId: displayId, status: 'cancelled', summary: msg });
                    recordSubagentFinish(traceEntry, { status: 'cancelled', error: msg, reasoningText: aggregatedReasoning });
                    return { handleId, subagentId: displayId, error: msg };
                }
                if (!converged) {
                    const msg = `did not converge within ${effectiveMaxRounds} rounds`;
                    safeMarkSectionStatus(label, `error: ${msg}`);
                    completionNotifications.push({ handleId, subagentId: displayId, status: 'failed', summary: msg });
                    recordSubagentFinish(traceEntry, { status: 'failed', error: msg, reasoningText: aggregatedReasoning });
                    return { handleId, subagentId: displayId, error: msg };
                }
                safeMarkSectionStatus(label, '');
                completionNotifications.push({
                    handleId,
                    subagentId: displayId,
                    status: 'completed',
                    summary: `output: ${finalText.length} chars`,
                });
                recordSubagentFinish(traceEntry, { status: 'completed', outputText: finalText, reasoningText: aggregatedReasoning });
                return { handleId, subagentId: displayId, outputText: finalText };
            } catch (err) {
                const isAbort = err?.name === 'AbortError' || childSignal.aborted;
                const status = isAbort ? 'cancelled' : 'failed';
                const msg = isAbort ? 'cancelled' : String(err?.message || err);
                safeMarkSectionStatus(label, `error: ${msg}`);
                completionNotifications.push({ handleId, subagentId: displayId, status, summary: msg });
                recordSubagentFinish(traceEntry, { status, error: msg, reasoningText: aggregatedReasoning });
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
    try {
        return JSON.stringify(value && typeof value === 'object' ? value : {});
    } catch {
        return '{}';
    }
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
export async function renderSubSystemPromptWithNotes(systemPrompt, contextForNotes) {
    const fs = contextForNotes && contextForNotes.__floorStateForNotes;
    if (!fs || typeof fs.listAcrossFloors !== 'function') return systemPrompt;
    let all;
    try {
        all = await fs.listAcrossFloors();
    } catch (_) {
        return systemPrompt;
    }
    if (!Array.isArray(all) || all.length === 0) return systemPrompt;
    const open = all.filter(e => e && typeof e === 'object' && (e.status ?? 'open') === 'open');
    if (open.length === 0) return systemPrompt;
    const lines = ['', '## Open Notes (your plot-author threads — close with note_close when deployed)'];
    for (const e of open) {
        lines.push(`- [${String(e.id || '')}] ${String(e.text || '')}`);
    }
    return `${systemPrompt}${lines.join('\n')}`;
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
    lines.push("The following is the main orchestrating agent's reasoning and tool-result history up to the moment it dispatched you. This is BACKGROUND for understanding your task — not a conversation you are continuing. Your actual task is in the next message.");
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
