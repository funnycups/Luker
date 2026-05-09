/**
 * Loop execution-mode runtime for the orchestrator.
 *
 * Loop mode runs a single agent that calls tools in the same conversation
 * over multiple rounds, terminating only when the agent invokes the
 * `finalize` tool with a capsule body. This file owns the outer driver
 * (`runLoopOrchestration`) plus the minimum tool set (only `finalize` at
 * Task 5–7; chat / lorebook / memory / note tools land in Task 8+).
 *
 * Layering:
 *
 *   - `runLoopOrchestration` is the entry point. It accepts an optional
 *     `deps` bag whose three slots — `sendLlm`, `executeTool`, `traceApi`
 *     — let tests inject fakes without booting the real LLM stack. The
 *     production `defaultSendLlm` wraps `requestToolCallsWithRetry` from
 *     `tool-calling.js` (which itself wraps `context.generateTask`); the
 *     production `defaultExecuteTool` rejects every non-finalize tool
 *     name with a structured `ToolError(NOT_IMPLEMENTED)` until Task 8+
 *     swaps in the real central dispatcher.
 *
 *   - The driver returns `{ status, capsule, total_rounds, runtimeTrace }`.
 *     `status` is one of `completed` (agent called finalize with a
 *     non-empty body) or `budget_exhausted` (max_rounds / wall_clock /
 *     no_tool_call_streak ran out before finalize).
 *
 *   - Tool error feedback (Task 7): when a tool throws a `ToolError`, the
 *     runtime serializes `{ ok: false, error, code, hint }` into a
 *     `role: 'tool'` message that the next round sees in the messages
 *     array. The agent can then read the structured error and retry —
 *     this is the "self-correcting agent" loop we get for free from
 *     OpenAI tool-calling. Non-`ToolError` exceptions propagate out as
 *     runtime errors (the orchestration aborts).
 *
 *   - Trace events: `run_started` / `run_finished` come from the trace
 *     creator / finalizer (recorded unconditionally). The loop driver itself
 *     emits a flat event stream — no stage / node nesting since loop mode
 *     has neither — using the spec-aligned types `llm_request` /
 *     `llm_response` / `agent_no_tool_call` / `tool_call` / `tool_result` /
 *     `tool_error` / `budget_exhausted`. `budget_exhausted` carries a
 *     `reason` field (`max_rounds` / `wall_clock` / `no_tool_call_streak`)
 *     so the trace UI can disambiguate the three exhaustion paths from a
 *     single event type. `tool_call` / `tool_error` cover the finalize tool
 *     too (with `name: 'finalize'` and, on error,
 *     `code: 'FINALIZE_EMPTY'`). The trace popup renders this as a flat
 *     timeline; the JSONL export hands the same structure to external tooling.
 */

import { isAbortSignalLike, throwIfAborted } from './abort-utils.js';
import { executeLoopTool, getEnabledToolSchemas } from './loop-tools.js';

// runtime-trace and tool-calling are loaded lazily inside the runtime
// entry point — both pull `lib.js` (a build-only bundle) transitively
// and would otherwise refuse to load under the Node-based test runner.
// Tests get an in-memory trace shim and inject `deps.sendLlm` directly;
// production resolves the real modules via dynamic import.
//
// loop-tools.js is imported eagerly: it has no `lib.js` dependency, and
// circular import with this file is safe under ES module hoisting because
// loop-tools' initializer only references our `FINALIZE_TOOL_SCHEMA` and
// `ToolError` — both static exports — at registration time, not run time.

/**
 * Structured tool-call error carried back to the agent as a `role: tool`
 * message. The runtime catches `ToolError` thrown by `executeTool` and
 * serializes it into JSON so the agent sees a stable
 * `{ ok: false, error, code, hint }` shape regardless of which tool
 * raised it. Non-`ToolError` exceptions propagate out as runtime errors.
 */
export class ToolError extends Error {
    constructor(message, code, hint) {
        super(String(message || 'Tool error.'));
        this.name = 'ToolError';
        this.code = String(code || 'TOOL_ERROR');
        this.hint = String(hint || '');
    }
}

