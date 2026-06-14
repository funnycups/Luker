import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// public/lib.js is redirected to tests/util/lib-stub.js via jest config's
// moduleNameMapper — that supplies the real showdown + DOMPurify so this
// test gets a faithful Converter without a per-test mock.

let renderMessageMarkdown;
let ensureMarkdownDeps;
let _resetMarkdownCacheForTests;

beforeEach(async () => {
    // Reset module-level cache between tests so we exercise both the
    // cold-start fallback and the warmed path independently.
    const mod = await import('../../public/scripts/iteration-library/render.js');
    renderMessageMarkdown = mod.renderMessageMarkdown;
    ensureMarkdownDeps = mod.ensureMarkdownDeps;
    _resetMarkdownCacheForTests = mod._resetMarkdownCacheForTests;
    _resetMarkdownCacheForTests();
});

describe('iteration-library/render', () => {
    test('cold-start: returns HTML-escaped plain text (kicks off warm-up)', () => {
        const out = renderMessageMarkdown('<script>alert(1)</script>');
        expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    test('after warm-up: returns markdown HTML through showdown + DOMPurify', async () => {
        const ok = await ensureMarkdownDeps();
        expect(ok).toBe(true);
        const out = renderMessageMarkdown('hello world');
        expect(out).toBe('<p>hello world</p>');
    });

    test('empty / nullish input returns empty string short-circuit', () => {
        expect(renderMessageMarkdown('')).toBe('');
        expect(renderMessageMarkdown(null)).toBe('');
        expect(renderMessageMarkdown(undefined)).toBe('');
    });
});
