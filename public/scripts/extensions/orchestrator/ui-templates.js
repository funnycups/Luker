// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * HTML template for the Notes panel (consumed by `notes-panel.js` in
 * `mountNotesPanel`). Contains:
 *  - the panel root with header (title + tab switcher between Open / Closed)
 *  - the empty list placeholder shown when no notes are present
 *  - a `<template id="luker-notes-row-template">` cloned per row by the panel
 *  - a `<template id="luker-notes-close-dialog-template">` cloned when the user
 *    clicks the per-row "Close" action (the close-dialog flow asks for an
 *    optional closure reason before invoking `updateStatusById`)
 *
 * All user-visible strings carry `data-i18n=` for the i18n system.
 * Translations live in `i18n/zh-{cn,tw}.json` (Task 13).
 */
export const NOTES_PANEL_TEMPLATE = `
<div class="luker-notes-panel" id="luker-notes-panel">
    <div class="luker-notes-panel__header">
        <h3 data-i18n="Notes">Notes</h3>
        <div class="luker-notes-panel__tabs">
            <button class="luker-notes-tab is-active" data-tab="open" data-i18n="Open notes">Open notes</button>
            <button class="luker-notes-tab" data-tab="closed" data-i18n="Closed notes">Closed notes</button>
        </div>
    </div>
    <ul class="luker-notes-list" id="luker-notes-list">
        <li class="luker-notes-empty" data-i18n="No open notes yet">No open notes yet</li>
    </ul>
</div>
<template id="luker-notes-row-template">
    <li class="luker-notes-row" data-id="">
        <div class="luker-notes-row__text" contenteditable="false"></div>
        <div class="luker-notes-row__reason" hidden></div>
        <div class="luker-notes-row__actions">
            <button class="luker-notes-action luker-notes-action--close" data-action="close" data-i18n="Close this note">Close this note</button>
            <button class="luker-notes-action luker-notes-action--edit" data-action="edit" data-i18n="Edit note">Edit note</button>
            <button class="luker-notes-action luker-notes-action--danger" data-action="delete" data-i18n="Delete note (permanent)">Delete note (permanent)</button>
        </div>
    </li>
</template>
<template id="luker-notes-close-dialog-template">
    <div class="luker-notes-close-dialog">
        <label data-i18n="Closure reason (optional)">Closure reason (optional)</label>
        <textarea class="luker-notes-close-reason"></textarea>
        <button class="luker-notes-close-confirm" data-i18n="Close this note">Close this note</button>
    </div>
</template>
`;
