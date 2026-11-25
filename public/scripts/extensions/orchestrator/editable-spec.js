/**
 * Editable spec / preset map transforms used by the orchestrator UI.
 *
 * The orchestration spec is stored in two shapes:
 *
 *   - **Persistence shape** (`{ stages: [{ id, mode, nodes }] }`) — what
 *     `extension_settings.orchestrator.orchestrationSpec` and per-character
 *     overrides hold on disk. This shape is sanitized by `spec-schema.js`.
 *
 *   - **Editor shape** — the same data plus per-node UI affordances (a
 *     stable `preset` id, a `userPromptTemplate` text always present even
 *     if empty, and a fully-populated preset map keyed by `preset`).
 *
 * This module owns the bidirectional conversion plus the small helpers
 * the editor leans on:
 *
 *   - `createPresetDraft(seed)` returns the editable preset object —
 *     fields are always present (empty string vs missing) and pass
 *     through `apiPresetName` / `promptPresetName` from `agent-resolution.js`.
 *   - `createAgendaPlannerDraft(seed)` is the agenda planner equivalent,
 *     pre-seeded with `defaultAgendaPlanner`.
 *   - `sanitizePresetMap` normalizes an arbitrary preset map before it
 *     lands either in storage or in an editor draft. Values go through
 *     `createPresetDraft`; keys are kept verbatim because nodes reference
 *     presets by the stored key.
 *   - `toEditablePresetMap` / `toEditableSpec` convert from persistence
 *     shape to editor shape, ensuring at minimum a `distiller` preset and
 *     one default stage with one node.
 *   - `serializeEditorSpec` / `serializeEditorPresetMap` go the other
 *     way for save / export.
 *   - `normalizeIdToken(value, fallback)` is the shared id helper for
 *     preset keys, stage / node ids and agent ids: it trims and falls
 *     back to the supplied default when the value is empty. Ids are
 *     otherwise kept as written — any non-empty string is a valid JSON
 *     key and every DOM use escapes it — so ids in any script stay
 *     addressable and distinct ids never merge.
 *   - `resolveStoredIdToken` / `resolveStoredIdReference` resolve a
 *     requested id or a reference against the stored keys.
 *
 * All functions are pure and side-effect-free except for the in-place
 * `presets[defaultPreset] = …` writes in `toEditableSpec`, which mutates
 * the caller-supplied editor presets map by design.
 */

import {
    ORCH_NODE_TYPE_WORKER,
    defaultAgendaPlanner,
} from './defaults.js';
import {
    getPresetApiPresetName,
    getPresetPromptPresetName,
} from './agent-resolution.js';
import {
    normalizeNodeSpec,
    normalizeNodeType,
    sanitizeSpec,
} from './spec-schema.js';
import { sanitizeOptionalAgentToolFlags } from './persistence.js';
import { initializePromptDefaults } from '../../lib/prompt-values.js';

function cloneSkillsField(skills) {
    if (!skills || typeof skills !== 'object') return undefined;
    return {
        visible: Array.isArray(skills.visible) ? skills.visible.slice() : [],
        deny: Array.isArray(skills.deny) ? skills.deny.slice() : [],
    };
}

export function normalizeIdToken(value, fallback = '') {
    const normalized = value === null || value === undefined ? '' : String(value).trim();
    return normalized || String(fallback || '');
}

/**
 * Resolve a requested id against stored ids, which are kept verbatim.
 * An exact match wins — the raw request first, then its trimmed form —
 * then a unique stored id that equals the request after trimming. Several
 * stored ids matching at the same step is ambiguous rather than "first".
 *
 * @param {string[]} storedIds
 * @param {unknown} value requested id
 * @returns {{ status: 'empty' }
 *   | { status: 'found', id: string, index: number }
 *   | { status: 'missing', id: string }
 *   | { status: 'ambiguous', id: string, matches: string[] }}
 *   `index` is the position in `storedIds`; `missing` carries the trimmed
 *   request for callers that create the id.
 */
