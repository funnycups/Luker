// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

const __ctx = Luker.getContext();
const eventSource = __ctx.eventSource;
const extension_prompt_roles = __ctx.constants.promptRoles;
const extension_prompt_types = __ctx.constants.promptTypes;
const resolveChatStateTarget = __ctx.resolveChatStateTarget;
const saveSettings = __ctx.saveSettings;
const saveSettingsDebounced = __ctx.saveSettingsDebounced;
const extension_settings = __ctx.extensionSettings;
const getContext = Luker.getContext;
const performFuzzySearch = __ctx.performFuzzySearch;
const download = __ctx.download;
const getFileText = __ctx.getFileText;
const getStringHash = __ctx.getStringHash;
const newWorldInfoEntryTemplate = __ctx.worldInfoEntry.template;
const setGlobalWorldInfoSelection = __ctx.worldInfoEntry.setGlobalSelection;
const world_info_position = __ctx.constants.wiPosition;
// Register the Layer-1 session API at module load.
import './api.js';
// Publishes memory-graph's read + write tools into the orchestrator's
// Layer-2 extension registry so any orchestration mode (loop / spec /
// agenda / director) can dispatch them. Silent no-op when orchestrator
// isn't loaded — memory-graph stays independently functional.
import { registerMemoryGraphOrchestrationTools } from './orchestrator-tools.js';
import { i18n, i18nFormat, registerLocaleData } from './i18n.js';
import {
    DEFAULT_PER_TYPE_INSTRUCTIONS,
    computeActiveExtractionTypes,
    buildExtractionNodesBlock,
    buildExtractionEdgesBlock,
    buildRoundNodesSection,
    classifyExtractionMutation,
} from './extraction-schedule.js';
import { renderExtractionTemplate, resolveExtractionTemplate } from './prompt-units.js';
export { DEFAULT_PER_TYPE_INSTRUCTIONS, computeActiveExtractionTypes };
import {
    configure as configureCharacterOverrides,
    getEffectiveSettings,
    getEffectiveNodeTypeSchema,
    getSchemaScopeInfo,
    getAdvancedScopeInfo,
    persistCharacterSchemaOverride,
    persistCharacterAdvancedOverride,
    persistCharacterAdvancedOverridePatch,
    removeCharacterAdvancedOverride,
} from './character-overrides.js';
import { registerMemoryGraphCardBindingSlot } from './card-binding-slot.js';
import {
    getMemoryGraphExportFileName,
    getImportedStoreBindingFloor,
    clearImportedStoreTransientState,
    bindImportedStoreToAssistantFloor,
} from './import-export.js';
import { openConfigIterationStudio } from './config-iteration/studio.js';
import { DEFAULT_CONFIG_ITER_SYSTEM_PROMPT } from './config-iteration/system-prompt.js';
import { migrateConfigIterationPrompt } from './config-iteration/prompt-migration.js';
import { openGraphIterationStudio } from './graph-iteration/studio.js';
import {
    DEFAULT_EXTRACT_EDGE_RULES,
    DEFAULT_EXTRACT_TEMPLATE,
    DEFAULT_EVENT_COMPRESS_INSTRUCTION,
    DEFAULT_CRAWL_SYSTEM_PROMPT,
    DEFAULT_RAG_REWRITE_SYSTEM_PROMPT,
    DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT,
    DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT,
} from './default-prompts.js';
import {
    ADVANCED_SETTING_DEFAULTS,
    applyAdvancedSettings,
    normalizeAdvancedSettings,
    normalizeExtractExcludeRecentTurns,
    sanitizeRecallQueryMessages,
} from './config-iteration/advanced-settings.js';
export {
    applyAdvancedSettings,
    normalizeAdvancedSettings,
    normalizeExtractExcludeRecentTurns,
    sanitizeRecallQueryMessages,
};
import { registerManagedRegexProvider, regex_placement, substitute_find_regex } from '../regex/engine.js';
import { computeDepthsFromEnd } from '../../lib/chat-regex.js';
import { cookPluginFloorText } from '../../lib/plugin-floors.js';
import { markPluginFloorMessage } from '../../lib/plugin-prompt-regex.js';
import { getChatCompletionConnectionProfiles } from '../connection-manager/profile-resolver.js';
import {
    TOOL_PROTOCOL_STYLE,
    validateParsedToolCalls,
} from '../function-call-runtime.js';
import { runRagRecall, hasRecallableNodes } from './retriever.js';
import {
    getVectorConfigFromSettings,
    getRerankProfileFromSettings,
    validateVectorConfig,
    syncVectorIndex,
    findSimilarNodes,
    ensureVectorIndexState,
    buildCollectionId,
    purgeVectorCollection,
} from './vector-index.js';
import {
    upsertEmbeddingProfile,
    upsertRerankProfile,
} from '../connection-manager/embed-rerank.js';
import { getEmbeddingProfileById } from '../connection-manager/embed-rerank.js';
import { resolveGraphVectorProfile, syncGraphVectorsAfterMutation as runGraphVectorSync } from './graph-iteration/vector-sync.js';

// Symmetric relations collapse direction: A→B and B→A merge into a single
// canonical edge sorted by node id. Used by the extraction writer and edge
// reader paths — kept here (not in retriever.js) because it's graph-storage
// invariant, not a recall concept.
const SYMMETRIC_RELATIONS = new Set([
    'allied_with',
    'hostile_to',
    'family_of',
    'partner_of',
]);
import {
    getFloorStateInstance,
    resetFloorStateInstance,
    loadMetaFields,
    persistMetaFields,
    migrateLegacyMemoryGraphState,
    constants as floorStateAdapterConstants,
    createEmptyStore,
    normalizeStoreForRuntime,
    normalizePersistedMemoryState,
    applyMemoryLogEntryToStore,
    buildRuntimeStoreFromPersistedState,
    graphPayloadFromStore,
    metaFieldsFromStore,
    buildRuntimeStoreFromGraphPayloadAndMeta,
    normalizeVectorIndexState,
    synthesizePersistedStateFromStoreAndMeta,
    hasPersistedStoreMetadataChanges,
    getStoreCoveredSeqTo,
    resolveStoreCommitSeq,
    getCachedMeta,
    setCachedMeta,
    clearCachedMeta,
    activeSwipeIdAtFloor,
    resolveInFlightAnchor,
    seqToFloor,
} from './persistence.js';
import { STATE_ERROR_REASONS } from '../../state-errors.js';
import {
    LEVEL,
    normalizeText,
    normalizeMultilineText,
    ensureNodeFieldsObject,
    isExtractableAssistantMessage,
} from './primitives.js';
import {
    cloneRollbackNodeSnapshot,
    cloneRollbackEdgeSnapshot,
    addEdge,
    removeEdge,
    dropNode,
    repairStoreAfterRollback,
    compareNodesByTimeline,
    getSemanticCoverageSeq,
    reparentNode,
} from './graph-ops.js';
import { __recordInjectedNodeIds } from './external-api.js';

const MODULE_NAME = 'memory_graph';
const CHAT_STATE_NAMESPACE = MODULE_NAME;
const META_NAMESPACE = floorStateAdapterConstants.META_NAMESPACE;
const META_SCHEMA_VERSION = floorStateAdapterConstants.SCHEMA_VERSION;
const SHARED_LOREBOOK_NAME = '__MEMORY_GRAPH__';
const RUNTIME_LOREBOOK_COMMENT_PREFIX = 'MEMORY_GRAPH_RUNTIME';
const PERSISTENT_LOREBOOK_COMMENT_PREFIX = 'MEMORY_GRAPH_PERSISTENT';
const RECALL_ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
const RECALL_REUSE_GENERATION_TYPES = new Set(['continue', 'regenerate', 'swipe']);
const GENERATION_VISIBLE_HISTORY_REGEX_PROVIDER_ID = `${MODULE_NAME}_generation_visible_history`;
const GENERATION_VISIBLE_HISTORY_REGEX_SCRIPT_ID = `${MODULE_NAME}_generation_visible_history_runtime_script`;
const RECALL_INJECT_POSITION_SCHEMA_VERSION = 2;
const SUPPORTED_WORLD_INFO_POSITIONS = Object.freeze([
    world_info_position.before,
    world_info_position.after,
    world_info_position.ANTop,
    world_info_position.ANBottom,
    world_info_position.EMTop,
    world_info_position.EMBottom,
    world_info_position.atDepth,
]);

const DEFAULT_EVENT_SUMMARY_COLUMN_HINT = 'A prose body covering event skeleton, key decisions, and causal chains, with the in-world time and place anchors at the top and three optional structured sections at the end (不可逆 / 未结 / 原文摘录, all default empty). See the event summary writing standard for the exact format and section gating.';
const DEFAULT_EVENT_EXTRACT_HINT = 'Critical plot events, turning points, commitments, betrayals, irreversible outcomes — written as a prose body with an in-world time and place anchor at the top, plus three optional sections at the end (不可逆 / 未结 / 原文摘录, default empty).';

// Built-in node types shipped as the default schema. `thread` is the long-
// running plotline / foreshadow / mystery tracker — high write threshold,
// extraction prompt enforces cross-scene-only creation and aggressive
// resolution on goal completion. The compression instruction body is the
// imported default; users can edit per-type via the Schema Editor popup.
const defaultNodeTypeSchema = [
    {
        id: 'event',
        label: 'Event',
        tableName: 'event_table',
        tableColumns: ['summary'],
        embeddingColumns: ['summary'],
        columnHints: {
            summary: DEFAULT_EVENT_SUMMARY_COLUMN_HINT,
        },
        requiredColumns: ['summary'],
        forceUpdate: true,
        editable: false,
        level: LEVEL.SEMANTIC,
        extractHint: DEFAULT_EVENT_EXTRACT_HINT,
        extractionInstructions: DEFAULT_PER_TYPE_INSTRUCTIONS.event,
        keywords: ['battle', 'reveal', 'deal', 'betrayal', 'event', 'outcome'],
        alwaysInject: true,
        latestOnly: false,
        recordsFloorRange: true,
        primaryKeyColumns: [],
        compression: {
            mode: 'hierarchical',
            threshold: 5,
            fanIn: 3,
            maxDepth: 10,
            keepRecentLeaves: 3,
            summarizeInstruction: DEFAULT_EVENT_COMPRESS_INSTRUCTION,
        },
    },
    {
        id: 'character_sheet',
        label: 'Character Sheet',
        tableName: 'character_table',
        tableColumns: ['title', 'aliases', 'traits', 'identity', 'goal', 'inventory', 'language_sample', 'addressing_user'],
        embeddingColumns: ['title', 'aliases', 'traits', 'identity', 'goal'],
        columnHints: {
            title: 'Canonical character name only. Do not include aliases, English names, titles, translations, or any parenthetical/bracketed clarification here.',
            aliases: 'Nicknames, aliases, titles, English names, translated names, or alternative names — only when they pass the alias-write threshold (see extractionInstructions).',
            traits: 'Long-term personality + appearance/style markers, observed across multiple batches. Avoid momentary tone/expression descriptors.',
            identity: 'Long-term identity/background facts (24h+ persistence). Do NOT record temporary roles.',
            goal: 'Long-term goal that drives the character across multiple scenes. Single-scene goals are events, not goals.',
            inventory: 'Plot-critical items only (信物/钥匙/标志性武器/凭证/关键技术物品). No regular clothes/accessories or single-scene props.',
            language_sample: 'STYLE DESCRIPTIONS ONLY — never quoted dialogue lines. e.g. "公关式精确措辞, 战斗时短促命令式".',
            addressing_user: 'Stable cross-scene addressing of the user. Single-scene tone shifts do not count.',
        },
        requiredColumns: ['title'],
        forceUpdate: false,
        editable: true,
        level: LEVEL.SEMANTIC,
        extractHint: 'Stable character facts and evolving state. Prefer structured JSON-like content: aliases/traits/identity/status/goal/inventory/core notes.',
        extractionInstructions: DEFAULT_PER_TYPE_INSTRUCTIONS.character_sheet,
        extractEveryN: 1,
        keywords: ['character', 'alias', 'traits', 'personality', 'status', 'relationship', 'inventory', 'goal', 'core note'],
        alwaysInject: false,
        latestOnly: true,
        primaryKeyColumns: ['title', 'aliases'],
        compression: {
            mode: 'none',
            threshold: 2,
            fanIn: 2,
            maxDepth: 1,
            keepRecentLeaves: 1,
            summarizeInstruction: '',
        },
    },
    {
        id: 'location_state',
        label: 'Location State',
        tableName: 'location_table',
        tableColumns: ['title', 'aliases', 'controller', 'danger', 'resources', 'state'],
        embeddingColumns: ['title', 'aliases', 'controller', 'state', 'danger'],
        columnHints: {
            title: 'Canonical location name only. Do not include aliases, English names, translations, or any parenthetical/bracketed clarification here.',
            aliases: 'Alternative location names, English names, translated names, short names, or colloquial references. Store them here instead of appending them to title.',
            controller: 'Current long-term controller. May use "X(名义)/Y(实际)". Forbid temporary stand-in roles.',
            danger: 'Long-term risk profile (e.g. permafrost planet). Not single-visit encounters.',
            resources: 'Long-term fixtures / features / geography. No event traces.',
            state: 'Long-term identity (≤50 chars). Single-visit traces forbidden.',
        },
        requiredColumns: ['title'],
        forceUpdate: false,
        editable: true,
        level: LEVEL.SEMANTIC,
        extractHint: 'Location status, aliases, ownership/control, danger level, and environmental/resource changes. Prefer structured JSON-like content.',
        extractionInstructions: DEFAULT_PER_TYPE_INSTRUCTIONS.location_state,
        extractEveryN: 1,
        keywords: ['location', 'alias', 'control', 'danger', 'resource', 'region', 'base'],
        alwaysInject: false,
        latestOnly: true,
        primaryKeyColumns: ['title', 'aliases'],
        compression: {
            mode: 'none',
            threshold: 2,
            fanIn: 2,
            maxDepth: 1,
            keepRecentLeaves: 1,
            summarizeInstruction: '',
        },
    },
    {
        id: 'thread',
        label: 'Thread',
        tableName: 'thread_table',
        tableColumns: ['title', 'status', 'note'],
        embeddingColumns: ['title', 'note'],
        columnHints: {
            title: 'Short noun-phrase name of the thread (≤10 chars). Forbid AI-coined adjective+noun labels.',
            status: 'One of: active (推进中) / resolved (达成或彻底解决) / abandoned (永久放弃). Default active.',
            note: '≤80 chars. Must cover: (a) core fact, (b) involved characters, (c) trigger conditions / current progress.',
        },
        requiredColumns: ['title', 'status', 'note'],
        forceUpdate: false,
        editable: true,
        level: LEVEL.SEMANTIC,
        extractHint: 'Long-running plotline / promise / mystery that spans multiple events. High write threshold.',
        extractionInstructions: DEFAULT_PER_TYPE_INSTRUCTIONS.thread,
        extractEveryN: 1,
        keywords: ['thread', 'plotline', 'foreshadow', 'promise', 'quest', 'mystery'],
        alwaysInject: true,
        latestOnly: true,
        primaryKeyColumns: ['title'],
        compression: {
            mode: 'none',
            threshold: 2,
            fanIn: 2,
            maxDepth: 1,
            keepRecentLeaves: 1,
            summarizeInstruction: '',
        },
    },
];

const CANONICAL_EXTRACT_RELATION_TYPES = [
    // Generic graph relations (existing)
    'related', 'involved_in', 'occurred_at', 'mentions', 'evidence', 'updates', 'advances',
    // Character-character relations (new — spec §3.2)
    // Symmetric (use bidirectional direction in upsert):
    'partner_of', 'family_of', 'allied_with', 'hostile_to',
    // Directed (from = action originator):
    'mentor_of', 'sworn_to', 'debt_owed_to', 'deceiving',
];
const CANONICAL_EXTRACT_RELATION_TYPES_TEXT = CANONICAL_EXTRACT_RELATION_TYPES.join(', ');


export const defaultSettings = {
    enabled: false,
    autoExtractionEnabled: true,
    autoCompressionEnabled: true,
    ...ADVANCED_SETTING_DEFAULTS,
    updateEvery: 1,
    maxTurns: 900,
    recallEnabled: true,
    recallMethod: 'llm',
    recallInjectPosition: world_info_position.atDepth,
    recallInjectDepth: 9999,
    recallInjectRole: extension_prompt_roles.SYSTEM,
    recallApiPresetName: '',
    recallPresetName: '',
    extractApiPresetName: '',
    extractPresetName: '',
    requestApiPresetName: '',
    requestLlmPresetName: '',
    lorebookNameOverride: '',
    lorebookEntryOrderBase: 9800,
    nodeTypeSchema: defaultNodeTypeSchema,
    embeddingProfileId: '',
    rerankProfileId: '',
    vectorTopK: 20,
    hybridMaxResults: 15,
    // RAG per-type bucketing: default quota per node type. Each vector
    // pre-filter hit is bucketed by node.type; each bucket takes at most
    // ragDefaultPerTypeK hits (or the per-type override in
    // schema.ragPerTypeK). Prevents one dominant type (typically `event`)
    // from starving other types out of recall. Set to 0 to disable
    // bucketing and use the legacy shared-pool topK behaviour.
    ragDefaultPerTypeK: 3,
    ragUseRerank: false,
    ragUseQueryRewrite: false,
    ragRewriteApiPresetName: '',
    ragRewriteLlmPresetName: '',
};


const extractionTimers = new Map();
const memoryStoreCache = new Map();
const memoryStoreTargets = new Map();
const memoryLoadTasks = new Map();
const rollbackHistoryCache = new Map();
const scheduledExtractionSingleFlightStates = new Map();
let activeExtractionToast = null;
let activeRecallToast = null;
let activePersistentRuntimeNoticeToast = null;
let activeRecallAbortController = null;
let activeExtractionAbortController = null;
// Scope of the in-flight scheduled extraction pass, keyed to
// `activeExtractionAbortController`. Only `runScheduledExtractionPass`
// populates it; fill / rebuild / rebuild_recent / compression passes
// leave it null so `applyMutationInvalidationImpl` falls back to the
// unconditional-abort branch for them.
//   beginSeq:     preview.beginSeq at pass launch (immutable)
//   latestSeq:    upper bound the loop actually respects; may be shrunk
//                 by `applyMutationInvalidationImpl` when a mutation
//                 lands in a not-yet-dispatched tail batch
//   committedSeq: highest endSeq that has been fully committed
//                 (batch commit + compression commit both bump it)
//   inFlightSeqFrom/To: range of the batch currently handed to the LLM
//                 pipeline, null between batches. The batch prompt is built
//                 from the launch-time frames snapshot, so a mutation inside
//                 this range discards the batch instead of shrinking the tail.
let activeExtractionScope = null;
let activeRecallRunToken = 0;
let nextActiveRecallRequestId = 0;
const activeRecallRequestStates = new Map();
let latestRecallSnapshot = null;
let generationVisibleHistoryRegexProvider = null;

// Pending mutation-invalidation chain. Lives at module scope so the
// GENERATION_BEFORE_WORLD_INFO_SCAN listener can drain it before WI scan
// captures lorebook entries — otherwise a manual delete + immediate
// regenerate races the cache/lorebook refresh and stale persistent
// entries (event summaries) leak into the prompt.
let pendingMutationInvalidation = Promise.resolve();

// Test-only injection points. Production keeps these null; the dedicated
// test suite (tests/memory-graph/wi-scan-listeners.test.js) installs
// stubs via the `_set*HookForTest` exports below to assert side effects
// without exercising the real LLM / lorebook stack.
let __testSafeInjectMemoryPromptsHook = null;
let __testPersistentDrainHook = null;
function getGenerationVisibleHistoryRuntimeRegexScripts() {
    const context = getContext();
    const settings = getEffectiveSettings(context, getSettings());
    if (!settings?.enabled) {
        return [];
    }
    const visibleLayers = Math.max(0, Math.min(200, Math.floor(Number(settings?.llmVisibleRecentMessages ?? defaultSettings.llmVisibleRecentMessages))));
    if (visibleLayers <= 0) {
        return [];
    }
    const suffix = visibleLayers > 0 ? ` (${visibleLayers})` : '';

    return [{
        id: GENERATION_VISIBLE_HISTORY_REGEX_SCRIPT_ID,
        scriptName: `Memory Graph Visible Message Window${suffix}`,
        findRegex: '/[\\s\\S]*/g',
        replaceString: '',
        trimStrings: [],
        placement: [regex_placement.USER_INPUT, regex_placement.AI_OUTPUT],
        disabled: false,
        markdownOnly: false,
        promptOnly: true,
        runOnEdit: false,
        substituteRegex: substitute_find_regex.NONE,
        minDepth: visibleLayers,
        maxDepth: null,
    }];
}

function syncGenerationVisibleHistoryRuntimeRegexScripts(options = {}) {
    generationVisibleHistoryRegexProvider?.setScripts(getGenerationVisibleHistoryRuntimeRegexScripts(), options);
}

function cloneDefault(value) {
    return Array.isArray(value) || typeof value === 'object' ? structuredClone(value) : value;
}

/**
 * One-time migration that lifts memory-graph's private `embeddingSource` /
 * `embeddingModel` / `rerankSource` / `rerankModel` fields into shared
 * Connection Manager profiles. Subsequent runs short-circuit when the new
 * `embeddingProfileId` / `rerankProfileId` ids are already present.
 */
function migrateLegacyProfileSettings() {
    const s = extension_settings[MODULE_NAME];
    if (!s || typeof s !== 'object') return;

    let changed = false;

    if (!s.embeddingProfileId && (s.embeddingSource || s.embeddingModel)) {
        const source = String(s.embeddingSource || 'transformers').trim();
        const model = String(s.embeddingModel || '').trim();
        const baseName = `Memory Graph: ${source}${model ? ' ' + model : ''}`.trim();
        const profile = {
            mode: 'embed',
            name: baseName,
            source,
        };
        if (model) profile.model = model;
        const stored = upsertEmbeddingProfile(profile);
        if (stored) {
            s.embeddingProfileId = stored.id;
            changed = true;
        }
    }

    if (!s.rerankProfileId && s.rerankSource) {
        const source = String(s.rerankSource).trim();
        const model = String(s.rerankModel || '').trim();
        const baseName = `Memory Graph rerank: ${source}${model ? ' ' + model : ''}`.trim();
        const profile = {
            mode: 'rerank',
            name: baseName,
            source,
        };
        if (model) profile.model = model;
        const stored = upsertRerankProfile(profile);
        if (stored) {
            s.rerankProfileId = stored.id;
            changed = true;
        }
    }

    // Drop the now-orphaned legacy fields so they don't drift back into use.
    if ('embeddingSource' in s) { delete s.embeddingSource; changed = true; }
    if ('embeddingModel' in s) { delete s.embeddingModel; changed = true; }
    if ('rerankSource' in s) { delete s.rerankSource; changed = true; }
    if ('rerankModel' in s) { delete s.rerankModel; changed = true; }

    if (changed) {
        try {
            saveSettingsDebounced();
        } catch { /* settings layer not yet available — caller saves later. */ }
    }
}

export function getDefaultNodeTypeSchema() {
    return structuredClone(defaultNodeTypeSchema);
}

export function normalizeNodeTypeSchema(schema) {
    const list = Array.isArray(schema) ? schema : defaultNodeTypeSchema;
    const normalizeCompressionMode = (mode) => {
        const value = String(mode || '').trim().toLowerCase();
        return ['none', 'hierarchical'].includes(value) ? value : 'none';
    };
    const normalized = list
        .filter(item => item && typeof item === 'object')
        .map((item, index) => {
            const rawId = String(item.id || `custom_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
            const defaultRequired = rawId === 'event' ? ['summary'] : [];
            const requiredColumns = Array.isArray(item.requiredColumns)
                ? item.requiredColumns.map(x => String(x || '').trim()).filter(Boolean)
                : defaultRequired;
            const columnHints = item.columnHints && typeof item.columnHints === 'object' && !Array.isArray(item.columnHints)
                ? Object.fromEntries(
                    Object.entries(item.columnHints)
                        .map(([key, value]) => [String(key || '').trim(), String(value || '').trim()])
                        .filter(([key, value]) => key && value),
                )
                : {};
            const forceUpdate = item.forceUpdate === undefined
                ? rawId === 'event'
                : Boolean(item.forceUpdate);
            const editable = item.editable === undefined
                ? rawId !== 'event'
                : Boolean(item.editable);
            const rawCompressionMode = String(item?.compression?.mode || '').trim().toLowerCase();
            const defaultCompressionRule = '';
            const tableColumns = Array.isArray(item.tableColumns)
                ? item.tableColumns.map(x => String(x || '').trim()).filter(Boolean)
                : ['title'];
            const requestedLatestOnly = Boolean(item.latestOnly);
            const rawPrimaryKeyColumns = Array.isArray(item.primaryKeyColumns)
                ? item.primaryKeyColumns
                : [];
            const allowedKeyColumns = new Set(tableColumns);
            const primaryKeyColumns = Array.from(new Set(
                rawPrimaryKeyColumns
                    .map(x => String(x || '').trim())
                    .filter(Boolean)
                    .filter(column => allowedKeyColumns.has(column)),
            ));
            const latestOnly = requestedLatestOnly;
            const embeddingColumns = Array.isArray(item.embeddingColumns)
                ? item.embeddingColumns.map(x => String(x || '').trim()).filter(col => col && tableColumns.includes(col))
                : tableColumns.slice();
            return {
                id: rawId,
                label: String(item.label || item.id || `Type ${index + 1}`).trim(),
                tableName: String(item.tableName || item.id || `table_${index + 1}`).trim(),
                tableColumns,
                embeddingColumns,
                level: String(item.level || LEVEL.SEMANTIC),
                extractHint: String(item.extractHint || '').trim(),
                extractionInstructions: String(item.extractionInstructions ?? DEFAULT_PER_TYPE_INSTRUCTIONS[rawId] ?? '').trim(),
                // Force-update types run on every pass, so the cadence is
                // meaningless for them: never synthesize a default. A value
                // already persisted on such a type is carried through
                // untouched and simply ignored by the cadence.
                ...(forceUpdate
                    ? (item.extractEveryN === undefined ? {} : { extractEveryN: item.extractEveryN })
                    : { extractEveryN: Math.max(1, Math.floor(Number.isFinite(Number(item.extractEveryN)) ? Number(item.extractEveryN) : 1) || 1) }),
                keywords: Array.isArray(item.keywords) ? item.keywords.map(x => String(x || '').trim()).filter(Boolean) : [],
                columnHints,
                requiredColumns,
                forceUpdate,
                editable,
                alwaysInject: Boolean(item.alwaysInject),
                latestOnly,
                // Per-type RAG recall quota. 0 (default) = follow the global
                // ragDefaultPerTypeK. Positive integer = override just this
                // type. Negative / NaN / null / undefined all collapse to 0.
                ragPerTypeK: Math.max(0, Math.floor(
                    Number.isFinite(Number(item.ragPerTypeK)) ? Number(item.ragPerTypeK) : 0,
                )),
                recordsFloorRange: Boolean(item?.recordsFloorRange),
                primaryKeyColumns,
                compression: {
                    mode: normalizeCompressionMode(rawCompressionMode),
                    threshold: Math.max(2, Number(item?.compression?.threshold) || 6),
                    fanIn: Math.max(2, Number(item?.compression?.fanIn) || 3),
                    maxDepth: Math.max(1, Number(item?.compression?.maxDepth) || 6),
                    keepRecentLeaves: Math.max(0, Number(item?.compression?.keepRecentLeaves) || 0),
                    rule: String(item?.compression?.rule ?? defaultCompressionRule).trim(),
                    summarizeInstruction: String(item?.compression?.summarizeInstruction || '').trim(),
                },
            };
        })
        .filter(item => item && item.id);

    const deduped = [];
    const seenIds = new Set();
    for (const item of normalized) {
        let id = String(item.id || '').trim();
        if (!id) {
            continue;
        }
        if (seenIds.has(id)) {
            let suffix = 2;
            while (seenIds.has(`${id}_${suffix}`)) {
                suffix += 1;
            }
            id = `${id}_${suffix}`;
        }
        seenIds.add(id);
        deduped.push({ ...item, id });
    }

    return deduped.length > 0 ? deduped : structuredClone(defaultNodeTypeSchema);
}

function normalizeRecallInjectPosition(value) {
    const numeric = Number(value);
    return SUPPORTED_WORLD_INFO_POSITIONS.includes(numeric) ? numeric : world_info_position.atDepth;
}

function migrateLegacyRecallInjectPosition(value) {
    switch (Number(value)) {
        case extension_prompt_types.BEFORE_PROMPT:
            return world_info_position.before;
        case extension_prompt_types.IN_PROMPT:
            return world_info_position.after;
        case extension_prompt_types.IN_CHAT:
            return world_info_position.atDepth;
        default:
            return world_info_position.atDepth;
    }
}

function normalizeRecallInjectDepth(value) {
    return Math.max(0, Math.min(10000, Math.floor(Number(value) || 0)));
}

function normalizeRecallInjectRole(value) {
    const allowed = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
    const numeric = Number(value);
    return allowed.includes(numeric) ? numeric : extension_prompt_roles.SYSTEM;
}

function getExtractableLatestSeq(totalTurns, settings = null) {
    const total = Math.max(0, Math.floor(Number(totalTurns || 0)));
    const excludedRecentTurns = normalizeExtractExcludeRecentTurns(
        settings?.extractExcludeRecentTurns ?? defaultSettings.extractExcludeRecentTurns,
    );
    return Math.max(0, total - excludedRecentTurns);
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }
    const hasRecallInjectPositionSchemaVersion = Object.prototype.hasOwnProperty.call(
        extension_settings[MODULE_NAME],
        'recallInjectPositionSchemaVersion',
    );

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = cloneDefault(value);
        }
    }

    // One-shot: carry a user-authored legacy schema prompt into the
    // configuration prompt slot. Must run before the legacy normalization
    // below rewrites the old key with the retired default.
    migrateConfigIterationPrompt(extension_settings[MODULE_NAME]);

    const normalizedAdvanced = normalizeAdvancedSettings(extension_settings[MODULE_NAME], defaultSettings);
    for (const key of Object.keys(ADVANCED_SETTING_DEFAULTS)) {
        extension_settings[MODULE_NAME][key] = normalizedAdvanced[key];
    }

    // Legacy migration: convert old embeddingSource/embeddingModel + rerankSource/rerankModel
    // into Connection Manager profiles so memory-graph stops reading the vectors plugin's
    // private settings.
    migrateLegacyProfileSettings();

    if (extension_settings[MODULE_NAME].schemaIterationApiPresetName !== undefined) {
        extension_settings[MODULE_NAME].requestApiPresetName ||= String(extension_settings[MODULE_NAME].schemaIterationApiPresetName || '');
        delete extension_settings[MODULE_NAME].schemaIterationApiPresetName;
    }
    if (extension_settings[MODULE_NAME].schemaIterationPresetName !== undefined) {
        extension_settings[MODULE_NAME].requestLlmPresetName ||= String(extension_settings[MODULE_NAME].schemaIterationPresetName || '');
        delete extension_settings[MODULE_NAME].schemaIterationPresetName;
    }

    if (!hasRecallInjectPositionSchemaVersion) {
        extension_settings[MODULE_NAME].recallInjectPosition = migrateLegacyRecallInjectPosition(
            extension_settings[MODULE_NAME].recallInjectPosition,
        );
    }
    extension_settings[MODULE_NAME].recallInjectPosition = normalizeRecallInjectPosition(extension_settings[MODULE_NAME].recallInjectPosition);
    extension_settings[MODULE_NAME].recallInjectPositionSchemaVersion = RECALL_INJECT_POSITION_SCHEMA_VERSION;
    extension_settings[MODULE_NAME].recallInjectDepth = normalizeRecallInjectDepth(extension_settings[MODULE_NAME].recallInjectDepth);
    extension_settings[MODULE_NAME].recallInjectRole = normalizeRecallInjectRole(extension_settings[MODULE_NAME].recallInjectRole);
    delete extension_settings[MODULE_NAME].plainTextFunctionCallMode;
    extension_settings[MODULE_NAME].autoExtractionEnabled =
        extension_settings[MODULE_NAME].autoExtractionEnabled !== false;
    extension_settings[MODULE_NAME].autoCompressionEnabled =
        extension_settings[MODULE_NAME].autoCompressionEnabled !== false;
    extension_settings[MODULE_NAME].updateEvery = Math.max(
        1,
        Math.floor(Number(extension_settings[MODULE_NAME].updateEvery) || defaultSettings.updateEvery),
    );
    // RAG per-type quota default. 0 disables bucketing (single shared pool).
    const ragDefaultPerTypeKRaw = Number(extension_settings[MODULE_NAME].ragDefaultPerTypeK);
    extension_settings[MODULE_NAME].ragDefaultPerTypeK = Math.max(
        0,
        Math.min(50, Math.floor(Number.isFinite(ragDefaultPerTypeKRaw) ? ragDefaultPerTypeKRaw : defaultSettings.ragDefaultPerTypeK)),
    );
    extension_settings[MODULE_NAME].nodeTypeSchema = normalizeNodeTypeSchema(extension_settings[MODULE_NAME].nodeTypeSchema);

    normalizeLegacyRecallSettings(extension_settings[MODULE_NAME]);
}

/**
 * Collapse the 4-mode hybrid recall settings into the 2-mode LLM/RAG schema.
 * Mutates `settings` in place. Pure helper exported for unit tests; ensureSettings
 * is the production caller.
 *
 *   hybrid           → rag (no toggles)
 *   hybrid_rerank    → rag + ragUseRerank=true
 *   hybrid_llm       → rag (no toggles — hybrid_llm was second-stage LLM finalize, not query rewrite)
 *   unknown / blank  → llm
 *
 * Also coerces the rag* fields to canonical types and strips the legacy
 * diffusion / enableRerank fields so they stop round-tripping through disk.
 */
export function normalizeLegacyRecallSettings(settings) {
    if (!settings || typeof settings !== 'object') {
        return settings;
    }
    const legacy = String(settings.recallMethod || '').trim().toLowerCase();
    if (legacy === 'hybrid' || legacy === 'hybrid_llm') {
        settings.recallMethod = 'rag';
    } else if (legacy === 'hybrid_rerank') {
        settings.recallMethod = 'rag';
        settings.ragUseRerank = true;
    } else if (legacy !== 'llm' && legacy !== 'rag') {
        settings.recallMethod = 'llm';
    }
    settings.ragUseRerank = Boolean(settings.ragUseRerank);
    settings.ragUseQueryRewrite = Boolean(settings.ragUseQueryRewrite);
    settings.ragRewriteApiPresetName = String(settings.ragRewriteApiPresetName || '');
    settings.ragRewriteLlmPresetName = String(settings.ragRewriteLlmPresetName || '');
    delete settings.diffusionSteps;
    delete settings.diffusionDecay;
    delete settings.diffusionTopK;
    delete settings.diffusionTeleportAlpha;
    delete settings.enableRerank;
    // Legacy: mainInjectionAssistantTurnsWindow was a separate setting that
    // duplicated recentRawTurns' meaning ("how many trailing assistant turns
    // are already visible as raw text"). Collapsed into recentRawTurns alone.
    delete settings.mainInjectionAssistantTurnsWindow;
    return settings;
}

export function getSettings() {
    return extension_settings[MODULE_NAME];
}


function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
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


function getConnectionProfiles() {
    return getChatCompletionConnectionProfiles();
}


export function getChatKey(context, explicitTarget = null) {
    const target = buildMemoryTargetFromContext(context, explicitTarget);
    if (!target) {
        return 'invalid_target';
    }
    if (target.is_group) {
        return `group:${target.id}`;
    }
    return `char:${target.avatar_url}:${target.file_name}`;
}

function normalizeExplicitChatStateTarget(target) {
    if (!target || typeof target !== 'object') {
        return null;
    }
    if (target.is_group) {
        const id = String(target.id || '').trim();
        return id ? { is_group: true, id } : null;
    }
    const avatar = String(target.avatar_url || '').trim();
    const fileName = String(target.file_name || '').trim();
    return avatar && fileName
        ? { is_group: false, avatar_url: avatar, file_name: fileName }
        : null;
}

function normalizeResolvedMemoryTarget(target) {
    if (!target || typeof target !== 'object') {
        return null;
    }
    if (target.is_group) {
        const id = String(target.id || '').trim();
        return id ? { is_group: true, id } : null;
    }
    const avatar = String(target.avatar_url || '').trim();
    const fileName = String(target.file_name || '').trim();
    return avatar && fileName
        ? { is_group: false, avatar_url: avatar, file_name: fileName }
        : null;
}

function buildMemoryTargetFromContext(context, explicitTarget = null) {
    const resolvedTarget = resolveChatStateTarget(explicitTarget);
    return normalizeResolvedMemoryTarget(resolvedTarget);
}

function getLatestAssistantFloorFromContext(context) {
    return Math.max(0, Math.floor(Number(computeChatSourceState(context)?.messageCount || 0)));
}

function getMemoryGraphExportFileNameForContext(context) {
    return getMemoryGraphExportFileName(buildMemoryTargetFromContext(context));
}

async function promptMemoryGraphImportMode(context, store) {
    const normalized = normalizeStoreForRuntime(store);
    const latestAssistantFloor = getLatestAssistantFloorFromContext(context);
    const exportedFloor = getImportedStoreBindingFloor(normalized);
    const specificFloorInputId = 'luker_rpg_memory_import_bind_floor';
    const defaultSpecificFloor = latestAssistantFloor > 0
        ? latestAssistantFloor
        : Math.max(1, exportedFloor || 1);
    let importMode = null;
    let bindFloor = null;

    const content = `
        <div class="flex-container flexFlowColumn gap8">
            <div>${escapeHtml(i18n('Choose how to attach the imported memory graph to assistant floors.'))}</div>
            <div>${escapeHtml(i18nFormat(
        'Imported nodes: ${0} | Edges: ${1} | Exported floor: ${2}',
        Object.keys(normalized.nodes || {}).length,
        Array.isArray(normalized.edges) ? normalized.edges.length : 0,
        exportedFloor,
    ))}</div>
            <div>${escapeHtml(i18nFormat('Current chat latest assistant floor: ${0}', latestAssistantFloor))}</div>
            <div class="opacity70p">${escapeHtml(i18n('Restore keeps exported floor numbers for same-chat recovery. Bind modes rewrite all imported nodes to the selected floor.'))}</div>
        </div>
    `;

    const result = await context.callGenericPopup(content, context.POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: i18n('Cancel'),
        wider: true,
        defaultResult: context.POPUP_RESULT.CUSTOM1,
        customInputs: [{
            id: specificFloorInputId,
            type: 'text',
            label: i18n('Specific assistant floor'),
            defaultState: String(defaultSpecificFloor),
            tooltip: i18nFormat('Enter a floor between 1 and ${0}.', Math.max(1, latestAssistantFloor)),
        }],
        customButtons: [
            { text: i18n('Restore Exported Floor'), result: context.POPUP_RESULT.CUSTOM1 },
            { text: i18n('Bind Latest Floor'), result: context.POPUP_RESULT.CUSTOM2 },
            { text: i18n('Bind Specific Floor'), result: context.POPUP_RESULT.CUSTOM3 },
        ],
        onClosing: async (popup) => {
            if (popup.result === context.POPUP_RESULT.CANCELLED) {
                return true;
            }

            if (popup.result === context.POPUP_RESULT.CUSTOM1) {
                if (exportedFloor > latestAssistantFloor) {
                    notifyError(i18nFormat(
                        'Restore requires current chat to have at least ${0} assistant floor(s). Current chat only has ${1}. Choose a bind mode instead.',
                        exportedFloor,
                        latestAssistantFloor,
                    ));
                    return false;
                }
                importMode = 'restore';
                bindFloor = exportedFloor;
                return true;
            }

            if (popup.result === context.POPUP_RESULT.CUSTOM2) {
                if (latestAssistantFloor <= 0) {
                    notifyError(i18n('Current chat has no assistant floors to bind.'));
                    return false;
                }
                importMode = 'bind_latest';
                bindFloor = latestAssistantFloor;
                return true;
            }

            if (popup.result === context.POPUP_RESULT.CUSTOM3) {
                if (latestAssistantFloor <= 0) {
                    notifyError(i18n('Current chat has no assistant floors to bind.'));
                    return false;
                }
                const rawValue = String(popup.inputResults?.get(specificFloorInputId) ?? '').trim();
                if (!/^\d+$/.test(rawValue)) {
                    notifyError(i18nFormat('Enter a floor between 1 and ${0}.', latestAssistantFloor));
                    return false;
                }
                const specificFloor = Number(rawValue);
                if (!Number.isFinite(specificFloor) || specificFloor < 1 || specificFloor > latestAssistantFloor) {
                    notifyError(i18nFormat('Enter a floor between 1 and ${0}.', latestAssistantFloor));
                    return false;
                }
                importMode = 'bind_specific';
                bindFloor = specificFloor;
                return true;
            }

            return true;
        },
    });

    if (result === context.POPUP_RESULT.CANCELLED || !importMode) {
        return null;
    }

    return {
        importMode,
        bindFloor,
        exportedFloor,
        latestAssistantFloor,
    };
}

async function importMemoryGraphStore(context, parsed) {
    const chatKey = getChatKey(context);
    const target = memoryStoreTargets.get(chatKey) || buildMemoryTargetFromContext(context);
    if (target) {
        memoryStoreTargets.set(chatKey, target);
    }
    const imported = normalizeStoreForRuntime(parsed);
    const importPlan = await promptMemoryGraphImportMode(context, imported);
    if (!importPlan) {
        return null;
    }

    const nextStore = importPlan.importMode === 'restore'
        ? clearImportedStoreTransientState(imported)
        : bindImportedStoreToAssistantFloor(imported, importPlan.bindFloor);
    updateStoreSourceState(nextStore, context);
    const persistSeq = importPlan.importMode === 'restore'
        ? importPlan.exportedFloor
        : Math.max(1, Math.floor(Number(importPlan.bindFloor || 0)));
    await new Promise(resolve => setTimeout(resolve, 0));
    await commitMemoryStoreReplaceByChatKey(
        context,
        chatKey,
        nextStore,
        persistSeq,
        { syncPersistentProjection: true, floor: seqToFloor(context, persistSeq) },
    );
    clearRollbackHistory(chatKey);
    latestRecallSnapshot = null;
    refreshUiStats();
    return {
        importMode: importPlan.importMode,
        bindFloor: persistSeq,
    };
}

async function deleteMemoryStoreByTarget(context, target) {
    if (typeof context.deleteChatState !== 'function') {
        throw new Error('Chat state delete API is unavailable in extension context.');
    }
    // Floor-state owns the log sidecar — ask it to purge that itself.
    // memory-graph still owns the META sidecar, so we delete that directly.
    // The legacy CHAT_STATE_NAMESPACE data sidecar should already be gone
    // post-migration; deleting it here is a no-op guard for chats whose
    // first fs.get() never ran (e.g. fresh install meeting an old sidecar).
    //
    // Returns `{ ok, partial }` so the Reset button can surface which step
    // failed (log / meta / legacy) instead of flashing a green success toast
    // over a half-deleted state. Each failure is also console-logged.
    const partial = {};
    try {
        const fs = await getFloorStateInstance(context);
        const r = await fs.destroy({ purge: true });
        if (!r.ok) {
            partial.fs = r.reason;
            console.warn(`[${MODULE_NAME}] floor-state log purge failed (reason=${r.reason}, hint=${r.hint})`);
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to purge floor-state log sidecar`, { target, error });
        partial.fs = 'EXCEPTION';
    }
    // The singleton is now dead; clear the cache so the next mutation gets
    // a fresh instance bound to the (now-empty) namespace.
    resetFloorStateInstance();
    try {
        const metaResult = await context.deleteChatState(META_NAMESPACE, { target });
        if (metaResult && metaResult.ok === false) {
            partial.meta = metaResult.reason;
            console.warn(`[${MODULE_NAME}] meta sidecar delete failed (reason=${metaResult.reason}, hint=${metaResult.hint})`);
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to delete memory-graph meta sidecar`, { target, error });
        partial.meta = 'EXCEPTION';
    }
    try {
        const legacyResult = await context.deleteChatState(CHAT_STATE_NAMESPACE, { target });
        if (legacyResult && legacyResult.ok === false) {
            partial.legacy = legacyResult.reason;
            console.warn(`[${MODULE_NAME}] legacy data sidecar delete failed (reason=${legacyResult.reason}, hint=${legacyResult.hint})`);
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to delete legacy memory-graph data sidecar`, { target, error });
        partial.legacy = 'EXCEPTION';
    }
    return { ok: Object.keys(partial).length === 0, partial };
}

/**
 * Build a user-visible, reason-localized persist-failure message.
 *
 * The visible message is composed of (a) a short reason sentence (one of the
 * STATE_ERROR_REASONS values, mapped to a translatable string) and (b) a
 * `[op=… stage=… seq=… floor=… chatLen=…]` debug suffix so a screenshot still
 * tells us which path and which floor was involved. The `hint` carried by the
 * envelope is intentionally NOT spliced into the toast: hints are
 * `STATE_HINT_MAX_LENGTH`-capped diagnostic strings from the producer layer,
 * not localized user copy. They land in `console.error` instead.
 */
function formatPersistFailure({ op, stage, seq, floor, chatLen, reason }) {
    const reasonText = (() => {
        switch (reason) {
            case STATE_ERROR_REASONS.VALIDATION_ARGS:
                return i18n('Internal bug, invalid arguments passed to memory save.');
            case STATE_ERROR_REASONS.VALIDATION_TARGET:
                return i18n('No active chat for memory save.');
            case STATE_ERROR_REASONS.VALIDATION_COMMIT:
                return i18n('Memory log commit rejected by validation.');
            case STATE_ERROR_REASONS.INSTANCE_DESTROYED:
                return i18n('Memory storage was destroyed, reload the chat.');
            case STATE_ERROR_REASONS.CONFLICT:
                return i18n('Memory save lost a race after retry, try again.');
            case STATE_ERROR_REASONS.HTTP_ERROR:
                return i18n('Memory save failed (server error).');
            case STATE_ERROR_REASONS.TRANSPORT_ERROR:
                return i18n('Memory save failed (network error).');
            case STATE_ERROR_REASONS.REPLAY_BROKEN:
                return i18n('Memory log replay failed and could not be recovered.');
            case STATE_ERROR_REASONS.LOG_WRITE_FAILED:
                return i18n('Memory log write failed.');
            default:
                return i18n('Memory save failed.');
        }
    })();
    const contextSuffix = i18nFormat(
        ' [op=${0} stage=${1} seq=${2} floor=${3} chatLen=${4}]',
        String(op || '?'),
        String(stage || '?'),
        seq === null || seq === undefined ? 'n/a' : String(seq),
        floor === null || floor === undefined ? 'n/a' : String(floor),
        chatLen === null || chatLen === undefined ? 'n/a' : String(chatLen),
    );
    return `${reasonText}${contextSuffix}`;
}

/**
 * Replace the floor-state log for the current chat with a single commit that
 * encodes `store` as a fresh baseline at the supplied floor. Used by
 * Reset / Rebuild / Import paths that need to install a new history rather
 * than append to it.
 *
 * Goes through `fs.reset()` so the floor-state singleton owns the write
 * (single underlying log update + cache invalidation). The data namespace is
 * not touched: it's no longer a persisted source of truth — `fs.get()`
 * replays the log on demand.
 *
 * `floor` is required: callers compute it via `seqToFloor(context, seq)` so
 * the commit anchors at the chat slot the covered seq actually maps to.
 * Passing an invalid floor (null / out of range) returns `{ skipped: true }`
 * so the caller can decide whether to retry or surface.
 *
 * `seq` is the watermark stamp (coveredAssistantSeq / appliedSeqTo /
 * loggedSeqTo). It doubles as the seq that derived the floor, but the floor
 * is supplied explicitly so callers don't all re-derive it.
 */
async function replaceGraphLogForTarget(context, store, seq, floor, validate) {
    const fs = await getFloorStateInstance(context);
    await fs.ready();
    const normalizedStore = normalizeStoreForRuntime(store);
    const normalizedSeq = resolveStoreCommitSeq(seq, normalizedStore);
    const finalPayload = graphPayloadFromStore(normalizedStore);
    finalPayload.coveredAssistantSeq = Math.max(finalPayload.coveredAssistantSeq, normalizedSeq);
    finalPayload.appliedSeqTo = Math.max(finalPayload.appliedSeqTo, normalizedSeq);
    finalPayload.loggedSeqTo = Math.max(finalPayload.loggedSeqTo, normalizedSeq);

    const floorResolved = Number.isInteger(floor) && floor >= 0;
    const swipeId = floorResolved ? (activeSwipeIdAtFloor(context, floor) ?? 0) : 0;
    const buildObjectPatchOperationsAsync = context.buildObjectPatchOperationsAsync;
    const patches = await buildObjectPatchOperationsAsync({}, finalPayload);

    if (Array.isArray(patches) && patches.length > 0 && floorResolved) {
        validate?.();
        const result = await fs.reset([{ floor, swipeId, patches }]);
        return {
            payload: finalPayload,
            hasCommit: result.ok,
            skipped: !result.ok,
            reason: result.ok ? null : result.reason,
            hint: result.ok ? null : result.hint,
        };
    }

    if (!floorResolved) {
        console.warn(`[${MODULE_NAME}] replace skipped: caller did not supply a valid trigger floor (seq=${normalizedSeq}, floor=${floor}).`);
        return {
            payload: finalPayload,
            hasCommit: false,
            skipped: true,
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
            hint: 'caller did not supply a valid trigger floor',
        };
    }

    // floor resolved but patches empty — the store is genuinely empty.
    // Guard: if the log has commits on disk, an empty-store write here is
    // almost certainly a bug (cache got poisoned to empty by a mid-load
    // refresh where replay's swipeMap projection returned {}). Never
    // silently `fs.reset([])` a non-empty log — force user acknowledgement,
    // because a wipe is irreversible and there is no snapshot to fall back
    // on (the log is the source of truth).
    const currentLogSize = typeof fs.getLogSize === 'function' ? await fs.getLogSize() : 0;
    if (currentLogSize > 0) {
        const confirmed = await context.callGenericPopup(
            i18nFormat(
                'About to wipe memory graph for the current chat. The on-disk log has ${0} commit(s) but the in-memory graph is empty — this usually means the chat was still loading when a write was triggered, not that you asked to clear the graph. Continuing will permanently delete all recorded nodes and edges. Continue anyway?',
                currentLogSize,
            ),
            context.POPUP_TYPE.CONFIRM,
            '',
            {
                okButton: i18n('Wipe anyway'),
                cancelButton: i18n('Cancel (recommended)'),
            },
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) {
            return {
                payload: finalPayload,
                hasCommit: false,
                skipped: true,
                reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
                hint: 'user declined to wipe non-empty log with an empty store',
            };
        }
    }
    validate?.();
    const result = await fs.reset([]);
    return {
        payload: finalPayload,
        hasCommit: false,
        skipped: !result.ok,
        reason: result.ok ? null : result.reason,
        hint: result.ok ? null : result.hint,
    };
}

async function loadMemoryStoreByTarget(context, target) {
    if (typeof context.getChatState !== 'function') {
        throw new Error('Chat state API is unavailable in extension context.');
    }
    const metaResult = await context.getChatState(META_NAMESPACE, { target });
    const meta = metaResult?.ok ? metaResult.state : null;
    const isV2 = meta && Number(meta.schemaVersion || 0) >= META_SCHEMA_VERSION;

    if (isV2) {
        // Floor-state owns the log: replay, swipe-map projection, migration,
        // and one-shot recovery from a stale data namespace are all centralized
        // in fs.get(). We never read the log namespace directly here.
        const fs = await getFloorStateInstance(context);
        await fs.ready();
        const payloadResult = await fs.get();
        if (!payloadResult.ok) {
            // A read failure (transient HTTP / REPLAY_BROKEN / destroyed) must
            // NOT degrade to an empty payload — the caller would cache an
            // empty store, then the next write would diff `realLog → empty`
            // and persist a graph-wiping commit (or `commitSessionMutation`
            // would fs.reset([]) the log entirely). Surface the failure and
            // let the caller decide; the on-disk log stays intact.
            const isReplayBroken = payloadResult.reason === STATE_ERROR_REASONS.REPLAY_BROKEN;
            const message = isReplayBroken
                ? i18n('Memory graph log replay failed, data may be unrecoverable. Use Reset or Import to recover.')
                : i18nFormat('Memory graph load failed: ${0}', payloadResult.hint || payloadResult.reason || i18n('reason unknown'));
            notifyError(message);
            throw new Error(`[${MODULE_NAME}] loadMemoryStoreByTarget read failed (reason=${payloadResult.reason}, hint=${payloadResult.hint})`);
        }
        const payload = payloadResult.state || {};
        const runtimeStore = buildRuntimeStoreFromGraphPayloadAndMeta(payload, meta);
        return {
            state: synthesizePersistedStateFromStoreAndMeta(runtimeStore, meta),
            store: runtimeStore,
            migrated: false,
            meta: meta && typeof meta === 'object' ? structuredClone(meta) : null,
            v2: true,
        };
    }

    // v1 / legacy raw fallback: opLog inside main namespace, no __meta.
    // Schema-migration will hoist this to v2 on the next ensureMemoryStoreLoaded.
    const dataResult = await context.getChatState(CHAT_STATE_NAMESPACE, { target });
    const data = dataResult?.ok ? dataResult.state : null;
    const { state, migrated } = normalizePersistedMemoryState(data, context);
    return {
        state,
        store: buildRuntimeStoreFromPersistedState(state),
        migrated,
        meta: null,
        v2: false,
    };
}

/**
 * Persist the meta sidecar for a chat target and refresh the cache.
 *
 * `persistMetaFields` is now an envelope passthrough — when the underlying
 * `updateChatState` reports `VALIDATION_TARGET` we treat it as a benign skip
 * (background extractions / debounced flushes that fire with no active chat
 * land here); any other `reason` becomes an Error so the caller's existing
 * `try/catch` wiring can react.
 */
async function persistMetaForChatKey(context, chatKey, store, target = undefined) {
    const resolvedTarget = target || memoryStoreTargets.get(chatKey);
    if (!resolvedTarget) return null;
    const meta = metaFieldsFromStore(store);
    setCachedMeta(chatKey, meta);
    const result = await persistMetaFields(context, meta, resolvedTarget);
    if (!result?.ok) {
        if (result?.reason === STATE_ERROR_REASONS.VALIDATION_TARGET) {
            console.warn(`[${MODULE_NAME}] meta persist skipped: ${result.hint}`);
            return meta;
        }
        throw new Error(`[${MODULE_NAME}] meta sidecar persist failed (${result?.reason}): ${result?.hint}`);
    }
    return meta;
}

/**
 * Replace-style persist: wipes the log and writes one commit covering the
 * given store at the supplied floor. Updates __meta and the runtime caches.
 *
 * Used by import, raw-graph editor apply, and the rebuild flow's
 * onBatchApplied/onCompressionApplied checkpoints. `floor` MUST be derived
 * from `seqToFloor(context, seq)` (or the equivalent for the covered watermark)
 * so the commit anchors at the chat slot the covered seq actually maps to.
 */
async function commitMemoryStoreReplaceByChatKey(context, chatKey, store, seq, { syncPersistentProjection = false, floor = null, validate } = {}) {
    const target = memoryStoreTargets.get(chatKey);
    if (!target) {
        throw new Error('Memory store target is unavailable.');
    }
    const normalizedStore = normalizeStoreForRuntime(store);
    const normalizedSeq = resolveStoreCommitSeq(seq, normalizedStore);

    const replaceResult = await replaceGraphLogForTarget(context, normalizedStore, normalizedSeq, floor, validate);
    if (replaceResult.skipped) {
        // Disk untouched; do not advance the in-memory cache to a state that
        // is not persisted. Existing cache stays the source of truth until
        // a later write succeeds. Propagate the skip reason so the wrapping
        // UI callers (persistLatest, raw-JSON Apply, rebuild) can surface a
        // real failure toast instead of pretending the save landed.
        return {
            store: memoryStoreCache.get(chatKey) || normalizedStore,
            skipped: true,
            reason: replaceResult.reason || null,
            hint: replaceResult.hint || null,
        };
    }

    const meta = await persistMetaForChatKey(context, chatKey, {
        ...normalizedStore,
        sourceMessageCount: normalizedStore.sourceMessageCount,
    }, target);

    const runtimeStore = buildRuntimeStoreFromGraphPayloadAndMeta(replaceResult.payload, meta);
    runtimeStore.lastExtractionDebug = normalizedStore?.lastExtractionDebug && typeof normalizedStore.lastExtractionDebug === 'object'
        ? structuredClone(normalizedStore.lastExtractionDebug)
        : null;
    memoryStoreCache.set(chatKey, runtimeStore);

    if (syncPersistentProjection && chatKey === getChatKey(context)) {
        const effectiveSettings = getEffectiveSettings(context, getSettings());
        await syncPersistentLorebookProjection(context, effectiveSettings, runtimeStore);
    }
    return { store: runtimeStore, skipped: false, reason: null, hint: null };
}

/**
 * Diff-style persist: appends one commit to the floor-state log carrying the
 * incremental `prev → next` diff between the materialized data namespace and
 * `afterPayload`, updates __meta if metadata changed, refreshes caches.
 *
 * Why incremental, not snapshot-from-empty: floor-state.js documents that
 * each commit's patches must be a `prev → next` diff against the running
 * materialized state — replay walks commits sequentially against `{}` and
 * each commit assumes the prior surviving commits' patches are already in
 * place. Snapshot-from-empty patches violate that contract and balloon log
 * size (every commit serializes the full graph). Floor-state guarantees
 * deletions are tail-only on the active replay path, so commits form a
 * contiguous chain and incremental patches replay correctly.
 *
 * fs.update reads the current materialized state, runs the reducer (which
 * here just returns afterPayload), computes the prev→next diff via the
 * host-injected buildObjectPatchOperationsAsync, and appends a single commit
 * tagged at `floor`. This guarantees the recorded patches are coherent with
 * whatever state floor-state actually holds — even if our beforeStore copy
 * happens to be stale.
 */
async function commitMemoryStoreDiffByChatKey(context, chatKey, beforeStore, afterStore, seq, { syncPersistentProjection = false, floor = null } = {}) {
    const target = memoryStoreTargets.get(chatKey);
    if (!target) {
        throw new Error('Memory store target is unavailable.');
    }
    const fs = await getFloorStateInstance(context);
    const normalizedBefore = normalizeStoreForRuntime(beforeStore);
    const normalizedAfter = normalizeStoreForRuntime(afterStore);
    const normalizedSeq = resolveStoreCommitSeq(seq, normalizedAfter);

    const beforePayload = graphPayloadFromStore(normalizedBefore);
    const afterPayload = graphPayloadFromStore(normalizedAfter);
    afterPayload.coveredAssistantSeq = Math.max(afterPayload.coveredAssistantSeq, normalizedSeq);
    afterPayload.appliedSeqTo = Math.max(afterPayload.appliedSeqTo, normalizedSeq);
    afterPayload.loggedSeqTo = Math.max(afterPayload.loggedSeqTo, normalizedSeq);

    const buildObjectPatchOperationsAsync = context.buildObjectPatchOperationsAsync;
    const incrementalOps = await buildObjectPatchOperationsAsync(beforePayload, afterPayload);
    const metadataChanged = hasPersistedStoreMetadataChanges(normalizedBefore, normalizedAfter);
    const hasGraphChange = Array.isArray(incrementalOps) && incrementalOps.length > 0;

    if (!hasGraphChange && !metadataChanged) {
        const cached = memoryStoreCache.get(chatKey);
        return { store: cached || normalizedAfter, skipped: false, reason: null, hint: null };
    }

    if (hasGraphChange) {
        const chatLen = Array.isArray(context?.chat) ? context.chat.length : 0;
        // `floor` is the chat slot the seq this commit covers maps to —
        // computed by callers via `seqToFloor(context, seq)` (or
        // resolveInFlightAnchor for in-flight director writes that may land
        // on an empty placeholder seqToFloor can't see). It MUST be supplied
        // by the caller: anchoring at "chat tail at write time" sampled here
        // would mis-attribute commits when the user posts new messages
        // mid-extraction.
        //
        // Missing floor is an MG-internal precondition violation (the caller
        // forgot to derive one), NOT a state-API failure. Log + throw a
        // developer-shaped error — the user can't fix it.
        if (!Number.isInteger(floor) || floor < 0) {
            const internalMsg = `[${MODULE_NAME}] commit-diff caller did not supply a valid floor (seq=${normalizedSeq}, floor=${floor === null ? 'missing' : String(floor)}, chatLen=${chatLen}); commits must be anchored at the chat slot the covered seq maps to`;
            console.error(internalMsg);
            throw new Error(internalMsg);
        }
        let committed;
        try {
            committed = await fs.update(() => afterPayload, { floor });
        } catch (error) {
            // fs.update is envelope-typed now and shouldn't throw, but if a
            // dep injection bug or older build leaks through we still
            // want a localized message rather than a raw stack.
            const msg = formatPersistFailure({
                op: 'commit-diff',
                stage: 'log-append',
                seq: normalizedSeq,
                floor,
                chatLen,
                reason: STATE_ERROR_REASONS.HTTP_ERROR,
            });
            console.error(`[${MODULE_NAME}] commit-diff fs.update threw: ${error?.message || error}`);
            throw new Error(msg);
        }
        if (!committed.ok) {
            // Chat switched mid-flight → benign no-op; matches the existing
            // "no commit, drop the in-flight payload" semantics that callers
            // rely on. Don't throw, don't toast — caller will see no graph
            // mutation but the new chat owns the next write. Carry the
            // skip reason in the envelope so UI wrappers (persistLatest)
            // can decide whether to suppress the success toast.
            if (committed.reason === STATE_ERROR_REASONS.VALIDATION_TARGET) {
                console.warn(`[${MODULE_NAME}] commit-diff skipped (target changed): ${committed.hint}`);
                return {
                    store: memoryStoreCache.get(chatKey) || normalizedAfter,
                    skipped: true,
                    reason: committed.reason,
                    hint: committed.hint,
                };
            }
            const msg = formatPersistFailure({
                op: 'commit-diff',
                stage: 'log-append',
                seq: normalizedSeq,
                floor,
                chatLen,
                reason: committed.reason,
            });
            console.error(`[${MODULE_NAME}] commit-diff failed reason=${committed.reason} hint=${committed.hint}`);
            throw new Error(msg);
        }
    }

    const meta = await persistMetaForChatKey(context, chatKey, normalizedAfter, target);
    // Re-read materialized state so the cache reflects the post-commit shape
    // (the commit we just appended plus any sibling commits that landed in
    // between). When the replay is broken or destroyed we fall back to the
    // in-memory `afterPayload` we wrote — the commit itself landed on disk,
    // so the cache stays in sync with what users see on reload; only the
    // REPLAY_BROKEN case warrants a toast (data may be unrecoverable).
    const latestResult = await fs.get();
    let payload = afterPayload;
    if (latestResult.ok && latestResult.state && typeof latestResult.state === 'object') {
        payload = latestResult.state;
    } else if (!latestResult.ok) {
        if (latestResult.reason === STATE_ERROR_REASONS.REPLAY_BROKEN) {
            notifyError(i18n('Memory log corrupted after commit, please reload chat.'));
        }
        console.warn(`[${MODULE_NAME}] post-commit cache refresh failed (reason=${latestResult.reason}, hint=${latestResult.hint}); using in-memory afterPayload`);
    }
    const runtimeStore = buildRuntimeStoreFromGraphPayloadAndMeta(payload, meta);
    runtimeStore.lastExtractionDebug = normalizedAfter?.lastExtractionDebug && typeof normalizedAfter.lastExtractionDebug === 'object'
        ? structuredClone(normalizedAfter.lastExtractionDebug)
        : null;
    memoryStoreCache.set(chatKey, runtimeStore);

    if (syncPersistentProjection && chatKey === getChatKey(context)) {
        const effectiveSettings = getEffectiveSettings(context, getSettings());
        await syncPersistentLorebookProjection(context, effectiveSettings, runtimeStore);
    }
    return { store: runtimeStore, skipped: false, reason: null, hint: null };
}

/**
 * Sync alias kept for callsites that don't await; thin wrapper around
 * commitMemoryStoreReplaceByChatKey. Returns the promise so callers that DO
 * want to await can. `floor` is forwarded as the trigger anchor.
 */
function replacePersistedGraphWithStore(context, chatKey, store, seq, { floor = null } = {}) {
    return commitMemoryStoreReplaceByChatKey(context, chatKey, store, seq, { floor });
}

/**
 * Editor-save path: caller has a beforeStore and an afterStore and wants the
 * delta committed. Same semantics as commitMemoryStoreDiffByChatKey;
 * `floor` is forwarded as the trigger anchor. Returns the envelope from
 * commitMemoryStoreDiffByChatKey unchanged so callers can inspect
 * `.skipped` / `.reason` / `.hint` for surfacing accurate UI feedback.
 */
async function appendPersistedDiffEntry(context, chatKey, beforeStore, afterStore, seq, { floor = null } = {}) {
    return commitMemoryStoreDiffByChatKey(context, chatKey, beforeStore, afterStore, seq, { floor });
}

export async function ensureMemoryStoreLoaded(context, { force = false } = {}) {
    const target = buildMemoryTargetFromContext(context);
    if (!target) {
        return null;
    }

    const chatKey = getChatKey(context, target);
    memoryStoreTargets.set(chatKey, target);

    if (!force && memoryStoreCache.has(chatKey)) {
        return memoryStoreCache.get(chatKey);
    }
    if (!force && memoryLoadTasks.has(chatKey)) {
        return await memoryLoadTasks.get(chatKey);
    }

    const task = (async () => {
        // Schema migration runs at init/CHAT_CHANGED for current target.
        // Bring the target up to v2 before reading so loadMemoryStoreByTarget
        // always sees the current shape.
        try {
            await migrateLegacyMemoryGraphState(
                context,
                target,
                isExtractableAssistantMessage,
                applyMemoryLogEntryToStore,
            );
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Legacy schema migration failed for target`, { target, error });
        }

        const loaded = await loadMemoryStoreByTarget(context, target);

        setCachedMeta(chatKey, loaded.meta || metaFieldsFromStore(loaded.store));
        memoryStoreCache.set(chatKey, loaded.store);
        if (loaded.migrated) {
            const migrationSeq = getStoreCoveredSeqTo(loaded.store);
            await commitMemoryStoreReplaceByChatKey(
                context,
                chatKey,
                loaded.store,
                migrationSeq,
                { floor: seqToFloor(context, migrationSeq) },
            );
        }
        return memoryStoreCache.get(chatKey) || loaded.store;
    })();
    memoryLoadTasks.set(chatKey, task);

    try {
        return await task;
    } finally {
        memoryLoadTasks.delete(chatKey);
    }
}

function getMemoryStore(context) {
    const chatKey = getChatKey(context);
    return memoryStoreCache.get(chatKey) || null;
}

/**
 * Layer-1 helper: resolve the cache key the session should commit under.
 * Wraps the internal `getChatKey` so `api.js` doesn't need a private import.
 * Returns an empty string when the context has no resolvable target — the
 * commit path then no-ops, matching `commitSessionMutation`'s guard.
 */
export function resolveChatKeyForSession(context) {
    const target = buildMemoryTargetFromContext(context);
    if (!target) return '';
    return getChatKey(context, target);
}

/**
 * Layer-1 commit boundary called after a `session.X(...)` write mutation
 * lands. Mirrors the shape of the editor-save commit (`persistLatest` in
 * the popup) minus the toast / status messaging owned by the popup:
 *   1. Re-seat the (already mutated) runtime store in the cache so any
 *      subsequent `getMemoryStore` / recall path reads the latest shape.
 *   2. Drop any cached rollback frames — they're tied to UI rollback and
 *      the session-side write didn't go through that pipeline.
 *   3. Replace-mode flush to floor-state (the session owns whole-store
 *      semantics; we don't keep a diff base, and the LLM's write surface
 *      is not part of the user-facing rollback timeline).
 *   4. Persist meta + sync the persistent lorebook projection so World
 *      Info bindings reflect the new graph immediately. If the
 *      projection step fails (e.g. schema deps not wired in headless
 *      contexts), fall back to a meta-only persist so the graph store
 *      itself is still committed — projection retriggers on later
 *      lifecycle events like CHAT_CHANGED / MESSAGE_RECEIVED.
 *   5. Best-effort UI refresh — `refreshUiStats` early-returns when the
 *      popup isn't mounted, so this is safe in headless contexts.
 */
const storeCommitListeners = new Set();

/**
 * Registers a store-commit listener. The callback receives a frozen
 * `{ chatKey }` signal — re-query through the api.js Lookup API for fresh
 * data; the cached runtime store is not exposed. Returns an idempotent
 * unsubscribe function; non-function inputs return a no-op unsubscribe.
 */
export function addStoreCommitListener(cb) {
    if (typeof cb !== 'function') return () => { /* no-op for invalid input */ };
    storeCommitListeners.add(cb);
    return () => { storeCommitListeners.delete(cb); };
}

/** Matches the add/remove pair shape used by external-api.js. */
export function removeStoreCommitListener(cb) {
    return storeCommitListeners.delete(cb);
}

/**
 * Shared persistence entry for graph mutations performed outside the
 * extraction pipeline (graph inspector saves, graph-iteration studio
 * approvals). Anchors at the store's covered watermark so the commit lands
 * on the latest settled assistant floor, then syncs meta + the persistent
 * lorebook projection and notifies store-commit subscribers.
 *
 * Returns the commit envelope from the diff/replace helper unchanged
 * (`{ skipped, reason, hint }`) so callers can surface skips accurately.
 */
export async function commitGraphUiMutation(context, chatKey, {
    beforeStore = null,
    afterStore = null,
    replaceGraph = false,
    seq = null,
} = {}) {
    const key = String(chatKey || '').trim();
    const latest = afterStore;
    if (!key || !latest || typeof latest !== 'object') {
        throw new Error('commitGraphUiMutation: chatKey and afterStore are required.');
    }
    const effectiveSeq = resolveStoreCommitSeq(seq, latest);
    const floor = seqToFloor(context, effectiveSeq);
    let innerResult = { skipped: false, reason: null, hint: null };
    if (replaceGraph) {
        innerResult = await replacePersistedGraphWithStore(context, key, latest, effectiveSeq, { floor });
    } else if (beforeStore) {
        innerResult = await appendPersistedDiffEntry(context, key, beforeStore, latest, effectiveSeq, { floor });
    }
    if (innerResult?.skipped) return innerResult;
    clearRollbackHistory(key);
    try {
        await persistMemoryStoreByChatKey(context, key, latest, { syncPersistentProjection: true });
    } catch (err) {
        console.warn('[memory-graph] commitGraphUiMutation: lorebook projection sync failed, persisting graph only', err);
        await persistMemoryStoreByChatKey(context, key, latest, { syncPersistentProjection: false });
    }
    try { refreshUiStats(); } catch (_) { /* UI optional in headless / test env */ }
    emitStoreCommit(key);
    return innerResult;
}

function emitStoreCommit(chatKey) {
    if (storeCommitListeners.size === 0) return;
    // Frozen signal — re-query through the Lookup API for fresh data; the
    // cached runtime store is not exposed. Each listener is wrapped
    // individually so one throw doesn't abort iteration over the rest.
    const snapshot = Object.freeze({ chatKey: String(chatKey || '') });
    for (const cb of storeCommitListeners) {
        try {
            cb(snapshot);
        } catch (err) {
            try {
                console.warn(`[${MODULE_NAME}] store-commit listener threw:`, err);
            } catch (_) { /* logger itself failed; ignore */ }
        }
    }
}

/**
 * Incremental vector-index sync after graph-iteration approvals. Resolves
 * the effective (character-override aware) embedding profile; no profile →
 * no-op. Meta is flushed explicitly because syncVectorIndex only mutates
 * the in-memory vectorIndexState mirror.
 */
export async function syncGraphVectorsAfterMutation(context, chatKey, store) {
    const effectiveSettings = getEffectiveSettings(context, getSettings());
    const profile = resolveGraphVectorProfile(effectiveSettings, getEmbeddingProfileById);
    return await runGraphVectorSync({
        store,
        chatKey,
        settings: effectiveSettings,
        profile,
        schema: effectiveSettings.nodeTypeSchema,
        syncFn: syncVectorIndex,
        persistFn: () => persistMemoryStoreByChatKey(context, String(chatKey || ''), store, { syncPersistentProjection: false }),
    });
}

export async function commitSessionMutation(context, chatKey, beforeStore, afterStore) {
    const key = String(chatKey || '').trim();
    const store = afterStore;
    if (!key || !store || typeof store !== 'object') return;
    memoryStoreCache.set(key, store);
    clearRollbackHistory(key);

    const anchor = resolveInFlightAnchor(context);
    if (anchor !== null) {
        // Diff-mode: append one incremental commit at the in-flight floor.
        // anchor.floor is the chat-tail slot the director's write belongs
        // to. Passing it explicitly anchors the commit at that exact slot
        // even when the tail is an empty assistant placeholder (director
        // tool calls can fire before streaming has produced any text), and
        // satisfies commitMemoryStoreDiffByChatKey's required `floor` arg.
        await commitMemoryStoreDiffByChatKey(
            context, key, beforeStore || store, store, anchor.turnSeq,
            { syncPersistentProjection: false, floor: anchor.floor },
        );
    } else {
        // Legacy replace-flush for callers without an in-flight chat tail
        // (e.g. test fixtures, future non-orchestrator session consumers).
        const seq = getStoreCoveredSeqTo(store);
        await replacePersistedGraphWithStore(context, key, store, seq, { floor: seqToFloor(context, seq) });
    }

    try {
        await persistMemoryStoreByChatKey(context, key, store, { syncPersistentProjection: true });
    } catch (err) {
        console.warn('[memory-graph] commitSessionMutation: lorebook projection sync failed, persisting graph only', err);
        await persistMemoryStoreByChatKey(context, key, store, { syncPersistentProjection: false });
    }
    try { refreshUiStats(); } catch (_) { /* UI optional in headless / test env */ }
    emitStoreCommit(key);
}

/**
 * Persist meta-only updates (sourceMessageCount, lastRecallTrace,
 * lastRecallProjection) without touching the floor-state log. Used after
 * non-graph-mutating store updates (e.g. updateStoreSourceState in the
 * mutation invalidation path, editor save's metadata refresh).
 */
async function persistMemoryStoreByChatKey(context, chatKey, store, { syncPersistentProjection = false } = {}) {
    const target = memoryStoreTargets.get(chatKey);
    if (!target) {
        return;
    }
    if (typeof context.updateChatState !== 'function') {
        throw new Error('Chat state update API is unavailable in extension context.');
    }
    const nextStore = normalizeStoreForRuntime(store);
    nextStore.lastExtractionDebug = store?.lastExtractionDebug && typeof store.lastExtractionDebug === 'object'
        ? structuredClone(store.lastExtractionDebug)
        : null;
    memoryStoreCache.set(chatKey, nextStore);
    await persistMetaForChatKey(context, chatKey, nextStore, target);
    if (syncPersistentProjection && chatKey === getChatKey(context)) {
        const effectiveSettings = getEffectiveSettings(context, getSettings());
        await syncPersistentLorebookProjection(context, effectiveSettings, nextStore);
    }
}

async function persistRecallMetadataByChatKey(context, chatKey, { trace, projection } = {}) {
    const target = memoryStoreTargets.get(chatKey);
    if (!target) {
        return;
    }
    if (typeof context.updateChatState !== 'function') {
        throw new Error('Chat state update API is unavailable in extension context.');
    }
    const cached = getCachedMeta(chatKey) || {};
    // Preserve vectorIndexState across recall meta writes. This function is
    // called at the end of every recall (both LLM and RAG paths); using a
    // trimmed meta shape here silently drops vectorIndexState from the
    // sidecar, so the next refreshMemoryStoreCacheFromFloorState reloads
    // an empty vector state and syncVectorIndex's configChanged branch
    // wipes the backend collection and re-embeds every node. Prefer the
    // live store's vectorIndexState (freshest — extraction/sync writes to
    // it in place); fall back to the cached meta copy when the store hasn't
    // been through a sync yet.
    const liveStore = memoryStoreCache.get(chatKey);
    const preservedVectorIndexState = normalizeVectorIndexState(
        liveStore?.vectorIndexState || cached?.vectorIndexState || null,
    );
    const nextMeta = {
        schemaVersion: META_SCHEMA_VERSION,
        sourceMessageCount: Math.max(0, Number(cached.sourceMessageCount || 0)),
        lastRecallTrace: structuredClone(Array.isArray(trace) ? trace : []),
        lastRecallProjection: projection && typeof projection === 'object'
            ? structuredClone(projection)
            : null,
        vectorIndexState: preservedVectorIndexState,
    };
    setCachedMeta(chatKey, nextMeta);
    const result = await persistMetaFields(context, nextMeta, target);
    if (!result?.ok) {
        if (result?.reason === STATE_ERROR_REASONS.VALIDATION_TARGET) {
            console.warn(`[${MODULE_NAME}] recall meta persist skipped: ${result.hint}`);
            return { ok: false, reason: result.reason };
        }
        throw new Error(`[${MODULE_NAME}] recall meta persist failed (${result?.reason}): ${result?.hint}`);
    }
    const store = memoryStoreCache.get(chatKey);
    if (store) {
        store.lastRecallTrace = structuredClone(nextMeta.lastRecallTrace);
        store.lastRecallProjection = nextMeta.lastRecallProjection
            ? structuredClone(nextMeta.lastRecallProjection)
            : null;
    }
    return { ok: true };
}

/**
 * Branch inheritance: floor-state's own CHAT_BRANCH_CREATED handler copies
 * the commit log to the target sidecar, so the graph itself is already
 * inherited. We only need to seed the new chat's `__meta` with reset values
 * and clear runtime caches that might have been populated speculatively.
 */
async function inheritMemoryStoreForBranch(context, payload) {
    const sourceTarget = normalizeExplicitChatStateTarget(payload?.sourceTarget);
    const targetTarget = normalizeExplicitChatStateTarget(payload?.targetTarget);
    if (!sourceTarget || !targetTarget) {
        return;
    }
    const assistantMessageCount = Math.max(0, Math.floor(Number(payload?.assistantMessageCount || 0)));
    const targetChatKey = getChatKey(context, targetTarget);
    if (!targetChatKey || targetChatKey === 'invalid_target') {
        return;
    }
    memoryStoreTargets.set(targetChatKey, targetTarget);
    memoryLoadTasks.delete(targetChatKey);
    memoryStoreCache.delete(targetChatKey);
    clearCachedMeta(targetChatKey);
    clearRollbackHistory(targetChatKey);
    if (extractionTimers.has(targetChatKey)) {
        clearTimeout(extractionTimers.get(targetChatKey));
        extractionTimers.delete(targetChatKey);
    }

    const branchMeta = {
        schemaVersion: META_SCHEMA_VERSION,
        sourceMessageCount: assistantMessageCount,
        lastRecallTrace: [],
        lastRecallProjection: null,
        // vectorIndexState is intentionally NOT inherited from the source.
        // The collectionId in buildCollectionId() is chat-id-scoped, so the
        // branch chat's backend vector collection starts empty regardless
        // of what the source had embedded. Copying source.nodeToHash here
        // would map node ids to hashes the branch backend doesn't hold —
        // a phantom-indexed state that makes subsequent hybrid recall
        // think nodes are indexed when they aren't. The empty state lets
        // ensureVectorIndexState lazy-init on first hybrid-recall call,
        // which goes through the configChanged-purge branch in
        // syncVectorIndex and produces a fresh state that matches the
        // (also empty) backend collection. LLM-recall users are
        // unaffected because that path never touches vectorIndexState.
        vectorIndexState: null,
    };
    setCachedMeta(targetChatKey, branchMeta);
    if (typeof context.updateChatState === 'function') {
        const result = await context.updateChatState(
            META_NAMESPACE,
            () => branchMeta,
            { target: targetTarget, maxOperations: 16000 },
        );
        if (result && result.ok === false) {
            // Seed write failed — branch chat's __meta will be missing
            // sourceMessageCount and the next ensureMemoryStoreLoaded will
            // synthesize a default. We log so the dev surface still shows
            // the failure (the user can't act on it directly).
            console.warn(`[${MODULE_NAME}] branch meta seed failed (reason=${result.reason}, hint=${result.hint})`);
        }
    }
}

function tryParseJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) {
        return null;
    }
    const stripFence = (input) => input.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const candidates = [raw, stripFence(raw)];
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        if ((candidate.startsWith('{') && candidate.endsWith('}')) || (candidate.startsWith('[') && candidate.endsWith(']'))) {
            try {
                const parsed = JSON.parse(candidate);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed;
                }
            } catch {
                // ignore and continue
            }
        }
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                const parsed = JSON.parse(candidate.slice(start, end + 1));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed;
                }
            } catch {
                // ignore and continue
            }
        }
    }
    return null;
}

function toDisplayScalar(value) {
    if (value === null || value === undefined) {
        return '';
    }
    if (Array.isArray(value)) {
        return value.map(item => normalizeText(typeof item === 'string' ? item : JSON.stringify(item))).filter(Boolean).join(', ');
    }
    if (typeof value === 'object') {
        return normalizeText(JSON.stringify(value));
    }
    return normalizeText(String(value));
}

function getNodeSummary(node) {
    if (!node || typeof node !== 'object') {
        return '';
    }
    const fields = node.fields && typeof node.fields === 'object' && !Array.isArray(node.fields)
        ? node.fields
        : {};
    if (fields.summary !== undefined && fields.summary !== null) {
        return normalizeText(toDisplayScalar(fields.summary));
    }
    return '';
}


function setNodeSummary(node, summaryText) {
    if (!node || typeof node !== 'object') {
        return;
    }
    const fields = ensureNodeFieldsObject(node);
    const normalized = normalizeText(summaryText);
    if (normalized) {
        fields.summary = normalized;
    } else {
        delete fields.summary;
    }
    if (Object.prototype.hasOwnProperty.call(node, 'summary')) {
        delete node.summary;
    }
}

function getStructuredNodeFields(node) {
    const fields = {};
    const mergeObject = (obj) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            return;
        }
        Object.assign(fields, obj);
        if (obj.fields && typeof obj.fields === 'object' && !Array.isArray(obj.fields)) {
            Object.assign(fields, obj.fields);
        }
    };
    mergeObject(node?.fields);
    mergeObject(tryParseJsonObject(node?.fields));
    mergeObject(tryParseJsonObject(getNodeSummary(node)));
    return fields;
}

function findValueByKeyDeep(value, targetKey, depth = 0) {
    if (!value || depth > 5) {
        return undefined;
    }
    const key = String(targetKey || '').trim().toLowerCase();
    if (!key) {
        return undefined;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const hit = findValueByKeyDeep(item, key, depth + 1);
            if (hit !== undefined) {
                return hit;
            }
        }
        return undefined;
    }
    if (typeof value !== 'object') {
        return undefined;
    }
    for (const [entryKey, entryValue] of Object.entries(value)) {
        if (String(entryKey || '').trim().toLowerCase() === key) {
            return entryValue;
        }
    }
    for (const entryValue of Object.values(value)) {
        const hit = findValueByKeyDeep(entryValue, key, depth + 1);
        if (hit !== undefined) {
            return hit;
        }
    }
    return undefined;
}

function getAssistantChatMessages(sourceOrContext) {
    const source = Array.isArray(sourceOrContext)
        ? sourceOrContext
        : (Array.isArray(sourceOrContext?.chat) ? sourceOrContext.chat : []);
    const result = [];
    let lastUser = null;
    for (let i = 0; i < source.length; i += 1) {
        const message = source[i];
        if (!message) {
            continue;
        }
        if (message.is_user) {
            lastUser = {
                name: String(message.name || ''),
                mes: String(message.mes || ''),
                send_date: String(message.send_date || ''),
                source_index: i,
            };
            continue;
        }
        if (!isExtractableAssistantMessage(message)) {
            continue;
        }
        const text = normalizeText(message?.mes || '');
        result.push({
            is_user: false,
            name: String(message.name || ''),
            mes: text,
            send_date: String(message.send_date || ''),
            source_index: i,
            last_user_name: String(lastUser?.name || ''),
            last_user_mes: String(lastUser?.mes || ''),
            last_user_send_date: String(lastUser?.send_date || ''),
            last_user_source_index: typeof lastUser?.source_index === 'number' ? lastUser.source_index : -1,
        });
    }
    return result;
}

function computeChatSourceStateFromMessages(messages) {
    const source = getAssistantChatMessages(messages);
    let count = 0;
    for (let i = 0; i < source.length; i += 1) {
        count += 1;
    }
    return {
        messageCount: count,
    };
}

function computeChatSourceState(context) {
    const source = Array.isArray(context?.chat) ? context.chat : [];
    return computeChatSourceStateFromMessages(source);
}

function updateStoreSourceState(store, context) {
    const source = computeChatSourceState(context);
    store.sourceMessageCount = Number(source.messageCount || 0);
}

function getRollbackHistory(chatKey) {
    const key = String(chatKey || '').trim();
    if (!key) {
        return [];
    }
    if (!rollbackHistoryCache.has(key)) {
        rollbackHistoryCache.set(key, []);
    }
    return rollbackHistoryCache.get(key);
}

function clearRollbackHistory(chatKey) {
    const key = String(chatKey || '').trim();
    if (!key) {
        return;
    }
    rollbackHistoryCache.delete(key);
}

function trimRollbackHistoryFromSeq(chatKey, fromSeq) {
    const key = String(chatKey || '').trim();
    const startSeq = Math.max(1, Math.floor(Number(fromSeq || 0)));
    if (!key || !Number.isFinite(startSeq) || startSeq <= 0) {
        return;
    }
    const history = rollbackHistoryCache.get(key);
    if (!Array.isArray(history) || history.length === 0) {
        return;
    }
    const nextHistory = history.filter(entry => Math.max(0, Math.floor(Number(entry?.seqTo || 0))) < startSeq);
    if (nextHistory.length > 0) {
        rollbackHistoryCache.set(key, nextHistory);
    } else {
        rollbackHistoryCache.delete(key);
    }
}

function captureRollbackSnapshot(store) {
    const nodes = {};
    for (const [id, node] of Object.entries(store?.nodes || {})) {
        const snapshot = cloneRollbackNodeSnapshot(node);
        if (snapshot) {
            nodes[String(id || '').trim()] = snapshot;
        }
    }
    return {
        nodeSeq: Math.max(0, Math.floor(Number(store?.nodeSeq || 0))),
        seqCounter: Math.max(0, Math.floor(Number(store?.seqCounter || 0))),
        appliedSeqTo: Math.max(0, Math.floor(Number(store?.appliedSeqTo || 0))),
        loggedSeqTo: Math.max(0, Math.floor(Number(store?.loggedSeqTo || 0))),
        nodes,
        edges: Array.isArray(store?.edges)
            ? store.edges.map(cloneRollbackEdgeSnapshot).filter(Boolean)
            : [],
    };
}

function restoreStoreFromRollbackSnapshot(store, snapshot) {
    if (!store || typeof store !== 'object' || !snapshot || typeof snapshot !== 'object') {
        return;
    }
    store.nodeSeq = Math.max(0, Math.floor(Number(snapshot.nodeSeq || 0)));
    store.seqCounter = Math.max(0, Math.floor(Number(snapshot.seqCounter || 0)));
    store.appliedSeqTo = Math.max(0, Math.floor(Number(snapshot.appliedSeqTo || 0)));
    store.loggedSeqTo = Math.max(0, Math.floor(Number(snapshot.loggedSeqTo || snapshot.appliedSeqTo || 0)));
    store.nodes = {};
    for (const [id, node] of Object.entries(snapshot.nodes || {})) {
        const restored = cloneRollbackNodeSnapshot(node);
        if (restored) {
            store.nodes[String(id || '').trim()] = restored;
        }
    }
    store.edges = Array.isArray(snapshot.edges)
        ? snapshot.edges.map(cloneRollbackEdgeSnapshot).filter(Boolean)
        : [];
    repairStoreAfterRollback(store);
}

function buildRollbackEntry(chatKey, { seqTo = 0, kind = 'extract' } = {}) {
    const key = String(chatKey || '').trim();
    if (!key) {
        return null;
    }
    return {
        kind: String(kind || 'extract'),
        seqTo: Math.max(1, Math.floor(Number(seqTo || 0))),
    };
}

function recordRollbackEntry(chatKey, entry) {
    const key = String(chatKey || '').trim();
    if (!key || !entry || typeof entry !== 'object') {
        return;
    }
    getRollbackHistory(key).push(entry);
}

function findAssistantSeqFromPlayableSeq(context, playableSeqFrom) {
    const targetPlayableSeq = Math.max(1, Math.floor(Number(playableSeqFrom || 0)));
    if (!Number.isFinite(targetPlayableSeq) || targetPlayableSeq <= 0) {
        return null;
    }
    const source = Array.isArray(context?.chat) ? context.chat : [];
    let playableSeq = 0;
    let assistantSeq = 0;
    for (const message of source) {
        if (!message) {
            continue;
        }
        // playable rank still tracks SillyTavern's prompt-visible view (hidden
        // messages excluded), to stay aligned with `mutationMeta.*PlayableSeq`
        // values supplied by core. Extractable rank is hide-independent so
        // stored node seqs don't drift on /hide.
        if (!message.is_system) {
            playableSeq += 1;
        }
        if (!isExtractableAssistantMessage(message)) {
            continue;
        }
        assistantSeq += 1;
        if (playableSeq >= targetPlayableSeq) {
            return assistantSeq;
        }
    }
    return null;
}

export function findAffectedAssistantSeqFromMessageIndex(context, messageIndex) {
    const targetIndex = Math.max(0, Math.floor(Number(messageIndex || 0)));
    if (!Number.isFinite(targetIndex) || targetIndex < 0) {
        return null;
    }
    const source = Array.isArray(context?.chat) ? context.chat : [];
    let assistantSeq = 0;
    for (let i = 0; i < source.length; i++) {
        const message = source[i];
        if (!isExtractableAssistantMessage(message)) {
            continue;
        }
        assistantSeq += 1;
        if (i >= targetIndex) {
            return assistantSeq;
        }
    }
    // Extractable-walk miss on an assistant-role target: the slot's body was
    // wiped before MESSAGE_SWIPED fired (overswipe REGENERATE clears
    // chat[mesId].mes before animateSwipe emits), so the walk above skips it
    // and would return null — which applyMutationInvalidationImpl feeds to
    // shouldPreserveLatestRecallSnapshotForAssistantMutation as fromSeq=null,
    // killing the recall snapshot and forcing a fresh RAG recall on every
    // swipe retry. Fall back to role-based counting (!is_user && !is_system),
    // the same coordinate system buildLastUserAnchorFromMessages uses for
    // anchorAssistantFloor, so the preserve check compares like with like.
    const target = source[targetIndex];
    if (target && !target.is_user && !target.is_system) {
        let roleAssistantSeq = 0;
        for (let i = 0; i <= targetIndex && i < source.length; i++) {
            const message = source[i];
            if (message && !message.is_user && !message.is_system) {
                roleAssistantSeq += 1;
            }
        }
        return roleAssistantSeq;
    }
    return null;
}

function getNodeTypeSchemaMap(settings, context = null) {
    const map = new Map();
    for (const entry of getEffectiveNodeTypeSchema(context, settings)) {
        map.set(String(entry.id || '').toLowerCase(), entry);
    }
    return map;
}

// Build the { perTypeK, defaultPerTypeK } pair that runRagRecall consumes to
// bucket vector hits by node type. Each schema spec may set `ragPerTypeK`
// to override the global default for that type; unset (null) means "use the
// global default", so old schemas keep working without any migration.
//
// When ragDefaultPerTypeK is 0 (bucketing disabled) AND no schema entry
// overrides it, we return { perTypeK: null, defaultPerTypeK: null }, which
// tells runRagRecall to run the legacy single-pool path.
function buildRagPerTypeQuotas(context, settings) {
    const schema = getEffectiveNodeTypeSchema(context, settings);
    const perTypeK = {};
    let anyOverride = false;
    for (const entry of schema) {
        const id = String(entry?.id || '').trim().toLowerCase();
        if (!id) continue;
        // Only positive values are overrides. 0 (the default and the value
        // users leave when they don't care) means "follow the global".
        const override = Number(entry?.ragPerTypeK);
        if (Number.isFinite(override) && override > 0) {
            perTypeK[id] = Math.floor(override);
            anyOverride = true;
        }
    }
    const rawDefault = Number(settings?.ragDefaultPerTypeK);
    const defaultPerTypeK = Number.isFinite(rawDefault) && rawDefault > 0
        ? Math.floor(rawDefault)
        : null;
    if (!anyOverride && defaultPerTypeK === null) {
        return { perTypeK: null, defaultPerTypeK: null };
    }
    return {
        perTypeK: anyOverride ? perTypeK : null,
        defaultPerTypeK,
    };
}

export function getSemanticTypeSpec(settings, type, context = null) {
    const map = getNodeTypeSchemaMap(settings, context);
    return map.get(String(type || '').toLowerCase()) || null;
}

export function getSemanticCompressionConfig(settings, type, context = null) {
    const spec = getSemanticTypeSpec(settings, type, context);
    const raw = spec?.compression && typeof spec.compression === 'object' ? spec.compression : {};
    const mode = ['none', 'hierarchical'].includes(String(raw.mode || '').toLowerCase())
        ? String(raw.mode).toLowerCase()
        : 'none';
    return {
        mode,
        threshold: Math.max(2, Number(raw.threshold) || 6),
        fanIn: Math.max(2, Number(raw.fanIn) || 3),
        maxDepth: Math.max(1, Number(raw.maxDepth) || 6),
        keepRecentLeaves: Math.max(0, Number(raw.keepRecentLeaves) || 0),
        rule: String(raw.rule || '').trim(),
        summarizeInstruction: String(raw.summarizeInstruction || '').trim(),
        label: String(spec?.label || type || 'Semantic'),
    };
}

function getSemanticLatestOnlyConfig(settings, type, context = null) {
    const spec = getSemanticTypeSpec(settings, type, context);
    return {
        enabled: Boolean(spec?.latestOnly),
        keyFields: Array.isArray(spec?.primaryKeyColumns)
            ? spec.primaryKeyColumns.map(column => String(column || '').trim()).filter(Boolean)
            : [],
    };
}

function nextNodeId(store) {
    store.nodeSeq = Number(store.nodeSeq || 0) + 1;
    return `n_${store.nodeSeq}`;
}

export function createNode(store, node) {
    const id = nextNodeId(store);
    const seqToRaw = Number.isFinite(Number(node.seqTo))
        ? Number(node.seqTo)
        : Number.isFinite(Number(node.seq))
            ? Number(node.seq)
            : Number(store.seqCounter || 0);
    const seqTo = Number.isFinite(seqToRaw) ? Math.max(0, Math.floor(seqToRaw)) : Number(store.seqCounter || 0);
    store.seqCounter = Math.max(Number(store.seqCounter || 0), Number.isFinite(seqTo) ? seqTo : 0);
    store.nodes[id] = {
        id,
        type: String(node.type || 'unknown'),
        level: String(node.level || LEVEL.SEMANTIC),
        title: normalizeText(node.title || id),
        parentId: node.parentId ? String(node.parentId) : '',
        childrenIds: [],
        fields: node.fields && typeof node.fields === 'object' && !Array.isArray(node.fields) ? node.fields : {},
        semanticDepth: Number.isFinite(Number(node.semanticDepth)) ? Number(node.semanticDepth) : 0,
        semanticRollup: Boolean(node.semanticRollup),
        seqTo: Number.isFinite(seqTo) ? seqTo : undefined,
        archived: Boolean(node.archived),
    };
    setNodeSummary(store.nodes[id], node?.fields?.summary ?? '');

    const rawFloorRange = node?.floorRange;
    if (rawFloorRange && typeof rawFloorRange === 'object') {
        const rs = rawFloorRange.start;
        const re = rawFloorRange.end;
        if (typeof rs === 'number' && typeof re === 'number'
            && Number.isFinite(rs) && Number.isFinite(re)
            && rs >= 0 && re >= rs) {
            store.nodes[id].floorRange = {
                start: Math.floor(rs),
                end: Math.floor(re),
            };
        }
    }

    if (store.nodes[id].parentId && store.nodes[store.nodes[id].parentId]) {
        const parent = store.nodes[store.nodes[id].parentId];
        if (!parent.childrenIds.includes(id)) {
            parent.childrenIds.push(id);
        }
        addEdge(store, parent.id, id, 'contains');
    }

    return store.nodes[id];
}

export { createNode as _createNodeForTest };
export { createRollupWithChildren as _createRollupWithChildrenForTest };

function listNodesByLevel(store, level) {
    return Object.values(store.nodes)
        .filter(node => node.level === level)
        .sort((a, b) => {
            if (a.level === LEVEL.SEMANTIC && b.level === LEVEL.SEMANTIC) {
                const depthDiff = Number(b.semanticDepth ?? 0) - Number(a.semanticDepth ?? 0);
                if (depthDiff !== 0) return depthDiff;
            }
            const seqDiff = Number(a.seqTo ?? 0) - Number(b.seqTo ?? 0);
            if (seqDiff !== 0) return seqDiff;
            return String(a.id || '').localeCompare(String(b.id || ''));
        });
}

export function getChildren(store, nodeId) {
    const node = store.nodes[nodeId];
    if (!node || !Array.isArray(node.childrenIds)) {
        return [];
    }
    return node.childrenIds.map(id => store.nodes[id]).filter(child => Boolean(child) && !child.archived);
}

export function archiveNode(store, oldId, replacementId = null) {
    const node = store.nodes[oldId];
    if (!node) {
        return;
    }
    node.archived = true;

    if (!replacementId || replacementId === oldId || !store.nodes[replacementId]) {
        return;
    }

    let finalTarget = replacementId;
    const visited = new Set([oldId]);
    while (!visited.has(finalTarget)) {
        visited.add(finalTarget);
        const next = store.nodes[finalTarget]?.supersededBy;
        if (!next || !store.nodes[next] || next === finalTarget) {
            break;
        }
        finalTarget = next;
    }
    node.supersededBy = finalTarget;

    if (!Array.isArray(store.edges)) {
        return;
    }
    const seen = new Set();
    const next = [];
    for (const edge of store.edges) {
        if (!edge) {
            continue;
        }
        const fromHit = edge.from === oldId;
        const toHit = edge.to === oldId;
        const newFrom = fromHit ? finalTarget : edge.from;
        const newTo = toHit ? finalTarget : edge.to;
        if (newFrom === newTo) {
            continue;
        }
        const key = `${newFrom}␟${edge.type}␟${newTo}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        if (fromHit || toHit) {
            next.push({ ...edge, from: newFrom, to: newTo });
        } else {
            next.push(edge);
        }
    }
    store.edges = next;
}

function summarizeTextHeuristic(lines) {
    return lines
        .map(line => normalizeText(line))
        .filter(Boolean)
        .join('\n');
}

function buildCompressionSummaryInstruction(baseInstruction, options = {}) {
    const base = normalizeText(baseInstruction || '');
    const defaultInstruction = 'Compress semantic nodes into concise higher-level memory while preserving stage-shifting facts.';
    const instruction = base || defaultInstruction;
    const fanIn = Math.max(2, Math.floor(Number(options?.fanIn) || 2));
    const depth = Math.max(1, Math.floor(Number(options?.depth) || 1));
    const childDepth = depth - 1;
    const childDepthDesc = childDepth === 0
        ? 'leaf events (direct from dialogue)'
        : `depth-${childDepth} rollup events`;
    return [
        instruction,
        '',
        `Compression context (HARD, from code — do not infer): rollup_depth=${depth}, children=${fanIn} (each child is a ${childDepthDesc}). Apply the depth-${depth} rules from the writing standard above. KEEP ≤ 3 hard bound applies regardless of fanIn; total chars ≤ 60 + 50 × (KEEP count).`,
        'Never copy-paste or concatenate child summaries — re-synthesize. Do not continue story or predict future events.',
    ].join('\n');
}

function getCompressionColumnNames(spec) {
    const columns = Array.isArray(spec?.tableColumns)
        ? spec.tableColumns.map(column => String(column || '').trim().toLowerCase()).filter(Boolean)
        : [];
    const deduped = Array.from(new Set(columns));
    if (!deduped.includes('summary')) {
        deduped.unshift('summary');
    }
    return deduped;
}

function rewriteDepthWorldInfoToAfter(payload = {}) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }
    const depthEntries = Array.isArray(payload.worldInfoDepth) ? payload.worldInfoDepth : [];
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

    payload.worldInfoDepth = [];
    if (blocks.length === 0) {
        return payload;
    }

    appendUniqueWorldInfoEntries(payload, 'worldInfoAfter', blocks);
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

async function resolveMemoryGraphWorldInfo(context, settings, {
    worldInfoMessages = null,
    runtimeWorldInfo = null,
    forceWorldInfoResimulate = false,
    worldInfoType = 'quiet',
    abortSignal = null,
    recallRunToken = 0,
} = {}) {
    const includeWorldInfoWithPreset = settings?.includeWorldInfoWithPreset !== false;
    if (!includeWorldInfoWithPreset) {
        return {};
    }
    if (!forceWorldInfoResimulate && hasEffectiveRuntimeWorldInfo(runtimeWorldInfo)) {
        return normalizeRuntimeWorldInfo(runtimeWorldInfo);
    }
    if (!Array.isArray(worldInfoMessages) || worldInfoMessages.length === 0 || typeof context?.resolveWorldInfoForMessages !== 'function') {
        return {};
    }
    throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
    const resolved = await context.resolveWorldInfoForMessages(worldInfoMessages, {
        type: String(worldInfoType || 'quiet'),
        fallbackToCurrentChat: false,
        postActivationHook: rewriteDepthWorldInfoToAfter,
    });
    throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
    return normalizeRuntimeWorldInfo(resolved);
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
        outletEntries: payload?.outletEntries && typeof payload.outletEntries === 'object' ? payload.outletEntries : {},
        worldInfoExamples: Array.isArray(payload?.worldInfoExamples) ? payload.worldInfoExamples : [],
        anBefore: Array.isArray(payload?.anBefore) ? payload.anBefore : [],
        anAfter: Array.isArray(payload?.anAfter) ? payload.anAfter : [],
    });
    const rewritten = normalizeRuntimeWorldInfo(rewriteDepthWorldInfoToAfter({
        ...candidate,
        worldInfoDepth: Array.isArray(candidate.worldInfoDepth)
            ? candidate.worldInfoDepth.map(entry => ({
                ...entry,
                entries: Array.isArray(entry?.entries) ? entry.entries.slice() : [],
            }))
            : [],
    }));
    return hasEffectiveRuntimeWorldInfo(rewritten) ? rewritten : null;
}

async function summarizeTextWithLLM(context, settings, instruction, lines, abortSignal = null) {
    const joined = summarizeTextHeuristic(lines);
    if (!joined) {
        return '';
    }

    try {
        const result = await runFunctionCallTask(context, settings, {
            systemPrompt: instruction,
            userPrompt: joined,
            apiPresetName: settings.extractApiPresetName || '',
            promptPresetName: settings.extractPresetName || '',
            functionName: 'luker_rpg_summary',
            functionDescription: 'Return compressed memory summary text.',
            parameters: {
                type: 'object',
                properties: {
                    summary: { type: 'string' },
                },
                required: ['summary'],
                additionalProperties: false,
            },
            abortSignal,
            allowPreamble: true,
        });
        return normalizeText(result?.summary || '');
    } catch (error) {
        console.warn(`[${MODULE_NAME}] LLM summary failed`, error);
        return '';
    }
}

async function summarizeRollupFieldsWithLLM(context, settings, spec, instruction, group, abortSignal = null) {
    const columns = getCompressionColumnNames(spec);
    const rows = (Array.isArray(group) ? group : []).map((node) => {
        const row = {
            id: String(node?.id || ''),
            title: String(node?.title || ''),
            seq_to: String(node?.seqTo ?? ''),
        };
        for (const column of columns) {
            row[column] = getTableCellValueFromNode(node, column);
        }
        return row;
    });
    if (rows.length === 0) {
        return {};
    }
    const properties = {};
    for (const column of columns) {
        properties[column] = { type: 'string' };
    }
    const userPrompt = rows.map(row => JSON.stringify(row)).join('\n');
    try {
        const result = await runFunctionCallTask(context, settings, {
            systemPrompt: [
                instruction,
                'Return only compressed rollup fields.',
                'Keep each field concise and high-signal.',
                'Do not continue story.',
            ].join('\n'),
            userPrompt,
            apiPresetName: settings.extractApiPresetName || '',
            promptPresetName: settings.extractPresetName || '',
            functionName: 'luker_rpg_summary_fields',
            functionDescription: 'Return compressed rollup fields for the higher-level memory node.',
            parameters: {
                type: 'object',
                properties,
                required: ['summary'],
                additionalProperties: false,
            },
            abortSignal,
            allowPreamble: true,
        });
        const out = {};
        for (const column of columns) {
            const normalized = normalizeText(result?.[column] ?? '');
            if (normalized) {
                out[column] = normalized;
            }
        }
        return out;
    } catch (error) {
        console.warn(`[${MODULE_NAME}] LLM rollup fields failed`, error);
        return {};
    }
}

function isAbortSignalLike(value) {
    return Boolean(value && typeof value === 'object' && 'aborted' in value);
}

function isAbortError(error, abortSignal = null) {
    if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
        return true;
    }
    const name = String(error?.name || '').toLowerCase();
    if (name === 'aborterror') {
        return true;
    }
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('aborted') || message.includes('abort');
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

function throwIfAborted(abortSignal, message = 'Operation aborted.') {
    if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
        throw createAbortError(message);
    }
}

function throwIfRecallRunInvalid(runToken, abortSignal, message = 'Memory recall aborted.') {
    throwIfAborted(abortSignal, message);
    const normalizedRunToken = Number(runToken);
    if (Number.isFinite(normalizedRunToken) && normalizedRunToken > 0 && normalizedRunToken !== activeRecallRunToken) {
        throw createAbortError(message);
    }
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

function createLinkedAbortController(...signals) {
    const validSignals = signals.filter(isAbortSignalLike);
    const controller = new AbortController();
    if (validSignals.length === 0) {
        return {
            controller,
            signal: controller.signal,
            cleanup: () => {},
        };
    }

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
        controller,
        signal: controller.signal,
        cleanup: () => {
            for (const signal of validSignals) {
                signal.removeEventListener('abort', onAbort);
            }
        },
    };
}

function registerActiveRecallRequest(runToken, controller) {
    const normalizedRunToken = Number(runToken);
    if (!Number.isFinite(normalizedRunToken) || normalizedRunToken <= 0 || !controller) {
        return null;
    }

    let resolveSettled = null;
    const settledPromise = new Promise((resolve) => {
        resolveSettled = resolve;
    });
    const state = {
        id: ++nextActiveRecallRequestId,
        runToken: normalizedRunToken,
        controller,
        settledPromise,
        settled: false,
        resolveSettled: typeof resolveSettled === 'function' ? resolveSettled : (() => {}),
    };
    activeRecallRequestStates.set(state.id, state);
    return state;
}

function finishActiveRecallRequest(state) {
    if (!state || typeof state !== 'object' || state.settled) {
        return;
    }
    state.settled = true;
    state.resolveSettled();
    activeRecallRequestStates.delete(state.id);
}

async function abortActiveRecallRequests(runToken, timeoutMs = 400) {
    const normalizedRunToken = Number(runToken);
    if (!Number.isFinite(normalizedRunToken) || normalizedRunToken <= 0) {
        return;
    }
    const requests = Array.from(activeRecallRequestStates.values())
        .filter(state => Number(state?.runToken || 0) === normalizedRunToken);
    if (requests.length === 0) {
        return;
    }

    for (const state of requests) {
        if (!state?.controller?.signal?.aborted) {
            state.controller.abort();
        }
    }

    const waitForSettlement = Promise.allSettled(requests.map(state => state.settledPromise));
    const numericTimeout = Number(timeoutMs);
    if (!Number.isFinite(numericTimeout) || numericTimeout <= 0) {
        await waitForSettlement;
        return;
    }

    await Promise.race([
        waitForSettlement,
        new Promise((resolve) => setTimeout(resolve, numericTimeout)),
    ]);
}

const _rpmTimestamps = [];

async function waitForRpmSlot(settings, abortSignal = null) {
    const limit = Math.max(0, Math.floor(Number(settings?.rpmLimit) || 0));
    if (limit <= 0) return;
    const windowMs = 60_000;
    const pollMs = 200;
    while (true) {
        if (isAbortSignalLike(abortSignal) && abortSignal.aborted) return;
        const now = Date.now();
        while (_rpmTimestamps.length > 0 && _rpmTimestamps[0] <= now - windowMs) {
            _rpmTimestamps.shift();
        }
        if (_rpmTimestamps.length < limit) {
            _rpmTimestamps.push(now);
            return;
        }
        const waitUntil = _rpmTimestamps[0] + windowMs;
        const delay = Math.min(pollMs, Math.max(10, waitUntil - now));
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}

/**
 * Tag an error thrown while parsing / validating the model's tool calls, so
 * retry toasts can describe it as an unusable-output retry rather than a
 * request failure. Transport errors stay untagged and read as request
 * failures.
 */
function markToolCallValidationError(error) {
    if (error && typeof error === 'object') {
        try { error.__toolCallValidation = true; } catch { /* frozen error */ }
    }
    return error;
}

async function requestSingleFunctionCallWithRetry(context, settings, {
    taskMessages = [],
    runtimeWorldInfo = null,
    apiPresetName = '',
    llmPresetName = '',
    functionName = '',
    functionDescription = '',
    parameters = {},
    abortSignal = null,
    recallRunToken = 0,
    allowPreamble = false,
    retriesOverride = null,
} = {}) {
    const fnName = String(functionName || '').trim();
    if (!fnName) {
        throw new Error('Function name is required.');
    }
    if (!context || typeof context.generateTask !== 'function') {
        throw new Error('context.generateTask is unavailable.');
    }

    const retriesSource = retriesOverride === null || retriesOverride === undefined
        ? Number(settings?.toolCallRetryMax)
        : Number(retriesOverride);
    const retries = Math.max(0, Math.min(10, Math.floor(retriesSource || 0)));
    const tools = [{
        type: 'function',
        function: {
            name: fnName,
            description: String(functionDescription || `Function output for ${fnName}`),
            parameters: parameters && typeof parameters === 'object' ? parameters : { type: 'object', additionalProperties: true },
        },
    }];
    const toolChoice = allowPreamble
        ? 'auto'
        : { type: 'function', function: { name: fnName } };
    const functionCallOptions = {
        protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
    };
    if (!allowPreamble) {
        functionCallOptions.requiredFunctionName = fnName;
    }
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const requestController = createLinkedAbortController(isAbortSignalLike(abortSignal) ? abortSignal : null);
        const activeRequestState = registerActiveRecallRequest(recallRunToken, requestController.controller);
        try {
            throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
            await waitForRpmSlot(settings, abortSignal);
            const generateTaskOpts = {
                taskMessages,
                includeCharacterCard: true,
                worldInfoSource: 'none',
                runtimeWorldInfo,
                apiPresetName: String(apiPresetName || '').trim(),
                llmPresetName: String(llmPresetName || '').trim(),
                tools,
                toolChoice,
                functionCallMode: 'auto',
                functionCallOptions,
                abortSignal: requestController.signal,
            };
            const result = await context.generateTask(generateTaskOpts);
            throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
            const rawCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
            const normalizedCalls = rawCalls.map(call => ({
                name: String(call?.name || ''),
                args: call?.args && typeof call.args === 'object' ? call.args : {},
                raw: call?.raw || null,
            }));
            const filteredCalls = normalizedCalls.filter(call => call.name === fnName);
            const validationError = validateParsedToolCalls(filteredCalls, tools);
            if (validationError) {
                throw markToolCallValidationError(new Error(validationError));
            }
            const matched = filteredCalls.find(call => call.name === fnName);
            if (!matched) {
                throw markToolCallValidationError(new Error(`Model returned tool call, but not '${fnName}'.`));
            }
            return matched.args;
        } catch (error) {
            if (isAbortError(error, abortSignal)) {
                throw error;
            }
            throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
            lastError = error;
            if (attempt >= retries) {
                throw error;
            }
            notifyInfo(i18nFormat('Memory graph request failed, retrying (${0}/${1})…', attempt + 1, retries));
            console.warn(`[${MODULE_NAME}] Tool call '${fnName}' failed. Retrying (${attempt + 1}/${retries})...`, error);
        } finally {
            finishActiveRecallRequest(activeRequestState);
            requestController.cleanup();
        }
    }

    throw lastError || new Error(`Tool call '${fnName}' failed.`);
}

async function requestToolCallsWithRetry(context, settings, {
    taskMessages = [],
    runtimeWorldInfo = null,
    apiPresetName = '',
    llmPresetName = '',
    tools = [],
    allowedNames = null,
    retriesOverride = null,
    abortSignal = null,
    recallRunToken = 0,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('Tools are required.');
    }
    if (!context || typeof context.generateTask !== 'function') {
        throw new Error('context.generateTask is unavailable.');
    }

    const retriesSource = retriesOverride === null || retriesOverride === undefined
        ? Number(settings?.toolCallRetryMax)
        : Number(retriesOverride);
    const retries = Math.max(0, Math.min(10, Math.floor(retriesSource || 0)));
    const allowedSet = Array.isArray(allowedNames)
        ? new Set(allowedNames.map(name => String(name || '').trim()).filter(Boolean))
        : (allowedNames instanceof Set ? allowedNames : null);
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const requestController = createLinkedAbortController(isAbortSignalLike(abortSignal) ? abortSignal : null);
        const activeRequestState = registerActiveRecallRequest(recallRunToken, requestController.controller);
        try {
            throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
            await waitForRpmSlot(settings, abortSignal);
            const generateTaskOpts = {
                taskMessages,
                includeCharacterCard: true,
                worldInfoSource: 'none',
                runtimeWorldInfo,
                apiPresetName: String(apiPresetName || '').trim(),
                llmPresetName: String(llmPresetName || '').trim(),
                tools,
                toolChoice: 'auto',
                functionCallMode: 'auto',
                functionCallOptions: {
                    protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
                },
                abortSignal: requestController.signal,
            };
            const result = await context.generateTask(generateTaskOpts);
            throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
            const rawCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
            const normalizedCalls = rawCalls.map(call => ({
                name: String(call?.name || ''),
                args: call?.args && typeof call.args === 'object' ? call.args : {},
                raw: call?.raw || null,
            }));
            const filteredCalls = allowedSet && allowedSet.size > 0
                ? normalizedCalls.filter(call => allowedSet.has(call.name))
                : normalizedCalls;
            const validationError = validateParsedToolCalls(filteredCalls, tools);
            if (validationError) {
                throw markToolCallValidationError(new Error(validationError));
            }
            return filteredCalls;
        } catch (error) {
            if (isAbortError(error, abortSignal)) {
                throw error;
            }
            throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
            lastError = error;
            if (attempt >= retries) {
                throw error;
            }
            notifyInfo(i18nFormat('Memory graph request failed, retrying (${0}/${1})…', attempt + 1, retries));
            console.warn(`[${MODULE_NAME}] Multi tool call request failed. Retrying (${attempt + 1}/${retries})...`, error);
        } finally {
            finishActiveRecallRequest(activeRequestState);
            requestController.cleanup();
        }
    }

    throw lastError || new Error('Multi tool call request failed.');
}

async function runFunctionCallTask(context, settings, {
    systemPrompt = '',
    userPrompt = '',
    // Optional pre-assembled taskMessages. When provided, systemPrompt /
    // userPrompt are ignored and the array is threaded through to
    // requestSingleFunctionCallWithRetry verbatim. Callers that need
    // role-alternating chat between the system prefix and the tail user
    // task (extraction / recall route / recall finalize) construct this
    // themselves so per-turn plugin-lane regex applies at real chat depth
    // via cookPluginFloorText, and the dispatch layer skips re-cooking
    // these texts through its floor provenance marker.
    taskMessages: taskMessagesOverride = null,
    promptPresetName = '',
    apiPresetName = '',
    worldInfoMessages = null,
    runtimeWorldInfo = null,
    forceWorldInfoResimulate = false,
    worldInfoType = 'quiet',
    functionName = '',
    functionDescription = '',
    parameters = {},
    abortSignal = null,
    recallRunToken = 0,
    allowPreamble = false,
} = {}) {
    const fnName = String(functionName || '').trim();
    if (!fnName) {
        throw new Error('Function name is required.');
    }
    throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');

    const resolvedWorldInfo = await resolveMemoryGraphWorldInfo(context, settings, {
        worldInfoMessages,
        runtimeWorldInfo,
        forceWorldInfoResimulate,
        worldInfoType,
        abortSignal,
        recallRunToken,
    });
    throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');

    const taskMessages = Array.isArray(taskMessagesOverride) && taskMessagesOverride.length > 0
        ? taskMessagesOverride
        : [
            { role: 'system', content: String(systemPrompt || '').trim() },
            { role: 'user', content: String(userPrompt || '').trim() },
        ];

    return await requestSingleFunctionCallWithRetry(context, settings, {
        taskMessages,
        runtimeWorldInfo: resolvedWorldInfo,
        apiPresetName: String(apiPresetName || '').trim(),
        llmPresetName: String(promptPresetName || '').trim(),
        functionName: fnName,
        functionDescription,
        parameters,
        abortSignal,
        recallRunToken,
        allowPreamble,
    });
}

function sanitizeExtractToolNameSuffix(typeId = '') {
    return String(typeId || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '') || 'semantic';
}

function buildDynamicToolDescription(spec = {}, mode = 'create') {
    const typeId = String(spec?.id || '').trim().toLowerCase();
    const tableName = String(spec?.tableName || typeId || '').trim();
    const hint = normalizeText(spec?.extractHint || '');
    const fields = Array.isArray(spec?.tableColumns) ? spec.tableColumns.map(field => String(field || '').trim()).filter(Boolean) : [];
    const columnHints = spec?.columnHints && typeof spec.columnHints === 'object' && !Array.isArray(spec.columnHints)
        ? spec.columnHints
        : {};
    const required = Array.isArray(spec?.requiredColumns) ? spec.requiredColumns.map(field => String(field || '').trim()).filter(Boolean) : [];
    const primaryKeyColumns = Array.isArray(spec?.primaryKeyColumns)
        ? spec.primaryKeyColumns.map(field => String(field || '').trim()).filter(Boolean)
        : [];
    const latestOnly = Boolean(spec?.latestOnly);
    const normalizedMode = String(mode || 'create').trim().toLowerCase();
    const chunks = [];
    if (normalizedMode === 'edit') {
        chunks.push(`Edit semantic node for type "${typeId}" (table "${tableName || typeId}") by node_id.`);
        chunks.push('Provide only changed fields in set_fields. Existing fields not mentioned will stay unchanged.');
    } else {
        chunks.push(`Create semantic node for type "${typeId}" (table "${tableName || typeId}").`);
        chunks.push('Use this tool only for creating new nodes.');
    }
    if (hint) {
        chunks.push(`Meaning: ${hint}`);
    }
    if (fields.length > 0) {
        chunks.push(`Columns: ${fields.join(', ')}`);
    }
    const hintRows = fields
        .map(field => `${field}=${normalizeText(columnHints[field] || '')}`)
        .filter(row => !row.endsWith('='));
    if (hintRows.length > 0) {
        chunks.push(`Column meanings: ${hintRows.join('; ')}`);
    }
    if (required.length > 0) {
        chunks.push(`Required columns: ${required.join(', ')}`);
    } else {
        chunks.push('Required columns: none');
    }
    if (fields.includes('title')) {
        chunks.push('Title normalization: title must be the canonical primary name only. Never append aliases, English names, translations, titles, or any parenthetical/bracketed clarification to title.');
    }
    if (fields.includes('aliases')) {
        chunks.push('Alias normalization: put nicknames, titles, English names, translated names, short names, and alternative spellings in aliases only. Separate multiple aliases with commas or semicolons.');
    }
    if (latestOnly && primaryKeyColumns.length > 0) {
        chunks.push(`Dedup rule: before create, inspect graph_data.nodes and prefer edit over create when an existing node plausibly matches by primary-key overlap (${primaryKeyColumns.join(', ')}).`);
    }
    if (normalizedMode === 'create') {
        chunks.push(`Link relation vocabulary: when adding links, only use canonical relation types ${CANONICAL_EXTRACT_RELATION_TYPES_TEXT}. Reuse existing canonical labels instead of inventing synonyms or bilingual variants.`);
    }
    return chunks.join(' ');
}

export { buildDynamicExtractTools };

function buildDynamicExtractTools(schema = [], options = {}) {
    const tools = [];
    const specByToolName = new Map();
    const usedNames = new Set();
    const allowEditDelete = options?.allowEditDelete !== false;
    const allowLinks = options?.allowLinks !== false;
    const activeTypes = options?.activeTypes instanceof Set ? options.activeTypes : null;

    for (const rawSpec of Array.isArray(schema) ? schema : []) {
        const spec = rawSpec && typeof rawSpec === 'object' ? rawSpec : null;
        if (!spec) {
            continue;
        }
        const typeId = String(spec.id || '').trim().toLowerCase();
        if (!typeId) {
            continue;
        }
        if (activeTypes && !activeTypes.has(typeId)) {
            continue;
        }
        const baseName = `luker_rpg_extract_${sanitizeExtractToolNameSuffix(typeId)}`;
        const isEditableType = Boolean(spec?.editable);
        let createToolName = `${baseName}_create`;
        let suffix = 2;
        while (usedNames.has(createToolName)) {
            createToolName = `${baseName}_create_${suffix}`;
            suffix += 1;
        }
        usedNames.add(createToolName);
        let editToolName = '';
        if (isEditableType && allowEditDelete) {
            editToolName = `${baseName}_edit`;
            suffix = 2;
            while (usedNames.has(editToolName)) {
                editToolName = `${baseName}_edit_${suffix}`;
                suffix += 1;
            }
            usedNames.add(editToolName);
        }
        let deleteToolName = '';
        if (isEditableType && allowEditDelete) {
            deleteToolName = `${baseName}_delete`;
            suffix = 2;
            while (usedNames.has(deleteToolName)) {
                deleteToolName = `${baseName}_delete_${suffix}`;
                suffix += 1;
            }
            usedNames.add(deleteToolName);
        }
        const fields = Array.isArray(spec.tableColumns)
            ? spec.tableColumns.map(field => String(field || '').trim()).filter(Boolean)
            : [];
        const filteredFields = fields;
        const requiredColumns = Array.isArray(spec.requiredColumns)
            ? spec.requiredColumns.map(field => String(field || '').trim()).filter(Boolean)
            : [];
        const filteredRequiredColumns = requiredColumns;
        const rawColumnHints = spec.columnHints && typeof spec.columnHints === 'object' && !Array.isArray(spec.columnHints)
            ? spec.columnHints
            : {};
        const filteredColumnHints = Object.fromEntries(
            Object.entries(rawColumnHints)
                .map(([key, value]) => [String(key || '').trim(), String(value || '').trim()])
                .filter(([key, value]) => key && value && filteredFields.includes(key)),
        );
        const fieldSet = new Set(filteredFields);
        const createProperties = {
            ref: {
                type: 'string',
                description: allowLinks
                    ? 'Optional ref for this new node; links in the same response target it by this value. When referencing an existing node, use only an id that appears in graph_data.nodes.'
                    : 'Optional ref for this new node. When referencing an existing node, use only an id that appears in graph_data.nodes.',
            },
        };
        if (allowLinks) {
            createProperties.no_link_reason = { type: 'string' };
            createProperties.links = {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        target_ref: { type: 'string', description: 'Optional. Use either target_ref or target_node_id. When referencing an existing node, use only an id that appears in graph_data.nodes.' },
                        target_node_id: { type: 'string', description: 'Optional. Use either target_node_id or target_ref. When referencing an existing node, use only an id that appears in graph_data.nodes.' },
                        relation: { type: 'string', description: `Canonical relation type only. Allowed values: ${CANONICAL_EXTRACT_RELATION_TYPES_TEXT}.` },
                        direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'] },
                    },
                    additionalProperties: false,
                },
            };
        }
        if (fieldSet.has('title')) {
            createProperties.title = { type: 'string' };
        }
        for (const field of fieldSet) {
            if (createProperties[field]) {
                continue;
            }
            createProperties[field] = { type: 'string' };
        }
        const editFieldProperties = {};
        for (const field of fieldSet) {
            editFieldProperties[field] = { type: 'string' };
        }

        const createRequiredColumns = filteredRequiredColumns
            .filter(field => fieldSet.has(field) || field === 'title');
        if (allowLinks && typeId === 'event' && !createRequiredColumns.includes('links')) {
            createRequiredColumns.push('links');
        }

        tools.push({
            type: 'function',
            function: {
                name: createToolName,
                description: buildDynamicToolDescription({
                    ...spec,
                    id: typeId,
                    tableColumns: filteredFields,
                    requiredColumns: filteredRequiredColumns,
                    columnHints: filteredColumnHints,
                }, 'create'),
                parameters: {
                    type: 'object',
                    properties: createProperties,
                    required: createRequiredColumns,
                    additionalProperties: false,
                },
            },
        });
        if (isEditableType && allowEditDelete) {
            tools.push({
                type: 'function',
                function: {
                    name: editToolName,
                    description: buildDynamicToolDescription({
                        ...spec,
                        id: typeId,
                        tableColumns: filteredFields,
                        requiredColumns: filteredRequiredColumns,
                        columnHints: filteredColumnHints,
                    }, 'edit'),
                    parameters: {
                        type: 'object',
                        properties: {
                            node_id: { type: 'string', description: 'When referencing an existing node, use only an id that appears in graph_data.nodes.' },
                            title: { type: 'string' },
                            set_fields: {
                                type: 'object',
                                properties: editFieldProperties,
                                additionalProperties: false,
                            },
                            clear_fields: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                    enum: filteredFields,
                                },
                            },
                            reason: { type: 'string' },
                        },
                        required: ['node_id'],
                        additionalProperties: false,
                    },
                },
            });
        }
        if (isEditableType && allowEditDelete) {
            tools.push({
                type: 'function',
                function: {
                    name: deleteToolName,
                    description: `Delete semantic node for type "${typeId}" by node_id.`,
                    parameters: {
                        type: 'object',
                        properties: {
                            node_id: { type: 'string', description: 'When referencing an existing node, use only an id that appears in graph_data.nodes.' },
                            reason: { type: 'string' },
                        },
                        required: ['node_id'],
                        additionalProperties: false,
                    },
                },
            });
        }
        specByToolName.set(createToolName, {
            ...spec,
            id: typeId,
            tableColumns: filteredFields,
            requiredColumns: filteredRequiredColumns,
            columnHints: filteredColumnHints,
            op: 'create',
        });
        if (isEditableType && allowEditDelete) {
            specByToolName.set(editToolName, {
                ...spec,
                id: typeId,
                tableColumns: filteredFields,
                requiredColumns: filteredRequiredColumns,
                columnHints: filteredColumnHints,
                op: 'edit',
            });
        }
        if (isEditableType && allowEditDelete) {
            specByToolName.set(deleteToolName, {
                ...spec,
                id: typeId,
                tableColumns: filteredFields,
                requiredColumns: filteredRequiredColumns,
                columnHints: filteredColumnHints,
                op: 'delete',
            });
        }
    }

    if (allowLinks) {
        const linkUpsertToolName = 'luker_rpg_extract_link_upsert';
        tools.push({
            type: 'function',
            function: {
                name: linkUpsertToolName,
                description: `Upsert relation edges between semantic nodes. Use this when only links change. Only use canonical relation types: ${CANONICAL_EXTRACT_RELATION_TYPES_TEXT}. Reuse existing canonical labels instead of inventing synonyms or bilingual variants.`,
                parameters: {
                    type: 'object',
                    properties: {
                        source_ref: { type: 'string', description: 'Optional. Use either source_ref or source_node_id. When referencing an existing node, use only an id that appears in graph_data.nodes.' },
                        source_node_id: { type: 'string', description: 'Optional. Use either source_node_id or source_ref. When referencing an existing node, use only an id that appears in graph_data.nodes.' },
                        links: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    target_ref: { type: 'string', description: 'Optional. Use either target_ref or target_node_id. When referencing an existing node, use only an id that appears in graph_data.nodes.' },
                                    target_node_id: { type: 'string', description: 'Optional. Use either target_node_id or target_ref. When referencing an existing node, use only an id that appears in graph_data.nodes.' },
                                    relation: { type: 'string', description: `Canonical relation type only. Allowed values: ${CANONICAL_EXTRACT_RELATION_TYPES_TEXT}.` },
                                    direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'] },
                                },
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['links'],
                    additionalProperties: false,
                },
            },
        });
        specByToolName.set(linkUpsertToolName, {
            id: 'link',
            tableName: 'link',
            tableColumns: [],
            requiredColumns: [],
            columnHints: {},
            editable: true,
            op: 'link_upsert',
            toolName: linkUpsertToolName,
        });

        const linkDeleteToolName = 'luker_rpg_extract_link_delete';
        tools.push({
            type: 'function',
            function: {
                name: linkDeleteToolName,
                description: `Delete a relation edge between two semantic nodes. Use when a relationship is no longer in effect (dissolved, broken, repaid, revoked). Composite states like partner_of + deceiving stay valid — do NOT delete to "replace" with another relation. Direction: 'outgoing' deletes from→to only; 'incoming' deletes to→from only; 'bidirectional' (default) deletes both. Only use canonical relation types: ${CANONICAL_EXTRACT_RELATION_TYPES_TEXT}.`,
                parameters: {
                    type: 'object',
                    properties: {
                        source_node_id: { type: 'string', description: 'Existing node id (one endpoint of the edge). When referencing an existing node, use only an id that appears in graph_data.nodes.' },
                        target_node_id: { type: 'string', description: 'Existing node id (the other endpoint). When referencing an existing node, use only an id that appears in graph_data.nodes.' },
                        relation: { type: 'string', description: `Canonical relation type only. Allowed values: ${CANONICAL_EXTRACT_RELATION_TYPES_TEXT}.` },
                        direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'] },
                    },
                    required: ['source_node_id', 'target_node_id', 'relation'],
                    additionalProperties: false,
                },
            },
        });
        specByToolName.set(linkDeleteToolName, {
            id: 'link',
            tableName: 'link',
            tableColumns: [],
            requiredColumns: [],
            columnHints: {},
            editable: true,
            op: 'link_delete',
            toolName: linkDeleteToolName,
        });
    }

    tools.push({
        type: 'function',
        function: {
            name: 'luker_rpg_extract_done',
            description: 'Signal extraction completion.',
            parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
            },
        },
    });

    return { tools, specByToolName };
}

function normalizeExtractLinks(rawLinks) {
    if (!Array.isArray(rawLinks)) {
        return [];
    }
    const normalized = [];
    for (const rawLink of rawLinks) {
        const link = rawLink && typeof rawLink === 'object' ? rawLink : null;
        if (!link) {
            continue;
        }
        const targetRef = normalizeText(link?.target_ref || link?.targetRef || '');
        const targetNodeId = normalizeText(link?.target_node_id || link?.targetNodeId || '');
        if (!targetRef && !targetNodeId) {
            continue;
        }
        const relation = normalizeText(link?.relation || 'related') || 'related';
        const directionRaw = String(link?.direction || 'bidirectional').toLowerCase();
        const direction = ['outgoing', 'incoming', 'bidirectional'].includes(directionRaw)
            ? directionRaw
            : 'bidirectional';
        normalized.push({
            targetRef,
            targetNodeId,
            relation,
            direction,
        });
    }
    return normalized;
}

function buildCreateFromDynamicToolCall(call, spec) {
    if (!call || typeof call !== 'object' || !spec || typeof spec !== 'object') {
        return { payload: null, missingRequired: [] };
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const fields = {};
    for (const column of Array.isArray(spec.tableColumns) ? spec.tableColumns : []) {
        const key = String(column || '').trim();
        if (!key) {
            continue;
        }
        if (key === 'title') {
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(args, key)) {
            continue;
        }
        const rawValue = args[key];
        if (rawValue === undefined || rawValue === null) {
            continue;
        }
        fields[key] = rawValue;
    }
    const titleValue = args.title ?? '';
    const missingRequired = [];
    for (const requiredField of Array.isArray(spec.requiredColumns) ? spec.requiredColumns : []) {
        const key = String(requiredField || '').trim();
        if (!key) {
            continue;
        }
        const value = key === 'title'
            ? titleValue
            : fields[key];
        if (!normalizeText(toDisplayScalar(value))) {
            missingRequired.push(key);
        }
    }
    return {
        payload: {
            type: String(spec.id || '').trim().toLowerCase(),
            title: normalizeText(titleValue),
            fields,
            ref: normalizeText(args.ref || ''),
            links: normalizeExtractLinks(args.links),
            noLinkReason: normalizeText(args.no_link_reason || ''),
            hasLinksProp: Object.prototype.hasOwnProperty.call(args, 'links'),
        },
        missingRequired,
    };
}

function buildLinkUpsertFromToolCall(call) {
    if (!call || typeof call !== 'object') {
        return { payload: null, invalidReason: 'Invalid call.' };
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const sourceNodeId = normalizeText(args.source_node_id || '');
    const sourceRef = normalizeText(args.source_ref || '');
    if (!sourceNodeId && !sourceRef) {
        return { payload: null, invalidReason: 'source_node_id or source_ref is required.' };
    }
    const links = normalizeExtractLinks(args.links);
    if (links.length === 0) {
        return { payload: null, invalidReason: 'links must contain at least one valid target.' };
    }
    return {
        payload: {
            op: 'link_upsert',
            sourceNodeId,
            sourceRef,
            links,
        },
        invalidReason: '',
    };
}

function buildLinkDeleteFromToolCall(call) {
    if (!call || typeof call !== 'object') {
        return { payload: null, invalidReason: 'Invalid call.' };
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const sourceNodeId = normalizeText(args.source_node_id || '');
    const targetNodeId = normalizeText(args.target_node_id || '');
    const relation = normalizeText(args.relation || '').toLowerCase();
    if (!sourceNodeId) {
        return { payload: null, invalidReason: 'source_node_id is required.' };
    }
    if (!targetNodeId) {
        return { payload: null, invalidReason: 'target_node_id is required.' };
    }
    if (!relation) {
        return { payload: null, invalidReason: 'relation is required.' };
    }
    const directionRaw = String(args.direction || 'bidirectional').toLowerCase();
    const direction = ['outgoing', 'incoming', 'bidirectional'].includes(directionRaw)
        ? directionRaw
        : 'bidirectional';
    return {
        payload: {
            op: 'link_delete',
            sourceNodeId,
            targetNodeId,
            relation,
            direction,
        },
        invalidReason: '',
    };
}

function buildEditFromDynamicToolCall(call, spec) {
    if (!call || typeof call !== 'object' || !spec || typeof spec !== 'object') {
        return { payload: null, invalidReason: 'Invalid call.' };
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const nodeId = normalizeText(args.node_id || '');
    if (!nodeId) {
        return { payload: null, invalidReason: 'node_id is required.' };
    }
    const allowedFields = new Set(
        (Array.isArray(spec.tableColumns) ? spec.tableColumns : [])
            .map(column => String(column || '').trim())
            .filter(key => key && key !== 'title'),
    );
    const rawSetFields = args.set_fields && typeof args.set_fields === 'object' && !Array.isArray(args.set_fields)
        ? args.set_fields
        : {};
    const setFields = {};
    for (const [key, value] of Object.entries(rawSetFields)) {
        const normalizedKey = String(key || '').trim();
        if (!normalizedKey || !allowedFields.has(normalizedKey)) {
            continue;
        }
        if (value === undefined || value === null) {
            continue;
        }
        setFields[normalizedKey] = value;
    }
    const clearFields = Array.isArray(args.clear_fields)
        ? args.clear_fields
            .map(key => String(key || '').trim())
            .filter(key => key && allowedFields.has(key))
        : [];
    const titleValue = Object.prototype.hasOwnProperty.call(args, 'title')
        ? normalizeText(args.title || '')
        : '';
    const hasTitlePatch = Object.prototype.hasOwnProperty.call(args, 'title');
    if (!hasTitlePatch && Object.keys(setFields).length === 0 && clearFields.length === 0) {
        return { payload: null, invalidReason: 'No effective edit fields provided.' };
    }
    return {
        payload: {
            op: 'edit',
            type: String(spec.id || '').trim().toLowerCase(),
            nodeId,
            hasTitlePatch,
            title: titleValue,
            setFields,
            clearFields,
        },
        invalidReason: '',
    };
}

function buildDeleteFromDynamicToolCall(call, spec) {
    if (!call || typeof call !== 'object' || !spec || typeof spec !== 'object') {
        return { payload: null, invalidReason: 'Invalid call.' };
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const nodeId = normalizeText(args.node_id || '');
    if (!nodeId) {
        return { payload: null, invalidReason: 'node_id is required.' };
    }
    return {
        payload: {
            op: 'delete',
            type: String(spec.id || '').trim().toLowerCase(),
            nodeId,
        },
        invalidReason: '',
    };
}

export function getSchemaProjectionColumns(spec = null) {
    return Array.isArray(spec?.tableColumns)
        ? spec.tableColumns.map(column => String(column || '').trim()).filter(Boolean)
        : [];
}

function buildProjectedRowValues(node, spec = null) {
    const rowValues = {};
    const columns = getSchemaProjectionColumns(spec);
    for (const column of columns) {
        const value = toDisplayScalar(getTableCellValueFromNode(node, column));
        if (!value) {
            continue;
        }
        rowValues[column] = value;
    }
    return rowValues;
}

function buildProjectedKeyValues(node, spec = null) {
    const keyColumns = Array.from(new Set([
        ...(
            Array.isArray(spec?.primaryKeyColumns)
                ? spec.primaryKeyColumns.map(column => String(column || '').trim()).filter(Boolean)
                : []
        ),
        ...(
            Array.isArray(spec?.requiredColumns)
                ? spec.requiredColumns.map(column => String(column || '').trim()).filter(Boolean)
                : []
        ),
    ]));
    const keyValues = {};
    for (const column of keyColumns) {
        const value = toDisplayScalar(getTableCellValueFromNode(node, column));
        if (!value) {
            continue;
        }
        keyValues[column] = value;
    }
    return keyValues;
}

function buildLlmFriendlyNodeProjection(node, spec = null) {
    const rowValues = buildProjectedRowValues(node, spec);
    const keyValues = buildProjectedKeyValues(node, spec);
    const seqTo = Number.isFinite(Number(node?.seqTo)) ? Number(node.seqTo) : null;
    return {
        id: String(node?.id || ''),
        level: String(node?.level || ''),
        type: String(node?.type || ''),
        table_name: String(spec?.tableName || node?.type || '').trim(),
        title: String(node?.title || ''),
        summary: getNodeSummary(node),
        key_values: keyValues,
        row_values: rowValues,
        to_seq: seqTo,
    };
}

export function buildGraphNodeHints(store, schema, limit = 0, options = {}) {
    const numericLimit = Number(limit);
    const safeLimit = Number.isFinite(numericLimit) && numericLimit > 0
        ? Math.max(1, Math.min(5000, Math.floor(numericLimit)))
        : Number.POSITIVE_INFINITY;
    const maxSeq = Number.isFinite(Number(options?.maxSeq))
        ? Math.max(0, Math.floor(Number(options.maxSeq)))
        : null;
    if (!store || typeof store !== 'object') {
        return [];
    }
    const scope = String(options?.scope || 'visible').trim().toLowerCase();
    const schemaMap = new Map(
        (Array.isArray(schema) ? schema : [])
            .map(item => [String(item?.id || '').trim().toLowerCase(), item]),
    );
    const allSemanticNodes = listNodesByLevel(store, LEVEL.SEMANTIC)
        .filter(node => !node?.archived)
        .filter(node => !isRecallDiagnosticNode(node))
        .filter((node) => {
            if (maxSeq === null) {
                return true;
            }
            const seq = Number(node?.seqTo ?? NaN);
            return !Number.isFinite(seq) || seq <= maxSeq;
        });
    let projectedNodes = allSemanticNodes;
    if (scope !== 'full') {
        const typeIds = new Set(
            allSemanticNodes
                .map(node => String(node?.type || '').trim().toLowerCase())
                .filter(Boolean),
        );
        const visibleNodes = [];
        const visibleNodeIds = new Set();
        for (const type of typeIds) {
            const spec = schemaMap.get(type);
            const compressionMode = String(spec?.compression?.mode || 'none').trim().toLowerCase();
            const typeNodes = allSemanticNodes
                .filter(node => String(node?.type || '').trim().toLowerCase() === type)
                .sort(compareNodesByTimeline);
            if (typeNodes.length === 0) {
                continue;
            }
            const selectedTypeNodes = selectVisibleNodesForType(store, typeNodes, type, compressionMode);
            for (const node of selectedTypeNodes) {
                if (!node?.id || visibleNodeIds.has(node.id)) {
                    continue;
                }
                visibleNodeIds.add(node.id);
                visibleNodes.push(node);
            }
        }
        projectedNodes = visibleNodes;
    }
    projectedNodes.sort(compareNodesByTimeline);
    const rows = [];
    for (const node of projectedNodes) {
        if (rows.length >= safeLimit) {
            break;
        }
        rows.push(buildGraphNodeRow(node, schemaMap));
    }
    return rows;
}

/**
 * Project one semantic node into a `graph_data.nodes` row. Shared by
 * `buildGraphNodeHints` and the round node list so both carry the same shape.
 *
 * @param {object} node
 * @param {Map<string, object>} schemaMap type id (lowercase) → schema entry
 * @returns {object}
 */
function buildGraphNodeRow(node, schemaMap) {
    const type = String(node?.type || '').trim().toLowerCase();
    const spec = schemaMap.get(type);
    return {
        ...buildLlmFriendlyNodeProjection(node, spec),
        type,
        semantic_depth: Number(node?.semanticDepth ?? node?.metadata?.semantic_depth ?? 0),
        parent_id: String(node?.parentId || ''),
        child_count: Array.isArray(node?.childrenIds) ? node.childrenIds.length : 0,
        editable: Boolean(spec?.editable),
    };
}

function buildJsonXmlSection(tag, value) {
    const name = String(tag || '').trim();
    const safeTag = name || 'data';
    const jsonText = JSON.stringify(value ?? {});
    return [
        `  <${safeTag}>`,
        `    ${jsonText}`,
        `  </${safeTag}>`,
    ].join('\n');
}

function buildExtractInputHead() {
    return [
        '<extract_input>',
        '  <input_guide>dialogue_batch is the current source dialogue to extract from. Each turn is delivered as a real chat message (role=user or assistant) with a leading <seq>{n}</seq> tag identifying its turn number.</input_guide>',
        '  <dialogue_batch>',
    ].join('\n');
}

function buildExtractInputTail(requiredTypes, graphData, roundNodes = null) {
    const safeRequiredTypes = Array.isArray(requiredTypes)
        ? requiredTypes.map(item => normalizeText(item).toLowerCase()).filter(Boolean)
        : [];
    const safeGraphData = graphData && typeof graphData === 'object' ? graphData : { initialized: false, nodes: [] };
    const roundNodesSection = buildRoundNodesSection(roundNodes);

    const requiredTypeXml = safeRequiredTypes.length > 0
        ? safeRequiredTypes.map(type => `    <type>${type}</type>`).join('\n')
        : '    <type>(none)</type>';

    return [
        '  </dialogue_batch>',
        '  <input_guide>required_types are hard-required types for this batch.</input_guide>',
        '  <required_types>',
        requiredTypeXml,
        '  </required_types>',
        '  <input_guide>graph_data is the current semantic memory graph state for extraction.</input_guide>',
        safeGraphData.graph_scope === 'crawled_local_slice'
            ? '  <input_guide>graph_data is a bounded local slice obtained by crawling from relevant candidate nodes. Nodes omitted from this slice may still exist; do not treat omission as proof of non-existence.</input_guide>'
            : '  <input_guide>graph_data is a full schema-aware projection of the current semantic graph for extraction.</input_guide>',
        '  <input_guide>Each graph_data.nodes row contains key_values (identity keys) and row_values (schema columns) when available.</input_guide>',
        '  <input_guide>graph_data.edges contains the currently projected semantic relations between nodes in this graph view.</input_guide>',
        '  <input_guide>If graph_data.initialized=false, treat graph as uninitialized and prefer create operations over edit/delete.</input_guide>',
        buildJsonXmlSection('graph_data', safeGraphData),
        ...(roundNodesSection ? [roundNodesSection] : []),
        '</extract_input>',
    ].join('\n');
}

/**
 * Wrap a chat message's cooked text with the seq metadata prefix used by
 * extraction / recall LLM inputs. The wrapper prefix is added AFTER the
 * plugin-lane cooking pass has already been applied, so user regex rules
 * only see raw chat text — the wrapper doesn't pollute pattern inputs.
 */
function wrapChatMessageContentWithSeq(seq, cookedText) {
    const safeSeq = Number.isFinite(Number(seq)) ? Math.max(0, Math.floor(Number(seq))) : 0;
    return `<seq>${safeSeq}</seq>\n${String(cookedText || '')}`;
}

/**
 * Convert a memory-graph batch item (from buildExtractBatchFromFrames or
 * queryBundle.recent_messages equivalent) into a role-alternating chat
 * completion message, with plugin request lane (`pluginLanes: ['request']`)
 * user regex scripts applied at the real chat[] depth for parity with the
 * main pipeline.
 *
 * @param {{seq?: number, is_user?: boolean, name?: string, mes?: string, source_index?: number}} item
 * @param {number|undefined} depth
 * @param {{wrapWithSeq?: boolean}} [opts] - When wrapWithSeq is true, the
 *     cooked text is prefixed with `<seq>{n}</seq>\n` so extraction prompts
 *     can identify per-turn seq boundaries. Default false for recall /
 *     rewrite scenarios where seq per turn is not consumed.
 * @returns {{role: string, content: string, sourceFloorIndex: number}}
 */
function buildRoleSplitChatMessage(item, depth, { wrapWithSeq = false } = {}) {
    const isUser = Boolean(item?.is_user);
    const rawText = String(item?.mes || '');
    const cooked = cookPluginFloorText({ mes: rawText, is_user: isUser }, depth);
    const content = wrapWithSeq
        ? wrapChatMessageContentWithSeq(Number(item?.seq || 0), cooked)
        : cooked;
    // Stamp the floor-provenance marker so the dispatch layer
    // (applyPluginLaneRegex) skips re-cooking these already-cooked texts.
    // The marker is stripped before any network payload leaves.
    return markPluginFloorMessage(
        {
            role: isUser ? 'user' : 'assistant',
            content,
        },
        item?.source_index,
    );
}

/**
 * Turn a batch of memory-graph chat items (with source_index) into
 * role-alternating chat completion messages. Depth is computed against
 * the *full* context.chat so `maxDepth` / `minDepth` filters on user
 * regex rules behave the same as in the main generation pipeline.
 *
 * Items with missing / invalid source_index fall back to `undefined`
 * depth (disabling depth-based script filtering), matching the graceful
 * degradation policy in `cookPluginFloorText`.
 *
 * @param {Array<object>} batchItems
 * @param {object} context
 * @param {{wrapWithSeq?: boolean}} [opts] - Propagated to buildRoleSplitChatMessage.
 * @returns {Array<{role: string, content: string}>}
 */
function buildRoleSplitChatMessages(batchItems, context, { wrapWithSeq = false } = {}) {
    const items = Array.isArray(batchItems) ? batchItems : [];
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const depths = computeDepthsFromEnd(chat);
    const out = [];
    for (const item of items) {
        if (!item) continue;
        const rawText = String(item?.mes || '');
        if (!rawText) continue;
        const sourceIndex = Number(item?.source_index);
        const depth = Number.isFinite(sourceIndex) && sourceIndex >= 0 && sourceIndex < depths.length
            ? depths[sourceIndex]
            : undefined;
        out.push(buildRoleSplitChatMessage(item, depth, { wrapWithSeq }));
    }
    return out;
}

function buildRecallRouteInputHead() {
    return [
        '<recall_route_input>',
        '  <input_guide>Plan recall route from the data blocks below. Use node ids from candidate_nodes only.</input_guide>',
        '  <input_guide>always_inject_node_ids are injected separately; never include them in selected_node_ids.</input_guide>',
        '  <input_guide>The dialogue_context block below carries recent chat turns as real role=user|assistant messages (raw dialogue, no per-turn seq wrapper). Use them to reason about scene, entities, and intent.</input_guide>',
        '  <dialogue_context>',
    ].join('\n');
}

function buildRecallRouteInputTail({
    recallQueryContext = {},
    candidateNodes = [],
    alwaysInjectNodeIds = [],
    schemaOverview = [],
    selectionConstraints = {},
} = {}) {
    return [
        '  </dialogue_context>',
        buildJsonXmlSection('recall_query_context', recallQueryContext),
        buildJsonXmlSection('candidate_nodes', candidateNodes),
        buildJsonXmlSection('always_inject_node_ids', alwaysInjectNodeIds),
        buildJsonXmlSection('schema_overview', schemaOverview),
        buildJsonXmlSection('selection_constraints', selectionConstraints),
        '</recall_route_input>',
    ].join('\n');
}

function buildRecallFinalizeInputHead() {
    return [
        '<recall_finalize_input>',
        '  <input_guide>Finalize selected node ids for injection from candidate_nodes.</input_guide>',
        '  <input_guide>always_inject_node_ids are injected separately; never include them in selected_node_ids.</input_guide>',
        '  <input_guide>The dialogue_context block below carries recent chat turns as real role=user|assistant messages (raw dialogue, no per-turn seq wrapper). Use them to reason about scene, entities, and intent.</input_guide>',
        '  <dialogue_context>',
    ].join('\n');
}

function buildRecallFinalizeInputTail({
    recallQueryContext = {},
    candidateNodes = [],
    alwaysInjectNodeIds = [],
    routeResult = {},
    selectionConstraints = {},
} = {}) {
    return [
        '  </dialogue_context>',
        buildJsonXmlSection('recall_query_context', recallQueryContext),
        buildJsonXmlSection('candidate_nodes', candidateNodes),
        buildJsonXmlSection('always_inject_node_ids', alwaysInjectNodeIds),
        buildJsonXmlSection('route_result', routeResult),
        buildJsonXmlSection('selection_constraints', selectionConstraints),
        '</recall_finalize_input>',
    ].join('\n');
}

async function extractNodesWithLLM(context, store, settings, schema, messageBatch, options = {}) {
    const messages = (Array.isArray(messageBatch) ? messageBatch : [])
        .map(item => ({
            seq: Number(item?.seq || 0),
            role: item?.is_user ? 'user' : 'assistant',
            name: String(item?.name || ''),
            text: String(item?.mes || ''),
        }))
        .filter(item => normalizeText(item.text));
    if (messages.length === 0) {
        return [];
    }

    const apiPresetName = String(settings.extractApiPresetName || '').trim();
    const promptPresetName = String(settings.extractPresetName || '').trim();
    const forceUpdateTypes = new Set(
        schema
            .filter(item => item && typeof item === 'object' && item.forceUpdate)
            .map(item => String(item.id || '').trim().toLowerCase())
            .filter(Boolean),
    );
    const editableTypeSet = new Set(
        schema
            .filter(item => item && typeof item === 'object' && item.editable)
            .map(item => String(item.id || '').trim().toLowerCase())
            .filter(Boolean),
    );
    const extractionMaxSeq = Number.isFinite(Number(options?.maxSeq))
        ? Math.max(0, Math.floor(Number(options.maxSeq)))
        : null;
    const rebuildCreateOnly = Boolean(options?.rebuildCreateOnly);
    const crawlGraph = options?.crawlGraph && typeof options.crawlGraph === 'object' ? options.crawlGraph : null;
    const includeEdges = options?.includeEdges !== false;
    const includeLinks = options?.includeLinks !== false;
    const allowEmptyTypes = options?.allowEmptyTypes === true;
    const requestedTypes = options?.types instanceof Set ? options.types : null;
    const graphNodes = crawlGraph
        ? (Array.isArray(crawlGraph.nodes) ? crawlGraph.nodes : [])
        : buildGraphNodeHints(store, schema, 0, { maxSeq: extractionMaxSeq, scope: 'visible' });
    const graphNodeIds = new Set(graphNodes.map(node => String(node?.id || '')).filter(Boolean));
    const graphEdges = crawlGraph && Array.isArray(crawlGraph.edges)
        ? crawlGraph.edges
        : buildProjectedEdges(store, {
            visibleNodeIds: graphNodeIds,
            excludeInternal: false,
        }).map(edge => ({
            from: String(edge?.from || ''),
            to: String(edge?.to || ''),
            type: normalizeText(edge?.type || 'related') || 'related',
            weight: Math.max(1, Number(edge?.weight || 1)),
        }));
    const semanticNodeTotal = crawlGraph
        ? Number(crawlGraph.semantic_node_total || graphNodes.length)
        : listNodesByLevel(store, LEVEL.SEMANTIC)
            .filter(node => !node?.archived)
            .filter(node => !isRecallDiagnosticNode(node))
            .filter((node) => {
                if (extractionMaxSeq === null) {
                    return true;
                }
                const seq = Number(node?.seqTo ?? NaN);
                return !Number.isFinite(seq) || seq <= extractionMaxSeq;
            })
            .length;
    const graphDataPayload = {
        initialized: graphNodes.length > 0,
        editable_type_ids: Array.from(editableTypeSet.values()),
        projection_policy: crawlGraph?.projection_policy || {
            hierarchical_types: 'top_level_rollups_only',
            non_hierarchical_types: 'full',
        },
        graph_scope: crawlGraph?.graph_scope || 'visible',
        semantic_node_total: semanticNodeTotal,
        visible_node_count: graphNodes.length,
        nodes: graphNodes,
        edges: graphEdges,
    };
    const cadenceSeq = Number.isFinite(Number(extractionMaxSeq)) ? Number(extractionMaxSeq) : 0;
    const activeTypes = requestedTypes || computeActiveExtractionTypes(schema, cadenceSeq);
    if (activeTypes.size === 0 && !allowEmptyTypes) {
        store.lastExtractionDebug = {
            ...(store.lastExtractionDebug || {}),
            extracted: false,
            reason: 'no_active_types',
            at: Date.now(),
        };
        return [];
    }
    // Hard-required types drive both the `<required_types>` block and the
    // missing-tool retry. Default: the active types the schema marks
    // force-update. The concurrent round names them per request.
    const requiredTypes = options?.requiredTypes instanceof Set
        ? options.requiredTypes
        : new Set(Array.from(activeTypes).filter(typeId => forceUpdateTypes.has(typeId)));
    const { template, edgeRules } = resolveExtractionTemplate(settings);
    const extractInputHead = buildExtractInputHead();
    const extractInputTail = buildExtractInputTail(Array.from(requiredTypes), graphDataPayload, options?.roundNodes || null);
    // Role-split dialogue: each chat message is a real chat-completion turn
    // (role=user|assistant), with a leading <seq>{n}</seq> tag preserving
    // batch/prior boundary identification. Prompt-scoped user regex is
    // applied per-message at the real chat[] depth so behavior matches the
    // main generation pipeline; the wrapper `<dialogue_batch>` open/close
    // lives in extractInputHead/extractInputTail.
    const roleSplitChatMessages = buildRoleSplitChatMessages(messageBatch, context, { wrapWithSeq: true });
    const extractSystemPrompt = renderExtractionTemplate(template, {
        nodesBlock: buildExtractionNodesBlock(schema, activeTypes),
        edgesBlock: includeEdges ? buildExtractionEdgesBlock(edgeRules) : '',
    });
    const resolvedExtractWorldInfo = await resolveMemoryGraphWorldInfo(context, settings, {
        worldInfoMessages: messages.map(item => ({
            role: item.role,
            content: item.text,
            name: item.name,
        })),
        worldInfoType: 'quiet',
        abortSignal: options?.abortSignal || null,
    });
    const { tools, specByToolName } = buildDynamicExtractTools(schema, {
        allowEditDelete: !rebuildCreateOnly,
        activeTypes,
        allowLinks: includeLinks,
    });
    const allowedNames = new Set(['luker_rpg_extract_done', ...specByToolName.keys()]);
    const semanticRetries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    const editableNodes = new Map(
        listNodesByLevel(store, LEVEL.SEMANTIC)
            .filter((node) => {
                if (!node || node.archived || !node.id) {
                    return false;
                }
                if (extractionMaxSeq !== null) {
                    const seq = Number(node?.seqTo ?? NaN);
                    if (Number.isFinite(seq) && seq > extractionMaxSeq) {
                        return false;
                    }
                }
                const type = String(node?.type || '').trim().toLowerCase();
                return editableTypeSet.has(type);
            })
            .map(node => [String(node.id), node]),
    );
    let validatedOps = [];
    let retryReason = '';
    let retryCategory = 'incomplete';
    let lastRetryableError = null;
    for (let attempt = 0; attempt <= semanticRetries; attempt++) {
        if (attempt > 0) {
            notifyExtractionRetry(retryCategory, attempt - 1, semanticRetries);
        }
        const reminderText = attempt > 0
            ? `Previous response was incomplete. Return COMPLETE extraction tool calls in one response: exactly one final luker_rpg_extract_done as the last call.${retryReason ? ` Fix: ${retryReason}` : ''}`
            : '';
        const tailParts = [extractInputTail];
        if (reminderText) tailParts.push(reminderText);
        const taskMessages = [
            { role: 'system', content: extractSystemPrompt },
            { role: 'system', content: extractInputHead },
            ...roleSplitChatMessages,
            { role: 'user', content: tailParts.join('\n\n') },
        ];
        let calls = [];
        try {
            calls = await requestToolCallsWithRetry(context, settings, {
                taskMessages,
                runtimeWorldInfo: resolvedExtractWorldInfo,
                apiPresetName,
                llmPresetName: promptPresetName,
                tools,
                allowedNames,
                retriesOverride: 0,
                abortSignal: options?.abortSignal || null,
            });
        } catch (error) {
            if (isAbortError(error, options?.abortSignal || null)) {
                throw error;
            }
            if (attempt >= semanticRetries) {
                throw error;
            }
            lastRetryableError = error;
            retryReason = `request_error: ${String(error?.message || error)}`;
            retryCategory = error?.__toolCallValidation ? 'invalid' : 'request';
            console.warn(`[${MODULE_NAME}] Extract request failed. Retrying semantic pass (${attempt + 1}/${semanticRetries})...`, error);
            continue;
        }
        if (!Array.isArray(calls) || calls.length < 1) {
            retryReason = 'Tool calls are missing or incomplete.';
            retryCategory = 'incomplete';
            continue;
        }
        const names = calls.map(call => String(call?.name || '').trim()).filter(Boolean);
        const doneCount = names.filter(name => name === 'luker_rpg_extract_done').length;
        if (doneCount < 1) {
            retryReason = 'luker_rpg_extract_done was not called.';
            retryCategory = 'incomplete';
            continue;
        }
        if (names[names.length - 1] !== 'luker_rpg_extract_done') {
            retryReason = 'luker_rpg_extract_done must be the last call.';
            retryCategory = 'incomplete';
            continue;
        }
        const typeCalls = calls.filter(call => specByToolName.has(String(call?.name || '')));
        const ops = [];
        const calledTypes = new Set();
        let invalid = false;
        for (const call of typeCalls) {
            const toolName = String(call?.name || '');
            const specEntry = specByToolName.get(toolName);
            if (!specEntry) {
                continue;
            }
            const spec = { ...specEntry };
            if (spec.op === 'delete') {
                const deletion = buildDeleteFromDynamicToolCall(call, spec);
                if (!deletion.payload) {
                    invalid = true;
                    retryReason = `Delete call invalid for "${spec.id}": ${deletion.invalidReason}`;
                    break;
                }
                const mappedNodeId = String(deletion.payload.nodeId || '').trim();
                const targetNode = editableNodes.get(mappedNodeId);
                if (!targetNode) {
                    invalid = true;
                    retryReason = `Unknown node_id "${mappedNodeId}". Use only ids from graph_data.nodes (editable nodes only).`;
                    break;
                }
                if (String(targetNode?.type || '').trim().toLowerCase() !== String(spec.id || '').trim().toLowerCase()) {
                    invalid = true;
                    retryReason = `node_id "${mappedNodeId}" type mismatch: expected "${spec.id}".`;
                    break;
                }
                ops.push(deletion.payload);
                continue;
            }
            if (spec.op === 'link_upsert') {
                const linkOp = buildLinkUpsertFromToolCall(call);
                if (!linkOp.payload) {
                    invalid = true;
                    retryReason = `Link call invalid: ${linkOp.invalidReason}`;
                    break;
                }
                ops.push(linkOp.payload);
                continue;
            }
            if (spec.op === 'link_delete') {
                const linkOp = buildLinkDeleteFromToolCall(call);
                if (!linkOp.payload) {
                    invalid = true;
                    retryReason = `Link delete call invalid: ${linkOp.invalidReason}`;
                    break;
                }
                ops.push(linkOp.payload);
                continue;
            }
            if (spec.op === 'edit') {
                const editOp = buildEditFromDynamicToolCall(call, spec);
                if (!editOp.payload) {
                    invalid = true;
                    retryReason = `Edit call invalid for "${spec.id}": ${editOp.invalidReason}`;
                    break;
                }
                const mappedNodeId = String(editOp.payload.nodeId || '').trim();
                const targetNode = editableNodes.get(mappedNodeId);
                if (!targetNode) {
                    invalid = true;
                    retryReason = `Unknown node_id "${mappedNodeId}". Use only ids from graph_data.nodes (editable nodes only).`;
                    break;
                }
                if (String(targetNode?.type || '').trim().toLowerCase() !== String(spec.id || '').trim().toLowerCase()) {
                    invalid = true;
                    retryReason = `node_id "${mappedNodeId}" type mismatch: expected "${spec.id}".`;
                    break;
                }
                calledTypes.add(String(spec.id || '').trim().toLowerCase());
                ops.push(editOp.payload);
                continue;
            }
            const mapped = buildCreateFromDynamicToolCall(call, spec);
            if (mapped.missingRequired.length > 0) {
                invalid = true;
                retryReason = `Type "${spec.id}" missing required columns: ${mapped.missingRequired.join(', ')}.`;
                break;
            }
            const safeTypeId = String(spec.id || '').trim().toLowerCase();
            // The link surface only exists when this request carries it; a node
            // request has no `links` property on the create tool at all.
            if (includeLinks && safeTypeId === 'event') {
                if (!mapped.payload?.hasLinksProp) {
                    invalid = true;
                    retryReason = 'Event create must include links. Use links: [] with no_link_reason if no relation is grounded.';
                    break;
                }
                const eventLinkCount = Array.isArray(mapped.payload?.links) ? mapped.payload.links.length : 0;
                const eventNoLinkReason = normalizeText(mapped.payload?.noLinkReason || '');
                if (eventLinkCount === 0 && !eventNoLinkReason) {
                    invalid = true;
                    retryReason = 'Event create has empty links. Provide no_link_reason when no links are grounded.';
                    break;
                }
            }
            if (mapped.payload) {
                calledTypes.add(safeTypeId);
                ops.push({
                    op: 'create',
                    ...mapped.payload,
                });
            }
        }
        if (invalid) {
            retryCategory = 'invalid';
            continue;
        }
        const missingForceTypes = [...requiredTypes].filter(typeId => !calledTypes.has(typeId));
        if (missingForceTypes.length > 0) {
            retryReason = `Missing force-update type tool calls: ${missingForceTypes.join(', ')}.`;
            retryCategory = 'incomplete';
            continue;
        }
        validatedOps = ops;
        return validatedOps;
    }
    const failureReason = normalizeText(retryReason || String(lastRetryableError?.message || '')) || 'No valid extraction tool calls after retries.';
    throw new Error(failureReason);
}

function upsertSemanticNode(store, item, settings = null, options = {}) {
    const type = String(item.type || 'semantic').toLowerCase();
    let title = normalizeText(item.title || '');
    const explicitNodeId = normalizeText(item?.nodeId || item?.node_id || '');
    const maxSeqLimit = Number.isFinite(Number(options?.maxSeq))
        ? Math.max(0, Math.floor(Number(options.maxSeq)))
        : null;
    const isNodeVisibleAtSeq = (node) => {
        if (!node || node.archived || node.level !== LEVEL.SEMANTIC) {
            return false;
        }
        if (maxSeqLimit === null) {
            return true;
        }
        const nodeSeq = Number(node?.seqTo ?? NaN);
        if (!Number.isFinite(nodeSeq)) {
            return true;
        }
        return nodeSeq <= maxSeqLimit;
    };
    const parseEventSummaryIndex = (value) => {
        const text = normalizeText(value || '');
        if (!text) {
            return null;
        }
        const match = text.match(/^(?:summary|摘要)\s*#?\s*(\d+)$/i);
        if (!match) {
            return null;
        }
        const num = Number(match[1]);
        return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
    };
    const nextEventSummaryTitle = () => {
        let maxIndex = 0;
        for (const node of Object.values(store.nodes || {})) {
            if (!node || node.archived || node.level !== LEVEL.SEMANTIC) {
                continue;
            }
            if (String(node.type || '').toLowerCase() !== 'event') {
                continue;
            }
            const index = parseEventSummaryIndex(node.title);
            if (index && index > maxIndex) {
                maxIndex = index;
            }
        }
        return `Summary ${maxIndex + 1}`;
    };
    const seqTo = Number.isFinite(Number(item.seqTo))
        ? Math.max(0, Math.floor(Number(item.seqTo)))
        : Math.max(0, Number(store.seqCounter || 0));
    const incomingFields = item?.fields && typeof item.fields === 'object' && !Array.isArray(item.fields)
        ? { ...item.fields }
        : {};
    const itemSummary = normalizeText(
        incomingFields.summary
        ?? '',
    );
    // floorRange is stamped only when the type opts in (schema flag) and the
    // caller supplied a valid lower bound; otherwise the field is omitted so
    // legacy callers and edits can't corrupt or shrink an existing range.
    const optsMinSeq = (typeof options?.minSeq === 'number' && Number.isFinite(options.minSeq))
        ? Math.max(0, Math.floor(options.minSeq))
        : null;
    const typeSchemaEntry = settings ? getSemanticTypeSpec(settings, type) : null;
    const shouldRecordFloorRange = Boolean(typeSchemaEntry?.recordsFloorRange);
    const computedFloorRange = (shouldRecordFloorRange && optsMinSeq !== null && optsMinSeq <= seqTo)
        ? { start: optsMinSeq, end: seqTo }
        : null;
    const latestOnlyConfig = settings ? getSemanticLatestOnlyConfig(settings, type) : { enabled: false, keyFields: [] };
    const latestOnlyKeyFields = Array.isArray(latestOnlyConfig.keyFields)
        ? latestOnlyConfig.keyFields.map(column => String(column || '').trim()).filter(Boolean)
        : [];
    const tokenizePrimaryKeyField = (nodeLike, key) => {
        const raw = toDisplayScalar(getTableCellValueFromNode(nodeLike, key));
        if (!raw) {
            return [];
        }
        return String(raw)
            .split(/[,，;；|]/g)
            .map(part => normalizeText(part).toLowerCase())
            .filter(Boolean);
    };
    const computeLatestOnlyMatchScore = (candidateNode) => {
        if (latestOnlyKeyFields.length === 0) {
            return 0;
        }
        const incomingNodeLike = { title, fields: incomingFields };
        let score = 0;
        for (const key of latestOnlyKeyFields) {
            const incomingTokens = tokenizePrimaryKeyField(incomingNodeLike, key);
            const candidateTokens = tokenizePrimaryKeyField(candidateNode, key);
            if (incomingTokens.length === 0 || candidateTokens.length === 0) {
                continue;
            }
            const candidateSet = new Set(candidateTokens);
            if (incomingTokens.some(token => candidateSet.has(token))) {
                score += 1;
            }
        }
        return score;
    };

    let target = null;
    if (explicitNodeId) {
        const explicitTarget = store?.nodes?.[explicitNodeId];
        if (
            isNodeVisibleAtSeq(explicitTarget)
            && String(explicitTarget.type || '').toLowerCase() === type
        ) {
            target = explicitTarget;
        }
    }

    if (type === 'event' && !target) {
        const generatedTitle = nextEventSummaryTitle();
        return createNode(store, {
            type,
            level: LEVEL.SEMANTIC,
            title: generatedTitle,
            fields: incomingFields,
            semanticDepth: 0,
            semanticRollup: false,
            seqTo,
            ...(computedFloorRange ? { floorRange: computedFloorRange } : {}),
        });
    }

    if (!title) {
        const derivedTitle = normalizeText(
            incomingFields?.name
            || incomingFields?.id
            || incomingFields?.key
            || incomingFields?.label
            || '',
        );
        title = derivedTitle || `${type}_${Math.max(1, seqTo || Number(store.seqCounter || 0) || 1)}`;
    }
    if (!target && latestOnlyConfig.enabled) {
        const candidates = Object.values(store.nodes)
            .filter(node => isNodeVisibleAtSeq(node))
            .filter(node => String(node.type || '').toLowerCase() === type)
            .map(node => ({ node, score: computeLatestOnlyMatchScore(node) }))
            .filter(entry => entry.score > 0)
            .sort((a, b) => {
                if (a.score !== b.score) {
                    return b.score - a.score;
                }
                const aSeq = Number(a?.node?.seqTo ?? -1);
                const bSeq = Number(b?.node?.seqTo ?? -1);
                if (aSeq !== bSeq) {
                    return bSeq - aSeq;
                }
                return String(a?.node?.id || '').localeCompare(String(b?.node?.id || ''));
            });
        target = candidates[0]?.node || null;
        for (let i = 1; i < candidates.length; i++) {
            archiveNode(store, candidates[i]?.node?.id, target?.id);
        }
    } else if (!target) {
        const normalizedKey = `${type}::${title.toLowerCase()}`;
        target = Object.values(store.nodes).find(node => isNodeVisibleAtSeq(node) && `${node.type}::${node.title.toLowerCase()}` === normalizedKey);
    }

    if (!target) {
        target = createNode(store, {
            type,
            level: LEVEL.SEMANTIC,
            title,
            fields: incomingFields,
            semanticDepth: 0,
            semanticRollup: false,
            seqTo,
            ...(computedFloorRange ? { floorRange: computedFloorRange } : {}),
        });
    } else {
        setNodeSummary(target, itemSummary || getNodeSummary(target));
        if (!target.fields || typeof target.fields !== 'object' || Array.isArray(target.fields)) {
            target.fields = {};
        }
        if (!Number.isFinite(Number(target.semanticDepth))) {
            target.semanticDepth = 0;
        }
        if (target.semanticRollup === undefined) {
            target.semanticRollup = false;
        }
        if (incomingFields && typeof incomingFields === 'object') {
            Object.assign(target.fields, incomingFields);
        }
        target.seqTo = Math.max(Number(target.seqTo || 0), seqTo);
    }

    return target;
}

function resolveExtractNodeId(store, {
    nodeId = '',
    ref = '',
} = {}, options = {}) {
    const normalizedNodeId = normalizeText(nodeId || '');
    if (normalizedNodeId) {
        const directNode = store?.nodes?.[normalizedNodeId];
        if (directNode && !directNode.archived && directNode.level === LEVEL.SEMANTIC) {
            return normalizedNodeId;
        }
    }
    const normalizedRef = normalizeText(ref || '');
    if (!normalizedRef) {
        return '';
    }
    const refIndex = options?.refIndex instanceof Map ? options.refIndex : null;
    if (!refIndex) {
        return '';
    }
    const refNodeId = normalizeText(refIndex.get(normalizedRef) || '');
    if (!refNodeId) {
        return '';
    }
    const mappedNode = store?.nodes?.[refNodeId];
    if (!mappedNode || mappedNode.archived || mappedNode.level !== LEVEL.SEMANTIC) {
        return '';
    }
    return refNodeId;
}

function applyExtractedLinks(store, sourceNode, rawLinks, options = {}) {
    if (!sourceNode || !Array.isArray(rawLinks) || rawLinks.length === 0) {
        return;
    }

    const rawSeqTo = options?.maxSeq;
    const seqTo = (rawSeqTo !== null && rawSeqTo !== undefined && Number.isFinite(Number(rawSeqTo)))
        ? Math.max(0, Math.floor(Number(rawSeqTo)))
        : undefined;
    const edgeOptions = seqTo !== undefined ? { seqTo } : undefined;

    for (const link of rawLinks) {
        const targetNodeId = resolveExtractNodeId(store, {
            nodeId: link?.targetNodeId || link?.target_node_id || '',
            ref: link?.targetRef || link?.target_ref || '',
        }, options);
        if (!targetNodeId) {
            continue;
        }
        const targetNode = store?.nodes?.[targetNodeId];
        if (!targetNode || targetNode.archived || targetNode.level !== LEVEL.SEMANTIC) {
            continue;
        }

        const relation = normalizeText(link?.relation || 'related') || 'related';
        const direction = String(link?.direction || 'bidirectional').toLowerCase();

        // Symmetric relations collapse to ONE canonical edge (sorted-id
        // from→to). Direction directive is ignored — "A allied_with B" and
        // "B allied_with A" are the same fact, stored once.
        if (SYMMETRIC_RELATIONS.has(relation)) {
            const [canonicalFrom, canonicalTo] = sourceNode.id < targetNode.id
                ? [sourceNode.id, targetNode.id]
                : [targetNode.id, sourceNode.id];
            addEdge(store, canonicalFrom, canonicalTo, relation, edgeOptions);
            continue;
        }

        if (direction === 'incoming') {
            addEdge(store, targetNode.id, sourceNode.id, relation, edgeOptions);
            continue;
        }
        if (direction === 'outgoing') {
            addEdge(store, sourceNode.id, targetNode.id, relation, edgeOptions);
            continue;
        }

        addEdge(store, sourceNode.id, targetNode.id, relation, edgeOptions);
        addEdge(store, targetNode.id, sourceNode.id, relation, edgeOptions);
    }
}

function getSemanticNodesForType(store, type) {
    const targetType = String(type || '').toLowerCase();
    return listNodesByLevel(store, LEVEL.SEMANTIC)
        .filter(node => !node.archived)
        .filter(node => String(node.type || '').toLowerCase() === targetType);
}

function createCompressionStats() {
    return {
        totalRounds: 0,
        byType: {},
    };
}

function recordCompressionRound(stats, type, rounds = 1) {
    if (!stats || typeof stats !== 'object') {
        return;
    }
    const safeType = String(type || '').trim().toLowerCase();
    const safeRounds = Math.max(0, Math.floor(Number(rounds) || 0));
    if (!safeType || safeRounds <= 0) {
        return;
    }
    stats.totalRounds = Math.max(0, Math.floor(Number(stats.totalRounds || 0))) + safeRounds;
    if (!stats.byType || typeof stats.byType !== 'object') {
        stats.byType = {};
    }
    stats.byType[safeType] = Math.max(0, Math.floor(Number(stats.byType[safeType] || 0))) + safeRounds;
}

function getCompressionRoundsByType(stats, type) {
    const safeType = String(type || '').trim().toLowerCase();
    if (!safeType || !stats || typeof stats !== 'object' || !stats.byType || typeof stats.byType !== 'object') {
        return 0;
    }
    return Math.max(0, Math.floor(Number(stats.byType[safeType] || 0)));
}

export function collectSemanticRootsByDepth(store, type, depth, options = {}) {
    const rawMaxSeq = options?.maxSeq;
    const maxSeq = (rawMaxSeq !== null && rawMaxSeq !== undefined && Number.isFinite(Number(rawMaxSeq))) ? Math.max(0, Math.floor(Number(rawMaxSeq))) : null;
    return getSemanticNodesForType(store, type)
        .filter(node => Number(node?.semanticDepth ?? 0) === Number(depth))
        .filter(node => !String(node.parentId || '').trim())
        .filter(node => maxSeq === null || Number(node?.seqTo ?? 0) <= maxSeq)
        .sort((a, b) => {
            const aTo = Number(a.seqTo ?? 0);
            const bTo = Number(b.seqTo ?? 0);
            if (aTo !== bTo) {
                return aTo - bTo;
            }
            return String(a?.id || '').localeCompare(String(b?.id || ''));
        });
}

function collectFlatSemanticRoots(store, type, options = {}) {
    const rawMaxSeq = options?.maxSeq;
    const maxSeq = (rawMaxSeq !== null && rawMaxSeq !== undefined && Number.isFinite(Number(rawMaxSeq))) ? Math.max(0, Math.floor(Number(rawMaxSeq))) : null;
    return getSemanticNodesForType(store, type)
        .filter(node => !String(node.parentId || '').trim())
        .filter(node => maxSeq === null || Number(node?.seqTo ?? 0) <= maxSeq)
        .sort((a, b) => {
            const aTo = Number(a.seqTo ?? 0);
            const bTo = Number(b.seqTo ?? 0);
            if (aTo !== bTo) {
                return aTo - bTo;
            }
            return String(a?.id || '').localeCompare(String(b?.id || ''));
        });
}

function normalizeCompressionRuleToken(raw) {
    return String(raw || '')
        .trim()
        .replace(/^["'`]|["'`]$/g, '')
        .trim()
        .toLowerCase();
}

function parseCompressionRuleValues(rawValues) {
    const source = String(rawValues || '').trim().replace(/^[[({]\s*|\s*[\])}]$/g, '');
    return source
        .split(/[|,]/g)
        .map(item => normalizeCompressionRuleToken(item))
        .filter(Boolean);
}

function parseCompressionRuleClause(rawClause) {
    const text = String(rawClause || '').trim();
    if (!text) {
        return null;
    }
    const existsMatch = text.match(/^(?:has|exists)\s*\(\s*([a-zA-Z0-9_]+)\s*\)$/i);
    if (existsMatch) {
        return { field: String(existsMatch[1]).trim().toLowerCase(), op: 'exists', values: [] };
    }
    const emptyMatch = text.match(/^empty\s*\(\s*([a-zA-Z0-9_]+)\s*\)$/i);
    if (emptyMatch) {
        return { field: String(emptyMatch[1]).trim().toLowerCase(), op: 'empty', values: [] };
    }
    const compareMatch = text.match(/^([a-zA-Z0-9_]+)\s*(=|==|!=|in|not\s+in)\s*(.+)$/i);
    if (!compareMatch) {
        return { raw: text, invalid: true };
    }
    const field = String(compareMatch[1] || '').trim().toLowerCase();
    const opRaw = String(compareMatch[2] || '').trim().toLowerCase();
    const values = parseCompressionRuleValues(compareMatch[3]);
    if (!field || values.length === 0) {
        return { raw: text, invalid: true };
    }
    const op = opRaw === '=' || opRaw === '==' ? 'eq' : opRaw === '!=' ? 'neq' : opRaw.includes('not') ? 'not_in' : 'in';
    return { field, op, values };
}

function getCompressionRuleFieldValue(node, field) {
    const key = String(field || '').trim().toLowerCase();
    if (!key) {
        return '';
    }
    if (key === 'semantic_rollup' || key === 'rollup' || key === 'is_rollup') {
        return String(Boolean(node?.semanticRollup)).toLowerCase();
    }
    if (key === 'semantic_depth' || key === 'depth') {
        return String(Number.isFinite(Number(node?.semanticDepth)) ? Number(node.semanticDepth) : 0);
    }
    if (key === 'seq' || key === 'seq_to') {
        return String(Number.isFinite(Number(node?.seqTo)) ? Number(node.seqTo) : '');
    }
    return normalizeCompressionRuleToken(getTableCellValueFromNode(node, key));
}

function buildCompressionRuleMatcher(ruleText) {
    const text = String(ruleText || '').trim();
    if (!text) {
        return { enabled: false, valid: true, test: () => true, invalid: [] };
    }
    const rawClauses = text
        .split(/\n|&&/g)
        .map(clause => String(clause || '').trim())
        .filter(Boolean);
    if (rawClauses.length === 0) {
        return { enabled: false, valid: true, test: () => true, invalid: [] };
    }
    const clauses = [];
    const invalid = [];
    for (const rawClause of rawClauses) {
        const parsed = parseCompressionRuleClause(rawClause);
        if (!parsed) {
            continue;
        }
        if (parsed.invalid) {
            invalid.push(String(parsed.raw || rawClause));
            continue;
        }
        clauses.push(parsed);
    }
    if (invalid.length > 0 || clauses.length === 0) {
        return { enabled: true, valid: false, test: () => false, invalid };
    }
    return {
        enabled: true,
        valid: true,
        invalid: [],
        test: (node) => {
            for (const clause of clauses) {
                const actual = getCompressionRuleFieldValue(node, clause.field);
                if (clause.op === 'exists') {
                    if (!actual) {
                        return false;
                    }
                    continue;
                }
                if (clause.op === 'empty') {
                    if (actual) {
                        return false;
                    }
                    continue;
                }
                if (clause.op === 'eq') {
                    if (actual !== clause.values[0]) {
                        return false;
                    }
                    continue;
                }
                if (clause.op === 'neq') {
                    if (actual === clause.values[0]) {
                        return false;
                    }
                    continue;
                }
                if (clause.op === 'in') {
                    if (!clause.values.includes(actual)) {
                        return false;
                    }
                    continue;
                }
                if (clause.op === 'not_in') {
                    if (clause.values.includes(actual)) {
                        return false;
                    }
                    continue;
                }
            }
            return true;
        },
    };
}

function getNextSemanticRollupOrdinal(store, type, depth) {
    const targetDepth = Math.max(1, Math.floor(Number(depth || 0)));
    const nodes = getSemanticNodesForType(store, type)
        .filter(node => !node.archived)
        .filter(node => Number(node?.semanticDepth ?? 0) === targetDepth);
    let maxOrdinal = 0;
    const suffixPattern = /#(\d+)\s*$/;
    for (const node of nodes) {
        const title = String(node?.title || '');
        const match = title.match(suffixPattern);
        if (!match) {
            continue;
        }
        const value = Number(match[1]);
        if (Number.isFinite(value) && value > maxOrdinal) {
            maxOrdinal = value;
        }
    }
    if (maxOrdinal > 0) {
        return maxOrdinal + 1;
    }
    return nodes.length + 1;
}

/**
 * Create a rollup node with the given children. Used by both:
 *   - compressSemanticHierarchical (internal compression loop)
 *   - write-api.js::compactNodes (external agent-driven compaction)
 *
 * Throws structured errors:
 *   - { code: 'BAD_ARGS' } when type or childIds missing/empty
 *   - { code: 'CHILD_NOT_FOUND' } when a child id is not in the store
 *   - { code: 'CHILD_HAS_PARENT' } when a child already has a rollup parent of the same type
 */
export function createRollupWithChildren(store, { type, childIds, summary, fields = {}, label = '' } = {}) {
    if (!type || !Array.isArray(childIds) || childIds.length === 0) {
        const err = new Error('createRollupWithChildren requires type and non-empty childIds.');
        err.code = 'BAD_ARGS';
        throw err;
    }
    const children = childIds.map(id => store?.nodes?.[id]).filter(Boolean);
    if (children.length !== childIds.length) {
        const err = new Error('createRollupWithChildren: one or more childIds not in store.');
        err.code = 'CHILD_NOT_FOUND';
        throw err;
    }
    for (const child of children) {
        if (child.parentId) {
            const err = new Error(`createRollupWithChildren: child ${child.id} already has rollup parent ${child.parentId}.`);
            err.code = 'CHILD_HAS_PARENT';
            throw err;
        }
    }
    const childDepths = children.map(c => Number(c.semanticDepth || 0));
    const rollupDepth = Math.max(...childDepths) + 1;
    const ordinal = getNextSemanticRollupOrdinal(store, type, rollupDepth);
    const finalFields = { summary: String(summary || ''), ...fields };
    // Partial-coverage rollup: union the floorRange of children that have a
    // well-formed one, and skip the rest. Legacy children pre-dating the
    // floor-anchor schema flag don't veto the parent's anchor — they just
    // don't contribute to it. Strict typeof === 'number' guards mirror
    // createNode's own floorRange validation upstream.
    const childrenWithFloorRange = children.filter(c => c?.floorRange
        && typeof c.floorRange.start === 'number' && Number.isFinite(c.floorRange.start)
        && typeof c.floorRange.end === 'number' && Number.isFinite(c.floorRange.end));
    const rolledFloorRange = childrenWithFloorRange.length > 0
        ? {
            start: Math.min(...childrenWithFloorRange.map(c => c.floorRange.start)),
            end: Math.max(...childrenWithFloorRange.map(c => c.floorRange.end)),
        }
        : null;
    const parent = createNode(store, {
        type: String(type),
        level: LEVEL.SEMANTIC,
        title: `${String(label || type)} Summary L${rollupDepth} #${ordinal}`,
        fields: finalFields,
        archived: false,
        semanticRollup: true,
        semanticDepth: rollupDepth,
        seqTo: Math.max(...children.map(c => Number(c.seqTo ?? 0))),
        ...(rolledFloorRange ? { floorRange: rolledFloorRange } : {}),
    });
    for (const child of children) {
        reparentNode(store, child.id, parent.id);
        addEdge(store, parent.id, child.id, 'semantic_contains');
    }
    return parent;
}

async function compressSemanticHierarchical(context, store, settings, spec, type, config, options = {}) {
    let changed = false;
    let guard = 0;
    let compressedRounds = 0;
    const forceMode = Boolean(options?.force);
    const maxRoundsPerType = Number.isFinite(Number(options?.maxRoundsPerType))
        ? Math.max(1, Math.floor(Number(options.maxRoundsPerType)))
        : Number.POSITIVE_INFINITY;
    const threshold = forceMode
        ? 2
        : Math.max(2, Number(config.threshold || 2));
    const fanIn = Math.max(2, Number(config.fanIn || 2));
    const ruleMatcher = buildCompressionRuleMatcher(config.rule);
    if (ruleMatcher.enabled && !ruleMatcher.valid) {
        const invalidPart = ruleMatcher.invalid.length > 0 ? ruleMatcher.invalid.join(' | ') : String(config.rule || '');
        console.warn(`[${MODULE_NAME}]`, i18nFormat('Invalid compression rule for type ${0}: ${1}', String(type || 'unknown'), invalidPart));
        return false;
    }

    console.log(`[${MODULE_NAME}] compressSemanticHierarchical: type=${type}, forceMode=${forceMode}, threshold=${threshold}, fanIn=${fanIn}, maxRoundsPerType=${maxRoundsPerType}, maxDepth=${Number(config.maxDepth || 1)}`);
    for (let depth = 0; depth < Number(config.maxDepth || 1); depth++) {
        while (guard < 120 && compressedRounds < maxRoundsPerType) {
            if (isAbortSignalLike(options?.abortSignal) && options.abortSignal.aborted) {
                throw new DOMException('Memory compression aborted.', 'AbortError');
            }
            guard += 1;
            let candidates = collectSemanticRootsByDepth(store, type, depth, options);
            console.log(`[${MODULE_NAME}] compress depth=${depth}, guard=${guard}, candidates=${candidates.length}, ids=[${candidates.slice(0, 5).map(n => n.id).join(',')}${candidates.length > 5 ? ',...' : ''}]`);
            if (ruleMatcher.enabled) {
                candidates = candidates.filter(node => ruleMatcher.test(node));
            }
            if (!forceMode && depth === 0 && Number(config.keepRecentLeaves || 0) > 0 && candidates.length > Number(config.keepRecentLeaves || 0)) {
                candidates = candidates.slice(0, Math.max(0, candidates.length - Number(config.keepRecentLeaves || 0)));
            }
            if (candidates.length < threshold) {
                break;
            }

            const groupSize = forceMode ? Math.min(fanIn, candidates.length) : fanIn;
            if (groupSize < 2) {
                break;
            }
            const group = candidates.slice(0, groupSize);
            if (group.length < groupSize || group.length < 2) {
                break;
            }

            const roundBeforeStore = typeof options?.onRoundApplied === 'function'
                ? normalizeStoreForRuntime(store)
                : null;
            const rollupDepth = depth + 1;
            const lines = group.map(node => `${node.id} | ${node.title}: ${getNodeSummary(node)}`);
            const instruction = buildCompressionSummaryInstruction(
                config.summarizeInstruction
                || `Compress semantic type "${type}" into a higher-level summary node. Keep enduring facts and unresolved hooks.`,
                { depth: rollupDepth, fanIn: group.length },
            );
            const rollupFields = await summarizeRollupFieldsWithLLM(
                context,
                settings,
                spec,
                instruction,
                group,
                options?.abortSignal || null,
            );
            if (!normalizeText(rollupFields?.summary || '')) {
                const fallbackSummary = await summarizeTextWithLLM(
                    context,
                    settings,
                    instruction,
                    lines,
                    options?.abortSignal || null,
                );
                if (fallbackSummary) {
                    rollupFields.summary = fallbackSummary;
                }
            }
            if (!normalizeText(rollupFields?.summary || '')) {
                break;
            }

            const parent = createRollupWithChildren(store, {
                type,
                childIds: group.map(n => n.id),
                summary: rollupFields.summary,
                fields: rollupFields,
                label: config.label,
            });
            changed = true;
            compressedRounds += 1;
            recordCompressionRound(options?.compressionStats, type, 1);
            if (typeof options?.onRoundApplied === 'function' && roundBeforeStore) {
                await options.onRoundApplied({
                    type: String(type || ''),
                    depth,
                    roundSeqTo: Number(parent?.seqTo ?? 0),
                    beforeStore: roundBeforeStore,
                });
            }
        }
        if (compressedRounds >= maxRoundsPerType) {
            break;
        }
    }

    return changed;
}

async function compressSemanticFlat(context, store, settings, spec, type, config, options = {}) {
    let changed = false;
    let guard = 0;
    let compressedRounds = 0;
    const maxRoundsPerType = Number.isFinite(Number(options?.maxRoundsPerType))
        ? Math.max(1, Math.floor(Number(options.maxRoundsPerType)))
        : Number.POSITIVE_INFINITY;
    const threshold = 2;
    const fanIn = Math.max(2, Number(config.fanIn || 2));
    const ruleMatcher = buildCompressionRuleMatcher(config.rule);
    if (ruleMatcher.enabled && !ruleMatcher.valid) {
        const invalidPart = ruleMatcher.invalid.length > 0 ? ruleMatcher.invalid.join(' | ') : String(config.rule || '');
        console.warn(`[${MODULE_NAME}]`, i18nFormat('Invalid compression rule for type ${0}: ${1}', String(type || 'unknown'), invalidPart));
        return false;
    }

    console.log(`[${MODULE_NAME}] compressSemanticFlat: type=${type}, threshold=${threshold}, fanIn=${fanIn}, maxRoundsPerType=${maxRoundsPerType}`);
    while (guard < 120 && compressedRounds < maxRoundsPerType) {
        if (isAbortSignalLike(options?.abortSignal) && options.abortSignal.aborted) {
            throw new DOMException('Memory compression aborted.', 'AbortError');
        }
        guard += 1;
        let candidates = collectFlatSemanticRoots(store, type, options);
        console.log(`[${MODULE_NAME}] flat compress guard=${guard}, candidates=${candidates.length}, ids=[${candidates.slice(0, 5).map(n => `${n.id}@L${Number(n?.semanticDepth ?? 0)}`).join(',')}${candidates.length > 5 ? ',...' : ''}]`);
        if (ruleMatcher.enabled) {
            candidates = candidates.filter(node => ruleMatcher.test(node));
        }
        if (candidates.length < threshold) {
            break;
        }

        const groupSize = Math.min(fanIn, candidates.length);
        if (groupSize < 2) {
            break;
        }
        const group = candidates.slice(0, groupSize);

        const roundBeforeStore = typeof options?.onRoundApplied === 'function'
            ? normalizeStoreForRuntime(store)
            : null;
        // Parent depth follows the "max(child)+1" invariant so subsequent
        // hierarchical compression and depth-based sorts remain coherent.
        const maxChildDepth = group.reduce((max, node) => {
            const d = Number(node?.semanticDepth ?? 0);
            return Number.isFinite(d) && d > max ? d : max;
        }, 0);
        const rollupDepth = maxChildDepth + 1;
        const lines = group.map(node => `${node.id} | ${node.title}: ${getNodeSummary(node)}`);
        const instruction = buildCompressionSummaryInstruction(
            config.summarizeInstruction
            || `Compress semantic type "${type}" into a higher-level summary node. Keep enduring facts and unresolved hooks.`,
            { depth: rollupDepth, fanIn: group.length },
        );
        const rollupFields = await summarizeRollupFieldsWithLLM(
            context,
            settings,
            spec,
            instruction,
            group,
            options?.abortSignal || null,
        );
        if (!normalizeText(rollupFields?.summary || '')) {
            const fallbackSummary = await summarizeTextWithLLM(
                context,
                settings,
                instruction,
                lines,
                options?.abortSignal || null,
            );
            if (fallbackSummary) {
                rollupFields.summary = fallbackSummary;
            }
        }
        if (!normalizeText(rollupFields?.summary || '')) {
            break;
        }

        const rollupOrdinal = getNextSemanticRollupOrdinal(store, type, rollupDepth);
        const parent = createNode(store, {
            type: String(type || 'semantic'),
            level: LEVEL.SEMANTIC,
            title: `${String(config.label || type || 'Semantic')} Summary L${rollupDepth} #${rollupOrdinal}`,
            fields: rollupFields,
            archived: false,
            semanticRollup: true,
            semanticDepth: rollupDepth,
            seqTo: Math.max(...group.map(node => Number(node.seqTo ?? 0))),
        });

        for (const child of group) {
            reparentNode(store, child.id, parent.id);
            addEdge(store, parent.id, child.id, 'semantic_contains');
        }
        changed = true;
        compressedRounds += 1;
        recordCompressionRound(options?.compressionStats, type, 1);
        if (typeof options?.onRoundApplied === 'function' && roundBeforeStore) {
            await options.onRoundApplied({
                type: String(type || ''),
                depth: rollupDepth - 1,
                roundSeqTo: Number(parent?.seqTo ?? 0),
                beforeStore: roundBeforeStore,
            });
        }
    }

    return changed;
}

async function compressSemanticTypesIfNeeded(context, store, settings, options = {}) {
    const schema = getEffectiveNodeTypeSchema(context, settings);
    const selectedTypeSet = Array.isArray(options?.typeIds)
        ? new Set(options.typeIds.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))
        : null;
    const flatten = Boolean(options?.flatten);
    let changed = false;
    for (const spec of schema) {
        const type = String(spec.id || '').toLowerCase();
        if (!type) {
            continue;
        }
        if (selectedTypeSet && !selectedTypeSet.has(type)) {
            continue;
        }
        const config = getSemanticCompressionConfig(settings, type, context);
        if (config.mode === 'none') {
            continue;
        }
        if (flatten) {
            if (await compressSemanticFlat(context, store, settings, spec, type, config, options)) {
                changed = true;
            }
            continue;
        }
        if (config.mode === 'hierarchical') {
            if (await compressSemanticHierarchical(context, store, settings, spec, type, config, options)) {
                changed = true;
            }
        }
    }
    return changed;
}

async function runCompressionLoop(context, store, settings, options = {}) {
    if (!settings?.enabled) return false;
    if (!settings?.autoCompressionEnabled) return false;
    return await compressSemanticTypesIfNeeded(context, store, settings, options);
}

function buildExtractBatchFromFrames(frames, batchStartIndex, batchEndIndex, contextTurns = 1) {
    const source = Array.isArray(frames) ? frames : [];
    const safeStart = Math.max(0, Math.min(source.length - 1, Math.floor(Number(batchStartIndex) || 0)));
    const safeEnd = Math.max(safeStart, Math.min(source.length - 1, Math.floor(Number(batchEndIndex) || safeStart)));
    const windowSize = Math.max(1, Math.min(32, Math.floor(Number(contextTurns) || 1)));
    const contextStartIndex = Math.max(0, safeStart - windowSize);
    const rangeStart = contextStartIndex;
    const rangeEnd = safeEnd;
    const batch = [];

    for (let i = rangeStart; i <= rangeEnd; i++) {
        const frame = source[i];
        if (!frame || typeof frame !== 'object') {
            continue;
        }
        const seq = Number(frame?.seq || 0);
        const lastUserText = normalizeText(frame?.last_user_mes || '');
        if (lastUserText) {
            batch.push({
                seq,
                is_user: true,
                name: String(frame?.last_user_name || ''),
                mes: lastUserText,
                send_date: String(frame?.last_user_send_date || ''),
                source_index: typeof frame?.last_user_source_index === 'number' ? frame.last_user_source_index : -1,
            });
        }
        const assistantText = normalizeText(frame?.mes || '');
        if (!assistantText) {
            continue;
        }
        batch.push({
            seq,
            is_user: Boolean(frame?.is_user),
            name: String(frame?.name || ''),
            mes: assistantText,
            send_date: String(frame?.send_date || ''),
            source_index: typeof frame?.source_index === 'number' ? frame.source_index : -1,
        });
    }

    return batch;
}

const CRAWL_READ_TOOL_NAMES = new Set([
    'luker_rpg_extract_crawl_inspect',
    'luker_rpg_extract_crawl_neighbors',
    'luker_rpg_extract_crawl_search',
    'luker_rpg_extract_crawl_done',
]);

function buildExtractionCrawlTools() {
    return [
        {
            type: 'function',
            function: {
                name: 'luker_rpg_extract_crawl_inspect',
                description: 'Inspect one existing memory node in full. Use before editing or when its current fields are needed.',
                parameters: { type: 'object', properties: { node_id: { type: 'string' } }, required: ['node_id'], additionalProperties: false },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_rpg_extract_crawl_neighbors',
                description: 'Crawl from a known node through semantic graph edges. Returns bounded neighbor briefs; use for historical continuity or related events.',
                parameters: {
                    type: 'object',
                    properties: {
                        node_id: { type: 'string' },
                        edge_types: { type: 'array', items: { type: 'string' } },
                        limit: { type: 'integer', minimum: 1, maximum: 20 },
                    },
                    required: ['node_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_rpg_extract_crawl_search',
                description: 'Search the complete graph for a named entity or topic, useful when a relevant old node is not in the initial candidate list.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        types: { type: 'array', items: { type: 'string' } },
                        limit: { type: 'integer', minimum: 1, maximum: 20 },
                    },
                    required: ['query'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_rpg_extract_crawl_done',
                description: 'Finish graph exploration. Call this when the local graph slice is sufficient for extraction.',
                parameters: { type: 'object', properties: { reason: { type: 'string' } }, additionalProperties: false },
            },
        },
    ];
}

function extractCrawlBrief(node, readApi, visibleIds) {
    if (!node?.id) return null;
    return readApi.getNodeBrief(String(node.id), {
        visibleNodeIds: visibleIds,
        edgeSummaryLimit: 6,
    });
}

// Fallback row builder when getNodeBrief can't serve a node (missing spec,
// diagnostic nodes, etc). Kept to the same 5-field compact shape so crawl
// graph_data rows stay uniform even on the degraded path.
function buildCrawlBriefRow(node) {
    if (!node?.id) return null;
    return {
        id: String(node.id || ''),
        type: String(node.type || ''),
        title: String(node.title || ''),
        seqTo: Number(node.seqTo || 0),
        semanticDepth: Number(node.semanticDepth || 0),
    };
}

async function buildExtractionCrawlGraph(context, store, settings, schema, messageBatch, options = {}) {
    const { getMemoryGraphReadApi } = await import('./read-api.js');
    const readApi = getMemoryGraphReadApi(store, context);
    const limit = Math.max(10, Math.min(100, Math.floor(Number(settings?.extractCrawlCandidateLimit) || 40)));
    const maxReads = Math.max(1, Math.min(30, Math.floor(Number(settings?.extractCrawlMaxReads) || 12)));
    const maxRounds = Math.max(1, Math.min(5, Math.floor(Number(settings?.extractCrawlMaxRounds) || 3)));
    // as-of cutoff: the rebuild-from-seq replay path calls this against a live
    // store that already contains nodes from AFTER the batch being extracted.
    // Every store read below must honor maxSeq or future graph state leaks
    // into a historical batch (see buildGraphNodeHints maxSeq handling).
    const maxSeq = Number.isFinite(Number(options?.maxSeq))
        ? Math.max(0, Math.floor(Number(options.maxSeq)))
        : null;
    const isAsOfNode = (node) => {
        if (!node || node.archived || isRecallDiagnosticNode(node)) return false;
        if (maxSeq === null) return true;
        const seq = Number(node?.seqTo ?? NaN);
        return !Number.isFinite(seq) || seq <= maxSeq;
    };
    const messageText = (Array.isArray(messageBatch) ? messageBatch : [])
        .map(item => `${item?.is_user ? 'user' : 'assistant'}: ${String(item?.mes || '')}`)
        // Skip empty/placeholder turns ("user: hi" etc) that carry no extractable
        // scene content; the round-trip cost of a turn must buy at least a
        // short clause of content to be worth prompt tokens.
        .filter(item => item.trim().length > 8)
        .join('\n');
    const visibleCandidates = Array.from(readApi.listVisibleCandidates({ excludeRecentMessages: 0, seqWindow: maxSeq === null ? undefined : { to: maxSeq } }) || [])
        .filter(isAsOfNode)
        .slice(0, limit);
    const candidates = visibleCandidates
        .map(node => extractCrawlBrief({ id: node?.id }, readApi, undefined) || buildCrawlBriefRow(node))
        .filter(node => node && node.id);
    const selected = new Map();
    const readKeys = new Set();
    const observations = [];
    const tools = buildExtractionCrawlTools();
    const systemPrompt = String(settings?.extractCrawlSystemPrompt || '').trim() || DEFAULT_CRAWL_SYSTEM_PROMPT;
    let round = 0;
    while (round < maxRounds) {
        round += 1;
        if (isAbortSignalLike(options?.abortSignal) && options.abortSignal.aborted) {
            throw new DOMException('Memory extraction aborted.', 'AbortError');
        }
        const prompt = [
            `<dialogue_batch>\n${messageText}\n</dialogue_batch>`,
            buildJsonXmlSection('candidate_nodes', candidates),
            observations.length > 0 ? buildJsonXmlSection('crawl_observations', observations) : '',
            `Exploration round ${round}/${maxRounds}. Reads used: ${readKeys.size}/${maxReads}.`,
            'Call one or more read tools, or call luker_rpg_extract_crawl_done.',
        ].filter(Boolean).join('\n\n');
        const calls = await requestToolCallsWithRetry(context, settings, {
            taskMessages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
            apiPresetName: settings.extractApiPresetName || '',
            llmPresetName: settings.extractPresetName || '',
            tools,
            allowedNames: CRAWL_READ_TOOL_NAMES,
            // Crawl is a read-only warm-up; unlike the extract pass there is no
            // semantic-retry loop around this call, so transient tool-parse
            // failures fall back to the user's toolCallRetryMax instead of
            // hard-failing the whole extraction.
            retriesOverride: Math.max(0, Math.floor(Number(settings?.toolCallRetryMax) || 0)),
            abortSignal: options?.abortSignal || null,
        });
        let done = false;
        for (const call of calls) {
            const name = String(call?.name || '');
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            if (name === 'luker_rpg_extract_crawl_done') {
                done = true;
                continue;
            }
            if (readKeys.size >= maxReads) {
                observations.push({ tool: 'budget', result: 'Read budget exhausted; finalize exploration.' });
                done = true;
                continue;
            }
            // Tool failures push a structured error observation so the LLM sees
            // why a call produced nothing; silent no-ops historically caused
            // model loops (see iter-studio noop/error contract).
            let result = null;
            let error = null;
            if (name === 'luker_rpg_extract_crawl_inspect') {
                const id = String(args.node_id || '').trim();
                if (!id) {
                    error = 'invalid_args: node_id is required.';
                } else if (readKeys.has(`inspect:${id}`)) {
                    error = 'already_read: node was inspected earlier; refer to crawl_observations instead of re-reading.';
                } else {
                    const node = readApi.getNode(id);
                    if (!node) {
                        error = `not_found: node_id "${id}" does not exist. Use search to locate the correct id.`;
                    } else if (!isAsOfNode(node)) {
                        error = `not_found: node_id "${id}" exists outside the extraction seq window (seqTo > ${maxSeq}). Do not reference it.`;
                    } else {
                        result = {
                            id: node.id,
                            type: node.type,
                            title: node.title,
                            fields: node.fields,
                            seqTo: node.seqTo,
                            semanticDepth: node.semanticDepth,
                            parentId: node.parentId,
                            childrenIds: node.childrenIds,
                        };
                        const brief = readApi.getNodeBrief(id, { visibleNodeIds: undefined, edgeSummaryLimit: 8 });
                        if (brief) selected.set(`node:${id}`, brief);
                        readKeys.add(`inspect:${id}`);
                    }
                }
            } else if (name === 'luker_rpg_extract_crawl_neighbors') {
                const id = String(args.node_id || '').trim();
                if (!id) {
                    error = 'invalid_args: node_id is required.';
                } else if (readKeys.has(`neighbors:${id}`)) {
                    error = 'already_read: neighbors of this node were fetched earlier; refer to crawl_observations.';
                } else {
                    const neighbors = readApi.getNeighbors(id, { edgeTypes: args.edge_types, projectTo: 'raw' });
                    const asOfNeighbors = Array.from(neighbors || []).filter(item => isAsOfNode(item?.node));
                    if (asOfNeighbors.length === 0) {
                        error = `not_found: node_id "${id}" has no matching neighbors.`;
                    } else {
                        result = asOfNeighbors.slice(0, Math.max(1, Math.min(20, Number(args.limit) || 10))).map(item => ({ // cap-ok: neighbor briefs feed the crawl prompt verbatim; bounded rows keep one tool result inside typical tool-output context limits
                            id: item?.node?.id, type: item?.node?.type, title: item?.node?.title,
                            edge_type: item?.edgeType, direction: item?.direction,
                        }));
                        readKeys.add(`neighbors:${id}`);
                    }
                }
            } else if (name === 'luker_rpg_extract_crawl_search') {
                const query = String(args.query || '').trim();
                if (!query) {
                    error = 'invalid_args: query is required.';
                } else if (readKeys.has(`search:${query.toLowerCase()}`)) {
                    error = 'already_read: this exact query was searched earlier; refer to crawl_observations.';
                } else {
                    const hits = readApi.keywordSearch({ query, types: args.types, k: Math.max(1, Math.min(20, Number(args.limit) || 10)) }); // cap-ok: search hits feed the crawl prompt verbatim; bounded rows keep one tool result inside typical tool-output context limits
                    const asOfHits = Array.from(hits || []).filter(isAsOfNode);
                    if (asOfHits.length === 0) {
                        error = 'not_found: no nodes match this query. Try different keywords or proceed without it.';
                        result = null;
                    } else {
                        result = asOfHits.map(node => ({ id: node.id, type: node.type, title: node.title, seqTo: node.seqTo }));
                        readKeys.add(`search:${query.toLowerCase()}`);
                    }
                }
            }
            if (error) {
                observations.push({ tool: name, args, result: null, error });
                continue;
            }
            if (result) {
                observations.push({ tool: name, args, result });
                const rows = Array.isArray(result) ? result : [result];
                for (const row of rows) {
                    const id = String(row?.id || '').trim();
                    if (id && !selected.has(`node:${id}`)) {
                        const brief = extractCrawlBrief({ id }, readApi, undefined) || buildCrawlBriefRow(store?.nodes?.[id]);
                        if (brief) selected.set(`node:${id}`, brief);
                    }
                }
            }
        }
        if (done || calls.length === 0) break;
    }
    const nodeMap = new Map();
    for (const item of candidates) nodeMap.set(String(item.id), item);
    for (const value of selected.values()) {
        if (value && value.id) nodeMap.set(String(value.id), value);
    }
    const nodes = Array.from(nodeMap.values()).slice(0, limit + maxReads * 2);
    const ids = new Set(nodes.map(node => String(node.id || '')).filter(Boolean));
    const edges = readApi.projectEdges({ visibleNodeIds: ids, excludeInternal: false });
    // True as-of graph total, not the crawl slice size. The extraction prompt
    // tells the LLM "omitted nodes may exist"; that guardrail only works if
    // this number reflects how much of the graph was actually withheld.
    const semanticNodeTotal = listNodesByLevel(store, LEVEL.SEMANTIC)
        .filter(node => !node?.archived)
        .filter(node => !isRecallDiagnosticNode(node))
        .filter((node) => {
            if (maxSeq === null) return true;
            const seq = Number(node?.seqTo ?? NaN);
            return !Number.isFinite(seq) || seq <= maxSeq;
        })
        .length;
    return {
        initialized: nodes.length > 0,
        editable_type_ids: schema.filter(item => item?.editable).map(item => String(item.id || '').toLowerCase()).filter(Boolean),
        projection_policy: { hierarchical_types: 'top_level_rollups_only', non_hierarchical_types: 'crawled_local_slice' },
        graph_scope: 'crawled_local_slice',
        semantic_node_total: semanticNodeTotal,
        visible_node_count: nodes.length,
        nodes,
        edges: Array.from(edges || []).map(edge => ({ from: edge.from, to: edge.to, type: edge.type, weight: Math.max(1, Number(edge.weight || 1)) })),
    };
}

/**
 * Project the nodes this round created or updated, in operation order, into the
 * same row shape `graph_data.nodes` uses. The edge request carries the result as
 * `<round_nodes>` so the edge decision can use the ids the node stage just
 * created as link endpoints — the projected graph may have folded or omitted
 * them. A node already listed under `created` is not repeated under `updated`.
 *
 * @param {object} store working store, already carrying the applied ops
 * @param {Array<object>} schema effective node type schema
 * @param {Array<object>} appliedOps ops the node stage applied
 * @returns {{ created: object[], updated: object[] }}
 */
function buildRoundNodeRows(store, schema, appliedOps) {
    const schemaMap = new Map(
        (Array.isArray(schema) ? schema : [])
            .map(item => [String(item?.id || '').trim().toLowerCase(), item]),
    );
    const created = [];
    const updated = [];
    const createdIds = new Set();
    for (const op of Array.isArray(appliedOps) ? appliedOps : []) {
        const nodeId = String(op?.nodeId || '').trim();
        if (!nodeId) {
            continue;
        }
        const node = store?.nodes?.[nodeId];
        if (!node) {
            continue;
        }
        const kind = String(op?.op || '').trim().toLowerCase();
        if (kind === 'create') {
            if (createdIds.has(nodeId)) {
                continue;
            }
            createdIds.add(nodeId);
            created.push(buildGraphNodeRow(node, schemaMap));
        } else if (kind === 'edit') {
            if (createdIds.has(nodeId)) {
                continue;
            }
            updated.push(buildGraphNodeRow(node, schemaMap));
        }
    }
    return { created, updated };
}

/**
 * Run one extraction round as a node stage and an edge stage.
 *
 * The node stage sends one request per active type, all in flight at once, each
 * carrying only its own type's rules and create tool. Every request reads the
 * same round-opening snapshot (`readStore`), so concurrent requests cannot see
 * each other's writes; their operations are applied to `store` in schema order
 * once all settle. Any node request failing throws, and `runExtractionForStore`
 * discards the whole working copy.
 *
 * The edge stage then sends one request carrying the round's node list, so it
 * can link nodes by id — node ids are assigned when the ops apply, so the round's
 * new nodes already have them. It runs even when no type is active, because
 * edges between existing nodes can still change.
 *
 * @param {object} options
 * @param {Function} [options.onPhaseProgress] receives `{ stage, done, total }`
 * @returns {Promise<{ processed: boolean, changed: boolean }>}
 */
async function processConcurrentBatch(context, store, settings, schema, extractBatch, {
    maxSeq,
    minSeq,
    abortSignal,
    rebuildCreateOnly,
    onPhaseProgress,
} = {}) {
    const readStore = normalizeStoreForRuntime(store);
    const cadenceSeq = Number.isFinite(Number(maxSeq)) ? Number(maxSeq) : 0;
    const activeTypes = computeActiveExtractionTypes(schema, cadenceSeq);
    const crawlMode = String(settings?.extractMode || '').toLowerCase() === 'crawl';
    const buildCrawl = async () => (crawlMode
        ? await buildExtractionCrawlGraph(context, readStore, settings, schema, extractBatch, { maxSeq, abortSignal })
        : null);
    const forceTypes = new Set(schema
        .filter(item => item?.forceUpdate)
        .map(item => String(item?.id || '').trim().toLowerCase())
        .filter(Boolean));
    const reportProgress = typeof onPhaseProgress === 'function' ? onPhaseProgress : () => {};
    let changed = false;
    const nodeTypes = [...activeTypes];
    let nodesSettled = 0;
    reportProgress({ stage: 'nodes', done: 0, total: nodeTypes.length });
    const nodePhase = nodeTypes.map(async (typeId) => {
        const operations = await extractNodesWithLLM(context, readStore, settings, schema, extractBatch, {
            maxSeq,
            abortSignal,
            rebuildCreateOnly,
            crawlGraph: await buildCrawl(),
            types: new Set([typeId]),
            includeEdges: false,
            includeLinks: false,
            requiredTypes: forceTypes.has(typeId) ? new Set([typeId]) : new Set(),
        });
        return { typeId, operations };
    });
    for (const pending of nodePhase) {
        const bump = () => reportProgress({ stage: 'nodes', done: ++nodesSettled, total: nodeTypes.length });
        pending.then(bump, bump);
    }
    const settled = await Promise.allSettled(nodePhase);
    const failed = settled.find(entry => entry.status === 'rejected');
    if (failed) {
        throw failed.reason;
    }
    const appliedOps = [];
    for (const entry of settled) {
        const operations = entry.value.operations;
        if (operations.length === 0) {
            continue;
        }
        const appliedReport = applyExtractionOpsImpl(store, operations, { maxSeq, minSeq, context, settings });
        assertExtractionOpsApplied(appliedReport);
        appliedOps.push(...appliedReport.applied);
        changed = true;
    }
    reportProgress({ stage: 'edges', done: 0, total: 1 });
    const edgeOperations = await extractNodesWithLLM(context, readStore, settings, schema, extractBatch, {
        maxSeq,
        abortSignal,
        rebuildCreateOnly,
        crawlGraph: await buildCrawl(),
        types: new Set(),
        includeEdges: true,
        includeLinks: true,
        allowEmptyTypes: true,
        requiredTypes: new Set(),
        roundNodes: buildRoundNodeRows(store, schema, appliedOps),
    });
    if (edgeOperations.length > 0) {
        const applied = applyExtractionOpsImpl(store, edgeOperations, { maxSeq, minSeq, context, settings });
        assertExtractionOpsApplied(applied);
        changed = true;
    }
    return { processed: true, changed };
}

async function processPendingMessageBatchWithLLM(context, store, settings, schema, frames, batchStartIndex, batchEndIndex, options = {}) {
    const source = Array.isArray(frames) ? frames : [];
    const safeStart = Math.max(0, Math.min(source.length - 1, Math.floor(Number(batchStartIndex) || 0)));
    const safeEnd = Math.max(safeStart, Math.min(source.length - 1, Math.floor(Number(batchEndIndex) || safeStart)));
    const endFrame = source[safeEnd];
    if (!endFrame || typeof endFrame !== 'object') {
        return { processed: false, changed: false };
    }
    const extractBatch = [];
    const contextTurns = Math.max(1, Math.min(32, Number(settings?.extractContextTurns || 1)));
    extractBatch.push(...buildExtractBatchFromFrames(frames, safeStart, safeEnd, contextTurns));
    const endFrameSeq = Number(endFrame?.seq || 0);
    const extractionMaxSeq = Number.isFinite(endFrameSeq) ? Math.max(0, Math.floor(endFrameSeq)) : null;
    const startFrame = source[safeStart];
    const startFrameSeq = Number(startFrame?.seq || 0);
    const extractionMinSeq = Number.isFinite(startFrameSeq) ? Math.max(0, Math.floor(startFrameSeq)) : null;
    if (settings?.extractConcurrent === true) {
        return await processConcurrentBatch(context, store, settings, schema, extractBatch, {
            maxSeq: extractionMaxSeq,
            minSeq: extractionMinSeq,
            abortSignal: options?.abortSignal || null,
            rebuildCreateOnly: Boolean(options?.rebuildCreateOnly),
            onPhaseProgress: options?.onPhaseProgress,
        });
    }
    const operations = await extractNodesWithLLM(context, store, settings, schema, extractBatch, {
        maxSeq: extractionMaxSeq,
        abortSignal: options?.abortSignal || null,
        rebuildCreateOnly: Boolean(options?.rebuildCreateOnly),
        crawlGraph: String(settings?.extractMode || '').toLowerCase() === 'crawl'
            ? await buildExtractionCrawlGraph(context, store, settings, schema, extractBatch, { maxSeq: extractionMaxSeq, abortSignal: options?.abortSignal || null })
            : null,
    });
    if (operations.length === 0) {
        return { processed: true, changed: false };
    }

    const applied = applyExtractionOpsImpl(store, operations, {
        maxSeq: extractionMaxSeq,
        minSeq: extractionMinSeq,
        context,
        settings,
    });
    assertExtractionOpsApplied(applied);

    return { processed: true, changed: true };
}

/**
 * Apply a batch of extraction operations to a memory-graph store in place.
 *
 * Used by both the internal LLM-driven extraction pipeline
 * (`processPendingMessageBatchWithLLM`) and by the public write API
 * (`write-api.js`, Task 19). The function mutates `store` and returns a
 * report of which ops applied vs. which were rejected; it never throws on
 * individual op failures, so the caller decides whether a rejection is
 * fatal (`assertExtractionOpsApplied` for the extraction pipeline, the
 * reported `rejected` list for the public write API).
 *
 * Supported op shapes (matches the in-tree extraction tool schema):
 *   - { op: 'create', type, title, fields, ref?, links?, nodeId? } — upsert
 *     a semantic node via `upsertSemanticNode`; `ref` is recorded in a
 *     per-batch ref→nodeId map so subsequent `link_upsert` ops can target
 *     freshly-created nodes by ref.
 *   - { op: 'edit', nodeId, type, setFields?, clearFields?, hasTitlePatch?, title? }
 *     — patch fields / title on an existing semantic node.
 *   - { op: 'delete', nodeId } — drop a node and its edges.
 *   - { op: 'link_upsert', sourceNodeId?|sourceRef?, links: [...] } — deferred
 *     until after the create pass so refs from sibling ops resolve.
 *   - { op: 'link_delete', sourceNodeId, targetNodeId, relation, direction? }
 *     — remove a directed/bidirectional edge.
 *
 * @param {object} store - memory-graph store, mutated in place
 * @param {Array<object>} operations - op records produced by extraction
 * @param {object} [opts]
 * @param {number} [opts.maxSeq=0] - extraction seq ceiling for new/edited node seqTo
 * @param {number} [opts.minSeq=null] - extraction-window lower bound; threaded
 *     into `upsertSemanticNode` so node types whose schema opts in via
 *     `recordsFloorRange:true` (default: `event`) record `floorRange={start,end}`
 * @param {object} [opts.context] - accepted for caller parity; currently unused inside
 * @param {object} [opts.settings] - effective settings (threaded into `upsertSemanticNode`)
 * @returns {{ applied: object[], rejected: object[] }}
 */
export function applyExtractionOpsImpl(store, operations, {
    maxSeq = 0,
    minSeq = null,
    context = null,
    settings = null,
} = {}) {
    const applied = [];
    const rejected = [];
    if (!Array.isArray(operations) || operations.length === 0) {
        return { applied, rejected };
    }
    const extractionMaxSeq = Number.isFinite(Number(maxSeq))
        ? Math.max(0, Math.floor(Number(maxSeq)))
        : 0;
    // Strict typeof === 'number' parallel to createNode's floorRange validation
    // (see A2): `Number(null) === 0`, `Number('') === 0`, `Number(true) === 1`
    // — none of which mean "the caller gave me a real lower bound". Treat
    // anything that wasn't already typed `number` as absent.
    const extractionMinSeq = (typeof minSeq === 'number' && Number.isFinite(minSeq))
        ? Math.max(0, Math.floor(minSeq))
        : null;
    const extractionRefIndex = new Map();
    const pendingLinkJobs = [];

    for (const item of operations) {
        const op = String(item?.op || 'create').trim().toLowerCase();
        try {
            if (op === 'delete') {
                const nodeId = String(item?.nodeId || '').trim();
                if (!nodeId) {
                    rejected.push({ op: item, error: { code: 'VALIDATION_SKIP', message: 'delete requires nodeId.' } });
                    continue;
                }
                const targetNode = store?.nodes?.[nodeId];
                if (!targetNode) {
                    rejected.push({ op: item, error: { code: 'NODE_NOT_FOUND', message: `delete: node ${nodeId} does not exist.` } });
                    continue;
                }
                dropNode(store, nodeId, true);
                applied.push(item);
                continue;
            }
            if (op === 'edit') {
                const nodeId = String(item?.nodeId || '').trim();
                if (!nodeId) {
                    rejected.push({ op: item, error: { code: 'VALIDATION_SKIP', message: 'edit requires nodeId.' } });
                    continue;
                }
                const targetNode = store?.nodes?.[nodeId];
                if (!targetNode) {
                    rejected.push({ op: item, error: { code: 'NODE_NOT_FOUND', message: `edit: node ${nodeId} does not exist.` } });
                    continue;
                }
                if (targetNode.archived) {
                    rejected.push({ op: item, error: { code: 'NODE_ARCHIVED', message: `edit: node ${nodeId} is archived.` } });
                    continue;
                }
                if (targetNode.level !== LEVEL.SEMANTIC) {
                    rejected.push({ op: item, error: { code: 'NODE_NOT_SEMANTIC', message: `edit: node ${nodeId} is not a semantic node (level=${targetNode.level || 'unknown'}).` } });
                    continue;
                }
                // Type-match guard: only enforced when the op explicitly
                // declares a type. The internal extraction pipeline always
                // passes one (defensive cross-check against a misaddressed
                // LLM op); the public write-api path does NOT — the caller
                // already named the node by id, so re-asserting the type
                // would just silently drop legitimate edits.
                const claimedType = String(item?.type || '').trim().toLowerCase();
                if (claimedType && String(targetNode.type || '').toLowerCase() !== claimedType) {
                    rejected.push({ op: item, error: { code: 'TYPE_MISMATCH', message: `edit: op type "${claimedType}" does not match node ${nodeId} type "${targetNode.type}".` } });
                    continue;
                }
                const setFields = item?.setFields && typeof item.setFields === 'object' && !Array.isArray(item.setFields)
                    ? item.setFields
                    : {};
                const clearFields = Array.isArray(item?.clearFields)
                    ? item.clearFields.map(key => String(key || '').trim()).filter(Boolean)
                    : [];
                if (!targetNode.fields || typeof targetNode.fields !== 'object' || Array.isArray(targetNode.fields)) {
                    targetNode.fields = {};
                }
                if (item?.hasTitlePatch) {
                    const patchedTitle = normalizeText(item?.title || '');
                    if (patchedTitle) {
                        targetNode.title = patchedTitle;
                    }
                }
                for (const [key, value] of Object.entries(setFields)) {
                    if (value === undefined || value === null) {
                        continue;
                    }
                    targetNode.fields[key] = value;
                }
                for (const key of clearFields) {
                    delete targetNode.fields[key];
                }
                targetNode.seqTo = Math.max(Number(targetNode.seqTo || 0), Number(extractionMaxSeq || 0));
                applied.push(item);
                continue;
            }
            if (op === 'link_upsert') {
                pendingLinkJobs.push({
                    sourceNodeId: normalizeText(item?.sourceNodeId || ''),
                    sourceRef: normalizeText(item?.sourceRef || ''),
                    links: Array.isArray(item?.links) ? item.links : [],
                    raw: item,
                });
                continue;
            }
            if (op === 'link_delete') {
                const sourceNodeId = String(item?.sourceNodeId || '').trim();
                const targetNodeId = String(item?.targetNodeId || '').trim();
                const relation = String(item?.relation || '').trim().toLowerCase();
                const directionRaw = String(item?.direction || 'bidirectional').toLowerCase();
                const direction = ['outgoing', 'incoming', 'bidirectional'].includes(directionRaw)
                    ? directionRaw
                    : 'bidirectional';
                if (sourceNodeId && targetNodeId && relation) {
                    removeEdge(store, sourceNodeId, targetNodeId, relation, { direction });
                    applied.push(item);
                } else {
                    rejected.push({ op: item, error: { code: 'VALIDATION_SKIP', message: 'link_delete requires sourceNodeId, targetNodeId, and relation.' } });
                }
                continue;
            }
            // op === 'create' (default)
            const type = String(item?.type || 'semantic').toLowerCase();
            const title = normalizeText(item?.title || '');
            if (!type) {
                continue;
            }
            const targetNode = upsertSemanticNode(store, {
                type,
                nodeId: String(item?.nodeId || ''),
                title,
                fields: item?.fields && typeof item.fields === 'object' ? item.fields : {},
                seqTo: extractionMaxSeq,
            }, settings, { maxSeq: extractionMaxSeq, minSeq: extractionMinSeq });
            if (targetNode) {
                const ref = normalizeText(item?.ref || '');
                if (ref) {
                    extractionRefIndex.set(ref, targetNode.id);
                }
                pendingLinkJobs.push({
                    sourceNodeId: targetNode.id,
                    sourceRef: '',
                    links: Array.isArray(item?.links) ? item.links : [],
                    raw: item,
                });
                // Carry the resolved node id so write-api can report the real
                // node (create may merge into an existing latestOnly target).
                applied.push({ ...item, nodeId: targetNode.id });
            }
        } catch (err) {
            rejected.push({
                op: item,
                error: { code: err?.code || 'OP_FAILED', message: String(err?.message || err) },
            });
        }
    }

    for (const job of pendingLinkJobs) {
        try {
            const sourceNodeId = resolveExtractNodeId(store, {
                nodeId: job?.sourceNodeId || '',
                ref: job?.sourceRef || '',
            }, { refIndex: extractionRefIndex });
            if (!sourceNodeId) {
                continue;
            }
            const sourceNode = store?.nodes?.[sourceNodeId];
            if (!sourceNode || sourceNode.archived || sourceNode.level !== LEVEL.SEMANTIC) {
                continue;
            }
            applyExtractedLinks(
                store,
                sourceNode,
                Array.isArray(job?.links) ? job.links : [],
                { maxSeq: extractionMaxSeq, refIndex: extractionRefIndex },
            );
            // link_upsert ops surface as applied here; create ops were already counted above.
            if (job?.raw && String(job.raw.op || '').toLowerCase() === 'link_upsert') {
                applied.push(job.raw);
            }
        } catch (err) {
            rejected.push({
                op: job?.raw || { op: 'link_upsert', ...job },
                error: { code: err?.code || 'OP_FAILED', message: String(err?.message || err) },
            });
        }
    }

    // `context` is accepted for future use (Task 19 write-api) but currently has
    // no in-loop consumers; reference it to keep static analysis honest.
    void context;

    return { applied, rejected };
}

/**
 * Fail the extraction batch when any operation was rejected.
 *
 * The extraction pipeline applies a batch and then commits its seq
 * watermark; a rejection means part of the batch never reached the store,
 * so committing the watermark would drop that content permanently. The
 * batch loop wraps each attempt in a rollback snapshot, so throwing here
 * rolls the partial batch back and retries it.
 *
 * @param {{ applied: object[], rejected: Array<{ op: object, error: { code: string, message: string } }> }} result
 *     report returned by `applyExtractionOpsImpl`
 * @throws {Error} when `result.rejected` is non-empty
 */
export function assertExtractionOpsApplied(result) {
    if (result.rejected.length === 0) {
        return;
    }
    const { error } = result.rejected[0];
    throw new Error(
        `Extraction operations rejected: ${result.rejected.length} (first: ${error.code} ${error.message})`,
    );
}

async function runExtractionForStore(context, store, {
    force = false,
    startSeq = null,
    showCompressionToast = true,
    abortSignal = null,
    onBatchStart = null,
    onBatchApplied = null,
    onCompressionApplied = null,
    onPhaseProgress = null,
    rebuildCreateOnly = false,
    getEffectiveLatestSeq = null,
} = {}) {
    const settings = getEffectiveSettings(context, getSettings());
    const window = computeExtractionWindow(context, store, startSeq, settings);
    const frames = window.frames;
    const latestSeq = window.latestSeq;
    const coveredSeqTo = window.coveredSeqTo;
    if (coveredSeqTo !== Math.max(0, Math.floor(Number(store.appliedSeqTo || 0)))) {
        store.appliedSeqTo = coveredSeqTo;
    }
    const beginSeq = window.beginSeq;
    if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
        throw new DOMException('Memory extraction aborted.', 'AbortError');
    }
    if (beginSeq > latestSeq) {
        store.appliedSeqTo = latestSeq;
        store.seqCounter = latestSeq;
        store.lastExtractionDebug = {
            beginSeq,
            latestSeq,
            coveredSeqTo,
            extracted: false,
            reason: 'already_up_to_date',
            at: Date.now(),
        };
        return false;
    }

    if (!force) {
        const gap = Number(window.gap || 0);
        if (gap < Number(settings.updateEvery || 1)) {
            store.lastExtractionDebug = {
                beginSeq,
                latestSeq,
                coveredSeqTo,
                extracted: false,
                reason: 'gap_below_threshold',
                at: Date.now(),
            };
            return false;
        }
    }

    const schema = getEffectiveNodeTypeSchema(context, settings);
    const compressionStats = createCompressionStats();
    const frameErrorRetries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    const extractBatchTurns = Math.max(
        1,
        Math.floor(Number(settings?.extractBatchTurns || defaultSettings.extractBatchTurns || 1)),
    );
    const historyChatKey = String(getChatKey(context) || '').trim();
    let extractedAny = false;
    let processedSeqTo = coveredSeqTo;
    for (let i = beginSeq - 1; ; i += extractBatchTurns) {
        if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
            throw new DOMException('Memory extraction aborted.', 'AbortError');
        }
        // Re-read the effective upper bound every batch so external
        // signals (currently `activeExtractionScope.latestSeq` shrunk
        // by `applyMutationInvalidationImpl`) let the loop wind down
        // gracefully instead of only responding to abort. Never lets
        // it exceed the launch-time physical bound because `frames`
        // is a snapshot from that moment; growing beyond it would
        // dereference undefined frames.
        const currentLatest = typeof getEffectiveLatestSeq === 'function'
            ? Math.min(latestSeq, Math.max(0, Math.floor(Number(getEffectiveLatestSeq()) || 0)))
            : latestSeq;
        if (i >= currentLatest) {
            break;
        }
        const batchStartIndex = i;
        const batchEndIndex = Math.min(currentLatest - 1, i + extractBatchTurns - 1);
        const startFrame = frames[batchStartIndex];
        const endFrame = frames[batchEndIndex];
        if (typeof onBatchStart === 'function') {
            onBatchStart({
                beginSeq: Number(startFrame?.seq || 0),
                endSeq: Number(endFrame?.seq || 0),
                latestSeq,
                batchStartIndex,
                batchEndIndex,
            });
        }
        let success = false;
        let lastFrameError = null;
        // The in-round progress callback carries only the stage and the counts;
        // the batch layer adds the seq range this round covers.
        const batchOnPhaseProgress = typeof onPhaseProgress === 'function'
            ? ({ stage, done, total }) => onPhaseProgress({
                stage,
                done,
                total,
                beginSeq: Number(startFrame?.seq || 0),
                endSeq: Number(endFrame?.seq || 0),
                latestSeq,
            })
            : null;
        for (let attempt = 0; attempt <= frameErrorRetries; attempt++) {
            const attemptSnapshot = captureRollbackSnapshot(store);
            try {
                const batchResult = await processPendingMessageBatchWithLLM(
                    context,
                    store,
                    settings,
                    schema,
                    frames,
                    batchStartIndex,
                    batchEndIndex,
                    {
                        compressionStats,
                        abortSignal,
                        rebuildCreateOnly: Boolean(rebuildCreateOnly),
                        onPhaseProgress: batchOnPhaseProgress,
                    },
                );
                success = Boolean(batchResult?.processed);
                lastFrameError = null;
                if (success) {
                    processedSeqTo = Math.max(processedSeqTo, Number(endFrame?.seq || 0));
                    store.appliedSeqTo = Math.max(Number(store.appliedSeqTo || 0), Number(endFrame?.seq || 0));
                    if (batchResult?.changed) {
                        extractedAny = true;
                        const rollbackEntry = buildRollbackEntry(historyChatKey, {
                            kind: 'extract',
                            seqTo: Number(endFrame?.seq || 0),
                        });
                        if (rollbackEntry) {
                            recordRollbackEntry(historyChatKey, rollbackEntry);
                        }
                    }
                }
                break;
            } catch (error) {
                restoreStoreFromRollbackSnapshot(store, attemptSnapshot);
                if (isAbortError(error, abortSignal)) {
                    throw error;
                }
                lastFrameError = error;
                if (attempt >= frameErrorRetries) {
                    throw error;
                }
                console.warn(
                    `[${MODULE_NAME}] Extraction batch failed (seq=${Number(startFrame?.seq || 0)}-${Number(endFrame?.seq || 0)}). Retrying (${attempt + 1}/${frameErrorRetries})...`,
                    error,
                );
            }
        }
        if (lastFrameError) {
            throw lastFrameError;
        }
        if (!success) {
            break;
        }
        if (typeof onBatchApplied === 'function') {
            await onBatchApplied({
                beginSeq: Number(startFrame?.seq || 0),
                endSeq: Number(endFrame?.seq || 0),
                latestSeq,
            });
        }
        // Per-batch compression: run the compression loop immediately after
        // each successful extraction batch, mirroring how live incremental
        // play paces extract→compress turn by turn. Keeps every commit's
        // anchor floor monotonic in log-append order — each compression
        // round's commit lands right after the batch that produced its
        // candidate events, so its anchor (seqToFloor of the rollup's
        // covered range) is naturally bounded above by the batch's anchor.
        // Postponing compression to the tail (the old shape) made the
        // rollup commit land in the log AFTER batches that wrote later
        // floors, while its anchor pointed back to a historical floor —
        // a non-monotone anchor sequence that broke floor-state's
        // truncate-by-floor invariant and could nuke the whole graph on
        // delete (see tests/floor-state/compaction-floor-anchor.test.js).
        const batchEndSeq = Number(endFrame?.seq || 0);
        await runCompressionLoop(context, store, settings, {
            compressionStats,
            maxSeq: batchEndSeq,
            abortSignal: abortSignal || null,
            onRoundApplied: typeof onCompressionApplied === 'function'
                ? async ({ type, depth, roundSeqTo, beforeStore }) => {
                    await onCompressionApplied({
                        type,
                        depth,
                        roundSeqTo,
                        latestSeq,
                        beforeStore,
                        batchEndSeq,
                    });
                }
                : null,
        });
    }
    if (extractedAny) {
        const compressionRollbackEntry = buildRollbackEntry(historyChatKey, {
            kind: 'compression',
            seqTo: latestSeq,
        });
        if (compressionRollbackEntry) {
            recordRollbackEntry(historyChatKey, compressionRollbackEntry);
        }
    }
    store.appliedSeqTo = Math.max(Number(store.appliedSeqTo || 0), processedSeqTo);
    store.loggedSeqTo = Math.max(Number(store.loggedSeqTo || 0), store.appliedSeqTo);
    store.seqCounter = Math.max(Number(store.seqCounter || 0), store.appliedSeqTo);
    updateStoreSourceState(store, context);
    store.lastExtractionDebug = {
        beginSeq,
        latestSeq,
        coveredSeqTo,
        extracted: extractedAny,
        reason: extractedAny ? 'ok' : (processedSeqTo > coveredSeqTo ? 'no_graph_changes' : 'no_upserts'),
        compression: compressionStats,
        at: Date.now(),
    };
    if (showCompressionToast) {
        notifyEventCompressionIfAny(compressionStats);
    }
    return extractedAny;
}

export function formatNodeBrief(node, settings = null, context = null, extra = {}) {
    const spec = settings ? getSemanticTypeSpec(settings, node?.type, context) : null;
    const out = {
        ...buildLlmFriendlyNodeProjection(node, spec),
        child_count: Array.isArray(node?.childrenIds) ? node.childrenIds.length : 0,
        ...extra,
    };
    // Carry node.floorRange through to the brief view so the read-api's
    // freezeNodeBriefView can preserve it for the orchestrator-tools layer
    // (which translates the seq range to chat[] coords for the LLM).
    // Stamped by A3 extraction; only present for types whose schema sets
    // `recordsFloorRange: true`. Spread comes after `extra` to win when a
    // caller overrides explicitly.
    const rawFloorRange = node?.floorRange;
    if (rawFloorRange
        && typeof rawFloorRange === 'object'
        && typeof rawFloorRange.start === 'number' && Number.isFinite(rawFloorRange.start)
        && typeof rawFloorRange.end === 'number' && Number.isFinite(rawFloorRange.end)) {
        if (out.floorRange === undefined) {
            out.floorRange = { start: rawFloorRange.start, end: rawFloorRange.end };
        }
    }
    return out;
}

function formatNodeDetail(node, settings = null, context = null, extra = {}) {
    const spec = settings ? getSemanticTypeSpec(settings, node?.type, context) : null;
    return {
        ...buildLlmFriendlyNodeProjection(node, spec),
        semantic_depth: Number(node?.semanticDepth || 0),
        semantic_rollup: Boolean(node?.semanticRollup),
        children: Array.isArray(node?.childrenIds) ? node.childrenIds : [],
        ...extra,
    };
}

export function compareNodesByRecency(a, b) {
    const aSeq = Number(a?.seqTo ?? -1);
    const bSeq = Number(b?.seqTo ?? -1);
    if (aSeq !== bSeq) {
        return bSeq - aSeq;
    }
    const aDepth = Number(a?.semanticDepth ?? 0);
    const bDepth = Number(b?.semanticDepth ?? 0);
    if (aDepth !== bDepth) {
        return bDepth - aDepth;
    }
    return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function getSortedNodesByRecency(nodes) {
    return nodes
        .slice()
        .sort(compareNodesByRecency);
}

function buildRecallDebugCoreChat(context, queryText, settings = null) {
    const source = Array.isArray(context?.chat) ? context.chat : [];
    const recentTurns = Math.max(
        1,
        Math.min(60, Math.floor(Number(settings?.recentRawTurns ?? defaultSettings.recentRawTurns))),
    );
    const recentMessageLimit = Math.max(2, recentTurns * 2);
    const history = [];
    for (let i = source.length - 1; i >= 0 && history.length < recentMessageLimit; i -= 1) {
        const message = source[i];
        if (!message || message.is_system) {
            continue;
        }
        const text = normalizeText(message.mes ?? message.content ?? message.text ?? '');
        if (!text) {
            continue;
        }
        history.push({
            is_user: Boolean(message.is_user),
            name: String(message.name || ''),
            mes: text,
        });
    }
    history.reverse();

    const query = normalizeText(queryText || '');
    if (query) {
        history.push({
            is_user: true,
            name: String(context?.name1 || 'User'),
            mes: query,
        });
    }

    if (history.length === 0) {
        history.push({
            is_user: true,
            name: String(context?.name1 || 'User'),
            mes: query || 'Recall debug for current context.',
        });
    }

    return history;
}

function getRecallQueryBundle(payload, context, settings = null) {
    const payloadMessages = Array.isArray(payload?.coreChat) ? payload.coreChat : null;
    const source = payloadMessages || context.chat || [];
    const recentAssistantTurns = sanitizeRecallQueryMessages(settings?.recallQueryMessages);

    // N=0: use the latest user message alone; skip prior turns entirely.
    // recent_messages still carries that one message so query rewrite (if
    // enabled) has an input; vector search reads fullText which equals
    // last_user verbatim.
    if (recentAssistantTurns === 0) {
        let lastUser = '';
        let lastUserIndex = -1;
        for (let i = source.length - 1; i >= 0; i -= 1) {
            const message = source[i];
            if (!message || message.is_system || !message.is_user) continue;
            const text = normalizeText(message.mes || '');
            if (text) {
                lastUser = text;
                lastUserIndex = i;
                break;
            }
        }
        const recentMessages = lastUserIndex >= 0 ? [{
            role: 'user',
            is_user: true,
            name: String(source[lastUserIndex].name || ''),
            text: lastUser,
            mes: lastUser,
            source_index: lastUserIndex,
        }] : [];
        return {
            last_user: lastUser,
            last_assistant: '',
            recent_messages: recentMessages,
            fullText: lastUser,
        };
    }

    const recentWindow = getRecentMessagesByAssistantTurns(source, recentAssistantTurns);
    // getRecentMessagesByAssistantTurns always returns source.slice(startIndex),
    // so recentWindow's global start in `source` is length-length.
    // We stamp source_index on each recent_messages item so downstream
    // (buildRoleSplitChatMessages) can compute the real chat[] depth for
    // prompt-scoped user regex application, keeping parity with the main
    // generation pipeline.
    const windowStartIndex = Math.max(0, source.length - recentWindow.length);
    const recentMessages = [];
    let lastUser = '';
    let lastAssistant = '';

    for (let k = recentWindow.length - 1; k >= 0; k--) {
        const message = recentWindow[k];
        if (!message) {
            continue;
        }
        if (message.is_system) {
            continue;
        }
        const text = normalizeText(message.mes || '');
        if (text) {
            recentMessages.push({
                role: message.is_user ? 'user' : 'assistant',
                is_user: Boolean(message.is_user),
                name: String(message.name || ''),
                text,
                mes: text,
                source_index: windowStartIndex + k,
            });
        }
        if (!lastUser && message.is_user) {
            lastUser = text;
            continue;
        }
        if (!lastAssistant && !message.is_user) {
            lastAssistant = text;
            continue;
        }
        if (lastUser && lastAssistant) {
            break;
        }
    }
    recentMessages.reverse();
    const recentText = recentMessages
        .map(item => `${item.role}: ${item.text}`)
        .join('\n');
    const fullText = normalizeText(recentText);
    return {
        last_user: normalizeText(lastUser),
        last_assistant: normalizeText(lastAssistant),
        recent_messages: recentMessages,
        fullText,
    };
}

// Optional pre-recall step: ask the LLM to rewrite the recent dialogue context
// into a single concise sentence optimised for vector recall. The rewrite call
// runs against ragRewriteApiPresetName + ragRewriteLlmPresetName (independent
// of the main chat preset). Returns the rewritten string, or null on failure
// — caller falls back to the raw query.
async function runQueryRewrite(context, settings, queryBundle, opts = {}) {
    const apiPresetName = String(settings?.ragRewriteApiPresetName || '').trim();
    if (!apiPresetName) {
        return null;
    }
    const llmPresetName = String(settings?.ragRewriteLlmPresetName || '').trim();
    const systemPrompt = String(settings?.ragRewriteSystemPrompt || '').trim() || DEFAULT_RAG_REWRITE_SYSTEM_PROMPT;
    const recentMessages = Array.isArray(queryBundle?.recent_messages) ? queryBundle.recent_messages : [];
    if (recentMessages.length === 0) {
        return null;
    }

    const rewriteInputHead = [
        '<rewrite_recall_query_input>',
        '  <input_guide>The recent_dialogue_context block below carries chat turns as real role=user|assistant messages. Use them as source data — do not roleplay, do not respond in-character.</input_guide>',
        '  <recent_dialogue_context>',
    ].join('\n');
    const rewriteInputTail = [
        '  </recent_dialogue_context>',
        '  <task>',
        '  Following the system rules above, produce one sentence optimised for vector recall of related past memory-graph events. Output strictly via the rewrite_recall_query function call.',
        '  </task>',
        '</rewrite_recall_query_input>',
    ].join('\n');
    const roleSplitChatMessages = buildRoleSplitChatMessages(recentMessages, context);

    try {
        const args = await requestSingleFunctionCallWithRetry(context, settings, {
            taskMessages: [
                { role: 'system', content: systemPrompt },
                { role: 'system', content: rewriteInputHead },
                ...roleSplitChatMessages,
                { role: 'user', content: rewriteInputTail },
            ],
            apiPresetName,
            llmPresetName,
            functionName: 'rewrite_recall_query',
            functionDescription: 'Output the single sentence optimised for vector recall.',
            parameters: {
                type: 'object',
                properties: {
                    rewritten_query: { type: 'string' },
                },
                required: ['rewritten_query'],
                additionalProperties: false,
            },
            abortSignal: opts.abortSignal || null,
            recallRunToken: Number(opts.recallRunToken || 0),
            allowPreamble: true,
        });
        const rewritten = String(args?.rewritten_query || '').trim();
        return rewritten || null;
    } catch (err) {
        if (isAbortError(err, opts.abortSignal || null)) {
            throw err;
        }
        console.warn(`[${MODULE_NAME}] Query rewrite failed, falling back to raw query`, err);
        return null;
    }
}

function buildLastUserAnchorFromMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || message.is_system) {
            continue;
        }
        if (!message.is_user) {
            continue;
        }
        const playableFloor = messages
            .slice(0, i + 1)
            .reduce((count, item) => count + (item && !item.is_system ? 1 : 0), 0);
        const assistantFloor = messages
            .slice(0, i + 1)
            .reduce((count, item) => count + (item && !item.is_system && !item.is_user ? 1 : 0), 0);
        const text = String(message.mes ?? '');
        return {
            floor: i + 1,
            playableFloor,
            assistantFloor,
            hash: String(getStringHash(text)),
        };
    }
    return null;
}

function buildLastUserAnchor(context, payloadMessages) {
    const contextMessages = Array.isArray(context?.chat) ? context.chat : [];
    const contextAnchor = buildLastUserAnchorFromMessages(contextMessages);
    if (contextAnchor) {
        return contextAnchor;
    }

    return buildLastUserAnchorFromMessages(payloadMessages);
}

function invalidateLatestRecallSnapshot() {
    latestRecallSnapshot = null;
}

function canReuseLatestRecallSnapshot(chatKey, anchor) {
    if (!latestRecallSnapshot || typeof latestRecallSnapshot !== 'object') {
        return false;
    }
    if (!anchor || typeof anchor !== 'object') {
        return false;
    }
    if (String(latestRecallSnapshot.chatKey || '') !== String(chatKey || '')) {
        return false;
    }
    const storedFloor = Number(latestRecallSnapshot.anchorFloor);
    const incomingFloor = Number(anchor.floor);
    const storedPlayableFloor = Number(latestRecallSnapshot.anchorPlayableFloor);
    const incomingPlayableFloor = Number(anchor.playableFloor);
    const floorMatched = Number.isFinite(storedPlayableFloor) && Number.isFinite(incomingPlayableFloor)
        ? storedPlayableFloor === incomingPlayableFloor
        : storedFloor === incomingFloor;
    return floorMatched
        && String(latestRecallSnapshot.anchorHash || '') === String(anchor.hash || '');
}

function shouldPreserveLatestRecallSnapshotForAssistantMutation(context, fromSeq) {
    if (!latestRecallSnapshot || typeof latestRecallSnapshot !== 'object') {
        return false;
    }
    const chatKey = getChatKey(context);
    if (String(latestRecallSnapshot.chatKey || '') !== String(chatKey || '')) {
        return false;
    }
    const anchorAssistantFloor = Number(latestRecallSnapshot.anchorAssistantFloor);
    const affectedAssistantSeq = Number(fromSeq);
    return Number.isFinite(anchorAssistantFloor)
        && anchorAssistantFloor >= 0
        && Number.isFinite(affectedAssistantSeq)
        && affectedAssistantSeq > anchorAssistantFloor;
}

export function getNodeRecallExposure(settings, node, context = null) {
    if (!node) {
        return 'high_only';
    }
    if (node.level !== LEVEL.SEMANTIC) {
        return 'high_only';
    }
    const config = getSemanticCompressionConfig(settings, node.type, context);
    if (config.mode === 'hierarchical') {
        return 'high_only';
    }
    return 'full';
}

export function getNearestVisibleAncestorId(store, nodeId, visibleSet) {
    const target = String(nodeId || '').trim();
    if (!target) {
        return '';
    }
    const set = visibleSet instanceof Set ? visibleSet : new Set();
    let currentId = target;
    const guard = new Set();
    while (currentId && !guard.has(currentId)) {
        guard.add(currentId);
        const node = store?.nodes?.[currentId];
        if (!node || node.archived) {
            return '';
        }
        if (set.has(currentId)) {
            return currentId;
        }
        currentId = String(node.parentId || '').trim();
    }
    return '';
}

export function buildProjectedEdges(store, {
    visibleNodeIds = null,
    relationTypes = null,
    excludeInternal = false,
} = {}) {
    const visibleSet = visibleNodeIds instanceof Set
        ? visibleNodeIds
        : Array.isArray(visibleNodeIds)
            ? new Set(visibleNodeIds.map(id => String(id || '').trim()).filter(Boolean))
            : new Set(
                Object.values(store?.nodes || {})
                    .filter(node => node && !node.archived)
                    .map(node => String(node.id || '').trim())
                    .filter(Boolean),
            );
    const relationAllow = Array.isArray(relationTypes) && relationTypes.length > 0
        ? new Set(relationTypes.map(type => normalizeText(type).toLowerCase()).filter(Boolean))
        : null;
    const internalEdgeTypes = new Set(['contains', 'semantic_contains']);
    const merged = new Map();
    for (const edge of store?.edges || []) {
        if (!edge) {
            continue;
        }
        const edgeType = normalizeText(edge.type || '').toLowerCase() || 'related';
        if (excludeInternal && internalEdgeTypes.has(edgeType)) {
            continue;
        }
        if (relationAllow && !relationAllow.has(edgeType)) {
            continue;
        }
        const fromVisible = getNearestVisibleAncestorId(store, edge.from, visibleSet);
        const toVisible = getNearestVisibleAncestorId(store, edge.to, visibleSet);
        if (!fromVisible || !toVisible || fromVisible === toVisible) {
            continue;
        }
        // Symmetric relations (allied_with / hostile_to / family_of /
        // partner_of) collapse direction: A→B and B→A merge into a single row
        // with canonical from = lexicographically smaller id. Non-symmetric
        // relations keep direction in the key.
        const isSymmetric = SYMMETRIC_RELATIONS.has(edgeType);
        const canonicalFrom = isSymmetric && fromVisible > toVisible ? toVisible : fromVisible;
        const canonicalTo = isSymmetric && fromVisible > toVisible ? fromVisible : toVisible;
        const key = `${canonicalFrom}::${canonicalTo}::${edgeType}`;
        const edgeSeq = edgeSeqTo(edge, store);
        const current = merged.get(key);
        if (!current) {
            merged.set(key, {
                from: canonicalFrom,
                to: canonicalTo,
                type: edgeType,
                weight: 1,
                seqTo: edgeSeq,
                ...(isSymmetric ? { symmetric: true } : {}),
            });
            continue;
        }
        current.weight = Number(current.weight || 0) + 1;
        if (edgeSeq > Number(current.seqTo ?? -1)) {
            current.seqTo = edgeSeq;
        }
    }
    return Array.from(merged.values());
}

/**
 * Resolve an edge's effective seqTo for projection ordering. Older edges
 * predate the `seqTo` field; fall back to the most-recent endpoint node's
 * seqTo so projections still rank them sensibly. Never returns negative.
 */
function edgeSeqTo(edge, store) {
    const direct = Number(edge?.seqTo);
    if (Number.isFinite(direct)) {
        return Math.max(0, Math.floor(direct));
    }
    const fromNode = store?.nodes?.[edge?.from];
    const toNode = store?.nodes?.[edge?.to];
    const fromSeq = Number(fromNode?.seqTo ?? -1);
    const toSeq = Number(toNode?.seqTo ?? -1);
    return Math.max(Number.isFinite(fromSeq) ? fromSeq : -1, Number.isFinite(toSeq) ? toSeq : -1, 0);
}

export function buildEdgeSummary(store, nodeId, { nodeSet = null, relationTypes = null, limit = 10 } = {}) {
    if (!nodeId) {
        return {
            degree: 0,
            relations: [],
            sample_neighbors: [],
        };
    }
    const visibleSet = nodeSet instanceof Set
        ? nodeSet
        : Array.isArray(nodeSet)
            ? new Set(nodeSet.map(id => String(id || '').trim()).filter(Boolean))
            : null;
    const projectedEdges = buildProjectedEdges(store, {
        visibleNodeIds: visibleSet,
        relationTypes,
        excludeInternal: false,
    });
    const byRelation = new Map();
    const neighborSeqTo = new Map();
    let degree = 0;
    for (const edge of projectedEdges) {
        const edgeType = normalizeText(edge.type || '').toLowerCase() || 'related';
        let neighborId = '';
        let direction = '';
        if (edge.from === nodeId) {
            neighborId = String(edge.to || '');
            direction = edge.symmetric ? 'symmetric' : 'out';
        } else if (edge.to === nodeId) {
            neighborId = String(edge.from || '');
            direction = edge.symmetric ? 'symmetric' : 'in';
        } else {
            continue;
        }
        if (!neighborId) {
            continue;
        }
        if (visibleSet && !visibleSet.has(neighborId)) {
            continue;
        }
        if (!store.nodes[neighborId] || store.nodes[neighborId].archived) {
            continue;
        }
        const supportCount = Math.max(1, Number(edge?.weight || 1));
        degree += supportCount;
        // Track the most-recent edge per neighbor for sample sort/cutoff.
        const edgeSeq = edgeSeqTo(edge, store);
        const previousSeq = neighborSeqTo.get(neighborId);
        if (previousSeq === undefined || edgeSeq > previousSeq) {
            neighborSeqTo.set(neighborId, edgeSeq);
        }
        const key = `${edgeType}:${direction}`;
        byRelation.set(key, Number(byRelation.get(key) || 0) + supportCount);
    }
    const relationRows = Array.from(byRelation.entries())
        .map(([key, count]) => {
            const [relation, direction] = key.split(':');
            return { relation, direction, count };
        })
        .sort((a, b) => b.count - a.count);

    const sampleNeighbors = Array.from(neighborSeqTo.entries())
        .map(([id, seqTo]) => {
            const node = store.nodes[id];
            return {
                id,
                type: String(node?.type || ''),
                title: String(node?.title || ''),
                to_seq: seqTo,
            };
        })
        // Most-recent first; stable tiebreak on id keeps output deterministic.
        .sort((a, b) => (b.to_seq - a.to_seq) || a.id.localeCompare(b.id))
        .slice(0, Math.max(1, Number(limit || 10)));

    return {
        degree,
        relations: relationRows,
        sample_neighbors: sampleNeighbors,
    };
}

export function isRecallDiagnosticNode(node) {
    const type = String(node?.type || '').trim().toLowerCase();
    return type === 'recall' || type.startsWith('recall_');
}

export function collectRootCandidates(store, settings, queryBundle = { fullText: '' }, alwaysInjectNodes = [], context = null, {
    latestSeqIndex = -1,
    excludeMessages = 0,
} = {}) {
    void queryBundle;
    const schema = getEffectiveNodeTypeSchema(context, settings);
    const visibleRows = buildGraphNodeHints(store, schema, 0);
    const visibleNodes = visibleRows
        .map((row) => store?.nodes?.[String(row?.id || '')] || null)
        .filter((node) => Boolean(node) && !node.archived && !isRecallDiagnosticNode(node))
        .filter((node) => !isNodeInRecentExcludeWindow(node, latestSeqIndex, excludeMessages));
    const merged = [
        ...getSortedNodesByRecency(alwaysInjectNodes.filter(Boolean)),
        ...getSortedNodesByRecency(visibleNodes),
    ];
    const deduped = [];
    const seen = new Set();
    for (const node of merged) {
        const nodeId = String(node?.id || '');
        if (!nodeId || seen.has(nodeId)) {
            continue;
        }
        seen.add(nodeId);
        deduped.push(node);
    }
    return deduped;
}

function normalizeEdgeTypeList(rawTypes) {
    if (!Array.isArray(rawTypes)) {
        return ['related', 'involved_in', 'mentions', 'evidence', 'contains', 'updates', 'advances', 'occurred_at'];
    }
    const list = rawTypes.map(type => normalizeText(type).toLowerCase()).filter(Boolean);
    return list.length > 0 ? list : ['related', 'involved_in', 'mentions', 'evidence', 'contains', 'updates', 'advances', 'occurred_at'];
}

async function chooseRecallRoute(context, settings, recallState) {
    const routeSystemPrompt = String(settings?.recallRouteSystemPrompt || '').trim() || DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT;
    const alwaysInjectIds = Array.isArray(recallState?.alwaysInjectIds) ? recallState.alwaysInjectIds : [];
    const candidateSet = new Set((recallState.candidates || []).map(node => String(node?.id || '')).filter(Boolean));
    if (candidateSet.size === 0) {
        return {
            action: 'finalize',
            selected_node_ids: [],
            expand_plan: [],
            referenced_always_inject_ids: [],
            reason: 'No recall candidates.',
        };
    }
    // Dogfood the read-only API for candidate brief + schema overview so the
    // recall LLM and any plugin that re-implements recall both consume the
    // same view shape. Dynamic import avoids a static circular dependency
    // with read-api.js (which itself imports helpers from here); the ESM
    // module cache makes repeat calls effectively free.
    const { getMemoryGraphReadApi } = await import('./read-api.js');
    const readApi = getMemoryGraphReadApi(recallState.store, context);

    const candidateRows = (recallState.candidates || []).map(node => {
        const id = String(node?.id || '');
        const brief = readApi.getNodeBrief(id, {
            visibleNodeIds: candidateSet,
            edgeSummaryLimit: 8,
        });
        if (brief) return brief;
        // Fallback: node was dropped from the live store between candidate
        // collection and this point (archived / merged). Reconstruct the
        // legacy shape so the route LLM still sees a row for it.
        return formatNodeBrief(node, settings, context, {
            exposure: getNodeRecallExposure(settings, node, context),
            edge_summary: buildEdgeSummary(recallState.store, node?.id, { nodeSet: candidateSet, limit: 8 }),
            always_inject: alwaysInjectIds.includes(id),
        });
    });

    const schemaOverview = readApi.getSchema().types.map(spec => ({
        id: spec.type,
        table_name: spec.tableName,
        table_columns: spec.tableColumns,
        required_columns: spec.requiredColumns,
        force_update: Boolean(spec.forceUpdate),
        extract_every_n: Number(spec.extractEveryN),
        always_inject: Boolean(spec.alwaysInject),
        editable: Boolean(spec.editable),
        compression_mode: String(spec.compressionMode || 'none'),
    }));

    try {
        const routeInputHead = buildRecallRouteInputHead();
        const routeInputTail = buildRecallRouteInputTail({
            recallQueryContext: {
                user_query_text: recallState.query,
            },
            candidateNodes: candidateRows,
            alwaysInjectNodeIds: alwaysInjectIds,
            schemaOverview,
            selectionConstraints: {
                recent_message_window: Math.max(3, Number(settings.recentRawTurns ?? defaultSettings.recentRawTurns)),
                injection_exclude_recent_messages: Math.max(0, Number(settings.recentRawTurns ?? defaultSettings.recentRawTurns)),
                recall_query_recent_messages: sanitizeRecallQueryMessages(settings.recallQueryMessages),
            },
        });
        const roleSplitChatMessages = buildRoleSplitChatMessages(
            recallState?.queryBundle?.recent_messages || [],
            context,
        );
        const parsed = await runFunctionCallTask(context, settings, {
            taskMessages: [
                { role: 'system', content: routeSystemPrompt },
                { role: 'system', content: routeInputHead },
                ...roleSplitChatMessages,
                { role: 'user', content: routeInputTail },
            ],
            apiPresetName: settings.recallApiPresetName || '',
            promptPresetName: String(settings.recallPresetName || '').trim(),
            worldInfoMessages: Array.isArray(recallState?.worldInfoMessages) ? recallState.worldInfoMessages : null,
            runtimeWorldInfo: recallState?.runtimeWorldInfo && typeof recallState.runtimeWorldInfo === 'object'
                ? recallState.runtimeWorldInfo
                : null,
            forceWorldInfoResimulate: Boolean(recallState?.forceWorldInfoResimulate),
            worldInfoType: 'quiet',
            functionName: 'luker_rpg_recall_plan',
            functionDescription: 'Plan recall as finalize or drill with optional expansion plan.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['finalize', 'drill'] },
                    selected_node_ids: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                    expand_plan: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                seed_node_id: { type: 'string' },
                                relation_types: {
                                    type: 'array',
                                    items: { type: 'string' },
                                },
                                depth: { type: 'integer' },
                                include_children: { type: 'boolean' },
                            },
                            required: ['seed_node_id'],
                            additionalProperties: true,
                        },
                    },
                    referenced_always_inject_ids: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                    reason: { type: 'string' },
                },
                required: ['action'],
                additionalProperties: true,
            },
            abortSignal: recallState?.abortSignal || null,
            recallRunToken: Number(recallState?.recallRunToken || 0),
        });
        return {
            action: String(parsed?.action || '').toLowerCase() === 'drill' ? 'drill' : 'finalize',
            selected_node_ids: Array.isArray(parsed?.selected_node_ids)
                ? parsed.selected_node_ids.map(id => String(id || '').trim()).filter(id => id && candidateSet.has(id))
                : [],
            expand_plan: Array.isArray(parsed?.expand_plan)
                ? parsed.expand_plan.map(item => ({
                    seed_node_id: String(item?.seed_node_id || '').trim(),
                    relation_types: normalizeEdgeTypeList(item?.relation_types),
                    depth: Math.max(1, Math.floor(Number(item?.depth) || 1)),
                    include_children: item?.include_children !== false,
                })).filter(item => item.seed_node_id && candidateSet.has(item.seed_node_id))
                : [],
            referenced_always_inject_ids: Array.isArray(parsed?.referenced_always_inject_ids)
                ? parsed.referenced_always_inject_ids.map(id => String(id || '').trim()).filter(Boolean)
                : [],
            reason: String(parsed?.reason || ''),
        };
    } catch (error) {
        // A route failure means recall did not produce a selection. Do not
        // fall back to "select every candidate": that turns an outage into a
        // cached, plausible-looking recall result and injects nodes the model
        // never chose. Propagate so the caller can surface it and skip caching.
        if (!isAbortError(error, recallState?.abortSignal || null)) {
            console.warn(`[${MODULE_NAME}] recall route failed`, error);
        }
        throw error;
    }
}

function addCandidate(candidateMap, node) {
    if (!node?.id) {
        return;
    }
    if (!candidateMap.has(node.id)) {
        candidateMap.set(node.id, node);
    }
}

export function expandRouteCandidates(store, route, rootCandidates) {
    const candidateMap = new Map();
    const expandPlan = Array.isArray(route?.expand_plan) ? route.expand_plan : [];

    for (const node of rootCandidates) {
        addCandidate(candidateMap, node);
    }
    for (const request of expandPlan) {
        const seedId = String(request?.seed_node_id || '').trim();
        if (!seedId || !store.nodes[seedId]) {
            continue;
        }
        const relationTypes = normalizeEdgeTypeList(request?.relation_types);
        const depth = Math.max(1, Math.floor(Number(request?.depth) || 1));
        const includeChildren = request?.include_children !== false;
        const seen = new Set([seedId]);
        let frontier = [seedId];
        addCandidate(candidateMap, store.nodes[seedId]);
        for (let hop = 0; hop < depth; hop++) {
            if (frontier.length === 0) {
                break;
            }
            const visibleSet = new Set(candidateMap.keys());
            const projectedEdges = buildProjectedEdges(store, {
                visibleNodeIds: visibleSet,
                relationTypes,
                excludeInternal: false,
            });
            const next = [];
            for (const currentId of frontier) {
                const currentNode = store.nodes[currentId];
                if (!currentNode || currentNode.archived) {
                    continue;
                }
                if (includeChildren) {
                    for (const child of getChildren(store, currentId)) {
                        if (!child?.id || child.archived || seen.has(child.id)) {
                            continue;
                        }
                        seen.add(child.id);
                        addCandidate(candidateMap, child);
                        next.push(child.id);
                    }
                }
                for (const edge of projectedEdges) {
                    if (!edge) {
                        continue;
                    }
                    let neighborId = '';
                    if (edge.from === currentId) {
                        neighborId = String(edge.to || '');
                    } else if (edge.to === currentId) {
                        neighborId = String(edge.from || '');
                    } else {
                        continue;
                    }
                    if (!neighborId || seen.has(neighborId)) {
                        continue;
                    }
                    const neighbor = store.nodes[neighborId];
                    if (!neighbor || neighbor.archived) {
                        continue;
                    }
                    seen.add(neighborId);
                    addCandidate(candidateMap, neighbor);
                    next.push(neighborId);
                }
            }
            frontier = next;
        }
    }

    return Array.from(candidateMap.values());
}

async function chooseFocusNodes(context, settings, recallState) {
    const finalizeSystemPrompt = String(settings?.recallFinalizeSystemPrompt || '').trim() || DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT;
    const alwaysInjectIds = Array.isArray(recallState?.alwaysInjectIds) ? recallState.alwaysInjectIds : [];
    const candidateSet = new Set((recallState.candidates || []).map(node => String(node?.id || '')).filter(Boolean));
    if (candidateSet.size === 0) {
        return {
            selected_node_ids: [],
            reason: 'No recall candidates.',
        };
    }
    const detailRows = (recallState.candidates || []).map(node => {
        const row = formatNodeDetail(node, settings, context, {
            exposure: getNodeRecallExposure(settings, node, context),
            edge_summary: buildEdgeSummary(recallState.store, node?.id, { nodeSet: candidateSet, limit: 12 }),
            always_inject: alwaysInjectIds.includes(String(node?.id || '')),
        });
        return row;
    });
    try {
        const finalizeInputHead = buildRecallFinalizeInputHead();
        const finalizeInputTail = buildRecallFinalizeInputTail({
            recallQueryContext: {
                user_query_text: recallState.query,
            },
            candidateNodes: detailRows,
            alwaysInjectNodeIds: alwaysInjectIds,
            routeResult: recallState.route || {},
            selectionConstraints: {
                include_non_event_nodes: true,
                require_event_continuity: true,
                recent_message_window: Math.max(3, Number(settings.recentRawTurns ?? defaultSettings.recentRawTurns)),
                injection_exclude_recent_messages: Math.max(0, Number(settings.recentRawTurns ?? defaultSettings.recentRawTurns)),
                recall_query_recent_messages: sanitizeRecallQueryMessages(settings.recallQueryMessages),
                min_event_nodes_if_available: 2,
            },
        });
        const roleSplitChatMessages = buildRoleSplitChatMessages(
            recallState?.queryBundle?.recent_messages || [],
            context,
        );
        const parsed = await runFunctionCallTask(context, settings, {
            taskMessages: [
                { role: 'system', content: finalizeSystemPrompt },
                { role: 'system', content: finalizeInputHead },
                ...roleSplitChatMessages,
                { role: 'user', content: finalizeInputTail },
            ],
            apiPresetName: settings.recallApiPresetName || '',
            promptPresetName: String(settings.recallPresetName || '').trim(),
            worldInfoMessages: Array.isArray(recallState?.worldInfoMessages) ? recallState.worldInfoMessages : null,
            runtimeWorldInfo: recallState?.runtimeWorldInfo && typeof recallState.runtimeWorldInfo === 'object'
                ? recallState.runtimeWorldInfo
                : null,
            forceWorldInfoResimulate: Boolean(recallState?.forceWorldInfoResimulate),
            worldInfoType: 'quiet',
            functionName: 'luker_rpg_recall_finalize',
            functionDescription: 'Finalize memory node IDs to inject.',
            parameters: {
                type: 'object',
                properties: {
                    selected_node_ids: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                    reason: { type: 'string' },
                },
                required: ['selected_node_ids'],
                additionalProperties: true,
            },
            abortSignal: recallState?.abortSignal || null,
            recallRunToken: Number(recallState?.recallRunToken || 0),
        });

        const selectedIds = Array.isArray(parsed?.selected_node_ids)
            ? parsed.selected_node_ids.map(id => String(id || '').trim()).filter(id => id && candidateSet.has(id))
            : [];
        return {
            selected_node_ids: selectedIds,
            reason: String(parsed?.reason || ''),
        };
    } catch (error) {
        // Same contract as chooseRecallRoute: a failed finalize is not a
        // selection. Never cache or inject the whole candidate set.
        if (!isAbortError(error, recallState?.abortSignal || null)) {
            console.warn(`[${MODULE_NAME}] recall select failed`, error);
        }
        throw error;
    }
}

function getActiveSemanticParentOfType(store, node, type) {
    const parentId = String(node?.parentId || '').trim();
    if (!parentId) {
        return null;
    }
    const parent = store.nodes[parentId];
    if (!parent || parent.archived) {
        return null;
    }
    if (String(parent.type || '').toLowerCase() !== String(type || '').toLowerCase()) {
        return null;
    }
    return parent;
}

function getTopActiveSemanticAncestorOfType(store, node, type) {
    if (!node) {
        return null;
    }
    const targetType = String(type || '').toLowerCase();
    let current = node;
    let top = node;
    const guard = new Set();
    while (current && current.id && !guard.has(current.id)) {
        guard.add(current.id);
        const parent = getActiveSemanticParentOfType(store, current, targetType);
        if (!parent) {
            break;
        }
        top = parent;
        current = parent;
    }
    return top;
}

function hasActiveSemanticChildOfType(store, node, type) {
    if (!node || !Array.isArray(node.childrenIds) || node.childrenIds.length === 0) {
        return false;
    }
    const targetType = String(type || '').toLowerCase();
    for (const childId of node.childrenIds) {
        const child = store.nodes[childId];
        if (!child || child.archived) {
            continue;
        }
        if (String(child.type || '').toLowerCase() === targetType) {
            return true;
        }
    }
    return false;
}

export function selectVisibleNodesForType(store, typeNodes, type, compressionMode = 'none') {
    const sorted = Array.isArray(typeNodes)
        ? typeNodes.slice().sort(compareNodesByTimeline)
        : [];
    if (sorted.length === 0) {
        return [];
    }
    if (String(compressionMode || '').toLowerCase() !== 'hierarchical') {
        return sorted;
    }

    const leaves = sorted.filter(node => !hasActiveSemanticChildOfType(store, node, type));
    const picked = [];
    const seen = new Set();
    for (const leaf of leaves) {
        const candidate = getTopActiveSemanticAncestorOfType(store, leaf, type) || leaf;
        if (!candidate?.id || seen.has(candidate.id)) {
            continue;
        }
        seen.add(candidate.id);
        picked.push(candidate);
    }
    return picked.sort(compareNodesByTimeline);
}

export function collectAlwaysInjectNodes(store, settings, context = null, options = {}) {
    // `options.seqWindowFrom?: number` — when set, post-filter the picked nodes
    // to DROP those whose `node.seqTo >= seqWindowFrom` (boundary exclusive on
    // the kept side: keep `seqTo < seqWindowFrom` only). When unset / non-finite,
    // behavior is unchanged. The window is applied after per-type selection so
    // type / compression behavior is preserved.
    //
    // Caller intent: `seqWindowFrom` is the lower bound of the raw-visible
    // recent-turns window. Nodes whose seqTo lands inside that window are
    // already covered by raw text in the prompt, so injecting their semantic
    // summary again is redundant; only nodes that end strictly before the
    // raw-visible region carry information the main context cannot otherwise
    // see.
    //
    // `options.seqCutoffFrom?: number` — when finite, DROP any picked node
    // whose `seqTo < seqCutoffFrom`. Kept side is inclusive on the lower
    // bound: keep `seqTo >= seqCutoffFrom` only. Unlike `seqWindowFrom`
    // (which drops NEW nodes because raw text already covers them), this
    // filter drops OLD nodes past a user-configured recency horizon —
    // they fall back to recall-only. Applied uniformly to ALL always-inject
    // types INCLUDING `event_table` AND latestOnly types (character_sheet
    // etc.): if a latestOnly entity has not been updated within the recency
    // horizon, its snapshot is not injected persistently and must be
    // recalled on demand.
    //
    // Dropped nodes remain in the recall candidate pool automatically
    // because the caller derives the "always-inject id set" from THIS
    // function's return value — a node not in that set is not excluded
    // from recall route candidates (see `routeCandidates` filter in
    // `runRecallPipeline`).
    //
    // latestOnly types (character_sheet / location_state / thread) are
    // intentionally exempt from `seqWindowFrom` only — their picked nodes
    // are current-truth snapshots that must inject even when their seqTo
    // overlaps the raw-visible window, otherwise the main context loses
    // authoritative state. They are NOT exempt from `seqCutoffFrom`.
    const alwaysSpecs = getEffectiveNodeTypeSchema(context, settings)
        .filter((spec) => {
            const tableName = String(spec?.tableName || '').trim().toLowerCase();
            // `event_table` is always considered core storyline context and must stay injected.
            return Boolean(spec?.alwaysInject) || tableName === 'event_table';
        })
        .map(spec => ({
            type: String(spec.id || '').toLowerCase(),
            latestOnly: Boolean(spec?.latestOnly),
            compression: getSemanticCompressionConfig(settings, String(spec.id || '').toLowerCase(), context),
        }))
        .filter(spec => spec.type);
    if (alwaysSpecs.length === 0) {
        return [];
    }

    const latestOnlyTypes = new Set(alwaysSpecs.filter(spec => spec.latestOnly).map(spec => spec.type));
    const picked = [];
    const seen = new Set();
    for (const spec of alwaysSpecs) {
        const nodes = listNodesByLevel(store, LEVEL.SEMANTIC)
            .filter(node => !node.archived)
            .filter(node => !isRecallDiagnosticNode(node))
            .filter(node => String(node.type || '').toLowerCase() === spec.type);
        if (nodes.length === 0) {
            continue;
        }
        const selectedTypeNodes = selectVisibleNodesForType(store, nodes, spec.type, spec.compression.mode);
        for (const node of selectedTypeNodes) {
            if (!node?.id || seen.has(node.id)) {
                continue;
            }
            seen.add(node.id);
            picked.push(node);
        }
    }

    const seqWindowFromRaw = Number(options?.seqWindowFrom);
    const windowed = Number.isFinite(seqWindowFromRaw)
        ? picked.filter((node) => {
            const nodeType = String(node?.type || '').toLowerCase();
            // latestOnly types are exempt — their snapshots are current truth
            // and must inject even when seqTo overlaps the raw-visible window.
            if (latestOnlyTypes.has(nodeType)) {
                return true;
            }
            return Number.isFinite(Number(node?.seqTo)) && Number(node.seqTo) < seqWindowFromRaw;
        })
        : picked;

    // Recency horizon cutoff: within any type (latestOnly INCLUDED), drop
    // nodes whose seqTo is strictly less than seqCutoffFrom. Dropped nodes
    // fall back to recall-only (see class comment above).
    const seqCutoffFromRaw = Number(options?.seqCutoffFrom);
    const capped = Number.isFinite(seqCutoffFromRaw)
        ? windowed.filter((node) => {
            const toSeq = Number(node?.seqTo);
            if (!Number.isFinite(toSeq)) return false;
            return toSeq >= seqCutoffFromRaw;
        })
        : windowed;

    return capped.sort(compareNodesByTimeline);
}

function getNodeSeqRange(node) {
    if (Number.isFinite(Number(node?.seqTo))) {
        return String(Number(node.seqTo));
    }
    return '';
}

export function getLatestSeqIndex(store) {
    return Math.max(-1, getStoreCoveredSeqTo(store));
}

// Compute the seq-based lower bound for the raw-visible recent-turns window.
// Nodes whose seqTo lands at or above this bound are already covered by
// raw dialogue in the main prompt, so persistent injection of their
// semantic form is redundant.
//
// Returns `undefined` when `recentRawTurns <= 0` — callers should omit the
// option from `collectAlwaysInjectNodes` in that case.
//
// PASSED BY: syncPersistentLorebookProjection only. Recall pipeline callers
// intentionally do NOT pass this (recall candidate pool must remain
// unaffected by the injection window so new always-inject nodes stay
// recallable when relevant).
function computeRecentRawWindowFrom(store, settings) {
    const recentRawTurns = Math.max(
        0,
        Math.floor(Number(settings?.recentRawTurns ?? defaultSettings.recentRawTurns)),
    );
    if (recentRawTurns <= 0) return undefined;
    return Math.max(0, getLatestSeqIndex(store) - recentRawTurns + 1);
}

// Compute the seq-based lower bound for the persistent-injection recency
// horizon. Nodes whose seqTo is strictly less than this bound drop out of
// the always-inject set — meaning they leave the persistent lorebook
// projection AND leave the alwaysInjectSet that recall pipelines use to
// exclude nodes from the candidate pool. Old always-inject nodes therefore
// fall back to being recallable (i18n label
// "常驻注入最大回溯楼层数" / "Persistent injection recency horizon"
// promises this explicitly: "仍可通过召回捞回").
//
// Returns `undefined` when `persistentInjectionMaxSeqDistance <= 0`
// (unlimited) — callers should omit the option from
// `collectAlwaysInjectNodes` in that case.
//
// PASSED BY: syncPersistentLorebookProjection AND all recall pipeline
// call sites (runLLMDrivenRecall, injectMemoryPrompts). Keeping the two
// sides in sync is what makes recency-horizon nodes fall back to recall
// instead of vanishing from both channels.
export function computePersistentInjectionSeqCutoff(store, settings) {
    const persistentInjectionMaxSeqDistance = Math.max(
        0,
        Math.floor(
            Number(
                settings?.persistentInjectionMaxSeqDistance
                    ?? defaultSettings.persistentInjectionMaxSeqDistance,
            ) || 0,
        ),
    );
    if (persistentInjectionMaxSeqDistance <= 0) return undefined;
    return Math.max(0, getLatestSeqIndex(store) - persistentInjectionMaxSeqDistance + 1);
}

// Build the `options` object recall pipelines pass to
// `collectAlwaysInjectNodes`. Includes `seqCutoffFrom` (persistent-injection
// recency horizon, so horizon-dropped nodes leave the always-inject set and
// become recall candidates) but NEVER `seqWindowFrom` — the recall
// candidate pool must be unaffected by the raw-visible recent-turns window
// so new always-inject nodes remain recallable when relevant.
//
// Sync-persistent-injection uses `computeRecentRawWindowFrom` +
// `computePersistentInjectionSeqCutoff` directly, not this helper — it
// passes BOTH windows.
export function computeRecallAlwaysInjectOptions(store, settings) {
    const options = {};
    const seqCutoffFrom = computePersistentInjectionSeqCutoff(store, settings);
    if (seqCutoffFrom !== undefined) options.seqCutoffFrom = seqCutoffFrom;
    return options;
}

function getRecentMessagesByAssistantTurns(messages, keepAssistantTurns) {
    const source = Array.isArray(messages) ? messages : [];
    const windowSize = Math.max(0, Math.floor(Number(keepAssistantTurns || 0)));
    if (windowSize <= 0 || source.length === 0) {
        return source.slice();
    }

    let assistantCount = 0;
    let startIndex = -1;
    for (let i = source.length - 1; i >= 0; i -= 1) {
        const message = source[i];
        if (!message || message.is_system) {
            continue;
        }
        if (!message.is_user) {
            assistantCount += 1;
            if (assistantCount >= windowSize) {
                startIndex = i;
                break;
            }
        }
    }

    if (startIndex < 0) {
        return source.slice();
    }

    // If the cutoff lands on an assistant message, include directly preceding user inputs for readability.
    while (startIndex > 0) {
        const prev = source[startIndex - 1];
        if (!prev || prev.is_system || !prev.is_user) {
            break;
        }
        startIndex -= 1;
    }

    return source.slice(startIndex);
}

export function isNodeInRecentExcludeWindow(node, latestSeqIndex, excludeMessages) {
    const windowSize = Math.max(0, Number(excludeMessages || 0));
    if (windowSize <= 0 || latestSeqIndex < 0 || !node) {
        return false;
    }
    const toSeq = Number(node?.seqTo ?? NaN);
    if (!Number.isFinite(toSeq)) {
        return false;
    }
    const cutoff = latestSeqIndex - windowSize + 1;
    return Number.isFinite(cutoff) && toSeq >= cutoff;
}

function toMarkdownTable(headers, rows) {
    if (!Array.isArray(headers) || headers.length === 0 || !Array.isArray(rows) || rows.length === 0) {
        return '';
    }
    const safeHeaders = headers.map(header => normalizeText(header || '-').replaceAll('|', '\\|'));
    const lines = [];
    lines.push(`| ${safeHeaders.join(' | ')} |`);
    lines.push(`| ${safeHeaders.map(() => '---').join(' | ')} |`);
    for (const row of rows) {
        const cells = safeHeaders.map((_, index) => normalizeText(row?.[index] ?? '').replaceAll('|', '\\|'));
        lines.push(`| ${cells.join(' | ')} |`);
    }
    return lines.join('\n');
}

function getTableCellValueFromNode(node, columnName) {
    const key = String(columnName || '').trim().toLowerCase();
    if (!key) {
        return '';
    }
    const structured = getStructuredNodeFields(node);
    if (key === 'title' || key === 'name') {
        return String(node.title || structured.name || '');
    }
    if (key === 'type') {
        return String(node.type || '');
    }
    if (key === 'seq_range' || key === 'turn_range') {
        return getNodeSeqRange(node);
    }
    if (key === 'summary') {
        return getNodeSummary(node);
    }
    if (key === 'details') {
        if (structured[key] !== undefined) {
            return toDisplayScalar(structured[key]);
        }
        return '';
    }
    if (key === 'last_update_seq' || key === 'last_update_turn') {
        return String(node.seqTo ?? '');
    }
    if (key === 'seq_to' || key === 'turn_to' || key === 'seq') {
        return String(node.seqTo ?? '');
    }
    if (structured[key] !== undefined) {
        return toDisplayScalar(structured[key]);
    }
    const parsedSummary = tryParseJsonObject(getNodeSummary(node));
    const deepHit = findValueByKeyDeep(node?.fields, key)
        ?? findValueByKeyDeep(parsedSummary, key);
    if (deepHit !== undefined) {
        return toDisplayScalar(deepHit);
    }
    return String(node?.fields?.[key] ?? '');
}

function buildFocusTablesText(nodes, settings, options = {}, context = null) {
    const byBucket = new Map();
    const sourceNodes = Array.isArray(nodes) ? nodes : [];
    const tablePrefix = String(options?.tablePrefix || 'Focus').trim() || 'Focus';
    const schemaMap = getNodeTypeSchemaMap(settings, context);
    for (const node of sourceNodes) {
        if (!node) {
            continue;
        }
        const bucket = node.level === LEVEL.SEMANTIC
            ? `semantic:${String(node.type || 'semantic')}`
            : `timeline:${String(node.level || 'unknown')}`;
        if (!byBucket.has(bucket)) {
            byBucket.set(bucket, []);
        }
        byBucket.get(bucket).push(node);
    }

    const blocks = [];
    for (const [bucket, bucketNodes] of byBucket.entries()) {
        let headers = ['title', 'type', 'seq_range', 'summary'];
        let rows = bucketNodes.map(node => [
            String(node.title || ''),
            String(node.type || ''),
            getNodeSeqRange(node),
            getNodeSummary(node),
        ]);
        let bucketTitle = `${tablePrefix} ${bucket}`;

        if (bucket.startsWith('semantic:')) {
            const semanticType = String(bucket.slice('semantic:'.length) || '').trim().toLowerCase();
            const spec = schemaMap.get(semanticType);
            const columns = Array.isArray(spec?.tableColumns) ? spec.tableColumns : [];
            if (columns.length > 0) {
                headers = columns;
                rows = bucketNodes.map(node => columns.map(column => getTableCellValueFromNode(node, column)));
            }
            bucketTitle = `${tablePrefix} ${spec?.tableName || semanticType || bucket}`;
        }

        const table = toMarkdownTable(headers, rows);
        if (!table) {
            continue;
        }
        blocks.push(`[Table: ${bucketTitle}]\n${table}`);
    }

    return blocks.join('\n\n');
}

const DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG = Object.freeze({
    position: Number(newWorldInfoEntryTemplate.position ?? world_info_position.before),
    depth: Math.max(0, Math.min(10000, Math.floor(Number(newWorldInfoEntryTemplate.depth ?? 4) || 0))),
    role: [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT]
        .includes(Number(newWorldInfoEntryTemplate.role))
        ? Number(newWorldInfoEntryTemplate.role)
        : extension_prompt_roles.SYSTEM,
});

function normalizeManagedLorebookEntryConfig(entryConfig = {}, fallbackConfig = DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG) {
    const fallback = fallbackConfig && typeof fallbackConfig === 'object'
        ? fallbackConfig
        : DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG;
    const fallbackPosition = SUPPORTED_WORLD_INFO_POSITIONS.includes(Number(fallback.position))
        ? Number(fallback.position)
        : DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG.position;
    const fallbackDepth = Math.max(
        0,
        Math.min(10000, Math.floor(Number(fallback.depth ?? DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG.depth) || 0)),
    );
    const fallbackRole = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT]
        .includes(Number(fallback.role))
        ? Number(fallback.role)
        : DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG.role;
    const numericPosition = Number(entryConfig?.position);
    const numericRole = Number(entryConfig?.role);

    return {
        position: SUPPORTED_WORLD_INFO_POSITIONS.includes(numericPosition) ? numericPosition : fallbackPosition,
        depth: Math.max(0, Math.min(10000, Math.floor(Number(entryConfig?.depth ?? fallbackDepth) || 0))),
        role: [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT]
            .includes(numericRole) ? numericRole : fallbackRole,
    };
}

function getProjectionLorebookEntryConfig(commentPrefix, settings) {
    if ([PERSISTENT_LOREBOOK_COMMENT_PREFIX, RUNTIME_LOREBOOK_COMMENT_PREFIX].includes(String(commentPrefix || '').trim())) {
        return normalizeManagedLorebookEntryConfig({
            position: normalizeRecallInjectPosition(settings?.recallInjectPosition),
            depth: normalizeRecallInjectDepth(settings?.recallInjectDepth),
            role: normalizeRecallInjectRole(settings?.recallInjectRole),
        });
    }
    return DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG;
}

function createRuntimeLorebookEntry(uid, comment, content, order, entryConfig = DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG) {
    const normalizedEntryConfig = normalizeManagedLorebookEntryConfig(entryConfig);
    return {
        uid,
        ...structuredClone(newWorldInfoEntryTemplate),
        key: [],
        keysecondary: [],
        comment: String(comment || ''),
        content: String(content || ''),
        constant: true,
        selective: true,
        disable: false,
        order: Number(order || 100),
        preventRecursion: true,
        excludeRecursion: true,
        useProbability: true,
        probability: 100,
        position: normalizedEntryConfig.position,
        depth: normalizedEntryConfig.depth,
        role: normalizedEntryConfig.role,
    };
}

function syncMutableGenerationPayloadState(target, source) {
    if (!target || typeof target !== 'object' || !source || typeof source !== 'object' || target === source) {
        return;
    }

    const mutableKeys = [
        'requestRescan',
        '__lukerRpgMemoryNeedRescan',
        '__lukerRpgMemoryInjected',
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

async function ensureSharedLorebook(context, allowCreate = true) {
    const loaded = await context.loadWorldInfo(SHARED_LOREBOOK_NAME);
    if (loaded && typeof loaded === 'object') {
        return SHARED_LOREBOOK_NAME;
    }
    if (!allowCreate) {
        return '';
    }

    await context.saveWorldInfo(SHARED_LOREBOOK_NAME, { entries: {} }, true, { refreshEditor: true });
    return SHARED_LOREBOOK_NAME;
}

async function refreshSharedLorebookVisibilityAndSelection(context, selected) {
    if (typeof selected === 'boolean') {
        await setGlobalWorldInfoSelection(SHARED_LOREBOOK_NAME, selected, { refreshList: true });
    }
}

function getManagedLorebookEntries(data, commentPrefix) {
    const prefix = `${String(commentPrefix || '').trim()}::`;
    if (!prefix || !data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
        return [];
    }
    return Object.entries(data.entries)
        .filter(([, entry]) => String(entry?.comment || '').startsWith(prefix))
        .map(([uid, entry]) => ({
            uid: String(uid || ''),
            comment: String(entry?.comment || ''),
            content: normalizeMultilineText(entry?.content || ''),
            order: Number(entry?.order || 0),
            position: Number(entry?.position ?? DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG.position),
            depth: Math.max(
                0,
                Math.min(10000, Math.floor(Number(entry?.depth ?? DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG.depth) || 0)),
            ),
            role: [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT]
                .includes(Number(entry?.role))
                ? Number(entry.role)
                : DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG.role,
        }));
}

function getNextLorebookUid(entries) {
    return Object.keys(entries || {})
        .map(uid => Number(uid))
        .filter(Number.isFinite)
        .reduce((max, value) => Math.max(max, value), -1) + 1;
}

function areManagedLorebookEntriesEqual(
    existingEntries,
    sections,
    commentPrefix,
    baseOrder,
    entryConfig = DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG,
) {
    const normalizedSections = Array.isArray(sections) ? sections : [];
    const normalizedExisting = Array.isArray(existingEntries) ? existingEntries : [];
    const normalizedEntryConfig = normalizeManagedLorebookEntryConfig(entryConfig);
    if (normalizedExisting.length !== normalizedSections.length) {
        return false;
    }
    const byComment = new Map(normalizedExisting.map(entry => [String(entry.comment || ''), entry]));
    if (byComment.size !== normalizedExisting.length) {
        return false;
    }
    for (let i = 0; i < normalizedSections.length; i += 1) {
        const [name, text] = normalizedSections[i];
        const comment = `${String(commentPrefix || '').trim()}::${String(name || '').trim()}`;
        const expectedContent = normalizeMultilineText(text || '');
        const expectedOrder = baseOrder + i;
        const existing = byComment.get(comment);
        if (!existing) {
            return false;
        }
        if (normalizeMultilineText(existing.content || '') !== expectedContent) {
            return false;
        }
        if (Number(existing.order || 0) !== expectedOrder) {
            return false;
        }
        if (Number(existing.position ?? DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG.position) !== normalizedEntryConfig.position) {
            return false;
        }
        if (Math.max(
            0,
            Math.min(10000, Math.floor(Number(existing.depth ?? DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG.depth) || 0)),
        ) !== normalizedEntryConfig.depth) {
            return false;
        }
        if (([extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT]
            .includes(Number(existing.role))
            ? Number(existing.role)
            : DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG.role) !== normalizedEntryConfig.role) {
            return false;
        }
    }
    return true;
}

async function upsertManagedLorebookProjection(context, settings, {
    commentPrefix,
    sections,
    orderBase,
    allowCreate = true,
    entryConfig = undefined,
} = {}) {
    const prefix = String(commentPrefix || '').trim();
    if (!prefix) {
        return { changed: false, bookName: '' };
    }
    const resolvedEntryConfig = normalizeManagedLorebookEntryConfig(
        entryConfig ?? getProjectionLorebookEntryConfig(prefix, settings),
    );
    const normalizedSections = (Array.isArray(sections) ? sections : [])
        .map((section) => [String(section?.[0] || '').trim(), normalizeMultilineText(section?.[1] || '')])
        .filter(([name, text]) => Boolean(name) && Boolean(text));
    let bookName = SHARED_LOREBOOK_NAME;
    let data = null;
    const loaded = await context.loadWorldInfo(bookName);
    if (loaded && typeof loaded === 'object') {
        data = loaded;
    }

    if (!data) {
        if (normalizedSections.length === 0 || !allowCreate) {
            return { changed: false, bookName };
        }
        bookName = await ensureSharedLorebook(context, true);
        const created = await context.loadWorldInfo(bookName);
        data = created && typeof created === 'object' ? created : { entries: {} };
    }

    if (!data.entries || typeof data.entries !== 'object') {
        data.entries = {};
    }

    const baseOrder = Math.max(100, Number(orderBase || settings?.lorebookEntryOrderBase || 9800));
    const existingEntries = getManagedLorebookEntries(data, prefix);
    if (areManagedLorebookEntriesEqual(existingEntries, normalizedSections, prefix, baseOrder, resolvedEntryConfig)) {
        return { changed: false, bookName };
    }

    for (const entry of existingEntries) {
        delete data.entries[entry.uid];
    }

    let nextUid = getNextLorebookUid(data.entries);
    for (let i = 0; i < normalizedSections.length; i += 1) {
        const [name, text] = normalizedSections[i];
        data.entries[nextUid] = createRuntimeLorebookEntry(
            nextUid,
            `${prefix}::${name}`,
            text,
            baseOrder + i,
            resolvedEntryConfig,
        );
        nextUid += 1;
    }

    await context.saveWorldInfo(bookName, data, true, { refreshEditor: true });
    if (bookName === SHARED_LOREBOOK_NAME) {
        await refreshSharedLorebookVisibilityAndSelection(context, Boolean(settings?.enabled));
    }
    return { changed: true, bookName };
}

async function syncPersistentLorebookProjection(context, settings, store) {
    const semanticNodes = listNodesByLevel(store, LEVEL.SEMANTIC)
        .filter(node => node && !node.archived);
    if (semanticNodes.length === 0) {
        const changed = await clearPersistentLorebookProjection(context, settings);
        return {
            changed,
            corePacket: '',
            alwaysInjectNodes: [],
        };
    }
    // seqWindowFrom (raw-visible recent-turns window) and seqCutoffFrom
    // (persistent-injection recency horizon) are both derived from settings
    // via the exported helpers so recall pipeline call sites can compute
    // the same seqCutoffFrom bound — that's how horizon-dropped nodes
    // fall back to being recallable instead of vanishing from both
    // channels. See computePersistentInjectionSeqCutoff docs.
    const seqWindowFrom = computeRecentRawWindowFrom(store, settings);
    const seqCutoffFrom = computePersistentInjectionSeqCutoff(store, settings);
    const collectOptions = {};
    if (seqWindowFrom !== undefined) collectOptions.seqWindowFrom = seqWindowFrom;
    if (seqCutoffFrom !== undefined) collectOptions.seqCutoffFrom = seqCutoffFrom;
    const alwaysInjectNodes = collectAlwaysInjectNodes(
        store,
        settings,
        context,
        collectOptions,
    );
    const corePacket = normalizeMultilineText(
        buildFocusTablesText(alwaysInjectNodes, settings, { tablePrefix: 'Core' }, context),
    );
    const result = await upsertManagedLorebookProjection(context, settings, {
        commentPrefix: PERSISTENT_LOREBOOK_COMMENT_PREFIX,
        sections: [['CORE_PACKET', corePacket]],
        orderBase: Math.max(100, Number(settings.lorebookEntryOrderBase || 9800)),
        allowCreate: true,
    });
    return {
        changed: Boolean(result?.changed),
        corePacket,
        alwaysInjectNodes,
    };
}

async function syncRuntimeLorebookProjection(context, settings, store) {
    const projection = getLastRecallProjection(store);
    const focusPacket = normalizeMultilineText(projection?.blocks?.focusPacket || projection?.focusPacket || '');
    const result = await upsertManagedLorebookProjection(context, settings, {
        commentPrefix: RUNTIME_LOREBOOK_COMMENT_PREFIX,
        sections: focusPacket ? [['FOCUS_PACKET', focusPacket]] : [],
        orderBase: Math.max(100, Number(settings.lorebookEntryOrderBase || 9800)) + 50,
        allowCreate: Boolean(focusPacket),
    });
    return {
        changed: Boolean(result?.changed),
        focusPacket,
    };
}

async function clearRuntimeLorebookProjection(context, settings) {
    const result = await syncRuntimeLorebookProjection(context, settings, { lastRecallProjection: null });
    return Boolean(result?.changed);
}

async function clearPersistentLorebookProjection(context, settings) {
    const result = await upsertManagedLorebookProjection(context, settings, {
        commentPrefix: PERSISTENT_LOREBOOK_COMMENT_PREFIX,
        sections: [],
        orderBase: Math.max(100, Number(settings.lorebookEntryOrderBase || 9800)),
        allowCreate: false,
    });
    return Boolean(result?.changed);
}

async function clearAllMemoryLorebookProjection(context, settings) {
    await clearRuntimeLorebookProjection(context, settings);
    await clearPersistentLorebookProjection(context, settings);
}

async function syncMemoryLorebookActivation(context, settings) {
    if (settings?.enabled) {
        await ensureSharedLorebook(context, true);
        await refreshSharedLorebookVisibilityAndSelection(context, true);
        return;
    }

    await setGlobalWorldInfoSelection(SHARED_LOREBOOK_NAME, false);
}

async function syncPersistentProjectionForCurrentChat(context = getContext()) {
    try {
        const effectiveSettings = getEffectiveSettings(context, getSettings());
        await syncMemoryLorebookActivation(context, effectiveSettings);
        if (!effectiveSettings.enabled) {
            refreshUiStats();
            return;
        }
        const store = await ensureStoreSyncedWithChat(context);
        if (!store) {
            await clearAllMemoryLorebookProjection(context, effectiveSettings);
            refreshUiStats();
            return;
        }
        await syncPersistentLorebookProjection(context, effectiveSettings, store);
        refreshUiStats();
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to sync persistent lorebook projection on chat open`, error);
        refreshUiStats();
    }
}

async function runLLMDrivenRecall(context, store, payload) {
    const settings = getEffectiveSettings(context, getSettings());
    if (!settings.recallEnabled) {
        return { selectedNodes: [], alwaysInjectNodes: [], trace: [], query: '' };
    }
    const abortSignal = isAbortSignalLike(payload?.signal) ? payload.signal : null;
    const recallRunToken = Number(payload?.__lukerRpgMemoryRecallRunToken || 0);
    throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');

    const queryBundle = getRecallQueryBundle(payload, context, settings);
    const query = normalizeText(queryBundle.fullText || '');
    const runtimeWorldInfo = buildRuntimeWorldInfoFromPayload(payload);
    const forceWorldInfoResimulate = Boolean(payload?.forceWorldInfoResimulate);
    const worldInfoMessages = Array.isArray(payload?.coreChat) ? payload.coreChat : [];
    // Recall-side always-inject set is horizon-adjusted (seqCutoffFrom) but
    // NOT window-adjusted (seqWindowFrom) — see computeRecallAlwaysInjectOptions.
    const alwaysInjectNodes = collectAlwaysInjectNodes(
        store,
        settings,
        context,
        computeRecallAlwaysInjectOptions(store, settings),
    );
    const latestSeqIndex = getLatestSeqIndex(store);
    const excludeMessages = Math.max(0, Number(settings.recentRawTurns ?? defaultSettings.recentRawTurns));
    const rootCandidates = collectRootCandidates(store, settings, queryBundle, alwaysInjectNodes, context, {
        latestSeqIndex,
        excludeMessages,
    });
    const maxIterations = Math.max(2, Math.min(6, Number(settings.recallMaxIterations || 3)));
    const trace = [];
    const alwaysInjectIds = alwaysInjectNodes.map(node => String(node?.id || '')).filter(Boolean);
    const alwaysInjectSet = new Set(alwaysInjectIds);
    const routeCandidates = rootCandidates.filter((node) => node?.id && !alwaysInjectSet.has(String(node.id)));

    if (routeCandidates.length === 0) {
        trace.push({
            step: 'skip_recall_route_no_candidates',
            latest_seq: latestSeqIndex,
            exclude_messages: excludeMessages,
            always_inject_count: alwaysInjectNodes.length,
        });
        if (alwaysInjectNodes.length > 0) {
            trace.push({
                step: 'always_inject',
                node_ids: alwaysInjectNodes.map(node => node.id),
            });
        }
        return {
            selectedNodes: [],
            alwaysInjectNodes,
            query,
            trace,
        };
    }

    let selectedIds = [];
    let currentCandidates = routeCandidates.slice();
    let latestRoute = null;
    let earlyFinalized = false;
    const drillBudget = Math.max(0, maxIterations - 1);

    for (let pass = 1; pass <= drillBudget; pass++) {
        throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
        const route = await chooseRecallRoute(context, settings, {
            store,
            query,
            queryBundle,
            candidates: currentCandidates,
            alwaysInjectIds,
            worldInfoMessages,
            runtimeWorldInfo,
            forceWorldInfoResimulate,
            abortSignal,
            recallRunToken,
        });
        throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
        latestRoute = route;
        trace.push({
            step: `plan_pass_${pass}`,
            route,
            stage1_candidates: currentCandidates.map(node => node.id),
        });
        if (Array.isArray(route?.referenced_always_inject_ids) && route.referenced_always_inject_ids.length > 0) {
            trace.push({
                step: `plan_referenced_always_inject_${pass}`,
                node_ids: route.referenced_always_inject_ids,
            });
        }

        if (route.action === 'finalize') {
            selectedIds = Array.isArray(route.selected_node_ids) ? route.selected_node_ids : [];
            trace.push({
                step: `plan_early_finalize_${pass}`,
                selected_ids: selectedIds,
                reason: route.reason || '',
            });
            earlyFinalized = true;
            break;
        }

        if (route.action !== 'drill') {
            trace.push({
                step: `plan_stop_non_drill_${pass}`,
                action: String(route.action || ''),
            });
            break;
        }

        const expandedCandidates = expandRouteCandidates(store, route, currentCandidates);
        trace.push({
            step: `expand_from_plan_${pass}`,
            expanded_candidates: expandedCandidates.map(node => node.id),
        });

        if (expandedCandidates.length <= currentCandidates.length) {
            currentCandidates = expandedCandidates;
            trace.push({
                step: `drill_stagnated_${pass}`,
                candidate_count: currentCandidates.length,
            });
            break;
        }

        currentCandidates = expandedCandidates;
    }

    if (!earlyFinalized) {
        throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
        const selectedRaw = await chooseFocusNodes(context, settings, {
            store,
            query,
            queryBundle,
            route: latestRoute || {},
            candidates: currentCandidates,
            alwaysInjectIds,
            worldInfoMessages,
            runtimeWorldInfo,
            forceWorldInfoResimulate,
            abortSignal,
            recallRunToken,
        });
        throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
        selectedIds = Array.isArray(selectedRaw.selected_node_ids) ? selectedRaw.selected_node_ids : [];
        trace.push({
            step: 'finalize_pass',
            selected_ids: selectedIds,
            reason: selectedRaw.reason || '',
        });
    }

    const droppedAlwaysInjectIds = [];
    const filteredSelectionIds = [];
    for (const id of selectedIds) {
        const key = String(id || '').trim();
        if (!key) {
            continue;
        }
        if (alwaysInjectSet.has(key)) {
            droppedAlwaysInjectIds.push(key);
            continue;
        }
        filteredSelectionIds.push(key);
    }
    if (droppedAlwaysInjectIds.length > 0) {
        trace.push({
            step: 'drop_always_inject_from_selection',
            dropped_always_inject_ids: droppedAlwaysInjectIds,
        });
    }

    const selectedNodesRaw = filteredSelectionIds
        .map(id => store.nodes[id])
        .filter(Boolean);
    const dedupedSelectedNodes = [];
    const selectedNodeSeen = new Set();
    for (const node of selectedNodesRaw) {
        if (!node?.id || selectedNodeSeen.has(node.id)) {
            continue;
        }
        selectedNodeSeen.add(node.id);
        dedupedSelectedNodes.push(node);
    }
    const selectedNodes = dedupedSelectedNodes;
    if (alwaysInjectNodes.length > 0) {
        trace.push({
            step: 'always_inject',
            node_ids: alwaysInjectNodes.map(node => node.id),
        });
    }

    const excludedNodeIds = [];
    const filteredSelectedNodes = selectedNodes.filter((node) => {
        const excluded = isNodeInRecentExcludeWindow(node, latestSeqIndex, excludeMessages);
        if (excluded && node?.id) {
            excludedNodeIds.push(node.id);
        }
        return !excluded;
    }).sort(compareNodesByTimeline);
    if (excludeMessages > 0 && excludedNodeIds.length > 0) {
        trace.push({
            step: 'exclude_recent_window',
            exclude_messages: excludeMessages,
            latest_seq: latestSeqIndex,
            excluded_node_ids: excludedNodeIds,
        });
    }

    return {
        selectedNodes: filteredSelectedNodes,
        alwaysInjectNodes,
        query,
        trace,
    };
}

async function rebuildStoreFromCurrentChat(context, { abortSignal = null, onBatchStart = null, onPhaseProgress = null } = {}) {
    const chatKey = getChatKey(context);
    const target = memoryStoreTargets.get(chatKey) || buildMemoryTargetFromContext(context);
    if (!target) {
        return null;
    }

    const rebuilt = createEmptyStore();
    let hasCommittedBatch = false;
    // Each batch commit and each compression round commit anchors at the floor
    // of the batch that triggered it (seqToFloor(batchEndSeq)). Compression
    // runs inline after every successful batch, so anchors stay monotonic in
    // log append order and tail-truncation on delete drops a clean log suffix —
    // see runExtractionForStore for the invariant. Anchoring compression at
    // the rollup parent's own seqTo would mis-place the commit when the
    // compression pulls in pre-existing older nodes (parent.seqTo can be far
    // earlier than the triggering batch); use batchEndSeq instead.
    const extracted = await runExtractionForStore(context, rebuilt, {
        force: true,
        startSeq: 1,
        showCompressionToast: false,
        abortSignal,
        onBatchStart,
        onPhaseProgress,
        onBatchApplied: async ({ endSeq }) => {
            if (!hasCommittedBatch) {
                const currentBatchEntries = getRollbackHistory(chatKey)
                    .filter(entry => Number(entry?.seqTo || 0) === Number(endSeq || 0));
                clearRollbackHistory(chatKey);
                for (const entry of currentBatchEntries) {
                    recordRollbackEntry(chatKey, entry);
                }
                hasCommittedBatch = true;
            }
            await commitMemoryStoreReplaceByChatKey(context, chatKey, rebuilt, endSeq, { syncPersistentProjection: true, floor: seqToFloor(context, endSeq) });
        },
        onCompressionApplied: async ({ batchEndSeq }) => {
            await commitMemoryStoreReplaceByChatKey(
                context,
                chatKey,
                rebuilt,
                batchEndSeq,
                { syncPersistentProjection: true, floor: seqToFloor(context, batchEndSeq) },
            );
        },
        rebuildCreateOnly: true,
    });
    const latestSeq = Math.max(0, Number(rebuilt?.lastExtractionDebug?.latestSeq || 0));
    if (!extracted && latestSeq > 0 && String(rebuilt?.lastExtractionDebug?.reason || '') !== 'no_graph_changes') {
        throw new Error('Memory extraction returned no graph updates. Existing graph preserved.');
    }
    updateStoreSourceState(rebuilt, context);
    memoryStoreTargets.set(chatKey, target);
    const finalSeq = Number(rebuilt?.lastExtractionDebug?.latestSeq || getStoreCoveredSeqTo(rebuilt) || 0);
    const persistResult = await commitMemoryStoreReplaceByChatKey(
        context,
        chatKey,
        rebuilt,
        finalSeq,
        { syncPersistentProjection: true, floor: seqToFloor(context, finalSeq) },
    );
    return persistResult.store;
}

function buildPlayableFramesFromContext(context) {
    const frames = [];
    let seq = 0;
    for (const message of getAssistantChatMessages(context)) {
        const text = normalizeText(message?.mes || '');
        if (!text) {
            continue;
        }
        seq += 1;
        frames.push({
            seq,
            is_user: Boolean(message?.is_user),
            name: String(message?.name || ''),
            mes: text,
            send_date: String(message?.send_date || ''),
            source_index: typeof message?.source_index === 'number' ? message.source_index : -1,
            last_user_name: String(message?.last_user_name || ''),
            last_user_mes: String(message?.last_user_mes || ''),
            last_user_send_date: String(message?.last_user_send_date || ''),
            last_user_source_index: typeof message?.last_user_source_index === 'number' ? message.last_user_source_index : -1,
        });
    }
    return frames;
}

function computeExtractionWindow(context, store, startSeq = null, settings = null) {
    const effectiveSettings = settings || getEffectiveSettings(context, getSettings());
    const frames = buildPlayableFramesFromContext(context);
    const latestSeq = getExtractableLatestSeq(frames.length, effectiveSettings);
    const coveredSeqTo = Math.min(latestSeq, getStoreCoveredSeqTo(store));
    const hasExplicitStartSeq = startSeq !== null
        && startSeq !== undefined
        && Number.isFinite(Number(startSeq));
    const beginSeq = hasExplicitStartSeq
        ? Math.max(1, Math.floor(Number(startSeq)))
        : coveredSeqTo + 1;
    return {
        frames,
        latestSeq,
        coveredSeqTo,
        beginSeq,
        gap: latestSeq - coveredSeqTo,
    };
}

function formatExtractionRangeToast(beginSeq, endSeq, latestSeq) {
    const begin = Math.max(1, Math.floor(Number(beginSeq || 0)));
    const end = Math.max(begin, Math.floor(Number(endSeq || begin)));
    const latest = Math.max(end, Math.floor(Number(latestSeq || end)));
    return i18nFormat('Memory graph update running... seq ${0}-${1} / latest ${2}', begin, end, latest);
}

function formatExtractionPhaseToast(stage, done, total) {
    const kind = String(stage || '').trim().toLowerCase();
    if (kind === 'edges') {
        return i18n('Edge stage');
    }
    const safeDone = Math.max(0, Math.floor(Number(done) || 0));
    const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
    return i18nFormat('Node stage ${0}/${1}', safeDone, safeTotal);
}

function truncateStoreFromSeq(store, fromSeq, chatKey = '') {
    const startSeq = Math.max(1, Math.floor(Number(fromSeq || 0)));
    if (!store || typeof store !== 'object' || !Number.isFinite(startSeq) || startSeq <= 0) {
        return;
    }
    trimRollbackHistoryFromSeq(chatKey, startSeq);
    const removeIds = new Set();
    for (const [id, node] of Object.entries(store.nodes || {})) {
        const nodeSeq = Number(node?.seqTo || 0);
        if (Number.isFinite(nodeSeq) && nodeSeq >= startSeq) {
            removeIds.add(String(id || ''));
        }
    }
    if (removeIds.size === 0) {
        const covered = Math.max(0, startSeq - 1);
        store.appliedSeqTo = covered;
        store.loggedSeqTo = covered;
        store.seqCounter = Math.max(getSemanticCoverageSeq(store), covered);
        return;
    }

    for (const id of removeIds) {
        delete store.nodes[id];
    }
    for (const node of Object.values(store.nodes || {})) {
        if (!node || typeof node !== 'object') {
            continue;
        }
        if (Array.isArray(node.childrenIds)) {
            node.childrenIds = node.childrenIds.filter(childId => !removeIds.has(String(childId || '')));
        } else {
            node.childrenIds = [];
        }
        if (String(node.parentId || '').trim() && removeIds.has(String(node.parentId || '').trim())) {
            node.parentId = '';
        }
    }
    if (Array.isArray(store.edges)) {
        store.edges = store.edges.filter(edge => {
            const from = String(edge?.from || '');
            const to = String(edge?.to || '');
            return from && to && !removeIds.has(from) && !removeIds.has(to);
        });
    }
    const covered = Math.max(0, startSeq - 1);
    store.appliedSeqTo = covered;
    store.loggedSeqTo = covered;
    store.seqCounter = Math.max(getSemanticCoverageSeq(store), covered);
}

function alignStoreCoverageToChat(store, context, settings = null) {
    if (!store || typeof store !== 'object') {
        return { changed: false, latestSeq: 0 };
    }
    const effectiveSettings = settings || getEffectiveSettings(context, getSettings());
    const frames = buildPlayableFramesFromContext(context);
    const latestSeq = getExtractableLatestSeq(frames.length, effectiveSettings);
    updateStoreSourceState(store, context);
    return { changed: false, latestSeq };
}

export async function ensureStoreSyncedWithChat(context) {
    // floor-state's settle is driven by core BEFORE this function ever runs
    // (see settleMessageDeleted/settleMessageSwiped/etc in floor-state.js),
    // so the data namespace is already current. We just need to load the
    // runtime store from cache or rebuild it from floor-state.
    const loaded = await ensureMemoryStoreLoaded(context);
    let store = getMemoryStore(context) || loaded || null;
    if (!store) {
        return null;
    }
    const target = buildMemoryTargetFromContext(context);
    if (!target) {
        return store;
    }
    updateStoreSourceState(store, context);
    return store;
}

/**
 * Read a slice of the chat transcript by assistant-seq range (1-based,
 * the same ordinals the graph stores in `seqTo` / `floorRange`). Each
 * assistant frame contributes its preceding user turn (when present) and
 * the assistant message itself, so the caller sees both sides of the
 * exchange around each floor.
 */
export function readChatRange(context, fromAssistantSeq, toAssistantSeq) {
    const frames = buildPlayableFramesFromContext(context);
    const from = Math.max(0, Math.floor(Number(fromAssistantSeq) || 0));
    const to = Math.max(from, Math.floor(Number(toAssistantSeq) || from));
    const out = [];
    for (const frame of frames) {
        const seq = Number(frame?.seq || 0);
        if (seq < from || seq > to) {
            continue;
        }
        const lastUserText = String(frame?.last_user_mes || '');
        if (lastUserText) {
            out.push({ seq, role: 'user', content: lastUserText });
        }
        out.push({ seq, role: frame?.is_user ? 'user' : 'assistant', content: String(frame?.mes || '') });
    }
    return out;
}

/**
 * Semantic search over the current chat's graph using the configured
 * embedding profile. Throws when no valid profile is configured so the
 * tool layer can hand the model a precise retry hint (keyword search).
 */
export async function searchGraphSimilarNodes(context, query, { topK = 20 } = {}) {
    const currentSettings = getSettings();
    const effectiveSettings = getEffectiveSettings(context, currentSettings);
    const profile = getVectorConfigFromSettings(effectiveSettings);
    const validation = validateVectorConfig(profile);
    if (!validation.valid) {
        throw new Error(`no embedding profile configured: ${validation.error || 'unknown reason'}`);
    }
    const store = await ensureStoreSyncedWithChat(context);
    if (!store) {
        return [];
    }
    return await findSimilarNodes(String(query || ''), store, profile, getChatKey(context), { topK });
}

/** Assemble the graph-iteration studio's deps from module-scope helpers. */
async function openGraphIterationStudioWithDeps(context) {
    const settings = getSettings();
    await openGraphIterationStudio({
        context,
        settings,
        ensureStoreSyncedWithChat,
        commitGraphUiMutation,
        getChatKey,
        getEffectiveSettings,
        getEffectiveNodeTypeSchema,
        syncGraphVectorsAfterMutation,
        readChatRange,
        searchGraphSimilarNodes,
        i18n,
        i18nFormat,
    });
}

/**
 * Run the configured recall strategy and classify the outcome.
 *
 * `outcome: 'skip'` means the pipeline deliberately did not attempt recall
 * (recall disabled, no recallable nodes, empty query). Any provider,
 * transport, or tool-validation failure throws — the caller must not cache
 * or inject a result for those.
 */
async function collectRecallSelection(context, store, payload, settings, {
    chatKey,
    alwaysInjectNodes,
    recallRunToken,
}) {
    const recallMethod = String(settings.recallMethod || 'llm').trim().toLowerCase();
    let selectedNodes = [];
    let trace = [];
    let outcome = 'success';

    if (!settings.recallEnabled) {
        trace = [{ step: 'skip_recall_disabled' }];
        outcome = 'skip';
    } else if (recallMethod === 'rag' && !hasRecallableNodes(store)) {
        // Fresh chat (or a store whose nodes are all archived): there is
        // nothing RAG could return, so skip the index sync, the optional
        // query-rewrite LLM call, and the query embedding entirely.
        trace = [{ step: 'skip_rag_recall_no_nodes' }];
        outcome = 'skip';
    } else if (recallMethod === 'rag') {
        const queryBundle = getRecallQueryBundle(payload, context, settings);
        const queryText = normalizeText(queryBundle.fullText || '');

        // Ensure vector index is synced before first RAG recall
        const vs = ensureVectorIndexState(store);
        if (!vs.hashToNodeId || Object.keys(vs.hashToNodeId).length === 0) {
            const syncVectorConfig = getVectorConfigFromSettings(settings);
            const effectiveSchema = getEffectiveNodeTypeSchema(context, settings);
            await syncVectorIndex(store, syncVectorConfig, chatKey, {
                schema: effectiveSchema,
                signal: payload?.signal,
            });
            // syncVectorIndex mutates store.vectorIndexState in place, which is
            // a meta-sidecar field after Commit B. Without this persist call
            // the freshly-built hash map would only live in memoryStoreCache
            // and the next refreshMemoryStoreCacheFromFloorState would wipe
            // it — forcing a re-embed on every chat reload.
            //
            // No try/catch: silently warning here was the reason RAG chats
            // re-embedded the full corpus every recall. If the persist
            // fails, let injectMemoryPrompts' outer catch surface it as a
            // "Recall injection failed" notice so the user can act on the
            // real failure (auth, disk, target changed) instead of paying
            // the full-corpus cost on every subsequent turn.
            await persistMemoryStoreByChatKey(context, chatKey, store, { syncPersistentProjection: false });
        }

        let rewrittenQuery = null;
        const degradedReasons = [];
        if (settings.ragUseQueryRewrite && String(settings.ragRewriteApiPresetName || '').trim()) {
            try {
                rewrittenQuery = await runQueryRewrite(context, settings, queryBundle, {
                    abortSignal: payload?.signal || null,
                    recallRunToken,
                });
            } catch (error) {
                if (isAbortError(error, payload?.signal)) {
                    throw error;
                }
                // The selection is still valid without a rewrite; record the
                // degradation and use the raw query instead of failing recall.
                console.warn(`[${MODULE_NAME}] Query rewrite failed; using raw query`, error);
                degradedReasons.push('Query rewrite failed, used raw query');
            }
            throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
        }

        const useRerank = Boolean(settings.ragUseRerank);
        const rerankProfile = useRerank ? getRerankProfileFromSettings(settings) : null;
        const { perTypeK, defaultPerTypeK } = buildRagPerTypeQuotas(context, settings);

        const ragResult = await runRagRecall(store, queryText, chatKey, settings, {
            maxResults: Number(settings.hybridMaxResults) || 15,
            vectorTopK: Number(settings.vectorTopK) || 20,
            useRerank,
            rerankProfile,
            rewrittenQuery,
            perTypeK,
            defaultPerTypeK,
            signal: payload?.signal,
        });
        throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');

        if (ragResult.meta?.skipCode) {
            trace = [{
                step: `skip_rag_recall_${ragResult.meta.skipCode}`,
                method: 'rag',
                meta: ragResult.meta,
            }];
            outcome = 'skip';
        } else {
            if (degradedReasons.length > 0) {
                ragResult.meta.skipReasons = [
                    ...(Array.isArray(ragResult.meta.skipReasons) ? ragResult.meta.skipReasons : []),
                    ...degradedReasons,
                ];
            }

            const alwaysInjectSet = new Set(alwaysInjectNodes.map(n => n?.id).filter(Boolean));
            const latestSeqIndex = getLatestSeqIndex(store);
            const excludeMessages = Math.max(0, Number(settings.recentRawTurns ?? defaultSettings.recentRawTurns));

            selectedNodes = ragResult.candidates
                .map(c => store.nodes?.[c.nodeId])
                .filter(node => node && !node.archived && !alwaysInjectSet.has(node.id))
                .filter(node => !isNodeInRecentExcludeWindow(node, latestSeqIndex, excludeMessages))
                .sort(compareNodesByTimeline);

            // Structured recall diagnostic. Emits one row per RAG recall so users
            // can grep `[memory_graph] rag_recall` in DevTools when injection ends
            // up empty or lopsided. All numbers are counts so the payload stays
            // small — actual candidate lists are already in `store.lastRecallTrace`.
            // The three stages must add up for anyone reading the log to know
            // WHERE candidates disappeared:
            //   vector_hits   → returned by the embedding backend (post store-filter)
            //   rag_candidates → after per-type bucketing + optional rerank + maxResults trim
            //   selected      → after main-flow filters (alwaysInject exclusion + recent-turns window)
            try {
                const candByType = ragResult.candidates.reduce((acc, c) => {
                    const t = c.nodeType || 'unknown';
                    acc[t] = (acc[t] || 0) + 1;
                    return acc;
                }, {});
                const droppedAlwaysInject = ragResult.candidates.filter((c) => {
                    const n = store.nodes?.[c.nodeId];
                    return n && alwaysInjectSet.has(n.id);
                }).length;
                const droppedRecentWindow = ragResult.candidates.filter((c) => {
                    const n = store.nodes?.[c.nodeId];
                    return n && !alwaysInjectSet.has(n.id)
                        && isNodeInRecentExcludeWindow(n, latestSeqIndex, excludeMessages);
                }).length;
                const droppedArchivedOrMissing = ragResult.candidates.filter((c) => {
                    const n = store.nodes?.[c.nodeId];
                    return !n || n.archived;
                }).length;
                const perBucketFinal = ragResult.meta?.perBucket
                    ? Object.fromEntries(
                        Object.entries(ragResult.meta.perBucket)
                            .map(([type, m]) => [type, m?.finalCount ?? 0]),
                    )
                    : null;
                console.info(`[${MODULE_NAME}] rag_recall`, {
                    chatKey,
                    bucketing: {
                        perTypeK: perTypeK || null,
                        defaultPerTypeK,
                        active: Boolean(perBucketFinal),
                    },
                    vector: {
                        topKRequested: Number(settings.vectorTopK) || 20,
                        hits: ragResult.meta?.vectorHits ?? 0,
                    },
                    rerank: {
                        enabled: useRerank,
                        applied: Boolean(ragResult.meta?.rerankApplied),
                    },
                    candidates: {
                        total: ragResult.candidates.length,
                        byType: candByType,
                        perBucketFinal,
                    },
                    dropped: {
                        archivedOrMissing: droppedArchivedOrMissing,
                        alwaysInjectOverlap: droppedAlwaysInject,
                        recentTurnsWindow: droppedRecentWindow,
                    },
                    selected: {
                        count: selectedNodes.length,
                        recentTurnsWindowSize: excludeMessages,
                        alwaysInjectSetSize: alwaysInjectSet.size,
                    },
                    skipReasons: ragResult.meta?.skipReasons || [],
                });
            } catch (logErr) {
                console.warn(`[${MODULE_NAME}] rag_recall log emit failed`, logErr);
            }

            trace = [{
                step: 'rag_recall',
                method: 'rag',
                meta: ragResult.meta,
                selected_ids: selectedNodes.map(n => n.id),
            }];
        }
    } else {
        const llmResult = await runLLMDrivenRecall(context, store, payload);
        selectedNodes = llmResult.selectedNodes;
        trace = llmResult.trace;
    }

    return { selectedNodes, trace, outcome };
}

async function injectMemoryPrompts(context, payload) {
    const settings = getEffectiveSettings(context, getSettings());
    const generationType = String(payload?.type || '').trim().toLowerCase();
    const isDryRun = payload?.dryRun === true;
    const generationAbortSignal = isAbortSignalLike(payload?.__lukerRpgMemoryGenerationSignal)
        ? payload.__lukerRpgMemoryGenerationSignal
        : payload?.signal;
    const recallRunToken = Number(payload?.__lukerRpgMemoryRecallRunToken || 0);
    if (payload && typeof payload === 'object') {
        payload.__lukerRpgMemoryNeedRescan = false;
    }
    if (isDryRun || generationType === 'quiet') {
        return false;
    }
    if (!RECALL_ALLOWED_GENERATION_TYPES.has(generationType)) {
        return false;
    }
    if (!Array.isArray(payload?.coreChat)) {
        return false;
    }
    if (isAbortSignalLike(payload?.signal) && payload.signal.aborted) {
        updateUiStatus(isAbortSignalLike(generationAbortSignal) && generationAbortSignal.aborted
            ? i18n('Generation aborted. Skipped memory recall.')
            : i18n('Memory recall cancelled by user.'));
        return false;
    }

    if (!settings.enabled) {
        latestRecallSnapshot = null;
        await clearAllMemoryLorebookProjection(context, settings);
        updateUiStatus(i18n('Memory disabled, cleared memory lorebook injections.'));
        return false;
    }

    const store = await ensureStoreSyncedWithChat(context);
    if (!store) {
        latestRecallSnapshot = null;
        updateUiStatus(i18n('Memory store unavailable for current chat.'));
        return false;
    }
    throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
    const persistentSync = await syncPersistentLorebookProjection(context, settings, store);
    throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
    const corePacket = normalizeMultilineText(persistentSync.corePacket || '');
    if (isAbortSignalLike(payload?.signal) && payload.signal.aborted) {
        // Cancellation does not produce a recall result. The pre-scan
        // RUNTIME clear already removed any previous focus, so there is
        // nothing to write here. Persistent injection is unaffected.
        if (payload && typeof payload === 'object') {
            payload.__lukerRpgMemoryNeedRescan = Boolean(persistentSync.changed);
        }
        updateUiStatus(isAbortSignalLike(generationAbortSignal) && generationAbortSignal.aborted
            ? i18n('Generation aborted. Skipped memory recall.')
            : i18n('Memory recall cancelled by user.'));
        return false;
    }
    const chatKey = getChatKey(context);
    const anchor = buildLastUserAnchor(context, payload?.coreChat);
    throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
    const shouldReuseSnapshot = settings.recallEnabled
        && RECALL_REUSE_GENERATION_TYPES.has(generationType)
        && canReuseLatestRecallSnapshot(chatKey, anchor);
    if (shouldReuseSnapshot) {
        const focusPacket = normalizeMultilineText(latestRecallSnapshot?.blocks?.focusPacket || '');
        const blocks = { corePacket, focusPacket };
        store.lastRecallTrace = structuredClone(Array.isArray(latestRecallSnapshot.trace) ? latestRecallSnapshot.trace : []);
        store.lastRecallProjection = {
            at: Date.now(),
            blocks,
        };
        await persistRecallMetadataByChatKey(context, chatKey, {
            trace: store.lastRecallTrace,
            projection: store.lastRecallProjection,
        });
        throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
        const runtimeSync = await syncRuntimeLorebookProjection(context, settings, store);
        throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
        if (payload && typeof payload === 'object') {
            payload.__lukerRpgMemoryNeedRescan = Boolean(persistentSync.changed || runtimeSync.changed);
        }
        updateUiStatus(i18nFormat('Recall ready. selected=${0}', Math.max(0, Number(latestRecallSnapshot.selectedCount || 0))));
        return Boolean(persistentSync.changed || runtimeSync.changed);
    }

    // Persistent injection (alwaysInject nodes) ran above via
    // syncPersistentLorebookProjection. Collect here independently of recall
    // so __recordInjectedNodeIds publishes the real set even when recall is
    // disabled or short-circuits. Same recall-side options shape as
    // runLLMDrivenRecall — see computeRecallAlwaysInjectOptions.
    const alwaysInjectNodes = collectAlwaysInjectNodes(
        store,
        settings,
        context,
        computeRecallAlwaysInjectOptions(store, settings),
    );
    let selectedNodes = [];
    let trace = [];
    try {
        const selection = await collectRecallSelection(context, store, payload, settings, {
            chatKey,
            alwaysInjectNodes,
            recallRunToken,
        });
        selectedNodes = selection.selectedNodes;
        trace = selection.trace;
        if (selection.outcome === 'skip') {
            throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
            const skipProjection = { at: Date.now(), blocks: { corePacket, focusPacket: '' } };
            store.lastRecallTrace = trace;
            store.lastRecallProjection = skipProjection;
            __recordInjectedNodeIds({
                alwaysInjectIds: alwaysInjectNodes.map(node => String(node?.id || '')).filter(Boolean),
                recallSelectedIds: [],
            });
            await persistRecallMetadataByChatKey(context, chatKey, {
                trace,
                projection: skipProjection,
            });
            throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
            const skipRuntimeSync = await syncRuntimeLorebookProjection(context, settings, store);
            throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
            if (payload && typeof payload === 'object') {
                payload.__lukerRpgMemoryNeedRescan = Boolean(persistentSync.changed || skipRuntimeSync.changed);
            }
            updateUiStatus(i18n('Memory recall skipped.'));
            return Boolean(persistentSync.changed || skipRuntimeSync.changed);
        }
    } catch (error) {
        if (isAbortError(error, payload?.signal)
            || (Number(recallRunToken) > 0 && Number(recallRunToken) !== activeRecallRunToken)) {
            if (payload && typeof payload === 'object') {
                payload.__lukerRpgMemoryNeedRescan = Boolean(persistentSync.changed);
            }
            throw error;
        }
        console.error(`[${MODULE_NAME}] Recall selection failed`, error);
        const failureTrace = [{
            step: 'recall_failed',
            method: String(settings.recallMethod || 'llm').trim().toLowerCase(),
            message: String(error?.message || error),
        }];
        const failureProjection = { at: Date.now(), blocks: { corePacket, focusPacket: '' } };
        store.lastRecallTrace = failureTrace;
        store.lastRecallProjection = failureProjection;
        __recordInjectedNodeIds({
            alwaysInjectIds: (Array.isArray(persistentSync.alwaysInjectNodes) ? persistentSync.alwaysInjectNodes : [])
                .map(node => String(node?.id || ''))
                .filter(Boolean),
            recallSelectedIds: [],
        });
        try {
            await persistRecallMetadataByChatKey(context, chatKey, {
                trace: failureTrace,
                projection: failureProjection,
            });
        } catch (metadataError) {
            console.error(`[${MODULE_NAME}] Failed to persist recall failure metadata`, metadataError);
        }
        try {
            await syncRuntimeLorebookProjection(context, settings, store);
        } catch (runtimeError) {
            console.error(`[${MODULE_NAME}] Failed to clear runtime focus after recall failure`, runtimeError);
        }
        if (payload && typeof payload === 'object') {
            payload.__lukerRpgMemoryNeedRescan = Boolean(persistentSync.changed);
        }
        throw error;
    }

    throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
    store.lastRecallTrace = trace;

    // Publish the two id sets that this turn's main-flow injection has settled
    // on, so other extensions (orchestrator loop mode et al.) can dedup against
    // what's already in the main model context. Read via
    // `getCurrentlyInjectedNodeIds(context)` from external-api.js.
    __recordInjectedNodeIds({
        alwaysInjectIds: alwaysInjectNodes.map(node => String(node?.id || '')).filter(Boolean),
        recallSelectedIds: selectedNodes.map(node => String(node?.id || '')).filter(Boolean),
    });

    const blocks = {
        corePacket,
        focusPacket: normalizeMultilineText(buildFocusTablesText(selectedNodes, settings, { tablePrefix: 'Recall' }, context)),
    };
    store.lastRecallProjection = {
        at: Date.now(),
        blocks,
    };
    await persistRecallMetadataByChatKey(context, chatKey, {
        trace: store.lastRecallTrace,
        projection: store.lastRecallProjection,
    });
    throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
    const runtimeSync = await syncRuntimeLorebookProjection(context, settings, store);
    throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
    if (payload && typeof payload === 'object') {
        payload.__lukerRpgMemoryNeedRescan = Boolean(persistentSync.changed || runtimeSync.changed);
    }
    latestRecallSnapshot = anchor
        ? {
            chatKey,
            anchorFloor: anchor.floor,
            anchorPlayableFloor: anchor.playableFloor,
            anchorAssistantFloor: anchor.assistantFloor,
            anchorHash: anchor.hash,
            blocks: structuredClone(blocks),
            trace: structuredClone(trace),
            selectedCount: selectedNodes.length,
        }
        : null;
    updateUiStatus(i18nFormat('Recall ready. selected=${0}', selectedNodes.length));
    return Boolean(persistentSync.changed || runtimeSync.changed);
}

async function safeInjectMemoryPrompts(context, payload, trigger = 'after_world_info_scan') {
    const settings = getSettings();
    const generationType = String(payload?.type || '').trim().toLowerCase();
    clearPersistentRuntimeNotice();
    const shouldShowRuntimeToast = settings.enabled
        && settings.recallEnabled
        && RECALL_ALLOWED_GENERATION_TYPES.has(generationType)
        && payload?.dryRun !== true
        && generationType !== 'quiet'
        && Array.isArray(payload?.coreChat);
    if (activeRecallAbortController && !activeRecallAbortController.signal.aborted) {
        activeRecallAbortController.abort();
    }
    const recallRunToken = ++activeRecallRunToken;
    const recallAbortController = shouldShowRuntimeToast ? new AbortController() : null;
    if (recallAbortController) {
        activeRecallAbortController = recallAbortController;
    }
    const linkedAbort = linkAbortSignals(payload?.signal, recallAbortController?.signal);
    const effectivePayload = linkedAbort.signal && linkedAbort.signal !== payload?.signal
        ? {
            ...payload,
            signal: linkedAbort.signal,
            __lukerRpgMemoryGenerationSignal: payload?.signal || null,
            __lukerRpgMemoryRecallRunToken: recallRunToken,
        }
        : {
            ...payload,
            __lukerRpgMemoryRecallRunToken: recallRunToken,
        };
    let stopRequestedByUser = false;
    let resolveStopRequest = null;
    const stopRequestPromise = shouldShowRuntimeToast
        ? new Promise((resolve) => {
            resolveStopRequest = () => {
                if (stopRequestedByUser) {
                    return;
                }
                stopRequestedByUser = true;
                if (activeRecallRunToken === recallRunToken) {
                    activeRecallRunToken += 1;
                }
                void (async () => {
                    if (recallAbortController && !recallAbortController.signal.aborted) {
                        recallAbortController.abort();
                    }
                    await abortActiveRecallRequests(recallRunToken);
                    resolve({ stopped: true });
                })();
            };
        })
        : null;
    if (shouldShowRuntimeToast) {
        showRuntimeInfoToast(i18n('Memory recall running...'), {
            kind: 'recall',
            stopLabel: i18n('Stop'),
            onStop: () => {
                resolveStopRequest?.();
            },
        });
    }
    try {
        const injectTask = (async () => {
            const injected = await injectMemoryPrompts(context, effectivePayload);
            return { stopped: false, injected: Boolean(injected) };
        })();
        if (stopRequestPromise) {
            void injectTask.catch((error) => {
                if (!stopRequestedByUser) {
                    return;
                }
                if (!isAbortError(error, effectivePayload?.signal)) {
                    console.warn(`[${MODULE_NAME}] Recall task finished after user stop`, error);
                }
            });
        }
        const result = stopRequestPromise
            ? await Promise.race([injectTask, stopRequestPromise])
            : await injectTask;
        if (result?.stopped) {
            syncMutableGenerationPayloadState(payload, effectivePayload);
            if (payload && typeof payload === 'object') {
                // A recall-only stop still leaves the persistent channel
                // authoritative for this prompt. Keep any rescan request the
                // injection path recorded for a post-scan persistent update.
                const needRescan = Boolean(payload.__lukerRpgMemoryNeedRescan);
                payload.__lukerRpgMemoryNeedRescan = needRescan;
                payload.requestRescan = needRescan;
            }
            updateUiStatus(i18n('Memory recall cancelled by user.'));
            clearPersistentRuntimeNotice();
            return false;
        }
        syncMutableGenerationPayloadState(payload, effectivePayload);
        const injected = Boolean(result?.injected);
        if (injected && payload && typeof payload === 'object') {
            payload.__lukerRpgMemoryInjected = true;
        }
        clearPersistentRuntimeNotice();
        return Boolean(injected);
    } catch (error) {
        syncMutableGenerationPayloadState(payload, effectivePayload);
        if (isAbortError(error, effectivePayload?.signal)) {
            if (payload && typeof payload === 'object') {
                const needRescan = Boolean(payload.__lukerRpgMemoryNeedRescan);
                payload.__lukerRpgMemoryNeedRescan = needRescan;
                payload.requestRescan = needRescan;
            }
            const generationAborted = Boolean(isAbortSignalLike(payload?.signal) && payload.signal.aborted);
            updateUiStatus(generationAborted
                ? i18n('Generation aborted. Skipped memory recall.')
                : i18n('Memory recall cancelled by user.'));
            clearPersistentRuntimeNotice();
            return false;
        }
        console.error(`[${MODULE_NAME}] Recall injection failed during ${trigger}`, error);
        const failureText = i18nFormat(
            'Recall injection failed (${0}): ${1}',
            trigger,
            String(error?.message || error),
        );
        updateUiStatus(failureText);
        showPersistentRuntimeNotice(failureText);
        return false;
    } finally {
        linkedAbort.cleanup();
        if (activeRecallAbortController === recallAbortController) {
            activeRecallAbortController = null;
        }
        if (shouldShowRuntimeToast) {
            clearRuntimeInfoToast('recall');
        }
    }
}

async function captureLatestAssistantAfterGeneration() {
    const context = getContext();
    const settings = getSettings();
    if (!settings.enabled) {
        return;
    }
    if (!Array.isArray(context.chat) || context.chat.length === 0) {
        return;
    }
    const index = context.chat.length - 1;
    const message = context.chat[index];
    if (!message || message.is_system || message.is_user) {
        return;
    }
    if (!normalizeText(message.mes || '')) {
        return;
    }
    await ensureMemoryStoreLoaded(context);
    scheduleExtraction(context);
}

function getScheduledExtractionSingleFlightState(chatKey) {
    const key = String(chatKey || '').trim();
    if (!key) {
        return null;
    }
    if (!scheduledExtractionSingleFlightStates.has(key)) {
        scheduledExtractionSingleFlightStates.set(key, {
            running: false,
            rerun: false,
            cancelled: false,
        });
    }
    return scheduledExtractionSingleFlightStates.get(key);
}

function clearScheduledExtractionSingleFlightState(chatKey) {
    const key = String(chatKey || '').trim();
    if (!key) {
        return;
    }
    scheduledExtractionSingleFlightStates.delete(key);
}

async function runScheduledExtractionPass(chatKey) {
    const runtimeContext = getContext();
    if (getChatKey(runtimeContext) !== chatKey) {
        return;
    }
    const store = await ensureStoreSyncedWithChat(runtimeContext);
    if (!store) {
        return;
    }
    const extractionAbortController = new AbortController();
    activeExtractionAbortController = extractionAbortController;
    try {
        const settings = getEffectiveSettings(runtimeContext, getSettings());
        if (!settings.enabled) {
            refreshUiStats();
            return;
        }
        alignStoreCoverageToChat(store, runtimeContext, settings);
        const preview = computeExtractionWindow(runtimeContext, store, null, settings);
        if (preview.beginSeq > preview.latestSeq || preview.gap < Number(settings.updateEvery || 1)) {
            store.lastExtractionDebug = {
                beginSeq: preview.beginSeq,
                latestSeq: preview.latestSeq,
                coveredSeqTo: preview.coveredSeqTo,
                extracted: false,
                reason: preview.beginSeq > preview.latestSeq ? 'already_up_to_date' : 'gap_below_threshold',
                at: Date.now(),
            };
            const debug = store.lastExtractionDebug || {};
            updateUiStatus(i18nFormat(
                'Extraction ${0}: begin=${1} latest=${2} covered=${3}',
                'skip',
                Number(debug.beginSeq || 0),
                Number(debug.latestSeq || 0),
                Number(debug.coveredSeqTo || 0),
            ));
            refreshUiStats();
            return;
        }
        const workingStore = normalizeStoreForRuntime(store);
        let committedStore = normalizeStoreForRuntime(store);
        // Publish the pass's scope so `applyMutationInvalidationImpl`
        // can decide per-mutation whether to abort, shrink the tail, or
        // leave the pass alone. Stays live for the whole
        // runExtractionForStore call and is cleared in the outer
        // `finally` alongside `activeExtractionAbortController`.
        activeExtractionScope = {
            beginSeq: Number(preview.beginSeq || 0),
            latestSeq: Number(preview.latestSeq || 0),
            committedSeq: Number(preview.beginSeq || 0) - 1,
            inFlightSeqFrom: null,
            inFlightSeqTo: null,
        };
        const extractBatchTurns = Math.max(
            1,
            Math.floor(Number(settings?.extractBatchTurns || defaultSettings.extractBatchTurns || 1)),
        );
        const initialEndSeq = Math.min(
            Number(preview.latestSeq || 0),
            Number(preview.beginSeq || 1) + extractBatchTurns - 1,
        );
        showRuntimeInfoToast(formatExtractionRangeToast(preview.beginSeq, initialEndSeq, preview.latestSeq), {
            stopLabel: i18n('Stop'),
            onStop: () => {
                if (!extractionAbortController.signal.aborted) {
                    extractionAbortController.abort();
                }
            },
        });
        // Each batch + each compression round commit anchors at the floor of
        // the triggering batch (seqToFloor(batchEndSeq)). Compression runs
        // inline after every batch and uses the batch's endSeq, never the
        // rollup parent's own seqTo — the parent can fold in pre-existing
        // older nodes whose seqTo predates the current batch, which would
        // anchor the commit at a much earlier floor and break log-append
        // monotonicity (see tests/floor-state/compaction-floor-anchor.test.js
        // for the failure mode this avoids).
        await runExtractionForStore(runtimeContext, workingStore, {
            abortSignal: extractionAbortController.signal,
            getEffectiveLatestSeq: () => activeExtractionScope?.latestSeq ?? Number(preview.latestSeq || 0),
            onBatchStart: ({ beginSeq, endSeq, latestSeq }) => {
                if (activeExtractionScope) {
                    activeExtractionScope.inFlightSeqFrom = Number(beginSeq || 0);
                    activeExtractionScope.inFlightSeqTo = Number(endSeq || 0);
                }
                updateRuntimeInfoToastMessage(formatExtractionRangeToast(beginSeq, endSeq, latestSeq));
            },
            onPhaseProgress: ({ beginSeq, endSeq, latestSeq, stage, done, total }) => {
                updateRuntimeInfoToastMessage(`${formatExtractionRangeToast(beginSeq, endSeq, latestSeq)} · ${formatExtractionPhaseToast(stage, done, total)}`);
            },
            onBatchApplied: async ({ endSeq }) => {
                const batchResult = await commitMemoryStoreDiffByChatKey(
                    runtimeContext,
                    chatKey,
                    committedStore,
                    workingStore,
                    endSeq,
                    { syncPersistentProjection: true, floor: seqToFloor(runtimeContext, endSeq) },
                );
                committedStore = batchResult.store;
                if (activeExtractionScope) {
                    activeExtractionScope.committedSeq = Math.max(
                        activeExtractionScope.committedSeq,
                        Number(endSeq || 0),
                    );
                    activeExtractionScope.inFlightSeqFrom = null;
                    activeExtractionScope.inFlightSeqTo = null;
                }
            },
            onCompressionApplied: async ({ beforeStore, batchEndSeq }) => {
                const compactionResult = await commitMemoryStoreDiffByChatKey(
                    runtimeContext,
                    chatKey,
                    beforeStore,
                    workingStore,
                    batchEndSeq,
                    { syncPersistentProjection: true, floor: seqToFloor(runtimeContext, batchEndSeq) },
                );
                committedStore = compactionResult.store;
                if (activeExtractionScope) {
                    activeExtractionScope.committedSeq = Math.max(
                        activeExtractionScope.committedSeq,
                        Number(batchEndSeq || 0),
                    );
                }
            },
        });
        // A mutation may have shrunk the pass below its launch-time bound, or
        // a batch may have bailed without processing. Anchor the tail commit
        // at the last batch that actually committed — `preview.latestSeq` can
        // point past extracted coverage and, after a tail delete, no longer
        // map to an existing floor.
        const finalSeq = Number(activeExtractionScope ? activeExtractionScope.committedSeq : preview.latestSeq);
        const finalResult = await commitMemoryStoreDiffByChatKey(
            runtimeContext,
            chatKey,
            committedStore,
            workingStore,
            finalSeq,
            { syncPersistentProjection: true, floor: seqToFloor(runtimeContext, finalSeq) },
        );
        const finalStore = finalResult.store;
        // Sync vector index after extraction (only when RAG recall is enabled)
        const effectiveStore = finalStore || workingStore;
        const recallMethod = String(settings.recallMethod || 'llm').trim().toLowerCase();
        if (recallMethod !== 'llm' && effectiveStore) {
            try {
                const vectorConfig = getVectorConfigFromSettings(settings);
                if (validateVectorConfig(vectorConfig).valid) {
                    const chatIdForVector = String(chatKey || '').trim();
                    const effectiveSchema = settings.nodeTypeSchema || defaultSettings.nodeTypeSchema;
                    await syncVectorIndex(effectiveStore, vectorConfig, chatIdForVector, {
                        signal: extractionAbortController.signal,
                        schema: effectiveSchema,
                    });
                    // syncVectorIndex mutates effectiveStore.vectorIndexState
                    // in place. That field is meta-sidecar after Commit B, so
                    // we explicitly persist here — the preceding
                    // commitMemoryStoreDiffByChatKey ran *before* the sync and
                    // already wrote its meta snapshot without the new hashes.
                    try {
                        await persistMemoryStoreByChatKey(runtimeContext, chatKey, effectiveStore, { syncPersistentProjection: false });
                    } catch (persistError) {
                        console.warn(`[${MODULE_NAME}] Failed to persist vectorIndexState after extraction-tail sync: ${persistError?.message || persistError}`);
                    }
                }
            } catch (vecError) {
                if (!isAbortError(vecError, extractionAbortController.signal)) {
                    console.warn(`[${MODULE_NAME}] Vector index sync after extraction failed`, vecError);
                }
            }
        }

        const debug = finalStore?.lastExtractionDebug || workingStore.lastExtractionDebug || {};
        updateUiStatus(i18nFormat(
            'Extraction ${0}: begin=${1} latest=${2} covered=${3}',
            debug.extracted ? 'ok' : 'skip',
            Number(debug.beginSeq || 0),
            Number(debug.latestSeq || 0),
            Number(debug.coveredSeqTo || 0),
        ));
        clearPersistentRuntimeNotice();
        refreshUiStats();
    } catch (error) {
        if (isAbortError(error, extractionAbortController.signal)) {
            updateUiStatus(i18n('Memory graph update cancelled by user.'));
            clearPersistentRuntimeNotice();
            refreshUiStats();
            return;
        }
        console.warn(`[${MODULE_NAME}] Extraction failed`, error);
        const failureText = i18nFormat('Recall injection failed (${0}): ${1}', 'extract', String(error?.message || error));
        updateUiStatus(failureText);
        showPersistentRuntimeNotice(failureText);
    } finally {
        if (activeExtractionAbortController === extractionAbortController) {
            activeExtractionAbortController = null;
            activeExtractionScope = null;
        }
        clearRuntimeInfoToast('extraction');
    }
}

function scheduleExtraction(context) {
    const settings = getEffectiveSettings(context, getSettings());
    if (!settings.enabled) {
        return;
    }
    if (!settings.autoExtractionEnabled) {
        return;
    }
    const chatKey = getChatKey(context);
    if (!chatKey || chatKey === 'invalid_target') {
        return;
    }
    const singleFlightState = getScheduledExtractionSingleFlightState(chatKey);
    if (!singleFlightState) {
        return;
    }
    if (singleFlightState.running) {
        if (!singleFlightState.cancelled) {
            singleFlightState.rerun = true;
        }
        return;
    }
    if (singleFlightState.cancelled) {
        clearScheduledExtractionSingleFlightState(chatKey);
    }
    if (extractionTimers.has(chatKey)) {
        return;
    }

    const timer = setTimeout(async () => {
        extractionTimers.delete(chatKey);
        const runState = getScheduledExtractionSingleFlightState(chatKey);
        if (!runState) {
            return;
        }
        if (runState.running) {
            if (!runState.cancelled) {
                runState.rerun = true;
            }
            return;
        }
        runState.running = true;
        runState.cancelled = false;
        try {
            do {
                runState.rerun = false;
                await runScheduledExtractionPass(chatKey);
            } while (runState.rerun && !runState.cancelled);
        } finally {
            runState.running = false;
            runState.rerun = false;
            clearScheduledExtractionSingleFlightState(chatKey);
        }
    }, 0);

    extractionTimers.set(chatKey, timer);
}

function getStoreStats(store) {
    const nodes = Object.values(store.nodes || {});
    const levelCount = {
        semantic: nodes.filter(n => n.level === LEVEL.SEMANTIC).length,
    };

    return {
        nodeCount: nodes.length,
        edgeCount: Array.isArray(store.edges) ? store.edges.length : 0,
        messageCount: getStoreCoveredSeqTo(store),
        sourceMessageCount: Number(store.sourceMessageCount || 0),
        levelCount,
        lastRecallSteps: Array.isArray(store.lastRecallTrace) ? store.lastRecallTrace.length : 0,
    };
}


function getLastRecallProjection(store) {
    return store?.lastRecallProjection && typeof store.lastRecallProjection === 'object'
        ? store.lastRecallProjection
        : null;
}


function notifySuccess(message) {
    emitMemoryStatus(message);
    if (typeof toastr !== 'undefined') {
        toastr.success(String(message));
    }
}

function notifyError(message) {
    emitMemoryStatus(message);
    if (typeof toastr !== 'undefined') {
        toastr.error(String(message));
    }
}

function notifyInfo(message) {
    emitMemoryStatus(message);
    if (typeof toastr !== 'undefined') {
        toastr.info(String(message));
    }
}

/**
 * Info toast for an extraction retry round. `category` is 'request' |
 * 'incomplete' | 'invalid'; `attemptIndex` is the 0-based index of the
 * attempt that just failed and `maxRetries` the configured retry budget.
 * Silenced when no retry follows (the failed attempt was the last one).
 */
function notifyExtractionRetry(category, attemptIndex, maxRetries) {
    if (!(attemptIndex < maxRetries)) {
        return;
    }
    const key = category === 'request'
        ? 'Memory graph request failed, retrying (${0}/${1})…'
        : category === 'invalid'
            ? 'Memory graph extraction result invalid, retrying (${0}/${1})…'
            : 'Memory graph extraction result incomplete, retrying (${0}/${1})…';
    notifyInfo(i18nFormat(key, attemptIndex + 1, maxRetries));
}

function showPersistentRuntimeNotice(message, { level = 'error' } = {}) {
    if (typeof toastr === 'undefined') {
        return;
    }
    clearPersistentRuntimeNotice();
    const method = typeof toastr?.[level] === 'function' ? level : 'error';
    const toast = toastr[method](String(message || ''), i18n('Memory Graph'), {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: true,
        closeButton: true,
        progressBar: false,
        newestOnTop: true,
        onHidden: () => {
            if (activePersistentRuntimeNoticeToast === toast) {
                activePersistentRuntimeNoticeToast = null;
            }
        },
    });
    if (toast?.length) {
        toast.addClass('luker-persistent-toast');
        activePersistentRuntimeNoticeToast = toast;
    }
}

function clearPersistentRuntimeNotice() {
    if (typeof toastr === 'undefined' || !activePersistentRuntimeNoticeToast) {
        return;
    }
    const toast = activePersistentRuntimeNoticeToast;
    activePersistentRuntimeNoticeToast = null;
    toastr.clear(toast);
}

function notifyEventCompressionIfAny(compressionStats) {
    const eventRounds = getCompressionRoundsByType(compressionStats, 'event');
    if (eventRounds <= 0) {
        return;
    }
    notifyInfo(i18nFormat('Event compression completed: ${0} round(s).', eventRounds));
}

function showRuntimeInfoToast(message, { stopLabel = '', onStop = null, kind = 'extraction' } = {}) {
    if (kind === 'extraction') emitMemoryStatus(message);
    if (typeof toastr === 'undefined') {
        return;
    }
    if (kind === 'recall') {
        if (activeRecallToast) { toastr.clear(activeRecallToast); activeRecallToast = null; }
    } else {
        if (activeExtractionToast) { toastr.clear(activeExtractionToast); activeExtractionToast = null; }
    }
    const toastRef = toastr.info(String(message || ''), '', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        progressBar: false,
    });
    if (kind === 'recall') { activeRecallToast = toastRef; } else { activeExtractionToast = toastRef; }
    const toastBody = toastRef ? toastRef.find('.toast-message') : null;
    if (toastBody && toastBody.length > 0) {
        toastBody.empty();
        const textNode = jQuery('<div class="luker-rpg-memory-toast-text"></div>');
        textNode.text(String(message || ''));
        toastBody.append(textNode);
        if (typeof onStop === 'function') {
            const button = jQuery('<button type="button" class="menu_button menu_button_small luker-toast-stop-button"></button>');
            button.text(String(stopLabel || i18n('Stop')));
            button.on('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                button.prop('disabled', true);
                const toastElement = button.closest('.toast');
                clearRuntimeInfoToast(kind);
                if (toastElement && toastElement.length > 0) {
                    toastElement.remove();
                }
                onStop();
            });
            toastBody.append(button);
        }
    }
}

function updateRuntimeInfoToastMessage(message, kind = 'extraction') {
    if (kind === 'extraction') emitMemoryStatus(message);
    const toastRef = kind === 'recall' ? activeRecallToast : activeExtractionToast;
    if (!toastRef) {
        return;
    }
    const textNode = toastRef.find('.luker-rpg-memory-toast-text');
    if (textNode.length > 0) {
        textNode.text(String(message || ''));
    }
}

function clearRuntimeInfoToast(kind) {
    if (typeof toastr === 'undefined') {
        return;
    }
    if (kind === 'recall') {
        if (activeRecallToast) { toastr.clear(activeRecallToast); activeRecallToast = null; }
    } else if (kind === 'extraction') {
        if (activeExtractionToast) { toastr.clear(activeExtractionToast); activeExtractionToast = null; }
    } else {
        if (activeExtractionToast) { toastr.clear(activeExtractionToast); activeExtractionToast = null; }
        if (activeRecallToast) { toastr.clear(activeRecallToast); activeRecallToast = null; }
    }
}

async function stopMemoryRuntimeWork() {
    clearRuntimeInfoToast();
    clearPersistentRuntimeNotice();

    for (const timer of extractionTimers.values()) {
        clearTimeout(timer);
    }
    extractionTimers.clear();
    for (const state of scheduledExtractionSingleFlightStates.values()) {
        state.rerun = false;
        state.cancelled = true;
    }

    const recallRunToken = Number(activeRecallRunToken || 0);
    if (recallRunToken > 0) {
        activeRecallRunToken += 1;
    }

    if (activeRecallAbortController && !activeRecallAbortController.signal.aborted) {
        activeRecallAbortController.abort();
    }
    if (activeExtractionAbortController && !activeExtractionAbortController.signal.aborted) {
        activeExtractionAbortController.abort();
    }

    if (recallRunToken > 0) {
        await abortActiveRecallRequests(recallRunToken);
    }
}

function updateUiStatus(text) {
    emitMemoryStatus(text);
}

/** Kept for its callers; Memory Lens reads the stats when it renders. */
function refreshUiStats() {}


async function persistAdvancedToGlobal(settings, advancedSettings) {
    applyAdvancedSettings(settings, advancedSettings);
    invalidateLatestRecallSnapshot();
    await saveSettings();
}

async function persistAdvancedToCharacter(context, avatar, advancedSettings) {
    const targetAvatar = String(avatar || '').trim();
    if (!targetAvatar) {
        return false;
    }
    invalidateLatestRecallSnapshot();
    return await persistCharacterAdvancedOverride(context, targetAvatar, advancedSettings);
}


// ---- Advanced tab (in-drawer) helpers -----------------------------------
// The Advanced tab embeds all 14 advanced settings + Schema controls
// directly in the drawer. Semantics: form changes take effect immediately
// (write to `settings` in memory + normalized) but are NOT persisted to
// settings.json or character override until user clicks Save to Global /
// Save to Character. Reset only restores defaults into the form; user
// must click Save Global to persist.


export function getCompressibleTypeSpecs(settings, context = null) {
    const schema = getEffectiveNodeTypeSchema(context, settings);
    const specs = [];
    for (const item of schema) {
        const typeId = String(item?.id || '').trim().toLowerCase();
        if (!typeId) {
            continue;
        }
        const config = getSemanticCompressionConfig(settings, typeId, context);
        if (config.mode === 'none') {
            continue;
        }
        specs.push({
            id: typeId,
            label: String(item?.label || typeId),
            mode: config.mode,
        });
    }
    return specs;
}


async function prepareVectorRecompute(context, settings) {
    await ensureMemoryStoreLoaded(context);
    const chatKey = getChatKey(context);
    const store = memoryStoreCache.get(chatKey);
    if (!store) {
        notifyError(i18n('No active chat selected.'));
        return null;
    }

    const vectorConfig = getVectorConfigFromSettings(settings);
    const validation = validateVectorConfig(vectorConfig);
    if (!validation.valid) {
        notifyError(i18n('Embedding profile is not configured. Configure it in the settings above first.'));
        return null;
    }

    const nodes = store?.nodes || {};
    const hasAnyNode = Object.values(nodes).some(node => !node?.archived);
    if (!hasAnyNode) {
        notifyInfo(i18n('No eligible nodes to embed.'));
        return null;
    }
    return { store, chatKey };
}

/** Recomputes vectors for the current chat; mode is incremental or full. */
export async function runVectorRecomputeForChat(context, mode, settings = getEffectiveSettings(context, getSettings())) {
    const prepared = await prepareVectorRecompute(context, settings);
    if (prepared) await runVectorRecompute(context, settings, prepared.store, prepared.chatKey, { mode });
}


async function runVectorRecompute(context, settings, store, chatKey, { mode }) {
    const vectorConfig = getVectorConfigFromSettings(settings);
    const schema = getEffectiveNodeTypeSchema(context, settings);
    const vs = ensureVectorIndexState(store);
    const profileChanged = Boolean(vs.source) && (vs.source !== vectorConfig.source || (vs.model || '') !== (vectorConfig.model || ''));

    let purge = mode === 'full';
    if (mode === 'incremental' && profileChanged) {
        notifyInfo(i18n('Embedding configuration changed. Switching to full rebuild automatically.'));
        purge = true;
    }

    let progressToast = null;
    const updateProgressToast = (current, total) => {
        if (typeof toastr === 'undefined') return;
        const message = i18nFormat('Recomputing vectors: ${0} / ${1}', current, total);
        if (!progressToast) {
            progressToast = toastr.info(message, '', {
                timeOut: 0,
                extendedTimeOut: 0,
                tapToDismiss: false,
                closeButton: false,
                progressBar: false,
            });
        }
        if (progressToast) {
            const body = progressToast.find('.toast-message');
            if (body && body.length) body.text(message);
        }
    };
    const dismissProgressToast = () => {
        if (progressToast && typeof toastr !== 'undefined') {
            toastr.clear(progressToast);
        }
        progressToast = null;
    };

    notifyInfo(i18n('Starting vector recompute…'));
    try {
        const result = await syncVectorIndex(store, vectorConfig, chatKey, {
            schema,
            purge,
            tolerateErrors: true,
            onProgress: ({ current, total }) => updateProgressToast(current, total),
        });
        await persistMemoryStoreByChatKey(context, chatKey, store, { syncPersistentProjection: false });
        const total = Number(result?.stats?.total || 0);
        const inserted = Number(result?.insertedCount || 0);
        const deleted = Number(result?.deletedCount || 0);
        const failed = Array.isArray(result?.failedNodeIds) ? result.failedNodeIds.length : 0;
        if (total === 0) {
            notifyInfo(i18n('No eligible nodes to embed.'));
        } else if (inserted === 0 && deleted === 0 && failed === 0) {
            notifySuccess(i18n('Vector index already up to date.'));
        } else if (failed > 0) {
            notifyError(i18nFormat('Vector recompute complete: ${0} indexed, ${1} failed (see console).', inserted, failed));
        } else {
            notifySuccess(i18nFormat('Vector recompute complete: ${0} indexed.', inserted));
        }
    } catch (error) {
        console.error(`[${MODULE_NAME}] Vector recompute (${mode}) failed:`, error);
        notifyError(i18nFormat('Vector recompute failed: ${0}', String(error?.message || error)));
    } finally {
        dismissProgressToast();
        refreshUiStats();
    }
}

// ---- Shared by the settings drawer and Memory Lens --------------------------

const memoryStatusListeners = new Set();
let lastMemoryStatus = '';

function emitMemoryStatus(text) {
    lastMemoryStatus = String(text || '');
    for (const cb of memoryStatusListeners) {
        try { cb(lastMemoryStatus); } catch { /* listener errors stay local */ }
    }
}

export function getMemoryStatus() {
    return lastMemoryStatus;
}

export function addMemoryStatusListener(cb) {
    memoryStatusListeners.add(cb);
    return () => memoryStatusListeners.delete(cb);
}

export function getMemoryGraphStats(context) {
    return getStoreStats(getMemoryStore(context) || createEmptyStore());
}

/** Same effect as the runtime toast's Stop button for the running extraction. */
export function stopMemoryExtraction() {
    if (activeExtractionAbortController && !activeExtractionAbortController.signal.aborted) {
        activeExtractionAbortController.abort();
    }
}

export function getRebuildableLatestSeq(context, settings = getSettings()) {
    return getExtractableLatestSeq(buildPlayableFramesFromContext(context).length, getEffectiveSettings(context, settings));
}

export function openMemoryGraphStudio(context) {
    return openGraphIterationStudioWithDeps(context);
}

const clampInt = (value, min, max, fallback) => Math.max(min, Math.min(max, Math.floor(Number(value) || fallback)));
const trimmed = (value) => String(value || '').trim();
const recallPreset = { read: trimmed, recall: true };
const plainPreset = { read: trimmed };

const MEMORY_SETTING_RULES = {
    enabled: {
        read: Boolean,
        after(settings) {
            invalidateLatestRecallSnapshot();
            syncGenerationVisibleHistoryRuntimeRegexScripts();
            void syncMemoryLorebookActivation(getContext(), settings);
            if (settings.enabled) {
                void syncPersistentProjectionForCurrentChat(getContext());
            } else {
                void stopMemoryRuntimeWork();
                updateUiStatus(i18n('Memory disabled, cleared memory lorebook injections.'));
            }
        },
    },
    recallEnabled: { read: Boolean, recall: true },
    autoExtractionEnabled: { read: Boolean },
    autoCompressionEnabled: { read: Boolean },
    recallMethod: { read: (v) => trimmed(v) || 'llm', recall: true },
    vectorTopK: { read: (v) => clampInt(v, 5, 100, 20), recall: true },
    hybridMaxResults: { read: (v) => clampInt(v, 3, 50, 15), recall: true },
    ragDefaultPerTypeK: {
        read: (v) => Math.max(0, Math.min(50, Math.floor(Number.isFinite(Number(v)) ? Number(v) : defaultSettings.ragDefaultPerTypeK))),
        recall: true,
    },
    embeddingProfileId: { read: (v) => String(v || ''), recall: true },
    rerankProfileId: { read: (v) => String(v || ''), recall: true },
    ragUseRerank: { read: Boolean, recall: true },
    ragUseQueryRewrite: { read: Boolean, recall: true },
    ragRewriteApiPresetName: recallPreset,
    ragRewriteLlmPresetName: recallPreset,
    recallInjectPosition: { read: normalizeRecallInjectPosition, projection: true },
    recallInjectDepth: { read: normalizeRecallInjectDepth, projection: true },
    recallInjectRole: { read: normalizeRecallInjectRole, projection: true },
    recallApiPresetName: recallPreset,
    recallPresetName: recallPreset,
    extractApiPresetName: plainPreset,
    extractPresetName: plainPreset,
    requestApiPresetName: plainPreset,
    requestLlmPresetName: plainPreset,
    updateEvery: { read: (v) => Math.max(1, Math.floor(Number(v) || defaultSettings.updateEvery)) },
};

/** Writes one drawer-level setting with the side effects of its native control. */
export function setMemorySetting(key, value) {
    const rule = MEMORY_SETTING_RULES[key];
    if (!rule) throw new Error(`Unknown memory setting: ${key}`);
    const settings = getSettings();
    settings[key] = rule.read(value);
    if (rule.recall) invalidateLatestRecallSnapshot();
    if (rule.projection) void syncPersistentProjectionForCurrentChat(getContext());
    rule.after?.(settings);
    saveSettingsDebounced();
    return settings[key];
}

function withAdvancedPromptDefaults(source) {
    return {
        ...source,
        extractTemplate: source.extractTemplate || DEFAULT_EXTRACT_TEMPLATE,
        extractEdgeRules: source.extractEdgeRules || DEFAULT_EXTRACT_EDGE_RULES,
        extractCrawlSystemPrompt: source.extractCrawlSystemPrompt || DEFAULT_CRAWL_SYSTEM_PROMPT,
        recallRouteSystemPrompt: source.recallRouteSystemPrompt || DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT,
        recallFinalizeSystemPrompt: source.recallFinalizeSystemPrompt || DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT,
        ragRewriteSystemPrompt: source.ragRewriteSystemPrompt || DEFAULT_RAG_REWRITE_SYSTEM_PROMPT,
        configIterSystemPrompt: source.configIterSystemPrompt || DEFAULT_CONFIG_ITER_SYSTEM_PROMPT,
    };
}

/** Everything the settings page shows: values, choices and the advanced scope. */
export function getMemorySettingsView(context) {
    const settings = getSettings();
    const values = Object.fromEntries(Object.keys(MEMORY_SETTING_RULES).map(key => [key, structuredClone(settings[key])]));
    const info = getAdvancedScopeInfo(context, settings);
    return {
        values,
        options: {
            connections: getConnectionProfiles().map(profile => profile.name).filter(Boolean),
            presets: getOpenAIPresetNames(context),
            positions: { ...world_info_position },
            roles: { ...extension_prompt_roles },
            compressibleTypes: getCompressibleTypeSpecs(getEffectiveSettings(context, settings), context),
        },
        advanced: {
            values: withAdvancedPromptDefaults(info.settings),
            defaults: withAdvancedPromptDefaults(normalizeAdvancedSettings(defaultSettings, defaultSettings)),
            scope: info.scope,
            hasAvatar: info.hasAvatar,
            hasOverride: info.hasOverride,
            avatar: info.avatar,
            characterName: info.characterName,
        },
    };
}

/** @param {'global'|'character'} scope */
export async function saveMemoryAdvancedSettings(context, values, scope, expectedAvatar) {
    const settings = getSettings();
    const normalized = normalizeAdvancedSettings(values, settings);
    if (scope === 'character') {
        const info = getAdvancedScopeInfo(context, settings);
        if (expectedAvatar !== undefined && info.avatar !== expectedAvatar) throw new Error(i18n('The active character has changed.'));
        if (!info.hasAvatar) throw new Error(i18n('No active character selected.'));
        if (!await persistAdvancedToCharacter(context, info.avatar, normalized)) {
            throw new Error(i18n('Failed to persist character advanced override.'));
        }
    } else {
        await persistAdvancedToGlobal(settings, normalized);
    }
    syncGenerationVisibleHistoryRuntimeRegexScripts();
}

export async function clearMemoryAdvancedOverride(context, expectedAvatar) {
    const info = getAdvancedScopeInfo(context, getSettings());
    if (expectedAvatar !== undefined && info.avatar !== expectedAvatar) throw new Error(i18n('The active character has changed.'));
    if (!info.hasAvatar) throw new Error(i18n('No active character selected.'));
    if (!await removeCharacterAdvancedOverride(context, info.avatar)) {
        throw new Error(i18n('Failed to clear character advanced override.'));
    }
    syncGenerationVisibleHistoryRuntimeRegexScripts();
    invalidateLatestRecallSnapshot();
}


/** Stops running work, then imports a graph file into the current chat. */
export async function importMemoryGraphFile(context, file) {
    await stopMemoryRuntimeWork();
    await ensureMemoryStoreLoaded(context);
    const store = getMemoryStore(context);
    if (!store) {
        notifyError(i18n('No active chat selected.'));
        return;
    }
    const importToast = toastr.info(i18n('Importing memory graph…'), '', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
    });
    try {
        await new Promise(resolve => setTimeout(resolve, 0));
        const parsed = JSON.parse(await getFileText(file));
        await new Promise(resolve => setTimeout(resolve, 0));
        const imported = await importMemoryGraphStore(context, parsed);
        if (!imported) {
            return;
        }
        notifySuccess(i18n('Memory graph imported for current chat.'));
        if (imported.importMode === 'restore') {
            updateUiStatus(i18nFormat('Imported memory graph and restored exported floor ${0}.', imported.bindFloor));
        } else if (imported.importMode === 'bind_latest') {
            updateUiStatus(i18nFormat('Imported memory graph and bound it to latest assistant floor ${0}.', imported.bindFloor));
        } else {
            updateUiStatus(i18nFormat('Imported memory graph and bound it to assistant floor ${0}.', imported.bindFloor));
        }
    } catch (error) {
        notifyError(i18nFormat('Import failed: ${0}', error?.message || error));
        updateUiStatus(i18n('Memory graph import failed.'));
    } finally {
        if (importToast) {
            toastr.clear(importToast);
        }
    }
}

/** Downloads the current chat's memory graph as JSON. */
export async function exportMemoryGraph(context) {
    await ensureMemoryStoreLoaded(context);
    const store = getMemoryStore(context);
    if (!store) {
        notifyError(i18n('No active chat selected.'));
        return;
    }
    const fileName = getMemoryGraphExportFileNameForContext(context);
    download(JSON.stringify(store, null, 2), fileName, 'application/json');
    notifySuccess(i18n('Memory graph exported for current chat.'));
    updateUiStatus(i18nFormat('Downloaded memory graph file: ${0}', fileName));
}

/** Clears the current chat's graph, projections and vectors. */
export async function resetMemoryGraphForChat(context, settings = getSettings()) {
    await stopMemoryRuntimeWork();
    const chatKey = getChatKey(context);
    const target = memoryStoreTargets.get(chatKey) || buildMemoryTargetFromContext(context);
    if (target) {
        memoryStoreTargets.set(chatKey, target);
    }
    memoryStoreCache.set(chatKey, createEmptyStore());
    clearCachedMeta(chatKey);
    clearRollbackHistory(chatKey);
    let resetResult = { ok: true, partial: {} };
    if (target) {
        resetResult = await deleteMemoryStoreByTarget(context, target);
    }
    await clearAllMemoryLorebookProjection(context, settings);
    try {
        const vectorConfig = getVectorConfigFromSettings(settings);
        if (vectorConfig) {
            await purgeVectorCollection(buildCollectionId(chatKey));
        }
    } catch (vectorError) {
        console.warn(`[${MODULE_NAME}] Failed to purge vector collection on reset`, vectorError);
    }
    refreshUiStats();
    if (resetResult.ok) {
        notifySuccess(i18n('Current chat memory graph reset.'));
    } else {
        const stages = Object.entries(resetResult.partial).map(([k, v]) => `${k}=${v}`).join(', ');
        notifyError(i18nFormat('Memory graph reset incomplete: ${0}', stages));
    }
    updateUiStatus(i18n('Reset memory graph for current chat.'));
}

/** Re-extracts the latest N assistant turns. */
export async function runRebuildRecent(context, recentTurns, settings = getSettings()) {
    await ensureMemoryStoreLoaded(context);
    const chatKey = getChatKey(context);
    let store = memoryStoreCache.get(chatKey);
    if (!store) {
        notifyError(i18n('No active chat selected.'));
        return;
    }
    const runtimeSettings = getEffectiveSettings(context, settings);
    alignStoreCoverageToChat(store, context, runtimeSettings);
    const latestSeq = getExtractableLatestSeq(buildPlayableFramesFromContext(context).length, runtimeSettings);
    if (latestSeq <= 0) {
        notifyError(i18n('No assistant turns available to rebuild.'));
        return;
    }

    const startSeq = Math.max(1, latestSeq - recentTurns + 1);
    const workingStore = normalizeStoreForRuntime(store);
    truncateStoreFromSeq(workingStore, startSeq);
    updateStoreSourceState(workingStore, context);
    const rebuildAbortController = new AbortController();
    activeExtractionAbortController = rebuildAbortController;
    let hasCommittedBatch = false;
    const extractBatchTurns = Math.max(
        1,
        Math.floor(Number(runtimeSettings?.extractBatchTurns || defaultSettings.extractBatchTurns || 1)),
    );
    const initialEndSeq = Math.min(
        latestSeq,
        startSeq + extractBatchTurns - 1,
    );
    showRuntimeInfoToast(formatExtractionRangeToast(startSeq, initialEndSeq, latestSeq), {
        stopLabel: i18n('Stop'),
        onStop: () => {
            if (!rebuildAbortController.signal.aborted) {
                rebuildAbortController.abort();
            }
        },
    });
    try {
        const extracted = await runExtractionForStore(context, workingStore, {
            force: true,
            startSeq,
            abortSignal: rebuildAbortController.signal,
            onBatchStart: ({ beginSeq, endSeq, latestSeq: latest }) => {
                updateRuntimeInfoToastMessage(formatExtractionRangeToast(beginSeq, endSeq, latest));
            },
            onPhaseProgress: ({ beginSeq, endSeq, latestSeq: latest, stage, done, total }) => {
                updateRuntimeInfoToastMessage(`${formatExtractionRangeToast(beginSeq, endSeq, latest)} · ${formatExtractionPhaseToast(stage, done, total)}`);
            },
            onBatchApplied: async ({ endSeq }) => {
                if (!hasCommittedBatch) {
                    const currentBatchEntries = getRollbackHistory(chatKey)
                        .filter(entry => Number(entry?.seqTo || 0) === Number(endSeq || 0));
                    trimRollbackHistoryFromSeq(chatKey, startSeq);
                    for (const entry of currentBatchEntries) {
                        recordRollbackEntry(chatKey, entry);
                    }
                    hasCommittedBatch = true;
                }
                await commitMemoryStoreReplaceByChatKey(
                    context,
                    chatKey,
                    workingStore,
                    endSeq,
                    { syncPersistentProjection: true, floor: seqToFloor(context, endSeq) },
                );
            },
            onCompressionApplied: async ({ batchEndSeq }) => {
                await commitMemoryStoreReplaceByChatKey(
                    context,
                    chatKey,
                    workingStore,
                    batchEndSeq,
                    { syncPersistentProjection: true, floor: seqToFloor(context, batchEndSeq) },
                );
            },
        });
        const debug = workingStore.lastExtractionDebug || {};
        if (!extracted && Number(debug.latestSeq || 0) >= startSeq && String(debug.reason || '') !== 'no_graph_changes') {
            throw new Error('Memory extraction returned no graph updates. Existing graph preserved.');
        }
        const finalSeq = Number(latestSeq || debug.latestSeq || 0);
        const persistResult = await commitMemoryStoreReplaceByChatKey(
            context,
            chatKey,
            workingStore,
            finalSeq,
            { syncPersistentProjection: true, floor: seqToFloor(context, finalSeq) },
        );
        const persistedStore = persistResult.store;
        const committedDebug = persistedStore?.lastExtractionDebug || debug;
        refreshUiStats();
        notifySuccess(i18nFormat('Memory graph rebuilt for recent ${0} assistant turn(s).', recentTurns));
        updateUiStatus(i18nFormat('Rebuilt recent memory graph range: seq ${0}-${1}.', startSeq, Number(committedDebug.latestSeq || latestSeq)));
    } catch (error) {
        if (isAbortError(error, rebuildAbortController.signal)) {
            updateUiStatus(i18n('Memory graph update cancelled by user.'));
            refreshUiStats();
            return;
        }
        console.warn(`[${MODULE_NAME}] Recent rebuild failed`, error);
        notifyError(i18nFormat('Recall injection failed (${0}): ${1}', 'rebuild_recent', String(error?.message || error)));
    } finally {
        if (activeExtractionAbortController === rebuildAbortController) {
            activeExtractionAbortController = null;
        }
        clearRuntimeInfoToast('extraction');
    }
}

/** Rebuilds the whole graph from the current chat. */
export async function runRebuildGraph(context, settings = getSettings()) {
    const runtimeSettings = getEffectiveSettings(context, settings);
    const rebuildLatestSeq = getExtractableLatestSeq(buildPlayableFramesFromContext(context).length, runtimeSettings);
    if (rebuildLatestSeq <= 0) {
        notifyError(i18n('No assistant turns available to rebuild.'));
        return;
    }
    const rebuildAbortController = new AbortController();
    activeExtractionAbortController = rebuildAbortController;
    showRuntimeInfoToast(formatExtractionRangeToast(1, Math.min(1, rebuildLatestSeq || 1), Math.max(1, rebuildLatestSeq)), {
        stopLabel: i18n('Stop'),
        onStop: () => {
            if (!rebuildAbortController.signal.aborted) {
                rebuildAbortController.abort();
            }
        },
    });
    try {
        const store = await rebuildStoreFromCurrentChat(context, {
            abortSignal: rebuildAbortController.signal,
            onBatchStart: ({ beginSeq, endSeq, latestSeq }) => {
                updateRuntimeInfoToastMessage(formatExtractionRangeToast(beginSeq, endSeq, latestSeq));
            },
            onPhaseProgress: ({ beginSeq, endSeq, latestSeq, stage, done, total }) => {
                updateRuntimeInfoToastMessage(`${formatExtractionRangeToast(beginSeq, endSeq, latestSeq)} · ${formatExtractionPhaseToast(stage, done, total)}`);
            },
        });
        if (!store) {
            notifyError(i18n('No active chat selected.'));
            return;
        }
        refreshUiStats();
        notifySuccess(i18n('Memory graph rebuilt from current chat.'));
        notifyEventCompressionIfAny(store?.lastExtractionDebug?.compression);
        updateUiStatus(i18n('Rebuilt memory graph and compression from chat.'));
    } catch (error) {
        if (isAbortError(error, rebuildAbortController.signal)) {
            updateUiStatus(i18n('Memory graph update cancelled by user.'));
            refreshUiStats();
            return;
        }
        console.warn(`[${MODULE_NAME}] Rebuild failed`, error);
        notifyError(i18nFormat('Recall injection failed (${0}): ${1}', 'rebuild', String(error?.message || error)));
    } finally {
        if (activeExtractionAbortController === rebuildAbortController) {
            activeExtractionAbortController = null;
        }
        clearRuntimeInfoToast('extraction');
    }
}

/** Runs recall for a test query without injecting anything. */
export async function runRecallDebug(context, query = '') {
    await ensureStoreSyncedWithChat(context);
    const store = getMemoryStore(context);
    if (!store) {
        notifyError(i18n('No active chat selected.'));
        return null;
    }
    const effectiveSettings = getEffectiveSettings(context, getSettings());
    const payload = {
        coreChat: buildRecallDebugCoreChat(context, query, effectiveSettings),
        forceWorldInfoResimulate: true,
    };

    const recallMethod = String(effectiveSettings.recallMethod || 'llm').trim().toLowerCase();
    let selectedNodes = [];
    let trace = [];

    if (recallMethod === 'rag' && !hasRecallableNodes(store)) {
        trace = [{ step: 'skip_rag_recall_no_nodes' }];
    } else if (recallMethod === 'rag') {
        const chatKey = getChatKey(context);
        const queryBundle = getRecallQueryBundle(payload, context, effectiveSettings);
        const queryText = normalizeText(queryBundle.fullText || '');

        let rewrittenQuery = null;
        if (effectiveSettings.ragUseQueryRewrite && String(effectiveSettings.ragRewriteApiPresetName || '').trim()) {
            rewrittenQuery = await runQueryRewrite(context, effectiveSettings, queryBundle, {
                abortSignal: null,
                recallRunToken: null,
            });
        }

        const useRerank = Boolean(effectiveSettings.ragUseRerank);
        const rerankProfile = useRerank ? getRerankProfileFromSettings(effectiveSettings) : null;
        const { perTypeK, defaultPerTypeK } = buildRagPerTypeQuotas(context, effectiveSettings);

        const ragResult = await runRagRecall(store, queryText, chatKey, effectiveSettings, {
            maxResults: Number(effectiveSettings.hybridMaxResults) || 15,
            vectorTopK: Number(effectiveSettings.vectorTopK) || 20,
            useRerank,
            rerankProfile,
            rewrittenQuery,
            perTypeK,
            defaultPerTypeK,
            signal: null,
        });

        const latestSeqIndex = getLatestSeqIndex(store);
        const excludeMessages = Math.max(0, Number(effectiveSettings.recentRawTurns ?? defaultSettings.recentRawTurns));

        selectedNodes = ragResult.candidates
            .map(c => store.nodes?.[c.nodeId])
            .filter(node => node && !node.archived)
            .filter(node => !isNodeInRecentExcludeWindow(node, latestSeqIndex, excludeMessages))
            .sort(compareNodesByTimeline);

        trace = [{
            step: 'rag_recall',
            method: 'rag',
            meta: ragResult.meta,
            selected_ids: selectedNodes.map(n => n.id),
        }];
    } else {
        const result = await runLLMDrivenRecall(context, store, payload);
        selectedNodes = result.selectedNodes;
        trace = result.trace;
    }

    store.lastRecallTrace = trace;
    updateUiStatus(i18nFormat('Recall ready. selected=${0}', selectedNodes.length));
    refreshUiStats();
    return { selectedNodes, trace };
}

/** Extracts every assistant turn the graph has not covered yet. */
export async function runFillGraph(context, settings = getSettings()) {
    await ensureStoreSyncedWithChat(context);
    const chatKey = getChatKey(context);
    const store = memoryStoreCache.get(chatKey);
    if (!store) {
        notifyError(i18n('No active chat selected.'));
        return;
    }
    const runtimeSettings = getEffectiveSettings(context, settings);
    alignStoreCoverageToChat(store, context, runtimeSettings);
    const fillAbortController = new AbortController();
    activeExtractionAbortController = fillAbortController;
    try {
        const preview = computeExtractionWindow(context, store, null, runtimeSettings);
        if (preview.beginSeq > preview.latestSeq) {
            notifySuccess(i18n('Memory graph is already up to date.'));
            updateUiStatus(i18n('Memory graph is already up to date.'));
            refreshUiStats();
            return;
        }
        const extractBatchTurns = Math.max(
            1,
            Math.floor(Number(runtimeSettings?.extractBatchTurns || defaultSettings.extractBatchTurns || 1)),
        );
        const initialEndSeq = Math.min(
            Number(preview.latestSeq || 0),
            Number(preview.beginSeq || 1) + extractBatchTurns - 1,
        );
        showRuntimeInfoToast(formatExtractionRangeToast(preview.beginSeq, initialEndSeq, preview.latestSeq), {
            stopLabel: i18n('Stop'),
            onStop: () => {
                if (!fillAbortController.signal.aborted) {
                    fillAbortController.abort();
                }
            },
        });
        const workingStore = normalizeStoreForRuntime(store);
        let committedStore = normalizeStoreForRuntime(store);
        await runExtractionForStore(context, workingStore, {
            force: true,
            abortSignal: fillAbortController.signal,
            onBatchStart: ({ beginSeq, endSeq, latestSeq }) => {
                updateRuntimeInfoToastMessage(formatExtractionRangeToast(beginSeq, endSeq, latestSeq));
            },
            onPhaseProgress: ({ beginSeq, endSeq, latestSeq, stage, done, total }) => {
                updateRuntimeInfoToastMessage(`${formatExtractionRangeToast(beginSeq, endSeq, latestSeq)} · ${formatExtractionPhaseToast(stage, done, total)}`);
            },
            onBatchApplied: async ({ endSeq }) => {
                const batchResult = await commitMemoryStoreDiffByChatKey(
                    context,
                    chatKey,
                    committedStore,
                    workingStore,
                    endSeq,
                    { syncPersistentProjection: true, floor: seqToFloor(context, endSeq) },
                );
                committedStore = batchResult.store;
            },
            onCompressionApplied: async ({ beforeStore, batchEndSeq }) => {
                const compactionResult = await commitMemoryStoreDiffByChatKey(
                    context,
                    chatKey,
                    beforeStore,
                    workingStore,
                    batchEndSeq,
                    { syncPersistentProjection: true, floor: seqToFloor(context, batchEndSeq) },
                );
                committedStore = compactionResult.store;
            },
        });
        const finalSeq = Number(preview.latestSeq || workingStore?.lastExtractionDebug?.latestSeq || 0);
        const finalResult = await commitMemoryStoreDiffByChatKey(
            context,
            chatKey,
            committedStore,
            workingStore,
            finalSeq,
            { syncPersistentProjection: true, floor: seqToFloor(context, finalSeq) },
        );
        const finalStore = finalResult.store;
        const debug = finalStore?.lastExtractionDebug || workingStore.lastExtractionDebug || {};
        updateUiStatus(i18nFormat(
            'Extraction ${0}: begin=${1} latest=${2} covered=${3}',
            debug.extracted ? 'ok' : 'skip',
            Number(debug.beginSeq || 0),
            Number(debug.latestSeq || 0),
            Number(debug.coveredSeqTo || 0),
        ));
        refreshUiStats();
        notifySuccess(i18n('Memory graph incremental fill completed.'));
    } catch (error) {
        if (isAbortError(error, fillAbortController.signal)) {
            updateUiStatus(i18n('Memory graph update cancelled by user.'));
            refreshUiStats();
            return;
        }
        console.warn(`[${MODULE_NAME}] Incremental fill failed`, error);
        notifyError(i18nFormat('Recall injection failed (${0}): ${1}', 'fill', String(error?.message || error)));
    } finally {
        if (activeExtractionAbortController === fillAbortController) {
            activeExtractionAbortController = null;
        }
        clearRuntimeInfoToast('extraction');
    }
}

/** Opens the configuration workbench. */
export async function openMemoryConfigStudio(context, settings = getSettings()) {
    await openConfigIterationStudio({
        context,
        settings,
        normalizeNodeTypeSchema,
        getEffectiveNodeTypeSchema,
        getEffectiveSettings,
        getSchemaScopeInfo,
        getDefaultNodeTypeSchema,
        persistCharacterSchemaOverride,
        persistCharacterAdvancedOverridePatch,
        syncGenerationVisibleHistoryRuntimeRegexScripts,
        saveSettings,
        i18n,
        i18nFormat,
        refreshRootUi: () => {
            invalidateLatestRecallSnapshot();
            try { syncGenerationVisibleHistoryRuntimeRegexScripts(); } catch { /* host refresh errors surface elsewhere */ }
        },
    });
}

/** Runs manual compression with already-collected options. */
export async function runManualCompression(context, settings, values) {
    await ensureMemoryStoreLoaded(context);
    const store = getMemoryStore(context);
    if (!store) {
        notifyError(i18n('No active chat selected.'));
        return;
    }
    if (!Array.isArray(values.selectedTypeIds) || values.selectedTypeIds.length === 0) {
        notifyError(i18n('Select at least one type to compress.'));
        return;
    }

    let maxSeq = null;
    if (values.scope === 'older') {
        const latestSeq = Math.max(0, Number(buildPlayableFramesFromContext(context).length || 0));
        maxSeq = Math.max(0, latestSeq - Math.max(0, values.excludeRecent));
        if (maxSeq <= 0) {
            notifyError(i18n('No nodes are eligible for the selected scope.'));
            return;
        }
    }

    const beforeNodes = Object.values(store.nodes || {});
    const beforeNodeCount = beforeNodes.length;
    const beforeArchivedCount = beforeNodes.filter(node => Boolean(node?.archived)).length;
    const beforeStore = normalizeStoreForRuntime(store);
    const compressionStats = createCompressionStats();
    const compressionAbortController = new AbortController();
    activeExtractionAbortController = compressionAbortController;
    showRuntimeInfoToast(i18n('Memory graph update running...'), {
        stopLabel: i18n('Stop'),
        onStop: () => {
            if (!compressionAbortController.signal.aborted) {
                compressionAbortController.abort();
            }
        },
    });
    try {
        // Manual compression collapses into a single tail commit after all
        // rounds finish. Per-round commits would form a non-monotonic anchor
        // sequence (each round's roundSeqTo can jump backwards across types),
        // and floor-state's incremental patch model can't replay such a log
        // after truncation. The covered seq advances by the highest roundSeqTo
        // observed, which yields the same anchor as the legacy "one commit at
        // tail" shape.
        let highestRoundSeqTo = getStoreCoveredSeqTo(store);
        const changed = await runCompressionLoop(context, store, settings, {
            typeIds: values.selectedTypeIds,
            force: values.mode === 'force' || values.mode === 'flat',
            flatten: values.mode === 'flat',
            maxRoundsPerType: values.maxRoundsPerType,
            maxSeq,
            compressionStats,
            abortSignal: compressionAbortController.signal,
            onRoundApplied: ({ roundSeqTo }) => {
                const candidate = Number(roundSeqTo || 0);
                if (Number.isFinite(candidate) && candidate > highestRoundSeqTo) {
                    highestRoundSeqTo = candidate;
                }
            },
        });
        if (!changed) {
            notifySuccess(i18n('Manual compression made no changes.'));
            return;
        }
        await commitMemoryStoreDiffByChatKey(
            context,
            getChatKey(context),
            beforeStore,
            store,
            highestRoundSeqTo,
            { syncPersistentProjection: true, floor: seqToFloor(context, highestRoundSeqTo) },
        );
        const afterNodes = Object.values(store.nodes || {});
        const afterNodeCount = afterNodes.length;
        const afterArchivedCount = afterNodes.filter(node => Boolean(node?.archived)).length;
        const createdDelta = Math.max(0, afterNodeCount - beforeNodeCount);
        const archivedDelta = Math.max(0, afterArchivedCount - beforeArchivedCount);
        refreshUiStats();
        const summary = i18nFormat('Manual compression completed. Created=${0}, archived=${1}', createdDelta, archivedDelta);
        notifySuccess(summary);
        notifyEventCompressionIfAny(compressionStats);
        updateUiStatus(summary);
    } catch (error) {
        if (isAbortError(error, compressionAbortController.signal)) {
            updateUiStatus(i18n('Memory graph update cancelled by user.'));
            return;
        }
        console.warn(`[${MODULE_NAME}] Manual compression failed`, error);
        notifyError(i18nFormat('Recall injection failed (${0}): ${1}', 'compress', String(error?.message || error)));
    } finally {
        if (activeExtractionAbortController === compressionAbortController) {
            activeExtractionAbortController = null;
        }
        clearRuntimeInfoToast('extraction');
    }
}

export function getRawGraphJson(context) {
    const store = getMemoryStore(context);
    return store ? JSON.stringify(store, null, 2) : '';
}

/** Replaces the current chat's graph with edited JSON. Throws on invalid JSON. */
export async function applyRawGraphJson(context, raw, base) {
    const chatKey = getChatKey(context);
    function validate() {
        if (base && (base.chatKey !== getChatKey(getContext()) || getRawGraphJson(context) !== base.text)) {
            throw new Error(i18n('The memory graph changed. Reopen the editor before applying changes.'));
        }
    }
    validate();
    const parsed = JSON.parse(raw);
    const migrated = normalizeStoreForRuntime(parsed);
    updateStoreSourceState(migrated, context);
    const migratedSeq = getStoreCoveredSeqTo(migrated);
    const applyResult = await commitMemoryStoreReplaceByChatKey(
        context,
        chatKey,
        migrated,
        migratedSeq,
        { floor: seqToFloor(context, migratedSeq), validate },
    );
    if (applyResult && applyResult.skipped) {
        notifyError(i18nFormat('Failed to apply graph JSON: ${0}', applyResult.hint || applyResult.reason || i18n('reason unknown')));
        return false;
    }
    clearRollbackHistory(chatKey);
    await persistMemoryStoreByChatKey(context, chatKey, migrated, { syncPersistentProjection: true });
    refreshUiStats();
    try { await syncGraphVectorsAfterMutation(context, chatKey, migrated); } catch (err) {
        notifyError(i18nFormat('Vector recompute failed: ${0}', err?.message || err));
    }
    emitStoreCommit(chatKey);
    updateUiStatus(i18n('Applied raw graph JSON edit.'));
    notifySuccess(i18n('Memory graph JSON updated.'));
    return true;
}


/**
 * Refresh the in-memory runtime store cache for `chatKey` from the
 * floor-state graph payload + the __meta sidecar. Awaits fs.ready()
 * so any in-flight write (a concurrent fs.patch from extraction) has
 * landed before we read.
 */
async function refreshMemoryStoreCacheFromFloorState(runtimeContext, chatKey) {
    if (!chatKey || chatKey === 'invalid_target') return null;
    const target = memoryStoreTargets.get(chatKey);
    // fs.get() owns migration + replay-failure recovery. It returns an
    // envelope: hard failures (REPLAY_BROKEN, INSTANCE_DESTROYED) surface
    // to the user; transient soft failures keep the cache as-is rather
    // than overwriting with an empty store (which would visually erase
    // the user's data).
    let payload;
    let logSize = 0;
    let recoveryJustHappened = false;
    try {
        const fs = await getFloorStateInstance(runtimeContext);
        await fs.ready();
        const getResult = await fs.get();
        if (!getResult.ok) {
            console.error(`[${MODULE_NAME}] floor-state get failed during cache refresh (reason=${getResult.reason}, hint=${getResult.hint})`);
            notifyError(i18nFormat('Memory graph load failed: ${0}', getResult.hint || getResult.reason || i18n('reason unknown')));
            return memoryStoreCache.get(chatKey) || null;
        }
        payload = getResult.state;
        // Floor-state sets `recovered: true` on the envelope exactly for the
        // one call that drove `recoverByTruncatingBrokenFloor` — replay found
        // a corrupted commit, backed the full log up to `<ns>__orphans`, and
        // truncated the broken floor. Later refreshes hit fs.get()'s cache
        // and never see this flag again, so the user notification below fires
        // exactly once per real data-loss event instead of every time the
        // leftover `<ns>__orphans` sidecar is observed on disk.
        recoveryJustHappened = getResult.recovered === true;
        // Look up the on-disk log size so we can distinguish "graph
        // genuinely empty" from "replay projected empty against a
        // transient chat state" (e.g. chat array still loading, or all
        // commits skipped by the swipeMap projection). The latter must
        // NOT overwrite the cache with an empty store — the next
        // replaceGraphLogForTarget would see an empty in-memory graph
        // and fs.reset([]) the log entirely.
        if (typeof fs.getLogSize === 'function') {
            logSize = await fs.getLogSize();
        }
    } catch (error) {
        console.error(`[${MODULE_NAME}] floor-state get threw during cache refresh`, error);
        notifyError(i18nFormat('Memory graph load failed: ${0}', error?.message || error));
        return memoryStoreCache.get(chatKey) || null;
    }
    // Guard: log has commits on disk but replay produced an empty
    // payload. This is the "chat state can't project the log" case; the
    // graph is not really empty. Preserve the existing cache and warn
    // the user, so they don't Rebuild/Import over a live graph they
    // still hold.
    const payloadHasNoNodes = !payload || !payload.nodes || Object.keys(payload.nodes).length === 0;
    if (logSize > 0 && payloadHasNoNodes) {
        console.warn(`[${MODULE_NAME}] cache refresh: log has ${logSize} commits but replay is empty — preserving old cache to avoid wipe on next write`);
        notifyError(i18nFormat(
            'Memory graph replay projected empty against ${0} log commit(s) — chat likely still loading. Kept the previous graph in memory. Do NOT trigger Rebuild / Import / Vector recompute until the chat is fully loaded, or the graph may be wiped.',
            logSize,
        ));
        return memoryStoreCache.get(chatKey) || null;
    }
    let meta = null;
    if (target) {
        try {
            meta = await loadMetaFields(runtimeContext, target);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] meta sidecar read failed during cache refresh`, error);
        }
    }
    if (meta) setCachedMeta(chatKey, meta);
    const runtimeStore = buildRuntimeStoreFromGraphPayloadAndMeta(payload, meta || getCachedMeta(chatKey));
    memoryStoreCache.set(chatKey, runtimeStore);
    // One-shot post-recovery notice: floor-state just discarded a broken
    // commit + everything on/after its floor, backing the full pre-truncate
    // log up to `<ns>__orphans`. Users on that chat lost the nodes covered
    // by the truncated commits. Tell them once (this branch only runs on
    // the call that triggered the recovery — later refreshes never re-fire).
    if (recoveryJustHappened) {
        notifyError(i18n('Memory graph had a corrupted entry. The affected data was moved to an __orphans backup. It can be found alongside the chat data.'));
    }
    return runtimeStore;
}

/**
 * Coalesce structural-event reactions:
 *  - cancel any in-flight extraction
 *  - wait for floor-state to finish its truncate / swipe-delete settle
 *  - rebuild the in-memory runtime store from the replayed fs payload
 *  - clear stale recall trace + sourceMessageCount, persist to __meta
 *  - re-sync the persistent + runtime lorebook projections
 *  - optionally schedule a fresh extraction replay
 *
 * Floor-state owns the graph payload's response to MESSAGE_DELETED /
 * MESSAGE_SWIPED / MESSAGE_SWIPE_DELETED. Memory-graph's job here is only
 * to flush its read-side caches and reset its non-floor metadata.
 *
 * Floor-state has already settled by the time this runs (core invokes
 * `settleMessageDeleted/Swiped/SwipeDeleted` before the corresponding
 * `eventSource.emit`), so `refreshMemoryStoreCacheFromFloorState` replays
 * the post-truncate / post-swipe log.
 */
async function applyMutationInvalidationImpl(fromSeq = null, { scheduleReplay = false, kind = 'delete' } = {}) {
    const liveContext = getContext();
    const chatKey = getChatKey(liveContext);
    if (!chatKey || chatKey === 'invalid_target') {
        latestRecallSnapshot = null;
        return;
    }
    const normalizedFromSeq = Number.isFinite(Number(fromSeq)) && Number(fromSeq) > 0
        ? Math.max(1, Math.floor(Number(fromSeq)))
        : null;
    const isCurrentChat = getChatKey(liveContext) === chatKey;
    const preserveLatestRecallSnapshot = shouldPreserveLatestRecallSnapshotForAssistantMutation(liveContext, normalizedFromSeq);
    if (!preserveLatestRecallSnapshot) {
        latestRecallSnapshot = null;
    }
    // The scheduled-extraction debounce timer holds a pass that hasn't
    // started yet; it's targeting the pre-mutation chat shape, drop it.
    // The rerun branch at the end re-arms one if this mutation warrants
    // fresh work.
    if (extractionTimers.has(chatKey)) {
        clearTimeout(extractionTimers.get(chatKey));
        extractionTimers.delete(chatKey);
    }
    // Classify how the mutation intersects the in-flight scheduled
    // pass. Fill / rebuild / rebuild_recent / compression passes leave
    // activeExtractionScope null; those get the conservative abort path.
    //
    //   noop:                fromSeq > scope.latestSeq — pass hasn't
    //                        reached the affected region, let it run.
    //   shrink:              the mutation lands in a tail batch that has
    //                        not been dispatched yet; lower latestSeq so
    //                        the loop winds down at fromSeq - 1 on its
    //                        next batch check.
    //   abort_in_flight_batch:
    //                        fromSeq sits inside the batch currently being
    //                        processed. Its prompt was built from the
    //                        launch-time frames snapshot, so the stale
    //                        batch cannot be salvaged by lowering the
    //                        bound — abort and let the post-regeneration
    //                        schedule re-extract the new content.
    //   abort_committed_hit: fromSeq <= committed — already-committed
    //                        work covers the affected region; abort and
    //                        let the store refresh below re-materialize
    //                        from the (core-settled) floor-state log.
    //   abort_no_metadata:   no scope or no fromSeq; conservative abort
    //                        preserves the pre-refactor behaviour.
    if (activeExtractionAbortController && !activeExtractionAbortController.signal.aborted) {
        const scope = activeExtractionScope;
        const decision = classifyExtractionMutation(scope, normalizedFromSeq);
        if (decision === 'abort_no_metadata'
            || decision === 'abort_committed_hit'
            || decision === 'abort_in_flight_batch') {
            if (isCurrentChat) {
                clearRuntimeInfoToast('extraction');
            }
            activeExtractionAbortController.abort();
        } else if (decision === 'shrink' && scope) {
            scope.latestSeq = normalizedFromSeq - 1;
            // Keep the toast — the pass is winding down, not being killed.
        }
        // decision === 'noop' → leave the pass entirely alone.
    }
    let store = null;
    try {
        store = await refreshMemoryStoreCacheFromFloorState(liveContext, chatKey);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to refresh memory store cache after mutation`, error);
    }
    if (!store) {
        store = memoryStoreCache.get(chatKey) || null;
    }
    if (store) {
        updateStoreSourceState(store, liveContext);
        store.lastRecallTrace = [];
        store.lastRecallProjection = null;
        try {
            await persistMetaForChatKey(liveContext, chatKey, store);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to persist meta after mutation for ${chatKey}`, error);
        }
        if (isCurrentChat) {
            const effectiveSettings = getEffectiveSettings(liveContext, getSettings());
            try {
                if (!effectiveSettings.enabled) {
                    await clearAllMemoryLorebookProjection(liveContext, effectiveSettings);
                } else {
                    await clearRuntimeLorebookProjection(liveContext, effectiveSettings);
                    await syncPersistentLorebookProjection(liveContext, effectiveSettings, store);
                }
            } catch (error) {
                console.warn(`[${MODULE_NAME}] Lorebook projection sync failed after mutation`, error);
            }
        }
    }
    refreshUiStats();
    // Only 'refresh' kinds (swipe / continue / append / appendfinal)
    // create new content that must be re-extracted; 'delete' just trims
    // and produces nothing new.
    //
    // No generationInProgress gate: MESSAGE_RECEIVED / MESSAGE_SWIPED
    // fire after the message body is persisted, so a fresh pass reading
    // the live chat sees the new content immediately. Gating on
    // generationInProgress here would defer refresh reruns to
    // GENERATION_ENDED's abortedByUser path, which returns early and
    // drops the rerun whenever streamingProcessor's abort signal is
    // dirty from a prior turn.
    if (scheduleReplay && isCurrentChat && kind === 'refresh') {
        scheduleExtraction(getContext());
    }
}

/**
 * Public wrapper around `applyMutationInvalidationImpl`. Serializes
 * concurrent invocations through a Promise chain rooted at
 * `pendingMutationInvalidation`, and publishes the in-flight task so
 * the WI-scan listeners can gate on it.
 */
function applyMutationInvalidation(fromSeq = null, opts = {}) {
    const previous = pendingMutationInvalidation;
    const task = previous
        .catch(() => {})
        .then(() => applyMutationInvalidationImpl(fromSeq, opts));
    pendingMutationInvalidation = task;
    return task;
}

// Floor-state has already settled (driven by core via settleXxx) before
// MESSAGE_DELETED / MESSAGE_SWIPED / MESSAGE_SWIPE_DELETED listeners run.
// Our work here is the non-graph state: cache invalidation, lorebook
// re-projection, extraction restart. The chain
// (refreshMemoryStoreCacheFromFloorState → persistMetaForChatKey →
// sync*LorebookProjection) fans out several server fetches and on a
// medium store can take 5+ seconds; on a slow fetch it can hang longer.
// `eventSource.emit` awaits every listener in sequence, so awaiting that
// chain inline would block the emit loop and freeze every other listener
// (var-ops rebuild, card-app refresh, UI), as well as any caller that
// awaits emit itself (`deleteMessage` ends with
// `await eventSource.emit(MESSAGE_DELETED, ...)`).
//
// Detach instead: schedule `applyMutationInvalidation` on a microtask so
// the MESSAGE_DELETED listener resolves synchronously, the emit loop
// returns immediately, and the heavy chain runs in the background.
// Readers that depend on a settled post-mutation state still gate on
// `pendingMutationInvalidation` — see `_handleWiBeforeScan` below.
//
// `kind` distinguishes the two shapes of mutation:
//   'delete':  fromSeq and everything after it disappeared. Nothing new
//              to extract; only need to trim / abort in-flight work.
//   'refresh': fromSeq's content changed in place (swipe / continue /
//              append / appendfinal). That seq needs to be re-extracted
//              against the new text, so we also flag a rerun.
function scheduleMutationInvalidation(fromSeq, kind = 'delete') {
    queueMicrotask(() => {
        applyMutationInvalidation(fromSeq, { scheduleReplay: true, kind })
            .catch(error => {
                console.error(`[${MODULE_NAME}] applyMutationInvalidation failed`, error);
            });
    });
}

// Quiet / dry-run generations must NEVER reach the recall machinery.
//
// PromptManager.scheduleDeferredTryGenerate (public/scripts/PromptManager.js)
// fires a debounced `Generate('normal', {}, true)` (dryRun=true) on every
// re-render — and MESSAGE_DELETED forces a re-render. If we let the
// dry-run reach safeInjectMemoryPrompts, it would (1) abort the live
// `activeRecallAbortController` from a real in-flight Generate and (2)
// bump `activeRecallRunToken`, which makes the real recall throw
// AbortError → surfaces as "Memory recall cancelled by user." in the
// status bar even though the user never clicked Stop. Both side effects
// happen BEFORE the dry-run check inside injectMemoryPrompts (which
// returns false too late at line 8115).
//
// Quiet generations don't send a prompt either, so they should bail for
// the same reason.
function isRecallEligiblePayload(payload) {
    if (payload?.dryRun === true) return false;
    const generationType = String(payload?.type || '').trim().toLowerCase();
    if (generationType === 'quiet') return false;
    return true;
}

/**
 * Drain any in-flight mutation invalidation and re-sync the persistent
 * lorebook projection (corePacket / event summaries). Called on
 * GENERATION_BEFORE_WORLD_INFO_SCAN — which core `await`s — so by the
 * time runWIScan() captures lorebook entries they are fresh.
 *
 * The lorebook clear in applyMutationInvalidation may run after a
 * MESSAGE_DELETED but BEFORE this Generate's WI scan; the extra
 * syncPersistentLorebookProjection call here is idempotent (the
 * managed-entry diff at upsertManagedLorebookProjection returns
 * changed=false when nothing actually differs) and protects against the
 * "cleared on disk but WI scan snapshotted the stale entries" race.
 */
async function drainAndSyncPersistentForCurrentChat() {
    await pendingMutationInvalidation.catch(() => {});
    if (__testPersistentDrainHook) {
        await __testPersistentDrainHook();
        return;
    }
    const ctx = getContext();
    const settings = getEffectiveSettings(ctx, getSettings());
    if (!settings.enabled) {
        try {
            await clearAllMemoryLorebookProjection(ctx, settings);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to clear lorebook projections before WI scan`, error);
        }
        return;
    }
    // Recall focus is a per-generation artifact. Clear it before the scan so
    // a missed or still-running GENERATION_ENDED cleanup can never leak the
    // previous turn's recall candidates into this prompt. Persistent
    // injection is a separate managed entry and stays untouched.
    await clearRuntimeLorebookProjection(ctx, settings);
    const store = await ensureStoreSyncedWithChat(ctx);
    if (!store) return;
    try {
        await syncPersistentLorebookProjection(ctx, settings, store);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Persistent lorebook sync failed before WI scan`, error);
    }
}

/**
 * GENERATION_BEFORE_WORLD_INFO_SCAN handler. Bails on dry-run / quiet
 * payloads; otherwise drains the mutation-invalidation chain and refreshes
 * the persistent lorebook projection so the WI scan sees a current
 * snapshot.
 */
async function _handleWiBeforeScan(payload) {
    if (!isRecallEligiblePayload(payload)) return;
    await drainAndSyncPersistentForCurrentChat();
}

/**
 * GENERATION_AFTER_WORLD_INFO_SCAN handler. Bails on dry-run / quiet
 * payloads (see isRecallEligiblePayload). Otherwise runs recall via
 * safeInjectMemoryPrompts and propagates `__lukerRpgMemoryNeedRescan`
 * to `payload.requestRescan` so core re-runs runWIScan when the
 * focusPacket changed.
 *
 * The persistent-lorebook drain already happened in the BEFORE handler;
 * we still await `pendingMutationInvalidation` here as a cheap safety
 * net in case a fresh mutation was scheduled between BEFORE and AFTER.
 */
async function _handleWiAfterScan(payload) {
    if (!isRecallEligiblePayload(payload)) return;
    await pendingMutationInvalidation.catch(() => {});
    const inject = __testSafeInjectMemoryPromptsHook || safeInjectMemoryPrompts;
    await inject(getContext(), payload, 'after_world_info_scan');
    if (payload?.signal?.aborted) {
        if (payload && typeof payload === 'object') {
            payload.__lukerRpgMemoryNeedRescan = false;
            payload.requestRescan = false;
        }
        return;
    }
    if (payload && typeof payload === 'object' && payload.__lukerRpgMemoryNeedRescan) {
        payload.requestRescan = true;
    }
}

// ---- Test-only exports --------------------------------------------------
// Mirror the `_*ForTest` convention used elsewhere in this module
// (`_createNodeForTest`, etc.). Production code never touches these.
export { _handleWiBeforeScan as _handleWiBeforeScanForTest };
export { _handleWiAfterScan as _handleWiAfterScanForTest };
export function _getRecallRuntimeStateForTest() {
    return {
        activeRecallRunToken,
        activeRecallAbortController,
        pendingMutationInvalidation,
    };
}
export function _getLatestRecallSnapshotForTest() {
    return latestRecallSnapshot
        ? structuredClone(latestRecallSnapshot)
        : null;
}
export function _resetRecallRuntimeStateForTest(seed = {}) {
    activeRecallRunToken = Number.isFinite(Number(seed.activeRecallRunToken))
        ? Number(seed.activeRecallRunToken)
        : 0;
    activeRecallAbortController = Object.prototype.hasOwnProperty.call(seed, 'activeRecallAbortController')
        ? seed.activeRecallAbortController
        : null;
    pendingMutationInvalidation = seed.pendingMutationInvalidation instanceof Promise
        ? seed.pendingMutationInvalidation
        : Promise.resolve();
}
export function _setSafeInjectMemoryPromptsHookForTest(hook) {
    __testSafeInjectMemoryPromptsHook = (typeof hook === 'function') ? hook : null;
}
export function _setPersistentDrainHookForTest(hook) {
    __testPersistentDrainHook = (typeof hook === 'function') ? hook : null;
}
export { buildRoleSplitChatMessages as _buildRoleSplitChatMessagesForTest };

jQuery(() => {
    const context = getContext();
    registerLocaleData();
    import('./lens/index.js')
        .then(({ initMemoryLens }) => initMemoryLens())
        .catch(err => console.error(`[${MODULE_NAME}] Failed to start Memory Lens`, err));
    ensureSettings();
    configureCharacterOverrides({
        MODULE_NAME,
        defaultSettings,
        normalizeNodeTypeSchema,
        normalizeAdvancedSettings,
        getSettings,
    });
    registerMemoryGraphCardBindingSlot(getContext());
    generationVisibleHistoryRegexProvider = registerManagedRegexProvider(GENERATION_VISIBLE_HISTORY_REGEX_PROVIDER_ID);
    syncGenerationVisibleHistoryRuntimeRegexScripts();
    saveSettingsDebounced();
    void ensureMemoryStoreLoaded(context).catch(() => {});
    void syncPersistentProjectionForCurrentChat();
    // memory-graph publishes its 15 read/write tools into the
    // orchestrator's Layer-2 registry so any of the four orchestration
    // modes can dispatch them. Fire-and-forget — when the orchestrator
    // extension isn't loaded the call is a silent no-op.
    void registerMemoryGraphOrchestrationTools();

    // ORDER MATTERS for the migration path. Floor-state's log is the only
    // persisted source of truth; if a legacy chat (v8 opLog inside the main
    // namespace) reaches `fs.get()` before our schema migration has hoisted
    // the opLog into the log namespace, replay sees an empty log and recall
    // observes a wiped store until the next write rebuilds.
    //
    // We therefore: (a) subscribe memory-graph's CHAT_CHANGED handler BEFORE
    // mounting floor-state — its `migrateLegacyMemoryGraphState` call runs
    // early on every chat switch; (b) run an explicit migration for the
    // initial chat before mounting the singleton.
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, async () => {
        latestRecallSnapshot = null;
        void ensureMemoryStoreLoaded(getContext()).catch(() => {});
        const runtimeContext = getContext();
        const newTarget = buildMemoryTargetFromContext(runtimeContext);
        const newChatKey = getChatKey(runtimeContext);
        if (newTarget && newChatKey && newChatKey !== 'invalid_target') {
            memoryStoreTargets.set(newChatKey, newTarget);
            try {
                await migrateLegacyMemoryGraphState(
                    runtimeContext,
                    newTarget,
                    isExtractableAssistantMessage,
                    applyMemoryLogEntryToStore,
                );
            } catch (error) {
                console.warn(`[${MODULE_NAME}] Schema migration failed on CHAT_CHANGED`, { target: newTarget, error });
            }
        }
    });

    // Mount the floor-state singleton AFTER subscribing the migration
    // handler. The initial migration writes the log for the current chat,
    // so the singleton's first `fs.get()` replays against the migrated log.
    // From this point onward, our CHAT_CHANGED handler runs after core's
    // settleChatChanged on every switch, and is followed by the cache-refresh
    // handler below.
    void (async () => {
        const initialChatKey = getChatKey(context);
        if (initialChatKey && initialChatKey !== 'invalid_target') {
            const initialTarget = buildMemoryTargetFromContext(context);
            if (initialTarget) {
                memoryStoreTargets.set(initialChatKey, initialTarget);
                try {
                    await migrateLegacyMemoryGraphState(
                        context,
                        initialTarget,
                        isExtractableAssistantMessage,
                        applyMemoryLogEntryToStore,
                    );
                } catch (error) {
                    console.warn(`[${MODULE_NAME}] Initial schema migration failed`, { target: initialTarget, error });
                }
            }
        }
        try {
            await getFloorStateInstance(context);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to mount floor-state singleton`, error);
        }
    })();

    const wiBeforeEvent = context.eventTypes.GENERATION_BEFORE_WORLD_INFO_SCAN;
    if (wiBeforeEvent) {
        context.eventSource.on(wiBeforeEvent, _handleWiBeforeScan);
    }
    const wiAfterEvent = context.eventTypes.GENERATION_AFTER_WORLD_INFO_SCAN;
    if (wiAfterEvent) {
        context.eventSource.on(wiAfterEvent, _handleWiAfterScan);
    }
    const clearRuntimeProjectionAfterGeneration = async () => {
        const runtimeContext = getContext();
        try {
            await clearRuntimeLorebookProjection(runtimeContext, getSettings());
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to clear runtime lorebook projection after generation`, error);
        }
    };
    if (context.eventTypes.GENERATION_ENDED) {
        context.eventSource.on(context.eventTypes.GENERATION_ENDED, async () => {
            await clearRuntimeProjectionAfterGeneration();
            clearRuntimeInfoToast('recall');
            const runtimeContext = getContext();
            const abortedByUser = Boolean(runtimeContext?.streamingProcessor?.abortController?.signal?.aborted);
            if (abortedByUser) {
                updateUiStatus(i18n('Generation aborted. Skipped memory extraction.'));
                return;
            }
            await captureLatestAssistantAfterGeneration();
        });
    }
    if (context.eventTypes.CHAT_BRANCH_CREATED) {
        context.eventSource.on(context.eventTypes.CHAT_BRANCH_CREATED, async (payload) => {
            try {
                await inheritMemoryStoreForBranch(getContext(), payload);
            } catch (error) {
                console.warn(`[${MODULE_NAME}] Failed to inherit memory graph for branch`, error);
            }
        });
    }
    // MESSAGE_DELETED / MESSAGE_SWIPED / MESSAGE_RECEIVED kick the
    // module-level `scheduleMutationInvalidation` (defined above the
    // jQuery init) which queues `applyMutationInvalidation` on a
    // microtask. The detached chain keeps `eventSource.emit` non-blocking;
    // readers that need a settled post-mutation state await
    // `pendingMutationInvalidation` — see `_handleWiBeforeScan`.
    context.eventSource.on(context.eventTypes.MESSAGE_DELETED, (_messageCount, mutationMeta) => {
        const runtimeContext = getContext();
        const assistantFromSeq = Number(mutationMeta?.deletedAssistantSeqFrom || 0);
        const playableFromSeq = Number(mutationMeta?.deletedPlayableSeqFrom || 0);
        const fromSeq = Number.isFinite(assistantFromSeq) && assistantFromSeq > 0
            ? assistantFromSeq
            : findAssistantSeqFromPlayableSeq(runtimeContext, playableFromSeq);
        scheduleMutationInvalidation(fromSeq, 'delete');
    });
    if (context.eventTypes.MESSAGE_SWIPED) {
        context.eventSource.on(context.eventTypes.MESSAGE_SWIPED, (messageId, _meta) => {
            // chat[0] is first_mes; its swipe deck IS the character card's
            // alternate_greetings array, so a swipe here only swaps opening
            // greetings — not new conversation content. Mirrors the
            // type='first_message' filter in the MESSAGE_RECEIVED branch below.
            if (Number(messageId) === 0) return;
            const fromSeq = findAffectedAssistantSeqFromMessageIndex(getContext(), messageId);
            scheduleMutationInvalidation(fromSeq, 'refresh');
        });
    }
    if (context.eventTypes.MESSAGE_RECEIVED) {
        context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, (messageId, generationType) => {
            const normalizedType = String(generationType || '').trim().toLowerCase();
            if (!['swipe', 'continue', 'append', 'appendfinal'].includes(normalizedType)) {
                return;
            }
            const fromSeq = findAffectedAssistantSeqFromMessageIndex(getContext(), messageId);
            scheduleMutationInvalidation(fromSeq, 'refresh');
        });
    }
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, async () => {
        // The pre-fs-mount CHAT_CHANGED handler at the top of jQuery init
        // already runs migration; this listener fires after both that one
        // and core's settleChatChanged (which drives floor-state
        // instances), so by now fs.get() reflects the new chat. Our job
        // here is to refresh the runtime store cache and trigger UI
        // updates.
        const runtimeContext = getContext();
        const newChatKey = getChatKey(runtimeContext);
        if (newChatKey && newChatKey !== 'invalid_target') {
            try {
                await refreshMemoryStoreCacheFromFloorState(runtimeContext, newChatKey);
            } catch (error) {
                console.warn(`[${MODULE_NAME}] Failed to refresh memory store cache on CHAT_CHANGED`, error);
            }
            refreshUiStats();
        }
        void syncPersistentProjectionForCurrentChat();
    });
});
