import { characters, chatElement, eventSource, event_types, getCurrentChatId, messageFormatting, redisplayChat, reloadCurrentChat, saveSettings as saveSettingsNow, saveSettingsDebounced, this_chid, unshallowCharacter } from '../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { selected_group } from '../../group-chats.js';
import { callGenericPopup, POPUP_RESULT, Popup, POPUP_TYPE } from '../../popup.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders, enumIcons } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandEnumValue, enumTypes } from '../../slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { download, equalsIgnoreCaseAndAccents, escapeHtml, getFileText, getSortableDelay, isFalseBoolean, isTrueBoolean, regexFromString, setInfoBlock, uuidv4 } from '../../utils.js';
import { allowPresetScripts, allowScopedScripts, captureRegexTarget, disallowPresetScripts, disallowScopedScripts, getCurrentPresetAPI, getCurrentPresetName, getPluginLanes, getRegexScripts, getRuntimeRegexScripts, getScriptsByType, isPresetScriptsAllowed, isScopedScriptsAllowed, regex_placement, RegexProvider, REGEX_RUNTIME_SCRIPTS_CHANGED_EVENT, runRegexScript, saveScriptsByType, SCRIPT_TYPE_UNKNOWN, SCRIPT_TYPES, substitute_find_regex, updateScopedRegexScripts } from './engine.js';
import { REGEX_ALLOW_SLOW_SCRIPT_EVENT, REGEX_HARD_THRESHOLD_MS, REGEX_OPEN_SCRIPT_EVENT, resetAllRegexScriptState, resetRegexScriptState } from './redos-reporter.js';
import { getCurrentLocale, t, translate } from '../../i18n.js';
import { accountStorage } from '../../util/AccountStorage.js';
import { getPresetManager } from '../../preset-manager.js';
import { mountBehaviorSummary } from '../../lens-shared/behavior-summary.js';
import { buildRegexBehaviorSummary } from './behavior-summary-model.js';

// Re-exports for legacy extensions
export { getRegexScripts };

const sanitizeFileName = name => name.replace(/[\s.<>:"/\\|?*\x00-\x1F\x7F]/g, '_').toLowerCase();
const REGEX_SCRIPT_TYPE_LABELS = Object.freeze({
    [SCRIPT_TYPES.GLOBAL]: 'global',
    [SCRIPT_TYPES.SCOPED]: 'scoped',
    [SCRIPT_TYPES.PRESET]: 'preset',
    [SCRIPT_TYPE_UNKNOWN]: 'runtime',
});
const PRESET_EMBEDDED_REGEX_SOURCE_PATH = 'luker.embedded_regex_scripts_source';

const REGEX_SCOPE_DOC_BASE = 'https://luker.cups.moe';

/**
 * Doc URL for the "Affects" scope explainer, locale-aware. Chinese docs
 * live under a locale prefix; the English site is served path-less.
 */
function getRegexScopeDocUrl() {
    const locale = String(typeof getCurrentLocale === 'function' ? getCurrentLocale() : '').toLowerCase();
    if (locale.startsWith('zh-cn')) {
        return `${REGEX_SCOPE_DOC_BASE}/zh-CN/features/regex-scope.html`;
    }
    if (locale.startsWith('zh-tw') || locale.startsWith('zh-hk') || locale.startsWith('zh-mo')) {
        return `${REGEX_SCOPE_DOC_BASE}/zh-TW/features/regex-scope.html`;
    }
    return `${REGEX_SCOPE_DOC_BASE}/features/regex-scope.html`;
}

$(document).on('click', '.regex-scope-help-link', function (event) {
    event.preventDefault();
    window.open(getRegexScopeDocUrl(), '_blank', 'noopener,noreferrer');
});

function buildRegexDragHelper(item) {
    const itemEl = item?.get?.(0) || item?.[0] || item;
    const helper = item?.clone?.() || $(itemEl).clone();
    const width = Math.round(item?.outerWidth?.() || itemEl?.getBoundingClientRect?.().width || 0);
    helper.addClass('regex-drag-helper');
    helper.css({
        width: width > 0 ? `${width}px` : '',
        'pointer-events': 'none',
        'box-shadow': '0 12px 28px rgba(0, 0, 0, 0.18)',
        opacity: '0.96',
        transform: 'rotate(1deg)',
    });
    return helper;
}

function styleRegexDragPlaceholder(ui) {
    const placeholder = ui?.placeholder;
    if (!placeholder?.length) {
        return;
    }

    placeholder.css({
        height: '4px',
        'min-height': '4px',
        visibility: 'visible',
        border: '0',
        'border-radius': '999px',
        background: 'var(--SmartThemeQuoteColor)',
        opacity: '0.7',
        margin: '8px 0',
    });
}

function getRegexSortableDelay() {
    // Keep desktop behavior from utils, but avoid very long touch hold on mobile.
    return Math.min(getSortableDelay(), 180);
}

function summarizeRegexScriptForLog(script) {
    if (!script || typeof script !== 'object') {
        return null;
    }

    return {
        id: String(script.id || ''),
        name: String(script.scriptName || ''),
        disabled: Boolean(script.disabled),
        placementCount: Array.isArray(script.placement) ? script.placement.length : 0,
        findRegexLength: String(script.findRegex || '').length,
        replaceLength: String(script.replaceString || '').length,
        runOnEdit: Boolean(script.runOnEdit),
        promptOnly: Boolean(script.promptOnly),
        markdownOnly: Boolean(script.markdownOnly),
        pluginLanes: getPluginLanes(script),
    };
}

/**
 * @param {JQuery<HTMLElement>} editorHtml
 * @returns {object | null}
 */
function summarizeRegexEditorDomStateForLog(editorHtml) {
    if (!editorHtml?.length) {
        return null;
    }

    return {
        scriptNameLength: String(editorHtml.find('.regex_script_name').val() || '').length,
        findRegexLength: String(editorHtml.find('.find_regex').val() || '').length,
        replaceLength: String(editorHtml.find('.regex_replace_string').val() || '').length,
        disabled: Boolean(editorHtml.find('input[name="disabled"]').prop('checked')),
        markdownOnly: Boolean(editorHtml.find('input[name="only_format_display"]').prop('checked')),
        promptOnly: Boolean(editorHtml.find('input[name="only_format_prompt"]').prop('checked')),
        pluginLanes: [
            editorHtml.find('input[name="plugin_request"]').prop('checked') ? 'request' : null,
            editorHtml.find('input[name="plugin_reply"]').prop('checked') ? 'reply' : null,
        ].filter(Boolean),
        runOnEdit: Boolean(editorHtml.find('input[name="run_on_edit"]').prop('checked')),
        minDepthRaw: String(editorHtml.find('input[name="min_depth"]').val() || ''),
        maxDepthRaw: String(editorHtml.find('input[name="max_depth"]').val() || ''),
        placement: editorHtml
            .find('input[name="replace_position"]')
            .filter(':checked')
            .map(function () { return String($(this).val()); })
            .get(),
    };
}

/**
 * @param {unknown} script
 * @returns {script is RegexScript}
 */
function isRegexScriptRecord(script) {
    return Boolean(script) && typeof script === 'object' && !Array.isArray(script);
}

/**
 * @param {SCRIPT_TYPES} scriptType
 * @param {{ readOnly?: boolean }} [options]
 * @returns {string}
 */
function getRegexScriptSourceLabel(scriptType, { readOnly = false } = {}) {
    if (readOnly) {
        return 'runtime';
    }

    switch (scriptType) {
        case SCRIPT_TYPES.GLOBAL:
            return 'global';
        case SCRIPT_TYPES.SCOPED:
            return 'scoped';
        case SCRIPT_TYPES.PRESET:
            return 'preset';
        default:
            return String(scriptType);
    }
}

/**
 * @param {SCRIPT_TYPES} scriptType
 * @param {{ readOnly?: boolean }} [options]
 * @returns {string}
 */
function getInvalidRegexScriptsToastMessage(scriptType, { readOnly = false } = {}) {
    if (readOnly) {
        return t`A plugin provided invalid regex entries. They were skipped in Regex Editor. Check the browser console for details.`;
    }

    switch (scriptType) {
        case SCRIPT_TYPES.GLOBAL:
            return t`Global regex entries contained invalid data. Invalid entries were removed before opening Regex Editor. Check the browser console for details.`;
        case SCRIPT_TYPES.SCOPED:
            return t`Character-scoped regex entries contained invalid data. Invalid entries were removed before opening Regex Editor. Check the browser console for details.`;
        case SCRIPT_TYPES.PRESET:
            return t`Preset regex entries contained invalid data. Invalid entries were removed before opening Regex Editor. Check the browser console for details.`;
        default:
            return t`Some regex scripts were invalid and could not be shown in Regex Editor. Check the browser console for details.`;
    }
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {object}
 */
function summarizeInvalidRegexEntry(value, index) {
    if (value === null) {
        return { index, type: 'null' };
    }

    if (Array.isArray(value)) {
        return { index, type: 'array', length: value.length };
    }

    return {
        index,
        type: typeof value,
        value: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? value
            : null,
    };
}

/**
 * Removes invalid entries from a script list before Regex Editor touches them.
 * @param {RegexScript[] | unknown} scripts
 * @param {SCRIPT_TYPES} scriptType
 * @param {{ readOnly?: boolean, issues?: Set<string> }} [options]
 * @returns {Promise<RegexScript[]>}
 */
async function sanitizeRegexScriptsForEditor(scripts, scriptType, { readOnly = false, issues = new Set() } = {}) {
    if (!Array.isArray(scripts)) {
        return [];
    }

    const validScripts = [];
    const invalidEntries = [];

    scripts.forEach((script, index) => {
        if (isRegexScriptRecord(script)) {
            validScripts.push(script);
            return;
        }

        invalidEntries.push(summarizeInvalidRegexEntry(script, index));
    });

    if (!invalidEntries.length) {
        return scripts;
    }

    const source = getRegexScriptSourceLabel(scriptType, { readOnly });
    console.error('[Regex] Invalid scripts were skipped while rendering Regex Editor', {
        source,
        invalidCount: invalidEntries.length,
        invalidEntries,
    });

    if (!readOnly) {
        try {
            await saveScriptsByType(validScripts, scriptType);
            issues.add(getInvalidRegexScriptsToastMessage(scriptType, { readOnly }));
        } catch (error) {
            console.error('[Regex] Failed to save sanitized regex scripts while rendering Regex Editor', {
                source,
                invalidCount: invalidEntries.length,
                error,
            });
            issues.add(t`Some regex scripts contained invalid data, but automatic cleanup could not be saved. Invalid entries were skipped. Check the browser console for details.`);
        }
        return validScripts;
    }

    issues.add(getInvalidRegexScriptsToastMessage(scriptType, { readOnly }));
    return validScripts;
}

/**
 * @typedef {import('../../char-data.js').RegexScriptData} RegexScript
 */

/**
 * @typedef {object} RegexPresetItem
 * @property {string} id - UUID of the regex script
 */

/**
 * @typedef {object} RegexPreset
 * @property {string} id - UUID of the preset
 * @property {string} name - Name of the preset
 * @property {boolean} isSelected - Whether the preset is currently selected
 * @property {RegexPresetItem[]} global - The list of global preset items
 * @property {RegexPresetItem[]} scoped - The list of scoped preset items
 * @property {RegexPresetItem[]} preset - The list of preset preset items
 */

/**
 * @typedef {object} RegexPresetState
 * @property {string[]} global - List of enabled global regex script IDs
 * @property {string[]} scoped - List of enabled scoped regex script IDs
 * @property {string[]} preset - List of enabled preset regex script IDs
 */

class RegexPresetManager {
    /** @type {HTMLSelectElement} */
    presetSelect = null;

    /** @type {HTMLElement} */
    presetCreateButton = null;

    /** @type {HTMLElement} */
    presetUpdateButton = null;

    /** @type {HTMLElement} */
    presetApplyButton = null;

    /** @type {HTMLElement} */
    presetDeleteButton = null;

    /** @type {string|null} */
    currentPresetId = null;

    /** @type {RegexPresetState|null} */
    lastKnownState = null;

    /**
     * Captures the current state of enabled regex scripts for change detection.
     * @returns {RegexPresetState} The current state object
     */
    captureCurrentState() {
        const globalScripts = this.regexListToPresetItems(getScriptsByType(SCRIPT_TYPES.GLOBAL));
        const scopedScripts = this.regexListToPresetItems(getScriptsByType(SCRIPT_TYPES.SCOPED));
        const presetScripts = this.regexListToPresetItems(getScriptsByType(SCRIPT_TYPES.PRESET));

        return {
            global: globalScripts.map(item => item.id).sort(),
            scoped: scopedScripts.map(item => item.id).sort(),
            preset: presetScripts.map(item => item.id).sort(),
        };
    }

    /**
     * Compares two state objects to detect changes.
     * @param {RegexPresetState} state1 First state object
     * @param {RegexPresetState} state2 Second state object
     * @returns {boolean} True if states are different
     */
    hasStateChanged(state1, state2) {
        if (!state1 || !state2) return false;

        const global1 = state1.global || [];
        const global2 = state2.global || [];
        const scoped1 = state1.scoped || [];
        const scoped2 = state2.scoped || [];
        const preset1 = state1.preset || [];
        const preset2 = state2.preset || [];

        if (global1.length !== global2.length || scoped1.length !== scoped2.length) {
            return true;
        }

        return !global1.every(id => global2.includes(id)) ||
            !scoped1.every(id => scoped2.includes(id)) ||
            !preset1.every(id => preset2.includes(id));
    }

    /**
     * Updates the stored state after a preset is applied or saved.
     * @param {string} presetId - The current preset ID
     */
    updateStoredState(presetId) {
        this.currentPresetId = presetId;
        this.lastKnownState = this.captureCurrentState();
    }

    /**
     * Checks if there are unsaved changes and shows a confirmation dialog.
     * @returns {Promise<boolean>} True if user wants to proceed without saving
     */
    async checkUnsavedChanges() {
        if (!this.currentPresetId || !this.lastKnownState) {
            return true; // No current preset or state to compare
        }

        const currentState = this.captureCurrentState();
        if (!this.hasStateChanged(this.lastKnownState, currentState)) {
            return true; // No changes detected
        }

        const currentPreset = extension_settings.regex_presets.find(p => p.id === this.currentPresetId);
        const presetName = currentPreset ? currentPreset.name : t`Unknown Preset`;

        const choice = await Popup.show.confirm(
            t`You have unsaved changes to the "${presetName}" preset.`,
            t`Do you want to save them before switching?`,
            {
                okButton: t`Save Changes`,
                cancelButton: t`Discard Changes`,
            },
        );

        if (choice) {
            // User chose to save changes
            await this.savePreset(this.currentPresetId, true);
            this.renderPresetList();
            return true;
        }

        // User chose to discard changes
        return true;
    }

    /**
     * Sets up event listeners for the preset management UI.
     * @returns {void}
     */
    setupEventListeners() {
        this.presetSelect = /** @type {HTMLSelectElement} */ (document.getElementById('regex_presets'));
        if (!this.presetSelect) {
            console.error('RegexPresetManager: Could not find preset select element in the DOM.');
            return;
        }

        this.presetSelect.addEventListener('change', async (event) => {
            const selectedPresetId = this.presetSelect.value;
            const fromSlashCommand = event instanceof CustomEvent && event?.detail?.fromSlashCommand === true;

            // Check for unsaved changes before switching
            if (!fromSlashCommand) {
                const canProceed = await this.checkUnsavedChanges();
                if (!canProceed) {
                    // Revert the selection
                    event.preventDefault();
                    const currentPreset = extension_settings.regex_presets.find(p => p.id === this.currentPresetId);
                    if (currentPreset) {
                        this.presetSelect.value = currentPreset.id;
                    }
                    return;
                }
            }

            await this.applyPreset(selectedPresetId);
            extension_settings.regex_presets.forEach(p => { p.isSelected = p.id === selectedPresetId; });
            saveSettingsDebounced();
            this.updateStoredState(selectedPresetId);
        });

        this.presetCreateButton = document.getElementById('regex_preset_create');
        if (!this.presetCreateButton) {
            console.error('RegexPresetManager: Could not find preset create button in the DOM.');
            return;
        }

        this.presetCreateButton.addEventListener('click', async () => {
            const newId = uuidv4();
            await this.savePreset(newId, false);
            this.renderPresetList();
            this.updateStoredState(newId);
        });

        this.presetUpdateButton = document.getElementById('regex_preset_update');
        if (!this.presetUpdateButton) {
            console.error('RegexPresetManager: Could not find preset update button in the DOM.');
            return;
        }

        this.presetUpdateButton.addEventListener('click', async () => {
            const selectedPresetId = this.presetSelect.value;
            await this.savePreset(selectedPresetId, true);
            this.renderPresetList();
            this.updateStoredState(selectedPresetId);
        });

        this.presetApplyButton = document.getElementById('regex_preset_apply');
        if (!this.presetApplyButton) {
            console.error('RegexPresetManager: Could not find preset apply button in the DOM.');
            return;
        }

        this.presetApplyButton.addEventListener('click', async () => {
            const selectedPresetId = this.presetSelect.value;
            await this.applyPreset(selectedPresetId);
            this.updateStoredState(selectedPresetId);
        });

        this.presetDeleteButton = document.getElementById('regex_preset_delete');
        if (!this.presetDeleteButton) {
            console.error('RegexPresetManager: Could not find preset delete button in the DOM.');
            return;
        }

        this.presetDeleteButton.addEventListener('click', async () => {
            const selectedPresetId = this.presetSelect.value;
            await this.deletePreset(selectedPresetId);
            this.renderPresetList();

            const newSelectedPresetId = extension_settings.regex_presets.find(p => p.isSelected)?.id;
            if (newSelectedPresetId) {
                await this.applyPreset(newSelectedPresetId);
                this.presetSelect.value = newSelectedPresetId;
                this.updateStoredState(newSelectedPresetId);
            } else {
                this.currentPresetId = null;
                this.lastKnownState = null;
            }
        });

        this.renderPresetList();

        // Initialize the stored state with the currently selected preset
        const selectedPreset = extension_settings.regex_presets?.find(p => p.isSelected);
        if (selectedPreset) {
            this.updateStoredState(selectedPreset.id);
        }
    }

    /**
     * Registers slash commands related to regex presets.
     * @returns {void}
     */
    registerSlashCommands() {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'regex-preset',
            helpString: t`Selects a regex preset by name or ID. Gets the current regex preset ID if no argument is provided.`,
            callback: (args, name) => {
                if (!this.presetSelect) {
                    return '';
                }

                name = String(name ?? '').trim();

                if (name) {
                    const quiet = isTrueBoolean(args?.quiet?.toString());
                    const foundId = extension_settings.regex_presets.find(p => equalsIgnoreCaseAndAccents(p.id, name) || equalsIgnoreCaseAndAccents(p.name, name))?.id;

                    if (foundId) {
                        this.presetSelect.value = foundId;
                        this.presetSelect.dispatchEvent(new CustomEvent('change', { detail: { fromSlashCommand: true } }));
                        return foundId;
                    }

                    !quiet && toastr.warning(`Regex preset "${name}" not found`);
                    return '';
                }

                return this.presetSelect.value;
            },
            returns: 'current preset ID',
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'quiet',
                    description: 'Suppress the toast message on preset change',
                    typeList: [ARGUMENT_TYPE.BOOLEAN],
                    defaultValue: 'false',
                    enumList: commonEnumProviders.boolean('trueFalse')(),
                }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'regex preset name or ID',
                    typeList: [ARGUMENT_TYPE.STRING],
                    enumProvider: () => extension_settings.regex_presets.map(x => new SlashCommandEnumValue(x.id, x.name, enumTypes.enum, enumIcons.preset)),
                }),
            ],
        }));
    }

    /**
     * Renders the list of regex presets in the UI.
     * @returns {void}
     */
    renderPresetList() {
        if (!this.presetSelect) {
            return;
        }

        this.presetSelect.innerHTML = '';

        if (!Array.isArray(extension_settings.regex_presets) || extension_settings.regex_presets.length === 0) {
            const fallbackOption = new Option(t`[No presets saved]`, '', true, true);
            this.presetSelect.appendChild(fallbackOption);
            this.presetSelect.disabled = true;
            return;
        }

        extension_settings.regex_presets.forEach(preset => {
            const option = new Option(preset.name, preset.id, preset.isSelected, preset.isSelected);
            this.presetSelect.appendChild(option);
        });

        this.presetSelect.disabled = false;
    }

    /**
     * Applies a preset list to a target list of scripts.
     * @param {Object} params The parameters object
     * @param {RegexPresetItem[]} params.presetList The list of preset items
     * @param {RegexScript[]} params.targetList The list of target scripts to modify
     * @param {(targetList: RegexScript[]) => Promise<any>} params.saveFunction Function to save the modified list
     */
    async applyPresetList({ presetList, targetList, saveFunction }) {
        if (!Array.isArray(targetList) || !Array.isArray(presetList)) {
            return;
        }

        // Build an isolated copy so failed persistence never mutates live records
        const nextList = targetList.map(script => ({
            ...structuredClone(script),
            disabled: !presetList.some(p => p.id === script.id),
        }));
        const originalOrder = new Map(nextList.map((script, idx) => [script.id, idx]));

        // First sort by the order in the preset, then the original order
        nextList.sort((a, b) => {
            const aIndex = presetList.findIndex(p => p.id === a.id);
            const bIndex = presetList.findIndex(p => p.id === b.id);
            return aIndex - bIndex || (originalOrder.get(a.id) ?? 0) - (originalOrder.get(b.id) ?? 0);
        });

        await saveFunction(nextList);
    }

    /**
     * Applies a regex preset to the current context.
     * @param {string} presetId - The ID of the preset to apply
     * @returns {Promise<void>}
     */
    async applyPreset(presetId) {
        const preset = extension_settings.regex_presets.find(p => p.id === presetId);
        if (!preset) {
            toastr.error(t`Could not find the selected preset.`);
            return;
        }

        // Apply preset to all lists
        const failedTypes = [];
        let anySucceeded = false;
        for (const scriptType of Object.values(SCRIPT_TYPES)) {
            const presetList = {
                [SCRIPT_TYPES.GLOBAL]: preset.global,
                [SCRIPT_TYPES.SCOPED]: preset.scoped,
                [SCRIPT_TYPES.PRESET]: preset.preset,
            }[scriptType];
            const targetList = getScriptsByType(scriptType);
            if (!Array.isArray(targetList) || targetList.length === 0) {
                continue;
            }
            const target = captureRegexTarget(scriptType);
            try {
                await this.applyPresetList({
                    presetList,
                    targetList,
                    saveFunction: scripts => saveScriptsByType(scripts, scriptType, { target }),
                });
                anySucceeded = true;
            } catch (error) {
                failedTypes.push(scriptType);
                console.error('[Regex] Failed to apply regex preset to scope', {
                    presetId,
                    scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
                    error,
                });
            }
        }

        if (failedTypes.length > 0) {
            toastr.error(anySucceeded
                ? t`Some regex script changes could not be saved.`
                : t`Could not save regex script changes.`);
        }

        // Render the actual acknowledged state to the UI
        await loadRegexScripts();
        if (anySucceeded) {
            await requestRegexChatReload();
        }
    }

    /**
     * Converts a list of regex scripts to preset items.
     * @param {RegexScript[]} list The list of regex scripts
     * @returns {RegexPresetItem[] | null} The list of preset items, or null if the input is invalid
     */
    regexListToPresetItems(list) {
        if (!Array.isArray(list)) {
            return null;
        }

        return list.filter(isRegexScriptRecord).filter(x => !x.disabled).map(s => ({ id: s.id }));
    }

    /**
     * Saves a regex preset.
     * @param {string} presetId - The ID of the preset
     * @param {boolean} isUpdate - Whether this is an update operation
     * @returns {Promise<void>}
     */
    async savePreset(presetId, isUpdate) {
        const existingPreset = isUpdate ? extension_settings.regex_presets.find(p => p.id === presetId) : null;

        if (isUpdate && !existingPreset) {
            toastr.error(t`Could not find the preset to update.`);
            return;
        }

        const name = isUpdate ? existingPreset.name : await Popup.show.input(t`Enter a name for the new regex preset:`, '');
        const id = isUpdate ? existingPreset.id : presetId;

        if (!name || !name.trim().length) {
            return;
        }

        const preset = {
            id: id,
            name: name,
            isSelected: false,
            global: this.regexListToPresetItems(getScriptsByType(SCRIPT_TYPES.GLOBAL)),
            scoped: this.regexListToPresetItems(getScriptsByType(SCRIPT_TYPES.SCOPED)),
            preset: this.regexListToPresetItems(getScriptsByType(SCRIPT_TYPES.PRESET)),
        };

        if (isUpdate) {
            Object.assign(existingPreset, preset);
        } else {
            extension_settings.regex_presets.push(preset);
        }

        extension_settings.regex_presets.forEach(p => { p.isSelected = p.id === id; });
        saveSettingsDebounced();

        toastr.success(isUpdate ? t`Regex preset updated` : t`Regex preset saved`);
    }

    /**
     * Deletes a regex preset.
     * @param {string} presetId - The ID of the preset to delete
     * @returns {Promise<void>}
     */
    async deletePreset(presetId) {
        const presetIndex = extension_settings.regex_presets.findIndex(p => p.id === presetId);
        if (presetIndex === -1) {
            toastr.error(t`Could not find the preset to delete.`);
            return;
        }

        const presetName = extension_settings.regex_presets[presetIndex].name;
        const confirm = await Popup.show.confirm(t`Are you sure you want to delete this regex preset?`, presetName);
        if (!confirm) {
            return;
        }

        extension_settings.regex_presets.splice(presetIndex, 1);

        // Select the first preset if any exist
        extension_settings.regex_presets.forEach((p, i) => { p.isSelected = i === 0; });
        saveSettingsDebounced();

        toastr.success(t`Regex preset deleted`);
    }
}

