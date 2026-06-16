import { describe, test, expect } from '@jest/globals';
import {
    sha256OfJson,
    sha256OfString,
    canonicalJson,
} from '../../../public/scripts/iteration-library/proposal-bus/drift-hash.js';

describe('proposal-bus drift-hash', () => {
    test('sha256OfString returns 64-hex digest for an ASCII payload', async () => {
        const out = await sha256OfString('hello');
        expect(out).toMatch(/^[0-9a-f]{64}$/);
        expect(out).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    test('sha256OfString is deterministic across calls', async () => {
        const a = await sha256OfString('payload');
        const b = await sha256OfString('payload');
        expect(a).toBe(b);
    });

    test('sha256OfString distinguishes content', async () => {
        const a = await sha256OfString('payload');
        const b = await sha256OfString('payloads');
        expect(a).not.toBe(b);
    });

    test('canonicalJson sorts keys deeply', () => {
        const out = canonicalJson({ b: 2, a: { y: 1, x: 2 } });
        expect(out).toBe('{"a":{"x":2,"y":1},"b":2}');
    });

    test('canonicalJson preserves arrays in original order', () => {
        const out = canonicalJson({ list: [3, 1, 2] });
        expect(out).toBe('{"list":[3,1,2]}');
    });

    test('canonicalJson omits undefined values', () => {
        const out = canonicalJson({ a: undefined, b: 2 });
        expect(out).toBe('{"b":2}');
    });

    test('sha256OfJson is order-independent across equivalent objects', async () => {
        const a = await sha256OfJson({ x: 1, y: { p: 1, q: 2 } });
        const b = await sha256OfJson({ y: { q: 2, p: 1 }, x: 1 });
        expect(a).toBe(b);
    });

    test('sha256OfJson distinguishes by content', async () => {
        const a = await sha256OfJson({ x: 1 });
        const b = await sha256OfJson({ x: 2 });
        expect(a).not.toBe(b);
    });
});
