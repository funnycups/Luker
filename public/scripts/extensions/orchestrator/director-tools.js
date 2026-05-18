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

import { FINALIZE_TOOL_SCHEMA, getEnabledToolSchemas } from './loop-tools.js';
import {
    appendText,
    applyPatch,
    EditorOpsError,
    ensureReasoningSection,
    appendToReasoningSection,
    markReasoningSectionStatus,
} from './editor-ops.js';
import { isAbortError } from './abort-utils.js';

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

function loopToolSchemasFor(tools) {
    const all = getEnabledToolSchemas({ tools });
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

export function buildMainAgentToolSchemas({ subAgents, tools }) {
    const hasSubAgents = Array.isArray(subAgents) && subAgents.length > 0;
    // `dispatch_inline_subagent`, `await_subagents`, and `cancel_subagent`
    // are ALWAYS available — the main agent can dispatch an ad-hoc
    // sub-agent role at any time (even when the profile has no
    // pre-configured sub-agents), and the await / cancel handles work
    // for any in-flight sub-agent regardless of how it was dispatched.
    // `dispatch_subagent` (the by-id variant) only appears when there
    // is at least one configured sub-agent to dispatch — otherwise it
    // would have no valid targets.
    const collab = [
        ...(hasSubAgents ? [DISPATCH_SUBAGENT_TOOL] : []),
        DISPATCH_INLINE_SUBAGENT_TOOL,
        AWAIT_SUBAGENTS_TOOL,
        CANCEL_SUBAGENT_TOOL,
    ];
    const messageProduction = [WRITE_MESSAGE_TOOL, APPLY_MESSAGE_PATCHES_TOOL, GET_DRAFT_TOOL, FINALIZE_TOOL];
    const loop = loopToolSchemasFor(tools);
    return [...collab, ...messageProduction, ...loop];
}

export function buildSubAgentToolSchemas({ tools }) {
    // Sub-agents always get get_draft (lets analysts read the in-flight
    // draft) plus whichever loop tools the profile enables. They do NOT
    // get the message-editing tools or the dispatch/cancel collaboration
    // tools — only the main agent writes the message and only the main
    // agent dispatches.
    return [GET_DRAFT_TOOL, ...loopToolSchemasFor(tools)];
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
 * Default cap on the sub-agent's own tool-call mini-loop. Independent
 * from the main agent's `maxRounds` — sub-agents are expected to
 * converge quickly (gather context, then emit a final text response).
 * The cap is a runaway safety net; in practice a well-prompted sub-agent
 * either calls one or two read tools and answers, or just answers from
 * the cached chat history directly.
 */
const SUB_AGENT_MAX_ROUNDS = 8;

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
 *   - subAgents: profile.director.subAgents — id → spec lookup.
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
 *   - contextForMemory: optional overlay carrying `__memoryStore` (and
 *     anything else `loop-runtime::attachMemoryStore` mounts in the
 *     future). Spread into the per-tool-call context so memory_* tools
 *     find a live store — without this, sub-agents hit MEMORY_DISABLED
 *     even when memory-graph is enabled. Mounted by main.js once per
 *     director turn; shared by reference across every tool call.
 */
export function createSubagentDispatcher({
    subAgents,
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
    contextForMemory,
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

    const subToolSchemas = buildSubAgentToolSchemas({ tools: tools || {} });

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
            error: '',
            conversation: { messages: subMessages },
        };
        trace.director.subagents.push(entry);
        return entry;
    }

    function recordSubagentFinish(entry, { status, outputText, error }) {
        if (!entry) return;
        entry.status = String(status || 'completed');
        entry.finishedAt = new Date().toISOString();
        if (typeof outputText === 'string') entry.outputText = outputText;
        if (typeof error === 'string') entry.error = error;
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

    async function runOneRound(subMessages, sectionLabelForChunks, baseOpts) {
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
            let roundResult;
            try {
                if (typeof generateTaskStream === 'function') {
                    const { stream, result } = generateTaskStream(callOpts);
                    for await (const chunk of stream) {
                        if (!chunk || typeof chunk !== 'object') continue;
                        if (typeof chunk.delta !== 'string') continue;
                        if (chunk.type === 'text' || chunk.type === 'reasoning') {
                            roundText += chunk.delta;
                            safeAppendToSection(sectionLabelForChunks, chunk.delta);
                        }
                    }
                    roundResult = await result;
                } else {
                    roundResult = await generateTask(callOpts);
                    roundText = String(roundResult?.assistantText ?? '');
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
            return { roundAssistantText, roundToolCalls };
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
        });
    }

    async function runDispatchInternal({ handleId, displayId, isInline, label, systemPrompt, apiPresetName, promptPresetName, task, parentMessages }) {
        totalRuns++;
        safeEnsureSection(label);

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
        // shared prefix. Main agent's `parentMessages` starts with
        // [system_open, ...payload, system_close] (same shape we build
        // below for the sub) then its tool-using rounds — so the prefix
        // we ask `renderMainAgentDigest` to skip is
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

        const subMessages = [
            { role: 'system', content: '<story_context>' },
            ...payloadMessages,
            { role: 'system', content: '</story_context>' + (baseSystemPrompt ? '\n\n' + baseSystemPrompt : '') },
            ...(mainRoundsDigest ? [{ role: 'system', content: '<main_agent_digest>\n' + mainRoundsDigest + '\n</main_agent_digest>' }] : []),
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
            try {
                let finalText = '';
                let converged = false;
                for (let r = 0; r < SUB_AGENT_MAX_ROUNDS; r++) {
                    if (childSignal.aborted) {
                        break;
                    }
                    const { roundAssistantText, roundToolCalls } = await runOneRound(subMessages, label, baseOpts);
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
                    const assistantToolCallEntries = roundToolCalls.map(tc => ({
                        id: String(tc?.raw?.id || tc?.id || makeSubagentToolCallId()),
                        type: 'function',
                        function: {
                            name: String(tc?.name || ''),
                            arguments: safeStringifyArgs(tc?.args),
                        },
                    }));
                    subMessages.push({
                        role: 'assistant',
                        content: roundAssistantText || null,
                        tool_calls: assistantToolCallEntries,
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
                                const raw = await executeLoopTool(name, args, { ...(contextForMemory || {}), chat });
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
                        });
                    }
                }
                if (childSignal.aborted && !converged) {
                    const msg = 'cancelled';
                    safeMarkSectionStatus(label, `error: ${msg}`);
                    completionNotifications.push({ handleId, subagentId: displayId, status: 'cancelled', summary: msg });
                    recordSubagentFinish(traceEntry, { status: 'cancelled', error: msg });
                    return { handleId, subagentId: displayId, error: msg };
                }
                if (!converged) {
                    const msg = `did not converge within ${SUB_AGENT_MAX_ROUNDS} rounds`;
                    safeMarkSectionStatus(label, `error: ${msg}`);
                    completionNotifications.push({ handleId, subagentId: displayId, status: 'failed', summary: msg });
                    recordSubagentFinish(traceEntry, { status: 'failed', error: msg });
                    return { handleId, subagentId: displayId, error: msg };
                }
                safeMarkSectionStatus(label, '');
                completionNotifications.push({
                    handleId,
                    subagentId: displayId,
                    status: 'completed',
                    summary: `output: ${finalText.length} chars`,
                });
                recordSubagentFinish(traceEntry, { status: 'completed', outputText: finalText });
                return { handleId, subagentId: displayId, outputText: finalText };
            } catch (err) {
                const isAbort = err?.name === 'AbortError' || childSignal.aborted;
                const status = isAbort ? 'cancelled' : 'failed';
                const msg = isAbort ? 'cancelled' : String(err?.message || err);
                safeMarkSectionStatus(label, `error: ${msg}`);
                completionNotifications.push({ handleId, subagentId: displayId, status, summary: msg });
                recordSubagentFinish(traceEntry, { status, error: msg });
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
