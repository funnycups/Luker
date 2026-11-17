// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer } from 'node:buffer';
import FormData from 'form-data';
import mime from 'mime-types';

import { readSecret, SECRET_KEYS } from '../../../endpoints/secrets.js';

const CHAT_CANDIDATE_SECRET_KEYS = Object.freeze([
    SECRET_KEYS.CUSTOM,
    SECRET_KEYS.OPENAI,
    SECRET_KEYS.OPENROUTER,
    SECRET_KEYS.MAKERSUITE,
    SECRET_KEYS.VERTEXAI,
    SECRET_KEYS.XAI,
    SECRET_KEYS.ZAI,
    SECRET_KEYS.NANOGPT,
    SECRET_KEYS.CHUTES,
    SECRET_KEYS.ELECTRONHUB,
    SECRET_KEYS.AIMLAPI,
    SECRET_KEYS.POLLINATIONS,
    SECRET_KEYS.COMETAPI,
    SECRET_KEYS.SILICONFLOW,
    SECRET_KEYS.FIREWORKS,
    SECRET_KEYS.GROQ,
    SECRET_KEYS.MISTRALAI,
    SECRET_KEYS.DEEPSEEK,
    SECRET_KEYS.MOONSHOT,
    SECRET_KEYS.PERPLEXITY,
]);

/**
 * Resolves an API key for an SD provider without ever silently falling back to a global key
 * when an explicit `secret_id` was requested by a bound Connection Profile.
 */
export function resolveSdSecret(ctx, primaryKeys, { allowEmpty = false, includeAllChatKeys = false } = {}) {
    const keys = Array.isArray(primaryKeys) ? primaryKeys : [primaryKeys];
    const directories = ctx?.user?.directories;
    const explicitSecretId = String(ctx?.body?.secret_id || '').trim();

    if (explicitSecretId) {
        const searchList = [...new Set([
            ...keys,
            SECRET_KEYS.CUSTOM,
            ...(includeAllChatKeys ? CHAT_CANDIDATE_SECRET_KEYS : []),
        ].filter(Boolean))];

        for (const key of searchList) {
            const viaCtx = ctx?.secrets?.read?.(key, { secretId: explicitSecretId });
            if (viaCtx) return String(viaCtx);
            if (directories?.root) {
                const viaDisk = readSecret(directories, key, explicitSecretId);
                if (viaDisk) return String(viaDisk);
            }
        }
        throw new Error(`API key for connection profile secret_id "${explicitSecretId}" was not found.`);
    }

    for (const key of keys.filter(Boolean)) {
        const viaCtx = ctx?.secrets?.read?.(key);
        if (viaCtx) return String(viaCtx);
        if (directories?.root) {
            const viaDisk = readSecret(directories, key);
            if (viaDisk) return String(viaDisk);
        }
    }

    if (allowEmpty) {
        return '';
    }
    throw new Error(`API key not found (${keys.join(', ')}).`);
}

export function formatReferenceCaption(ref) {
    const label = String(ref?.label || '').trim();
    if (ref?.role === 'style') {
        return label ? `[Style reference: ${label}]` : '[Style reference]';
    }
    if (ref?.role === 'source') {
        return label ? `[Source image to edit: ${label}]` : '[Source image to edit]';
    }
    return label ? `[Character reference: ${label}]` : '[Character reference]';
}

export function normalizeChatCompletionsUrl(rawBaseUrl) {
    const trimmed = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
        throw new Error('Chat image endpoint URL is empty.');
    }
    if (trimmed.endsWith('/chat/completions')) {
        return trimmed;
    }
    if (/\/v\d+(?:beta\d*)?$/i.test(trimmed)) {
        return `${trimmed}/chat/completions`;
    }
    return `${trimmed}/v1/chat/completions`;
}

export function normalizeModelsUrl(rawBaseUrl) {
    const completionsUrl = normalizeChatCompletionsUrl(rawBaseUrl);
    return completionsUrl.replace(/\/chat\/completions$/, '/models');
}

export function normalizeImagesBaseUrl(rawBaseUrl, defaultBaseUrl) {
    const trimmed = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
        return String(defaultBaseUrl || '').replace(/\/+$/, '');
    }
    const stripped = trimmed
        .replace(/\/images\/(?:generations|edits)$/i, '')
        .replace(/\/chat\/completions$/i, '');
    if (/\/v\d+(?:beta\d*)?$/i.test(stripped)) {
        return stripped;
    }
    return `${stripped}/v1`;
}

export function rejectUnsupportedReferences(providerLabel, references) {
    if (Array.isArray(references) && references.length > 0) {
        throw new Error(`${providerLabel} image generation does not support reference images.`);
    }
}