const presetManager = new RegexPresetManager();
let pendingRegexChatReload = false;
let regexReloadOnSettingsCloseBound = false;
let regexScriptsRenderRequestId = 0;

function isRegexSettingsPanelOpen() {
    return jQuery('#rm_extensions_block').hasClass('openDrawer');
}

async function rerenderVisibleRegexChatMessages() {
    const firstVisibleMessage = chatElement.children('.mes').first();
    if (!firstVisibleMessage.length) {
        return true;
    }

    const startIndex = Number(firstVisibleMessage.attr('mesid'));
    if (!Number.isInteger(startIndex) || startIndex < 0) {
        return false;
    }

    const previousTop = firstVisibleMessage.get(0)?.getBoundingClientRect?.().top;
    await redisplayChat({ startIndex, fade: false });

    // redisplayChat is silent; mirror reloadCurrentChat's CHAT_LOADED emission so
    // extensions that re-process rendered HTML get a chance to rebuild after a
    // regex change. Solo-chat path only — group
    // chats don't receive CHAT_LOADED from getGroupChat either.
    if (typeof this_chid !== 'undefined' && characters[this_chid]) {
        eventSource.emit(event_types.CHAT_LOADED, { detail: { id: this_chid, character: characters[this_chid] } });
    }

    if (!Number.isFinite(previousTop)) {
        return true;
    }

    const anchorAfterRerender = chatElement.children(`.mes[mesid="${startIndex}"]`).first();
    if (!anchorAfterRerender.length) {
        return true;
    }

    const nextTop = anchorAfterRerender.get(0)?.getBoundingClientRect?.().top;
    if (!Number.isFinite(nextTop)) {
        return true;
    }

    const offsetDelta = nextTop - previousTop;
    if (Math.abs(offsetDelta) > 0.5) {
        chatElement.scrollTop((chatElement.scrollTop() || 0) + offsetDelta);
    }

    return true;
}

async function requestRegexChatReload({ force = false } = {}) {
    if (!getCurrentChatId()) {
        pendingRegexChatReload = false;
        return;
    }

    if (!force && isRegexSettingsPanelOpen()) {
        pendingRegexChatReload = true;
        return;
    }

    pendingRegexChatReload = false;
    try {
        const rerendered = await rerenderVisibleRegexChatMessages();
        if (rerendered) {
            return;
        }
    } catch (error) {
        console.warn('[Regex] Visible chat rerender failed, falling back to full reload', error);
    }

    await reloadCurrentChat();
}

async function flushPendingRegexChatReload() {
    if (!pendingRegexChatReload) {
        return;
    }
    await requestRegexChatReload({ force: true });
}

