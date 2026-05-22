export function createCharacterEditorUi(deps) {
    const {
        MODULE_NAME,
        STYLE_ID,
        UI_BLOCK_ID,
        beginCeaLineDiffResize,
        closeCeaExpandedDiff,
        defaultSettings,
        escapeHtml,
        getContext,
        getPrimaryLorebookName,
        getSettings,
        i18n,
        i18nFormat,
        loadOperationState,
        openCeaExpandedDiff,
        openCharacterEditorPopup,
        refreshPresetSelectors,
        renderJournalItems,
        saveSettingsDebounced,
        summarizeCharacterEditorSession,
    } = deps;

    function renderCharacterEditorConversationHistoryItems(sessionStore, currentSessionId = '') {
        const currentId = String(currentSessionId || '').trim();
        const items = (Array.isArray(sessionStore?.sessions) ? sessionStore.sessions : [])
            .slice()
            .sort((left, right) => Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0));
        const toolbar = `
<div class="cea_sync_history_toolbar">
    <div class="menu_button menu_button_small" data-cea-editor-history-action="new-session">${escapeHtml(i18n('New session'))}</div>
</div>`;
        if (items.length === 0) {
            return `${toolbar}<div class="cea_sync_history_empty">${escapeHtml(i18n('No conversation history yet.'))}</div>`;
        }
        return `${toolbar}${items.map(item => {
            const sessionId = String(item?.id || '').trim();
            const summary = summarizeCharacterEditorSession(item, sessionId) || sessionId;
            const isCurrent = sessionId && sessionId === currentId;
            const messageCount = Array.isArray(item?.messages) ? item.messages.length : 0;
            const pending = item?.pendingApproval ? ` · ${escapeHtml(i18n('Pending review'))}` : '';
            return `
<div class="cea_sync_history_item${isCurrent ? ' active' : ''}">
    <div class="cea_sync_history_item_main">
        <div class="cea_sync_history_item_summary">${escapeHtml(summary)}${isCurrent ? ` <span class="cea_sync_history_item_current">${escapeHtml(i18n('Current'))}</span>` : ''}</div>
        <div class="cea_sync_history_item_time">${escapeHtml(new Date(Number(item?.updatedAt || Date.now())).toLocaleString())} · ${escapeHtml(i18nFormat('${0} msgs', String(messageCount)))}${pending}</div>
    </div>
    <div class="cea_sync_history_item_actions">
        ${!isCurrent && sessionId ? `<div class="menu_button menu_button_small" data-cea-editor-history-action="load" data-cea-editor-session-id="${escapeHtml(sessionId)}">${escapeHtml(i18n('Load'))}</div>` : ''}
        ${sessionId ? `<div class="menu_button menu_button_small" data-cea-editor-history-action="delete" data-cea-editor-session-id="${escapeHtml(sessionId)}">${escapeHtml(i18n('Delete'))}</div>` : ''}
    </div>
</div>`;
        }).join('')}`;
    }

    function buildCharacterEditorPopupHtml(record) {
        const characterName = String(record?.character?.name || '').trim() || '(unknown)';
        const primaryBook = String(getPrimaryLorebookName(record?.character || {}) || i18n('(empty)'));
        return `
<div class="luker-studio cea_sync_popup luker-iter-workspace" data-iter-layout="split" data-iter-active-tab="chat">
    <div class="luker-studio-header">
        <div class="luker-studio-title">${escapeHtml(i18n('Character Editor'))}</div>
        <div class="luker-studio-meta">
            <div class="luker-studio-meta-item"><b>${escapeHtml(i18n('Character'))}:</b> ${escapeHtml(characterName)}</div>
            <div class="luker-studio-meta-item"><b>${escapeHtml(i18n('Target lorebook'))}:</b> ${escapeHtml(primaryBook)}</div>
        </div>
    </div>
    <div class="luker-iter-workspace-tabs" role="tablist">
        <button type="button" class="luker-iter-workspace-tab active" role="tab" aria-selected="true" data-iter-action="switch-tab" data-iter-tab="chat">
            <span class="luker-iter-workspace-tab-label">${escapeHtml(i18n('Chat'))}</span>
            <span class="luker-iter-workspace-tab-badge" data-iter-chat-badge hidden></span>
        </button>
        <button type="button" class="luker-iter-workspace-tab" role="tab" aria-selected="false" data-iter-action="switch-tab" data-iter-tab="preview">
            <span class="luker-iter-workspace-tab-label">${escapeHtml(i18n('Preview'))}</span>
        </button>
    </div>
    <div class="luker-iter-workspace-grid">
        <div class="luker-iter-workspace-chat" data-iter-pane="chat">
            <div class="luker-studio-chat" data-cea-editor-chat></div>
            <div class="luker-studio-composer">
                <textarea class="text_pole textarea_compact" rows="4" data-cea-editor-input placeholder="${escapeHtml(i18n('Type your requirement to continue this conversation...'))}"></textarea>
                <div class="luker-studio-composer-actions">
                    <label class="luker-studio-composer-auto-apply">
                        <input type="checkbox" data-cea-editor-auto-approve>
                        <span>${escapeHtml(i18n('Auto-apply AI proposed changes'))}</span>
                    </label>
                    <div class="luker-studio-composer-buttons">
                        <div class="menu_button menu_button_small luker-studio-primary" data-cea-editor-send>${escapeHtml(i18n('Send'))}</div>
                        <div class="menu_button menu_button_small disabled" data-cea-editor-stop>${escapeHtml(i18n('Stop'))}</div>
                    </div>
                </div>
            </div>
            <div data-cea-editor-pending></div>
            <details class="luker-studio-history">
                <summary>${escapeHtml(i18n('Conversation history'))}</summary>
                <div class="luker-studio-history-list" data-cea-editor-history></div>
            </details>
        </div>
        <div class="luker-iter-workspace-resizer" data-iter-resizer aria-label="${escapeHtml(i18n('Resize columns'))}"></div>
        <div class="luker-iter-workspace-preview" data-iter-pane="preview" data-iter-preview-pane></div>
    </div>
</div>`;
    }

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
#${UI_BLOCK_ID} .cea_row { display:flex; gap:8px; align-items:center; margin:6px 0; flex-wrap:wrap; }
#${UI_BLOCK_ID} .cea_panel { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 22%, transparent); border-radius:8px; padding:8px; margin:8px 0; }
#${UI_BLOCK_ID} .cea_item { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 16%, transparent); border-radius:8px; padding:8px; margin:6px 0; }
#${UI_BLOCK_ID} .cea_item_top { display:flex; justify-content:space-between; gap:8px; align-items:flex-start; }
#${UI_BLOCK_ID} .cea_item_meta { opacity:0.75; font-size:0.9em; }
#${UI_BLOCK_ID} .cea_status { opacity:0.85; }
#${UI_BLOCK_ID} .cea_item_actions { display:flex; gap:6px; flex-wrap:wrap; }
#${UI_BLOCK_ID} .cea_diff_popup { display:flex; flex-direction:column; gap:10px; }
#${UI_BLOCK_ID} .cea_diff_meta { display:flex; flex-wrap:wrap; gap:8px; }
#${UI_BLOCK_ID} .cea_diff_meta_item { padding:6px 8px; border-radius:8px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 10%, transparent); }
#${UI_BLOCK_ID} .cea_diff_item { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 16%, transparent); border-radius:8px; padding:8px; }
#${UI_BLOCK_ID} .cea_diff_label { font-weight:600; margin-bottom:6px; }
#${UI_BLOCK_ID} .cea_diff_blocks { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
#${UI_BLOCK_ID} .cea_diff_block { border-radius:8px; border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 14%, transparent); padding:6px; min-height:72px; }
#${UI_BLOCK_ID} .cea_diff_block_title { font-size:0.9em; opacity:0.75; margin-bottom:4px; }
#${UI_BLOCK_ID} .cea_diff_block pre { margin:0; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; max-height:280px; overflow:auto; }
#${UI_BLOCK_ID} .cea_diff_block.before { background: color-mix(in oklab, #d9534f 12%, transparent); }
#${UI_BLOCK_ID} .cea_diff_block.after { background: color-mix(in oklab, #4caf50 14%, transparent); }
#${UI_BLOCK_ID} .menu_button,
#${UI_BLOCK_ID} .menu_button_small {
    display: inline-flex;
    width: auto;
    min-width: max-content;
    white-space: nowrap;
    word-break: keep-all;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
    align-items: center;
    justify-content: center;
}
/* CEA-specific: chat message scrollable container.
   The shared .luker-studio-chat caps the list height; inside CEA we let
   the list grow and scroll each message body individually, because round
   diffs + tool summaries make individual messages tall. */
