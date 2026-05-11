export function createCompletionPresetAssistantDialogUi(deps) {
    const {
        CREATE_BUTTON_ID,
        OPENAI_BUTTON_ID,
        OPEN_BUTTON_ID,
        SESSION_MESSAGE_LIMIT_MAX,
        SESSION_MESSAGE_LIMIT_MIN,
        TOOL_CALL_RETRY_MAX,
        UI_BLOCK_ID,
        bindHandleCreateNewPreset,
        bindOpenAssistantPopup,
        buildDialogMetaItems,
        defaultSettings,
        ensureSettings,
        escapeHtml,
        getConnectionProfileNames,
        getContext,
        getOpenAIPresetNames,
        getSettings,
        handleApplyDraft,
        handleClearHistory,
        handleDiscardDraft,
        handleReferenceChange,
        handleReferenceDiff,
        handleLoadSession,
        handleDeleteSession,
        handleMessageDiff,
        handleNewSession,
        handleRollbackToMessage,
        handleSend,
        i18n,
        i18nFormat,
        renderConversationHtml,
        renderDraftHtml,
        renderPresetConversationHistoryItems,
        renderSelectOptions,
        saveSettingsDebounced,
        toInteger,
    } = deps;

    function renderDialogHtml(dialogState) {
        const referenceNames = getOpenAIPresetNames(dialogState.context)
            .filter(name => name && name !== dialogState.targetRef?.name);
        const metaItems = buildDialogMetaItems(dialogState);
        const isBusy = Boolean(dialogState.busy);
        const statusHtml = dialogState.status
            ? `${isBusy ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ' : ''}${escapeHtml(dialogState.status || '')}`
            : '';

        return `
<div class="luker-studio cpa_dialog${isBusy ? ' is_busy' : ''}">
    <div class="luker-studio-meta">
        ${metaItems.map(item => `<div class="luker-studio-meta-item">${escapeHtml(item)}</div>`).join('')}
    </div>
    <div class="luker-studio-toolbar">
        <div class="luker-studio-toolbar-field">
            <label for="cpa_reference_preset">${escapeHtml(i18n('Reference preset'))}</label>
            <select id="cpa_reference_preset" class="text_pole" title="${escapeHtml(i18n('Select reference preset'))}">
                ${renderSelectOptions(referenceNames, dialogState.session?.referencePresetName || '', true)}
            </select>
        </div>
        <div class="luker-studio-toolbar-actions">
            <div class="menu_button menu_button_small" data-cpa-action="show-reference-diff">${escapeHtml(i18n('Compare with reference'))}</div>
            <div class="menu_button menu_button_small" data-cpa-action="clear-history">${escapeHtml(i18n('Clear history'))}</div>
        </div>
    </div>
    <div class="luker-studio-columns">
        <div class="luker-studio-panel">
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Conversation'))}</div>
            <details class="luker-studio-history" open>
                <summary>${escapeHtml(i18n('Conversation history'))}</summary>
                ${renderPresetConversationHistoryItems(dialogState.sessionStore, dialogState.currentSessionId)}
            </details>
            <div class="luker-studio-chat">${renderConversationHtml(dialogState.session, dialogState.journal)}</div>
        </div>
        <div class="luker-studio-panel">
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Draft diff'))}</div>
            ${renderDraftHtml(dialogState)}
        </div>
    </div>
    <div class="luker-studio-composer">
        <textarea id="cpa_dialog_input" class="text_pole" placeholder="${escapeHtml(i18n('Type what to change in this preset...'))}">${escapeHtml(dialogState.inputText || '')}</textarea>
        <div class="luker-studio-composer-actions">
            <div class="luker-studio-composer-meta">
                <div class="luker-studio-status">${statusHtml}</div>
            </div>
            <div class="luker-studio-composer-buttons">
                <div class="menu_button" data-cpa-action="send-or-stop">${escapeHtml(isBusy ? i18n('Stop') : i18n('Send'))}</div>
                <div class="menu_button" data-cpa-action="close">${escapeHtml(i18n('Close'))}</div>
            </div>
        </div>
    </div>
</div>`;
    }

    async function rerenderDialog(dialogState) {
        if (!dialogState?.root) {
            return;
        }
        dialogState.root.html(renderDialogHtml(dialogState));
    }

    function bindDialogEvents(dialogState) {
        if (!dialogState?.root) {
            return;
        }

        dialogState.root.off('.cpaDialog');
        dialogState.root.on('input.cpaDialog', '#cpa_dialog_input', function () {
            dialogState.inputText = String(jQuery(this).val() || '');
        });
        dialogState.root.on('change.cpaDialog', '#cpa_reference_preset', async function () {
            await handleReferenceChange(dialogState, jQuery(this).val());
        });
        dialogState.root.on('click.cpaDialog', '[data-cpa-action="send-or-stop"]', async function () {
            await handleSend(dialogState);
        });
        dialogState.root.on('click.cpaDialog', '[data-cpa-action="apply-draft"]', async function () {
            await handleApplyDraft(dialogState);
        });
        dialogState.root.on('click.cpaDialog', '[data-cpa-action="discard-draft"]', async function () {
            await handleDiscardDraft(dialogState);
        });
        dialogState.root.on('click.cpaDialog', '[data-cpa-action="show-reference-diff"]', async function () {
            await handleReferenceDiff(dialogState);
        });
        dialogState.root.on('click.cpaDialog', '[data-cpa-action="show-message-diff"]', async function () {
            await handleMessageDiff(dialogState, jQuery(this).attr('data-cpa-message-id'));
        });
        dialogState.root.on('click.cpaDialog', '[data-cpa-action="rollback-to-message"]', async function () {
            await handleRollbackToMessage(dialogState, jQuery(this).attr('data-cpa-message-id'));
        });
        dialogState.root.on('click.cpaDialog', '[data-cpa-action="clear-history"]', async function () {
            await handleClearHistory(dialogState);
        });
        dialogState.root.on('click.cpaDialog', '[data-cpa-action="close"]', async function () {
            await dialogState.popup?.completeCancelled?.();
        });
        dialogState.root.on('click.cpaDialog', '[data-cpa-history-action]', async function () {
            const action = String(jQuery(this).attr('data-cpa-history-action') || '').trim();
            const sessionId = String(jQuery(this).attr('data-cpa-session-id') || '').trim();
            try {
                if (action === 'new-session') {
                    await handleNewSession(dialogState);
                    return;
                }
                if (action === 'load-session') {
                    await handleLoadSession(dialogState, sessionId);
                    return;
                }
                if (action === 'delete-session') {
                    await handleDeleteSession(dialogState, sessionId);
                }
            } catch (error) {
                if (action === 'delete-session') {
                    toastr.error(i18nFormat('Conversation delete failed: ${0}', error?.message || error));
                    return;
                }
                toastr.error(i18nFormat('Load failed: ${0}', error?.message || error));
            }
        });
    }

    function ensureOpenAiToolbarButton() {
        const toolbar = jQuery('#openai_api-presets .preset_manager_select_actions').first();
        if (!toolbar.length || toolbar.find(`#${OPENAI_BUTTON_ID}`).length) {
            return;
        }

        toolbar.append(`
<div id="${OPENAI_BUTTON_ID}" class="menu_button menu_button_icon completion-preset-assistant-open" title="${escapeHtml(i18n('Open Assistant'))}">
    <i class="fa-fw fa-solid fa-wand-magic-sparkles"></i>
</div>`);
    }

    function refreshUiState(context = getContext()) {
        ensureSettings();
        ensureOpenAiToolbarButton();
        const root = jQuery(`#${UI_BLOCK_ID}`);
        if (!root.length) {
            return;
        }

        const settings = getSettings();
        root.find('#cpa_request_llm_preset').html(renderSelectOptions(getOpenAIPresetNames(context), settings.requestLlmPresetName, true, '(current)'));
        root.find('#cpa_request_api_profile').html(renderSelectOptions(getConnectionProfileNames(), settings.requestApiProfileName, true, '(current)'));
        root.find('#cpa_include_world_info').prop('checked', settings.includeWorldInfo === true);
        root.find('#cpa_tool_retries').val(String(settings.toolCallRetryMax));
        root.find('#cpa_session_message_limit').val(String(settings.sessionMessageLimit));
    }

    function bindUi() {
        const root = jQuery(`#${UI_BLOCK_ID}`);
        if (!root.length) {
            return;
        }

        root.off('.cpa');
        jQuery(document).off('.cpaOpen');

        root.on('click.cpa', `#${OPEN_BUTTON_ID}`, async function () {
            await bindOpenAssistantPopup();
        });
        root.on('click.cpa', `#${CREATE_BUTTON_ID}`, async function () {
            await bindHandleCreateNewPreset();
        });
        root.on('change.cpa', '#cpa_request_llm_preset', function () {
            getSettings().requestLlmPresetName = String(jQuery(this).val() || '').trim();
            saveSettingsDebounced();
        });
        root.on('change.cpa', '#cpa_request_api_profile', function () {
            getSettings().requestApiProfileName = String(jQuery(this).val() || '').trim();
            saveSettingsDebounced();
        });
        root.on('change.cpa', '#cpa_include_world_info', function () {
            getSettings().includeWorldInfo = jQuery(this).prop('checked') === true;
            saveSettingsDebounced();
        });
        root.on('change.cpa', '#cpa_tool_retries', function () {
            getSettings().toolCallRetryMax = Math.max(0, Math.min(TOOL_CALL_RETRY_MAX, toInteger(jQuery(this).val(), defaultSettings.toolCallRetryMax)));
            saveSettingsDebounced();
            refreshUiState();
        });
        root.on('change.cpa', '#cpa_session_message_limit', function () {
            getSettings().sessionMessageLimit = Math.max(
                SESSION_MESSAGE_LIMIT_MIN,
                Math.min(SESSION_MESSAGE_LIMIT_MAX, toInteger(jQuery(this).val(), defaultSettings.sessionMessageLimit)),
            );
            saveSettingsDebounced();
            refreshUiState();
        });

        jQuery(document).on('click.cpaOpen', `#${OPENAI_BUTTON_ID}`, async function () {
            await bindOpenAssistantPopup();
        });
    }

    function ensureUi(context = getContext()) {
        const host = jQuery('#extensions_settings2');
        if (!host.length) {
            return;
        }

        ensureOpenAiToolbarButton();
        if (jQuery(`#${UI_BLOCK_ID}`).length) {
            bindUi();
            refreshUiState(context);
            return;
        }

        host.append(`
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${escapeHtml(i18n('Completion Preset Assistant'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="cpa_row">
                <div id="${OPEN_BUTTON_ID}" class="menu_button">${escapeHtml(i18n('Open Assistant'))}</div>
                <div id="${CREATE_BUTTON_ID}" class="menu_button">${escapeHtml(i18n('Create New Preset'))}</div>
            </div>
            <div class="cpa_hint">${escapeHtml(i18n('Character-bound runtime presets are not directly editable.'))}</div>
            <label for="cpa_request_llm_preset">${escapeHtml(i18n('Model request LLM preset name'))}</label>
            <select id="cpa_request_llm_preset" class="text_pole"></select>
            <label for="cpa_request_api_profile">${escapeHtml(i18n('Model request API preset name (Connection profile)'))}</label>
            <select id="cpa_request_api_profile" class="text_pole"></select>
            <label class="checkbox_label"><input id="cpa_include_world_info" type="checkbox"/> ${escapeHtml(i18n('Include world info (simulate current chat)'))}</label>
            <label for="cpa_tool_retries">${escapeHtml(i18n('Tool-call retries on invalid/missing tool call (N)'))}</label>
            <input id="cpa_tool_retries" class="text_pole" type="number" min="0" max="${TOOL_CALL_RETRY_MAX}" step="1"/>
            <label for="cpa_session_message_limit">${escapeHtml(i18n('Stored session messages per preset'))}</label>
            <input id="cpa_session_message_limit" class="text_pole" type="number" min="${SESSION_MESSAGE_LIMIT_MIN}" max="${SESSION_MESSAGE_LIMIT_MAX}" step="1"/>
        </div>
    </div>
</div>`);

        bindUi();
        refreshUiState(context);
    }

    return {
        bindDialogEvents,
        bindUi,
        ensureOpenAiToolbarButton,
        ensureUi,
        refreshUiState,
        rerenderDialog,
    };
}
