// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure live behavioral summary model for Image Captioning.
// All runtime checks mirror public/scripts/extensions/caption/index.js
// and getMultimodalCaption / throwIfInvalidModel in shared.js.
// No DOM dependencies.

const MULTIMODAL_SUBFIELDS = Object.freeze([
    'multimodalApi',
    'multimodalModel',
    'customModel',
    'ollamaCustomModel',
    'allowReverseProxy',
    'altEndpointEnabled',
    'altEndpointUrl',
    'prompt',
    'promptAsk',
]);

const ALT_ENDPOINT_APIS = new Set([
    'koboldcpp',
    'ollama',
    'vllm',
    'llamacpp',
    'ooba',
]);

const REVERSE_PROXY_APIS = new Set([
    'openai',
    'anthropic',
    'google',
    'vertexai',
    'mistral',
    'xai',
    'zai',
    'moonshot',
]);

const VIDEO_CAPTION_APIS = new Set([
    'google',
    'vertexai',
    'zai',
]);

const API_LABELS = Object.freeze({
    aimlapi: 'AI/ML API',
    chutes: 'Chutes',
    anthropic: 'Claude',
    workers_ai: 'Cloudflare Workers AI',
    cohere: 'Cohere',
    custom: 'Custom (OpenAI-compatible)',
    electronhub: 'Electron Hub',
    google: 'Google AI Studio',
    vertexai: 'Google Vertex AI',
    groq: 'Groq',
    koboldcpp: 'KoboldCpp',
    llamacpp: 'llama.cpp',
    mistral: 'MistralAI',
    moonshot: 'Moonshot AI',
    nanogpt: 'NanoGPT',
    ollama: 'Ollama',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    ooba: 'Text Generation WebUI (oobabooga)',
    pollinations: 'Pollinations',
    vllm: 'vLLM',
    xai: 'xAI (Grok)',
    zai: 'Z.AI (GLM)',
});

function defaultTranslate(text, key = null) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? ''), key) : String(text ?? '');
}

function resolveSourceLabel(source, translate) {
    switch (source) {
        case 'multimodal':
            return translate('Multimodal');
        case 'horde':
            return translate('Horde');
        case 'local':
        default:
            return translate('Local');
    }
}

function resolveApiLabel(api, explicitLabel, translate) {
    if (explicitLabel) {
        return explicitLabel;
    }
    if (api === 'custom') {
        return translate('Custom (OpenAI-compatible)');
    }
    if (api === 'ooba') {
        return translate('Text Generation WebUI (oobabooga)');
    }
    return API_LABELS[api] || api || translate('none selected');
}

function resolveModelToken(state, multimodalApi, multimodalModel, translate) {
    const customModel = String(state.customModel || '').trim();
    const ollamaCustomModel = String(state.ollamaCustomModel || '').trim();

    if (multimodalApi === 'custom' && multimodalModel === 'custom_custom') {
        return {
            field: 'customModel',
            text: customModel || translate('empty model ID'),
            tone: customModel ? 'active' : 'danger',
        };
    }

    if (multimodalApi === 'ollama' && multimodalModel === 'ollama_custom') {
        return {
            field: 'ollamaCustomModel',
            text: ollamaCustomModel || translate('empty model tag'),
            tone: ollamaCustomModel ? 'active' : 'danger',
        };
    }

    if (multimodalApi === 'ollama' && multimodalModel === 'ollama_current') {
        const currentOllama = String(state.currentOllamaModel || '').trim();
        return {
            field: 'multimodalModel',
            text: currentOllama || translate('[Currently selected]', 'currently_selected'),
            tone: 'active',
        };
    }

    if (multimodalApi === 'custom' && multimodalModel === 'custom_current') {
        const currentCustom = String(state.currentCustomModel || '').trim();
        return {
            field: 'multimodalModel',
            text: currentCustom || translate('[Currently selected]', 'currently_selected'),
            tone: 'active',
        };
    }

    if (multimodalApi === 'vllm' && multimodalModel === 'vllm_current') {
        const currentVllm = String(state.currentVllmModel || '').trim();
        return {
            field: 'multimodalModel',
            text: currentVllm || translate('[Currently selected]', 'currently_selected'),
            tone: 'active',
        };
    }

    if (['llamacpp', 'ooba', 'koboldcpp'].includes(multimodalApi) && multimodalModel.endsWith('_current')) {
        return {
            field: 'multimodalModel',
            text: translate('[Currently loaded]', 'currently_loaded'),
            tone: 'active',
        };
    }

    const explicitModelLabel = String(state.multimodalModelLabel || '').trim();
    const displayModel = explicitModelLabel || multimodalModel;
    return {
        field: 'multimodalModel',
        text: displayModel || translate('none selected'),
        tone: displayModel ? 'active' : 'warn',
    };
}

