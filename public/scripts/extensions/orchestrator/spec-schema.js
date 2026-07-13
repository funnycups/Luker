/**
 * Spec / preset schema helpers for the orchestrator.
 *
 * Pure helpers that operate on the orchestration *spec* shape — the
 * stages-and-nodes tree the user authors and the runtime walks.
 *
 *   - `cloneDefault` / `cloneJsonCompatible` — defensive deep-clones used
 *     when seeding fresh settings or copying snapshots so editors do not
 *     mutate shared defaults.
 *   - `normalizeNodeType` / `normalizeNodeSpec` — coerce hand-edited or
 *     loaded node entries (string preset id OR object node spec) into the
 *     canonical `{ id, preset, type, userPromptTemplate }` shape downstream
 *     code expects.
 *   - `sanitizeSpec` — strip the spec down to its safe shape, drop empty
 *     stages, and fall back to `defaultSpec` when the input is unusable.
 *   - `isReviewNodeSpec` / `getStageRuntimeMode` — runtime classification
 *     of a node / stage. A stage that contains a review node always runs
 *     serial regardless of its declared `mode`.
 *   - `getNodeIterationMaxRounds` / `getReviewRerunMaxRounds` — settings
 *     readers with sensible defaults; both fall back to live
 *     `extension_settings.orchestrator` when the caller passes no arg.
 *
 * `sanitizePresetMap` / `mergePresetMaps` / `ensureSettings` live in
 * main.js because they call into editor draft helpers
 * (`createPresetDraft`, `sanitizeIdentifierToken`, etc.) that own the
 * preset-editor UI state — they belong with the editor surface, not
 * with the spec schema.
 */

const extension_settings = Luker.getContext().extensionSettings;
import {
    ORCH_NODE_TYPE_REVIEW,
    ORCH_NODE_TYPE_WORKER,
    defaultSpec,
} from './defaults.js';
import { ORCH_EXECUTION_MODE_DIRECTOR, sanitizeDirectorProfile } from './director-defaults.js';
import { sanitizeAgentToolFlags, sanitizeOptionalAgentToolFlags, seedDefaultLayer2Customs } from './persistence.js';
import { sanitizeCustomTools } from './custom-tools-sanitize.js';
import { seedDefaultCustomToolsIfNeeded } from './seed-default-custom-tools.js';
import { sanitizeLorebookFilter } from './lorebook-filter.js';

const MODULE_NAME = 'orchestrator';

export function cloneDefault(value) {
    return Array.isArray(value) || typeof value === 'object' ? cloneJsonCompatible(value) : value;
}

export function cloneJsonCompatible(value) {
    if (value === undefined) {
        return undefined;
    }

    try {
        return structuredClone(value);
    } catch {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? undefined : JSON.parse(serialized);
    }
}

export function normalizeNodeType(value) {
    return String(value || '').trim().toLowerCase() === ORCH_NODE_TYPE_REVIEW
        ? ORCH_NODE_TYPE_REVIEW
        : ORCH_NODE_TYPE_WORKER;
}

export function normalizeNodeSpec(node) {
    if (typeof node === 'string') {
        return {
            id: node,
            preset: node,
            type: ORCH_NODE_TYPE_WORKER,
            userPromptTemplate: undefined,
            tools: null,
        };
    }

    const id = String(node?.id || node?.node || node?.preset || '').trim();
    const preset = String(node?.preset || id).trim();
    const out = {
        id: id || preset,
        preset,
        type: normalizeNodeType(node?.type),
        userPromptTemplate: typeof node?.userPromptTemplate === 'string' ? node.userPromptTemplate : undefined,
        // null = "inherit from profile defaultTools"; an object = explicit
        // per-node override. Sanitizer below normalizes the object shape so
        // missing flags fall to their default-off disposition.
        tools: sanitizeOptionalAgentToolFlags(node?.tools),
    };
    // Per-node skills (opt-in). Same shape as elsewhere; left undefined
    // when absent so the resolver knows to inherit the mode default.
    if (node && typeof node === 'object' && node.skills && typeof node.skills === 'object') {
        out.skills = {
            visible: Array.isArray(node.skills.visible) ? node.skills.visible.slice() : [],
            deny: Array.isArray(node.skills.deny) ? node.skills.deny.slice() : [],
        };
    }
    return out;
}

