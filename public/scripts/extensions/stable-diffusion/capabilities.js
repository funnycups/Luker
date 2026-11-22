// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolveAspectRatioDimensions } from './aspect-ratio.js';
import { CHARACTER_REFERENCE_MODES, normalizeReferenceSettings } from './generation-presets.js';

const NOVEL_PROTOCOL_CHANNEL_CAP = 4; // cap-ok: upstream director_reference_images and reference_image_multiple arrays accept at most 4 items

function isGeminiNativeImageModel(model) {
    const m = String(model || '').trim().toLowerCase();
    return Boolean(m) && !/^imagen|^imagegeneration|^veo/i.test(m);
}

function isOpenAiEditCapableModel(model) {
    const m = String(model || '').trim().toLowerCase();
    if (!m || m.includes('dall-e-3') || m.startsWith('sora-')) {
        return false;
    }
    return true;
}

function countActiveStyleReferences(sdSettings, styleReferencesEnabled) {
    if (!styleReferencesEnabled || !Array.isArray(sdSettings?.style_references)) {
        return 0;
    }
    return sdSettings.style_references.filter(entry => String(entry?.imagePath || '').trim()).length;
}

/**
 * Computes backend transport and ComfyUI workflow reference capabilities without consulting user switches.
 *
 * @param {object} [sdSettings={}]
 * @param {{ comfyReferenceSlotCount?: number, comfyWorkflowError?: string }} [runtimeInfo={}]
 */
export function computeProtocolCapabilities(sdSettings = {}, runtimeInfo = {}) {
    const source = String(sdSettings?.source || '').trim();
    const model = String(sdSettings?.model || '').trim();
    const lowerModel = model.toLowerCase();
    const comfyType = String(sdSettings?.comfy_type || 'standard').trim() || 'standard';
    const rawSlots = Number(runtimeInfo?.comfyReferenceSlotCount || 0);
    const parsedSlots = Number.isFinite(rawSlots) ? Math.max(0, rawSlots) : 0;
    const comfyWorkflowError = runtimeInfo?.comfyWorkflowError ? String(runtimeInfo.comfyWorkflowError) : '';
    const isStandardComfy = source === 'comfy' && comfyType === 'standard';
    const comfyReferenceSlotCount = isStandardComfy && !comfyWorkflowError ? parsedSlots : 0;

    const base = {
        supportsCharacterReference: false,
        maxCharacterReferences: 0,
        supportsStyleReference: false,
        maxStyleReferences: 0,
        supportsSourceImage: false,
        supportsMultiCharacterPrompts: false,
        supportsDynamicAspectRatio: true,
        sharedReferenceSlots: false,
        maxTotalReferences: null,
        comfyReferenceSlotCount,
        comfyWorkflowError: isStandardComfy ? comfyWorkflowError : '',
    };

    switch (source) {
        case 'google': {
            if (isGeminiNativeImageModel(lowerModel)) {
                return {
                    ...base,
                    supportsCharacterReference: true,
                    maxCharacterReferences: null,
                    supportsStyleReference: true,
                    maxStyleReferences: null,
                    supportsSourceImage: true,
                };
            }
            return base;
        }
        case 'chat_image':
        case 'openrouter':
        case 'xai':
            return {
                ...base,
                supportsCharacterReference: true,
                maxCharacterReferences: null,
                supportsStyleReference: true,
                maxStyleReferences: null,
                supportsSourceImage: true,
            };
        case 'openai': {
            if (lowerModel.includes('dall-e-2')) {
                return {
                    ...base,
                    supportsCharacterReference: true,
                    maxCharacterReferences: 1,
                    supportsStyleReference: true,
                    maxStyleReferences: 1,
                    supportsSourceImage: true,
                    supportsDynamicAspectRatio: false,
                    sharedReferenceSlots: true,
                    maxTotalReferences: 1,
                };
            }
            if (isOpenAiEditCapableModel(lowerModel)) {
                return {
                    ...base,
                    supportsCharacterReference: true,
                    maxCharacterReferences: null,
                    supportsStyleReference: true,
                    maxStyleReferences: null,
                    supportsSourceImage: true,
                };
            }
            return base;
        }
        case 'novel': {
            const isV45 = lowerModel.startsWith('nai-diffusion-4-5');
            const isV4Plus = lowerModel.startsWith('nai-diffusion-4');
            const isV3 = lowerModel.startsWith('nai-diffusion-3') || lowerModel.startsWith('nai-diffusion-furry-3');
            return {
                ...base,
                supportsCharacterReference: isV45,
                maxCharacterReferences: isV45 ? NOVEL_PROTOCOL_CHANNEL_CAP : 0,
                supportsStyleReference: isV4Plus || isV3,
                maxStyleReferences: (isV4Plus || isV3) ? NOVEL_PROTOCOL_CHANNEL_CAP : 0,
                supportsSourceImage: true,
                supportsMultiCharacterPrompts: isV4Plus,
            };
        }
        case 'comfy': {
            if (!isStandardComfy) {
                return base;
            }
            const slots = comfyReferenceSlotCount;
            return {
                ...base,
                supportsCharacterReference: slots > 0,
                maxCharacterReferences: slots,
                supportsStyleReference: slots > 0,
                maxStyleReferences: slots,
                supportsSourceImage: slots > 0,
                sharedReferenceSlots: true,
                maxTotalReferences: slots,
            };
        }
        case 'auto':
        case 'vlad':
            return {
                ...base,
                supportsSourceImage: true,
            };
        default:
            return base;
    }
}

