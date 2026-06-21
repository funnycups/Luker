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

describe('#73 — Skill resolution: 3-scope precedence', () => {
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
});
