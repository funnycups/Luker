// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Pins the contract of `dispatchReadFields`, the per-mode
// `luker_orch_read_<mode>_fields` executor helper used by orchestrator
// iter-studio to satisfy read-first anchor-patch flows. The dispatcher
// is pure (no ST context, no side effects) so we test it directly
// without dragging main.js's ST-globals import graph into jest — the
// heavy shim setup in tests/orchestrator/ensure-settings-migration.test.js
// is overkill for a thin wrapper. See
// [[adapter_executor_lift_pattern]] for the general lift rationale.
//
// Signature after the Fix Wave 1 sanitization refactor: the dispatcher
// takes a pre-sanitized profile directly (mode-aware sanitization is
// the executor's responsibility). Tests build sanitized shapes inline
// to stay independent of the sanitizer implementations, and a
// dedicated "scratch field never leaks" test proves the boundary via
// the real sanitizer imported directly.

import { describe, test, expect } from '@jest/globals';
import { dispatchReadFields } from '../../public/scripts/extensions/orchestrator/iter-studio/read-fields-dispatcher.js';

const sampleDirectorProfile = Object.freeze({
    mainAgent: {
        systemPrompt: 'You are the main agent.',
        apiPresetName: '',
        promptPresetName: '',
    },
    subAgents: [
        { id: 'analyst_a', description: 'Reads and reports.', systemPrompt: 'You analyze.' },
        { id: 'analyst_b', description: 'Second analyst.', systemPrompt: 'Long prompt.' },
    ],
    tools: { note: { open: true, close: true }, memory: { node_create: false } },
    maxRounds: 40,
});

function makeSanitizedDirectorProfile() {
    return JSON.parse(JSON.stringify(sampleDirectorProfile));
}

describe('dispatchReadFields — director profile shape', () => {
    test('returns exact values for multiple paths', async () => {
        const sanitizedProfile = makeSanitizedDirectorProfile();
        const out = await dispatchReadFields({
            sanitizedProfile,
            args: { paths: ['mainAgent.systemPrompt', 'subAgents[0].description', 'maxRounds'] },
        });
        expect(out['mainAgent.systemPrompt']).toBe('You are the main agent.');
        expect(out['subAgents[0].description']).toBe('Reads and reports.');
        expect(out['maxRounds']).toBe(40);
        expect(out.missing_paths).toEqual([]);
    });

    test('unknown path returns null + adds to missing_paths', async () => {
        const sanitizedProfile = makeSanitizedDirectorProfile();
        const out = await dispatchReadFields({
            sanitizedProfile,
            args: { paths: ['mainAgent.systemPrompt', 'subAgents[99].id', 'tools.nonexistent.verb'] },
        });
        expect(out['mainAgent.systemPrompt']).toBe('You are the main agent.');
        expect(out['subAgents[99].id']).toBeNull();
        expect(out['tools.nonexistent.verb']).toBeNull();
        expect(out.missing_paths.sort()).toEqual(['subAgents[99].id', 'tools.nonexistent.verb'].sort());
    });

    test('value > 5KB is returned verbatim (no size-based truncation)', async () => {
        const sanitizedProfile = makeSanitizedDirectorProfile();
        sanitizedProfile.subAgents[0].systemPrompt = 'x'.repeat(6000);
        const out = await dispatchReadFields({
            sanitizedProfile,
            args: { paths: ['subAgents[0].systemPrompt'] },
        });
        // Read tools are narrow contracts — the caller named the exact
        // path, so it gets the exact value. No preview envelope, no
        // size cap; the caller is responsible for asking precisely.
        expect(out['subAgents[0].systemPrompt']).toBe('x'.repeat(6000));
    });

    test('empty paths array returns empty map with missing_paths=[]', async () => {
        const sanitizedProfile = makeSanitizedDirectorProfile();
        const out = await dispatchReadFields({ sanitizedProfile, args: { paths: [] } });
        expect(out.missing_paths).toEqual([]);
        // No keys other than missing_paths itself
        expect(Object.keys(out).filter((k) => k !== 'missing_paths')).toEqual([]);
    });

    test('non-array paths throws invalid_args', async () => {
        const sanitizedProfile = makeSanitizedDirectorProfile();
        await expect(
            dispatchReadFields({ sanitizedProfile, args: { paths: 'not an array' } }),
        ).rejects.toThrow(/invalid_args/);
    });

    test('missing sanitizedProfile is treated as empty root (all paths miss)', async () => {
        const out = await dispatchReadFields({ args: { paths: ['mainAgent.systemPrompt'] } });
        expect(out['mainAgent.systemPrompt']).toBeNull();
        expect(out.missing_paths).toEqual(['mainAgent.systemPrompt']);
    });
});

