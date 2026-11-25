// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared multimodal user-message encoding, lossless image loading, and
// lightweight attachment normalization for Workbench, SD Lens, and Studio AI chats.

/**
 * Normalizes a list of image attachments into lightweight persisted descriptors:
 * `{ path, name?, mime? }`, deduplicated by normalized path order.
 *
 * @param {unknown} raw
 * @returns {Array<{ path: string, name?: string, mime?: string }>}
 */
export function normalizeImageAttachments(raw) {
    if (!Array.isArray(raw) || raw.length === 0) {
        return [];
    }
    const out = [];
    const byPath = new Map();
    for (const item of raw) {
        let entry = null;
        if (typeof item === 'string') {
            const p = item.trim();
            if (p) entry = { path: p };
        } else if (item && typeof item === 'object' && !Array.isArray(item)) {
            const p = typeof item.path === 'string' ? item.path.trim() : '';
            if (p) {
                const name = typeof item.name === 'string' ? item.name.trim() : '';
                const mime = typeof item.mime === 'string' ? item.mime.trim() : '';
                entry = {
                    path: p,
                    ...(name ? { name } : {}),
                    ...(mime ? { mime } : {}),
                };
            }
        }
        if (!entry) continue;
        const existing = byPath.get(entry.path);
        if (existing) {
            if (!existing.name && entry.name) existing.name = entry.name;
            if (!existing.mime && entry.mime) existing.mime = entry.mime;
            continue;
        }
        byPath.set(entry.path, entry);
        out.push(entry);
    }
    return out;
}

/**
 * Extracts plain text from either a string content or an OpenAI multimodal
 * content-part array without losing text or turning arrays into `[object Object]`.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function extractTextContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (content == null) {
        return '';
    }
    if (Array.isArray(content)) {
        const parts = [];
        for (const part of content) {
            if (typeof part === 'string') {
                if (part) parts.push(part);
            } else if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
                if (part.text) parts.push(part.text);
            }
        }
        return parts.join('\n');
    }
    return String(content);
}

/**
 * Builds a concise session/turn summary label when a message may contain only images.
 *
 * @param {string} text
 * @param {Array<{ path: string, name?: string }>} [attachments=[]]
 * @param {string} [fallbackLabel='[Image]']
 * @returns {string}
 */
export function buildAttachmentSummaryLabel(text, attachments = [], fallbackLabel = '[Image]') {
    const clean = String(text ?? '').trim();
    if (clean) return clean;
    const list = normalizeImageAttachments(attachments);
    if (!list.length) return '';
    return list.length > 1 ? `${fallbackLabel} (${list.length})` : fallbackLabel;
}

/**
 * Collects deduplicated attachment paths from an array of turn/message records.
 *
 * @param {Array<object>} records
 * @param {{ filter?: (path: string) => boolean }} [options]
 * @returns {string[]}
 */
export function collectAttachmentPathsFromRecords(records, { filter = null } = {}) {
    if (!Array.isArray(records) || records.length === 0) {
        return [];
    }
    const out = [];
    const seen = new Set();
    for (const rec of records) {
        const list = normalizeImageAttachments(rec?.attachments);
        for (const att of list) {
            if (seen.has(att.path)) continue;
            if (typeof filter === 'function' && !filter(att.path)) continue;
            seen.add(att.path);
            out.push(att.path);
        }
    }
    return out;
}

/**
 * Losslessly converts a Blob into a `data:<mime>;base64,...` URL without
 * canvas re-encoding or resolution scaling.
 *
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function blobToDataUrl(blob) {
    if (typeof FileReader === 'function') {
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('Failed to read image blob.'));
            reader.readAsDataURL(blob);
        });
    }
    const arrayBuf = await blob.arrayBuffer();
    const mime = blob.type || 'application/octet-stream';
    if (typeof globalThis.Buffer === 'function') {
        return `data:${mime};base64,${globalThis.Buffer.from(arrayBuf).toString('base64')}`;
    }
    const bytes = new Uint8Array(arrayBuf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * Fetches a managed local image path and returns its lossless original data URL.
 * Supports request-scoped caching via `cache` so multi-round tool loops do not
 * re-read the same attachment from disk on every round.
 *
 * @param {string} imagePath
 * @param {{
 *   context?: object | null,
 *   headers?: Record<string, string> | null,
 *   signal?: AbortSignal | null,
 *   cache?: Map<string, Promise<string>> | null,
 *   fetchFn?: typeof fetch,
 * }} [options]
 * @returns {Promise<string>}
 */
