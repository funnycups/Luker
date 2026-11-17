// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure model helpers for the shared Run Dock: normalizes recorded runs into
// segments/lanes, groups them into display blocks, and computes collapsed row
// previews. Zero DOM.

import { truncate } from '../lens-shared/util.js';
import {
    i18n,
    i18nFormat,
    isChineseLocale,
    listSeparator,
    agentName,
    toolName,
    stageName,
} from './dock-i18n.js';

const str = (value) => (value == null ? '' : String(value));

function splitAgentTodo(text, knownIds) {
    const candidates = [...knownIds].filter(id => text === id || text.startsWith(`${id}-`)).sort((a, b) => b.length - a.length);
    if (candidates.length) {
        const agent = candidates[0];
        return { agent, todo: text.slice(agent.length + 1) };
    }
    const cut = text.indexOf('-');
    return cut < 0 ? { agent: text, todo: '' } : { agent: text.slice(0, cut), todo: text.slice(cut + 1) };
}

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

export function displayStatus(status, error) {
    const value = str(status);
    if ((value === 'error' || value === 'aborted') && /abort|user_stopped|chat changed|cancel/i.test(str(error))) return 'aborted';
    return value;
}

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

    const laneOrder = [];
    const lanes = new Map();
    for (const seg of segments) {
        if (!lanes.has(seg.agentId)) {
            lanes.set(seg.agentId, { agentId: seg.agentId, segments: [] });
            laneOrder.push(seg.agentId);
        }
        lanes.get(seg.agentId).segments.push(seg);
    }

    const source = str(run.source || 'orchestrator');
    const runId = str(run.runId);
    return {
        runId,
        runKey: `${source}:${runId}`,
        mode,
        source,
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

export function parseMaybeJson(text) {
    if (text && typeof text === 'object') return text;
    const value = str(text).trim();
    if (!value || !/^[[{]/.test(value)) return value;
    try { return JSON.parse(value); } catch { return value; }
}

export function toolNameOf(section) {
    const m = /[:：]\s*(\S+)\s*$/.exec(str(section?.title));
    return m ? m[1] : '';
}

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

// ----- Blocks & collapsed row summaries --------------------------------------

function block(id, title, segments, extra = {}) {
    const statuses = segments.filter(s => !s.pending).map(s => s.status);
    const status = statuses.includes('running') ? 'running' : statuses.includes('failed') ? 'failed' : statuses.length ? 'done' : 'pending';
    const live = segments.filter(s => !s.pending);
    const start = live.length ? Math.min(...live.map(s => s.start)) : 0;
    const end = live.length ? Math.max(...live.map(s => s.end)) : 0;
    return { id, title, segments, status, duration: Math.max(0, end - start), ...extra };
}

export function buildBlocks(view, flow = null) {
    if (!view) return [];
    const segs = view.segments;
    const mode = view.mode;

    if (mode === 'spec' || mode === 'single') {
        const blocks = [];
        const seen = new Set();
        const stageCols = flow && (flow.mode === 'spec' || flow.mode === 'single') ? flow.columns : [];
        for (const seg of segs) {
            const key = `${seg.stageId}${seg.replay ? `#${seg.attempt}` : ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const col = stageCols.find(c => c.id === seg.stageId);
            const inStage = segs.filter(s => s.stageId === seg.stageId && Boolean(s.replay) === Boolean(seg.replay) && (!seg.replay || s.attempt === seg.attempt));
            const started = new Set(inStage.map(s => s.agentId));
            const pending = !seg.replay && col && view.status === 'running'
                ? col.nodes.filter(id => !started.has(id)).map(id => ({ key: `pending:${seg.stageId}/${id}`, agentId: id, pending: true, status: 'pending', start: 0, end: 0, duration: 0, sections: [] }))
                : [];
            blocks.push(block(key, seg.replay ? i18nFormat('${0} · redo', stageName(seg.stageId)) : stageName(seg.stageId), [...inStage, ...pending], {
                index: col ? stageCols.indexOf(col) + 1 : 0,
                parallel: Boolean(col?.parallel) && inStage.length + pending.length > 1,
                review: Boolean(col?.review),
                replay: Boolean(seg.replay),
            }));
        }
        if (view.status === 'running' && stageCols.length) {
            for (const col of stageCols) {
                if ([...seen].some(key => key.split('#')[0] === col.id)) continue;
                blocks.push(block(col.id, stageName(col.id), col.nodes.map(id => ({ key: `pending:${col.id}/${id}`, agentId: id, pending: true, status: 'pending', start: 0, end: 0, duration: 0, sections: [] })), {
                    index: stageCols.indexOf(col) + 1, parallel: col.parallel, review: col.review, upcoming: true,
                }));
            }
        }
        return blocks;
    }

    if (mode === 'agenda') {
        const blocks = [];
        for (const seg of segs) {
            if (seg.agentId === 'agenda_planner') {
                blocks.push(block(`r${seg.attempt}`, i18nFormat('Dispatch round ${0}', seg.attempt), [seg], { round: seg.attempt }));
            } else if (seg.final) {
                blocks.push(block('final', i18n('Wrap up'), [seg]));
            } else {
                const target = blocks.find(b => b.round === seg.attempt) || blocks[blocks.length - 1];
                if (target) {
                    target.segments.push(seg);
                    Object.assign(target, block(target.id, target.title, target.segments, { round: target.round, parallel: target.segments.length > 2 }));
                } else {
                    blocks.push(block(`r${seg.attempt}`, i18nFormat('Dispatch round ${0}', seg.attempt), [seg], { round: seg.attempt }));
                }
            }
        }
        return blocks;
    }

    if (mode === 'director') {
        const mains = segs.filter(s => s.agentId === 'main');
        const subs = segs.filter(s => s.agentId !== 'main');
        const blocks = mains.map(m => ({ main: m, subs: [] }));
        for (const sub of subs) {
            let owner = blocks[0];
            for (const b of blocks) if (b.main.start <= sub.start + 1) owner = b;
            if (owner) owner.subs.push(sub);
        }
        return blocks.map((b, i) => block(b.main.key, i18nFormat('Round ${0}', i + 1), [b.main, ...b.subs], { round: i + 1, parallel: b.subs.length > 1 }));
    }

    return segs.map((seg, i) => block(seg.key, i18nFormat('Round ${0}', seg.attempt || i + 1), [seg], { round: seg.attempt || i + 1 }));
}

export function runCounts(view) {
    if (!view) return { agents: 0, tools: 0, running: 0 };
    const tools = view.segments.reduce((n, seg) => n + (seg.sections || []).filter(s => s.kind === 'tool_call').length, 0);
    const running = view.segments.filter(s => s.status === 'running').length;
    return { agents: view.lanes.length, tools, running };
}

export function liveSummary(view, flow = null) {
    if (!view || view.status !== 'running') return '';
    const blocks = buildBlocks(view, flow);
    const current = [...blocks].reverse().find(b => b.status === 'running') || blocks[blocks.length - 1];
    if (!current) return '';
    const total = blocks.length;
    if (view.mode === 'spec' || view.mode === 'single') return `${current.title} · ${current.index || blocks.indexOf(current) + 1}/${flow?.columns?.length || total}`;
    return str(current.title);
}

export function currentBlock(blocks) {
    const ran = (blocks || []).filter(b => !b.upcoming);
    return [...ran].reverse().find(b => b.status === 'running') || ran[ran.length - 1] || null;
}

export function blockLabel(blk) {
    if (!blk) return { tag: '', title: '' };
    if (blk.index) return { tag: i18nFormat('Step ${0}', blk.index), title: blk.title };
    return { tag: blk.title, title: '' };
}

// ----- Collapsed-row one-line descriptions ---------------------------------

const quote = (value, max = 36) => i18nFormat('"${0}"', truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), max));
const count = (value) => (Array.isArray(value) ? value.length : value ? 1 : 0);

function hostOf(url) {
    try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return truncate(String(url || ''), 40); }
}

