// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Structural tests for the advanced-settings normalizer.
 *
 * `normalizeAdvancedSettings` mirrors the clamp semantics the Advanced panel
 * and the Layer-2 API rely on. `ADVANCED_SETTING_DEFAULTS` only carries the
 * keys that are seeded into `defaultSettings`; the five unseeded keys stay
 * out so code constants can keep driving their defaults.
 */

import { describe, test, expect } from '@jest/globals';

import {
    ADVANCED_SETTING_DEFAULTS,
    normalizeAdvancedSettings,
    applyAdvancedSettings,
    normalizeExtractExcludeRecentTurns,
    sanitizeRecallQueryMessages,
} from '../../public/scripts/extensions/memory-graph/config-iteration/advanced-settings.js';
import {
    DEFAULT_CRAWL_SYSTEM_PROMPT,
    DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT,
    DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT,
} from '../../public/scripts/extensions/memory-graph/default-prompts.js';
import { DEFAULT_CONFIG_ITER_SYSTEM_PROMPT } from '../../public/scripts/extensions/memory-graph/config-iteration/system-prompt.js';

const UNSEDDED_KEYS = [
    'extractTemplate',
    'extractEdgeRules',
    'extractConcurrent',
    'graphIterSystemPrompt',
    'configIterSystemPrompt',
];

describe('ADVANCED_SETTING_DEFAULTS', () => {
    test('contains exactly the 19 seeded keys', () => {
        expect(Object.keys(ADVANCED_SETTING_DEFAULTS)).toHaveLength(19);
    });

    test('leaves the unseeded keys out', () => {
        for (const key of UNSEDDED_KEYS) {
            expect(ADVANCED_SETTING_DEFAULTS).not.toHaveProperty(key);
        }
    });

    test('seeds the prompt keys with the moved constants', () => {
        expect(ADVANCED_SETTING_DEFAULTS.extractCrawlSystemPrompt).toBe(DEFAULT_CRAWL_SYSTEM_PROMPT);
        expect(ADVANCED_SETTING_DEFAULTS.recallRouteSystemPrompt).toBe(DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT);
        expect(ADVANCED_SETTING_DEFAULTS.recallFinalizeSystemPrompt).toBe(DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT);
    });
});

