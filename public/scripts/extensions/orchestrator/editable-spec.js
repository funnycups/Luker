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
 *   - `sanitizePresetMap` / `mergePresetMaps` normalize an arbitrary
 *     preset map before it lands either in storage or in an editor draft.
 *   - `toEditablePresetMap` / `toEditableSpec` convert from persistence
 *     shape to editor shape, ensuring at minimum a `distiller` preset and
 *     one default stage with one node.
 *   - `serializeEditorSpec` / `serializeEditorPresetMap` go the other
 *     way for save / export.
 *   - `sanitizeIdentifierToken(value, fallback)` is the shared id slug
 *     helper — kebab-friendly characters only, replaces whitespace with
 *     underscore, falls back to the supplied default when the value
 *     normalizes to empty.
 *   - `resolveOverridePresetMap(override, basePresets)` returns the
 *     effective preset map for a per-character override, honoring both
 *     the modern `override.presets` shape and the legacy `override.presetPatch`
 *     fallback that merges into the base map.
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

export function sanitizeIdentifierToken(value, fallback = '') {
    const normalized = String(value || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_-]/g, '_');
    return normalized || String(fallback || '');
}

export function createPresetDraft(seed = {}) {
    return {
        systemPrompt: String(seed.systemPrompt || '').trim(),
        userPromptTemplate: String(seed.userPromptTemplate || '').trim(),
        apiPresetName: getPresetApiPresetName(seed),
        promptPresetName: getPresetPromptPresetName(seed),
    };
}

export function createAgendaPlannerDraft(seed = {}) {
    const source = typeof seed === 'string'
        ? { userPromptTemplate: seed }
        : (seed && typeof seed === 'object' ? seed : {});
    return createPresetDraft({
        ...defaultAgendaPlanner,
        ...source,
        systemPrompt: String(source.systemPrompt || defaultAgendaPlanner.systemPrompt).trim(),
        userPromptTemplate: String(source.userPromptTemplate || defaultAgendaPlanner.userPromptTemplate).trim(),
    });
}

export function sanitizePresetMap(presets) {
    if (!presets || typeof presets !== 'object') {
        return {};
    }

    const normalized = {};
    for (const [key, value] of Object.entries(presets)) {
        if (!value || typeof value !== 'object') {
            continue;
        }
        const presetId = sanitizeIdentifierToken(key, '');
        if (!presetId) {
            continue;
        }
        normalized[presetId] = createPresetDraft(value);
    }

    return normalized;
}

export function mergePresetMaps(basePresets, patchPresets) {
    const base = sanitizePresetMap(basePresets);
    const patchSource = patchPresets && typeof patchPresets === 'object' ? patchPresets : {};
    const merged = { ...base };

    for (const [key, rawValue] of Object.entries(patchSource)) {
        if (!rawValue || typeof rawValue !== 'object') {
            continue;
        }
        const presetId = sanitizeIdentifierToken(key, '');
        if (!presetId) {
            continue;
        }
        merged[presetId] = createPresetDraft({
            ...(base[presetId] || {}),
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
            const stageId = sanitizeIdentifierToken(stage?.id, `stage_${stageIndex + 1}`);
            const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
            const normalizedNodes = nodes.map((node, nodeIndex) => {
                const normalizedNode = normalizeNodeSpec(node);
                const preset = sanitizeIdentifierToken(normalizedNode.preset || normalizedNode.id, defaultPreset);
                if (!presets[preset]) {
                    presets[preset] = createPresetDraft();
                }
                return {
                    id: sanitizeIdentifierToken(normalizedNode.id || preset, `node_${nodeIndex + 1}`),
                    preset,
                    type: normalizeNodeType(normalizedNode.type),
                    userPromptTemplate: String(normalizedNode.userPromptTemplate || ''),
                };
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
                    }],
            };
        })
        .filter(stage => stage.nodes.length > 0);

    if (stages.length > 0) {
        return { stages };
    }

    return {
        stages: [{
            id: 'distill',
            mode: 'serial',
            nodes: [{
                id: defaultPreset,
                preset: defaultPreset,
                type: ORCH_NODE_TYPE_WORKER,
                userPromptTemplate: '',
            }],
        }],
    };
}

export function serializeEditorSpec(editorSpec) {
    const stages = Array.isArray(editorSpec?.stages) ? editorSpec.stages : [];
    return sanitizeSpec({
        stages: stages
            .map((stage, stageIndex) => ({
                id: sanitizeIdentifierToken(stage?.id, `stage_${stageIndex + 1}`),
                mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
                nodes: (Array.isArray(stage?.nodes) ? stage.nodes : [])
                    .map((node, nodeIndex) => {
                        const id = sanitizeIdentifierToken(node?.id, `node_${nodeIndex + 1}`);
                        const preset = sanitizeIdentifierToken(node?.preset, id);
                        const userPromptTemplate = String(node?.userPromptTemplate || '').trim();

                        const serialized = { id, preset, type: normalizeNodeType(node?.type) };
                        if (userPromptTemplate) {
                            serialized.userPromptTemplate = userPromptTemplate;
                        }
                        return serialized;
                    })
                    .filter(Boolean),
            }))
            .filter(stage => Array.isArray(stage.nodes) && stage.nodes.length > 0),
    });
}

export function serializeEditorPresetMap(editorPresets) {
    return sanitizePresetMap(editorPresets || {});
}

export function resolveOverridePresetMap(override, basePresets = {}) {
    if (override?.presets && typeof override.presets === 'object') {
        return sanitizePresetMap(override.presets);
    }
    // Legacy compatibility: older overrides stored only presetPatch.
    if (override?.presetPatch && typeof override.presetPatch === 'object') {
        return mergePresetMaps(basePresets, override.presetPatch);
    }
    return {};
}
