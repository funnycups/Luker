// SPDX-License-Identifier: AGPL-3.0-or-later

import { transientSessionHeaders } from '../../lib/transient-session.js';

function normalizeSpace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

export function formatCharacterSourceCandidates(source, candidates = []) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return '';
    }
    return candidates.map((item, idx) => {
        const parts = [`${idx + 1}: [${source}] ${normalizeSpace(item.name || 'Unknown')}`];
        if (item.work) parts.push(`work=${normalizeSpace(item.work)}`);
        if (item.characterTag) parts.push(`character_tag=${normalizeSpace(item.characterTag)}`);
        if (Array.isArray(item.aliases) && item.aliases.length > 0) {
            parts.push(`aliases=${item.aliases.join(',')}`);
        }
        if (Array.isArray(item.tags) && item.tags.length > 0) {
            parts.push(`tags=${item.tags.join(',')}`);
        }
        if (Array.isArray(item.imageUrls) && item.imageUrls.length > 0) {
            parts.push(`images=${item.imageUrls.join(',')}`);
        }
        if (item.pageUrl) parts.push(`page=${item.pageUrl}`);
        if (item.summary) parts.push(normalizeSpace(item.summary));
        return parts.join(' | ');
    }).join('\n');
}

export function formatPageCandidateImages(pageData) {
    const images = Array.isArray(pageData?.images) ? pageData.images : [];
    if (images.length === 0) {
        return '';
    }
    const header = pageData?.pageTitle
        ? `# ${normalizeSpace(pageData.pageTitle)} (${pageData.pageUrl || ''})`
        : `# ${pageData?.pageUrl || ''}`;
    const lines = images.map((img, idx) => {
        const parts = [`${idx + 1}: ${img.imageUrl}`];
        if (img.width && img.height) parts.push(`${img.width}x${img.height}`);
        if (img.alt) parts.push(`alt=${normalizeSpace(img.alt)}`);
        if (img.caption) parts.push(`caption=${normalizeSpace(img.caption)}`);
        return parts.join(' | ');
    });
    return [header, ...lines].join('\n');
}

export async function searchCharacterSources({
    context,
    source = 'bangumi',
    query,
    work = '',
    wikiHost = '',
    booruSite = 'safebooru',
    maxResults = 8,
    abortSignal = null,
}) {
    const normalizedSource = String(source || '').trim().toLowerCase();
    const cleanQuery = normalizeSpace(query);
    if (!cleanQuery) {
        throw new Error('query is required.');
    }

    if (normalizedSource === 'web') {
        const searchApi = context?.getExtensionApi?.('search-tools');
        if (!searchApi || typeof searchApi.searchImages !== 'function') {
            throw new Error('Web image search requires the search-tools extension API.');
        }
        const combinedQuery = work ? `${cleanQuery} ${normalizeSpace(work)}`.trim() : cleanQuery;
        const response = await searchApi.searchImages(
            { query: combinedQuery, max_results: maxResults },
            abortSignal ? { abortSignal } : {},
        );
        const rawResults = Array.isArray(response?.results) ? response.results : [];
        const candidates = rawResults.map(item => ({
            name: String(item?.title || cleanQuery),
            aliases: [],
            work: String(work || ''),
            tags: [],
            imageUrls: item?.imageUrl ? [item.imageUrl] : [],
            pageUrl: String(item?.pageUrl || ''),
            summary: item?.width && item?.height ? `${item.width}x${item.height}` : '',
        }));
        return {
            source: 'web',
            query: combinedQuery,
            candidates,
            formattedLines: formatCharacterSourceCandidates('web', candidates),
        };
    }

    const res = await fetch('/api/sd/character-sources/search', {
        method: 'POST',
        headers: context?.getRequestHeaders?.() || { 'Content-Type': 'application/json' },
        signal: abortSignal || undefined,
        body: JSON.stringify({
            source: normalizedSource,
            query: cleanQuery,
            work,
            wikiHost: wikiHost || undefined,
            booruSite: booruSite || undefined,
        }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data?.error || `Character source search failed (${res.status}).`);
        if (data?.code) err.code = data.code;
        throw err;
    }

    return {
        source: normalizedSource,
        query: cleanQuery,
        candidates: Array.isArray(data?.candidates) ? data.candidates : [],
        formattedLines: typeof data?.formattedLines === 'string'
            ? data.formattedLines
            : formatCharacterSourceCandidates(normalizedSource, data?.candidates || []),
    };
}

export async function visitCharacterPage({ context, url, abortSignal = null }) {
    const cleanUrl = normalizeSpace(url);
    if (!cleanUrl) {
        throw new Error('url is required.');
    }

    const searchApi = context?.getExtensionApi?.('search-tools');
    if (searchApi && typeof searchApi.extractPageImages === 'function') {
        const pageData = await searchApi.extractPageImages(
            { url: cleanUrl },
            abortSignal ? { abortSignal } : {},
        );
        return {
            ...pageData,
            formattedLines: formatPageCandidateImages(pageData),
        };
    }

    const res = await fetch('/api/search/page-images', {
        method: 'POST',
        headers: context?.getRequestHeaders?.() || { 'Content-Type': 'application/json' },
        signal: abortSignal || undefined,
        body: JSON.stringify({ url: cleanUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data?.error || `Failed to extract candidate images from page (${res.status}).`);
    }
    return {
        pageTitle: String(data?.pageTitle || ''),
        pageUrl: String(data?.pageUrl || cleanUrl),
        images: Array.isArray(data?.images) ? data.images : [],
        formattedLines: formatPageCandidateImages(data),
    };
}

export async function fetchReferenceImage({
    context, imageUrl, refererUrl = '', profileId = 'char', abortSignal = null, staging = false, transientSessionId,
}) {
    const res = await fetch('/api/sd/character-sources/fetch-image', {
        method: 'POST',
        headers: {
            ...(context?.getRequestHeaders?.() || { 'Content-Type': 'application/json' }),
            ...transientSessionHeaders(transientSessionId),
        },
        signal: abortSignal || undefined,
        body: JSON.stringify({
            imageUrl,
            refererUrl: refererUrl || undefined,
            profileId,
            staging,
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data?.error || `Reference image download failed (${res.status}).`);
        if (data?.code) err.code = data.code;
        throw err;
    }
    return data;
}

export async function promoteLocalReferenceImage({
    context, sourcePath, profileId = 'char', abortSignal = null, staging = false, transientSessionId,
}) {
    const res = await fetch('/api/sd/character-sources/promote-local-image', {
        method: 'POST',
        headers: {
            ...(context?.getRequestHeaders?.() || { 'Content-Type': 'application/json' }),
            ...transientSessionHeaders(transientSessionId),
        },
        signal: abortSignal || undefined,
        body: JSON.stringify({
            sourcePath,
            profileId,
            staging,
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data?.error || `Failed to promote local reference image (${res.status}).`);
        if (data?.code) err.code = data.code;
        throw err;
    }
    return data;
}
