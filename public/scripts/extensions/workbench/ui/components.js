// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small building blocks shared by every page.

import { i18n } from '../i18n.js';
import { h } from '../../lens-shared/util.js';
import { icon } from '../icons.js';

export const TONES = { memory: i18n('Memory graph'), orch: i18n('Orchestration'), preset: i18n('Preset'), card: i18n('Character card'), world: i18n('World book') };

export function iconButton(name, label, onClick, { className = '', disabled = false } = {}) {
    return h('button', { type: 'button', class: `wb-ibtn ${className}`.trim(), title: label, 'aria-label': label, disabled, onClick }, icon(name));
}

export function button(label, onClick, { iconName = '', className = '', disabled = false, title = '' } = {}) {
    return h('button', { type: 'button', class: `wb-btn ${className}`.trim(), disabled, title: title || null, onClick },
        iconName ? icon(iconName, { size: 14 }) : null,
        h('span', { text: label }));
}

/**
 * Small action row under a chat message.
 * items: { iconName, label, onClick, disabled?, done? } — `done` = text shown
 * briefly after a successful click (e.g. Copied).
 */
export function msgActions(items) {
    return h('div', { class: 'wb-msg-acts' }, items.filter(Boolean).map((it) => {
        const label = h('span', { text: it.label });
        const btn = h('button', {
            type: 'button', class: 'wb-msg-act', title: it.title || it.label, disabled: it.disabled,
            onClick: async () => {
                const ok = await it.onClick();
                if (it.done && ok !== false) {
                    label.textContent = it.done;
                    btn.classList.add('is-done');
                    setTimeout(() => { label.textContent = it.label; btn.classList.remove('is-done'); }, 1400);
                }
            },
        }, icon(it.iconName, { size: 13 }), label);
        return btn;
    }));
}

export function link(label, onClick, { iconName = '' } = {}) {
    return h('button', { type: 'button', class: 'wb-link', onClick }, iconName ? icon(iconName, { size: 12 }) : null, h('span', { text: label }));
}

/** Coloured square for a workbench (memory / orch / preset / card / …). */
export function dot(tone) {
    return h('span', { class: 'wb-dot', style: { '--tone': `var(--wb-t-${tone})` }, 'aria-hidden': 'true' });
}

export function pillTag(text, kind = '') {
    return h('span', { class: `wb-pilltag ${kind ? `is-${kind}` : ''}`.trim(), text });
}

/** Whole row toggles; never a native checkbox. */
export function checkRow({ checked, label = '', note = '', onChange, disabled = false, ariaLabel = '' }) {
    let value = Boolean(checked);
    const row = h('button', {
        type: 'button', role: 'checkbox', class: 'wb-check', disabled,
        'aria-checked': String(value), 'aria-label': ariaLabel || null,
        onClick: () => { value = !value; row.setAttribute('aria-checked', String(value)); onChange?.(value); },
    },
    h('span', { class: 'wb-check-box', 'aria-hidden': 'true' }, icon('check', { size: 11 })),
    label || note ? h('span', { class: 'wb-check-text' }, label ? h('span', { text: label }) : null, note ? h('span', { class: 'wb-check-note', text: note }) : null) : null);
    return row;
}

/**
 * @param {{ value: string, label: string, tone?: string, iconName?: string, disabled?: boolean, hidden?: boolean }[]} options
 */
export function segmented(options, value, onChange, { ariaLabel = '', className = '' } = {}) {
    return h('div', { class: `wb-seg ${className}`.trim(), role: 'group', 'aria-label': ariaLabel || null },
        options.filter(o => !o.hidden).map(o => h('button', {
            type: 'button', class: 'wb-seg-btn', disabled: o.disabled,
            'aria-pressed': String(o.value === value), title: o.title || null,
            onClick: () => { if (o.value !== value) onChange(o.value); },
        },
        o.tone ? dot(o.tone) : null,
        o.iconName ? icon(o.iconName, { size: 13 }) : null,
        h('span', { text: o.label }))));
}

/** <select> with plain-text options. `follow` greys it out when the first option is picked. */
export function select(options, value, onChange, { ariaLabel = '', follow = false } = {}) {
    const el = h('select', { class: 'wb-select', 'aria-label': ariaLabel || null },
        options.map(o => h('option', { value: o.value, text: o.label })));
    el.value = value;
    const paint = () => el.classList.toggle('is-follow', follow && el.value === options[0]?.value);
    paint();
    el.addEventListener('change', () => { paint(); onChange(el.value); });
    return el;
}

export function sectionTitle(text, extra = null) {
    return h('div', { class: 'wb-sec-title' }, h('span', { text }), extra);
}

export function loading(text = i18n('Reading data…')) {
    return h('div', { class: 'wb-loading' }, h('span', { class: 'wb-spinner', 'aria-hidden': 'true' }), h('span', { text }));
}

export function isTouch() {
    return Boolean(globalThis.matchMedia?.('(hover: none) and (pointer: coarse)').matches);
}