describe('dispatchReadFields — loop profile shape', () => {
    // The dispatcher is mode-agnostic (mode-specific sanitization happens
    // in the executor before this fires). We pin loop-shaped paths here
    // so a future change that hard-codes director keys shows up.
    const loopProfile = Object.freeze({
        system_prompt: 'You are a careful loop planner.',
        apiPresetName: '',
        promptPresetName: '',
        max_rounds: 20,
        wall_clock_budget_ms: 60000,
        tools: { finalize: true, memory: { node_create: false } },
    });
    test('reads loop-shaped paths', async () => {
        const sanitizedProfile = JSON.parse(JSON.stringify(loopProfile));
        const out = await dispatchReadFields({
            sanitizedProfile,
            args: { paths: ['system_prompt', 'max_rounds', 'tools.memory.node_create'] },
        });
        expect(out['system_prompt']).toBe('You are a careful loop planner.');
        expect(out['max_rounds']).toBe(20);
        expect(out['tools.memory.node_create']).toBe(false);
        expect(out.missing_paths).toEqual([]);
    });
});

describe('dispatchReadFields — agenda profile shape', () => {
    const agendaProfile = Object.freeze({
        planner: { systemPrompt: 'You plan.', userPromptTemplate: '' },
        agents: {
            worker_a: { systemPrompt: 'You work.', userPromptTemplate: 'do the thing' },
        },
        finalAgentId: 'worker_a',
        limits: { plannerMaxRounds: 5, maxConcurrentAgents: 3, maxTotalRuns: 10 },
    });
    test('reads agenda-shaped paths', async () => {
        const sanitizedProfile = JSON.parse(JSON.stringify(agendaProfile));
        const out = await dispatchReadFields({
            sanitizedProfile,
            args: { paths: ['planner.systemPrompt', 'agents.worker_a.userPromptTemplate', 'finalAgentId', 'limits.plannerMaxRounds'] },
        });
        expect(out['planner.systemPrompt']).toBe('You plan.');
        expect(out['agents.worker_a.userPromptTemplate']).toBe('do the thing');
        expect(out['finalAgentId']).toBe('worker_a');
        expect(out['limits.plannerMaxRounds']).toBe(5);
    });
});

describe('dispatchReadFields — spec profile shape', () => {
    const specProfile = Object.freeze({
        spec: {
            stages: [
                { id: 'stage_a', mode: 'serial', nodes: [{ id: 'n1', preset: 'p1', type: 'worker' }] },
            ],
        },
        presets: { p1: { systemPrompt: 'p1 identity' } },
    });
    test('reads spec-shaped paths', async () => {
        const sanitizedProfile = JSON.parse(JSON.stringify(specProfile));
        const out = await dispatchReadFields({
            sanitizedProfile,
            args: { paths: ['spec.stages[0].id', 'spec.stages[0].nodes[0].preset', 'presets.p1.systemPrompt'] },
        });
        expect(out['spec.stages[0].id']).toBe('stage_a');
        expect(out['spec.stages[0].nodes[0].preset']).toBe('p1');
        expect(out['presets.p1.systemPrompt']).toBe('p1 identity');
    });
});

// -------------------------------------------------------------
// Sanitization boundary — proves the caller-side sanitizer strips
// scratch fields before the dispatcher ever sees them. This is the
// FIX 2 (Fix Wave 1) proof: a future scratch field / debug slot on
// `session.workingProfile` cannot leak to the LLM via read-fields
// because the executor sanitizes at the call site.
//
// We import the real sanitizer directly and pipe its output through
// the dispatcher, asserting `_scratch` never reaches the response.
// -------------------------------------------------------------
describe('sanitization boundary — scratch fields never reach the LLM', () => {
    test('sanitizeLoopProfile strips _scratch before dispatchReadFields sees it', async () => {
        const { sanitizeLoopProfile } = await import('../../public/scripts/extensions/orchestrator/persistence.js');
        // Build a live-shape profile with a scratch/debug slot the
        // sanitizer must strip.
        const liveProfile = {
            system_prompt: 'careful planner',
            max_rounds: 20,
            _scratch: 'internal secret — must never reach the LLM',
        };
        const sanitizedProfile = sanitizeLoopProfile(liveProfile);
        // Precondition: sanitizer actually removed the field.
        expect(sanitizedProfile._scratch).toBeUndefined();
        // Now pipe through dispatcher and assert both:
        //   (a) reading the real field still works
        //   (b) reading the scratch field returns null + missing_paths
        //       (never leaks the value)
        const out = await dispatchReadFields({
            sanitizedProfile,
            args: { paths: ['system_prompt', '_scratch'] },
        });
        expect(out['system_prompt']).toBe('careful planner');
        expect(out['_scratch']).toBeNull();
        expect(out.missing_paths).toContain('_scratch');
        // Structural: no key or value anywhere in the response carries
        // the scratch string. Walk all values defensively.
        const flat = JSON.stringify(out);
        expect(flat).not.toContain('internal secret');
    });
});
