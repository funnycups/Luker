// Case #72 — Per-run custom tools: registration isolation
//
// Spec:
//   - Run A registers a per-run custom tool X (via profile.customTools[]).
//   - Run B (next turn) with a DIFFERENT profile does NOT see X.
//   - Restart server → no leakage across sessions.
//
// Layering note (from per-run-custom-tools.js):
//   Layer-2 (`EXTENSION_REGISTRY` in register-custom-tool.js) is a
//   module-global Map persisted nowhere — extensions register tools at
//   startup via `registerOrchestrationTool`; those tools are visible
//   for the lifetime of the page.
//
//   Layer-3 (per-run) is built from `profile.customTools[]` by
//   `buildPerRunCustomToolRegistry(profile, ...)` at the start of each
//   run. It is scoped to ONE invocation; the next run rebuilds from
//   whatever profile is then active.
//
// This test exercises Layer-3 isolation: two different profiles produce
// two different per-run registries.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*ack*'] });
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '72-per-run-tools' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#72 — Per-run custom tools: registration isolation', () => {
    test('two different profiles produce two different per-run tool registries; tools do not leak across runs', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Run A: profile that defines a Layer-3 custom tool named `lantern_check`.
        // Run B: profile that does NOT define `lantern_check`.
        // Both registries must be independent — A has the tool, B does not.
        const result = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/per-run-custom-tools.js');

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

            const registryA = mod.buildPerRunCustomToolRegistry(profileA, null);
            const registryB = mod.buildPerRunCustomToolRegistry(profileB, null);
            const registryEmpty = mod.buildPerRunCustomToolRegistry(profileEmpty, null);

            // Execute each tool to verify the body code closed over its
            // own source and didn't leak into the other registry.
            let execA = null, execB = null;
            try {
                const entryA = registryA.get('lantern_check');
                execA = await entryA.exec({}, {});
            } catch (e) { execA = { error: String(e?.message || e) }; }
            try {
                const entryB = registryB.get('reef_depth');
                execB = await entryB.exec({}, {});
            } catch (e) { execB = { error: String(e?.message || e) }; }

            return {
                A_has_lantern_check: registryA.has('lantern_check'),
                A_has_reef_depth: registryA.has('reef_depth'),
                B_has_lantern_check: registryB.has('lantern_check'),
                B_has_reef_depth: registryB.has('reef_depth'),
                empty_size: registryEmpty.size,
                execA,
                execB,
                A_names: [...registryA.keys()],
                B_names: [...registryB.keys()],
            };
        });

        // Profile A's registry contains lantern_check, not reef_depth.
        expect(result.A_has_lantern_check).toBe(true);
        expect(result.A_has_reef_depth).toBe(false);

        // Profile B's registry contains reef_depth, not lantern_check.
        expect(result.B_has_lantern_check).toBe(false);
        expect(result.B_has_reef_depth).toBe(true);

        // Empty profile produces an empty registry.
        expect(result.empty_size).toBe(0);

        // The two tools each return their own profile-scoped data.
        expect(result.execA).toEqual({ steady: true, source: 'profileA' });
        expect(result.execB).toEqual({ depth_m: 3.2, source: 'profileB' });

        expect(result.A_names).toEqual(['lantern_check']);
        expect(result.B_names).toEqual(['reef_depth']);
    });

    test('per-run registry does not persist across server restart (no on-disk leak)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Register a Layer-3 tool via a profile and exercise it.
        const beforeRestart = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/per-run-custom-tools.js');
            const reg = mod.buildPerRunCustomToolRegistry({
                customTools: [{
                    name: 'salt_mark_count',
                    description: 'Counts salt-mark drifter skiffs in view.',
                    mode: 'read',
                    body: 'return { count: 4, ephemeral: true };',
                    parameters: { type: 'object', properties: {} },
                }],
            }, null);
            return { hasTool: reg.has('salt_mark_count') };
        });
        expect(beforeRestart.hasTool).toBe(true);

        // Restart server + reload page. The per-run registry is built from
        // a profile object passed at invocation time, so there is no
        // persistent state to leak — the test asserts that a fresh page
        // load starts with NO automatic Layer-3 tool registration.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        // A fresh empty profile produces an empty registry — proving no
        // cross-restart bleed-through.
        const afterRestart = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/per-run-custom-tools.js');
            const reg = mod.buildPerRunCustomToolRegistry({}, null);
            return { size: reg.size, names: [...reg.keys()] };
        });
        expect(afterRestart.size).toBe(0);
        expect(afterRestart.names).toEqual([]);
    });
});
