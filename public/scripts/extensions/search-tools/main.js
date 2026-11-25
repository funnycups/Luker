// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { createSearchToolsSettingsUi } from './settings-ui.js';
import {
    MODULE_NAME,
    TOOL_NAMES,
    EXPORTED_TOOL_NAMES,
    DEFAULT_SETTINGS,
    LOREBOOK_POSITION_SCHEMA_VERSION,
    SUPPORTED_WORLD_INFO_POSITIONS,
} from './defaults.js';
import { initializePromptDefaults, requireStoredPrompt } from '../../lib/prompt-values.js';
import { createSearchRunPanel } from './run-panel.js';
import {
    buildLastUserAnchor,
    normalizeAnchorPlayableFloor,
} from './anchors.js';
import {
    commitManagedEntries,
    fromEntriesMap,
    loadManagedEntries,
} from './persistence.js';
import { registerSearchToolsOrchestrationTools } from './orchestrator-tools.js';
import {
    SEARCH_PROVIDERS,
    getSearchProviderDefinition,
    normalizeFieldValue,
    normalizeProviderConfig,
    normalizeProviderSettings,
    normalizeSafeSearch,
} from './providers.js';
import {
    appendStandardToolRoundMessages,
    normalizeToolCallRetryMax,
    requestToolCallsWithRetry,
    serializeToolResultContent,
} from '/scripts/lib/iter-tool-calling.js';
import { i18n, i18nFormat } from './i18n.js';
import {
    renderConnectionProfileOptions as renderSharedConnectionProfileOptions,
    renderOpenAIPresetOptions as renderSharedOpenAIPresetOptions,
} from '../../lens-shared/preset-selectors.js';
import { isAbortSignalLike, isStrictAbortError as isAbortError, linkAbortSignals, throwIfAborted } from '../../lib/abort-utils.js';

const __ctx = Luker.getContext();
const eventSource = __ctx.eventSource;
const event_types = __ctx.eventTypes;
const extension_prompt_roles = __ctx.constants.promptRoles;
const getRequestHeaders = __ctx.getRequestHeaders;
const saveSettings = __ctx.saveSettings;
const saveSettingsDebounced = __ctx.saveSettingsDebounced;
const extension_settings = __ctx.extensionSettings;
const getContext = Luker.getContext;
const SECRET_KEYS = __ctx.secrets.KEYS;
const secret_state = __ctx.secrets.state;
const escapeHtml = __ctx.escapeHtml;
const getStringHash = __ctx.getStringHash;
const newWorldInfoEntryTemplate = __ctx.worldInfoEntry.template;
const setGlobalWorldInfoSelection = __ctx.worldInfoEntry.setGlobalSelection;
const world_info_position = __ctx.constants.wiPosition;
const POPUP_TYPE = __ctx.POPUP_TYPE;
const Popup = __ctx.Popup;

const UI_BLOCK_ID = 'search_tools_settings';
const STYLE_ID = 'search_tools_style';
const STATUS_ID = 'search_tools_status';
const CHAT_LOREBOOK_METADATA_KEY = 'world_info';
const SHARED_LOREBOOK_NAME = '__SEARCH_TOOLS__';
const MANAGED_COMMENT_PREFIX = 'SEARCH_TOOLS';
const ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
const REUSE_GENERATION_TYPES = new Set(['continue', 'regenerate', 'swipe']);
let activeAgentRunToken = 0;
let activeAgentAbortController = null;
let latestSearchAgentSnapshot = null;
let latestManagedEntries = [];
let loadedChatStateKey = '';

let searchRunPanel = null;

function initSearchRunPanel() {
    if (searchRunPanel) {
        return;
    }
    searchRunPanel = createSearchRunPanel();
    searchRunPanel.init();
}

/**
 * Map a state-error envelope reason to a localized user-facing message
 * describing why a search-agent snapshot failed to persist. Used for
 * hard-failure branches that surface to the UI status + throw.
 */
function persistSnapshotErrorMessage(reason) {
    switch (reason) {
        case 'CONFLICT':
            return i18n('Failed to persist search agent snapshot (storage conflict).');
        case 'HTTP_ERROR':
            return i18n('Failed to persist search agent snapshot (server error).');
        case 'TRANSPORT_ERROR':
            return i18n('Failed to persist search agent snapshot (network error).');
        case 'REPLAY_BROKEN':
            return i18n('Failed to persist search agent snapshot (storage corrupted, reload chat).');
        case 'LOG_WRITE_FAILED':
            return i18n('Failed to persist search agent snapshot (disk write failed).');
        default:
            return i18n('Failed to persist search agent snapshot.');
    }
}

function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}

function getAvailableSearchProviders() {
    return SEARCH_PROVIDERS;
}

function getProviderDefinition(providerId) {
    return getSearchProviderDefinition(providerId);
}

function getProviderSettings(settings = getSettings(), providerId = '') {
    const id = normalizeProvider(providerId || settings?.provider);
    const source = settings?.providers && typeof settings.providers === 'object' ? settings.providers : {};
    return normalizeProviderConfig(id, source[id], settings?.safeSearch);
}

function getDefaultSearchProviderId() {
    return getAvailableSearchProviders()[0]?.id || 'ddg';
}

function normalizeProvider(value) {
    return getSearchProviderDefinition(value)?.id || getDefaultSearchProviderId();
}

function hasConfiguredSecret(key) {
    const secrets = secret_state?.[key];
    return Array.isArray(secrets) ? secrets.length > 0 : Boolean(secrets);
}

function normalizeLorebookRole(value) {
    const numeric = Number(value);
    if ([extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT].includes(numeric)) {
        return numeric;
    }
    return DEFAULT_SETTINGS.lorebookRole;
}

function normalizeLorebookPosition(value) {
    const numeric = Number(value);
    return SUPPORTED_WORLD_INFO_POSITIONS.includes(numeric) ? numeric : DEFAULT_SETTINGS.lorebookPosition;
}

function migrateLegacyPromptInjectionPosition(value) {
    switch (Number(value)) {
        case 2:
            return world_info_position.before;
        case 0:
            return world_info_position.after;
        case 1:
            return world_info_position.atDepth;
        default:
            return DEFAULT_SETTINGS.lorebookPosition;
    }
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }
    const settings = extension_settings[MODULE_NAME];
    settings.enabled = Boolean(settings.enabled ?? DEFAULT_SETTINGS.enabled);
    settings.preRequestEnabled = Boolean(settings.preRequestEnabled ?? DEFAULT_SETTINGS.preRequestEnabled);
    settings.provider = normalizeProvider(settings.provider ?? DEFAULT_SETTINGS.provider);
    settings.providers = normalizeProviderSettings(settings.providers, {
        safeSearch: settings.safeSearch ?? DEFAULT_SETTINGS.safeSearch,
    });
    settings.defaultMaxResults = clampInteger(
        settings.defaultMaxResults ?? DEFAULT_SETTINGS.defaultMaxResults,
        1,
        20,
        DEFAULT_SETTINGS.defaultMaxResults,
    );
    settings.defaultVisitMaxChars = clampInteger(
        settings.defaultVisitMaxChars ?? DEFAULT_SETTINGS.defaultVisitMaxChars,
        0,
        50000,
        DEFAULT_SETTINGS.defaultVisitMaxChars,
    );
    settings.safeSearch = getProviderSettings(settings, 'ddg').safeSearch;
    settings.agentApiPresetName = String(settings.agentApiPresetName ?? DEFAULT_SETTINGS.agentApiPresetName).trim();
    settings.agentPresetName = String(settings.agentPresetName ?? DEFAULT_SETTINGS.agentPresetName).trim();
    settings.includeWorldInfoWithPreset = Boolean(settings.includeWorldInfoWithPreset ?? DEFAULT_SETTINGS.includeWorldInfoWithPreset);
    if (initializePromptDefaults(settings, { agentSystemPrompt: DEFAULT_SETTINGS.agentSystemPrompt })) {
        saveSettingsDebounced();
    }
    settings.toolCallRetryMax = normalizeToolCallRetryMax(settings.toolCallRetryMax, DEFAULT_SETTINGS.toolCallRetryMax);
    const hasLorebookPositionSchemaVersion = Object.prototype.hasOwnProperty.call(settings, 'lorebookPositionSchemaVersion');
    if (!hasLorebookPositionSchemaVersion) {
        settings.lorebookPosition = migrateLegacyPromptInjectionPosition(settings.lorebookPosition ?? DEFAULT_SETTINGS.lorebookPosition);
    }
    settings.lorebookPosition = normalizeLorebookPosition(settings.lorebookPosition ?? DEFAULT_SETTINGS.lorebookPosition);
    settings.lorebookPositionSchemaVersion = LOREBOOK_POSITION_SCHEMA_VERSION;
    settings.lorebookDepth = clampInteger(
        settings.lorebookDepth ?? DEFAULT_SETTINGS.lorebookDepth,
        0,
        9999,
        DEFAULT_SETTINGS.lorebookDepth,
    );
    settings.lorebookRole = normalizeLorebookRole(settings.lorebookRole ?? DEFAULT_SETTINGS.lorebookRole);
    settings.lorebookEntryOrder = clampInteger(
        settings.lorebookEntryOrder ?? DEFAULT_SETTINGS.lorebookEntryOrder,
        0,
        20000,
        DEFAULT_SETTINGS.lorebookEntryOrder,
    );
}

function getSettings() {
    ensureSettings();
    return extension_settings[MODULE_NAME];
}

function isToolEnabled() {
    return Boolean(getSettings().enabled);
}

function shouldActivateSharedLorebook(settings = getSettings()) {
    return Boolean(settings?.enabled || settings?.preRequestEnabled);
}

