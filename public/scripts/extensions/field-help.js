/**
 * field-help.js — Shared "?" help button for generic field explanations.
 *
 * Three layers:
 *   Layer 1 (direct):       import { renderFieldHelpButton } from '/scripts/extensions/field-help.js';
 *   Layer 2 (lukerContext): const { renderFieldHelpButton } = lukerContext;
 *   Layer 3 (getContext):   const { renderFieldHelpButton } = Luker.getContext();
 *
 * Similar visual to preset-help (fa-circle-question) but plain title+body popup;
 * no preset-import side action. Body must be HTML-safe (call site's responsibility).
 */

import { escapeHtml } from '../utils.js';
import { translate } from '../i18n.js';

/**
 * @param {object} opts
 * @param {string} opts.title             Popup title (plain text).
 * @param {string} opts.bodyHtml          Popup body (HTML, caller must escape).
 * @param {string} [opts.targetSelectId]  Optional id of the field the help belongs to (for future auto-attach).
 * @returns {string} HTML string
 */
export function renderFieldHelpButton({ title, bodyHtml, targetSelectId = '' }) {
    const t = String(title || '');
    const b = String(bodyHtml || '');
    const target = targetSelectId ? ` data-luker-field-help-target="${escapeHtml(targetSelectId)}"` : '';
    return `<button type="button" class="luker-field-help menu_button menu_button_small" title="${escapeHtml(t)}" data-luker-field-help-title="${escapeHtml(t)}" data-luker-field-help-body="${escapeHtml(b)}"${target}><i class="fa-solid fa-circle-question"></i></button>`;
}

// One-shot delegated click handler
if (typeof jQuery !== 'undefined') {
    jQuery(document).off('click.lukerFieldHelp').on('click.lukerFieldHelp', '.luker-field-help', async function (event) {
        event.preventDefault();
        event.stopPropagation();
        const $btn = jQuery(this);
        const title = $btn.attr('data-luker-field-help-title') || '';
        const body = $btn.attr('data-luker-field-help-body') || '';
        try {
            const ctx = (typeof Luker !== 'undefined') ? Luker.getContext() : null;
            if (!ctx || typeof ctx.callGenericPopup !== 'function') return;
            const POPUP_TYPE = ctx.POPUP_TYPE || { TEXT: 1 };
            const wrapper = `<h4>${escapeHtml(title)}</h4><div>${body}</div>`;
            await ctx.callGenericPopup(wrapper, POPUP_TYPE.TEXT, '', {
                okButton: translate('Close'),
                allowVerticalScrolling: true,
                wide: false,
            });
        } catch (err) {
            console.warn('[field-help] popup failed:', err);
        }
    });
}

// Layer 2 exposure
if (typeof globalThis.lukerContext === 'object' && globalThis.lukerContext) {
    globalThis.lukerContext.renderFieldHelpButton = renderFieldHelpButton;
}
