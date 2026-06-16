// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * lorebook-write KindHandler — wraps the CEA helper
 * `applyCharacterEditorLorebookProposal(context, {kind, args})` so any
 * popup can stage lorebook update / str_replace writes as ProposalBus
 * entries.
 *
 * Op shape: { kind: 'update' | 'str_replace', args: { book_name, uid, ... } }
 *   The args object is the original tool-call payload — passed unchanged
 *   to the underlying helper at commit time so its drift-against-disk
 *   guards (unique-substring match, etc.) still fire.
 *
 * Snapshot is a single entry object captured at propose time. readCurrent
 * reloads the book through the injected loadWorldInfo and pulls the same
 * uid; fingerprint mismatch -> conflict (someone edited the book between
 * propose and approve).
 */

import { sha256OfJson } from '../drift-hash.js';

const DEFAULT_LABEL = 'Lorebook write';
const DEFAULT_ICON = '📚';

function pickEntry(book, uid) {
    if (!book || typeof book !== 'object') return null;
    const entries = book.entries;
    if (!entries || typeof entries !== 'object') return null;
    const key = String(uid);
    if (!Object.prototype.hasOwnProperty.call(entries, key)) return null;
    const raw = entries[key];
    if (!raw || typeof raw !== 'object') return null;
    return raw;
}

function inverseFromSnapshot(op, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const args = (op && op.args && typeof op.args === 'object') ? op.args : {};
    const restored = { ...snapshot };
    return {
        kind: 'update',
        args: {
            book_name: args.book_name,
            uid: args.uid,
            ...restored,
        },
    };
}

function defaultRenderDiff(_before, _op, helpers) {
    const t = helpers && typeof helpers.i18n === 'function' ? helpers.i18n : (s) => String(s ?? '');
    return `<div class="iter_proposal_diff_placeholder">${t('Lorebook write — no diff renderer registered')}</div>`;
}

export function createLorebookWriteHandler(opts = {}) {
    if (!opts || typeof opts.applyProposal !== 'function') {
        throw new Error('createLorebookWriteHandler: applyProposal is required');
    }
    if (typeof opts.loadWorldInfo !== 'function') {
        throw new Error('createLorebookWriteHandler: loadWorldInfo is required');
    }
    const applyProposal = opts.applyProposal;
    const loadWorldInfo = opts.loadWorldInfo;
    const renderDiff = typeof opts.renderDiff === 'function' ? opts.renderDiff : defaultRenderDiff;
    const labelFn = typeof opts.label === 'function' ? opts.label : null;
    const iconFn = typeof opts.icon === 'function' ? opts.icon : null;
    const targetFn = typeof opts.target === 'function' ? opts.target : null;

    async function fingerprint(snapshot) {
        return sha256OfJson(snapshot ?? null);
    }

    async function readCurrent(op) {
        const args = (op && op.args && typeof op.args === 'object') ? op.args : {};
        const bookName = args.book_name;
        let book = null;
        try {
            book = await loadWorldInfo(bookName);
        } catch {
            book = null;
        }
        const snapshot = pickEntry(book, args.uid);
        return { snapshot, fingerprint: await fingerprint(snapshot) };
    }

    async function commit(op, ctx) {
        const kind = op?.kind;
        const args = (op && op.args && typeof op.args === 'object') ? op.args : {};
        return applyProposal(ctx, { kind, args });
    }

    function inverse(op, snapshot) {
        return inverseFromSnapshot(op, snapshot);
    }

    function renderDiffCard(entry, helpers) {
        return renderDiff(entry?.snapshot, entry?.op, helpers || {});
    }

    function label(entry) {
        if (labelFn) return labelFn(entry);
        const kind = entry?.op?.kind || '';
        return kind ? `Lorebook ${kind}` : DEFAULT_LABEL;
    }
    function icon(entry) {
        return iconFn ? iconFn(entry) : DEFAULT_ICON;
    }
    function target(entry) {
        if (targetFn) return targetFn(entry);
        const args = entry?.op?.args || {};
        const bookName = args.book_name ?? '';
        const uid = args.uid != null ? String(args.uid) : '';
        if (!bookName && !uid) return '';
        return uid ? `${bookName}#${uid}` : String(bookName);
    }

    return {
        fingerprint,
        readCurrent,
        commit,
        inverse,
        renderDiffCard,
        label,
        icon,
        target,
        inverseAvailable: true,
    };
}
