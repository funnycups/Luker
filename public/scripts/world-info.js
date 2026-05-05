import { Fuse } from '../lib.js';

import { saveSettings, substituteParams, getRequestHeaders, chat_metadata, this_chid, characters, saveCharacterDebounced, menu_type, eventSource, event_types, getExtensionPromptByName, saveMetadata, getCurrentChatId, extension_prompt_roles, create_save, createOrEditCharacter, name1, buildObjectPatchOperations, buildObjectPatchOperationsAsync, requestAsyncDiffForNextSettingsSave, getOneCharacter, select_selected_character } from '../script.js';
import { areLookupNamesEqual, download, debounce, findCanonicalIndexInList, findCanonicalNameInList, initScrollHeight, resetScrollHeight, parseJsonFile, extractDataFromPng, getFileBuffer, getCharaFilename, getSortableDelay, escapeRegex, PAGINATION_TEMPLATE, navigation_option, waitUntilCondition, isTrueBoolean, setValueByPath, flashHighlight, select2ModifyOptions, getSelect2OptionId, dynamicSelect2DataViaAjax, highlightRegex, select2ChoiceClickSubscribe, isFalseBoolean, getSanitizedFilename, checkOverwriteExistingData, getStringHash, parseStringArray, cancelDebounce, findChar, onlyUnique, equalsIgnoreCaseAndAccents, uuidv4, normalizeArray, getUniqueName, logSlashCommandWarn, addLongPressEvent, escapeHtml } from './utils.js';
import { extension_settings, getContext } from './extensions.js';
import { NOTE_MODULE_NAME, metadata_keys, shouldWIAddPrompt } from './authors-note.js';
import { isMobile } from './RossAscends-mods.js';
import { FILTER_TYPES, FilterHelper, WORLD_INFO_SEARCH_MODES, keywordSearchWorldInfo } from './filters.js';
import { getTokenCountAsync } from './tokenizers.js';
import { power_user } from './power-user.js';
import { getTagKeyForEntity } from './tags.js';
import { debounce_timeout, GENERATION_TYPE_TRIGGERS } from './constants.js';
import { getRegexedString, regex_placement } from './extensions/regex/engine.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from './slash-commands/SlashCommandEnumValue.js';
import { commonEnumProviders, enumIcons } from './slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandClosure } from './slash-commands/SlashCommandClosure.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { StructuredCloneMap } from './util/StructuredCloneMap.js';
import { renderTemplateAsync } from './templates.js';
import { t, translate } from './i18n.js';
import {
    BULK_PATCH_KEEP_SENTINEL,
    inferCommonValue,
    buildBulkFieldPatchSnapshot,
    applyPatchToEntries,
    restoreEntriesFromSnapshot,
} from './world-info-bulk-edit.js';
import { accountStorage } from './util/AccountStorage.js';
import { getOrCreatePersonaDescriptor, setPersonaDescription, user_avatar } from './personas.js';
import { initActionableSingleSelect } from './select2-actionable-single.js';
import { showUndoToast } from './undo-toast.js';

function buildWorldInfoDragHelper(item) {
    const itemEl = item?.get?.(0) || item?.[0] || item;
    const commentField = itemEl instanceof HTMLElement
        ? itemEl.querySelector('textarea[name="comment"]')
        : null;
    const fallbackKey = itemEl instanceof HTMLElement
        ? itemEl.querySelector('.key_info')
        : null;
    const title = String(
        commentField?.value
        || fallbackKey?.textContent
        || itemEl?.getAttribute?.('uid')
        || itemEl?.getAttribute?.('data-uid')
        || 'World Info',
    ).trim();
    const width = Math.round(item?.outerWidth?.() || itemEl?.getBoundingClientRect?.().width || 0);
    const helper = document.createElement('div');
    helper.className = 'world-info-drag-helper';
    helper.textContent = title;
    helper.style.width = width > 0 ? `${width}px` : '';
    helper.style.padding = '8px 12px';
    helper.style.border = '1px solid var(--SmartThemeBorderColor)';
    helper.style.borderRadius = '10px';
    helper.style.background = 'var(--SmartThemeBlurTintColor)';
    helper.style.color = 'var(--SmartThemeBodyColor)';
    helper.style.boxShadow = '0 12px 28px rgba(0, 0, 0, 0.18)';
    helper.style.pointerEvents = 'none';
    return $(helper);
}

function styleWorldInfoDragPlaceholder(ui) {
    const placeholder = ui?.placeholder;
    const item = ui?.item;
    if (!placeholder?.length || !item?.length) {
        return;
    }

    placeholder.css({
        height: `${Math.round(item.outerHeight() || 0)}px`,
        visibility: 'visible',
        border: '1px dashed var(--SmartThemeBorderColor)',
        'border-radius': '10px',
        background: 'color-mix(in srgb, var(--SmartThemeQuoteColor) 10%, transparent)',
        opacity: '0.8',
    });
}

const WORLD_INFO_INDICATOR_DRAG_Z_INDEX = 2147483647;
const WORLD_INFO_INDICATOR_SCROLL_EDGE_PX = 72;
const WORLD_INFO_INDICATOR_SCROLL_MIN_SPEED_PX = 4;
const WORLD_INFO_INDICATOR_SCROLL_MAX_SPEED_PX = 22;
const WORLD_INFO_DRAWER_FALLBACK_RESERVE_HEIGHT_PX = 620;

const worldInfoIndicatorDragHandlers = new WeakMap();
const worldInfoDrawerReserveHeightByWidth = new Map();
let activeWorldInfoIndicatorDrag = null;
const selectedWorldInfoEntryUids = new Set();
let selectedWorldInfoEntryBook = '';
const WORLD_INFO_MANAGER_PAGE_SIZE_KEY = 'world_info_manager_page_size';
const WORLD_INFO_MANAGER_PAGE_SIZE_OPTIONS = [6, 12, 24, 48];
const selectedWorldInfoManagerNames = new Set();
const worldInfoManagerMetadata = new Map();
const worldInfoManagerState = {
    page: 1,
    pageSize: 12,
    search: '',
    tag: '',
    searchEntries: false,
};
const worldInfoManagerEntrySearchState = {
    key: '',
    pendingKey: '',
    matches: new Map(),
    requestId: 0,
};
let worldInfoManagerSearchRevision = 0;

const WORLD_INFO_EDITOR_DISPLAY_GROUPS = Object.freeze([
    { key: 'matching', labelKey: 'Matching & Filters' },
    { key: 'overrides', labelKey: 'Overrides & Routing' },
    { key: 'activation', labelKey: 'Activation & Recursion' },
]);

const WORLD_INFO_EDITOR_DISPLAY_OPTIONS = Object.freeze([
    { key: 'hideAdditionalMatchingSources', group: 'matching', labelKey: 'Hide Additional Matching Sources' },
    { key: 'hidePrimaryKeywords', group: 'matching', labelKey: 'Hide Primary Keywords' },
    { key: 'hideEntryLogic', group: 'matching', labelKey: 'Hide Logic' },
    { key: 'hideOptionalFilter', group: 'matching', labelKey: 'Hide Optional Filter' },
    { key: 'hideCharacterOrTagFilter', group: 'matching', labelKey: 'Hide Character or Tag Filter' },
    { key: 'hideGenerationTriggers', group: 'matching', labelKey: 'Hide Generation Triggers' },
    { key: 'hideScanDepth', group: 'overrides', labelKey: 'Hide Scan Depth' },
    { key: 'hideCaseSensitive', group: 'overrides', labelKey: 'Hide Case-Sensitive' },
    { key: 'hideWholeWords', group: 'overrides', labelKey: 'Hide Whole Words' },
    { key: 'hideGroupScoring', group: 'overrides', labelKey: 'Hide Group Scoring' },
    { key: 'hideAutomationId', group: 'overrides', labelKey: 'Hide Automation ID' },
    { key: 'hideRecursionLevel', group: 'overrides', labelKey: 'Hide Recursion Level' },
    { key: 'hideInclusionGroup', group: 'overrides', labelKey: 'Hide Inclusion Group' },
    { key: 'hideGroupWeight', group: 'overrides', labelKey: 'Hide Group Weight' },
    { key: 'hideSticky', group: 'activation', labelKey: 'Hide Sticky' },
    { key: 'hideCooldown', group: 'activation', labelKey: 'Hide Cooldown' },
    { key: 'hideDelay', group: 'activation', labelKey: 'Hide Delay' },
    { key: 'hideExcludeRecursion', group: 'activation', labelKey: 'Hide Non-recursable' },
    { key: 'hidePreventFurtherRecursion', group: 'activation', labelKey: 'Hide Prevent Further Recursion' },
    { key: 'hideDelayUntilRecursion', group: 'activation', labelKey: 'Hide Delay Until Recursion' },
    { key: 'hideIgnoreBudget', group: 'activation', labelKey: 'Hide Ignore Budget' },
    { key: 'hideBottomLegacyControls', group: 'activation', labelKey: 'Hide Legacy Bottom Controls' },
]);

const DEFAULT_WORLD_INFO_EDITOR_DISPLAY_SETTINGS = Object.freeze(
    Object.fromEntries(WORLD_INFO_EDITOR_DISPLAY_OPTIONS.map((option) => [option.key, false])),
);

function normalizeWorldInfoEditorDisplaySettings(settings = null) {
    const source = settings && typeof settings === 'object' && !Array.isArray(settings)
        ? settings
        : {};
    return Object.fromEntries(
        WORLD_INFO_EDITOR_DISPLAY_OPTIONS.map((option) => [option.key, Boolean(source[option.key])]),
    );
}

function getWorldInfoEditorDisplaySettings() {
    const normalized = normalizeWorldInfoEditorDisplaySettings(power_user.world_info_editor_display);
    if (JSON.stringify(power_user.world_info_editor_display ?? null) !== JSON.stringify(normalized)) {
        power_user.world_info_editor_display = normalized;
    }
    return power_user.world_info_editor_display;
}

function getWorldInfoEditorDisplaySettingsSignature() {
    return JSON.stringify(getWorldInfoEditorDisplaySettings());
}

export const world_info_insertion_strategy = {
    evenly: 0,
    character_first: 1,
    global_first: 2,
};

export const world_info_logic = {
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
};

/**
 * @enum {number} Possible states of the WI evaluation
 */
export const scan_state = {
    /**
     * The scan will be stopped.
     */
    NONE: 0,
    /**
     * Initial state.
     */
    INITIAL: 1,
    /**
     * The scan is triggered by a recursion step.
     */
    RECURSION: 2,
    /**
     * The scan is triggered by a min activations depth skew.
     */
    MIN_ACTIVATIONS: 3,
};

const WI_ENTRY_HEADER_TEMPLATE = $('#entry_edit_template .world_entry');
const WI_ENTRY_EDIT_TEMPLATE = $('#entry_edit_template .world_entry_edit');

export let world_info = {};
export let selected_world_info = [];

/**
 * Flag to suppress the legacy select MutationObserver sync.
 * Set to true before internal DOM updates to #world_info, reset after.
 */
let _suppressLegacySelectSync = false;
/** @type {string[]} */
export let world_names;
export let world_info_depth = 2;
export let world_info_min_activations = 0; // if > 0, will continue seeking chat until minimum world infos are activated
export let world_info_min_activations_depth_max = 0; // used when (world_info_min_activations > 0)

export let world_info_budget = 25;
export let world_info_include_names = true;
export let world_info_recursive = false;
export let world_info_overflow_alert = false;
export let world_info_case_sensitive = false;
export let world_info_match_whole_words = false;
export let world_info_use_group_scoring = false;
export let world_info_character_strategy = world_info_insertion_strategy.character_first;
export let world_info_budget_cap = 0;
export let world_info_max_recursion_steps = 0;
function normalizeWorldInfoSaveOptions(options = null) {
    return {
        asyncDiff: options?.asyncDiff !== false,
    };
}

function mergeWorldInfoSaveOptions(baseOptions = null, overrideOptions = null) {
    return {
        asyncDiff: overrideOptions?.asyncDiff ?? baseOptions?.asyncDiff ?? true,
    };
}

const saveWorldDebounced = debounce(async (name, data, options = null) => await _save(name, data, options), debounce_timeout.relaxed);
const saveSettingsDebounced = debounce(() => {
    Object.assign(world_info, { globalSelect: selected_world_info });
    saveSettings();
}, debounce_timeout.relaxed);
const sortFn = (a, b) => b.order - a.order;
let updateEditor = (navigation, flashOnNav = true) => { console.debug('Triggered WI navigation', navigation, flashOnNav); };
let worldInfoSaveInFlight = null;
let worldInfoSaveQueuedRequest = null;

// Do not optimize. updateEditor is a function that is updated by the displayWorldEntries with new data.
export const worldInfoFilter = new FilterHelper(() => updateEditor());
export const SORT_ORDER_KEY = 'world_info_sort_order';
export const SEARCH_MODE_KEY = 'world_info_search_mode';
export const SEARCH_ADVANCED_KEY = 'world_info_search_advanced';
export const METADATA_KEY = 'world_info';
export const PRESET_LINKED_LOREBOOK_KEY = 'preset_lorebook';

const presetLinkedLorebookPromptedKeys = new Set();

export const DEFAULT_DEPTH = 4;
export const DEFAULT_WEIGHT = 100;
export const MAX_SCAN_DEPTH = 1000;
const MAX_COMMENT_LENGTH = 100;
const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'];
const WI_ACTIVATION_TRACE_SCAN_LIMIT = 12;
const wiActivationTraceByScope = new Map();

function resolveWorldInfoName(name) {
    return findCanonicalNameInList(Array.isArray(world_names) ? world_names : [], name) || String(name || '').trim();
}

function resolveWorldInfoIndex(name) {
    return findCanonicalIndexInList(Array.isArray(world_names) ? world_names : [], name);
}

function hasWorldInfoName(name) {
    return Boolean(findCanonicalNameInList(Array.isArray(world_names) ? world_names : [], name));
}

function hasSelectedWorldInfo(name) {
    return selected_world_info.some(entry => areLookupNamesEqual(entry, name));
}

function getChatWorldInfoNames(metadata = chat_metadata, { resolveNames = true, onlyExisting = true } = {}) {
    const rawValue = metadata?.[METADATA_KEY];
    const names = normalizeArray(Array.isArray(rawValue) ? rawValue : [rawValue])
        .map((name) => resolveNames ? resolveWorldInfoName(name) : String(name || '').trim())
        .filter(Boolean)
        .filter(onlyUnique);

    return onlyExisting ? names.filter(hasWorldInfoName) : names;
}

function getPrimaryChatWorldInfoName(metadata = chat_metadata, options = undefined) {
    return getChatWorldInfoNames(metadata, options)[0] ?? '';
}

function hasChatWorldInfoSelection(metadata = chat_metadata) {
    return getChatWorldInfoNames(metadata).length > 0;
}

function setChatWorldInfoSelection(names, metadata = chat_metadata) {
    const normalizedNames = normalizeArray(Array.isArray(names) ? names : [names])
        .map((name) => resolveWorldInfoName(name))
        .filter(Boolean)
        .filter(onlyUnique)
        .filter(hasWorldInfoName);

    if (!normalizedNames.length) {
        delete metadata[METADATA_KEY];
        return [];
    }

    metadata[METADATA_KEY] = normalizedNames.length === 1 ? normalizedNames[0] : normalizedNames;
    return normalizedNames;
}

function getStoredWorldInfoSearchMode() {
    return accountStorage.getItem(SEARCH_MODE_KEY) === WORLD_INFO_SEARCH_MODES.FUZZY
        ? WORLD_INFO_SEARCH_MODES.FUZZY
        : WORLD_INFO_SEARCH_MODES.KEYWORD;
}

function getStoredWorldInfoSearchAdvancedSyntaxEnabled() {
    return accountStorage.getItem(SEARCH_ADVANCED_KEY) === 'true';
}

function isWorldInfoSearchAdvancedSyntaxEnabled() {
    const input = $('#world_info_search_advanced');
    return input.length
        ? Boolean(input.prop('checked'))
        : getStoredWorldInfoSearchAdvancedSyntaxEnabled();
}

function getWorldInfoSearchMode() {
    return $('#world_info_search_mode').val() === WORLD_INFO_SEARCH_MODES.FUZZY
        ? WORLD_INFO_SEARCH_MODES.FUZZY
        : WORLD_INFO_SEARCH_MODES.KEYWORD;
}

function setWorldInfoSearchAdvancedSyntaxEnabled(enabled) {
    const normalized = Boolean(enabled);
    accountStorage.setItem(SEARCH_ADVANCED_KEY, String(normalized));
    $('#world_info_search_advanced').prop('checked', normalized);
    $('#world_info_manager_search_advanced').prop('checked', normalized);
    updateWorldInfoSearchInputState();
    updateWorldInfoManagerSearchInputState();
}

function updateWorldInfoSearchInputState() {
    const searchInput = $('#world_info_search');
    const isKeywordMode = getWorldInfoSearchMode() === WORLD_INFO_SEARCH_MODES.KEYWORD;
    const advancedSyntax = isWorldInfoSearchAdvancedSyntaxEnabled();
    const advancedInput = $('#world_info_search_advanced');

    searchInput
        .attr('placeholder', isKeywordMode ? (advancedSyntax ? t`Advanced keyword search...` : t`Keyword search...`) : t`Search...`)
        .attr(
            'title',
            isKeywordMode
                ? (
                    advancedSyntax
                        ? t`Advanced keyword search over entry titles, groups, keys, content, UID, and automation ID. Supports title:, group:, uid:, automationId:, content:, quotes, -, and OR.`
                        : t`Direct keyword match over entry titles, groups, keys, content, UID, and automation ID. Enable Advanced syntax for operators like title:, OR, -, and quotes.`
                )
                : t`Fuzzy search across entry titles, keys, content, UID, and automation ID.`,
        );
    advancedInput.prop('disabled', !isKeywordMode);
}

function setWorldInfoSearchFilter(searchQuery, { suppressDataChanged = false } = {}) {
    const nextQuery = String(searchQuery || '').trim();
    const nextMode = nextQuery ? getWorldInfoSearchMode() : '';
    const nextAdvanced = nextQuery && nextMode === WORLD_INFO_SEARCH_MODES.KEYWORD
        ? isWorldInfoSearchAdvancedSyntaxEnabled()
        : false;
    const previousQuery = worldInfoFilter.getFilterData(FILTER_TYPES.WORLD_INFO_SEARCH);
    const previousMode = worldInfoFilter.getFilterData(FILTER_TYPES.WORLD_INFO_SEARCH_MODE);
    const previousAdvanced = worldInfoFilter.getFilterData(FILTER_TYPES.WORLD_INFO_SEARCH_ADVANCED);

    worldInfoFilter.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH, nextQuery, true);
    worldInfoFilter.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH_MODE, nextMode, true);
    worldInfoFilter.setFilterData(FILTER_TYPES.WORLD_INFO_SEARCH_ADVANCED, nextAdvanced, true);

    if (!suppressDataChanged && (previousQuery !== nextQuery || previousMode !== nextMode || previousAdvanced !== nextAdvanced)) {
        updateEditor();
    }
}

function invalidateWorldInfoManagerEntrySearch() {
    worldInfoManagerSearchRevision += 1;
    worldInfoManagerEntrySearchState.key = '';
    worldInfoManagerEntrySearchState.pendingKey = '';
    worldInfoManagerEntrySearchState.matches = new Map();
}

function getWorldInfoManagerEntrySearchKey() {
    return JSON.stringify({
        search: String(worldInfoManagerState.search || '').trim(),
        searchEntries: Boolean(worldInfoManagerState.searchEntries),
        advancedSyntax: Boolean(isWorldInfoSearchAdvancedSyntaxEnabled()),
        revision: worldInfoManagerSearchRevision,
    });
}

function updateWorldInfoManagerSearchInputState() {
    const searchInput = $('#world_info_manager_search');
    const isEntrySearch = Boolean(worldInfoManagerState.searchEntries);
    const advancedSyntax = isWorldInfoSearchAdvancedSyntaxEnabled();
    const advancedInput = $('#world_info_manager_search_advanced');

    searchInput
        .attr('placeholder', isEntrySearch ? (advancedSyntax ? t`Advanced entry/content search across lorebooks...` : t`Search entries or content across lorebooks...`) : t`Search lorebooks or tags...`)
        .attr(
            'title',
            isEntrySearch
                ? (
                    advancedSyntax
                        ? t`Advanced keyword search across all lorebooks. Supports title:, group:, uid:, automationId:, content:, quotes, -, and OR.`
                        : t`Direct keyword match across entry titles, groups, keys, content, UID, and automation ID in all lorebooks.`
                )
                : '',
        );
    advancedInput.prop('disabled', !isEntrySearch);
}

function buildWorldInfoSearchSyntaxHelpHtml() {
    const basicRows = [
        {
            query: 'dragon queen',
            description: t`Default Keyword Search looks for the exact text dragon queen.`,
        },
        {
            query: 'uid:42',
            description: t`With Advanced syntax off, this searches the literal text uid:42.`,
        },
    ];
    const advancedRows = [
        {
            query: 'dragon queen',
            description: t`With Advanced syntax enabled, space-separated terms use AND. Both terms must match.`,
        },
        {
            query: '"dragon queen"',
            description: t`Quoted text matches an exact phrase.`,
        },
        {
            query: '-goblin',
            description: t`Prefix a term with - to exclude matches.`,
        },
        {
            query: 'dragon | phoenix',
            description: t`Use | or OR between alternatives.`,
        },
        {
            query: 'title:queen content:"silver city"',
            description: t`Scope a term to title/keywords or content.`,
        },
        {
            query: 'group:lore uid:42 automationId:hero_1',
            description: t`Scope a term to group, UID, or automation ID.`,
        },
    ];

    const syntaxHeader = escapeHtmlText(t`Syntax`);
    const effectHeader = escapeHtmlText(t`Effect`);
    const buildTableRows = (rows) => rows.map((row) => `
        <tr>
            <td data-label="${syntaxHeader}"><code>${escapeHtmlText(row.query)}</code></td>
            <td data-label="${effectHeader}">${escapeHtmlText(row.description)}</td>
        </tr>
    `).join('');

    return `
        <div class="world_info_search_syntax_help">
            <p>${escapeHtmlText(t`Keyword Search defaults to direct whole-query matching across entry titles, groups, keywords, content, UID, and automation ID.`)}</p>
            <section class="world_info_search_syntax_section">
                <h4>${escapeHtmlText(t`Default behavior`)}</h4>
                <div class="world_info_search_syntax_table_wrap">
                    <table class="world_info_search_syntax_table">
                        <thead>
                            <tr>
                                <th>${syntaxHeader}</th>
                                <th>${effectHeader}</th>
                            </tr>
                        </thead>
                        <tbody>${buildTableRows(basicRows)}</tbody>
                    </table>
                </div>
            </section>
            <p>${escapeHtmlText(t`Enable Advanced syntax to use operators and field prefixes.`)}</p>
            <p>${escapeHtmlText(t`title: searches entry titles, memo/comment, and primary/secondary keywords. group:, uid:, and automationId: search only those fields. content: searches entry content only.`)}</p>
            <section class="world_info_search_syntax_section">
                <h4>${escapeHtmlText(t`Advanced behavior`)}</h4>
                <div class="world_info_search_syntax_table_wrap">
                    <table class="world_info_search_syntax_table">
                        <thead>
                            <tr>
                                <th>${syntaxHeader}</th>
                                <th>${effectHeader}</th>
                            </tr>
                        </thead>
                        <tbody>${buildTableRows(advancedRows)}</tbody>
                    </table>
                </div>
            </section>
            <p>${escapeHtmlText(t`Aliases: name:, comment:, key:, and keywords: map to title:. text: and body: map to content:. id: maps to uid:, while automation_id: and autoid: map to automationId:.`)}</p>
        </div>
    `;
}

async function showWorldInfoSearchSyntaxHelp() {
    await Popup.show.text(
        t`Lorebook Search Syntax`,
        buildWorldInfoSearchSyntaxHelpHtml(),
        {
            okButton: t`Close`,
            wide: true,
            allowVerticalScrolling: true,
        },
    );
}

async function refreshWorldInfoManagerSearchResults() {
    const searchValue = String(worldInfoManagerState.search || '').trim();
    const searchKey = getWorldInfoManagerEntrySearchKey();
    const advancedSyntax = isWorldInfoSearchAdvancedSyntaxEnabled();

    if (!searchValue || !worldInfoManagerState.searchEntries) {
        worldInfoManagerEntrySearchState.key = searchKey;
        worldInfoManagerEntrySearchState.pendingKey = '';
        worldInfoManagerEntrySearchState.matches = new Map();
        renderWorldInfoManager();
        return;
    }

    if (worldInfoManagerEntrySearchState.key === searchKey || worldInfoManagerEntrySearchState.pendingKey === searchKey) {
        return;
    }

    const requestId = ++worldInfoManagerEntrySearchState.requestId;
    worldInfoManagerEntrySearchState.pendingKey = searchKey;
    renderWorldInfoManager();

    const names = Array.isArray(world_names) ? [...world_names] : [];
    const worldData = await loadWorldInfoBatch(names);

    if (worldInfoManagerEntrySearchState.requestId !== requestId) {
        return;
    }

    const matches = new Map();
    for (const [name, data] of worldData.entries()) {
        const entries = Object.values(data?.entries ?? {})
            .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
        const results = keywordSearchWorldInfo(entries, searchValue, { advancedSyntax });
        if (results.length === 0) {
            continue;
        }
        const bestScore = Math.min(...results.map((result) => Number(result.score ?? 0)));
        matches.set(name, {
            score: bestScore,
            count: results.length,
        });
    }

    if (worldInfoManagerEntrySearchState.requestId !== requestId) {
        return;
    }

    worldInfoManagerEntrySearchState.key = searchKey;
    worldInfoManagerEntrySearchState.pendingKey = '';
    worldInfoManagerEntrySearchState.matches = matches;
    renderWorldInfoManager();
}

function escapeHtmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getWorldEditorSelectedIndex() {
    const selectedValue = String($('#world_editor_select').val() ?? '');
    if (selectedValue === '') {
        return -1;
    }

    const selectedIndex = Number.parseInt(selectedValue, 10);
    return Number.isInteger(selectedIndex) && selectedIndex >= 0 ? selectedIndex : -1;
}

function getSelectedWorldEditorName() {
    const selectedIndex = getWorldEditorSelectedIndex();
    return selectedIndex === -1 ? '' : String(world_names[selectedIndex] || '');
}

function getActivationTraceScopeKey() {
    const chatId = String(getCurrentChatId() || '').trim();
    return chatId ? `chat:${chatId}` : 'chat:none';
}

function getOrCreateActivationTraceBucket(scopeKey) {
    const key = String(scopeKey || 'chat:none');
    if (!wiActivationTraceByScope.has(key)) {
        wiActivationTraceByScope.set(key, new Map());
    }
    return wiActivationTraceByScope.get(key);
}

function getEntryActivationTrace(scopeKey, worldName, uid) {
    const bucket = wiActivationTraceByScope.get(String(scopeKey || 'chat:none'));
    if (!bucket) {
        return null;
    }
    return bucket.get(`${String(worldName || '')}.${String(uid || '')}`) || null;
}

function getScanStateName(stateValue) {
    return Object.entries(scan_state).find(([_, value]) => value === stateValue)?.[0] || String(stateValue);
}

function formatTraceTime(value) {
    if (!value) {
        return 'N/A';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }
    return date.toLocaleString();
}

function explainTraceSourceHint(hint) {
    if (!hint || typeof hint !== 'object') {
        return '';
    }
    const source = String(hint.source || '');
    switch (source) {
        case 'chat_depth':
            return `${t`Chat depth`} #${Number(hint.depth || 0)}`;
        case 'personaDescription':
            return t`Persona Description`;
        case 'characterDescription':
            return t`Character Description`;
        case 'characterPersonality':
            return t`Character Personality`;
        case 'characterDepthPrompt':
            return t`Character Depth Prompt`;
        case 'scenario':
            return t`Scenario`;
        case 'creatorNotes':
            return t`Creator Notes`;
        case 'extension_inject':
            return `${t`Extension Inject`} #${Number(hint.index || 0)}`;
        case 'wi_recursion':
            return `${t`WI Recursion Buffer`} #${Number(hint.index || 0)} (${t`indirect recursion source`})`;
        case 'scan_buffer':
            return t`Scan Buffer`;
        default:
            return source || t`Unknown`;
    }
}

function explainTraceScanState(stateName) {
    const key = String(stateName || '').trim();
    switch (key) {
        case 'INITIAL':
            return t`Initial scan`;
        case 'RECURSION':
            return t`Recursion scan`;
        case 'MIN_ACTIVATIONS':
            return t`Minimum activation backfill scan`;
        default:
            return key || t`Unknown`;
    }
}

function normalizeTraceSignatureValue(value) {
    if (Array.isArray(value)) {
        return value.map(normalizeTraceSignatureValue);
    }
    if (value && typeof value === 'object') {
        const out = {};
        const keys = Object.keys(value).sort();
        for (const key of keys) {
            out[key] = normalizeTraceSignatureValue(value[key]);
        }
        return out;
    }
    return value;
}

function buildTraceScanSignature(scan) {
    const payload = {
        trigger: String(scan?.trigger || ''),
        dryRun: Boolean(scan?.dryRun),
        activated: Boolean(scan?.activated),
        attempts: Array.isArray(scan?.attempts) ? scan.attempts : [],
        lastActivation: scan?.lastActivation || null,
    };
    return JSON.stringify(normalizeTraceSignatureValue(payload));
}

function collapseConsecutiveDuplicateScans(scans = []) {
    const merged = [];
    for (const scan of scans) {
        const signature = buildTraceScanSignature(scan);
        const finishedAt = scan?.finishedAt || scan?.startedAt || null;
        const prev = merged.length > 0 ? merged[merged.length - 1] : null;
        if (prev && prev.signature === signature) {
            prev.repeatCount += 1;
            prev.oldestAt = finishedAt || prev.oldestAt;
            continue;
        }
        merged.push({
            scan,
            signature,
            repeatCount: 1,
            newestAt: finishedAt,
            oldestAt: finishedAt,
        });
    }
    return merged;
}

function explainTraceReason(reason, details = {}) {
    const reasonKey = String(reason || '');
    switch (reasonKey) {
        case 'decorator_activate':
            return t`Activated by @@activate decorator`;
        case 'external_activation':
            return t`Activated externally by another entry/system`;
        case 'constant':
            return t`Activated because this entry is constant`;
        case 'sticky':
            return t`Activated because sticky effect is active`;
        case 'key_match': {
            const key = String(details.primaryKey || '').trim();
            return key
                ? `${t`Activated by keyword match`}: "${key}"`
                : t`Activated by keyword match`;
        }
        case 'secondary_key_miss':
            return t`Primary key matched but secondary keyword logic failed`;
        case 'inclusion_group_filtered':
            return t`Filtered out by inclusion-group conflict`;
        case 'probability_failed':
            return t`Failed probability roll`;
        case 'budget_overflow':
            return t`Skipped due to world info budget limit`;
        case 'added_to_prompt':
            return t`Activated and injected into prompt`;
        default:
            return reasonKey || t`Unknown reason`;
    }
}

function renderTraceDetailLines(details = {}) {
    if (!details || typeof details !== 'object') {
        return '';
    }

    const lines = [];
    const sourceHints = Array.isArray(details.sourceHints) ? details.sourceHints : [];
    if (sourceHints.length > 0) {
        const labels = sourceHints
            .map(explainTraceSourceHint)
            .filter(Boolean);
        if (labels.length > 0) {
            const labelCounts = new Map();
            for (const label of labels) {
                labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
            }
            const compact = Array.from(labelCounts.entries())
                .map(([label, count]) => count > 1 ? `${label} (${count} ${t`hits`})` : label);
            const previewLimit = 6;
            const head = compact.slice(0, previewLimit).join(', ');
            const tail = compact.length > previewLimit
                ? ` (+${compact.length - previewLimit} ${t`more`})`
                : '';
            lines.push(`${t`Matched in`}: ${head}${tail}`);
        }
    }

    if (Array.isArray(details.secondaryKeys) && details.secondaryKeys.length > 0) {
        lines.push(`${t`Secondary keys checked`}: ${details.secondaryKeys.join(', ')}`);
    }

    if (Array.isArray(details.matchedSecondaryKeys) && details.matchedSecondaryKeys.length > 0) {
        lines.push(`${t`Secondary keys matched`}: ${details.matchedSecondaryKeys.join(', ')}`);
    }

    if (details.selectiveLogic) {
        lines.push(`${t`Secondary logic`}: ${String(details.selectiveLogic)}`);
    }

    if (details.group) {
        lines.push(`${t`Inclusion group`}: ${String(details.group)}`);
    }

    if (Number.isFinite(details.probability)) {
        lines.push(`${t`Probability`}: ${Number(details.probability)}%`);
    }

    if (Number.isFinite(details.budget)) {
        lines.push(`${t`Budget`}: ${Number(details.budget)}`);
    }

    if (Array.isArray(details.recursionSourceEntries) && details.recursionSourceEntries.length > 0) {
        const recursionEntries = details.recursionSourceEntries
            .map(x => String(x || '').trim())
            .filter(Boolean);
        if (recursionEntries.length > 0) {
            const groupCounts = new Map();
            for (const entry of recursionEntries) {
                const dotIndex = entry.lastIndexOf('.');
                const hasNumericSuffix = dotIndex > 0 && /^\d+$/.test(entry.slice(dotIndex + 1));
                const group = hasNumericSuffix ? entry.slice(0, dotIndex) : entry;
                groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
            }
            const grouped = Array.from(groupCounts.entries())
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            const groupedSummary = grouped
                .map(([group, count]) => `${group} (${count} ${t`entries`})`)
                .join(', ');
            lines.push(`${t`Recursion source entries`}: ${recursionEntries.length} ${t`entries`} (${groupedSummary})`);
            lines.push(`${t`Recursion source explanation`}: ${t`This entry was activated indirectly by recursive expansion from the source entries below, not by a direct keyword hit in this single worldbook.`}`);

            lines.push(`${t`Recursion source preview`}: ${recursionEntries.join(', ')}`);
        }
    }

    if (details.sourceEntry) {
        lines.push(`${t`Activated by entry`}: ${String(details.sourceEntry)}`);
    }

    return lines
        .map(line => `<div style="opacity:.86;">${escapeHtmlText(line)}</div>`)
        .join('');
}

// Typedef area
/**
 * @typedef {object} WIGlobalScanData The chat-independent data to be scanned. Each of
 *     these fields can be enabled for scanning per entry.
 * @property {string} personaDescription User persona description
 * @property {string} characterDescription Character description
 * @property {string} characterPersonality Character personality
 * @property {string} characterDepthPrompt Character depth prompt (sometimes referred to as character notes)
 * @property {string} scenario Character defined scenario
 * @property {string} creatorNotes Character creator notes
 * @property {string} trigger The type that triggered the scan, e.g. 'normal', 'continue', etc.
 */

/**
 * @typedef {object} WIScanEntry The entry that triggered the scan
 * @property {number} [scanDepth] The depth of the scan
 * @property {boolean} [caseSensitive] If the scan is case sensitive
 * @property {boolean} [matchWholeWords] If the scan should match whole words
 * @property {boolean} [useGroupScoring] If the scan should use group scoring
 * @property {boolean} [matchPersonaDescription] If the scan should match against the persona description
 * @property {boolean} [matchCharacterDescription] If the scan should match against the character description
 * @property {boolean} [matchCharacterPersonality] If the scan should match against the character personality
 * @property {boolean} [matchCharacterDepthPrompt] If the scan should match against the character depth prompt
 * @property {boolean} [matchScenario] If the scan should match against the character scenario
 * @property {boolean} [matchCreatorNotes] If the scan should match against the creator notes
 * @property {number} [uid] The UID of the entry that triggered the scan
 * @property {string} [world] The world info book of origin of the entry
 * @property {string[]} [key] The primary keys to scan for
 * @property {string[]} [keysecondary] The secondary keys to scan for
 * @property {number} [selectiveLogic] The logic to use for selective activation
 * @property {number} [sticky] The sticky value of the entry
 * @property {number} [cooldown] The cooldown of the entry
 * @property {number} [delay] The delay of the entry
 * @property {string[]} [decorators] Array of decorators for the entry
 * @property {number} [hash] The hash of the entry
 */

/**
 * @typedef {object} WITimedEffect Timed effect for world info
 * @property {number} hash Hash of the entry that triggered the effect
 * @property {number} start The chat index where the effect starts
 * @property {number} end The chat index where the effect ends
 * @property {boolean} protected The protected effect can't be removed if the chat does not advance
 */

/**
 * @typedef TimedEffectType Type of timed effect
 * @type {'sticky'|'cooldown'|'delay'}
 */

/**
 * @typedef {object} WIPromptResult
 * @property {string} worldInfoString - Complete world info string
 * @property {string[]} worldInfoBeforeEntries - Raw world info entries that go before the prompt
 * @property {string[]} worldInfoAfterEntries - Raw world info entries that go after the prompt
 * @property {Array} worldInfoExamples - Array of example entries
 * @property {Array} worldInfoDepth - Array of depth entries
 * @property {Array} anBefore - Array of entries before Author's Note
 * @property {Array} anAfter - Array of entries after Author's Note
 * @property {{[key: string]: string[]}} outletEntries - Array of entries to be added to an outlet
 */

/**
 * @typedef {object} WIActivated
 * @property {string[]} worldInfoBeforeEntries The raw world info entries before the chat.
 * @property {string[]} worldInfoAfterEntries The raw world info entries after the chat.
 * @property {any[]} EMEntries The entries for examples.
 * @property {any[]} WIDepthEntries The depth entries.
 * @property {any[]} ANBeforeEntries The entries before Author's Note.
 * @property {any[]} ANAfterEntries The entries after Author's Note.
 * @property {{[key: string]: string[]}} outletEntries - Array of entries to be added to an outlet
 * @property {Set<any>} allActivatedEntries All entries.
 */

/**
 * @typedef {object} WIEntryFieldDefinition
 * @property {any} default - Default value for the field
 * @property {string} type - Type of the field, can be 'string', 'number', 'boolean', 'array', 'enum'
 * @property {boolean} [excludeFromTemplate=false] - Whether to exclude this field from the template
 * @property {(value: any) => boolean} [arrayFilter] - Optional filter function for array fields to filter out unwanted values
 */
// End typedef area

/** @type {Readonly<WIGlobalScanData>} */
const defaultGlobalScanData = Object.freeze({
    trigger: 'normal',
    personaDescription: '',
    characterDescription: '',
    characterPersonality: '',
    characterDepthPrompt: '',
    scenario: '',
    creatorNotes: '',
});

/**
 * Represents a scanning buffer for one evaluation of World Info.
 */
class WorldInfoBuffer {
    /**
     * @type {Map<string, object>} Map of entries that need to be activated no matter what
     */
    static externalActivations = new Map();

    /**
     * @type {WIGlobalScanData} Chat independent data to be scanned, such as persona and character descriptions
     */
    #globalScanData = null;

    /**
     * @type {string[]} Array of messages sorted by ascending depth
     */
    #depthBuffer = [];

    /**
     * @type {string[]} Array of strings added by recursive scanning
     */
    #recurseBuffer = [];

    /**
     * @type {string[]} Array of strings added by prompt injections that are valid for the current scan
     */
    #injectBuffer = [];

    /**
     * @type {number} The skew of the global scan depth. Used in "min activations"
     */
    #skew = 0;

    /**
     * @type {number} The starting depth of the global scan depth.
     */
    #startDepth = 0;

    /**
     * Initialize the buffer with the given messages.
     * @param {string[]} messages Array of messages to add to the buffer
     * @param {WIGlobalScanData} globalScanData Chat independent context to be scanned
     */
    constructor(messages, globalScanData) {
        this.#initDepthBuffer(messages);
        this.#globalScanData = globalScanData;
    }

    /**
     * Populates the buffer with the given messages.
     * @param {string[]} messages Array of messages to add to the buffer
     * @returns {void} Hardly seen nothing down here
     */
    #initDepthBuffer(messages) {
        for (let depth = 0; depth < MAX_SCAN_DEPTH; depth++) {
            if (messages[depth]) {
                this.#depthBuffer[depth] = messages[depth].trim();
            }
            // break if last message is reached
            if (depth === messages.length - 1) {
                break;
            }
        }
    }

    /**
     * Gets a string that respects the case sensitivity setting
     * @param {string} str The string to transform
     * @param {WIScanEntry} entry The entry that triggered the scan
     * @returns {string} The transformed string
    */
    #transformString(str, entry) {
        const caseSensitive = entry.caseSensitive ?? world_info_case_sensitive;
        return caseSensitive ? str : str.toLowerCase();
    }

    /**
     * Gets all messages up to the given depth + recursion buffer.
     * @param {WIScanEntry} entry The entry that triggered the scan
     * @param {number} scanState The state of the scan
     * @returns {string} A slice of buffer until the given depth (inclusive)
     */
    get(entry, scanState) {
        let depth = entry.scanDepth ?? this.getDepth();
        if (depth <= this.#startDepth) {
            return '';
        }

        if (depth < 0) {
            console.error(`[WI] Invalid WI scan depth ${depth}. Must be >= 0`);
            return '';
        }

        if (depth > MAX_SCAN_DEPTH) {
            console.warn(`[WI] Invalid WI scan depth ${depth}. Truncating to ${MAX_SCAN_DEPTH}`);
            depth = MAX_SCAN_DEPTH;
        }

        const MATCHER = '\x01';
        const JOINER = '\n' + MATCHER;
        let result = MATCHER + this.#depthBuffer.slice(this.#startDepth, depth).join(JOINER);

        if (entry.matchPersonaDescription && this.#globalScanData.personaDescription) {
            result += JOINER + this.#globalScanData.personaDescription;
        }
        if (entry.matchCharacterDescription && this.#globalScanData.characterDescription) {
            result += JOINER + this.#globalScanData.characterDescription;
        }
        if (entry.matchCharacterPersonality && this.#globalScanData.characterPersonality) {
            result += JOINER + this.#globalScanData.characterPersonality;
        }
        if (entry.matchCharacterDepthPrompt && this.#globalScanData.characterDepthPrompt) {
            result += JOINER + this.#globalScanData.characterDepthPrompt;
        }
        if (entry.matchScenario && this.#globalScanData.scenario) {
            result += JOINER + this.#globalScanData.scenario;
        }
        if (entry.matchCreatorNotes && this.#globalScanData.creatorNotes) {
            result += JOINER + this.#globalScanData.creatorNotes;
        }

        if (this.#injectBuffer.length > 0) {
            result += JOINER + this.#injectBuffer.join(JOINER);
        }

        // Min activations should not include the recursion buffer
        if (this.#recurseBuffer.length > 0 && scanState !== scan_state.MIN_ACTIVATIONS) {
            result += JOINER + this.#recurseBuffer.join(JOINER);
        }

        return result;
    }

    /**
     * Matches the given string against the buffer.
     * @param {string} haystack The string to search in
     * @param {string} needle The string to search for
     * @param {WIScanEntry} entry The entry that triggered the scan
     * @returns {boolean} True if the string was found in the buffer
     */
    matchKeys(haystack, needle, entry) {
        // If the needle is a regex, we do regex pattern matching and override all the other options
        const keyRegex = parseRegexFromString(needle);
        if (keyRegex) {
            return keyRegex.test(haystack);
        }

        // Otherwise we do normal matching of plaintext with the chosen entry settings
        haystack = this.#transformString(haystack, entry);
        const transformedString = this.#transformString(needle, entry);
        const matchWholeWords = entry.matchWholeWords ?? world_info_match_whole_words;

        if (matchWholeWords) {
            const keyWords = transformedString.split(/\s+/);

            if (keyWords.length > 1) {
                return haystack.includes(transformedString);
            } else {
                // Use custom boundaries to include punctuation and other non-alphanumeric characters
                const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformedString)})(?:$|\\W)`);
                if (regex.test(haystack)) {
                    return true;
                }
            }
        } else {
            return haystack.includes(transformedString);
        }

        return false;
    }

    /**
     * Returns match source hints for a key.
     * @param {WIScanEntry} entry WI entry
     * @param {string} needle Key text/regex to match
     * @param {number} scanState The current scan state
     * @returns {Array<object>} Match source hints
     */
    getMatchSourceHints(entry, needle, scanState) {
        const hints = [];
        const key = String(needle || '').trim();
        if (!key) {
            return hints;
        }

        let depth = entry.scanDepth ?? this.getDepth();
        if (!Number.isFinite(depth)) {
            depth = this.getDepth();
        }
        depth = Math.max(0, Math.min(MAX_SCAN_DEPTH, Math.floor(depth)));

        for (let index = this.#startDepth; index < depth; index++) {
            const message = this.#depthBuffer[index];
            if (!message) {
                continue;
            }
            if (this.matchKeys(message, key, entry)) {
                hints.push({
                    source: 'chat_depth',
                    depth: index + 1,
                });
            }
        }

        const globalMatchers = [
            ['personaDescription', entry.matchPersonaDescription, this.#globalScanData.personaDescription],
            ['characterDescription', entry.matchCharacterDescription, this.#globalScanData.characterDescription],
            ['characterPersonality', entry.matchCharacterPersonality, this.#globalScanData.characterPersonality],
            ['characterDepthPrompt', entry.matchCharacterDepthPrompt, this.#globalScanData.characterDepthPrompt],
            ['scenario', entry.matchScenario, this.#globalScanData.scenario],
            ['creatorNotes', entry.matchCreatorNotes, this.#globalScanData.creatorNotes],
        ];
        for (const [name, enabled, text] of globalMatchers) {
            if (!enabled || !text) {
                continue;
            }
            if (this.matchKeys(text, key, entry)) {
                hints.push({ source: name });
            }
        }

        for (let index = 0; index < this.#injectBuffer.length; index++) {
            const text = this.#injectBuffer[index];
            if (!text) {
                continue;
            }
            if (this.matchKeys(text, key, entry)) {
                hints.push({
                    source: 'extension_inject',
                    index: index + 1,
                });
            }
        }

        if (scanState !== scan_state.MIN_ACTIVATIONS) {
            for (let index = 0; index < this.#recurseBuffer.length; index++) {
                const text = this.#recurseBuffer[index];
                if (!text) {
                    continue;
                }
                if (this.matchKeys(text, key, entry)) {
                    hints.push({
                        source: 'wi_recursion',
                        index: index + 1,
                    });
                }
            }
        }

        if (hints.length === 0) {
            hints.push({ source: 'scan_buffer' });
        }
        return hints;
    }

    /**
     * Adds a message to the recursion buffer.
     * @param {string} message The message to add
     */
    addRecurse(message) {
        this.#recurseBuffer.push(message);
    }

    /**
     * Adds an injection to the buffer.
     * @param {string} message The injection to add
     */
    addInject(message) {
        this.#injectBuffer.push(message);
    }

    /**
     * Checks if the recursion buffer is not empty.
     * @returns {boolean} Returns true if the recursion buffer is not empty, otherwise false
     */
    hasRecurse() {
        return this.#recurseBuffer.length > 0;
    }

    /**
     * Increments skew to advance the scan range.
     */
    advanceScan() {
        this.#skew++;
    }

    /**
     * @returns {number} Settings' depth + current skew.
     */
    getDepth() {
        return world_info_depth + this.#skew;
    }

    /**
     * Get the externally activated version of the entry, if there is one.
     * @param {object} entry WI entry to check
     * @returns {object|undefined} the external version if the entry is forcefully activated, undefined otherwise
     */
    getExternallyActivated(entry) {
        return WorldInfoBuffer.externalActivations.get(`${entry.world}.${entry.uid}`);
    }

    /**
     * Clean-up the external effects for entries.
     */
    resetExternalEffects() {
        WorldInfoBuffer.externalActivations = new Map();
    }

    /**
     * Gets the match score for the given entry.
     * @param {WIScanEntry} entry Entry to check
     * @param {number} scanState The state of the scan
     * @returns {number} The number of key activations for the given entry
     */
    getScore(entry, scanState) {
        const bufferState = this.get(entry, scanState);
        let numberOfPrimaryKeys = 0;
        let numberOfSecondaryKeys = 0;
        let primaryScore = 0;
        let secondaryScore = 0;

        // Increment score for every key found in the buffer
        if (Array.isArray(entry.key)) {
            numberOfPrimaryKeys = entry.key.length;
            for (const key of entry.key) {
                if (this.matchKeys(bufferState, key, entry)) {
                    primaryScore++;
                }
            }
        }

        // Increment score for every secondary key found in the buffer
        if (Array.isArray(entry.keysecondary)) {
            numberOfSecondaryKeys = entry.keysecondary.length;
            for (const key of entry.keysecondary) {
                if (this.matchKeys(bufferState, key, entry)) {
                    secondaryScore++;
                }
            }
        }

        // No keys == no score
        if (!numberOfPrimaryKeys) {
            return 0;
        }

        // Only positive logic influences the score
        if (numberOfSecondaryKeys > 0) {
            switch (entry.selectiveLogic) {
                // AND_ANY: Add both scores
                case world_info_logic.AND_ANY:
                    return primaryScore + secondaryScore;
                // AND_ALL: Add both scores if all secondary keys are found, otherwise only primary score
                case world_info_logic.AND_ALL:
                    return secondaryScore === numberOfSecondaryKeys ? primaryScore + secondaryScore : primaryScore;
            }
        }

        return primaryScore;
    }
}

/**
 * Represents a timed effects manager for World Info.
 */
class WorldInfoTimedEffects {
    /**
     * Array of chat messages.
     * @type {string[]}
     */
    #chat = [];

    /**
     * Array of entries.
     * @type {WIScanEntry[]}
     */
    #entries = [];

    /**
     * Is this a dry run?
     * @type {boolean}
     */
    #isDryRun = false;

    /**
     * Buffer for active timed effects.
     * @type {Record<TimedEffectType, WIScanEntry[]>}
     */
    #buffer = {
        'sticky': [],
        'cooldown': [],
        'delay': [],
    };

    /**
     * Callbacks for effect types ending.
     * @type {Record<TimedEffectType, (entry: WIScanEntry) => void>}
     */
    #onEnded = {
        /**
         * Callback for when a sticky entry ends.
         * Sets an entry on cooldown immediately if it has a cooldown.
         * @param {WIScanEntry} entry Entry that ended sticky
         */
        'sticky': (entry) => {
            if (!entry.cooldown) {
                return;
            }

            const key = this.#getEntryKey(entry);
            const effect = this.#getEntryTimedEffect('cooldown', entry, true);
            chat_metadata.timedWorldInfo.cooldown[key] = effect;
            console.log(`[WI] Adding cooldown entry ${key} on ended sticky: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`);
            // Set the cooldown immediately for this evaluation
            this.#buffer.cooldown.push(entry);
        },

        /**
         * Callback for when a cooldown entry ends.
         * No-op, essentially.
         * @param {WIScanEntry} entry Entry that ended cooldown
         */
        'cooldown': (entry) => {
            console.debug('[WI] Cooldown ended for entry', entry.uid);
        },

        'delay': () => { },
    };

    /**
     * Initialize the timed effects with the given messages.
     * @param {string[]} chat Array of chat messages
     * @param {WIScanEntry[]} entries Array of entries
     * @param {boolean} isDryRun Whether the operation is a dry run
     */
    constructor(chat, entries, isDryRun = false) {
        this.#chat = chat;
        this.#entries = entries;
        this.#isDryRun = isDryRun;
        this.#ensureChatMetadata();
    }

    /**
     * Verify correct structure of chat metadata.
     */
    #ensureChatMetadata() {
        if (!chat_metadata.timedWorldInfo) {
            chat_metadata.timedWorldInfo = {};
        }

        ['sticky', 'cooldown'].forEach(type => {
            // Ensure the property exists and is an object
            if (!chat_metadata.timedWorldInfo[type] || typeof chat_metadata.timedWorldInfo[type] !== 'object') {
                chat_metadata.timedWorldInfo[type] = {};
            }

            // Clean up invalid entries
            Object.entries(chat_metadata.timedWorldInfo[type]).forEach(([key, value]) => {
                if (!value || typeof value !== 'object') {
                    delete chat_metadata.timedWorldInfo[type][key];
                }
            });
        });
    }

    /**
    * Gets a hash for a WI entry.
    * @param {WIScanEntry} entry WI entry
    * @returns {number} String hash
    */
    #getEntryHash(entry) {
        return entry.hash;
    }

    /**
     * Gets a unique-ish key for a WI entry.
     * @param {WIScanEntry} entry WI entry
     * @returns {string} String key for the entry
     */
    #getEntryKey(entry) {
        return `${entry.world}.${entry.uid}`;
    }

    /**
     * Gets a timed effect for a WI entry.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry
     * @param {boolean} isProtected If the effect should be protected
     * @returns {WITimedEffect} Timed effect for the entry
     */
    #getEntryTimedEffect(type, entry, isProtected) {
        return {
            hash: this.#getEntryHash(entry),
            start: this.#chat.length,
            end: this.#chat.length + Number(entry[type]),
            protected: !!isProtected,
        };
    }

    /**
     * Processes entries for a given type of timed effect.
     * @param {TimedEffectType} type Identifier for the type of timed effect
     * @param {WIScanEntry[]} buffer Buffer to store the entries
     * @param {(entry: WIScanEntry) => void} onEnded Callback for when a timed effect ends
     */
    #checkTimedEffectOfType(type, buffer, onEnded) {
        /** @type {[string, WITimedEffect][]} */
        const effects = Object.entries(chat_metadata.timedWorldInfo[type]);
        for (const [key, value] of effects) {
            console.log(`[WI] Processing ${type} entry ${key}`, value);
            const entry = this.#entries.find(x => String(this.#getEntryHash(x)) === String(value.hash));

            if (this.#chat.length <= Number(value.start) && !value.protected) {
                console.log(`[WI] Removing ${type} entry ${key} from timedWorldInfo: chat not advanced`, value);
                delete chat_metadata.timedWorldInfo[type][key];
                continue;
            }

            // Missing entries (they could be from another character's lorebook)
            if (!entry) {
                if (this.#chat.length >= Number(value.end)) {
                    console.log(`[WI] Removing ${type} entry from timedWorldInfo: entry not found and interval passed`, entry);
                    delete chat_metadata.timedWorldInfo[type][key];
                }
                continue;
            }

            // Ignore invalid entries (not configured for timed effects)
            if (!entry[type]) {
                console.log(`[WI] Removing ${type} entry from timedWorldInfo: entry not ${type}`, entry);
                delete chat_metadata.timedWorldInfo[type][key];
                continue;
            }

            if (this.#chat.length >= Number(value.end)) {
                console.log(`[WI] Removing ${type} entry from timedWorldInfo: ${type} interval passed`, entry);
                delete chat_metadata.timedWorldInfo[type][key];
                if (typeof onEnded === 'function') {
                    onEnded(entry);
                }
                continue;
            }

            buffer.push(entry);
            console.log(`[WI] Timed effect "${type}" applied to entry`, entry);
        }
    }

    /**
     * Processes entries for the "delay" timed effect.
     * @param {WIScanEntry[]} buffer Buffer to store the entries
     */
    #checkDelayEffect(buffer) {
        for (const entry of this.#entries) {
            if (!entry.delay) {
                continue;
            }

            if (this.#chat.length < entry.delay) {
                buffer.push(entry);
                console.log('[WI] Timed effect "delay" applied to entry', entry);
            }
        }
    }

    /**
     * Checks for timed effects on chat messages.
     */
    checkTimedEffects() {
        if (!this.#isDryRun) {
            this.#checkTimedEffectOfType('sticky', this.#buffer.sticky, this.#onEnded.sticky.bind(this));
            this.#checkTimedEffectOfType('cooldown', this.#buffer.cooldown, this.#onEnded.cooldown.bind(this));
        }
        this.#checkDelayEffect(this.#buffer.delay);
    }

    /**
     * Gets raw timed effect metadatum for a WI entry.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry
     * @returns {WITimedEffect} Timed effect for the entry
     */
    getEffectMetadata(type, entry) {
        if (!this.isValidEffectType(type)) {
            return null;
        }

        const key = this.#getEntryKey(entry);
        return chat_metadata.timedWorldInfo[type][key];
    }

    /**
     * Sets a timed effect for a WI entry.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry to check
     */
    #setTimedEffectOfType(type, entry) {
        // Skip if entry does not have the type (sticky or cooldown)
        if (!entry[type]) {
            return;
        }

        const key = this.#getEntryKey(entry);

        if (!chat_metadata.timedWorldInfo[type][key]) {
            const effect = this.#getEntryTimedEffect(type, entry, false);
            chat_metadata.timedWorldInfo[type][key] = effect;

            console.log(`[WI] Adding ${type} entry ${key}: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`);
        }
    }

    /**
     * Sets timed effects on chat messages.
     * @param {WIScanEntry[]} activatedEntries Entries that were activated
     */
    setTimedEffects(activatedEntries) {
        if (this.#isDryRun) return;
        for (const entry of activatedEntries) {
            this.#setTimedEffectOfType('sticky', entry);
            this.#setTimedEffectOfType('cooldown', entry);
        }
    }

    /**
     * Force set a timed effect for a WI entry.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry
     * @param {boolean} newState The state of the effect
     */
    setTimedEffect(type, entry, newState) {
        if (!this.isValidEffectType(type)) {
            return;
        }
        if (this.#isDryRun && type !== 'delay') {
            return;
        }

        const key = this.#getEntryKey(entry);
        delete chat_metadata.timedWorldInfo[type][key];

        if (newState) {
            const effect = this.#getEntryTimedEffect(type, entry, false);
            chat_metadata.timedWorldInfo[type][key] = effect;
            console.log(`[WI] Adding ${type} entry ${key}: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`);
        }
    }

    /**
     * Check if the string is a valid timed effect type.
     * @param {string} type Name of the timed effect
     * @returns {boolean} Is recognized type
     */
    isValidEffectType(type) {
        return typeof type === 'string' && ['sticky', 'cooldown', 'delay'].includes(type.trim().toLowerCase());
    }

    /**
     * Check if the current entry is sticky activated.
     * @param {TimedEffectType} type Type of timed effect
     * @param {WIScanEntry} entry WI entry to check
     * @returns {boolean} True if the entry is active
     */
    isEffectActive(type, entry) {
        if (!this.isValidEffectType(type)) {
            return false;
        }

        return this.#buffer[type]?.some(x => this.#getEntryHash(x) === this.#getEntryHash(entry)) ?? false;
    }

    /**
     * Clean-up previously set timed effects.
     */
    cleanUp() {
        for (const buffer of Object.values(this.#buffer)) {
            buffer.splice(0, buffer.length);
        }
    }
}

export function getWorldInfoSettings() {
    return {
        world_info,
        world_info_depth,
        world_info_min_activations,
        world_info_min_activations_depth_max,
        world_info_budget,
        world_info_include_names,
        world_info_recursive,
        world_info_overflow_alert,
        world_info_case_sensitive,
        world_info_match_whole_words,
        world_info_character_strategy,
        world_info_budget_cap,
        world_info_use_group_scoring,
        world_info_max_recursion_steps,
    };
}

/**
 * Updates the world info settings.
 * @param {WorldInfoSettings} settings - Settings object
 * @param {string[]} [activeWorldInfo] - Optional array of active world info names
 */
export function updateWorldInfoSettings(settings, activeWorldInfo) {
    console.debug('[WI] Updating world info settings', settings, activeWorldInfo);

    /** @type {Record<keyof WorldInfoSettings, (value: any) => void>} */
    const fields = {
        world_info_depth: (value) => world_info_depth = Number(value),
        world_info_min_activations: (value) => world_info_min_activations = Number(value),
        world_info_min_activations_depth_max: (value) => world_info_min_activations_depth_max = Number(value),
        world_info_budget: (value) => world_info_budget = Number(value),
        world_info_include_names: (value) => world_info_include_names = Boolean(value),
        world_info_recursive: (value) => world_info_recursive = Boolean(value),
        world_info_overflow_alert: (value) => world_info_overflow_alert = Boolean(value),
        world_info_case_sensitive: (value) => world_info_case_sensitive = Boolean(value),
        world_info_match_whole_words: (value) => world_info_match_whole_words = Boolean(value),
        world_info_character_strategy: (value) => world_info_character_strategy = Number(value),
        world_info_budget_cap: (value) => world_info_budget_cap = Number(value),
        world_info_use_group_scoring: (value) => world_info_use_group_scoring = Boolean(value),
        world_info_max_recursion_steps: (value) => world_info_max_recursion_steps = Number(value),
        // Unused
        world_info: (_value) => { },
    };

    for (const [key, setter] of Object.entries(fields)) {
        if (Object.hasOwn(settings, key)) {
            setter(settings[key]);
        }
    }

    if (Array.isArray(activeWorldInfo)) {
        delete settings.world_info;
        selected_world_info = activeWorldInfo;
    }

    saveSettingsDebounced();
}

export const world_info_position = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
};

export const wi_anchor_position = {
    before: 0,
    after: 1,
};

/**
 * The cache of all world info data that was loaded from the backend.
 *
 * Calling `loadWorldInfo` will fill this cache and utilize this cache, so should be the preferred way to load any world info data.
 * Only use the cache directly if you need synchronous access.
 *
 * This will return a deep clone of the data, so no way to modify the data without actually saving it.
 * Should generally be only used for readonly access.
 *
 * @type {StructuredCloneMap<string,object>}
 * */
export const worldInfoCache = new StructuredCloneMap({ cloneOnGet: true, cloneOnSet: false });
const worldInfoSnapshotCache = new Map();
const worldInfoRequestCache = new Map();
const worldInfoRequestGeneration = new Map();

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Fallback below.
        }
    }
    const seen = new WeakSet();
    const serialized = JSON.stringify(value, (_, nextValue) => {
        if (typeof nextValue === 'function' || typeof nextValue === 'symbol') {
            return undefined;
        }
        if (typeof nextValue === 'bigint') {
            return String(nextValue);
        }
        if (nextValue && typeof nextValue === 'object') {
            if (seen.has(nextValue)) {
                return undefined;
            }
            seen.add(nextValue);
        }
        return nextValue;
    });
    return serialized === undefined ? undefined : JSON.parse(serialized);
}

function rememberWorldInfoSnapshot(name, data) {
    const key = String(name || '').trim();
    if (!key) {
        return;
    }
    if (!isPlainObject(data)) {
        worldInfoSnapshotCache.delete(key);
        return;
    }
    const snapshot = cloneJsonValue(data);
    if (isPlainObject(snapshot)) {
        worldInfoSnapshotCache.set(key, snapshot);
    } else {
        worldInfoSnapshotCache.delete(key);
    }
}

function getWorldInfoSnapshot(name) {
    const key = String(name || '').trim();
    if (!key) {
        return null;
    }
    const snapshot = worldInfoSnapshotCache.get(key);
    return isPlainObject(snapshot) ? cloneJsonValue(snapshot) : null;
}

function getWorldInfoRequestGeneration(name) {
    const key = String(name || '').trim();
    return Math.max(0, Number(worldInfoRequestGeneration.get(key) || 0));
}

function invalidateWorldInfoRequestCache(names = []) {
    const normalizedNames = [...new Set((Array.isArray(names) ? names : [names])
        .map((name) => String(name || '').trim())
        .filter(Boolean))];
    for (const name of normalizedNames) {
        worldInfoRequestGeneration.set(name, getWorldInfoRequestGeneration(name) + 1);
        worldInfoRequestCache.delete(name);
    }
}

/**
 * Gets the world info based on chat messages.
 * @param {string[]} chat - The chat messages to scan, in reverse order.
 * @param {number} maxContext - The maximum context size of the generation.
 * @param {boolean} isDryRun - If true, the function will not emit any events.
 * @param {WIGlobalScanData} globalScanData Chat independent context to be scanned
 * @returns {Promise<WIPromptResult>} The world info string and depth.
 */
export async function getWorldInfoPrompt(chat, maxContext, isDryRun, globalScanData) {
    let worldInfoBeforeEntries = [], worldInfoAfterEntries = [];

    const activatedWorldInfo = await checkWorldInfo(chat, maxContext, isDryRun, globalScanData);
    worldInfoBeforeEntries = Array.isArray(activatedWorldInfo.worldInfoBeforeEntries) ? activatedWorldInfo.worldInfoBeforeEntries : [];
    worldInfoAfterEntries = Array.isArray(activatedWorldInfo.worldInfoAfterEntries) ? activatedWorldInfo.worldInfoAfterEntries : [];
    const worldInfoString = [...worldInfoBeforeEntries, ...worldInfoAfterEntries].join('\n');

    if (!isDryRun && activatedWorldInfo.allActivatedEntries && activatedWorldInfo.allActivatedEntries.size > 0) {
        const arg = Array.from(activatedWorldInfo.allActivatedEntries.values());
        await eventSource.emit(event_types.WORLD_INFO_ACTIVATED, arg);
    }

    return {
        worldInfoString,
        worldInfoBeforeEntries,
        worldInfoAfterEntries,
        worldInfoExamples: activatedWorldInfo.EMEntries ?? [],
        worldInfoDepth: activatedWorldInfo.WIDepthEntries ?? [],
        anBefore: activatedWorldInfo.ANBeforeEntries ?? [],
        anAfter: activatedWorldInfo.ANAfterEntries ?? [],
        outletEntries: activatedWorldInfo.outletEntries ?? {},
    };
}

export function setWorldInfoSettings(settings, data) {
    if (settings.world_info_depth !== undefined)
        world_info_depth = Number(settings.world_info_depth);
    if (settings.world_info_min_activations !== undefined)
        world_info_min_activations = Number(settings.world_info_min_activations);
    if (settings.world_info_min_activations_depth_max !== undefined)
        world_info_min_activations_depth_max = Number(settings.world_info_min_activations_depth_max);
    if (settings.world_info_budget !== undefined)
        world_info_budget = Number(settings.world_info_budget);
    if (settings.world_info_include_names !== undefined)
        world_info_include_names = Boolean(settings.world_info_include_names);
    if (settings.world_info_recursive !== undefined)
        world_info_recursive = Boolean(settings.world_info_recursive);
    if (settings.world_info_overflow_alert !== undefined)
        world_info_overflow_alert = Boolean(settings.world_info_overflow_alert);
    if (settings.world_info_case_sensitive !== undefined)
        world_info_case_sensitive = Boolean(settings.world_info_case_sensitive);
    if (settings.world_info_match_whole_words !== undefined)
        world_info_match_whole_words = Boolean(settings.world_info_match_whole_words);
    if (settings.world_info_character_strategy !== undefined)
        world_info_character_strategy = Number(settings.world_info_character_strategy);
    if (settings.world_info_budget_cap !== undefined)
        world_info_budget_cap = Number(settings.world_info_budget_cap);
    if (settings.world_info_use_group_scoring !== undefined)
        world_info_use_group_scoring = Boolean(settings.world_info_use_group_scoring);
    if (settings.world_info_max_recursion_steps !== undefined)
        world_info_max_recursion_steps = Number(settings.world_info_max_recursion_steps);

    // Migrate old settings
    if (world_info_budget > 100) {
        world_info_budget = 25;
    }

    if (world_info_use_group_scoring === undefined) {
        world_info_use_group_scoring = false;
    }

    // Reset selected world from old string and delete old keys
    // TODO: Remove next release
    const existingWorldInfo = settings.world_info;
    if (typeof existingWorldInfo === 'string') {
        delete settings.world_info;
        selected_world_info = [existingWorldInfo];
    } else if (Array.isArray(existingWorldInfo)) {
        delete settings.world_info;
        selected_world_info = existingWorldInfo;
    }

    world_info = settings.world_info ?? {};

    $('#world_info_depth_counter').val(world_info_depth);
    $('#world_info_depth').val(world_info_depth);

    $('#world_info_min_activations_counter').val(world_info_min_activations);
    $('#world_info_min_activations').val(world_info_min_activations);

    $('#world_info_min_activations_depth_max_counter').val(world_info_min_activations_depth_max);
    $('#world_info_min_activations_depth_max').val(world_info_min_activations_depth_max);

    $('#world_info_budget_counter').val(world_info_budget);
    $('#world_info_budget').val(world_info_budget);

    $('#world_info_include_names').prop('checked', world_info_include_names);
    $('#world_info_recursive').prop('checked', world_info_recursive);
    $('#world_info_overflow_alert').prop('checked', world_info_overflow_alert);
    $('#world_info_case_sensitive').prop('checked', world_info_case_sensitive);
    $('#world_info_match_whole_words').prop('checked', world_info_match_whole_words);
    $('#world_info_use_group_scoring').prop('checked', world_info_use_group_scoring);

    $(`#world_info_character_strategy option[value='${world_info_character_strategy}']`).prop('selected', true);
    $('#world_info_character_strategy').val(world_info_character_strategy);

    $('#world_info_budget_cap').val(world_info_budget_cap);
    $('#world_info_budget_cap_counter').val(world_info_budget_cap);

    $('#world_info_max_recursion_steps').val(world_info_max_recursion_steps);
    $('#world_info_max_recursion_steps_counter').val(world_info_max_recursion_steps);

    world_names = data.world_names?.length ? data.world_names : [];

    // Add to existing selected WI if it exists
    selected_world_info = selected_world_info.concat(
        settings.world_info?.globalSelect
            ?.map((name) => resolveWorldInfoName(name))
            .filter(Boolean)
            .filter(onlyUnique) ?? [],
    );
    selected_world_info = selected_world_info
        .map((name) => resolveWorldInfoName(name))
        .filter(Boolean)
        .filter(onlyUnique);

    if (world_names.length > 0) {
        _suppressLegacySelectSync = true;
        $('#world_info').empty();
    }

    world_names.forEach((item, i) => {
        $('#world_info').append(`<option value='${i}'${selected_world_info.includes(item) ? ' selected' : ''}>${item}</option>`);
        $('#world_editor_select').append(`<option value='${i}'>${item}</option>`);
    });
    _suppressLegacySelectSync = false;

    setWorldInfoManagerPageSize(getWorldInfoManagerPageSize());
    $('#world_info_manager_page_size').val(String(worldInfoManagerState.pageSize));
    $('#world_info_sort_order').val(accountStorage.getItem(SORT_ORDER_KEY) || '0');
    if ($('#world_info_sort_order').find(':selected').data('rule') === 'search') {
        $('#world_info_sort_order').val('0');
        accountStorage.setItem(SORT_ORDER_KEY, '0');
    }
    $('#world_info_search_mode').val(getStoredWorldInfoSearchMode());
    setWorldInfoSearchAdvancedSyntaxEnabled(getStoredWorldInfoSearchAdvancedSyntaxEnabled());
    updateWorldInfoSearchInputState();
    $('#world_info').trigger('change');
    $('#world_editor_select').val('');
    $('#world_editor_select').trigger('change');
    renderWorldInfoManager();
    void refreshWorldInfoManagerMetadata();

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        const hasWorldInfo = hasChatWorldInfoSelection();
        $('.chat_lorebook_button').toggleClass('world_set', hasWorldInfo);
        // Pre-cache the world info data for the chat for quicker first prompt generation
        await getSortedEntries();
    });

    eventSource.on(event_types.WORLDINFO_UPDATED, async (name, payload) => {
        const updatedName = resolveWorldInfoName(name) || String(name || '').trim();
        if (!updatedName) {
            return;
        }

        if (isPlainObject(payload?.extensions)) {
            setWorldInfoManagerMetadata(updatedName, payload.extensions);
            renderWorldInfoManager();
        }

        if (!hasWorldInfoName(updatedName)) {
            await updateWorldInfoList();
        }

        // Avoid interrupting direct in-editor typing flow from the world editor itself.
        const activeElement = document.activeElement;
        const isEditorInputFocused = activeElement instanceof HTMLElement
            && activeElement.closest('#WorldInfo.openDrawer #world_popup') instanceof HTMLElement;
        if (isEditorInputFocused) {
            return;
        }

        reloadEditor(updatedName);
    });

    eventSource.on(event_types.WORLDINFO_FORCE_ACTIVATE, (entries) => {
        for (const entry of entries) {
            if (!Object.hasOwn(entry, 'world') || !Object.hasOwn(entry, 'uid')) {
                console.error('[WI] WORLDINFO_FORCE_ACTIVATE requires all entries to have both world and uid fields, entry IGNORED', entry);
            } else {
                WorldInfoBuffer.externalActivations.set(`${entry.world}.${entry.uid}`, entry);
                console.log('[WI] WORLDINFO_FORCE_ACTIVATE added entry', entry);
            }
        }
    });

    eventSource.on(event_types.PRESET_CHANGED, async ({ apiId, name } = {}) => {
        await checkPresetLinkedLorebookOnPresetChange({ apiId, name });
    });

    eventSource.on(event_types.MAIN_API_CHANGED, async ({ apiId } = {}) => {
        const manager = await getPresetManagerForApi(apiId);
        if (!manager) {
            return;
        }
        const name = manager.getSelectedPresetName();
        await checkPresetLinkedLorebookOnPresetChange({ apiId, name });
    });

    eventSource.on(event_types.PRESET_DELETED, ({ apiId, name } = {}) => {
        clearPresetLinkedLorebookPromptState({ apiId, name });
    });

    // Add slash commands
    registerWorldInfoSlashCommands();
}

/**
 * Reloads the editor with the specified world info file
 * @param {string} file - The file to load in the editor
 * @param {boolean} [loadIfNotSelected=false] - Indicates whether to load the file even if it's not currently selected
 */
export function reloadEditor(file, loadIfNotSelected = false) {
    const currentIndex = getWorldEditorSelectedIndex();
    const selectedIndex = resolveWorldInfoIndex(file);
    if (selectedIndex !== -1 && (loadIfNotSelected || currentIndex === selectedIndex)) {
        $('#world_editor_select').val(selectedIndex).trigger('change');
    }
}

//MARK: regWISlashCommands
function registerWorldInfoSlashCommands() {
    /**
     * Gets a *rough* approximation of the current chat context.
     * Normally, it is provided externally by the prompt builder.
     * Don't use for anything critical!
     * @returns {string[]}
     */
    function getScanningChat() {
        return getContext().chat.filter(x => !x.is_system).map(x => x.mes);
    }

    async function getEntriesFromFile(file, { args = {}, unnamed = null, callbackName = 'getEntriesFromFile' } = {}) {
        const resolvedFile = resolveWorldInfoName(file);
        if (!resolvedFile || !hasWorldInfoName(resolvedFile)) {
            toastr.warning(t`Valid World Info file name is required`);
            logSlashCommandWarn(`${callbackName}: Valid World Info file name is required`, args, unnamed);
            return '';
        }

        const data = await loadWorldInfo(resolvedFile);

        if (!data || !('entries' in data)) {
            toastr.warning(t`World Info file has an invalid format`);
            logSlashCommandWarn(`${callbackName}: World Info file has an invalid format`, args, unnamed);
            return '';
        }

        const entries = Object.values(data.entries);

        if (!entries || entries.length === 0) {
            toastr.warning(t`World Info file has no entries`);
            logSlashCommandWarn(`${callbackName}: World Info file has no entries`, args, unnamed);
            return '';
        }

        return entries;
    }

    /**
     * Gets the name of the persona-bound lorebook.
     * @param {import('./slash-commands/SlashCommand.js').NamedArguments} args Named arguments
     * @param {string} _unnamedArg not used
     * @returns {Promise<string>} The name of the persona-bound lorebook
     */
    async function getPersonaBookCallback({ name, create }, _unnamedArg) {
        let bookName = power_user.persona_description_lorebook || '';
        if (bookName) {
            return bookName;
        }

        if (isTrueBoolean(String(create))) {
            const newName = await createWorldWithName(name, `Persona Book ${name1}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 64));
            power_user.persona_description_lorebook = newName;
            setPersonaDescription();
            saveSettingsDebounced();
            return newName;
        }

        return '';
    }

    /**
     * Gets the name of the character-bound lorebook.
     * @param {import('./slash-commands/SlashCommand.js').NamedArguments} args Named arguments
     * @param {string} characterIdentifier Character name
     * @returns {Promise<string>} The name of the character-bound lorebook, a JSON string of the character's lorebooks, or an empty string
     */
    async function getCharBookCallback({ type, name, create }, characterIdentifier) {
        const context = getContext();
        if (context.groupId && !characterIdentifier) throw new Error('This command is not available in groups without providing a character name');
        type = String(type ?? '').trim().toLowerCase() || 'primary';
        characterIdentifier = String(characterIdentifier ?? '') || context.characters[context.characterId]?.avatar || null;
        const character = findChar({ name: characterIdentifier });
        if (!character) {
            toastr.error(t`Character not found.`);
            logSlashCommandWarn('getCharBookCallback: Character not found', { type, name, create }, { characterIdentifier });
            return '';
        }
        const books = [];
        if (type === 'all' || type === 'primary' && character.data?.extensions?.world) {
            books.push(character.data.extensions.world);
        }
        if (type === 'all' || type === 'additional') {
            const fileName = getCharaFilename(context.characters.indexOf(character));
            const extraCharLore = world_info.charLore?.find((e) => e.name === fileName);
            if (extraCharLore && Array.isArray(extraCharLore.extraBooks)) {
                books.push(...extraCharLore.extraBooks.filter(onlyUnique).filter(Boolean));
            }
        }

        if (isTrueBoolean(String(create)) && books.length === 0) {
            const newName = await createWorldWithName(name, `Character Book ${character.name}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 64));
            // Also assign the book now - additional if requested, otherwise as primary
            if (type === 'additional') {
                await charUpdateAddAuxWorld(character.avatar, newName);
            } else {
                await charUpdatePrimaryWorld(newName);
            }
            // Refresh UI, if needed
            setWorldInfoButtonClass(this_chid);
            books.push(newName);
        }

        return type === 'primary' ? (books[0] ?? '') : JSON.stringify(books.filter(onlyUnique).filter(Boolean));
    }

    /**
     * Gets the name of the chat-bound lorebook. Creates a new one if it doesn't exist.
     * @param {import('./slash-commands/SlashCommand.js').NamedArguments} args Named arguments
     * @returns {Promise<string>} The name of the chat-bound lorebook
     */
    async function getChatBookCallback(args) {
        const chatId = getCurrentChatId();

        if (!chatId) {
            toastr.warning(t`Open a chat to get a name of the chat-bound lorebook`);
            logSlashCommandWarn('getChatBookCallback: Open a chat to get a name of the chat-bound lorebook', args);
            return '';
        }

        const resolvedChatBook = getPrimaryChatWorldInfoName();
        if (resolvedChatBook) {
            return resolvedChatBook;
        }

        if (isFalseBoolean(String(args.create))) {
            return '';
        }

        const name = await createWorldWithName(args.name, `Chat Book ${getCurrentChatId()}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 64));

        setChatWorldInfoSelection([name]);
        await saveMetadata();
        $('.chat_lorebook_button').addClass('world_set');
        return name;
    }

    async function createWorldWithName(possibleName = undefined, fallbackName = undefined) {
        let newName = (() => {
            // Use the provided name if it's not in use
            if (typeof possibleName === 'string') {
                const name = String(possibleName);
                if (hasWorldInfoName(name)) {
                    throw new Error('This World Info file name is already in use');
                }
                return name;
            }

            // Replace non-alphanumeric characters with underscores, cut to 64 characters
            return fallbackName ?? `Lorebook (${uuidv4()})`;
        })();

        // Make sure the name is unique
        newName = getUniqueName(newName, name => hasWorldInfoName(name));

        await createNewWorldInfo(newName);
        return newName;
    }

    async function findBookEntryCallback(args, value) {
        const file = args.file;
        const field = args.field || 'key';

        const entries = await getEntriesFromFile(file, { args, unnamed: { value }, callbackName: 'findBookEntryCallback' });

        if (!entries) {
            return '';
        }

        if (typeof newWorldInfoEntryTemplate[field] === 'boolean') {
            const isTrue = isTrueBoolean(value);
            const isFalse = isFalseBoolean(value);

            if (isTrue) {
                value = String(true);
            }

            if (isFalse) {
                value = String(false);
            }
        }

        const fuse = new Fuse(entries, {
            keys: [{ name: field, weight: 1 }],
            includeScore: true,
            threshold: 0.3,
        });

        const results = fuse.search(value);

        if (!results || results.length === 0) {
            return '';
        }

        const result = results[0]?.item?.uid;

        if (result === undefined) {
            return '';
        }

        return result;
    }

    async function getEntryFieldCallback(args, uid) {
        const file = args.file;
        const field = args.field || 'content';
        const tags = getContext().tags;

        const entries = await getEntriesFromFile(file, { args, unnamed: { uid }, callbackName: 'getEntryFieldCallback' });

        if (!entries) {
            return '';
        }

        const entry = entries.find(x => String(x.uid) === String(uid));

        if (!entry) {
            toastr.warning('Valid UID is required');
            logSlashCommandWarn('getEntryFieldCallback: Valid UID is required', args, { uid });
            console.warn();
            return '';
        }

        if (!Object.hasOwn(newWorldInfoEntryDefinition, field)) {
            toastr.warning('Valid field name is required');
            logSlashCommandWarn('getEntryFieldCallback: Valid field name is required', args, { uid });
            return '';
        }

        // handle special cases, otherwise execute default logic
        let fieldValue;
        switch (field) {
            case 'characterFilterNames':
                if (entry.characterFilter) {
                    fieldValue = entry.characterFilter.names;
                }
                break;
            case 'characterFilterTags':
                if (entry.characterFilter) {
                    if (!entry.characterFilter.tags) {
                        return '';
                    }
                    //Find the tag objects corresponding to each ID in the array, then return the names
                    fieldValue = tags.filter((tag) => entry.characterFilter.tags.includes(tag.id)).map((tag) => tag.name);
                }
                break;
            case 'characterFilterExclude':
                if (entry.characterFilter) {
                    fieldValue = entry.characterFilter.isExclude;
                }
                break;
            default:
                fieldValue = entry[field] ?? newWorldInfoEntryDefinition[field]?.default;
        }

        if (fieldValue === undefined) {
            return '';
        }

        if (Array.isArray(fieldValue)) {
            return JSON.stringify(fieldValue.map(x => substituteParams(x)));
        }

        return substituteParams(String(fieldValue));
    }

    async function createEntryCallback(args, content) {
        const file = args.file;
        const key = args.key;

        const data = await loadWorldInfo(file);

        if (!data || !('entries' in data)) {
            toastr.warning('Valid World Info file name is required');
            logSlashCommandWarn('createEntryCallback: Valid World Info file name is required', args);
            return '';
        }

        const entry = createWorldInfoEntry(file, data);

        if (key) {
            entry.key.push(key);
            entry.addMemo = true;
            entry.comment = key;
        }

        if (content) {
            entry.content = content;
        }

        await saveWorldInfo(file, data);
        reloadEditor(file);

        return String(entry.uid);
    }

    async function setEntryFieldCallback(args, value) {
        const file = args.file;
        const uid = args.uid;
        const field = args.field || 'content';
        const tags = getContext().tags;

        // characterFilter is an object with internal fields we need to access, which may also may be null and need to be populated
        const createCharacterFilterFieldObjectIfNeeded = (currentEntry) => {
            if (!currentEntry.characterFilter) {
                Object.assign(
                    currentEntry,
                    {
                        characterFilter: {
                            isExclude: false,
                            names: [],
                            tags: [],
                        },
                    },
                );
            }
        };

        if (value === undefined) {
            toastr.warning('Value is required');
            logSlashCommandWarn('setEntryFieldCallback: Value is required', args, { value });
            return '';
        }

        value = value.replace(/\\([{}|])/g, '$1');

        const data = await loadWorldInfo(file);

        if (!data || !('entries' in data)) {
            toastr.warning('Valid World Info file name is required');
            logSlashCommandWarn('setEntryFieldCallback: Valid World Info file name is required', args, { value });
            return '';
        }

        const entry = data.entries[uid];

        if (!entry) {
            toastr.warning('Valid UID is required');
            logSlashCommandWarn('setEntryFieldCallback: Valid UID is required', args, { value });
            return '';
        }

        if (!Object.hasOwn(newWorldInfoEntryDefinition, field)) {
            toastr.warning('Valid field name is required');
            logSlashCommandWarn('setEntryFieldCallback: Valid field name is required', args, { value });
            return '';
        }

        // Init a default value for the field if it does not exist
        if (!Object.hasOwn(entry, field)) {
            entry[field] = newWorldInfoEntryDefinition[field].default;
        }

        // Use an array filter if it exists for the field
        const arrayFilter = newWorldInfoEntryDefinition[field]?.arrayFilter || (() => true);

        // handle special cases, otherwise execute default logic
        let tagNames;
        let charNames;
        switch (field) {
            case 'characterFilterNames':
                createCharacterFilterFieldObjectIfNeeded(entry);
                charNames = parseStringArray(value);
                entry.characterFilter.names = charNames
                    .map((name) => getCharaFilename(null, { manualAvatarKey: findChar({ name, allowAvatar: true, preferCurrentChar: false, quiet: true })?.avatar }))
                    .filter(Boolean)
                    .filter(onlyUnique);
                setWIOriginalDataValue(data, uid, 'character_filter', entry.characterFilter);
                break;
            case 'characterFilterTags':
                createCharacterFilterFieldObjectIfNeeded(entry);
                tagNames = parseStringArray(value);
                //Find the tag objects corresponding to each name in the user array, then return an array of the corresponding IDs
                entry.characterFilter.tags = tags.filter((tag) => tagNames.includes(tag.name)).map((tag) => tag.id);
                setWIOriginalDataValue(data, uid, 'character_filter', entry.characterFilter);
                break;
            case 'characterFilterExclude':
                createCharacterFilterFieldObjectIfNeeded(entry);
                entry.characterFilter.isExclude = isTrueBoolean(value);
                setWIOriginalDataValue(data, uid, 'character_filter', entry.characterFilter);
                break;
            default:
                if (Array.isArray(entry[field])) {
                    entry[field] = parseStringArray(value).filter(arrayFilter);
                } else if (typeof entry[field] === 'boolean') {
                    entry[field] = isTrueBoolean(value);
                } else if (typeof entry[field] === 'number') {
                    entry[field] = Number(value);
                } else {
                    entry[field] = value;
                }

                if (originalWIDataKeyMap[field]) {
                    setWIOriginalDataValue(data, uid, originalWIDataKeyMap[field], entry[field]);
                }
        }

        await saveWorldInfo(file, data);
        reloadEditor(file);
        return '';
    }

    async function getTimedEffectCallback(args, value) {
        if (!getCurrentChatId()) {
            throw new Error('This command can only be used in chat');
        }

        const file = args.file;
        const uid = value;
        const effect = args.effect;

        const entries = await getEntriesFromFile(file, { args, unnamed: { value }, callbackName: 'getTimedEffectCallback' });

        if (!entries) {
            return '';
        }

        /** @type {WIScanEntry} */
        const entry = structuredClone(entries.find(x => String(x.uid) === String(uid)));

        if (!entry) {
            toastr.warning('Valid UID is required');
            logSlashCommandWarn('getTimedEffectCallback: Valid UID is required', args, { uid });
            return '';
        }

        entry.world = file; // Required by the timed effects manager
        const chat = getScanningChat();
        const timedEffects = new WorldInfoTimedEffects(chat, [entry]);

        if (!timedEffects.isValidEffectType(effect)) {
            toastr.warning('Valid effect type is required');
            logSlashCommandWarn('getTimedEffectCallback: Valid effect type is required', args, { uid });
            return '';
        }

        const data = timedEffects.getEffectMetadata(effect, entry);

        if (String(args.format).trim().toLowerCase() === ARGUMENT_TYPE.NUMBER) {
            return String(data ? (data.end - chat.length) : 0);
        }

        return String(!!data);
    }

    async function setTimedEffectCallback(args, value) {
        if (!getCurrentChatId()) {
            throw new Error('This command can only be used in chat');
        }

        const file = args.file;
        const uid = args.uid;
        const effect = args.effect;

        if (value === undefined) {
            toastr.warning('New state is required');
            logSlashCommandWarn('setTimedEffectCallback: New state is required', args, { value });
            return '';
        }

        const entries = await getEntriesFromFile(file, { args, unnamed: { value }, callbackName: 'setTimedEffectCallback' });

        if (!entries) {
            return '';
        }

        /** @type {WIScanEntry} */
        const entry = structuredClone(entries.find(x => String(x.uid) === String(uid)));

        if (!entry) {
            toastr.warning('Valid UID is required');
            logSlashCommandWarn('setTimedEffectCallback: Valid UID is required', args, { value });
            return '';
        }

        entry.world = file; // Required by the timed effects manager
        const chat = getScanningChat();
        const timedEffects = new WorldInfoTimedEffects(chat, [entry]);

        if (!timedEffects.isValidEffectType(effect)) {
            toastr.warning('Valid effect type is required');
            logSlashCommandWarn('setTimedEffectCallback: Valid effect type is required', args, { value });
            return '';
        }

        if (!entry[effect]) {
            toastr.warning('This entry does not have the selected effect. Configure it in the editor first.');
            logSlashCommandWarn('setTimedEffectCallback: This entry does not have the selected effect', args, { value });
            return '';
        }

        const getNewEffectState = () => {
            const currentState = !!timedEffects.getEffectMetadata(effect, entry);

            if (['toggle', 't', ''].includes(value.trim().toLowerCase())) {
                return !currentState;
            }

            if (isTrueBoolean(value)) {
                return true;
            }

            if (isFalseBoolean(value)) {
                return false;
            }

            return currentState;
        };

        const newEffectState = getNewEffectState();
        timedEffects.setTimedEffect(effect, entry, newEffectState);

        await saveMetadata();
        toastr.success(`Timed effect "${effect}" for entry ${entry.uid} is now ${newEffectState ? 'active' : 'inactive'}`);

        return '';
    }

    /** A collection of local enum providers for this context of world info */
    const localEnumProviders = {
        /** All possible fields that can be set in a WI entry */
        wiEntryFields: () => Object.entries(newWorldInfoEntryDefinition).map(([key, value]) =>
            new SlashCommandEnumValue(key, `[${value.type}] default: ${(typeof value.default === 'string' ? `'${value.default}'` : JSON.stringify(value.default))}`,
                enumTypes.enum, enumIcons.getDataTypeIcon(value.type))),

        /** All existing UIDs based on the file argument as world name */
        wiUids: (/** @type {import('./slash-commands/SlashCommandExecutor.js').SlashCommandExecutor} */ executor) => {
            const file = executor.namedArgumentList.find(it => it.name == 'file')?.value;
            if (file instanceof SlashCommandClosure) throw new Error('Argument \'file\' does not support closures');
            // Try find world from cache
            if (!worldInfoCache.has(file)) return [];
            const world = worldInfoCache.get(file);
            if (!world) return [];
            return Object.entries(world.entries).map(([uid, data]) =>
                new SlashCommandEnumValue(uid, `${data.comment ? `${data.comment}: ` : ''}${data.key.join(', ')}${data.keysecondary?.length ? ` [${Object.entries(world_info_logic).find(([_, value]) => value == data.selectiveLogic)[0]}] ${data.keysecondary.join(', ')}` : ''} [${getWiPositionString(data)}]`,
                    enumTypes.enum, enumIcons.getWiStatusIcon(data)));
        },

        timedEffects: () => [
            new SlashCommandEnumValue('sticky', 'Stays active for N messages', enumTypes.enum, '📌'),
            new SlashCommandEnumValue('cooldown', 'Cooldown for N messages', enumTypes.enum, '⌛'),
        ],
    };

    function getWiPositionString(entry) {
        switch (entry.position) {
            case world_info_position.before: return '↑Char';
            case world_info_position.after: return '↓Char';
            case world_info_position.EMTop: return '↑EM';
            case world_info_position.EMBottom: return '↓EM';
            case world_info_position.ANTop: return '↑AT';
            case world_info_position.ANBottom: return '↓AT';
            case world_info_position.atDepth: return `@D${enumIcons.getRoleIcon(entry.role)}`;
            default: return '<Unknown>';
        }
    }

    async function getGlobalBooksCallback() {
        if (!selected_world_info?.length) {
            return JSON.stringify([]);
        }

        let entries = selected_world_info.slice();

        console.debug(`[WI] Selected global world info has ${entries.length} entries`, selected_world_info);

        return JSON.stringify(entries);
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'world',
        callback: onWorldInfoChange,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'state', 'set world state', [ARGUMENT_TYPE.STRING], false, false, null, commonEnumProviders.boolean('onOffToggle')(),
            ),
            new SlashCommandNamedArgument(
                'silent', 'suppress toast messages', [ARGUMENT_TYPE.BOOLEAN], false,
            ),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'world name',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.worlds,
            }),
        ],
        helpString: `
            <div>
                Sets active World, or unsets if no args provided, use <code>state=off</code> and <code>state=toggle</code> to deactivate or toggle a World, use <code>silent=true</code> to suppress toast messages.
            </div>
        `,
        aliases: [],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getchatbook',
        callback: getChatBookCallback,
        returns: 'lorebook name',
        helpString: 'Get a name of the chat-bound lorebook or create a new one if was unbound, and pass it down the pipe.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'lorebook name if creating a new one, will be auto-generated otherwise',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'create',
                description: 'create a new lorebook if it doesn\'t exist',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'true',
            }),
        ],
        aliases: ['getchatlore', 'getchatwi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getglobalbooks',
        callback: getGlobalBooksCallback,
        returns: 'list of selected lorebook names',
        helpString: 'Get a list of names of the selected global lorebooks and pass it down the pipe.',
        aliases: ['getgloballore', 'getglobalwi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getpersonabook',
        callback: getPersonaBookCallback,
        returns: 'lorebook name',

        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'lorebook name if creating a new one, will be auto-generated otherwise',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'create',
                description: 'create a new lorebook if it doesn\'t exist',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
        ],
        helpString: 'Get a name of the current persona-bound lorebook and pass it down the pipe. Returns empty string if persona lorebook is not set.',
        aliases: ['getpersonalore', 'getpersonawi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getcharbook',
        callback: getCharBookCallback,
        returns: 'lorebook name or a list of lorebook names',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'type',
                description: 'type of the lorebook to get, returns a list for "all" and "additional"',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['primary', 'additional', 'all'],
                defaultValue: 'primary',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'lorebook name if creating a new one, will be auto-generated otherwise',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'create',
                description: 'create a new lorebook if it doesn\'t exist',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Character name - or unique character identifier (avatar key). If not provided, the current character is used.',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: commonEnumProviders.characters('character'),
            }),
        ],
        helpString: 'Get a name of the character-bound lorebook and pass it down the pipe. Returns empty string if character lorebook is not set. Does not work in group chats without providing a character avatar name.',
        aliases: ['getcharlore', 'getcharwi'],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'findentry',
        aliases: ['findlore', 'findwi'],
        returns: 'UID',
        callback: findBookEntryCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field value for fuzzy match (default: key)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'key',
                enumList: localEnumProviders.wiEntryFields(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'texts', ARGUMENT_TYPE.STRING, true, true,
            ),
        ],
        helpString: `
            <div>
                Find a UID of the record from the specified book using the fuzzy match of a field value (default: key) and pass it down the pipe.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/findentry file=chatLore field=key Shadowfang</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getentryfield',
        aliases: ['getlorefield', 'getwifield'],
        callback: getEntryFieldCallback,
        returns: 'field value',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field to retrieve (default: content)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'content',
                enumList: localEnumProviders.wiEntryFields(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.wiUids,
            }),
        ],
        helpString: `
            <div>
                Get a field value (default: content) of the record with the UID from the specified book and pass it down the pipe.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/getentryfield file=chatLore field=content 123</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'createentry',
        callback: createEntryCallback,
        aliases: ['createlore', 'createwi'],
        returns: 'UID of the new record',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            new SlashCommandNamedArgument(
                'key', 'record key', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'content', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
            <div>
                Create a new record in the specified book with the key and content (both are optional) and pass the UID down the pipe.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/createentry file=chatLore key=Shadowfang The sword of the king</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'setentryfield',
        callback: setEntryFieldCallback,
        aliases: ['setlorefield', 'setwifield'],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'uid',
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.wiUids,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field name (default: content)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'content',
                enumList: localEnumProviders.wiEntryFields(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'value', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
            <div>
                Set a field value (default: content) of the record with the UID from the specified book. To set multiple values for key fields, use comma-delimited list as a value.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/setentryfield file=chatLore uid=123 field=key Shadowfang,sword,weapon</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-set-timed-effect',
        callback: setTimedEffectCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'uid',
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.wiUids,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'effect',
                description: 'effect name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.timedEffects,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'new state of the effect',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('onOffToggle')(),
            }),
        ],
        helpString: `
            <div>
                Set a timed effect for the record with the UID from the specified book. The duration must be set in the entry itself.
                Will only be applied for the current chat. Enabling an effect that was already active refreshes the duration.
                If the last chat message is swiped or deleted, the effect will be removed.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/wi-set-timed-effect file=chatLore uid=123 effect=sticky on</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-get-timed-effect',
        callback: getTimedEffectCallback,
        helpString: `
            <div>
                Get the current state of the timed effect for the record with the UID from the specified book.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <code>/wi-get-timed-effect file=chatLore format=bool effect=sticky 123</code> - returns true or false if the effect is active or not
                    </li>
                    <li>
                        <code>/wi-get-timed-effect file=chatLore format=number effect=sticky 123</code> - returns the remaining duration of the effect, or 0 if inactive
                    </li>
                </ul>
            </div>
        `,
        returns: 'state of the effect',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'file',
                description: 'book name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.worlds,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'effect',
                description: 'effect name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.timedEffects,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'format',
                description: 'output format',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: ARGUMENT_TYPE.BOOLEAN,
                enumList: [ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.NUMBER],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: localEnumProviders.wiUids,
            }),
        ],
    }));
}


/**
 * Loads the given world into the World Editor.
 *
 * @param {string} name - The name of the world
 * @return {Promise<void>} A promise that resolves when the world editor is loaded
 */
export async function showWorldEditor(name) {
    if (!name) {
        await hideWorldEditor();
        return;
    }

    const wiData = await loadWorldInfo(name);
    await displayWorldEntries(name, wiData);
}

/**
 * Loads world info from the backend.
 *
 * This function will return from `worldInfoCache` if it has already been loaded before.
 *
 * @param {string} name - The name of the world to load
 * @return {Promise<Object|null>} A promise that resolves to the loaded world information, or null if the request fails.
 */
export async function loadWorldInfoBatch(names) {
    const uniqueNames = [...new Set((Array.isArray(names) ? names : []).map((name) => String(name || '').trim()).filter(Boolean))];
    const results = new Map();
    const awaitedRequests = [];
    const pendingNames = [];

    for (const name of uniqueNames) {
        if (worldInfoCache.has(name)) {
            const cached = worldInfoCache.get(name);
            if (!worldInfoSnapshotCache.has(name)) {
                rememberWorldInfoSnapshot(name, cached);
            }
            results.set(name, cached);
            continue;
        }

        if (worldInfoRequestCache.has(name)) {
            awaitedRequests.push(worldInfoRequestCache.get(name).then((data) => {
                results.set(name, data);
            }));
            continue;
        }

        pendingNames.push(name);
    }

    if (pendingNames.length) {
        const requestGenerationByName = new Map(
            pendingNames.map((name) => [name, getWorldInfoRequestGeneration(name)]),
        );
        const batchPromise = (async () => {
            const response = await fetch('/api/worldinfo/get-batch', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ names: pendingNames }),
                cache: 'no-cache',
            });

            if (!response.ok) {
                return new Map(pendingNames.map((name) => [name, null]));
            }

            const payload = await response.json();
            const batchResults = new Map();
            for (const name of pendingNames) {
                const data = isPlainObject(payload?.data?.[name]) ? payload.data[name] : null;
                if (data && requestGenerationByName.get(name) === getWorldInfoRequestGeneration(name)) {
                    cacheWorldInfoData(name, data);
                }
                batchResults.set(name, data);
            }
            return batchResults;
        })();

        for (const name of pendingNames) {
            worldInfoRequestCache.set(name, batchPromise.then((batchResults) => batchResults.get(name) ?? null));
        }

        try {
            const batchResults = await batchPromise;
            for (const name of pendingNames) {
                results.set(name, batchResults.get(name) ?? null);
            }
        } finally {
            pendingNames.forEach((name) => worldInfoRequestCache.delete(name));
        }
    }

    if (awaitedRequests.length) {
        await Promise.all(awaitedRequests);
    }

    return results;
}

export async function loadWorldInfo(name) {
    const resolvedName = resolveWorldInfoName(name);
    if (!resolvedName) {
        return;
    }

    const results = await loadWorldInfoBatch([resolvedName]);
    return results.get(resolvedName) ?? null;
}

export async function updateWorldInfoList() {
    const result = await fetch('/api/worldinfo/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (result.ok) {
        const data = await result.json();
        const editorSelected = getSelectedWorldEditorName();
        worldInfoManagerMetadata.clear();
        world_names = Array.isArray(data)
            ? data
                .map((entry) => String(entry?.file_id || '').trim())
                .filter(Boolean)
            : [];
        selected_world_info = selected_world_info
            .map((name) => resolveWorldInfoName(name))
            .filter(Boolean)
            .filter(onlyUnique);
        _suppressLegacySelectSync = true;
        $('#world_info').find('option[value!=""]').remove();
        $('#world_editor_select').find('option[value!=""]').remove();

        world_names.forEach((item, i) => {
            const globalListOption = new Option(item, i.toString());
            globalListOption.selected = selected_world_info.includes(item);
            const editorListOption = new Option(item, i.toString());
            editorListOption.selected = editorSelected === item;
            $('#world_info').append(globalListOption);
            $('#world_editor_select').append(editorListOption);
        });
        _suppressLegacySelectSync = false;

        const nextEditorIndex = editorSelected ? world_names.indexOf(editorSelected) : -1;
        $('#world_editor_select').val(nextEditorIndex === -1 ? '' : String(nextEditorIndex));
        if ($('#world_editor_select').data('select2')) {
            $('#world_editor_select').trigger('change.select2');
        }

        if (Array.isArray(data)) {
            data.forEach((entry) => {
                const name = String(entry?.file_id || '').trim();
                if (name) {
                    setWorldInfoManagerMetadata(name, entry?.extensions);
                }
            });
        }
    }

    invalidateWorldInfoManagerEntrySearch();
    renderWorldInfoManager();
}

function cacheWorldInfoData(name, data, { invalidateSearch = false } = {}) {
    worldInfoCache.set(name, data);
    rememberWorldInfoSnapshot(name, data);
    if (invalidateSearch) {
        invalidateWorldInfoManagerEntrySearch();
    }
}

function syncGlobalWorldInfoSettingsState() {
    Object.assign(world_info, { globalSelect: selected_world_info });
}

function syncGlobalWorldInfoSelectionUi() {
    if (!Array.isArray(world_names)) {
        return;
    }

    const selector = $('#world_info');
    if (!selector.length) {
        return;
    }

    _suppressLegacySelectSync = true;
    const selectedValues = [];
    world_names.forEach((item, index) => {
        const option = selector.find(`option[value="${index}"]`).get(0);
        const isSelected = selected_world_info.includes(item);
        if (option) {
            option.selected = isSelected;
        }
        if (isSelected) {
            selectedValues.push(index.toString());
        }
    });

    selector.val(selectedValues);
    selector.trigger('change.select2');
    _suppressLegacySelectSync = false;
    renderWorldInfoManager();
}

export async function setGlobalWorldInfoSelection(worldInfoName, selected, {
    save = true,
    refreshList = false,
} = {}) {
    const name = refreshList ? String(worldInfoName || '').trim() : resolveWorldInfoName(worldInfoName);
    if (!name) {
        return false;
    }

    if (refreshList || !Array.isArray(world_names) || (selected && !world_names.includes(name))) {
        await updateWorldInfoList();
    }

    const existingIndex = selected_world_info.findIndex((entry) => entry === name);
    let changed = false;

    if (selected) {
        if (!world_names?.includes(name)) {
            return false;
        }
        if (existingIndex === -1) {
            selected_world_info.push(name);
            changed = true;
        }
    } else if (existingIndex !== -1) {
        selected_world_info.splice(existingIndex, 1);
        changed = true;
    }

    syncGlobalWorldInfoSettingsState();
    syncGlobalWorldInfoSelectionUi();

    if (!changed) {
        return false;
    }

    requestAsyncDiffForNextSettingsSave();
    if (save) {
        saveSettingsDebounced();
    }
    await eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
    return true;
}

async function hideWorldEditor() {
    await displayWorldEntries(null, null);
}

function getWIElement(name) {
    const wiElement = $('#world_info').children().filter(function () {
        return $(this).text().toLowerCase() === name.toLowerCase();
    });

    return wiElement;
}

/**
 * Adds missing fields to WI entries that are present in the entry template, but not in the data.
 * Additionally verify that array/object fields are of the expected type.
 * @param {any[]} data WI entries
 * @returns {any[]} Data with backfilled fields
 */
function addMissingWorldInfoFields(data) {
    data.forEach((entry) => {
        // Add missing fields from the template
        Object.entries(newWorldInfoEntryTemplate).forEach(([key, value]) => {
            if (!Object.hasOwn(entry, key)) {
                entry[key] = structuredClone(value);
            }
        });

        // Ensure that the key is always an array
        if (!Array.isArray(entry.key)) {
            console.debug('[WI] Fixing invalid "key" field for entry', entry);
            entry.key = [];
        }

        // Ensure that the keysecondary is always an array
        if (!Array.isArray(entry.keysecondary)) {
            console.debug('[WI] Fixing invalid "keysecondary" field for entry', entry);
            entry.keysecondary = [];
        }

        // Ensure that the characterFilter is an object with the expected structure
        if (!entry.characterFilter || typeof entry.characterFilter !== 'object' || Array.isArray(entry.characterFilter)) {
            entry.characterFilter = {
                isExclude: false,
                names: [],
                tags: [],
            };
        }
    });

    return data;
}

/**
 * Sorts the given data based on the selected sort option
 *
 * @param {any[]} data WI entries
 * @param {object} [options={}] - Optional arguments
 * @param {{sortField?: string, sortOrder?: string, sortRule?: string}} [options.customSort={}] - Custom sort options, instead of the chosen UI sort
 * @returns {any[]} Sorted data
 */
export function sortWorldInfoEntries(data, { customSort = null } = {}) {
    const option = $('#world_info_sort_order').find(':selected');
    const sortField = customSort?.sortField ?? option.data('field');
    const sortOrder = customSort?.sortOrder ?? option.data('order');
    const sortRule = customSort?.sortRule ?? option.data('rule');
    const orderSign = sortOrder === 'asc' ? 1 : -1;

    if (!data.length) return data;

    /** @type {(a: any, b: any) => number} */
    let primarySort;

    // Secondary and tertiary it will always be sorted by Order descending, and last UID ascending
    // This is the most sensible approach for sorts where the primary sort has a lot of equal values
    const secondarySort = (a, b) => b.order - a.order;
    const tertiarySort = (a, b) => a.uid - b.uid;

    // If we have a search term for WI, we are sorting by weighting scores
    if (sortRule === 'search') {
        primarySort = (a, b) => {
            const aScore = worldInfoFilter.getScore(FILTER_TYPES.WORLD_INFO_SEARCH, a.uid);
            const bScore = worldInfoFilter.getScore(FILTER_TYPES.WORLD_INFO_SEARCH, b.uid);
            return aScore - bScore;
        };
    } else if (sortRule === 'custom') {
        // First by display index
        primarySort = (a, b) => {
            const aValue = a.displayIndex;
            const bValue = b.displayIndex;
            return aValue - bValue;
        };
    } else if (sortRule === 'priority') {
        // First constant, then normal, then disabled.
        primarySort = (a, b) => {
            const aValue = a.disable ? 2 : a.constant ? 0 : 1;
            const bValue = b.disable ? 2 : b.constant ? 0 : 1;
            return aValue - bValue;
        };
    } else {
        primarySort = (a, b) => {
            const aValue = a[sortField];
            const bValue = b[sortField];

            // Sort strings
            if (typeof aValue === 'string' && typeof bValue === 'string') {
                if (sortRule === 'length') {
                    // Sort by string length
                    return orderSign * (aValue.length - bValue.length);
                } else {
                    // Sort by A-Z ordinal
                    return orderSign * aValue.localeCompare(bValue);
                }
            }

            // Sort numbers
            return orderSign * (Number(aValue) - Number(bValue));
        };
    }

    data.sort((a, b) => {
        return primarySort(a, b) || secondarySort(a, b) || tertiarySort(a, b);
    });

    return data;
}

function nullWorldInfo() {
    toastr.info('Create or import a new World Info file first.', 'World Info is not set', { timeOut: 10000, preventDuplicates: true });
}

/** @type {Select2Option[]} Cache all keys as selectable dropdown option */
const worldEntryKeyOptionsCache = [];

/**
 * Update the cache and all select options for the keys with new values to display
 * @param {string[]|Select2Option[]} keyOptions - An array of options to update
 * @param {object} options - Optional arguments
 * @param {boolean?} [options.remove=false] - Whether the option was removed, so the count should be reduced - otherwise it'll be increased
 * @param {boolean?} [options.reset=false] - Whether the cache should be reset. Reset will also not trigger update of the controls, as we expect them to be redrawn anyway
 */
function updateWorldEntryKeyOptionsCache(keyOptions, { remove = false, reset = false } = {}) {
    if (!keyOptions.length) return;
    /** @type {Select2Option[]} */
    const options = keyOptions.map(x => typeof x === 'string' ? { id: getSelect2OptionId(x), text: x } : x);
    if (reset) worldEntryKeyOptionsCache.length = 0;
    options.forEach(option => {
        // Update the cache list
        let cachedEntry = worldEntryKeyOptionsCache.find(x => x.id == option.id);
        if (cachedEntry) {
            cachedEntry.count += !remove ? 1 : -1;
        } else if (!remove) {
            worldEntryKeyOptionsCache.push(option);
            cachedEntry = option;
            cachedEntry.count = 1;
        }
    });

    // Sort by count DESC and then alphabetically
    worldEntryKeyOptionsCache.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

function cleanupEntryList($list, { measure = true } = {}) {
    if (measure) {
        console.time('clearEntryList');
    }

    // List already empty, skipping cleanup
    if (!$list.children().length) {
        if (measure) {
            console.timeEnd('clearEntryList');
        }
        return;
    }

    // Unsubscribe from toggle events, so that mass open won't create new drawers
    $list.find('.inline-drawer').off('inline-drawer-toggle');

    // Step 1: Clean all <option> elements within <select>
    $list.find('option').each(function () {
        const $option = $(this);
        $option.off();
        $.cleanData([$option[0]]);
        $option.remove();
    });

    // Step 2: Clean all <select> elements
    $list.find('select').each(function () {
        const $select = $(this);
        // Remove Select2-related data and container if present
        if ($select.data('select2')) {
            try {
                $select.select2('destroy');
            } catch (e) {
                console.debug('Select2 destroy failed:', e);
            }
        }
        const $container = $select.parent();
        if ($container.length) {
            $container.find('*').off();
            $.cleanData($container.find('*').get());
            $container.remove();
        }

        $select.off();
        $.cleanData([$select[0]]);
    });

    // Step 3: Clean <div>, <span>, <input>
    $list.find('div, span, input').each(function () {
        const $elem = $(this);
        $elem.off();
        $.cleanData([$elem[0]]);
        $elem.remove();
    });

    const totalElementsOfAnyKindLeftInList = $list.children().length;

    // Final cleanup
    if (totalElementsOfAnyKindLeftInList) {
        if (measure) {
            console.time('empty');
        }
        $list.empty();
        if (measure) {
            console.timeEnd('empty');
        }
    }

    if (measure) {
        console.timeEnd('clearEntryList');
    }
}

function clearEntryList($list) {
    cleanupEntryList($list, { measure: true });
}

async function persistWorldInfoEntryOrder(worldEntriesList, name, data) {
    const firstEntryUid = worldEntriesList.children('.world_entry').first().data('uid');
    const minDisplayIndex = data?.entries[firstEntryUid]?.displayIndex ?? 0;
    worldEntriesList.children('.world_entry').each(function (index) {
        const uid = $(this).data('uid');
        const item = data.entries[uid];

        if (!item) {
            console.debug(`Could not find entry with uid ${uid}`);
            return;
        }

        item.displayIndex = minDisplayIndex + index;
        setWIOriginalDataValue(data, uid, 'extensions.display_index', item.displayIndex);
    });

    await saveWorldInfo(name, data);
}

function stopWorldInfoDragEvent(event) {
    try { event.preventDefault?.(); } catch { }
    try { event.stopImmediatePropagation?.(); } catch { }
    try { event.stopPropagation?.(); } catch { }
}

function isScrollableYAxis(element) {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    try {
        const style = getComputedStyle(element);
        const overflowY = String(style.overflowY || '');
        const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
        return scrollable && ((element.scrollHeight - element.clientHeight) > 2);
    } catch {
        return false;
    }
}

function findWorldInfoScrollContainer(startEl) {
    let element = startEl;
    while (element instanceof HTMLElement) {
        if (isScrollableYAxis(element)) {
            return element;
        }
        element = element.parentElement;
    }

    return startEl instanceof HTMLElement ? startEl : document.documentElement;
}

function getWorldInfoTextareaElements(textareas) {
    const input = Array.isArray(textareas) ? textareas : [textareas];
    return input
        .map((textarea) => textarea instanceof HTMLElement ? textarea : textarea?.[0])
        .filter((element) => element instanceof HTMLElement);
}

function getWorldInfoScrollSnapshots(textareas) {
    const elements = getWorldInfoTextareaElements(textareas);
    const scrollTargets = [
        window,
        document.scrollingElement,
        document.documentElement,
        document.body,
        document.getElementById('WorldInfo'),
        ...elements.map((element) => findWorldInfoScrollContainer(element)),
    ].filter((target, index, array) => target && array.indexOf(target) === index);

    return scrollTargets.map((target) => target === window
        ? [target, window.scrollX, window.scrollY]
        : [target, target.scrollLeft, target.scrollTop]);
}

function restoreWorldInfoScrollSnapshots(scrollSnapshots) {
    for (const [target, left, top] of scrollSnapshots) {
        if (target === window) {
            window.scrollTo(left, top);
        } else {
            target.scrollLeft = left;
            target.scrollTop = top;
        }
    }
}

function resizeWorldInfoTextarea(element) {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    element.style.height = '0px';
    element.style.height = `${element.scrollHeight + 3}px`;
}

async function resetWorldInfoTextareaHeight(textarea, { preserveScroll = true } = {}) {
    const [element] = getWorldInfoTextareaElements(textarea);
    if (!element) {
        return;
    }

    if (!preserveScroll) {
        resizeWorldInfoTextarea(element);
        return;
    }

    const scrollSnapshots = getWorldInfoScrollSnapshots([element]);
    resizeWorldInfoTextarea(element);
    restoreWorldInfoScrollSnapshots(scrollSnapshots);
    await new Promise((resolve) => requestAnimationFrame(() => {
        restoreWorldInfoScrollSnapshots(scrollSnapshots);
        resolve();
    }));
}

async function resetWorldInfoTextareaHeights(textareas, { preserveScroll = true } = {}) {
    const elements = getWorldInfoTextareaElements(textareas);
    if (elements.length === 0) {
        return;
    }

    if (!preserveScroll) {
        elements.forEach(resizeWorldInfoTextarea);
        return;
    }

    const scrollSnapshots = getWorldInfoScrollSnapshots(elements);
    elements.forEach(resizeWorldInfoTextarea);
    restoreWorldInfoScrollSnapshots(scrollSnapshots);
    await new Promise((resolve) => requestAnimationFrame(() => {
        restoreWorldInfoScrollSnapshots(scrollSnapshots);
        resolve();
    }));
}

function getWorldInfoPointerXY(event) {
    const touches = event?.touches;
    if (touches?.length) {
        return { x: touches[0].clientX, y: touches[0].clientY };
    }

    const changedTouches = event?.changedTouches;
    if (changedTouches?.length) {
        return { x: changedTouches[0].clientX, y: changedTouches[0].clientY };
    }

    return {
        x: Number(event?.clientX ?? 0),
        y: Number(event?.clientY ?? 0),
    };
}

function createWorldInfoDragGhost(draggedEl) {
    const ghost = buildWorldInfoDragHelper($(draggedEl));
    ghost.addClass('world-info-drag-ghost');
    ghost.css({
        position: 'fixed',
        left: '0',
        top: '0',
        margin: '0',
        'z-index': String(WORLD_INFO_INDICATOR_DRAG_Z_INDEX),
        'pointer-events': 'none',
        opacity: '0.96',
    });
    return ghost;
}

function createWorldInfoDropIndicator(listRect, topPx) {
    const indicator = document.createElement('div');
    indicator.className = 'world-info-drop-indicator';
    indicator.style.position = 'fixed';
    indicator.style.left = `${Math.round(listRect.left)}px`;
    indicator.style.top = `${Math.round(topPx)}px`;
    indicator.style.width = `${Math.round(listRect.width)}px`;
    indicator.style.height = '4px';
    indicator.style.borderRadius = '999px';
    indicator.style.background = 'var(--SmartThemeQuoteColor)';
    indicator.style.opacity = '0.75';
    indicator.style.pointerEvents = 'none';
    indicator.style.zIndex = String(WORLD_INFO_INDICATOR_DRAG_Z_INDEX);
    document.body.appendChild(indicator);
    return indicator;
}

function getWorldInfoEntryAtPoint(listEl, draggedEl, x, y) {
    let hit = null;
    try {
        hit = document.elementFromPoint(x, y);
    } catch {
        hit = null;
    }

    if (!(hit instanceof Element)) {
        return null;
    }

    const entry = hit.closest('.world_entry');
    if (!(entry instanceof HTMLElement) || entry === draggedEl) {
        return null;
    }

    return entry.closest('#world_popup_entries_list') === listEl ? entry : null;
}

function getWorldInfoFirstLastEntry(listEl, draggedEl) {
    const allEntries = Array.from(listEl.querySelectorAll('.world_entry'))
        .filter(entry => entry instanceof HTMLElement && entry !== draggedEl);

    return {
        first: allEntries[0] || null,
        last: allEntries.length ? allEntries[allEntries.length - 1] : null,
    };
}

function updateWorldInfoIndicatorTarget(drag) {
    try {
        drag.listRect = drag.listEl.getBoundingClientRect();
        drag.viewportRect = drag.viewportEl.getBoundingClientRect();
    } catch {
        // Ignore stale layout reads while the popup is closing.
    }

    drag.indicatorEl.style.left = `${Math.round(drag.listRect.left)}px`;
    drag.indicatorEl.style.width = `${Math.round(drag.listRect.width)}px`;

    const hitEntry = getWorldInfoEntryAtPoint(drag.listEl, drag.draggedEl, drag.lastX, drag.lastY);
    if (hitEntry) {
        const rect = hitEntry.getBoundingClientRect();
        drag.insertBefore = drag.lastY < (rect.top + (rect.height / 2));
        drag.refEl = hitEntry;
        drag.indicatorEl.style.top = `${Math.round(drag.insertBefore ? rect.top : rect.bottom)}px`;
        return;
    }

    const { first, last } = getWorldInfoFirstLastEntry(drag.listEl, drag.draggedEl);
    if (!first || !last) {
        drag.refEl = null;
        drag.insertBefore = true;
        drag.indicatorEl.style.top = `${Math.round(drag.viewportRect.top)}px`;
        return;
    }

    if (drag.lastY < drag.viewportRect.top) {
        const rect = first.getBoundingClientRect();
        drag.refEl = first;
        drag.insertBefore = true;
        drag.indicatorEl.style.top = `${Math.round(rect.top)}px`;
        return;
    }

    if (drag.lastY > drag.viewportRect.bottom) {
        const rect = last.getBoundingClientRect();
        drag.refEl = last;
        drag.insertBefore = false;
        drag.indicatorEl.style.top = `${Math.round(rect.bottom)}px`;
        return;
    }

    if (drag.refEl && drag.refEl !== drag.draggedEl && drag.refEl.isConnected) {
        const rect = drag.refEl.getBoundingClientRect();
        drag.indicatorEl.style.top = `${Math.round(drag.insertBefore ? rect.top : rect.bottom)}px`;
        return;
    }

    const mid = drag.viewportRect.top + (drag.viewportRect.height / 2);
    if (drag.lastY < mid) {
        const rect = first.getBoundingClientRect();
        drag.refEl = first;
        drag.insertBefore = true;
        drag.indicatorEl.style.top = `${Math.round(rect.top)}px`;
    } else {
        const rect = last.getBoundingClientRect();
        drag.refEl = last;
        drag.insertBefore = false;
        drag.indicatorEl.style.top = `${Math.round(rect.bottom)}px`;
    }
}

function tickWorldInfoIndicatorDrag() {
    if (!activeWorldInfoIndicatorDrag?.active) {
        return;
    }

    const drag = activeWorldInfoIndicatorDrag;
    drag.rafId = requestAnimationFrame(tickWorldInfoIndicatorDrag);

    const edgePx = WORLD_INFO_INDICATOR_SCROLL_EDGE_PX;
    if (edgePx > 0) {
        const distTop = drag.lastY - drag.viewportRect.top;
        const distBottom = drag.viewportRect.bottom - drag.lastY;
        let delta = null;

        if (distTop < edgePx) {
            const ratio = Math.max(0, Math.min(1, (edgePx - distTop) / edgePx));
            delta = -(WORLD_INFO_INDICATOR_SCROLL_MIN_SPEED_PX + ((WORLD_INFO_INDICATOR_SCROLL_MAX_SPEED_PX - WORLD_INFO_INDICATOR_SCROLL_MIN_SPEED_PX) * ratio));
        } else if (distBottom < edgePx) {
            const ratio = Math.max(0, Math.min(1, (edgePx - distBottom) / edgePx));
            delta = WORLD_INFO_INDICATOR_SCROLL_MIN_SPEED_PX + ((WORLD_INFO_INDICATOR_SCROLL_MAX_SPEED_PX - WORLD_INFO_INDICATOR_SCROLL_MIN_SPEED_PX) * ratio);
        }

        if (delta !== null && delta !== 0) {
            const maxScroll = Math.max(0, drag.viewportEl.scrollHeight - drag.viewportEl.clientHeight);
            drag.viewportEl.scrollTop = Math.max(0, Math.min(maxScroll, drag.viewportEl.scrollTop + delta));
        }
    }

    const ghostX = drag.lastX - drag.offsetX;
    const ghostY = drag.lastY - drag.offsetY;
    drag.ghostEl.style.transform = `translate3d(${Math.round(ghostX)}px, ${Math.round(ghostY)}px, 0)`;

    updateWorldInfoIndicatorTarget(drag);
}

async function endWorldInfoIndicatorDrag({ commit }) {
    if (!activeWorldInfoIndicatorDrag) {
        return;
    }

    const drag = activeWorldInfoIndicatorDrag;
    activeWorldInfoIndicatorDrag = null;
    drag.active = false;

    if (drag.rafId !== null) {
        try { cancelAnimationFrame(drag.rafId); } catch { }
    }

    try { drag.ghostEl.remove(); } catch { }
    try { drag.indicatorEl.remove(); } catch { }

    drag.draggedEl.style.opacity = drag.originalOpacity;

    window.removeEventListener('mousemove', drag.onMove, true);
    window.removeEventListener('mouseup', drag.onUp, true);
    window.removeEventListener('touchmove', drag.onMove, true);
    window.removeEventListener('touchend', drag.onUp, true);
    window.removeEventListener('touchcancel', drag.onUp, true);

    if (!commit) {
        return;
    }

    const ref = drag.refEl;
    if (ref && ref !== drag.draggedEl && ref.parentElement === drag.listEl) {
        if (drag.insertBefore) {
            drag.listEl.insertBefore(drag.draggedEl, ref);
        } else {
            drag.listEl.insertBefore(drag.draggedEl, ref.nextSibling);
        }
    } else {
        drag.listEl.appendChild(drag.draggedEl);
    }

    await persistWorldInfoEntryOrder($(drag.listEl), drag.name, drag.data);
}

function startWorldInfoIndicatorDrag(startEvent, listEl, draggedEl, name, data) {
    if (activeWorldInfoIndicatorDrag) {
        return;
    }

    const viewportEl = findWorldInfoScrollContainer(listEl);
    const listRect = listEl.getBoundingClientRect();
    const viewportRect = viewportEl.getBoundingClientRect();
    const dragRect = draggedEl.getBoundingClientRect();
    const pointer = getWorldInfoPointerXY(startEvent);

    const ghost = createWorldInfoDragGhost(draggedEl);
    ghost.css({
        width: dragRect.width > 0 ? `${Math.round(dragRect.width)}px` : '',
        transform: `translate3d(${Math.round(dragRect.left)}px, ${Math.round(dragRect.top)}px, 0)`,
    });
    document.body.appendChild(ghost[0]);

    const indicator = createWorldInfoDropIndicator(listRect, dragRect.top);
    const offsetX = Math.max(0, Math.min(dragRect.width, pointer.x - dragRect.left));
    const offsetY = Math.max(0, Math.min(dragRect.height, pointer.y - dragRect.top));
    const originalOpacity = draggedEl.style.opacity;
    draggedEl.style.opacity = '0.35';

    const onMove = (event) => {
        if (!activeWorldInfoIndicatorDrag?.active) {
            return;
        }

        if (String(event?.type || '').startsWith('touch')) {
            try { event.preventDefault?.(); } catch { }
        }

        const nextPointer = getWorldInfoPointerXY(event);
        activeWorldInfoIndicatorDrag.lastX = nextPointer.x;
        activeWorldInfoIndicatorDrag.lastY = nextPointer.y;
    };

    const onUp = async (event) => {
        stopWorldInfoDragEvent(event);
        try {
            if (activeWorldInfoIndicatorDrag?.active) {
                updateWorldInfoIndicatorTarget(activeWorldInfoIndicatorDrag);
            }
        } catch {
            // Ignore stale layout reads on drag end.
        }
        await endWorldInfoIndicatorDrag({ commit: true });
    };

    activeWorldInfoIndicatorDrag = {
        listEl,
        viewportEl,
        listRect,
        viewportRect,
        draggedEl,
        offsetX,
        offsetY,
        lastX: pointer.x,
        lastY: pointer.y,
        refEl: null,
        insertBefore: true,
        ghostEl: ghost[0],
        indicatorEl: indicator,
        rafId: null,
        active: true,
        onMove,
        onUp,
        originalOpacity,
        name,
        data,
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('touchmove', onMove, { capture: true, passive: false });
    window.addEventListener('touchend', onUp, { capture: true, passive: false });
    window.addEventListener('touchcancel', onUp, { capture: true, passive: false });

    updateWorldInfoIndicatorTarget(activeWorldInfoIndicatorDrag);
    activeWorldInfoIndicatorDrag.rafId = requestAnimationFrame(tickWorldInfoIndicatorDrag);
}

function uninstallWorldInfoIndicatorDrag(worldEntriesList) {
    const listEl = worldEntriesList?.get?.(0);
    if (!(listEl instanceof HTMLElement)) {
        return;
    }

    const handlers = worldInfoIndicatorDragHandlers.get(listEl);
    if (handlers) {
        listEl.removeEventListener('mousedown', handlers.onMouseDown, true);
        listEl.removeEventListener('touchstart', handlers.onTouchStart, true);
        worldInfoIndicatorDragHandlers.delete(listEl);
    }

    if (activeWorldInfoIndicatorDrag?.listEl === listEl) {
        void endWorldInfoIndicatorDrag({ commit: false });
    }
}

function installWorldInfoIndicatorDrag(worldEntriesList, name, data) {
    const listEl = worldEntriesList?.get?.(0);
    if (!(listEl instanceof HTMLElement)) {
        return;
    }

    uninstallWorldInfoIndicatorDrag(worldEntriesList);

    const onStart = (event) => {
        if (activeWorldInfoIndicatorDrag) {
            return;
        }

        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        const handle = target.closest('.drag-handle');
        if (!(handle instanceof Element) || handle.closest('#world_popup_entries_list') !== listEl) {
            return;
        }

        if (event.type === 'mousedown' && typeof event.button === 'number' && event.button !== 0) {
            return;
        }

        const draggedEl = handle.closest('.world_entry');
        if (!(draggedEl instanceof HTMLElement)) {
            return;
        }

        stopWorldInfoDragEvent(event);
        startWorldInfoIndicatorDrag(event, listEl, draggedEl, name, data);
    };

    listEl.addEventListener('mousedown', onStart, true);
    listEl.addEventListener('touchstart', onStart, { capture: true, passive: false });
    worldInfoIndicatorDragHandlers.set(listEl, {
        onMouseDown: onStart,
        onTouchStart: onStart,
    });
}

function getWorldInfoDrawerWidthKey(drawerEl) {
    if (!(drawerEl instanceof HTMLElement)) {
        return 0;
    }

    const width = Math.round(drawerEl.getBoundingClientRect().width || drawerEl.offsetWidth || 0);
    if (width <= 0) {
        return 0;
    }

    return Math.round(width / 32) * 32;
}

function getWorldInfoDrawerReserveHeight(drawerEl) {
    const widthKey = getWorldInfoDrawerWidthKey(drawerEl);
    return worldInfoDrawerReserveHeightByWidth.get(widthKey) ?? WORLD_INFO_DRAWER_FALLBACK_RESERVE_HEIGHT_PX;
}

function setWorldInfoDrawerReserveHeight(drawerEl, heightPx) {
    const widthKey = getWorldInfoDrawerWidthKey(drawerEl);
    const normalizedHeight = Math.round(Number(heightPx) || 0);
    if (widthKey <= 0 || normalizedHeight <= 80) {
        return;
    }

    worldInfoDrawerReserveHeightByWidth.set(widthKey, normalizedHeight);
}

function ensureWorldInfoDrawerLoadingPlaceholder(editOutlet) {
    if (!editOutlet?.length) {
        return;
    }

    if (editOutlet.children('.world-info-entry-loading').length) {
        return;
    }

    const loading = $(`
        <div class="world-info-entry-loading">
            <div class="fa-solid fa-spinner fa-spin"></div>
            <span>${escapeHtmlText(t`Loading entry editor...`)}</span>
        </div>
    `);
    loading.css({
        display: 'flex',
        'align-items': 'center',
        gap: '8px',
        padding: '12px 14px',
        margin: '8px 0',
        border: '1px dashed var(--SmartThemeBorderColor)',
        'border-radius': '10px',
        background: 'color-mix(in srgb, var(--SmartThemeBlurTintColor) 82%, transparent)',
        color: 'var(--SmartThemeBodyColor)',
        opacity: '0.9',
    });
    editOutlet.append(loading);
}

function clearWorldInfoDrawerLoadingPlaceholder(editOutlet) {
    editOutlet?.children('.world-info-entry-loading')?.remove();
}

function reserveWorldInfoDrawerHeight(drawerEl, editOutlet) {
    const reserveHeight = getWorldInfoDrawerReserveHeight(drawerEl);
    editOutlet.css({
        height: `${reserveHeight}px`,
        overflow: 'hidden',
    });
    return reserveHeight;
}

function releaseWorldInfoDrawerHeight(editOutlet) {
    editOutlet.css({
        height: '',
        overflow: '',
    });
}

function resetWorldInfoEntrySelection(name = '') {
    selectedWorldInfoEntryBook = String(name || '').trim();
    selectedWorldInfoEntryUids.clear();
    closeBulkSetFieldMenu();
}

function ensureWorldInfoEntrySelectionContext(name = '') {
    const normalizedName = String(name || '').trim();
    if (selectedWorldInfoEntryBook !== normalizedName) {
        resetWorldInfoEntrySelection(normalizedName);
    }
    return normalizedName;
}

function getCurrentWorldInfoEntryPageUids() {
    const pageUids = $('#world_popup_entries_list').data('worldEntryPageUids');
    return Array.isArray(pageUids)
        ? pageUids.map((uid) => String(uid ?? '').trim()).filter(Boolean)
        : [];
}

function getSelectedWorldInfoEntryUids(name, data = null) {
    ensureWorldInfoEntrySelectionContext(name);

    if (data?.entries && typeof data.entries === 'object') {
        for (const uid of [...selectedWorldInfoEntryUids]) {
            if (!Object.hasOwn(data.entries, uid)) {
                selectedWorldInfoEntryUids.delete(uid);
            }
        }
    }

    return [...selectedWorldInfoEntryUids];
}

function syncWorldInfoEntryBulkToolbar(name = '', data = null) {
    const toolbar = $('#world_entry_bulk_toolbar');
    const selectPageButton = $('#world_entries_select_page');
    const clearSelectionButton = $('#world_entries_clear_selection');
    const enableSelectedButton = $('#world_entries_enable_selected');
    const disableSelectedButton = $('#world_entries_disable_selected');
    const moveSelectedButton = $('#world_entries_move_selected');
    const deleteSelectedButton = $('#world_entries_delete_selected');
    const bulkSetFieldButton = $('#world_entries_bulk_set_field');
    const status = $('#world_entry_bulk_status');
    const worldEntriesList = $('#world_popup_entries_list');

    if (!toolbar.length) {
        return;
    }

    if (!name || !data?.entries || typeof data.entries !== 'object') {
        resetWorldInfoEntrySelection('');
        toolbar.addClass('displayNone');
        status.text('');
        worldEntriesList.removeData('worldEntryPageUids');
        worldEntriesList.children('.world_entry').removeClass('bulk-selected').find('.world_entry_select').prop('checked', false);
        return;
    }

    const selectedUids = getSelectedWorldInfoEntryUids(name, data);
    const pageUids = getCurrentWorldInfoEntryPageUids();
    const selectedCount = selectedUids.length;
    const allPageSelected = pageUids.length > 0 && pageUids.every((uid) => selectedWorldInfoEntryUids.has(uid));

    toolbar.removeClass('displayNone');
    selectPageButton.find('span').text(allPageSelected ? t`Deselect Page` : t`Select Page`);
    clearSelectionButton.toggleClass('disabled', selectedCount === 0);
    enableSelectedButton.toggleClass('disabled', selectedCount === 0);
    disableSelectedButton.toggleClass('disabled', selectedCount === 0);
    moveSelectedButton.toggleClass('disabled', selectedCount === 0);
    deleteSelectedButton.toggleClass('disabled', selectedCount === 0);
    bulkSetFieldButton.toggleClass('disabled', selectedCount === 0);

    if (selectedCount > 0) {
        status.text(t`${selectedCount} entries selected`);
    } else if (pageUids.length > 0) {
        status.text(t`No entries selected`);
    } else {
        status.text(t`No entries on this page`);
    }

    worldEntriesList.children('.world_entry').each(function () {
        const entryBlock = $(this);
        const uid = String(entryBlock.data('uid') ?? entryBlock.attr('uid') ?? '').trim();
        const isSelected = uid ? selectedWorldInfoEntryUids.has(uid) : false;
        entryBlock.toggleClass('bulk-selected', isSelected);
        entryBlock.find('.world_entry_select').prop('checked', isSelected);
    });
}

function setWorldInfoEntrySelected(name, uid, selected, data = null) {
    const normalizedUid = String(uid ?? '').trim();
    if (!normalizedUid) {
        return;
    }

    ensureWorldInfoEntrySelectionContext(name);
    if (selected) {
        selectedWorldInfoEntryUids.add(normalizedUid);
    } else {
        selectedWorldInfoEntryUids.delete(normalizedUid);
    }

    syncWorldInfoEntryBulkToolbar(name, data);
}

// #region Bulk field edit (registry, menu, dialogs, apply/restore)

/**
 * Registry of fields that the bulk-set-field menu can edit. Each entry
 * describes how to render a leaf menu item, what control to show in the
 * single-field dialog, and how to validate the user's input.
 *
 * @typedef {Object} BulkEditableField
 * @property {string} key                                       entry property name
 * @property {'top'|'placement'|'matching'|'matchedFields'|'recursion'|'group'|'other'} group
 * @property {string} label                                     English i18n key (used as menu label, popup title fragment)
 * @property {'number'|'text'|'boolean'|'enum'} control
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {Array<{ value: any, label: string }>} [options]   for enum
 * @property {(value: any) => boolean} [validate]
 */

/** @type {BulkEditableField[]} */
const BULK_EDITABLE_FIELDS = [
    // top-level
    { key: 'depth', group: 'top', label: 'Injection Depth', control: 'number',
        min: 0, step: 1, validate: (v) => Number.isInteger(v) && v >= 0 },
    { key: 'position', group: 'top', label: 'Insertion Position', control: 'enum',
        options: [
            { value: world_info_position.before,    label: '⌀ Before Char' },
            { value: world_info_position.after,     label: '⌀ After Char' },
            { value: world_info_position.ANTop,     label: '↑ Author Note Top' },
            { value: world_info_position.ANBottom,  label: '↓ Author Note Bottom' },
            { value: world_info_position.atDepth,   label: '@D Custom Depth' },
            { value: world_info_position.EMTop,     label: '↑ Example Top' },
            { value: world_info_position.EMBottom,  label: '↓ Example Bottom' },
            { value: world_info_position.outlet,    label: '⊳ Outlet' },
        ] },
    { key: 'probability', group: 'top', label: 'Trigger Probability', control: 'number',
        min: 0, max: 100, step: 1,
        validate: (v) => Number.isFinite(v) && v >= 0 && v <= 100 },

    // placement
    { key: 'order', group: 'placement', label: 'Order', control: 'number', step: 1,
        validate: (v) => Number.isInteger(v) },
    { key: 'role', group: 'placement', label: 'Role', control: 'enum',
        options: [
            { value: 0, label: 'System' },
            { value: 1, label: 'User' },
            { value: 2, label: 'Assistant' },
        ] },
    { key: 'outletName', group: 'placement', label: 'Outlet Name', control: 'text' },
    { key: 'ignoreBudget', group: 'placement', label: 'Ignore Budget', control: 'boolean' },

    // matching
    { key: 'selective', group: 'matching', label: 'Use Secondary Keys', control: 'boolean' },
    { key: 'selectiveLogic', group: 'matching', label: 'Selective Logic', control: 'enum',
        options: [
            { value: 0, label: 'AND ANY' },
            { value: 1, label: 'NOT ALL' },
            { value: 2, label: 'NOT ANY' },
            { value: 3, label: 'AND ALL' },
        ] },
    { key: 'scanDepth', group: 'matching', label: 'Scan Depth', control: 'number',
        min: 0, step: 1, validate: (v) => Number.isInteger(v) && v >= 0 },
    { key: 'caseSensitive', group: 'matching', label: 'Case Sensitive', control: 'boolean' },
    { key: 'matchWholeWords', group: 'matching', label: 'Match Whole Words', control: 'boolean' },
    { key: 'useGroupScoring', group: 'matching', label: 'Use Group Scoring', control: 'boolean' },

    // recursion & lifecycle
    { key: 'preventRecursion', group: 'recursion', label: 'Prevent Recursion', control: 'boolean' },
    { key: 'excludeRecursion', group: 'recursion', label: 'Exclude from Recursion', control: 'boolean' },
    { key: 'delayUntilRecursion', group: 'recursion', label: 'Delay Until Recursion', control: 'number',
        min: 0, step: 1, validate: (v) => Number.isInteger(v) && v >= 0 },
    { key: 'sticky', group: 'recursion', label: 'Sticky', control: 'number',
        min: 0, step: 1, validate: (v) => Number.isInteger(v) && v >= 0 },
    { key: 'cooldown', group: 'recursion', label: 'Cooldown', control: 'number',
        min: 0, step: 1, validate: (v) => Number.isInteger(v) && v >= 0 },
    { key: 'delay', group: 'recursion', label: 'Delay', control: 'number',
        min: 0, step: 1, validate: (v) => Number.isInteger(v) && v >= 0 },

    // group
    { key: 'group', group: 'group', label: 'Group', control: 'text' },
    { key: 'groupOverride', group: 'group', label: 'Group Override', control: 'boolean' },
    { key: 'groupWeight', group: 'group', label: 'Group Weight', control: 'number',
        min: 0, step: 1, validate: (v) => Number.isFinite(v) && v >= 0 },

    // other
    { key: 'useProbability', group: 'other', label: 'Use Probability Trigger', control: 'boolean' },
    { key: 'automationId', group: 'other', label: 'Automation ID', control: 'text' },
    { key: 'addMemo', group: 'other', label: 'Add Memo', control: 'boolean' },
    // Note: `triggers` (generation-type filter array) is intentionally excluded
    // from this iteration — its multi-select array semantics need a dedicated
    // UI; out of scope per spec section 2.
];

/**
 * Apply a field patch to selected world-info entries with undo toast.
 *
 * @param {string} name              world book name
 * @param {object} data              loaded world-info data object
 * @param {string[]} uids            selected uids (already normalized)
 * @param {Record<string, any>} patch  { fieldKey: newValue }; BULK_PATCH_KEEP_SENTINEL values are skipped
 * @param {string} fieldLabel        i18n key for the toast message field name
 * @returns {Promise<boolean>} true when at least one entry was actually changed
 */
async function applyBulkWorldInfoEntryFieldPatch(name, data, uids, patch, fieldLabel) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName || !data || data.entries === null || typeof data.entries !== 'object') return false;

    const { changedUids, snapshot } = buildBulkFieldPatchSnapshot(data.entries, uids, patch);
    if (changedUids.length === 0) {
        toastr.info(t`No changes — all selected entries already had this value`);
        return false;
    }

    // Snapshot originalData entries before mirroring so we can revert on save failure / undo.
    const originalEntries = Array.isArray(data?.originalData?.entries) ? data.originalData.entries : [];
    const originalSnapshot = changedUids
        .map((uid) => {
            const entry = originalEntries.find((e) => e?.uid === uid || String(e?.uid) === String(uid));
            return entry ? { uid, clone: structuredClone(entry) } : null;
        })
        .filter((s) => s !== null);

    applyPatchToEntries(data.entries, changedUids, patch);

    // Mirror to originalData using the canonical entry-name → dot-path translation.
    for (const uid of changedUids) {
        for (const [fieldKey, value] of Object.entries(patch)) {
            if (value === BULK_PATCH_KEEP_SENTINEL) continue;
            const targetKey = originalWIDataKeyMap[fieldKey] ?? fieldKey;
            setWIOriginalDataValue(data, /** @type {any} */ (uid), targetKey, value);
        }
    }

    try {
        await saveWorldInfo(normalizedName, data, true);
    } catch (error) {
        // Roll back the in-memory change so UI doesn't show a divergent state
        restoreEntriesFromSnapshot(data.entries, snapshot);
        restoreOriginalDataEntries(data, originalSnapshot);
        console.error('Failed to apply bulk world-info field patch', error);
        toastr.error(t`Failed to update entries`);
        return false;
    }

    if (areLookupNamesEqual(getSelectedWorldEditorName(), normalizedName)) {
        syncWorldInfoEntryBulkToolbar(normalizedName, data);
        updateEditor(navigation_option.previous);
    }

    const localizedField = translate(fieldLabel);
    const successMessage = t`Updated ${changedUids.length} entries: ${localizedField}`;

    showUndoToast({
        message: successMessage,
        onUndo: async () => {
            try {
                restoreEntriesFromSnapshot(data.entries, snapshot);
                restoreOriginalDataEntries(data, originalSnapshot);
                await saveWorldInfo(normalizedName, data, true);
                if (areLookupNamesEqual(getSelectedWorldEditorName(), normalizedName)) {
                    updateEditor(navigation_option.previous, false);
                }
                toastr.info(t`Reverted ${snapshot.length} entries`);
            } catch (error) {
                console.error('Failed to revert bulk world-info field patch', error);
                toastr.error(t`Failed to update entries`);
            }
        },
    });

    return true;
}

/**
 * Restore previously-cloned originalData entries by uid. No-op for missing
 * uids (entry was deleted or replaced between snapshot and restore).
 *
 * @param {object} data
 * @param {Array<{ uid: string, clone: object }>} originalSnapshot
 */
function restoreOriginalDataEntries(data, originalSnapshot) {
    if (!Array.isArray(data?.originalData?.entries) || !Array.isArray(originalSnapshot)) return;
    for (const { uid, clone } of originalSnapshot) {
        const idx = data.originalData.entries.findIndex((e) => e?.uid === uid || String(e?.uid) === String(uid));
        if (idx === -1) continue;
        data.originalData.entries[idx] = structuredClone(clone);
    }
}

/**
 * Show a single-field input dialog and apply the result to all currently
 * selected world-info entries. Pre-fills the input with the common value
 * if all selected entries share it, otherwise leaves it empty and shows a
 * "mixed values" hint.
 *
 * @param {string} name
 * @param {object} data
 * @param {BulkEditableField} fieldDef
 */
async function openBulkSetFieldDialog(name, data, fieldDef) {
    const uids = getSelectedWorldInfoEntryUids(name, data);
    if (uids.length === 0) return;

    const inferred = inferCommonValue(data.entries, uids, fieldDef.key);
    const fieldLabel = translate(fieldDef.label);

    const container = document.createElement('div');
    container.classList.add('flex-container', 'flexFlowColumn', 'gap5px');

    const headerLine = document.createElement('div');
    headerLine.textContent = t`${uids.length} entries selected`;
    container.appendChild(headerLine);

    const titleLine = document.createElement('div');
    titleLine.textContent = t`Set ${fieldLabel}`;
    titleLine.classList.add('marginTop10');
    container.appendChild(titleLine);

    const valueLabel = document.createElement('label');
    valueLabel.classList.add('marginTop5');
    valueLabel.textContent = translate('New value:');
    container.appendChild(valueLabel);

    const inputEl = createBulkFieldInput(fieldDef, inferred);
    container.appendChild(inputEl);

    if (inferred.kind === 'mixed') {
        const hint = document.createElement('small');
        hint.classList.add('opacity50p');
        hint.textContent = translate('Mixed values across selected entries');
        container.appendChild(hint);
    }

    let validatedValue;
    const popup = new Popup(container, POPUP_TYPE.CONFIRM, '', {
        okButton: false,
        cancelButton: t`Cancel`,
        customButtons: [{ text: t`Apply`, result: POPUP_RESULT.AFFIRMATIVE }],
        onClosing: async (instance) => {
            if (instance.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const rawValue = readBulkFieldInput(fieldDef, inputEl);
            if (rawValue === undefined) {
                toastr.warning(t`Please enter a value`);
                return false;
            }
            if (typeof fieldDef.validate === 'function' && !fieldDef.validate(rawValue)) {
                toastr.warning(t`Invalid value`);
                return false;
            }
            validatedValue = rawValue;
            return true;
        },
    });

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE || validatedValue === undefined) return;

    await applyBulkWorldInfoEntryFieldPatch(name, data, uids, { [fieldDef.key]: validatedValue }, fieldDef.label);
}

/**
 * Create the appropriate <input>/<select> element for a field, pre-filled
 * with the common value if available.
 *
 * @param {BulkEditableField} fieldDef
 * @param {{ kind: 'common', value: any } | { kind: 'mixed' }} inferred
 * @returns {HTMLElement}
 */
function createBulkFieldInput(fieldDef, inferred) {
    const common = inferred.kind === 'common' ? inferred.value : undefined;

    switch (fieldDef.control) {
        case 'number': {
            const el = document.createElement('input');
            el.type = 'number';
            el.classList.add('text_pole', 'wide100p');
            if (typeof fieldDef.min === 'number') el.min = String(fieldDef.min);
            if (typeof fieldDef.max === 'number') el.max = String(fieldDef.max);
            if (typeof fieldDef.step === 'number') el.step = String(fieldDef.step);
            if (typeof common === 'number') el.value = String(common);
            return el;
        }
        case 'text': {
            const el = document.createElement('input');
            el.type = 'text';
            el.classList.add('text_pole', 'wide100p');
            if (typeof common === 'string') el.value = common;
            return el;
        }
        case 'boolean': {
            const wrapper = document.createElement('div');
            wrapper.classList.add('flex-container', 'gap10px');
            for (const value of [true, false]) {
                const labelEl = document.createElement('label');
                labelEl.classList.add('checkbox_label');
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = `bulk_field_${fieldDef.key}`;
                radio.value = value ? '1' : '0';
                if (common === value) radio.checked = true;
                labelEl.appendChild(radio);
                const span = document.createElement('span');
                span.textContent = value ? translate('On') : translate('Off');
                labelEl.appendChild(span);
                wrapper.appendChild(labelEl);
            }
            return wrapper;
        }
        case 'enum': {
            const el = document.createElement('select');
            el.classList.add('text_pole', 'wide100p');
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = `-- ${translate('Select…')} --`;
            el.appendChild(placeholder);
            for (const opt of fieldDef.options || []) {
                const optionEl = document.createElement('option');
                optionEl.value = JSON.stringify(opt.value);
                optionEl.textContent = translate(opt.label);
                if (Object.is(common, opt.value)) optionEl.selected = true;
                el.appendChild(optionEl);
            }
            return el;
        }
        default:
            throw new Error(`Unsupported control type: ${fieldDef.control}`);
    }
}

/**
 * Read the user-entered value out of an input element. Returns undefined
 * if the user left it empty (caller treats this as "no input").
 *
 * @param {BulkEditableField} fieldDef
 * @param {HTMLElement} inputEl
 * @returns {any | undefined}
 */
function readBulkFieldInput(fieldDef, inputEl) {
    switch (fieldDef.control) {
        case 'number': {
            const raw = /** @type {HTMLInputElement} */ (inputEl).value;
            if (raw === '') return undefined;
            const n = Number(raw);
            return Number.isFinite(n) ? n : undefined;
        }
        case 'text': {
            const raw = /** @type {HTMLInputElement} */ (inputEl).value;
            return raw;
        }
        case 'boolean': {
            const checked = /** @type {HTMLDivElement} */ (inputEl).querySelector('input[type="radio"]:checked');
            if (!checked) return undefined;
            return /** @type {HTMLInputElement} */ (checked).value === '1';
        }
        case 'enum': {
            const raw = /** @type {HTMLSelectElement} */ (inputEl).value;
            if (raw === '') return undefined;
            try { return JSON.parse(raw); } catch { return undefined; }
        }
        default:
            return undefined;
    }
}

/**
 * Internal: holds the cleanup callback for the currently-open bulk-set-field
 * menu, or null when no menu is open. The callback removes the menu DOM node
 * AND detaches the document-level mousedown / keydown listeners.
 */
let _activeBulkMenuTeardown = null;

/**
 * Close the active bulk-set-field menu, if any. Idempotent — safe to call
 * when no menu is open. Called when the user dismisses the menu, when a
 * leaf is clicked, when the user switches world books, etc.
 */
function closeBulkSetFieldMenu() {
    if (typeof _activeBulkMenuTeardown === 'function') {
        _activeBulkMenuTeardown();
    }
    _activeBulkMenuTeardown = null;
}

/**
 * Open the bulk-set-field dropdown menu near the toolbar button.
 * Built dynamically from BULK_EDITABLE_FIELDS plus the two special items
 * (Trigger Strategy, Matched Fields). Closes on outside click, Escape,
 * leaf click, or world-book switch.
 *
 * @param {string} name
 * @param {object} data
 * @param {HTMLElement} anchorEl  the toolbar button
 */
function openBulkSetFieldMenu(name, data, anchorEl) {
    // Always close any prior menu before opening a new one — single-active invariant.
    closeBulkSetFieldMenu();

    const menu = document.createElement('div');
    menu.id = 'world_bulk_set_field_menu';
    menu.classList.add('list-group', 'world_bulk_field_menu');
    menu.tabIndex = 0;

    /** @type {Array<{ label: string, onClick: () => void }>} */
    const topItems = [];
    /** @type {Map<string, Array<{ label: string, onClick: () => void }>>} */
    const submenuItems = new Map();

    for (const fieldDef of BULK_EDITABLE_FIELDS) {
        const item = {
            label: fieldDef.label,
            onClick: () => {
                closeBulkSetFieldMenu();
                void openBulkSetFieldDialog(name, data, fieldDef);
            },
        };
        if (fieldDef.group === 'top') {
            topItems.push(item);
        } else {
            const list = submenuItems.get(fieldDef.group) || [];
            list.push(item);
            submenuItems.set(fieldDef.group, list);
        }
    }

    for (const item of topItems) {
        menu.appendChild(buildBulkMenuLeaf(item.label, item.onClick));
    }

    const groupTitles = {
        placement: 'Placement',
        matching: 'Matching Rules',
        recursion: 'Recursion & Lifecycle',
        group: 'Group',
        other: 'Other',
    };

    for (const [groupKey, items] of submenuItems.entries()) {
        const groupLabel = groupTitles[groupKey] || groupKey;
        menu.appendChild(buildBulkMenuSubmenu(groupLabel, items));
    }

    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'absolute';
    menu.style.top = `${window.scrollY + rect.bottom + 2}px`;
    menu.style.left = `${window.scrollX + rect.left}px`;

    const onOutside = (event) => {
        if (!menu.contains(event.target)) {
            closeBulkSetFieldMenu();
        }
    };
    const onEscape = (event) => {
        if (event.key === 'Escape') {
            closeBulkSetFieldMenu();
        }
    };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onEscape, true);

    _activeBulkMenuTeardown = () => {
        menu.remove();
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onEscape, true);
    };
}

function buildBulkMenuLeaf(labelKey, onClick) {
    const el = document.createElement('div');
    el.classList.add('list-group-item', 'world_bulk_field_menu_item');
    el.textContent = translate(labelKey);
    el.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
    });
    return el;
}

function buildBulkMenuSubmenu(labelKey, items) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('world_bulk_field_menu_submenu', 'collapsed');

    const header = document.createElement('div');
    header.classList.add('list-group-item', 'world_bulk_field_menu_item', 'world_bulk_field_menu_submenu_header');
    const caret = document.createElement('i');
    caret.classList.add('fa-solid', 'fa-caret-right', 'world_bulk_field_menu_caret');
    header.appendChild(caret);
    const labelSpan = document.createElement('span');
    labelSpan.textContent = translate(labelKey);
    header.appendChild(labelSpan);

    const body = document.createElement('div');
    body.classList.add('world_bulk_field_menu_submenu_body');
    body.style.display = 'none';

    for (const item of items) {
        body.appendChild(buildBulkMenuLeaf(item.label, item.onClick));
    }

    header.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const expanded = wrapper.classList.toggle('collapsed');
        body.style.display = expanded ? 'none' : 'block';
        caret.classList.toggle('fa-caret-right', expanded);
        caret.classList.toggle('fa-caret-down', !expanded);
    });

    wrapper.appendChild(header);
    wrapper.appendChild(body);
    return wrapper;
}

async function applyBulkWorldInfoEntryEnabledState(name, data, uids, enabled) {
    const normalizedUids = [...new Set((Array.isArray(uids) ? uids : [])
        .map((uid) => String(uid ?? '').trim())
        .filter(Boolean)
        .filter((uid) => Object.hasOwn(data?.entries || {}, uid)))];
    if (normalizedUids.length === 0) {
        return false;
    }

    let changed = 0;
    for (const uid of normalizedUids) {
        const entry = data.entries[uid];
        if (!entry || Boolean(entry.disable) === !enabled) {
            continue;
        }

        entry.disable = !enabled;
        setWIOriginalDataValue(data, uid, 'enabled', enabled);
        changed++;
    }

    if (changed === 0) {
        return false;
    }

    await saveWorldInfo(name, data);
    return true;
}

async function deleteWorldInfoEntries(data, uids, { silent = false } = {}) {
    const normalizedUids = [...new Set((Array.isArray(uids) ? uids : [])
        .map((uid) => String(uid ?? '').trim())
        .filter(Boolean)
        .filter((uid) => Object.hasOwn(data?.entries || {}, uid)))];
    if (normalizedUids.length === 0) {
        return false;
    }

    const confirmation = silent || await Popup.show.confirm(
        normalizedUids.length === 1
            ? t`Delete the selected entry?`
            : t`Delete ${normalizedUids.length} selected entries?`,
        t`This action is irreversible!`,
    );
    if (!confirmation) {
        return false;
    }

    let deleted = 0;
    for (const uid of normalizedUids) {
        const removed = await deleteWorldInfoEntry(data, uid, { silent: true });
        if (!removed) {
            continue;
        }

        deleteWIOriginalDataValue(data, uid);
        selectedWorldInfoEntryUids.delete(uid);
        deleted++;
    }

    return deleted > 0;
}

function restoreDeletedWorldInfoEntries(data, snapshot) {
    if (!data || typeof data !== 'object' || !snapshot || typeof snapshot !== 'object') {
        return;
    }

    const currentEntries = data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)
        ? data.entries
        : {};
    const currentEntriesByUid = new Map(Object.entries(currentEntries)
        .map(([uid, entry]) => [String(uid ?? '').trim(), entry])
        .filter(([uid]) => uid));
    const deletedEntriesByUid = new Map((Array.isArray(snapshot.deletedEntries) ? snapshot.deletedEntries : [])
        .map((entry) => [String(entry?.uid ?? '').trim(), structuredClone(entry)])
        .filter(([uid]) => uid));
    const restoredEntries = {};
    const seenEntryUids = new Set();

    for (const uid of Array.isArray(snapshot.entryOrder) ? snapshot.entryOrder : []) {
        if (currentEntriesByUid.has(uid)) {
            restoredEntries[uid] = currentEntriesByUid.get(uid);
            seenEntryUids.add(uid);
            continue;
        }

        if (deletedEntriesByUid.has(uid)) {
            restoredEntries[uid] = deletedEntriesByUid.get(uid);
            seenEntryUids.add(uid);
        }
    }

    for (const [uid, entry] of currentEntriesByUid.entries()) {
        if (!seenEntryUids.has(uid)) {
            restoredEntries[uid] = entry;
            seenEntryUids.add(uid);
        }
    }

    for (const [uid, entry] of deletedEntriesByUid.entries()) {
        if (!seenEntryUids.has(uid)) {
            restoredEntries[uid] = entry;
        }
    }

    data.entries = restoredEntries;

    const shouldRestoreOriginalEntries = (Array.isArray(snapshot.originalEntryOrder) && snapshot.originalEntryOrder.length > 0)
        || (Array.isArray(snapshot.deletedOriginalEntries) && snapshot.deletedOriginalEntries.length > 0);
    if (!shouldRestoreOriginalEntries) {
        return;
    }

    if (!data.originalData || typeof data.originalData !== 'object' || Array.isArray(data.originalData)) {
        data.originalData = {};
    }

    const currentOriginalEntries = Array.isArray(data.originalData.entries) ? data.originalData.entries : [];
    const currentOriginalEntriesByUid = new Map(currentOriginalEntries
        .map((entry) => [String(entry?.uid ?? '').trim(), entry])
        .filter(([uid]) => uid));
    const deletedOriginalEntriesByUid = new Map((Array.isArray(snapshot.deletedOriginalEntries) ? snapshot.deletedOriginalEntries : [])
        .map((entry) => [String(entry?.uid ?? '').trim(), structuredClone(entry)])
        .filter(([uid]) => uid));
    const restoredOriginalEntries = [];
    const seenOriginalUids = new Set();

    for (const uid of Array.isArray(snapshot.originalEntryOrder) ? snapshot.originalEntryOrder : []) {
        if (currentOriginalEntriesByUid.has(uid)) {
            restoredOriginalEntries.push(currentOriginalEntriesByUid.get(uid));
            seenOriginalUids.add(uid);
            continue;
        }

        if (deletedOriginalEntriesByUid.has(uid)) {
            restoredOriginalEntries.push(deletedOriginalEntriesByUid.get(uid));
            seenOriginalUids.add(uid);
        }
    }

    for (const entry of currentOriginalEntries) {
        const uid = String(entry?.uid ?? '').trim();
        if (!uid || seenOriginalUids.has(uid)) {
            continue;
        }

        restoredOriginalEntries.push(entry);
        seenOriginalUids.add(uid);
    }

    for (const [uid, entry] of deletedOriginalEntriesByUid.entries()) {
        if (!seenOriginalUids.has(uid)) {
            restoredOriginalEntries.push(entry);
        }
    }

    data.originalData.entries = restoredOriginalEntries;
}

async function deleteWorldInfoEntriesWithUndo(name, data, uids) {
    const normalizedName = String(name || '').trim();
    const normalizedUids = [...new Set((Array.isArray(uids) ? uids : [])
        .map((uid) => String(uid ?? '').trim())
        .filter(Boolean)
        .filter((uid) => Object.hasOwn(data?.entries || {}, uid)))];
    if (!normalizedName || normalizedUids.length === 0) {
        return false;
    }

    const originalEntries = Array.isArray(data?.originalData?.entries) ? data.originalData.entries : [];
    const snapshot = {
        entryOrder: Object.keys(data?.entries || {}).map((uid) => String(uid ?? '').trim()).filter(Boolean),
        deletedEntries: normalizedUids
            .map((uid) => data?.entries?.[uid])
            .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
            .map((entry) => structuredClone(entry)),
        originalEntryOrder: originalEntries.map((entry) => String(entry?.uid ?? '').trim()).filter(Boolean),
        deletedOriginalEntries: originalEntries
            .filter((entry) => normalizedUids.includes(String(entry?.uid ?? '').trim()))
            .map((entry) => structuredClone(entry)),
        selectedUids: normalizedUids.filter((uid) => selectedWorldInfoEntryUids.has(uid)),
    };
    if (snapshot.deletedEntries.length === 0) {
        return false;
    }

    const deleted = await deleteWorldInfoEntries(data, normalizedUids);
    if (!deleted) {
        return false;
    }

    const deleteErrorMessage = snapshot.deletedEntries.length === 1
        ? t`Failed to delete world info entry.`
        : t`Failed to delete world info entries.`;
    const restoreErrorMessage = snapshot.deletedEntries.length === 1
        ? t`Failed to restore world info entry.`
        : t`Failed to restore world info entries.`;
    const successMessage = snapshot.deletedEntries.length === 1
        ? t`World info entry deleted.`
        : t`World info entries deleted.`;

    try {
        await saveWorldInfo(normalizedName, data, true);
    } catch (error) {
        restoreDeletedWorldInfoEntries(data, snapshot);
        if (areLookupNamesEqual(getSelectedWorldEditorName(), normalizedName)) {
            ensureWorldInfoEntrySelectionContext(normalizedName);
            for (const uid of snapshot.selectedUids) {
                selectedWorldInfoEntryUids.add(uid);
            }
            const restoreNavigation = snapshot.deletedEntries.length === 1
                ? snapshot.deletedEntries[0].uid
                : navigation_option.previous;
            updateEditor(restoreNavigation, false);
        }
        console.error('Failed to delete world info entries', error);
        toastr.error(deleteErrorMessage);
        return false;
    }

    if (areLookupNamesEqual(getSelectedWorldEditorName(), normalizedName)) {
        syncWorldInfoEntryBulkToolbar(normalizedName, data);
        updateEditor(navigation_option.previous);
    }

    showUndoToast({
        message: successMessage,
        onUndo: async () => {
            try {
                restoreDeletedWorldInfoEntries(data, snapshot);

                if (areLookupNamesEqual(getSelectedWorldEditorName(), normalizedName)) {
                    ensureWorldInfoEntrySelectionContext(normalizedName);
                    for (const uid of snapshot.selectedUids) {
                        selectedWorldInfoEntryUids.add(uid);
                    }
                }

                await saveWorldInfo(normalizedName, data, true);

                if (areLookupNamesEqual(getSelectedWorldEditorName(), normalizedName)) {
                    const restoreNavigation = snapshot.deletedEntries.length === 1
                        ? snapshot.deletedEntries[0].uid
                        : navigation_option.previous;
                    updateEditor(restoreNavigation, false);
                }
            } catch (error) {
                console.error('Failed to restore deleted world info entries', error);
                toastr.error(restoreErrorMessage);
            }
        },
    });

    return true;
}

async function promptWorldInfoEntryMoveTarget(sourceWorld, {
    count = 1,
    previewName = '',
} = {}) {
    let selectableWorldCount = 0;
    const select = document.createElement('select');
    select.id = 'move_entry_target_select';
    select.classList.add('text_pole', 'wide100p', 'marginTop10');

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = `-- ${t`Select Target Lorebook`} --`;
    select.appendChild(defaultOption);

    world_names.forEach((worldName) => {
        if (worldName === sourceWorld) {
            return;
        }

        const option = document.createElement('option');
        option.value = world_names.indexOf(worldName).toString();
        option.textContent = worldName;
        select.appendChild(option);
        selectableWorldCount++;
    });

    if (selectableWorldCount === 0) {
        toastr.warning(t`There are no other lorebooks to move to.`);
        return null;
    }

    const wrapper = document.createElement('div');
    wrapper.textContent = count > 1
        ? t`Move/Copy ${count} entries to:`
        : t`Move/Copy '${previewName}' to:`;
    const container = document.createElement('div');
    container.appendChild(wrapper);
    container.appendChild(select);

    let selectedWorldIndex = -1;
    select.addEventListener('change', function () {
        selectedWorldIndex = this.value === '' ? -1 : Number(this.value);
    });

    const popup = new Popup(container, POPUP_TYPE.CONFIRM, '', {
        cancelButton: t`Cancel`,
        customButtons: [
            { text: t`Move`, result: POPUP_RESULT.CUSTOM1 },
            { text: t`Copy`, result: POPUP_RESULT.CUSTOM2 },
        ],
    });
    popup.okButton.style.display = 'none';

    const popupConfirm = await popup.show();
    if (!popupConfirm || selectedWorldIndex === -1) {
        return null;
    }

    const targetName = world_names[selectedWorldIndex];
    if (!targetName) {
        toastr.warning(t`Please select a target lorebook.`);
        return null;
    }

    return {
        targetName,
        deleteOriginal: popupConfirm === POPUP_RESULT.CUSTOM1,
    };
}

function getWorldInfoManagerPageSize() {
    const storedValue = Number(accountStorage.getItem(WORLD_INFO_MANAGER_PAGE_SIZE_KEY));
    return WORLD_INFO_MANAGER_PAGE_SIZE_OPTIONS.includes(storedValue) ? storedValue : worldInfoManagerState.pageSize;
}

function setWorldInfoManagerPageSize(value) {
    const numericValue = Number(value);
    worldInfoManagerState.pageSize = WORLD_INFO_MANAGER_PAGE_SIZE_OPTIONS.includes(numericValue) ? numericValue : 12;
    accountStorage.setItem(WORLD_INFO_MANAGER_PAGE_SIZE_KEY, String(worldInfoManagerState.pageSize));
}

function getPinnedWorldInfoNames() {
    return Array.isArray(world_info?.pinnedWorlds)
        ? world_info.pinnedWorlds
            .map((name) => resolveWorldInfoName(name))
            .filter(Boolean)
            .filter(onlyUnique)
        : [];
}

function isWorldInfoPinned(name) {
    return getPinnedWorldInfoNames().some((entry) => areLookupNamesEqual(entry, name));
}

async function setWorldInfoPinned(name, pinned) {
    const resolvedName = resolveWorldInfoName(name);
    if (!resolvedName) {
        return false;
    }

    const nextPinned = getPinnedWorldInfoNames()
        .filter((entry) => !areLookupNamesEqual(entry, resolvedName));
    if (pinned) {
        nextPinned.unshift(resolvedName);
    }

    world_info.pinnedWorlds = nextPinned;
    requestAsyncDiffForNextSettingsSave();
    saveSettingsDebounced();
    await eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
    renderWorldInfoManager();
    return true;
}

function setWorldInfoManagerMetadata(name, extensions = {}) {
    const resolvedName = resolveWorldInfoName(name) || String(name || '').trim();
    if (!resolvedName) {
        return;
    }

    worldInfoManagerMetadata.set(resolvedName, isPlainObject(extensions) ? structuredClone(extensions) : {});
}

function getWorldInfoManagerMetadata(name) {
    const resolvedName = resolveWorldInfoName(name) || String(name || '').trim();
    return worldInfoManagerMetadata.get(resolvedName) || {};
}

function updateWorldInfoEditorDisplaySettingsButton() {
    const hiddenCount = WORLD_INFO_EDITOR_DISPLAY_OPTIONS
        .filter((option) => getWorldInfoEditorDisplaySettings()[option.key])
        .length;
    const baseTitle = translate('Hide or show World Info entry fields');
    const title = hiddenCount > 0
        ? `${baseTitle} (${t`${hiddenCount} hidden`})`
        : baseTitle;
    $('#world_entry_display_settings')
        .toggleClass('is-active', hiddenCount > 0)
        .attr('title', title);
}

function buildWorldInfoEditorDisplaySettingsPopupContent(settings) {
    const popupRoot = $('<div class="world_info_display_settings_popup"></div>');
    const intro = $('<div class="world_info_display_settings_intro"></div>')
        .text(t`Choose which World Info entry fields stay hidden in the editor. This only changes the editor UI.`);
    const actions = $('<div class="world_info_display_settings_actions"></div>');
    const hideAllButton = $('<button type="button" class="menu_button"></button>')
        .text(t`Hide all`)
        .attr('title', translate('Hide all World Info editor fields'));
    const showAllButton = $('<button type="button" class="menu_button"></button>')
        .text(t`Show all`)
        .attr('title', translate('Show all World Info editor fields'));
    const optionsGrid = $('<div class="world_info_display_settings_grid"></div>');

    hideAllButton.on('click', () => {
        popupRoot.find('[data-wi-display-setting]').prop('checked', true);
    });
    showAllButton.on('click', () => {
        popupRoot.find('[data-wi-display-setting]').prop('checked', false);
    });
    actions.append(hideAllButton, showAllButton);

    for (const group of WORLD_INFO_EDITOR_DISPLAY_GROUPS) {
        const groupOptions = WORLD_INFO_EDITOR_DISPLAY_OPTIONS.filter((option) => option.group === group.key);
        if (groupOptions.length === 0) {
            continue;
        }

        const groupContainer = $('<div class="world_info_display_settings_group"></div>');
        groupContainer.append($('<div class="world_info_display_settings_group_title"></div>').text(translate(String(group.labelKey || ''))));

        for (const option of groupOptions) {
            const checkboxId = `world_info_editor_display_${option.key}`;
            const checkbox = $('<input type="checkbox">')
                .attr('id', checkboxId)
                .attr('data-wi-display-setting', option.key)
                .prop('checked', Boolean(settings[option.key]));
            const label = $('<label class="checkbox world_info_display_settings_option"></label>')
                .attr('for', checkboxId)
                .append(checkbox, $('<span></span>').text(translate(String(option.labelKey || ''))));
            groupContainer.append(label);
        }

        optionsGrid.append(groupContainer);
    }

    popupRoot.append(intro, actions, optionsGrid);
    return popupRoot;
}

function readWorldInfoEditorDisplaySettingsFromPopup(popupRoot) {
    const nextSettings = { ...DEFAULT_WORLD_INFO_EDITOR_DISPLAY_SETTINGS };
    for (const option of WORLD_INFO_EDITOR_DISPLAY_OPTIONS) {
        nextSettings[option.key] = Boolean(
            popupRoot.find(`[data-wi-display-setting="${option.key}"]`).prop('checked'),
        );
    }
    return nextSettings;
}

async function showWorldInfoEditorDisplaySettingsPopup() {
    const currentSettings = getWorldInfoEditorDisplaySettings();
    const popupContent = buildWorldInfoEditorDisplaySettingsPopupContent(currentSettings);
    const result = await callGenericPopup(
        popupContent,
        POPUP_TYPE.CONFIRM,
        '',
        {
            okButton: t`Apply`,
            cancelButton: t`Cancel`,
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            leftAlign: true,
        },
    );

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const nextSettings = readWorldInfoEditorDisplaySettingsFromPopup(popupContent);
    if (JSON.stringify(currentSettings) === JSON.stringify(nextSettings)) {
        return;
    }

    power_user.world_info_editor_display = nextSettings;
    saveSettingsDebounced();
    updateWorldInfoEditorDisplaySettingsButton();

    if ($('#world_editor_select').val() !== '') {
        await updateEditor(navigation_option.previous, false);
    }
}

function applyWorldInfoEditorDisplaySettings(editTemplate) {
    if (!editTemplate?.length) {
        return;
    }

    const settings = getWorldInfoEditorDisplaySettings();
    const selectorMap = {
        hideAdditionalMatchingSources: ($root) => $root.find('.inline-drawer:has(input[name="matchCharacterDescription"])').first(),
        hidePrimaryKeywords: ($root) => $root.find('.keyprimary'),
        hideEntryLogic: ($root) => $root.find('select[name="entryLogicType"]').closest('.world_entry_form_control'),
        hideOptionalFilter: ($root) => $root.find('.keysecondary'),
        hideCharacterOrTagFilter: ($root) => $root.find('select[name="characterFilter"]').closest('.flex4'),
        hideGenerationTriggers: ($root) => $root.find('select[name="triggers"]').closest('.flex4'),
        hideScanDepth: ($root) => $root.find('input[name="scanDepth"]').closest('.world_entry_form_control'),
        hideCaseSensitive: ($root) => $root.find('select[name="caseSensitive"]').closest('.world_entry_form_control'),
        hideWholeWords: ($root) => $root.find('select[name="matchWholeWords"]').closest('.world_entry_form_control'),
        hideGroupScoring: ($root) => $root.find('select[name="useGroupScoring"]').closest('.world_entry_form_control'),
        hideAutomationId: ($root) => $root.find('input[name="automationId"]').closest('.world_entry_form_control'),
        hideRecursionLevel: ($root) => $root.find('input[name="delayUntilRecursionLevel"]').closest('.world_entry_form_control'),
        hideInclusionGroup: ($root) => $root.find('input[name="group"]').closest('.flex4'),
        hideGroupWeight: ($root) => $root.find('input[name="groupWeight"]').closest('.flex2'),
        hideSticky: ($root) => $root.find('input[name="sticky"]').closest('.flex2'),
        hideCooldown: ($root) => $root.find('input[name="cooldown"]').closest('.flex2'),
        hideDelay: ($root) => $root.find('input[name="delay"]').closest('.flex2'),
        hideExcludeRecursion: ($root) => $root.find('input[name="excludeRecursion"]').closest('label.checkbox'),
        hidePreventFurtherRecursion: ($root) => $root.find('input[name="preventRecursion"]').closest('label.checkbox'),
        hideDelayUntilRecursion: ($root) => $root.find('input[name="delay_until_recursion"]').closest('label.checkbox'),
        hideIgnoreBudget: ($root) => $root.find('input[name="ignoreBudget"]').closest('label.checkbox'),
        hideBottomLegacyControls: ($root) => $root.find('[name="WIEntryBottomControls"]'),
    };

    for (const option of WORLD_INFO_EDITOR_DISPLAY_OPTIONS) {
        if (!settings[option.key]) {
            continue;
        }

        selectorMap[option.key]?.(editTemplate)?.hide();
    }
}

function getWorldInfoTags(name) {
    const metadata = getWorldInfoManagerMetadata(name);
    const lukerMetadata = isPlainObject(metadata?.luker) ? metadata.luker : {};
    const rawTags = Array.isArray(lukerMetadata.tags)
        ? lukerMetadata.tags
        : parseStringArray(String(lukerMetadata.tags || ''));

    return rawTags
        .map((tag) => String(tag || '').trim())
        .filter(Boolean)
        .filter(onlyUnique);
}

async function setWorldInfoTags(name, tags) {
    const resolvedName = resolveWorldInfoName(name);
    if (!resolvedName) {
        return false;
    }

    const data = await loadWorldInfo(resolvedName);
    if (!data) {
        return false;
    }

    const nextTags = (Array.isArray(tags) ? tags : [])
        .map((tag) => String(tag || '').trim())
        .filter(Boolean)
        .filter(onlyUnique);
    const extensions = isPlainObject(data.extensions) ? structuredClone(data.extensions) : {};
    const lukerMetadata = isPlainObject(extensions.luker) ? structuredClone(extensions.luker) : {};
    lukerMetadata.tags = nextTags;
    extensions.luker = lukerMetadata;
    data.extensions = extensions;

    await saveWorldInfo(resolvedName, data, true);
    setWorldInfoManagerMetadata(resolvedName, extensions);
    renderWorldInfoManager();
    return true;
}

async function promptWorldInfoTags(name) {
    const existingTags = getWorldInfoTags(name).join(', ');
    const nextValue = await Popup.show.input(
        t`Edit lorebook tags`,
        t`Set comma-separated tags for "${name}"`,
        existingTags,
    );
    if (nextValue === null) {
        return false;
    }

    return setWorldInfoTags(name, parseStringArray(String(nextValue || '')));
}

async function refreshWorldInfoManagerMetadata() {
    const result = await fetch('/api/worldinfo/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (!result.ok) {
        return false;
    }

    const data = await result.json();
    worldInfoManagerMetadata.clear();
    if (Array.isArray(data)) {
        data.forEach((entry) => {
            const name = String(entry?.file_id || entry?.name || '').trim();
            if (!name) {
                return;
            }
            setWorldInfoManagerMetadata(name, entry?.extensions);
        });
    }

    renderWorldInfoManager();
    return true;
}

function pruneWorldInfoManagerSelection() {
    for (const name of [...selectedWorldInfoManagerNames]) {
        if (!world_names?.includes(name)) {
            selectedWorldInfoManagerNames.delete(name);
        }
    }
}

function getWorldInfoManagerItems() {
    return Array.isArray(world_names)
        ? world_names.map((name) => ({
            name,
            active: hasSelectedWorldInfo(name),
            pinned: isWorldInfoPinned(name),
            tags: getWorldInfoTags(name),
        }))
        : [];
}

function sortWorldInfoManagerItems(items, { searchActive = false } = {}) {
    return [...items].sort((a, b) =>
        (searchActive ? ((a.searchScore ?? 0) - (b.searchScore ?? 0)) : 0)
        || Number(b.pinned) - Number(a.pinned)
        || Number(b.active) - Number(a.active)
        || a.name.localeCompare(b.name),
    );
}

function getVisibleWorldInfoManagerItems() {
    const tagFilter = String(worldInfoManagerState.tag || '').trim();
    const searchValue = String(worldInfoManagerState.search || '').trim();
    let items = getWorldInfoManagerItems();

    if (tagFilter) {
        items = items.filter((item) => item.tags.includes(tagFilter));
    }

    if (!searchValue) {
        return sortWorldInfoManagerItems(items);
    }

    if (worldInfoManagerState.searchEntries) {
        const searchKey = getWorldInfoManagerEntrySearchKey();
        if (worldInfoManagerEntrySearchState.key !== searchKey) {
            return [];
        }

        return sortWorldInfoManagerItems(
            items.flatMap((item) => {
                const match = worldInfoManagerEntrySearchState.matches.get(item.name);
                return match ? [{ ...item, searchScore: match.score, entrySearchMatchCount: match.count }] : [];
            }),
            { searchActive: true },
        );
    }

    const fuse = new Fuse(items, {
        includeScore: true,
        ignoreLocation: true,
        threshold: 0.35,
        keys: [
            { name: 'name', weight: 0.7 },
            { name: 'tags', weight: 0.3 },
        ],
    });

    return sortWorldInfoManagerItems(
        fuse.search(searchValue).map((result) => ({
            ...result.item,
            searchScore: result.score ?? 0,
        })),
        { searchActive: true },
    );
}

async function applyBulkWorldInfoSelection(names, selected) {
    const normalizedNames = [...new Set((Array.isArray(names) ? names : [])
        .map((name) => resolveWorldInfoName(name))
        .filter(Boolean)
        .filter((name) => world_names.includes(name)))];
    if (normalizedNames.length === 0) {
        return false;
    }

    const nextSelected = selected_world_info
        .map((name) => resolveWorldInfoName(name))
        .filter(Boolean)
        .filter((name) => !normalizedNames.some((candidate) => areLookupNamesEqual(candidate, name)));

    if (selected) {
        nextSelected.push(...normalizedNames.filter((name) => !nextSelected.some((entry) => areLookupNamesEqual(entry, name))));
    }

    if (JSON.stringify(nextSelected) === JSON.stringify(selected_world_info)) {
        return false;
    }

    selected_world_info = nextSelected;
    syncGlobalWorldInfoSettingsState();
    syncGlobalWorldInfoSelectionUi();
    requestAsyncDiffForNextSettingsSave();
    saveSettingsDebounced();
    await eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
    return true;
}

async function deleteWorldInfoSelection(names) {
    const normalizedNames = [...new Set((Array.isArray(names) ? names : [])
        .map((name) => resolveWorldInfoName(name))
        .filter(Boolean)
        .filter((name) => world_names.includes(name)))];
    if (normalizedNames.length === 0) {
        return false;
    }

    for (const name of normalizedNames) {
        selectedWorldInfoManagerNames.delete(name);
        const deleted = await deleteWorldInfo(name);
        if (!deleted) {
            toastr.error(t`Failed to delete '${name}'.`);
        }
    }

    return true;
}

function buildWorldInfoManagerItem(item) {
    const isSelected = selectedWorldInfoManagerNames.has(item.name);
    const itemElement = $(`
        <div class="world_info_manager_item">
            <label class="checkbox_label world_info_manager_select_label" title="${escapeHtmlText(t`Select this lorebook for bulk actions`)}">
                <input type="checkbox" class="world_info_manager_select">
                <span class="fa-solid fa-check"></span>
            </label>
            <div class="world_info_manager_item_main">
                <button type="button" class="world_info_manager_item_title"></button>
                <div class="world_info_manager_item_meta"></div>
            </div>
            <div class="world_info_manager_item_actions">
                <div class="menu_button world_info_manager_tags_button fa-solid fa-tags"></div>
                <div class="menu_button world_info_manager_pin fa-solid fa-thumbtack"></div>
                <div class="menu_button world_info_manager_toggle fa-solid fa-toggle-off"></div>
                <div class="menu_button world_info_manager_edit fa-solid fa-pen-to-square" title="${escapeHtmlText(t`Open lorebook in editor`)}"></div>
                <div class="menu_button world_info_manager_delete fa-solid fa-trash-can" title="${escapeHtmlText(t`Delete lorebook`)}"></div>
            </div>
        </div>
    `);

    itemElement.attr('data-name', item.name);
    itemElement.toggleClass('is-active', item.active);
    itemElement.toggleClass('is-selected', isSelected);

    const selectLabel = itemElement.find('.world_info_manager_select_label');
    const selectInput = itemElement.find('.world_info_manager_select');
    selectInput.prop('checked', isSelected);
    selectLabel.on('click', (event) => event.stopPropagation());
    selectInput.on('click', (event) => event.stopPropagation());
    selectInput.on('change', function (event) {
        event.stopPropagation();
        if ($(this).prop('checked')) {
            selectedWorldInfoManagerNames.add(item.name);
        } else {
            selectedWorldInfoManagerNames.delete(item.name);
        }
        renderWorldInfoManager();
    });

    itemElement.find('.world_info_manager_item_title')
        .text(item.name)
        .attr('title', item.name)
        .on('click', () => openWorldInfoEditor(item.name));

    const meta = itemElement.find('.world_info_manager_item_meta');
    if (item.pinned) {
        meta.append($(`
            <span class="world_info_manager_badge is-pinned">
                ${escapeHtmlText(t`Pinned`)}
            </span>
        `));
    }
    meta.append($(`
        <span class="world_info_manager_badge ${item.active ? 'is-active' : ''}">
            ${escapeHtmlText(item.active ? t`Active` : t`Inactive`)}
        </span>
    `));
    if (item.tags.length > 0) {
        const tagContainer = $('<div class="world_info_manager_tags"></div>');
        item.tags.forEach((tag) => {
            tagContainer.append($(`
                <span class="world_info_manager_badge world_info_manager_tag_badge">
                    ${escapeHtmlText(tag)}
                </span>
            `));
        });
        meta.append(tagContainer);
    }

    itemElement.find('.world_info_manager_tags_button')
        .attr('title', t`Edit lorebook tags`)
        .on('click', async () => {
            await promptWorldInfoTags(item.name);
            renderWorldInfoManager();
        });
    itemElement.find('.world_info_manager_pin')
        .toggleClass('is-active', item.pinned)
        .attr('title', item.pinned ? t`Unpin lorebook` : t`Pin lorebook`)
        .on('click', async () => {
            await setWorldInfoPinned(item.name, !item.pinned);
            renderWorldInfoManager();
        });

    const toggleButton = itemElement.find('.world_info_manager_toggle');
    toggleButton
        .toggleClass('fa-toggle-on', item.active)
        .toggleClass('fa-toggle-off', !item.active)
        .toggleClass('is-active', item.active)
        .attr('title', item.active ? t`Disable lorebook` : t`Enable lorebook`)
        .on('click', async () => {
            await setGlobalWorldInfoSelection(item.name, !item.active);
            renderWorldInfoManager();
        });

    itemElement.find('.world_info_manager_edit').on('click', () => openWorldInfoEditor(item.name));
    itemElement.find('.world_info_manager_delete').on('click', async () => {
        const confirmation = await Popup.show.confirm(
            t`Delete the World/Lorebook: "${item.name}"?`,
            t`This action is irreversible!`,
        );
        if (!confirmation) {
            return;
        }

        selectedWorldInfoManagerNames.delete(item.name);
        await deleteWorldInfo(item.name);
        renderWorldInfoManager();
    });

    return itemElement;
}

function buildActiveWorldInfoChip(item) {
    const chip = $(`
        <div class="world_info_manager_active_chip">
            <button type="button" class="world_info_manager_active_name"></button>
            <div class="menu_button world_info_manager_active_pin fa-solid fa-thumbtack"></div>
            <div class="menu_button world_info_manager_active_toggle fa-solid fa-toggle-on"></div>
        </div>
    `);

    chip.toggleClass('is-pinned', item.pinned);
    chip.find('.world_info_manager_active_name')
        .text(item.name)
        .attr('title', item.name)
        .on('click', () => openWorldInfoEditor(item.name));
    chip.find('.world_info_manager_active_pin')
        .toggleClass('is-active', item.pinned)
        .attr('title', item.pinned ? t`Unpin lorebook` : t`Pin lorebook`)
        .on('click', async () => {
            await setWorldInfoPinned(item.name, !item.pinned);
            renderWorldInfoManager();
        });
    chip.find('.world_info_manager_active_toggle')
        .removeClass('fa-toggle-off')
        .addClass('fa-toggle-on')
        .toggleClass('is-active', true)
        .attr('title', t`Disable lorebook`)
        .on('click', async () => {
            await setGlobalWorldInfoSelection(item.name, false);
            renderWorldInfoManager();
        });

    return chip;
}

function renderWorldInfoManagerTagFilters(items) {
    const container = $('#world_info_manager_tag_filters');
    if (!container.length) {
        return;
    }

    const currentTag = String(worldInfoManagerState.tag || '').trim();
    const availableTags = [...new Set(items.flatMap((item) => item.tags))].sort((a, b) => a.localeCompare(b));
    if (currentTag && !availableTags.includes(currentTag)) {
        worldInfoManagerState.tag = '';
    }

    container.empty();

    const allFilter = $(`<div class="world_info_manager_tag_filter">${escapeHtmlText(t`All Tags`)}</div>`);
    allFilter.toggleClass('is-active', !worldInfoManagerState.tag);
    allFilter.on('click', () => {
        worldInfoManagerState.tag = '';
        worldInfoManagerState.page = 1;
        renderWorldInfoManager();
    });
    container.append(allFilter);

    availableTags.forEach((tag) => {
        const tagElement = $('<div class="world_info_manager_tag_filter"></div>');
        tagElement.text(tag);
        tagElement.toggleClass('is-active', worldInfoManagerState.tag === tag);
        tagElement.on('click', () => {
            worldInfoManagerState.tag = worldInfoManagerState.tag === tag ? '' : tag;
            worldInfoManagerState.page = 1;
            renderWorldInfoManager();
        });
        container.append(tagElement);
    });
}

function renderWorldInfoManager() {
    const manager = $('#world_info_manager');
    const activePanel = $('#world_info_manager_active_panel');
    const activeList = $('#world_info_manager_active_list');
    const list = $('#world_info_manager_list');
    const drawerSummary = $('#world_info_manager_drawer_summary');
    const searchInput = $('#world_info_manager_search');
    const searchEntriesInput = $('#world_info_manager_search_entries');
    const searchAdvancedInput = $('#world_info_manager_search_advanced');
    const pageStatus = $('#world_info_manager_page_status');
    const selectionStatus = $('#world_info_manager_selection_status');
    const pageSizeSelect = $('#world_info_manager_page_size');
    const selectPageButton = $('#world_info_manager_select_page');
    const clearSelectionButton = $('#world_info_manager_clear_selection');
    const enableSelectedButton = $('#world_info_manager_enable_selected');
    const disableSelectedButton = $('#world_info_manager_disable_selected');
    const deleteSelectedButton = $('#world_info_manager_delete_selected');
    const firstButton = $('#world_info_manager_first');
    const prevButton = $('#world_info_manager_prev');
    const nextButton = $('#world_info_manager_next');
    const lastButton = $('#world_info_manager_last');

    if (!manager.length || !list.length) {
        return;
    }

    worldInfoManagerState.pageSize = getWorldInfoManagerPageSize();
    pruneWorldInfoManagerSelection();
    updateWorldInfoManagerSearchInputState();

    const allItems = getWorldInfoManagerItems();
    const items = getVisibleWorldInfoManagerItems();
    const searchValue = String(worldInfoManagerState.search || '').trim();
    const searchKey = getWorldInfoManagerEntrySearchKey();
    const isEntrySearchPending = Boolean(worldInfoManagerState.searchEntries && searchValue)
        && worldInfoManagerEntrySearchState.pendingKey === searchKey
        && worldInfoManagerEntrySearchState.key !== searchKey;
    const activeItemCount = allItems.filter((item) => item.active).length;
    const totalItems = items.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / worldInfoManagerState.pageSize));
    worldInfoManagerState.page = Math.min(Math.max(1, worldInfoManagerState.page), totalPages);

    const startIndex = (worldInfoManagerState.page - 1) * worldInfoManagerState.pageSize;
    const pageItems = items.slice(startIndex, startIndex + worldInfoManagerState.pageSize);
    const allPageSelected = pageItems.length > 0 && pageItems.every((item) => selectedWorldInfoManagerNames.has(item.name));
    const selectedCount = selectedWorldInfoManagerNames.size;

    manager.removeClass('displayNone');
    drawerSummary.text(allItems.length > 0 ? `${activeItemCount}/${allItems.length}` : t`No lorebooks available.`);
    activeList.empty();
    list.empty();
    searchInput.val(worldInfoManagerState.search);
    searchEntriesInput.prop('checked', Boolean(worldInfoManagerState.searchEntries));
    searchAdvancedInput.prop('checked', isWorldInfoSearchAdvancedSyntaxEnabled());
    renderWorldInfoManagerTagFilters(allItems);

    if (worldInfoManagerState.searchEntries && searchValue && !isEntrySearchPending && worldInfoManagerEntrySearchState.key !== searchKey) {
        void refreshWorldInfoManagerSearchResults();
    }

    const activeItems = sortWorldInfoManagerItems(allItems.filter((item) => item.active));
    activePanel.toggleClass('displayNone', activeItems.length === 0);
    if (activeItems.length > 0) {
        activeList.append(activeItems.map(buildActiveWorldInfoChip));
    }

    if (totalItems === 0) {
        const hasSearchFilter = Boolean(searchValue || worldInfoManagerState.tag || worldInfoManagerState.searchEntries);
        const emptyMessage = isEntrySearchPending
            ? t`Searching lorebook entries...`
            : hasSearchFilter && allItems.length > 0
                ? t`No lorebooks matched the current search.`
                : t`No lorebooks available.`;
        list.append(`<div class="world_info_manager_empty">${escapeHtmlText(emptyMessage)}</div>`);
    } else {
        list.append(pageItems.map(buildWorldInfoManagerItem));
    }

    pageSizeSelect.val(String(worldInfoManagerState.pageSize));
    pageStatus.text(t`Page ${totalItems > 0 ? worldInfoManagerState.page : 0} / ${totalItems > 0 ? totalPages : 0}`);
    selectionStatus.text(selectedCount > 0
        ? t`${selectedCount} lorebooks selected`
        : t`No lorebooks selected`);
    selectPageButton.find('span').text(allPageSelected ? t`Deselect Page` : t`Select Page`);

    clearSelectionButton.toggleClass('disabled', selectedCount === 0);
    enableSelectedButton.toggleClass('disabled', selectedCount === 0);
    disableSelectedButton.toggleClass('disabled', selectedCount === 0);
    deleteSelectedButton.toggleClass('disabled', selectedCount === 0);
    firstButton.toggleClass('disabled', worldInfoManagerState.page <= 1);
    prevButton.toggleClass('disabled', worldInfoManagerState.page <= 1);
    nextButton.toggleClass('disabled', worldInfoManagerState.page >= totalPages);
    lastButton.toggleClass('disabled', worldInfoManagerState.page >= totalPages);
}

function destroyWorldEntryBlock($block) {
    if (!$block?.length) {
        return;
    }

    const scratch = $('<div>');
    scratch.append($block);
    cleanupEntryList(scratch, { measure: false });
}

function getWorldEntryRenderSignature(entry) {
    try {
        return JSON.stringify(entry);
    } catch {
        return String(entry?.uid ?? '');
    }
}

function isWorldEntryBlockInteractive($block) {
    if (!$block?.length) {
        return false;
    }

    const root = $block[0];
    const activeElement = document.activeElement;
    if (root instanceof Element && activeElement instanceof Element && root.contains(activeElement)) {
        return true;
    }

    return $block.find('.inline-drawer-content:visible, .select2-container--open').length > 0;
}

function getWorldEntryRenderContextKey({ isCustomOrder }) {
    return JSON.stringify({
        isCustomOrder: Boolean(isCustomOrder),
        isMobile: Boolean(isMobile()),
        keyInputPlaintext: Boolean(power_user.wi_key_input_plaintext),
        displaySettings: getWorldInfoEditorDisplaySettingsSignature(),
    });
}

function stampWorldEntryBlock($block, entry, { name, data, isCustomOrder }) {
    if (!$block?.length) {
        return;
    }

    $block.data('worldEntryRenderName', name);
    $block.data('worldEntryRenderData', data);
    $block.data('worldEntryRenderSignature', getWorldEntryRenderSignature(entry));
    $block.data('worldEntryRenderContextKey', getWorldEntryRenderContextKey({ isCustomOrder }));
}

function canReuseWorldEntryBlock($block, entry, { name, data, isCustomOrder }) {
    if (!$block?.length) {
        return false;
    }

    if ($block.data('worldEntryRenderName') !== name || $block.data('worldEntryRenderData') !== data) {
        return false;
    }

    if ($block.data('worldEntryRenderContextKey') !== getWorldEntryRenderContextKey({ isCustomOrder })) {
        return false;
    }

    const signature = getWorldEntryRenderSignature(entry);
    if (isWorldEntryBlockInteractive($block)) {
        $block.data('worldEntryRenderSignature', signature);
        return true;
    }

    return $block.data('worldEntryRenderSignature') === signature;
}

async function renderWorldEntriesPage(worldEntriesList, name, data, page, renderPass, keywordHeaders) {
    if (Number(worldEntriesList.data('worldEntryRenderPass')) !== Number(renderPass)) {
        return;
    }

    const isCustomOrder = $('#world_info_sort_order').find(':selected').data('rule') === 'custom';
    const existingBlocks = new Map(
        worldEntriesList.children('.world_entry').toArray().map((element) => {
            const block = $(element);
            return [String(block.data('uid')), block];
        }),
    );
    const nextBlocks = [];

    for (const entry of page) {
        if (Number(worldEntriesList.data('worldEntryRenderPass')) !== Number(renderPass)) {
            return;
        }

        try {
            const uid = String(entry?.uid ?? '');
            let block = existingBlocks.get(uid) ?? null;
            if (block) {
                existingBlocks.delete(uid);
                if (!canReuseWorldEntryBlock(block, entry, { name, data, isCustomOrder })) {
                    destroyWorldEntryBlock(block);
                    block = null;
                }
            }

            if (!block) {
                block = await getWorldEntry(name, data, entry);
                if (!block) {
                    continue;
                }
            }

            if (!isCustomOrder) {
                block.find('.drag-handle').remove();
            }

            stampWorldEntryBlock(block, entry, { name, data, isCustomOrder });
            nextBlocks.push(block[0]);
        } catch (error) {
            console.error(`Error while processing entry ${entry?.uid}:`, error);
        }
    }

    if (Number(worldEntriesList.data('worldEntryRenderPass')) !== Number(renderPass)) {
        return;
    }

    for (const [, block] of existingBlocks) {
        destroyWorldEntryBlock(block);
    }

    worldEntriesList.children().not('.world_entry').remove();
    worldEntriesList.append(keywordHeaders);
    worldEntriesList.append(nextBlocks);
    await resetWorldInfoTextareaHeights(worldEntriesList.find('textarea[name="comment"]').toArray());
    worldEntriesList.data('worldEntryPageUids', page.map((entry) => String(entry?.uid ?? '').trim()).filter(Boolean));
    syncWorldInfoEntryBulkToolbar(name, data);
}

//MARK: displayWorldEntries
async function displayWorldEntries(name, data, navigation = navigation_option.none, flashOnNav = true) {
    updateEditor = async (navigation, flashOnNav = true) => await displayWorldEntries(name, data, navigation, flashOnNav);

    const worldEntriesList = $('#world_popup_entries_list');
    const shouldResetRenderedPage = worldEntriesList.data('worldEntryRenderName') !== name
        || worldEntriesList.data('worldEntryRenderData') !== data;
    if (shouldResetRenderedPage) {
        clearEntryList(worldEntriesList);
    }
    const renderPass = Number(worldEntriesList.data('worldEntryRenderPass') || 0) + 1;
    worldEntriesList.data('worldEntryRenderPass', renderPass);
    worldEntriesList.data('worldEntryRenderName', name);
    worldEntriesList.data('worldEntryRenderData', data);
    worldEntriesList.show();

    if (!data || !('entries' in data)) {
        clearEntryList(worldEntriesList);
        worldEntriesList.removeData('worldEntryRenderName worldEntryRenderData');
        $('#world_popup_new').off('click').on('click', nullWorldInfo);
        $('#world_popup_name_button').off('click').on('click', nullWorldInfo);
        $('#world_popup_export').off('click').on('click', nullWorldInfo);
        $('#world_popup_delete').off('click').on('click', nullWorldInfo);
        $('#world_duplicate').off('click').on('click', nullWorldInfo);
        $('#world_entries_select_page').off('click');
        $('#world_entries_clear_selection').off('click');
        $('#world_entries_enable_selected').off('click');
        $('#world_entries_disable_selected').off('click');
        $('#world_entries_move_selected').off('click');
        $('#world_entries_delete_selected').off('click');
        worldEntriesList.hide();
        $('#world_info_pagination').html('');
        syncWorldInfoEntryBulkToolbar('', null);
        return;
    }

    ensureWorldInfoEntrySelectionContext(name);

    // Regardless of whether success is displayed or not. Make sure the delete button is available.
    // Do not put this code behind.
    $('#world_popup_delete').off('click').on('click', async () => {
        const confirmation = await Popup.show.confirm(
            t`Delete the World/Lorebook: "${name}"?`,
            t`This action is irreversible!`,
        );
        if (!confirmation) {
            return;
        }

        await deleteWorldInfoWithUndo(name);
    });

    // Before printing the WI, we check if we should enable/disable search sorting
    verifyWorldInfoSearchSortRule();
    const isCustomOrder = $('#world_info_sort_order').find(':selected').data('rule') === 'custom';

    function getDataArray(callback) {
        // Convert the data.entries object into an array
        let entriesArray = Object.keys(data.entries).map(uid => {
            const entry = data.entries[uid];
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return null;
            }
            entry.displayIndex = entry.displayIndex ?? entry.uid;
            return entry;
        }).filter(entry => entry !== null);

        // Apply the filter and do the chosen sorting
        entriesArray = addMissingWorldInfoFields(entriesArray);
        entriesArray = worldInfoFilter.applyFilters(entriesArray);
        entriesArray = sortWorldInfoEntries(entriesArray);

        // Cache keys
        const keys = entriesArray.flatMap(entry => [...entry.key, ...entry.keysecondary]);
        updateWorldEntryKeyOptionsCache(keys, { reset: true });

        // Run the callback for printing this
        typeof callback === 'function' && callback(entriesArray);
        return entriesArray;
    }

    const storageKey = 'WI_PerPage';
    const perPageDefault = 25;
    const entriesArray = getDataArray();
    const perPage = Number(accountStorage.getItem(storageKey)) || perPageDefault;
    const keywordHeaders = await renderTemplateAsync('worldInfoKeywordHeaders');
    let startPage = 1;

    if (navigation === navigation_option.previous) {
        startPage = $('#world_info_pagination').pagination('getCurrentPageNum');
    }

    if (typeof navigation === 'number' && Number(navigation) >= 0) {
        const uidIndex = entriesArray.findIndex(x => x.uid === navigation);
        startPage = Math.floor(uidIndex / perPage) + 1;
    }

    $('#world_info_pagination').pagination({
        dataSource: entriesArray,
        pageSize: perPage,
        sizeChangerOptions: [10, 25, 50, 100, 500, 1000],
        showSizeChanger: true,
        pageRange: 1,
        pageNumber: startPage,
        position: 'top',
        showPageNumbers: false,
        prevText: '<',
        nextText: '>',
        formatNavigator: PAGINATION_TEMPLATE,
        showNavigator: true,
        callback: async function (/** @type {object[]} */ page) {
            try {
                await renderWorldEntriesPage(worldEntriesList, name, data, page, renderPass, keywordHeaders);
            } catch (error) {
                console.error('Error while rendering WI entries:', error);
            }
        },
        afterSizeSelectorChange: function (e) {
            accountStorage.setItem(storageKey, e.target.value);
        },
    });

    if (typeof navigation === 'number' && Number(navigation) >= 0) {
        const selector = `#world_popup_entries_list [uid="${navigation}"]`;
        waitUntilCondition(() => document.querySelector(selector) !== null).finally(() => {
            const element = $(selector);

            if (element.length === 0) {
                console.log(`Could not find element for uid ${navigation}`);
                return;
            }

            const elementOffset = element.offset();
            const parentOffset = element.parent().offset();
            const scrollOffset = elementOffset.top - parentOffset.top;
            $('#WorldInfo').scrollTop(scrollOffset);
            if (flashOnNav) flashHighlight(element);
        });
    }

    $('#world_popup_new').off('click').on('click', () => {
        const entry = createWorldInfoEntry(name, data);
        if (entry) updateEditor(entry.uid);
    });

    $('#world_entries_select_page').off('click').on('click', function () {
        const pageUids = getCurrentWorldInfoEntryPageUids();
        if (pageUids.length === 0) {
            return;
        }

        const allSelected = pageUids.every((uid) => selectedWorldInfoEntryUids.has(uid));
        for (const uid of pageUids) {
            if (allSelected) {
                selectedWorldInfoEntryUids.delete(uid);
            } else {
                selectedWorldInfoEntryUids.add(uid);
            }
        }

        syncWorldInfoEntryBulkToolbar(name, data);
    });

    $('#world_entries_clear_selection').off('click').on('click', function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        resetWorldInfoEntrySelection(name);
        syncWorldInfoEntryBulkToolbar(name, data);
    });

    $('#world_entries_enable_selected').off('click').on('click', async function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        const changed = await applyBulkWorldInfoEntryEnabledState(name, data, getSelectedWorldInfoEntryUids(name, data), true);
        if (!changed) {
            return;
        }

        updateEditor(navigation_option.previous);
    });

    $('#world_entries_disable_selected').off('click').on('click', async function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        const changed = await applyBulkWorldInfoEntryEnabledState(name, data, getSelectedWorldInfoEntryUids(name, data), false);
        if (!changed) {
            return;
        }

        updateEditor(navigation_option.previous);
    });

    $('#world_entries_move_selected').off('click').on('click', async function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        const selectedUids = getSelectedWorldInfoEntryUids(name, data);
        if (selectedUids.length === 0) {
            return;
        }

        const previewName = selectedUids.length === 1
            ? (data.entries[selectedUids[0]]?.comment || String(selectedUids[0]))
            : '';
        const moveOptions = await promptWorldInfoEntryMoveTarget(name, {
            count: selectedUids.length,
            previewName,
        });
        if (!moveOptions) {
            return;
        }

        const moved = await moveWorldInfoEntries(name, moveOptions.targetName, selectedUids, { deleteOriginal: moveOptions.deleteOriginal });
        if (!moved) {
            return;
        }

        resetWorldInfoEntrySelection(name);
        syncWorldInfoEntryBulkToolbar(name, data);
    });

    $('#world_entries_bulk_set_field').off('click').on('click', function () {
        if ($(this).hasClass('disabled')) return;
        openBulkSetFieldMenu(name, data, this);
    });

    $('#world_entries_delete_selected').off('click').on('click', async function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        const deleted = await deleteWorldInfoEntriesWithUndo(name, data, getSelectedWorldInfoEntryUids(name, data));
        if (!deleted) {
            return;
        }
    });

    $('#world_popup_name_button').off('click').on('click', async () => {
        await renameWorldInfo(name, data);
    });

    $('#world_backfill_memos').off('click').on('click', async () => {
        let counter = 0;
        for (const entry of Object.values(data.entries)) {
            if (!entry.comment && Array.isArray(entry.key) && entry.key.length > 0) {
                entry.comment = entry.key.join(', ').slice(0, MAX_COMMENT_LENGTH);
                setWIOriginalDataValue(data, entry.uid, 'comment', entry.comment);
                counter++;
            }
        }

        if (counter > 0) {
            toastr.info(`Backfilled ${counter} titles`);
            await saveWorldInfo(name, data);
            updateEditor(navigation_option.previous);
        }
    });

    $('#world_apply_current_sorting').off('click').on('click', async () => {
        const entryCount = Object.keys(data.entries).length;
        const moreThan100 = entryCount > 100;

        let content = '<span>' + t`Apply your current sorting to the "Order" field. The Order values will go down from the chosen number.` + '</span>';
        if (moreThan100) {
            content += '<div class="m-t-1"><i class="fa-solid fa-triangle-exclamation" style="color: #FFD43B;"></i> ' + t`More than 100 entries in this world. If you don't choose a number higher than that, the lower entries will default to 0.<br />(Usual default: 100)<br />Minimum: ${entryCount}` + '</div>';
        }

        const result = await Popup.show.input(t`Apply Current Sorting`, content, '100', { okButton: t`Apply`, cancelButton: 'Cancel' });
        if (!result) return;

        const start = Number(result);
        if (isNaN(start) || start < 0) {
            toastr.error(t`Invalid number: ${result}`, t`Apply Current Sorting`);
            return;
        }
        if (start < entryCount) {
            toastr.warning(t`A number lower than the entry count has been chosen. All entries below that will default to 0.`, t`Apply Current Sorting`);
        }

        // We need to sort the entries here, as the data source isn't sorted
        const entries = Object.values(data.entries);
        sortWorldInfoEntries(entries);

        let updated = 0, current = start;
        for (const entry of entries) {
            const newOrder = Math.max(current--, 0);
            if (entry.order === newOrder) continue;

            entry.order = newOrder;
            setWIOriginalDataValue(data, entry.order, 'order', entry.order);
            updated++;
        }

        if (updated > 0) {
            toastr.info(`Updated ${updated} Order values`, 'Apply Custom Sorting');
            await saveWorldInfo(name, data, true);
            updateEditor(navigation_option.previous);
        } else {
            toastr.info('All values up to date', 'Apply Custom Sorting');
        }
    });

    $('#world_popup_export').off('click').on('click', () => {
        if (name && data) {
            const jsonValue = JSON.stringify(data);
            const fileName = `${name}.json`;
            download(jsonValue, fileName, 'application/json');
        }
    });

    $('#world_duplicate').off('click').on('click', async () => {
        // Find current name for the world selected
        const selectedIndex = String($('#world_editor_select').find(':selected').val());
        const worldName = world_names[selectedIndex] || null;

        // Use the current name as default input, then ask user for the name
        const tempName = getFreeWorldName(worldName);
        const finalName = await Popup.show.input('Create a new World Info?', 'Enter a name for the new file:', tempName);

        if (finalName) {
            await saveWorldInfo(finalName, data, true);
            await updateWorldInfoList();

            const selectedIndex = world_names.indexOf(finalName);
            if (selectedIndex !== -1) {
                $('#world_editor_select').val(selectedIndex).trigger('change');
            } else {
                await hideWorldEditor();
            }
        }
    });

    try {
        if (worldEntriesList.sortable('instance') !== undefined) {
            worldEntriesList.sortable('destroy');
        }
    } catch {
        // The list may not have an active sortable instance.
    }

    if (isCustomOrder) {
        installWorldInfoIndicatorDrag(worldEntriesList, name, data);
    } else {
        uninstallWorldInfoIndicatorDrag(worldEntriesList);
    }

    syncWorldInfoEntryBulkToolbar(name, data);
}

export const originalWIDataKeyMap = {
    'displayIndex': 'extensions.display_index',
    'excludeRecursion': 'extensions.exclude_recursion',
    'preventRecursion': 'extensions.prevent_recursion',
    'delayUntilRecursion': 'extensions.delay_until_recursion',
    'selectiveLogic': 'selectiveLogic',
    'comment': 'comment',
    'constant': 'constant',
    'order': 'insertion_order',
    'depth': 'extensions.depth',
    'probability': 'extensions.probability',
    'position': 'extensions.position',
    'role': 'extensions.role',
    'content': 'content',
    'enabled': 'enabled',
    'key': 'keys',
    'keysecondary': 'secondary_keys',
    'selective': 'selective',
    'matchWholeWords': 'extensions.match_whole_words',
    'useGroupScoring': 'extensions.use_group_scoring',
    'caseSensitive': 'extensions.case_sensitive',
    'matchPersonaDescription': 'extensions.match_persona_description',
    'matchCharacterDescription': 'extensions.match_character_description',
    'matchCharacterPersonality': 'extensions.match_character_personality',
    'matchCharacterDepthPrompt': 'extensions.match_character_depth_prompt',
    'matchScenario': 'extensions.match_scenario',
    'matchCreatorNotes': 'extensions.match_creator_notes',
    'scanDepth': 'extensions.scan_depth',
    'automationId': 'extensions.automation_id',
    'vectorized': 'extensions.vectorized',
    'groupOverride': 'extensions.group_override',
    'groupWeight': 'extensions.group_weight',
    'sticky': 'extensions.sticky',
    'cooldown': 'extensions.cooldown',
    'delay': 'extensions.delay',
    'triggers': 'extensions.triggers',
    'ignoreBudget': 'extensions.ignore_budget',
};

/** Checks the state of the current search, and adds/removes the search sorting option accordingly */
function verifyWorldInfoSearchSortRule() {
    const searchTerm = String(worldInfoFilter.getFilterData(FILTER_TYPES.WORLD_INFO_SEARCH) || '').trim();
    const searchOption = $('#world_info_sort_order option[data-rule="search"]');
    const selector = $('#world_info_sort_order');
    const isHidden = searchOption.attr('hidden') !== undefined;

    // If we have a search term, we are displaying the sorting option for it
    if (searchTerm && isHidden) {
        searchOption.removeAttr('hidden');
        selector.val(searchOption.attr('value') || '0');
        flashHighlight(selector);
    }
    // If search got cleared, we make sure to hide the option and go back to the one before
    if (!searchTerm && !isHidden) {
        searchOption.attr('hidden', '');
        selector.val(accountStorage.getItem(SORT_ORDER_KEY) || '0');
    }
}

/**
 * Sets the value of a specific key in the original data entry corresponding to the given uid
 * This needs to be called whenever you update JSON data fields.
 * Use `originalWIDataKeyMap` to find the correct value to be set.
 *
 * @param {object} data - The data object containing the original data entries.
 * @param {number} uid - The unique identifier of the data entry.
 * @param {string} key - The key of the value to be set.
 * @param {any} value - The value to be set.
 */
export function setWIOriginalDataValue(data, uid, key, value) {
    if (data.originalData && Array.isArray(data.originalData.entries)) {
        let originalEntry = data.originalData.entries.find(x => x.uid === uid);

        if (!originalEntry) {
            return;
        }

        setValueByPath(originalEntry, key, value);
    }
}

/**
 * Deletes the original data entry corresponding to the given uid from the provided data object
 *
 * @param {object} data - The data object containing the original data entries
 * @param {string} uid - The unique identifier of the data entry to be deleted
 */
export function deleteWIOriginalDataValue(data, uid) {
    if (data.originalData && Array.isArray(data.originalData.entries)) {
        // Non-strict equality is used here to allow for both string and number comparisons
        // @eslint-disable-next-line eqeqeq
        const originalIndex = data.originalData.entries.findIndex(x => x.uid == uid);

        if (originalIndex >= 0) {
            data.originalData.entries.splice(originalIndex, 1);
        }
    }
}

/** @typedef {import('./utils.js').Select2Option} Select2Option */

/**
 * Splits a given input string that contains one or more keywords or regexes, separated by commas.
 *
 * Each part can be a valid regex following the pattern `/myregex/flags` with optional flags. Commas inside the regex are allowed, slashes have to be escaped like this: `\/`
 * If a regex doesn't stand alone, it is not treated as a regex.
 *
 * @param {string} input - One or multiple keywords or regexes, separated by commas
 * @returns {string[]} An array of keywords and regexes
 */
export function splitKeywordsAndRegexes(input) {
    /** @type {string[]} */
    let keywordsAndRegexes = [];

    // We can make this easy. Instead of writing another function to find and parse regexes,
    // we gonna utilize the custom tokenizer that also handles the input.
    // No need for validation here
    const addFindCallback = (/** @type {Select2Option} */ item) => {
        keywordsAndRegexes.push(item.text);
    };

    const { term } = customTokenizer({ _type: 'custom_call', term: input }, undefined, addFindCallback);
    const finalTerm = term.trim();
    if (finalTerm) {
        addFindCallback({ id: getSelect2OptionId(finalTerm), text: finalTerm });
    }

    return keywordsAndRegexes;
}

/**
 * Tokenizer parsing input and splitting it into keywords and regexes
 *
 * @param {{_type: string, term: string}} input - The typed input
 * @param {{options: object}} _selection - The selection even object (?)
 * @param {function(Select2Option):void} callback - The original callback function to call if an item should be inserted
 * @returns {{term: string}} - The remaining part that is untokenized in the textbox
 */
function customTokenizer(input, _selection, callback) {
    let current = input.term;

    let insideRegex = false, regexClosed = false;

    // Go over the input and check the current state, if we can get a token
    for (let i = 0; i < current.length; i++) {
        let char = current[i];

        // If we find an unascaped slash, set the current regex state
        if (char === '/' && (i === 0 || current[i - 1] !== '\\')) {
            if (!insideRegex) insideRegex = true;
            else if (!regexClosed) regexClosed = true;
        }

        // If a comma is typed, we tokenize the input.
        // unless we are inside a possible regex, which would allow commas inside
        if (char === ',') {
            // We take everything up till now and consider this a token
            const token = current.slice(0, i).trim();

            // Now how we test if this is a regex? And not a finished one, but a half-finished one?
            // We use the state remembered from above to check whether the delimiter was opened but not closed yet.
            // We don't check validity here if we are inside a regex, because it might only get valid after its finished. (Closing brackets, etc)
            // Validity will be finally checked when the next comma is typed.
            if (insideRegex && !regexClosed) {
                continue;
            }

            // So now the comma really means the token is done.
            // We take the token up till now, and insert it. Empty will be skipped.
            if (token) {
                const isRegex = isValidRegex(token);

                // Last chance to check for valid regex again. Because it might have been valid while typing, but now is not valid anymore and contains commas we need to split.
                if (token.startsWith('/') && !isRegex) {
                    const tokens = token.split(',').map(x => x.trim());
                    tokens.forEach(x => callback({ id: getSelect2OptionId(x), text: x }));
                } else {
                    callback({ id: getSelect2OptionId(token), text: token });
                }
            }

            // Now remove the token from the current input, and the comma too
            current = current.slice(i + 1);
            insideRegex = false;
            regexClosed = false;
            i = 0;
        }
    }

    // At the end, just return the left-over input
    return { term: current };
}

/**
 * Validates if a string is a valid slash-delimited regex, that can be parsed and executed
 *
 * This is a wrapper around `parseRegexFromString`
 *
 * @param {string} input - A delimited regex string
 * @returns {boolean} Whether this would be a valid regex that can be parsed and executed
 */
function isValidRegex(input) {
    return parseRegexFromString(input) !== null;
}

/**
 * Gets a real regex object from a slash-delimited regex string
 *
 * This function works with `/` as delimiter, and each occurance of it inside the regex has to be escaped.
 * Flags are optional, but can only be valid flags supported by JavaScript's `RegExp` (`g`, `i`, `m`, `s`, `u`, `y`).
 *
 * @param {string} input - A delimited regex string
 * @returns {RegExp|null} The regex object, or null if not a valid regex
 */
export function parseRegexFromString(input) {
    // Extracting the regex pattern and flags
    let match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) {
        return null; // Not a valid regex format
    }

    let [, pattern, flags] = match;

    // If we find any unescaped slash delimiter, we also exit out.
    // JS doesn't care about delimiters inside regex patterns, but for this to be a valid regex outside of our implementation,
    // we have to make sure that our delimiter is correctly escaped. Or every other engine would fail.
    if (pattern.match(/(^|[^\\])\//)) {
        return null;
    }

    // Now we need to actually unescape the slash delimiters, because JS doesn't care about delimiters
    pattern = pattern.replace('\\/', '/');

    // Then we return the regex. If it fails, it was invalid syntax.
    try {
        return new RegExp(pattern, flags);
    } catch (e) {
        return null;
    }
}

/**
 * Enables the input helper for keys in a World Info entry.
 * @param {object} params - Parameters for enabling the keys input helper.
 * @param {JQuery<HTMLElement>} params.template - The template element containing the input.
 * @param {object} params.entry - The entry object containing the keys.
 * @param {string} params.entryPropName - The property name of the entry that holds the keys.
 * @param {string} params.originalDataValueName - The name of the original data value to be set.
 * @param {string} params.name - The name of the world info entry.
 * @param {object} params.data - The data object containing entries.
 */
function enableKeysInputHelper({ template, entry, entryPropName, originalDataValueName, name, data }) {
    const isFancyInput = !isMobile() && !power_user.wi_key_input_plaintext;
    const input = isFancyInput ? template.find(`select[name="${entryPropName}"]`) : template.find(`textarea[name="${entryPropName}"]`);
    input.data('uid', entry.uid);
    input[0].dataset.macros = ''; // active
    input.on('click', function (event) {
        event.stopPropagation();
    });

    function templateStyling(item, { searchStyle = false } = {}) {
        const content = $('<span>').addClass('item').text(item.text).attr('title', `${item.text}\n\nClick to edit`);
        const isRegex = isValidRegex(item.text);
        if (isRegex) {
            content.html(highlightRegex(item.text));
            content.addClass('regex_item').prepend($('<span>').addClass('regex_icon').text('•*').attr('title', 'Regex'));
        }
        if (searchStyle && item.count) {
            const wrapper = $('<span>').addClass('result_block').append(content);
            wrapper.append($('<span>').addClass('item_count').text(item.count).attr('title', `Used as a key ${item.count} ${item.count != 1 ? 'times' : 'time'} in this lorebook`));
            return wrapper;
        }
        return content;
    }

    if (isFancyInput) {
        select2ModifyOptions(input, entry[entryPropName], { select: true, changeEventArgs: { skipReset: true, noSave: true } });
        input.select2({
            ajax: dynamicSelect2DataViaAjax(() => worldEntryKeyOptionsCache),
            tags: true,
            tokenSeparators: [','],
            // @ts-ignore
            tokenizer: customTokenizer,
            placeholder: input.attr('placeholder'),
            templateResult: item => templateStyling(item, { searchStyle: true }),
            templateSelection: item => templateStyling(item),
        });

        // TypeScript-safe event handler
        /**
         * @param {Event} _event
         * @param {{ skipReset?: boolean, noSave?: boolean }} [arg]
         */
        input.on('change', async function (_event, arg) {
            const uid = $(this).data('uid');
            const keys = ($(this).select2('data')).map(x => x.text);
            const skipReset = arg?.skipReset ?? false;
            const noSave = arg?.noSave ?? false;
            if (!skipReset) await resetScrollHeight(this);
            if (!noSave) {
                data.entries[uid][entryPropName] = keys;
                setWIOriginalDataValue(data, uid, originalDataValueName, data.entries[uid][entryPropName]);
                await saveWorldInfo(name, data);
            }
            $(this).toggleClass('empty', !data.entries[uid][entryPropName].length);
            // Update the commentInput's placeholder for primary keys
            if (entryPropName === 'key') {
                const commentInput = $(_event.currentTarget).closest('.world_entry_form').find('textarea[name="comment"]');
                setCommentPlaceholder(data.entries[uid][entryPropName].join(', '), commentInput);
            }
        });

        input.toggleClass('empty', !entry[entryPropName].length);
        input.on('select2:select', event => updateWorldEntryKeyOptionsCache([event.params.data]));
        input.on('select2:unselect', event => updateWorldEntryKeyOptionsCache([event.params.data], { remove: true }));

        select2ChoiceClickSubscribe(input, target => {
            const key = $(target.closest('.regex-highlight, .item')).text();
            const selected = input.val();
            if (!Array.isArray(selected)) return;
            var index = selected.indexOf(getSelect2OptionId(key));
            if (index > -1) selected.splice(index, 1);
            input.val(selected).trigger('change');
            updateWorldEntryKeyOptionsCache([key], { remove: true });
            input.next('span.select2-container').find('textarea').val(key).trigger('input');
        }, { openDrawer: true });
    } else {
        template.find(`select[name="${entryPropName}"]`).hide();
        input.show();
        /**
        * @param {Event} _event
        * @param {{ skipReset?: boolean, noSave?: boolean }} [arg]
        */
        input.on('change', async function (_event, arg) {
            const uid = $(this).data('uid');
            const value = String($(this).val());
            const skipReset = arg?.skipReset ?? false;
            const noSave = arg?.noSave ?? false;
            if (!skipReset) await resetScrollHeight(this);
            if (!noSave) {
                data.entries[uid][entryPropName] = splitKeywordsAndRegexes(value);
                setWIOriginalDataValue(data, uid, originalDataValueName, data.entries[uid][entryPropName]);
                await saveWorldInfo(name, data);
                $(this).toggleClass('empty', !data.entries[uid][entryPropName].length);
            }
            // Update the commentInput's placeholder for primary keys
            if (entryPropName === 'key') {
                const commentInput = $(_event.currentTarget).closest('.world_entry_form').find('textarea[name="comment"]');
                setCommentPlaceholder(value, commentInput);
            }
        });
        input.val(entry[entryPropName].join(', ')).trigger('input', { skipReset: true });
    }
    return { isFancy: isFancyInput, control: input };
}

/**
 * Helper to handle match checkboxes for WI entries.
 * @param {object} params - Parameters for handling match checkboxes.
 * @param {JQuery<HTMLElement>} params.template - The template element containing the checkbox.
 * @param {object} params.entry - The entry object containing the checkbox state.
 * @param {string} params.fieldName - The name of the checkbox field.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 */
function handleMatchCheckboxHelper({ template, entry, fieldName, data, name }) {
    const key = originalWIDataKeyMap[fieldName];
    const checkBoxElem = template.find(`input[type="checkbox"][name="${fieldName}"]`);
    checkBoxElem.data('uid', entry.uid);
    checkBoxElem.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = $(this).prop('checked');
        data.entries[uid][fieldName] = value;
        setWIOriginalDataValue(data, uid, key, data.entries[uid][fieldName]);
        !noSave && await saveWorldInfo(name, data);
    });
    checkBoxElem.prop('checked', !!entry[fieldName]).trigger('input', { noSave: true });
}

/**
 * Helper to update position/order display.
 * @param {object} params - Parameters for updating position/order display.
 * @param {JQuery<HTMLElement>} params.template - The template element containing the display.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.uid - The unique identifier of the entry to update.
 */
function updatePosOrdDisplayHelper({ template, data, uid }) {
    let entry = data.entries[uid];
    let posText = entry.position;
    switch (entry.position) {
        case 0: posText = '↑CD'; break;
        case 1: posText = 'CD↓'; break;
        case 2: posText = '↑AN'; break;
        case 3: posText = 'AN↓'; break;
        case 4: posText = `@D${entry.depth}`; break;
    }
    template.find('.world_entry_form_position_value').text(`(${posText} ${entry.order})`);
}

/**
 * Helper to initialize character filter select2.
 * @param {JQuery<HTMLElement>} characterFilter - The select element for character filter.
 */
function initCharacterFilterSelect2Helper(characterFilter) {
    if (!isMobile()) {
        $(characterFilter).select2({
            width: '100%',
            placeholder: t`Tie this entry to specific characters or characters with specific tags`,
            allowClear: true,
            closeOnSelect: false,
        });
    }
}

/**
 * Helper to fill character and tag options for character filter.
 * @param {object} params - Parameters for filling options.
 * @param {JQuery<HTMLElement>} params.characterFilter - The select element to fill with options.
 * @param {object} params.entry - The entry object containing character filter data.
 */
function fillCharacterAndTagOptionsHelper({ characterFilter, entry }) {
    const characters = getContext().characters;
    characters.forEach((character) => {
        const option = document.createElement('option');
        const name = character.avatar.replace(/\.[^/.]+$/, '') ?? character.name;
        option.innerText = name;
        option.selected = entry.characterFilter?.names?.includes(name);
        option.setAttribute('data-type', 'character');
        characterFilter.append(option);
    });
    const tags = getContext().tags;
    tags.forEach((tag) => {
        const option = document.createElement('option');
        option.innerText = `[Tag] ${tag.name}`;
        option.selected = entry.characterFilter?.tags?.includes(tag.id);
        option.value = tag.id;
        option.setAttribute('data-type', 'tag');
        characterFilter.append(option);
    });
}

/**
 * Helper to handle character filter changes.
 * @param {object} params - Parameters for handling character filter changes.
 * @param {JQuery<HTMLElement>} params.characterFilter - The select element for character filter.
 * @param {object} params.data - The data object containing entries.
 * @param {object} params.entry - The entry object to update.
 * @param {string} params.name - The name of the world info to save changes to.
 */
function handleCharacterFilterChangeHelper({ characterFilter, data, entry, name }) {
    characterFilter.on('mousedown change', async function (e) {
        if (world_names.length === 0) {
            e.preventDefault();
            return;
        }
        const uid = $(this).data('uid');
        const selected = $(this).find(':selected');
        if ((!selected || selected?.length === 0) && !data.entries[uid].characterFilter?.isExclude) {
            delete data.entries[uid].characterFilter;
        } else {
            const names = selected.filter('[data-type="character"]').map((_, e) => e instanceof HTMLOptionElement && e.innerText).toArray();
            const tags = selected.filter('[data-type="tag"]').map((_, e) => e instanceof HTMLOptionElement && e.value).toArray();
            Object.assign(
                data.entries[uid],
                {
                    characterFilter: {
                        isExclude: data.entries[uid].characterFilter?.isExclude ?? false,
                        names: names,
                        tags: tags,
                    },
                },
            );
        }
        setWIOriginalDataValue(data, uid, 'character_filter', data.entries[uid].characterFilter);
        await saveWorldInfo(name, data);
    });
}

/**
 * Helper to handle probability input.
 * @param {object} params - Parameters for handling probability input.
 * @param {JQuery<HTMLElement>} params.probabilityInput - The input element for probability.
 * @param {object} params.data - The data object containing entries.
 * @param {object} params.entry - The entry object to update.
 * @param {string} params.name - The name of the world info to save changes to.
 */
function handleProbabilityInputHelper({ probabilityInput, data, entry, name }) {
    probabilityInput.data('uid', entry.uid);
    probabilityInput.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = Number($(this).val());
        data.entries[uid].probability = !isNaN(value) ? value : null;
        if (data.entries[uid].probability !== null) {
            data.entries[uid].probability = Math.min(100, Math.max(0, data.entries[uid].probability));
            if (data.entries[uid].probability !== value) {
                $(this).val(data.entries[uid].probability);
            }
        }
        setWIOriginalDataValue(data, uid, 'extensions.probability', data.entries[uid].probability);
        !noSave && await saveWorldInfo(name, data);
    });
    probabilityInput.val(entry.probability).trigger('input', { noSave: true });
    probabilityInput.css('width', 'calc(3em + 15px)');
}

/**
 * Helper to handle probability toggle.
 * @param {object} params - Parameters for handling probability toggle.
 * @param {JQuery<HTMLElement>} params.probabilityToggle - The toggle element for probability.
 * @param {object} params.data - The data object containing entries.
 * @param {object} params.entry - The entry object to update.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {JQuery<HTMLElement>} params.probabilityInput - The input element for probability.
 */
function handleProbabilityToggleHelper({ probabilityToggle, data, entry, name, probabilityInput }) {
    probabilityToggle.data('uid', entry.uid);
    probabilityToggle.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = $(this).prop('checked');
        data.entries[uid].useProbability = value;
        const probabilityContainer = $(this).closest('.world_entry').find('.probabilityContainer');
        !noSave && await saveWorldInfo(name, data);
        value ? probabilityContainer.show() : probabilityContainer.hide();
        if (value && data.entries[uid].probability === null) {
            data.entries[uid].probability = 100;
        }
        if (!value) {
            data.entries[uid].probability = null;
        }
        probabilityInput.val(data.entries[uid].probability).trigger('input', { noSave });
    });
    probabilityToggle.prop('checked', true).trigger('input', { noSave: true });
    probabilityToggle.parent().hide();
}

/**
 * Helper to handle select2 dropdowns for boolean selects.
 * @param {object} params - Parameters for handling boolean selects.
 * @param {JQuery<HTMLElement>} params.selectElem - The select element for boolean values.
 * @param {object} params.entry - The entry object containing the boolean value.
 * @param {string} params.entryKey - The key in the entry object for the boolean value.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 */
function handleBooleanSelectHelper({ selectElem, entry, entryKey, data, name }) {
    selectElem.data('uid', entry.uid);
    selectElem.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = $(this).val();
        data.entries[uid][entryKey] = value === 'null' ? null : value === 'true';
        setWIOriginalDataValue(data, uid, `extensions.${entryKey.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)}`, data.entries[uid][entryKey]);
        !noSave && await saveWorldInfo(name, data);
    });
    selectElem.val((entry[entryKey] === null || entry[entryKey] === undefined) ? 'null' : entry[entryKey] ? 'true' : 'false').trigger('input', { noSave: true });
}

/**
 * Helper to handle input fields for numbers.
 * @param {object} params - Parameters for handling number inputs.
 * @param {JQuery<HTMLElement>} params.inputElem - The input element for the number.
 * @param {object} params.entry - The entry object containing the number value.
 * @param {string} params.entryKey - The key in the entry object for the number value.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {number} params.min - The minimum value for the number input.
 * @param {number} params.max - The maximum value for the number input.
 * @param {boolean} [params.clamp=false] - Whether to clamp the value within the min and max range.
 */
function handleNumberInputHelper({ inputElem, entry, entryKey, data, name, min, max, clamp = false }) {
    inputElem.data('uid', entry.uid);
    inputElem.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        let value = Number($(this).val());
        if (clamp) {
            if (value < min) {
                value = min;
                $(this).val(min);
            } else if (value > max) {
                value = max;
                $(this).val(max);
            }
        }
        data.entries[uid][entryKey] = !isNaN(value) ? value : null;
        setWIOriginalDataValue(data, uid, `extensions.${entryKey.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)}`, data.entries[uid][entryKey]);
        !noSave && await saveWorldInfo(name, data);
    });
    inputElem.val(entry[entryKey] ?? (clamp ? min : '')).trigger('input', { noSave: true });
}

/**
 * Helper to handle tri-state selector for constant/normal/vectorized.
 * @param {object} params - Parameters for handling the entry state selector.
 * @param {JQuery<HTMLElement>} params.entryStateSelector - The select element for entry state.
 * @param {object} params.entry - The entry object containing the state.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 */
function handleEntryStateSelectorHelper({ entryStateSelector, entry, data, name }) {
    entryStateSelector.data('uid', entry.uid);
    entryStateSelector.on('click', function (event) {
        event.stopPropagation();
    });
    entryStateSelector.on('input', async function (_, { noSave = false } = {}) {
        const uid = entry.uid;
        const value = $(this).val();
        switch (value) {
            case 'constant':
                data.entries[uid].constant = true;
                data.entries[uid].vectorized = false;
                setWIOriginalDataValue(data, uid, 'constant', true);
                setWIOriginalDataValue(data, uid, 'extensions.vectorized', false);
                break;
            case 'normal':
                data.entries[uid].constant = false;
                data.entries[uid].vectorized = false;
                setWIOriginalDataValue(data, uid, 'constant', false);
                setWIOriginalDataValue(data, uid, 'extensions.vectorized', false);
                break;
            case 'vectorized':
                data.entries[uid].constant = false;
                data.entries[uid].vectorized = true;
                setWIOriginalDataValue(data, uid, 'constant', false);
                setWIOriginalDataValue(data, uid, 'extensions.vectorized', true);
                break;
        }
        !noSave && await saveWorldInfo(name, data);
    });
    const entryState = () => entry.constant === true ? 'constant' : entry.vectorized === true ? 'vectorized' : 'normal';
    entryStateSelector.find(`option[value=${entryState()}]`).prop('selected', true).trigger('input', { noSave: true });
}

/**
 * Helper to handle kill switch toggle.
 * @param {object} params - Parameters for handling the kill switch toggle.
 * @param {JQuery<HTMLElement>} params.entryKillSwitch - The toggle element for the kill switch.
 * @param {object} params.entry - The entry object containing the state.
 * @param {object} params.data - The data object containing entries.
 * @param {string} params.name - The name of the world info to save changes to.
 * @param {JQuery<HTMLElement>} params.template - The template element for the entry.
 */
function handleEntryKillSwitchHelper({ entryKillSwitch, entry, data, name, template }) {
    entryKillSwitch.data('uid', entry.uid);
    entryKillSwitch.on('click', async function () {
        const uid = entry.uid;
        data.entries[uid].disable = !data.entries[uid].disable;
        const isActive = !data.entries[uid].disable;
        setWIOriginalDataValue(data, uid, 'enabled', isActive);
        template.toggleClass('disabledWIEntry', !isActive);
        entryKillSwitch.toggleClass('fa-toggle-off', !isActive);
        entryKillSwitch.toggleClass('fa-toggle-on', isActive);
        await saveWorldInfo(name, data);
    });
    const isActive = !entry.disable;
    template.toggleClass('disabledWIEntry', !isActive);
    entryKillSwitch.toggleClass('fa-toggle-off', !isActive);
    entryKillSwitch.toggleClass('fa-toggle-on', isActive);
}

/**
 * Update commentInput's placeholder.
 * @param {string} keys Text to display in commentInput's placeholder.
 * @param {JQuery<HTMLElement>} commentInput The comment input element.
 */
function setCommentPlaceholder(keys, commentInput) {
    // Limit placeholder text to avoid performance issues.
    keys = keys.slice(0, MAX_COMMENT_LENGTH);
    commentInput.attr('placeholder', (keys || t`Entry Title/Memo`));
}

async function showActivationTracePopup(worldName, uid) {
    const scopeKey = getActivationTraceScopeKey();
    const trace = getEntryActivationTrace(scopeKey, worldName, uid);
    const hasTrace = trace && (
        (Array.isArray(trace.recentScans) && trace.recentScans.length > 0) ||
        (Array.isArray(trace.recentDryRunScans) && trace.recentDryRunScans.length > 0)
    );

    if (!hasTrace) {
        await callGenericPopup(
            `<div style="max-width:900px;"><h4>${escapeHtmlText(t`No activation trace yet`)}</h4><p>${escapeHtmlText(t`Generate at least one reply in this chat, then check again.`)}</p></div>`,
            POPUP_TYPE.TEXT,
            t`Lorebook Activation Trace`,
            { wide: true, large: true, allowVerticalScrolling: true },
        );
        return;
    }

    const recentScans = Array.isArray(trace.recentScans) ? trace.recentScans : [];
    const recentDryRunScans = Array.isArray(trace.recentDryRunScans) ? trace.recentDryRunScans : [];
    const hasRealScans = recentScans.length > 0;
    const displayScans = hasRealScans ? recentScans : recentDryRunScans;
    const dedupedDisplayScans = collapseConsecutiveDuplicateScans(displayScans);
    const usingDryRunFallback = !hasRealScans && displayScans.length > 0;
    const lastActivation = trace.lastActivation || null;
    const fallbackDryActivation = trace.lastDryRunActivation || null;
    const effectiveActivation = lastActivation || (usingDryRunFallback ? fallbackDryActivation : null);
    const scanCards = dedupedDisplayScans.map((entry, scanIndex) => {
        const scan = entry.scan;
        const attempts = Array.isArray(scan?.attempts) ? scan.attempts : [];
        const activated = Boolean(scan?.activated);
        const isDryRunScan = Boolean(scan?.dryRun);
        const attemptHtml = attempts.length > 0
            ? attempts.map((attempt, attemptIndex) => {
                const details = attempt?.details && typeof attempt.details === 'object' ? attempt.details : {};
                const reasonText = explainTraceReason(attempt?.reason, details);
                return `
<div style="border:1px solid var(--SmartThemeBorderColor);border-radius:8px;padding:8px;margin-top:6px;">
    <div style="font-weight:600;">#${attemptIndex + 1} ${escapeHtmlText(reasonText)}</div>
    <div style="opacity:.75;">${escapeHtmlText(t`Scan loop`)}: ${escapeHtmlText(String(attempt?.loop ?? 'N/A'))} · ${escapeHtmlText(t`Scan phase`)}: ${escapeHtmlText(explainTraceScanState(attempt?.scanState))}</div>
    ${renderTraceDetailLines(details)}
</div>`;
            }).join('')
            : `<div style="opacity:.75;">${escapeHtmlText(t`No activation attempts recorded in this scan.`)}</div>`;

        const activationSummary = scan?.lastActivation
            ? explainTraceReason(scan.lastActivation?.details?.reason, scan.lastActivation?.details || {})
            : (activated ? t`Activated` : t`Not activated`);
        return `
<div style="border:1px solid var(--SmartThemeBorderColor);border-radius:10px;padding:10px;margin-top:10px;">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
        <div style="font-weight:700;">${escapeHtmlText(t`Scan`)} #${scanIndex + 1}</div>
        <div style="opacity:.78;">${escapeHtmlText(formatTraceTime(entry.newestAt))}</div>
    </div>
    ${entry.repeatCount > 1
        ? `<div style="margin-top:4px;opacity:.82;">${escapeHtmlText(t`Merged identical scans`)} ×${escapeHtmlText(String(entry.repeatCount))}</div>`
        : ''}
    ${isDryRunScan ? `<div style="margin-top:4px;opacity:.8;">${escapeHtmlText(t`Simulated activation (dry run)`)}.</div>` : ''}
    <div style="margin-top:4px;">
        <span style="font-weight:600;color:${activated ? 'var(--SmartThemeQuoteColor)' : 'var(--SmartThemeBodyColor)'};">
            ${activated ? escapeHtmlText(t`Activated`) : escapeHtmlText(t`Not activated`)}
        </span>
        <span style="opacity:.9;"> · ${escapeHtmlText(activationSummary)}</span>
    </div>
    <div style="margin-top:8px;">${attemptHtml}</div>
</div>`;
    }).join('');

    const html = `
<div style="max-width:1100px;">
    <h4>${escapeHtmlText(t`Lorebook Activation Trace`)}</h4>
    <div style="opacity:0.8;">${escapeHtmlText(t`Scope`)}: ${escapeHtmlText(scopeKey)}</div>
    <div style="opacity:0.8;">${escapeHtmlText(t`Entry`)}: ${escapeHtmlText(`${trace.world}.${trace.uid}`)}</div>
    <div style="opacity:0.8;">${escapeHtmlText(t`Last activated at`)}: ${escapeHtmlText(formatTraceTime(trace.lastActivatedAt || (usingDryRunFallback ? trace.lastDryRunScanAt : null)))}</div>
    <div style="margin-top:6px;font-weight:600;">${escapeHtmlText(t`Last activation reason`)}: ${escapeHtmlText(effectiveActivation ? explainTraceReason(effectiveActivation?.details?.reason, effectiveActivation?.details || {}) : t`N/A`)}</div>
    ${effectiveActivation ? `<div style="margin-top:6px;">${renderTraceDetailLines(effectiveActivation.details || {})}</div>` : ''}
    ${usingDryRunFallback ? `<div style="margin-top:8px;opacity:.8;">${escapeHtmlText(t`No real generation trace yet. Showing simulated activation from dry run.`)}</div>` : ''}
    <hr style="margin:12px 0;">
    <div style="font-weight:700;">${escapeHtmlText(hasRealScans ? t`Recent scans` : t`Recent simulated scans`)}</div>
    <div style="max-height:68vh;overflow:auto;padding-right:4px;">
        ${scanCards || `<div style="opacity:.75;">${escapeHtmlText(t`No scan records yet.`)}</div>`}
    </div>
</div>`;
    await callGenericPopup(
        html,
        POPUP_TYPE.TEXT,
        t`Lorebook Activation Trace`,
        { wide: true, large: true, allowVerticalScrolling: true },
    );
}

/**
 * Main function to build the WI entry editor template.
 * @param {string} name - The name of the world info file.
 * @param {object} data - The world info data object.
 * @param {object} entry - The entry object to be edited.
 */
export async function getWorldEntry(name, data, entry) {
    if (!data.entries[entry.uid]) return;

    const headerTemplate = WI_ENTRY_HEADER_TEMPLATE.clone();
    headerTemplate.data('uid', entry.uid);
    headerTemplate.attr('uid', entry.uid);
    ensureWorldInfoEntrySelectionContext(name);

    const entrySelectInput = headerTemplate.find('.world_entry_select');
    const entrySelectLabel = headerTemplate.find('.world_entry_select_label');
    const syncEntrySelectionState = () => {
        const isSelected = selectedWorldInfoEntryUids.has(String(entry.uid));
        entrySelectInput.prop('checked', isSelected);
        headerTemplate.toggleClass('bulk-selected', isSelected);
    };
    syncEntrySelectionState();
    entrySelectLabel.on('click', (event) => event.stopPropagation());
    entrySelectInput.on('click', (event) => event.stopPropagation());
    entrySelectInput.on('change', function (event) {
        event.stopPropagation();
        setWorldInfoEntrySelected(name, entry.uid, $(this).prop('checked'), data);
    });

    if (typeof power_user.wi_key_input_plaintext === 'undefined') power_user.wi_key_input_plaintext = true;

    // Comment
    const commentInput = headerTemplate.find('textarea[name="comment"]');

    //Update the commentInput's placeholder.
    const keys = entry.key.join(', ');
    setCommentPlaceholder(keys, commentInput);

    commentInput.data('uid', entry.uid);
    commentInput.on('input', async function (_, { skipReset = false, noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = $(this).val();
        !skipReset && await resetWorldInfoTextareaHeight(this);
        data.entries[uid].comment = value;
        setWIOriginalDataValue(data, uid, 'comment', data.entries[uid].comment);
        !noSave && await saveWorldInfo(name, data);
    });
    commentInput.val(entry.comment).trigger('input', { skipReset: true, noSave: true });

    // Order
    const orderInput = headerTemplate.find('input[name="order"]');
    orderInput.data('uid', entry.uid);
    orderInput.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = Number($(this).val());
        data.entries[uid].order = !isNaN(value) ? value : 0;
        updatePosOrdDisplayHelper({ template: headerTemplate, data, uid });
        setWIOriginalDataValue(data, uid, 'insertion_order', data.entries[uid].order);
        !noSave && await saveWorldInfo(name, data);
    });
    orderInput.val(entry.order).trigger('input', { noSave: true });
    orderInput.css('width', 'calc(3em + 15px)');

    // Probability
    handleProbabilityInputHelper({ probabilityInput: headerTemplate.find('input[name="probability"]'), data, entry, name });

    // Depth
    handleNumberInputHelper({
        inputElem: headerTemplate.find('input[name="depth"]'),
        entry, entryKey: 'depth', data, name, min: 0, max: MAX_SCAN_DEPTH, clamp: false,
    });
    headerTemplate.find('input[name="depth"]').css('width', 'calc(3em + 15px)');

    // Position
    if (entry.position === undefined) entry.position = 0;
    const positionInput = headerTemplate.find('select[name="position"]');
    positionInput.data('uid', entry.uid);
    positionInput.on('click', e => e.stopPropagation());
    positionInput.on('input', async function (_, { noSave = false } = {}) {
        const uid = $(this).data('uid');
        const value = Number($(this).val());
        data.entries[uid].position = !isNaN(value) ? value : 0;
        const depthInput = headerTemplate.find('input[name="depth"]');
        if (value === world_info_position.atDepth) {
            depthInput.prop('disabled', false);
            depthInput.css('visibility', 'visible');
            const role = Number($(this).find(':selected').data('role'));
            data.entries[uid].role = role;
        } else {
            depthInput.prop('disabled', true);
            depthInput.css('visibility', 'hidden');
            data.entries[uid].role = null;
        }
        updatePosOrdDisplayHelper({ template: headerTemplate, data, uid });
        setWIOriginalDataValue(data, uid, 'position', data.entries[uid].position == 0 ? 'before_char' : 'after_char');
        setWIOriginalDataValue(data, uid, 'extensions.position', data.entries[uid].position);
        setWIOriginalDataValue(data, uid, 'extensions.role', data.entries[uid].role);
        !noSave && await saveWorldInfo(name, data);
    });
    const roleValue = entry.position === world_info_position.atDepth ? String(entry.role ?? extension_prompt_roles.SYSTEM) : '';
    headerTemplate.find(`select[name="position"] option[value="${entry.position}"][data-role="${roleValue}"]`).prop('selected', true).trigger('input', { noSave: true });

    // Tri-state selector
    handleEntryStateSelectorHelper({
        entryStateSelector: headerTemplate.find('select[name="entryStateSelector"]'),
        entry, data, name,
    });

    // Kill switch
    handleEntryKillSwitchHelper({
        entryKillSwitch: headerTemplate.find('div[name="entryKillSwitch"]'),
        entry, data, name, template: headerTemplate,
    });

    // Duplicate/delete/move buttons
    headerTemplate.find('.duplicate_entry_button').data('uid', entry.uid).on('click', async function () {
        const uid = $(this).data('uid');
        const entryDup = duplicateWorldInfoEntry(data, uid);
        if (entryDup) {
            await saveWorldInfo(name, data);
            updateEditor(entryDup.uid);
        }
    });
    headerTemplate.find('.delete_entry_button').data('uid', entry.uid).on('click', async function (e) {
        e.stopPropagation();
        const uid = $(this).data('uid');
        const deleted = await deleteWorldInfoEntriesWithUndo(name, data, [uid]);
        if (!deleted) return;
    });
    headerTemplate.find('.move_entry_button').attr('data-uid', entry.uid).attr('data-current-world', name).on('click', async function (e) {
        e.stopPropagation();
        const sourceUid = $(this).attr('data-uid');
        const sourceWorld = $(this).attr('data-current-world');
        const sourceWorldInfo = await loadWorldInfo(sourceWorld);
        if (!sourceWorldInfo) return;
        const sourceName = sourceWorldInfo.entries[sourceUid]?.comment;
        if (sourceName === undefined) return;
        const moveOptions = await promptWorldInfoEntryMoveTarget(sourceWorld, { previewName: sourceName });
        if (!moveOptions) {
            return;
        }
        const moved = await moveWorldInfoEntry(sourceWorld, moveOptions.targetName, sourceUid, { deleteOriginal: moveOptions.deleteOriginal });
        if (moved) {
            selectedWorldInfoEntryUids.delete(String(sourceUid));
            syncWorldInfoEntryBulkToolbar(name, data);
        }
    });
    const traceButton = $(
        `<i class="menu_button trace_activation_button fa-solid fa-route" title="${escapeHtmlText(t`Trace activation source`)}"></i>`,
    );
    traceButton.on('click', async function (e) {
        e.stopPropagation();
        await showActivationTracePopup(name, entry.uid);
    });
    headerTemplate.find('.delete_entry_button').after(traceButton);

    const drawerEl = headerTemplate.find('.inline-drawer');
    const editOutlet = headerTemplate.find('.inline-drawer-outlet');
    let drawerInitialized = false;
    let drawerBuildQueued = false;
    let drawerBuildToken = 0;
    let drawerDestroyTimeout = null;

    function clearDrawerDestroyTimeout() {
        if (!drawerDestroyTimeout) {
            return;
        }

        clearTimeout(drawerDestroyTimeout);
        drawerDestroyTimeout = null;
    }

    function scheduleDrawerBuild() {
        if (drawerInitialized || drawerBuildQueued) {
            return;
        }

        const drawerNode = drawerEl.get(0);
        if (!(drawerNode instanceof HTMLElement)) {
            return;
        }

        drawerBuildQueued = true;
        const buildToken = ++drawerBuildToken;
        const reserveHeight = reserveWorldInfoDrawerHeight(drawerNode, editOutlet);
        ensureWorldInfoDrawerLoadingPlaceholder(editOutlet);

        requestAnimationFrame(() => {
            editOutlet.promise().done(() => {
                if (buildToken !== drawerBuildToken) {
                    return;
                }

                drawerBuildQueued = false;
                if (!editOutlet.is(':visible') || drawerInitialized) {
                    return;
                }

                let buildSucceeded = false;
                try {
                    addEditorDrawerContent();
                    drawerInitialized = true;
                    buildSucceeded = true;
                } catch (error) {
                    console.error(`Error building World Info entry drawer for ${entry.uid}:`, error);
                } finally {
                    clearWorldInfoDrawerLoadingPlaceholder(editOutlet);

                    if (buildSucceeded) {
                        const naturalHeight = Math.round(editOutlet.get(0)?.scrollHeight || 0);
                        if (naturalHeight > 0) {
                            setWorldInfoDrawerReserveHeight(drawerNode, naturalHeight);
                            if (naturalHeight > reserveHeight) {
                                editOutlet.css('height', `${naturalHeight}px`);
                            }
                        }
                    }

                    requestAnimationFrame(() => {
                        if (editOutlet.is(':visible')) {
                            releaseWorldInfoDrawerHeight(editOutlet);
                        }
                    });
                }
            });
        });
    }

    drawerEl.on('inline-drawer-toggle', function () {
        clearDrawerDestroyTimeout();
        const isOpening = !editOutlet.is(':visible');

        if (isOpening) {
            scheduleDrawerBuild();
            return;
        }

        drawerBuildToken++;
        drawerBuildQueued = false;
        drawerDestroyTimeout = setTimeout(() => {
            if (editOutlet.is(':visible')) {
                return;
            }

            clearWorldInfoDrawerLoadingPlaceholder(editOutlet);
            releaseWorldInfoDrawerHeight(editOutlet);

            if (drawerInitialized) {
                drawerInitialized = false;
                clearEntryList(editOutlet);
            }

            drawerDestroyTimeout = null;
        }, debounce_timeout.relaxed);
    });

    function addEditorDrawerContent() {
        const editTemplate = WI_ENTRY_EDIT_TEMPLATE.clone();

        // UID display
        editTemplate.find('.world_entry_form_uid_value').text(`(UID: ${entry.uid})`);

        // Key inputs
        const keyInput = enableKeysInputHelper({ template: editTemplate, entry, entryPropName: 'key', originalDataValueName: 'keys', name, data });
        const keySecondaryInput = enableKeysInputHelper({ template: editTemplate, entry, entryPropName: 'keysecondary', originalDataValueName: 'secondary_keys', name, data });
        if (!keyInput.isFancy) initScrollHeight(keyInput.control);
        if (!keySecondaryInput.isFancy) initScrollHeight(keySecondaryInput.control);

        // Key input switch
        editTemplate.find('.switch_input_type_icon').on('click', function () {
            power_user.wi_key_input_plaintext = !power_user.wi_key_input_plaintext;
            saveSettingsDebounced();
            const uid = ($(this).parents('.world_entry')).data('uid');
            updateEditor(uid, false);
            $(`.world_entry[uid="${uid}"] .inline-drawer-icon`).trigger('click');
        }).each((_, icon) => {
            $(icon).attr('title', $(icon).data(power_user.wi_key_input_plaintext ? 'tooltip-on' : 'tooltip-off'));
            $(icon).text($(icon).data(power_user.wi_key_input_plaintext ? 'icon-on' : 'icon-off'));
        });

        // Probability toggle
        handleProbabilityToggleHelper({
            probabilityToggle: editTemplate.find('input[name="useProbability"]'),
            data, entry, name,
            probabilityInput: headerTemplate.find('input[name="probability"]'),
        });

        // Comment toggle
        const commentToggle = editTemplate.find('input[name="addMemo"]');
        commentToggle.data('uid', entry.uid);
        commentToggle.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).prop('checked');
            const commentContainer = $(this).closest('.world_entry').find('.commentContainer');
            data.entries[uid].addMemo = value;
            !noSave && await saveWorldInfo(name, data);
            value ? commentContainer.show() : commentContainer.hide();
        });
        commentToggle.prop('checked', true).trigger('input', { noSave: true });
        commentToggle.parent().hide();

        // Logic AND/NOT
        const selectiveLogicDropdown = editTemplate.find('select[name="entryLogicType"]');
        selectiveLogicDropdown.data('uid', entry.uid);
        selectiveLogicDropdown.on('click', e => e.stopPropagation());
        selectiveLogicDropdown.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = Number($(this).val());
            data.entries[uid].selectiveLogic = !isNaN(value) ? value : world_info_logic.AND_ANY;
            setWIOriginalDataValue(data, uid, 'selectiveLogic', data.entries[uid].selectiveLogic);
            !noSave && await saveWorldInfo(name, data);
        });
        editTemplate.find(`select[name="entryLogicType"] option[value=${entry.selectiveLogic}]`).prop('selected', true).trigger('input', { noSave: true });

        // Selective
        const selectiveInput = editTemplate.find('input[name="selective"]');
        selectiveInput.data('uid', entry.uid);
        selectiveInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).prop('checked');
            data.entries[uid].selective = value;
            setWIOriginalDataValue(data, uid, 'selective', data.entries[uid].selective);
            !noSave && await saveWorldInfo(name, data);
            const keysecondary = $(this).closest('.world_entry').find('.keysecondary');
            const keysecondarytextpole = $(this).closest('.world_entry').find('.keysecondarytextpole');
            const keyprimaryselect = $(this).closest('.world_entry').find('.keyprimaryselect');
            const keyprimaryHeight = keyprimaryselect.outerHeight();
            keysecondarytextpole.css('height', keyprimaryHeight + 'px');
            value ? keysecondary.show() : keysecondary.hide();
        });
        selectiveInput.prop('checked', true).trigger('input', { noSave: true });
        selectiveInput.parent().hide();

        // Character filter
        const characterFilterLabel = editTemplate.find('label[for="characterFilter"] > small');
        characterFilterLabel.text(entry.characterFilter?.isExclude ? 'Exclude Character(s)' : 'Filter to Character(s)');
        const characterExclusionInput = editTemplate.find('input[name="character_exclusion"]');
        characterExclusionInput.data('uid', entry.uid);
        characterExclusionInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).prop('checked');
            characterFilterLabel.text(value ? 'Exclude Character(s)' : 'Filter to Character(s)');
            if (data.entries[uid].characterFilter) {
                if (!value && data.entries[uid].characterFilter.names.length === 0 && data.entries[uid].characterFilter.tags.length === 0) {
                    delete data.entries[uid].characterFilter;
                } else {
                    data.entries[uid].characterFilter.isExclude = value;
                }
            } else if (value) {
                Object.assign(data.entries[uid], { characterFilter: { isExclude: true, names: [], tags: [] } });
            }
            if (data.entries[uid]?.characterFilter?.names?.length > 0) {
                for (const name of [...data.entries[uid].characterFilter.names]) {
                    if (!getContext().characters.find(x => x.avatar.replace(/\.[^/.]+$/, '') === name)) {
                        data.entries[uid].characterFilter.names = data.entries[uid].characterFilter.names.filter(x => x !== name);
                    }
                }
            }
            setWIOriginalDataValue(data, uid, 'character_filter', data.entries[uid].characterFilter);
            !noSave && await saveWorldInfo(name, data);
        });
        characterExclusionInput.prop('checked', entry.characterFilter?.isExclude ?? false).trigger('input', { noSave: true });

        const characterFilter = editTemplate.find('select[name="characterFilter"]');
        characterFilter.data('uid', entry.uid);
        initCharacterFilterSelect2Helper(characterFilter);
        fillCharacterAndTagOptionsHelper({ characterFilter, entry });
        handleCharacterFilterChangeHelper({ characterFilter, data, entry, name });

        // Content
        const counter = editTemplate.find('.world_entry_form_token_counter');
        const countTokensDebounced = debounce(async function (counter, value) {
            const numberOfTokens = await getTokenCountAsync(value);
            $(counter).text(numberOfTokens);
        }, debounce_timeout.relaxed);
        const contentInputId = `world_entry_content_${entry.uid}`;
        const contentInput = editTemplate.find('textarea[name="content"]');
        contentInput.data('uid', entry.uid);
        contentInput.attr('id', contentInputId);
        contentInput[0].dataset.macros = ''; // active
        contentInput.on('input', async function (_, { skipCount, noSave } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).val();
            data.entries[uid].content = value;
            setWIOriginalDataValue(data, uid, 'content', data.entries[uid].content);
            !noSave && await saveWorldInfo(name, data);
            if (!skipCount) countTokensDebounced(counter, value);
        });
        contentInput.val(entry.content).trigger('input', { skipCount: true, noSave: true });
        editTemplate.find('.editor_maximize').attr('data-for', contentInputId);

        // Outlet name
        const outletNameInput = editTemplate.find('input[name="outletName"]');
        outletNameInput.data('uid', entry.uid);
        outletNameInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).val();
            data.entries[uid].outletName = value;
            setWIOriginalDataValue(data, uid, 'extensions.outlet_name', data.entries[uid].outletName);
            !noSave && await saveWorldInfo(name, data);
        });
        outletNameInput.val(entry.outletName ?? '').trigger('input', { noSave: true });
        setTimeout(() => createEntryInputAutocomplete(outletNameInput, getOutletNameCallback(data), { allowMultiple: true }), 1);

        // Scan depth
        const scanDepthInput = editTemplate.find('input[name="scanDepth"]');
        scanDepthInput.data('uid', entry.uid);
        scanDepthInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const isEmpty = $(this).val() === '';
            const value = Number($(this).val());
            if (value < 0) {
                $(this).val(0).trigger('input');
                toastr.warning('Scan depth cannot be negative');
                return;
            }
            if (value > MAX_SCAN_DEPTH) {
                $(this).val(MAX_SCAN_DEPTH).trigger('input');
                toastr.warning(`Scan depth cannot exceed ${MAX_SCAN_DEPTH}`);
                return;
            }
            data.entries[uid].scanDepth = !isEmpty && !isNaN(value) && value >= 0 && value <= MAX_SCAN_DEPTH ? Math.floor(value) : null;
            setWIOriginalDataValue(data, uid, 'extensions.scan_depth', data.entries[uid].scanDepth);
            !noSave && await saveWorldInfo(name, data);
        });
        scanDepthInput.val(entry.scanDepth ?? null).trigger('input', { noSave: true });

        // Group
        const groupInput = editTemplate.find('input[name="group"]');
        groupInput.data('uid', entry.uid);
        groupInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = String($(this).val()).trim();
            data.entries[uid].group = value;
            setWIOriginalDataValue(data, uid, 'extensions.group', data.entries[uid].group);
            !noSave && await saveWorldInfo(name, data);
        });
        groupInput.val(entry.group ?? '').trigger('input', { noSave: true });
        setTimeout(() => createEntryInputAutocomplete(groupInput, getInclusionGroupCallback(data), { allowMultiple: true }), 1);

        // Inclusion priority
        const groupOverrideInput = editTemplate.find('input[name="groupOverride"]');
        groupOverrideInput.data('uid', entry.uid);
        groupOverrideInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).prop('checked');
            data.entries[uid].groupOverride = value;
            setWIOriginalDataValue(data, uid, 'extensions.group_override', data.entries[uid].groupOverride);
            !noSave && await saveWorldInfo(name, data);
        });
        groupOverrideInput.prop('checked', entry.groupOverride).trigger('input', { noSave: true });

        // Group weight
        handleNumberInputHelper({
            inputElem: editTemplate.find('input[name="groupWeight"]'),
            entry, entryKey: 'groupWeight', data, name, min: 1, max: 10000, clamp: true,
        });

        // Sticky, cooldown, delay
        handleNumberInputHelper({
            inputElem: editTemplate.find('input[name="sticky"]'),
            entry, entryKey: 'sticky', data, name, min: 1, max: 10000, clamp: false,
        });
        handleNumberInputHelper({
            inputElem: editTemplate.find('input[name="cooldown"]'),
            entry, entryKey: 'cooldown', data, name, min: 1, max: 10000, clamp: false,
        });
        handleNumberInputHelper({
            inputElem: editTemplate.find('input[name="delay"]'),
            entry, entryKey: 'delay', data, name, min: 1, max: 10000, clamp: false,
        });

        // Exclude/prevent recursion
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'excludeRecursion', data, name });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'preventRecursion', data, name });

        // Delay until recursion
        const delayUntilRecursionInput = editTemplate.find('input[name="delay_until_recursion"]');
        delayUntilRecursionInput.data('uid', entry.uid);
        const delayUntilRecursionLevelInput = editTemplate.find('input[name="delayUntilRecursionLevel"]');
        delayUntilRecursionLevelInput.data('uid', entry.uid);
        delayUntilRecursionInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const toggled = $(this).prop('checked');
            const value = toggled ? data.entries[uid].delayUntilRecursion || true : false;
            if (!toggled) delayUntilRecursionLevelInput.val('');
            data.entries[uid].delayUntilRecursion = value;
            setWIOriginalDataValue(data, uid, 'extensions.delay_until_recursion', data.entries[uid].delayUntilRecursion);
            !noSave && await saveWorldInfo(name, data);
        });
        delayUntilRecursionInput.prop('checked', entry.delayUntilRecursion).trigger('input', { noSave: true });
        delayUntilRecursionLevelInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const content = $(this).val();
            const value = content === '' ? (typeof data.entries[uid].delayUntilRecursion === 'boolean' ? data.entries[uid].delayUntilRecursion : true)
                : content === 1 ? true
                    : !isNaN(Number(content)) ? Number(content)
                        : false;
            data.entries[uid].delayUntilRecursion = value;
            setWIOriginalDataValue(data, uid, 'extensions.delay_until_recursion', data.entries[uid].delayUntilRecursion);
            !noSave && await saveWorldInfo(name, data);
        });
        delayUntilRecursionLevelInput.val(['number', 'string'].includes(typeof entry.delayUntilRecursion) ? entry.delayUntilRecursion : '').trigger('input', { noSave: true });

        // Boolean selects
        handleBooleanSelectHelper({ selectElem: editTemplate.find('select[name="caseSensitive"]'), entry, entryKey: 'caseSensitive', data, name });
        handleBooleanSelectHelper({ selectElem: editTemplate.find('select[name="matchWholeWords"]'), entry, entryKey: 'matchWholeWords', data, name });
        handleBooleanSelectHelper({ selectElem: editTemplate.find('select[name="useGroupScoring"]'), entry, entryKey: 'useGroupScoring', data, name });

        // Match checkboxes
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchPersonaDescription', data, name });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchCharacterDescription', data, name });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchCharacterPersonality', data, name });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchCharacterDepthPrompt', data, name });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchScenario', data, name });
        handleMatchCheckboxHelper({ template: editTemplate, entry, fieldName: 'matchCreatorNotes', data, name });

        // Automation ID
        const automationIdInput = editTemplate.find('input[name="automationId"]');
        automationIdInput.data('uid', entry.uid);
        automationIdInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).val();
            data.entries[uid].automationId = value;
            setWIOriginalDataValue(data, uid, 'extensions.automation_id', data.entries[uid].automationId);
            !noSave && await saveWorldInfo(name, data);
        });
        automationIdInput.val(entry.automationId ?? '').trigger('input', { noSave: true });
        setTimeout(() => createEntryInputAutocomplete(automationIdInput, getAutomationIdCallback(data)), 1);

        // Generation Type Triggers
        const generationTypeTriggers = editTemplate.find('select[name="triggers"]');
        generationTypeTriggers.data('uid', entry.uid);
        generationTypeTriggers.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).val();
            data.entries[uid].triggers = Array.isArray(value) ? value : [];
            setWIOriginalDataValue(data, uid, 'extensions.triggers', data.entries[uid].triggers);
            !noSave && await saveWorldInfo(name, data);
        });
        if (!isMobile()) {
            generationTypeTriggers.select2({
                placeholder: t`All types (default)`,
                width: '100%',
                closeOnSelect: false,
                allowClear: true,
            });
        }
        generationTypeTriggers
            .val(Array.isArray(entry.triggers) ? entry.triggers : [])
            .trigger('input', { noSave: true })
            .trigger('change');

        // Ignore budget
        const ignoreBudgetInput = editTemplate.find('input[name="ignoreBudget"]');
        ignoreBudgetInput.data('uid', entry.uid);
        ignoreBudgetInput.on('input', async function (_, { noSave = false } = {}) {
            const uid = $(this).data('uid');
            const value = $(this).prop('checked');
            data.entries[uid].ignoreBudget = value;
            setWIOriginalDataValue(data, uid, 'extensions.ignore_budget', data.entries[uid].ignoreBudget);
            !noSave && await saveWorldInfo(name, data);
        });
        ignoreBudgetInput.prop('checked', entry.ignoreBudget ?? false).trigger('input', { noSave: true });

        countTokensDebounced(counter, contentInput.val());

        applyWorldInfoEditorDisplaySettings(editTemplate);
        editTemplate.find('.inline-drawer-content').css('display', 'none');
        editOutlet.append(editTemplate);
    }

    headerTemplate.find('.inline-drawer-content').css('display', 'none');

    return headerTemplate;
}


/**
 * Builds a jQuery UI autocomplete callback: (control, request, response) => void
 * @param {object} [opt={}] - Optional arguments
 * @param {{entries: Record<string, any>}} [opt.data]   - Your WI data
 * @param {(entry:any)=>string|string[]|null|undefined} [opt.collectValues] - Extract values from one entry
 * @param {() => Iterable<string>} [opt.includeExtras] - Optional global extras to include
 * @param {(ctx:{result:string[], control:JQuery, input:any, haystack:string[]})=>string[]} [opt.postFilter] - Optional final filter step (for special rules like your "group" de-dupe logic)
 */
function buildAutocompleteCallback({ data, collectValues, includeExtras = () => [], postFilter } = {}) {
    return function (control, input, output) {
        const uid = $(control).data('uid');

        // Collect unique values from all *other* entries
        const values = new Set();
        for (const entry of Object.values(data.entries ?? {})) {
            if (entry?.uid == uid) continue;
            const raw = collectValues(entry);
            if (raw == null) continue;
            const arr = Array.isArray(raw) ? raw : [raw];
            for (const v of arr) {
                const s = String(v).trim();
                if (s) values.add(s);
            }
        }

        // Add optional global extras
        for (const v of includeExtras()) {
            const s = String(v).trim();
            if (s) values.add(s);
        }

        // Sort stable & locale-aware
        const haystack = Array.from(values).sort((a, b) => a.localeCompare(b));

        // Case-insensitive contains
        const needle = String(input.term ?? '').toLowerCase();
        let result = haystack.filter(x => x.toLowerCase().includes(needle));

        // Optional final-pass semantics
        if (postFilter) {
            result = postFilter({ result, control: $(control), input, haystack });
        }

        output(result);
    };
}

/**
 * Splits a string into an array of strings, separated by commas and trimmed
 * @param {string} s - The string to split
 * @returns {string[]} An array of strings, separated by commas and trimmed
 */
const splitCsv = s => String(s ?? '').split(/,\s*/).filter(Boolean);

/**
 * Get the inclusion groups for the autocomplete.
 * @param {any} data WI data
 * @returns {(input: any, output: any) => any} Callback function for the autocomplete
 */
function getInclusionGroupCallback(data) {
    return buildAutocompleteCallback({
        data,
        collectValues: entry => entry.group ? splitCsv(entry.group) : [],
        postFilter: ({ result, control, input, haystack }) => {
            const thisGroups = splitCsv(String($(control).val()));
            const needle = String(input.term ?? '').toLowerCase();
            const hasExactMatch = haystack.some(x => x.toLowerCase() === needle);

            // include suggestion if it contains the needle AND
            // (not already present OR (exact match typed && appears only once))
            return result.filter(x =>
                !thisGroups.includes(x) ||
                (hasExactMatch && thisGroups.filter(g => g === x).length === 1),
            );
        },
    });
}

function getAutomationIdCallback(data) {
    return buildAutocompleteCallback({
        data,
        collectValues: entry => entry.automationId != null ? [String(entry.automationId)] : [],
        includeExtras: () =>
            ('quickReplyApi' in globalThis && globalThis.quickReplyApi?.listAutomationIds)
                ? globalThis.quickReplyApi.listAutomationIds()
                : [],
    });
}

function getOutletNameCallback(data) {
    return buildAutocompleteCallback({
        data,
        collectValues: entry => entry.position === world_info_position.outlet && entry.outletName ? [entry.outletName] : [],
    });
}

/**
 * Create an autocomplete for an input element.
 * @param {JQuery<HTMLElement>} input - Input element to attach the autocomplete to
 * @param {(control: JQuery<HTMLElement>, input: any, output: any) => any} callback - Source data callbacks
 * @param {object} [options={}] - Optional arguments
 * @param {boolean} [options.allowMultiple=false] - Whether to allow multiple comma-separated values
 */
function createEntryInputAutocomplete(input, callback, { allowMultiple = false } = {}) {
    const handleSelect = (event, ui) => {
        // Prevent default autocomplete select, so we can manually set the value
        event.preventDefault();
        if (!allowMultiple) {
            $(input).val(ui.item.value).trigger('input').trigger('blur');
        } else {
            var terms = String($(input).val()).split(/,\s*/);
            terms.pop(); // remove the current input
            terms.push(ui.item.value); // add the selected item
            $(input).val(terms.filter(x => x).join(', ')).trigger('input').trigger('blur');
        }
    };

    $(input).autocomplete({
        minLength: 0,
        source: function (request, response) {
            if (!allowMultiple) {
                callback(input, request, response);
            } else {
                const term = request.term.split(/,\s*/).pop();
                request.term = term;
                callback(input, request, response);
            }
        },
        select: handleSelect,
    });

    $(input).on('focus click', function () {
        $(input).autocomplete('search', allowMultiple ? String($(input).val()).split(/,\s*/).pop() : String($(input).val()));
    });
}


/**
 * Duplicate a WI entry by copying all of its properties and assigning a new uid
 * @param {*} data - The data of the book
 * @param {number} uid - The uid of the entry to copy in this book
 * @returns {*} The new WI duplicated entry
 */
export function duplicateWorldInfoEntry(data, uid) {
    if (!data || !('entries' in data) || !data.entries[uid]) {
        return;
    }

    // Exclude uid and gather the rest of the properties
    const originalData = structuredClone(data.entries[uid]);
    delete originalData.uid;

    // Create new entry and copy over data
    const entry = createWorldInfoEntry(data.name, data);
    Object.assign(entry, originalData);

    return entry;
}

/**
 * Deletes a WI entry, with a user confirmation dialog
 * @param {*[]} data - The data of the book
 * @param {number} uid - The uid of the entry to copy in this book
 * @param {object} [options={}] - Optional arguments
 * @param {boolean} [options.silent=false] - Whether to prompt the user for deletion or just do it
 * @returns {Promise<boolean>} Whether the entry deletion was successful
 */
export async function deleteWorldInfoEntry(data, uid, { silent = false } = {}) {
    if (!data || !('entries' in data)) {
        return;
    }

    const entry = data.entries[uid];
    if (!entry) {
        return false;
    }

    let previewText = '';
    if (entry.comment && entry.comment.trim()) {
        previewText = entry.comment.trim();
    } else if (entry.content) {
        const lines = entry.content.split(/\r?\n/).filter(line => line.trim());
        previewText = lines.slice(0, 2).join('\n');
    }

    const popupHeader = t`Delete world info entry with UID: ${uid}?`;
    const popupText = previewText
        ? `<strong>${t`Entry`}:</strong><br>${escapeHtml(previewText).replace(/\n/g, '<br>')}<br><br>${t`This action is irreversible!`}`
        : t`This action is irreversible!`;

    const confirmation = silent || await Popup.show.confirm(popupHeader, popupText);
    if (!confirmation) {
        return false;
    }

    delete data.entries[uid];
    return true;
}

/**
 * Definitions of types for new WI entries
 *
 * Use `newEntryTemplate` if you just need the template that contains default values
 *
 * @type {{[key: string]: WIEntryFieldDefinition}}
 */
export const newWorldInfoEntryDefinition = {
    key: { default: [], type: 'array' },
    keysecondary: { default: [], type: 'array' },
    comment: { default: '', type: 'string' },
    content: { default: '', type: 'string' },
    constant: { default: false, type: 'boolean' },
    vectorized: { default: false, type: 'boolean' },
    selective: { default: true, type: 'boolean' },
    selectiveLogic: { default: world_info_logic.AND_ANY, type: 'enum' },
    addMemo: { default: false, type: 'boolean' },
    order: { default: 100, type: 'number' },
    position: { default: 0, type: 'number' },
    disable: { default: false, type: 'boolean' },
    ignoreBudget: { default: false, type: 'boolean' },
    excludeRecursion: { default: false, type: 'boolean' },
    preventRecursion: { default: false, type: 'boolean' },
    matchPersonaDescription: { default: false, type: 'boolean' },
    matchCharacterDescription: { default: false, type: 'boolean' },
    matchCharacterPersonality: { default: false, type: 'boolean' },
    matchCharacterDepthPrompt: { default: false, type: 'boolean' },
    matchScenario: { default: false, type: 'boolean' },
    matchCreatorNotes: { default: false, type: 'boolean' },
    delayUntilRecursion: { default: 0, type: 'number' },
    probability: { default: 100, type: 'number' },
    useProbability: { default: true, type: 'boolean' },
    depth: { default: DEFAULT_DEPTH, type: 'number' },
    outletName: { default: '', type: 'string' },
    group: { default: '', type: 'string' },
    groupOverride: { default: false, type: 'boolean' },
    groupWeight: { default: DEFAULT_WEIGHT, type: 'number' },
    scanDepth: { default: null, type: 'number?' },
    caseSensitive: { default: null, type: 'boolean?' },
    matchWholeWords: { default: null, type: 'boolean?' },
    useGroupScoring: { default: null, type: 'boolean?' },
    automationId: { default: '', type: 'string' },
    role: { default: 0, type: 'enum' },
    sticky: { default: null, type: 'number?' },
    cooldown: { default: null, type: 'number?' },
    delay: { default: null, type: 'number?' },
    characterFilterNames: { default: [], type: 'array', excludeFromTemplate: true },
    characterFilterTags: { default: [], type: 'array', excludeFromTemplate: true },
    characterFilterExclude: { default: false, type: 'boolean', excludeFromTemplate: true },
    triggers: { default: [], type: 'array', arrayFilter: (value) => GENERATION_TYPE_TRIGGERS.includes(value) },
};

export const newWorldInfoEntryTemplate = Object.fromEntries(
    Object.entries(newWorldInfoEntryDefinition).filter(([_, value]) => !value.excludeFromTemplate).map(([key, value]) => [key, value.default]),
);

/**
 * Creates a new world info entry from template.
 * @param {string} _name Name of the WI (unused)
 * @param {any} data WI data
 * @returns {object | undefined} New entry object or undefined if failed
 */
export function createWorldInfoEntry(_name, data) {
    const newUid = getFreeWorldEntryUid(data);

    if (!Number.isInteger(newUid)) {
        console.error('Couldn\'t assign UID to a new entry');
        return;
    }

    const newEntry = { uid: newUid, ...structuredClone(newWorldInfoEntryTemplate) };
    data.entries[newUid] = newEntry;

    return newEntry;
}

async function saveWorldInfoInternal(name, data, options = {}) {
    let saved = false;
    invalidateWorldInfoRequestCache([name]);
    const payload = cloneJsonValue(data);
    const previousSnapshot = getWorldInfoSnapshot(name);
    const canPatch = isPlainObject(previousSnapshot) && isPlainObject(payload);
    const normalizedOptions = normalizeWorldInfoSaveOptions(options);

    if (canPatch) {
        const operations = normalizedOptions.asyncDiff
            ? await buildObjectPatchOperationsAsync(previousSnapshot, payload, { maxOperations: 16000 })
            : buildObjectPatchOperations(previousSnapshot, payload, { maxOperations: 16000 });
        if (operations.length === 0) {
            saved = true;
        } else {
            const patchResult = await fetch('/api/worldinfo/patch', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name, operations }),
            });
            saved = patchResult.ok;
        }
    }

    if (!saved) {
        const fullSaveResult = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: name, data: payload }),
        });
        if (!fullSaveResult.ok) {
            throw new Error(`Failed to save world info: ${fullSaveResult.status}`);
        }
    }

    cacheWorldInfoData(name, payload, { invalidateSearch: true });
    await eventSource.emit(event_types.WORLDINFO_UPDATED, name, payload);
}

async function _save(name, data, options = {}) {
    // Prevent double saving if both immediate and debounced save are called
    cancelDebounce(saveWorldDebounced);

    const normalizedOptions = normalizeWorldInfoSaveOptions(options);

    if (worldInfoSaveInFlight) {
        worldInfoSaveQueuedRequest = {
            name,
            data,
            options: mergeWorldInfoSaveOptions(worldInfoSaveQueuedRequest?.options, normalizedOptions),
        };
        return worldInfoSaveInFlight;
    }

    worldInfoSaveInFlight = (async () => {
        try {
            await saveWorldInfoInternal(name, data, normalizedOptions);
        } finally {
            worldInfoSaveInFlight = null;
            if (worldInfoSaveQueuedRequest) {
                const queuedRequest = worldInfoSaveQueuedRequest;
                worldInfoSaveQueuedRequest = null;
                await _save(queuedRequest.name, queuedRequest.data, queuedRequest.options);
            }
        }
    })();

    return worldInfoSaveInFlight;
}


/**
 * Saves the world info
 *
 * This will also refresh the `worldInfoCache`.
 * Note, for performance reasons the saved cache will not make a deep clone of the data.
 * It is your responsibility to not modify the saved data object after calling this function, or there will be data inconsistencies.
 * Call `loadWorldInfoData` or query directly from cache if you need the object again.
 *
 * @param {string} name - The name of the world info
 * @param {any} data - The data to be saved
 * @param {boolean} [immediately=false] - Whether to save immediately or use debouncing
 * @return {Promise<void>} A promise that resolves when the world info is saved
 */
export async function saveWorldInfo(name, data, immediately = false, options = {}) {
    if (!name || !data) {
        return;
    }

    // Update cache immediately, so any future call can pull from this
    worldInfoCache.set(name, data);
    const normalizedOptions = normalizeWorldInfoSaveOptions(options);

    if (immediately) {
        return await _save(name, data, normalizedOptions);
    }

    saveWorldDebounced(name, data, normalizedOptions);
}

async function renameWorldInfo(name, data) {
    const oldName = name;
    const newName = await Popup.show.input('Rename World Info', 'Enter a new name:', oldName);

    if (oldName === newName || !newName) {
        console.debug('World info rename cancelled');
        return;
    }
    if (equalsIgnoreCaseAndAccents(oldName, newName)) {
        toastr.warning(t`Name not accepted, as it is the same as before (ignoring case and accents).`, t`Rename World Info`);
        return;
    }

    const entryPreviouslySelected = selected_world_info.findIndex((e) => e === oldName);

    await saveWorldInfo(newName, data, true);
    await deleteWorldInfo(oldName);

    await updateWorldInfoLinks(oldName, newName);

    if (Array.isArray(world_info.pinnedWorlds)) {
        world_info.pinnedWorlds = world_info.pinnedWorlds.map((entry) => areLookupNamesEqual(entry, oldName) ? newName : entry);
        saveSettingsDebounced();
    }

    if (entryPreviouslySelected !== -1) {
        const wiElement = getWIElement(newName);
        wiElement.prop('selected', true);
        $('#world_info').trigger('change');
    }

    const selectedIndex = world_names.indexOf(newName);
    if (selectedIndex !== -1) {
        $('#world_editor_select').val(selectedIndex).trigger('change');
    }
}

/**
 * Retargets all character lore links from an old world info name to a new one, with an optional confirmation for primary lorebook links
 * @param {string} oldName Previous WI file name
 * @param {string} newName New WI file name
 * @returns {Promise<void>}
 */
async function updateWorldInfoLinks(oldName, newName) {
    const existingCharLores = world_info.charLore?.filter((e) => e.extraBooks.includes(oldName));
    if (existingCharLores && existingCharLores.length > 0) {
        existingCharLores.forEach((charLore) => {
            const tempCharLore = charLore.extraBooks.filter((e) => e !== oldName);
            tempCharLore.push(newName);
            charLore.extraBooks = tempCharLore;
        });
        saveSettingsDebounced();
    }

    // find all characters using the old lorebook name as their primary world
    const linkedChIDs = [];
    characters.forEach((character, chid) => {
        if (character.data?.extensions?.world === oldName) {
            linkedChIDs.push(chid);
        }
    });

    if (!linkedChIDs.length) {
        return;
    }

    // Trigger the confirmation popup
    const updatePastLinksConfirm = await Popup.show.confirm(
        t`World/Lorebook renamed!`,
        `<p>${t`Auxiliary Lorebook links have been updated. Would you like to update primary lorebook links for ${linkedChIDs.length} character(s) as well?`}</p>`,
    ) == POPUP_RESULT.AFFIRMATIVE;

    if (updatePastLinksConfirm) {
        let activeCharacterUpdated = false;

        for (const chid of linkedChIDs) {
            const character = characters[chid];

            try {
                // /merge-attributes API call to update the file on the backend silently
                const response = await fetch('/api/characters/merge-attributes', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        avatar: character.avatar,
                        data: {
                            extensions: {
                                world: newName,
                            },
                        },
                    }),
                });

                if (!response.ok) {
                    throw new Error(`Merge API returned ${response.status}`);
                }

                // used to update the data in the browser's memory
                await getOneCharacter(character.avatar);

                // Flag if the currently open character was affected
                if (String(chid) === String(this_chid)) {
                    activeCharacterUpdated = true;
                }

                toastr.success(`Successfully updated link for ${character.name}.`);
            } catch (e) {
                toastr.error(`Failed to update link for ${character.name}.`);
                console.error(`Backend update for character ${character.name} failed:`, e);
            }
        }

        // update the UI fields
        // only required if the currently selected character was changed
        if (activeCharacterUpdated) {
            select_selected_character(this_chid, { switchMenu: false });
            setWorldInfoButtonClass(this_chid, true);
        }
    }
}

/**
 * Deletes a world info with the given name
 *
 * @param {string} worldInfoName - The name of the world info to delete
 * @returns {Promise<boolean>} A promise that resolves to true if the world info was successfully deleted, false otherwise
 */
export async function deleteWorldInfo(worldInfoName) {
    const resolvedWorldInfoName = resolveWorldInfoName(worldInfoName);
    if (!resolvedWorldInfoName) {
        return false;
    }
    invalidateWorldInfoRequestCache([resolvedWorldInfoName]);

    const response = await fetch('/api/worldinfo/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: resolvedWorldInfoName }),
    });

    if (!response.ok) {
        return false;
    }

    if (worldInfoCache.has(resolvedWorldInfoName)) {
        worldInfoCache.delete(resolvedWorldInfoName);
    }
    worldInfoSnapshotCache.delete(resolvedWorldInfoName);
    invalidateWorldInfoManagerEntrySearch();

    const existingWorldIndex = selected_world_info.findIndex((e) => areLookupNamesEqual(e, resolvedWorldInfoName));
    if (existingWorldIndex !== -1) {
        selected_world_info.splice(existingWorldIndex, 1);
        requestAsyncDiffForNextSettingsSave();
        saveSettingsDebounced();
    }

    if (Array.isArray(world_info.pinnedWorlds)) {
        const nextPinnedWorlds = world_info.pinnedWorlds.filter((entry) => !areLookupNamesEqual(entry, resolvedWorldInfoName));
        if (nextPinnedWorlds.length !== world_info.pinnedWorlds.length) {
            world_info.pinnedWorlds = nextPinnedWorlds;
            requestAsyncDiffForNextSettingsSave();
            saveSettingsDebounced();
        }
    }

    await updateWorldInfoList();
    $('#world_editor_select').trigger('change');

    if (areLookupNamesEqual($('#character_world').val(), resolvedWorldInfoName)) {
        $('#character_world').val('').trigger('change');
        setWorldInfoButtonClass(undefined, false);
        if (menu_type != 'create') {
            saveCharacterDebounced();
        }
    }

    if (areLookupNamesEqual(power_user.persona_description_lorebook, resolvedWorldInfoName)) {
        power_user.persona_description_lorebook = '';
        if (power_user.personas[user_avatar]) {
            const object = getOrCreatePersonaDescriptor();
            object.lorebook = '';
        }
        $('#persona_lore_button').toggleClass('world_set', false);
        requestAsyncDiffForNextSettingsSave();
        saveSettingsDebounced();
    }

    return true;
}

export async function deleteWorldInfoWithUndo(worldInfoName) {
    const resolvedWorldInfoName = resolveWorldInfoName(worldInfoName);
    if (!resolvedWorldInfoName) {
        return false;
    }

    const worldData = structuredClone(await loadWorldInfo(resolvedWorldInfoName));
    const worldEditorName = getSelectedWorldEditorName();
    const snapshot = {
        worldData,
        selectedWorldInfo: structuredClone(selected_world_info),
        charLore: world_info.charLore ? structuredClone(world_info.charLore) : null,
        characterWorld: String($('#character_world').val() || ''),
        personaLorebook: String(power_user.persona_description_lorebook || ''),
        worldEditorName,
    };

    if (world_info.charLore) {
        for (let index = world_info.charLore.length - 1; index >= 0; index--) {
            const charLore = world_info.charLore[index];
            if (charLore.extraBooks?.some((entry) => areLookupNamesEqual(entry, resolvedWorldInfoName))) {
                const nextExtraBooks = charLore.extraBooks.filter((entry) => !areLookupNamesEqual(entry, resolvedWorldInfoName));
                if (nextExtraBooks.length === 0) {
                    world_info.charLore.splice(index, 1);
                } else {
                    charLore.extraBooks = nextExtraBooks;
                }
            }
        }

        saveSettingsDebounced();
    }

    const deleted = await deleteWorldInfo(resolvedWorldInfoName);
    if (!deleted) {
        return false;
    }

    if (!snapshot.worldData) {
        toastr.success(t`World/Lorebook deleted.`);
        return true;
    }

    showUndoToast({
        message: t`World/Lorebook deleted.`,
        onUndo: async () => {
            try {
                await saveWorldInfo(resolvedWorldInfoName, structuredClone(snapshot.worldData), true);
                await updateWorldInfoList();

                if (snapshot.charLore) {
                    world_info.charLore = structuredClone(snapshot.charLore);
                }

                const restoredSelectedWorlds = snapshot.selectedWorldInfo.filter(name => world_names.includes(name));
                selected_world_info.splice(0, selected_world_info.length, ...restoredSelectedWorlds);
                syncGlobalWorldInfoSettingsState();
                syncGlobalWorldInfoSelectionUi();
                await eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);

                if (areLookupNamesEqual(snapshot.characterWorld, resolvedWorldInfoName)) {
                    $('#character_world').val(resolvedWorldInfoName).trigger('change');
                    setWorldInfoButtonClass(undefined, true);
                    if (menu_type != 'create') {
                        saveCharacterDebounced();
                    }
                }

                if (areLookupNamesEqual(snapshot.personaLorebook, resolvedWorldInfoName)) {
                    power_user.persona_description_lorebook = resolvedWorldInfoName;
                    if (power_user.personas[user_avatar]) {
                        const object = getOrCreatePersonaDescriptor();
                        object.lorebook = resolvedWorldInfoName;
                    }
                    $('#persona_lore_button').toggleClass('world_set', true);
                }

                requestAsyncDiffForNextSettingsSave();
                saveSettingsDebounced();

                if (areLookupNamesEqual(snapshot.worldEditorName, resolvedWorldInfoName)) {
                    const restoredIndex = resolveWorldInfoIndex(resolvedWorldInfoName);
                    if (restoredIndex !== -1) {
                        $('#world_editor_select').val(restoredIndex).trigger('change');
                    }
                }
            } catch (error) {
                console.error('Failed to restore deleted world info', error);
                toastr.error(t`Failed to restore World/Lorebook.`);
            }
        },
    });

    return true;
}

export function getFreeWorldEntryUid(data) {
    if (!data || !('entries' in data)) {
        return null;
    }

    const MAX_UID = 1_000_000; // <- should be safe enough :)
    for (let uid = 0; uid < MAX_UID; uid++) {
        if (uid in data.entries) {
            continue;
        }
        return uid;
    }

    return null;
}


/**
 * Generates a free world name based on the given input name.
 * If the input name is null, a default name is used.
 * If the input name already exists, a numbered suffix is added.
 *
 * @param {string|null} worldName - The name to base the new world name on. If null, a default name is used.
 * @param {Object} [options={}] - Optional parameters.
 * @param {boolean} [options.stripIndex=true] - Whether to strip any numbered suffix from the input name before generating the new name.
 * @return {string|undefined} The generated free world name, or undefined if no free name could be found after trying 100,000 times.
 */
export function getFreeWorldName(worldName = null, { stripIndex = true } = {}) {
    worldName ??= t`New World`;
    if (stripIndex) {
        worldName = worldName.replace(/\s*\(\d+\)$/, '');
    }
    const MAX_FREE_NAME = 100_000;
    for (let index = 1; index < MAX_FREE_NAME; index++) {
        const newName = `${worldName} (${index})`;
        if (world_names.includes(newName)) {
            continue;
        }
        return newName;
    }

    return undefined;
}

/**
 * Creates a new world info/lorebook with the given name.
 * Checks if a world with the same name already exists, providing a warning or optionally a user confirmation dialog.
 *
 * @param {string} worldName - The name of the new world info
 * @param {Object} options - Optional parameters
 * @param {boolean} [options.interactive=false] - Whether to show a confirmation dialog when overwriting an existing world
 * @returns {Promise<boolean>} - True if the world info was successfully created, false otherwise
 */
export async function createNewWorldInfo(worldName, { interactive = false } = {}) {
    const worldInfoTemplate = { entries: {} };

    if (!worldName) {
        return false;
    }

    const sanitizedWorldName = await getSanitizedFilename(worldName);

    const allowed = await checkOverwriteExistingData('World Info', world_names, sanitizedWorldName, { interactive: interactive, actionName: 'Create', deleteAction: (existingName) => deleteWorldInfo(existingName) });
    if (!allowed) {
        return false;
    }

    await saveWorldInfo(worldName, worldInfoTemplate, true);
    await updateWorldInfoList();

    const selectedIndex = world_names.indexOf(worldName);
    if (selectedIndex !== -1) {
        $('#world_editor_select').val(selectedIndex).trigger('change');
    } else {
        await hideWorldEditor();
    }

    return true;
}

async function getCharacterLore() {
    const character = characters[this_chid];
    const name = character?.name;
    const chatWorlds = getChatWorldInfoNames();
    /** @type {Set<string>} */
    let worldsToSearch = new Set();

    const baseWorldName = character?.data?.extensions?.world;
    if (baseWorldName) {
        worldsToSearch.add(baseWorldName);
    }

    // TODO: Maybe make the utility function not use the window context?
    const fileName = getCharaFilename(this_chid);
    const extraCharLore = world_info.charLore?.find((e) => e.name === fileName);
    if (extraCharLore) {
        worldsToSearch = new Set([...worldsToSearch, ...extraCharLore.extraBooks]);
    }

    if (!worldsToSearch.size) {
        return [];
    }

    const worldsToLoad = [...worldsToSearch].filter((worldName) =>
        !selected_world_info.includes(worldName)
        && !chatWorlds.includes(worldName)
        && power_user.persona_description_lorebook !== worldName);
    const worldData = await loadWorldInfoBatch(worldsToLoad);
    let entries = [];
    for (const worldName of worldsToSearch) {
        if (selected_world_info.includes(worldName)) {
            console.debug(`[WI] Character ${name}'s world ${worldName} is already activated in global world info! Skipping...`);
            continue;
        }

        if (chatWorlds.includes(worldName)) {
            console.debug(`[WI] Character ${name}'s world ${worldName} is already activated in chat lore! Skipping...`);
            continue;
        }

        if (power_user.persona_description_lorebook === worldName) {
            console.debug(`[WI] Character ${name}'s world ${worldName} is already activated in persona lore! Skipping...`);
            continue;
        }

        const data = worldData.get(worldName);
        const newEntries = data ? Object.keys(data.entries).map((x) => data.entries[x]).map(({ uid, ...rest }) => ({ uid, world: worldName, ...rest })) : [];
        entries = entries.concat(newEntries);

        if (!newEntries.length) {
            console.debug(`[WI] Character ${name}'s world ${worldName} could not be found or is empty`);
        }
    }

    console.debug(`[WI] Character ${name}'s lore has ${entries.length} world info entries`, [...worldsToSearch]);
    return entries;
}

async function getGlobalLore() {
    if (!selected_world_info?.length) {
        return [];
    }

    const worldData = await loadWorldInfoBatch(selected_world_info);
    let entries = [];
    for (const worldName of selected_world_info) {
        const data = worldData.get(worldName);
        const newEntries = data ? Object.keys(data.entries).map((x) => data.entries[x]).map(({ uid, ...rest }) => ({ uid, world: worldName, ...rest })) : [];
        entries = entries.concat(newEntries);
    }

    console.debug(`[WI] Global world info has ${entries.length} entries`, selected_world_info);

    return entries;
}

async function getChatLore() {
    const chatWorlds = getChatWorldInfoNames();

    if (!chatWorlds.length) {
        return [];
    }

    const worldsToLoad = chatWorlds.filter((worldName) => !selected_world_info.includes(worldName));
    const worldData = await loadWorldInfoBatch(worldsToLoad);
    let entries = [];

    for (const worldName of chatWorlds) {
        if (selected_world_info.includes(worldName)) {
            console.debug(`[WI] Chat world ${worldName} is already activated in global world info! Skipping...`);
            continue;
        }

        const data = worldData.get(worldName);
        const newEntries = data ? Object.keys(data.entries).map((x) => data.entries[x]).map(({ uid, ...rest }) => ({ uid, world: worldName, ...rest })) : [];
        entries = entries.concat(newEntries);
    }

    console.debug(`[WI] Chat lore has ${entries.length} entries`, chatWorlds);

    return entries;
}

async function getPersonaLore() {
    const chatWorlds = getChatWorldInfoNames();
    const personaWorld = power_user.persona_description_lorebook;

    if (!personaWorld) {
        return [];
    }

    if (chatWorlds.includes(personaWorld)) {
        console.debug(`[WI] Persona world ${personaWorld} is already activated in chat world! Skipping...`);
        return [];
    }

    if (selected_world_info.includes(personaWorld)) {
        console.debug(`[WI] Persona world ${personaWorld} is already activated in global world info! Skipping...`);
        return [];
    }

    const data = await loadWorldInfo(personaWorld);
    const entries = data ? Object.keys(data.entries).map((x) => data.entries[x]).map(({ uid, ...rest }) => ({ uid, world: personaWorld, ...rest })) : [];

    console.debug(`[WI] Persona lore has ${entries.length} entries`, [personaWorld]);

    return entries;
}

export async function getSortedEntries() {
    try {
        const [
            globalLore,
            characterLore,
            chatLore,
            personaLore,
        ] = await Promise.all([
            getGlobalLore(),
            getCharacterLore(),
            getChatLore(),
            getPersonaLore(),
        ]);

        await eventSource.emit(event_types.WORLDINFO_ENTRIES_LOADED, { globalLore, characterLore, chatLore, personaLore });

        let entries;

        switch (Number(world_info_character_strategy)) {
            case world_info_insertion_strategy.evenly:
                entries = [...globalLore, ...characterLore].sort(sortFn);
                break;
            case world_info_insertion_strategy.character_first:
                entries = [...characterLore.sort(sortFn), ...globalLore.sort(sortFn)];
                break;
            case world_info_insertion_strategy.global_first:
                entries = [...globalLore.sort(sortFn), ...characterLore.sort(sortFn)];
                break;
            default:
                console.error('[WI] Unknown WI insertion strategy:', world_info_character_strategy, 'defaulting to evenly');
                entries = [...globalLore, ...characterLore].sort(sortFn);
                break;
        }

        // Chat lore always goes first, then persona lore, then the rest
        entries = [...chatLore.sort(sortFn), ...personaLore.sort(sortFn), ...entries];

        // Calculate hash and parse decorators. Split maps to preserve old hashes.
        entries = entries.map((entry) => {
            const [decorators, content] = parseDecorators(entry.content || '');
            return { ...entry, decorators, content };
        }).map((entry) => {
            const hash = getStringHash(JSON.stringify(entry));
            return { ...entry, hash };
        });

        console.debug(`[WI] Found ${entries.length} world lore entries. Sorted by strategy`, Object.entries(world_info_insertion_strategy).find((x) => x[1] === world_info_character_strategy));

        // Need to deep clone the entries to avoid modifying the cached data
        return structuredClone(entries);
    } catch (e) {
        console.error(e);
        return [];
    }
}


/**
 * Parse decorators from worldinfo content
 * @param {string} content The content to parse
 * @returns {[string[],string]} The decorators found in the content and the content without decorators
*/
function parseDecorators(content) {
    /**
     * Check if the decorator is known
     * @param {string} data string to check
     * @returns {boolean} true if the decorator is known
    */
    const isKnownDecorator = (data) => {
        if (data.startsWith('@@@')) {
            data = data.substring(1);
        }

        for (let i = 0; i < KNOWN_DECORATORS.length; i++) {
            if (data.startsWith(KNOWN_DECORATORS[i])) {
                return true;
            }
        }
        return false;
    };

    if (content.startsWith('@@')) {
        let newContent = content;
        const splited = content.split('\n');
        let decorators = [];
        let fallbacked = false;

        for (let i = 0; i < splited.length; i++) {
            if (splited[i].startsWith('@@')) {
                if (splited[i].startsWith('@@@') && !fallbacked) {
                    continue;
                }

                if (isKnownDecorator(splited[i])) {
                    decorators.push(splited[i].startsWith('@@@') ? splited[i].substring(1) : splited[i]);
                    fallbacked = false;
                } else {
                    fallbacked = true;
                }
            } else {
                newContent = splited.slice(i).join('\n');
                break;
            }
        }
        return [decorators, newContent];
    }

    return [[], content];
}

/**
 * Performs a scan on the chat and returns the world info activated.
 * @param {string[]} chat The chat messages to scan, in reverse order.
 * @param {number} maxContext The maximum context size of the generation.
 * @param {boolean} isDryRun Whether to perform a dry run.
 * @param {WIGlobalScanData} globalScanData Chat independent context to be scanned
 * @returns {Promise<WIActivated>} The world info activated.
 */
//MARK: checkWorldInfo
export async function checkWorldInfo(chat, maxContext, isDryRun, globalScanData = defaultGlobalScanData) {
    const context = getContext();
    const buffer = new WorldInfoBuffer(chat, globalScanData);
    const activationTraceScopeKey = getActivationTraceScopeKey();
    const scanStartedAt = Date.now();
    const scanTraceByEntry = new Map();

    console.debug(`[WI] --- START WI SCAN (on ${chat.length} messages, trigger = ${globalScanData.trigger})${isDryRun ? ' (DRY RUN)' : ''} ---`);

    // Combine the chat

    // Add the depth or AN if enabled
    // Put this code here since otherwise, the chat reference is modified
    for (const key of Object.keys(context.extensionPrompts)) {
        if (context.extensionPrompts[key]?.scan) {
            const prompt = await getExtensionPromptByName(key);
            if (prompt) {
                buffer.addInject(prompt);
            }
        }
    }

    /** @type {scan_state} */
    let scanState = scan_state.INITIAL;
    let token_budget_overflowed = false;
    let count = 0;
    let allActivatedEntries = new Map();
    let failedProbabilityChecks = new Set();
    let allActivatedText = '';
    let recursionSourceEntryKeys = [];

    let budget = Math.round(world_info_budget * maxContext / 100) || 1;

    if (world_info_budget_cap > 0 && budget > world_info_budget_cap) {
        console.debug(`[WI] Budget ${budget} exceeds cap ${world_info_budget_cap}, using cap`);
        budget = world_info_budget_cap;
    }

    console.debug(`[WI] Context size: ${maxContext}; WI budget: ${budget} (max% = ${world_info_budget}%, cap = ${world_info_budget_cap})`);
    const sortedEntries = await getSortedEntries();
    const timedEffects = new WorldInfoTimedEffects(chat, sortedEntries, isDryRun);

    timedEffects.checkTimedEffects();

    if (sortedEntries.length === 0) {
        return {
            worldInfoBeforeEntries: [],
            worldInfoAfterEntries: [],
            WIDepthEntries: [],
            EMEntries: [],
            ANBeforeEntries: [],
            ANAfterEntries: [],
            outletEntries: {},
            allActivatedEntries: new Set(),
        };
    }

    /** @type {number[]} Represents the delay levels for entries that are delayed until recursion */
    const availableRecursionDelayLevels = [...new Set(sortedEntries
        .filter(entry => entry.delayUntilRecursion)
        .map(entry => entry.delayUntilRecursion === true ? 1 : entry.delayUntilRecursion),
    )].sort((a, b) => a - b);
    // Already preset with the first level
    let currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0;
    if (currentRecursionDelayLevel > 0 && availableRecursionDelayLevels.length) {
        console.debug('[WI] Preparing first delayed recursion level', currentRecursionDelayLevel, '. Still delayed:', availableRecursionDelayLevels);
    }

    function makeTraceKey(entry) {
        return `${entry.world}.${entry.uid}`;
    }

    function getRecursionTraceSources(state = scanState) {
        if (state !== scan_state.RECURSION || !recursionSourceEntryKeys.length) {
            return [];
        }
        return [...new Set(recursionSourceEntryKeys)];
    }

    function withRecursionTraceSources(details = {}, state = scanState) {
        const sources = getRecursionTraceSources(state);
        if (!sources.length) {
            return details;
        }
        return {
            ...details,
            recursionSourceEntries: sources,
        };
    }

    function recordActivationAttempt(entry, reason, details = {}, loopCount = count, state = scanState) {
        if (!entry || entry.uid === undefined || !entry.world) {
            return;
        }
        const key = makeTraceKey(entry);
        const existing = scanTraceByEntry.get(key) || {
            world: String(entry.world || ''),
            uid: Number(entry.uid),
            recentScans: [],
            attempts: [],
            activated: false,
            lastActivation: null,
        };
        existing.attempts.push({
            loop: Number(loopCount || 0),
            scanState: getScanStateName(state),
            trigger: String(globalScanData.trigger || 'normal'),
            scanDepth: Number(entry.scanDepth ?? buffer.getDepth()),
            reason: String(reason || ''),
            details: details && typeof details === 'object' ? details : {},
        });
        scanTraceByEntry.set(key, existing);
    }

    function recordActivationSuccess(entry, details = {}, loopCount = count, state = scanState) {
        if (!entry || entry.uid === undefined || !entry.world) {
            return;
        }
        const key = makeTraceKey(entry);
        const existing = scanTraceByEntry.get(key) || {
            world: String(entry.world || ''),
            uid: Number(entry.uid),
            recentScans: [],
            attempts: [],
            activated: false,
            lastActivation: null,
        };
        existing.activated = true;
        existing.lastActivation = {
            loop: Number(loopCount || 0),
            scanState: getScanStateName(state),
            trigger: String(globalScanData.trigger || 'normal'),
            scanDepth: Number(entry.scanDepth ?? buffer.getDepth()),
            details: details && typeof details === 'object' ? details : {},
        };
        scanTraceByEntry.set(key, existing);
    }

    console.debug(`[WI] --- SEARCHING ENTRIES (on ${sortedEntries.length} entries) ---`);

    while (scanState) {
        //if world_info_max_recursion_steps is non-zero min activations are disabled, and vice versa
        if (world_info_max_recursion_steps && world_info_max_recursion_steps <= count) {
            console.debug('[WI] Search stopped by reaching max recursion steps', world_info_max_recursion_steps);
            break;
        }

        // Track how many times the loop has run. May be useful for debugging.
        count++;

        console.debug(`[WI] --- LOOP #${count} START ---`);
        console.debug('[WI] Scan state', Object.entries(scan_state).find(x => x[1] === scanState));

        // Until decided otherwise, we set the loop to stop scanning after this
        let nextScanState = scan_state.NONE;

        // Loop and find all entries that can activate here
        let activatedNow = new Set();

        for (const entry of sortedEntries) {
            // Logging preparation
            let headerLogged = false;
            function log(...args) {
                if (!headerLogged) {
                    console.debug(`[WI] Entry ${entry.uid}`, `from '${entry.world}' processing`, entry);
                    headerLogged = true;
                }
                console.debug(`[WI] Entry ${entry.uid}`, ...args);
            }

            // Already processed, considered and then skipped entries should still be skipped
            if (failedProbabilityChecks.has(entry) || allActivatedEntries.has(`${entry.world}.${entry.uid}`)) {
                continue;
            }

            if (entry.disable == true) {
                log('disabled');
                continue;
            }

            // Check for generation type trigger filter
            if (Array.isArray(entry.triggers) && entry.triggers.length > 0) {
                const isTriggered = entry.triggers.includes(globalScanData.trigger);
                if (!isTriggered) {
                    log(`skipped by generation type trigger filter (${globalScanData.trigger} ∉ ${entry.triggers})`);
                    continue;
                }
            }

            // Check if this entry applies to the character or if it's excluded
            if (entry.characterFilter && entry.characterFilter?.names?.length > 0) {
                const nameIncluded = entry.characterFilter.names.includes(getCharaFilename());
                const filtered = entry.characterFilter.isExclude ? nameIncluded : !nameIncluded;

                if (filtered) {
                    log('filtered out by character');
                    continue;
                }
            }

            if (entry.characterFilter && entry.characterFilter?.tags?.length > 0) {
                const tagKey = getTagKeyForEntity(this_chid);

                if (tagKey) {
                    const tagMapEntry = context.tagMap[tagKey];

                    if (Array.isArray(tagMapEntry)) {
                        // If tag map intersects with the tag exclusion list, skip
                        const includesTag = tagMapEntry.some((tag) => entry.characterFilter.tags.includes(tag));
                        const filtered = entry.characterFilter.isExclude ? includesTag : !includesTag;

                        if (filtered) {
                            log('filtered out by tag');
                            continue;
                        }
                    }
                }
            }

            const isSticky = timedEffects.isEffectActive('sticky', entry);
            const isCooldown = timedEffects.isEffectActive('cooldown', entry);
            const isDelay = timedEffects.isEffectActive('delay', entry);

            if (isDelay) {
                log('suppressed by delay');
                continue;
            }

            if (isCooldown && !isSticky) {
                log('suppressed by cooldown');
                continue;
            }

            // Only use checks for recursion flags if the scan step was activated by recursion
            if (scanState !== scan_state.RECURSION && entry.delayUntilRecursion && !isSticky) {
                log('suppressed by delay until recursion');
                continue;
            }

            if (scanState === scan_state.RECURSION && entry.delayUntilRecursion && entry.delayUntilRecursion > currentRecursionDelayLevel && !isSticky) {
                log('suppressed by delay until recursion level', entry.delayUntilRecursion, '. Currently', currentRecursionDelayLevel);
                continue;
            }

            if (scanState === scan_state.RECURSION && world_info_recursive && entry.excludeRecursion && !isSticky) {
                log('suppressed by exclude recursion');
                continue;
            }

            if (entry.decorators.includes('@@activate')) {
                log('activated by @@activate decorator');
                recordActivationAttempt(
                    entry,
                    'decorator_activate',
                    withRecursionTraceSources({ decorator: '@@activate' }),
                );
                activatedNow.add(entry);
                continue;
            }

            if (entry.decorators.includes('@@dont_activate')) {
                log('suppressed by @@dont_activate decorator');
                continue;
            }

            const externallyActivated = buffer.getExternallyActivated(entry);
            if (externallyActivated) {
                log('externally activated');
                recordActivationAttempt(
                    externallyActivated,
                    'external_activation',
                    withRecursionTraceSources({ sourceEntry: makeTraceKey(entry) }),
                );
                activatedNow.add(externallyActivated);
                continue;
            }

            // Now do checks for immediate activations
            if (entry.constant) {
                log('activated because of constant');
                recordActivationAttempt(
                    entry,
                    'constant',
                    withRecursionTraceSources({ constant: true }),
                );
                activatedNow.add(entry);
                continue;
            }

            if (isSticky) {
                log('activated because active sticky');
                recordActivationAttempt(
                    entry,
                    'sticky',
                    withRecursionTraceSources({ sticky: true }),
                );
                activatedNow.add(entry);
                continue;
            }

            if (!Array.isArray(entry.key) || !entry.key.length) {
                log('has no keys defined, skipped');
                continue;
            }

            // Cache the text to scan before the loop, it won't change its content
            const textToScan = buffer.get(entry, scanState);

            // PRIMARY KEYWORDS
            let primaryKeyMatch = entry.key.find(key => {
                const substituted = substituteParams(key);
                return substituted && buffer.matchKeys(textToScan, substituted.trim(), entry);
            });

            if (!primaryKeyMatch) {
                // Don't write logs for simple no-matches
                continue;
            }

            const substitutedPrimary = String(substituteParams(primaryKeyMatch) || primaryKeyMatch || '').trim();
            const matchSourceHints = substitutedPrimary
                ? buffer.getMatchSourceHints(entry, substitutedPrimary, scanState)
                : [];

            const hasSecondaryKeywords = (
                entry.selective && //all entries are selective now
                Array.isArray(entry.keysecondary) && //always true
                entry.keysecondary.length //ignore empties
            );

            if (!hasSecondaryKeywords) {
                // Handle cases where secondary is empty
                log('activated by primary key match', primaryKeyMatch);
                recordActivationAttempt(
                    entry,
                    'key_match',
                    withRecursionTraceSources({
                        primaryKey: substitutedPrimary || String(primaryKeyMatch || ''),
                        sourceHints: matchSourceHints,
                        selectiveLogic: 'none',
                    }),
                );
                activatedNow.add(entry);
                continue;
            }


            // SECONDARY KEYWORDS
            const selectiveLogic = entry.selectiveLogic ?? 0; // If selectiveLogic isn't found, assume it's AND, only do this once per entry
            log('Entry with primary key match', primaryKeyMatch, 'has secondary keywords. Checking with logic logic', Object.entries(world_info_logic).find(x => x[1] === entry.selectiveLogic));

            /** @type {() => boolean} */
            function matchSecondaryKeys() {
                let hasAnyMatch = false;
                let hasAllMatch = true;
                const matchedSecondaryKeys = [];
                for (let keysecondary of entry.keysecondary) {
                    const secondarySubstituted = substituteParams(keysecondary);
                    const hasSecondaryMatch = secondarySubstituted && buffer.matchKeys(textToScan, secondarySubstituted.trim(), entry);

                    if (hasSecondaryMatch) hasAnyMatch = true;
                    if (!hasSecondaryMatch) hasAllMatch = false;
                    if (hasSecondaryMatch) {
                        matchedSecondaryKeys.push(secondarySubstituted.trim());
                    }

                    // Simplified AND ANY / NOT ALL if statement. (Proper fix for PR#1356 by Bronya)
                    // If AND ANY logic and the main checks pass OR if NOT ALL logic and the main checks do not pass
                    if (selectiveLogic === world_info_logic.AND_ANY && hasSecondaryMatch) {
                        log('activated. (AND ANY) Found match secondary keyword', secondarySubstituted);
                        recordActivationAttempt(
                            entry,
                            'key_match',
                            withRecursionTraceSources({
                                primaryKey: substitutedPrimary || String(primaryKeyMatch || ''),
                                sourceHints: matchSourceHints,
                                selectiveLogic: 'AND_ANY',
                                matchedSecondaryKeys,
                            }),
                        );
                        return true;
                    }
                    if (selectiveLogic === world_info_logic.NOT_ALL && !hasSecondaryMatch) {
                        log('activated. (NOT ALL) Found not matching secondary keyword', secondarySubstituted);
                        recordActivationAttempt(
                            entry,
                            'key_match',
                            withRecursionTraceSources({
                                primaryKey: substitutedPrimary || String(primaryKeyMatch || ''),
                                sourceHints: matchSourceHints,
                                selectiveLogic: 'NOT_ALL',
                                matchedSecondaryKeys,
                            }),
                        );
                        return true;
                    }
                }

                // Handle NOT ANY logic
                if (selectiveLogic === world_info_logic.NOT_ANY && !hasAnyMatch) {
                    log('activated. (NOT ANY) No secondary keywords found', entry.keysecondary);
                    recordActivationAttempt(
                        entry,
                        'key_match',
                        withRecursionTraceSources({
                            primaryKey: substitutedPrimary || String(primaryKeyMatch || ''),
                            sourceHints: matchSourceHints,
                            selectiveLogic: 'NOT_ANY',
                            matchedSecondaryKeys: [],
                        }),
                    );
                    return true;
                }

                // Handle AND ALL logic
                if (selectiveLogic === world_info_logic.AND_ALL && hasAllMatch) {
                    log('activated. (AND ALL) All secondary keywords found', entry.keysecondary);
                    recordActivationAttempt(
                        entry,
                        'key_match',
                        withRecursionTraceSources({
                            primaryKey: substitutedPrimary || String(primaryKeyMatch || ''),
                            sourceHints: matchSourceHints,
                            selectiveLogic: 'AND_ALL',
                            matchedSecondaryKeys: entry.keysecondary.map(x => String(substituteParams(x) || x || '').trim()).filter(Boolean),
                        }),
                    );
                    return true;
                }

                return false;
            }

            const matched = matchSecondaryKeys();
            if (!matched) {
                log('skipped. Secondary keywords not satisfied', entry.keysecondary);
                recordActivationAttempt(
                    entry,
                    'secondary_key_miss',
                    withRecursionTraceSources({
                        primaryKey: substitutedPrimary || String(primaryKeyMatch || ''),
                        sourceHints: matchSourceHints,
                        selectiveLogic: Object.entries(world_info_logic).find(x => x[1] === selectiveLogic)?.[0] || String(selectiveLogic),
                        secondaryKeys: entry.keysecondary.map(x => String(substituteParams(x) || x || '').trim()).filter(Boolean),
                    }),
                );
                continue;
            }

            // Success logging was already done inside the function, so just add the entry
            activatedNow.add(entry);
            continue;
        }

        console.debug(`[WI] Search done. Found ${activatedNow.size} possible entries.`);

        // Sort the entries for the probability and the budget limit checks
        const newEntries = [...activatedNow]
            .sort((a, b) => {
                const isASticky = timedEffects.isEffectActive('sticky', a) ? 1 : 0;
                const isBSticky = timedEffects.isEffectActive('sticky', b) ? 1 : 0;
                return isBSticky - isASticky || sortedEntries.indexOf(a) - sortedEntries.indexOf(b);
            });


        let newContent = '';
        const textToScanTokens = await getTokenCountAsync(allActivatedText);
        const entriesBeforeGroupFilter = [...newEntries];
        filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);
        for (const groupedOutEntry of entriesBeforeGroupFilter) {
            if (!newEntries.includes(groupedOutEntry)) {
                recordActivationAttempt(
                    groupedOutEntry,
                    'inclusion_group_filtered',
                    withRecursionTraceSources({
                        group: String(groupedOutEntry.group || ''),
                    }),
                );
            }
        }

        console.debug('[WI] --- PROBABILITY CHECKS ---');
        !newEntries.length && console.debug('[WI] No probability checks to do');

        let ignoresBudget = newEntries.filter(e => e.ignoreBudget).length;

        for (const entry of newEntries) {
            ignoresBudget -= (entry.ignoreBudget ? 1 : 0);
            if (token_budget_overflowed && !entry.ignoreBudget) {
                if (ignoresBudget > 0) {
                    continue;
                }
                break;
            }

            function verifyProbability() {
                // If we don't need to roll, it's always true
                if (!entry.useProbability || entry.probability === 100) {
                    console.debug(`WI entry ${entry.uid} does not use probability`);
                    return true;
                }

                const isSticky = timedEffects.isEffectActive('sticky', entry);
                if (isSticky) {
                    console.debug(`WI entry ${entry.uid} is sticky, does not need to re-roll probability`);
                    return true;
                }

                const rollValue = Math.random() * 100;
                if (rollValue <= entry.probability) {
                    console.debug(`WI entry ${entry.uid} passed probability check of ${entry.probability}%`);
                    return true;
                }

                failedProbabilityChecks.add(entry);
                return false;
            }

            const success = verifyProbability();
            if (!success) {
                console.debug(`WI entry ${entry.uid} failed probability check, removing from activated entries`, entry);
                recordActivationAttempt(
                    entry,
                    'probability_failed',
                    withRecursionTraceSources({
                        useProbability: Boolean(entry.useProbability),
                        probability: Number(entry.probability ?? 100),
                    }),
                );
                continue;
            }

            // Substitute macros inline, for both this checking and also future processing
            entry.content = substituteParams(entry.content);
            newContent += `${entry.content}\n`;

            if (!entry.ignoreBudget && (textToScanTokens + (await getTokenCountAsync(newContent))) >= budget) {
                if (!token_budget_overflowed) {
                    console.debug('[WI] --- BUDGET OVERFLOW CHECK ---');
                    if (world_info_overflow_alert) {
                        console.warn(`[WI] budget of ${budget} reached, stopping after ${allActivatedEntries.size} entries`);
                        toastr.warning(`World info budget reached after ${allActivatedEntries.size} entries.`, 'World Info');
                    } else {
                        console.debug(`[WI] budget of ${budget} reached, stopping after ${allActivatedEntries.size} entries`);
                    }
                    token_budget_overflowed = true;
                }
                recordActivationAttempt(
                    entry,
                    'budget_overflow',
                    withRecursionTraceSources({
                        budget: Number(budget),
                        ignoreBudget: Boolean(entry.ignoreBudget),
                    }),
                );
                continue;
            }

            allActivatedEntries.set(`${entry.world}.${entry.uid}`, entry);
            recordActivationSuccess(
                entry,
                withRecursionTraceSources({
                    reason: 'added_to_prompt',
                    ignoreBudget: Boolean(entry.ignoreBudget),
                    useProbability: Boolean(entry.useProbability),
                    probability: Number(entry.probability ?? 100),
                }),
            );
            console.debug(`[WI] Entry ${entry.uid} activation successful, adding to prompt`, entry);
        }

        const successfulNewEntries = newEntries.filter(x => !failedProbabilityChecks.has(x));
        const successfulNewEntriesForRecursion = successfulNewEntries.filter(x => !x.preventRecursion);

        console.debug(`[WI] --- LOOP #${count} RESULT ---`);
        if (!newEntries.length) {
            console.debug('[WI] No new entries activated.');
        } else if (!successfulNewEntries.length) {
            console.debug('[WI] Probability checks failed for all activated entries. No new entries activated.');
        } else {
            console.debug(`[WI] Successfully activated ${successfulNewEntries.length} new entries to prompt. ${allActivatedEntries.size} total entries activated.`, successfulNewEntries);
        }

        function logNextState(...args) {
            args.length && console.debug(args.shift(), ...args);
            console.debug('[WI] Setting scan state', Object.entries(scan_state).find(x => x[1] === scanState));
        }

        // After processing and rolling entries is done, see if we should continue with normal recursion
        if (world_info_recursive && !token_budget_overflowed && successfulNewEntriesForRecursion.length) {
            nextScanState = scan_state.RECURSION;
            logNextState('[WI] Found', successfulNewEntriesForRecursion.length, 'new entries for recursion');
        }

        // If we are inside min activations scan, and we have recursive buffer, we should do a recursive scan before increasing the buffer again
        // There might be recurse-trigger-able entries that match the buffer, so we need to check that
        if (world_info_recursive && !token_budget_overflowed && scanState === scan_state.MIN_ACTIVATIONS && buffer.hasRecurse()) {
            nextScanState = scan_state.RECURSION;
            logNextState('[WI] Min Activations run done, whill will always be followed by a recursive scan');
        }

        // If scanning is planned to stop, but min activations is set and not satisfied, check if we should continue
        const minActivationsNotSatisfied = world_info_min_activations > 0 && (allActivatedEntries.size < world_info_min_activations);
        if (!nextScanState && !token_budget_overflowed && minActivationsNotSatisfied) {
            console.debug('[WI] --- MIN ACTIVATIONS CHECK ---');

            let over_max = (
                world_info_min_activations_depth_max > 0 &&
                buffer.getDepth() > world_info_min_activations_depth_max
            ) || (buffer.getDepth() > chat.length);

            if (!over_max) {
                nextScanState = scan_state.MIN_ACTIVATIONS; // loop
                logNextState(`[WI] Min activations not reached (${allActivatedEntries.size}/${world_info_min_activations}), advancing depth to ${buffer.getDepth() + 1}, starting another scan`);
                buffer.advanceScan();
            } else {
                console.debug(`[WI] Min activations not reached (${allActivatedEntries.size}/${world_info_min_activations}), but reached on of depth. Stopping`);
            }
        }

        // If the scan is done, but we still have open "delay until recursion" levels, we should continue with the next one
        if (nextScanState === scan_state.NONE && availableRecursionDelayLevels.length) {
            nextScanState = scan_state.RECURSION;
            currentRecursionDelayLevel = availableRecursionDelayLevels.shift();
            logNextState('[WI] Open delayed recursion levels left. Preparing next delayed recursion level', currentRecursionDelayLevel, '. Still delayed:', availableRecursionDelayLevels);
        }

        // Final check if we should really continue scan, and extend the current WI recurse buffer
        const curScanState = scanState;
        scanState = nextScanState;
        if (scanState) {
            const text = successfulNewEntriesForRecursion
                .map(x => x.content).join('\n');
            if (text) {
                buffer.addRecurse(text);
                allActivatedText = (text + '\n' + allActivatedText);
            }
            if (scanState === scan_state.RECURSION) {
                recursionSourceEntryKeys = successfulNewEntriesForRecursion.map(entry => makeTraceKey(entry));
            } else {
                recursionSourceEntryKeys = [];
            }
        } else {
            logNextState('[WI] Scan done. No new entries to prompt. Stopping.');
            recursionSourceEntryKeys = [];
        }

        // Fire an event after each scan loop, so extensions can hook into the current scanning state
        const args = {
            state: {
                current: curScanState,
                next: scanState,
                loopCount: count,
            },
            new: {
                all: newEntries,
                successful: successfulNewEntries,
            },
            activated: {
                entries: allActivatedEntries,
                text: allActivatedText,
            },
            sortedEntries,
            recursionDelay: {
                availableLevels: availableRecursionDelayLevels,
                currentLevel: currentRecursionDelayLevel,
            },
            budget: {
                current: budget,
                overflowed: token_budget_overflowed,
            },
            timedEffects,
        };
        await eventSource.emit(event_types.WORLDINFO_SCAN_DONE, args);

        // Some fields are allowed to be changed by listeners, those will be handled here manually. They can be updated via changed the args from the listeners.
        // Any array provided directly can be modified by updating it's elements, adding or removing elements. This has to be done consistently.
        if (args.state.next !== scanState) {
            logNextState('[WI] Scan state changed from', scanState, 'to', args.state.next);
            scanState = args.state.next;
        }
        allActivatedText = args.activated.text;
        currentRecursionDelayLevel = args.recursionDelay.currentLevel;
        budget = args.budget.current;
        token_budget_overflowed = args.budget.overflowed;
    }

    if (scanTraceByEntry.size > 0) {
        const bucket = getOrCreateActivationTraceBucket(activationTraceScopeKey);
        const scanFinishedAt = Date.now();
        for (const [entryKey, traceState] of scanTraceByEntry.entries()) {
            const previous = bucket.get(entryKey) || {
                world: String(traceState.world || ''),
                uid: Number(traceState.uid),
                lastActivatedAt: null,
                lastActivation: null,
                recentScans: [],
                lastDryRunScanAt: null,
                lastDryRunActivation: null,
                recentDryRunScans: [],
            };

            const scanRecord = {
                startedAt: scanStartedAt,
                finishedAt: scanFinishedAt,
                trigger: String(globalScanData.trigger || 'normal'),
                dryRun: Boolean(isDryRun),
                activated: Boolean(traceState.activated),
                attempts: Array.isArray(traceState.attempts) ? traceState.attempts : [],
                lastActivation: traceState.lastActivation || null,
            };

            previous.world = String(traceState.world || previous.world || '');
            previous.uid = Number(traceState.uid);
            if (isDryRun) {
                const previousDryScans = Array.isArray(previous.recentDryRunScans) ? previous.recentDryRunScans : [];
                previous.recentDryRunScans = [scanRecord, ...previousDryScans].slice(0, WI_ACTIVATION_TRACE_SCAN_LIMIT);
                previous.lastDryRunScanAt = scanFinishedAt;
                previous.lastDryRunActivation = traceState.lastActivation || null;
            } else {
                const previousScans = Array.isArray(previous.recentScans) ? previous.recentScans : [];
                previous.recentScans = [scanRecord, ...previousScans].slice(0, WI_ACTIVATION_TRACE_SCAN_LIMIT);
                if (traceState.lastActivation) {
                    previous.lastActivation = traceState.lastActivation;
                    previous.lastActivatedAt = scanFinishedAt;
                }
            }

            bucket.set(entryKey, previous);
        }
    }

    console.debug('[WI] --- BUILDING PROMPT ---');

    // Forward-sorted list of entries for joining
    const WIBeforeEntries = [];
    const WIAfterEntries = [];
    const EMEntries = [];
    const ANTopEntries = [];
    const ANBottomEntries = [];
    const WIDepthEntries = [];
    /** @type {{[key: string]: string[]}} */
    const WIOutletEntries = {};

    // Appends from insertion order 999 to 1. Use unshift for this purpose
    // TODO (kingbri): Change to use WI Anchor positioning instead of separate top/bottom arrays
    [...allActivatedEntries.values()].sort(sortFn).forEach((entry) => {
        const regexDepth = entry.position === world_info_position.atDepth ? (entry.depth ?? DEFAULT_DEPTH) : null;
        const content = getRegexedString(entry.content, regex_placement.WORLD_INFO, { depth: regexDepth, isMarkdown: false, isPrompt: true });

        if (!content) {
            console.debug(`[WI] Entry ${entry.uid}`, 'skipped adding to prompt due to empty content', entry);
            return;
        }

        switch (entry.position) {
            case world_info_position.before:
                WIBeforeEntries.unshift(content);
                break;
            case world_info_position.after:
                WIAfterEntries.unshift(content);
                break;
            case world_info_position.EMTop:
                EMEntries.unshift(
                    { position: wi_anchor_position.before, content: content },
                );
                break;
            case world_info_position.EMBottom:
                EMEntries.unshift(
                    { position: wi_anchor_position.after, content: content },
                );
                break;
            case world_info_position.ANTop:
                ANTopEntries.unshift(content);
                break;
            case world_info_position.ANBottom:
                ANBottomEntries.unshift(content);
                break;
            case world_info_position.atDepth: {
                const existingDepthIndex = WIDepthEntries.findIndex((e) => e.depth === (entry.depth ?? DEFAULT_DEPTH) && e.role === (entry.role ?? extension_prompt_roles.SYSTEM));
                if (existingDepthIndex !== -1) {
                    WIDepthEntries[existingDepthIndex].entries.unshift(content);
                } else {
                    WIDepthEntries.push({
                        depth: entry.depth,
                        entries: [content],
                        role: entry.role ?? extension_prompt_roles.SYSTEM,
                    });
                }
                break;
            }
            case world_info_position.outlet: {
                if (!entry.outletName) {
                    console.warn(`[WI] Entry ${entry.uid} has position 'outlet' but no outlet name. Skipping.`);
                    break;
                }
                if (Array.isArray(WIOutletEntries[entry.outletName])) {
                    WIOutletEntries[entry.outletName].push(content);
                } else {
                    WIOutletEntries[entry.outletName] = [content];
                }
                break;
            }
            default:
                break;
        }
    });

    if (shouldWIAddPrompt) {
        const originalAN = context.extensionPrompts[NOTE_MODULE_NAME].value;
        const ANWithWI = `${ANTopEntries.join('\n')}\n${originalAN}\n${ANBottomEntries.join('\n')}`.replace(/(^\n)|(\n$)/g, '');
        context.setExtensionPrompt(NOTE_MODULE_NAME, ANWithWI, chat_metadata[metadata_keys.position], chat_metadata[metadata_keys.depth], extension_settings.note.allowWIScan, chat_metadata[metadata_keys.role]);
    }

    timedEffects.setTimedEffects(Array.from(allActivatedEntries.values()));
    buffer.resetExternalEffects();
    timedEffects.cleanUp();

    console.log(`[WI] ${isDryRun ? 'Hypothetically adding' : 'Adding'} ${allActivatedEntries.size} entries to prompt`, Array.from(allActivatedEntries.values()));
    console.debug(`[WI] --- DONE${isDryRun ? ' (DRY RUN)' : ''} ---`);

    return {
        worldInfoBeforeEntries: [...WIBeforeEntries],
        worldInfoAfterEntries: [...WIAfterEntries],
        EMEntries,
        WIDepthEntries,
        ANBeforeEntries: ANTopEntries,
        ANAfterEntries: ANBottomEntries,
        outletEntries: WIOutletEntries,
        allActivatedEntries: new Set(allActivatedEntries.values()),
    };
}

/**
 * Only leaves entries with the highest key matching score in each group.
 * @param {Record<string, WIScanEntry[]>} groups The groups to filter
 * @param {WorldInfoBuffer} buffer The buffer to use for scoring
 * @param {(entry: WIScanEntry) => void} removeEntry The function to remove an entry
 * @param {number} scanState The current scan state
 * @param {Map<string, boolean>} hasStickyMap The sticky entries map
 */
function filterGroupsByScoring(groups, buffer, removeEntry, scanState, hasStickyMap) {
    for (const [key, group] of Object.entries(groups)) {
        // Group scoring is disabled both globally and for the group entries
        if (!world_info_use_group_scoring && !group.some(x => x.useGroupScoring)) {
            console.debug(`[WI] Skipping group scoring for group '${key}'`);
            continue;
        }

        // If the group has any sticky entries, the rest are already removed by the timed effects filter
        const hasAnySticky = hasStickyMap.get(key);
        if (hasAnySticky) {
            console.debug(`[WI] Skipping group scoring check, group '${key}' has sticky entries`);
            continue;
        }

        const scores = group.map(entry => buffer.getScore(entry, scanState));
        const maxScore = Math.max(...scores);
        console.debug(`[WI] Group '${key}' max score:`, maxScore);
        //console.table(group.map((entry, i) => ({ uid: entry.uid, key: JSON.stringify(entry.key), score: scores[i] })));

        for (let i = 0; i < group.length; i++) {
            const isScored = group[i].useGroupScoring ?? world_info_use_group_scoring;

            if (!isScored) {
                continue;
            }

            if (scores[i] < maxScore) {
                console.debug(`[WI] Entry ${group[i].uid}`, `removed as score loser from inclusion group '${key}'`, group[i]);
                removeEntry(group[i]);
                group.splice(i, 1);
                scores.splice(i, 1);
                i--;
            }
        }
    }
}

/**
 * Removes entries on cooldown and forces sticky entries as winners.
 * @param {Record<string, WIScanEntry[]>} groups The groups to filter
 * @param {WorldInfoTimedEffects} timedEffects The timed effects to use
 * @param {(entry: WIScanEntry) => void} removeEntry The function to remove an entry
 * @returns {Map<string, boolean>} If any sticky entries were found
 */
function filterGroupsByTimedEffects(groups, timedEffects, removeEntry) {
    /** @type {Map<string, boolean>} */
    const hasStickyMap = new Map();

    for (const [key, group] of Object.entries(groups)) {
        hasStickyMap.set(key, false);

        // If the group has any sticky entries, leave only the sticky entries
        const stickyEntries = group.filter(x => timedEffects.isEffectActive('sticky', x));
        if (stickyEntries.length) {
            for (const entry of group) {
                if (stickyEntries.includes(entry)) {
                    continue;
                }

                console.debug(`[WI] Entry ${entry.uid}`, `removed as a non-sticky loser from inclusion group '${key}'`, entry);
                removeEntry(entry);
            }

            hasStickyMap.set(key, true);
        }

        // It should not be possible for an entry on cooldown/delay to event get into the grouping phase but @Wolfsblvt told me to leave it here.
        const cooldownEntries = group.filter(x => timedEffects.isEffectActive('cooldown', x));
        if (cooldownEntries.length) {
            console.debug(`[WI] Inclusion group '${key}' has entries on cooldown. They will be removed.`, cooldownEntries);
            for (const entry of cooldownEntries) {
                removeEntry(entry);
            }
        }

        const delayEntries = group.filter(x => timedEffects.isEffectActive('delay', x));
        if (delayEntries.length) {
            console.debug(`[WI] Inclusion group '${key}' has entries with delay. They will be removed.`, delayEntries);
            for (const entry of delayEntries) {
                removeEntry(entry);
            }
        }
    }

    return hasStickyMap;
}

/**
 * Filters entries by inclusion groups.
 * @param {object[]} newEntries Entries activated on current recursion level
 * @param {Map<string, object>} allActivatedEntries Map of all activated entries
 * @param {WorldInfoBuffer} buffer The buffer to use for scanning
 * @param {number} scanState The current scan state
 * @param {WorldInfoTimedEffects} timedEffects The timed effects currently active
 */
function filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects) {
    console.debug('[WI] --- INCLUSION GROUP CHECKS ---');

    const grouped = newEntries.filter(x => x.group).reduce((acc, item) => {
        item.group.split(/,\s*/).filter(x => x).forEach(group => {
            if (!acc[group]) {
                acc[group] = [];
            }
            acc[group].push(item);
        });
        return acc;
    }, {});

    if (Object.keys(grouped).length === 0) {
        console.debug('[WI] No inclusion groups found');
        return;
    }

    const removeEntry = (entry) => newEntries.splice(newEntries.indexOf(entry), 1);
    function removeAllBut(group, chosen, logging = true) {
        for (const entry of group) {
            if (entry === chosen) {
                continue;
            }

            if (logging) console.debug(`[WI] Entry ${entry.uid}`, `removed as loser from inclusion group '${entry.group}'`, entry);
            removeEntry(entry);
        }
    }

    const hasStickyMap = filterGroupsByTimedEffects(grouped, timedEffects, removeEntry);
    filterGroupsByScoring(grouped, buffer, removeEntry, scanState, hasStickyMap);

    for (const [key, group] of Object.entries(grouped)) {
        console.debug(`[WI] Checking inclusion group '${key}' with ${group.length} entries`, group);

        // If the group has any sticky entries, the rest are already removed by the timed effects filter
        const hasAnySticky = hasStickyMap.get(key);
        if (hasAnySticky) {
            console.debug(`[WI] Skipping inclusion group check, group '${key}' has sticky entries`);
            continue;
        }

        if (Array.from(allActivatedEntries.values()).some(x => x.group === key)) {
            console.debug(`[WI] Skipping inclusion group check, group '${key}' was already activated`);
            // We need to forcefully deactivate all other entries in the group
            removeAllBut(group, null, false);
            continue;
        }

        if (!Array.isArray(group) || group.length <= 1) {
            console.debug('[WI] Skipping inclusion group check, only one entry');
            continue;
        }

        // Check for group prio
        const prios = group.filter(x => x.groupOverride).sort(sortFn);
        if (prios.length) {
            console.debug(`[WI] Entry ${prios[0].uid}`, `activated as prio winner from inclusion group '${key}'`, prios[0]);
            removeAllBut(group, prios[0]);
            continue;
        }

        // Do weighted random using entry's weight
        const totalWeight = group.reduce((acc, item) => acc + (item.groupWeight ?? DEFAULT_WEIGHT), 0);
        const rollValue = Math.random() * totalWeight;
        let currentWeight = 0;
        let winner = null;

        for (const entry of group) {
            currentWeight += (entry.groupWeight ?? DEFAULT_WEIGHT);

            if (rollValue <= currentWeight) {
                console.debug(`[WI] Entry ${entry.uid}`, `activated as roll winner from inclusion group '${key}'`, entry);
                winner = entry;
                break;
            }
        }

        if (!winner) {
            console.debug(`[WI] Failed to activate inclusion group '${key}', no winner found`);
            continue;
        }

        // Remove every group item from newEntries but the winner
        removeAllBut(group, winner);
    }
}

function convertAgnaiMemoryBook(inputObj) {
    const outputObj = { entries: {} };

    inputObj.entries.forEach((entry, index) => {
        outputObj.entries[index] = {
            ...newWorldInfoEntryTemplate,
            uid: index,
            key: entry.keywords,
            keysecondary: [],
            comment: entry.name,
            content: entry.entry,
            constant: false,
            selective: false,
            vectorized: false,
            selectiveLogic: world_info_logic.AND_ANY,
            order: entry.weight,
            position: 0,
            disable: !entry.enabled,
            addMemo: !!entry.name,
            excludeRecursion: false,
            delayUntilRecursion: false,
            displayIndex: index,
            probability: 100,
            useProbability: true,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: DEFAULT_WEIGHT,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: extension_prompt_roles.SYSTEM,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            ignoreBudget: false,
        };
    });

    return outputObj;
}

function convertRisuLorebook(inputObj) {
    const outputObj = { entries: {} };

    inputObj.data.forEach((entry, index) => {
        outputObj.entries[index] = {
            ...newWorldInfoEntryTemplate,
            uid: index,
            key: entry.key.split(',').map(x => x.trim()),
            keysecondary: entry.secondkey ? entry.secondkey.split(',').map(x => x.trim()) : [],
            comment: entry.comment,
            content: entry.content,
            constant: entry.alwaysActive,
            selective: entry.selective,
            vectorized: false,
            selectiveLogic: world_info_logic.AND_ANY,
            order: entry.insertorder,
            position: world_info_position.before,
            disable: false,
            addMemo: true,
            excludeRecursion: false,
            delayUntilRecursion: false,
            displayIndex: index,
            probability: entry.activationPercent ?? 100,
            useProbability: entry.activationPercent ?? true,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: DEFAULT_WEIGHT,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: extension_prompt_roles.SYSTEM,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            ignoreBudget: false,
        };
    });

    return outputObj;
}

function convertNovelLorebook(inputObj) {
    const outputObj = {
        entries: {},
    };

    inputObj.entries.forEach((entry, index) => {
        const displayName = entry.displayName;
        const addMemo = displayName !== undefined && displayName.trim() !== '';

        outputObj.entries[index] = {
            ...newWorldInfoEntryTemplate,
            uid: index,
            key: entry.keys,
            keysecondary: [],
            comment: displayName || '',
            content: entry.text,
            constant: false,
            selective: false,
            vectorized: false,
            selectiveLogic: world_info_logic.AND_ANY,
            order: entry.contextConfig?.budgetPriority ?? 0,
            position: 0,
            disable: !entry.enabled,
            addMemo: addMemo,
            excludeRecursion: false,
            delayUntilRecursion: false,
            displayIndex: index,
            probability: 100,
            useProbability: true,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: DEFAULT_WEIGHT,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: extension_prompt_roles.SYSTEM,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            ignoreBudget: false,
        };
    });

    return outputObj;
}

export function convertCharacterBook(characterBook) {
    const result = { entries: {}, originalData: characterBook };

    characterBook.entries.forEach((entry, index) => {
        // Not in the spec, but this is needed to find the entry in the original data
        if (entry.id === undefined) {
            entry.id = index;
        }

        result.entries[entry.id] = {
            ...newWorldInfoEntryTemplate,
            uid: entry.id,
            key: entry.keys,
            keysecondary: entry.secondary_keys || [],
            comment: entry.comment || '',
            content: entry.content,
            constant: entry.constant || false,
            selective: entry.selective || false,
            order: entry.insertion_order,
            position: entry.extensions?.position ?? (entry.position === 'before_char' ? world_info_position.before : world_info_position.after),
            excludeRecursion: entry.extensions?.exclude_recursion ?? false,
            preventRecursion: entry.extensions?.prevent_recursion ?? false,
            delayUntilRecursion: entry.extensions?.delay_until_recursion ?? false,
            disable: !entry.enabled,
            addMemo: !!entry.comment,
            displayIndex: entry.extensions?.display_index ?? index,
            probability: entry.extensions?.probability ?? 100,
            useProbability: entry.extensions?.useProbability ?? true,
            depth: entry.extensions?.depth ?? DEFAULT_DEPTH,
            selectiveLogic: entry.extensions?.selectiveLogic ?? world_info_logic.AND_ANY,
            outletName: entry.extensions?.outlet_name ?? '',
            group: entry.extensions?.group ?? '',
            groupOverride: entry.extensions?.group_override ?? false,
            groupWeight: entry.extensions?.group_weight ?? DEFAULT_WEIGHT,
            scanDepth: entry.extensions?.scan_depth ?? null,
            caseSensitive: entry.extensions?.case_sensitive ?? null,
            matchWholeWords: entry.extensions?.match_whole_words ?? null,
            useGroupScoring: entry.extensions?.use_group_scoring ?? null,
            automationId: entry.extensions?.automation_id ?? '',
            role: entry.extensions?.role ?? extension_prompt_roles.SYSTEM,
            vectorized: entry.extensions?.vectorized ?? false,
            sticky: entry.extensions?.sticky ?? null,
            cooldown: entry.extensions?.cooldown ?? null,
            delay: entry.extensions?.delay ?? null,
            matchPersonaDescription: entry.extensions?.match_persona_description ?? false,
            matchCharacterDescription: entry.extensions?.match_character_description ?? false,
            matchCharacterPersonality: entry.extensions?.match_character_personality ?? false,
            matchCharacterDepthPrompt: entry.extensions?.match_character_depth_prompt ?? false,
            matchScenario: entry.extensions?.match_scenario ?? false,
            matchCreatorNotes: entry.extensions?.match_creator_notes ?? false,
            extensions: entry.extensions ?? {},
            triggers: entry.extensions?.triggers || [],
            ignoreBudget: entry.extensions?.ignore_budget ?? false,
        };
    });

    return result;
}

export function setWorldInfoButtonClass(chid, forceValue = undefined) {
    if (forceValue !== undefined) {
        $('#set_character_world, #world_button').toggleClass('world_set', forceValue);
        return;
    }

    if (chid === undefined) {
        return;
    }

    const world = characters[chid]?.data?.extensions?.world;
    const worldSet = Boolean(world && hasWorldInfoName(world));
    $('#set_character_world, #world_button').toggleClass('world_set', worldSet);
}

function normalizePresetLinkedLorebookPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const name = String(payload.name || '').trim();
    const data = payload.data && typeof payload.data === 'object' ? structuredClone(payload.data) : null;

    if (!name || !data || typeof data.entries !== 'object' || data.entries === null) {
        return null;
    }

    return {
        version: Number(payload.version || 1),
        name,
        data,
    };
}

export function createPresetLinkedLorebookPayload(name, data) {
    return {
        version: 1,
        name: String(name || '').trim(),
        data: structuredClone(data),
    };
}

function getPresetLinkedLorebookPromptKey(apiId, presetName, payload) {
    const worldName = String(payload?.name || '').trim();
    const worldHash = String(getStringHash(JSON.stringify(payload?.data || {})));
    return `AlertPresetLorebook_${String(apiId || '').trim()}_${String(presetName || '').trim()}_${worldName}_${worldHash}`;
}

function getPresetLinkedLorebookPromptKeyPrefix(apiId, presetName) {
    return `AlertPresetLorebook_${String(apiId || '').trim()}_${String(presetName || '').trim()}_`;
}

function clearPresetLinkedLorebookPromptState({ apiId = '', name = '' } = {}) {
    const prefix = getPresetLinkedLorebookPromptKeyPrefix(apiId, name);
    for (const key of [...presetLinkedLorebookPromptedKeys]) {
        if (key.startsWith(prefix)) {
            presetLinkedLorebookPromptedKeys.delete(key);
        }
    }

    const storageState = accountStorage.getState();
    for (const key of Object.keys(storageState)) {
        if (key.startsWith(prefix)) {
            accountStorage.removeItem(key);
        }
    }
}

async function getPresetManagerForApi(apiId = '') {
    const module = await import('./preset-manager.js');
    return module.getPresetManager(apiId);
}

function activateLinkedLorebookForPreset(worldName) {
    const name = resolveWorldInfoName(worldName);
    if (!name || !hasWorldInfoName(name) || hasSelectedWorldInfo(name)) {
        return;
    }

    selected_world_info.push(name);
    $('#world_info').trigger('change');
    requestAsyncDiffForNextSettingsSave();
    saveSettingsDebounced();
}

export async function importPresetLinkedLorebookPayload(payload) {
    const normalized = normalizePresetLinkedLorebookPayload(payload);
    if (!normalized) {
        return false;
    }

    await saveWorldInfo(normalized.name, normalized.data, true, { asyncDiff: true });
    await updateWorldInfoList();
    activateLinkedLorebookForPreset(normalized.name);
    return true;
}

async function readCurrentPresetLinkedLorebook({ apiId = '', presetName = '' } = {}) {
    const manager = await getPresetManagerForApi(apiId);
    if (!manager) {
        return null;
    }

    const name = String(presetName || manager.getSelectedPresetName() || '').trim();
    if (!name) {
        return null;
    }

    const raw = manager.readPresetExtensionField({ name, path: PRESET_LINKED_LOREBOOK_KEY });
    return normalizePresetLinkedLorebookPayload(raw);
}

async function checkPresetLinkedLorebookOnPresetChange({ apiId = '', name = '' } = {}) {
    const payload = await readCurrentPresetLinkedLorebook({ apiId, presetName: name });
    if (!payload) {
        return;
    }

    const resolvedPayloadName = resolveWorldInfoName(payload.name);
    const existing = resolvedPayloadName ? await loadWorldInfo(resolvedPayloadName) : null;
    if (existing && (await buildObjectPatchOperationsAsync(existing, payload.data)).length === 0) {
        activateLinkedLorebookForPreset(resolvedPayloadName);
        return;
    }

    const promptKey = getPresetLinkedLorebookPromptKey(apiId, name, payload);
    if (presetLinkedLorebookPromptedKeys.has(promptKey) || accountStorage.getItem(promptKey)) {
        return;
    }

    const header = t`This preset has an embedded World/Lorebook.`;
    const body = `${t`Import and activate it now?`}<br><code>${escapeHtmlText(payload.name)}</code>`;
    const shouldImport = await Popup.show.confirm(header, body);
    if (!shouldImport) {
        return;
    }

    const imported = await importPresetLinkedLorebookPayload(payload);
    if (imported) {
        presetLinkedLorebookPromptedKeys.add(promptKey);
        accountStorage.setItem(promptKey, 'true');
        toastr.success(t`Imported and activated linked World/Lorebook from preset.`);
    } else {
        toastr.error(t`Failed to import linked World/Lorebook from preset.`);
    }
}

export function getPresetLinkedLorebookFromExtensions(extensions) {
    if (!extensions || typeof extensions !== 'object') {
        return null;
    }

    const raw = extensions[PRESET_LINKED_LOREBOOK_KEY];
    return normalizePresetLinkedLorebookPayload(raw);
}

export async function maybeDeleteLinkedLorebookForPresetDeletion({ presetName = '', extensions = null } = {}) {
    const payload = getPresetLinkedLorebookFromExtensions(extensions);
    const resolvedPayloadName = resolveWorldInfoName(payload?.name);
    if (!payload || !resolvedPayloadName) {
        return;
    }

    const header = t`This preset has a linked World/Lorebook.`;
    const body = `${presetName ? `${t`Preset`}: <code>${escapeHtmlText(presetName)}</code><br>` : ''}${t`Also delete it?`}<br><code>${escapeHtmlText(payload.name)}</code>`;
    const shouldDelete = await Popup.show.confirm(header, body);
    if (!shouldDelete) {
        return;
    }

    const deleted = await deleteWorldInfoWithUndo(resolvedPayloadName);
    if (!deleted) {
        toastr.warning(t`Failed to delete linked World/Lorebook.`);
    }
}

export function checkEmbeddedWorld(chid) {
    $('#import_character_info').hide();

    if (chid === undefined) {
        return false;
    }

    if (characters[chid]?.data?.character_book) {
        $('#import_character_info').data('chid', chid).show();

        // Only show the alert once per character
        const checkKey = `AlertWI_${characters[chid].avatar}`;
        const worldName = characters[chid]?.data?.extensions?.world;
        if (!accountStorage.getItem(checkKey) && (!worldName || !hasWorldInfoName(worldName))) {
            accountStorage.setItem(checkKey, 'true');

            if (power_user.world_import_dialog) {
                const html = `<h3>This character has an embedded World/Lorebook.</h3>
                <h3>Would you like to import it now?</h3>
                <div class="m-b-1">If you want to import it later, select "Import Card Lore" in the "More..." dropdown menu on the character panel.</div>`;
                const checkResult = (result) => {
                    if (result) {
                        importEmbeddedWorldInfo(true);
                    }
                };
                callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { okButton: 'Yes' }).then(checkResult);
            } else {
                toastr.info(
                    'To import and use it, select "Import Card Lore" in the "More..." dropdown menu on the character panel.',
                    `${characters[chid].name} has an embedded World/Lorebook`,
                    { timeOut: 5000, extendedTimeOut: 10000 },
                );
            }
        }
        return true;
    }

    return false;
}

export async function importEmbeddedWorldInfo(skipPopup = false) {
    const chid = $('#import_character_info').data('chid');

    if (chid === undefined || chid === -1) {
        return;
    }

    const hasEmbed = checkEmbeddedWorld(chid);

    if (!hasEmbed) {
        return;
    }

    const bookName = characters[chid]?.data?.character_book?.name || `${characters[chid]?.name}'s Lorebook`;
    const existingBookName = resolveWorldInfoName(bookName);

    if (!skipPopup) {
        const confirmation = await Popup.show.confirm(t`Are you sure you want to import '${bookName}'?`, existingBookName ? t`It will overwrite the World/Lorebook with the same name.` : '');
        if (!confirmation) {
            return;
        }
    }

    const convertedBook = convertCharacterBook(characters[chid].data.character_book);

    await saveWorldInfo(bookName, convertedBook, true, { asyncDiff: true });
    await updateWorldInfoList();
    $('#character_world').val(bookName).trigger('change');

    toastr.success(t`The world '${bookName}' has been imported and linked to the character successfully.`, t`World/Lorebook imported`);

    const newIndex = resolveWorldInfoIndex(bookName);
    if (newIndex >= 0) {
        //show&draw the WI panel before..
        $('#WIDrawerIcon').trigger('click');
        //..auto-opening the new imported WI
        $('#world_editor_select').val(newIndex).trigger('change');
    }

    setWorldInfoButtonClass(chid, true);
}

export function onWorldInfoChange(args, text) {
    _suppressLegacySelectSync = true;
    if (args !== '__notSlashCommand__') { // if it's a slash command
        const silent = isTrueBoolean(args.silent);
        if (text.trim() !== '') { // and args are provided
            const slashInputSplitText = text.trim().toLowerCase().split(',');

            slashInputSplitText.forEach((worldName) => {
                const wiElement = getWIElement(worldName);
                if (wiElement.length > 0) {
                    const name = wiElement.text();
                    switch (args.state) {
                        case 'off': {
                            if (selected_world_info.includes(name)) {
                                selected_world_info.splice(selected_world_info.indexOf(name), 1);
                                wiElement.prop('selected', false);
                                if (!silent) toastr.success(t`Deactivated world: ${name}`);
                            } else {
                                if (!silent) toastr.error(t`World was not active: ${name}`);
                            }
                            break;
                        }
                        case 'toggle': {
                            if (selected_world_info.includes(name)) {
                                selected_world_info.splice(selected_world_info.indexOf(name), 1);
                                wiElement.prop('selected', false);
                                if (!silent) toastr.success(t`Deactivated world: ${name}`);
                            } else {
                                selected_world_info.push(name);
                                wiElement.prop('selected', true);
                                if (!silent) toastr.success(t`Activated world: ${name}`);
                            }
                            break;
                        }
                        case 'on':
                        default: {
                            selected_world_info.push(name);
                            wiElement.prop('selected', true);
                            if (!silent) toastr.success(t`Activated world: ${name}`);
                        }
                    }
                } else {
                    if (!silent) toastr.error(t`No world found named: ${worldName}`);
                }
            });
            $('#world_info').trigger('change');
        } else { // if no args, unset all worlds
            if (!silent) toastr.success(t`Deactivated all worlds`);
            selected_world_info = [];
            $('#world_info').val(null).trigger('change');
        }
    } else { //if it's a pointer selection
        const tempWorldInfo = [];
        const val = $('#world_info').val();
        const selectedWorlds = (Array.isArray(val) ? val : [val]).map((e) => Number(e)).filter((e) => !isNaN(e));
        if (selectedWorlds.length > 0) {
            selectedWorlds.forEach((worldIndex) => {
                const existingWorldName = world_names[worldIndex];
                if (existingWorldName) {
                    tempWorldInfo.push(existingWorldName);
                } else {
                    const wiElement = getWIElement(existingWorldName);
                    wiElement.prop('selected', false);
                    toastr.error(t`The world with ${existingWorldName} is invalid or corrupted.`);
                }
            });
        }
        selected_world_info = tempWorldInfo;
    }

    _suppressLegacySelectSync = false;
    saveSettingsDebounced();
    eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
    return '';
}

/**
 * Imports world info from a file.
 * @param {File} file File to import
 */
export async function importWorldInfo(file) {
    if (!file) {
        return;
    }

    const formData = new FormData();
    formData.append('avatar', file);

    try {
        let jsonData;

        if (file.name.endsWith('.png')) {
            const buffer = new Uint8Array(await getFileBuffer(file));
            jsonData = extractDataFromPng(buffer, 'naidata');
        } else {
            // File should be a JSON file
            jsonData = await parseJsonFile(file);
        }

        if (jsonData === undefined || jsonData === null) {
            toastr.error(t`File is not valid: ${file.name}`);
            return;
        }

        // Convert Novel Lorebook
        if (jsonData.lorebookVersion !== undefined) {
            console.log('Converting Novel Lorebook');
            formData.append('convertedData', JSON.stringify(convertNovelLorebook(jsonData)));
        }

        // Convert Agnai Memory Book
        if (jsonData.kind === 'memory') {
            console.log('Converting Agnai Memory Book');
            formData.append('convertedData', JSON.stringify(convertAgnaiMemoryBook(jsonData)));
        }

        // Convert Risu Lorebook
        if (jsonData.type === 'risu') {
            console.log('Converting Risu Lorebook');
            formData.append('convertedData', JSON.stringify(convertRisuLorebook(jsonData)));
        }
    } catch (error) {
        toastr.error(`Error parsing file: ${error}`);
        return;
    }

    const worldName = file.name.substr(0, file.name.lastIndexOf('.'));
    const sanitizedWorldName = await getSanitizedFilename(worldName);
    const allowed = await checkOverwriteExistingData('World Info', world_names, sanitizedWorldName, { interactive: true, actionName: 'Import', deleteAction: (existingName) => deleteWorldInfo(existingName) });
    if (!allowed) {
        return false;
    }

    try {
        const result = await fetch('/api/worldinfo/import', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
            cache: 'no-cache',
        });

        if (!result.ok) {
            throw new Error(`Failed to import world info: ${result.statusText}`);
        }

        const data = await result.json();

        if (data.name) {
            await updateWorldInfoList();

            const newIndex = world_names.indexOf(data.name);
            if (newIndex >= 0) {
                $('#world_editor_select').val(newIndex).trigger('change');
            }

            toastr.success(t`World Info "${data.name}" imported successfully!`);
        }
    } catch (error) {
        console.error('Error importing world info:', error);
        toastr.error(t`Failed to import World Info`);
    }
}

/**
 * Forces the world info editor to open on a specific world.
 * @param {string} worldName The name of the world to open
 */
export function openWorldInfoEditor(worldName) {
    console.log(`Opening lorebook for ${worldName}`);
    if (!$('#WorldInfo').is(':visible')) {
        $('#WIDrawerIcon').trigger('click');
    }
    const index = world_names.indexOf(worldName);
    $('#world_editor_select').val(index).trigger('change');
}

/**
 * Assigns a lorebook to the current chat.
 * @param {Pick<JQuery.ClickEvent, 'shiftKey' | 'altKey'>} event Click event
 * @returns {Promise<void>}
 */
export async function assignLorebookToChat(event) {
    const selectedNames = getChatWorldInfoNames(chat_metadata, { onlyExisting: false });

    if (selectedNames.length && event.altKey) {
        openWorldInfoEditor(selectedNames[0]);
        return;
    }

    const template = $(await renderTemplateAsync('chatLorebook'));

    const worldSelect = template.find('select');
    const chatName = template.find('.chat_name');
    chatName.text(getCurrentChatId());
    let pendingSelection = [...selectedNames];

    for (const worldName of world_names) {
        const option = document.createElement('option');
        option.value = worldName;
        option.innerText = worldName;
        option.selected = selectedNames.includes(worldName);
        worldSelect.append(option);
    }

    worldSelect.on('change', function () {
        pendingSelection = normalizeArray(
            Array.isArray($(this).val())
                ? $(this).val()
                : [$(this).val()],
        )
            .map((worldName) => resolveWorldInfoName(worldName))
            .filter(Boolean)
            .filter(onlyUnique);
    });

    try {
        const popup = new Popup(template, POPUP_TYPE.TEXT, '', {
            wide: true,
            allowVerticalScrolling: true,
            onOpen: (popup) => {
                if (worldSelect.length && typeof worldSelect.select2 === 'function' && !isMobile()) {
                    const popupDialog = $(popup.dlg);
                    worldSelect.select2({
                        width: '100%',
                        closeOnSelect: false,
                        placeholder: t`Select lorebooks...`,
                        searchInputPlaceholder: t`Search lorebooks...`,
                        dropdownParent: popupDialog,
                    });
                }
            },
        });
        await popup.show();
    } finally {
        if (worldSelect.length && typeof worldSelect.select2 === 'function' && worldSelect.hasClass('select2-hidden-accessible')) {
            worldSelect.select2('destroy');
        }
    }

    const previousSelection = getChatWorldInfoNames(chat_metadata, { onlyExisting: false });
    const nextSelection = setChatWorldInfoSelection(pendingSelection);

    $('.chat_lorebook_button').toggleClass('world_set', nextSelection.length > 0);

    if (JSON.stringify(previousSelection) !== JSON.stringify(nextSelection)) {
        await saveMetadata();
    }
}

/**
 * Moves one or more World Info entries from a source lorebook to a target lorebook.
 *
 * @param {string} sourceName - The name of the source lorebook file.
 * @param {string} targetName - The name of the target lorebook file.
 * @param {string[]|number[]|string|number} uids - The UID or UIDs of the entries to move from the source lorebook.
 * @param {Object} options - Additional options for the move operation.
 * @param {boolean} [options.deleteOriginal=true] - Whether to delete the original entry from the source lorebook after moving it.
 * @returns {Promise<boolean>} True if the move was successful, false otherwise.
 */
export async function moveWorldInfoEntries(sourceName, targetName, uids, { deleteOriginal = true } = {}) {
    if (sourceName === targetName) {
        return false;
    }

    if (!world_names.includes(sourceName)) {
        toastr.error(t`Source lorebook '${sourceName}' not found.`);
        console.error(`[WI Move] Source lorebook '${sourceName}' does not exist.`);
        return false;
    }

    if (!world_names.includes(targetName)) {
        toastr.error(t`Target lorebook '${targetName}' not found.`);
        console.error(`[WI Move] Target lorebook '${targetName}' does not exist.`);
        return false;
    }

    const entryUidStrings = [...new Set((Array.isArray(uids) ? uids : [uids])
        .map((uid) => String(uid ?? '').trim())
        .filter(Boolean))];
    if (entryUidStrings.length === 0) {
        return false;
    }

    try {
        const sourceData = await loadWorldInfo(sourceName);
        const targetData = await loadWorldInfo(targetName);

        if (!sourceData || !sourceData.entries) {
            toastr.error(t`Failed to load data for source lorebook '${sourceName}'.`);
            console.error(`[WI Move] Could not load source data for '${sourceName}'.`);
            return false;
        }
        if (!targetData || !targetData.entries) {
            toastr.error(t`Failed to load data for target lorebook '${targetName}'.`);
            console.error(`[WI Move] Could not load target data for '${targetName}'.`);
            return false;
        }

        let maxDisplayIndex = Object.values(targetData.entries).reduce((max, entry) => Math.max(max, entry.displayIndex ?? -1), -1);
        const movedEntries = [];

        for (const entryUidString of entryUidStrings) {
            if (!sourceData.entries[entryUidString]) {
                console.warn(`[WI Move] Entry UID ${entryUidString} not found in '${sourceName}'. Skipping.`);
                continue;
            }

            const entryToMove = structuredClone(sourceData.entries[entryUidString]);
            const newUid = getFreeWorldEntryUid(targetData);
            if (newUid === null) {
                console.error(`[WI Move] Failed to get a free UID in '${targetName}'.`);
                continue;
            }

            entryToMove.uid = newUid;
            entryToMove.displayIndex = ++maxDisplayIndex;
            targetData.entries[newUid] = entryToMove;
            movedEntries.push({ sourceUid: entryUidString, label: entryToMove.comment || entryUidString });

            if (deleteOriginal) {
                delete sourceData.entries[entryUidString];
                deleteWIOriginalDataValue(sourceData, entryUidString);
            }
        }

        if (movedEntries.length === 0) {
            toastr.error(t`No entries were moved.`);
            return false;
        }

        await saveWorldInfo(targetName, targetData, true);
        console.debug(`[WI Move] Saved target lorebook '${targetName}'.`);
        if (deleteOriginal) {
            await saveWorldInfo(sourceName, sourceData, true);
            console.debug(`[WI Move] Saved source lorebook '${sourceName}'.`);
        }

        console.log(`[WI Move] ${movedEntries.length} entr${movedEntries.length === 1 ? 'y' : 'ies'} ${deleteOriginal ? 'moved' : 'copied'} successfully to '${targetName}'.`);

        // Check if the currently viewed book in the editor is the source or target and reload it
        const currentEditorBookName = getSelectedWorldEditorName();
        if (currentEditorBookName === sourceName || currentEditorBookName === targetName) {
            reloadEditor(currentEditorBookName);
        }

        toastr.success(deleteOriginal
            ? (movedEntries.length === 1
                ? t`Entry moved successfully from '${sourceName}' to '${targetName}'.`
                : t`${movedEntries.length} entries moved from '${sourceName}' to '${targetName}'.`)
            : (movedEntries.length === 1
                ? t`Entry copied successfully to '${targetName}'.`
                : t`${movedEntries.length} entries copied to '${targetName}'.`));

        return true;
    } catch (error) {
        toastr.error(t`An unexpected error occurred while moving the entry: ${error.message}`);
        console.error('[WI Move] Unexpected error:', error);
        return false;
    }
}

/**
 * Moves a World Info entry from a source lorebook to a target lorebook.
 *
 * @param {string} sourceName - The name of the source lorebook file.
 * @param {string} targetName - The name of the target lorebook file.
 * @param {string|number} uid - The UID of the entry to move from the source lorebook.
 * @param {Object} options - Additional options for the move operation.
 * @param {boolean} [options.deleteOriginal=true] - Whether to delete the original entry from the source lorebook after moving it.
 * @returns {Promise<boolean>} True if the move was successful, false otherwise.
 */
export async function moveWorldInfoEntry(sourceName, targetName, uid, { deleteOriginal = true } = {}) {
    return moveWorldInfoEntries(sourceName, targetName, [uid], { deleteOriginal });
}


/**
 * Updates the primary world info linked to a character.
 * Can also unset it to null.
 * @param {string} name - The name of the world info to link to the character.
 */
export async function charUpdatePrimaryWorld(name) {
    const previousValue = $('#character_world').val();
    $('#character_world').val(name);

    console.debug('Character world selected:', name);

    if (menu_type == 'create') {
        create_save.world = name;
        return;
    }

    if (previousValue && !name) {
        try {
            // Dirty hack to remove embedded lorebook from character JSON data.
            const data = JSON.parse(String($('#character_json_data').val()));

            if (data?.data?.character_book) {
                data.data.character_book = undefined;
            }

            $('#character_json_data').val(JSON.stringify(data));
            toastr.info(t`Embedded lorebook will be removed from this character.`);
        } catch {
            console.error('Failed to parse character JSON data.');
        }
    }

    await createOrEditCharacter();

    setWorldInfoButtonClass(undefined, !!name);
}

/**
 * Adds one or more auxiliary world books to a character.
 * @param {string} characterKey - The key of the character to add auxiliary world books to
 * @param {string|string[]} nameOrNames - The name or names of the auxiliary world books to add
 */
export async function charUpdateAddAuxWorld(characterKey, nameOrNames) {
    const fileName = getCharaFilename(null, { manualAvatarKey: characterKey });
    const toAdd = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
    updateAuxBooks(fileName, curr => [...curr, ...toAdd]);
}

/**
 * Replaces the entire list of auxiliary world books for a character.
 * @param {string} fileName - The filename of the character to update
 * @param {string[]} books - The new list of auxiliary world books to replace the existing list with
 */
export function charSetAuxWorlds(fileName, books) {
    updateAuxBooks(fileName, _ => Array.isArray(books) ? books : []);
}

function updateAuxBooks(fileName, computeNext) {
    if (!fileName) return;

    if (menu_type === 'create') {
        const current = create_save.extra_books ?? [];
        create_save.extra_books = normalizeArray(computeNext(current));
        return; // no debounced save in create flow
    }

    const charLore = world_info.charLore ?? [];
    const idx = charLore.findIndex(e => e.name === fileName);
    const current = idx !== -1 ? (charLore[idx].extraBooks ?? []) : [];
    const next = normalizeArray(computeNext(current));

    if (next.length === 0) {
        if (idx !== -1) charLore.splice(idx, 1);
    } else if (idx === -1) {
        charLore.push({ name: fileName, extraBooks: next });
    } else {
        charLore[idx] = { ...charLore[idx], extraBooks: next };
    }

    Object.assign(world_info, { charLore });
    saveSettingsDebounced();
}

export function initWorldInfo() {
    $('#world_info').on('mousedown change', async function (e) {
        // If there's no world names, don't do anything
        if (world_names.length === 0) {
            e.preventDefault();
            return;
        }

        onWorldInfoChange('__notSlashCommand__');
    });

    // Monitor the hidden legacy <select#world_info> for external DOM mutations.
    // Third-party scripts (e.g. JS-Slash-Runner) may directly manipulate the select's
    // options and selected_world_info array without triggering 'change' or calling
    // syncGlobalWorldInfoSelectionUi(). This observer detects such changes and
    // syncs the World Info Manager UI accordingly.
    const legacySelect = document.getElementById('world_info');
    if (legacySelect) {
        const syncFromLegacySelect = debounce(() => {
            if (_suppressLegacySelectSync) return;

            // Read the current selected names from the legacy select DOM
            const domSelected = [];
            for (const option of legacySelect.options) {
                if (option.selected && option.value !== '') {
                    const index = Number(option.value);
                    const name = world_names[index];
                    if (name) domSelected.push(name);
                }
            }

            // Also check selected_world_info directly — external scripts may have
            // modified the array without touching the DOM at all
            const currentSet = [...selected_world_info].sort().join('\0');
            const domSet = [...domSelected].sort().join('\0');

            // If the DOM disagrees with selected_world_info, prefer selected_world_info
            // (the script already wrote to it). Just sync the UI.
            // If they agree, check against what the Manager UI currently shows.
            if (currentSet !== domSet) {
                // DOM and array disagree — the external script likely wrote to both
                // but with different values. Trust selected_world_info as source of truth.
                console.debug('[WI] Legacy select observer: DOM and selected_world_info disagree, syncing UI from array');
            } else {
                console.debug('[WI] Legacy select observer: external mutation detected, syncing UI');
            }

            syncGlobalWorldInfoSettingsState();
            syncGlobalWorldInfoSelectionUi();
            requestAsyncDiffForNextSettingsSave();
            saveSettingsDebounced();
            eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
        }, 100);

        const legacySelectObserver = new MutationObserver(() => {
            if (_suppressLegacySelectSync) return;
            syncFromLegacySelect();
        });

        legacySelectObserver.observe(legacySelect, {
            childList: true,           // option added/removed
            subtree: true,             // changes within option elements
            attributes: true,          // selected attribute changes
            attributeFilter: ['selected'],
        });
    }
    setWorldInfoManagerPageSize(getWorldInfoManagerPageSize());
    $('#world_info_manager_page_size').val(String(worldInfoManagerState.pageSize));
    updateWorldInfoEditorDisplaySettingsButton();

    $('#world_info_manager_select_page').on('click', function () {
        const items = getVisibleWorldInfoManagerItems();
        const startIndex = (worldInfoManagerState.page - 1) * worldInfoManagerState.pageSize;
        const pageItems = items.slice(startIndex, startIndex + worldInfoManagerState.pageSize);
        if (pageItems.length === 0) {
            return;
        }

        const allSelected = pageItems.every((item) => selectedWorldInfoManagerNames.has(item.name));
        for (const item of pageItems) {
            if (allSelected) {
                selectedWorldInfoManagerNames.delete(item.name);
            } else {
                selectedWorldInfoManagerNames.add(item.name);
            }
        }

        renderWorldInfoManager();
    });

    $('#world_info_manager_clear_selection').on('click', function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        selectedWorldInfoManagerNames.clear();
        renderWorldInfoManager();
    });

    $('#world_info_manager_enable_selected').on('click', async function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        await applyBulkWorldInfoSelection([...selectedWorldInfoManagerNames], true);
        renderWorldInfoManager();
    });

    $('#world_info_manager_disable_selected').on('click', async function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        await applyBulkWorldInfoSelection([...selectedWorldInfoManagerNames], false);
        renderWorldInfoManager();
    });

    $('#world_info_manager_delete_selected').on('click', async function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        const selectedNames = [...selectedWorldInfoManagerNames];
        const confirmation = await Popup.show.confirm(
            t`Delete ${selectedNames.length} selected lorebooks?`,
            t`This action is irreversible!`,
        );
        if (!confirmation) {
            return;
        }

        await deleteWorldInfoSelection(selectedNames);
        renderWorldInfoManager();
    });

    $('#world_info_manager_page_size').on('change', function () {
        setWorldInfoManagerPageSize($(this).val());
        worldInfoManagerState.page = 1;
        renderWorldInfoManager();
    });

    const debouncedWorldInfoManagerSearch = debounce((searchValue) => {
        worldInfoManagerState.search = String(searchValue || '').trim();
        worldInfoManagerState.page = 1;
        if (worldInfoManagerState.searchEntries) {
            void refreshWorldInfoManagerSearchResults();
        } else {
            renderWorldInfoManager();
        }
    });
    $('#world_info_manager_search').on('input', function () {
        debouncedWorldInfoManagerSearch($(this).val());
    });
    $('#world_info_manager_search_help').on('click', async function () {
        await showWorldInfoSearchSyntaxHelp();
    });
    $('#world_info_manager_search_entries').on('change', function () {
        worldInfoManagerState.searchEntries = Boolean($(this).prop('checked'));
        worldInfoManagerState.page = 1;
        updateWorldInfoManagerSearchInputState();
        void refreshWorldInfoManagerSearchResults();
    });
    $('#world_info_manager_search_advanced').on('change', function () {
        const enabled = Boolean($(this).prop('checked'));
        setWorldInfoSearchAdvancedSyntaxEnabled(enabled);
        worldInfoManagerState.page = 1;
        invalidateWorldInfoManagerEntrySearch();
        cancelDebounce(debouncedWorldInfoManagerSearch);
        if (worldInfoManagerState.searchEntries) {
            void refreshWorldInfoManagerSearchResults();
        } else {
            renderWorldInfoManager();
        }
        setWorldInfoSearchFilter($('#world_info_search').val());
    });

    $('#world_info_manager_prev').on('click', function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        worldInfoManagerState.page = Math.max(1, worldInfoManagerState.page - 1);
        renderWorldInfoManager();
    });

    $('#world_info_manager_first').on('click', function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        worldInfoManagerState.page = 1;
        renderWorldInfoManager();
    });

    $('#world_info_manager_next').on('click', function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        worldInfoManagerState.page += 1;
        renderWorldInfoManager();
    });

    $('#world_info_manager_last').on('click', function () {
        if ($(this).hasClass('disabled')) {
            return;
        }

        const totalItems = getVisibleWorldInfoManagerItems().length;
        const totalPages = Math.max(1, Math.ceil(totalItems / worldInfoManagerState.pageSize));
        worldInfoManagerState.page = totalPages;
        renderWorldInfoManager();
    });

    //**************************WORLD INFO IMPORT EXPORT*************************//
    $('#world_import_button').on('click', function () {
        $('#world_import_file').trigger('click');
    });

    $('#world_import_file').on('change', async function (e) {
        if (!(e.target instanceof HTMLInputElement)) {
            return;
        }

        const file = e.target.files[0];

        await importWorldInfo(file);

        // Will allow to select the same file twice in a row
        e.target.value = '';
    });

    $('#world_create_button').on('click', async () => {
        const tempName = getFreeWorldName();
        const finalName = await Popup.show.input(t`Create a new World Info`, t`Enter a name for the new file:`, tempName);

        if (finalName) {
            await createNewWorldInfo(finalName, { interactive: true });
        }
    });

    $('#world_editor_select').on('change', async () => {
        cancelDebounce(debouncedWorldInfoSearch);
        $('#world_info_search').val('');
        setWorldInfoSearchFilter('', { suppressDataChanged: true });
        const selectedIndex = String($('#world_editor_select').find(':selected').val());

        if (selectedIndex === '') {
            await hideWorldEditor();
        } else {
            const worldName = world_names[selectedIndex];
            showWorldEditor(worldName);
        }
    });

    const saveSettings = () => {
        saveSettingsDebounced();
        eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
    };

    $('#world_info_depth').on('input', function () {
        world_info_depth = Number($(this).val());
        $('#world_info_depth_counter').val($(this).val());
        saveSettings();
    });

    $('#world_info_min_activations').on('input', function () {
        world_info_min_activations = Number($(this).val());
        $('#world_info_min_activations_counter').val(world_info_min_activations);

        if (world_info_min_activations !== 0 && world_info_max_recursion_steps !== 0) {
            $('#world_info_max_recursion_steps').val(0).trigger('input');
            flashHighlight($('#world_info_max_recursion_steps').parent()); // flash the other control to show it has changed
            console.info('[WI] Max recursion steps set to 0, as min activations is set to', world_info_min_activations);
        } else {
            saveSettings();
        }
    });

    $('#world_info_min_activations_depth_max').on('input', function () {
        world_info_min_activations_depth_max = Number($(this).val());
        $('#world_info_min_activations_depth_max_counter').val($(this).val());
        saveSettings();
    });

    $('#world_info_budget').on('input', function () {
        world_info_budget = Number($(this).val());
        $('#world_info_budget_counter').val($(this).val());
        saveSettings();
    });

    $('#world_info_include_names').on('input', function () {
        world_info_include_names = !!$(this).prop('checked');
        saveSettings();
    });

    $('#world_info_recursive').on('input', function () {
        world_info_recursive = !!$(this).prop('checked');
        saveSettings();
    });

    $('#world_info_case_sensitive').on('input', function () {
        world_info_case_sensitive = !!$(this).prop('checked');
        saveSettings();
    });

    $('#world_info_match_whole_words').on('input', function () {
        world_info_match_whole_words = !!$(this).prop('checked');
        saveSettings();
    });

    $('#world_info_character_strategy').on('change', function () {
        world_info_character_strategy = Number($(this).val());
        saveSettings();
    });

    $('#world_info_overflow_alert').on('change', function () {
        world_info_overflow_alert = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#world_info_use_group_scoring').on('change', function () {
        world_info_use_group_scoring = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#world_info_budget_cap').on('input', function () {
        world_info_budget_cap = Number($(this).val());
        $('#world_info_budget_cap_counter').val(world_info_budget_cap);
        saveSettings();
    });

    $('#world_info_max_recursion_steps').on('input', function () {
        world_info_max_recursion_steps = Number($(this).val());
        $('#world_info_max_recursion_steps_counter').val(world_info_max_recursion_steps);
        if (world_info_max_recursion_steps !== 0 && world_info_min_activations !== 0) {
            $('#world_info_min_activations').val(0).trigger('input');
            flashHighlight($('#world_info_min_activations').parent()); // flash the other control to show it has changed
            console.info('[WI] Min activations set to 0, as max recursion steps is set to', world_info_max_recursion_steps);
        } else {
            saveSettings();
        }
    });

    $('#world_button').on('click', async function (event) {
        const openSetWorldMenu = () => $('#char-management-dropdown').val($('#set_character_world').val()).trigger('change');
        const chid = $('#set_character_world').data('chid');

        if (chid === -1) {
            openSetWorldMenu();
            return;
        }

        const worldName = characters[chid]?.data?.extensions?.world;
        const hasEmbed = checkEmbeddedWorld(chid);
        if (worldName && world_names.includes(worldName) && !event.shiftKey && !event.altKey) {
            openWorldInfoEditor(worldName);
        } else if (hasEmbed && !event.shiftKey && !event.altKey) {
            await importEmbeddedWorldInfo();
            saveCharacterDebounced();
        } else {
            openSetWorldMenu();
        }
    });
    addLongPressEvent('#world_button', function () {
        $(this).trigger($.Event('click', { shiftKey: true }));
    });

    const debouncedWorldInfoSearch = debounce((searchQuery) => {
        setWorldInfoSearchFilter(searchQuery);
    });
    $('#world_info_search').on('input', function () {
        const searchQuery = $(this).val();
        debouncedWorldInfoSearch(searchQuery);
    });
    $('#world_info_search_help').on('click', async function () {
        await showWorldInfoSearchSyntaxHelp();
    });
    $('#world_info_search_advanced').on('change', function () {
        const enabled = Boolean($(this).prop('checked'));
        setWorldInfoSearchAdvancedSyntaxEnabled(enabled);
        worldInfoManagerState.page = 1;
        invalidateWorldInfoManagerEntrySearch();
        cancelDebounce(debouncedWorldInfoManagerSearch);
        cancelDebounce(debouncedWorldInfoSearch);
        setWorldInfoSearchFilter($('#world_info_search').val());
        if (worldInfoManagerState.searchEntries) {
            void refreshWorldInfoManagerSearchResults();
        } else {
            renderWorldInfoManager();
        }
    });
    $('#world_info_search_mode').on('change', function () {
        accountStorage.setItem(SEARCH_MODE_KEY, getWorldInfoSearchMode());
        cancelDebounce(debouncedWorldInfoSearch);
        updateWorldInfoSearchInputState();
        setWorldInfoSearchFilter($('#world_info_search').val());
    });

    $('#world_refresh').on('click', () => {
        updateEditor(navigation_option.previous);
    });
    $('#world_entry_display_settings').on('click', async () => {
        await showWorldInfoEditorDisplaySettingsPopup();
    });

    $('#world_info_sort_order').on('change', function () {
        const value = String($(this).find(':selected').val());
        const selectedOption = $(this).find(':selected');
        // Save sort order, but do not save search sorting, as this is a temporary sorting option
        if (selectedOption.data('rule') !== 'search') accountStorage.setItem(SORT_ORDER_KEY, value);
        updateEditor(navigation_option.none);
    });

    $(document).on('click', '.chat_lorebook_button', assignLorebookToChat);
    addLongPressEvent('.chat_lorebook_button', function () {
        assignLorebookToChat({ shiftKey: true, altKey: false });
    });

    $('#group-chat-lorebook-dropdown').on('change', async function () {
        $(this).prop('selectedIndex', 0);
        await assignLorebookToChat({ shiftKey: true, altKey: false });
    });

    initActionableSingleSelect($('#world_editor_select'), {
        placeholder: t`--- Pick to Edit ---`,
        searchInputPlaceholder: t`Search...`,
        allowClear: true,
        closeOnSelect: true,
        deleteButtonTitle: t`Delete lorebook`,
        canDelete: ({ text }) => Boolean(resolveWorldInfoName(text)),
        onDelete: async ({ text }) => {
            const worldName = resolveWorldInfoName(text);
            if (!worldName) {
                return;
            }

            const confirmation = await Popup.show.confirm(
                t`Delete the World/Lorebook: "${worldName}"?`,
                t`This action is irreversible!`,
            );

            if (!confirmation) {
                return;
            }

            await deleteWorldInfoWithUndo(worldName);
        },
    });

    let worldInfoAutocompleteCloseFrame = 0;
    $('#WorldInfo').on('scroll', () => {
        if (worldInfoAutocompleteCloseFrame) {
            return;
        }

        worldInfoAutocompleteCloseFrame = requestAnimationFrame(() => {
            worldInfoAutocompleteCloseFrame = 0;
            $('.world_entry input[name="group"], .world_entry input[name="automationId"]').each((_, el) => {
                const instance = $(el).autocomplete('instance');

                if (instance !== undefined) {
                    $(el).autocomplete('close');
                }
            });
        });
    });
}
