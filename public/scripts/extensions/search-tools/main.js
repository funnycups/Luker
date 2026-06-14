// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { getChatCompletionConnectionProfiles } from '../connection-manager/profile-resolver.js';
import {
    TOOL_PROTOCOL_STYLE,
    validateParsedToolCalls,
} from '../function-call-runtime.js';
import { createSearchToolsSettingsUi } from './settings-ui.js';
import {
    buildLastUserAnchor,
    getPlayableMessageAt,
    normalizeAnchorPlayableFloor,
} from './anchors.js';
import {
    commitAnchorSnapshot,
    getFloorStateInstance,
    loadAnchorMap,
    loadMetaSidecar,
    migrateLegacyAnchorsIfNeeded,
    persistFallbackManagedEntries,
    pickLatestValidSnapshot,
} from './persistence.js';
import { registerSearchToolsOrchestrationTools } from './orchestrator-tools.js';

const __ctx = Luker.getContext();
const eventSource = __ctx.eventSource;
const event_types = __ctx.eventTypes;
const extension_prompt_roles = __ctx.constants.promptRoles;
const getRequestHeaders = __ctx.getRequestHeaders;
const saveSettings = __ctx.saveSettings;
const saveSettingsDebounced = __ctx.saveSettingsDebounced;
const extension_settings = __ctx.extensionSettings;
const getContext = Luker.getContext;
const addLocaleData = __ctx.addLocaleData;
const translate = __ctx.translate;
const SECRET_KEYS = __ctx.secrets.KEYS;
const secret_state = __ctx.secrets.state;
const escapeHtml = __ctx.escapeHtml;
const getStringHash = __ctx.getStringHash;
const newWorldInfoEntryTemplate = __ctx.worldInfoEntry.template;
const setGlobalWorldInfoSelection = __ctx.worldInfoEntry.setGlobalSelection;
const world_info_position = __ctx.constants.wiPosition;
const POPUP_TYPE = __ctx.POPUP_TYPE;
const Popup = __ctx.Popup;

const MODULE_NAME = 'search_tools';
const UI_BLOCK_ID = 'search_tools_settings';
const STYLE_ID = 'search_tools_style';
const STATUS_ID = 'search_tools_status';
const CHAT_LOREBOOK_METADATA_KEY = 'world_info';
const SHARED_LOREBOOK_NAME = '__SEARCH_TOOLS__';
const MANAGED_COMMENT_PREFIX = 'SEARCH_TOOLS';
const ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
const REUSE_GENERATION_TYPES = new Set(['continue', 'regenerate', 'swipe']);
const TOOL_NAMES = Object.freeze({
    SEARCH: 'luker_web_search',
    VISIT: 'luker_web_visit',
    AGENT_SEARCH: 'luker_search_agent_search',
    AGENT_VISIT: 'luker_search_agent_visit',
    AGENT_UPSERT: 'luker_search_agent_upsert_lorebook_entry',
    AGENT_DELETE: 'luker_search_agent_delete_lorebook_entry',
    AGENT_FINALIZE: 'luker_search_agent_finalize',
});
const EXPORTED_TOOL_NAMES = Object.freeze({
    SEARCH: TOOL_NAMES.SEARCH,
    VISIT: TOOL_NAMES.VISIT,
});
const DEFAULT_LOREBOOK_CONTENT_TEMPLATE_GUIDANCE = [
    'When you write lorebook content, the content field must be exactly one fenced yaml code block.',
    'If an entry is created to provide creative inspiration, candidate suggestions, or temporary creative reference, set it constant / always_inject and add explicit top-level YAML markers `entry_usage: creative_inspiration_constant` and `retention: delete_if_unused_after_one_creation_round` inside the entry.',
    'A non-constant entry is allowed only when the latest user input clearly already contains or directly invokes that entry\'s trigger words.',
    'If the current turn does not need any real external reference grounding, do not create or update a lorebook entry at all.',
    'Never write original setting material, speculative filler, plot continuation, or any content that is not directly grounded in managed search entries, search results, or visited pages.',
    'Treat the templates below as flexible reference skeletons, not a rigid schema.',
    'You may freely delete, rename, regroup, merge, or add sections when useful, as long as every included detail is directly supported by managed search entries, search results, or visited pages.',
    'Do not keep empty placeholders, filler headings, or sections with no informational value.',
    'When the source clearly indicates the canonical work (novel/game/anime/comic/film), include a top-level `source_work` field (label meaning: 原作).',
    'Do not let the current chat context, roleplay direction, or likely next scene distort the entry. Keep it faithful to the gathered source material itself.',
    'Prefer clear, information-dense worldbook notes over a minimal one- or two-sentence summary when the source supports more detail.',
    'For character entries, source-backed roleplay-useful details such as mannerisms, speech style, and speech examples are allowed when the source explicitly supports them.',
    'Speech examples must only be included when directly evidenced by the source text or an explicit quoted line.',
    'Reference character template:',
    '```yaml',
    'name: "<Character Name>"',
    'source_work: "<原作 / Source Work>"',
    'aliases:',
    '  - "<Alias>"',
    'role: "<Identity or role>"',
    'overview: |',
    '  <Source-backed overview>',
    'identity:',
    '  species: "<Species or type>"',
    '  occupation:',
    '    - "<Occupation or function>"',
    '  affiliation:',
    '    - "<Group or faction>"',
    'appearance:',
    '  - "<Stable visual trait>"',
    'personality:',
    '  - "<Stable trait or behavioral tendency>"',
    'mannerisms:',
    '  - "<Habit or recognizable behavior>"',
    'speech:',
    '  style:',
    '    - "<Speaking style or register>"',
    '  examples:',
    '    - "<Source-backed line or phrasing pattern>"',
    'background:',
    '  - "<Relevant history>"',
    'relationships:',
    '  - target: "<Person or group>"',
    '    relation: "<Relationship>"',
    '    notes: "<Source-backed detail>"',
    'abilities:',
    '  - "<Ability, skill, or limitation>"',
    'items:',
    '  - "<Equipment or associated item>"',
    'notable_facts:',
    '  - "<Important fact>"',
    '```',
    'Reference event template:',
    '```yaml',
    'title: "<Event Name>"',
    'aliases:',
    '  - "<Alternate name>"',
    'time: "<Time or period>"',
    'location: "<Place>"',
    'overview: |',
    '  <Source-backed overview>',
    'background:',
    '  - "<Cause or prior condition>"',
    'participants:',
    '  - "<Participant>"',
    'sequence:',
    '  - stage: "<Stage or moment>"',
    '    details:',
    '      - "<What happened>"',
    'results:',
    '  - "<Outcome or consequence>"',
    'notable_details:',
    '  - "<Memorable detail>"',
    '```',
    'Reference location template:',
    '```yaml',
    'name: "<Location Name>"',
    'aliases:',
    '  - "<Alternate name>"',
    'type: "<City, building, region, site, ruin, venue>"',
    'overview: |',
    '  <Source-backed overview>',
    'environment:',
    '  - "<Environmental or atmospheric trait>"',
    'layout:',
    '  - "<Area, division, or structural feature>"',
    'inhabitants:',
    '  - "<Residents, caretakers, or controlling group>"',
    'rules_or_customs:',
    '  - "<Local rule, taboo, or custom>"',
    'notable_features:',
    '  - "<Landmark, danger, or resource>"',
    'history:',
    '  - "<Important historical fact>"',
    '```',
    'Reference organization template:',
    '```yaml',
    'name: "<Organization Name>"',
    'aliases:',
    '  - "<Alternate name>"',
    'type: "<Organization type>"',
    'overview: |',
    '  <Source-backed overview>',
    'purpose:',
    '  - "<Goal or mission>"',
    'structure:',
    '  - "<Hierarchy or operating model>"',
    'members:',
    '  - "<Key member or subgroup>"',
    'assets:',
    '  - "<Resources, territory, or influence>"',
    'methods:',
    '  - "<Typical methods or activities>"',
    'relations:',
    '  - target: "<Other party>"',
    '    status: "<Friendly, hostile, neutral, subordinate, allied>"',
    '    notes: "<Source-backed detail>"',
    'notable_facts:',
    '  - "<Important fact>"',
    '```',
    'Reference item / technology / concept / rule template:',
    '```yaml',
    'name: "<Name>"',
    'aliases:',
    '  - "<Alternate name>"',
    'type: "<Item, technology, concept, rule, power system>"',
    'overview: |',
    '  <Source-backed overview>',
    'properties:',
    '  - "<Property or defining trait>"',
    'usage:',
    '  - "<Use or application>"',
    'mechanics:',
    '  - "<How it works, including limits or costs>"',
    'owners_or_users:',
    '  - "<Associated person or group>"',
    'notable_facts:',
    '  - "<Important fact>"',
    '```',
].join('\n');
const DEFAULT_LOREBOOK_CONTENT_TASK_GUIDANCE = [
    '- In the AGENT_UPSERT content field, write exactly one fenced yaml code block.',
    '- Treat the YAML templates as flexible reference skeletons rather than a rigid schema. Delete irrelevant sections and add useful source-backed ones freely.',
    '- If an entry is for creative inspiration, candidate suggestions, or temporary creative reference, it must use always_inject=true and include top-level YAML markers `entry_usage: creative_inspiration_constant` and `retention: delete_if_unused_after_one_creation_round`.',
    '- Inspiration constant entries are disposable scaffolding: after one creation round, if the current chat branch confirms they are no longer needed, delete them.',
    '- Set always_inject=false only when the latest user message clearly already contains or directly invokes the entry trigger words; then use precise keywords matching that visible wording.',
    '- If there is no real external information gap for this turn, do not write or update any lorebook entry.',
    '- Every included claim must be traceable to managed search entries, search snippets, or visited page text already available in this run. If you cannot point to grounded evidence, omit it.',
    '- If a candidate write is being shaped by current plot pressure, scene mood, expected next actions, or your own creative completion, do not write it.',
    '- Character entries may include source-backed mannerisms, speech style, and speech examples when the evidence explicitly supports them.',
    '- Do not keep empty placeholders, and do not let current chat context distort the source-backed entry.',
].join('\n');

