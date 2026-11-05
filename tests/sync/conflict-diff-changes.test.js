import { describe, test, expect } from '@jest/globals';

import { collectChanges, MISSING } from '../../src/sync/conflict-diff/changes.js';

const childByKey = (change, key) => change.children.find(child => String(child.key) === String(key));

describe('collectChanges', () => {
    test('reports a changed object field', () => {
        const change = collectChanges({ a: 1 }, { a: 2 });
        expect(change).toMatchObject({ type: 'object', status: 'changed' });
        expect(change.children).toHaveLength(1);
        expect(change.children[0]).toMatchObject({ type: 'field', key: 'a', status: 'changed', before: 1, after: 2 });
    });

    test('returns null when objects are equal', () => {
        expect(collectChanges({ a: [1, 2] }, { a: [1, 2] })).toBeNull();
    });

    test('aligns objects by identifier and keeps only changed entries', () => {
        const left = [
            { identifier: 'a', name: 'A', content: 'one' },
            { identifier: 'b', name: 'B', content: 'two' },
        ];
        const right = [
            { identifier: 'a', name: 'A', content: 'ONE' },
            { identifier: 'b', name: 'B', content: 'two' },
        ];
        const change = collectChanges(left, right, { path: 'prompts', idFields: ['identifier'] });
        expect(change.type).toBe('array');
        expect(change.children).toHaveLength(1);
        expect(change.children[0]).toMatchObject({ type: 'item', key: 'a', status: 'changed' });
        expect(change.children[0].children[0]).toMatchObject({ key: 'content', before: 'one', after: 'ONE' });
    });

    test('falls back to positional comparison for duplicate ids', () => {
        const left = [{ id: 'x', value: 1 }, { id: 'x', value: 2 }];
        const right = [{ id: 'x', value: 1 }, { id: 'x', value: 3 }];
        const change = collectChanges(left, right, { idFields: ['id'] });
        expect(change.children.map(child => child.key)).toEqual([1]);
        expect(change.children[0].children[0]).toMatchObject({ key: 'value', before: 2, after: 3 });
    });

    test('falls back to positional comparison when an id is missing', () => {
        const left = [{ id: 'x', value: 1 }, { value: 2 }];
        const right = [{ id: 'x', value: 1 }, { value: 3 }];
        const change = collectChanges(left, right, { idFields: ['id'] });
        expect(change.children.map(child => child.key)).toEqual([1]);
        expect(change.children[0]).toMatchObject({ type: 'item', status: 'changed' });
    });

    test('reports a moved only entry', () => {
        const left = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const right = [{ id: 'b' }, { id: 'c' }, { id: 'a' }];
        const change = collectChanges(left, right, { idFields: ['id'] });
        const moved = childByKey(change, 'a');
        expect(moved).toMatchObject({ type: 'item', status: 'moved', move: { from: 1, to: 3 } });
        expect(moved.children ?? []).toHaveLength(0);
    });

    test('does not report a move for an insertion', () => {
        const left = [{ id: 'a' }, { id: 'b' }];
        const right = [{ id: 'a' }, { id: 'x' }, { id: 'b' }];
        const change = collectChanges(left, right, { idFields: ['id'] });
        expect(change.children.map(child => [child.key, child.status])).toEqual([
            ['x', 'added'],
        ]);
        expect(change.children.some(child => child.move)).toBe(false);
    });

    test('reports a move together with field changes', () => {
        const left = [{ id: 'a', value: 1 }, { id: 'b', value: 2 }];
        const right = [{ id: 'b', value: 2 }, { id: 'a', value: 9 }];
        const change = collectChanges(left, right, { idFields: ['id'] });
        const moved = childByKey(change, 'a');
        expect(moved).toMatchObject({ type: 'item', status: 'changed', move: { from: 1, to: 2 } });
        expect(moved.children[0]).toMatchObject({ key: 'value', before: 1, after: 9 });
    });

    test('compares primitive arrays as one value', () => {
        const change = collectChanges(['a', 'b'], ['a', 'b', 'c']);
        expect(change).toMatchObject({ type: 'field', status: 'changed', before: ['a', 'b'], after: ['a', 'b', 'c'] });
    });

    test('keeps an added object whole with added field children', () => {
        const change = collectChanges({}, { created: { a: 1, b: 2 } });
        const created = childByKey(change, 'created');
        expect(created).toMatchObject({ type: 'object', key: 'created', status: 'added' });
        expect(created.children).toHaveLength(2);
        expect(created.children.every(child => child.status === 'added')).toBe(true);
    });

    test('builds an added root object from MISSING', () => {
        const change = collectChanges(MISSING, { a: 1 });
        expect(change).toMatchObject({ type: 'object', status: 'added' });
        expect(change.children[0]).toMatchObject({ key: 'a', status: 'added', after: 1 });
        expect(change).not.toHaveProperty('before');
    });

    test('builds an added array of objects from MISSING', () => {
        const change = collectChanges(MISSING, [{ id: 'a', value: 1 }], { idFields: ['id'] });
        expect(change).toMatchObject({ type: 'array', status: 'added' });
        expect(change.children[0]).toMatchObject({ type: 'item', key: 'a', status: 'added' });
        expect(childByKey(change.children[0], 'value')).toMatchObject({ status: 'added', after: 1 });
    });
});