function bindRegexReloadOnSettingsClose() {
    if (regexReloadOnSettingsCloseBound) {
        return;
    }
    regexReloadOnSettingsCloseBound = true;

    const panel = document.getElementById('rm_extensions_block');
    if (!panel) {
        return;
    }

    let wasOpen = panel.classList.contains('openDrawer');
    const observer = new MutationObserver(() => {
        const isOpen = panel.classList.contains('openDrawer');
        if (wasOpen && !isOpen) {
            void flushPendingRegexChatReload();
        }
        wasOpen = isOpen;
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
}

const REGEX_SECTION_IDS = ['regex_presets_block', 'global_scripts_block', 'preset_scripts_block', 'scoped_scripts_block', 'plugin_scripts_block'];

function getCollapsedRegexSections() {
    if (!extension_settings.regex_section_collapsed || typeof extension_settings.regex_section_collapsed !== 'object') {
        extension_settings.regex_section_collapsed = {};
    }
    return extension_settings.regex_section_collapsed;
}

function applyCollapsedRegexSections() {
    const state = getCollapsedRegexSections();
    for (const id of REGEX_SECTION_IDS) {
        const section = document.getElementById(id);
        if (!section) continue;
        const sectionKey = section.getAttribute('data-section') || id;
        const shouldCollapse = state[sectionKey] === true;
        const content = section.querySelector(':scope > .inline-drawer-content');
        const icon = section.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
        if (!(content instanceof HTMLElement) || !(icon instanceof HTMLElement)) continue;
        if (shouldCollapse) {
            content.style.display = 'none';
            icon.classList.remove('down', 'fa-circle-chevron-down');
            icon.classList.add('up', 'fa-circle-chevron-up');
        } else {
            // Override the default `.inline-drawer-content { display: none }` so sections are
            // expanded by default; only sections the user explicitly collapsed stay hidden.
            content.style.display = 'block';
            icon.classList.add('down', 'fa-circle-chevron-down');
            icon.classList.remove('up', 'fa-circle-chevron-up');
        }
    }
}

function bindRegexSectionCollapse() {
    for (const id of REGEX_SECTION_IDS) {
        const section = document.getElementById(id);
        if (!section) continue;
        const sectionKey = section.getAttribute('data-section') || id;
        // jQuery .trigger('inline-drawer-toggle') in script.js fires a jQuery custom event,
        // bind via jQuery so the listener actually runs. The event is dispatched AFTER the
        // icon class toggles but BEFORE slideToggle changes content display, so we read the
        // post-toggle state from the icon (`up` = collapsed) rather than from getComputedStyle.
        $(section).on('inline-drawer-toggle', () => {
            const icon = section.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
            if (!(icon instanceof HTMLElement)) return;
            const state = getCollapsedRegexSections();
            if (icon.classList.contains('up')) {
                state[sectionKey] = true;
            } else {
                delete state[sectionKey];
            }
            saveSettingsDebounced();
        });
    }
    document.querySelectorAll('#regex_container .regex-section-toggle-control').forEach(label => {
        label.addEventListener('click', (e) => e.stopPropagation());
    });
}

/**
 * Toggle the icon for the "select all" checkbox in the regex settings.
 * - Use `fa-check-double` when the checkbox is unchecked (indicating all scripts are not selected).
 * - Use `fa-minus` when the checkbox is checked (indicating all scripts are selected).
 * @param {boolean} allAreChecked Should the "select all" icon be in the checked state?
 */
function setToggleAllIcon(allAreChecked) {
    const selectAllIcon = $('#bulk_select_all_toggle').find('i');
    selectAllIcon.toggleClass('fa-check-double', !allAreChecked);
    selectAllIcon.toggleClass('fa-minus', allAreChecked);
}

/**
 * Sets the visibility of the bulk move buttons based on selected scripts.
 */
function setMoveButtonsVisibility() {
    const hasGlobalScripts = $('#saved_regex_scripts .regex-script-label:has(.regex_bulk_checkbox:checked)').length > 0;
    const hasScopedScripts = $('#saved_scoped_scripts .regex-script-label:has(.regex_bulk_checkbox:checked)').length > 0;
    const hasPresetScripts = $('#saved_preset_scripts .regex-script-label:has(.regex_bulk_checkbox:checked)').length > 0;
    $('#bulk_regex_move_to_global').toggle(hasScopedScripts || hasPresetScripts);
    $('#bulk_regex_move_to_scoped').toggle(hasGlobalScripts || hasPresetScripts);
    $('#bulk_regex_move_to_preset').toggle(hasGlobalScripts || hasScopedScripts);
}

function applyRegexScriptUpsert(scripts, scriptToSave, existingId = null, existingScriptIndex = -1) {
    const nextScripts = Array.isArray(scripts) ? scripts.map(item => structuredClone(item)) : [];
    const lookupId = existingId || scriptToSave.id || null;
    let targetIndex = lookupId ? nextScripts.findIndex(item => item?.id === lookupId) : -1;
    if (targetIndex === -1 && existingScriptIndex >= 0 && existingScriptIndex < nextScripts.length && !lookupId) {
        targetIndex = existingScriptIndex;
    }
    if (targetIndex !== -1) {
        nextScripts[targetIndex] = structuredClone(scriptToSave);
    } else {
        nextScripts.push(structuredClone(scriptToSave));
    }
    return nextScripts;
}

function getRegexEditorSaveErrorMessage(scriptType, error) {
    if (scriptType === SCRIPT_TYPES.SCOPED) {
        return t`Could not save character-scoped regex script. Your edits remain open in the editor.`;
    }
    if (scriptType === SCRIPT_TYPES.PRESET) {
        const message = String(error?.message || '');
        if (message === 'Preset extension settings could not be saved' || message === 'Preset extension settings acknowledgement changed') {
            return t`Could not save preset regex script. Your edits remain open in the editor.`;
        }
        return t`Preset regex settings were saved, but persisting the preset or character card failed. Your edits remain open in the editor.`;
    }
    return t`Could not save global regex script. Your edits remain open in the editor.`;
}

function showRegexScriptContentWarnings(regexScript) {
    if (regexScript.findRegex.length === 0) {
        toastr.warning(t`This regex script will not work, but was saved anyway: A find regex isn't present.`);
    }

    const pluginLanes = getPluginLanes(regexScript);
    if (pluginLanes.includes('request') && regexScript.placement.length === 0) {
        toastr.warning(t`This regex script will not work on plugin requests, but was saved anyway: select at least one message type.`);
    } else if (regexScript.placement.length === 0 && pluginLanes.length === 0) {
        toastr.warning(t`This regex script will not work, but was saved anyway: One "Affects" checkbox must be selected!`);
    }
}

/**
 * Persists the user's "Allow anyway" decision on the regex script itself, so it
 * survives enable/disable toggles, edits, and reloads until the script is deleted.
 * Runtime (plugin-provided) scripts have no persisted storage; their decision
 * stays in the reporter's session cache.
 *
 * @param {string} id Regex script id
 * @returns {Promise<boolean>} true if a persisted script was updated
 */
async function persistRegexScriptAllowSlow(id) {
    const scriptId = String(id || '');
    if (!scriptId) {
        return false;
    }
    for (const scriptType of [SCRIPT_TYPES.GLOBAL, SCRIPT_TYPES.SCOPED, SCRIPT_TYPES.PRESET]) {
        const target = captureRegexTarget(scriptType);
        const scripts = getScriptsByType(scriptType, { target });
        if (!Array.isArray(scripts)) {
            continue;
        }
        const index = scripts.findIndex(item => item && item.id === scriptId);
        if (index === -1) {
            continue;
        }
        if (!scripts[index].allowSlow) {
            if (scriptType === SCRIPT_TYPES.SCOPED) {
                await updateScopedRegexScripts((currentScripts) => {
                    const currentIdx = currentScripts.findIndex(item => item && item.id === scriptId);
                    if (currentIdx === -1 || currentScripts[currentIdx].allowSlow) {
                        return null;
                    }
                    const next = currentScripts.map(item => structuredClone(item));
                    next[currentIdx].allowSlow = true;
                    return next;
                }, target);
            } else {
                const next = scripts.map(item => structuredClone(item));
                next[index].allowSlow = true;
                await saveScriptsByType(next, scriptType, { target });
            }
        }
        return true;
    }
    return false;
}

/**
 * Saves a regex script to the extension settings or character data.
 * @param {import('../../char-data.js').RegexScriptData} regexScript
 * @param {number} existingScriptIndex Index of the existing script
 * @param {SCRIPT_TYPES} scriptType Type of the script
 * @param {boolean} [saveSettings=true] Whether to save the settings immediately
 * @param {{ target?: ReturnType<typeof captureRegexTarget> | null, existingId?: string | null, persistGlobalImmediately?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
async function saveRegexScript(regexScript, existingScriptIndex, scriptType, saveSettings = true, options = {}) {
    const target = options?.target || captureRegexTarget(scriptType);
    const scriptTypeLabel = REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType);

    // Assign a UUID if it doesn't exist
    if (!regexScript.id) {
        regexScript.id = uuidv4();
    }

    // Is the script name undefined or empty?
    if (!regexScript.scriptName) {
        toastr.error(t`Could not save regex script: The script name was undefined or empty!`);
        return false;
    }

    const scriptToSave = structuredClone(regexScript);
    if (!Array.isArray(scriptToSave.placement)) {
        scriptToSave.placement = [];
    }

    const existingId = options?.existingId ?? (existingScriptIndex !== -1 ? scriptToSave.id : null);
    const currentPreviewScripts = getScriptsByType(scriptType, { target });
    const previewNext = applyRegexScriptUpsert(currentPreviewScripts, scriptToSave, existingId, existingScriptIndex);

    console.info('[Regex] saveRegexScript prepared', {
        scriptType: scriptTypeLabel,
        existingScriptIndex,
        saveSettings,
        chid: target?.characterId ?? this_chid ?? null,
        selectedGroup: selected_group ?? null,
        scriptSummary: summarizeRegexScriptForLog(scriptToSave),
        nextScriptCount: previewNext.length,
    });

    if (scriptType === SCRIPT_TYPES.SCOPED) {
        const result = await updateScopedRegexScripts(
            currentScripts => applyRegexScriptUpsert(currentScripts, scriptToSave, existingId, existingScriptIndex),
            target,
        );
        allowScopedScripts(result.character);
    } else if (scriptType === SCRIPT_TYPES.PRESET) {
        const nextPresetScripts = applyRegexScriptUpsert(getScriptsByType(SCRIPT_TYPES.PRESET, { target }), scriptToSave, existingId, existingScriptIndex);
        await saveScriptsByType(nextPresetScripts, SCRIPT_TYPES.PRESET, { target });
        allowPresetScripts(target?.presetApiId ?? getCurrentPresetAPI(), target?.presetName ?? getCurrentPresetName());
    } else if (scriptType === SCRIPT_TYPES.GLOBAL) {
        const nextGlobalScripts = applyRegexScriptUpsert(getScriptsByType(SCRIPT_TYPES.GLOBAL), scriptToSave, existingId, existingScriptIndex);
        await saveScriptsByType(nextGlobalScripts, SCRIPT_TYPES.GLOBAL, {
            persistGlobal: options?.persistGlobalImmediately ? () => saveSettingsNow() : null,
        });
    }

    // The script may have been auto-paused in a previous session-state. Saving
    // replaces the pattern, so wipe its runtime session state only after persistence succeeds.
    resetRegexScriptState(scriptToSave.id);
    showRegexScriptContentWarnings(scriptToSave);

    if (saveSettings) {
        if (scriptType !== SCRIPT_TYPES.GLOBAL || !options?.persistGlobalImmediately) {
            saveSettingsDebounced();
        }
        await loadRegexScripts();
        await requestRegexChatReload();
    }

    console.info('[Regex] saveRegexScript completed', {
        scriptType: scriptTypeLabel,
        saveSettings,
        chid: target?.characterId ?? this_chid ?? null,
        scopedAllowed: isScopedScriptsAllowed(target?.character ?? characters?.[this_chid]),
        scopedCount: getScriptsByType(SCRIPT_TYPES.SCOPED).length,
        globalCount: getScriptsByType(SCRIPT_TYPES.GLOBAL).length,
        presetCount: getScriptsByType(SCRIPT_TYPES.PRESET).length,
    });

    const debuggerPopup = $('#regex_debugger_popup');
    if (debuggerPopup.length) {
        populateDebuggerRuleList(debuggerPopup.parent());
    }
    return true;
}

/**
 * Delete a regex script by ID
 * @param {string} id ID of the script to delete
 * @param {SCRIPT_TYPES} scriptType Type of the script
 * @param {boolean} saveSettingsFlag Whether to save the settings immediately
 * @param {{ target?: ReturnType<typeof captureRegexTarget> | null, persistGlobalImmediately?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
async function deleteRegexScript(id, scriptType, saveSettingsFlag = true, options = {}) {
    const target = options?.target || captureRegexTarget(scriptType);
    let deleted = false;

    switch (scriptType) {
        case SCRIPT_TYPES.GLOBAL: {
            const current = getScriptsByType(SCRIPT_TYPES.GLOBAL);
            const next = current.filter(script => script.id !== id);
            if (next.length === current.length) {
                return false;
            }
            await saveScriptsByType(next, SCRIPT_TYPES.GLOBAL, {
                persistGlobal: options?.persistGlobalImmediately ? () => saveSettingsNow() : null,
            });
            deleted = true;
            break;
        }
        case SCRIPT_TYPES.SCOPED: {
            const result = await updateScopedRegexScripts((currentScripts) => {
                const next = currentScripts.filter(script => script.id !== id);
                return next.length === currentScripts.length ? null : next;
            }, target);
            deleted = result.changed;
            break;
        }
        case SCRIPT_TYPES.PRESET: {
            const current = getScriptsByType(SCRIPT_TYPES.PRESET, { target });
            const next = current.filter(script => script.id !== id);
            if (next.length === current.length) {
                return false;
            }
            await saveScriptsByType(next, SCRIPT_TYPES.PRESET, { target });
            deleted = true;
            break;
        }
        default:
            return false;
    }

    if (!deleted) {
        return false;
    }

    // Wipe any session-level state only after persistence succeeds.
    resetRegexScriptState(id);

    if (saveSettingsFlag) {
        if (scriptType !== SCRIPT_TYPES.GLOBAL || !options?.persistGlobalImmediately) {
            saveSettingsDebounced();
        }
        await loadRegexScripts();
    }
    return true;
}

/**
 * Move a regex script from one type to another.
 * Saves to the destination with acknowledgement BEFORE removing from source.
 * @param {import('../../char-data.js').RegexScriptData} script The script to move
 * @param {SCRIPT_TYPES} toType Target type
 * @param {SCRIPT_TYPES|null} fromType Source type, if null it will be determined automatically
 * @param {boolean} saveSettingsFlag Whether to save the settings immediately
 * @param {{ fromTarget?: ReturnType<typeof captureRegexTarget> | null, toTarget?: ReturnType<typeof captureRegexTarget> | null }} [options]
 * @returns {Promise<{ ok: boolean, partial?: boolean }>}
 */
async function moveRegexScript(script, toType, fromType = null, saveSettingsFlag = true, options = {}) {
    if (!Object.values(SCRIPT_TYPES).includes(toType)) {
        console.warn(`moveRegexScript: Invalid target script type ${toType}`);
        return { ok: false };
    }
    if (!Object.values(SCRIPT_TYPES).includes(fromType)) {
        fromType = getScriptType(script);
    }
    if (fromType === toType || fromType === SCRIPT_TYPE_UNKNOWN || toType === SCRIPT_TYPE_UNKNOWN) {
        return { ok: false };
    }

    const fromTarget = options?.fromTarget || captureRegexTarget(fromType);
    const toTarget = options?.toTarget || captureRegexTarget(toType);
    const scriptCopy = structuredClone(script);

    try {
        await saveRegexScript(scriptCopy, -1, toType, false, {
            target: toTarget,
            existingId: null,
            persistGlobalImmediately: toType === SCRIPT_TYPES.GLOBAL,
        });
    } catch (error) {
        console.error('[Regex] moveRegexScript failed while saving to destination', {
            scriptId: scriptCopy.id,
            fromType: REGEX_SCRIPT_TYPE_LABELS[fromType] || String(fromType),
            toType: REGEX_SCRIPT_TYPE_LABELS[toType] || String(toType),
            error,
        });
        toastr.error(t`Could not move regex script because saving to the destination failed. The original script was kept.`);
        if (saveSettingsFlag) {
            await loadRegexScripts();
        }
        return { ok: false, partial: false };
    }

    try {
        await deleteRegexScript(scriptCopy.id, fromType, false, {
            target: fromTarget,
            persistGlobalImmediately: fromType === SCRIPT_TYPES.GLOBAL,
        });
    } catch (error) {
        console.error('[Regex] moveRegexScript saved destination but failed to remove source', {
            scriptId: scriptCopy.id,
            fromType: REGEX_SCRIPT_TYPE_LABELS[fromType] || String(fromType),
            toType: REGEX_SCRIPT_TYPE_LABELS[toType] || String(toType),
            error,
        });
        toastr.error(t`Regex script was saved to the destination, but could not be removed from the source. Both copies currently exist.`);
        if (saveSettingsFlag) {
            await loadRegexScripts();
            await requestRegexChatReload();
        }
        return { ok: false, partial: true };
    }

    if (saveSettingsFlag) {
        saveSettingsDebounced();
        await loadRegexScripts();
        await requestRegexChatReload();
    }
    return { ok: true };
}

async function syncRegexEditorState(requestId) {
    if (!selected_group && this_chid !== undefined) {
        // Android/app starts from shallow character stubs, so scoped regexes need a hydrated card before render.
        console.debug('[Regex] Hydrating scoped regex character state before render', {
            requestId,
            chid: this_chid,
            avatar: characters?.[this_chid]?.avatar || null,
        });
        await unshallowCharacter(this_chid);
        if (requestId !== regexScriptsRenderRequestId) {
            return false;
        }
    }

    presetManager.renderPresetList();
    return requestId === regexScriptsRenderRequestId;
}

async function refreshRegexEditorUi() {
    presetManager.renderPresetList();
    await loadRegexScripts();
}

async function loadRegexScripts() {
    const requestId = ++regexScriptsRenderRequestId;
    if (!await syncRegexEditorState(requestId)) {
        return;
    }
    const scriptTemplate = $(await renderExtensionTemplateAsync('regex', 'scriptTemplate'));
    if (requestId !== regexScriptsRenderRequestId) {
        return;
    }

    $('#saved_regex_scripts').empty();
    $('#saved_scoped_scripts').empty();
    $('#saved_preset_scripts').empty();
    $('#saved_plugin_scripts').empty();
    setToggleAllIcon(false);

    /**
     * Renders a script to the UI.
     * @param {string} container Container to render the script to
     * @param {import('../../char-data.js').RegexScriptData} script Script data
     * @param {SCRIPT_TYPES} scriptType Type of the script
     * @param {number} index Index of the script in the array
     */
    function renderScript(container, script, scriptType, index, { readOnly = false } = {}) {
        // Have to clone here
        const scriptHtml = scriptTemplate.clone();
        const renderedTarget = readOnly ? null : captureRegexTarget(scriptType);

        if (!script.id) {
            script.id = uuidv4();
        }

        scriptHtml.attr('id', script.id);
        const runtimeOwner = String(script.__runtime_owner || '').trim();
        const displayName = readOnly && runtimeOwner
            ? `${script.scriptName} (${runtimeOwner})`
            : script.scriptName;
        scriptHtml.find('.regex_script_name').text(displayName).attr('title', displayName);
        scriptHtml.find('.disable_regex').prop('checked', script.disabled ?? false);

        if (readOnly) {
            const readonlyId = `runtime_${sanitizeFileName(runtimeOwner || 'plugin')}_${sanitizeFileName(String(script.id || index || uuidv4()))}`;
            scriptHtml.attr('id', readonlyId);
            scriptHtml.attr('data-readonly', 'true');
            const viewButton = scriptHtml.find('.edit_existing_regex');
            viewButton.attr('title', String(t`Regex Editor`));
            viewButton.attr('data-i18n', '[title]Regex Editor');
            viewButton.find('i').removeClass('fa-pencil').addClass('fa-eye');
            viewButton.on('click', async function () {
                await onReadonlyRegexViewOpenClick(script, displayName);
            });
            scriptHtml.find('.regex_script_name').on('click', async function () {
                await onReadonlyRegexViewOpenClick(script, displayName);
            });
            $(container).append(scriptHtml);
            return;
        }

        scriptHtml.find('.disable_regex').on('input', async function () {
            const checkbox = $(this);
            const latestScript = getScriptsByType(scriptType, { target: renderedTarget }).find(s => s?.id === script.id) || script;
            const previousDisabled = Boolean(latestScript.disabled);
            const nextDisabled = !!checkbox.prop('checked');
            const updatedScript = { ...structuredClone(latestScript), disabled: nextDisabled };
            checkbox.prop('disabled', true);
            try {
                await saveRegexScript(updatedScript, index, scriptType, true, {
                    target: renderedTarget,
                    existingId: script.id,
                });
            } catch (error) {
                console.error('[Regex] Failed to save regex script toggle state', {
                    scriptId: script.id,
                    scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
                    error,
                });
                toastr.error(t`Could not save regex script changes.`);
                checkbox.prop('checked', previousDisabled);
                await loadRegexScripts();
            } finally {
                checkbox.prop('disabled', false);
            }
        });
        scriptHtml.find('.regex-toggle-on').on('click', function () {
            scriptHtml.find('.disable_regex').prop('checked', true).trigger('input');
        });
        scriptHtml.find('.regex-toggle-off').on('click', function () {
            scriptHtml.find('.disable_regex').prop('checked', false).trigger('input');
        });
        scriptHtml.find('.edit_existing_regex').on('click', async function () {
            await onRegexEditorOpenClick(scriptHtml.attr('id'), scriptType);
        });
        scriptHtml.find('.move_to_global').on('click', async function () {
            const confirm = await callGenericPopup(t`Are you sure you want to move this regex script to global?`, POPUP_TYPE.CONFIRM);

            if (!confirm) {
                return;
            }
            const latestScript = getScriptsByType(scriptType, { target: renderedTarget }).find(s => s?.id === script.id) || script;
            await moveRegexScript(latestScript, SCRIPT_TYPES.GLOBAL, scriptType, true, { fromTarget: renderedTarget });
        });
        scriptHtml.find('.move_to_scoped').on('click', async function () {
            if (this_chid === undefined) {
                toastr.error(t`No character selected.`);
                return;
            }
            if (selected_group) {
                toastr.error(t`Cannot edit scoped scripts in group chats.`);
                return;
            }
            const confirm = await callGenericPopup(t`Are you sure you want to move this regex script to scoped?`, POPUP_TYPE.CONFIRM);
            if (!confirm) {
                return;
            }
            const latestScript = getScriptsByType(scriptType, { target: renderedTarget }).find(s => s?.id === script.id) || script;
            await moveRegexScript(latestScript, SCRIPT_TYPES.SCOPED, scriptType, true, { fromTarget: renderedTarget });
        });
        scriptHtml.find('.move_to_preset').on('click', async function () {
            const confirm = await callGenericPopup(
                t`Are you sure you want to move this regex script to preset?`,
                POPUP_TYPE.CONFIRM,
            );
            if (!confirm) {
                return;
            }
            const latestScript = getScriptsByType(scriptType, { target: renderedTarget }).find(s => s?.id === script.id) || script;
            await moveRegexScript(latestScript, SCRIPT_TYPES.PRESET, scriptType, true, { fromTarget: renderedTarget });
        });
        scriptHtml.find('.export_regex').on('click', async function () {
            const latestScript = getScriptsByType(scriptType, { target: renderedTarget }).find(s => s?.id === script.id) || script;
            const fileName = `regex-${sanitizeFileName(latestScript.scriptName)}.json`;
            const fileData = JSON.stringify(latestScript, null, 4);
            download(fileData, fileName, 'application/json');
        });
        scriptHtml.find('.delete_regex').on('click', async function () {
            const confirm = await callGenericPopup(t`Are you sure you want to delete this regex script?`, POPUP_TYPE.CONFIRM);
            if (!confirm) {
                return;
            }
            try {
                const deleted = await deleteRegexScript(script.id, scriptType, true, { target: renderedTarget });
                if (deleted) {
                    await requestRegexChatReload();
                }
            } catch (error) {
                console.error('[Regex] Failed to delete regex script', {
                    scriptId: script.id,
                    scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
                    error,
                });
                toastr.error(t`Could not delete regex script.`);
                await loadRegexScripts();
            }
        });
        scriptHtml.find('.regex_bulk_checkbox').on('change', function () {
            setMoveButtonsVisibility();
            const checkboxes = $('#regex_container .regex_bulk_checkbox');
            const allAreChecked = checkboxes.length === checkboxes.filter(':checked').length;
            setToggleAllIcon(allAreChecked);
        });
        scriptHtml.find('input[name="regex_expand"]').on('change', function () {
            if (!(this instanceof HTMLInputElement)) {
                return;
            }

            if (!this.checked) {
                return;
            }

            const closeMenuHandler = (e) => {
                if (e.target instanceof HTMLElement) {
                    if (e.target.closest('.regex-script-label')) {
                        return;
                    }
                    this.checked = false;
                    document.removeEventListener('click', closeMenuHandler);
                }
            };

            // Use setTimeout to avoid closing immediately from the same click
            setTimeout(() => {
                document.addEventListener('click', closeMenuHandler, { passive: true, once: false });
            }, 0);
        });

        $(container).append(scriptHtml);
    }

    const renderIssues = new Set();
    const globalScripts = await sanitizeRegexScriptsForEditor(getScriptsByType(SCRIPT_TYPES.GLOBAL), SCRIPT_TYPES.GLOBAL, { issues: renderIssues });
    const scopedScripts = await sanitizeRegexScriptsForEditor(getScriptsByType(SCRIPT_TYPES.SCOPED), SCRIPT_TYPES.SCOPED, { issues: renderIssues });
    const presetScripts = await sanitizeRegexScriptsForEditor(getScriptsByType(SCRIPT_TYPES.PRESET), SCRIPT_TYPES.PRESET, { issues: renderIssues });
    const runtimeScripts = await sanitizeRegexScriptsForEditor(getRuntimeRegexScripts(), SCRIPT_TYPE_UNKNOWN, { readOnly: true, issues: renderIssues });

    if (renderIssues.size) {
        toastr.error(Array.from(renderIssues).join('<br>'), t`Regex script error`, {
            escapeHtml: false,
            timeOut: 10000,
        });
    }

    globalScripts.forEach((script, index) => renderScript('#saved_regex_scripts', script, SCRIPT_TYPES.GLOBAL, index));
    scopedScripts.forEach((script, index) => renderScript('#saved_scoped_scripts', script, SCRIPT_TYPES.SCOPED, index));
    presetScripts.forEach((script, index) => renderScript('#saved_preset_scripts', script, SCRIPT_TYPES.PRESET, index));
    runtimeScripts.forEach((script, index) => renderScript('#saved_plugin_scripts', script, SCRIPT_TYPE_UNKNOWN, index, { readOnly: true }));

    $('#regex_scoped_toggle').prop('checked', isScopedScriptsAllowed(characters?.[this_chid]));
    $('#regex_preset_toggle').prop('checked', isPresetScriptsAllowed(getCurrentPresetAPI(), getCurrentPresetName()));

    setMoveButtonsVisibility();

    // Re-init Sortable after the lists were rebuilt; without this, jQuery UI
    // Sortable keeps internal refs to the old <li> nodes and they linger as
    // detached DOM until full GC (which V8 defers indefinitely under load).
    setupRegexSortable();

    console.info('[Regex] Editor UI loaded', {
        requestId,
        chid: this_chid ?? null,
        avatar: characters?.[this_chid]?.avatar || null,
        selectedGroup: selected_group ?? null,
        globalCount: globalScripts.length,
        scopedCount: scopedScripts.length,
        presetCount: presetScripts.length,
        runtimeCount: runtimeScripts.length,
        scopedAllowed: isScopedScriptsAllowed(characters?.[this_chid]),
        presetAllowed: isPresetScriptsAllowed(getCurrentPresetAPI(), getCurrentPresetName()),
    });
}

function fillRegexEditorFields(editorHtml, script) {
    if (!script?.scriptName) {
        return false;
    }
    editorHtml.find('.regex_script_name').val(script.scriptName);
    editorHtml.find('.find_regex').val(script.findRegex || '');
    editorHtml.find('.regex_replace_string').val(script.replaceString || '');
    editorHtml.find('.regex_trim_strings').val(script.trimStrings?.join('\n') || []);
    editorHtml.find('input[name="disabled"]').prop('checked', script.disabled ?? false);
    editorHtml.find('input[name="only_format_display"]').prop('checked', script.markdownOnly ?? false);
    editorHtml.find('input[name="only_format_prompt"]').prop('checked', script.promptOnly ?? false);
    const pluginLanes = getPluginLanes(script);
    editorHtml.find('input[name="plugin_request"]').prop('checked', pluginLanes.includes('request'));
    editorHtml.find('input[name="plugin_reply"]').prop('checked', pluginLanes.includes('reply'));
    editorHtml.find('input[name="run_on_edit"]').prop('checked', script.runOnEdit ?? false);
    editorHtml.find('select[name="substitute_regex"]').val(script.substituteRegex ?? substitute_find_regex.NONE);
    editorHtml.find('input[name="min_depth"]').val(script.minDepth ?? '');
    editorHtml.find('input[name="max_depth"]').val(script.maxDepth ?? '');

    const existingPlacement = Array.isArray(script.placement) ? script.placement : [];
    existingPlacement.forEach((element) => {
        editorHtml
            .find(`input[name="replace_position"][value="${element}"]`)
            .prop('checked', true);
    });
    return true;
}

const REGEX_EDITOR_SUMMARY_FIELDS = Object.freeze({
    placements: { selector: 'input[name="replace_position"]', highlight: 'label.checkbox' },
    placementWorldInfo: { selector: 'input[name="replace_position"][value="5"]', highlight: 'label.checkbox' },
    placementSlashCommand: { selector: 'input[name="replace_position"][value="3"]', highlight: 'label.checkbox' },
    placementReasoning: { selector: 'input[name="replace_position"][value="6"]', highlight: 'label.checkbox' },
    pluginRequest: { selector: 'input[name="plugin_request"]', highlight: 'label.checkbox' },
    pluginReply: { selector: 'input[name="plugin_reply"]', highlight: 'label.checkbox' },
    minDepth: { selector: 'input[name="min_depth"]', highlight: '.flex1' },
    maxDepth: { selector: 'input[name="max_depth"]', highlight: '.flex1' },
    disabled: { selector: 'input[name="disabled"]', highlight: 'label.checkbox' },
    runOnEdit: { selector: 'input[name="run_on_edit"]', highlight: 'label.checkbox' },
    substituteRegex: { selector: 'select[name="substitute_regex"]', highlight: 'label.checkbox' },
    markdownOnly: { selector: 'input[name="only_format_display"]', highlight: 'label.checkbox' },
    promptOnly: { selector: 'input[name="only_format_prompt"]', highlight: 'label.checkbox' },
});

function readRegexEditorSummaryState(rootEl) {
    const placements = Array.from(rootEl.querySelectorAll('input[name="replace_position"]:checked'))
        .map((el) => Number.parseInt(String(el.value), 10))
        .filter((num) => Number.isFinite(num));

    const minDepthInput = /** @type {HTMLInputElement|null} */ (rootEl.querySelector('input[name="min_depth"]'));
    const maxDepthInput = /** @type {HTMLInputElement|null} */ (rootEl.querySelector('input[name="max_depth"]'));
    const substituteSelect = /** @type {HTMLSelectElement|null} */ (rootEl.querySelector('select[name="substitute_regex"]'));

    return {
        disabled: Boolean(/** @type {HTMLInputElement|null} */ (rootEl.querySelector('input[name="disabled"]'))?.checked),
        placements,
        pluginRequest: Boolean(/** @type {HTMLInputElement|null} */ (rootEl.querySelector('input[name="plugin_request"]'))?.checked),
        pluginReply: Boolean(/** @type {HTMLInputElement|null} */ (rootEl.querySelector('input[name="plugin_reply"]'))?.checked),
        minDepthRaw: String(minDepthInput?.value ?? ''),
        maxDepthRaw: String(maxDepthInput?.value ?? ''),
        runOnEdit: Boolean(/** @type {HTMLInputElement|null} */ (rootEl.querySelector('input[name="run_on_edit"]'))?.checked),
        substituteRegex: Number(substituteSelect?.value ?? substitute_find_regex.NONE),
        markdownOnly: Boolean(/** @type {HTMLInputElement|null} */ (rootEl.querySelector('input[name="only_format_display"]'))?.checked),
        promptOnly: Boolean(/** @type {HTMLInputElement|null} */ (rootEl.querySelector('input[name="only_format_prompt"]'))?.checked),
        translate,
    };
}

function mountRegexEditorBehaviorSummary(editorHtml) {
    const rootEl = editorHtml?.get?.(0) || editorHtml?.[0] || null;
    if (!(rootEl instanceof Element)) {
        return null;
    }
    const editorBody = rootEl.matches('.regex_editor') ? rootEl : (rootEl.querySelector('.regex_editor') || rootEl);
    const affectsColumn = editorBody.querySelector('input[name="replace_position"]')?.closest('.wi-enter-footer-text');
    const twoColumnGrid = affectsColumn?.parentElement;
    const anchor = twoColumnGrid || editorBody;
    const position = twoColumnGrid ? 'before' : 'prepend';

    return mountBehaviorSummary({
        id: 'regex-editor',
        root: editorBody,
        anchor,
        position,
        fields: REGEX_EDITOR_SUMMARY_FIELDS,
        ariaLabel: translate('Regex rule scope and conflict summary'),
        readState: readRegexEditorSummaryState,
        build: buildRegexBehaviorSummary,
    });
}

export async function onReadonlyRegexViewOpenClick(script, displayName = '') {
    const editorHtml = $(await renderExtensionTemplateAsync('regex', 'editor'));
    if (!fillRegexEditorFields(editorHtml, script)) {
        toastr.error('This script doesn\'t have a name! Please delete it.');
        return;
    }
    editorHtml.find('#regex_test_mode_toggle').remove();
    editorHtml.find('#regex_test_mode').remove();
    editorHtml.find('input, textarea, select').prop('disabled', true);
    let summaryHandle = mountRegexEditorBehaviorSummary(editorHtml);
    try {
        await callGenericPopup(
            editorHtml,
            POPUP_TYPE.TEXT,
            displayName || String(script?.scriptName || ''),
            {
                okButton: t`Close`,
                wide: true,
                large: true,
                allowVerticalScrolling: true,
                onOpen: () => {
                    summaryHandle?.refresh?.();
                },
                onClose: () => {
                    summaryHandle?.destroy?.();
                    summaryHandle = null;
                },
            },
        );
    } finally {
        summaryHandle?.destroy?.();
        summaryHandle = null;
    }
}

/**
 * Opens the regex editor.
 * @param {string|boolean} existingId Existing ID
 * @param {SCRIPT_TYPES} scriptType Type of the script
 * @returns {Promise<void>}
 */
export async function onRegexEditorOpenClick(existingId, scriptType) {
    const capturedTarget = captureRegexTarget(scriptType);
    const editorHtml = $(await renderExtensionTemplateAsync('regex', 'editor'));
    const array = getScriptsByType(scriptType, { target: capturedTarget });
    const scriptTypeLabel = REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType);
    const draftScriptId = existingId ? String(existingId) : uuidv4();
    const existingScriptId = existingId ? String(existingId) : null;
    const logEditorState = (event, extra = {}) => {
        console.info('[Regex] Editor interaction', {
            event,
            scriptType: scriptTypeLabel,
            existingId: existingId || null,
            existingScriptIndex,
            chid: capturedTarget?.characterId ?? this_chid ?? null,
            selectedGroup: selected_group ?? null,
            domState: summarizeRegexEditorDomStateForLog(editorHtml),
            ...extra,
        });
    };

    console.info('[Regex] Editor opened', {
        existingId: existingId || null,
        scriptType: scriptTypeLabel,
        currentScriptCount: array.length,
        chid: capturedTarget?.characterId ?? this_chid ?? null,
        selectedGroup: selected_group ?? null,
    });

    // If an ID exists, fill in all the values
    let existingScriptIndex = -1;
    let preservedAllowSlow = false;
    if (existingId) {
        existingScriptIndex = array.findIndex((script) => script.id === existingId);
        if (existingScriptIndex !== -1) {
            const existingScript = array[existingScriptIndex];
            preservedAllowSlow = Boolean(existingScript?.allowSlow);
            if (!fillRegexEditorFields(editorHtml, existingScript)) {
                toastr.error('This script doesn\'t have a name! Please delete it.');
                return;
            }
        }
    } else {
        editorHtml
            .find('input[name="only_format_display"]')
            .prop('checked', true);

        editorHtml
            .find('input[name="run_on_edit"]')
            .prop('checked', true);

        editorHtml
            .find('input[name="replace_position"][value="1"]')
            .prop('checked', true);
    }

    editorHtml.find('input[name="plugin_request"], input[name="plugin_reply"]').on('click input change', function (event) {
        logEditorState('plugin_lane_toggled', {
            eventType: event.type,
            inputName: this.name,
            inputChecked: Boolean($(this).prop('checked')),
        });
    });

    editorHtml.find('#regex_test_mode_toggle').on('click', function () {
        editorHtml.find('#regex_test_mode').toggleClass('displayNone');
        updateTestResult();
    });

    function updateTestResult() {
        updateInfoBlock(editorHtml);

        if (!editorHtml.find('#regex_test_mode').is(':visible')) {
            return;
        }

        const testScript = {
            id: uuidv4(),
            scriptName: editorHtml.find('.regex_script_name').val().toString(),
            findRegex: editorHtml.find('.find_regex').val().toString(),
            replaceString: editorHtml.find('.regex_replace_string').val().toString(),
            trimStrings: String(editorHtml.find('.regex_trim_strings').val()).split('\n').filter((e) => e.length !== 0) || [],
            substituteRegex: Number(editorHtml.find('select[name="substitute_regex"]').val()),
            disabled: false,
            promptOnly: false,
            pluginLanes: [],
            markdownOnly: false,
            runOnEdit: false,
            minDepth: null,
            maxDepth: null,
            placement: null,
        };
        const rawTestString = String(editorHtml.find('#regex_test_input').val());
        const result = runRegexScript(testScript, rawTestString);
        editorHtml.find('#regex_test_output').text(result);
    }

    editorHtml.find('input, textarea, select').on('input', updateTestResult);
    updateInfoBlock(editorHtml);
    let summaryHandle = mountRegexEditorBehaviorSummary(editorHtml);

    let saveInFlight = false;
    const confirmEditorSave = async (popup) => {
        if (saveInFlight) {
            return false;
        }
        const newRegexScript = {
            id: draftScriptId,
            scriptName: String(editorHtml.find('.regex_script_name').val()),
            findRegex: String(editorHtml.find('.find_regex').val()),
            replaceString: String(editorHtml.find('.regex_replace_string').val()),
            trimStrings: String(editorHtml.find('.regex_trim_strings').val()).split('\n').filter((e) => e.length !== 0) || [],
            placement:
                editorHtml
                    .find('input[name="replace_position"]')
                    .filter(':checked')
                    .map(function () { return parseInt($(this).val().toString()); })
                    .get()
                    .filter((e) => !isNaN(e)) || [],
            disabled: editorHtml.find('input[name="disabled"]').prop('checked'),
            markdownOnly: editorHtml.find('input[name="only_format_display"]').prop('checked'),
            promptOnly: editorHtml.find('input[name="only_format_prompt"]').prop('checked'),
            pluginLanes: [
                editorHtml.find('input[name="plugin_request"]').prop('checked') ? 'request' : null,
                editorHtml.find('input[name="plugin_reply"]').prop('checked') ? 'reply' : null,
            ].filter(Boolean),
            runOnEdit: editorHtml.find('input[name="run_on_edit"]').prop('checked'),
            substituteRegex: Number(editorHtml.find('select[name="substitute_regex"]').val()),
            minDepth: parseInt(String(editorHtml.find('input[name="min_depth"]').val())),
            maxDepth: parseInt(String(editorHtml.find('input[name="max_depth"]').val())),
        };

        if (!newRegexScript.scriptName) {
            toastr.error(t`Could not save regex script: The script name was undefined or empty!`);
            return false;
        }

        // Preserve the persisted "Allow anyway" decision across edits; it is
        // cleared only when the script is deleted.
        if (preservedAllowSlow) {
            newRegexScript.allowSlow = true;
        }

        console.info('[Regex] Editor save confirmed', {
            scriptType: scriptTypeLabel,
            existingId: existingId || null,
            existingScriptIndex,
            chid: capturedTarget?.characterId ?? this_chid ?? null,
            selectedGroup: selected_group ?? null,
            scriptSummary: summarizeRegexScriptForLog(newRegexScript),
        });

        saveInFlight = true;
        popup.okButton?.classList.add('disabled');
        try {
            const saved = await saveRegexScript(newRegexScript, existingScriptIndex, scriptType, true, {
                target: capturedTarget,
                existingId: existingScriptId,
                persistGlobalImmediately: scriptType === SCRIPT_TYPES.GLOBAL,
            });
            return saved !== false;
        } catch (error) {
            console.error('[Regex] saveRegexScript failed after editor confirm', {
                scriptType: scriptTypeLabel,
                existingId: existingId || null,
                existingScriptIndex,
                chid: capturedTarget?.characterId ?? this_chid ?? null,
                selectedGroup: selected_group ?? null,
                scriptSummary: summarizeRegexScriptForLog(newRegexScript),
            }, error);
            toastr.error(getRegexEditorSaveErrorMessage(scriptType, error));
            return false;
        } finally {
            saveInFlight = false;
            popup.okButton?.classList.remove('disabled');
        }
    };

    logEditorState('popup_show_requested');

    let popupResult;
    try {
        popupResult = await callGenericPopup(editorHtml, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Save`,
            cancelButton: t`Cancel`,
            allowVerticalScrolling: true,
            onOpen: (popup) => {
                summaryHandle?.refresh?.();
                logEditorState('popup_opened');
                popup.okButton?.addEventListener('click', () => {
                    logEditorState('save_button_clicked');
                }, { passive: true });
                popup.cancelButton?.addEventListener('click', () => {
                    logEditorState('cancel_button_clicked');
                }, { passive: true });
            },
            onClosing: async (popup) => {
                logEditorState('popup_closing_requested', {
                    popupResult: popup.result ?? null,
                    popupValue: popup.value ?? null,
                });
                if (popup.result === POPUP_RESULT.AFFIRMATIVE) {
                    return await confirmEditorSave(popup);
                }
                return !saveInFlight;
            },
            onClose: (popup) => {
                summaryHandle?.destroy?.();
                summaryHandle = null;
                logEditorState('popup_closed', {
                    popupResult: popup.result ?? null,
                    popupValue: popup.value ?? null,
                });
            },
        });
    } catch (error) {
        console.error('[Regex] Editor popup failed', {
            scriptType: scriptTypeLabel,
            existingId: existingId || null,
            existingScriptIndex,
            chid: capturedTarget?.characterId ?? this_chid ?? null,
            selectedGroup: selected_group ?? null,
            domState: summarizeRegexEditorDomStateForLog(editorHtml),
        }, error);
        throw error;
    } finally {
        summaryHandle?.destroy?.();
        summaryHandle = null;
    }

    logEditorState('popup_returned', { popupResult: popupResult ?? null });
    if (!popupResult) {
        logEditorState('save_not_confirmed', { popupResult: popupResult ?? null });
    }
}

/**
 * Builds an HTML string for a replacement, highlighting literal parts in green
 * and keeping back-referenced parts plain.
 * @param {RegExpMatchArray} match The match object from `matchAll`.
 * @param {string} pattern The replacement pattern string (e.g., "new text $1").
 * @returns {string} The constructed HTML string.
 */
function buildReplacementHtml(match, pattern) {
    const container = document.createDocumentFragment();
    let lastIndex = 0;
    const backrefRegex = /\$\$|\$&|\$`|\$'|\$(\d{1,2})/g;

    let reMatch;
    while ((reMatch = backrefRegex.exec(pattern)) !== null) {
        // Part of the pattern before the back-reference is a literal.
        const literalPart = pattern.substring(lastIndex, reMatch.index);
        if (literalPart) {
            const mark = document.createElement('mark');
            mark.className = 'green_hl';
            mark.innerText = literalPart;
            container.appendChild(mark);
        }

        const backref = reMatch[0];
        if (backref === '$$') {
            container.appendChild(document.createTextNode('$'));
        } else if (backref === '$&') {
            const mark = document.createElement('mark');
            mark.className = 'yellow_hl';
            mark.innerText = match[0];
            container.appendChild(mark);
        } else if (backref === '$`') {
            container.appendChild(document.createTextNode(match.input.substring(0, match.index)));
        } else if (backref === '$\'') {
            container.appendChild(document.createTextNode(match.input.substring(match.index + match[0].length)));
        } else { // It's a numbered capture group, $n.
            const groupIndex = parseInt(reMatch[1], 10);
            if (groupIndex > 0 && groupIndex < match.length && match[groupIndex] !== undefined) {
                const mark = document.createElement('mark');
                mark.className = 'yellow_hl';
                mark.innerText = match[groupIndex];
                container.appendChild(mark);
            } else {
                // Not a valid group index, treat it as a literal.
                const mark = document.createElement('mark');
                mark.className = 'green_hl';
                mark.innerText = backref;
                container.appendChild(mark);
            }
        }
        lastIndex = backrefRegex.lastIndex;
    }

    // The final part of the pattern after the last back-reference.
    const finalLiteralPart = pattern.substring(lastIndex);
    if (finalLiteralPart) {
        const mark = document.createElement('mark');
        mark.className = 'green_hl';
        mark.innerText = finalLiteralPart;
        container.appendChild(mark);
    }

    // To get the HTML content, we need a temporary parent element.
    const tempDiv = document.createElement('div');
    tempDiv.appendChild(container);
    return tempDiv.innerHTML;
}

function executeRegexScriptForDebugging(script, text) {
    let err;
    let originalRegex;

    try {
        originalRegex = regexFromString(script.findRegex);
        if (!originalRegex) throw new Error('Invalid regex string');
    } catch (e) {
        err = `Compile error: ${e.message}`;
        return { output: text, highlightedOutput: text, error: err, charsCaptured: 0, charsAdded: 0, charsRemoved: 0 };
    }

    const globalRegex = new RegExp(originalRegex.source, originalRegex.flags.includes('g') ? originalRegex.flags : originalRegex.flags + 'g');
    const matches = [...text.matchAll(globalRegex)];

    if (matches.length === 0) {
        return { output: text, highlightedOutput: escapeHtml(text), error: null, charsCaptured: 0, charsAdded: 0, charsRemoved: 0 };
    }

    let outputText = '';
    let highlightedOutput = ''; // This will now be our "diff view"
    let lastIndex = 0;
    let totalCharsCaptured = 0;
    let totalCharsAdded = 0;
    let totalCharsRemoved = 0;

    try {
        for (const match of matches) {
            const originalMatchText = match[0];
            totalCharsCaptured += originalMatchText.length;

            // Append text between matches (this part is unchanged)
            const precedingText = text.substring(lastIndex, match.index);
            outputText += precedingText;
            highlightedOutput += escapeHtml(precedingText);

            // --- Start of new diff and statistics logic ---
            let charsAddedInMatch = 0;
            let charsKeptFromMatch = 0;
            const backrefRegex = /\$\$|\$&|\$`|\$'|\$(\d{1,2})/g;
            let lastPatternIndex = 0;
            let reMatch;
            let replacementForPlainText = '';

            // This loop calculates the stats accurately
            while ((reMatch = backrefRegex.exec(script.replaceString)) !== null) {
                const literalPart = script.replaceString.substring(lastPatternIndex, reMatch.index);
                charsAddedInMatch += literalPart.length;
                replacementForPlainText += literalPart;
                const backref = reMatch[0];
                if (backref === '$$') {
                    replacementForPlainText += '$';
                } else if (backref === '$&') {
                    charsKeptFromMatch += (match[0] || '').length; replacementForPlainText += (match[0] || '');
                } else if (backref === '$`') {
                    const part = match.input.substring(0, match.index); charsKeptFromMatch += part.length; replacementForPlainText += part;
                } else if (backref === '$\'') {
                    const part = match.input.substring(match.index + match[0].length); charsKeptFromMatch += part.length; replacementForPlainText += part;
                } else {
                    const groupIndex = parseInt(reMatch[1], 10);
                    if (groupIndex > 0 && groupIndex < match.length && match[groupIndex] !== undefined) {
                        charsKeptFromMatch += match[groupIndex].length;
                        replacementForPlainText += match[groupIndex];
                    }
                }
                lastPatternIndex = backrefRegex.lastIndex;
            }
            const finalLiteralPart = script.replaceString.substring(lastPatternIndex);
            charsAddedInMatch += finalLiteralPart.length;
            replacementForPlainText += finalLiteralPart;

            totalCharsAdded += charsAddedInMatch;
            totalCharsRemoved += (originalMatchText.length - charsKeptFromMatch);

            outputText += replacementForPlainText;
            // --- End of statistics logic ---

            // --- Build the new Diff View HTML ---
            // 1. Show the entire original match as "removed" (red strikethrough)
            highlightedOutput += `<mark class='red_hl'>${escapeHtml(originalMatchText)}</mark>`;
            // 2. Add an arrow to signify transformation
            highlightedOutput += ' → ';
            // 3. Build the replacement string with green (added) and yellow (kept) parts
            highlightedOutput += buildReplacementHtml(match, script.replaceString);

            lastIndex = match.index + originalMatchText.length;
        }

        // Append text after the last match
        const trailingText = text.substring(lastIndex);
        outputText += trailingText;
        highlightedOutput += escapeHtml(trailingText);
    } catch (e) {
        err = (err ? err + '; ' : '') + `Replace error: ${e.message}`;
        outputText = text; // Fallback
        highlightedOutput = escapeHtml(text);
    }

    return {
        output: outputText,
        highlightedOutput: highlightedOutput,
        error: err,
        charsCaptured: totalCharsCaptured,
        charsAdded: totalCharsAdded,
        charsRemoved: totalCharsRemoved,
    };
}

function populateDebuggerRuleList(container, targets = {}) {
    const rulesContainer = container.find('#regex_debugger_rules');
    const ruleTemplate = container.find('#regex_debugger_rule_template');
    if (!rulesContainer.length || !ruleTemplate.length) {
        console.error('Regex Debugger: Could not find rule list or template in the DOM.');
        return;
    }

    rulesContainer.empty();

    const hasScopedTarget = Object.prototype.hasOwnProperty.call(targets, 'scopedTarget');
    const hasPresetTarget = Object.prototype.hasOwnProperty.call(targets, 'presetTarget');
    const scopedTarget = hasScopedTarget ? targets.scopedTarget : null;
    const presetTarget = hasPresetTarget ? targets.presetTarget : null;

    const globalScripts = getScriptsByType(SCRIPT_TYPES.GLOBAL).map(script => {
        const scriptCopy = structuredClone(script);
        // @ts-ignore
        scriptCopy.type = SCRIPT_TYPES.GLOBAL;
        return scriptCopy;
    });
    const presetScripts = (hasPresetTarget
        ? (presetTarget?.presetName ? getScriptsByType(SCRIPT_TYPES.PRESET, { target: presetTarget }) : [])
        : getScriptsByType(SCRIPT_TYPES.PRESET)
    ).map(script => {
        const scriptCopy = structuredClone(script);
        // @ts-ignore
        scriptCopy.type = SCRIPT_TYPES.PRESET;
        return scriptCopy;
    });
    const scopedScripts = (hasScopedTarget
        ? (scopedTarget?.character ? getScriptsByType(SCRIPT_TYPES.SCOPED, { target: scopedTarget }) : [])
        : getScriptsByType(SCRIPT_TYPES.SCOPED)
    ).map(script => {
        const scriptCopy = structuredClone(script);
        // @ts-ignore
        scriptCopy.type = SCRIPT_TYPES.SCOPED;
        return scriptCopy;
    });
    const pluginScripts = getRuntimeRegexScripts().map(script => {
        const scriptCopy = structuredClone(script);
        // @ts-ignore
        scriptCopy.type = SCRIPT_TYPE_UNKNOWN;
        return scriptCopy;
    });

    const allScripts = [...globalScripts, ...presetScripts, ...scopedScripts, ...pluginScripts];
    if (allScripts.length === 0) {
        rulesContainer.append('<div class="regex-debugger-no-rules">' + t`No regex rules found.` + '</div>');
        return;
    }

    container.data('allScripts', allScripts);

    const renderRule = (script) => {
        if (!script.id) script.id = uuidv4();
        const ruleElementContent = $(ruleTemplate.prop('content')).clone();
        const ruleElement = ruleElementContent.find('.regex-debugger-rule');

        ruleElement.attr('data-id', script.id);
        // @ts-ignore
        ruleElement.find('.rule-name').text(script.scriptName);
        ruleElement.find('.rule-regex').text(script.findRegex);
        // @ts-ignore
        ruleElement
            .find('.rule-scope')
            .text(
                {
                    [SCRIPT_TYPES.SCOPED]: t`Scoped`,
                    [SCRIPT_TYPES.GLOBAL]: t`Global`,
                    [SCRIPT_TYPES.PRESET]: t`Preset`,
                    [SCRIPT_TYPE_UNKNOWN]: t`Plugin`,
                }[script.type],
            );
        ruleElement.find('.rule-enabled').prop('checked', !script.disabled);
        // @ts-ignore
        ruleElement.find('.edit_rule').on('click', () => onRegexEditorOpenClick(script.id, script.type));

        ruleElement.on('click', function (event) {
            if ($(event.target).is('input, .menu_button, .menu_button i')) {
                return;
            }
            const scriptId = $(this).data('id');
            const stepElement = $(`#step-result-${scriptId}`);
            const container = $('#regex_debugger_steps_output');

            if (stepElement.length && container.length) {
                // Replace scrollIntoView with scrollTop animation
                const targetTop = stepElement.position().top;
                const containerScrollTop = container.scrollTop();
                const containerHeight = container.height();

                // Center the element if possible
                let scrollTo = containerScrollTop + targetTop - (containerHeight / 2) + (stepElement.height() / 2);

                container.animate({ scrollTop: scrollTo }, 300); // 300ms smooth scroll

                stepElement.css('transition', 'background-color 0.5s').css('background-color', 'var(--highlight_color)');
                setTimeout(() => stepElement.css('background-color', ''), 1000);
            }
        });

        return ruleElementContent;
    };

    if (globalScripts.length > 0) {
        rulesContainer.append('<div class="list-header regex-debugger-list-header">' + t`Global Rules` + '</div>');
        const globalList = $('<ul id="regex_debugger_rules_global" class="sortable-list"></ul>');
        globalScripts.forEach(script => globalList.append(renderRule(script)));
        rulesContainer.append(globalList);
    }

    if (presetScripts.length > 0) {
        rulesContainer.append('<div class="list-header regex-debugger-list-header">' + t`Preset Rules` + '</div>');
        const presetList = $('<ul id="regex_debugger_rules_preset" class="sortable-list"></ul>');
        presetScripts.forEach(script => presetList.append(renderRule(script)));
        rulesContainer.append(presetList);
    }

    if (scopedScripts.length > 0) {
        rulesContainer.append('<div class="list-header regex-debugger-list-header">' + t`Scoped Rules` + '</div>');
        const scopedList = $('<ul id="regex_debugger_rules_scoped" class="sortable-list"></ul>');
        scopedScripts.forEach(script => scopedList.append(renderRule(script)));
        rulesContainer.append(scopedList);
    }

    if (pluginScripts.length > 0) {
        rulesContainer.append('<div class="list-header regex-debugger-list-header">' + t`Plugin Rules` + '</div>');
        const pluginList = $('<ul id="regex_debugger_rules_plugin" class="sortable-list"></ul>');
        pluginScripts.forEach(script => pluginList.append(renderRule(script)));
        rulesContainer.append(pluginList);
    }
}

/**
 * Opens the regex debugger.
 * @returns {Promise<void>}
 */
async function onRegexDebuggerOpenClick() {
    let debuggerScopedTarget = this_chid !== undefined ? captureRegexTarget(SCRIPT_TYPES.SCOPED) : null;
    let debuggerPresetTarget = captureRegexTarget(SCRIPT_TYPES.PRESET);
    const templateContent = await renderExtensionTemplateAsync('regex', 'debugger');
    const debuggerHtml = $('<div>').html(templateContent);

    const stepTemplate = debuggerHtml.find('#regex_debugger_step_template');

    populateDebuggerRuleList(debuggerHtml, {
        scopedTarget: debuggerScopedTarget,
        presetTarget: debuggerPresetTarget,
    });

    // @ts-ignore
    debuggerHtml.find('#regex_debugger_rules_global').sortable({ delay: getRegexSortableDelay() }).disableSelection();
    // @ts-ignore
    debuggerHtml.find('#regex_debugger_rules_scoped').sortable({ delay: getRegexSortableDelay() }).disableSelection();
    // @ts-ignore
    debuggerHtml.find('#regex_debugger_rules_preset').sortable({ delay: getRegexSortableDelay() }).disableSelection();

    debuggerHtml.find('#regex_debugger_run_test').on('click', function () {
        const allScripts = debuggerHtml.data('allScripts');
        const orderedRuleIds = [
            ...$('#regex_debugger_rules_global').find('li.regex-debugger-rule').map((i, el) => $(el).data('id')).get(),
            ...$('#regex_debugger_rules_scoped').find('li.regex-debugger-rule').map((i, el) => $(el).data('id')).get(),
            ...$('#regex_debugger_rules_preset').find('li.regex-debugger-rule').map((i, el) => $(el).data('id')).get(),
            ...$('#regex_debugger_rules_plugin').find('li.regex-debugger-rule').map((i, el) => $(el).data('id')).get(),
        ];

        const rawInput = String($('#regex_debugger_raw_input').val());
        const stepsOutput = $('#regex_debugger_steps_output');
        const finalOutput = $('#regex_debugger_final_output');

        if (!stepsOutput.length || !finalOutput.length) return;

        const displayMode = $('input[name="display_mode"]:checked').val();
        stepsOutput.empty();
        finalOutput.empty();
        $('#regex_debugger_final_summary').remove();

        if (!allScripts) return;
        let textForNextStep = rawInput;
        let totalCharsCaptured = 0;
        let totalCharsAdded = 0;
        let totalCharsRemoved = 0;

        orderedRuleIds.forEach(scriptId => {
            const ruleElement = $(`#regex_debugger_rules [data-id="${scriptId}"]`);
            if (!ruleElement.find('.rule-enabled').is(':checked')) return;

            const script = allScripts.find(s => s.id === scriptId);

            if (script) {
                const result = executeRegexScriptForDebugging(script, textForNextStep);
                totalCharsCaptured += result.charsCaptured;
                totalCharsAdded += result.charsAdded;
                totalCharsRemoved += result.charsRemoved;

                const stepElement = $(stepTemplate.prop('content')).clone();
                // Set the ID on the TOP-LEVEL element that is being appended.
                stepElement.find('>:first-child').attr('id', `step-result-${script.id}`);
                const stepHeader = stepElement.find('.step-header');
                stepHeader.find('strong').text(t`After:` + ` ${script.scriptName}`);

                const metricsHtml = '<span class="step-metrics">' + t`Captured:` + ` ${result.charsCaptured}, ` + t`Added:` + ` +${result.charsAdded}, ` + t`Removed:` + ` -${result.charsRemoved}</span>`;
                stepHeader.append(metricsHtml);

                if (displayMode === 'highlight') {
                    stepElement.find('.step-output').html(result.highlightedOutput);
                } else {
                    stepElement.find('.step-output').text(result.output);
                }

                if (result.error) {
                    stepHeader.append($(`<div class='warning_text text_rose-500'>${result.error}</div>`));
                }

                stepsOutput.append(stepElement);
                textForNextStep = result.output;
            }
        });

        const summaryHtml = `
            <div id="regex_debugger_final_summary" class="regex-debugger-summary">
                <strong>` + t`Total Captured:` + `</strong> ${totalCharsCaptured} | <strong>` + t`Total Added:` + `</strong> +${totalCharsAdded} | <strong>` + t`Total Removed:` + `</strong> -${totalCharsRemoved}
            </div>
        `;
        finalOutput.before(summaryHtml);

        const renderMode = $('#regex_debugger_render_mode').val();
        if (renderMode === 'message') {
            const formattedHtml = messageFormatting(textForNextStep, 'Debugger', true, false, null);
            const messageBlock = $('<div class="mes"><div class="mes_text"></div></div>');
            messageBlock.find('.mes_text').html(formattedHtml);
            finalOutput.append(messageBlock);
        } else {
            finalOutput.text(textForNextStep);
        }
    });

    debuggerHtml.find('#regex_debugger_save_order').on('click', async function () {
        const mergeOrderedScripts = (orderedIds, liveScripts) => {
            const byId = new Map(liveScripts.map(script => [String(script?.id || ''), script]));
            const seen = new Set();
            const merged = [];
            for (const id of orderedIds) {
                const key = String(id || '');
                if (!key || seen.has(key) || !byId.has(key)) continue;
                seen.add(key);
                merged.push(byId.get(key));
            }
            for (const script of liveScripts) {
                const key = String(script?.id || '');
                if (!seen.has(key)) {
                    merged.push(script);
                }
            }
            return merged;
        };

        const globalIds = $('#regex_debugger_rules_global').children('li').map((_, el) => $(el).data('id')).get();
        const scopedIds = $('#regex_debugger_rules_scoped').children('li').map((_, el) => $(el).data('id')).get();
        const presetIds = $('#regex_debugger_rules_preset').children('li').map((_, el) => $(el).data('id')).get();

        const newGlobalScripts = mergeOrderedScripts(globalIds, getScriptsByType(SCRIPT_TYPES.GLOBAL));
        const newPresetScripts = debuggerPresetTarget?.presetName
            ? mergeOrderedScripts(presetIds, getScriptsByType(SCRIPT_TYPES.PRESET, { target: debuggerPresetTarget }))
            : [];

        let failed = false;
        let succeeded = false;
        let globalSavedImmediately = false;

        if ($('#regex_debugger_rules_global').length) {
            try {
                await saveScriptsByType(newGlobalScripts, SCRIPT_TYPES.GLOBAL, {
                    persistGlobal: () => saveSettingsNow(),
                });
                succeeded = true;
                globalSavedImmediately = true;
            } catch (error) {
                failed = true;
                console.error('[Regex] Failed to save global regex order from debugger', error);
            }
        }
        if (debuggerScopedTarget?.character && $('#regex_debugger_rules_scoped').length) {
            try {
                await updateScopedRegexScripts(
                    currentScripts => mergeOrderedScripts(scopedIds, currentScripts),
                    debuggerScopedTarget,
                );
                succeeded = true;
            } catch (error) {
                failed = true;
                console.error('[Regex] Failed to save scoped regex order from debugger', error);
            }
        }
        if (debuggerPresetTarget?.presetName && $('#regex_debugger_rules_preset').length) {
            try {
                await saveScriptsByType(newPresetScripts, SCRIPT_TYPES.PRESET, { target: debuggerPresetTarget });
                succeeded = true;
            } catch (error) {
                failed = true;
                console.error('[Regex] Failed to save preset regex order from debugger', error);
            }
        }

        if (succeeded && !globalSavedImmediately) {
            saveSettingsDebounced();
        }
        await loadRegexScripts();
        if (failed) {
            toastr.error(succeeded ? t`Some regex script changes could not be saved.` : t`Could not save regex script order.`);
        } else {
            toastr.success(t`Regex script order saved!`);
        }

        const currentPopupContent = $('div:has(> #regex_debugger_rules)');
        debuggerScopedTarget = this_chid !== undefined ? captureRegexTarget(SCRIPT_TYPES.SCOPED) : null;
        debuggerPresetTarget = captureRegexTarget(SCRIPT_TYPES.PRESET);
        populateDebuggerRuleList(currentPopupContent, {
            scopedTarget: debuggerScopedTarget,
            presetTarget: debuggerPresetTarget,
        });
        // @ts-ignore
        currentPopupContent.find('#regex_debugger_rules_global').sortable({ delay: getRegexSortableDelay() }).disableSelection();
        // @ts-ignore
        currentPopupContent.find('#regex_debugger_rules_scoped').sortable({ delay: getRegexSortableDelay() }).disableSelection();
        // @ts-ignore
        currentPopupContent.find('#regex_debugger_rules_preset').sortable({ delay: getRegexSortableDelay() }).disableSelection();
    });

    debuggerHtml.find('#regex_debugger_expand_steps').on('click', function () {
        const popupContainer = $('<div class="expanded-regex-container"></div>');
        const navPanel = $('<div class="expanded-regex-nav"><h4>Steps</h4></div>');
        const contentPanel = $('<div class="expanded-regex-content"></div>');

        const content = $('#regex_debugger_steps_output').clone().html();
        contentPanel.html(content);

        $('#regex_debugger_rules .regex-debugger-rule').each(function () {
            const ruleElement = $(this);
            const scriptId = ruleElement.data('id');
            const scriptName = ruleElement.find('.rule-name').text();

            const link = $(`<a href="#">${escapeHtml(scriptName)}</a>`);
            link.data('target-id', `step-result-${scriptId}`);

            link.on('click', function (e) {
                e.preventDefault();
                navPanel.find('a').removeClass('active');
                $(this).addClass('active');

                const targetId = $(this).data('target-id');
                // The selector is now correct for the structure.
                const targetElement = contentPanel.find(`#${targetId}`);

                if (targetElement.length) {
                    const scrollTo = contentPanel.scrollTop() + targetElement.position().top;
                    contentPanel.animate({ scrollTop: scrollTo }, 300);

                    targetElement.css('transition', 'background-color 0.5s').css('background-color', 'var(--highlight_color)');
                    setTimeout(() => targetElement.css('background-color', ''), 1000);
                }
            });

            navPanel.append(link);
        });

        popupContainer.append(navPanel).append(contentPanel);
        callGenericPopup(popupContainer, POPUP_TYPE.TEXT, t`Step-by-step Transformation`, { wide: true, allowVerticalScrolling: false });
    });

    debuggerHtml.find('#regex_debugger_expand_final').on('click', function () {
        const content = $('#regex_debugger_final_output').html();
        const popupContent = $('<div class="regex-popup-content"></div>').html(content);
        callGenericPopup(popupContent, POPUP_TYPE.TEXT, t`Final Output`, { wide: true, large: true, allowVerticalScrolling: true });
    });

    await callGenericPopup(debuggerHtml.children(), POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
}

/**
 * Updates the info block in the regex editor with hints regarding the find regex.
 * @param {JQuery<HTMLElement>} editorHtml The editor HTML
 */
function updateInfoBlock(editorHtml) {
    const infoBlock = editorHtml.find('.info-block').get(0);
    const infoBlockFlagsHint = editorHtml.find('#regex_info_block_flags_hint');
    const findRegex = String(editorHtml.find('.find_regex').val());

    infoBlockFlagsHint.hide();

    // Clear the info block if the find regex is empty
    if (!findRegex) {
        setInfoBlock(infoBlock, t`Find Regex is empty`, 'info');
        return;
    }

    try {
        const regex = regexFromString(findRegex);
        if (!regex) {
            throw new Error(t`Invalid Find Regex`);
        }

        const flagInfo = [];
        flagInfo.push(regex.flags.includes('g') ? t`Applies to all matches` : t`Applies to the first match`);
        flagInfo.push(regex.flags.includes('i') ? t`Case insensitive` : t`Case sensitive`);

        setInfoBlock(infoBlock, flagInfo.join('. '), 'hint');
        infoBlockFlagsHint.show();
    } catch (error) {
        setInfoBlock(infoBlock, error.message, 'error');
    }
}

// Common settings migration function. Some parts will eventually be removed
// TODO: Maybe migrate placement to strings?
function migrateSettings() {
    let performSave = false;

    // Current: If MD Display is present in placement, remove it and add new placements/MD option
    extension_settings.regex.forEach((script) => {
        if (!script.id) {
            script.id = uuidv4();
            performSave = true;
        }

        if (!Array.isArray(script.placement)) {
            script.placement = [];
            performSave = true;
        }

        if (script.placement.includes(regex_placement.MD_DISPLAY)) {
            script.placement = script.placement.length === 1 ?
                Object.values(regex_placement).filter((e) => e !== regex_placement.MD_DISPLAY) :
                script.placement = script.placement.filter((e) => e !== regex_placement.MD_DISPLAY);

            script.markdownOnly = true;
            script.promptOnly = true;

            performSave = true;
        }

        // Old system and sendas placement migration
        // 4 - sendAs
        if (script.placement.includes(4)) {
            script.placement = script.placement.length === 1 ?
                [regex_placement.SLASH_COMMAND] :
                script.placement = script.placement.filter((e) => e !== 4);

            performSave = true;
        }
    });

    if (performSave) {
        saveSettingsDebounced();
    }
}

/**
 * /regex slash command callback
 * @param {{name: string}} args Named arguments
 * @param {string} value Unnamed argument
 * @returns {string} The regexed string
 */
function runRegexCallback(args, value) {
    if (!args.name) {
        toastr.warning('No regex script name provided.');
        return value;
    }

    const scriptName = args.name;
    const scripts = getRegexScripts();

    for (const script of scripts) {
        if (script.scriptName.toLowerCase() === scriptName.toLowerCase()) {
            if (script.disabled) {
                toastr.warning(t`Regex script "${scriptName}" is disabled.`);
                return value;
            }

            console.debug(`Running regex callback for ${scriptName}`);
            return runRegexScript(script, value);
        }
    }

    toastr.warning(`Regex script "${scriptName}" not found.`);
    return value;
}

/**
 * /regex-toggle slash command callback
 * @param {{state: string, quiet: string}} args Named arguments
 * @param {string} scriptName The name of the script to toggle
 * @returns {Promise<string>} The name of the script
 */
async function toggleRegexCallback(args, scriptName) {
    if (typeof scriptName !== 'string') throw new Error('Script name must be a string.');

    const quiet = isTrueBoolean(args?.quiet);
    const action = isTrueBoolean(args?.state) ? 'enable' :
        isFalseBoolean(args?.state) ? 'disable' :
            'toggle';

    const scripts = getEditableRegexScripts();
    const script = scripts.find(s => equalsIgnoreCaseAndAccents(s.scriptName, scriptName));

    if (!script) {
        toastr.warning(t`Regex script '${scriptName}' not found.`);
        return '';
    }

    const updatedScript = structuredClone(script);
    switch (action) {
        case 'enable':
            updatedScript.disabled = false;
            break;
        case 'disable':
            updatedScript.disabled = true;
            break;
        default:
            updatedScript.disabled = !updatedScript.disabled;
            break;
    }

    const scriptType = getScriptType(script);
    const target = captureRegexTarget(scriptType);
    const index = getScriptsByType(scriptType, { target }).findIndex(s => s.id === script.id);

    try {
        await saveRegexScript(updatedScript, index, scriptType, true, { target, existingId: script.id });
    } catch (error) {
        console.error('[Regex] Failed to toggle regex script via slash command', {
            scriptName,
            scriptId: script.id,
            scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
            error,
        });
        toastr.error(t`Could not save regex script changes.`);
        return '';
    }
    if (updatedScript.disabled) {
        !quiet && toastr.success(t`Regex script '${scriptName}' has been disabled.`);
    } else {
        !quiet && toastr.success(t`Regex script '${scriptName}' has been enabled.`);
    }

    return updatedScript.scriptName || '';
}

/**
 * Performs the import of the regex object.
 * @param {RegexScript} regexScript Input object
 * @param {SCRIPT_TYPES} scriptType The type of script to import as
 * @param {{ target?: ReturnType<typeof captureRegexTarget> | null }} [options]
 */
async function onRegexImportObjectChange(regexScript, scriptType, options = {}) {
    if (!isRegexScriptRecord(regexScript) || !regexScript.scriptName) {
        console.error('[Regex] Invalid regex object rejected during import', { regexScript });
        toastr.error(t`Invalid regex object.`);
        return false;
    }

    const importedScript = structuredClone(regexScript);
    let normalizedPlacement = false;
    if (!Array.isArray(importedScript.placement)) {
        importedScript.placement = [];
        normalizedPlacement = true;
    }

    // Assign a new UUID
    importedScript.id = uuidv4();
    const target = options?.target || captureRegexTarget(scriptType);

    try {
        switch (scriptType) {
            case SCRIPT_TYPES.GLOBAL: {
                const nextGlobal = [...getScriptsByType(SCRIPT_TYPES.GLOBAL), importedScript];
                await saveScriptsByType(nextGlobal, SCRIPT_TYPES.GLOBAL);
                break;
            }
            case SCRIPT_TYPES.SCOPED:
                await updateScopedRegexScripts(currentScripts => [...currentScripts, importedScript], target);
                break;
            case SCRIPT_TYPES.PRESET: {
                const nextPreset = [...getScriptsByType(SCRIPT_TYPES.PRESET, { target }), importedScript];
                await saveScriptsByType(nextPreset, SCRIPT_TYPES.PRESET, { target });
                break;
            }
            default:
                throw new Error(`Unsupported regex import target: ${scriptType}`);
        }
    } catch (error) {
        console.error('[Regex] Failed to persist imported regex script', {
            scriptName: importedScript.scriptName,
            scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
            error,
        });
        toastr.error(t`Could not import regex script because saving failed.`);
        await loadRegexScripts();
        return false;
    }

    if (normalizedPlacement) {
        toastr.warning(t`Imported regex script has invalid "Affects" settings and was normalized. Please review it.`);
    }
    saveSettingsDebounced();
    await loadRegexScripts();
    toastr.success(t`Regex script "${importedScript.scriptName}" imported.`);
    return true;
}

/**
 * Performs the import of the regex file.
 * @param {File} file Input file
 * @param {SCRIPT_TYPES} scriptType The type of script to import as
 * @param {{ target?: ReturnType<typeof captureRegexTarget> | null }} [options]
 */
async function onRegexImportFileChange(file, scriptType, options = {}) {
    if (!file) {
        toastr.error('No file provided.');
        return;
    }

    let regexScripts;
    try {
        regexScripts = JSON.parse(await getFileText(file));
    } catch (error) {
        console.log(error);
        toastr.error('Invalid JSON file.');
        return;
    }

    if (Array.isArray(regexScripts)) {
        for (const regexScript of regexScripts) {
            await onRegexImportObjectChange(regexScript, scriptType, options);
        }
    } else {
        await onRegexImportObjectChange(regexScripts, scriptType, options);
    }
}

/**
 * Determines the type of a given script.
 * @param {RegexScript} script The script to check
 * @returns {SCRIPT_TYPES} The script type.
 */
function getScriptType(script) {
    for (const scriptType of Object.values(SCRIPT_TYPES)) {
        const scripts = getScriptsByType(scriptType);
        if (scripts.some(s => s.id === script.id)) {
            return scriptType;
        }
    }
    return SCRIPT_TYPE_UNKNOWN;
}

function getEditableRegexScripts() {
    return [
        ...getScriptsByType(SCRIPT_TYPES.GLOBAL),
        ...getScriptsByType(SCRIPT_TYPES.SCOPED),
        ...getScriptsByType(SCRIPT_TYPES.PRESET),
    ];
}

function getSelectedScripts() {
    const scripts = getEditableRegexScripts();
    const selector = '#regex_container .regex-script-label:has(.regex_bulk_checkbox:checked)';
    const selectedIds = Array.from(document.querySelectorAll(selector))
        .map(e => e.getAttribute('id'))
        .filter(id => id);
    return scripts.filter(script => selectedIds.includes(script.id));
}

function purgeEmbeddedRegexScripts({ character }) {
    const avatar = character?.avatar;
    if (!avatar) {
        return;
    }
    const checkKey = `AlertRegex_${avatar}`;
    if (accountStorage.getItem(checkKey)) {
        accountStorage.removeItem(checkKey);
    }
    disallowScopedScripts(characters?.[this_chid]);
}

function purgePresetEmbeddedRegexScripts({ apiId, name }) {
    const checkKey = `AlertRegex_${apiId}_${name}`;
    if (accountStorage.getItem(checkKey)) {
        accountStorage.removeItem(checkKey);
    }
    disallowPresetScripts(apiId, name);
}

async function checkCharEmbeddedRegexScripts() {
    const chid = this_chid;

    if (chid !== undefined && !selected_group) {
        const character = characters[chid];
        const scripts = getScriptsByType(SCRIPT_TYPES.SCOPED);

        if (Array.isArray(scripts) && scripts.length > 0) {
            if (!isScopedScriptsAllowed(character)) {
                const checkKey = `AlertRegex_${character.avatar}`;
                if (!accountStorage.getItem(checkKey)) {
                    accountStorage.setItem(checkKey, 'true');
                    const template = await renderExtensionTemplateAsync('regex', 'embeddedScripts', {});
                    const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '');

                    if (result) {
                        allowScopedScripts(character);
                        await requestRegexChatReload();
                    }
                }
            }
        }
    }

    // Clear cache and reload scripts
    RegexProvider.instance.clear();
    await loadRegexScripts();
}

/**
 * Notify whether to reload current chat when preset is changed
 * @param {string} presetName The name of the preset
 */
function notifyReloadCurrentChat(presetName) {
    toastr.info(
        t`Reload the chat for regex to take effect` + '<br><u>' + t`Click here to reload immediately` + '</u>',
        t`Preset '${escapeHtml(presetName)}' contains enabled regex scripts`,
        {
            timeOut: 5000,
            escapeHtml: false,
            onclick: reloadCurrentChat,
        });
}

function getRegexPlacementPreviewLabel(placement) {
    switch (Number(placement)) {
        case regex_placement.MD_DISPLAY:
            return t`Markdown Display`;
        case regex_placement.USER_INPUT:
            return t`User Input`;
        case regex_placement.AI_OUTPUT:
            return t`AI Output`;
        case regex_placement.SLASH_COMMAND:
            return t`Slash Commands`;
        case regex_placement.WORLD_INFO:
            return t`World Info`;
        case regex_placement.REASONING:
            return t`Reasoning`;
        default:
            return String(placement);
    }
}

function getSubstituteRegexPreviewLabel(value) {
    switch (Number(value)) {
        case substitute_find_regex.RAW:
            return t`Raw`;
        case substitute_find_regex.ESCAPED:
            return t`Escaped`;
        case substitute_find_regex.NONE:
        default:
            return t`None`;
    }
}

function getDepthPreviewLabel(value) {
    if (value === null || value === undefined || value === '' || Number(value) === -1) {
        return t`Unlimited`;
    }

    return String(value);
}

function clonePresetEmbeddedRegexScripts(scripts) {
    return Array.isArray(scripts)
        ? scripts.filter(isRegexScriptRecord).map(script => structuredClone(script))
        : [];
}

function getPresetEmbeddedRegexSignature(script) {
    return JSON.stringify({
        scriptName: String(script?.scriptName ?? ''),
        findRegex: String(script?.findRegex ?? ''),
        replaceString: String(script?.replaceString ?? ''),
        trimStrings: Array.isArray(script?.trimStrings) ? script.trimStrings.map(String) : [],
        placement: Array.isArray(script?.placement) ? script.placement.map(Number) : [],
        disabled: Boolean(script?.disabled),
        markdownOnly: Boolean(script?.markdownOnly),
        promptOnly: Boolean(script?.promptOnly),
        pluginLanes: getPluginLanes(script).slice().sort(),
        runOnEdit: Boolean(script?.runOnEdit),
        substituteRegex: Number(script?.substituteRegex ?? substitute_find_regex.NONE),
        minDepth: script?.minDepth ?? null,
        maxDepth: script?.maxDepth ?? null,
    });
}

function getPresetEmbeddedRegexDuplicateIndexes(scripts, existingScripts) {
    const existingSignatures = new Set(clonePresetEmbeddedRegexScripts(existingScripts).map(getPresetEmbeddedRegexSignature));
    const duplicateIndexes = new Set();
    clonePresetEmbeddedRegexScripts(scripts).forEach((script, index) => {
        if (existingSignatures.has(getPresetEmbeddedRegexSignature(script))) {
            duplicateIndexes.add(index);
        }
    });
    return duplicateIndexes;
}

function getUniquePresetEmbeddedRegexScripts(scripts, existingScripts) {
    const usedIds = new Set(clonePresetEmbeddedRegexScripts(existingScripts).map(script => String(script.id || '').trim()).filter(Boolean));
    return clonePresetEmbeddedRegexScripts(scripts).map(script => {
        const scriptId = String(script.id || '').trim();
        if (!scriptId || usedIds.has(scriptId)) {
            script.id = uuidv4();
        }
        usedIds.add(String(script.id || '').trim());
        return script;
    });
}

async function getPresetEmbeddedRegexSourceScripts(presetManager, presetName, fallbackScripts = []) {
    const storedSource = presetManager?.readPresetExtensionField({ name: presetName, path: PRESET_EMBEDDED_REGEX_SOURCE_PATH });
    if (Array.isArray(storedSource) && storedSource.length > 0) {
        return clonePresetEmbeddedRegexScripts(storedSource);
    }

    const fallbackSource = clonePresetEmbeddedRegexScripts(fallbackScripts);
    if (presetManager && fallbackSource.length > 0) {
        await presetManager.writePresetExtensionField({
            name: presetName,
            path: PRESET_EMBEDDED_REGEX_SOURCE_PATH,
            value: fallbackSource,
        });
    }
    return fallbackSource;
}

function getPresetEmbeddedRegexPreviewData(scripts, presetName, { defaultSelected = true, existingScripts = [] } = {}) {
    const duplicateIndexes = getPresetEmbeddedRegexDuplicateIndexes(scripts, existingScripts);
    const previewScripts = scripts.map((script, index) => {
        const trimStrings = Array.isArray(script.trimStrings) ? script.trimStrings.join('\n') : '';
        const placement = Array.isArray(script.placement) && script.placement.length > 0
            ? script.placement.map(getRegexPlacementPreviewLabel).join(', ')
            : t`None`;
        const flags = [
            script.markdownOnly ? t`Only Format Display` : '',
            script.promptOnly ? t`Only Format Prompt` : '',
            ...getPluginLanes(script).map(lane => lane === 'request' ? t`Plugin Requests` : t`Plugin Replies`),
            script.runOnEdit ? t`Run on Edit` : '',
        ].filter(Boolean);

        return {
            index,
            number: index + 1,
            scriptName: String(script.scriptName || t`Unnamed regex script`),
            statusLabel: script.disabled ? t`Disabled` : t`Enabled`,
            disabled: Boolean(script.disabled),
            selected: Boolean(defaultSelected),
            duplicate: duplicateIndexes.has(index),
            duplicateLabel: t`Already exists`,
            findRegex: String(script.findRegex ?? ''),
            replaceString: String(script.replaceString ?? ''),
            trimStrings,
            hasTrimStrings: trimStrings.length > 0,
            placement,
            substituteRegex: getSubstituteRegexPreviewLabel(script.substituteRegex),
            minDepth: getDepthPreviewLabel(script.minDepth),
            maxDepth: getDepthPreviewLabel(script.maxDepth),
            flags,
            hasFlags: flags.length > 0,
        };
    });

    return {
        presetName: String(presetName || t`Unknown preset`),
        scriptCount: previewScripts.length,
        enabledScriptCount: previewScripts.filter(script => !script.disabled).length,
        selectedScriptCount: previewScripts.filter(script => script.selected).length,
        hasDuplicateScripts: previewScripts.some(script => script.duplicate),
        scripts: previewScripts,
    };
}

function getSelectedPresetEmbeddedRegexIndexes(template) {
    return template
        .find('.regex-preset-embedded-preview__select:checked')
        .map(function () { return Number($(this).data('regexPreviewIndex')); })
        .get()
        .filter(index => Number.isInteger(index));
}

function bindPresetEmbeddedRegexPreviewControls(template) {
    const updateSelectedCount = () => {
        const selectedCount = getSelectedPresetEmbeddedRegexIndexes(template).length;
        template.find('[data-regex-preview-selected-count]').text(String(selectedCount));
    };

    template.find('.regex-preset-embedded-preview__select').on('click', event => event.stopPropagation());
    template.find('.regex-preset-embedded-preview__select').on('input', updateSelectedCount);
    template.find('[data-regex-preview-select-all]').on('click', () => {
        template.find('.regex-preset-embedded-preview__select').prop('checked', true);
        updateSelectedCount();
    });
    template.find('[data-regex-preview-clear-selection]').on('click', () => {
        template.find('.regex-preset-embedded-preview__select').prop('checked', false);
        updateSelectedCount();
    });
    updateSelectedCount();
}

function getSelectedPresetEmbeddedRegexScripts(template, scripts) {
    const selectedIndexes = getSelectedPresetEmbeddedRegexIndexes(template);
    return selectedIndexes
        .map(index => scripts[index])
        .filter(isRegexScriptRecord);
}

async function showPresetEmbeddedRegexImportPopup(scripts, presetName, {
    defaultSelected = true,
    existingScripts = [],
    okButton = t`Import Selected`,
    cancelButton = t`Cancel`,
    checkDuplicates = false,
} = {}) {
    const sourceScripts = clonePresetEmbeddedRegexScripts(scripts);
    const duplicateIndexes = getPresetEmbeddedRegexDuplicateIndexes(sourceScripts, existingScripts);
    const previewData = getPresetEmbeddedRegexPreviewData(sourceScripts, presetName, { defaultSelected, existingScripts });
    const template = $(await renderExtensionTemplateAsync('regex', 'presetEmbeddedScripts', previewData));
    let duplicateConfirmed = false;

    bindPresetEmbeddedRegexPreviewControls(template);

    const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', {
        okButton,
        cancelButton,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        onClosing: async (popup) => {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }

            const selectedIndexes = getSelectedPresetEmbeddedRegexIndexes(template);
            if (selectedIndexes.length === 0) {
                toastr.warning(t`Select at least one regex script to import.`);
                return false;
            }

            const selectedDuplicateIndexes = selectedIndexes.filter(index => duplicateIndexes.has(index));
            if (!checkDuplicates || selectedDuplicateIndexes.length === 0 || duplicateConfirmed) {
                return true;
            }

            const duplicateList = selectedDuplicateIndexes
                .map(index => `<li>${escapeHtml(String(sourceScripts[index]?.scriptName || t`Unnamed regex script`))}</li>`)
                .join('');
            const confirm = await callGenericPopup(
                `<div>${t`The following selected regex scripts already exist in this preset:`}</div><ul>${duplicateList}</ul><div>${t`Import them again anyway?`}</div>`,
                POPUP_TYPE.CONFIRM,
                '',
                {
                    okButton: t`Import Anyway`,
                    cancelButton: t`Review`,
                    wide: true,
                    leftAlign: true,
                },
            );

            duplicateConfirmed = confirm === POPUP_RESULT.AFFIRMATIVE;
            return duplicateConfirmed;
        },
    });

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }

    return getSelectedPresetEmbeddedRegexScripts(template, sourceScripts);
}

