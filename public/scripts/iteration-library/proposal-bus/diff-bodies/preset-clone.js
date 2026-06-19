// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Shared body renderer for preset-clone ProposalBus cards. Clone has no
 * diff-replacement semantics (it forks a new preset rather than mutating
 * one in place), so unlike skill / lorebook / profile-edit there is no
 * LCS-style body. Instead we surface the two facts the user needs before
 * approving:
 *
 *   1. What's going to happen — source name → new name, plus a hint that
 *      the open session migrates onto the cloned preset.
 *   2. That this kind is structurally non-rollbackable. The bus already
 *      reflects this by hiding the Rollback button on committed clone
 *      entries, but the card body re-states it up-front so the user
 *      doesn't approve under the assumption they can undo from the bus.
 *
 * Entry shape (set by the popup at propose time):
 *   entry.op   — { sourceName, newName, _oldRef? }
 *   entry.meta — opaque to this renderer; populated for tool-trace
 *                purposes by the popup
 */

function escapeHtmlLocal(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    }[c]));
}

/**
 * @param {Object} _snapshot  ProposalBus entry.snapshot (unused — clone
 *                            body has nothing to diff)
 * @param {Object} op         ProposalBus entry.op
 * @param {Object} helpers    { i18n: (s, ...args) => string }
 * @returns {string} HTML for the card body
 */
export function renderPresetCloneBody(_snapshot, op, helpers) {
    const i18n = typeof helpers?.i18n === 'function' ? helpers.i18n : (s) => String(s ?? '');
    const t = i18n;
    const tf = i18n;
    const src = String(op?.sourceName ?? '');
    const dst = String(op?.newName ?? '');
    const summary = src && dst
        ? tf('Will fork "${0}" into a new preset named "${1}" and switch the open session onto it.', src, dst)
        : t('Will fork the current preset into a new one and switch the open session onto it.');
    return `<div class="iter_proposal_preset_clone_body">
        <div class="iter_proposal_preset_clone_summary">${escapeHtmlLocal(summary)}</div>
        <div class="iter_proposal_preset_clone_warning">${escapeHtmlLocal(t('⚠ Cannot be auto-rolled back — the cloned preset stays on disk even after this card is undone.'))}</div>
    </div>`;
}
