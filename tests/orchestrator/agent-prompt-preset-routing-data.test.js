// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Guards the AI-facing shape of `buildAgentPromptPresetRoutingPromptData`
// (and its underlying sanitizer `sanitizeOpenAIPresetNamesForAiPrompt`).
// The AI orchestrator builder consumes this data as YAML in the iteration
// system prompt; the AI must be able to distinguish card-bound vs
// local-global preset names because a card-bound name only resolves on
// the currently active character card (and travels with the card on
// export), while a local-global name is portable across cards.
//
// Regression: prior code returned a single flat `available_chat_completion_presets`
// list built from `getOpenAIPresetNames`, which reads the DOM `<select>`
// that includes card-bound ghost options (see openai.js:upsertCharacterBoundRuntimeOptions).
// The AI could not distinguish origins, and could bake a card-bound name
// into a profile intended for the global library.

import { describe, test, expect, jest, beforeAll } from '@jest/globals';

// defaults.js (transitively imported by agent-resolution's siblings)
// reads `Luker.getContext().constants.{promptRoles,wiPosition}` at
// module load. `agent-resolution.js` itself also grabs
// `Luker.getContext().extensionSettings` at import time. Provide a
// mutable ctx so the test can install card presets by swapping the
// characters array.
const ctxState = {
    characters: [],
    characterId: 0,
    extensionSettings: { orchestrator: {} },
    character: {
        presets: {
            list: (character) => {
                const raw = character?.data?.extensions?.luker?.chat_completion_preset;
                if (!raw || !Array.isArray(raw.presets)) return [];
                return raw.presets.map(p => ({
                    name: p.name,
                    preset: p.preset,
                    isDefault: p.name === raw.defaultPresetName,
                }));
            },
        },
    },
    getPresetManager: (id) => {
        if (id !== 'openai') return null;
        // Mimic the DOM-reading behavior: return whatever the test set up
        // via ctxState._openaiPresetNames — includes card-bound names when
        // present because the real DOM has ghost options.
        return {
            getAllPresets: () => ctxState._openaiPresetNames.slice(),
        };
    },
    _openaiPresetNames: [],
    constants: {
        promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
    },
    lib: {
        yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
    },
};

globalThis.Luker = {
    getContext: () => ctxState,
};

jest.unstable_mockModule('../../public/lib.js', () => ({
    Popper: {},
    lodash: {},
    yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
    default: {},
}));

// Sever the connection-manager gate — profile-resolver.js pulls textgen-models.js
// → document.addEventListener under Node, which fails without JSDOM.
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

let buildAgentPromptPresetRoutingPromptData;
let sanitizeOpenAIPresetNamesForAiPrompt;

beforeAll(async () => {
    ({
        buildAgentPromptPresetRoutingPromptData,
        sanitizeOpenAIPresetNamesForAiPrompt,
    } = await import('../../public/scripts/extensions/orchestrator/agent-resolution.js'));
});

function setCharacterWithPresets(names, defaultName = null) {
    const character = {
        avatar: 'test.png',
        name: 'Test',
        data: {
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: names.map(n => ({ name: n, preset: { temperature: 0.5 } })),
                        defaultPresetName: defaultName,
                    },
                },
            },
        },
    };
    ctxState.characters = [character];
    ctxState.characterId = 0;
}

function setNoCharacter() {
    ctxState.characters = [];
    ctxState.characterId = -1;
}

describe('sanitizeOpenAIPresetNamesForAiPrompt', () => {
    test('returns split shape { local_global, card_bound }', () => {
        setNoCharacter();
        ctxState._openaiPresetNames = ['G1', 'G2'];
        const out = sanitizeOpenAIPresetNamesForAiPrompt(ctxState);
        expect(out).toEqual({ local_global: ['G1', 'G2'], card_bound: [] });
    });

    test('empty when no presets anywhere', () => {
        setNoCharacter();
        ctxState._openaiPresetNames = [];
        const out = sanitizeOpenAIPresetNamesForAiPrompt(ctxState);
        expect(out).toEqual({ local_global: [], card_bound: [] });
    });

    test('splits card-bound names out of the DOM flat list', () => {
        // Real DOM prepends card-bound options as ghosts, so getAllPresets
        // returns card names AND global names in one flat list. Sanitizer
        // must subtract card names from the local-global bucket to keep
        // the two groups mutually exclusive.
        setCharacterWithPresets(['CardOnly', 'Shared']);
        ctxState._openaiPresetNames = ['CardOnly', 'Shared', 'GlobalOnly'];
        const out = sanitizeOpenAIPresetNamesForAiPrompt(ctxState);
        expect(out.card_bound.sort()).toEqual(['CardOnly', 'Shared']);
        expect(out.local_global).toEqual(['GlobalOnly']);
    });

    test('card-bound-only names appear in card_bound even if DOM omits them', () => {
        // Defense: some code paths may pass a context whose preset manager
        // has not been re-hydrated with the ghost options yet (e.g. right
        // after character switch, before openai.js upsertCharacterBoundRuntimeOptions
        // finishes). The card list is the source of truth for card_bound.
        setCharacterWithPresets(['Alpha', 'Beta']);
        ctxState._openaiPresetNames = ['GlobalOne'];
        const out = sanitizeOpenAIPresetNamesForAiPrompt(ctxState);
        expect(out.card_bound.sort()).toEqual(['Alpha', 'Beta']);
        expect(out.local_global).toEqual(['GlobalOne']);
    });
});

describe('buildAgentPromptPresetRoutingPromptData', () => {
    test('returns two distinct lists when a card has embedded presets', () => {
        setCharacterWithPresets(['CardPreset']);
        ctxState._openaiPresetNames = ['CardPreset', 'GlobalPreset'];
        const settings = { llmNodePresetName: 'GlobalPreset' };
        const data = buildAgentPromptPresetRoutingPromptData(ctxState, settings);
        expect(data.available_card_bound_chat_completion_presets).toEqual(['CardPreset']);
        expect(data.available_local_global_chat_completion_presets).toEqual(['GlobalPreset']);
        // The two lists must be mutually exclusive so the AI knows origin
        // unambiguously — a name cannot appear in both.
        const overlap = data.available_card_bound_chat_completion_presets
            .filter(n => data.available_local_global_chat_completion_presets.includes(n));
        expect(overlap).toEqual([]);
    });

    test('card_bound is empty and local_global carries all names when no card is loaded', () => {
        setNoCharacter();
        ctxState._openaiPresetNames = ['G1', 'G2'];
        const data = buildAgentPromptPresetRoutingPromptData(ctxState, {});
        expect(data.available_card_bound_chat_completion_presets).toEqual([]);
        expect(data.available_local_global_chat_completion_presets).toEqual(['G1', 'G2']);
    });

    test('surfaces the global orchestration prompt preset name for fallback context', () => {
        setNoCharacter();
        ctxState._openaiPresetNames = ['P1'];
        const data = buildAgentPromptPresetRoutingPromptData(ctxState, { llmNodePresetName: '  P1  ' });
        expect(data.global_orchestration_prompt_preset).toBe('P1');
    });

    test('drops the legacy flat `available_chat_completion_presets` key so AI cannot see stale data', () => {
        setCharacterWithPresets(['CardPreset']);
        ctxState._openaiPresetNames = ['CardPreset', 'GlobalPreset'];
        const data = buildAgentPromptPresetRoutingPromptData(ctxState, {});
        expect(data).not.toHaveProperty('available_chat_completion_presets');
    });
});