export async function reimportPresetEmbeddedRegexScripts(apiId = getCurrentPresetAPI()) {
    const presetManager = getPresetManager(apiId);
    if (!presetManager) {
        console.warn(`Preset Manager not found for API: ${apiId}`);
        return false;
    }

    const presetName = String(presetManager.getSelectedPresetName() || '').trim();
    if (!presetName) {
        toastr.warning(t`No preset selected.`);
        return false;
    }

    const currentScripts = clonePresetEmbeddedRegexScripts(presetManager.readPresetExtensionField({ name: presetName, path: 'regex_scripts' }));
    const sourceScripts = await getPresetEmbeddedRegexSourceScripts(presetManager, presetName, currentScripts);
    if (sourceScripts.length === 0) {
        toastr.warning(t`This preset does not have embedded regex scripts to import.`);
        return false;
    }

    const selectedScripts = await showPresetEmbeddedRegexImportPopup(sourceScripts, presetName, {
        defaultSelected: false,
        existingScripts: currentScripts,
        okButton: t`Import Selected`,
        cancelButton: t`Cancel`,
        checkDuplicates: true,
    });

    if (!selectedScripts) {
        return false;
    }

    const importedScripts = getUniquePresetEmbeddedRegexScripts(selectedScripts, currentScripts);
    await presetManager.writePresetExtensionField({
        name: presetName,
        path: 'regex_scripts',
        value: [...currentScripts, ...importedScripts],
    });
    allowPresetScripts(apiId, presetName);
    await loadRegexScripts();
    if (getCurrentChatId()) {
        await requestRegexChatReload();
    }
    toastr.success(t`Preset regex scripts imported.`);
    return true;
}