/**
 * Schema for the always-on `finalize` tool. The loop has no other
 * terminator; the agent must call this with a non-empty `capsule_text`
 * to commit the capsule body and stop the loop.
 */
export const FINALIZE_TOOL_SCHEMA = Object.freeze({
    type: 'function',
    function: {
        name: 'finalize',
        description: 'Produce the final guidance capsule and stop the loop. capsule_text becomes the orchestration capsule injected into the next generation pass.',
        parameters: {
            type: 'object',
            properties: {
                capsule_text: {
                    type: 'string',
                    description: 'Free-form guidance text injected into the main model prompt.',
                },
            },
            required: ['capsule_text'],
            additionalProperties: false,
        },
    },
});

/**
 * Number of consecutive zero-tool-call rounds that triggers an early break
 * out of the loop. The agent has presumably "gotten stuck talking" and will
 * not converge on a finalize tool call without intervention.
 */
const NO_TOOL_CALL_STREAK_LIMIT = 3;

/**
 * Production LLM transport. Wraps `requestToolCallsWithRetry` from
 * `tool-calling.js` so each round of the loop is a single "send messages
 * + receive tool calls and assistant text" call. The loop runtime owns
 * the multi-round bookkeeping; this helper is intentionally single-shot.
 *
 * The lazy import keeps the test runner from pulling `lib.js` transitively
 * via `tool-calling.js`'s siblings; tests inject `deps.sendLlm` and
 * never hit this path. `agent-resolution.js` is loaded with the same
 * deferral — its transitive imports also pull `lib.js`.
 *
 * Empty `apiPresetName` / `llmPresetName` fall back to the global
 * `llmNodeApiPresetName` / `llmNodePresetName` via
 * `resolveOrchestrationAgent*PresetName`, mirroring how spec / agenda
 * runtimes resolve preset names. Without this fallback an empty profile
 * field passes through to `context.generateTask` and the call drops
 * straight to whatever request layer treats as default — which in
 * practice is "no profile selected" for the loop-only path.
 *
 * Returns `{ toolCalls: Array<{id, name, args}>, assistantText: string }`.
 */
async function defaultSendLlm({ context, settings, messages, tools, runtimeWorldInfo, apiPresetName, llmPresetName, abortSignal }) {
    const [toolCallingMod, agentResolutionMod] = await Promise.all([
        import('./tool-calling.js'),
        import('./agent-resolution.js'),
    ]);
    if (typeof toolCallingMod?.requestToolCallsWithRetry !== 'function') {
        throw new Error('[orchestrator] loop-runtime: requestToolCallsWithRetry is unavailable.');
    }
    const resolvedApiPresetName = agentResolutionMod.resolveOrchestrationAgentApiPresetName(
        settings,
        { apiPresetName },
    );
    const resolvedLlmPresetName = agentResolutionMod.resolveOrchestrationAgentPromptPresetName(
        settings,
        { promptPresetName: llmPresetName },
    );
    const result = await toolCallingMod.requestToolCallsWithRetry(context, settings, {
        taskMessages: messages,
        runtimeWorldInfo: runtimeWorldInfo || {},
        apiPresetName: resolvedApiPresetName,
        llmPresetName: resolvedLlmPresetName,
        tools,
        allowedNames: null,
        abortSignal,
        includeAssistantText: true,
        // The loop tolerates rounds where the agent only emits prose: that
        // gets counted into the no-tool-call streak rather than rejected
        // as an LLM error. allowNoToolCalls=true preserves the assistant
        // text so the streak-break fallback can use it as the capsule.
        allowNoToolCalls: true,
        applyAgentTimeout: true,
    });
    if (Array.isArray(result)) {
        // Returned shape when includeAssistantText is false — shouldn't
        // happen here, but normalize defensively.
        return { toolCalls: result, assistantText: '' };
    }
    return {
        toolCalls: Array.isArray(result?.toolCalls) ? result.toolCalls : [],
        assistantText: String(result?.assistantText || ''),
    };
}

