/**
 * Iteration-studio tool calls must carry ids that are unique within the
 * session: the proposal bus selects a turn's proposals by tool-call id
 * (approve / reject / rollback by turn), so a provider that repeats an id
 * across responses would make one turn's actions reach another turn.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import {
    requestToolCallsWithRetry,
    collectIterToolCallIds,
} from '../../public/scripts/lib/iter-tool-calling.js';
import { createBus } from '../../public/scripts/iteration-library/proposal-bus/bus.js';
import { registerTarget, clearRegistry } from '../../public/scripts/iteration-library/storage/target-registry.js';

const tools = [{
    type: 'function',
    function: {
        name: 'set_value',
        description: 'Set the value.',
        parameters: {
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value'],
            additionalProperties: false,
        },
    },
}];

function call(id, value) {
    return { name: 'set_value', args: { value }, raw: { id, type: 'function' } };
}

function contextReturning(...responses) {
    const generateTask = jest.fn();
    for (const toolCalls of responses) {
        generateTask.mockResolvedValueOnce({ assistantText: '', toolCalls });
    }
    return { generateTask };
}

describe('collectIterToolCallIds', () => {
    test('collects call and result ids from persisted and wire message shapes', () => {
        const ids = collectIterToolCallIds([
            { role: 'user', content: 'x' },
            { role: 'assistant', toolCalls: [{ id: 'a' }], toolResults: [{ tool_call_id: 'b' }] },
            { role: 'assistant', tool_calls: [{ id: 'c' }] },
            { role: 'tool', tool_call_id: 'd' },
        ]);
        expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd']);
    });
});

describe('requestToolCallsWithRetry — reservedToolCallIds', () => {
    test('re-ids calls whose id is reserved or repeated within the response', async () => {
        const context = contextReturning([call('tc-1', 1), call('tc-2', 2), call('tc-2', 3)]);
        const seen = [];
        const result = await requestToolCallsWithRetry(context, {}, {
            tools,
            includeAssistantText: true,
            reservedToolCallIds: new Set(['tc-1']),
            onToolCall: (c) => seen.push(c.id),
        });
        const ids = result.toolCalls.map(c => c.id);
        expect(new Set(ids).size).toBe(3);
        expect(ids).not.toContain('tc-1');
        expect(ids[1]).toBe('tc-2');
        expect(ids[2]).not.toBe('tc-2');
        expect(result.toolCalls.map(c => c.raw.id)).toEqual(ids);
        expect(seen).toEqual(ids);
    });

    test('ids already in the replayed task messages count as reserved', async () => {
        const context = contextReturning([call('tc-1', 1)]);
        const result = await requestToolCallsWithRetry(context, {}, {
            tools,
            includeAssistantText: true,
            reservedToolCallIds: [],
            taskMessages: [
                { role: 'assistant', content: '', tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'set_value', arguments: '{}' } }] },
                { role: 'tool', tool_call_id: 'tc-1', content: 'ok' },
            ],
        });
        expect(result.toolCalls[0].id).not.toBe('tc-1');
    });

    test('without reservedToolCallIds the provider ids pass through', async () => {
        const context = contextReturning([call('tc-1', 1), call('tc-1', 2)]);
        const result = await requestToolCallsWithRetry(context, {}, { tools, includeAssistantText: true });
        expect(result.toolCalls.map(c => c.id)).toEqual(['tc-1', 'tc-1']);
    });

    test('synchronizes native replay envelopes positionally when ids are rewritten', async () => {
        const generateTask = jest.fn().mockResolvedValueOnce({
            assistantText: '',
            toolCalls: [call('tc-1', 1), call('tc-2', 2), call('tc-2', 3)],
            nativeContentBlocks: [
                { type: 'thinking', thinking: 'plan', signature: 'sig' },
                { type: 'tool_use', id: 'tc-1', name: 'set_value', input: { value: 1 } },
                { type: 'tool_use', id: 'tc-2', name: 'set_value', input: { value: 2 } },
                { type: 'tool_use', id: 'tc-2', name: 'set_value', input: { value: 3 } },
            ],
            nativeParts: [
                { functionCall: { id: 'tc-1', name: 'set_value', args: { value: 1 } } },
                { functionCall: { id: 'tc-2', name: 'set_value', args: { value: 2 } } },
                { functionCall: { id: 'tc-2', name: 'set_value', args: { value: 3 } } },
            ],
            responsesOutputItems: [
                { type: 'function_call', call_id: 'tc-1', name: 'set_value', arguments: '{"value":1}' },
                { type: 'function_call', call_id: 'tc-2', name: 'set_value', arguments: '{"value":2}' },
                { type: 'function_call', call_id: 'tc-2', name: 'set_value', arguments: '{"value":3}' },
            ],
        });
        const result = await requestToolCallsWithRetry({ generateTask }, {}, {
            tools,
            includeAssistantText: true,
            reservedToolCallIds: new Set(['tc-1']),
        });
        const ids = result.toolCalls.map(c => c.id);
        expect(ids[0]).not.toBe('tc-1');
        expect(ids[1]).toBe('tc-2');
        expect(ids[2]).not.toBe('tc-2');
        expect(result.nativeContentBlocks.filter(b => b.type === 'tool_use').map(b => b.id)).toEqual(ids);
        expect(result.nativeParts.map(p => p.functionCall.id)).toEqual(ids);
        expect(result.responsesOutputItems.map(i => i.call_id)).toEqual(ids);
    });

    test('drops native replay envelopes when allowedNames filters out calls', async () => {
        const generateTask = jest.fn().mockResolvedValueOnce({
            assistantText: '',
            toolCalls: [
                call('tc-1', 1),
                { name: 'disallowed_tool', args: {}, raw: { id: 'tc-2', type: 'function' } },
            ],
            reasoningBlocks: [{ type: 'thinking', thinking: 'keep me', signature: 'sig' }],
            nativeContentBlocks: [
                { type: 'tool_use', id: 'tc-1', name: 'set_value', input: { value: 1 } },
                { type: 'tool_use', id: 'tc-2', name: 'disallowed_tool', input: {} },
            ],
            nativeParts: [{ functionCall: { id: 'tc-1', name: 'set_value', args: { value: 1 } } }],
            responsesOutputItems: [{ type: 'function_call', call_id: 'tc-1', name: 'set_value', arguments: '{"value":1}' }],
        });
        const result = await requestToolCallsWithRetry({ generateTask }, {}, {
            tools,
            includeAssistantText: true,
            allowedNames: ['set_value'],
        });
        expect(result.toolCalls).toHaveLength(1);
        expect(result.reasoningBlocks).toHaveLength(1);
        expect(result.nativeContentBlocks).toBeUndefined();
        expect(result.nativeParts).toBeUndefined();
        expect(result.responsesOutputItems).toBeUndefined();
    });
});

describe('a provider repeating one tool-call id across turns', () => {
    beforeEach(() => clearRegistry());

    test('rolling back one turn leaves the other turn committed', async () => {
        let live = { value: 0 };
        registerTarget('preset', {
            read: async () => ({ ...live }),
            write: async (_target, next) => { live = { ...next }; },
            describe: () => 'preset',
        });
        const bus = createBus();
        bus.registerKind('profile-edit', { targetType: 'preset' });
        const context = contextReturning([call('mock-tc-1', 1)], [call('mock-tc-1', 2)]);
        const messages = [];

        // Two studio rounds: each persists its assistant turn with the
        // runner's ids and stages one proposal sourced from its call.
        for (let round = 0; round < 2; round++) {
            const result = await requestToolCallsWithRetry(context, {}, {
                tools,
                includeAssistantText: true,
                reservedToolCallIds: collectIterToolCallIds(messages),
            });
            const message = {
                id: `msg_${round}`,
                role: 'assistant',
                toolCalls: result.toolCalls.map(c => ({ id: c.id, name: c.name, args: c.args })),
            };
            messages.push(message);
            const before = await bus.getCurrentPendingState('profile-edit', { type: 'preset' });
            const { id } = await bus.propose({
                kind: 'profile-edit',
                target: { type: 'preset' },
                before,
                after: { ...before, value: result.toolCalls[0].args.value },
                sourceCallId: result.toolCalls[0].id,
            });
            expect(await bus.approve(id)).toMatchObject({ ok: true });
        }
        expect(live).toEqual({ value: 2 });

        const { results } = await bus.rollbackAllInTurn(messages[1]);
        expect(results).toHaveLength(1);
        expect(live).toEqual({ value: 1 });
        const statuses = bus.listEntries().map(e => e.status);
        expect(statuses).toEqual(['committed', 'rolledBack']);
    });
});
