import {
    activateSendButtons,
    addOneMessage,
    appendMediaToMessage,
    callPopup,
    characters,
    chat,
    chat_metadata,
    CONNECT_API_MAP,
    create_save,
    deactivateSendButtons,
    event_types,
    eventSource,
    extension_prompts,
    extension_prompt_types,
    extension_prompt_roles,
    extractMessageFromData,
    Generate,
    generateQuietPrompt,
    getCharacters,
    getCurrentChatId,
    getRequestHeaders,
    getThumbnailUrl,
    main_api,
    max_context,
    menu_type,
    messageFormatting,
    name1,
    name2,
    online_status,
    openCharacterChat,
    reloadCurrentChat,
    renameChat,
    saveChatConditional,
    saveMetadata,
    saveReply,
    saveSettingsDebounced,
    selectCharacterById,
    sendGenerationRequest,
    sendStreamingRequest,
    sendSystemMessage,
    setExtensionPrompt,
    stopGeneration,
    streamingProcessor,
    substituteParams,
    substituteParamsExtended,
    this_chid,
    updateChatMetadata,
    updateMessageBlock,
    printMessages,
    clearChat,
    unshallowCharacter,
    deleteLastMessage,
    getCharacterCardFields,
    buildWorldInfoChatInput,
    buildWorldInfoGlobalScanData,
    simulateWorldInfoActivation,
    getActiveWorldInfoPromptFields,
    appendChatMessages,
    patchChatMessages,
    saveChatMetadata,
    getChatState,
    getChatStateBatch,
    patchChatState,
    updateChatState,
    setVariable,
    getPresetState,
    getPresetStateBatch,
    patchPresetState,
    updatePresetState,
    deleteChatState,
    deletePresetState,
    deleteAllPresetState,
    swipe_right,
    swipe_left,
    generateRaw,
    generateRawData,
    showSwipeButtons,
    hideSwipeButtons,
    deleteMessage,
    refreshSwipeButtons,
    swipe,
    isSwipingAllowed,
    swipeState,
    ensureMessageMediaIsArray,
    getMediaDisplay,
    getMediaIndex,
    scrollChatToBottom,
    scrollOnMediaLoad,
    getOneCharacter,
    getCharacterSource,
    createRawPrompt,
    getGenerateUrl,
    amount_gen,
    closeCurrentChat,
    doNewChat,
    getPastCharacterChats,
    deleteCharacterChatByName,
    updateCharacterData,
    persistCharacterData,
    persistCharacterDataDebounced,
} from '../script.js';
import {
    extension_settings,
    getExtensionManifest,
    ModuleWorkerWrapper,
    openThirdPartyExtensionMenu,
    registerExtensionApi,
    getExtensionApi,
    getCharacterState,
    setCharacterState,
    renderExtensionTemplate,
    renderExtensionTemplateAsync,
    saveMetadataDebounced,
    UNSET_VALUE,
    writeExtensionField,
    writeExtensionFieldBulk,
} from './extensions.js';
import { groups, openGroupChat, selected_group, unshallowGroupMembers } from './group-chats.js';
import { addLocaleData, getCurrentLocale, t, translate } from './i18n.js';
import { hideLoader, showLoader } from './loader.js';
import { loader } from './action-loader.js';
import { MacrosParser } from './macros.js';
import { getChatCompletionModel, oai_settings, sendOpenAIRequest } from './openai.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { power_user, registerDebugFunction } from './power-user.js';
import { getPresetManager } from './preset-manager.js';
import { persistPreset } from './preset-persistence.js';
import { humanizedDateTime, isMobile, shouldSendOnEnter } from './RossAscends-mods.js';
import { ScraperManager } from './scrapers.js';
import { executeSlashCommands, executeSlashCommandsWithOptions, registerSlashCommand } from './slash-commands.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from './slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { tag_map, tags, importTags } from './tags.js';
import { getTextGenServer, getTextGenGenerationData, textgenerationwebui_settings } from './textgen-settings.js';
import { tokenizers, getTextTokens, getTokenCount, getTokenCountAsync, getTokenizerModel } from './tokenizers.js';
import { ToolManager } from './tool-calling.js';
import { accountStorage } from './util/AccountStorage.js';
import { areLookupNamesEqual, findCanonicalNameInList, timestampToMoment, uuidv4, importFromExternalUrl, getCharaFilename } from './utils.js';
import { addGlobalVariable, addLocalVariable, decrementGlobalVariable, decrementLocalVariable, deleteGlobalVariable, deleteLocalVariable, existsGlobalVariable, existsLocalVariable, getGlobalVariable, getLocalVariable, incrementGlobalVariable, incrementLocalVariable, setGlobalVariable, setLocalVariable } from './variables.js';
import { convertCharacterBook, getWorldInfoPrompt, loadWorldInfo, loadWorldInfoBatch, reloadEditor, saveWorldInfo, updateWorldInfoList, wi_anchor_position, world_names, getCharaAuxWorlds, createNewWorldInfo, importEmbeddedWorldInfo, charUpdatePrimaryWorld, getCharacterEmbeddedWorld } from './world-info.js';
import { ChatCompletionService, TextCompletionService } from './custom-request.js';
import { ConnectionManagerRequestService } from './extensions/shared.js';
import { getChatCompletionConnectionProfiles, resolveChatCompletionRequestProfile } from './extensions/connection-manager/profile-resolver.js';
import { updateReasoningUI, parseReasoningFromString, getReasoningTemplateByName } from './reasoning.js';
import { IGNORE_SYMBOL, inject_ids } from './constants.js';
import { macros } from './macros/macro-system.js';
import { getRegexedString, regex_placement } from './extensions/regex/engine.js';
import { addMessages, updateMessages, deleteMessages, getMessage, getMessageCount } from './messages.js';
import { createFloorState } from './floor-state.js';
import { generateTask, generateTaskStream, GenerateTaskError } from './generate-task.js';
import { createMessageEditorHandle, TakeoverError } from './message-takeover.js';
import { generateHorde } from './horde.js';
import { getKoboldGenerationData, kai_settings, koboldai_settings, koboldai_setting_names } from './kai-settings.js';
import { getNovelGenerationData, nai_settings, novelai_settings, novelai_setting_names } from './nai-settings.js';
import {
    openIterationStudio,
    defineAdapter as defineIterationStudioAdapter,
    createEmptyHistoryState as createIterationStudioHistoryState,
    makeSessionId as makeIterationStudioSessionId,
    sanitizeSession as sanitizeIterationStudioSession,
    sanitizeSessionMessage as sanitizeIterationStudioMessage,
    findMessageById as findIterationStudioMessage,
    buildControlToolDefs as buildIterationStudioControlTools,
    getControlToolNames as getIterationStudioControlNames,
    runIterationTurn as runIterationStudioTurn,
    executeToolCalls as executeIterationStudioTools,
    stagePendingApproval as stageIterationStudioPendingApproval,
    applyPendingApproval as applyIterationStudioPendingApproval,
    rejectPendingApproval as rejectIterationStudioPendingApproval,
    rollbackToMessage as rollbackIterationStudioMessage,
    buildAutoContinuePrompt as buildIterationStudioAutoContinue,
    ensureStorageWipeOnce as ensureIterationStudioStorageWipe,
} from './iteration-studio/index.js';
import * as EDITS_API from './lib/edits/index.js';

/**
 * Layer 2 export of the shared IterationStudio shell. Third-party
 * extensions consume it as `SillyTavern.getContext().iterationStudio` so
 * they don't need to know the source file path. The same functions are
 * also importable directly via `/scripts/iteration-studio/index.js` for
 * in-tree extensions that prefer the static import path. See
 * `docs/development/extension-api/iteration-studio.md` for the contract.
 */
const ITERATION_STUDIO_API = Object.freeze({
    open: openIterationStudio,
    openIterationStudio,
    defineAdapter: defineIterationStudioAdapter,
    createEmptyHistoryState: createIterationStudioHistoryState,
    makeSessionId: makeIterationStudioSessionId,
    sanitizeSession: sanitizeIterationStudioSession,
    sanitizeSessionMessage: sanitizeIterationStudioMessage,
    findMessageById: findIterationStudioMessage,
    buildControlToolDefs: buildIterationStudioControlTools,
    getControlToolNames: getIterationStudioControlNames,
    runIterationTurn: runIterationStudioTurn,
    executeToolCalls: executeIterationStudioTools,
    stagePendingApproval: stageIterationStudioPendingApproval,
    applyPendingApproval: applyIterationStudioPendingApproval,
    rejectPendingApproval: rejectIterationStudioPendingApproval,
    rollbackToMessage: rollbackIterationStudioMessage,
    buildAutoContinuePrompt: buildIterationStudioAutoContinue,
    ensureStorageWipeOnce: ensureIterationStudioStorageWipe,
});

function safeClone(value, fallback = {}) {
    try {
        return structuredClone(value);
    } catch {
        return fallback;
    }
}

function cleanText(value) {
    return String(value ?? '').trim();
}

function normalizePresetApi(api) {
    if (api === 'koboldhorde') {
        return 'kobold';
    }
    return String(api || main_api || 'openai');
}

function isPresetAvailable(manager, presetName) {
    if (!manager || typeof manager.getAllPresets !== 'function') {
        return false;
    }
    const names = manager.getAllPresets();
    if (!Array.isArray(names)) {
        return false;
    }
    return Boolean(findCanonicalNameInList(names, presetName));
}

function getPresetSnapshot(apiId, presetName = '') {
    const api = normalizePresetApi(apiId);
    const manager = getPresetManager(api);
    const selectedName = manager?.getSelectedPresetName?.() || '';
    const requestedName = findCanonicalNameInList(manager?.getAllPresets?.() || [], presetName) || String(presetName || '').trim();
    const targetName = requestedName || String(selectedName || '');

    let settings = {};
    let resolvedName = targetName;

    if (requestedName && manager && isPresetAvailable(manager, requestedName)) {
        try {
            settings = safeClone(manager?.getCompletionPresetByName?.(requestedName) || {}, {});
            resolvedName = requestedName;
        } catch {
            settings = {};
        }
    }

    if (!settings || typeof settings !== 'object' || Object.keys(settings).length === 0) {
        try {
            settings = safeClone(manager?.getPresetSettings?.(targetName || selectedName) || {}, {});
            if (!resolvedName) {
                resolvedName = String(selectedName || '');
            }
        } catch {
            settings = {};
        }
    }

    return {
        apiId: api,
        name: String(resolvedName || selectedName || ''),
        settings,
    };
}

