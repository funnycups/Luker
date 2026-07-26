// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

const __ctx = Luker.getContext();
const event_types = __ctx.eventTypes;
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
    assembleExtractionSystemPrompt,
    buildPerTypeRulesBlock,
} from './extraction-schedule.js';
export { DEFAULT_PER_TYPE_INSTRUCTIONS, computeActiveExtractionTypes, assembleExtractionSystemPrompt, buildPerTypeRulesBlock };
import {
    configure as configureCharacterOverrides,
    getCurrentAvatar,
    getCharacterSchemaOverrideByAvatar,
    getCharacterAdvancedOverrideByAvatar,
    getEffectiveAdvancedSettings,
    getEffectiveSettings,
    getEffectiveNodeTypeSchema,
    getSchemaScopeInfo,
    getAdvancedScopeInfo,
    persistCharacterSchemaOverride,
    removeCharacterSchemaOverride,
    persistCharacterAdvancedOverride,
    removeCharacterAdvancedOverride,
} from './character-overrides.js';
import {
    sanitizeMemoryGraphFileNamePart,
    getMemoryGraphExportFileName,
    getImportedStoreBindingFloor,
    clearImportedStoreTransientState,
    bindImportedStoreToAssistantFloor,
    getSchemaExportFileName,
    buildSchemaExportPayload,
    parseSchemaImportPayload,
} from './import-export.js';
import { openSchemaIterationStudio } from './schema-iteration/studio.js';
import { DEFAULT_SCHEMA_ITER_SYSTEM_PROMPT } from './schema-iteration/system-prompt.js';
import {
    EVENT_SUMMARY_RULES_BODY,
    DEFAULT_EXTRACT_SYSTEM_PROMPT,
    DEFAULT_EVENT_COMPRESS_INSTRUCTION,
} from './default-prompts.js';
import { registerManagedRegexProvider, regex_placement, substitute_find_regex } from '../regex/engine.js';
import { computeDepthsFromEnd, regexChatMessageForAgent } from '../../lib/chat-regex.js';
import { getChatCompletionConnectionProfiles } from '../connection-manager/profile-resolver.js';
import {
    TOOL_PROTOCOL_STYLE,
    validateParsedToolCalls,
} from '../function-call-runtime.js';
import {
    buildManualCompressionPopupHtml,
    buildMemoryGraphSettingsHtml,
    buildSchemaEditorPopupHtml,
} from './ui-templates.js';
import { runRagRecall } from './retriever.js';
import {
    getVectorConfigFromSettings,
    getRerankProfileFromSettings,
    validateVectorConfig,
    syncVectorIndex,
    ensureVectorIndexState,
    buildCollectionId,
    purgeVectorCollection,
} from './vector-index.js';
import {
    renderProfileSelect,
    upsertEmbeddingProfile,
    upsertRerankProfile,
} from '../connection-manager/embed-rerank.js';

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
    getFloorFromAssistantSeq,
    loadMetaFields,
    persistMetaFields,
    migrateLegacyMemoryGraphState,
    constants as floorStateAdapterConstants,
    createEmptyStore,
    createEmptyPersistedMemoryState,
    normalizeStoreForRuntime,
    normalizePersistedMemoryState,
    applyLoggedNodeSnapshot,
    applyMemoryLogEntryToStore,
    buildRuntimeStoreFromPersistedState,
    buildMemoryLogOpsFromStore,
    graphPayloadFromStore,
    metaFieldsFromStore,
    buildRuntimeStoreFromGraphPayloadAndMeta,
    synthesizePersistedStateFromStoreAndMeta,
    hasPersistedStoreMetadataChanges,
    getStoreCoveredSeqTo,
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
    getRollbackEdgeKey,
    addEdge,
    removeEdge,
    dropNode,
    repairStoreAfterRollback,
    compareNodesByTimeline,
    getSemanticCoverageSeq,
} from './graph-ops.js';
import { __recordInjectedNodeIds } from './external-api.js';

const MODULE_NAME = 'memory_graph';
const CHAT_STATE_NAMESPACE = MODULE_NAME;
const META_NAMESPACE = floorStateAdapterConstants.META_NAMESPACE;
const META_SCHEMA_VERSION = floorStateAdapterConstants.SCHEMA_VERSION;
const PERSISTED_STORE_VERSION = floorStateAdapterConstants.PERSISTED_STORE_VERSION;
const UI_BLOCK_ID = 'memory_graph_settings';
const STYLE_ID = 'memory_graph_style';
const SHARED_LOREBOOK_NAME = '__MEMORY_GRAPH__';
const RUNTIME_LOREBOOK_COMMENT_PREFIX = 'MEMORY_GRAPH_RUNTIME';
const PERSISTENT_LOREBOOK_COMMENT_PREFIX = 'MEMORY_GRAPH_PERSISTENT';
const RECALL_ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
const RECALL_REUSE_GENERATION_TYPES = new Set(['continue', 'regenerate', 'swipe']);
const CHARACTER_SCHEMA_OVERRIDE_KEY = 'schemaOverride';
const CHARACTER_ADVANCED_OVERRIDE_KEY = 'advancedOverride';
const MEMORY_GRAPH_SEARCH_ALL_TYPE = '__all__';
const MEMORY_GRAPH_SEARCH_RESULT_PREVIEW_LIMIT = 10;
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
        extractEveryN: 1,
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

export { DEFAULT_EXTRACT_SYSTEM_PROMPT };

const EVENT_SUMMARY_TIME_EXTRACT_PROMPT_LINES = [
    'Event summary time hard rule: every event row must put an explicit full in-world date/time or date span at the start of summary, formatted as "时间：<time>；<summary>".',
    'Event summary time completeness rule: use complete year/month/day-style precision when the world supports it; for non-real-world settings, use that world\'s full calendar/date notation instead of modern placeholders.',
    'Event summary time inference rule: when dialogue/context does not state a concrete time, infer or invent one plausible full in-world timestamp/span from chronology, world info, and continuity. This constructive inference is allowed only for the summary time prefix, and it must stay consistent with known facts.',
    'Event summary time placeholder ban: never use placeholders or vague substitutes such as x年x月x日, X年X月X日, 某年某月某日, 未知时间, 待定时间.',
    'Event summary prefix rule: after the time prefix, continue with concise causal summary text.',
];

const DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT = [
    'You are a memory recall planner focused on relevance, continuity, and efficiency.',
    'You must output exactly one short <thought>...</thought> before tool call to explain your plan.',
    'Input format: XML blocks (recall_query_context, candidate_nodes, always_inject_node_ids, schema_overview, selection_constraints). Read all blocks before deciding.',
    'First, extract a compact query profile from recall_query_context: active entities, locations, goals, unresolved commitments, relationship/emotion shifts, and causal constraints.',
    'Do not rely on keywords only. Use semantic cues, intent, and causal context from recent dialogue.',
    'Primary goal: pick the smallest high-value set that best supports the CURRENT scene and next reply.',
    'Apply layered relevance explicitly: (1) direct relevance to this turn, (2) indirect continuity support, (3) background context with clear potential impact.',
    'Rank candidates by practical usefulness now: direct event support, causality continuity, unresolved commitments/constraints, and key character/location/rule grounding.',
    'Use edge_summary to follow relation chains and avoid isolated picks.',
    '',
    '## Hierarchy awareness (event nodes form a multi-layer tree)',
    'Each candidate carries three structural fields:',
    '  - semantic_depth: 0 = leaf (one source-batch event); 1+ = rollup that compresses N children into one milestone.',
    '  - parent_id: id of the rollup that contains this node, if any.',
    '  - child_count: number of immediate children this node summarises (0 for leaves).',
    'Mental model: deeper into the tree = more abstract over a longer span; closer to the leaves = richer scene-specific detail (paraphrased lines, specific actions, specific reactions, posture / scene / sensory cues). The same storyline exists at multiple zoom levels.',
    'You do NOT have to drill — finalize is fine when the current candidate set already covers the need. The hierarchy is a tool, not an obligation.',
    '',
    '## When to drill (use sparingly)',
    'Drill when a rollup looks topically on-target but, by design, has compressed away the specifics this turn needs — e.g. what exactly was promised, who reacted how, what one specific ally did, what items changed hands, what the scene felt like.',
    'Do NOT drill when:',
    '  - The rollup\'s abstract gist is enough (continuation, background context).',
    '  - No rollup is topically relevant — drilling will not create relevance.',
    '  - The needed detail is already present in another candidate at lower depth.',
    'How drill works: set action="drill" and put 1-2 high-value rollups in expand_plan as seed_node_id with include_children:true (the system will pull their immediate children into the next-pass candidate set). Keep depth small (1 unless grand-children are clearly needed). Wide drilling wastes budget.',
    '',
    'Return action="finalize" if current candidates are sufficient.',
    'Return action="drill" only when extra expansion is clearly needed for missing context.',
    'When drilling, expand around high-value seeds instead of broad expansion.',
    'Always-inject nodes are already injected separately. Never include them in selected_node_ids.',
    'Do not fabricate missing facts. If grounded evidence is weak or absent, prefer conservative selection or empty selection and explain briefly in reason.',
    'Be honest: if no grounded memory should be recalled, return finalize with empty selected_node_ids.',
    'FINAL OUTPUT CONTRACT (ABSOLUTE): return EXACTLY two parts in order: (1) one <thought>...</thought>; (2) function call output only.',
    'Do not output any narrative/body text, markdown, code fences, XML blocks (except <thought>), comments, or any extra JSON payload.',
    'After function call output, stop immediately.',
].join('\n');

const DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT = [
    'You are finalizing memory recall node selection after optional drill expansion.',
    'You must output exactly one short <thought>...</thought> before tool call to explain your final tradeoff.',
    'Input format: XML blocks (recall_query_context, candidate_nodes, always_inject_node_ids, route_result, selection_constraints). Read all blocks before deciding.',
    'Before selecting, extract the key information needs of this turn from context: who/where/what is active, what must stay continuous, and what unknowns matter now.',
    'Do not rely on keywords only. Use semantic intent and causal continuity.',
    'Select nodes that maximize practical value for the immediate next reply.',
    'Keep storyline continuity first, then add essential support nodes (character/location/rule) only when they materially improve correctness.',
    'Apply layered relevance in final ranking: direct > indirect > background-potential.',
    '',
    '## Hierarchy preference (event nodes)',
    'Event candidates carry semantic_depth (0 = leaf, 1+ = rollup), parent_id, and child_count. When both a rollup and one of its descendant leaves are in candidate_nodes:',
    '  - Prefer the LEAF when this turn needs specifics (a paraphrased line, a specific action, a specific reaction, exact items / promises / damage).',
    '  - Prefer the ROLLUP when this turn needs gist over a long span and per-scene detail would dilute the signal.',
    '  - Avoid selecting both for the same storyline — the rollup was synthesised from those leaves, so the two views overlap and the budget would be wasted.',
    'When picking detail leaves, choose only the few most causally relevant ones; do not pick an entire sibling group just because their parent is relevant.',
    '',
    'Output selected_node_ids in priority order (highest value first).',
    'Prefer a compact set (typically 3-8 when available) instead of selecting everything.',
    'Always-inject nodes are already injected separately. Never include them in selected_node_ids.',
    'If no candidate is grounded and useful, return an empty list rather than forcing weak picks or inventing links.',
    'Be explicit and honest when returning empty selection.',
    'Never hallucinate facts not grounded in candidates.',
    'FINAL OUTPUT CONTRACT (ABSOLUTE): return EXACTLY two parts in order: (1) one <thought>...</thought>; (2) function call output only.',
    'Do not output any narrative/body text, markdown, code fences, XML blocks (except <thought>), comments, or any extra JSON payload.',
    'After function call output, stop immediately.',
].join('\n');

const DEFAULT_RAG_REWRITE_SYSTEM_PROMPT = [
    'You rewrite the user\'s most recent conversational context into a single concise sentence in the dialogue\'s language that maximizes vector-search recall of related past events from a long-form roleplay\'s memory graph.',
    '',
    'Output requirements:',
    '- Exactly one sentence, 15-40 characters (for CJK) or 8-25 words (for Latin scripts).',
    '- State the SUBSTANCE the user wants recalled (a past event, scene, or fact), NOT the meta-instruction to recall.',
    '- Use entity names and concrete verbs that would appear verbatim in summarized event records. Prefer "<actor> <verb> <object>" form. Avoid abstract framing like "讨论某事" or "talked about something" — name the act directly.',
    '- Drop pronouns, filler, and current scene setup; keep only what identifies the callback target.',
    '- Resolve ambiguous references to a named entity when context supports it, otherwise omit.',
    '- Never invent facts not present in the dialogue.',
    '- If the dialogue contains no clear callback intent toward a prior memory, output the most salient concrete action and its named actor from the recent turns instead.',
    '',
    'FINAL OUTPUT CONTRACT: return EXACTLY one function call to rewrite_recall_query with the sentence. No prose, no markdown, no extra text.',
].join('\n');

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
const EXTRACT_PROMPT_EDGE_TYPE_LINES = [
    `Relation vocabulary hard rule: only use these canonical relation types for semantic links: ${CANONICAL_EXTRACT_RELATION_TYPES_TEXT}.`,
    'Thought relation review rule: in section [3] (link plan), explicitly inspect graph_data edges and reuse existing canonical relation labels when the meaning matches. Do not invent a new synonym, translation, or near-duplicate relation label.',
    'Relation normalization rule: involved_in vs mentions for event-end edges: use involved_in only when the entity/character is ON SCENE with dialogue/action/perception/being-acted-on; use mentions when the entity is discussed/referenced/implicated but NOT on scene (e.g. two characters talk about an absent third).',
    'Relation normalization rule: occurred_at — use when an event takes place at a location.',
    'Relation normalization rule: advances vs updates for event→thread edges: use advances when the event PROGRESSES the thread toward its resolution condition (including status flips to resolved/abandoned); use updates when the same event materially CHANGED thread.note text in this batch. Both can apply simultaneously (write both edges). Neither applies → write no edge; do not default to advances for tangential threads.',
    'Relation normalization rule: related is a narrow catch-all — allowed ONLY for character↔character weak ties (below allied/hostile/family/partner/sworn/mentor/debt/deceiving) and location↔location proximity/containment. NEVER use related for character→location (write to character_sheet.identity instead), event-end, or thread-end.',
    'Relation normalization rule: symmetric relations (partner_of, family_of, allied_with, hostile_to) — write ONE edge per pair with direction=bidirectional; do not write two edges (A→B and B→A) for the same relationship. System canonicalizes storage and diffuses symmetrically.',
    'Forbidden relation drift: do not mix Chinese and English variants or near-synonyms for the same meaning. Forbidden examples include 参与者 / 涉及主角 / participant / main_character when involved_in fits, and 发生地 / 发生在 / 发生地点 / 发生于 / occurred_at / happened_at / location / located_at / happened_in / occurs_at for the same event-location meaning.',
    'Internal edge prohibition: do not create contains or semantic_contains via extraction tools; hierarchy edges are managed by the graph system, not by semantic extraction.',
];


