import './_mocks/luker-zh.js';
import { jest, test } from '@jest/globals';
import assert from 'node:assert/strict';

const scripts = '../../public/scripts/';
const ext = scripts + 'extensions/';
const horizon = 'persistentInjectionMaxSeqDistance';
const globalSettings = { [horizon]: 10 };
const overrides = { A: { marker: true }, B: { [horizon]: 90 } };
const presets = { X: { temperature: 1 }, Y: { temperature: 2 } };
let selected = 'X';
let avatar = 'A';
const ctx = {
    ...Luker.getContext(),
    characters: [{ avatar: 'A' }, { avatar: 'B' }],
    openai: { stripPresetConnectionFields: value => value },
    presets: {
        getSelected: () => ({ name: selected }),
        getStored: ref => ({ body: presets[ref.name] }),
        save: async (ref, body) => { presets[ref.name] = body; return { ok: true }; },
    },
    getExtensionApi: () => ({ getAdvancedScopeInfo: () => ({ scope: 'character', avatar, settings: globalSettings }) }),
};
Luker.getContext = () => ctx;
jest.unstable_mockModule(scripts + 'itemized-prompts.js', () => ({ itemizedParams: {}, itemizedPrompts: {} }));
jest.unstable_mockModule(scripts + 'frontend-log-manager.js', () => ({ getFrontendLogsSnapshot: jest.fn() }));
jest.unstable_mockModule(scripts + 'iteration-library/runner.js', () => ({ requestToolCallsWithRetry: jest.fn() }));
jest.unstable_mockModule(ext + 'connection-manager/profile-resolver.js', () => ({ getChatCompletionConnectionProfiles: jest.fn() }));
jest.unstable_mockModule(ext + 'lens-shared/current-account.js', () => ({ accountLocalStorage: jest.fn() }));
jest.unstable_mockModule(scripts + 'world-info.js', () => ({ worldInfoCache: new Map() }));
jest.unstable_mockModule(scripts + 'named-resource-read.js', () => ({ readWorldInfoDocument: jest.fn() }));
jest.unstable_mockModule(ext + 'memory-graph/main.js', () => ({ getSettings: () => globalSettings }));
jest.unstable_mockModule(ext + 'memory-graph/character-overrides.js', () => ({
    getCharacterAdvancedOverrideByAvatar: (_, target) => overrides[target],
    persistCharacterAdvancedOverridePatch: async (_, target, patch) => {
        Object.assign(overrides[target], patch.set);
        for (const key of patch.unset || []) delete overrides[target][key];
        return true;
    },
}));
const { iterate, setMemoryHorizon } = await import(ext + 'workbench/source-luker.js');

test('a pending preset proposal writes and undoes X while Y stays selected', async () => {
    const original = await iterate.load('preset', 'global');
    selected = 'Y';
    const next = await iterate.load('preset', 'global');
    assert.equal(next.target.ref.name, 'Y');
    const handle = await iterate.commit('preset', original.target, original.live, { temperature: 3 }, ['settings']);
    assert.deepEqual(presets, { X: { temperature: 3 }, Y: { temperature: 2 } });
    await handle.undo();
    assert.deepEqual(presets, { X: { temperature: 1 }, Y: { temperature: 2 } });
    assert.equal(selected, 'Y');
});

test('undoing a home suggestion restores inheritance on its original card', async () => {
    const result = await setMemoryHorizon(30);
    assert.equal(overrides.A[horizon], 30);
    avatar = 'B';
    await result.undo();
    assert.deepEqual(overrides.A, { marker: true });
    assert.equal(overrides.B[horizon], 90);
    assert.equal(globalSettings[horizon], 10);
});
