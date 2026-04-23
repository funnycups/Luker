import { DOMPurify, Fuse } from '../../../lib.js';

import { CONNECT_API_MAP, event_types, eventSource, main_api, online_status, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandAbortController } from '../../slash-commands/SlashCommandAbortController.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders, enumIcons } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandDebugController } from '../../slash-commands/SlashCommandDebugController.js';
import { enumTypes, SlashCommandEnumValue } from '../../slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommandScope } from '../../slash-commands/SlashCommandScope.js';
import { collapseSpaces, getUniqueName, isFalseBoolean, uuidv4, waitUntilCondition } from '../../utils.js';
import { t } from '../../i18n.js';
import { getSecretLabelById } from '../../secrets.js';
import { applyProxyProfileEntry, getCurrentProxyProfileEntry, oai_settings } from '../../openai.js';
import { initActionableSingleSelect } from '../../select2-actionable-single.js';

const MODULE_NAME = 'connection-manager';
const NONE = '<None>';
const EMPTY = '<Empty>';

const DEFAULT_SETTINGS = {
    profiles: [],
    selectedProfile: null,
};

// Commands that can record an empty value into the profile
const ALLOW_EMPTY = [
    'start-reply-with',
    'custom-include-body',
    'custom-exclude-body',
    'custom-include-headers',
];

const CC_COMMANDS = [
    'api',
    // Keep duplicated API application for legacy command sequencing consistency.
    'api',
    'api-url',
    'model',
    'proxy',
    'stop-strings',
    'start-reply-with',
    'reasoning-template',
    'prompt-post-processing',
    'function-calling-plain-text',
    'function-calling-plain-text-error-retry',
    'function-calling-plain-text-error-retry-max-attempts',
    'custom-include-body',
    'custom-exclude-body',
    'custom-include-headers',
    'secret-id',
];

const TC_COMMANDS = [
    'api',
    'preset',
    'api-url',
    'model',
    'sysprompt',
    'sysprompt-state',
    'instruct',
    'context',
    'instruct-state',
    'tokenizer',
    'stop-strings',
    'start-reply-with',
    'reasoning-template',
    'secret-id',
];

const FANCY_NAMES = {
    'api': 'API',
    'api-url': 'Server URL',
    'preset': 'Settings Preset',
    'model': 'Model',
    'proxy': 'Proxy Preset',
    'sysprompt-state': 'Use System Prompt',
    'sysprompt': 'System Prompt Name',
    'instruct-state': 'Instruct Mode',
    'instruct': 'Instruct Template',
    'context': 'Context Template',
    'tokenizer': 'Tokenizer',
    'stop-strings': 'Custom Stopping Strings',
    'start-reply-with': 'Start Reply With',
    'reasoning-template': 'Reasoning Template',
    'prompt-post-processing': 'Prompt Post-Processing',
    'function-calling-plain-text': 'Plain-text Function Calling',
    'function-calling-plain-text-error-retry': 'Retry malformed plain-text tool calls',
    'function-calling-plain-text-error-retry-max-attempts': 'Plain-text retry attempts',
    'custom-include-body': 'Include Body Parameters',
    'custom-exclude-body': 'Exclude Body Parameters',
    'custom-include-headers': 'Include Request Headers',
    'secret-id': 'Secret',
};

/**
 * A wrapper for the connection manager spinner.
 */
class ConnectionManagerSpinner {
    /**
     * @type {AbortController[]}
     */
    static abortControllers = [];

    /** @type {HTMLElement} */
    spinnerElement;

    /** @type {AbortController} */
    abortController = new AbortController();

    constructor() {
        // @ts-ignore
        this.spinnerElement = document.getElementById('connection_profile_spinner');
        this.abortController = new AbortController();
    }

    start() {
        ConnectionManagerSpinner.abortControllers.push(this.abortController);
        this.spinnerElement.classList.remove('hidden');
    }

    stop() {
        this.spinnerElement.classList.add('hidden');
    }

    isAborted() {
        return this.abortController.signal.aborted;
    }

    static abort() {
        for (const controller of ConnectionManagerSpinner.abortControllers) {
            controller.abort();
        }
        ConnectionManagerSpinner.abortControllers = [];
    }
}

/**
 * Get named arguments for the command callback.
 * @param {object} [args] Additional named arguments
 * @param {string} [args.force] Whether to force setting the value
 * @returns {object} Named arguments
 */
function getNamedArguments(args = {}) {
    // None of the commands here use underscored args, but better safe than sorry
    return {
        _scope: new SlashCommandScope(),
        _abortController: new SlashCommandAbortController(),
        _debugController: new SlashCommandDebugController(),
        _parserFlags: {},
        _hasUnnamedArgument: false,
        quiet: 'true',
        ...args,
    };
}

