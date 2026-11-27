import { describe, expect, test } from '@jest/globals';

import {
    hydrateIndexedPresetEntries,
    hydrateOrderedPresetEntries,
    listHydratedIndexedPresetNames,
    listHydratedOrderedPresetNames,
    synthesizeCardBoundPresetList,
} from '../../public/scripts/util/preset-hydration.js';

describe('preset hydration helpers', () => {
    test('preserves already-hydrated indexed preset objects when complete preload skips re-fetching them', () => {
        const bootstrap = hydrateIndexedPresetEntries({
            currentNames: undefined,
            currentBodies: undefined,
            nextNamesInput: ['Alpha', 'Active', 'Omega'],
            nextBodiesInput: [null, JSON.stringify({ temperature: 0.7 }), null],
        });

        expect(bootstrap.names).toEqual({ Alpha: 0, Active: 1, Omega: 2 });
        expect(bootstrap.bodies).toEqual([null, { temperature: 0.7 }, null]);

        // Simulate in-memory migration after bootstrap before warm preload completes
        bootstrap.bodies[1].migrated = true;

        expect(listHydratedIndexedPresetNames(bootstrap.names, bootstrap.bodies)).toEqual(['Active']);

        const completed = hydrateIndexedPresetEntries({
            currentNames: bootstrap.names,
            currentBodies: bootstrap.bodies,
            nextNamesInput: ['Alpha', 'Active', 'Omega'],
            nextBodiesInput: [
                JSON.stringify({ temperature: 0.2 }),
                null,
                JSON.stringify({ temperature: 0.9 }),
            ],
            preserveExisting: true,
        });

        expect(completed.names).toEqual({ Alpha: 0, Active: 1, Omega: 2 });
        expect(completed.bodies[0]).toEqual({ temperature: 0.2 });
        expect(completed.bodies[1]).toBe(bootstrap.bodies[1]);
        expect(completed.bodies[1]).toEqual({ temperature: 0.7, migrated: true });
        expect(completed.bodies[2]).toEqual({ temperature: 0.9 });
    });

    test('replaces indexed preset objects when preserveExisting is false', () => {
        const initial = hydrateIndexedPresetEntries({
            nextNamesInput: ['Active'],
            nextBodiesInput: [JSON.stringify({ temperature: 0.7 })],
        });

        const replaced = hydrateIndexedPresetEntries({
            currentNames: initial.names,
            currentBodies: initial.bodies,
            nextNamesInput: ['Active'],
            nextBodiesInput: [null],
            preserveExisting: false,
        });

        expect(replaced.bodies).toEqual([null]);
    });

    test('preserves already-hydrated ordered preset objects when preserveExisting is true', () => {
        const bootstrap = hydrateOrderedPresetEntries({
            nextNamesInput: ['First', 'Selected'],
            nextBodiesInput: [null, JSON.stringify({ temp: 0.5 })],
        });

        expect(listHydratedOrderedPresetNames(bootstrap.names, bootstrap.bodies)).toEqual(['Selected']);

        const completed = hydrateOrderedPresetEntries({
            currentNames: bootstrap.names,
            currentBodies: bootstrap.bodies,
            nextNamesInput: ['First', 'Selected'],
            nextBodiesInput: [JSON.stringify({ temp: 0.1 }), null],
            preserveExisting: true,
        });

        expect(completed.names).toEqual(['First', 'Selected']);
        expect(completed.bodies[0]).toEqual({ temp: 0.1 });
        expect(completed.bodies[1]).toBe(bootstrap.bodies[1]);
    });

    test('retains indexed presets created in memory during warm preload and keeps in-memory edits over stale disk strings', () => {
        const currentNames = { Default: 0, NewlyCreated: 1 };
        const editedDefault = { temperature: 0.88, savedInMemory: true };
        const createdPreset = { temperature: 0.42, extensions: { regex_scripts: [{ id: 'rx-new' }] } };
        const currentBodies = [editedDefault, createdPreset];

        const completed = hydrateIndexedPresetEntries({
            currentNames,
            currentBodies,
            nextNamesInput: ['Alpha', 'Default'],
            nextBodiesInput: [JSON.stringify({ temperature: 0.25 }), JSON.stringify({ temperature: 1.0 })],
            preserveExisting: true,
        });

        expect(completed.names).toEqual({
            Alpha: 0,
            Default: 1,
            NewlyCreated: 2,
        });
        expect(completed.bodies[completed.names.Alpha]).toEqual({ temperature: 0.25 });
        expect(completed.bodies[completed.names.Default]).toBe(editedDefault);
        expect(completed.bodies[completed.names.NewlyCreated]).toBe(createdPreset);
    });

    test('retains ordered presets created in memory during warm preload and keeps in-memory edits over stale disk strings', () => {
        const editedSelected = { temp: 0.77 };
        const createdOrdered = { temp: 0.33 };
        const completed = hydrateOrderedPresetEntries({
            currentNames: ['Selected', 'CreatedDuringPreload'],
            currentBodies: [editedSelected, createdOrdered],
            nextNamesInput: ['First', 'Selected'],
            nextBodiesInput: [JSON.stringify({ temp: 0.1 }), JSON.stringify({ temp: 0.5 })],
            preserveExisting: true,
        });

        expect(completed.names).toEqual(['First', 'Selected', 'CreatedDuringPreload']);
        expect(completed.bodies[0]).toEqual({ temp: 0.1 });
        expect(completed.bodies[1]).toBe(editedSelected);
        expect(completed.bodies[2]).toBe(createdOrdered);
    });

    test('synthesizeCardBoundPresetList appends a non-colliding ghost without mutating raw arrays', () => {
        const globalBody = { temperature: 0.7 };
        const raw = {
            presets: [globalBody],
            preset_names: { Default: 0 },
            settings: { temperature: 0.5 },
        };
        const ghostBody = { temperature: 0.42 };

        const synthesized = synthesizeCardBoundPresetList(raw, { name: 'CardOnly', body: ghostBody });

        expect(synthesized.preset_names).toEqual({ Default: 0, CardOnly: 1 });
        expect(synthesized.presets[0]).toBe(globalBody);
        expect(synthesized.presets[1]).toBe(ghostBody);
        expect(raw.presets).toEqual([globalBody]);
        expect(raw.preset_names).toEqual({ Default: 0 });
    });

    test('synthesizeCardBoundPresetList prefers active card-bound ghost over both null and hydrated colliding global slots', () => {
        const ghostBody = { temperature: 0.35, source: 'card' };

        const unhydratedRaw = {
            presets: [null, { temperature: 0.7 }],
            preset_names: { SharedName: 0, Default: 1 },
            settings: {},
        };
        const withNullSlot = synthesizeCardBoundPresetList(unhydratedRaw, { name: 'SharedName', body: ghostBody });
        expect(withNullSlot.preset_names).toEqual({ SharedName: 0, Default: 1 });
        expect(withNullSlot.presets[0]).toBe(ghostBody);
        expect(unhydratedRaw.presets[0]).toBeNull();

        const globalBody = { temperature: 0.99, source: 'global' };
        const hydratedRaw = {
            presets: [globalBody, { temperature: 0.7 }],
            preset_names: { SharedName: 0, Default: 1 },
            settings: {},
        };
        const withHydratedSlot = synthesizeCardBoundPresetList(hydratedRaw, { name: 'SharedName', body: ghostBody });
        expect(withHydratedSlot.preset_names).toEqual({ SharedName: 0, Default: 1 });
        expect(withHydratedSlot.presets[0]).toBe(ghostBody);
        expect(hydratedRaw.presets[0]).toBe(globalBody);
    });
});
