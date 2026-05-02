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

    return `
<div class="luker-studio luker_orch_runtime_popup">
    <div class="luker-studio-notice">${notices.map(item => escapeHtml(String(item || ''))).join('<br />')}</div>
    <div class="luker-studio-meta-grid">
        <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Status'))}</b><span>${escapeHtml(formatOrchestrationRuntimeStatusLabel(trace.status))}</span></div>
        <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Generation Type'))}</b><span>${escapeHtml(String(trace.generationType || 'normal'))}</span></div>
        <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Target Layer'))}</b><span>${escapeHtml(String(trace.targetLayer || 0))}</span></div>
        <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Node Attempts'))}</b><span>${escapeHtml(String(Array.isArray(trace.attempts) ? trace.attempts.length : 0))}</span></div>
        <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Review Reruns'))}</b><span>${escapeHtml(String(trace.reviewRerunCount || 0))}</span></div>
        <div class="luker-studio-meta-card"><b>${escapeHtml(i18n('Updated At'))}</b><span>${escapeHtml(formatReadableTimestamp(trace.updatedAt))}</span></div>
    </div>
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
    </div>
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