function normalizeWhitespace(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeMultilineText(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizePreviewText(text, maxChars = 240) {
    const normalized = normalizeWhitespace(text);
    if (normalized.length <= maxChars) {
        return normalized;
    }
    return `${normalized.slice(0, maxChars - 1).trim()}...`;
}

function normalizeStoredManagedEntries(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const output = [];
    const seen = new Set();
    for (const item of raw) {
        const entryId = sanitizeEntryId(item?.entryId || item?.entry_id || '');
        const content = normalizeMultilineText(item?.content || '');
        if (!entryId || !content || seen.has(entryId)) {
            continue;
        }
        seen.add(entryId);
        output.push({
            entryId,
            title: deriveManagedEntryTitle(
                entryId,
                item?.title || '',
                Array.isArray(item?.keywords) ? item.keywords : [],
                content,
            ),
            keywords: normalizeKeywordDisplayList(Array.isArray(item?.keywords) ? item.keywords : []),
            content,
            alwaysInject: Boolean(item?.alwaysInject ?? item?.always_inject),
        });
    }

    return output.sort((a, b) => String(a.entryId || '').localeCompare(String(b.entryId || '')));
}

/**
 * In-memory reuse state for the last search-agent run. Deliberately not
 * persisted: the stored entry set is never invalidated by editing a message,
 * and reuse is only meaningful within the session that produced it.
 */
function materializeSearchAgentSnapshot(chatKey, anchorPlayableFloor, { anchorHash, mutationCount } = {}) {
    const normalizedChatKey = String(chatKey || '').trim();
    const normalizedAnchor = normalizeAnchorPlayableFloor(anchorPlayableFloor);
    const normalizedHash = String(anchorHash || '').trim();
    if (!normalizedChatKey || !normalizedAnchor || !normalizedHash) {
        return null;
    }
    return {
        chatKey: normalizedChatKey,
        anchorPlayableFloor: normalizedAnchor,
        anchorHash: normalizedHash,
        mutationCount: Math.max(0, Math.floor(Number(mutationCount || 0))),
    };
}

function getChatKey(context) {
    if (context.groupId) {
        return `group:${context.groupId}`;
    }

    const avatar = String(context.characters?.[context.characterId]?.avatar || '').trim();
    const chatId = String(context.chatId || context.getCurrentChatId?.() || '').trim();
    if (!avatar || !chatId) {
        return '';
    }
    return `char:${avatar}:${chatId}`;
}

function abortActiveSearchAgentRun() {
    if (activeAgentAbortController && !activeAgentAbortController.signal.aborted) {
        activeAgentAbortController.abort();
    }
    if (searchRunPanel) {
        const run = searchRunPanel.store.getCurrentRun();
        if (run && run.status === 'running') {
            searchRunPanel.store.finishRun({ runId: run.runId, status: 'aborted' });
        }
    }
}

async function loadSearchToolsChatState(context, { force = false } = {}) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        latestSearchAgentSnapshot = null;
        latestManagedEntries = [];
        loadedChatStateKey = '';
        return;
    }
    if (!force && loadedChatStateKey === chatKey) {
        return;
    }

    loadedChatStateKey = chatKey;
    latestManagedEntries = fromEntriesMap(await loadManagedEntries(context));
    // Reuse of the previous run is decided in memory, so a reload always
    // starts with nothing to reuse.
    latestSearchAgentSnapshot = null;

    if (latestManagedEntries.length === 0) {
        // Bootstrap from a pre-existing chat lorebook on a never-touched chat.
        const existingEntries = await loadLegacyManagedEntries(context);
        if (existingEntries.length > 0) {
            latestManagedEntries = existingEntries;
        }
    }
}

function renderOpenAIPresetOptions(context, selectedName = '') {
    return renderSharedOpenAIPresetOptions(context, selectedName, {
        emptyLabel: i18n('(Current preset)'),
        missingLabel: i18n('(missing)'),
    });
}

function renderConnectionProfileOptions(selectedName = '') {
    return renderSharedConnectionProfileOptions(getContext(), selectedName, {
        emptyLabel: i18n('(Current API config)'),
        missingLabel: i18n('(missing)'),
    });
}

function fallbackStripHtml(html) {
    return normalizeWhitespace(String(html || '').replace(/<[^>]*>/g, ' '));
}

function htmlToReadableText(html) {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(String(html || ''), 'text/html');
        doc.querySelectorAll('script, style, noscript, svg, canvas, iframe').forEach(node => node.remove());
        const title = normalizeWhitespace(doc.querySelector('title')?.textContent || '');
        const text = normalizeMultilineText(doc.body?.innerText || '');
        return { title, text };
    } catch {
        return { title: '', text: fallbackStripHtml(html) };
    }
}

function normalizeSearchRows(rawRows = [], source = 'ddg') {
    if (!Array.isArray(rawRows)) {
        return [];
    }
    return rawRows
        .map(item => ({
            title: normalizeWhitespace(item?.title || ''),
            url: normalizeWhitespace(item?.url || ''),
            snippet: normalizeWhitespace(item?.snippet || item?.content || ''),
            text_excerpt: normalizeWhitespace(item?.text_excerpt || ''),
            source,
        }))
        .filter(item => item.title && item.url);
}

async function runSearchProvider(provider, {
    query,
    maxResults,
    safeSearch,
    timeRange,
    region,
    config,
    abortSignal = null,
}) {
    const normalizedProvider = normalizeProvider(provider);
    const response = await fetch('/api/search/query', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: isAbortSignalLike(abortSignal) ? abortSignal : null,
        body: JSON.stringify({
            provider: normalizedProvider,
            query,
            max_results: maxResults,
            safe_search: safeSearch,
            time_range: timeRange || '',
            region: region || '',
            options: config || {},
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Search request failed (${response.status}): ${text || response.statusText}`);
    }

    const payload = await response.json();
    const results = normalizeSearchRows(payload?.results || [], normalizedProvider);
    return {
        provider: normalizedProvider,
        query: String(payload?.query || query || ''),
        result_count: Number(payload?.result_count || results.length),
        results,
    };
}

async function searchWeb(args = {}, { abortSignal = null } = {}) {
    const settings = getSettings();
    const query = normalizeWhitespace(args?.query || '');
    if (!query) {
        throw new Error('query is required.');
    }

    const maxResults = clampInteger(
        args?.max_results ?? args?.maxResults ?? settings.defaultMaxResults,
        1,
        20,
        settings.defaultMaxResults,
    );
    const providerSettings = getProviderSettings(settings, settings.provider);
    const safeSearch = normalizeSafeSearch(args?.safe_search || providerSettings.safeSearch || settings.safeSearch);
    const timeRange = String(args?.time_range || '').trim().toLowerCase();
    const region = normalizeWhitespace(args?.region || '');

    return await runSearchProvider(settings.provider, {
        query,
        maxResults,
        safeSearch,
        timeRange,
        region,
        config: providerSettings,
        abortSignal,
    });
}

async function visitWebPage(args = {}, { abortSignal = null } = {}) {
    const settings = getSettings();
    const url = normalizeWhitespace(args?.url || '');
    if (!url) {
        throw new Error('url is required.');
    }

    const rawMaxChars = args?.max_chars ?? settings.defaultVisitMaxChars;
    const normalizedMaxChars = Number.isFinite(Number(rawMaxChars))
        ? Math.floor(Number(rawMaxChars))
        : settings.defaultVisitMaxChars;
    const maxChars = normalizedMaxChars > 0
        ? clampInteger(normalizedMaxChars, 1, 50000, settings.defaultVisitMaxChars)
        : 0;

    const response = await fetch('/api/search/visit', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: isAbortSignalLike(abortSignal) ? abortSignal : null,
        body: JSON.stringify({ url, html: true, reader: 'jina' }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Visit request failed (${response.status}): ${text || response.statusText}`);
    }

    const html = await response.text();
    const parsed = htmlToReadableText(html);
    const fullText = normalizeMultilineText(parsed.text || fallbackStripHtml(html));
    const excerpt = maxChars > 0 ? fullText.slice(0, maxChars) : fullText;

    return {
        url,
        title: parsed.title || '',
        text: excerpt,
        text_excerpt: excerpt,
        source: 'visit',
        total_chars: fullText.length,
        truncated: maxChars > 0 ? (fullText.length > excerpt.length) : false,
    };
}

function getActiveProviderCapabilities() {
    const settings = getSettings();
    const provider = normalizeProvider(settings.provider);
    const definition = getProviderDefinition(provider);
    return {
        provider,
        supportsWebSearch: true,
        supportsImageSearch: Boolean(definition?.supportsImageSearch),
    };
}

async function searchImages(args = {}, { abortSignal = null } = {}) {
    const settings = getSettings();
    const query = normalizeWhitespace(args?.query || '');
    if (!query) {
        throw new Error('query is required.');
    }

    const provider = normalizeProvider(args?.provider || settings.provider);
    const definition = getProviderDefinition(provider);
    if (!definition?.supportsImageSearch) {
        const err = new Error(`Image search is not supported by provider "${provider}".`);
        err.code = 'IMAGE_SEARCH_UNSUPPORTED_BY_PROVIDER';
        throw err;
    }

    const maxResults = clampInteger(
        args?.max_results ?? args?.maxResults ?? settings.defaultMaxResults,
        1,
        20,
        settings.defaultMaxResults,
    );
    const providerSettings = getProviderSettings(settings, provider);
    const safeSearch = normalizeSafeSearch(args?.safe_search || providerSettings.safeSearch || settings.safeSearch);
    const region = normalizeWhitespace(args?.region || providerSettings.region || '');

    const response = await fetch('/api/search/images', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: isAbortSignalLike(abortSignal) ? abortSignal : null,
        body: JSON.stringify({
            provider,
            query,
            max_results: maxResults,
            safe_search: safeSearch,
            region: region || '',
            options: providerSettings || {},
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        let detail = text || response.statusText;
        let code = '';
        try {
            const parsed = JSON.parse(text);
            if (parsed?.error) detail = parsed.error;
            if (parsed?.code) code = parsed.code;
        } catch {
            // plain text body
        }
        const err = new Error(`Image search failed (${response.status}): ${detail}`);
        if (code) err.code = code;
        throw err;
    }

    const payload = await response.json();
    const results = Array.isArray(payload?.results) ? payload.results : [];
    return {
        provider: String(payload?.provider || provider),
        query: String(payload?.query || query),
        result_count: Number(payload?.result_count ?? results.length),
        results,
    };
}

async function extractPageImages(args = {}, { abortSignal = null } = {}) {
    const url = normalizeWhitespace(args?.url || '');
    if (!url) {
        throw new Error('url is required.');
    }

    const response = await fetch('/api/search/page-images', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: isAbortSignalLike(abortSignal) ? abortSignal : null,
        body: JSON.stringify({ url }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        let detail = text || response.statusText;
        try {
            const parsed = JSON.parse(text);
            if (parsed?.error) detail = parsed.error;
        } catch {
            // plain text body
        }
        throw new Error(`Page image extraction failed (${response.status}): ${detail}`);
    }

    const payload = await response.json();
    return {
        pageTitle: String(payload?.pageTitle || ''),
        pageUrl: String(payload?.pageUrl || url),
        images: Array.isArray(payload?.images) ? payload.images : [],
    };
}

function getSharedSearchToolSpecs() {
    return [
        {
            tool: {
                type: 'function',
                function: {
                    name: EXPORTED_TOOL_NAMES.SEARCH,
                    description: 'Search the web for up-to-date information. Provider is configured by the plugin settings.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Search query text.' },
                            max_results: { type: 'integer', description: 'Maximum number of search results (1-20).' },
                            safe_search: { type: 'string', enum: ['off', 'moderate', 'strict'] },
                            time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Optional. Omit for no time filter.' },
                            region: { type: 'string', description: 'Optional provider-specific locale or region hint.' },
                        },
                        required: ['query'],
                        additionalProperties: false,
                    },
                },
            },
            displayName: 'Web Search',
            formatMessage: 'Searching web...',
            action: searchWeb,
        },
        {
            tool: {
                type: 'function',
                function: {
                    name: EXPORTED_TOOL_NAMES.VISIT,
                    description: 'Fetch one webpage and return readable text excerpt.',
                    parameters: {
                        type: 'object',
                        properties: {
                            url: { type: 'string', description: 'HTTP/HTTPS page URL.' },
                            max_chars: { type: 'integer', description: 'Maximum output characters (0-50000). 0 means no truncation.' },
                        },
                        required: ['url'],
                        additionalProperties: false,
                    },
                },
            },
            displayName: 'Visit Web Page',
            formatMessage: 'Fetching webpage...',
            action: visitWebPage,
        },
        {
            tool: {
                type: 'function',
                function: {
                    name: EXPORTED_TOOL_NAMES.IMAGE_SEARCH,
                    description: 'Search the web for candidate images matching a query.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Image search query text.' },
                            max_results: { type: 'integer', description: 'Maximum number of image results (1-20).' },
                            safe_search: { type: 'string', enum: ['off', 'moderate', 'strict'] },
                            region: { type: 'string', description: 'Optional locale or region hint.' },
                        },
                        required: ['query'],
                        additionalProperties: false,
                    },
                },
            },
            displayName: 'Image Search',
            formatMessage: 'Searching images...',
            action: searchImages,
        },
        {
            tool: {
                type: 'function',
                function: {
                    name: EXPORTED_TOOL_NAMES.PAGE_IMAGES,
                    description: 'Extract candidate high-resolution image URLs and captions from a webpage.',
                    parameters: {
                        type: 'object',
                        properties: {
                            url: { type: 'string', description: 'HTTP/HTTPS webpage URL.' },
                        },
                        required: ['url'],
                        additionalProperties: false,
                    },
                },
            },
            displayName: 'Extract Page Images',
            formatMessage: 'Extracting page images...',
            action: extractPageImages,
        },
    ];
}

