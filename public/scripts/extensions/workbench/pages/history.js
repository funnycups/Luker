// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Change history: a timeline of everything applied from the workbench, filterable
// by workbench, each entry undoable while this page load still holds its
// undo function.

import { i18n, i18nFormat } from '../i18n.js';
import { h, put, clear, relativeTime } from '../../lens-shared/util.js';
import { button } from '../ui/components.js';

const NAMES = { memory: i18n('Memory graph'), orch: i18n('Orchestration'), preset: i18n('Preset'), card: i18n('Character card'), world: i18n('World book') };

export function createHistoryPage(app) {
    const el = h('div', { class: 'wb-page' });
    let filter = '';

    function paint() {
        clear(el);
        const list = app.history.list().filter(e => !filter || e.ws === filter);
        put(el,
            h('div', null, h('h2', { class: 'wb-h2', text: i18n('Change history') }), h('p', { class: 'wb-sub', text: i18n('Everything applied from the workbench. Each entry can be undone on its own (until the page is reloaded).') })),
            h('div', { class: 'wb-filters' },
                [['', i18n('All')], ...Object.entries(NAMES)].map(([k, n]) => h('button', { type: 'button', class: 'wb-chip', 'aria-pressed': String(filter === k), onClick: () => { filter = k; paint(); } }, n))));
        if (!list.length) {
            put(el, h('p', { class: 'wb-note', text: filter ? i18n('No changes for this workbench yet.') : i18n('No changes yet. Changes applied in AI iteration or through a suggestion button are recorded here.') }));
            return;
        }
        put(el, h('div', { class: 'wb-hist' }, list.map(e => h('div', { class: `wb-hist-item ${e.undone ? 'is-undone' : ''}`, style: { '--tone': `var(--wb-t-${e.ws})` } },
            h('span', { class: 'wb-hist-dot', 'aria-hidden': 'true' }),
            h('div', { class: 'wb-hist-card' },
                h('div', { class: 'wb-hist-top' },
                    h('div', { class: 'wb-hist-title', text: e.title }),
                    e.undone ? h('span', { class: 'wb-note', text: i18n('Undone') })
                        : app.history.canUndo(e.id) ? button(i18n('Undo'), () => undo(e), { iconName: 'undo', className: 'is-ghost is-sm' }) : null),
                h('div', { class: 'wb-note', text: [NAMES[e.ws], e.scope, relativeTime(e.at), i18nFormat('From ${0}', e.from)].filter(Boolean).join(' · ') }),
                e.lines?.length ? h('ul', { class: 'wb-hist-lines' }, e.lines.slice(0, 8).map(l => h('li', { text: l })), e.lines.length > 8 ? h('li', { text: i18nFormat('…${0} more', e.lines.length - 8) }) : null) : null)))));
    }

    async function undo(e) {
        try {
            await app.history.undo(e.id);
            app.toast(i18n('Undone'));
            app.reload();
        } catch (err) {
            app.toast(i18nFormat('Could not undo: ${0}', err?.message || err), { error: true });
        }
        paint();
    }

    app.history.subscribe(() => { if (el.isConnected) paint(); });
    return { el, show: paint };
}
