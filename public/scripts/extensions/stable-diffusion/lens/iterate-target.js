// SPDX-License-Identifier: AGPL-3.0-or-later

import { h } from '../../../lens-shared/util.js';
import {
    LOREBOOK_READ_TOOL_DEFS,
    isLorebookReadTool,
    runLorebookReadTool,
} from '../../../iteration-library/tools/lorebook-reads.js';
import { SourceError } from '../../../workbench/model/errors.js';
import {
    clone,
    commitFields,
    differingFields,
    fieldPlan,
    same,
    saveSettingsChecked,
} from '../../../workbench/model/patch.js';
import { diffUnits } from '../../../workbench/model/units.js';
import {
    CHARACTER_PROFILES_NAMESPACE,
    CHARACTER_PROFILES_VERSION,
    createCharacterProfileStore,
    normalizeCharacterProfile,
} from '../character-archive/store.js';
import {
    compileComfyWorkflowPromptPayload,
    formatWorkflowTopology,
    normalizeWorkflowFileName,
    sortComfyNodeIds,
    validateComfyWorkflowGraph,
} from '../comfy-workflow-graph.js';
import { patchGenerationPresetConfig } from '../generation-presets.js';
import { getDefaultPromptValues, makeIllustrationId } from '../illustration/presets.js';
import { getPresetById } from '../illustration/settings.js';
import { i18n } from './i18n.js';
import { simulateSdExploration, simulateSdIllustration } from './simulate.js';

export const DEFAULT_SD_ITERATE_PROMPT = `You are a configuration, visual-archive, and ComfyUI workflow editor for Luker's Image Generation and AI Illustration system.

Capabilities:
- Manage AI illustration prompt presets (name, promptStyle, illustrationPrompt, studioPrompt, explorationPrompt, visualInspection) via sd_list_presets, sd_read_preset, sd_create_preset, sd_update_preset, and sd_delete_preset.
- Simulate unsaved prompt changes in an isolated sandbox and open the Simulation Review popup for user inspection and annotations via sd_simulate_illustration (for illustrationPrompt, optionally allowing sandbox character exploration) and sd_simulate_exploration (for explorationPrompt, choosing mode "background" with targets or mode "dialog" with user_turns).
- Edit character visual archive profiles (description and reference_images) via sd_list_characters, sd_read_character, sd_upsert_character, and sd_delete_character, cross-checking bound lorebooks with world_book_list, lorebook_list, lorebook_query, and lorebook_get.
- Edit ComfyUI API-format workflows and custom placeholders via sd_list_workflows, sd_read_workflow, sd_create_workflow, sd_upsert_workflow_nodes, sd_remove_workflow_nodes, sd_delete_workflow, and sd_update_comfy_config.
- Query the user's connected ComfyUI server via sd_search_comfy_nodes and sd_inspect_comfy_node before wiring unfamiliar or custom nodes so class_type names, required inputs, enum filenames, and output slot indices match installed nodes.
- Validate draft workflows end-to-end without overwriting saved workflow files via sd_test_workflow_draft, and inspect recorded run traces via sd_read_run.

Luker ComfyUI placeholder rules:
- Standard scalar placeholders: "%prompt%", "%negative_prompt%", "%model%", "%vae%", "%sampler%", "%scheduler%", "%steps%", "%scale%", "%denoise%", "%clip_skip%", "%width%", "%height%", "%seed%".
- Dynamic LoRA chain template: insert at most ONE LoraLoader (model + clip) or LoraLoaderModelOnly (model) node with "lora_name": "%lora_name%", "strength_model": "%lora_strength_model%", and "strength_clip": "%lora_strength_clip%". At generation time Luker expands 0..N selected LoRAs automatically and bypasses the node when 0 LoRAs are selected.
- Reference image slots: use LoadImage nodes with "image": "%ref_image%" (single slot) or "%ref_image_1%", "%ref_image_2%", ... (numbered slots). Unused optional reference branches are pruned automatically at generation time.

All edits stage into a reviewable draft; keep explanations concise.`;

const READ_TOOL_NAMES = new Set([
    'sd_list_presets',
    'sd_read_preset',
    'sd_list_characters',
    'sd_read_character',
    'sd_read_run',
    'sd_list_workflows',
    'sd_read_workflow',
    'sd_search_comfy_nodes',
    'sd_inspect_comfy_node',
    'sd_test_workflow_draft',
    'sd_simulate_illustration',
    'sd_simulate_exploration',
]);