export function resolveStoredIdToken(storedIds, value) {
    const raw = value === null || value === undefined ? '' : String(value);
    const trimmed = raw.trim();
    if (!trimmed) {
        return { status: 'empty' };
    }
    const ids = (Array.isArray(storedIds) ? storedIds : []).map(id => String(id ?? ''));
    const matchesOf = predicate => ids.reduce((out, id, index) => (predicate(id) ? [...out, index] : out), []);
    for (const predicate of [id => id === raw, id => id === trimmed, id => id.trim() === trimmed]) {
        const indexes = matchesOf(predicate);
        if (indexes.length === 1) {
            return { status: 'found', id: ids[indexes[0]], index: indexes[0] };
        }
        if (indexes.length > 1) {
            return { status: 'ambiguous', id: trimmed, matches: indexes.map(index => ids[index]) };
        }
    }
    return { status: 'missing', id: trimmed };
}

/**
 * Resolve a reference to a key of `map` with `resolveStoredIdToken`.
 * Returns the stored key it resolves to, otherwise the trimmed reference,
 * which is then not a key: an ambiguous reference reads as missing.
 *
 * @param {object} map keyed by stored ids
 * @param {unknown} value reference
 * @returns {string}
 */
export function resolveStoredIdReference(map, value) {
    const resolved = resolveStoredIdToken(Object.keys(map && typeof map === 'object' ? map : {}), value);
    return resolved.status === 'found' ? resolved.id : normalizeIdToken(value);
}

export function createPresetDraft(seed = {}) {
    const out = {
        systemPrompt: String(seed.systemPrompt ?? ''),
        userPromptTemplate: String(seed.userPromptTemplate ?? ''),
        apiPresetName: getPresetApiPresetName(seed),
        promptPresetName: getPresetPromptPresetName(seed),
        // null = inherit from profile.defaultTools at runtime; an object =
        // per-preset override (spec node / agenda agent / loop). The
        // sanitizer canonicalizes the shape (missing flags default OFF in
        // this opt-in path; loop mode does its own all-on layering).
        tools: sanitizeOptionalAgentToolFlags(seed.tools),
    };
    // Per-preset skills (opt-in). Mirrors normalizeNodeSpec — left undefined
    // when absent so the resolver inherits the mode default. Carries an
    // explicit value through unchanged otherwise.
    if (seed && typeof seed === 'object' && seed.skills && typeof seed.skills === 'object') {
        out.skills = {
            visible: Array.isArray(seed.skills.visible) ? seed.skills.visible.slice() : [],
            deny: Array.isArray(seed.skills.deny) ? seed.skills.deny.slice() : [],
        };
    }
    return out;
}

export function createAgendaPlannerDraft(seed = {}) {
    const source = typeof seed === 'string'
        ? { userPromptTemplate: seed }
        : (seed && typeof seed === 'object' ? seed : {});
    const planner = { ...source };
    initializePromptDefaults(planner, {
        systemPrompt: defaultAgendaPlanner.systemPrompt,
        userPromptTemplate: defaultAgendaPlanner.userPromptTemplate,
    });
    return { ...createPresetDraft(planner), promptDefaultsInitialized: true };
}

const FORBIDDEN_PRESET_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function sanitizePresetMap(presets) {
    if (!presets || typeof presets !== 'object') {
        return {};
    }

    const normalized = {};
    for (const [key, value] of Object.entries(presets)) {
        if (FORBIDDEN_PRESET_KEYS.has(key)) {
            continue;
        }
        const presetId = normalizeIdToken(key);
        if (!value || typeof value !== 'object' || !presetId || FORBIDDEN_PRESET_KEYS.has(presetId)) {
            continue;
        }
        normalized[key] = createPresetDraft(value);
    }

    return normalized;
}

export function mergePresetMaps(basePresets, patchPresets) {
    const base = sanitizePresetMap(basePresets);
    const patchSource = patchPresets && typeof patchPresets === 'object' ? patchPresets : {};
    const merged = { ...base };

    for (const [key, rawValue] of Object.entries(patchSource)) {
        if (FORBIDDEN_PRESET_KEYS.has(key)) {
            continue;
        }
        const presetId = normalizeIdToken(key);
        if (!rawValue || typeof rawValue !== 'object' || !presetId || FORBIDDEN_PRESET_KEYS.has(presetId)) {
            continue;
        }
        const targetKey = Object.prototype.hasOwnProperty.call(base, key) ? key : presetId;
        merged[targetKey] = createPresetDraft({
            ...(base[targetKey] || {}),
            ...rawValue,
        });
    }

    return sanitizePresetMap(merged);
}
export function toEditablePresetMap(presets) {
    const normalized = {};
    const source = sanitizePresetMap(presets);
    for (const [key, value] of Object.entries(source)) {
        normalized[key] = createPresetDraft(value);
    }
    return normalized;
}

