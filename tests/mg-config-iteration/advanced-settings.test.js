// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Structural tests for the advanced-settings normalizer.
 *
 * `normalizeAdvancedSettings` mirrors the clamp semantics the Advanced panel
 * and the Layer-2 API rely on. Built-in prompt defaults are stored in full;
 * subsequent normalization preserves exact edited values.
 */

import { describe, test, expect } from '@jest/globals';

import {
    ADVANCED_SETTING_DEFAULTS,
    migrateLegacyWorldInfoToggle,
    normalizeAdvancedSettings,
    applyAdvancedSettings,
    normalizeExtractExcludeRecentTurns,
    sanitizeRecallQueryMessages,
} from '../../public/scripts/extensions/memory-graph/config-iteration/advanced-settings.js';
import {
    DEFAULT_CRAWL_SYSTEM_PROMPT,
    DEFAULT_EXTRACT_TEMPLATE,
    DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT,
    DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT,
} from '../../public/scripts/extensions/memory-graph/default-prompts.js';
import { DEFAULT_CONFIG_ITER_SYSTEM_PROMPT } from '../../public/scripts/extensions/memory-graph/config-iteration/system-prompt.js';
import { CONFIG_FIELDS } from '../../public/scripts/extensions/memory-graph/config-iteration/fields.js';

describe('ADVANCED_SETTING_DEFAULTS', () => {
    test('seeds the registered defaults except the inherited concurrency field', () => {
        expect(Object.keys(ADVANCED_SETTING_DEFAULTS)).toHaveLength(Object.keys(CONFIG_FIELDS).length - 1);
    });

    test('leaves the unseeded keys out', () => {
        expect(ADVANCED_SETTING_DEFAULTS).not.toHaveProperty('extractConcurrent');
    });

    test('seeds the prompt keys with the moved constants', () => {
        expect(ADVANCED_SETTING_DEFAULTS.extractCrawlSystemPrompt).toBe(DEFAULT_CRAWL_SYSTEM_PROMPT);
        expect(ADVANCED_SETTING_DEFAULTS.recallRouteSystemPrompt).toBe(DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT);
        expect(ADVANCED_SETTING_DEFAULTS.recallFinalizeSystemPrompt).toBe(DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT);
    });
});

