import { describe, test, expect } from '@jest/globals';

import {
    normalizeAdvancedSettings,
    normalizeCrawlCandidateLimit,
} from '../../public/scripts/extensions/memory-graph/config-iteration/advanced-settings.js';
import {
    CONFIG_FIELDS,
    validateFieldValue,
} from '../../public/scripts/extensions/memory-graph/config-iteration/fields.js';

const FIELD = CONFIG_FIELDS['settings.extractCrawlCandidateLimit'];

describe('crawl candidate limit 0 = unlimited', () => {
    test('preserves 0 in both string and number form', () => {
        expect(normalizeCrawlCandidateLimit(0)).toBe(0);
        expect(normalizeCrawlCandidateLimit('0')).toBe(0);
    });

    test('preserves 0 through settings normalization', () => {
        expect(normalizeAdvancedSettings({ extractCrawlCandidateLimit: 0 }, {}).extractCrawlCandidateLimit).toBe(0);
    });

    test('clamps positive values and falls back on invalid input', () => {
        expect(normalizeCrawlCandidateLimit(40)).toBe(40);
        expect(normalizeCrawlCandidateLimit(150)).toBe(100);
        expect(normalizeCrawlCandidateLimit(-1)).toBe(40);
        expect(normalizeCrawlCandidateLimit('')).toBe(40);
        expect(normalizeCrawlCandidateLimit('nope')).toBe(40);
    });

    test('negative values fall back during settings normalization', () => {
        expect(normalizeAdvancedSettings({ extractCrawlCandidateLimit: -1 }, {}).extractCrawlCandidateLimit).toBe(40);
    });

    test('field validation accepts 0 and rejects out-of-range values', () => {
        expect(validateFieldValue(FIELD, 0)).toEqual({ ok: true, value: 0 });
        expect(validateFieldValue(FIELD, -1).ok).toBe(false);
        expect(validateFieldValue(FIELD, 101).ok).toBe(false);
    });
});
