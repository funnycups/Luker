import { filterReplayReferences } from '../capabilities.js';
import { buildLorasProperty, validateLorasArg } from '../lora/tool.js';
import { resolveProfileAssets } from '../character-archive/store.js';
import { findInsertionPoint } from './message.js';

export { filterReplayReferences };

export const SUPPORTED_ASPECT_RATIOS = Object.freeze(['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9']);

export const ILLUSTRATION_AGENT_TOOL_NAMES = Object.freeze({
    ADD_IMAGE_PROMPT: 'add_image_prompt',
    READ_CHARACTER_PROFILES: 'read_character_profiles',
    EXPLORE_CHARACTERS: 'explore_characters',
});

export const ADD_IMAGE_PROMPT_TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'add_image_prompt',
        description: 'Add an image prompt to the current message.',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'Image generation prompt.',
                },
                insert_after: {
                    type: 'string',
                    description: 'Text from the current message that ends immediately before the insertion point.',
                },
                insert_before: {
                    type: 'string',
                    description: 'Text from the current message that starts immediately after the insertion point.',
                },
            },
            required: ['prompt', 'insert_after', 'insert_before'],
        },
    },
});

export const READ_CHARACTER_PROFILES_TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'read_character_profiles',
        description: 'Read character visual archive details (appearance, outfits, and/or reference image metadata according to active reference mode) for specific character ids from <character_archive>.',
        parameters: {
            type: 'object',
            properties: {
                ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Character profile ids listed in <character_archive>.',
                },
            },
            required: ['ids'],
        },
    },
});

export const EXPLORE_CHARACTERS_TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'explore_characters',
        description: 'Dispatch the character visual exploration agent for unfamiliar public-work characters whose visual canon the active image model does not already know and who are absent from <character_archive>. Never call for well-known characters the image model recognizes on its own, original characters without public source material, or minor background figures.',
        parameters: {
            type: 'object',
            properties: {
                targets: {
                    type: 'array',
                    description: 'Characters to look up and archive.',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Character name as used in the scene or card.' },
                            work: { type: 'string', description: 'Source franchise or work title if known.' },
                            hint: { type: 'string', description: 'Optional scene or role context.' },
                        },
                        required: ['name'],
                    },
                },
            },
            required: ['targets'],
        },
    },
});

export const GENERATE_IMAGE_TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'generate_image',
        description: 'Generate an image and add it to the studio gallery.',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'Image generation prompt.',
                },
            },
            required: ['prompt'],
        },
    },
});

/**
 * Builds a copy of the prompt tool with optional LoRA and backend-capability parameters.
 *
 * @param {string[]} loras Selectable LoRA names.
 * @param {{ includeWeight?: boolean, capabilities?: object|null, includeAgentFields?: boolean }} [options]
 * @returns {object} Tool definition for the prompt request.
 */
const cloneJson = value => JSON.parse(JSON.stringify(value));

function buildCharacterRefsProperty(capabilities) {
    if (!capabilities?.supportsCharacterReference) {
        return null;
    }
    const capNote = capabilities.maxCharacterReferences !== null && capabilities.maxCharacterReferences !== undefined
        ? ` Current backend accepts at most ${capabilities.maxCharacterReferences} reference image(s) per prompt.`
        : '';
    return {
        type: 'array',
        description: `Character visual archive references to bind to this image.${capNote}`,
        items: {
            type: 'object',
            properties: {
                profile_id: {
                    type: 'string',
                    description: 'Character profile id from <character_archive>.',
                },
                outfit_id: {
                    type: 'string',
                    description: 'Optional outfit id from the character profile.',
                },
            },
            required: ['profile_id'],
        },
    };
}

