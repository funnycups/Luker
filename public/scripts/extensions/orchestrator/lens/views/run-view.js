// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Run view: one run at a time. Stats strip, a swimlane timeline (one lane per
// agent, bars = each time it worked; overlapping bars = ran in parallel),
// and the step-by-step detail of the selected bar.

import { h, clear, put, copyText, formatTime } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat, agentName, statusLabel, modeInfo } from '../i18n.js';
import { formatDuration, formatTokens } from '../model/run.js';
import { emptyState, button, iconButton } from '../ui/components.js';
import { agentAvatar, toneOf } from './flow-view.js';
import { renderSections, collapseAllText } from './sections.js';

const TICK_STEPS = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];

function ticksFor(duration) {
    const step = TICK_STEPS.find(s => duration / s <= 8) || 600000;
    const out = [];
    for (let at = 0; at <= duration; at += step) out.push(at);
    return out;
}

function tickLabel(ms) {
    if (ms === 0) return '0';
    const secs = ms / 1000;
    if (secs < 60) return `${secs % 1 ? secs.toFixed(1) : secs}s`;
    return `${Math.floor(secs / 60)}m${secs % 60 ? `${Math.round(secs % 60)}s` : ''}`;
}

export function createRunView(app) {
    const el = h('section', { class: 'ol-run', 'aria-label': i18n('Run') });
    let lastRunId = '';
    let current = null;
    const run = () => current || {};

    function stat(label, value, extra = null) {
        return h('div', { class: 'ol-stat' }, h('span', { class: 'ol-stat-label', text: label }), h('span', { class: 'ol-stat-value' }, value, extra));
    }

    function header(run) {
        const pinned = app.state().pinnedRunId;
        const running = run.status === 'running';
        const started = run.startedAtWall ? formatTime(run.startedAtWall) : '';
        return h('div', { class: 'ol-run-head' },
            pinned ? h('div', { class: 'ol-run-pinned' },
                icon('history', { size: 14 }), h('span', { text: i18n('Viewing a past run') }),
                button(i18n('Back to current'), () => app.setState({ pinnedRunId: '', selectedSegment: '' }), { className: 'ol-btn-sm ol-btn-ghost', iconName: 'arrowLeft' })) : null,
            h('div', { class: 'ol-stats' },
                stat(i18n('Status'), h('span', { class: 'ol-status', dataset: { status: running ? 'running' : run.status } },
                    h('span', { class: 'ol-status-dot', 'aria-hidden': 'true' }), h('span', { text: statusLabel(run.status) }))),
                stat(i18n('Execution mode'), modeInfo(run.mode === 'spec' && app.flow()?.mode === 'single' ? 'single' : run.mode).label),
                stat(i18n('Time used'), formatDuration(run.duration)),
                run.tokens ? stat(i18n('Usage'), formatTokens(run.tokens), h('small', { text: ' tokens' })) : null,
                stat(i18n('Agent count'), String(run.lanes.length), run.peakParallel > 1 ? h('small', { class: 'ol-stat-note', text: i18nFormat(' · up to ${0} at once', run.peakParallel) }) : null),
                run.floor >= 0 && run.floor !== 0 ? stat(i18n('Floor'), `#${run.floor}`) : null,
                started ? stat(i18n('Started'), started) : null,
                h('span', { class: 'ol-spacer' }),
                app.source?.lastRunSummary ? h('span', { class: 'ol-insp-note', text: app.source.lastRunSummary() }) : null,
                iconButton('shrink', i18n('Collapse all'), () => collapseAllText(el), { className: 'ol-iconbtn-sm' }),
                !running && app.source?.ai ? button(i18n('AI diagnosis'), () => app.diagnose(run.key), { iconName: 'target', className: 'ol-btn-sm', title: i18n('Let the AI find what went wrong in this run') }) : null,
                running && !pinned ? button(i18n('Stop run'), () => { if (!app.recorder.stop(run)) app.notify(i18n('Could not stop'), { error: true }); }, { iconName: 'stop', className: 'ol-btn-sm ol-btn-danger' }) : null),
            run.error && run.status !== 'committed' ? h('div', { class: 'ol-run-error' }, icon('alert', { size: 14 }), h('span', { text: humanError(run.error) })) : null);
    }

    function humanError(text) {
        const value = String(text);
        if (/chat changed/i.test(value)) return i18n('The chat changed, so the run stopped');
        if (/user_stopped|aborted/i.test(value)) return i18n('Stopped manually');
        return value;
    }

    function timeline(run) {
        const selected = app.state().selectedSegment;
        const duration = Math.max(run.duration, 1);
        const pct = (ms) => `${Math.min(100, Math.max(0, (ms / duration) * 100))}%`;
        const ticks = ticksFor(duration);
        const axis = h('div', { class: 'ol-tl-axis', 'aria-hidden': 'true' },
            ticks.map(at => h('span', { class: 'ol-tl-tick', style: { left: pct(at) }, text: tickLabel(at) })));
        const grid = h('div', { class: 'ol-tl-grid', 'aria-hidden': 'true' }, ticks.map(at => h('span', { style: { left: pct(at) } })));
        const lanes = run.lanes.map(lane => {
            const total = lane.segments.reduce((sum, seg) => sum + seg.duration, 0);
            return h('div', { class: 'ol-lane', dataset: { tone: toneOf(lane.agentId) } },
                h('button', { type: 'button', class: 'ol-lane-label', onClick: () => app.selectAgent(lane.agentId), title: agentName(lane.agentId) },
                    agentAvatar(lane.agentId, { size: 'sm' }),
                    h('span', { class: 'ol-lane-name', text: agentName(lane.agentId) }),
                    h('span', { class: 'ol-lane-sum', text: lane.segments.length > 1 ? `×${lane.segments.length}` : formatDuration(total) })),
                h('div', { class: 'ol-lane-track' },
                    lane.segments.map(seg => h('button', {
                        type: 'button',
                        class: 'ol-bar',
                        dataset: { status: seg.status, replay: seg.replay ? 'true' : null },
                        'aria-pressed': String(seg.key === selected),
                        'aria-label': i18nFormat('${0} ${1}, ${2}, ${3}', agentName(seg.agentId), segmentLabel(seg), formatDuration(seg.duration), statusLabel(seg.status)),
                        title: `${segmentLabel(seg)} · ${formatDuration(seg.duration)}`,
                        style: { left: pct(seg.start), width: `max(6px, ${pct(seg.duration)})` },
                        onClick: () => app.selectSegment(seg.key === selected ? '' : seg.key, seg.agentId),
                    }, h('span', { class: 'ol-bar-text', text: barText(seg) })))));
        });
        return h('div', { class: 'ol-tl' },
            h('div', { class: 'ol-tl-head' }, h('span', { class: 'ol-tl-title', text: i18n('Timeline') }), h('span', { class: 'ol-tl-hint', text: i18n('Overlapping bars ran at the same time') })),
            h('div', { class: 'ol-tl-body' },
                h('div', { class: 'ol-tl-scale' }, h('span'), axis),
                h('div', { class: 'ol-tl-lanes' }, h('div', { class: 'ol-tl-gridwrap' }, h('span'), grid), lanes)));
    }

    function segmentLabel(seg) {
        if (seg.replay) return i18nFormat('Redo · attempt ${0}', seg.attempt);
        if (seg.final) return i18n('Wrap up');
        if (seg.todo) return i18nFormat('Task "${0}"', seg.todo);
        // Only the driver agents have numbered rounds; a director sub-agent's
        // number is its dispatch handle, not a round.
        if (['main', 'loop_agent', 'agenda_planner'].includes(seg.agentId)) return i18nFormat('Round ${0}', seg.attempt);
        if (run().mode === 'agenda' && seg.attempt > 1) return i18nFormat('Dispatch in round ${0}', seg.attempt);
        return '';
    }

    function barText(seg) {
        const label = segmentLabel(seg);
        return label || formatDuration(seg.duration);
    }

    function detail(run) {
        const key = app.state().selectedSegment;
        const seg = run.segments.find(item => item.key === key);
        if (!seg) {
            return h('div', { class: 'ol-detail is-empty' },
                run.finalText ? finalBlock(run) : null,
                h('p', { class: 'ol-detail-hint', text: i18n('Pick a bar on the timeline to see its process.') }));
        }
        const index = run.segments.indexOf(seg);
        const prev = run.segments[index - 1];
        const next = run.segments[index + 1];
        return h('div', { class: 'ol-detail' },
            h('div', { class: 'ol-detail-head', dataset: { tone: toneOf(seg.agentId) } },
                agentAvatar(seg.agentId),
                h('div', { class: 'ol-detail-titles' },
                    h('h3', { text: agentName(seg.agentId) }),
                    h('span', { class: 'ol-detail-sub', text: [segmentLabel(seg), formatDuration(seg.duration), statusLabel(seg.status)].filter(Boolean).join(' · ') })),
                h('span', { class: 'ol-spacer' }),
                app.source?.ai && run.status !== 'running' ? button(i18n('Diagnose this step'), () => app.diagnose(run.key, index + 1), { iconName: 'target', className: 'ol-btn-sm ol-btn-ghost' }) : null,
                iconButton('chevronLeft', i18n('Previous segment'), () => prev && app.selectSegment(prev.key, prev.agentId), { disabled: !prev }),
                iconButton('chevronRight', i18n('Next segment'), () => next && app.selectSegment(next.key, next.agentId), { disabled: !next }),
                iconButton('x', i18n('Close'), () => app.selectSegment(''))),
            renderSections(seg.sections, { app, mode: run.mode, agentId: seg.agentId }));
    }

    function finalBlock(run) {
        const body = run.mode === 'director';
        return h('div', { class: 'ol-final' },
            h('div', { class: 'ol-final-head' },
                icon(body ? 'pen' : 'capsule', { size: 15 }),
                h('span', { class: 'ol-final-title', text: i18n('Final result') }),
                h('span', { class: 'ol-final-note', text: body ? i18n('This is the reply text that was sent') : i18n('This text is injected for the main model') }),
                h('span', { class: 'ol-spacer' }),
                iconButton('copy', i18n('Copy'), async () => { if (await copyText(run.finalText)) app.notify(i18n('Copied')); }, { className: 'ol-iconbtn-sm' })),
            h('div', { class: 'ol-final-text', text: run.finalText }));
    }

    function render() {
        const run = app.run();
        current = run;
        clear(el);
        if (!run) {
            put(el, emptyState('play', i18n('No runs yet'), i18n('Orchestration runs automatically when you send a message, and the process shows here live.')));
            return;
        }
        if (run.runId !== lastRunId) lastRunId = run.runId;
        put(el, header(run), h('div', { class: 'ol-run-main' }, timeline(run), detail(run)));
    }

    return {
        id: 'run',
        el,
        render,
        onSelectionChange: render,
    };
}
