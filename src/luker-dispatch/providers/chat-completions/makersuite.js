// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for Google MakerSuite (Google AI Studio) AND Google Vertex AI
// chat completions. Extracted from legacy `sendMakerSuiteRequest`
// (src/endpoints/backends/chat-completions.js:825-1148, ~330 lines).
// Both CHAT_COMPLETION_SOURCES.MAKERSUITE and CHAT_COMPLETION_SOURCES.VERTEXAI
// route through this single function; distinguished by
// `ctx.body.chat_completion_source`.
//
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// head/chunk/end/error events; never touches Express request/response.
//
// Follows the 8-step template established by claude.js. Google specifics:
//   - MAKERSUITE: regular API key auth (SECRET_KEYS.MAKERSUITE), URL is
//     {base}/{apiVersion}/models/{model}:{generateContent|streamGenerateContent}
//     ?key={apiKey}[&alt=sse]
//   - VERTEXAI: service-account (`full`), express-mode API key, or reverse-proxy
//     auth via getVertexAIAuth(). URL varies by authType (express/full/proxy)
//     and by region (`global` uses no region prefix).
//   - Both build the same Gemini-shaped body (contents/safetySettings/
//     generationConfig/systemInstruction/tools/toolConfig).
//   - Non-streaming responses are normalized to OpenAI shape via
//     normalizeGeminiResponseToOAI before emission.
//
// getVertexAIAuth() and readProviderSecret() expect an Express-request-like
// shape (`request.body`, `request.user.directories`); we synthesize a minimal
// shim from ctx.body + ctx.user.directories so we can reuse them verbatim.

import util from 'node:util';

import {
    CHAT_COMPLETION_SOURCES,
    GEMINI_SAFETY,
    VERTEX_SAFETY,
} from '../../../constants.js';
import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { getVertexAIAuth, getProjectIdFromServiceAccount } from '../../../endpoints/google.js';
import {
    convertGooglePrompt,
    calculateGoogleBudgetTokens,
    getPromptNames,
} from '../../../prompt-converters.js';
import {
    buildGeminiFunctionDeclaration,
    convertGeminiToolChoice,
    getConfigValue,
    tryParse,
} from '../../../util.js';
import { normalizeGeminiResponseToOAI } from '../../../endpoints/backends/chat-completions.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';

const API_MAKERSUITE = 'https://generativelanguage.googleapis.com';
const API_VERTEX_AI = 'https://us-central1-aiplatform.googleapis.com';

/**
 * Build a minimal Express-request shim for legacy helpers (getVertexAIAuth,
 * readProviderSecret) that expect `.body` and `.user.directories`.
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
 * Resolve MAKERSUITE API key honoring proxy_password override and optional
 * `secret_id` in body (via ctx.secrets.read).
 * @param {object} ctx DispatchContext
 * @returns {string}
 */
