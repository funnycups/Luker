// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Structural tests for the configuration field registry.
 *
 * The registry is the single source of truth for the 25 settings keys the
 * configuration workbench can read and write: group, kind, bounds, enum
 * values, text markers, defaults, and the catalog handed to the AI.
 */

import { describe, test, expect } from '@jest/globals';

import {
    CONFIG_FIELDS,
    getFieldDef,
    resolveSettingsForView,
    getDefaultSettingsView,
    buildConfigFieldCatalog,
    validateFieldValue,
} from '../../public/scripts/extensions/memory-graph/config-iteration/fields.js';
import { DEFAULT_EXTRACT_TEMPLATE } from '../../public/scripts/extensions/memory-graph/default-prompts.js';
import { DEFAULT_CONFIG_ITER_SYSTEM_PROMPT } from '../../public/scripts/extensions/memory-graph/config-iteration/system-prompt.js';

describe('CONFIG_FIELDS registry', () => {
    test('registers exactly 25 fields', () => {
        expect(Object.keys(CONFIG_FIELDS)).toHaveLength(25);
        expect(CONFIG_FIELDS['settings.includeWorldInfoWithPreset']).toBeUndefined();
        expect(CONFIG_FIELDS['settings.extractIncludeWorldInfo']).toMatchObject({
            key: 'extractIncludeWorldInfo',
            group: 'extraction',
            kind: 'bool',
            defaultValue: true,
        });
        expect(CONFIG_FIELDS['settings.recallIncludeWorldInfo']).toMatchObject({
            key: 'recallIncludeWorldInfo',
            group: 'recall',
            kind: 'bool',
            defaultValue: true,
        });
    });

    test('every entry key matches its full settings path', () => {
        for (const [path, def] of Object.entries(CONFIG_FIELDS)) {
            expect(path.startsWith('settings.')).toBe(true);
            expect(def.path).toBe(path);
            expect(path).toBe(`settings.${def.key}`);
        }
    });

    test('every entry carries a group from the registry and a non-empty summary', () => {
        const known = new Set(buildConfigFieldCatalog({}).groups.map(group => group.id));
        for (const def of Object.values(CONFIG_FIELDS)) {
            expect(known.has(def.group)).toBe(true);
            expect(typeof def.summary).toBe('string');
            expect(def.summary.trim().length).toBeGreaterThan(0);
            expect(typeof def.label).toBe('string');
        }
    });

    test('extractTemplate declares the template markers', () => {
        expect(CONFIG_FIELDS['settings.extractTemplate'].markers).toEqual(['{{nodes}}', '{{edges}}']);
    });

    test('extractContextTurns bounds match the Advanced panel', () => {
        expect(CONFIG_FIELDS['settings.extractContextTurns'].min).toBe(1);
        expect(CONFIG_FIELDS['settings.extractContextTurns'].max).toBe(32);
    });

    test('enum fields list their allowed values', () => {
        expect(CONFIG_FIELDS['settings.extractMode'].values).toEqual(['oneshot', 'crawl']);
    });

    test('text fields carry the code default, not an empty slot', () => {
        expect(CONFIG_FIELDS['settings.extractTemplate'].defaultValue).toBe(DEFAULT_EXTRACT_TEMPLATE);
        expect(CONFIG_FIELDS['settings.configIterSystemPrompt'].defaultValue).toBe(DEFAULT_CONFIG_ITER_SYSTEM_PROMPT);
    });

    test('getFieldDef resolves registered paths only', () => {
        expect(getFieldDef('settings.extractMode')).toBe(CONFIG_FIELDS['settings.extractMode']);
        expect(getFieldDef('settings.unknownKey')).toBeNull();
        expect(getFieldDef('schema[0].id')).toBeNull();
    });
});