function getSharedSearchToolDefs() {
    return getSharedSearchToolSpecs().map(spec => structuredClone(spec.tool));
}

function isSharedSearchToolName(name = '') {
    const normalizedName = String(name || '').trim();
    return normalizedName === EXPORTED_TOOL_NAMES.SEARCH
        || normalizedName === EXPORTED_TOOL_NAMES.VISIT
        || normalizedName === EXPORTED_TOOL_NAMES.IMAGE_SEARCH
        || normalizedName === EXPORTED_TOOL_NAMES.PAGE_IMAGES;
}

async function invokeSharedSearchToolCall(call, { abortSignal = null } = {}) {
    const name = String(call?.name || '').trim();
    const args = call?.args && typeof call.args === 'object' ? call.args : {};

    if (name === EXPORTED_TOOL_NAMES.SEARCH) {
        return await searchWeb(args, { abortSignal });
    }

    if (name === EXPORTED_TOOL_NAMES.VISIT) {
        return await visitWebPage(args, { abortSignal });
    }

    if (name === EXPORTED_TOOL_NAMES.IMAGE_SEARCH) {
        return await searchImages(args, { abortSignal });
    }

    if (name === EXPORTED_TOOL_NAMES.PAGE_IMAGES) {
        return await extractPageImages(args, { abortSignal });
    }

    throw new Error(`Unsupported search tool: ${name}`);
}

function publishSearchToolsExtensionApi() {
    const context = getContext();
    context?.registerExtensionApi?.('search-tools', {
        search: searchWeb,
        visit: visitWebPage,
        searchImages,
        extractPageImages,
        getActiveProviderCapabilities,
    });
}

function installGlobalApi() {
    const root = globalThis;
    if (!root.Luker || typeof root.Luker !== 'object') {
        root.Luker = {};
    }
    root.Luker.searchTools = {
        toolNames: EXPORTED_TOOL_NAMES,
        getToolDefs: () => getSharedSearchToolDefs(),
        isToolName: (name) => isSharedSearchToolName(name),
        invoke: async (call, options = {}) => await invokeSharedSearchToolCall(call, options),
        search: searchWeb,
        visit: visitWebPage,
        searchImages,
        extractPageImages,
        getActiveProviderCapabilities,
        getSettings: () => {
            const settings = getSettings();
            const activeProviderSettings = getProviderSettings(settings, settings.provider);
            return {
                enabled: Boolean(settings.enabled),
                preRequestEnabled: Boolean(settings.preRequestEnabled),
                provider: String(settings.provider || getDefaultSearchProviderId()),
                defaultMaxResults: Number(settings.defaultMaxResults || DEFAULT_SETTINGS.defaultMaxResults),
                defaultVisitMaxChars: Number(settings.defaultVisitMaxChars || DEFAULT_SETTINGS.defaultVisitMaxChars),
                safeSearch: String(activeProviderSettings.safeSearch || settings.safeSearch || DEFAULT_SETTINGS.safeSearch),
                providerSettings: structuredClone(settings.providers || {}),
                agentApiPresetName: String(settings.agentApiPresetName || ''),
                agentPresetName: String(settings.agentPresetName || ''),
                lorebookDepth: Number(settings.lorebookDepth || DEFAULT_SETTINGS.lorebookDepth),
                lorebookRole: Number(settings.lorebookRole || DEFAULT_SETTINGS.lorebookRole),
                lorebookEntryOrder: Number(settings.lorebookEntryOrder || DEFAULT_SETTINGS.lorebookEntryOrder),
            };
        },
    };
}

function registerTools(context) {
    Object.values(TOOL_NAMES).forEach(name => context.unregisterFunctionTool(name));

    for (const spec of getSharedSearchToolSpecs()) {
        context.registerFunctionTool({
            name: spec.tool.function.name,
            displayName: spec.displayName,
            description: spec.tool.function.description,
            shouldRegister: async () => isToolEnabled(),
            parameters: structuredClone(spec.tool.function.parameters),
            action: async (args) => await spec.action(args),
            formatMessage: () => spec.formatMessage,
        });
    }
}

function rewriteDepthWorldInfoToAfter(payload = {}) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }
    /** @type {{ worldInfoDepth?: any[]; worldInfoAfterEntries?: string[] }} */
    const target = payload;
    const depthEntries = Array.isArray(target.worldInfoDepth) ? target.worldInfoDepth : [];
    if (depthEntries.length === 0) {
        return payload;
    }

    const blocks = [];
    for (const entry of depthEntries) {
        const lines = Array.isArray(entry?.entries) ? entry.entries : [];
        for (const line of lines) {
            const content = String(line ?? '').trim();
            if (content) {
                blocks.push(content);
            }
        }
    }

    target.worldInfoDepth = [];
    if (blocks.length === 0) {
        return payload;
    }

    appendUniqueWorldInfoEntries(target, 'worldInfoAfter', blocks);
    return payload;
}

function normalizeWorldInfoEntries(rawEntries) {
    return Array.isArray(rawEntries)
        ? rawEntries.map(entry => String(entry ?? '').trim()).filter(Boolean)
        : [];
}

function ensureWorldInfoEntries(payload, field) {
    const entryField = `${field}Entries`;
    const entries = normalizeWorldInfoEntries(payload?.[entryField]);
    payload[entryField] = entries;
    return entries;
}

function appendUniqueWorldInfoEntries(payload, field, incomingEntries = []) {
    if (!payload || typeof payload !== 'object') {
        return false;
    }

    const entries = ensureWorldInfoEntries(payload, field);
    let changed = false;
    for (const value of incomingEntries) {
        const incoming = String(value ?? '').trim();
        if (!incoming || entries.includes(incoming)) {
            continue;
        }
        entries.push(incoming);
        changed = true;
    }
    return changed;
}

function normalizeRuntimeWorldInfo(runtimeWorldInfo = null) {
    const source = runtimeWorldInfo && typeof runtimeWorldInfo === 'object' ? runtimeWorldInfo : {};
    return {
        worldInfoBeforeEntries: normalizeWorldInfoEntries(source.worldInfoBeforeEntries),
        worldInfoAfterEntries: normalizeWorldInfoEntries(source.worldInfoAfterEntries),
        worldInfoDepth: Array.isArray(source.worldInfoDepth) ? source.worldInfoDepth : [],
        outletEntries: source.outletEntries && typeof source.outletEntries === 'object' ? source.outletEntries : {},
        worldInfoExamples: Array.isArray(source.worldInfoExamples) ? source.worldInfoExamples : [],
        anBefore: Array.isArray(source.anBefore) ? source.anBefore : [],
        anAfter: Array.isArray(source.anAfter) ? source.anAfter : [],
    };
}

function hasEffectiveRuntimeWorldInfo(runtimeWorldInfo = null) {
    const normalized = normalizeRuntimeWorldInfo(runtimeWorldInfo);
    if (normalized.worldInfoBeforeEntries.length > 0 || normalized.worldInfoAfterEntries.length > 0) {
        return true;
    }
    if (normalized.worldInfoDepth.length > 0 || normalized.worldInfoExamples.length > 0) {
        return true;
    }
    if (normalized.anBefore.length > 0 || normalized.anAfter.length > 0) {
        return true;
    }
    return Object.keys(normalized.outletEntries).length > 0;
}

function buildRuntimeWorldInfoFromPayload(payload = null) {
    const candidate = normalizeRuntimeWorldInfo({
        worldInfoBeforeEntries: Array.isArray(payload?.worldInfoBeforeEntries) ? payload.worldInfoBeforeEntries : [],
        worldInfoAfterEntries: Array.isArray(payload?.worldInfoAfterEntries) ? payload.worldInfoAfterEntries : [],
        worldInfoDepth: Array.isArray(payload?.worldInfoDepth) ? payload.worldInfoDepth : [],
        outletEntries: payload?.outletEntries && typeof payload?.outletEntries === 'object' ? payload.outletEntries : {},
        worldInfoExamples: Array.isArray(payload?.worldInfoExamples) ? payload.worldInfoExamples : [],
        anBefore: Array.isArray(payload?.anBefore) ? payload.anBefore : [],
        anAfter: Array.isArray(payload?.anAfter) ? payload.anAfter : [],
    });
    return hasEffectiveRuntimeWorldInfo(candidate) ? candidate : null;
}

