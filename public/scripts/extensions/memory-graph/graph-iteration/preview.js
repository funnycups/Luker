// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Right-pane preview for the graph-iteration studio: a lightweight outline
 * grouped by node type plus a link list, with staged changes highlighted.
 * Deliberately no canvas / cytoscape embedding — the workspace must stay
 * cheap on mobile WebViews.
 */

import { diffGraphDocs } from './diff-cards.js';

function escapeHtmlLocal(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function stateClass(base, state) {
    return state ? `${base} ${base}_${state}` : base;
}

function sortNodes(nodes) {
    return nodes.slice().sort((a, b) => {
        const archivedDelta = Number(Boolean(a?.archived)) - Number(Boolean(b?.archived));
        if (archivedDelta !== 0) return archivedDelta;
        return String(a?.title || '').localeCompare(String(b?.title || ''));
    });
}

export function renderMgGraphPreviewPane(stagedDoc, liveDoc, { t } = {}) {
    const tr = typeof t === 'function' ? t : (s) => String(s ?? '');
    const stagedNodes = (stagedDoc && typeof stagedDoc.nodes === 'object' && stagedDoc.nodes) || {};
    const liveNodes = (liveDoc && typeof liveDoc.nodes === 'object' && liveDoc.nodes) || {};
    const stagedLinks = (stagedDoc && typeof stagedDoc.links === 'object' && stagedDoc.links) || {};
    const liveLinks = (liveDoc && typeof liveDoc.links === 'object' && liveDoc.links) || {};
    const diff = diffGraphDocs(liveDoc, stagedDoc);
    const addedNodes = new Set(diff.addedNodes);
    const removedNodes = new Set(diff.removedNodes);
    const modifiedNodes = new Set(diff.modifiedNodes);
    const addedLinks = new Set(diff.addedLinks);
    const removedLinks = new Set(diff.removedLinks);
    const modifiedLinks = new Set(diff.modifiedLinks);

    const parts = ['<div class="mg_graph_it_preview">'];

    const totalNodes = Object.keys(stagedNodes).length;
    if (totalNodes === 0 && removedNodes.size === 0) {
        parts.push(`<div class="mg_graph_it_preview_empty">${escapeHtmlLocal(tr('No graph changes staged yet.'))}</div>`);
    }

    // Group staged nodes by type; removed nodes join their type's group.
    const groups = new Map();
    for (const node of sortNodes(Object.values(stagedNodes))) {
        const type = String(node?.type || 'unknown');
        if (!groups.has(type)) groups.set(type, []);
        groups.get(type).push(node);
    }
    for (const id of diff.removedNodes) {
        const node = liveNodes[id];
        if (!node) continue;
        const type = String(node?.type || 'unknown');
        if (!groups.has(type)) groups.set(type, []);
        groups.get(type).push({ ...node, __removed: true });
    }

    for (const [type, nodes] of groups) {
        parts.push('<div class="mg_graph_it_preview_group">');
        parts.push(`<div class="mg_graph_it_preview_group_title">${escapeHtmlLocal(type)} <span class="mg_graph_it_preview_group_count">${nodes.length}</span></div>`);
        for (const node of nodes) {
            const id = String(node?.id || '');
            let state = '';
            if (node.__removed || removedNodes.has(id)) state = 'removed';
            else if (addedNodes.has(id)) state = 'added';
            else if (modifiedNodes.has(id)) state = 'modified';
            const stateMark = state === 'added' ? '+' : state === 'removed' ? '-' : state === 'modified' ? '~' : '';
            parts.push(`<div class="${stateClass('mg_graph_it_preview_row', state)}" data-mg-graph-node-id="${escapeHtmlLocal(id)}">`
                + `<span class="mg_graph_it_preview_row_state">${stateMark}</span>`
                + `<span class="mg_graph_it_preview_row_title">${escapeHtmlLocal(node?.title || id)}</span>`
                + `<span class="mg_graph_it_preview_row_id">${escapeHtmlLocal(id)}</span>`
                + '</div>');
        }
        parts.push('</div>');
    }

    const linkRows = [];
    for (const key of [...addedLinks, ...modifiedLinks]) {
        const edge = stagedLinks[key];
        if (!edge) continue;
        const state = addedLinks.has(key) ? 'added' : 'modified';
        linkRows.push(`<div class="${stateClass('mg_graph_it_preview_link', state)}" data-mg-graph-link-key="${escapeHtmlLocal(key)}">`
            + `<span class="mg_graph_it_preview_link_state">${state === 'added' ? '+' : '~'}</span>`
            + `<span class="mg_graph_it_preview_link_body">${escapeHtmlLocal(`${edge.from} —${edge.type}→ ${edge.to}`)}</span>`
            + '</div>');
    }
    for (const key of removedLinks) {
        const edge = liveLinks[key];
        if (!edge) continue;
        linkRows.push(`<div class="${stateClass('mg_graph_it_preview_link', 'removed')}" data-mg-graph-link-key="${escapeHtmlLocal(key)}">`
            + '<span class="mg_graph_it_preview_link_state">-</span>'
            + `<span class="mg_graph_it_preview_link_body">${escapeHtmlLocal(`${edge.from} —${edge.type}→ ${edge.to}`)}</span>`
            + '</div>');
    }
    if (linkRows.length > 0) {
        parts.push(`<div class="mg_graph_it_preview_group_title">${escapeHtmlLocal(tr('Links'))}</div>`);
        parts.push(...linkRows);
    }

    parts.push('</div>');
    return parts.join('');
}
