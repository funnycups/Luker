import './_mocks/luker-zh.js';
import { test, expect } from '@jest/globals';
import { formatTokens } from '../../../public/scripts/extensions/lens-shared/util.js';
import { addEntry, summarize } from '../../../public/scripts/extensions/memory-graph/lens/token-stats.js';

test('same floor replaces, new floor appends, list is capped', () => {
    let list = addEntry([], { at: 1, floor: 4, core: 10, focus: 20 });
    list = addEntry(list, { at: 2, floor: 4, core: 10, focus: 50 });
    expect(list.length).toBe(1);
    expect(list[0].focus).toBe(50);
    list = addEntry(list, { at: 3, floor: 6, core: 10, focus: 5 });
    expect(list.length).toBe(2);
    let many = [];
    for (let i = 0; i < 10; i++) many = addEntry(many, { at: i, floor: i, core: 1, focus: 1 }, 4);
    expect(many.map(e => e.floor)).toEqual([6, 7, 8, 9]);
});

test('summary totals and averages', () => {
    const s = summarize([{ core: 100, focus: 200 }, { core: 100, focus: 0 }]);
    expect(s).toEqual({ count: 2, total: 400, avg: 200, max: 300, avgFocus: 100, avgCore: 100 });
    expect(summarize([]).avg).toBe(0);
});

test('formatTokens', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(2000)).toBe('2k');
    expect(formatTokens(15300)).toBe('15k');
    expect(formatTokens(2400000)).toBe('2.4M');
});
