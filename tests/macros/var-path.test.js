import { describe, test, expect } from '@jest/globals';
import { resolveVarPath } from '../../public/scripts/macros/util/var-path.js';

/**
 * Build a getter that mimics getLocalVariable's contract:
 * - returns '' for missing keys (not undefined)
 * - returns Number(...) for purely numeric strings (the stock STscript
 *   coercion); we don't actually need that branch in these tests, but
 *   shaping the helper this way makes the variable-store contract
 *   explicit in the tests.
 */
function makeGetter(store) {
    return (name) => {
        if (!Object.prototype.hasOwnProperty.call(store, name)) return '';
        const value = store[name];
        if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
            return Number(value);
        }
        return value;
    };
}

describe('resolveVarPath', () => {
    test('flat key without dot returns the raw value', () => {
        const get = makeGetter({ name: 'Alice' });
        expect(resolveVarPath(get, 'name')).toBe('Alice');
    });

    test('flat key without dot for missing variable returns empty string', () => {
        const get = makeGetter({});
        expect(resolveVarPath(get, 'missing')).toBe('');
    });

    test('dotted path on JSON-stringified object walks one level', () => {
        const get = makeGetter({ user: '{"name":"Alice","age":30}' });
        expect(resolveVarPath(get, 'user.name')).toBe('Alice');
        expect(resolveVarPath(get, 'user.age')).toBe(30);
    });

    test('dotted path on JSON-stringified object walks multiple levels', () => {
        const get = makeGetter({ npcs: '{"alice":{"hp":50,"loc":"tavern"},"bob":{"hp":30}}' });
        expect(resolveVarPath(get, 'npcs.alice.hp')).toBe(50);
        expect(resolveVarPath(get, 'npcs.alice.loc')).toBe('tavern');
        expect(resolveVarPath(get, 'npcs.bob.hp')).toBe(30);
    });

    test('missing intermediate key in path returns undefined', () => {
        const get = makeGetter({ npcs: '{"alice":{"hp":50}}' });
        expect(resolveVarPath(get, 'npcs.bob.hp')).toBeUndefined();
        expect(resolveVarPath(get, 'npcs.alice.missing')).toBeUndefined();
    });

    test('path that null-walks past null/undefined returns undefined without throwing', () => {
        const get = makeGetter({ npcs: '{"alice":null}' });
        expect(resolveVarPath(get, 'npcs.alice.hp')).toBeUndefined();
        expect(resolveVarPath(get, 'npcs.alice.deep.deeper')).toBeUndefined();
    });

    test('array index access via dotted path works', () => {
        const get = makeGetter({ items: '["sword","shield","potion"]' });
        expect(resolveVarPath(get, 'items.0')).toBe('sword');
        expect(resolveVarPath(get, 'items.1')).toBe('shield');
        expect(resolveVarPath(get, 'items.99')).toBeUndefined();
    });

    test('nested array of objects via dotted path works', () => {
        const get = makeGetter({ npcs: '[{"name":"Alice"},{"name":"Bob"}]' });
        expect(resolveVarPath(get, 'npcs.0.name')).toBe('Alice');
        expect(resolveVarPath(get, 'npcs.1.name')).toBe('Bob');
    });

    test('literal dotted key falls back when head is not JSON-parseable', () => {
        // 'a' does not exist (getter returns ''), so JSON.parse('') throws,
        // and we fall through to a literal lookup of 'a.b'.
        const get = makeGetter({ 'a.b': 'literal-value' });
        expect(resolveVarPath(get, 'a.b')).toBe('literal-value');
    });

    test('literal dotted key falls back when head exists but is plain string', () => {
        // 'name' is the string 'Alice', JSON.parse('Alice') throws, fallback
        // to literal lookup of 'name.first'.
        const get = makeGetter({ name: 'Alice', 'name.first': 'fallback' });
        expect(resolveVarPath(get, 'name.first')).toBe('fallback');
    });

    test('dotted path takes precedence over literal when both could apply', () => {
        // Both 'a' (parseable) and 'a.b' (literal) are set. The dotted
        // interpretation wins because parse succeeds — this is the
        // documented "objects shadow flat dotted keys" semantics.
        const get = makeGetter({ a: '{"b":99}', 'a.b': 'shadowed' });
        expect(resolveVarPath(get, 'a.b')).toBe(99);
    });

    test('numeric-stored head value yields undefined when walked into', () => {
        // 'count' is the number 42 (stored as the string '42', coerced by
        // getter). JSON.parse('42') succeeds with the number 42; walking
        // into a number with .anything yields undefined.
        const get = makeGetter({ count: '42' });
        expect(resolveVarPath(get, 'count.foo')).toBeUndefined();
    });

    test('non-string name is passed through to getter unchanged', () => {
        const get = (n) => `got:${n}`;
        // The helper should not crash on weird input; it falls through to
        // the getter for anything that is not a dotted string.
        expect(resolveVarPath(get, '')).toBe('got:');
        expect(resolveVarPath(get, undefined)).toBe('got:undefined');
    });

    test('head value that is already a parsed object is walked directly', () => {
        // Some callers (e.g. STscript /setvar with as=object) may store a
        // live object. The helper handles this without a JSON.parse round-trip.
        const liveObjects = { cfg: { feature: { enabled: true } } };
        const get = (name) => liveObjects[name] ?? '';
        expect(resolveVarPath(get, 'cfg.feature.enabled')).toBe(true);
    });

    test('empty path segments gracefully yield undefined', () => {
        // 'npcs.' splits to ['npcs', ''], walking with empty key in JSON
        // object returns undefined.
        const get = makeGetter({ npcs: '{"alice":{"hp":50}}' });
        expect(resolveVarPath(get, 'npcs.')).toBeUndefined();
    });
});
