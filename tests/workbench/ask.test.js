import './_mocks/luker-zh.js';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { askTools, runAsk, readsSummary, clip } from '../../public/scripts/extensions/workbench/model/ask.js';
import { attribute, groupByGeneration, redact, describeRequest } from '../../public/scripts/extensions/workbench/model/requests.js';

test('tools follow the allowed sources and always include wb_answer', () => {
    const names = (s) => askTools(s).map(t => t.function.name);
    assert.ok(names({}).includes('wb_list_requests'));
    assert.ok(!names({ inspector: false }).includes('wb_list_requests'));
    assert.deepEqual(names({ inspector: false, frontLogs: false, serverLogs: false, content: false, plugins: false }), ['wb_answer']);
});

test('runAsk reads, then answers', async () => {
    const script = [
        { text: '', calls: [{ id: 'c1', name: 'wb_list_requests', args: { limit: 5 } }, { id: 'c2', name: 'wb_read_frontend_logs', args: {} }] },
        { text: '', calls: [{ id: 'c3', name: 'wb_answer', args: { text: '慢在剧情顾问', suggest: 'orch', fix_prompt: '换连接', request_ids: ['r3'] } }] },
    ];
    const seen = [];
    const result = await runAsk({
        question: '为什么慢',
        overview: { chat: 'x' },
        readers: { wb_list_requests: async () => [{ id: 'r3' }], wb_read_frontend_logs: async () => 'log' },
        request: async (messages, tools) => { seen.push({ messages: [...messages], tools: tools.map(t => t.function.name) }); return script.shift(); },
    });
    assert.equal(result.answer, '慢在剧情顾问');
    assert.equal(result.suggest, 'orch');
    assert.deepEqual(result.requestIds, ['r3']);
    assert.equal(result.reads.length, 2);
    // second request carries both tool results
    assert.equal(seen[1].messages.filter(m => m.role === 'tool').length, 2);
    assert.equal(readsSummary(result.reads), '请求列表 · 前端日志');
});

test('runAsk only offers wb_answer on the last round, and handles plain text', async () => {
    let calls = 0;
    const offered = [];
    const r = await runAsk({
        question: 'q', overview: {}, readers: { wb_read_chat: async () => 'x' },
        request: async (_m, tools) => { calls++; offered.push(tools.length); return { text: '', calls: [{ id: `c${calls}`, name: 'wb_read_chat', args: {} }] }; },
    });
    assert.equal(calls, 6);
    assert.equal(offered[5], 1);
    assert.match(r.answer, /换个更具体/);
    const plain = await runAsk({ question: 'q', overview: {}, readers: {}, request: async () => ({ text: '直接回答', calls: [] }) });
    assert.equal(plain.answer, '直接回答');
});

test('request attribution and grouping', () => {
    assert.equal(attribute({ searchText: 'You are a memory recall planner' }).label, '记忆图 · 召回规划');
    assert.equal(attribute({ id: 'a' }, { mainReplyIds: new Set(['a']) }).guessed, false);
    assert.equal(attribute({ messageCount: 30 }).kind, 'main');
    assert.equal(attribute({ messageCount: 2 }).kind, 'other');
    const g = groupByGeneration([{ timestamp: 0, durationMs: 1000 }, { timestamp: 5000 }, { timestamp: 500000 }]);
    assert.equal(g.length, 2);
    assert.equal(g[1].items.length, 2);
    const d = describeRequest({ id: 'x', timestamp: 0, status: 'error', httpStatus: 429, error: 'rate' });
    assert.equal(d.status, '失败 429');
});

test('redact hides keys and hosts', () => {
    const out = redact('key sk-abcdefghijklmnop1234 Bearer abcdefghijklmnopqrst url https://api.secret-host.example.com/v1/chat api_key: "hunter2hunter2"');
    assert.ok(!out.includes('abcdefghijklmnop1234'));
    assert.ok(!out.includes('abcdefghijklmnopqrst'));
    assert.ok(!out.includes('/v1/chat'));
    assert.ok(!out.includes('hunter2hunter2'));
    assert.match(clip('x'.repeat(20000)), /已截断/);
});
