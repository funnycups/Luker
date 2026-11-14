import './_mocks/luker-zh.js';
import { test, expect } from '@jest/globals';
import { buildTaskMessages, runTurn, newSession, upsertSession, markRolledBack, toolCallText, MAX_SESSIONS } from '../../../public/scripts/extensions/memory-graph/lens/ai/ai-model.js';

test('buildTaskMessages replays tool calls with matching tool results', () => {
    const messages = [
        { id: 'u1', role: 'user', content: '加一个物品类型' },
        { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'mg_schema_set_node_type', args: { id: 'item' } }], toolResults: [{ tool_call_id: 'c1', content: { status: 'applied' }, status: 'ok' }] },
        { id: 'n1', role: 'note', content: '已停止' },
        { id: 'a2', role: 'assistant', content: '好了' },
    ];
    const out = buildTaskMessages('SYS', messages);
    expect(out.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(out[2].tool_calls[0].function.arguments).toBe('{"id":"item"}');
    expect(out[3].tool_call_id).toBe('c1');
    expect(out[3].content).toBe('{"status":"applied"}');
});

test('runTurn loops while the AI calls tools and reports change', async () => {
    const session = newSession();
    session.messages.push({ id: 'u', role: 'user', content: 'x' });
    let n = 0;
    const round = async ({ live }) => {
        n++;
        if (n === 1) return { assistantText: '', calls: [{ id: 'c', name: 'mg_schema_set_node_type', args: {}, result: {}, ok: true }], live: [...live, { id: 'item' }] };
        return { assistantText: '完成', calls: [], live };
    };
    const out = await runTurn(round, session, { live: [{ id: 'event' }] });
    expect(out.rounds).toBe(2);
    expect(out.changed).toBe(true);
    expect(out.live.map(t => t.id)).toEqual(['event', 'item']);
    expect(session.messages.length).toBe(3);
    expect(session.messages[1].toolResults[0].status).toBe('ok');
});

test('runTurn stops at the round cap and honours abort', async () => {
    const session = newSession();
    const round = async ({ live }) => ({ assistantText: '', calls: [{ id: 'c', name: 'mg_schema_read_fields', args: {}, result: {}, ok: true }], live });
    const out = await runTurn(round, session, { live: [], maxRounds: 3 });
    expect(out.rounds).toBe(3);
    expect(out.changed).toBe(false);
    const ac = new AbortController();
    ac.abort();
    await await expect(runTurn(round, session, { live: [], signal: ac.signal })).rejects.toThrow();
});

test('upsertSession keeps newest first, drops empty, caps length', () => {
    let list = [];
    for (let i = 0; i < MAX_SESSIONS + 3; i++) list = upsertSession(list, { id: `s${i}`, at: i, messages: [{}] });
    expect(list.length).toBe(MAX_SESSIONS);
    expect(list[0].id).toBe(`s${MAX_SESSIONS + 2}`);
    expect(upsertSession(list, { id: 'empty', at: 999, messages: [] }).length).toBe(MAX_SESSIONS);
});

test('markRolledBack rewrites only successful edit results', () => {
    const messages = [{ id: 'a', role: 'assistant', toolCalls: [{ id: 'r', name: 'mg_schema_read_fields' }, { id: 'e', name: 'mg_schema_set_node_type' }], toolResults: [{ tool_call_id: 'r', content: 'R', status: 'ok' }, { tool_call_id: 'e', content: 'E', status: 'ok' }] }];
    markRolledBack(messages, ['a'], { status: 'rolled_back' });
    expect(messages[0].toolResults[0].content).toBe('R');
    expect(messages[0].toolResults[1].content).toEqual({ status: 'rolled_back' });
    expect(messages[0].rolledBack).toBe(true);
});

test('toolCallText names the target in Chinese', () => {
    expect(toolCallText({ name: 'mg_schema_set_node_type', args: { label: '物品' } })).toBe('修改类型「物品」');
    expect(toolCallText({ name: 'mg_schema_read_fields', args: {} })).toBe('查看当前结构');
});

test('built-in guide is optional; task rules always sent', async () => {
    const { rewriteSystemPrompt, rewriteUserPrompt, suggestSystemPrompt, suggestUserPrompt } = await import('../../../public/scripts/extensions/memory-graph/lens/ai/ai-model.js');
    const withGuide = suggestSystemPrompt({ builtin: true });
    const bare = suggestSystemPrompt({ builtin: false });
    expect(withGuide).toMatch(/不是写故事/);
    expect(withGuide).toMatch(/alwaysInject/);
    expect(bare).not.toMatch(/不是写故事/);
    expect(bare).toMatch(/key 一律不改/);
    expect(rewriteSystemPrompt('columnHint', { builtin: false })).toMatch(/submit_text/);
    expect(rewriteSystemPrompt('typeIntro')).toMatch(/类型的说明/);
    expect(rewriteUserPrompt({ kind: 'columnHint', text: '' })).toMatch(/请写一段/);
    const user = suggestUserPrompt({ spec: { id: 'todo', label: '待办', tableColumns: ['title'], columnHints: { title: '显示名' } }, others: [{ id: 'character_sheet', label: '角色', tableColumns: ['title'] }], request: '要记截止时间' });
    expect(user).toMatch(/要记截止时间/);
    expect(user).toMatch(/"id": "todo"/);
    expect(user).toMatch(/character_sheet/);
});