async function checkPresetEmbeddedRegexScripts(event = {}) {
    const apiId = getCurrentPresetAPI();
    const name = getCurrentPresetName();
    const eventApiId = String(event?.apiId || '').trim();
    const eventName = String(event?.name || '').trim();

    if (eventApiId) {
        if (!apiId || !equalsIgnoreCaseAndAccents(eventApiId, apiId)) {
            return;
        }
    }

    if (eventName) {
        if (!name || !equalsIgnoreCaseAndAccents(eventName, name)) {
            return;
        }
    }

    const scripts = getScriptsByType(SCRIPT_TYPES.PRESET);

    if (Array.isArray(scripts) && scripts.length > 0) {
        if (!isPresetScriptsAllowed(apiId, name)) {
            const checkKey = `AlertRegex_${apiId}_${name}`;

            if (!accountStorage.getItem(checkKey)) {
                accountStorage.setItem(checkKey, 'true');
                const presetManager = getPresetManager(apiId);
                if (!presetManager) {
                    return;
                }

                // Use the in-memory scripts directly for the popup to avoid blocking on a
                // preset+settings roundtrip before showing the UI. The persistent source
                // snapshot (used by the "reimport" button) is written after the popup closes.
                const sourceScripts = clonePresetEmbeddedRegexScripts(scripts);
                const selectedScripts = await showPresetEmbeddedRegexImportPopup(sourceScripts, name, {
                    defaultSelected: true,
                    okButton: t`Import Selected`,
                    cancelButton: t`Cancel`,
                });

                // Persist the immutable source snapshot regardless of the popup outcome
                // (including cancel) so the reimport button can offer the original bundle
                // later. Skip the write if a snapshot is already stored to avoid churn.
                const storedSource = presetManager.readPresetExtensionField({ name, path: PRESET_EMBEDDED_REGEX_SOURCE_PATH });
                if ((!Array.isArray(storedSource) || storedSource.length === 0) && sourceScripts.length > 0) {
                    await presetManager.writePresetExtensionField({
                        name,
                        path: PRESET_EMBEDDED_REGEX_SOURCE_PATH,
                        value: sourceScripts,
                    });
                }

                if (selectedScripts) {
                    await presetManager.writePresetExtensionField({ name, path: 'regex_scripts', value: selectedScripts });
                    allowPresetScripts(apiId, name);
                    if (getCurrentChatId()) {
                        await requestRegexChatReload();
                    }
                } else {
                    await presetManager.writePresetExtensionField({ name, path: 'regex_scripts', value: [] });
                }
            }
        } else if (getCurrentChatId() && scripts.filter(script => !script.disabled).length > 0) {
            notifyReloadCurrentChat(name);
        }
    }

    await loadRegexScripts();
}

