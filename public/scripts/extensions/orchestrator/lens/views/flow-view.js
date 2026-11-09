// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Flow view: the configured workflow as left-to-right columns of agent cards,
// joined by hand-drawn SVG curves. While a run is live the cards light up
// (amber = working, teal = done, red = failed) and the curves into working
// cards animate.

import { h, clear, put, hashString } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat, listSeparator, agentName, agentRole, stageName, toolName, modeInfo } from '../i18n.js';
import { agentActivity } from '../model/run.js';
import { emptyState } from '../ui/components.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GROUP_LABELS = { scout: 'Scouting before the draft', plan: 'Ideas', critic: 'Review after the draft', curator: 'Final tidying', other: 'Other agents' };
const LIMIT_LABELS = { limitRounds: 'Up to ${0} rounds', limitConcurrent: 'Up to ${0} at once', limitTotal: 'Up to ${0} runs in total', limitTime: 'Up to ${0} seconds' };
export const TONES = 8;

export function toneOf(id) {
    return `t${hashString(id) % TONES}`;
}

/** Avatar glyph: first character of the display name. */
function glyph(id) {
    const name = agentName(id);
    return Array.from(name)[0]?.toUpperCase() || '?';
}

export function agentAvatar(id, { size = 'md' } = {}) {
    return h('span', { class: `ol-avatar is-${size}`, dataset: { tone: toneOf(id) }, 'aria-hidden': 'true', text: glyph(id) });
}

function groupTitle(column) {
    if (column.kind === 'stage') {
        return column.review ? i18n('Review step') : stageName(column.id);
    }
    if (column.kind === 'pool') return i18n('Available agents');
    if (column.kind === 'group') return i18n(GROUP_LABELS[column.group]);
    if (column.kind === 'driver') return column.id === 'main' ? i18n('Lead writer') : i18n('Dispatcher');
    return '';
}

