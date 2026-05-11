export function createSearchToolsSettingsUi(deps) {
    const {
        DEFAULT_SETTINGS,
        MODULE_NAME,
        SECRET_KEYS,
        STATUS_ID,
        STYLE_ID,
        UI_BLOCK_ID,
        clampInteger,
        ensureSharedLorebook,
        escapeHtml,
        extension_prompt_roles,
        getAvailableSearchProviders,
        getConnectionProfileOptions,
        getContext,
        getOpenAIPresetOptions,
        getProviderSettings,
        getSettings,
        hasConfiguredSecret,
        i18n,
        listManagedEntries,
        normalizeLorebookPosition,
        normalizeLorebookRole,
        normalizeProvider,
        normalizeSafeSearch,
        normalizeWhitespace,
        saveSettingsDebounced,
        syncSharedLorebookForCurrentChat,
        syncSharedLorebookForLoadedChat,
        world_info_position,
    } = deps;

    let activeAgentRunInfoToast = null;

    function renderSearchProviderOptions(selectedProvider = '') {
        const selected = normalizeProvider(selectedProvider);
        return getAvailableSearchProviders()
            .map(provider => `<option value="${escapeHtml(provider.id)}"${provider.id === selected ? ' selected' : ''}>${escapeHtml(i18n(provider.label))}</option>`)
            .join('');
    }

    function renderSafeSearchOptions(selectedValue = '') {
        const selected = normalizeSafeSearch(selectedValue);
        const options = [
            ['off', 'Off'],
            ['moderate', 'Moderate'],
            ['strict', 'Strict'],
        ];
        return options
            .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(i18n(label))}</option>`)
            .join('');
    }

    function buildProviderSettingsPanelHtml(settings = getSettings()) {
        const providerId = normalizeProvider(settings.provider);
        if (providerId === 'ddg') {
            const providerSettings = getProviderSettings(settings, providerId);
            return `
        <label for="search_tools_ddg_safe_search">${escapeHtml(i18n('Default safe search'))}</label>
        <select id="search_tools_ddg_safe_search" class="text_pole">
            ${renderSafeSearchOptions(providerSettings.safeSearch)}
        </select>`;
        }
        if (providerId === 'searxng') {
            const providerSettings = getProviderSettings(settings, providerId);
            return `
        <label for="search_tools_searxng_base_url">${escapeHtml(i18n('SearXNG instance URL'))}</label>
        <input id="search_tools_searxng_base_url" class="text_pole" type="text" placeholder="https://your-searxng.example" value="${escapeHtml(providerSettings.baseUrl || '')}" />
        <label for="search_tools_searxng_safe_search">${escapeHtml(i18n('Default safe search'))}</label>
        <select id="search_tools_searxng_safe_search" class="text_pole">
            ${renderSafeSearchOptions(providerSettings.safeSearch)}
        </select>`;
        }
        if (providerId === 'brave') {
            const providerSettings = getProviderSettings(settings, providerId);
            const hasApiKey = hasConfiguredSecret(SECRET_KEYS.BRAVE_SEARCH);
            return `
        <label>${escapeHtml(i18n('Brave API key'))}</label>
        <div class="flex-container alignitemscenter">
            <span class="text_muted">${escapeHtml(i18n(hasApiKey ? 'Configured' : 'Not configured'))}</span>
            <div class="menu_button menu_button_small manage-api-keys" data-key="${escapeHtml(SECRET_KEYS.BRAVE_SEARCH)}">${escapeHtml(i18n('Manage API key'))}</div>
        </div>
        <label for="search_tools_brave_safe_search">${escapeHtml(i18n('Default safe search'))}</label>
        <select id="search_tools_brave_safe_search" class="text_pole">
            ${renderSafeSearchOptions(providerSettings.safeSearch)}
        </select>`;
        }

        return '';
    }

    function refreshProviderSettingsUi(root, settings = getSettings()) {
        root.find('#search_tools_provider').html(renderSearchProviderOptions(settings.provider));
        root.find('#search_tools_provider_settings').html(buildProviderSettingsPanelHtml(settings));
    }

    function renderSettingsBlock() {
        return `
<div id="${UI_BLOCK_ID}" class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>${escapeHtml(i18n('Search Tools'))}</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
        <label class="checkbox_label">
            <input id="search_tools_enabled" type="checkbox" />
            ${escapeHtml(i18n('Expose tools to main model'))}
        </label>
        <label class="checkbox_label">
            <input id="search_tools_pre_request_enabled" type="checkbox" />
            ${escapeHtml(i18n('Run pre-request search agent'))}
        </label>
        <label for="search_tools_provider">${escapeHtml(i18n('Search provider'))}</label>
        <select id="search_tools_provider" class="text_pole"></select>
        <div id="search_tools_provider_settings"></div>
        <label for="search_tools_default_max_results">${escapeHtml(i18n('Default max search results'))}</label>
        <input id="search_tools_default_max_results" class="text_pole" type="number" min="1" max="20" step="1" />
        <label for="search_tools_default_visit_max_chars">${escapeHtml(i18n('Default page excerpt max chars (0 = no truncation)'))}</label>
        <input id="search_tools_default_visit_max_chars" class="text_pole" type="number" min="0" max="50000" step="100" />
        <label for="search_tools_agent_api_preset_name">${escapeHtml(i18n('Agent API preset (Connection profile)'))}</label>
        <select id="search_tools_agent_api_preset_name" class="text_pole"></select>
        <label for="search_tools_agent_preset_name">${escapeHtml(i18n('Agent preset (params + prompt)'))}</label>
        <select id="search_tools_agent_preset_name" class="text_pole"></select>
        <label class="checkbox_label">
            <input id="search_tools_include_world_info_with_preset" type="checkbox" />
            ${escapeHtml(i18n('Include world info'))}
        </label>
        <label for="search_tools_agent_max_rounds">${escapeHtml(i18n('Agent max rounds'))}</label>
        <input id="search_tools_agent_max_rounds" class="text_pole" type="number" min="1" max="8" step="1" />
        <label for="search_tools_tool_call_retry_max">${escapeHtml(i18n('Tool call retry count'))}</label>
        <input id="search_tools_tool_call_retry_max" class="text_pole" type="number" min="0" max="5" step="1" />
        <label for="search_tools_lorebook_position">${escapeHtml(i18n('Injection position'))}</label>
        <select id="search_tools_lorebook_position" class="text_pole">
            <option value="${world_info_position.before}">${escapeHtml(i18n('Before Character Definitions'))}</option>
            <option value="${world_info_position.after}">${escapeHtml(i18n('After Character Definitions'))}</option>
            <option value="${world_info_position.ANTop}">${escapeHtml(i18n('Before Author\'s Note'))}</option>
            <option value="${world_info_position.ANBottom}">${escapeHtml(i18n('After Author\'s Note'))}</option>
            <option value="${world_info_position.EMTop}">${escapeHtml(i18n('Before Example Messages'))}</option>
            <option value="${world_info_position.EMBottom}">${escapeHtml(i18n('After Example Messages'))}</option>
            <option value="${world_info_position.atDepth}">${escapeHtml(i18n('At Chat Depth'))}</option>
        </select>
        <label for="search_tools_lorebook_depth">${escapeHtml(i18n('Injection depth (At Chat Depth only)'))}</label>
        <input id="search_tools_lorebook_depth" class="text_pole" type="number" min="0" max="9999" step="1" />
        <label for="search_tools_lorebook_role">${escapeHtml(i18n('Injection role (At Chat Depth only)'))}</label>
        <select id="search_tools_lorebook_role" class="text_pole">
            <option value="${extension_prompt_roles.SYSTEM}">${escapeHtml(i18n('System'))}</option>
            <option value="${extension_prompt_roles.USER}">${escapeHtml(i18n('User'))}</option>
            <option value="${extension_prompt_roles.ASSISTANT}">${escapeHtml(i18n('Assistant'))}</option>
        </select>
        <label for="search_tools_lorebook_entry_order">${escapeHtml(i18n('Injection order'))}</label>
        <input id="search_tools_lorebook_entry_order" class="text_pole" type="number" min="0" max="20000" step="1" />
        <label for="search_tools_agent_system_prompt">${escapeHtml(i18n('Search-stage agent system prompt'))}</label>
        <textarea id="search_tools_agent_system_prompt" class="text_pole" rows="12"></textarea>
        <label for="search_tools_agent_final_stage_prompt">${escapeHtml(i18n('Final-stage agent system prompt'))}</label>
        <textarea id="search_tools_agent_final_stage_prompt" class="text_pole" rows="12"></textarea>
        <div class="flex-container">
            <div id="search_tools_reset_agent_prompt" class="menu_button menu_button_small">${escapeHtml(i18n('Reset search-stage agent prompt'))}</div>
            <div id="search_tools_reset_agent_final_stage_prompt" class="menu_button menu_button_small">${escapeHtml(i18n('Reset final-stage agent prompt'))}</div>
        </div>
        <div id="${STATUS_ID}" class="wide100p text_muted" style="margin-top: 8px;"></div>
    </div>
</div>`;
    }

    function ensureStyles() {
        if (jQuery(`#${STYLE_ID}`).length) {
            return;
        }

        jQuery('head').append(`
<style id="${STYLE_ID}">
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
</style>`);
    }

    function updateUiStatus(text) {
        const element = jQuery(`#${STATUS_ID}`);
        if (!element.length) {
            return;
        }
        element.text(String(text || ''));
    }

    function showAgentRunInfoToast(message, { stopLabel = '', onStop = null } = {}) {
        if (typeof toastr === 'undefined') {
            return;
        }
        if (activeAgentRunInfoToast) {
            toastr.clear(activeAgentRunInfoToast);
            activeAgentRunInfoToast = null;
        }
        activeAgentRunInfoToast = toastr.info(String(message || ''), '', {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            closeButton: true,
            progressBar: false,
        });
        if (activeAgentRunInfoToast && typeof onStop === 'function') {
            const toastBody = activeAgentRunInfoToast.find('.toast-message');
            if (toastBody.length > 0) {
                const button = jQuery('<button type="button" class="menu_button menu_button_small luker-toast-stop-button"></button>');
                button.text(String(stopLabel || i18n('Stop')));
                button.on('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    button.prop('disabled', true);
                    const toastElement = button.closest('.toast');
                    clearAgentRunInfoToast();
                    if (toastElement && toastElement.length > 0) {
                        toastElement.remove();
                    }
                    onStop();
                });
                toastBody.append(button);
            }
        }
    }

    function clearAgentRunInfoToast() {
        if (typeof toastr === 'undefined' || !activeAgentRunInfoToast) {
            return;
        }
        toastr.clear(activeAgentRunInfoToast);
        activeAgentRunInfoToast = null;
    }

    async function refreshUiStatusForCurrentChat() {
        const context = getContext();
        if (!context?.chatId && !context?.getCurrentChatId?.()) {
            updateUiStatus(i18n('No active chat.'));
            return;
        }
        try {
            const lorebook = await ensureSharedLorebook(context, false);
            const entryCount = lorebook?.data ? listManagedEntries(lorebook.data).length : 0;
            if (!lorebook?.bookName) {
                updateUiStatus(i18n('No shared search lorebook yet.'));
                return;
            }
            updateUiStatus(i18n(`Shared lorebook: ${lorebook.bookName} | Managed search entries: ${entryCount}`));
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to refresh UI status`, error);
            updateUiStatus(i18n('Failed to inspect shared search lorebook.'));
        }
    }

    function bindSettingsUi() {
        const root = jQuery(`#${UI_BLOCK_ID}`);
        if (!root.length) {
            return;
        }

        const context = getContext();
        const settings = getSettings();
        root.find('#search_tools_agent_api_preset_name').html(getConnectionProfileOptions(settings.agentApiPresetName));
        root.find('#search_tools_agent_preset_name').html(getOpenAIPresetOptions(context, settings.agentPresetName));
        refreshProviderSettingsUi(root, settings);
        root.find('#search_tools_enabled').prop('checked', Boolean(settings.enabled));
        root.find('#search_tools_pre_request_enabled').prop('checked', Boolean(settings.preRequestEnabled));
        root.find('#search_tools_provider').val(String(settings.provider || 'ddg'));
        root.find('#search_tools_default_max_results').val(String(settings.defaultMaxResults));
        root.find('#search_tools_default_visit_max_chars').val(String(settings.defaultVisitMaxChars));
        root.find('#search_tools_agent_api_preset_name').val(String(settings.agentApiPresetName || ''));
        root.find('#search_tools_agent_preset_name').val(String(settings.agentPresetName || ''));
        root.find('#search_tools_include_world_info_with_preset').prop('checked', Boolean(settings.includeWorldInfoWithPreset));
        root.find('#search_tools_agent_max_rounds').val(String(settings.agentMaxRounds));
        root.find('#search_tools_tool_call_retry_max').val(String(settings.toolCallRetryMax));
        root.find('#search_tools_lorebook_position').val(String(settings.lorebookPosition));
        root.find('#search_tools_lorebook_depth').val(String(settings.lorebookDepth));
        root.find('#search_tools_lorebook_role').val(String(settings.lorebookRole));
        root.find('#search_tools_lorebook_entry_order').val(String(settings.lorebookEntryOrder));
        root.find('#search_tools_agent_system_prompt').val(String(settings.agentSystemPrompt || DEFAULT_SETTINGS.agentSystemPrompt));
        root.find('#search_tools_agent_final_stage_prompt').val(String(settings.agentFinalStagePrompt || DEFAULT_SETTINGS.agentFinalStagePrompt));

        root.off('.searchTools');
        root.on('input.searchTools', '#search_tools_enabled', function () {
            settings.enabled = Boolean(jQuery(this).prop('checked'));
            void syncSharedLorebookForCurrentChat(getContext());
            saveSettingsDebounced();
        });
        root.on('input.searchTools', '#search_tools_pre_request_enabled', function () {
            settings.preRequestEnabled = Boolean(jQuery(this).prop('checked'));
            void syncSharedLorebookForCurrentChat(getContext());
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_provider', function () {
            settings.provider = normalizeProvider(jQuery(this).val());
            refreshProviderSettingsUi(root, settings);
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_default_max_results', function () {
            settings.defaultMaxResults = clampInteger(jQuery(this).val(), 1, 20, DEFAULT_SETTINGS.defaultMaxResults);
            jQuery(this).val(String(settings.defaultMaxResults));
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_default_visit_max_chars', function () {
            settings.defaultVisitMaxChars = clampInteger(jQuery(this).val(), 0, 50000, DEFAULT_SETTINGS.defaultVisitMaxChars);
            jQuery(this).val(String(settings.defaultVisitMaxChars));
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_ddg_safe_search', function () {
            settings.providers.ddg.safeSearch = normalizeSafeSearch(jQuery(this).val());
            settings.safeSearch = settings.providers.ddg.safeSearch;
            saveSettingsDebounced();
        });
        root.on('change.searchTools input.searchTools', '#search_tools_searxng_base_url', function () {
            settings.providers.searxng.baseUrl = normalizeWhitespace(jQuery(this).val());
            jQuery(this).val(settings.providers.searxng.baseUrl);
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_searxng_safe_search', function () {
            settings.providers.searxng.safeSearch = normalizeSafeSearch(jQuery(this).val());
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_brave_safe_search', function () {
            settings.providers.brave.safeSearch = normalizeSafeSearch(jQuery(this).val());
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_agent_api_preset_name', function () {
            settings.agentApiPresetName = normalizeWhitespace(jQuery(this).val());
            jQuery(this).val(settings.agentApiPresetName);
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_agent_preset_name', function () {
            settings.agentPresetName = normalizeWhitespace(jQuery(this).val());
            jQuery(this).val(settings.agentPresetName);
            saveSettingsDebounced();
        });
        root.on('input.searchTools', '#search_tools_include_world_info_with_preset', function () {
            settings.includeWorldInfoWithPreset = Boolean(jQuery(this).prop('checked'));
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_agent_max_rounds', function () {
            settings.agentMaxRounds = clampInteger(jQuery(this).val(), 1, 8, DEFAULT_SETTINGS.agentMaxRounds);
            jQuery(this).val(String(settings.agentMaxRounds));
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_tool_call_retry_max', function () {
            settings.toolCallRetryMax = clampInteger(jQuery(this).val(), 0, 5, DEFAULT_SETTINGS.toolCallRetryMax);
            jQuery(this).val(String(settings.toolCallRetryMax));
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_lorebook_position', function () {
            settings.lorebookPosition = normalizeLorebookPosition(jQuery(this).val());
            jQuery(this).val(String(settings.lorebookPosition));
            void syncSharedLorebookForLoadedChat(getContext());
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_lorebook_depth', function () {
            settings.lorebookDepth = clampInteger(jQuery(this).val(), 0, 9999, DEFAULT_SETTINGS.lorebookDepth);
            jQuery(this).val(String(settings.lorebookDepth));
            void syncSharedLorebookForLoadedChat(getContext());
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_lorebook_role', function () {
            settings.lorebookRole = normalizeLorebookRole(jQuery(this).val());
            jQuery(this).val(String(settings.lorebookRole));
            void syncSharedLorebookForLoadedChat(getContext());
            saveSettingsDebounced();
        });
        root.on('change.searchTools', '#search_tools_lorebook_entry_order', function () {
            settings.lorebookEntryOrder = clampInteger(jQuery(this).val(), 0, 20000, DEFAULT_SETTINGS.lorebookEntryOrder);
            jQuery(this).val(String(settings.lorebookEntryOrder));
            void syncSharedLorebookForLoadedChat(getContext());
            saveSettingsDebounced();
        });
        root.on('change.searchTools input.searchTools', '#search_tools_agent_system_prompt', function () {
            settings.agentSystemPrompt = String(jQuery(this).val() || '').trim() || DEFAULT_SETTINGS.agentSystemPrompt;
            saveSettingsDebounced();
        });
        root.on('change.searchTools input.searchTools', '#search_tools_agent_final_stage_prompt', function () {
            settings.agentFinalStagePrompt = String(jQuery(this).val() || '').trim() || DEFAULT_SETTINGS.agentFinalStagePrompt;
            saveSettingsDebounced();
        });
        root.on('click.searchTools', '#search_tools_reset_agent_prompt', function () {
            if (!window.confirm(i18n('Reset search-stage agent prompt to default? This will overwrite the current search-stage system prompt.'))) {
                return;
            }
            settings.agentSystemPrompt = DEFAULT_SETTINGS.agentSystemPrompt;
            root.find('#search_tools_agent_system_prompt').val(settings.agentSystemPrompt);
            saveSettingsDebounced();
            if (typeof toastr !== 'undefined') {
                toastr.success(i18n('Reset search-stage agent prompt'));
            }
        });
        root.on('click.searchTools', '#search_tools_reset_agent_final_stage_prompt', function () {
            if (!window.confirm(i18n('Reset final-stage agent prompt to default? This will overwrite the current final-stage system prompt.'))) {
                return;
            }
            settings.agentFinalStagePrompt = DEFAULT_SETTINGS.agentFinalStagePrompt;
            root.find('#search_tools_agent_final_stage_prompt').val(settings.agentFinalStagePrompt);
            saveSettingsDebounced();
            if (typeof toastr !== 'undefined') {
                toastr.success(i18n('Reset final-stage agent prompt'));
            }
        });
    }

    function ensureUi() {
        const host = jQuery('#extensions_settings2');
        if (!host.length) {
            return;
        }

        ensureStyles();

        if (!jQuery(`#${UI_BLOCK_ID}`).length) {
            host.append(renderSettingsBlock());
        }
        bindSettingsUi();
        void refreshUiStatusForCurrentChat();
    }

    return {
        bindSettingsUi,
        clearAgentRunInfoToast,
        ensureUi,
        refreshUiStatusForCurrentChat,
        showAgentRunInfoToast,
        updateUiStatus,
    };
}
