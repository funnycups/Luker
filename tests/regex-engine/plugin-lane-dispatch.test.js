/**
 * Dispatch-layer provenance cooking — plugin-prompt-regex.js.
 *
 * Contract:
 *   - `markPluginFloorMessage(message, idx)` stamps a numeric internal-only
 *     provenance field onto a fresh message object (input never mutated).
 *   - `applyPluginLaneRegex(messages, { applyRegex })`:
 *       - messages carrying the provenance marker pass through UNCOOKED;
 *       - unmarked `user`/`assistant` messages are cooked via
 *         `applyRegex(content, placement, { isPluginPrompt: true })` with
 *         NO `depth` key at all (depth filtering disabled, matching an
 *         undepthed plugin message);
 *       - `system`/`tool` roles are never cooked;
 *       - every output message is rebuilt WITHOUT the provenance field —
 *         it is internal-only and must never reach network payloads;
 *       - all other fields (tool_calls, name, ...) are preserved.
 */

import { describe, test, expect, jest, beforeEach, beforeAll } from '@jest/globals';

const applyRegexMock = jest.fn((s, _placement, params) =>
    params && params.isPluginPrompt ? String(s).replace(/SYNTH/g, 'cooked') : String(s));

const PLACEMENTS = { USER_INPUT: 1, AI_OUTPUT: 2 };

const restoreFns = [];

function installLuker() {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'Luker');
    globalThis.Luker = {
        getContext: () => ({
            regex: {
                applyRegex: applyRegexMock,
                placement: { ...PLACEMENTS },
            },
        }),
    };
    return () => {
        if (previous) {
            Object.defineProperty(globalThis, 'Luker', previous);
        } else {
            delete globalThis.Luker;
        }
    };
}

let mod;

beforeAll(async () => {
    restoreFns.push(installLuker());
    try {
        mod = await import('../../public/scripts/lib/plugin-prompt-regex.js');
    } finally {
        restoreFns.pop()();
    }
});

beforeEach(() => {
    restoreFns.push(installLuker());
    applyRegexMock.mockClear();
});

afterEach(() => {
    restoreFns.pop()();
    mod.__resetRegexApiCacheForTests();
});

describe('markPluginFloorMessage', () => {
    test('stamps a numeric sourceFloorIndex on a NEW object, input untouched', () => {
        const original = { role: 'user', content: 'SYNTH text' };
        const marked = mod.markPluginFloorMessage(original, 3);
        expect(marked).not.toBe(original);
        expect(original).toEqual({ role: 'user', content: 'SYNTH text' });
        expect(marked.sourceFloorIndex).toBe(3);
        expect(Number.isInteger(marked.sourceFloorIndex)).toBe(true);
    });

    test('coerces fractional index to integer', () => {
        const marked = mod.markPluginFloorMessage({ role: 'user', content: '' }, 7.9);
        expect(marked.sourceFloorIndex).toBe(7);
    });
});

