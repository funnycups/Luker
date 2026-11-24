import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter } from '../../public/lib/eventemitter.js';
import {
    acquireActivityLease,
    getActiveActivities,
} from '../../public/scripts/activity-guard.js';

const noop = () => {};
const asyncNoop = async () => {};

function stubExports(names, overrides = {}) {
    const out = { ...overrides };
    for (const name of names) {
        if (!(name in out)) out[name] = noop;
    }
    return out;
}

class StubClass {}

let powerUserMod;
let power_user;
let syncMobileKeepAliveUi;
let scopedKeepAliveShouldHold;
let syncPipReopenBanner;
let doRandomChat;

let eventSource;
let pipViewStatus = 'idle';
let activeKeepAliveMode = 'off';
let pipWindowOpen = false;
let updatePipViewMock;
let setKeepAliveModeMock;
let bannerShowMock;
let bannerHideMock;
let selectCharacterByIdMock;
let setCharacterIdMock;
let setActiveCharacterMock;
let setActiveGroupMock;
let resetSelectedGroupMock;
let reloadCurrentChatMock;
let mockCharacters;

const EVENT_TYPES = {
    CHAT_CHANGED: 'chat_id_changed',
    GENERATION_STARTED: 'generation_started',
    GENERATION_AFTER_COMMANDS: 'generation_after_commands',
    STREAM_TOKEN_RECEIVED: 'stream_token_received',
    MESSAGE_RECEIVED: 'message_received',
    IMPERSONATE_READY: 'impersonate_ready',
    GENERATION_STOPPED: 'generation_stopped',
    IMAGE_GENERATION_STARTED: 'image_generation_started',
    IMAGE_GENERATION_ENDED: 'image_generation_ended',
};

