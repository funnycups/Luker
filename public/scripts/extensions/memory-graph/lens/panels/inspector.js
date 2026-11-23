// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Right inspector: reads a node like a document. Events show their parsed
// summary (time/place, prose, irreversible changes, open threads, quotes);
// entities show their fields and grouped relations.

import { h, clear, copyText, put } from '../../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, typeLabel, relationLabel, fieldLabel, depthLabel } from '../i18n.js';
import { neighborsOf, entitiesOfEvent, eventsOfEntity, contextState, formatFloor, fieldText, compareTimeline, typeVisual } from '../model.js';
import { iconButton, nodeLink, contextBadge, sectionTitle, typeChip, emptyState, button, isTouch, withMod } from '../ui/components.js';
import { editable } from '../edit/inline-edit.js';
import { confirmDeleteNode, openEdgeManager, openNodeProperties } from '../edit/node-forms.js';

const EVENT_PREVIEW_LIMIT = 12;

export function createInspector(app) {
    const body = h('div', { class: 'ml-inspector-body' });
    const el = h('aside', { class: 'ml-inspector', 'aria-label': i18n('Details') }, body);
    const history = [];
    const expandedEvents = new Set();
    let lastChatKey = '';
    let lastRenderedId = '';

    function block(title, ...content) {
        const items = content.flat().filter(Boolean);
        if (!items.length) return null;
        return h('section', { class: 'ml-insp-block' }, sectionTitle(title), items);
    }

    function threadLink(model, title) {
        const match = [...model.nodes.values()].find(node => node.type === 'thread' && node.title === title);
        return match ? nodeLink(match, select) : h('span', { class: 'ml-insp-muted', text: title });
    }

    function eventBody(model, node) {
        const parsed = node.parsed || { time: '', place: '', prose: [node.summaryText], irreversible: [], open: [], quotes: [] };
        const { characters, locations, threads } = entitiesOfEvent(model, node.id);
        const parent = node.parentId ? model.nodes.get(node.parentId) : null;
        const children = node.childrenIds.map(id => model.nodes.get(id)).filter(Boolean).sort(compareTimeline);
        return [
            (parsed.time || parsed.place)
                ? h('div', { class: 'ml-insp-anchors' },
                    parsed.time ? h('div', { class: 'ml-insp-anchor' }, icon('clock', { size: 14 }), h('span', { class: 'ml-insp-anchor-label', text: i18n('Time') }), h('span', { text: parsed.time })) : null,
                    parsed.place ? h('div', { class: 'ml-insp-anchor' }, icon('mapPin', { size: 14 }), h('span', { class: 'ml-insp-anchor-label', text: i18n('Place') }), h('span', { text: parsed.place })) : null)
                : null,
            editable(h('div', { class: 'ml-insp-prose' }, parsed.prose.length ? parsed.prose.map(p => h('p', { text: p })) : h('p', { class: 'ml-insp-muted', text: i18n('(empty)') })),
                { app, node, key: 'summary', value: node.fields.summary ?? node.summaryText, label: fieldLabel('summary', node.type) }),
            parsed.irreversible.length
                ? h('section', { class: 'ml-insp-callout', dataset: { kind: 'irreversible' } },
                    h('div', { class: 'ml-insp-callout-title' }, icon('bolt', { size: 14 }), h('span', { text: i18n('Irreversible') })),
                    h('ul', null, parsed.irreversible.map(item => h('li', { text: item }))))
                : null,
            parsed.open.length
                ? h('section', { class: 'ml-insp-callout', dataset: { kind: 'open' } },
                    h('div', { class: 'ml-insp-callout-title' }, icon('thread', { size: 14 }), h('span', { text: i18n('Unresolved') })),
                    h('ul', null, parsed.open.map(item => h('li', null, item.threadTitle ? threadLink(model, item.threadTitle) : item.text))))
                : null,
            parsed.quotes.length
                ? h('section', { class: 'ml-insp-quotes' },
                    sectionTitle(i18n('Quotes from the text')),
                    parsed.quotes.map(item => h('figure', { class: 'ml-insp-quote' },
                        h('blockquote', { text: item.quote }),
                        item.label ? h('figcaption', { text: item.label }) : null)))
                : null,
            block(i18n('Characters involved'), characters.map(c => nodeLink(c, select))),
            block(i18n('Locations'), locations.map(c => nodeLink(c, select))),
            threads.length ? block(typeLabel('thread'), threads.map(c => nodeLink(c, select))) : null,
            (parent || children.length)
                ? block(i18n('Hierarchy'),
                    parent ? h('div', { class: 'ml-insp-sub', text: i18n('Parent summary') }) : null,
                    parent ? nodeLink(parent, select, { meta: depthLabel(parent.depth) }) : null,
                    children.length ? h('div', { class: 'ml-insp-sub', text: `${i18n('Child events')} · ${children.length}` }) : null,
                    children.length ? h('div', { class: 'ml-insp-children' }, children.map(child => nodeLink(child, select, { meta: formatFloor(child) }))) : null)
                : null,
        ];
    }

    function entityBody(model, node) {
        const columns = model.schemaColumns.get(node.type) || Object.keys(node.fields);
        const editing = app.canEdit();
        const keys = [...new Set([...columns, ...Object.keys(node.fields)])]
            .filter(key => key !== 'title' && (fieldText(node.fields[key]).trim() || (editing && columns.includes(key))));
        const groups = new Map();
        for (const item of neighborsOf(model, node.id)) {
            if (item.node.type === 'event') continue;
            const key = item.edge.type;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        }
        const events = eventsOfEntity(model, node.id);
        const showAllEvents = expandedEvents.has(node.id);
        const visibleEvents = (showAllEvents ? events : events.slice(-EVENT_PREVIEW_LIMIT)).slice().reverse();
        const hiddenEventCount = events.length - visibleEvents.length;
        const fieldList = keys.length
            ? h('dl', { class: 'ml-insp-fields' }, keys.map(key => [
                h('dt', { text: fieldLabel(key, node.type) }),
                editable(h('dd', { class: fieldText(node.fields[key]).trim() ? null : 'is-empty', text: fieldText(node.fields[key]) || (isTouch() ? i18n('Not filled in (tap to fill)') : i18n('Not filled in (double-click to fill)')) }),
                    { app, node, key, value: node.fields[key], label: fieldLabel(key, node.type) }),
            ]))
            : null;
        const relationBlocks = [...groups.entries()].map(([type, items]) => h('div', { class: 'ml-insp-relgroup', dataset: { category: items[0].edge.category } },
            h('div', { class: 'ml-insp-reltitle' }, h('span', { class: 'ml-insp-relbar', 'aria-hidden': 'true' }), h('span', { text: relationLabel(type) }), h('span', { class: 'ml-insp-count', text: String(items.length) })),
            h('div', { class: 'ml-insp-rellist' }, items.map(item => nodeLink(item.node, select, { meta: item.direction === 'in' ? '←' : item.direction === 'out' ? '→' : '' })))));
        return [
            block(i18n('Record items'), fieldList),
            relationBlocks.length ? block(i18n('Relationships'), relationBlocks) : null,
            events.length
                ? h('section', { class: 'ml-insp-block' },
                    sectionTitle(`${i18n('Events')} · ${events.length}`,
                        node.type === 'character_sheet' || node.type === 'location_state' || node.type === 'thread'
                            ? h('button', { type: 'button', class: 'ml-linkbtn', onClick: () => app.focusEntity(node.id) }, icon('timeline', { size: 12 }), h('span', { text: i18n('View in timeline') }))
                            : null),
                    h('ol', { class: 'ml-insp-eventlist' }, visibleEvents.map(({ node: ev, relations }) => h('li', null, nodeLink(ev, select, {
                        meta: formatFloor(ev),
                        tags: [...new Set(relations.map(relationLabel))],
                    })))),
                    hiddenEventCount > 0
                        ? button(`${i18n('Show more')} (${hiddenEventCount})`, () => { expandedEvents.add(node.id); render(); }, { className: 'ml-btn-ghost ml-btn-sm ml-insp-more' })
                        : null)
                : null,
        ];
    }

    function overview(model) {
        return [
            h('div', { class: 'ml-insp-overview' },
                h('div', { class: 'ml-insp-overview-mark' }, icon('lens', { size: 26 })),
                h('h3', { text: model.chatLabel || i18n('Memory Lens') }),
                h('p', { class: 'ml-insp-muted', text: isTouch() ? i18n('Tap a node to see its details, or tap Search at the bottom.') : withMod(i18n('Select a node to see its details, or press {mod} K to search.')) })),
            block(i18n('Last recall'), model.lastRecall
                ? h('div', { class: 'ml-insp-recall' },
                    previewText(model.lastRecall.blocks?.corePacket),
                    button(i18n('View injected text'), () => app.showInjection(), { iconName: 'doc', className: 'ml-btn-sm' }))
                : h('div', { class: 'ml-insp-muted', text: i18n('Not recalled yet') })),
        ];
    }

    function previewText(text) {
        const value = String(text || '').trim();
        if (!value) return h('div', { class: 'ml-insp-muted', text: i18n('(empty)') });
        return h('pre', { class: 'ml-insp-pre is-clamped', text: value.slice(0, 600) });
    }

    function select(id) {
        app.select(id);
    }

    function render() {
        const model = app.model();
        clear(body);
        if (!model) return;
        if (model.chatKey !== lastChatKey) {
            expandedEvents.clear();
            lastChatKey = model.chatKey;
        }
        const { selectedId } = app.state();
        const node = selectedId ? model.nodes.get(selectedId) : null;
        if (!node) {
            lastRenderedId = '';
            if (selectedId) put(body, emptyState('search', i18n('No matching results')));
            else put(body, ...overview(model).filter(Boolean));
            return;
        }
        if (history[history.length - 1] !== node.id) history.push(node.id);
        if (history.length > 30) history.shift();
        const ctx = contextState(model, node.id);
        const canBack = history.length > 1;
        const degreeChip = !node.degree
            ? null
            : app.canEdit()
                ? h('button', {
                    type: 'button',
                    class: 'ml-chip ml-chip-btn',
                    title: i18n('Relationships'),
                    onClick: () => openEdgeManager(app, node),
                }, icon('link', { size: 12 }), h('span', { text: String(node.degree) }))
                : h('span', { class: 'ml-chip', title: i18n('Relationships') }, icon('link', { size: 12 }), h('span', { text: String(node.degree) }));
        const header = h('header', { class: 'ml-insp-head', dataset: { tone: typeVisual(node.type).tone } },
            h('div', { class: 'ml-insp-toprow' },
                canBack ? iconButton('arrowLeft', i18n('Back'), () => {
                    history.pop();
                    const prev = history.pop();
                    if (prev) select(prev);
                }, { className: 'ml-iconbtn-sm' }) : null,
                typeChip(node.type),
                node.isRollup ? h('span', { class: 'ml-tl-tag', text: depthLabel(node.depth) }) : null,
                node.archived ? h('span', { class: 'ml-tag-muted', text: i18n('Archived') }) : null,
                h('span', { class: 'ml-spacer' }),
                iconButton('crosshair', i18n('Locate in graph'), () => app.locate(node.id, { inGraph: true }), { className: 'ml-iconbtn-sm' }),
                app.canEdit() ? iconButton('gear', i18n('Node properties'), () => openNodeProperties(app, node), { className: 'ml-iconbtn-sm' }) : null,
                app.canEdit() ? iconButton('link', i18n('Relationships'), () => openEdgeManager(app, node), { className: 'ml-iconbtn-sm' }) : null,
                app.canEdit() ? iconButton('trash', i18n('Delete'), () => confirmDeleteNode(app, node), { className: 'ml-iconbtn-sm' }) : null,
                iconButton('x', i18n('Close'), () => select(''), { className: 'ml-iconbtn-sm ml-insp-close' })),
            node.type !== 'event' && node.fields.title !== undefined
                ? editable(h('h2', { class: 'ml-insp-title', text: node.title }), { app, node, key: 'title', value: node.fields.title, label: i18n('Name') })
                : editable(h('h2', { class: 'ml-insp-title', text: node.title }), { app, node, key: '', value: node.rawTitle || node.title, label: i18n('Name') }),
            h('div', { class: 'ml-insp-meta' },
                contextBadge(ctx),
                formatFloor(node) ? h('span', { class: 'ml-chip' }, icon('clock', { size: 12 }), h('span', { text: formatFloor(node) })) : null,
                degreeChip,
                h('button', {
                    type: 'button',
                    class: 'ml-chip ml-chip-btn',
                    title: i18n('Copy node ID'),
                    onClick: async (event) => {
                        const target = event.currentTarget;
                        if (await copyText(node.id)) {
                            target.dataset.copied = 'true';
                            setTimeout(() => { delete target.dataset.copied; }, 1200);
                        }
                    },
                }, icon('copy', { size: 12 }), h('span', { class: 'ml-chip-mono', text: node.id }), h('span', { class: 'ml-chip-copied', text: i18n('Copied') }))));
        put(body, header, ...(node.type === 'event' ? eventBody(model, node) : entityBody(model, node)).filter(Boolean));
        if (node.id !== lastRenderedId) {
            body.scrollTop = 0;
            lastRenderedId = node.id;
        }
    }

    return { el, render };
}
