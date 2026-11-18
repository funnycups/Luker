// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import fetch from 'node-fetch';
import urlJoin from 'url-join';
import { getBasicAuthHeader } from './util.js';
import { createProxyBoundFetch, createRequestProxyAgent } from './request-proxy.js';

// Cache full ComfyUI /object_info payloads briefly per endpoint so sequential
// search + inspect tool calls within one AI iteration turn avoid re-downloading
// multi-megabyte node schemas over the wire.
const OBJECT_INFO_CACHE_TTL_MS = 30 * 1000;

// Category directory mode summarizes multi-thousand-node ComfyUI installations
// so the caller can drill down via { category } or { query } without pulling
// every class_type upfront; 5 sample class_types per category orient the lookup.
const SAMPLE_TYPES_PER_CATEGORY = 5;

/** @type {Map<string, { fetchedAt: number, data: Record<string, any> }>} */
const objectInfoCache = new Map();

const collator = new Intl.Collator();

function createHttpError(statusCode, message) {
    const err = new Error(message);
    /** @type {any} */ (err).statusCode = statusCode;
    return err;
}

export function clearComfyObjectInfoCache() {
    objectInfoCache.clear();
}

/**
 * Fetch and cache ComfyUI `/object_info` for a given server URL.
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} [options.auth]
 * @param {string} [options.networkProxy]
 * @param {boolean} [options.refresh]
 * @param {typeof fetch} [options.fetchFn]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchComfyObjectInfo({
    baseUrl,
    auth = '',
    networkProxy = '',
    refresh = false,
    fetchFn = fetch,
    signal,
} = {}) {
    const cleanBase = String(baseUrl || '').trim();
    if (!cleanBase) {
        throw createHttpError(400, 'ComfyUI server URL is required.');
    }

    let targetUrl;
    try {
        targetUrl = new URL(urlJoin(cleanBase, '/object_info'));
    } catch {
        throw createHttpError(400, `Invalid ComfyUI server URL: ${cleanBase}`);
    }
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        throw createHttpError(400, `Unsupported ComfyUI URL protocol: ${targetUrl.protocol}`);
    }

    const normalizedBase = cleanBase.replace(/\/+$/, '');
    const authStr = String(auth || '');
    const proxyStr = String(networkProxy || '').trim();
    const cacheKey = `${normalizedBase}\0${authStr}\0${proxyStr}`;

    const now = Date.now();
    if (!refresh) {
        const cached = objectInfoCache.get(cacheKey);
        if (cached && now - cached.fetchedAt < OBJECT_INFO_CACHE_TTL_MS) {
            return cached.data;
        }
    }

    let proxyAgent;
    try {
        proxyAgent = createRequestProxyAgent(proxyStr);
    } catch (err) {
        throw createHttpError(400, String(err?.message || err));
    }

    const boundFetch = createProxyBoundFetch(fetchFn, proxyAgent);
    /** @type {Record<string, string>} */
    const headers = {};
    if (authStr) {
        headers['Authorization'] = getBasicAuthHeader(authStr);
    }

    let resp;
    try {
        resp = await boundFetch(targetUrl, {
            method: 'GET',
            headers,
            signal,
        });
    } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') {
            throw err;
        }
        throw createHttpError(502, `Failed to connect to ComfyUI at ${normalizedBase}: ${err?.message || err}`);
    }

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const detail = errText.trim() || resp.statusText || 'Unknown error';
        throw createHttpError(502, `ComfyUI /object_info returned HTTP ${resp.status}: ${detail}`);
    }

    let data;
    try {
        data = await resp.json();
    } catch (err) {
        throw createHttpError(502, `ComfyUI /object_info returned invalid JSON: ${err?.message || err}`);
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw createHttpError(502, 'ComfyUI /object_info did not return a node dictionary object.');
    }

    for (const [k, v] of objectInfoCache.entries()) {
        if (now - v.fetchedAt >= OBJECT_INFO_CACHE_TTL_MS) {
            objectInfoCache.delete(k);
        }
    }
    objectInfoCache.set(cacheKey, { fetchedAt: now, data });
    return data;
}

/**
 * Search ComfyUI `/object_info` by keyword tokens and/or category, or return
 * a category directory when both are empty.
 * @param {Record<string, any>} objectInfo
 * @param {{ query?: string, category?: string }} [params]
 */