/** @type {() => SlashCommandEnumValue[]} */
const profilesProvider = () => [
    new SlashCommandEnumValue(NONE),
    ...extension_settings.connectionManager.profiles.map(p => new SlashCommandEnumValue(p.name, null, enumTypes.name, enumIcons.server)),
];

/**
 * @typedef {Object} ConnectionProfile
 * @property {string} id Unique identifier
 * @property {string} mode Mode of the connection profile
 * @property {string} [name] Name of the connection profile
 * @property {string} [api] API
 * @property {string} [preset] Settings Preset
 * @property {string} [model] Model
 * @property {string} [proxy] Proxy Preset
 * @property {string} ['proxy-url'] Reverse proxy URL snapshot
 * @property {string} ['proxy-password'] Reverse proxy password snapshot
 * @property {string} [instruct] Instruct Template
 * @property {string} [context] Context Template
 * @property {string} [instruct-state] Instruct Mode
 * @property {string} [tokenizer] Tokenizer
 * @property {string} [stop-strings] Custom Stopping Strings
 * @property {string} [start-reply-with] Start Reply With
 * @property {string} [reasoning-template] Reasoning Template
 * @property {string} [prompt-post-processing] Prompt Post-Processing
 * @property {string} [function-calling-plain-text] Plain-text Function Calling
 * @property {string} [function-calling-plain-text-error-retry] Retry malformed plain-text tool calls
 * @property {string} [function-calling-plain-text-error-retry-max-attempts] Plain-text retry attempts
 * @property {string} [custom-include-body] Include Body Parameters
 * @property {string} [custom-exclude-body] Exclude Body Parameters
 * @property {string} [custom-include-headers] Include Request Headers
 * @property {string} [sysprompt] System Prompt Name
 * @property {string} [sysprompt-state] Use System Prompt
 * @property {string} [api-url] Server URL
 * @property {string} [secret-id] Secret ID
 * @property {string[]} [exclude] Commands to exclude
 */

/**
 * Finds the best match for the search value.
 * @param {string} value Search value
 * @returns {ConnectionProfile|null} Best match or null
 */
function findProfileByName(value) {
    // Try to find exact match
    const profile = extension_settings.connectionManager.profiles.find(p => p.name === value);

    if (profile) {
        return profile;
    }

    // Try to find fuzzy match
    const fuse = new Fuse(extension_settings.connectionManager.profiles, { keys: ['name'] });
    const results = fuse.search(value);

    if (results.length === 0) {
        return null;
    }

    const bestMatch = results[0];
    return bestMatch.item;
}

/**
 * Parses a profile boolean value.
 * @param {unknown} value
 * @returns {boolean|null}
 */
function parseProfileBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return null;
}

/**
 * Parses a profile integer value.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseProfileInteger(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return null;
    }
    return Math.min(Math.max(Math.round(numeric), 1), 10);
}

function getCommandsForMode(mode) {
    return mode === 'cc' ? CC_COMMANDS : TC_COMMANDS;
}

function resolveProfileMode(profile) {
    const explicitMode = String(profile?.mode || '').trim().toLowerCase();
    if (explicitMode === 'cc' || explicitMode === 'tc') {
        return explicitMode;
    }

    const apiAlias = String(profile?.api || '').trim().toLowerCase();
    const selectedApi = String(CONNECT_API_MAP?.[apiAlias]?.selected || '').trim().toLowerCase();
    if (selectedApi === 'openai') {
        return 'cc';
    }
    if (selectedApi) {
        return 'tc';
    }

    return main_api === 'openai' ? 'cc' : 'tc';
}

function normalizeConnectionProfile(profile) {
    if (!profile || typeof profile !== 'object') {
        return false;
    }

    let mutated = false;
    const nextMode = resolveProfileMode(profile);
    if (profile.mode !== nextMode) {
        profile.mode = nextMode;
        mutated = true;
    }

    if (profile['stop-strings'] === '') {
        delete profile['stop-strings'];
        mutated = true;
    }

    if (Object.hasOwn(profile, 'regex-preset')) {
        delete profile['regex-preset'];
        mutated = true;
    }

    const activeCommands = new Set(getCommandsForMode(nextMode));
    const opposingCommands = (nextMode === 'cc' ? TC_COMMANDS : CC_COMMANDS)
        .filter(command => !activeCommands.has(command));

    for (const command of opposingCommands) {
        if (Object.hasOwn(profile, command)) {
            delete profile[command];
            mutated = true;
        }
    }

    if (!Array.isArray(profile.exclude)) {
        if (profile.exclude !== undefined) {
            profile.exclude = [];
            mutated = true;
        }
        return mutated;
    }

    const nextExclude = profile.exclude.filter(command => activeCommands.has(command));
    if (nextExclude.length !== profile.exclude.length) {
        profile.exclude = nextExclude;
        mutated = true;
    }

    return mutated;
}

function getCommandsForProfile(profile) {
    return getCommandsForMode(resolveProfileMode(profile));
}

/**
 * Clamps the plain-text retry attempts value.
 * @param {unknown} value
 * @returns {number}
 */