function buildReferenceConfigWarnings(sdSettings, refSettings, protocol) {
    const source = String(sdSettings?.source || '').trim();
    const comfyType = String(sdSettings?.comfy_type || 'standard').trim() || 'standard';
    const wantsCharacterImage = refSettings.character_reference_enabled && refSettings.character_reference_mode !== 'text_only';
    const wantsStyle = refSettings.style_references_enabled;
    const wantsSource = refSettings.img2img_enabled;
    const activeAffects = [
        wantsCharacterImage ? 'character_image' : null,
        wantsStyle ? 'style' : null,
        wantsSource ? 'source' : null,
    ].filter(Boolean);
    const activeStyleCount = countActiveStyleReferences(sdSettings, wantsStyle);
    const warnings = [];

    if (source === 'comfy') {
        if (comfyType !== 'standard') {
            if (activeAffects.length > 0) {
                warnings.push({
                    code: 'comfy_runpod_no_references',
                    message: 'RunPod Serverless mode does not support uploading reference images. Disable reference images and img2img, or switch character reference mode to text-only.',
                    affects: activeAffects,
                });
            }
            return warnings;
        }
        if (protocol.comfyWorkflowError) {
            if (activeAffects.length > 0) {
                warnings.push({
                    code: 'comfy_workflow_invalid',
                    message: 'Current ComfyUI workflow JSON could not be parsed to inspect %ref_image% reference nodes, so requests with reference images or img2img will fail.',
                    affects: activeAffects,
                });
            }
            return warnings;
        }
        if (protocol.comfyReferenceSlotCount === 0) {
            if (activeAffects.length > 0) {
                warnings.push({
                    code: 'comfy_missing_ref_slots',
                    message: 'Current ComfyUI workflow does not contain any %ref_image% LoadImage nodes, so requests with reference images or img2img will fail.',
                    affects: activeAffects,
                });
            }
            return warnings;
        }
    } else if (source === 'google') {
        if (!protocol.supportsCharacterReference && !protocol.supportsStyleReference && !protocol.supportsSourceImage && activeAffects.length > 0) {
            warnings.push({
                code: 'google_model_no_image_input',
                message: 'The selected Google model uses :predict or video generation and does not support reference images or img2img.',
                affects: activeAffects,
            });
        }
        return warnings;
    } else if (source === 'openai') {
        if (!protocol.supportsCharacterReference && !protocol.supportsStyleReference && !protocol.supportsSourceImage && activeAffects.length > 0) {
            warnings.push({
                code: 'openai_model_no_image_input',
                message: 'The selected OpenAI model does not support image edits or reference image inputs.',
                affects: activeAffects,
            });
            return warnings;
        }
    } else if (source === 'novel') {
        if (wantsCharacterImage && !protocol.supportsCharacterReference) {
            warnings.push({
                code: 'novel_char_ref_requires_v45',
                message: 'NovelAI character reference images require a V4.5 model. Switch to a V4.5 model or use text-only character descriptions.',
                affects: ['character_image'],
            });
        }
        if (wantsStyle && !protocol.supportsStyleReference) {
            warnings.push({
                code: 'novel_style_ref_unsupported',
                message: 'The selected NovelAI model does not support style/vibe references.',
                affects: ['style'],
            });
        } else if (wantsStyle && protocol.supportsStyleReference && protocol.maxStyleReferences !== null && activeStyleCount > protocol.maxStyleReferences) {
            warnings.push({
                code: 'novel_style_exceeds_cap',
                message: 'NovelAI supports at most 4 style references, so generation will fail.',
                affects: ['style'],
            });
        }
        return warnings;
    } else if (source === 'auto' || source === 'vlad') {
        const unsupportedAffects = [
            wantsCharacterImage ? 'character_image' : null,
            wantsStyle ? 'style' : null,
        ].filter(Boolean);
        if (unsupportedAffects.length > 0) {
            warnings.push({
                code: 'webui_source_only',
                message: 'The selected WebUI backend only supports source image editing (img2img) and does not support character or style reference images.',
                affects: unsupportedAffects,
            });
        }
        return warnings;
    } else if (!protocol.supportsCharacterReference && !protocol.supportsStyleReference && !protocol.supportsSourceImage) {
        if (activeAffects.length > 0) {
            warnings.push({
                code: 'backend_no_image_input',
                message: 'The selected image backend does not support image inputs. Switch character reference mode to text-only or disable reference images and img2img.',
                affects: activeAffects,
            });
        }
        return warnings;
    }

    if (protocol.sharedReferenceSlots && protocol.maxTotalReferences !== null && protocol.maxTotalReferences > 0) {
        if (wantsStyle && activeStyleCount > protocol.maxTotalReferences) {
            warnings.push({
                code: 'shared_style_exceeds_slots',
                message: 'Enabled style reference count exceeds the available reference slots in the current workflow or model, so generation will fail.',
                affects: ['style'],
            });
        }
        if (activeStyleCount >= protocol.maxTotalReferences) {
            const exhaustedAffects = [
                wantsCharacterImage ? 'character_image' : null,
                wantsSource ? 'source' : null,
            ].filter(Boolean);
            if (exhaustedAffects.length > 0) {
                warnings.push({
                    code: 'shared_slots_exhausted_by_style',
                    message: 'Enabled style references occupy all available reference slots, leaving no room for character reference images or img2img.',
                    affects: exhaustedAffects,
                });
            }
        }
    }

    return warnings;
}

