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

router.post('/serpapi', async (request, response) => {
    try {
        const key = readSecret(request.user.directories, SECRET_KEYS.SERPAPI);

        if (!key) {
            console.error('No SerpApi key found');
            return response.sendStatus(400);
        }

        const { query } = request.body;
        const result = await fetch(`https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${key}`);

        console.debug('SerpApi query', query);

        if (!result.ok) {
            const text = await result.text();
            console.error('SerpApi request failed', result.statusText, text);
            return response.status(500).send(text);
        }

        const data = await result.json();
        console.debug('SerpApi response', data);
        return response.json(data);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/ddg', async (request, response) => {
    try {
        const query = String(request.body.query || '').trim();

        if (!query) {
            console.error('Query is required for /ddg');
            return response.sendStatus(400);
        }

        const maxResults = Math.max(1, Math.min(20, Math.floor(Number(request.body.max_results ?? request.body.maxResults ?? 8) || 8)));
        const safeSearchRaw = String(request.body.safe_search ?? request.body.safeSearch ?? 'moderate').trim().toLowerCase();
        const timeRangeRaw = String(request.body.time_range ?? request.body.timeRange ?? '').trim().toLowerCase();
        const region = String(request.body.region || '').trim();
        const safeSearchMap = {
            off: '-2',
            moderate: '-1',
            strict: '1',
        };
        const timeRangeMap = {
            day: 'd',
            week: 'w',
            month: 'm',
            year: 'y',
        };

        const searchUrl = new URL('https://duckduckgo.com/html/');
        searchUrl.searchParams.set('q', query);
        searchUrl.searchParams.set('kp', safeSearchMap[safeSearchRaw] || '-1');
        if (region) {
            searchUrl.searchParams.set('kl', region);
        }
        if (timeRangeMap[timeRangeRaw]) {
            searchUrl.searchParams.set('df', timeRangeMap[timeRangeRaw]);
        }

        console.debug('DDG query', query);
        const result = await fetch(searchUrl, {
            headers: visitHeaders,
        });

        if (!result.ok) {
            const text = await result.text();
            console.error('DDG request failed', result.statusText, text);
            return response.status(500).send(text);
        }

        const html = await result.text();
        const results = parseDuckDuckGoHtml(html, maxResults);

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

        const maxResults = Math.max(1, Math.min(20, Math.floor(Number(request.body.max_results ?? request.body.maxResults ?? 8) || 8)));
        const safeSearchRaw = String(request.body.safe_search ?? request.body.safeSearch ?? 'moderate').trim().toLowerCase();
        const timeRangeRaw = String(request.body.time_range ?? request.body.timeRange ?? '').trim().toLowerCase();
        const language = String(request.body.language || '').trim();
        const safeSearchMap = {
            off: '0',
            moderate: '1',
            strict: '2',
        };
        const timeRangeMap = {
            day: 'day',
            week: 'week',
            month: 'month',
            year: 'year',
        };

        let normalizedBaseUrl = '';
        try {
            normalizedBaseUrl = new URL(baseUrl).toString();
        } catch {
            console.error('Invalid baseUrl for /searxng', baseUrl);
            return response.status(400).send('Invalid baseUrl');
        }

        console.debug('SearXNG query', normalizedBaseUrl, query);

        const buildSearchUrl = ({ json = false } = {}) => {
            const searchUrl = new URL('/search', normalizedBaseUrl);
            searchUrl.searchParams.set('q', query);
            if (preferences) {
                searchUrl.searchParams.set('preferences', preferences);
            }
            if (categories) {
                searchUrl.searchParams.set('categories', categories);
            }
            if (language) {
                searchUrl.searchParams.set('language', language);
            }
            if (safeSearchMap[safeSearchRaw]) {
                searchUrl.searchParams.set('safesearch', safeSearchMap[safeSearchRaw]);
            }
            if (timeRangeMap[timeRangeRaw]) {
                searchUrl.searchParams.set('time_range', timeRangeMap[timeRangeRaw]);
            }
            if (json) {
                searchUrl.searchParams.set('format', 'json');
            }
            return searchUrl;
        };

        const jsonSearchUrl = buildSearchUrl({ json: true });
        const jsonResult = await fetch(jsonSearchUrl, {
            headers: {
                ...visitHeaders,
                'Accept': 'application/json',
            },
        });

        if (jsonResult.ok && String(jsonResult.headers.get('content-type') || '').includes('application/json')) {
            const payload = await jsonResult.json();
            const results = normalizeSearxngApiResults(payload?.results, maxResults);
            return response.json({
                provider: 'searxng',
                query,
                result_count: results.length,
                results,
            });
        }

        const mainPageUrl = new URL(normalizedBaseUrl);
        const mainPageRequest = await fetch(mainPageUrl, { headers: visitHeaders });

        if (!mainPageRequest.ok) {
            console.error('SearXNG request failed', mainPageRequest.statusText);
            return response.sendStatus(500);
        }

        const mainPageText = await mainPageRequest.text();
        const clientHref = mainPageText.match(/href="(\/client.+\.css)"/)?.[1];

        if (clientHref) {
            const clientUrl = new URL(clientHref, normalizedBaseUrl);
            await fetch(clientUrl, { headers: visitHeaders });
        }

        const htmlSearchUrl = buildSearchUrl();
        const searchResult = await fetch(htmlSearchUrl, { headers: visitHeaders });

        if (!searchResult.ok) {
            const text = await searchResult.text();
            console.error('SearXNG request failed', searchResult.statusText, text);
            return response.sendStatus(500);
        }

        const html = await searchResult.text();
        const results = parseSearxngHtml(html, normalizedBaseUrl, maxResults);
        return response.json({
            provider: 'searxng',
            query,
            result_count: results.length,
            results,
        });
    } catch (error) {
        console.error('SearXNG request failed', error);
        return response.sendStatus(500);
    }
});

router.post('/tavily', async (request, response) => {
    try {
        const apiKey = readSecret(request.user.directories, SECRET_KEYS.TAVILY);

        if (!apiKey) {
            console.error('No Tavily key found');
            return response.sendStatus(400);
        }

        const { query, include_images } = request.body;

        const body = {
            query: query,
            api_key: apiKey,
            search_depth: 'basic',
            topic: 'general',
            include_answer: true,
            include_raw_content: false,
            include_images: !!include_images,
            include_image_descriptions: false,
            include_domains: [],
            max_results: 10,
        };

        const result = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        console.debug('Tavily query', query);

        if (!result.ok) {
            const text = await result.text();
            console.error('Tavily request failed', result.statusText, text);
            return response.status(500).send(text);
        }

        const data = await result.json();
        console.debug('Tavily response', data);
        return response.json(data);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
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
        const key = readSecret(request.user.directories, SECRET_KEYS.SERPER);

        if (!key) {
            console.error('No Serper key found');
            return response.sendStatus(400);
        }

        const { query, images } = request.body;

        const url = images
            ? 'https://google.serper.dev/images'
            : 'https://google.serper.dev/search';

        const result = await fetch(url, {
            method: 'POST',
            headers: {
                'X-API-KEY': key,
                'Content-Type': 'application/json',
            },
            redirect: 'follow',
            body: JSON.stringify({ q: query }),
        });

        console.debug('Serper query', query);

        if (!result.ok) {
            const text = await result.text();
            console.warn('Serper request failed', result.statusText, text);
            return response.status(500).send(text);
        }

        const data = await result.json();
        console.debug('Serper response', data);
        return response.json(data);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/brave', async (request, response) => {
    try {
        const apiKey = readSecret(request.user.directories, SECRET_KEYS.BRAVE_SEARCH);

        if (!apiKey) {
            console.error('No Brave Search key found');
            return response.status(400).send('No Brave Search key found');
        }

        const query = String(request.body.query || '').trim();
        if (!query) {
            console.error('Query is required for /brave');
            return response.sendStatus(400);
        }

        const maxResults = Math.max(1, Math.min(20, Math.floor(Number(request.body.max_results ?? request.body.maxResults ?? 8) || 8)));
        const safeSearchRaw = String(request.body.safe_search ?? request.body.safeSearch ?? 'moderate').trim().toLowerCase();
        const timeRangeRaw = String(request.body.time_range ?? request.body.timeRange ?? '').trim().toLowerCase();
        const safeSearchMap = {
            off: 'off',
            moderate: 'moderate',
            strict: 'strict',
        };
        const freshnessMap = {
            day: 'pd',
            week: 'pw',
            month: 'pm',
            year: 'py',
        };

        const searchUrl = new URL('https://api.search.brave.com/res/v1/web/search');
        searchUrl.searchParams.set('q', query);
        searchUrl.searchParams.set('count', String(maxResults));
        searchUrl.searchParams.set('safesearch', safeSearchMap[safeSearchRaw] || 'moderate');
        if (freshnessMap[timeRangeRaw]) {
            searchUrl.searchParams.set('freshness', freshnessMap[timeRangeRaw]);
        }

        console.debug('Brave Search query', query);
        const result = await fetch(searchUrl, {
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': apiKey,
            },
        });

        if (!result.ok) {
            const text = await result.text();
            console.error('Brave Search request failed', result.statusText, text);
            return response.status(500).send(text);
        }

        const data = await result.json();
        const results = normalizeBraveApiResults(data?.web?.results, maxResults);
        return response.json({
            provider: 'brave',
            query,
            result_count: results.length,
            results,
        });
    } catch (error) {
        console.error('Brave Search request failed', error);
        return response.sendStatus(500);
    }
});

router.post('/zai', async (request, response) => {
    try {
        const key = readSecret(request.user.directories, SECRET_KEYS.ZAI);

        if (!key) {
            console.error('No Z.AI key found');
            return response.sendStatus(400);
        }

        const { query } = request.body;

        if (!query) {
            console.error('No query provided for /zai');
            return response.sendStatus(400);
        }

        console.debug('Z.AI web search query', query);

        const result = await fetch('https://api.z.ai/api/paas/v4/web_search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
            },
            body: JSON.stringify({
                // TODO: There's only one engine option for now
                search_engine: 'search-prime',
                search_query: query,
            }),
        });

        if (!result.ok) {
            const text = await result.text();
            console.error('Z.AI request failed', result.statusText, text);
            return response.status(500).send(text);
        }

        const data = await result.json();
        console.debug('Z.AI web search response', data);
        return response.json(data);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
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
