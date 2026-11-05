import { describe, test, expect } from '@jest/globals';

import { normalizeWorldBook, renderWorldBook } from '../../src/sync/conflict-diff/worldbook.js';
import { createBuilder } from '../../src/sync/conflict-diff/tree.js';

const entry = (uid, displayIndex, comment, content, extra = {}) => ({
    uid,
    displayIndex,
    comment,
    content,
    key: [`keyword ${uid}`],
    keysecondary: [],
    disable: false,
    ...extra,
});

const book = entries => ({ entries });

function build(left, right) {
    const builder = createBuilder();
    const sections = renderWorldBook(left, right, builder);
    return builder.finalize(sections);
}

const section = (sections, label) => sections.find(item => item.label === label);
const item = (parent, label) => parent.children.find(child => child.label === label);

describe('world book conflict renderer', () => {
    test('normalizes object and array entry maps and sorts by displayIndex', () => {
        const fromObject = normalizeWorldBook({ entries: { a: entry(1, 30, 'Third', ''), b: entry(2, 10, 'First', ''), c: entry(3, 20, 'Second', '') } });
        const fromArray = normalizeWorldBook(book([entry(1, 30, 'Third', ''), entry(2, 10, 'First', ''), entry(3, 20, 'Second', '')]));
        expect(fromObject.entries.map(item => item.uid)).toEqual([2, 3, 1]);
        expect(fromArray.entries.map(item => item.uid)).toEqual([2, 3, 1]);
    });

    test('groups changed entries by uid and labels them by comment', () => {
        const left = book([entry(1, 10, 'Alpha', 'A'), entry(2, 20, 'Beta', 'B'), entry(3, 30, 'Gamma', 'C')]);
        const right = book([entry(1, 10, 'Alpha', 'A changed'), entry(2, 20, 'Beta', 'B'), entry(3, 30, 'Gamma', 'C')]);
        const { sections, values } = build(left, right);
        const entries = section(sections, 'Entries');
        expect(entries.children).toHaveLength(1);
        const alpha = item(entries, 'Alpha');
        expect(alpha).toMatchObject({ type: 'item', status: 'changed', translateLabel: false });
        const content = item(alpha, 'Content');
        expect(content).toMatchObject({ type: 'field', value: { kind: 'scalar' } });
        expect(values.get(content.id)()).toEqual({ mode: 'cells', before: 'A', after: 'A changed' });
        expect(alpha.children.map(child => child.label)).not.toContain('UID');
        expect(alpha.children.map(child => child.label)).not.toContain('Display index');
    });

    test('falls back to the first content line and then the uid', () => {
        const left = book([entry(1, 10, '', 'First line\nSecond line')]);
        const right = book([entry(1, 10, '', 'First line changed\nSecond line')]);
        const { sections } = build(left, right);
        expect(section(sections, 'Entries').children[0].label).toBe('First line changed');
    });

    test('reports a reorder as a move and a renumbering as nothing', () => {
        const left = book([entry(1, 10, 'Alpha', 'A'), entry(2, 20, 'Beta', 'B'), entry(3, 30, 'Gamma', 'C')]);
        const renumbered = book([entry(1, 110, 'Alpha', 'A'), entry(2, 120, 'Beta', 'B'), entry(3, 130, 'Gamma', 'C')]);
        expect(build(left, renumbered).sections).toEqual([]);

        const swapped = book([entry(1, 20, 'Alpha', 'A'), entry(2, 10, 'Beta', 'B'), entry(3, 30, 'Gamma', 'C')]);
        const { sections } = build(left, swapped);
        const entries = section(sections, 'Entries');
        const moved = entries.children.find(child => child.meta?.move);
        expect(moved).toBeTruthy();
        expect(moved.meta.move).toEqual({ from: 1, to: 2 });
    });

    test('keeps added and removed entries as expandable entries', () => {
        const left = book([entry(1, 10, 'Alpha', 'A'), entry(2, 20, 'Beta', 'B')]);
        const right = book([entry(1, 10, 'Alpha', 'A'), entry(3, 30, 'Gamma', 'C')]);
        const { sections, values } = build(left, right);
        const entries = section(sections, 'Entries');
        expect(entries.children.map(child => [child.label, child.status]).sort()).toEqual([
            ['Beta', 'removed'],
            ['Gamma', 'added'],
        ]);
        const gamma = item(entries, 'Gamma');
        const content = item(gamma, 'Content');
        expect(values.get(content.id)()).toMatchObject({ mode: 'cells', after: 'C' });
    });
});
