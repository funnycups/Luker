/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';

const updateCharacterStateMock = jest.fn();
const getCharacterStateMock = jest.fn();

const mockCtx = {
    characters: [{ avatar: 'alice.png', name: 'Alice', data: {} }],
    characterId: 0,
    getRequestHeaders: () => ({}),
    saveSettingsDebounced: () => {},
    getCharaFilename: (_chid, opts) => String(opts?.manualAvatarKey || '').replace(/\.png$/i, ''),
    extensionSettings: { character_editor_assistant: {} },
    getExtensionApi: () => null,
    getCharacterState: (...args) => getCharacterStateMock(...args),
    updateCharacterState: (...args) => updateCharacterStateMock(...args),
    worldInfoEntry: { create: () => {}, delete: () => {} },
    chatWorldInfo: { getNames: () => [] },
    loadWorldInfo: async () => ({}),
    saveWorldInfo: async () => {},
    createWorldBook: async () => {},
    charUpdatePrimaryWorld: async () => {},
    getCharaAuxWorlds: () => [],
    importEmbeddedWorldInfo: async () => {},
    getCharacterEmbeddedWorld: () => null,
    SlashCommandParser: {},
    writeExtensionField: async () => true,
    uuidv4: () => 'uuid-1',
    lib: {
        DOMPurify: { sanitize: (html) => html },
        DiffMatchPatch: class {},
        showdown: {
            Converter: class {
                makeHtml(text) { return `<p>${text}</p>`; }
            },
        },
    },
};

globalThis.Luker = { getContext: () => mockCtx };

let openCardAppStudio;

beforeAll(async () => {
    globalThis.toastr = {
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    };
    globalThis.confirm = jest.fn(() => true);
    globalThis.fetch = jest.fn(async (url) => {
        if (String(url).endsWith('/files')) {
            return { ok: true, json: async () => ({ files: [] }) };
        }
        return { ok: true, json: async () => ({ commits: [] }) };
    });
    ({ openCardAppStudio } = await import('../../public/scripts/extensions/character-editor-assistant/studio/studio.js'));
});

beforeEach(() => {
    document.body.innerHTML = '';
    globalThis.localStorage.setItem('luker_cea_studio_legacy_v2_wiped', '1');
    globalThis.toastr.info.mockClear();
    globalThis.toastr.success.mockClear();
    globalThis.toastr.warning.mockClear();
    globalThis.toastr.error.mockClear();
    updateCharacterStateMock.mockReset();
    getCharacterStateMock.mockReset();
});

afterEach(async () => {
    const closeBtn = document.querySelector('[data-studio-action="close"]');
    if (closeBtn) {
        updateCharacterStateMock.mockResolvedValue({ ok: true });
        closeBtn.click();
        await new Promise(r => setTimeout(r, 0));
    }
});

describe('CardApp Studio saveAllSessions failure propagation', () => {
    test('new-session, clear-chat, and delete-session keep in-memory chat and avoid success toasts when save fails', async () => {
        const storedSessions = [
            {
                id: 'sess-1',
                summary: 'First session',
                updatedAt: 2000,
                messages: [
                    { role: 'user', content: 'Hello studio' },
                    { role: 'assistant', content: 'Hi there' },
                ],
            },
            {
                id: 'sess-2',
                summary: 'Second session',
                updatedAt: 1000,
                messages: [{ role: 'user', content: 'Other' }],
            },
        ];

        getCharacterStateMock.mockResolvedValue({
            ok: true,
            state: { version: 1, sessions: storedSessions },
        });
        updateCharacterStateMock.mockResolvedValue({
            ok: false,
            reason: 'HTTP_ERROR',
            hint: '500 Internal Server Error',
        });

        // Skip webpack-only /codemirror.bundle.js dynamic import during openCardAppStudio
        const origQuerySelector = document.querySelector.bind(document);
        const qsSpy = jest.spyOn(document, 'querySelector').mockImplementation((sel) => (
            sel === '[data-studio-code]' ? null : origQuerySelector(sel)
        ));
        try {
            await openCardAppStudio('alice');
        } finally {
            qsSpy.mockRestore();
        }
        const chatEl = document.querySelector('[data-studio-chat]');
        expect(chatEl.textContent).toContain('Hello studio');
        expect(chatEl.textContent).toContain('Hi there');

        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            // 1. New session fails to persist current session -> MUST NOT wipe chat or toast "New session created"
            document.querySelector('[data-studio-action="new-session"]').click();
            await new Promise(r => setTimeout(r, 0));
            expect(chatEl.textContent).toContain('Hello studio');
            expect(globalThis.toastr.info).not.toHaveBeenCalled();
            expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);

            // 2. Clear chat fails to persist deletion -> MUST NOT wipe chat
            globalThis.toastr.error.mockClear();
            document.querySelector('[data-studio-action="clear-chat"]').click();
            await new Promise(r => setTimeout(r, 0));
            expect(chatEl.textContent).toContain('Hello studio');
            expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);

            // 3. Open sessions list and try delete-session -> fails, MUST NOT wipe chat or toast success
            globalThis.toastr.error.mockClear();
            globalThis.toastr.success.mockClear();
            document.querySelector('[data-studio-action="sessions-toggle"]').click();
            await new Promise(r => setTimeout(r, 0));
            const deleteCurrentBtn = document.querySelector('[data-studio-action="delete-session"][data-session-id="sess-1"]');
            expect(deleteCurrentBtn).not.toBeNull();
            deleteCurrentBtn.click();
            await new Promise(r => setTimeout(r, 0));
            expect(chatEl.textContent).toContain('Hello studio');
            expect(globalThis.toastr.success).not.toHaveBeenCalled();
            expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);

            // 4. Load another session when saving current session rejects -> MUST NOT switch or toast success
            globalThis.toastr.error.mockClear();
            globalThis.toastr.success.mockClear();
            updateCharacterStateMock.mockRejectedValueOnce(new Error('network offline'));
            const loadOtherBtn = document.querySelector('[data-studio-action="load-session"][data-session-id="sess-2"]');
            expect(loadOtherBtn).not.toBeNull();
            loadOtherBtn.click();
            await new Promise(r => setTimeout(r, 0));
            expect(chatEl.textContent).toContain('Hello studio');
            expect(globalThis.toastr.success).not.toHaveBeenCalled();
            expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        } finally {
            errSpy.mockRestore();
        }
    });
});
