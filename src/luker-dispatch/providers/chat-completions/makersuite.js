// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchLog as console } from '../../logging.js';
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Google MakerSuite (Google AI Studio) and Google Vertex AI
// chat completions. Both CHAT_COMPLETION_SOURCES.MAKERSUITE and
// CHAT_COMPLETION_SOURCES.VERTEXAI route through this function, distinguished
// by `ctx.body.chat_completion_source`.
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.

import util from 'node:util';

import {
    CHAT_COMPLETION_SOURCES,
    GEMINI_SAFETY,
    VERTEX_SAFETY,
} from '../../../constants.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { getVertexAIAuth, getProjectIdFromServiceAccount } from '../../../endpoints/google.js';
import { getVertexApiHost } from '../../../endpoints/vertex-host.js';
import {
    convertGooglePrompt,
    calculateGoogleBudgetTokens,
    getPromptNames,
} from '../../../prompt-converters.js';
import {
    buildGeminiFunctionDeclaration,
    convertGeminiToolChoice,
    getConfigValue,
} from '../../../util.js';
import {
    resolveGeminiModelCapabilities,
    validateGeminiRequestCapabilities,
} from '../../../../public/scripts/lib/provider-capabilities.js';
import { resolveEffectiveApiKey } from '../../../request-inspector.js';
import { applyAdditionalParameters } from './custom-params.js';
import { normalizeReasoningToken } from './reasoning-params.js';
import {
    emitCapabilityConflict,
    handleProviderDispatchError,
    relayUpstreamResponse,
} from './upstream-relay.js';
import { normalizeProviderBaseUrl } from '../../../util/base-url.js';

const API_MAKERSUITE = 'https://generativelanguage.googleapis.com';
const API_VERTEX_AI = 'https://us-central1-aiplatform.googleapis.com';

/**
 * Build a minimal request shim for helpers (getVertexAIAuth) that expect
 * `.body` and `.user.directories`.
 * @param {object} ctx DispatchContext
 * @returns {{ body: any, user: { directories: any } }}
 */
function buildLegacyRequestShim(ctx) {
    return {
        body: ctx.body,
        user: { directories: ctx.user?.directories },
    };
}

