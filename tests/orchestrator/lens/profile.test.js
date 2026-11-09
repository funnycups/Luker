import './_mocks/luker-zh.js';
import { test, expect } from '@jest/globals';
import { buildFlow, enabledTools } from '../../../public/scripts/extensions/orchestrator/lens/model/profile.js';
import { PROFILES } from './_mocks/mock-data.js';
import { agentName, toolName, humanizeId } from '../../../public/scripts/extensions/orchestrator/lens/i18n.js';

test('spec: one column per stage, parallel flag, review forces serial', () => {
    const flow = buildFlow(PROFILES.spec, { mode: 'spec' });
    expect(flow.columns.map(c => c.id)).toEqual(['distill', 'grounding', 'reason', 'review', 'finalize']);
    expect(flow.columns[1].parallel).toBe(true);
    expect(flow.columns[3].review).toBe(true);
    expect(flow.columns[3].parallel).toBe(false);
    expect(flow.columns.at(-1).final).toBe(true);
    expect(flow.agents.critic.kind).toBe('review');
    expect(flow.agents.lorebook_reader.apiPreset).toBe('Gemini Flash');
    expect(flow.agents.distiller.userPrompt).toMatch(/recent_chat/);
    expect(flow.output).toBe('capsule');
});

test('spec: node-level template and tools override the preset', () => {
    const flow = buildFlow({
        spec: { stages: [{ id: 's', mode: 'parallel', nodes: [{ id: 'a', preset: 'p', userPromptTemplate: 'custom', tools: { chat: { search: true } } }, 'p'] }] },
        presets: { p: { systemPrompt: 'sys', userPromptTemplate: 'base' } },
    }, { mode: 'spec' });
    expect(flow.agents.a.userPrompt).toBe('custom');
    expect(flow.agents.a.tools).toEqual(['chat_search']);
    expect(flow.agents.p.userPrompt).toBe('base');
    expect(flow.agents.p.tools).toBe(null);
});

test('agenda: planner, pool without the final agent, final column', () => {
    const flow = buildFlow(PROFILES.agenda, { mode: 'agenda' });
    expect(flow.columns.map(c => c.kind)).toEqual(['driver', 'pool', 'stage']);
    expect(!flow.columns[1].nodes.includes('finalizer')).toBeTruthy();
    expect(flow.columns[2].nodes).toEqual(['finalizer']);
    expect(flow.limits.map(l => l.key)).toEqual(['limitRounds', 'limitConcurrent', 'limitTotal']);
});

test('loop: single agent with flattened tools', () => {
    const flow = buildFlow(PROFILES.loop, { mode: 'loop' });
    const tools = flow.agents.loop_agent.tools;
    expect(tools.includes('chat_search')).toBeTruthy();
    expect(tools.includes('memory_search')).toBeTruthy();
    expect(tools.includes('finalize')).toBeTruthy();
    expect(!tools.includes('lorebook_list')).toBeTruthy();
    expect(flow.limits.find(l => l.key === 'limitTime').value).toBe(300);
});

test('director: main + grouped team, body output, inherited tools', () => {
    const flow = buildFlow(PROFILES.director, { mode: 'director' });
    expect(flow.output).toBe('body');
    expect(flow.columns[0].id).toBe('main');
    const groups = Object.fromEntries(flow.columns.slice(1).map(c => [c.id, c.nodes]));
    expect(groups.scout.includes('chat_scout')).toBeTruthy();
    expect(groups.critic).toEqual(['voice_critic', 'continuity_critic']);
    expect(flow.agents.epistemic_scout.inheritedTools).toEqual(['chat_read_range']);
});

test('director: unknown sub-agent ids go to the other group, duplicates dropped', () => {
    const flow = buildFlow({ mainAgent: {}, subAgents: [{ id: '我的助手', systemPrompt: 'x' }, { id: '我的助手', systemPrompt: 'y' }, { id: '', systemPrompt: 'z' }] }, { mode: 'director' });
    expect(flow.columns.find(c => c.id === 'other').nodes).toEqual(['我的助手']);
});

test('empty / garbage profiles do not throw', () => {
    for (const mode of ['spec', 'single', 'agenda', 'loop', 'director']) {
        expect(() => buildFlow(null, { mode })).not.toThrow();
        expect(() => buildFlow({ spec: { stages: 'x' }, agents: 5, subAgents: {} }, { mode })).not.toThrow();
    }
});

test('enabledTools flattens flag trees', () => {
    expect(enabledTools({ chat: { read_range: true, search: false }, custom: { memory_get: true }, finalize: true })).toEqual(['chat_read_range', 'memory_get', 'finalize']);
    expect(enabledTools(null)).toEqual([]);
});

test('display names: shipped ids are Chinese, user ids pass through', () => {
    expect(agentName('distiller')).toBe('场景提炼');
    expect(agentName('林栖的助手')).toBe('林栖的助手');
    expect(humanizeId('my_custom-agent')).toBe('my custom agent');
    expect(toolName('chat_search')).toBe('搜索聊天');
    expect(toolName('memory_search')).toBe('搜索记忆');
    expect(toolName('lorebook_whatever')).toBe('世界书工具');
});
