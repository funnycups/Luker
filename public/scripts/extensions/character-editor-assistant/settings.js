// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { getChatCompletionConnectionProfiles } from '../connection-manager/profile-resolver.js';
import {
    renderConnectionProfileOptions as renderSharedConnectionProfileOptions,
    renderOpenAIPresetOptions as renderSharedOpenAIPresetOptions,
} from '../../lens-shared/preset-selectors.js';
import { normalizeToolCallRetryMax } from '../../lib/iter-tool-calling.js';
import { initializePromptDefaults } from '../../lib/prompt-values.js';
import {
    MODULE_NAME,
    PROMPT_DEFAULTS,
    defaultSettings,
} from './defaults.js';
import { i18n } from './i18n.js';

const __ctx = Luker.getContext();
const extension_settings = __ctx.extensionSettings;
const saveSettingsDebounced = __ctx.saveSettingsDebounced;

export { defaultSettings };

export function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const settings = extension_settings[MODULE_NAME];
    if (settings.lorebookSyncLlmPresetName !== undefined) {
        settings.requestLlmPresetName ||= String(settings.lorebookSyncLlmPresetName || '');
        delete settings.lorebookSyncLlmPresetName;
    }
    if (settings.lorebookSyncApiPresetName !== undefined) {
        settings.requestApiPresetName ||= String(settings.lorebookSyncApiPresetName || '');
        delete settings.lorebookSyncApiPresetName;
    }
    settings.requestLlmPresetName = String(settings.requestLlmPresetName || '').trim();
    settings.requestApiPresetName = String(settings.requestApiPresetName || '').trim();
    delete settings.plainTextFunctionCallMode;
    settings.toolCallRetryMax = normalizeToolCallRetryMax(settings.toolCallRetryMax, defaultSettings.toolCallRetryMax);
    delete settings.maxJournalEntries;
    if (initializePromptDefaults(settings, PROMPT_DEFAULTS)) {
        saveSettingsDebounced();
    }
}

export function getSettings() {
    ensureSettings();
    return extension_settings[MODULE_NAME];
}

function renderOpenAIPresetOptions(context, selectedName = '') {
    return renderSharedOpenAIPresetOptions(context, selectedName, {
        emptyLabel: i18n('(Current preset)'),
        missingLabel: i18n('(missing)'),
    });
}

function renderConnectionProfileOptions(selectedName = '') {
    return renderSharedConnectionProfileOptions(getChatCompletionConnectionProfiles(), selectedName, {
        emptyLabel: i18n('(Current API config)'),
        missingLabel: i18n('(missing)'),
        sort: true,
    });
}

export function refreshPresetSelectors(root, context, settings) {
    // A focused select is being operated by the user; rebuilding its options
    // would reset the choice in progress.
    const llmSelect = root.find('#cea_sync_llm_preset');
    if (llmSelect.length && llmSelect[0] !== document.activeElement) {
        llmSelect.html(renderOpenAIPresetOptions(context, settings.requestLlmPresetName));
        llmSelect.val(String(settings.requestLlmPresetName || '').trim());
        const installed = [...llmSelect[0].options].some(option => option.value === 'plugin-only');
        root.find('#cea_import_preset_example').text(installed ? i18n('Re-import example') : i18n('Import example'));
    }
    const apiSelect = root.find('#cea_sync_api_preset');
    if (apiSelect.length && apiSelect[0] !== document.activeElement) {
        apiSelect.html(renderConnectionProfileOptions(settings.requestApiPresetName));
        apiSelect.val(String(settings.requestApiPresetName || '').trim());
    }
}
