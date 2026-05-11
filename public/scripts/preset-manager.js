import { Fuse, lodash } from '../lib.js';

import {
    amount_gen,
    buildObjectPatchOperationsAsync,
    characters,
    eventSource,
    event_types,
    getRequestHeaders,
    koboldai_setting_names,
    koboldai_settings,
    main_api,
    max_context,
    nai_settings,
    novelai_setting_names,
    novelai_settings,
    online_status,
    deleteAllPresetState,
    renamePresetStateTarget,
    saveSettings,
    saveSettingsDebounced,
    requestAsyncDiffForNextSettingsSave,
    this_chid,
} from '../script.js';
import { groups, selected_group } from './group-chats.js';
import { t } from './i18n.js';
import { instruct_presets } from './instruct-mode.js';
import { kai_settings } from './kai-settings.js';
import { convertNovelPreset } from './nai-settings.js';
import { getChatCompletionPreset, oai_settings, openai_setting_names, openai_settings } from './openai.js';
import { persistPreset } from './preset-persistence.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from './popup.js';
import { context_presets, getContextSettings, power_user } from './power-user.js';
import { reasoning_templates } from './reasoning.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from './slash-commands/SlashCommandArgument.js';
import { enumIcons } from './slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandEnumValue, enumTypes } from './slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { checkForSystemPromptInInstructTemplate, system_prompts } from './sysprompt.js';
import { renderTemplateAsync } from './templates.js';
import {
    textgenerationwebui_settings as textgen_settings,
    textgenerationwebui_preset_names,
    textgenerationwebui_presets,
} from './textgen-settings.js';
import { areLookupNamesEqual, download, ensurePlainObject, equalsIgnoreCaseAndAccents, findCanonicalNameInList, getSanitizedFilename, parseJsonFile, waitUntilCondition } from './utils.js';
import {
    PRESET_LINKED_LOREBOOK_KEY,
    createPresetLinkedLorebookPayload,
    getPresetLinkedLorebookFromExtensions,
    importPresetLinkedLorebookPayload,
    loadWorldInfo,
    maybeDeleteLinkedLorebookForPresetDeletion,
    updateWorldInfoList,
    world_names,
} from './world-info.js';
import { showUndoToast } from './undo-toast.js';
import { initActionableSingleSelect } from './select2-actionable-single.js';

const presetManagers = {};
const PRESET_LOREBOOK_BINDABLE_APIS = new Set(['kobold', 'novel', 'openai', 'textgenerationwebui']);

function shouldShowPresetLinkedLorebookButton(apiId) {
    return PRESET_LOREBOOK_BINDABLE_APIS.has(String(apiId || '').trim());
}

function ensurePresetLinkedLorebookButton(apiId) {
    if (!shouldShowPresetLinkedLorebookButton(apiId)) {
        return;
    }

    if ($(`[data-preset-manager-linked-lorebook="${apiId}"]`).length) {
        return;
    }

    const $anchor = $(`[data-preset-manager-restore="${apiId}"], [data-preset-manager-new="${apiId}"], [data-preset-manager-update="${apiId}"], [data-preset-manager-rename="${apiId}"]`).last();
    if (!$anchor.length) {
        return;
    }

    const title = t`Manage linked World/Lorebook`;
    const tagName = String($anchor.prop('tagName') || '').toUpperCase();
    let $button;

    if (tagName === 'I') {
        $button = $('<i />')
            .addClass('menu_button fa-solid fa-link')
            .attr('title', title);
    } else {
        $button = $('<div />')
            .addClass('menu_button menu_button_icon')
            .attr('title', title)
            .append($('<i />').addClass('fa-solid fa-link'));
        if ($anchor.hasClass('margin0')) {
            $button.addClass('margin0');
        }
    }

    $button
        .attr('data-i18n', '[title]Manage linked World/Lorebook')
        .attr('data-preset-manager-linked-lorebook', apiId);
    $anchor.after($button);
}

function ensurePresetEmbeddedRegexImportButton(apiId) {
    if ($(`[data-preset-manager-reimport-regex="${apiId}"]`).length) {
        return;
    }

    const $anchor = $(`[data-preset-manager-linked-lorebook="${apiId}"], [data-preset-manager-restore="${apiId}"], [data-preset-manager-new="${apiId}"], [data-preset-manager-update="${apiId}"], [data-preset-manager-rename="${apiId}"]`).last();
    if (!$anchor.length) {
        return;
    }

    const title = t`Import embedded regex scripts`;
    const tagName = String($anchor.prop('tagName') || '').toUpperCase();
    let $button;

    if (tagName === 'I') {
        $button = $('<i />')
            .addClass('menu_button fa-solid fa-file-import')
            .attr('title', title);
    } else {
        $button = $('<div />')
            .addClass('menu_button menu_button_icon')
            .attr('title', title)
            .append($('<i />').addClass('fa-solid fa-file-import'));
        if ($anchor.hasClass('margin0')) {
            $button.addClass('margin0');
        }
    }

    $button
        .attr('data-i18n', '[title]Import embedded regex scripts')
        .attr('data-preset-manager-reimport-regex', apiId);
    $anchor.after($button);
}

