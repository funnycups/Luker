// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import {
    applyLorasToWorkflow,
    inspectLoraTemplate,
    LORA_NAME_PLACEHOLDER,
} from './lora/workflow.js';
import {
    applyReferencesToWorkflow,
    inspectReferenceSlots,
    REF_IMAGE_SINGLE_PLACEHOLDER,
} from './reference/workflow.js';

export const DEFAULT_COMFY_SETTING_PLACEHOLDERS = [
    'model',
    'vae',
    'sampler',
    'scheduler',
    'steps',
    'scale',
    'width',
    'height',
];

const PLACEHOLDER_SCAN_RE = /%[a-zA-Z0-9_]+%/g;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const UNSAFE_FILENAME_CHAR_RE = /[<>:"/\\|?*]/;
const DEFAULT_SETTING_FALLBACKS = Object.freeze({
    model: '',
    vae: '',
    sampler: 'euler',
    scheduler: 'normal',
    steps: 20,
    scale: 7,
    width: 512,
    height: 512,
});

function isPlainObject(val) {
    return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function isLink(val) {
    return Array.isArray(val)
        && val.length === 2
        && typeof val[0] === 'string'
        && Number.isInteger(val[1]);
}

export function sortComfyNodeIds(ids) {
    return [...ids].sort((a, b) => {
        const aInt = /^\d+$/.test(a);
        const bInt = /^\d+$/.test(b);
        if (aInt && bInt) {
            return Number(a) - Number(b);
        }
        if (aInt) return -1;
        if (bInt) return 1;
        return a.localeCompare(b);
    });
}

/**
 * Normalize and validate a ComfyUI workflow file name (`*.json` only, no path traversal).
 * @param {unknown} rawName
 * @returns {string}
 */
export function normalizeWorkflowFileName(rawName) {
    const trimmed = String(rawName ?? '').trim();
    if (
        !trimmed
        || trimmed.startsWith('.')
        || trimmed.endsWith('.')
        || trimmed.includes('..')
        || UNSAFE_FILENAME_CHAR_RE.test(trimmed)
        || CONTROL_CHAR_RE.test(trimmed)
        || trimmed.toLowerCase() === '.json'
    ) {
        throw new Error(`Invalid ComfyUI workflow file name: "${trimmed}"`);
    }
    return trimmed.toLowerCase().endsWith('.json') ? trimmed : `${trimmed}.json`;
}

/**
 * Validate a ComfyUI API-format workflow graph, rejecting LiteGraph UI exports,
 * dangling links, cyclic edges, and malformed `%lora_name%` / `%ref_image%` templates.
 *
 * @param {unknown} graph
 * @returns {{
 *   ok: true,
 *   graph: Record<string, any>,
 *   summary: {
 *     nodeCount: number,
 *     placeholders: string[],
 *     loraTemplate: { nodeId: string, hasModelStrength: boolean, hasClipStrength: boolean } | null,
 *     referenceSlots: { slotCount: number, mode: 'none' | 'single' | 'numbered', nodesBySlot: Array<{ slot: number, nodeId: string }> }
 *   }
 * } | { ok: false, code: string, error: string }}
 */
export function validateComfyWorkflowGraph(graph) {
    if (!isPlainObject(graph)) {
        return {
            ok: false,
            code: 'invalid_graph',
            error: 'ComfyUI workflow must be a JSON object keyed by node ID.',
        };
    }

    if (Array.isArray(graph.nodes) && Array.isArray(graph.links)) {
        return {
            ok: false,
            code: 'ui_format_unsupported',
            error: 'This JSON is in ComfyUI LiteGraph UI canvas format (contains "nodes" and "links" arrays), not API format. Enable Dev Mode in ComfyUI Settings and click "Save (API Format)", or rebuild the workflow nodes in API format keyed by node ID.',
        };
    }

    const rawEntries = Object.entries(graph);
    if (rawEntries.length === 0) {
        return {
            ok: false,
            code: 'empty_graph',
            error: 'ComfyUI workflow graph cannot be empty.',
        };
    }

    /** @type {Record<string, any>} */
    const normalizedGraph = {};
    /** @type {Set<string>} */
    const discoveredPlaceholders = new Set();

    for (const [rawId, rawNode] of rawEntries) {
        const nodeId = String(rawId).trim();
        if (!nodeId) {
            return {
                ok: false,
                code: 'invalid_node_id',
                error: 'ComfyUI workflow contains an empty node ID key.',
            };
        }
        if (!isPlainObject(rawNode)) {
            return {
                ok: false,
                code: 'invalid_node',
                error: `Workflow node "${nodeId}" must be a JSON object.`,
            };
        }
        const classType = typeof rawNode.class_type === 'string' ? rawNode.class_type.trim() : '';
        if (!classType) {
            return {
                ok: false,
                code: 'missing_class_type',
                error: `Workflow node "${nodeId}" is missing a non-empty string class_type.`,
            };
        }
        if (rawNode.inputs !== undefined && !isPlainObject(rawNode.inputs)) {
            return {
                ok: false,
                code: 'invalid_inputs',
                error: `Workflow node "${nodeId}" (${classType}) must have a plain object for inputs.`,
            };
        }

        const clonedNode = JSON.parse(JSON.stringify(rawNode));
        clonedNode.class_type = classType;
        clonedNode.inputs = isPlainObject(clonedNode.inputs) ? clonedNode.inputs : {};

        for (const [inputName, val] of Object.entries(clonedNode.inputs)) {
            if (typeof val === 'string') {
                const matches = val.match(PLACEHOLDER_SCAN_RE);
                if (matches) {
                    for (const token of matches) {
                        discoveredPlaceholders.add(token);
                    }
                }
                continue;
            }
            if (Array.isArray(val)) {
                if (val.length === 2 && typeof val[0] === 'number' && Number.isInteger(val[1])) {
                    return {
                        ok: false,
                        code: 'invalid_link_format',
                        error: `Workflow node "${nodeId}" (${classType}) input "${inputName}" uses numeric node ID [${val[0]}, ${val[1]}]; ComfyUI API links require string node IDs like ["${val[0]}", ${val[1]}].`,
                    };
                }
                if (isLink(val)) {
                    if (val[1] < 0) {
                        return {
                            ok: false,
                            code: 'invalid_link_slot',
                            error: `Workflow node "${nodeId}" (${classType}) input "${inputName}" has negative output slot index ${val[1]}.`,
                        };
                    }
                    if (!Object.hasOwn(graph, val[0])) {
                        return {
                            ok: false,
                            code: 'dangling_link',
                            error: `Workflow node "${nodeId}" (${classType}) input "${inputName}" references missing upstream node "${val[0]}".`,
                        };
                    }
                }
            }
        }

        normalizedGraph[nodeId] = clonedNode;
    }

    // Detect cyclic dependencies across [upstreamNodeId, slotIndex] links.
    /** @type {Map<string, number>} 0 = unvisited, 1 = visiting, 2 = visited */
    const visitState = new Map();
    /** @type {string[]} */
    const stack = [];

    function dfs(nodeId) {
        visitState.set(nodeId, 1);
        stack.push(nodeId);
        const inputs = normalizedGraph[nodeId]?.inputs || {};
        for (const val of Object.values(inputs)) {
            if (!isLink(val)) continue;
            const targetId = val[0];
            const st = visitState.get(targetId) || 0;
            if (st === 1) {
                const startIdx = stack.indexOf(targetId);
                const cycleChain = [...stack.slice(startIdx), targetId].join(' -> ');
                return `Cyclic node link detected in ComfyUI workflow: ${cycleChain}`;
            }
            if (st === 0) {
                const err = dfs(targetId);
                if (err) return err;
            }
        }
        stack.pop();
        visitState.set(nodeId, 2);
        return null;
    }

    for (const nodeId of sortComfyNodeIds(Object.keys(normalizedGraph))) {
        if ((visitState.get(nodeId) || 0) === 0) {
            const cycleError = dfs(nodeId);
            if (cycleError) {
                return {
                    ok: false,
                    code: 'graph_cycle',
                    error: cycleError,
                };
            }
        }
    }

    let loraTemplate = null;
    try {
        loraTemplate = inspectLoraTemplate(normalizedGraph);
        if (loraTemplate) {
            applyLorasToWorkflow(normalizedGraph, []);
        }
    } catch (err) {
        return {
            ok: false,
            code: String(err?.code || 'invalid_lora_template'),
            error: String(err?.message || err),
        };
    }

    let refInfo;
    try {
        refInfo = inspectReferenceSlots(normalizedGraph);
    } catch (err) {
        return {
            ok: false,
            code: String(err?.code || 'invalid_reference_slots'),
            error: String(err?.message || err),
        };
    }

    /** @type {'none' | 'single' | 'numbered'} */
    let refMode = 'none';
    if (refInfo.slotCount > 0) {
        const firstNodeId = refInfo.nodesBySlot[0]?.nodeId;
        const firstRaw = String(normalizedGraph[firstNodeId]?.inputs?.image || '').trim();
        refMode = refInfo.slotCount === 1 && firstRaw === REF_IMAGE_SINGLE_PLACEHOLDER ? 'single' : 'numbered';
    }

    return {
        ok: true,
        graph: normalizedGraph,
        summary: {
            nodeCount: Object.keys(normalizedGraph).length,
            placeholders: [...discoveredPlaceholders].sort(),
            loraTemplate,
            referenceSlots: {
                slotCount: refInfo.slotCount,
                mode: refMode,
                nodesBySlot: refInfo.nodesBySlot,
            },
        },
    };
}

function formatSingleNodeLine(nodeId, node) {
    const cls = String(node?.class_type || 'Unknown');
    const title = String(node?._meta?.title || '').trim();
    const titlePart = title && title !== cls ? ` ("${title}")` : '';
    const inputs = isPlainObject(node?.inputs) ? node.inputs : {};
    const parts = Object.entries(inputs).map(([key, val]) => {
        if (isLink(val)) {
            return `${key}: -> #${val[0]}:${val[1]}`;
        }
        return `${key}: ${JSON.stringify(val)}`;
    });
    return `[${nodeId}] ${cls}${titlePart} <- { ${parts.join(', ')} }`;
}

/**
 * Render an LLM-friendly Unix-style topology summary (and optional node subset view).
 *
 * @param {string} fileName
 * @param {Record<string, any>} graph
 * @param {{ isActive?: boolean, rawError?: string, nodeIds?: string[] }} [options]
 * @returns {string}
 */
export function formatWorkflowTopology(fileName, graph, options = {}) {
    const activeSuffix = options.isActive ? ' (active)' : '';
    if (options.rawError) {
        const header = `${fileName}${activeSuffix} [INVALID JSON: ${options.rawError}]`;
        return options.rawText ? `${header}\n${options.rawText}` : header;
    }
    if (!isPlainObject(graph)) {
        return `${fileName}${activeSuffix} [INVALID GRAPH]`;
    }

    const validation = validateComfyWorkflowGraph(graph);
    const lines = [];
    if (validation.ok) {
        const { nodeCount, placeholders, loraTemplate, referenceSlots } = validation.summary;
        const loraDesc = loraTemplate
            ? `node #${loraTemplate.nodeId} (${graph[loraTemplate.nodeId]?.class_type})`
            : 'none';
        const refDesc = referenceSlots.slotCount > 0
            ? `${referenceSlots.slotCount} (${referenceSlots.nodesBySlot.map(s => `#${s.nodeId} slot${s.slot}`).join(', ')})`
            : '0';
        lines.push(`${fileName}${activeSuffix} — nodes=${nodeCount}, lora_template=${loraDesc}, ref_slots=${refDesc}`);
        lines.push(`placeholders: ${placeholders.length > 0 ? placeholders.join(', ') : '(none)'}`);
    } else {
        lines.push(`${fileName}${activeSuffix} [VALIDATION ERROR (${validation.code}): ${validation.error}]`);
    }

    const allIds = sortComfyNodeIds(Object.keys(graph));
    const requestedIds = Array.isArray(options.nodeIds)
        ? options.nodeIds.map(id => String(id).trim()).filter(Boolean)
        : [];

    if (requestedIds.length === 0) {
        for (const id of allIds) {
            lines.push(formatSingleNodeLine(id, graph[id]));
        }
        return lines.join('\n');
    }

    const requestedSet = new Set(requestedIds);
    const adjacentSet = new Set();
    for (const reqId of requestedSet) {
        const reqNode = graph[reqId];
        if (isPlainObject(reqNode?.inputs)) {
            for (const val of Object.values(reqNode.inputs)) {
                if (isLink(val) && Object.hasOwn(graph, val[0]) && !requestedSet.has(val[0])) {
                    adjacentSet.add(val[0]);
                }
            }
        }
    }
    for (const id of allIds) {
        if (requestedSet.has(id)) continue;
        const inputs = graph[id]?.inputs;
        if (!isPlainObject(inputs)) continue;
        for (const val of Object.values(inputs)) {
            if (isLink(val) && requestedSet.has(val[0])) {
                adjacentSet.add(id);
            }
        }
    }

    for (const id of allIds) {
        if (requestedSet.has(id)) {
            lines.push(formatSingleNodeLine(id, graph[id]));
        } else if (adjacentSet.has(id)) {
            lines.push(`${formatSingleNodeLine(id, graph[id])}  # adjacent`);
        }
    }

    const missing = requestedIds.filter(id => !Object.hasOwn(graph, id));
    if (missing.length > 0) {
        lines.push(`missing_node_ids: ${missing.join(', ')}`);
    }

    const exactSubset = {};
    for (const id of requestedIds) {
        if (Object.hasOwn(graph, id)) {
            exactSubset[id] = graph[id];
        }
    }
    if (Object.keys(exactSubset).length > 0) {
        lines.push('nodes_json:');
        lines.push(JSON.stringify(exactSubset, null, 2));
    }

    return lines.join('\n');
}

/**
 * Substitute Luker ComfyUI placeholders, prune/bind `%ref_image%` slots, and
 * expand `%lora_name%` chains into a ready-to-POST ComfyUI `{ prompt }` JSON payload.
 *
 * @param {object} options
 * @param {string | Record<string, any>} options.workflowText
 * @param {string} options.prompt
 * @param {string} [options.negativePrompt]
 * @param {Record<string, any>} [options.sdSettings]
 * @param {string[]} [options.settingPlaceholders]
 * @param {Array<{ find: string, replace: string }>} [options.customPlaceholders]
 * @param {(raw: string) => string} [options.substituteFn]
 * @param {string[]} [options.uploadedFilenames]
 * @param {Array<{ name: string, weight?: number }>} [options.loras]
 * @param {Record<string, any>} [options.extraOptions]
 * @param {string} [options.userAvatarBase64]
 * @param {string} [options.charAvatarBase64]
 * @returns {{ promptPayload: string, seed: number, slotInfo: { slotCount: number, mode: 'none' | 'single' | 'numbered' } }}
 */
export function compileComfyWorkflowPromptPayload({
    workflowText,
    prompt,
    negativePrompt = '',
    sdSettings = {},
    settingPlaceholders = DEFAULT_COMFY_SETTING_PLACEHOLDERS,
    customPlaceholders = [],
    substituteFn,
    uploadedFilenames = [],
    loras = [],
    extraOptions = {},
    userAvatarBase64,
    charAvatarBase64,
}) {
    let workflow = typeof workflowText === 'string' ? workflowText : JSON.stringify(workflowText);
    const replaceToken = (token, val) => {
        const encoded = JSON.stringify(val === undefined ? null : val);
        workflow = workflow.replaceAll(`"%${token}%"`, () => encoded);
    };

    replaceToken('prompt', String(prompt ?? ''));
    replaceToken('negative_prompt', String(negativePrompt ?? ''));

    const explicitSeed = extraOptions?.seed ?? sdSettings?.seed;
    const seed = explicitSeed >= 0 ? explicitSeed : Math.round(Math.random() * Number.MAX_SAFE_INTEGER);
    replaceToken('seed', seed);

    const denoisingStrength = sdSettings?.denoising_strength === undefined ? 1.0 : sdSettings.denoising_strength;
    replaceToken('denoise', denoisingStrength);

    const clipSkip = isNaN(sdSettings?.clip_skip) ? -1 : -sdSettings.clip_skip;
    replaceToken('clip_skip', clipSkip);

    for (const ph of settingPlaceholders) {
        const rawOverride = ph === 'width' && extraOptions?.width !== undefined
            ? extraOptions.width
            : (ph === 'height' && extraOptions?.height !== undefined ? extraOptions.height : sdSettings?.[ph]);
        const resolvedVal = rawOverride === undefined ? (DEFAULT_SETTING_FALLBACKS[ph] ?? '') : rawOverride;
        replaceToken(ph, resolvedVal);
    }

    for (const ph of (customPlaceholders ?? [])) {
        if (!ph || !ph.find) continue;
        const resolved = substituteFn ? substituteFn(String(ph.replace ?? '')) : String(ph.replace ?? '');
        replaceToken(ph.find, resolved);
    }

    if (userAvatarBase64 !== undefined && /%user_avatar%/gi.test(workflow)) {
        replaceToken('user_avatar', userAvatarBase64);
    }
    if (charAvatarBase64 !== undefined && /%char_avatar%/gi.test(workflow)) {
        replaceToken('char_avatar', charAvatarBase64);
    }

    const refInfo = inspectReferenceSlots(workflow);
    /** @type {'none' | 'single' | 'numbered'} */
    let refMode = 'none';
    if (refInfo.slotCount > 0) {
        refMode = refInfo.slotCount === 1 && workflow.includes(`"${REF_IMAGE_SINGLE_PLACEHOLDER}"`)
            ? 'single'
            : 'numbered';
    }

    const normalizedLoras = Array.isArray(loras)
        ? loras
            .filter(item => item && String(item.name || '').trim())
            .map(item => ({
                name: String(item.name).trim(),
                weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : 1,
            }))
        : [];

    let graph = JSON.parse(workflow);
    if (refInfo.slotCount > 0 || uploadedFilenames.length > 0) {
        graph = applyReferencesToWorkflow(graph, uploadedFilenames);
    }
    if (workflow.includes(LORA_NAME_PLACEHOLDER) || normalizedLoras.length > 0) {
        graph = applyLorasToWorkflow(graph, normalizedLoras);
    }
    const promptPayload = JSON.stringify({ prompt: graph });

    return {
        promptPayload,
        seed,
        slotInfo: {
            slotCount: refInfo.slotCount,
            mode: refMode,
        },
    };
}