function clampPlainTextRetryAttempts(value) {
    const parsed = parseProfileInteger(value);
    return parsed ?? 3;
}

/**
 * Sets one command on the connection profile and ensures it is not excluded.
 * @param {ConnectionProfile} profile
 * @param {string} command
 * @param {string} value
 */
function setProfileCommandValue(profile, command, value) {
    profile[command] = value;
    if (!Array.isArray(profile.exclude)) {
        profile.exclude = [];
    }
    profile.exclude = profile.exclude.filter(entry => entry !== command);
}

/**
 * Reads the connection profile from the commands.
 * @param {string} mode Mode of the connection profile
 * @param {ConnectionProfile} profile Connection profile
 * @param {boolean} [cleanUp] Whether to clean up the profile
 */
async function readProfileFromCommands(mode, profile, cleanUp = false) {
    const commands = getCommandsForMode(mode);
    const opposingCommands = mode === 'cc' ? TC_COMMANDS : CC_COMMANDS;
    const excludeList = Array.isArray(profile.exclude) ? profile.exclude : [];
    for (const command of commands) {
        try {
            if (excludeList.includes(command)) {
                continue;
            }

            if (command === 'proxy') {
                const proxyEntry = getCurrentProxyProfileEntry({ persist: true });
                if (proxyEntry.name || proxyEntry.url || proxyEntry.password) {
                    profile.proxy = proxyEntry.name || '';
                    profile['proxy-url'] = proxyEntry.url;
                    profile['proxy-password'] = proxyEntry.password;
                } else {
                    profile.proxy = 'None';
                    delete profile['proxy-url'];
                    delete profile['proxy-password'];
                }
                continue;
            }

            const allowEmpty = ALLOW_EMPTY.includes(command);
            const args = getNamedArguments();
            const result = await SlashCommandParser.commands[command].callback(args, '');
            if (result || (allowEmpty && result === '')) {
                profile[command] = result;
                continue;
            }
        } catch (error) {
            console.error(`Failed to execute command: ${command}`, error);
        }
    }

    if (cleanUp) {
        for (const command of commands) {
            if (command.endsWith('-state') && profile[command] === 'false') {
                delete profile[command.replace('-state', '')];
            }
        }
        for (const command of opposingCommands) {
            if (commands.includes(command)) {
                continue;
            }

            delete profile[command];
        }
    }
}

/**
 * Creates a new connection profile.
 * @param {string} [forceName] Name of the connection profile
 * @returns {Promise<ConnectionProfile>} Created connection profile
 */
async function createConnectionProfile(forceName = null) {
    const mode = main_api === 'openai' ? 'cc' : 'tc';
    const id = uuidv4();
    /** @type {ConnectionProfile} */
    const profile = {
        id,
        mode,
        exclude: [],
    };

    await readProfileFromCommands(mode, profile);

    const profileForDisplay = makeFancyProfile(profile);
    const template = $(await renderExtensionTemplateAsync(MODULE_NAME, 'profile', { profile: profileForDisplay }));
    template.find('input[name="exclude"]').on('input', function () {
        const fancyName = String($(this).val());
        const keyName = Object.entries(FANCY_NAMES).find(x => x[1] === fancyName)?.[0];
        if (!keyName) {
            console.warn('Key not found for fancy name:', fancyName);
            return;
        }

        if (!Array.isArray(profile.exclude)) {
            profile.exclude = [];
        }

        const excludeState = !$(this).prop('checked');
        if (excludeState) {
            profile.exclude.push(keyName);
        } else {
            const index = profile.exclude.indexOf(keyName);
            index !== -1 && profile.exclude.splice(index, 1);
        }
    });
    const isNameTaken = (n) => extension_settings.connectionManager.profiles.some(p => p.name === n);
    const suggestedName = getUniqueName(collapseSpaces(`${profile.api ?? ''} ${profile.model ?? ''} - ${profile.preset ?? ''}`), isNameTaken);
    let name = forceName ?? await callGenericPopup(template, POPUP_TYPE.INPUT, suggestedName);
    // If it's cancelled, it will be false
    if (!name) {
        return null;
    }
    name = DOMPurify.sanitize(String(name));
    if (!name) {
        toastr.error('Name cannot be empty.');
        return null;
    }

    if (isNameTaken(name) || name === NONE) {
        toastr.error('A profile with the same name already exists.');
        return null;
    }

    if (Array.isArray(profile.exclude)) {
        for (const command of profile.exclude) {
            delete profile[command];
        }
    }

    profile.name = String(name);
    return profile;
}

