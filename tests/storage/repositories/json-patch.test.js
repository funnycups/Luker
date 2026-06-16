import { applyJsonPatch } from '../../../src/storage/repositories/json-patch.js';
import {
    PatchTestFailedError,
    PatchMissingParentError,
    UnsupportedPatchOpError,
} from '../../../src/storage/errors.js';

describe('applyJsonPatch', () => {
    test('replace at top level', () => {
        expect(applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: 2 }])).toEqual({ a: 2 });
    });
    test('add at nested path', () => {
        expect(applyJsonPatch({ a: { b: 1 } }, [{ op: 'add', path: '/a/c', value: 2 }]))
            .toEqual({ a: { b: 1, c: 2 } });
    });
    test('add auto-creates missing intermediate objects', () => {
        expect(applyJsonPatch({}, [{ op: 'add', path: '/a/b/c', value: 1 }]))
            .toEqual({ a: { b: { c: 1 } } });
    });
    test('remove deletes object key', () => {
        expect(applyJsonPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/a' }])).toEqual({ b: 2 });
    });
    test('remove deletes array element', () => {
        expect(applyJsonPatch({ xs: [10, 20, 30] }, [{ op: 'remove', path: '/xs/1' }]))
            .toEqual({ xs: [10, 30] });
    });
    test('test op succeeds when value matches', () => {
        expect(applyJsonPatch({ a: 1 }, [
            { op: 'test', path: '/a', value: 1 },
            { op: 'replace', path: '/a', value: 2 },
        ])).toEqual({ a: 2 });
    });
    test('test op throws when value mismatches', () => {
        expect(() => applyJsonPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 99 }]))
            .toThrow(/json patch test failed/);
    });
    test('add appends to array with /-', () => {
        expect(applyJsonPatch({ xs: [1, 2] }, [{ op: 'add', path: '/xs/-', value: 3 }]))
            .toEqual({ xs: [1, 2, 3] });
    });
    test('decodes pointer escapes (~0 → ~, ~1 → /)', () => {
        expect(applyJsonPatch({ 'a/b': 1, 'c~d': 2 }, [
            { op: 'replace', path: '/a~1b', value: 9 },
            { op: 'replace', path: '/c~0d', value: 8 },
        ])).toEqual({ 'a/b': 9, 'c~d': 8 });
    });
    test('unsupported op throws', () => {
        expect(() => applyJsonPatch({}, [{ op: 'move', path: '/a', from: '/b' }]))
            .toThrow(/unsupported json patch op/);
    });
    test('add at numeric array index inserts (not replaces)', () => {
        expect(applyJsonPatch({ xs: [10, 20, 30] }, [{ op: 'add', path: '/xs/1', value: 99 }]))
            .toEqual({ xs: [10, 99, 20, 30] });
    });
    test('replace on missing parent throws structured error with path', () => {
        expect(() => applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/b/c', value: 9 }]))
            .toThrow(/replace failed: missing parent at \/b/);
    });
    test('remove on missing parent throws structured error with path', () => {
        expect(() => applyJsonPatch({ a: { b: 1 } }, [{ op: 'remove', path: '/x/y' }]))
            .toThrow(/remove failed: missing parent at \/x/);
    });
    test('remove on missing leaf key (parent exists) is a silent no-op', () => {
        expect(applyJsonPatch({ a: 1 }, [{ op: 'remove', path: '/b' }])).toEqual({ a: 1 });
    });
    test('does not mutate input (Object.freeze guard)', () => {
        const input = Object.freeze({ a: Object.freeze({ b: 1 }) });
        // No throw — cloneDeep should produce a fresh writable copy.
        expect(() => applyJsonPatch(input, [{ op: 'add', path: '/a/c', value: 2 }])).not.toThrow();
        expect(input).toEqual({ a: { b: 1 } });
    });

    test('test failure throws PatchTestFailedError', () => {
        expect(() => applyJsonPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 99 }]))
            .toThrow(PatchTestFailedError);
    });

    test('replace on missing parent throws PatchMissingParentError', () => {
        try {
            applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/b/c', value: 9 }]);
            throw new Error('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(PatchMissingParentError);
            expect(err.op).toBe('replace');
            expect(err.path).toBe('/b/c');
        }
    });

    test('remove on missing parent throws PatchMissingParentError', () => {
        try {
            applyJsonPatch({ a: { b: 1 } }, [{ op: 'remove', path: '/x/y' }]);
            throw new Error('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(PatchMissingParentError);
            expect(err.op).toBe('remove');
            expect(err.path).toBe('/x/y');
        }
    });

    test('unsupported op throws UnsupportedPatchOpError', () => {
        try {
            applyJsonPatch({}, [{ op: 'move', path: '/a', from: '/b' }]);
            throw new Error('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(UnsupportedPatchOpError);
            expect(err.op).toBe('move');
        }
    });
});
