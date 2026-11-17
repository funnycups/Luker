/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';

import {
    createWorkbenchRegistry,
    registerWorkspace,
    registerIterateTarget,
    registerAskProvider,
    registerSuggestRuleProvider,
    open as openWorkbench,
    setOpenHandler,
    getWorkspaces,
    getIterateTargets,
    getAskProviders,
    getSuggestRuleProviders,
    subscribe as subscribeRegistry,
} from '../../public/scripts/workbench/registry.js';
import { mountWorkbench } from '../../public/scripts/workbench/app.js';
import { initWorkbench, resetWorkbenchForTest } from '../../public/scripts/workbench/index.js';
import { registerWorkbenchLocaleData } from '../../public/scripts/workbench/locale-data.js';

function createMockLukerContext({
    extensionNames = [],
    disabledExtensions = [],
    extensionSettings = {},
    locale = 'en',
} = {}) {
    const listeners = new Map();
    const localeTables = {};
    const eventSource = {
        on: (ev, fn) => {
            if (!listeners.has(ev)) listeners.set(ev, new Set());
            listeners.get(ev).add(fn);
        },
        off: (ev, fn) => listeners.get(ev)?.delete(fn),
        emit: async (ev, ...args) => {
            for (const fn of [...(listeners.get(ev) || [])]) {
                await fn(...args);
            }
        },
    };
    return {
        eventSource,
        eventTypes: { APP_READY: 'APP_READY', CHAT_CHANGED: 'CHAT_CHANGED' },
        extensionSettings: {
            disabledExtensions,
            ...extensionSettings,
        },
        listExtensionNames: () => [...extensionNames],
        addLocaleData: (loc, data) => {
            localeTables[loc] = { ...(localeTables[loc] || {}), ...data };
        },
        translate: (text) => localeTables[locale]?.[text] ?? text,
        getCurrentLocale: () => locale,
        accountStorage: null,
        saveSettings: async (_, opts) => opts?.onSaved?.(),
    };
}

beforeAll(() => {
    if (!globalThis.matchMedia) {
        globalThis.matchMedia = () => ({
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {},
        });
    }
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    }
    if (!globalThis.cancelAnimationFrame) {
        globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    }
    globalThis.toastr = { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() };
});

beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    globalThis.localStorage.clear();
    jest.restoreAllMocks();
});

afterEach(() => {
    resetWorkbenchForTest();
});

