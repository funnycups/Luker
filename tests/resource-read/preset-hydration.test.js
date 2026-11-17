import { describe, expect, test } from '@jest/globals';

import {
    hydrateIndexedPresetEntries,
    hydrateOrderedPresetEntries,
    listHydratedIndexedPresetNames,
    listHydratedOrderedPresetNames,
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
});