describe('validateFieldValue', () => {
    test('accepts an in-range enum value', () => {
        expect(validateFieldValue(CONFIG_FIELDS['settings.extractMode'], 'crawl')).toEqual({ ok: true, value: 'crawl' });
    });

    test('rejects an out-of-range enum value', () => {
        expect(validateFieldValue(CONFIG_FIELDS['settings.extractMode'], 'bogus').ok).toBe(false);
    });

    test('rejects an integer above max', () => {
        expect(validateFieldValue(CONFIG_FIELDS['settings.extractContextTurns'], 33).ok).toBe(false);
    });

    test('rejects an integer below min', () => {
        expect(validateFieldValue(CONFIG_FIELDS['settings.extractContextTurns'], 0).ok).toBe(false);
    });

    test('accepts an in-range integer', () => {
        expect(validateFieldValue(CONFIG_FIELDS['settings.extractContextTurns'], 4)).toEqual({ ok: true, value: 4 });
    });

    test('rejects a non-integer for an int field', () => {
        expect(validateFieldValue(CONFIG_FIELDS['settings.extractContextTurns'], 2.5).ok).toBe(false);
        expect(validateFieldValue(CONFIG_FIELDS['settings.extractContextTurns'], '4').ok).toBe(false);
    });

    test('rejects a string for a bool field', () => {
        expect(validateFieldValue(CONFIG_FIELDS['settings.extractIncludeWorldInfo'], 'true').ok).toBe(false);
        expect(validateFieldValue(CONFIG_FIELDS['settings.extractIncludeWorldInfo'], true)).toEqual({ ok: true, value: true });
        expect(validateFieldValue(CONFIG_FIELDS['settings.recallIncludeWorldInfo'], 'false').ok).toBe(false);
        expect(validateFieldValue(CONFIG_FIELDS['settings.recallIncludeWorldInfo'], false)).toEqual({ ok: true, value: false });
    });

    test('rejects a text value missing a required marker', () => {
        expect(validateFieldValue(CONFIG_FIELDS['settings.extractTemplate'], 'no markers').ok).toBe(false);
    });

    test('accepts a text value that keeps both markers', () => {
        const value = 'keep {{nodes}} and {{edges}}';
        expect(validateFieldValue(CONFIG_FIELDS['settings.extractTemplate'], value)).toEqual({ ok: true, value });
    });

    test('rejects a non-string for a text field', () => {
        expect(validateFieldValue(CONFIG_FIELDS['settings.extractEdgeRules'], 42).ok).toBe(false);
    });
});

describe('resolveSettingsForView', () => {
    test('fills empty text slots with the code default', () => {
        const view = resolveSettingsForView({});
        expect(view.extractTemplate).toBe(DEFAULT_EXTRACT_TEMPLATE);
        expect(view.configIterSystemPrompt).toBe(DEFAULT_CONFIG_ITER_SYSTEM_PROMPT);
        expect(view.graphIterSystemPrompt.length).toBeGreaterThan(0);
    });

    test('keeps bool and int defaults', () => {
        const view = resolveSettingsForView({});
        expect(view.extractConcurrent).toBe(false);
        expect(view.extractIncludeWorldInfo).toBe(true);
        expect(view.recallIncludeWorldInfo).toBe(true);
        expect(view.recallMaxIterations).toBe(3);
    });

    test('returns every registered key', () => {
        const view = resolveSettingsForView({});
        expect(Object.keys(view).sort()).toEqual(Object.keys(CONFIG_FIELDS).map(path => CONFIG_FIELDS[path].key).sort());
    });

    test('clamps integers and floors fractions', () => {
        const view = resolveSettingsForView({ extractContextTurns: 999, extractCrawlMaxRounds: 3.9, updateEvery: 0, extractExcludeRecentTurns: -5 });
        expect(view.extractContextTurns).toBe(32);
        expect(view.extractCrawlMaxRounds).toBe(3);
        expect(view.updateEvery).toBe(1);
        expect(view.extractExcludeRecentTurns).toBe(0);
    });

    test('rejects non-boolean and unknown enum values in favour of defaults', () => {
        const view = resolveSettingsForView({ extractConcurrent: 'yes', extractMode: 'bogus' });
        expect(view.extractConcurrent).toBe(false);
        expect(view.extractMode).toBe('oneshot');
    });

    test('lowercases and trims enum input', () => {
        expect(resolveSettingsForView({ extractMode: '  CRAWL ' }).extractMode).toBe('crawl');
    });
});

describe('getDefaultSettingsView', () => {
    test('returns the 25 code defaults', () => {
        const view = getDefaultSettingsView();
        expect(Object.keys(view)).toHaveLength(25);
        expect(view.extractTemplate).toBe(DEFAULT_EXTRACT_TEMPLATE);
        expect(view.extractMode).toBe('oneshot');
    });
});