describe('workbench registry (order-independent)', () => {
    test('registers workspaces/targets before and after mount and updates live rail & status on deregister/disable', async () => {
        const reg = createWorkbenchRegistry();
        let memEnabled = true;
        const mountedMemoryOpts = [];
        const shownMemoryOpts = [];
        const aiShowOpts = [];

        // Register BEFORE mount
        const unregMem = reg.registerWorkspace({
            id: 'memory',
            title: 'Memory Lens',
            icon: 'memory',
            order: 10,
            tone: 'memory',
            isEnabled: () => memEnabled,
            mount: (host, { opts }) => {
                mountedMemoryOpts.push(opts);
                const el = document.createElement('div');
                el.className = 'test-mem-ws';
                el.textContent = 'Memory workspace mounted';
                host.appendChild(el);
                return {
                    show: (showOpts) => shownMemoryOpts.push(showOpts),
                    destroy: () => el.remove(),
                };
            },
        });
        const unregTargetBefore = reg.registerIterateTarget({ id: 'memory', label: 'Memory graph', order: 1 });

        expect(reg.getWorkspaces().map(w => w.id)).toEqual(['memory']);
        expect(reg.getIterateTargets().map(t => t.id)).toEqual(['memory']);

        const wb = mountWorkbench({
            registry: reg,
            startCollapsed: false,
            pages: {
                ai: () => {
                    const el = document.createElement('div');
                    el.className = 'test-ai-page';
                    return { el, show: (opts) => aiShowOpts.push(opts) };
                },
            },
        });

        // Initial connected fitToViewport measurement runs via win.refresh() right after mount
        await new Promise(r => globalThis.requestAnimationFrame(r));
        const layer = document.querySelector('.wbench');
        expect(layer.style.getPropertyValue('--wb-vh')).toBe(`${Math.round(window.innerHeight) / 100}px`);
        expect(layer.style.width).toBe(`${Math.round(window.innerWidth)}px`);

        // Rail renders built-in tabs + pre-mounted workspace
        const tabLabels = () => [...document.querySelectorAll('.wb-rail .wb-tab')].map(el => el.textContent);
        expect(tabLabels()).toContain('Memory Lens');

        // Register AFTER mount: rail and registry listeners update immediately
        let registryNotifications = 0;
        const unsub = reg.subscribe(() => { registryNotifications += 1; });
        const unregOrch = reg.registerWorkspace({
            id: 'orch',
            title: 'Orchestra Lens',
            icon: 'orch',
            order: 5,
            tone: 'orch',
            mount: () => {},
        });
        const unregAsk = reg.registerAskProvider({ id: 'chat-reader', label: 'Chat' });
        const unregSuggest = reg.registerSuggestRuleProvider({ id: 'mem-rules', rules: [] });

        expect(registryNotifications).toBeGreaterThanOrEqual(3);
        expect(reg.getWorkspaces().map(w => w.id)).toEqual(['orch', 'memory']);
        expect(tabLabels()).toContain('Orchestra Lens');
        expect(reg.getAskProviders().map(p => p.id)).toEqual(['chat-reader']);
        expect(reg.getSuggestRuleProviders().map(p => p.id)).toEqual(['mem-rules']);

        // Idempotent replace by id does not duplicate and stale unregister is a no-op
        const unregOrchNew = reg.registerWorkspace({
            id: 'orch',
            title: 'Orchestra V2',
            icon: 'orch',
            order: 5,
            tone: 'orch',
            mount: () => {},
        });
        expect(reg.getWorkspaces().filter(w => w.id === 'orch')).toHaveLength(1);
        expect(tabLabels()).toContain('Orchestra V2');
        unregOrch(); // stale unregister must not remove the replacement
        expect(reg.getWorkspaces().map(w => w.id)).toEqual(['orch', 'memory']);

        // Open the memory workspace and verify mount + show received navigation opts
        wb.open({ ws: 'memory', subview: 'nodes', focusId: 'n42' });
        expect(document.querySelector('.test-mem-ws')).not.toBeNull();
        expect(mountedMemoryOpts).toEqual([{ ws: 'memory', subview: 'nodes', focusId: 'n42' }]);
        expect(shownMemoryOpts).toEqual([{ ws: 'memory', subview: 'nodes', focusId: 'n42' }]);

        // Re-registering an already-mounted workspace unmounts stale view and remounts new mount()
        let v2Destroyed = false;
        const unregMemV2 = reg.registerWorkspace({
            id: 'memory',
            title: 'Memory V2',
            icon: 'memory',
            order: 10,
            tone: 'memory',
            isEnabled: () => memEnabled,
            mount: (host) => {
                const el = document.createElement('div');
                el.className = 'test-mem-ws-v2';
                host.appendChild(el);
                return () => { v2Destroyed = true; el.remove(); };
            },
        });
        expect(document.querySelector('.test-mem-ws')).toBeNull();
        expect(document.querySelector('.test-mem-ws-v2')).not.toBeNull();

        // Open core page with target options -> pageFactories.ai.show receives exact opts
        wb.open({ page: 'ai', ws: 'memory', scope: 'character' });
        expect(aiShowOpts).toEqual([{ page: 'ai', ws: 'memory', scope: 'character' }]);

        // Switch back to memory v2, then disable via isEnabled + notify -> tears down active workspace
        wb.open({ ws: 'memory' });
        memEnabled = false;
        reg.notify();
        expect(v2Destroyed).toBe(true);
        expect(tabLabels()).not.toContain('Memory V2');
        expect(document.querySelector('.test-mem-ws-v2')).toBeNull();

        // Deregistration cleans up live state
        unregOrchNew();
        unregMem();
        unregMemV2();
        unregTargetBefore();
        unregAsk();
        unregSuggest();
        unsub();

        expect(reg.getWorkspaces()).toEqual([]);
        expect(reg.getIterateTargets()).toEqual([]);
        expect(reg.getAskProviders()).toEqual([]);
        expect(reg.getSuggestRuleProviders()).toEqual([]);
        expect(tabLabels()).not.toContain('Orchestra V2');

        wb.close();
    });

    test('open({ page, ws, scope, subview, focusId }) queues before handler and forwards when wired', async () => {
        const reg = createWorkbenchRegistry();
        const received = [];

        // Called before handler exists -> queued
        const pendingPromise = reg.open({ page: 'ai', ws: 'memory', scope: 'character', subview: 'types', focusId: 'event' });
        expect(received).toEqual([]);

        reg.setOpenHandler(async (opts) => {
            received.push(opts);
            return opts;
        });

        await pendingPromise;
        expect(received).toEqual([
            { page: 'ai', ws: 'memory', scope: 'character', subview: 'types', focusId: 'event' },
        ]);

        // Subsequent call dispatches immediately
        await reg.open({ page: 'home', ws: 'preset' });
        expect(received).toHaveLength(2);
        expect(received[1]).toEqual({ page: 'home', ws: 'preset' });
    });

    test('singleton exports match registry contract', () => {
        const u1 = registerWorkspace({ id: 'singleton-test', title: 'S', icon: 'home', mount: () => {} });
        const u2 = registerIterateTarget({ id: 't1' });
        const u3 = registerAskProvider({ id: 'a1' });
        const u4 = registerSuggestRuleProvider({ id: 's1' });
        const u5 = subscribeRegistry(() => {});
        expect(getWorkspaces().some(w => w.id === 'singleton-test')).toBe(true);
        expect(getIterateTargets().some(t => t.id === 't1')).toBe(true);
        expect(getAskProviders().some(p => p.id === 'a1')).toBe(true);
        expect(getSuggestRuleProviders().some(r => r.id === 's1')).toBe(true);
        expect(typeof openWorkbench).toBe('function');
        expect(typeof setOpenHandler).toBe('function');
        u1(); u2(); u3(); u4(); u5();
    });
});

