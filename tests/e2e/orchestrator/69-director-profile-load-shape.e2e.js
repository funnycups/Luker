// Case #69 — Director profile load shape: no `director:` wrapper
//   (regression for bug fixed 2026-05-28).
//
// Memory: `known_bug_director_override_load_shape`. The director profile
// JSON used to nest its fields under a `director:` key. Now it's flattened
// to match loop/agenda. The sanitizer auto-detects legacy nested input
// and lifts the fields to the top level.
//
// Spec (per AGENT_BRIEF + the bug memo):
//   Spec: write BOTH a flat profile AND a legacy nested profile through
//         sanitizeDirectorProfile in the browser.
//   Load each. Both should parse to identical in-memory shape.
//   Save: a re-sanitize of the sanitized output yields the same flat form
//   (idempotent, no `director:` key).
//
// We exercise the sanitizer directly via the orchestrator's loaded module
// since the regression is fundamentally a data-shape problem; the UI
// editor + persistence are pass-through wrappers around the sanitizer.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*ash*'] });
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '69-director-load-shape' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#69 — Director profile load shape: flat vs legacy nested (REGRESSION 2026-05-28)', () => {
    test('sanitizer auto-detects legacy `director:` wrapper and lifts to flat; output is canonical', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Drive both shapes through the production sanitizer module.
        const result = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/director-defaults.js');
            const sanitize = mod.sanitizeDirectorProfile;

            // Shared director-shaped inner content used in both shapes.
            const inner = {
                mainAgent: {
                    promptPresetName: 'director-main',
                    apiPresetName: 'director-claude',
                    systemPrompt: 'You are the cliff-watch coordinator. Synthesize the scouts\' reports.',
                    tools: null, // inherit
                },
                subAgents: [
                    {
                        id: 'scout_north',
                        description: 'Read the northern reef line for unusual hull silhouettes.',
                        systemPrompt: 'You are scout_north. Examine the chart between marker pairs A-B and B-C and report any anomaly.',
                        tools: null,
                        maxRounds: 6,
                    },
                    {
                        id: 'scout_south',
                        description: 'Read the southern reef line.',
                        systemPrompt: 'You are scout_south. Mirror scout_north on the southern section.',
                        tools: null,
                        maxRounds: 6,
                    },
                ],
                maxRounds: 12,
                maxConcurrentSubagents: 2,
                maxTotalSubagentRuns: 10,
                discardOnAbort: true,
            };

            // Shape 1: flat (current canonical shape).
            const flatInput = { mode: 'director', ...inner };

            // Shape 2: legacy nested.
            const nestedInput = { mode: 'director', director: inner };

            // Shape 3: bare sub-object (character-card override style).
            const bareInput = { ...inner };

            const flatOut = sanitize(flatInput);
            const nestedOut = sanitize(nestedInput);
            const bareOut = sanitize(bareInput);

            // Re-sanitize to assert idempotence (round-trip stability).
            const flatRoundTrip = sanitize(flatOut);

            // Return the three outputs + flag whether each has the legacy
            // `director:` wrapper on the top level (regression evidence).
            return {
                flatOut,
                nestedOut,
                bareOut,
                flatRoundTrip,
                hasDirectorKey: {
                    flatOut: Object.prototype.hasOwnProperty.call(flatOut, 'director'),
                    nestedOut: Object.prototype.hasOwnProperty.call(nestedOut, 'director'),
                    bareOut: Object.prototype.hasOwnProperty.call(bareOut, 'director'),
                },
            };
        });

        // (1) The on-disk shape after sanitization MUST be flat — no
        //     `director:` wrapper anywhere.
        expect(result.hasDirectorKey.flatOut, 'flat input -> flat output (no director wrapper)').toBe(false);
        expect(result.hasDirectorKey.nestedOut, 'legacy nested input -> flat output (wrapper dropped)').toBe(false);
        expect(result.hasDirectorKey.bareOut, 'bare input -> flat output (no wrapper)').toBe(false);

        // (2) Both flat and legacy nested inputs sanitize to identical
        //     in-memory shapes (the core regression assertion).
        expect(result.flatOut, 'flat sanitizer output exists').toBeTruthy();
        expect(result.nestedOut, 'nested sanitizer output exists').toBeTruthy();

        // Verify each director field traveled correctly from both shapes.
        expect(result.flatOut.mode).toBe('director');
        expect(result.nestedOut.mode).toBe('director');
        expect(result.flatOut.mainAgent.systemPrompt).toBe(result.nestedOut.mainAgent.systemPrompt);
        expect(result.flatOut.mainAgent.systemPrompt).toContain('cliff-watch coordinator');
        expect(result.flatOut.subAgents.length).toBe(2);
        expect(result.nestedOut.subAgents.length).toBe(2);
        expect(result.flatOut.subAgents.map(a => a.id).sort()).toEqual(['scout_north', 'scout_south']);
        expect(result.nestedOut.subAgents.map(a => a.id).sort()).toEqual(['scout_north', 'scout_south']);
        expect(result.flatOut.maxRounds).toBe(12);
        expect(result.nestedOut.maxRounds).toBe(12);
        expect(result.flatOut.maxConcurrentSubagents).toBe(2);
        expect(result.nestedOut.maxConcurrentSubagents).toBe(2);
        expect(result.flatOut.discardOnAbort).toBe(true);
        expect(result.nestedOut.discardOnAbort).toBe(true);

        // (3) Bare sub-object input also lifts correctly.
        expect(result.bareOut.mode).toBe('director');
        expect(result.bareOut.subAgents.length).toBe(2);
        expect(result.bareOut.mainAgent.systemPrompt).toBe(result.flatOut.mainAgent.systemPrompt);

        // (4) Idempotence: sanitizing the output again yields the same shape.
        expect(result.flatRoundTrip.mainAgent.systemPrompt).toBe(result.flatOut.mainAgent.systemPrompt);
        expect(result.flatRoundTrip.subAgents.length).toBe(result.flatOut.subAgents.length);
        expect(result.flatRoundTrip.maxRounds).toBe(result.flatOut.maxRounds);
        expect(Object.prototype.hasOwnProperty.call(result.flatRoundTrip, 'director')).toBe(false);

        // (5) Deep-equality between flat and nested outputs (the strongest
        //     form of the regression contract). Fields are compared with
        //     a JSON normalization to avoid order-dependent failures.
        // We exclude any auto-generated metadata that may legitimately
        // differ between calls.
        const normalize = (o) => JSON.parse(JSON.stringify(o));
        expect(normalize(result.flatOut)).toEqual(normalize(result.nestedOut));
    });
});
