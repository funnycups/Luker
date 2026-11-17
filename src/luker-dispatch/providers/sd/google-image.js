// SPDX-License-Identifier: AGPL-3.0-or-later

import mime from 'mime-types';

import { SECRET_KEYS } from '../../../endpoints/secrets.js';
import { getGoogleApiConfig } from '../../../endpoints/google.js';
import { loadReferenceInputs } from '../../../media-input-loader.js';
import { extractImageMeta } from '../../../request-inspector.js';
import { getConfigValue, trimTrailingSlash } from '../../../util.js';
import { formatReferenceCaption, resolveSdSecret } from './sd-auth.js';

const API_MAKERSUITE = 'https://generativelanguage.googleapis.com';

export function isGeminiNativeImageModel(model) {
    const m = String(model || '').trim().toLowerCase();
    return /^gemini-.*-image/.test(m) || m === 'gemini-2.0-flash-exp';
}

async function buildGoogleDispatchTarget(ctx, model, endpoint) {
    const body = ctx.body || {};
    const useVertexAi = body.api === 'vertexai';
    const customApiUrl = trimTrailingSlash(String(body.api_url || body.reverse_proxy || body.base_url || '').trim());

    if (!useVertexAi) {
        const key = resolveSdSecret(ctx, [SECRET_KEYS.MAKERSUITE]);
        const baseHost = customApiUrl || API_MAKERSUITE;
        const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
        const hasVersion = /\/v1(?:beta\d*)?$/i.test(baseHost);
        const baseUrl = hasVersion ? baseHost : `${baseHost}/${apiVersion}`;
        return {
            url: `${baseUrl}/models/${model}:${endpoint}`,
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': key,
            },
            key,
            isVertex: false,
        };
    }

    if (String(body.secret_id || '').trim() || customApiUrl) {
        const key = resolveSdSecret(ctx, [SECRET_KEYS.VERTEXAI, SECRET_KEYS.MAKERSUITE]);
        const region = String(body.vertexai_region || 'us-central1').trim();
        const projectId = String(body.vertexai_express_project_id || '').trim();
        const defaultHost = region === 'global'
            ? 'https://aiplatform.googleapis.com/v1'
            : `https://${region}-aiplatform.googleapis.com/v1`;
        const baseUrl = customApiUrl
            ? (/\/v\d+$/i.test(customApiUrl) ? customApiUrl : `${customApiUrl}/v1`)
            : defaultHost;
        const url = projectId
            ? `${baseUrl}/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${endpoint}`
            : `${baseUrl}/publishers/google/models/${model}:${endpoint}`;
        return {
            url,
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': key,
            },
            key,
            isVertex: true,
        };
    }

    const fakeReq = { body, user: { directories: ctx.user?.directories } };
    const cfg = await getGoogleApiConfig(fakeReq, model, endpoint);
    return {
        url: cfg.url,
        headers: cfg.headers,
        key: cfg.headers['x-goog-api-key'] || cfg.headers.Authorization || '',
        isVertex: true,
    };
}

