/**
 * HTML renderers for the orchestrator runtime trace.
 *
 * Pure rendering only — every function takes either a `trace` object,
 * an `entry` object, or the `context` (so it can fetch the active
 * trace via `getLatestOrchestrationRuntimeTrace`). No state lives
 * here; the model is in `runtime-trace.js`.
 *
 * Public exports:
 *   - `renderLastOrchestrationResultHtml(entry)` — renders the small
 *     "Latest Orchestration Result" panel. Caller fetches the entry
 *     via `getLatestOrchestrationEntry` (still in main.js) so this
 *     module stays decoupled from the chat-state cache.
 *   - `renderOrchestrationRuntimeTraceHtml(context)` — full trace
 *     popup body: meta grid, flow graph, timeline, events, attempts,
 *     plus optional capsule preview and raw JSON `<details>`.
 *
 * The popup launcher itself (`openOrchestrationRuntimeTrace`) stays in
 * main.js because it wires up jQuery handlers for the diff-zoom
 * overlay (`openOrchExpandedDiff` / `closeOrchExpandedDiff` /
 * `beginOrchLineDiffResize`) which haven't been split out yet.
 *
 * `escapeHtml` is duplicated as a private helper to keep this module
 * portable. Same caveat as `line-diff.js`: collapses into a shared
 * `html-utils.js` if/when more modules need it.
 */

import { normalizeAnchorPlayableFloor } from './anchors.js';
import { i18n, i18nFormat } from './i18n.js';
import { renderIterationLineDiffHtml } from './line-diff.js';
import { toReadableYamlText } from './output-formatting.js';
import {
    getLatestOrchestrationRuntimeTrace,
    sanitizeOrchestrationRuntimeConversation,
    truncateOrchestrationRuntimePreview,
} from './runtime-trace.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function formatReadableTimestamp(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return i18n('Not set');
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        return raw;
    }
    try {
        return parsed.toLocaleString();
    } catch {
        return raw;
    }
}

/**
 * Translate a tool-call args / tool-result blob into a human-readable
 * pre-formatted block. JSON-shaped objects use the readable YAML helper
 * so deeply nested args (which is most of them) render legibly; strings
 * pass through unchanged.
 */
function renderTraceJsonBlock(value) {
    if (value === null || value === undefined) {
        return `<pre class="luker-studio-attempt-pre">${escapeHtml('(empty)')}</pre>`;
    }
    if (typeof value === 'string') {
        // tool result content is serialized JSON — pretty-print if it
        // parses, otherwise show as-is.
        const trimmed = value.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                return `<pre class="luker-studio-attempt-pre">${escapeHtml(toReadableYamlText(parsed, '{}'))}</pre>`;
            } catch {
                // Fall through.
            }
        }
        return `<pre class="luker-studio-attempt-pre">${escapeHtml(value)}</pre>`;
    }
    return `<pre class="luker-studio-attempt-pre">${escapeHtml(toReadableYamlText(value, '{}'))}</pre>`;
}

/**
 * Walk a sanitized messages array once to pair tool results with their
 * originating assistant `tool_calls[]` entry. Tool results live in the
 * conversation as separate `role:'tool'` messages keyed by
 * `tool_call_id`; the renderers want them inlined under the originating
 * call so users see args + result side-by-side instead of as detached
 * sibling blocks.
 *
 * Returns:
 *   - `resultMap`: Map<tool_call_id, { content, parsed, isError }>
 *   - `consumedIndices`: Set<number> of message indices whose tool result
 *     has been absorbed into a tool_call — callers skip these when
 *     rendering siblings so the result isn't shown twice. Unpaired
 *     orphan tool results (no matching assistant tool_call in this
 *     conversation) are left unconsumed and still render standalone.
 *
 * Error detection: structured tool errors are serialized as
 * `{ok:false, error, code, ...}` by `makeErrorToolMessage`; we parse
 * the content JSON once here so the renderer can show an "Error" badge
 * on the call's summary line and auto-expand the failing call.
 */
function buildToolResultMap(messages) {
    const resultMap = new Map();
    const consumedIndices = new Set();
    if (!Array.isArray(messages) || messages.length === 0) {
        return { resultMap, consumedIndices };
    }
    const knownToolCallIds = new Set();
    for (const m of messages) {
        const tcs = Array.isArray(m?.tool_calls) ? m.tool_calls : [];
        for (const c of tcs) {
            const id = String(c?.id || '').trim();
            if (id) knownToolCallIds.add(id);
        }
    }
    for (let i = 0; i < messages.length; i += 1) {
        const m = messages[i];
        if (String(m?.role || '').trim().toLowerCase() !== 'tool') continue;
        const id = String(m?.tool_call_id || '').trim();
        if (!id || !knownToolCallIds.has(id)) continue;
        if (resultMap.has(id)) continue; // first match wins; ignore duplicates
        const rawContent = m?.content;
        let parsed = null;
        let isError = false;
        if (typeof rawContent === 'string') {
            const trimmed = rawContent.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                try {
                    parsed = JSON.parse(trimmed);
                } catch {
                    parsed = null;
                }
            }
        } else if (rawContent && typeof rawContent === 'object') {
            parsed = rawContent;
        }
        if (parsed && typeof parsed === 'object' && parsed.ok === false) {
            isError = true;
        }
        resultMap.set(id, { content: rawContent, parsed, isError });
        consumedIndices.add(i);
    }
    return { resultMap, consumedIndices };
}

