import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createActivityGuardRegistry,
    getActiveActivities,
    hasUnloadGuard,
    hasChatSwitchGuard,
} from '../../public/scripts/activity-guard.js';
import {
    findPluginViolations,
    findReverseViolations,
} from '../../scripts/check-plugin-imports.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function makeLayer2FromRegistry(registry) {
    return Object.freeze({
        acquire: registry.acquireActivityLease,
        run: registry.withActivityLease,
        hasUnloadGuard: registry.hasUnloadGuard,
        hasChatSwitchGuard: registry.hasChatSwitchGuard,
        hasKeepAliveHold: registry.hasKeepAliveHold,
        list: registry.getActiveActivities,
        subscribe: registry.subscribeActivityGuard,
    });
}

let realGetContext;
let buildContext;
let createScopedActivityGuard;
let activeLayer2Mock = null;

beforeAll(async () => {
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

    const stContextMod = await import('../../public/scripts/st-context.js');
    realGetContext = stContextMod.getContext;
    await import('../../public/scripts/lukerContext.js');

    globalThis.Luker = {
        getContext: () => {
            const base = realGetContext();
            if (activeLayer2Mock === null) {
                return base;
            }
            return {
                ...base,
                activityGuard: activeLayer2Mock,
            };
        },
    };

    ({ buildContext, createScopedActivityGuard } = await import('../../public/scripts/extensions/card-app/context.js'));
});

beforeEach(() => {
    activeLayer2Mock = null;
});

describe('Layer 2 activityGuard exposure (st-context.js & lukerContext)', () => {
    test('exposes frozen 7-method activityGuard on getContext() and globalThis.lukerContext without cancelChatSwitchActivities', () => {
        const ctx2 = realGetContext();
        const lukerCtx = globalThis.lukerContext;

        expect(ctx2.activityGuard).toBeDefined();
        expect(Object.isFrozen(ctx2.activityGuard)).toBe(true);
        expect(lukerCtx.activityGuard).toBe(ctx2.activityGuard);

        expect(Object.keys(ctx2.activityGuard).sort()).toEqual([
            'acquire',
            'hasChatSwitchGuard',
            'hasKeepAliveHold',
            'hasUnloadGuard',
            'list',
            'run',
            'subscribe',
        ]);
        for (const key of Object.keys(ctx2.activityGuard)) {
            expect(typeof ctx2.activityGuard[key]).toBe('function');
        }
        expect('cancelChatSwitchActivities' in ctx2.activityGuard).toBe(false);
        expect(ctx2.activityGuard.cancelChatSwitchActivities).toBeUndefined();
    });

    test('delegates live state to the Layer 1 singleton', async () => {
        const ctx2 = realGetContext();
        const listener = jest.fn();
        const unsubscribe = ctx2.activityGuard.subscribe(listener);

        try {
            const release = ctx2.activityGuard.acquire({ source: 'ext:sync-test', label: 'Ext op', scope: 'chat' });
            try {
                expect(hasUnloadGuard()).toBe(true);
                expect(hasChatSwitchGuard()).toBe(true);
                expect(ctx2.activityGuard.hasUnloadGuard()).toBe(true);
                expect(ctx2.activityGuard.hasChatSwitchGuard()).toBe(true);
                expect(ctx2.activityGuard.hasKeepAliveHold()).toBe(true);
                expect(getActiveActivities().some(a => a.source === 'ext:sync-test')).toBe(true);
                expect(ctx2.activityGuard.list().some(a => a.source === 'ext:sync-test')).toBe(true);
                expect(listener).toHaveBeenCalledTimes(1);
            } finally {
                release();
            }

            expect(listener).toHaveBeenCalledTimes(2);
            expect(ctx2.activityGuard.list().some(a => a.source === 'ext:sync-test')).toBe(false);

            const val = await ctx2.activityGuard.run({ source: 'ext:run-test' }, async () => 'done');
            expect(val).toBe('done');
            expect(ctx2.activityGuard.list().some(a => a.source === 'ext:run-test')).toBe(false);
        } finally {
            unsubscribe();
        }
    });
});