export function describeToolCall(name, rawArgs) {
    const args = parseMaybeJson(rawArgs);
    const a = args && typeof args === 'object' ? args : {};
    const n = String(name || '');
    const q = a.query ?? a.q ?? a.keyword ?? a.keywords;
    if (/(^|_)(web_search|agent_search)$/.test(n) || n === 'search_search') return { icon: 'search', text: q ? i18nFormat('Search the web ${0}', quote(q)) : i18n('Search the web') };
    if (/(^|_)(web_visit|agent_visit)$/.test(n) || n === 'search_visit') return { icon: 'external', text: a.url ? i18nFormat('Open ${0}', hostOf(a.url)) : i18n('Open web page') };
    if (/upsert_lorebook_entry$/.test(n)) return { icon: 'pen', text: a.title ? i18nFormat('Write to the lorebook ${0}', quote(a.title)) : i18n('Write lorebook entry') };
    if (/delete_lorebook_entry$/.test(n)) return { icon: 'trash', text: i18nFormat('Delete ${0} lorebook entries', count(a.entry_ids)) };
    if (/get_lorebook_entries$/.test(n)) return { icon: 'doc', text: i18nFormat('Read ${0} lorebook entries', count(a.entry_ids)) };
    switch (n) {
        case 'chat_search': return { icon: 'search', text: q ? i18nFormat('Search the chat ${0}', quote(q)) : i18n('Search the chat') };
        case 'chat_read_range': return { icon: 'doc', text: a.from != null && a.to != null ? i18nFormat('Read floors ${0}–${1}', a.from, a.to) : i18n('Read the chat') };
        case 'lorebook_search': return { icon: 'search', text: q ? i18nFormat('Search the lorebook ${0}', quote(q)) : i18n('Search the lorebook') };
        case 'lorebook_get': return { icon: 'doc', text: i18n('Read lorebook entry') };
        case 'dispatch_subagent':
        case 'dispatch_inline_subagent': {
            const id = a.subagentId || a.subagent_id || a.agent || '';
            return { icon: 'user', text: id ? i18nFormat('Dispatch ${0}', agentName(id)) : i18n('Dispatch a temporary agent') };
        }
        case 'await_subagents': return { icon: 'clock', text: count(a.handles) > 1 ? i18nFormat('Wait for ${0} agents', count(a.handles)) : i18n('Wait for agents') };
        case 'write_message': return { icon: 'pen', text: a.text ? i18nFormat('Write the text (${0} characters)', String(a.text).length) : i18n('Write the text') };
        case 'apply_message_patches': return { icon: 'pen', text: count(a.patches) ? i18nFormat('Revise the text in ${0} places', count(a.patches)) : i18n('Revise the text') };
        case 'finalize': return { icon: 'check', text: i18n('Wrap up') };
        case 'luker_orch_review_approve': return { icon: 'check', text: i18n('Review passed') };
        case 'luker_orch_request_rerun': return { icon: 'repeat', text: i18n('Send back for redo') };
        default:
            if (n.startsWith('memory_')) return { icon: 'search', text: q ? i18nFormat('${0} ${1}', toolName(n), quote(q)) : toolName(n) };
            return { icon: 'tool', text: toolName(n) };
    }
}