function formatTraceRoleLabel(role) {
    switch (String(role || '').trim().toLowerCase()) {
        case 'system': return i18n('System');
        case 'user': return i18n('User');
        case 'assistant': return i18n('Assistant');
        case 'tool': return i18n('Tool Result');
        default: return String(role || 'message');
    }
}

function renderTraceMessageHtml(message, resultMap) {
    const role = String(message?.role || '').trim().toLowerCase();
    const roleLabel = formatTraceRoleLabel(role);
    const roundBadge = Number.isFinite(Number(message?._round))
        ? `<span class="luker-studio-convo-round">${escapeHtml(i18nFormat('round ${0}', Number(message._round)))}</span>`
        : '';

    const headerParts = [
        `<span class="luker-studio-convo-role luker-studio-convo-role-${escapeHtml(role || 'message')}">${escapeHtml(roleLabel)}</span>`,
        message?.name ? `<span class="luker-studio-convo-name">${escapeHtml(String(message.name))}</span>` : '',
        roundBadge,
    ].filter(Boolean).join(' ');

    if (role === 'tool') {
        // Tool result message — show name + content, collapsed by default.
        // Reached only when this result couldn't be paired to a tool_call
        // in the same conversation (orphan); paired results are absorbed
        // into the originating tool_call's <details> by the loop below.
        return `
<details class="luker-studio-convo-msg luker-studio-convo-msg-tool">
    <summary>${headerParts}</summary>
    ${renderTraceJsonBlock(message?.content || '')}
</details>`;
    }

    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const hasToolCalls = toolCalls.length > 0;
    const contentText = String(message?.content || '').trim();

    if (!hasToolCalls && !contentText) {
        return `
<div class="luker-studio-convo-msg luker-studio-convo-msg-${escapeHtml(role || 'message')}">
    <div class="luker-studio-convo-head">${headerParts}</div>
    <div class="luker-studio-convo-empty">${escapeHtml(i18n('(empty)'))}</div>
</div>`;
    }

    const toolCallsHtml = hasToolCalls
        ? `<div class="luker-studio-convo-toolcalls">${toolCalls.map((call) => {
            const callName = String(call?.name || '');
            const callId = String(call?.id || '').trim();
            const pairedResult = (callId && resultMap) ? resultMap.get(callId) : null;
            const errorBadge = pairedResult?.isError
                ? ` <span class="luker-studio-badge luker-studio-badge-failed">${escapeHtml(i18n('Error'))}</span>`
                : '';
            const resultLabel = pairedResult
                ? (pairedResult.isError ? i18n('Error') : i18n('Result'))
                : '';
            const resultBody = pairedResult
                ? renderTraceJsonBlock(pairedResult.parsed ?? pairedResult.content ?? '')
                : '';
            return `
<details class="luker-studio-convo-toolcall"${pairedResult?.isError ? ' open' : ''}>
    <summary><span class="luker-studio-convo-toolname">${escapeHtml(callName || 'tool_call')}</span>${callId ? `<span class="luker-studio-convo-callid">#${escapeHtml(callId)}</span>` : ''}${errorBadge}</summary>
    <div class="luker-studio-attempt-label">${escapeHtml(i18n('Arguments'))}</div>
    ${renderTraceJsonBlock(call?.args ?? {})}
    ${pairedResult ? `<div class="luker-studio-attempt-label">${escapeHtml(resultLabel)}</div>${resultBody}` : ''}
</details>`;
        }).join('')}</div>`
        : '';

    return `
<div class="luker-studio-convo-msg luker-studio-convo-msg-${escapeHtml(role || 'message')}">
    <div class="luker-studio-convo-head">${headerParts}</div>
    ${contentText ? `<pre class="luker-studio-attempt-pre">${escapeHtml(contentText)}</pre>` : ''}
    ${toolCallsHtml}
</div>`;
}

/**
 * Render a `{ messages: [...] }` conversation envelope as a scrollable
 * sequence of role-styled message blocks. Tool-calls and tool results
 * each get their own collapsible block so the conversation stays
 * readable even when the agent did dozens of rounds.
 *
 * Returns an empty string for null / empty conversations so callers can
 * conditionally wrap the result.
 */
function renderTraceConversationHtml(conversation) {
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    if (messages.length === 0) return '';
    const { resultMap, consumedIndices } = buildToolResultMap(messages);
    const parts = [];
    for (let i = 0; i < messages.length; i += 1) {
        if (consumedIndices.has(i)) continue;
        parts.push(renderTraceMessageHtml(messages[i], resultMap));
    }
    return `<div class="luker-studio-convo">${parts.join('')}</div>`;
}

export function renderLastOrchestrationResultHtml(entry) {
    if (!entry || typeof entry !== 'object') {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No recent orchestration result available for this chat.'))}</div>`;
    }

    const anchorPlayableFloor = normalizeAnchorPlayableFloor(entry.anchorPlayableFloor);
    const injectedText = String(entry.injectedText || '').trim();

    return `
<div class="luker-studio luker_orch_last_run_popup">
    <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Anchored User Turn'))}</b><span>${escapeHtml(String(anchorPlayableFloor || 0))}</span></div>
    <pre class="luker-studio-attempt-pre">${escapeHtml(injectedText || i18n('Not set'))}</pre>
</div>`;
}

