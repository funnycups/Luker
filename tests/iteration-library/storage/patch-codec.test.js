import {
    encodeInverse,
    decodeBackward,
    deriveForward,
    PatchConflictError,
} from '/scripts/iteration-library/storage/patch-codec.js';

describe('encodeInverse', () => {
    test('same state → empty patch', () => {
        expect(encodeInverse({ a: 1 }, { a: 1 })).toEqual([]);
    });

    test('scalar replace → single replace op pointing back to old value', () => {
        const result = encodeInverse({ a: 1 }, { a: 2 });
        expect(result).toEqual([{ op: 'replace', path: '/a', value: 1 }]);
    });

    test('added key in after → remove op in inverse', () => {
        const result = encodeInverse({ a: 1 }, { a: 1, b: 2 });
        expect(result).toContainEqual({ op: 'remove', path: '/b' });
    });

    test('removed key in after → add op in inverse with old value', () => {
        const result = encodeInverse({ a: 1, b: 2 }, { a: 1 });
        expect(result).toContainEqual({ op: 'add', path: '/b', value: 2 });
    });

    test('nested object change → path is JSON Pointer', () => {
        const result = encodeInverse(
            { entries: { 42: { content: 'orig' } } },
            { entries: { 42: { content: 'new' } } },
        );
        expect(result).toEqual([
            { op: 'replace', path: '/entries/42/content', value: 'orig' },
        ]);
    });
});

describe('decodeBackward', () => {
    test('roundtrip: decodeBackward(after, encodeInverse(before, after)) === before', () => {
        const before = { a: 1, b: { c: 2 } };
        const after = { a: 9, b: { c: 2, d: 3 } };
        const inverse = encodeInverse(before, after);
        expect(decodeBackward(after, inverse)).toEqual(before);
    });

    test('does not mutate the input current state', () => {
        const current = { a: { b: 1 } };
        const inverse = [{ op: 'replace', path: '/a/b', value: 0 }];
        decodeBackward(current, inverse);
        expect(current).toEqual({ a: { b: 1 } });
    });

    test('throws PatchConflictError when target path is missing', () => {
        const current = { a: 1 };
        const inverse = [{ op: 'replace', path: '/missing', value: 0 }];
        expect(() => decodeBackward(current, inverse)).toThrow(PatchConflictError);
        try { decodeBackward(current, inverse); } catch (err) {
            expect(err.jsonPath).toBe('/missing');
            expect(err.opIndex).toBe(0);
            expect(err.reason).toBe('CONFLICT');
            expect(err.hint).toMatch(/missing|not found|cannot/i);
        }
    });

    test('throws PatchConflictError with opIndex on second op failure', () => {
        const current = { a: 1, b: 2 };
        const inverse = [
            { op: 'replace', path: '/a', value: 0 },
            { op: 'remove', path: '/nope' },
        ];
        try { decodeBackward(current, inverse); } catch (err) {
            expect(err.opIndex).toBe(1);
            expect(err.jsonPath).toBe('/nope');
        }
    });
});

describe('deriveForward', () => {
    test('same state → empty patch', () => {
        expect(deriveForward({ a: 1 }, { a: 1 })).toEqual([]);
    });

    test('replace produces forward replace with new value', () => {
        expect(deriveForward({ a: 1 }, { a: 2 })).toEqual([
            { op: 'replace', path: '/a', value: 2 },
        ]);
    });

    test('bidirectional consistency: applying deriveForward(before, after) to before yields after', () => {
        const before = { a: 1, b: { c: 2 } };
        const after = { a: 9, b: { c: 3 } };
        const forward = deriveForward(before, after);
        // Apply via decodeBackward path (it is the same applyPatch under the hood,
        // we just label intent).
        let state = before;
        for (let i = 0; i < forward.length; i++) {
            state = decodeBackward(state, [forward[i]]);
        }
        expect(state).toEqual(after);
    });
});

describe('fast-json-patch invariants we rely on', () => {
    test('compare produces only add/remove/replace ops (no move/copy)', () => {
        const before = { a: [1, 2, 3], b: { c: 'x' } };
        const after = { a: [3, 2, 1], b: { c: 'y' } };
        const inverse = encodeInverse(before, after);
        for (const op of inverse) {
            expect(['add', 'remove', 'replace']).toContain(op.op);
        }
    });

    test('decodeBackward never mutates input', () => {
        const current = { entries: { 42: { content: 'orig' } } };
        const snapshot = JSON.stringify(current);
        const inverse = [{ op: 'replace', path: '/entries/42/content', value: 'prev' }];
        decodeBackward(current, inverse);
        expect(JSON.stringify(current)).toBe(snapshot);
    });

    test('empty inverse on identical objects', () => {
        const obj = { deep: { nested: { value: [1, 2, 3] } } };
        expect(encodeInverse(obj, obj)).toEqual([]);
        expect(encodeInverse(obj, JSON.parse(JSON.stringify(obj)))).toEqual([]);
    });
});

describe('encodeInverse + decodeBackward roundtrip fuzz', () => {
    // Deterministic LCG; no Math.random.
    function makeRng(seed) {
        let s = seed >>> 0;
        return () => {
            s = (s * 1664525 + 1013904223) >>> 0;
            return s / 0xffffffff;
        };
    }
    function makeNode(rng, depth) {
        if (depth <= 0 || rng() < 0.3) return Math.floor(rng() * 1000);
        const n = 1 + Math.floor(rng() * 4);
        const out = {};
        for (let i = 0; i < n; i++) out[`k${i}`] = makeNode(rng, depth - 1);
        return out;
    }
    test('100 random object pairs roundtrip cleanly', () => {
        const rng = makeRng(42);
        for (let i = 0; i < 100; i++) {
            const before = makeNode(rng, 3);
            const after = makeNode(rng, 3);
            const inv = encodeInverse(before, after);
            expect(decodeBackward(after, inv)).toEqual(before);
        }
    });
});
