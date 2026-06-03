import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

/**
 * Light smoke test for the browser-side skillsApi wrapper.
 *
 * The REST endpoints themselves are covered by api-rest.test.js (supertest).
 * Here we only verify the jsonFetch wrapper + URL construction behaviour by
 * stubbing global.fetch. We deliberately import api.js lazily inside each
 * test so that the stubbed fetch is in place at the time `skillsApi` is
 * evaluated.
 */

// api.js imports getRequestHeaders from the main script.js to pick up the CSRF
// token. We mock the module at its boundary so tests don't pull in the entire
// browser bootstrap; the mock returns a predictable header bag so we can assert
// the CSRF token is forwarded on writes.
jest.unstable_mockModule('../../public/script.js', () => ({
    getRequestHeaders: () => ({
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'test-token-123',
    }),
}));

describe('public/scripts/skills/api.js — jsonFetch wrapper', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('list() encodes scope into the query string', async () => {
        const { skillsApi } = await import('../../public/scripts/skills/api.js');
        let capturedUrl;
        global.fetch = async (url) => {
            capturedUrl = url;
            return { ok: true, status: 200, json: async () => [] };
        };

        await skillsApi.list({ scope: { kind: 'preset', apiId: 'openai', name: 'rp4' } });

        expect(capturedUrl).toContain('scope=preset%2Fopenai%2Frp4');
    });

    test('list() defaults to scope=all when no scope is supplied', async () => {
        const { skillsApi } = await import('../../public/scripts/skills/api.js');
        let capturedUrl;
        global.fetch = async (url) => {
            capturedUrl = url;
            return { ok: true, status: 200, json: async () => [] };
        };

        await skillsApi.list();

        expect(capturedUrl).toContain('scope=all');
    });

    test('non-2xx response throws Error with .status and .body', async () => {
        const { skillsApi } = await import('../../public/scripts/skills/api.js');
        global.fetch = async () => ({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            text: async () => JSON.stringify({ error: 'illegal skill name: ../etc' }),
        });

        let caught;
        try {
            await skillsApi.delete({ kind: 'global' }, '../etc');
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeDefined();
        expect(caught.status).toBe(400);
        expect(caught.message).toMatch(/illegal/);
        expect(caught.body).toEqual({ error: 'illegal skill name: ../etc' });
    });

    test('readFile() appends offset/limit only when integer', async () => {
        const { skillsApi } = await import('../../public/scripts/skills/api.js');
        let capturedUrl;
        global.fetch = async (url) => {
            capturedUrl = url;
            return { ok: true, status: 200, json: async () => ({}) };
        };

        await skillsApi.readFile({
            scope: { kind: 'global' },
            name: 'foo',
            path: 'SKILL.md',
            offset: 10,
            limit: 50,
        });

        expect(capturedUrl).toContain('path=SKILL.md');
        expect(capturedUrl).toContain('offset=10');
        expect(capturedUrl).toContain('limit=50');
    });

    test('204 No Content is returned as null', async () => {
        const { skillsApi } = await import('../../public/scripts/skills/api.js');
        global.fetch = async () => ({
            ok: true,
            status: 204,
            json: async () => { throw new Error('should not be called'); },
        });

        const result = await skillsApi.delete({ kind: 'global' }, 'some-skill');
        expect(result).toBeNull();
    });

    test('sends X-CSRF-Token header on write calls', async () => {
        // Luker enables csrfSyncProtection globally (server-main.js), so every
        // POST/DELETE must carry X-CSRF-Token. The wrapper must source this from
        // getRequestHeaders rather than hand-rolling 'Content-Type' alone.
        const { skillsApi } = await import('../../public/scripts/skills/api.js');
        let capturedHeaders;
        global.fetch = async (url, opts) => {
            capturedHeaders = opts.headers;
            return { ok: true, status: 200, json: async () => ({ action: 'installed', name: 'x' }) };
        };

        await skillsApi.install({
            scope: { kind: 'global' },
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: x\ndescription: y\n---\n' }] },
        });

        expect(capturedHeaders['X-CSRF-Token']).toBe('test-token-123');
        expect(capturedHeaders['Content-Type']).toBe('application/json');
    });

    test('listFiles() targets the /files sub-route with encoded scope', async () => {
        const { skillsApi } = await import('../../public/scripts/skills/api.js');
        let capturedUrl;
        global.fetch = async (url) => {
            capturedUrl = url;
            return { ok: true, status: 200, json: async () => ({ files: [{ path: 'SKILL.md', size: 12, isBinary: false }] }) };
        };

        const r = await skillsApi.listFiles({
            scope: { kind: 'preset', apiId: 'openai', name: 'rp' },
            name: 'demo',
        });

        expect(capturedUrl).toContain('/api/skills/');
        expect(capturedUrl).toMatch(/\/demo\/files$/);
        // The scope segment is URL-encoded so preset/openai/rp survives Express path parsing.
        expect(capturedUrl).toContain(encodeURIComponent('preset/openai/rp'));
        expect(Array.isArray(r.files)).toBe(true);
    });

    test('deleteFile() issues DELETE with path query string', async () => {
        const { skillsApi } = await import('../../public/scripts/skills/api.js');
        let capturedUrl;
        let capturedMethod;
        global.fetch = async (url, opts) => {
            capturedUrl = url;
            capturedMethod = opts.method;
            return { ok: true, status: 204, json: async () => { throw new Error('should not be called'); } };
        };

        const r = await skillsApi.deleteFile({
            scope: { kind: 'global' },
            name: 'demo',
            path: 'references/note.md',
        });

        expect(capturedMethod).toBe('DELETE');
        expect(capturedUrl).toContain('/api/skills/global/demo/file?');
        expect(capturedUrl).toContain('path=references%2Fnote.md');
        expect(r).toBeNull();
    });

    test('listBundledManifest() GETs the bundled-manifest route', async () => {
        const { skillsApi } = await import('../../public/scripts/skills/api.js');
        let capturedUrl;
        let capturedMethod;
        global.fetch = async (url, opts) => {
            capturedUrl = url;
            // eslint-disable-next-line playwright/no-conditional-in-test
            capturedMethod = opts ? opts.method : undefined;
            return {
                ok: true,
                status: 200,
                json: async () => ([
                    { name: 'alpha', installedHash: 'h1', fileCount: 1, totalBytes: 100, description: 'a' },
                ]),
            };
        };

        const r = await skillsApi.listBundledManifest();

        expect(capturedUrl).toBe('/api/skills/bundled-manifest');
        // GET — undefined method on fetch defaults to GET.
        expect(capturedMethod).toBeUndefined();
        expect(Array.isArray(r)).toBe(true);
        expect(r[0].name).toBe('alpha');
        expect(r[0].installedHash).toBe('h1');
    });
});