export function stripInternalSdDispatchFields(body) {
    if (!body || typeof body !== 'object') {
        return {};
    }
    const clone = { ...body };
    delete clone.secret_id;
    delete clone.api_url;
    delete clone.network_proxy;
    delete clone.references;
    delete clone.luker_generation;
    return clone;
}

export function buildMultipartImageEditsPayload({ fields = {}, loadedRefs = [], singleField = false }) {
    const form = new FormData();
    const mappingLines = loadedRefs.map((ref, index) => {
        const detail = String(ref.label || ref.role || 'reference').trim();
        return `Reference image ${index + 1} (${ref.role}): ${detail}`;
    });
    const basePrompt = String(fields.prompt || '').trim();
    const mergedPrompt = mappingLines.length > 0
        ? `${mappingLines.join('\n')}\n\n${basePrompt}`
        : basePrompt;

    const fieldEntries = {
        ...fields,
        prompt: mergedPrompt,
    };

    for (const [key, value] of Object.entries(fieldEntries)) {
        if (value === undefined || value === null || value === '') {
            continue;
        }
        form.append(key, String(value));
    }

    const imageFieldName = singleField ? 'image' : 'image[]';
    for (let i = 0; i < loadedRefs.length; i++) {
        const ref = loadedRefs[i];
        const ext = mime.extension(ref.mimeType) || 'png';
        form.append(imageFieldName, ref.buffer, {
            filename: `ref_${i + 1}.${ext === 'jpeg' ? 'jpg' : ext}`,
            contentType: ref.mimeType,
        });
    }

    return {
        body: form.getBuffer(),
        headers: form.getHeaders(),
    };
}

function parseDataUrl(value) {
    const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,([\s\S]+)$/.exec(String(value || '').trim());
    if (!match) {
        return null;
    }
    const format = mime.extension(match[1]) || 'png';
    return {
        image: match[2].replace(/\s+/g, ''),
        format: format === 'jpeg' ? 'jpg' : format,
    };
}

function collectCandidateImageStrings(message) {
    const candidates = [];
    if (!message || typeof message !== 'object') {
        return candidates;
    }

    const pushItem = (item) => {
        if (!item) return;
        if (typeof item === 'string') {
            candidates.push(item);
            return;
        }
        if (typeof item?.image_url?.url === 'string') {
            candidates.push(item.image_url.url);
        } else if (typeof item?.url === 'string') {
            candidates.push(item.url);
        } else if (typeof item?.b64_json === 'string') {
            candidates.push(`data:image/png;base64,${item.b64_json}`);
        } else if (typeof item?.data === 'string') {
            const mt = item.mime_type || item.mimeType || 'image/png';
            candidates.push(item.data.startsWith('data:') ? item.data : `data:${mt};base64,${item.data}`);
        }
    };

    if (Array.isArray(message.images)) {
        message.images.forEach(pushItem);
    }
    if (Array.isArray(message.content)) {
        for (const part of message.content) {
            if (part?.type === 'image_url' || part?.image_url || part?.b64_json || part?.data) {
                pushItem(part);
            } else if (part?.type === 'text' && typeof part.text === 'string') {
                extractEmbeddedUrlsFromText(part.text, candidates);
            }
        }
    } else if (typeof message.content === 'string') {
        extractEmbeddedUrlsFromText(message.content, candidates);
    }

    const rd = message.reasoning_details;
    if (Array.isArray(rd)) {
        for (const item of rd) {
            if (Array.isArray(item?.images)) item.images.forEach(pushItem);
            pushItem(item);
        }
    } else if (rd && Array.isArray(rd.images)) {
        rd.images.forEach(pushItem);
    }

    return candidates;
}

function extractEmbeddedUrlsFromText(text, out) {
    const dataMatches = text.match(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\s]+/g);
    if (dataMatches) {
        out.push(...dataMatches);
    }
    const mdMatches = [...text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g)];
    for (const m of mdMatches) {
        out.push(m[1]);
    }
}

export async function extractImageFromChatCompletionResponse(data, fetchFn, signal) {
    const message = data?.choices?.[0]?.message;
    const candidates = collectCandidateImageStrings(message);
    for (const candidate of candidates) {
        const parsed = parseDataUrl(candidate);
        if (parsed) {
            return parsed;
        }
        if (/^https?:\/\//i.test(candidate) && typeof fetchFn === 'function') {
            const resp = await fetchFn(candidate, { method: 'GET', signal });
            if (!resp.ok) {
                throw new Error(`Failed to fetch generated image URL (${resp.status}).`);
            }
            const contentType = resp.headers.get('content-type') || 'image/png';
            const ext = mime.extension(contentType) || 'png';
            const buf = Buffer.from(await resp.arrayBuffer());
            return {
                image: buf.toString('base64'),
                format: ext === 'jpeg' ? 'jpg' : ext,
            };
        }
    }
    throw new Error('Upstream chat completion response did not contain any generated image.');
}
