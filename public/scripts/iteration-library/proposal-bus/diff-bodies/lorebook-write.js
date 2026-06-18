// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Shared body renderer for lorebook-write ProposalBus cards. Mirrors the
 * pre-bus `renderLorebookDiffBody` in orch iter-studio (commit 3de0c3ecc):
 * strips the `uid` (it's the address, not a payload field), feeds the
 * before/after entry to ITER_UI.diff.renderDiffCard with a translated
 * field label map so users see "label" instead of "comment" etc.
 *
 * Entry shape (set by the popup at propose time):
 *   entry.op    — { kind: 'update' | 'str_replace', args: { book_name, uid, ... } }
 *   entry.meta  — { bookName, uid, before, after }
 */

import * as ITER_UI from '../../ui/index.js';

// Keys mirror SillyTavern's worldInfo entry JSON shape so any field the
// update tool can touch has a friendlier label. Frozen for cheap reuse.
export const LOREBOOK_FIELD_LABELS = Object.freeze({
    content: 'content',
    comment: 'label',
    disable: 'disabled',
    key: 'keys',
    keysecondary: 'secondary keys',
    constant: 'always-active',
    order: 'order',
    position: 'position',
    depth: 'depth',
    probability: 'probability',
    useProbability: 'use probability',
    selectiveLogic: 'selective logic',
    excludeRecursion: 'exclude recursion',
    preventRecursion: 'prevent recursion',
    delayUntilRecursion: 'delay until recursion',
    scanDepth: 'scan depth',
    caseSensitive: 'case sensitive',
    matchWholeWords: 'match whole words',
    useGroupScoringSourceForCheck: 'use group scoring',
    automationId: 'automation id',
});

function escapeHtmlLocal(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    }[c]));
}

function stripUid(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    // eslint-disable-next-line no-unused-vars
    const { uid, ...rest } = obj;
    return rest;
}

/**
 * @param {Object} entry  ProposalBus entry
 * @param {Object} helpers  { i18n: (s) => string }
 * @returns {string} HTML for the card body
 */
export function renderLorebookBody(entry, helpers) {
    const i18n = typeof helpers?.i18n === 'function' ? helpers.i18n : (s) => String(s ?? '');
    const t = i18n;
    const meta = entry?.meta || {};
    const beforeObj = (meta.before && typeof meta.before === 'object') ? meta.before : {};
    const afterObj = (meta.after && typeof meta.after === 'object') ? meta.after : {};
    const edit = {
        op: 'set',
        path: '',
        oldValue: stripUid(beforeObj),
        newValue: stripUid(afterObj),
    };
    const html = ITER_UI.diff.renderDiffCard([edit], {
        i18n: t,
        fieldLabels: LOREBOOK_FIELD_LABELS,
        // Live snapshot is the BEFORE side itself: lorebook proposals
        // re-derive against the on-disk entry at commit time, so passing
        // `before` as `live` is correct for str-op resolution.
        live: stripUid(beforeObj),
    });
    if (!html) {
        return `<div class="orch_it_lbk_nochange">${escapeHtmlLocal(t('No field changes'))}</div>`;
    }
    return html;
}

export function lorebookLabel(entry, helpers) {
    const i18n = typeof helpers?.i18n === 'function' ? helpers.i18n : (s) => String(s ?? '');
    const kind = entry?.op?.kind || '';
    return kind === 'str_replace'
        ? i18n('Patch lorebook entry text')
        : i18n('Update lorebook entry');
}

export function lorebookIcon(entry) {
    return entry?.op?.kind === 'str_replace' ? '🩹' : '✏️';
}

export function lorebookTarget(entry) {
    const meta = entry?.meta || {};
    const args = entry?.op?.args || {};
    const bookName = meta.bookName ?? args.book_name ?? '';
    const uid = meta.uid != null ? String(meta.uid) : (args.uid != null ? String(args.uid) : '');
    if (!bookName && !uid) return '';
    return uid ? `${bookName}#${uid}` : String(bookName);
}
