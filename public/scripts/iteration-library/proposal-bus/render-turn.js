// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    }[c]));
}

/**
 * Renders the "turn actions" row above a message's proposal cards.
 * Empty string when there's nothing to act on, OR when each group has
 * at most one item — a single-item "Approve all (1)" / "Rollback (1)"
 * just duplicates the per-card Approve / Rollback button the user
 * already sees. The row only earns its space when a bulk action saves
 * the user from clicking multiple per-card buttons.
 *
 * Inputs are pre-counted so bus.js doesn't have to scan twice — it
 * already walks entries to render cards, so the count is essentially
 * free at that point.
 */
export function renderTurnActions({ pendingCount, committedCount, messageId, i18n }) {
    const t = typeof i18n === 'function' ? i18n : (s) => String(s ?? '');
    const showPending = pendingCount > 1;
    const showRollback = committedCount > 1;
    if (!showPending && !showRollback) return '';
    const msgAttr = escapeHtml(messageId);
    const btns = [];
    if (showPending) {
        btns.push(`<button class="menu_button iter_proposal_turn_btn iter_proposal_turn_btn_approve" data-proposal-action="approve-all-pending" data-proposal-message-id="${msgAttr}">${escapeHtml(t('Approve all pending (${0})', String(pendingCount)))}</button>`);
        btns.push(`<button class="menu_button iter_proposal_turn_btn iter_proposal_turn_btn_reject" data-proposal-action="reject-all-pending" data-proposal-message-id="${msgAttr}">${escapeHtml(t('Reject all pending (${0})', String(pendingCount)))}</button>`);
    }
    if (showRollback) {
        btns.push(`<button class="menu_button iter_proposal_turn_btn iter_proposal_turn_btn_rollback" data-proposal-action="rollback-turn" data-proposal-message-id="${msgAttr}">${escapeHtml(t('Rollback this turn (${0})', String(committedCount)))}</button>`);
    }
    return `<div class="iter_proposal_turn_actions" data-proposal-message-id="${msgAttr}">${btns.join('')}</div>`;
}