export function searchComfyObjectInfo(objectInfo, { query = '', category = '' } = {}) {
    const entries = Object.entries(objectInfo || {}).sort(([a], [b]) => collator.compare(a, b));
    const rawQuery = String(query || '').trim().toLowerCase();
    const rawCategory = String(category || '').trim().toLowerCase();

    if (!rawQuery && !rawCategory) {
        /** @type {Map<string, string[]>} */
        const byCategory = new Map();
        for (const [classType, def] of entries) {
            const cat = String(def?.category || 'uncategorized').trim() || 'uncategorized';
            let list = byCategory.get(cat);
            if (!list) {
                list = [];
                byCategory.set(cat, list);
            }
            list.push(classType);
        }

        const categories = [...byCategory.entries()]
            .sort(([a], [b]) => collator.compare(a, b))
            .map(([cat, types]) => ({
                category: cat,
                count: types.length,
                sampleTypes: types.slice(0, SAMPLE_TYPES_PER_CATEGORY),
            }));

        return {
            mode: 'categories',
            totalNodes: entries.length,
            categories,
        };
    }

    const tokens = rawQuery.split(/\s+/).filter(Boolean);
    const matches = [];

    for (const [classType, def] of entries) {
        const nodeCategory = String(def?.category || 'uncategorized').trim() || 'uncategorized';
        if (rawCategory) {
            const catLower = nodeCategory.toLowerCase();
            if (catLower !== rawCategory && !catLower.startsWith(`${rawCategory}/`)) {
                continue;
            }
        }

        const displayName = String(def?.display_name || classType);
        const description = String(def?.description || '');

        if (tokens.length > 0) {
            const haystack = `${classType}\n${displayName}\n${nodeCategory}\n${description}`.toLowerCase();
            if (!tokens.every(tok => haystack.includes(tok))) {
                continue;
            }
        }

        const outputTypes = Array.isArray(def?.output) ? def.output.map(String) : [];
        const outputNames = Array.isArray(def?.output_name) ? def.output_name.map(String) : [];
        matches.push({
            classType,
            displayName,
            category: nodeCategory,
            description,
            outputTypes,
            outputNames,
        });
    }

    const formattedLines = matches
        .map((m) => {
            const outs = m.outputTypes
                .map((type, idx) => `${idx}:${m.outputNames[idx] || type}:${type}`)
                .join(', ');
            const descPart = m.description ? ` — ${m.description}` : '';
            return `${m.classType} [${m.category}] "${m.displayName}" -> (${outs})${descPart}`;
        })
        .join('\n');

    return {
        mode: 'matches',
        totalMatches: matches.length,
        matches,
        formattedLines,
    };
}

/**
 * Extract full input/output schemas for specific ComfyUI `class_type` names.
 * @param {Record<string, any>} objectInfo
 * @param {string[]} classTypes
 */
export function inspectComfyNodes(objectInfo, classTypes = []) {
    const requested = Array.isArray(classTypes)
        ? [...new Set(classTypes.map(x => String(x || '').trim()).filter(Boolean))]
        : [];
    /** @type {Record<string, any>} */
    const nodes = {};
    /** @type {string[]} */
    const notFound = [];

    for (const ct of requested) {
        if (!objectInfo || !Object.hasOwn(objectInfo, ct) || !objectInfo[ct]) {
            notFound.push(ct);
            continue;
        }
        const def = objectInfo[ct];
        const rawOutputs = Array.isArray(def?.output) ? def.output : [];
        const rawOutputNames = Array.isArray(def?.output_name) ? def.output_name : [];
        const rawOutputIsList = Array.isArray(def?.output_is_list) ? def.output_is_list : [];
        const outputs = rawOutputs.map((type, index) => ({
            index,
            type: String(type),
            name: String(rawOutputNames[index] ?? type),
            isList: Boolean(rawOutputIsList[index]),
        }));

        nodes[ct] = {
            classType: ct,
            displayName: String(def?.display_name || ct),
            category: String(def?.category || 'uncategorized'),
            description: String(def?.description || ''),
            requiredInputs: (def?.input?.required && typeof def.input.required === 'object') ? def.input.required : {},
            optionalInputs: (def?.input?.optional && typeof def.input.optional === 'object') ? def.input.optional : {},
            outputs,
        };
    }

    return { nodes, notFound };
}