function syncMutableGenerationPayloadState(target, source) {
    if (!target || typeof target !== 'object' || !source || typeof source !== 'object' || target === source) {
        return;
    }

    const mutableKeys = [
        'requestRescan',
        'worldInfoResolution',
        'worldInfoResolutionOverride',
        'worldInfoBeforeEntries',
        'worldInfoAfterEntries',
        'worldInfoDepth',
        'worldInfoExamples',
        'anBefore',
        'anAfter',
        'outletEntries',
        'globalScanData',
        'chatForWI',
        'maxContext',
        'useCustomChatForWI',
    ];

    for (const key of mutableKeys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            target[key] = source[key];
        }
    }
}

async function buildSearchAgentRuntimeWorldInfo(settings, runtimeWorldInfo) {
    const includeWorldInfoWithPreset = settings?.includeWorldInfoWithPreset !== false;
    if (!includeWorldInfoWithPreset) {
        return {};
    }
    if (!hasEffectiveRuntimeWorldInfo(runtimeWorldInfo)) {
        return null;
    }
    const cloned = normalizeRuntimeWorldInfo(runtimeWorldInfo);
    const depthCopy = Array.isArray(cloned.worldInfoDepth)
        ? cloned.worldInfoDepth.map(entry => ({
            ...entry,
            entries: Array.isArray(entry?.entries) ? entry.entries.slice() : [],
        }))
        : [];
    return normalizeRuntimeWorldInfo(rewriteDepthWorldInfoToAfter({
        ...cloned,
        worldInfoDepth: depthCopy,
    }));
}