function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

// Extension-facing character compatibility layer:
// keep getContext().characters usable for legacy root-field reads/writes while routing data through V2-shaped fields.
const characterApiProxyTargetMap = new WeakMap();
const characterApiArrayProxyCache = new WeakMap();
const characterApiProxyCache = new WeakMap();
const characterApiDataProxyCache = new WeakMap();
const characterApiExtensionsProxyCache = new WeakMap();
const legacyCharacterWriteWarningKeys = new Set();

function rememberCharacterApiProxy(proxy, target) {
    characterApiProxyTargetMap.set(proxy, target);
    return proxy;
}

function unwrapCharacterApiProxy(value) {
    return characterApiProxyTargetMap.get(value) ?? value;
}

function normalizeCharacterTextField(value) {
    return String(value ?? '');
}

function normalizeCharacterTagsField(value) {
    if (Array.isArray(value)) {
        return value
            .map(tag => String(tag ?? '').trim())
            .filter(Boolean);
    }

    if (typeof value === 'string') {
        return value
            .split(',')
            .map(tag => tag.trim())
            .filter(Boolean);
    }

    return [];
}

function normalizeCharacterTalkativenessField(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0.5;
}

function normalizeCharacterFavField(value) {
    if (typeof value === 'string') {
        const normalizedValue = value.trim().toLowerCase();
        if (normalizedValue === 'true') {
            return true;
        }
        if (normalizedValue === 'false' || normalizedValue === '') {
            return false;
        }
    }

    return Boolean(value);
}

function ensureCharacterDataObject(character) {
    if (!isPlainObject(character?.data)) {
        character.data = {};
    }

    return character.data;
}

function ensureCharacterExtensionsObject(character) {
    const data = ensureCharacterDataObject(character);
    if (!isPlainObject(data.extensions)) {
        data.extensions = {};
    }

    return data.extensions;
}

const legacyCharacterRootFieldSpecs = Object.freeze({
    name: {
        canonicalPath: 'data.name',
        read: character => character?.data?.name ?? character?.name ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).name = normalized;
            character.name = normalized;
        },
    },
    description: {
        canonicalPath: 'data.description',
        read: character => character?.data?.description ?? character?.description ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).description = normalized;
            character.description = normalized;
        },
    },
    personality: {
        canonicalPath: 'data.personality',
        read: character => character?.data?.personality ?? character?.personality ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).personality = normalized;
            character.personality = normalized;
        },
    },
    scenario: {
        canonicalPath: 'data.scenario',
        read: character => character?.data?.scenario ?? character?.scenario ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).scenario = normalized;
            character.scenario = normalized;
        },
    },
    first_mes: {
        canonicalPath: 'data.first_mes',
        read: character => character?.data?.first_mes ?? character?.first_mes ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).first_mes = normalized;
            character.first_mes = normalized;
        },
    },
    mes_example: {
        canonicalPath: 'data.mes_example',
        read: character => character?.data?.mes_example ?? character?.mes_example ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).mes_example = normalized;
            character.mes_example = normalized;
        },
    },
    creatorcomment: {
        canonicalPath: 'data.creator_notes',
        read: character => character?.data?.creator_notes ?? character?.creatorcomment ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).creator_notes = normalized;
            character.creatorcomment = normalized;
        },
    },
    tags: {
        canonicalPath: 'data.tags',
        read: (character) => {
            if (Array.isArray(character?.data?.tags)) {
                character.tags = character.data.tags;
                return character.data.tags;
            }

            return character?.tags ?? [];
        },
        write: (character, value) => {
            const normalized = normalizeCharacterTagsField(value);
            ensureCharacterDataObject(character).tags = normalized;
            character.tags = normalized;
        },
    },
    talkativeness: {
        canonicalPath: 'data.extensions.talkativeness',
        read: character => character?.data?.extensions?.talkativeness ?? character?.talkativeness ?? 0.5,
        write: (character, value) => {
            const normalized = normalizeCharacterTalkativenessField(value);
            ensureCharacterExtensionsObject(character).talkativeness = normalized;
            character.talkativeness = normalized;
        },
    },
    fav: {
        canonicalPath: 'data.extensions.fav',
        read: character => character?.data?.extensions?.fav ?? character?.fav ?? false,
        write: (character, value) => {
            const normalized = normalizeCharacterFavField(value);
            ensureCharacterExtensionsObject(character).fav = normalized;
            character.fav = normalized;
        },
    },
});

const characterDataMirrorSpecs = Object.freeze({
    name: {
        rootField: 'name',
        normalize: normalizeCharacterTextField,
    },
    description: {
        rootField: 'description',
        normalize: normalizeCharacterTextField,
    },
    personality: {
        rootField: 'personality',
        normalize: normalizeCharacterTextField,
    },
    scenario: {
        rootField: 'scenario',
        normalize: normalizeCharacterTextField,
    },
    first_mes: {
        rootField: 'first_mes',
        normalize: normalizeCharacterTextField,
    },
    mes_example: {
        rootField: 'mes_example',
        normalize: normalizeCharacterTextField,
    },
    creator_notes: {
        rootField: 'creatorcomment',
        normalize: normalizeCharacterTextField,
    },
    tags: {
        rootField: 'tags',
        normalize: normalizeCharacterTagsField,
    },
});

const characterExtensionsMirrorSpecs = Object.freeze({
    talkativeness: {
        rootField: 'talkativeness',
        normalize: normalizeCharacterTalkativenessField,
    },
    fav: {
        rootField: 'fav',
        normalize: normalizeCharacterFavField,
    },
});

function syncCharacterRootFieldFromData(character, field) {
    const spec = characterDataMirrorSpecs[field];
    if (!spec) {
        return;
    }

    const data = ensureCharacterDataObject(character);
    if (!Object.prototype.hasOwnProperty.call(data, field)) {
        return;
    }

    const normalized = spec.normalize(data[field]);
    data[field] = normalized;
    character[spec.rootField] = normalized;
}

function syncCharacterRootFieldFromExtensions(character, field) {
    const spec = characterExtensionsMirrorSpecs[field];
    if (!spec) {
        return;
    }

    const extensions = ensureCharacterExtensionsObject(character);
    if (!Object.prototype.hasOwnProperty.call(extensions, field)) {
        return;
    }

    const normalized = spec.normalize(extensions[field]);
    extensions[field] = normalized;
    character[spec.rootField] = normalized;
}

function syncCharacterMirrorsFromData(character) {
    const data = ensureCharacterDataObject(character);
    for (const field of Object.keys(characterDataMirrorSpecs)) {
        if (Object.prototype.hasOwnProperty.call(data, field)) {
            syncCharacterRootFieldFromData(character, field);
        }
    }
}

function syncCharacterMirrorsFromExtensions(character) {
    const extensions = ensureCharacterExtensionsObject(character);
    for (const field of Object.keys(characterExtensionsMirrorSpecs)) {
        if (Object.prototype.hasOwnProperty.call(extensions, field)) {
            syncCharacterRootFieldFromExtensions(character, field);
        }
    }
}

function warnLegacyCharacterRootWrite(field, canonicalPath) {
    const warningKey = `legacy-character-root-write:${field}`;
    if (!legacyCharacterWriteWarningKeys.has(warningKey)) {
        console.warn(`Deprecated extension character write: root field "${field}" was written through Luker.getContext().characters. Write to "${canonicalPath}" instead.`);
        legacyCharacterWriteWarningKeys.add(warningKey);
    }

    const toastKey = 'legacy-character-root-write:toast';
    if (!legacyCharacterWriteWarningKeys.has(toastKey)) {
        globalThis.toastr?.warning(
            t`An extension wrote deprecated root character fields. The change was applied, but extensions should write to data.* / data.extensions.* instead.`,
            t`Deprecated character API write`,
            { preventDuplicates: true, timeOut: 8000 },
        );
        legacyCharacterWriteWarningKeys.add(toastKey);
    }
}

function isArrayIndexProperty(prop) {
    if (typeof prop !== 'string') {
        return false;
    }

    const numericIndex = Number(prop);
    return Number.isInteger(numericIndex) && numericIndex >= 0 && String(numericIndex) === prop;
}

function getCharacterApiExtensionsProxy(character) {
    const extensions = ensureCharacterExtensionsObject(character);
    const cachedProxy = characterApiExtensionsProxyCache.get(extensions);
    if (cachedProxy) {
        return cachedProxy;
    }

    const proxy = rememberCharacterApiProxy(new Proxy(extensions, {
        set(target, prop, value, receiver) {
            if (typeof prop === 'string' && characterExtensionsMirrorSpecs[prop]) {
                const normalized = characterExtensionsMirrorSpecs[prop].normalize(unwrapCharacterApiProxy(value));
                const result = Reflect.set(target, prop, normalized, receiver);
                character[characterExtensionsMirrorSpecs[prop].rootField] = normalized;
                return result;
            }

            return Reflect.set(target, prop, unwrapCharacterApiProxy(value), receiver);
        },
        defineProperty(target, prop, descriptor) {
            if (typeof prop === 'string' && characterExtensionsMirrorSpecs[prop] && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                const normalized = characterExtensionsMirrorSpecs[prop].normalize(unwrapCharacterApiProxy(descriptor.value));
                target[prop] = normalized;
                character[characterExtensionsMirrorSpecs[prop].rootField] = normalized;
                return true;
            }

            return Reflect.defineProperty(target, prop, descriptor);
        },
        deleteProperty(target, prop) {
            if (typeof prop === 'string' && characterExtensionsMirrorSpecs[prop]) {
                delete character[characterExtensionsMirrorSpecs[prop].rootField];
            }
            return Reflect.deleteProperty(target, prop);
        },
    }), extensions);

    characterApiExtensionsProxyCache.set(extensions, proxy);
    return proxy;
}

