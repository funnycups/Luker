/**
 * field-help.js — Shared "?" help button for generic field explanations.
 *
 * Three layers:
 *   Layer 1 (direct):       import { renderFieldHelpButton } from '/scripts/extensions/field-help.js';
 *   Layer 2 (lukerContext): const { renderFieldHelpButton } = lukerContext;
 *   Layer 3 (getContext):   const { renderFieldHelpButton } = Luker.getContext();
 *
 * Inline question-mark button with a plain title+body popup; no side actions.
 * Body must be HTML-safe (call site's responsibility).
 */

import { escapeHtml } from '../utils.js';
import { translate } from '../i18n.js';
import { renderFieldHelpButton } from '../lib/field-help-button.js';

export { renderFieldHelpButton };

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