async function promptLorebookNameToBind(worldNames, defaultName = '') {
    const names = Array.isArray(worldNames) ? worldNames : [];
    if (!names.length) {
        return '';
    }

    const selectedName = names.includes(defaultName) ? defaultName : names[0];
    const $container = $('<div class="flex-container flexFlowColumn gap8"></div>');
    const $label = $('<div></div>').text(t`Select a World/Lorebook to link with this preset.`);
    const $select = $('<select class="text_pole width100p"></select>');
    for (const name of names) {
        const $option = $('<option></option>').val(name).text(name);
        if (name === selectedName) {
            $option.prop('selected', true);
        }
        $select.append($option);
    }
    $container.append($label, $select);

    const popup = new Popup($container, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Link`,
        cancelButton: t`Cancel`,
        leftAlign: true,
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return '';
    }

    return String($select.val() || '').trim();
}

async function managePresetLinkedLorebook(apiId) {
    const presetManager = getPresetManager(apiId);
    if (!presetManager) {
        console.warn(`Preset Manager not found for API: ${apiId}`);
        return;
    }

    const presetName = String(presetManager.getSelectedPresetName() || '').trim();
    if (!presetName) {
        toastr.warning(t`No preset selected.`);
        return;
    }

    const extensions = ensurePlainObject(presetManager.readPresetExtensionField({ name: presetName, path: '' }) || {});
    const payload = getPresetLinkedLorebookFromExtensions(extensions);

    if (payload) {
        const existing = world_names?.includes(payload.name) ? await loadWorldInfo(payload.name) : null;
        const canImport = !(existing && (await buildObjectPatchOperationsAsync(existing, payload.data)).length === 0);
        const header = t`This preset has a linked World/Lorebook.`;
        const body = `${t`Preset`}: <code>${presetName}</code><br>${t`Linked World/Lorebook`}: <code>${payload.name}</code><br><br>${t`Import and activate it now?`}`;
        const action = await Popup.show.confirm(header, body, {
            okButton: canImport ? t`Import` : false,
            cancelButton: t`Close`,
            customButtons: [
                {
                    text: t`Unlink`,
                    result: POPUP_RESULT.CUSTOM1,
                },
            ],
        });
        if (canImport && action === POPUP_RESULT.AFFIRMATIVE) {
            const imported = await importPresetLinkedLorebookPayload(payload);
            if (imported) {
                toastr.success(t`Imported and activated linked World/Lorebook from preset.`);
            } else {
                toastr.error(t`Failed to import linked World/Lorebook from preset.`);
            }
            return;
        }

        if (action !== POPUP_RESULT.CUSTOM1) {
            return;
        }

        const shouldUnlink = await Popup.show.confirm(
            t`Unlink linked World/Lorebook?`,
            `${t`Preset`}: <code>${presetName}</code><br>${t`Linked World/Lorebook`}: <code>${payload.name}</code>`,
            {
                okButton: t`Unlink`,
                cancelButton: t`Keep`,
            },
        );
        if (shouldUnlink !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        const nextExtensions = structuredClone(extensions);
        delete nextExtensions[PRESET_LINKED_LOREBOOK_KEY];
        await presetManager.writePresetExtensionField({ name: presetName, path: '', value: nextExtensions });
        toastr.success(t`Linked World/Lorebook removed from preset.`);
        return;
    }

    await updateWorldInfoList();
    const worldNames = Array.isArray(world_names) ? [...world_names] : [];
    if (!worldNames.length) {
        toastr.info(t`No World/Lorebook available to link.`);
        return;
    }

    const worldName = await promptLorebookNameToBind(worldNames, worldNames[0]);
    if (!worldName) {
        return;
    }

    const data = await loadWorldInfo(worldName);
    if (!data) {
        toastr.error(t`Failed to load the selected World/Lorebook.`);
        return;
    }

    const nextExtensions = structuredClone(extensions);
    nextExtensions[PRESET_LINKED_LOREBOOK_KEY] = createPresetLinkedLorebookPayload(worldName, data);
    await presetManager.writePresetExtensionField({ name: presetName, path: '', value: nextExtensions });
    toastr.success(t`Linked World/Lorebook saved to the current preset.`);
}

/**
 * Automatically select a preset for current API based on character or group name.
 */
function autoSelectPreset() {
    const presetManager = getPresetManager();

    if (!presetManager) {
        console.debug(`Preset Manager not found for API: ${main_api}`);
        return;
    }

    if (main_api === 'openai' && !selected_group) {
        const lukerExtensions = characters?.[this_chid]?.data?.extensions?.luker;
        const hasExplicitCharacterPresetConfig = lukerExtensions && typeof lukerExtensions === 'object'
            && Object.prototype.hasOwnProperty.call(lukerExtensions, 'chat_completion_preset');
        const rawBoundPreset = hasExplicitCharacterPresetConfig ? lukerExtensions.chat_completion_preset : undefined;
        const boundPresetName = typeof rawBoundPreset === 'string'
            ? rawBoundPreset.trim()
            : String(rawBoundPreset?.name || '').trim();

        if (hasExplicitCharacterPresetConfig) {
            if (boundPresetName) {
                console.debug('Skipping OpenAI preset auto-selection because the current character has an explicit bound preset.');
            } else {
                console.debug('Skipping OpenAI preset auto-selection because the current character explicitly cleared character-bound preset selection.');
            }
            return;
        }
    }

    const name = selected_group ? groups.find(x => x.id == selected_group)?.name : characters[this_chid]?.name;

    if (!name) {
        console.debug(`Preset candidate not found for API: ${main_api}`);
        return;
    }

    const preset = presetManager.findPreset(name);
    const selectedPreset = presetManager.getSelectedPreset();

    if (preset === selectedPreset) {
        console.debug(`Preset already selected for API: ${main_api}, name: ${name}`);
        return;
    }

    if (preset !== undefined && preset !== null) {
        console.log(`Preset found for API: ${main_api}, name: ${name}`);
        presetManager.selectPreset(preset);
    }
}

/**
 * Gets a preset manager by API id.
 * @param {string} apiId API id
 * @returns {PresetManager} Preset manager
 */
export function getPresetManager(apiId = '') {
    if (apiId === 'koboldhorde') {
        apiId = 'kobold';
    }
    if (!apiId) {
        apiId = main_api == 'koboldhorde' ? 'kobold' : main_api;
    }

    if (!Object.keys(presetManagers).includes(apiId)) {
        return null;
    }

    return presetManagers[apiId];
}

/**
 * Persists preset extension changes back into the active character-bound OpenAI preset snapshot.
 * This keeps character-bound preset payloads in sync when extensions such as preset regex scripts mutate.
 *
 * @param {object} options
 * @param {string} options.presetName
 * @param {string} options.path
 * @param {any} options.value
 * @returns {Promise<void>}
 */
async function syncCharacterBoundOpenAIPresetExtensionField({ presetName, path, value }) {
    const chid = Number(this_chid);
    if (!Number.isInteger(chid)) {
        return;
    }

    const character = characters?.[chid];
    if (!character?.avatar) {
        return;
    }

    const nextExtensions = structuredClone(character?.data?.extensions ?? {});
    const lukerExtensions = ensurePlainObject(nextExtensions.luker);
    const boundPreset = ensurePlainObject(lukerExtensions.chat_completion_preset);
    const boundName = String(boundPreset.name || '').trim();
    const resolvedPresetName = String(presetName || '').trim();

    if (!boundName || !resolvedPresetName || !areLookupNamesEqual(boundName, resolvedPresetName)) {
        return;
    }

    const boundPresetBody = ensurePlainObject(boundPreset.preset);
    const boundPresetExtensions = ensurePlainObject(boundPresetBody.extensions);
    if (path) {
        lodash.set(boundPresetExtensions, path, value);
    }
    boundPresetBody.extensions = path ? boundPresetExtensions : value;
    boundPreset.preset = boundPresetBody;
    lukerExtensions.chat_completion_preset = boundPreset;
    nextExtensions.luker = lukerExtensions;

    character.data = character.data || {};
    character.data.extensions = nextExtensions;

    if (Number(this_chid) === chid && character.json_data) {
        try {
            const jsonData = JSON.parse(character.json_data);
            jsonData.data = jsonData.data || {};
            jsonData.data.extensions = nextExtensions;
            character.json_data = JSON.stringify(jsonData);
            $('#character_json_data').val(character.json_data);
        } catch {
            // Ignore malformed json_data snapshots.
        }
    }

    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            avatar: character.avatar,
            data: {
                extensions: nextExtensions,
            },
        }),
    });

    if (!response.ok) {
        console.error('Failed to sync character-bound OpenAI preset extensions', response.statusText);
    }
}

/**
 * Registers preset managers for all select elements with data-preset-manager-for attribute.
 */
function registerPresetManagers() {
    $('select[data-preset-manager-for]').each((_, e) => {
        if (e instanceof HTMLSelectElement && !e.dataset.lukerAsyncDiffBound) {
            e.dataset.lukerAsyncDiffBound = '1';
            e.addEventListener('change', () => {
                requestAsyncDiffForNextSettingsSave();
            }, { capture: true });
        }

        const forData = String($(e).data('preset-manager-for') || '');
        const apiIds = forData.split(',').map((apiId) => String(apiId || '').trim()).filter(Boolean);
        let primaryManager = null;

        for (const apiId of apiIds) {
            console.debug(`Registering preset manager for API: ${apiId}`);
            presetManagers[apiId] = new PresetManager($(e), apiId);
            ensurePresetLinkedLorebookButton(apiId);
            ensurePresetEmbeddedRegexImportButton(apiId);
            primaryManager ??= presetManagers[apiId];
        }

        if (primaryManager && e instanceof HTMLSelectElement && !e.dataset.lukerActionableSingleSelectBound) {
            e.dataset.lukerActionableSingleSelectBound = '1';
            initActionableSingleSelect($(e), {
                searchInputPlaceholder: t`Search...`,
                deleteButtonTitle: primaryManager.isAdvancedFormatting() ? t`Delete template` : t`Delete preset`,
                canDelete: ({ text, element }) => primaryManager.canDeletePreset(text, element),
                onDelete: async ({ text }) => {
                    await primaryManager.deletePresetInteractive(text);
                },
                select2Options: {
                    width: '100%',
                },
                presetGroupCallbacks: {
                    getGroups: () => primaryManager.getPresetGroups(),
                    getGroupForPreset: (name) => primaryManager.getGroupForPreset(name),
                    getGroupDepth: (groupId) => primaryManager.getGroupDepth(groupId),
                    rebuild: () => {
                        primaryManager.rebuildSelectWithGroups();
                    },
                    createGroup: async (name, parentId) => {
                        const id = primaryManager.createPresetGroup(name, parentId || null);
                        return id;
                    },
                    renameGroup: async (groupId, newName) => {
                        primaryManager.renamePresetGroup(groupId, newName);
                    },
                    deleteGroup: async (groupId) => {
                        primaryManager.deletePresetGroup(groupId);
                    },
                    addToGroup: async (presetName, groupId) => {
                        primaryManager.addPresetToGroup(presetName, groupId);
                    },
                    removeFromGroup: async (presetName) => {
                        primaryManager.removePresetFromGroup(presetName);
                    },
                },
            });
        }
    });
}


class PresetManager {
    constructor(select, apiId) {
        this.select = select;
        this.apiId = apiId;
    }

    static masterSections = {
        'instruct': {
            name: 'Instruct Template',
            getData: () => {
                const manager = getPresetManager('instruct');
                const name = manager.getSelectedPresetName();
                return manager.getPresetSettings(name);
            },
            setData: (data) => {
                const manager = getPresetManager('instruct');
                const name = data.name;
                return manager.savePreset(name, data);
            },
            isValid: (data) => PresetManager.isPossiblyInstructData(data),
        },
        'context': {
            name: 'Context Template',
            getData: () => {
                const manager = getPresetManager('context');
                const name = manager.getSelectedPresetName();
                return manager.getPresetSettings(name);
            },
            setData: (data) => {
                const manager = getPresetManager('context');
                const name = data.name;
                return manager.savePreset(name, data);
            },
            isValid: (data) => PresetManager.isPossiblyContextData(data),
        },
        'sysprompt': {
            name: 'System Prompt',
            getData: () => {
                const manager = getPresetManager('sysprompt');
                const name = manager.getSelectedPresetName();
                return manager.getPresetSettings(name);
            },
            setData: (data) => {
                const manager = getPresetManager('sysprompt');
                const name = data.name;
                return manager.savePreset(name, data);
            },
            isValid: (data) => PresetManager.isPossiblySystemPromptData(data),
        },
        'preset': {
            name: 'Text Completion Preset',
            getData: () => {
                const manager = getPresetManager('textgenerationwebui');
                const name = manager.getSelectedPresetName();
                const data = manager.getPresetSettings(name);
                data.name = name;
                return data;
            },
            setData: (data) => {
                const manager = getPresetManager('textgenerationwebui');
                const name = data.name;
                return manager.savePreset(name, data);
            },
            isValid: (data) => PresetManager.isPossiblyTextCompletionData(data),
        },
        'reasoning': {
            name: 'Reasoning Formatting',
            getData: () => {
                const manager = getPresetManager('reasoning');
                const name = manager.getSelectedPresetName();
                return manager.getPresetSettings(name);
            },
            setData: (data) => {
                const manager = getPresetManager('reasoning');
                const name = data.name;
                return manager.savePreset(name, data);
            },
            isValid: (data) => PresetManager.isPossiblyReasoningData(data),
        },
        'srw': {
            name: 'Start Reply With',
            getData: () => {
                return {
                    value: power_user.user_prompt_bias ?? '',
                    show: power_user.show_user_prompt_bias ?? false,
                };
            },
            setData: (data) => {
                power_user.user_prompt_bias = data.value ?? '';
                power_user.show_user_prompt_bias = data.show ?? false;
                $('#start_reply_with').val(power_user.user_prompt_bias);
                $('#chat-show-reply-prefix-checkbox').prop('checked', power_user.show_user_prompt_bias);
                return saveSettingsDebounced();
            },
            isValid: (data) => PresetManager.isPossiblyStartReplyWithData(data),
        },
    };

    static isPossiblyInstructData(data) {
        const instructProps = ['name', 'input_sequence', 'output_sequence'];
        return data && instructProps.every(prop => Object.keys(data).includes(prop));
    }

    static isPossiblyContextData(data) {
        const contextProps = ['name', 'story_string'];
        return data && contextProps.every(prop => Object.keys(data).includes(prop));
    }

    static isPossiblySystemPromptData(data) {
        const sysPromptProps = ['name', 'content'];
        return data && sysPromptProps.every(prop => Object.keys(data).includes(prop));
    }

    static isPossiblyTextCompletionData(data) {
        const textCompletionProps = ['temp', 'top_k', 'top_p', 'rep_pen'];
        return data && textCompletionProps.every(prop => Object.keys(data).includes(prop));
    }

    static isPossiblyReasoningData(data) {
        const reasoningProps = ['name', 'prefix', 'suffix', 'separator'];
        return data && reasoningProps.every(prop => Object.keys(data).includes(prop));
    }

    static isPossiblyStartReplyWithData(data) {
        return data && 'value' in data && 'show' in data;
    }

    /**
     * Imports master settings from JSON data.
     * @param {object} data Data to import
     * @param {string} fileName File name
     * @returns {Promise<void>}
     */
    static async performMasterImport(data, fileName) {
        if (!data || typeof data !== 'object') {
            toastr.error(t`Invalid data provided for master import`);
            return;
        }

        // Check for legacy file imports
        // 1. Instruct Template
        if (this.isPossiblyInstructData(data)) {
            toastr.info(t`Importing instruct template...`, t`Instruct template detected`);
            return await getPresetManager('instruct').savePreset(data.name, data);
        }

        // 2. Context Template
        if (this.isPossiblyContextData(data)) {
            toastr.info(t`Importing as context template...`, t`Context template detected`);
            return await getPresetManager('context').savePreset(data.name, data);
        }

        // 3. System Prompt
        if (this.isPossiblySystemPromptData(data)) {
            toastr.info(t`Importing as system prompt...`, t`System prompt detected`);
            return await getPresetManager('sysprompt').savePreset(data.name, data);
        }

        // 4. Text Completion settings
        if (this.isPossiblyTextCompletionData(data)) {
            toastr.info(t`Importing as settings preset...`, t`Text Completion settings detected`);
            return await getPresetManager('textgenerationwebui').savePreset(fileName, data);
        }

        // 5. Reasoning Template
        if (this.isPossiblyReasoningData(data)) {
            toastr.info(t`Importing as reasoning template...`, t`Reasoning template detected`);
            return await getPresetManager('reasoning').savePreset(data.name, data);
        }

        const validSections = [];
        for (const [key, section] of Object.entries(this.masterSections)) {
            if (key in data && section.isValid(data[key])) {
                validSections.push(key);
            }
        }

        if (validSections.length === 0) {
            toastr.error(t`No valid sections found in imported data`);
            return;
        }

        const sectionNames = validSections.reduce((acc, key) => {
            acc[key] = { key: key, name: this.masterSections[key].name, preset: data[key]?.name || '' };
            return acc;
        }, {});

        const html = $(await renderTemplateAsync('masterImport', { sections: sectionNames }));
        const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Import`,
            cancelButton: t`Cancel`,
        });

        const result = await popup.show();

        // Import cancelled
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        const importedSections = [];
        const confirmedSections = html.find('input:checked').map((_, el) => el instanceof HTMLInputElement && el.value).get();

        if (confirmedSections.length === 0) {
            toastr.info(t`No sections selected for import`);
            return;
        }

        for (const section of confirmedSections) {
            const sectionData = data[section];
            const masterSection = this.masterSections[section];
            if (sectionData && masterSection) {
                await masterSection.setData(sectionData);
                importedSections.push(masterSection.name);
            }
        }

        toastr.success(t`Imported ${importedSections.length} settings: ${importedSections.join(', ')}`);
    }

    /**
     * Exports master settings to JSON data.
     * @returns {Promise<string>} JSON data
     */
    static async performMasterExport() {
        const sectionNames = Object.entries(this.masterSections).reduce((acc, [key, section]) => {
            acc[key] = { key: key, name: section.name, checked: !['preset', 'srw'].includes(key) };
            return acc;
        }, {});
        const html = $(await renderTemplateAsync('masterExport', { sections: sectionNames }));

        const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Export`,
            cancelButton: t`Cancel`,
        });

        const result = await popup.show();

        // Export cancelled
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        const confirmedSections = html.find('input:checked').map((_, el) => el instanceof HTMLInputElement && el.value).get();
        const data = {};

        if (confirmedSections.length === 0) {
            toastr.info(t`No sections selected for export`);
            return;
        }

        for (const section of confirmedSections) {
            const masterSection = this.masterSections[section];
            if (masterSection) {
                data[section] = masterSection.getData();
            }
        }

        return JSON.stringify(data, null, 4);
    }

    /**
     * Gets all preset names.
     * @returns {string[]} List of preset names
     */
    getAllPresets() {
        return $(this.select).find('option').map((_, el) => el.text).toArray();
    }

    /**
     * Resolves a preset name to the canonical name currently present in the UI.
     * @param {string} name
     * @returns {string}
     */
    resolvePresetName(name) {
        return findCanonicalNameInList(this.getAllPresets(), name) || String(name || '').trim();
    }

    /**
     * Finds a preset by name.
     * @param {string} name Preset name
     * @returns {any} Preset value
     */
    findPreset(name) {
        const resolvedName = this.resolvePresetName(name);
        return $(this.select).find('option').filter(function () {
            return $(this).text() === resolvedName;
        }).val();
    }

    /**
     * Gets the selected preset value.
     * @returns {any} Selected preset value
     */
    getSelectedPreset() {
        return $(this.select).find('option:selected').val();
    }

    /**
     * Gets the selected preset name.
     * @returns {string} Selected preset name
     */
    getSelectedPresetName() {
        return $(this.select).find('option:selected').text();
    }

    /**
     * Returns true if the provided preset can be deleted from the UI.
     * @param {string} name
     * @param {HTMLOptionElement|null} [optionElement]
     * @returns {boolean}
     */
    canDeletePreset(name, optionElement = null) {
        const resolvedName = this.resolvePresetName(name);
        if (!resolvedName) {
            return false;
        }

        const resolvedOptionElement = optionElement instanceof HTMLOptionElement
            ? optionElement
            : $(this.select).find('option').filter(function () {
                return $(this).text() === resolvedName;
            }).get(0);

        if (this.apiId === 'openai' && resolvedOptionElement instanceof HTMLOptionElement && resolvedOptionElement.getAttribute('data-luker-char-bound') === '1') {
            return false;
        }

        const value = resolvedOptionElement instanceof HTMLOptionElement
            ? String(resolvedOptionElement.value)
            : String(this.findPreset(resolvedName) ?? '');

        return Boolean(value) && value !== 'gui';
    }

    /**
     * Selects a preset by option value.
     * @param {string} value Preset option value
     */
    selectPreset(value) {
        const option = $(this.select).filter(function () {
            return $(this).val() === value;
        });
        option.prop('selected', true);
        $(this.select).val(value).trigger('change');
    }

    /**
     * Updates the preset select element with the current API presets.
     * @param {object} [options] Options for saving the preset
     * @param {boolean} [options.skipUpdate=false] If true, skips updating the preset list after saving.
     */
    async updatePreset(option = { skipUpdate: false }) {
        const selected = $(this.select).find('option:selected');
        console.log(selected);

        if (selected.val() == 'gui') {
            toastr.info(t`Cannot update GUI preset`);
            return;
        }

        const name = selected.text();
        await this.savePreset(name, null, option);

        const successToast = !this.isAdvancedFormatting() ? t`Preset updated` : t`Template updated`;
        toastr.success(successToast);
    }

    /**
     * Saves the currently selected preset with a new name.
     */
    async savePresetAs() {
        const inputValue = this.getSelectedPresetName();
        const popupText = !this.isAdvancedFormatting() ? '<h4>' + t`Hint: Use a character/group name to bind preset to a specific chat.` + '</h4>' : '';
        const headerText = !this.isAdvancedFormatting() ? t`Preset name:` : t`Template name:`;
        const name = await Popup.show.input(headerText, popupText, inputValue);
        if (!name) {
            console.log('Preset name not provided');
            return;
        }

        await this.savePreset(name);

        const successToast = !this.isAdvancedFormatting() ? t`Preset saved` : t`Template saved`;
        toastr.success(successToast);
    }

    /**
     * Saves a preset with the given name and settings.
     * @param {string} name Name of the preset to save
     * @param {object} [settings] Settings to save as the preset. If not provided, uses the current preset settings.
     * @param {object} [options] Options for saving the preset
     * @param {boolean} [options.skipUpdate=false] If true, skips updating the preset list after saving.
     */
    async savePreset(name, settings, { skipUpdate = false } = {}) {
        if (this.apiId === 'instruct' && settings) {
            await checkForSystemPromptInInstructTemplate(name, settings);
        }

        if (this.apiId === 'novel' && settings) {
            settings = convertNovelPreset(settings);
        }

        const preset = settings ?? this.getPresetSettings(name);

        const saveResult = await persistPreset({
            apiId: this.apiId,
            name,
            preset,
        });

        if (!saveResult.ok) {
            toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Preset could not be saved`);
            console.error('Preset could not be saved', saveResult.response);
            throw new Error('Preset could not be saved');
        }

        const data = saveResult.data || { name };
        name = data.name;

        if (skipUpdate) {
            console.debug(`Preset ${name} saved, but not updating the list`);
            return;
        }

        this.updateList(name, preset);
    }

    /**
     * Renames the currently selected preset.
     * @param {string} newName New name for the preset
     */
    async renamePreset(newName) {
        const oldName = this.getSelectedPresetName();
        if (equalsIgnoreCaseAndAccents(oldName, newName)) {
            throw new Error('New name must be different from old name');
        }
        try {
            await this.savePreset(newName);
            const renamedState = await renamePresetStateTarget(
                { apiId: this.apiId, name: oldName },
                { apiId: this.apiId, name: newName },
            );
            if (!renamedState) {
                throw new Error('Preset state sidecars could not be renamed');
            }
            await this.deletePreset(oldName);
        } catch (error) {
            toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Preset could not be renamed`);
            console.error('Preset could not be renamed', error);
            throw new Error('Preset could not be renamed');
        }
    }

    /**
     * Gets a list of presets for the API.
     * @param {string} [api] API ID. If not specified, uses the current API ID.
     * @returns {{presets: any[], preset_names: object, settings: object}}
     */
    getPresetList(api) {
        let presets = [];
        let preset_names = {};
        let settings = {};

        // If no API specified, use the current API
        if (api === undefined) {
            api = this.apiId;
        }

        switch (api) {
            case 'koboldhorde':
            case 'kobold':
                presets = koboldai_settings;
                preset_names = koboldai_setting_names;
                settings = kai_settings;
                break;
            case 'novel':
                presets = novelai_settings;
                preset_names = novelai_setting_names;
                settings = nai_settings;
                break;
            case 'textgenerationwebui':
                presets = textgenerationwebui_presets;
                preset_names = textgenerationwebui_preset_names;
                settings = textgen_settings;
                break;
            case 'openai':
                presets = openai_settings;
                preset_names = openai_setting_names;
                settings = oai_settings;
                break;
            case 'context':
                presets = context_presets;
                preset_names = context_presets.map(x => x.name);
                settings = power_user.context;
                break;
            case 'instruct':
                presets = instruct_presets;
                preset_names = instruct_presets.map(x => x.name);
                settings = power_user.instruct;
                break;
            case 'sysprompt':
                presets = system_prompts;
                preset_names = system_prompts.map(x => x.name);
                settings = power_user.sysprompt;
                break;
            case 'reasoning':
                presets = reasoning_templates;
                preset_names = reasoning_templates.map(x => x.name);
                settings = power_user.reasoning;
                break;
            default:
                console.warn(`Unknown API ID ${api}`);
        }

        return { presets, preset_names, settings };
    }

    /**
     * Returns true if the API is keyed, meaning it uses a name to identify presets.
     */
    isKeyedApi() {
        return this.apiId == 'textgenerationwebui' || this.isAdvancedFormatting();
    }

    /**
     * Returns true if the API is from Advanced Formatting group.
     */
    isAdvancedFormatting() {
        return ['context', 'instruct', 'sysprompt', 'reasoning'].includes(this.apiId);
    }

    /**
     * Updates the preset list with a new or existing preset.
     * @param {string} name Name of the preset
     * @param {object} preset Preset object
     */
    updateList(name, preset, { select = true } = {}) {
        const { presets, preset_names } = this.getPresetList();
        const presetExists = this.isKeyedApi() ? preset_names.includes(name) : Object.keys(preset_names).includes(name);

        if (presetExists) {
            if (this.isKeyedApi()) {
                presets[preset_names.indexOf(name)] = preset;
                if (select) {
                    $(this.select).find(`option[value="${name}"]`).prop('selected', true);
                    $(this.select).val(name).trigger('change');
                }
            } else {
                const value = preset_names[name];
                presets[value] = preset;
                if (select) {
                    $(this.select).find(`option[value="${value}"]`).prop('selected', true);
                    $(this.select).val(value).trigger('change');
                }
            }
        } else {
            presets.push(preset);
            const value = presets.length - 1;

            if (this.isKeyedApi()) {
                preset_names[value] = name;
                const option = $('<option></option>', { value: name, text: name, selected: select });
                $(this.select).append(option);
                if (select) {
                    $(this.select).val(name).trigger('change');
                }
            } else {
                preset_names[name] = value;
                const option = $('<option></option>', { value: value, text: name, selected: select });
                $(this.select).append(option);
                if (select) {
                    $(this.select).val(value).trigger('change');
                }
            }
        }

        this.rebuildSelectWithGroups();
    }

    /**
     * Gets the preset settings for the given name.
     * @param {string} name Name of the preset
     * @returns {object} Preset settings object for the given name
     */
    getPresetSettings(name) {
        function getSettingsByApiId(apiId) {
            switch (apiId) {
                case 'koboldhorde':
                case 'kobold':
                    return kai_settings;
                case 'novel':
                    return nai_settings;
                case 'textgenerationwebui':
                    return textgen_settings;
                case 'openai':
                    return getChatCompletionPreset(oai_settings, { includeConnectionFields: false });
                case 'context': {
                    const context_preset = getContextSettings();
                    context_preset.name = name || power_user.context.preset;
                    return context_preset;
                }
                case 'instruct': {
                    const instruct_preset = structuredClone(power_user.instruct);
                    instruct_preset.name = name || power_user.instruct.preset;
                    return instruct_preset;
                }
                case 'sysprompt': {
                    const sysprompt_preset = structuredClone(power_user.sysprompt);
                    sysprompt_preset.name = name || power_user.sysprompt.preset;
                    return sysprompt_preset;
                }
                case 'reasoning': {
                    const reasoning_preset = structuredClone(power_user.reasoning);
                    reasoning_preset.name = name || power_user.reasoning.preset;
                    return reasoning_preset;
                }
                default:
                    console.warn(`Unknown API ID ${apiId}`);
                    return {};
            }
        }

        const filteredKeys = [
            'api_server',
            'preset',
            'streaming',
            'truncation_length',
            'n',
            'streaming_url',
            'stopping_strings',
            'can_use_tokenization',
            'can_use_streaming',
            'preset_settings_novel',
            'preset_settings',
            'streaming_novel',
            'nai_preamble',
            'model_novel',
            'streaming_kobold',
            'enabled',
            'bind_to_context',
            'seed',
            'legacy_api',
            'mancer_model',
            'togetherai_model',
            'ollama_model',
            'vllm_model',
            'aphrodite_model',
            'llamacpp_model',
            'server_urls',
            'type',
            'custom_model',
            'bypass_status_check',
            'infermaticai_model',
            'dreamgen_model',
            'openrouter_model',
            'featherless_model',
            'max_tokens_second',
            'openrouter_providers',
            'openrouter_quantizations',
            'openrouter_allow_fallbacks',
            'tabby_model',
            'derived',
            'generic_model',
            'include_reasoning',
            'global_banned_tokens',
            'send_banned_tokens',

            // Reasoning exclusions
            'auto_parse',
            'add_to_prompts',
            'auto_expand',
            'show_hidden',
            'max_additions',
        ];
        /** @type {Record<string, any>} */
        const settings = Object.assign({}, getSettingsByApiId(this.apiId));

        for (const key of filteredKeys) {
            if (Object.hasOwn(settings, key)) {
                delete settings[key];
            }
        }

        if (!this.isAdvancedFormatting() && this.apiId !== 'openai') {
            settings.genamt = amount_gen;
            settings.max_length = max_context;
        }

        return settings;
    }

    /**
     * Retrieves a completion preset by name.
     * @param {string} name Name of the preset to retrieve
     * @returns {any} Preset object if found, otherwise undefined
     */
    getCompletionPresetByName(name) {
        // Retrieve a completion preset by name. Return undefined if not found.
        let { presets, preset_names } = this.getPresetList();
        let preset;
        const resolvedName = Array.isArray(preset_names)
            ? (findCanonicalNameInList(preset_names, name) || String(name || '').trim())
            : (findCanonicalNameInList(Object.keys(preset_names || {}), name) || String(name || '').trim());

        // Some APIs use an array of names, others use an object of {name: index}
        if (Array.isArray(preset_names)) {  // array of names
            if (preset_names.includes(resolvedName)) {
                preset = presets[preset_names.indexOf(resolvedName)];
            }
        } else {  // object of {names: index}
            if (preset_names[resolvedName] !== undefined) {
                preset = presets[preset_names[resolvedName]];
            }
        }

        if (preset === undefined) {
            console.error(`Preset ${name} not found`);
        }

        // if the preset isn't found, returns undefined
        return preset;
    }

    /**
     * Retrieves the stored preset body by name.
     * @param {string} [name]
     * @returns {any}
     */
    getStoredPreset(name) {
        const presetName = this.resolvePresetName(name || this.getSelectedPresetName());
        const { presets, preset_names } = this.getPresetList();

        if (this.isKeyedApi()) {
            const index = preset_names.indexOf(presetName);
            return index !== -1 ? structuredClone(presets[index]) : undefined;
        }

        const index = preset_names[presetName];
        return index !== undefined ? structuredClone(presets[index]) : undefined;
    }

    /**
     * Deletes a preset by name. If not provided, deletes the currently selected preset.
     * @param {string} [name] Name of the preset to delete.
     */
    async deletePreset(name) {
        const { preset_names, presets } = this.getPresetList();
        const resolvedName = name ? this.resolvePresetName(name) : this.getSelectedPresetName();
        const value = name ? (this.isKeyedApi() ? this.findPreset(resolvedName) : resolvedName) : this.getSelectedPreset();
        const nameToDelete = resolvedName || this.getSelectedPresetName();

        if (value == 'gui') {
            toastr.info(t`Cannot delete GUI preset`);
            return;
        }

        if (this.isKeyedApi()) {
            $(this.select).find(`option[value="${value}"]`).remove();
            const index = preset_names.indexOf(nameToDelete);
            preset_names.splice(index, 1);
            presets.splice(index, 1);
        } else {
            const index = preset_names[nameToDelete];
            $(this.select).find(`option[value="${index}"]`).remove();
            delete preset_names[nameToDelete];
        }

        this.removeDeletedPresetFromGroups(nameToDelete);

        // switch in UI only when deleting currently selected preset
        const switchPresets = !name || areLookupNamesEqual(this.getSelectedPresetName(), nameToDelete);

        if (Object.keys(preset_names).length && switchPresets) {
            const nextPresetName = Object.keys(preset_names)[0];
            const newValue = preset_names[nextPresetName];
            $(this.select).find(`option[value="${newValue}"]`).attr('selected', 'true');
            $(this.select).trigger('change');
        }

        const response = await fetch('/api/presets/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: nameToDelete, apiId: this.apiId }),
        });

        return response.ok;
    }

    /**
     * Prompts for confirmation, deletes a preset, and wires the existing undo flow.
     * @param {string} [name]
     * @returns {Promise<boolean>}
     */
    async deletePresetInteractive(name) {
        const resolvedName = this.resolvePresetName(name || this.getSelectedPresetName());
        if (!this.canDeletePreset(resolvedName)) {
            return false;
        }

        const headerText = !this.isAdvancedFormatting() ? t`Delete this preset?` : t`Delete this template?`;
        const confirm = await Popup.show.confirm(headerText, t`This action is irreversible and your current settings will be overwritten.`);
        if (!confirm) {
            return false;
        }

        const presetSnapshot = this.getStoredPreset(resolvedName);
        const extensions = this.readPresetExtensionField({ name: resolvedName, path: '' });
        const result = await this.deletePreset(resolvedName);

        if (result) {
            const successToast = !this.isAdvancedFormatting() ? t`Preset deleted` : t`Template deleted`;
            const restoreErrorToast = !this.isAdvancedFormatting() ? t`Failed to restore preset.` : t`Failed to restore template.`;

            if (!presetSnapshot) {
                toastr.success(successToast);
                await eventSource.emit(event_types.PRESET_DELETED, { apiId: this.apiId, name: resolvedName });
                await deleteAllPresetState({ apiId: this.apiId, name: resolvedName });
                await maybeDeleteLinkedLorebookForPresetDeletion({ presetName: resolvedName, extensions });
            } else {
                showUndoToast({
                    message: successToast,
                    onUndo: async () => {
                        try {
                            await this.savePreset(resolvedName, structuredClone(presetSnapshot));
                        } catch (error) {
                            console.error('Failed to restore deleted preset', error);
                            toastr.error(restoreErrorToast);
                        }
                    },
                    onCommit: async () => {
                        await eventSource.emit(event_types.PRESET_DELETED, { apiId: this.apiId, name: resolvedName });
                        await deleteAllPresetState({ apiId: this.apiId, name: resolvedName });
                        await maybeDeleteLinkedLorebookForPresetDeletion({ presetName: resolvedName, extensions });
                    },
                });
            }
        } else {
            const warningToast = !this.isAdvancedFormatting() ? t`Preset was not deleted from server` : t`Template was not deleted from server`;
            toastr.warning(warningToast);
        }

        requestAsyncDiffForNextSettingsSave();
        saveSettingsDebounced();
        return result;
    }

    /**
     * Retrieves the default preset for the API from the server.
     * @param {string} name Name of the preset to restore
     * @returns {Promise<any>} Default preset object, or undefined if the request fails
     */
    async getDefaultPreset(name) {
        const response = await fetch('/api/presets/restore', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name, apiId: this.apiId }),
        });

        if (!response.ok) {
            const errorToast = !this.isAdvancedFormatting() ? t`Failed to restore default preset` : t`Failed to restore default template`;
            toastr.error(errorToast);
            return;
        }

        return await response.json();
    }

    /**
     * Reads a preset extension field from the preset.
     * @param {object} options
     * @param {string} [options.name] Name of the preset. If not provided, uses the currently selected preset name.
     * @param {string} options.path Path to the preset extension field, e.g. 'myextension.data'. If empty, reads the entire extensions object.
     * @return {any} The value of the preset extension field, or null if not found.
     */
    readPresetExtensionField({ name, path }) {
        const { settings } = this.getPresetList();
        const selectedName = this.getSelectedPresetName();
        const presetName = this.resolvePresetName(name || selectedName);

        // Read from settings if the selected preset is the same as the provided name
        if (settings && areLookupNamesEqual(selectedName, presetName)) {
            const settingsExtensions = ensurePlainObject(settings.extensions || {});
            return path ? lodash.get(settingsExtensions, path, null) : settingsExtensions;
        }

        // Otherwise, read from the preset by name
        const preset = this.getCompletionPresetByName(presetName);
        if (!preset) {
            return null;
        }

        const presetExtensions = ensurePlainObject(preset.extensions || {});
        const value = path ? lodash.get(presetExtensions, path, null) : presetExtensions;
        return value;
    }

    /**
     * Writes a value to a preset extension field.
     * @param {object} options
     * @param {string} [options.name] Name of the preset. If not provided, uses the currently selected preset name.
     * @param {string} options.path Path to the preset extension field, e.g. 'myextension.data'. If empty, writes to the root of the extensions object.
     * @param {any} options.value Value to write to the preset extension field.
     * @return {Promise<void>} Resolves when the preset is saved.
     */
    async writePresetExtensionField({ name, path, value }) {
        const { settings } = this.getPresetList();
        const selectedName = this.getSelectedPresetName();
        const presetName = this.resolvePresetName(name || selectedName);
        const selectedOption = $(this.select).find('option:selected');
        const isCharacterBoundOpenAIPreset = this.apiId === 'openai'
            && selectedOption.attr('data-luker-char-bound') === '1'
            && areLookupNamesEqual(selectedName, presetName);

        // Write to settings if the selected preset is the same as the provided name
        if (settings && areLookupNamesEqual(selectedName, presetName)) {
            // Set the value at the specified path
            settings.extensions = ensurePlainObject(settings.extensions || {});
            path ? lodash.set(settings.extensions, path, value) : (settings.extensions = value);
            await saveSettings();
        }

        // Also update the preset by name
        const preset = this.getCompletionPresetByName(presetName);
        if (!preset) {
            if (isCharacterBoundOpenAIPreset) {
                await syncCharacterBoundOpenAIPresetExtensionField({ presetName, path, value });
            }
            return;
        }

        // Set the value at the specified path
        preset.extensions = ensurePlainObject(preset.extensions || {});
        path ? lodash.set(preset.extensions, path, value) : (preset.extensions = value);

        // Save the updated preset
        await this.savePreset(presetName, preset, { skipUpdate: true });

        if (isCharacterBoundOpenAIPreset) {
            await syncCharacterBoundOpenAIPresetExtensionField({ presetName, path, value });
        }
    }

    // ===== Preset Group Methods =====

    /**
     * Gets preset groups for the current API.
     * @returns {Array<{id: string, name: string, presets: string[]}>}
     */
    getPresetGroups() {
        if (!power_user.preset_groups) {
            power_user.preset_groups = {};
        }
        if (!power_user.preset_groups[this.apiId]) {
            power_user.preset_groups[this.apiId] = [];
        }
        return power_user.preset_groups[this.apiId];
    }

    /**
     * Get the nesting depth of a preset group (0 = top-level).
     * @param {string} groupId
     * @returns {number}
     */
    getGroupDepth(groupId) {
        const groups = this.getPresetGroups();
        const groupMap = new Map(groups.map(g => [g.id, g]));
        let depth = 0;
        let current = groupMap.get(groupId);
        while (current && current.parentId) {
            depth++;
            current = groupMap.get(current.parentId);
            if (depth > 100) break; // guard against circular refs
        }
        return depth;
    }

    /**
     * Get direct child groups of a given preset group.
     * @param {string} groupId
     * @returns {Array}
     */
    getGroupChildren(groupId) {
        return this.getPresetGroups().filter(g => (g.parentId ?? null) === groupId);
    }

    /**
     * Check if a preset group is visible (all ancestor groups are expanded).
     * @param {string} groupId
     * @returns {boolean}
     */
    isGroupVisible(groupId) {
        const groups = this.getPresetGroups();
        const groupMap = new Map(groups.map(g => [g.id, g]));
        let current = groupMap.get(groupId);
        while (current && current.parentId) {
            const parent = groupMap.get(current.parentId);
            if (!parent) break; // orphaned, treat as visible
            if (parent.collapsed) return false;
            current = parent;
        }
        return true;
    }

    /**
     * Sort preset groups hierarchically: top-level first, then their children recursively.
     * @returns {Array}
     */
    getPresetGroupsSorted() {
        const groups = this.getPresetGroups();
        const topLevel = groups.filter(g => !g.parentId);
        const result = [];
        const addWithChildren = (parent) => {
            result.push(parent);
            const children = groups.filter(g => (g.parentId ?? null) === parent.id);
            for (const child of children) {
                addWithChildren(child);
            }
        };
        for (const g of topLevel) {
            addWithChildren(g);
        }
        // Include any orphaned groups
        const included = new Set(result.map(g => g.id));
        for (const g of groups) {
            if (!included.has(g.id)) {
                result.push(g);
            }
        }
        return result;
    }

    /**
     * Gets the group a preset belongs to, if any.
     * @param {string} presetName
     * @returns {{id: string, name: string, presets: string[]}|null}
     */
    getGroupForPreset(presetName) {
        return this.getPresetGroups().find(g => g.presets.includes(presetName)) || null;
    }

    /**
     * Creates a new preset group.
     * @param {string} name
     * @returns {string} The new group's ID
     */
    createPresetGroup(name, parentId = null) {
        const groups = this.getPresetGroups();
        const id = `pg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        groups.push({ id, name, presets: [], parentId });
        saveSettingsDebounced();
        return id;
    }

    /**
     * Renames a preset group.
     * @param {string} groupId
     * @param {string} newName
     */
    renamePresetGroup(groupId, newName) {
        const group = this.getPresetGroups().find(g => g.id === groupId);
        if (group) {
            group.name = newName;
            saveSettingsDebounced();
        }
    }

    /**
     * Deletes a preset group (presets become ungrouped).
     * @param {string} groupId
     */
    deletePresetGroup(groupId) {
        const groups = this.getPresetGroups();
        const index = groups.findIndex(g => g.id === groupId);
        if (index !== -1) {
            const deletedGroup = groups[index];
            // Move child groups up to the deleted group's parent
            const parentId = deletedGroup.parentId ?? null;
            for (const group of groups) {
                if ((group.parentId ?? null) === groupId) {
                    group.parentId = parentId || null;
                }
            }
            groups.splice(index, 1);
            saveSettingsDebounced();
        }
    }

    /**
     * Adds a preset to a group.
     * @param {string} presetName
     * @param {string} groupId
     */
    addPresetToGroup(presetName, groupId) {
        this.removePresetFromGroup(presetName, true);
        const group = this.getPresetGroups().find(g => g.id === groupId);
        if (group) {
            group.presets.push(presetName);
            saveSettingsDebounced();
        }
    }

    /**
     * Removes a preset from its group.
     * @param {string} presetName
     * @param {boolean} [skipSave=false]
     */
    removePresetFromGroup(presetName, skipSave = false) {
        for (const group of this.getPresetGroups()) {
            const index = group.presets.indexOf(presetName);
            if (index !== -1) {
                group.presets.splice(index, 1);
                break;
            }
        }
        if (!skipSave) {
            saveSettingsDebounced();
        }
    }

    /**
     * Rebuilds the select element with group structure.
     * Ungrouped presets go first, then each group as a collapsible section.
     */
    rebuildSelectWithGroups() {
        const $select = $(this.select);
        const currentValue = $select.val();
        const groups = this.getPresetGroups();
        const sortedGroups = this.getPresetGroupsSorted();

        if (!groups.length) {
            return;
        }

        // Collect all real options (skip existing group headers)
        const allOptions = [];
        $select.find('option').each((_, el) => {
            if (!el.dataset.presetGroupHeader) {
                // Strip leading indentation (non-breaking spaces) that may have
                // been added by a previous rebuild — textContent is used for
                // matching against group.presets which stores clean names
                const cleanText = el.textContent.replace(/^[\u00A0]+/, '');
                allOptions.push({
                    value: el.value,
                    text: cleanText,
                    selected: el.selected,
                    attrs: {},
                });
                // Preserve data-luker-char-bound if present
                if (el.getAttribute('data-luker-char-bound')) {
                    allOptions[allOptions.length - 1].attrs['data-luker-char-bound'] = el.getAttribute('data-luker-char-bound');
                }
            }
        });

        // Track which presets are in groups
        const groupedPresets = new Set();
        for (const group of groups) {
            for (const presetName of group.presets) {
                groupedPresets.add(presetName);
            }
        }

        // Clear and rebuild
        $select.empty();

        // Add ungrouped presets first
        for (const opt of allOptions) {
            if (!groupedPresets.has(opt.text)) {
                const $option = $('<option></option>').val(opt.value).text(opt.text);
                for (const [k, v] of Object.entries(opt.attrs)) {
                    $option.attr(k, v);
                }
                $select.append($option);
            }
        }

        // Add group headers and their presets (hierarchically)
        const renderGroup = (group, depth) => {
            const indent = '\u00A0'.repeat(depth * 3);
            const prefix = depth > 0 ? '└ ' : '';

            const $header = $('<option></option>')
                .val(`__group_header__${group.id}`)
                .text(indent + prefix + group.name)
                .attr('data-preset-group-id', group.id)
                .attr('data-preset-group-header', 'true')
                .attr('data-depth', depth);
            if (group.parentId) {
                $header.attr('data-preset-group-parent-id', group.parentId);
            }
            $header.prop('disabled', true);
            $select.append($header);

            for (const presetName of group.presets) {
                const opt = allOptions.find(o => o.text === presetName);
                if (opt) {
                    const $option = $('<option></option>')
                        .val(opt.value)
                        .text(opt.text)
                        .attr('data-preset-group-id', group.id)
                        .attr('data-preset-group-member', 'true')
                        .attr('data-depth', depth);
                    for (const [k, v] of Object.entries(opt.attrs)) {
                        $option.attr(k, v);
                    }
                    $select.append($option);
                }
            }

            // Render child groups
            const childGroups = this.getGroupChildren(group.id);
            for (const child of childGroups) {
                const childFromSorted = sortedGroups.find(g => g.id === child.id) || child;
                renderGroup(childFromSorted, depth + 1);
            }
        };

        // Render top-level groups and their descendants
        const topLevelGroups = sortedGroups.filter(g => !g.parentId);
        for (const group of topLevelGroups) {
            renderGroup(group, 0);
        }

        // Restore selection
        if (currentValue) {
            $select.val(currentValue);
        }

        // Refresh select2 if initialized
        if ($select.data('select2')) {
            $select.trigger('change.select2');
        }
    }

    /**
     * Updates group data when a preset is renamed.
     * @param {string} oldName
     * @param {string} newName
     */
    updatePresetNameInGroups(oldName, newName) {
        for (const group of this.getPresetGroups()) {
            const index = group.presets.indexOf(oldName);
            if (index !== -1) {
                group.presets[index] = newName;
                saveSettingsDebounced();
                break;
            }
        }
    }

    /**
     * Removes a preset from groups when deleted.
     * @param {string} presetName
     */
    removeDeletedPresetFromGroups(presetName) {
        let changed = false;
        for (const group of this.getPresetGroups()) {
            const index = group.presets.indexOf(presetName);
            if (index !== -1) {
                group.presets.splice(index, 1);
                changed = true;
                break;
            }
        }
        if (changed) {
            saveSettingsDebounced();
        }
    }
}

