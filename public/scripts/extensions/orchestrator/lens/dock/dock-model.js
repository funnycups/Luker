// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Groups a run view into the blocks the side panel shows:
//   spec / single  one block per stage (with not-yet-started agents as pending)
//   agenda         one block per planner round (planner + its dispatches), then the wrap-up
//   loop           one block per round
//   director       one block per main-agent round, holding the sub-agents it dispatched
//   search         one block per round
// Pure: no DOM.

import { i18n, i18nFormat, stageName } from '../i18n.js';

const str = (value) => (value == null ? '' : String(value));

function block(id, title, segments, extra = {}) {
    const statuses = segments.filter(s => !s.pending).map(s => s.status);
    const status = statuses.includes('running') ? 'running' : statuses.includes('failed') ? 'failed' : statuses.length ? 'done' : 'pending';
    const live = segments.filter(s => !s.pending);
    const start = live.length ? Math.min(...live.map(s => s.start)) : 0;
    const end = live.length ? Math.max(...live.map(s => s.end)) : 0;
    return { id, title, segments, status, duration: Math.max(0, end - start), ...extra };
}

/**
 * @param {object} view   buildRunView() output
 * @param {object} [flow] buildFlow() output for the configured workflow (used to
 *                        show upcoming spec stages and agents that haven't started)
 */
export function buildBlocks(view, flow = null) {
    if (!view) return [];
    const segs = view.segments;
    const mode = view.mode;

    if (mode === 'spec' || mode === 'single') {
        const blocks = [];
        const seen = new Set();
        const stageCols = flow && (flow.mode === 'spec' || flow.mode === 'single') ? flow.columns : [];
        // Stages in run order; replays become their own block.
        for (const seg of segs) {
            const key = `${seg.stageId}${seg.replay ? `#${seg.attempt}` : ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const col = stageCols.find(c => c.id === seg.stageId);
            const inStage = segs.filter(s => s.stageId === seg.stageId && Boolean(s.replay) === Boolean(seg.replay) && (!seg.replay || s.attempt === seg.attempt));
            const started = new Set(inStage.map(s => s.agentId));
            // A full (non-replay) stage that's still running shows its other nodes as waiting.
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
        // Upcoming stages (only while running, and only for the matching workflow).
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
        // A sub-agent belongs to the main round that was running when it started.
        for (const sub of subs) {
            let owner = blocks[0];
            for (const b of blocks) if (b.main.start <= sub.start + 1) owner = b;
            if (owner) owner.subs.push(sub);
        }
        return blocks.map((b, i) => block(b.main.key, i18nFormat('Round ${0}', i + 1), [b.main, ...b.subs], { round: i + 1, parallel: b.subs.length > 1 }));
    }

    // loop, search, anything else: one block per segment.
    return segs.map((seg, i) => block(seg.key, i18nFormat('Round ${0}', seg.attempt || i + 1), [seg], { round: seg.attempt || i + 1 }));
}

/** Header numbers for the panel. */
export function runCounts(view) {
    if (!view) return { agents: 0, tools: 0, running: 0 };
    const tools = view.segments.reduce((n, seg) => n + (seg.sections || []).filter(s => s.kind === 'tool_call').length, 0);
    const running = view.segments.filter(s => s.status === 'running').length;
    return { agents: view.lanes.length, tools, running };
}

/** Text for the floating pill while running. */
export function liveSummary(view, flow = null) {
    if (!view || view.status !== 'running') return '';
    const blocks = buildBlocks(view, flow);
    const current = [...blocks].reverse().find(b => b.status === 'running') || blocks[blocks.length - 1];
    if (!current) return '';
    const total = blocks.length;
    if (view.mode === 'spec' || view.mode === 'single') return `${current.title} · ${current.index || blocks.indexOf(current) + 1}/${flow?.columns?.length || total}`;
    return str(current.title);
}

/**
 * The block the small floating window shows: the running one (latest if
 * several), else the last one that actually ran. Upcoming spec stages are skipped.
 */
export function currentBlock(blocks) {
    const ran = (blocks || []).filter(b => !b.upcoming);
    return [...ran].reverse().find(b => b.status === 'running') || ran[ran.length - 1] || null;
}

/** Tag and title of a block. */
export function blockLabel(blk) {
    if (!blk) return { tag: '', title: '' };
    if (blk.index) return { tag: i18nFormat('Step ${0}', blk.index), title: blk.title };
    return { tag: blk.title, title: '' };
}