beforeAll(async () => {
    eventSource = new EventEmitter();
    mockCharacters = [];
    updatePipViewMock = jest.fn(({ status }) => {
        if (status) pipViewStatus = status;
    });
    setKeepAliveModeMock = jest.fn(async (mode) => {
        activeKeepAliveMode = mode;
    });
    bannerShowMock = jest.fn();
    bannerHideMock = jest.fn();
    selectCharacterByIdMock = jest.fn(async () => true);
    setCharacterIdMock = jest.fn();
    setActiveCharacterMock = jest.fn();
    setActiveGroupMock = jest.fn();
    resetSelectedGroupMock = jest.fn();
    reloadCurrentChatMock = jest.fn(async () => {});

    jest.unstable_mockModule('../../public/script.js', () => stubExports([
        'saveSettingsDebounced', 'setImmersiveMode', 'scrollChatToBottom',
        'reloadMarkdownProcessor', 'getRequestHeaders',
        'substituteParams', 'getCurrentChatId', 'printCharactersDebounced',
        'setEditedMessageId', 'getFirstDisplayedMessageId',
        'showMoreMessages', 'saveSettings', 'saveChatConditional',
        'setAnimationDuration',
        'doNewChat', 'messageFormatting', 'deleteMessage', 'getThumbnailUrl',
    ], {
        characters: mockCharacters,
        chat: [],
        eventSource,
        event_types: EVENT_TYPES,
        ANIMATION_DURATION_DEFAULT: 0,
        entitiesFilter: { onSearchInput: noop },
        online_status: 'connected',
        extension_prompt_types: {},
        extension_prompt_roles: {},
        settingsReady: Promise.resolve(),
        name2: 'Assistant',
        this_chid: undefined,
        selectCharacterById: (...args) => selectCharacterByIdMock(...args),
        setCharacterId: (...args) => setCharacterIdMock(...args),
        setActiveCharacter: (...args) => setActiveCharacterMock(...args),
        setActiveGroup: (...args) => setActiveGroupMock(...args),
        reloadCurrentChat: (...args) => reloadCurrentChatMock(...args),
    }));
    jest.unstable_mockModule('../../public/scripts/luker-pip-view.js', () => ({
        getPipViewStatus: () => pipViewStatus,
        updatePipView: updatePipViewMock,
    }));
    jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
        isMobile: () => true,
        initMovingUI: noop,
        favsToHotswap: noop,
        shouldSendOnEnter: () => false,
    }));
    jest.unstable_mockModule('../../public/scripts/luker-keep-alive.js', () => ({
        getActiveKeepAliveMode: () => activeKeepAliveMode,
        getAvailableWebModes: () => ({ pip: true, audio: true }),
        getKeepAlivePlatform: () => 'web',
        hasNativeKeepAliveBridge: () => false,
        initKeepAlive: noop,
        isKeepAliveSupported: () => true,
        isPipWindowOpen: () => pipWindowOpen,
        onKeepAliveStateChanged: noop,
        primePipKeepAlive: noop,
        releasePipKeepAlive: noop,
        setKeepAliveMode: setKeepAliveModeMock,
        setPipPrimingEnabled: noop,
    }));
    jest.unstable_mockModule('../../public/scripts/app-endpoint-controls.js', () => ({ initAppEndpointControls: noop }));
    jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
        groups: [],
        resetSelectedGroup: (...args) => resetSelectedGroupMock(...args),
    }));
    jest.unstable_mockModule('../../public/scripts/instruct-mode.js', () => stubExports([
        'loadInstructMode', 'selectInstructPreset', 'updateBindModelTemplatesState',
    ], { instruct_presets: {}, names_behavior_types: {} }));
    jest.unstable_mockModule('../../public/scripts/tags.js', () => stubExports(['getTagsList'], {
        tag_import_setting: {},
        tag_map: {},
        tag_sort_mode: {},
        tags: [],
    }));
    jest.unstable_mockModule('../../public/scripts/tokenizers.js', () => ({
        initTokenizerSelects: noop,
        isSelectableTokenizer: () => true,
        tokenizers: { BEST_MATCH: 'best_match' },
    }));
    jest.unstable_mockModule('../../public/scripts/logit-bias.js', () => ({ BIAS_CACHE: new Map() }));
    jest.unstable_mockModule('../../public/scripts/templates.js', () => ({ renderTemplateAsync: asyncNoop }));
    jest.unstable_mockModule('../../public/scripts/utils.js', () => stubExports([
        'countOccurrences', 'delay', 'download', 'getFileText', 'getSanitizedFilename',
        'getStringHash', 'isOdd', 'isTrueBoolean', 'onlyUnique', 'resetScrollHeight',
        'shuffle', 'sortMoments', 'stringToRange', 'timestampToMoment',
    ], { debounce: (fn) => fn }));
    jest.unstable_mockModule('../../public/scripts/filters.js', () => ({ FILTER_TYPES: {}, fuzzySearchCategories: {} }));
    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
        PARSER_FLAG: {},
        SlashCommandParser: { addCommandObject: noop },
    }));
    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({ SlashCommand: { fromProps: () => ({}) } }));
    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
        ARGUMENT_TYPE: {},
        SlashCommandArgument: { fromProps: () => ({}) },
        SlashCommandNamedArgument: { fromProps: () => ({}) },
    }));
    jest.unstable_mockModule('../../public/scripts/autocomplete/AutoComplete.js', () => ({
        AUTOCOMPLETE_SELECT_KEY: {},
        AUTOCOMPLETE_STATE: {},
        AUTOCOMPLETE_WIDTH: {},
    }));
    jest.unstable_mockModule('../../public/scripts/browser-fixes.js', () => ({
        didMobileLayoutWidthChange: () => false,
        isWorldInfoEditorInputFocused: () => false,
    }));
    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
        SlashCommandEnumValue: StubClass,
        enumTypes: {},
    }));
    jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
        commonEnumProviders: { boolean: () => () => [] },
        enumIcons: {},
    }));
    jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
        POPUP_TYPE: {},
        callGenericPopup: asyncNoop,
        fixToastrForDialogs: noop,
    }));
    jest.unstable_mockModule('../../public/scripts/sysprompt.js', () => ({ loadSystemPrompts: asyncNoop }));
    jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
        accountStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    }));
    jest.unstable_mockModule('../../public/scripts/util/ThemeGenerator.js', () => stubExports([
        'extractDominantColor', 'generateThemePalette', 'deriveBackgroundName',
    ]));
    jest.unstable_mockModule('../../public/scripts/reasoning.js', () => ({
        DEFAULT_REASONING_TEMPLATE: {},
        loadReasoningTemplates: asyncNoop,
    }));
    jest.unstable_mockModule('../../public/scripts/chat-templates.js', () => ({ bindModelTemplates: noop }));
    jest.unstable_mockModule('../../public/scripts/constants.js', () => ({ IMAGE_OVERSWIPE: {}, MEDIA_DISPLAY: {} }));
    jest.unstable_mockModule('../../public/scripts/frontend-log-manager.js', () => ({ setFrontendConsoleDebugLoggingEnabled: noop }));
    jest.unstable_mockModule('../../public/scripts/luker-android-debug-trail.js', () => ({
        setAndroidDebugRecordingEnabled: noop,
        isAndroidDebugTrailAvailable: () => false,
        getAndroidDebugRecordingActualState: () => false,
    }));
    jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
        t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)),
        translate: (s) => String(s ?? ''),
    }));
    jest.unstable_mockModule('../../public/scripts/theme-palettes.js', () => stubExports([
        'getActiveThemePaletteColor', 'initThemePalettes', 'normalizeThemePalettes', 'syncThemePalettes',
    ]));
    jest.unstable_mockModule('../../public/scripts/backgrounds.js', () => ({
        getBackgroundPath: () => '',
        isCustomBackgroundUrl: () => false,
    }));
    jest.unstable_mockModule('../../public/scripts/self-profiler.js', () => ({
        downloadCurrentSelfProfileReport: noop,
        setSelfProfilerPreference: noop,
        syncSelfProfilerEnabled: noop,
    }));
    jest.unstable_mockModule('../../public/scripts/debug-export.js', () => ({
        registerDebugMenuAction: noop,
        setDebugMenuToggleState: noop,
    }));
    jest.unstable_mockModule('../../public/scripts/personas.js', () => ({
        persona_description_positions: {},
    }));

    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
    globalThis.document = {
        addEventListener: noop,
        removeEventListener: noop,
        visibilityState: 'visible',
        documentElement: { classList: { add: noop }, style: { setProperty: noop } },
    };
    globalThis.window = Object.assign(globalThis, {
        addEventListener: noop,
        removeEventListener: noop,
    });
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: { getItem: () => null, setItem: noop, removeItem: noop },
    });
    globalThis.toastr = { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() };

    const baseJQuery = globalThis.jQuery;
    const bannerChain = new Proxy(function () {}, {
        get(_, prop) {
            if (prop === 'then') return undefined;
            if (prop === 'show') return bannerShowMock;
            if (prop === 'hide') return bannerHideMock;
            return () => bannerChain;
        },
    });
    const customJQuery = Object.assign(
        function (selectorOrFn) {
            if (selectorOrFn === '<button></button>') {
                return bannerChain;
            }
            return baseJQuery(selectorOrFn);
        },
        baseJQuery,
    );
    globalThis.jQuery = customJQuery;
    globalThis.$ = customJQuery;

    powerUserMod = await import('../../public/scripts/power-user.js');
    ({
        power_user,
        syncMobileKeepAliveUi,
        scopedKeepAliveShouldHold,
        syncPipReopenBanner,
        doRandomChat,
    } = powerUserMod);
});