export async function loadManagedImageDataUrl(imagePath, {
    context = null,
    headers = null,
    signal = null,
    cache = null,
    fetchFn = globalThis.fetch,
} = {}) {
    const cleanPath = String(imagePath || '').trim();
    if (!cleanPath) {
        throw new Error('Image path must be a non-empty string.');
    }
    if (cache instanceof Map && cache.has(cleanPath)) {
        return await cache.get(cleanPath);
    }

    const run = (async () => {
        const reqHeaders = {
            ...(typeof context?.getRequestHeaders === 'function' ? context.getRequestHeaders() : {}),
            ...(headers && typeof headers === 'object' ? headers : {}),
        };
        const res = await fetchFn(cleanPath, {
            method: 'GET',
            headers: reqHeaders,
            ...(signal ? { signal } : {}),
        });
        if (!res.ok) {
            throw new Error(`Failed to load attached image ${cleanPath} (HTTP ${res.status}).`);
        }
        const blob = await res.blob();
        const dataUrl = await blobToDataUrl(blob);
        if (!dataUrl.startsWith('data:')) {
            throw new Error(`Attached image ${cleanPath} did not produce a valid data URL.`);
        }
        return dataUrl;
    })();

    if (cache instanceof Map) {
        cache.set(cleanPath, run);
        run.catch(() => {
            if (cache.get(cleanPath) === run) {
                cache.delete(cleanPath);
            }
        });
    }
    return await run;
}

/**
 * Expands lightweight `{ role, content, attachments }` messages into standard
 * OpenAI multimodal messages (`content: [{ type: 'text', ... }, { type: 'image_url', ... }]`)
 * right before sending to the LLM. Does not mutate input messages.
 *
 * @param {Array<object>} messages
 * @param {{
 *   context?: object | null,
 *   headers?: Record<string, string> | null,
 *   loadDataUrl?: ((path: string, opts: { signal: AbortSignal | null, cache: Map<string, Promise<string>> }) => Promise<string>) | null,
 *   includePathAnnotations?: boolean,
 *   signal?: AbortSignal | null,
 *   cache?: Map<string, Promise<string>> | null,
 *   fetchFn?: typeof fetch,
 * }} [options]
 * @returns {Promise<Array<object>>}
 */
export async function hydrateMessagesForLlm(messages, {
    context = null,
    headers = null,
    loadDataUrl = null,
    includePathAnnotations = false,
    signal = null,
    cache = null,
    fetchFn = globalThis.fetch,
} = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return [];
    }
    const activeCache = cache instanceof Map ? cache : new Map();
    const out = [];

    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') {
            out.push(msg);
            continue;
        }
        const attachments = normalizeImageAttachments(msg.attachments);
        if (attachments.length === 0) {
            if ('attachments' in msg) {
                const { attachments: _unused, ...rest } = msg;
                out.push(rest);
            } else {
                out.push(msg);
            }
            continue;
        }

        const dataUrls = await Promise.all(attachments.map(async (att) => {
            const url = typeof loadDataUrl === 'function'
                ? await loadDataUrl(att.path, { signal, cache: activeCache })
                : await loadManagedImageDataUrl(att.path, {
                    context,
                    headers,
                    signal,
                    cache: activeCache,
                    fetchFn,
                });
            if (typeof url !== 'string' || !url.startsWith('data:')) {
                throw new Error(`Attached image ${att.path} did not resolve to a data URL.`);
            }
            return url;
        }));

        const { attachments: _stripped, content: rawContent, ...rest } = msg;
        const parts = [];

        const existingParts = Array.isArray(rawContent) ? rawContent : null;
        const baseText = existingParts
            ? extractTextContent(existingParts)
            : (typeof rawContent === 'string' ? rawContent : '');
        const annotationText = includePathAnnotations
            ? attachments.map((att, idx) => `[Attached image #${idx + 1}: ${att.path}]`).join('\n')
            : '';
        const combinedText = [baseText.trim(), annotationText].filter(Boolean).join('\n\n');

        if (combinedText) {
            parts.push({ type: 'text', text: combinedText });
        }
        if (existingParts) {
            for (const part of existingParts) {
                if (part && typeof part === 'object' && part.type !== 'text') {
                    parts.push(part);
                }
            }
        }
        for (const dataUrl of dataUrls) {
            parts.push({
                type: 'image_url',
                image_url: { url: dataUrl },
            });
        }

        out.push({
            ...rest,
            content: parts,
        });
    }

    return out;
}