function getCharacterApiDataProxy(character) {
    const data = ensureCharacterDataObject(character);
    const cachedProxy = characterApiDataProxyCache.get(data);
    if (cachedProxy) {
        return cachedProxy;
    }

    const proxy = rememberCharacterApiProxy(new Proxy(data, {
        get(target, prop, receiver) {
            if (prop === 'extensions') {
                return getCharacterApiExtensionsProxy(character);
            }

            if (prop === 'tags' && Array.isArray(target.tags)) {
                character.tags = target.tags;
                return target.tags;
            }

            return Reflect.get(target, prop, receiver);
        },
        set(target, prop, value, receiver) {
            if (typeof prop === 'string' && characterDataMirrorSpecs[prop]) {
                const normalized = characterDataMirrorSpecs[prop].normalize(unwrapCharacterApiProxy(value));
                const result = Reflect.set(target, prop, normalized, receiver);
                character[characterDataMirrorSpecs[prop].rootField] = normalized;
                return result;
            }

            if (prop === 'extensions') {
                const nextValue = isPlainObject(unwrapCharacterApiProxy(value)) ? unwrapCharacterApiProxy(value) : {};
                const result = Reflect.set(target, prop, nextValue, receiver);
                syncCharacterMirrorsFromExtensions(character);
                return result;
            }

            return Reflect.set(target, prop, unwrapCharacterApiProxy(value), receiver);
        },
        defineProperty(target, prop, descriptor) {
            if (typeof prop === 'string' && characterDataMirrorSpecs[prop] && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                const normalized = characterDataMirrorSpecs[prop].normalize(unwrapCharacterApiProxy(descriptor.value));
                target[prop] = normalized;
                character[characterDataMirrorSpecs[prop].rootField] = normalized;
                return true;
            }

            if (prop === 'extensions' && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                target.extensions = isPlainObject(unwrapCharacterApiProxy(descriptor.value)) ? unwrapCharacterApiProxy(descriptor.value) : {};
                syncCharacterMirrorsFromExtensions(character);
                return true;
            }

            return Reflect.defineProperty(target, prop, descriptor);
        },
        deleteProperty(target, prop) {
            if (typeof prop === 'string' && characterDataMirrorSpecs[prop]) {
                delete character[characterDataMirrorSpecs[prop].rootField];
            }
            return Reflect.deleteProperty(target, prop);
        },
        ownKeys(target) {
            const keys = new Set(Reflect.ownKeys(target));
            keys.add('extensions');
            return [...keys];
        },
        getOwnPropertyDescriptor(target, prop) {
            if (prop === 'extensions') {
                return {
                    configurable: true,
                    enumerable: true,
                    value: getCharacterApiExtensionsProxy(character),
                    writable: true,
                };
            }

            return Reflect.getOwnPropertyDescriptor(target, prop);
        },
    }), data);

    characterApiDataProxyCache.set(data, proxy);
    return proxy;
}

function getCharacterApiProxy(character) {
    if (!isPlainObject(character)) {
        return character;
    }

    const cachedProxy = characterApiProxyCache.get(character);
    if (cachedProxy) {
        return cachedProxy;
    }

    const proxy = rememberCharacterApiProxy(new Proxy(character, {
        get(target, prop, receiver) {
            if (typeof prop === 'string' && legacyCharacterRootFieldSpecs[prop]) {
                return legacyCharacterRootFieldSpecs[prop].read(target);
            }

            if (prop === 'data') {
                return getCharacterApiDataProxy(target);
            }

            return Reflect.get(target, prop, receiver);
        },
        set(target, prop, value, receiver) {
            if (typeof prop === 'string' && legacyCharacterRootFieldSpecs[prop]) {
                legacyCharacterRootFieldSpecs[prop].write(target, unwrapCharacterApiProxy(value));
                warnLegacyCharacterRootWrite(prop, legacyCharacterRootFieldSpecs[prop].canonicalPath);
                return true;
            }

            if (prop === 'data') {
                const nextValue = isPlainObject(unwrapCharacterApiProxy(value)) ? unwrapCharacterApiProxy(value) : {};
                const result = Reflect.set(target, prop, nextValue, receiver);
                syncCharacterMirrorsFromData(target);
                syncCharacterMirrorsFromExtensions(target);
                return result;
            }

            return Reflect.set(target, prop, unwrapCharacterApiProxy(value), receiver);
        },
        defineProperty(target, prop, descriptor) {
            if (typeof prop === 'string' && legacyCharacterRootFieldSpecs[prop] && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                legacyCharacterRootFieldSpecs[prop].write(target, unwrapCharacterApiProxy(descriptor.value));
                warnLegacyCharacterRootWrite(prop, legacyCharacterRootFieldSpecs[prop].canonicalPath);
                return true;
            }

            if (prop === 'data' && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                target.data = isPlainObject(unwrapCharacterApiProxy(descriptor.value)) ? unwrapCharacterApiProxy(descriptor.value) : {};
                syncCharacterMirrorsFromData(target);
                syncCharacterMirrorsFromExtensions(target);
                return true;
            }

            return Reflect.defineProperty(target, prop, descriptor);
        },
        deleteProperty(target, prop) {
            if (typeof prop === 'string' && legacyCharacterRootFieldSpecs[prop]) {
                delete target[prop];
                return true;
            }

            return Reflect.deleteProperty(target, prop);
        },
        has(target, prop) {
            if (typeof prop === 'string' && legacyCharacterRootFieldSpecs[prop]) {
                return true;
            }

            if (prop === 'data') {
                return true;
            }

            return Reflect.has(target, prop);
        },
        ownKeys(target) {
            const keys = new Set(Reflect.ownKeys(target));
            keys.add('data');
            for (const field of Object.keys(legacyCharacterRootFieldSpecs)) {
                keys.add(field);
            }
            return [...keys];
        },
        getOwnPropertyDescriptor(target, prop) {
            if (typeof prop === 'string' && legacyCharacterRootFieldSpecs[prop]) {
                return {
                    configurable: true,
                    enumerable: true,
                    value: legacyCharacterRootFieldSpecs[prop].read(target),
                    writable: true,
                };
            }

            if (prop === 'data') {
                return {
                    configurable: true,
                    enumerable: true,
                    value: getCharacterApiDataProxy(target),
                    writable: true,
                };
            }

            return Reflect.getOwnPropertyDescriptor(target, prop);
        },
    }), character);

    characterApiProxyCache.set(character, proxy);
    return proxy;
}

function getCharacterArrayApiProxy(characterList) {
    if (!Array.isArray(characterList)) {
        return characterList;
    }

    const cachedProxy = characterApiArrayProxyCache.get(characterList);
    if (cachedProxy) {
        return cachedProxy;
    }

    const proxy = rememberCharacterApiProxy(new Proxy(characterList, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (isArrayIndexProperty(prop)) {
                return getCharacterApiProxy(value);
            }

            return value;
        },
        set(target, prop, value, receiver) {
            if (isArrayIndexProperty(prop)) {
                return Reflect.set(target, prop, unwrapCharacterApiProxy(value), receiver);
            }

            return Reflect.set(target, prop, unwrapCharacterApiProxy(value), receiver);
        },
    }), characterList);

    characterApiArrayProxyCache.set(characterList, proxy);
    return proxy;
}

function getStoredPresetNames(collection = '') {
    const normalizedCollection = normalizePresetApi(collection);
    const manager = getPresetManager(normalizedCollection);
    const presetNames = manager?.getPresetList?.()?.preset_names;

    if (Array.isArray(presetNames)) {
        return [...presetNames];
    }

    return isPlainObject(presetNames) ? Object.keys(presetNames) : [];
}

function normalizePresetRef(target = null, options = {}) {
    const fallbackCollection = options?.collection || options?.defaultCollection || '';
    const allowMissingName = options?.allowMissingName === true;

    if (target && typeof target === 'object') {
        const collection = normalizePresetApi(target.collection || fallbackCollection);
        const manager = getPresetManager(collection);
        const presetNames = getStoredPresetNames(collection);
        const selectedName = cleanText(manager?.getSelectedPresetName?.());
        const selectedStoredName = findCanonicalNameInList(presetNames, selectedName) || '';
        const requestedName = cleanText(target.name);
        const resolvedName = requestedName
            ? (findCanonicalNameInList(presetNames, requestedName) || (allowMissingName ? requestedName : ''))
            : selectedStoredName;

        return collection && resolvedName
            ? { collection, name: resolvedName }
            : null;
    }

    if (typeof target === 'string') {
        const collection = normalizePresetApi(target || fallbackCollection);
        const manager = getPresetManager(collection);
        const selectedName = cleanText(manager?.getSelectedPresetName?.());
        const selectedStoredName = findCanonicalNameInList(getStoredPresetNames(collection), selectedName) || '';
        return collection && selectedStoredName
            ? { collection, name: selectedStoredName }
            : null;
    }

    const collection = normalizePresetApi(fallbackCollection);
    const manager = getPresetManager(collection);
    const selectedName = cleanText(manager?.getSelectedPresetName?.());
    const selectedStoredName = findCanonicalNameInList(getStoredPresetNames(collection), selectedName) || '';
    return collection && selectedStoredName
        ? { collection, name: selectedStoredName }
        : null;
}

function buildPresetBodySnapshot(collection, name, body, source, { stored = true, selected = false } = {}) {
    const ref = { collection, name: cleanText(name) };
    return {
        ref,
        body: safeClone(isPlainObject(body) ? body : {}, {}),
        source,
        selected,
        stored,
    };
}

function listPresetRefs(collection = '') {
    const normalizedCollection = normalizePresetApi(collection);
    const names = getStoredPresetNames(normalizedCollection);
    return names.map((name) => ({ collection: normalizedCollection, name }));
}

function getSelectedPresetRef(collection = '') {
    return normalizePresetRef(collection || null);
}

function getLivePresetBody(collection = '') {
    const normalizedCollection = normalizePresetApi(collection);
    const manager = getPresetManager(normalizedCollection);
    const selectedName = cleanText(manager?.getSelectedPresetName?.());
    const body = safeClone(manager?.getPresetSettings?.(selectedName) || {}, {});
    const storedRef = normalizePresetRef(normalizedCollection);
    const snapshotName = storedRef?.name || selectedName;

    if (!snapshotName && !Object.keys(body).length) {
        return null;
    }

    return buildPresetBodySnapshot(normalizedCollection, snapshotName, body, 'live', {
        stored: Boolean(storedRef),
        selected: true,
    });
}