describe('workbench index bootstrap & st-context exposure', () => {
    test('st-context.js exposes workbench platform API synchronously on getContext() and lukerContext', async () => {
        const noop = () => {};
        const asyncNoop = async () => {};
        const stubExports = (names, overrides = {}) => {
            const out = { ...overrides };
            for (const name of names) {
                if (!(name in out)) out[name] = noop;
            }
            return out;
        };

        jest.unstable_mockModule('fflate', () => ({
            gzipSync: (x) => x,
            gzip: (x, cb) => cb?.(null, x),
        }));
        jest.unstable_mockModule('../../public/script.js', () => stubExports([
            'activateSendButtons', 'addOneMessage', 'appendMediaToMessage', 'callPopup',
            'deactivateSendButtons', 'extractMessageFromData', 'Generate', 'generateQuietPrompt',
            'getCharacters', 'getCurrentChatId', 'getRequestHeaders', 'getThumbnailUrl',
            'messageFormatting', 'openCharacterChat', 'reloadCurrentChat', 'renameChat',
            'saveChatConditional', 'saveChatDebounced', 'saveMetadata', 'saveReply',
            'saveSettingsDebounced', 'selectCharacterById', 'sendGenerationRequest',
            'sendStreamingRequest', 'sendSystemMessage', 'setExtensionPrompt', 'stopGeneration',
            'substituteParams', 'substituteParamsExtended', 'updateChatMetadata',
            'updateMessageBlock', 'printMessages', 'clearChat', 'unshallowCharacter',
            'deleteLastMessage', 'getCharacterCardFields', 'buildWorldInfoChatInput',
            'buildWorldInfoGlobalScanData', 'simulateWorldInfoActivation',
            'getActiveWorldInfoPromptFields', 'appendChatMessages', 'patchChatMessages',
            'saveChatMetadata', 'getChatState', 'getChatStateBatch', 'patchChatState',
            'updateChatState', 'setVariable', 'getPresetState', 'listPresetDocuments',
            'readPresetDocument', 'getPresetStateBatch', 'patchPresetState', 'updatePresetState',
            'deleteChatState', 'deletePresetState', 'deleteAllPresetState', 'swipe_right',
            'swipe_left', 'generateRaw', 'generateRawData', 'showSwipeButtons', 'hideSwipeButtons',
            'deleteMessage', 'refreshSwipeButtons', 'swipe', 'isSwipingAllowed',
            'ensureMessageMediaIsArray', 'getMediaDisplay', 'getMediaIndex', 'scrollChatToBottom',
            'scrollOnMediaLoad', 'getOneCharacter', 'getCharacterSource', 'createRawPrompt',
            'getGenerateUrl', 'closeCurrentChat', 'doNewChat', 'getPastCharacterChats',
            'deleteCharacterChatByName', 'updateCharacterData', 'persistCharacterData',
            'persistCharacterDataDebounced', 'saveSettings', 'createModelIcon',
            'resolveChatStateTarget', 'sendTextareaMessage', 'buildObjectPatchOperationsAsync',
        ], {
            characters: [],
            chat: [],
            chat_metadata: {},
            CONNECT_API_MAP: {},
            create_save: {},
            event_types: {},
            eventSource: { on: noop, off: noop, emit: asyncNoop, once: noop, emitAndWait: asyncNoop },
            extension_prompts: {},
            extension_prompt_types: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
            extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            main_api: 'openai',
            max_context: 4096,
            menu_type: '',
            name1: 'User',
            name2: 'Char',
            online_status: 'no_connection',
            streamingProcessor: null,
            swipeState: {},
            this_chid: 0,
            amount_gen: 100,
            converter: { makeHtml: (s) => String(s ?? '') },
            settingsReady: false,
        }));
        jest.unstable_mockModule('../../public/scripts/extensions.js', () => stubExports([
            'getExtensionManifest', 'openThirdPartyExtensionMenu', 'registerExtensionApi',
            'getExtensionApi', 'getCharacterState', 'setCharacterState', 'patchCharacterState',
            'updateCharacterState', 'getCharacterStateBatch', 'deleteCharacterState',
            'getGlobalState', 'setGlobalState', 'patchGlobalState', 'updateGlobalState',
            'getGlobalStateBatch', 'deleteGlobalState', 'renderExtensionTemplate',
            'renderExtensionTemplateAsync', 'saveMetadataDebounced', 'writeExtensionField',
            'writeExtensionFieldBulk',
        ], {
            extensionNames: [],
            extension_settings: {},
            ModuleWorkerWrapper: class {},
            UNSET_VALUE: '__@@UNSET@@__',
        }));
        jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
            groups: [], openGroupChat: asyncNoop, selected_group: null, unshallowGroupMembers: asyncNoop,
        }));
        jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
            addLocaleData: noop, getCurrentLocale: () => 'en', t: (s) => String(s ?? ''), translate: (s) => String(s ?? ''),
        }));
        jest.unstable_mockModule('../../public/scripts/loader.js', () => ({ hideLoader: noop, showLoader: noop }));
        jest.unstable_mockModule('../../public/scripts/action-loader.js', () => ({ loader: {} }));
        jest.unstable_mockModule('../../public/scripts/macros.js', () => ({
            MacrosParser: { registerMacro: noop, unregisterMacro: noop },
        }));
        jest.unstable_mockModule('../../public/scripts/openai.js', () => stubExports([
            'getChatCompletionModel', 'sendOpenAIRequest', 'stripOpenAIConnectionFieldsFromPreset',
            'saveOpenAIPreset', 'hasUnsavedOpenAIPresetChanges', 'applyPresetByName',
            'syncSavedCharacterBoundPreset',
        ], { oai_settings: {}, openai_settings: [], openai_setting_names: {}, proxies: [], ZAI_ENDPOINT: '', promptManager: {} }));
        jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
            callGenericPopup: asyncNoop, Popup: class {}, POPUP_TYPE: {}, POPUP_RESULT: {},
        }));
        jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
            power_user: {}, registerDebugFunction: noop, performFuzzySearch: () => [],
        }));
        jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({ getPresetManager: () => null }));
        jest.unstable_mockModule('../../public/scripts/preset-persistence.js', () => ({ persistPreset: asyncNoop }));
        jest.unstable_mockModule('../../public/scripts/character/presets.js', () => stubExports([
            'listCharacterBoundPresets', 'getCharacterBoundPreset', 'addCharacterBoundPreset',
            'updateCharacterBoundPreset', 'removeCharacterBoundPreset', 'setCharacterBoundDefault',
            'resolveCharacterBoundPresetByName', 'clearAllCharacterBoundPresets',
        ]));
        jest.unstable_mockModule('../../public/scripts/character/card-binding-preservation.js', () => ({
            registerCardBindingSlot: noop, listCardBindingSlots: () => [],
        }));
        jest.unstable_mockModule('../../public/scripts/character/post-replace-actions.js', () => ({
            registerPostReplaceAction: noop, listPostReplaceActions: () => [],
            importEmbeddedBookForCharacter: asyncNoop, rebindPreviousPrimaryBook: asyncNoop,
        }));
        jest.unstable_mockModule('../../public/scripts/character/preset-ref-codec.js', () => ({ decodeCardBoundOptionValue: () => null }));
        jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
            humanizedDateTime: () => '', isMobile: () => false, shouldSendOnEnter: () => true,
        }));
        jest.unstable_mockModule('../../public/scripts/scrapers.js', () => ({ ScraperManager: { registerDataBankScraper: noop } }));
        jest.unstable_mockModule('../../public/scripts/slash-commands.js', () => ({
            executeSlashCommands: asyncNoop, executeSlashCommandsWithOptions: asyncNoop, registerSlashCommand: noop,
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({ SlashCommand: class {} }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
            ARGUMENT_TYPE: {}, SlashCommandArgument: class {}, SlashCommandNamedArgument: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({ SlashCommandEnumValue: class {} }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({ SlashCommandParser: { addCommandObject: noop } }));
        jest.unstable_mockModule('../../public/scripts/tags.js', () => ({ tag_map: {}, tags: [], importTags: noop }));
        jest.unstable_mockModule('../../public/scripts/textgen-settings.js', () => ({
            getTextGenServer: () => '', getTextGenGenerationData: () => ({}), textgenerationwebui_settings: {}, textgen_types: {},
        }));
        jest.unstable_mockModule('../../public/scripts/tokenizers.js', () => ({
            tokenizers: {}, tokenizer_settings: {}, getTextTokens: () => [],
            getTokenCount: () => 0, getTokenCountAsync: async () => 0, getTokenizerModel: () => '',
        }));
        jest.unstable_mockModule('../../public/scripts/tool-calling.js', () => ({
            ToolManager: {
                registerFunctionTool: noop, unregisterFunctionTool: noop,
                isToolCallingSupported: () => false, canPerformToolCalls: () => false,
            },
        }));
        jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({ accountStorage: {} }));
        jest.unstable_mockModule('../../public/scripts/utils.js', () => stubExports([
            'areLookupNamesEqual', 'findCanonicalNameInList', 'timestampToMoment', 'uuidv4',
            'importFromExternalUrl', 'getCharaFilename', 'escapeHtml', 'download', 'getFileText',
            'getStringHash', 'createThumbnail', 'isValidUrl',
        ]));
        jest.unstable_mockModule('../../public/scripts/variables.js', () => stubExports([
            'addGlobalVariable', 'addLocalVariable', 'decrementGlobalVariable', 'decrementLocalVariable',
            'deleteGlobalVariable', 'deleteLocalVariable', 'existsGlobalVariable', 'existsLocalVariable',
            'getGlobalVariable', 'getLocalVariable', 'incrementGlobalVariable', 'incrementLocalVariable',
            'popLocalVariable', 'pushLocalVariable', 'setGlobalVariable', 'setLocalVariable',
        ]));
        jest.unstable_mockModule('../../public/scripts/world-info.js', () => stubExports([
            'convertCharacterBook', 'getWorldInfoPrompt', 'loadWorldInfo', 'loadWorldInfoBatch',
            'reloadEditor', 'saveWorldInfo', 'updateWorldInfoList', 'getCharaAuxWorlds',
            'createNewWorldInfo', 'importEmbeddedWorldInfo', 'charUpdatePrimaryWorld',
            'getCharacterEmbeddedWorld', 'newWorldInfoEntryTemplate', 'createWorldInfoEntry',
            'setWorldInfoButtonClass', 'setGlobalWorldInfoSelection', 'deleteWorldInfoEntry',
            'deleteWorldInfo', 'getChatWorldInfoNames', 'setChatWorldInfoSelection', 'getSortedEntries',
        ], { wi_anchor_position: {}, world_info_position: {}, world_names: [], selected_world_info: [] }));
        jest.unstable_mockModule('../../public/scripts/custom-request.js', () => ({ ChatCompletionService: {}, TextCompletionService: {} }));
        jest.unstable_mockModule('../../public/scripts/extensions/shared.js', () => ({ ConnectionManagerRequestService: {} }));
        jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
            getChatCompletionConnectionProfiles: () => [], resolveChatCompletionRequestProfile: () => null,
        }));
        jest.unstable_mockModule('../../public/scripts/reasoning.js', () => ({
            updateReasoningUI: noop, parseReasoningFromString: () => ({}),
            getReasoningTemplateByName: () => null, removeReasoningFromString: (s) => s,
        }));
        jest.unstable_mockModule('../../public/scripts/constants.js', () => ({ IGNORE_SYMBOL: Symbol('IGNORE'), inject_ids: {} }));
        jest.unstable_mockModule('../../public/scripts/macros/macro-system.js', () => ({ macros: {} }));
        jest.unstable_mockModule('../../public/scripts/message-formatter.js', () => ({ MessageFormatter: class {} }));
        jest.unstable_mockModule('../../public/scripts/extensions/regex/engine.js', () => ({ getRegexedString: (s) => s, regex_placement: {} }));
        jest.unstable_mockModule('../../public/scripts/messages.js', () => stubExports(['addMessages', 'updateMessages', 'deleteMessages', 'getMessage', 'getMessageCount']));
        jest.unstable_mockModule('../../public/scripts/floor-state.js', () => ({ createFloorState: () => ({}) }));
        jest.unstable_mockModule('../../public/scripts/generate-task.js', () => ({
            generateTask: asyncNoop, generateTaskStream: asyncNoop, GenerateTaskError: class extends Error {}, resolveOpenAiStreamFlag: () => false,
        }));
        jest.unstable_mockModule('../../public/scripts/message-takeover.js', () => ({ createMessageEditorHandle: noop, TakeoverError: class extends Error {} }));
        jest.unstable_mockModule('../../public/scripts/horde.js', () => ({ generateHorde: asyncNoop }));
        jest.unstable_mockModule('../../public/scripts/kai-settings.js', () => ({
            getKoboldGenerationData: () => ({}), kai_settings: {}, koboldai_settings: {}, koboldai_setting_names: {},
        }));
        jest.unstable_mockModule('../../public/scripts/nai-settings.js', () => ({
            getNovelGenerationData: () => ({}), nai_settings: {}, novelai_settings: {}, novelai_setting_names: {},
        }));
        jest.unstable_mockModule('../../public/scripts/lib/edits/index.js', () => ({}));
        jest.unstable_mockModule('../../public/scripts/lib/plugin-prompt-regex.js', () => ({ applyPluginLaneRegex: (m) => m }));
        jest.unstable_mockModule('../../public/scripts/lib/plugin-floors.js', () => ({ readPluginFloors: () => [], floorRecordToTaskMessage: (r) => r }));
        jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({}));
        jest.unstable_mockModule('../../public/scripts/extensions/luker-tabs.js', () => ({ renderLukerTabs: noop }));
        jest.unstable_mockModule('../../public/scripts/extensions/field-help.js', () => ({ renderFieldHelpButton: noop }));
        jest.unstable_mockModule('../../public/scripts/skills/api.js', () => ({ skillsApi: {} }));
        jest.unstable_mockModule('../../public/scripts/run-panel/index.js', () => ({}));
        jest.unstable_mockModule('../../public/scripts/secrets.js', () => ({ SECRET_KEYS: {}, secret_state: {} }));
        jest.unstable_mockModule('../../public/scripts/embedding-service.js', () => ({ EmbeddingService: class {} }));
        jest.unstable_mockModule('../../public/scripts/user.js', () => ({ accountsEnabled: false, currentUser: null }));

        const { getContext } = await import('../../public/scripts/st-context.js');
        await import('../../public/scripts/lukerContext.js');

        const ctx = getContext();
        const lukerCtx = globalThis.lukerContext;
        expect(ctx.workbench).toBeDefined();
        expect(lukerCtx.workbench).toBe(ctx.workbench);
        for (const method of [
            'registerWorkspace',
            'registerIterateTarget',
            'registerAskProvider',
            'registerSuggestRuleProvider',
            'open',
            'saveSettingsChecked',
            'getWorkspaces',
            'getIterateTargets',
            'getAskProviders',
            'getSuggestRuleProviders',
            'subscribe',
        ]) {
            expect(typeof ctx.workbench[method]).toBe('function');
        }

        // Verify live singleton wiring: registering through ctx.workbench reflects in registry exports
        const unreg = ctx.workbench.registerWorkspace({ id: 'ctx-runtime-ws', title: 'Ctx WS', icon: 'home', mount: () => {} });
        expect(getWorkspaces().some(w => w.id === 'ctx-runtime-ws')).toBe(true);
        expect(ctx.workbench.getWorkspaces().some(w => w.id === 'ctx-runtime-ws')).toBe(true);
        unreg();
        expect(getWorkspaces().some(w => w.id === 'ctx-runtime-ws')).toBe(false);
    });

    test('initWorkbench mounts corner pill on APP_READY, adds wand item, and supports Alt+W', async () => {
        const menu = document.createElement('div');
        menu.id = 'extensionsMenu';
        document.body.appendChild(menu);

        const ctx = createMockLukerContext({
            extensionSettings: { workbench: { pill: true, hotkey: 'alt+w' } },
        });
        globalThis.Luker = { getContext: () => ctx };
        initWorkbench();

        // Wand menu item added
        const wandItem = document.getElementById('luker_workbench_wand_item');
        expect(wandItem).not.toBeNull();
        expect(wandItem.textContent).toContain('Workbench');

        // APP_READY mounts collapsed pill and injects stylesheets idempotently
        await ctx.eventSource.emit('APP_READY');
        expect(document.querySelector('.wbench .wb-pill')).not.toBeNull();
        expect(document.querySelector('.wbench .wb-win').hidden).toBe(true);
        expect(document.querySelectorAll('link[href*="lens-shared/tokens.css"]')).toHaveLength(1);
        expect(document.querySelectorAll('link[href*="workbench/style.css"]')).toHaveLength(1);

        // Alt+W opens and toggles
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', altKey: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 20));
        expect(document.querySelector('.wbench .wb-win').hidden).toBe(false);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', altKey: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 20));
        expect(document.querySelector('.wbench .wb-win').hidden).toBe(true);

        // openWorkbench({ page: 'ai', ws: 'memory', scope: 'character' }) opens core AI page without mounting memory workspace
        let memoryMountedOpts = [];
        const unreg = registerWorkspace({
            id: 'memory',
            title: 'Memory',
            icon: 'memory',
            mount: (_host, { opts }) => { memoryMountedOpts.push(opts); },
        });
        await openWorkbench({ page: 'ai', ws: 'memory', scope: 'character' });
        expect(document.querySelector('.wbench .wb-win').hidden).toBe(false);
        expect(document.querySelector('.wb-tab[aria-selected="true"]').textContent).toContain('AI iteration');
        expect(memoryMountedOpts).toEqual([]);

        // openWorkbench({ ws: 'memory', subview: 'nodes', focusId: 'n1' }) mounts the workspace directly with opts
        await openWorkbench({ ws: 'memory', subview: 'nodes', focusId: 'n1' });
        expect(document.querySelector('.wb-tab[aria-selected="true"]').textContent).toContain('Memory');
        expect(memoryMountedOpts).toEqual([{ ws: 'memory', subview: 'nodes', focusId: 'n1' }]);

        // openWorkbench() with no args when already expanded focuses the workbench window
        const outsideBtn = document.createElement('button');
        document.body.appendChild(outsideBtn);
        outsideBtn.focus();
        expect(document.activeElement).toBe(outsideBtn);
        await openWorkbench();
        expect(document.activeElement).toBe(document.querySelector('.wbench .wb-win'));
        outsideBtn.remove();
        unreg();
    });
});