export async function dispatchSdGoogleImage(ctx) {
    const body = ctx.body || {};
    const model = String(body.model || 'imagen-3.0-generate-002').trim();
    ctx.inspection.startImage(extractImageMeta('google', body));

    try {
        const loadedRefs = await loadReferenceInputs(ctx.user?.directories, body.references);
        const isGeminiNative = isGeminiNativeImageModel(model);

        if (!isGeminiNative && loadedRefs.length > 0) {
            throw new Error(`Google model "${model}" (:predict) does not support reference images. Switch to a Gemini native image model such as gemini-2.5-flash-image or gemini-3-pro-image.`);
        }

        if (isGeminiNative) {
            const { url, headers, key } = await buildGoogleDispatchTarget(ctx, model, 'generateContent');
            const parts = [];
            for (const ref of loadedRefs) {
                parts.push({ text: formatReferenceCaption(ref) });
                parts.push({
                    inlineData: {
                        mimeType: ref.mimeType,
                        data: ref.base64,
                    },
                });
            }
            const promptText = body.negative_prompt
                ? `${String(body.prompt || '').trim()}\nAvoid: ${String(body.negative_prompt).trim()}`
                : String(body.prompt || '');
            parts.push({ text: promptText });

            const aspectRatio = String(body.aspect_ratio || '').trim();
            const requestBody = {
                contents: [{ role: 'user', parts }],
                generationConfig: {
                    responseModalities: ['TEXT', 'IMAGE'],
                    ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
                    ...(Number.isInteger(Number(body.seed)) && Number(body.seed) >= 0 ? { seed: Number(body.seed) } : {}),
                },
            };

            ctx.inspection.attach(url, key);
            const result = await ctx.fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
                signal: ctx.signal,
            });
            ctx.emit.head({ status: result.status, headers: result.headers });

            if (!result.ok) {
                const errText = await result.text().catch(() => '');
                const err = new Error(`Google Gemini image generation failed (${result.status})`);
                ctx.inspection.failImage(err, result.status || 500);
                if (errText) ctx.emit.chunk(new TextEncoder().encode(errText));
                ctx.emit.end();
                return;
            }

            const data = await result.json();
            const candidateParts = data?.candidates?.[0]?.content?.parts || [];
            const inlinePart = candidateParts.find(p => p?.inlineData?.data || p?.inline_data?.data);
            const rawInline = inlinePart?.inlineData || inlinePart?.inline_data;
            if (!rawInline?.data) {
                throw new Error('No image inlineData returned by Gemini generateContent.');
            }
            const ext = mime.extension(rawInline.mimeType || rawInline.mime_type || 'image/png') || 'png';
            const format = ext === 'jpeg' ? 'jpg' : ext;
            ctx.inspection.completeImage({ format, data: rawInline.data });
            ctx.emit.chunk(new TextEncoder().encode(JSON.stringify({ image: rawInline.data, format })));
            ctx.emit.end();
            return;
        }

        const { url, headers, key, isVertex } = await buildGoogleDispatchTarget(ctx, model, 'predict');
        const isDeprecated = model.startsWith('imagegeneration');
        const personGeneration = getConfigValue('gemini.image.personGeneration', 'allow_adult');
        const requestBody = {
            instances: [{ prompt: String(body.prompt || '') }],
            parameters: {
                sampleCount: 1,
                seed: isVertex ? Number(body.seed ?? Math.floor(Math.random() * 1000000)) : undefined,
                enhancePrompt: isVertex ? Boolean(body.enhance ?? false) : undefined,
                negativePrompt: isVertex ? (body.negative_prompt || undefined) : undefined,
                aspectRatio: String(body.aspect_ratio || '1:1'),
                personGeneration: !isDeprecated && personGeneration ? personGeneration : undefined,
                language: isVertex ? 'auto' : undefined,
                safetySetting: !isDeprecated ? (isVertex ? 'block_only_high' : 'block_low_and_above') : undefined,
                addWatermark: isVertex ? false : undefined,
                outputOptions: {
                    mimeType: 'image/jpeg',
                    compressionQuality: 100,
                },
            },
        };

        ctx.inspection.attach(url, key);
        const result = await ctx.fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: ctx.signal,
        });
        ctx.emit.head({ status: result.status, headers: result.headers });

        if (!result.ok) {
            const errText = await result.text().catch(() => '');
            const err = new Error(`Google Imagen generation failed (${result.status})`);
            ctx.inspection.failImage(err, result.status || 500);
            if (errText) ctx.emit.chunk(new TextEncoder().encode(errText));
            ctx.emit.end();
            return;
        }

        const data = await result.json();
        const imagePart = data?.predictions?.[0]?.bytesBase64Encoded;
        if (!imagePart) {
            throw new Error('No image data found in Google Imagen response.');
        }
        ctx.inspection.completeImage({ format: 'jpg', data: imagePart });
        ctx.emit.chunk(new TextEncoder().encode(JSON.stringify({ image: imagePart, format: 'jpg' })));
        ctx.emit.end();
    } catch (error) {
        ctx.inspection.failImage(error, 400);
        ctx.emit.error(error);
    }
}