async function resolveAgentRuntimeWorldInfo(context, settings, payload, runtimeWorldInfo) {
    const includeWorldInfoWithPreset = settings?.includeWorldInfoWithPreset !== false;
    const presetRuntimeWorldInfo = await buildSearchAgentRuntimeWorldInfo(settings, runtimeWorldInfo);
    if (
        includeWorldInfoWithPreset
        && presetRuntimeWorldInfo === null
        && Array.isArray(payload?.coreChat)
        && payload.coreChat.length > 0
        && typeof context?.resolveWorldInfoForMessages === 'function'
    ) {
        try {
            const resolved = await context.resolveWorldInfoForMessages(payload.coreChat, {
                type: 'quiet',
                fallbackToCurrentChat: false,
                postActivationHook: rewriteDepthWorldInfoToAfter,
            });
            return normalizeRuntimeWorldInfo(resolved);
        } catch (error) {
            if (isAbortError(error, payload?.signal || null)) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] World info pre-resolution failed`, error);
            return {};
        }
    }
    return presetRuntimeWorldInfo === null ? {} : presetRuntimeWorldInfo;
}

function buildRecoverableToolErrorResult(error, fallbackMessage = 'Tool call failed.') {
    const message = normalizeWhitespace(error?.message || error || fallbackMessage) || fallbackMessage;
    return {
        ok: false,
        error: message,
    };
}

function sanitizeEntryId(value) {
    const normalized = String(value || '')
        .trim()
        .replace(/[^a-z0-9._-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return normalized;
}

function normalizeKeywordDisplayList(rawKeywords = []) {
    if (!Array.isArray(rawKeywords)) {
        return [];
    }
    const seen = new Set();
    const output = [];
    for (const item of rawKeywords) {
        const text = normalizeWhitespace(item);
        const signature = text.toLowerCase();
        if (!signature || seen.has(signature)) {
            continue;
        }
        seen.add(signature);
        output.push(text);
    }
    return output;
}

function getKeywordSignature(rawKeywords = []) {
    const normalized = normalizeKeywordDisplayList(rawKeywords)
        .map(item => item.toLowerCase())
        .sort((a, b) => a.localeCompare(b));
    return normalized.join(' || ');
}

function buildManagedComment(entryId, title = '') {
    const safeId = sanitizeEntryId(entryId) || 'entry';
    const safeTitle = normalizeWhitespace(title).replace(/::/g, ' - ').slice(0, 120);
    return `${MANAGED_COMMENT_PREFIX}::${safeId}::${safeTitle || safeId}`;
}

function parseManagedComment(comment = '') {
    const text = String(comment || '');
    const prefix = `${MANAGED_COMMENT_PREFIX}::`;
    if (!text.startsWith(prefix)) {
        return null;
    }
    const rest = text.slice(prefix.length);
    const splitIndex = rest.indexOf('::');
    if (splitIndex < 0) {
        const entryIdOnly = sanitizeEntryId(rest);
        return entryIdOnly ? { entryId: entryIdOnly, title: entryIdOnly } : null;
    }
    const entryId = sanitizeEntryId(rest.slice(0, splitIndex));
    const title = normalizeWhitespace(rest.slice(splitIndex + 2));
    if (!entryId) {
        return null;
    }
    return { entryId, title: title || entryId };
}

function deriveManagedEntryTitle(entryId, title, keywords, content) {
    const normalizedTitle = normalizeWhitespace(title);
    if (normalizedTitle) {
        return normalizedTitle;
    }
    if (Array.isArray(keywords) && keywords.length > 0) {
        return normalizeWhitespace(keywords[0]);
    }
    if (entryId) {
        return sanitizeEntryId(entryId);
    }
    const contentTitle = normalizePreviewText(content, 48);
    return contentTitle || 'Search Note';
}

function listManagedEntries(data) {
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
        return [];
    }
    return Object.entries(data.entries)
        .map(([uid, entry]) => {
            const parsed = parseManagedComment(entry?.comment || '');
            if (!parsed) {
                return null;
            }
            const keywords = normalizeKeywordDisplayList(Array.isArray(entry?.key) ? entry.key : []);
            const title = deriveManagedEntryTitle(parsed.entryId, parsed.title, keywords, entry?.content || '');
            return {
                uid: String(uid || ''),
                entryId: parsed.entryId,
                title,
                keywords,
                keywordSignature: getKeywordSignature(keywords),
                content: normalizeMultilineText(entry?.content || ''),
                alwaysInject: Boolean(entry?.constant),
                position: entry?.position,
                depth: entry?.depth,
                role: entry?.role,
                order: entry?.order,
                disable: Boolean(entry?.disable),
            };
        })
        .filter(Boolean)
        .sort((a, b) => String(a.entryId || '').localeCompare(String(b.entryId || '')));
}

function getNextLorebookUid(entries = {}) {
    return Object.keys(entries || {})
        .map(uid => Number(uid))
        .filter(Number.isFinite)
        .reduce((max, value) => Math.max(max, value), -1) + 1;
}

async function ensureSharedLorebook(context, allowCreate = true) {
    const loaded = await context.loadWorldInfo(SHARED_LOREBOOK_NAME);
    if (loaded && typeof loaded === 'object') {
        return { bookName: SHARED_LOREBOOK_NAME, data: loaded, created: false };
    }

    if (!allowCreate) {
        return { bookName: SHARED_LOREBOOK_NAME, data: null, created: false };
    }

    await context.saveWorldInfo(SHARED_LOREBOOK_NAME, { entries: {} }, true, { refreshEditor: true });
    const created = await context.loadWorldInfo(SHARED_LOREBOOK_NAME);
    return {
        bookName: SHARED_LOREBOOK_NAME,
        data: created && typeof created === 'object' ? created : { entries: {} },
        created: true,
    };
}

async function refreshSharedLorebookVisibilityAndSelection(context, selected) {
    if (typeof selected === 'boolean') {
        const changed = await setGlobalWorldInfoSelection(SHARED_LOREBOOK_NAME, selected, {
            refreshList: true,
            save: false,
        });
        if (changed) {
            const outcome = await saveSettings();
            if (outcome && typeof outcome === 'object' && outcome.ok === false) {
                console.error(`[${MODULE_NAME}] Failed to save shared search lorebook selection`, outcome);
                throw new Error(i18n('Failed to save shared search lorebook selection.'));
            }
        }
    }
}

async function loadLegacyManagedEntries(context) {
    const metadata = context.chatMetadata && typeof context.chatMetadata === 'object' ? context.chatMetadata : {};
    const existingNames = Array.isArray(metadata?.[CHAT_LOREBOOK_METADATA_KEY])
        ? metadata[CHAT_LOREBOOK_METADATA_KEY].map((name) => String(name || '').trim()).filter(Boolean)
        : [String(metadata?.[CHAT_LOREBOOK_METADATA_KEY] || '').trim()].filter(Boolean);
    const existingName = existingNames.find((name) => name !== SHARED_LOREBOOK_NAME) || '';
    if (!existingName || existingName === SHARED_LOREBOOK_NAME) {
        return [];
    }

    const loaded = await context.loadWorldInfo(existingName);
    if (!loaded || typeof loaded !== 'object') {
        return [];
    }

    return normalizeStoredManagedEntries(listManagedEntries(loaded));
}

function applyManagedEntriesToLorebook(data, settings, managedEntries = []) {
    if (!data || typeof data !== 'object') {
        throw new Error('Lorebook data is required.');
    }

    if (!data.entries || typeof data.entries !== 'object') {
        data.entries = {};
    }

    const normalizedEntries = normalizeStoredManagedEntries(managedEntries);
    const existingManagedEntries = listManagedEntries(data);
    const existingById = new Map(existingManagedEntries.map(entry => [entry.entryId, entry]));
    const existingRawById = new Map(existingManagedEntries.map(entry => [entry.entryId, data.entries[entry.uid]]));
    for (const entry of existingManagedEntries) {
        delete data.entries[entry.uid];
    }

    let nextUid = getNextLorebookUid(data.entries);
    for (const spec of normalizedEntries) {
        const existing = existingById.get(spec.entryId) || null;
        const uid = existing ? Number(existing.uid) : nextUid;
        data.entries[uid] = createManagedLorebookEntry(uid, {
            entryId: spec.entryId,
            title: spec.title,
            keywords: spec.keywords,
            content: spec.content,
            alwaysInject: spec.alwaysInject,
        }, settings, existing ? existingRawById.get(spec.entryId) || null : null);
        if (!existing) {
            nextUid += 1;
        }
    }
}

async function syncSharedLorebookForCurrentChat(context = getContext()) {
    const settings = getSettings();
    if (!shouldActivateSharedLorebook(settings)) {
        await refreshSharedLorebookVisibilityAndSelection(context, false);
        return { changed: false, bookName: SHARED_LOREBOOK_NAME };
    }

    const lorebook = await ensureSharedLorebook(context, true);
    const data = lorebook.data && typeof lorebook.data === 'object' ? structuredClone(lorebook.data) : { entries: {} };
    applyManagedEntriesToLorebook(data, settings, latestManagedEntries);
    await context.saveWorldInfo(SHARED_LOREBOOK_NAME, data, true, { refreshEditor: true });
    await refreshSharedLorebookVisibilityAndSelection(context, true);
    return { changed: true, bookName: SHARED_LOREBOOK_NAME };
}

async function syncSharedLorebookForLoadedChat(context = getContext()) {
    await loadSearchToolsChatState(context, { force: false });
    return syncSharedLorebookForCurrentChat(context);
}

function createManagedLorebookEntry(uid, spec, settings, existingEntry = null) {
    const entry = existingEntry && typeof existingEntry === 'object'
        ? structuredClone(existingEntry)
        : { uid, ...structuredClone(newWorldInfoEntryTemplate) };

    entry.uid = uid;
    entry.comment = buildManagedComment(spec.entryId, spec.title);
    entry.key = Array.isArray(spec.keywords) ? spec.keywords.slice() : [];
    entry.content = normalizeMultilineText(spec.content);
    entry.constant = Boolean(spec.alwaysInject);
    entry.selective = false;

    entry.position = normalizeLorebookPosition(settings.lorebookPosition);
    entry.depth = Number(settings.lorebookDepth);
    entry.role = Number(settings.lorebookRole);
    entry.order = Number(settings.lorebookEntryOrder);

    if (!existingEntry) {
        entry.disable = false;
        entry.useProbability = false;
        entry.probability = 100;
        entry.preventRecursion = true;
        entry.excludeRecursion = true;
    } else {
        if (!Array.isArray(entry.key)) {
            entry.key = Array.isArray(spec.keywords) ? spec.keywords.slice() : [];
        }
    }

    return entry;
}

function findManagedEntryById(data, entryId) {
    const targetId = sanitizeEntryId(entryId);
    if (!targetId) {
        return null;
    }
    return listManagedEntries(data).find(entry => entry.entryId === targetId) || null;
}

function findManagedEntryByKeywordSignature(data, keywordSignature) {
    const signature = String(keywordSignature || '').trim();
    if (!signature) {
        return null;
    }
    return listManagedEntries(data).find(entry => entry.keywordSignature === signature) || null;
}

function buildGeneratedEntryId(title, keywords, content) {
    const base = sanitizeEntryId(title || keywords?.[0] || '') || 'search_entry';
    const hashSource = `${base}\n${getKeywordSignature(keywords)}\n${normalizeMultilineText(content)}`;
    const hash = Math.abs(getStringHash(hashSource)).toString(36);
    return sanitizeEntryId(`${base}_${hash.slice(0, 8)}`) || `search_entry_${hash.slice(0, 8)}`;
}

function collectUpsertSpec(args = {}, existingEntry = null) {
    const hasKeywords = Object.hasOwn(args, 'keywords');
    const inputKeywords = hasKeywords ? normalizeKeywordDisplayList(args?.keywords || []) : null;
    const alwaysInject = Object.hasOwn(args, 'always_inject')
        ? Boolean(args?.always_inject)
        : Boolean(existingEntry?.alwaysInject);
    const keywords = inputKeywords ?? (Array.isArray(existingEntry?.keywords) ? existingEntry.keywords.slice() : []);
    const content = normalizeMultilineText(args?.content || '');
    const explicitEntryId = sanitizeEntryId(args?.entry_id || '');
    const title = deriveManagedEntryTitle(
        explicitEntryId || existingEntry?.entryId || '',
        args?.title || existingEntry?.title || '',
        keywords,
        content,
    );

    return {
        entryId: explicitEntryId,
        title,
        keywords,
        keywordSignature: getKeywordSignature(keywords),
        content,
        alwaysInject,
    };
}

function upsertManagedEntry(data, settings, args = {}) {
    if (!data || typeof data !== 'object') {
        throw new Error('Lorebook data is required.');
    }
    if (!data.entries || typeof data.entries !== 'object') {
        data.entries = {};
    }

    const requestedEntryId = sanitizeEntryId(args?.entry_id || '');
    const hasExplicitEntryId = Boolean(requestedEntryId);
    const explicitEntry = hasExplicitEntryId ? findManagedEntryById(data, requestedEntryId) : null;
    const normalized = collectUpsertSpec(args, explicitEntry);
    if (!normalized.content) {
        throw new Error('content is required.');
    }
    if (!normalized.alwaysInject && normalized.keywords.length === 0) {
        throw new Error('keywords are required when always_inject is false.');
    }

    let target = explicitEntry;
    let matchedBy = explicitEntry ? 'entry_id' : '';
    if (!target && !hasExplicitEntryId && normalized.keywordSignature) {
        target = findManagedEntryByKeywordSignature(data, normalized.keywordSignature);
        if (target) {
            matchedBy = 'keywords';
        }
    }

    const finalEntryId = target?.entryId
        || requestedEntryId
        || buildGeneratedEntryId(normalized.title, normalized.keywords, normalized.content);
    const finalTitle = deriveManagedEntryTitle(finalEntryId, normalized.title, normalized.keywords, normalized.content);
    const existingRaw = target ? data.entries[target.uid] : null;
    const uid = target ? Number(target.uid) : getNextLorebookUid(data.entries);
    const nextEntry = createManagedLorebookEntry(uid, {
        entryId: finalEntryId,
        title: finalTitle,
        keywords: normalized.keywords,
        content: normalized.content,
        alwaysInject: normalized.alwaysInject,
    }, settings, existingRaw);

    const previousSerialized = existingRaw ? JSON.stringify(existingRaw) : '';
    const nextSerialized = JSON.stringify(nextEntry);
    const changed = previousSerialized !== nextSerialized;
    data.entries[uid] = nextEntry;

    return {
        changed,
        action: target ? 'updated' : 'created',
        matchedBy: matchedBy || (target ? 'unknown' : 'new'),
        uid: String(uid),
        entryId: finalEntryId,
        title: finalTitle,
        keywords: normalized.keywords,
        alwaysInject: normalized.alwaysInject,
    };
}

function deleteManagedEntries(data, entryIds = []) {
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
        return { changed: false, deleted: [], skipped: [] };
    }
    const deleted = [];
    const skipped = [];
    for (const rawId of Array.isArray(entryIds) ? entryIds : []) {
        const entryId = sanitizeEntryId(rawId);
        if (!entryId) {
            continue;
        }
        const target = findManagedEntryById(data, entryId);
        if (!target) {
            skipped.push(entryId);
            continue;
        }
        delete data.entries[target.uid];
        deleted.push(entryId);
    }
    return {
        changed: deleted.length > 0,
        deleted,
        skipped,
    };
}

function buildRecentChatText(messages = [], limit = 12) {
    const normalized = Array.isArray(messages) ? messages : [];
    const sliced = normalized.slice(Math.max(0, normalized.length - limit));
    const lines = sliced.map((message) => {
        const role = message?.is_user ? 'User' : (message?.is_system ? 'System' : (message?.name || 'Assistant'));
        const content = normalizeMultilineText(message?.mes || message?.content || '');
        return content ? `${role}: ${content}` : '';
    }).filter(Boolean);
    return lines.length > 0 ? lines.join('\n\n') : '(No recent chat messages available)';
}

function canReuseLatestSearchAgentSnapshot(chatKey, anchor) {
    if (!latestSearchAgentSnapshot || typeof latestSearchAgentSnapshot !== 'object') {
        return false;
    }
    if (!anchor || typeof anchor !== 'object') {
        return false;
    }
    if (String(latestSearchAgentSnapshot.chatKey || '') !== String(chatKey || '')) {
        return false;
    }

    return Number(latestSearchAgentSnapshot.anchorPlayableFloor) === Number(anchor.playableFloor)
        && String(latestSearchAgentSnapshot.anchorHash || '') === String(anchor.hash || '');
}

function buildSearchAgentStatusText(result, { reused = false } = {}) {
    const mutationCount = Math.max(0, Number(result?.mutationCount || 0));
    const managedEntryCount = Math.max(0, Number(result?.managedEntryCount ?? latestManagedEntries.length));
    if (reused) {
        return mutationCount
            ? i18nFormat('Search agent reused cached lorebook update (${0} changes, ${1} managed entries).', mutationCount, managedEntryCount)
            : i18nFormat('Search agent reused cached result with no lorebook changes (${0} managed entries).', managedEntryCount);
    }
    return mutationCount
        ? i18nFormat('Search agent updated lorebook (${0} changes, ${1} managed entries).', mutationCount, managedEntryCount)
        : i18nFormat('Search agent finished with no lorebook changes (${0} managed entries).', managedEntryCount);
}

async function storeCompletedSearchAgentSnapshot(context, anchor, result) {
    const chatKey = getChatKey(context);
    const anchorPlayableFloor = normalizeAnchorPlayableFloor(anchor?.playableFloor);
    const anchorHash = String(anchor?.hash || '').trim();
    const managedEntries = normalizeStoredManagedEntries(result?.managedEntries);
    if (!chatKey || !anchorPlayableFloor || !anchorHash) {
        latestSearchAgentSnapshot = null;
        latestManagedEntries = managedEntries;
        return null;
    }

    const mutationCount = Math.max(0, Math.floor(Number(result?.mutationCount || 0)));
    const commitResult = await commitManagedEntries(context, { playableFloor: anchorPlayableFloor }, managedEntries);
    if (!commitResult.ok) {
        console.warn(`[search-tools] floor-state commit failed (reason=${commitResult.reason}, hint=${commitResult.hint})`);
        // Anchor lost mid-write (the user message was deleted or is no longer
        // is_user) — the run's result has no owner to attach to. Keep it in
        // memory so the shared lorebook still reflects it until the next run.
        if (commitResult.reason === 'VALIDATION_TARGET' || commitResult.reason === 'VALIDATION_COMMIT') {
            latestSearchAgentSnapshot = null;
            latestManagedEntries = managedEntries;
            return null;
        }
        // Hard failure (storage conflict, transport, replay broken, etc.) —
        // surface a reason-aware message to the UI and rethrow so the
        // caller can stop the run.
        const msg = persistSnapshotErrorMessage(commitResult.reason);
        updateUiStatus(msg);
        throw new Error(msg);
    }

    latestSearchAgentSnapshot = materializeSearchAgentSnapshot(chatKey, anchorPlayableFloor, { anchorHash, mutationCount });
    latestManagedEntries = managedEntries;
    return latestSearchAgentSnapshot;
}

async function applyManualManagedEntriesUpdate(context, nextEntries) {
    const snapshotBackup = latestSearchAgentSnapshot;
    const entriesBackup = latestManagedEntries;
    try {
        const normalized = normalizeStoredManagedEntries(nextEntries);
        latestManagedEntries = normalized;

        // Manual edits live in the same store as agent results. Without an
        // in-memory run anchor, attribute them to the current last user turn.
        const anchor = latestSearchAgentSnapshot && typeof latestSearchAgentSnapshot === 'object'
            ? { playableFloor: latestSearchAgentSnapshot.anchorPlayableFloor }
            : buildLastUserAnchor(context, []);
        if (anchor) {
            const commitResult = await commitManagedEntries(context, anchor, normalized);
            if (!commitResult.ok) {
                if (commitResult.reason === 'VALIDATION_TARGET' || commitResult.reason === 'VALIDATION_COMMIT') {
                    // Anchor no longer resolvable (user message was deleted or
                    // turned non-user) — keep the change in memory; the next
                    // run commits it.
                    console.warn(`[search-tools] manual commit anchor lost (reason=${commitResult.reason}, hint=${commitResult.hint})`);
                    latestSearchAgentSnapshot = null;
                } else {
                    // Hard failure (storage conflict, transport, replay broken,
                    // disk write failed, etc.) — surface to the caller. The
                    // outer try/catch restores in-memory state so the UI and
                    // storage stay aligned.
                    console.error(`[search-tools] manual commit failed (reason=${commitResult.reason}, hint=${commitResult.hint})`);
                    throw new Error(i18n('Failed to update managed entries. See console for details.'));
                }
            }
        }

        await syncSharedLorebookForCurrentChat(context);
        return normalized;
    } catch (err) {
        // Restore in-memory state so the UI and storage stay aligned with
        // what the user sees. The snapshotBackup / entriesBackup pair was
        // captured before any mutation in this call.
        latestSearchAgentSnapshot = snapshotBackup;
        latestManagedEntries = entriesBackup;
        throw err;
    }
}

async function manuallyDeleteManagedEntries(context, entryIds = []) {
    const idsToDelete = new Set(
        (Array.isArray(entryIds) ? entryIds : [])
            .map((id) => sanitizeEntryId(id))
            .filter(Boolean),
    );
    if (idsToDelete.size === 0) {
        return { deleted: [], remaining: latestManagedEntries.slice() };
    }
    const before = Array.isArray(latestManagedEntries) ? latestManagedEntries.slice() : [];
    const after = before.filter((entry) => !idsToDelete.has(entry.entryId));
    const deleted = before
        .filter((entry) => idsToDelete.has(entry.entryId))
        .map((entry) => entry.entryId);
    if (deleted.length === 0) {
        return { deleted: [], remaining: before };
    }
    const remaining = await applyManualManagedEntriesUpdate(context, after);
    return { deleted, remaining };
}

async function manuallyResetManagedEntries(context) {
    const before = Array.isArray(latestManagedEntries) ? latestManagedEntries.slice() : [];
    if (before.length === 0) {
        return { deleted: [], remaining: [] };
    }
    const remaining = await applyManualManagedEntriesUpdate(context, []);
    return {
        deleted: before.map((entry) => entry.entryId),
        remaining,
    };
}

function getManagedEntriesSnapshot() {
    return Array.isArray(latestManagedEntries) ? latestManagedEntries.slice() : [];
}

function buildManagedEntryCatalog(entries = []) {
    const normalized = Array.isArray(entries) ? entries : [];
    if (normalized.length === 0) {
        return '[]';
    }
    return JSON.stringify(normalized.slice().sort((a, b) => String(a?.entryId || '').localeCompare(String(b?.entryId || ''))).map(entry => ({
        entry_id: entry.entryId,
        title: entry.title,
        keywords: entry.keywords,
        always_inject: entry.alwaysInject,
    })), null, 2);
}

function getManagedEntriesByIds(data, entryIds = []) {
    const requested = (Array.isArray(entryIds) ? entryIds : [])
        .map(id => sanitizeEntryId(id))
        .filter(Boolean);
    const byId = new Map(listManagedEntries(data).map(entry => [entry.entryId, entry]));
    const entries = [];
    const missing_entry_ids = [];
    for (const id of requested) {
        const entry = byId.get(id);
        if (entry) {
            entries.push({
                entry_id: entry.entryId,
                title: entry.title,
                keywords: entry.keywords,
                always_inject: entry.alwaysInject,
                content: entry.content,
            });
        } else {
            missing_entry_ids.push(id);
        }
    }
    return { entries, missing_entry_ids };
}

function buildAgentSystemPrompt(settings) {
    return requireStoredPrompt(settings?.agentSystemPrompt, i18n('Fill in the prompt or reset it to the default.'));
}

function buildSearchAgentUserPrompt(payload, { bookName, managedEntries } = {}) {
    const recentChat = buildRecentChatText(payload?.coreChat || []);
    const lastUserMessage = Array.isArray(payload?.coreChat)
        ? [...payload.coreChat].reverse().find(message => message?.is_user)
        : null;
    const userText = normalizeMultilineText(lastUserMessage?.mes || '');
    const toolNames = Object.values(TOOL_NAMES).filter(name => name.startsWith('luker_search_agent_'));

    return [
        '# Search Agent Task',
        `Generation type: ${String(payload?.type || 'unknown')}.`,
        `Shared lorebook: ${bookName || '(not created yet)'}.`,
        `Available function tools: ${toolNames.join(', ')}.`,
        '',
        '## Latest user message',
        userText || '(No user message found)',
        '',
        '## Recent chat',
        recentChat,
        '',
        '## Managed search entries (readable / updatable / deletable)',
        buildManagedEntryCatalog(managedEntries),
    ].filter(Boolean).join('\n');
}

function buildAgentTools() {
    return [
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.AGENT_SEARCH,
                description: 'Search the web for current information. Treat returned snippets as source text only; do not infer beyond them.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        max_results: { type: 'integer' },
                        safe_search: { type: 'string', enum: ['off', 'moderate', 'strict'] },
                        time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
                        region: { type: 'string' },
                    },
                    required: ['query'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.AGENT_VISIT,
                description: 'Visit one web page and read its text as source material. Do not invent claims beyond the visited text.',
                parameters: {
                    type: 'object',
                    properties: {
                        url: { type: 'string' },
                        max_chars: { type: 'integer' },
                    },
                    required: ['url'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.AGENT_UPSERT,
                description: 'Create or update one managed search lorebook entry using only facts explicitly supported by managed search entries, search snippets, or visited page text. Entries must read like neutral reference notes, not plot guidance, characterization advice, or instructions for how the roleplay should continue. Do not infer emotions, cognition, motives, intentions, hidden facts, or plot consequences unless the source explicitly states them. Use always_inject when the entry should stay visible continuously without a trigger, including always-on rules, core worldbuilding, and any entry created to provide creative inspiration, candidate suggestions, or temporary creative reference. For inspiration entries, include top-level YAML markers `entry_usage: creative_inspiration_constant` and `retention: delete_if_unused_after_one_creation_round`. Set always_inject=false only when the latest user input clearly already contains or directly invokes the entry trigger words; then use precise keywords matching that wording. Explicit entry_id matches first; otherwise exact normalized keyword match updates an existing managed entry.',
                parameters: {
                    type: 'object',
                    properties: {
                        entry_id: { type: 'string' },
                        title: { type: 'string' },
                        keywords: {
                            type: 'array',
                            description: 'Use precise activation keywords only when always_inject is false. Non-constant entries are allowed only when the latest user input clearly already contains or directly invokes these trigger words.',
                            items: { type: 'string' },
                        },
                        content: { type: 'string' },
                        always_inject: {
                            type: 'boolean',
                            description: 'Set true when the entry should remain visible continuously without a trigger, including always-on rules, core worldbuilding, and any creative-inspiration/reference entry. Set false only when the latest user input clearly already contains or directly invokes the entry trigger words.',
                        },
                    },
                    required: ['content'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.AGENT_DELETE,
                description: 'Delete one or more managed search lorebook entries by entry_id.',
                parameters: {
                    type: 'object',
                    properties: {
                        entry_ids: {
                            type: 'array',
                            items: { type: 'string' },
                        },
                    },
                    required: ['entry_ids'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.AGENT_GET,
                description: 'Read the full content of managed search lorebook entries by entry_id before deciding whether to update or delete them. Read-only.',
                parameters: {
                    type: 'object',
                    properties: {
                        entry_ids: {
                            type: 'array',
                            items: { type: 'string' },
                        },
                    },
                    required: ['entry_ids'],
                    additionalProperties: false,
                },
            },
        },
    ];
}

function updatePayloadWorldInfoFromResolution(payload, resolution) {
    if (!payload || typeof payload !== 'object' || !resolution || typeof resolution !== 'object') {
        return;
    }
    const normalized = normalizeRuntimeWorldInfo(resolution);
    payload.worldInfoBeforeEntries = [...normalized.worldInfoBeforeEntries];
    payload.worldInfoAfterEntries = [...normalized.worldInfoAfterEntries];
    payload.worldInfoDepth = [...normalized.worldInfoDepth];
    payload.outletEntries = normalized.outletEntries;
    payload.worldInfoExamples = [...normalized.worldInfoExamples];
    payload.anBefore = [...normalized.anBefore];
    payload.anAfter = [...normalized.anAfter];
    if (Array.isArray(resolution.chatForWI)) {
        payload.chatForWI = resolution.chatForWI;
    }
    if (Number.isFinite(Number(resolution.maxContext)) && Number(resolution.maxContext) > 0) {
        payload.maxContext = Number(resolution.maxContext);
    }
    if (resolution.globalScanData && typeof resolution.globalScanData === 'object') {
        payload.globalScanData = resolution.globalScanData;
    }
    payload.worldInfoResolution = resolution;
}

async function commitSearchAgentEntries(context, anchor, lorebookData) {
    const playableFloor = normalizeAnchorPlayableFloor(anchor?.playableFloor);
    const entries = normalizeStoredManagedEntries(listManagedEntries(lorebookData));
    // Keep the in-memory projection aligned with the live world book even if
    // the floor-state write fails; the next sync should not treat entries
    // that were already written as absent.
    latestManagedEntries = entries;
    if (!playableFloor) {
        return null;
    }
    const commitResult = await commitManagedEntries(context, { playableFloor }, entries);
    if (!commitResult?.ok) {
        console.warn(`[search-tools] partial floor-state commit failed (reason=${commitResult?.reason}, hint=${commitResult?.hint})`);
    }
    return commitResult;
}

async function flushLorebookChanges(context, payload, bookName, data) {
    await context.saveWorldInfo(bookName, data, true, { refreshEditor: true });
    if (String(bookName || '').trim() === SHARED_LOREBOOK_NAME) {
        await refreshSharedLorebookVisibilityAndSelection(context, shouldActivateSharedLorebook(getSettings()));
    }
    payload.requestRescan = true;
    if (typeof payload?.simulateWorldInfo === 'function') {
        const resolution = await payload.simulateWorldInfo();
        updatePayloadWorldInfoFromResolution(payload, resolution);
        return buildRuntimeWorldInfoFromPayload(resolution);
    }
    return buildRuntimeWorldInfoFromPayload(payload);
}

async function runPreRequestSearchAgent(context, settings, payload, panel = null, { anchor = null } = {}) {
    throwIfAborted(payload?.signal, 'Search agent aborted.');
    const apiPresetName = String(settings.agentApiPresetName || '').trim();
    const promptPresetName = String(settings.agentPresetName || '').trim();
    const runAnchor = anchor || buildLastUserAnchor(context, payload?.coreChat);
    const tools = buildAgentTools();
    const allowedNames = tools.map(tool => tool?.function?.name).filter(Boolean);
    const toolHistoryMessages = [];
    let internalRuntimeWorldInfo = buildRuntimeWorldInfoFromPayload(payload);
    let mutationCount = 0;
    let lorebookBookName = '';
    let lorebookData = null;

    let round = 0;
    while (true) {
        throwIfAborted(payload?.signal, 'Search agent aborted.');

        round += 1;
        let roundId = null;
        if (panel) {
            roundId = panel.store.appendRound({
                runId: panel.runId,
                round: { id: `round-${round}`, label: i18nFormat('Round ${0}', round) },
            });
        }

        if (!lorebookData && !lorebookBookName) {
            const lorebook = await ensureSharedLorebook(context, true);
            throwIfAborted(payload?.signal, 'Search agent aborted.');
            lorebookBookName = lorebook.bookName;
            lorebookData = lorebook.data && typeof lorebook.data === 'object' ? lorebook.data : null;
        }
        const managedEntries = listManagedEntries(lorebookData);
        const systemPrompt = buildAgentSystemPrompt(settings);
        const userPrompt = buildSearchAgentUserPrompt(payload, {
            bookName: lorebookBookName,
            managedEntries,
        });
        const taskMessages = [
            { role: 'system', content: systemPrompt },
            ...toolHistoryMessages,
            { role: 'user', content: userPrompt },
        ];
        const runtimeWorldInfo = await resolveAgentRuntimeWorldInfo(context, settings, payload, internalRuntimeWorldInfo);
        throwIfAborted(payload?.signal, 'Search agent aborted.');

        const response = await requestToolCallsWithRetry(context, settings, {
            taskMessages,
            runtimeWorldInfo,
            apiPresetName,
            llmPresetName: promptPresetName,
            tools,
            allowedNames,
            allowNoToolCalls: true,
            includeAssistantText: true,
            substituteMacros: true,
            onUsage: panel ? (usage) => panel.store.addTokenUsage({ runId: panel.runId, usage }) : undefined,
            abortSignal: payload?.signal || null,
        });
        throwIfAborted(payload?.signal, 'Search agent aborted.');
        const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
        if (panel && response.reasoning) {
            panel.store.ensureSection({ runId: panel.runId, roundId, section: { id: 'reasoning', kind: 'reasoning', title: i18n('Reasoning') } });
            panel.store.appendToSection({ runId: panel.runId, roundId, sectionId: 'reasoning', delta: response.reasoning });
            panel.store.setSectionStatus({ runId: panel.runId, roundId, sectionId: 'reasoning', status: 'done' });
        }
        if (panel && response.assistantText) {
            panel.store.ensureSection({ runId: panel.runId, roundId, section: { id: 'text', kind: 'text', title: i18n('Response') } });
            panel.store.appendToSection({ runId: panel.runId, roundId, sectionId: 'text', delta: response.assistantText });
            panel.store.setSectionStatus({ runId: panel.runId, roundId, sectionId: 'text', status: 'done' });
        }
        if (toolCalls.length === 0) {
            if (panel) {
                panel.store.setRoundStatus({ runId: panel.runId, roundId, status: 'done' });
            }
            break;
        }

        const executedCalls = [];
        let lorebookDirty = false;

        for (const call of toolCalls) {
            throwIfAborted(payload?.signal, 'Search agent aborted.');
            const callName = String(call?.name || '').trim();
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            let result = null;

            if (panel) {
                const callSectionId = `tool-${call.id || callName}`;
                panel.store.ensureSection({ runId: panel.runId, roundId, section: { id: callSectionId, kind: 'tool_call', title: i18nFormat('Tool: ${0}', callName), meta: { args } } });
                panel.store.setSectionStatus({ runId: panel.runId, roundId, sectionId: callSectionId, status: 'done' });
            }

            if (callName === TOOL_NAMES.AGENT_SEARCH) {
                try {
                    result = await searchWeb(args, { abortSignal: payload?.signal || null });
                    throwIfAborted(payload?.signal, 'Search agent aborted.');
                } catch (error) {
                    if (isAbortError(error, payload?.signal || null)) {
                        throw error;
                    }
                    result = buildRecoverableToolErrorResult(error, 'Search tool failed.');
                }
            } else if (callName === TOOL_NAMES.AGENT_VISIT) {
                try {
                    result = await visitWebPage(args, { abortSignal: payload?.signal || null });
                    throwIfAborted(payload?.signal, 'Search agent aborted.');
                } catch (error) {
                    if (isAbortError(error, payload?.signal || null)) {
                        throw error;
                    }
                    result = buildRecoverableToolErrorResult(error, 'Visit tool failed.');
                }
            } else if (callName === TOOL_NAMES.AGENT_GET) {
                result = getManagedEntriesByIds(lorebookData, args?.entry_ids || []);
            } else if (callName === TOOL_NAMES.AGENT_UPSERT) {
                if (!lorebookData) {
                    const createdLorebook = await ensureSharedLorebook(context, true);
                    throwIfAborted(payload?.signal, 'Search agent aborted.');
                    lorebookBookName = createdLorebook.bookName;
                    lorebookData = createdLorebook.data && typeof createdLorebook.data === 'object'
                        ? createdLorebook.data
                        : { entries: {} };
                }
                result = upsertManagedEntry(lorebookData, settings, args);
                lorebookDirty = lorebookDirty || Boolean(result?.changed);
                if (result?.changed) {
                    mutationCount += 1;
                }
            } else if (callName === TOOL_NAMES.AGENT_DELETE) {
                result = deleteManagedEntries(lorebookData, args?.entry_ids || []);
                lorebookDirty = lorebookDirty || Boolean(result?.changed);
                if (result?.changed) {
                    mutationCount += Number(result.deleted?.length || 0);
                }
            }

            executedCalls.push({
                ...call,
                result,
            });

            if (panel) {
                const resultSectionId = `tool-result-${call.id || callName}`;
                panel.store.ensureSection({ runId: panel.runId, roundId, section: { id: resultSectionId, kind: 'tool_result', title: i18nFormat('Tool result: ${0}', callName), meta: { ok: result?.ok !== false } } });
                panel.store.appendToSection({ runId: panel.runId, roundId, sectionId: resultSectionId, delta: serializeToolResultContent(result) });
                panel.store.setSectionStatus({ runId: panel.runId, roundId, sectionId: resultSectionId, status: 'done' });
            }
        }

        if (lorebookDirty && lorebookBookName && lorebookData) {
            throwIfAborted(payload?.signal, 'Search agent aborted.');
            internalRuntimeWorldInfo = await flushLorebookChanges(context, payload, lorebookBookName, lorebookData);
            throwIfAborted(payload?.signal, 'Search agent aborted.');
            await commitSearchAgentEntries(context, runAnchor, lorebookData);
            throwIfAborted(payload?.signal, 'Search agent aborted.');
        }

        appendStandardToolRoundMessages(toolHistoryMessages, executedCalls, response.assistantText || '', {
            reasoning: response?.reasoning || '',
            signature: response?.signature || null,
            reasoningBlocks: response?.reasoningBlocks || null,
            reasoningDetails: response?.reasoningDetails || null,
            nativeParts: response?.nativeParts || null,
            nativeContentBlocks: response?.nativeContentBlocks || null,
            responsesOutputItems: response?.responsesOutputItems || null,
        });

        if (panel) {
            panel.store.setRoundStatus({ runId: panel.runId, roundId, status: 'done' });
        }
    }

    const finalLorebook = lorebookData
        ? { bookName: lorebookBookName, data: lorebookData }
        : await ensureSharedLorebook(context, true);
    throwIfAborted(payload?.signal, 'Search agent aborted.');
    const finalManagedEntries = finalLorebook?.data ? listManagedEntries(finalLorebook.data) : [];
    const normalizedManagedEntries = normalizeStoredManagedEntries(finalManagedEntries);
    latestManagedEntries = normalizedManagedEntries;
    return {
        mutationCount,
        bookName: finalLorebook?.bookName || '',
        managedEntryCount: finalManagedEntries.length,
        managedEntries: normalizedManagedEntries,
    };
}

async function maybeRunPreRequestSearchAgent(payload) {
    const context = getContext();
    const settings = getSettings();
    if (!settings.preRequestEnabled) {
        return;
    }
    if (!payload || typeof payload !== 'object' || payload.dryRun) {
        return;
    }
    if (!ALLOWED_GENERATION_TYPES.has(String(payload.type || '').trim())) {
        return;
    }
    if (!Array.isArray(payload.coreChat) || payload.coreChat.length === 0) {
        return;
    }
    if (payload?.signal?.aborted) {
        return;
    }

    await loadSearchToolsChatState(context, { force: false });
    if (payload?.signal?.aborted) {
        return;
    }
    await syncSharedLorebookForCurrentChat(context);
    if (payload?.signal?.aborted) {
        return;
    }
    const chatKey = getChatKey(context);
    const generationType = String(payload?.type || '').trim().toLowerCase();
    const anchor = buildLastUserAnchor(context, payload.coreChat);
    if (REUSE_GENERATION_TYPES.has(generationType) && canReuseLatestSearchAgentSnapshot(chatKey, anchor)) {
        updateUiStatus(buildSearchAgentStatusText(latestSearchAgentSnapshot, { reused: true }));
        return;
    }

    if (activeAgentAbortController && !activeAgentAbortController.signal.aborted) {
        activeAgentAbortController.abort();
    }

    const runToken = ++activeAgentRunToken;
    const pluginAbortController = new AbortController();
    activeAgentAbortController = pluginAbortController;
    const linkedAbort = linkAbortSignals(payload?.signal, pluginAbortController.signal);
    const effectivePayload = linkedAbort.signal && linkedAbort.signal !== payload?.signal
        ? { ...payload, signal: linkedAbort.signal }
        : payload;
    let stopRequestedByUser = false;
    let resolveStopRequest = null;
    const stopRequestPromise = new Promise((resolve) => {
        resolveStopRequest = () => {
            if (stopRequestedByUser) {
                return;
            }
            stopRequestedByUser = true;
            if (!pluginAbortController.signal.aborted) {
                pluginAbortController.abort();
            }
            resolve({ stopped: true });
        };
    });

    if (searchRunPanel) {
        const liveRun = searchRunPanel.store.getCurrentRun();
        if (liveRun && liveRun.status === 'running') {
            try {
                searchRunPanel.store.finishRun({ runId: liveRun.runId, status: 'aborted' });
            } catch (_) { /* best-effort */ }
        }
    }
    const runId = searchRunPanel
        ? searchRunPanel.store.startRun({ mode: 'search', chatKey, stopFn: () => resolveStopRequest?.() })
        : null;

    updateUiStatus(i18n('Search agent running...'));

    try {
        const agentTask = runPreRequestSearchAgent(context, settings, effectivePayload, runId ? { store: searchRunPanel.store, runId } : null, { anchor });
        void agentTask.catch((error) => {
            if (!stopRequestedByUser) {
                return;
            }
            if (!isAbortError(error, effectivePayload?.signal || null)) {
                console.warn(`[${MODULE_NAME}] Search agent finished after user stop`, error);
            }
        });
        const raced = await Promise.race([
            agentTask.then(result => ({ stopped: false, result })),
            stopRequestPromise,
        ]);
        if (raced?.stopped) {
            syncMutableGenerationPayloadState(payload, effectivePayload);
            updateUiStatus(i18n('Search agent aborted.'));
            searchRunPanel?.store.finishRun({ runId, status: 'aborted' });
            return;
        }
        syncMutableGenerationPayloadState(payload, effectivePayload);
        const result = raced?.result;
        if (runToken !== activeAgentRunToken) {
            return;
        }
        throwIfAborted(effectivePayload?.signal, 'Search agent aborted.');
        await storeCompletedSearchAgentSnapshot(context, anchor, result);
        updateUiStatus(buildSearchAgentStatusText(result));
        searchRunPanel?.store.finishRun({ runId, status: 'committed' });
    } catch (error) {
        syncMutableGenerationPayloadState(payload, effectivePayload);
        if (runToken !== activeAgentRunToken) {
            return;
        }
        if (isAbortError(error, effectivePayload?.signal || null)) {
            updateUiStatus(i18n('Search agent aborted.'));
            searchRunPanel?.store.finishRun({ runId, status: 'aborted' });
            return;
        }
        console.warn(`[${MODULE_NAME}] Pre-request search agent failed`, error);
        // If the failure was a snapshot-persistence throw, the error message
        // already carries the reason-aware text from persistSnapshotErrorMessage;
        // preserve it so the user sees why (storage conflict, network error,
        // etc.) instead of a generic fallback. Every variant of that helper
        // shares the same prefix in each locale, derived from the canonical
        // localized "Failed to persist search agent snapshot." minus its
        // trailing period — so localize once and strip the period to get the
        // prefix that matches both English and translated locales.
        const errorMsg = String(error?.message || '');
        const snapshotKey = i18n('Failed to persist search agent snapshot.');
        const snapshotPrefix = snapshotKey.replace(/[.。]\s*$/, '');
        if (snapshotPrefix && errorMsg.startsWith(snapshotPrefix)) {
            updateUiStatus(errorMsg);
        } else {
            updateUiStatus(i18n('Search agent failed. Check console for details.'));
        }
        searchRunPanel?.store.finishRun({ runId, status: 'error', error: String(error?.message || error) });
    } finally {
        linkedAbort.cleanup();
        if (activeAgentAbortController === pluginAbortController) {
            activeAgentAbortController = null;
        }
    }
}

/**
 * Identity of what the shared lorebook currently projects. A structural chat
 * change that does not move the committed entry set (e.g. swiping an
 * assistant reply) leaves this unchanged, so the lorebook does not need
 * another write.
 */
function describeSelectedSearchSnapshot() {
    return JSON.stringify(latestManagedEntries);
}

/**
 * Re-read the chat-scoped search state and re-project it onto the shared
 * lorebook. floor-state settles its commit log before core emits each
 * structural event, so by the time this runs the stored entry set already
 * reflects the deletion / swipe.
 */
async function resyncSearchToolsStateAfterStructuralChange() {
    const context = getContext();
    const before = describeSelectedSearchSnapshot();
    try {
        await loadSearchToolsChatState(context, { force: true });
    } catch (error) {
        console.warn(`[${MODULE_NAME}] structural resync could not reload chat state`, error);
        return;
    }
    if (describeSelectedSearchSnapshot() !== before) {
        try {
            await syncSharedLorebookForCurrentChat(context);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] structural resync could not update the shared lorebook`, error);
        }
    }
    await refreshUiStatusForCurrentChat();
}