function formatOrchestrationRuntimeStatusLabel(status) {
    switch (String(status || '').trim().toLowerCase()) {
        case 'running':
            return i18n('Running');
        case 'completed':
            return i18n('Completed');
        case 'cancelled':
            return i18n('Cancelled');
        case 'failed':
            return i18n('Failed');
        case 'reused':
            return i18n('Reused');
        default:
            return i18n('Idle');
    }
}

function buildOrchestrationRuntimeTraceNodeIndex(trace) {
    const index = new Map();
    for (const attempt of Array.isArray(trace?.attempts) ? trace.attempts : []) {
        const slotKey = String(attempt?.slotKey || '');
        if (!slotKey) {
            continue;
        }
        if (!index.has(slotKey)) {
            index.set(slotKey, []);
        }
        index.get(slotKey).push(attempt);
    }
    return index;
}

function renderOrchestrationRuntimeTraceGraphHtml(trace) {
    const attemptIndex = buildOrchestrationRuntimeTraceNodeIndex(trace);
    const stages = Array.isArray(trace?.stages) ? trace.stages : [];
    if (stages.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No node attempts recorded.'))}</div>`;
    }

    return stages.map((stage, stageIndex) => {
        const stageNodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const nodeHtml = stageNodes.map((node) => {
            const attempts = attemptIndex.get(String(node?.slotKey || '')) || [];
            const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
            const status = formatOrchestrationRuntimeStatusLabel(latestAttempt?.status || '');
            const statusKey = String(latestAttempt?.status || 'idle').trim().toLowerCase() || 'idle';
            const previewText = truncateOrchestrationRuntimePreview(String(latestAttempt?.previewText || ''), 120);
            return `
<div class="luker-studio-flow-node">
    <div class="luker-studio-flow-node-head">
        <div class="luker-studio-flow-node-title">${escapeHtml(String(node?.id || ''))}</div>
        <span class="luker-studio-badge luker-studio-badge-${escapeHtml(statusKey)}">${escapeHtml(status)}</span>
    </div>
    <div class="luker-studio-flow-node-meta">${escapeHtml(String(node?.type || 'worker'))} · ${escapeHtml(String(node?.preset || node?.id || ''))}</div>
    <div class="luker-studio-flow-node-meta">${escapeHtml(i18n('Node Attempts'))}: ${escapeHtml(String(attempts.length || 0))}</div>
    ${previewText ? `<div class="luker-studio-flow-node-preview">${escapeHtml(previewText)}</div>` : ''}
</div>`;
        }).join('');
        return `
<div class="luker-studio-flow-stage">
    <div class="luker-studio-flow-stage-head">
        <div class="luker-studio-flow-stage-title">${escapeHtml(String(stage?.id || `stage_${stageIndex + 1}`))}</div>
        <div class="luker-studio-flow-stage-mode">${escapeHtml(String(stage?.mode || 'serial'))}</div>
    </div>
    <div class="luker-studio-flow-stage-nodes">${nodeHtml || `<div class="luker-studio-empty-hint">${escapeHtml(i18n('Not set'))}</div>`}</div>
</div>
${stageIndex < stages.length - 1 ? '<div class="luker-studio-flow-arrow">→</div>' : ''}`;
    }).join('');
}

function formatOrchestrationRuntimeEventSummary(event) {
    const type = String(event?.type || '');
    const stageId = String(event?.stageId || '');
    const nodeId = String(event?.nodeId || '');
    switch (type) {
        case 'run_started':
            return `Run started · ${String(event?.generationType || 'normal') || 'normal'}`;
        case 'run_finished':
            return `Run ${String(event?.status || 'completed')} · reruns=${Number(event?.reviewRerunCount || 0)}`;
        case 'replay_started':
            return `Replay started · ${String(event?.restartStageId || 'stage')} · ${Array.isArray(event?.targetNodeIds) ? event.targetNodeIds.join(', ') : ''}`.trim();
        case 'replay_finished':
            return `Replay finished · ${String(event?.restart_stage_id || 'stage')} · rerun ${Number(event?.rerun_round || 0)}`;
        case 'stage_started':
            return `${event?.replay ? 'Replay ' : ''}stage started · ${stageId || 'stage'}`;
        case 'stage_finished':
            return `${event?.replay ? 'Replay ' : ''}stage ${String(event?.status || 'completed')} · ${stageId || 'stage'}`;
        case 'node_started':
            return `${String(event?.nodeType || 'worker')} started · ${nodeId}`;
        case 'node_finished':
            return `worker ${String(event?.status || 'completed')} · ${nodeId}`;
        case 'review_finished':
            return `review ${String(event?.status || 'completed')} · ${nodeId}${event?.action ? ` · ${event.action}` : ''}`;
        default:
            return `${type || 'event'} · ${nodeId || stageId || ''}`.trim();
    }
}

function renderOrchestrationRuntimeTraceEventsHtml(trace) {
    const events = Array.isArray(trace?.events) ? trace.events : [];
    if (events.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No events recorded.'))}</div>`;
    }
    return `<div class="luker-studio-timeline">${events.map((event) => `
<div class="luker-studio-timeline-event">
    <div class="luker-studio-timeline-seq">#${escapeHtml(String(event?.seq || ''))}</div>
    <div class="luker-studio-timeline-body">
        <div class="luker-studio-timeline-text">${escapeHtml(formatOrchestrationRuntimeEventSummary(event))}</div>
        <div class="luker-studio-timeline-time">${escapeHtml(formatReadableTimestamp(event?.at))}</div>
    </div>
</div>`).join('')}</div>`;
}

