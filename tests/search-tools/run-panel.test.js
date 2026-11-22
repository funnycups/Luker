// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

const attachDock = jest.fn();
const openRunDock = jest.fn();
let currentCtx = {};

globalThis.Luker = {
    getContext: () => currentCtx,
};

let mod;
beforeAll(async () => {
    mod = await import('../../public/scripts/extensions/search-tools/run-panel.js');
});

beforeEach(() => {
    attachDock.mockClear();
    openRunDock.mockClear();
    currentCtx = {
        chatId: 'chat_1',
        name2: 'Alice',
        groupId: null,
        groups: [],
        characters: [{ avatar: 'alice.png', name: 'Alice' }],
        characterId: 0,
        runPanel: { attachDock, openRunDock },
    };
});

describe('search-tools/run-panel.js', () => {
    test('createSearchRunPanel returns an isolated store and attaches to shared runPanel dock', () => {
        const panel = mod.createSearchRunPanel();
        expect(typeof panel.store.startRun).toBe('function');
        expect(typeof panel.store.appendRound).toBe('function');
        expect(typeof panel.store.finishRun).toBe('function');
        expect(attachDock).toHaveBeenCalledTimes(1);
        expect(attachDock).toHaveBeenCalledWith(panel.store, expect.objectContaining({
            source: 'search',
            getRunContext: expect.any(Function),
        }));
    });

    test('getRunContext returns group chat name when ctx.groupId is set', () => {
        mod.createSearchRunPanel();
        const { getRunContext } = attachDock.mock.calls[0][1];

        expect(getRunContext()).toEqual({ chatId: 'chat_1', chatLabel: 'Alice' });

        currentCtx = {
            ...currentCtx,
            groupId: 'grp_9',
            chatId: 'grp_chat_9',
            groups: [{ id: 'grp_9', name: 'Tavern Party' }],
        };
        expect(getRunContext()).toEqual({ chatId: 'grp_chat_9', chatLabel: 'Tavern Party' });
    });

    test('open() opens shared runPanel dock', async () => {
        const panel = mod.createSearchRunPanel();
        await panel.open();
        expect(openRunDock).toHaveBeenCalledTimes(1);
    });

    test('has zero imports from orchestrator and zero dynamic lens style injection', () => {
        const root = path.resolve(process.cwd(), '..');
        const rpSrc = fs.readFileSync(path.join(root, 'public/scripts/extensions/search-tools/run-panel.js'), 'utf8');
        const mainSrc = fs.readFileSync(path.join(root, 'public/scripts/extensions/search-tools/main.js'), 'utf8');
        expect(rpSrc).not.toMatch(/orchestrator/);
        expect(rpSrc).not.toMatch(/style\.css/);
        expect(mainSrc).not.toMatch(/standaloneDock/);
    });

    test('createSearchToolsSettingsUi.destroy tears down subscribeRunDockPrefs subscription and event handlers', async () => {
        const { createSearchToolsSettingsUi } = await import('../../public/scripts/extensions/search-tools/settings-ui.js');
        const unsub = jest.fn();
        const subscribeRunDockPrefs = jest.fn(() => unsub);
        const off = jest.fn();
        const fakeRoot = {
            length: 1,
            find: () => ({ length: 0, html: () => {}, text: () => {}, prop: () => {}, val: () => '0', toggle: () => {} }),
            off,
            on: () => {},
        };
        const prevJQuery = globalThis.jQuery;
        globalThis.jQuery = (sel) => (sel === '#search_tools_settings' ? fakeRoot : { length: 0 });
        try {
            const ui = createSearchToolsSettingsUi({
                DEFAULT_SETTINGS: { agentSystemPrompt: 'sys' },
                UI_BLOCK_ID: 'search_tools_settings',
                escapeHtml: (s) => String(s ?? ''),
                getAvailableSearchProviders: () => [],
                getConnectionProfileOptions: () => '',
                getContext: () => ({
                    runPanel: {
                        getRunDockPrefs: () => ({ autoOpen: true, defaultSize: 'small' }),
                        subscribeRunDockPrefs,
                    },
                }),
                getOpenAIPresetOptions: () => '',
                getProviderDefinition: () => ({ id: 'ddg', fields: [] }),
                getProviderSettings: () => ({}),
                getSettings: () => ({ provider: 'ddg' }),
                i18n: (s) => s,
                normalizeProvider: (s) => s,
                world_info_position: { atDepth: 4 },
            });
            ui.bindSettingsUi();
            expect(subscribeRunDockPrefs).toHaveBeenCalledTimes(1);
            expect(unsub).not.toHaveBeenCalled();

            ui.destroy();
            expect(unsub).toHaveBeenCalledTimes(1);
            expect(off).toHaveBeenCalledWith('.searchTools');
        } finally {
            globalThis.jQuery = prevJQuery;
        }
    });
});