export function sanitizeSpec(spec) {
    if (!spec || typeof spec !== 'object') {
        return structuredClone(defaultSpec);
    }

    // Director-mode profiles are sanitized via their own branch — they own
    // a {director: {...}} shape, not the {stages, defaultTools} stages-spec
    // shape. The plan asks sanitizeSpec to route to the director sanitizer
    // when the input is recognized as a director profile.
    if (spec.mode === ORCH_EXECUTION_MODE_DIRECTOR) {
        return sanitizeDirectorProfile(spec);
    }

    const stages = Array.isArray(spec.stages) ? spec.stages : [];
    const normalizedStages = stages.map((stage, stageIndex) => {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const normalizedNodes = nodes
            .map(node => {
                if (typeof node === 'string') {
                    return node.trim();
                }
                if (node && typeof node === 'object') {
                    const compact = {
                        id: String(node.id || node.node || node.preset || '').trim(),
                        preset: String(node.preset || node.id || node.node || '').trim(),
                        type: normalizeNodeType(node.type),
                        userPromptTemplate: typeof node.userPromptTemplate === 'string' ? node.userPromptTemplate : undefined,
                        tools: sanitizeOptionalAgentToolFlags(node.tools),
                    };
                    if (!compact.id && compact.preset) {
                        compact.id = compact.preset;
                    }
                    if (!compact.preset && compact.id) {
                        compact.preset = compact.id;
                    }
                    // Per-node skills (opt-in). Mirror normalizeNodeSpec.
                    if (node.skills && typeof node.skills === 'object') {
                        compact.skills = {
                            visible: Array.isArray(node.skills.visible) ? node.skills.visible.slice() : [],
                            deny: Array.isArray(node.skills.deny) ? node.skills.deny.slice() : [],
                        };
                    }
                    return compact.id ? compact : null;
                }
                return null;
            })
            .filter(Boolean);

        return {
            id: String(stage?.id || `stage_${stageIndex + 1}`),
            mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
            nodes: normalizedNodes,
        };
    }).filter(stage => Array.isArray(stage.nodes) && stage.nodes.length > 0);

    const out = {
        stages: normalizedStages.length > 0 ? normalizedStages : structuredClone(defaultSpec.stages),
        // null = no profile-level default. An object = canonical tool
        // flags applied to any node whose own `tools` is null. The runtime
        // resolver picks node.tools first, then this, then mode's all-off
        // built-in default.
        //
        // Fresh profile (defaultTools key missing) gets the Layer-2
        // customs seed so memory + search ship enabled out of the box.
        // Explicit null is preserved as-is.
        defaultTools: sanitizeSpecProfileDefaultTools(spec),
        ...(() => {
            const seeded = seedDefaultCustomToolsIfNeeded(spec, sanitizeCustomTools(spec.customTools));
            return {
                customTools: seeded.customTools,
                seededDefaultCustomTools: seeded.seededDefaultCustomTools,
            };
        })(),
    };
    out.lorebookFilter = sanitizeLorebookFilter(spec.lorebookFilter);
    // Mode-level skills: ensure the runtime always reads a canonical
    // `{ visible, deny }` shape. Inline normalizer (see director-defaults.js
    // for rationale on not importing from skill-resolution.js).
    if (spec.skills && typeof spec.skills === 'object') {
        out.skills = {
            visible: Array.isArray(spec.skills.visible) ? spec.skills.visible.slice() : ['*'],
            deny: Array.isArray(spec.skills.deny) ? spec.skills.deny.slice() : [],
        };
    } else {
        out.skills = { visible: ['*'], deny: [] };
    }
    return out;
}

function sanitizeSpecProfileDefaultTools(spec) {
    const hasKey = spec && Object.prototype.hasOwnProperty.call(spec, 'defaultTools');
    if (!hasKey) {
        const seeded = seedDefaultLayer2Customs({});
        return sanitizeAgentToolFlags(seeded);
    }
    const raw = spec.defaultTools;
    if (raw === null) return null;
    if (raw === undefined) {
        const seeded = seedDefaultLayer2Customs({});
        return sanitizeAgentToolFlags(seeded);
    }
    const seeded = seedDefaultLayer2Customs(raw);
    return sanitizeAgentToolFlags(seeded);
}

export function isReviewNodeSpec(nodeSpec) {
    return normalizeNodeType(nodeSpec?.type) === ORCH_NODE_TYPE_REVIEW;
}

export function getStageRuntimeMode(stage) {
    const mode = String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
    const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
    return nodes.some(node => isReviewNodeSpec(normalizeNodeSpec(node))) ? 'serial' : mode;
}

export function getNodeIterationMaxRounds(settings = null) {
    const source = settings && typeof settings === 'object' ? settings : extension_settings[MODULE_NAME];
    return Math.max(1, Math.floor(Number(source?.nodeIterationMaxRounds) || 0));
}

export function getReviewRerunMaxRounds(settings = null) {
    const source = settings && typeof settings === 'object' ? settings : extension_settings[MODULE_NAME];
    return Math.max(0, Math.floor(Number(source?.reviewRerunMaxRounds) || 0));
}
