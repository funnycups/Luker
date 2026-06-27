import { describe, test, expect, beforeEach, jest } from '@jest/globals';

import {
    ensureDirectorPureSyntheticPreset,
    applyDirectorPresetSwap,
    restoreDirectorPresetSwap,
    __resetDirectorPresetSwapForTests,
    __getPendingDirectorPresetSnapshotForTests,
} from '../../public/scripts/extensions/orchestrator/director-preset-swap.js';
import { DIRECTOR_PURE_PRESET_NAME, DIRECTOR_PURE_PRESET_BODY } from '../../public/scripts/extensions/orchestrator/pure-preset-body.js';

// The swap module accesses `document` for dropdown updates, but guards
// every reference with `typeof document === 'undefined'`. Under the
// default node test environment (no jsdom), these helpers are no-ops on
// the DOM side and we can assert against the cache + oai_settings
// mutations alone — which is where the data-loss bug lives.

function makeCtx({
    activeName = 'OrigPreset',
    oaiSettings,
    settings,
    settingNames,
    hasUnsavedChanges = () => false,
    savePreset = jest.fn(async () => {}),
    callGenericPopup = jest.fn(async () => null),
} = {}) {
    const oai = oaiSettings ?? {
        preset_settings_openai: activeName,
        temperature: 0.42,
        prompts: [{ identifier: 'main', content: 'orig main' }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
    };
    const _settings = settings ?? [
        { temperature: 0.42, prompts: oai.prompts, prompt_order: oai.prompt_order },
    ];
    const _names = settingNames ?? { [activeName]: 0 };

    return {
        chatCompletionSettings: oai,
        callGenericPopup,
        POPUP_TYPE: { CONFIRM: 1 },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: -1 },
        openai: {
            settings: _settings,
            settingNames: _names,
            hasUnsavedChanges,
            savePreset,
            promptManager: { render: jest.fn() },
        },
    };
}

beforeEach(() => {
    __resetDirectorPresetSwapForTests();
});

describe('ensureDirectorPureSyntheticPreset', () => {
    test('registers synthetic preset on first call', () => {
        const ctx = makeCtx();
        const initialLen = ctx.openai.settings.length;
        ensureDirectorPureSyntheticPreset(ctx);
        expect(ctx.openai.settings).toHaveLength(initialLen + 1);
        expect(ctx.openai.settingNames[DIRECTOR_PURE_PRESET_NAME]).toBe(initialLen);
        expect(ctx.openai.settings[initialLen].prompts).toHaveLength(DIRECTOR_PURE_PRESET_BODY.prompts.length);
    });

    test('idempotent: re-registration does not push a second cache slot', () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);
        const lenAfterFirst = ctx.openai.settings.length;
        ensureDirectorPureSyntheticPreset(ctx);
        expect(ctx.openai.settings).toHaveLength(lenAfterFirst);
    });

    test('re-registration replaces the cached body in place (heals manual mutations)', () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);
        const idx = ctx.openai.settingNames[DIRECTOR_PURE_PRESET_NAME];
        ctx.openai.settings[idx].temperature = 999;
        ensureDirectorPureSyntheticPreset(ctx);
        expect(ctx.openai.settings[idx].temperature).toBe(DIRECTOR_PURE_PRESET_BODY.temperature);
    });

    test('does not throw when openai surface is missing (defensive)', () => {
        expect(() => ensureDirectorPureSyntheticPreset({ openai: {} })).not.toThrow();
        expect(() => ensureDirectorPureSyntheticPreset({})).not.toThrow();
    });
});

describe('applyDirectorPresetSwap', () => {
    test('without unsaved changes, copies pure body into oai_settings and snapshots active', async () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);

        expect(ctx.chatCompletionSettings.preset_settings_openai).toBe(DIRECTOR_PURE_PRESET_NAME);
        expect(ctx.chatCompletionSettings.prompts).toHaveLength(DIRECTOR_PURE_PRESET_BODY.prompts.length);
        expect(ctx.chatCompletionSettings.temperature).toBe(DIRECTOR_PURE_PRESET_BODY.temperature);

        const snap = __getPendingDirectorPresetSnapshotForTests();
        expect(snap).toEqual({ activeName: 'OrigPreset', activeIdx: 0 });
    });

    test('throws if synthetic preset is not registered', async () => {
        const ctx = makeCtx();
        // Intentionally do NOT call ensureDirectorPureSyntheticPreset.
        await expect(applyDirectorPresetSwap(ctx)).rejects.toThrow(/synthetic preset not registered/);
    });

    test('leaked snapshot is healed by restoring before re-applying', async () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);
        expect(__getPendingDirectorPresetSnapshotForTests()).not.toBeNull();

        // Mutate oai_settings to simulate further drift before the second apply.
        await applyDirectorPresetSwap(ctx);
        // Snapshot now reflects the restored active (OrigPreset, not the leaked
        // synthetic name from the first apply).
        const snap = __getPendingDirectorPresetSnapshotForTests();
        expect(snap.activeName).toBe('OrigPreset');
    });

    test('does not consult hasUnsavedChanges when callable is absent', async () => {
        const ctx = makeCtx();
        delete ctx.openai.hasUnsavedChanges;
        ensureDirectorPureSyntheticPreset(ctx);
        await expect(applyDirectorPresetSwap(ctx)).resolves.toBeUndefined();
    });
});

