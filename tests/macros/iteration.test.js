import { describe, test, expect } from '@jest/globals';
import {
    tryParseJsonContainer,
    coerceContainer,
    resolveEachContainer,
    walkLoopValuePath,
} from '../../public/scripts/macros/util/iteration.js';

describe('tryParseJsonContainer', () => {
    test('accepts JSON object literal', () => {
        expect(tryParseJsonContainer('{"a":1,"b":2}')).toEqual({ a: 1, b: 2 });
    });

    test('accepts JSON array literal', () => {
        expect(tryParseJsonContainer('[1,2,3]')).toEqual([1, 2, 3]);
    });

    test('tolerates surrounding whitespace', () => {
        expect(tryParseJsonContainer('   {"x":1}\n')).toEqual({ x: 1 });
    });

    test('rejects plain numeric string (would parse but is not iterable)', () => {
        expect(tryParseJsonContainer('42')).toBeNull();
    });

    test('rejects bare string (not JSON)', () => {
        expect(tryParseJsonContainer('hello')).toBeNull();
    });

    test('rejects double-quoted string literal (parses to string, not container)', () => {
        expect(tryParseJsonContainer('"hello"')).toBeNull();
    });

    test('rejects empty string', () => {
        expect(tryParseJsonContainer('')).toBeNull();
        expect(tryParseJsonContainer('   ')).toBeNull();
    });

    test('rejects malformed JSON', () => {
        expect(tryParseJsonContainer('{not json}')).toBeNull();
        expect(tryParseJsonContainer('[1,2,')).toBeNull();
    });

    test('rejects non-string inputs', () => {
        expect(tryParseJsonContainer(null)).toBeNull();
        expect(tryParseJsonContainer(undefined)).toBeNull();
        expect(tryParseJsonContainer(42)).toBeNull();
        expect(tryParseJsonContainer({ a: 1 })).toBeNull();
    });
});

describe('coerceContainer', () => {
    test('live object passes through', () => {
        const obj = { a: 1 };
        expect(coerceContainer(obj)).toBe(obj);
    });

    test('live array passes through', () => {
        const arr = [1, 2, 3];
        expect(coerceContainer(arr)).toBe(arr);
    });

    test('JSON-stringified object goes through tryParseJsonContainer', () => {
        expect(coerceContainer('{"a":1}')).toEqual({ a: 1 });
    });

    test('null and primitive types yield null', () => {
        expect(coerceContainer(null)).toBeNull();
        expect(coerceContainer(undefined)).toBeNull();
        expect(coerceContainer(42)).toBeNull();
        expect(coerceContainer(true)).toBeNull();
    });

    test('non-container string yields null', () => {
        expect(coerceContainer('hello')).toBeNull();
        expect(coerceContainer('')).toBeNull();
    });
});

describe('resolveEachContainer', () => {
    function makeGetters({ local = {}, global = {} } = {}) {
        const make = (store) => (name) => {
            if (!Object.prototype.hasOwnProperty.call(store, name)) return '';
            return store[name];
        };
        return { local: make(local), global: make(global) };
    }

    test('JSON literal beats variable lookup', () => {
        const getters = makeGetters({ local: { '{"a":1}': 'should-not-win' } });
        expect(resolveEachContainer('{"a":1}', getters)).toEqual({ a: 1 });
    });

    test('local variable name resolves to its JSON value', () => {
        const getters = makeGetters({ local: { npcs: '{"alice":{"hp":50}}' } });
        expect(resolveEachContainer('npcs', getters)).toEqual({ alice: { hp: 50 } });
    });

    test('dotted variable path resolves through nested data', () => {
        const getters = makeGetters({ local: { world: '{"npcs":{"alice":{"hp":50},"bob":{"hp":30}}}' } });
        expect(resolveEachContainer('world.npcs', getters)).toEqual({ alice: { hp: 50 }, bob: { hp: 30 } });
    });

    test('falls back to global when local has nothing', () => {
        const getters = makeGetters({ global: { world_state: '[1,2,3]' } });
        expect(resolveEachContainer('world_state', getters)).toEqual([1, 2, 3]);
    });

    test('returns null when no path produces an iterable', () => {
        const getters = makeGetters({});
        expect(resolveEachContainer('missing', getters)).toBeNull();
    });

    test('returns null for variable holding a primitive (not iterable)', () => {
        const getters = makeGetters({ local: { name: 'Alice' } });
        expect(resolveEachContainer('name', getters)).toBeNull();
    });

    test('handles live-object variable storage (no JSON round-trip needed)', () => {
        const liveStore = { cfg: { features: ['a', 'b'] } };
        const getters = {
            local: (n) => liveStore[n] ?? '',
            global: () => '',
        };
        expect(resolveEachContainer('cfg.features', getters)).toEqual(['a', 'b']);
    });

    test('returns null on empty / non-string ref', () => {
        const getters = makeGetters({});
        expect(resolveEachContainer('', getters)).toBeNull();
        expect(resolveEachContainer('   ', getters)).toBeNull();
        expect(resolveEachContainer(null, getters)).toBeNull();
    });
});

describe('walkLoopValuePath', () => {
    test('empty path returns the value itself', () => {
        const v = { a: 1 };
        expect(walkLoopValuePath(v, '')).toBe(v);
    });

    test('single-segment path works', () => {
        expect(walkLoopValuePath({ hp: 50 }, 'hp')).toBe(50);
    });

    test('multi-segment path works', () => {
        expect(walkLoopValuePath({ stats: { atk: 7 } }, 'stats.atk')).toBe(7);
    });

    test('missing intermediate key yields undefined', () => {
        expect(walkLoopValuePath({ a: { b: 1 } }, 'a.missing.x')).toBeUndefined();
        expect(walkLoopValuePath({ a: 1 }, 'a.b')).toBeUndefined();
    });

    test('null / undefined value is safe', () => {
        expect(walkLoopValuePath(null, 'a')).toBeUndefined();
        expect(walkLoopValuePath(undefined, 'a.b')).toBeUndefined();
    });

    test('array index access works', () => {
        expect(walkLoopValuePath(['x', 'y', 'z'], '0')).toBe('x');
        expect(walkLoopValuePath(['x', 'y', 'z'], '2')).toBe('z');
        expect(walkLoopValuePath(['x'], '99')).toBeUndefined();
    });

    test('primitive value returns itself for empty path, undefined for any drill', () => {
        expect(walkLoopValuePath('hello', '')).toBe('hello');
        expect(walkLoopValuePath(42, '')).toBe(42);
        // Primitive cur with non-empty path: cur.length = ... etc. would
        // technically work in JS, but author intent for {{loop_value::x}}
        // on a primitive is "no field" — ensure that's the behavior.
        expect(walkLoopValuePath(42, 'foo')).toBeUndefined();
    });
});
