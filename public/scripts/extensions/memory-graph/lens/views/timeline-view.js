// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Timeline view: the story read top-to-bottom. Top-level summaries become
// collapsible chapters; raw events sit on a rail inside them with time /
// place chips and the characters and locations they involve.

import { h, clear, truncate, put } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat, depthLabel } from '../i18n.js';
import { buildChapters, entitiesOfEvent, contextState, formatFloor, isDefaultFilters } from '../model.js';
import { contextBadge, emptyState, nodeLink, segmented, button } from '../ui/components.js';

const LOOSE_PAGE = 80;

export function createTimelineView(app) {
    const head = h('div', { class: 'ml-tl-head' });
    const scroller = h('div', { class: 'ml-tl-scroll', tabIndex: -1 });
    const root = h('div', { class: 'ml-timeline' }, head, scroller);
    const collapsed = new Set();
    let looseLimit = LOOSE_PAGE;
    const cards = new Map();

    function eventCard(model, node, { nested = false } = {}) {
        const parsed = node.parsed || { time: '', place: '', prose: [] };
        const { characters, locations } = entitiesOfEvent(model, node.id);
        const ctx = contextState(model, node.id);
        const selected = app.state().selectedId === node.id;
        const prose = parsed.prose[0] || node.summaryText;
        const card = h('article', {
            class: `ml-tl-card ${nested ? 'is-nested' : ''} ${node.isRollup ? 'is-rollup' : ''} ${node.archived ? 'is-archived' : ''}`.trim(),
            tabIndex: 0,
            'aria-selected': String(selected),
            dataset: { id: node.id, ctx: ctx || 'none' },
            onClick: () => app.select(node.id),
            onKeydown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    app.select(node.id);
                }
            },
        },
        h('div', { class: 'ml-tl-meta' },
            h('span', { class: 'ml-tl-floor', text: formatFloor(node) || '—' }),
            node.isRollup ? h('span', { class: 'ml-tl-tag', text: depthLabel(node.depth) }) : null,
            parsed.time ? h('span', { class: 'ml-chip' }, icon('clock', { size: 12 }), h('span', { text: parsed.time })) : null,
            parsed.place ? h('span', { class: 'ml-chip' }, icon('mapPin', { size: 12 }), h('span', { text: parsed.place })) : null,
            h('span', { class: 'ml-spacer' }),
            contextBadge(ctx)),
        h('h4', { class: 'ml-tl-title', text: node.title }),
        prose && prose !== node.title ? h('p', { class: 'ml-tl-prose', text: truncate(prose, node.isRollup ? 220 : 180) }) : null,
        (characters.length || locations.length)
            ? h('div', { class: 'ml-tl-entities' },
                characters.slice(0, 6).map(entity => nodeLink(entity, app.select, { compact: true })),
                locations.slice(0, 3).map(entity => nodeLink(entity, app.select, { compact: true })),
                characters.length > 6 ? h('span', { class: 'ml-more', text: `+${characters.length - 6}` }) : null)
            : null);
        cards.set(node.id, card);
        return card;
    }

    function renderTree(model, tree, depth = 0) {
        const { node, children } = tree;
        if (!node.isRollup) return eventCard(model, node, { nested: depth > 0 });
        const isCollapsed = collapsed.has(node.id);
        const toggle = h('button', {
            type: 'button',
            class: 'ml-tl-toggle',
            'aria-expanded': String(!isCollapsed),
            'aria-label': node.title,
            onClick: (event) => {
                event.stopPropagation();
                if (collapsed.has(node.id)) collapsed.delete(node.id);
                else collapsed.add(node.id);
                render();
            },
        }, icon('chevronDown', { size: 14 }));
        const header = h('div', { class: 'ml-tl-chapter-head' }, toggle, eventCard(model, node, { nested: depth > 0 }));
        const leafCount = h('span', { class: 'ml-tl-count', text: i18nFormat('${0} items', tree.leafCount) });
        put(header, leafCount);
        const ordered = app.state().timelineOrder === 'desc' ? [...children].reverse() : children;
        const body = isCollapsed ? null : h('div', { class: 'ml-tl-chapter-body' }, ordered.map(child => renderTree(model, child, depth + 1)));
        return h('section', { class: `ml-tl-chapter depth-${Math.min(depth, 3)} ${isCollapsed ? 'is-collapsed' : ''}`.trim() }, header, body);
    }

    function renderHead(model) {
        const state = app.state();
        clear(head);
        const focus = state.filters.focusEntityId ? model.nodes.get(state.filters.focusEntityId) : null;
        put(head,
            segmented([
                { value: 'asc', label: i18n('Oldest first') },
                { value: 'desc', label: i18n('Newest first') },
            ], state.timelineOrder, (value) => app.setState({ timelineOrder: value }), { className: 'ml-seg-sm' }),
            focus
                ? h('div', { class: 'ml-focuspill' },
                    icon('target', { size: 13 }),
                    h('span', { text: i18nFormat('Only events related to "${0}"', focus.title) }),
                    h('button', { type: 'button', class: 'ml-focuspill-x', 'aria-label': i18n('Clear focus'), onClick: () => app.setFilter({ focusEntityId: '' }) }, icon('x', { size: 12 })))
                : null,
        );
    }

    function render() {
        const model = app.model();
        if (!model) return;
        const state = app.state();
        cards.clear();
        renderHead(model);
        const { chapters, loose } = buildChapters(model, state.filters);
        clear(scroller);
        if (!chapters.length && !loose.length) {
            const hasEvents = model.typeCounts.get('event') > 0;
            put(scroller, hasEvents
                ? emptyState('filter', i18n('No nodes match the current filters.'), '', isDefaultFilters(state.filters) ? null : button(i18n('Reset filters'), () => app.resetFilters(), { iconName: 'refresh' }))
                : emptyState('timeline', i18n('This chat has no memory nodes yet.'), i18n('The memory graph extracts them automatically as the conversation goes on.')));
            return;
        }
        const desc = state.timelineOrder === 'desc';
        const blocks = [];
        const orderedChapters = desc ? [...chapters].reverse() : chapters;
        for (const chapter of orderedChapters) blocks.push(renderTree(model, chapter));
        if (loose.length) {
            const orderedLoose = desc ? [...loose].reverse() : loose;
            const shown = orderedLoose.slice(0, looseLimit);
            const section = h('section', { class: 'ml-tl-chapter is-loose' },
                h('div', { class: 'ml-tl-loose-head' }, icon('sparkle', { size: 14 }), h('span', { text: i18n('Not in a summary') }), h('span', { class: 'ml-tl-count', text: i18nFormat('${0} items', loose.length) })),
                h('div', { class: 'ml-tl-chapter-body' }, shown.map(tree => renderTree(model, tree, 1))),
                loose.length > shown.length
                    ? button(i18n('Show more'), () => { looseLimit += LOOSE_PAGE; render(); }, { className: 'ml-tl-more' })
                    : null);
            if (desc) blocks.unshift(section);
            else blocks.push(section);
        }
        put(scroller, h('div', { class: 'ml-tl-rail' }, blocks));
        syncSelection(false);
    }

    function syncSelection(scroll = true) {
        const { selectedId } = app.state();
        for (const [id, card] of cards) card.setAttribute('aria-selected', String(id === selectedId));
        if (!scroll || !selectedId) return;
        let card = cards.get(selectedId);
        if (!card) {
            // A collapsed ancestor may hide it: expand the chain and re-render.
            const model = app.model();
            let parentId = model?.nodes.get(selectedId)?.parentId;
            let expanded = false;
            while (parentId) {
                if (collapsed.delete(parentId)) expanded = true;
                parentId = model.nodes.get(parentId)?.parentId;
            }
            if (expanded) {
                render();
                card = cards.get(selectedId);
            }
        }
        card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    return {
        id: 'timeline',
        el: root,
        render,
        onSelectionChange: () => syncSelection(true),
        locate: (id) => syncSelection(true, id),
    };
}
