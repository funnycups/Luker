import { i18n } from './i18n.js';

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

export function buildIterationStudioPopupHtml({ popupId, layout, popupClassName = '', title = '' }) {
    const cls = ['luker-studio', 'luker-iter-studio', `luker-iter-studio--${layout}`, popupClassName].filter(Boolean).join(' ');
    const titleHtml = title ? `<div class="luker-studio-meta-item">${escapeHtml(title)}</div>` : '';

    if (layout === 'split') {
        return `
<div id="${popupId}" class="${cls}">
    <div class="luker-studio-meta">${titleHtml}</div>
    <div class="luker-studio-toolbar" data-iter-toolbar>
        <div class="luker-studio-toolbar-slot" data-iter-slot="start"></div>
        <div class="luker-studio-toolbar-field">
            <label for="${popupId}_reference">${escapeHtml(i18n('Compare with'))}</label>
            <select id="${popupId}_reference" class="text_pole" data-iter-reference-select></select>
        </div>
        <div class="luker-studio-toolbar-actions">
            <div class="menu_button menu_button_small" data-iter-action="clear-history">${escapeHtml(i18n('Clear history'))}</div>
        </div>
        <div class="luker-studio-toolbar-slot" data-iter-slot="end"></div>
    </div>
    <div class="luker-studio-columns">
        <div class="luker-studio-panel">
            <details class="luker-studio-history" open>
                <summary>${escapeHtml(i18n('Conversation history'))}</summary>
                <div data-iter-history></div>
            </details>
            <div class="luker-studio-chat" data-iter-chat></div>
            <div class="luker-studio-pending" data-iter-pending></div>
        </div>
        <div class="luker-studio-panel" data-iter-preview-pane></div>
    </div>
    <div class="luker-studio-composer">
        <textarea class="text_pole" data-iter-input placeholder="${escapeHtml(i18n('Type what to change...'))}"></textarea>
        <div class="luker-studio-composer-actions">
            <div class="luker-studio-status" data-iter-status></div>
            <div class="luker-studio-composer-buttons">
                <div class="menu_button" data-iter-action="send-or-stop">${escapeHtml(i18n('Send'))}</div>
                <div class="menu_button" data-iter-action="close">${escapeHtml(i18n('Close'))}</div>
            </div>
        </div>
    </div>
</div>`;
    }

    // popup layout
    return `
<div id="${popupId}" class="${cls}">
    <div class="luker-studio-meta">${titleHtml}</div>
    <div class="luker-studio-toolbar" data-iter-toolbar>
        <div class="luker-studio-toolbar-slot" data-iter-slot="start"></div>
        <div class="luker-studio-toolbar-field">
            <label for="${popupId}_reference">${escapeHtml(i18n('Compare with'))}</label>
            <select id="${popupId}_reference" class="text_pole" data-iter-reference-select></select>
        </div>
        <div class="luker-studio-toolbar-actions">
            <div class="menu_button menu_button_small" data-iter-action="clear-history">${escapeHtml(i18n('Clear history'))}</div>
        </div>
        <div class="luker-studio-toolbar-slot" data-iter-slot="end"></div>
    </div>
    <details class="luker-studio-history" open>
        <summary>${escapeHtml(i18n('Conversation history'))}</summary>
        <div data-iter-history></div>
    </details>
    <div class="luker-studio-chat" data-iter-chat></div>
    <div class="luker-studio-pending" data-iter-pending></div>
    <div class="luker-studio-composer">
        <textarea class="text_pole" data-iter-input placeholder="${escapeHtml(i18n('Type what to change...'))}"></textarea>
        <div class="luker-studio-composer-actions">
            <div class="luker-studio-status" data-iter-status></div>
            <div class="luker-studio-composer-buttons">
                <div class="menu_button" data-iter-action="send-or-stop">${escapeHtml(i18n('Send'))}</div>
                <div class="menu_button" data-iter-action="close">${escapeHtml(i18n('Close'))}</div>
            </div>
        </div>
    </div>
</div>`;
}
