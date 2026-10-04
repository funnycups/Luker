import fetch from 'node-fetch';
import express from 'express';
import { load } from 'cheerio';
import ipRegex from 'ip-regex';

import { decode } from 'html-entities';
import { readSecret, SECRET_KEYS } from './secrets.js';
import { trimV1 } from '../util.js';
import { setAdditionalHeaders } from '../additional-headers.js';
import { getUntrustedRequestAgent } from '../private-request-filter.js';

export const router = express.Router();

// Cosplay as browser
const visitHeaders = {
    'Accept': 'text/html',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'TE': 'trailers',
    'DNT': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
};

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function fetchProviderJson(url, init, label) {
    const result = await fetch(url, init);
    if (!result.ok) {
        const text = await result.text().catch(() => '');
        throw new HttpError(result.status >= 500 ? 502 : result.status, `${label} request failed: ${result.status} ${result.statusText}. ${text}`.trim());
    }
    return await result.json();
}

function normalizeWhitespace(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripHtmlTags(text) {
    return String(text || '').replace(/<[^>]*>/g, ' ');
}

function decodeHtmlFragment(text) {
    return normalizeWhitespace(decode(stripHtmlTags(text)));
}

function resolveDuckDuckGoResultUrl(rawHref) {
    let href = String(rawHref || '').trim();
    if (!href) {
        return '';
    }

    if (href.startsWith('//')) {
        href = `https:${href}`;
    }

    try {
        const parsed = new URL(href, 'https://duckduckgo.com');
        const isRedirect = parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname === '/l/';
        if (isRedirect) {
            const target = parsed.searchParams.get('uddg');
            if (target) {
                try {
                    return decodeURIComponent(target);
                } catch {
                    return target;
                }
            }
        }
        return parsed.toString();
    } catch {
        return href;
    }
}

function resolveRelativeResultUrl(rawHref, baseUrl = '') {
    const href = String(rawHref || '').trim();
    if (!href) {
        return '';
    }

    try {
        const parsed = baseUrl ? new URL(href, baseUrl) : new URL(href);
        return parsed.toString();
    } catch {
        return href;
    }
}

function parseDuckDuckGoHtml(html, maxResults = 8) {
    const source = String(html || '');
    const results = [];
    const seenUrls = new Set();
    const $ = load(source);
    const containerSelectors = [
        'article[data-testid="result"]',
        '.result.results_links_deep.web-result',
        '.web-result',
    ];
    const titleSelectors = [
        '[data-testid="result-title-a"]',
        'a.result__a',
        'h2 a',
    ];
    const urlSelectors = [
        '[data-testid="result-extras-url-link"]',
        'a.result__url',
        '.result__extras__url a',
    ];
    const snippetSelectors = [
        '[data-result="snippet"]',
        '.result__snippet',
    ];

    let containers = $();
    for (const selector of containerSelectors) {
        containers = $(selector);
        if (containers.length) {
            break;
        }
    }

    for (const container of containers.toArray()) {
        if (results.length >= maxResults) {
            break;
        }

        const $container = $(container);

        let titleLink = null;
        for (const selector of titleSelectors) {
            const candidate = $container.find(selector).first();
            if (candidate.length) {
                titleLink = candidate;
                break;
            }
        }

        if (!titleLink?.length) {
            continue;
        }

        let urlLink = null;
        for (const selector of urlSelectors) {
            const candidate = $container.find(selector).first();
            if (candidate.length) {
                urlLink = candidate;
                break;
            }
        }

        const rawHref = urlLink?.attr('href') || titleLink.attr('href') || '';
        const titleHtml = titleLink.html() || titleLink.text();
        const title = decodeHtmlFragment(titleHtml);
        const url = resolveDuckDuckGoResultUrl(rawHref);

        if (!title || !url || seenUrls.has(url)) {
            continue;
        }

        let protocol = '';
        try {
            protocol = new URL(url).protocol;
        } catch {
            protocol = '';
        }

        if (protocol !== 'http:' && protocol !== 'https:') {
            continue;
        }

        let snippet = '';
        for (const selector of snippetSelectors) {
            const candidate = $container.find(selector).first();
            const text = normalizeWhitespace(decode(candidate.text() || ''));
            if (text) {
                snippet = text;
                break;
            }
        }

        seenUrls.add(url);
        results.push({ title, url, snippet });
    }

    return results;
}

function parseSearxngHtml(html, baseUrl, maxResults = 8) {
    const source = String(html || '');
    const results = [];
    const seenUrls = new Set();
    const $ = load(source);
    const containers = $('article.result, .result').toArray();

    for (const container of containers) {
        if (results.length >= maxResults) {
            break;
        }

        const $container = $(container);
        const titleLink = $container.find('h3 a, a.result_header, a.url_header, a[data-testid="result-title-a"]').first();
        if (!titleLink.length) {
            continue;
        }

        const rawHref = titleLink.attr('href')
            || $container.find('a.url_header, .url_header a, a.result_url').first().attr('href')
            || '';
        const title = decodeHtmlFragment(titleLink.html() || titleLink.text());
        const url = resolveRelativeResultUrl(rawHref, baseUrl);

        if (!title || !url || seenUrls.has(url)) {
            continue;
        }

        let protocol = '';
        try {
            protocol = new URL(url).protocol;
        } catch {
            protocol = '';
        }

        if (protocol !== 'http:' && protocol !== 'https:') {
            continue;
        }

        const snippet = normalizeWhitespace(decode(
            $container.find('p.content, .content, .result-content, .result-snippet').first().text() || '',
        ));

        seenUrls.add(url);
        results.push({ title, url, snippet });
    }

    return results;
}

function normalizeSearxngApiResults(rawRows = [], maxResults = 8) {
    if (!Array.isArray(rawRows)) {
        return [];
    }

    const results = [];
    const seenUrls = new Set();
    for (const row of rawRows) {
        if (results.length >= maxResults) {
            break;
        }

        const title = normalizeWhitespace(row?.title || '');
        const url = normalizeWhitespace(row?.url || '');
        const snippet = normalizeWhitespace(row?.content || row?.snippet || '');
        if (!title || !url || seenUrls.has(url)) {
            continue;
        }

        let protocol = '';
        try {
            protocol = new URL(url).protocol;
        } catch {
            protocol = '';
        }

        if (protocol !== 'http:' && protocol !== 'https:') {
            continue;
        }

        seenUrls.add(url);
        results.push({ title, url, snippet });
    }

    return results;
}

function normalizeBraveApiResults(rawRows = [], maxResults = 8) {
    if (!Array.isArray(rawRows)) {
        return [];
    }

    const results = [];
    const seenUrls = new Set();
    for (const row of rawRows) {
        if (results.length >= maxResults) {
            break;
        }

        const title = normalizeWhitespace(row?.title || '');
        const url = normalizeWhitespace(row?.url || '');
        const snippet = normalizeWhitespace(row?.description || row?.snippet || '');
        if (!title || !url || seenUrls.has(url)) {
            continue;
        }

        let protocol = '';
        try {
            protocol = new URL(url).protocol;
        } catch {
            protocol = '';
        }

        if (protocol !== 'http:' && protocol !== 'https:') {
            continue;
        }

        seenUrls.add(url);
        results.push({ title, url, snippet });
    }

    return results;
}

const TIME_RANGE_TBS = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' };

function normalizeApiResults(rawRows = [], accessors = {}, maxResults = 8) {
    if (!Array.isArray(rawRows)) {
        return [];
    }

    const pick = (row, accessor) => (typeof accessor === 'function' ? accessor(row) : row?.[accessor]);

    const results = [];
    const seenUrls = new Set();
    for (const row of rawRows) {
        if (results.length >= maxResults) {
            break;
        }

        const title = normalizeWhitespace(pick(row, accessors.title) || '');
        const url = normalizeWhitespace(pick(row, accessors.url) || '');
        const snippet = normalizeWhitespace(pick(row, accessors.snippet) || '');
        if (!title || !url || seenUrls.has(url)) {
            continue;
        }

        let protocol = '';
        try {
            protocol = new URL(url).protocol;
        } catch {
            protocol = '';
        }

        if (protocol !== 'http:' && protocol !== 'https:') {
            continue;
        }

        seenUrls.add(url);
        results.push({ title, url, snippet });
    }

    return results;
}

function buildTavilyRequest({ query, maxResults, safeSearch, timeRange, options = {}, apiKey, raw = false }) {
    const searchDepth = options.searchDepth || 'basic';
    const body = {
        query,
        api_key: apiKey,
        search_depth: searchDepth,
        topic: options.topic || 'general',
        include_answer: options.includeAnswer === 'off' ? false : (options.includeAnswer || false),
        include_raw_content: false,
        include_images: Boolean(options.includeImages),
        include_image_descriptions: false,
        include_domains: [],
        exclude_domains: [],
        max_results: maxResults,
    };
    if (timeRange) {
        body.time_range = timeRange;
    }
    if (!raw && searchDepth !== 'fast' && searchDepth !== 'ultra-fast') {
        body.safe_search = Boolean(safeSearch) && safeSearch !== 'off';
    }
    return {
        url: 'https://api.tavily.com/search',
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
    };
}

function normalizeTavilyResults(raw, maxResults = 8) {
    return normalizeApiResults(raw?.results, { title: 'title', url: 'url', snippet: 'content' }, maxResults);
}

function buildExaRequest({ query, maxResults, safeSearch, region, options = {}, apiKey }) {
    const body = {
        query,
        type: options.searchType || 'auto',
        numResults: maxResults,
    };
    if (options.category) {
        body.category = options.category;
    }
    const userLocation = region || options.region || '';
    if (userLocation) {
        body.userLocation = userLocation;
    }
    if (options.contents === 'highlights') {
        body.contents = { highlights: true };
    } else if (options.contents === 'text') {
        body.contents = { text: true };
    }
    if (safeSearch && safeSearch !== 'off') {
        body.moderation = true;
    }
    return {
        url: 'https://api.exa.ai/search',
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
            body: JSON.stringify(body),
        },
    };
}