export function buildAddImagePromptTool(loras, { includeWeight = false, capabilities = null, includeAgentFields = false } = {}) {
    const tool = cloneJson(ADD_IMAGE_PROMPT_TOOL);
    const props = tool.function.parameters.properties;

    if (capabilities || includeAgentFields) {
        props.negative_prompt = {
            type: 'string',
            description: 'Optional negative prompt tags or exclusions for this image.',
        };
        if (!capabilities || capabilities.supportsDynamicAspectRatio !== false) {
            props.aspect_ratio = {
                type: 'string',
                enum: [...SUPPORTED_ASPECT_RATIOS],
                description: 'Optional aspect ratio override matching scene composition.',
            };
        }
        const charRefsProp = buildCharacterRefsProperty(capabilities);
        if (charRefsProp) {
            props.character_refs = charRefsProp;
        }
        if (capabilities?.supportsMultiCharacterPrompts) {
            props.character_captions = {
                type: 'array',
                description: 'Per-character regional captions and normalized canvas centers (0.0 to 1.0) for multi-character scenes.',
                items: {
                    type: 'object',
                    properties: {
                        prompt: { type: 'string', description: 'Character-specific positive tags or description.' },
                        negative_prompt: { type: 'string', description: 'Optional character-specific negative tags.' },
                        center: {
                            type: 'object',
                            properties: {
                                x: { type: 'number', description: 'Horizontal position from 0.0 (left) to 1.0 (right).' },
                                y: { type: 'number', description: 'Vertical position from 0.0 (top) to 1.0 (bottom).' },
                            },
                            required: ['x', 'y'],
                        },
                    },
                    required: ['prompt'],
                },
            };
        }
    }

    const lorasProperty = buildLorasProperty(loras, { includeWeight });
    if (lorasProperty) {
        props.loras = lorasProperty;
    }
    return tool;
}

export function buildIllustrationAgentTools({
    loras = [],
    includeWeight = false,
    capabilities = null,
    includeArchiveTools = false,
    allowExploration = true,
} = {}) {
    const archiveToolsEnabled = Boolean(
        includeArchiveTools
        && (!capabilities || capabilities.characterReferenceEnabled !== false),
    );
    const tools = [
        buildAddImagePromptTool(loras, {
            includeWeight,
            capabilities,
            includeAgentFields: Boolean(capabilities || archiveToolsEnabled),
        }),
    ];
    if (archiveToolsEnabled) {
        tools.push(cloneJson(READ_CHARACTER_PROFILES_TOOL));
        if (allowExploration) {
            tools.push(cloneJson(EXPLORE_CHARACTERS_TOOL));
        }
    }
    return tools;
}

/**
 * Builds a copy of the image tool with optional LoRA and studio parameters.
 *
 * @param {string[]} loras Selectable LoRA names.
 * @param {{ includeWeight?: boolean, capabilities?: object|null, includeStudioFields?: boolean }} [options]
 * @returns {object} Tool definition for the image request.
 */
