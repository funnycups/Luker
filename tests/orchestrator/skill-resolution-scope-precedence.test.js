// Case #73 — Skill resolution: 3-scope precedence (ported from e2e).
//
// Spec:
//   - Same skill name at preset / character / global scopes.
//   - The resolver merges them with last-wins semantics: global → preset →
//     character. The character-scope entry wins.
//
// Source-of-truth check: see skill-resolution.js's resolveAgentVisibleSkills
// (lines 117-140): the merge order is global, then preset (if presetName),
// then character (if characterFile). Later entries supersede earlier ones
// by virtue of overwriting the same Map key.
//
// We stub `Luker.getContext()` BEFORE the production module is imported so
// the module-load-time `skillsApi = Luker.getContext().skills` binding
// captures our controlled `list` function. The shared `mutableSkillsList`
// closure lets each test rewrite the inventory before invoking the
// resolver — the resolver caches the inventory for ~5s, so each test
// also invalidates the cache first.

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

let currentSkillsList = async () => [];

// Install BEFORE import — the production module captures
// `Luker.getContext().skills` at module-load time.
globalThis.Luker = {
    getContext: () => ({
        skills: {
            list: async (...args) => currentSkillsList(...args),
        },
        translate: (s) => String(s ?? ''),
        addLocaleData: () => {},
    }),
};

let resolveAgentVisibleSkills;
let invalidateSkillInventory;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/orchestrator/skill-resolution.js');
    resolveAgentVisibleSkills = mod.resolveAgentVisibleSkills;
    invalidateSkillInventory = mod.invalidateSkillInventory;
});

beforeEach(() => {
    invalidateSkillInventory();
    currentSkillsList = async () => [];
});

