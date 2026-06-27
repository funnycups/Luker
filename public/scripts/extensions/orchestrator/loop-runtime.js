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
import { canonicalStringifyArgs } from './canonical-stringify.js';
import { executeLoopTool, getEnabledToolSchemas, resolveToolSource } from './loop-tools.js';
import { buildPerRunCustomToolRegistry } from './per-run-custom-tools.js';
import {
    appendRound, appendToSection, ensureSection,
    finishRun, setRoundStatus, setSectionStatus, startRun, addTokenUsage,
} from './run-state/store.js';
import { i18n, i18nFormat } from './i18n.js';

// Skill-resolution helpers are loaded lazily so the transitive import chain
// (skill-resolution → skillsApi → script.js → lib.js) stays out of module
// evaluation. Production runs hit the dynamic import once per process; tests
// that exercise pure helpers never reach it.
let _skillResolutionPromise = null;
async function loadSkillResolution() {
    if (!_skillResolutionPromise) {
        _skillResolutionPromise = import('./skill-resolution.js');
    }
    return _skillResolutionPromise;
}

// tool-calling.js is loaded lazily inside the runtime entry point —
// it pulls `lib.js` (a build-only bundle) and would otherwise refuse
// to load under the Node-based test runner. Tests inject `deps.sendLlm`
// directly; production resolves the real module via dynamic import.
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
 * Duck-type predicate for structured tool errors. Layer-2 tools live in
 * extension modules (e.g. memory-graph/orchestrator-tools.js) that
 * declare their own `ToolError` class locally to avoid depending on
 * orchestrator internals. Those errors satisfy the same wire contract
 * (`name === 'ToolError'`, string `code`/`hint`) but fail
 * `instanceof ToolError` across the module boundary because they extend
 * a different `Error` subclass.
 *
 * Runtimes (loop / spec / agenda) catch dispatched tool errors and
 * decide whether to convert them into a structured `role: tool` reply
 * or rethrow. The gate must duck-type on the wire shape, not on class
 * identity, so cross-module Layer-2 errors are still surfaced to the
 * agent as recoverable tool errors rather than crashing the run.
 */