describe('normalizeAdvancedSettings', () => {
    test('returns the 25 registered keys with defaults when both sources are empty', () => {
        const normalized = normalizeAdvancedSettings({}, {});
        expect(Object.keys(normalized)).toHaveLength(25);
        expect(normalized).toMatchObject({
            extractMode: 'oneshot',
            extractContextTurns: 2,
            extractConcurrent: false,
            extractIncludeWorldInfo: true,
            recallIncludeWorldInfo: true,
            extractTemplate: DEFAULT_EXTRACT_TEMPLATE,
            configIterSystemPrompt: DEFAULT_CONFIG_ITER_SYSTEM_PROMPT,
            recallRouteSystemPrompt: DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT,
        });
        expect(normalized).not.toHaveProperty('includeWorldInfoWithPreset');
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
        expect(normalizeAdvancedSettings({ extractIncludeWorldInfo: 'no' }, {}).extractIncludeWorldInfo).toBe(true);
        expect(normalizeAdvancedSettings({ extractIncludeWorldInfo: false }, {}).extractIncludeWorldInfo).toBe(false);
        expect(normalizeAdvancedSettings({ recallIncludeWorldInfo: 'no' }, {}).recallIncludeWorldInfo).toBe(true);
        expect(normalizeAdvancedSettings({ recallIncludeWorldInfo: false }, {}).recallIncludeWorldInfo).toBe(false);
    });

    test('trims and lowercases enum input, falling back for unknown values', () => {
        expect(normalizeAdvancedSettings({ extractMode: ' CRAWL ' }, {}).extractMode).toBe('crawl');
        expect(normalizeAdvancedSettings({ extractMode: 'bogus' }, { extractMode: 'crawl' }).extractMode).toBe('crawl');
        expect(normalizeAdvancedSettings({ extractMode: 'bogus' }, {}).extractMode).toBe('oneshot');
    });

    test('preserves whitespace and empty edits in stored templates', () => {
        const normalized = normalizeAdvancedSettings({ extractTemplate: '   ', extractEdgeRules: '' }, {});
        expect(normalized.extractTemplate).toBe('   ');
        expect(normalized.extractEdgeRules).toBe('');
    });

    test('preserves user-entered template text verbatim', () => {
        const normalized = normalizeAdvancedSettings({ extractTemplate: '  custom {{nodes}} {{edges}}  ' }, {});
        expect(normalized.extractTemplate).toBe('  custom {{nodes}} {{edges}}  ');
    });

    test('preserves cleared prompts and inherits absent prompts from base or default', () => {
        expect(normalizeAdvancedSettings({ extractCrawlSystemPrompt: '' }, {}).extractCrawlSystemPrompt).toBe('');
        expect(normalizeAdvancedSettings({}, { recallRouteSystemPrompt: 'base route' }).recallRouteSystemPrompt).toBe('base route');
        expect(normalizeAdvancedSettings({}, {}).recallFinalizeSystemPrompt).toBe(DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT);
    });

    test('keeps default and custom configuration prompts in storage', () => {
        expect(normalizeAdvancedSettings({ configIterSystemPrompt: DEFAULT_CONFIG_ITER_SYSTEM_PROMPT }, {}).configIterSystemPrompt).toBe(DEFAULT_CONFIG_ITER_SYSTEM_PROMPT);
        expect(normalizeAdvancedSettings({ configIterSystemPrompt: 'custom config prompt' }, {}).configIterSystemPrompt).toBe('custom config prompt');
    });

    test('inherits configIterSystemPrompt from the fallback source', () => {
        const normalized = normalizeAdvancedSettings({}, { configIterSystemPrompt: 'inherited config prompt' });
        expect(normalized.configIterSystemPrompt).toBe('inherited config prompt');
    });
});

describe('applyAdvancedSettings', () => {
    test('writes all 25 keys so the old whole-object semantics hold', () => {
        const target = {};
        applyAdvancedSettings(target, { extractMode: 'crawl', extractIncludeWorldInfo: false, recallIncludeWorldInfo: false });
        expect(target.extractMode).toBe('crawl');
        expect(target.extractIncludeWorldInfo).toBe(false);
        expect(target.recallIncludeWorldInfo).toBe(false);
        expect(target.configIterSystemPrompt).toBe(DEFAULT_CONFIG_ITER_SYSTEM_PROMPT);
        expect(target.extractTemplate).toBe(DEFAULT_EXTRACT_TEMPLATE);
        expect(Object.keys(target)).toHaveLength(25);
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

describe('migrateLegacyWorldInfoToggle', () => {
    test('migrates false legacy toggle into both new flags and deletes legacy key', () => {
        const s = { includeWorldInfoWithPreset: false };
        expect(migrateLegacyWorldInfoToggle(s)).toBe(true);
        expect(s).toEqual({ extractIncludeWorldInfo: false, recallIncludeWorldInfo: false });
        expect('includeWorldInfoWithPreset' in s).toBe(false);
    });

    test('preserves already-set split flags while removing legacy key', () => {
        const s = { includeWorldInfoWithPreset: false, extractIncludeWorldInfo: true };
        expect(migrateLegacyWorldInfoToggle(s)).toBe(true);
        expect(s).toEqual({ extractIncludeWorldInfo: true, recallIncludeWorldInfo: false });
    });

    test('returns false when legacy key is absent', () => {
        const s = { extractIncludeWorldInfo: true };
        expect(migrateLegacyWorldInfoToggle(s)).toBe(false);
        expect(s).toEqual({ extractIncludeWorldInfo: true });
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
