/**
 * Shared mock stack for the checkpoint state-event tests
 * (tests/bookmarks/checkpoint-*.test.js).
 *
 * Jest's ESM mock namespace evaluates the factory object's properties ONCE at
 * module instantiation — `import { chat }`-style bindings in bookmarks.js
 * therefore see a snapshot of the values present when bookmarks.js was
 * imported, NOT live getters. Consumers must apply their scenario via
 * loadBookmarks() before the FIRST bookmarks.js import, which means one
 * scenario per test file.
 *
 * NOTE on relative paths: `jest.unstable_mockModule` resolves the specifier
 * relative to the consuming TEST FILE (tests/bookmarks/), not this helper's
 * directory — same convention as tests/memory-graph/_mocks/main-module-stack.js.
 */

import { jest } from '@jest/globals';
import { SCRIPT_EXPORT_NAMES } from './script-exports.js';
import { GROUP_CHATS_EXPORT_NAMES } from './group-chats-exports.js';

// Scenario state consumed by the script.js / group-chats.js mock getters.
export const state = {
    chat: [],
    characters: [],
    this_chid: 0,
    chat_metadata: {},
    selected_group: false,
    groups: [],
};

// Call log of every chat-mutating mock, in call order: [label, ...args].
export const calls = [];
const record = (label, impl) => jest.fn(async (...args) => {
    calls.push([label, ...args]);
    return impl ? impl(...args) : undefined;
});

export const settleSpy = record('settle');
export const emitSpy = record('emit');
export const saveChatSpy = record('saveChat');
export const saveGroupSpy = record('saveGroup');
export const saveConditionalSpy = record('saveConditional');

// Inert stand-in for exports no test touches. Callable, constructible and
// chainable via a Proxy so load-time calls in transitive importers
// (`new X()`, `X.method(...)`, `X.on(...)`) are harmless no-ops.
function genericStub() {
    const fn = function () {};
    return new Proxy(fn, {
        get(target, prop) {
            if (prop === 'then') return undefined;
            if (typeof prop === 'symbol') return Reflect.get(target, prop);
            return genericStub();
        },
        apply() { return undefined; },
        construct() { return {}; },
    });
}

// script.js carries ~300 live exports; transitive importers
// (slash-commands.js -> variables.js -> slash-commands.js, stats.js, …) link
// against the full set at module-evaluation time, so the mock must expose
// every real export name. Values default to inert stubs; the entries after
// the spread carry the behavior the tests actually assert.
jest.unstable_mockModule('../../public/script.js', () => ({
    ...Object.fromEntries(SCRIPT_EXPORT_NAMES.map((n) => [n, genericStub()])),
    get chat() { return state.chat; },
    get characters() { return state.characters; },
    get this_chid() { return state.this_chid; },
    get chat_metadata() { return state.chat_metadata; },
    saveChat: saveChatSpy,
    saveChatConditional: saveConditionalSpy,
    saveItemizedPrompts: async () => {},
    system_message_types: { SYSTEM: 'system' },
    eventSource: { emit: emitSpy, on: () => {} },
    event_types: { CHAT_BRANCH_CREATED: 'chat_branch_created' },
    syncSwipeToMes: () => true,
    openCharacterChat: async () => {},
    getRequestHeaders: () => ({}),
    getThumbnailUrl: (_type, name) => name,
    getCharacters: async () => {},
    setActiveGroup: () => {},
    getCharacterName: (data) => data?.name ?? '',
    isCharacterFavorite: () => false,
    getCurrentChatDetails: () => ({ sessionName: 'Main Chat' }),
    substituteParams: (s) => s,
    extension_prompt_roles: {},
    extension_prompt_types: {},
    name2: 'You',
    neutralCharacterName: 'Neutral',
    user_avatar: 'avatar.png',
    processDroppedFiles: () => {},
    // Transitive slash-command/macro-engine deps resolve these at link time.
    saveSettingsDebounced: () => {},
    name1: 'You',
    getCharacterCardFieldsLazy: () => ({}),
    getGeneratingModel: () => 'model',
    parseMesExamples: (s) => s,
    main_api: 'openai',
    getMaxPromptTokens: () => 4096,
    getMaxContextTokens: () => 4096,
    getMaxResponseTokens: () => 512,
    extension_prompts: {},
    getCurrentChatId: () => 'chat-main',
}));

jest.unstable_mockModule('../../public/scripts/floor-state.js', () => ({
    settleMessageDeleted: record('settleMessageDeleted'),
    settleMessageSwiped: record('settleMessageSwiped'),
    settleMessageSwipeDeleted: record('settleMessageSwipeDeleted'),
    settleChatChanged: record('settleChatChanged'),
    settleBranchCreated: settleSpy,
    createFloorState: () => ({}),
    createFloorStateWithDeps: () => ({}),
}));

