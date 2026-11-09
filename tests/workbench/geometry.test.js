import './_mocks/luker-zh.js';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { defaultBox, clampBox, maxBox, sheetBox, isCompactWidth, parseSavedBox, MIN_W } from '../../public/scripts/extensions/workbench/model/geometry.js';
import { formatTokens, relativeTime, formatDuration } from '../../public/scripts/extensions/lens-shared/util.js';

test('default box is centred and capped', () => {
    assert.deepEqual(defaultBox(1280, 800), { left: 160, top: 80, width: 960, height: 640 });
    const small = defaultBox(700, 500);
    assert.equal(small.width, 636);
    assert.ok(small.left >= 0);
});

test('clamp keeps the title bar reachable and size sane', () => {
    const b = clampBox({ left: 5000, top: -40, width: 100, height: 99999 }, 1280, 800);
    assert.equal(b.width, MIN_W);
    assert.equal(b.height, 800);
    assert.equal(b.left, 1280 - 120);
    assert.equal(b.top, 0);
    assert.equal(clampBox({ left: -9999, top: 0, width: 900, height: 500 }, 1280, 800).left, 120 - 900);
});

test('max, sheet, compact, saved box', () => {
    assert.deepEqual(maxBox(1000, 700), { left: 10, top: 10, width: 980, height: 680 });
    const s = sheetBox(390, 844);
    assert.equal(s.top + s.height, 844);
    assert.ok(isCompactWidth(390) && !isCompactWidth(1024));
    assert.equal(parseSavedBox({ left: 1 }), null);
    assert.deepEqual(parseSavedBox({ left: '1', top: 2, width: 3.4, height: 4 }), { left: 1, top: 2, width: 3, height: 4 });
});

test('formatting helpers', () => {
    assert.equal(formatTokens(32700), '33k');
    assert.equal(formatTokens(7600), '7.6k');
    assert.equal(formatDuration(31200), '31.2s');
    const now = new Date(2025, 5, 10, 15, 0).getTime();
    assert.equal(relativeTime(now - 30e3, now), '刚刚');
    assert.equal(relativeTime(now - 12 * 60e3, now), '12 分钟前');
    assert.match(relativeTime(new Date(2025, 5, 9, 23, 40).getTime(), now), /^昨天 23:40$/);
    assert.equal(relativeTime(new Date(2025, 5, 7, 12).getTime(), now), '3 天前');
});

import { clampPill } from '../../public/scripts/extensions/workbench/model/geometry.js';
test('pill stays on screen', () => {
    assert.deepEqual(clampPill({ right: -50, bottom: 9999 }, 1280, 800, { width: 220, height: 42 }), { right: 4, bottom: 754 });
    assert.deepEqual(clampPill({ right: 5000, bottom: 10 }, 390, 844, { width: 220, height: 42 }), { right: 166, bottom: 10 });
});