describe('applyPluginLaneRegex', () => {
    test('marked messages pass through UNCOOKED, other fields preserved, marker stripped from output', () => {
        const messages = [
            { role: 'system', content: 'sys SYNTH prompt', name: 'keep-name' },
            mod.markPluginFloorMessage({ role: 'user', content: 'floor SYNTH text', signature: 'sig-1' }, 0),
        ];

        const out = mod.applyPluginLaneRegex(messages);

        expect(applyRegexMock).toHaveBeenCalledTimes(0);
        expect(out[0]).toEqual({ role: 'system', content: 'sys SYNTH prompt', name: 'keep-name' });
        expect(out[1].content).toBe('floor SYNTH text');
        expect(out[1].signature).toBe('sig-1');
        expect(Object.hasOwn(out[1], 'sourceFloorIndex')).toBe(false);
    });

    test('unmarked user/assistant cooked with isPluginPrompt:true and NO depth param', () => {
        const messages = [
            { role: 'user', content: 'say SYNTH now' },
            { role: 'assistant', content: 'reply SYNTH ok' },
        ];

        const out = mod.applyPluginLaneRegex(messages);

        expect(out[0].content).toBe('say cooked now');
        expect(out[1].content).toBe('reply cooked ok');

        expect(applyRegexMock).toHaveBeenCalledTimes(2);
        const [firstCall, secondCall] = applyRegexMock.mock.calls;
        expect(firstCall[0]).toBe('say SYNTH now');
        expect(firstCall[1]).toBe(PLACEMENTS.USER_INPUT);
        expect(firstCall[2]).toEqual({ isPluginPrompt: true });
        expect(Object.hasOwn(firstCall[2], 'depth')).toBe(false);

        expect(secondCall[1]).toBe(PLACEMENTS.AI_OUTPUT);
        expect(secondCall[2]).toEqual({ isPluginPrompt: true });
        expect(Object.hasOwn(secondCall[2], 'depth')).toBe(false);

        expect(Object.hasOwn(out[0], 'sourceFloorIndex')).toBe(false);
        expect(Object.hasOwn(out[1], 'sourceFloorIndex')).toBe(false);
    });

    test('system and tool roles are never cooked', () => {
        const messages = [
            { role: 'system', content: 'sys SYNTH text' },
            { role: 'tool', content: 'tool SYNST SYNTH payload', tool_call_id: 'call_1' },
        ];

        const out = mod.applyPluginLaneRegex(messages);

        expect(applyRegexMock).not.toHaveBeenCalled();
        expect(out[0]).toEqual({ role: 'system', content: 'sys SYNTH text' });
        expect(out[1]).toEqual({ role: 'tool', content: 'tool SYNST SYNTH payload', tool_call_id: 'call_1' });
    });

    test('assistant tool_calls survive the pass; mixed batch fully stripped of marker', () => {
        const toolCalls = [{ id: 'call_9', type: 'function', function: { name: 'f', arguments: '{}' } }];
        const messages = [
            mod.markPluginFloorMessage({
                role: 'assistant',
                content: '',
                tool_calls: structuredClone(toolCalls),
            }, 12),
            { role: 'user', content: 'SYNTH q', sourceFloorIndex: 'not-a-number' },
        ];

        const out = mod.applyPluginLaneRegex(messages);

        expect(out[0]).toEqual({ role: 'assistant', content: '', tool_calls: toolCalls });
        // Non-numeric marker value does NOT suppress cooking...
        expect(applyRegexMock).toHaveBeenCalledTimes(1);
        expect(out[1].content).toBe('cooked q');
        // ...and nothing in the output carries the marker field.
        for (const message of out) {
            expect(Object.hasOwn(message, 'sourceFloorIndex')).toBe(false);
        }
    });

    test('injected applyRegex override wins over ctx.regex.applyRegex', () => {
        const probe = jest.fn((s, _p, params) => (params && params.isPluginPrompt ? 'via-injection' : s));
        const out = mod.applyPluginLaneRegex(
            [{ role: 'user', content: 'SYNTH' }],
            { applyRegex: probe },
        );

        expect(probe).toHaveBeenCalledTimes(1);
        expect(applyRegexMock).not.toHaveBeenCalled();
        expect(out[0].content).toBe('via-injection');
    });

    test('non-string content is left uncooked', () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'SYNTH' }] },
        ];

        const out = mod.applyPluginLaneRegex(messages);

        expect(applyRegexMock).not.toHaveBeenCalled();
        expect(out[0].content).toEqual([{ type: 'text', text: 'SYNTH' }]);
    });

    test('degrades gracefully without a reachable regex API: raw text, marker still stripped', () => {
        // Overwrite the stub; afterEach's captured restore puts the real one back.
        globalThis.Luker = { getContext: () => ({}) };
        mod.__resetRegexApiCacheForTests();

        const out = mod.applyPluginLaneRegex([
            mod.markPluginFloorMessage({ role: 'user', content: 'SYNTH raw' }, 1),
            { role: 'user', content: 'SYNTH raw2' },
        ]);
        expect(applyRegexMock).not.toHaveBeenCalled();
        expect(out[0].content).toBe('SYNTH raw');
        expect(out[1].content).toBe('SYNTH raw2');
        expect(Object.hasOwn(out[0], 'sourceFloorIndex')).toBe(false);
    });

    test('empty and non-array inputs yield empty arrays', () => {
        expect(mod.applyPluginLaneRegex([])).toEqual([]);
        expect(mod.applyPluginLaneRegex(undefined)).toEqual([]);
        expect(mod.applyPluginLaneRegex(null)).toEqual([]);
    });
});
