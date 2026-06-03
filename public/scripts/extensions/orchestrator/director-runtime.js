/**
 * Director-mode runtime.
 *
 * Subscribes (via `main.js` wiring) to `GENERATE_TAKEOVER_DISPATCH`;
 * when the active profile is in director mode and the generation type
 * is supported, claims the editor handle and runs the main-agent
 * tool-calling loop in the background. The main loop is configurable
 * via `deps.runMainLoop` for testability; production uses the
 * `runMainAgentLoop` defined in this module.
 *
 * Placeholder + live-render contract:
 *   - The core `Generate()` path does NOT pre-allocate the placeholder
 *     message slot for takeover. Subscribers own that. We require
 *     `deps.acquirePlaceholderMessageId(eventData)` to return the chat
 *     index the editor handle should write into. Production (main.js
 *     wiring) pushes a fresh empty bottom-of-chat message for `normal`
 *     generation, or returns the in-place last-message index for
 *     `continue` / `swipe` / `regenerate` where ST has already set up
 *     the slot. Tests inject a stub that points at chat[0].
 *
 * Lifecycle contract:
 *   - `handleDirectorDispatch` returns synchronously (relative to the
 *     event emit). It assigns `eventData.takeoverHandle` so the core
 *     `Generate()` path can await `handle.complete`.
 *   - The main loop runs concurrently; on completion it must either
 *     commit or discard. The wrapper here guarantees that on any
 *     thrown error the handle is discarded so `handle.complete` always
 *     settles.
 */

import { ORCH_EXECUTION_MODE_DIRECTOR } from './director-defaults.js';
import { isAbortError } from './abort-utils.js';
import { resolveAgentToolFlags } from './persistence.js';
import { createMessageEditorHandle } from '../../message-takeover.js';
import {
    buildMainAgentToolSchemas,
    createSubagentDispatcher,
    executeWriteMessageTool,
    executeApplyPatchesTool,
    executeFinalizeTool,
    executeGetDraftTool,
} from './director-tools.js';
import {
    appendToReasoningSection,
    ensureReasoningSection,
    markReasoningSectionStatus,
} from './editor-ops.js';
import { buildPerRunCustomToolRegistry } from './per-run-custom-tools.js';
import { resolveToolSource } from './loop-tools.js';

// Skill-resolution helpers are loaded lazily inside the dispatch path so the
// transitive import chain (skill-resolution → skillsApi → script.js → lib.js)
// stays out of module evaluation. Unit tests that exercise pure helpers
// (`buildAgentTaskMessages`, sanitizer contracts) never call the dispatcher
// and therefore never trigger the dynamic import — the lib.js dependency
// remains test-friendly.
let _skillResolutionPromise = null;
async function loadSkillResolution() {
    if (!_skillResolutionPromise) {
        _skillResolutionPromise = import('./skill-resolution.js');
    }
    return _skillResolutionPromise;
}

/**
 * Resolve the connection-profile name for a director agent: per-agent
 * setting wins; falls back to the orchestrator's global LLM-node setting
 * (`settings.llmNodeApiPresetName`). Mirrors loop/agenda/spec convention
 * (`resolveOrchestrationAgentApiPresetName` in `agent-resolution.js`) but
 * inlined here because the agent-resolution module transitively imports
 * `extensions.js` → `lib.js`, which can't be loaded under Node test env.
 */
function resolveAgentApiPresetName(settings, agentConfig) {
    return String(agentConfig?.apiPresetName || '').trim()
        || String(settings?.llmNodeApiPresetName || '').trim();
}

/**
 * Mirror of `resolveOrchestrationAgentPromptPresetName` for chat-
 * completion preset names. Per-agent setting wins; falls back to the
 * orchestrator's global LLM-node setting (`settings.llmNodePresetName`).
 */
function resolveAgentPromptPresetName(settings, agentConfig) {
    return String(agentConfig?.promptPresetName || '').trim()
        || String(settings?.llmNodePresetName || '').trim();
}
// Note: we intentionally do NOT import from `runtime-trace.js` directly.
// That module transitively pulls in `defaults.js` → `script.js` →
// `lib.js`, which is a browser-only bundle and breaks Node test
// environments that exercise the director runtime in isolation. The
// caller (main.js) wires `deps.finalizeTrace` to the real
// `finalizeOrchestrationRuntimeTrace`; tests pass a no-op or a mock.

const SUPPORTED_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);

