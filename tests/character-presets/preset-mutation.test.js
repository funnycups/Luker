import { describe, test, expect } from '@jest/globals';
import { createPresetLineage, preparePresetMutation } from '../../public/scripts/character/preset-mutation.js';

describe('conditional preset mutation', () => {
    test.each(['watch.value', ''])('same-value ownership cannot bypass unchanged ancestors for %j', ownedPath => {
        const before = { extensions: { watch: { value: 1 } } };
        const current = { extensions: { watch: { value: 2 } } };
        const ownedValue = ownedPath === '' ? before.extensions : 1;
        expect(() => preparePresetMutation(before, before, current, { ownedPath, ownedValue })).toThrow('source conflict');
        expect(preparePresetMutation(before, before, before, { ownedPath, ownedValue })).toEqual(before);
    });
    test('an empty public array path leaves extensions and unrelated current edits intact', () => {
        const before = { temperature: 0.23, extensions: { retained: 'preset', watch: { value: 1 } } };
        const current = { ...before, extensions: { ...before.extensions, watch: { value: 2 } }, later: true };
        expect(preparePresetMutation(before, before, before, { ownedPath: [], ownedValue: { replacement: true } })).toEqual(before);
        expect(preparePresetMutation(before, before, current, { ownedPath: [], ownedValue: { replacement: true } })).toEqual(current);
    });
    test('an empty public array path still applies and checks carried acknowledged deltas', () => {
        const before = { temperature: 0.23, extensions: { retained: 'preset', watch: { value: 1 } } };
        const desired = { temperature: 0.61, extensions: { retained: 'preset', watch: { value: 1, carried: 'acknowledged' } } };
        const current = { ...before, extensions: { ...before.extensions, watch: { value: 2 } } };
        expect(preparePresetMutation(before, desired, current, { ownedPath: [], ownedValue: { replacement: true } })).toEqual({ temperature: 0.61, extensions: { retained: 'preset', watch: { value: 2, carried: 'acknowledged' } } });
        expect(() => preparePresetMutation(before, desired, { ...before, temperature: 0.88 }, { ownedPath: [], ownedValue: { replacement: true } })).toThrow('source conflict at /temperature');
    });
    test('an empty string explicitly replaces the extensions root', () => {
        const before = { temperature: 0.23, extensions: { retained: 'preset', watch: { value: 1 } } };
        expect(preparePresetMutation(before, before, before, { ownedPath: '', ownedValue: { replacement: true } })).toEqual({ temperature: 0.23, extensions: { replacement: true } });
    });
    test.each(['items[0].enabled', ['items', '0', 'enabled']])('indexed ownership prepares the whole intended array for %j', ownedPath => {
        const before = { extensions: { items: [{ enabled: false, retained: true }] }, sibling: 1 };
        const desired = { extensions: { items: [{ enabled: true, retained: true }] }, sibling: 1 };
        expect(preparePresetMutation(before, desired, { ...before, sibling: 2 }, { ownedPath, ownedValue: true })).toEqual({ ...desired, sibling: 2 });
        expect(() => preparePresetMutation(before, desired, { ...before, extensions: { items: [{ enabled: false, retained: true }, { later: true }] } }, { ownedPath, ownedValue: true })).toThrow('source conflict');
    });
    test('same-value ownership checks an unchanged subtree beneath a changed sampler', () => {
        const before = { temperature: 0.23, extensions: { watch: { value: 1 } } };
        const desired = { ...before, temperature: 0.61 };
        expect(() => preparePresetMutation(before, desired, { ...before, extensions: { watch: { value: 2 } } }, { ownedPath: 'watch.value', ownedValue: 1 })).toThrow('source conflict');
        expect(preparePresetMutation(before, desired, { ...before, extensions: { watch: { value: 1, later: true } } }, { ownedPath: 'watch.value', ownedValue: 1 })).toEqual({ temperature: 0.61, extensions: { watch: { value: 1, later: true } } });
    });
    test('owned objects replace rather than merge with competing descendants', () => {
        const before = { extensions: { watch: { a: 1 } } };
        const desired = { extensions: { watch: { a: 2 } } };
        const current = { extensions: { watch: { a: 1, later: true } } };
        expect(() => preparePresetMutation(before, desired, current, { ownedPath: 'watch', ownedValue: { a: 2 } })).toThrow('source conflict');
        expect(preparePresetMutation(before, desired, before, { ownedPath: 'watch', ownedValue: { a: 2 } })).toEqual(desired);
    });
    test('materializes indexed ownership without requiring desired to contain the edit', () => {
        const before = { extensions: { items: [{ enabled: false, retained: true }] } };
        expect(preparePresetMutation(before, before, before, { ownedPath: ['items', 0, 'enabled'], ownedValue: true })).toEqual({ extensions: { items: [{ enabled: true, retained: true }] } });
    });
    test.each(['watch.value', 'items[0].enabled'])('preserves an existing literal lodash key %s', ownedPath => {
        const before = { extensions: { [ownedPath]: 1, watch: { retained: true }, items: [{ enabled: false }] } };
        const desired = { extensions: { ...before.extensions, [ownedPath]: 2 } };
        expect(preparePresetMutation(before, desired, before, { ownedPath, ownedValue: 2 })).toEqual(desired);
        expect(() => preparePresetMutation(before, before, { extensions: { ...before.extensions, [ownedPath]: 3 } }, { ownedPath, ownedValue: 1 })).toThrow('source conflict');
    });
    test('array-form paths remain indexed when a matching literal bracket key exists', () => {
        const before = { extensions: { 'items[0].enabled': false, items: [{ enabled: false }] } };
        expect(preparePresetMutation(before, before, before, { ownedPath: ['items', 0, 'enabled'], ownedValue: true })).toEqual({ extensions: { 'items[0].enabled': false, items: [{ enabled: true }] } });
    });
    test('unchanged ordinary state preserves drift and explicit absence remains distinct from undefined', () => {
        const before = { extensions: { watch: {} } };
        const current = { extensions: { watch: { later: true } } };
        expect(preparePresetMutation(before, before, current)).toEqual(current);
        const result = preparePresetMutation(before, before, current, { ownedPath: 'watch.value', ownedValue: undefined });
        expect(result).toEqual({ extensions: { watch: { later: true, value: undefined } } });
        expect(Object.hasOwn(result.extensions.watch, 'value')).toBe(true);
        expect(result.extensions.watch.value).toBeUndefined();
        expect(() => preparePresetMutation(before, before, { extensions: { watch: { value: undefined } } }, { ownedPath: 'watch.value', ownedValue: undefined })).toThrow('source conflict');
    });
    test.each(['__proto__.polluted', 'safe[constructor].polluted', ['safe', 'prototype', 'polluted']])('refuses unsafe owned paths %j', ownedPath => {
        expect(() => preparePresetMutation({}, {}, {}, { ownedPath, ownedValue: true })).toThrow('Invalid preset extension path');
        expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    });
    test('refuses changed old values and absent object additions', () => {
        expect(() => preparePresetMutation({ temperature: 0.23 }, { temperature: 0.61 }, { temperature: 0.88 })).toThrow('source conflict');
        expect(() => preparePresetMutation({ extensions: {} }, { extensions: { watch: { a: 1 } } }, { extensions: { watch: { later: true } } })).toThrow('source conflict');
    });
    test('arrays are atomic and disjoint siblings survive', () => {
        expect(() => preparePresetMutation({ order: ['a'] }, { order: ['a', 'b'] }, { order: ['later', 'a'] })).toThrow('source conflict');
        expect(preparePresetMutation({ a: 1, order: ['a'] }, { a: 2, order: ['a'] }, { a: 1, order: ['later'], retained: true })).toEqual({ a: 2, order: ['later'], retained: true });
    });
    test('identical desired values require acknowledged ownership', () => {
        expect(() => preparePresetMutation({ a: 1 }, { a: 2 }, { a: 2 })).toThrow('source conflict');
        expect(preparePresetMutation({ a: 1 }, { a: 2 }, { a: 2 }, { acknowledged: true })).toEqual({ a: 2 });
    });
    test('nested ownership retains unrelated acknowledged extension changes', () => {
        expect(preparePresetMutation({ extensions: { groups: [], watch: {} } }, { extensions: { groups: ['a'], watch: { value: 2 } } }, { extensions: { groups: [], watch: { later: true } } }, { ownedPath: 'watch.value', ownedValue: 2 })).toEqual({ extensions: { groups: ['a'], watch: { later: true, value: 2 } } });
    });
    test('lineage identity is payload-free and preserves late successor ownership', () => {
        const lineage = createPresetLineage();
        const first = { body: 'first' };
        const identity = lineage.capture(first);
        const next = { body: 'next' };
        lineage.acknowledge(next, identity);
        expect(Reflect.ownKeys(identity)).toEqual([]);
        expect(lineage.owns(next, identity)).toBe(true);
        expect(lineage.owns({ body: 'next' }, identity)).toBe(false);
        expect(lineage.capture(next)).toBe(identity);
    });
});