/**
 * Selects a preset by name for current API.
 * @param {any} _ Named arguments
 * @param {string} name Unnamed arguments
 * @returns {Promise<string>} Selected or current preset name
 */
async function presetCommandCallback(_, name) {
    const shouldReconnect = online_status !== 'no_connection';
    const presetManager = getPresetManager();
    const allPresets = presetManager.getAllPresets();
    const currentPreset = presetManager.getSelectedPresetName();

    if (!presetManager) {
        console.debug(`Preset Manager not found for API: ${main_api}`);
        return '';
    }

    if (!name) {
        console.log('No name provided for /preset command, using current preset');
        return currentPreset;
    }

    if (!Array.isArray(allPresets) || allPresets.length === 0) {
        console.log(`No presets found for API: ${main_api}`);
        return currentPreset;
    }

    // Find exact match
    const exactMatch = allPresets.find(p => p.toLowerCase().trim() === name.toLowerCase().trim());

    if (exactMatch) {
        console.log('Found exact preset match', exactMatch);

        if (currentPreset !== exactMatch) {
            const presetValue = presetManager.findPreset(exactMatch);

            if (presetValue) {
                presetManager.selectPreset(presetValue);
                shouldReconnect && await waitForConnection();
            }
        }

        return exactMatch;
    } else {
        // Find fuzzy match
        const fuse = new Fuse(allPresets);
        const fuzzyMatch = fuse.search(name);

        if (!fuzzyMatch.length) {
            console.warn(`WARN: Preset found with name ${name}`);
            return currentPreset;
        }

        const fuzzyPresetName = fuzzyMatch[0].item;
        const fuzzyPresetValue = presetManager.findPreset(fuzzyPresetName);

        if (fuzzyPresetValue) {
            console.log('Found fuzzy preset match', fuzzyPresetName);

            if (currentPreset !== fuzzyPresetName) {
                presetManager.selectPreset(fuzzyPresetValue);
                shouldReconnect && await waitForConnection();
            }
        }

        return fuzzyPresetName;
    }
}

