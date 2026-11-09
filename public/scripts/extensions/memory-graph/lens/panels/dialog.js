// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lightweight modal used for the injected-text viewer.

import { h, clear, copyText, put } from '../../../lens-shared/util.js';
import { i18n } from '../i18n.js';
import { iconButton, sectionTitle } from '../ui/components.js';

export function createDialog() {
    const title = h('h3', { class: 'ml-dialog-title' });
    const body = h('div', { class: 'ml-dialog-body' });
    const closeBtn = iconButton('x', i18n('Close'), () => close());
    const panel = h('div', { class: 'ml-dialog', role: 'dialog', 'aria-modal': 'true', tabIndex: -1 },
        h('header', { class: 'ml-dialog-head' }, title, closeBtn),
        body);
    const el = h('div', { class: 'ml-dialog-backdrop', hidden: true, onMousedown: (event) => { if (event.target === el) close(); } }, panel);
    let returnFocus = null;

    /** sections: [{ title, text }] or a ready DOM node. */
    function open(heading, sections) {
        returnFocus = document.activeElement;
        title.textContent = heading;
        panel.setAttribute('aria-label', heading);
        clear(body);
        if (sections instanceof Node) {
            put(body, sections);
            el.hidden = false;
            requestAnimationFrame(() => closeBtn.focus());
            return;
        }
        for (const section of sections) {
            const text = String(section.text || '').trim();
            put(body, h('section', { class: 'ml-dialog-section' },
                sectionTitle(section.title, text ? iconButton('copy', i18n('Copy node ID'), () => copyText(text), { className: 'ml-iconbtn-sm' }) : null),
                h('pre', { class: 'ml-insp-pre', text: text || i18n('(empty)') })));
        }
        el.hidden = false;
        requestAnimationFrame(() => closeBtn.focus());
    }

    function close() {
        if (el.hidden) return;
        el.hidden = true;
        if (returnFocus?.isConnected) returnFocus.focus();
    }

    return { el, open, close, isOpen: () => !el.hidden };
}