function resolveMakerSuiteApiKey(ctx) {
    const body = ctx.body || {};
    if (typeof body.proxy_password === 'string' && body.proxy_password) {
        return body.proxy_password;
    }
    const requestedId = typeof body.secret_id === 'string'
        ? body.secret_id.trim()
        : (typeof body.secretId === 'string' ? body.secretId.trim() : '');
    if (requestedId) {
        const byId = ctx.secrets.read(SECRET_KEYS.MAKERSUITE, { secretId: requestedId });
        if (byId) return byId;
    }
    return ctx.secrets.read(SECRET_KEYS.MAKERSUITE) || '';
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
            apiUrl = new URL(body.reverse_proxy || body.base_url || API_VERTEX_AI);
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
            apiUrl = new URL(body.reverse_proxy || body.base_url || API_MAKERSUITE);
        } catch (parseErr) {
            const err = new Error(`${apiName} upstream URL invalid: ${parseErr?.message || parseErr}`);
            ctx.inspection.fail(err, 400);
            ctx.emit.error(err);
            return;
        }
        apiKey = resolveMakerSuiteApiKey(ctx);

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
    const aspectRatio = String(body.request_image_aspect_ratio);
    const imageSize = String(body.request_image_resolution);
    const isGemma3 = /gemma-3/.test(model);
    const isLearnLM = model.includes('learnlm');

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

    function getGeminiBody() {
        // #region UGLY MODEL LISTS AREA
        const imageGenerationModels = [
            'gemini-2.0-flash-exp',
            'gemini-2.0-flash-exp-image-generation',
            'gemini-2.0-flash-preview-image-generation',
            'gemini-2.5-flash-image-preview',
            'gemini-2.5-flash-image',
            'gemini-3-pro-image-preview',
            'gemini-3.1-flash-image-preview',
        ];

        const isThinkingConfigModel = m => (/^gemini-2.5-(flash|pro)/.test(m) && !/-image(-preview)?$/.test(m)) || (/^gemini-3[.\d]*-(flash|pro)/.test(m));
        const isImageSizeModel = m => /^gemini-3/.test(m);

        const noSearchModels = [
            'gemini-2.0-flash-lite',
            'gemini-2.0-flash-lite-001',
            'gemini-2.0-flash-lite-preview-02-05',
            'gemini-robotics-er-1.5-preview',
        ];
        // #endregion

        if (!Array.isArray(generationConfig.stopSequences) || !generationConfig.stopSequences.length) {
            delete generationConfig.stopSequences;
        }

        const enableImageModality = requestImages && imageGenerationModels.includes(model);
        const enableImageConfig = enableImageModality && (aspectRatio || imageSize);
        if (enableImageModality) {
            generationConfig.responseModalities = ['text', 'image'];
            if (enableImageConfig) {
                generationConfig.imageConfig = {};
                if (imageSize && isImageSizeModel(model)) {
                    generationConfig.imageConfig.imageSize = imageSize;
                }
                if (aspectRatio) {
                    generationConfig.imageConfig.aspectRatio = aspectRatio;
                }
            }
        }

        const useSystemPrompt = !enableImageModality && !isGemma3 && body.use_sysprompt;

        const tools = [];
        const prompt = convertGooglePrompt(body.messages, model, useSystemPrompt, getPromptNames({ body }));
        const safetySettings = [...GEMINI_SAFETY, ...(useVertexAi ? VERTEX_SAFETY : [])];

        if (Array.isArray(body.tools) && body.tools.length > 0 && !enableImageModality && !isGemma3) {
            const functionDeclarations = [];
            const customTools = [];
            for (const tool of body.tools) {
                if (tool.type === 'function') {
                    const functionDeclaration = buildGeminiFunctionDeclaration(tool.function);
                    if (functionDeclaration) {
                        functionDeclarations.push(functionDeclaration);
                    }
                } else if (tool[tool.type]) {
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
            if (functionDeclarations.length > 0) {
                tools.push({ functionDeclarations });
            }
            // Custom tools are only supported when no function calling is present
            if (functionDeclarations.length === 0 && customTools.length > 0) {
                tools.push(...customTools);
            }
        }

        if (enableWebSearch && !enableImageModality && !isGemma3 && !isLearnLM && !noSearchModels.includes(model)) {
            // Tool use with function calling is unsupported
            if (!tools.some(t => Array.isArray(t.functionDeclarations) && t.functionDeclarations.length > 0)) {
                tools.push({ googleSearch: {} });
            }
        }

        if (isThinkingConfigModel(model)) {
            const thinkingConfig = { includeThoughts: includeReasoning };

            const thinkingBudget = calculateGoogleBudgetTokens(generationConfig.maxOutputTokens, reasoningEffort, model);
            if (typeof thinkingBudget === 'number' && Number.isInteger(thinkingBudget)) {
                thinkingConfig.thinkingBudget = thinkingBudget;
            }

            if (typeof thinkingBudget === 'string' && thinkingBudget.length > 0) {
                thinkingConfig.thinkingLevel = thinkingBudget;
            }

            // Vertex doesn't allow mixing disabled thinking with includeThoughts
            if (useVertexAi && thinkingBudget === 0 && thinkingConfig.includeThoughts) {
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
                const baseUrl = region === 'global'
                    ? 'https://aiplatform.googleapis.com'
                    : `https://${region}-aiplatform.googleapis.com`;
                url = projectId
                    ? `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}?key=${keyParam}${stream ? '&alt=sse' : ''}`
                    : `${baseUrl}/v1/publishers/google/models/${model}:${responseType}?key=${keyParam}${stream ? '&alt=sse' : ''}`;
            } else if (authType === 'full') {
                // For Full mode (service account authentication), use project-specific URL
                // Get project ID from Service Account JSON
                const serviceAccountJson = ctx.secrets.read(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT);
                if (!serviceAccountJson) {
                    console.warn('Vertex AI Service Account JSON is missing.');
                    ctx.emit.error(new Error('Vertex AI Service Account JSON is missing'));
                    return;
                }

                let projectId;
                try {
                    const serviceAccount = JSON.parse(serviceAccountJson);
                    projectId = getProjectIdFromServiceAccount(serviceAccount);
                } catch (error) {
                    console.error('Failed to extract project ID from Service Account JSON:', error);
                    ctx.emit.error(new Error('Failed to extract project ID from Service Account JSON'));
                    return;
                }
                const region = body.vertexai_region || 'us-central1';
                // Handle global region differently - no region prefix in hostname
                if (region === 'global') {
                    url = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                } else {
                    url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                }
                headers['Authorization'] = authHeader;
            } else {
                // For proxy mode, use the original URL with Authorization header
                url = `${apiUrl.toString().replace(/\/$/, '')}/v1/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                headers['Authorization'] = authHeader;
            }
        } else {
            url = `${apiUrl.toString().replace(/\/$/, '')}/${apiVersion}/models/${model}:${responseType}?key=${apiKey}${stream ? '&alt=sse' : ''}`;
        }

        ctx.inspection.attach(url, apiKey || '', requestBody);
        const generateResponse = await ctx.fetch(url, {
            body: JSON.stringify(requestBody),
            method: 'POST',
            headers: headers,
            signal: ctx.signal,
        });

        // Architectural contract: every dispatch emits a single head frame
        // immediately after the upstream fetch resolves, regardless of
        // status. The WebSocket delivery layer (ws-delivery) uses head to
        // release the client-side `await headPromise`; without it the
        // client hangs on subscribe races with setImmediate dispatch.
        ctx.emit.head({ status: generateResponse.status, headers: generateResponse.headers });

        if (stream) {
            await pipeResponseBodyToEmit(generateResponse, ctx);
        } else {
            if (!generateResponse.ok) {
                let errorText = '';
                try { errorText = await generateResponse.text(); } catch { /* body already consumed */ }
                console.warn(`${apiName} API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const msg = `${apiName} upstream ${generateResponse.status}: ${errorText}`;
                ctx.inspection.fail(new Error(msg), generateResponse?.status ?? 502);
                // Legacy shape: always deliver a JSON envelope so client-side
                // `await response.json()` succeeds (parses upstream body when
                // possible, falls back to `{error:true}` sentinel for empty
                // or non-JSON bodies). Matches
                // `res.status(500).send(tryParse(errorText) ?? {error:true})`.
                const envelope = errorText ? (tryParse(errorText) ?? { error: true }) : { error: true };
                ctx.emit.chunk(new TextEncoder().encode(JSON.stringify(envelope)));
                ctx.emit.end();
                return;
            }

            /** @type {any} */
            const generateResponseJson = await generateResponse.json();

            const candidates = generateResponseJson?.candidates;
            if (!candidates || candidates.length === 0) {
                let message = `${apiName} API returned no candidate`;
                console.warn(message, generateResponseJson);
                if (generateResponseJson?.promptFeedback?.blockReason) {
                    message += `\nPrompt was blocked due to : ${generateResponseJson.promptFeedback.blockReason}`;
                }
                // Legacy shape: `res.send({error:{message}})` (Express default
                // HTTP 200 with the error envelope). The head frame at line
                // 392 above already carried the upstream 200 status, so we
                // only emit chunk+end here. Client:
                //   • response.ok stays true → skips the `!response.ok`
                //     raw-throw path at openai.js:4037.
                //   • `.json()` parses cleanly at :4450 → `data.error`
                //     branch at :4455 fires → toastr shows the block-reason
                //     message.
                // Using HTTP 500 here would bury the descriptive block
                // reason inside the generic "Got response status 500"
                // substring thrown at :4047.
                const errPayload = { error: { message } };
                const errBody = JSON.stringify(errPayload);
                ctx.emit.chunk(new TextEncoder().encode(errBody));
                ctx.emit.end();
                try { ctx.inspection.complete(errPayload, generateResponseJson); }
                catch { /* inspection best-effort */ }
                return;
            }

            const responseContent = candidates[0].content ?? candidates[0].output;
            const functionCall = (candidates?.[0]?.content?.parts ?? []).some(part => part.functionCall || part.function_call);
            const inlineData = (candidates?.[0]?.content?.parts ?? []).some(part => part.inlineData);
            console.debug(`${apiName} response:`, util.inspect(generateResponseJson, { depth: 5, colors: true }));

            const responseText = typeof responseContent === 'string' ? responseContent : responseContent?.parts?.filter(part => !part.thought)?.map(part => part.text)?.join('\n\n');
            if (!responseText && !functionCall && !inlineData) {
                let message = `${apiName} Candidate text empty`;
                console.warn(message, generateResponseJson);
                // Same shape as the no-candidate branch above: legacy HTTP 200
                // (already emitted via head at line 392) + `{error:{message}}`
                // chunk so the client's `data.error` handler surfaces the
                // message via toastr.
                const errPayload = { error: { message } };
                const errBody = JSON.stringify(errPayload);
                ctx.emit.chunk(new TextEncoder().encode(errBody));
                ctx.emit.end();
                try { ctx.inspection.complete(errPayload, generateResponseJson); }
                catch { /* inspection best-effort */ }
                return;
            }

            const reply = normalizeGeminiResponseToOAI(generateResponseJson);
            ctx.emit.chunk(new TextEncoder().encode(JSON.stringify(reply)));
            ctx.emit.end();
            // Route the raw Gemini body to the inspector alongside the
            // OAI-normalized reply. extractUsageFromGemini (source =
            // 'makersuite' | 'vertexai') reads usageMetadata.
            // cachedContentTokenCount + candidatesTokenCount from the raw
            // shape; extractPartsFromPayload walks raw.candidates[0].
            // content.parts for thoughtSignature / inlineData / functionCall.
            // Without passing rawApiResponse, the runner falls back to
            // completeInspection(reply, reply) which loses those fields.
            // See runner.js:290 for the status-guard that skips the
            // fallback once ctx.inspection.complete has already run.
            try { ctx.inspection.complete(reply, generateResponseJson); }
            catch { /* inspection best-effort */ }
        }
    } catch (error) {
        console.error(`Error communicating with ${apiName} API:`, error);
        try { ctx.inspection.fail(error?.message || `${apiName} request failed`, 500); } catch { /* inspection best-effort */ }
        ctx.emit.error(error);
    }
}
