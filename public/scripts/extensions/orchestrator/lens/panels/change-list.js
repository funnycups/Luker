// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reviewable list of agent-field changes: one row per changed field, with an
// optional checkbox and a fold-out before / after. Used for AI proposals
// (pick what to apply) and the save review (read-only list).

import { h, clear, put } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat, agentName } from '../i18n.js';
import { fieldLabel, PROFILE } from '../model/edit.js';
import { button } from '../ui/components.js';

const ownerName = (change) => (change.agentId === PROFILE ? i18n('Profile structure') : agentName(change.agentId));

export function changeText(change) {
    return `${ownerName(change)} · ${fieldLabel(change.field) || change.field}`;
}

/** Character-level diff (common prefix / suffix) → highlighted spans. */
export function markDiff(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    // Long unchanged runs are shortened so the change is visible.
    const ctx = (text, from, to) => {
        const head = text.slice(0, from);
        const tail = text.slice(to);
        return [head.length > 160 ? `…${head.slice(-140)}` : head, text.slice(from, to), tail.length > 160 ? `${tail.slice(0, 140)}…` : tail];
    };
    const pieces = (text, from, to, cls) => {
        if (!text) return [h('span', { class: 'ol-diff-empty', text: i18n('(empty · follows default)') })];
        const [head, mid, tail] = ctx(text, from, to);
        return [head ? h('span', { text: head }) : null, mid ? h('mark', { class: cls, text: mid }) : null, tail ? h('span', { text: tail }) : null].filter(Boolean);
    };
    return { before: pieces(a, start, endA, 'is-del'), after: pieces(b, start, endB, 'is-add') };
}

export function diffBlock(change) {
    const { before, after } = markDiff(change.before || '', change.after || '');
    return h('div', { class: 'ol-change-detail' },
        h('div', { class: 'ol-diff-label', text: i18n('Original') }), h('p', { class: 'ol-diff-before' }, before),
        h('div', { class: 'ol-diff-label', text: i18n('Changed to') }), h('p', { class: 'ol-diff-after' }, after));
}

/**
 * @param {{ changes: object[], state?: 'pending'|'applied'|'discarded'|'undone'|'superseded'|'review',
 *   applied?: Set<string>, stale?: Set<string>, open?: boolean, onApply?(chosen: object[]): void,
 *   onDiscard?(): void, onUndo?(): void, onFocus?(change: object): void }} opts
 */
export function changeList(opts) {
    const { changes, state = 'pending', applied = new Set(), stale = new Set(), open = false, onApply, onDiscard, onUndo, onFocus } = opts;
    const chosen = new Set(changes.filter(c => !stale.has(c.id)).map(c => c.id));
    const checkable = state === 'pending';
    const el = h('section', { class: 'ol-changes', dataset: { state } });

    function row(change) {
        const isStale = stale.has(change.id);
        const box = checkable || state === 'applied' ? h('button', {
            type: 'button',
            role: 'checkbox',
            class: 'ol-check ol-check-hit',
            'aria-checked': String(checkable ? chosen.has(change.id) : applied.has(change.id)),
            'aria-label': changeText(change),
            disabled: !checkable || isStale,
            onClick: () => {
                if (chosen.has(change.id)) chosen.delete(change.id); else chosen.add(change.id);
                box.setAttribute('aria-checked', String(chosen.has(change.id)));
                paintFoot();
            },
        }, icon('check', { size: 11 })) : null;
        const detail = diffBlock(change);
        detail.hidden = !open;
        let caret = icon(open ? 'chevronUp' : 'chevronDown', { size: 12, className: 'ol-change-caret' });
        const text = h('button', {
            type: 'button',
            class: 'ol-change-text',
            'aria-expanded': String(open),
            onClick: () => {
                detail.hidden = !detail.hidden;
                text.setAttribute('aria-expanded', String(!detail.hidden));
                const next = icon(detail.hidden ? 'chevronDown' : 'chevronUp', { size: 12, className: 'ol-change-caret' });
                caret.replaceWith(next);
                caret = next;
                onFocus?.(change);
            },
        },
        h('span', { class: 'ol-change-agent', text: ownerName(change) }),
        h('span', { class: 'ol-change-field', text: fieldLabel(change.field) || change.field }),
        isStale ? h('span', { class: 'ol-change-stale', text: i18n('You edited this by hand'), title: i18n('You edited this by hand after the AI finished, so it cannot be applied directly') }) : null,
        caret);
        return h('li', { class: `ol-change${isStale ? ' is-stale' : ''}` }, h('div', { class: 'ol-change-line' }, box, text), detail);
    }

    const foot = h('div', { class: 'ol-changes-foot' });
    function paintFoot() {
        clear(foot);
        if (state === 'pending') {
            put(foot,
                button(i18nFormat('Apply selected (${0})', chosen.size), () => onApply?.(changes.filter(c => chosen.has(c.id))), { iconName: 'check', className: 'ol-btn-sm ol-btn-primary', disabled: !chosen.size }),
                button(i18n('Drop all'), () => onDiscard?.(), { className: 'ol-btn-sm ol-btn-ghost' }));
        } else if (state === 'applied') {
            put(foot,
                h('span', { class: 'ol-changes-state', text: i18nFormat('${0} put in the draft; applied after saving', applied.size) }),
                onUndo ? button(i18n('Undo this round'), () => onUndo(), { iconName: 'undo', className: 'ol-btn-sm ol-btn-ghost' }) : null);
        } else if (state !== 'review') {
            const text = { undone: i18n('Undone'), superseded: i18n('Replaced by the next round of edits'), discarded: i18n('Discarded') }[state] || '';
            put(foot, h('span', { class: 'ol-changes-state', text }));
        }
    }
    paintFoot();

    put(el,
        state === 'review' ? null : h('div', { class: 'ol-changes-head', text: state === 'pending' ? i18nFormat('The AI suggests ${0} edits', changes.length) : i18nFormat('The AI made ${0} edits', changes.length) }),
        h('ul', { class: 'ol-changes-list' }, changes.map(row)),
        state === 'review' ? null : foot);
    return el;
}