const defaultSettings = {
    enabled: false,
    autoExtractionEnabled: true,
    autoCompressionEnabled: true,
    updateEvery: 1,
    maxTurns: 900,
    recallEnabled: true,
    recallMethod: 'llm',
    recallInjectPosition: world_info_position.atDepth,
    recallInjectDepth: 9999,
    recallInjectRole: extension_prompt_roles.SYSTEM,
    recallApiPresetName: '',
    recallPresetName: '',
    includeWorldInfoWithPreset: true,
    toolCallRetryMax: 2,
    recallMaxIterations: 3,
    recallRouteSystemPrompt: DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT,
    recallFinalizeSystemPrompt: DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT,
    extractApiPresetName: '',
    extractPresetName: '',
    requestApiPresetName: '',
    requestLlmPresetName: '',
    extractSystemPrompt: DEFAULT_EXTRACT_SYSTEM_PROMPT,
    schemaIterSystemPrompt: DEFAULT_SCHEMA_ITER_SYSTEM_PROMPT,
    extractBatchTurns: 1,
    extractContextTurns: 2,
    extractExcludeRecentTurns: 0,
    recallQueryMessages: 2,
    recentRawTurns: 2,
    llmVisibleRecentMessages: 5,
    lorebookNameOverride: '',
    lorebookEntryOrderBase: 9800,
    nodeTypeSchema: defaultNodeTypeSchema,
    embeddingProfileId: '',
    rerankProfileId: '',
    vectorTopK: 20,
    hybridMaxResults: 15,
    ragUseRerank: false,
    ragUseQueryRewrite: false,
    ragRewriteApiPresetName: '',
    ragRewriteLlmPresetName: '',
    ragRewriteSystemPrompt: DEFAULT_RAG_REWRITE_SYSTEM_PROMPT,
    rpmLimit: 0,
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
//                 lands inside the not-yet-committed tail
//   committedSeq: highest endSeq that has been fully committed
//                 (batch commit + compression commit both bump it)
let activeExtractionScope = null;
let activeRecallRunToken = 0;
let nextActiveRecallRequestId = 0;
const activeRecallRequestStates = new Map();
let cytoscapeLoadPromise = null;
let lastKnownChatKey = '';
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
            const rawId = String(item.id || `custom_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
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
                extractEveryN: Math.max(1, Math.floor(Number.isFinite(Number(item.extractEveryN)) ? Number(item.extractEveryN) : 1) || 1),
                keywords: Array.isArray(item.keywords) ? item.keywords.map(x => String(x || '').trim()).filter(Boolean) : [],
                columnHints,
                requiredColumns,
                forceUpdate,
                editable,
                alwaysInject: Boolean(item.alwaysInject),
                latestOnly,
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

function normalizeExtractExcludeRecentTurns(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
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

    extension_settings[MODULE_NAME].toolCallRetryMax = Math.max(
        0,
        Math.min(10, Math.floor(Number(extension_settings[MODULE_NAME].toolCallRetryMax) || 0)),
    );
    extension_settings[MODULE_NAME].rpmLimit = Math.max(
        0,
        Math.floor(Number(extension_settings[MODULE_NAME].rpmLimit) || 0),
    );
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
    extension_settings[MODULE_NAME].recallMaxIterations = Math.max(
        2,
        Math.min(6, Math.floor(Number(extension_settings[MODULE_NAME].recallMaxIterations) || defaultSettings.recallMaxIterations)),
    );
    const extractBatchTurnsRaw = Number(extension_settings[MODULE_NAME].extractBatchTurns);
    const extractContextTurnsRaw = Number(extension_settings[MODULE_NAME].extractContextTurns);
    const extractExcludeRecentTurnsRaw = Number(extension_settings[MODULE_NAME].extractExcludeRecentTurns);
    const recallQueryMessagesRaw = Number(extension_settings[MODULE_NAME].recallQueryMessages);
    const recentRawTurnsRaw = Number(extension_settings[MODULE_NAME].recentRawTurns);
    const llmVisibleRecentMessagesRaw = Number(extension_settings[MODULE_NAME].llmVisibleRecentMessages);
    extension_settings[MODULE_NAME].extractBatchTurns = Math.max(
        1,
        Math.floor(Number.isFinite(extractBatchTurnsRaw) ? extractBatchTurnsRaw : defaultSettings.extractBatchTurns),
    );
    extension_settings[MODULE_NAME].extractContextTurns = Math.max(
        1,
        Math.min(32, Math.floor(Number.isFinite(extractContextTurnsRaw) ? extractContextTurnsRaw : defaultSettings.extractContextTurns)),
    );
    extension_settings[MODULE_NAME].extractExcludeRecentTurns = normalizeExtractExcludeRecentTurns(
        Number.isFinite(extractExcludeRecentTurnsRaw) ? extractExcludeRecentTurnsRaw : defaultSettings.extractExcludeRecentTurns,
    );
    extension_settings[MODULE_NAME].recallQueryMessages = Math.max(
        1,
        Math.min(64, Math.floor(Number.isFinite(recallQueryMessagesRaw) ? recallQueryMessagesRaw : defaultSettings.recallQueryMessages)),
    );
    extension_settings[MODULE_NAME].recentRawTurns = Math.max(
        0,
        Math.floor(Number.isFinite(recentRawTurnsRaw) ? recentRawTurnsRaw : defaultSettings.recentRawTurns),
    );
    extension_settings[MODULE_NAME].llmVisibleRecentMessages = Math.max(
        0,
        Math.min(200, Math.floor(Number.isFinite(llmVisibleRecentMessagesRaw) ? llmVisibleRecentMessagesRaw : defaultSettings.llmVisibleRecentMessages)),
    );
    extension_settings[MODULE_NAME].includeWorldInfoWithPreset = extension_settings[MODULE_NAME].includeWorldInfoWithPreset !== false;
    extension_settings[MODULE_NAME].extractSystemPrompt = String(extension_settings[MODULE_NAME].extractSystemPrompt || '').trim() || DEFAULT_EXTRACT_SYSTEM_PROMPT;
    extension_settings[MODULE_NAME].schemaIterSystemPrompt = String(extension_settings[MODULE_NAME].schemaIterSystemPrompt || '').trim() || DEFAULT_SCHEMA_ITER_SYSTEM_PROMPT;
    extension_settings[MODULE_NAME].recallRouteSystemPrompt = String(extension_settings[MODULE_NAME].recallRouteSystemPrompt || '').trim() || DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT;
    extension_settings[MODULE_NAME].recallFinalizeSystemPrompt = String(extension_settings[MODULE_NAME].recallFinalizeSystemPrompt || '').trim() || DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT;
    extension_settings[MODULE_NAME].ragRewriteSystemPrompt = String(extension_settings[MODULE_NAME].ragRewriteSystemPrompt || '').trim() || DEFAULT_RAG_REWRITE_SYSTEM_PROMPT;
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

function normalizeAdvancedSettings(source = null, fallbackSource = null) {
    const base = fallbackSource && typeof fallbackSource === 'object' ? fallbackSource : defaultSettings;
    const input = source && typeof source === 'object' ? source : {};
    const extractBatchTurnsRaw = Number(input.extractBatchTurns);
    const extractContextTurnsRaw = Number(input.extractContextTurns);
    const extractExcludeRecentTurnsRaw = Number(input.extractExcludeRecentTurns);
    const recallQueryMessagesRaw = Number(input.recallQueryMessages);
    const recentRawTurnsRaw = Number(input.recentRawTurns);
    const llmVisibleRecentMessagesRaw = Number(input.llmVisibleRecentMessages);
    const recallIterationsRaw = Number(input.recallMaxIterations);
    const toolRetryRaw = Number(input.toolCallRetryMax);
    const rpmLimitRaw = Number(input.rpmLimit);
    return {
        recentRawTurns: Math.max(
            0,
            Math.floor(Number.isFinite(recentRawTurnsRaw) ? recentRawTurnsRaw : Number(base.recentRawTurns ?? defaultSettings.recentRawTurns)),
        ),
        llmVisibleRecentMessages: Math.max(
            0,
            Math.min(200, Math.floor(Number.isFinite(llmVisibleRecentMessagesRaw) ? llmVisibleRecentMessagesRaw : Number(base.llmVisibleRecentMessages ?? defaultSettings.llmVisibleRecentMessages))),
        ),
        recallMaxIterations: Math.max(
            2,
            Math.min(6, Math.floor(Number.isFinite(recallIterationsRaw) ? recallIterationsRaw : Number(base.recallMaxIterations || defaultSettings.recallMaxIterations))),
        ),
        toolCallRetryMax: Math.max(
            0,
            Math.min(10, Math.floor(Number.isFinite(toolRetryRaw) ? toolRetryRaw : Number(base.toolCallRetryMax || defaultSettings.toolCallRetryMax))),
        ),
        extractExcludeRecentTurns: normalizeExtractExcludeRecentTurns(
            Number.isFinite(extractExcludeRecentTurnsRaw)
                ? extractExcludeRecentTurnsRaw
                : Number(base.extractExcludeRecentTurns ?? defaultSettings.extractExcludeRecentTurns),
        ),
        extractContextTurns: Math.max(
            1,
            Math.min(32, Math.floor(Number.isFinite(extractContextTurnsRaw) ? extractContextTurnsRaw : Number(base.extractContextTurns || defaultSettings.extractContextTurns))),
        ),
        recallQueryMessages: Math.max(
            1,
            Math.min(64, Math.floor(Number.isFinite(recallQueryMessagesRaw) ? recallQueryMessagesRaw : Number(base.recallQueryMessages || defaultSettings.recallQueryMessages))),
        ),
        extractBatchTurns: Math.max(
            1,
            Math.floor(Number.isFinite(extractBatchTurnsRaw) ? extractBatchTurnsRaw : Number(base.extractBatchTurns || defaultSettings.extractBatchTurns)),
        ),
        rpmLimit: Math.max(
            0,
            Math.floor(Number.isFinite(rpmLimitRaw) ? rpmLimitRaw : Number(base.rpmLimit ?? defaultSettings.rpmLimit)),
        ),
        extractSystemPrompt: String(input.extractSystemPrompt || '').trim() || String(base.extractSystemPrompt || DEFAULT_EXTRACT_SYSTEM_PROMPT),
        schemaIterSystemPrompt: String(input.schemaIterSystemPrompt || '').trim() || String(base.schemaIterSystemPrompt || DEFAULT_SCHEMA_ITER_SYSTEM_PROMPT),
        recallRouteSystemPrompt: String(input.recallRouteSystemPrompt || '').trim() || String(base.recallRouteSystemPrompt || DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT),
        recallFinalizeSystemPrompt: String(input.recallFinalizeSystemPrompt || '').trim() || String(base.recallFinalizeSystemPrompt || DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT),
        ragRewriteSystemPrompt: String(input.ragRewriteSystemPrompt || '').trim() || String(base.ragRewriteSystemPrompt || DEFAULT_RAG_REWRITE_SYSTEM_PROMPT),
        includeWorldInfoWithPreset: (
            typeof input.includeWorldInfoWithPreset === 'boolean'
                ? input.includeWorldInfoWithPreset
                : (typeof base.includeWorldInfoWithPreset === 'boolean' ? base.includeWorldInfoWithPreset : true)
        ),
    };
}

function applyAdvancedSettings(target, values) {
    if (!target || typeof target !== 'object') {
        return;
    }
    const normalized = normalizeAdvancedSettings(values, target);
    target.recentRawTurns = normalized.recentRawTurns;
    target.llmVisibleRecentMessages = normalized.llmVisibleRecentMessages;
    target.recallMaxIterations = normalized.recallMaxIterations;
    target.toolCallRetryMax = normalized.toolCallRetryMax;
    target.rpmLimit = normalized.rpmLimit;
    target.extractExcludeRecentTurns = normalized.extractExcludeRecentTurns;
    target.extractContextTurns = normalized.extractContextTurns;
    target.recallQueryMessages = normalized.recallQueryMessages;
    target.extractBatchTurns = normalized.extractBatchTurns;
    target.extractSystemPrompt = normalized.extractSystemPrompt;
    target.schemaIterSystemPrompt = normalized.schemaIterSystemPrompt;
    target.recallRouteSystemPrompt = normalized.recallRouteSystemPrompt;
    target.recallFinalizeSystemPrompt = normalized.recallFinalizeSystemPrompt;
    target.ragRewriteSystemPrompt = normalized.ragRewriteSystemPrompt;
    target.includeWorldInfoWithPreset = normalized.includeWorldInfoWithPreset;
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

function getConnectionProfiles() {
    return getChatCompletionConnectionProfiles();
}

function renderConnectionProfileOptions(selectedName = '') {
    const selected = String(selectedName || '').trim();
    const names = getConnectionProfiles().map(profile => profile.name);
    const options = [`<option value="">${escapeHtml(i18n('(Current API config)'))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function refreshOpenAIPresetSelectors(root, context, settings) {
    const selectorValues = [
        ['#luker_rpg_memory_recall_api_preset', settings.recallApiPresetName],
        ['#luker_rpg_memory_recall_preset', settings.recallPresetName],
        ['#luker_rpg_memory_extract_api_preset', settings.extractApiPresetName],
        ['#luker_rpg_memory_extract_preset', settings.extractPresetName],
        ['#luker_rpg_memory_request_api_preset', settings.requestApiPresetName],
        ['#luker_rpg_memory_request_llm_preset', settings.requestLlmPresetName],
        ['#luker_rpg_memory_rag_rewrite_api_preset', settings.ragRewriteApiPresetName],
        ['#luker_rpg_memory_rag_rewrite_llm_preset', settings.ragRewriteLlmPresetName],
    ];

    for (const [selector, value] of selectorValues) {
        const select = root.find(selector);
        if (!select.length) {
            continue;
        }
        const isConnectionSelector = selector.endsWith('_api_preset');
        select.html(isConnectionSelector ? renderConnectionProfileOptions(value) : renderOpenAIPresetOptions(context, value));
        select.val(String(value || '').trim());
    }
}

function getChatKey(context, explicitTarget = null) {
    const target = buildMemoryTargetFromContext(context, explicitTarget);
    if (!target) {
        return 'invalid_target';
    }
    if (target.is_group) {
        const key = `group:${target.id}`;
        lastKnownChatKey = key;
        return key;
    }
    const key = `char:${target.avatar_url}:${target.file_name}`;
    lastKnownChatKey = key;
    return key;
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
async function replaceGraphLogForTarget(context, store, seq, floor) {
    const fs = await getFloorStateInstance(context);
    await fs.ready();
    const normalizedStore = normalizeStoreForRuntime(store);
    const normalizedSeq = Math.max(0, Math.floor(Number(seq || getStoreCoveredSeqTo(normalizedStore) || 0)));
    const finalPayload = graphPayloadFromStore(normalizedStore);
    finalPayload.coveredAssistantSeq = Math.max(finalPayload.coveredAssistantSeq, normalizedSeq);
    finalPayload.appliedSeqTo = Math.max(finalPayload.appliedSeqTo, normalizedSeq);
    finalPayload.loggedSeqTo = Math.max(finalPayload.loggedSeqTo, normalizedSeq);

    const floorResolved = Number.isInteger(floor) && floor >= 0;
    const swipeId = floorResolved ? (activeSwipeIdAtFloor(context, floor) ?? 0) : 0;
    const buildObjectPatchOperationsAsync = context.buildObjectPatchOperationsAsync;
    const patches = await buildObjectPatchOperationsAsync({}, finalPayload);

    if (Array.isArray(patches) && patches.length > 0 && floorResolved) {
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
async function commitMemoryStoreReplaceByChatKey(context, chatKey, store, seq, { syncPersistentProjection = false, floor = null } = {}) {
    const target = memoryStoreTargets.get(chatKey);
    if (!target) {
        throw new Error('Memory store target is unavailable.');
    }
    const normalizedStore = normalizeStoreForRuntime(store);
    const normalizedSeq = Math.max(0, Math.floor(Number(seq || getStoreCoveredSeqTo(normalizedStore) || 0)));

    const replaceResult = await replaceGraphLogForTarget(context, normalizedStore, normalizedSeq, floor);
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
    const normalizedSeq = Math.max(0, Math.floor(Number(seq || getStoreCoveredSeqTo(normalizedAfter) || 0)));

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

export function getMemoryStore(context) {
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
    if (storeCommitListeners.size > 0) {
        // Frozen signal — re-query through the Lookup API for fresh data; the
        // cached runtime store is not exposed. Each listener is wrapped
        // individually so one throw doesn't abort iteration over the rest.
        const snapshot = Object.freeze({ chatKey: key });
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
    const nextMeta = {
        schemaVersion: META_SCHEMA_VERSION,
        sourceMessageCount: Math.max(0, Number(cached.sourceMessageCount || 0)),
        lastRecallTrace: structuredClone(Array.isArray(trace) ? trace : []),
        lastRecallProjection: projection && typeof projection === 'object'
            ? structuredClone(projection)
            : null,
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

function isLongFieldValue(value) {
    if (typeof value !== 'string') {
        return false;
    }
    return value.length > 80 || /[\r\n]/.test(value);
}

function formatNodeFieldValueHtml(value) {
    if (value === null || value === undefined || value === '') {
        return '<span class="luker-node-detail-empty">—</span>';
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return '<span class="luker-node-detail-empty">—</span>';
        }
        const allScalar = value.every(item => item === null || typeof item !== 'object');
        if (allScalar) {
            return value
                .map(item => `<span class="luker-node-detail-tag">${escapeHtml(String(item))}</span>`)
                .join(' ');
        }
        return `<pre class="luker-node-detail-pre">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
    }
    if (typeof value === 'object') {
        return `<pre class="luker-node-detail-pre">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
    }
    if (typeof value === 'boolean') {
        return value
            ? `<span class="luker-node-detail-bool is-true"><i class="fa-solid fa-check fa-fw"></i>${escapeHtml(i18n('Yes'))}</span>`
            : `<span class="luker-node-detail-bool is-false"><i class="fa-solid fa-xmark fa-fw"></i>${escapeHtml(i18n('No'))}</span>`;
    }
    const str = String(value);
    if (isLongFieldValue(str)) {
        return `<div class="luker-node-detail-text">${escapeHtml(str)}</div>`;
    }
    return `<span class="luker-node-detail-scalar">${escapeHtml(str)}</span>`;
}

function renderNodeDetailHtml(node) {
    if (!node || typeof node !== 'object') {
        return '';
    }
    const id = String(node.id || '');
    const title = String(node.title || node.id || '');
    const type = String(node.type || '');
    const level = String(node.level || '');
    const seqFrom = node.seqFrom ?? null;
    const seqTo = node.seqTo ?? null;
    const parentId = String(node.parentId || '');
    const archived = Boolean(node.archived);
    const childrenIds = Array.isArray(node.childrenIds) ? node.childrenIds : [];
    const semanticDepthRaw = node.semanticDepth;
    const semanticDepth = Number.isFinite(Number(semanticDepthRaw)) ? Number(semanticDepthRaw) : null;
    const semanticRollup = Boolean(node.semanticRollup);
    const fields = node.fields && typeof node.fields === 'object' && !Array.isArray(node.fields) ? node.fields : {};

    let seqLabel = '';
    if (seqFrom !== null && seqFrom !== undefined && seqTo !== null && seqTo !== undefined && seqFrom !== seqTo) {
        seqLabel = `${seqFrom}–${seqTo}`;
    } else if (seqTo !== null && seqTo !== undefined && seqTo !== '') {
        seqLabel = String(seqTo);
    } else if (seqFrom !== null && seqFrom !== undefined && seqFrom !== '') {
        seqLabel = String(seqFrom);
    }

    const metaItems = [];
    if (parentId) {
        metaItems.push(`<div class="luker-node-detail-meta-item"><span class="luker-node-detail-meta-key">${escapeHtml(i18n('Parent Node'))}</span><span class="luker-node-detail-meta-val">${escapeHtml(parentId)}</span></div>`);
    }
    if (childrenIds.length) {
        metaItems.push(`<div class="luker-node-detail-meta-item"><span class="luker-node-detail-meta-key">${escapeHtml(i18n('Children'))}</span><span class="luker-node-detail-meta-val">${childrenIds.length}</span></div>`);
    }
    if (seqLabel) {
        metaItems.push(`<div class="luker-node-detail-meta-item"><span class="luker-node-detail-meta-key">${escapeHtml(i18n('Sequence'))}</span><span class="luker-node-detail-meta-val">${escapeHtml(seqLabel)}</span></div>`);
    }
    if (semanticDepth !== null && semanticDepth > 0) {
        metaItems.push(`<div class="luker-node-detail-meta-item"><span class="luker-node-detail-meta-key">${escapeHtml(i18n('Semantic Depth'))}</span><span class="luker-node-detail-meta-val">${escapeHtml(String(semanticDepth))}</span></div>`);
    }
    if (semanticRollup) {
        metaItems.push(`<div class="luker-node-detail-meta-item"><span class="luker-node-detail-meta-key">${escapeHtml(i18n('Semantic Rollup'))}</span><span class="luker-node-detail-meta-val">${escapeHtml(i18n('Yes'))}</span></div>`);
    }
    if (archived) {
        metaItems.push(`<div class="luker-node-detail-meta-item is-warn"><span class="luker-node-detail-meta-key">${escapeHtml(i18n('Archived'))}</span><span class="luker-node-detail-meta-val">${escapeHtml(i18n('Yes'))}</span></div>`);
    }

    const summaryText = getNodeSummary(node);

    const fieldEntries = Object.entries(fields).filter(([key]) => key !== 'summary');
    const fieldRowsHtml = fieldEntries.map(([key, value]) => {
        const isLong = (typeof value === 'string' && isLongFieldValue(value))
            || (Array.isArray(value) && value.some(item => item !== null && typeof item === 'object'))
            || (value !== null && typeof value === 'object' && !Array.isArray(value));
        return `
<div class="luker-node-detail-row${isLong ? ' is-block' : ''}">
    <div class="luker-node-detail-key">${escapeHtml(String(key))}</div>
    <div class="luker-node-detail-value">${formatNodeFieldValueHtml(value)}</div>
</div>`;
    }).join('');

    const childrenChipsHtml = childrenIds.length
        ? childrenIds.map(c => `<span class="luker-node-detail-tag">${escapeHtml(String(c))}</span>`).join(' ')
        : '';

    return `
<div class="luker-node-detail">
    <div class="luker-node-detail-header">
        <div class="luker-node-detail-title-row">
            <span class="luker-node-detail-title">${escapeHtml(title)}</span>
            ${type ? `<span class="luker-node-detail-badge is-type">${escapeHtml(type)}</span>` : ''}
            ${level ? `<span class="luker-node-detail-badge is-level">${escapeHtml(level)}</span>` : ''}
        </div>
        <div class="luker-node-detail-id">#${escapeHtml(id)}</div>
    </div>
    ${summaryText ? `<div class="luker-node-detail-summary">${escapeHtml(summaryText)}</div>` : ''}
    ${metaItems.length ? `<div class="luker-node-detail-meta">${metaItems.join('')}</div>` : ''}
    ${fieldRowsHtml ? `
    <div class="luker-node-detail-section">
        <div class="luker-node-detail-section-title">${escapeHtml(i18n('Fields'))}</div>
        <div class="luker-node-detail-rows">${fieldRowsHtml}</div>
    </div>` : `
    <div class="luker-node-detail-section">
        <div class="luker-node-detail-empty-block">${escapeHtml(i18n('No fields.'))}</div>
    </div>`}
    ${childrenChipsHtml ? `
    <div class="luker-node-detail-section">
        <div class="luker-node-detail-section-title">${escapeHtml(i18n('Children'))}</div>
        <div class="luker-node-detail-tags">${childrenChipsHtml}</div>
    </div>` : ''}
    <details class="luker-node-detail-raw">
        <summary>${escapeHtml(i18n('View Raw JSON'))}</summary>
        <pre>${escapeHtml(JSON.stringify(node, null, 2))}</pre>
    </details>
</div>`;
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
    for (const message of source) {
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
    return null;
}

function getNodeTypeSchemaMap(settings, context = null) {
    const map = new Map();
    for (const entry of getEffectiveNodeTypeSchema(context, settings)) {
        map.set(String(entry.id || '').toLowerCase(), entry);
    }
    return map;
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

function createNode(store, node) {
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

function reparentNode(store, childId, parentId) {
    const child = store.nodes[childId];
    const parent = store.nodes[parentId];
    if (!child || !parent) {
        return;
    }

    const oldParentId = String(child.parentId || '');
    if (oldParentId && store.nodes[oldParentId]) {
        const oldParent = store.nodes[oldParentId];
        oldParent.childrenIds = (oldParent.childrenIds || []).filter(id => id !== childId);
    }

    child.parentId = parentId;
    if (!Array.isArray(parent.childrenIds)) {
        parent.childrenIds = [];
    }
    if (!parent.childrenIds.includes(childId)) {
        parent.childrenIds.push(childId);
    }
    addEdge(store, parentId, childId, 'contains');
}

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

function archiveNode(store, oldId, replacementId = null) {
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

function normalizeWorldInfoResolverMessages(messages = []) {
    if (!Array.isArray(messages)) {
        return [];
    }

    return messages.map((message) => {
        if (!message || typeof message !== 'object') {
            return message;
        }
        const next = { ...message };
        const rawRole = String(next.role || '').trim().toLowerCase();
        if (rawRole === 'system' || rawRole === 'user' || rawRole === 'assistant') {
            next.role = rawRole;
        } else if (next.is_system) {
            next.role = 'system';
        } else if (next.is_user) {
            next.role = 'user';
        } else {
            next.role = 'assistant';
        }
        if (next.content === undefined && Object.hasOwn(next, 'mes')) {
            next.content = String(next.mes ?? '');
        }
        return next;
    });
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
    const resolverMessages = normalizeWorldInfoResolverMessages(worldInfoMessages);
    if (resolverMessages.length === 0 || typeof context?.resolveWorldInfoForMessages !== 'function') {
        return {};
    }
    throwIfRecallRunInvalid(recallRunToken, abortSignal, 'Memory recall aborted.');
    const resolved = await context.resolveWorldInfoForMessages(resolverMessages, {
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
                throw new Error(validationError);
            }
            const matched = filteredCalls.find(call => call.name === fnName);
            if (!matched) {
                throw new Error(`Model returned tool call, but not '${fnName}'.`);
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
                throw new Error(validationError);
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
    // themselves so per-turn user regex applies at real chat depth via
    // buildPresetAwarePromptMessages → applyPluginRegexToPromptMessages.
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
    const forceUpdate = Boolean(spec?.forceUpdate);
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
    if (typeId === 'event' && fields.includes('summary')) {
        chunks.push('Event summary time rule: summary must begin with "时间：<time>；" using an explicit full in-world date/time or date span.');
        chunks.push('Event summary time inference: if source lacks a concrete timestamp, infer or invent one plausible continuity-consistent full time instead of placeholders.');
        chunks.push('Event summary time ban: never use x年x月x日, 某年某月某日, 未知时间, 待定时间, or similar placeholders.');
    }
    if (latestOnly && primaryKeyColumns.length > 0) {
        chunks.push(`Dedup rule: before create, inspect graph_data.nodes and prefer edit over create when an existing node plausibly matches by primary-key overlap (${primaryKeyColumns.join(', ')}).`);
    }
    if (normalizedMode === 'create') {
        chunks.push(`Link relation vocabulary: when adding links, only use canonical relation types ${CANONICAL_EXTRACT_RELATION_TYPES_TEXT}. Reuse existing canonical labels instead of inventing synonyms or bilingual variants.`);
    }
    chunks.push(`Force update each extraction batch: ${forceUpdate ? 'yes' : 'no'}`);
    return chunks.join(' ');
}

export { buildDynamicExtractTools };

function buildDynamicExtractTools(schema = [], options = {}) {
    const tools = [];
    const specByToolName = new Map();
    const usedNames = new Set();
    const allowEditDelete = options?.allowEditDelete !== false;
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
            ref: { type: 'string' },
            no_link_reason: { type: 'string' },
            links: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        target_ref: { type: 'string', description: 'Optional. Use either target_ref or target_node_id.' },
                        target_node_id: { type: 'string', description: 'Optional. Use either target_node_id or target_ref.' },
                        relation: { type: 'string', description: `Canonical relation type only. Allowed values: ${CANONICAL_EXTRACT_RELATION_TYPES_TEXT}.` },
                        direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'] },
                    },
                    additionalProperties: false,
                },
            },
        };
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
        if (typeId === 'event' && !createRequiredColumns.includes('links')) {
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
                            node_id: { type: 'string' },
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
                            node_id: { type: 'string' },
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

    const linkUpsertToolName = 'luker_rpg_extract_link_upsert';
    tools.push({
        type: 'function',
        function: {
            name: linkUpsertToolName,
            description: `Upsert relation edges between semantic nodes. Use this when only links change. Only use canonical relation types: ${CANONICAL_EXTRACT_RELATION_TYPES_TEXT}. Reuse existing canonical labels instead of inventing synonyms or bilingual variants.`,
            parameters: {
                type: 'object',
                properties: {
                    source_ref: { type: 'string', description: 'Optional. Use either source_ref or source_node_id.' },
                    source_node_id: { type: 'string', description: 'Optional. Use either source_node_id or source_ref.' },
                    links: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                target_ref: { type: 'string', description: 'Optional. Use either target_ref or target_node_id.' },
                                target_node_id: { type: 'string', description: 'Optional. Use either target_node_id or target_ref.' },
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
                    source_node_id: { type: 'string', description: 'Existing node id (one endpoint of the edge).' },
                    target_node_id: { type: 'string', description: 'Existing node id (the other endpoint).' },
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
        const type = String(node?.type || '').trim().toLowerCase();
        const spec = schemaMap.get(type);
        rows.push({
            ...buildLlmFriendlyNodeProjection(node, spec),
            type,
            semantic_depth: Number(node?.semanticDepth ?? node?.metadata?.semantic_depth ?? 0),
            parent_id: String(node?.parentId || ''),
            child_count: Array.isArray(node?.childrenIds) ? node.childrenIds.length : 0,
            editable: Boolean(spec?.editable),
        });
    }
    return rows;
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

function buildRawXmlTag(tag, value, indent = '    ') {
    const safeTag = String(tag || '').trim() || 'value';
    const body = String(value ?? '');
    return [
        `${indent}<${safeTag}>`,
        `${indent}  ${body}`,
        `${indent}</${safeTag}>`,
    ].join('\n');
}

function buildExtractInputHead() {
    return [
        '<extract_input>',
        '  <input_guide>dialogue_batch is the current source dialogue to extract from. Each turn is delivered as a real chat message (role=user or assistant) with a leading <seq>{n}</seq> tag identifying its turn number.</input_guide>',
        '  <dialogue_batch>',
    ].join('\n');
}

function buildExtractInputTail(requiredTypes, graphData) {
    const safeRequiredTypes = Array.isArray(requiredTypes)
        ? requiredTypes.map(item => normalizeText(item).toLowerCase()).filter(Boolean)
        : [];
    const safeGraphData = graphData && typeof graphData === 'object' ? graphData : { initialized: false, nodes: [] };

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
        '  <input_guide>graph_data is a full schema-aware projection of the current semantic graph for extraction.</input_guide>',
        '  <input_guide>Each graph_data.nodes row contains key_values (identity keys) and row_values (schema columns).</input_guide>',
        '  <input_guide>graph_data.edges contains the currently projected semantic relations between nodes.</input_guide>',
        '  <input_guide>If graph_data.initialized=false, treat graph as uninitialized and prefer create operations over edit/delete.</input_guide>',
        buildJsonXmlSection('graph_data', safeGraphData),
        '</extract_input>',
    ].join('\n');
}

/**
 * Wrap a chat message's cooked text with the seq metadata prefix used by
 * extraction / recall LLM inputs. The wrapper prefix is added AFTER
 * prompt-scoped regex has already been applied, so user regex rules
 * only see raw chat text — the wrapper doesn't pollute pattern inputs.
 */
function wrapChatMessageContentWithSeq(seq, cookedText) {
    const safeSeq = Number.isFinite(Number(seq)) ? Math.max(0, Math.floor(Number(seq))) : 0;
    return `<seq>${safeSeq}</seq>\n${String(cookedText || '')}`;
}

/**
 * Convert a memory-graph batch item (from buildExtractBatchFromFrames or
 * queryBundle.recent_messages equivalent) into a role-alternating chat
 * completion message, with prompt-scoped user regex scripts applied at
 * the real chat[] depth for parity with the main pipeline.
 *
 * @param {{seq?: number, is_user?: boolean, name?: string, mes?: string, source_index?: number}} item
 * @param {number|undefined} depth
 * @param {{wrapWithSeq?: boolean}} [opts] - When wrapWithSeq is true, the
 *     cooked text is prefixed with `<seq>{n}</seq>\n` so extraction prompts
 *     can identify per-turn seq boundaries. Default false for recall /
 *     rewrite scenarios where seq per turn is not consumed.
 * @returns {{role: string, content: string}}
 */
function buildRoleSplitChatMessage(item, depth, { wrapWithSeq = false } = {}) {
    const isUser = Boolean(item?.is_user);
    const rawText = String(item?.mes || '');
    const cooked = regexChatMessageForAgent({ mes: rawText, is_user: isUser }, depth);
    const content = wrapWithSeq
        ? wrapChatMessageContentWithSeq(Number(item?.seq || 0), cooked)
        : cooked;
    return {
        role: isUser ? 'user' : 'assistant',
        content,
    };
}

/**
 * Turn a batch of memory-graph chat items (with source_index) into
 * role-alternating chat completion messages. Depth is computed against
 * the *full* context.chat so `maxDepth` / `minDepth` filters on user
 * regex rules behave the same as in the main generation pipeline.
 *
 * Items with missing / invalid source_index fall back to `undefined`
 * depth (disabling depth-based script filtering), matching the graceful
 * degradation policy in `regexChatMessageForAgent`.
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
    const graphNodes = buildGraphNodeHints(store, schema, 0, { maxSeq: extractionMaxSeq, scope: 'visible' });
    const graphNodeIds = new Set(graphNodes.map(node => String(node?.id || '')).filter(Boolean));
    const graphEdges = buildProjectedEdges(store, {
        visibleNodeIds: graphNodeIds,
        excludeInternal: false,
    }).map(edge => ({
        from: String(edge?.from || ''),
        to: String(edge?.to || ''),
        type: normalizeText(edge?.type || 'related') || 'related',
        weight: Math.max(1, Number(edge?.weight || 1)),
    }));
    const semanticNodeTotal = listNodesByLevel(store, LEVEL.SEMANTIC)
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
            projection_policy: {
                hierarchical_types: 'top_level_rollups_only',
                non_hierarchical_types: 'full',
            },
            graph_scope: 'visible',
            semantic_node_total: semanticNodeTotal,
            visible_node_count: graphNodes.length,
            nodes: graphNodes,
            edges: graphEdges,
        };
    const baseExtractSystemPrompt = String(settings.extractSystemPrompt || '').trim() || DEFAULT_EXTRACT_SYSTEM_PROMPT;
    const cadenceSeq = Number.isFinite(Number(extractionMaxSeq)) ? Number(extractionMaxSeq) : 0;
    const activeTypes = computeActiveExtractionTypes(schema, cadenceSeq);
    if (activeTypes.size === 0) {
        store.lastExtractionDebug = {
            ...(store.lastExtractionDebug || {}),
            extracted: false,
            reason: 'no_active_types',
            at: Date.now(),
        };
        return [];
    }
    const extractSystemPrompt = assembleExtractionSystemPrompt(baseExtractSystemPrompt);
    const extractInputHead = buildExtractInputHead();
    const extractInputTail = buildExtractInputTail(Array.from(forceUpdateTypes), graphDataPayload);
    // Role-split dialogue: each chat message is a real chat-completion turn
    // (role=user|assistant), with a leading <seq>{n}</seq> tag preserving
    // batch/prior boundary identification. Prompt-scoped user regex is
    // applied per-message at the real chat[] depth so behavior matches the
    // main generation pipeline; the wrapper `<dialogue_batch>` open/close
    // lives in extractInputHead/extractInputTail.
    const roleSplitChatMessages = buildRoleSplitChatMessages(messageBatch, context, { wrapWithSeq: true });
    const perTypeRulesBlock = buildPerTypeRulesBlock(schema, activeTypes);
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
    let lastRetryableError = null;
    for (let attempt = 0; attempt <= semanticRetries; attempt++) {
        const reminderText = attempt > 0
            ? `Previous response was incomplete. Return COMPLETE extraction tool calls in one response: exactly one final luker_rpg_extract_done as the last call (SKIP-all with done-only is valid).${retryReason ? ` Fix: ${retryReason}` : ''}`
            : '';
        const tailParts = [extractInputTail];
        if (perTypeRulesBlock) tailParts.push(perTypeRulesBlock);
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
            console.warn(`[${MODULE_NAME}] Extract request failed. Retrying semantic pass (${attempt + 1}/${semanticRetries})...`, error);
            continue;
        }
        if (!Array.isArray(calls) || calls.length < 1) {
            retryReason = 'Tool calls are missing or incomplete.';
            continue;
        }
            const names = calls.map(call => String(call?.name || '').trim()).filter(Boolean);
            const doneCount = names.filter(name => name === 'luker_rpg_extract_done').length;
            if (doneCount < 1) {
                continue;
            }
            if (names[names.length - 1] !== 'luker_rpg_extract_done') {
                retryReason = 'luker_rpg_extract_done must be the last call.';
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
                if (safeTypeId === 'event') {
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
                continue;
            }
            const missingForceTypes = [...forceUpdateTypes].filter(typeId => !calledTypes.has(typeId));
            if (missingForceTypes.length > 0) {
                retryReason = `Missing force-update type tool calls: ${missingForceTypes.join(', ')}.`;
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
    const source = String(rawValues || '').trim().replace(/^[\[(\{]\s*|\s*[\])\}]$/g, '');
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
    const operations = await extractNodesWithLLM(context, store, settings, schema, extractBatch, {
        maxSeq: extractionMaxSeq,
        abortSignal: options?.abortSignal || null,
        rebuildCreateOnly: Boolean(options?.rebuildCreateOnly),
    });
    if (operations.length === 0) {
        return { processed: true, changed: false };
    }

    applyExtractionOpsImpl(store, operations, {
        maxSeq: extractionMaxSeq,
        minSeq: extractionMinSeq,
        context,
        settings,
    });

    return { processed: true, changed: true };
}

/**
 * Apply a batch of extraction operations to a memory-graph store in place.
 *
 * Used by both the internal LLM-driven extraction pipeline
 * (`processPendingMessageBatchWithLLM`) and by the public write API
 * (`write-api.js`, Task 19). The function mutates `store` and returns a
 * report of which ops applied vs. which were rejected; it never throws on
 * individual op failures so a partial batch still commits as much as it can.
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
                if (Boolean(item?.hasTitlePatch)) {
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
                applied.push(item);
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

async function runExtractionForStore(context, store, {
    force = false,
    startSeq = null,
    showCompressionToast = true,
    abortSignal = null,
    onBatchStart = null,
    onBatchApplied = null,
    onCompressionApplied = null,
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
    const recentAssistantTurns = Math.max(
        1,
        Math.min(
            64,
            Math.floor(Number(settings?.recallQueryMessages || defaultSettings.recallQueryMessages || 2)),
        ),
    );
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
                recall_query_recent_messages: Math.max(1, Number(settings.recallQueryMessages || defaultSettings.recallQueryMessages || 2)),
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
        if (isAbortError(error, recallState?.abortSignal || null)) {
            throw error;
        }
        console.warn(`[${MODULE_NAME}] recall route failed`, error);
        return {
            action: 'finalize',
            selected_node_ids: recallState.candidates.map(node => node.id),
            expand_plan: [],
            referenced_always_inject_ids: [],
            reason: 'Fallback route used.',
        };
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
                recall_query_recent_messages: Math.max(1, Number(settings.recallQueryMessages || defaultSettings.recallQueryMessages || 2)),
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
        if (isAbortError(error, recallState?.abortSignal || null)) {
            throw error;
        }
        console.warn(`[${MODULE_NAME}] recall select failed`, error);
        return {
            selected_node_ids: recallState.candidates.map(node => node.id),
            reason: 'Fallback selection used.',
        };
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

function collectAlwaysInjectNodes(store, settings, context = null, options = {}) {
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
    // latestOnly types (character_sheet / location_state / thread) are
    // intentionally exempt from this filter — their picked nodes are
    // current-truth snapshots that must inject even when their seqTo overlaps
    // the raw-visible window, otherwise the main context loses authoritative
    // state.
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

    return windowed.sort(compareNodesByTimeline);
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
    // recentRawTurns governs "how many trailing assistant turns are visible as
    // raw text" — anything derived from them is redundant for the main context.
    // Use it as the snapshot offset for always-injected nodes too, instead of
    // a separate window. latestOnly types (character_sheet / location_state /
    // thread) are exempt from this offset inside collectAlwaysInjectNodes so
    // their current-truth snapshots still inject.
    //
    // The raw-visible region spans seq `[latestSeq - N + 1, latestSeq]`
    // (N seqs, inclusive on both ends — matches `isNodeInRecentExcludeWindow`
    // which uses `cutoff = latestSeq - N + 1`). `seqWindowFrom` is that lower
    // bound; collectAlwaysInjectNodes drops nodes whose seqTo lands at or
    // above it, keeping only nodes that end strictly before the raw region.
    const recentRawTurns = Math.max(0, Math.floor(Number(settings.recentRawTurns ?? defaultSettings.recentRawTurns)));
    const seqWindowFrom = recentRawTurns > 0
        ? Math.max(0, getLatestSeqIndex(store) - recentRawTurns + 1)
        : undefined;
    const alwaysInjectNodes = collectAlwaysInjectNodes(
        store,
        settings,
        context,
        seqWindowFrom !== undefined ? { seqWindowFrom } : {},
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
    const alwaysInjectNodes = collectAlwaysInjectNodes(store, settings, context);
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

async function rebuildStoreFromCurrentChat(context, { abortSignal = null, onBatchStart = null } = {}) {
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

function rebaseStoreToChatBaseline(store, context) {
    if (!store || typeof store !== 'object') {
        return;
    }
    const baselineSeq = Math.max(0, Math.floor(Number(buildPlayableFramesFromContext(context).length || 0)));
    for (const node of Object.values(store.nodes || {})) {
        if (!node || typeof node !== 'object') {
            continue;
        }
        node.seqTo = baselineSeq;
    }
    store.appliedSeqTo = baselineSeq;
    store.loggedSeqTo = baselineSeq;
    store.seqCounter = baselineSeq;
    store.lastRecallTrace = [];
    store.lastRecallProjection = null;
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

async function ensureStoreSyncedWithChat(context) {
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
        await clearAllMemoryLorebookProjection(context, settings);
        updateUiStatus(i18n('Memory disabled, cleared memory lorebook injections.'));
        return false;
    }

    const store = await ensureStoreSyncedWithChat(context);
    if (!store) {
        updateUiStatus(i18n('Memory store unavailable for current chat.'));
        return false;
    }
    throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
    const persistentSync = await syncPersistentLorebookProjection(context, settings, store);
    throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
    const corePacket = normalizeMultilineText(persistentSync.corePacket || '');
    if (isAbortSignalLike(payload?.signal) && payload.signal.aborted) {
        const chatKey = getChatKey(context);
        store.lastRecallProjection = { at: Date.now(), blocks: { corePacket, focusPacket: '' } };
        await persistRecallMetadataByChatKey(context, chatKey, {
            trace: store.lastRecallTrace,
            projection: store.lastRecallProjection,
        });
        await syncRuntimeLorebookProjection(context, settings, store);
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

    const recallMethod = String(settings.recallMethod || 'llm').trim().toLowerCase();
    // Persistent injection (alwaysInject nodes) ran above via
    // syncPersistentLorebookProjection. Collect here independently of recall
    // so __recordInjectedNodeIds publishes the real set even when recall is
    // disabled or short-circuits.
    const alwaysInjectNodes = collectAlwaysInjectNodes(store, settings, context);
    let selectedNodes = [];
    let trace = [];

    if (!settings.recallEnabled) {
        // Skip recall; fall through to clear runtime lorebook projection.
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
            try {
                await persistMemoryStoreByChatKey(context, chatKey, store, { syncPersistentProjection: false });
            } catch (persistError) {
                console.warn(`[${MODULE_NAME}] Failed to persist vectorIndexState after RAG-recall lazy sync`, persistError);
            }
        }

        let rewrittenQuery = null;
        if (settings.ragUseQueryRewrite && String(settings.ragRewriteApiPresetName || '').trim()) {
            rewrittenQuery = await runQueryRewrite(context, settings, queryBundle, {
                abortSignal: payload?.signal || null,
                recallRunToken,
            });
            throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');
        }

        const useRerank = Boolean(settings.ragUseRerank);
        const rerankProfile = useRerank ? getRerankProfileFromSettings(settings) : null;

        const ragResult = await runRagRecall(store, queryText, chatKey, settings, {
            maxResults: Number(settings.hybridMaxResults) || 15,
            vectorTopK: Number(settings.vectorTopK) || 20,
            useRerank,
            rerankProfile,
            rewrittenQuery,
            signal: payload?.signal,
        });
        throwIfRecallRunInvalid(recallRunToken, payload?.signal, 'Memory recall aborted.');

        const alwaysInjectSet = new Set(alwaysInjectNodes.map(n => n?.id).filter(Boolean));
        const latestSeqIndex = getLatestSeqIndex(store);
        const excludeMessages = Math.max(0, Number(settings.recentRawTurns ?? defaultSettings.recentRawTurns));

        selectedNodes = ragResult.candidates
            .map(c => store.nodes?.[c.nodeId])
            .filter(node => node && !node.archived && !alwaysInjectSet.has(node.id))
            .filter(node => !isNodeInRecentExcludeWindow(node, latestSeqIndex, excludeMessages))
            .sort(compareNodesByTimeline);

        trace = [{
            step: 'rag_recall',
            method: 'rag',
            meta: ragResult.meta,
            selected_ids: selectedNodes.map(n => n.id),
        }];
    } else {
        const llmResult = await runLLMDrivenRecall(context, store, payload);
        selectedNodes = llmResult.selectedNodes;
        trace = llmResult.trace;
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
                payload.__lukerRpgMemoryNeedRescan = false;
                payload.requestRescan = false;
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
                payload.__lukerRpgMemoryNeedRescan = false;
                payload.requestRescan = false;
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
                updateRuntimeInfoToastMessage(formatExtractionRangeToast(beginSeq, endSeq, latestSeq));
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
        const finalSeq = Number(preview.latestSeq || workingStore?.lastExtractionDebug?.latestSeq || 0);
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

function clipMemoryGraphText(value, maxLength = 180) {
    const text = normalizeText(value);
    if (!text) {
        return '';
    }
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function getMemoryGraphNodeSearchText(node) {
    if (!node || typeof node !== 'object') {
        return '';
    }
    const fields = node.fields && typeof node.fields === 'object' && !Array.isArray(node.fields)
        ? node.fields
        : {};
    const fieldText = Object.entries(fields)
        .map(([key, value]) => `${key} ${toDisplayScalar(value)}`)
        .filter(Boolean)
        .join(' ');
    return normalizeText([
        node.id,
        node.title,
        node.type,
        node.level,
        getNodeSummary(node),
        fieldText,
    ].filter(Boolean).join(' '));
}

function getMemoryGraphSearchModel(store, searchState = {}) {
    const allNodes = Object.values(store?.nodes || {}).sort(compareNodesByTimeline);
    const typeCounts = new Map();
    for (const node of allNodes) {
        const type = String(node?.type || '').trim() || 'unknown';
        typeCounts.set(type, Number(typeCounts.get(type) || 0) + 1);
    }

    const requestedType = String(searchState?.type || MEMORY_GRAPH_SEARCH_ALL_TYPE).trim() || MEMORY_GRAPH_SEARCH_ALL_TYPE;
    const typeFilter = requestedType === MEMORY_GRAPH_SEARCH_ALL_TYPE || typeCounts.has(requestedType)
        ? requestedType
        : MEMORY_GRAPH_SEARCH_ALL_TYPE;
    const query = normalizeText(searchState?.query || '');
    const isSearchActive = Boolean(query) || typeFilter !== MEMORY_GRAPH_SEARCH_ALL_TYPE;
    const typeFilteredNodes = typeFilter === MEMORY_GRAPH_SEARCH_ALL_TYPE
        ? allNodes
        : allNodes.filter(node => String(node?.type || '').trim() === typeFilter);

    let matchedNodes = [];
    if (isSearchActive && query) {
        const searchData = typeFilteredNodes.map(node => ({
            node,
            id: String(node?.id || ''),
            title: normalizeText(node?.title || ''),
            summary: getNodeSummary(node),
            type: String(node?.type || ''),
            body: getMemoryGraphNodeSearchText(node),
        }));
        const fuzzyResults = performFuzzySearch(
            'memory-graph-inspector',
            searchData,
            [
                { name: 'title', weight: 0.45 },
                { name: 'summary', weight: 0.25 },
                { name: 'body', weight: 0.18 },
                { name: 'id', weight: 0.08 },
                { name: 'type', weight: 0.04 },
            ],
            query,
        );
        matchedNodes = fuzzyResults.map(result => ({ node: result.item.node, score: Number(result.score ?? 0) }));
        if (!matchedNodes.length) {
            const loweredQuery = query.toLowerCase();
            matchedNodes = typeFilteredNodes
                .filter(node => getMemoryGraphNodeSearchText(node).toLowerCase().includes(loweredQuery))
                .map(node => ({ node, score: 0 }));
        }
    } else if (isSearchActive) {
        matchedNodes = typeFilteredNodes.map(node => ({ node, score: 0 }));
    }

    const matchNodeIds = matchedNodes.map(item => String(item.node?.id || '')).filter(Boolean);
    const matchNodeIdSet = new Set(matchNodeIds);
    const visibleNodes = (isSearchActive
        ? allNodes.filter(node => matchNodeIdSet.has(String(node?.id || '')))
        : allNodes)
        .slice(-220);
    const visibleEdges = Array.isArray(store?.edges)
        ? store.edges
            .map((edge, index) => ({ ...edge, _index: index }))
            .filter(edge => {
                if (!isSearchActive) {
                    return true;
                }
                return matchNodeIdSet.has(String(edge?.from || '')) || matchNodeIdSet.has(String(edge?.to || ''));
            })
            .sort((a, b) => Number(b._index || 0) - Number(a._index || 0))
            .slice(0, 160)
        : [];
    const previewNodes = matchedNodes.slice(0, MEMORY_GRAPH_SEARCH_RESULT_PREVIEW_LIMIT);
    const activeNodeId = matchNodeIdSet.has(String(searchState?.activeNodeId || ''))
        ? String(searchState.activeNodeId)
        : '';
    const summaryText = isSearchActive
        ? i18nFormat('Showing ${0} of ${1} matching nodes.', previewNodes.length, matchNodeIds.length)
        : i18n('Start typing to search the graph.');

    return {
        active: isSearchActive,
        query,
        typeFilter,
        activeNodeId,
        matchNodeIds,
        matchNodeIdSet,
        typeOptions: [
            {
                value: MEMORY_GRAPH_SEARCH_ALL_TYPE,
                label: i18n('All types'),
                count: allNodes.length,
            },
            ...[...typeCounts.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([value, count]) => ({ value, label: value, count })),
        ],
        summaryText,
        emptyText: isSearchActive ? i18n('No nodes match the current search.') : i18n('Start typing to search the graph.'),
        emptyHint: isSearchActive ? i18n('Try a different keyword or type filter.') : i18n('Select a result to focus it in graph.'),
        previewNodes,
        visibleNodes,
        visibleEdges,
    };
}

function renderGraphInspectorHtml(store, options = {}) {
    const stats = getStoreStats(store);
    const searchModel = getMemoryGraphSearchModel(store, options.searchState);
    const nodes = searchModel.visibleNodes;
    const edges = searchModel.visibleEdges;
    const activeTab = String(options.activeTab || 'graph');
    const isSearchOpen = Boolean(options.isSearchOpen);

    // --- Node table rows (desktop) ---
    const nodeTableRows = nodes.map(node => `
<tr>
<td>${escapeHtml(String(node.id || ''))}</td>
<td>${escapeHtml(String(node.type || ''))}</td>
<td>${escapeHtml(String(node.title || ''))}</td>
<td class="luker-graph-td-summary">${escapeHtml(clipMemoryGraphText(getNodeSummary(node), 120))}</td>
<td>${node.seqTo ?? ''}</td>
<td>
    <div class="luker-graph-row-actions">
        <div class="menu_button menu_button_small luker-graph-locate-node" data-node-id="${escapeHtml(node.id)}" title="${escapeHtml(i18n('Locate in Graph'))}"><i class="fa-solid fa-crosshairs fa-fw"></i></div>
        <div class="menu_button menu_button_small luker-rpg-memory-node-view" data-node-id="${escapeHtml(node.id)}" title="${escapeHtml(i18n('View'))}"><i class="fa-solid fa-eye fa-fw"></i></div>
        <div class="menu_button menu_button_small luker-rpg-memory-node-edit" data-node-id="${escapeHtml(node.id)}" title="${escapeHtml(i18n('Form Edit'))}"><i class="fa-solid fa-pen fa-fw"></i></div>
        <div class="menu_button menu_button_small luker-rpg-memory-node-delete" data-node-id="${escapeHtml(node.id)}" title="${escapeHtml(i18n('Delete'))}"><i class="fa-solid fa-trash fa-fw"></i></div>
    </div>
</td>
</tr>`).join('');

    // --- Node card list (mobile) ---
    const nodeCardList = nodes.map(node => {
        const nodeId = escapeHtml(String(node.id || ''));
        const summary = clipMemoryGraphText(getNodeSummary(node), 140);
        return `
<div class="luker-graph-card" data-node-id="${nodeId}">
    <div class="luker-graph-card-head">
        <span class="luker-graph-card-title">${escapeHtml(String(node.title || node.id || ''))}</span>
        <span class="luker-graph-card-type">${escapeHtml(String(node.type || ''))}</span>
    </div>
    <div class="luker-graph-card-meta">#${nodeId} · seq ${escapeHtml(String(node.seqTo ?? ''))}</div>
    ${summary ? `<div class="luker-graph-card-body">${escapeHtml(summary)}</div>` : ''}
    <div class="luker-graph-card-actions">
        <div class="menu_button menu_button_small luker-graph-locate-node" data-node-id="${nodeId}" title="${escapeHtml(i18n('Locate in Graph'))}"><i class="fa-solid fa-crosshairs fa-fw"></i></div>
        <div class="menu_button menu_button_small luker-rpg-memory-node-view" data-node-id="${nodeId}" title="${escapeHtml(i18n('View'))}"><i class="fa-solid fa-eye fa-fw"></i></div>
        <div class="menu_button menu_button_small luker-rpg-memory-node-edit" data-node-id="${nodeId}" title="${escapeHtml(i18n('Form Edit'))}"><i class="fa-solid fa-pen fa-fw"></i></div>
        <div class="menu_button menu_button_small luker-rpg-memory-node-delete" data-node-id="${nodeId}" title="${escapeHtml(i18n('Delete'))}"><i class="fa-solid fa-trash fa-fw"></i></div>
    </div>
</div>`;
    }).join('');

    // --- Edge table rows (desktop) ---
    const edgeTableRows = edges.map(edge => `
<tr>
<td>${escapeHtml(String(edge.from || ''))}</td>
<td>${escapeHtml(String(edge.to || ''))}</td>
<td>${escapeHtml(String(edge.type || ''))}</td>
<td>${Number(edge._index)}</td>
<td>
    <div class="luker-graph-row-actions">
        <div class="menu_button menu_button_small luker-graph-locate-edge" data-edge-index="${Number(edge._index)}" title="${escapeHtml(i18n('Locate in Graph'))}"><i class="fa-solid fa-crosshairs fa-fw"></i></div>
        <div class="menu_button menu_button_small luker-rpg-memory-edge-edit-row" data-edge-index="${Number(edge._index)}" title="${escapeHtml(i18n('Edit'))}"><i class="fa-solid fa-pen fa-fw"></i></div>
    </div>
</td>
</tr>`).join('');

    // --- Edge card list (mobile) ---
    const edgeCardList = edges.map(edge => `
<div class="luker-graph-card">
    <div class="luker-graph-card-head">
        <span class="luker-graph-card-title">${escapeHtml(String(edge.from || ''))} → ${escapeHtml(String(edge.to || ''))}</span>
        <span class="luker-graph-card-type">${escapeHtml(String(edge.type || ''))}</span>
    </div>
    <div class="luker-graph-card-meta">#${Number(edge._index)}</div>
    <div class="luker-graph-card-actions">
        <div class="menu_button menu_button_small luker-graph-locate-edge" data-edge-index="${Number(edge._index)}" title="${escapeHtml(i18n('Locate in Graph'))}"><i class="fa-solid fa-crosshairs fa-fw"></i></div>
        <div class="menu_button menu_button_small luker-rpg-memory-edge-edit-row" data-edge-index="${Number(edge._index)}" title="${escapeHtml(i18n('Edit'))}"><i class="fa-solid fa-pen fa-fw"></i></div>
    </div>
</div>`).join('');

    // --- Search filter chips ---
    const searchFilterHtml = searchModel.typeOptions.map(option => `
<button
    type="button"
    class="luker-rpg-memory-graph-search-filter${option.value === searchModel.typeFilter ? ' is-active' : ''}"
    data-search-type="${escapeHtml(option.value)}"
>
    <span>${escapeHtml(option.label)}</span>
    <span class="luker-rpg-memory-graph-search-filter-count">${option.count}</span>
</button>`).join('');

    // --- Search result cards ---
    const searchResultsHtml = searchModel.previewNodes.length > 0
        ? searchModel.previewNodes.map(item => {
            const node = item.node;
            const nodeId = String(node?.id || '');
            const summary = clipMemoryGraphText(getNodeSummary(node) || getMemoryGraphNodeSearchText(node), 160);
            return `
<div
    class="luker-rpg-memory-graph-search-result${nodeId === searchModel.activeNodeId ? ' is-active' : ''}"
    data-node-id="${escapeHtml(nodeId)}"
    role="button"
    tabindex="0"
>
    <div class="luker-rpg-memory-graph-search-result-body">
        <span class="luker-rpg-memory-graph-search-result-topline">
            <span class="luker-rpg-memory-graph-search-result-title">${escapeHtml(String(node?.title || nodeId || ''))}</span>
            <span class="luker-rpg-memory-graph-search-result-type">${escapeHtml(String(node?.type || 'unknown'))}</span>
        </span>
        <span class="luker-rpg-memory-graph-search-result-meta">#${escapeHtml(nodeId)} · seq ${escapeHtml(String(node?.seqTo ?? ''))}</span>
        <span class="luker-rpg-memory-graph-search-result-summary">${escapeHtml(summary || String(node?.type || ''))}</span>
    </div>
    <div class="luker-rpg-memory-graph-search-result-actions">
        <div class="menu_button menu_button_small luker-graph-locate-node luker-rpg-memory-graph-search-result-action" data-node-id="${escapeHtml(nodeId)}" title="${escapeHtml(i18n('Locate in Graph'))}"><i class="fa-solid fa-crosshairs fa-fw"></i></div>
        <div class="menu_button menu_button_small luker-rpg-memory-node-view luker-rpg-memory-graph-search-result-action" data-node-id="${escapeHtml(nodeId)}" title="${escapeHtml(i18n('View'))}"><i class="fa-solid fa-eye fa-fw"></i></div>
        <div class="menu_button menu_button_small luker-rpg-memory-node-edit luker-rpg-memory-graph-search-result-action" data-node-id="${escapeHtml(nodeId)}" title="${escapeHtml(i18n('Form Edit'))}"><i class="fa-solid fa-pen fa-fw"></i></div>
        <div class="menu_button menu_button_small luker-rpg-memory-node-delete luker-rpg-memory-graph-search-result-action" data-node-id="${escapeHtml(nodeId)}" title="${escapeHtml(i18n('Delete'))}"><i class="fa-solid fa-trash fa-fw"></i></div>
    </div>
</div>`;
        }).join('')
        : `
<div class="luker-rpg-memory-graph-search-empty">
    <div>${escapeHtml(searchModel.emptyText)}</div>
    <small>${escapeHtml(searchModel.emptyHint)}</small>
</div>`;

    // --- Tab helper ---
    const tabClass = (name) => `luker-graph-tab${activeTab === name ? ' is-active' : ''}`;
    const panelClass = (name) => `luker-graph-tab-panel${activeTab === name ? ' is-active' : ''}`;

    return `
<div class="luker-rpg-memory-graph-popup-inner">
    <!-- HEADER -->
    <div class="luker-graph-header">
        <div class="luker-graph-header-left">
            <h3 class="luker-graph-title">${escapeHtml(i18n('Memory Graph'))}</h3>
            <div class="luker-graph-stats">
                <span class="luker-graph-stat">${escapeHtml(i18n('Nodes'))} <b>${stats.nodeCount}</b></span>
                <span class="luker-graph-stat">${escapeHtml(i18n('Edges'))} <b>${stats.edgeCount}</b></span>
                <span class="luker-graph-stat">${escapeHtml(i18n('Turns'))} <b>${stats.messageCount}</b></span>
                <span class="luker-graph-stat">${escapeHtml(i18n('Recall'))} <b>${stats.lastRecallSteps}</b></span>
            </div>
        </div>
        <button type="button" class="luker-graph-search-toggle${isSearchOpen ? ' is-active' : ''}" title="${escapeHtml(i18n('Search'))}">
            <i class="fa-solid fa-magnifying-glass"></i>
        </button>
    </div>

    <!-- SEARCH (collapsible) -->
    <div class="luker-graph-search-collapsible${isSearchOpen ? ' is-open' : ''}">
        <div class="luker-rpg-memory-graph-search-shell">
            <div class="luker-rpg-memory-graph-search-head">
                <label class="luker-rpg-memory-graph-search-input-wrap">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input
                        type="search"
                        class="text_pole luker-rpg-memory-graph-search-input"
                        placeholder="${escapeHtml(i18n('Search nodes, summaries, IDs...'))}"
                        value="${escapeHtml(searchModel.query)}"
                    />
                </label>
                <div class="luker-rpg-memory-graph-search-actions">
                    <button type="button" class="menu_button menu_button_small luker-rpg-memory-graph-search-prev"${searchModel.matchNodeIds.length > 1 ? '' : ' disabled'} title="${escapeHtml(i18n('Prev Result'))}"><i class="fa-solid fa-chevron-up fa-fw"></i></button>
                    <button type="button" class="menu_button menu_button_small luker-rpg-memory-graph-search-next"${searchModel.matchNodeIds.length > 1 ? '' : ' disabled'} title="${escapeHtml(i18n('Next Result'))}"><i class="fa-solid fa-chevron-down fa-fw"></i></button>
                    <button type="button" class="menu_button menu_button_small luker-rpg-memory-graph-search-clear"${searchModel.active ? '' : ' disabled'} title="${escapeHtml(i18n('Clear Search'))}"><i class="fa-solid fa-xmark fa-fw"></i></button>
                </div>
            </div>
            <div class="luker-rpg-memory-graph-search-meta">
                <div class="luker-rpg-memory-graph-search-filters">${searchFilterHtml}</div>
                <small class="luker-rpg-memory-graph-search-summary">${escapeHtml(searchModel.summaryText)}</small>
            </div>
            <div class="luker-rpg-memory-graph-search-results">${searchResultsHtml}</div>
        </div>
    </div>

    <!-- TAB BAR -->
    <div class="luker-graph-tab-bar">
        <button type="button" class="${tabClass('graph')}" data-tab="graph"><i class="fa-solid fa-diagram-project fa-fw"></i><span>${escapeHtml(i18n('Graph'))}</span></button>
        <button type="button" class="${tabClass('nodes')}" data-tab="nodes"><i class="fa-solid fa-circle-nodes fa-fw"></i><span>${escapeHtml(i18n('Nodes'))}</span></button>
        <button type="button" class="${tabClass('edges')}" data-tab="edges"><i class="fa-solid fa-arrows-left-right fa-fw"></i><span>${escapeHtml(i18n('Edges'))}</span></button>
        <button type="button" class="${tabClass('recall')}" data-tab="recall"><i class="fa-solid fa-file-lines fa-fw"></i><span>${escapeHtml(i18n('Recall'))}</span></button>
    </div>

    <!-- TAB: Graph -->
    <div class="${panelClass('graph')}" data-panel="graph">
        <div class="luker-rpg-memory-graph-workspace">
            <div class="luker-rpg-memory-graph-canvas-wrap">
                <div class="luker-rpg-memory-graph-cy"></div>
                <div class="luker-graph-canvas-toolbar">
                    <div class="menu_button menu_button_small luker-rpg-memory-graph-fit" title="${escapeHtml(i18n('Fit View'))}"><i class="fa-solid fa-expand fa-fw"></i></div>
                    <div class="menu_button menu_button_small luker-rpg-memory-edge-add" title="${escapeHtml(i18n('Add Edge'))}"><i class="fa-solid fa-plus fa-fw"></i></div>
                    <div class="menu_button menu_button_small luker-rpg-memory-edge-edit" title="${escapeHtml(i18n('Edit Selected Edge'))}"><i class="fa-solid fa-pen fa-fw"></i></div>
                    <div class="menu_button menu_button_small luker-rpg-memory-node-delete" title="${escapeHtml(i18n('Delete Selected Node'))}"><i class="fa-solid fa-trash fa-fw"></i></div>
                    <div class="menu_button menu_button_small luker-rpg-memory-edge-delete" title="${escapeHtml(i18n('Delete Selected Edge'))}"><i class="fa-solid fa-link-slash fa-fw"></i></div>
                    <div class="menu_button menu_button_small luker-rpg-memory-graph-raw-view" title="${escapeHtml(i18n('JSON View'))}"><i class="fa-solid fa-code fa-fw"></i></div>
                    <div class="menu_button menu_button_small luker-rpg-memory-graph-raw-edit" title="${escapeHtml(i18n('JSON Edit'))}"><i class="fa-solid fa-file-code fa-fw"></i></div>
                </div>
                <small class="luker-rpg-memory-graph-selection">${escapeHtml(i18n('Click a node or edge to inspect.'))}</small>
            </div>
            <div class="luker-rpg-memory-graph-sidepanel">
                <div class="luker-graph-inspector-header">
                    <h4 class="margin0">${escapeHtml(i18n('Inspector'))}</h4>
                    <button type="button" class="luker-graph-inspector-toggle" title="${escapeHtml(i18n('Toggle Inspector'))}"><i class="fa-solid fa-chevron-down fa-fw"></i></button>
                </div>
                <small class="luker-rpg-memory-graph-sidehint">${escapeHtml(i18n('Select a node or edge to edit.'))}</small>
                <div class="luker-rpg-memory-graph-editor-slot"></div>
            </div>
        </div>
    </div>

    <!-- TAB: Nodes -->
    <div class="${panelClass('nodes')}" data-panel="nodes">
        <div class="luker-rpg-memory-graph-table-wrap luker-graph-desktop-only">
            <table class="table luker-graph-table">
                <thead><tr><th>${escapeHtml(i18n('ID'))}</th><th>${escapeHtml(i18n('Type'))}</th><th>${escapeHtml(i18n('Title'))}</th><th>${escapeHtml(i18n('Summary'))}</th><th>${escapeHtml(i18n('Seq'))}</th><th>${escapeHtml(i18n('Actions'))}</th></tr></thead>
                <tbody>${nodeTableRows}</tbody>
            </table>
        </div>
        <div class="luker-graph-card-list luker-graph-mobile-only">${nodeCardList}</div>
    </div>

    <!-- TAB: Edges -->
    <div class="${panelClass('edges')}" data-panel="edges">
        <div class="luker-graph-edges-toolbar">
            <div class="menu_button menu_button_small luker-rpg-memory-edge-add" title="${escapeHtml(i18n('Add Edge'))}"><i class="fa-solid fa-plus fa-fw"></i> ${escapeHtml(i18n('Add Edge'))}</div>
        </div>
        <div class="luker-rpg-memory-graph-table-wrap luker-graph-desktop-only">
            <table class="table luker-graph-table">
                <thead><tr><th>${escapeHtml(i18n('From'))}</th><th>${escapeHtml(i18n('To'))}</th><th>${escapeHtml(i18n('Type'))}</th><th>${escapeHtml(i18n('ID'))}</th><th>${escapeHtml(i18n('Actions'))}</th></tr></thead>
                <tbody>${edgeTableRows}</tbody>
            </table>
        </div>
        <div class="luker-graph-card-list luker-graph-mobile-only">${edgeCardList}</div>
    </div>

    <!-- TAB: Recall -->
    <div class="${panelClass('recall')}" data-panel="recall">
        ${buildLastRecallCorePacketHtml(store, { showHeader: true })}
    </div>
</div>`;
}

function parseOptionalNumber(value) {
    const text = String(value ?? '').trim();
    if (!text.length) {
        return undefined;
    }
    const number = Number(text);
    return Number.isFinite(number) ? number : undefined;
}

function parseLooseScalar(value) {
    const text = String(value ?? '').trim();
    if (!text.length) {
        return '';
    }
    const lower = text.toLowerCase();
    if (lower === 'true') {
        return true;
    }
    if (lower === 'false') {
        return false;
    }
    if (lower === 'null') {
        return null;
    }
    if (lower === 'undefined') {
        return '';
    }
    const number = Number(text);
    if (Number.isFinite(number) && /^[-+]?\d+(\.\d+)?$/.test(text)) {
        return number;
    }
    return text;
}

function getLastRecallProjection(store) {
    return store?.lastRecallProjection && typeof store.lastRecallProjection === 'object'
        ? store.lastRecallProjection
        : null;
}

function getLastRecallCorePacketText(store) {
    const projection = getLastRecallProjection(store);
    if (!projection) {
        return '';
    }
    const corePacket = normalizeMultilineText(projection?.blocks?.corePacket || '');
    const focusPacket = normalizeMultilineText(projection?.blocks?.focusPacket || '');
    const sections = [];
    if (corePacket) {
        sections.push(`[CORE_PACKET]\n${corePacket}`);
    }
    if (focusPacket) {
        sections.push(`[FOCUS_PACKET]\n${focusPacket}`);
    }
    return sections.join('\n\n');
}

function parseMarkdownTableToHtml(mdTable) {
    const lines = String(mdTable || '').split('\n').filter(l => l.trim());
    if (lines.length < 2) {
        return '';
    }
    const parseLine = (line) => {
        const trimmed = line.trim();
        const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
        const chopped = inner.endsWith('|') ? inner.slice(0, -1) : inner;
        return chopped.split('|').map(cell => cell.trim().replaceAll('\\|', '|'));
    };
    const headers = parseLine(lines[0]);
    if (headers.length === 0) {
        return '';
    }
    const sepLine = lines[1].trim();
    const startIdx = /^\|?\s*-{2,}/.test(sepLine) ? 2 : 1;
    const dataRows = lines.slice(startIdx).map(parseLine);
    if (dataRows.length === 0) {
        return '';
    }
    const thCells = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
    const bodyRows = dataRows.map(row => {
        const cells = headers.map((_, i) => {
            const val = row[i] ?? '';
            const cls = val.length > 60 ? 'luker-injection-cell-wrap' : 'luker-injection-cell-tight';
            return `<td class="${cls}">${escapeHtml(val)}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
    }).join('');
    return `<table class="luker-injection-table"><thead><tr>${thCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

function renderPacketSectionsAsHtml(packetText) {
    if (!packetText || !packetText.trim()) {
        return '';
    }
    const sectionRegex = /\[Table:\s*(.+?)\]\s*\n((?:(?!\[Table:)[\s\S])*)/g;
    const sections = [];
    let match;
    while ((match = sectionRegex.exec(packetText)) !== null) {
        sections.push({ title: match[1].trim(), body: match[2].trim() });
    }
    if (sections.length === 0) {
        return `<pre class="luker-injection-rawpre">${escapeHtml(packetText)}</pre>`;
    }
    return sections.map(section => {
        const tableHtml = parseMarkdownTableToHtml(section.body);
        const content = tableHtml || `<pre class="luker-injection-rawpre">${escapeHtml(section.body)}</pre>`;
        return `<div class="luker-injection-section">
    <div class="luker-injection-section-head">
        <span class="luker-injection-section-title">${escapeHtml(section.title)}</span>
    </div>
    <div class="luker-injection-section-body">${content}</div>
</div>`;
    }).join('');
}

function buildLastRecallCorePacketHtml(store, options = {}) {
    const projection = getLastRecallProjection(store);
    const showHeader = options?.showHeader !== false;
    const headerLabel = escapeHtml(i18n('Injection Content'));

    if (!projection) {
        return `
<div class="luker-injection-shell">
    ${showHeader ? `<div class="luker-injection-header"><div class="luker-injection-title">${headerLabel}</div></div>` : ''}
    <div class="luker-injection-empty">${escapeHtml(i18n('No recall injection result yet.'))}</div>
</div>`;
    }

    const at = Number(projection?.at);
    const renderedAt = Number.isFinite(at) ? new Date(at).toLocaleString() : '';
    const corePacket = normalizeMultilineText(projection?.blocks?.corePacket || '');
    const focusPacket = normalizeMultilineText(projection?.blocks?.focusPacket || '');

    const headerHtml = showHeader
        ? `
<div class="luker-injection-header">
    <div class="luker-injection-title">${headerLabel}</div>
    ${renderedAt ? `<div class="luker-injection-time"><i class="fa-regular fa-clock"></i> ${escapeHtml(renderedAt)}</div>` : ''}
    <div class="luker-injection-header-actions">
        <button type="button" class="menu_button menu_button_small luker-injection-copy-all" title="${escapeHtml(i18n('Copy'))}"><i class="fa-solid fa-copy fa-fw"></i></button>
    </div>
</div>`
        : '';

    if (!corePacket && !focusPacket) {
        return `
<div class="luker-injection-shell">
    ${headerHtml}
    <div class="luker-injection-empty">${escapeHtml(i18n('Injection content is empty.'))}</div>
</div>`;
    }

    const buildBlock = (label, packet, variant) => {
        if (!packet) return '';
        return `
<section class="luker-injection-block luker-injection-block-${variant}" data-variant="${variant}">
    <header class="luker-injection-block-head">
        <span class="luker-injection-block-badge">${escapeHtml(label)}</span>
        <button type="button" class="menu_button menu_button_small luker-injection-view-source" data-variant="${variant}" title="${escapeHtml(i18n('View Source'))}"><i class="fa-solid fa-code fa-fw"></i></button>
        <button type="button" class="menu_button menu_button_small luker-injection-copy-block" data-variant="${variant}" title="${escapeHtml(i18n('Copy'))}"><i class="fa-solid fa-copy fa-fw"></i></button>
    </header>
    <textarea class="luker-injection-block-source" data-variant="${variant}" readonly hidden>${escapeHtml(packet)}</textarea>
    <div class="luker-injection-block-body">${renderPacketSectionsAsHtml(packet)}</div>
</section>`;
    };

    const blocksHtml = [
        buildBlock('CORE', corePacket, 'core'),
        buildBlock('FOCUS', focusPacket, 'focus'),
    ].filter(Boolean).join('');

    return `
<div class="luker-injection-shell">
    ${headerHtml}
    <div class="luker-injection-content">
        ${blocksHtml}
    </div>
</div>`;
}

async function copyTextToClipboard(text) {
    const value = String(text ?? '');
    if (!value) return false;
    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch (_err) { /* fall through to legacy */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand && document.execCommand('copy');
        document.body.removeChild(ta);
        return Boolean(ok);
    } catch (_err) {
        return false;
    }
}

let injectionViewerBindingsInstalled = false;
function ensureInjectionViewerBindings() {
    if (injectionViewerBindingsInstalled) return;
    injectionViewerBindingsInstalled = true;
    const ns = '.luker-injection-viewer';
    jQuery(document).off(ns)
        .on(`click${ns}`, '.luker-injection-view-source', async function (event) {
            event.preventDefault();
            event.stopPropagation();
            const block = jQuery(this).closest('.luker-injection-block');
            const text = String(block.find('.luker-injection-block-source').val() || '');
            if (!text) {
                notifyInfo(i18n('Injection content is empty.'));
                return;
            }
            const variant = String(block.data('variant') || '').toUpperCase();
            const title = variant
                ? i18nFormat('${0} Injection Source', variant)
                : i18n('Injection Source');
            const ctx = getContext();
            await ctx.callGenericPopup(
                `<div class="luker-injection-source-popup">
                    <h3 class="margin0">${escapeHtml(title)}</h3>
                    <pre class="luker-injection-source-pre">${escapeHtml(text)}</pre>
                </div>`,
                ctx.POPUP_TYPE.TEXT,
                '',
                { wide: true, large: true, allowVerticalScrolling: true },
            );
        })
        .on(`click${ns}`, '.luker-injection-copy-block', async function (event) {
            event.preventDefault();
            event.stopPropagation();
            const block = jQuery(this).closest('.luker-injection-block');
            const text = String(block.find('.luker-injection-block-source').val() || '');
            const ok = await copyTextToClipboard(text);
            if (ok) {
                notifySuccess(i18n('Copied.'));
            } else {
                notifyError(i18n('Copy failed.'));
            }
        })
        .on(`click${ns}`, '.luker-injection-copy-all', async function (event) {
            event.preventDefault();
            event.stopPropagation();
            const shell = jQuery(this).closest('.luker-injection-shell');
            const parts = [];
            shell.find('.luker-injection-block').each(function () {
                const variant = String(jQuery(this).data('variant') || '').toUpperCase();
                const text = String(jQuery(this).find('.luker-injection-block-source').val() || '').trim();
                if (!text) return;
                parts.push(variant ? `[${variant}_PACKET]\n${text}` : text);
            });
            const all = parts.join('\n\n');
            if (!all) {
                notifyInfo(i18n('Injection content is empty.'));
                return;
            }
            const ok = await copyTextToClipboard(all);
            if (ok) {
                notifySuccess(i18n('Copied.'));
            } else {
                notifyError(i18n('Copy failed.'));
            }
        });
}

function encodeFieldsAsLines(fields) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        return '';
    }
    return Object.entries(fields)
        .filter(([key]) => String(key || '').trim().toLowerCase() !== 'summary')
        .map(([key, value]) => {
            let encoded = value;
            if (value && typeof value === 'object') {
                encoded = JSON.stringify(value);
            }
            return `${key}=${String(encoded ?? '')}`;
        })
        .join('\n');
}

function decodeFieldsFromLines(text) {
    const out = {};
    for (const rawLine of String(text || '').split('\n')) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        const sep = line.indexOf('=');
        if (sep <= 0) {
            continue;
        }
        const key = line.slice(0, sep).trim();
        const valueRaw = line.slice(sep + 1).trim();
        if (!key) {
            continue;
        }
        if ((valueRaw.startsWith('{') && valueRaw.endsWith('}')) || (valueRaw.startsWith('[') && valueRaw.endsWith(']'))) {
            try {
                out[key] = JSON.parse(valueRaw);
                continue;
            } catch {
                // scalar parsing below
            }
        }
        out[key] = parseLooseScalar(valueRaw);
    }
    return out;
}

function getNodeTypeOptionsHtml(settings, store, currentType = '') {
    const candidates = new Set();
    for (const entry of getEffectiveNodeTypeSchema(null, settings)) {
        candidates.add(String(entry.id || '').trim());
    }
    for (const node of Object.values(store.nodes || {})) {
        const type = String(node?.type || '').trim();
        if (type) {
            candidates.add(type);
        }
    }
    const selected = String(currentType || '').trim();
    if (selected) {
        candidates.add(selected);
    }
    return [...candidates]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
        .map(type => `<option value="${escapeHtml(type)}"${type === selected ? ' selected' : ''}>${escapeHtml(type)}</option>`)
        .join('');
}

function getNodeParentOptionsHtml(store, selfId, selectedParentId = '') {
    const selected = String(selectedParentId || '').trim();
    const options = [`<option value="">${escapeHtml(i18n('(none)'))}</option>`];
    const nodes = Object.values(store.nodes || {})
        .filter(node => node && String(node.id || '') !== String(selfId || ''))
        .sort(compareNodesByTimeline);
    for (const node of nodes) {
        const id = String(node.id || '');
        const title = String(node.title || '').trim();
        const label = `${id} | ${node.level}/${node.type} | ${title}`;
        options.push(`<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`);
    }
    if (selected && !nodes.find(node => String(node.id || '') === selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function renderNodeFormEditorHtml(node, store, settings, editorId) {
    const levelOptions = [LEVEL.SEMANTIC]
        .map(level => `<option value="${level}"${String(node.level || '') === level ? ' selected' : ''}>${level}</option>`).join('');

    return `
<div id="${editorId}" class="flex-container flexFlowColumn luker-rpg-memory-node-form">
    <small style="opacity:0.85">${escapeHtml(i18n('Form editor for one node. Parent/child relationships and graph persistence are applied automatically.'))}</small>
    <div class="luker-rpg-memory-node-form-grid">
        <label>${escapeHtml(i18n('Node ID'))}
            <input data-field="id" class="text_pole" type="text" value="${escapeHtml(node.id)}" readonly />
        </label>
        <label>${escapeHtml(i18n('Parent Node'))}
            <select data-field="parentId" class="text_pole">${getNodeParentOptionsHtml(store, node.id, node.parentId || '')}</select>
        </label>
        <label>${escapeHtml(i18n('Type'))}
            <select data-field="type" class="text_pole">${getNodeTypeOptionsHtml(settings, store, node.type || '')}</select>
        </label>
        <label>${escapeHtml(i18n('Level'))}
            <select data-field="level" class="text_pole">${levelOptions}</select>
        </label>
        <label>${escapeHtml(i18n('Sequence'))}
            <input data-field="seqTo" class="text_pole" type="number" step="1" value="${escapeHtml(node.seqTo ?? '')}" />
        </label>
    </div>
    <div class="luker-rpg-memory-node-form-flags">
        <label class="checkbox_label"><input data-field="archived" type="checkbox" ${node.archived ? 'checked' : ''} /> ${escapeHtml(i18n('Archived'))}</label>
    </div>
    <label>${escapeHtml(i18n('Title'))}
        <input data-field="title" class="text_pole" type="text" value="${escapeHtml(node.title || '')}" />
    </label>
    <label>${escapeHtml(i18n('Summary'))}
        <textarea data-field="summary" class="text_pole textarea_compact" rows="3">${escapeHtml(getNodeSummary(node))}</textarea>
    </label>
    <label>${escapeHtml(i18n('Fields (one key=value per line)'))}
        <textarea data-field="fieldsLines" class="text_pole textarea_compact" rows="6">${escapeHtml(encodeFieldsAsLines(node.fields || {}))}</textarea>
    </label>
</div>`;
}

function willCreateParentCycle(store, nodeId, parentId) {
    const childId = String(nodeId || '').trim();
    let current = String(parentId || '').trim();
    if (!childId || !current) {
        return false;
    }

    let guard = 0;
    while (current && guard < 3000) {
        if (current === childId) {
            return true;
        }
        const node = store.nodes?.[current];
        current = String(node?.parentId || '').trim();
        guard += 1;
    }
    return false;
}

async function ensureCytoscapeLoaded() {
    if (window.cytoscape) {
        return window.cytoscape;
    }
    if (cytoscapeLoadPromise) {
        return cytoscapeLoadPromise;
    }

    const scriptId = 'luker_rpg_memory_cytoscape_script';
    const src = '/lib/cytoscape.min.js';
    cytoscapeLoadPromise = new Promise((resolve, reject) => {
        // A previous failed attempt may have left a dead <script> in the DOM.
        // Its load/error events have already fired, so attaching new listeners
        // would hang forever — just drop it and start over.
        const existing = document.getElementById(scriptId);
        if (existing) {
            if (window.cytoscape) {
                resolve(window.cytoscape);
                return;
            }
            existing.remove();
        }

        // Some third-party SillyTavern extensions inject an AMD loader (RequireJS
        // or similar) at the page level. Cytoscape's UMD wrapper would then take
        // the `define([], factory)` branch instead of `window.cytoscape = factory()`,
        // and we'd never see the global. Temporarily mask the CommonJS/AMD hooks
        // around the script load so the wrapper falls through to the window branch.
        const hadModule = 'module' in window;
        const hadExports = 'exports' in window;
        const hadDefine = 'define' in window;
        const savedModule = window.module;
        const savedExports = window.exports;
        const savedDefine = window.define;
        window.module = undefined;
        window.exports = undefined;
        window.define = undefined;

        const restoreGlobals = () => {
            if (hadModule) window.module = savedModule; else delete window.module;
            if (hadExports) window.exports = savedExports; else delete window.exports;
            if (hadDefine) window.define = savedDefine; else delete window.define;
        };

        const script = document.createElement('script');
        script.id = scriptId;
        script.src = src;
        script.async = true;
        script.onload = () => {
            restoreGlobals();
            if (window.cytoscape) {
                resolve(window.cytoscape);
            } else {
                reject(new Error(`Cytoscape script loaded but did not expose window.cytoscape (page may have a CommonJS/AMD shim that intercepted the UMD wrapper)`));
            }
        };
        script.onerror = () => {
            restoreGlobals();
            reject(new Error(`Failed to load Cytoscape from ${src}`));
        };
        document.head.append(script);
    });

    try {
        return await cytoscapeLoadPromise;
    } catch (error) {
        cytoscapeLoadPromise = null;
        throw error;
    }
}

function buildGraphCytoscapeElements(store) {
    const sortedNodes = Object.values(store.nodes || {})
        .sort(compareNodesByTimeline);
    const maxVisualNodes = 450;
    const scopedNodes = sortedNodes.slice(-maxVisualNodes);
    const scopedNodeIds = new Set(scopedNodes.map(node => String(node.id || '')));
    const scopedNodeList = [...scopedNodeIds]
        .map(id => store.nodes[id])
        .filter(Boolean);
    const nodeById = new Map(scopedNodeList.map(node => [String(node.id || ''), node]));
    const timelineNodes = scopedNodeList
        .slice()
        .sort((a, b) => {
            const at = Number(a.seqTo ?? 0);
            const bt = Number(b.seqTo ?? 0);
            if (at !== bt) {
                return at - bt;
            }
            const typeCompare = String(a.type || '').localeCompare(String(b.type || ''));
            if (typeCompare !== 0) {
                return typeCompare;
            }
            return String(a.id || '').localeCompare(String(b.id || ''));
        });
    // Keep event nodes on per-depth horizontal rails (L0 at the bottom, L1/L2 rollups stacked above),
    // then fan secondary nodes into parallel lanes that clear the highest rollup tier.
    const eventDepthOf = (node) => {
        const raw = Number(node?.semanticDepth);
        return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
    };
    const eventNodesScoped = timelineNodes.filter(node => String(node.type || '').trim() === 'event');
    const eventsByDepth = new Map();
    for (const ev of eventNodesScoped) {
        const d = eventDepthOf(ev);
        if (!eventsByDepth.has(d)) {
            eventsByDepth.set(d, []);
        }
        eventsByDepth.get(d).push(ev);
    }
    const compareEventsForRail = (a, b) => {
        const at = Number(a?.seqTo ?? 0);
        const bt = Number(b?.seqTo ?? 0);
        if (at !== bt) {
            return at - bt;
        }
        return String(a?.id || '').localeCompare(String(b?.id || ''));
    };
    for (const tier of eventsByDepth.values()) {
        tier.sort(compareEventsForRail);
    }
    const eventDepths = [...eventsByDepth.keys()].sort((a, b) => a - b);
    const primaryEventDepth = eventDepths.length > 0 ? eventDepths[0] : 0;
    const maxEventDepth = eventDepths.length > 0 ? eventDepths[eventDepths.length - 1] : 0;
    const primaryEventTier = eventsByDepth.get(primaryEventDepth) || [];
    const primaryRailNodes = primaryEventTier.length > 0 ? primaryEventTier : timelineNodes;
    const railIndexByNodeId = new Map();
    primaryRailNodes.forEach((node, index) => {
        railIndexByNodeId.set(String(node.id || ''), index);
    });

    const preferredTypeOrder = ['event', 'character_sheet', 'location_state', 'rule_constraint'];
    const typeRank = new Map(preferredTypeOrder.map((type, index) => [type, index]));
    const types = [...new Set(scopedNodeList.map(node => String(node.type || 'unknown').trim() || 'unknown'))]
        .sort((a, b) => {
            const ar = typeRank.has(a) ? Number(typeRank.get(a)) : 999;
            const br = typeRank.has(b) ? Number(typeRank.get(b)) : 999;
            if (ar !== br) {
                return ar - br;
            }
            return a.localeCompare(b);
        });

    const secondaryTypes = types.filter(type => type !== 'event');
    const preferredLaneSlots = new Map([
        ['character_sheet', { side: -1, depth: 0 }],
        ['location_state', { side: 1, depth: 0 }],
        ['rule_constraint', { side: 1, depth: 1 }],
    ]);
    const laneSlotByType = new Map([['event', { side: 0, depth: 0 }]]);
    let fallbackLaneIndex = 0;
    for (const type of secondaryTypes) {
        if (preferredLaneSlots.has(type)) {
            laneSlotByType.set(type, preferredLaneSlots.get(type));
            continue;
        }
        const depth = 1 + Math.floor((fallbackLaneIndex + 1) / 2);
        const side = fallbackLaneIndex % 2 === 0 ? -1 : 1;
        laneSlotByType.set(type, { side, depth });
        fallbackLaneIndex += 1;
    }

    const railCount = Math.max(1, primaryRailNodes.length);
    const colGap = railCount <= 8 ? 250 : railCount <= 16 ? 220 : railCount <= 28 ? 184 : 152;
    const railCenter = (railCount - 1) / 2;
    const laneBaseOffset = 220;
    const laneDepthGap = 170;
    const laneFanX = railCount <= 10 ? 92 : railCount <= 24 ? 76 : 64;
    const laneFanY = 60;
    // Vertical spacing between event compression tiers; rollups float above the L0 rail.
    const eventLayerGap = 180;
    const rollupTierSpan = Math.max(0, (maxEventDepth - primaryEventDepth)) * eventLayerGap;
    const getRailX = (railIndex) => (railIndex - railCenter) * colGap;
    const getEventLayerY = (depth) => -(Math.max(0, Number(depth) - primaryEventDepth)) * eventLayerGap;
    const getLaneCenterY = (type) => {
        const slot = laneSlotByType.get(type) || { side: 1, depth: 1 };
        if (slot.side === 0) {
            return 0;
        }
        if (slot.side < 0) {
            // Push above-event lanes past every rollup tier so they never collide with L1/L2 rows.
            return -(rollupTierSpan + laneBaseOffset + (slot.depth * laneDepthGap));
        }
        return laneBaseOffset + (slot.depth * laneDepthGap);
    };
    const getLaneStackOffset = (index, side) => {
        if (index <= 0) {
            return { x: 0, y: 0 };
        }
        const layer = Math.floor(index / 3);
        const slot = index % 3;
        const xPattern = [0, -laneFanX, laneFanX];
        const xScale = 1 + (Math.floor(layer / 2) * 0.35);
        return {
            x: xPattern[slot] * xScale,
            y: side * layer * laneFanY,
        };
    };

    const scopedEdges = Array.isArray(store.edges)
        ? store.edges
            .map((edge, index) => ({ edge, index }))
            .filter(item => {
                const from = String(item.edge?.from || '');
                const to = String(item.edge?.to || '');
                return from && to && scopedNodeIds.has(from) && scopedNodeIds.has(to);
            })
        : [];
    const adjacency = new Map();
    const linkAdjacency = (from, to) => {
        if (!adjacency.has(from)) {
            adjacency.set(from, new Set());
        }
        adjacency.get(from).add(to);
    };
    for (const item of scopedEdges) {
        const from = String(item.edge?.from || '');
        const to = String(item.edge?.to || '');
        if (!from || !to) {
            continue;
        }
        linkAdjacency(from, to);
        linkAdjacency(to, from);
    }

    const resolveNearestRailIndex = (node) => {
        const nodeId = String(node?.id || '');
        if (railIndexByNodeId.has(nodeId)) {
            return Number(railIndexByNodeId.get(nodeId) ?? 0);
        }
        if (primaryRailNodes.length === 0) {
            return 0;
        }
        const nodeSeq = Number(node?.seqTo ?? NaN);
        let bestIndex = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        primaryRailNodes.forEach((railNode, index) => {
            const railSeq = Number(railNode?.seqTo ?? NaN);
            const distance = Number.isFinite(nodeSeq) && Number.isFinite(railSeq)
                ? Math.abs(nodeSeq - railSeq)
                : Math.abs(index - ((railCount - 1) / 2));
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = index;
            }
        });
        return bestIndex;
    };
    const directEventLinkCountByNodeId = new Map();
    const anchoredRailIndexByNodeId = new Map();
    for (const node of scopedNodeList) {
        const nodeId = String(node.id || '');
        const type = String(node.type || 'unknown').trim() || 'unknown';
        if (type === 'event' && railIndexByNodeId.has(nodeId)) {
            anchoredRailIndexByNodeId.set(nodeId, Number(railIndexByNodeId.get(nodeId) ?? 0));
            directEventLinkCountByNodeId.set(nodeId, Number.MAX_SAFE_INTEGER);
            continue;
        }

        const linkedEventIndices = new Set();
        const linkedNodeIds = adjacency.get(nodeId);
        if (linkedNodeIds) {
            for (const linkedNodeId of linkedNodeIds) {
                const linkedNode = nodeById.get(linkedNodeId);
                if (String(linkedNode?.type || '').trim() !== 'event') {
                    continue;
                }
                if (railIndexByNodeId.has(linkedNodeId)) {
                    linkedEventIndices.add(Number(railIndexByNodeId.get(linkedNodeId) ?? 0));
                }
            }
        }
        const parentId = String(node.parentId || '').trim();
        if (parentId) {
            const parentNode = nodeById.get(parentId);
            if (String(parentNode?.type || '').trim() === 'event' && railIndexByNodeId.has(parentId)) {
                linkedEventIndices.add(Number(railIndexByNodeId.get(parentId) ?? 0));
            }
        }

        const linkedIndices = [...linkedEventIndices];
        directEventLinkCountByNodeId.set(nodeId, linkedIndices.length);
        if (linkedIndices.length > 0) {
            const averageRailIndex = linkedIndices.reduce((sum, value) => sum + value, 0) / linkedIndices.length;
            anchoredRailIndexByNodeId.set(nodeId, averageRailIndex);
            continue;
        }
        anchoredRailIndexByNodeId.set(nodeId, resolveNearestRailIndex(node));
    }

    const secondaryBuckets = new Map();
    for (const node of scopedNodeList) {
        const nodeId = String(node.id || '');
        const type = String(node.type || 'unknown').trim() || 'unknown';
        if (type === 'event') {
            continue;
        }
        const anchorRailIndex = Number(anchoredRailIndexByNodeId.get(nodeId) ?? 0);
        const bucketRailIndex = Math.round(anchorRailIndex * 2) / 2;
        const bucketKey = `${type}|${bucketRailIndex}`;
        if (!secondaryBuckets.has(bucketKey)) {
            secondaryBuckets.set(bucketKey, {
                type,
                bucketRailIndex,
                nodes: [],
            });
        }
        secondaryBuckets.get(bucketKey).nodes.push(node);
    }

    const positionByNodeId = new Map();
    // Place L0 (primary) events first, then iteratively place each higher rollup tier
    // at the X-mean of its already-placed children so parent rollups float visually
    // above the events they summarize.
    for (const node of primaryEventTier) {
        const nodeId = String(node.id || '');
        const railIndex = Number(railIndexByNodeId.get(nodeId) ?? 0);
        positionByNodeId.set(nodeId, {
            x: getRailX(railIndex),
            y: getEventLayerY(primaryEventDepth),
        });
    }
    for (const depth of eventDepths) {
        if (depth === primaryEventDepth) {
            continue;
        }
        const layerY = getEventLayerY(depth);
        const tier = eventsByDepth.get(depth) || [];
        for (const node of tier) {
            const nodeId = String(node.id || '');
            const childIds = Array.isArray(node.childrenIds) ? node.childrenIds : [];
            const childPositions = childIds
                .map(cid => positionByNodeId.get(String(cid)))
                .filter(pos => pos && Number.isFinite(pos.x));
            let x;
            if (childPositions.length > 0) {
                x = childPositions.reduce((sum, p) => sum + p.x, 0) / childPositions.length;
            } else {
                const railIndex = Number(anchoredRailIndexByNodeId.get(nodeId) ?? 0);
                x = getRailX(railIndex);
            }
            positionByNodeId.set(nodeId, { x, y: layerY });
        }
    }
    for (const bucket of secondaryBuckets.values()) {
        const type = String(bucket.type || 'unknown').trim() || 'unknown';
        const laneSlot = laneSlotByType.get(type) || { side: 1, depth: 1 };
        const laneSide = laneSlot.side === 0 ? 1 : laneSlot.side;
        const baseX = getRailX(Number(bucket.bucketRailIndex || 0));
        const baseY = getLaneCenterY(type);
        bucket.nodes
            .sort((a, b) => {
                const aLinkedCount = Number(directEventLinkCountByNodeId.get(String(a.id || '')) ?? 0);
                const bLinkedCount = Number(directEventLinkCountByNodeId.get(String(b.id || '')) ?? 0);
                if (aLinkedCount !== bLinkedCount) {
                    return bLinkedCount - aLinkedCount;
                }
                const aSeq = Number(a?.seqTo ?? 0);
                const bSeq = Number(b?.seqTo ?? 0);
                if (aSeq !== bSeq) {
                    return aSeq - bSeq;
                }
                return String(a.id || '').localeCompare(String(b.id || ''));
            })
            .forEach((node, index) => {
                const offset = getLaneStackOffset(index, laneSide);
                positionByNodeId.set(String(node.id || ''), {
                    x: baseX + offset.x,
                    y: baseY + offset.y,
                });
            });
    }

    const nodes = scopedNodeList
        .map(node => {
            const isEvent = String(node.type || '').trim() === 'event';
            const depth = isEvent ? eventDepthOf(node) : -1;
            const tierLabel = isEvent
                ? `L${depth}`
                : String(node.level || '');
            const labelLine2 = `${tierLabel}${tierLabel ? '/' : ''}${String(node.type || '')}`;
            return {
                data: {
                    id: `node:${node.id}`,
                    nodeId: String(node.id),
                    label: `${String(node.title || node.id)}\n${labelLine2}`,
                    level: String(node.level || ''),
                    type: String(node.type || ''),
                    depth: String(depth),
                    archived: Boolean(node.archived),
                },
                position: positionByNodeId.get(String(node.id)) || { x: 0, y: 0 },
            };
        });

    const edges = scopedEdges
        .map(item => {
            const from = String(item.edge?.from || '');
            const to = String(item.edge?.to || '');
            const fromType = String(nodeById.get(from)?.type || '').trim();
            const toType = String(nodeById.get(to)?.type || '').trim();
            return {
                data: {
                    id: `edge:${item.index}`,
                    edgeIndex: Number(item.index),
                    source: `node:${from}`,
                    target: `node:${to}`,
                    type: String(item.edge?.type || 'related'),
                    eventBridge: (fromType === 'event') !== (toType === 'event') ? 1 : 0,
                    eventToEvent: fromType === 'event' && toType === 'event' ? 1 : 0,
                },
            };
        });

    // Tier guide labels (non-interactive) sit on the left margin of each compression row
    // so users can read off "L0 / L1 / L2" without inspecting node titles.
    const tierLabelNodes = [];
    if (eventDepths.length >= 2) {
        const labelX = getRailX(-1.6);
        for (const depth of eventDepths) {
            tierLabelNodes.push({
                data: {
                    id: `tier:${depth}`,
                    nodeId: `tier:${depth}`,
                    label: `L${depth}`,
                    tierLabel: 1,
                    type: 'tier',
                    level: '',
                    depth: String(depth),
                    archived: false,
                },
                position: { x: labelX, y: getEventLayerY(depth) },
                grabbable: false,
                selectable: false,
            });
        }
    }

    return { nodes: [...tierLabelNodes, ...nodes], edges };
}

function getEdgeNodeOptionsHtml(store, selectedNodeId = '') {
    const selected = String(selectedNodeId || '').trim();
    const options = [`<option value="">${escapeHtml(i18n('(select node)'))}</option>`];
    const nodes = Object.values(store.nodes || {})
        .sort(compareNodesByTimeline);
    for (const node of nodes) {
        const id = String(node.id || '');
        if (!id) {
            continue;
        }
        const label = `${id} | ${node.level}/${node.type} | ${(node.title || '')}`;
        options.push(`<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`);
    }
    if (selected && !nodes.find(node => String(node.id || '') === selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function getEdgeTypeOptionsHtml(store, selectedType = 'related') {
    const selected = String(selectedType || 'related').trim() || 'related';
    const presets = [...CANONICAL_EXTRACT_RELATION_TYPES, 'contains'];
    const known = new Set(presets);
    for (const edge of store.edges || []) {
        const type = String(edge?.type || '').trim();
        if (type) {
            known.add(type);
        }
    }
    known.add(selected);
    return [...known]
        .sort((a, b) => a.localeCompare(b))
        .map(type => `<option value="${escapeHtml(type)}"${type === selected ? ' selected' : ''}>${escapeHtml(type)}</option>`)
        .join('');
}

function renderEdgeFormEditorHtml(store, editorId, edge = {}, edgeIndex = -1) {
    const from = String(edge?.from || '').trim();
    const to = String(edge?.to || '').trim();
    const type = String(edge?.type || 'related').trim() || 'related';

    return `
<div id="${editorId}" class="flex-container flexFlowColumn">
    <small style="opacity:0.85">${escapeHtml(i18nFormat('Edge ${0}: configure relation between two nodes.', edgeIndex >= 0 ? `#${edgeIndex}` : i18n('(new)')))}</small>
    <div class="luker-rpg-memory-edge-form-grid">
        <label>${escapeHtml(i18n('From Node'))}
            <select data-field="from" class="text_pole">${getEdgeNodeOptionsHtml(store, from)}</select>
        </label>
        <label>${escapeHtml(i18n('To Node'))}
            <select data-field="to" class="text_pole">${getEdgeNodeOptionsHtml(store, to)}</select>
        </label>
        <label>${escapeHtml(i18n('Type'))}
            <select data-field="type" class="text_pole">${getEdgeTypeOptionsHtml(store, type)}</select>
        </label>
    </div>
</div>`;
}

async function openGraphInspectorPopup(context) {
    await ensureStoreSyncedWithChat(context);
    ensureInjectionViewerBindings();
    const chatKey = getChatKey(context);
    const store = getMemoryStore(context);
    if (!store) {
        notifyError(i18n('No active chat selected.'));
        return;
    }

    const popupId = `luker_rpg_memory_graph_popup_${Date.now()}`;
    const selector = `#${popupId}`;
    const namespace = `.lukerGraphPopup_${popupId}`;
    let cy = null;
    let selectedEdgeIndex = -1;
    let selectedNodeId = '';
    let searchQuery = '';
    let searchType = MEMORY_GRAPH_SEARCH_ALL_TYPE;
    let activeSearchNodeId = '';
    let isSearchComposing = false;
    let currentTab = 'graph';
    let isSearchOpen = false;
    let runLayout = null;
    let mountRetryTimer = null;
    const popupHtml = `<div id="${popupId}" class="luker-rpg-memory-graph-popup">${renderGraphInspectorHtml(store, {
        searchState: { query: searchQuery, type: searchType, activeNodeId: activeSearchNodeId },
        activeTab: currentTab,
        isSearchOpen,
    })}</div>`;

    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.TEXT,
        '',
        { wide: true, wider: true, large: true, allowVerticalScrolling: true, allowHorizontalScrolling: true },
    );

    const getStore = () => memoryStoreCache.get(chatKey) || store;
    const getPopupRoot = () => jQuery(selector);
    const getSearchState = () => ({
        query: searchQuery,
        type: searchType,
        activeNodeId: activeSearchNodeId,
    });
    const getSearchModel = (currentStore = getStore()) => getMemoryGraphSearchModel(currentStore, getSearchState());
    const syncSearchState = (currentStore = getStore()) => {
        const initialModel = getSearchModel(currentStore);
        if (!initialModel.active) {
            activeSearchNodeId = '';
            return initialModel;
        }
        if (selectedNodeId && initialModel.matchNodeIdSet.has(selectedNodeId)) {
            activeSearchNodeId = selectedNodeId;
            return getSearchModel(currentStore);
        }
        if (activeSearchNodeId && initialModel.matchNodeIdSet.has(activeSearchNodeId)) {
            return initialModel;
        }
        activeSearchNodeId = initialModel.matchNodeIds[0] || '';
        return getSearchModel(currentStore);
    };
    const getDefaultSelectionText = () => i18n('Click a node or edge to inspect.');
    const updateSelectionText = (text = '') => {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        popupRoot.find('.luker-rpg-memory-graph-selection').text(String(text || getDefaultSelectionText()));
    };
    const syncSearchResultSelectionUi = () => {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        popupRoot.find('.luker-rpg-memory-graph-search-result').each(function () {
            const button = jQuery(this);
            button.toggleClass('is-active', String(button.data('node-id') || '') === activeSearchNodeId);
        });
    };
    const updateInspectorPanel = () => {
        const popupRoot = getPopupRoot();
        const latest = getStore();
        if (!popupRoot.length || !latest) {
            return;
        }
        const slot = popupRoot.find('.luker-rpg-memory-graph-editor-slot');
        if (!slot.length) {
            return;
        }
        if (selectedNodeId) {
            const node = latest.nodes?.[selectedNodeId];
            if (!node) {
                slot.html(`<div class="luker-rpg-memory-graph-editor-empty">${escapeHtml(i18nFormat('Node not found: ${0}', selectedNodeId))}</div>`);
                return;
            }
            const editorId = `${popupId}_inline_node_editor`;
            slot.html(`
<div class="luker-rpg-memory-graph-editor-box">
${renderNodeFormEditorHtml(node, latest, getSettings(), editorId)}
<div class="luker-rpg-memory-graph-inline-actions">
    <div class="menu_button luker-rpg-memory-inline-node-apply">${escapeHtml(i18n('Apply Changes'))}</div>
    <div class="menu_button luker-rpg-memory-inline-node-view" data-node-id="${escapeHtml(selectedNodeId)}">${escapeHtml(i18n('View'))}</div>
    <div class="menu_button luker-rpg-memory-inline-node-delete" data-node-id="${escapeHtml(selectedNodeId)}">${escapeHtml(i18n('Delete'))}</div>
</div>
</div>`);
            return;
        }
        if (Number.isInteger(selectedEdgeIndex) && selectedEdgeIndex >= 0) {
            const edge = latest.edges?.[selectedEdgeIndex];
            if (!edge) {
                slot.html(`<div class="luker-rpg-memory-graph-editor-empty">${escapeHtml(i18nFormat('Selected edge index ${0} (missing).', selectedEdgeIndex))}</div>`);
                return;
            }
            const editorId = `${popupId}_inline_edge_editor`;
            slot.html(`
<div class="luker-rpg-memory-graph-editor-box">
${renderEdgeFormEditorHtml(latest, editorId, edge, selectedEdgeIndex)}
<div class="luker-rpg-memory-graph-inline-actions">
    <div class="menu_button luker-rpg-memory-inline-edge-apply">${escapeHtml(i18n('Apply Changes'))}</div>
    <div class="menu_button luker-rpg-memory-inline-edge-delete">${escapeHtml(i18n('Delete'))}</div>
</div>
</div>`);
            return;
        }
        slot.html(`<div class="luker-rpg-memory-graph-editor-empty">${escapeHtml(i18n('Select a node or edge to edit.'))}</div>`);
    };
    const applySearchGraphState = () => {
        if (!cy) {
            return;
        }
        const latest = getStore();
        const searchModel = syncSearchState(latest);
        cy.startBatch();
        cy.nodes().forEach(nodeElement => {
            if (Number(nodeElement.data('tierLabel')) === 1) {
                nodeElement.removeClass('luker-search-match');
                nodeElement.removeClass('luker-search-dimmed');
                return;
            }
            const nodeId = String(nodeElement.data('nodeId') || '');
            const matched = !searchModel.active || searchModel.matchNodeIdSet.has(nodeId);
            nodeElement.toggleClass('luker-search-match', searchModel.active && matched);
            nodeElement.toggleClass('luker-search-dimmed', searchModel.active && !matched);
        });
        cy.edges().forEach(edgeElement => {
            const sourceId = String(edgeElement.data('source') || '').replace(/^node:/, '');
            const targetId = String(edgeElement.data('target') || '').replace(/^node:/, '');
            const matched = !searchModel.active
                || searchModel.matchNodeIdSet.has(sourceId)
                || searchModel.matchNodeIdSet.has(targetId);
            edgeElement.toggleClass('luker-search-dimmed', searchModel.active && !matched);
        });
        cy.endBatch();
        syncSearchResultSelectionUi();
    };
    const focusNodeInGraph = (nodeId) => {
        if (!cy || !nodeId) {
            return;
        }
        const nodeElement = cy.$id(`node:${nodeId}`);
        if (!nodeElement || !nodeElement.length) {
            return;
        }
        const connectedEdges = nodeElement.connectedEdges();
        const neighborhood = nodeElement.union(connectedEdges.connectedNodes()).union(connectedEdges);
        cy.animate({
            fit: {
                eles: neighborhood.length > 1 ? neighborhood : nodeElement,
                padding: 120,
            },
            duration: 180,
        });
    };
    const selectNodeForInspection = (nodeId, { focusGraph = false } = {}) => {
        const latest = getStore();
        if (!latest?.nodes?.[nodeId]) {
            return;
        }
        selectedNodeId = nodeId;
        selectedEdgeIndex = -1;
        const searchModel = syncSearchState(latest);
        if (searchModel.matchNodeIdSet.has(nodeId)) {
            activeSearchNodeId = nodeId;
        }
        updateSelectionText(i18nFormat('Selected node: ${0}. Tip: click an edge to edit relation.', nodeId));
        updateInspectorPanel();
        if (cy) {
            cy.elements().unselect();
            const nodeElement = cy.$id(`node:${nodeId}`);
            if (nodeElement.length) {
                nodeElement.select();
            }
            applySearchGraphState();
            if (focusGraph) {
                focusNodeInGraph(nodeId);
            }
        } else {
            syncSearchResultSelectionUi();
        }
    };
    const selectEdgeForInspection = (edgeIndex, { focusGraph = false } = {}) => {
        const latest = getStore();
        const edge = latest?.edges?.[edgeIndex];
        if (!edge) {
            updateSelectionText(i18nFormat('Selected edge index ${0} (missing).', edgeIndex));
            updateInspectorPanel();
            return;
        }
        selectedEdgeIndex = edgeIndex;
        selectedNodeId = '';
        syncSearchState(latest);
        updateSelectionText(i18nFormat(
            'Selected edge #${0}: ${1} -> ${2} [${3}]',
            edgeIndex,
            edge.from,
            edge.to,
            edge.type,
        ));
        updateInspectorPanel();
        if (cy) {
            cy.elements().unselect();
            const edgeElement = cy.$id(`edge:${edgeIndex}`);
            if (edgeElement.length) {
                edgeElement.select();
                if (focusGraph) {
                    cy.animate({
                        fit: {
                            eles: edgeElement,
                            padding: 120,
                        },
                        duration: 180,
                    });
                }
            }
            applySearchGraphState();
        } else {
            syncSearchResultSelectionUi();
        }
    };
    const clearInspectorSelection = () => {
        selectedNodeId = '';
        selectedEdgeIndex = -1;
        updateSelectionText('');
        updateInspectorPanel();
        if (cy) {
            cy.elements().unselect();
            applySearchGraphState();
        } else {
            syncSearchResultSelectionUi();
        }
    };
    const persistLatest = async (latest, successText, statusText, { beforeStore = null, replaceGraph = false, seq = null } = {}) => {
        memoryStoreCache.set(chatKey, latest);
        clearRollbackHistory(chatKey);
        const effectiveSeq = Number.isFinite(Number(seq))
            ? Math.max(0, Math.floor(Number(seq)))
            : getStoreCoveredSeqTo(latest);
        const editorSaveFloor = seqToFloor(context, effectiveSeq);
        // Defaults assume "no inner commit was attempted" → treated as success
        // for the paths that don't call commitMemoryStore*ByChatKey at all.
        let innerResult = { skipped: false, reason: null, hint: null };
        if (replaceGraph) {
            innerResult = await replacePersistedGraphWithStore(context, chatKey, latest, effectiveSeq, { floor: editorSaveFloor });
        } else if (beforeStore) {
            innerResult = await appendPersistedDiffEntry(context, chatKey, beforeStore, latest, effectiveSeq, { floor: editorSaveFloor });
        }
        await persistMemoryStoreByChatKey(context, chatKey, latest, { syncPersistentProjection: true });
        refreshUiStats();
        if (statusText) {
            updateUiStatus(statusText);
        }
        if (innerResult && innerResult.skipped) {
            // Commit was silently skipped (typically VALIDATION_TARGET when
            // the user switched chats mid-edit). Surface the real reason
            // instead of firing a success toast over a write that didn't land.
            notifyError(i18nFormat('Memory save skipped: ${0}', innerResult.hint || innerResult.reason || i18n('reason unknown')));
            return;
        }
        if (successText) {
            notifySuccess(successText);
        }
    };
    const mountGraph = async () => {
        const popupRoot = getPopupRoot();
        const latest = getStore();
        if (!popupRoot.length || !latest) {
            return false;
        }
        if (cy) {
            cy.destroy();
            cy = null;
        }

        const container = popupRoot.find('.luker-rpg-memory-graph-cy').get(0);
        if (!container) {
            return false;
        }

        try {
            const cytoscape = await ensureCytoscapeLoaded();
            const elements = buildGraphCytoscapeElements(latest);
            cy = cytoscape({
                container,
                elements,
                wheelSensitivity: 0.2,
                layout: { name: 'preset', fit: true, padding: 20 },
                minZoom: 0.02,
                maxZoom: 5,
                panningEnabled: true,
                userPanningEnabled: true,
                zoomingEnabled: true,
                userZoomingEnabled: true,
                boxSelectionEnabled: false,
                style: [
                    {
                        selector: 'node',
                        style: {
                            label: 'data(label)',
                            'font-size': 12,
                            'text-wrap': 'wrap',
                            'text-max-width': 220,
                            'text-valign': 'center',
                            'text-halign': 'center',
                            color: '#f5f5f5',
                            'text-outline-width': 2,
                            'text-outline-color': '#1a1a1a',
                            'background-color': '#4f7ba7',
                            shape: 'round-rectangle',
                            width: 'label',
                            height: 'label',
                            padding: '14px',
                        },
                    },
                    { selector: 'node[level = "semantic"]', style: { 'background-color': '#3c9b7b' } },
                    {
                        selector: 'node[type = "event"]',
                        style: {
                            'background-color': '#2f74bd',
                            'border-width': 2,
                            'border-color': '#8ec6ff',
                            padding: '18px',
                            'font-size': 13,
                            'text-outline-color': '#14283d',
                        },
                    },
                    { selector: 'node[type = "event"][depth = "1"]', style: { 'background-color': '#5ba0d8', 'border-color': '#bcdfff' } },
                    { selector: 'node[type = "event"][depth = "2"]', style: { 'background-color': '#84bce3', 'border-color': '#dcefff' } },
                    { selector: 'node[type = "event"][depth = "3"]', style: { 'background-color': '#aed4ee', 'border-color': '#eef7ff' } },
                    { selector: 'node[type = "event"][depth = "4"]', style: { 'background-color': '#cde6f5', 'border-color': '#f4faff' } },
                    {
                        selector: 'node[tierLabel = 1]',
                        style: {
                            label: 'data(label)',
                            'background-opacity': 0,
                            'border-opacity': 0,
                            'text-valign': 'center',
                            'text-halign': 'center',
                            color: 'rgba(255,255,255,0.55)',
                            'font-size': 18,
                            'font-weight': 700,
                            'text-outline-color': 'rgba(0,0,0,0.6)',
                            'text-outline-width': 2,
                            width: 56,
                            height: 32,
                            events: 'no',
                            'overlay-opacity': 0,
                        },
                    },
                    { selector: 'node[type = "character_sheet"]', style: { 'background-color': '#a55c3f' } },
                    { selector: 'node[type = "location_state"]', style: { 'background-color': '#2f8c6d' } },
                    { selector: 'node[type = "rule_constraint"]', style: { 'background-color': '#8b6a24' } },
                    { selector: 'node[archived = true]', style: { opacity: 0.45 } },
                    { selector: 'node.luker-search-match', style: { 'border-width': 2, 'border-color': '#9ed8b3' } },
                    { selector: 'node.luker-search-dimmed', style: { opacity: 0.16 } },
                    {
                        selector: 'edge',
                        style: {
                            label: '',
                            'font-size': 9,
                            'curve-style': 'bezier',
                            'control-point-step-size': 30,
                            'target-arrow-shape': 'vee',
                            'target-arrow-color': '#8e95a0',
                            'line-color': '#8e95a0',
                            width: 2,
                            'line-opacity': 0.75,
                            color: '#d3d9e2',
                            'text-outline-width': 2,
                            'text-outline-color': '#20242b',
                            'text-opacity': 0,
                        },
                    },
                    {
                        selector: 'edge[eventBridge = 1]',
                        style: {
                            'curve-style': 'taxi',
                            'taxi-direction': 'vertical',
                            'taxi-turn': 34,
                            'taxi-turn-min-distance': 16,
                        },
                    },
                    {
                        selector: 'edge[eventToEvent = 1]',
                        style: {
                            'curve-style': 'bezier',
                            'control-point-step-size': 26,
                            width: 2.6,
                            'line-opacity': 0.85,
                        },
                    },
                    {
                        selector: 'edge[type = "contains"]',
                        style: {
                            'line-color': '#3fa66f',
                            'target-arrow-color': '#3fa66f',
                        },
                    },
                    {
                        selector: 'edge.luker-search-dimmed',
                        style: {
                            opacity: 0.08,
                            'line-opacity': 0.08,
                            'target-arrow-color': '#5e6772',
                            'line-color': '#5e6772',
                        },
                    },
                    {
                        selector: 'edge:selected',
                        style: {
                            label: 'data(type)',
                            'text-opacity': 1,
                            'line-color': '#ffd96c',
                            'target-arrow-color': '#ffd96c',
                            width: 4,
                        },
                    },
                    {
                        selector: ':selected',
                        style: {
                            'overlay-color': '#ffd96c',
                            'overlay-padding': 6,
                            'overlay-opacity': 0.2,
                            'border-width': 3,
                            'border-color': '#ffd96c',
                        },
                    },
                ],
            });
            const applyViewportFit = () => {
                if (!cy) {
                    return;
                }
                const nodeCount = Number(cy.nodes().length || 0);
                const padding = nodeCount <= 10 ? 20 : nodeCount <= 24 ? 32 : nodeCount <= 48 ? 48 : 64;
                const minComfortZoom = nodeCount <= 8 ? 1.2 : nodeCount <= 16 ? 1.0 : nodeCount <= 32 ? 0.85 : 0.65;
                cy.resize();
                cy.fit(cy.elements(), padding);
                if (cy.zoom() < minComfortZoom) {
                    cy.zoom(minComfortZoom);
                }
                cy.center();
            };
            runLayout = () => {
                if (!cy) {
                    return;
                }
                const current = getStore();
                const refreshed = buildGraphCytoscapeElements(current);
                const positionMap = new Map(
                    refreshed.nodes
                        .map(node => [String(node?.data?.nodeId || ''), node.position])
                        .filter(([id, pos]) => id && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)),
                );
                cy.startBatch();
                cy.nodes().forEach(node => {
                    const nodeId = String(node.data('nodeId') || '');
                    const nextPos = positionMap.get(nodeId);
                    if (nextPos) {
                        node.position(nextPos);
                    }
                });
                cy.endBatch();
                applyViewportFit();
            };
            runLayout();
            setTimeout(() => {
                applyViewportFit();
            }, 0);
            setTimeout(() => {
                applyViewportFit();
            }, 60);
            setTimeout(() => {
                applyViewportFit();
            }, 220);
            applySearchGraphState();

            cy.on('tap', 'node', (event) => {
                if (Number(event.target.data('tierLabel')) === 1) {
                    return;
                }
                const nodeId = String(event.target.data('nodeId') || '');
                selectNodeForInspection(nodeId);
            });
            cy.on('tap', 'edge', (event) => {
                const edgeIndex = Number(event.target.data('edgeIndex'));
                if (!Number.isInteger(edgeIndex) || edgeIndex < 0) {
                    return;
                }
                selectEdgeForInspection(edgeIndex);
            });
            cy.on('tap', (event) => {
                if (event.target !== cy) {
                    return;
                }
                clearInspectorSelection();
            });
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Cytoscape mount failed`, error);
            updateSelectionText(i18n('Visual graph unavailable: failed to load Cytoscape.'));
            return false;
        }
        return true;
    };
    const mountGraphWithRetry = async (attempt = 0) => {
        const mounted = await mountGraph();
        if (mounted || attempt >= 25) {
            return mounted;
        }
        if (mountRetryTimer) {
            clearTimeout(mountRetryTimer);
            mountRetryTimer = null;
        }
        await new Promise(resolve => {
            mountRetryTimer = setTimeout(resolve, 80);
        });
        mountRetryTimer = null;
        return await mountGraphWithRetry(attempt + 1);
    };
    const rerender = async () => {
        const popupRoot = jQuery(selector);
        const latest = getStore();
        if (!popupRoot.length || !latest) {
            return;
        }
        if (cy) {
            cy.destroy();
            cy = null;
        }
        syncSearchState(latest);
        popupRoot.html(renderGraphInspectorHtml(latest, {
            searchState: getSearchState(),
            activeTab: currentTab,
            isSearchOpen: isSearchOpen || Boolean(searchQuery),
        }));
        if (!latest.edges?.[selectedEdgeIndex]) {
            selectedEdgeIndex = -1;
        }
        if (!latest.nodes?.[selectedNodeId]) {
            selectedNodeId = '';
        }
        if (currentTab === 'graph') {
            await mountGraphWithRetry();
            if (cy && selectedNodeId && latest.nodes?.[selectedNodeId]) {
                cy.$id(`node:${selectedNodeId}`).select();
            } else if (cy && selectedEdgeIndex >= 0 && latest.edges?.[selectedEdgeIndex]) {
                cy.$id(`edge:${selectedEdgeIndex}`).select();
            }
            applySearchGraphState();
        }
        if (selectedNodeId && latest.nodes?.[selectedNodeId]) {
            updateSelectionText(i18nFormat('Selected node: ${0}. Tip: click an edge to edit relation.', selectedNodeId));
        } else if (selectedEdgeIndex >= 0 && latest.edges?.[selectedEdgeIndex]) {
            const edge = latest.edges[selectedEdgeIndex];
            updateSelectionText(i18nFormat(
                'Selected edge #${0}: ${1} -> ${2} [${3}]',
                selectedEdgeIndex,
                edge.from,
                edge.to,
                edge.type,
            ));
        } else {
            updateSelectionText('');
        }
        updateInspectorPanel();
    };
    const openEdgeEditor = async (edgeIndex = -1) => {
        const latest = getStore();
        if (!latest) {
            return;
        }
        const isEdit = Number.isInteger(edgeIndex) && edgeIndex >= 0;
        const sourceEdge = isEdit ? latest.edges?.[edgeIndex] : null;
        if (isEdit && !sourceEdge) {
            notifyError(i18nFormat('Edge not found: #${0}', edgeIndex));
            return;
        }
        const editorId = `luker_rpg_memory_edge_editor_${Date.now()}`;
        const editorHtml = renderEdgeFormEditorHtml(
            latest,
            editorId,
            sourceEdge || { from: '', to: '', type: 'related' },
            isEdit ? edgeIndex : -1,
        );
        let capturedValues = null;
        const result = await context.callGenericPopup(
            editorHtml,
            context.POPUP_TYPE.CONFIRM,
            '',
            {
                okButton: isEdit ? i18n('Apply Edge') : i18n('Create Edge'),
                cancelButton: i18n('Cancel'),
                wide: true,
                wider: true,
                large: false,
                allowVerticalScrolling: true,
                allowHorizontalScrolling: true,
                onClosing: (popup) => {
                    if (popup.result !== context.POPUP_RESULT.AFFIRMATIVE) {
                        return true;
                    }
                    const editorRoot = jQuery(popup.dlg).find(`#${editorId}`);
                    if (!editorRoot.length) {
                        return true;
                    }
                    capturedValues = {
                        from: String(editorRoot.find('[data-field="from"]').val() || '').trim(),
                        to: String(editorRoot.find('[data-field="to"]').val() || '').trim(),
                        type: String(editorRoot.find('[data-field="type"]').val() || 'related').trim() || 'related',
                    };
                    return true;
                },
            },
        );
        if (result !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        try {
            if (!capturedValues) {
                throw new Error(i18n('Edge form not found'));
            }
            const { from, to, type } = capturedValues;

            if (!from || !to) {
                throw new Error(i18n('From/To node is required'));
            }
            if (!latest.nodes[from] || !latest.nodes[to]) {
                throw new Error(i18n('From/To node does not exist'));
            }
            if (from === to) {
                throw new Error(i18n('From and To cannot be the same node'));
            }

            const next = {
                from,
                to,
                type,
            };
            const beforeStore = normalizeStoreForRuntime(latest);

            if (isEdit) {
                latest.edges[edgeIndex] = next;
                selectedEdgeIndex = edgeIndex;
                await persistLatest(
                    latest,
                    i18nFormat('Edge updated (#${0})', edgeIndex),
                    i18nFormat('Updated edge #${0}.', edgeIndex),
                    { beforeStore },
                );
            } else {
                latest.edges.push(next);
                selectedEdgeIndex = latest.edges.length - 1;
                await persistLatest(
                    latest,
                    i18n('Edge created.'),
                    i18nFormat('Created edge #${0}.', selectedEdgeIndex),
                    { beforeStore },
                );
            }
            await rerender();
        } catch (error) {
            notifyError(i18nFormat('Edge edit failed: ${0}', error?.message || error));
        }
    };
    const applyNodeEditorFromRoot = async (editorRoot, nodeId) => {
        const latest = getStore();
        if (!latest) {
            return;
        }
        const node = latest?.nodes?.[nodeId];
        if (!node) {
            throw new Error(i18nFormat('Node not found: ${0}', nodeId));
        }
        if (!editorRoot || !editorRoot.length) {
            throw new Error(i18n('Node form not found'));
        }
        const parsedParentId = String(editorRoot.find('[data-field="parentId"]').val() || '').trim();
        if (parsedParentId && !latest.nodes[parsedParentId]) {
            throw new Error(i18nFormat('Parent node does not exist: ${0}', parsedParentId));
        }
        if (parsedParentId === nodeId) {
            throw new Error(i18n('Parent node cannot be itself'));
        }
        if (willCreateParentCycle(latest, nodeId, parsedParentId)) {
            throw new Error(i18n('Parent selection would create a cycle'));
        }
        const beforeStore = normalizeStoreForRuntime(latest);

        const target = latest.nodes[nodeId];
        const oldParentId = String(target.parentId || '').trim();

        target.type = String(editorRoot.find('[data-field="type"]').val() || target.type || 'unknown').trim() || 'unknown';
        target.level = String(editorRoot.find('[data-field="level"]').val() || target.level || LEVEL.SEMANTIC).trim() || LEVEL.SEMANTIC;
        target.title = normalizeText(editorRoot.find('[data-field="title"]').val() || target.title || nodeId);
        target.seqTo = parseOptionalNumber(editorRoot.find('[data-field="seqTo"]').val());
        target.archived = Boolean(editorRoot.find('[data-field="archived"]').prop('checked'));
        target.fields = decodeFieldsFromLines(editorRoot.find('[data-field="fieldsLines"]').val());
        setNodeSummary(target, editorRoot.find('[data-field="summary"]').val() || '');

        if (parsedParentId !== oldParentId) {
            if (oldParentId && latest.nodes[oldParentId]) {
                const oldParent = latest.nodes[oldParentId];
                oldParent.childrenIds = (oldParent.childrenIds || []).filter(id => id !== nodeId);
            }
            if (parsedParentId && latest.nodes[parsedParentId]) {
                reparentNode(latest, nodeId, parsedParentId);
            } else {
                target.parentId = '';
            }
        } else if (parsedParentId && latest.nodes[parsedParentId]) {
            const parent = latest.nodes[parsedParentId];
            if (!Array.isArray(parent.childrenIds)) {
                parent.childrenIds = [];
            }
            if (!parent.childrenIds.includes(nodeId)) {
                parent.childrenIds.push(nodeId);
            }
        }

        selectedNodeId = nodeId;
        selectedEdgeIndex = -1;
        await persistLatest(
            latest,
            i18nFormat('Node updated: ${0}', nodeId),
            i18nFormat('Updated node ${0}.', nodeId),
            { beforeStore },
        );
        await rerender();
    };
    const applyEdgeEditorFromRoot = async (editorRoot, edgeIndex) => {
        const latest = getStore();
        if (!latest) {
            return;
        }
        const edge = latest.edges?.[edgeIndex];
        if (!edge) {
            throw new Error(i18nFormat('Edge not found: #${0}', edgeIndex));
        }
        if (!editorRoot || !editorRoot.length) {
            throw new Error(i18n('Edge form not found'));
        }
        const from = String(editorRoot.find('[data-field="from"]').val() || '').trim();
        const to = String(editorRoot.find('[data-field="to"]').val() || '').trim();
        const type = String(editorRoot.find('[data-field="type"]').val() || 'related').trim() || 'related';

        if (!from || !to) {
            throw new Error(i18n('From/To node is required'));
        }
        if (!latest.nodes[from] || !latest.nodes[to]) {
            throw new Error(i18n('From/To node does not exist'));
        }
        if (from === to) {
            throw new Error(i18n('From and To cannot be the same node'));
        }
        const beforeStore = normalizeStoreForRuntime(latest);

        latest.edges[edgeIndex] = {
            from,
            to,
            type,
        };
        selectedEdgeIndex = edgeIndex;
        selectedNodeId = '';
        await persistLatest(
            latest,
            i18nFormat('Edge updated (#${0})', edgeIndex),
            i18nFormat('Updated edge #${0}.', edgeIndex),
            { beforeStore },
        );
        await rerender();
    };
    const deleteNodeById = async (nodeIdHint = '') => {
        const latest = getStore();
        if (!latest) {
            return;
        }
        const nodeId = String(nodeIdHint || selectedNodeId || '').trim();
        if (!nodeId) {
            notifyError(i18n('No node selected. Click a node in graph first.'));
            return;
        }
        const node = latest.nodes?.[nodeId];
        if (!node) {
            notifyError(i18nFormat('Node not found: ${0}', nodeId));
            return;
        }
        const confirm = await context.callGenericPopup(
            i18nFormat(
                'Delete node ${0}: ${1}? This will remove its subtree and related edges.',
                nodeId,
                String(node.title || ''),
            ),
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: i18n('Delete'), cancelButton: i18n('Cancel') },
        );
        if (confirm !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        const beforeStore = normalizeStoreForRuntime(latest);
        dropNode(latest, nodeId, true);
        await persistLatest(
            latest,
            i18nFormat('Deleted node ${0}.', nodeId),
            i18n('Deleted selected node.'),
            { beforeStore },
        );
        selectedNodeId = '';
        if (!latest.edges?.[selectedEdgeIndex]) {
            selectedEdgeIndex = -1;
        }
        await rerender();
    };
    const applySearchControls = async ({ nextQuery = searchQuery, nextType = searchType, restoreCursor = null } = {}) => {
        searchQuery = String(nextQuery ?? '');
        searchType = String(nextType || MEMORY_GRAPH_SEARCH_ALL_TYPE).trim() || MEMORY_GRAPH_SEARCH_ALL_TYPE;
        const searchModel = syncSearchState(getStore());
        if (searchModel.active) {
            if (searchModel.matchNodeIds.length > 0) {
                selectedNodeId = activeSearchNodeId || searchModel.matchNodeIds[0];
                selectedEdgeIndex = -1;
            } else {
                selectedNodeId = '';
                selectedEdgeIndex = -1;
                activeSearchNodeId = '';
            }
        }
        await rerender();
        if (selectedNodeId) {
            focusNodeInGraph(selectedNodeId);
        }
        if (restoreCursor !== null) {
            const input = getPopupRoot().find('.luker-rpg-memory-graph-search-input').get(0);
            if (input) {
                input.focus();
                const cursor = Math.max(0, Math.min(Number(restoreCursor) || 0, String(input.value || '').length));
                if (typeof input.setSelectionRange === 'function') {
                    input.setSelectionRange(cursor, cursor);
                }
            }
        }
    };
    const stepSearchResult = (direction = 1) => {
        const searchModel = syncSearchState(getStore());
        if (!searchModel.active || searchModel.matchNodeIds.length < 1) {
            return;
        }
        const currentNodeId = searchModel.matchNodeIdSet.has(selectedNodeId)
            ? selectedNodeId
            : (searchModel.matchNodeIdSet.has(activeSearchNodeId) ? activeSearchNodeId : searchModel.matchNodeIds[0]);
        const currentIndex = Math.max(0, searchModel.matchNodeIds.indexOf(currentNodeId));
        const nextIndex = (currentIndex + direction + searchModel.matchNodeIds.length) % searchModel.matchNodeIds.length;
        activeSearchNodeId = searchModel.matchNodeIds[nextIndex];
        selectNodeForInspection(activeSearchNodeId, { focusGraph: true });
    };

    jQuery(document).off(namespace);

    // --- Tab switching ---
    const switchToTab = async (tabName) => {
        if (tabName === currentTab) {
            return;
        }
        currentTab = tabName;
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        popupRoot.find('.luker-graph-tab').each(function () {
            jQuery(this).toggleClass('is-active', String(jQuery(this).data('tab') || '') === tabName);
        });
        popupRoot.find('.luker-graph-tab-panel').each(function () {
            jQuery(this).toggleClass('is-active', String(jQuery(this).data('panel') || '') === tabName);
        });
        if (tabName === 'graph') {
            if (cy) {
                requestAnimationFrame(() => {
                    if (cy) {
                        cy.resize();
                        cy.fit(cy.elements(), 20);
                    }
                });
            } else {
                await mountGraphWithRetry();
                applySearchGraphState();
                updateInspectorPanel();
            }
        }
    };
    jQuery(document).on(`click${namespace}`, `${selector} .luker-graph-tab`, async function () {
        await switchToTab(String(jQuery(this).data('tab') || 'graph'));
    });

    // --- Locate node/edge in graph ---
    jQuery(document).on(`click${namespace}`, `${selector} .luker-graph-locate-node`, async function () {
        const nodeId = String(jQuery(this).data('node-id') || '').trim();
        if (!nodeId) return;
        await switchToTab('graph');
        selectNodeForInspection(nodeId, { focusGraph: true });
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-graph-locate-edge`, async function () {
        const edgeIndex = Number(jQuery(this).data('edge-index'));
        if (!Number.isInteger(edgeIndex) || edgeIndex < 0) return;
        await switchToTab('graph');
        selectEdgeForInspection(edgeIndex, { focusGraph: true });
    });

    // --- Search toggle ---
    jQuery(document).on(`click${namespace}`, `${selector} .luker-graph-search-toggle`, function () {
        isSearchOpen = !isSearchOpen;
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        jQuery(this).toggleClass('is-active', isSearchOpen);
        popupRoot.find('.luker-graph-search-collapsible').toggleClass('is-open', isSearchOpen);
        if (isSearchOpen) {
            const input = popupRoot.find('.luker-rpg-memory-graph-search-input');
            if (input.length) {
                input.trigger('focus');
            }
        }
    });

    // --- Inspector toggle (mobile) ---
    jQuery(document).on(`click${namespace}`, `${selector} .luker-graph-inspector-toggle`, function () {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        const panel = popupRoot.find('.luker-rpg-memory-graph-sidepanel');
        panel.toggleClass('is-collapsed');
        const icon = jQuery(this).find('i');
        if (panel.hasClass('is-collapsed')) {
            icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
        } else {
            icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
        }
    });

    jQuery(document).on(`compositionstart${namespace}`, `${selector} .luker-rpg-memory-graph-search-input`, function () {
        isSearchComposing = true;
    });
    jQuery(document).on(`compositionend${namespace}`, `${selector} .luker-rpg-memory-graph-search-input`, async function () {
        isSearchComposing = false;
        const cursor = typeof this.selectionStart === 'number' ? this.selectionStart : null;
        await applySearchControls({
            nextQuery: jQuery(this).val(),
            nextType: searchType,
            restoreCursor: cursor,
        });
    });
    jQuery(document).on(`input${namespace}`, `${selector} .luker-rpg-memory-graph-search-input`, async function (event) {
        if (isSearchComposing || this.composing || event?.originalEvent?.isComposing) {
            searchQuery = String(jQuery(this).val() || '');
            return;
        }
        const cursor = typeof this.selectionStart === 'number' ? this.selectionStart : null;
        await applySearchControls({
            nextQuery: jQuery(this).val(),
            nextType: searchType,
            restoreCursor: cursor,
        });
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-graph-search-filter`, async function () {
        await applySearchControls({
            nextQuery: searchQuery,
            nextType: String(jQuery(this).data('search-type') || MEMORY_GRAPH_SEARCH_ALL_TYPE),
        });
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-graph-search-result`, function (event) {
        // Action buttons inside the card have their own handlers; don't double-fire selection.
        if (jQuery(event.target).closest('.luker-rpg-memory-graph-search-result-action').length > 0) {
            return;
        }
        const nodeId = String(jQuery(this).data('node-id') || '').trim();
        if (!nodeId) {
            return;
        }
        activeSearchNodeId = nodeId;
        selectNodeForInspection(nodeId, { focusGraph: true });
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-graph-search-prev`, function () {
        stepSearchResult(-1);
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-graph-search-next`, function () {
        stepSearchResult(1);
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-graph-search-clear`, async function () {
        await applySearchControls({
            nextQuery: '',
            nextType: MEMORY_GRAPH_SEARCH_ALL_TYPE,
        });
        const input = getPopupRoot().find('.luker-rpg-memory-graph-search-input');
        if (input.length) {
            input.trigger('focus');
        }
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-node-view`, async function () {
        const nodeId = String(jQuery(this).data('node-id') || '').trim();
        selectNodeForInspection(nodeId);
        const latest = getStore();
        const node = latest?.nodes?.[nodeId];
        if (!node) {
            notifyError(i18nFormat('Node not found: ${0}', nodeId));
            return;
        }
        await context.callGenericPopup(
            renderNodeDetailHtml(node),
            context.POPUP_TYPE.TEXT,
            '',
            { wide: true, large: true, allowVerticalScrolling: true },
        );
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-node-edit`, async function () {
        const nodeId = String(jQuery(this).data('node-id') || '').trim();
        await switchToTab('graph');
        selectNodeForInspection(nodeId, { focusGraph: true });
        return;
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-inline-node-view`, async function () {
        const nodeId = String(jQuery(this).data('node-id') || selectedNodeId || '').trim();
        const latest = getStore();
        const node = latest?.nodes?.[nodeId];
        if (!node) {
            notifyError(i18nFormat('Node not found: ${0}', nodeId));
            return;
        }
        await context.callGenericPopup(
            renderNodeDetailHtml(node),
            context.POPUP_TYPE.TEXT,
            '',
            { wide: true, large: true, allowVerticalScrolling: true },
        );
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-inline-node-apply`, async function () {
        const nodeId = String(selectedNodeId || '').trim();
        if (!nodeId) {
            notifyError(i18n('No node selected. Click a node in graph first.'));
            return;
        }
        const editorRoot = jQuery(`#${popupId}_inline_node_editor`);
        try {
            await applyNodeEditorFromRoot(editorRoot, nodeId);
        } catch (error) {
            notifyError(i18nFormat('Node edit failed: ${0}', error?.message || error));
        }
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-inline-node-delete`, async function () {
        const nodeId = String(jQuery(this).data('node-id') || selectedNodeId || '').trim();
        await deleteNodeById(nodeId);
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-node-delete`, async function () {
        const nodeId = String(jQuery(this).data('node-id') || selectedNodeId || '').trim();
        await deleteNodeById(nodeId);
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-edge-add`, async function () {
        await openEdgeEditor(-1);
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-graph-fit`, function () {
        if (!cy) {
            return;
        }
        const nodeCount = Number(cy.nodes().length || 0);
        const padding = nodeCount <= 10 ? 20 : nodeCount <= 24 ? 32 : nodeCount <= 48 ? 48 : 64;
        const minComfortZoom = nodeCount <= 8 ? 1.2 : nodeCount <= 16 ? 1.0 : nodeCount <= 32 ? 0.85 : 0.65;
        cy.resize();
        cy.fit(cy.elements(), padding);
        if (cy.zoom() < minComfortZoom) {
            cy.zoom(minComfortZoom);
        }
        cy.center();
        updateSelectionText(i18n('Fitted graph view.'));
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-edge-edit`, async function () {
        if (!Number.isInteger(selectedEdgeIndex) || selectedEdgeIndex < 0) {
            notifyError(i18n('No edge selected. Click an edge in graph first.'));
            return;
        }
        await openEdgeEditor(selectedEdgeIndex);
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-edge-edit-row`, async function () {
        const edgeIndex = Number(jQuery(this).data('edge-index'));
        if (!Number.isInteger(edgeIndex) || edgeIndex < 0) {
            return;
        }
        await switchToTab('graph');
        selectEdgeForInspection(edgeIndex, { focusGraph: true });
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-inline-edge-apply`, async function () {
        if (!Number.isInteger(selectedEdgeIndex) || selectedEdgeIndex < 0) {
            notifyError(i18n('No edge selected. Click an edge in graph first.'));
            return;
        }
        const editorRoot = jQuery(`#${popupId}_inline_edge_editor`);
        try {
            await applyEdgeEditorFromRoot(editorRoot, selectedEdgeIndex);
        } catch (error) {
            notifyError(i18nFormat('Edge edit failed: ${0}', error?.message || error));
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-inline-edge-delete`, async function () {
        jQuery(`${selector} .luker-rpg-memory-edge-delete`).trigger('click');
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-edge-delete`, async function () {
        const latest = getStore();
        if (!latest) {
            return;
        }
        if (!Number.isInteger(selectedEdgeIndex) || selectedEdgeIndex < 0 || !latest.edges?.[selectedEdgeIndex]) {
            notifyError(i18n('No edge selected. Click an edge in graph first.'));
            return;
        }

        const edge = latest.edges[selectedEdgeIndex];
        const confirm = await context.callGenericPopup(
            i18nFormat(
                'Delete edge #${0}: ${1} -> ${2} [${3}]?',
                selectedEdgeIndex,
                escapeHtml(String(edge.from || '')),
                escapeHtml(String(edge.to || '')),
                escapeHtml(String(edge.type || '')),
            ),
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: i18n('Delete'), cancelButton: i18n('Cancel') },
        );
        if (confirm !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        const beforeStore = normalizeStoreForRuntime(latest);
        latest.edges.splice(selectedEdgeIndex, 1);
        await persistLatest(
            latest,
            i18nFormat('Deleted edge #${0}.', selectedEdgeIndex),
            i18n('Deleted selected edge.'),
            { beforeStore },
        );
        selectedEdgeIndex = -1;
        await rerender();
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-graph-raw-view`, async function () {
        const latest = getStore();
        if (!latest) {
            return;
        }
        await context.callGenericPopup(
            `<pre style="white-space:pre-wrap; max-height:72vh; overflow:auto;">${escapeHtml(JSON.stringify(latest, null, 2))}</pre>`,
            context.POPUP_TYPE.TEXT,
            '',
            { wide: true, large: true, allowVerticalScrolling: true },
        );
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-graph-raw-edit`, async function () {
        const latest = getStore();
        if (!latest) {
            return;
        }

        const editorId = `luker_rpg_memory_graph_editor_${Date.now()}`;
        const editorHtml = `
<div class="flex-container flexFlowColumn">
    <small style="opacity:0.85">${escapeHtml(i18n('Advanced: edit full memory graph JSON for current chat.'))}</small>
    <textarea id="${editorId}" class="text_pole textarea_compact" style="min-height:68vh; font-family:monospace;">${escapeHtml(JSON.stringify(latest, null, 2))}</textarea>
</div>`;

        const result = await context.callGenericPopup(
            editorHtml,
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: i18n('Apply Graph'), cancelButton: i18n('Cancel'), wide: true, large: true, allowVerticalScrolling: true },
        );
        if (result !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        try {
            const raw = String(jQuery(`#${editorId}`).val() || '').trim();
            const parsed = JSON.parse(raw);
            const migrated = normalizeStoreForRuntime(parsed);
            updateStoreSourceState(migrated, context);
            const migratedSeq = getStoreCoveredSeqTo(migrated);
            const applyResult = await replacePersistedGraphWithStore(
                context,
                chatKey,
                migrated,
                migratedSeq,
                { floor: seqToFloor(context, migratedSeq) },
            );
            clearRollbackHistory(chatKey);
            await persistMemoryStoreByChatKey(context, chatKey, migrated, { syncPersistentProjection: true });
            refreshUiStats();
            if (applyResult && applyResult.skipped) {
                notifyError(i18nFormat('Failed to apply graph JSON: ${0}', applyResult.hint || applyResult.reason || i18n('reason unknown')));
                return;
            }
            updateUiStatus(i18n('Applied raw graph JSON edit.'));
            notifySuccess(i18n('Memory graph JSON updated.'));
            selectedEdgeIndex = -1;
            await rerender();
        } catch (error) {
            notifyError(i18nFormat('Graph edit failed: ${0}', error?.message || error));
        }
    });

    await mountGraphWithRetry();
    updateInspectorPanel();
    setTimeout(() => { void mountGraphWithRetry(); }, 0);
    setTimeout(() => { void mountGraphWithRetry(); }, 180);
    try {
        await popupPromise;
    } finally {
        jQuery(document).off(namespace);
        if (cy) {
            cy.destroy();
            cy = null;
        }
        if (mountRetryTimer) {
            clearTimeout(mountRetryTimer);
            mountRetryTimer = null;
        }
    }
}

function notifySuccess(message) {
    if (typeof toastr !== 'undefined') {
        toastr.success(String(message));
    }
}

function notifyError(message) {
    if (typeof toastr !== 'undefined') {
        toastr.error(String(message));
    }
}

function notifyInfo(message) {
    if (typeof toastr !== 'undefined') {
        toastr.info(String(message));
    }
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
    if (typeof toastr === 'undefined') {
        return;
    }
    const activeRef = kind === 'recall' ? 'activeRecallToast' : 'activeExtractionToast';
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
    jQuery('#luker_rpg_memory_status').text(String(text || ''));
}

function refreshUiStats() {
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    const context = getContext();
    const chatKey = getChatKey(context);
    const store = memoryStoreCache.get(chatKey) || createEmptyStore();
    const stats = getStoreStats(store);

    root.find('#luker_rpg_memory_stats').text(
        i18nFormat(
            'nodes=${0}, edges=${1}, messages=${2}, source=${3}, semantic=${4}',
            stats.nodeCount,
            stats.edgeCount,
            stats.messageCount,
            stats.sourceMessageCount,
            stats.levelCount.semantic,
        ),
    );
}

function joinCommaList(list) {
    if (!Array.isArray(list)) {
        return '';
    }
    return list.map(item => String(item || '').trim()).filter(Boolean).join(', ');
}

function splitCommaList(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function joinKeyValueLines(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
        return '';
    }
    return Object.entries(map)
        .map(([key, value]) => `${String(key || '').trim()}=${String(value || '').trim()}`)
        .filter(line => !line.startsWith('=') && !line.endsWith('='))
        .join('\n');
}

function parseKeyValueLines(value) {
    const lines = String(value || '').split(/\r?\n/);
    const result = {};
    for (const line of lines) {
        const trimmed = String(line || '').trim();
        if (!trimmed) {
            continue;
        }
        const idx = trimmed.indexOf('=');
        if (idx <= 0) {
            continue;
        }
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!key || !val) {
            continue;
        }
        result[key] = val;
    }
    return result;
}

function getSchemaTypeTemplate(index = 1) {
    return {
        id: `custom_${index}`,
        label: `Custom Type ${index}`,
        tableName: `custom_table_${index}`,
        tableColumns: ['title'],
        level: LEVEL.SEMANTIC,
        extractHint: '',
        extractionInstructions: '',
        extractEveryN: 1,
        keywords: [],
        columnHints: {},
        requiredColumns: [],
        forceUpdate: false,
        editable: true,
        alwaysInject: false,
        latestOnly: false,
        primaryKeyColumns: [],
        compression: {
            mode: 'none',
            threshold: 6,
            fanIn: 3,
            maxDepth: 6,
            keepRecentLeaves: 0,
            summarizeInstruction: '',
        },
    };
}

function ensureStyles() {
    const existingStyle = jQuery(`#${STYLE_ID}`);
    if (existingStyle.length) {
        existingStyle.remove();
    }

    jQuery('head').append(`
<style id="${STYLE_ID}">
#${UI_BLOCK_ID} .menu_button,
#${UI_BLOCK_ID} .menu_button_small {
    width: auto;
    min-width: max-content;
    white-space: nowrap;
}
#${UI_BLOCK_ID} #luker_rpg_memory_schema_summary {
    display: block;
    margin: 4px 0 8px;
    padding: 6px 9px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.45));
    border-radius: 8px;
    background: linear-gradient(140deg, rgba(27, 43, 36, 0.2), rgba(24, 30, 44, 0.17));
    font-variant-numeric: tabular-nums;
}

.luker-rpg-schema-popup {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    text-align: left;
}

.luker-rpg-schema-popup .menu_button,
.luker-rpg-schema-popup .menu_button_small,
.luker-rpg-memory-graph-popup .menu_button,
.luker-rpg-memory-graph-popup .menu_button_small,
.luker-rpg-memory-advanced-popup .menu_button,
.luker-rpg-memory-advanced-popup .menu_button_small {
    width: auto;
    min-width: max-content;
    white-space: nowrap;
    display: inline-flex;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
}

.luker-rpg-memory-graph-popup .menu_button,
.luker-rpg-memory-graph-popup .menu_button_small {
    min-width: 0;
    white-space: normal;
}

.popup:has(.luker-rpg-memory-graph-popup) {
    width: min(96vw, 1480px) !important;
    max-width: min(96vw, 1480px) !important;
}

.popup:has(.luker-rpg-memory-graph-popup) .popup-body {
    min-height: 0;
}

.popup:has(.luker-rpg-memory-graph-popup) .popup-content {
    overflow: hidden !important;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.popup:has(.luker-rpg-memory-graph-popup) .popup-controls {
    margin-top: 6px;
}

.luker-rpg-schema-popup .luker-schema-topbar {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.45));
    border-radius: 10px;
    padding: 10px;
    background: linear-gradient(155deg, rgba(17, 47, 43, 0.25), rgba(31, 30, 44, 0.2));
}

.luker-rpg-schema-popup .luker-schema-topbar-title {
    font-weight: 700;
    letter-spacing: 0.01em;
}

.luker-rpg-schema-popup .luker-schema-topbar-note {
    opacity: 0.85;
    margin-top: 3px;
    font-size: 0.93em;
}

.luker-rpg-schema-popup .luker-schema-chip-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.luker-rpg-schema-popup .luker-schema-chip {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.45));
    border-radius: 999px;
    padding: 3px 9px;
    font-size: 0.82em;
    background: rgba(255, 255, 255, 0.05);
    white-space: nowrap;
}

.luker-rpg-schema-popup .luker-schema-chip.hier {
    border-color: rgba(69, 164, 133, 0.75);
}

.luker-rpg-schema-popup .luker-schema-chip.latest {
    border-color: rgba(68, 136, 215, 0.75);
}

.luker-rpg-schema-popup .luker-schema-chip.inject {
    border-color: rgba(194, 146, 76, 0.8);
}

.luker-rpg-schema-popup .luker-schema-editor-list {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    max-height: 65vh;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 4px;
    gap: 10px;
}

.luker-rpg-schema-popup .luker-schema-card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.42));
    border-radius: 11px;
    padding: 10px;
    background: linear-gradient(145deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015));
    box-shadow: 0 4px 12px rgba(0,0,0,0.16);
    border-left-width: 4px;
}

.luker-rpg-schema-popup .luker-schema-card.mode-none {
    border-left-color: rgba(140, 140, 140, 0.9);
}

.luker-rpg-schema-popup .luker-schema-card.mode-hierarchical {
    border-left-color: rgba(58, 173, 118, 0.95);
}

.luker-rpg-schema-popup .luker-schema-card.is-always {
    box-shadow: 0 4px 14px rgba(191, 143, 62, 0.25);
}

.luker-rpg-schema-popup .luker-schema-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 8px;
}

.luker-rpg-schema-popup .luker-schema-card-title {
    font-size: 1.02em;
    font-weight: 700;
    letter-spacing: 0.01em;
}

.luker-rpg-schema-popup .luker-schema-card-sub {
    opacity: 0.76;
    font-size: 0.86em;
}

.luker-rpg-schema-popup .luker-schema-badges {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.luker-rpg-schema-popup .luker-schema-badge {
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 0.8em;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.42));
    background: rgba(255,255,255,0.05);
}

.luker-rpg-schema-popup .luker-schema-grid-2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}

.luker-rpg-schema-popup .luker-schema-card label:not(.checkbox_label) {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    min-width: 0;
    gap: 3px;
}

.luker-rpg-schema-popup .text_pole,
.luker-rpg-schema-popup textarea,
.luker-rpg-schema-popup input:not([type="checkbox"]),
.luker-rpg-schema-popup select {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
}

.luker-rpg-schema-popup .luker-schema-card label.checkbox_label {
    display: inline-flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    min-width: 0;
    justify-content: flex-start;
}

.luker-rpg-schema-popup .luker-schema-card label.checkbox_label input[type="checkbox"] {
    width: auto;
    max-width: none;
    min-width: 0;
    margin: 0;
    align-self: center;
}

.luker-rpg-schema-popup .luker-schema-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
    margin-top: 6px;
}

.luker-rpg-schema-popup .luker-schema-footer {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    border-top: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    padding-top: 8px;
}

.luker-rpg-schema-popup .luker-schema-footer-note {
    opacity: 0.76;
    font-size: 0.86em;
}

.luker-rpg-schema-popup .luker-schema-footer-meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.luker-rpg-schema-popup .luker-schema-footer-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.luker-rpg-memory-graph-popup {
    width: min(1380px, calc(100vw - 32px));
    max-width: min(1380px, calc(100vw - 32px));
    min-width: 0;
    box-sizing: border-box;
    overflow-x: hidden;
}

.luker-rpg-memory-graph-popup-inner {
    display: flex;
    flex-direction: column;
    gap: 0;
    align-items: stretch;
    text-align: left;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    overflow-x: hidden;
    min-height: 0;
    max-height: calc(100vh - 170px);
    max-height: calc(100dvh - 170px);
}

/* --- Header --- */
.luker-graph-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 2px 10px;
}

.luker-graph-header-left {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    min-width: 0;
}

.luker-graph-title {
    margin: 0;
    font-size: 1.1em;
    font-weight: 700;
    white-space: nowrap;
}

.luker-graph-stats {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.luker-graph-stat {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.3));
    background: rgba(255, 255, 255, 0.04);
    font-size: 0.82em;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
}

.luker-graph-stat b {
    font-weight: 700;
    color: rgba(180, 220, 200, 0.95);
}

.luker-graph-search-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.3));
    background: rgba(255, 255, 255, 0.04);
    color: inherit;
    cursor: pointer;
    flex-shrink: 0;
    transition: border-color 0.15s ease, background 0.15s ease;
}

.luker-graph-search-toggle:hover {
    border-color: rgba(140, 205, 168, 0.5);
}

.luker-graph-search-toggle.is-active {
    border-color: rgba(140, 205, 168, 0.8);
    background: rgba(40, 86, 68, 0.5);
}

/* --- Search collapsible --- */
.luker-graph-search-collapsible {
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.25s ease, padding 0.25s ease;
    padding: 0;
}

.luker-graph-search-collapsible.is-open {
    flex: 1;
    min-height: 0;
    max-height: none;
    overflow: hidden;
    padding: 0 0 8px;
    display: flex;
    flex-direction: column;
}

/* When search is open, take over the popup body — hide tabs + panels so
 * results aren't visually mixed with the squeezed graph/inspector strip. */
.luker-graph-search-collapsible.is-open ~ .luker-graph-tab-bar,
.luker-graph-search-collapsible.is-open ~ .luker-graph-tab-panel {
    display: none;
}

/* --- Tab bar --- */
.luker-graph-tab-bar {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.3));
    margin-bottom: 0;
}

.luker-graph-tab {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 8px;
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 0.9em;
    opacity: 0.7;
    transition: opacity 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    white-space: nowrap;
}

.luker-graph-tab:hover {
    opacity: 0.9;
    background: rgba(255, 255, 255, 0.03);
}

.luker-graph-tab.is-active {
    opacity: 1;
    border-bottom-color: rgba(140, 205, 168, 0.85);
    background: rgba(40, 86, 68, 0.15);
}

.luker-graph-tab i {
    font-size: 1em;
}

/* --- Tab panels --- */
.luker-graph-tab-panel {
    display: none;
    flex-direction: column;
    gap: 8px;
    padding-top: 10px;
    min-height: 0;
    flex: 1;
    overflow-y: auto;
}

.luker-graph-tab-panel.is-active {
    display: flex;
}

/* --- Canvas toolbar (icon buttons) --- */
.luker-graph-canvas-toolbar {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    padding: 4px 0 2px;
}

.luker-graph-canvas-toolbar .menu_button,
.luker-graph-canvas-toolbar .menu_button_small {
    width: 34px;
    height: 34px;
    min-width: 0;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
}

/* --- Inspector header with toggle --- */
.luker-graph-inspector-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.luker-graph-inspector-toggle {
    display: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.3));
    background: transparent;
    color: inherit;
    cursor: pointer;
}

/* --- Edges toolbar --- */
.luker-graph-edges-toolbar {
    display: flex;
    gap: 6px;
    margin-bottom: 4px;
}

/* --- Row actions (icon buttons in tables) --- */
.luker-graph-row-actions {
    display: flex;
    gap: 4px;
}

.luker-graph-row-actions .menu_button,
.luker-graph-row-actions .menu_button_small {
    width: 30px;
    height: 30px;
    min-width: 0;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
}

/* --- Table styles --- */
.luker-graph-table {
    font-size: 12px;
    width: 100%;
    table-layout: fixed;
}

.luker-graph-td-summary {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* --- Card list (mobile) --- */
.luker-graph-card-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1 1 0%;
    min-height: 0;
    overflow-y: auto;
    padding: 2px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
}

.luker-graph-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.28));
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.01));
}

.luker-graph-card-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
}

.luker-graph-card-title {
    font-weight: 600;
    font-size: 0.95em;
    line-height: 1.3;
    min-width: 0;
    word-break: break-word;
    flex: 1;
}

.luker-graph-card-type {
    flex-shrink: 1;
    min-width: 0;
    font-size: 0.74em;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(83, 133, 176, 0.18);
    color: rgba(223, 239, 255, 0.96);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 50%;
}

.luker-graph-card-meta {
    font-size: 0.78em;
    opacity: 0.65;
}

.luker-graph-card-body {
    font-size: 0.88em;
    line-height: 1.4;
    opacity: 0.88;
}

.luker-graph-card-actions {
    display: flex;
    gap: 4px;
    margin-top: 2px;
}

.luker-graph-card-actions .menu_button,
.luker-graph-card-actions .menu_button_small {
    width: 30px;
    height: 30px;
    min-width: 0;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
}

/* --- Desktop/mobile visibility --- */
.luker-graph-desktop-only { display: block; }
.luker-graph-mobile-only { display: none; }

.luker-rpg-memory-graph-search-shell {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    flex: 1;
    min-height: 0;
    box-sizing: border-box;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 14px;
    padding: 10px;
    background: var(--SmartThemeBlurTintColor, rgba(20, 24, 33, 0.95));
    color: var(--SmartThemeBodyColor, inherit);
}

.luker-rpg-memory-graph-search-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
}

.luker-rpg-memory-graph-search-input-wrap {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 8px 12px;
    border-radius: 12px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(123, 163, 196, 0.28));
    background: color-mix(in srgb, var(--SmartThemeBodyColor, #888) 6%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 4%, transparent);
}

.luker-rpg-memory-graph-search-input-wrap > i {
    color: rgba(197, 229, 214, 0.92);
}

.luker-rpg-memory-graph-search-input-wrap .luker-rpg-memory-graph-search-input {
    flex: 1;
    min-width: 0;
    width: 100%;
    border: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
    padding: 0 !important;
}

.luker-rpg-memory-graph-search-input-wrap .luker-rpg-memory-graph-search-input:focus {
    outline: none;
}

.luker-rpg-memory-graph-search-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.luker-rpg-memory-graph-search-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: center;
    justify-content: space-between;
}

.luker-rpg-memory-graph-search-filters {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.luker-rpg-memory-graph-search-filter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(123, 163, 196, 0.24));
    background: color-mix(in srgb, var(--SmartThemeBodyColor, #888) 5%, transparent);
    color: inherit;
    cursor: pointer;
    transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
}

.luker-rpg-memory-graph-search-filter:hover {
    border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, rgb(140,205,168)) 60%, transparent);
    transform: translateY(-1px);
}

.luker-rpg-memory-graph-search-filter.is-active {
    border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, rgb(140,205,168)) 90%, transparent);
    background: color-mix(in srgb, var(--SmartThemeQuoteColor, rgb(140,205,168)) 22%, transparent);
    color: var(--SmartThemeBodyColor, inherit);
}

.luker-rpg-memory-graph-search-filter-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    padding: 1px 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--SmartThemeBodyColor, #888) 12%, transparent);
    font-size: 0.82em;
    opacity: 0.92;
}

.luker-rpg-memory-graph-search-summary {
    opacity: 0.82;
    font-size: 0.9em;
}

.luker-rpg-memory-graph-search-results {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 8px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    align-content: start;
    padding-right: 4px;
}

.luker-rpg-memory-graph-search-result {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    min-width: 0;
    padding: 10px;
    border-radius: 12px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(123, 163, 196, 0.22));
    background: color-mix(in srgb, var(--SmartThemeBodyColor, #888) 6%, transparent);
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}

.luker-rpg-memory-graph-search-result-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
}

.luker-rpg-memory-graph-search-result-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
    padding-top: 6px;
    border-top: 1px dashed var(--SmartThemeBorderColor, rgba(123, 163, 196, 0.22));
}

.luker-rpg-memory-graph-search-result-actions .menu_button,
.luker-rpg-memory-graph-search-result-actions .menu_button_small {
    width: 30px;
    height: 30px;
    min-width: 0;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
}

.luker-rpg-memory-graph-search-result-action {
    cursor: pointer;
}

.luker-rpg-memory-graph-search-result:hover {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, rgb(140,205,168)) 60%, transparent);
    box-shadow: 0 8px 20px var(--SmartThemeShadowColor, rgba(0, 0, 0, 0.15));
}

.luker-rpg-memory-graph-search-result.is-active {
    border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, rgb(255,217,108)) 90%, transparent);
    background: color-mix(in srgb, var(--SmartThemeQuoteColor, rgb(255,217,108)) 18%, transparent);
    box-shadow: 0 10px 24px var(--SmartThemeShadowColor, rgba(0, 0, 0, 0.22));
}

.luker-rpg-memory-graph-search-result-topline {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
}

.luker-rpg-memory-graph-search-result-title {
    font-weight: 600;
    line-height: 1.25;
}

.luker-rpg-memory-graph-search-result-type {
    flex-shrink: 0;
    font-size: 0.76em;
    padding: 3px 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--SmartThemeBodyColor, #888) 12%, transparent);
    color: var(--SmartThemeBodyColor, inherit);
    opacity: 0.9;
}

.luker-rpg-memory-graph-search-result-meta {
    font-size: 0.8em;
    opacity: 0.74;
}

.luker-rpg-memory-graph-search-result-summary {
    font-size: 0.9em;
    line-height: 1.4;
    opacity: 0.92;
}

.luker-rpg-memory-graph-search-empty {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px;
    border-radius: 12px;
    border: 1px dashed var(--SmartThemeBorderColor, rgba(123, 163, 196, 0.24));
    background: color-mix(in srgb, var(--SmartThemeBodyColor, #888) 4%, transparent);
    opacity: 0.86;
}

.luker-rpg-memory-graph-workspace {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
    gap: 10px;
    align-items: stretch;
    width: 100%;
    max-width: 100%;
    min-width: 0;
}

.luker-rpg-memory-graph-canvas-wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 10px;
    background: radial-gradient(circle at 20% 20%, rgba(70, 104, 138, 0.2), rgba(21, 24, 31, 0.25));
    padding: 6px;
}

.luker-rpg-memory-graph-cy {
    width: 100%;
    height: min(58vh, 580px);
    height: min(58dvh, 580px);
    border-radius: 8px;
    background: rgba(10, 12, 16, 0.5);
    cursor: grab;
}

.luker-rpg-memory-graph-selection {
    display: block;
    opacity: 0.9;
    font-size: 0.9em;
}

.luker-rpg-memory-graph-sidepanel {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 10px;
    background: linear-gradient(150deg, rgba(30, 35, 47, 0.35), rgba(12, 14, 20, 0.4));
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: min(58vh, 580px);
    max-height: min(58dvh, 580px);
    overflow: auto;
}

.luker-rpg-memory-graph-sidehint {
    opacity: 0.8;
    font-size: 0.88em;
}

.luker-rpg-memory-graph-editor-slot {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.luker-rpg-memory-graph-editor-empty {
    opacity: 0.78;
    font-size: 0.9em;
    padding: 8px;
    border: 1px dashed var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.08);
}

.luker-rpg-memory-graph-inline-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.luker-rpg-memory-graph-sidepanel .luker-rpg-memory-node-form {
    min-width: 0;
    width: 100%;
    max-width: 100%;
}

.luker-rpg-memory-graph-sidepanel .luker-rpg-memory-node-form-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.luker-rpg-memory-graph-sidepanel .luker-rpg-memory-edge-form-grid {
    grid-template-columns: repeat(1, minmax(0, 1fr));
}

.luker-rpg-memory-graph-table-wrap {
    flex: 1 1 0%;
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.32));
    border-radius: 8px;
    padding: 4px;
    background: rgba(0, 0, 0, 0.08);
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
}

.luker-rpg-memory-graph-table-wrap table {
    width: 100%;
    table-layout: fixed;
}

.luker-rpg-memory-graph-table-wrap th,
.luker-rpg-memory-graph-table-wrap td {
    word-break: break-word;
    overflow-wrap: anywhere;
}

/* --- Last-injection viewer --- */
.luker-injection-shell {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
    min-width: 0;
    max-height: 72vh;
    max-height: 72dvh;
    overflow: auto;
    padding: 4px 2px;
    box-sizing: border-box;
}

.luker-graph-tab-panel .luker-injection-shell {
    flex: 1 1 0%;
    min-height: 0;
    max-height: none;
}

.luker-injection-header {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 8px 12px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.32));
    border-radius: 10px;
    background: linear-gradient(155deg, rgba(17, 47, 43, 0.18), rgba(31, 30, 44, 0.12));
}

.luker-injection-title {
    font-weight: 600;
    font-size: 1.02em;
}

.luker-injection-time {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.82em;
    opacity: 0.78;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
}

.luker-injection-header-actions {
    margin-left: auto;
    display: flex;
    gap: 6px;
}

.luker-injection-header-actions .menu_button,
.luker-injection-header-actions .menu_button_small {
    width: 30px;
    height: 30px;
    min-width: 0;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
}

.luker-injection-empty {
    padding: 24px 16px;
    text-align: center;
    border: 1px dashed rgba(123, 163, 196, 0.28);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.02);
    opacity: 0.86;
    font-size: 0.92em;
}

.luker-injection-content {
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.luker-injection-block {
    display: flex;
    flex-direction: column;
    gap: 10px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.32));
    border-radius: 12px;
    padding: 12px;
    background: linear-gradient(155deg, rgba(17, 47, 43, 0.18), rgba(31, 30, 44, 0.12));
}

.luker-injection-block-source {
    display: none;
}

.luker-injection-block-core {
    border-color: rgba(80, 175, 120, 0.4);
    box-shadow: inset 3px 0 0 rgba(80, 175, 120, 0.55);
}

.luker-injection-block-focus {
    border-color: rgba(80, 150, 220, 0.4);
    box-shadow: inset 3px 0 0 rgba(80, 150, 220, 0.55);
}

.luker-injection-block-head {
    display: flex;
    align-items: center;
    gap: 10px;
}

.luker-injection-block-badge {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.6px;
    padding: 3px 10px;
    border-radius: 4px;
    color: #f5fffa;
}

.luker-injection-block-core .luker-injection-block-badge {
    background: rgba(76, 175, 80, 0.32);
    color: #b3eac0;
}

.luker-injection-block-focus .luker-injection-block-badge {
    background: rgba(33, 150, 243, 0.28);
    color: #aedaff;
}

.luker-injection-block-head .menu_button,
.luker-injection-block-head .menu_button_small {
    margin-left: auto;
    width: 28px;
    height: 28px;
    min-width: 0;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
}

.luker-injection-block-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
}

.luker-injection-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.06);
    border: 1px solid var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.22));
}

.luker-injection-source-popup {
    display: flex;
    flex-direction: column;
    gap: 8px;
    text-align: left;
    width: 100%;
    min-width: 0;
}

.luker-injection-source-pre {
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
    font-size: 12.5px;
    line-height: 1.5;
    margin: 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.08);
    border: 1px solid var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.28));
    max-height: 68vh;
    overflow: auto;
    box-sizing: border-box;
}

.luker-node-detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
    text-align: left;
    width: 100%;
    min-width: 0;
    max-height: 68vh;
    overflow: auto;
    padding-right: 4px;
    box-sizing: border-box;
}

.luker-node-detail-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.28));
}

.luker-node-detail-title-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
}

.luker-node-detail-title {
    font-size: 17px;
    font-weight: 700;
    line-height: 1.3;
    word-break: break-word;
}

.luker-node-detail-id {
    font-size: 11.5px;
    opacity: 0.6;
    font-family: var(--monoFontFamily, monospace);
    letter-spacing: 0.02em;
}

.luker-node-detail-badge {
    display: inline-flex;
    align-items: center;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 9px;
    border-radius: 999px;
    line-height: 1.6;
    white-space: nowrap;
    border: 1px solid transparent;
}

.luker-node-detail-badge.is-type {
    background: rgba(120, 160, 220, 0.18);
    color: var(--SmartThemeBodyColor, inherit);
    border-color: rgba(120, 160, 220, 0.32);
}

.luker-node-detail-badge.is-level {
    background: rgba(168, 137, 220, 0.18);
    color: var(--SmartThemeBodyColor, inherit);
    border-color: rgba(168, 137, 220, 0.32);
}

.luker-node-detail-summary {
    font-size: 13px;
    line-height: 1.55;
    padding: 8px 12px;
    border-radius: 8px;
    background: rgba(120, 160, 220, 0.08);
    border-left: 3px solid rgba(120, 160, 220, 0.5);
    word-break: break-word;
    white-space: pre-wrap;
}

.luker-node-detail-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.luker-node-detail-meta-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    padding: 3px 9px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.05);
    border: 1px solid var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.22));
}

.luker-node-detail-meta-item.is-warn {
    background: rgba(220, 150, 80, 0.14);
    border-color: rgba(220, 150, 80, 0.35);
}

.luker-node-detail-meta-key {
    opacity: 0.65;
}

.luker-node-detail-meta-val {
    font-weight: 600;
    word-break: break-word;
}

.luker-node-detail-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.luker-node-detail-section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.7;
}

.luker-node-detail-rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.22));
    background: var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.18));
}

.luker-node-detail-row {
    display: grid;
    grid-template-columns: minmax(110px, 22%) 1fr;
    gap: 12px;
    padding: 8px 12px;
    background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.02));
    align-items: start;
}

.luker-node-detail-row.is-block {
    grid-template-columns: 1fr;
    gap: 4px;
}

.luker-node-detail-key {
    font-size: 12px;
    font-weight: 600;
    opacity: 0.75;
    word-break: break-word;
    font-family: var(--monoFontFamily, monospace);
    padding-top: 2px;
}

.luker-node-detail-value {
    font-size: 13px;
    line-height: 1.5;
    word-break: break-word;
    min-width: 0;
}

.luker-node-detail-scalar {
    word-break: break-word;
}

.luker-node-detail-text {
    white-space: pre-wrap;
    word-break: break-word;
    padding: 6px 10px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.05);
    border: 1px solid var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.18));
    line-height: 1.55;
}

.luker-node-detail-empty {
    opacity: 0.45;
    font-style: italic;
}

.luker-node-detail-empty-block {
    font-size: 12.5px;
    opacity: 0.55;
    font-style: italic;
    padding: 8px 12px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.04);
    border: 1px dashed var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.28));
    text-align: center;
}

.luker-node-detail-bool {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
}

.luker-node-detail-bool.is-true {
    background: rgba(120, 200, 130, 0.18);
    color: rgb(70, 160, 90);
}

.luker-node-detail-bool.is-false {
    background: rgba(200, 120, 120, 0.16);
    opacity: 0.75;
}

.luker-node-detail-tag {
    display: inline-flex;
    align-items: center;
    margin: 2px 4px 2px 0;
    padding: 2px 8px;
    font-size: 11.5px;
    border-radius: 999px;
    background: rgba(120, 160, 220, 0.14);
    border: 1px solid rgba(120, 160, 220, 0.28);
    word-break: break-word;
}

.luker-node-detail-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
}

.luker-node-detail-pre {
    margin: 0;
    padding: 8px 10px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.06);
    border: 1px solid var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.22));
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 280px;
    overflow: auto;
}

.luker-node-detail-raw {
    border-top: 1px dashed var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.3));
    padding-top: 8px;
    margin-top: 4px;
}

.luker-node-detail-raw > summary {
    cursor: pointer;
    font-size: 12px;
    opacity: 0.7;
    user-select: none;
    padding: 4px 0;
    list-style: revert;
}

.luker-node-detail-raw > summary:hover {
    opacity: 1;
}

.luker-node-detail-raw > pre {
    margin: 6px 0 0 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.08);
    border: 1px solid var(--SmartThemeBorderColor, rgba(130, 130, 130, 0.22));
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 50vh;
    overflow: auto;
}

.luker-injection-section-head {
    display: flex;
    align-items: center;
    gap: 8px;
}

.luker-injection-section-title {
    font-size: 12px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(120, 160, 220, 0.16);
    color: rgba(220, 234, 250, 0.96);
}

.luker-injection-section-body {
    width: 100%;
    overflow-x: auto;
}

.luker-injection-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    table-layout: auto;
}

.luker-injection-table th {
    padding: 6px 10px;
    text-align: left;
    font-weight: 600;
    white-space: nowrap;
    border-bottom: 2px solid var(--SmartThemeBorderColor, rgba(120, 120, 120, 0.5));
    background: rgba(255, 255, 255, 0.03);
    position: sticky;
    top: 0;
}

.luker-injection-table td {
    padding: 6px 10px;
    border-bottom: 1px solid rgba(120, 120, 120, 0.22);
    line-height: 1.45;
    vertical-align: top;
}

.luker-injection-table tr:hover td {
    background: rgba(255, 255, 255, 0.02);
}

.luker-injection-cell-tight {
    white-space: nowrap;
}

.luker-injection-cell-wrap {
    word-break: break-word;
    overflow-wrap: anywhere;
    min-width: 220px;
}

.luker-injection-rawpre {
    white-space: pre-wrap;
    font-size: 12.5px;
    margin: 0;
    padding: 8px;
    background: rgba(0, 0, 0, 0.08);
    border-radius: 6px;
    line-height: 1.45;
    word-break: break-word;
    overflow-wrap: anywhere;
}

@media (max-width: 720px) {
    .luker-injection-section {
        padding: 6px 6px;
    }
    .luker-injection-table th,
    .luker-injection-table td {
        padding: 4px 6px;
    }
    .luker-injection-cell-tight {
        white-space: normal;
    }
}

.luker-rpg-memory-node-form {
    gap: 8px;
    min-width: 0;
    width: 100%;
    max-width: 100%;
}

.luker-rpg-memory-advanced-popup {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: stretch;
    text-align: left;
    max-height: 70vh;
    max-height: 70dvh;
    overflow-y: auto;
    overflow-x: hidden;
}

.luker-rpg-memory-advanced-popup label {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.luker-rpg-memory-advanced-footer {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    border-top: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    padding-top: 8px;
}

.luker-rpg-memory-advanced-footer-meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.luker-rpg-memory-advanced-footer-note {
    opacity: 0.76;
    font-size: 0.86em;
}

.luker-rpg-memory-advanced-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    flex-wrap: wrap;
}

.luker-rpg-memory-node-form-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
}

.luker-rpg-memory-node-form-flags {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    padding: 2px 0;
}

.luker-rpg-memory-node-form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.luker-rpg-memory-edge-form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}

.luker-rpg-memory-edge-form-grid label {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

@media (max-width: 1000px) {
    .popup:has(.luker-rpg-memory-graph-popup) {
        padding-left: 8px;
        padding-right: 8px;
    }
    .popup:has(.luker-rpg-memory-graph-popup) .popup-content {
        padding: 0 2px;
    }
    .luker-rpg-schema-popup {
        width: 100%;
        max-width: 100%;
    }
    .luker-rpg-memory-graph-popup {
        width: 100%;
        max-width: 100%;
    }
    .luker-rpg-memory-graph-search-head {
        grid-template-columns: minmax(0, 1fr);
    }
    .luker-rpg-schema-popup .luker-schema-topbar {
        flex-direction: column;
    }
    .luker-rpg-schema-popup .luker-schema-grid-2 {
        grid-template-columns: 1fr;
    }
    .luker-rpg-schema-popup .luker-schema-footer {
        flex-direction: column;
        align-items: stretch;
    }
    .luker-rpg-schema-popup .luker-schema-footer-actions {
        justify-content: flex-start;
    }
    .luker-rpg-memory-advanced-actions {
        justify-content: flex-start;
    }
    .luker-rpg-memory-advanced-footer {
        flex-direction: column;
        align-items: stretch;
    }
    /* Graph workspace: single column on mobile */
    .luker-rpg-memory-graph-workspace {
        grid-template-columns: minmax(0, 1fr);
    }
    .luker-rpg-memory-graph-cy {
        height: min(55vh, 420px);
    }
    /* Inspector: bottom panel on mobile */
    .luker-rpg-memory-graph-sidepanel {
        max-height: 40vh;
        border-top: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    }
    .luker-rpg-memory-graph-sidepanel.is-collapsed {
        max-height: 38px;
        overflow: hidden;
    }
    .luker-graph-inspector-toggle {
        display: inline-flex;
    }
    /* Show mobile card lists, hide desktop tables */
    .luker-graph-desktop-only { display: none !important; }
    .luker-graph-mobile-only { display: flex !important; }
    .luker-graph-tab-panel {
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
    }
    .luker-graph-card-list {
        padding: 0;
    }
    .luker-graph-card {
        padding: 10px 8px;
    }
    .luker-graph-card-head {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 6px;
    }
    .luker-graph-card-type {
        justify-self: start;
        max-width: 100%;
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
        overflow-wrap: anywhere;
    }
    /* Header: stack title and stats */
    .luker-graph-header-left {
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
    }
    /* Search actions: compact */
    .luker-rpg-memory-graph-search-actions {
        gap: 4px;
    }
    .luker-rpg-memory-graph-search-results {
        grid-template-columns: 1fr;
    }
    /* Node form grid: 2 columns on mobile */
    .luker-rpg-memory-node-form-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 480px) {
    /* Tab labels: icon only on very small screens */
    .luker-graph-tab span {
        display: none;
    }
    .luker-graph-tab {
        gap: 0;
        padding: 10px 6px;
    }
    .luker-graph-stat {
        font-size: 0.75em;
        padding: 2px 7px;
    }
}
</style>`);
}

function renderPrimaryKeyOptions(columns = [], selected = []) {
    const cols = Array.isArray(columns) ? columns.map(column => String(column || '').trim()).filter(Boolean) : [];
    const selectedSet = new Set(Array.isArray(selected) ? selected.map(column => String(column || '').trim()).filter(Boolean) : []);
    if (cols.length === 0) {
        return `<small style="opacity:0.8">${escapeHtml(i18n('(empty)'))}</small>`;
    }
    return cols.map((column) => `
        <label class="checkbox_label">
            <input type="checkbox" data-field="primaryKeyColumns" value="${escapeHtml(column)}" ${selectedSet.has(column) ? 'checked' : ''} />
            ${escapeHtml(column)}
        </label>
    `).join('');
}

function refreshPrimaryKeyOptionsForCard(card) {
    const root = jQuery(card);
    if (!root.length) {
        return;
    }
    const columns = splitCommaList(root.find('[data-field="tableColumns"]').val());
    const checked = root.find('[data-field="primaryKeyColumns"]:checked')
        .map((_, el) => String(jQuery(el).val() || '').trim())
        .get()
        .filter(Boolean);
    const validChecked = checked.filter(column => columns.includes(column));
    root.find('.luker-schema-primary-key-options').html(renderPrimaryKeyOptions(columns, validChecked));
}

function renderNodeTypeSchemaCard(spec, index) {
        const mode = String(spec?.compression?.mode || 'none');
    const threshold = Number(spec?.compression?.threshold || 6);
    const fanIn = Number(spec?.compression?.fanIn || 3);
    const maxDepth = Number(spec?.compression?.maxDepth || 6);
    const keepRecentLeaves = Number(spec?.compression?.keepRecentLeaves || 0);
    const compressionRule = String(spec?.compression?.rule || '');
    const summarizeInstruction = String(spec?.compression?.summarizeInstruction || '');
    const latestOnly = Boolean(spec?.latestOnly);
    const primaryKeyColumns = Array.isArray(spec?.primaryKeyColumns)
        ? spec.primaryKeyColumns.map(column => String(column || '').trim()).filter(Boolean)
        : [];
    const cardTitle = String(spec?.label || `Type ${index + 1}`).trim();
    const tableName = String(spec?.tableName || spec?.id || '').trim();
    const cardClass = `mode-${mode}${spec.alwaysInject ? ' is-always' : ''}${spec.forceUpdate ? ' is-force' : ''}`;
    return `
<div class="luker-schema-card ${cardClass}" data-index="${index}">
    <div class="luker-schema-card-header">
        <div>
            <div class="luker-schema-card-title">${escapeHtml(cardTitle)}</div>
            <div class="luker-schema-card-sub">${escapeHtml(i18nFormat('table: ${0}', tableName || i18n('(unset)')))}</div>
        </div>
        <div class="luker-schema-badges">
            <span class="luker-schema-badge">${escapeHtml(i18nFormat('mode: ${0}', mode))}</span>
            ${spec.editable ? `<span class="luker-schema-badge">${escapeHtml(i18n('Editable'))}</span>` : `<span class="luker-schema-badge">${escapeHtml(i18n('Create-only'))}</span>`}
            ${spec.alwaysInject ? `<span class="luker-schema-badge">${escapeHtml(i18n('always inject'))}</span>` : ''}
            ${spec.latestOnly ? `<span class="luker-schema-badge">${escapeHtml(i18n('Latest Only Upsert'))}</span>` : ''}
            ${spec.forceUpdate ? `<span class="luker-schema-badge">${escapeHtml(i18n('Force Update (must appear each extraction batch)'))}</span>` : ''}
        </div>
    </div>
    <div class="luker-schema-grid-2">
        <label>${escapeHtml(i18n('Type ID'))}
            <input data-field="id" class="text_pole" type="text" value="${escapeHtml(spec.id)}" />
        </label>
        <label>${escapeHtml(i18n('Label'))}
            <input data-field="label" class="text_pole" type="text" value="${escapeHtml(spec.label)}" />
        </label>
    </div>
    <div class="luker-schema-grid-2">
        <label>${escapeHtml(i18n('Table Name'))}
            <input data-field="tableName" class="text_pole" type="text" value="${escapeHtml(spec.tableName || spec.id)}" />
        </label>
        <label class="checkbox_label luker-schema-checkbox"><input data-field="alwaysInject" type="checkbox" ${spec.alwaysInject ? 'checked' : ''} />${escapeHtml(i18n('Always Inject'))}
        </label>
    </div>
    <label class="checkbox_label luker-schema-checkbox"><input data-field="forceUpdate" type="checkbox" ${spec.forceUpdate ? 'checked' : ''} />${escapeHtml(i18n('Force Update (must appear each extraction batch)'))}
    </label>
    <label class="checkbox_label luker-schema-checkbox"><input data-field="editable" type="checkbox" ${spec.editable ? 'checked' : ''} />${escapeHtml(i18n('Editable (enable edit/delete tools and graph edit context)'))}
    </label>
    <div class="luker-schema-grid-2">
        <label class="checkbox_label luker-schema-checkbox"><input data-field="latestOnly" type="checkbox" ${latestOnly ? 'checked' : ''} />${escapeHtml(i18n('Latest Only Upsert'))}
        </label>
        <div class="luker-schema-latestonly-keys" style="${latestOnly ? '' : 'display:none;'}">
            <label>${escapeHtml(i18n('Primary Key Columns'))}</label>
            <div class="luker-schema-primary-key-options">${renderPrimaryKeyOptions(spec.tableColumns, primaryKeyColumns)}</div>
        </div>
    </div>
    <label>${escapeHtml(i18n('Table Columns (comma separated)'))}
        <input data-field="tableColumns" class="text_pole" type="text" value="${escapeHtml(joinCommaList(spec.tableColumns))}" />
    </label>
    <label>${escapeHtml(i18n('Required Columns (comma separated)'))}
        <input data-field="requiredColumns" class="text_pole" type="text" value="${escapeHtml(joinCommaList(spec.requiredColumns))}" />
    </label>
    <label>${escapeHtml(i18n('Embedding Columns (comma separated, empty = all table columns)'))}
        <input data-field="embeddingColumns" class="text_pole" type="text" value="${escapeHtml(joinCommaList(spec.embeddingColumns || []))}" placeholder="${escapeHtml(joinCommaList(spec.tableColumns))}" />
    </label>
    <label>${escapeHtml(i18n('Column Hints (one per line: column=meaning)'))}
        <textarea data-field="columnHints" class="text_pole textarea_compact" rows="3">${escapeHtml(joinKeyValueLines(spec.columnHints))}</textarea>
    </label>
    <label>${escapeHtml(i18n('Keywords (comma separated)'))}
        <input data-field="keywords" class="text_pole" type="text" value="${escapeHtml(joinCommaList(spec.keywords))}" />
    </label>
    <label>${escapeHtml(i18n('Extract Hint'))}
        <textarea data-field="extractHint" class="text_pole textarea_compact" rows="2">${escapeHtml(spec.extractHint || '')}</textarea>
    </label>
    <label>${escapeHtml(i18n('Extraction Instructions'))}
        <small style="opacity:0.7">${escapeHtml(i18n('Per-type rules appended to the extraction system prompt when this type is active this round.'))}</small>
        <textarea data-field="extractionInstructions" class="text_pole textarea_compact" rows="5">${escapeHtml(spec.extractionInstructions || '')}</textarea>
    </label>
    <label>${escapeHtml(i18n('Extract Every N Floors'))}
        <small style="opacity:0.7">${escapeHtml(i18n('1 = every extraction pass (default). Larger N reduces frequency for slow-changing tables.'))}</small>
        <input data-field="extractEveryN" class="text_pole" type="number" min="1" step="1" value="${Number(spec.extractEveryN || 1)}" />
    </label>
    <label class="checkbox_label luker-schema-checkbox"><input data-field="compression.enabled" type="checkbox" ${mode === 'hierarchical' ? 'checked' : ''} />${escapeHtml(i18n('Enable Hierarchical Compression'))}
    </label>
    <div class="luker-schema-grid-2 luker-schema-compression-hier" style="${mode === 'hierarchical' ? '' : 'display:none;'}">
        <label>${escapeHtml(i18n('Threshold'))}
            <input data-field="compression.threshold" class="text_pole" type="number" min="2" step="1" value="${threshold}" />
        </label>
        <label>${escapeHtml(i18n('Fan-In'))}
            <input data-field="compression.fanIn" class="text_pole" type="number" min="2" step="1" value="${fanIn}" />
        </label>
    </div>
    <div class="luker-schema-grid-2 luker-schema-compression-hier" style="${mode === 'hierarchical' ? '' : 'display:none;'}">
        <label>${escapeHtml(i18n('Max Depth'))}
            <input data-field="compression.maxDepth" class="text_pole" type="number" min="1" step="1" value="${maxDepth}" />
        </label>
        <label>${escapeHtml(i18n('Keep Recent Leaves'))}
            <input data-field="compression.keepRecentLeaves" class="text_pole" type="number" min="0" step="1" value="${keepRecentLeaves}" />
        </label>
    </div>
    <label class="luker-schema-compression-hier" style="${mode === 'hierarchical' ? '' : 'display:none;'}">${escapeHtml(i18n('Compression Rule (optional)'))}
        <textarea data-field="compression.rule" class="text_pole textarea_compact" rows="2" placeholder="${escapeHtml(i18n('Filter nodes eligible for compression. One condition per line or use &&. Examples: status in resolved,dropped ; semantic_rollup=false'))}">${escapeHtml(compressionRule)}</textarea>
    </label>
    <label class="luker-schema-compression-hier" style="${mode === 'hierarchical' ? '' : 'display:none;'}">${escapeHtml(i18n('Summarize Instruction'))}
        <textarea data-field="compression.summarizeInstruction" class="text_pole textarea_compact" rows="2">${escapeHtml(summarizeInstruction)}</textarea>
    </label>
    <div class="luker-schema-actions">
        <div class="menu_button luker-schema-action" data-action="duplicate">${escapeHtml(i18n('Duplicate Type'))}</div>
        <div class="menu_button luker-schema-action" data-action="remove">${escapeHtml(i18n('Remove Type'))}</div>
    </div>
</div>`;
}

function updateSchemaCardModeUi(card) {
    const root = jQuery(card);
    const enabled = Boolean(root.find('[data-field="compression.enabled"]').prop('checked'));
    const latestOnlyEnabled = Boolean(root.find('[data-field="latestOnly"]').prop('checked'));
    root.find('.luker-schema-compression-hier').toggle(enabled);
    root.find('.luker-schema-latestonly-keys').toggle(latestOnlyEnabled);
}

function readSchemaCard(card) {
    const root = jQuery(card);
    return {
        id: String(root.find('[data-field="id"]').val() || '').trim(),
        label: String(root.find('[data-field="label"]').val() || '').trim(),
        tableName: String(root.find('[data-field="tableName"]').val() || '').trim(),
        tableColumns: splitCommaList(root.find('[data-field="tableColumns"]').val()),
        requiredColumns: splitCommaList(root.find('[data-field="requiredColumns"]').val()),
        embeddingColumns: splitCommaList(root.find('[data-field="embeddingColumns"]').val()),
        columnHints: parseKeyValueLines(root.find('[data-field="columnHints"]').val()),
        level: LEVEL.SEMANTIC,
        extractHint: String(root.find('[data-field="extractHint"]').val() || '').trim(),
        extractionInstructions: String(root.find('[data-field="extractionInstructions"]').val() || '').trim(),
        extractEveryN: Math.max(1, Math.floor(Number(root.find('[data-field="extractEveryN"]').val()) || 1)),
        keywords: splitCommaList(root.find('[data-field="keywords"]').val()),
        forceUpdate: Boolean(root.find('[data-field="forceUpdate"]').prop('checked')),
        editable: Boolean(root.find('[data-field="editable"]').prop('checked')),
        alwaysInject: Boolean(root.find('[data-field="alwaysInject"]').prop('checked')),
        latestOnly: Boolean(root.find('[data-field="latestOnly"]').prop('checked')),
        primaryKeyColumns: root.find('[data-field="primaryKeyColumns"]:checked')
            .map((_, el) => String(jQuery(el).val() || '').trim())
            .get()
            .filter(Boolean),
        compression: {
            mode: Boolean(root.find('[data-field="compression.enabled"]').prop('checked')) ? 'hierarchical' : 'none',
            threshold: Math.max(2, Number(root.find('[data-field="compression.threshold"]').val()) || 6),
            fanIn: Math.max(2, Number(root.find('[data-field="compression.fanIn"]').val()) || 3),
            maxDepth: Math.max(1, Number(root.find('[data-field="compression.maxDepth"]').val()) || 6),
            keepRecentLeaves: Math.max(0, Number(root.find('[data-field="compression.keepRecentLeaves"]').val()) || 0),
            rule: String(root.find('[data-field="compression.rule"]').val() || '').trim(),
            summarizeInstruction: String(root.find('[data-field="compression.summarizeInstruction"]').val() || '').trim(),
        },
    };
}

function readNodeTypeSchemaEditor(root, listSelector = '#luker_rpg_memory_schema_editor_list') {
    const cards = root.find(`${listSelector} .luker-schema-card`);
    const raw = [];
    cards.each((_, card) => raw.push(readSchemaCard(card)));
    return normalizeNodeTypeSchema(raw);
}

function renderNodeTypeSchemaEditor(root, schema, listSelector = '#luker_rpg_memory_schema_editor_list') {
    const list = root.find(listSelector);
    if (!list.length) {
        return;
    }
    const normalized = normalizeNodeTypeSchema(schema);
    list.html(normalized.map((spec, index) => renderNodeTypeSchemaCard(spec, index)).join(''));
    list.find('.luker-schema-card').each((_, card) => updateSchemaCardModeUi(card));
    list.off('change.lukerSchemaMode input.lukerSchemaMode');
    list.on('change.lukerSchemaMode', '[data-field="compression.enabled"],[data-field="latestOnly"]', function () {
        updateSchemaCardModeUi(jQuery(this).closest('.luker-schema-card'));
        refreshPrimaryKeyOptionsForCard(jQuery(this).closest('.luker-schema-card'));
    });
    list.on('input.lukerSchemaMode change.lukerSchemaMode', '[data-field="tableColumns"]', function () {
        refreshPrimaryKeyOptionsForCard(jQuery(this).closest('.luker-schema-card'));
    });
}

function updateSchemaSummary(root, schema) {
    const normalized = normalizeNodeTypeSchema(schema);
    const total = normalized.length;
    const alwaysInject = normalized.filter(item => item.alwaysInject).length;
    const forceUpdate = normalized.filter(item => item.forceUpdate).length;
    const editable = normalized.filter(item => item.editable).length;
    const hierarchical = normalized.filter(item => String(item?.compression?.mode || '') === 'hierarchical').length;
    root.find('#luker_rpg_memory_schema_summary').text(i18nFormat(
        'Types: ${0} | Editable: ${1} | Always Inject: ${2} | Force Update: ${3} | Hierarchical: ${4}',
        total,
        editable,
        alwaysInject,
        forceUpdate,
        hierarchical,
    ));
}

function updateSchemaScopeIndicator(root, scopeInfo) {
    const scopeText = scopeInfo?.hasOverride
        ? i18nFormat('Schema scope: character override (${0})', scopeInfo.characterName || scopeInfo.avatar || i18n('(unset)'))
        : i18n('Schema scope: global');
    root.find('#luker_rpg_memory_schema_scope').text(scopeText);
}

function updateAdvancedScopeIndicator(root, scopeInfo) {
    const scopeText = scopeInfo?.hasOverride
        ? i18nFormat('Advanced scope: character override (${0})', scopeInfo.characterName || scopeInfo.avatar || i18n('(unset)'))
        : i18n('Advanced scope: global');
    root.find('#luker_rpg_memory_advanced_scope').text(scopeText);
}

async function persistSchemaToGlobal(settings, schema) {
    settings.nodeTypeSchema = normalizeNodeTypeSchema(schema);
    await saveSettings();
}

async function persistSchemaToCharacter(context, avatar, schema) {
    const targetAvatar = String(avatar || '').trim();
    if (!targetAvatar) {
        return false;
    }
    return await persistCharacterSchemaOverride(context, targetAvatar, schema);
}

async function persistAdvancedToGlobal(settings, advancedSettings) {
    applyAdvancedSettings(settings, advancedSettings);
    await saveSettings();
}

async function persistAdvancedToCharacter(context, avatar, advancedSettings) {
    const targetAvatar = String(avatar || '').trim();
    if (!targetAvatar) {
        return false;
    }
    return await persistCharacterAdvancedOverride(context, targetAvatar, advancedSettings);
}

async function openSchemaEditorPopup(context, settings, root) {
    ensureStyles();
    const popupId = `luker_rpg_memory_schema_popup_${Date.now()}`;
    const scopeInfo = getSchemaScopeInfo(context, settings);
    const popupHtml = buildSchemaEditorPopupHtml({
        escapeHtml,
        i18n,
        i18nFormat,
        normalizeNodeTypeSchema,
        renderNodeTypeSchemaCard,
    }, popupId, scopeInfo);
    const namespace = `.lukerSchemaPopup_${popupId}`;
    const selector = `#${popupId}`;
    const listSelector = '.luker-schema-editor-list';

    const getPopupRoot = () => jQuery(selector);
    const readCurrentSchema = () => {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return null;
        }
        return readNodeTypeSchemaEditor(popupRoot, listSelector);
    };
    const rerender = (schema) => {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        renderNodeTypeSchemaEditor(popupRoot, schema, listSelector);
    };
    const setPopupScopeUi = (nextScopeInfo) => {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        const hasAvatar = Boolean(nextScopeInfo?.hasAvatar);
        const hasOverride = Boolean(nextScopeInfo?.hasAvatar && nextScopeInfo?.hasOverride);
        const scopeText = nextScopeInfo?.hasOverride
            ? i18nFormat('Schema scope: character override (${0})', nextScopeInfo.characterName || nextScopeInfo.avatar || i18n('(unset)'))
            : i18n('Schema scope: global');
        popupRoot.find(`#${popupId}_schema_scope`).text(scopeText);
        popupRoot.find(`#${popupId}_schema_save_character`)
            .toggle(hasAvatar)
            .prop('disabled', !hasAvatar);
        popupRoot.find(`#${popupId}_schema_clear_character_override`)
            .toggle(hasAvatar)
            .prop('disabled', !hasOverride);
    };
    const syncRootScopeUi = () => {
        if (!root?.length) {
            return;
        }
        const nextScopeInfo = getSchemaScopeInfo(context, settings);
        updateSchemaSummary(root, nextScopeInfo.schema);
        updateSchemaScopeIndicator(root, nextScopeInfo);
    };
    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.TEXT,
        '',
        {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            onOpen: () => {
                setPopupScopeUi(getSchemaScopeInfo(context, settings));
            },
        },
    );
    const popupScopeSyncEvents = [
        context?.eventTypes?.CHAT_CHANGED,
        context?.eventTypes?.CHARACTER_REPLACED,
        context?.eventTypes?.CHARACTER_EDITED,
    ].filter(Boolean);
    const handlePopupScopeSync = () => setPopupScopeUi(getSchemaScopeInfo(context, settings));
    for (const eventName of popupScopeSyncEvents) {
        context?.eventSource?.on?.(eventName, handlePopupScopeSync);
    }

    jQuery(document).off(namespace);
    jQuery(document).on(`change${namespace}`, `${selector} [data-field="compression.enabled"], ${selector} [data-field="latestOnly"]`, function () {
        const card = jQuery(this).closest('.luker-schema-card');
        updateSchemaCardModeUi(card);
        refreshPrimaryKeyOptionsForCard(card);
    });
    jQuery(document).on(`input${namespace} change${namespace}`, `${selector} [data-field="tableColumns"]`, function () {
        const card = jQuery(this).closest('.luker-schema-card');
        refreshPrimaryKeyOptionsForCard(card);
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-schema-editor-add`, function () {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        const current = readNodeTypeSchemaEditor(popupRoot, listSelector);
        current.push(getSchemaTypeTemplate(current.length + 1));
        rerender(current);
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-schema-editor-reset`, function () {
        if (!window.confirm(i18n('Reset schema editor content to default? This will overwrite current unsaved schema edits.'))) {
            return;
        }
        rerender(normalizeNodeTypeSchema(structuredClone(defaultNodeTypeSchema)));
        notifySuccess(i18n('Schema reset to default in editor.'));
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-schema-action`, function () {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        const card = jQuery(this).closest('.luker-schema-card');
        const index = Number(card.data('index'));
        const action = String(jQuery(this).data('action') || '');
        const current = readNodeTypeSchemaEditor(popupRoot, listSelector);
        if (!Number.isInteger(index) || index < 0 || index >= current.length) {
            return;
        }

        if (action === 'duplicate') {
            const clone = structuredClone(current[index]);
            clone.id = `${clone.id || 'custom'}_copy_${Date.now()}`;
            clone.label = `${clone.label || 'Custom'} Copy`;
            current.splice(index + 1, 0, clone);
            rerender(current);
            return;
        }

        if (action === 'remove') {
            current.splice(index, 1);
            if (current.length === 0) {
                current.push(getSchemaTypeTemplate(1));
            }
            rerender(current);
        }
    });
    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_schema_save_global`, async function () {
        const nextSchema = readCurrentSchema();
        if (!Array.isArray(nextSchema) || nextSchema.length === 0) {
            notifyError(i18n('Failed to read schema from editor.'));
            return;
        }
        await persistSchemaToGlobal(settings, nextSchema);
        const nextScopeInfo = getSchemaScopeInfo(context, settings);
        setPopupScopeUi(nextScopeInfo);
        syncRootScopeUi();
        notifySuccess(i18n('Schema saved to global settings.'));
        updateUiStatus(i18n('Schema saved to global settings.'));
    });
    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_schema_save_character`, async function () {
        const nextScopeInfo = getSchemaScopeInfo(context, settings);
        if (!nextScopeInfo.hasAvatar) {
            notifyError(i18n('No active character selected.'));
            return;
        }
        const nextSchema = readCurrentSchema();
        if (!Array.isArray(nextSchema) || nextSchema.length === 0) {
            notifyError(i18n('Failed to read schema from editor.'));
            return;
        }
        const ok = await persistSchemaToCharacter(context, nextScopeInfo.avatar, nextSchema);
        if (!ok) {
            notifyError(i18n('Failed to persist character schema override.'));
            return;
        }
        const refreshedScopeInfo = getSchemaScopeInfo(context, settings);
        setPopupScopeUi(refreshedScopeInfo);
        syncRootScopeUi();
        notifySuccess(i18nFormat('Schema saved to character override: ${0}.', refreshedScopeInfo.characterName || nextScopeInfo.characterName || nextScopeInfo.avatar));
        updateUiStatus(i18nFormat('Schema saved to character override: ${0}.', refreshedScopeInfo.characterName || nextScopeInfo.characterName || nextScopeInfo.avatar));
    });
    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_schema_clear_character_override`, async function () {
        const nextScopeInfo = getSchemaScopeInfo(context, settings);
        if (!nextScopeInfo.hasAvatar) {
            notifyError(i18n('No active character selected.'));
            return;
        }
        const ok = await removeCharacterSchemaOverride(context, nextScopeInfo.avatar);
        if (!ok) {
            notifyError(i18n('Failed to clear character schema override.'));
            return;
        }
        const refreshedScopeInfo = getSchemaScopeInfo(context, settings);
        rerender(refreshedScopeInfo.schema);
        setPopupScopeUi(refreshedScopeInfo);
        syncRootScopeUi();
        notifySuccess(i18nFormat('Cleared character schema override: ${0}.', nextScopeInfo.characterName || nextScopeInfo.avatar));
        updateUiStatus(i18nFormat('Cleared character schema override: ${0}.', nextScopeInfo.characterName || nextScopeInfo.avatar));
    });
    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_schema_export`, function () {
        const nextSchema = readCurrentSchema();
        if (!Array.isArray(nextSchema) || nextSchema.length === 0) {
            notifyError(i18n('Failed to read schema from editor.'));
            return;
        }
        const currentScopeInfo = getSchemaScopeInfo(context, settings);
        const payload = buildSchemaExportPayload(nextSchema, currentScopeInfo, normalizeNodeTypeSchema);
        const fileName = getSchemaExportFileName(currentScopeInfo);
        download(JSON.stringify(payload, null, 2), fileName, 'application/json');
        notifySuccess(i18nFormat('Downloaded schema file: ${0}', fileName));
        updateUiStatus(i18nFormat('Downloaded schema file: ${0}', fileName));
    });
    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_schema_import`, function () {
        // Detached file input — click() works on inputs that are not attached
        // to the document, so we avoid mutating the DOM and the lifecycle is
        // tied to the closure: once the change handler runs (or the input is
        // GC'd if the user cancels), nothing leaks.
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) {
                return;
            }
            try {
                const parsed = JSON.parse(await getFileText(file));
                const importedSchema = parseSchemaImportPayload(parsed, normalizeNodeTypeSchema);
                rerender(importedSchema);
                notifySuccess(i18n('Schema imported into editor. Click a Save button to persist.'));
                updateUiStatus(i18n('Schema imported into editor. Click a Save button to persist.'));
            } catch (error) {
                notifyError(i18nFormat('Failed to import schema: ${0}', i18n(error?.message || String(error))));
            }
        }, { once: true });
        fileInput.click();
    });

    try {
        await popupPromise;
    } finally {
        jQuery(document).off(namespace);
        for (const eventName of popupScopeSyncEvents) {
            context?.eventSource?.removeListener?.(eventName, handlePopupScopeSync);
        }
        bindUi();
    }
}


// ---- Advanced tab (in-drawer) helpers -----------------------------------
// The Advanced tab embeds all 14 advanced settings + Schema controls
// directly in the drawer. Semantics: form changes take effect immediately
// (write to `settings` in memory + normalized) but are NOT persisted to
// settings.json or character override until user clicks Save to Global /
// Save to Character. Reset only restores defaults into the form; user
// must click Save Global to persist.

function hydrateAdvancedTabFields(root, source) {
    if (!root?.length || !source) return;
    root.find('#luker_rpg_memory_advanced_include_world_info').prop('checked', source.includeWorldInfoWithPreset !== false);
    root.find('#luker_rpg_memory_advanced_recent_raw_turns').val(String(Math.max(0, Number(source.recentRawTurns ?? defaultSettings.recentRawTurns))));
    root.find('#luker_rpg_memory_advanced_recall_iterations').val(String(Math.max(2, Math.min(6, Number(source.recallMaxIterations ?? defaultSettings.recallMaxIterations)))));
    root.find('#luker_rpg_memory_advanced_tool_retries').val(String(Math.max(0, Math.min(10, Number(source.toolCallRetryMax ?? defaultSettings.toolCallRetryMax)))));
    root.find('#luker_rpg_memory_advanced_rpm_limit').val(String(Math.max(0, Math.min(600, Number(source.rpmLimit ?? defaultSettings.rpmLimit)))));
    root.find('#luker_rpg_memory_advanced_extract_context_turns').val(String(Math.max(1, Math.min(32, Number(source.extractContextTurns ?? defaultSettings.extractContextTurns)))));
    root.find('#luker_rpg_memory_advanced_extract_exclude_recent_turns').val(String(normalizeExtractExcludeRecentTurns(source.extractExcludeRecentTurns ?? defaultSettings.extractExcludeRecentTurns)));
    root.find('#luker_rpg_memory_advanced_recall_query_messages').val(String(Math.max(1, Math.min(64, Number(source.recallQueryMessages ?? defaultSettings.recallQueryMessages)))));
    root.find('#luker_rpg_memory_advanced_llm_visible_recent_messages').val(String(Math.max(0, Math.min(200, Number(source.llmVisibleRecentMessages ?? defaultSettings.llmVisibleRecentMessages)))));
    root.find('#luker_rpg_memory_advanced_extract_batch_turns').val(String(Math.max(1, Number(source.extractBatchTurns ?? defaultSettings.extractBatchTurns))));
    root.find('#luker_rpg_memory_advanced_extract_system_prompt').val(String(source.extractSystemPrompt || DEFAULT_EXTRACT_SYSTEM_PROMPT));
    root.find('#luker_rpg_memory_advanced_recall_route_prompt').val(String(source.recallRouteSystemPrompt || DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT));
    root.find('#luker_rpg_memory_advanced_recall_finalize_prompt').val(String(source.recallFinalizeSystemPrompt || DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT));
    root.find('#luker_rpg_memory_advanced_rag_rewrite_prompt').val(String(source.ragRewriteSystemPrompt || DEFAULT_RAG_REWRITE_SYSTEM_PROMPT));
    root.find('#luker_rpg_memory_advanced_schema_iter_system_prompt').val(String(source.schemaIterSystemPrompt || DEFAULT_SCHEMA_ITER_SYSTEM_PROMPT));
    const ragRewriteVisible = String(source.recallMethod || 'llm') === 'rag' && Boolean(source.ragUseQueryRewrite);
    root.find('#luker_rpg_memory_advanced_rag_rewrite_prompt_block').toggle(ragRewriteVisible);
}

function readAdvancedTabFields(root) {
    if (!root?.length) return null;
    return {
        includeWorldInfoWithPreset: Boolean(root.find('#luker_rpg_memory_advanced_include_world_info').prop('checked')),
        recentRawTurns: Number(root.find('#luker_rpg_memory_advanced_recent_raw_turns').val()),
        recallMaxIterations: Number(root.find('#luker_rpg_memory_advanced_recall_iterations').val()),
        toolCallRetryMax: Number(root.find('#luker_rpg_memory_advanced_tool_retries').val()),
        rpmLimit: Number(root.find('#luker_rpg_memory_advanced_rpm_limit').val()),
        extractContextTurns: Number(root.find('#luker_rpg_memory_advanced_extract_context_turns').val()),
        extractExcludeRecentTurns: Number(root.find('#luker_rpg_memory_advanced_extract_exclude_recent_turns').val()),
        recallQueryMessages: Number(root.find('#luker_rpg_memory_advanced_recall_query_messages').val()),
        llmVisibleRecentMessages: Number(root.find('#luker_rpg_memory_advanced_llm_visible_recent_messages').val()),
        extractBatchTurns: Number(root.find('#luker_rpg_memory_advanced_extract_batch_turns').val()),
        extractSystemPrompt: String(root.find('#luker_rpg_memory_advanced_extract_system_prompt').val() || '').trim(),
        recallRouteSystemPrompt: String(root.find('#luker_rpg_memory_advanced_recall_route_prompt').val() || '').trim(),
        recallFinalizeSystemPrompt: String(root.find('#luker_rpg_memory_advanced_recall_finalize_prompt').val() || '').trim(),
        ragRewriteSystemPrompt: String(root.find('#luker_rpg_memory_advanced_rag_rewrite_prompt').val() || '').trim(),
        schemaIterSystemPrompt: String(root.find('#luker_rpg_memory_advanced_schema_iter_system_prompt').val() || '').trim(),
    };
}

function markAdvancedTabDirty(root, dirty) {
    root.find('#luker_rpg_memory_advanced_dirty_note').toggle(Boolean(dirty));
}

function applyAdvancedTabToLiveSettings(root, settings) {
    const values = readAdvancedTabFields(root);
    if (!values) return;
    const normalized = normalizeAdvancedSettings(values, settings);
    applyAdvancedSettings(settings, normalized);
    markAdvancedTabDirty(root, true);
}


function getCompressibleTypeSpecs(settings, context = null) {
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

async function openManualCompressionPopup(context, settings) {
    const compressibleTypes = getCompressibleTypeSpecs(settings, context);
    if (compressibleTypes.length === 0) {
        notifyError(i18n('No compressible types in current schema.'));
        return;
    }
    await ensureMemoryStoreLoaded(context);
    const store = getMemoryStore(context);
    if (!store) {
        notifyError(i18n('No active chat selected.'));
        return;
    }

    const popupId = `luker_rpg_memory_manual_compress_${Date.now()}`;
    const html = buildManualCompressionPopupHtml({
        escapeHtml,
        i18n,
    }, popupId, settings, compressibleTypes);
    const readValues = () => {
        const popupRoot = jQuery(`#${popupId}`);
        if (!popupRoot.length) {
            return null;
        }
        const selectedTypeIds = popupRoot
            .find('input[data-field="type"]:checked')
            .map((_, el) => String(jQuery(el).val() || '').trim().toLowerCase())
            .get()
            .filter(Boolean);
        return {
            scope: String(popupRoot.find(`#${popupId}_scope`).val() || 'all').trim(),
            mode: String(popupRoot.find(`#${popupId}_mode`).val() || 'schema').trim(),
            excludeRecent: Math.max(0, Math.floor(Number(popupRoot.find(`#${popupId}_exclude_recent`).val()) || 0)),
            maxRoundsPerType: Math.max(1, Math.floor(Number(popupRoot.find(`#${popupId}_max_rounds`).val()) || 1)),
            selectedTypeIds,
        };
    };

    let captured = null;
    const result = await context.callGenericPopup(
        html,
        context.POPUP_TYPE.CONFIRM,
        '',
        {
            okButton: i18n('Apply Manual Compression'),
            cancelButton: i18n('Cancel'),
            wide: true,
            large: false,
            allowVerticalScrolling: true,
            onOpen: () => {
                const popupRoot = jQuery(`#${popupId}`);
                const scopeSelect = popupRoot.find(`#${popupId}_scope`);
                const excludeLabel = popupRoot.find(`#${popupId}_exclude_recent_label`);
                const toggleExclude = () => excludeLabel.toggle(scopeSelect.val() === 'older');
                toggleExclude();
                scopeSelect.on('change', toggleExclude);
            },
            onClosing: () => {
                captured = readValues();
                return true;
            },
        },
    );
    if (result !== context.POPUP_RESULT.AFFIRMATIVE) {
        return;
    }
    const values = captured || readValues();
    if (!values) {
        notifyError(i18n('Failed to read advanced settings.'));
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

async function openVectorRecomputePopup(context, settings) {
    await ensureMemoryStoreLoaded(context);
    const chatKey = getChatKey(context);
    const store = memoryStoreCache.get(chatKey);
    if (!store) {
        notifyError(i18n('No active chat selected.'));
        return;
    }

    const vectorConfig = getVectorConfigFromSettings(settings);
    const validation = validateVectorConfig(vectorConfig);
    if (!validation.valid) {
        notifyError(i18n('Embedding profile is not configured. Configure it in the settings above first.'));
        return;
    }

    const nodes = store?.nodes || {};
    const hasAnyNode = Object.values(nodes).some(node => !node?.archived);
    if (!hasAnyNode) {
        notifyInfo(i18n('No eligible nodes to embed.'));
        return;
    }

    const content = `
        <div class="flex-container flexFlowColumn" style="gap:6px">
            <div>${escapeHtml(i18n('Recompute vector embeddings for memory graph nodes.'))}</div>
            <div style="opacity:0.85">${escapeHtml(i18n('Fill Missing: re-embed only nodes whose vectors are missing or stale (after node edits).'))}</div>
            <div style="opacity:0.85">${escapeHtml(i18n('Full Rebuild: clear and re-embed all eligible nodes (after changing embedding model/profile).'))}</div>
        </div>
    `;
    const choice = await context.callGenericPopup(content, context.POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: i18n('Cancel'),
        wider: true,
        customButtons: [
            { text: i18n('Fill Missing'), result: context.POPUP_RESULT.CUSTOM1 },
            { text: i18n('Full Rebuild'), result: context.POPUP_RESULT.CUSTOM2 },
        ],
    });

    if (choice === context.POPUP_RESULT.CUSTOM1) {
        await runVectorRecompute(context, settings, store, chatKey, { mode: 'incremental' });
    } else if (choice === context.POPUP_RESULT.CUSTOM2) {
        await runVectorRecompute(context, settings, store, chatKey, { mode: 'full' });
    }
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

function bindUi() {
    const context = getContext();
    const settings = getSettings();
    const root = jQuery(`#${UI_BLOCK_ID}`);

    if (!root.length) {
        return;
    }

    root.find('#luker_rpg_memory_enabled').prop('checked', Boolean(settings.enabled));
    root.find('#luker_rpg_memory_auto_extraction_enabled').prop('checked', settings.autoExtractionEnabled !== false);
    root.find('#luker_rpg_memory_auto_compression_enabled').prop('checked', settings.autoCompressionEnabled !== false);
    root.find('#luker_rpg_memory_recall_enabled').prop('checked', Boolean(settings.recallEnabled));
    root.find('#luker_rpg_memory_recall_inject_position').val(String(normalizeRecallInjectPosition(settings.recallInjectPosition)));
    root.find('#luker_rpg_memory_recall_inject_depth').val(String(normalizeRecallInjectDepth(settings.recallInjectDepth)));
    root.find('#luker_rpg_memory_recall_inject_role').val(String(normalizeRecallInjectRole(settings.recallInjectRole)));
    root.find('#luker_rpg_memory_recall_api_preset').val(String(settings.recallApiPresetName || ''));
    root.find('#luker_rpg_memory_recall_preset').val(String(settings.recallPresetName || ''));
    root.find('#luker_rpg_memory_extract_api_preset').val(String(settings.extractApiPresetName || ''));
    root.find('#luker_rpg_memory_extract_preset').val(String(settings.extractPresetName || ''));
    root.find('#luker_rpg_memory_request_api_preset').val(String(settings.requestApiPresetName || ''));
    root.find('#luker_rpg_memory_request_llm_preset').val(String(settings.requestLlmPresetName || ''));
    root.find('#luker_rpg_memory_update_every').val(String(settings.updateEvery));
    const schemaScopeInfo = getSchemaScopeInfo(context, settings);
    updateSchemaSummary(root, schemaScopeInfo.schema);
    updateSchemaScopeIndicator(root, schemaScopeInfo);
    const advancedScopeInfo = getAdvancedScopeInfo(context, settings);
    updateAdvancedScopeIndicator(root, advancedScopeInfo);
    root.find('#luker_rpg_memory_advanced_save_character').prop('disabled', !advancedScopeInfo.hasAvatar);
    root.find('#luker_rpg_memory_advanced_clear_character_override').prop('disabled', !(advancedScopeInfo.hasAvatar && advancedScopeInfo.hasOverride));
    hydrateAdvancedTabFields(root, advancedScopeInfo.settings);
    markAdvancedTabDirty(root, false);
    refreshOpenAIPresetSelectors(root, context, settings);

    ensureMemoryStoreLoaded(context)
        .then(() => refreshUiStats())
        .catch(() => refreshUiStats());

    root.find('#luker_rpg_memory_enabled').off('input').on('input', function () {
        settings.enabled = Boolean(jQuery(this).prop('checked'));
        syncGenerationVisibleHistoryRuntimeRegexScripts();
        void syncMemoryLorebookActivation(getContext(), settings);
        if (settings.enabled) {
            void syncPersistentProjectionForCurrentChat(getContext());
        } else {
            void stopMemoryRuntimeWork();
            updateUiStatus(i18n('Memory disabled, cleared memory lorebook injections.'));
        }
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_recall_enabled').off('input').on('input', function () {
        settings.recallEnabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_auto_extraction_enabled').off('input').on('input', function () {
        settings.autoExtractionEnabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_auto_compression_enabled').off('input').on('input', function () {
        settings.autoCompressionEnabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    // Recall method selector + RAG settings visibility
    root.find('#luker_rpg_memory_recall_method').val(String(settings.recallMethod || 'llm'));

    root.find('#luker_rpg_memory_vector_topk').val(String(settings.vectorTopK || 20));
    root.find('#luker_rpg_memory_hybrid_max_results').val(String(settings.hybridMaxResults || 15));
    root.find('#luker_rpg_memory_rag_use_rerank').prop('checked', Boolean(settings.ragUseRerank));
    root.find('#luker_rpg_memory_rag_use_query_rewrite').prop('checked', Boolean(settings.ragUseQueryRewrite));

    function refreshMemoryEmbeddingSelect() {
        const sel = /** @type {HTMLSelectElement} */ (root.find('#luker_rpg_memory_embedding_profile')[0]);
        if (!sel) return;
        renderProfileSelect(sel, 'embed', settings.embeddingProfileId || '');
        const actual = String(sel.value || '');
        if (actual !== (settings.embeddingProfileId || '')) {
            settings.embeddingProfileId = actual;
            saveSettingsDebounced();
        }
    }
    function refreshMemoryRerankSelect() {
        const sel = /** @type {HTMLSelectElement} */ (root.find('#luker_rpg_memory_rerank_profile')[0]);
        if (!sel) return;
        renderProfileSelect(sel, 'rerank', settings.rerankProfileId || '');
        const actual = String(sel.value || '');
        if (actual !== (settings.rerankProfileId || '')) {
            settings.rerankProfileId = actual;
            saveSettingsDebounced();
        }
    }
    refreshMemoryEmbeddingSelect();
    refreshMemoryRerankSelect();

    function updateRecallMethodVisibility() {
        const method = String(root.find('#luker_rpg_memory_recall_method').val() || 'llm');
        const isRag = method === 'rag';
        const isLlm = method === 'llm';
        // RAG-only blocks
        root.find('#luker_rpg_memory_rag_settings').toggle(isRag);
        root.find('#luker_rpg_memory_rag_rerank_block').toggle(isRag && Boolean(settings.ragUseRerank));
        root.find('#luker_rpg_memory_rag_rewrite_block').toggle(isRag && Boolean(settings.ragUseQueryRewrite));
        // Advanced tab's rag rewrite system prompt textarea follows the same gate.
        root.find('#luker_rpg_memory_advanced_rag_rewrite_prompt_block').toggle(isRag && Boolean(settings.ragUseQueryRewrite));
        // LLM-only fields: preset row + iterations + stage prompts. Hidden when RAG.
        root.find('#luker_rpg_memory_recall_llm_settings').toggle(isLlm);
        root.find('#luker_rpg_memory_advanced_recall_iterations_row').toggle(isLlm);
        root.find('#luker_rpg_memory_advanced_recall_route_prompt_row').toggle(isLlm);
        root.find('#luker_rpg_memory_advanced_recall_finalize_prompt_row').toggle(isLlm);
        // Chat-depth-only injection controls: shown only when position === atDepth.
        const positionVal = Number(root.find('#luker_rpg_memory_recall_inject_position').val());
        const isAtDepth = positionVal === Number(world_info_position.atDepth);
        root.find('#luker_rpg_memory_recall_inject_depth_block').toggle(isAtDepth);
        root.find('#luker_rpg_memory_recall_inject_role_block').toggle(isAtDepth);
    }
    updateRecallMethodVisibility();

    root.find('#luker_rpg_memory_recall_method').off('change').on('change', function () {
        settings.recallMethod = String(jQuery(this).val() || 'llm').trim();
        updateRecallMethodVisibility();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_vector_topk').off('change input').on('change input', function () {
        settings.vectorTopK = Math.max(5, Math.min(100, Math.floor(Number(jQuery(this).val()) || 20)));
        jQuery(this).val(String(settings.vectorTopK));
        saveSettingsDebounced();
    });
    root.find('#luker_rpg_memory_hybrid_max_results').off('change input').on('change input', function () {
        settings.hybridMaxResults = Math.max(3, Math.min(50, Math.floor(Number(jQuery(this).val()) || 15)));
        jQuery(this).val(String(settings.hybridMaxResults));
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_embedding_profile').off('change').on('change', function () {
        settings.embeddingProfileId = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_rerank_profile').off('change').on('change', function () {
        settings.rerankProfileId = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_rag_use_rerank').off('input').on('input', function () {
        settings.ragUseRerank = Boolean(jQuery(this).prop('checked'));
        updateRecallMethodVisibility();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_rag_use_query_rewrite').off('input').on('input', function () {
        settings.ragUseQueryRewrite = Boolean(jQuery(this).prop('checked'));
        updateRecallMethodVisibility();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_rag_rewrite_api_preset').off('change').on('change', function () {
        settings.ragRewriteApiPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_rag_rewrite_llm_preset').off('change').on('change', function () {
        settings.ragRewriteLlmPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    [event_types.CONNECTION_PROFILE_CREATED, event_types.CONNECTION_PROFILE_UPDATED, event_types.CONNECTION_PROFILE_DELETED].forEach(evt => {
        eventSource.on(evt, () => {
            refreshMemoryEmbeddingSelect();
            refreshMemoryRerankSelect();
        });
    });

    root.find('#luker_rpg_memory_recall_inject_position').off('change').on('change', function () {
        settings.recallInjectPosition = normalizeRecallInjectPosition(jQuery(this).val());
        jQuery(this).val(String(settings.recallInjectPosition));
        updateRecallMethodVisibility();
        void syncPersistentProjectionForCurrentChat(getContext());
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_recall_inject_depth').off('change input').on('change input', function (event) {
        settings.recallInjectDepth = normalizeRecallInjectDepth(jQuery(this).val());
        jQuery(this).val(String(settings.recallInjectDepth));
        if (event?.type === 'change') {
            void syncPersistentProjectionForCurrentChat(getContext());
        }
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_recall_inject_role').off('change').on('change', function () {
        settings.recallInjectRole = normalizeRecallInjectRole(jQuery(this).val());
        jQuery(this).val(String(settings.recallInjectRole));
        void syncPersistentProjectionForCurrentChat(getContext());
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_recall_api_preset').off('change').on('change', function () {
        settings.recallApiPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_recall_preset').off('change').on('change', function () {
        settings.recallPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_extract_api_preset').off('change').on('change', function () {
        settings.extractApiPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_extract_preset').off('change').on('change', function () {
        settings.extractPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_request_api_preset').off('change').on('change', function () {
        settings.requestApiPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_request_llm_preset').off('change').on('change', function () {
        settings.requestLlmPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_update_every').off('change input').on('change input', function () {
        const nextValue = Math.max(1, Math.floor(Number(jQuery(this).val()) || defaultSettings.updateEvery));
        settings.updateEvery = nextValue;
        jQuery(this).val(String(nextValue));
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_open_schema_editor').off('click').on('click', async function () {
        await openSchemaEditorPopup(context, settings, root);
    });
    root.find('#luker_rpg_memory_open_schema_studio').off('click').on('click', async function () {
        await openSchemaIterationStudio({
            context,
            settings,
            root,
            normalizeNodeTypeSchema,
            getEffectiveNodeTypeSchema,
            getEffectiveSettings,
            getSchemaScopeInfo,
            persistCharacterSchemaOverride,
            saveSettings,
            i18n,
            i18nFormat,
            refreshRootUi: (uiRoot) => {
                if (!uiRoot?.length) {
                    return;
                }
                const nextScopeInfo = getSchemaScopeInfo(context, settings);
                updateSchemaSummary(uiRoot, nextScopeInfo.schema);
                updateSchemaScopeIndicator(uiRoot, nextScopeInfo);
            },
        });
    });
    // Advanced tab: change handlers on the 14 fields — apply to live settings
    // immediately (in-memory) but do NOT persist. Dirty note appears until a
    // scope save button is clicked (or a fresh bindUi() clears the note).
    const advancedFieldSelectors = [
        '#luker_rpg_memory_advanced_include_world_info',
        '#luker_rpg_memory_advanced_recent_raw_turns',
        '#luker_rpg_memory_advanced_recall_iterations',
        '#luker_rpg_memory_advanced_tool_retries',
        '#luker_rpg_memory_advanced_rpm_limit',
        '#luker_rpg_memory_advanced_extract_context_turns',
        '#luker_rpg_memory_advanced_extract_exclude_recent_turns',
        '#luker_rpg_memory_advanced_recall_query_messages',
        '#luker_rpg_memory_advanced_llm_visible_recent_messages',
        '#luker_rpg_memory_advanced_extract_batch_turns',
        '#luker_rpg_memory_advanced_extract_system_prompt',
        '#luker_rpg_memory_advanced_recall_route_prompt',
        '#luker_rpg_memory_advanced_recall_finalize_prompt',
        '#luker_rpg_memory_advanced_rag_rewrite_prompt',
        '#luker_rpg_memory_advanced_schema_iter_system_prompt',
    ].join(', ');
    root.find(advancedFieldSelectors).off('input change').on('input change', function () {
        applyAdvancedTabToLiveSettings(root, settings);
    });

    root.find('#luker_rpg_memory_advanced_reset').off('click').on('click', function () {
        if (!window.confirm(i18n('Reset advanced settings editor to default? This will overwrite current unsaved advanced edits.'))) {
            return;
        }
        hydrateAdvancedTabFields(root, defaultSettings);
        applyAdvancedTabToLiveSettings(root, settings);
        notifySuccess(i18n('Advanced settings reset to defaults in editor.'));
    });

    root.find('#luker_rpg_memory_advanced_save_global').off('click').on('click', async function () {
        // Ensure form values are applied to memory first, then persist to global.
        applyAdvancedTabToLiveSettings(root, settings);
        const info = getAdvancedScopeInfo(context, settings);
        await persistAdvancedToGlobal(settings, info.settings);
        syncGenerationVisibleHistoryRuntimeRegexScripts();
        const nextScopeInfo = getAdvancedScopeInfo(context, settings);
        updateAdvancedScopeIndicator(root, nextScopeInfo);
        root.find('#luker_rpg_memory_advanced_save_character').prop('disabled', !nextScopeInfo.hasAvatar);
        root.find('#luker_rpg_memory_advanced_clear_character_override').prop('disabled', !(nextScopeInfo.hasAvatar && nextScopeInfo.hasOverride));
        markAdvancedTabDirty(root, false);
        notifySuccess(i18n('Advanced settings saved to global settings.'));
        updateUiStatus(i18n('Advanced settings saved to global settings.'));
    });
    root.find('#luker_rpg_memory_advanced_save_character').off('click').on('click', async function () {
        const info = getAdvancedScopeInfo(context, settings);
        if (!info.hasAvatar) {
            notifyError(i18n('No active character selected.'));
            return;
        }
        applyAdvancedTabToLiveSettings(root, settings);
        const refreshedInfo = getAdvancedScopeInfo(context, settings);
        const ok = await persistAdvancedToCharacter(context, refreshedInfo.avatar, refreshedInfo.settings);
        if (!ok) {
            notifyError(i18n('Failed to persist character advanced override.'));
            return;
        }
        syncGenerationVisibleHistoryRuntimeRegexScripts();
        const nextScopeInfo = getAdvancedScopeInfo(context, settings);
        updateAdvancedScopeIndicator(root, nextScopeInfo);
        root.find('#luker_rpg_memory_advanced_save_character').prop('disabled', !nextScopeInfo.hasAvatar);
        root.find('#luker_rpg_memory_advanced_clear_character_override').prop('disabled', !(nextScopeInfo.hasAvatar && nextScopeInfo.hasOverride));
        markAdvancedTabDirty(root, false);
        notifySuccess(i18nFormat('Advanced settings saved to character override: ${0}.', nextScopeInfo.characterName || refreshedInfo.characterName || refreshedInfo.avatar));
        updateUiStatus(i18nFormat('Advanced settings saved to character override: ${0}.', nextScopeInfo.characterName || refreshedInfo.characterName || refreshedInfo.avatar));
    });
    root.find('#luker_rpg_memory_advanced_clear_character_override').off('click').on('click', async function () {
        const info = getAdvancedScopeInfo(context, settings);
        if (!info.hasAvatar) {
            notifyError(i18n('No active character selected.'));
            return;
        }
        const ok = await removeCharacterAdvancedOverride(context, info.avatar);
        if (!ok) {
            notifyError(i18n('Failed to clear character advanced override.'));
            return;
        }
        syncGenerationVisibleHistoryRuntimeRegexScripts();
        const nextScopeInfo = getAdvancedScopeInfo(context, settings);
        updateAdvancedScopeIndicator(root, nextScopeInfo);
        root.find('#luker_rpg_memory_advanced_save_character').prop('disabled', !nextScopeInfo.hasAvatar);
        root.find('#luker_rpg_memory_advanced_clear_character_override').prop('disabled', !(nextScopeInfo.hasAvatar && nextScopeInfo.hasOverride));
        // After clearing, form should reflect the freshly-effective settings (global values).
        hydrateAdvancedTabFields(root, nextScopeInfo.settings);
        // Also apply back to live settings so any dirty in-memory state is discarded.
        applyAdvancedSettings(settings, nextScopeInfo.settings);
        markAdvancedTabDirty(root, false);
        notifySuccess(i18nFormat('Cleared character advanced override: ${0}.', info.characterName || info.avatar));
        updateUiStatus(i18nFormat('Cleared character advanced override: ${0}.', info.characterName || info.avatar));
    });

    root.find('#luker_rpg_memory_view_graph').off('click').on('click', async function () {
        await openGraphInspectorPopup(context);
    });

    root.find('#luker_rpg_memory_fill').off('click').on('click', async function () {
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
    });

    root.find('#luker_rpg_memory_recall_debug').off('click').on('click', async function () {
        await ensureStoreSyncedWithChat(context);
        const store = getMemoryStore(context);
        if (!store) {
            notifyError(i18n('No active chat selected.'));
            return;
        }
        const query = String(root.find('#luker_rpg_memory_debug_query').val() || '');
        const effectiveSettings = getEffectiveSettings(context, getSettings());
        const payload = {
            coreChat: buildRecallDebugCoreChat(context, query, effectiveSettings),
            forceWorldInfoResimulate: true,
        };

        const recallMethod = String(effectiveSettings.recallMethod || 'llm').trim().toLowerCase();
        let selectedNodes = [];
        let trace = [];

        if (recallMethod === 'rag') {
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

            const ragResult = await runRagRecall(store, queryText, chatKey, effectiveSettings, {
                maxResults: Number(effectiveSettings.hybridMaxResults) || 15,
                vectorTopK: Number(effectiveSettings.vectorTopK) || 20,
                useRerank,
                rerankProfile,
                rewrittenQuery,
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
    });

    root.find('#luker_rpg_memory_view_last_injection').off('click').on('click', async function () {
        await ensureMemoryStoreLoaded(context);
        const store = getMemoryStore(context);
        if (!store) {
            notifyError(i18n('No active chat selected.'));
            return;
        }
        ensureInjectionViewerBindings();
        const html = buildLastRecallCorePacketHtml(store, { showHeader: true });
        await context.callGenericPopup(html, context.POPUP_TYPE.TEXT, i18n('View Last Injection'), { wide: true, large: true });
    });

    root.find('#luker_rpg_memory_rebuild').off('click').on('click', async function () {
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
            });

    root.find('#luker_rpg_memory_rebuild_recent').off('click').on('click', async function () {
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

        const defaultRecentTurns = Math.min(20, latestSeq);
        const input = await context.callGenericPopup(
            i18nFormat('Rebuild recent assistant turns: enter N (1-${0}).', latestSeq),
            context.POPUP_TYPE.INPUT,
            String(defaultRecentTurns),
            { okButton: i18n('Rebuild Recent'), cancelButton: i18n('Cancel') },
        );
        if (!input || typeof input !== 'string') {
            return;
        }
        const trimmed = String(input).trim();
        if (!/^\d+$/.test(trimmed)) {
            notifyError(i18nFormat('Please enter a valid integer between 1 and ${0}.', latestSeq));
            return;
        }
        const recentTurns = Number(trimmed);
        if (!Number.isFinite(recentTurns) || recentTurns < 1 || recentTurns > latestSeq) {
            notifyError(i18nFormat('Please enter a valid integer between 1 and ${0}.', latestSeq));
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
            });

    root.find('#luker_rpg_memory_manual_compress').off('click').on('click', async function () {
        await openManualCompressionPopup(context, getEffectiveSettings(context, settings));
    });

    root.find('#luker_rpg_memory_reset').off('click').on('click', async function () {
        const confirm = await context.callGenericPopup(
            i18n('Reset current chat memory graph? This cannot be undone.'),
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: i18n('Reset'), cancelButton: i18n('Cancel') },
        );
        if (confirm !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
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
    });

    root.find('#luker_rpg_memory_recompute_vectors').off('click').on('click', async function () {
        await openVectorRecomputePopup(context, getEffectiveSettings(context, settings));
    });

    const importFileInput = root.find('#luker_rpg_memory_import_file');

    root.find('#luker_rpg_memory_export').off('click').on('click', async function () {
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
    });

    root.find('#luker_rpg_memory_import').off('click').on('click', function () {
        if (!importFileInput.length) {
            notifyError(i18n('Memory graph import failed.'));
            return;
        }
        importFileInput.val('');
        importFileInput.trigger('click');
    });

    importFileInput.off('change').on('change', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) {
            return;
        }
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
    });
}

function ensureUi() {
    const host = jQuery('#extensions_settings2');
    if (!host.length) {
        return;
    }

    ensureStyles();

    if (jQuery(`#${UI_BLOCK_ID}`).length) {
        bindUi();
        return;
    }

    const html = buildMemoryGraphSettingsHtml({
        escapeHtml,
        extension_prompt_roles,
        i18n,
        UI_BLOCK_ID,
        world_info_position,
    });

    host.append(html);
    bindUi();
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
    // Post-recovery notice: if the log is empty on disk but __meta
    // records that extraction previously processed messages, the log
    // was almost certainly wiped by a broken-log recovery cycle. Tell
    // the user their history was quarantined to __orphans so they can
    // Import a backup instead of assuming the empty graph is normal.
    const effectiveMeta = meta || getCachedMeta(chatKey);
    const seenSourceCount = Number(effectiveMeta?.sourceMessageCount || 0);
    if (logSize === 0 && payloadHasNoNodes && Number.isFinite(seenSourceCount) && seenSourceCount > 0) {
        notifyError(i18nFormat(
            'Memory graph is empty but state records ${0} previously-processed message(s). The log was likely cleared by a recovery cycle; the pre-recovery log is preserved in the __orphans backup. Use Import to restore from a backup if you have one.',
            seenSourceCount,
        ));
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
    //   shrink:              committed < fromSeq <= latestSeq — the
    //                        not-yet-committed tail is now stale; lower
    //                        latestSeq so the loop winds down at
    //                        fromSeq - 1 on its next batch check.
    //   abort_committed_hit: fromSeq <= committed — already-committed
    //                        work covers the affected region; abort and
    //                        let the store refresh below re-materialize
    //                        from the (core-settled) floor-state log.
    //   abort_no_metadata:   no scope or no fromSeq; conservative abort
    //                        preserves the pre-refactor behaviour.
    if (activeExtractionAbortController && !activeExtractionAbortController.signal.aborted) {
        const scope = activeExtractionScope;
        let decision;
        if (normalizedFromSeq === null || !scope) {
            decision = 'abort_no_metadata';
        } else if (normalizedFromSeq <= scope.committedSeq) {
            decision = 'abort_committed_hit';
        } else if (normalizedFromSeq <= scope.latestSeq) {
            decision = 'shrink';
        } else {
            decision = 'noop';
        }
        if (decision === 'abort_no_metadata' || decision === 'abort_committed_hit') {
            if (isCurrentChat) {
                clearRuntimeInfoToast('extraction');
            }
            activeExtractionAbortController.abort();
        } else if (decision === 'shrink') {
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

jQuery(() => {
    const context = getContext();
    registerLocaleData();
    ensureSettings();
    configureCharacterOverrides({
        MODULE_NAME,
        defaultSettings,
        normalizeNodeTypeSchema,
        normalizeAdvancedSettings,
        getSettings,
    });
    generationVisibleHistoryRegexProvider = registerManagedRegexProvider(GENERATION_VISIBLE_HISTORY_REGEX_PROVIDER_ID);
    syncGenerationVisibleHistoryRuntimeRegexScripts();
    saveSettingsDebounced();
    ensureUi();
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
        ensureUi();
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
    if (context.eventTypes.PRESET_CHANGED) {
        context.eventSource.on(context.eventTypes.PRESET_CHANGED, (event) => {
            if (String(event?.apiId || '') === 'openai') {
                ensureUi();
            }
        });
    }
    const connectionProfileEvents = [
        context.eventTypes.CONNECTION_PROFILE_LOADED,
        context.eventTypes.CONNECTION_PROFILE_CREATED,
        context.eventTypes.CONNECTION_PROFILE_DELETED,
        context.eventTypes.CONNECTION_PROFILE_UPDATED,
    ].filter(Boolean);
    for (const eventName of connectionProfileEvents) {
        context.eventSource.on(eventName, () => ensureUi());
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
