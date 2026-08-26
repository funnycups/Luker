// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Coverage for the CPA simulate tool's chat-floor source-message build:
// `buildSimulateSourceMessages` must derive its text-mode carry messages
// from `readPluginFloors` + `floorRecordToTaskMessage`, meaning every
// carried message carries plugin-lane-cooked content (mesCooked) and the
// numeric `sourceFloorIndex` provenance marker.
//
// The module under test is NOT mocked — only the ctx boundary is stubbed.
// Same mock scaffold as tools.test.js, since tools.js captures a wide ctx
// surface at module load.

import { describe, test, expect, beforeAll, jest } from '@jest/globals';

const lodashDefault = (await import('lodash')).default;

// Probe regex rule: the plugin-lane engine stand-in. Cooked output is
// distinguishable from raw text so the assertions below prove mesCooked
// flowed through floorRecordToTaskMessage into message.content.
const probeApplyRegex = (raw, placement, params) =>
    `[cooked|p:${placement}|d:${params?.depth ?? 'none'}]${raw}`;

// Full boot surface — cpa-iteration/tools.js captures `Luker.getContext()`
// at module load (lib.lodash, skills, generateQuietPrompt …), while
// lib/plugin-floors.js reaches the engine via the same getContext().regex.
const lukerCtx = {
    skills: {
        list: jest.fn(async () => []),
        get: jest.fn(),
        listFiles: jest.fn(),
        readFile: jest.fn(),
        search: jest.fn(),
        writeFile: jest.fn(),
        editFile: jest.fn(),
        install: jest.fn(),
        rename: jest.fn(),
        moveScope: jest.fn(),
        delete: jest.fn(),
    },
    lib: {
        yaml: { parse: () => ({}), stringify: () => '' },
        lodash: lodashDefault,
    },
    generateQuietPrompt: async () => 'mocked',
    regex: {
        placement: { USER_INPUT: 1, AI_OUTPUT: 2 },
        applyRegex: probeApplyRegex,
    },
};
globalThis.Luker = { getContext: () => lukerCtx };

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return {
        lodash,
        yaml: { parse: () => ({}), stringify: () => '' },
    };
});

const __lodash = (await import('lodash')).default;
const __testCtx = {
    lib: { lodash: __lodash, yaml: { parse: () => ({}), stringify: () => '' } },
    skills: {
        list: () => Promise.resolve([]),
        get: () => Promise.resolve(null),
        listFiles: () => Promise.resolve({ files: [] }),
        readFile: () => Promise.resolve(''),
        search: () => Promise.resolve({ hits: [] }),
        writeFile: () => Promise.resolve({ ok: true }),
        editFile: () => Promise.resolve({ ok: true }),
        install: () => Promise.resolve({ ok: true }),
        rename: () => Promise.resolve({ ok: true }),
        moveScope: () => Promise.resolve({ ok: true }),
        delete: () => Promise.resolve({ ok: true }),
    },
};
globalThis.SillyTavern = globalThis.SillyTavern || {
    getContext: () => __testCtx,
};

jest.unstable_mockModule('../../public/script.js', () => ({
    generateQuietPrompt: jest.fn(async () => 'mocked model reply'),
    Generate: jest.fn(async () => undefined),
    eventSource: { on: jest.fn(), makeLast: jest.fn(), removeListener: jest.fn() },
    event_types: { CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready', GENERATION_WORLD_INFO_FINALIZED: 'generation_world_info_finalized' },
    getRequestHeaders: jest.fn(() => ({})),
}));

jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/index.js', () => ({
    openSimulationReview: jest.fn(async () => ({
        ok: true,
        cancelled: false,
        toolResultText: '<simulation_result kind="cpa" ok="true">mock</simulation_result>',
        annotations: [],
        chainText: '<simulation_result kind="cpa" ok="true">mock</simulation_result>',
    })),
    buildSimulationToolResult: jest.fn(() => '<simulation_result kind="cpa" ok="true">mock</simulation_result>'),
}));

const __mockRunSkill = jest.fn();
const __mockCommitSkill = jest.fn();
jest.unstable_mockModule('../../public/scripts/iteration-library/tools/skill-iter-studio.js', () => ({
    SKILL_ITER_STUDIO_TOOL_DEFS: [],
    isSkillIterStudioTool: () => true,
    runSkillIterStudioTool: __mockRunSkill,
    commitApprovedSkillProposal: __mockCommitSkill,
}));

let buildSimulateSourceMessages;

beforeAll(async () => {
    ({ buildSimulateSourceMessages } = await import(
        '../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/tools.js'
    ));
});

function makeStContext() {
    const stContext = {
        translate: (s) => s,
        regex: {
            placement: { USER_INPUT: 1, AI_OUTPUT: 2 },
            applyRegex: probeApplyRegex,
        },
        chat: [
            { mes: 'user turn one', is_user: true },   // idx 0
            { mes: 'assistant reply', is_user: false }, // idx 1
            { mes: 'system note', is_system: true },    // idx 2 — re-included by CPA's roles list
            { mes: 'final user turn', is_user: true },  // idx 3
        ],
    };
    return stContext;
}

describe('buildSimulateSourceMessages — floor migration', () => {
    test('text mode carries cooked floors with numeric sourceFloorIndex before the appended turn', async () => {
        const { __resetPluginFloorsCacheForTests } = await import('../../public/scripts/lib/plugin-floors.js');
        __resetPluginFloorsCacheForTests();

        const stContext = makeStContext();
        const out = buildSimulateSourceMessages(stContext, { text: 'next user turn', messages: null });

        expect(out.mode).toBe('text');
        // CPA passes roles ['user','assistant','system'] — the system floor rides along,
        // depth-less; +1 for the appended user turn
        expect(out.messages).toHaveLength(5);

        const carried = out.messages.slice(0, 4);
        for (const [i, message] of carried.entries()) {
            expect(Number.isFinite(message.sourceFloorIndex)).toBe(true);
            expect(message.sourceFloorIndex).toBe([0, 1, 2, 3][i]);
        }

        expect(carried[0]).toMatchObject({ role: 'user', content: '[cooked|p:1|d:2]user turn one' });
        expect(carried[1]).toMatchObject({ role: 'assistant', content: '[cooked|p:2|d:1]assistant reply' });
        // system floor sits outside depth numbering and cooks with no depth filter
        expect(carried[2]).toMatchObject({ role: 'system', content: '[cooked|p:2|d:none]system note' });
        expect(carried[3]).toMatchObject({ role: 'user', content: '[cooked|p:1|d:0]final user turn' });

        const appended = out.messages[4];
        expect(appended).toEqual({ role: 'user', content: 'next user turn' });
        expect(appended.sourceFloorIndex).toBeUndefined();
    });

    test('explicit messages mode wins over text and skips the floor walk', () => {
        const explicit = [{ role: 'user', content: 'structured input' }];
        const out = buildSimulateSourceMessages(makeStContext(), { text: 'ignored', messages: explicit });

        expect(out.mode).toBe('messages');
        expect(out.messages).toEqual(explicit);
        expect(out.messages[0].sourceFloorIndex).toBeUndefined();
    });

    test('no input yields empty mode with no messages', () => {
        const out = buildSimulateSourceMessages(makeStContext(), { text: '', messages: [] });
        expect(out).toEqual({ mode: 'empty', messages: [] });
    });
});
