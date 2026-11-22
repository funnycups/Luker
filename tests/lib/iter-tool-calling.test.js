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
        expect(context.generateTask.mock.calls[0][0].includeCharacterCard).toBe(true);
    });

    test('forwards promptContext, transientSessionId, onPreparedRequest, and explicit includeCharacterCard=false', async () => {
        const context = {
            ...makeContext(),
            isStreamingPresetEnabled: () => false,
        };
        const promptContext = { scope: 'preset', envelope: { version: 1 }, runtimeWorldInfo: {}, macroEnv: {} };
        const onPreparedRequest = jest.fn();
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools,
            includeCharacterCard: false,
            promptContext,
            transientSessionId: '550e8400-e29b-41d4-a716-446655440000',
            onPreparedRequest,
        });
        expect(context.generateTask).toHaveBeenCalledTimes(1);
        expect(context.generateTask.mock.calls[0][0]).toMatchObject({
            includeCharacterCard: false,
            promptContext,
            transientSessionId: '550e8400-e29b-41d4-a716-446655440000',
            onPreparedRequest,
        });
    });

    test('forwards isolation options on the streaming preset path as well', async () => {
        const promptContext = { scope: 'chat', envelope: { version: 1 }, runtimeWorldInfo: {}, macroEnv: {} };
        const onPreparedRequest = jest.fn();
        const generateTaskStream = jest.fn(() => ({
            stream: (async function* () {
                yield { type: 'text', delta: 'ok' };
            })(),
            result: Promise.resolve({
                assistantText: 'ok',
                toolCalls: [{ name: 'noop', args: {} }],
            }),
        }));
        const context = {
            generateTask: jest.fn(),
            generateTaskStream,
            isStreamingPresetEnabled: () => true,
        };
        await requestToolCallsWithRetry(context, { rpmLimit: 0 }, {
            tools,
            llmPresetName: 'StreamPreset',
            includeCharacterCard: false,
            promptContext,
            transientSessionId: '550e8400-e29b-41d4-a716-446655440000',
            onPreparedRequest,
        });
        expect(generateTaskStream).toHaveBeenCalledTimes(1);
        expect(generateTaskStream.mock.calls[0][0]).toMatchObject({
            includeCharacterCard: false,
            promptContext,
            transientSessionId: '550e8400-e29b-41d4-a716-446655440000',
            onPreparedRequest,
        });
    });
});