/**
 * Drop the cached chat state and re-project it whenever the active chat
 * changes. Exported so tests can drive the wiring without the DOM-ready path.
 */
function registerSearchToolsChatChangedSync(context = getContext()) {
    if (!context?.eventTypes?.CHAT_CHANGED) {
        return;
    }
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        abortActiveSearchAgentRun();
        loadedChatStateKey = '';
        latestSearchAgentSnapshot = null;
        latestManagedEntries = [];
        const liveContext = getContext();
        void loadSearchToolsChatState(liveContext, { force: true })
            .then(() => syncSharedLorebookForCurrentChat(liveContext))
            .catch((error) => {
                console.warn(`[${MODULE_NAME}] Failed to reload search chat state on chat change`, error);
                return syncSharedLorebookForCurrentChat(liveContext);
            })
            .finally(() => refreshUiStatusForCurrentChat());
    });
}

/**
 * Re-project the shared lorebook whenever a structural chat change
 * invalidates the stored search snapshot. Exported so tests can drive the
 * wiring without the DOM-ready path.
 */
function registerSearchToolsStructuralSync(context = getContext()) {
    const types = context?.eventTypes;
    const source = context?.eventSource;
    if (!types || !source) {
        return;
    }
    const structuralEvents = [
        types.MESSAGE_DELETED,
        types.MESSAGE_SWIPED,
        types.MESSAGE_SWIPE_DELETED,
        types.MESSAGE_EDITED,
    ].filter(Boolean);
    for (const eventName of structuralEvents) {
        source.on(eventName, () => { void resyncSearchToolsStateAfterStructuralChange(); });
    }
}

