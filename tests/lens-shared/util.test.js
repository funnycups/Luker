import { describe, test, expect, beforeAll } from '@jest/globals';

import {
    formatDuration,
    formatTime,
    formatTokens,
    hashString,
    initialOf,
    relativeTime,
    truncate,
} from '../../public/scripts/extensions/lens-shared/util.js';
import { registerLensSharedLocaleData } from '../../public/scripts/extensions/lens-shared/locale-data.js';

const table = {};

beforeAll(() => {
    globalThis.Luker = { getContext: () => ({ translate: (text) => table[text] ?? text }) };
});

describe('lens-shared util', () => {
    test('formatTime includes seconds unless told otherwise', () => {
        const date = new Date(2026, 0, 2, 3, 4, 5);
        expect(formatTime(date)).toBe('03:04:05');
        expect(formatTime(date, { seconds: false })).toBe('03:04');
        expect(formatTime('not a date')).toBe('');
    });

    test('formatTokens scales', () => {
        expect(formatTokens(950)).toBe('950');
        expect(formatTokens(1234)).toBe('1.2k');
        expect(formatTokens(15300)).toBe('15k');
        expect(formatTokens(2400000)).toBe('2.4M');
    });

    test('formatDuration', () => {
        expect(formatDuration(250)).toBe('250ms');
        expect(formatDuration(1500)).toBe('1.5s');
        expect(formatDuration(-1)).toBe('—');
    });

    test('hashString is stable and initialOf upper-cases', () => {
        expect(hashString('abc')).toBe(hashString('abc'));
        expect(hashString('abc')).not.toBe(hashString('abd'));
        expect(initialOf('  zoe')).toBe('Z');
        expect(initialOf('')).toBe('?');
        expect(truncate('abcdef', 4)).toBe('abc…');
    });

    test('relativeTime speaks the active locale', () => {
        const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
        expect(relativeTime(now - 1000, now)).toBe('just now');
        expect(relativeTime(now - 5 * 60e3, now)).toBe('5 min ago');
        expect(relativeTime(0, now)).toBe('');
        registerLensSharedLocaleData((locale, data) => { if (locale === 'zh-cn') Object.assign(table, data); });
        expect(relativeTime(now - 5 * 60e3, now)).toBe('5 分钟前');
        expect(relativeTime(now - 3 * 86400e3, now)).toBe('3 天前');
    });
});