/**
 * Computes configuration conflict warnings where user reference switches contradict backend protocol or workflow facts.
 *
 * @param {object} [sdSettings={}]
 * @param {{ comfyReferenceSlotCount?: number, comfyWorkflowError?: string }} [runtimeInfo={}]
 * @returns {Array<{ code: string, message: string, affects: Array<'character_image' | 'style' | 'source'> }>}
 */
export function computeReferenceConfigWarnings(sdSettings = {}, runtimeInfo = {}) {
    const refSettings = normalizeReferenceSettings(sdSettings);
    const protocol = computeProtocolCapabilities(sdSettings, runtimeInfo);
    return buildReferenceConfigWarnings(sdSettings, refSettings, protocol);
}

/**
 * Computes user-driven capabilities, protocol facts, shared-slot budgets, and configuration conflict warnings.
 *
 * @param {object} [sdSettings={}]
 * @param {{ comfyReferenceSlotCount?: number, comfyWorkflowError?: string, availableLoras?: { names: string[], includeWeight: boolean } }} [runtimeInfo={}]
 */
export function computeImageCapabilities(sdSettings = {}, runtimeInfo = {}) {
    const source = String(sdSettings?.source || '').trim();
    const model = String(sdSettings?.model || '').trim();
    const availableLoras = runtimeInfo?.availableLoras && Array.isArray(runtimeInfo.availableLoras.names)
        ? {
            names: [...runtimeInfo.availableLoras.names],
            includeWeight: Boolean(runtimeInfo.availableLoras.includeWeight),
        }
        : { names: [], includeWeight: false };

    const refSettings = normalizeReferenceSettings(sdSettings);
    const protocol = computeProtocolCapabilities(sdSettings, runtimeInfo);
    const warnings = buildReferenceConfigWarnings(sdSettings, refSettings, protocol);

    const characterReferenceEnabled = refSettings.character_reference_enabled;
    const characterReferenceMode = refSettings.character_reference_mode;
    const supportsCharacterTextReference = characterReferenceEnabled && characterReferenceMode !== 'image_only';
    const supportsCharacterReference = characterReferenceEnabled && characterReferenceMode !== 'text_only';
    const supportsStyleReference = refSettings.style_references_enabled;
    const supportsSourceImage = refSettings.img2img_enabled;

    const activeStyleCount = countActiveStyleReferences(sdSettings, supportsStyleReference);
    let maxCharacterReferences = 0;
    if (supportsCharacterReference) {
        if (protocol.sharedReferenceSlots && protocol.maxTotalReferences !== null) {
            maxCharacterReferences = Math.max(0, protocol.maxTotalReferences - activeStyleCount);
        } else {
            maxCharacterReferences = protocol.maxCharacterReferences;
        }
    }
    const maxStyleReferences = supportsStyleReference ? protocol.maxStyleReferences : 0;

    return {
        source,
        model,
        characterReferenceEnabled,
        characterReferenceMode,
        supportsCharacterTextReference,
        supportsCharacterReference,
        maxCharacterReferences,
        supportsStyleReference,
        maxStyleReferences,
        supportsSourceImage,
        supportsMultiCharacterPrompts: protocol.supportsMultiCharacterPrompts,
        supportsDynamicAspectRatio: protocol.supportsDynamicAspectRatio,
        availableLoras,
        protocol,
        warnings,
    };
}

