// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * HTML for the Notes panel (consumed by `notes-panel.js` in
 * `mountNotesPanel`). Contains:
 *  - the panel root with header (title + tab switcher between Open / Closed)
 *  - the empty list placeholder shown when no notes are present
 *  - a `<template id="luker-notes-row-template">` cloned per row by the panel
 *
 * Text is rendered through the orchestrator translator passed as `i18n`.
 */
export function renderNotesPanelTemplate({ escapeHtml, i18n }) {
    const tr = key => escapeHtml(i18n(key));
    return `
<div class="luker-notes-panel" id="luker-notes-panel">
    <div class="luker-notes-panel__header">
        <h3>${tr('Notes')}</h3>
        <div class="luker-notes-panel__tabs">
            <button class="luker-notes-tab is-active" data-tab="open">${tr('Open notes')}</button>
            <button class="luker-notes-tab" data-tab="closed">${tr('Closed notes')}</button>
        </div>
    </div>
    <ul class="luker-notes-list" id="luker-notes-list">
        <li class="luker-notes-empty">${tr('No open notes yet')}</li>
    </ul>
</div>
<template id="luker-notes-row-template">
    <li class="luker-notes-row" data-id="">
        <div class="luker-notes-row__text" contenteditable="false"></div>
        <div class="luker-notes-row__reason" hidden></div>
        <div class="luker-notes-row__actions">
            <button class="luker-notes-action luker-notes-action--close" data-action="close">${tr('Close this note')}</button>
            <button class="luker-notes-action luker-notes-action--edit" data-action="edit">${tr('Edit note')}</button>
            <button class="luker-notes-action luker-notes-action--danger" data-action="delete">${tr('Delete note (permanent)')}</button>
        </div>
    </li>
</template>
`;
}
