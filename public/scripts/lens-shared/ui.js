// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared UI primitives for the lens and workbench surfaces. All DOM nodes are
// built with h() using textContent / createTextNode — never innerHTML.

import { h } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const SHARED_ICON_PATHS = {
    check: 'M5 12.5l4.5 4.5L19 7.5',
    x: 'M6 6l12 12M18 6L6 18',
    info: `${circle(12, 12, 9)}M12 11v5M12 7.5v.01`,
    alert: `${circle(12, 12, 9)}M12 7.5v5.5M12 16.5v.01`,
    plus: 'M12 5v14M5 12h14',
    copy: 'M9 9h10v11H9zM15 9V4H5v11h4',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    gear: `M4 7h9M17 7h3M4 17h3M11 17h9${circle(15, 7, 2)}${circle(9, 17, 2)}`,
    undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
    search: `${circle(11, 11, 7)}M20 20l-4-4`,
    refresh: 'M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4',
    sun: `${circle(12, 12, 4)}M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4`,
    moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
    chevronDown: 'M6 9l6 6 6-6',
    chevronRight: 'M9 6l6 6-6 6',
};

const i18n = (text) => globalThis.Luker?.getContext?.()?.translate?.(text) ?? String(text ?? '');

export function sharedIcon(name, { size = 16, className = '', label = '' } = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    if (className) svg.setAttribute('class', className);
    if (label) {
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', label);
    } else {
        svg.setAttribute('aria-hidden', 'true');
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', SHARED_ICON_PATHS[name] || SHARED_ICON_PATHS.info);
    svg.appendChild(path);
    return svg;
}

function resolveIcon(nameOrNode, size, renderIcon = sharedIcon) {
    if (!nameOrNode) return null;
    if (nameOrNode instanceof Node) return nameOrNode;
    return renderIcon(nameOrNode, { size });
}

export function button(label, onClick, {
    iconName = '',
    icon = null,
    renderIcon = sharedIcon,
    className = '',
    primary = false,
    danger = false,
    ghost = false,
    small = false,
    disabled = false,
    title = '',
} = {}) {
    const classes = [
        'lw-btn',
        primary ? 'is-primary' : '',
        danger ? 'is-danger' : '',
        ghost ? 'is-ghost' : '',
        small ? 'is-sm' : '',
        className,
    ].filter(Boolean).join(' ');
    const iconEl = icon instanceof Node ? icon : (iconName ? resolveIcon(iconName, 14, renderIcon) : null);
    return h('button', { type: 'button', class: classes, disabled, title: title || null, onClick },
        iconEl,
        h('span', { text: label }));
}

export function iconButton(name, label, onClick, {
    className = '',
    pressed,
    disabled = false,
    renderIcon = sharedIcon,
    icon = null,
    size = 16,
} = {}) {
    const btn = h('button', {
        type: 'button',
        class: `lw-ibtn ${className}`.trim(),
        title: label,
        'aria-label': label,
        disabled,
        onClick,
    }, resolveIcon(icon || name, size, renderIcon));
    if (pressed !== undefined) btn.setAttribute('aria-pressed', String(Boolean(pressed)));
    return btn;
}

export function switchControl(label, checked, onChange, { className = '', disabled = false } = {}) {
    let value = Boolean(checked);
    const btn = h('button', {
        type: 'button',
        role: 'switch',
        class: `lw-switch ${className}`.trim(),
        'aria-checked': String(value),
        disabled,
        onClick: () => {
            value = !value;
            btn.setAttribute('aria-checked', String(value));
            onChange?.(value);
        },
    },
    h('span', { class: 'lw-switch-label', text: label }),
    h('span', { class: 'lw-switch-track', 'aria-hidden': 'true' },
        h('span', { class: 'lw-switch-thumb' })));
    return btn;
}

/**
 * @param {{ value: string, label: string, tone?: string, iconName?: string, icon?: string | Node, badge?: string | number, dirty?: boolean, disabled?: boolean, hidden?: boolean, title?: string }[]} options
 */
export function segmented(options, value, onChange, {
    ariaLabel = '',
    className = '',
    renderIcon = sharedIcon,
    iconOnlyMobile = false,
} = {}) {
    const classes = ['lw-seg', iconOnlyMobile ? 'lw-seg-compact' : '', className].filter(Boolean).join(' ');
    return h('div', { class: classes, role: 'group', 'aria-label': ariaLabel || null },
        options.filter(o => !o.hidden).map(o => h('button', {
            type: 'button',
            class: 'lw-seg-btn',
            disabled: o.disabled,
            dataset: o.dirty ? { dirty: 'true' } : null,
            'aria-pressed': String(o.value === value),
            'aria-label': o.ariaLabel || (iconOnlyMobile ? o.label : null),
            title: o.title || (iconOnlyMobile ? o.label : null),
            onClick: () => { if (o.value !== value) onChange?.(o.value); },
        },
        o.tone ? h('span', { class: 'lw-dot', style: { '--tone': `var(--lw-t-${o.tone}, var(--lw-faint))` }, 'aria-hidden': 'true' }) : null,
        (o.icon || o.iconName) ? resolveIcon(o.icon || o.iconName, 14, renderIcon) : null,
        h('span', { class: 'lw-seg-label', text: o.label }),
        o.badge !== undefined ? h('span', { class: 'lw-seg-badge', text: String(o.badge) }) : null,
        o.dirty ? h('span', { class: 'lw-dirty-dot', 'aria-hidden': 'true' }) : null)));
}

export function checkRow({
    checked,
    label = '',
    note = '',
    onChange,
    disabled = false,
    ariaLabel = '',
    className = '',
    renderIcon = sharedIcon,
}) {
    let value = Boolean(checked);
    const row = h('button', {
        type: 'button',
        role: 'checkbox',
        class: `lw-check ${className}`.trim(),
        disabled,
        'aria-checked': String(value),
        'aria-label': ariaLabel || null,
        onClick: () => {
            value = !value;
            row.setAttribute('aria-checked', String(value));
            onChange?.(value);
        },
    },
    h('span', { class: 'lw-check-box', 'aria-hidden': 'true' }, resolveIcon('check', 11, renderIcon)),
    label || note
        ? h('span', { class: 'lw-check-text' },
            label ? h('span', { class: 'lw-check-label', text: label }) : null,
            note ? h('span', { class: 'lw-check-note', text: note }) : null)
        : null);
    return row;
}

export function sectionTitle(text, extra = null, { className = '' } = {}) {
    return h('div', { class: `lw-sec-title ${className}`.trim() }, h('span', { text }), extra);
}

export function emptyState(iconName, title, hint = '', action = null, {
    className = '',
    renderIcon = sharedIcon,
} = {}) {
    return h('div', { class: `lw-empty ${className}`.trim() },
        iconName ? h('div', { class: 'lw-empty-icon' }, resolveIcon(iconName, 22, renderIcon)) : null,
        h('div', { class: 'lw-empty-title', text: title }),
        hint ? h('div', { class: 'lw-empty-hint', text: hint }) : null,
        action);
}

/** @param {{ value: string, label: string, disabled?: boolean }[]} options */
export function selectInput(options, value, onChange = null, {
    ariaLabel = '',
    follow = false,
    className = '',
    disabled = false,
} = {}) {
    const el = h('select', {
        class: `lw-select ${className}`.trim(),
        'aria-label': ariaLabel || null,
        disabled,
    }, options.map(o => h('option', { value: o.value, text: o.label, disabled: o.disabled })));
    el.value = String(value ?? '');
    const paint = () => el.classList.toggle('is-follow', Boolean(follow) && el.value === options[0]?.value);
    paint();
    el.addEventListener('change', () => {
        paint();
        onChange?.(el.value);
    });
    return el;
}

export function formField(label, control, { className = '' } = {}) {
    return h('label', { class: `lw-field ${className}`.trim() },
        h('span', { class: 'lw-field-label', text: label }),
        control);
}

/**
 * Confirmation dialog mounted on `host` (defaults to `document.body`).
 * Accepts `(host, options)` or `(options)`. Resolves `true` on confirm, `false` on cancel.
 */
export function confirmDialog(hostOrOptions, maybeOptions) {
    const hasHost = hostOrOptions instanceof Node;
    const options = (hasHost ? maybeOptions : hostOrOptions) || {};
    const host = hasHost ? hostOrOptions : (options.host || document.body);
    const {
        title = '',
        message = '',
        lines = [],
        okLabel = '',
        cancelLabel = '',
        danger = false,
        theme = '',
        onOk = null,
        onCancel = null,
    } = options;

    const surfaceSelector = '.lw-surface, .wbench, .mlens, .olens, .rpdock';
    const hasSurfaceAncestor = host instanceof Element && Boolean(host.closest(surfaceSelector));
    const resolvedTheme = !hasSurfaceAncestor
        ? (theme || document.documentElement?.dataset?.theme || '')
        : '';

    const textLines = [message, ...(Array.isArray(lines) ? lines : [])]
        .map(line => String(line ?? '').trim())
        .filter(Boolean);

    const returnFocus = document.activeElement;
    let settled = false;
    let busy = false;

    return new Promise((resolve) => {
        const close = (result) => {
            if (settled) return;
            settled = true;
            backdrop.remove();
            if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') {
                returnFocus.focus({ preventScroll: true });
            }
            if (!result) onCancel?.();
            resolve(result);
        };

        const cancelBtn = button(cancelLabel || i18n('Cancel'), () => close(false), { ghost: true });
        const confirmBtn = button(okLabel || i18n('Confirm'), async () => {
            if (busy) return;
            busy = true;
            try {
                const outcome = await onOk?.();
                if (outcome === false) return;
                close(true);
            } finally {
                busy = false;
            }
        }, { primary: !danger, danger });

        const panel = h('div', {
            class: 'lw-dialog',
            role: 'alertdialog',
            'aria-modal': 'true',
            'aria-label': title || null,
            tabIndex: -1,
        },
        h('header', { class: 'lw-dialog-head' }, h('h3', { class: 'lw-dialog-title', text: title })),
        h('div', { class: 'lw-dialog-body' },
            h('div', { class: 'lw-confirm-text' }, textLines.map(line => h('p', { text: line })))),
        h('footer', { class: 'lw-dialog-foot' }, cancelBtn, confirmBtn));

        const backdrop = h('div', {
            class: hasSurfaceAncestor ? 'lw-dialog-backdrop' : 'lw-dialog-backdrop lw-surface',
            dataset: resolvedTheme ? { theme: resolvedTheme } : null,
            onMousedown: (event) => { if (event.target === backdrop) close(false); },
            onKeydown: (event) => {
                event.stopPropagation();
                if (event.key === 'Escape') close(false);
            },
        }, panel);

        host.appendChild(backdrop);
        globalThis.requestAnimationFrame?.(() => confirmBtn.focus({ preventScroll: true }));
    });
}
