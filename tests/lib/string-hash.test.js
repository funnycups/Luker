// tests/lib/string-hash.test.js
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getStringHash } from '../../public/scripts/lib/string-hash.js';

const UTILS_PATH = fileURLToPath(new URL('../../public/scripts/utils.js', import.meta.url));
const LIB_PATH = fileURLToPath(new URL('../../public/scripts/lib/string-hash.js', import.meta.url));

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

const collapseWhitespace = (s) => s.replace(/\s+/g, ' ').trim();

describe('lib/string-hash getStringHash', () => {
    test('returns the persisted cyrb53 values', () => {
        expect(getStringHash('hello world')).toBe(3259054761512980);
        expect(getStringHash('你好，世界')).toBe(267949778711503);
        expect(getStringHash('')).toBe(3338908027751811);
    });

    test('the seed changes the hash', () => {
        expect(getStringHash('abc', 42)).toBe(6035376845117563);
        expect(getStringHash('abc', 42)).not.toBe(getStringHash('abc'));
    });

    test('non-string input hashes to 0', () => {
        expect(getStringHash(null)).toBe(0);
        expect(getStringHash(undefined)).toBe(0);
        expect(getStringHash(42)).toBe(0);
        expect(getStringHash({})).toBe(0);
    });

    test('the function body is identical to the upstream utils.js getStringHash', () => {
        const upstream = extractFunction(readFileSync(UTILS_PATH, 'utf8'), 'getStringHash');
        const shared = extractFunction(readFileSync(LIB_PATH, 'utf8'), 'getStringHash');
        expect(collapseWhitespace(shared)).toBe(collapseWhitespace(upstream));
    });

});