async function onMainApiChanged({ apiId }) {
    const presetManager = getPresetManager(apiId);
    if (!presetManager) {
        return;
    }
    // Preset regex scripts follow the active preset, not the active API. An API
    // switch does not switch the preset, so the reload prompt must not be raised
    // here. Actual preset switches are reported by PRESET_CHANGED.
    await loadRegexScripts();
}

function onPresetRenamed({ apiId, oldName, newName }) {
    const oldCheckKey = `AlertRegex_${apiId}_${oldName}`;
    const checkKey = `AlertRegex_${apiId}_${newName}`;
    const value = accountStorage.getItem(oldCheckKey);
    if (value) {
        accountStorage.setItem(checkKey, value);
        accountStorage.removeItem(oldCheckKey);
    }
    if (isPresetScriptsAllowed(apiId, oldName)) {
        disallowPresetScripts(apiId, oldName);
        allowPresetScripts(apiId, newName);
    }
}

/**
 * (Re-)initialize jQuery UI Sortable for the three script lists. Safe to call
 * after every loadRegexScripts() — without re-init, Sortable's internal
 * `instance.items` keeps references to the previous render's <li> nodes, so
 * .empty()'d DOM stays alive as detached nodes (heap snapshots showed ~44 of
 * each regex action button lingering across re-renders).
 */