const {
    destroy: destroySettingsUi,
    ensureUi,
    refreshUiStatusForCurrentChat,
    updateUiStatus,
} = createSearchToolsSettingsUi({
    DEFAULT_SETTINGS,
    MODULE_NAME,
    SECRET_KEYS,
    STATUS_ID,
    STYLE_ID,
    UI_BLOCK_ID,
    clampInteger,
    ensureSharedLorebook,
    escapeHtml,
    extension_prompt_roles,
    getAvailableSearchProviders,
    getConnectionProfileOptions: renderConnectionProfileOptions,
    getContext,
    getOpenAIPresetOptions: (context, selectedName) => renderOpenAIPresetOptions(context, selectedName),
    getProviderDefinition,
    getProviderSettings,
    getSettings,
    hasConfiguredSecret,
    i18n,
    i18nFormat,
    listManagedEntries,
    manuallyDeleteManagedEntries,
    manuallyResetManagedEntries,
    getManagedEntriesSnapshot,
    POPUP_TYPE,
    Popup,
    normalizeFieldValue,
    normalizeLorebookPosition,
    normalizeLorebookRole,
    normalizeProvider,
    normalizeSafeSearch,
    normalizeWhitespace,
    saveSettingsDebounced,
    showRunPanel: () => Luker.getContext()?.runPanel?.openRunDock?.(),
    syncSharedLorebookForCurrentChat,
    syncSharedLorebookForLoadedChat,
    world_info_position,
});

