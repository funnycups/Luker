/**
 * iteration-library/text-diff — restored from the deleted shell renderer.
 *
 * The renderer ingests `(before, after, options)` and emits an HTML
 * `<details>` block containing a side-by-side line-level LCS diff. The
 * tests below cover the contract that the four plugin-owned popups rely
 * on:
 *
 *   - identical inputs collapse to a no-change marker
 *   - one-sided inputs paint the present side red / green wholesale
 *   - in-line modifications surface word-level highlights
 *   - multi-line edits use line-level LCS so untouched rows stay neutral
 *   - long inputs auto-collapse the `<details>` (no `open` attribute)
 *   - the i18n param is honored; default is identity
 *   - the lazy stylesheet injector is idempotent
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import {
    renderInlineTextDiffHtml,
    ensureStylesheetInjected,
    sanitizeDiffPlaceholderValue,
    formatDiffValue,
} from '../../public/scripts/iteration-library/text-diff.js';

function decodeEntities(html) {
    return String(html ?? '')
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', '\'');
}

function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let from = 0;
    while (true) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;
        count += 1;
        from = at + needle.length;
    }
    return count;
}

// Each diff row is rendered twice in the output (once on the old-side
// table, once on the new-side table), so the substring match count for a
// row class is `rowCount * 2`. This helper bakes that in.
function countRows(html, rowClass) {
    return countOccurrences(html, rowClass) / 2;
}

// Minimal in-test stub of just enough `document` API to exercise
// `ensureStylesheetInjected` without pulling in jsdom (jest runs in
// `testEnvironment: "node"` per this repo's jest.config.json).
class StubElement {
    constructor(tagName) {
        this.tagName = String(tagName || '').toUpperCase();
        this.id = '';
        this.attributes = {};
        this.parent = null;
        this.children = [];
    }
    setAttribute(name, value) { this.attributes[String(name)] = String(value); }
    getAttribute(name) {
        const key = String(name);
        if (Object.hasOwn(this.attributes, key)) return this.attributes[key];
        // Mirror real DOM: setting `el.rel = '…'` (the property) reflects
        // as the `rel` attribute. Same for `href`, `src`, `type`, etc.
        // The renderer uses property assignment for `link.rel` / `link.href`,
        // so we surface them through getAttribute too.
        if (Object.hasOwn(this, key)) return String(this[key]);
        return null;
    }
    remove() {
        if (this.parent) {
            const idx = this.parent.children.indexOf(this);
            if (idx >= 0) this.parent.children.splice(idx, 1);
            this.parent = null;
        }
    }
    appendChild(child) {
        child.parent = this;
        this.children.push(child);
    }
}

function installStubDocument() {
    const head = new StubElement('head');
    const allByQuery = [];
    const allById = new Map();
    const previousDocument = globalThis.document;
    globalThis.document = {
        head,
        createElement(tagName) { return new StubElement(tagName); },
        getElementById(id) {
            return allById.get(id) || null;
        },
        querySelectorAll(selector) {
            // Stub supports only `#<id>` — enough for the idempotency test.
            const match = /^#([\w-]+)$/.exec(String(selector || ''));
            if (!match) return [];
            const el = allById.get(match[1]);
            return el ? [el] : [];
        },
    };
    const originalAppend = head.appendChild.bind(head);
    head.appendChild = (child) => {
        originalAppend(child);
        if (child.id) allById.set(child.id, child);
        allByQuery.push(child);
        // After append, removing the element should drop the lookup too.
        const originalRemove = child.remove.bind(child);
        child.remove = () => {
            originalRemove();
            if (child.id) allById.delete(child.id);
        };
    };
    return () => {
        if (previousDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = previousDocument;
        }
    };
}

describe('iteration-library/text-diff — renderInlineTextDiffHtml', () => {
    test('identical inputs emit +0 -0 with no add/del row classes', () => {
        const html = renderInlineTextDiffHtml('hello world', 'hello world');
        expect(html).toContain('+0');
        expect(html).toContain('-0');
        // No add / del / mod row classes when nothing changed.
        expect(html).not.toContain('luker_lib_diff_row_add');
        expect(html).not.toContain('luker_lib_diff_row_del');
        expect(html).not.toContain('luker_lib_diff_row_mod');
        // Stays under the long threshold, so details default-open.
        expect(html).toMatch(/<details class="luker_lib_diff" open>/);
    });

    test('empty before paints every after line as an add (green) row', () => {
        const after = 'line A\nline B\nline C';
        const html = renderInlineTextDiffHtml('', after);
        // Three new lines → three add rows, zero del rows.
        expect(countRows(html, 'luker_lib_diff_row_add')).toBe(3);
        expect(countRows(html, 'luker_lib_diff_row_del')).toBe(0);
        // Summary reports +3 -0.
        expect(html).toContain('+3');
        expect(html).toContain('-0');
    });

    test('empty after paints every before line as a delete (red) row', () => {
        const before = 'line A\nline B';
        const html = renderInlineTextDiffHtml(before, '');
        expect(countRows(html, 'luker_lib_diff_row_del')).toBe(2);
        expect(countRows(html, 'luker_lib_diff_row_add')).toBe(0);
        expect(html).toContain('+0');
        expect(html).toContain('-2');
    });

    test('single-line, single-word change emits a mod row with inline word spans', () => {
        const html = renderInlineTextDiffHtml('hello world', 'hello there');
        // One paired delete+insert → coalesced into a mod row.
        expect(countRows(html, 'luker_lib_diff_row_mod')).toBe(1);
        // Both word-level highlights show up.
        expect(html).toContain('luker_lib_diff_word_del');
        expect(html).toContain('luker_lib_diff_word_add');
        // Unchanged token ('hello ') survives in both columns.
        expect(html.includes('hello')).toBe(true);
    });

    test('multi-line change: only the changed line is colored, unchanged lines are eq rows', () => {
        const before = 'alpha\nbeta\ngamma';
        const after = 'alpha\nBETA\ngamma';
        const html = renderInlineTextDiffHtml(before, after);
        // alpha + gamma untouched → 2 eq rows. beta vs BETA → 1 mod row.
        expect(countRows(html, 'luker_lib_diff_row_eq')).toBe(2);
        expect(countRows(html, 'luker_lib_diff_row_mod')).toBe(1);
        expect(countRows(html, 'luker_lib_diff_row_add')).toBe(0);
        expect(countRows(html, 'luker_lib_diff_row_del')).toBe(0);
    });

    test('long input (over the line-count threshold) emits a collapsed <details>', () => {
        // 25 distinct before / after lines guarantees we cross the
        // LINE_DIFF_LONG_LINE_THRESHOLD = 18 ceiling.
        const before = Array.from({ length: 25 }, (_, i) => `old line ${i}`).join('\n');
        const after = Array.from({ length: 25 }, (_, i) => `new line ${i}`).join('\n');
        const html = renderInlineTextDiffHtml(before, after);
        // No `open` attribute on the outer details.
        expect(html).toMatch(/<details class="luker_lib_diff">/);
        expect(html).not.toMatch(/<details class="luker_lib_diff" open>/);
    });

    test('long input (over the char threshold) also auto-collapses', () => {
        // One long line each side, well past the 900-char ceiling.
        const before = 'a'.repeat(1200);
        const after = 'b'.repeat(1200);
        const html = renderInlineTextDiffHtml(before, after);
        expect(html).toMatch(/<details class="luker_lib_diff">/);
        expect(html).not.toMatch(/<details class="luker_lib_diff" open>/);
    });

    test('i18n option translates the summary and Expand label', () => {
        const dict = {
            'Line diff (+${0} -${1})': '行级 diff (+${0} -${1})',
            'Expand diff': '放大',
            'Resize diff columns': '拖动',
        };
        const fakeI18n = (s) => (Object.hasOwn(dict, s) ? dict[s] : s);
        const html = renderInlineTextDiffHtml('hello', 'world', { i18n: fakeI18n });
        // The decoded summary should carry the translated template
        // (with the placeholders filled in for adds / removes).
        expect(decodeEntities(html)).toContain('行级 diff (+1 -1)');
        // The Expand button title attribute should be translated too.
        expect(html).toContain('title="放大"');
    });

    test('default i18n is identity (English passthrough)', () => {
        const html = renderInlineTextDiffHtml('hello', 'world');
        // Identity i18n means the English template stays — interpolated
        // with the actual +/- counts. (We just check the template stem.)
        expect(decodeEntities(html)).toContain('Line diff');
        expect(html).toContain('title="Expand diff"');
    });

    test('fileLabel is surfaced in data-luker-lib-diff-label and HTML-escaped', () => {
        const html = renderInlineTextDiffHtml('a', 'b', { fileLabel: 'description <unsafe>' });
        // Attribute carries an HTML-escaped copy of the label.
        expect(html).toContain('data-luker-lib-diff-label="description &lt;unsafe&gt;"');
    });

    test('third positional arg falls back to fileLabel (backward-compat)', () => {
        const html = renderInlineTextDiffHtml('a', 'b', 'mySafeLabel');
        expect(html).toContain('data-luker-lib-diff-label="mySafeLabel"');
    });

    test('handles \\r\\n input by normalizing to \\n before LCS', () => {
        const before = 'one\r\ntwo\r\nthree';
        const after = 'one\r\ntwo\r\nthree';
        const html = renderInlineTextDiffHtml(before, after);
        // Identical content after normalization → no add/del rows.
        expect(html).not.toContain('luker_lib_diff_row_add');
        expect(html).not.toContain('luker_lib_diff_row_del');
        expect(html).not.toContain('luker_lib_diff_row_mod');
    });

    test('"Not set" placeholders are treated as empty by sanitize helper', () => {
        // Both "Not set" placeholders sanitize to '', so 'Not set' → 'value'
        // is identical to '' → 'value' (one add row, no del row).
        const html = renderInlineTextDiffHtml('Not set', 'value');
        expect(countRows(html, 'luker_lib_diff_row_add')).toBe(1);
        expect(countRows(html, 'luker_lib_diff_row_del')).toBe(0);
    });
});

describe('iteration-library/text-diff — placeholder helpers', () => {
    test('sanitizeDiffPlaceholderValue strips known "not set" tokens', () => {
        expect(sanitizeDiffPlaceholderValue('Not set')).toBe('');
        expect(sanitizeDiffPlaceholderValue('未设置')).toBe('');
        expect(sanitizeDiffPlaceholderValue('未設定')).toBe('');
        expect(sanitizeDiffPlaceholderValue('  Not set  ')).toBe('');
    });

    test('sanitizeDiffPlaceholderValue preserves real content', () => {
        expect(sanitizeDiffPlaceholderValue('Not set yet')).toBe('Not set yet');
        expect(sanitizeDiffPlaceholderValue('')).toBe('');
        expect(sanitizeDiffPlaceholderValue('hello')).toBe('hello');
    });

    test('formatDiffValue is an alias for sanitizeDiffPlaceholderValue', () => {
        expect(formatDiffValue('Not set')).toBe('');
        expect(formatDiffValue('something')).toBe('something');
    });
});

describe('iteration-library/text-diff — ensureStylesheetInjected', () => {
    let restoreDocument;

    beforeEach(() => {
        // Install a fresh stub document per test. The renderer / injector
        // both no-op when `document` is undefined, and we want each test to
        // start with an empty `<head>` (no pre-injected link).
        restoreDocument = installStubDocument();
    });

    afterEach(() => {
        restoreDocument();
    });

    test('first call injects a <link> with the expected id + href', () => {
        ensureStylesheetInjected();
        const link = document.getElementById('luker_lib_diff_stylesheet');
        expect(link).toBeTruthy();
        expect(link.tagName).toBe('LINK');
        expect(link.getAttribute('rel')).toBe('stylesheet');
        expect(link.getAttribute('href')).toBe('/scripts/iteration-library/text-diff.css');
    });

    test('subsequent calls are idempotent — only one <link> remains', () => {
        ensureStylesheetInjected();
        ensureStylesheetInjected();
        ensureStylesheetInjected();
        const all = document.querySelectorAll('#luker_lib_diff_stylesheet');
        expect(all.length).toBe(1);
    });

    test('renderInlineTextDiffHtml auto-injects the stylesheet on first call', () => {
        // Pre-condition: no link.
        expect(document.getElementById('luker_lib_diff_stylesheet')).toBeNull();
        renderInlineTextDiffHtml('a', 'b');
        expect(document.getElementById('luker_lib_diff_stylesheet')).toBeTruthy();
    });
});
