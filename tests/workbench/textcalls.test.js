import './_mocks/luker-zh.js';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { salvageTextCalls, hasTextCalls, lenientJson } from '../../public/scripts/extensions/workbench/model/textcalls.js';
import { worldUnits, worldRebuild } from '../../public/scripts/extensions/workbench/model/adapters.js';

// Shape seen in a real report: raw newlines inside the JSON string.
const RAW = `前言
<Function_NGHO_Start/>
<function_calls>
<function_call>
<tool>wb_answer</tool>
<args_json><![CDATA[{
 "text": "### 结论
1. 依然显示 running",
 "suggest": "memory",
 "request_ids": ["a", "b"]
}]]></args_json>
</function_call>
<function_call>
<tool>emit_complete_response_e52d</tool>
<args_json><![CDATA[{"content": "x"}]]></args_json>
</function_call>
</function_calls>`;

test('salvages broken plain-text tool calls', () => {
    assert.ok(hasTextCalls(RAW));
    const r = salvageTextCalls(RAW, ['wb_answer', 'wb_list_requests']);
    assert.equal(r.text, '前言');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].name, 'wb_answer');
    assert.equal(r.calls[0].args.text, '### 结论\n1. 依然显示 running');
    assert.equal(r.calls[0].args.suggest, 'memory');
    assert.deepEqual(r.calls[0].args.request_ids, ['a', 'b']);
});

test('lenientJson keeps valid JSON and escapes', () => {
    assert.deepEqual(lenientJson('{"a":"x\\"y"}'), { a: 'x"y' });
    assert.deepEqual(lenientJson(''), {});
    assert.equal(lenientJson('{nope'), null);
});

test('world units only cover lorebook entries', () => {
    const base = { lorebooks: { 雾港: { entries: { 1: { uid: 1, key: ['码头'], content: '旧' } } } } };
    const ai = { lorebooks: { 雾港: { entries: { 1: { uid: 1, key: ['码头'], content: '新' }, 2: { uid: 2, key: ['灯塔'], content: '加' } } } } };
    assert.deepEqual([...worldUnits(ai).keys()], ['wi:雾港:1', 'wi:雾港:2']);
    const next = worldRebuild(base, ai, ['wi:雾港:2', 'card:name']);
    assert.equal(next.lorebooks.雾港.entries[1].content, '旧');
    assert.equal(next.lorebooks.雾港.entries[2].content, '加');
    assert.equal(next.character, undefined);
});
