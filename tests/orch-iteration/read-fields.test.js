// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Pins the contract of `dispatchReadFields`, the per-mode
// `luker_orch_read_<mode>_fields` executor used by orchestrator
// iter-studio to satisfy read-first anchor-patch flows. The dispatcher
// is pure (no ST context, no side effects) so we test it directly
// without dragging main.js's ST-globals import graph into jest — the
// heavy shim setup in tests/orchestrator/ensure-settings-migration.test.js
// is overkill for a thin wrapper. See
// [[adapter_executor_lift_pattern]] for the general lift rationale.

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

function makeSession() {
    return {
        mode: 'director',
        workingProfile: JSON.parse(JSON.stringify(sampleDirectorProfile)),
    };
}

describe('dispatchReadFields — director profile shape', () => {
    test('returns exact values for multiple paths', async () => {
        const session = makeSession();
        const out = await dispatchReadFields({
            session,
            args: { paths: ['mainAgent.systemPrompt', 'subAgents[0].description', 'maxRounds'] },
        });
        expect(out['mainAgent.systemPrompt']).toBe('You are the main agent.');
        expect(out['subAgents[0].description']).toBe('Reads and reports.');
        expect(out['maxRounds']).toBe(40);
        expect(out.missing_paths).toEqual([]);
    });

    test('unknown path returns null + adds to missing_paths', async () => {
        const session = makeSession();
        const out = await dispatchReadFields({
            session,
            args: { paths: ['mainAgent.systemPrompt', 'subAgents[99].id', 'tools.nonexistent.verb'] },
        });
        expect(out['mainAgent.systemPrompt']).toBe('You are the main agent.');
        expect(out['subAgents[99].id']).toBeNull();
        expect(out['tools.nonexistent.verb']).toBeNull();
        expect(out.missing_paths.sort()).toEqual(['subAgents[99].id', 'tools.nonexistent.verb'].sort());
    });

    test('value > 5KB returns truncation envelope', async () => {
        const session = makeSession();
        session.workingProfile.subAgents[0].systemPrompt = 'x'.repeat(6000);
        const out = await dispatchReadFields({
            session,
            args: { paths: ['subAgents[0].systemPrompt'] },
        });
        const val = out['subAgents[0].systemPrompt'];
        expect(val).toEqual(expect.objectContaining({
            __truncated__: true,
            length: 6000,
        }));
        expect(typeof val.preview).toBe('string');
        expect(val.preview.length).toBe(200);
    });

    test('empty paths array returns empty map with missing_paths=[]', async () => {
        const session = makeSession();
        const out = await dispatchReadFields({ session, args: { paths: [] } });
        expect(out.missing_paths).toEqual([]);
        // No keys other than missing_paths itself
        expect(Object.keys(out).filter((k) => k !== 'missing_paths')).toEqual([]);
    });

    test('non-array paths throws invalid_args', async () => {
        const session = makeSession();
        await expect(
            dispatchReadFields({ session, args: { paths: 'not an array' } }),
        ).rejects.toThrow(/invalid_args/);
    });

    test('missing session workingProfile is treated as empty root (all paths miss)', async () => {
        const out = await dispatchReadFields({ session: {}, args: { paths: ['mainAgent.systemPrompt'] } });
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
        const session = { mode: 'loop', workingProfile: JSON.parse(JSON.stringify(loopProfile)) };
        const out = await dispatchReadFields({
            session,
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
        const session = { mode: 'agenda', workingProfile: JSON.parse(JSON.stringify(agendaProfile)) };
        const out = await dispatchReadFields({
            session,
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
        const session = { mode: 'spec', workingProfile: JSON.parse(JSON.stringify(specProfile)) };
        const out = await dispatchReadFields({
            session,
            args: { paths: ['spec.stages[0].id', 'spec.stages[0].nodes[0].preset', 'presets.p1.systemPrompt'] },
        });
        expect(out['spec.stages[0].id']).toBe('stage_a');
        expect(out['spec.stages[0].nodes[0].preset']).toBe('p1');
        expect(out['presets.p1.systemPrompt']).toBe('p1 identity');
    });
});
