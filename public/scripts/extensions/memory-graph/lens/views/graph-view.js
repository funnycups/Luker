// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Graph view: Cytoscape canvas with two deterministic layouts, focus-on-
// selection dimming, hover neighbourhood preview and a floating toolbar.

import { h, clear, truncate, prefersReducedMotion, put } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat, typeLabel, relationLabel, depthLabel } from '../i18n.js';
import { visibleSubgraph, contextState, typeVisual, isDefaultFilters } from '../model.js';
import { loadCytoscape } from '../graph/cy-loader.js';
import { forceLayout, chronoLayout, nodeRadius } from '../graph/layout.js';
import { buildStylesheet, readTokens, colorForNode } from '../graph/cy-style.js';
import { iconButton, segmented, emptyState, button, typeDot } from '../ui/components.js';

export function createGraphView(app) {
    const canvas = h('div', { class: 'ml-graph-canvas', role: 'application', 'aria-label': i18n('Graph') });
    const toolbar = h('div', { class: 'ml-graph-toolbar' });
    const zoombar = h('div', { class: 'ml-graph-zoombar' });
    const legend = h('div', { class: 'ml-graph-legend' });
    const notice = h('div', { class: 'ml-graph-notice', hidden: true });
    const overlay = h('div', { class: 'ml-graph-overlay', hidden: true });
    const tooltip = h('div', { class: 'ml-graph-tip', role: 'tooltip', hidden: true });
    const root = h('div', { class: 'ml-graph' }, canvas, toolbar, zoombar, legend, notice, overlay, tooltip);

    let cy = null;
    let cyPromise = null;
    let positionsCache = new Map(); // layout+id → position, keeps refreshes stable
    let lastSignature = '';
    let lastLayout = '';
    let destroyed = false;

    const ensureCy = () => {
        if (cy) return Promise.resolve(cy);
        if (!cyPromise) {
            cyPromise = loadCytoscape(app.cytoscapeSrc).then((cytoscape) => {
                if (destroyed) return null;
                cy = cytoscape({
                    container: canvas,
                    elements: [],
                    minZoom: 0.08,
                    maxZoom: 3.2,
                    boxSelectionEnabled: false,
                    selectionType: 'single',
                    autoungrabify: false,
                    textureOnViewport: false,
                    pixelRatio: 'auto',
                    style: buildStylesheet(readTokens(app.root), { compact: app.isCompact() }),
                });
                bindEvents();
                return cy;
            });
            cyPromise.catch(() => { cyPromise = null; });
        }
        return cyPromise;
    };

    function bindEvents() {
        cy.on('tap', 'node', (event) => app.select(event.target.id()));
        cy.on('tap', (event) => {
            if (event.target === cy) app.select('');
        });
        cy.on('dbltap', 'node', (event) => {
            cy.animate({ center: { eles: event.target }, zoom: Math.max(cy.zoom(), 1.3) }, { duration: animMs() });
        });
        cy.on('mouseover', 'node', (event) => {
            if (app.isCompact()) return;
            const node = event.target;
            node.addClass('ml-hover');
            if (!app.state().selectedId) previewNeighborhood(node);
            showTip(node);
        });
        cy.on('mouseout', 'node', (event) => {
            event.target.removeClass('ml-hover');
            if (!app.state().selectedId) clearFocusClasses();
            hideTip();
        });
        cy.on('mouseover', 'edge', (event) => {
            if (!app.state().selectedId) event.target.addClass('ml-near');
        });
        cy.on('mouseout', 'edge', (event) => {
            if (!app.state().selectedId) event.target.removeClass('ml-near');
        });
        cy.on('dragfree', 'node', (event) => {
            const key = `${app.state().graphLayout}|${event.target.id()}`;
            positionsCache.set(key, { ...event.target.position() });
        });
        cy.on('viewport', hideTip);
    }

    const animMs = () => (prefersReducedMotion() ? 0 : 260);

    function showTip(node) {
        const model = app.model();
        const data = model?.nodes.get(node.id());
        if (!data) return;
        clear(tooltip);
        put(tooltip,
            h('div', { class: 'ml-graph-tip-head' }, typeDot(data.type, { size: 8 }), h('span', { text: typeLabel(data.type) }), data.isRollup ? h('span', { class: 'ml-graph-tip-tag', text: depthLabel(data.depth) }) : null),
            h('div', { class: 'ml-graph-tip-title', text: truncate(data.title, 60) }),
        );
        const pos = node.renderedPosition();
        const r = node.renderedOuterWidth() / 2;
        tooltip.hidden = false;
        const bounds = canvas.getBoundingClientRect();
        const tipWidth = tooltip.offsetWidth;
        const x = Math.min(Math.max(8, pos.x - tipWidth / 2), bounds.width - tipWidth - 8);
        const y = pos.y - r - tooltip.offsetHeight - 10;
        tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y < 8 ? pos.y + r + 10 : y)}px)`;
    }

    function hideTip() {
        tooltip.hidden = true;
    }

    function clearFocusClasses() {
        if (!cy) return;
        cy.batch(() => cy.elements().removeClass('ml-dim ml-near'));
    }

    function previewNeighborhood(node) {
        cy.batch(() => {
            const hood = node.closedNeighborhood();
            cy.elements().not(hood).addClass('ml-dim');
            hood.removeClass('ml-dim').addClass('ml-near');
        });
    }

    function applySelection({ animate = true } = {}) {
        if (!cy) return;
        const { selectedId } = app.state();
        cy.batch(() => {
            cy.elements().removeClass('ml-dim ml-near');
            cy.$(':selected').unselect();
        });
        if (!selectedId) return;
        const node = cy.getElementById(selectedId);
        if (!node || node.empty()) return;
        node.select();
        const hood = node.closedNeighborhood();
        cy.batch(() => {
            cy.elements().not(hood).addClass('ml-dim');
            hood.addClass('ml-near');
            node.removeClass('ml-near');
        });
        if (animate) revealNode(node);
    }

    /** Area of the canvas not covered by the mobile bottom sheet. */
    function visibleViewport() {
        const width = canvas.clientWidth;
        let height = canvas.clientHeight;
        if (app.isCompact() && app.state().drawer === 'inspector') {
            const sheet = app.root.querySelector('.ml-inspector');
            if (sheet) height = Math.max(120, height - sheet.offsetHeight + 24);
        }
        return { width, height };
    }

    function revealNode(node, { zoom = null } = {}) {
        const { width, height } = visibleViewport();
        const rendered = node.renderedPosition();
        const margin = 60;
        const inView = rendered.x > margin && rendered.x < width - margin && rendered.y > margin && rendered.y < height - margin;
        if (inView && zoom === null) return;
        const level = zoom ?? cy.zoom();
        const p = node.position();
        cy.animate({
            zoom: level,
            pan: { x: width / 2 - p.x * level, y: height / 2 - p.y * level },
        }, { duration: animMs() });
    }

    function applyMatches() {
        if (!cy) return;
        const matches = app.state().matchIds;
        cy.batch(() => {
            cy.nodes('.ml-match').removeClass('ml-match');
            if (matches?.size) for (const id of matches) cy.getElementById(id).addClass('ml-match');
        });
    }

    function buildElements(model, sub, layoutName) {
        const tokens = readTokens(app.root);
        const compact = app.isCompact();
        const layoutFn = layoutName === 'chrono' ? chronoLayout : forceLayout;
        const keyed = (id) => `${layoutName}|${id}`;
        const initial = new Map();
        for (const node of sub.nodes) {
            const cached = positionsCache.get(keyed(node.id));
            if (cached) initial.set(node.id, cached);
        }
        const aspect = canvas.clientWidth && canvas.clientHeight ? canvas.clientWidth / canvas.clientHeight : 1.4;
        const positions = layoutName === 'chrono'
            ? layoutFn(sub.nodes, sub.edges)
            : layoutFn(sub.nodes, sub.edges, { initial: initial.size ? initial : null, aspect });
        if (layoutName === 'chrono') {
            for (const [id, pos] of initial) positions.set(id, pos);
        }
        const elements = [];
        for (const node of sub.nodes) {
            const pos = positions.get(node.id) || { x: 0, y: 0 };
            positionsCache.set(keyed(node.id), pos);
            const isEvent = node.type === 'event';
            const chrono = layoutName === 'chrono';
            const label = isEvent
                ? (node.isRollup ? truncate(node.title, compact ? 10 : 16) : (compact || chrono ? '' : truncate(node.title, 12)))
                : truncate(node.title, compact ? 8 : 14);
            elements.push({
                group: 'nodes',
                data: {
                    id: node.id,
                    label,
                    kind: isEvent ? 'event' : 'entity',
                    size: nodeRadius(node) * 2,
                    shape: typeVisual(node.type).shape,
                    color: colorForNode(tokens, node),
                    rollup: node.isRollup,
                    archived: node.archived,
                    ctx: contextState(model, node.id),
                },
                position: { ...pos },
            });
        }
        for (const edge of sub.edges) {
            elements.push({
                group: 'edges',
                data: {
                    id: edge.key,
                    source: edge.from,
                    target: edge.to,
                    category: edge.category,
                    directed: edge.directed && !edge.internal,
                    label: relationLabel(edge.type),
                },
                // On the chronology spine, event→entity links are context, not structure.
                classes: layoutName === 'chrono' && edge.category === 'structural' ? 'ml-faint' : '',
            });
        }
        return elements;
    }

    function signatureOf(model, sub, layoutName) {
        let sig = `${layoutName}|${model.loadedAt}|${sub.nodes.length}|${sub.edges.length}`;
        for (const node of sub.nodes) sig += `|${node.id}`;
        return sig;
    }

    function renderToolbar() {
        const state = app.state();
        clear(toolbar);
        put(toolbar, segmented([
            { value: 'force', label: i18n('Relationship web'), icon: 'graph' },
            { value: 'chrono', label: i18n('Chronological'), icon: 'timeline' },
        ], state.graphLayout, (value) => app.setState({ graphLayout: value }), { ariaLabel: i18n('Legend'), className: 'ml-seg-sm' }));
        clear(zoombar);
        put(zoombar,
            iconButton('plus', i18n('Zoom in'), () => zoomBy(1.25)),
            iconButton('minus', i18n('Zoom out'), () => zoomBy(0.8)),
            iconButton('fit', i18n('Fit to window'), () => fit(true)),
        );
    }

    function renderLegend(model, sub) {
        clear(legend);
        const counts = new Map();
        for (const node of sub.nodes) counts.set(node.type, (counts.get(node.type) || 0) + 1);
        for (const type of model.typeList) {
            if (!counts.has(type)) continue;
            put(legend, h('span', { class: 'ml-legend-item' }, typeDot(type, { size: 9 }), h('span', { text: typeLabel(type) }), h('span', { class: 'ml-legend-count', text: String(counts.get(type)) })));
        }
        const hasCtx = sub.nodes.some(node => contextState(model, node.id) === 'recalled');
        if (hasCtx) put(legend, h('span', { class: 'ml-legend-item' }, h('span', { class: 'ml-legend-glow', 'aria-hidden': 'true' }), h('span', { text: i18n('Recalled this turn') })));
    }

    function zoomBy(factor) {
        if (!cy) return;
        const center = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
        cy.animate({ zoom: { level: cy.zoom() * factor, renderedPosition: center } }, { duration: animMs() / 1.6 });
    }

    function fit(animate = false) {
        if (!cy || cy.elements().empty()) return;
        const padding = app.isCompact() ? 28 : 56;
        if (animate) cy.animate({ fit: { eles: cy.elements(), padding } }, { duration: animMs() });
        else cy.fit(cy.elements(), padding);
        if (cy.zoom() > 1.6) cy.zoom({ level: 1.6, renderedPosition: { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 } });
    }

    async function render() {
        const model = app.model();
        const state = app.state();
        renderToolbar();
        if (!model) return;
        const sub = visibleSubgraph(model, state.filters, { maxNodes: app.isCompact() ? 220 : 450 });
        notice.hidden = !sub.truncated;
        if (sub.truncated) {
            put(clear(notice), icon('layers', { size: 14 }), h('span', { text: i18nFormat('Too many nodes; showing only the latest ${0}. Narrow it down with the filters on the left.', sub.nodes.length) }));
        }
        renderLegend(model, sub);

        if (!sub.nodes.length) {
            overlay.hidden = false;
            put(clear(overlay), model.nodes.size
                ? emptyState('filter', i18n('No nodes match the current filters.'), '', isDefaultFilters(state.filters) ? null : button(i18n('Reset filters'), () => app.resetFilters(), { iconName: 'refresh' }))
                : emptyState('graph', i18n('This chat has no memory nodes yet.'), i18n('The memory graph extracts them automatically as the conversation goes on.')));
            if (cy) cy.elements().remove();
            lastSignature = '';
            return;
        }
        overlay.hidden = true;

        let instance;
        try {
            instance = await ensureCy();
        } catch (err) {
            overlay.hidden = false;
            put(clear(overlay), emptyState('graph', String(err?.message || err)));
            return;
        }
        if (!instance || destroyed) return;

        const signature = signatureOf(model, sub, state.graphLayout);
        const layoutChanged = lastLayout !== state.graphLayout;
        if (signature !== lastSignature) {
            const elements = buildElements(model, sub, state.graphLayout);
            const firstRender = !lastSignature;
            cy.batch(() => {
                cy.elements().remove();
                cy.add(elements);
            });
            lastSignature = signature;
            lastLayout = state.graphLayout;
            if (firstRender || layoutChanged) fit(false);
        } else {
            // Same topology: refresh data that can change without structure changes.
            cy.batch(() => {
                for (const node of sub.nodes) {
                    const el = cy.getElementById(node.id);
                    if (el.nonempty()) el.data('ctx', contextState(model, node.id));
                }
            });
        }
        applyMatches();
        applySelection({ animate: !layoutChanged });
    }

    function restyle() {
        if (!cy) return;
        cy.style(buildStylesheet(readTokens(app.root), { compact: app.isCompact() }));
        const model = app.model();
        if (!model) return;
        const tokens = readTokens(app.root);
        cy.batch(() => cy.nodes().forEach((el) => {
            const node = model.nodes.get(el.id());
            if (node) el.data('color', colorForNode(tokens, node));
        }));
    }

    return {
        id: 'graph',
        el: root,
        render,
        onSelectionChange: () => applySelection(),
        onMatchesChange: applyMatches,
        onThemeChange: restyle,
        onResize: () => { if (cy) cy.resize(); },
        onShow: () => {
            if (cy) {
                cy.resize();
                if (!cy.elements().empty() && cy.zoom() === 1 && cy.pan().x === 0) fit(false);
            }
        },
        locate(id) {
            if (!cy) return;
            const node = cy.getElementById(id);
            if (node.nonempty()) revealNode(node, { zoom: Math.max(cy.zoom(), 1.1) });
        },
        fit: () => fit(true),
        invalidate() {
            lastSignature = '';
        },
        destroy() {
            destroyed = true;
            cy?.destroy();
            cy = null;
        },
    };
}
