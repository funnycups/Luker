import './_mocks/luker-zh.js';
import { test, expect } from '@jest/globals';
import {
    PROFILE, addAgendaAgent, addNode, addPresetEntry, addStage, addSubAgent, applyChanges, canHold, diffProfiles, fieldLabel, getField,
    invertChanges, mergeChanges, moveNode, moveStage, removeAgendaAgent, removeNode, removePresetEntry, removeStage, removeSubAgent,
    setDefaultTools, setField, setNodeProp, validateStructure, withToolFlag,
} from '../../../public/scripts/extensions/orchestrator/lens/model/edit.js';
import { createDrafts } from '../../../public/scripts/extensions/orchestrator/lens/model/drafts.js';

const spec = () => ({
    spec: { stages: [
        { id: 'a', mode: 'serial', nodes: [{ id: 'one', preset: 'one', type: 'worker', userPromptTemplate: '' }] },
        { id: 'b', mode: 'parallel', nodes: [{ id: 'two', preset: 'two', type: 'worker', userPromptTemplate: '' }, 'one'] },
    ], defaultTools: { note: { open: true } } },
    presets: { one: { systemPrompt: 'S1' }, two: { systemPrompt: 'S2' } },
});
const target = { mode: 'spec', scope: 'global', presetId: 'x' };

test('stage and node operations return a new profile', () => {
    const base = spec();
    const added = addStage(base);
    expect(base.spec.stages).toHaveLength(2);
    expect(added.spec.stages[2].id).toBe('stage_3');
    expect(moveStage(base, 1, -1).spec.stages.map(s => s.id)).toEqual(['b', 'a']);
    expect(moveStage(base, 0, -1).spec.stages.map(s => s.id)).toEqual(['a', 'b']);
    expect(removeStage(removeStage(base, 0), 0).spec.stages).toHaveLength(1);
    expect(addNode(base, 0).spec.stages[0].nodes).toHaveLength(2);
    expect(moveNode(base, 1, 0, 1).spec.stages[1].nodes[1].id).toBe('two');
    expect(removeNode(base, 0, 0).spec.stages[0].nodes).toHaveLength(1);
    expect(setNodeProp(base, 1, 1, 'type', 'review').spec.stages[1].nodes[1]).toMatchObject({ id: 'one', type: 'review' });
});

test('preset entries: add, duplicate id, in-use', () => {
    const next = addPresetEntry(spec(), 'three');
    expect(next.presets.three.systemPrompt).toBe('');
    expect(() => addPresetEntry(spec(), 'one')).toThrow();
    expect(() => addPresetEntry(spec(), 'a b')).toThrow();
    expect(() => removePresetEntry(spec(), 'one')).toThrow();
    expect(removePresetEntry(next, 'three').presets.three).toBeUndefined();
});

test('diff, apply and undo round-trip structural changes', () => {
    const before = spec();
    const after = addPresetEntry(addStage(before), 'three');
    const changes = diffProfiles('spec', before, after);
    expect(changes.map(c => c.id).sort()).toEqual([`${PROFILE}.presets/three`, `${PROFILE}.spec/stages`]);
    const applied = applyChanges('spec', before, changes);
    expect(diffProfiles('spec', after, applied)).toEqual([]);
    const undone = applyChanges('spec', applied, invertChanges(changes));
    expect(diffProfiles('spec', before, undone)).toEqual([]);
    expect(undone.presets.three).toBeUndefined();
});

test('field edits land on top of slots; removed agents are skipped', () => {
    const before = spec();
    const stages = diffProfiles('spec', before, addStage(before))[0];
    const edit = { id: 'one.system', agentId: 'one', field: 'system', before: 'S1', after: 'edited' };
    expect(getField('spec', applyChanges('spec', before, [edit, stages]), 'one', 'system')).toBe('edited');
    const gone = { agentId: PROFILE, field: 'presets/two', before: '{}', after: '' };
    const stray = { agentId: 'nobody', field: 'system', before: '', after: 'x' };
    expect(applyChanges('spec', before, [gone, stray]).presets.two).toBeUndefined();
});

test('per-node tools are a field, not a stage change', () => {
    const before = spec();
    const after = setField('spec', before, 'one', 'tools', JSON.stringify({ note: { open: true } }));
    expect(diffProfiles('spec', before, after).map(c => c.id)).toEqual(['one.tools']);
    expect(getField('spec', setField('spec', after, 'one', 'tools', ''), 'one', 'tools')).toBe('');
});

