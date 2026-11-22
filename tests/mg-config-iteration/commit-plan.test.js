// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Commit-plan tests for the Memory Graph configuration studio.
 *
 * `planConfigCommit` derives the sparse write plan for a { schema, settings }
 * document pair: which settings keys changed, which of those collapse back
 * onto the inherited baseline (character override slots that must be
 * dropped), and whether the schema half moved at all.
 *
 * `applyConfigPlan` executes the plan. The character branch is fail-closed:
 * a rejected character write throws and NEVER falls through to the global
 * settings write — the historical fall-through masked override failures by
 * silently mutating global state.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { getDefaultSettingsView } from '../../public/scripts/extensions/memory-graph/config-iteration/fields.js';
import {
    planConfigCommit,
    applyConfigPlan,
} from '../../public/scripts/extensions/memory-graph/config-iteration/commit-plan.js';

const defaults = getDefaultSettingsView();

describe('planConfigCommit — settings diff against the inherited baseline', () => {
    test('a changed key that differs from the inherited baseline lands in set', () => {
        const plan = planConfigCommit({
            before: { schema: [{ id: 'event' }], settings: { ...defaults, recallMaxIterations: 3 } },
            next: { schema: [{ id: 'event' }], settings: { ...defaults, recallMaxIterations: 5 } },
            scope: 'global',
            inheritedSettings: defaults,
        });
        expect(plan.set).toEqual({ recallMaxIterations: 5 });
        expect(plan.unset).toEqual([]);
        expect(plan.schemaChanged).toBe(false);
        expect(plan.schema).toEqual([{ id: 'event' }]);
        expect(plan.changedKeys).toEqual(['recallMaxIterations']);
        expect(plan.hasChanges).toBe(true);
    });

    test('a changed key that returns to the inherited value lands in unset', () => {
        const backToDefault = planConfigCommit({
            before: { schema: [], settings: { ...defaults, recallMaxIterations: 5 } },
            next: { schema: [], settings: { ...defaults, recallMaxIterations: 3 } },
            scope: 'global',
            inheritedSettings: defaults,
        });
        expect(backToDefault.unset).toEqual(['recallMaxIterations']);
        expect(backToDefault.set).toEqual({});
        expect(backToDefault.changedKeys).toEqual(['recallMaxIterations']);
    });

    test('keys that differ from the baseline on BOTH sides are not part of the plan', () => {
        // extractBatchTurns was overridden before the turn started and the
        // proposal leaves it alone — only recallMaxIterations moved.
        const external = planConfigCommit({
            before: { schema: [], settings: { ...defaults, extractBatchTurns: 4, recallMaxIterations: 3 } },
            next: { schema: [], settings: { ...defaults, extractBatchTurns: 4, recallMaxIterations: 5 } },
            scope: 'global',
            inheritedSettings: defaults,
        });
        expect(external.set).toEqual({ recallMaxIterations: 5 });
        expect(external.set).not.toHaveProperty('extractBatchTurns');
        expect(external.changedKeys).toEqual(['recallMaxIterations']);
    });

    test('no settings change and no schema change → hasChanges false, empty plan', () => {
        const noChange = planConfigCommit({
            before: { schema: [], settings: { ...defaults, recallMaxIterations: 5 } },
            next: { schema: [], settings: { ...defaults, recallMaxIterations: 5 } },
            scope: 'character',
            inheritedSettings: { ...defaults, recallMaxIterations: 5 },
        });
        expect(noChange.hasChanges).toBe(false);
        expect(noChange.unset).toEqual([]);
        expect(noChange.set).toEqual({});
        expect(noChange.changedKeys).toEqual([]);
        expect(noChange.schemaChanged).toBe(false);
    });

    test('schema-only change → schemaChanged true, no settings keys in the plan', () => {
        const plan = planConfigCommit({
            before: { schema: [{ id: 'event' }], settings: { ...defaults } },
            next: { schema: [{ id: 'event', label: 'Event' }], settings: { ...defaults } },
            scope: 'character',
            inheritedSettings: defaults,
        });
        expect(plan.schemaChanged).toBe(true);
        expect(plan.changedKeys).toEqual([]);
        expect(plan.hasChanges).toBe(true);
        expect(plan.schema).toEqual([{ id: 'event', label: 'Event' }]);
    });

    test('only the 25 registered keys participate — foreign keys never enter the plan', () => {
        const plan = planConfigCommit({
            before: { schema: [], settings: { ...defaults, someForeignKey: 1, includeWorldInfoWithPreset: true } },
            next: { schema: [], settings: { ...defaults, someForeignKey: 2, includeWorldInfoWithPreset: false } },
            scope: 'character',
            inheritedSettings: defaults,
        });
        expect(plan.set).toEqual({});
        expect(plan.unset).toEqual([]);
        expect(plan.changedKeys).toEqual([]);
        expect(plan.hasChanges).toBe(false);
    });

    test('set + unset can coexist across different keys', () => {
        const plan = planConfigCommit({
            before: {
                schema: [],
                settings: { ...defaults, recallMaxIterations: 5, rpmLimit: 30 },
            },
            next: {
                schema: [],
                settings: { ...defaults, recallMaxIterations: 3, rpmLimit: 60 },
            },
            scope: 'character',
            inheritedSettings: defaults,
        });
        expect(plan.set).toEqual({ rpmLimit: 60 });
        expect(plan.unset).toEqual(['recallMaxIterations']);
        expect(plan.changedKeys).toEqual(['recallMaxIterations', 'rpmLimit']);
    });
});

