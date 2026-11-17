// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small building blocks shared by workbench pages, built on top of lens-shared/ui.js.

import { i18n } from '../i18n.js';
import { h } from '../../lens-shared/util.js';
import {
    button as sharedButton,
    iconButton as sharedIconButton,
    checkRow as sharedCheckRow,
    segmented as sharedSegmented,
    selectInput,
} from '../../lens-shared/ui.js';
import { icon } from '../icons.js';

const TONE_KEYS = {
    memory: 'Memory graph',
    orch: 'Orchestration',
    preset: 'Preset',
    card: 'Character card',
    world: 'World book',
};

export function toneLabel(tone) {
    const key = TONE_KEYS[tone];
    return key ? i18n(key) : String(tone ?? '');
}

export function getTones() {
    return Object.fromEntries(Object.entries(TONE_KEYS).map(([k, v]) => [k, i18n(v)]));
}

export function iconButton(name, label, onClick, { className = '', disabled = false, pressed, size = 16 } = {}) {
    return sharedIconButton(name, label, onClick, { className, disabled, pressed, size, renderIcon: icon });
}

export function button(label, onClick, {
    iconName = '',
    className = '',
    primary = false,
    danger = false,
    ghost = false,
    small = false,
    disabled = false,
    title = '',
} = {}) {
    return sharedButton(label, onClick, {
        iconName,
        className,
        primary,
        danger,
        ghost,
        small,
        disabled,
        title,
        renderIcon: icon,
    });
}

/**
 * Small action row under a chat message.
 * items: { iconName, label, onClick, disabled?, done? }
 */
export function msgActions(items) {
    return h('div', { class: 'wb-msg-acts' }, items.filter(Boolean).map((it) => {
        const label = h('span', { text: it.label });
        const btn = h('button', {
            type: 'button',
            class: 'wb-msg-act',
            title: it.title || it.label,
            disabled: it.disabled,
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
    return h('span', { class: `lw-pilltag ${kind ? `is-${kind}` : ''}`.trim(), text });
}

/** Whole row toggles; never a native checkbox. */
export function checkRow({ checked, label = '', note = '', onChange, disabled = false, ariaLabel = '', className = '' }) {
    return sharedCheckRow({ checked, label, note, onChange, disabled, ariaLabel, className, renderIcon: icon });
}

/**
 * @param {{ value: string, label: string, tone?: string, iconName?: string, disabled?: boolean, hidden?: boolean, title?: string }[]} options
 */
export function segmented(options, value, onChange, { ariaLabel = '', className = '' } = {}) {
    return sharedSegmented(options, value, onChange, { ariaLabel, className, renderIcon: icon });
}

/** <select> with plain-text options. `follow` greys it out when the first option is picked. */
export function select(options, value, onChange, { ariaLabel = '', follow = false, className = '', disabled = false } = {}) {
    return selectInput(options, value, onChange, { ariaLabel, follow, className, disabled });
}

export function sectionTitle(text, extra = null) {
    return h('div', { class: 'wb-sec-title' }, h('span', { text }), extra);
}

export function loading(text = i18n('Reading data…')) {
    return h('div', { class: 'wb-loading' }, h('span', { class: 'wb-spinner', 'aria-hidden': 'true' }), h('span', { text }));
}
