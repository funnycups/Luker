import { describe, test, expect, beforeAll } from '@jest/globals';

process.env.SILLYTAVERN_ALLOWKEYSEXPOSURE = 'false';

let router;
let baseUrl;
let server;

beforeAll(async () => {
    ({ router } = await import('../../src/endpoints/search.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories: { root: '/nonexistent' } }; next(); });
    app.use('/api/search', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

function query(body) {
    return fetch(`${baseUrl}/api/search/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /api/search/query validation', () => {
    test('rejects an unknown provider with 400', async () => {
        const res = await query({ provider: 'nope', query: 'x' });
        expect(res.status).toBe(400);
    });

    test('rejects an empty query with 400', async () => {
        const res = await query({ provider: 'ddg', query: '   ' });
        expect(res.status).toBe(400);
    });

    test('requires an API key for tavily with 400', async () => {
        const res = await query({ provider: 'tavily', query: 'x' });
        expect(res.status).toBe(400);
    });
});

describe('SEARCH_PROVIDER_IDS', () => {
    test('contains the registered providers', async () => {
        const { SEARCH_PROVIDER_IDS } = await import('../../src/endpoints/search.js');
        expect([...SEARCH_PROVIDER_IDS].sort()).toEqual(
            ['brave', 'ddg', 'exa', 'searxng', 'serpapi', 'serper', 'tavily', 'zai'],
        );
    });
});

describe('upstream raw wrappers still validate', () => {
    for (const path of ['tavily', 'serper', 'serpapi', 'zai']) {
        test(`POST /api/search/${path} without a key returns 400`, async () => {
            const res = await fetch(`${baseUrl}/api/search/${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: 'x' }),
            });
            expect(res.status).toBe(400);
        });
    }
});

describe('POST /api/search/searxng upstream contract', () => {
    test('missing baseUrl returns 400', async () => {
        const res = await fetch(`${baseUrl}/api/search/searxng`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'x' }),
        });
        expect(res.status).toBe(400);
    });
});