export function toEditableSpec(spec, presets) {
    const sanitized = sanitizeSpec(spec);
    const presetIds = Object.keys(presets);
    const defaultPreset = presetIds[0] || 'distiller';
    if (!presets[defaultPreset]) {
        presets[defaultPreset] = createPresetDraft();
    }

    const stages = (Array.isArray(sanitized.stages) ? sanitized.stages : [])
        .map((stage, stageIndex) => {
            const stageId = normalizeIdToken(stage?.id, `stage_${stageIndex + 1}`);
            const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
            const normalizedNodes = nodes.map((node, nodeIndex) => {
                const normalizedNode = normalizeNodeSpec(node);
                const presetRef = normalizedNode.preset || normalizedNode.id;
                const resolvedPreset = resolveStoredIdToken(Object.keys(presets), presetRef);
                const preset = resolvedPreset.status === 'found'
                    ? resolvedPreset.id
                    : normalizeIdToken(presetRef, defaultPreset);
                // An ambiguous ref stays missing rather than gaining an
                // empty preset that would then win the exact match.
                if (!presets[preset] && resolvedPreset.status !== 'ambiguous') {
                    presets[preset] = createPresetDraft();
                }
                const editableNode = {
                    id: normalizeIdToken(normalizedNode.id || preset, `node_${nodeIndex + 1}`),
                    preset,
                    type: normalizeNodeType(normalizedNode.type),
                    userPromptTemplate: String(normalizedNode.userPromptTemplate || ''),
                    // null = inherit profile defaultTools; object = explicit override.
                    tools: sanitizeOptionalAgentToolFlags(normalizedNode.tools),
                };
                const skills = cloneSkillsField(normalizedNode.skills);
                if (skills) editableNode.skills = skills;
                return editableNode;
            });
            return {
                id: stageId,
                mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
                nodes: normalizedNodes.length > 0
                    ? normalizedNodes
                    : [{
                        id: defaultPreset,
                        preset: defaultPreset,
                        type: ORCH_NODE_TYPE_WORKER,
                        userPromptTemplate: '',
                        tools: null,
                    }],
            };
        })
        .filter(stage => stage.nodes.length > 0);

    const rootExtras = {
        // sanitizeSpec already canonicalized these — pass through verbatim
        // so the editor renders the persisted state, including explicit
        // null (no profile default) and the full custom-tool list.
        defaultTools: sanitized.defaultTools === undefined ? null : sanitized.defaultTools,
        customTools: Array.isArray(sanitized.customTools) ? sanitized.customTools : [],
        // Carried so an emptied custom tool list is not re-seeded with
        // the defaults when the draft is serialized back.
        seededDefaultCustomTools: sanitized.seededDefaultCustomTools === true,
        skills: cloneSkillsField(sanitized.skills) || { visible: ['*'], deny: [] },
        // Round-trip the per-preset lorebook filter: sanitizeSpec always
        // emits a canonical `{ bookPattern, entryPattern }` shape, so the
        // editor draft carries it verbatim for the popup textareas.
        lorebookFilter: sanitized.lorebookFilter || { bookPattern: '', entryPattern: '' },
    };

    if (stages.length > 0) {
        return { ...rootExtras, stages };
    }

    return {
        ...rootExtras,
        stages: [{
            id: 'distill',
            mode: 'serial',
            nodes: [{
                id: defaultPreset,
                preset: defaultPreset,
                type: ORCH_NODE_TYPE_WORKER,
                userPromptTemplate: '',
                tools: null,
            }],
        }],
    };
}