/**
 * Event subscriber entry point. Inspects the active profile and, when
 * appropriate, claims the takeover handle for director mode.
 *
 * Deps:
 *   - profile: orchestrator profile (must have `mode` field).
 *   - chat: live chat array; used to seed the handle with originalText /
 *     originalReasoning from the target slot. The plugin does NOT mutate
 *     chat — the kernel (script.js takeover branch) subscribes to
 *     setOnUpdate and owns chat writes + DOM redraw + message_updated.
 *   - acquirePlaceholderMessageId(eventData): returns the message index
 *     the takeover will write into. Required: tests inject a stub; in
 *     production main.js returns the slot kernel will allocate.
 *   - runMainLoop?: optional override for the main-agent loop function.
 *   - generateTask / generateTaskStreamForMainAgent / getContentPayload /
 *     executeLoopTool: forwarded to the loop runner.
 */
export async function handleDirectorDispatch(eventData, deps) {
    const { profile, chat } = deps || {};
    if (!profile || profile.mode !== ORCH_EXECUTION_MODE_DIRECTOR) return;
    if (!SUPPORTED_TYPES.has(eventData?.type)) return;
    if (eventData.takeoverHandle) return;

    // Resolve the target message id. The kernel owns chat-array mutation
    // (placeholder push, DOM bubble render, message_updated emits) in
    // production via its own setOnUpdate listener; this acquirer only
    // needs to point at the slot the takeover will eventually write
    // into so we can seed the handle with its current text/reasoning
    // (originals are used by the buffer for `continue` prefix checks
    // and for the `discarded` outcome shape).
    let messageId;
    try {
        const acquirer = typeof deps?.acquirePlaceholderMessageId === 'function'
            ? deps.acquirePlaceholderMessageId
            : null;
        if (!acquirer) {
            console.warn('[orchestrator-director] no acquirePlaceholderMessageId provided; cannot claim takeover');
            return;
        }
        messageId = await acquirer(eventData);
        if (!Number.isInteger(messageId) || messageId < 0) {
            console.warn(`[orchestrator-director] acquirePlaceholderMessageId returned invalid id: ${messageId}`);
            return;
        }
    } catch (err) {
        console.warn('[orchestrator-director] acquirePlaceholderMessageId threw:', err);
        return;
    }

    // Buffer-only handle: no chat array, no event emit. The kernel
    // (script.js takeover branch) subscribes to setOnUpdate and is
    // responsible for mirroring text/reasoning back into chat[slot]
    // plus repainting the DOM. Tests install their own adapter.
    const slot = chat && Number.isInteger(messageId) ? chat[messageId] : null;
    const handle = createMessageEditorHandle({
        generationType: eventData.type,
        originalText: String(slot?.mes ?? ''),
        originalReasoning: String(slot?.extra?.reasoning ?? ''),
        abortSignal: eventData.abortSignal,
        owner: 'orchestrator-director',
    });
    eventData.takeoverHandle = handle;

    const runMainLoop = typeof deps.runMainLoop === 'function' ? deps.runMainLoop : runMainAgentLoop;

    // Background runner — the core Generate() path awaits handle.complete,
    // so we must guarantee complete eventually settles. We translate the
    // loop's terminal condition into the takeover API's three states:
    //   - natural return / maxRounds → commit (kernel runs full finalize)
    //   - user abort → abort (kernel keeps partial visible, skips finalize)
    //   - other thrown error → commit with [error] marker (preserve partial
    //     for debugging; user wants to see how far the turn got)
    //   - if commit / abort themselves throw → fall back to discard so
    //     handle.complete still settles
    void (async () => {
        try {
            await runMainLoop({ handle, profile, eventData, deps });
            if (!handle.complete._settled) {
                await handle.commit();
            }
        } catch (err) {
            const userAborted = isAbortError(err, eventData?.abortSignal);
            if (userAborted) {
                console.info('[orchestrator-director] main loop aborted by user');
            } else {
                console.warn('[orchestrator-director] main loop threw:', err);
            }
            // Surface the failure to the user via a toast (or whatever
            // visible channel the caller wired). Without this, the only
            // signal that the generation died is the `### [error]`
            // section appended to the reasoning fold — easy to miss
            // when the fold is collapsed. Director owns the takeover
            // dispatch, so ST's core sender never gets to toast for us.
            //
            // Skip the toast when the user themselves clicked stop —
            // a user-initiated abort isn't an error, and ST core's own
            // sender stays silent in the same situation.
            if (!userAborted) {
                try {
                    if (typeof deps?.notifyError === 'function') {
                        deps.notifyError(String(err?.message || err), err);
                    }
                } catch (notifyErr) {
                    console.warn('[orchestrator-director] notifyError threw:', notifyErr);
                }
            }
            if (!handle.complete._settled) {
                // Append a marker into the reasoning fold so the user can
                // see the turn ended unnaturally (vs. a clean finalize).
                try {
                    const current = handle.getReasoning();
                    const sep = current ? '\n\n' : '';
                    const marker = userAborted
                        ? '### [aborted]'
                        : `### [error]\n${String(err?.message || err)}`;
                    handle.setReasoning(`${current}${sep}${marker}`);
                } catch (_) { /* reasoning append is best-effort */ }
                try {
                    if (userAborted) {
                        // User stop: preserve partial output but signal
                        // the kernel to skip the finalize pipeline
                        // (MESSAGE_RECEIVED emit, persistence,
                        // autoContinue) — those are for natural
                        // completion, not user-driven cancel. Same
                        // contract as ST core streaming's
                        // `isStreamFinished` gate: stopped → partial
                        // visible, no save, no emit.
                        await handle.abort();
                    } else {
                        // Real error (network drop, backend 500, etc.):
                        // commit so the kernel runs the full pipeline.
                        // The user wants to see how far the turn got
                        // before the backend died AND have it persisted
                        // for debugging / manual recovery.
                        await handle.commit();
                    }
                } catch (settleErr) {
                    console.warn('[orchestrator-director] settle-after-error failed, falling back to discard:', settleErr);
                    try {
                        if (!handle.complete._settled) await handle.discard();
                    } catch (_) { /* swallow — complete must settle */ }
                }
            }
        } finally {
            // Finalize the runtime trace with the resolved handle status
            // so the trace popup shows a terminal state instead of
            // "running" forever. Trace creation is optional (caller may
            // not have supplied one), so guard. The actual finalize
            // function is injected via deps to avoid a hard import of
            // runtime-trace.js (which transitively breaks the node test
            // environment).
            if (deps?.trace && typeof deps?.finalizeTrace === 'function') {
                let traceStatus = 'completed';
                try {
                    const outcome = await handle.complete;
                    const handleStatus = String(outcome?.status || '');
                    if (handleStatus === 'committed') traceStatus = 'completed';
                    else if (handleStatus === 'aborted') traceStatus = 'cancelled';
                    else if (handleStatus === 'discarded') traceStatus = 'cancelled';
                    else traceStatus = handleStatus || 'completed';
                } catch (_) {
                    traceStatus = 'failed';
                }
                try {
                    deps.finalizeTrace(deps.trace, traceStatus);
                } catch (_) { /* trace is best-effort */ }
            }
        }
    })();
}