export async function getCapabilities(sdSettings = {}, _context = null, runtimeInfo = {}) {
    return computeImageCapabilities(sdSettings, runtimeInfo);
}

/**
 * Resolves a validated character reference mode from capabilities, falling back to
 * `text_and_image` or `text_only` when `characterReferenceMode` is missing or unrecognized.
 *
 * @param {object|null|undefined} capabilities
 * @returns {'text_only' | 'image_only' | 'text_and_image'}
 */
export function resolveCharacterReferenceMode(capabilities) {
    const raw = String(capabilities?.characterReferenceMode || '').trim();
    if (CHARACTER_REFERENCE_MODES.includes(raw)) {
        return raw;
    }
    return capabilities?.supportsCharacterReference ? 'text_and_image' : 'text_only';
}

/**
 * Merges all preset style references when `capabilities.supportsStyleReference` is enabled,
 * leaving backend cap validation to `assertReferencesSupportedByProtocol`.
 *
 * @param {Array<object>} [explicitReferences=[]]
 * @param {Array<object>} [styleReferences=[]]
 * @param {object|null} [capabilities=null]
 * @returns {Array<object>}
 */
export function mergePresetStyleReferences(explicitReferences = [], styleReferences = [], capabilities = null) {
    const baseList = Array.isArray(explicitReferences) ? explicitReferences.map(ref => ({ ...ref })) : [];
    if (!capabilities?.supportsStyleReference || !Array.isArray(styleReferences) || styleReferences.length === 0) {
        return baseList;
    }
    const existingPaths = new Set(baseList.map(r => String(r?.imagePath || '').trim()).filter(Boolean));
    for (const entry of styleReferences) {
        const imagePath = String(entry?.imagePath || '').trim();
        if (!imagePath || existingPaths.has(imagePath)) {
            continue;
        }
        existingPaths.add(imagePath);
        baseList.push({
            imagePath,
            role: 'style',
            strength: Number.isFinite(Number(entry?.strength)) ? Number(entry.strength) : 0.6,
        });
    }
    return baseList;
}

