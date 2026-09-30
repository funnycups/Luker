// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Graph-iteration review card. Splits one proposal's before/after canonical
 * docs into per-record groups (nodes and links) so the user sees exactly
 * what the turn added, removed or modified. Each group opens with a header
 * carrying the record's kind, marker and identity; its leaf body delegates
 * to the shared iteration-library diff card so fields render per-leaf.
 */

import { renderDiffCard } from '../../../iteration-library/ui/diff.js';

function escapeHtmlLocal(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sameRecord(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function nodeMapOf(doc) {
    return (doc && typeof doc.nodes === 'object' && doc.nodes) || {};
}

function linkMapOf(doc) {
    return (doc && typeof doc.links === 'object' && doc.links) || {};
}

export function diffGraphDocs(beforeDoc, afterDoc) {
    const beforeNodes = nodeMapOf(beforeDoc);
    const afterNodes = nodeMapOf(afterDoc);
    const beforeLinks = linkMapOf(beforeDoc);
    const afterLinks = linkMapOf(afterDoc);

    const addedNodes = [];
    const removedNodes = [];
    const modifiedNodes = [];
    for (const id of Object.keys(afterNodes)) {
        if (!(id in beforeNodes)) addedNodes.push(id);
        else if (!sameRecord(beforeNodes[id], afterNodes[id])) modifiedNodes.push(id);
    }
    for (const id of Object.keys(beforeNodes)) {
        if (!(id in afterNodes)) removedNodes.push(id);
    }

    const addedLinks = [];
    const removedLinks = [];
    const modifiedLinks = [];
    for (const key of Object.keys(afterLinks)) {
        if (!(key in beforeLinks)) addedLinks.push(key);
        else if (!sameRecord(beforeLinks[key], afterLinks[key])) modifiedLinks.push(key);
    }
    for (const key of Object.keys(beforeLinks)) {
        if (!(key in afterLinks)) removedLinks.push(key);
    }

    const sortIds = (list) => list.sort((a, b) => String(a).localeCompare(String(b)));
    return {
        addedNodes: sortIds(addedNodes),
        removedNodes: sortIds(removedNodes),
        modifiedNodes: sortIds(modifiedNodes),
        addedLinks: sortIds(addedLinks),
        removedLinks: sortIds(removedLinks),
        modifiedLinks: sortIds(modifiedLinks),
    };
}

function nodeIdentity(node) {
    const type = String(node?.type || 'node');
    const id = String(node?.id ?? '');
    const title = String(node?.title ?? '');
    return title ? `${type} · ${title} (${id})` : `${type} · ${id}`;
}

function linkIdentity(edge) {
    return `${String(edge?.from || '?')} −${String(edge?.type || 'related')}→ ${String(edge?.to || '?')}`;
}

function countDifferences(diff) {
    return diff.addedNodes.length + diff.removedNodes.length + diff.modifiedNodes.length
        + diff.addedLinks.length + diff.removedLinks.length + diff.modifiedLinks.length;
}

function isArchivedTransition(beforeNode, afterNode) {
    return !beforeNode?.archived && Boolean(afterNode?.archived);
}

function renderRecordGroup({ marker, kind, identity, edit, i18n }) {
    const body = renderDiffCard([edit], { i18n });
    return [
        '<div class="mg_graph_it_diff_record">',
        '<div class="mg_graph_it_diff_record_header">'
            + `<span class="mg_graph_it_diff_record_marker">${escapeHtmlLocal(marker)}</span>`
            + `<span class="mg_graph_it_diff_record_kind">${escapeHtmlLocal(kind)}</span>`
            + `<span class="mg_graph_it_diff_record_identity">${escapeHtmlLocal(identity)}</span>`
            + '</div>',
        body,
        '</div>',
    ].join('');
}

export function renderMgGraphDiffCard(beforeDoc, afterDoc, { t } = {}) {
    const tr = typeof t === 'function' ? t : (s) => String(s ?? '');
    const diff = diffGraphDocs(beforeDoc, afterDoc);
    if (countDifferences(diff) === 0) {
        return `<div class="mg_graph_it_pending_card"><div class="mg_graph_it_pending_note">${escapeHtmlLocal(tr('(no effective change)'))}</div></div>`;
    }

    const beforeNodes = nodeMapOf(beforeDoc);
    const afterNodes = nodeMapOf(afterDoc);
    const beforeLinks = linkMapOf(beforeDoc);
    const afterLinks = linkMapOf(afterDoc);

    const groups = [];

    // Modified nodes: one empty-path set lets the shared walker split the
    // record into per-leaf cards inside the group body.
    for (const id of diff.modifiedNodes) {
        const beforeNode = beforeNodes[id];
        const afterNode = afterNodes[id];
        groups.push(renderRecordGroup({
            marker: '~',
            kind: tr(isArchivedTransition(beforeNode, afterNode) ? 'Archived node' : 'Modified node'),
            identity: nodeIdentity(afterNode),
            edit: { op: 'set', path: '', oldValue: beforeNode, newValue: afterNode },
            i18n: tr,
        }));
    }
    for (const id of diff.addedNodes) {
        groups.push(renderRecordGroup({
            marker: '+',
            kind: tr('Added node'),
            identity: nodeIdentity(afterNodes[id]),
            edit: { op: 'set', path: `nodes.${id}`, oldValue: undefined, newValue: afterNodes[id] },
            i18n: tr,
        }));
    }
    for (const id of diff.removedNodes) {
        groups.push(renderRecordGroup({
            marker: '−',
            kind: tr('Removed node'),
            identity: nodeIdentity(beforeNodes[id]),
            edit: { op: 'set', path: `nodes.${id}`, oldValue: beforeNodes[id], newValue: undefined },
            i18n: tr,
        }));
    }
    for (const key of diff.addedLinks) {
        groups.push(renderRecordGroup({
            marker: '+',
            kind: tr('Added link'),
            identity: linkIdentity(afterLinks[key]),
            edit: { op: 'set', path: `links.${key}`, oldValue: undefined, newValue: afterLinks[key] },
            i18n: tr,
        }));
    }
    for (const key of diff.removedLinks) {
        groups.push(renderRecordGroup({
            marker: '−',
            kind: tr('Removed link'),
            identity: linkIdentity(beforeLinks[key]),
            edit: { op: 'set', path: `links.${key}`, oldValue: beforeLinks[key], newValue: undefined },
            i18n: tr,
        }));
    }
    for (const key of diff.modifiedLinks) {
        groups.push(renderRecordGroup({
            marker: '~',
            kind: tr('Modified link'),
            identity: linkIdentity(afterLinks[key]),
            edit: { op: 'set', path: `links.${key}`, oldValue: beforeLinks[key], newValue: afterLinks[key] },
            i18n: tr,
        }));
    }

    return `<div class="mg_graph_it_pending_card">${groups.join('')}</div>`;
}

export function buildGraphDiffSummary(beforeDoc, afterDoc) {
    const diff = diffGraphDocs(beforeDoc, afterDoc);
    const beforeNodes = nodeMapOf(beforeDoc);
    const afterNodes = nodeMapOf(afterDoc);
    const beforeLinks = linkMapOf(beforeDoc);
    const afterLinks = linkMapOf(afterDoc);
    const nodeEntry = (id, node, extra = {}) => ({
        id: String(id),
        type: String(node?.type || ''),
        title: String(node?.title || ''),
        ...extra,
    });
    const linkEntry = (edge) => ({
        from: String(edge?.from || ''),
        to: String(edge?.to || ''),
        type: String(edge?.type || ''),
    });
    return {
        addedNodes: diff.addedNodes.map(id => nodeEntry(id, afterNodes[id])),
        removedNodes: diff.removedNodes.map(id => nodeEntry(id, beforeNodes[id])),
        modifiedNodes: diff.modifiedNodes.map(id => nodeEntry(id, afterNodes[id], {
            archivedTransition: isArchivedTransition(beforeNodes[id], afterNodes[id]),
        })),
        addedLinks: diff.addedLinks.map(key => linkEntry(afterLinks[key])),
        removedLinks: diff.removedLinks.map(key => linkEntry(beforeLinks[key])),
        modifiedLinks: diff.modifiedLinks.map(key => linkEntry(afterLinks[key])),
    };
}

export function renderMgGraphDiffSummary(summary, { t } = {}) {
    const tr = typeof t === 'function' ? t : (s) => String(s ?? '');
    if (!summary || typeof summary !== 'object') return '';
    const group = (marker, kind, identity) => [
        '<div class="mg_graph_it_diff_record">',
        '<div class="mg_graph_it_diff_record_header">'
            + `<span class="mg_graph_it_diff_record_marker">${escapeHtmlLocal(marker)}</span>`
            + `<span class="mg_graph_it_diff_record_kind">${escapeHtmlLocal(kind)}</span>`
            + `<span class="mg_graph_it_diff_record_identity">${escapeHtmlLocal(identity)}</span>`
            + '</div>',
        '</div>',
    ].join('');
    const groups = [];
    for (const n of Array.isArray(summary.modifiedNodes) ? summary.modifiedNodes : []) {
        groups.push(group('~', tr(n.archivedTransition ? 'Archived node' : 'Modified node'), nodeIdentity(n)));
    }
    for (const n of Array.isArray(summary.addedNodes) ? summary.addedNodes : []) {
        groups.push(group('+', tr('Added node'), nodeIdentity(n)));
    }
    for (const n of Array.isArray(summary.removedNodes) ? summary.removedNodes : []) {
        groups.push(group('−', tr('Removed node'), nodeIdentity(n)));
    }
    for (const l of Array.isArray(summary.addedLinks) ? summary.addedLinks : []) {
        groups.push(group('+', tr('Added link'), linkIdentity(l)));
    }
    for (const l of Array.isArray(summary.removedLinks) ? summary.removedLinks : []) {
        groups.push(group('−', tr('Removed link'), linkIdentity(l)));
    }
    for (const l of Array.isArray(summary.modifiedLinks) ? summary.modifiedLinks : []) {
        groups.push(group('~', tr('Modified link'), linkIdentity(l)));
    }
    if (groups.length === 0) return '';
    return `<div class="mg_graph_it_pending_card">${groups.join('')}</div>`;
}
