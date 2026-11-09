// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Command palette (Ctrl/⌘ K): fuzzy node search + a few commands, fully
// keyboard driven, rendered as an ARIA combobox/listbox.

import { h, clear, put } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat, typeLabel } from '../i18n.js';
import { searchNodes, formatFloor } from '../model.js';
import { typeDot, highlight, kbd, contextBadge, iconButton, isTouch } from '../ui/components.js';
import { contextState } from '../model.js';

export function createPalette(app) {
    const listId = `ml-palette-list-${Math.random().toString(36).slice(2, 8)}`;
    const input = h('input', {
        type: 'text',
        class: 'ml-palette-input',
        placeholder: i18n('Search nodes, characters, events…'),
        autocomplete: 'off',
        spellcheck: 'false',
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-controls': listId,
        'aria-autocomplete': 'list',
        'aria-label': i18n('Search'),
    });
    const list = h('div', { class: 'ml-palette-list', id: listId, role: 'listbox' });
    const footer = h('div', { class: 'ml-palette-foot' },
        h('span', null, kbd('↑', '↓'), ' '),
        h('span', null, kbd('Enter'), ' '),
        h('span', null, kbd('Esc')));
    const panel = h('div', { class: 'ml-palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': i18n('Search') },
        h('div', { class: 'ml-palette-field' }, icon('search', { size: 18 }), input,
            isTouch() ? iconButton('x', i18n('Close'), () => close(), { className: 'ml-iconbtn-sm' }) : kbd('Esc')),
        list,
        footer);
    const el = h('div', { class: 'ml-palette-backdrop', hidden: true, onMousedown: (event) => { if (event.target === el) close(); } }, panel);

    let items = [];
    let active = 0;
    let returnFocus = null;

    function commands() {
        const views = [
            { id: 'graph', label: i18n('Graph'), icon: 'graph' },
            { id: 'timeline', label: i18n('Timeline'), icon: 'timeline' },
            { id: 'table', label: i18n('Data table'), icon: 'table' },
            { id: 'settings', label: i18n('Settings'), icon: 'gear' },
        ];
        return [
            ...views.filter(v => v.id !== app.state().view).map(v => ({ kind: 'cmd', icon: v.icon, label: i18nFormat('Switch to ${0}', v.label), run: () => app.setState({ view: v.id }) })),
            { kind: 'cmd', icon: app.state().theme === 'dark' ? 'sun' : 'moon', label: i18n('Toggle light/dark theme'), run: () => app.toggleTheme() },
            { kind: 'cmd', icon: 'refresh', label: i18n('Reload memory'), run: () => app.reload() },
            { kind: 'cmd', icon: 'fit', label: i18n('Fit graph to window'), run: () => { app.setState({ view: 'graph' }); app.fitGraph(); } },
        ];
    }

    function compute() {
        const query = input.value;
        const model = app.model();
        const hits = model ? searchNodes(model, query, { limit: 40 }) : [];
        const q = query.trim().toLowerCase();
        const cmds = commands().filter(cmd => !q || cmd.label.toLowerCase().includes(q));
        if (!q && model) {
            const recent = [...model.nodes.values()]
                .filter(node => node.type !== 'event' && !node.archived)
                .sort((a, b) => b.degree - a.degree)
                .slice(0, 8)
                .map(node => ({ node, snippet: '' }));
            items = [
                ...cmds.map(cmd => ({ ...cmd, group: i18n('Quick commands') })),
                ...recent.map(hit => ({ kind: 'node', ...hit, group: i18n('Node results') })),
            ];
        } else {
            items = [
                ...hits.map(hit => ({ kind: 'node', ...hit, group: i18n('Node results') })),
                ...cmds.map(cmd => ({ ...cmd, group: i18n('Quick commands') })),
            ];
        }
        active = Math.min(active, Math.max(0, items.length - 1));
        renderList(query);
        app.setMatches(q ? new Set(hits.map(hit => hit.node.id)) : null);
    }

    function renderList(query) {
        clear(list);
        if (!items.length) {
            put(list, h('div', { class: 'ml-palette-empty', text: i18n('No matching results') }));
            input.removeAttribute('aria-activedescendant');
            return;
        }
        let group = '';
        items.forEach((item, index) => {
            if (item.group !== group) {
                group = item.group;
                put(list, h('div', { class: 'ml-palette-group', role: 'presentation', text: group }));
            }
            const id = `${listId}-${index}`;
            const option = h('div', {
                id,
                role: 'option',
                class: 'ml-palette-item',
                'aria-selected': String(index === active),
                onMousemove: () => { if (active !== index) { active = index; syncActive(); } },
                onClick: () => choose(index),
            });
            if (item.kind === 'node') {
                const node = item.node;
                put(option,
                    h('span', { class: 'ml-palette-icon' }, typeDot(node.type, { size: 10 })),
                    h('span', { class: 'ml-palette-main' },
                        h('span', { class: 'ml-palette-title' }, highlight(node.title, query)),
                        item.snippet ? h('span', { class: 'ml-palette-snippet' }, highlight(item.snippet, query)) : null),
                    contextBadge(contextState(app.model(), node.id)),
                    h('span', { class: 'ml-palette-meta', text: `${typeLabel(node.type)}${formatFloor(node) ? ` · ${formatFloor(node)}` : ''}` }));
            } else {
                put(option,
                    h('span', { class: 'ml-palette-icon' }, icon(item.icon, { size: 15 })),
                    h('span', { class: 'ml-palette-main' }, h('span', { class: 'ml-palette-title', text: item.label })));
            }
            put(list, option);
        });
        syncActive();
    }

    function syncActive() {
        const options = list.querySelectorAll('[role="option"]');
        options.forEach((option, index) => option.setAttribute('aria-selected', String(index === active)));
        const current = options[active];
        if (current) {
            input.setAttribute('aria-activedescendant', current.id);
            current.scrollIntoView({ block: 'nearest' });
        }
    }

    function choose(index) {
        const item = items[index];
        if (!item) return;
        const keepMatches = item.kind === 'node';
        close({ keepMatches });
        if (item.kind === 'node') {
            app.select(item.node.id);
            app.locate(item.node.id);
        } else {
            item.run();
        }
    }

    input.addEventListener('input', () => { active = 0; compute(); });
    input.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); active = (active + 1) % Math.max(1, items.length); syncActive(); } else if (event.key === 'ArrowUp') { event.preventDefault(); active = (active - 1 + items.length) % Math.max(1, items.length); syncActive(); } else if (event.key === 'Enter') { event.preventDefault(); choose(active); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } else if (event.key === 'Tab') { event.preventDefault(); }
    });

    function open(initial = '') {
        returnFocus = document.activeElement;
        el.hidden = false;
        input.value = initial;
        active = 0;
        compute();
        requestAnimationFrame(() => { input.focus(); input.select(); });
    }

    function close({ keepMatches = false } = {}) {
        if (el.hidden) return;
        el.hidden = true;
        if (!keepMatches) app.setMatches(null);
        if (returnFocus && typeof returnFocus.focus === 'function' && returnFocus.isConnected) returnFocus.focus();
    }

    return { el, open, close, isOpen: () => !el.hidden };
}
