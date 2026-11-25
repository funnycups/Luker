/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../public/scripts/lib/edits/engine.js';

const realEditsEngine = createEngine({
    get: lodash.get,
    set: lodash.set,
    unset: lodash.unset,
    isEqual: lodash.isEqual,
    cloneDeep: lodash.cloneDeep,
});

jest.unstable_mockModule('../../public/scripts/lib/edits/index.js', () => ({
    applyEdits: (...args) => realEditsEngine.applyEdits(...args),
    registerOp: (...args) => realEditsEngine.registerOp(...args),
}));
jest.unstable_mockModule('../../public/scripts/extensions/function-call-runtime.js', () => ({
    TOOL_PROTOCOL_STYLE: { JSON_SCHEMA: 'json_schema' },
}));
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class {},
    POPUP_TYPE: { DISPLAY: 'display', CONFIRM: 'confirm' },
}));

describe('CardApp Studio AI chat image attachments', () => {
    let origFetch;
    let origLuker;

    beforeEach(() => {
        origFetch = globalThis.fetch;
        origLuker = globalThis.Luker;
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        globalThis.Luker = origLuker;
    });

    test('sendAIMessage hydrates historical and current user attachments losslessly while keeping conversationMessages lightweight', async () => {
        const img1Bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 11, 22, 33]);
        const img2Bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 44, 55, 66]);
        const disk = new Map([
            ['/user/images/_ai_attachments/ui1.png', img1Bytes],
            ['/user/images/_ai_attachments/ui2.png', img2Bytes],
        ]);
        globalThis.fetch = jest.fn(async (url) => {
            if (disk.has(url)) {
                return { ok: true, status: 200, blob: async () => new Blob([disk.get(url)], { type: 'image/png' }) };
            }
            return { ok: false, status: 404, statusText: 'Not Found', text: async () => 'Not Found' };
        });

        const sentTaskMessages = [];
        const ctx = {
            getRequestHeaders: () => ({}),
            saveSettingsDebounced: () => {},
            translate: (s) => s,
            lib: {
                DOMPurify: { sanitize: (s) => s },
                DiffMatchPatch: class {},
                showdown: { Converter: class { makeHtml(s) { return s; } } },
            },
            extensionSettings: { character_editor_assistant: {} },
            getExtensionApi: () => null,
            getCharacterState: async () => ({ ok: true, state: null }),
            updateCharacterState: async () => ({ ok: true }),
            characters: [],
            worldInfoEntry: { create: () => {}, delete: () => {} },
            chatWorldInfo: { getNames: () => [] },
            loadWorldInfo: async () => ({}),
            saveWorldInfo: async () => {},
            createWorldBook: async () => {},
            charUpdatePrimaryWorld: async () => {},
            getCharaAuxWorlds: () => [],
            importEmbeddedWorldInfo: async () => {},
            getCharacterEmbeddedWorld: () => null,
            getCharaFilename: () => '',
            SlashCommandParser: {},
            writeExtensionField: () => {},
            uuidv4: () => 'uuid-1',
            generateTask: jest.fn(async (opts) => {
                sentTaskMessages.push(JSON.parse(JSON.stringify(opts.taskMessages)));
                return { assistantText: `Handled turn ${sentTaskMessages.length}`, toolCalls: [] };
            }),
        };
        globalThis.Luker = { getContext: () => ctx };

        const { sendAIMessage } = await import('../../public/scripts/extensions/character-editor-assistant/studio/ai-chat.js');

        const history = [];
        await sendAIMessage('char_1', history, 'Match this mockup', {
            systemPrompt: 'Build CardApp UI.',
            attachments: [{ path: '/user/images/_ai_attachments/ui1.png', name: 'ui1.png', mime: 'image/png' }],
        });

        await sendAIMessage('char_1', history, 'Now adjust colors like this', {
            systemPrompt: 'Build CardApp UI.',
            attachments: [{ path: '/user/images/_ai_attachments/ui2.png', name: 'ui2.png', mime: 'image/png' }],
        });

        // Persisted history has NO inline data URLs
        expect(JSON.stringify(history)).not.toContain('data:image/');
        expect(history[0]).toEqual({
            role: 'user',
            content: 'Match this mockup',
            attachments: [{ path: '/user/images/_ai_attachments/ui1.png', name: 'ui1.png', mime: 'image/png' }],
        });

        // Turn 2 outbound taskMessages includes BOTH Turn 1 and Turn 2 lossless image_url parts
        const turn2Messages = sentTaskMessages[1];
        const expected1 = `data:image/png;base64,${Buffer.from(img1Bytes).toString('base64')}`;
        const expected2 = `data:image/png;base64,${Buffer.from(img2Bytes).toString('base64')}`;
        expect(turn2Messages[1].content).toEqual([
            { type: 'text', text: 'Match this mockup' },
            { type: 'image_url', image_url: { url: expected1 } },
        ]);
        expect(turn2Messages[3].content).toEqual([
            { type: 'text', text: 'Now adjust colors like this' },
            { type: 'image_url', image_url: { url: expected2 } },
        ]);
    });
});
