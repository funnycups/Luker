// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stats view: per-agent duration and failure figures over the runs this browser
// recorded. Tokens are only known per run, so they are shown per run.

import { h, clear, put } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat, agentName, modeInfo } from '../i18n.js';
import { agentStats } from '../model/stats.js';
import { formatDuration, formatTokens } from '../model/run.js';
import { statsEvidence } from '../model/ai.js';
import { emptyState, segmented, button, iconButton } from '../ui/components.js';
import { agentAvatar, toneOf } from './flow-view.js';

export function createStatsView(app) {
    const el = h('section', { class: 'ol-stats-view', 'aria-label': i18n('Stats') });
    let scope = 'chat';
    let source = 'orchestrator';

    function card(label, value, note = '') {
        return h('div', { class: 'ol-scard' },
            h('span', { class: 'ol-stat-label', text: label }),
            h('span', { class: 'ol-scard-value', text: value }),
            note ? h('span', { class: 'ol-scard-note', text: note }) : null);
    }

    function render() {
        clear(el);
        const chatId = app.snapshot()?.chatId || '';
        const all = app.recorder.history();
        // Agents differ per execution mode: count only runs of the mode on screen.
        const mode = app.snapshot()?.mode || '';
        const sameMode = (r) => source === 'search' || !mode || r.mode === mode || (mode === 'single' && r.mode === 'spec');
        const runs = (scope === 'chat' && chatId ? all.filter(r => r.chatId === chatId) : all).filter(sameMode);
        const knownIds = Object.keys(app.flow()?.agents || {});
        const stats = agentStats(runs, { knownIds, source });
        // Frozen into the AI session: later runs don't change what it was asked about.
        const diagnose = (focus = '') => {
            const views = runs.filter(r => (r.source || 'orchestrator') === source && r.status !== 'running' && !r.quiet).map(r => app.runViewOf(r));
            app.diagnoseStats({ stats, evidence: statsEvidence(stats, views, { focus }), mode: source === 'search' ? 'search' : mode, focus });
        };
        const canAi = Boolean(app.source?.ai) && source === 'orchestrator';
        put(el, h('div', { class: 'ol-history-head' },
            h('div', null,
                h('h2', { text: i18n('Stats') }),
                h('p', { class: 'ol-history-hint', text: `${i18n('Based on the recent runs recorded on this device')}${source === 'orchestrator' && mode ? i18nFormat(' (only "${0}" mode)', modeInfo(mode).label) : ''}${i18n('. Find the slowest and most error-prone agents and consider a faster model or shorter prompts.')}` })),
            h('span', { class: 'ol-spacer' }),
            canAi && stats.runs ? button(i18n('AI diagnosis'), () => diagnose(), { iconName: 'target', className: 'ol-btn-sm ol-btn-primary', title: i18n('Let the AI use the stats to find why the slowest and most error-prone agents behave that way, and fix them directly') }) : null,
            segmented([{ value: 'orchestrator', label: i18n('Orchestration') }, { value: 'search', label: i18n('Online search') }], source, (value) => { source = value; render(); }, { className: 'ol-seg-sm' }),
            segmented([{ value: 'chat', label: i18n('Current chat') }, { value: 'all', label: i18n('All chats') }], scope, (value) => { scope = value; render(); }, { className: 'ol-seg-sm' })));
        const body = h('div', { class: 'ol-stats-body' });
        put(el, body);
        if (!stats.runs) {
            put(body, emptyState('history', i18n('No runs to analyze yet'), i18n('Come back after a few orchestration runs.')));
            return;
        }
        const failRate = stats.failedRuns / stats.runs;
        put(body, h('div', { class: 'ol-scards' },
            card(i18n('Runs'), String(stats.runs)),
            card(i18n('Average time'), formatDuration(stats.avgDuration)),
            card(i18n('Errored'), stats.failedRuns ? i18nFormat('${0} times', stats.failedRuns) : i18n('No failures'), stats.failedRuns ? `${Math.round(failRate * 100)}%` : ''),
            stats.avgTokens ? card(i18n('Usage per run'), `${formatTokens(Math.round(stats.avgTokens))}`, i18n('tokens · average')) : null));

        const slowest = stats.agents.reduce((a, b) => (b.avg > (a?.avg ?? -1) ? b : a), null);
        const worst = stats.agents.filter(a => a.failed).sort((a, b) => b.failRate - a.failRate)[0];
        const maxAvg = Math.max(1, ...stats.agents.map(a => a.avg));
        put(body,
            h('div', { class: 'ol-stable', role: 'table', 'aria-label': i18n('Per agent') },
                h('div', { class: 'ol-srow is-head', role: 'row' },
                    h('span', { role: 'columnheader', text: i18n('Agent') }),
                    h('span', { role: 'columnheader', text: i18n('Average time') }),
                    h('span', { role: 'columnheader', class: 'ol-scol-num', text: i18n('Longest') }),
                    h('span', { role: 'columnheader', class: 'ol-scol-num', text: i18n('Appeared') }),
                    h('span', { role: 'columnheader', class: 'ol-scol-num', text: i18n('Errored') }),
                    h('span', { role: 'columnheader', class: 'ol-scol-num', title: i18n('Share of all agents\' working time (parallel work all counts)'), text: i18n('Time share') }),
                    h('span', { role: 'columnheader' })),
                stats.agents.map(a => h('button', {
                    type: 'button',
                    class: 'ol-srow',
                    role: 'row',
                    dataset: { tone: toneOf(a.agentId) },
                    title: a.lastError ? i18nFormat('Last error: ${0}', a.lastError) : null,
                    onClick: () => { app.setState({ view: 'flow' }); app.selectAgent(a.agentId); },
                },
                h('span', { class: 'ol-scol-agent', role: 'cell' },
                    agentAvatar(a.agentId, { size: 'sm' }),
                    h('span', { class: 'ol-lane-name', text: agentName(a.agentId) }),
                    a === slowest && stats.agents.length > 1 ? h('span', { class: 'ol-stag is-slow', text: i18n('Slowest') }) : null,
                    a === worst ? h('span', { class: 'ol-stag is-bad', text: i18n('Most errors') }) : null),
                h('span', { class: 'ol-scol-bar', role: 'cell' },
                    h('span', { class: 'ol-sbar' }, h('span', { style: { width: `${Math.max(2, (a.avg / maxAvg) * 100)}%` } })),
                    h('span', { class: 'ol-sbar-text', text: formatDuration(a.avg) })),
                h('span', { class: 'ol-scol-num', role: 'cell', text: formatDuration(a.max) }),
                h('span', { class: 'ol-scol-num', role: 'cell', text: a.steps > a.runs ? i18nFormat('${0} times · ${1} segments', a.runs, a.steps) : i18nFormat('${0} times', a.runs) }),
                h('span', { class: `ol-scol-num${a.failed ? ' is-bad' : ''}`, role: 'cell', text: a.failed ? i18nFormat('${0} (${1}%)', a.failed, Math.round(a.failRate * 100)) : '—' }),
                h('span', { class: 'ol-scol-num', role: 'cell', text: `${Math.round(a.share * 100)}%` }),
                h('span', { class: 'ol-scol-act', role: 'cell' }, canAi ? iconButton('target', i18nFormat('AI diagnosis of "${0}"', agentName(a.agentId)), (event) => { event.stopPropagation(); diagnose(a.agentId); }, { className: 'ol-iconbtn-sm' }) : null)))),
            h('p', { class: 'ol-stats-note' }, icon('alert', { size: 12 }), h('span', { text: i18n('Tokens are only recorded per run and cannot be split by agent. Click a row to view and edit that agent\'s settings; click the target on the right to have the AI diagnose it alone.') })));
    }

    return { id: 'stats', el, render };
}
