import { describe, test, expect } from '@jest/globals';
import { createFactoryPresetForMode } from '../../public/scripts/extensions/orchestrator/defaults.js';
import { ORCH_EXECUTION_MODE_DIRECTOR } from '../../public/scripts/extensions/orchestrator/director-defaults.js';

// Pin the data-shape contract that the Reset Global handler relies on for
// director mode. `createFactoryPresetForMode(director)` returns an ARRAY of
// two entries (B3 / fa0c5d5db); the handler must pick the right one by id
// and strip the `id` field before writing via `writeActivePreset`. If the
// factory ever silently regresses to a single object, the handler would
// write `undefined` as the payload — these tests fail loudly first.
//
// UI behavior (popup buttons, editor reload) is covered by the manual
// Playwright pass at end-of-branch; these tests cover the data contract
// only.
describe('reset-global director: factory payloads are individually addressable', () => {
    test('both factory entries are resolvable by id', () => {
        const entries = createFactoryPresetForMode(ORCH_EXECUTION_MODE_DIRECTOR);
        expect(Array.isArray(entries)).toBe(true);
        const byId = Object.fromEntries(entries.map(e => [e.id, e]));
        expect(byId['default-full']).toBeDefined();
        expect(byId['default']).toBeDefined();
    });

    test('Full entry has sub-agents (so writeActivePreset receives a real profile)', () => {
        const entries = createFactoryPresetForMode(ORCH_EXECUTION_MODE_DIRECTOR);
        const full = entries.find(e => e.id === 'default-full');
        expect(Array.isArray(full.subAgents)).toBe(true);
        expect(full.subAgents.length).toBeGreaterThan(0);
    });

    test('Minimal entry has sub-agents (so writeActivePreset receives a real profile)', () => {
        const entries = createFactoryPresetForMode(ORCH_EXECUTION_MODE_DIRECTOR);
        const minimal = entries.find(e => e.id === 'default');
        expect(Array.isArray(minimal.subAgents)).toBe(true);
        expect(minimal.subAgents.length).toBeGreaterThan(0);
    });

    test('payload after dropping id is still a complete profile', () => {
        const entries = createFactoryPresetForMode(ORCH_EXECUTION_MODE_DIRECTOR);
        const full = entries.find(e => e.id === 'default-full');
        const payload = { ...full };
        delete payload.id;
        expect(payload.mode).toBe('director');
        expect(payload.mainAgent).toBeDefined();
        expect(payload.subAgents).toBeDefined();
        expect(payload.tools).toBeDefined();
    });
});