export function serializeEditorSpec(editorSpec) {
    const stages = Array.isArray(editorSpec?.stages) ? editorSpec.stages : [];
    // defaultTools: explicit null = "no profile default" — preserve.
    // Undefined / missing key = unset; pass through so sanitizeSpec's
    // fresh-profile seeder reseeds Layer-2 customs once. Object = user
    // edit; pass through for sanitization.
    const hasDefaultToolsKey = editorSpec
        && Object.prototype.hasOwnProperty.call(editorSpec, 'defaultTools');
    const payload = {
        stages: stages
            .map((stage, stageIndex) => ({
                id: normalizeIdToken(stage?.id, `stage_${stageIndex + 1}`),
                mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
                nodes: (Array.isArray(stage?.nodes) ? stage.nodes : [])
                    .map((node, nodeIndex) => {
                        const id = normalizeIdToken(node?.id, `node_${nodeIndex + 1}`);
                        const preset = normalizeIdToken(node?.preset, id);
                        const userPromptTemplate = String(node?.userPromptTemplate || '').trim();

                        const serialized = { id, preset, type: normalizeNodeType(node?.type) };
                        if (userPromptTemplate) {
                            serialized.userPromptTemplate = userPromptTemplate;
                        }
                        // Per-node tool override: null = inherit (omit so
                        // sanitizer carries null through); object = explicit
                        // override (let sanitizer canonicalize the shape).
                        if (node?.tools !== undefined) {
                            serialized.tools = node.tools;
                        }
                        const skills = cloneSkillsField(node?.skills);
                        if (skills) serialized.skills = skills;
                        return serialized;
                    })
                    .filter(Boolean),
            }))
            .filter(stage => Array.isArray(stage.nodes) && stage.nodes.length > 0),
        customTools: Array.isArray(editorSpec?.customTools) ? editorSpec.customTools : [],
        seededDefaultCustomTools: editorSpec?.seededDefaultCustomTools === true,
    };
    if (hasDefaultToolsKey) {
        payload.defaultTools = editorSpec.defaultTools;
    }
    const skills = cloneSkillsField(editorSpec?.skills);
    if (skills) payload.skills = skills;
    // Round-trip the per-preset lorebook filter through the sanitizer
    // so a bookPattern / entryPattern edited in the popup lands in
    // sanitizeSpec's output rather than being replaced by the empty
    // default when the payload is rebuilt here (Task 5).
    if (editorSpec && editorSpec.lorebookFilter !== undefined) {
        payload.lorebookFilter = editorSpec.lorebookFilter;
    }
    return sanitizeSpec(payload);
}

export function serializeEditorPresetMap(editorPresets) {
    return sanitizePresetMap(editorPresets || {});
}

/**
 * Build a spec editor draft from an iteration session's working profile
 * (`{ spec, presets }`), the shape the character-scope commit persists.
 */
export function createIterationEditorFromWorkingProfile(workingProfile) {
    const safeSpec = sanitizeSpec(workingProfile?.spec);
    const safePresets = sanitizePresetMap(workingProfile?.presets);
    return {
        spec: toEditableSpec(safeSpec, toEditablePresetMap(safePresets)),
        presets: toEditablePresetMap(safePresets),
    };
}

/**
 * Whether a node of `spec` references the stored preset key `presetId`.
 * Refs resolve against `presets` with `resolveStoredIdToken`; an ambiguous
 * ref counts as referencing every key it matches, since removing one of
 * them would make the ref resolve to another.
 */
export function isPresetReferencedInSpec(spec, presetId, presets) {
    const targetPresetId = String(presetId ?? '');
    if (!normalizeIdToken(targetPresetId)) {
        return false;
    }
    const presetIds = Object.keys(presets && typeof presets === 'object' ? presets : {});
    const stages = Array.isArray(spec?.stages) ? spec.stages : [];
    return stages.some(stage =>
        (stage?.nodes || []).some(node => {
            const normalizedNode = normalizeNodeSpec(node);
            const resolved = resolveStoredIdToken(presetIds, normalizedNode?.preset || normalizedNode?.id);
            if (resolved.status === 'found') return resolved.id === targetPresetId;
            if (resolved.status === 'ambiguous') return resolved.matches.includes(targetPresetId);
            return false;
        }));
}
