// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small presentational building blocks shared by panels and views.

import { h } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { typeVisual } from '../model.js';
import { i18n, typeLabel } from '../i18n.js';

export function iconButton(name, label, onClick, { className = '', pressed, disabled = false } = {}) {
    const btn = h('button', {
        type: 'button',
        class: `ml-iconbtn ${className}`.trim(),
        title: label,
        'aria-label': label,
        disabled,
        onClick,
    }, icon(name));
    if (pressed !== undefined) btn.setAttribute('aria-pressed', String(Boolean(pressed)));
    return btn;
}

export function button(label, onClick, { iconName = '', className = '', disabled = false, title = '' } = {}) {
    return h('button', { type: 'button', class: `ml-btn ${className}`.trim(), disabled, title: title || null, onClick },
        iconName ? icon(iconName, { size: 14 }) : null,
        h('span', { text: label }));
}

export function switchControl(label, checked, onChange) {
    return h('button', {
        type: 'button',
        role: 'switch',
        class: 'ml-switch',
        'aria-checked': String(Boolean(checked)),
        onClick: () => onChange(!checked),
    }, h('span', { class: 'ml-switch-label', text: label }), h('span', { class: 'ml-switch-track' }, h('span', { class: 'ml-switch-thumb' })));
}

/**
 * @param {{value:string,label:string,icon?:string,badge?:string|number}[]} options
 */
export function segmented(options, value, onChange, { ariaLabel = '', className = '', iconOnlyMobile = false } = {}) {
    return h('div', { class: `ml-seg ${iconOnlyMobile ? 'ml-seg-compact' : ''} ${className}`.trim(), role: 'group', 'aria-label': ariaLabel || null },
        options.map(option => h('button', {
            type: 'button',
            class: 'ml-seg-btn',
            'aria-pressed': String(option.value === value),
            title: option.title || null,
            onClick: () => { if (option.value !== value) onChange(option.value); },
        },
        option.icon ? icon(option.icon, { size: 14 }) : null,
        h('span', { class: 'ml-seg-label', text: option.label }),
        option.badge !== undefined ? h('span', { class: 'ml-seg-badge', text: String(option.badge) }) : null)));
}

export function typeDot(type, { size = 10 } = {}) {
    const visual = typeVisual(type);
    return h('span', {
        class: 'ml-dot',
        'aria-hidden': 'true',
        dataset: { tone: visual.tone, shape: visual.shape },
        style: { '--ml-dot-size': `${size}px` },
    });
}

export function typeChip(type) {
    return h('span', { class: 'ml-typechip', dataset: { tone: typeVisual(type).tone } }, typeDot(type, { size: 8 }), h('span', { text: typeLabel(type) }));
}

const CTX_LABEL = { recalled: 'Recalled this turn', pinned: 'Always injected', candidate: 'Candidate pool' };

export function contextBadge(ctx) {
    if (!ctx || ctx === 'candidate') return null;
    return h('span', { class: 'ml-ctx', dataset: { ctx } }, h('span', { class: 'ml-ctx-dot', 'aria-hidden': 'true' }), h('span', { text: i18n(CTX_LABEL[ctx]) }));
}

/** Clickable reference to another node. */
export function nodeLink(node, onSelect, { meta = '', compact = false } = {}) {
    return h('button', {
        type: 'button',
        class: `ml-nodelink ${compact ? 'is-compact' : ''}`.trim(),
        dataset: { tone: typeVisual(node.type).tone },
        title: node.title,
        onClick: (event) => { event.stopPropagation(); onSelect(node.id); },
    }, typeDot(node.type, { size: 8 }), h('span', { class: 'ml-nodelink-title', text: node.title }), meta ? h('span', { class: 'ml-nodelink-meta', text: meta }) : null);
}

export function emptyState(iconName, title, hint = '', action = null) {
    return h('div', { class: 'ml-empty' },
        h('div', { class: 'ml-empty-icon' }, icon(iconName, { size: 22 })),
        h('div', { class: 'ml-empty-title', text: title }),
        hint ? h('div', { class: 'ml-empty-hint', text: hint }) : null,
        action);
}

export function sectionTitle(text, extra = null) {
    return h('div', { class: 'ml-section-title' }, h('span', { text }), extra);
}

export function kbd(...keys) {
    return h('span', { class: 'ml-kbd-group' }, keys.map(key => h('kbd', { class: 'ml-kbd', text: modKey(key) })));
}

// ----- Platform -------------------------------------------------------------

/** macOS / iOS use ⌘ for shortcuts; everything else uses Ctrl. */
export function isMac() {
    const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
    return /Mac|iPhone|iPad|iPod/i.test(platform);
}

/** Touch-first device (phone / tablet): no physical keyboard assumed. */
export function isTouch() {
    return Boolean(globalThis.matchMedia?.('(hover: none) and (pointer: coarse)').matches);
}

/** 'Mod' → ⌘ on Mac, Ctrl elsewhere. */
export function modKey(key = 'Mod') {
    return key === 'Mod' ? (isMac() ? '⌘' : 'Ctrl') : key;
}

/** Replaces {mod} in a hint string with the platform's modifier. */
export function withMod(text) {
    return String(text).replace(/\{mod\}/g, modKey());
}

/**
 * Checkbox with its text: clicking anywhere on the row toggles it once.
 * @param {{ checked: boolean, label: string, note?: string, onChange(value: boolean): void, className?: string }} opts
 */
export function checkRow({ checked, label, note = '', onChange, className = '' }) {
    let value = Boolean(checked);
    const box = h('span', { class: 'ml-check', 'aria-hidden': 'true' }, icon('check', { size: 11 }));
    const row = h('button', {
        type: 'button',
        role: 'checkbox',
        class: `ml-checkrow ${className}`.trim(),
        'aria-checked': String(value),
        onClick: () => {
            value = !value;
            row.setAttribute('aria-checked', String(value));
            onChange?.(value);
        },
    },
    box,
    h('span', { class: 'ml-checkrow-text' },
        h('span', { class: 'ml-checkrow-label', text: label }),
        note ? h('span', { class: 'ml-checkrow-note', text: note }) : null));
    return row;
}

/** Renders `text` with case-insensitive occurrences of `query` wrapped in <mark>. */
export function highlight(text, query) {
    const value = String(text ?? '');
    const needle = String(query ?? '').trim().toLowerCase().split(/\s+/)[0] || '';
    const frag = document.createDocumentFragment();
    if (!needle) {
        frag.append(value);
        return frag;
    }
    const lower = value.toLowerCase();
    let cursor = 0;
    let index = lower.indexOf(needle);
    while (index >= 0) {
        if (index > cursor) frag.append(value.slice(cursor, index));
        frag.append(h('mark', { text: value.slice(index, index + needle.length) }));
        cursor = index + needle.length;
        index = lower.indexOf(needle, cursor);
    }
    if (cursor < value.length) frag.append(value.slice(cursor));
    return frag;
}
