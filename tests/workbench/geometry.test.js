// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect, beforeAll } from '@jest/globals';
import { defaultBox, clampBox, compactDefaultBox, clampCompactBox, maxBox, sheetBox, isCompactWidth, parseSavedBox, clampPill, MIN_W, MIN_COMPACT_W } from '../../public/scripts/workbench/model/geometry.js';
import { formatTokens, relativeTime, formatDuration } from '../../public/scripts/lens-shared/util.js';
import { registerLensSharedLocaleData } from '../../public/scripts/lens-shared/locale-data.js';
import { registerWorkbenchLocaleData } from '../../public/scripts/workbench/locale-data.js';

const zhTable = {
    'just now': '刚刚',
    '${0} min ago': '${0} 分钟前',
    '${0} hr ago': '${0} 小时前',
};

beforeAll(() => {
    registerLensSharedLocaleData((loc, data) => {
        if (loc === 'zh-cn') Object.assign(zhTable, data);
    });
    registerWorkbenchLocaleData((loc, data) => {
        if (loc === 'zh-cn') Object.assign(zhTable, data);
    });
    globalThis.Luker = {
        getContext: () => ({
            translate: (text) => zhTable[text] ?? text,
            getCurrentLocale: () => 'zh-cn',
        }),
    };
});

test('default box is centred and sized for viewport', () => {
    expect(defaultBox(1280, 800)).toEqual({ left: 160, top: 80, width: 960, height: 640 });
    const small = defaultBox(700, 500);
    expect(small.width).toBe(636);
    expect(small.left).toBeGreaterThanOrEqual(0);
});

test('clamp keeps the title bar reachable and size sane', () => {
    const b = clampBox({ left: 5000, top: -40, width: 100, height: 99999 }, 1280, 800);
    expect(b.width).toBe(MIN_W);
    expect(b.height).toBe(800);
    expect(b.left).toBe(1280 - 120);
    expect(b.top).toBe(0);
    expect(clampBox({ left: -9999, top: 0, width: 900, height: 500 }, 1280, 800).left).toBe(120 - 900);
});

test('max, sheet, compact, saved box', () => {
    expect(maxBox(1000, 700)).toEqual({ left: 10, top: 10, width: 980, height: 680 });
    const s = sheetBox(390, 844);
    expect(s.top + s.height).toBe(844);
    expect(isCompactWidth(390)).toBe(true);
    expect(isCompactWidth(1024)).toBe(false);
    expect(parseSavedBox({ left: 1 })).toBeNull();
    expect(parseSavedBox({ left: '1', top: 2, width: 3.4, height: 4 })).toEqual({ left: 1, top: 2, width: 3, height: 4 });

    const cf = compactDefaultBox(390, 844);
    expect(cf.left).toBe(12);
    expect(cf.width).toBe(366);
    expect(cf.top).toBeGreaterThanOrEqual(16);
    expect(cf.top + cf.height).toBeLessThan(844);

    const clamped = clampCompactBox({ left: 9000, top: -30, width: 100, height: 9000 }, 390, 844);
    expect(clamped.width).toBe(MIN_COMPACT_W);
    expect(clamped.height).toBe(844);
    expect(clamped.left).toBe(390 - 96);
    expect(clamped.top).toBe(0);
});

test('formatting helpers', () => {
    expect(formatTokens(32700)).toBe('33k');
    expect(formatTokens(7600)).toBe('7.6k');
    expect(formatDuration(31200)).toBe('31.2s');
    const now = new Date(2025, 5, 10, 15, 0).getTime();
    expect(relativeTime(now - 30e3, now)).toBe('刚刚');
    expect(relativeTime(now - 12 * 60e3, now)).toBe('12 分钟前');
    expect(relativeTime(new Date(2025, 5, 9, 23, 40).getTime(), now)).toMatch(/^昨天 23:40$/);
    expect(relativeTime(new Date(2025, 5, 7, 12).getTime(), now)).toBe('3 天前');
});

test('pill stays on screen', () => {
    expect(clampPill({ right: -50, bottom: 9999 }, 1280, 800, { width: 220, height: 42 })).toEqual({ right: 4, bottom: 754 });
    expect(clampPill({ right: 5000, bottom: 10 }, 390, 844, { width: 220, height: 42 })).toEqual({ right: 166, bottom: 10 });
});
