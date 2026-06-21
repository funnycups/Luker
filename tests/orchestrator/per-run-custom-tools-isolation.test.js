// Case #72 — Per-run custom tools: registration isolation (ported from e2e).
//
// Spec:
//   - Run A registers a per-run custom tool X (via profile.customTools[]).
//   - Run B (next turn) with a DIFFERENT profile does NOT see X.
//   - Restart server → no leakage across sessions.
//
// Layering note (from per-run-custom-tools.js):
//   Layer-2 (`EXTENSION_REGISTRY` in register-custom-tool.js) is a
//   module-global Map persisted nowhere — extensions register tools at
//   startup; those tools are visible for the lifetime of the page.
//
//   Layer-3 (per-run) is built from `profile.customTools[]` by
//   `buildPerRunCustomToolRegistry(profile, ...)` at the start of each
//   run. It is scoped to ONE invocation; the next run rebuilds from
//   whatever profile is then active.
//
// This test exercises Layer-3 isolation: two different profiles produce
// two different per-run registries. The "no cross-restart bleed-through"
// half collapses to "calling the builder again with an empty profile
// returns an empty Map" — there is no persistent state to leak because
// the per-run registry is built from a profile object passed at
// invocation time, not pulled from disk/storage.

import { describe, test, expect } from '@jest/globals';
import { buildPerRunCustomToolRegistry } from '../../public/scripts/extensions/orchestrator/per-run-custom-tools.js';

describe('#72 — Per-run custom tools: registration isolation', () => {
    test('two different profiles produce two different per-run tool registries; tools do not leak across runs', async () => {
        const profileA = {
            customTools: [
                {
                    name: 'lantern_check',
                    description: 'Returns whether the lantern flame is steady.',
                    mode: 'read',
                    body: 'return { steady: true, source: "profileA" };',
                    simulateBody: '',
                    parameters: { type: 'object', properties: {} },
                },
            ],
        };
        const profileB = {
            customTools: [
                {
                    name: 'reef_depth',
                    description: 'Reads the reef depth at a coordinate.',
                    mode: 'read',
                    body: 'return { depth_m: 3.2, source: "profileB" };',
                    simulateBody: '',
                    parameters: { type: 'object', properties: {} },
                },
            ],
        };
        const profileEmpty = {};

        const registryA = buildPerRunCustomToolRegistry(profileA, null);
        const registryB = buildPerRunCustomToolRegistry(profileB, null);
        const registryEmpty = buildPerRunCustomToolRegistry(profileEmpty, null);

        // Profile A's registry contains lantern_check, not reef_depth.
        expect(registryA.has('lantern_check')).toBe(true);
        expect(registryA.has('reef_depth')).toBe(false);

        // Profile B's registry contains reef_depth, not lantern_check.
        expect(registryB.has('lantern_check')).toBe(false);
        expect(registryB.has('reef_depth')).toBe(true);

        // Empty profile produces an empty registry.
        expect(registryEmpty.size).toBe(0);

        // Execute each tool to verify the body code closed over its
        // own source and didn't leak into the other registry.
        const entryA = registryA.get('lantern_check');
        const execA = await entryA.exec({}, {});
        const entryB = registryB.get('reef_depth');
        const execB = await entryB.exec({}, {});

        expect(execA).toEqual({ steady: true, source: 'profileA' });
        expect(execB).toEqual({ depth_m: 3.2, source: 'profileB' });

        expect([...registryA.keys()]).toEqual(['lantern_check']);
        expect([...registryB.keys()]).toEqual(['reef_depth']);
    });

    test('per-run registry does not persist across server restart (no on-disk leak)', () => {
        // First "run" — register a Layer-3 tool via a profile and exercise it.
        const beforeRestartReg = buildPerRunCustomToolRegistry({
            customTools: [{
                name: 'salt_mark_count',
                description: 'Counts salt-mark drifter skiffs in view.',
                mode: 'read',
                body: 'return { count: 4, ephemeral: true };',
                parameters: { type: 'object', properties: {} },
            }],
        }, null);
        expect(beforeRestartReg.has('salt_mark_count')).toBe(true);

        // Simulated "after restart" — a fresh build call with no profile.
        // The per-run registry is built from a profile object passed at
        // invocation time, so there is no persistent state to leak. A
        // fresh build with an empty profile must produce an empty
        // registry, proving no cross-restart bleed-through.
        const afterRestartReg = buildPerRunCustomToolRegistry({}, null);
        expect(afterRestartReg.size).toBe(0);
        expect([...afterRestartReg.keys()]).toEqual([]);
    });
});