describe('workbench boundary and locale-data contracts', () => {
    test('public/scripts/workbench/ has zero imports from extensions/, extensions.js, or script.js, and zero innerHTML', () => {
        const rootDir = fileURLToPath(new URL('../../public/scripts/workbench/', import.meta.url));
        const collectJs = (dir) => {
            const out = [];
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = `${dir}/${entry.name}`;
                if (entry.isDirectory()) out.push(...collectJs(full));
                else if (entry.name.endsWith('.js')) out.push(full);
            }
            return out;
        };
        const files = collectJs(rootDir);
        expect(files.length).toBeGreaterThan(5);
        for (const file of files) {
            const src = readFileSync(file, 'utf8');
            const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
            expect(code).not.toMatch(/from\s+['"][^'"]*extensions(?:\/|\.js['"])/);
            expect(code).not.toMatch(/import\s*\(\s*['"][^'"]*extensions(?:\/|\.js['"])/);
            expect(code).not.toMatch(/from\s+['"][^'"]*script\.js['"]/);
            expect(code).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML)\b/);
        }
    });

    test('locale-data has matching ZH_CN/ZH_TW keys, no unescaped semicolons, full-width CJK punctuation, and zero overlap with core locale JSONs', () => {
        const captured = {};
        registerWorkbenchLocaleData((locale, data) => {
            captured[locale] = data;
        });

        expect(Object.keys(captured)).toEqual(['zh-cn', 'zh-tw']);
        const cnKeys = Object.keys(captured['zh-cn']).sort();
        const twKeys = Object.keys(captured['zh-tw']).sort();
        expect(cnKeys).toEqual(twKeys);

        for (const key of cnKeys) {
            expect(key.replace(/\\;/g, '')).not.toContain(';');
        }

        const zhCnCore = JSON.parse(readFileSync(fileURLToPath(new URL('../../public/locales/zh-cn.json', import.meta.url)), 'utf8'));
        const zhTwCore = JSON.parse(readFileSync(fileURLToPath(new URL('../../public/locales/zh-tw.json', import.meta.url)), 'utf8'));
        for (const key of cnKeys) {
            expect(Object.hasOwn(zhCnCore, key)).toBe(false);
            expect(Object.hasOwn(zhTwCore, key)).toBe(false);
        }

        for (const loc of ['zh-cn', 'zh-tw']) {
            for (const val of Object.values(captured[loc])) {
                expect(val).not.toMatch(/[\u4e00-\u9fff][,;:!?()]|[,;:!?()][\u4e00-\u9fff]/);
            }
        }
    });

    test('shell.css lifts host #toast-container above open Workbench windows across all pages, not only memory-graph settings', () => {
        const shellCss = readFileSync(fileURLToPath(new URL('../../public/scripts/workbench/css/shell.css', import.meta.url)), 'utf8');
        const mgSettingsCss = readFileSync(fileURLToPath(new URL('../../public/scripts/extensions/memory-graph/lens/css/settings.css', import.meta.url)), 'utf8');
        expect(shellCss).toMatch(/body:has\(\.wbench\s+\.wb-win:not\(\[hidden\]\)\)\s+#toast-container\s*\{\s*z-index:\s*2147483000\s*;/);
        expect(mgSettingsCss).not.toContain('#toast-container');
    });
});
