import { DOMPurify, Fuse } from '../../../lib.js';

import { activateSendButtons, CONNECT_API_MAP, deactivateSendButtons, event_types, eventSource, main_api, online_status, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandAbortController } from '../../slash-commands/SlashCommandAbortController.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders, enumIcons } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandDebugController } from '../../slash-commands/SlashCommandDebugController.js';
import { enumTypes, SlashCommandEnumValue } from '../../slash-commands/SlashCommandEnumValue.js';
import { SlashCommandClosure } from '../../slash-commands/SlashCommandClosure.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommandScope } from '../../slash-commands/SlashCommandScope.js';
import { collapseSpaces, getUniqueName, isFalseBoolean, isTrueBoolean, uuidv4, waitUntilCondition } from '../../utils.js';
import { t } from '../../i18n.js';
import { getSecretLabelById } from '../../secrets.js';
import { applyProxyProfileEntry, getCurrentProxyProfileEntry, oai_settings } from '../../openai.js';
import { initActionableSingleSelect } from '../../select2-actionable-single.js';
import { performFuzzySearch } from '/scripts/power-user.js';
import { StreamingDisplay } from '/scripts/streaming-display.js';
import { ConnectionManagerRequestService } from '../shared.js';
import { formatReasoning } from '/scripts/reasoning.js';

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

// Pure-data fields stored on embedding-mode profiles. These are NOT slash commands —
// embedding profiles are not "applied" globally; consumers look them up by id and
// hand them to the EmbeddingService. The list is used by normalize / FANCY_NAMES.
const EMBED_COMMANDS = [
    'source',
    'model',
    'api-url',
    'proxy-password',
    'secret-id',
    // Per-provider knobs:
    'jina-late-chunking',
    'jina-dimensions',
    'jina-task',
    'ollama-keep',
    'siliconflow-endpoint',
    'workers-ai-account-id',
    'vertexai-region',
    'vertexai-auth-mode',
    'vertexai-express-project-id',
];

// Pure-data fields stored on rerank-mode profiles.
const RERANK_COMMANDS = [
    'source',
    'model',
    'api-url',
    'proxy-password',
    'secret-id',
];