describe('applyConfigPlan — character scope is fail-closed', () => {
    test('a rejected schema override write throws and never touches global settings', async () => {
        const persistCharacterSchema = jest.fn(async () => false);
        const persistCharacterSettings = jest.fn(async () => true);
        const saveGlobalSettings = jest.fn(async () => {});
        await expect(applyConfigPlan(
            { hasChanges: true, schemaChanged: true, schema: [{ id: 'event' }], changedKeys: [], set: {}, unset: [] },
            { scope: 'character', globalSettings: {}, persistCharacterSchema, persistCharacterSettings, saveGlobalSettings },
        )).rejects.toThrow(/character schema override/);
        expect(saveGlobalSettings).not.toHaveBeenCalled();
        expect(persistCharacterSettings).not.toHaveBeenCalled();
    });

    test('a rejected settings override write throws after the schema write landed', async () => {
        const persistCharacterSchema = jest.fn(async () => true);
        const persistCharacterSettings = jest.fn(async () => false);
        const saveGlobalSettings = jest.fn(async () => {});
        await expect(applyConfigPlan(
            {
                hasChanges: true,
                schemaChanged: true,
                schema: [{ id: 'event' }],
                changedKeys: ['recallMaxIterations'],
                set: { recallMaxIterations: 5 },
                unset: [],
            },
            { scope: 'character', globalSettings: {}, persistCharacterSchema, persistCharacterSettings, saveGlobalSettings },
        )).rejects.toThrow(/character settings override/);
        expect(persistCharacterSchema).toHaveBeenCalledWith([{ id: 'event' }]);
        expect(persistCharacterSettings).toHaveBeenCalledWith({ set: { recallMaxIterations: 5 }, unset: [] });
        expect(saveGlobalSettings).not.toHaveBeenCalled();
    });

    test('a successful character commit writes schema + sparse settings patch and never saves global', async () => {
        const persistCharacterSchema = jest.fn(async () => true);
        const persistCharacterSettings = jest.fn(async () => true);
        const saveGlobalSettings = jest.fn(async () => {});
        const globalSettings = { nodeTypeSchema: [], untouched: 'keep' };
        await applyConfigPlan(
            {
                hasChanges: true,
                schemaChanged: true,
                schema: [{ id: 'event' }],
                changedKeys: ['recallMaxIterations'],
                set: { recallMaxIterations: 5 },
                unset: ['rpmLimit'],
            },
            { scope: 'character', globalSettings, persistCharacterSchema, persistCharacterSettings, saveGlobalSettings },
        );
        expect(persistCharacterSchema).toHaveBeenCalledWith([{ id: 'event' }]);
        expect(persistCharacterSettings).toHaveBeenCalledWith({ set: { recallMaxIterations: 5 }, unset: ['rpmLimit'] });
        expect(saveGlobalSettings).not.toHaveBeenCalled();
        // The global settings object is left byte-identical in the
        // character branch — a rejected write must not be able to fall
        // through and mutate global state as a side effect.
        expect(globalSettings).toEqual({ nodeTypeSchema: [], untouched: 'keep' });
    });

    test('settings-only character commit skips the schema override write', async () => {
        // Writing an unchanged schema to the card would CREATE an override
        // the user never asked for (the working schema starts as a fork of
        // global in the no-override case), so the schema write must be
        // gated on schemaChanged.
        const persistCharacterSchema = jest.fn(async () => true);
        const persistCharacterSettings = jest.fn(async () => true);
        const saveGlobalSettings = jest.fn(async () => {});
        await applyConfigPlan(
            {
                hasChanges: true,
                schemaChanged: false,
                schema: [{ id: 'event' }],
                changedKeys: ['recallMaxIterations'],
                set: { recallMaxIterations: 5 },
                unset: [],
            },
            { scope: 'character', globalSettings: {}, persistCharacterSchema, persistCharacterSettings, saveGlobalSettings },
        );
        expect(persistCharacterSchema).not.toHaveBeenCalled();
        expect(persistCharacterSettings).toHaveBeenCalledWith({ set: { recallMaxIterations: 5 }, unset: [] });
    });
});