describe('buildConfigFieldCatalog', () => {
    test('lists groups, fields, schema indices, and schema text fields', () => {
        const catalog = buildConfigFieldCatalog({ schema: [{ id: 'event', label: 'Event' }] });
        expect(catalog.groups.map(group => group.id)).toEqual(['extraction', 'recall', 'query_rewrite', 'iteration', 'runtime']);
        expect(catalog.fields).toHaveLength(25);
        expect(catalog.schema_index).toEqual([{ index: 0, id: 'event', label: 'Event' }]);
        expect(catalog.schema_text_fields).toEqual([
            { field: 'extractionInstructions', kind: 'text', summary: 'Per-type detailed extraction instructions.' },
            { field: 'extractHint', kind: 'text', summary: 'Overall extraction hint for this node type.' },
            { field: 'columnHints', kind: 'text', column: true, summary: 'Per-column extraction hint; target by column name.' },
            { field: 'compression.summarizeInstruction', kind: 'text', summary: 'Compression summary instruction.' },
        ]);
    });

    test('marks text fields and carries bounds without leaking current values', () => {
        const catalog = buildConfigFieldCatalog({ schema: [] });
        const template = catalog.fields.find(f => f.path === 'settings.extractTemplate');
        expect(template.text).toBe(true);
        expect(template.markers).toEqual(['{{nodes}}', '{{edges}}']);
        const contextTurns = catalog.fields.find(f => f.path === 'settings.extractContextTurns');
        expect(contextTurns.min).toBe(1);
        expect(contextTurns.max).toBe(32);
        expect(contextTurns.text).toBe(false);
        for (const field of catalog.fields) {
            expect(field).not.toHaveProperty('value');
            expect(field).not.toHaveProperty('currentValue');
            expect(field).not.toHaveProperty('defaultValue');
        }
    });

    test('tolerates a missing schema argument', () => {
        const catalog = buildConfigFieldCatalog({});
        expect(catalog.schema_index).toEqual([]);
    });

    test('an absent group lists all 25 fields', () => {
        const catalog = buildConfigFieldCatalog({ schema: [] });
        expect(catalog.fields).toHaveLength(25);
        expect(catalog.groups).toHaveLength(5);
    });

    test('a group filters the fields and keeps the full group index and schema metadata', () => {
        const catalog = buildConfigFieldCatalog({
            schema: [{ id: 'event', label: 'Event' }],
            group: 'recall',
        });
        expect(catalog.fields).toHaveLength(7);
        expect(new Set(catalog.fields.map(field => field.group))).toEqual(new Set(['recall']));
        expect(catalog.groups.map(group => group.id)).toEqual(['extraction', 'recall', 'query_rewrite', 'iteration', 'runtime']);
        expect(catalog.schema_index).toEqual([{ index: 0, id: 'event', label: 'Event' }]);
        expect(catalog.schema_text_fields).toHaveLength(4);
    });

    test('trims a group id and treats a blank one as no filter', () => {
        expect(buildConfigFieldCatalog({ group: '  recall  ' }).fields).toHaveLength(7);
        expect(buildConfigFieldCatalog({ group: '' }).fields).toHaveLength(25);
        expect(buildConfigFieldCatalog({ group: '   ' }).fields).toHaveLength(25);
        expect(buildConfigFieldCatalog({ group: null }).fields).toHaveLength(25);
    });

    test('an unknown group is invalid_args and lists the available groups', () => {
        expect(() => buildConfigFieldCatalog({ group: 'bogus' })).toThrow(/invalid_args/);
        expect(() => buildConfigFieldCatalog({ group: 'bogus' })).toThrow(/"bogus"/);
        expect(() => buildConfigFieldCatalog({ group: 'bogus' })).toThrow(/extraction, recall, query_rewrite, iteration, runtime/);
    });

    test('a non-string group is invalid_args', () => {
        expect(() => buildConfigFieldCatalog({ group: 42 })).toThrow(/invalid_args/);
        expect(() => buildConfigFieldCatalog({ group: { id: 'recall' } })).toThrow(/invalid_args/);
        expect(() => buildConfigFieldCatalog({ group: ['recall'] })).toThrow(/invalid_args/);
    });
});
