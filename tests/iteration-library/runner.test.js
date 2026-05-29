/**
 * iteration-library/runner is a thin re-export of lib/iter-tool-calling
 * and lib/abort-utils. The test asserts identity (same function references)
 * so a future rename or accidental drop of an export is caught.
 *
 * Behavioral coverage for `requestToolCallsWithRetry` lives here too,
 * covering the contract that downstream runtimes (spec / agenda / loop)
 * depend on — notably that `reasoning` (API reasoning_content, e.g.
 * Claude thinking or OpenAI o1) is surfaced alongside `assistantText`
 * so per-turn entries can capture both fields independently.
 */

import { describe, test, expect, jest } from '@jest/globals';
import * as runner from '../../public/scripts/iteration-library/runner.js';
import * as iterToolCalling from '../../public/scripts/lib/iter-tool-calling.js';
import * as abortUtils from '../../public/scripts/lib/abort-utils.js';

describe('iteration-library/runner — public surface', () => {
    test('LLM primitives identity-match lib/iter-tool-calling exports', () => {
        expect(runner.requestToolCallsWithRetry).toBe(iterToolCalling.requestToolCallsWithRetry);
        expect(runner.buildExecutionToolCalls).toBe(iterToolCalling.buildExecutionToolCalls);
        expect(runner.buildPendingToolResults).toBe(iterToolCalling.buildPendingToolResults);
        expect(runner.makeAiIterationMessageId).toBe(iterToolCalling.makeAiIterationMessageId);
    });

    test('abortUtils namespace re-exports lib/abort-utils', () => {
        // identity-check whatever the abort-utils module actually exports
        for (const key of Object.keys(abortUtils)) {
            expect(runner.abortUtils[key]).toBe(abortUtils[key]);
        }
        expect(Object.keys(runner.abortUtils).length).toBeGreaterThan(0);
    });
});

describe('requestToolCallsWithRetry — reasoning propagation', () => {
    // The simplest tool definition that satisfies the "tools are required"
    // guard. Tests below use `allowNoToolCalls: true` and stub generateTask
    // to return no tool calls so the wrapper takes the assistant-text
    // branch without engaging the JSON-schema validator.
    const dummyTools = [{
        type: 'function',
        function: {
            name: 'noop',
            description: 'Stub tool; never actually called.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    }];

    function makeContext(generateTaskResult) {
        return {
            generateTask: jest.fn().mockResolvedValue(generateTaskResult),
        };
    }

    test('propagates reasoning string from generateTask result', async () => {
        const context = makeContext({
            assistantText: 'hi',
            toolCalls: [],
            reasoning: 'I was thinking...',
        });
        const returned = await runner.requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools: dummyTools,
            allowNoToolCalls: true,
            includeAssistantText: true,
        });
        expect(returned).toEqual({
            toolCalls: [],
            assistantText: 'hi',
            rawAssistantText: 'hi',
            reasoning: 'I was thinking...',
        });
    });

    test('defaults reasoning to empty string when missing on result', async () => {
        const context = makeContext({
            assistantText: 'hi',
            toolCalls: [],
            // no reasoning field
        });
        const returned = await runner.requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools: dummyTools,
            allowNoToolCalls: true,
            includeAssistantText: true,
        });
        expect(returned).toEqual({
            toolCalls: [],
            assistantText: 'hi',
            rawAssistantText: 'hi',
            reasoning: '',
        });
        // Explicit string-ness check — downstream consumers shouldn't
        // need to defend against undefined / null.
        expect(typeof returned.reasoning).toBe('string');
    });
});