/**
 * Default tool dispatcher. Delegates to `loop-tools.js`'s central
 * registry; unknown tool names surface as `ToolError(NOT_IMPLEMENTED)`
 * from the dispatcher so the agent sees the failure in its tool-message
 * history and can self-correct on the next round. Tasks 8–11 register
 * the chat / lorebook / memory / note implementations into the
 * dispatcher's REGISTRY so this default keeps working as new tools come
 * online without changes here.
 */
async function defaultExecuteTool(name, args, context) {
    return executeLoopTool(name, args, context);
}

function makeInMemoryTraceFallback(context, payload, extra) {
    // Mirrors the runtime-trace API surface used by the loop driver:
    // create / record / finalize. Used in tests where the real
    // runtime-trace module pulls the build-time `lib.js` bundle and is
    // not importable. Production resolves the real module via dynamic
    // import below.
    const startedAt = new Date().toISOString();
    const trace = {
        runId: `orch_runtime_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        chatKey: '',
        status: 'running',
        startedAt,
        updatedAt: startedAt,
        finishedAt: '',
        generationType: String(payload?.type || extra?.generationType || '').trim().toLowerCase(),
        targetLayer: 0,
        note: String(extra?.note || ''),
        capsuleText: '',
        error: '',
        stages: [],
        attempts: [],
        events: [],
        nextEventSeq: 1,
        nextAttemptId: 1,
        reviewRerunCount: 0,
        mode: String(extra?.mode || 'loop'),
    };
    trace.events.push({ seq: trace.nextEventSeq++, at: startedAt, type: 'run_started', mode: trace.mode });
    return trace;
}

function recordToTraceFallback(trace, type, details = {}) {
    if (!trace || typeof trace !== 'object') return null;
    const event = {
        seq: Number(trace.nextEventSeq || 1),
        at: new Date().toISOString(),
        type: String(type || 'event'),
        ...(details && typeof details === 'object' ? structuredClone(details) : {}),
    };
    trace.nextEventSeq = event.seq + 1;
    trace.updatedAt = event.at;
    trace.events.push(event);
    return event;
}

function finalizeTraceFallback(trace, status, details = {}) {
    if (!trace || typeof trace !== 'object') return;
    const normalizedStatus = String(status || trace.status || 'completed');
    trace.status = normalizedStatus;
    trace.updatedAt = new Date().toISOString();
    trace.finishedAt = normalizedStatus === 'running' ? '' : trace.updatedAt;
    if (Object.prototype.hasOwnProperty.call(details || {}, 'capsuleText')) {
        trace.capsuleText = String(details?.capsuleText || '');
    }
    if (Object.prototype.hasOwnProperty.call(details || {}, 'note')) {
        trace.note = String(details?.note || '');
    }
    if (Object.prototype.hasOwnProperty.call(details || {}, 'error')) {
        trace.error = String(details?.error || '');
    }
    recordToTraceFallback(trace, 'run_finished', {
        status: normalizedStatus,
        note: trace.note,
        error: trace.error,
    });
}

/**
 * Resolve the trace API. In production we dynamically import the real
 * `runtime-trace.js` so the `getLatestOrchestrationRuntimeTrace(context)`
 * dispatch still finds our run; under Jest the dynamic import fails on
 * the build-only `lib.js` and we fall back to the in-memory shim. The
 * shim exposes the same call shape but doesn't register the trace as
 * "latest" — that path is exercised by main.js integration tests.
 */
async function resolveTraceApi(deps) {
    if (deps?.traceApi && typeof deps.traceApi === 'object') {
        return deps.traceApi;
    }
    try {
        const mod = await import('./runtime-trace.js');
        if (typeof mod?.createOrchestrationRuntimeTrace === 'function'
            && typeof mod?.recordOrchestrationRuntimeEvent === 'function'
            && typeof mod?.finalizeOrchestrationRuntimeTrace === 'function') {
            return {
                create: mod.createOrchestrationRuntimeTrace,
                record: mod.recordOrchestrationRuntimeEvent,
                finalize: mod.finalizeOrchestrationRuntimeTrace,
            };
        }
    } catch (_error) {
        // Fall through to the in-memory shim.
    }
    return {
        create: (context, payload, _stages, extra) => makeInMemoryTraceFallback(context, payload, extra),
        record: recordToTraceFallback,
        finalize: finalizeTraceFallback,
    };
}

function buildInitialMessages(context, _payload, profile) {
    const systemContent = String(profile?.system_prompt || '').trim();
    const notes = Array.isArray(context?.__loopNotes) ? context.__loopNotes.filter(s => String(s ?? '').trim()) : [];

    let body = systemContent;
    if (notes.length > 0) {
        const block = '## Previous Notes (persistent, written by you in earlier runs)\n'
            + notes.map((note, i) => `${i + 1}. ${String(note)}`).join('\n');
        body = body ? `${body}\n\n${block}` : block;
    }
    return body
        ? [{ role: 'system', content: body }]
        : [];
}

/**
 * Production wiring for memory.* tools (Task 10). Loads the materialized
 * memory-graph store via the extension's floor-state instance and stashes
 * it on `context.__memoryStore`. Failures (memory-graph disabled,
 * `createFloorState` unavailable, race during chat switch) silently fall
 * through to `null` so the memory tools surface the structured
 * `ToolError(MEMORY_DISABLED)` rather than crashing the run.
 *
 * The shape returned by `fs.get()` is `graphPayloadFromStore(store)` from
 * `memory-graph/persistence.js` — a plain object `{ nodes, edges, ... }`
 * — exactly what `external-api.js`'s `iterateStoreNodes` expects.
 *
 * Safe to call when memory-graph is not loaded: `import('../memory-graph/
 * persistence.js')` will succeed (the file is always present), but
 * `getFloorStateInstance` may throw if `context.createFloorState` is
 * missing (test runners, non-extension callers). The catch swallows that
 * and leaves the field null.
 *
 * NOTE: this helper performs a lazy dynamic import on every call. The
 * memory-graph persistence module sits behind ES module import caching
 * so the actual filesystem read happens at most once per session.
 *
 * @param {object} context — toolContext object (mutated in place)
 */
async function attachMemoryStore(context) {
    if (!context || typeof context !== 'object') return;
    try {
        const mod = await import('../memory-graph/persistence.js');
        if (typeof mod?.getFloorStateInstance !== 'function') {
            context.__memoryStore = null;
            return;
        }
        const fs = await mod.getFloorStateInstance(context);
        if (!fs || typeof fs.ready !== 'function' || typeof fs.get !== 'function') {
            context.__memoryStore = null;
            return;
        }
        await fs.ready();
        const payload = await fs.get();
        context.__memoryStore = (payload && typeof payload === 'object' && !Array.isArray(payload))
            ? payload
            : null;
    } catch (_error) {
        // memory-graph not available, createFloorState missing, or
        // floor-state replay failed — degrade gracefully.
        context.__memoryStore = null;
    }
}

const NOTES_NAMESPACE = 'luker_orch_loop_notes';
let notesFloorStatePromise = null;

/**
 * Singleton lookup for the `luker_orch_loop_notes` floor-state instance.
 * Mirrors `memory-graph/persistence.js::getFloorStateInstance` — once
 * created, the instance lives for the page session; structural events
 * (chat-changed, swipe, branch) are replayed automatically.
 */
async function getNotesFloorStateInstance(context) {
    if (!notesFloorStatePromise) {
        if (typeof context?.createFloorState !== 'function') {
            throw new Error('[orchestrator/loop] createFloorState API is unavailable in extension context.');
        }
        notesFloorStatePromise = context.createFloorState({ namespace: NOTES_NAMESPACE });
    }
    return notesFloorStatePromise;
}

/**
 * @internal — exposed for tests. Drop the cached singleton so subsequent
 * `getNotesFloorStateInstance` calls create a fresh instance.
 */
export function resetNotesFloorStateInstanceForTesting() {
    notesFloorStatePromise = null;
}

/**
 * Build the production adapter expected by `loop-tools/note.js`. The
 * underlying floor-state instance stores notes as an ordered array under
 * a single key (`entries`) inside the data namespace; reads / writes go
 * through `fs.update(reducer, { floor })` so each commit is incremental.
 *
 * Adapter shape (matches the test fixture in `loop-tools-note.test.js`):
 *
 *   {
 *     appendForFloor(floor, text): Promise<void>
 *     listAcrossFloors(): Promise<string[]>
 *     pruneOldest(n): Promise<void>
 *     deleteByIndex(indexes: number[]): Promise<{ removed: number }>
 *   }
 *
 * `deleteByIndex` accepts 1-based positions matching the "## Previous Notes"
 * numbering injected into the system prompt at run start. It dedupes the
 * input, drops out-of-range / non-integer entries, and removes the
 * survivors high-to-low so earlier removals don't shift later positions.
 * Returns the count actually removed so the tool can echo accurate
 * feedback to the agent. Errors propagate up to `attachNotesFloorState`,
 * which catches them and leaves the adapter null so the tool surfaces
 * `ToolError(NOTE_FS_UNAVAILABLE)`.
 */
function makeNotesAdapter(fs) {
    return {
        async appendForFloor(floor, text) {
            const targetFloor = Math.max(0, Math.floor(Number(floor) || 0));
            await fs.update((current) => {
                const safe = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
                const entries = Array.isArray(safe.entries) ? safe.entries.slice() : [];
                entries.push(String(text));
                return { ...safe, entries };
            }, { floor: targetFloor });
        },
        async listAcrossFloors() {
            await fs.ready();
            const data = await fs.get();
            const entries = (data && typeof data === 'object' && Array.isArray(data.entries))
                ? data.entries.map(s => String(s ?? ''))
                : [];
            return entries;
        },
        async pruneOldest(n) {
            const drop = Math.max(0, Math.floor(Number(n) || 0));
            if (!drop) return;
            // The pruning commit attaches at the chat tail (no override) so
            // it travels with subsequent activity — pruning is a maintenance
            // op rather than a per-floor record.
            await fs.update((current) => {
                const safe = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
                const entries = Array.isArray(safe.entries) ? safe.entries.slice() : [];
                if (drop >= entries.length) return { ...safe, entries: [] };
                return { ...safe, entries: entries.slice(drop) };
            });
        },
        async deleteByIndex(indexes) {
            const requested = Array.isArray(indexes) ? indexes : [];
            // Normalize: take only finite integers, dedupe, sort descending so
            // earlier splices don't shift later targets. Out-of-range values
            // are filtered out per-update against the live entries array (the
            // adapter doesn't know the count until it reads).
            const cleaned = Array.from(new Set(
                requested
                    .map(n => Number(n))
                    .filter(n => Number.isInteger(n) && n >= 1)
                    .map(n => Math.floor(n)),
            )).sort((a, b) => b - a);
            if (cleaned.length === 0) return { removed: 0 };

            let removed = 0;
            await fs.update((current) => {
                const safe = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
                const entries = Array.isArray(safe.entries) ? safe.entries.slice() : [];
                for (const oneBased of cleaned) {
                    const idx = oneBased - 1;
                    if (idx < 0 || idx >= entries.length) continue;
                    entries.splice(idx, 1);
                    removed += 1;
                }
                return { ...safe, entries };
            });
            return { removed };
        },
    };
}

/**
 * Production wiring for note.add (Task 11). Mounts the
 * `luker_orch_loop_notes` floor-state namespace, exposes an
 * `appendForFloor` / `listAcrossFloors` / `pruneOldest` adapter on
 * `context.__floorStateForNotes`, and pre-populates `context.__loopNotes`
 * with the historical notes for this chat so `buildInitialMessages` can
 * inject them into the system prompt before the first round.
 *
 * Failures degrade silently: the adapter stays null and `__loopNotes`
 * stays `[]`, so the agent simply doesn't get a "Previous Notes" block
 * this run (and any `note.add` call surfaces `NOTE_FS_UNAVAILABLE`).
 *
 * @param {object} context — toolContext (mutated in place)
 */
async function attachNotesFloorState(context) {
    if (!context || typeof context !== 'object') return;
    try {
        const fs = await getNotesFloorStateInstance(context);
        if (!fs || typeof fs.ready !== 'function' || typeof fs.get !== 'function' || typeof fs.update !== 'function') {
            context.__floorStateForNotes = null;
            context.__loopNotes = [];
            return;
        }
        const adapter = makeNotesAdapter(fs);
        context.__floorStateForNotes = adapter;
        context.__loopNotes = await adapter.listAcrossFloors();
    } catch (_error) {
        context.__floorStateForNotes = null;
        context.__loopNotes = [];
    }
}

/**
 * Single-agent loop driver. Returns:
 *
 *   {
 *     status: 'completed' | 'budget_exhausted',
 *     capsule: string | null,
 *     total_rounds: number,
 *     runtimeTrace: object,
 *   }
 *
 * Status semantics:
 *   - 'completed' when the agent calls finalize with a non-empty capsule_text.
 *   - 'budget_exhausted' when the loop ran out of budget before finalize:
 *       - hit `profile.max_rounds`, OR
 *       - exceeded `profile.wall_clock_budget_ms`, OR
 *       - the agent went silent for `NO_TOOL_CALL_STREAK_LIMIT` rounds in
 *         a row (default 3).
 *     Capsule falls back to the most recent assistant text the model
 *     produced (may be null if the model never wrote any prose).
 *
 * Tool error feedback (Task 7): when `executeTool` throws a `ToolError`,
 * the runtime appends a `role: tool` message with `{ ok: false, error,
 * code, hint }` JSON content for the matching `tool_call_id`. The agent
 * sees this on the next round and can self-correct. Non-`ToolError`
 * exceptions propagate out as runtime errors.
 *
 * @param {object} context — extension context (chat/messages live here)
 * @param {object} payload — generation payload (signal / coreChat / type)
 * @param {object} profile — sanitized loop profile (`sanitizeLoopProfile` output)
 * @param {{ sendLlm?: Function, executeTool?: Function, traceApi?: object, settings?: object, runtimeWorldInfo?: object }} [deps]
 * @returns {Promise<{status: string, capsule: string|null, total_rounds: number, runtimeTrace: object}>}
 */
export async function runLoopOrchestration(context, payload, profile, deps = {}) {
    const sendLlm = typeof deps?.sendLlm === 'function' ? deps.sendLlm : defaultSendLlm;
    const executeTool = typeof deps?.executeTool === 'function' ? deps.executeTool : defaultExecuteTool;

    const abortSignal = isAbortSignalLike(payload?.signal) ? payload.signal : null;
    throwIfAborted(abortSignal, 'Orchestration aborted.');

    // Tool dispatch context: extends SillyTavern's context with run-scoped
    // metadata the loop tools rely on. Currently carries
    // `__lukerLoop.activatedEntryKeys` (the World Info entries already
    // injected this turn — used by lorebook.search to dedup) and the
    // memory-graph store handle (`__memoryStore` + optional `__memoryDeps`,
    // populated by `attachMemoryStore` for production or pre-set on the
    // upstream context by tests). Built as a fresh object so the upstream
    // context is never mutated. Falls through to a tests-friendly empty
    // `__lukerLoop` when payload didn't carry one (e.g. non-orchestration
    // callers, integration fixtures).
    const toolContext = context && typeof context === 'object'
        ? Object.create(context)
        : {};
    if (payload && typeof payload === 'object' && payload.__lukerLoop && typeof payload.__lukerLoop === 'object') {
        toolContext.__lukerLoop = payload.__lukerLoop;
    } else if (!toolContext.__lukerLoop) {
        toolContext.__lukerLoop = { activatedEntryKeys: new Set() };
    }

    // Memory tools (Task 10) need a chat-scoped memory-graph store. Tests
    // pre-set `__memoryStore` (and optionally `__memoryDeps`) on the
    // upstream context; production wiring delegates to
    // `attachMemoryStore(toolContext)` which loads the store via
    // memory-graph's floor-state instance and falls back to null on any
    // failure (memory-graph disabled, missing API, race during chat
    // switch). The tools then surface `ToolError(MEMORY_DISABLED)` so the
    // agent sees a structured failure rather than a stack trace.
    if (toolContext.__memoryStore === undefined) {
        await attachMemoryStore(toolContext);
    }

    // note.add (Task 11) needs a per-chat floor-state namespace and the
    // historical notes loaded into `__loopNotes` so the system prompt
    // builder can re-inject them. Tests pre-set both fields directly to
    // skip the floor-state mount; production calls `attachNotesFloorState`
    // which silently degrades (adapter null, notes []) when
    // `createFloorState` isn't available.
    if (toolContext.__floorStateForNotes === undefined && toolContext.__loopNotes === undefined) {
        await attachNotesFloorState(toolContext);
    }

    const traceApi = await resolveTraceApi(deps);
    const trace = traceApi.create(context, payload, [], { mode: 'loop' });

    const messages = buildInitialMessages(toolContext, payload, profile);
    const tools = getEnabledToolSchemas(profile);
    const maxRounds = Math.max(1, Math.floor(Number(profile?.max_rounds) || 1));
    const wallClockBudgetMs = Math.max(0, Math.floor(Number(profile?.wall_clock_budget_ms) || 0));
    const deadline = wallClockBudgetMs > 0 ? Date.now() + wallClockBudgetMs : null;

    let capsule = null;
    let totalRounds = 0;
    let noToolCallStreak = 0;
    let lastNaturalText = null;
    let exhaustReason = '';

    try {
        for (let round = 1; round <= maxRounds; round += 1) {
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            if (deadline !== null && Date.now() >= deadline) {
                exhaustReason = 'wall_clock';
                traceApi.record(trace, 'budget_exhausted', {
                    round,
                    reason: 'wall_clock',
                    deadline_ms: wallClockBudgetMs,
                });
                break;
            }
            totalRounds = round;
            traceApi.record(trace, 'llm_request', {
                round,
                max_rounds: maxRounds,
                message_count: messages.length,
            });

            const response = await sendLlm({
                context,
                settings: deps?.settings || null,
                runtimeWorldInfo: deps?.runtimeWorldInfo || null,
                apiPresetName: String(profile?.apiPresetName || ''),
                llmPresetName: String(profile?.promptPresetName || ''),
                messages,
                tools,
                round,
                abortSignal,
            });

            const assistantText = String(response?.assistantText || '').trim();
            if (assistantText) {
                lastNaturalText = assistantText;
            }

            const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
            traceApi.record(trace, 'llm_response', {
                round,
                tool_call_count: toolCalls.length,
                has_assistant_text: Boolean(assistantText),
            });

            if (toolCalls.length === 0) {
                noToolCallStreak += 1;
                traceApi.record(trace, 'agent_no_tool_call', {
                    round,
                    streak: noToolCallStreak,
                });
                if (noToolCallStreak >= NO_TOOL_CALL_STREAK_LIMIT) {
                    exhaustReason = 'no_tool_call_streak';
                    traceApi.record(trace, 'budget_exhausted', {
                        round,
                        reason: 'no_tool_call_streak',
                        streak: noToolCallStreak,
                        limit: NO_TOOL_CALL_STREAK_LIMIT,
                    });
                    break;
                }
                continue;
            }
            noToolCallStreak = 0;

            // Append the assistant message that produced these tool calls so
            // the next round sees a well-formed messages array (per OpenAI's
            // tool-calling convention: assistant turn first, then matching
            // role:tool results in order).
            const assistantToolCallEntries = toolCalls.map(tc => ({
                id: String(tc?.id || makeToolCallId()),
                type: 'function',
                function: {
                    name: String(tc?.name || ''),
                    arguments: safeStringifyArgs(tc?.args),
                },
            }));
            messages.push({
                role: 'assistant',
                content: assistantText,
                tool_calls: assistantToolCallEntries,
            });

            for (let i = 0; i < toolCalls.length; i += 1) {
                const tc = toolCalls[i];
                const persistedId = assistantToolCallEntries[i].id;
                const name = String(tc?.name || '').trim();
                const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
                traceApi.record(trace, 'tool_call', { round, name, tool_call_id: persistedId });

                if (name === 'finalize') {
                    const text = String(args?.capsule_text || '').trim();
                    if (text) {
                        capsule = text;
                        traceApi.record(trace, 'tool_result', {
                            round,
                            name,
                            tool_call_id: persistedId,
                            finalized: true,
                        });
                        // Record the finalize tool result for completeness.
                        messages.push(makeOkToolMessage(persistedId, { ok: true, finalized: true }));
                        break;
                    }
                    // Empty finalize — feed back as a structured error so
                    // the agent can retry on the next round.
                    const finalizeErr = new ToolError(
                        'finalize requires a non-empty capsule_text.',
                        'FINALIZE_EMPTY',
                        'Provide a non-empty capsule_text describing the guidance for the next turn.',
                    );
                    messages.push(makeErrorToolMessage(persistedId, finalizeErr));
                    traceApi.record(trace, 'tool_error', {
                        round,
                        name,
                        tool_call_id: persistedId,
                        code: finalizeErr.code,
                        error: finalizeErr.message,
                    });
                    continue;
                }

                try {
                    const result = await executeTool(name, args, toolContext);
                    messages.push(makeOkToolMessage(persistedId, normalizeToolOk(result)));
                    traceApi.record(trace, 'tool_result', { round, name, tool_call_id: persistedId });
                } catch (error) {
                    if (error instanceof ToolError) {
                        messages.push(makeErrorToolMessage(persistedId, error));
                        traceApi.record(trace, 'tool_error', {
                            round,
                            name,
                            tool_call_id: persistedId,
                            code: error.code,
                            error: error.message,
                        });
                        continue;
                    }
                    throw error;
                }
            }

            if (capsule !== null) break;
        }
        if (!exhaustReason && capsule === null) {
            exhaustReason = 'max_rounds';
            traceApi.record(trace, 'budget_exhausted', {
                round: totalRounds,
                reason: 'max_rounds',
                limit: maxRounds,
            });
        }
    } catch (error) {
        traceApi.finalize(trace, 'failed', {
            error: String(error?.message || error),
        });
        throw error;
    }

    if (capsule === null) {
        traceApi.finalize(trace, 'budget_exhausted', {
            note: `Loop exhausted (${exhaustReason || 'max_rounds'}).`,
            capsuleText: lastNaturalText || '',
        });
        return {
            status: 'budget_exhausted',
            capsule: lastNaturalText,
            total_rounds: totalRounds,
            runtimeTrace: trace,
        };
    }

    traceApi.finalize(trace, 'completed', {
        capsuleText: capsule,
    });
    return { status: 'completed', capsule, total_rounds: totalRounds, runtimeTrace: trace };
}

function makeToolCallId() {
    return `loop_tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeStringifyArgs(value) {
    try {
        return JSON.stringify(value && typeof value === 'object' ? value : {});
    } catch {
        return '{}';
    }
}

function makeOkToolMessage(toolCallId, payload) {
    return {
        role: 'tool',
        tool_call_id: String(toolCallId || ''),
        content: safeStringifyToolPayload(payload),
    };
}

function makeErrorToolMessage(toolCallId, error) {
    const payload = {
        ok: false,
        error: String(error?.message || error || ''),
        code: String(error?.code || 'TOOL_ERROR'),
        hint: String(error?.hint || ''),
    };
    return {
        role: 'tool',
        tool_call_id: String(toolCallId || ''),
        content: safeStringifyToolPayload(payload),
    };
}

function normalizeToolOk(result) {
    if (result === null || result === undefined) {
        return { ok: true };
    }
    if (typeof result === 'object' && !Array.isArray(result) && Object.prototype.hasOwnProperty.call(result, 'ok')) {
        return result;
    }
    return { ok: true, data: result };
}

function safeStringifyToolPayload(payload) {
    try {
        return JSON.stringify(payload);
    } catch {
        return JSON.stringify({ ok: false, error: 'Tool result was not JSON-serializable.', code: 'TOOL_RESULT_UNSERIALIZABLE', hint: '' });
    }
}
