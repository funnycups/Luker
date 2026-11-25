/**
 * iteration-library — render helpers.
 *
 * Plugin-owned popups call these from their `renderMessageCard` (or
 * equivalent) when they want standard markdown chat formatting:
 * bullets, code blocks, bold/italic, etc. Output is DOMPurify-
 * sanitized, so embedding via `innerHTML` is XSS-safe even with AI replies.
 *
 * showdown + DOMPurify are loaded lazily from `public/lib.js` so unit tests
 * that don't mock the lib bundle keep working — the renderer falls back to
 * a plain HTML-escape if the lazy import fails or hasn't resolved yet.
 */
import { escapeHtml } from '../lib/html-escape.js';

let _mdConverter = null;
let _mdSanitizer = null;
let _mdInitPromise = null;

export async function ensureMarkdownDeps() {
    if (_mdConverter && _mdSanitizer) return true;
    if (!_mdInitPromise) {
        _mdInitPromise = (async () => {
            try {
                const lib = await import('../../lib.js');
                _mdConverter = new lib.showdown.Converter({
                    simpleLineBreaks: true,
                    openLinksInNewWindow: true,
                    strikethrough: true,
                    tables: true,
                    tasklists: true,
                });
                _mdSanitizer = lib.DOMPurify;
                return true;
            } catch (err) {
                _mdInitPromise = null;
                console.error('[iteration-library/render] failed to load markdown dependencies:', err);
                return false;
            }
        })();
    }
    return await _mdInitPromise;
}

export function renderMessageMarkdown(text) {
    if (!text) return '';
    if (_mdConverter && _mdSanitizer) {
        const html = _mdConverter.makeHtml(String(text));
        return _mdSanitizer.sanitize(html, { USE_PROFILES: { html: true } });
    }
    ensureMarkdownDeps();
    return escapeHtml(text);
}

// Test-only: reset the cached singletons between tests.
export function _resetMarkdownCacheForTests() {
    _mdConverter = null;
    _mdSanitizer = null;
    _mdInitPromise = null;
}
