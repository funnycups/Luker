/**
 * Unit tests for the shared ctx + docs discovery executors
 * (`public/scripts/iteration-library/tools/ctx-and-docs-discovery.js`).
 *
 * These executors back BOTH CardApp Studio AI chat AND the orchestrator
 * iter-studio. Their behavior is critical because the iter-studio's
 * doctrine block tells the AI to use these BEFORE writing any JS that
 * touches ctx — a regression here means the AI guesses ctx instead of
 * walking into it.
 */

import { describe, test, expect, jest, beforeAll } from '@jest/globals';

globalThis.Luker = {
    getContext: () => ({
        chat: ['msg1', 'msg2'],
        characters: [{ name: 'A' }, { name: 'B' }],
        generate: function generate(prompt) { return prompt; },
        presets: {
            state: {
                patch: function patch(p) { return p; },
            },
        },
        getRequestHeaders: () => ({ 'X-Test': '1' }),
        nullField: null,
        scalarField: 'hello',
    }),
};

let mod;
beforeAll(async () => {
    mod = await import('../../public/scripts/iteration-library/tools/ctx-and-docs-discovery.js');
});

describe('listCtxKeys', () => {
    test('returns sorted top-level keys with type tags', async () => {
        const out = await mod.listCtxKeys({});
        expect(out.ok).toBe(true);
        expect(out.count).toBeGreaterThan(0);
        const names = out.keys.map(k => k.key);
        expect(names).toEqual([...names].sort());
        const chatEntry = out.keys.find(k => k.key === 'chat');
        expect(chatEntry.type).toBe('array');
        const nullEntry = out.keys.find(k => k.key === 'nullField');
        expect(nullEntry.type).toBe('null');
        const fnEntry = out.keys.find(k => k.key === 'generate');
        expect(fnEntry.type).toBe('function');
    });

    test('filter narrows by case-insensitive substring', async () => {
        const out = await mod.listCtxKeys({ filter: 'CHAR' });
        expect(out.keys.map(k => k.key)).toEqual(['characters']);
    });
});

describe('describeCtxPath', () => {
    test('function path returns parameterCount + sourcePreview', async () => {
        const out = await mod.describeCtxPath({ path: 'generate' });
        expect(out.ok).toBe(true);
        expect(out.type).toBe('function');
        expect(out.parameterCount).toBe(1);
        expect(out.sourcePreview).toMatch(/function generate/);
    });

    test('object path returns subKeys', async () => {
        const out = await mod.describeCtxPath({ path: 'presets.state' });
        expect(out.type).toBe('object');
        expect(out.subKeys.find(k => k.key === 'patch').type).toBe('function');
    });

    test('array path returns length', async () => {
        const out = await mod.describeCtxPath({ path: 'chat' });
        expect(out.type).toBe('array');
        expect(out.length).toBe(2);
    });

    test('scalar path returns value', async () => {
        const out = await mod.describeCtxPath({ path: 'scalarField' });
        expect(out.type).toBe('string');
        expect(out.value).toBe('"hello"');
    });

    test('null path errors out (cannot descend into null)', async () => {
        const out = await mod.describeCtxPath({ path: 'nullField.foo' });
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/cannot descend/);
    });

    test('missing property errors', async () => {
        const out = await mod.describeCtxPath({ path: 'no.such.path' });
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/not found/);
    });

    test('empty path errors', async () => {
        const out = await mod.describeCtxPath({ path: '' });
        expect(out.ok).toBe(false);
    });
});

describe('listLukerDocs', () => {
    test('hits /api/docs/list and filters translations by default', async () => {
        const fakeFetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                files: [
                    { path: 'features/orchestrator/custom-tools.md', size: 100 },
                    { path: 'zh-CN/features/orchestrator/custom-tools.md', size: 100 },
                    { path: 'development/extension-api/chat-and-state.md', size: 200 },
                ],
            }),
        }));
        const out = await mod.listLukerDocs({ fetchImpl: fakeFetch });
        expect(out.ok).toBe(true);
        expect(out.hiddenTranslations).toBe(1);
        expect(out.files.map(f => f.path)).toEqual([
            'features/orchestrator/custom-tools.md',
            'development/extension-api/chat-and-state.md',
        ]);
        expect(fakeFetch).toHaveBeenCalledWith('/api/docs/list', expect.any(Object));
    });

    test('includeTranslations: true keeps everything', async () => {
        const fakeFetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ files: [
                { path: 'a.md' }, { path: 'zh-CN/a.md' }, { path: 'zh-TW/a.md' },
            ] }),
        }));
        const out = await mod.listLukerDocs({ includeTranslations: true, fetchImpl: fakeFetch });
        expect(out.files.length).toBe(3);
        expect(out.hiddenTranslations).toBe(0);
    });

    test('filter is case-insensitive substring on path', async () => {
        const fakeFetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ files: [
                { path: 'features/orchestrator/custom-tools.md' },
                { path: 'development/extension-api/orchestrator-tools.md' },
                { path: 'features/cardapp.md' },
            ] }),
        }));
        const out = await mod.listLukerDocs({ filter: 'orch', fetchImpl: fakeFetch });
        expect(out.files.map(f => f.path)).toEqual([
            'features/orchestrator/custom-tools.md',
            'development/extension-api/orchestrator-tools.md',
        ]);
    });

    test('surfaces non-OK as ok:false', async () => {
        const fakeFetch = jest.fn(async () => ({ ok: false, status: 500 }));
        const out = await mod.listLukerDocs({ fetchImpl: fakeFetch });
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/500/);
    });
});

describe('readLukerDoc', () => {
    test('happy path returns content + size', async () => {
        const fakeFetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ path: 'a.md', size: 5, content: 'hello' }),
        }));
        const out = await mod.readLukerDoc({ path: 'a.md', fetchImpl: fakeFetch });
        expect(out.ok).toBe(true);
        expect(out.content).toBe('hello');
        const calledUrl = fakeFetch.mock.calls[0][0];
        expect(calledUrl).toBe('/api/docs/file?path=a.md');
    });

    test('URL-encodes the path argument', async () => {
        const fakeFetch = jest.fn(async () => ({ ok: true, json: async () => ({ path: 'a b.md', content: '' }) }));
        await mod.readLukerDoc({ path: 'dir with space/a b.md', fetchImpl: fakeFetch });
        expect(fakeFetch.mock.calls[0][0]).toContain('dir%20with%20space%2Fa%20b.md');
    });

    test('rejects empty path', async () => {
        const out = await mod.readLukerDoc({ path: '' });
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/required/);
    });

    test('surfaces 404 with detail', async () => {
        const fakeFetch = jest.fn(async () => ({
            ok: false,
            status: 404,
            json: async () => ({ error: 'not found' }),
        }));
        const out = await mod.readLukerDoc({ path: 'nope.md', fetchImpl: fakeFetch });
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/404.*not found/);
    });
});
