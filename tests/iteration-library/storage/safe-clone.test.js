// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import { safeClone } from '../../../public/scripts/iteration-library/storage/safe-clone.js';

describe('iteration-library/storage/safe-clone', () => {
    test('deep-clones plain objects without sharing references', () => {
        const src = { a: 1, nested: { list: ['x', 'y'] } };
        const copy = safeClone(src);
        expect(copy).toEqual(src);
        copy.nested.list.push('z');
        expect(src.nested.list).toEqual(['x', 'y']);
    });

    test('falls through to JSON round-trip when structuredClone rejects non-cloneable fields', () => {
        const src = { name: 'Hero', nested: { ok: true }, uncloneableFn: () => 42 };
        const copy = safeClone(src);
        expect(copy).toEqual({ name: 'Hero', nested: { ok: true } });
        copy.nested.ok = false;
        expect(src.nested.ok).toBe(true);
    });

    test('throws instead of returning a live mutable reference when both structuredClone and JSON fail', () => {
        const cyclicWithFn = { fn: () => {} };
        cyclicWithFn.self = cyclicWithFn;
        expect(() => safeClone(cyclicWithFn)).toThrow();
    });
});
