/**
 * `regexChatMessageForAgent` must ask the engine for user-authored scripts
 * only.
 *
 * Without that, memory-graph's own managed "Memory Graph Visible Message
 * Window" provider (findRegex `/[\s\S]*​/g` -> '', promptOnly,
 * minDepth: llmVisibleRecentMessages) fires on the chat text memory-graph
 * feeds to its OWN extractor: the script is registered globally, runs at the
 * real chat depth this function passes, and matches on `isPrompt: true`. Every
 * message at or beyond the visible window then arrives blank at the extractor
 * that is supposed to summarize it.
 *
 * Depth cannot express the exclusion — passing `undefined` skips the
 * min/maxDepth gate entirely (engine.js: `if (typeof depth === 'number')`),
 * which makes the blanking unconditional instead of removing it.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

const { regexChatMessageForAgent, __resetRegexApiCacheForTests } =
    await import('../../public/scripts/lib/chat-regex.js');

const PLACEMENT = { USER_INPUT: 1, AI_OUTPUT: 2 };

let applyRegex;
let previousLuker;

beforeEach(() => {
    previousLuker = globalThis.Luker;
    applyRegex = jest.fn((text) => text);
    globalThis.Luker = {
        getContext: () => ({ regex: { applyRegex, placement: PLACEMENT } }),
    };
    __resetRegexApiCacheForTests();
});

afterEach(() => {
    globalThis.Luker = previousLuker;
    __resetRegexApiCacheForTests();
});

describe('regexChatMessageForAgent: user-authored scripts only', () => {
    test('requests userScriptsOnly so managed runtime providers are skipped', () => {
        regexChatMessageForAgent({ mes: 'Alice met Bob at the gate.', is_user: false }, 12);
        expect(applyRegex).toHaveBeenCalledWith(
            'Alice met Bob at the gate.',
            PLACEMENT.AI_OUTPUT,
            expect.objectContaining({ userScriptsOnly: true }),
        );
    });

    test('still passes real depth and prompt scope for user-authored rules', () => {
        regexChatMessageForAgent({ mes: 'body', is_user: true }, 4);
        expect(applyRegex).toHaveBeenCalledWith(
            'body',
            PLACEMENT.USER_INPUT,
            expect.objectContaining({ isPrompt: true, depth: 4 }),
        );
    });

    test('an old turn is not blanked once managed providers are excluded', () => {
        // Stand-in for the engine: the managed window script blanks anything at
        // depth >= 5 unless the caller opted out of runtime-provider scripts.
        applyRegex.mockImplementation((text, _placement, params) => {
            const managedWouldFire = typeof params?.depth !== 'number' || params.depth >= 5;
            if (managedWouldFire && !params?.userScriptsOnly) {
                return '';
            }
            return text;
        });
        expect(regexChatMessageForAgent({ mes: 'turn 40 prose', is_user: false }, 40))
            .toBe('turn 40 prose');
    });

    test('degrades to raw text when the regex API is unreachable', () => {
        globalThis.Luker = undefined;
        __resetRegexApiCacheForTests();
        expect(regexChatMessageForAgent({ mes: 'raw', is_user: false }, 0)).toBe('raw');
    });
});