export function previewText(body, { tail = false, max = 120 } = {}) {
    const lines = String(body ?? '')
        .split('\n')
        .map(line => line.trim().replace(/^[-*•]\s+/, '').replace(/^[A-Za-z_][\w-]*:\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter(line => line && !/^[[\]{}]+,?$/.test(line));
    if (!lines.length) return '';
    const text = (tail ? lines.slice(-3) : lines.slice(0, 3)).join(' · ');
    if (text.length <= max) return text;
    return tail ? `…${text.slice(-(max - 1))}` : truncate(text, max);
}

export function segmentPreview(seg, mode) {
    const lines = [];
    if (!seg || seg.pending) return { lines: [{ icon: 'clock', text: i18n('Waiting'), muted: true }] };
    const running = seg.status === 'running';
    const sections = seg.sections || [];

    if (mode === 'agenda') {
        const decision = plannerDecision(sections.find(s => s.meta?.output));
        if (decision) {
            if (decision.dispatches.length) lines.push({ icon: 'user', text: i18nFormat('Dispatched ${0}', decision.dispatches.map(d => agentName(d.agent)).join(listSeparator())) });
            const added = decision.todos.filter(op => op.op === 'add').length;
            if (added) lines.push({ icon: 'plus', text: i18nFormat('Added ${0} to-dos', added) });
            if (decision.finalize) lines.push({ icon: 'check', text: i18n('Getting ready to wrap up') });
            return { lines };
        }
    }

    for (const section of sections) {
        if (section.kind !== 'tool_call') continue;
        const name = toolNameOf(section);
        const result = sections.find(s => s.kind === 'tool_result' && s.id === section.id.replace(/^tool-/, 'tool-result-'));
        const line = describeToolCall(name, section.meta?.args ?? section.body);
        if (result && (result.meta?.ok === false || result.status === 'failed')) line.text = i18nFormat('${0} [failed]', line.text);
        lines.push(line);
    }

    const text = sections.filter(s => s.kind === 'text' || s.kind === 'note').map(s => s.body).join('\n');
    const excerpt = previewText(text, { tail: running });
    if (excerpt && (!lines.length || !running)) lines.unshift({ icon: 'doc', text: excerpt, quote: true });

    if (!lines.length) {
        const reasoning = sections.find(s => s.kind === 'reasoning')?.body;
        if (running) lines.push({ icon: 'brain', text: reasoning ? i18nFormat('Thinking · ${0}', previewText(reasoning, { tail: true, max: 90 })) : i18n('Working…'), muted: true });
        else if (sections.some(s => s.kind === 'note')) lines.push({ icon: 'review', text: i18n('Review result passed to the next step'), muted: true });
        else if (seg.status === 'failed') lines.push({ icon: 'alert', text: String(sections.find(s => s.meta?.err)?.meta?.err || i18n('Agent failed')) });
    }
    return { lines };
}
