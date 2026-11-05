import { describe, test, expect } from '@jest/globals';

import { createBuilder } from '../../src/sync/conflict-diff/tree.js';

describe('conflict view tree', () => {
    test('assigns stable ids and counts direct changes and leaves', () => {
        const builder = createBuilder();
        const prompts = builder.section({
            label: 'Prompts',
            children: [
                builder.item({
                    label: 'A',
                    translateLabel: false,
                    children: [
                        builder.field({ label: 'Content', status: 'changed', before: 'one\ntwo', after: 'one\nthree' }),
                        builder.field({ label: 'Depth', status: 'changed', before: 1, after: 2 }),
                    ],
                }),
                builder.item({ label: 'B', translateLabel: false, status: 'moved', move: { from: 1, to: 2 }, children: [] }),
            ],
        });
        const { sections, values } = builder.finalize([prompts]);
        expect(sections).toHaveLength(1);
        expect(sections[0].id).toBe('0');
        expect(sections[0].meta).toMatchObject({ changed: 2, leaves: 3 });
        expect(sections[0].children[0].id).toBe('1');
        expect(sections[0].children[0].meta).toMatchObject({ changed: 2, leaves: 2 });
        expect(sections[0].children[1]).toMatchObject({ id: '4', status: 'moved', meta: { changed: 1, leaves: 1, move: { from: 1, to: 2 } } });
        expect(sections[0].children[1]).not.toHaveProperty('value');
        expect(values.get('2')()).toMatchObject({ mode: 'lines' });
        expect(values.get('3')()).toEqual({ mode: 'cells', before: '1', after: '2' });
        expect(values.has('4')).toBe(false);
    });

    test('drops empty sections and unchanged items', () => {
        const builder = createBuilder();
        const empty = builder.section({
            label: 'Empty',
            children: [builder.section({ label: 'Nested', children: [] })],
        });
        const unchanged = builder.item({ label: 'A', status: 'changed', children: [] });
        const { sections } = builder.finalize([empty, unchanged]);
        expect(sections).toEqual([]);
    });

    test('keeps an added empty object as one change', () => {
        const builder = createBuilder();
        const added = builder.item({ label: 'New entry', translateLabel: false, status: 'added', children: [] });
        const { sections } = builder.finalize([builder.section({ label: 'Entries', children: [added] })]);
        expect(sections[0].children[0].meta).toMatchObject({ changed: 1, leaves: 1 });
    });

    test('builds the same ids for the same tree', () => {
        const build = () => {
            const builder = createBuilder();
            const tree = builder.section({
                label: 'Entries',
                children: [builder.item({ label: 'A', children: [builder.field({ label: 'Content', status: 'changed', before: 'a', after: 'b' })] })],
            });
            return builder.finalize([tree]).sections;
        };
        expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
    });

    test('marks a line hunk and resolves its rows', () => {
        const builder = createBuilder();
        const rows = [
            { kind: 'removed', text: 'old', leftLine: 4 },
            { kind: 'added', text: 'new', rightLine: 4 },
        ];
        const hunk = builder.lines({ label: 'Lines', status: 'changed', lines: { from: 4, to: 4 }, rows });
        const { sections, values } = builder.finalize([builder.section({ label: 'Changes', children: [hunk] })]);
        expect(sections[0].children[0]).toMatchObject({ type: 'field', value: { kind: 'lines' }, meta: { lines: { from: 4, to: 4 } } });
        expect(values.get(sections[0].children[0].id)()).toEqual({ mode: 'lines', rows });
    });
});
