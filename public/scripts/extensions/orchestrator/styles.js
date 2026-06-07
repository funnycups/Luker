/**
 * CSS injection for the orchestrator extension.
 *
 * Lives in its own file because ~480 lines of inline CSS were drowning
 * out the JavaScript in main.js. The styles target both the in-page
 * settings block (`#${uiBlockId}`) and a handful of detached popups
 * (iteration studio, line-diff overlays, knowledge-base cards).
 *
 * Idempotent: a `<style id="${ORCH_STYLE_ID}">` element already
 * present in the document head causes the function to return early.
 */

const ORCH_STYLE_ID = 'orchestrator_styles';

export function ensureStyles(uiBlockId) {
    if (jQuery(`#${ORCH_STYLE_ID}`).length) {
        return;
    }
    jQuery('head').append(`
<style id="${ORCH_STYLE_ID}">
#${uiBlockId} .menu_button,
#${uiBlockId} .menu_button_small {
    width: auto;
    min-width: max-content;
    white-space: nowrap;
}
#${uiBlockId} .luker_orch_board {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.5));
    border-radius: 10px;
    padding: 10px;
    background: linear-gradient(160deg, rgba(29,46,39,0.28), rgba(21,31,43,0.2));
}
#${uiBlockId} .luker_orch_button_disabled {
    opacity: 0.45;
    pointer-events: none;
}
#${uiBlockId} .luker_orch_single_mode_tools {
    margin-top: 8px;
}
#${uiBlockId} .luker_orch_state_summary {
    display: block;
    margin-top: 8px;
    opacity: 0.82;
}
.luker_orch_iter_popup {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.luker_orch_iter_profile {
    border: 1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 14%, transparent);
    border-radius: 8px;
    padding: 8px;
    background: color-mix(in oklab, var(--SmartThemeBodyColor) 5%, transparent);
    overflow: auto;
    min-height: 350px;
    max-height: 460px;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
}
.luker_orch_iter_empty {
    opacity: 0.8;
}
.luker_orch_iter_diff_popup {
    display: grid;
    gap: 10px;
    max-height: 72vh;
    overflow: auto;
    padding-right: 2px;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
}
.luker_orch_iter_diff_item {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    background: rgba(0,0,0,0.16);
    padding: 8px;
    display: grid;
    gap: 8px;
}
.luker_orch_iter_diff_popup .luker_object_diff {
    display: grid;
    gap: 10px;
    font-size: 0.88rem;
    line-height: 1.45;
}
.luker_orch_iter_diff_popup .luker_object_diff_item {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.28));
    border-radius: 8px;
    background: rgba(0,0,0,0.14);
    padding: 8px;
    display: grid;
    gap: 8px;
}
.luker_orch_iter_diff_popup .luker_object_diff_path {
    font-weight: 600;
    word-break: break-word;
}
.luker_orch_iter_diff_popup .luker_object_diff_grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}
.luker_orch_iter_diff_popup .luker_object_diff_col {
    min-width: 0;
    display: grid;
    gap: 6px;
    border-radius: 8px;
    padding: 8px;
    border-left: 3px solid transparent;
    background: rgba(255,255,255,0.04);
}
.luker_orch_iter_diff_popup .luker_object_diff_col.before {
    border-left-color: color-mix(in oklab, #f44336 68%, transparent);
    background: color-mix(in oklab, #f44336 10%, transparent);
}
.luker_orch_iter_diff_popup .luker_object_diff_col.after {
    border-left-color: color-mix(in oklab, #4caf50 68%, transparent);
    background: color-mix(in oklab, #4caf50 12%, transparent);
}
.luker_orch_iter_diff_popup .luker_object_diff_col_title {
    font-size: 0.9em;
    font-weight: 700;
    opacity: 0.82;
}
.luker_orch_iter_diff_popup .luker_object_diff_col pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
}
.luker_orch_iter_diff_popup .luker_object_diff_missing {
    opacity: 0.74;
    font-style: italic;
}
.luker_orch_iter_diff_popup .luker_object_diff_text {
    min-width: 0;
}
.luker_orch_iter_diff_popup .luker_object_diff_text .luker_iter_diff {
    margin: 0;
}
.luker_orch_iter_diff_title {
    font-weight: 600;
    line-height: 1.35;
}
.luker_orch_iter_diff_fields {
    display: grid;
    gap: 8px;
}
.luker_orch_iter_diff_field {
    display: grid;
    gap: 6px;
}
.luker_orch_iter_diff_label {
    font-size: 0.92rem;
    opacity: 0.86;
}
.luker_iter_diff {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.3));
    border-radius: 6px;
    background: rgba(0,0,0,0.2);
}
.luker_iter_diff > summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    font-size: 0.9rem;
}
.luker_iter_diff_summary_main {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.luker_iter_diff_meta {
    opacity: 0.78;
    font-size: 0.88rem;
}
.luker_iter_diff_expand_btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.2em;
    width: 2.2em;
    padding: 0;
    line-height: 1;
}
.luker_iter_diff_expand_btn i { pointer-events: none; }
.luker_iter_diff_pre {
    margin: 0;
    padding: 6px;
    border-top: 1px dashed var(--SmartThemeBorderColor, rgba(130,130,130,0.3));
    max-height: 320px;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
}
.luker_orch_iter_grid,
.luker_orch_iter_col,
.luker_orch_iter_diff_popup,
.luker_orch_iter_diff_item,
.luker_orch_iter_diff_fields,
.luker_orch_iter_diff_field,
.luker_iter_diff,
.luker_iter_diff_pre { min-width: 0; max-width: 100%; box-sizing: border-box; }
.luker_orch_iter_conversation,
.luker_orch_iter_profile { -webkit-overflow-scrolling: touch; touch-action: pan-y; }
.luker_iter_diff_dual { --luker-iter-split-left: 50%; --luker-iter-splitter-width: 12px; display: grid; grid-template-columns: minmax(0, var(--luker-iter-split-left)) var(--luker-iter-splitter-width) minmax(0, calc(100% - var(--luker-iter-split-left) - var(--luker-iter-splitter-width))); gap: 0; width: 100%; min-width: 0; align-items: stretch; }
.luker_iter_diff_splitter { position: relative; cursor: col-resize; touch-action: none; user-select: none; background: transparent; }
.luker_iter_diff_splitter::before { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; transform: translateX(-50%); border-radius: 999px; background: color-mix(in oklab, var(--SmartThemeBodyColor) 20%, transparent); transition: background-color .12s ease; }
.luker_iter_diff_splitter:hover::before,
.luker_iter_diff_splitter.active::before { background: color-mix(in oklab, var(--SmartThemeBodyColor) 38%, transparent); }
.luker_iter_diff_side { border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.32)); border-radius: 6px; background: rgba(0,0,0,0.12); min-width: 0; overflow: hidden; }
.luker_iter_diff_side_scroll { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; touch-action: auto; }
.luker_iter_diff_table {
    width: max-content;
    min-width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 0.82rem;
}
.luker_iter_diff_pre,
.luker_iter_diff_table,
.luker_iter_diff_row td,
.luker_iter_diff_text,
.luker_iter_diff_text_inner { text-align: left; }
.luker_iter_diff_row td {
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.24));
    padding: 2px 6px;
    vertical-align: top;
}
.luker_iter_diff_row:last-child td { border-bottom: none; }
.luker_iter_diff_ln {
    width: 3.8em;
    text-align: right;
    color: color-mix(in oklab, var(--SmartThemeBodyColor) 72%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    position: sticky;
    left: 0;
    z-index: 3;
    background-color: var(--SmartThemeBlurTintColor);
    box-shadow: 1px 0 0 var(--SmartThemeBorderColor);
    background-image: none;
    opacity: 1;
}
.luker_iter_diff_text {
    width: auto;
    min-width: 0;
}
.luker_iter_diff_text_inner {
    white-space: pre;
    word-break: normal;
    overflow-wrap: normal;
    user-select: text;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    min-width: max-content;
}
.luker_iter_diff_word_add {
    background: color-mix(in oklab, #4caf50 30%, transparent);
    border-radius: 3px;
    padding: 0 1px;
}
.luker_iter_diff_word_del {
    background: color-mix(in oklab, #d9534f 30%, transparent);
    border-radius: 3px;
    padding: 0 1px;
}
.luker_iter_diff_row_add .luker_iter_diff_text.new { background: color-mix(in oklab, #4caf50 12%, transparent); }
.luker_iter_diff_row_del .luker_iter_diff_text.old { background: color-mix(in oklab, #d9534f 12%, transparent); }
.luker_iter_diff_row_mod .luker_iter_diff_text.old { background: color-mix(in oklab, #d9534f 10%, transparent); }
.luker_iter_diff_row_mod .luker_iter_diff_text.new { background: color-mix(in oklab, #4caf50 10%, transparent); }
.luker_iter_diff_zoom_overlay {
    position: fixed;
    inset: 0;
    z-index: 10010;
    display: flex;
    align-items: center;
    justify-content: center;
}
.luker_iter_diff_zoom_backdrop {
    position: absolute;
    inset: 0;
    background: color-mix(in oklab, #000 70%, transparent);
}
.luker_iter_diff_zoom_dialog {
    position: relative;
    z-index: 1;
    width: min(1280px, 95vw);
    height: min(92vh, 920px);
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 10px;
    background: var(--SmartThemeBlurTintColor);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 12px 36px rgba(0,0,0,0.45);
}
.luker_iter_diff_zoom_header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.24));
}
.luker_iter_diff_zoom_title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.luker_iter_diff_zoom_close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.2em;
    width: 2.2em;
    padding: 0;
    line-height: 1;
}
.luker_iter_diff_zoom_body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 10px;
}
.luker_iter_diff_zoom_body .luker_iter_diff_pre { max-height: none; height: auto; }
.luker_orch_iter_diff_raw summary {
    cursor: pointer;
    font-size: 0.9rem;
    opacity: 0.9;
}
.luker_orch_iter_diff_raw pre {
    margin-top: 6px;
    margin-bottom: 0;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow: auto;
    font-size: 0.84rem;
}
/* Runtime trace and last-run styles now use luker-studio classes from luker-studio.css */
.luker_orch_runtime_empty {
    opacity: 0.84;
    padding: 8px;
}
.luker_orch_kb_popup {
    display: grid;
    gap: 10px;
}
.luker_orch_kb_list {
    display: grid;
    gap: 10px;
}
.luker_orch_kb_card {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 10px;
    background: rgba(0,0,0,0.16);
    display: grid;
    gap: 8px;
}
.luker_orch_kb_card_header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
.luker_orch_kb_card_title {
    font-weight: 600;
    line-height: 1.35;
}
.luker_orch_kb_meta_grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 6px 10px;
    font-size: 0.9rem;
    opacity: 0.92;
}
.luker_orch_kb_section {
    display: grid;
    gap: 6px;
}
.luker_orch_kb_section_title {
    font-weight: 600;
    font-size: 0.92rem;
}
.luker_orch_kb_tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.luker_orch_kb_tag {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(39, 117, 215, 0.16);
    border: 1px solid rgba(39, 117, 215, 0.35);
    font-size: 0.82rem;
}
.luker_orch_kb_empty {
    opacity: 0.8;
    font-size: 0.9rem;
}
.luker_orch_kb_sources {
    margin: 0;
    padding-left: 1.1em;
    display: grid;
    gap: 4px;
}
.luker_orch_kb_content {
    margin: 0;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 8px;
    background: rgba(0,0,0,0.2);
    max-height: 260px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.38;
}
.luker_orch_iter_popup .menu_button,
.luker_orch_iter_popup .menu_button_small {
    width: auto;
    min-width: max-content;
    white-space: nowrap;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.luker_orch_iter_empty {
    opacity: 0.8;
    font-size: 0.92rem;
}
.luker_orch_iter_profile_meta {
    display: grid;
    gap: 4px;
    margin-bottom: 8px;
}
.luker_orch_iter_stage_list {
    display: grid;
    gap: 8px;
}
.luker_orch_iter_stage {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 8px;
    background: rgba(255,255,255,0.02);
}
.luker_orch_iter_stage_title {
    font-weight: 600;
}
.luker_orch_iter_stage_mode {
    font-size: 0.82rem;
    opacity: 0.8;
    margin: 2px 0 4px;
}
.luker_orch_iter_stage_nodes {
    white-space: pre-wrap;
    word-break: break-word;
}
.luker_orch_iter_preset_line {
    margin-top: 10px;
    white-space: pre-wrap;
    word-break: break-word;
}
.director-preset-help {
    margin-top: 4px;
    font-size: 0.85em;
    opacity: 0.7;
    line-height: 1.35;
}
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
.luker-notes-row__text {
    font-size: 0.95em;
    line-height: 1.4;
}
.luker-notes-row__text[contenteditable="true"] {
    outline: 1px dashed var(--SmartThemeBorderColor, #888);
    padding: 2px 4px;
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
.luker-notes-empty {
    opacity: 0.5;
    padding: 12px;
    text-align: center;
}
/* Custom Tools section (Unit 3 — Layer-2 / Layer-3 panels per mode) */
.luker_orch_ct_section {
    margin-top: 12px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.5));
    border-radius: 8px;
    padding: 8px;
}
.luker_orch_ct_section > summary {
    cursor: pointer;
    font-weight: 600;
    padding: 4px 0;
}
.luker_orch_ct_actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 8px 0;
}
.luker_orch_ct_subgroup {
    margin-top: 8px;
}
.luker_orch_ct_subgroup_title {
    font-size: 0.9em;
    opacity: 0.7;
    margin-bottom: 4px;
}
.luker_orch_ct_row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    border-bottom: 1px dashed rgba(130,130,130,0.2);
}
.luker_orch_ct_row:last-child {
    border-bottom: none;
}
.luker_orch_ct_row_label {
    flex: 1 1 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
}
.luker_orch_ct_name {
    font-weight: 500;
}
.luker_orch_ct_mode {
    opacity: 0.7;
    font-size: 0.85em;
}
.luker_orch_ct_desc {
    opacity: 0.7;
    font-size: 0.85em;
    margin-left: 6px;
}
.luker_orch_ct_actions_inline {
    display: inline-flex;
    gap: 4px;
}
.luker_orch_ct_empty {
    opacity: 0.6;
    font-style: italic;
    padding: 4px 0;
}
/* Custom tool editor popup */
.luker_orch_ct_editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
    text-align: left;
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
@media (max-width: 980px) {
    #${uiBlockId} .luker_orch_workspace_grid {
        grid-template-columns: 1fr;
    }
    #${uiBlockId} .luker_orch_character_row {
        grid-template-columns: 1fr;
    }
    .luker_orch_editor_popup .luker_orch_workspace_grid {
        grid-template-columns: 1fr;
    }
    .luker_orch_iter_grid {
        grid-template-columns: 1fr;
    }
    .luker_orch_iter_col {
        min-height: 320px;
    }
    .luker_iter_diff_ln {
        width: 3.2em;
    }
}

/* Skill chips component (Plan 2 Unit 3) */
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
    cursor: pointer;
}
.luker_skill_chip_add > [data-skill-chip-action="open-add"] {
    /* The select auto-commits on change; keep the button as an
       accessibility/keyboard fallback but visually hide it so the
       control reads as a single pill. */
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
.luker_orch_tools_section,
.luker_orch_skills_section {
    margin: 6px 0;
}
.luker_orch_tools_section > summary,
.luker_orch_skills_section > summary {
    cursor: pointer;
    padding: 4px 8px;
    background: rgba(180, 180, 180, 0.07);
    border-radius: 4px;
    font-size: 1rem;
    font-weight: 500;
}
.luker_orch_tools_section > summary:hover,
.luker_orch_skills_section > summary:hover {
    background: rgba(180, 180, 180, 0.14);
}
.luker_orch_preset_bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    margin-bottom: 8px;
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 4px;
    flex-wrap: wrap;
}
.luker_orch_preset_bar--disabled {
    opacity: 0.6;
}
.luker_orch_preset_bar_label {
    font-weight: 600;
    margin-right: 4px;
}
.luker_orch_preset_select {
    flex: 1 1 200px;
    min-width: 160px;
}
.luker_orch_btn_danger {
    color: var(--warning);
}
</style>`);
}
