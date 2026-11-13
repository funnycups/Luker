// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Confirm / form modal shown over the lens.

import { h } from '../../../../lens-shared/util.js';
import { i18n } from '../i18n.js';
import { button, formField, selectInput } from '../ui/components.js';

export { formField, selectInput };

/**
 * @param {object} app
 * @param {{ title: string, content: Node, okLabel?: string, danger?: boolean, onOk?: () => any, wide?: boolean }} options
 *   onOk may return false to keep the modal open. Without okLabel there is only a close button.
 */
export function openModal(app, { title, content, okLabel = '', danger = false, onOk = null, wide = true }) {
    let unregister = null;
    const close = () => {
        unregister?.();
        unregister = null;
        backdrop.remove();
    };
    const ok = okLabel ? button(okLabel, async () => {
        if (await onOk?.() !== false) close();
    }, { primary: !danger, danger }) : null;
    const panel = h('div', { class: `ml-dialog ml-schema-modal ${wide ? 'is-wide' : ''}`.trim(), role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title, tabIndex: -1 },
        h('header', { class: 'ml-dialog-head' }, h('h3', { class: 'ml-dialog-title', text: title })),
        h('div', { class: 'ml-dialog-body' }, content),
        h('footer', { class: 'ml-schema-modal-foot' }, button(okLabel ? i18n('Cancel') : i18n('Close'), close, { ghost: true }), ok));
    const backdrop = h('div', {
        class: 'ml-dialog-backdrop',
        onMousedown: (event) => { if (event.target === backdrop) close(); },
        onKeydown: (event) => {
            event.stopPropagation();
            if (event.key === 'Escape') close();
        },
    }, panel);
    unregister = app.registerModal?.(close) || null;
    app.root.appendChild(backdrop);
    requestAnimationFrame(() => (ok || panel).focus());
    return close;
}

export function confirmText(app, { title, lines, okLabel, danger = false, onOk }) {
    return openModal(app, {
        title,
        content: h('div', { class: 'ml-schema-confirm-text' }, lines.filter(Boolean).map(line => h('p', { text: line }))),
        okLabel,
        danger,
        onOk,
        wide: false,
    });
}