const DEFAULT_AGENT_SYSTEM_PROMPT = [
    'You are a pre-request web research agent for roleplay generation.',
    'Your job is to decide whether any search-backed lorebook update is necessary before the main generation request continues.',
    'Your first decision is whether this turn actually needs any external research or search-backed lorebook mutation at all.',
    'If the user is simply continuing an original scene, asking for pure creative writing, or the needed grounding is already covered by active world info, character info, or managed search entries, do not search and do not write new entries. Finalize immediately.',
    'You may finish immediately without searching if active world info, character information, and managed search entries already cover the need.',
    'Search-backed lorebook content must stay strictly faithful to the source text from managed search entries, search results, and visited pages.',
    'Every managed lorebook entry must read like an objective reference note, not like story direction, roleplay guidance, or character writing advice.',
    'Search tools are only for external reference grounding. They are not for inventing lore, repairing thin scene context with creativity, or turning the current plot into fake research-backed notes.',
    'Treat search output as source material only. Any story-driven adaptation, reinterpretation, dramatization, or extrapolation is out of scope.',
    'Do not rewrite source-backed facts to fit the current plot, scene mood, or roleplay direction.',
    'Do not infer or invent character emotions, cognition, motives, intentions, hidden thoughts, relationship shifts, future actions, or plot consequences unless the source explicitly states them.',
    'Do not write instructions, recommendations, likely reactions, behavioral coaching, tone guidance, scene framing, or any text that tells the main model how to portray a character or continue the story.',
    'If a source is ambiguous, keep wording neutral or do not write it.',
    'Never create a managed entry whose content is original, speculative, scene-driven, or unrelated to the gathered search evidence.',
    'Avoid duplicates. If information would repeat existing active world info, character card facts, or existing managed search entries, do not add it.',
    'Search and visit are optional. You may use existing managed search entries as your own database.',
    'If information is uncertain, highly time-sensitive, or search snippets are insufficient, prefer search plus visit before writing.',
    `Keep each response focused. Prefer 1 to 3 new ${TOOL_NAMES.AGENT_SEARCH} calls per response, avoid exceeding 4 unless absolutely necessary, and never spray many near-duplicate searches in one response.`,
    `Call ${TOOL_NAMES.AGENT_FINALIZE} only when you are ready to end the run.`,
    `If you call ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT}, do not call ${TOOL_NAMES.AGENT_FINALIZE} in that same response. Wait for tool results first.`,
    'Only delete entries that are explicitly listed as deletable.',
    'Before any tool calls, output exactly one structured <thought>...</thought> block.',
    'Hard output format for <thought> (must follow exactly this order):',
    '<thought>',
    '[1] Need gate: state whether there is a real external information gap for this turn. If not, say so explicitly and finalize.',
    '[2] Evidence gate: for every planned write, update, or deletion, name the exact supporting evidence already available from managed entries, search results, or visited pages. If evidence is missing, say no grounded write yet.',
    '[3] Contamination gate: explicitly check whether any planned content is being influenced by plot pressure, current scene momentum, expected next actions, roleplay preference, or your own invention. Remove anything contaminated.',
    '[4] Activation gate: for each planned entry, state constant vs non-constant and why. A non-constant entry is valid only if the latest user input clearly already contains or directly invokes that entry\'s trigger words; quote or name those trigger words explicitly.',
    '[5] Cleanup gate: check whether any existing creative-inspiration constant entry has already served one creation round and is now confirmed unnecessary; if so, delete it.',
    '[6] Action: choose exactly what to do now: finalize, search, visit, upsert, delete, or a grounded combination allowed by the tool contract.',
    '</thought>',
    'If the thought block misses any required section above, treat your own response as invalid and regenerate fully.',
    'Use the thought block as a preflight check. If [1] says no real external gap, do not search and do not write.',
    `If fresh evidence is still needed, [6] should choose ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT} only. Do not commit to concrete lorebook writes before the evidence arrives.`,
    'After new search or visit results arrive, run the full gate sequence again from the updated evidence and only then decide concrete entry writes or deletions.',
    'For lorebook writes, provide only the needed persistent factual content, activation keywords, and whether it should always inject.',
    DEFAULT_LOREBOOK_CONTENT_TEMPLATE_GUIDANCE,
    'Use always-inject entries when the information must stay visible in context continuously without a trigger. This includes always-on rules, core worldbuilding, setting assumptions, power-system rules, social norms, and any entry created to provide creative inspiration, candidate suggestions, or temporary creative reference.',
    'For creative-inspiration entries, always set constant / always_inject and include explicit top-level YAML markers `entry_usage: creative_inspiration_constant` and `retention: delete_if_unused_after_one_creation_round` inside the entry.',
    'After one creation round, if the current chat branch confirms an inspiration constant entry is no longer needed, delete it instead of keeping it.',
    'Set an entry non-constant only when the latest user input clearly already contains or directly invokes that entry\'s trigger words. That is the only valid reason to rely on keyword activation.',
    'When using a non-constant entry, choose precise trigger words that match wording already present in the latest user input.',
    'If the trigger words are not clearly present in the latest user input, do not create a non-constant entry merely because it might become relevant later.',
    'Prefer concise declarative fact statements over narrative prose.',
    'When writing lorebook content, preserve source scope and uncertainty instead of upgrading it into stronger claims.',
    'Do not move or redesign lorebook layout. Runtime controls managed entry position/depth/role/order from current settings.',
    'Outside the single <thought>...</thought> block and tool calls, do not output plain prose.',
].join('\n');