// Mirror the full export surface of group-chats.js (re-export block +
// functions + consts) so transitive importers link cleanly.
jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
    ...Object.fromEntries(GROUP_CHATS_EXPORT_NAMES.map((n) => [n, genericStub()])),
    DEFAULT_AUTO_MODE_DELAY: 5,
    group_activation_strategy: { NATURAL: 0 },
    group_generation_mode: {},
    get groups() { return state.groups; },
    get selected_group() { return state.selected_group; },
    saveGroupBookmarkChat: saveGroupSpy,
    getGroupChat: async () => state.chat,
    saveGroupChat: record('saveGroupChat'),
    regenerateGroup: async () => {},
    resetSelectedGroup: () => {},
}));

jest.unstable_mockModule('../../public/scripts/popup.js', () => {
    class PopupMock {
        constructor() {}
        async show() { return null; }
    }
    PopupMock.show = { input: jest.fn(async () => null), confirm: async () => null };
    return {
        Popup: PopupMock,
        POPUP_TYPE: { DISPLAY: 0, INPUT: 1, CONFIRM: 2 },
        POPUP_RESULT: { CANCELLED: 0, AFFIRMATIVE: 1 },
    };
});

jest.unstable_mockModule('../../public/scripts/templates.js', () => ({
    renderTemplateAsync: async () => '<div></div>',
    renderTemplate: () => '<div></div>',
}));

jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
    RA_CountCharTokens: async () => {},
    favsToHotswap: async () => {},
    initMovingUI: async () => {},
    initRossMods: async () => {},
    autoFitSendTextAreaDebounced: () => {},
    dragElement: () => {},
    getMessageTimeStamp: () => '',
    getParsedUA: () => ({}),
    humanizeGenTime: () => '',
    humanizedDateTime: () => '2026-01-01 00:00',
    initNavPanelPins: () => {},
    initSendTextareaState: () => {},
    isMobile: () => false,
    shouldSendOnEnter: () => false,
}));

jest.unstable_mockModule('../../public/scripts/macros.js', () => ({
    getLastMessageId: () => 0,
}));

jest.unstable_mockModule('../../public/scripts/action-loader.js', () => ({
    loader: {},
}));

jest.unstable_mockModule('../../public/scripts/request-compression.js', () => ({
    compressRequest: async (body) => body,
}));

jest.unstable_mockModule('../../public/scripts/tags.js', () => ({
    createTagMapFromList: (_selector, _list) => ({}),
    getTagsList: () => [],
    searchCharByName: () => undefined,
    tags: [],
    tag_map: {},
}));

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (s) => String(s ?? ''),
    translate: (s) => String(s ?? ''),
    getCurrentLocale: () => 'en',
    addLocaleData: () => {},
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    getContext: () => ({}),
    extension_settings: {},
}));

jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
    power_user: {},
    collapseNewlines: (s) => s,
    registerDebugFunction: () => {},
}));

jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_names: [],
    importWorldInfo: () => {},
}));

// The slash-command namespace is only touched when initBookmarks() registers
// its commands; stub the four classes bookmarks.js links against.
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
    SlashCommand: class { static fromProps(props) { return { ...props }; } },
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
    ARGUMENT_TYPE: { STRING: 0, NUMBER: 1, BOOLEAN: 2, LIST: 3, FILE: 4, IMAGE: 5, ENUM: 6, ICON: 7, CHOICE: 8, EXTERNAL: 9 },
    SlashCommandArgument: class {},
    SlashCommandNamedArgument: class {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
    commonEnumProviders: { char: () => async () => [], group: () => async () => [], chat: () => async () => [] },
    enumIcons: {},
    enumTypes: {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: class { static addCommandObject() {} },
}));

// Runtime globals reached by createNewBookmark (bookmarks.js does not use $
// at module load time, so plain assignment is enough).
function jqStub() {
    const node = {
        attrs: [],
        attr(name, value) {
            if (value === undefined) return undefined;
            node.attrs.push([name, value]);
            return node;
        },
        find() { return node; },
        data() { return undefined; },
    };
    return node;
}
globalThis.$ = () => jqStub();
globalThis.toastr = { warning: () => {}, info: () => {}, success: () => {}, error: () => {} };
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

/**
 * Applies the scenario state, then imports bookmarks.js for the first time
 * so the snapshot the module captures matches the scenario.
 */
export async function loadBookmarks(overrides) {
    Object.assign(state, overrides);
    return import('../../../public/scripts/bookmarks.js');
}
