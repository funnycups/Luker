// Case #73 — Skill resolution: 3-scope precedence (global / preset / character)
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
// This test stubs the skillsApi to return a controlled inventory and
// asserts the merge picks the highest-precedence entry per name.

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
    mock = await startMockLLM({ scriptedReplies: ['*ack*'] });
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '73-skill-resolution' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#73 — Skill resolution: 3-scope precedence', () => {
    test('character > preset > global; resolver merges and the highest-precedence entry wins per name', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Stub the skillsApi inventory: three entries with the same name
        // at three different scopes. resolveAgentVisibleSkills should pick
        // the character-scope one for `reef-rotation`, the preset-scope
        // one for `lantern-protocol` (no character override), and the
        // global one for `salt-mark-history` (no preset / character).
        const merged = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/skill-resolution.js');
            const ctx = window.Luker.getContext();
            mod.invalidateSkillInventory();
            const originalList = ctx.skills.list;

            ctx.skills.list = async () => ([
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

            try {
                const visible = await mod.resolveAgentVisibleSkills({
                    modeProfile: { skills: { visible: ['*'], deny: [] } },
                    agentConfig: null,
                    runtimeContext: { presetName: 'rp4', characterFile: 'ash.png' },
                });
                return {
                    visible: visible.map(s => ({
                        name: s.name,
                        description: s.description,
                        scope: s.scope,
                    })),
                };
            } finally {
                ctx.skills.list = originalList;
                mod.invalidateSkillInventory();
            }
        });

        // The merge produces one entry per name. character-scope reef-rotation
        // wins, preset-scope lantern-protocol wins, global-only salt-mark-history.
        const byName = new Map(merged.visible.map(s => [s.name, s]));

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
        expect(merged.visible.length).toBe(3);
    });

    test('runtimeContext without presetName/characterFile collapses to global-only scope', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const visible = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/skill-resolution.js');
            const ctx = window.Luker.getContext();
            mod.invalidateSkillInventory();
            const orig = ctx.skills.list;

            ctx.skills.list = async () => ([
                { name: 'a', scope: { kind: 'global' }, description: 'g' },
                { name: 'a', scope: { kind: 'preset', name: 'rp4' }, description: 'p' },
                { name: 'a', scope: { kind: 'character', characterFile: 'x.png' }, description: 'c' },
            ]);

            try {
                const res = await mod.resolveAgentVisibleSkills({
                    modeProfile: { skills: { visible: ['*'], deny: [] } },
                    agentConfig: null,
                    runtimeContext: {}, // No preset, no character: only global scope visible.
                });
                return res.map(s => ({ name: s.name, scope: s.scope, description: s.description }));
            } finally {
                ctx.skills.list = orig;
                mod.invalidateSkillInventory();
            }
        });

        expect(visible.length).toBe(1);
        expect(visible[0].scope.kind).toBe('global');
        expect(visible[0].description).toBe('g');
    });
});
