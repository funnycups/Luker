// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Turns a recorded orchestrator run (the run-panel store's run object plus
// our own section timestamps) into per-agent timeline segments.
//
// The runtimes encode who did what only in round / section ids:
//   spec      round `stage-<stage>[-replay-N]`, one section `node-<agent>` per node
//   agenda    round `node-agenda_planner-<r>` | `node-<agent>-<todo>-<r>` | `node-<final>-final`
//   loop      round `agent-<r>`
//   director  round `main-<r>` | `sub-<agent>-<dispatch>`
//   search    round `round-<r>` (the search-tools agent, its own store)
// Pure: no DOM.

import { i18nFormat, isChineseLocale } from '../i18n.js';

const str = (value) => (value == null ? '' : String(value));

/** Splits `<agent>-<todo>` using the known agent ids (ids may contain '-'). */
function splitAgentTodo(text, knownIds) {
    const candidates = [...knownIds].filter(id => text === id || text.startsWith(`${id}-`)).sort((a, b) => b.length - a.length);
    if (candidates.length) {
        const agent = candidates[0];
        return { agent, todo: text.slice(agent.length + 1) };
    }
    const cut = text.indexOf('-');
    return cut < 0 ? { agent: text, todo: '' } : { agent: text.slice(0, cut), todo: text.slice(cut + 1) };
}

/**
 * @returns {{ agentId: string, stageId?: string, attempt?: number, todo?: string, replay?: boolean, perSection?: boolean }}
 */
export function parseRound(mode, roundId, knownIds = []) {
    const id = str(roundId);
    let m;
    if (mode === 'spec' || mode === 'single') {
        m = /^stage-(.+?)(?:-replay-(\d+))?$/.exec(id);
        return { agentId: '', stageId: m ? m[1] : id, replay: Boolean(m?.[2]), attempt: m?.[2] ? Number(m[2]) + 1 : 1, perSection: true };
    }
    if (mode === 'agenda') {
        if ((m = /^node-agenda_planner-(\d+)$/.exec(id))) return { agentId: 'agenda_planner', attempt: Number(m[1]) };
        if ((m = /^node-(.+)-final$/.exec(id))) return { agentId: m[1], final: true, attempt: 1 };
        if ((m = /^node-(.+)-(\d+)$/.exec(id))) {
            const { agent, todo } = splitAgentTodo(m[1], knownIds);
            return { agentId: agent, todo, attempt: Number(m[2]) };
        }
        return { agentId: id.replace(/^node-/, '') };
    }
    if (mode === 'loop') {
        m = /^agent-(\d+)$/.exec(id);
        return { agentId: 'loop_agent', attempt: m ? Number(m[1]) : 1 };
    }
    if (mode === 'search') {
        m = /^round-(\d+)$/.exec(id);
        return { agentId: 'search_agent', attempt: m ? Number(m[1]) : 1 };
    }
    if (mode === 'director') {
        if ((m = /^main-(\d+)$/.exec(id))) return { agentId: 'main', attempt: Number(m[1]) + 1 };
        if ((m = /^sub-(.+)-(\d+)$/.exec(id))) return { agentId: m[1], attempt: Number(m[2]) };
    }
    return { agentId: id };
}

function sectionTimes(run, roundId, sectionId) {
    return run.times?.[`${roundId}/${sectionId}`] || null;
}

/**
 * Normalizes a recorded run into lanes of segments.
 * @param {object} run       recorded run (see recorder.js snapshotRun)
 * @param {string[]} knownIds agent ids from the current flow, to split agenda ids
 */
export function buildRunView(run, knownIds = []) {
    if (!run) return null;
    const mode = run.source === 'search' ? 'search' : str(run.mode);
    const start = Number(run.startedAt) || 0;
    const end = Number(run.endedAt) || Number(run.now) || start;
    const segments = [];
    const rounds = Array.isArray(run.rounds) ? run.rounds : [];

    for (const round of rounds) {
        const info = parseRound(mode, round.id, knownIds);
        const roundStart = (Number(round.startedAt) || start) - start;
        const roundEnd = round.endedAt != null ? Number(round.endedAt) - start : null;
        const sections = Array.isArray(round.sections) ? round.sections : [];
        if (info.perSection) {
            // Spec: one segment per node section, timed by our own stamps.
            for (const section of sections) {
                const agentId = str(section.id).replace(/^node-/, '');
                const times = sectionTimes(run, round.id, section.id);
                segments.push({
                    key: `${round.id}/${section.id}`,
                    agentId,
                    stageId: info.stageId,
                    attempt: info.attempt,
                    replay: info.replay,
                    status: section.status,
                    start: times?.start != null ? times.start - start : roundStart,
                    end: times?.end != null ? times.end - start : roundEnd,
                    sections: [section],
                });
            }
            continue;
        }
        segments.push({
            key: round.id,
            agentId: info.agentId,
            todo: info.todo || '',
            attempt: info.attempt || 1,
            final: Boolean(info.final),
            status: round.status,
            start: roundStart,
            end: roundEnd,
            sections,
        });
    }

    const running = run.status === 'running';
    const total = Math.max(1, end - start, ...segments.map(s => (s.end ?? (end - start))));
    for (const seg of segments) {
        if (seg.end == null) seg.end = running ? total : Math.max(seg.start, total);
        seg.duration = Math.max(0, seg.end - seg.start);
    }

    // Lanes: one per agent, in order of first appearance.
    const laneOrder = [];
    const lanes = new Map();
    for (const seg of segments) {
        if (!lanes.has(seg.agentId)) {
            lanes.set(seg.agentId, { agentId: seg.agentId, segments: [] });
            laneOrder.push(seg.agentId);
        }
        lanes.get(seg.agentId).segments.push(seg);
    }

    return {
        runId: str(run.runId),
        mode,
        source: str(run.source || 'orchestrator'),
        status: displayStatus(run.status, run.error),
        quiet: Boolean(run.quiet),
        error: str(run.error),
        finalText: str(run.finalText),
        tokens: run.tokensSpent?.total || 0,
        startedAtWall: Number(run.startedAtWall) || 0,
        floor: Number(run.floor) || 0,
        duration: total,
        segments,
        lanes: laneOrder.map(id => lanes.get(id)),
        peakParallel: peakConcurrency(segments),
    };
}