/**
 * Builds the live behavioral summary model for Image Captioning settings.
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildCaptionSummaryModel(state = {}) {
    const translate = typeof state.i18n === 'function'
        ? state.i18n
        : (typeof state.translate === 'function' ? state.translate : defaultTranslate);

    const rawSource = String(state.source || 'local').trim();
    const source = (rawSource === 'multimodal' || rawSource === 'horde') ? rawSource : 'local';
    const isMultimodal = source === 'multimodal';

    const multimodalApi = String(state.multimodalApi || 'openai').trim();
    const multimodalApiLabel = resolveApiLabel(multimodalApi, String(state.multimodalApiLabel || '').trim(), translate);
    const multimodalModel = String(state.multimodalModel || '').trim();
    const customModel = String(state.customModel || '').trim();
    const ollamaCustomModel = String(state.ollamaCustomModel || '').trim();

    const allowReverseProxy = Boolean(state.allowReverseProxy);
    const reverseProxyConfigured = state.reverseProxyConfigured !== undefined
        ? Boolean(state.reverseProxyConfigured)
        : true;
    const altEndpointEnabled = Boolean(state.altEndpointEnabled);
    const altEndpointUrl = String(state.altEndpointUrl || '').trim();
    const promptAsk = Boolean(state.promptAsk);
    const hasStoredPrompt = state.prompt === undefined || Boolean(String(state.prompt ?? '').trim());

    const autoMode = Boolean(state.autoMode);
    const refineMode = Boolean(state.refineMode);
    const showInChat = Boolean(state.showInChat);
    const templateRaw = state.template === undefined
        ? '[{{user}} sends {{char}} a picture that contains: {{caption}}]'
        : String(state.template ?? '');
    const effectiveTemplate = templateRaw || '[{{user}} sends {{char}} a picture that contains: {{caption}}]';
    const hasCaptionMacro = /\{\{caption\}\}/i.test(effectiveTemplate);

    let engineRow;
    if (!isMultimodal) {
        engineRow = {
            role: translate('Engine'),
            template: source === 'horde'
                ? translate('${source} — distributed worker captioning (images only).')
                : translate('${source} — local captioning pipeline (images only).'),
            tokens: {
                source: {
                    field: 'source',
                    text: resolveSourceLabel(source, translate),
                    tone: 'active',
                },
            },
        };
    } else {
        const modelToken = resolveModelToken(state, multimodalApi, multimodalModel, translate);
        const videoEligible = VIDEO_CAPTION_APIS.has(multimodalApi);
        const mediaSupportToken = {
            field: null,
            text: videoEligible ? translate('images and video') : translate('images only'),
            tone: videoEligible ? 'active' : 'off',
        };
        const promptAskToken = {
            field: 'promptAsk',
            text: promptAsk
                ? translate('asks for custom prompt per caption')
                : translate('uses stored Caption Prompt'),
            tone: promptAsk ? 'active' : 'off',
        };

        const engineTokens = {
            source: {
                field: 'source',
                text: resolveSourceLabel(source, translate),
                tone: 'active',
            },
            multimodalApi: {
                field: 'multimodalApi',
                text: multimodalApiLabel,
                tone: 'active',
            },
            model: modelToken,
            mediaSupport: mediaSupportToken,
            promptAsk: promptAskToken,
        };

        const usesReverseProxy = REVERSE_PROXY_APIS.has(multimodalApi) && allowReverseProxy;
        const usesAltEndpoint = ALT_ENDPOINT_APIS.has(multimodalApi) && altEndpointEnabled;

        if (usesReverseProxy) {
            engineTokens.allowReverseProxy = {
                field: 'allowReverseProxy',
                text: reverseProxyConfigured
                    ? translate('reverse proxy allowed')
                    : translate('reverse proxy allowed when URL set'),
                tone: 'active',
            };
            engineRow = {
                role: translate('Engine'),
                template: translate('${source} via ${multimodalApi} (${model}, ${allowReverseProxy}) — ${mediaSupport}, ${promptAsk}.'),
                tokens: engineTokens,
            };
        } else if (usesAltEndpoint) {
            engineTokens.altEndpoint = {
                field: altEndpointUrl ? ['altEndpointEnabled', 'altEndpointUrl'] : 'altEndpointUrl',
                text: altEndpointUrl || translate('missing secondary URL'),
                tone: altEndpointUrl ? 'active' : 'danger',
            };
            engineRow = {
                role: translate('Engine'),
                template: translate('${source} via ${multimodalApi} (${model}, ${altEndpoint}) — ${mediaSupport}, ${promptAsk}.'),
                tokens: engineTokens,
            };
        } else {
            engineRow = {
                role: translate('Engine'),
                template: translate('${source} via ${multimodalApi} (${model}) — ${mediaSupport}, ${promptAsk}.'),
                tokens: engineTokens,
            };
        }
    }

    const behaviorTokens = {
        autoMode: {
            field: 'autoMode',
            text: autoMode
                ? translate('Auto-captions new uploads')
                : translate('Manual & /caption only'),
            tone: autoMode ? 'active' : 'off',
        },
        showInChat: {
            field: 'showInChat',
            text: showInChat
                ? translate('shows manual/slash captions inline')
                : translate('hides manual/slash captions in chat'),
            tone: showInChat ? 'active' : 'off',
        },
        refineMode: {
            field: 'refineMode',
            text: refineMode
                ? translate('opens edit popup before saving')
                : translate('saves directly without review'),
            tone: refineMode ? 'active' : 'off',
        },
        template: {
            field: 'template',
            text: hasCaptionMacro
                ? translate('Message Template')
                : translate('Message Template (auto-appends {{caption}})'),
            tone: hasCaptionMacro ? 'active' : 'warn',
        },
    };
    if (autoMode) {
        behaviorTokens.showInChatLabel = {
            field: 'showInChat',
            text: translate('Show captions in chat'),
            tone: 'off',
        };
    }

    const behaviorRow = {
        role: translate('Behavior'),
        template: autoMode
            ? translate('${autoMode} (auto-captioning uses message text presence instead of ${showInChatLabel}) · ${showInChat} · ${refineMode} · ${template}.')
            : translate('${autoMode} · ${showInChat} · ${refineMode} · ${template}.'),
        tokens: behaviorTokens,
    };

    const warnings = [];
    if (isMultimodal && ALT_ENDPOINT_APIS.has(multimodalApi) && altEndpointEnabled && !altEndpointUrl) {
        warnings.push({
            severity: 'danger',
            template: translate('${altEndpointEnabled} is checked while ${altEndpointUrl} is empty — multimodal captioning will fail until a URL is set.'),
            tokens: {
                altEndpointEnabled: {
                    field: 'altEndpointEnabled',
                    text: translate('Use secondary URL'),
                    tone: 'danger',
                },
                altEndpointUrl: {
                    field: 'altEndpointUrl',
                    text: translate('Secondary captioning endpoint URL'),
                    tone: 'danger',
                },
            },
        });
    }

    if (isMultimodal && multimodalApi === 'custom' && multimodalModel === 'custom_custom' && !customModel) {
        warnings.push({
            severity: 'danger',
            template: translate('${multimodalModel} is selected while ${customModel} is empty — caption requests will fail until a model ID is entered.'),
            tokens: {
                multimodalModel: {
                    field: 'multimodalModel',
                    text: translate('[Custom model]'),
                    tone: 'danger',
                },
                customModel: {
                    field: 'customModel',
                    text: translate('Model Id'),
                    tone: 'danger',
                },
            },
        });
    }

    if (isMultimodal && multimodalApi === 'ollama' && multimodalModel === 'ollama_custom' && !ollamaCustomModel) {
        warnings.push({
            severity: 'danger',
            template: translate('${multimodalModel} is selected while ${ollamaCustomModel} is empty — caption requests will fail until a model tag is entered.'),
            tokens: {
                multimodalModel: {
                    field: 'multimodalModel',
                    text: translate('[Custom model]'),
                    tone: 'danger',
                },
                ollamaCustomModel: {
                    field: 'ollamaCustomModel',
                    text: translate('Custom Model Tag'),
                    tone: 'danger',
                },
            },
        });
    }

    if (isMultimodal && !promptAsk && !hasStoredPrompt) {
        warnings.push({
            severity: 'danger',
            template: translate('${prompt} is empty while ${promptAsk} is off — multimodal caption requests will fail until a prompt is set or restored.'),
            tokens: {
                prompt: {
                    field: 'prompt',
                    text: translate('Caption Prompt'),
                    tone: 'danger',
                },
                promptAsk: {
                    field: 'promptAsk',
                    text: translate('Ask every time'),
                    tone: 'warn',
                },
            },
        });
    }

    const dormantFields = [];
    if (!isMultimodal) {
        dormantFields.push(...MULTIMODAL_SUBFIELDS);
    } else {
        if (!altEndpointEnabled) {
            dormantFields.push('altEndpointUrl');
        }
        if (!(multimodalApi === 'custom' && multimodalModel === 'custom_custom')) {
            dormantFields.push('customModel');
        }
        if (!(multimodalApi === 'ollama' && multimodalModel === 'ollama_custom')) {
            dormantFields.push('ollamaCustomModel');
        }
    }

    return {
        tone: warnings.some((w) => w.severity === 'danger')
            ? 'danger'
            : (warnings.length > 0 ? 'warn' : 'active'),
        rows: [engineRow, behaviorRow],
        warnings,
        dormantFields,
    };
}
