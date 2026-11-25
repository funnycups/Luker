// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

/**
 * Internal default configuration table for the Memory Graph extension.
 *
 * Centralizes shipped defaults, built-in node-type schema definitions,
 * relation vocabularies, and managed lorebook defaults so runtime modules
 * read from one canonical source of truth.
 */

import { DEFAULT_EVENT_COMPRESS_INSTRUCTION } from './default-prompts.js';
import { DEFAULT_PER_TYPE_INSTRUCTIONS } from './extraction-schedule.js';
import { ADVANCED_SETTING_DEFAULTS } from './config-iteration/advanced-settings.js';
import { LEVEL } from './primitives.js';

const __ctx = Luker.getContext();
const extension_prompt_roles = __ctx.constants.promptRoles;
const world_info_position = __ctx.constants.wiPosition;
const newWorldInfoEntryTemplate = __ctx.worldInfoEntry.template;

export const MODULE_NAME = 'memory_graph';
export const RECALL_INJECT_POSITION_SCHEMA_VERSION = 2;

export const SUPPORTED_WORLD_INFO_POSITIONS = Object.freeze([
    world_info_position.before,
    world_info_position.after,
    world_info_position.ANTop,
    world_info_position.ANBottom,
    world_info_position.EMTop,
    world_info_position.EMBottom,
    world_info_position.atDepth,
]);

export const DEFAULT_EVENT_SUMMARY_COLUMN_HINT = 'A prose body covering event skeleton, key decisions, and causal chains, with the in-world time and place anchors at the top and three optional structured sections at the end (不可逆 / 未结 / 原文摘录, all default empty). See the event summary writing standard for the exact format and section gating.';
export const DEFAULT_EVENT_EXTRACT_HINT = 'Critical plot events, turning points, commitments, betrayals, irreversible outcomes — written as a prose body with an in-world time and place anchor at the top, plus three optional sections at the end (不可逆 / 未结 / 原文摘录, default empty).';

// Built-in node types shipped as the default schema.
export const defaultNodeTypeSchema = [
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

// Symmetric relations collapse direction: A→B and B→A merge into a single
// canonical edge sorted by node id.
export const SYMMETRIC_RELATIONS = new Set([
    'allied_with',
    'hostile_to',
    'family_of',
    'partner_of',
    'related',
]);

export const CANONICAL_EXTRACT_RELATION_TYPES = Object.freeze([
    // Generic graph relations
    'related', 'involved_in', 'occurred_at', 'mentions', 'evidence', 'updates', 'advances',
    // Symmetric character-character relations
    'partner_of', 'family_of', 'allied_with', 'hostile_to',
    // Directed character-character relations (from = action originator)
    'mentor_of', 'sworn_to', 'debt_owed_to', 'deceiving',
]);

export const CANONICAL_EXTRACT_RELATION_TYPES_TEXT = CANONICAL_EXTRACT_RELATION_TYPES.join(', ');

export const defaultSettings = {
    enabled: false,
    autoExtractionEnabled: true,
    autoCompressionEnabled: true,
    ...ADVANCED_SETTING_DEFAULTS,
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
    lorebookEntryOrderBase: 9800,
    nodeTypeSchema: defaultNodeTypeSchema,
    embeddingProfileId: '',
    rerankProfileId: '',
    vectorTopK: 20,
    hybridMaxResults: 15,
    // RAG per-type bucketing: default quota per node type (0 disables bucketing).
    ragDefaultPerTypeK: 3,
    ragUseRerank: false,
    ragUseQueryRewrite: false,
    ragRewriteApiPresetName: '',
    ragRewriteLlmPresetName: '',
};

export const DEFAULT_MANAGED_LOREBOOK_ENTRY_CONFIG = Object.freeze({
    position: Number(newWorldInfoEntryTemplate.position ?? world_info_position.before),
    depth: Math.max(0, Math.floor(Number(newWorldInfoEntryTemplate.depth ?? 4) || 0)),
    role: [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT]
        .includes(Number(newWorldInfoEntryTemplate.role))
        ? Number(newWorldInfoEntryTemplate.role)
        : extension_prompt_roles.SYSTEM,
});
