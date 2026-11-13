/**
 * CSS injection for the popups and panels the orchestrator still renders with
 * its own markup (notes, custom tools, ST tool bridge, character import review,
 * skill chips).
 *
 * Idempotent: a `<style id="${ORCH_STYLE_ID}">` element already
 * present in the document head causes the function to return early.
 */

const ORCH_STYLE_ID = 'orchestrator_styles';

export function ensureStyles() {
    if (jQuery(`#${ORCH_STYLE_ID}`).length) {
        return;
    }
    jQuery('head').append(`
<style id="${ORCH_STYLE_ID}">
/* ============================================================== */
/* Notes panel (consumed by notes-panel.js / ui-templates.js)      */
/* ============================================================== */
.luker-notes-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
}
.luker-notes-panel__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.luker-notes-panel__tabs {
    display: flex;
    gap: 4px;
}
.luker-notes-tab {
    padding: 4px 10px;
    opacity: 0.6;
}
.luker-notes-tab.is-active {
    opacity: 1;
    font-weight: 600;
}
.luker-notes-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.luker-notes-row {
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--SmartThemeBlurTintColor, rgba(255,255,255,0.04));
}
.wb-win .luker-notes-row,
.olens .luker-notes-row {
    background: var(--lw-surface-2, var(--ol-surface-2, rgba(255, 255, 255, 0.04)));
    border: 1px solid var(--lw-border, var(--ol-border, transparent));
    color: var(--lw-text, var(--ol-text, inherit));
    border-radius: var(--lw-r-sm, 6px);
    padding: 8px 10px;
}
.wb-win .luker-notes-tab,
.olens .luker-notes-tab,
.wb-win .luker-notes-action,
.olens .luker-notes-action {
    background: var(--lw-raised, var(--ol-raised, transparent));
    border: 1px solid var(--lw-border-strong, var(--ol-border-strong, rgba(130, 130, 130, 0.35)));
    border-radius: var(--lw-r-sm, 6px);
    color: var(--lw-text, var(--ol-text, inherit));
    cursor: pointer;
}
.wb-win .luker-notes-tab.is-active,
.olens .luker-notes-tab.is-active {
    border-color: var(--lw-accent, var(--ol-accent));
    background: var(--lw-accent-soft, var(--ol-accent-soft));
}
.luker-notes-row__text {
    font-size: 0.95em;
    line-height: 1.4;
}
.luker-notes-row__text[contenteditable="true"] {
    outline: 1px dashed var(--SmartThemeBorderColor, #888);
    padding: 2px 4px;
}
.wb-win .luker-notes-row__text[contenteditable="true"],
.olens .luker-notes-row__text[contenteditable="true"] {
    outline: 1px dashed var(--lw-accent, var(--ol-accent, #888));
}
.luker-notes-row__reason {
    margin-top: 4px;
    font-size: 0.85em;
    opacity: 0.7;
}
.luker-notes-row__actions {
    display: flex;
    gap: 4px;
    margin-top: 4px;
}
.luker-notes-action {
    padding: 2px 8px;
    font-size: 0.85em;
}
.luker-notes-action--danger {
    color: var(--SmartThemeWarningColor, #c66);
}
.wb-win .luker-notes-action--danger,
.olens .luker-notes-action--danger {
    color: var(--lw-danger, var(--ol-danger, #c66));
}
.luker-notes-empty {
    opacity: 0.5;
    padding: 12px;
    text-align: center;
}

/* Custom tool editor popup */
.luker_orch_ct_editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
    text-align: left;
}
.luker_orch_ct_title {
    margin: 0;
}
.luker_orch_ct_warning {
    background: rgba(255, 180, 0, 0.12);
    border: 1px solid rgba(255, 180, 0, 0.45);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 0.9em;
}
.luker_orch_ct_field {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.luker_orch_ct_label {
    font-weight: 500;
    font-size: 0.9em;
}
.luker_orch_ct_validation_msg {
    background: rgba(255, 80, 80, 0.12);
    border: 1px solid rgba(255, 80, 80, 0.4);
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 0.9em;
}
.luker_orch_ct_validation_msg[hidden] {
    display: none;
}
.luker_orch_ct_mode {
    opacity: 0.7;
    font-size: 0.85em;
}

/* ST tool bridge picker */
.luker_orch_st_picker {
    display: flex;
    flex-direction: column;
    gap: 10px;
    text-align: left;
}
.luker_orch_st_picker_title {
    font-weight: 600;
    font-size: 1em;
}
.luker_orch_st_picker_row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 0;
    border-bottom: 1px dashed rgba(130,130,130,0.2);
}
.luker_orch_st_picker_row:last-child {
    border-bottom: none;
}
.luker_orch_st_picker_check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}
.luker_orch_st_picker_name {
    font-weight: 500;
}
.luker_orch_st_picker_mode {
    display: inline-flex;
    gap: 12px;
    opacity: 0.85;
    font-size: 0.9em;
}
.luker_orch_st_picker_desc {
    opacity: 0.7;
    font-size: 0.85em;
}
.luker_orch_st_picker_empty {
    opacity: 0.6;
    font-style: italic;
    padding: 8px 0;
}

/* Character import review popup */
.luker_orch_ct_import_review {
    display: flex;
    flex-direction: column;
    gap: 10px;
    text-align: left;
}
.luker_orch_ct_import_list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.luker_orch_ct_import_item {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.5));
    border-radius: 6px;
    padding: 8px;
}
.luker_orch_ct_import_head {
    display: flex;
    align-items: center;
    gap: 8px;
}
.luker_orch_ct_import_name {
    font-weight: 600;
}
.luker_orch_ct_import_desc {
    opacity: 0.8;
    font-size: 0.9em;
    margin-top: 4px;
}
.luker_orch_ct_import_body {
    margin-top: 6px;
}
.luker_orch_ct_import_pre {
    max-height: 200px;
    overflow: auto;
    background: rgba(0,0,0,0.2);
    padding: 6px;
    border-radius: 4px;
    font-size: 0.85em;
}

/* Skill chips component */
.luker_skill_chips_block {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 6px 0;
}
.luker_skill_chips_label {
    opacity: 0.78;
    font-size: 0.85rem;
}
.luker_skill_chips_loading {
    opacity: 0.65;
    font-size: 0.85rem;
    font-style: italic;
}
.luker_skill_chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
    align-items: center;
    padding: 4px 0;
}
.luker_skill_chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px 2px 8px;
    border-radius: 999px;
    font-size: 0.8rem;
    line-height: 1.2;
    border: 1px solid rgba(140, 140, 140, 0.35);
    background: rgba(140, 140, 140, 0.12);
    cursor: pointer;
    user-select: none;
}
.luker_skill_chip_visible {
    border-color: rgba(56, 161, 105, 0.55);
    background: rgba(56, 161, 105, 0.16);
}
.luker_skill_chip_deny {
    border-color: rgba(220, 80, 80, 0.55);
    background: rgba(220, 80, 80, 0.16);
}
.luker_skill_chip_inherit {
    border-color: rgba(39, 117, 215, 0.55);
    background: rgba(39, 117, 215, 0.16);
    font-style: italic;
    cursor: default;
}
.luker_skill_chip_missing {
    opacity: 0.55;
    border-style: dashed;
}
.luker_skill_chip_label {
    color: inherit;
}
.luker_skill_chip_x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.2em;
    height: 1.2em;
    padding: 0 2px;
    border-radius: 999px;
    font-size: 0.95rem;
    opacity: 0.75;
}
.luker_skill_chip_x:hover {
    opacity: 1;
    background: rgba(0, 0, 0, 0.18);
}
.luker_skill_chip_add {
    display: inline-flex;
    align-items: stretch;
    gap: 0;
    border: 1px dashed rgba(140, 140, 140, 0.55);
    border-radius: 999px;
    background: rgba(140, 140, 140, 0.06);
    overflow: hidden;
    position: relative;
    transition: border-color 120ms ease, background 120ms ease;
}
.luker_skill_chip_add:hover {
    border-color: rgba(140, 140, 140, 0.85);
    background: rgba(140, 140, 140, 0.12);
}
.luker_skill_chip_add::before {
    content: '+';
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    font-size: 0.95rem;
    font-weight: 700;
    opacity: 0.7;
    border-right: 1px solid rgba(140, 140, 140, 0.25);
    background: rgba(140, 140, 140, 0.08);
}
.luker_skill_chip_add_select {
    height: 1.9rem;
    padding: 1px 22px 1px 8px;
    font-size: 0.8rem;
    min-width: 11em;
    border: none !important;
    background: transparent !important;
    color: inherit;
    cursor: pointer;
}
.olens .luker_skill_chip_add_select option {
    background: var(--ol-surface, var(--lw-surface));
    color: var(--ol-text, var(--lw-text));
}
.luker_skill_chip_add > [data-skill-chip-action="open-add"] {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
}
.luker_skill_chip_add_empty {
    opacity: 0.55;
    cursor: not-allowed;
}
.luker_skill_chip_add_empty::before {
    opacity: 0.4;
}
.luker_skill_chip_add_inherit {
    font-size: 0.78rem !important;
    padding: 2px 8px !important;
    border-radius: 999px !important;
}
</style>
`);
}
