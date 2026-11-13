// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Presentational building blocks for Memory Lens: delegates shared primitives
// to platform `lens-shared/ui.js` and keeps memory-specific badges/chips.

import { h } from '../../../../lens-shared/util.js';
import {
    button as sharedButton,
    iconButton as sharedIconButton,
    switchControl as sharedSwitchControl,
    segmented as sharedSegmented,
    checkRow as sharedCheckRow,
    sectionTitle as sharedSectionTitle,
    emptyState as sharedEmptyState,
    selectInput,
    formField,
} from '../../../../lens-shared/ui.js';
import { icon } from '../icons.js';
import { typeVisual } from '../model.js';
import { i18n, typeLabel } from '../i18n.js';

export { selectInput, formField };

function translateTokenClasses(className, map) {
    const extra = [];
    const flags = {};
    for (const cls of String(className || '').split(/\s+/).filter(Boolean)) {
        if (Object.hasOwn(map, cls)) flags[map[cls]] = true;
        else extra.push(cls);
    }
    return { extra: extra.join(' '), flags };
}

export function iconButton(name, label, onClick, { className = '', pressed, disabled = false, size = 16 } = {}) {
    const mapped = String(className || '').replace(/\bml-iconbtn-sm\b/g, 'is-sm').trim();
    return sharedIconButton(name, label, onClick, { className: mapped, pressed, disabled, size, renderIcon: icon });
}

export function button(label, onClick, { iconName = '', className = '', primary = false, danger = false, ghost = false, small = false, disabled = false, title = '' } = {}) {
    const { extra, flags } = translateTokenClasses(className, {
        'ml-btn-primary': 'primary',
        'ml-btn-danger': 'danger',
        'ml-btn-ghost': 'ghost',
        'ml-btn-sm': 'small',
    });
    return sharedButton(label, onClick, {
        iconName,
        className: extra,
        primary: primary || Boolean(flags.primary),
        danger: danger || Boolean(flags.danger),
        ghost: ghost || Boolean(flags.ghost),
        small: small || Boolean(flags.small),
        disabled,
        title,
        renderIcon: icon,
    });
}

export function switchControl(label, checked, onChange, opts = {}) {
    return sharedSwitchControl(label, checked, onChange, opts);
}

/**
 * @param {{value:string,label:string,icon?:string,iconName?:string,badge?:string|number}[]} options
 */
export function segmented(options, value, onChange, { ariaLabel = '', className = '', iconOnlyMobile = false } = {}) {
    const mapped = String(className || '')
        .replace(/\bml-seg-sm\b/g, 'is-sm')
        .replace(/\bml-seg-block\b/g, 'is-block')
        .replace(/\bml-seg-scroll\b/g, 'is-scroll')
        .trim();
    return sharedSegmented(options, value, onChange, {
        ariaLabel,
        className: mapped,
        iconOnlyMobile,
        renderIcon: icon,
    });
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
    return sharedEmptyState(iconName, title, hint, action, { renderIcon: icon });
}

export function sectionTitle(text, extra = null) {
    return sharedSectionTitle(text, extra);
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
export function checkRow({ checked, label, note = '', onChange, className = '', disabled = false, ariaLabel = '' }) {
    return sharedCheckRow({ checked, label, note, onChange, className, disabled, ariaLabel, renderIcon: icon });
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
