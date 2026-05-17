import { describe, expect, test } from '@jest/globals';
import { renderMainAgentDigest } from '../../../public/scripts/extensions/orchestrator/director-tools.js';

describe('renderMainAgentDigest', () => {
    test('returns null when parentMessages is empty or not an array', () => {
        expect(renderMainAgentDigest(null, 0)).toBeNull();
        expect(renderMainAgentDigest([], 0)).toBeNull();
        expect(renderMainAgentDigest(undefined, 0)).toBeNull();
    });

    test('returns null when there are no main-agent rounds past the chat snapshot', () => {
        // parentMessages = [systemMain, chat0, chat1]. chatSnapshotLength = 2.
        // startIndex = 1 + 2 = 3. rounds = [] → null.
        const parent = [
            { role: 'system', content: 'main system' },
            { role: 'user', content: 'chat user 0' },
            { role: 'assistant', content: 'chat assistant 0' },
        ];
        expect(renderMainAgentDigest(parent, 2)).toBeNull();
    });

    test('renders assistant reasoning and tool invocations under labeled headings', () => {
        const parent = [
            { role: 'system', content: 'main system' },
            { role: 'user', content: 'chat user 0' },
            {
                role: 'assistant',
                content: 'I need to gather context first.',
                tool_calls: [
                    { id: 'tc1', type: 'function', function: { name: 'dispatch_subagent', arguments: '{}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'tc1', content: '{"ok":true,"handle":"h_abc"}' },
        ];
        const out = renderMainAgentDigest(parent, 1);
        expect(out).toContain('## Main agent context');
        expect(out).toContain('### Main agent reasoning');
        expect(out).toContain('I need to gather context first.');
        expect(out).toContain('[Main agent invoked tools: dispatch_subagent]');
        expect(out).toContain('### Tool result');
        expect(out).toContain('"handle":"h_abc"');
    });

    test('skips empty assistant content but still renders tool_calls line', () => {
        const parent = [
            { role: 'system', content: 'sys' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    { id: 't', type: 'function', function: { name: 'await_subagents', arguments: '{}' } },
                ],
            },
        ];
        const out = renderMainAgentDigest(parent, 0);
        expect(out).toContain('[Main agent invoked tools: await_subagents]');
    });

    test('renders multi-round histories with both assistant and tool blocks in order', () => {
        const parent = [
            { role: 'system', content: 'sys' },
            { role: 'assistant', content: 'round 1 thinking', tool_calls: [{ id: 'a', type: 'function', function: { name: 'dispatch_subagent', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'a', content: 'result A' },
            { role: 'assistant', content: 'round 2 thinking', tool_calls: [{ id: 'b', type: 'function', function: { name: 'finalize', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'b', content: 'result B' },
        ];
        const out = renderMainAgentDigest(parent, 0);
        const r1Idx = out.indexOf('round 1 thinking');
        const r1ToolIdx = out.indexOf('result A');
        const r2Idx = out.indexOf('round 2 thinking');
        const r2ToolIdx = out.indexOf('result B');
        expect(r1Idx).toBeGreaterThan(-1);
        expect(r1ToolIdx).toBeGreaterThan(r1Idx);
        expect(r2Idx).toBeGreaterThan(r1ToolIdx);
        expect(r2ToolIdx).toBeGreaterThan(r2Idx);
    });
});
