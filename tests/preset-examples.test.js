/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, jest } from '@jest/globals';

let presetExamples;

beforeAll(async () => {
    jest.unstable_mockModule('../public/scripts/popup.js', () => ({
        Popup: class {},
        POPUP_TYPE: { CONFIRM: 'confirm' },
        POPUP_RESULT: { AFFIRMATIVE: 1, CANCELLED: 0 },
    }));
    presetExamples = await import('../public/scripts/lens-shared/preset-examples.js');
});

function fakeContext({ installed = false } = {}) {
    const manager = {
        findPreset: jest.fn((name) => (installed && name === 'plugin-only' ? { name } : null)),
        getAllPresets: jest.fn(() => (installed ? ['plugin-only'] : [])),
        savePreset: jest.fn(async () => {}),
    };
    return { context: { getPresetManager: () => manager }, manager };
}

describe('preset examples', () => {
    test('maps director mode to the director example and everything else to plugin-only', () => {
        expect(presetExamples.exampleNameForMode('director')).toBe('agent-director');
        expect(presetExamples.exampleNameForMode('single')).toBe('plugin-only');
        expect(presetExamples.exampleNameForMode('')).toBe('plugin-only');
    });

    test('detects an installed preset through the manager', () => {
        const { context } = fakeContext({ installed: true });
        expect(presetExamples.isPresetInstalled('plugin-only', context)).toBe(true);
        expect(presetExamples.isPresetInstalled('agent-director', context)).toBe(false);
    });

    test('imports a missing example without asking for confirmation', async () => {
        const { context, manager } = fakeContext();
        const confirm = jest.fn(async () => true);
        const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ temperature: 1 }) }));

        await expect(presetExamples.importPresetExample('plugin-only', { context, confirm, fetchImpl })).resolves.toBe(true);
        expect(confirm).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledWith('/presets/plugin-only.json');
        expect(manager.savePreset).toHaveBeenCalledWith('plugin-only', { temperature: 1, name: 'plugin-only' });
    });

    test('does not fetch or write when overwrite is declined', async () => {
        const { context, manager } = fakeContext({ installed: true });
        const confirm = jest.fn(async () => false);
        const fetchImpl = jest.fn();

        await expect(presetExamples.importPresetExample('plugin-only', { context, confirm, fetchImpl })).resolves.toBe(false);
        expect(confirm).toHaveBeenCalledWith('plugin-only');
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(manager.savePreset).not.toHaveBeenCalled();
    });

    test('overwrites an existing example after confirmation', async () => {
        const { context, manager } = fakeContext({ installed: true });
        const confirm = jest.fn(async () => true);
        const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ temperature: 1 }) }));

        await expect(presetExamples.importPresetExample('plugin-only', { context, confirm, fetchImpl })).resolves.toBe(true);
        expect(manager.savePreset).toHaveBeenCalledTimes(1);
    });

    test('rejects names outside the bundled examples', async () => {
        const { context } = fakeContext();
        await expect(presetExamples.importPresetExample('../secret', { context })).rejects.toThrow('Unrecognized preset');
    });

    test('opens the preset workspace with the requested edit mode', async () => {
        const open = jest.fn(async () => ({ id: 'handle' }));
        await expect(presetExamples.openPresetDerivation('jailbreak-only', { workbench: { open } })).resolves.toEqual({ id: 'handle' });
        expect(open).toHaveBeenCalledWith({ page: 'ai', ws: 'preset', launch: { presetMode: 'jailbreak-only' } });
    });

    test('reports an unavailable Workbench instead of navigating elsewhere', async () => {
        await expect(presetExamples.openPresetDerivation('jailbreak-only', { workbench: null })).rejects.toThrow('Workbench is unavailable.');
    });
});