/**
 * spec / agenda / loop report a user stop as status 'error' with an
 * "Orchestration aborted." message; show those (and chat switches) as stopped.
 */
export function displayStatus(status, error) {
    const value = str(status);
    if ((value === 'error' || value === 'aborted') && /abort|user_stopped|chat changed|cancel/i.test(str(error))) return 'aborted';
    return value;
}

/** Largest number of segments overlapping in time (sweep line). */
export function peakConcurrency(segments) {
    const points = [];
    for (const seg of segments) {
        if (!(seg.end > seg.start)) continue;
        points.push([seg.start, 1], [seg.end, -1]);
    }
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let current = 0;
    let peak = segments.length ? 1 : 0;
    for (const [, delta] of points) {
        current += delta;
        peak = Math.max(peak, current);
    }
    return peak;
}

/** Per-agent status for the flow view: { [agentId]: { status, runs, failed } }. */
export function agentActivity(view) {
    const out = {};
    if (!view) return out;
    for (const seg of view.segments) {
        const entry = out[seg.agentId] || (out[seg.agentId] = { status: 'done', runs: 0, failed: 0, lastKey: '' });
        entry.runs += 1;
        if (seg.status === 'failed') entry.failed += 1;
        if (seg.status === 'running') entry.status = 'running';
        else if (entry.status !== 'running') entry.status = seg.status === 'failed' ? 'failed' : 'done';
        entry.lastKey = seg.key;
    }
    return out;
}

// ----- Section content -------------------------------------------------------

/** Best-effort JSON parse for tool args / results; returns the input on failure. */
export function parseMaybeJson(text) {
    if (text && typeof text === 'object') return text;
    const value = str(text).trim();
    if (!value || !/^[[{]/.test(value)) return value;
    try { return JSON.parse(value); } catch { return value; }
}

/** Tool name from a section title like "Tool: chat_search"; localized titles may use a full-width colon. */
export function toolNameOf(section) {
    const m = /[:：]\s*(\S+)\s*$/.exec(str(section?.title));
    return m ? m[1] : '';
}

/**
 * Agenda planner sections carry the decision in meta.output:
 * { todo_ops: [{op, todo_id, goal, status}], dispatches: [{agent, todo_id, task_brief}], finalize }
 */
export function plannerDecision(section) {
    const output = section?.meta?.output;
    if (!output || typeof output !== 'object') return null;
    return {
        todos: (Array.isArray(output.todo_ops) ? output.todo_ops : []).map(op => ({ op: str(op?.op), id: str(op?.todo_id), goal: str(op?.goal), status: str(op?.status) })),
        dispatches: (Array.isArray(output.dispatches) ? output.dispatches : []).map(d => ({ agent: str(d?.agent), todo: str(d?.todo_id), brief: str(d?.task_brief) })),
        finalize: Boolean(output.finalize),
    };
}

export function formatDuration(ms) {
    const value = Math.max(0, Number(ms) || 0);
    if (value < 1000) return i18nFormat('${0} ms', Math.round(value));
    const secs = value / 1000;
    if (secs < 60) return i18nFormat('${0} s', secs < 10 ? secs.toFixed(1) : Math.round(secs));
    const m = Math.floor(secs / 60);
    return i18nFormat('${0} min ${1} s', m, String(Math.floor(secs - m * 60)).padStart(2, '0'));
}

export function formatTokens(n) {
    const value = Number(n) || 0;
    if (value >= 10000 && isChineseLocale()) return i18nFormat('${0} x10k', (value / 10000).toFixed(value >= 100000 ? 0 : 1));
    return String(value);
}