function getStoredPresetBody(target = null) {
    const ref = normalizePresetRef(target);
    if (!ref) {
        return null;
    }

    const manager = getPresetManager(ref.collection);
    const body = manager?.getStoredPreset?.(ref.name);
    if (!isPlainObject(body)) {
        return null;
    }

    const selectedRef = normalizePresetRef(ref.collection);
    return buildPresetBodySnapshot(ref.collection, ref.name, body, 'stored', {
        stored: true,
        selected: Boolean(selectedRef && areLookupNamesEqual(selectedRef.name, ref.name)),
    });
}

async function savePresetBody(target, body, options = {}) {
    const ref = normalizePresetRef(target, { collection: options?.collection, allowMissingName: true });
    const presetBody = safeClone(isPlainObject(body) ? body : {}, {});
    if (!ref) {
        return { ok: false, ref: null, mode: 'noop', operations: [] };
    }

    const manager = getPresetManager(ref.collection);
    const selectedRef = normalizePresetRef(ref.collection);
    const shouldSelect = typeof options?.select === 'boolean'
        ? options.select
        : Boolean(selectedRef && areLookupNamesEqual(selectedRef.name, ref.name));
    const saveResult = await persistPreset({
        apiId: ref.collection,
        name: ref.name,
        preset: presetBody,
    });

    if (!saveResult.ok) {
        return {
            ok: false,
            ref,
            mode: saveResult.mode,
            operations: safeClone(saveResult.operations || [], []),
            response: saveResult.response || null,
            body: null,
        };
    }

    const savedName = cleanText(saveResult?.data?.name || ref.name);
    manager?.updateList?.(savedName, presetBody, { select: shouldSelect });
    return {
        ok: true,
        ref: { collection: ref.collection, name: savedName },
        mode: saveResult.mode,
        operations: safeClone(saveResult.operations || [], []),
        response: saveResult.response || null,
        body: safeClone(presetBody, {}),
        snapshot: getStoredPresetBody({ collection: ref.collection, name: savedName }),
    };
}

function readPresetExtensions(target = null, path = '') {
    const ref = normalizePresetRef(target);
    if (!ref) {
        return null;
    }

    const manager = getPresetManager(ref.collection);
    const value = manager?.readPresetExtensionField?.({ name: ref.name, path: cleanText(path) });
    return value === null || value === undefined
        ? null
        : safeClone(value, value);
}

async function writePresetExtensions(target = null, path = '', value = null) {
    const ref = normalizePresetRef(target);
    if (!ref) {
        return false;
    }

    const manager = getPresetManager(ref.collection);
    if (!manager?.writePresetExtensionField) {
        return false;
    }

    await manager.writePresetExtensionField({
        name: ref.name,
        path: cleanText(path),
        value: safeClone(value, value),
    });
    return true;
}

function pickPromptLikeFields(settings) {
    const result = {};
    const source = settings && typeof settings === 'object' ? settings : {};
    const promptLikeRegex = /(prompt|story|sequence|suffix|prefix|format|separator|jailbreak|chat_start|example|system|scenario|personality|wi_|anchor)/i;

    for (const [key, value] of Object.entries(source)) {
        if (!promptLikeRegex.test(key)) {
            continue;
        }
        if (typeof value === 'string') {
            const trimmed = cleanText(value);
            if (trimmed) {
                result[key] = trimmed;
            }
        } else if (Array.isArray(value) || (value && typeof value === 'object')) {
            result[key] = safeClone(value, {});
        } else if (typeof value === 'boolean' || typeof value === 'number') {
            result[key] = value;
        }
    }

    return result;
}

function getCompletionPromptCore(api, settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const apiId = normalizePresetApi(api);

    if (apiId === 'openai') {
        const keys = [
            'use_sysprompt',
            'new_chat_prompt',
            'new_group_chat_prompt',
            'new_example_chat_prompt',
            'continue_nudge_prompt',
            'impersonation_prompt',
            'assistant_prefill',
            'continue_prefill',
            'continue_postfix',
            'scenario_format',
            'personality_format',
            'wi_format',
            'group_nudge_prompt',
            'squash_system_messages',
            'prompts',
            'prompt_order',
        ];
        const core = {};
        for (const key of keys) {
            if (!Object.hasOwn(source, key)) {
                continue;
            }
            const value = source[key];
            if (typeof value === 'string') {
                core[key] = cleanText(value);
            } else if (Array.isArray(value) || (value && typeof value === 'object')) {
                core[key] = safeClone(value, {});
            } else {
                core[key] = value;
            }
        }
        return core;
    }

    return pickPromptLikeFields(source);
}

function getContextPromptCore(settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const keys = [
        'story_string',
        'chat_start',
        'example_separator',
        'chat_end',
        'name',
    ];
    const core = {};
    for (const key of keys) {
        if (!Object.hasOwn(source, key)) {
            continue;
        }
        core[key] = typeof source[key] === 'string'
            ? cleanText(source[key])
            : safeClone(source[key], source[key]);
    }
    return core;
}

function getInstructPromptCore(settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const keys = [
        'input_sequence',
        'output_sequence',
        'system_sequence',
        'system_suffix',
        'input_suffix',
        'output_suffix',
        'last_input_sequence',
        'last_output_sequence',
        'first_input_sequence',
        'first_output_sequence',
        'last_system_sequence',
        'user_alignment_message',
        'stop_sequence',
        'name',
        'enabled',
    ];
    const core = {};
    for (const key of keys) {
        if (!Object.hasOwn(source, key)) {
            continue;
        }
        core[key] = typeof source[key] === 'string'
            ? cleanText(source[key])
            : safeClone(source[key], source[key]);
    }
    return core;
}

function getReasoningPromptCore(settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const keys = ['prefix', 'suffix', 'separator', 'max_additions', 'name', 'enabled'];
    const core = {};
    for (const key of keys) {
        if (!Object.hasOwn(source, key)) {
            continue;
        }
        core[key] = typeof source[key] === 'string'
            ? cleanText(source[key])
            : safeClone(source[key], source[key]);
    }
    return core;
}

function normalizeLayoutRole(role) {
    const value = String(role || 'system').trim().toLowerCase();
    if (['system', 'user', 'assistant'].includes(value)) {
        return value;
    }
    return 'system';
}

function normalizePromptMessageRole(role) {
    const value = String(role || 'system').trim().toLowerCase();
    if (['system', 'user', 'assistant', 'tool'].includes(value)) {
        return value;
    }
    return 'system';
}

function normalizeLayoutPhase(phase) {
    const value = String(phase || 'any').trim().toLowerCase();
    if (['before', 'after', 'any', '*'].includes(value)) {
        return value === '*' ? 'any' : value;
    }
    return 'any';
}

function normalizePromptLayout(layout) {
    const list = Array.isArray(layout) ? layout : [];
    return list
        .filter(item => item && typeof item === 'object')
        .map((item, index) => ({
            id: String(item.id || `entry_${index + 1}`).trim(),
            enabled: item.enabled !== false,
            order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
            role: normalizeLayoutRole(item.role),
            phase: normalizeLayoutPhase(item.phase),
            source: String(item.source || 'literal').trim().toLowerCase(),
            content: String(item.content || '').trim(),
            path: String(item.path || '').trim(),
            promptIdentifier: String(item.promptIdentifier || item.prompt_identifier || '').trim(),
            tags: Array.isArray(item.tags)
                ? item.tags.map(tag => String(tag || '').trim().toLowerCase()).filter(Boolean)
                : [],
        }))
        .sort((a, b) => a.order - b.order);
}

function getPresetPromptLayout(completionPresetSettings) {
    const source = completionPresetSettings && typeof completionPresetSettings === 'object'
        ? completionPresetSettings
        : {};
    return normalizePromptLayout(source?.extensions?.luker?.prompt_layout);
}

function getPromptCatalog(completionPresetSettings) {
    const source = completionPresetSettings && typeof completionPresetSettings === 'object'
        ? completionPresetSettings
        : {};
    const prompts = Array.isArray(source.prompts) ? source.prompts : [];
    const result = {};

    for (const prompt of prompts) {
        if (!prompt || typeof prompt !== 'object' || !prompt.identifier) {
            continue;
        }
        const identifier = String(prompt.identifier);
        result[identifier] = {
            identifier,
            name: String(prompt.name || ''),
            role: normalizeLayoutRole(prompt.role || 'system'),
            content: cleanText(prompt.content || ''),
            marker: Boolean(prompt.marker),
            systemPrompt: Boolean(prompt.system_prompt),
        };
    }

    return result;
}

function getActivePromptPresetEnvelope({
    includeCharacterCard = true,
    api = main_api,
    promptPresetName = '',
    completionPresetName = '',
    contextPresetName = '',
    instructPresetName = '',
    syspromptPresetName = '',
    reasoningPresetName = '',
} = {}) {
    const completionApi = normalizePresetApi(api);
    const requestedCompletionPreset = String(promptPresetName || completionPresetName || '').trim();
    const completionPreset = getPresetSnapshot(completionApi, requestedCompletionPreset);
    const contextPreset = getPresetSnapshot('context', contextPresetName);
    const instructPreset = getPresetSnapshot('instruct', instructPresetName);
    const syspromptPreset = getPresetSnapshot('sysprompt', syspromptPresetName);
    const reasoningPreset = getPresetSnapshot('reasoning', reasoningPresetName);

    const fields = getCharacterCardFields({ chid: this_chid }) || {};
    const character = characters?.[this_chid];
    const syspromptRaw = cleanText(substituteParams(power_user?.sysprompt?.content || ''));
    const postHistoryRaw = cleanText(substituteParams(power_user?.sysprompt?.post_history || ''));
    const cardSystem = cleanText(fields?.system || '');
    const cardPostHistory = cleanText(fields?.jailbreak || '');

    const syspromptEnabled = Boolean(power_user?.sysprompt?.enabled);
    const activeSystemPrompt = syspromptEnabled ? (cardSystem || syspromptRaw) : '';
    const activePostHistory = syspromptEnabled ? (cardPostHistory || postHistoryRaw) : '';
    const promptLayout = getPresetPromptLayout(completionPreset.settings);

    const envelope = {
        version: 1,
        generatedAt: Date.now(),
        mainApi: normalizePresetApi(main_api),
        completionApi,
        presetRefs: {
            completion: completionPreset.name || '',
            context: contextPreset.name || '',
            instruct: instructPreset.name || '',
            sysprompt: syspromptPreset.name || '',
            reasoning: reasoningPreset.name || '',
        },
        promptCore: {
            sysprompt: {
                enabled: syspromptEnabled,
                activeSystemPrompt,
                activePostHistory,
                defaultSystemPrompt: syspromptRaw,
                defaultPostHistory: postHistoryRaw,
                cardSystemPrompt: cardSystem,
                cardPostHistory,
            },
            context: getContextPromptCore(contextPreset.settings),
            instruct: getInstructPromptCore(instructPreset.settings),
            reasoning: getReasoningPromptCore(reasoningPreset.settings),
            completion: getCompletionPromptCore(completionApi, completionPreset.settings),
        },
        promptLayout,
        promptCatalog: getPromptCatalog(completionPreset.settings),
    };

    if (includeCharacterCard) {
        envelope.characterCard = {
            name: String(character?.name || ''),
            description: cleanText(fields?.description || ''),
            personality: cleanText(fields?.personality || ''),
            persona: cleanText(fields?.persona || ''),
            scenario: cleanText(fields?.scenario || ''),
            mesExamples: cleanText(fields?.mesExamples || ''),
            creatorNotes: cleanText(fields?.creatorNotes || ''),
            charDepthPrompt: cleanText(fields?.charDepthPrompt || ''),
        };
    }

    return envelope;
}