describe('#73 — Skill resolution: 4-scope precedence', () => {
    test('character > preset > global; resolver merges and the highest-precedence entry wins per name', async () => {
        // Stub the skillsApi inventory: three entries with the same name
        // at three different scopes. resolveAgentVisibleSkills should pick
        // the character-scope one for `reef-rotation`, the preset-scope
        // one for `lantern-protocol` (no character override), and the
        // global one for `salt-mark-history` (no preset / character).
        currentSkillsList = async () => ([
            // `reef-rotation` exists in all three scopes; character wins.
            {
                name: 'reef-rotation',
                description: 'GLOBAL: stale rotation cycle.',
                scope: { kind: 'global' },
            },
            {
                name: 'reef-rotation',
                description: 'PRESET: rp4 preset rotation cycle.',
                scope: { kind: 'preset', name: 'rp4' },
            },
            {
                name: 'reef-rotation',
                description: 'CHARACTER: ash-the-cartographer rotation cycle (most recent).',
                scope: { kind: 'character', characterFile: 'ash.png' },
            },
            // `lantern-protocol` exists at global + preset only; preset wins.
            {
                name: 'lantern-protocol',
                description: 'GLOBAL: generic lantern protocol.',
                scope: { kind: 'global' },
            },
            {
                name: 'lantern-protocol',
                description: 'PRESET: rp4-tuned lantern protocol.',
                scope: { kind: 'preset', name: 'rp4' },
            },
            // `salt-mark-history` global only.
            {
                name: 'salt-mark-history',
                description: 'GLOBAL: salt-mark drifter history.',
                scope: { kind: 'global' },
            },
        ]);

        const visible = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: { presetName: 'rp4', characterFile: 'ash.png' },
        });

        // The merge produces one entry per name. character-scope reef-rotation
        // wins, preset-scope lantern-protocol wins, global-only salt-mark-history.
        const byName = new Map(visible.map(s => [s.name, s]));

        expect(byName.has('reef-rotation')).toBe(true);
        expect(byName.has('lantern-protocol')).toBe(true);
        expect(byName.has('salt-mark-history')).toBe(true);

        expect(byName.get('reef-rotation').description).toMatch(/^CHARACTER:/);
        expect(byName.get('reef-rotation').scope.kind).toBe('character');

        expect(byName.get('lantern-protocol').description).toMatch(/^PRESET:/);
        expect(byName.get('lantern-protocol').scope.kind).toBe('preset');

        expect(byName.get('salt-mark-history').description).toMatch(/^GLOBAL:/);
        expect(byName.get('salt-mark-history').scope.kind).toBe('global');

        // Exactly 3 unique names — no duplicates from imperfect merge.
        expect(visible.length).toBe(3);
    });

    test('runtimeContext without presetName/characterFile collapses to global-only scope', async () => {
        currentSkillsList = async () => ([
            { name: 'a', scope: { kind: 'global' }, description: 'g' },
            { name: 'a', scope: { kind: 'preset', name: 'rp4' }, description: 'p' },
            { name: 'a', scope: { kind: 'character', characterFile: 'x.png' }, description: 'c' },
        ]);

        const res = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: {}, // No preset, no character: only global scope visible.
        });

        expect(res.length).toBe(1);
        expect(res[0].scope.kind).toBe('global');
        expect(res[0].description).toBe('g');
    });

    test('orch-preset overrides oai-preset when both scopes have the same skill name', async () => {
        currentSkillsList = async () => ([
            {
                name: 'lantern-protocol',
                description: 'GLOBAL: generic.',
                scope: { kind: 'global' },
            },
            {
                name: 'lantern-protocol',
                description: 'PRESET: rp4 preset-tuned.',
                scope: { kind: 'preset', name: 'rp4' },
            },
            {
                name: 'lantern-protocol',
                description: 'ORCH-PRESET: director/tactician-preset-tuned.',
                scope: { kind: 'orch-preset', mode: 'director', name: 'tactician' },
            },
        ]);

        const visible = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: {
                presetName: 'rp4',
                orchPreset: { mode: 'director', name: 'tactician' },
            },
        });

        expect(visible.length).toBe(1);
        expect(visible[0].description).toMatch(/^ORCH-PRESET:/);
        expect(visible[0].scope.kind).toBe('orch-preset');
        expect(visible[0].scope.mode).toBe('director');
        expect(visible[0].scope.name).toBe('tactician');
    });

    test('character > orch-preset > oai-preset > global full precedence chain', async () => {
        currentSkillsList = async () => ([
            // reef-rotation at all 4 layers; character wins.
            { name: 'reef-rotation', description: 'GLOBAL',      scope: { kind: 'global' } },
            { name: 'reef-rotation', description: 'PRESET',      scope: { kind: 'preset', name: 'rp4' } },
            { name: 'reef-rotation', description: 'ORCH-PRESET', scope: { kind: 'orch-preset', mode: 'director', name: 'tactician' } },
            { name: 'reef-rotation', description: 'CHARACTER',   scope: { kind: 'character', characterFile: 'ash.png' } },
            // salt-mark at 3 layers (no character); orch-preset wins.
            { name: 'salt-mark',     description: 'GLOBAL',      scope: { kind: 'global' } },
            { name: 'salt-mark',     description: 'PRESET',      scope: { kind: 'preset', name: 'rp4' } },
            { name: 'salt-mark',     description: 'ORCH-PRESET', scope: { kind: 'orch-preset', mode: 'director', name: 'tactician' } },
            // moss-signal at 2 layers (no orch-preset override); preset wins.
            { name: 'moss-signal',   description: 'GLOBAL',      scope: { kind: 'global' } },
            { name: 'moss-signal',   description: 'PRESET',      scope: { kind: 'preset', name: 'rp4' } },
        ]);

        const visible = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: {
                presetName: 'rp4',
                orchPreset: { mode: 'director', name: 'tactician' },
                characterFile: 'ash.png',
            },
        });

        const byName = new Map(visible.map(s => [s.name, s]));
        expect(byName.get('reef-rotation').description).toBe('CHARACTER');
        expect(byName.get('salt-mark').description).toBe('ORCH-PRESET');
        expect(byName.get('moss-signal').description).toBe('PRESET');
        expect(visible.length).toBe(3);
    });

    test('orch-preset filter is name+mode specific — wrong mode does not leak', async () => {
        currentSkillsList = async () => ([
            {
                name: 'plan-x',
                description: 'AGENDA scope',
                scope: { kind: 'orch-preset', mode: 'agenda', name: 'foo' },
            },
            {
                name: 'plan-x',
                description: 'DIRECTOR scope (same name, different mode)',
                scope: { kind: 'orch-preset', mode: 'director', name: 'foo' },
            },
            {
                name: 'plan-x',
                description: 'GLOBAL fallback',
                scope: { kind: 'global' },
            },
        ]);

        const visible = await resolveAgentVisibleSkills({
            modeProfile: { skills: { visible: ['*'], deny: [] } },
            agentConfig: null,
            runtimeContext: {
                orchPreset: { mode: 'agenda', name: 'foo' },
            },
        });

        expect(visible.length).toBe(1);
        expect(visible[0].description).toBe('AGENDA scope');
    });
});

describe('buildSkillRuntimeContext — orch-preset carrier', () => {
    let buildSkillRuntimeContext;
    beforeAll(async () => {
        const mod = await import('../../public/scripts/extensions/orchestrator/skill-resolution.js');
        buildSkillRuntimeContext = mod.buildSkillRuntimeContext;
    });

    test('lifts orchPreset from third argument into runtimeContext', () => {
        const ctx = buildSkillRuntimeContext(
            { characterId: null },
            null,
            { mode: 'director', name: 'tactician' },
        );
        expect(ctx.orchPreset).toEqual({ mode: 'director', name: 'tactician' });
    });

    test('omits orchPreset when third argument is null (backward compatibility)', () => {
        const ctx = buildSkillRuntimeContext({ characterId: null }, null);
        expect(ctx.orchPreset).toBeUndefined();
    });

    test('omits orchPreset when third argument is malformed (no mode or no name)', () => {
        expect(buildSkillRuntimeContext(null, null, { mode: 'director' }).orchPreset).toBeUndefined();
        expect(buildSkillRuntimeContext(null, null, { name: 'x' }).orchPreset).toBeUndefined();
        expect(buildSkillRuntimeContext(null, null, {}).orchPreset).toBeUndefined();
    });
});
