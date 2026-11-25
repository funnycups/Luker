// SPDX-License-Identifier: AGPL-3.0-or-later

import { escapeHtml } from './html-escape.js';

/**
 * @param {{title: string, bodyHtml: string, targetSelectId?: string}} options
 * @returns {string} Markup with an HTML-safe body supplied by the caller.
 */
export function renderFieldHelpButton({ title, bodyHtml, targetSelectId = '' }) {
    const t = String(title || '');
    const b = String(bodyHtml || '');
    const target = targetSelectId ? ` data-luker-field-help-target="${escapeHtml(targetSelectId)}"` : '';
    return `<button type="button" class="luker-field-help" title="${escapeHtml(t)}" data-luker-field-help-title="${escapeHtml(t)}" data-luker-field-help-body="${escapeHtml(b)}"${target}><i class="fa-solid fa-circle-question"></i></button>`;
}

export function renderFieldHelpButtonElement(options) {
    const template = document.createElement('template');
    template.innerHTML = renderFieldHelpButton(options);
    return template.content.firstElementChild;
}
