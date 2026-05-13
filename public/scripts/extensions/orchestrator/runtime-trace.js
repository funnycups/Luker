/**
 * Runtime trace model for the orchestrator.
 *
 * The "trace" is an in-memory record of one orchestration run — every
 * stage start/finish, every node attempt, every recorded event — used
 * by the runtime-trace popup to show users what happened. It is
 * scoped to a single chat (`trace.chatKey`) and lives only for the
 * page session; switching chats invalidates it.
 *
 * The trace state is a single module-private slot (`latestOrchestrationRuntimeTrace`).
 * Only one orchestration is in-flight per page at a time, so a single
 * slot is sufficient. `getLatest…` returns null when the cached trace
 * belongs to a different chat than the caller's; `clearLatest…`
 * invalidates the cache when chat changes or the user starts a new run.
 *
 * Event recording is append-only — every state transition (`run_started`,
 * `stage_started`, `node_started`, `node_finished`, `stage_finished`,
 * `run_finished`) lands in `trace.events` with a monotonic `seq` and an
 * ISO `at` timestamp. Per-node attempts also accumulate in
 * `trace.attempts` so the trace UI can render attempt bars without
 * re-walking the event stream.
 */

import { ORCH_NODE_TYPE_REVIEW } from './defaults.js';
import { toReadableYamlText } from './output-formatting.js';
import { getTargetAssistantLayer } from './capsule-injection.js';
import { getChatKey } from './snapshot-cache.js';
import {
    getStageRuntimeMode,
    normalizeNodeSpec,
    normalizeNodeType,
} from './spec-schema.js';

let latestOrchestrationRuntimeTrace = null;

export function cloneOrchestrationTraceValue(value) {
    if (typeof value === 'string') {
        return String(value);
    }
    if (value && typeof value === 'object') {
        return structuredClone(value);
    }
    return value;
}

export function buildOrchestrationRuntimeSlotKey(stageIndex, nodeIndex, nodeId = '') {
    return [Number(stageIndex), Number(nodeIndex), String(nodeId || '').trim()].join(':');
}

export function serializeOrchestrationRuntimeValue(value) {
    if (typeof value === 'string') {
        return String(value || '');
    }
    if (value && typeof value === 'object') {
        return toReadableYamlText(value, '{}');
    }
    if (value === undefined || value === null) {
        return '';
    }
    return String(value);
}

export function truncateOrchestrationRuntimePreview(value, maxChars = 240) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }
    return text.length > maxChars
        ? `${text.slice(0, maxChars).trimEnd()}…`
        : text;
}

export function buildOrchestrationRuntimeStageLayout(stages = []) {
    return (Array.isArray(stages) ? stages : []).map((stage, stageIndex) => ({
        stageIndex,
        id: String(stage?.id || `stage_${stageIndex + 1}`),
        mode: getStageRuntimeMode(stage),
        nodes: (Array.isArray(stage?.nodes) ? stage.nodes : []).map((rawNode, nodeIndex) => {
            const nodeSpec = normalizeNodeSpec(rawNode);
            return {
                stageIndex,
                nodeIndex,
                slotKey: buildOrchestrationRuntimeSlotKey(stageIndex, nodeIndex, nodeSpec.id),
                id: String(nodeSpec?.id || ''),
                preset: String(nodeSpec?.preset || ''),
                type: normalizeNodeType(nodeSpec?.type),
            };
        }).filter(node => node.id),
    }));
}