/**
 * Waits for API connection to be established.
 */
async function waitForConnection() {
    try {
        await waitUntilCondition(() => online_status !== 'no_connection', 10000, 100);
    } catch {
        console.log('Timeout waiting for API to connect');
    }
}

export async function initPresetManager() {
    eventSource.on(event_types.CHAT_CHANGED, autoSelectPreset);
    registerPresetManagers();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'preset',
        callback: presetCommandCallback,
        returns: 'current preset',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'name',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: () => getPresetManager().getAllPresets().map(preset => new SlashCommandEnumValue(preset, null, enumTypes.enum, enumIcons.preset)),
            }),
        ],
        helpString: `
            <div>
                Sets a preset by name for the current API. Gets the current preset if no name is provided.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/preset myPreset</code></pre>
                    </li>
                    <li>
                        <pre><code>/preset</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));


    $(document).on('click', '[data-preset-manager-update]', async function () {
        const apiId = $(this).data('preset-manager-update');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        await presetManager.updatePreset();
    });

    $(document).on('click', '[data-preset-manager-new]', async function () {
        const apiId = $(this).data('preset-manager-new');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        await presetManager.savePresetAs();
    });

    $(document).on('click', '[data-preset-manager-rename]', async function () {
        const apiId = $(this).data('preset-manager-rename');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        const popupHeader = !presetManager.isAdvancedFormatting() ? t`Rename preset` : t`Rename template`;
        const oldName = presetManager.getSelectedPresetName();
        const newName = await getSanitizedFilename(await Popup.show.input(popupHeader, t`Enter a new name:`, oldName) || '');
        if (!newName || oldName === newName) {
            console.debug(!presetManager.isAdvancedFormatting() ? 'Preset rename cancelled' : 'Template rename cancelled');
            return;
        }
        if (equalsIgnoreCaseAndAccents(oldName, newName)) {
            toastr.warning(t`Name not accepted, as it is the same as before (ignoring case and accents).`, t`Rename Preset`);
            return;
        }

        await eventSource.emit(event_types.PRESET_RENAMED_BEFORE, { apiId: apiId, oldName: oldName, newName: newName });
        const extensions = presetManager.readPresetExtensionField({ name: oldName, path: '' });
        await presetManager.renamePreset(newName);
        await presetManager.writePresetExtensionField({ name: newName, path: '', value: extensions });
        presetManager.updatePresetNameInGroups(oldName, newName);
        presetManager.rebuildSelectWithGroups();
        await eventSource.emit(event_types.PRESET_RENAMED, { apiId: apiId, oldName: oldName, newName: newName });

        if (apiId === 'openai') {
            // This is a horrible mess, but prevents the renamed preset from being corrupted.
            $('#update_oai_preset').trigger('click');
            return;
        }

        const successToast = !presetManager.isAdvancedFormatting() ? t`Preset renamed` : t`Template renamed`;
        toastr.success(successToast);
    });

    $(document).on('click', '[data-preset-manager-export]', async function () {
        const apiId = $(this).data('preset-manager-export');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        const selected = $(presetManager.select).find('option:selected');
        const name = selected.text();
        const preset = presetManager.getPresetSettings(name);
        const data = JSON.stringify(preset, null, 4);
        download(data, `${name}.json`, 'application/json');
    });

    $(document).on('click', '[data-preset-manager-import]', async function () {
        const apiId = $(this).data('preset-manager-import');
        $(`[data-preset-manager-file="${apiId}"]`).trigger('click');
    });

    $(document).on('click', '[data-preset-manager-linked-lorebook]', async function () {
        const apiId = $(this).data('preset-manager-linked-lorebook');
        await managePresetLinkedLorebook(apiId);
    });

    $(document).on('click', '[data-preset-manager-reimport-regex]', async function () {
        const apiId = $(this).data('preset-manager-reimport-regex');
        const { reimportPresetEmbeddedRegexScripts } = await import('./extensions/regex/index.js');
        await reimportPresetEmbeddedRegexScripts(apiId);
    });

    $(document).on('change', '[data-preset-manager-file]', async function (e) {
        const apiId = $(this).data('preset-manager-file');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        const file = e.target.files[0];

        if (!file) {
            return;
        }

        const fileName = file.name.replace('.json', '').replace('.settings', '');
        const data = await parseJsonFile(file);
        const name = data?.name ?? fileName;
        data.name = name;

        await presetManager.savePreset(name, data);
        const successToast = !presetManager.isAdvancedFormatting() ? t`Preset imported` : t`Template imported`;
        toastr.success(successToast);
        e.target.value = null;
    });

    $(document).on('click', '[data-preset-manager-delete]', async function () {
        const apiId = $(this).data('preset-manager-delete');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        await presetManager.deletePresetInteractive();
    });

    $(document).on('click', '[data-preset-manager-restore]', async function () {
        const apiId = $(this).data('preset-manager-restore');
        const presetManager = getPresetManager(apiId);

        if (!presetManager) {
            console.warn(`Preset Manager not found for API: ${apiId}`);
            return;
        }

        const name = presetManager.getSelectedPresetName();
        const data = await presetManager.getDefaultPreset(name);

        if (name == 'gui') {
            toastr.info(t`Cannot restore GUI preset`);
            return;
        }

        if (!data) {
            return;
        }

        if (data.isDefault) {
            if (Object.keys(data.preset).length === 0) {
                const errorToast = !presetManager.isAdvancedFormatting() ? t`Default preset cannot be restored` : t`Default template cannot be restored`;
                toastr.error(errorToast);
                return;
            }

            const confirmText = !presetManager.isAdvancedFormatting()
                ? t`Resetting a <b>default preset</b> will restore the default settings.`
                : t`Resetting a <b>default template</b> will restore the default settings.`;
            const confirm = await Popup.show.confirm(t`Are you sure?`, confirmText);
            if (!confirm) {
                return;
            }

            await presetManager.deletePreset();
            await presetManager.savePreset(name, data.preset);
            const option = presetManager.findPreset(name);
            presetManager.selectPreset(option);
            const successToast = !presetManager.isAdvancedFormatting() ? t`Default preset restored` : t`Default template restored`;
            toastr.success(successToast);
        } else {
            const confirmText = !presetManager.isAdvancedFormatting()
                ? t`Resetting a <b>custom preset</b> will restore to the last saved state.`
                : t`Resetting a <b>custom template</b> will restore to the last saved state.`;
            const confirm = await Popup.show.confirm(t`Are you sure?`, confirmText);
            if (!confirm) {
                return;
            }

            const option = presetManager.findPreset(name);
            presetManager.selectPreset(option);
            const successToast = !presetManager.isAdvancedFormatting() ? t`Preset restored` : t`Template restored`;
            toastr.success(successToast);
        }
    });

    $('#af_master_import').on('click', () => {
        $('#af_master_import_file').trigger('click');
    });

    $('#af_master_import_file').on('change', async function (e) {
        if (!(e.target instanceof HTMLInputElement)) {
            return;
        }
        const file = e.target.files[0];

        if (!file) {
            return;
        }

        const data = await parseJsonFile(file);
        const fileName = file.name.replace('.json', '');
        await PresetManager.performMasterImport(data, fileName);
        e.target.value = null;
    });

    $('#af_master_export').on('click', async () => {
        const data = await PresetManager.performMasterExport();

        if (!data) {
            return;
        }

        const shortDate = new Date().toISOString().split('T')[0];
        download(data, `ST-formatting-${shortDate}.json`, 'application/json');
    });
}