/**
 * Deletes the selected connection profile.
 * @returns {Promise<void>}
 */
async function deleteConnectionProfile(profileId = extension_settings.connectionManager.selectedProfile) {
    const selectedProfile = String(profileId || '');
    if (!selectedProfile) {
        return false;
    }

    const index = extension_settings.connectionManager.profiles.findIndex(p => p.id === selectedProfile);
    if (index === -1) {
        return false;
    }

    const profile = extension_settings.connectionManager.profiles[index];
    const name = profile.name;
    const confirm = await Popup.show.confirm(t`Are you sure you want to delete the selected profile?`, name);

    if (!confirm) {
        return false;
    }

    extension_settings.connectionManager.profiles.splice(index, 1);
    if (extension_settings.connectionManager.selectedProfile === selectedProfile) {
        extension_settings.connectionManager.selectedProfile = null;
    }
    saveSettingsDebounced();

    await eventSource.emit(event_types.CONNECTION_PROFILE_DELETED, profile);
    return true;
}

/**
 * Formats the connection profile for display.
 * @param {ConnectionProfile} profile Connection profile
 * @returns {Object} Fancy profile
 */
function makeFancyProfile(profile) {
    return Object.entries(FANCY_NAMES).reduce((acc, [key, value]) => {
        const allowEmpty = ALLOW_EMPTY.includes(key);
        if (!profile[key]) {
            if (profile[key] === '' && allowEmpty) {
                acc[value] = EMPTY;
            }
            return acc;
        }

        // UUID is not very useful in the UI, so we replace it with a label (if available)
        if (key === 'secret-id') {
            const label = getSecretLabelById(profile[key]);
            if (label) {
                acc[value] = label;
                return acc;
            }
        }

        acc[value] = profile[key];
        return acc;
    }, {});
}

/**
 * Applies the connection profile.
 * @param {ConnectionProfile} profile Connection profile
 * @returns {Promise<void>}
 */
async function applyConnectionProfile(profile) {
    if (!profile) {
        return;
    }

    const normalized = normalizeConnectionProfile(profile);
    if (normalized) {
        saveSettingsDebounced();
    }

    // Abort any ongoing profile application
    ConnectionManagerSpinner.abort();

    const mode = resolveProfileMode(profile);
    const commands = getCommandsForMode(mode);
    const spinner = new ConnectionManagerSpinner();
    spinner.start();

    for (const command of commands) {
        if (spinner.isAborted()) {
            throw new Error('Profile application aborted');
        }

        if (command === 'proxy' && (Object.hasOwn(profile, 'proxy-url') || Object.hasOwn(profile, 'proxy-password'))) {
            applyProxyProfileEntry({
                name: String(profile.proxy || ''),
                url: String(profile['proxy-url'] || ''),
                password: String(profile['proxy-password'] || ''),
            });
            continue;
        }

        const argument = profile[command];
        const allowEmpty = ALLOW_EMPTY.includes(command);
        if (!argument && !(allowEmpty && argument === '')) {
            continue;
        }
        try {
            const args = getNamedArguments(allowEmpty ? { force: 'true' } : {});
            await SlashCommandParser.commands[command].callback(args, argument);
        } catch (error) {
            console.error(`Failed to execute command: ${command} ${argument}`, error);
        }
    }

    spinner.stop();
}

/**
 * Updates the selected connection profile.
 * @param {ConnectionProfile} profile Connection profile
 * @returns {Promise<void>}
 */
async function updateConnectionProfile(profile) {
    profile.mode = main_api === 'openai' ? 'cc' : 'tc';
    await readProfileFromCommands(profile.mode, profile, true);
}

/**
 * Renders the connection profile details.
 * @param {HTMLSelectElement} profiles Select element containing connection profiles
 */
function renderConnectionProfiles(profiles) {
    profiles.innerHTML = '';
    const noneOption = document.createElement('option');

    noneOption.value = '';
    noneOption.textContent = NONE;
    noneOption.selected = !extension_settings.connectionManager.selectedProfile;
    profiles.appendChild(noneOption);

    for (const profile of extension_settings.connectionManager.profiles.sort((a, b) => a.name.localeCompare(b.name))) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name;
        option.selected = profile.id === extension_settings.connectionManager.selectedProfile;
        profiles.appendChild(option);
    }

    profiles.value = extension_settings.connectionManager.selectedProfile || '';
    if ($(profiles).data('select2')) {
        $(profiles).trigger('change.select2');
    }
}