describe('applyConfigPlan — global scope', () => {
    test('writes the schema, applies set, deletes unset, and saves exactly once', async () => {
        const saveGlobalSettings = jest.fn(async () => {});
        const globalSettings = {
            nodeTypeSchema: [{ id: 'old' }],
            recallMaxIterations: 3,
            rpmLimit: 30,
        };
        await applyConfigPlan(
            {
                hasChanges: true,
                schemaChanged: true,
                schema: [{ id: 'event' }],
                changedKeys: ['recallMaxIterations', 'rpmLimit'],
                set: { recallMaxIterations: 5 },
                unset: ['rpmLimit'],
            },
            {
                scope: 'global',
                globalSettings,
                persistCharacterSchema: jest.fn(),
                persistCharacterSettings: jest.fn(),
                saveGlobalSettings,
            },
        );
        expect(globalSettings.nodeTypeSchema).toEqual([{ id: 'event' }]);
        expect(globalSettings.recallMaxIterations).toBe(5);
        expect('rpmLimit' in globalSettings).toBe(false);
        expect(saveGlobalSettings).toHaveBeenCalledTimes(1);
    });

    test('an unchanged schema leaves globalSettings.nodeTypeSchema untouched', async () => {
        const saveGlobalSettings = jest.fn(async () => {});
        const originalSchema = [{ id: 'old' }];
        const globalSettings = { nodeTypeSchema: originalSchema, recallMaxIterations: 3 };
        await applyConfigPlan(
            {
                hasChanges: true,
                schemaChanged: false,
                schema: [{ id: 'event' }],
                changedKeys: ['recallMaxIterations'],
                set: { recallMaxIterations: 5 },
                unset: [],
            },
            { scope: 'global', globalSettings, persistCharacterSchema: jest.fn(), persistCharacterSettings: jest.fn(), saveGlobalSettings },
        );
        expect(globalSettings.nodeTypeSchema).toBe(originalSchema);
        expect(globalSettings.recallMaxIterations).toBe(5);
        expect(saveGlobalSettings).toHaveBeenCalledTimes(1);
    });
});
