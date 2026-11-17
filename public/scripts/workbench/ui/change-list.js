// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Change list card: one row per changed unit, a checkbox, a modified/added/removed
// tag and a fold-out before/after line diff. Footer: Apply selected / Discard all.

import { i18n, i18nFormat } from '../i18n.js';
import { h, put, clear } from '../../lens-shared/util.js';
import { button, checkRow } from '../../lens-shared/ui.js';
import { icon } from '../icons.js';
import { lineDiff, inlineMarks, changeSummary } from '../model/units.js';

function tagFor(kind) {
    if (kind === 'add') return [i18n('Added'), 'is-add'];
    if (kind === 'remove') return [i18n('Removed item'), 'is-del'];
    return [i18n('Edited'), ''];
}

function diffView(change) {
    const rows = lineDiff(change.before, change.after);
    const box = h('div', { class: 'wb-diff' });
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const next = rows[i + 1];
        if (r.type === 'del' && next?.type === 'add') {
            const { prefix, suffix } = inlineMarks(r.text, next.text);
            const mark = (text, cls) => h('div', { class: cls },
                text.slice(0, prefix),
                h('mark', { text: text.slice(prefix, text.length - suffix) }),
                text.slice(text.length - suffix));
            put(box, mark(r.text, 'is-del'), mark(next.text, 'is-add'));
            i++;
            continue;
        }
        put(box, h('div', { class: `is-${r.type}`, text: r.text || ' ' }));
    }
    return box;
}

/**
 * @param {{ changes: any[], state?: 'pending'|'applied'|'discarded'|'partial', target?: string,
 *           onApply: (keys: string[]) => void, onDiscard: () => void, onUndo?: (() => void) | null, note?: string }} opts
 */
export function changeList({ changes, state = 'pending', target = '', onApply, onDiscard, onUndo = null, note = '' }) {
    const picked = new Set(changes.map(c => c.key));
    const open = new Set(changes.length === 1 ? [changes[0].key] : []);
    const el = h('div', { class: `wb-chg is-${state}` });

    function paint() {
        clear(el);
        el.className = `wb-chg is-${state}`;
        const pending = state === 'pending';
        put(el, h('div', { class: 'wb-chg-head' },
            icon('list', { size: 14 }),
            h('b', { text: i18nFormat('${0} changes', changes.length) }),
            h('span', { class: 'wb-note', text: [changeSummary(changes), target].filter(Boolean).join(' · ') }),
            h('span', { class: 'wb-spacer' }),
            state === 'applied' ? h('span', { class: 'lw-pilltag is-ok', text: i18n('Applied') })
                : state === 'partial' ? h('span', { class: 'lw-pilltag is-ok', text: i18n('Partly applied') })
                    : state === 'discarded' ? h('span', { class: 'lw-pilltag', text: i18n('Discarded') }) : null));
        let group = '';
        for (const c of changes) {
            if (c.group && c.group !== group && new Set(changes.map(x => x.group)).size > 1) {
                group = c.group;
                put(el, h('div', { class: 'wb-chg-group', text: group }));
            }
            const [tag, cls] = tagFor(c.kind);
            const isOpen = open.has(c.key);
            const box = checkRow({
                checked: picked.has(c.key),
                disabled: !pending,
                ariaLabel: i18nFormat('Select "${0}"', c.label),
                className: 'wb-chg-box',
                renderIcon: icon,
                onChange: (checked) => {
                    if (checked) picked.add(c.key);
                    else picked.delete(c.key);
                    paint();
                },
            });
            put(el, h('div', { class: 'wb-chg-line' },
                box,
                h('div', { class: 'wb-chg-text' },
                    h('button', {
                        type: 'button',
                        class: 'wb-chg-label',
                        'aria-expanded': String(isOpen),
                        onClick: () => { if (isOpen) open.delete(c.key); else open.add(c.key); paint(); },
                    },
                    h('span', { text: c.label }),
                    icon(isOpen ? 'chevronDown' : 'chevronRight', { size: 12 })),
                    c.note ? h('div', { class: 'wb-chg-note', text: c.note }) : null,
                    isOpen ? diffView(c) : null),
                h('span', { class: `wb-chg-tag ${cls}`, text: tag })));
        }
        if (pending) {
            put(el, h('div', { class: 'wb-chg-foot' },
                h('span', { class: 'wb-note', text: note || i18n('Applied changes are written to Luker and can be undone in Change history') }),
                button(i18n('Discard everything'), () => onDiscard(), { ghost: true, renderIcon: icon }),
                button(i18nFormat('Apply selected (${0})', picked.size), () => onApply([...picked]), { primary: true, disabled: !picked.size, renderIcon: icon })));
        } else if (onUndo && (state === 'applied' || state === 'partial')) {
            put(el, h('div', { class: 'wb-chg-foot' }, h('span', { class: 'wb-spacer' }), button(i18n('Undo'), () => onUndo(), { iconName: 'undo', ghost: true, small: true, renderIcon: icon })));
        }
    }

    paint();
    return {
        el,
        setState(next) { state = next; paint(); },
    };
}
