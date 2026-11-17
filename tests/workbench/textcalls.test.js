// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import { salvageTextCalls, hasTextCalls, lenientJson, visibleText } from '../../public/scripts/workbench/model/textcalls.js';

const RAW = `Intro text
<Function_NGHO_Start/>
<function_calls>
<function_call>
<tool>wb_answer</tool>
<args_json><![CDATA[{
 "text": "### Summary
1. Still running",
 "suggest": "memory",
 "request_ids": ["a", "b"]
}]]></args_json>
</function_call>
<function_call>
<tool>emit_complete_response_e52d</tool>
<args_json><![CDATA[{"content": "x"}]]></args_json>
</function_call>
</function_calls>`;

describe('workbench plain-text tool call salvage', () => {
    test('salvages broken plain-text tool calls and strips protocol tail', () => {
        expect(hasTextCalls(RAW)).toBe(true);
        const r = salvageTextCalls(RAW, ['wb_answer', 'wb_list_requests']);
        expect(r.text).toBe('Intro text');
        expect(r.calls).toHaveLength(1);
        expect(r.calls[0].name).toBe('wb_answer');
        expect(r.calls[0].args.text).toBe('### Summary\n1. Still running');
        expect(r.calls[0].args.suggest).toBe('memory');
        expect(r.calls[0].args.request_ids).toEqual(['a', 'b']);
        expect(visibleText(RAW)).toBe('Intro text');
    });

    test('lenientJson keeps valid JSON and escapes raw control characters', () => {
        expect(lenientJson('{"a":"x\\"y"}')).toEqual({ a: 'x"y' });
        expect(lenientJson('{"a":"line1\nline2"}')).toEqual({ a: 'line1\nline2' });
        expect(lenientJson('')).toEqual({});
        expect(lenientJson('{nope')).toBeNull();
    });
});