/**
 * Renders the content of the details element.
 * @param {HTMLElement} detailsContent Content element of the details
 */
async function renderDetailsContent(detailsContent) {
    detailsContent.innerHTML = '';
    if (detailsContent.classList.contains('hidden')) {
        return;
    }
    const selectedProfile = extension_settings.connectionManager.selectedProfile;
    const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
    if (profile) {
        const profileForDisplay = makeFancyProfile(profile);
        const templateParams = { profile: profileForDisplay };
        if (Array.isArray(profile.exclude) && profile.exclude.length > 0) {
            templateParams.omitted = profile.exclude.map(e => FANCY_NAMES[e]).join(', ');
        }
        const template = await renderExtensionTemplateAsync(MODULE_NAME, 'view', templateParams);
        detailsContent.innerHTML = template;
    } else {
        detailsContent.textContent = t`No profile selected`;
    }
}

(async function () {
    extension_settings.connectionManager = extension_settings.connectionManager || structuredClone(DEFAULT_SETTINGS);

    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (extension_settings.connectionManager[key] === undefined) {
            extension_settings.connectionManager[key] = DEFAULT_SETTINGS[key];
        }
    }

    // Luker: fully decouple connection profiles from chat-completion presets and regex presets.
    // Legacy profiles might still carry stale fields or invalid mode metadata.
    let migrated = false;
    if (Array.isArray(extension_settings.connectionManager.profiles)) {
        for (const profile of extension_settings.connectionManager.profiles) {
            migrated = normalizeConnectionProfile(profile) || migrated;
        }
    }
    if (migrated) {
        saveSettingsDebounced();
    }

    const container = document.getElementById('rm_api_block');
    const settings = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    container.insertAdjacentHTML('afterbegin', settings);

    /** @type {HTMLSelectElement} */
    // @ts-ignore
    const profiles = document.getElementById('connection_profiles');
    const detailsContent = document.getElementById('connection_profile_details_content');
    const viewDetails = document.getElementById('view_connection_profile');
    const plainTextFunctionCallingToggle = document.getElementById('connection_profile_function_calling_plain_text');
    const plainTextFunctionCallingErrorRetryToggle = document.getElementById('connection_profile_function_calling_plain_text_error_retry');
    const plainTextFunctionCallingRetryAttemptsInput = document.getElementById('connection_profile_function_calling_plain_text_error_retry_max_attempts');
    renderConnectionProfiles(profiles);
    initActionableSingleSelect(profiles, {
        searchInputPlaceholder: t`Search...`,
        deleteButtonTitle: t`Delete connection profile`,
        canDelete: ({ value }) => Boolean(value),
        onDelete: async ({ value }) => {
            const deletedSelected = extension_settings.connectionManager.selectedProfile === value;
            const deleted = await deleteConnectionProfile(value);
            if (!deleted) {
                return;
            }

            renderConnectionProfiles(profiles);
            await renderDetailsContent(detailsContent);
            toggleProfileSpecificButtons();

            if (deletedSelected) {
                await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, NONE);
            }
        },
    });

    /**
     * @returns {ConnectionProfile|null}
     */
    function getSelectedProfile() {
        const selectedProfileId = extension_settings.connectionManager.selectedProfile;
        return extension_settings.connectionManager.profiles.find(p => p.id === selectedProfileId) || null;
    }

    function syncPlainTextFunctionCallingControls() {
        if (!plainTextFunctionCallingToggle || !plainTextFunctionCallingErrorRetryToggle || !plainTextFunctionCallingRetryAttemptsInput) {
            return;
        }
        const profile = getSelectedProfile();
        const globalValue = Boolean(oai_settings.function_calling_plain_text);
        const globalRetryValue = Boolean(oai_settings.function_calling_plain_text_error_retry);
        const globalRetryAttempts = clampPlainTextRetryAttempts(oai_settings.function_calling_plain_text_error_retry_max_attempts);
        const profileMode = profile ? resolveProfileMode(profile) : '';
        const supported = !profile || profileMode === 'cc';
        const parsed = profileMode === 'cc' && profile
            ? parseProfileBoolean(profile['function-calling-plain-text'])
            : null;
        const parsedRetry = profileMode === 'cc' && profile
            ? parseProfileBoolean(profile['function-calling-plain-text-error-retry'])
            : null;
        const parsedRetryAttempts = profileMode === 'cc' && profile
            ? parseProfileInteger(profile['function-calling-plain-text-error-retry-max-attempts'])
            : null;
        const plainTextEnabled = parsed ?? globalValue;
        const retryEnabled = parsedRetry ?? globalRetryValue;

        plainTextFunctionCallingToggle.disabled = !supported;
        plainTextFunctionCallingToggle.checked = plainTextEnabled;
        plainTextFunctionCallingErrorRetryToggle.disabled = !supported || !plainTextEnabled;
        plainTextFunctionCallingErrorRetryToggle.checked = retryEnabled;
        plainTextFunctionCallingRetryAttemptsInput.disabled = !supported || !plainTextEnabled || !retryEnabled;
        plainTextFunctionCallingRetryAttemptsInput.value = String(parsedRetryAttempts ?? globalRetryAttempts);
    }

    async function applySelectedProfileMutation(mutator) {
        const profile = getSelectedProfile();
        if (!profile || resolveProfileMode(profile) !== 'cc') {
            syncPlainTextFunctionCallingControls();
            return false;
        }

        const oldProfile = structuredClone(profile);
        mutator(profile);

        try {
            await applyConnectionProfile(profile);
        } catch (error) {
            console.error('Failed to apply profile after plain-text function calling change', error);
        }

        saveSettingsDebounced();
        await renderDetailsContent(detailsContent);
        await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, oldProfile, profile);
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, profile.name);
        syncPlainTextFunctionCallingControls();
        return true;
    }

    function toggleProfileSpecificButtons() {
        const profileId = extension_settings.connectionManager.selectedProfile;
        const profileSpecificButtons = ['update_connection_profile', 'reload_connection_profile', 'delete_connection_profile'];
        profileSpecificButtons.forEach(id => document.getElementById(id).classList.toggle('disabled', !profileId));
        syncPlainTextFunctionCallingControls();
    }
    toggleProfileSpecificButtons();

    if (plainTextFunctionCallingToggle && plainTextFunctionCallingErrorRetryToggle && plainTextFunctionCallingRetryAttemptsInput) {
        plainTextFunctionCallingToggle.addEventListener('input', async () => {
            const profile = getSelectedProfile();
            if (!profile) {
                oai_settings.function_calling_plain_text = !!plainTextFunctionCallingToggle.checked;
                saveSettingsDebounced();
                syncPlainTextFunctionCallingControls();
                return;
            }
            if (resolveProfileMode(profile) !== 'cc') {
                syncPlainTextFunctionCallingControls();
                return;
            }

            await applySelectedProfileMutation((selectedProfile) => {
                setProfileCommandValue(selectedProfile, 'function-calling-plain-text', plainTextFunctionCallingToggle.checked ? 'true' : 'false');
            });
        });

        plainTextFunctionCallingErrorRetryToggle.addEventListener('input', async () => {
            const profile = getSelectedProfile();
            if (!profile) {
                oai_settings.function_calling_plain_text_error_retry = !!plainTextFunctionCallingErrorRetryToggle.checked;
                saveSettingsDebounced();
                syncPlainTextFunctionCallingControls();
                return;
            }
            if (resolveProfileMode(profile) !== 'cc') {
                syncPlainTextFunctionCallingControls();
                return;
            }

            await applySelectedProfileMutation((selectedProfile) => {
                setProfileCommandValue(selectedProfile, 'function-calling-plain-text-error-retry', plainTextFunctionCallingErrorRetryToggle.checked ? 'true' : 'false');
            });
        });

        plainTextFunctionCallingRetryAttemptsInput.addEventListener('input', async () => {
            const value = clampPlainTextRetryAttempts(plainTextFunctionCallingRetryAttemptsInput.value);
            plainTextFunctionCallingRetryAttemptsInput.value = String(value);

            const profile = getSelectedProfile();
            if (!profile) {
                oai_settings.function_calling_plain_text_error_retry_max_attempts = value;
                saveSettingsDebounced();
                syncPlainTextFunctionCallingControls();
                return;
            }
            if (resolveProfileMode(profile) !== 'cc') {
                syncPlainTextFunctionCallingControls();
                return;
            }

            await applySelectedProfileMutation((selectedProfile) => {
                setProfileCommandValue(selectedProfile, 'function-calling-plain-text-error-retry-max-attempts', String(value));
            });
        });
    }

    // Refresh function calling controls when main API changes (cc <-> tc)
    eventSource.on(event_types.MAIN_API_CHANGED, () => {
        syncPlainTextFunctionCallingControls();
    });

    $(profiles).on('change', async function () {
        const profileId = String(profiles.value || '');
        extension_settings.connectionManager.selectedProfile = profileId;
        saveSettingsDebounced();
        await renderDetailsContent(detailsContent);

        toggleProfileSpecificButtons();

        // None option selected
        if (!profileId) {
            await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, NONE);
            return;
        }

        const profile = extension_settings.connectionManager.profiles.find(p => p.id === profileId);

        if (!profile) {
            console.log(`Profile not found: ${profileId}`);
            return;
        }

        await applyConnectionProfile(profile);
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, profile.name);
    });

    const reloadButton = document.getElementById('reload_connection_profile');
    reloadButton.addEventListener('click', async () => {
        const selectedProfile = extension_settings.connectionManager.selectedProfile;
        const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
        if (!profile) {
            console.log('No profile selected');
            return;
        }
        await applyConnectionProfile(profile);
        await renderDetailsContent(detailsContent);
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, profile.name);
        toastr.success('Connection profile reloaded', '', { timeOut: 1500 });
    });

    const createButton = document.getElementById('create_connection_profile');
    createButton.addEventListener('click', async () => {
        const profile = await createConnectionProfile();
        if (!profile) {
            return;
        }
        extension_settings.connectionManager.profiles.push(profile);
        extension_settings.connectionManager.selectedProfile = profile.id;
        saveSettingsDebounced();
        renderConnectionProfiles(profiles);
        await renderDetailsContent(detailsContent);
        toggleProfileSpecificButtons();
        await eventSource.emit(event_types.CONNECTION_PROFILE_CREATED, profile);
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, profile.name);
    });

    const updateButton = document.getElementById('update_connection_profile');
    updateButton.addEventListener('click', async () => {
        const selectedProfile = extension_settings.connectionManager.selectedProfile;
        const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
        if (!profile) {
            console.log('No profile selected');
            return;
        }
        const oldProfile = structuredClone(profile);
        await updateConnectionProfile(profile);
        await renderDetailsContent(detailsContent);
        saveSettingsDebounced();
        toggleProfileSpecificButtons();
        await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, oldProfile, profile);
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, profile.name);
        toastr.success('Connection profile updated', '', { timeOut: 1500 });
    });

    const deleteButton = document.getElementById('delete_connection_profile');
    deleteButton.addEventListener('click', async () => {
        const deleted = await deleteConnectionProfile();
        if (!deleted) {
            return;
        }
        renderConnectionProfiles(profiles);
        await renderDetailsContent(detailsContent);
        toggleProfileSpecificButtons();
        await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, NONE);
    });

    const editButton = document.getElementById('edit_connection_profile');
    editButton.addEventListener('click', async () => {
        const selectedProfile = extension_settings.connectionManager.selectedProfile;
        const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
        if (!profile) {
            console.log('No profile selected');
            return;
        }
        if (!Array.isArray(profile.exclude)) {
            profile.exclude = [];
        }

        let saveChanges = false;
        const sortByViewOrder = (a, b) => Object.keys(FANCY_NAMES).indexOf(a) - Object.keys(FANCY_NAMES).indexOf(b);
        const commands = getCommandsForProfile(profile);
        const settings = commands.slice().sort(sortByViewOrder).reduce((acc, command) => {
            const fancyName = FANCY_NAMES[command];
            acc[fancyName] = !profile.exclude.includes(command);
            return acc;
        }, {});
        const template = $(await renderExtensionTemplateAsync(MODULE_NAME, 'edit', { name: profile.name, settings }));
        let newName = await callGenericPopup(template, POPUP_TYPE.INPUT, profile.name, {
            customButtons: [{
                text: t`Save and Update`,
                classes: ['popup-button-ok'],
                result: POPUP_RESULT.AFFIRMATIVE,
                action: () => {
                    saveChanges = true;
                },
            }],
        });

        // If it's cancelled, it will be false
        if (!newName) {
            return;
        }
        newName = DOMPurify.sanitize(String(newName));
        if (!newName) {
            toastr.error('Name cannot be empty.');
            return;
        }

        if (profile.name !== newName && extension_settings.connectionManager.profiles.some(p => p.name === newName)) {
            toastr.error('A profile with the same name already exists.');
            return;
        }

        const newExcludeList = template.find('input[name="exclude"]:not(:checked)').map(function () {
            return Object.entries(FANCY_NAMES).find(x => x[1] === String($(this).val()))?.[0];
        }).get();

        const oldProfile = structuredClone(profile);
        if (newExcludeList.length !== profile.exclude.length || !newExcludeList.every(e => profile.exclude.includes(e))) {
            profile.exclude = newExcludeList;
            for (const command of newExcludeList) {
                delete profile[command];
            }
            if (saveChanges) {
                await updateConnectionProfile(profile);
            } else {
                toastr.info('Press "Update" to record them into the profile.', 'Included settings list updated');
            }
        }

        if (profile.name !== newName) {
            toastr.success('Connection profile renamed.');
            profile.name = newName;
        }

        saveSettingsDebounced();
        await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, oldProfile, profile);
        renderConnectionProfiles(profiles);
        await renderDetailsContent(detailsContent);
        toggleProfileSpecificButtons();
    });

    viewDetails.addEventListener('click', async () => {
        viewDetails.classList.toggle('active');
        detailsContent.classList.toggle('hidden');
        await renderDetailsContent(detailsContent);
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'profile',
        helpString: 'Switch to a connection profile or return the name of the current profile in no argument is provided. Use <code>&lt;None&gt;</code> to switch to no profile.',
        returns: 'name of the profile',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Name of the connection profile',
                enumProvider: profilesProvider,
                isRequired: false,
            }),
        ],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'await',
                description: 'Wait for the connection profile to be applied before returning.',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'timeout',
                description: 'Maximum time to wait for the API connection to be established, in milliseconds. Set to 0 to disable. Only applies when await=true.',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: '2000',
            }),
        ],
        callback: async (args, value) => {
            if (!value || typeof value !== 'string') {
                const selectedProfile = extension_settings.connectionManager.selectedProfile;
                const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
                if (!profile) {
                    return NONE;
                }
                return profile.name;
            }

            if (value === NONE) {
                profiles.selectedIndex = 0;
                profiles.dispatchEvent(new Event('change'));
                return NONE;
            }

            const profile = findProfileByName(value);

            if (!profile) {
                return '';
            }

            const shouldAwait = !isFalseBoolean(String(args?.await));
            const awaitPromise = new Promise((resolve) => eventSource.once(event_types.CONNECTION_PROFILE_LOADED, resolve));

            profiles.selectedIndex = Array.from(profiles.options).findIndex(o => o.value === profile.id);
            profiles.dispatchEvent(new Event('change'));

            if (shouldAwait) {
                await awaitPromise;

                // We should also await the connection to be established
                const parsedTimeout = parseInt(args?.timeout?.toString());
                const timeout = !isNaN(parsedTimeout) ? Math.max(0, parsedTimeout) : 2000;
                if (timeout > 0) {
                    await waitUntilCondition(() => online_status !== 'no_connection', timeout, 100, { rejectOnTimeout: false });
                }
            }

            return profile.name;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'profile-list',
        helpString: 'List all connection profile names.',
        returns: 'list of profile names',
        callback: () => JSON.stringify(extension_settings.connectionManager.profiles.map(p => p.name)),
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'profile-create',
        returns: 'name of the new profile',
        helpString: 'Create a new connection profile using the current settings.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'name of the new connection profile',
                isRequired: true,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        callback: async (_args, name) => {
            if (!name || typeof name !== 'string') {
                toastr.warning('Please provide a name for the new connection profile.');
                return '';
            }
            const profile = await createConnectionProfile(name);
            if (!profile) {
                return '';
            }
            extension_settings.connectionManager.profiles.push(profile);
            extension_settings.connectionManager.selectedProfile = profile.id;
            saveSettingsDebounced();
            renderConnectionProfiles(profiles);
            await renderDetailsContent(detailsContent);
            await eventSource.emit(event_types.CONNECTION_PROFILE_CREATED, profile);
            return profile.name;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'profile-update',
        helpString: 'Update the selected connection profile.',
        callback: async () => {
            const selectedProfile = extension_settings.connectionManager.selectedProfile;
            const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
            if (!profile) {
                toastr.warning('No profile selected.');
                return '';
            }
            const oldProfile = structuredClone(profile);
            await updateConnectionProfile(profile);
            await renderDetailsContent(detailsContent);
            saveSettingsDebounced();
            await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, oldProfile, profile);
            return profile.name;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'profile-get',
        helpString: 'Get the details of the connection profile. Returns the selected profile if no argument is provided.',
        returns: 'object of the selected profile',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Name of the connection profile',
                enumProvider: profilesProvider,
                isRequired: false,
            }),
        ],
        callback: async (_args, value) => {
            if (!value || typeof value !== 'string') {
                const selectedProfile = extension_settings.connectionManager.selectedProfile;
                const profile = extension_settings.connectionManager.profiles.find(p => p.id === selectedProfile);
                if (!profile) {
                    return '';
                }
                return JSON.stringify(profile);
            }

            const profile = findProfileByName(value);
            if (!profile) {
                return '';
            }
            return JSON.stringify(profile);
        },
    }));
})();