const FANCY_NAMES = {
    'api': 'API',
    'api-url': 'Server URL',
    'preset': 'Settings Preset',
    'model': 'Model',
    'proxy': 'Proxy Preset',
    'proxy-password': 'API Key',
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
    'source': 'Source',
    'jina-late-chunking': 'Jina Late Chunking',
    'jina-dimensions': 'Jina Dimensions',
    'jina-task': 'Jina Task',
    'ollama-keep': 'Ollama Keep Loaded',
    'siliconflow-endpoint': 'SiliconFlow Endpoint',
    'workers-ai-account-id': 'Cloudflare Account ID',
    'vertexai-region': 'Vertex AI Region',
    'vertexai-auth-mode': 'Vertex AI Auth Mode',
    'vertexai-express-project-id': 'Vertex AI Express Project',
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
    ...extension_settings.connectionManager.profiles
        .filter(p => {
            const mode = resolveProfileMode(p);
            return mode === 'cc' || mode === 'tc';
        })
        .map(p => new SlashCommandEnumValue(p.name, null, enumTypes.name, enumIcons.server)),
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
 * Finds the best match for the search value among "active connection" profiles
 * (cc/tc only). Embed/rerank profiles are not exposed via name lookup since
 * they are not selected through this path.
 * @param {string} value Search value
 * @returns {ConnectionProfile|null} Best match or null
 */
function findProfileByName(value) {
    const candidates = extension_settings.connectionManager.profiles.filter(p => {
        const mode = resolveProfileMode(p);
        return mode === 'cc' || mode === 'tc';
    });

    // Try to find exact match
    const profile = candidates.find(p => p.name === value);

    if (profile) {
        return profile;
    }

    // Try to find fuzzy match
    const fuse = new Fuse(candidates, { keys: ['name'] });
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
    switch (mode) {
        case 'cc': return CC_COMMANDS;
        case 'tc': return TC_COMMANDS;
        case 'embed': return EMBED_COMMANDS;
        case 'rerank': return RERANK_COMMANDS;
        default: return TC_COMMANDS;
    }
}

function resolveProfileMode(profile) {
    const explicitMode = String(profile?.mode || '').trim().toLowerCase();
    if (explicitMode === 'cc' || explicitMode === 'tc' || explicitMode === 'embed' || explicitMode === 'rerank') {
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
    // Strip fields belonging to other modes. Use the union of all foreign-mode fields.
    const allModes = ['cc', 'tc', 'embed', 'rerank'];
    const foreignFields = new Set();
    for (const m of allModes) {
        if (m === nextMode) continue;
        for (const f of getCommandsForMode(m)) {
            if (!activeCommands.has(f)) foreignFields.add(f);
        }
    }

    for (const field of foreignFields) {
        if (Object.hasOwn(profile, field)) {
            delete profile[field];
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

    const mode = resolveProfileMode(profile);
    // Embedding/rerank profiles are pure data — they're not "applied" globally.
    // Consumers look them up by id when they need to embed or rerank.
    if (mode === 'embed' || mode === 'rerank') {
        return;
    }

    // Abort any ongoing profile application
    ConnectionManagerSpinner.abort();

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
    const currentMode = resolveProfileMode(profile);
    // Embedding/rerank profiles cannot be "snapshotted" from current global state —
    // they are edited directly through their dedicated form.
    if (currentMode === 'embed' || currentMode === 'rerank') {
        return;
    }
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

    // The main API-drawer picker only governs the active chat connection.
    // Embedding/rerank profiles live in the same registry but are managed by
    // their consumer plugins (vectors, memory-graph) — keep them out of this list.
    const visibleProfiles = extension_settings.connectionManager.profiles
        .filter(p => {
            const mode = resolveProfileMode(p);
            return mode === 'cc' || mode === 'tc';
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const profile of visibleProfiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name;
        option.selected = profile.id === extension_settings.connectionManager.selectedProfile;
        profiles.appendChild(option);
    }

    // If the persisted selection points at an embed/rerank profile (data drift),
    // fall back to <None> in the UI without mutating storage.
    const persistedId = extension_settings.connectionManager.selectedProfile || '';
    const persistedVisible = visibleProfiles.some(p => p.id === persistedId);
    profiles.value = persistedVisible ? persistedId : '';
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

/**
 * Callback for the /profile-genstream command
 * Generates text using Connection Manager with streaming display support.
 * @param {object} args Named arguments
 * @param {string} value Unnamed argument (the prompt)
 * @returns {Promise<string>} The generated text, optionally with formatted reasoning
 */
async function generateStreamCallback(args, value) {
    if (!value) {
        console.warn('WARN: No argument provided for /profile-genstream command');
        return '';
    }

    // Check if Connection Manager is available
    const context = getContext();
    if (context.extensionSettings.disabledExtensions.includes('connection-manager')) {
        toastr.error(t`Connection Manager is required for /profile-genstream. Use /gen or /genraw instead.`);
        return '';
    }

    const profileIdOrName = args?.profile;
    const includeReasoning = isTrueBoolean(args?.reasoning);
    const systemPrompt = typeof args?.system == 'string' ? args.system : '';
    const maxTokens = Number(args?.length ?? 2048) || 2048;
    const lock = isTrueBoolean(args?.lock);
    const generatingLabel = typeof args?.generating === 'string' ? args.generating : 'Generating...';
    const completedLabel = typeof args?.completed === 'string' ? args.completed : 'Generated';
    const enableStop = !isFalseBoolean(args?.stop);
    const onStopClosure = args?.onStop instanceof SlashCommandClosure ? args.onStop : null;
    const onCompleteClosure = args?.onComplete instanceof SlashCommandClosure ? args.onComplete : null;

    // Parse delay: 'infinite' or negative = null (stay open), number = delay in ms
    let completeDelay = 3000; // Default 3 seconds
    if (args?.delay !== undefined) {
        if (typeof args.delay === 'string' && args.delay.toLowerCase() === 'infinite') {
            completeDelay = null; // Stay until user closes
        } else {
            const parsed = Number(args.delay);
            if (!isNaN(parsed) && parsed >= 0) {
                completeDelay = parsed;
            } else if (!isNaN(parsed) && parsed < 0) {
                completeDelay = null; // Negative = infinite
            }
        }
    }

    // Create abort controller for stop functionality (when stop is enabled)
    const abortController = enableStop ? new AbortController() : null;

    // Compose the stop handler: abort the request + optionally invoke user closure
    const onStopHandler = enableStop ? async () => {
        abortController.abort();
        if (onStopClosure) {
            try {
                const localClosure = onStopClosure.getCopy();
                localClosure.onProgress = () => { };
                await localClosure.execute();
            } catch (e) {
                console.error('[GenStream] Error executing onStop closure', e);
            }
        }
    } : null;

    try {
        if (lock) {
            deactivateSendButtons();
        }

        // Determine which profile to use
        // Use the currently selected profile if no profile specified
        let effectiveProfileId = context.extensionSettings.connectionManager.selectedProfile;

        const profiles = context.extensionSettings.connectionManager.profiles;

        if (profileIdOrName) {
            // Use try to find profile by id first, then fuse search
            const profile = profiles.find(p => p.id === profileIdOrName);
            if (profile) {
                effectiveProfileId = profile.id;
            } else {
                const keys = [
                    { name: 'name', weight: 10 },
                ];
                const fuseResults = performFuzzySearch('profile', profiles, keys, profileIdOrName);
                if (fuseResults.length > 0) {
                    effectiveProfileId = fuseResults[0].item.id;
                } else {
                    toastr.warning(t`Connection profile not found: ${profileIdOrName}`);
                    return '';
                }
            }
        }

        if (!effectiveProfileId) {
            toastr.error(t`No connection profile specified or selected. Use profile= argument or select a profile in Connection Manager.`);
            return '';
        }

        // Create streaming display
        const display = new StreamingDisplay();
        display.show({
            label: generatingLabel,
            icon: ConnectionManagerRequestService.getProfileIcon(effectiveProfileId),
            onStop: onStopHandler,
        });

        const messages = [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: value },
        ];

        let finalText = '';
        let finalReasoning = '';

        /** Gets the final (if requested, formatted) text to return for this command @returns {string} */
        function buildResultText() {
            // Format output with reasoning if requested
            if (includeReasoning && finalReasoning) {
                const { formatted } = formatReasoning(finalReasoning, finalText);
                return formatted;
            }

            return finalText;
        }

        try {
            // Attempt streaming first
            const streamResponse = await ConnectionManagerRequestService.sendRequest(
                effectiveProfileId,
                messages,
                maxTokens,
                { extractData: true, includePreset: true, stream: true, signal: abortController?.signal ?? undefined },
            );

            if (typeof streamResponse === 'function') {
                const generator = streamResponse();
                for await (const chunk of generator) {
                    finalText = chunk.text;
                    finalReasoning = chunk.state?.reasoning || '';
                    display.updateReasoning(finalReasoning);
                    display.updateContent(finalText);
                }
            } else {
                // Non-streaming fallback within the try block
                const extracted = streamResponse;
                finalText = extracted?.content || '';
                finalReasoning = extracted?.reasoning || '';
                if (finalReasoning) {
                    display.updateReasoning(finalReasoning);
                }
                display.updateContent(finalText);
            }
        } catch (error) {
            // If the user clicked stop, don't retry — show stopped state and return empty
            if (abortController?.signal?.aborted) {
                display.markStopped({ label: `${generatingLabel} [Stopped]` });
                return buildResultText();
            }

            console.warn('[Slash Commands] Streaming failed, falling back to non-streaming:', error);
            display.hide({ instant: true });

            // Retry with non-streaming
            const response = await ConnectionManagerRequestService.sendRequest(
                effectiveProfileId,
                messages,
                maxTokens,
                { extractData: true, includePreset: true, stream: false },
            );

            const extracted = /** @type {import('../../custom-request.js').ExtractedData} */ (response);
            finalText = extracted?.content || '';
            finalReasoning = extracted?.reasoning || '';

            // Show quick non-streaming display
            display.show({
                label: generatingLabel,
                icon: ConnectionManagerRequestService.getProfileIcon(effectiveProfileId),
            });
            if (finalReasoning) {
                display.updateReasoning(finalReasoning);
            }
            display.updateContent(finalText);
        }

        // Mark as complete with delay (null = stay open until user closes)
        display.complete({ label: completedLabel, delay: completeDelay });

        // Invoke onComplete closure if provided
        if (onCompleteClosure) {
            try {
                const localClosure = onCompleteClosure.getCopy();
                localClosure.onProgress = () => { };
                await localClosure.execute();
            } catch (e) {
                console.error('[GenStream] Error executing onComplete closure', e);
            }
        }

        if (!finalText) {
            toastr.warning(t`Generation returned empty result`);
            return '';
        }

        return buildResultText();
    } catch (err) {
        console.error('Error on /genstream generation', err);
        toastr.error(err.message, t`API Error`, { preventDuplicates: true });
        return '';
    } finally {
        if (lock) {
            activateSendButtons();
        }
    }
}

export async function init() {
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

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'profile-genstream',
        callback: generateStreamCallback,
        returns: t`generated text`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'lock', t`lock user input during generation`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'off', commonEnumProviders.boolean('onOff')(),
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'profile',
                description: t`connection profile ID to use for generation`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.connectionProfiles(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'reasoning',
                description: t`include formatted reasoning in the output`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'system',
                description: t`system prompt at the start`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'length',
                description: t`API response length in tokens`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: '2048',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'generating',
                description: t`label/title for the generation display`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'Generating...',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'completed',
                description: t`updated label/title for when generation completes`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'Generated',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'delay',
                description: t`auto-hide delay in ms after generation completes. Use "infinite" or negative to keep until manually closed`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: '3000',
                enumList: [
                    new SlashCommandEnumValue('infinite', 'Keep the streaming display open until manually closed', 'command', '♾️'),
                    new SlashCommandEnumValue('any delay in seconds', null, 'number', '⌚', () => true, input => input),
                ],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'stop',
                description: t`show a stop button on the streaming display that aborts generation when clicked`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onStop',
                description: t`closure to execute when the stop button is clicked (in addition to aborting the request)`,
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onComplete',
                description: t`closure to execute after generation completes successfully`,
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'prompt',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
            <div>
                ${t`Generates text using Connection Manager with streaming display. Shows live generation progress including reasoning (thinking) and content.`}
            </div>
            <div>
                ${t`Requires Connection Manager extension. Uses the currently selected profile or the specified profile= argument.`}
            </div>
            <div>
                ${t`Use reasoning=true to include formatted reasoning in the output (using the defined reasoning template). This can be parsed later with /reasoning-parse.`}
            </div>
            <div>
                ${t`Use delay to control auto-hide behavior: number (ms), "infinite", or negative to keep the display open until manually closed. The display shows a green LED when complete.`}
            </div>
            <div>
                ${t`A stop button is shown by default (stop=true). Click it to abort generation and return whatever was streamed so far. Use stop=false to hide the stop button.`}
            </div>
            <div>
                ${t`Use onStop and onComplete closures for custom behavior when generation is stopped or completes.`}
            </div>
            <div>
                ${t`Example: <pre><code>/profile-genstream profile=my-profile-id reasoning=true Summarize the following text</code></pre>`}
            </div>
            <div>
                ${t`Example with infinite display: <pre><code>/profile-genstream delay=infinite Tell me a story</code></pre>`}
            </div>
            <div>
                ${t`Example with custom stop handler: <pre><code>/profile-genstream onStop={: /echo "Generation stopped!" :} Tell me a story</code></pre>`}
            </div>
        `,
    }));
}