function normalizeExaResults(raw, maxResults = 8) {
    return normalizeApiResults(raw?.results, {
        title: 'title',
        url: 'url',
        snippet: (row) => (Array.isArray(row?.highlights) ? row.highlights.join(' ') : (row?.text || '')),
    }, maxResults);
}

function buildSerperRequest({ query, maxResults, timeRange, region, options = {}, apiKey, raw = false, hasExplicitMaxResults = false }) {
    const resultType = options.resultType || 'web';
    const path = resultType === 'news' ? '/news' : (resultType === 'images' ? '/images' : '/search');
    const body = { q: query };
    if (!raw || hasExplicitMaxResults) {
        body.num = maxResults;
    }
    const country = region || options.region || '';
    if (country) {
        body.gl = country;
    }
    if (options.language) {
        body.hl = options.language;
    }
    if (TIME_RANGE_TBS[timeRange]) {
        body.tbs = TIME_RANGE_TBS[timeRange];
    }
    return {
        url: `https://google.serper.dev${path}`,
        init: {
            method: 'POST',
            headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
    };
}

function normalizeSerperResults(raw, maxResults = 8, resultType = 'web') {
    const rows = resultType === 'news' ? raw?.news : raw?.organic;
    return normalizeApiResults(rows, { title: 'title', url: 'link', snippet: 'snippet' }, maxResults);
}

function buildSerpapiRequest({ query, maxResults, safeSearch, timeRange, region, options = {}, apiKey, raw = false }) {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', apiKey);
    if (options.resultType === 'news') {
        url.searchParams.set('tbm', 'nws');
    }
    const country = region || options.region || '';
    if (country) {
        url.searchParams.set('gl', country);
    }
    if (options.language) {
        url.searchParams.set('hl', options.language);
    }
    if (TIME_RANGE_TBS[timeRange]) {
        url.searchParams.set('tbs', TIME_RANGE_TBS[timeRange]);
    }
    if (!raw && safeSearch && safeSearch !== 'off') {
        url.searchParams.set('safe', 'active');
    }
    return { url: url.toString(), init: { method: 'GET' } };
}

function normalizeSerpapiResults(raw, maxResults = 8, resultType = 'web') {
    const rows = resultType === 'news' ? raw?.news_results : raw?.organic_results;
    return normalizeApiResults(rows, { title: 'title', url: 'link', snippet: 'snippet' }, maxResults);
}

function buildZaiRequest({ query, maxResults, options = {}, apiKey, raw = false, hasExplicitMaxResults = false }) {
    const body = {
        search_engine: 'search-prime',
        search_query: query,
    };
    if (!raw || hasExplicitMaxResults) {
        body.count = maxResults;
    }
    if (options.recency && options.recency !== 'noLimit') {
        body.search_recency_filter = options.recency;
    }
    return {
        url: 'https://api.z.ai/api/paas/v4/web_search',
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(body),
        },
    };
}

