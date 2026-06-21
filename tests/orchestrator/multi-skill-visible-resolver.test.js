// Case #78 — Multi-skill visible: director sees N skills; sub-agent inherits (ported from e2e).
//
// Spec:
//   - Director's profile has 3+ visible skills (modeProfile.skills.visible
//     is a list, not just '*').
//   - Director's main agent prompt's `<available_skills>` block lists all 3.
//   - A dispatched sub-agent (no per-agent skills override → inherits the
//     mode default) sees the same 3.
//
// Source-of-truth: skill-resolution.js — `buildAvailableSkillsBlock`
// renders the catalog block; `resolveAgentVisibleSkills` performs the
// merge. When agentConfig.skills is absent / empty, modeProfile.skills
// is the effective visible list.
//
// What we port to Jest:
//   The two pure resolver tests — visibility/inheritance contracts that
//   need only a stubbed `skills.list` and the resolver under test. No
//   real director runtime, no mock LLM.
//
// The third case in the original e2e file ("live director dispatch:
// main agent prompt + dispatched sub-agent payload both contain the
// same `<available_skills>` block") stays as e2e — it asserts on the
// HTTP request bodies the production director runtime sends through
// the mock LLM, which is genuinely cross-module (preset library →
// director-runtime → chat-completion adapter → outbound request).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

const SKILL_NAMES = ['reef-rotation', 'lantern-protocol', 'salt-mark-history'];

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
let buildAvailableSkillsBlock;
let invalidateSkillInventory;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/orchestrator/skill-resolution.js');
    resolveAgentVisibleSkills = mod.resolveAgentVisibleSkills;
    buildAvailableSkillsBlock = mod.buildAvailableSkillsBlock;
    invalidateSkillInventory = mod.invalidateSkillInventory;
});

beforeEach(() => {
    invalidateSkillInventory();
    currentSkillsList = async () => [];
});

describe('#78 — Multi-skill visible: director sees N skills; sub-agent inherits', () => {
    test('mode profile with 3 visible skills → resolver returns all 3 for main agent + each sub-agent that inherits', async () => {
        // Three global-scope skills with the three names.
        currentSkillsList = async () => SKILL_NAMES.map(n => ({
            name: n,
            description: `Description for ${n}.`,
            scope: { kind: 'global' },
        }));

        // Mode profile: explicitly visible = the 3 names (not '*').
        const modeProfile = {
            skills: {
                visible: [...SKILL_NAMES],
                deny: [],
            },
        };

        // Main agent: agentConfig=null → inherits modeProfile.
        const mainVisible = await resolveAgentVisibleSkills({
            modeProfile,
            agentConfig: null,
            runtimeContext: {},
        });

        // Sub-agent 1: agentConfig has no skills field → inherits.
        const sub1Visible = await resolveAgentVisibleSkills({
            modeProfile,
            agentConfig: { id: 'sub1', systemPrompt: 'x' },
            runtimeContext: {},
        });

        // Sub-agent 2: agentConfig.skills.visible = [] → inherits
        // (per resolver doc: empty agent visible means inherit mode).
        const sub2Visible = await resolveAgentVisibleSkills({
            modeProfile,
            agentConfig: { skills: { visible: [], deny: [] } },
            runtimeContext: {},
        });

        // Sub-agent 3: agentConfig.skills.visible = ['+', extra]
        //   → inherits + appends extra (extra isn't in inventory
        //     so it's filtered out; result equals mode default).
        const sub3Visible = await resolveAgentVisibleSkills({
            modeProfile,
            agentConfig: { skills: { visible: ['+', 'nonexistent-skill'], deny: [] } },
            runtimeContext: {},
        });

        const mainBlock = buildAvailableSkillsBlock(mainVisible);
        const sub1Block = buildAvailableSkillsBlock(sub1Visible);

        // All four agent shapes see the same 3 inherited skills.
        const expected = [...SKILL_NAMES].sort();
        expect(mainVisible.map(s => s.name).sort()).toEqual(expected);
        expect(sub1Visible.map(s => s.name).sort()).toEqual(expected);
        expect(sub2Visible.map(s => s.name).sort()).toEqual(expected);
        expect(sub3Visible.map(s => s.name).sort()).toEqual(expected);

        // The rendered catalog block enumerates all 3 names in both the
        // main-agent and sub-agent variants — proving the catalog is
        // identical, not just the resolved list.
        for (const name of SKILL_NAMES) {
            expect(mainBlock).toContain(name);
            expect(sub1Block).toContain(name);
        }
        expect(mainBlock).toContain('<available_skills>');
        expect(mainBlock).toContain('</available_skills>');
        expect(sub1Block).toContain('<available_skills>');
        expect(sub1Block).toContain('</available_skills>');
    });

    test('agent-level deny adds to mode deny (union); a sub-agent denying one of the 3 visible skills loses just that one', async () => {
        currentSkillsList = async () => SKILL_NAMES.map(n => ({
            name: n,
            description: `Description for ${n}.`,
            scope: { kind: 'global' },
        }));

        const modeProfile = {
            skills: { visible: [...SKILL_NAMES], deny: [] },
        };

        const subWithDeny = await resolveAgentVisibleSkills({
            modeProfile,
            agentConfig: { skills: { visible: [], deny: [SKILL_NAMES[1]] } },
            runtimeContext: {},
        });

        const expected = SKILL_NAMES.filter(n => n !== SKILL_NAMES[1]).sort();
        expect(subWithDeny.map(s => s.name).sort()).toEqual(expected);
    });
});
