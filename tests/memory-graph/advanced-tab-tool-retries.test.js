/**
 * Memory Graph advanced settings tool-call retry input must fall back to the
 * Memory Graph default when the field is cleared, and keep an explicit 0 or
 * arbitrarily large integer without clamping.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import './_mocks/main-module-stack.js';
import { normalizeAdvancedSettings } from '../../public/scripts/extensions/memory-graph/config-iteration/advanced-settings.js';
import { TECHNICAL_FIELDS } from '../../public/scripts/extensions/memory-graph/lens/settings/settings-model.js';

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