describe('public/scripts/power-user.js unified keep-alive and PiP status', () => {
    beforeEach(() => {
        pipViewStatus = 'idle';
        activeKeepAliveMode = 'off';
        pipWindowOpen = false;
        mockCharacters.splice(0, mockCharacters.length);
        power_user.luker_mobile_keep_alive_web_audio_enabled = false;
        power_user.luker_mobile_keep_alive_web_pip_enabled = false;
        updatePipViewMock.mockClear();
        setKeepAliveModeMock.mockClear();
        bannerShowMock.mockClear();
        bannerHideMock.mockClear();
        selectCharacterByIdMock.mockReset().mockResolvedValue(true);
        setCharacterIdMock.mockReset();
        setActiveCharacterMock.mockReset();
        setActiveGroupMock.mockReset();
        resetSelectedGroupMock.mockReset();
        reloadCurrentChatMock.mockReset().mockResolvedValue(undefined);
        if (getActiveActivities().length > 0) {
            throw new Error(`Expected empty activity guard before test, got: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    afterEach(() => {
        jest.useRealTimers();
        if (getActiveActivities().length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    test('before_unload_guard_mode setting is physically removed from power_user', () => {
        expect(Object.hasOwn(power_user, 'before_unload_guard_mode')).toBe(false);
    });

    test('scopedKeepAliveShouldHold follows hasKeepAliveHold across core, ambient, and plugin leases', () => {
        expect(scopedKeepAliveShouldHold()).toBe(false);

        const relNoKeepAlive = acquireActivityLease({ source: 'test:no-ka', keepAlive: false });
        expect(scopedKeepAliveShouldHold()).toBe(false);
        relNoKeepAlive();

        const relAmbient = acquireActivityLease({ source: 'core:generate-task', ambient: true, keepAlive: true });
        expect(scopedKeepAliveShouldHold()).toBe(true);
        relAmbient();
        expect(scopedKeepAliveShouldHold()).toBe(false);

        const relSd = acquireActivityLease({ source: 'sd:image', scope: 'chat', keepAlive: true });
        expect(scopedKeepAliveShouldHold()).toBe(true);
        relSd();
        expect(scopedKeepAliveShouldHold()).toBe(false);
    });

    test('syncMobileKeepAliveUi subscribes to activityGuard without IMAGE_GENERATION keep-alive listeners and drives audio keep-alive', () => {
        jest.useFakeTimers();
        power_user.luker_mobile_keep_alive_web_audio_enabled = true;

        syncMobileKeepAliveUi();

        expect(eventSource.events[EVENT_TYPES.IMAGE_GENERATION_STARTED]).toBeUndefined();
        expect(eventSource.events[EVENT_TYPES.IMAGE_GENERATION_ENDED]).toBeUndefined();

        const release = acquireActivityLease({ source: 'memory-graph:update', scope: 'chat', keepAlive: true });
        try {
            expect(setKeepAliveModeMock).toHaveBeenCalledWith('audio');
        } finally {
            release();
        }

        jest.advanceTimersByTime(10_000);
        expect(setKeepAliveModeMock).toHaveBeenCalledWith('off');
    });

    test('PiP generating->done transition ignores memory-graph leases and waits for core:generation and core:group-generation', () => {
        syncMobileKeepAliveUi();

        pipViewStatus = 'generating';
        const relGen = acquireActivityLease({ source: 'core:generation', scope: 'chat' });
        const relMg = acquireActivityLease({ source: 'memory-graph:update', scope: 'chat' });

        // Memory graph ending while generation runs must not flip PiP to done.
        relMg();
        expect(updatePipViewMock).not.toHaveBeenCalledWith({ status: 'done' });

        // Starting another memory-graph task before generation ends must not hold PiP at generating.
        const relMgAfter = acquireActivityLease({ source: 'memory-graph:update', scope: 'chat' });
        relGen();
        expect(updatePipViewMock).toHaveBeenCalledWith({ status: 'done' });
        relMgAfter();

        // Group generation also blocks premature generating -> done transition.
        updatePipViewMock.mockClear();
        pipViewStatus = 'generating';
        const relGroup = acquireActivityLease({ source: 'core:group-generation', scope: 'chat' });
        const relMember = acquireActivityLease({ source: 'core:generation', scope: 'chat' });
        relMember();
        expect(updatePipViewMock).not.toHaveBeenCalledWith({ status: 'done' });
        relGroup();
        expect(updatePipViewMock).toHaveBeenCalledWith({ status: 'done' });
    });

    test('syncPipReopenBanner ignores ambient and core generation sources when idle, and shows for explicit non-core tasks or active PiP generation', () => {
        power_user.luker_mobile_keep_alive_web_pip_enabled = true;

        // Ambient request baseline must not flash PiP reopen banner.
        const relAmbient = acquireActivityLease({ source: 'core:generate-raw', ambient: true, keepAlive: true });
        try {
            syncPipReopenBanner();
            expect(bannerShowMock).not.toHaveBeenCalled();
        } finally {
            relAmbient();
        }

        // Quiet generation must not surface the PiP reopen banner.
        bannerShowMock.mockClear();
        const relQuiet = acquireActivityLease({ source: 'core:generation-quiet', scope: 'chat', keepAlive: true });
        try {
            syncPipReopenBanner();
            expect(bannerShowMock).not.toHaveBeenCalled();
        } finally {
            relQuiet();
        }

        // Explicit non-core keep-alive task (e.g. image generation or Memory Graph) surfaces the restore banner.
        bannerShowMock.mockClear();
        const relSd = acquireActivityLease({ source: 'sd:image', scope: 'chat', keepAlive: true });
        try {
            bannerShowMock.mockClear();
            syncPipReopenBanner();
            expect(bannerShowMock).toHaveBeenCalledTimes(1);
        } finally {
            relSd();
        }

        // Releasing the explicit task hides the already-created banner.
        bannerHideMock.mockClear();
        syncPipReopenBanner();
        expect(bannerHideMock).toHaveBeenCalledTimes(1);

        // Active PiP status === 'generating' also surfaces the restore banner when PiP window is closed.
        bannerShowMock.mockClear();
        pipViewStatus = 'generating';
        syncPipReopenBanner();
        expect(bannerShowMock).toHaveBeenCalledTimes(1);
    });

    test('PiP feed triggers generating on GENERATION_AFTER_COMMANDS rather than GENERATION_STARTED and returns to done on lease release', () => {
        syncMobileKeepAliveUi();

        // GENERATION_STARTED alone (e.g. non-switching slash command before processCommands) must not pin PiP to generating.
        eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
        expect(pipViewStatus).toBe('idle');
        expect(updatePipViewMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'generating' }));

        // dryRun and quiet GENERATION_AFTER_COMMANDS must not pin PiP to generating.
        eventSource.emit(EVENT_TYPES.GENERATION_AFTER_COMMANDS, 'normal', {}, true);
        eventSource.emit(EVENT_TYPES.GENERATION_AFTER_COMMANDS, 'quiet', {}, false);
        expect(pipViewStatus).toBe('idle');

        // Normal GENERATION_AFTER_COMMANDS inside core:generation enters generating and transitions to done on release.
        const releaseGen = acquireActivityLease({ source: 'core:generation', scope: 'chat' });
        eventSource.emit(EVENT_TYPES.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        expect(pipViewStatus).toBe('generating');
        expect(updatePipViewMock).toHaveBeenCalledWith({ status: 'generating', text: '' });

        releaseGen();
        expect(pipViewStatus).toBe('done');
        expect(updatePipViewMock).toHaveBeenCalledWith({ status: 'done' });
    });

    test('/random (doRandomChat) routes through selectCharacterById and respects switch cancellation', async () => {
        mockCharacters.push({ name: 'Alice', avatar: 'alice.png' });

        // Cancelled switch guard must leave selection/group intact and return empty string.
        selectCharacterByIdMock.mockResolvedValueOnce(false);
        await expect(doRandomChat({}, '')).resolves.toBe('');
        expect(selectCharacterByIdMock).toHaveBeenCalledWith('0');
        expect(resetSelectedGroupMock).not.toHaveBeenCalled();
        expect(setCharacterIdMock).not.toHaveBeenCalled();
        expect(setActiveCharacterMock).not.toHaveBeenCalled();
        expect(setActiveGroupMock).not.toHaveBeenCalled();
        expect(reloadCurrentChatMock).not.toHaveBeenCalled();

        // Confirmed switch routes through selectCharacterById before updating active character/group markers.
        const order = [];
        selectCharacterByIdMock.mockImplementationOnce(async (id) => {
            order.push(['select', id]);
            return true;
        });
        setActiveCharacterMock.mockImplementationOnce((avatar) => order.push(['activeChar', avatar]));
        setActiveGroupMock.mockImplementationOnce((grp) => order.push(['activeGroup', grp]));

        await expect(doRandomChat({}, '')).resolves.toBe('Alice');
        expect(order).toEqual([
            ['select', '0'],
            ['activeChar', 'alice.png'],
            ['activeGroup', null],
        ]);
        expect(resetSelectedGroupMock).not.toHaveBeenCalled();
        expect(setCharacterIdMock).not.toHaveBeenCalled();
        expect(reloadCurrentChatMock).not.toHaveBeenCalled();
    });
});
