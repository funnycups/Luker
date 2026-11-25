// tests/lib/html-escape.test.js
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeHtml, escapeHtmlText } from '../../public/scripts/lib/html-escape.js';

const UTILS_PATH = fileURLToPath(new URL('../../public/scripts/utils.js', import.meta.url));

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`function ${name} not found`);
    let depth = 0;
    let seenBrace = false;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') {
            depth++;
            seenBrace = true;
        } else if (ch === '}') {
            depth--;
            if (seenBrace && depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`function ${name} is not closed`);
}

describe('lib/html-escape', () => {
    test('escapeHtml escapes the five markup characters', () => {
        expect(escapeHtml('<a href="x">Tom & \'Jerry\'</a>'))
            .toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;');
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

    test('escapeHtml output matches the upstream utils.js escapeHtml', () => {
        const upstream = new Function(`return (${extractFunction(readFileSync(UTILS_PATH, 'utf8'), 'escapeHtml')})`)();
        for (const input of ['', 'plain', '<&>"\'', '&amp;', '"quoted" <tag attr=\'v\'>', '你好 & <世界>']) {
            expect(escapeHtml(input)).toBe(upstream(input));
        }
    });
});