/**
 * Read open notes from a `contextForNotes` adapter for prepending to
 * the main agent's system prompt. Mirrors the loop-runtime and sub-
 * agent renderer semantics: an entry without an explicit `status`
 * field is treated as open (legacy data shape from before the
 * open/closed state machine landed). Returns `[]` for any unhappy
 * path — missing adapter, adapter without `listAcrossFloors`,
 * thrown listAcrossFloors, non-array return — so callers can blindly
 * pass the result to `renderMainAgentSystemPromptWithOpenNotes`
 * without further null-checking.
 *
 * @internal exported for tests.
 *
 * @param {object|null|undefined} contextForNotes
 * @returns {Promise<Array<{id: string, text: string}>>}
 */
export async function readOpenNotesFromContextForNotes(contextForNotes) {
    const fs = contextForNotes && contextForNotes.__floorStateForNotes;
    if (!fs || typeof fs.listAcrossFloors !== 'function') return [];
    let all;
    try {
        all = await fs.listAcrossFloors();
    } catch (_) {
        return [];
    }
    if (!Array.isArray(all)) return [];
    return all
        .filter(e => e && typeof e === 'object' && (e.status ?? 'open') === 'open')
        .map(e => ({ id: String(e.id || ''), text: String(e.text || '') }));
}

/**
 * Prepend a "## Open Notes" block to the main agent's system prompt
 * when there are any open notes. Empty (or null/undefined) list →
 * the prompt is returned unchanged so the boundary is invisible to
 * the model when there's nothing to surface. Format mirrors the
 * loop-runtime and sub-agent renderers (`- [id] text` per entry) so
 * the same close-by-id contract applies everywhere notes appear in
 * the prompt stack.
 *
 * @internal exported for tests.
 *
 * @param {string} systemPrompt - the bare instruction string
 * @param {Array<{id: string, text: string}>|null|undefined} openNotes
 * @returns {string}
 */
export function renderMainAgentSystemPromptWithOpenNotes(systemPrompt, openNotes) {
    const open = Array.isArray(openNotes) ? openNotes : [];
    if (open.length === 0) return systemPrompt;
    const lines = ['## Open Notes (your plot-author threads — close with note_close when deployed)'];
    for (const n of open) {
        lines.push(`- [${String(n.id || '')}] ${String(n.text || '')}`);
    }
    const block = lines.join('\n');
    return systemPrompt ? `${systemPrompt}\n\n${block}` : block;
}