function setupRegexSortable() {
    const sortableDatas = [
        {
            selector: '#saved_regex_scripts',
            scriptType: SCRIPT_TYPES.GLOBAL,
        },
        {
            selector: '#saved_scoped_scripts',
            scriptType: SCRIPT_TYPES.SCOPED,
        },
        {
            selector: '#saved_preset_scripts',
            scriptType: SCRIPT_TYPES.PRESET,
        },
    ];
    for (const { selector, scriptType } of sortableDatas) {
        const $el = $(selector);
        // @ts-ignore
        if ($el.sortable('instance') !== undefined) {
            // @ts-ignore
            $el.sortable('destroy');
        }
        // @ts-ignore
        $el.sortable({
            delay: getRegexSortableDelay(),
            handle: '.regex-script-handle',
            helper: (_event, ui) => buildRegexDragHelper(ui),
            appendTo: document.body,
            tolerance: 'pointer',
            forcePlaceholderSize: false,
            placeholder: 'regex-sortable-placeholder',
            cursor: 'grabbing',
            scroll: true,
            scrollSensitivity: 60,
            scrollSpeed: 18,
            start: (_event, ui) => {
                styleRegexDragPlaceholder(ui);
            },
            stop: async function () {
                const target = captureRegexTarget(scriptType);
                const orderedIds = $(selector).children().map(function () { return $(this).attr('id'); }).get().filter(Boolean);
                const reorderList = (sourceScripts) => {
                    const byId = new Map(sourceScripts.map(script => [script.id, script]));
                    const next = [];
                    for (const id of orderedIds) {
                        const existingScript = byId.get(id);
                        if (existingScript) {
                            next.push(existingScript);
                            byId.delete(id);
                        }
                    }
                    for (const remaining of byId.values()) {
                        next.push(remaining);
                    }
                    return next;
                };

                try {
                    if (scriptType === SCRIPT_TYPES.SCOPED) {
                        await updateScopedRegexScripts(reorderList, target);
                    } else {
                        const oldScripts = getScriptsByType(scriptType, { target });
                        await saveScriptsByType(reorderList(oldScripts), scriptType, { target });
                    }
                    saveSettingsDebounced();
                    console.debug(`Regex scripts in ${selector} reordered`);
                    await requestRegexChatReload();
                    await loadRegexScripts();
                } catch (error) {
                    console.error('[Regex] Failed to save reordered regex scripts', {
                        selector,
                        scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
                        error,
                    });
                    toastr.error(t`Could not save regex script order.`);
                    await loadRegexScripts();
                }
            },
        });

        // Suppress native long-press context menu on drag handles.
        $el
            .off('contextmenu.regexHandle', '.regex-script-handle')
            .on('contextmenu.regexHandle', '.regex-script-handle', (event) => event.preventDefault());
    }
}

async function showRegexPerfDetectionHelp() {
    const container = document.createElement('div');
    const what = document.createElement('p');
    what.textContent = t`Every regex script run is timed. A script that takes ${REGEX_HARD_THRESHOLD_MS} ms or longer in a single run is paused for the session and a warning appears, so catastrophic backtracking cannot freeze the chat.`;
    container.appendChild(what);
    const off = document.createElement('p');
    off.textContent = t`When detection is off, scripts still run, but their time is not recorded and they are not paused or reported.`;
    container.appendChild(off);
    await callGenericPopup(container, POPUP_TYPE.TEXT, translate('Performance detection', 'ext_regex_perf_detection'), { okButton: t`Got it` });
}

