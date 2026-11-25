// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Persistent AI chat attachment storage helpers backed by /user/images/_ai_attachments/.
// Supports lossless upload with atomic rollback on batch failure, copy-on-fork
// ownership isolation, and idempotent batch deletion.

import { normalizeImageAttachments } from './multimodal-messages.js';

export const AI_ATTACHMENTS_FOLDER = '_ai_attachments';

const ALLOWED_IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'jfif']);

const MIME_TO_FORMAT = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/x-ms-bmp': 'bmp',
});

/**
 * Single-decode path normalizer matching server path confinement.
 *
 * @param {string} imagePath
 * @returns {string}
 */
export function normalizeAttachmentPath(imagePath) {
    const raw = String(imagePath || '').trim();
    if (!raw) return '';
    if (raw.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return '';
    let decoded;
    try {
        decoded = decodeURIComponent(raw.split(/[?#]/, 1)[0]);
    } catch {
        return '';
    }
    if (decoded.includes('\\') || decoded.includes('\0')) return '';
    const segments = [];
    for (const seg of decoded.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
            if (!segments.length) return '';
            segments.pop();
        } else {
            segments.push(seg);
        }
    }
    return `/${segments.join('/')}`;
}

/**
 * Returns true iff `imagePath` resolves under `/user/images/_ai_attachments/`.
 *
 * @param {string} imagePath
 * @returns {boolean}
 */
export function isAiAttachmentPath(imagePath) {
    const normalized = normalizeAttachmentPath(imagePath);
    return normalized.toLowerCase().startsWith(`/user/images/${AI_ATTACHMENTS_FOLDER}/`);
}

/**
 * Losslessly encodes a File/Blob to a base64 string.
 *
 * @param {Blob} file
 * @returns {Promise<string>}
 */
export async function fileToBase64(file) {
    if (typeof file?.arrayBuffer === 'function') {
        const buf = await file.arrayBuffer();
        if (typeof globalThis.Buffer === 'function') {
            return globalThis.Buffer.from(buf).toString('base64');
        }
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }
    if (typeof FileReader === 'function') {
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('Failed to read image file.'));
            reader.readAsDataURL(file);
        });
        const match = /^data:[^;,]+;base64,(.*)$/s.exec(dataUrl);
        if (!match) {
            throw new Error('Failed to encode image file.');
        }
        return match[1];
    }
    throw new Error('Select an image file.');
}

/**
 * Infers an uploadable image extension from the File's MIME type or filename.
 *
 * @param {{ type?: string, name?: string }} file
 * @returns {string}
 */
export function inferImageFormat(file) {
    const mime = String(file?.type || '').trim().toLowerCase().split(';')[0];
    if (mime && MIME_TO_FORMAT[mime]) {
        return MIME_TO_FORMAT[mime];
    }
    const name = String(file?.name || '').trim();
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    if (ext && ALLOWED_IMAGE_FORMATS.has(ext)) {
        return ext;
    }
    return 'png';
}

function getHeaders(context) {
    const base = typeof context?.getRequestHeaders === 'function'
        ? context.getRequestHeaders()
        : {};
    return {
        'Content-Type': 'application/json',
        ...base,
    };
}

/**
 * Uploads one original image File into `/user/images/_ai_attachments/`.
 *
 * @param {object | null} context
 * @param {File | Blob} file
 * @param {{ signal?: AbortSignal | null, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<{ path: string, name?: string, mime?: string }>}
 */
