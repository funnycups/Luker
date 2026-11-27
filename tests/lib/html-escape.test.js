// tests/lib/html-escape.test.js
import { describe, test, expect } from '@jest/globals';
import { escapeHtml, escapeHtmlText } from '../../public/scripts/lib/html-escape.js';

describe('lib/html-escape', () => {
    test('escapeHtml escapes the five markup characters', () => {
        expect(escapeHtml('<a href="x">Tom & \'Jerry\'</a>'))
            .toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;');
        expect(escapeHtml('你好 & <世界>')).toBe('你好 &amp; &lt;世界&gt;');
    });

    test('escapeHtml coerces nullish to an empty string and other values through String', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
        expect(escapeHtml(0)).toBe('0');
        expect(escapeHtml(false)).toBe('false');
    });

    test('escapeHtmlText escapes only & < >', () => {
        expect(escapeHtmlText('a: "short" & <b>\'x\'</b>')).toBe('a: "short" &amp; &lt;b&gt;\'x\'&lt;/b&gt;');
    });

    test('escapeHtmlText coerces nullish to an empty string', () => {
        expect(escapeHtmlText(null)).toBe('');
        expect(escapeHtmlText(undefined)).toBe('');
    });
});
