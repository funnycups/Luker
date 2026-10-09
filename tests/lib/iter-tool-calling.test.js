/**
 * substituteMacros opt-in tests for requestToolCallsWithRetry.
 *
 * The shared runner hardcodes a default of `substituteMacros: false`
 * because the iter-studio popups edit raw source text and must see
 * literal `{{...}}` templates. Callers that read resolved content —
 * e.g. the search agent reading chat text — opt in by passing
 * `substituteMacros: true`, which is forwarded to generateTask.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { requestToolCallsWithRetry } from '../../public/scripts/lib/iter-tool-calling.js';

const tools = [{
    type: 'function',
    function: {
        name: 'noop',
        description: 'Stub tool; never actually executed.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
}];

function makeContext() {
    return {
        generateTask: jest.fn(async () => ({
            assistantText: 'ok',
            toolCalls: [{ name: 'noop', args: {} }],
        })),
    };
}

describe('requestToolCallsWithRetry — substituteMacros opt-in', () => {
    test('forwards substituteMacros: true to generateTask when opted in', async () => {
        const context = makeContext();
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools,
            includeAssistantText: true,
            substituteMacros: true,
        });
        expect(context.generateTask).toHaveBeenCalledTimes(1);
        expect(context.generateTask.mock.calls[0][0].substituteMacros).toBe(true);
    });

    test('defaults substituteMacros to false when omitted', async () => {
        const context = makeContext();
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools,
            includeAssistantText: true,
        });
        expect(context.generateTask).toHaveBeenCalledTimes(1);
        expect(context.generateTask.mock.calls[0][0].substituteMacros).toBe(false);
    });
});
