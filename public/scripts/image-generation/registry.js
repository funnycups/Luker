// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layer 1 platform registry for structured image generation.
// Exposed on Layer 2 (`Luker.getContext().imageGeneration` / `lukerContext.imageGeneration` /
// `getExtensionApi('sd')`) and Layer 3 (`card-app` `ctx.imageGeneration`).

function normalizeGenerateRequest(requestOrPrompt, options = {}) {
    if (typeof requestOrPrompt === 'string') {
        return {
            ...(options && typeof options === 'object' ? options : {}),
            prompt: requestOrPrompt,
        };
    }
    if (requestOrPrompt && typeof requestOrPrompt === 'object') {
        return {
            ...(options && typeof options === 'object' ? options : {}),
            ...requestOrPrompt,
        };
    }
    throw new Error('imageGeneration.generate requires a prompt string or request object.');
}

export function createImageGenerationRegistry() {
    let provider = null;

    function requireProvider() {
        if (!provider) {
            throw new Error('Image Generation service is not initialized or available.');
        }
        return provider;
    }

    const api = Object.freeze({
        isAvailable() {
            return Boolean(provider);
        },
        async generate(requestOrPrompt, options = {}) {
            const normalized = normalizeGenerateRequest(requestOrPrompt, options);
            if (!String(normalized.prompt || '').trim()) {
                throw new Error('imageGeneration.generate requires a non-empty prompt.');
            }
            return await requireProvider().generate(normalized);
        },
        async getCapabilities() {
            return await requireProvider().getCapabilities();
        },
        listPresets() {
            return requireProvider().listPresets();
        },
        getCurrentPreset() {
            return requireProvider().getCurrentPreset();
        },
        async switchPreset(idOrName) {
            return await requireProvider().switchPreset(idOrName);
        },
        async getAvailableLoras() {
            return await requireProvider().getAvailableLoras();
        },
    });

    return {
        api,
        setProvider(nextProvider) {
            provider = nextProvider && typeof nextProvider === 'object' ? nextProvider : null;
        },
        getProvider() {
            return provider;
        },
        reset() {
            provider = null;
        },
    };
}

export const defaultImageGenerationRegistry = createImageGenerationRegistry();

export const imageGenerationApi = defaultImageGenerationRegistry.api;
export const setImageGenerationProvider = (p) => defaultImageGenerationRegistry.setProvider(p);
export const getImageGenerationProvider = () => defaultImageGenerationRegistry.getProvider();
export const resetImageGenerationProvider = () => defaultImageGenerationRegistry.reset();
