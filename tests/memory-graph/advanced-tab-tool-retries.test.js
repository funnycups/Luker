/**
 * Memory Graph advanced settings tool-call retry input must fall back to the
 * Memory Graph default when the field is cleared, and keep an explicit 0 or
 * arbitrarily large integer without clamping.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import {
    createExtensionRegistry,
    installBrowserModuleContext,
    installDomReadyJQuery,
    loadStateErrorsApi,
} from '../util/browser-module-context.js';
import { normalizeAdvancedSettings } from '../../public/scripts/extensions/memory-graph/config-iteration/advanced-settings.js';
import { TECHNICAL_FIELDS } from '../../public/scripts/extensions/memory-graph/lens/settings/settings-model.js';

installDomReadyJQuery();
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
};
globalThis.toastr = {
    info: () => null,
    success: () => null,
    warning: () => null,
    error: () => null,
    clear: () => {},
};

const stateErrors = await loadStateErrorsApi();
const extensionRegistry = createExtensionRegistry();
installBrowserModuleContext({
    constants: {
        promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        promptTypes: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
        wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        unset: Symbol('UNSET_VALUE'),
    },
    resolveChatStateTarget: () => ({ is_group: false, avatar_url: 'avatar.png', file_name: 'chat-0' }),
    saveSettings: async () => ({ ok: true, status: 'saved' }),
    saveSettingsDebounced: () => {},
    extensionSettings: { memory_graph: {} },
    download: () => {},
    getFileText: () => Promise.resolve(''),
    getStringHash: () => '',
    worldInfoEntry: { template: {}, setGlobalSelection: async () => false },
    stateErrors,
    regex: { getScripts: () => [], saveScripts: () => {} },
    getExtensionApi: extensionRegistry.getExtensionApi,
    registerExtensionApi: extensionRegistry.registerExtensionApi,
    translate: (s) => String(s ?? ''),
    addLocaleData: () => {},
    getCurrentLocale: () => 'en-US',
});

describe('memory-graph advanced settings tool-call retries', () => {
    let saveMemoryAdvancedSettings;
    let getSettings;

    beforeAll(async () => {
        const mainMod = await import('../../public/scripts/extensions/memory-graph/main.js');
        saveMemoryAdvancedSettings = mainMod.saveMemoryAdvancedSettings;
        getSettings = mainMod.getSettings;
    });

    test('a cleared field falls back to the Memory Graph default (2)', async () => {
        const settings = getSettings();
        settings.toolCallRetryMax = 7;
        await saveMemoryAdvancedSettings({}, { ...settings, toolCallRetryMax: '' }, 'global');
        expect(getSettings().toolCallRetryMax).toBe(2);

        const normalized = normalizeAdvancedSettings({ toolCallRetryMax: '' }, { toolCallRetryMax: 2 });
        expect(normalized.toolCallRetryMax).toBe(2);
    });

    test('an explicit 0 is kept', async () => {
        const settings = getSettings();
        settings.toolCallRetryMax = 7;
        await saveMemoryAdvancedSettings({}, { ...settings, toolCallRetryMax: '0' }, 'global');
        expect(getSettings().toolCallRetryMax).toBe(0);
    });

    test('a typed value above 10 is kept without clamping', async () => {
        const settings = getSettings();
        settings.toolCallRetryMax = 2;
        await saveMemoryAdvancedSettings({}, { ...settings, toolCallRetryMax: '25' }, 'global');
        expect(getSettings().toolCallRetryMax).toBe(25);

        const retryDef = TECHNICAL_FIELDS.find((d) => d.key === 'toolCallRetryMax');
        expect(retryDef).toBeDefined();
        expect(retryDef?.max).toBeUndefined();
    });
});
