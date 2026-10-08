/**
 * Unit tests for lib/chat-regex.js — the plugin channel's response-side
 * regex primitive.
 *
 * Contract under test:
 *   - `regexAgentPluginOutput(text)` applies the OUTPUT-direction plugin
 *     pass: AI_OUTPUT placement with `{ isPluginOutput: true }` (pluginOnly
 *     without promptOnly).
 *   - Empty / nullish input short-circuits to '' without touching the API.
 *   - When no regex API is reachable, raw text is returned unchanged.
 */

import { describe, test, expect, afterEach } from '@jest/globals';

const applyRegexCalls = [];

const applyRegexMock = (raw, placement, params) => {
    applyRegexCalls.push({ raw, placement, params });
    return params && params.isPluginOutput ? `[out]${raw}` : raw;
};

let previousLuker;

function installLuker() {
    previousLuker = Object.getOwnPropertyDescriptor(globalThis, 'Luker');
    globalThis.Luker = {
        getContext: () => ({
            regex: {
                applyRegex: applyRegexMock,
                placement: { USER_INPUT: 1, AI_OUTPUT: 2 },
            },
        }),
    };
}

afterEach(() => {
    if (previousLuker) {
        Object.defineProperty(globalThis, 'Luker', previousLuker);
    } else {
        delete globalThis.Luker;
    }
    applyRegexCalls.length = 0;
});

async function loadModule() {
    const mod = await import('../../public/scripts/lib/chat-regex.js');
    mod.__resetRegexApiCacheForTests();
    return mod;
}

describe('regexAgentPluginOutput', () => {
    test('applies the output-direction pass at AI_OUTPUT placement', async () => {
        installLuker();
        const { regexAgentPluginOutput } = await loadModule();

        const out = regexAgentPluginOutput('hello');

        expect(out).toBe('[out]hello');
        expect(applyRegexCalls).toHaveLength(1);
        expect(applyRegexCalls[0].raw).toBe('hello');
        expect(applyRegexCalls[0].placement).toBe(2);
        expect(applyRegexCalls[0].params).toEqual({ isPluginOutput: true });
    });

    test('empty / nullish input short-circuits without calling the API', async () => {
        installLuker();
        const { regexAgentPluginOutput } = await loadModule();

        expect(regexAgentPluginOutput('')).toBe('');
        expect(regexAgentPluginOutput(null)).toBe('');
        expect(regexAgentPluginOutput(undefined)).toBe('');
        expect(applyRegexCalls).toHaveLength(0);
    });

    test('degrades to raw text when no regex API is reachable', async () => {
        globalThis.Luker = { getContext: () => ({}) };
        const { regexAgentPluginOutput } = await loadModule();

        expect(regexAgentPluginOutput('raw')).toBe('raw');
    });
});
