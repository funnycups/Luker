// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lightweight modal used for the full-text viewer.

import { h, clear, copyText, put } from '../../../lens-shared/util.js';
import { i18n } from '../i18n.js';
import { iconButton, sectionTitle } from '../ui/components.js';

export function createDialog() {
    const title = h('h3', { class: 'ol-dialog-title' });
    const body = h('div', { class: 'ol-dialog-body' });
    const closeBtn = iconButton('x', i18n('Close'), () => close());
    const panel = h('div', { class: 'ol-dialog', role: 'dialog', 'aria-modal': 'true', tabIndex: -1 },
        h('header', { class: 'ol-dialog-head' }, title, closeBtn),
        body);
    const el = h('div', { class: 'ol-dialog-backdrop', hidden: true, onMousedown: (event) => { if (event.target === el) close(); } }, panel);
    let returnFocus = null;

    function open(heading, sections) {
        returnFocus = document.activeElement;
        title.textContent = heading;
        panel.setAttribute('aria-label', heading);
        clear(body);
        for (const section of sections) {
            const text = String(section.text || '').trim();
            put(body, h('section', { class: 'ol-dialog-section' },
                sectionTitle(section.title, text ? iconButton('copy', i18n('Copy'), () => copyText(text), { className: 'ol-iconbtn-sm' }) : null),
                h('pre', { class: 'ol-insp-pre', text: text || i18n('(empty)') })));
        }
        el.hidden = false;
        requestAnimationFrame(() => closeBtn.focus());
    }

    /**
     * Arbitrary content with action buttons. Resolves with the clicked
     * action's value ('' when dismissed).
     * @param {string} heading
     * @param {Node|Node[]} content
     * @param {{ label: string, value: string, primary?: boolean, danger?: boolean }[]} actions
     */
    function ask(heading, content, actions = []) {
        returnFocus = document.activeElement;
        title.textContent = heading;
        panel.setAttribute('aria-label', heading);
        clear(body);
        put(body, content);
        const foot = h('footer', { class: 'ol-dialog-foot' }, actions.map(action => h('button', {
            type: 'button',
            class: `ol-btn${action.primary ? ' ol-btn-primary' : ''}${action.danger ? ' ol-btn-danger' : ''}`,
            onClick: () => finish(action.value),
        }, h('span', { text: action.label }))));
        put(body, foot);
        el.hidden = false;
        requestAnimationFrame(() => (foot.querySelector('.ol-btn-primary') || closeBtn).focus());
        return new Promise((resolve) => { pending = resolve; });
    }

    let pending = null;
    function finish(value) {
        const resolve = pending;
        pending = null;
        close();
        resolve?.(value);
    }

    function close() {
        if (pending) { finish(''); return; }
        if (el.hidden) return;
        el.hidden = true;
        if (returnFocus?.isConnected) returnFocus.focus();
    }

    return { el, open, ask, close, isOpen: () => !el.hidden };
}