function normalizePromptMessages(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }
    const result = [];
    for (const message of messages) {
        if (!message || typeof message !== 'object') {
            continue;
        }
        const role = normalizePromptMessageRole(message.role);
        const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
        const toolCallId = String(message.tool_call_id || '').trim();
        const hasToolPayload = hasToolCalls || (role === 'tool' && toolCallId);
        const hasRawContent = Object.hasOwn(message, 'content') && message.content !== undefined && message.content !== null;
        const content = typeof message.content === 'string'
            ? message.content.trim()
            : message.content;

        if (!hasToolPayload && !hasRawContent) {
            continue;
        }

        if (!hasToolPayload && typeof content === 'string' && !content) {
            continue;
        }

        const normalized = {
            role,
            content: hasRawContent ? content : '',
        };

        const name = String(message.name || '').trim();
        if (name) {
            normalized.name = name;
        }

        if (hasToolCalls) {
            normalized.tool_calls = structuredClone(message.tool_calls);
        }

        if (role === 'tool' && toolCallId) {
            normalized.tool_call_id = toolCallId;
        }

        const signature = String(message.signature || '').trim();
        if (signature) {
            normalized.signature = signature;
        }

        result.push(normalized);
    }
    return result;
}

function getPluginRegexPlacementForPromptMessage(message) {
    const role = normalizePromptMessageRole(message?.role);
    if (role === 'user') {
        return regex_placement.USER_INPUT;
    }
    if (role === 'assistant') {
        return regex_placement.AI_OUTPUT;
    }
    return null;
}

function applyPluginRegexToPromptMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return [];
    }

    const eligibleIndexes = [];
    for (let index = 0; index < messages.length; index++) {
        if (getPluginRegexPlacementForPromptMessage(messages[index]) !== null) {
            eligibleIndexes.push(index);
        }
    }

    const depthByIndex = new Map(
        eligibleIndexes.map((index, orderIndex) => [index, eligibleIndexes.length - orderIndex - 1]),
    );

    return messages.map((message, index) => {
        const placement = getPluginRegexPlacementForPromptMessage(message);
        if (placement === null || typeof message?.content !== 'string') {
            return message;
        }

        return {
            ...message,
            content: getRegexedString(message.content, placement, {
                isPluginPrompt: true,
                depth: depthByIndex.get(index),
            }),
        };
    });
}

function applyPluginRegexToRuntimeWorldInfo(runtimeWorldInfo = null) {
    if (!runtimeWorldInfo || typeof runtimeWorldInfo !== 'object') {
        return runtimeWorldInfo;
    }

    const normalized = normalizeRuntimeWorldInfo(runtimeWorldInfo);
    const applyWorldInfoRegex = (value, options = {}) => {
        const text = String(value ?? '');
        if (!text) {
            return '';
        }
        return getRegexedString(text, regex_placement.WORLD_INFO, {
            isPluginPrompt: true,
            ...options,
        });
    };

    return normalizeRuntimeWorldInfo({
        ...normalized,
        worldInfoBeforeEntries: normalizeRuntimeWorldInfoEntries(normalized.worldInfoBeforeEntries)
            .map(item => applyWorldInfoRegex(item))
            .filter(Boolean),
        worldInfoAfterEntries: normalizeRuntimeWorldInfoEntries(normalized.worldInfoAfterEntries)
            .map(item => applyWorldInfoRegex(item))
            .filter(Boolean),
        worldInfoDepth: normalized.worldInfoDepth.map(entry => ({
            ...entry,
            entries: Array.isArray(entry?.entries)
                ? entry.entries.map(item => applyWorldInfoRegex(item, { depth: entry.depth })).filter(Boolean)
                : [],
        })),
        outletEntries: Object.fromEntries(
            Object.entries(normalized.outletEntries).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.map(item => applyWorldInfoRegex(item)).filter(Boolean) : [],
            ]),
        ),
        worldInfoExamples: normalized.worldInfoExamples
            .map(example => ({
                ...example,
                content: applyWorldInfoRegex(example?.content),
            }))
            .filter(example => example.content),
        anBefore: normalized.anBefore.map(item => applyWorldInfoRegex(item)).filter(Boolean),
        anAfter: normalized.anAfter.map(item => applyWorldInfoRegex(item)).filter(Boolean),
    });
}

function getPluginPromptOrderPreferredCharacterIds() {
    const ids = [];
    const manager = getPresetManager('openai');
    const activeId = manager?.activeCharacter?.id;
    const normalizedActive = String(activeId ?? '').trim();
    if (normalizedActive) {
        ids.push(normalizedActive);
    }

    // Fallbacks for migrated/legacy prompt_order snapshots.
    for (const fallbackId of ['100001', '100000']) {
        if (!ids.includes(fallbackId)) {
            ids.push(fallbackId);
        }
    }

    return ids;
}

function resolvePluginPromptOrderEntries(completionCore, { preferredCharacterIds = [] } = {}) {
    const promptOrder = Array.isArray(completionCore?.prompt_order) ? completionCore.prompt_order : [];
    const isEntry = entry => entry && typeof entry === 'object' && typeof entry.identifier === 'string';

    if (promptOrder.length === 0) {
        return [];
    }
    if (promptOrder.every(isEntry)) {
        return promptOrder;
    }

    const grouped = promptOrder
        .filter(item => item && typeof item === 'object' && Array.isArray(item.order))
        .map(item => ({
            characterId: String(item.character_id ?? '').trim(),
            order: item.order.filter(isEntry),
        }))
        .filter(item => item.order.length > 0);

    if (grouped.length === 0) {
        return [];
    }

    for (const preferredId of preferredCharacterIds.map(id => String(id ?? '').trim()).filter(Boolean)) {
        const matched = grouped.find(item => item.characterId === preferredId);
        if (matched) {
            return matched.order;
        }
    }

    const unnamed = grouped.find(item => !item.characterId);
    if (unnamed) {
        return unnamed.order;
    }

    return grouped[0].order;
}

function normalizeRuntimeWorldInfoExamples(rawExamples) {
    if (!Array.isArray(rawExamples)) {
        return [];
    }
    const normalized = [];
    for (const item of rawExamples) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const content = String(item.content ?? '').trim();
        if (!content) {
            continue;
        }
        let position = Number(wi_anchor_position.after);
        const numericPosition = Number(item.position);
        if (Number.isFinite(numericPosition)) {
            if (numericPosition === Number(wi_anchor_position.before)) {
                position = Number(wi_anchor_position.before);
            } else if (numericPosition === Number(wi_anchor_position.after)) {
                position = Number(wi_anchor_position.after);
            }
        } else {
            const textPosition = String(item.position || '').trim().toLowerCase();
            if (textPosition === 'before') {
                position = Number(wi_anchor_position.before);
            } else if (textPosition === 'after') {
                position = Number(wi_anchor_position.after);
            }
        }
        normalized.push({ position, content });
    }
    return normalized;
}

function normalizeRuntimeWorldInfoNoteEntries(rawEntries) {
    if (!Array.isArray(rawEntries)) {
        return [];
    }
    return rawEntries
        .map(entry => String(entry ?? '').trim())
        .filter(Boolean);
}

function normalizeRuntimeWorldInfoOutlets(rawOutlets) {
    if (!rawOutlets || typeof rawOutlets !== 'object') {
        return {};
    }
    const normalized = {};
    for (const [key, value] of Object.entries(rawOutlets)) {
        const outletName = String(key || '').trim();
        if (!outletName) {
            continue;
        }
        const entries = Array.isArray(value)
            ? value.map(entry => String(entry ?? '').trim()).filter(Boolean)
            : [];
        if (entries.length > 0) {
            normalized[outletName] = entries;
        }
    }
    return normalized;
}

function composeDialogueExamplesWithWorldInfo(baseExamples = '', worldInfoExamples = []) {
    const before = [];
    const after = [];
    for (const example of worldInfoExamples) {
        if (!example || typeof example !== 'object') {
            continue;
        }
        const content = String(example.content ?? '').trim();
        if (!content) {
            continue;
        }
        if (Number(example.position) === Number(wi_anchor_position.before)) {
            before.push(content);
        } else {
            after.push(content);
        }
    }
    return [before.join('\n').trim(), String(baseExamples || '').trim(), after.join('\n').trim()]
        .filter(Boolean)
        .join('\n')
        .trim();
}

function composeAuthorsNoteWithWorldInfo(authorsNote = '', anBefore = [], anAfter = []) {
    const before = normalizeRuntimeWorldInfoNoteEntries(anBefore);
    const after = normalizeRuntimeWorldInfoNoteEntries(anAfter);
    const note = String(authorsNote || '').trim();
    return [...before, note, ...after]
        .filter(Boolean)
        .join('\n')
        .trim();
}

function resolveRuntimeWorldInfoOutletPromptContent(identifier, outletEntries = {}) {
    const promptIdentifier = String(identifier || '').trim();
    if (!promptIdentifier || !outletEntries || typeof outletEntries !== 'object') {
        return '';
    }
    for (const [outletName, entries] of Object.entries(outletEntries)) {
        const generatedIdentifier = String(inject_ids.CUSTOM_WI_OUTLET(outletName) || '').replace(/\W/g, '_');
        if (generatedIdentifier !== promptIdentifier) {
            continue;
        }
        const content = Array.isArray(entries)
            ? entries.map(entry => String(entry ?? '').trim()).filter(Boolean).join('\n').trim()
            : '';
        if (content) {
            return content;
        }
    }
    return '';
}

