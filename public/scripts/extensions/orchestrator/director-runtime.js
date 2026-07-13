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
import { isAbortError, raceAbortSignal, throwIfAborted } from './abort-utils.js';
import { resolveAgentToolFlags } from './persistence.js';
// Resolved lazily inside `handleDirectorDispatch` so test environments
// can import this module without first installing a SillyTavern global —
// the loop body (`runMainAgentLoop`) and pure helpers do not need it.
function getCreateMessageEditorHandle() {
    return Luker.getContext().createMessageEditorHandle;
}
import {
    buildMainAgentToolSchemas,
    createSubagentDispatcher,
    executeWriteMessageTool,
    executeApplyPatchesTool,
    executeFinalizeTool,
    executeGetDraftTool,
    executeDraftSearchTool,
} from './director-tools.js';
import { buildPerRunCustomToolRegistry } from './per-run-custom-tools.js';
import { canonicalStringifyArgs } from './canonical-stringify.js';
import { resolveToolSource } from './loop-tools.js';
import { resolveCardFirstPresetName } from './agent-preset-resolver.js';
import {
    appendRound, appendToSection, ensureSection,
    finishRun, setRoundStatus, setSectionStatus, addTokenUsage,
} from './run-state/store.js';
import { i18n, i18nFormat } from './i18n.js';

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
 * (`settings.llmNodeApiPresetName`). Card-first — an embedded card
 * preset with the same name overrides a same-named local global preset,
 * matching the orchestrator's card-first binding rule shared with the
 * loop / agenda / spec modes.
 * Delegates to `resolveCardFirstPresetName` so all orchestrator modes
 * share one resolution path; kept as a local string-returning wrapper
 * because the surrounding call sites feed the result straight into
 * `generateTaskStreamForMainAgent({apiPresetName, llmPresetName})`
 * which expects a bare name (or empty string to inherit runtime
 * defaults). `resolveByName` + character are pulled from the ctx layer
 * lazily so this module stays Jest-clean when the loop / tools tests
 * import it transitively.
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
 * presets. Per-agent setting wins; falls back to
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
// Note: director writes process state through the RunStateStore (panel
// + simulation review popup read from there). For backward compat the
// loop still accepts optional `deps.trace` + `deps.finalizeTrace` hooks
// — they let a caller post-process a trace-shaped record if one is
// supplied, but no in-tree caller does so anymore.

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
    const createMessageEditorHandle = getCreateMessageEditorHandle();
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
                // Reasoning-fold markers used to be appended here so the user
                // could see the turn ended unnaturally (vs. a clean finalize),
                // but live progress now lives in RunStateStore. The
                // chat-message reasoning fold stays untouched on abort/error
                // so the original seeded reasoning is preserved.
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
            // Finalize the runtime trace AND the run-panel store with the
            // resolved handle status so both back-ends settle into a
            // terminal state instead of staying "running". Trace creation
            // is optional (caller may not have supplied one), so guard.
            // The finalize function is injected via deps so director-
            // runtime stays agnostic to the caller's trace shape.
            let resolvedStatus = 'completed';
            let resolvedFinalText = null;
            let resolvedError = null;
            try {
                const outcome = await handle.complete;
                const handleStatus = String(outcome?.status || '');
                if (handleStatus === 'committed') {
                    resolvedStatus = 'committed';
                    resolvedFinalText = String(outcome?.finalText ?? '');
                } else if (handleStatus === 'aborted') {
                    resolvedStatus = 'aborted';
                } else if (handleStatus === 'discarded') {
                    resolvedStatus = 'aborted';
                } else {
                    resolvedStatus = handleStatus || 'completed';
                }
            } catch (handleErr) {
                resolvedStatus = 'error';
                resolvedError = String(handleErr?.message || handleErr);
            }
            if (deps?.trace && typeof deps?.finalizeTrace === 'function') {
                const traceStatus = resolvedStatus === 'committed' ? 'completed'
                    : resolvedStatus === 'aborted' ? 'cancelled'
                        : resolvedStatus === 'error' ? 'failed'
                            : resolvedStatus;
                try {
                    deps.finalizeTrace(deps.trace, traceStatus);
                } catch (_) { /* trace is best-effort */ }
            }
            if (deps?.runId) {
                try {
                    finishRun({
                        runId: deps.runId,
                        status: resolvedStatus,
                        finalText: resolvedFinalText,
                        error: resolvedError,
                    });
                } catch (_) { /* store may already be cleared */ }
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
 * Render the "## Open Notes" block for the main agent. Returns an empty
 * string when there are no open notes so callers can compose it into a
 * runtime-state body without conditional guards. Format mirrors the
 * loop-runtime and sub-agent renderers (`- [id] text` per entry) so the
 * same close-by-id contract applies everywhere notes appear in the
 * prompt stack.
 *
 * @internal exported for tests.
 *
 * @param {Array<{id: string, text: string}>|null|undefined} openNotes
 * @returns {string}
 */
export function renderOpenNotesBlock(openNotes) {
    const open = Array.isArray(openNotes) ? openNotes : [];
    if (open.length === 0) return '';
    const lines = ['## Open Notes (your plot-author threads — close with note_close when deployed)'];
    for (const n of open) {
        lines.push(`- [${String(n.id || '')}] ${String(n.text || '')}`);
    }
    return lines.join('\n');
}

/**
 * Back-compat wrapper kept for tests that still target the prior
 * "concat into systemPrompt" shape. New call sites should use
 * `renderOpenNotesBlock` and place the block in a trailing
 * `<runtime_state>` user message instead — see `buildAgentTaskMessages`.
 *
 * @internal exported for tests.
 *
 * @param {string} systemPrompt - the bare instruction string
 * @param {Array<{id: string, text: string}>|null|undefined} openNotes
 * @returns {string}
 */
export function renderMainAgentSystemPromptWithOpenNotes(systemPrompt, openNotes) {
    const block = renderOpenNotesBlock(openNotes);
    if (!block) return systemPrompt;
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
        maxRounds: Number(director.maxRounds) > 0 ? Number(director.maxRounds) : 40,
        maxConcurrentSubagents: Number(director.maxConcurrentSubagents) > 0 ? Number(director.maxConcurrentSubagents) : 4,
        maxTotalSubagentRuns: Number(director.maxTotalSubagentRuns) > 0 ? Number(director.maxTotalSubagentRuns) : 16,
    };
    // Same range/parsing as tool-calling.js so user-facing semantics of
    // "Tool-call retries (on invalid/missing)" are uniform across
    // orchestrator modes. 0 = no retry (one shot, then throw).
    const maxNoToolRetries = Math.max(0, Math.floor(Number(deps?.settings?.toolCallRetryMax) || 0));
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
        // Streaming provider is always forwarded; the dispatcher decides
        // per dispatch whether to consume chunks by probing
        // `isStreamingPresetEnabled(presetName)` against the sub-agent's
        // resolved `llmPresetName`. When the preset enables streaming
        // chunks pipe into the RunStateStore section live; otherwise the
        // dispatcher awaits the terminal result and writes the section
        // once.
        generateTaskStream: deps?.generateTaskStream,
        isStreamingPresetEnabled: deps?.isStreamingPresetEnabled,
        handle,
        // The active director run id — each sub-agent dispatch opens its
        // own top-level round (`sub-<agentName>-<n>`) in the store so
        // every panel subscriber sees its activity in real time. Null
        // (legacy tests that don't open a run) makes the dispatcher's
        // store calls no-op — the inflight promise still resolves and
        // the sub-agent's mini-loop runs to completion, the activity
        // just isn't surfaced to the run panel.
        runId: deps?.runId || null,
        getContentPayload,
        abortSignal: eventData?.abortSignal,
        // Sub-agents run their own tool-call mini-loop using the same
        // loop tools the main agent has access to (chat / lorebook /
        // memory / note / search — gated by the same profile.tools
        // flags), plus get_draft / draft_search unconditionally.
        // Dispatch_subagent / dispatch_inline_subagent / await_subagents /
        // cancel_subagent / finalize are NOT exposed to sub-agents; only
        // the main agent dispatches and commits. Write_message /
        // apply_message_patches are gated by `tools.message.<verb>` for
        // BOTH roles (same flag namespace) — default off on every fresh
        // sub-agent profile; a user can flip them on per sub-agent or
        // profile-wide.
        tools: director.tools || {},
        executeLoopTool: deps?.executeLoopTool,
        chat: deps?.chat,
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

    // Per-dispatch runtime state (open notes + available skills catalog)
    // is delivered in a trailing user `<runtime_state>` block instead of
    // being concatenated into the main agent's system prompt. The notes
    // adapter flips status as note_open / note_close fire mid-run, and
    // the skills catalog mutates when skills are installed / removed —
    // either change used to invalidate the entire system prefix and
    // every cache breakpoint downstream of it. The system prompt now
    // stays byte-identical across dispatches so the upstream prompt
    // cache holds.
    const openNotesForMain = await readOpenNotesFromContextForNotes(deps?.contextForNotes);
    const openNotesBlock = renderOpenNotesBlock(openNotesForMain);

    // Resolve visible skills for the main agent. The resolver loads the
    // inventory lazily so test environments that never reach this branch
    // (the orchestrator tests stub `runMainLoop`) don't pay the import
    // cost. Visible skills also get threaded into each tool-call's ctx
    // below so skill_list / skill_read / skill_search see the scoped
    // visibility instead of the fail-open global fallback.
    let visibleSkillsForMain = [];
    let availableSkillsBlock = '';
    try {
        const skillRes = await loadSkillResolution();
        visibleSkillsForMain = await skillRes.resolveAgentVisibleSkills({
            modeProfile: director,
            agentConfig: director.mainAgent || null,
            runtimeContext: skillRes.buildSkillRuntimeContext(
                deps?.contextForNotes || null,
                director.mainAgent || null,
                { mode: 'director', name: String(director?.name || '').trim() },
            ),
        });
        availableSkillsBlock = skillRes.buildAvailableSkillsBlock(visibleSkillsForMain) || '';
    } catch (e) {
        // Resolution failure must not abort the agent run. Fall back to
        // an empty visible list (tools resolve via global fallback) and
        // skip the catalog block.
        console.warn('[orchestrator-director] skill resolution failed:', e?.message || e);
    }

    const runtimeStateBlock = [openNotesBlock, availableSkillsBlock].filter(Boolean).join('\n\n');

    const messages = buildAgentTaskMessages(
        { systemPrompt },
        contentPayload,
        runtimeStateBlock,
    );

    const panelRunId = deps?.runId || null;

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
        // Anchor a named section for this round's main-agent output. Live
        // chunks flow into the run-panel store (the run-panel renders
        // them); the chat message reasoning fold is no longer touched
        // by the director runtime, so chat persistence stays untouched
        // until the final commit writes `mes`.
        // No-tool-call retry inner loop. Each round MUST produce a
        // tool call; an empty toolCalls list means the model balked
        // and we discard that attempt entirely — not pushed into
        // `messages`, not recorded in the trace — and re-request the
        // same history until `toolCallRetryMax` is exhausted.
        let result;
        let toolCalls;
        let noToolRetries = 0;
        // Reasoning is captured for the run-panel only (per user's
        // request). It is NOT forwarded into the message reasoning fold
        // — that channel stays untouched so the user still sees agent
        // output without internal thinking interleaved.
        let reasoningAccum = '';
        let panelRoundId = null;
        let panelTextSectionId = null;
        let panelReasoningSectionId = null;
        if (panelRunId) {
            panelRoundId = `main-${round}`;
            try {
                appendRound({ runId: panelRunId, round: { id: panelRoundId, label: i18nFormat('Director · round ${0}', round + 1) } });
                panelReasoningSectionId = ensureSection({ runId: panelRunId, roundId: panelRoundId, section: { id: 'reasoning', kind: 'reasoning', title: i18n('Reasoning') } });
                panelTextSectionId = ensureSection({ runId: panelRunId, roundId: panelRoundId, section: { id: 'text', kind: 'text', title: i18n('Text') } });
            } catch (_) { /* store may have been cleared */ }
        }
        while (true) {
            let chunkReceived = false;
            reasoningAccum = '';
            // Transport-error retry honors `settings.toolCallRetryMax` —
            // the same setting loop/agenda/spec modes already respect via
            // `requestToolCallsWithRetry`. Director's main agent bypasses
            // that wrapper (it needs onChunk for live UI), so we replicate
            // the retry semantics inline. User-initiated aborts re-throw
            // without retry.
            const transportRetries = Math.max(0, Math.floor(Number(deps?.settings?.toolCallRetryMax) || 0));
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
                                if (panelRunId && panelTextSectionId) {
                                    try {
                                        appendToSection({ runId: panelRunId, roundId: panelRoundId, sectionId: panelTextSectionId, delta: chunk.delta });
                                    } catch (_) { /* store may have been cleared */ }
                                }
                            } else if (chunk?.type === 'reasoning' && typeof chunk.delta === 'string' && chunk.delta.length > 0) {
                                reasoningAccum += chunk.delta;
                                if (panelRunId && panelReasoningSectionId) {
                                    try {
                                        appendToSection({ runId: panelRunId, roundId: panelRoundId, sectionId: panelReasoningSectionId, delta: chunk.delta });
                                    } catch (_) { /* store may have been cleared */ }
                                }
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
            if (panelRunId && result?.usage) {
                try { addTokenUsage({ runId: panelRunId, usage: result.usage }); } catch (_) { /* store may have been cleared */ }
            }
            if (!chunkReceived) {
                // Non-streaming transport or tool-only stream: append the
                // assembled assistantText so the panel's text section
                // reflects what the model said this attempt.
                const text = String(result?.assistantText || '');
                if (text && panelRunId && panelTextSectionId) {
                    try {
                        appendToSection({ runId: panelRunId, roundId: panelRoundId, sectionId: panelTextSectionId, delta: text });
                    } catch (_) { /* store may have been cleared */ }
                }
            }
            const rawToolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
            // Drop placeholder tool_calls with empty name — streaming
            // can flush these when the model started a tool_use block
            // and bailed mid-stream. Anthropic rejects empty-name
            // entries, and semantically they aren't actionable.
            toolCalls = rawToolCalls.filter(tc => String(tc?.name || '').trim().length > 0);
            if (toolCalls.length > 0) {
                if (panelRunId && panelTextSectionId) {
                    try {
                        setSectionStatus({ runId: panelRunId, roundId: panelRoundId, sectionId: panelTextSectionId, status: 'done' });
                    } catch (_) { /* store may have been cleared */ }
                }
                if (panelRunId && panelReasoningSectionId) {
                    try {
                        setSectionStatus({ runId: panelRunId, roundId: panelRoundId, sectionId: panelReasoningSectionId, status: 'done' });
                    } catch (_) { /* store may have been cleared */ }
                }
                break;
            }
            if (panelRunId && panelTextSectionId) {
                try {
                    setSectionStatus({ runId: panelRunId, roundId: panelRoundId, sectionId: panelTextSectionId, status: 'failed', meta: { err: 'no tool call' } });
                } catch (_) { /* store may have been cleared */ }
            }
            noToolRetries++;
            if (noToolRetries > maxNoToolRetries) {
                // No-tool-call exhaustion: the assistant turn was
                // deliberately NOT pushed into `messages` (the retry
                // contract requires the next round see the same
                // history). RunStateStore already captured the failure
                // via `setSectionStatus({status:'failed', meta:{err:'no tool call'}})`
                // above, so the run-panel and the simulation review popup
                // both have the evidence of the failed round.
                throw new Error(`Main agent produced no tool call after ${maxNoToolRetries + 1} attempt(s) (toolCallRetryMax=${maxNoToolRetries}).`);
            }
        }
        // Successful round — the assistant turn (with reasoning + _round)
        // and each tool_result will be pushed onto `messages` below; the
        // renderer reconstructs the per-round breakdown from there. No
        // parallel rounds[] write is needed.
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
            reasoning: reasoningAccum || String(result?.reasoning || ''),
            ...(Array.isArray(result?.reasoningBlocks) && result.reasoningBlocks.length > 0 ? { reasoning_blocks: result.reasoningBlocks } : {}),
            ...(Array.isArray(result?.reasoningDetails) && result.reasoningDetails.length > 0 ? { reasoning_details: result.reasoningDetails } : {}),
            tool_calls: assistantToolCallEntries,
            _round: round,
        });

        let finalized = false;
        for (let i = 0; i < toolCalls.length; i += 1) {
            // Abort discipline between tool iterations. The round-start
            // check at the top of this for-of-rounds loop catches signal
            // abort across rounds; this inner check catches it BETWEEN
            // tools within a single round so we don't keep dispatching
            // sub-agents / firing executeLoopTool calls after the user
            // hit stop. `throwIfAborted` propagates an AbortError that
            // the outer wrapper recognises as `userAborted` and routes
            // through `handle.abort()` — the handle is also already in
            // its `aborted` terminal state via the message-takeover
            // auto-abort listener, so any builtin tools that try to
            // mutate it (write_message, apply_message_patches, …) would
            // throw on their own. Throwing here gives us the same
            // unwind path uniformly for tools that don't touch the
            // handle (executeLoopTool, dispatch_subagent, …).
            throwIfAborted(eventData?.abortSignal);
            const call = toolCalls[i];
            const callId = assistantToolCallEntries[i].id;
            const name = String(call?.name || '');
            const args = call?.args;
            const callSource = assistantToolCallEntries[i].source;
            let panelToolCallSectionId = null;
            if (panelRunId && panelRoundId) {
                try {
                    panelToolCallSectionId = ensureSection({
                        runId: panelRunId, roundId: panelRoundId,
                        section: { id: `tool-${i}`, kind: 'tool_call', title: i18nFormat('Tool: ${0}', name), meta: { args, source: callSource } },
                    });
                    appendToSection({ runId: panelRunId, roundId: panelRoundId, sectionId: panelToolCallSectionId, delta: stringifyForSection(args) });
                } catch (_) { /* store may have been cleared */ }
            }
            let toolResult;
            if (name === 'dispatch_subagent') {
                const h = await raceAbortSignal(
                    dispatcher.dispatch({ ...(args || {}), __parentMessages: parentMessagesForRound }),
                    eventData?.abortSignal,
                );
                toolResult = { ok: true, handle: h };
            } else if (name === 'dispatch_inline_subagent') {
                const h = await raceAbortSignal(
                    dispatcher.dispatchInline({ ...(args || {}), __parentMessages: parentMessagesForRound }),
                    eventData?.abortSignal,
                );
                toolResult = { ok: true, handle: h };
            } else if (name === 'await_subagents') {
                // Race the awaitAll against the user-side signal so a
                // stop unblocks the main loop even when a sub-agent's
                // transport is stuck ignoring its (chained) child
                // signal. The sub-agent promise keeps running in the
                // background; we just stop waiting on it.
                const results = await raceAbortSignal(
                    dispatcher.awaitAll(args?.handles || []),
                    eventData?.abortSignal,
                );
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
            } else if (name === 'draft_search') {
                toolResult = await executeDraftSearchTool(handle, args);
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
                    // Custom tools in director mode often want to inspect the
                    // in-flight draft (e.g. a pre-finalize skeleton check). The
                    // built-in `get_draft` tool returns `handle.getText()`, so
                    // expose the same path here as `ctx.director.getDraft()` so
                    // Layer-3 tool bodies have a stable, sync, no-tool-roundtrip
                    // way to read the live message body. Sub-agents inherit a
                    // separate handle and get their own director.getDraft below.
                    toolCtx.director = {
                        getDraft() {
                            try {
                                if (handle && typeof handle.getText === 'function') return handle.getText();
                            } catch (_) { /* fall through */ }
                            return '';
                        },
                    };
                    // Thread the resolved visible-skills list onto the
                    // ctx so any skill_list / skill_read / skill_search
                    // calls dispatched through this loop see the agent's
                    // scoped visibility. The skill_* execs reject calls
                    // whose ctx omits this field — they never see the
                    // global skill inventory.
                    toolCtx.__visibleSkillsForAgent = visibleSkillsForMain;
                    // Race the tool against the signal so a hanging
                    // tool (network stalls, recursive sub-orchestration
                    // that ignores its own signal) can't pin the loop
                    // open after the user clicked stop.
                    const raw = await raceAbortSignal(
                        deps.executeLoopTool(name, args, toolCtx),
                        eventData?.abortSignal,
                    );
                    toolResult = { ok: true, result: raw };
                } catch (err) {
                    // Don't swallow abort — let the outer wrapper handle
                    // it as a user-initiated cancel rather than reporting
                    // it as a per-tool failure in the messages stream.
                    if (isAbortError(err, eventData?.abortSignal)) throw err;
                    toolResult = { ok: false, error: String(err?.message || err) };
                }
            } else {
                toolResult = { ok: false, error: `unknown tool: ${name}` };
            }
            messages.push({
                role: 'tool',
                tool_call_id: callId,
                content: JSON.stringify(toolResult),
                _round: round,
            });
            if (panelRunId && panelRoundId) {
                try {
                    const resultSectionId = ensureSection({
                        runId: panelRunId, roundId: panelRoundId,
                        section: { id: `tool-result-${i}`, kind: 'tool_result', title: i18nFormat('Tool result: ${0}', name), meta: { ok: !!toolResult?.ok, err: toolResult?.error || null } },
                    });
                    appendToSection({ runId: panelRunId, roundId: panelRoundId, sectionId: resultSectionId, delta: stringifyForSection(toolResult) });
                    setSectionStatus({ runId: panelRunId, roundId: panelRoundId, sectionId: resultSectionId, status: toolResult?.ok ? 'done' : 'failed' });
                    if (panelToolCallSectionId) {
                        setSectionStatus({ runId: panelRunId, roundId: panelRoundId, sectionId: panelToolCallSectionId, status: toolResult?.ok ? 'done' : 'failed' });
                    }
                } catch (_) { /* store may have been cleared */ }
            }
            // Post-execute abort check: surface user abort immediately
            // instead of waiting for the next tool-loop iteration (or
            // worse, the next round's top-of-loop check after another
            // full LLM round). Cheap: single `.aborted` read + throw on
            // the common path. Placed AFTER the messages.push + panel
            // status update so the tool result that already ran is
            // preserved in the transcript / visible in the panel — only
            // the *next* tool / round is suppressed. Mirrors the
            // post-execute checks in loop-runtime / spec-runtime /
            // agenda-runtime (see commit 2b228b93b — director was
            // missed).
            throwIfAborted(eventData?.abortSignal, 'Orchestration aborted.');
        }
        if (panelRunId && panelRoundId) {
            try {
                setRoundStatus({ runId: panelRunId, roundId: panelRoundId, status: 'done' });
            } catch (_) { /* store may have been cleared */ }
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
    return canonicalStringifyArgs(value);
}

function stringifyForSection(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
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
export function buildAgentTaskMessages(agentProfile, contentPayload, runtimeStateBlock = '') {
    const instruction = String(agentProfile?.systemPrompt || '');
    const messagesIn = Array.isArray(contentPayload?.messages) ? contentPayload.messages : [];

    const closeContent = '</story_context>' + (instruction ? '\n\n' + instruction : '');
    const runtimeState = String(runtimeStateBlock || '').trim();

    const out = [
        { role: 'system', content: '<story_context>' },
        ...messagesIn,
        { role: 'system', content: closeContent },
    ];
    if (runtimeState) {
        out.push({ role: 'user', content: '<runtime_state>\n' + runtimeState + '\n</runtime_state>' });
    }
    return out;
}
