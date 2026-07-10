// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { jest } from '@jest/globals';

// -------------------------------------------------------------------------
// Card fixture: two card-embedded presets (Shared, CardOnly) plus a
// GlobalOnly preset that lives only in the local global set.  The
// resolveByName function passed into `collectUnembeddedPresets` matches
// the card-first behavior of ctx.character.presets.resolveByName so we
// can prove the collect helper filters correctly.
// -------------------------------------------------------------------------
const character = {
    avatar: 'Aqua.png',
    data: {
        extensions: {
            luker: {
                chat_completion_preset: {
                    presets: [
                        { name: 'Shared', preset: { __from: 'card' } },
                        { name: 'CardOnly', preset: { __from: 'card' } },
                    ],
                    defaultPresetName: 'Shared',
                },
            },
        },
    },
};

const resolveByName = jest.fn((c, name) => {
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    const state = c?.data?.extensions?.luker?.chat_completion_preset;
    const hit = state?.presets?.find(p => p.name === trimmed);
    if (hit) return { name: trimmed, preset: hit.preset, origin: 'card' };
    if (trimmed === 'GlobalOnly') return { name: trimmed, preset: { __from: 'global' }, origin: 'global' };
    if (trimmed === 'AnotherGlobal') return { name: trimmed, preset: { __from: 'global' }, origin: 'global' };
    return null;
});

const { collectUnembeddedPresets } = await import(
    '/scripts/extensions/orchestrator/collect-unembedded-presets.js'
);

beforeEach(() => { resolveByName.mockClear(); });

test('loop mode: flags root promptPresetName only when unembedded', () => {
    const profile = { mode: 'loop', apiPresetName: '', promptPresetName: 'GlobalOnly' };
    const list = collectUnembeddedPresets(profile, character, resolveByName);
    expect(list.map(x => x.name)).toEqual(['GlobalOnly']);
    expect(list[0].usages).toEqual(['loop root prompt preset']);
});

test('loop mode: card-embedded root preset is skipped', () => {
    const profile = { mode: 'loop', apiPresetName: '', promptPresetName: 'Shared' };
    const list = collectUnembeddedPresets(profile, character, resolveByName);
    expect(list).toEqual([]);
});

test('loop mode: unknown name resolves to null and is skipped', () => {
    const profile = { mode: 'loop', apiPresetName: 'Missing', promptPresetName: 'GlobalOnly' };
    const list = collectUnembeddedPresets(profile, character, resolveByName);
    expect(list.map(x => x.name)).toEqual(['GlobalOnly']);
});

test('agenda mode: planner + agent fields are all considered', () => {
    const profile = {
        mode: 'agenda',
        planner: { plannerPromptPresetName: 'GlobalOnly', plannerApiPresetName: '' },
        agents: {
            a1: { name: 'Alpha', promptPresetName: 'CardOnly' },
            a2: { name: 'Beta', promptPresetName: 'GlobalOnly' },
            a3: { name: 'Gamma', promptPresetName: 'AnotherGlobal' },
        },
    };
    const list = collectUnembeddedPresets(profile, character, resolveByName);
    const names = list.map(x => x.name).sort();
    expect(names).toEqual(['AnotherGlobal', 'GlobalOnly']);
    // Dedupe by name — a2 references GlobalOnly as its prompt preset AND
    // the planner also references it. Both usages should be surfaced.
    const globalOnly = list.find(x => x.name === 'GlobalOnly');
    expect(globalOnly.usages).toContain('planner prompt preset');
    expect(globalOnly.usages.some(u => u.includes('Beta'))).toBe(true);
});

test('director mode: main agent + sub-agents are all considered', () => {
    const profile = {
        mode: 'director',
        mainAgent: { promptPresetName: 'Shared', apiPresetName: 'GlobalOnly' },
        subAgents: [
            { id: 'blade', name: 'Blade', promptPresetName: 'GlobalOnly' },
            { id: 'archer', name: 'Archer', promptPresetName: 'CardOnly' },
        ],
    };
    const list = collectUnembeddedPresets(profile, character, resolveByName);
    const names = list.map(x => x.name).sort();
    expect(names).toEqual(['GlobalOnly']);
    const usages = list[0].usages;
    expect(usages).toContain('director main API preset');
    expect(usages.some(u => u.includes('Blade'))).toBe(true);
});

test('director sub-agent without a name falls back to id', () => {
    const profile = {
        mode: 'director',
        mainAgent: { promptPresetName: '', apiPresetName: '' },
        subAgents: [
            { id: 'nameless-1', promptPresetName: 'GlobalOnly' },
        ],
    };
    const list = collectUnembeddedPresets(profile, character, resolveByName);
    expect(list).toHaveLength(1);
    expect(list[0].usages[0]).toContain('nameless-1');
});

test('spec mode is out of scope: returns empty list even with unembedded refs', () => {
    // Spec-mode preset names live inside profile.presets[nodeId].apiPresetName
    // etc.; this helper only covers loop/agenda/director agent-level refs
    // (spec-mode editing has its own iter-studio path).
    const profile = {
        mode: 'spec',
        presets: { node1: { promptPresetName: 'GlobalOnly' } },
    };
    const list = collectUnembeddedPresets(profile, character, resolveByName);
    expect(list).toEqual([]);
});

test('missing character (no card selected) returns empty list', () => {
    const profile = { mode: 'loop', promptPresetName: 'GlobalOnly' };
    const list = collectUnembeddedPresets(profile, null, resolveByName);
    expect(list).toEqual([]);
});

test('missing resolveByName injector returns empty list', () => {
    const profile = { mode: 'loop', promptPresetName: 'GlobalOnly' };
    // Guards against the ctx layer being unavailable at call time (e.g.
    // extension bootstrap ordering); no throw, just no work.
    expect(collectUnembeddedPresets(profile, character, null)).toEqual([]);
    expect(collectUnembeddedPresets(profile, character, undefined)).toEqual([]);
});

test('empty / whitespace preset names are ignored', () => {
    const profile = {
        mode: 'loop',
        apiPresetName: '   ',
        promptPresetName: '',
    };
    const list = collectUnembeddedPresets(profile, character, resolveByName);
    expect(list).toEqual([]);
});