const DEFAULT_AGENT_FINAL_STAGE_PROMPT = [
    'You are the final-stage web research agent for roleplay generation.',
    'This stage exists to finish the pre-request search pass using only evidence already gathered earlier in this run.',
    `Do not call ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT} in this stage.`,
    'Use only managed search entries, previous search results, and visited page text already available in the conversation.',
    'Your first decision is whether any grounded lorebook mutation is still needed at all. If not, finalize immediately.',
    'Search-backed lorebook content must stay strictly faithful to the source text from managed search entries, search results, and visited pages.',
    'Every managed lorebook entry must read like an objective reference note, not like story direction, roleplay guidance, or character writing advice.',
    'Search tools are only for external reference grounding. They are not for inventing lore, repairing thin scene context with creativity, or turning the current plot into fake research-backed notes.',
    'Treat search output as source material only. Any story-driven adaptation, reinterpretation, dramatization, or extrapolation is out of scope.',
    'Do not infer or invent character emotions, cognition, motives, intentions, hidden thoughts, relationship shifts, future actions, or plot consequences unless the source explicitly states them.',
    'Do not write instructions, recommendations, likely reactions, behavioral coaching, tone guidance, scene framing, or any text that tells the main model how to portray a character or continue the story.',
    'If a source is ambiguous, keep wording neutral or do not write it.',
    'Never create a managed entry whose content is original, speculative, scene-driven, or unrelated to the gathered search evidence.',
    'Avoid duplicates. If information would repeat existing active world info, character card facts, or existing managed search entries, do not add it.',
    'Only delete entries that are explicitly listed as deletable.',
    'Delete any managed search entries that are no longer needed, outdated for the current chat branch, duplicated, or unsupported by the gathered evidence.',
    'Do not preserve stale managed search entries just because they already exist.',
    'Before any tool calls, output exactly one structured <thought>...</thought> block.',
    'Hard output format for <thought> (must follow exactly this order):',
    '<thought>',
    '[1] Need gate: state whether any grounded lorebook mutation is still needed. If not, say so explicitly and finalize.',
    '[2] Evidence gate: for every planned write, update, or deletion, name the exact supporting evidence already available from managed entries, search results, or visited pages. If evidence is missing, do not write.',
    '[3] Contamination gate: explicitly check whether any planned content is being influenced by plot pressure, current scene momentum, expected next actions, roleplay preference, or your own invention. Remove anything contaminated.',
    '[4] Activation gate: for each planned entry, state constant vs non-constant and why. A non-constant entry is valid only if the latest user input clearly already contains or directly invokes that entry\'s trigger words; quote or name those trigger words explicitly.',
    '[5] Cleanup gate: check whether any existing creative-inspiration constant entry has already served one creation round and is now confirmed unnecessary; if so, delete it.',
    '[6] Action: choose exactly what to do now: finalize, upsert, delete, or a grounded combination allowed by the tool contract.',
    '</thought>',
    'If the thought block misses any required section above, treat your own response as invalid and regenerate fully.',
    'Use the thought block as a preflight check. If [1] says no grounded mutation is needed, finalize immediately.',
    'No new evidence will arrive in this stage, so base writes, deletions, and finalization only on evidence already gathered.',
    'For lorebook writes, provide only the needed persistent factual content, activation keywords, and whether it should always inject.',
    DEFAULT_LOREBOOK_CONTENT_TEMPLATE_GUIDANCE,
    'Use always-inject entries when the information must stay visible in context continuously without a trigger. This includes always-on rules, core worldbuilding, setting assumptions, power-system rules, social norms, and any entry created to provide creative inspiration, candidate suggestions, or temporary creative reference.',
    'For creative-inspiration entries, always set constant / always_inject and include explicit top-level YAML markers `entry_usage: creative_inspiration_constant` and `retention: delete_if_unused_after_one_creation_round` inside the entry.',
    'After one creation round, if the current chat branch confirms an inspiration constant entry is no longer needed, delete it instead of keeping it.',
    'Set an entry non-constant only when the latest user input clearly already contains or directly invokes that entry\'s trigger words. That is the only valid reason to rely on keyword activation.',
    'When using a non-constant entry, choose precise trigger words that match wording already present in the latest user input.',
    'If the trigger words are not clearly present in the latest user input, do not create a non-constant entry merely because it might become relevant later.',
    'Prefer concise declarative fact statements over narrative prose.',
    'When writing lorebook content, preserve source scope and uncertainty instead of upgrading it into stronger claims.',
    'Outside the single <thought>...</thought> block and tool calls, do not output plain prose.',
    `If any lorebook change is still needed, do it now and also call ${TOOL_NAMES.AGENT_FINALIZE} in the same response.`,
    `If no lorebook change is needed, call ${TOOL_NAMES.AGENT_FINALIZE} immediately.`,
    `Always finish by calling ${TOOL_NAMES.AGENT_FINALIZE}.`,
].join('\n');

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    preRequestEnabled: false,
    provider: 'ddg',
    defaultMaxResults: 8,
    defaultVisitMaxChars: 4000,
    safeSearch: 'moderate',
    providers: Object.freeze({
        ddg: Object.freeze({
            safeSearch: 'moderate',
        }),
        searxng: Object.freeze({
            baseUrl: '',
            safeSearch: 'moderate',
        }),
        brave: Object.freeze({
            safeSearch: 'moderate',
        }),
    }),
    agentApiPresetName: '',
    agentPresetName: '',
    includeWorldInfoWithPreset: true,
    agentSystemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
    agentFinalStagePrompt: DEFAULT_AGENT_FINAL_STAGE_PROMPT,
    agentMaxRounds: 3,
    toolCallRetryMax: 2,
    lorebookPosition: world_info_position.atDepth,
    lorebookDepth: 9999,
    lorebookRole: extension_prompt_roles.SYSTEM,
    lorebookEntryOrder: 9800,
    useStreamingTransport: false,
});
const LOREBOOK_POSITION_SCHEMA_VERSION = 2;
const SUPPORTED_WORLD_INFO_POSITIONS = Object.freeze([
    world_info_position.before,
    world_info_position.after,
    world_info_position.ANTop,
    world_info_position.ANBottom,
    world_info_position.EMTop,
    world_info_position.EMBottom,
    world_info_position.atDepth,
]);

let activeAgentRunToken = 0;
let activeAgentAbortController = null;
let latestSearchAgentSnapshot = null;
let latestManagedEntries = [];
let loadedChatStateKey = '';

function i18n(text) {
    return translate(String(text || ''));
}

function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}

function getAvailableSearchProviders() {
    return [
        {
            id: 'ddg',
            label: 'DuckDuckGo (no login)',
        },
        {
            id: 'searxng',
            label: 'SearXNG (custom instance)',
        },
        {
            id: 'brave',
            label: 'Brave Search (API key)',
        },
    ];
}

function getDefaultSearchProviderId() {
    return getAvailableSearchProviders()[0]?.id || 'ddg';
}

function getSearchProviderDefinition(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return getAvailableSearchProviders().find(provider => provider.id === normalized) || getAvailableSearchProviders()[0];
}

function normalizeProvider(value) {
    return getSearchProviderDefinition(value)?.id || getDefaultSearchProviderId();
}

function normalizeSafeSearch(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['off', 'moderate', 'strict'].includes(normalized) ? normalized : DEFAULT_SETTINGS.safeSearch;
}

function normalizeDdgProviderSettings(raw = {}, legacySafeSearch = DEFAULT_SETTINGS.safeSearch) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        safeSearch: normalizeSafeSearch(source.safeSearch ?? legacySafeSearch),
    };
}

function normalizeSearxngProviderSettings(raw = {}, legacySafeSearch = DEFAULT_SETTINGS.safeSearch) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        baseUrl: normalizeWhitespace(source.baseUrl || ''),
        safeSearch: normalizeSafeSearch(source.safeSearch ?? legacySafeSearch),
    };
}

function normalizeBraveProviderSettings(raw = {}, legacySafeSearch = DEFAULT_SETTINGS.safeSearch) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        safeSearch: normalizeSafeSearch(source.safeSearch ?? legacySafeSearch),
    };
}

function normalizeProviderSettings(raw = {}, legacy = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        ddg: normalizeDdgProviderSettings(source.ddg, legacy.safeSearch),
        searxng: normalizeSearxngProviderSettings(source.searxng, legacy.safeSearch),
        brave: normalizeBraveProviderSettings(source.brave, legacy.safeSearch),
    };
}