function createRefError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/**
 * Asserts that outgoing references comply with backend protocol capabilities and shared-slot total limits.
 *
 * @param {Array<object>} [references=[]]
 * @param {object} protocol
 * @param {{ source?: string, model?: string }} [meta={}]
 */
export function assertReferencesSupportedByProtocol(references = [], protocol, { source = '', model = '' } = {}) {
    if (!Array.isArray(references) || references.length === 0 || !protocol) {
        return;
    }
    const backendSource = String(source || protocol?.source || '').trim();
    const backendModel = String(model || protocol?.model || '').trim();
    if (protocol.comfyWorkflowError) {
        throw createRefError('ref_workflow_error', `Image backend "${backendSource}" workflow error: ${protocol.comfyWorkflowError}`);
    }

    const unknownRole = references.find(r => {
        const role = r?.role || 'character';
        return role !== 'character' && role !== 'style' && role !== 'source';
    });
    if (unknownRole) {
        throw createRefError('ref_role_unsupported', `Unsupported reference image role "${unknownRole.role}".`);
    }

    const charRefs = references.filter(r => (r?.role || 'character') === 'character');
    const styleRefs = references.filter(r => r?.role === 'style');
    const sourceRefs = references.filter(r => r?.role === 'source');

    if (charRefs.length > 0 && !protocol.supportsCharacterReference) {
        throw createRefError('ref_role_unsupported', `Image backend "${backendSource}" (model "${backendModel}") does not support character reference images.`);
    }
    if (protocol.maxCharacterReferences !== null && protocol.maxCharacterReferences !== undefined && charRefs.length > protocol.maxCharacterReferences) {
        throw createRefError('ref_limit_exceeded', `Image backend "${backendSource}" supports at most ${protocol.maxCharacterReferences} character reference image(s); received ${charRefs.length}.`);
    }
    if (styleRefs.length > 0 && !protocol.supportsStyleReference) {
        throw createRefError('ref_role_unsupported', `Image backend "${backendSource}" (model "${backendModel}") does not support style reference images.`);
    }
    if (protocol.maxStyleReferences !== null && protocol.maxStyleReferences !== undefined && styleRefs.length > protocol.maxStyleReferences) {
        throw createRefError('ref_limit_exceeded', `Image backend "${backendSource}" supports at most ${protocol.maxStyleReferences} style reference image(s); received ${styleRefs.length}.`);
    }
    if (sourceRefs.length > 0 && !protocol.supportsSourceImage) {
        throw createRefError('ref_role_unsupported', `Image backend "${backendSource}" (model "${backendModel}") does not support source image editing.`);
    }
    if (
        protocol.sharedReferenceSlots
        && protocol.maxTotalReferences !== null
        && protocol.maxTotalReferences !== undefined
        && references.length > protocol.maxTotalReferences
    ) {
        throw createRefError('ref_limit_exceeded', `Image backend "${backendSource}" (model "${backendModel}") supports at most ${protocol.maxTotalReferences} total reference image(s); received ${references.length}.`);
    }
}