export function isStructuredToolError(err) {
    return Boolean(
        err
        && typeof err === 'object'
        && err.name === 'ToolError'
        && typeof err.code === 'string',
    );
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
async function defaultSendLlm({ context, settings, messages, tools, runtimeWorldInfo, apiPresetName, llmPresetName, abortSignal, onUsage }) {
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
        onUsage: typeof onUsage === 'function' ? onUsage : null,
    });
    if (Array.isArray(result)) {
        // Returned shape when includeAssistantText is false — shouldn't
        // happen here, but normalize defensively.
        return { toolCalls: result, assistantText: '', reasoning: '' };
    }
    return {
        toolCalls: Array.isArray(result?.toolCalls) ? result.toolCalls : [],
        assistantText: String(result?.assistantText || ''),
        reasoning: String(result?.reasoning || ''),
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

function makeInMemoryTrace(context, payload, extra) {
    // Inline trace builder. The legacy runtime-trace.js module is gone;
    // the simulation-payload-adapter and the loop test suite still read
    // the same shape so the runner keeps producing it locally. Run-panel
    // state lives in run-state/store.js and is written alongside.
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

function recordToTrace(trace, type, details = {}) {
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

function finalizeTrace(trace, status, details = {}) {
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
    recordToTrace(trace, 'run_finished', {
        status: normalizedStatus,
        note: trace.note,
        error: trace.error,
    });
}

function attachLoopConversation(trace, conversation) {
    if (!trace || typeof trace !== 'object') return;
    if (!conversation || typeof conversation !== 'object') {
        if (trace.loop) delete trace.loop.conversation;
        return;
    }
    if (!trace.loop || typeof trace.loop !== 'object') {
        trace.loop = {};
    }
    trace.loop.conversation = conversation;
}

/**
 * Render the `## Open Notes` block injected into the loop-mode system
 * prompt. The block opens with a one-line header explaining what the
 * thread list is for and then enumerates every open note with its
 * stable id prefix (`[id]`) so the agent can refer back to the entry
 * by id when calling `note_close`. Closed notes never appear here —
 * `attachNotesFloorState` filters to `status === 'open'` before this
 * function runs.
 *
 * @internal — exposed for tests via `__testBuildInitialMessages`.
 */
function renderOpenNotesSection(rawNotes) {
    const open = Array.isArray(rawNotes) ? rawNotes : [];
    if (open.length === 0) return '';
    const lines = ['', '## Open Notes (your plot-author threads — close with note_close when deployed)'];
    for (const n of open) {
        const id = String(n?.id ?? '').trim();
        const text = String(n?.text ?? '');
        if (!id && !text) continue;
        lines.push(`- [${id}] ${text}`);
    }
    return lines.join('\n');
}

function buildInitialMessages(context, _payload, profile) {
    const systemContent = String(profile?.system_prompt || '').trim();
    const openNotesBlock = renderOpenNotesSection(context?.__openNotes);
    const body = systemContent + (openNotesBlock ? '\n' + openNotesBlock : '');
    return body
        ? [{ role: 'system', content: body }]
        : [];
}

/**
 * @internal — exposed for tests. `buildInitialMessages` would otherwise
 * be private to this module; tests use this alias to assert the system
 * prompt body against `context.__openNotes` shapes without booting the
 * full `runLoopOrchestration` loop.
 */
export const __testBuildInitialMessages = buildInitialMessages;

const NOTES_NAMESPACE = 'luker_orch_loop_notes';
let notesFloorStatePromise = null;

/**
 * Module-level change broadcaster for notes writes. The adapter built by
 * `makeNotesAdapter` invokes `emitNotesChanged()` after any successful
 * append / status flip / text edit / delete; subscribers registered via
 * `onNotesChanged` then re-read the adapter to reflect the new state.
 *
 * This is the wakeup channel the UI panel (`notes-panel.js`) uses to
 * rerender after an LLM-driven `note_open` / `note_close` lands mid-run —
 * without it, the panel only refreshes on chat switch.
 *
 * Single-emitter design: every chat funnels through the same notesFloor-
 * State singleton, so a single bus is enough. Subscribers re-query the
 * adapter on each fire and naturally render whatever the current chat
 * holds; a stray fire from an unrelated path is at worst one extra
 * read of the same data.
 */
const notesChangeListeners = new Set();

function emitNotesChanged() {
    for (const fn of notesChangeListeners) {
        try {
            fn();
        } catch (err) {
            // A misbehaving subscriber must not break the write path or
            // starve sibling subscribers. The adapter's write already
            // committed by the time we get here.
            console.warn('[orchestrator/loop] notes change listener threw', err);
        }
    }
}

/**
 * Subscribe to notes-mutation events. The callback fires after every
 * successful adapter write (append / status flip / text edit / delete);
 * no-op outcomes (`already_closed`, `not_found`, empty-delete) do NOT
 * fire so subscribers don't rerender on dud calls.
 *
 * @param {() => void} listener
 * @returns {() => void} unsubscribe handle
 */
export function onNotesChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    notesChangeListeners.add(listener);
    return () => { notesChangeListeners.delete(listener); };
}

/**
 * @internal — exposed for tests. Drop every registered listener so
 * cross-test bleed (listener from test A still firing during test B)
 * cannot mask real bugs.
 */
export function __resetNotesChangeListenersForTesting() {
    notesChangeListeners.clear();
}

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
 * Build the production adapter expected by `loop-tools/note.js` and the
 * Task 12 notes UI panel. The underlying floor-state instance stores
 * notes as an ordered array under a single key (`entries`) inside the
 * data namespace; reads / writes go through `fs.update(reducer, { floor })`
 * so each commit is incremental.
 *
 * Adapter shape (matches the test fixture in `loop-tools-note.test.js`):
 *
 *   {
 *     appendForFloor(floor, text): Promise<string>
 *       // returns new id; entry persisted with status: 'open'
 *     listAcrossFloors(): Promise<Array<{id, text, status, closure_reason?}>>
 *       // chronological; full entry shape so the UI panel can show
 *       // closure reasons. Legacy entries without `status` are
 *       // surfaced as status='open' by the lazy migration so the
 *       // open-notes prompt filter has a stable field to read.
 *     updateStatusById(id, status, reason?): Promise<{ok:true} | {ok:false, error:string}>
 *       // flip a single entry's status; reports `already_<status>` on no-op
 *     updateTextById(id, text): Promise<{ok:true} | {ok:false, error:string}>
 *       // mutate an existing entry's text (used by UI / curator agent)
 *     deleteByIds(ids: string[]): Promise<{ removed: string[], missing: string[] }>
 *       // hard-delete from storage (used by UI / curator agent, not the LLM tools).
 *       // `removed` is the list of ids that were actually present and dropped;
 *       // `missing` is the requested ids that were not in storage. The UI can
 *       // diff its optimistic list against `removed` directly without an
 *       // index-based reconciliation against the original request.
 *   }
 *
 * Each note carries a stable id assigned at append time and a `status`
 * field (`'open'` for fresh notes; flipped to `'closed'` by `note_close`).
 * The id is visible to the LLM in the `## Open Notes` system-prompt block
 * so subsequent `note_close` calls reference it directly — there is no
 * positional / index resolution and no per-run snapshot.
 *
 * Legacy entries stored as bare strings (pre-status) are migrated lazily:
 * on first read after the upgrade, an `fs.update` rewrites them as
 * `{id, text}` rows (no `status` field — the open-notes filter treats
 * missing status as `'open'`). Subsequent reads see the migrated shape
 * directly.
 *
 * A simple promise-chain mutex serializes append / status-update /
 * text-update / deleteByIds so a concurrent multi-agent caller can't
 * observe a partial write. Reads are not gated — they may snapshot
 * mid-operation but each individual `fs.update` is atomic.
 */
function makeNotesAdapter(fs) {
    let chain = Promise.resolve();
    const lock = (fn) => {
        const next = chain.then(fn, fn);
        chain = next.catch(() => {});
        return next;
    };

    const mintId = () => `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const normalizeEntries = (raw) => {
        const arr = Array.isArray(raw) ? raw : [];
        const out = [];
        let dirty = false;
        for (const entry of arr) {
            if (entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.text === 'string') {
                // Preserve status / closure_reason when present so a round-trip
                // through normalize doesn't strip the state machine fields.
                const next = { id: entry.id, text: entry.text };
                if (typeof entry.status === 'string') next.status = entry.status;
                if (typeof entry.closure_reason === 'string') next.closure_reason = entry.closure_reason;
                out.push(next);
            } else if (typeof entry === 'string') {
                // Legacy bare-string entry from pre-status chats. Upgrade
                // shape lazily; leave status unset so the open-notes filter
                // treats it as 'open' by default (back-compat).
                out.push({ id: mintId(), text: entry });
                dirty = true;
            }
            // Anything else (null, number, malformed object) is dropped — the
            // floor-state shouldn't have it, but defending here keeps a single
            // corrupt write from poisoning the whole list.
        }
        return { entries: out, dirty };
    };

    // fs.update returns false when the underlying chat-state patch is rejected
    // (target unresolvable, HTTP failure, replay conflict, etc.). Surface that
    // as a thrown ToolError so execNoteOpen / execNoteClose can report the
    // failure to the agent instead of returning a fake-success id the panel
    // and the agent both believe — see Task 7.
    const throwOnWriteFailure = (op) => {
        throw new ToolError(
            `${op}: notes write rejected by floor-state.`,
            'NOTE_WRITE_FAILED',
            'The chat-state patch did not land (typical causes: chat not yet persisted, target chat unresolved, or a replay conflict). The note was NOT saved. Retry once; if it still fails, drop the note for this turn.',
        );
    };

    return {
        async appendForFloor(floor, text) {
            const targetFloor = Math.max(0, Math.floor(Number(floor) || 0));
            const id = mintId();
            const ok = await lock(() => fs.update((current) => {
                const safe = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
                const { entries } = normalizeEntries(safe.entries);
                entries.push({ id, text: String(text), status: 'open' });
                return { ...safe, entries };
            }, { floor: targetFloor }));
            if (ok === false) throwOnWriteFailure('note_open');
            emitNotesChanged();
            return id;
        },
        async listAcrossFloors() {
            await fs.ready();
            const data = await fs.get();
            const safe = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
            const { entries, dirty } = normalizeEntries(safe.entries);
            // Lazy migration: if any legacy string entries were upgraded,
            // commit the new shape back so subsequent reads see stable ids.
            if (dirty) {
                await lock(() => fs.update((current) => {
                    const inner = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
                    const { entries: migrated } = normalizeEntries(inner.entries);
                    return { ...inner, entries: migrated };
                }));
            }
            // Return the full entry shape (id, text, status, closure_reason)
            // so the UI panel in Task 12 can render closure metadata. The
            // open-notes prompt filter in `loadOpenNotes` projects to its
            // own narrower shape.
            return entries.map(e => {
                const out = { id: e.id, text: e.text };
                if (typeof e.status === 'string') out.status = e.status;
                if (typeof e.closure_reason === 'string') out.closure_reason = e.closure_reason;
                return out;
            });
        },
        async updateStatusById(id, status, reason) {
            const targetId = String(id || '').trim();
            if (!targetId) return { ok: false, error: 'not_found' };
            const nextStatus = String(status || '');
            let outcome = { ok: false, error: 'not_found' };
            const writeOk = await lock(() => fs.update((current) => {
                const safe = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
                const { entries } = normalizeEntries(safe.entries);
                const idx = entries.findIndex(e => e.id === targetId);
                if (idx < 0) {
                    outcome = { ok: false, error: 'not_found' };
                    return current;
                }
                const existing = entries[idx];
                const existingStatus = existing.status ?? 'open';
                if (existingStatus === nextStatus) {
                    outcome = { ok: false, error: 'already_' + nextStatus };
                    return current;
                }
                const next = { ...existing, status: nextStatus };
                if (typeof reason === 'string' && reason.length > 0) {
                    next.closure_reason = reason;
                }
                entries[idx] = next;
                outcome = { ok: true };
                return { ...safe, entries };
            }));
            // Distinguish a no-op reducer (writeOk === true with outcome.ok === false
            // means the reducer found a logical reason like not_found / already_*) from
            // a real write rejection (writeOk === false means the patch itself failed).
            // Only the latter must throw — the reducer's no-op outcomes are legitimate
            // tool results the agent should react to.
            if (writeOk === false && outcome.ok) throwOnWriteFailure('note_close');
            if (outcome.ok) emitNotesChanged();
            return outcome;
        },
        async updateTextById(id, text) {
            const targetId = String(id || '').trim();
            if (!targetId) return { ok: false, error: 'not_found' };
            const nextText = String(text ?? '');
            let outcome = { ok: false, error: 'not_found' };
            const writeOk = await lock(() => fs.update((current) => {
                const safe = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
                const { entries } = normalizeEntries(safe.entries);
                const idx = entries.findIndex(e => e.id === targetId);
                if (idx < 0) {
                    outcome = { ok: false, error: 'not_found' };
                    return current;
                }
                entries[idx] = { ...entries[idx], text: nextText };
                outcome = { ok: true };
                return { ...safe, entries };
            }));
            if (writeOk === false && outcome.ok) throwOnWriteFailure('note_edit');
            if (outcome.ok) emitNotesChanged();
            return outcome;
        },
        async deleteByIds(ids) {
            const requested = new Set((Array.isArray(ids) ? ids : [])
                .map(v => String(v || '').trim())
                .filter(Boolean));
            if (requested.size === 0) return { removed: [], missing: [] };

            // `removed` collects the ids that were actually present and dropped
            // (not just a count), so the UI panel can diff its optimistic state
            // against the result without a positional reconciliation against
            // the original request. `seen` tracks every id we walked past so
            // we can compute `missing` (= requested - seen) after the write.
            const removed = [];
            const seen = new Set();
            const writeOk = await lock(() => fs.update((current) => {
                const safe = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
                const { entries } = normalizeEntries(safe.entries);
                const kept = [];
                removed.length = 0; // reset in case fs.update retries the reducer
                for (const entry of entries) {
                    seen.add(entry.id);
                    if (requested.has(entry.id)) {
                        removed.push(entry.id);
                        continue;
                    }
                    kept.push(entry);
                }
                return { ...safe, entries: kept };
            }));
            // Same shape as updateStatusById: only treat writeOk === false as a real
            // failure when something was actually meant to be deleted. If `removed`
            // is empty, the reducer was a no-op (all ids missing) and writeOk may
            // legitimately be true with nothing changed — there is no rejection to
            // surface.
            if (writeOk === false && removed.length > 0) throwOnWriteFailure('note_delete');
            const missing = [];
            for (const id of requested) {
                if (!seen.has(id)) missing.push(id);
            }
            if (removed.length > 0) emitNotesChanged();
            return { removed, missing };
        },
    };
}

/**
 * Production wiring for `note_open` / `note_close` (Task 11+).
 *
 * Mounts the `luker_orch_loop_notes` floor-state namespace, exposes the
 * adapter on `context.__floorStateForNotes` (with `appendForFloor` /
 * `listAcrossFloors` / `updateStatusById` / `updateTextById` /
 * `deleteByIds`), and pre-populates `context.__openNotes` with the
 * filtered subset `[{ id, text }]` so `buildInitialMessages` can render
 * the `## Open Notes` system-prompt block without re-querying the
 * adapter mid-build.
 *
 * Closed notes are filtered out before stashing — they stay in floor
 * storage as history (the UI panel renders them with their
 * `closure_reason`), but the agent never sees them again in its
 * prompt. Notes without a `status` field (legacy entries pre-state-
 * machine) are treated as open.
 *
 * Failures degrade silently: the adapter stays null and `__openNotes`
 * stays `[]`, so the agent simply doesn't get an Open Notes block this
 * run (and any `note_open` / `note_close` call surfaces
 * `NOTE_FS_UNAVAILABLE`).
 *
 * @param {object} context — toolContext (mutated in place)
 */
export async function attachNotesFloorState(context) {
    if (!context || typeof context !== 'object') return;
    try {
        const fs = await getNotesFloorStateInstance(context);
        if (!fs || typeof fs.ready !== 'function' || typeof fs.get !== 'function' || typeof fs.update !== 'function') {
            context.__floorStateForNotes = null;
            context.__openNotes = [];
            return;
        }
        const adapter = makeNotesAdapter(fs);
        context.__floorStateForNotes = adapter;
        const initial = await adapter.listAcrossFloors();
        // Only the open subset goes into the system prompt. The UI panel
        // (Task 12) reads the full entry list directly from the adapter
        // so it can show closure metadata.
        context.__openNotes = Array.isArray(initial)
            ? initial
                .filter(e => e && typeof e === 'object' && (e.status ?? 'open') === 'open')
                .map(e => ({ id: String(e.id || ''), text: String(e.text || '') }))
            : [];
    } catch (_error) {
        context.__floorStateForNotes = null;
        context.__openNotes = [];
    }
}

/**
 * Build a per-run tool dispatch context bundling the run-scoped metadata
 * every loop-tool family depends on:
 *
 *   - `__lukerRun.activatedEntryKeys` — World Info entries already
 *     injected for this turn, populated by the orchestrator's
 *     `onWorldInfoFinalized` hook and forwarded by `main.js` on the
 *     generation payload. `lorebook_search` reads this to dedup.
 *   - `__floorStateForNotes` adapter + `__openNotes` — per-chat
 *     persistent notes; `note_open` / `note_close` plus the
 *     system-prompt builder all read this. `__openNotes` carries only
 *     the open subset (closed entries stay in floor storage as
 *     history but are filtered out of the prompt-injection path).
 *
 * memory-graph's session is no longer threaded on this context —
 * memory tools live in memory-graph's own Layer-2 module and open the
 * session lazily on first call (cached by ctx via a WeakMap). The
 * orchestrator stays unaware of memory-graph.
 *
 * The returned object is created via `Object.create(context)` so caller
 * sees a fresh frame whose unset fields fall through to the upstream
 * extension context. Tests pre-populate the relevant
 * `__floorStateForNotes` / `__openNotes` fields on the upstream context
 * to skip the production loaders — that "undefined means not-set, load
 * it" gate per attachment is preserved here.
 *
 * Used by `runLoopOrchestration` directly and exported so spec / agenda
 * runtimes can reuse the same context shape when their nodes / agents
 * opt into loop tools through the `tools` cascade.
 *
 * @param {object} context — extension context (chat lives here)
 * @param {object} payload — generation payload (carries `__lukerRun`)
 * @returns {Promise<object>} the tool dispatch context (mutated copy)
 */
export async function attachToolContext(context, payload) {
    const toolContext = context && typeof context === 'object'
        ? Object.create(context)
        : {};
    if (payload && typeof payload === 'object' && payload.__lukerRun && typeof payload.__lukerRun === 'object') {
        toolContext.__lukerRun = payload.__lukerRun;
    } else if (!toolContext.__lukerRun) {
        toolContext.__lukerRun = { activatedEntryKeys: new Set() };
    }
    // Expose the abort signal through __lukerRun so custom tools (Layer-2
    // extension-registered or Layer-3 handwritten) can implement
    // cooperative cancellation without rummaging through payload. Set
    // only when the runtime actually has one — null means "no abort
    // policy bound to this run", which custom tools should treat as
    // "never aborted".
    const sig = isAbortSignalLike(payload?.signal) ? payload.signal : null;
    if (sig && !toolContext.__lukerRun.abortSignal) {
        toolContext.__lukerRun.abortSignal = sig;
    }

    // Expose a tool-invocation seam for Layer-3 customTools that need to
    // compose Layer-1 builtins (e.g. a customTool wrapper around
    // `lorebook_force_activate`). Bound to this toolContext so the
    // composed tool sees the same __lukerRun (activatedEntryKeys, etc.)
    // and __customToolRegistry. Returns whatever the underlying tool
    // returns; throws the same ToolError shape on failure.
    toolContext.__invokeLoopTool = async (toolName, toolArgs) => {
        const { executeLoopTool } = await import('./loop-tools.js');
        return executeLoopTool(toolName, toolArgs, toolContext);
    };

    if (toolContext.__floorStateForNotes === undefined && toolContext.__openNotes === undefined) {
        await attachNotesFloorState(toolContext);
    }

    return toolContext;
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
 * @param {{ sendLlm?: Function, executeTool?: Function, settings?: object, runtimeWorldInfo?: object }} [deps]
 * @returns {Promise<{status: string, capsule: string|null, total_rounds: number, runtimeTrace: object}>}
 */
export async function runLoopOrchestration(context, payload, profile, deps = {}) {
    const sendLlm = typeof deps?.sendLlm === 'function' ? deps.sendLlm : defaultSendLlm;
    const executeTool = typeof deps?.executeTool === 'function' ? deps.executeTool : defaultExecuteTool;

    const abortSignal = isAbortSignalLike(payload?.signal) ? payload.signal : null;
    throwIfAborted(abortSignal, 'Orchestration aborted.');

    const toolContext = await attachToolContext(context, payload);

    const trace = makeInMemoryTrace(context, payload, { mode: 'loop' });

    const customToolRegistry = buildPerRunCustomToolRegistry(profile, trace, recordToTrace);
    toolContext.__customToolRegistry = customToolRegistry;

    // Open a new run on the panel store. `startRun` throws if a previous
    // run is still flagged running — under normal flow main.js clears the
    // store between turns; tests preload `clearCurrentRun` in beforeEach.
    // `payload.__lukerSimulate` marks iter-studio dry-runs; the panel
    // skips auto-open + pill for those so the iter-studio popup + the
    // simulation review popup are the only surfaces the user sees.
    const chatKey = String(context?.chatId || context?.chat_id || '');
    const runId = startRun({
        mode: 'loop',
        chatKey,
        abortFn: () => { try { context.stopGeneration?.(); } catch (_) { /* best-effort */ } },
        quiet: Boolean(payload?.__lukerSimulate),
    });

    const messages = buildInitialMessages(toolContext, payload, profile);
    const tools = getEnabledToolSchemas(profile, customToolRegistry);
    const maxRounds = Math.max(1, Math.floor(Number(profile?.max_rounds) || 1));
    const wallClockBudgetMs = Math.max(0, Math.floor(Number(profile?.wall_clock_budget_ms) || 0));
    const deadline = wallClockBudgetMs > 0 ? Date.now() + wallClockBudgetMs : null;

    // Resolve skills visible to the loop agent and append the
    // `<available_skills>` catalog block to its system prompt. Loop is a
    // single-agent mode, so the resolver sees only the mode-level
    // `profile.skills` (no per-agent overlay). Failure falls back to an
    // empty list — the agent runs without a catalog and any skill_* tool
    // call rejects (the exec requires a populated __visibleSkillsForAgent).
    let visibleSkillsForLoop = [];
    try {
        const skillRes = await loadSkillResolution();
        visibleSkillsForLoop = await skillRes.resolveAgentVisibleSkills({
            modeProfile: profile,
            agentConfig: null,
            runtimeContext: skillRes.buildSkillRuntimeContext(context, profile),
        });
        const block = skillRes.buildAvailableSkillsBlock(visibleSkillsForLoop);
        if (block && messages.length > 0 && messages[0]?.role === 'system') {
            messages[0].content = (messages[0].content || '') + '\n\n' + block;
        } else if (block) {
            // No system message — buildInitialMessages returns [] when
            // both the prompt and notes block are empty. Insert one.
            messages.unshift({ role: 'system', content: block });
        }
    } catch (e) {
        console.warn('[orchestrator-loop] skill resolution failed:', e?.message || e);
    }
    // Make the loop agent's visible-skills list reachable through the
    // tool dispatch context so skill_list / skill_read / skill_search
    // see the scoped visibility.
    toolContext.__visibleSkillsForAgent = visibleSkillsForLoop;

    // Alias the running messages array onto the trace so the popup's
    // loop-conversation panel reflects the agent's history as it grows.
    // sanitization happens at render time; here we just point at the
    // live array (no clone — avoids per-round O(N) cost for long loops).
    attachLoopConversation(trace, { messages });

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
                recordToTrace(trace, 'budget_exhausted', {
                    round,
                    reason: 'wall_clock',
                    deadline_ms: wallClockBudgetMs,
                });
                break;
            }
            totalRounds = round;
            recordToTrace(trace, 'llm_request', {
                round,
                max_rounds: maxRounds,
                message_count: messages.length,
            });

            const roundId = `agent-${round}`;
            appendRound({ runId, round: { id: roundId, label: i18nFormat('Agent · round ${0}', round) } });
            const textSectionId = ensureSection({ runId, roundId, section: { id: 'text', kind: 'text', title: i18n('Text') } });

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
                onUsage: (usage) => {
                    try { addTokenUsage({ runId, usage }); } catch (_) { /* store may have been cleared */ }
                },
            });

            const assistantText = String(response?.assistantText || '').trim();
            if (assistantText) {
                lastNaturalText = assistantText;
                appendToSection({ runId, roundId, sectionId: textSectionId, delta: assistantText });
            }
            const reasoning = String(response?.reasoning || '');
            if (reasoning) {
                const reasoningSectionId = ensureSection({ runId, roundId, section: { id: 'reasoning', kind: 'reasoning', title: i18n('Reasoning') } });
                appendToSection({ runId, roundId, sectionId: reasoningSectionId, delta: reasoning });
                setSectionStatus({ runId, roundId, sectionId: reasoningSectionId, status: 'done' });
            }
            setSectionStatus({ runId, roundId, sectionId: textSectionId, status: 'done' });

            const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
            recordToTrace(trace, 'llm_response', {
                round,
                tool_call_count: toolCalls.length,
                has_assistant_text: Boolean(assistantText),
            });

            if (toolCalls.length === 0) {
                noToolCallStreak += 1;
                recordToTrace(trace, 'agent_no_tool_call', {
                    round,
                    streak: noToolCallStreak,
                });
                setRoundStatus({ runId, roundId, status: 'done' });
                if (noToolCallStreak >= NO_TOOL_CALL_STREAK_LIMIT) {
                    exhaustReason = 'no_tool_call_streak';
                    recordToTrace(trace, 'budget_exhausted', {
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
            // role:tool results in order). Names are normalized `.` → `_`
            // so a hallucinated dotted name doesn't drift the next round's
            // history out of sync with the (underscore-only) tools list.
            // `source` tags the layer that will serve the dispatch
            // (builtin / extension / profile / st-bridge / unknown) so the
            // trace popup can render a layer chip next to the tool name.
            const assistantToolCallEntries = toolCalls.map(tc => {
                const normalizedName = String(tc?.name || '').replace(/\./g, '_');
                return {
                    id: String(tc?.id || makeToolCallId()),
                    type: 'function',
                    function: {
                        name: normalizedName,
                        arguments: safeStringifyArgs(tc?.args),
                    },
                    source: resolveToolSource(normalizedName, toolContext),
                };
            });
            messages.push({
                role: 'assistant',
                content: assistantText,
                reasoning,
                tool_calls: assistantToolCallEntries,
                _round: round,
            });

            for (let i = 0; i < toolCalls.length; i += 1) {
                const tc = toolCalls[i];
                const persistedId = assistantToolCallEntries[i].id;
                const name = String(tc?.name || '').trim();
                const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
                const source = assistantToolCallEntries[i].source;
                recordToTrace(trace, 'tool_call', { round, name, tool_call_id: persistedId, source });

                const toolCallSectionId = ensureSection({
                    runId, roundId,
                    section: { id: `tool-${i}`, kind: 'tool_call', title: i18nFormat('Tool: ${0}', name), meta: { args, source } },
                });

                if (name === 'finalize') {
                    const text = String(args?.capsule_text || '').trim();
                    if (text) {
                        capsule = text;
                        recordToTrace(trace, 'tool_result', {
                            round,
                            name,
                            tool_call_id: persistedId,
                            finalized: true,
                        });
                        // Record the finalize tool result for completeness.
                        messages.push(makeOkToolMessage(persistedId, { ok: true, finalized: true }, round));
                        const finalizeResultSectionId = ensureSection({
                            runId, roundId,
                            section: { id: `tool-result-${i}`, kind: 'tool_result', title: i18nFormat('Tool result: ${0}', name), meta: { ok: true, finalized: true } },
                        });
                        setSectionStatus({ runId, roundId, sectionId: finalizeResultSectionId, status: 'done' });
                        setSectionStatus({ runId, roundId, sectionId: toolCallSectionId, status: 'done' });
                        break;
                    }
                    // Empty finalize — feed back as a structured error so
                    // the agent can retry on the next round.
                    const finalizeErr = new ToolError(
                        'finalize requires a non-empty capsule_text.',
                        'FINALIZE_EMPTY',
                        'Provide a non-empty capsule_text describing the guidance for the next turn.',
                    );
                    messages.push(makeErrorToolMessage(persistedId, finalizeErr, round));
                    recordToTrace(trace, 'tool_error', {
                        round,
                        name,
                        tool_call_id: persistedId,
                        code: finalizeErr.code,
                        error: finalizeErr.message,
                    });
                    const finalizeErrSectionId = ensureSection({
                        runId, roundId,
                        section: { id: `tool-result-${i}`, kind: 'tool_result', title: i18nFormat('Tool result: ${0}', name), meta: { ok: false, err: finalizeErr.message, code: finalizeErr.code } },
                    });
                    setSectionStatus({ runId, roundId, sectionId: finalizeErrSectionId, status: 'failed' });
                    setSectionStatus({ runId, roundId, sectionId: toolCallSectionId, status: 'failed' });
                    continue;
                }

                try {
                    const result = await executeTool(name, args, toolContext);
                    messages.push(makeOkToolMessage(persistedId, normalizeToolOk(result), round));
                    recordToTrace(trace, 'tool_result', { round, name, tool_call_id: persistedId });
                    const okSectionId = ensureSection({
                        runId, roundId,
                        section: { id: `tool-result-${i}`, kind: 'tool_result', title: i18nFormat('Tool result: ${0}', name), meta: { ok: true } },
                    });
                    setSectionStatus({ runId, roundId, sectionId: okSectionId, status: 'done' });
                    setSectionStatus({ runId, roundId, sectionId: toolCallSectionId, status: 'done' });
                } catch (error) {
                    if (isStructuredToolError(error)) {
                        messages.push(makeErrorToolMessage(persistedId, error, round));
                        recordToTrace(trace, 'tool_error', {
                            round,
                            name,
                            tool_call_id: persistedId,
                            code: error.code,
                            error: error.message,
                        });
                        const errSectionId = ensureSection({
                            runId, roundId,
                            section: { id: `tool-result-${i}`, kind: 'tool_result', title: i18nFormat('Tool result: ${0}', name), meta: { ok: false, err: error.message, code: error.code } },
                        });
                        setSectionStatus({ runId, roundId, sectionId: errSectionId, status: 'failed' });
                        setSectionStatus({ runId, roundId, sectionId: toolCallSectionId, status: 'failed' });
                        continue;
                    }
                    setSectionStatus({ runId, roundId, sectionId: toolCallSectionId, status: 'failed' });
                    setRoundStatus({ runId, roundId, status: 'failed' });
                    throw error;
                }
            }

            setRoundStatus({ runId, roundId, status: 'done' });
            if (capsule !== null) break;
        }
        if (!exhaustReason && capsule === null) {
            exhaustReason = 'max_rounds';
            recordToTrace(trace, 'budget_exhausted', {
                round: totalRounds,
                reason: 'max_rounds',
                limit: maxRounds,
            });
        }
    } catch (error) {
        finalizeTrace(trace, 'failed', {
            error: String(error?.message || error),
        });
        try {
            finishRun({ runId, status: 'error', error: String(error?.message || error) });
        } catch (_) { /* run may already be cleared */ }
        throw error;
    }

    if (capsule === null) {
        finalizeTrace(trace, 'budget_exhausted', {
            note: `Loop exhausted (${exhaustReason || 'max_rounds'}).`,
            capsuleText: lastNaturalText || '',
        });
        try {
            finishRun({ runId, status: 'budget_exhausted', finalText: lastNaturalText || '' });
        } catch (_) { /* run may already be cleared */ }
        return {
            status: 'budget_exhausted',
            capsule: lastNaturalText,
            total_rounds: totalRounds,
            runtimeTrace: trace,
        };
    }

    finalizeTrace(trace, 'completed', {
        capsuleText: capsule,
    });
    try {
        finishRun({ runId, status: 'committed', finalText: capsule });
    } catch (_) { /* run may already be cleared */ }
    return { status: 'completed', capsule, total_rounds: totalRounds, runtimeTrace: trace };
}

function makeToolCallId() {
    return `loop_tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeStringifyArgs(value) {
    return canonicalStringifyArgs(value);
}

function makeOkToolMessage(toolCallId, payload, round) {
    return {
        role: 'tool',
        tool_call_id: String(toolCallId || ''),
        content: safeStringifyToolPayload(payload),
        _round: Number(round || 0),
    };
}

function makeErrorToolMessage(toolCallId, error, round) {
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
        _round: Number(round || 0),
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
