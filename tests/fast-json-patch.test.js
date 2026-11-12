import { describe, expect, test } from '@jest/globals';

import { applyPatch, compare } from '../public/scripts/util/fast-json-patch.js';

describe('JSON Patch shared references', () => {
    test('projects a shared array into an additional property', () => {
        const tags = ['navigation', 'coastal'];
        const before = { data: { tags } };
        const after = { data: { tags }, tags };

        const patch = compare(before, after);

        expect(patch).toEqual([
            { op: 'add', path: '/tags', value: ['navigation', 'coastal'] },
        ]);
        expect(applyPatch(before, patch).newDocument).toEqual({
            data: { tags: ['navigation', 'coastal'] },
            tags: ['navigation', 'coastal'],
        });
    });

    test('treats shared source values as equal to independent JSON copies', () => {
        const shared = { enabled: true };
        const before = { first: shared, second: shared };
        const after = { first: { enabled: true }, second: { enabled: true } };

        expect(compare(before, after)).toEqual([]);
    });

    test('preserves repeated objects in array positions', () => {
        const shared = { content: 'The lantern marks the safe passage.' };
        const after = { entries: [shared, shared] };

        const patch = compare({ entries: [] }, after);

        expect(patch).toEqual([
            { op: 'add', path: '/entries/0', value: { content: 'The lantern marks the safe passage.' } },
            { op: 'add', path: '/entries/1', value: { content: 'The lantern marks the safe passage.' } },
        ]);
    });

    test('preserves aliases when cloning a patch value containing a function', () => {
        const shared = ['navigation'];
        const value = { first: shared, second: shared, callback() {} };

        const result = applyPatch({}, [{ op: 'add', path: '/value', value }]).newDocument;

        expect(result).toEqual({ value: { first: ['navigation'], second: ['navigation'] } });
        expect(result.value.first).not.toBe(shared);
        expect(result.value.second).not.toBe(shared);
    });

    test.each(['source', 'target'])('rejects a true cycle in the %s instead of dropping data', side => {
        const cyclic = { name: 'root' };
        cyclic.self = cyclic;

        expect(() => compare(side === 'source' ? cyclic : {}, side === 'target' ? cyclic : {}))
            .toThrow(TypeError);
    });
});