.popup .cea_sync_popup .luker-studio-chat { max-height:none; padding:var(--ls-space-md, 14px); }
.popup .cea_sync_chat_msg {
    border: 1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 14%, transparent);
    border-left: 3px solid transparent;
    border-radius: 12px;
    padding: 10px 14px;
    max-height: 40vh;
    overflow-y: auto;
    overflow-x: hidden;
    text-align: left;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
    transition: border-color 120ms ease;
}
.popup .cea_sync_chat_msg_assistant {
    border-left-color: color-mix(in oklab, #3aab7d 70%, transparent);
    background: color-mix(in oklab, #3aab7d 6%, transparent);
}
.popup .cea_sync_chat_msg_user {
    border-left-color: color-mix(in oklab, #5b8def 70%, transparent);
    background: color-mix(in oklab, #5b8def 7%, transparent);
}
.popup .cea_sync_chat_msg_user pre { margin:0; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; font-family:inherit; }
.popup .cea_sync_chat_msg_loading { display:flex; align-items:center; gap:8px; opacity:0.9; }
.popup .cea_sync_analysis_error { color:var(--crimson70); font-weight:600; }
.popup .cea_sync_analysis_empty { opacity:0.8; }
.popup .cea_sync_chat_text { margin-bottom:6px; }
.popup .cea_sync_tool_summary { margin-top:8px; padding:8px 10px; border-radius:8px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 12%, transparent); white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; }
.popup .cea_sync_msg_actions { margin-top:8px; display:flex; justify-content:flex-end; }
.popup .cea_sync_chat_msg :is(p, ul, ol, pre, table, h1, h2, h3, h4) { margin:0 0 8px; }
.popup .cea_sync_chat_msg :is(pre, code) { white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; }
.popup .cea_sync_chat_msg table { display:block; width:100%; overflow:auto; border-collapse:collapse; }
.popup .cea_sync_chat_msg th, .popup .cea_sync_chat_msg td { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 16%, transparent); padding:4px 6px; vertical-align:top; }
.popup .cea_sync_chat_text,
.popup .cea_sync_chat_text :is(p, ul, ol, li, pre, table, th, td, h1, h2, h3, h4) { text-align:left; }
.popup .cea_sync_turn_diff { margin-top:8px; border-top:1px dashed color-mix(in oklab, var(--SmartThemeBodyColor) 18%, transparent); padding-top:8px; }
.popup .cea_sync_turn_diff > summary { cursor:pointer; font-weight:600; opacity:0.9; }
.popup .cea_sync_turn_actions { margin-top:8px; display:flex; justify-content:flex-end; }
.popup .cea_sync_turn_diff_list { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
.popup .cea_sync_turn_diff_item { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 15%, transparent); border-radius:10px; padding:8px; }
.popup .cea_sync_turn_diff_title { font-weight:600; margin-bottom:6px; }
.popup .cea_sync_turn_diff_actions { display:flex; align-items:center; gap:6px; margin-bottom:8px; flex-wrap:wrap; }
.popup .cea_sync_turn_diff_status { padding:3px 8px; border-radius:999px; font-size:0.85em; line-height:1.2; border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 22%, transparent); }
.popup .cea_sync_turn_diff_status.approved { background:color-mix(in oklab, #4caf50 18%, transparent); }
.popup .cea_sync_turn_diff_status.rejected { background:color-mix(in oklab, #d9534f 16%, transparent); }
.popup .cea_sync_turn_diff_status.pending { background:color-mix(in oklab, var(--SmartThemeBodyColor) 10%, transparent); }
.popup .cea_sync_turn_diff_meta { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px; }
.popup .cea_sync_turn_diff_meta_item { padding:4px 8px; border-radius:8px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 10%, transparent); }
.popup .cea_sync_turn_diff_fields { display:flex; flex-direction:column; gap:8px; }
.popup .cea_sync_turn_diff_label { font-weight:600; margin-bottom:4px; }
.popup .cea_line_diff { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 14%, transparent); border-radius:8px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 5%, transparent); }
.popup .cea_line_diff > summary { cursor:pointer; padding:6px 8px; font-size:0.9em; display:flex; gap:8px; align-items:center; justify-content:space-between; }
.popup .cea_line_diff_summary_main { display:inline-flex; align-items:center; gap:8px; min-width:0; }
.popup .cea_line_diff_meta { opacity:0.75; font-size:0.88em; }
.popup .cea_line_diff_expand_btn { display:inline-flex; align-items:center; justify-content:center; min-width:2.2em; width:2.2em; padding:0; line-height:1; }
.popup .cea_line_diff_expand_btn i { pointer-events:none; }
.popup .cea_sync_popup,
.popup .cea_sync_chat_msg,
.popup .cea_sync_turn_diff,
.popup .cea_sync_turn_diff_item,
.popup .cea_sync_turn_diff_fields,
.popup .cea_sync_turn_diff_field,
.popup .cea_line_diff,
.popup .cea_line_diff_pre { min-width:0; max-width:100%; box-sizing:border-box; }
.popup .cea_line_diff_pre { margin:0; padding:6px; border-top:1px dashed color-mix(in oklab, var(--SmartThemeBodyColor) 16%, transparent); max-height:320px; overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; }
.popup .cea_line_diff_dual { --cea-split-left:50%; --cea-splitter-width:12px; display:grid; grid-template-columns:minmax(0, var(--cea-split-left)) var(--cea-splitter-width) minmax(0, calc(100% - var(--cea-split-left) - var(--cea-splitter-width))); gap:0; width:100%; min-width:0; align-items:stretch; }
.popup .cea_line_diff_splitter { position:relative; cursor:col-resize; touch-action:none; user-select:none; background:transparent; }
.popup .cea_line_diff_splitter::before { content:''; position:absolute; left:50%; top:0; bottom:0; width:2px; transform:translateX(-50%); border-radius:999px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 20%, transparent); transition:background-color .12s ease; }
.popup .cea_line_diff_splitter:hover::before,
.popup .cea_line_diff_splitter.active::before { background:color-mix(in oklab, var(--SmartThemeBodyColor) 38%, transparent); }
.popup .cea_line_diff_side { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 14%, transparent); border-radius:6px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 4%, transparent); min-width:0; overflow:hidden; }
.popup .cea_line_diff_side_scroll { overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch; touch-action:auto; }
.popup .cea_line_diff_table { width:max-content; min-width:100%; border-collapse:collapse; table-layout:fixed; font-size:0.82rem; }
.popup .cea_line_diff_pre,
.popup .cea_line_diff_table,
.popup .cea_line_diff_row td,
.popup .cea_line_diff_text,
.popup .cea_line_diff_text_inner { text-align:left; }
.popup .cea_line_diff_row td { border-bottom:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 12%, transparent); padding:2px 6px; vertical-align:top; }
.popup .cea_line_diff_row:last-child td { border-bottom:none; }
.popup .cea_line_diff_ln { width:3.8em; text-align:right; color:color-mix(in oklab, var(--SmartThemeBodyColor) 72%, transparent); font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; position:sticky; left:0; z-index:3; background-color:var(--SmartThemeBlurTintColor); box-shadow:1px 0 0 var(--SmartThemeBorderColor); background-image:none; opacity:1; }
.popup .cea_line_diff_text { width:auto; min-width:0; }
.popup .cea_line_diff_text_inner { white-space:pre; word-break:normal; overflow-wrap:normal; user-select:text; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; min-width:max-content; }
.popup .cea_line_diff_word_add { background:color-mix(in oklab, #4caf50 30%, transparent); border-radius:3px; padding:0 1px; }
.popup .cea_line_diff_word_del { background:color-mix(in oklab, #d9534f 30%, transparent); border-radius:3px; padding:0 1px; }
.popup .cea_line_diff_row_add .cea_line_diff_text.new { background:color-mix(in oklab, #4caf50 12%, transparent); }
.popup .cea_line_diff_row_del .cea_line_diff_text.old { background:color-mix(in oklab, #d9534f 12%, transparent); }
.popup .cea_line_diff_row_mod .cea_line_diff_text.old { background:color-mix(in oklab, #d9534f 10%, transparent); }
.popup .cea_line_diff_row_mod .cea_line_diff_text.new { background:color-mix(in oklab, #4caf50 10%, transparent); }
.popup .cea_line_diff_row_eq { background:transparent; }
.popup .cea_line_diff_zoom_overlay { position:fixed; inset:0; z-index:10010; display:flex; align-items:center; justify-content:center; }
.popup .cea_line_diff_zoom_backdrop { position:absolute; inset:0; background:color-mix(in oklab, #000 70%, transparent); }
.popup .cea_line_diff_zoom_dialog { position:relative; z-index:1; width:min(1280px, 95vw); height:min(92vh, 920px); border:1px solid var(--SmartThemeBorderColor); border-radius:10px; background:var(--SmartThemeBlurTintColor); display:flex; flex-direction:column; overflow:hidden; box-shadow:0 12px 36px rgba(0,0,0,0.45); }
.popup .cea_line_diff_zoom_header { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border-bottom:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 16%, transparent); }
.popup .cea_line_diff_zoom_title { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.popup .cea_line_diff_zoom_close { display:inline-flex; align-items:center; justify-content:center; min-width:2.2em; width:2.2em; padding:0; line-height:1; }
.popup .cea_line_diff_zoom_body { flex:1; min-height:0; overflow:auto; padding:10px; }
.popup .cea_line_diff_zoom_body .cea_line_diff_pre { max-height:none; height:auto; }
.popup .cea_sync_turn_diff_raw > summary { cursor:pointer; opacity:0.8; }
.popup .cea_sync_turn_diff_raw pre { margin-top:6px; max-height:180px; overflow:auto; }
.popup .cea_sync_turn_diff_empty { opacity:0.8; margin-top:6px; }
.popup .cea_editor_pending { margin-top:8px; border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 15%, transparent); border-radius:10px; padding:8px; display:flex; flex-direction:column; gap:8px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 8%, transparent); }
.popup .cea_editor_pending_hint { opacity:0.92; font-weight:600; }
.popup .cea_editor_pending_actions { display:flex; flex-wrap:wrap; gap:6px; justify-content:flex-end; }
@media (max-width: 900px) {
    #${UI_BLOCK_ID} .cea_diff_blocks { grid-template-columns:1fr; }
    .popup .cea_line_diff_ln { width:3.2em; }
}
`;
        document.head.append(style);
    }

    function ensureUi() {
        const host = jQuery('#extensions_settings2');
        if (!host.length) {
            return;
        }

        ensureStyles();
        if (jQuery(`#${UI_BLOCK_ID}`).length) {
            bindUi();
            return;
        }

        const html = `
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${escapeHtml(i18n('Character Editor Assistant'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="cea_row">
                <div class="menu_button" id="cea_open_editor_popup">${escapeHtml(i18n('Open Editor'))}</div>
                <div class="menu_button" id="cea_open_cardapp_studio"><i class="fa-solid fa-code"></i> ${escapeHtml(i18n('CardApp Studio'))}</div>
            </div>
            <label class="checkbox_label"><input id="cea_replace_sync" type="checkbox"/> ${escapeHtml(i18n('Enable lorebook sync popup after Replace/Update'))}</label>
            <label class="checkbox_label">
                <input id="cea_use_streaming_transport" type="checkbox" />
                ${escapeHtml(i18n('Use streaming transport (avoid timeout on slow APIs)'))}
            </label>
            <label for="cea_sync_llm_preset">${escapeHtml(i18n('Model request LLM preset name'))}</label>
            <select id="cea_sync_llm_preset" class="text_pole"></select>
            <label for="cea_sync_api_preset">${escapeHtml(i18n('Model request API preset name'))}</label>
            <select id="cea_sync_api_preset" class="text_pole"></select>
            <label for="cea_tool_retries">${escapeHtml(i18n('Tool-call retries on invalid/missing tool call (N)'))}</label>
            <input id="cea_tool_retries" class="text_pole" type="number" min="0" max="10" step="1"/>

            <div class="cea_panel">
                <div class="cea_row">
                    <div class="menu_button" id="cea_refresh">${escapeHtml(i18n('Refresh'))}</div>
                </div>
                <div><b>${escapeHtml(i18n('History'))}</b></div>
                <div id="cea_history"></div>
            </div>
            <small id="cea_status" class="cea_status"></small>
        </div>
    </div>
</div>`;

        host.append(html);
        bindUi();
    }

    function setStatus(message) {
        jQuery('#cea_status').text(String(message || ''));
    }

    async function refreshUiState(context = getContext()) {
        const root = jQuery(`#${UI_BLOCK_ID}`);
        if (!root.length) {
            return;
        }
        const settings = getSettings();
        root.find('#cea_replace_sync').prop('checked', Boolean(settings.replaceLorebookSyncEnabled));
        root.find('#cea_use_streaming_transport').prop('checked', Boolean(settings.useStreamingTransport));
        root.find('#cea_tool_retries').val(String(settings.toolCallRetryMax ?? defaultSettings.toolCallRetryMax));
        refreshPresetSelectors(root, context, settings);

        try {
            const state = await loadOperationState(context);
            root.find('#cea_history').html(renderJournalItems(state));
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to refresh UI state`, error);
        }
    }

    function bindUi() {
        const root = jQuery(`#${UI_BLOCK_ID}`);
        if (!root.length) {
            return;
        }

        root.off('.cea');
        jQuery(document).off('.ceaDiffZoom');

        jQuery(document).on('click.ceaDiffZoom', '.popup [data-cea-action="expand-line-diff"]', function (event) {
            event.preventDefault();
            event.stopPropagation();
            openCeaExpandedDiff(this);
        });

        jQuery(document).on('click.ceaDiffZoom', '.popup [data-cea-action="close-line-diff-zoom"], .popup .cea_line_diff_zoom_backdrop', function (event) {
            event.preventDefault();
            event.stopPropagation();
            closeCeaExpandedDiff(this);
        });

        jQuery(document).on('keydown.ceaDiffZoom', function (event) {
            if (event.key !== 'Escape') {
                return;
            }
            const overlays = Array.from(document.querySelectorAll('.popup .cea_line_diff_zoom_overlay'));
            const lastOverlay = overlays[overlays.length - 1];
            if (!(lastOverlay instanceof HTMLElement)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            lastOverlay.remove();
        });

        jQuery(document).on('pointerdown.ceaDiffZoom', '.popup .cea_line_diff_splitter', function (event) {
            beginCeaLineDiffResize(this, event.originalEvent || event);
        });

        root.on('change.cea', '#cea_replace_sync', function () {
            const settings = getSettings();
            settings.replaceLorebookSyncEnabled = Boolean(jQuery(this).prop('checked'));
            saveSettingsDebounced();
        });

        root.on('change.cea', '#cea_use_streaming_transport', function () {
            const settings = getSettings();
            settings.useStreamingTransport = Boolean(jQuery(this).prop('checked'));
            saveSettingsDebounced();
        });

        root.on('change.cea', '#cea_sync_llm_preset', function () {
            const settings = getSettings();
            settings.lorebookSyncLlmPresetName = String(jQuery(this).val() || '').trim();
            saveSettingsDebounced();
        });

        root.on('change.cea', '#cea_sync_api_preset', function () {
            const settings = getSettings();
            settings.lorebookSyncApiPresetName = String(jQuery(this).val() || '').trim();
            saveSettingsDebounced();
        });

        root.on('change.cea', '#cea_tool_retries', function () {
            const settings = getSettings();
            settings.toolCallRetryMax = Math.max(0, Math.min(10, Math.floor(Number(jQuery(this).val()) || 0)));
            saveSettingsDebounced();
        });

        root.on('click.cea', '#cea_refresh', async function () {
            await refreshUiState();
        });

        root.on('click.cea', '#cea_open_editor_popup', async function () {
            await openCharacterEditorPopup(getContext());
        });

        root.on('click.cea', '#cea_open_cardapp_studio', async function () {
            const context = getContext();
            const cardAppApi = context.getExtensionApi('card-app');
            const charId = cardAppApi?.getCharId?.();
            if (!charId) {
                toastr.warning(i18n('No character selected or character has no avatar.'));
                return;
            }
            try {
                const { openCardAppStudio } = await import('./studio/studio.js');
                await openCardAppStudio(charId);
            } catch (err) {
                console.error('[CEA] Failed to open CardApp Studio:', err);
                toastr.error(String(err?.message || err));
            }
        });
    }

    return {
        bindUi,
        buildCharacterEditorPopupHtml,
        ensureStyles,
        ensureUi,
        refreshUiState,
        renderCharacterEditorConversationHistoryItems,
        setStatus,
    };
}