function renderOrchestrationRuntimeAttemptHtml(attempt, previousOutputText = '', attemptNo = 1) {
    const statusKey = String(attempt?.status || 'idle').trim().toLowerCase() || 'idle';
    const statusLabel = formatOrchestrationRuntimeStatusLabel(attempt?.status || '');
    const outputText = String(attempt?.outputText || '');
    const hasOutputDiff = Boolean(previousOutputText && outputText && previousOutputText !== outputText);
    const metaItems = [
        `${String(attempt?.stageId || '')} · ${String(attempt?.nodeType || 'worker')}`,
        String(attempt?.preset || ''),
        i18nFormat('Attempt ${0}', attemptNo),
    ].filter(Boolean);
    if (attempt?.runKind === 'review') {
        metaItems.push(`round ${Math.max(1, Number(attempt?.round || 1))}`);
    }

    return `
<details class="luker-studio-attempt"${attemptNo > 1 || statusKey === 'running' || statusKey === 'failed' ? ' open' : ''}>
    <summary>
        <span class="luker-studio-attempt-title">${escapeHtml(String(attempt?.nodeId || ''))}</span>
        <span class="luker-studio-attempt-badges">
            <span class="luker-studio-badge luker-studio-badge-${escapeHtml(statusKey)}">${escapeHtml(statusLabel)}</span>
            <span class="luker-studio-attempt-meta">#${escapeHtml(String(attempt?.sequence || ''))}</span>
        </span>
    </summary>
    <div class="luker-studio-attempt-meta">${metaItems.map(item => escapeHtml(item)).join(' · ')}</div>
    <div class="luker-studio-attempt-meta">${escapeHtml(i18n('Created At'))}: ${escapeHtml(formatReadableTimestamp(attempt?.startedAt))}</div>
    <div class="luker-studio-attempt-meta">${escapeHtml(i18n('Finished At'))}: ${escapeHtml(formatReadableTimestamp(attempt?.endedAt || ''))}</div>
    ${attempt?.rerunReason ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Review feedback'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(String(attempt.rerunReason || ''))}</pre>` : ''}
    ${attempt?.action ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Decision'))}</div><div class="luker-studio-attempt-meta">${escapeHtml(String(attempt.action || ''))}</div>` : ''}
    ${Array.isArray(attempt?.targetNodeIds) && attempt.targetNodeIds.length > 0 ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Targets'))}</div><div class="luker-studio-attempt-meta">${escapeHtml(attempt.targetNodeIds.join(', '))}</div>` : ''}
    ${attempt?.reason ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Review feedback'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(String(attempt.reason || ''))}</pre>` : ''}
    ${attempt?.replayResult ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Replay result'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(toReadableYamlText(attempt.replayResult, '{}'))}</pre>` : ''}
    ${attempt?.error ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Failed'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(String(attempt.error || ''))}</pre>` : ''}
    ${hasOutputDiff ? `
        <div class="luker-studio-attempt-label">${escapeHtml(i18n('Rerun diff'))}</div>
        ${renderIterationLineDiffHtml(previousOutputText, outputText, `${attempt?.nodeId || 'node'} rerun diff`)}
        <div class="luker-studio-attempt-dual">
            <div class="luker-studio-attempt-dual-col">
                <div class="luker-studio-attempt-label">${escapeHtml(i18n('Previous result'))}</div>
                <pre class="luker-studio-attempt-pre">${escapeHtml(previousOutputText)}</pre>
            </div>
            <div class="luker-studio-attempt-dual-col">
                <div class="luker-studio-attempt-label">${escapeHtml(i18n('Current result'))}</div>
                <pre class="luker-studio-attempt-pre">${escapeHtml(outputText)}</pre>
            </div>
        </div>` : ''}
    ${outputText ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Output'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(outputText)}</pre>` : ''}
    ${Array.isArray(attempt?.conversation?.messages) && attempt.conversation.messages.length > 0
        ? `<details class="luker-studio-attempt-convo">
            <summary>${escapeHtml(i18n('Conversation'))} <span class="luker-studio-convo-count">(${escapeHtml(String(attempt.conversation.messages.length))})</span></summary>
            ${renderTraceConversationHtml(attempt.conversation)}
        </details>`
        : ''}
</details>`;
}

function renderOrchestrationRuntimeTraceAttemptsHtml(trace) {
    const attempts = Array.isArray(trace?.attempts) ? trace.attempts : [];
    if (attempts.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No node attempts recorded.'))}</div>`;
    }
    const attemptCountBySlot = new Map();
    const lastOutputBySlot = new Map();
    return `<div class="luker-studio-attempts">${attempts.map((attempt) => {
        const slotKey = String(attempt?.slotKey || '');
        const nextCount = Number(attemptCountBySlot.get(slotKey) || 0) + 1;
        attemptCountBySlot.set(slotKey, nextCount);
        const previousOutputText = lastOutputBySlot.get(slotKey) || '';
        if (String(attempt?.outputText || '')) {
            lastOutputBySlot.set(slotKey, String(attempt.outputText || ''));
        }
        return renderOrchestrationRuntimeAttemptHtml(attempt, previousOutputText, nextCount);
    }).join('')}</div>`;
}

function formatAgendaTodoStatusLabel(status) {
    switch (String(status || '').trim().toLowerCase()) {
        case 'todo': return i18n('todo');
        case 'doing': return i18n('doing');
        case 'done': return i18n('done');
        case 'blocked': return i18n('blocked');
        case 'dropped': return i18n('dropped');
        default: return i18n('todo');
    }
}

const AGENDA_TODO_BOARD_COLUMNS = ['todo', 'doing', 'done', 'blocked', 'dropped'];

function renderAgendaTodoBoardHtml(agenda) {
    const todos = Array.isArray(agenda?.todos) ? agenda.todos : [];
    if (todos.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('Todo board is empty.'))}</div>`;
    }
    const byStatus = new Map();
    for (const col of AGENDA_TODO_BOARD_COLUMNS) byStatus.set(col, []);
    for (const todo of todos) {
        const status = String(todo?.status || 'todo').trim().toLowerCase();
        const bucket = byStatus.has(status) ? status : 'todo';
        byStatus.get(bucket).push(todo);
    }
    return `<div class="luker-studio-kanban">${AGENDA_TODO_BOARD_COLUMNS.map((col) => {
        const items = byStatus.get(col) || [];
        return `
<div class="luker-studio-kanban-col luker-studio-kanban-col-${escapeHtml(col)}">
    <div class="luker-studio-kanban-head">
        <span class="luker-studio-kanban-title">${escapeHtml(formatAgendaTodoStatusLabel(col))}</span>
        <span class="luker-studio-kanban-count">${escapeHtml(String(items.length))}</span>
    </div>
    <div class="luker-studio-kanban-cards">${items.map(item => `
        <div class="luker-studio-kanban-card">
            <div class="luker-studio-kanban-card-id">${escapeHtml(String(item?.id || ''))}</div>
            <div class="luker-studio-kanban-card-goal">${escapeHtml(String(item?.goal || ''))}</div>
        </div>`).join('') || `<div class="luker-studio-empty-hint">${escapeHtml(i18n('(none)'))}</div>`}</div>
</div>`;
    }).join('')}</div>`;
}

/**
 * Group attempts into agenda-mode "rounds". Each planner attempt anchors
 * a round; the matching `agenda_agents_round_N` worker attempts hang off
 * the same round number. The single `agenda_finalize` attempt is its own
 * trailing round so the visual mirrors the runtime semantics.
 */
function groupAgendaAttemptsByRound(trace) {
    const attempts = Array.isArray(trace?.attempts) ? trace.attempts : [];
    const rounds = new Map();
    let finalAttempt = null;
    for (const attempt of attempts) {
        const stageId = String(attempt?.stageId || '');
        if (stageId === 'agenda_finalize') {
            finalAttempt = attempt;
            continue;
        }
        const plannerMatch = /^agenda_planner_round_(\d+)$/.exec(stageId);
        const agentMatch = /^agenda_agents_round_(\d+)$/.exec(stageId);
        const roundNum = plannerMatch
            ? Number(plannerMatch[1])
            : (agentMatch ? Number(agentMatch[1]) : Number(attempt?.stageIndex || 0) + 1);
        if (!rounds.has(roundNum)) rounds.set(roundNum, { planner: null, agents: [] });
        if (plannerMatch || attempt?.runKind === 'planner') {
            rounds.get(roundNum).planner = attempt;
        } else {
            rounds.get(roundNum).agents.push(attempt);
        }
    }
    return {
        rounds: [...rounds.entries()].sort((a, b) => a[0] - b[0]),
        finalAttempt,
    };
}

function renderAgendaAttemptCardHtml(attempt, kind) {
    if (!attempt) return '';
    const statusKey = String(attempt?.status || 'idle').trim().toLowerCase() || 'idle';
    const statusLabel = formatOrchestrationRuntimeStatusLabel(attempt?.status || '');
    const outputText = String(attempt?.outputText || '');
    const previewText = truncateOrchestrationRuntimePreview(outputText, 240);
    const hasConversation = Array.isArray(attempt?.conversation?.messages) && attempt.conversation.messages.length > 0;
    return `
<details class="luker-studio-agenda-attempt luker-studio-agenda-attempt-${escapeHtml(kind)}"${statusKey === 'failed' || statusKey === 'running' ? ' open' : ''}>
    <summary>
        <span class="luker-studio-agenda-attempt-title">${escapeHtml(String(attempt?.nodeId || kind))}</span>
        <span class="luker-studio-badge luker-studio-badge-${escapeHtml(statusKey)}">${escapeHtml(statusLabel)}</span>
    </summary>
    ${attempt?.error ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Failed'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(String(attempt.error || ''))}</pre>` : ''}
    ${previewText ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Output'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(outputText)}</pre>` : ''}
    ${hasConversation ? `<details class="luker-studio-attempt-convo">
        <summary>${escapeHtml(i18n('Conversation'))} <span class="luker-studio-convo-count">(${escapeHtml(String(attempt.conversation.messages.length))})</span></summary>
        ${renderTraceConversationHtml(attempt.conversation)}
    </details>` : ''}
</details>`;
}

function renderAgendaRoundsHtml(trace) {
    const { rounds, finalAttempt } = groupAgendaAttemptsByRound(trace);
    if (rounds.length === 0 && !finalAttempt) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No planner rounds recorded.'))}</div>`;
    }
    const roundsHtml = rounds.map(([roundNum, bundle]) => {
        const plannerCard = bundle.planner
            ? renderAgendaAttemptCardHtml(bundle.planner, 'planner')
            : `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No planner step recorded.'))}</div>`;
        const agentsHtml = bundle.agents.length === 0
            ? `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No agents dispatched this round.'))}</div>`
            : bundle.agents.map(a => renderAgendaAttemptCardHtml(a, 'agent')).join('');
        return `
<div class="luker-studio-agenda-round">
    <div class="luker-studio-agenda-round-head">
        <span class="luker-studio-agenda-round-title">${escapeHtml(i18nFormat('Round ${0}', roundNum))}</span>
    </div>
    <div class="luker-studio-agenda-round-body">
        <div class="luker-studio-agenda-round-planner">
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Planner Step'))}</div>
            ${plannerCard}
        </div>
        <div class="luker-studio-agenda-round-agents">
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Dispatched Agents'))}</div>
            ${agentsHtml}
        </div>
    </div>
</div>`;
    }).join('');
    const finalHtml = finalAttempt
        ? `<div class="luker-studio-agenda-final">
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Final Agent'))}</div>
            ${renderAgendaAttemptCardHtml(finalAttempt, 'final')}
        </div>`
        : '';
    return `<div class="luker-studio-agenda-rounds">${roundsHtml}${finalHtml}</div>`;
}

function renderAgendaModePanelsHtml(trace) {
    const agenda = trace?.agenda && typeof trace.agenda === 'object' ? trace.agenda : null;
    return `
<div class="luker-studio-panel">
    <div class="luker-studio-panel-title">${escapeHtml(i18n('Todo Board'))}</div>
    ${renderAgendaTodoBoardHtml(agenda)}
</div>
<div class="luker-studio-panel">
    <div class="luker-studio-panel-title">${escapeHtml(i18n('Planner Rounds'))}</div>
    ${renderAgendaRoundsHtml(trace)}
</div>`;
}

function renderLoopModePanelHtml(trace) {
    // `trace.loop.conversation` is a live alias of the loop runtime's running
    // messages array (see attachOrchestrationRuntimeLoopConversation). Sanitize
    // here at render time so assistant tool_calls in raw OpenAI shape
    // (`function.name` / `function.arguments`) get flattened into the
    // `{ name, args }` shape the renderer expects.
    const conversation = sanitizeOrchestrationRuntimeConversation(trace?.loop?.conversation);
    return `
<div class="luker-studio-panel">
    <div class="luker-studio-panel-title">${escapeHtml(i18n('Agent Conversation'))}</div>
    ${Array.isArray(conversation?.messages) && conversation.messages.length > 0
        ? renderTraceConversationHtml(conversation)
        : `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No agent messages recorded yet.'))}</div>`}
</div>`;
}

/**
 * Director-mode trace panels. Mirrors agenda's two-section layout:
 *   - left: Main Agent — per-round records + the running conversation
 *   - right: Sub-agent Dispatches — each dispatch as an expandable card
 *     (handleId, role, status badge, task brief, output preview, full
 *     mini-loop conversation in a collapsed details element).
 *
 * Both panels read from `trace.director` (attached by
 * `attachOrchestrationRuntimeDirectorState`). The conversation alias is
 * live — mutations during the run show up here on popup open.
 */
function renderDirectorSubagentCardHtml(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const statusKey = String(entry?.status || 'idle').trim().toLowerCase() || 'idle';
    const statusLabel = formatOrchestrationRuntimeStatusLabel(entry?.status || '');
    const handleId = String(entry?.handleId || '');
    const subagentId = String(entry?.subagentId || '');
    const isInline = Boolean(entry?.isInline);
    const task = String(entry?.task || '');
    const outputText = String(entry?.outputText || '');
    const reasoningText = String(entry?.reasoningText || '');
    const previewText = truncateOrchestrationRuntimePreview(outputText, 240);
    const conversation = entry?.conversation && typeof entry.conversation === 'object'
        ? sanitizeOrchestrationRuntimeConversation(entry.conversation)
        : null;
    const hasConversation = Array.isArray(conversation?.messages) && conversation.messages.length > 0;
    const inlineBadge = isInline
        ? ` <span class="luker-studio-badge">${escapeHtml(i18n('inline'))}</span>`
        : '';
    const systemPromptPreview = isInline ? String(entry?.systemPromptPreview || '') : '';
    return `
<details class="luker-studio-agenda-attempt luker-studio-agenda-attempt-agent"${statusKey === 'failed' || statusKey === 'running' || statusKey === 'cancelled' ? ' open' : ''}>
    <summary>
        <span class="luker-studio-agenda-attempt-title">${escapeHtml(handleId)}${escapeHtml(subagentId ? `: ${subagentId}` : '')}</span>
        <span class="luker-studio-badge luker-studio-badge-${escapeHtml(statusKey)}">${escapeHtml(statusLabel)}</span>${inlineBadge}
    </summary>
    ${task ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Task brief'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(task)}</pre>` : ''}
    ${systemPromptPreview ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Inline system prompt (preview)'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(systemPromptPreview)}</pre>` : ''}
    ${entry?.error ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Failed'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(String(entry.error || ''))}</pre>` : ''}
    ${reasoningText ? `<details class="luker-studio-reasoning-details">
        <summary>${escapeHtml(i18n('Model reasoning'))}</summary>
        <pre class="luker-studio-attempt-pre luker-studio-reasoning-pre">${escapeHtml(reasoningText)}</pre>
    </details>` : ''}
    ${previewText ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Output'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(outputText)}</pre>` : ''}
    ${hasConversation ? `<details class="luker-studio-attempt-convo">
        <summary>${escapeHtml(i18n('Conversation'))} <span class="luker-studio-convo-count">(${escapeHtml(String(conversation.messages.length))})</span></summary>
        ${renderTraceConversationHtml(conversation)}
    </details>` : ''}
</details>`;
}

function renderDirectorMainAgentRoundsHtml(trace) {
    const rounds = Array.isArray(trace?.director?.mainAgent?.rounds) ? trace.director.mainAgent.rounds : [];
    if (rounds.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No main-agent rounds recorded.'))}</div>`;
    }
    // The structured `rounds[].toolCalls[]` records only carry `{id, name,
    // args}` — the matching tool results live in
    // `director.mainAgent.conversation` as separate `role:'tool'`
    // messages keyed by `tool_call_id`. Build the lookup once so each
    // per-round <li> can show its result alongside the args.
    const conversation = sanitizeOrchestrationRuntimeConversation(trace?.director?.mainAgent?.conversation);
    const { resultMap } = buildToolResultMap(Array.isArray(conversation?.messages) ? conversation.messages : []);
    return rounds.map((r) => {
        const round = Number(r?.round ?? 0);
        const text = String(r?.assistantText || '');
        const reasoning = String(r?.reasoningText || '');
        const calls = Array.isArray(r?.toolCalls) ? r.toolCalls : [];
        const status = String(r?.status || '').trim();
        const statusBadge = status
            ? `<span class="luker-studio-badge luker-studio-badge-failed">${escapeHtml(status)}</span>`
            : '';
        const callsBadge = `<span class="luker-studio-badge">${escapeHtml(i18nFormat('${0} tool call(s)', calls.length))}</span>`;
        const callsSummary = calls.length === 0
            ? `<div class="luker-studio-empty-hint">${escapeHtml(i18n('(no tool calls — reasoning-only round)'))}</div>`
            : `<ul class="luker-studio-attempt-tool-list">${
                calls.map(c => {
                    const callId = String(c?.id || '').trim();
                    const pairedResult = callId ? resultMap.get(callId) : null;
                    const errorBadge = pairedResult?.isError
                        ? ` <span class="luker-studio-badge luker-studio-badge-failed">${escapeHtml(i18n('Error'))}</span>`
                        : '';
                    const argsBlock = c?.args
                        ? `<pre class="luker-studio-attempt-pre">${escapeHtml(toReadableYamlText(c.args, '{}'))}</pre>`
                        : '';
                    const resultBlock = pairedResult
                        ? `<div class="luker-studio-attempt-label">${escapeHtml(pairedResult.isError ? i18n('Error') : i18n('Result'))}</div>${renderTraceJsonBlock(pairedResult.parsed ?? pairedResult.content ?? '')}`
                        : '';
                    return `<li><b>${escapeHtml(String(c?.name || ''))}</b>${errorBadge}${argsBlock}${resultBlock}</li>`;
                }).join('')
            }</ul>`;
        return `
<details class="luker-studio-agenda-attempt luker-studio-agenda-attempt-planner" open>
    <summary>
        <span class="luker-studio-agenda-attempt-title">${escapeHtml(i18nFormat('Round ${0}', round))}</span>
        ${statusBadge}
        ${callsBadge}
    </summary>
    ${reasoning ? `<details class="luker-studio-reasoning-details">
        <summary>${escapeHtml(i18n('Model reasoning'))}</summary>
        <pre class="luker-studio-attempt-pre luker-studio-reasoning-pre">${escapeHtml(reasoning)}</pre>
    </details>` : ''}
    ${text ? `<div class="luker-studio-attempt-label">${escapeHtml(i18n('Assistant text'))}</div><pre class="luker-studio-attempt-pre">${escapeHtml(text)}</pre>` : ''}
    <div class="luker-studio-attempt-label">${escapeHtml(i18n('Tool calls'))}</div>
    ${callsSummary}
</details>`;
    }).join('');
}

function renderDirectorModePanelsHtml(trace) {
    const director = trace?.director && typeof trace.director === 'object' ? trace.director : null;
    const mainConversation = director?.mainAgent?.conversation
        ? sanitizeOrchestrationRuntimeConversation(director.mainAgent.conversation)
        : null;
    const subagents = Array.isArray(director?.subagents) ? director.subagents : [];

    const subagentsHtml = subagents.length === 0
        ? `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No sub-agents dispatched.'))}</div>`
        : subagents.map(renderDirectorSubagentCardHtml).join('');

    const conversationHtml = Array.isArray(mainConversation?.messages) && mainConversation.messages.length > 0
        ? renderTraceConversationHtml(mainConversation)
        : `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No main-agent messages recorded yet.'))}</div>`;

    return `
<div class="luker-studio-columns">
    <div class="luker-studio-panel">
        <div class="luker-studio-panel-title">${escapeHtml(i18n('Main Agent Rounds'))}</div>
        ${renderDirectorMainAgentRoundsHtml(trace)}
    </div>
    <div class="luker-studio-panel">
        <div class="luker-studio-panel-title">${escapeHtml(i18n('Sub-agent Dispatches'))}</div>
        <div class="luker-studio-agenda-rounds">${subagentsHtml}</div>
    </div>
</div>
<details class="luker-studio-raw">
    <summary>${escapeHtml(i18n('Main agent conversation (raw messages)'))}</summary>
    <div class="luker-studio-panel">${conversationHtml}</div>
</details>`;
}

function renderTraceMetaCardsHtml(trace, mode, isDirectorMode) {
    const card = (label, value) => `<div class="luker-studio-meta-card"><b>${escapeHtml(label)}</b><span>${escapeHtml(String(value))}</span></div>`;
    const cards = [
        card(i18n('Status'), formatOrchestrationRuntimeStatusLabel(trace.status)),
        card(i18n('Mode'), mode || 'spec'),
        card(i18n('Generation Type'), String(trace.generationType || 'normal')),
    ];
    if (isDirectorMode) {
        const rounds = Array.isArray(trace?.director?.mainAgent?.rounds) ? trace.director.mainAgent.rounds.length : 0;
        const subs = Array.isArray(trace?.director?.subagents) ? trace.director.subagents.length : 0;
        cards.push(card(i18n('Main agent rounds'), rounds));
        cards.push(card(i18n('Sub-agent dispatches'), subs));
    } else {
        cards.push(card(i18n('Target Layer'), String(trace.targetLayer || 0)));
        cards.push(card(i18n('Node Attempts'), String(Array.isArray(trace.attempts) ? trace.attempts.length : 0)));
        cards.push(card(i18n('Review Reruns'), String(trace.reviewRerunCount || 0)));
    }
    cards.push(card(i18n('Updated At'), formatReadableTimestamp(trace.updatedAt)));
    return cards.join('');
}

export function renderOrchestrationRuntimeTraceHtml(context) {
    const trace = getLatestOrchestrationRuntimeTrace(context);
    if (!trace || typeof trace !== 'object') {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No runtime orchestration trace available for this chat yet.'))}</div>`;
    }

    const notices = [
        i18n('This trace is in-memory only and clears when chat changes.'),
        trace.status === 'running' ? i18n('Trace is still running. Close and reopen to refresh.') : '',
        String(trace.note || ''),
    ].filter(Boolean);

    const mode = String(trace?.mode || '').trim().toLowerCase();
    const isLoopMode = mode === 'loop';
    const isAgendaMode = mode === 'agenda' || (trace?.agenda && typeof trace.agenda === 'object');
    const isDirectorMode = mode === 'director' || (trace?.director && typeof trace.director === 'object');

    let modeSpecificHtml;
    if (isLoopMode) {
        modeSpecificHtml = renderLoopModePanelHtml(trace);
    } else if (isAgendaMode) {
        modeSpecificHtml = renderAgendaModePanelsHtml(trace);
    } else if (isDirectorMode) {
        modeSpecificHtml = renderDirectorModePanelsHtml(trace);
    } else {
        modeSpecificHtml = `
<div class="luker-studio-columns">
    <div class="luker-studio-panel">
        <div class="luker-studio-panel-title">${escapeHtml(i18n('Flow Graph'))}</div>
        <div class="luker-studio-flow">${renderOrchestrationRuntimeTraceGraphHtml(trace)}</div>
        <div class="luker-studio-panel-title">${escapeHtml(i18n('Flow Events'))}</div>
        ${renderOrchestrationRuntimeTraceEventsHtml(trace)}
    </div>
    <div class="luker-studio-panel">
        <div class="luker-studio-panel-title">${escapeHtml(i18n('Execution Timeline'))}</div>
        ${renderOrchestrationRuntimeTraceAttemptsHtml(trace)}
    </div>
</div>`;
    }

    return `
<div class="luker-studio luker_orch_runtime_popup">
    <div class="luker-studio-notice">${notices.map(item => escapeHtml(String(item || ''))).join('<br />')}</div>
    <div class="luker-studio-meta-grid">
        ${renderTraceMetaCardsHtml(trace, mode, isDirectorMode)}
    </div>
    ${modeSpecificHtml}
    ${!isLoopMode && !isAgendaMode && !isDirectorMode ? '' : `<details class="luker-studio-raw">
        <summary>${escapeHtml(i18n('Flow Events'))}</summary>
        ${renderOrchestrationRuntimeTraceEventsHtml(trace)}
    </details>`}
    ${String(trace?.capsuleText || '').trim() ? `
        <details class="luker-studio-raw">
            <summary>${escapeHtml(i18n('Latest capsule text'))}</summary>
            <pre class="luker-studio-attempt-pre">${escapeHtml(String(trace.capsuleText || ''))}</pre>
        </details>` : ''}
    <details class="luker-studio-raw">
        <summary>${escapeHtml(i18n('Raw runtime trace'))}</summary>
        <pre class="luker-studio-attempt-pre">${escapeHtml(JSON.stringify(trace, null, 2))}</pre>
    </details>
</div>`;
}