export function createOrchestrationRuntimeTrace(context, payload, stages = [], extra = {}) {
    const now = new Date().toISOString();
    const trace = {
        runId: `orch_runtime_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        chatKey: String(extra?.chatKey || getChatKey(context) || ''),
        status: String(extra?.status || 'running'),
        startedAt: String(extra?.startedAt || now),
        updatedAt: String(extra?.updatedAt || now),
        finishedAt: String(extra?.finishedAt || ''),
        generationType: String(payload?.type || extra?.generationType || '').trim().toLowerCase(),
        targetLayer: Number.isFinite(Number(extra?.targetLayer))
            ? Number(extra.targetLayer)
            : getTargetAssistantLayer(payload),
        note: String(extra?.note || ''),
        capsuleText: String(extra?.capsuleText || ''),
        error: String(extra?.error || ''),
        // Runtime mode marker — propagated from the extra bag so the trace
        // popup can pick a mode-specific layout. Spec mode passes nothing
        // and stays mode-less.
        mode: String(extra?.mode || ''),
        stages: buildOrchestrationRuntimeStageLayout(stages),
        attempts: [],
        events: [],
        nextEventSeq: 1,
        nextAttemptId: 1,
        reviewRerunCount: 0,
    };
    if (!extra?.skipStartEvent) {
        recordOrchestrationRuntimeEvent(trace, 'run_started', {
            status: trace.status,
            generationType: trace.generationType,
            targetLayer: trace.targetLayer,
            note: trace.note,
        });
    }
    latestOrchestrationRuntimeTrace = trace;
    return trace;
}

export function getLatestOrchestrationRuntimeTrace(context) {
    const trace = latestOrchestrationRuntimeTrace;
    if (!trace || typeof trace !== 'object') {
        return null;
    }
    const chatKey = getChatKey(context);
    if (String(trace.chatKey || '') !== String(chatKey || '')) {
        return null;
    }
    return trace;
}

export function clearLatestOrchestrationRuntimeTrace(context = null) {
    if (!context) {
        latestOrchestrationRuntimeTrace = null;
        return;
    }
    const trace = latestOrchestrationRuntimeTrace;
    if (!trace || typeof trace !== 'object') {
        return;
    }
    const chatKey = getChatKey(context);
    if (!chatKey || String(trace.chatKey || '') === String(chatKey || '')) {
        latestOrchestrationRuntimeTrace = null;
    }
}

/**
 * Append a generic event to a trace's `events` array. Accepts any `type`
 * string — spec / agenda mode use stage-shaped events (`stage_started`,
 * `node_started`, `node_finished`, `stage_finished`, `review_finished`),
 * loop mode (Task 12) uses a flat event stream (`llm_request` /
 * `llm_response` / `agent_no_tool_call` / `tool_call` / `tool_result` /
 * `tool_error` / `budget_exhausted`). Unknown types are accepted as-is so
 * downstream extensions can emit their own taxonomy without modifying this
 * file. The serialized JSONL export consumes `trace.events` directly.
 */
export function recordOrchestrationRuntimeEvent(trace, type, details = {}) {
    if (!trace || typeof trace !== 'object') {
        return null;
    }
    const event = {
        seq: Number(trace.nextEventSeq || 1),
        at: new Date().toISOString(),
        type: String(type || 'event'),
        ...structuredClone(details && typeof details === 'object' ? details : {}),
    };
    trace.nextEventSeq = event.seq + 1;
    trace.updatedAt = event.at;
    trace.events.push(event);
    return event;
}

export function finalizeOrchestrationRuntimeTrace(trace, status, details = {}) {
    if (!trace || typeof trace !== 'object') {
        return;
    }
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
    if (Object.prototype.hasOwnProperty.call(details || {}, 'reviewRerunCount')) {
        trace.reviewRerunCount = Math.max(0, Math.floor(Number(details?.reviewRerunCount) || 0));
    }
    recordOrchestrationRuntimeEvent(trace, 'run_finished', {
        status: normalizedStatus,
        note: trace.note,
        error: trace.error,
        reviewRerunCount: Number(trace.reviewRerunCount || 0),
    });
}

export function beginOrchestrationRuntimeStage(trace, stage, stageIndex, options = {}) {
    if (!trace || typeof trace !== 'object') {
        return null;
    }
    const stageState = {
        stageIndex: Number(stageIndex || 0),
        stageId: String(stage?.id || `stage_${Number(stageIndex || 0) + 1}`),
        mode: getStageRuntimeMode(stage),
        replay: Boolean(options?.replay),
        partial: Number.isInteger(options?.stopBeforeNodeIndex),
        stopBeforeNodeIndex: Number.isInteger(options?.stopBeforeNodeIndex) ? Number(options.stopBeforeNodeIndex) : null,
        startedAt: new Date().toISOString(),
    };
    recordOrchestrationRuntimeEvent(trace, 'stage_started', stageState);
    return stageState;
}

export function finishOrchestrationRuntimeStage(trace, stageState, details = {}) {
    if (!trace || typeof trace !== 'object' || !stageState || typeof stageState !== 'object') {
        return;
    }
    recordOrchestrationRuntimeEvent(trace, 'stage_finished', {
        stageIndex: Number(stageState.stageIndex || 0),
        stageId: String(stageState.stageId || ''),
        mode: String(stageState.mode || 'serial'),
        replay: Boolean(stageState.replay),
        partial: Boolean(stageState.partial),
        stopBeforeNodeIndex: Number.isInteger(stageState.stopBeforeNodeIndex) ? stageState.stopBeforeNodeIndex : null,
        status: String(details?.status || 'completed'),
        error: String(details?.error || ''),
        stageOutput: cloneOrchestrationTraceValue(details?.stageOutput),
    });
}

export function beginOrchestrationRuntimeNodeAttempt(trace, meta = {}) {
    if (!trace || typeof trace !== 'object') {
        return null;
    }
    const attempt = {
        attemptId: `attempt_${Number(trace.nextAttemptId || 1)}`,
        sequence: Number(trace.nextEventSeq || 1),
        stageIndex: Number(meta?.stageIndex || 0),
        stageId: String(meta?.stageId || ''),
        nodeIndex: Number(meta?.nodeIndex || 0),
        nodeId: String(meta?.nodeId || ''),
        preset: String(meta?.preset || ''),
        nodeType: normalizeNodeType(meta?.nodeType),
        slotKey: String(meta?.slotKey || buildOrchestrationRuntimeSlotKey(meta?.stageIndex, meta?.nodeIndex, meta?.nodeId)),
        runKind: String(meta?.runKind || 'worker'),
        round: Math.max(1, Math.floor(Number(meta?.round) || 1)),
        startedAt: new Date().toISOString(),
        endedAt: '',
        status: 'running',
        rerunReason: String(meta?.rerunReason || ''),
        output: null,
        outputText: '',
        previewText: '',
        action: '',
        targetNodeIds: [],
        reason: '',
        replayResult: null,
        error: '',
        // Full conversation captured at attempt finish. Shape:
        //   { messages: Array<{role, content, tool_calls?, tool_call_id?, name?, _round?}> }
        // Attached only when the runtime opts in via finishOrchestrationRuntimeNodeAttempt
        // details.conversation. Used by the trace popup's per-attempt
        // conversation panel.
        conversation: null,
    };
    trace.nextAttemptId = Number(trace.nextAttemptId || 1) + 1;
    trace.attempts.push(attempt);
    recordOrchestrationRuntimeEvent(trace, 'node_started', {
        attemptId: attempt.attemptId,
        stageIndex: attempt.stageIndex,
        stageId: attempt.stageId,
        nodeIndex: attempt.nodeIndex,
        nodeId: attempt.nodeId,
        preset: attempt.preset,
        nodeType: attempt.nodeType,
        runKind: attempt.runKind,
        round: attempt.round,
        rerunReason: attempt.rerunReason,
    });
    return attempt;
}

export function finishOrchestrationRuntimeNodeAttempt(trace, attempt, details = {}) {
    if (!trace || typeof trace !== 'object' || !attempt || typeof attempt !== 'object') {
        return;
    }
    attempt.endedAt = new Date().toISOString();
    attempt.status = String(details?.status || attempt.status || 'completed');
    attempt.action = String(details?.action || attempt.action || '');
    attempt.reason = String(details?.reason || attempt.reason || '');
    attempt.rerunReason = String(
        Object.prototype.hasOwnProperty.call(details || {}, 'rerunReason')
            ? details?.rerunReason
            : attempt.rerunReason,
    ) || '';
    attempt.targetNodeIds = Array.isArray(details?.targetNodeIds)
        ? details.targetNodeIds.map(item => String(item || '').trim()).filter(Boolean)
        : (Array.isArray(attempt.targetNodeIds) ? attempt.targetNodeIds : []);
    attempt.replayResult = Object.prototype.hasOwnProperty.call(details || {}, 'replayResult')
        ? cloneOrchestrationTraceValue(details?.replayResult)
        : attempt.replayResult;
    attempt.error = String(details?.error || '');
    if (Object.prototype.hasOwnProperty.call(details || {}, 'output')) {
        attempt.output = cloneOrchestrationTraceValue(details?.output);
        attempt.outputText = serializeOrchestrationRuntimeValue(details?.output);
        attempt.previewText = truncateOrchestrationRuntimePreview(attempt.outputText);
    }
    if (Object.prototype.hasOwnProperty.call(details || {}, 'conversation')) {
        attempt.conversation = sanitizeOrchestrationRuntimeConversation(details?.conversation);
    }
    const eventType = attempt.nodeType === ORCH_NODE_TYPE_REVIEW ? 'review_finished' : 'node_finished';
    recordOrchestrationRuntimeEvent(trace, eventType, {
        attemptId: attempt.attemptId,
        stageIndex: attempt.stageIndex,
        stageId: attempt.stageId,
        nodeIndex: attempt.nodeIndex,
        nodeId: attempt.nodeId,
        preset: attempt.preset,
        nodeType: attempt.nodeType,
        runKind: attempt.runKind,
        round: attempt.round,
        status: attempt.status,
        action: attempt.action,
        reason: attempt.reason,
        rerunReason: attempt.rerunReason,
        targetNodeIds: Array.isArray(attempt.targetNodeIds) ? attempt.targetNodeIds.slice() : [],
        previewText: attempt.previewText,
        error: attempt.error,
        replayResult: cloneOrchestrationTraceValue(attempt.replayResult),
    });
}

/**
 * Normalize a conversation payload before it lands on the trace. The
 * runtime hands us a plain `{ messages: [...] }` envelope; we clone and
 * coerce each entry to the renderer-friendly shape:
 *   { role, content, tool_calls?, tool_call_id?, name?, _round? }
 *
 * Anything else is dropped so a malformed runtime cannot corrupt the
 * popup. Returns null for a missing / empty conversation so the renderer
 * can short-circuit on truthiness.
 */
export function sanitizeOrchestrationRuntimeConversation(conversation) {
    if (!conversation || typeof conversation !== 'object') {
        return null;
    }
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const out = [];
    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const role = String(message.role || '').trim().toLowerCase();
        if (!role) continue;
        const entry = { role };
        if (typeof message.content === 'string') {
            entry.content = message.content;
        } else if (message.content !== undefined && message.content !== null) {
            entry.content = serializeOrchestrationRuntimeValue(message.content);
        } else {
            entry.content = '';
        }
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            entry.tool_calls = message.tool_calls
                .map(call => sanitizeOrchestrationRuntimeToolCall(call))
                .filter(Boolean);
        }
        if (typeof message.tool_call_id === 'string' && message.tool_call_id) {
            entry.tool_call_id = message.tool_call_id;
        }
        if (typeof message.name === 'string' && message.name) {
            entry.name = message.name;
        }
        if (Number.isFinite(Number(message._round))) {
            entry._round = Number(message._round);
        }
        out.push(entry);
    }
    if (out.length === 0) return null;
    return { messages: out };
}

function sanitizeOrchestrationRuntimeToolCall(call) {
    if (!call || typeof call !== 'object') return null;
    const id = String(call.id || '').trim();
    const name = String(call.name || call?.function?.name || '').trim();
    if (!name) return null;
    let args;
    if (call.args && typeof call.args === 'object') {
        args = structuredClone(call.args);
    } else if (typeof call?.function?.arguments === 'string') {
        try {
            const parsed = JSON.parse(call.function.arguments);
            args = parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            args = {};
        }
    } else {
        args = {};
    }
    return { id, name, args };
}

/**
 * Attach a conversation payload to the loop slot on a trace. Loop mode
 * does not produce node attempts (single agent, no stages/nodes), so the
 * full message history lives directly under `trace.loop.conversation`.
 *
 * Idempotent — calling repeatedly overwrites the previous payload, which
 * is what we want for live updates as the loop progresses.
 */
export function attachOrchestrationRuntimeLoopConversation(trace, conversation) {
    if (!trace || typeof trace !== 'object') return;
    const sanitized = sanitizeOrchestrationRuntimeConversation(conversation);
    if (!sanitized) {
        if (trace.loop && typeof trace.loop === 'object') {
            delete trace.loop.conversation;
        }
        return;
    }
    if (!trace.loop || typeof trace.loop !== 'object') {
        trace.loop = {};
    }
    trace.loop.conversation = sanitized;
}