/**
 * Production main-agent loop. Tests inject a stub via `deps.runMainLoop`.
 *
 * Tools:
 *   - `dispatch_subagent` / `await_subagents`: routed through the dispatcher
 *     created from `profile.subAgents`.
 *   - `write_message` / `apply_message_patches` / `finalize`: routed through
 *     the director-tools executors.
 *   - Other tool names: delegated to `deps.executeLoopTool` (the central
 *     loop-tools dispatcher). If absent, an `unknown tool` tool-result is
 *     fed back so the agent can self-correct.
 *
 * The loop terminates when:
 *   - `finalize` succeeded → returns immediately.
 *   - `maxRounds` was reached → auto-commits current state.
 *   - `abortSignal` aborts.
 *
 * Each round MUST produce at least one tool call. A round with zero
 * tool calls is treated as a failed request (model balked: refusal,
 * truncation, silent text-only reply) and discarded — the assistant
 * turn is not pushed into `messages` and not recorded in the trace,
 * and the same history is re-requested. After `settings.toolCallRetryMax`
 * consecutive failed attempts the loop throws. `finalize` is the only
 * legitimate way to exit; `maxRounds` is just the upper bound.
 */
export async function runMainAgentLoop({ handle, profile, eventData, deps }) {
    // Profile shape post-flatten: top-level mainAgent / subAgents / limits.
    // Legacy callers may still pass `{ mode, director: {...} }`; auto-detect
    // so both shapes round-trip cleanly during the migration window.
    const safeProfile = profile && typeof profile === 'object' ? profile : {};
    const director = safeProfile.director && typeof safeProfile.director === 'object'
        ? safeProfile.director
        : safeProfile;
    const limits = {
        maxRounds: Number(director.maxRounds) > 0 ? Number(director.maxRounds) : 20,
        maxConcurrentSubagents: Number(director.maxConcurrentSubagents) > 0 ? Number(director.maxConcurrentSubagents) : 4,
        maxTotalSubagentRuns: Number(director.maxTotalSubagentRuns) > 0 ? Number(director.maxTotalSubagentRuns) : 16,
    };
    // Same range/parsing as tool-calling.js so user-facing semantics of
    // "Tool-call retries (on invalid/missing)" are uniform across
    // orchestrator modes. 0 = no retry (one shot, then throw).
    const maxNoToolRetries = Math.max(0, Math.min(10, Math.floor(Number(deps?.settings?.toolCallRetryMax) || 0)));
    // Empty systemPrompt sends an empty instruction — defaults are
    // materialized into the profile at creation/reset time (see
    // `createDefaultDirectorProfile` in director-defaults.js and the
    // `director-reset-main-prompt` button in main.js), so the textarea
    // is the single source of truth. An empty field means the user
    // really wants an empty instruction, not a hidden fallback.
    const systemPrompt = String(director.mainAgent?.systemPrompt || '');

    // Layer-3 custom tools live on the profile root. Built once per
    // director run and threaded into both the main agent (its tool
    // schemas + per-call executeLoopTool ctx) and every sub-agent
    // dispatch (via createSubagentDispatcher's deps bag, which forwards
    // it into the sub-agent's tool schemas + ctx the same way).
    const customToolRegistry = buildPerRunCustomToolRegistry(safeProfile, deps?.trace, deps?.recordTraceEvent);

    const toolSchemas = buildMainAgentToolSchemas({
        subAgents: director.subAgents || [],
        // Main agent tools: per-agent override (object) wins; null falls
        // back to profile-level default. Same cascade sub-agent dispatch
        // uses, just rooted at director.mainAgent.tools instead of
        // subAgents[i].tools.
        tools: resolveAgentToolFlags(director.mainAgent?.tools, director.tools) || {},
        customToolRegistry,
    });

    // Resolve the cached content payload (captured by
    // `wireDirectorPresetLifecycle` at GENERATE_TAKEOVER_DISPATCH). The
    // same payload backs both the main agent's taskMessages and every
    // sub-agent dispatch — single source of truth for character /
    // persona / WI / chat-history this turn. When the caller didn't
    // wire a getter (test stubs, legacy callers) the helper coerces
    // null safely and the agent still gets its instruction + context
    // header.
    const getContentPayload = typeof deps?.getContentPayload === 'function'
        ? deps.getContentPayload
        : () => null;
    const contentPayload = getContentPayload();

    const dispatcher = createSubagentDispatcher({
        subAgents: director.subAgents || [],
        // Mode profile carried for sub-agent skill resolution. The
        // dispatcher reads `directorProfile.skills` to seed the
        // mode-level visibility default; per-sub-agent overrides
        // (subAgents[i].skills) layer via the `+` inheritance idiom.
        directorProfile: director,
        limits,
        settings: deps?.settings,
        generateTask: deps?.generateTask,
        // When the main.js wiring passed a streaming provider, sub-agent
        // output streams chunk-by-chunk into its own named section of
        // the reasoning fold (so parallel sub-agents are visible live
        // without character-level interleaving). Without it, the
        // dispatcher falls back to non-streaming and the section gets
        // the terminal text in one shot.
        generateTaskStream: deps?.generateTaskStream,
        handle,
        getContentPayload,
        abortSignal: eventData?.abortSignal,
        // Sub-agents run their own tool-call mini-loop using the same
        // loop tools the main agent has access to (chat / lorebook /
        // memory / note / search — gated by the same profile.tools
        // flags). Message-editing tools and dispatch_subagent are NOT
        // exposed to sub-agents; only the main agent owns the message
        // body, and sub-agents cannot recurse.
        tools: director.tools || {},
        executeLoopTool: deps?.executeLoopTool,
        chat: deps?.chat,
        // Runtime trace, optional. When present the dispatcher records
        // each subagent dispatch (handleId, role, task, status, output,
        // conversation alias) into trace.director.subagents — the trace
        // popup reads from there.
        trace: deps?.trace,
        // Notes adapter context (same shape loop-runtime mounts on its
        // own context for the note_open / note_close tools). When
        // provided:
        //   - the main agent's system prompt gets a "## Open Notes"
        //     block prepended (filtered to status=open), so it can
        //     reason about ongoing plot threads when dispatching.
        //   - each sub-agent dispatch re-reads the floor-state notes
        //     and prepends the same "## Open Notes" block to the
        //     sub-agent's system prompt.
        // — mirrors loop-runtime's behavior so the curator / pickup-
        // scout pipeline sees the same surface as the loop agent does.
        contextForNotes: deps?.contextForNotes,
        // Layer-3 customTools registry compiled once at the top of this
        // run. The dispatcher forwards it into each sub-agent's tool
        // schemas (`buildSubAgentToolSchemas`) and into the ctx passed
        // to `executeLoopTool` for each sub-agent tool call.
        customToolRegistry,
    });

    // Prepend an `## Open Notes` block to the main agent's system
    // prompt when the notes adapter carries any open entries. Mirrors
    // the sub-agent renderer (`renderSubSystemPromptWithNotes`) and
    // the loop runtime so the same notes surface — same id-prefixed
    // format, same filter-on-open semantics — is visible whether the
    // turn runs through loop, director main, or a director sub-agent.
    // Empty list → systemPrompt unchanged.
    const openNotesForMain = await readOpenNotesFromContextForNotes(deps?.contextForNotes);
    const systemPromptWithOpenNotes = renderMainAgentSystemPromptWithOpenNotes(systemPrompt, openNotesForMain);

    // Resolve visible skills for the main agent + append the
    // `<available_skills>` catalog block to the system prompt. The
    // resolver loads the inventory lazily so test environments that
    // never reach this branch (the orchestrator tests stub `runMainLoop`)
    // don't pay the import cost. Visible skills also get threaded into
    // each tool-call's ctx below so skill_list / skill_read / skill_search
    // see the scoped visibility instead of the fail-open global fallback.
    let visibleSkillsForMain = [];
    let mainSystemPromptWithSkills = systemPromptWithOpenNotes;
    try {
        const skillRes = await loadSkillResolution();
        visibleSkillsForMain = await skillRes.resolveAgentVisibleSkills({
            modeProfile: director,
            agentConfig: director.mainAgent || null,
            runtimeContext: skillRes.buildSkillRuntimeContext(
                deps?.contextForNotes || null,
                director.mainAgent || null,
            ),
        });
        const block = skillRes.buildAvailableSkillsBlock(visibleSkillsForMain);
        if (block) mainSystemPromptWithSkills = systemPromptWithOpenNotes + '\n\n' + block;
    } catch (e) {
        // Resolution failure must not abort the agent run. Fall back to
        // an empty visible list (tools resolve via global fallback) and
        // skip the catalog block.
        console.warn('[orchestrator-director] skill resolution failed:', e?.message || e);
    }

    const messages = buildAgentTaskMessages(
        { systemPrompt: mainSystemPromptWithSkills },
        contentPayload,
    );

    // Alias the live messages array onto the director trace so the
    // trace popup can render the main agent's running conversation.
    // Mutations to `messages` below show up in the popup at open time
    // (the alias is by reference). Append per-round records to the
    // structured rounds list as well — those give a stable view even
    // if the messages array shape changes between rounds.
    const trace = deps?.trace || null;
    if (trace?.director?.mainAgent && typeof trace.director.mainAgent === 'object') {
        if (!trace.director.mainAgent.conversation || typeof trace.director.mainAgent.conversation !== 'object') {
            trace.director.mainAgent.conversation = { messages };
        } else {
            trace.director.mainAgent.conversation.messages = messages;
        }
        if (!Array.isArray(trace.director.mainAgent.rounds)) {
            trace.director.mainAgent.rounds = [];
        }
    }

    for (let round = 0; round < limits.maxRounds; round++) {
        if (eventData?.abortSignal?.aborted) {
            // User clicked stop between rounds. Use handle.abort() to
            // preserve whatever sub-agent reasoning + partial main-agent
            // output the user has been watching, but signal the kernel
            // to skip its natural-completion finalize pipeline (no
            // emit / persist / autoContinue). Discarding here would
            // wipe the entire reasoning fold, which is the opposite of
            // what the user wants when they stop mid-orchestration.
            if (!handle.complete._settled) {
                try { await handle.abort(); } catch (_) { /* abort is idempotent / best-effort */ }
            }
            return;
        }

        // Snapshot the main-agent history visible to any sub-agent
        // dispatched during this round. Captured BEFORE generate so the
        // snapshot ends on a complete round boundary (last completed
        // round's assistant + tool_results) and contains no in-flight
        // tool-call pending state. Forwarded as __parentMessages to
        // dispatch_subagent / dispatch_inline_subagent below.
        const parentMessagesForRound = messages.slice();
        // Drain sub-agent completion notifications since last round and
        // inject them as system messages so the main agent learns about
        // completed (or cancelled / failed) sub-agents without polling.
        // Each handle is reported exactly once; the drainer clears the
        // queue. The notification is independent of await — it only says
        // "X is done, you can await it now"; the actual output still
        // arrives via await_subagents.
        const notifs = typeof dispatcher.drainCompletionNotifications === 'function'
            ? dispatcher.drainCompletionNotifications()
            : [];
        for (const n of notifs) {
            const tail = n.status === 'completed'
                ? `completed (${n.summary || 'no summary'}). Call await_subagents(["${n.handleId}"]) to retrieve the output.`
                : `${n.status} — ${n.summary || ''}`;
            messages.push({
                role: 'system',
                content: `[Runtime] sub-agent ${n.handleId} (${n.subagentId}) ${tail}`,
            });
        }
        // Anchor a named section for this round's main-agent output so
        // text chunks can flow into the reasoning fold as they arrive,
        // not at round-end. Unique per round (`main-0`, `main-1`, …) so
        // multiple rounds don't collide on the same section header —
        // they need to read top-to-bottom in arrival order alongside any
        // sub-agent sections that get dispatched mid-round.
        // No-tool-call retry inner loop. Each round MUST produce a
        // tool call; an empty toolCalls list means the model balked
        // and we discard that attempt entirely — not pushed into
        // `messages`, not recorded in the trace — and re-request the
        // same history until `toolCallRetryMax` is exhausted.
        let result;
        let toolCalls;
        let noToolRetries = 0;
        let mainSectionId;
        // Reasoning is captured for the trace popup only (per user's
        // request). It is NOT forwarded into the message reasoning fold
        // — that channel stays text-only so the user still sees agent
        // output without internal thinking interleaved.
        let reasoningAccum = '';
        while (true) {
            mainSectionId = noToolRetries === 0
                ? `main-${round}`
                : `main-${round}-r${noToolRetries}`;
            ensureReasoningSection(handle, mainSectionId, { status: 'running' });
            let chunkReceived = false;
            reasoningAccum = '';
            // Transport-error retry honors `settings.toolCallRetryMax` —
            // the same setting loop/agenda/spec modes already respect via
            // `requestToolCallsWithRetry`. Director's main agent bypasses
            // that wrapper (it needs onChunk for live UI), so we replicate
            // the retry semantics inline. User-initiated aborts re-throw
            // without retry.
            const transportRetries = Math.max(0, Math.min(10, Math.floor(Number(deps?.settings?.toolCallRetryMax) || 0)));
            let transportAttempt = 0;
            while (true) {
                try {
                    result = await deps.generateTaskStreamForMainAgent({
                        taskMessages: messages,
                        tools: toolSchemas,
                        toolChoice: 'auto',
                        apiPresetName: resolveAgentApiPresetName(deps?.settings, director.mainAgent),
                        llmPresetName: resolveAgentPromptPresetName(deps?.settings, director.mainAgent),
                        includeCharacterCard: false,
                        worldInfoSource: 'none',
                        customWorldInfoMessages: null,
                        runtimeWorldInfo: null,
                        abortSignal: eventData?.abortSignal,
                        onChunk: (chunk) => {
                            if (chunk?.type === 'text' && typeof chunk.delta === 'string' && chunk.delta.length > 0) {
                                chunkReceived = true;
                                appendToReasoningSection(handle, mainSectionId, chunk.delta);
                            } else if (chunk?.type === 'reasoning' && typeof chunk.delta === 'string' && chunk.delta.length > 0) {
                                reasoningAccum += chunk.delta;
                            }
                        },
                    });
                    break;
                } catch (transportErr) {
                    if (isAbortError(transportErr, eventData?.abortSignal)) throw transportErr;
                    transportAttempt += 1;
                    if (transportAttempt > transportRetries) throw transportErr;
                    console.warn(`[orchestrator-director] main agent transport attempt ${transportAttempt}/${transportRetries + 1} failed; retrying:`, transportErr);
                }
            }
            if (!chunkReceived) {
                // Non-streaming transport or tool-only stream: section
                // header is in place but body is empty. Append the
                // assembled assistantText so the fold still reflects
                // what the model said this attempt.
                const text = String(result?.assistantText || '');
                if (text) {
                    appendToReasoningSection(handle, mainSectionId, text);
                }
            }
            const rawToolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
            // Drop placeholder tool_calls with empty name — streaming
            // can flush these when the model started a tool_use block
            // and bailed mid-stream. Anthropic rejects empty-name
            // entries, and semantically they aren't actionable.
            toolCalls = rawToolCalls.filter(tc => String(tc?.name || '').trim().length > 0);
            if (toolCalls.length > 0) {
                try { markReasoningSectionStatus(handle, mainSectionId, ''); } catch (_) { /* non-fatal */ }
                break;
            }
            try { markReasoningSectionStatus(handle, mainSectionId, 'failed: no tool call'); } catch (_) { /* non-fatal */ }
            noToolRetries++;
            if (noToolRetries > maxNoToolRetries) {
                // Push the exhausted round to the trace BEFORE throwing.
                // The success-path push at the bottom of the round-for-loop
                // never runs once we throw, so without this the trace shows
                // zero rounds even though `### [main-N] (failed: no tool call)`
                // sections were appended to the reasoning fold. `status` lets
                // consumers distinguish from the success path (where the
                // bottom-of-loop push omits the field).
                if (trace?.director?.mainAgent?.rounds) {
                    trace.director.mainAgent.rounds.push({
                        round,
                        startedAt: new Date().toISOString(),
                        assistantText: String(result?.assistantText || ''),
                        reasoningText: reasoningAccum || String(result?.reasoning || ''),
                        toolCalls: [],
                        status: 'failed-no-tool-call',
                    });
                }
                throw new Error(`Main agent produced no tool call after ${maxNoToolRetries + 1} attempt(s) (toolCallRetryMax=${maxNoToolRetries}).`);
            }
        }
        // Record this round in the trace (structured view, independent
        // of the messages-array alias) so the popup can show a per-round
        // breakdown of what the main agent said and what tools it called.
        // `source` tags each call with the layer that will serve the
        // dispatch (builtin / extension / profile / st-bridge / unknown)
        // so the simulation-review popup can render a layer chip.
        if (trace?.director?.mainAgent?.rounds) {
            const ctxForSource = { __customToolRegistry: customToolRegistry };
            trace.director.mainAgent.rounds.push({
                round,
                startedAt: new Date().toISOString(),
                assistantText: String(result?.assistantText || ''),
                reasoningText: reasoningAccum || String(result?.reasoning || ''),
                toolCalls: Array.isArray(toolCalls)
                    ? toolCalls.map(tc => {
                        const cloned = structuredClone(tc);
                        cloned.source = resolveToolSource(String(tc?.name || ''), ctxForSource);
                        return cloned;
                    })
                    : [],
            });
        }
        // text already streamed into the reasoning fold via onChunk;
        // no extra reasoning append needed here.
        // Reshape the toolCalls from generateTask's `{name, args, raw}`
        // form back into OpenAI's
        // `{id, type: 'function', function: {name, arguments}}` form
        // before pushing them onto the messages array. The backend
        // re-serializes this turn for the next round's request; the
        // OpenAI→Anthropic compat layer requires every `tool_result`
        // block to reference a `tool_use_id` that appeared on the
        // preceding assistant turn. Without this reshape, the `id` field
        // is null/empty and Anthropic rejects with
        //   "unexpected tool_use_id found in tool_result blocks: <name>"
        // (the runtime had fallen back to using the tool name as the id,
        // which doesn't match the assistant turn's generated tool_use id).
        const assistantToolCallEntries = toolCalls.map(tc => ({
            id: String(tc?.raw?.id || tc?.id || makeDirectorToolCallId()),
            type: 'function',
            function: {
                name: String(tc?.name || ''),
                arguments: safeStringifyArgs(tc?.args),
            },
            source: resolveToolSource(String(tc?.name || ''), { __customToolRegistry: customToolRegistry }),
        }));
        // Push assistant turn with reshaped tool-call records so the
        // next round's history is well-formed.
        messages.push({
            role: 'assistant',
            content: result.assistantText || null,
            tool_calls: assistantToolCallEntries,
        });

        let finalized = false;
        for (let i = 0; i < toolCalls.length; i += 1) {
            const call = toolCalls[i];
            const callId = assistantToolCallEntries[i].id;
            const name = String(call?.name || '');
            const args = call?.args;
            let toolResult;
            if (name === 'dispatch_subagent') {
                const h = await dispatcher.dispatch({ ...(args || {}), __parentMessages: parentMessagesForRound });
                toolResult = { ok: true, handle: h };
            } else if (name === 'dispatch_inline_subagent') {
                const h = await dispatcher.dispatchInline({ ...(args || {}), __parentMessages: parentMessagesForRound });
                toolResult = { ok: true, handle: h };
            } else if (name === 'await_subagents') {
                const results = await dispatcher.awaitAll(args?.handles || []);
                toolResult = { ok: true, results };
                // No reasoning-fold surfacing here on purpose: the
                // dispatcher already streamed each sub-agent's chunks
                // into its own named section as they arrived. Re-emitting
                // the terminal text on await would duplicate everything
                // the user has already been watching.
            } else if (name === 'write_message') {
                toolResult = await executeWriteMessageTool(handle, args);
            } else if (name === 'apply_message_patches') {
                toolResult = await executeApplyPatchesTool(handle, args);
            } else if (name === 'get_draft') {
                toolResult = await executeGetDraftTool(handle);
            } else if (name === 'cancel_subagent') {
                toolResult = dispatcher.cancel(args?.handle);
            } else if (name === 'finalize') {
                toolResult = await executeFinalizeTool(handle);
                finalized = !!toolResult.ok;
            } else if (typeof deps?.executeLoopTool === 'function') {
                try {
                    // Inherit from `contextForNotes` (which itself inherits
                    // from the SillyTavern context via `Object.create`) so
                    // prototype-resolved methods like `updateChatState` —
                    // needed by Layer-2 tools that lazily open chat-scoped
                    // state, e.g. memory-graph's session — remain reachable.
                    // Spread would drop them; `Object.create` preserves the
                    // chain. The own-property overlays below carry the
                    // per-call notes adapter, chat slice, and custom-tool
                    // registry.
                    const toolCtx = Object.create(deps?.contextForNotes || null);
                    toolCtx.chat = deps.chat;
                    toolCtx.__customToolRegistry = customToolRegistry;
                    // Thread the resolved visible-skills list onto the
                    // ctx so any skill_list / skill_read / skill_search
                    // calls dispatched through this loop see the agent's
                    // scoped visibility instead of falling back to the
                    // global skill inventory.
                    toolCtx.__visibleSkillsForAgent = visibleSkillsForMain;
                    const raw = await deps.executeLoopTool(name, args, toolCtx);
                    toolResult = { ok: true, result: raw };
                } catch (err) {
                    toolResult = { ok: false, error: String(err?.message || err) };
                }
            } else {
                toolResult = { ok: false, error: `unknown tool: ${name}` };
            }
            messages.push({
                role: 'tool',
                tool_call_id: callId,
                content: JSON.stringify(toolResult),
            });
        }
        if (finalized) return;
    }
    // Loop exhausted maxRounds without finalize — auto-commit current state.
    if (!handle.complete._settled) {
        await handle.commit();
    }
}