function normalizeZaiResults(raw, maxResults = 8) {
    return normalizeApiResults(raw?.search_result, { title: 'title', url: 'link', snippet: 'content' }, maxResults);
}

async function fetchDdgResults({ query, maxResults, safeSearch, timeRange, region }) {
    const safeSearchMap = { off: '-2', moderate: '-1', strict: '1' };
    const timeRangeMap = { day: 'd', week: 'w', month: 'm', year: 'y' };
    const searchUrl = new URL('https://duckduckgo.com/html/');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('kp', safeSearchMap[safeSearch] || '-1');
    if (region) {
        searchUrl.searchParams.set('kl', region);
    }
    if (timeRangeMap[timeRange]) {
        searchUrl.searchParams.set('df', timeRangeMap[timeRange]);
    }
    const result = await fetch(searchUrl, { headers: visitHeaders });
    if (!result.ok) {
        const text = await result.text().catch(() => '');
        throw new HttpError(502, `DDG request failed: ${result.statusText} ${text}`.trim());
    }
    return parseDuckDuckGoHtml(await result.text(), maxResults);
}

async function fetchBraveResults({ query, maxResults, safeSearch, timeRange, apiKey }) {
    const safeSearchMap = { off: 'off', moderate: 'moderate', strict: 'strict' };
    const freshnessMap = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };
    const searchUrl = new URL('https://api.search.brave.com/res/v1/web/search');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('count', String(maxResults));
    searchUrl.searchParams.set('safesearch', safeSearchMap[safeSearch] || 'moderate');
    if (freshnessMap[timeRange]) {
        searchUrl.searchParams.set('freshness', freshnessMap[timeRange]);
    }
    const raw = await fetchProviderJson(searchUrl, {
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey },
    }, 'Brave Search');
    return normalizeBraveApiResults(raw?.web?.results, maxResults);
}