// Workaround for loading in sequence with other extensions
// NOTE: Always puts extension at the top of the list, but this is fine since it's static
export async function init() {
    if (!Array.isArray(extension_settings.regex)) {
        extension_settings.regex = [];
    }

    if (!Array.isArray(extension_settings.regex_presets)) {
        extension_settings.regex_presets = [];
    }

    if (typeof extension_settings.regex_perf_detection !== 'boolean') {
        extension_settings.regex_perf_detection = true;
    }

    // Manually disable the extension since static imports auto-import the JS file
    if (extension_settings.disabledExtensions.includes('regex')) {
        return;
    }

    migrateSettings();

    const settingsHtml = $(await renderExtensionTemplateAsync('regex', 'dropdown'));
    $('#regex_container').append(settingsHtml);
    const regexDrawer = document.querySelector('#regex_container .regex_settings .inline-drawer');
    regexDrawer?.addEventListener('inline-drawer-toggle', (e) => {
        if (e.target !== regexDrawer) return;
        // The custom toggle event fires before slideToggle updates display, so read the open state on the next tick.
        window.setTimeout(() => {
            const content = regexDrawer.querySelector(':scope > .inline-drawer-content');
            const isOpen = content instanceof HTMLElement && getComputedStyle(content).display !== 'none';
            if (isOpen) {
                void refreshRegexEditorUi();
            }
        }, 0);
    });
    applyCollapsedRegexSections();
    bindRegexSectionCollapse();
    bindRegexReloadOnSettingsClose();
    $('#regex_perf_detection_toggle')
        .prop('checked', extension_settings.regex_perf_detection)
        .on('input', function () {
            const enabled = !!$(this).prop('checked');
            extension_settings.regex_perf_detection = enabled;
            if (!enabled) {
                resetAllRegexScriptState();
                void requestRegexChatReload();
            }
            saveSettingsDebounced();
        });
    $('#regex_perf_detection_help').on('click', function (event) {
        event.preventDefault();
        void showRegexPerfDetectionHelp();
    });
    $('#open_regex_editor').on('click', function () {
        onRegexEditorOpenClick(false, SCRIPT_TYPES.GLOBAL);
    });
    $('#open_regex_debugger').on('click', onRegexDebuggerOpenClick);
    $('#open_scoped_editor').on('click', function () {
        if (this_chid === undefined) {
            toastr.error(t`No character selected.`);
            return;
        }

        if (selected_group) {
            toastr.error(t`Cannot edit scoped scripts in group chats.`);
            return;
        }

        onRegexEditorOpenClick(false, SCRIPT_TYPES.SCOPED);
    });
    $('#open_preset_editor').on('click', function () {
        onRegexEditorOpenClick(false, SCRIPT_TYPES.PRESET);
    });
    $('#import_regex_file').on('change', async function () {
        let targetType = SCRIPT_TYPES.GLOBAL;
        const template = $(await renderExtensionTemplateAsync('regex', 'importTarget'));
        template.find('#regex_import_target_global').on('input', () => (targetType = SCRIPT_TYPES.GLOBAL));
        template.find('#regex_import_target_scoped').on('input', () => (targetType = SCRIPT_TYPES.SCOPED));
        template.find('#regex_import_target_preset').on('input', () => (targetType = SCRIPT_TYPES.PRESET));

        const confirmed = await callGenericPopup(template, POPUP_TYPE.TEXT);
        const inputElement = this instanceof HTMLInputElement && this;
        if (!confirmed || !inputElement) {
            if (inputElement) inputElement.value = '';
            return;
        }
        if (targetType === SCRIPT_TYPES.SCOPED) {
            if (this_chid === undefined) {
                toastr.error(t`No character selected.`);
                inputElement.value = '';
                return;
            }
            if (selected_group) {
                toastr.error(t`Cannot edit scoped scripts in group chats.`);
                inputElement.value = '';
                return;
            }
        }
        const capturedTarget = captureRegexTarget(targetType);
        for (const file of inputElement.files) {
            await onRegexImportFileChange(file, targetType, { target: capturedTarget });
        }
        inputElement.value = '';
    });
    $('#import_regex').on('click', function () {
        $('#import_regex_file').trigger('click');
    });

    $('#bulk_select_all_toggle').on('click', async function () {
        const checkboxes = $('#regex_container .regex_bulk_checkbox');
        if (checkboxes.length === 0) {
            return;
        }

        const allAreChecked = checkboxes.length === checkboxes.filter(':checked').length;
        const newState = !allAreChecked; // true if we just checked all, false if we just unchecked all

        checkboxes.prop('checked', newState);
        setToggleAllIcon(newState);
        setMoveButtonsVisibility();
    });

    $('#bulk_enable_regex').on('click', async function () {
        await bulkToggleRegexScripts(true);
    });

    $('#bulk_disable_regex').on('click', async function () {
        await bulkToggleRegexScripts(false);
    });

    function restoreBulkSelection(selectedIds) {
        if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
            return;
        }
        const idSet = new Set(selectedIds);
        $('#regex_container .regex-script-label').each(function () {
            const id = $(this).attr('id');
            if (id && idSet.has(id)) {
                $(this).find('.regex_bulk_checkbox').prop('checked', true);
            }
        });
        setMoveButtonsVisibility();
        const checkboxes = $('#regex_container .regex_bulk_checkbox');
        const allAreChecked = checkboxes.length > 0 && checkboxes.length === checkboxes.filter(':checked').length;
        setToggleAllIcon(allAreChecked);
    }

    /**
     * Bulk enable or disable regex scripts
     * @param {boolean} newState New state to set (true = enable, false = disable)
     * @returns {Promise<void>}
     */
    async function bulkToggleRegexScripts(newState) {
        const scripts = getSelectedScripts().filter(script => script.disabled === newState);
        if (scripts.length === 0) {
            toastr.warning(newState
                ? t`No regex scripts selected for enabling.`
                : t`No regex scripts selected for disabling.`,
            );
            return;
        }
        const idsByType = new Map();
        const targetsByType = new Map();
        for (const script of scripts) {
            const scriptType = getScriptType(script);
            if (scriptType === SCRIPT_TYPE_UNKNOWN) {
                continue;
            }
            if (!idsByType.has(scriptType)) {
                idsByType.set(scriptType, new Set());
                targetsByType.set(scriptType, captureRegexTarget(scriptType));
            }
            idsByType.get(scriptType).add(script.id);
        }

        let anySucceeded = false;
        const failedIds = [];
        for (const [scriptType, selectedIds] of idsByType.entries()) {
            const target = targetsByType.get(scriptType);
            try {
                if (scriptType === SCRIPT_TYPES.SCOPED) {
                    await updateScopedRegexScripts((currentScripts) =>
                        currentScripts.map(script => selectedIds.has(script.id) ? { ...script, disabled: !newState } : script),
                    target);
                } else {
                    const nextScripts = getScriptsByType(scriptType, { target })
                        .map(script => selectedIds.has(script.id) ? { ...script, disabled: !newState } : script);
                    await saveScriptsByType(nextScripts, scriptType, { target });
                }
                anySucceeded = true;
            } catch (error) {
                failedIds.push(...selectedIds);
                console.error('[Regex] Bulk toggle failed for script scope', {
                    scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
                    count: selectedIds.size,
                    error,
                });
            }
        }

        if (failedIds.length > 0) {
            toastr.error(anySucceeded
                ? t`Some regex script changes could not be saved.`
                : t`Could not save regex script changes.`);
        }
        if (anySucceeded) {
            saveSettingsDebounced();
        }
        await loadRegexScripts();
        if (failedIds.length > 0) {
            restoreBulkSelection(failedIds);
        }
        if (anySucceeded) {
            await requestRegexChatReload();
        }
    }

    /**
     * Bulk move regex scripts to the specified type
     * @param {SCRIPT_TYPES} toType destination type
     */
    async function bulkMoveRegexScript(toType) {
        const scripts = getSelectedScripts();
        if (scripts.length === 0) {
            toastr.warning(t`No regex scripts selected for moving.`);
            return;
        }
        const toTarget = captureRegexTarget(toType);
        const moves = scripts
            .map(script => ({ script, fromType: getScriptType(script) }))
            .filter(({ fromType }) => fromType !== SCRIPT_TYPE_UNKNOWN && fromType !== toType)
            .map(entry => ({ ...entry, fromTarget: captureRegexTarget(entry.fromType) }));

        let anyChanged = false;
        for (const { script, fromType, fromTarget } of moves) {
            const outcome = await moveRegexScript(script, toType, fromType, false, { fromTarget, toTarget });
            if (outcome?.ok || outcome?.partial) {
                anyChanged = true;
            }
        }

        if (anyChanged) {
            saveSettingsDebounced();
        }
        await loadRegexScripts();
        if (anyChanged) {
            await requestRegexChatReload();
        }
    }

    $('#bulk_regex_move_to_global').on('click', async () => {
        const confirm = await callGenericPopup(t`Are you sure you want to move the selected regex scripts to global?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            return;
        }
        await bulkMoveRegexScript(SCRIPT_TYPES.GLOBAL);
    });

    $('#bulk_regex_move_to_scoped').on('click', async () => {
        if (this_chid === undefined) {
            toastr.error(t`No character selected.`);
            return;
        }
        if (selected_group) {
            toastr.error(t`Cannot edit scoped scripts in group chats.`);
            return;
        }
        const confirm = await callGenericPopup(t`Are you sure you want to move the selected regex scripts to scoped?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            return;
        }
        await bulkMoveRegexScript(SCRIPT_TYPES.SCOPED);
    });

    $('#bulk_regex_move_to_preset').on('click', async function () {
        const confirm = await callGenericPopup(t`Are you sure you want to move the selected regex scripts to preset?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            return;
        }
        await bulkMoveRegexScript(SCRIPT_TYPES.PRESET);
    });

    $('#bulk_delete_regex').on('click', async function () {
        const scripts = getSelectedScripts();
        if (scripts.length === 0) {
            toastr.warning(t`No regex scripts selected for deletion.`);
            return;
        }
        const confirm = await callGenericPopup(t`Are you sure you want to delete the selected regex scripts?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            return;
        }
        const idsByType = new Map();
        const targetsByType = new Map();
        for (const script of scripts) {
            const scriptType = getScriptType(script);
            if (scriptType === SCRIPT_TYPE_UNKNOWN) {
                continue;
            }
            if (!idsByType.has(scriptType)) {
                idsByType.set(scriptType, new Set());
                targetsByType.set(scriptType, captureRegexTarget(scriptType));
            }
            idsByType.get(scriptType).add(script.id);
        }

        let anySucceeded = false;
        let anyFailed = false;
        for (const [scriptType, idsToDelete] of idsByType.entries()) {
            const target = targetsByType.get(scriptType);
            try {
                if (scriptType === SCRIPT_TYPES.SCOPED) {
                    const result = await updateScopedRegexScripts((currentScripts) => {
                        const next = currentScripts.filter(script => !idsToDelete.has(script.id));
                        return next.length === currentScripts.length ? null : next;
                    }, target);
                    if (result.changed) {
                        for (const id of idsToDelete) resetRegexScriptState(id);
                        anySucceeded = true;
                    }
                } else {
                    const current = getScriptsByType(scriptType, { target });
                    const next = current.filter(script => !idsToDelete.has(script.id));
                    if (next.length !== current.length) {
                        await saveScriptsByType(next, scriptType, { target });
                        for (const id of idsToDelete) resetRegexScriptState(id);
                        anySucceeded = true;
                    }
                }
            } catch (error) {
                anyFailed = true;
                console.error('[Regex] Bulk delete failed for script scope', {
                    scriptType: REGEX_SCRIPT_TYPE_LABELS[scriptType] || String(scriptType),
                    count: idsToDelete.size,
                    error,
                });
            }
        }

        if (anyFailed) {
            toastr.error(anySucceeded
                ? t`Some regex script changes could not be saved.`
                : t`Could not delete regex script.`);
        }
        if (anySucceeded) {
            saveSettingsDebounced();
        }
        await loadRegexScripts();
        if (anySucceeded) {
            await requestRegexChatReload();
        }
    });

    $('#bulk_export_regex').on('click', async function () {
        const scripts = getSelectedScripts();
        if (scripts.length === 0) {
            toastr.warning(t`No regex scripts selected for export.`);
            return;
        }
        const fileName = `regex-${new Date().toISOString()}.json`;
        const fileData = JSON.stringify(scripts, null, 4);
        download(fileData, fileName, 'application/json');
        await loadRegexScripts();
    });

    setupRegexSortable();

    $('#regex_scoped_toggle').on('input', function () {
        if (this_chid === undefined) {
            toastr.error(t`No character selected.`);
            return;
        }

        if (selected_group) {
            toastr.error(t`Cannot edit scoped scripts in group chats.`);
            return;
        }

        const isEnable = !!$(this).prop('checked');
        const character = characters[this_chid];

        if (isEnable) {
            allowScopedScripts(character);
        } else {
            disallowScopedScripts(character);
        }

        console.info('[Regex] Scoped toggle changed', {
            isEnable,
            chid: this_chid ?? null,
            avatar: character?.avatar || null,
            scopedCount: getScriptsByType(SCRIPT_TYPES.SCOPED).length,
        });

        saveSettingsDebounced();
        void requestRegexChatReload();
    });

    $('#regex_preset_toggle').on('input', function () {
        const isEnable = !!$(this).prop('checked');
        const name = getCurrentPresetName();

        if (isEnable) {
            allowPresetScripts(getCurrentPresetAPI(), name);
        } else {
            disallowPresetScripts(getCurrentPresetAPI(), name);
        }

        saveSettingsDebounced();
        void requestRegexChatReload();
    });

    window.addEventListener(REGEX_RUNTIME_SCRIPTS_CHANGED_EVENT, (event) => {
        void refreshRegexEditorUi();
        const requestReload = Boolean(event?.detail?.requestReload);
        if (requestReload) {
            void requestRegexChatReload();
        }
    });

    window.addEventListener(REGEX_OPEN_SCRIPT_EVENT, async (event) => {
        const id = event?.detail?.id;
        if (!id) return;
        try {
            for (const type of [SCRIPT_TYPES.GLOBAL, SCRIPT_TYPES.SCOPED, SCRIPT_TYPES.PRESET]) {
                const scripts = getScriptsByType(type);
                if (Array.isArray(scripts) && scripts.some(s => s && s.id === id)) {
                    await onRegexEditorOpenClick(id, type);
                    return;
                }
            }
            const runtimeScripts = getRuntimeRegexScripts();
            if (Array.isArray(runtimeScripts) && runtimeScripts.some(s => s && s.id === id)) {
                if (typeof toastr !== 'undefined') {
                    toastr.warning(t`This script is provided by a plugin and cannot be edited here.`);
                }
                return;
            }
            if (typeof toastr !== 'undefined') {
                toastr.warning(t`Regex script not found.`);
            }
        } catch (error) {
            console.warn('[Regex] Failed to open script editor from popup', { id, error });
        }
    });
    window.addEventListener(REGEX_ALLOW_SLOW_SCRIPT_EVENT, async (event) => {
        const id = event?.detail?.id;
        if (!id) return;
        try {
            await persistRegexScriptAllowSlow(String(id));
        } catch (error) {
            console.warn('[Regex] Failed to persist allow-slow decision', { id, error });
        }
        // Re-render the chat so the script that was auto-paused applies to the
        // current message right away instead of only on the next generation.
        void requestRegexChatReload();
    });

    await refreshRegexEditorUi();
    // @ts-ignore
    $('#saved_regex_scripts').sortable('enable');

    /**
     * @typedef {object} ScriptDecorators
     * @property {string} typename
     * @property {import('../../slash-commands/SlashCommandEnumValue.js').EnumType} color
     * @property {string} icon
     */

    /**
     * @param {SCRIPT_TYPES} type The script type
     * @returns {ScriptDecorators} The decorators for the script type
     */
    function getScriptDecorators(type) {
        switch (type) {
            case SCRIPT_TYPES.GLOBAL:
                return {
                    typename: 'global',
                    color: enumTypes.enum,
                    icon: 'G',
                };
            case SCRIPT_TYPES.SCOPED:
                return {
                    typename: 'scoped',
                    color: enumTypes.name,
                    icon: 'S',
                };
            case SCRIPT_TYPES.PRESET:
                return {
                    typename: 'preset',
                    color: enumTypes.name,
                    icon: 'P',
                };
            default:
                return {
                    typename: 'Unknown',
                    color: enumTypes.variable,
                    icon: 'Unknown',
                };
        }
    }

    const localEnumProviders = {
        regexScripts: () =>
            getRegexScripts().map(script => {
                const isPluginScript = Boolean(script?.__runtime_owner);
                const type = getScriptType(script);
                const decorators = isPluginScript
                    ? { typename: t`Plugin`, color: enumTypes.variable, icon: 'P' }
                    : getScriptDecorators(type);
                const { typename, color, icon } = decorators;
                return new SlashCommandEnumValue(
                    script.scriptName,
                    `${enumIcons.getStateIcon(!script.disabled)} [${typename}] ${script.findRegex}`,
                    color,
                    icon,
                );
            }),
        editableRegexScripts: () =>
            getEditableRegexScripts().map(script => {
                const type = getScriptType(script);
                const { typename, color, icon } = getScriptDecorators(type);
                return new SlashCommandEnumValue(
                    script.scriptName,
                    `${enumIcons.getStateIcon(!script.disabled)} [${typename}] ${script.findRegex}`,
                    color,
                    icon,
                );
            }),
    };

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'regex',
        callback: runRegexCallback,
        returns: 'replaced text',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'script name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.editableRegexScripts,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'input', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: 'Runs a Regex extension script by name on the provided string. The script must be enabled.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'regex-state',
        /** @param {object} _ @param {string} name */
        callback: (_, name) => {
            if (!name) {
                toastr.warning('No regex script name provided.');
                return '';
            }

            const scripts = getRegexScripts();
            const script = scripts.find(s => equalsIgnoreCaseAndAccents(s.scriptName, name));

            if (!script) {
                toastr.warning(`Regex script "${name}" not found.`);
                return '';
            }

            return script.disabled ? 'false' : 'true';
        },
        returns: 'true (for enabled) or false (for disabled)',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'script name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.regexScripts,
            }),
        ],
        helpString: 'Returns the current state of a regex script.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'regex-toggle',
        callback: toggleRegexCallback,
        returns: 'The name of the script that was toggled',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'state',
                description: 'Explicitly set the state of the script (\'on\' to enable, \'off\' to disable). If not provided, the state will be toggled to the opposite of the current state.',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'toggle',
                enumList: commonEnumProviders.boolean('onOffToggle')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'Suppress the toast message script toggled',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'script name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.regexScripts,
            }),
        ],
        helpString: `
            <div>
                Toggles the state of a specified regex script.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code class="language-stscript">/regex-toggle MyScript</code></pre>
                    </li>
                    <li>
                        <pre><code class="language-stscript">/regex-toggle state=off Character-specific Script</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));

    eventSource.on(event_types.MAIN_API_CHANGED, onMainApiChanged);
    eventSource.on(event_types.CHAT_CHANGED, checkCharEmbeddedRegexScripts);
    eventSource.on(event_types.CHARACTER_DELETED, purgeEmbeddedRegexScripts);
    eventSource.on(event_types.PRESET_RENAMED_BEFORE, onPresetRenamed);
    eventSource.on(event_types.PRESET_CHANGED, checkPresetEmbeddedRegexScripts);
    eventSource.on(event_types.PRESET_DELETED, purgePresetEmbeddedRegexScripts);

    presetManager.setupEventListeners();
    presetManager.registerSlashCommands();
    eventSource.on(event_types.APP_READY, refreshRegexEditorUi);
    eventSource.on(event_types.CHARACTER_EDITOR_OPENED, refreshRegexEditorUi);
}
