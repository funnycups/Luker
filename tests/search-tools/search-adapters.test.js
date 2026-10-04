import { describe, test, expect } from '@jest/globals';
import {
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
} from '../../src/endpoints/search.js';

const ctx = (over = {}) => ({
    query: 'capybara',
    maxResults: 5,
    safeSearch: 'moderate',
    timeRange: '',
    region: '',
    options: {},
    apiKey: 'secret',
    ...over,
});

describe('normalizeApiResults', () => {
    test('maps, dedupes, drops missing/non-http rows, and respects maxResults', () => {
        const rows = [
            { t: 'A', u: 'https://a.example', s: 'sa' },
            { t: 'A2', u: 'https://a.example', s: 'dup' },
            { t: 'B', u: 'ftp://b.example', s: 'sb' },
            { t: '', u: 'https://c.example', s: 'sc' },
            { t: 'D', u: 'https://d.example', s: 'sd' },
        ];
        const out = normalizeApiResults(rows, { title: 't', url: 'u', snippet: 's' }, 2);
        expect(out).toEqual([
            { title: 'A', url: 'https://a.example', snippet: 'sa' },
            { title: 'D', url: 'https://d.example', snippet: 'sd' },
        ]);
    });

    test('accepts accessor functions', () => {
        const out = normalizeApiResults([{ x: ['one', 'two'] }], { title: (r) => r.x.join(' '), url: () => 'https://e.example', snippet: (r) => r.x.join(' ') }, 5);
        expect(out).toEqual([{ title: 'one two', url: 'https://e.example', snippet: 'one two' }]);
    });
});

describe('tavily adapter', () => {
    test('builds a request with depth/topic/answer and omits safe_search for fast depths', () => {
        const { url, init } = buildTavilyRequest(ctx({ options: { searchDepth: 'fast', topic: 'news', includeAnswer: 'basic' } }));
        expect(url).toBe('https://api.tavily.com/search');
        const body = JSON.parse(init.body);
        expect(body.search_depth).toBe('fast');
        expect(body.topic).toBe('news');
        expect(body.include_answer).toBe('basic');
        expect(body.safe_search).toBeUndefined();
        expect(body.api_key).toBe('secret');
    });

    test('normalizes results[].content to snippet', () => {
        const out = normalizeTavilyResults({ results: [{ title: 'T', url: 'https://t.example', content: 'C' }] }, 5);
        expect(out).toEqual([{ title: 'T', url: 'https://t.example', snippet: 'C' }]);
    });

    test('forwards includeImages and defaults to false', () => {
        const withImages = JSON.parse(buildTavilyRequest(ctx({ options: { includeImages: true } })).init.body);
        expect(withImages.include_images).toBe(true);
        const byDefault = JSON.parse(buildTavilyRequest(ctx()).init.body);
        expect(byDefault.include_images).toBe(false);
    });
});

describe('exa adapter', () => {
    test('maps searchType/category/contents and moderation', () => {
        const { url, init } = buildExaRequest(ctx({ options: { searchType: 'deep', category: 'news', contents: 'text' } }));
        expect(url).toBe('https://api.exa.ai/search');
        const body = JSON.parse(init.body);
        expect(body.type).toBe('deep');
        expect(body.category).toBe('news');
        expect(body.contents).toEqual({ text: true });
        expect(body.moderation).toBe(true);
        expect(init.headers['x-api-key']).toBe('secret');
    });

    test('joins highlights into the snippet', () => {
        const out = normalizeExaResults({ results: [{ title: 'T', url: 'https://t.example', highlights: ['a', 'b'] }] }, 5);
        expect(out).toEqual([{ title: 'T', url: 'https://t.example', snippet: 'a b' }]);
    });

    test('maps region to userLocation and omits it when absent', () => {
        const withRegion = JSON.parse(buildExaRequest(ctx({ region: 'us' })).init.body);
        expect(withRegion.userLocation).toBe('us');
        const fromOptions = JSON.parse(buildExaRequest(ctx({ options: { region: 'de' } })).init.body);
        expect(fromOptions.userLocation).toBe('de');
        const without = JSON.parse(buildExaRequest(ctx()).init.body);
        expect(without.userLocation).toBeUndefined();
    });
});