function resolvePluginMarkerPromptContent(promptIdentifier, envelope, runtimeWorldInfo = null) {
    const marker = String(promptIdentifier || '').trim();
    switch (marker) {
        case 'charDescription':
            return String(envelope?.characterCard?.description || '').trim();
        case 'charPersonality':
            return String(envelope?.characterCard?.personality || '').trim();
        case 'scenario':
            return String(envelope?.characterCard?.scenario || '').trim();
        case 'personaDescription':
            return String(envelope?.characterCard?.persona || '').trim();
        case 'dialogueExamples':
            return composeDialogueExamplesWithWorldInfo(
                String(envelope?.characterCard?.mesExamples || ''),
                Array.isArray(runtimeWorldInfo?.worldInfoExamples) ? runtimeWorldInfo.worldInfoExamples : [],
            );
        default:
            return '';
    }
}

function normalizeRuntimeWorldInfoEntries(rawEntries) {
    return Array.isArray(rawEntries)
        ? rawEntries.map(entry => String(entry ?? '').trim()).filter(Boolean)
        : [];
}

function formatSplitPluginWorldInfoEntries(entries, completionCore) {
    const wiFormat = cleanText(completionCore?.wi_format || '');
    if (!wiFormat) {
        return [...entries];
    }

    const placeholder = wiFormat.includes('{{0}}') ? '{{0}}' : (wiFormat.includes('{0}') ? '{0}' : '');
    if (!placeholder) {
        return [wiFormat];
    }

    const placeholderCount = wiFormat.split(placeholder).length - 1;
    if (placeholderCount !== 1) {
        return [wiFormat.replaceAll(placeholder, entries.join('\n'))];
    }

    const [prefix, suffix] = wiFormat.split(placeholder);
    const lastIndex = entries.length - 1;
    return entries.map((entry, index) => `${index === 0 ? prefix : ''}${entry}${index === lastIndex ? suffix : ''}`);
}

function getPluginWorldInfoMessageContents(entries, completionCore) {
    const normalizedEntries = normalizeRuntimeWorldInfoEntries(entries);
    if (normalizedEntries.length === 0) {
        return [];
    }

    return formatSplitPluginWorldInfoEntries(normalizedEntries, completionCore).filter(Boolean);
}

function getWorldInfoRoleOrder(role) {
    switch (normalizeLayoutRole(role)) {
        case 'user':
            return 1;
        case 'assistant':
            return 2;
        case 'system':
        default:
            return 0;
    }
}

function normalizeRuntimeWorldInfoDepth(rawDepthEntries) {
    if (!Array.isArray(rawDepthEntries)) {
        return [];
    }
    const grouped = new Map();
    for (const item of rawDepthEntries) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const depth = Math.max(0, Math.floor(Number(item.depth) || 0));
        const numericRole = Number(item.role);
        let role = 'system';
        if (Number.isFinite(numericRole)) {
            if (numericRole === Number(extension_prompt_roles.USER)) {
                role = 'user';
            } else if (numericRole === Number(extension_prompt_roles.ASSISTANT)) {
                role = 'assistant';
            }
        } else {
            role = normalizeLayoutRole(item.role);
        }
        const entries = Array.isArray(item.entries)
            ? item.entries.map(entry => String(entry ?? '').trim()).filter(Boolean)
            : [];
        if (entries.length === 0) {
            continue;
        }
        const key = `${depth}:${role}`;
        const existing = grouped.get(key);
        if (existing) {
            existing.entries.push(...entries);
            continue;
        }
        grouped.set(key, { depth, role, entries: [...entries] });
    }

    return Array.from(grouped.values())
        .sort((a, b) => {
            if (a.depth !== b.depth) {
                return a.depth - b.depth;
            }
            return getWorldInfoRoleOrder(a.role) - getWorldInfoRoleOrder(b.role);
        });
}

function normalizeRuntimeWorldInfo(runtimeWorldInfo = null) {
    const source = runtimeWorldInfo && typeof runtimeWorldInfo === 'object' ? runtimeWorldInfo : {};
    return {
        worldInfoBeforeEntries: normalizeRuntimeWorldInfoEntries(source.worldInfoBeforeEntries),
        worldInfoAfterEntries: normalizeRuntimeWorldInfoEntries(source.worldInfoAfterEntries),
        worldInfoDepth: normalizeRuntimeWorldInfoDepth(source.worldInfoDepth),
        outletEntries: normalizeRuntimeWorldInfoOutlets(source.outletEntries),
        worldInfoExamples: normalizeRuntimeWorldInfoExamples(source.worldInfoExamples),
        anBefore: normalizeRuntimeWorldInfoNoteEntries(source.anBefore),
        anAfter: normalizeRuntimeWorldInfoNoteEntries(source.anAfter),
    };
}

function applyWorldInfoPostActivationHook(runtimeWorldInfo = null, postActivationHook = null) {
    const normalized = normalizeRuntimeWorldInfo(runtimeWorldInfo);
    if (typeof postActivationHook !== 'function') {
        return normalized;
    }

    const payload = {
        worldInfoBeforeEntries: [...normalized.worldInfoBeforeEntries],
        worldInfoAfterEntries: [...normalized.worldInfoAfterEntries],
        worldInfoDepth: normalized.worldInfoDepth.map(entry => ({
            depth: Math.max(0, Math.floor(Number(entry?.depth) || 0)),
            role: normalizeLayoutRole(entry?.role),
            entries: Array.isArray(entry?.entries) ? entry.entries.map(item => String(item ?? '').trim()).filter(Boolean) : [],
        })),
        outletEntries: Object.fromEntries(
            Object.entries(normalized.outletEntries).map(([key, value]) => [key, Array.isArray(value) ? [...value] : []]),
        ),
        worldInfoExamples: normalized.worldInfoExamples.map(example => ({
            position: Number(example?.position),
            content: String(example?.content ?? '').trim(),
        })),
        anBefore: [...normalized.anBefore],
        anAfter: [...normalized.anAfter],
    };

    try {
        const hookResult = postActivationHook(payload);
        if (hookResult && typeof hookResult === 'object') {
            return normalizeRuntimeWorldInfo({ ...payload, ...hookResult });
        }
        return normalizeRuntimeWorldInfo(payload);
    } catch (error) {
        console.warn('[LUKER] world-info postActivationHook failed', error);
        return normalized;
    }
}

function mergeWorldInfoDepthIntoMessages(messages, worldInfoDepthEntries) {
    const base = Array.isArray(messages)
        ? messages.map(message => ({ ...message }))
        : [];
    const depthEntries = Array.isArray(worldInfoDepthEntries) ? worldInfoDepthEntries : [];
    if (depthEntries.length === 0) {
        return base;
    }

    const depthGroups = new Map();
    for (const entry of depthEntries) {
        const depth = Math.max(0, Math.floor(Number(entry?.depth) || 0));
        const role = normalizeLayoutRole(entry?.role);
        const content = Array.isArray(entry?.entries)
            ? entry.entries.map(line => String(line ?? '').trim()).filter(Boolean).join('\n').trim()
            : '';
        if (!content) {
            continue;
        }
        const group = depthGroups.get(depth) || { system: '', user: '', assistant: '' };
        const existing = String(group[role] || '').trim();
        group[role] = existing ? `${existing}\n${content}` : content;
        depthGroups.set(depth, group);
    }

    let totalInserted = 0;
    const orderedDepths = Array.from(depthGroups.keys()).sort((a, b) => a - b);
    for (const depth of orderedDepths) {
        const group = depthGroups.get(depth);
        const roleMessages = ['system', 'user', 'assistant']
            .map(role => ({ role, content: String(group?.[role] || '').trim() }))
            .filter(item => item.content)
            .map(item => ({ role: item.role, content: item.content }));
        if (roleMessages.length === 0) {
            continue;
        }
        const reverseInsertionIndex = Math.min(depth + totalInserted, base.length);
        const insertionIndex = Math.max(0, base.length - reverseInsertionIndex);
        base.splice(insertionIndex, 0, ...roleMessages);
        totalInserted += roleMessages.length;
    }

    return base;
}

function normalizeScriptInjectRole(role) {
    const value = Number(role);
    if (value === extension_prompt_roles.USER) {
        return 'user';
    }
    if (value === extension_prompt_roles.ASSISTANT) {
        return 'assistant';
    }
    return 'system';
}

function canUseScriptInjectPrompt(prompt) {
    if (!prompt || typeof prompt !== 'object') {
        return false;
    }
    const value = String(prompt.value ?? '').trim();
    if (!value) {
        return false;
    }
    if (typeof prompt.filter !== 'function') {
        return true;
    }
    try {
        const passed = prompt.filter();
        if (passed && typeof passed.then === 'function') {
            return true;
        }
        return Boolean(passed);
    } catch {
        return false;
    }
}

function collectScriptInjectPromptFields() {
    const injectEntries = Object.entries(extension_prompts || {})
        .filter(([key]) => String(key || '').startsWith('script_inject_'))
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
        .map(([, prompt]) => prompt)
        .filter(canUseScriptInjectPrompt);
    if (injectEntries.length === 0) {
        return {
            before: '',
            after: '',
            depthEntries: [],
        };
    }

    const before = injectEntries
        .filter(prompt => Number(prompt?.position) === extension_prompt_types.BEFORE_PROMPT)
        .map(prompt => substituteParams(String(prompt?.value ?? '').trim()))
        .filter(Boolean)
        .join('\n')
        .trim();
    const after = injectEntries
        .filter(prompt => Number(prompt?.position) === extension_prompt_types.IN_PROMPT)
        .map(prompt => substituteParams(String(prompt?.value ?? '').trim()))
        .filter(Boolean)
        .join('\n')
        .trim();

    const depthGroups = new Map();
    for (const prompt of injectEntries) {
        if (Number(prompt?.position) !== extension_prompt_types.IN_CHAT) {
            continue;
        }
        const content = substituteParams(String(prompt?.value ?? '').trim());
        if (!content) {
            continue;
        }
        const depth = Math.max(0, Math.floor(Number(prompt?.depth) || 0));
        const role = normalizeScriptInjectRole(prompt?.role);
        const key = `${depth}:${role}`;
        const group = depthGroups.get(key) || { depth, role, entries: [] };
        group.entries.push(content);
        depthGroups.set(key, group);
    }

    return {
        before,
        after,
        depthEntries: Array.from(depthGroups.values())
            .map(group => ({
                depth: group.depth,
                role: group.role,
                entries: group.entries,
            }))
            .filter(group => Array.isArray(group.entries) && group.entries.length > 0),
    };
}

