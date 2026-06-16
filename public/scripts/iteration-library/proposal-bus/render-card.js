// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Renders a single proposal card. Chrome only — body is delegated to
 * handler.renderDiffCard. Controls toggle by entry.status:
 *   pending / conflict -> Approve + Reject
 *   rejected           -> Undo reject
 *   committed          -> Rollback (only when handler.inverseAvailable)
 *   rolledBack         -> no buttons
 *
 * The card-level attrs (data-proposal-id, data-proposal-kind,
 * data-proposal-action) form the contract that event-router.js consumes;
 * popups never see these attribute names directly.
 */

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    }[c]));
}

function formatTime(ts) {
    if (!ts) return '';
    try {
        const d = new Date(Number(ts));
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch { return ''; }
}

function statusChip(entry, i18n) {
    const t = formatTime(entry.committedAt || entry.decidedAt || entry.rolledBackAt);
    switch (entry.status) {
        case 'pending':    return `<span class="iter_proposal_card_status iter_proposal_card_status_pending">${escapeHtml(i18n('Pending approval'))}</span>`;
        case 'committed':  return `<span class="iter_proposal_card_status iter_proposal_card_status_committed">${escapeHtml(i18n('✓ Applied at ${0}', t))}</span>`;
        case 'rejected':   return `<span class="iter_proposal_card_status iter_proposal_card_status_rejected">${escapeHtml(i18n('✗ Rejected at ${0}', t))}</span>`;
        case 'conflict':   return `<span class="iter_proposal_card_status iter_proposal_card_status_conflict">${escapeHtml(i18n('⚠ External change'))}</span>`;
        case 'rolledBack': return `<span class="iter_proposal_card_status iter_proposal_card_status_rolledBack">${escapeHtml(i18n('↺ Rolled back at ${0}', t))}</span>`;
        default:           return '';
    }
}

function controls(entry, handler, i18n) {
    const idAttr = escapeHtml(entry.id);
    const status = entry.status;
    const btns = [];
    if (status === 'pending' || status === 'conflict') {
        btns.push(`<button class="menu_button iter_proposal_btn iter_proposal_btn_approve" data-proposal-action="approve" data-proposal-id="${idAttr}">${escapeHtml(i18n('Approve'))}</button>`);
        btns.push(`<button class="menu_button iter_proposal_btn iter_proposal_btn_reject" data-proposal-action="reject" data-proposal-id="${idAttr}">${escapeHtml(i18n('Reject'))}</button>`);
    } else if (status === 'rejected') {
        btns.push(`<button class="menu_button iter_proposal_btn" data-proposal-action="reset" data-proposal-id="${idAttr}">${escapeHtml(i18n('Undo reject'))}</button>`);
    } else if (status === 'committed' && handler.inverseAvailable !== false) {
        btns.push(`<button class="menu_button iter_proposal_btn" data-proposal-action="rollback" data-proposal-id="${idAttr}">${escapeHtml(i18n('Rollback'))}</button>`);
    }
    return `<div class="iter_proposal_card_controls">${btns.join('')}</div>`;
}

function conflictBlock(entry, i18n) {
    if (entry.status !== 'conflict' || !entry.conflictInfo) return '';
    const info = entry.conflictInfo;
    const errLine = info.error
        ? `<div class="iter_proposal_conflict_error">${escapeHtml(i18n('Error: ${0}', String(info.error)))}</div>`
        : '';
    return `<div class="iter_proposal_card_conflict">
        <div class="iter_proposal_conflict_summary">${escapeHtml(i18n('The resource changed externally since this proposal was captured. Approve to retry against the current state, or reject.'))}</div>
        ${errLine}
    </div>`;
}

export function renderProposalCard(entry, handler, opts = {}) {
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    const helpers = { escapeHtml, formatTime, i18n };
    const body = handler.renderDiffCard(entry, helpers);
    return `<div class="iter_proposal_card iter_proposal_card_${escapeHtml(entry.status)}"
                 data-proposal-id="${escapeHtml(entry.id)}"
                 data-proposal-kind="${escapeHtml(entry.kind)}">
        <div class="iter_proposal_card_header">
            <span class="iter_proposal_card_icon">${escapeHtml(handler.icon(entry))}</span>
            <span class="iter_proposal_card_label">${escapeHtml(handler.label(entry))}</span>
            <span class="iter_proposal_card_target">${escapeHtml(handler.target(entry))}</span>
            ${statusChip(entry, i18n)}
        </div>
        <div class="iter_proposal_card_body">${body}</div>
        ${conflictBlock(entry, i18n)}
        ${controls(entry, handler, i18n)}
    </div>`;
}