jQuery(() => {
    ensureSettings();
    initSearchRunPanel();
    installGlobalApi();
    publishSearchToolsExtensionApi();

    const context = getContext();
    registerTools(context);
    ensureUi();
    globalThis.window?.addEventListener?.('pagehide', (event) => {
        if (event?.persisted) return;
        destroySettingsUi();
    });
    // search-tools publishes its 2 read tools into the orchestrator's
    // Layer-2 registry so any of the four orchestration modes can
    // dispatch them. Deferred to APP_READY because search-tools is
    // loaded at loading_order 109 — before orchestrator (110) — so the
    // sync `getExtensionApi('orchestrator')` lookup inside
    // `registerSearchToolsOrchestrationTools` would see no API yet if
    // invoked from this jQuery ready handler. By APP_READY, every
    // extension's top-level `registerExtensionApi` has already run.
    // Silent no-op when orchestrator isn't installed.
    eventSource.on(event_types.APP_READY, () => {
        registerSearchToolsOrchestrationTools();
    });
    void loadSearchToolsChatState(context, { force: true })
        .then(() => syncSharedLorebookForCurrentChat(context))
        .catch((error) => {
            // readLegacySearchToolsState now throws on transient legacy-index
            // reads (storage envelope rejected); without a .catch this would
            // become an unhandled rejection on boot.
            console.warn(`[${MODULE_NAME}] boot load failed: ${error?.message || error}`);
        })
        .finally(() => refreshUiStatusForCurrentChat());

    const wiAfterEvent = context?.eventTypes?.GENERATION_AFTER_WORLD_INFO_SCAN;
    if (wiAfterEvent) {
        context.eventSource.on(wiAfterEvent, async (payload) => {
            await maybeRunPreRequestSearchAgent(payload);
        });
    }

    registerSearchToolsChatChangedSync(context);
    registerSearchToolsStructuralSync(context);

    if (context?.eventTypes?.PRESET_CHANGED) {
        context.eventSource.on(context.eventTypes.PRESET_CHANGED, (event) => {
            if (String(event?.apiId || '') === 'openai') {
                ensureUi();
            }
        });
    }

    const connectionProfileEvents = [
        context?.eventTypes?.CONNECTION_PROFILE_LOADED,
        context?.eventTypes?.CONNECTION_PROFILE_CREATED,
        context?.eventTypes?.CONNECTION_PROFILE_DELETED,
        context?.eventTypes?.CONNECTION_PROFILE_UPDATED,
    ].filter(Boolean);
    for (const eventName of connectionProfileEvents) {
        context.eventSource.on(eventName, () => ensureUi());
    }

    const secretEvents = [
        event_types.SECRET_WRITTEN,
        event_types.SECRET_DELETED,
        event_types.SECRET_ROTATED,
    ];
    for (const eventName of secretEvents) {
        eventSource.on(eventName, (key) => {
            if (key === SECRET_KEYS.BRAVE_SEARCH) {
                ensureUi();
            }
        });
    }
});

export {
    buildAgentTools,
    buildManagedEntryCatalog,
    DEFAULT_SETTINGS,
    getManagedEntriesByIds,
    registerSearchToolsChatChangedSync,
    registerSearchToolsStructuralSync,
    runPreRequestSearchAgent,
};