describe('Layer 3 CardApp activityGuard exposure (card-app/context.js)', () => {
    let registry;
    let ctx;

    beforeEach(() => {
        registry = createActivityGuardRegistry();
        activeLayer2Mock = makeLayer2FromRegistry(registry);
        ctx = buildContext({}, 'char-1', {});
    });

    test('exposes the 7 public methods and does not expose cancelChatSwitchActivities', () => {
        expect(ctx.activityGuard).toBeDefined();
        expect(Object.keys(ctx.activityGuard).sort()).toEqual([
            'acquire',
            'hasChatSwitchGuard',
            'hasKeepAliveHold',
            'hasUnloadGuard',
            'list',
            'run',
            'subscribe',
        ]);
        expect('cancelChatSwitchActivities' in ctx.activityGuard).toBe(false);
        expect(ctx.activityGuard.cancelChatSwitchActivities).toBeUndefined();
    });

    test('acquire defaults scope to "chat" when omitted', () => {
        const release = ctx.activityGuard.acquire({ source: 'card:op', label: 'Op' });

        expect(ctx.activityGuard.hasChatSwitchGuard()).toBe(true);
        expect(ctx.activityGuard.hasUnloadGuard()).toBe(true);
        expect(ctx.activityGuard.hasKeepAliveHold()).toBe(true);
        expect(ctx.activityGuard.list()).toHaveLength(1);
        expect(ctx.activityGuard.list()[0]).toMatchObject({
            source: 'card:op',
            label: 'Op',
            scope: 'chat',
            guardChatSwitch: true,
            guardUnload: true,
        });

        release();
        expect(ctx.activityGuard.list()).toEqual([]);
    });

    test('explicit scope: "global" is preserved', () => {
        const release = ctx.activityGuard.acquire({
            source: 'card:bg',
            label: 'Background sync',
            scope: 'global',
        });

        expect(ctx.activityGuard.hasChatSwitchGuard()).toBe(false);
        expect(ctx.activityGuard.hasUnloadGuard()).toBe(true);
        expect(ctx.activityGuard.list()[0]).toMatchObject({
            source: 'card:bg',
            scope: 'global',
            guardChatSwitch: false,
            guardUnload: true,
        });

        release();
    });

    test('disposing the CardApp releases all still-held leases and unsubscribes all listeners', () => {
        const listener1 = jest.fn();
        const listener2 = jest.fn();
        ctx.activityGuard.subscribe(listener1);
        ctx.activityGuard.subscribe(listener2);

        const r1 = ctx.activityGuard.acquire({ source: 'card:first', label: 'First' });
        const r2 = ctx.activityGuard.acquire({ source: 'card:second', label: 'Second', scope: 'global' });

        expect(ctx.activityGuard.list()).toHaveLength(2);
        expect(listener1).toHaveBeenCalledTimes(2);
        expect(listener2).toHaveBeenCalledTimes(2);

        ctx._dispose();

        expect(ctx.activityGuard.list()).toEqual([]);
        expect(registry.hasUnloadGuard()).toBe(false);
        expect(registry.hasChatSwitchGuard()).toBe(false);
        // Listeners were unsubscribed in registration order before releases ran, so still 2 calls
        expect(listener1).toHaveBeenCalledTimes(2);
        expect(listener2).toHaveBeenCalledTimes(2);

        // Subsequent mutations on the registry must not invoke disposed CardApp listeners
        const outsideRelease = registry.acquireActivityLease({ source: 'other:op' });
        outsideRelease();
        expect(listener1).toHaveBeenCalledTimes(2);
        expect(listener2).toHaveBeenCalledTimes(2);

        // Post-dispose manual release / second dispose are safe no-ops
        r1();
        r2();
        ctx._dispose();
    });

    test('manual release and unsubscribe remove cleanup entries cleanly and remain idempotent', () => {
        const cleanups = [];
        const registerCleanup = (fn) => {
            cleanups.push(fn);
            return () => {
                const idx = cleanups.indexOf(fn);
                if (idx !== -1) cleanups.splice(idx, 1);
            };
        };

        const scoped = createScopedActivityGuard(makeLayer2FromRegistry(registry), registerCleanup);
        const listener = jest.fn();
        const unsubscribe = scoped.subscribe(listener);
        const release = scoped.acquire({ source: 'card:manual', label: 'Manual' });

        expect(cleanups).toHaveLength(2);
        expect(listener).toHaveBeenCalledTimes(1);

        release();
        release();
        expect(cleanups).toHaveLength(1);
        expect(registry.getActiveActivities()).toEqual([]);
        expect(listener).toHaveBeenCalledTimes(2);

        unsubscribe();
        unsubscribe();
        expect(cleanups).toHaveLength(0);

        const outsideRelease = registry.acquireActivityLease({ source: 'card:after-unsub' });
        outsideRelease();
        expect(listener).toHaveBeenCalledTimes(2);

        // Also verify on real buildContext() ctx
        const ctxRelease = ctx.activityGuard.acquire({ source: 'card:ctx-manual' });
        const ctxUnsub = ctx.activityGuard.subscribe(jest.fn());
        ctxRelease();
        ctxRelease();
        ctxUnsub();
        ctxUnsub();
        ctx._dispose();
        ctx._dispose();
    });

    test('run defaults scope to "chat" and releases in finally on both resolve and reject', async () => {
        let seenDuringRun = null;
        const result = await ctx.activityGuard.run(
            { source: 'card:run-ok', label: 'Run OK' },
            async () => {
                seenDuringRun = ctx.activityGuard.list();
                return 42;
            },
        );

        expect(result).toBe(42);
        expect(seenDuringRun).toHaveLength(1);
        expect(seenDuringRun[0].scope).toBe('chat');
        expect(seenDuringRun[0].guardChatSwitch).toBe(true);
        expect(ctx.activityGuard.list()).toEqual([]);

        await expect(
            ctx.activityGuard.run({ source: 'card:run-err', label: 'Run Err' }, async () => {
                expect(ctx.activityGuard.hasChatSwitchGuard()).toBe(true);
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        expect(ctx.activityGuard.list()).toEqual([]);
        expect(ctx.activityGuard.hasChatSwitchGuard()).toBe(false);
    });

    test('run cleans up via _dispose if CardApp unmounts mid-flight and handles late settlement idempotently', async () => {
        let resolvePending;
        const pending = new Promise((resolve) => {
            resolvePending = resolve;
        });

        const runPromise = ctx.activityGuard.run(
            { source: 'card:in-flight', label: 'In flight' },
            () => pending,
        );

        expect(ctx.activityGuard.hasChatSwitchGuard()).toBe(true);
        ctx._dispose();
        expect(ctx.activityGuard.hasChatSwitchGuard()).toBe(false);
        expect(ctx.activityGuard.list()).toEqual([]);

        resolvePending('settled-after-dispose');
        await expect(runPromise).resolves.toBe('settled-after-dispose');
        expect(ctx.activityGuard.list()).toEqual([]);
    });

    test('hasKeepAliveHold forwards filter options and invalid acquire/run inputs throw without leaking cleanups', async () => {
        const cleanups = [];
        const scoped = createScopedActivityGuard(makeLayer2FromRegistry(registry), (fn) => {
            cleanups.push(fn);
            return () => {
                const idx = cleanups.indexOf(fn);
                if (idx !== -1) cleanups.splice(idx, 1);
            };
        });

        expect(() => scoped.acquire({})).toThrow(TypeError);
        expect(() => scoped.subscribe('not-fn')).toThrow(TypeError);
        await expect(scoped.run({ source: 'card:bad-fn' }, 'not-fn')).rejects.toThrow(TypeError);
        expect(cleanups).toHaveLength(0);

        const release = ctx.activityGuard.acquire({
            source: 'card:ambient',
            ambient: true,
        });
        expect(ctx.activityGuard.hasKeepAliveHold()).toBe(true);
        expect(ctx.activityGuard.hasKeepAliveHold({ excludeAmbient: true })).toBe(false);
        expect(ctx.activityGuard.hasKeepAliveHold({ excludeSources: ['card:ambient'] })).toBe(false);
        release();
    });

    test('buildContext wires through real st-context.js Layer 2 when unmocked', () => {
        activeLayer2Mock = null;
        const realChainCtx = buildContext({}, 'char-real', {});
        const release = realChainCtx.activityGuard.acquire({ source: 'card:full-chain', label: 'Full chain' });
        try {
            expect(realGetContext().activityGuard.list().some(a => a.source === 'card:full-chain')).toBe(true);
            expect(hasChatSwitchGuard()).toBe(true);
        } finally {
            realChainCtx._dispose();
        }
        expect(realGetContext().activityGuard.list().some(a => a.source === 'card:full-chain')).toBe(false);
        release();
    });

    test('card-app/context.js preserves zero plugin boundary violations', () => {
        const { coreViolations, pluginViolations } = findPluginViolations(REPO_ROOT);
        const reverseViolations = findReverseViolations(REPO_ROOT);
        expect(coreViolations.size).toBe(0);
        expect(pluginViolations.size).toBe(0);
        expect(reverseViolations).toEqual([]);
    });
});
