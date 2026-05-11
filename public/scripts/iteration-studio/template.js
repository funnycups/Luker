/**
 * IterationStudio — popup HTML template.
 *
 * Returns the full HTML string for the studio popup. Generic across all
 * adapters; per-adapter chrome (title, optional buttons) is injected by the
 * shell via the deps object.
 *
 * Class naming convention:
 *   - `luker-studio*` are shared across all studios (CSS in
 *     public/css/luker-studio.css).
 *   - `luker-iteration-studio*` are this shell's private classes
 *     (event hooks, ids).
 *   - `data-iter-action="..."` are shell-managed click targets. Adapter
 *     content embedded inside the working-profile panel can use its own
 *     selectors freely — the shell does not delegate from them.
 */

import { escapeHtml } from '../utils.js';
import { i18n, i18nFormat } from './i18n.js';

export function buildIterationStudioPopupHtml({
    popupId,
    session,
    adapter,
    opts = {},
}) {
    const { enableSessionHistory = true } = opts;
    const popupClassName = String(adapter?.popupClassName || '').trim();
    const headerSourceLine = i18nFormat('Iteration source: ${0}', session?.sourceName || i18n('Global profile'));
    const rootClasses = ['luker-studio', 'luker-iteration-studio', popupClassName].filter(Boolean).join(' ');

    return `
<div id="${popupId}" class="${rootClasses}" data-iter-popup-id="${popupId}">
    <div class="luker-studio-header">
        <div class="luker-studio-title">${escapeHtml(String(adapter?.title || i18n('AI Iteration Studio')))}</div>
        <div id="${popupId}_sub" class="luker-studio-subtitle">${escapeHtml(headerSourceLine)}</div>
    </div>
    <div id="${popupId}_status" class="luker-studio-status"></div>
    <div class="luker-studio-columns">
        <div class="luker-studio-panel">
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Conversation'))}</div>
            <div id="${popupId}_conversation" class="luker-studio-chat"></div>
            <div id="${popupId}_pending"></div>
            <div class="luker-studio-composer">
                <textarea id="${popupId}_input" class="text_pole textarea_compact" rows="4" placeholder="${escapeHtml(i18n('Tell the AI what to change...'))}"></textarea>
                <div class="luker-studio-composer-buttons">
                    <div class="menu_button" data-iter-action="send">${escapeHtml(i18n('Send to AI'))}</div>
                    <div class="menu_button" data-iter-action="stop">${escapeHtml(i18n('Stop'))}</div>
                    <div class="menu_button" data-iter-action="clear">${escapeHtml(i18n('Clear Session'))}</div>
                    <label class="luker-studio-switch" title="${escapeHtml(i18n('Skip the manual approve step for tool calls. Changes apply immediately.'))}">
                        <input type="checkbox" data-iter-toggle="auto-apply" />
                        <span class="luker-studio-switch-track" aria-hidden="true"><span class="luker-studio-switch-knob"></span></span>
                        <span class="luker-studio-switch-label">${escapeHtml(i18n('Auto-apply'))}</span>
                    </label>
                </div>
            </div>
        </div>
        <div class="luker-studio-panel">
            <div id="${popupId}_profile" class="luker-iteration-studio-profile"></div>
            ${enableSessionHistory ? `
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Session history'))}</div>
            <div id="${popupId}_history" class="luker-studio-history-list"></div>
            <div class="luker-studio-composer-buttons">
                <div class="menu_button" data-iter-action="new-session">${escapeHtml(i18n('New session'))}</div>
            </div>` : ''}
        </div>
    </div>
</div>`;
}
