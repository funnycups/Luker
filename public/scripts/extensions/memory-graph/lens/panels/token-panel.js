// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Token counter stats (opened from the sidebar's injected tokens row).

import { h, formatTime, formatTokens } from '../../../lens-shared/util.js';
import { i18n, i18nFormat } from '../i18n.js';
import { button } from '../ui/components.js';
import { summarize } from '../token-stats.js';

const RECENT = 20;

/** Content for the stats dialog. */
export function tokenPanel(model, { onClear = null } = {}) {
    const tokens = model?.tokens || { current: null, entries: [] };
    const cur = tokens.current;
    const entries = tokens.entries || [];
    const sum = summarize(entries);
    const num = (n) => h('b', { class: 'ml-tok-num', text: formatTokens(n), title: String(n) });

    const big = (label, value, tone = '') => h('div', { class: 'ml-tok-cell', dataset: { tone } },
        h('span', { class: 'ml-tok-label' }, tone ? h('span', { class: 'ml-tok-dot', 'aria-hidden': 'true' }) : null, h('span', { text: label })),
        num(value));

    const nowRow = h('div', { class: 'ml-tok-grid' },
        big(i18n('Total this time'), cur ? cur.core + cur.focus : 0),
        big(i18n('Recalled this time'), cur?.focus || 0, 'focus'),
        big(i18n('Always injected'), cur?.core || 0, 'core'));
    const histRow = h('div', { class: 'ml-tok-grid' },
        big(i18n('Total so far'), sum.total),
        big(i18n('Average per run'), sum.avg),
        big(i18n('Largest run'), sum.max));

    return h('div', { class: 'ml-tok' },
        h('p', { class: 'ml-tok-when', text: cur ? `${i18n('Last recall')} · ${formatTime(cur.at)}` : i18n('This chat has not recalled anything yet') }),
        nowRow,
        h('div', { class: 'ml-tok-sub' },
            h('span', { text: `${i18n('Recorded')} ${i18nFormat('${0} runs', sum.count)}` }),
            sum.count ? h('span', { text: `${i18n('Recalled')} ${formatTokens(sum.avgFocus)} + ${i18n('Pinned entries')} ${formatTokens(sum.avgCore)}${i18n(' / run')}` }) : null),
        histRow,
        entries.length ? chart(entries.slice(-RECENT)) : h('p', { class: 'ml-tok-empty', text: i18n('Nothing recorded yet. One entry is added for every reply generated from now on.') }),
        h('p', { class: 'ml-tok-note', text: i18n('Counts the text the memory graph puts into the prompt, using the current model\'s tokenizer; requests made by recall itself are not included. Regenerating the same floor only counts the last run. The record stays with this chat.') }),
        onClear && entries.length ? button(i18n('Clear records'), onClear, { iconName: 'trash', className: 'ml-btn-ghost ml-btn-sm ml-tok-clear' }) : null);
}

/** Stacked bars: core (blue) under focus (amber), newest on the right. */
function chart(list) {
    const max = Math.max(1, ...list.map(e => e.core + e.focus));
    return h('figure', { class: 'ml-tok-chart' },
        h('figcaption', { class: 'ml-tok-chart-head' },
            h('span', { text: i18nFormat('Last ${0} runs', list.length) }),
            h('span', { class: 'ml-tok-legend' },
                h('span', { dataset: { tone: 'focus' } }, h('span', { class: 'ml-tok-dot', 'aria-hidden': 'true' }), i18n('Recalled')),
                h('span', { dataset: { tone: 'core' } }, h('span', { class: 'ml-tok-dot', 'aria-hidden': 'true' }), i18n('Pinned entries')))),
        h('div', { class: 'ml-tok-bars', role: 'img', 'aria-label': i18nFormat('Last ${0} runs', list.length) },
            list.map(e => {
                const total = e.core + e.focus;
                return h('div', {
                    class: 'ml-tok-bar',
                    title: `${e.floor >= 0 ? `#${e.floor} · ` : ''}${formatTime(e.at)}\n${i18n('Recalled')} ${e.focus} · ${i18n('Pinned entries')} ${e.core}`,
                    style: { height: `${Math.max(3, (total / max) * 100)}%` },
                },
                h('span', { class: 'ml-tok-bar-focus', style: { flexGrow: String(e.focus || 0) } }),
                h('span', { class: 'ml-tok-bar-core', style: { flexGrow: String(e.core || 0) } }));
            })));
}