const SD_ITERATE_TOOLS = Object.freeze([
    {
        type: 'function',
        function: {
            name: 'sd_list_presets',
            description: 'List all AI illustration prompt presets in the working draft.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_read_preset',
            description: 'Read full prompt text and options of a specific AI illustration preset.',
            parameters: {
                type: 'object',
                properties: {
                    preset_id: { type: 'string', description: 'Preset id from sd_list_presets.' },
                },
                required: ['preset_id'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_list_characters',
            description: 'List compact summaries of all character profiles in the working draft.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_read_character',
            description: 'Read full plain-text description and reference images of a character profile in the working draft.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Character profile id.' },
                },
                required: ['id'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_read_run',
            description: 'Read a live or historical image generation / illustration run trace for diagnosis.',
            parameters: {
                type: 'object',
                properties: {
                    run_key: { type: 'string', description: 'Optional composite runKey such as sd:1. Omit to read the latest sd run.' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_list_workflows',
            description: 'List all ComfyUI workflows in the working draft with active state, node counts, LoRA template status, reference image slot count, and any JSON parse errors.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_read_workflow',
            description: 'Read topology connections and node definitions of a ComfyUI workflow in the draft. Omit node_ids to read the entire workflow.',
            parameters: {
                type: 'object',
                properties: {
                    file_name: { type: 'string', description: 'Workflow file name (defaults to the active workflow).' },
                    node_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional subset of node IDs to inspect along with their 1-hop adjacent nodes.',
                    },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_search_comfy_nodes',
            description: 'Search installed node classes on the connected ComfyUI server (/object_info) by keyword or category. Call with empty arguments to list node categories.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Case-insensitive multi-token search over class_type, display_name, category, and description.' },
                    category: { type: 'string', description: 'Category prefix filter (e.g. "loaders", "conditioning", "ipadapter").' },
                    refresh: { type: 'boolean', description: 'Bypass the 30s server cache when custom nodes were just installed.' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_inspect_comfy_node',
            description: 'Read exact required/optional input schemas, enum model/weight lists, and output slot indices for one or more ComfyUI node class_types on the connected server.',
            parameters: {
                type: 'object',
                properties: {
                    class_types: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'ComfyUI node class_type names to inspect.',
                    },
                    refresh: { type: 'boolean' },
                },
                required: ['class_types'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_test_workflow_draft',
            description: 'Compile and execute a ComfyUI workflow from the in-memory draft without modifying saved files on disk. Returns { ok: true, imagePath, seed } or { ok: false, error } with ComfyUI node execution errors.',
            parameters: {
                type: 'object',
                properties: {
                    file_name: { type: 'string', description: 'Draft workflow file name (defaults to draft activeWorkflow).' },
                    prompt: { type: 'string', description: 'Test positive prompt.' },
                    negative_prompt: { type: 'string', description: 'Test negative prompt.' },
                    loras: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                weight: { type: 'number' },
                            },
                            required: ['name'],
                            additionalProperties: false,
                        },
                    },
                    reference_image_paths: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional local Luker image paths (e.g. /user/images/_references/...) to upload and bind to %ref_image% slots.',
                    },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    seed: { type: 'number' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_simulate_illustration',
            description: 'Run the illustration agent and image generation against the unsaved working draft in an isolated sandbox, open Simulation Review for user inspection and annotations, and return the tagged text result without modifying chat, global character archive, or formal image storage.',
            parameters: {
                type: 'object',
                properties: {
                    preset_id: { type: 'string', description: 'Optional draft preset id (defaults to the current preset).' },
                    message_index: { type: 'integer', description: 'Optional 0-based chat message index to illustrate.' },
                    sample_message: { type: 'string', description: 'Optional sample assistant message text when testing without a chat or with custom text.' },
                    allow_exploration: { type: 'boolean', description: 'Whether the illustration agent may invoke sandbox explore_characters (default true).' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_simulate_exploration',
            description: 'Run the character profile agent against the unsaved working draft in an isolated sandbox in either "background" mode (requires targets) or "dialog" mode (requires user_turns), open Simulation Review for user inspection and annotations, and return the tagged text result without leaking state.',
            parameters: {
                type: 'object',
                properties: {
                    preset_id: { type: 'string', description: 'Optional draft preset id (defaults to the current preset).' },
                    mode: { type: 'string', enum: ['background', 'dialog'], description: 'Required execution mode: "background" for automatic exploration or "dialog" for multi-turn conversational building.' },
                    targets: {
                        type: 'array',
                        description: 'Required for mode "background": target characters to explore.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                work: { type: 'string' },
                                hint: { type: 'string' },
                            },
                            required: ['name'],
                            additionalProperties: false,
                        },
                    },
                    user_turns: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Required for mode "dialog": sequential user messages for real multi-turn replies.',
                    },
                    initial_profile_id: { type: 'string', description: 'Optional draft character profile id to refine in mode "dialog".' },
                    source: {
                        type: 'object',
                        description: 'Optional explicit local source policy (defaults to { kind: "none" }).',
                        properties: {
                            kind: { type: 'string', enum: ['none', 'card', 'persona'] },
                            card_avatar: { type: 'string' },
                        },
                        required: ['kind'],
                        additionalProperties: false,
                    },
                    user_hint: { type: 'string', description: 'Optional extra guidance for mode "background".' },
                },
                required: ['mode'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_create_preset',
            description: 'Create a new AI illustration prompt preset in the draft, optionally cloning an existing preset or seeding defaults from prompt_style.',
            parameters: {
                type: 'object',
                properties: {
                    preset_id: { type: 'string', description: 'Optional unique preset id. Omit to auto-generate one.' },
                    name: { type: 'string', description: 'Display name for the new prompt preset.' },
                    prompt_style: {
                        type: 'string',
                        enum: ['tag', 'natural'],
                        description: 'Default prompt style ("tag" or "natural"). Inherits from clone_from when omitted, or defaults to "tag".',
                    },
                    clone_from: { type: 'string', description: 'Optional existing draft preset_id to clone prompts and options from.' },
                    illustration_prompt: { type: 'string' },
                    studio_prompt: { type: 'string' },
                    exploration_prompt: { type: 'string' },
                    visual_inspection: { type: 'boolean' },
                },
                required: ['name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_update_preset',
            description: 'Update prompt fields, promptStyle, or visualInspection on an existing illustration preset in the draft.',
            parameters: {
                type: 'object',
                properties: {
                    preset_id: { type: 'string' },
                    name: { type: 'string' },
                    prompt_style: { type: 'string', enum: ['tag', 'natural'] },
                    illustration_prompt: { type: 'string' },
                    studio_prompt: { type: 'string' },
                    exploration_prompt: { type: 'string' },
                    visual_inspection: { type: 'boolean' },
                },
                required: ['preset_id'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_delete_preset',
            description: 'Delete an AI illustration prompt preset from the draft (cannot delete the last remaining preset).',
            parameters: {
                type: 'object',
                properties: {
                    preset_id: { type: 'string' },
                },
                required: ['preset_id'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_upsert_character',
            description: 'Create or update a character visual profile in the draft.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    aliases: { type: 'array', items: { type: 'string' } },
                    source_work: { type: 'string' },
                    description: {
                        type: 'string',
                        description: 'Structured plain-text visual description (appearance, attire variants, distinguishing traits, and Danbooru character tag if applicable).',
                    },
                    reference_images: {
                        type: 'array',
                        description: 'Reference image entries ({ path, label? }).',
                        items: {
                            type: 'object',
                            properties: {
                                path: { type: 'string' },
                                label: { type: 'string' },
                            },
                            required: ['path'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_delete_character',
            description: 'Remove a character visual profile from the draft.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                },
                required: ['id'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_create_workflow',
            description: 'Create or overwrite a ComfyUI API-format workflow in the draft by cloning an existing workflow or supplying a complete API-format node dictionary.',
            parameters: {
                type: 'object',
                properties: {
                    file_name: { type: 'string', description: 'Target workflow file name (e.g. "Flux_LoRA_Ref.json").' },
                    clone_from: { type: 'string', description: 'Existing draft workflow file name to clone from.' },
                    workflow_json: { type: 'object', description: 'Complete ComfyUI API-format graph keyed by string node IDs.' },
                    set_active: { type: 'boolean', description: 'Also set this workflow as the active ComfyUI workflow in the draft.' },
                },
                required: ['file_name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_upsert_workflow_nodes',
            description: 'Insert or replace one or more nodes in a draft ComfyUI workflow atomically, then validate all links, cycles, LoRA templates, and reference slots.',
            parameters: {
                type: 'object',
                properties: {
                    file_name: { type: 'string', description: 'Target workflow file name (defaults to active workflow).' },
                    nodes: {
                        type: 'object',
                        description: 'Map of nodeId -> { class_type, inputs, _meta? } to merge into the workflow.',
                    },
                },
                required: ['nodes'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_remove_workflow_nodes',
            description: 'Remove one or more node IDs from a draft ComfyUI workflow and verify no downstream nodes hold dangling links to them.',
            parameters: {
                type: 'object',
                properties: {
                    file_name: { type: 'string', description: 'Target workflow file name (defaults to active workflow).' },
                    node_ids: { type: 'array', items: { type: 'string' } },
                },
                required: ['node_ids'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_delete_workflow',
            description: 'Delete a ComfyUI workflow file from the draft (cannot delete the last remaining workflow).',
            parameters: {
                type: 'object',
                properties: {
                    file_name: { type: 'string' },
                },
                required: ['file_name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sd_update_comfy_config',
            description: 'Update the active ComfyUI workflow selection and/or custom %placeholder% substitutions in the draft.',
            parameters: {
                type: 'object',
                properties: {
                    active_workflow: { type: 'string' },
                    placeholders: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                find: { type: 'string' },
                                replace: { type: 'string' },
                            },
                            required: ['find', 'replace'],
                            additionalProperties: false,
                        },
                    },
                },
                additionalProperties: false,
            },
        },
    },
]);

function normalizePlaceholdersList(list) {
    if (!Array.isArray(list)) return [];
    return list
        .filter(item => item && String(item.find || '').trim())
        .map(item => ({
            find: String(item.find).trim(),
            replace: String(item.replace ?? ''),
        }));
}

function formatPresetUnitText(fields) {
    const lines = [
        `name: ${fields.name || ''}`,
        fields.promptStyle ? `promptStyle: ${fields.promptStyle}` : '',
        `visualInspection: ${Boolean(fields.visualInspection)}`,
        `--- illustrationPrompt ---\n${fields.illustrationPrompt || ''}`,
        `--- studioPrompt ---\n${fields.studioPrompt || ''}`,
    ].filter(Boolean);
    if (fields.explorationPrompt) {
        lines.push(`--- explorationPrompt ---\n${fields.explorationPrompt}`);
    }
    return lines.join('\n');
}

function formatCharacterUnitText(fields) {
    const refLines = (fields.referenceImages || []).map(r => (
        r.label ? `  - ${r.path} (${r.label})` : `  - ${r.path}`
    ));
    return [
        `name: ${fields.name || ''}`,
        fields.aliases?.length ? `aliases: ${fields.aliases.join(', ')}` : '',
        fields.sourceWork ? `work: ${fields.sourceWork}` : '',
        `description: ${fields.description || ''}`,
        refLines.length > 0 ? 'referenceImages:' : 'referenceImages: (none)',
        ...refLines,
    ].filter(Boolean).join('\n');
}

function buildWorkflowUnitFields(wf) {
    if (wf?.rawError) {
        return {
            __rawError: String(wf.rawError),
            __rawText: String(wf.rawText ?? ''),
        };
    }
    const fields = {};
    const graph = wf?.graph && typeof wf.graph === 'object' ? wf.graph : {};
    for (const nodeId of sortComfyNodeIds(Object.keys(graph))) {
        fields[`node:${nodeId}`] = clone(graph[nodeId]);
    }
    return fields;
}

function workflowEntryFromFields(fileName, fields) {
    if (fields?.__rawError) {
        return {
            fileName,
            graph: {},
            rawError: String(fields.__rawError),
            rawText: String(fields.__rawText ?? ''),
        };
    }
    const graph = {};
    const nodeKeys = Object.keys(fields || {})
        .filter(k => k.startsWith('node:') && fields[k] !== undefined)
        .map(k => k.slice('node:'.length));
    for (const nodeId of sortComfyNodeIds(nodeKeys)) {
        graph[nodeId] = clone(fields[`node:${nodeId}`]);
    }
    return {
        fileName,
        graph,
        rawError: '',
    };
}

function formatWorkflowUnitText(fileName, fields) {
    const wf = workflowEntryFromFields(fileName, fields);
    if (wf.rawError) {
        return `${fileName} [INVALID JSON: ${wf.rawError}]\n${wf.rawText || ''}`.trim();
    }
    const topo = formatWorkflowTopology(fileName, wf.graph);
    // Include canonical JSON of _meta keys beyond title if present so every field change alters unit.text.
    const metaExtras = [];
    for (const nodeId of sortComfyNodeIds(Object.keys(wf.graph))) {
        const node = wf.graph[nodeId];
        if (node?._meta && typeof node._meta === 'object') {
            const extraKeys = Object.keys(node._meta).filter(k => k !== 'title');
            if (extraKeys.length > 0) {
                metaExtras.push(`meta[${nodeId}]: ${JSON.stringify(node._meta)}`);
            }
        }
    }
    return metaExtras.length ? `${topo}\n${metaExtras.join('\n')}` : topo;
}

function formatComfyConfigUnitText(fields) {
    const placeholderLines = Array.isArray(fields?.placeholders) && fields.placeholders.length > 0
        ? fields.placeholders.map(p => `  - %${p.find}% = ${JSON.stringify(p.replace)}`)
        : ['  (none)'];
    return [
        `activeWorkflow: ${fields?.activeWorkflow || ''}`,
        'placeholders:',
        ...placeholderLines,
    ].join('\n');
}

function summarizeWorkflowNodeChanges(beforeFields, afterFields) {
    const changed = differingFields(beforeFields || {}, afterFields || {});
    const lines = [];
    for (const fKey of changed) {
        if (!fKey.startsWith('node:')) continue;
        const id = fKey.slice('node:'.length);
        const prev = beforeFields?.[fKey];
        const next = afterFields?.[fKey];
        if (!prev && next) {
            lines.push(`+ [${id}] ${next.class_type}`);
        } else if (prev && !next) {
            lines.push(`- [${id}] ${prev.class_type}`);
        } else if (prev && next) {
            lines.push(`~ [${id}] ${next.class_type}`);
        }
    }
    return lines;
}

export function buildSdUnits(doc) {
    const map = new Map();
    for (const preset of Array.isArray(doc?.presets) ? doc.presets : []) {
        if (!preset?.id) continue;
        const fields = {
            name: String(preset.name || ''),
            promptStyle: (preset.promptStyle === 'tag' || preset.promptStyle === 'natural') ? preset.promptStyle : '',
            illustrationPrompt: String(preset.illustrationPrompt || ''),
            studioPrompt: String(preset.studioPrompt || ''),
            explorationPrompt: String(preset.explorationPrompt || ''),
            visualInspection: Boolean(preset.visualInspection),
        };
        map.set(`preset:${preset.id}`, {
            key: `preset:${preset.id}`,
            label: fields.name || preset.id,
            group: i18n('Preset'),
            fields,
            text: formatPresetUnitText(fields),
        });
    }
    for (const char of Array.isArray(doc?.characters) ? doc.characters : []) {
        if (!char?.id) continue;
        const normalized = normalizeCharacterProfile(char);
        if (!normalized) continue;
        const fields = {
            name: normalized.name,
            aliases: clone(normalized.aliases),
            sourceWork: normalized.sourceWork,
            description: normalized.description,
            referenceImages: clone(normalized.referenceImages),
        };
        map.set(`character:${normalized.id}`, {
            key: `character:${normalized.id}`,
            label: fields.name || normalized.id,
            group: i18n('Character Archive'),
            fields,
            text: formatCharacterUnitText(fields),
        });
    }
    for (const wf of Array.isArray(doc?.workflows) ? doc.workflows : []) {
        if (!wf?.fileName) continue;
        const fields = buildWorkflowUnitFields(wf);
        map.set(`workflow:${wf.fileName}`, {
            key: `workflow:${wf.fileName}`,
            label: wf.fileName,
            group: i18n('ComfyUI Workflow'),
            fields,
            text: formatWorkflowUnitText(wf.fileName, fields),
        });
    }
    if (doc?.comfyConfig && typeof doc.comfyConfig === 'object') {
        const fields = {
            activeWorkflow: String(doc.comfyConfig.activeWorkflow || ''),
            placeholders: normalizePlaceholdersList(doc.comfyConfig.placeholders),
        };
        map.set('comfy:config', {
            key: 'comfy:config',
            label: i18n('Active workflow & custom placeholders'),
            group: i18n('ComfyUI Workflow'),
            fields,
            text: formatComfyConfigUnitText(fields),
        });
    }
    return map;
}

function applyOpsToSdDoc(doc, ops, { defaultLlm = null, defaultExplorationLlm = null } = {}) {
    const next = clone(doc || { presets: [], characters: [], workflows: [], comfyConfig: { activeWorkflow: '', placeholders: [] } });
    next.presets = Array.isArray(next.presets) ? next.presets : [];
    next.characters = Array.isArray(next.characters) ? next.characters : [];
    next.workflows = Array.isArray(next.workflows) ? next.workflows : [];
    next.comfyConfig = next.comfyConfig && typeof next.comfyConfig === 'object'
        ? {
            activeWorkflow: String(next.comfyConfig.activeWorkflow || ''),
            placeholders: normalizePlaceholdersList(next.comfyConfig.placeholders),
        }
        : { activeWorkflow: '', placeholders: [] };

    for (const op of ops) {
        if (op.key.startsWith('preset:')) {
            const id = op.key.slice('preset:'.length);
            if (op.kind === 'remove') {
                next.presets = next.presets.filter(p => p.id !== id);
                continue;
            }
            let target = next.presets.find(p => p.id === id);
            if (!target) {
                const styleChange = op.changes.find(c => c.field === 'promptStyle')?.after;
                const style = styleChange === 'natural' ? 'natural' : 'tag';
                const defaults = getDefaultPromptValues(style);
                const fallbackTemplate = next.presets[0] || null;
                const llmSource = defaultLlm || fallbackTemplate?.llm;
                const expLlmSource = defaultExplorationLlm || fallbackTemplate?.explorationLlm;
                target = {
                    id,
                    name: id,
                    promptStyle: style,
                    promptDefaultsInitialized: true,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    illustrationPrompt: defaults.illustrationPrompt,
                    studioPrompt: defaults.studioPrompt,
                    explorationPrompt: defaults.explorationPrompt,
                    llm: {
                        apiPresetName: String(llmSource?.apiPresetName || ''),
                        llmPresetName: String(llmSource?.llmPresetName || ''),
                    },
                    explorationLlm: {
                        apiPresetName: String(expLlmSource?.apiPresetName || ''),
                        llmPresetName: String(expLlmSource?.llmPresetName || ''),
                    },
                    visualInspection: false,
                };
                next.presets.push(target);
            }
            for (const c of op.changes) {
                if (op.kind === 'add'
                    && (c.field === 'illustrationPrompt' || c.field === 'studioPrompt' || c.field === 'explorationPrompt')
                    && !String(c.after ?? '').trim()) {
                    continue;
                }
                if (c.field === 'promptStyle') {
                    if (c.after === 'tag' || c.after === 'natural') {
                        target.promptStyle = c.after;
                    } else if (op.kind !== 'add') {
                        delete target.promptStyle;
                    }
                    continue;
                }
                target[c.field] = clone(c.after);
            }
            target.updatedAt = Date.now();
            continue;
        }

        if (op.key.startsWith('character:')) {
            const id = op.key.slice('character:'.length);
            if (op.kind === 'remove') {
                next.characters = next.characters.filter(ch => ch.id !== id);
                continue;
            }
            const idx = next.characters.findIndex(ch => ch.id === id);
            const raw = idx >= 0 ? { ...next.characters[idx] } : { id, name: id };
            for (const c of op.changes) {
                raw[c.field] = clone(c.after);
            }
            const normalized = normalizeCharacterProfile(raw);
            if (normalized) {
                if (idx >= 0) next.characters[idx] = normalized;
                else next.characters.push(normalized);
            }
            continue;
        }

        if (op.key.startsWith('workflow:')) {
            const fileName = op.key.slice('workflow:'.length);
            if (op.kind === 'remove') {
                next.workflows = next.workflows.filter(w => w.fileName !== fileName);
                continue;
            }
            const idx = next.workflows.findIndex(w => w.fileName === fileName);
            const fields = idx >= 0 ? buildWorkflowUnitFields(next.workflows[idx]) : {};
            for (const c of op.changes) {
                if (c.after === undefined) {
                    delete fields[c.field];
                } else {
                    fields[c.field] = clone(c.after);
                }
            }
            const updatedWf = workflowEntryFromFields(fileName, fields);
            if (idx >= 0) {
                next.workflows[idx] = updatedWf;
            } else {
                next.workflows.push(updatedWf);
            }
            next.workflows.sort((a, b) => a.fileName.localeCompare(b.fileName));
            continue;
        }

        if (op.key === 'comfy:config') {
            if (op.kind === 'remove') {
                next.comfyConfig = { activeWorkflow: '', placeholders: [] };
                continue;
            }
            for (const c of op.changes) {
                if (c.field === 'activeWorkflow') {
                    next.comfyConfig.activeWorkflow = String(c.after ?? '');
                } else if (c.field === 'placeholders') {
                    next.comfyConfig.placeholders = normalizePlaceholdersList(c.after);
                }
            }
        }
    }
    return next;
}

export async function fetchDiskWorkflows(ctx) {
    const headers = ctx?.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
    const listResp = await fetch('/api/sd/comfy/workflows', {
        method: 'POST',
        headers,
    });
    if (!listResp.ok) {
        throw new SourceError('read-failed', `Failed to list ComfyUI workflows (HTTP ${listResp.status}).`);
    }
    const names = await listResp.json();
    if (!Array.isArray(names)) {
        throw new SourceError('read-failed', 'ComfyUI workflow list endpoint did not return an array.');
    }

    const workflows = [];
    for (const rawName of names) {
        const fileName = String(rawName || '').trim();
        if (!fileName) continue;
        const wfResp = await fetch('/api/sd/comfy/workflow', {
            method: 'POST',
            headers,
            body: JSON.stringify({ file_name: fileName }),
        });
        if (!wfResp.ok) {
            throw new SourceError('read-failed', `Failed to read ComfyUI workflow "${fileName}" (HTTP ${wfResp.status}).`);
        }
        const rawText = await wfResp.json();
        try {
            const parsed = JSON.parse(String(rawText ?? ''));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                workflows.push({
                    fileName,
                    graph: {},
                    rawError: 'Root JSON value is not an object',
                    rawText: String(rawText ?? ''),
                });
            } else {
                workflows.push({
                    fileName,
                    graph: parsed,
                    rawError: '',
                });
            }
        } catch (err) {
            workflows.push({
                fileName,
                graph: {},
                rawError: String(err?.message || err),
                rawText: String(rawText ?? ''),
            });
        }
    }
    workflows.sort((a, b) => a.fileName.localeCompare(b.fileName));
    return workflows;
}

function serializeWorkflowEntry(wf) {
    if (wf?.rawError) {
        return String(wf.rawText ?? '');
    }
    return JSON.stringify(wf?.graph || {}, null, 2);
}

function pickFallbackActiveWorkflow(workflows) {
    const list = Array.isArray(workflows) ? workflows : [];
    const valid = list.filter(w => !w.rawError);
    const pool = valid.length > 0 ? valid : list;
    return pool.find(w => w.fileName === 'Default_Comfy_Workflow.json')?.fileName
        || pool[0]?.fileName
        || 'Default_Comfy_Workflow.json';
}

function resolveTargetWorkflow(live, rawFileName) {
    const workflows = Array.isArray(live?.workflows) ? live.workflows : [];
    const requested = String(rawFileName || '').trim()
        ? normalizeWorkflowFileName(rawFileName)
        : String(live?.comfyConfig?.activeWorkflow || '').trim();
    const found = requested
        ? workflows.find(w => w.fileName === requested)
        : workflows[0];
    if (!found) {
        throw new SourceError('not_found', `ComfyUI workflow not found in draft: ${requested || '(none)'}`);
    }
    return found;
}

export function createSdIterateTarget(
    getContext = () => globalThis.Luker?.getContext?.(),
    { comfyBridge = null, onPresetsCommitted = null } = {},
) {
    const resolveCtx = (override) => override || getContext();
    const resolveDefaultPresetLlm = (ctx) => {
        const ill = ctx?.extensionSettings?.sd?.illustration;
        const active = getPresetById(ill, ill?.currentPresetId) || ill?.presets?.[0] || null;
        return {
            defaultLlm: active?.llm || null,
            defaultExplorationLlm: active?.explorationLlm || null,
        };
    };
    /** @type {{ fileName: string, graphSig: string, imagePath: string, seed: number, promptUsed: string } | null} */
    let latestDraftPreview = null;

    async function readDiskDoc(ctx) {
        const c = resolveCtx(ctx);
        const sd = c?.extensionSettings?.sd || {};
        const ill = sd?.illustration;
        const presets = clone(Array.isArray(ill?.presets) ? ill.presets : []);
        const characters = typeof c?.getGlobalState === 'function'
            ? await createCharacterProfileStore(c).listProfiles()
            : [];
        const workflows = await fetchDiskWorkflows(c);
        const comfyConfig = {
            activeWorkflow: String(sd.comfy_workflow || workflows[0]?.fileName || ''),
            placeholders: normalizePlaceholdersList(sd.comfy_placeholders),
        };
        return {
            presets,
            characters,
            workflows,
            comfyConfig,
        };
    }

    return {
        id: 'sd',
        get label() { return i18n('Image Generation'); },
        tone: 'sd',
        order: 30,
        async scopes() {
            return { global: true };
        },
        chips(ctx) {
            const c = resolveCtx(ctx);
            const sd = c?.extensionSettings?.sd;
            if (sd?.source === 'comfy' && sd?.comfy_type !== 'runpod_serverless') {
                return [
                    i18n('Add dynamic LoRA loader template node to the active workflow'),
                    i18n('Wire reference image slots using installed ComfyUI nodes'),
                    i18n('Check workflow placeholders and run a draft test image'),
                ];
            }
            return [
                i18n('Refine illustration prompt instructions for consistent framing'),
                i18n('Align character visual archive descriptions with bound lorebooks'),
            ];
        },
        getNativeAi() {
            const c = resolveCtx();
            const ill = c?.extensionSettings?.sd?.illustration;
            const preset = getPresetById(ill, ill?.currentPresetId) || ill?.presets?.[0];
            if (!preset) return null;
            return {
                connection: String(preset.llm?.apiPresetName || '').trim(),
                preset: String(preset.llm?.llmPresetName || '').trim(),
            };
        },
        async promptInfo() {
            return {
                from: `Luker · ${i18n('Image generation prompts, character archive & ComfyUI workflows')}`,
                custom: false,
                text: DEFAULT_SD_ITERATE_PROMPT,
            };
        },
        renderPreview({ base, ai }) {
            const baseUnits = buildSdUnits(base);
            const aiUnits = buildSdUnits(ai);
            const changes = diffUnits(baseUnits, aiUnits);
            if (!changes.length) return null;

            const matchingPreview = latestDraftPreview
                && Array.isArray(ai?.workflows)
                && ai.workflows.some(w => (
                    !w.rawError
                    && w.fileName === latestDraftPreview.fileName
                    && JSON.stringify(w.graph) === latestDraftPreview.graphSig
                ))
                ? latestDraftPreview
                : null;

            const cards = [];
            if (matchingPreview?.imagePath) {
                cards.push(h('div', { class: 'sdlens-round-card' },
                    h('div', {
                        style: { fontWeight: '600', fontSize: '12.5px', marginBottom: '6px' },
                        text: `${i18n('Draft test preview')} · ${matchingPreview.fileName} (seed ${matchingPreview.seed})`,
                    }),
                    h('img', {
                        src: matchingPreview.imagePath,
                        alt: matchingPreview.fileName,
                        style: { maxWidth: '100%', maxHeight: '280px', borderRadius: '6px', objectFit: 'contain', display: 'block' },
                    })));
            }

            for (const ch of changes) {
                const nodeSummary = ch.key.startsWith('workflow:')
                    ? summarizeWorkflowNodeChanges(baseUnits.get(ch.key)?.fields, aiUnits.get(ch.key)?.fields)
                    : [];
                cards.push(h('div', { class: 'sdlens-round-card' },
                    h('div', { style: { fontWeight: '600', fontSize: '12.5px' }, text: `${ch.group} · ${ch.label} (${ch.kind})` }),
                    nodeSummary.length
                        ? h('pre', { class: 'sdlens-pre', style: { marginBottom: '6px' }, text: nodeSummary.join('\n') })
                        : null,
                    h('pre', { class: 'sdlens-pre', text: ch.after || ch.before })));
            }

            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px' } }, cards);
        },
        async load(_scope, ctx) {
            latestDraftPreview = null;
            const live = await readDiskDoc(ctx);
            return {
                live,
                target: { scope: 'global' },
                title: i18n('Image generation prompts, character archive & ComfyUI workflows'),
            };
        },
        async prompt() {
            return DEFAULT_SD_ITERATE_PROMPT;
        },
        async tools() {
            return [
                ...SD_ITERATE_TOOLS.map(t => clone(t)),
                ...LOREBOOK_READ_TOOL_DEFS.map(t => clone(t)),
            ];
        },
        isRead: (name) => READ_TOOL_NAMES.has(name) || isLorebookReadTool(name),
        async runRead(call, live, helpers = {}) {
            const c = resolveCtx();
            const name = String(call?.name || '');
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            const headers = c?.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
            const signal = helpers?.signal || undefined;

            if (isLorebookReadTool(name)) {
                const avatar = !c?.groupId ? String(c?.characters?.[c?.characterId]?.avatar || '') : '';
                const out = await runLorebookReadTool({ id: call?.id, name, args }, { context: c, avatar });
                if (!out?.ok) {
                    throw new SourceError('read', String(out?.error || 'Lorebook read failed'));
                }
                return out.result;
            }

            if (name === 'sd_list_presets') {
                return (live?.presets || []).map(p => ({
                    id: p.id,
                    name: p.name,
                    promptStyle: p.promptStyle || '',
                    visualInspection: Boolean(p.visualInspection),
                }));
            }
            if (name === 'sd_read_preset') {
                const found = (live?.presets || []).find(p => p.id === String(args.preset_id || ''));
                if (!found) throw new SourceError('not_found', `Preset not found: ${args.preset_id}`);
                return clone(found);
            }
            if (name === 'sd_list_characters') {
                return (live?.characters || []).map(ch => ({
                    id: ch.id,
                    name: ch.name,
                    aliases: ch.aliases || [],
                    sourceWork: ch.sourceWork || '',
                    referenceCount: (ch.referenceImages || []).length,
                }));
            }
            if (name === 'sd_read_character') {
                const found = (live?.characters || []).find(ch => ch.id === String(args.id || ''));
                if (!found) throw new SourceError('not_found', `Character profile not found: ${args.id}`);
                return clone(found);
            }
            if (name === 'sd_read_run') {
                const recorder = c?.runPanel?.getRunRecorder?.();
                const all = [
                    ...(recorder?.currents?.() || []),
                    ...(recorder?.history?.() || []),
                ].filter(r => r?.source === 'sd');
                const key = String(args.run_key || '').trim();
                const found = key
                    ? all.find(r => r.runKey === key || `sd:${r.runId}` === key || String(r.runId) === key)
                    : all[0];
                return found ? clone(found) : { message: 'No matching sd run found.' };
            }

            if (name === 'sd_list_workflows') {
                const active = String(live?.comfyConfig?.activeWorkflow || '');
                return (live?.workflows || []).map((wf) => {
                    if (wf.rawError) {
                        return {
                            fileName: wf.fileName,
                            isActive: wf.fileName === active,
                            nodeCount: 0,
                            rawError: wf.rawError,
                        };
                    }
                    const v = validateComfyWorkflowGraph(wf.graph);
                    if (!v.ok) {
                        return {
                            fileName: wf.fileName,
                            isActive: wf.fileName === active,
                            nodeCount: Object.keys(wf.graph || {}).length,
                            validationError: v.error,
                        };
                    }
                    return {
                        fileName: wf.fileName,
                        isActive: wf.fileName === active,
                        nodeCount: v.summary.nodeCount,
                        placeholders: v.summary.placeholders,
                        loraTemplateNodeId: v.summary.loraTemplate?.nodeId || null,
                        referenceSlotCount: v.summary.referenceSlots.slotCount,
                    };
                });
            }

            if (name === 'sd_read_workflow') {
                const wf = resolveTargetWorkflow(live, args.file_name);
                return formatWorkflowTopology(wf.fileName, wf.graph, {
                    isActive: wf.fileName === live?.comfyConfig?.activeWorkflow,
                    rawError: wf.rawError,
                    rawText: wf.rawText,
                    nodeIds: Array.isArray(args.node_ids) ? args.node_ids : undefined,
                });
            }

            if (name === 'sd_search_comfy_nodes') {
                if (c?.extensionSettings?.sd?.comfy_type === 'runpod_serverless') {
                    throw new SourceError('comfy_unavailable', 'ComfyUI /object_info introspection requires standard ComfyUI mode (not RunPod Serverless).');
                }
                const url = String(c?.extensionSettings?.sd?.comfy_url || '').trim();
                if (!url) {
                    throw new SourceError('comfy_unavailable', 'ComfyUI server URL (comfy_url) is not configured in Image Generation settings.');
                }
                const resp = await fetch('/api/sd/comfy/object-info/search', {
                    method: 'POST',
                    headers,
                    signal,
                    body: JSON.stringify({
                        url,
                        auth: c?.extensionSettings?.sd?.comfy_auth || undefined,
                        query: args.query || '',
                        category: args.category || '',
                        refresh: Boolean(args.refresh),
                    }),
                });
                const payload = await resp.json().catch(async () => ({ error: await resp.text().catch(() => '') }));
                if (!resp.ok) {
                    throw new SourceError('comfy_unreachable', String(payload?.error || `ComfyUI /object_info search failed (HTTP ${resp.status}).`));
                }
                return payload;
            }

            if (name === 'sd_inspect_comfy_node') {
                if (c?.extensionSettings?.sd?.comfy_type === 'runpod_serverless') {
                    throw new SourceError('comfy_unavailable', 'ComfyUI /object_info introspection requires standard ComfyUI mode (not RunPod Serverless).');
                }
                const url = String(c?.extensionSettings?.sd?.comfy_url || '').trim();
                if (!url) {
                    throw new SourceError('comfy_unavailable', 'ComfyUI server URL (comfy_url) is not configured in Image Generation settings.');
                }
                if (!Array.isArray(args.class_types) || args.class_types.length === 0) {
                    throw new SourceError('invalid_args', 'class_types must be a non-empty array of ComfyUI node class names.');
                }
                const resp = await fetch('/api/sd/comfy/object-info/node', {
                    method: 'POST',
                    headers,
                    signal,
                    body: JSON.stringify({
                        url,
                        auth: c?.extensionSettings?.sd?.comfy_auth || undefined,
                        class_types: args.class_types,
                        refresh: Boolean(args.refresh),
                    }),
                });
                const payload = await resp.json().catch(async () => ({ error: await resp.text().catch(() => '') }));
                if (!resp.ok) {
                    throw new SourceError('comfy_unreachable', String(payload?.error || `ComfyUI /object_info node inspect failed (HTTP ${resp.status}).`));
                }
                return payload;
            }

            if (name === 'sd_test_workflow_draft') {
                if (c?.extensionSettings?.sd?.comfy_type === 'runpod_serverless') {
                    return { ok: false, error: 'Draft workflow test generation requires standard ComfyUI mode (not RunPod Serverless).' };
                }
                const url = String(c?.extensionSettings?.sd?.comfy_url || '').trim();
                if (!url) {
                    return { ok: false, error: 'ComfyUI server URL (comfy_url) is not configured in Image Generation settings.' };
                }
                let wf;
                try {
                    wf = resolveTargetWorkflow(live, args.file_name);
                } catch (err) {
                    return { ok: false, error: String(err?.message || err) };
                }
                if (wf.rawError) {
                    return { ok: false, fileName: wf.fileName, error: `Workflow "${wf.fileName}" has invalid JSON: ${wf.rawError}` };
                }
                const validation = validateComfyWorkflowGraph(wf.graph);
                if (!validation.ok) {
                    return { ok: false, fileName: wf.fileName, code: validation.code, error: validation.error };
                }

                const sdSettings = c?.extensionSettings?.sd || {};
                const promptUsed = String(args.prompt || '1girl, upper body portrait, soft lighting, detailed illustration');
                const negativePrompt = String(args.negative_prompt ?? sdSettings.negative_prompt ?? 'lowres, blurry, bad anatomy');
                const refPaths = Array.isArray(args.reference_image_paths)
                    ? args.reference_image_paths.map(p => String(p || '').trim()).filter(Boolean)
                    : [];

                let uploadedFilenames = [];
                if (refPaths.length > 0) {
                    const slotCount = validation.summary.referenceSlots.slotCount;
                    if (slotCount === 0) {
                        return {
                            ok: false,
                            fileName: wf.fileName,
                            error: `Workflow "${wf.fileName}" has no %ref_image% LoadImage template node.`,
                        };
                    }
                    if (refPaths.length > slotCount) {
                        return {
                            ok: false,
                            fileName: wf.fileName,
                            error: `Workflow "${wf.fileName}" defines ${slotCount} reference slot(s), fewer than the ${refPaths.length} reference_image_paths provided.`,
                        };
                    }
                    let uploadResp;
                    try {
                        uploadResp = await fetch('/api/sd/comfy/upload-references', {
                            method: 'POST',
                            headers,
                            signal,
                            body: JSON.stringify({
                                url,
                                auth: sdSettings.comfy_auth || undefined,
                                references: refPaths.map(imagePath => ({ imagePath, role: 'character' })),
                            }),
                        });
                    } catch (err) {
                        if (signal?.aborted || err?.name === 'AbortError') {
                            throw err;
                        }
                        return {
                            ok: false,
                            fileName: wf.fileName,
                            error: String(err?.message || err),
                        };
                    }
                    if (!uploadResp.ok) {
                        return {
                            ok: false,
                            fileName: wf.fileName,
                            error: (await uploadResp.text().catch(() => '')).trim() || `Reference upload failed (HTTP ${uploadResp.status}).`,
                        };
                    }
                    const uploadData = await uploadResp.json();
                    uploadedFilenames = Array.isArray(uploadData?.filenames) ? uploadData.filenames : [];
                }

                let compiled;
                try {
                    compiled = compileComfyWorkflowPromptPayload({
                        workflowText: JSON.stringify(validation.graph),
                        prompt: promptUsed,
                        negativePrompt,
                        sdSettings,
                        customPlaceholders: live?.comfyConfig?.placeholders || [],
                        substituteFn: typeof c?.substituteParams === 'function' ? c.substituteParams : undefined,
                        uploadedFilenames,
                        loras: Array.isArray(args.loras) ? args.loras : [],
                        extraOptions: {
                            width: args.width,
                            height: args.height,
                            seed: args.seed,
                        },
                    });
                } catch (err) {
                    return {
                        ok: false,
                        fileName: wf.fileName,
                        error: String(err?.message || err),
                    };
                }

                let genResp;
                try {
                    genResp = await fetch('/api/sd/comfy/generate', {
                        method: 'POST',
                        headers,
                        signal,
                        body: JSON.stringify({
                            url,
                            prompt: compiled.promptPayload,
                        }),
                    });
                } catch (err) {
                    if (signal?.aborted || err?.name === 'AbortError') {
                        throw err;
                    }
                    return {
                        ok: false,
                        fileName: wf.fileName,
                        error: String(err?.message || err),
                    };
                }

                if (!genResp.ok) {
                    const errText = await genResp.text().catch(() => '');
                    return {
                        ok: false,
                        fileName: wf.fileName,
                        error: errText.trim() || `ComfyUI generation failed (HTTP ${genResp.status}).`,
                    };
                }

                const { format, data } = await genResp.json();
                let imagePath = '';
                if (typeof comfyBridge?.savePreviewBase64 === 'function' && data) {
                    imagePath = await comfyBridge.savePreviewBase64(data, format || 'png');
                }
                latestDraftPreview = {
                    fileName: wf.fileName,
                    graphSig: JSON.stringify(wf.graph),
                    imagePath,
                    seed: compiled.seed,
                    promptUsed,
                };
                return {
                    ok: true,
                    fileName: wf.fileName,
                    imagePath,
                    seed: compiled.seed,
                    promptUsed,
                };
            }

            if (name === 'sd_simulate_illustration') {
                return await simulateSdIllustration({
                    context: c,
                    live,
                    args,
                    signal,
                });
            }

            if (name === 'sd_simulate_exploration') {
                return await simulateSdExploration({
                    context: c,
                    live,
                    args,
                    signal,
                });
            }

            throw new SourceError('unknown_tool', `Unknown read tool: ${name}`);
        },
        async runEdit(call, live) {
            const name = String(call?.name || '');
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            const next = clone(live || {
                presets: [],
                characters: [],
                workflows: [],
                comfyConfig: { activeWorkflow: '', placeholders: [] },
            });
            next.presets = Array.isArray(next.presets) ? next.presets : [];
            next.characters = Array.isArray(next.characters) ? next.characters : [];
            next.workflows = Array.isArray(next.workflows) ? next.workflows : [];
            next.comfyConfig = next.comfyConfig && typeof next.comfyConfig === 'object'
                ? next.comfyConfig
                : { activeWorkflow: '', placeholders: [] };

            if (name === 'sd_create_preset') {
                if (typeof args.name !== 'string' || !args.name.trim()) {
                    throw new SourceError('invalid_args', 'name must be a non-empty string.');
                }
                const presetName = args.name.trim();
                let presetId = '';
                if (args.preset_id !== undefined) {
                    if (typeof args.preset_id !== 'string' || !args.preset_id.trim()) {
                        throw new SourceError('invalid_args', 'preset_id must be a non-empty string when provided.');
                    }
                    presetId = args.preset_id.trim();
                    if (next.presets.some(p => p.id === presetId)) {
                        throw new SourceError('invalid_args', `Preset id already exists in draft: ${presetId}`);
                    }
                } else {
                    presetId = makeIllustrationId('preset');
                }

                let cloneTarget = null;
                if (args.clone_from !== undefined) {
                    if (typeof args.clone_from !== 'string' || !args.clone_from.trim()) {
                        throw new SourceError('invalid_args', 'clone_from must be a non-empty preset id when provided.');
                    }
                    const cloneFromId = args.clone_from.trim();
                    cloneTarget = next.presets.find(p => p.id === cloneFromId) || null;
                    if (!cloneTarget) {
                        throw new SourceError('not_found', `clone_from preset not found in draft: ${cloneFromId}`);
                    }
                }

                if (args.prompt_style !== undefined && args.prompt_style !== 'tag' && args.prompt_style !== 'natural') {
                    throw new SourceError('invalid_args', 'prompt_style must be "tag" or "natural".');
                }
                const style = args.prompt_style
                    || (cloneTarget?.promptStyle === 'natural' ? 'natural' : 'tag');
                const defaults = getDefaultPromptValues(style);

                const resolvePromptField = (argVal, fieldName, clonedVal, defaultVal) => {
                    if (argVal !== undefined) {
                        if (typeof argVal !== 'string') {
                            throw new SourceError('invalid_args', `${fieldName} must be a string.`);
                        }
                        if (argVal.trim()) return argVal;
                    }
                    if (typeof clonedVal === 'string' && clonedVal.trim()) return clonedVal;
                    return defaultVal;
                };

                const { defaultLlm, defaultExplorationLlm } = resolveDefaultPresetLlm(resolveCtx());
                const llmSource = cloneTarget?.llm || defaultLlm || next.presets[0]?.llm;
                const expLlmSource = cloneTarget?.explorationLlm || defaultExplorationLlm || next.presets[0]?.explorationLlm;
                const now = Date.now();
                next.presets.push({
                    id: presetId,
                    name: presetName,
                    promptStyle: style,
                    promptDefaultsInitialized: true,
                    createdAt: now,
                    updatedAt: now,
                    illustrationPrompt: resolvePromptField(
                        args.illustration_prompt,
                        'illustration_prompt',
                        cloneTarget?.illustrationPrompt,
                        defaults.illustrationPrompt,
                    ),
                    studioPrompt: resolvePromptField(
                        args.studio_prompt,
                        'studio_prompt',
                        cloneTarget?.studioPrompt,
                        defaults.studioPrompt,
                    ),
                    explorationPrompt: resolvePromptField(
                        args.exploration_prompt,
                        'exploration_prompt',
                        cloneTarget?.explorationPrompt,
                        defaults.explorationPrompt,
                    ),
                    llm: {
                        apiPresetName: String(llmSource?.apiPresetName || ''),
                        llmPresetName: String(llmSource?.llmPresetName || ''),
                    },
                    explorationLlm: {
                        apiPresetName: String(expLlmSource?.apiPresetName || ''),
                        llmPresetName: String(expLlmSource?.llmPresetName || ''),
                    },
                    visualInspection: args.visual_inspection !== undefined
                        ? Boolean(args.visual_inspection)
                        : Boolean(cloneTarget?.visualInspection),
                });
                return next;
            }

            if (name === 'sd_update_preset') {
                const target = next.presets.find(p => p.id === String(args.preset_id || ''));
                if (!target) {
                    throw new SourceError('not_found', `Preset not found: ${args.preset_id}`);
                }
                if (args.prompt_style !== undefined) {
                    if (args.prompt_style !== 'tag' && args.prompt_style !== 'natural') {
                        throw new SourceError('invalid_args', 'prompt_style must be "tag" or "natural".');
                    }
                    target.promptStyle = args.prompt_style;
                }
                if (args.name !== undefined) target.name = String(args.name);
                if (args.illustration_prompt !== undefined) target.illustrationPrompt = String(args.illustration_prompt);
                if (args.studio_prompt !== undefined) target.studioPrompt = String(args.studio_prompt);
                if (args.exploration_prompt !== undefined) target.explorationPrompt = String(args.exploration_prompt);
                if (args.visual_inspection !== undefined) target.visualInspection = Boolean(args.visual_inspection);
                return next;
            }

            if (name === 'sd_delete_preset') {
                const presetId = String(args.preset_id || '').trim();
                const idx = next.presets.findIndex(p => p.id === presetId);
                if (idx < 0) {
                    throw new SourceError('not_found', `Preset not found: ${args.preset_id}`);
                }
                if (next.presets.length <= 1) {
                    throw new SourceError('invalid_args', 'Cannot delete the last remaining prompt preset; at least one preset must exist.');
                }
                next.presets.splice(idx, 1);
                return next;
            }

            if (name === 'sd_upsert_character') {
                const id = String(args.id || '').trim() || makeIllustrationId('char');
                const existingIdx = next.characters.findIndex(ch => ch.id === id);
                const prev = existingIdx >= 0 ? next.characters[existingIdx] : {};
                const merged = normalizeCharacterProfile({
                    ...prev,
                    id,
                    name: args.name ?? prev.name,
                    aliases: args.aliases ?? prev.aliases,
                    sourceWork: args.source_work ?? prev.sourceWork,
                    description: args.description ?? prev.description,
                    referenceImages: args.reference_images ?? prev.referenceImages,
                });
                if (!merged) {
                    throw new SourceError('invalid_args', 'Character profile requires a non-empty name.');
                }
                if (existingIdx >= 0) next.characters[existingIdx] = merged;
                else next.characters.push(merged);
                return next;
            }

            if (name === 'sd_delete_character') {
                const id = String(args.id || '').trim();
                const beforeLen = next.characters.length;
                next.characters = next.characters.filter(ch => ch.id !== id);
                if (next.characters.length === beforeLen) {
                    throw new SourceError('not_found', `Character profile not found: ${id}`);
                }
                return next;
            }

            if (name === 'sd_create_workflow') {
                let targetFileName;
                try {
                    targetFileName = normalizeWorkflowFileName(args.file_name);
                } catch (err) {
                    throw new SourceError('invalid_args', String(err?.message || err));
                }

                let sourceGraph;
                if (args.clone_from) {
                    const srcName = normalizeWorkflowFileName(args.clone_from);
                    const srcWf = next.workflows.find(w => w.fileName === srcName);
                    if (!srcWf) {
                        throw new SourceError('not_found', `clone_from workflow not found in draft: ${srcName}`);
                    }
                    if (srcWf.rawError) {
                        throw new SourceError('invalid_args', `Cannot clone broken workflow "${srcName}": ${srcWf.rawError}`);
                    }
                    sourceGraph = clone(srcWf.graph);
                } else if (args.workflow_json && typeof args.workflow_json === 'object') {
                    sourceGraph = clone(args.workflow_json);
                } else {
                    throw new SourceError('invalid_args', 'sd_create_workflow requires either clone_from or workflow_json.');
                }

                const validation = validateComfyWorkflowGraph(sourceGraph);
                if (!validation.ok) {
                    throw new SourceError(validation.code, validation.error);
                }

                const existingIdx = next.workflows.findIndex(w => w.fileName === targetFileName);
                const entry = {
                    fileName: targetFileName,
                    graph: validation.graph,
                    rawError: '',
                };
                if (existingIdx >= 0) {
                    next.workflows[existingIdx] = entry;
                } else {
                    next.workflows.push(entry);
                    next.workflows.sort((a, b) => a.fileName.localeCompare(b.fileName));
                }
                if (args.set_active) {
                    next.comfyConfig.activeWorkflow = targetFileName;
                }
                return next;
            }

            if (name === 'sd_upsert_workflow_nodes') {
                const wf = resolveTargetWorkflow(next, args.file_name);
                if (wf.rawError) {
                    throw new SourceError('invalid_graph', `Workflow "${wf.fileName}" has malformed JSON (${wf.rawError}); overwrite it via sd_create_workflow with valid workflow_json first.`);
                }
                if (!args.nodes || typeof args.nodes !== 'object' || Array.isArray(args.nodes) || Object.keys(args.nodes).length === 0) {
                    throw new SourceError('invalid_args', 'nodes must be a non-empty object mapping nodeId to { class_type, inputs }.');
                }

                const mergedGraph = clone(wf.graph);
                for (const [rawNodeId, nodeDef] of Object.entries(args.nodes)) {
                    const nodeId = String(rawNodeId).trim();
                    if (!nodeId) {
                        throw new SourceError('invalid_args', 'nodes cannot contain an empty node ID.');
                    }
                    mergedGraph[nodeId] = clone(nodeDef);
                }

                const validation = validateComfyWorkflowGraph(mergedGraph);
                if (!validation.ok) {
                    throw new SourceError(validation.code, validation.error);
                }
                wf.graph = validation.graph;
                wf.rawError = '';
                return next;
            }

            if (name === 'sd_remove_workflow_nodes') {
                const wf = resolveTargetWorkflow(next, args.file_name);
                if (wf.rawError) {
                    throw new SourceError('invalid_graph', `Workflow "${wf.fileName}" has malformed JSON (${wf.rawError}).`);
                }
                const ids = Array.isArray(args.node_ids)
                    ? args.node_ids.map(id => String(id).trim()).filter(Boolean)
                    : [];
                if (ids.length === 0) {
                    throw new SourceError('invalid_args', 'node_ids must be a non-empty array of node IDs to remove.');
                }

                const prunedGraph = clone(wf.graph);
                let removedAny = false;
                for (const id of ids) {
                    if (Object.hasOwn(prunedGraph, id)) {
                        delete prunedGraph[id];
                        removedAny = true;
                    }
                }
                if (!removedAny) {
                    throw new SourceError('not_found', `None of the requested node_ids exist in "${wf.fileName}": ${ids.join(', ')}`);
                }

                const validation = validateComfyWorkflowGraph(prunedGraph);
                if (!validation.ok) {
                    throw new SourceError(validation.code, validation.error);
                }
                wf.graph = validation.graph;
                return next;
            }

            if (name === 'sd_delete_workflow') {
                const fileName = normalizeWorkflowFileName(args.file_name);
                const idx = next.workflows.findIndex(w => w.fileName === fileName);
                if (idx < 0) {
                    throw new SourceError('not_found', `ComfyUI workflow not found in draft: ${fileName}`);
                }
                if (next.workflows.length <= 1) {
                    throw new SourceError('invalid_args', 'Cannot delete the last remaining ComfyUI workflow; at least one workflow must exist.');
                }
                next.workflows.splice(idx, 1);
                if (next.comfyConfig.activeWorkflow === fileName) {
                    next.comfyConfig.activeWorkflow = pickFallbackActiveWorkflow(next.workflows);
                }
                return next;
            }

            if (name === 'sd_update_comfy_config') {
                if (args.active_workflow !== undefined) {
                    const fileName = normalizeWorkflowFileName(args.active_workflow);
                    if (!next.workflows.some(w => w.fileName === fileName)) {
                        throw new SourceError('not_found', `Cannot set active_workflow to nonexistent workflow "${fileName}".`);
                    }
                    next.comfyConfig.activeWorkflow = fileName;
                }
                if (args.placeholders !== undefined) {
                    next.comfyConfig.placeholders = normalizePlaceholdersList(args.placeholders);
                }
                return next;
            }

            throw new SourceError('unknown_tool', `Unknown edit tool: ${name}`);
        },
        units: (live) => buildSdUnits(live),
        rebuild(base, ai, keys) {
            const ops = fieldPlan(buildSdUnits(base), buildSdUnits(ai), keys);
            return applyOpsToSdDoc(base, ops, resolveDefaultPresetLlm(resolveCtx()));
        },
        async commit(_targetRef, base, next, keys) {
            const c = resolveCtx();
            const ops = fieldPlan(buildSdUnits(base), buildSdUnits(next), keys);
            const touchesPresets = ops.some(op => op.key.startsWith('preset:'));
            const touchesCharacters = ops.some(op => op.key.startsWith('character:'));
            const touchesWorkflows = ops.some(op => op.key.startsWith('workflow:'));
            const touchesComfyConfig = ops.some(op => op.key === 'comfy:config');
            const initialActiveWorkflow = String(c?.extensionSettings?.sd?.comfy_workflow || '');
            const defaultLlmOpts = resolveDefaultPresetLlm(c);

            let lastReadDoc = null;

            const committed = await commitFields({
                read: async () => {
                    lastReadDoc = await readDiskDoc(c);
                    return lastReadDoc;
                },
                units: buildSdUnits,
                apply: (doc, applyOps) => applyOpsToSdDoc(doc, applyOps, defaultLlmOpts),
                write: async (nextDoc, { undoing } = {}) => {
                    const headers = c?.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
                    let needSettingsSave = false;

                    if (touchesPresets) {
                        const ill = c?.extensionSettings?.sd?.illustration;
                        if (!ill) {
                            throw new SourceError('write-failed', 'Image Generation illustration settings are unavailable.');
                        }
                        ill.presets = clone(nextDoc.presets);
                        if (!ill.presets.some(p => p.id === ill.currentPresetId)) {
                            ill.currentPresetId = ill.presets[0]?.id || '';
                        }
                        needSettingsSave = true;
                    }

                    if (touchesCharacters && typeof c?.updateGlobalState === 'function') {
                        const profilesObj = {};
                        for (const ch of nextDoc.characters || []) {
                            const clean = normalizeCharacterProfile(ch);
                            if (clean) profilesObj[clean.id] = clean;
                        }
                        const res = await c.updateGlobalState(CHARACTER_PROFILES_NAMESPACE, (cur) => ({
                            ...cur,
                            version: CHARACTER_PROFILES_VERSION,
                            profiles: profilesObj,
                        }), { asyncDiff: false });
                        if (!res?.ok) {
                            throw new SourceError('write-failed', `Failed to write character archive: ${res?.hint || res?.reason || 'unknown'}`);
                        }
                    }

                    if (touchesWorkflows) {
                        const prevMap = new Map((lastReadDoc?.workflows || []).map(w => [w.fileName, w]));
                        const nextMap = new Map((nextDoc?.workflows || []).map(w => [w.fileName, w]));

                        for (const [fileName, wf] of nextMap) {
                            const prev = prevMap.get(fileName);
                            if (!prev || !same(buildWorkflowUnitFields(prev), buildWorkflowUnitFields(wf))) {
                                const saveResp = await fetch('/api/sd/comfy/save-workflow', {
                                    method: 'POST',
                                    headers,
                                    body: JSON.stringify({
                                        file_name: fileName,
                                        workflow: serializeWorkflowEntry(wf),
                                    }),
                                });
                                if (!saveResp.ok) {
                                    const errText = await saveResp.text().catch(() => '');
                                    throw new SourceError('write-failed', `Failed to save ComfyUI workflow "${fileName}": ${errText || `HTTP ${saveResp.status}`}`);
                                }
                            }
                        }

                        for (const fileName of prevMap.keys()) {
                            if (!nextMap.has(fileName)) {
                                const delResp = await fetch('/api/sd/comfy/delete-workflow', {
                                    method: 'POST',
                                    headers,
                                    body: JSON.stringify({ file_name: fileName }),
                                });
                                if (!delResp.ok) {
                                    const errText = await delResp.text().catch(() => '');
                                    throw new SourceError('write-failed', `Failed to delete ComfyUI workflow "${fileName}": ${errText || `HTTP ${delResp.status}`}`);
                                }
                            }
                        }
                    }

                    const sd = c?.extensionSettings?.sd;
                    if (sd && (touchesComfyConfig || touchesWorkflows)) {
                        const availableList = Array.isArray(nextDoc.workflows) ? nextDoc.workflows : [];
                        const hasWorkflow = name => availableList.length === 0 || availableList.some(w => w.fileName === name);

                        if (touchesComfyConfig) {
                            const desiredActive = String(nextDoc.comfyConfig?.activeWorkflow || '');
                            if (desiredActive && hasWorkflow(desiredActive)) {
                                sd.comfy_workflow = desiredActive;
                            } else if (sd.comfy_workflow && !hasWorkflow(sd.comfy_workflow)) {
                                sd.comfy_workflow = pickFallbackActiveWorkflow(availableList);
                            }
                            sd.comfy_placeholders = normalizePlaceholdersList(nextDoc.comfyConfig?.placeholders);
                            needSettingsSave = true;
                        } else if (touchesWorkflows) {
                            if (undoing && initialActiveWorkflow && hasWorkflow(initialActiveWorkflow) && sd.comfy_workflow !== initialActiveWorkflow) {
                                sd.comfy_workflow = initialActiveWorkflow;
                                needSettingsSave = true;
                            } else if (sd.comfy_workflow && !hasWorkflow(sd.comfy_workflow)) {
                                sd.comfy_workflow = pickFallbackActiveWorkflow(availableList);
                                needSettingsSave = true;
                            }
                        }

                        if (needSettingsSave && sd.generationPresets?.currentId) {
                            patchGenerationPresetConfig(sd.generationPresets, sd.generationPresets.currentId, {
                                comfy_workflow: sd.comfy_workflow,
                                comfy_placeholders: clone(sd.comfy_placeholders || []),
                            });
                        }
                    }

                    if (needSettingsSave) {
                        await saveSettingsChecked(c);
                    }

                    if (touchesPresets) {
                        await onPresetsCommitted?.();
                    }

                    if (touchesWorkflows || touchesComfyConfig) {
                        await comfyBridge?.onComfyWorkflowsCommitted?.();
                    }
                },
            }, ops);

            latestDraftPreview = null;
            return committed;
        },
    };
}
