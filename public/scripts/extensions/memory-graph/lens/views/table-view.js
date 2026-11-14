// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Table view: one schema-driven table per node type with sorting and a
// sticky header. Desktop shows real tables; narrow screens switch to cards
// via CSS (each cell carries a data-label).

import { editable } from '../edit/inline-edit.js';
import { h, clear, truncate, put } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, typeLabel, fieldLabel, depthLabel } from '../i18n.js';
import { nodePassesFilters, contextState, formatFloor, fieldText, compareTimeline } from '../model.js';
import { segmented, contextBadge, emptyState, typeDot, isTouch } from '../ui/components.js';

const PAGE = 200;

export function createTableView(app) {
    const head = h('div', { class: 'ml-table-head' });
    const scroller = h('div', { class: 'ml-table-scroll' });
    const root = h('div', { class: 'ml-tableview' }, head, scroller);
    let activeType = '';
    let sort = { key: 'seq', dir: 'desc' };
    let limit = PAGE;
    const rows = new Map();

    function columnsFor(model, type) {
        const schema = model.schemaColumns.get(type);
        let cols = schema?.length ? schema.slice() : [];
        if (!cols.length) {
            const keys = new Set();
            for (const node of model.nodes.values()) {
                if (node.type === type) Object.keys(node.fields).forEach(key => keys.add(key));
            }
            cols = [...keys];
        }
        cols = cols.filter(col => col !== 'title');
        return cols.slice(0, type === 'event' ? 1 : 5);
    }

    function sortValue(node, key) {
        if (key === 'seq') return node.seqTo;
        if (key === 'title') return node.title.toLowerCase();
        if (key === 'degree') return node.degree;
        return fieldText(node.fields[key]).toLowerCase();
    }

    function headerCell(label, key) {
        const active = sort.key === key;
        return h('th', { scope: 'col', 'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
            h('button', {
                type: 'button',
                class: 'ml-th-btn',
                onClick: () => {
                    sort = active ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'title' ? 'asc' : 'desc' };
                    render();
                },
            }, h('span', { text: label }), active ? icon(sort.dir === 'asc' ? 'chevronDown' : 'chevronDown', { size: 12, className: sort.dir === 'asc' ? 'is-flipped' : '' }) : null));
    }

    function render() {
        const model = app.model();
        if (!model) return;
        const state = app.state();
        const available = model.typeList.filter(type => !state.filters.hiddenTypes.has(type));
        if (!available.includes(activeType)) activeType = available[0] || '';
        clear(head);
        clear(scroller);
        rows.clear();
        if (!activeType) {
            put(scroller, emptyState('table', model.nodes.size ? i18n('No nodes match the current filters.') : i18n('This chat has no memory nodes yet.')));
            return;
        }
        if (app.canEdit?.() && isTouch()) put(head, h('p', { class: 'ml-table-touchhint', text: i18n('Open an entry, then tap its contents in the details to edit') }));
        put(head, segmented(available.map(type => ({
            value: type,
            label: typeLabel(type),
            badge: model.typeCounts.get(type) || 0,
        })), activeType, (value) => { activeType = value; limit = PAGE; render(); }, { className: 'ml-seg-sm ml-seg-scroll' }));

        const nodes = [...model.nodes.values()]
            .filter(node => node.type === activeType && nodePassesFilters(model, node, state.filters));
        const dir = sort.dir === 'asc' ? 1 : -1;
        nodes.sort((a, b) => {
            const av = sortValue(a, sort.key);
            const bv = sortValue(b, sort.key);
            if (av < bv) return -dir;
            if (av > bv) return dir;
            return compareTimeline(a, b) * -1;
        });
        if (!nodes.length) {
            put(scroller, emptyState('filter', i18n('No nodes match the current filters.')));
            return;
        }
        const cols = columnsFor(model, activeType);
        const isEvent = activeType === 'event';
        const thead = h('thead', null, h('tr', null,
            headerCell(i18n('Name'), 'title'),
            cols.map(col => headerCell(fieldLabel(col, activeType), col)),
            headerCell(isEvent ? i18n('Floor') : i18n('Link count'), isEvent ? 'seq' : 'degree'),
            h('th', { scope: 'col', class: 'ml-th-ctx' }, h('span', { class: 'ml-sr', text: i18n('Current AI memory') }))));
        const tbody = h('tbody');
        for (const node of nodes.slice(0, limit)) {
            const ctx = contextState(model, node.id);
            const row = h('tr', {
                tabIndex: 0,
                class: node.archived ? 'is-archived' : null,
                'aria-selected': String(state.selectedId === node.id),
                dataset: { id: node.id },
                onClick: () => app.select(node.id),
                onKeydown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        app.select(node.id);
                    }
                },
            },
            h('td', { class: 'ml-td-title', 'data-label': i18n('Name') },
                h('span', { class: 'ml-td-title-inner' }, typeDot(node.type, { size: 8 }),
                    isEvent ? h('span', { text: node.title }) : editable(h('span', { text: node.title }), node.fields.title !== undefined
                        ? { app, node, key: 'title', value: node.fields.title, label: i18n('Name') }
                        : { app, node, key: '', value: node.rawTitle || node.title, label: i18n('Name') }),
                    node.isRollup ? h('span', { class: 'ml-tl-tag', text: depthLabel(node.depth) }) : null)),
            cols.map(col => {
                const value = isEvent && col === 'summary'
                    ? (node.parsed?.prose[0] || node.summaryText)
                    : fieldText(node.fields[col]);
                return editable(h('td', { 'data-label': fieldLabel(col, activeType), class: value ? null : 'is-empty', text: value ? truncate(value, isEvent ? 160 : 90) : '—' }),
                    { app, node, key: col, value: node.fields[col], label: fieldLabel(col, activeType) });
            }),
            h('td', { class: 'ml-td-num', 'data-label': isEvent ? i18n('Floor') : i18n('Link count'), text: isEvent ? (formatFloor(node) || '—') : String(node.degree) }),
            h('td', { class: 'ml-td-ctx' }, contextBadge(ctx)));
            rows.set(node.id, row);
            put(tbody, row);
        }
        put(scroller, h('table', { class: 'ml-table' }, thead, tbody));
        if (nodes.length > limit) {
            put(scroller, h('button', { type: 'button', class: 'ml-btn ml-table-more', onClick: () => { limit += PAGE; render(); } }, h('span', { text: `${i18n('Show more')} (${nodes.length - limit})` })));
        }
    }

    function syncSelection() {
        const { selectedId } = app.state();
        for (const [id, row] of rows) row.setAttribute('aria-selected', String(id === selectedId));
        const node = app.model()?.nodes.get(selectedId);
        if (node && node.type !== activeType && !app.state().filters.hiddenTypes.has(node.type)) {
            activeType = node.type;
            render();
        }
        rows.get(selectedId)?.scrollIntoView({ block: 'nearest' });
    }

    return {
        id: 'table',
        el: root,
        render,
        onSelectionChange: syncSelection,
    };
}