async function fetchSearxngResults({ query, maxResults, safeSearch, timeRange, options = {} }) {
    const baseUrl = normalizeWhitespace(options.baseUrl || '');
    if (!baseUrl) {
        throw new HttpError(400, 'SearXNG instance URL is required.');
    }
    const safeSearchMap = { off: '0', moderate: '1', strict: '2' };
    const timeRangeMap = { day: 'day', week: 'week', month: 'month', year: 'year' };
    let normalizedBaseUrl = '';
    try {
        normalizedBaseUrl = new URL(baseUrl).toString();
    } catch {
        throw new HttpError(400, 'Invalid SearXNG instance URL.');
    }
    const buildUrl = ({ json = false } = {}) => {
        const url = new URL('/search', normalizedBaseUrl);
        url.searchParams.set('q', query);
        if (safeSearchMap[safeSearch]) {
            url.searchParams.set('safesearch', safeSearchMap[safeSearch]);
        }
        if (timeRangeMap[timeRange]) {
            url.searchParams.set('time_range', timeRangeMap[timeRange]);
        }
        if (json) {
            url.searchParams.set('format', 'json');
        }
        return url;
    };
    const jsonResult = await fetch(buildUrl({ json: true }), { headers: { ...visitHeaders, 'Accept': 'application/json' } });
    if (jsonResult.ok && String(jsonResult.headers.get('content-type') || '').includes('application/json')) {
        return normalizeSearxngApiResults((await jsonResult.json())?.results, maxResults);
    }
    const searchResult = await fetch(buildUrl(), { headers: visitHeaders });
    if (!searchResult.ok) {
        const text = await searchResult.text().catch(() => '');
        throw new HttpError(502, `SearXNG request failed: ${searchResult.statusText} ${text}`.trim());
    }
    return parseSearxngHtml(await searchResult.text(), normalizedBaseUrl, maxResults);
}

const SEARCH_ADAPTERS = {
    ddg: {
        async execute(ctx) {
            return { raw: null, results: await fetchDdgResults(ctx) };
        },
    },
    searxng: {
        async execute(ctx) {
            return { raw: null, results: await fetchSearxngResults(ctx) };
        },
    },
    brave: {
        async execute(ctx) {
            const apiKey = readSecret(ctx.directories, SECRET_KEYS.BRAVE_SEARCH);
            if (!apiKey) {
                throw new HttpError(400, 'No Brave Search key found');
            }
            return { raw: null, results: await fetchBraveResults({ ...ctx, apiKey }) };
        },
    },
    tavily: {
        async execute(ctx) {
            const apiKey = readSecret(ctx.directories, SECRET_KEYS.TAVILY);
            if (!apiKey) {
                throw new HttpError(400, 'No Tavily key found');
            }
            const { url, init } = buildTavilyRequest({ ...ctx, apiKey });
            const raw = await fetchProviderJson(url, init, 'Tavily');
            return { raw, results: normalizeTavilyResults(raw, ctx.maxResults) };
        },
    },
    exa: {
        async execute(ctx) {
            const apiKey = readSecret(ctx.directories, SECRET_KEYS.EXA);
            if (!apiKey) {
                throw new HttpError(400, 'No Exa key found');
            }
            const { url, init } = buildExaRequest({ ...ctx, apiKey });
            const raw = await fetchProviderJson(url, init, 'Exa');
            return { raw, results: normalizeExaResults(raw, ctx.maxResults) };
        },
    },
    serper: {
        async execute(ctx) {
            const apiKey = readSecret(ctx.directories, SECRET_KEYS.SERPER);
            if (!apiKey) {
                throw new HttpError(400, 'No Serper key found');
            }
            const { url, init } = buildSerperRequest({ ...ctx, apiKey });
            const raw = await fetchProviderJson(url, init, 'Serper');
            return { raw, results: normalizeSerperResults(raw, ctx.maxResults, ctx.options?.resultType || 'web') };
        },
    },
    serpapi: {
        async execute(ctx) {
            const apiKey = readSecret(ctx.directories, SECRET_KEYS.SERPAPI);
            if (!apiKey) {
                throw new HttpError(400, 'No SerpApi key found');
            }
            const { url, init } = buildSerpapiRequest({ ...ctx, apiKey });
            const raw = await fetchProviderJson(url, init, 'SerpApi');
            return { raw, results: normalizeSerpapiResults(raw, ctx.maxResults, ctx.options?.resultType || 'web') };
        },
    },
    zai: {
        async execute(ctx) {
            const apiKey = readSecret(ctx.directories, SECRET_KEYS.ZAI);
            if (!apiKey) {
                throw new HttpError(400, 'No Z.AI key found');
            }
            const { url, init } = buildZaiRequest({ ...ctx, apiKey });
            const raw = await fetchProviderJson(url, init, 'Z.AI');
            return { raw, results: normalizeZaiResults(raw, ctx.maxResults) };
        },
    },
};