/**
 * Dispatch a MakerSuite / Vertex AI chat completion request through the
 * transport-agnostic event bus. Does NOT return a payload; results flow to
 * the caller via ctx.emit.{head,chunk,end,error}.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchMakerSuite(ctx) {
    const body = ctx.body || {};
    ctx.inspection.start();
    const useVertexAi = body.chat_completion_source === CHAT_COMPLETION_SOURCES.VERTEXAI;
    const apiName = useVertexAi ? 'Google Vertex AI' : 'Google AI Studio';

    let apiUrl;
    let apiKey;
    let authHeader;
    let authType;

    if (useVertexAi) {
        try {
            apiUrl = new URL(normalizeProviderBaseUrl('vertexai', body.reverse_proxy || body.base_url || API_VERTEX_AI));
        } catch (parseErr) {
            const err = new Error(`${apiName} upstream URL invalid: ${parseErr?.message || parseErr}`);
            ctx.inspection.fail(err, 400);
            ctx.emit.error(err);
            return;
        }
        try {
            const auth = await getVertexAIAuth(buildLegacyRequestShim(ctx));
            authHeader = auth.authHeader;
            authType = auth.authType;
            console.debug(`Using Vertex AI authentication type: ${authType}`);
        } catch (authErr) {
            console.warn(`${apiName} authentication failed: ${authErr.message}`);
            const err = new Error(authErr.message);
            ctx.inspection.fail(err, 400);
            ctx.emit.error(err);
            return;
        }
    } else {
        try {
            apiUrl = new URL(normalizeProviderBaseUrl('makersuite', body.reverse_proxy || body.base_url || API_MAKERSUITE));
        } catch (parseErr) {
            const err = new Error(`${apiName} upstream URL invalid: ${parseErr?.message || parseErr}`);
            ctx.inspection.fail(err, 400);
            ctx.emit.error(err);
            return;
        }
        const bodyApiKey = typeof body.proxy_password === 'string' ? body.proxy_password : '';
        apiKey = bodyApiKey || ctx.secrets.read(SECRET_KEYS.MAKERSUITE) || '';

        if (!body.base_url && !body.reverse_proxy && !apiKey) {
            console.warn(`${apiName} API key is missing.`);
            const err = new Error(`${apiName} API key is missing`);
            ctx.inspection.fail(err, 400);
            ctx.emit.error(err);
            return;
        }

        authHeader = `Bearer ${apiKey}`;
        authType = 'api_key';
    }

    const model = String(body.model);
    const stream = Boolean(body.stream);
    const enableWebSearch = Boolean(body.enable_web_search);
    const requestImages = Boolean(body.request_images);
    const reasoningEffort = String(body.reasoning_effort);
    const includeReasoning = Boolean(body.include_reasoning);
    const aspectRatio = typeof body.request_image_aspect_ratio === 'string' ? body.request_image_aspect_ratio.trim() : '';
    const imageSize = typeof body.request_image_resolution === 'string' ? body.request_image_resolution.trim() : '';
    const caps = resolveGeminiModelCapabilities(model);

    const responseMimeType = body.responseMimeType ?? (body.json_schema ? 'application/json' : undefined);
    const responseSchema = body.responseSchema ?? (body.json_schema ? body.json_schema.value : undefined);

    const generationConfig = {
        stopSequences: body.stop,
        candidateCount: 1,
        maxOutputTokens: body.max_tokens,
        temperature: body.temperature,
        topP: body.top_p,
        topK: body.top_k || undefined,
        responseMimeType: responseMimeType,
        responseSchema: responseSchema,
        seed: body.seed,
    };

    const functionDeclarations = [];
    const customTools = [];
    if (Array.isArray(body.tools) && body.tools.length > 0) {
        for (const tool of body.tools) {
            if (tool?.type === 'function') {
                const functionDeclaration = buildGeminiFunctionDeclaration(tool.function);
                if (functionDeclaration) {
                    functionDeclarations.push(functionDeclaration);
                }
            } else if (tool && tool[tool.type]) {
                switch (tool.type) {
                    case 'google_search':
                    case 'googleSearch':
                        customTools.push({ googleSearch: tool[tool.type] });
                        break;
                    case 'code_execution':
                    case 'codeExecution':
                        customTools.push({ codeExecution: tool[tool.type] });
                        break;
                    case 'url_context':
                    case 'urlContext':
                        customTools.push({ urlContext: tool[tool.type] });
                        break;
                    default:
                        customTools.push({ [tool.type]: tool[tool.type] });
                        break;
                }
            }
        }
    }

    const hasBuiltinSearch = customTools.some(t => Object.hasOwn(t, 'googleSearch'));
    const capabilityConflict = validateGeminiRequestCapabilities({
        model,
        requestImages,
        hasFunctionTools: functionDeclarations.length > 0,
        enableWebSearch,
        hasCustomBuiltinTools: customTools.length > 0,
        hasBuiltinSearch,
    });
    if (capabilityConflict) {
        emitCapabilityConflict(ctx, capabilityConflict, apiName);
        return;
    }

    function getGeminiBody() {
        if (!Array.isArray(generationConfig.stopSequences) || !generationConfig.stopSequences.length) {
            delete generationConfig.stopSequences;
        }

        if (!caps.supportsSampling) {
            delete generationConfig.temperature;
            delete generationConfig.topP;
            delete generationConfig.topK;
            delete generationConfig.candidateCount;
        }
        if (caps.supportsSeed === false) {
            delete generationConfig.seed;
        }

        const enableImageModality = requestImages && caps.imageOutput !== 'unsupported';
        if (enableImageModality) {
            generationConfig.responseModalities = ['text', 'image'];
            const imageConfig = {};
            if (imageSize && caps.imageSize) {
                imageConfig.imageSize = imageSize;
            }
            if (aspectRatio) {
                imageConfig.aspectRatio = aspectRatio;
            }
            if (Object.keys(imageConfig).length > 0) {
                generationConfig.imageConfig = imageConfig;
            }
        }

        const useSystemPrompt = caps.systemInstruction && Boolean(body.use_sysprompt);

        const tools = [];
        const prompt = convertGooglePrompt(body.messages, model, useSystemPrompt, getPromptNames({ body }));
        const safetySettings = [...GEMINI_SAFETY, ...(useVertexAi ? VERTEX_SAFETY : [])];

        if (functionDeclarations.length > 0) {
            tools.push({ functionDeclarations });
        }
        if (customTools.length > 0) {
            tools.push(...customTools);
        }
        if (enableWebSearch && !hasBuiltinSearch) {
            tools.push({ googleSearch: {} });
        }

        if (caps.thinkingMode !== 'none') {
            const reasoningToken = normalizeReasoningToken(reasoningEffort);
            const thinkingConfig = { includeThoughts: includeReasoning };

            if (reasoningToken === 'off') {
                if (caps.thinkingSupportsOff) {
                    if (caps.thinkingMode === 'level') {
                        thinkingConfig.thinkingLevel = caps.thinkingSupportsMinimal ? 'minimal' : 'low';
                    } else {
                        thinkingConfig.thinkingBudget = 0;
                    }
                }
            } else {
                const thinkingBudget = calculateGoogleBudgetTokens(generationConfig.maxOutputTokens, reasoningToken, model);
                if (typeof thinkingBudget === 'number' && Number.isInteger(thinkingBudget)) {
                    thinkingConfig.thinkingBudget = thinkingBudget;
                }
                if (typeof thinkingBudget === 'string' && thinkingBudget.length > 0) {
                    thinkingConfig.thinkingLevel = thinkingBudget;
                }
            }

            // Vertex doesn't allow mixing disabled thinking with includeThoughts
            if (useVertexAi && thinkingConfig.thinkingBudget === 0 && thinkingConfig.includeThoughts) {
                console.info('Thinking budget is 0, but includeThoughts is true. Thoughts will not be included in the response.');
                thinkingConfig.includeThoughts = false;
            }

            generationConfig.thinkingConfig = thinkingConfig;
        }

        let requestBody = {
            contents: prompt.contents,
            safetySettings: safetySettings,
            generationConfig: generationConfig,
        };

        if (useSystemPrompt && Array.isArray(prompt.system_instruction.parts) && prompt.system_instruction.parts.length) {
            requestBody.systemInstruction = prompt.system_instruction;
        }

        if (tools.length) {
            requestBody.tools = tools;

            const hasFunctionDeclarations = tools.some(tool => Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0);
            const functionCallingConfig = hasFunctionDeclarations
                ? convertGeminiToolChoice(body.tool_choice)
                : null;

            if (hasFunctionDeclarations && functionCallingConfig) {
                requestBody.toolConfig = { functionCallingConfig };
            }
        }

        return requestBody;
    }

    const requestBody = getGeminiBody();
    console.debug(`${apiName} request:`, requestBody);

    try {
        const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
        const responseType = (stream ? 'streamGenerateContent' : 'generateContent');

        let url;
        let headers = {
            'Content-Type': 'application/json',
        };

        if (useVertexAi) {
            if (authType === 'express') {
                // For Express mode (API key authentication), use the key parameter
                const keyParam = authHeader.replace('Bearer ', '');
                const region = body.vertexai_region || 'us-central1';
                const projectId = body.vertexai_express_project_id;
                const baseUrl = getVertexApiHost(region);
                url = projectId
                    ? `${baseUrl}/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}?key=${keyParam}${stream ? '&alt=sse' : ''}`
                    : `${baseUrl}/v1/publishers/google/models/${model}:${responseType}?key=${keyParam}${stream ? '&alt=sse' : ''}`;
            } else if (authType === 'full') {
                // For Full mode (service account authentication), use project-specific URL
                // Get project ID from Service Account JSON
                const serviceAccountJson = ctx.secrets.read(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT);
                if (!serviceAccountJson) {
                    console.warn('Vertex AI Service Account JSON is missing.');
                    const err = new Error('Vertex AI Service Account JSON is missing');
                    ctx.inspection.fail(err, 400);
                    ctx.emit.error(err);
                    return;
                }

                let projectId;
                try {
                    const serviceAccount = JSON.parse(serviceAccountJson);
                    projectId = getProjectIdFromServiceAccount(serviceAccount);
                } catch (error) {
                    console.error('Failed to extract project ID from Service Account JSON:', error);
                    const err = new Error('Failed to extract project ID from Service Account JSON');
                    ctx.inspection.fail(err, 400);
                    ctx.emit.error(err);
                    return;
                }
                const region = body.vertexai_region || 'us-central1';
                url = `${getVertexApiHost(region)}/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                headers['Authorization'] = authHeader;
            } else {
                // For proxy mode, use the original URL with Authorization header
                url = `${apiUrl.toString().replace(/\/$/, '')}/v1/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                headers['Authorization'] = authHeader;
            }
        } else {
            url = `${apiUrl.toString().replace(/\/$/, '')}/${apiVersion}/models/${model}:${responseType}?key=${apiKey}${stream ? '&alt=sse' : ''}`;
        }

        applyAdditionalParameters(requestBody, headers, body, { nestedBodyKey: 'generationConfig' });
        ctx.inspection.attach(url, resolveEffectiveApiKey(headers, apiKey || '', ['authorization', 'x-goog-api-key']), requestBody);
        const generateResponse = await ctx.fetch(url, {
            body: JSON.stringify(requestBody),
            method: 'POST',
            headers: headers,
            signal: ctx.signal,
        });

        await relayUpstreamResponse(ctx, generateResponse, {
            label: apiName,
            stream,
            completeInspection: true,
            logResponse: (json) => console.debug(`${apiName} response:`, util.inspect(json, { depth: 5, colors: true })),
        });
    } catch (error) {
        handleProviderDispatchError(ctx, error, apiName);
    }
}