function resolveRuntimeWorldInfoForPromptAssembly(runtimeWorldInfo = null, { applyPluginRegex = false } = {}) {
    const normalized = runtimeWorldInfo && typeof runtimeWorldInfo === 'object'
        ? normalizeRuntimeWorldInfo(runtimeWorldInfo)
        : normalizeRuntimeWorldInfo({
            ...getActiveWorldInfoPromptFields(),
            worldInfoDepth: [],
        });
    if (!applyPluginRegex) {
        return normalized;
    }
    return applyPluginRegexToRuntimeWorldInfo(normalized);
}

function normalizeWorldInfoSourceMessages(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }
    const normalized = [];
    for (const message of messages) {
        if (!message || typeof message !== 'object') {
            continue;
        }
        const hasChatShape = Object.hasOwn(message, 'mes') || Object.hasOwn(message, 'is_user') || Object.hasOwn(message, 'is_system');
        const role = normalizeLayoutRole(message.role);
        const text = hasChatShape
            ? String(message.mes ?? message.content ?? message.text ?? '').trim()
            : String(message.content ?? message.text ?? '').trim();
        if (!text) {
            continue;
        }
        const isUser = hasChatShape
            ? Boolean(message.is_user) || role === 'user'
            : role === 'user';
        const isSystem = hasChatShape
            ? Boolean(message.is_system) || role === 'system'
            : role === 'system';
        let speaker = String(message.name || '').trim();
        if (!speaker) {
            if (isUser) {
                speaker = String(name1 || 'User');
            } else if (!isSystem) {
                speaker = String(name2 || 'Assistant');
            }
        }
        normalized.push({
            name: speaker,
            is_user: isUser,
            is_system: isSystem,
            mes: text,
        });
    }
    return normalized;
}

async function resolveWorldInfoForMessages(messages = [], {
    type = 'quiet',
    maxContext = undefined,
    includeNames = true,
    globalScanData = undefined,
    fallbackToCurrentChat = true,
    postActivationHook = null,
} = {}) {
    const sourceMessages = Array.isArray(messages) && messages.length > 0
        ? messages
        : (fallbackToCurrentChat ? (Array.isArray(chat) ? chat : []) : []);
    const coreChat = normalizeWorldInfoSourceMessages(sourceMessages)
        .filter(item => !item.is_system);
    if (coreChat.length === 0) {
        return normalizeRuntimeWorldInfo();
    }

    const request = {
        coreChat,
        type: String(type || 'quiet'),
        includeNames: includeNames !== false,
    };
    const maxContextValue = Number(maxContext);
    if (Number.isFinite(maxContextValue) && maxContextValue > 0) {
        request.maxContext = Math.floor(maxContextValue);
    }
    if (globalScanData && typeof globalScanData === 'object') {
        request.globalScanData = globalScanData;
    }

    try {
        const resolution = await simulateWorldInfoActivation(request);
        return applyWorldInfoPostActivationHook({
            worldInfoBeforeEntries: Array.isArray(resolution?.worldInfoBeforeEntries) ? resolution.worldInfoBeforeEntries : [],
            worldInfoAfterEntries: Array.isArray(resolution?.worldInfoAfterEntries) ? resolution.worldInfoAfterEntries : [],
            worldInfoDepth: Array.isArray(resolution?.worldInfoDepth) ? resolution.worldInfoDepth : [],
            outletEntries: resolution?.outletEntries && typeof resolution.outletEntries === 'object' ? resolution.outletEntries : {},
            worldInfoExamples: Array.isArray(resolution?.worldInfoExamples) ? resolution.worldInfoExamples : [],
            anBefore: Array.isArray(resolution?.anBefore) ? resolution.anBefore : [],
            anAfter: Array.isArray(resolution?.anAfter) ? resolution.anAfter : [],
        }, postActivationHook);
    } catch (error) {
        console.warn('[LUKER] resolveWorldInfoForMessages failed', error);
        return normalizeRuntimeWorldInfo();
    }
}

function buildPluginMessagesFromPromptOrder(completionCore, envelope, normalizedMessages, runtimeWorldInfo = null) {
    const prompts = Array.isArray(completionCore?.prompts) ? completionCore.prompts : [];
    const promptMap = new Map(prompts
        .filter(prompt => prompt && typeof prompt === 'object' && typeof prompt.identifier === 'string')
        .map(prompt => [String(prompt.identifier), prompt]));
    const orderEntries = resolvePluginPromptOrderEntries(completionCore, {
        preferredCharacterIds: getPluginPromptOrderPreferredCharacterIds(),
    });
    if (orderEntries.length === 0) {
        return null;
    }

    const result = [];
    let historyInjected = false;
    const runtimePromptFields = resolveRuntimeWorldInfoForPromptAssembly(runtimeWorldInfo, { applyPluginRegex: true });
    const scriptInjectFields = collectScriptInjectPromptFields();
    const mergedWorldInfoDepth = [
        ...(Array.isArray(runtimePromptFields.worldInfoDepth) ? runtimePromptFields.worldInfoDepth : []),
        ...scriptInjectFields.depthEntries,
    ];
    const historyMessages = mergeWorldInfoDepthIntoMessages(normalizedMessages, mergedWorldInfoDepth);
    const worldInfoBeforeEntries = [
        ...normalizeRuntimeWorldInfoEntries(scriptInjectFields.before ? [scriptInjectFields.before] : []),
        ...normalizeRuntimeWorldInfoEntries(runtimePromptFields.worldInfoBeforeEntries),
    ];
    const worldInfoAfterEntries = [
        ...normalizeRuntimeWorldInfoEntries(runtimePromptFields.worldInfoAfterEntries),
        ...normalizeRuntimeWorldInfoEntries(scriptInjectFields.after ? [scriptInjectFields.after] : []),
    ];

    for (const entry of orderEntries) {
        if (!entry || entry.enabled === false) {
            continue;
        }

        const identifier = String(entry.identifier || '').trim();
        if (!identifier) {
            continue;
        }

        const prompt = promptMap.get(identifier);
        if (!prompt || prompt.plugin_extra === true) {
            continue;
        }

        if (identifier === 'worldInfoBefore' || identifier === 'worldInfoAfter') {
            const messageContents = getPluginWorldInfoMessageContents(
                identifier === 'worldInfoBefore' ? worldInfoBeforeEntries : worldInfoAfterEntries,
                completionCore,
            );
            if (messageContents.length > 0) {
                result.push(...messageContents.map(content => ({ role: 'system', content })));
            }
            continue;
        }

        if (identifier === 'chatHistory') {
            historyInjected = true;
            result.push(...historyMessages);
            continue;
        }

        let content = '';
        if (prompt.marker === true) {
            content = resolvePluginMarkerPromptContent(identifier, envelope, runtimePromptFields);
        } else {
            content = String(substituteParams(prompt.content || '')).trim();
        }

        if (identifier === 'authorsNote') {
            content = composeAuthorsNoteWithWorldInfo(
                content,
                runtimePromptFields.anBefore,
                runtimePromptFields.anAfter,
            );
        }

        if (!content) {
            content = resolveRuntimeWorldInfoOutletPromptContent(identifier, runtimePromptFields.outletEntries);
        }

        if (!content) {
            continue;
        }

        const role = normalizeLayoutRole(prompt.role || (prompt.system_prompt ? 'system' : 'user'));
        result.push({ role, content });
    }

    if (!historyInjected && historyMessages.length > 0) {
        result.push(...historyMessages);
    }

    return result;
}

function formatPromptPresetEnvelope(envelope, { label = 'LUKER_PRESET_ENVELOPE' } = {}) {
    const resolved = envelope && typeof envelope === 'object'
        ? envelope
        : getActivePromptPresetEnvelope();
    return `[[${label}]]\n${JSON.stringify(resolved)}`;
}

function getActivePromptLayout(options = {}) {
    const envelope = getActivePromptPresetEnvelope(options);
    return normalizePromptLayout(envelope?.promptLayout);
}

function buildPresetAwarePromptMessages({
    taskSystem = '',
    taskUser = '',
    messages = [],
    envelope = null,
    envelopeOptions = {},
    promptPresetName = '',
    runtimeWorldInfo = null,
} = {}) {
    const normalizedMessages = normalizePromptMessages(messages);
    const resolvedEnvelopeOptions = envelopeOptions && typeof envelopeOptions === 'object'
        ? { ...envelopeOptions }
        : {};
    const selectedPromptPresetName = String(promptPresetName || '').trim();
    if (selectedPromptPresetName && !resolvedEnvelopeOptions.promptPresetName && !resolvedEnvelopeOptions.completionPresetName) {
        resolvedEnvelopeOptions.promptPresetName = selectedPromptPresetName;
    }
    const resolvedEnvelope = envelope && typeof envelope === 'object'
        ? envelope
        : getActivePromptPresetEnvelope(resolvedEnvelopeOptions);

    // Backward compatibility: convert taskSystem/taskUser to messages if caller still uses legacy fields.
    const taskSystemText = String(taskSystem || '').trim();
    const taskUserText = String(taskUser || '').trim();
    if (normalizedMessages.length === 0) {
        if (taskSystemText) {
            normalizedMessages.push({ role: 'system', content: taskSystemText });
        }
        if (taskUserText) {
            normalizedMessages.push({ role: 'user', content: taskUserText });
        }
    }

    const pluginRegexMessages = applyPluginRegexToPromptMessages(normalizedMessages);

    const orderedMessages = buildPluginMessagesFromPromptOrder(
        resolvedEnvelope?.promptCore?.completion,
        resolvedEnvelope,
        pluginRegexMessages,
        runtimeWorldInfo,
    );
    if (Array.isArray(orderedMessages)) {
        return orderedMessages;
    }

    throw new Error('Prompt preset assembly failed: no valid prompt_order for plugin message construction.');
}

