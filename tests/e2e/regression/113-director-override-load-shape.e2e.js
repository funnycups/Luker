// #113 — director override load shape (memory: known_bug_director_override_load_shape)
//
// Bug shape (fixed 2026-05-28): the director profile used to carry a
// `director:` wrapper key (`{ mode: 'director', director: { mainAgent,
// subAgents, ... } }`) while loop / agenda were flat. Character-card
// overrides stored only the BARE inner sub-object
// (`override.director = { mainAgent, ... }`), and
// `loadCharacterDirectorEditorState` fed that straight into
// `sanitizeDirectorProfile`, which read `profile.director` (undefined
// for bare input) and silently returned defaults.
//
// User-visible: AI Iteration Studio in director mode appeared to "save
// nothing" because the loader rebuilt the override from defaults rather
// than reading the persisted shape.
//
// Fix: director profile is flat — `{ mode, mainAgent, subAgents, ... }`.
// `sanitizeDirectorProfile` auto-detects three input shapes (legacy
// wrapped, new flat, bare card-override sub-object) and produces flat
// output unconditionally; writes always produce flat.
//
// Regression lock: run all three input shapes through
// `sanitizeDirectorProfile`. They must yield identical in-memory shape
// (modulo defaults), and the output must always be flat (no `director:`
// wrapper).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'director-shape' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#113 — director profile sanitizer normalizes legacy + flat + bare shapes', () => {
    test('three input shapes produce identical flat output (no director: wrapper)', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const result = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/director-defaults.js');
            const { sanitizeDirectorProfile } = mod;

            // The canonical inner payload — same in all three shapes.
            const inner = {
                mainAgent: {
                    systemPrompt: 'Director main agent — keep watch on the headland.',
                    apiPresetName: 'openai-main',
                    promptPresetName: 'preset-main',
                },
                subAgents: [
                    {
                        id: 'reef-reader',
                        description: 'Watches the reef for drifter signals.',
                        systemPrompt: 'You note any reef movement out of pattern.',
                        promptPresetName: '',
                        apiPresetName: '',
                    },
                ],
                maxRounds: 7,
                maxConcurrentSubagents: 2,
                maxTotalSubagentRuns: 4,
                discardOnAbort: true,
            };

            // Three legacy shapes the loader must accept:
            //   A) FLAT (new shape) — mainAgent / subAgents / etc at top level
            //   B) WRAPPED (legacy) — { mode, director: { mainAgent, ... } }
            //   C) BARE (card-override inner) — just { mainAgent, ... }
            const A_flat = { mode: 'director', ...inner };
            const B_wrapped = { mode: 'director', director: { ...inner } };
            const C_bare = { ...inner };

            const sa = sanitizeDirectorProfile(A_flat);
            const sb = sanitizeDirectorProfile(B_wrapped);
            const sc = sanitizeDirectorProfile(C_bare);

            // Strip mode key — sanitizer may or may not preserve it, but we
            // care about the shape contract.
            const stripMode = (o) => { const { mode, ...rest } = o || {}; return rest; };
            return {
                a: stripMode(sa),
                b: stripMode(sb),
                c: stripMode(sc),
                aFlatLeak: Object.prototype.hasOwnProperty.call(sa, 'director'),
                bFlatLeak: Object.prototype.hasOwnProperty.call(sb, 'director'),
                cFlatLeak: Object.prototype.hasOwnProperty.call(sc, 'director'),
            };
        });

        // 1. None of the sanitized outputs may still carry the legacy
        //    `director:` wrapper key — writes always produce flat.
        expect(result.aFlatLeak, 'flat input → flat output (no director: wrapper)').toBe(false);
        expect(result.bFlatLeak, 'legacy wrapped input → flat output (wrapper stripped)').toBe(false);
        expect(result.cFlatLeak, 'bare input → flat output (no wrapper rebuilt)').toBe(false);

        // 2. All three must agree on the load-bearing payload fields.
        //    We compare via Playwright's deep-equal (`toEqual`) so field
        //    ordering doesn't matter — sanitizers are idempotent but may
        //    emit keys in different insertion orders depending on input.
        expect(result.b,
            'legacy wrapped input must produce the same shape as flat input — the load-side trap was exactly this divergence',
        ).toEqual(result.a);
        expect(result.c,
            'bare card-override input must produce the same shape as flat input — character-card overrides must load cleanly',
        ).toEqual(result.a);

        // 3. Sanity: the inner payload's load-bearing fields survived all
        //    three input shapes (if the sanitizer silently fell back to
        //    defaults, this test would have caught zero subAgents).
        expect(result.a.mainAgent?.systemPrompt).toContain('Director main agent');
        expect(Array.isArray(result.a.subAgents)).toBe(true);
        expect(result.a.subAgents.length).toBe(1);
        expect(result.a.subAgents[0].id).toBe('reef-reader');
        expect(result.a.maxRounds).toBe(7);
    });
});