test('a slot changed elsewhere is a conflict', () => {
    const before = spec();
    const changes = diffProfiles('spec', before, addStage(before));
    const elsewhere = moveStage(before, 1, -1);
    expect(mergeChanges('spec', elsewhere, changes).conflicts).toHaveLength(1);
    expect(mergeChanges('spec', before, changes).conflicts).toHaveLength(0);
});

test('agenda agents, final agent and default tools', () => {
    const base = { agents: { a: { systemPrompt: '1' }, b: { systemPrompt: '2', tools: { note: { open: true } } } }, finalAgentId: 'a', defaultTools: {} };
    expect(Object.keys(addAgendaAgent(base, 'c').agents)).toEqual(['a', 'b', 'c']);
    expect(removeAgendaAgent(base, 'a').finalAgentId).toBe('b');
    const off = setDefaultTools('agenda', base, null, { clearOverrides: true });
    expect(off.defaultTools).toBeNull();
    expect(off.agents.b.tools).toBeNull();
    expect(withToolFlag({}, 'custom.my.tool', false).custom['my.tool']).toBe(false);
});

test('director sub-agents and maxRounds', () => {
    const base = { mainAgent: { systemPrompt: 'm' }, subAgents: [{ id: 's', systemPrompt: 'x', maxRounds: null }], tools: {} };
    const added = addSubAgent(base, 'n');
    expect(added.subAgents.map(a => a.id)).toEqual(['s', 'n']);
    expect(() => addSubAgent(base, 's')).toThrow();
    const changes = diffProfiles('director', base, added);
    expect(changes.map(c => c.field)).toEqual(['subAgents/n']);
    expect(applyChanges('director', base, changes).subAgents).toHaveLength(2);
    expect(removeSubAgent(base, 's').subAgents).toEqual([]);
    expect(getField('director', setField('director', base, 's', 'maxRounds', '5'), 's', 'maxRounds')).toBe('5');
    expect(fieldLabel('subAgents/n')).toContain('n');
});

test('loop tools and lorebook filter', () => {
    const base = { system_prompt: 's', tools: { note: { open: false } }, lorebookFilter: { bookPattern: '' } };
    const after = { ...setField('loop', base, 'loop_agent', 'tools', JSON.stringify({ note: { open: true } })), lorebookFilter: { bookPattern: 'x' } };
    expect(diffProfiles('loop', base, after).map(c => c.id).sort()).toEqual([`${PROFILE}.lorebookFilter`, 'loop_agent.tools']);
});

test('validateStructure', () => {
    expect(validateStructure('spec', spec())).toEqual([]);
    const missing = spec();
    missing.spec.stages[0].nodes[0].preset = 'nope';
    expect(validateStructure('spec', missing)).toHaveLength(1);
    const dup = spec();
    dup.spec.stages[1].id = 'a';
    expect(validateStructure('spec', dup)).toHaveLength(1);
    expect(validateStructure('agenda', { agents: {}, finalAgentId: '' })).toHaveLength(1);
    expect(validateStructure('agenda', { agents: { a: {} }, finalAgentId: 'z' })).toHaveLength(1);
    expect(validateStructure('director', { subAgents: [{ id: 's', systemPrompt: '' }] })).toHaveLength(1);
});

test('drafts: setProfile, new agent fields, reload', () => {
    const drafts = createDrafts();
    const base = spec();
    drafts.setBase(target, base);
    drafts.setProfile(addPresetEntry(base, 'three'));
    expect(drafts.count()).toBe(1);
    drafts.set('three', 'system', 'new prompt');
    expect(drafts.get('three', 'system')).toBe('new prompt');
    expect(drafts.profile().presets.three.systemPrompt).toBe('new prompt');
    drafts.setBase(target, spec());
    expect(drafts.profile().presets.three.systemPrompt).toBe('new prompt');
    expect(canHold('spec', base, PROFILE, 'anything')).toBe(true);
    const snap = drafts.snapshot();
    drafts.discard();
    expect(drafts.profile().presets.three).toBeUndefined();
    drafts.restore(snap);
    expect(drafts.count()).toBe(2);
});