function buildGenerateTaskSenders() {
    return {
        sendOpenAIRequest,
        generateHorde,
        getKoboldGenerationData,
        getNovelGenerationData,
        getTextGenGenerationData,
        getGenerateUrl,
        getRequestHeaders,
        fetchImpl: globalThis.fetch.bind(globalThis),
        getKoboldRuntime: () => ({
            kai_settings,
            koboldai_settings,
            koboldai_setting_names,
            amount_gen,
            max_context,
        }),
        getNovelRuntime: () => ({
            nai_settings,
            novelai_settings,
            novelai_setting_names,
            amount_gen,
        }),
    };
}

export function getContext() {
    return {
        accountStorage,
        chat,
        characters: getCharacterArrayApiProxy(characters),
        groups,
        name1,
        name2,
        characterId: this_chid,
        groupId: selected_group,
        chatId: selected_group
            ? groups.find(x => x.id == selected_group)?.chat_id
            : (characters[this_chid]?.chat),
        getCurrentChatId,
        getRequestHeaders,
        reloadCurrentChat,
        renameChat,
        closeCurrentChat,
        doNewChat,
        getPastCharacterChats,
        deleteCharacterChat: deleteCharacterChatByName,
        saveSettingsDebounced,
        iterationStudio: ITERATION_STUDIO_API,
        edits: EDITS_API,
        onlineStatus: online_status,
        maxContext: Number(max_context),
        chatMetadata: chat_metadata,
        saveMetadataDebounced,
        streamingProcessor,
        eventSource,
        eventTypes: event_types,
        generateTask,
        generateTaskStream,
        GenerateTaskError,
        createMessageEditorHandle,
        TakeoverError,
        /** @deprecated Use addMessages() instead */
        addOneMessage,
        /** @deprecated Use deleteMessages(chat.length - 1) instead */
        deleteLastMessage,
        /** @deprecated Use deleteMessages() instead */
        deleteMessage,
        addMessages,
        updateMessages,
        deleteMessages,
        getMessage,
        getMessageCount,
        generate: Generate,
        sendStreamingRequest,
        sendGenerationRequest,
        stopGeneration,
        tokenizers,
        getTextTokens,
        /** @deprecated Use getTokenCountAsync instead */
        getTokenCount,
        getTokenCountAsync,
        extensionPrompts: extension_prompts,
        setExtensionPrompt,
        updateChatMetadata,
        saveChat: saveChatConditional,
        /** @deprecated Internal, use addMessages() instead */
        appendChatMessages,
        /** @deprecated Internal, use updateMessages()/deleteMessages() instead */
        patchChatMessages,
        saveChatMetadata,
        getChatState,
        getChatStateBatch,
        patchChatState,
        updateChatState,
        deleteChatState,
        createFloorState,
        presets: {
            list: listPresetRefs,
            resolve: normalizePresetRef,
            getSelected: getSelectedPresetRef,
            getLive: getLivePresetBody,
            getStored: getStoredPresetBody,
            save: savePresetBody,
            readExtensions: readPresetExtensions,
            writeExtensions: writePresetExtensions,
            state: {
                get: (namespace, options = {}) => getPresetState(namespace, {
                    ...options,
                    target: normalizePresetRef(options?.target, { collection: options?.collection }),
                }),
                getBatch: (namespaces, options = {}) => getPresetStateBatch(namespaces, {
                    ...options,
                    target: normalizePresetRef(options?.target, { collection: options?.collection }),
                }),
                patch: (namespace, operations, options = {}) => patchPresetState(namespace, operations, {
                    ...options,
                    target: normalizePresetRef(options?.target, { collection: options?.collection }),
                }),
                update: (namespace, updater, options = {}) => updatePresetState(namespace, updater, {
                    ...options,
                    target: normalizePresetRef(options?.target, { collection: options?.collection }),
                }),
                delete: (namespace, options = {}) => deletePresetState(namespace, {
                    ...options,
                    target: normalizePresetRef(options?.target, { collection: options?.collection }),
                }),
                deleteAll: (target = null) => deleteAllPresetState(normalizePresetRef(target)),
            },
        },
        connectionProfiles: {
            list: getChatCompletionConnectionProfiles,
            /** @deprecated Use generateTask({ apiPresetName }) instead. Will be removed in a future release. */
            resolve: resolveChatCompletionRequestProfile,
        },
        createRawPrompt,
        get generateTaskSenders() { return buildGenerateTaskSenders(); },
        openCharacterChat,
        openGroupChat,
        saveMetadata,
        sendSystemMessage,
        activateSendButtons,
        deactivateSendButtons,
        saveReply,
        substituteParams,
        substituteParamsExtended,
        SlashCommandParser,
        SlashCommand,
        SlashCommandArgument,
        SlashCommandNamedArgument,
        SlashCommandEnumValue,
        ARGUMENT_TYPE,
        executeSlashCommandsWithOptions,
        /** @deprecated Use SlashCommandParser.addCommandObject() instead */
        registerSlashCommand,
        /** @deprecated Use executeSlashCommandWithOptions instead */
        executeSlashCommands,
        timestampToMoment,
        /** @deprecated Handlebars for extensions are no longer supported. */
        registerHelper: () => { },
        /** @deprecated Use `macros.register(name, { handler, description })` from scripts/macros/macro-system.js instead. */
        registerMacro: MacrosParser.registerMacro.bind(MacrosParser),
        /** @deprecated Use `macros.registry.unregisterMacro(name)` from scripts/macros/macro-system.js instead. */
        unregisterMacro: MacrosParser.unregisterMacro.bind(MacrosParser),
        registerFunctionTool: ToolManager.registerFunctionTool.bind(ToolManager),
        unregisterFunctionTool: ToolManager.unregisterFunctionTool.bind(ToolManager),
        isToolCallingSupported: ToolManager.isToolCallingSupported.bind(ToolManager),
        canPerformToolCalls: ToolManager.canPerformToolCalls.bind(ToolManager),
        ToolManager,
        registerDebugFunction,
        /** @deprecated Use renderExtensionTemplateAsync instead. */
        renderExtensionTemplate,
        renderExtensionTemplateAsync,
        registerDataBankScraper: ScraperManager.registerDataBankScraper.bind(ScraperManager),
        /** @deprecated Use callGenericPopup or Popup instead. */
        callPopup,
        callGenericPopup,
        /** @deprecated Use loader.show instead. */
        showLoader,
        /** @deprecated Use loader.hide instead. */
        hideLoader,
        mainApi: main_api,
        extensionSettings: extension_settings,
        ModuleWorkerWrapper,
        getTokenizerModel,
        generateQuietPrompt,
        generateRaw,
        generateRawData,
        writeExtensionField,
        writeExtensionFieldBulk,
        getThumbnailUrl,
        selectCharacterById,
        messageFormatting,
        shouldSendOnEnter,
        isMobile,
        t,
        translate,
        getCurrentLocale,
        addLocaleData,
        tags,
        tagMap: tag_map,
        menuType: menu_type,
        createCharacterData: create_save,
        /** @deprecated Legacy snake-case naming, compatibility with old extensions */
        event_types: event_types,
        Popup,
        POPUP_TYPE,
        POPUP_RESULT,
        chatCompletionSettings: oai_settings,
        textCompletionSettings: textgenerationwebui_settings,
        powerUserSettings: power_user,
        getCharacters,
        getOneCharacter,
        getCharacterCardFields,
        getCharacterSource,
        importFromExternalUrl,
        importTags,
        buildWorldInfoChatInput,
        buildWorldInfoGlobalScanData,
        simulateWorldInfoActivation,
        resolveWorldInfoForMessages,
        uuidv4,
        humanizedDateTime,
        updateMessageBlock,
        appendMediaToMessage,
        ensureMessageMediaIsArray,
        getMediaDisplay,
        getMediaIndex,
        scrollChatToBottom,
        scrollOnMediaLoad,
        macros,
        loader,
        swipe: {
            left: swipe_left,
            right: swipe_right,
            to: swipe,
            show: showSwipeButtons,
            hide: hideSwipeButtons,
            refresh: refreshSwipeButtons,
            isAllowed: isSwipingAllowed,
            state: () => swipeState,
        },
        variables: {
            local: {
                get: getLocalVariable,
                set: setLocalVariable,
                del: deleteLocalVariable,
                add: addLocalVariable,
                inc: incrementLocalVariable,
                dec: decrementLocalVariable,
                has: existsLocalVariable,
            },
            global: {
                get: getGlobalVariable,
                set: setGlobalVariable,
                del: deleteGlobalVariable,
                add: addGlobalVariable,
                inc: incrementGlobalVariable,
                dec: decrementGlobalVariable,
                has: existsGlobalVariable,
            },
        },
        setVariable,
        loadWorldInfo,
        loadWorldInfoBatch,
        saveWorldInfo,
        reloadWorldInfoEditor: reloadEditor,
        updateWorldInfoList,
        convertCharacterBook,
        getWorldInfoPrompt,
        getWorldInfoNames: () => Array.isArray(world_names) ? [...world_names] : [],
        getCharaAuxWorlds,
        createWorldBook: createNewWorldInfo,
        importEmbeddedWorldInfo,
        charUpdatePrimaryWorld,
        getCharacterEmbeddedWorld,
        getCharaFilename,
        CONNECT_API_MAP,
        getTextGenServer,
        extractMessageFromData,
        getPresetManager,
        getActivePromptPresetEnvelope,
        getActivePromptLayout,
        formatPromptPresetEnvelope,
        buildPresetAwarePromptMessages,
        getChatCompletionModel,
        printMessages,
        clearChat,
        ChatCompletionService,
        TextCompletionService,
        ConnectionManagerRequestService,
        updateReasoningUI,
        parseReasoningFromString,
        getReasoningTemplateByName,
        unshallowCharacter,
        unshallowGroupMembers,
        getExtensionManifest,
        openThirdPartyExtensionMenu,
        registerExtensionApi,
        getExtensionApi,
        getCharacterState,
        setCharacterState,
        updateCharacterData,
        persistCharacterData,
        persistCharacterDataDebounced,
        symbols: {
            ignore: IGNORE_SYMBOL,
        },
        constants: {
            unset: UNSET_VALUE,
        },
    };
}

export default getContext;
