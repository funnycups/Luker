import { renderPresetHelpButton } from '../preset-help.js';

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
        manuallyDeleteManagedEntries,
        manuallyResetManagedEntries,
        getManagedEntriesSnapshot,
        POPUP_TYPE,
        Popup,
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

    // Toggle the depth/role input blocks based on the current position
    // select — these settings only apply when position === atDepth
    // (`applyManagedEntriesToLorebook` writes them unconditionally to
    // the entry, but the ST world-info engine ignores non-atDepth entries'
    // depth/role at inject time). Showing the fields for other positions
    // implied they had an effect. Root-scoped so the helper works from
    // both the init hydrate step and the position change handler.
    function updateLorebookPositionVisibility(root) {
        const positionVal = Number(root.find('#search_tools_lorebook_position').val());
        const isAtDepth = positionVal === Number(world_info_position.atDepth);
        root.find('#search_tools_lorebook_depth_block').toggle(isAtDepth);
        root.find('#search_tools_lorebook_role_block').toggle(isAtDepth);
    }

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
        <label for="search_tools_agent_preset_name">${escapeHtml(i18n('Agent preset (params + prompt)'))}${renderPresetHelpButton({ kind: 'agent' })}</label>
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
        <div id="search_tools_lorebook_depth_block" style="display:none">
            <label for="search_tools_lorebook_depth">${escapeHtml(i18n('Injection depth'))}</label>
            <input id="search_tools_lorebook_depth" class="text_pole" type="number" min="0" max="9999" step="1" />
        </div>
        <div id="search_tools_lorebook_role_block" style="display:none">
            <label for="search_tools_lorebook_role">${escapeHtml(i18n('Injection role'))}</label>
            <select id="search_tools_lorebook_role" class="text_pole">
                <option value="${extension_prompt_roles.SYSTEM}">${escapeHtml(i18n('System'))}</option>
                <option value="${extension_prompt_roles.USER}">${escapeHtml(i18n('User'))}</option>
                <option value="${extension_prompt_roles.ASSISTANT}">${escapeHtml(i18n('Assistant'))}</option>
            </select>
        </div>
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
        <div class="flex-container" style="margin-top: 8px;">
            <div id="search_tools_manage_entries" class="menu_button menu_button_small">${escapeHtml(i18n('Manage stored search entries'))}</div>
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
.luker-stm-entries .luker-stm-intro {
    margin-bottom: 8px;
    opacity: 0.75;
}
.luker-stm-entries .luker-stm-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--SmartThemeBorderColor);
    margin-bottom: 10px;
}
.luker-stm-entries .luker-stm-toolbar-spacer {
    flex: 1 1 auto;
}
.luker-stm-entries .luker-stm-count {
    opacity: 0.75;
}
.luker-stm-entries .luker-stm-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.luker-stm-entries .luker-stm-card {
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 6px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 50%, transparent);
}
.luker-stm-entries .luker-stm-card-head {
    display: flex;
    align-items: center;
    gap: 8px;
}
.luker-stm-entries .luker-stm-title {
    flex: 1 1 auto;
    font-weight: 600;
    overflow-wrap: anywhere;
}
.luker-stm-entries .luker-stm-actions {
    display: flex;
    gap: 6px;
}
.luker-stm-entries .luker-stm-keys {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
}
.luker-stm-entries .luker-stm-tag {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 12px;
    border: 1px solid var(--SmartThemeBorderColor);
    color: var(--SmartThemeQuoteColor);
    background: color-mix(in srgb, var(--SmartThemeQuoteColor) 10%, transparent);
    font-size: 0.85em;
    line-height: 1.4;
    white-space: nowrap;
}
.luker-stm-entries .luker-stm-content {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed var(--SmartThemeBorderColor);
    font-size: 0.9em;
    opacity: 0.85;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 8em;
    overflow-y: auto;
}
.luker-stm-entries .luker-stm-flag {
    display: inline-block;
    padding: 0 6px;
    margin-left: 6px;
    border-radius: 4px;
    border: 1px solid var(--SmartThemeQuoteColor);
    color: var(--SmartThemeQuoteColor);
    background: color-mix(in srgb, var(--SmartThemeQuoteColor) 15%, transparent);
    font-size: 0.72em;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    vertical-align: middle;
}
.luker-stm-entries .luker-stm-caution {
    color: var(--fullred);
}
.luker-stm-entries .luker-stm-empty {
    padding: 24px 0;
    text-align: center;
    opacity: 0.6;
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

    function buildPreviewText(content, limit = 320) {
        const text = String(content || '').replace(/\r\n?/g, '\n').trim();
        if (!text) return '';
        if (text.length <= limit) return text;
        return `${text.slice(0, limit - 1).trimEnd()}…`;
    }

    function renderEntriesList($container, entries) {
        const list = Array.isArray(entries) ? entries : [];
        const $list = $container.find('.luker-stm-list');
        const $empty = $container.find('.luker-stm-empty');
        const $count = $container.find('.luker-stm-count');
        const $selectAll = $container.find('.luker-stm-select-all');
        const $deleteSelected = $container.find('.luker-stm-delete-selected');
        const $resetAll = $container.find('.luker-stm-reset-all');

        $count.text(`${i18n('Total')}: ${list.length}`);
        $selectAll.prop('checked', false);
        $selectAll.prop('disabled', list.length === 0);
        $deleteSelected.toggleClass('disabled', true);
        $resetAll.toggleClass('disabled', list.length === 0);

        if (list.length === 0) {
            $list.empty();
            $empty.show();
            return;
        }
        $empty.hide();

        const fragments = list.map((entry) => {
            const keywords = Array.isArray(entry.keywords)
                ? entry.keywords.filter((k) => String(k || '').trim() !== '')
                : [];
            const keywordsHtml = keywords.length
                ? `<div class="luker-stm-keys">${keywords.map((k) => `<span class="luker-stm-tag">${escapeHtml(k)}</span>`).join('')}</div>`
                : '';
            const previewHtml = entry.content
                ? `<div class="luker-stm-content">${escapeHtml(buildPreviewText(entry.content))}</div>`
                : '';
            const alwaysFlag = entry.alwaysInject
                ? `<span class="luker-stm-flag" title="${escapeHtml(i18n('Always inject'))}">${escapeHtml(i18n('Always'))}</span>`
                : '';
            return `
<div class="luker-stm-card" data-entry-id="${escapeHtml(entry.entryId)}">
    <div class="luker-stm-card-head">
        <label class="checkbox_label" style="margin: 0;">
            <input type="checkbox" class="luker-stm-row-check" />
        </label>
        <div class="luker-stm-title">${escapeHtml(entry.title || entry.entryId)}${alwaysFlag}</div>
        <div class="luker-stm-actions">
            <div class="menu_button menu_button_small caution luker-stm-row-delete">${escapeHtml(i18n('Delete'))}</div>
        </div>
    </div>
    ${keywordsHtml}
    ${previewHtml}
</div>`;
        });
        $list.html(fragments.join(''));
    }

    function updateBulkButtonsEnabled($container) {
        const checkedCount = $container.find('.luker-stm-row-check:checked').length;
        $container.find('.luker-stm-delete-selected').toggleClass('disabled', checkedCount === 0);
        const totalCount = $container.find('.luker-stm-row-check').length;
        const allChecked = totalCount > 0 && checkedCount === totalCount;
        $container.find('.luker-stm-select-all').prop('checked', allChecked);
    }

    async function openManageEntriesDialog() {
        const context = getContext();
        if (!context?.chatId && !context?.getCurrentChatId?.()) {
            if (typeof toastr !== 'undefined') {
                toastr.info(i18n('No active chat.'));
            }
            return;
        }

        const initialHtml = `
<div class="luker-stm-entries">
    <h3 style="margin-top: 0;">${escapeHtml(i18n('Manage stored search entries'))}</h3>
    <div class="luker-stm-intro">${escapeHtml(i18n('Remove entries that are no longer relevant. Changes apply to the current chat.'))}</div>
    <div class="luker-stm-toolbar">
        <label class="checkbox_label" style="margin: 0;">
            <input type="checkbox" class="luker-stm-select-all" />
            <span>${escapeHtml(i18n('Select all'))}</span>
        </label>
        <span class="luker-stm-count"></span>
        <span class="luker-stm-toolbar-spacer"></span>
        <div class="menu_button menu_button_small luker-stm-caution luker-stm-delete-selected disabled">${escapeHtml(i18n('Delete selected'))}</div>
        <div class="menu_button menu_button_small luker-stm-caution luker-stm-reset-all">${escapeHtml(i18n('Reset all'))}</div>
    </div>
    <div class="luker-stm-list"></div>
    <div class="luker-stm-empty" style="display: none;">${escapeHtml(i18n('No managed search entries in this chat.'))}</div>
</div>`;

        const popup = new Popup(initialHtml, POPUP_TYPE.DISPLAY, '', {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: i18n('Close'),
            cancelButton: false,
        });

        let busy = false;

        function getRoot() {
            return jQuery(popup.content).find('.luker-stm-entries');
        }

        function refresh() {
            renderEntriesList(getRoot(), getManagedEntriesSnapshot());
        }

        async function runMutation(mutationFn, confirmMessage) {
            if (busy) return;
            if (confirmMessage && !window.confirm(confirmMessage)) return;
            busy = true;
            try {
                await mutationFn();
                refresh();
                void refreshUiStatusForCurrentChat();
            } catch (error) {
                console.warn(`[${MODULE_NAME}] Manage entries mutation failed`, error);
                if (typeof toastr !== 'undefined') {
                    toastr.error(i18n('Failed to update managed entries. See console for details.'));
                }
            } finally {
                busy = false;
            }
        }

        const $root = getRoot();

        $root.on('change', '.luker-stm-select-all', function () {
            const checked = jQuery(this).prop('checked');
            $root.find('.luker-stm-row-check').prop('checked', checked);
            updateBulkButtonsEnabled($root);
        });

        $root.on('change', '.luker-stm-row-check', function () {
            updateBulkButtonsEnabled($root);
        });

        $root.on('click', '.luker-stm-row-delete', function () {
            const entryId = jQuery(this).closest('.luker-stm-card').data('entry-id');
            if (!entryId) return;
            void runMutation(async () => {
                await manuallyDeleteManagedEntries(getContext(), [String(entryId)]);
            });
        });

        $root.on('click', '.luker-stm-delete-selected', function () {
            if (jQuery(this).hasClass('disabled')) return;
            const ids = $root.find('.luker-stm-row-check:checked')
                .map((_, el) => jQuery(el).closest('.luker-stm-card').data('entry-id'))
                .get()
                .map((value) => String(value || ''))
                .filter(Boolean);
            if (ids.length === 0) return;
            void runMutation(
                async () => { await manuallyDeleteManagedEntries(getContext(), ids); },
                ids.length === 1
                    ? i18n('Delete 1 selected search entry? This cannot be undone for the current chat.')
                    : i18n('Delete {count} selected search entries? This cannot be undone for the current chat.').replace('{count}', String(ids.length)),
            );
        });

        $root.on('click', '.luker-stm-reset-all', function () {
            if (jQuery(this).hasClass('disabled')) return;
            void runMutation(
                async () => { await manuallyResetManagedEntries(getContext()); },
                i18n('Remove ALL managed search entries from this chat? This cannot be undone.'),
            );
        });

        refresh();
        await popup.show();
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
        updateLorebookPositionVisibility(root);
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
            updateLorebookPositionVisibility(root);
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
        root.on('click.searchTools', '#search_tools_manage_entries', function () {
            void openManageEntriesDialog();
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