export function prepareGenerationExtraOptions(
    sdSettings = {},
    structuredOptions = {},
    { comfyReferenceSlotCount = 0, comfyWorkflowError = '', availableLoras = null, novelUnlimited = false } = {},
) {
    const capabilities = computeImageCapabilities(sdSettings, {
        comfyReferenceSlotCount,
        comfyWorkflowError,
        availableLoras,
    });
    const explicitReferences = Array.isArray(structuredOptions?.references)
        ? structuredOptions.references.map(ref => ({ ...ref }))
        : [];
    const mergedReferences = structuredOptions?.includePresetStyleReferences === false
        ? explicitReferences
        : mergePresetStyleReferences(
            explicitReferences,
            sdSettings?.style_references,
            capabilities,
        );
    if (mergedReferences.length > 0) {
        assertReferencesSupportedByProtocol(mergedReferences, capabilities.protocol, {
            source: capabilities.source,
            model: capabilities.model,
        });
    }

    let resolvedWidth = structuredOptions?.width;
    let resolvedHeight = structuredOptions?.height;
    const requestedAspectRatio = structuredOptions?.aspectRatio ? String(structuredOptions.aspectRatio).trim() : '';
    if (requestedAspectRatio && resolvedWidth === undefined && resolvedHeight === undefined) {
        const novelOpusFree = String(sdSettings?.source || '').trim() === 'novel'
            && Boolean(sdSettings?.novel_anlas_guard)
            && Boolean(novelUnlimited);
        const dims = resolveAspectRatioDimensions({
            aspectRatio: requestedAspectRatio,
            width: sdSettings?.width,
            height: sdSettings?.height,
            novelOpusFree,
        });
        resolvedWidth = dims.width;
        resolvedHeight = dims.height;
    }

    return {
        capabilities,
        extraOptions: {
            references: mergedReferences,
            characterPrompts: Array.isArray(structuredOptions?.characterPrompts) ? structuredOptions.characterPrompts : undefined,
            aspectRatio: requestedAspectRatio || undefined,
            width: resolvedWidth,
            height: resolvedHeight,
            seed: structuredOptions?.seed,
        },
    };
}

export function resolveAttributionPayload(attributionOption, context) {
    if (attributionOption === 'none' || attributionOption === false) {
        return null;
    }
    if (attributionOption && typeof attributionOption === 'object' && attributionOption.chat_name) {
        return {
            char_dir: String(attributionOption.char_dir || ''),
            chat_name: String(attributionOption.chat_name),
            is_group: Boolean(attributionOption.is_group),
        };
    }
    const chatId = context?.chatId ?? context?.getCurrentChatId?.() ?? '';
    if (!chatId) {
        return null;
    }
    const charId = context?.characterId;
    const avatar = (!context?.groupId && charId !== undefined && charId !== null)
        ? String(context?.characters?.[charId]?.avatar || '').replace(/\.png$/i, '')
        : '';
    return {
        char_dir: context?.groupId ? '' : avatar,
        chat_name: String(chatId),
        is_group: Boolean(context?.groupId),
    };
}

/**
 * Filters saved replay references against current user-driven capabilities, preserving enabled roles
 * and returning skipped entries so callers can notify the user.
 *
 * @param {Array<object>} [savedReferences=[]]
 * @param {object|null} [capabilities=null]
 * @returns {{ references: Array<object>, skipped: Array<object> }}
 */
export function filterReplayReferences(savedReferences, capabilities) {
    const list = Array.isArray(savedReferences) ? savedReferences : [];
    if (list.length === 0 || !capabilities || typeof capabilities !== 'object') {
        return { references: [...list], skipped: [] };
    }
    const references = [];
    const skipped = [];
    for (const ref of list) {
        if (!ref || typeof ref !== 'object') {
            continue;
        }
        const role = String(ref.role || 'character');
        let allowed = true;
        if (role === 'character') {
            allowed = Boolean(capabilities.supportsCharacterReference);
        } else if (role === 'source') {
            allowed = Boolean(capabilities.supportsSourceImage);
        } else if (role === 'style') {
            allowed = Boolean(capabilities.supportsStyleReference);
        }
        if (allowed) {
            references.push(ref);
        } else {
            skipped.push(ref);
        }
    }
    return { references, skipped };
}