export function buildGenerateImageTool(loras, { includeWeight = false, capabilities = null, includeStudioFields = false } = {}) {
    const tool = cloneJson(GENERATE_IMAGE_TOOL);
    const props = tool.function.parameters.properties;

    if (includeStudioFields) {
        props.negative_prompt = {
            type: 'string',
            description: 'Optional negative prompt tags or exclusions.',
        };
        if (!capabilities || capabilities.supportsDynamicAspectRatio !== false) {
            props.aspect_ratio = {
                type: 'string',
                enum: [...SUPPORTED_ASPECT_RATIOS],
                description: 'Optional aspect ratio override.',
            };
        }
        if (!capabilities || capabilities.supportsSourceImage) {
            props.source_image_id = {
                type: 'string',
                description: 'Optional gallery image id or managed /user/images path to edit from as source image.',
            };
        }
        if (!capabilities || capabilities.supportsCharacterReference) {
            props.character_image_ids = {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional gallery image ids or managed local paths (/characters/*, /User Avatars/*, /user/images/*) to pass as character reference images.',
            };
        }
        const charRefsProp = buildCharacterRefsProperty(capabilities);
        if (charRefsProp) {
            props.character_refs = charRefsProp;
        }
    }

    const lorasProperty = buildLorasProperty(loras, { includeWeight });
    if (lorasProperty) {
        props.loras = lorasProperty;
    }
    return tool;
}

function validateAspectRatioField(raw, capabilities) {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return { ok: true, value: '' };
    }
    const ratio = String(raw).trim();
    if (capabilities && capabilities.supportsDynamicAspectRatio === false) {
        return { ok: false, error: `Current image backend "${capabilities.source || 'unknown'}" does not support dynamic aspect_ratio overrides.` };
    }
    if (!SUPPORTED_ASPECT_RATIOS.includes(ratio)) {
        return { ok: false, error: `Unsupported aspect_ratio "${ratio}". Expected one of: ${SUPPORTED_ASPECT_RATIOS.join(', ')}.` };
    }
    return { ok: true, value: ratio };
}

function validateCharacterRefsShape(raw, capabilities = null) {
    if (raw === undefined || raw === null) {
        return { ok: true, value: [] };
    }
    if (!Array.isArray(raw)) {
        return { ok: false, error: 'character_refs must be an array' };
    }
    const normalized = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, error: 'Each character_refs entry must be an object with profile_id' };
        }
        const profileId = String(entry.profile_id ?? entry.profileId ?? '').trim();
        if (!profileId) {
            return { ok: false, error: 'Each character_refs entry requires a non-empty profile_id' };
        }
        const outfitId = String(entry.outfit_id ?? entry.outfitId ?? '').trim();
        normalized.push(outfitId ? { profileId, outfitId } : { profileId });
    }
    if (normalized.length > 0 && capabilities && capabilities.supportsCharacterReference === false) {
        return {
            ok: false,
            error: `Character reference images are disabled in the current preset or unsupported by backend "${capabilities.source || 'unknown'}"; omit character_refs.`,
        };
    }
    return { ok: true, value: normalized };
}

function validateCharacterCaptionsShape(raw, capabilities) {
    if (raw === undefined || raw === null) {
        return { ok: true, value: [] };
    }
    if (!Array.isArray(raw)) {
        return { ok: false, error: 'character_captions must be an array' };
    }
    if (raw.length > 0 && capabilities && capabilities.supportsMultiCharacterPrompts === false) {
        return { ok: false, error: `Current image backend "${capabilities.source || 'unknown'}" does not support character_captions.` };
    }
    const normalized = [];
    for (const item of raw) {
        const prompt = String(item?.prompt ?? '').trim();
        if (!prompt) {
            return { ok: false, error: 'Each character_captions item requires a non-empty prompt' };
        }
        const negativePrompt = String(item?.negative_prompt ?? item?.negativePrompt ?? '').trim();
        const entry = { prompt, negativePrompt };
        if (item?.center !== undefined && item?.center !== null) {
            const x = Number(item.center.x);
            const y = Number(item.center.y);
            if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
                return { ok: false, error: 'character_captions center coordinates must be numbers between 0 and 1' };
            }
            entry.center = { x, y };
        }
        normalized.push(entry);
    }
    return { ok: true, value: normalized };
}

export function validateAddImagePromptArgs(args, { availableLoras, includeWeight = false, capabilities = null } = {}) {
    const prompt = String(args?.prompt ?? '').trim();
    const insertAfter = String(args?.insert_after ?? '').trim();
    const insertBefore = String(args?.insert_before ?? '').trim();
    if (!prompt) {
        return { ok: false, error: 'prompt is required' };
    }
    if (!insertAfter) {
        return { ok: false, error: 'insert_after is required' };
    }
    if (!insertBefore) {
        return { ok: false, error: 'insert_before is required' };
    }
    const loras = validateLorasArg(args?.loras, { available: availableLoras, includeWeight });
    if (!loras.ok) {
        return { ok: false, error: loras.error };
    }
    const ratio = validateAspectRatioField(args?.aspect_ratio, capabilities);
    if (!ratio.ok) {
        return { ok: false, error: ratio.error };
    }
    const charRefs = validateCharacterRefsShape(args?.character_refs, capabilities);
    if (!charRefs.ok) {
        return { ok: false, error: charRefs.error };
    }
    const charCaptions = validateCharacterCaptionsShape(args?.character_captions, capabilities);
    if (!charCaptions.ok) {
        return { ok: false, error: charCaptions.error };
    }

    const value = { prompt, insertAfter, insertBefore, loras: loras.value };
    const negativePrompt = String(args?.negative_prompt ?? '').trim();
    if (negativePrompt) {
        value.negativePrompt = negativePrompt;
    }
    if (ratio.value) {
        value.aspectRatio = ratio.value;
    }
    if (charRefs.value.length > 0) {
        value.characterRefs = charRefs.value;
    }
    if (charCaptions.value.length > 0) {
        value.characterPrompts = charCaptions.value;
    }
    return { ok: true, value };
}

export function mergeNegativePrompts(explicitNegative = '', negativeTags = []) {
    const parts = [];
    const seen = new Set();
    const pushItem = (raw) => {
        const trimmed = String(raw ?? '').trim();
        if (!trimmed) return;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        parts.push(trimmed);
    };

    for (const chunk of String(explicitNegative || '').split(',')) {
        pushItem(chunk);
    }
    for (const tag of Array.isArray(negativeTags) ? negativeTags : []) {
        pushItem(tag);
    }
    return parts.join(', ');
}

/**
 * Deterministically resolves `character_refs` against archived character profiles and backend capabilities.
 */
export function resolvePromptCharacterRefs(characterRefs = [], { profileMap = new Map(), capabilities = null } = {}) {
    if (!Array.isArray(characterRefs) || characterRefs.length === 0) {
        return { ok: true, references: [], negativeTags: [] };
    }
    if (capabilities && capabilities.supportsCharacterReference === false) {
        return {
            ok: false,
            error: `Character reference images are disabled in the current preset or unsupported by backend "${capabilities.source || 'unknown'}"; omit character_refs.`,
        };
    }
    const references = [];
    const seenPaths = new Set();
    const negativeTags = [];

    for (const ref of characterRefs) {
        const profileId = String(ref?.profileId ?? ref?.profile_id ?? '').trim();
        if (!profileId) {
            return {
                ok: false,
                error: 'Each character_refs entry requires a non-empty profile_id.',
            };
        }
        const outfitId = String(ref?.outfitId ?? ref?.outfit_id ?? '').trim();
        const profile = profileMap instanceof Map ? profileMap.get(profileId) : profileMap?.[profileId];
        if (!profile) {
            return {
                ok: false,
                error: `Unknown character profile_id "${profileId}". Check <character_archive> or call read_character_profiles first.`,
            };
        }
        if (outfitId && !(Array.isArray(profile.outfits) && profile.outfits.some(o => o.id === outfitId))) {
            const validIds = (profile.outfits || []).map(o => o.id).join(', ') || 'none';
            return {
                ok: false,
                error: `Unknown outfit_id "${outfitId}" for character "${profile.name}" (${profile.id}). Available outfit ids: ${validIds}.`,
            };
        }
        const resolved = resolveProfileAssets(profile, { outfitId });
        for (const neg of resolved?.negativeTags || []) {
            negativeTags.push(neg);
        }
        const refImages = resolved?.referenceImages || [];
        if (refImages.length === 0) {
            return {
                ok: false,
                error: `Character "${profile.name}" (${profile.id}) has no reference images for the selected outfit. Do not pass character_refs for this character.`,
            };
        }
        const label = resolved?.outfitName
            ? `${resolved.name} — ${resolved.outfitName}`
            : String(resolved?.name || profile.name);
        for (const imagePath of refImages) {
            if (seenPaths.has(imagePath)) {
                continue;
            }
            seenPaths.add(imagePath);
            references.push({
                imagePath,
                role: 'character',
                label,
            });
        }
    }

    if (
        capabilities?.supportsCharacterReference
        && capabilities.maxCharacterReferences !== null
        && capabilities.maxCharacterReferences !== undefined
        && references.length > capabilities.maxCharacterReferences
    ) {
        return {
            ok: false,
            error: `Selected character_refs resolve to ${references.length} reference image(s), exceeding limit of ${capabilities.maxCharacterReferences}. Select fewer characters or outfits within the limit.`,
        };
    }

    return { ok: true, references, negativeTags };
}

export function validateGenerateImageArgs(args, { availableLoras, includeWeight = false, capabilities = null } = {}) {
    const prompt = String(args?.prompt ?? '').trim();
    if (!prompt) {
        return { ok: false, error: 'prompt is required' };
    }
    const loras = validateLorasArg(args?.loras, { available: availableLoras, includeWeight });
    if (!loras.ok) {
        return { ok: false, error: loras.error };
    }
    const ratio = validateAspectRatioField(args?.aspect_ratio, capabilities);
    if (!ratio.ok) {
        return { ok: false, error: ratio.error };
    }
    const charRefs = validateCharacterRefsShape(args?.character_refs, capabilities);
    if (!charRefs.ok) {
        return { ok: false, error: charRefs.error };
    }
    const value = { prompt, loras: loras.value };
    const negativePrompt = String(args?.negative_prompt ?? '').trim();
    if (negativePrompt) {
        value.negativePrompt = negativePrompt;
    }
    if (ratio.value) {
        value.aspectRatio = ratio.value;
    }
    const sourceImageId = String(args?.source_image_id ?? '').trim();
    if (sourceImageId) {
        value.sourceImageId = sourceImageId;
    }
    if (Array.isArray(args?.character_image_ids)) {
        const ids = args.character_image_ids.map(v => String(v ?? '').trim()).filter(Boolean);
        if (ids.length > 0) {
            value.characterImageIds = ids;
        }
    }
    if (charRefs.value.length > 0) {
        value.characterRefs = charRefs.value;
    }
    return { ok: true, value };
}

export function selectPromptCalls(toolCalls, {
    messageText = '',
    availableLoras,
    includeWeight = false,
    capabilities = null,
    profileMap = null,
} = {}) {
    const accepted = [];
    const rejected = [];
    const seen = new Set();

    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        if (call?.name !== ADD_IMAGE_PROMPT_TOOL.function.name) {
            rejected.push({ reason: 'unknown tool', call });
            continue;
        }
        const validation = validateAddImagePromptArgs(call.args, { availableLoras, includeWeight, capabilities });
        if (!validation.ok) {
            rejected.push({ reason: validation.error, call });
            continue;
        }
        const value = { ...validation.value };
        if (findInsertionPoint(messageText, value.insertAfter, value.insertBefore) === null) {
            rejected.push({ reason: 'anchors not found', call });
            continue;
        }
        if (Array.isArray(value.characterRefs) && value.characterRefs.length > 0) {
            const resolved = resolvePromptCharacterRefs(value.characterRefs, {
                profileMap: profileMap || new Map(),
                capabilities,
            });
            if (!resolved.ok) {
                rejected.push({ reason: resolved.error, call });
                continue;
            }
            if (resolved.references.length > 0) {
                value.references = resolved.references;
            }
            const mergedNeg = mergeNegativePrompts(value.negativePrompt || '', resolved.negativeTags);
            if (mergedNeg) {
                value.negativePrompt = mergedNeg;
            }
        }
        const key = JSON.stringify([
            value.prompt,
            value.insertAfter,
            value.insertBefore,
            value.loras,
            value.aspectRatio || '',
            value.references || [],
        ]);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        accepted.push(value);
    }

    return { accepted, rejected };
}