function makeDirectorToolCallId() {
    return `director_tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeStringifyArgs(value) {
    try {
        return JSON.stringify(value && typeof value === 'object' ? value : {});
    } catch {
        return '{}';
    }
}

/**
 * Build the taskMessages array for a director agent dispatch (main or sub).
 *
 * Shape:
 *   [
 *     { role: 'system', content: '<story_context>' },
 *     ...contentPayload.messages,    // takeover-captured messages spliced verbatim
 *     { role: 'system', content: '</story_context>\n\n' + agentProfile.systemPrompt },
 *   ]
 *
 * The agent's instruction is appended AFTER `</story_context>` so the model
 * reads the long reference material first and the task framing last
 * (recency bias works in our favour). Director hard-codes only the
 * `<story_context>` open/close tags; everything else (chat history,
 * character info, world info, the final user turn that triggers the
 * model's response) is the user's responsibility to manage via their
 * chat-completion preset (prompt items, macros). This minimises
 * director's interference with the user's prompt-assembly system and
 * makes the structural boundary readable to the model.
 *
 * @param {object} agentProfile - has `systemPrompt: string` (or empty/missing)
 * @param {object|null} contentPayload - cached payload, or null if missing
 * @returns {Array<{role: string, content: string}>}
 */
export function buildAgentTaskMessages(agentProfile, contentPayload) {
    const instruction = String(agentProfile?.systemPrompt || '');
    const messagesIn = Array.isArray(contentPayload?.messages) ? contentPayload.messages : [];

    const closeContent = '</story_context>' + (instruction ? '\n\n' + instruction : '');

    return [
        { role: 'system', content: '<story_context>' },
        ...messagesIn,
        { role: 'system', content: closeContent },
    ];
}
