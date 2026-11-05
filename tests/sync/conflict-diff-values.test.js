import { describe, test, expect } from '@jest/globals';

import {
    MAX_CELL_CHARS,
    MAX_LINE_ROWS,
    cellPage,
    lineHunks,
    lineRows,
    pageLines,
    valueMeta,
    withContext,
} from '../../src/sync/conflict-diff/values.js';

describe('conflict diff values', () => {
    test('cuts a cell to the display bound and reports the next offset', () => {
        const page = cellPage('x'.repeat(10_000), 0);
        expect(page.text).toHaveLength(MAX_CELL_CHARS);
        expect(page.chars).toBe(10_000);
        expect(page.bytes).toBe(10_000);
        expect(page.nextOffset).toBe(MAX_CELL_CHARS);
        expect(page.missing).toBe(false);
    });

    test('keeps a surrogate pair on the same page', () => {
        const text = `${'a'.repeat(MAX_CELL_CHARS - 1)}😀${'b'.repeat(10)}`;
        const page = cellPage(text, 0);
        expect(page.text).toHaveLength(MAX_CELL_CHARS + 1);
        expect(page.text.endsWith('😀')).toBe(true);
        expect(page.nextOffset).toBe(MAX_CELL_CHARS + 1);
    });

    test('stops at the end of the value', () => {
        const page = cellPage('abc', 0);
        expect(page).toMatchObject({ text: 'abc', chars: 3, bytes: 3, nextOffset: null, missing: false });
        expect(cellPage('abc', 3)).toMatchObject({ text: '', nextOffset: null });
    });

    test('marks a missing side', () => {
        expect(cellPage(undefined, 0)).toMatchObject({ text: '', chars: 0, bytes: 0, missing: true, nextOffset: null });
    });

    test('chooses a line diff only for multi-line strings', () => {
        expect(valueMeta('one\ntwo', 'one\nthree')).toMatchObject({ kind: 'text' });
        expect(valueMeta('x'.repeat(600), 'y'.repeat(600))).toMatchObject({ kind: 'scalar' });
        expect(valueMeta(undefined, 'one\ntwo')).toMatchObject({
            kind: 'scalar',
            before: { missing: true, chars: 0 },
            after: { missing: false, chars: 7 },
        });
    });

    test('builds line rows with side-specific line numbers', () => {
        const rows = lineRows('a\nb\nc', 'a\nx\nc');
        expect(rows.map(row => [row.kind, row.leftLine, row.rightLine, row.text])).toEqual([
            ['context', 1, 1, 'a'],
            ['removed', 2, undefined, 'b'],
            ['added', undefined, 2, 'x'],
            ['context', 3, 3, 'c'],
        ]);
    });

    test('keeps three context lines and counts skipped rows', () => {
        const before = Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n');
        const after = before.replace('line 6', 'changed');
        const rows = withContext(lineRows(before, after));
        expect(rows[0]).toMatchObject({ kind: 'skipped', count: 3 });
        expect(rows.at(-1)).toMatchObject({ kind: 'skipped', count: 2 });
        expect(rows.filter(row => row.kind === 'removed')).toHaveLength(1);
        expect(rows.filter(row => row.kind === 'added')).toHaveLength(1);
        expect(rows.filter(row => row.kind === 'context').length).toBeGreaterThanOrEqual(6);
    });

    test('splits context-filtered rows into hunks', () => {
        const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
        const after = before.replace('line 2', 'changed two').replace('line 15', 'changed fifteen');
        const hunks = lineHunks(withContext(lineRows(before, after)));
        expect(hunks).toHaveLength(2);
        expect(hunks[0].lines.from).toBe(1);
        expect(hunks[1].lines.to).toBe(19);
        expect(hunks[0].rows.some(row => row.text === 'changed two')).toBe(true);
    });

    test('pages line rows and terminates', () => {
        const rows = Array.from({ length: 250 }, (_, index) => ({ kind: 'context', text: `line ${index}`, leftLine: index + 1, rightLine: index + 1 }));
        const first = pageLines(rows, 0);
        expect(first.rows).toHaveLength(MAX_LINE_ROWS);
        expect(first.rowTotal).toBe(250);
        expect(first.nextOffset).toBe(MAX_LINE_ROWS);
        const second = pageLines(rows, MAX_LINE_ROWS);
        expect(second.rows).toHaveLength(50);
        expect(second.nextOffset).toBeNull();
    });

    test('cuts an oversized line and reports its full size', () => {
        const rows = [{ kind: 'added', text: 'x'.repeat(10_000), rightLine: 1 }];
        const page = pageLines(rows, 0);
        expect(page.rows[0].text).toHaveLength(MAX_CELL_CHARS);
        expect(page.rows[0]).toMatchObject({ truncated: true, chars: 10_000, bytes: 10_000 });
    });
});
