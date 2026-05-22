// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// World-book preview pane renderer for the CEA character editor popup.
// Pure function — no DOM, no I/O — so it tests cleanly under Jest without
// the heavy `main.js` import graph.
//
// Reads a `worldInfo = { name, entries }` snapshot (the shape returned by
// `context.loadWorldInfo(bookName)`) and a `pendingApproval` batch from the
// editor's closure state. Marks existing entries that the pending batch
// targets with `pending-change`, and renders any brand-new draft entries
// (operations whose payload uid is not yet in the snapshot) as their own
// draft rows at the top.
//
// Mirrors the pattern from character-iteration/studio.js#renderCeaCharPreviewPane:
// optional `tFn` arg lets the caller pass an i18n function; falls back to
// identity so the renderer remains import-free for tests.

function escapeHtmlLocal(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function truncateForPreview(value, max = 200) {
    const str = String(value ?? '');
    if (str.length <= max) return str;
    return `${str.slice(0, max)}…`;
}

function formatTemplate(template, ...values) {
    return String(template ?? '').replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}

/**
 * Render the world-book preview pane HTML.
 * @param {{name?: string, book_name?: string, entries?: object|Array}|null} worldInfo
 * @param {{messageId?: string, operations?: Array<{op: string, payload?: object, data?: object, args?: object}>}|null} pendingApproval
 * @param {Function} [tFn] Optional i18n function (string → string); defaults to identity.
 * @returns {string} HTML markup
 */
export function renderCeaEditorPreviewPane(worldInfo, pendingApproval, tFn) {
    const t = typeof tFn === 'function' ? tFn : (s) => String(s ?? '');
    const tFormat = (template, ...values) => formatTemplate(t(template), ...values);

    if (!worldInfo) {
        return `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No world book bound'))}</div>`;
    }

    const name = worldInfo.name || worldInfo.book_name || '';
    const entries = worldInfo.entries || {};
    const entryArray = Array.isArray(entries) ? entries.slice() : Object.values(entries);

    // Identify pending entries by uid; treat anything without a matching uid
    // as a brand-new draft (rendered as a separate row at the top).
    const pendingByUid = new Map();
    const pendingNewEntries = [];
    const ops = Array.isArray(pendingApproval?.operations) ? pendingApproval.operations : [];
    for (const op of ops) {
        const payload = op?.payload || op?.data || op?.args || {};
        const uid = payload?.uid;
        const key = uid == null ? null : String(uid);
        const isCreate = op?.op === 'upsert_entry' || op?.op === 'create_entry' || op?.op === 'add_entry';
        const entriesObj = !Array.isArray(entries) ? entries : null;
        const existsInSnapshot = key != null && entriesObj && Object.prototype.hasOwnProperty.call(entriesObj, key);
        if (existsInSnapshot) {
            pendingByUid.set(key, op);
        } else if (isCreate || key != null) {
            // upsert/create on unknown uid → draft row at the top.
            // delete/update on missing uid also shows up as a draft so the
            // user sees the AI is referencing a non-existent entry.
            pendingNewEntries.push(payload);
        }
    }

    const entryRows = entryArray.map((entry) => {
        const uid = entry?.uid ?? entry?.id ?? '';
        const keys = (Array.isArray(entry?.key) ? entry.key : (Array.isArray(entry?.keys) ? entry.keys : []))
            .slice(0, 3)
            .join(', ');
        const pos = entry?.position ?? '';
        const content = truncateForPreview(entry?.content || '', 200);
        const isPending = pendingByUid.has(String(uid));
        const cls = isPending
            ? 'luker-iter-workspace-preview-row pending-change'
            : 'luker-iter-workspace-preview-row';
        const draftBadge = isPending
            ? `<span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(t('Draft (not applied)'))}</span>`
            : '';
        return `<div class="${cls}"><div class="luker-iter-workspace-preview-row-head"><span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(tFormat('Entry UID: ${0}', uid))}</span><span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(tFormat('Position: ${0}', pos))}</span>${draftBadge}</div><div class="luker-iter-workspace-preview-row-body">${escapeHtmlLocal(tFormat('Keys: ${0}', keys))}<br>${content ? escapeHtmlLocal(content) : '<span class="muted">(empty)</span>'}</div></div>`;
    }).join('');

    const newEntryRows = pendingNewEntries.map((payload) => {
        const keys = (Array.isArray(payload?.key) ? payload.key : (Array.isArray(payload?.keys) ? payload.keys : []))
            .slice(0, 3)
            .join(', ');
        const content = truncateForPreview(payload?.content || '', 200);
        const uidLabel = payload?.uid != null ? String(payload.uid) : t('(new)');
        return `<div class="luker-iter-workspace-preview-row pending-change"><div class="luker-iter-workspace-preview-row-head"><span class="luker-iter-workspace-preview-row-label">${escapeHtmlLocal(tFormat('Entry UID: ${0}', uidLabel))}</span><span class="luker-iter-workspace-preview-row-meta">${escapeHtmlLocal(t('Draft (not applied)'))}</span></div><div class="luker-iter-workspace-preview-row-body">${escapeHtmlLocal(tFormat('Keys: ${0}', keys))}<br>${escapeHtmlLocal(content)}</div></div>`;
    }).join('');

    const bodyRows = `${newEntryRows}${entryRows}`
        || `<div class="luker-iter-workspace-preview-empty">${escapeHtmlLocal(t('No entries yet.'))}</div>`;

    return `
        <div class="luker-iter-workspace-preview-section">
            <div class="luker-iter-workspace-preview-section-title">${escapeHtmlLocal(tFormat('World book: ${0}', name))}</div>
            ${bodyRows}
        </div>
    `;
}

export { renderCeaEditorPreviewPane as _testOnly_renderCeaEditorPreviewPane };