function getProviderSettings(settings = getSettings(), providerId = '') {
    const normalizedProviderId = normalizeProvider(providerId || settings?.provider);
    const source = settings?.providers && typeof settings.providers === 'object' ? settings.providers : {};
    if (normalizedProviderId === 'ddg') {
        return normalizeDdgProviderSettings(source.ddg, settings?.safeSearch);
    }
    if (normalizedProviderId === 'searxng') {
        return normalizeSearxngProviderSettings(source.searxng, settings?.safeSearch);
    }
    if (normalizedProviderId === 'brave') {
        return normalizeBraveProviderSettings(source.brave, settings?.safeSearch);
    }
    return {};
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
    const normalizedAgentSystemPrompt = String(settings.agentSystemPrompt ?? DEFAULT_SETTINGS.agentSystemPrompt).trim();
    settings.agentSystemPrompt = normalizedAgentSystemPrompt || DEFAULT_SETTINGS.agentSystemPrompt;
    const normalizedAgentFinalStagePrompt = String(settings.agentFinalStagePrompt ?? DEFAULT_SETTINGS.agentFinalStagePrompt).trim();
    settings.agentFinalStagePrompt = normalizedAgentFinalStagePrompt || DEFAULT_SETTINGS.agentFinalStagePrompt;
    settings.agentMaxRounds = clampInteger(
        settings.agentMaxRounds ?? DEFAULT_SETTINGS.agentMaxRounds,
        1,
        8,
        DEFAULT_SETTINGS.agentMaxRounds,
    );
    settings.toolCallRetryMax = clampInteger(
        settings.toolCallRetryMax ?? DEFAULT_SETTINGS.toolCallRetryMax,
        0,
        5,
        DEFAULT_SETTINGS.toolCallRetryMax,
    );
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

function normalizeStoredSearchAgentSnapshot(raw) {
    const source = raw && typeof raw === 'object' ? raw : null;
    if (!source) {
        return null;
    }

    const anchorHash = String(source.anchorHash || '').trim();
    if (!anchorHash) {
        return null;
    }

    const managedEntries = normalizeStoredManagedEntries(source.managedEntries);
    return {
        anchorHash,
        updatedAt: String(source.updatedAt || '').trim(),
        summary: normalizeWhitespace(source.summary || ''),
        mutationCount: Math.max(0, Math.floor(Number(source.mutationCount || 0))),
        managedEntryCount: Math.max(0, Math.floor(Number(source.managedEntryCount ?? managedEntries.length))),
        bookName: normalizeWhitespace(source.bookName || ''),
        managedEntries,
    };
}

function materializeSearchAgentSnapshot(chatKey, anchorPlayableFloor, snapshot) {
    const normalizedSnapshot = normalizeStoredSearchAgentSnapshot(snapshot);
    const normalizedChatKey = String(chatKey || '').trim();
    const normalizedAnchor = normalizeAnchorPlayableFloor(anchorPlayableFloor);
    if (!normalizedSnapshot || !normalizedChatKey || !normalizedAnchor) {
        return null;
    }

    const managedEntries = normalizeStoredManagedEntries(normalizedSnapshot.managedEntries);
    return {
        chatKey: normalizedChatKey,
        anchorFloor: normalizedAnchor,
        anchorPlayableFloor: normalizedAnchor,
        anchorHash: String(normalizedSnapshot.anchorHash || '').trim(),
        updatedAt: normalizedSnapshot.updatedAt,
        summary: normalizedSnapshot.summary,
        mutationCount: normalizedSnapshot.mutationCount,
        managedEntryCount: managedEntries.length,
        bookName: normalizedSnapshot.bookName,
        managedEntries,
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
    clearAgentRunInfoToast();
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

    // One-shot legacy upgrade. Idempotent — the persistence layer's schema
    // sidecar marks it complete after the first run on each chat.
    await migrateLegacyAnchorsIfNeeded(context);

    loadedChatStateKey = chatKey;
    const map = await loadAnchorMap(context);
    const pick = pickLatestValidSnapshot(context, map);

    if (pick) {
        latestSearchAgentSnapshot = materializeSearchAgentSnapshot(chatKey, pick.playableFloor, pick.snapshot);
        latestManagedEntries = latestSearchAgentSnapshot
            ? normalizeStoredManagedEntries(latestSearchAgentSnapshot.managedEntries)
            : [];
    } else {
        // No valid snapshot — fall back to the meta sidecar's
        // `fallbackManagedEntries`, populated only by legacy migrations.
        latestSearchAgentSnapshot = null;
        const meta = await loadMetaSidecar(context);
        latestManagedEntries = normalizeStoredManagedEntries(meta.fallbackManagedEntries);
    }

    if (latestManagedEntries.length === 0 && !latestSearchAgentSnapshot) {
        // Bootstrap from a pre-existing chat lorebook on a never-touched chat.
        const migratedEntries = await loadLegacyManagedEntries(context);
        if (migratedEntries.length > 0) {
            latestManagedEntries = migratedEntries;
            await persistFallbackManagedEntries(context, migratedEntries);
        }
    }
}

function getOpenAIPresetNames(context) {
    const manager = context.getPresetManager?.('openai');
    if (!manager || typeof manager.getAllPresets !== 'function') {
        return [];
    }
    const names = manager.getAllPresets();
    if (!Array.isArray(names)) {
        return [];
    }
    return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
}

function renderOpenAIPresetOptions(context, selectedName = '') {
    const selected = String(selectedName || '').trim();
    const names = getOpenAIPresetNames(context);
    const options = [`<option value="">${escapeHtml(i18n('(Current preset)'))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function renderConnectionProfileOptions(selectedName = '') {
    const selected = String(selectedName || '').trim();
    const names = getChatCompletionConnectionProfiles()
        .map(profile => String(profile?.name || '').trim())
        .filter(Boolean);
    const options = [`<option value="">${escapeHtml(i18n('(Current API config)'))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
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

async function runDdgSearch({
    query,
    maxResults,
    safeSearch,
    timeRange,
    region,
    abortSignal = null,
}) {
    const response = await fetch('/api/search/ddg', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: isAbortSignalLike(abortSignal) ? abortSignal : null,
        body: JSON.stringify({
            query,
            max_results: maxResults,
            safe_search: safeSearch,
            time_range: timeRange || '',
            region: region || '',
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`DDG search request failed (${response.status}): ${text || response.statusText}`);
    }

    const payload = await response.json();
    const results = normalizeSearchRows(payload?.results || [], 'ddg');
    return {
        provider: 'ddg',
        query: String(payload?.query || query || ''),
        result_count: Number(payload?.result_count || results.length),
        results,
    };
}

async function runSearxngSearch({
    query,
    maxResults,
    safeSearch,
    timeRange,
    providerSettings,
    abortSignal = null,
}) {
    const baseUrl = normalizeWhitespace(providerSettings?.baseUrl || '');
    if (!baseUrl) {
        throw new Error('SearXNG instance URL is required.');
    }

    const response = await fetch('/api/search/searxng', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: isAbortSignalLike(abortSignal) ? abortSignal : null,
        body: JSON.stringify({
            baseUrl,
            query,
            max_results: maxResults,
            safe_search: safeSearch,
            time_range: timeRange || '',
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`SearXNG search request failed (${response.status}): ${text || response.statusText}`);
    }

    const payload = await response.json();
    const results = normalizeSearchRows(payload?.results || [], 'searxng');
    return {
        provider: 'searxng',
        query: String(payload?.query || query || ''),
        result_count: Number(payload?.result_count || results.length),
        results,
    };
}

async function runBraveSearch({
    query,
    maxResults,
    safeSearch,
    timeRange,
    abortSignal = null,
}) {
    const response = await fetch('/api/search/brave', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: isAbortSignalLike(abortSignal) ? abortSignal : null,
        body: JSON.stringify({
            query,
            max_results: maxResults,
            safe_search: safeSearch,
            time_range: timeRange || '',
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Brave search request failed (${response.status}): ${text || response.statusText}`);
    }

    const payload = await response.json();
    const results = normalizeSearchRows(payload?.results || [], 'brave');
    return {
        provider: 'brave',
        query: String(payload?.query || query || ''),
        result_count: Number(payload?.result_count || results.length),
        results,
    };
}

async function runSearchProvider(provider, options) {
    const normalizedProvider = normalizeProvider(provider);
    if (normalizedProvider === 'ddg') {
        return await runDdgSearch(options);
    }
    if (normalizedProvider === 'searxng') {
        return await runSearxngSearch(options);
    }
    if (normalizedProvider === 'brave') {
        return await runBraveSearch(options);
    }

    console.warn(`[${MODULE_NAME}] Unsupported provider '${provider}'. Falling back to ${getDefaultSearchProviderId()}.`);
    return await runDdgSearch(options);
}

async function searchWeb(args = {}, { abortSignal = null } = {}) {
    const settings = getSettings();
    const query = normalizeWhitespace(args?.query || '');
    if (!query) {
        throw new Error('query is required.');
    }

    const maxResults = clampInteger(
        args?.max_results ?? settings.defaultMaxResults,
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
        providerSettings,
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
    ];
}

function getSharedSearchToolDefs() {
    return getSharedSearchToolSpecs().map(spec => structuredClone(spec.tool));
}

function isSharedSearchToolName(name = '') {
    const normalizedName = String(name || '').trim();
    return normalizedName === EXPORTED_TOOL_NAMES.SEARCH || normalizedName === EXPORTED_TOOL_NAMES.VISIT;
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

    throw new Error(`Unsupported search tool: ${name}`);
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
                agentMaxRounds: Number(settings.agentMaxRounds || DEFAULT_SETTINGS.agentMaxRounds),
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

function isAbortSignalLike(signal) {
    return Boolean(signal && typeof signal === 'object' && typeof signal.aborted === 'boolean');
}

function isAbortError(error, signal = null) {
    if (error?.name === 'AbortError') {
        return true;
    }
    return Boolean(signal?.aborted);
}

function createAbortError(message = 'Operation aborted.') {
    try {
        return new DOMException(String(message || 'Operation aborted.'), 'AbortError');
    } catch {
        const error = new Error(String(message || 'Operation aborted.'));
        error.name = 'AbortError';
        return error;
    }
}

function throwIfAborted(signal, message = 'Operation aborted.') {
    if (isAbortSignalLike(signal) && signal.aborted) {
        throw createAbortError(message);
    }
}

function buildRecoverableToolErrorResult(error, fallbackMessage = 'Tool call failed.') {
    const message = normalizeWhitespace(error?.message || error || fallbackMessage) || fallbackMessage;
    return {
        ok: false,
        error: message,
    };
}

function linkAbortSignals(...signals) {
    const validSignals = signals.filter(isAbortSignalLike);
    if (validSignals.length === 0) {
        return { signal: null, cleanup: () => {} };
    }
    if (validSignals.length === 1) {
        return { signal: validSignals[0], cleanup: () => {} };
    }

    const controller = new AbortController();
    const onAbort = () => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    };

    for (const signal of validSignals) {
        if (signal.aborted) {
            onAbort();
            break;
        }
        signal.addEventListener('abort', onAbort, { once: true });
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            for (const signal of validSignals) {
                signal.removeEventListener('abort', onAbort);
            }
        },
    };
}

async function requestToolCallsWithRetry(context, settings, {
    systemPrompt = '',
    userPrompt = '',
    historyMessages = null,
    worldInfoMessages = null,
    runtimeWorldInfo = null,
    forceWorldInfoResimulate = false,
    worldInfoType = 'quiet',
    apiPresetName = '',
    promptPresetName = '',
    tools = [],
    allowedNames = null,
    retriesOverride = null,
    abortSignal = null,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('Tools are required.');
    }

    const systemText = String(systemPrompt || '').trim() || 'Use tool calls only.';
    const userText = String(userPrompt || '').trim() || 'Use tool calls only.';
    const taskMessages = [
        ...(Array.isArray(historyMessages) ? historyMessages.map(message => ({ ...message })) : []),
        { role: 'system', content: systemText },
        { role: 'user', content: userText },
    ].filter(message => message && message.content !== undefined);

    const customMessages = Array.isArray(worldInfoMessages) ? worldInfoMessages : null;
    const includeWorldInfoWithPreset = settings?.includeWorldInfoWithPreset !== false;
    let presetRuntimeWorldInfo = await buildSearchAgentRuntimeWorldInfo(settings, runtimeWorldInfo);
    if (
        includeWorldInfoWithPreset
        && presetRuntimeWorldInfo === null
        && customMessages
        && customMessages.length > 0
        && typeof context?.resolveWorldInfoForMessages === 'function'
    ) {
        // No effective WI snapshot yet — resolve from coreChat ourselves so we can apply
        // the depth-to-after rewrite (generateTask has no postActivationHook seam).
        try {
            const resolved = await context.resolveWorldInfoForMessages(customMessages, {
                type: String(worldInfoType || 'quiet'),
                fallbackToCurrentChat: false,
                postActivationHook: rewriteDepthWorldInfoToAfter,
            });
            presetRuntimeWorldInfo = normalizeRuntimeWorldInfo(resolved);
        } catch (error) {
            if (isAbortError(error, abortSignal)) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] World info pre-resolution failed`, error);
            presetRuntimeWorldInfo = {};
        }
    }
    if (presetRuntimeWorldInfo === null) {
        presetRuntimeWorldInfo = {};
    }

    const retriesSource = retriesOverride === null || retriesOverride === undefined
        ? Number(settings?.toolCallRetryMax)
        : Number(retriesOverride);
    const retries = Math.max(0, Math.min(10, Math.floor(retriesSource || 0)));
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            throwIfAborted(abortSignal, 'Search agent aborted.');
            const generateTaskOpts = {
                taskMessages,
                includeCharacterCard: true,
                worldInfoSource: 'none',
                customWorldInfoMessages: null,
                runtimeWorldInfo: presetRuntimeWorldInfo,
                forceWorldInfoResimulate,
                worldInfoType,
                apiPresetName: String(apiPresetName || '').trim(),
                llmPresetName: String(promptPresetName || '').trim(),
                tools,
                toolChoice: 'auto',
                functionCallMode: 'auto',
                functionCallOptions: {
                    protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
                },
                abortSignal: isAbortSignalLike(abortSignal) ? abortSignal : undefined,
            };
            const result = settings?.useStreamingTransport
                ? await context.generateTaskStream(generateTaskOpts).result
                : await context.generateTask(generateTaskOpts);
            throwIfAborted(abortSignal, 'Search agent aborted.');
            const rawCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
            const normalizedCalls = rawCalls.map(call => ({
                name: String(call?.name || ''),
                args: call?.args && typeof call.args === 'object' ? call.args : {},
                raw: call?.raw || null,
            }));
            const filteredCalls = Array.isArray(allowedNames) && allowedNames.length > 0
                ? normalizedCalls.filter(call => allowedNames.includes(call.name))
                : normalizedCalls;
            const validationError = validateParsedToolCalls(filteredCalls, tools);
            if (validationError) {
                throw new Error(validationError);
            }
            return {
                toolCalls: filteredCalls,
                assistantText: String(result?.assistantText || ''),
            };
        } catch (error) {
            if (isAbortError(error, abortSignal)) {
                throw error;
            }
            lastError = error;
            if (attempt >= retries) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] Multi tool call request failed. Retrying (${attempt + 1}/${retries})...`, error);
        }
    }

    throw lastError || new Error('Multi tool call request failed.');
}

function makeRuntimeToolCallId() {
    return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function serializeToolResultContent(result) {
    if (typeof result === 'string') {
        return result;
    }
    if (result === null || result === undefined) {
        return '';
    }
    try {
        return JSON.stringify(result, null, 2);
    } catch {
        return String(result);
    }
}

function appendStandardToolRoundMessages(targetMessages, executedCalls, assistantText = '') {
    if (!Array.isArray(targetMessages) || !Array.isArray(executedCalls) || executedCalls.length === 0) {
        return;
    }

    const toolCalls = executedCalls.map((call) => {
        const id = String(call?.id || '').trim() || makeRuntimeToolCallId();
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        return {
            id,
            type: 'function',
            function: {
                name,
                arguments: JSON.stringify(args),
            },
            _result: call?.result,
        };
    }).filter(call => call.function.name);

    if (toolCalls.length === 0) {
        return;
    }

    targetMessages.push({
        role: 'assistant',
        content: String(assistantText || ''),
        tool_calls: toolCalls.map(({ _result, ...toolCall }) => toolCall),
    });

    for (const toolCall of toolCalls) {
        targetMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: serializeToolResultContent(toolCall._result),
        });
    }
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
            await saveSettings();
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

    const storedFloor = Number(latestSearchAgentSnapshot.anchorFloor);
    const incomingFloor = Number(anchor.floor);
    const storedPlayableFloor = Number(latestSearchAgentSnapshot.anchorPlayableFloor);
    const incomingPlayableFloor = Number(anchor.playableFloor);
    const floorMatched = Number.isFinite(storedPlayableFloor) && Number.isFinite(incomingPlayableFloor)
        ? storedPlayableFloor === incomingPlayableFloor
        : storedFloor === incomingFloor;
    return floorMatched
        && String(latestSearchAgentSnapshot.anchorHash || '') === String(anchor.hash || '');
}

function buildSearchAgentStatusText(result, { reused = false } = {}) {
    const summary = result?.summary ? ` ${result.summary}` : '';
    const mutationCount = Math.max(0, Number(result?.mutationCount || 0));
    const managedEntryCount = Math.max(0, Number(result?.managedEntryCount || 0));
    if (reused) {
        return mutationCount
            ? i18n(`Search agent reused cached lorebook update (${mutationCount} changes, ${managedEntryCount} managed entries).${summary}`)
            : i18n(`Search agent reused cached result with no lorebook changes (${managedEntryCount} managed entries).${summary}`);
    }

    return mutationCount
        ? i18n(`Search agent updated lorebook (${mutationCount} changes, ${managedEntryCount} managed entries).${summary}`)
        : i18n(`Search agent finished with no lorebook changes (${managedEntryCount} managed entries).${summary}`);
}

async function storeCompletedSearchAgentSnapshot(context, anchor, result) {
    const chatKey = getChatKey(context);
    const anchorPlayableFloor = normalizeAnchorPlayableFloor(anchor?.playableFloor);
    const anchorHash = String(anchor?.hash || '').trim();
    const managedEntries = normalizeStoredManagedEntries(result?.managedEntries);
    if (!chatKey || !anchorPlayableFloor || !anchorHash) {
        latestSearchAgentSnapshot = null;
        latestManagedEntries = managedEntries;
        // Anchor unresolvable — stash entries in the meta sidecar so the
        // shared lorebook keeps reflecting them across reloads.
        await persistFallbackManagedEntries(context, managedEntries);
        return null;
    }

    const nextSnapshot = {
        anchorHash,
        updatedAt: new Date().toISOString(),
        summary: normalizeWhitespace(result?.summary || ''),
        mutationCount: Math.max(0, Math.floor(Number(result?.mutationCount || 0))),
        managedEntryCount: managedEntries.length,
        bookName: normalizeWhitespace(result?.bookName || ''),
        managedEntries,
    };

    // Compound op: drop any anchors above this floor (a fresh search at an
    // earlier turn invalidates everything above) AND add the new snapshot,
    // all tagged at the new anchor's user message so the cleanup survives
    // exactly as long as the new anchor itself does.
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const target = getPlayableMessageAt(messages, anchorPlayableFloor);
    if (!target?.message || !target.message.is_user) {
        throw new Error(i18n('Failed to persist search agent snapshot.'));
    }
    const swipeIdRaw = target.message.swipe_id;
    const swipeId = Number.isInteger(swipeIdRaw) && swipeIdRaw >= 0 ? swipeIdRaw : 0;

    const fs = await getFloorStateInstance(context);
    const currentMap = await loadAnchorMap(context);
    const ops = [];
    for (const key of Object.keys(currentMap)) {
        const f = Number(key);
        if (Number.isInteger(f) && f > anchorPlayableFloor) {
            ops.push({ op: 'remove', path: `/${f}` });
        }
    }
    ops.push({ op: 'add', path: `/${anchorPlayableFloor}`, value: nextSnapshot });
    const ok = await fs.patch(ops, { floor: target.index, swipeId });
    if (!ok) {
        throw new Error(i18n('Failed to persist search agent snapshot.'));
    }

    latestSearchAgentSnapshot = materializeSearchAgentSnapshot(chatKey, anchorPlayableFloor, nextSnapshot);
    latestManagedEntries = managedEntries;
    return latestSearchAgentSnapshot;
}

async function applyManualManagedEntriesUpdate(context, nextEntries) {
    const normalized = normalizeStoredManagedEntries(nextEntries);
    latestManagedEntries = normalized;

    if (latestSearchAgentSnapshot && typeof latestSearchAgentSnapshot === 'object') {
        const updated = {
            anchorHash: String(latestSearchAgentSnapshot.anchorHash || '').trim(),
            updatedAt: new Date().toISOString(),
            summary: normalizeWhitespace(latestSearchAgentSnapshot.summary || ''),
            mutationCount: Math.max(0, Math.floor(Number(latestSearchAgentSnapshot.mutationCount || 0))),
            managedEntryCount: normalized.length,
            bookName: normalizeWhitespace(latestSearchAgentSnapshot.bookName || ''),
            managedEntries: normalized,
        };
        const committed = await commitAnchorSnapshot(
            context,
            {
                playableFloor: latestSearchAgentSnapshot.anchorPlayableFloor,
                hash: latestSearchAgentSnapshot.anchorHash,
            },
            updated,
        );
        if (committed) {
            latestSearchAgentSnapshot = materializeSearchAgentSnapshot(
                getChatKey(context),
                latestSearchAgentSnapshot.anchorPlayableFloor,
                updated,
            );
        } else {
            // Anchor no longer resolvable (user message was deleted or
            // turned non-user) — drop the snapshot and fall back to the
            // meta sidecar so the change survives a reload.
            latestSearchAgentSnapshot = null;
            await persistFallbackManagedEntries(context, normalized);
        }
    } else {
        await persistFallbackManagedEntries(context, normalized);
    }

    await syncSharedLorebookForCurrentChat(context);
    return normalized;
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

function getLatestSearchAgentEntry(context) {
    const chatKey = getChatKey(context);
    if (!latestSearchAgentSnapshot || typeof latestSearchAgentSnapshot !== 'object') {
        return null;
    }
    if (String(latestSearchAgentSnapshot.chatKey || '') !== String(chatKey || '')) {
        return null;
    }
    return {
        anchorPlayableFloor: normalizeAnchorPlayableFloor(latestSearchAgentSnapshot.anchorPlayableFloor),
        managedEntryCount: normalizeStoredManagedEntries(latestManagedEntries).length,
    };
}

function buildManagedEntryCatalog(entries = []) {
    const normalized = Array.isArray(entries) ? entries : [];
    if (normalized.length === 0) {
        return '[]';
    }
    return JSON.stringify(normalized.map(entry => ({
        entry_id: entry.entryId,
        title: entry.title,
        keywords: entry.keywords,
        always_inject: entry.alwaysInject,
        disabled: entry.disable,
        preview: normalizePreviewText(entry.content, 800),
    })), null, 2);
}

function buildSearchAgentSystemPrompt(basePrompt, finalStagePrompt, { isFinalStage = false } = {}) {
    const normalizedBasePrompt = String(basePrompt || DEFAULT_AGENT_SYSTEM_PROMPT).trim() || DEFAULT_AGENT_SYSTEM_PROMPT;
    const normalizedFinalStagePrompt = String(finalStagePrompt || DEFAULT_AGENT_FINAL_STAGE_PROMPT).trim() || DEFAULT_AGENT_FINAL_STAGE_PROMPT;
    return isFinalStage ? normalizedFinalStagePrompt : normalizedBasePrompt;
}

function buildSearchAgentUserPrompt(payload, {
    roundIndex,
    maxRounds,
    bookName,
    managedEntries,
    isFinalStage = false,
} = {}) {
    const recentChat = buildRecentChatText(payload?.coreChat || []);
    const lastUserMessage = Array.isArray(payload?.coreChat)
        ? [...payload.coreChat].reverse().find(message => message?.is_user)
        : null;
    const userText = normalizeMultilineText(lastUserMessage?.mes || '');
    const allToolNames = Object.values(TOOL_NAMES).filter(name => name.startsWith('luker_search_agent_'));
    const finalStageToolNames = [
        TOOL_NAMES.AGENT_UPSERT,
        TOOL_NAMES.AGENT_DELETE,
        TOOL_NAMES.AGENT_FINALIZE,
    ];

    return [
        '# Search Agent Task',
        isFinalStage
            ? `Final stage after ${maxRounds} search rounds.`
            : `Search round ${roundIndex} of ${maxRounds}.`,
        `Generation type: ${String(payload?.type || 'unknown')}.`,
        `Shared lorebook: ${bookName || '(not created yet)'}.`,
        '',
        'Decide whether persistent search-backed lorebook updates are needed before the main generation continues.',
        'If there is no meaningful external-reference gap, or the information would repeat active world info / character info / existing managed search entries, call finalize immediately.',
        'If this turn is just creative continuation, original scene writing, or a request that does not actually need external grounding, do not search and do not write a managed entry.',
        'You may use existing managed search entries as your own database without searching or visiting.',
        isFinalStage
            ? 'This is the mandatory finalization stage. No new searching or visiting is allowed.'
            : 'Search and visit are optional. Visit is recommended when snippets are weak or the topic is time-sensitive.',
        'Only delete entry_ids from the managed entry list below.',
        'Delete any managed search entries that are no longer needed, duplicated, outdated for this chat branch, or unsupported by the gathered evidence.',
        'Worldbook entries must be neutral fact records, not plot suggestions or character portrayal guidance.',
        'Do not tell the main model what anyone should feel, think, say, do, or become next.',
        'Never write original content, speculative filler, or anything that does not clearly come from the gathered search evidence.',
        'If a planned entry is being influenced by current plot pressure or your own creative completion instead of the source material, do not write it.',
        'Use always_inject when the information should stay visible in context continuously without a trigger. This includes always-on rules, core worldbuilding, and any entry created to provide creative inspiration, candidate suggestions, or temporary creative reference.',
        'For creative-inspiration entries, always use always_inject=true and include explicit top-level YAML markers `entry_usage: creative_inspiration_constant` and `retention: delete_if_unused_after_one_creation_round` inside the entry.',
        'After one creation round, delete inspiration constant entries once the current chat branch confirms they are no longer needed.',
        'Set always_inject=false only when the latest user input clearly already contains or directly invokes the entry trigger words.',
        'For non-always_inject entries, provide precise activation keywords that match wording already present in the latest user input.',
        '',
        '## Source fidelity rules',
        '- Treat search snippets, visited page text, and managed search entries as source text only.',
        '- Ignore story pressure when deciding what the source means.',
        '- Do not infer or rewrite emotions, cognition, motives, intentions, hidden facts, relationship changes, or plot consequences unless the source explicitly states them.',
        '- If the source conflicts with your interpretation of the story, preserve the source-backed wording instead of adapting it.',
        '- Write concise declarative fact statements, not narrative prose or instructions.',
        '',
        '## Lorebook content format',
        DEFAULT_LOREBOOK_CONTENT_TASK_GUIDANCE,
        '',
        '## Mandatory preflight thought',
        '- Use exactly one <thought>...</thought> block before tool calls.',
        '- The thought block must contain sections [1] Need gate, [2] Evidence gate, [3] Contamination gate, [4] Activation gate, [5] Cleanup gate, [6] Action, in that exact order.',
        '- If [1] finds no real external-reference need, finalize immediately.',
        '- If [2] cannot name grounded evidence for a planned write, do not upsert it.',
        '- If [3] finds plot-driven or invented material, remove it instead of polishing it.',
        '- In [4], any non-constant entry must explicitly name the trigger words already present in the latest user input.',
        '- In [5], delete expired creative-inspiration constant entries when the current branch confirms they are no longer needed.',
        '',
        '## Latest user message',
        userText || '(No user message found)',
        '',
        '## Recent chat',
        recentChat,
        '',
        '## Managed search entries (deletable / updatable)',
        buildManagedEntryCatalog(managedEntries),
        '',
        '## Output contract',
        `- Use only these function tools: ${(isFinalStage ? finalStageToolNames : allToolNames).join(', ')}`,
        isFinalStage ? `- Do not call ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT} in this stage.` : null,
        !isFinalStage ? `- If you call ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT}, do not call ${TOOL_NAMES.AGENT_FINALIZE} in the same response. Wait for the tool results first.` : null,
        !isFinalStage ? `- Soft limit: prefer 1 to 3 new ${TOOL_NAMES.AGENT_SEARCH} calls in a single response. Avoid exceeding 4 unless absolutely necessary, and never batch many near-duplicate searches in one response.` : null,
        !isFinalStage ? `- You may use ${TOOL_NAMES.AGENT_SEARCH}/${TOOL_NAMES.AGENT_VISIT} follow-ups across the run before you write or finalize.` : null,
        isFinalStage ? `- If any lorebook mutation is still needed, do it in this response and also call ${TOOL_NAMES.AGENT_FINALIZE}.` : null,
        isFinalStage ? `- If no mutation is needed, call ${TOOL_NAMES.AGENT_FINALIZE} immediately.` : null,
        isFinalStage ? '- Before finalizing, delete any managed search entries that are unnecessary, duplicated, stale for the current chat branch, or not supported by the gathered evidence.' : null,
        isFinalStage ? `- End with ${TOOL_NAMES.AGENT_FINALIZE}.` : `- Call ${TOOL_NAMES.AGENT_FINALIZE} only when you are done with this run.`,
        '- Outside the single <thought>...</thought> block and tool calls, do not output plain prose.',
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
                name: TOOL_NAMES.AGENT_FINALIZE,
                description: `Finish the current search-agent run. Rejected if called in the same response as ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT}.`,
                parameters: {
                    type: 'object',
                    properties: {
                        summary: { type: 'string' },
                    },
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

async function runPreRequestSearchAgent(context, settings, payload) {
    throwIfAborted(payload?.signal, 'Search agent aborted.');
    const apiPresetName = String(settings.agentApiPresetName || '').trim();
    const promptPresetName = String(settings.agentPresetName || '').trim();
    const tools = buildAgentTools();
    const searchRoundCount = Math.max(1, Number(settings.agentMaxRounds) || DEFAULT_SETTINGS.agentMaxRounds);
    const finalStageTools = tools.filter((tool) => {
        const name = String(tool?.function?.name || '');
        return name !== TOOL_NAMES.AGENT_SEARCH && name !== TOOL_NAMES.AGENT_VISIT;
    });
    const allowedNames = tools.map(tool => tool?.function?.name).filter(Boolean);
    const finalStageAllowedNames = finalStageTools.map(tool => tool?.function?.name).filter(Boolean);
    const toolHistoryMessages = [];
    let internalRuntimeWorldInfo = buildRuntimeWorldInfoFromPayload(payload);
    let mutationCount = 0;
    let roundStoppedByFinalize = false;
    let lastSummary = '';
    let lorebookBookName = '';
    let lorebookData = null;

    for (let phaseIndex = 1; phaseIndex <= searchRoundCount + 1;) {
        if (payload?.signal?.aborted) {
            throw Object.assign(new Error('Search agent aborted.'), { name: 'AbortError' });
        }
        const isFinalStage = phaseIndex > searchRoundCount;

        if (!lorebookData && !lorebookBookName) {
            const lorebook = await ensureSharedLorebook(context, true);
            throwIfAborted(payload?.signal, 'Search agent aborted.');
            lorebookBookName = lorebook.bookName;
            lorebookData = lorebook.data && typeof lorebook.data === 'object' ? lorebook.data : null;
        }
        const managedEntries = listManagedEntries(lorebookData);
        const response = await requestToolCallsWithRetry(context, settings, {
            systemPrompt: buildSearchAgentSystemPrompt(settings.agentSystemPrompt, settings.agentFinalStagePrompt, { isFinalStage }),
            userPrompt: buildSearchAgentUserPrompt(payload, {
                roundIndex: phaseIndex,
                maxRounds: searchRoundCount,
                bookName: lorebookBookName,
                managedEntries,
                isFinalStage,
            }),
            historyMessages: toolHistoryMessages,
            worldInfoMessages: Array.isArray(payload?.coreChat) ? payload.coreChat : [],
            runtimeWorldInfo: internalRuntimeWorldInfo,
            forceWorldInfoResimulate: false,
            worldInfoType: 'quiet',
            apiPresetName,
            promptPresetName,
            tools: isFinalStage ? finalStageTools : tools,
            allowedNames: isFinalStage ? finalStageAllowedNames : allowedNames,
            abortSignal: payload?.signal || null,
        });
        throwIfAborted(payload?.signal, 'Search agent aborted.');
        const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
        // Fresh source text is only visible to the model on the next round, so same-response finalization must be rejected.
        const responseHasFreshSourceCalls = !isFinalStage && toolCalls.some((call) => {
            const callName = String(call?.name || '').trim();
            return callName === TOOL_NAMES.AGENT_SEARCH || callName === TOOL_NAMES.AGENT_VISIT;
        });

        const executedCalls = [];
        let lorebookDirty = false;
        let shouldFinalize = false;
        let hasSourceGatheringCalls = false;
        let hasLorebookMutationCalls = false;

        for (const call of toolCalls) {
            throwIfAborted(payload?.signal, 'Search agent aborted.');
            const callName = String(call?.name || '').trim();
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            let result = null;

            if (callName === TOOL_NAMES.AGENT_SEARCH) {
                hasSourceGatheringCalls = true;
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
                hasSourceGatheringCalls = true;
                try {
                    result = await visitWebPage(args, { abortSignal: payload?.signal || null });
                    throwIfAborted(payload?.signal, 'Search agent aborted.');
                } catch (error) {
                    if (isAbortError(error, payload?.signal || null)) {
                        throw error;
                    }
                    result = buildRecoverableToolErrorResult(error, 'Visit tool failed.');
                }
            } else if (callName === TOOL_NAMES.AGENT_UPSERT) {
                hasLorebookMutationCalls = true;
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
                hasLorebookMutationCalls = true;
                result = deleteManagedEntries(lorebookData, args?.entry_ids || []);
                lorebookDirty = lorebookDirty || Boolean(result?.changed);
                if (result?.changed) {
                    mutationCount += Number(result.deleted?.length || 0);
                }
            } else if (callName === TOOL_NAMES.AGENT_FINALIZE) {
                if (responseHasFreshSourceCalls) {
                    result = buildRecoverableToolErrorResult(
                        new Error(`Cannot call ${TOOL_NAMES.AGENT_FINALIZE} in the same response as ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT}. Wait for those tool results first.`),
                        'Finalize rejected.',
                    );
                } else {
                    lastSummary = normalizeWhitespace(args?.summary || '');
                    result = {
                        done: true,
                        summary: lastSummary,
                    };
                    shouldFinalize = true;
                }
            }

            executedCalls.push({
                ...call,
                result,
            });
        }

        if (lorebookDirty && lorebookBookName && lorebookData) {
            throwIfAborted(payload?.signal, 'Search agent aborted.');
            internalRuntimeWorldInfo = await flushLorebookChanges(context, payload, lorebookBookName, lorebookData);
            throwIfAborted(payload?.signal, 'Search agent aborted.');
        }

        appendStandardToolRoundMessages(toolHistoryMessages, executedCalls, response.assistantText || '');

        if (shouldFinalize) {
            roundStoppedByFinalize = true;
            break;
        }

        if (!isFinalStage && hasSourceGatheringCalls && !hasLorebookMutationCalls) {
            continue;
        }

        phaseIndex += 1;
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
        finalized: roundStoppedByFinalize,
        summary: lastSummary,
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
    await syncSharedLorebookForCurrentChat(context);
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

    updateUiStatus(i18n('Search agent running...'));
    showAgentRunInfoToast(i18n('Search agent running...'), {
        stopLabel: i18n('Stop'),
        onStop: () => {
            resolveStopRequest?.();
        },
    });

    try {
        const agentTask = runPreRequestSearchAgent(context, settings, effectivePayload);
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
            return;
        }
        syncMutableGenerationPayloadState(payload, effectivePayload);
        const result = raced?.result;
        if (runToken !== activeAgentRunToken) {
            return;
        }
        await storeCompletedSearchAgentSnapshot(context, anchor, result);
        updateUiStatus(buildSearchAgentStatusText(result));
    } catch (error) {
        syncMutableGenerationPayloadState(payload, effectivePayload);
        if (runToken !== activeAgentRunToken) {
            return;
        }
        if (isAbortError(error, effectivePayload?.signal || null)) {
            updateUiStatus(i18n('Search agent aborted.'));
            return;
        }
        console.warn(`[${MODULE_NAME}] Pre-request search agent failed`, error);
        updateUiStatus(i18n('Search agent failed. Check console for details.'));
    } finally {
        linkedAbort.cleanup();
        if (activeAgentAbortController === pluginAbortController) {
            activeAgentAbortController = null;
        }
        if (runToken === activeAgentRunToken) {
            clearAgentRunInfoToast();
        }
    }
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        'Search Tools': '搜索工具',
        'Expose tools to main model': '暴露工具给主模型',
        'Run pre-request search agent': '请求前运行搜索 Agent',
        'Search provider': '搜索提供方',
        'DuckDuckGo (no login)': 'DuckDuckGo（无需登录）',
        'SearXNG (custom instance)': 'SearXNG（自定义实例）',
        'Brave Search (API key)': 'Brave Search（API Key）',
        'SearXNG instance URL': 'SearXNG 实例地址',
        'Brave API key': 'Brave API Key',
        'Configured': '已配置',
        'Not configured': '未配置',
        'Manage API key': '管理 API Key',
        'Default max search results': '默认搜索结果上限',
        'Default safe search': '默认安全搜索',
        'Off': '关闭',
        'Moderate': '中等',
        'Strict': '严格',
        'Default page excerpt max chars (0 = no truncation)': '默认网页摘录最大字符数（0=不截断）',
        'Agent API preset (Connection profile)': 'Agent API 预设（连接配置）',
        'Agent preset (params + prompt)': 'Agent 预设（参数+提示词）',
        'Include world info': '包含世界书信息',
        'Agent max rounds': 'Agent 最大轮数',
        'Tool call retry count': '工具调用重试次数',
        'Injection position': '注入位置',
        'Before Character Definitions': '角色定义前',
        'After Character Definitions': '角色定义后',
        'Before Author\'s Note': '作者注释前',
        'After Author\'s Note': '作者注释后',
        'Before Example Messages': '示例消息前',
        'After Example Messages': '示例消息后',
        'At Chat Depth': '聊天深度',
        'Injection depth (At Chat Depth only)': '注入深度（仅聊天深度位置）',
        'Injection role (At Chat Depth only)': '注入角色（仅聊天深度位置）',
        'Injection order': '注入顺序',
        'Search-stage agent system prompt': '搜索阶段 Agent 系统提示词',
        'Final-stage agent system prompt': '最终阶段 Agent 系统提示词',
        'Reset search-stage agent prompt': '重置搜索阶段 Agent 提示词',
        'Reset final-stage agent prompt': '重置最终阶段 Agent 提示词',
        'Reset search-stage agent prompt to default? This will overwrite the current search-stage system prompt.': '确认重置搜索阶段 Agent 提示词为默认值？这会覆盖当前搜索阶段系统提示词。',
        'Reset final-stage agent prompt to default? This will overwrite the current final-stage system prompt.': '确认重置最终阶段 Agent 提示词为默认值？这会覆盖当前最终阶段系统提示词。',
        'System': '系统',
        'User': '用户',
        'Assistant': '助手',
        'Stop': '终止',
        'Search agent running...': '搜索 Agent 运行中...',
        'Search agent aborted.': '搜索 Agent 已中止。',
        'Search agent failed. Check console for details.': '搜索 Agent 失败，请查看控制台。',
        'No active chat.': '当前没有激活聊天。',
        'No shared search lorebook yet.': '当前还没有共享搜索世界书。',
        'Failed to inspect shared search lorebook.': '检查共享搜索世界书失败。',
        '(Current preset)': '（当前预设）',
        '(Current API config)': '（当前 API 配置）',
        '(missing)': '（缺失）',
        'Manage stored search entries': '管理已保存的搜索条目',
        'Remove entries that are no longer relevant. Changes apply to the current chat.': '删除不再相关的条目，改动只作用于当前聊天。',
        'No managed search entries in this chat.': '当前聊天没有任何搜索条目。',
        'Select all': '全选',
        'Delete selected': '删除选中',
        'Reset all': '重置全部',
        'Delete': '删除',
        'Close': '关闭',
        'Total': '总计',
        'Always inject': '始终注入',
        'Always': '常驻',
        'Delete 1 selected search entry? This cannot be undone for the current chat.': '删除已选中的 1 条搜索条目？当前聊天的此操作无法撤销。',
        'Delete {count} selected search entries? This cannot be undone for the current chat.': '删除已选中的 {count} 条搜索条目？当前聊天的此操作无法撤销。',
        'Remove ALL managed search entries from this chat? This cannot be undone.': '清空当前聊天的全部搜索条目？此操作无法撤销。',
        'Failed to update managed entries. See console for details.': '更新搜索条目失败，详情查看控制台。',
    });

    addLocaleData('zh-tw', {
        'Search Tools': '搜尋工具',
        'Expose tools to main model': '將工具暴露給主模型',
        'Run pre-request search agent': '在請求前執行搜尋 Agent',
        'Search provider': '搜尋提供方',
        'DuckDuckGo (no login)': 'DuckDuckGo（無需登入）',
        'SearXNG (custom instance)': 'SearXNG（自訂實例）',
        'Brave Search (API key)': 'Brave Search（API Key）',
        'SearXNG instance URL': 'SearXNG 實例網址',
        'Brave API key': 'Brave API Key',
        'Configured': '已設定',
        'Not configured': '未設定',
        'Manage API key': '管理 API Key',
        'Default max search results': '預設搜尋結果上限',
        'Default safe search': '預設安全搜尋',
        'Off': '關閉',
        'Moderate': '中等',
        'Strict': '嚴格',
        'Default page excerpt max chars (0 = no truncation)': '預設網頁摘錄最大字元數（0=不截斷）',
        'Agent API preset (Connection profile)': 'Agent API 預設（連線設定）',
        'Agent preset (params + prompt)': 'Agent 預設（參數+提示詞）',
        'Include world info': '包含世界書資訊',
        'Agent max rounds': 'Agent 最大輪數',
        'Tool call retry count': '工具呼叫重試次數',
        'Injection position': '注入位置',
        'Before Character Definitions': '角色定義前',
        'After Character Definitions': '角色定義後',
        'Before Author\'s Note': '作者註釋前',
        'After Author\'s Note': '作者註釋後',
        'Before Example Messages': '示例訊息前',
        'After Example Messages': '示例訊息後',
        'At Chat Depth': '聊天深度',
        'Injection depth (At Chat Depth only)': '注入深度（僅聊天深度位置）',
        'Injection role (At Chat Depth only)': '注入角色（僅聊天深度位置）',
        'Injection order': '注入順序',
        'Search-stage agent system prompt': '搜尋階段 Agent 系統提示詞',
        'Final-stage agent system prompt': '最終階段 Agent 系統提示詞',
        'Reset search-stage agent prompt': '重置搜尋階段 Agent 提示詞',
        'Reset final-stage agent prompt': '重置最終階段 Agent 提示詞',
        'Reset search-stage agent prompt to default? This will overwrite the current search-stage system prompt.': '確認重置搜尋階段 Agent 提示詞為預設值？這會覆蓋目前搜尋階段系統提示詞。',
        'Reset final-stage agent prompt to default? This will overwrite the current final-stage system prompt.': '確認重置最終階段 Agent 提示詞為預設值？這會覆蓋目前最終階段系統提示詞。',
        'System': '系統',
        'User': '使用者',
        'Assistant': '助手',
        'Stop': '終止',
        'Search agent running...': '搜尋 Agent 執行中...',
        'Search agent aborted.': '搜尋 Agent 已中止。',
        'Search agent failed. Check console for details.': '搜尋 Agent 失敗，請查看主控台。',
        'No active chat.': '目前沒有啟用聊天。',
        'No shared search lorebook yet.': '目前還沒有共享搜尋世界書。',
        'Failed to inspect shared search lorebook.': '檢查共享搜尋世界書失敗。',
        '(Current preset)': '（目前預設）',
        '(Current API config)': '（目前 API 設定）',
        '(missing)': '（缺失）',
        'Manage stored search entries': '管理已儲存的搜尋條目',
        'Remove entries that are no longer relevant. Changes apply to the current chat.': '刪除不再相關的條目，變動只套用於目前聊天。',
        'No managed search entries in this chat.': '目前聊天沒有任何搜尋條目。',
        'Select all': '全選',
        'Delete selected': '刪除選中',
        'Reset all': '重置全部',
        'Delete': '刪除',
        'Close': '關閉',
        'Total': '總計',
        'Always inject': '始終注入',
        'Always': '常駐',
        'Delete 1 selected search entry? This cannot be undone for the current chat.': '刪除已選中的 1 條搜尋條目？目前聊天的此操作無法復原。',
        'Delete {count} selected search entries? This cannot be undone for the current chat.': '刪除已選中的 {count} 條搜尋條目？目前聊天的此操作無法復原。',
        'Remove ALL managed search entries from this chat? This cannot be undone.': '清空目前聊天的全部搜尋條目？此操作無法復原。',
        'Failed to update managed entries. See console for details.': '更新搜尋條目失敗，詳情請查看主控台。',
    });
}

const {
    clearAgentRunInfoToast,
    ensureUi,
    refreshUiStatusForCurrentChat,
    showAgentRunInfoToast,
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
    getProviderSettings,
    getSettings,
    hasConfiguredSecret,
    i18n,
    listManagedEntries,
    manuallyDeleteManagedEntries,
    manuallyResetManagedEntries,
    getManagedEntriesSnapshot,
    POPUP_TYPE,
    Popup,
    normalizeLorebookPosition,
    normalizeLorebookRole,
    normalizeProvider,
    normalizeSafeSearch,
    normalizeWhitespace,
    saveSettingsDebounced,
    syncSharedLorebookForCurrentChat,
    syncSharedLorebookForLoadedChat,
    world_info_position,
});

jQuery(() => {
    ensureSettings();
    registerLocaleData();
    installGlobalApi();

    const context = getContext();
    registerTools(context);
    ensureUi();
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
        .finally(() => refreshUiStatusForCurrentChat());

    const wiAfterEvent = context?.eventTypes?.GENERATION_AFTER_WORLD_INFO_SCAN;
    if (wiAfterEvent) {
        context.eventSource.on(wiAfterEvent, async (payload) => {
            await maybeRunPreRequestSearchAgent(payload);
        });
    }

    if (context?.eventTypes?.CHAT_CHANGED) {
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
