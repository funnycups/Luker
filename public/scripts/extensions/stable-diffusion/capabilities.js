// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolveAspectRatioDimensions } from './aspect-ratio.js';

const NOVEL_PROTOCOL_CHANNEL_CAP = 4; // cap-ok: upstream director_reference_images and reference_image_multiple arrays accept at most 4 items

function isGeminiNativeImageModel(model) {
    const m = String(model || '').trim().toLowerCase();
    return /^gemini-.*-image/.test(m) || m === 'gemini-2.0-flash-exp';
}

function isOpenAiEditCapableModel(model) {
    const m = String(model || '').trim().toLowerCase();
    if (!m || m.includes('dall-e-3') || m.startsWith('sora-')) {
        return false;
    }
    return true;
}

/**
 * Computes structured capabilities for the currently configured image generation backend & model.
 *
 * @param {object} [sdSettings={}]
 * @param {{ comfyReferenceSlotCount?: number, availableLoras?: { names: string[], includeWeight: boolean } }} [runtimeInfo={}]
 */
export function computeImageCapabilities(sdSettings = {}, runtimeInfo = {}) {
    const source = String(sdSettings?.source || '').trim();
    const model = String(sdSettings?.model || '').trim();
    const lowerModel = model.toLowerCase();
    const availableLoras = runtimeInfo?.availableLoras && Array.isArray(runtimeInfo.availableLoras.names)
        ? {
            names: [...runtimeInfo.availableLoras.names],
            includeWeight: Boolean(runtimeInfo.availableLoras.includeWeight),
        }
        : { names: [], includeWeight: false };

    const base = {
        source,
        model,
        supportsCharacterReference: false,
        maxCharacterReferences: 0,
        supportsStyleReference: false,
        maxStyleReferences: 0,
        supportsSourceImage: false,
        supportsMultiCharacterPrompts: false,
        supportsDynamicAspectRatio: true,
        availableLoras,
    };

    switch (source) {
        case 'google': {
            if (lowerModel.startsWith('veo-')) {
                return base;
            }
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
                    supportsSourceImage: true,
                    supportsDynamicAspectRatio: false,
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
            if (String(sdSettings?.comfy_type || 'standard') !== 'standard') {
                return base;
            }
            const slots = Math.max(0, Number(runtimeInfo?.comfyReferenceSlotCount || 0));
            return {
                ...base,
                supportsCharacterReference: slots > 0,
                maxCharacterReferences: slots,
                supportsStyleReference: slots > 0,
                maxStyleReferences: slots,
                supportsSourceImage: slots > 0,
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

export async function getCapabilities(sdSettings = {}, _context = null, runtimeInfo = {}) {
    return computeImageCapabilities(sdSettings, runtimeInfo);
}

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
        if (
            capabilities.maxStyleReferences !== null
            && capabilities.maxStyleReferences !== undefined
            && baseList.filter(r => r.role === 'style').length >= capabilities.maxStyleReferences
        ) {
            break;
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

export function assertReferencesSupportedByCapabilities(references = [], capabilities) {
    if (!Array.isArray(references) || references.length === 0 || !capabilities) {
        return;
    }
    const charRefs = references.filter(r => (r?.role || 'character') === 'character');
    const styleRefs = references.filter(r => r?.role === 'style');
    const sourceRefs = references.filter(r => r?.role === 'source');

    if (charRefs.length > 0 && !capabilities.supportsCharacterReference) {
        throw new Error(`Image backend "${capabilities.source}" (model "${capabilities.model}") does not support character reference images.`);
    }
    if (capabilities.maxCharacterReferences !== null && charRefs.length > capabilities.maxCharacterReferences) {
        throw new Error(`Image backend "${capabilities.source}" supports at most ${capabilities.maxCharacterReferences} character reference image(s); received ${charRefs.length}.`);
    }
    if (styleRefs.length > 0 && !capabilities.supportsStyleReference) {
        throw new Error(`Image backend "${capabilities.source}" (model "${capabilities.model}") does not support style reference images.`);
    }
    if (capabilities.maxStyleReferences !== null && styleRefs.length > capabilities.maxStyleReferences) {
        throw new Error(`Image backend "${capabilities.source}" supports at most ${capabilities.maxStyleReferences} style reference image(s); received ${styleRefs.length}.`);
    }
    if (sourceRefs.length > 0 && !capabilities.supportsSourceImage) {
        throw new Error(`Image backend "${capabilities.source}" (model "${capabilities.model}") does not support source image editing.`);
    }
}

export function prepareGenerationExtraOptions(
    sdSettings = {},
    structuredOptions = {},
    { comfyReferenceSlotCount = 0, availableLoras = null, novelUnlimited = false } = {},
) {
    const capabilities = computeImageCapabilities(sdSettings, {
        comfyReferenceSlotCount,
        availableLoras,
    });
    const mergedReferences = structuredOptions?.includePresetStyleReferences === false
        ? (Array.isArray(structuredOptions?.references) ? structuredOptions.references : [])
        : mergePresetStyleReferences(
            structuredOptions?.references,
            sdSettings?.style_references,
            capabilities,
        );
    const isStandardComfy = String(sdSettings?.source || '').trim() === 'comfy'
        && String(sdSettings?.comfy_type || 'standard') === 'standard';
    if (mergedReferences.length > 0 && !isStandardComfy) {
        assertReferencesSupportedByCapabilities(mergedReferences, capabilities);
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