describe('applyDirectorPresetSwap — unsaved-changes guard', () => {
    test('Cancel choice throws and does not apply swap', async () => {
        const callGenericPopup = jest.fn(async () => -1); // CANCELLED
        const ctx = makeCtx({ hasUnsavedChanges: () => true, callGenericPopup });
        ensureDirectorPureSyntheticPreset(ctx);

        const origPrompts = ctx.chatCompletionSettings.prompts;
        const origName = ctx.chatCompletionSettings.preset_settings_openai;

        await expect(applyDirectorPresetSwap(ctx)).rejects.toThrow(/director cancelled/);

        expect(ctx.chatCompletionSettings.prompts).toBe(origPrompts);
        expect(ctx.chatCompletionSettings.preset_settings_openai).toBe(origName);
        expect(__getPendingDirectorPresetSnapshotForTests()).toBeNull();
    });

    test('null popup result is treated as cancel', async () => {
        const callGenericPopup = jest.fn(async () => null);
        const ctx = makeCtx({ hasUnsavedChanges: () => true, callGenericPopup });
        ensureDirectorPureSyntheticPreset(ctx);

        await expect(applyDirectorPresetSwap(ctx)).rejects.toThrow(/director cancelled/);
    });

    test('Save choice calls savePreset(name, settings, false), then applies swap', async () => {
        const savePreset = jest.fn(async () => {});
        const callGenericPopup = jest.fn(async () => 1); // AFFIRMATIVE
        const ctx = makeCtx({ hasUnsavedChanges: () => true, callGenericPopup, savePreset });
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);
        expect(savePreset).toHaveBeenCalledTimes(1);
        expect(savePreset.mock.calls[0][0]).toBe('OrigPreset');
        expect(savePreset.mock.calls[0][2]).toBe(false);
        expect(ctx.chatCompletionSettings.preset_settings_openai).toBe(DIRECTOR_PURE_PRESET_NAME);
    });

    test('Discard choice does not call savePreset; swap still applies and dirty oai_settings is overwritten', async () => {
        const savePreset = jest.fn(async () => {});
        const callGenericPopup = jest.fn(async () => 0); // NEGATIVE
        const ctx = makeCtx({ hasUnsavedChanges: () => true, callGenericPopup, savePreset });
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);
        expect(savePreset).not.toHaveBeenCalled();
        expect(ctx.chatCompletionSettings.preset_settings_openai).toBe(DIRECTOR_PURE_PRESET_NAME);
    });
});

describe('restoreDirectorPresetSwap', () => {
    test('no-op when no swap is pending', () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);
        const before = JSON.parse(JSON.stringify(ctx.chatCompletionSettings));
        restoreDirectorPresetSwap(ctx);
        expect(ctx.chatCompletionSettings).toEqual(before);
    });

    test('restores from cache, picking up any mutation made between apply and restore', async () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);

        // Simulate user clicking "Save and continue" mid-run by mutating cache.
        ctx.openai.settings[0].temperature = 0.99;
        ctx.openai.settings[0].prompts = [{ identifier: 'main', content: 'saved-version' }];

        restoreDirectorPresetSwap(ctx);
        expect(ctx.chatCompletionSettings.temperature).toBe(0.99);
        expect(ctx.chatCompletionSettings.prompts).toEqual([{ identifier: 'main', content: 'saved-version' }]);
        expect(ctx.chatCompletionSettings.preset_settings_openai).toBe('OrigPreset');
        expect(__getPendingDirectorPresetSnapshotForTests()).toBeNull();
    });

    test('drops keys added by pure body but absent from orig', async () => {
        const ctx = makeCtx();
        delete ctx.chatCompletionSettings.top_p;
        delete ctx.openai.settings[0].top_p;
        ensureDirectorPureSyntheticPreset(ctx);
        expect(DIRECTOR_PURE_PRESET_BODY.top_p).toBeDefined();

        await applyDirectorPresetSwap(ctx);
        expect(ctx.chatCompletionSettings.top_p).toBe(DIRECTOR_PURE_PRESET_BODY.top_p);

        restoreDirectorPresetSwap(ctx);
        expect(ctx.chatCompletionSettings.top_p).toBeUndefined();
    });

    test('falls back to stored activeIdx when preset is renamed mid-run', async () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);

        delete ctx.openai.settingNames['OrigPreset'];

        restoreDirectorPresetSwap(ctx);
        expect(ctx.chatCompletionSettings.prompts).toEqual([{ identifier: 'main', content: 'orig main' }]);
    });

    test('calls promptManager.render(false) after restoring', async () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);
        restoreDirectorPresetSwap(ctx);
        expect(ctx.openai.promptManager.render).toHaveBeenCalledWith(false);
    });

    test('renders preset_settings_openai-only update when cache entry is missing', () => {
        const ctx = makeCtx();
        // Manually set up a pending snapshot pointing at a missing slot.
        // We can't call apply (it would refuse without registered synthetic),
        // so go through ensure→apply and then nuke the cache before restore.
        ensureDirectorPureSyntheticPreset(ctx);
        return applyDirectorPresetSwap(ctx).then(() => {
            ctx.openai.settings[0] = null;
            delete ctx.openai.settingNames['OrigPreset'];
            restoreDirectorPresetSwap(ctx);
            expect(ctx.chatCompletionSettings.preset_settings_openai).toBe('OrigPreset');
        });
    });
});