describe('serper adapter', () => {
    test('routes news to /news and maps gl/hl/tbs', () => {
        const { url, init } = buildSerperRequest(ctx({ region: 'us', timeRange: 'week', options: { resultType: 'news', language: 'en' } }));
        expect(url).toBe('https://google.serper.dev/news');
        const body = JSON.parse(init.body);
        expect(body.gl).toBe('us');
        expect(body.hl).toBe('en');
        expect(body.tbs).toBe('qdr:w');
    });

    test('normalizes organic and news rows', () => {
        expect(normalizeSerperResults({ organic: [{ title: 'T', link: 'https://t.example', snippet: 'S' }] }, 5, 'web'))
            .toEqual([{ title: 'T', url: 'https://t.example', snippet: 'S' }]);
        expect(normalizeSerperResults({ news: [{ title: 'N', link: 'https://n.example', snippet: 'S' }] }, 5, 'news'))
            .toEqual([{ title: 'N', url: 'https://n.example', snippet: 'S' }]);
    });
});

describe('serpapi adapter', () => {
    test('sets tbm=nws for news and safe=active', () => {
        const { url } = buildSerpapiRequest(ctx({ options: { resultType: 'news', region: 'uk', language: 'en' } }));
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe('https://serpapi.com/search.json');
        expect(parsed.searchParams.get('tbm')).toBe('nws');
        expect(parsed.searchParams.get('gl')).toBe('uk');
        expect(parsed.searchParams.get('hl')).toBe('en');
        expect(parsed.searchParams.get('safe')).toBe('active');
    });

    test('normalizes news_results and organic_results', () => {
        expect(normalizeSerpapiResults({ news_results: [{ title: 'N', link: 'https://n.example', snippet: 'S' }] }, 5, 'news'))
            .toEqual([{ title: 'N', url: 'https://n.example', snippet: 'S' }]);
        expect(normalizeSerpapiResults({ organic_results: [{ title: 'O', link: 'https://o.example', snippet: 'S' }] }, 5, 'web'))
            .toEqual([{ title: 'O', url: 'https://o.example', snippet: 'S' }]);
    });
});

describe('zai adapter', () => {
    test('builds the search-prime request with count and recency', () => {
        const { url, init } = buildZaiRequest(ctx({ options: { recency: 'oneWeek' } }));
        expect(url).toBe('https://api.z.ai/api/paas/v4/web_search');
        const body = JSON.parse(init.body);
        expect(body.search_engine).toBe('search-prime');
        expect(body.count).toBe(5);
        expect(body.search_recency_filter).toBe('oneWeek');
        expect(init.headers.Authorization).toBe('Bearer secret');
    });

    test('normalizes search_result rows', () => {
        const out = normalizeZaiResults({ search_result: [{ title: 'T', link: 'https://t.example', content: 'C' }] }, 5);
        expect(out).toEqual([{ title: 'T', url: 'https://t.example', snippet: 'C' }]);
    });
});

describe('raw upstream wrappers preserve upstream parameters', () => {
    test('tavily raw omits safe_search but keeps the upstream max_results default', () => {
        const body = JSON.parse(buildTavilyRequest(ctx({ raw: true, maxResults: 10 })).init.body);
        expect(body.safe_search).toBeUndefined();
        expect(body.max_results).toBe(10);
    });

    test('tavily query path still sends safe_search', () => {
        const body = JSON.parse(buildTavilyRequest(ctx()).init.body);
        expect(body.safe_search).toBe(true);
    });

    test('serper raw omits num unless the caller supplied max_results', () => {
        const byDefault = JSON.parse(buildSerperRequest(ctx({ raw: true })).init.body);
        expect(byDefault.num).toBeUndefined();
        const explicit = JSON.parse(buildSerperRequest(ctx({ raw: true, hasExplicitMaxResults: true })).init.body);
        expect(explicit.num).toBe(5);
    });

    test('serpapi raw omits safe', () => {
        const rawUrl = new URL(buildSerpapiRequest(ctx({ raw: true })).url);
        expect(rawUrl.searchParams.get('safe')).toBeNull();
        const queryUrl = new URL(buildSerpapiRequest(ctx()).url);
        expect(queryUrl.searchParams.get('safe')).toBe('active');
    });

    test('zai raw omits count unless the caller supplied max_results', () => {
        const byDefault = JSON.parse(buildZaiRequest(ctx({ raw: true })).init.body);
        expect(byDefault.count).toBeUndefined();
        const explicit = JSON.parse(buildZaiRequest(ctx({ raw: true, hasExplicitMaxResults: true })).init.body);
        expect(explicit.count).toBe(5);
    });
});
