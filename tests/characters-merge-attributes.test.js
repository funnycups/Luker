import { describe, test, expect } from '@jest/globals';
import { validateReplacePaths, applyReplacePaths } from '../src/endpoints/characters.js';

describe('validateReplacePaths', () => {
    test('accepts an empty array', () => {
        expect(validateReplacePaths([])).toEqual({ ok: true, paths: [] });
    });

    test('accepts undefined / non-array as no-op', () => {
        expect(validateReplacePaths(undefined)).toEqual({ ok: true, paths: [] });
        expect(validateReplacePaths(null)).toEqual({ ok: true, paths: [] });
        expect(validateReplacePaths('data.extensions.foo')).toEqual({ ok: true, paths: [] });
    });

    test('accepts a single valid extension key path', () => {
        expect(validateReplacePaths(['data.extensions.foo'])).toEqual({
            ok: true,
            paths: ['data.extensions.foo'],
        });
    });

    test('accepts a nested extension key path', () => {
        expect(validateReplacePaths(['data.extensions.foo.bar'])).toEqual({
            ok: true,
            paths: ['data.extensions.foo.bar'],
        });
    });

    test('rejects a non-extension root path', () => {
        const result = validateReplacePaths(['data.name']);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/data\.extensions\./);
    });

    test('rejects the bare data.extensions prefix with no trailing segment', () => {
        const result = validateReplacePaths(['data.extensions']);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/segment/i);
    });

    test('rejects data.extensions. with empty trailing segment', () => {
        const result = validateReplacePaths(['data.extensions.']);
        expect(result.ok).toBe(false);
    });

    test('rejects non-string entries', () => {
        const result = validateReplacePaths(['data.extensions.foo', 42]);
        expect(result.ok).toBe(false);
    });

    test('rejects paths attempting to escape via traversal', () => {
        // Even though _.set would create literal keys, a path like
        // 'data.extensions..foo' is nonsense and must not be accepted.
        const result = validateReplacePaths(['data.extensions..foo']);
        expect(result.ok).toBe(false);
    });
});

describe('applyReplacePaths', () => {
    test('replaces a top-level extension key wholesale (drops stale siblings)', () => {
        const character = {
            data: { extensions: { my_plugin: { a: 1, b: 2, c: 3 } } },
        };
        const update = {
            data: { extensions: { my_plugin: { a: 9 } } },
        };
        applyReplacePaths(character, update, ['data.extensions.my_plugin']);
        expect(character.data.extensions.my_plugin).toEqual({ a: 9 });
        // path was lifted out of the update payload so subsequent deepMerge
        // does not re-introduce the stale siblings
        expect(update.data.extensions.my_plugin).toBeUndefined();
    });

    test('UNSET sentinel deletes the targeted key', () => {
        const character = {
            data: { extensions: { my_plugin: { a: 1 } }, name: 'X' },
        };
        const update = {
            data: { extensions: { my_plugin: '__@@UNSET@@__' } },
        };
        applyReplacePaths(character, update, ['data.extensions.my_plugin']);
        expect(character.data.extensions).not.toHaveProperty('my_plugin');
        expect(character.data.name).toBe('X');
        expect(update.data.extensions.my_plugin).toBeUndefined();
    });

    test('replacing an absent key is equivalent to setting it for the first time', () => {
        const character = { data: { extensions: {} } };
        const update = {
            data: { extensions: { newcomer: { level: 5 } } },
        };
        applyReplacePaths(character, update, ['data.extensions.newcomer']);
        expect(character.data.extensions.newcomer).toEqual({ level: 5 });
    });

    test('does not touch sibling extension keys', () => {
        const character = {
            data: { extensions: { kept: { z: 1 }, target: { old: true } } },
        };
        const update = {
            data: { extensions: { target: { fresh: true } } },
        };
        applyReplacePaths(character, update, ['data.extensions.target']);
        expect(character.data.extensions.kept).toEqual({ z: 1 });
        expect(character.data.extensions.target).toEqual({ fresh: true });
    });

    test('skips paths whose value is absent from the update payload', () => {
        const character = {
            data: { extensions: { keep_me: { v: 1 } } },
        };
        const update = { data: { extensions: {} } };
        applyReplacePaths(character, update, ['data.extensions.keep_me']);
        // The update did not specify keep_me, so the path is a no-op:
        // existing on-disk value is preserved.
        expect(character.data.extensions.keep_me).toEqual({ v: 1 });
    });

    test('handles nested extension paths (e.g. data.extensions.foo.bar)', () => {
        const character = {
            data: { extensions: { foo: { bar: { old: 1 }, keep: 2 } } },
        };
        const update = {
            data: { extensions: { foo: { bar: { fresh: 1 } } } },
        };
        applyReplacePaths(character, update, ['data.extensions.foo.bar']);
        // The nested replace replaces bar wholesale but leaves the sibling
        // `keep` under foo untouched, because the lift removed only `bar`
        // from the update payload — `foo.keep` was never in the update.
        expect(character.data.extensions.foo).toEqual({ bar: { fresh: 1 }, keep: 2 });
        expect(update.data.extensions.foo.bar).toBeUndefined();
    });
});

describe('mergeCharacterUpdate (replace + merge interplay) — pure simulation', () => {
    // We simulate what the endpoint does to a loaded character object:
    //   1. applyReplacePaths
    //   2. deepMerge
    //   3. processUnsetSentinels
    // This mirrors the order in mergeCharacterUpdate without booting Express.
    // If this passes and the helpers themselves pass, the wiring is correct.

    test('replacePaths + deepMerge coexist (form-level fields still merge)', async () => {
        const { deepMerge } = await import('../src/util.js');
        const character = {
            data: {
                name: 'Original',
                description: 'old desc',
                extensions: { plugin_a: { a: 1, b: 2 } },
            },
        };
        const update = {
            data: {
                description: 'new desc',
                extensions: { plugin_a: { a: 9 } },
            },
        };
        applyReplacePaths(character, update, ['data.extensions.plugin_a']);
        const merged = deepMerge(character, update);
        // plugin_a was replaced wholesale (no stale `b`)
        expect(merged.data.extensions.plugin_a).toEqual({ a: 9 });
        // description still merges through deepMerge
        expect(merged.data.description).toBe('new desc');
        // name was untouched
        expect(merged.data.name).toBe('Original');
    });
});
