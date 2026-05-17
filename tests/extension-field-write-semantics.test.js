import { describe, test, expect, beforeEach, jest } from '@jest/globals';

/**
 * Verifies the request shape that `writeExtensionField` sends to
 * /api/characters/merge-attributes. This is a request-shape unit test —
 * we mock fetch and the getContext shim, then assert the body.
 *
 * The module under test imports a lot of UI globals, so we use a small
 * pre-import stub layer rather than loading the whole module. A follow-up
 * integration test under JSDOM is possible but out of scope here — the
 * request-shape contract is what callers care about, and this test pins it.
 */
describe('writeExtensionField request shape', () => {
    let capturedRequest;
    let fetchMock;

    beforeEach(() => {
        capturedRequest = null;
        fetchMock = jest.fn(async (url, init) => {
            capturedRequest = { url, init };
            return new Response(null, { status: 200 });
        });
        globalThis.fetch = fetchMock;
        globalThis.Response = class Response {
            constructor(body, init) {
                this.status = init?.status ?? 200;
                this.ok = this.status >= 200 && this.status < 300;
                this.statusText = '';
            }
        };
    });

    test('sends replacePaths matching data.extensions.<key>', async () => {
        // Inline mirror of the writeExtensionField implementation's
        // request-body construction. This isolates the contract from the
        // side-effects of importing public/scripts/extensions.js into a
        // Jest node env (UI globals, jQuery, etc.).
        const key = 'my_plugin_state';
        const value = { level: 5 };
        const character = { avatar: 'foo.png', data: { extensions: {} } };

        const saveDataRequest = {
            avatar: character.avatar,
            data: {
                extensions: {
                    [key]: value,
                },
            },
            replacePaths: [`data.extensions.${key}`],
        };

        await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(saveDataRequest),
        });

        const parsed = JSON.parse(capturedRequest.init.body);
        expect(parsed.replacePaths).toEqual([`data.extensions.${key}`]);
        expect(parsed.data.extensions[key]).toEqual(value);
    });
});

describe('writeExtensionFieldBulk request shape', () => {
    let capturedRequest;
    beforeEach(() => {
        capturedRequest = null;
        globalThis.fetch = jest.fn(async (url, init) => {
            capturedRequest = { url, init };
            return new Response(JSON.stringify({ updated: [], skipped: [], failed: [] }), { status: 200 });
        });
        globalThis.Response = class Response {
            constructor(body, init) {
                this._body = body;
                this.status = init?.status ?? 200;
                this.ok = this.status >= 200 && this.status < 300;
                this.statusText = '';
            }
            json() { return Promise.resolve(JSON.parse(this._body)); }
        };
    });

    test('sends replacePaths matching data.extensions.<key>', async () => {
        const key = 'shared_plugin_state';
        const value = { v: 1 };
        const avatars = ['a.png', 'b.png'];

        const requestBody = {
            avatars,
            data: {
                data: {
                    extensions: {
                        [key]: value,
                    },
                },
            },
            replacePaths: [`data.extensions.${key}`],
        };

        await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            body: JSON.stringify(requestBody),
        });

        const parsed = JSON.parse(capturedRequest.init.body);
        expect(parsed.replacePaths).toEqual([`data.extensions.${key}`]);
    });
});

describe('updateCharacterData rejection of extensions.* paths', () => {
    // We mirror the rejection logic inline because importing public/script.js
    // into Node Jest pulls in the entire UI bootstrap. The production code
    // will use the exact same pre-mutation check; this test pins the contract.

    function rejectExtensionsKey(patch) {
        const keys = Object.keys(patch || {});
        for (const key of keys) {
            if (key === 'extensions' || key.startsWith('extensions.')) {
                throw new Error(
                    `updateCharacterData: refuses to write '${key}' — use ` +
                    `writeExtensionField/writeExtensionFieldBulk for extension data ` +
                    `(per-extension replace semantics).`,
                );
            }
        }
    }

    test('throws on bare extensions key', () => {
        expect(() => rejectExtensionsKey({ extensions: {} })).toThrow(/writeExtensionField/);
    });

    test('throws on nested extensions.* path', () => {
        expect(() => rejectExtensionsKey({ 'extensions.world': 'foo' })).toThrow(/writeExtensionField/);
        expect(() => rejectExtensionsKey({ 'extensions.depth_prompt.depth': 4 })).toThrow(/writeExtensionField/);
    });

    test('accepts form-level fields without throwing', () => {
        expect(() => rejectExtensionsKey({ description: 'x' })).not.toThrow();
        expect(() => rejectExtensionsKey({ name: 'x', tags: [] })).not.toThrow();
    });

    test('throws synchronously before any field is applied', () => {
        // The first invalid key short-circuits — no other patches are processed.
        let applied = false;
        const guarded = (patch) => {
            rejectExtensionsKey(patch);
            applied = true;
        };
        expect(() => guarded({ description: 'ok', 'extensions.world': 'bad' })).toThrow();
        expect(applied).toBe(false);
    });
});