export async function uploadChatAttachment(context, file, {
    signal = null,
    fetchFn = globalThis.fetch,
} = {}) {
    if (!file || (typeof file.arrayBuffer !== 'function' && typeof FileReader !== 'function')) {
        throw new Error('Select an image file.');
    }
    const mime = String(file.type || '').trim();
    if (mime && !mime.toLowerCase().startsWith('image/')) {
        throw new Error(`Unsupported attachment type "${mime}". Select an image file.`);
    }
    const base64 = await fileToBase64(file);
    const format = inferImageFormat(file);
    const res = await fetchFn('/api/images/upload', {
        method: 'POST',
        headers: getHeaders(context),
        body: JSON.stringify({
            image: base64,
            format,
            ch_name: AI_ATTACHMENTS_FOLDER,
        }),
        ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Failed to upload attached image (HTTP ${res.status}): ${detail || res.statusText}`);
    }
    const data = await res.json();
    const savedPath = String(data?.path || '').trim();
    if (!savedPath) {
        throw new Error('Image upload succeeded without returning a managed path.');
    }
    const name = typeof file.name === 'string' ? file.name.trim() : '';
    return {
        path: savedPath,
        ...(name ? { name } : {}),
        ...(mime ? { mime } : {}),
    };
}

/**
 * Uploads a batch of image Files. If any upload fails partway, rolls back all
 * files already uploaded in this batch before rethrowing.
 *
 * @param {object | null} context
 * @param {Array<File | Blob>} files
 * @param {{ signal?: AbortSignal | null, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<Array<{ path: string, name?: string, mime?: string }>>}
 */
export async function uploadChatAttachments(context, files, {
    signal = null,
    fetchFn = globalThis.fetch,
} = {}) {
    const list = Array.isArray(files) ? files.filter(Boolean) : [];
    if (!list.length) return [];

    const uploaded = [];
    try {
        for (const file of list) {
            const item = await uploadChatAttachment(context, file, { signal, fetchFn });
            uploaded.push(item);
        }
        return uploaded;
    } catch (err) {
        if (uploaded.length > 0) {
            await deleteChatAttachments(context, uploaded.map(item => item.path), { fetchFn }).catch(() => {});
        }
        throw err;
    }
}

/**
 * Copies existing `_ai_attachments` paths on the server so a forked session
 * exclusively owns its own attachment files.
 *
 * @param {object | null} context
 * @param {string[]} paths
 * @param {{ fetchFn?: typeof fetch }} [options]
 * @returns {Promise<Map<string, string>>} Map from original path to newly copied path.
 */
export async function copyChatAttachments(context, paths, {
    fetchFn = globalThis.fetch,
} = {}) {
    const eligible = [...new Set((Array.isArray(paths) ? paths : []).map(p => String(p || '').trim()).filter(isAiAttachmentPath))];
    if (!eligible.length) {
        return new Map();
    }
    const res = await fetchFn('/api/images/copy', {
        method: 'POST',
        headers: getHeaders(context),
        body: JSON.stringify({ paths: eligible }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Failed to copy attached images (HTTP ${res.status}): ${detail || res.statusText}`);
    }
    const data = await res.json();
    const map = new Map();
    if (data?.copies && typeof data.copies === 'object') {
        for (const [src, dst] of Object.entries(data.copies)) {
            if (typeof dst === 'string' && dst.trim()) {
                map.set(src, dst.trim());
            }
        }
    }
    return map;
}

/**
 * Deletes a batch of `_ai_attachments` files on the server. Non-attachment
 * paths are ignored client-side (and also rejected server-side).
 *
 * @param {object | null} context
 * @param {string[]} paths
 * @param {{ fetchFn?: typeof fetch }} [options]
 * @returns {Promise<{ deleted: string[], missing: string[], failed: Array<{ path: string, error: string }> }>}
 */
export async function deleteChatAttachments(context, paths, {
    fetchFn = globalThis.fetch,
} = {}) {
    const eligible = [...new Set((Array.isArray(paths) ? paths : []).map(p => String(p || '').trim()).filter(isAiAttachmentPath))];
    if (!eligible.length) {
        return { deleted: [], missing: [], failed: [] };
    }
    const res = await fetchFn('/api/images/delete-batch', {
        method: 'POST',
        headers: getHeaders(context),
        body: JSON.stringify({ paths: eligible }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Failed to delete attached images (HTTP ${res.status}): ${detail || res.statusText}`);
    }
    return await res.json();
}

/**
 * Rewrites an attachment descriptor array using a copy map from `copyChatAttachments`.
 *
 * @param {Array<{ path: string, name?: string, mime?: string }>} attachments
 * @param {Map<string, string>} copyMap
 * @returns {Array<{ path: string, name?: string, mime?: string }>}
 */
export function rewriteAttachmentsWithCopyMap(attachments, copyMap) {
    const list = normalizeImageAttachments(attachments);
    if (!list.length || !(copyMap instanceof Map) || copyMap.size === 0) {
        return list;
    }
    return list.map(att => {
        const nextPath = copyMap.get(att.path);
        return nextPath ? { ...att, path: nextPath } : { ...att };
    });
}