export function createFlowView(app) {
    const canvas = h('div', { class: 'ol-flow-canvas' });
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ol-flow-wires');
    svg.setAttribute('aria-hidden', 'true');
    const head = h('div', { class: 'ol-flow-head' });
    const scroller = h('div', { class: 'ol-flow-scroll' }, h('div', { class: 'ol-flow-inner' }, svg, canvas));
    const el = h('section', { class: 'ol-flow', 'aria-label': i18n('Flow') }, head, scroller);
    const cards = new Map(); // agentId → element
    let wires = []; // [{ from, to, kind }] ids, or column boxes
    let frame = 0;

    const resize = new ResizeObserver(() => scheduleWires());
    resize.observe(canvas);

    function scheduleWires() {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(drawWires);
    }

    function card(agent, flow, activity) {
        const id = agent.id;
        const act = activity[id];
        const status = act?.status || 'idle';
        const tools = agent.tools ?? agent.inheritedTools ?? [];
        const selected = app.state().selectedAgent === id;
        const chips = [];
        if (agent.kind === 'review') chips.push(h('span', { class: 'ol-chip is-review' }, icon('review', { size: 12 }), h('span', { text: i18n('Review step') })));
        if (tools.length) chips.push(h('span', { class: 'ol-chip', title: tools.map(toolName).join(listSeparator()) }, icon('tool', { size: 12 }), h('span', { text: String(tools.length) })));
        if (agent.apiPreset || agent.promptPreset) chips.push(h('span', { class: 'ol-chip', title: [agent.apiPreset, agent.promptPreset].filter(Boolean).join(' · ') }, icon('brain', { size: 12 }), h('span', { text: agent.apiPreset || agent.promptPreset })));
        if (flow.edited?.has(id)) chips.push(h('span', { class: 'ol-chip is-edited', title: i18n('Has unsaved edits') }, icon('pen', { size: 12 }), h('span', { text: i18n('Unsaved') })));
        if (act?.runs > 1) chips.push(h('span', { class: 'ol-chip is-runs', text: `×${act.runs}` }));
        const btn = h('button', {
            type: 'button',
            class: `ol-card is-${agent.kind}`,
            dataset: { tone: toneOf(id), status, agent: id },
            'aria-pressed': String(selected),
            'aria-label': status !== 'idle' ? i18nFormat('${0}, ${1}', agentName(id), i18n(status === 'running' ? 'Working' : status === 'failed' ? 'Errored' : 'Finished')) : agentName(id),
            onClick: () => app.selectAgent(selected ? '' : id),
        },
        h('span', { class: 'ol-card-top' },
            agentAvatar(id),
            h('span', { class: 'ol-card-titles' },
                h('span', { class: 'ol-card-name', text: agentName(id) }),
                h('span', { class: 'ol-card-id', text: agentName(id) !== id ? id : '' })),
            h('span', { class: 'ol-card-state', 'aria-hidden': 'true' },
                status === 'running' ? h('span', { class: 'ol-pulse' }) : status === 'done' ? icon('check', { size: 14 }) : status === 'failed' ? icon('alert', { size: 14 }) : null)),
        agentRole(id) || agent.description ? h('span', { class: 'ol-card-role', text: agentRole(id) || agent.description }) : null,
        chips.length ? h('span', { class: 'ol-card-chips' }, chips) : null);
        cards.set(id, btn);
        return btn;
    }

    function columnEl(column, flow, activity) {
        const title = groupTitle(column);
        const tag = column.kind === 'stage' && column.index ? i18nFormat('Step ${0}', column.index) : '';
        const flags = [];
        if (column.parallel) flags.push(h('span', { class: 'ol-colflag is-parallel', title: i18n('At the same time') }, icon('layers', { size: 12 }), h('span', { text: i18n('At the same time') })));
        else if (column.kind === 'stage' && column.nodes.length > 1) flags.push(h('span', { class: 'ol-colflag', text: i18n('One after another') }));
        const box = h('div', { class: `ol-col is-${column.kind}`, dataset: { col: column.id, group: column.group || '' } },
            h('div', { class: 'ol-col-head' },
                tag ? h('span', { class: 'ol-col-tag', text: tag }) : null,
                h('span', { class: 'ol-col-title', text: title }),
                flags),
            column.kind === 'pool' ? h('div', { class: 'ol-col-hint', text: i18n('The dispatcher picks agents as needed and can send several at once') }) : null,
            column.id === 'main' ? h('div', { class: 'ol-col-hint', text: i18n('Coordinates everything, drafts the text and revises on feedback') }) : null,
            h('div', { class: 'ol-col-cards' }, column.nodes.map(id => flow.agents[id] ? card(flow.agents[id], flow, activity) : null)),
            column.review ? h('div', { class: 'ol-col-rerun' }, icon('repeat', { size: 13 }), h('span', { text: i18n('Sent back for redo if it fails') })) : null);
        return box;
    }

    function loopEl(flow, activity) {
        const agent = flow.agents.loop_agent;
        const tools = agent.tools || [];
        return h('div', { class: 'ol-loop' },
            h('div', { class: 'ol-loop-ring', 'aria-hidden': 'true' }, icon('repeat', { size: 18 })),
            card(agent, flow, activity),
            h('div', { class: 'ol-loop-hint', text: i18n('One agent keeps looking things up and wraps up when it has enough') }),
            tools.length ? h('div', { class: 'ol-loop-tools' },
                h('div', { class: 'ol-col-head' }, h('span', { class: 'ol-col-title', text: i18n('Available tools') })),
                h('div', { class: 'ol-toolcloud' }, tools.map(name => h('span', { class: 'ol-chip', text: toolName(name) })))) : null);
    }

    function outputEl(flow) {
        const body = flow.output === 'body';
        return h('div', { class: 'ol-out', dataset: { col: '__out' } },
            h('span', { class: 'ol-out-icon', 'aria-hidden': 'true' }, icon(body ? 'pen' : 'capsule', { size: 16 })),
            h('span', { class: 'ol-out-text', text: body ? i18n('Writes the reply directly') : i18n('Handed to the main model to write the reply') }));
    }

    function render() {
        const flow = app.flow();
        cards.clear();
        clear(canvas);
        clear(head);
        wires = [];
        if (!flow) return;
        const activity = agentActivity(currentRunFor(flow));
        const info = modeInfo(flow.mode);
        put(head,
            h('div', { class: 'ol-flow-title' },
                h('h2', { text: info.label }),
                h('span', { class: 'ol-flow-sub', text: info.hint })),
            h('div', { class: 'ol-flow-meta' },
                flow.presetName ? h('span', { class: 'ol-pill', text: i18nFormat('Profile "${0}"', flow.presetName) }) : null,
                h('span', { class: 'ol-pill', dataset: { source: flow.source }, text: flow.scopeLabel }),
                flow.limits.map(limit => h('span', { class: 'ol-pill is-muted', text: limitText(limit) }))));

        if (!flow.columns.length || !Object.keys(flow.agents).length) {
            put(canvas, emptyState('flow', i18n('No runs yet')));
            return;
        }
        canvas.dataset.mode = flow.mode;
        if (flow.mode === 'loop') {
            put(canvas, h('div', { class: 'ol-flow-row' }, startEl(), loopEl(flow, activity), outputEl(flow)));
            wires = [['__start', 'loop_agent'], ['loop_agent', '__out']];
        } else if (flow.mode === 'director') {
            const [main, ...groups] = flow.columns;
            put(canvas, h('div', { class: 'ol-flow-row is-director' },
                startEl(),
                h('div', { class: 'ol-director-main' }, columnEl(main, flow, activity), outputEl(flow)),
                groups.length ? h('div', { class: 'ol-director-team', dataset: { col: '__team' } },
                    h('div', { class: 'ol-team-label' }, icon('user', { size: 13 }), h('span', { text: i18n('Agent team: the lead writer dispatches as needed, several at once') })),
                    groups.map(col => columnEl(col, flow, activity))) : null));
            wires = [['__start', 'main'], ['main', '__out', 'down']];
            if (groups.length) wires.push(['main', '__team', 'team']);
        } else {
            const cols = flow.columns.map(col => columnEl(col, flow, activity));
            put(canvas, h('div', { class: 'ol-flow-row' }, startEl(), cols, outputEl(flow)));
            const ids = flow.columns.map(col => col.nodes.filter(id => flow.agents[id]));
            // Stacked (phone) layout: wire whole columns, not every card pair.
            const targets = (i) => (app.isCompact() || (flow.mode === 'agenda' && flow.columns[i]?.kind === 'pool') ? [`col:${flow.columns[i].id}`] : ids[i]);
            const firstTargets = targets(0) || [];
            for (const id of firstTargets) wires.push(['__start', id]);
            for (let i = 0; i < ids.length - 1; i++) {
                for (const from of targets(i)) for (const to of targets(i + 1)) wires.push([from, to]);
            }
            for (const from of targets(ids.length - 1) || []) wires.push([from, '__out']);
            if (flow.mode === 'agenda' && !app.isCompact()) wires.push(['agenda_planner', 'col:pool', 'back']);
        }
        scheduleWires();
    }

    function startEl() {
        return h('div', { class: 'ol-start', dataset: { col: '__start' } }, icon('play', { size: 13 }), h('span', { text: i18n('Start') }));
    }

    function limitText({ key, value }) {
        if (key === 'limitRerun') return `${i18n('Sent back for redo if it fails')} · ${i18nFormat('Up to ${0} rounds', value)}`;
        return i18nFormat(LIMIT_LABELS[key], value);
    }

    function currentRunFor(flow) {
        if (app.state().pinnedRunId) return null;
        const run = app.run();
        return run && !run.quiet && (run.mode === flow.mode || (run.mode === 'spec' && flow.mode === 'single')) ? run : null;
    }

    function anchorOf(ref) {
        if (ref.startsWith('col:')) return canvas.querySelector(`[data-col="${CSS.escape(ref.slice(4))}"]`);
        if (ref.startsWith('__')) return canvas.querySelector(`[data-col="${ref}"]`);
        return cards.get(ref) || null;
    }

    function drawWires() {
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const base = canvas.getBoundingClientRect();
        svg.setAttribute('width', String(canvas.scrollWidth));
        svg.setAttribute('height', String(canvas.scrollHeight));
        const activity = agentActivity(currentRunFor(app.flow() || {}) || null);
        for (const [fromRef, toRef, kind] of wires) {
            const a = anchorOf(fromRef);
            const b = anchorOf(toRef);
            if (!a || !b) continue;
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            let d;
            if (app.isCompact() && kind !== 'back') {
                // Stacked layout: everything flows top → bottom.
                const x1 = ra.left + ra.width / 2 - base.left;
                const y1 = ra.bottom - base.top;
                const x2 = rb.left + rb.width / 2 - base.left;
                const y2 = rb.top - base.top;
                if (y2 < y1) continue;
                const dy = Math.max(16, (y2 - y1) * 0.5);
                d = `M${x1} ${y1}C${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`;
            } else if (kind === 'down') {
                const x = ra.left + ra.width / 2 - base.left;
                d = `M${x} ${ra.bottom - base.top}L${x} ${rb.top - base.top}`;
            } else if (kind === 'back') {
                // Planner ⇄ pool: a return arc under the cards.
                const x1 = rb.left - base.left + 18;
                const x2 = ra.left + ra.width / 2 - base.left;
                const y1 = rb.bottom - base.top - 10;
                const y2 = ra.bottom - base.top;
                const dip = Math.max(y1, y2) + 34;
                d = `M${x1} ${y1}C${x1} ${dip} ${x2} ${dip} ${x2} ${y2}`;
            } else {
                const x1 = ra.right - base.left;
                const y1 = ra.top + ra.height / 2 - base.top;
                const x2 = rb.left - base.left;
                const y2 = rb.top + (kind === 'team' ? Math.min(22, rb.height / 2) : rb.height / 2) - base.top;
                const dx = Math.max(28, (x2 - x1) * 0.5);
                d = `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
            }
            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', d);
            const target = toRef.startsWith('col:') || toRef.startsWith('__') ? '' : toRef;
            let status = activity[target]?.status;
            // A wire into a group lights up while any member is working.
            if (!target && (toRef === '__team' || toRef.startsWith('col:'))) {
                const members = toRef === '__team'
                    ? Object.keys(activity).filter(id => id !== 'main')
                    : (app.flow()?.columns.find(col => col.id === toRef.slice(4))?.nodes || []);
                if (members.some(id => activity[id]?.status === 'running')) status = 'running';
                else if (members.some(id => activity[id])) status = 'done';
            }
            path.setAttribute('class', `ol-wire${kind === 'back' ? ' is-back' : ''}${status === 'running' ? ' is-live' : status === 'done' ? ' is-done' : ''}`);
            const tone = target ? toneOf(target) : '';
            if (tone) path.dataset.tone = tone;
            svg.appendChild(path);
        }
    }

    return {
        id: 'flow',
        el,
        render,
        onShow: scheduleWires,
        onSelectionChange() {
            const selected = app.state().selectedAgent;
            for (const [id, node] of cards) node.setAttribute('aria-pressed', String(id === selected));
        },
        onRunUpdate: render,
        onLayoutChange: render,
        destroy() {
            resize.disconnect();
            cancelAnimationFrame(frame);
        },
    };
}