export const SEARCH_PROVIDER_IDS = Object.keys(SEARCH_ADAPTERS);

function summarizeVisitErrorBody(text, maxChars = 240) {
    const normalized = decodeHtmlFragment(text || '');
    if (!normalized) {
        return '';
    }
    if (normalized.length <= maxChars) {
        return normalized;
    }
    return `${normalized.slice(0, maxChars - 3).trim()}...`;
}

function isHtmlLikeContentType(contentType = '') {
    const normalized = String(contentType || '').toLowerCase();
    return normalized.includes('text/html') || normalized.includes('application/xhtml+xml');
}

function escapeHtml(text) {
    return String(text || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function validateVisitUrl(url) {
    const urlObj = new URL(url);

    if (urlObj.protocol === null || urlObj.host === null) {
        throw new Error('Invalid URL format');
    }

    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
        throw new Error('Invalid protocol');
    }

    if (urlObj.port !== '') {
        throw new Error('Invalid port');
    }

    // Reject IP addresses. A bracketed IPv6 literal keeps its brackets in URL.hostname.
    const bareHostname = urlObj.hostname.replace(/^\[|\]$/g, '');
    if (ipRegex.v4({ exact: true }).test(bareHostname) || ipRegex.v6({ exact: true }).test(bareHostname)) {
        throw new Error('Invalid hostname');
    }

    // Reject localhost and .localhost domains to prevent SSRF bypass
    if (urlObj.hostname === 'localhost' || urlObj.hostname.endsWith('.localhost')) {
        throw new Error('Invalid hostname');
    }

    return urlObj;
}

function extractJinaReaderField(text, label, endLabels = []) {
    const source = String(text || '').replace(/\r\n/g, '\n');
    const startMarker = `${label}:`;
    const startIndex = source.indexOf(startMarker);

    if (startIndex === -1) {
        return '';
    }

    const valueStart = startIndex + startMarker.length;
    let valueEnd = source.length;

    for (const endLabel of endLabels) {
        const endIndex = source.indexOf(`${endLabel}:`, valueStart);
        if (endIndex !== -1 && endIndex < valueEnd) {
            valueEnd = endIndex;
        }
    }

    return source.slice(valueStart, valueEnd).trim();
}

function parseJinaReaderPayload(text) {
    const source = String(text || '').replace(/\r\n/g, '\n').trim();
    const title = normalizeWhitespace(extractJinaReaderField(source, 'Title', ['URL Source', 'Published Time', 'Warning', 'Markdown Content']));
    const content = extractJinaReaderField(source, 'Markdown Content').trim() || source;
    return { title, content };
}

function renderReaderHtml(title, content) {
    const normalizedTitle = normalizeWhitespace(title) || 'Visited Page';
    const normalizedContent = String(content || '').trim();

    return [
        '<!doctype html>',
        '<html>',
        '<head>',
        '  <meta charset="utf-8" />',
        `  <title>${escapeHtml(normalizedTitle)}</title>`,
        '</head>',
        '<body>',
        `  <pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(normalizedContent)}</pre>`,
        '</body>',
        '</html>',
    ].join('\n');
}

async function fetchViaJinaReader(url) {
    const readerUrl = `https://r.jina.ai/${url}`;
    const result = await fetch(readerUrl, {
        headers: {
            'Accept': 'text/plain, text/markdown;q=0.9, */*;q=0.1',
            'User-Agent': visitHeaders['User-Agent'],
        },
    });

    if (!result.ok) {
        const bodyText = await result.text().catch(() => '');
        const bodySummary = summarizeVisitErrorBody(bodyText);
        const message = bodySummary
            ? `Jina Reader failed: upstream returned ${result.status} ${result.statusText}. ${bodySummary}`
            : `Jina Reader failed: upstream returned ${result.status} ${result.statusText}.`;
        throw new Error(message);
    }

    const text = await result.text();
    const parsed = parseJinaReaderPayload(text);
    const content = String(parsed.content || '').trim();

    if (!content) {
        throw new Error('Jina Reader returned empty content.');
    }

    return {
        title: parsed.title,
        content,
    };
}

/**
 * Extract the transcript of a YouTube video
 * @param {string} videoPageBody HTML of the video page
 * @param {string} lang Language code
 * @returns {Promise<string>} Transcript text
 */
async function extractTranscript(videoPageBody, lang) {
    const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
    const splittedHTML = videoPageBody.split('"captions":');

    if (splittedHTML.length <= 1) {
        if (videoPageBody.includes('class="g-recaptcha"')) {
            throw new Error('Too many requests');
        }
        if (!videoPageBody.includes('"playabilityStatus":')) {
            throw new Error('Video is not available');
        }
        throw new Error('Transcript not available');
    }

    const captions = (() => {
        try {
            return JSON.parse(splittedHTML[1].split(',"videoDetails')[0].replace('\n', ''));
        } catch (e) {
            return undefined;
        }
    })()?.playerCaptionsTracklistRenderer;

    if (!captions) {
        throw new Error('Transcript disabled');
    }

    if (!('captionTracks' in captions)) {
        throw new Error('Transcript not available');
    }

    if (lang && !captions.captionTracks.some(track => track.languageCode === lang)) {
        throw new Error('Transcript not available in this language');
    }

    const transcriptURL = (lang ? captions.captionTracks.find(track => track.languageCode === lang) : captions.captionTracks[0]).baseUrl;
    const transcriptResponse = await fetch(transcriptURL, {
        headers: {
            ...(lang && { 'Accept-Language': lang }),
            'User-Agent': visitHeaders['User-Agent'],
        },
    });

    if (!transcriptResponse.ok) {
        throw new Error('Transcript request failed');
    }

    const transcriptBody = await transcriptResponse.text();
    const results = [...transcriptBody.matchAll(RE_XML_TRANSCRIPT)];
    const transcript = results.map((result) => ({
        text: result[3],
        duration: parseFloat(result[2]),
        offset: parseFloat(result[1]),
        lang: lang ?? captions.captionTracks[0].languageCode,
    }));
    // The text is double-encoded
    const transcriptText = transcript.map((line) => decode(decode(line.text))).join(' ');
    return transcriptText;
}

function clampMaxResults(value) {
    return Math.max(1, Math.min(20, Math.floor(Number(value ?? 8) || 8))); // cap-ok: results feed the model's search-result context block; 20 rows keeps one search inside typical tool-output context limits
}

function buildSearchContext(request, { query, provider, raw = false }) {
    const body = request.body || {};
    return {
        provider,
        query,
        maxResults: clampMaxResults(body.max_results ?? body.maxResults ?? 8),
        safeSearch: String(body.safe_search ?? body.safeSearch ?? 'moderate').trim().toLowerCase(),
        timeRange: String(body.time_range ?? body.timeRange ?? '').trim().toLowerCase(),
        region: String(body.region || '').trim(),
        options: body.options && typeof body.options === 'object' ? body.options : {},
        directories: request.user?.directories,
        raw,
        hasExplicitMaxResults: body.max_results != null || body.maxResults != null,
    };
}

router.post('/query', async (request, response) => {
    try {
        const provider = String(request.body.provider || '').trim().toLowerCase();
        const adapter = SEARCH_ADAPTERS[provider];
        if (!adapter) {
            return response.status(400).send(`Unknown provider: ${provider}`);
        }
        const query = String(request.body.query || '').trim();
        if (!query) {
            return response.status(400).send('Query is required');
        }
        const ctx = buildSearchContext(request, { query, provider });
        const { results } = await adapter.execute(ctx);
        return response.json({
            provider,
            query,
            result_count: results.length,
            results,
        });
    } catch (error) {
        console.error('Search query failed', error);
        return response.status(error?.status || 500).send(error?.message || 'Search failed');
    }
});

router.post('/serpapi', async (request, response) => {
    try {
        const query = String(request.body.query || '').trim();
        if (!query) {
            return response.sendStatus(400);
        }
        const ctx = buildSearchContext(request, { query, provider: 'serpapi', raw: true });
        const { raw } = await SEARCH_ADAPTERS.serpapi.execute(ctx);
        return response.json(raw);
    } catch (error) {
        return response.status(error?.status || 500).send(error?.message || '');
    }
});

router.post('/ddg', async (request, response) => {
    try {
        const query = String(request.body.query || '').trim();
        if (!query) {
            return response.sendStatus(400);
        }
        const ctx = buildSearchContext(request, { query, provider: 'ddg' });
        const { results } = await SEARCH_ADAPTERS.ddg.execute(ctx);
        return response.json({
            provider: 'ddg',
            query,
            result_count: results.length,
            results,
        });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * Get the transcript of a YouTube video
 * @copyright https://github.com/Kakulukian/youtube-transcript (MIT License)
 */
router.post('/transcript', async (request, response) => {
    try {
        const id = request.body.id;
        const lang = request.body.lang;
        const json = request.body.json;

        if (!id) {
            console.error('Id is required for /transcript');
            return response.sendStatus(400);
        }

        const videoPageResponse = await fetch(`https://www.youtube.com/watch?v=${id}`, {
            headers: {
                ...(lang && { 'Accept-Language': lang }),
                'User-Agent': visitHeaders['User-Agent'],
            },
        });

        const videoPageBody = await videoPageResponse.text();

        try {
            const transcriptText = await extractTranscript(videoPageBody, lang);
            return json
                ? response.json({ transcript: transcriptText, html: videoPageBody })
                : response.send(transcriptText);
        } catch (error) {
            if (json) {
                return response.json({ html: videoPageBody, transcript: '' });
            }
            throw error;
        }
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/searxng', async (request, response) => {
    try {
        const { baseUrl, query, preferences, categories } = request.body;

        if (!baseUrl || !query) {
            console.error('Missing required parameters for /searxng');
            return response.sendStatus(400);
        }

        console.debug('SearXNG query', baseUrl, query);

        const mainPageUrl = new URL(baseUrl);
        const mainPageRequest = await fetch(mainPageUrl, { headers: visitHeaders });

        if (!mainPageRequest.ok) {
            console.error('SearXNG request failed', mainPageRequest.statusText);
            return response.sendStatus(500);
        }

        const mainPageText = await mainPageRequest.text();
        const clientHref = mainPageText.match(/href="(\/client.+\.css)"/)?.[1];

        if (clientHref) {
            const clientUrl = new URL(clientHref, baseUrl);
            await fetch(clientUrl, { headers: visitHeaders });
        }

        const searchUrl = new URL('/search', baseUrl);
        const searchParams = new URLSearchParams();
        searchParams.append('q', query);
        if (preferences) {
            searchParams.append('preferences', preferences);
        }
        if (categories) {
            searchParams.append('categories', categories);
        }
        searchUrl.search = searchParams.toString();

        const searchResult = await fetch(searchUrl, { headers: visitHeaders });

        if (!searchResult.ok) {
            const text = await searchResult.text();
            console.error('SearXNG request failed', searchResult.statusText, text);
            return response.sendStatus(500);
        }

        const data = await searchResult.text();
        return response.send(data);
    } catch (error) {
        console.error('SearXNG request failed', error);
        return response.sendStatus(500);
    }
});

router.post('/tavily', async (request, response) => {
    try {
        const query = String(request.body.query || '').trim();
        if (!query) {
            return response.sendStatus(400);
        }
        const ctx = buildSearchContext(request, { query, provider: 'tavily', raw: true });
        ctx.options = { ...ctx.options, includeAnswer: true, includeImages: Boolean(request.body.include_images) };
        ctx.maxResults = clampMaxResults(request.body.max_results ?? request.body.maxResults ?? 10);
        const { raw } = await SEARCH_ADAPTERS.tavily.execute(ctx);
        return response.json(raw);
    } catch (error) {
        return response.status(error?.status || 500).send(error?.message || '');
    }
});

router.post('/koboldcpp', async (request, response) => {
    try {
        const { query, url } = request.body;

        if (!url) {
            console.error('No URL provided for KoboldCpp search');
            return response.sendStatus(400);
        }

        console.debug('KoboldCpp search query', query);

        const baseUrl = trimV1(url);
        const args = {
            method: 'POST',
            headers: {},
            body: JSON.stringify({ q: query }),
        };

        setAdditionalHeaders(request, args, baseUrl);
        const result = await fetch(`${baseUrl}/api/extra/websearch`, args);

        if (!result.ok) {
            const text = await result.text();
            console.error('KoboldCpp request failed', result.statusText, text);
            return response.status(500).send(text);
        }

        const data = await result.json();
        console.debug('KoboldCpp search response', data);
        return response.json(data);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/serper', async (request, response) => {
    try {
        const query = String(request.body.query || '').trim();
        if (!query) {
            return response.sendStatus(400);
        }
        const ctx = buildSearchContext(request, { query, provider: 'serper', raw: true });
        if (request.body.images) {
            ctx.options = { ...ctx.options, resultType: 'images' };
        }
        const { raw } = await SEARCH_ADAPTERS.serper.execute(ctx);
        return response.json(raw);
    } catch (error) {
        return response.status(error?.status || 500).send(error?.message || '');
    }
});

router.post('/brave', async (request, response) => {
    try {
        const query = String(request.body.query || '').trim();
        if (!query) {
            return response.sendStatus(400);
        }
        const ctx = buildSearchContext(request, { query, provider: 'brave' });
        const { results } = await SEARCH_ADAPTERS.brave.execute(ctx);
        return response.json({
            provider: 'brave',
            query,
            result_count: results.length,
            results,
        });
    } catch (error) {
        return response.status(error?.status || 500).send(error?.message || '');
    }
});

router.post('/zai', async (request, response) => {
    try {
        const query = String(request.body.query || '').trim();
        if (!query) {
            return response.sendStatus(400);
        }
        const ctx = buildSearchContext(request, { query, provider: 'zai', raw: true });
        const { raw } = await SEARCH_ADAPTERS.zai.execute(ctx);
        return response.json(raw);
    } catch (error) {
        return response.status(error?.status || 500).send(error?.message || '');
    }
});

router.post('/visit', async (request, response) => {
    try {
        const url = request.body.url;
        const html = Boolean(request.body.html ?? true);
        const reader = String(request.body.reader || '').trim().toLowerCase();

        if (!url) {
            console.error('No url provided for /visit');
            return response.sendStatus(400);
        }

        try {
            validateVisitUrl(url);
        } catch (error) {
            const reason = summarizeVisitErrorBody(error?.message || '') || 'Invalid URL';
            console.error('Invalid url provided for /visit', url, reason);
            return response.status(400).send(`Invalid URL: ${reason}`);
        }

        console.info('Visiting web URL', url);

        if (reader === 'jina') {
            try {
                const readerResult = await fetchViaJinaReader(url);

                if (html) {
                    response.setHeader('Content-Type', 'text/html; charset=utf-8');
                    return response.send(renderReaderHtml(readerResult.title, readerResult.content));
                }

                response.setHeader('Content-Type', 'text/plain; charset=utf-8');
                return response.send(readerResult.content);
            } catch (error) {
                console.warn('Jina Reader request failed, falling back to direct visit', summarizeVisitErrorBody(error?.message || ''));
            }
        }

        // The URL checks above only guard the literal input. The agent enforces the actual network
        // boundary: it blocks connections to private addresses after DNS resolution, on every redirect
        // hop, and pins the connection to the validated IP to prevent DNS rebinding.
        const result = await fetch(url, { headers: visitHeaders, agent: getUntrustedRequestAgent() });

        if (!result.ok) {
            const bodyText = await result.text().catch(() => '');
            const bodySummary = summarizeVisitErrorBody(bodyText);
            const message = bodySummary
                ? `Visit failed: upstream returned ${result.status} ${result.statusText}. ${bodySummary}`
                : `Visit failed: upstream returned ${result.status} ${result.statusText}.`;
            console.error(message);
            const status = result.status >= 500 ? 502 : result.status;
            return response.status(status).send(message);
        }

        const contentType = String(result.headers.get('content-type'));

        if (html) {
            if (!isHtmlLikeContentType(contentType)) {
                const message = `Visit failed: upstream content-type is ${contentType || 'unknown'}, expected HTML.`;
                console.error(message);
                return response.status(415).send(message);
            }

            const text = await result.text();
            return response.send(text);
        }

        response.setHeader('Content-Type', contentType || 'application/octet-stream');
        const buffer = await result.arrayBuffer();
        return response.send(Buffer.from(buffer));
    } catch (error) {
        console.error(error);
        const message = summarizeVisitErrorBody(error?.message || '') || 'Visit request failed.';
        const isTimeout = String(error?.type || '').toLowerCase() === 'request-timeout' || /timeout/i.test(String(error?.message || ''));
        return response.status(isTimeout ? 504 : 502).send(`Visit request failed: ${message}`);
    }
});

export {
    normalizeApiResults,
    buildTavilyRequest,
    normalizeTavilyResults,
    buildExaRequest,
    normalizeExaResults,
    buildSerperRequest,
    normalizeSerperResults,
    buildSerpapiRequest,
    normalizeSerpapiResults,
    buildZaiRequest,
    normalizeZaiResults,
};