describe('normalizeAdvancedSettings', () => {
    test('returns the 24 registered keys with defaults when both sources are empty', () => {
        const normalized = normalizeAdvancedSettings({}, {});
        expect(Object.keys(normalized)).toHaveLength(24);
        expect(normalized).toMatchObject({
            extractMode: 'oneshot',
            extractContextTurns: 2,
            extractConcurrent: false,
            extractTemplate: '',
            configIterSystemPrompt: '',
            recallRouteSystemPrompt: DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT,
        });
    });

    test('clamps integers to the field bounds', () => {
        expect(normalizeAdvancedSettings({ extractContextTurns: 999 }, {}).extractContextTurns).toBe(32);
        expect(normalizeAdvancedSettings({ extractContextTurns: 0 }, {}).extractContextTurns).toBe(1);
        expect(normalizeAdvancedSettings({ extractCrawlMaxRounds: 9 }, {}).extractCrawlMaxRounds).toBe(5);
        expect(normalizeAdvancedSettings({ updateEvery: 0 }, {}).updateEvery).toBe(1);
        expect(normalizeAdvancedSettings({ extractExcludeRecentTurns: -3 }, {}).extractExcludeRecentTurns).toBe(0);
        expect(normalizeAdvancedSettings({ extractBatchTurns: 2.7 }, {}).extractBatchTurns).toBe(2);
    });

    test('falls back to the base source for invalid integers', () => {
        expect(normalizeAdvancedSettings({ recallMaxIterations: 'nope' }, { recallMaxIterations: 5 }).recallMaxIterations).toBe(5);
        expect(normalizeAdvancedSettings({ recallMaxIterations: 99 }, { recallMaxIterations: 5 }).recallMaxIterations).toBe(6);
    });

    test('accepts only booleans and otherwise falls back to base then default', () => {
        expect(normalizeAdvancedSettings({ extractConcurrent: 'yes' }, { extractConcurrent: true }).extractConcurrent).toBe(true);
        expect(normalizeAdvancedSettings({ includeWorldInfoWithPreset: 'no' }, {}).includeWorldInfoWithPreset).toBe(true);
        expect(normalizeAdvancedSettings({ includeWorldInfoWithPreset: false }, {}).includeWorldInfoWithPreset).toBe(false);
    });

    test('trims and lowercases enum input, falling back for unknown values', () => {
        expect(normalizeAdvancedSettings({ extractMode: ' CRAWL ' }, {}).extractMode).toBe('crawl');
        expect(normalizeAdvancedSettings({ extractMode: 'bogus' }, { extractMode: 'crawl' }).extractMode).toBe('crawl');
        expect(normalizeAdvancedSettings({ extractMode: 'bogus' }, {}).extractMode).toBe('oneshot');
    });

    test('keeps empty slots empty for user-edited templates', () => {
        const normalized = normalizeAdvancedSettings({ extractTemplate: '   ', extractEdgeRules: '' }, {});
        expect(normalized.extractTemplate).toBe('');
        expect(normalized.extractEdgeRules).toBe('');
    });

    test('trims user-entered template text', () => {
        const normalized = normalizeAdvancedSettings({ extractTemplate: '  custom {{nodes}} {{edges}}  ' }, {});
        expect(normalized.extractTemplate).toBe('custom {{nodes}} {{edges}}');
    });

    test('fills the crawl and recall prompts from base or default', () => {
        expect(normalizeAdvancedSettings({ extractCrawlSystemPrompt: '' }, {}).extractCrawlSystemPrompt).toBe(DEFAULT_CRAWL_SYSTEM_PROMPT);
        expect(normalizeAdvancedSettings({}, { recallRouteSystemPrompt: 'base route' }).recallRouteSystemPrompt).toBe('base route');
        expect(normalizeAdvancedSettings({}, {}).recallFinalizeSystemPrompt).toBe(DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT);
    });

    test('clears configIterSystemPrompt when it equals the code default', () => {
        expect(normalizeAdvancedSettings({ configIterSystemPrompt: DEFAULT_CONFIG_ITER_SYSTEM_PROMPT }, {}).configIterSystemPrompt).toBe('');
        expect(normalizeAdvancedSettings({ configIterSystemPrompt: 'custom config prompt' }, {}).configIterSystemPrompt).toBe('custom config prompt');
    });

    test('inherits configIterSystemPrompt from the fallback source', () => {
        const normalized = normalizeAdvancedSettings({}, { configIterSystemPrompt: 'inherited config prompt' });
        expect(normalized.configIterSystemPrompt).toBe('inherited config prompt');
    });
});

describe('applyAdvancedSettings', () => {
    test('writes all 24 keys so the old whole-object semantics hold', () => {
        const target = {};
        applyAdvancedSettings(target, { extractMode: 'crawl', includeWorldInfoWithPreset: false });
        expect(target.extractMode).toBe('crawl');
        expect(target.includeWorldInfoWithPreset).toBe(false);
        expect(target.configIterSystemPrompt).toBe('');
        expect(target.extractTemplate).toBe('');
        expect(Object.keys(target)).toHaveLength(24);
    });

    test('reads the existing target as the fallback source', () => {
        const target = { recallMaxIterations: 5 };
        applyAdvancedSettings(target, {});
        expect(target.recallMaxIterations).toBe(5);
    });

    test('ignores a non-object target', () => {
        expect(() => applyAdvancedSettings(null, { extractMode: 'crawl' })).not.toThrow();
    });
});

describe('shared numeric helpers', () => {
    test('normalizeExtractExcludeRecentTurns floors and clamps at zero', () => {
        expect(normalizeExtractExcludeRecentTurns(3.9)).toBe(3);
        expect(normalizeExtractExcludeRecentTurns(-4)).toBe(0);
        expect(normalizeExtractExcludeRecentTurns('nope')).toBe(0);
        expect(normalizeExtractExcludeRecentTurns(undefined)).toBe(0);
    });

    test('sanitizeRecallQueryMessages clamps to 0..64 with a fallback', () => {
        expect(sanitizeRecallQueryMessages(5)).toBe(5);
        expect(sanitizeRecallQueryMessages(999)).toBe(64);
        expect(sanitizeRecallQueryMessages(-1)).toBe(0);
        expect(sanitizeRecallQueryMessages(2.9)).toBe(2);
        expect(sanitizeRecallQueryMessages('nope', 7)).toBe(7);
        expect(sanitizeRecallQueryMessages('nope')).toBe(2);
    });
});
