import { describe, test, expect, beforeEach, jest } from '@jest/globals';

import {
    ensureDirectorPureSyntheticPreset,
    applyDirectorPresetSwap,
    restoreDirectorPresetSwap,
    __resetDirectorPresetSwapForTests,
    __getPendingDirectorPresetSnapshotForTests,
} from '../../public/scripts/extensions/orchestrator/director-preset-swap.js';
import { DIRECTOR_PURE_PRESET_NAME, DIRECTOR_PURE_PRESET_BODY } from '../../public/scripts/extensions/orchestrator/pure-preset-body.js';

// Tests run in the default node environment (no jsdom). The swap module
// delegates the actual preset switch to `ctx.openai.applyByName`, so the
// `document` accesses inside ensureDirectorPureSyntheticPreset (dropdown
// option upsert) stay no-ops, and the apply/restore behavior under test
// is whatever `applyByName` does — which we observe via a jest.fn that
// faithfully simulates the core's `onSettingsPresetChange` semantics:
// "copy preset body fields onto oai_settings, do NOT touch keys that
// aren't part of any preset (settings-only keys like `bias_presets`)."

function makeApplyByName(ctx) {
    return jest.fn((presetName) => {
        const idx = ctx.openai.settingNames[presetName];
        const body = Number.isInteger(idx) ? ctx.openai.settings[idx] : null;
        if (!body || typeof body !== 'object') return false;
        for (const key of Object.keys(body)) {
            ctx.chatCompletionSettings[key] = structuredClone(body[key]);
        }
        ctx.chatCompletionSettings.preset_settings_openai = presetName;
        return true;
    });
}

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
        bias_preset_selected: 'Default (none)',
        bias_presets: { 'Default (none)': [], 'Custom-A': [{ id: 'x', text: 'foo', value: -5 }] },
    };
    const _settings = settings ?? [
        {
            temperature: 0.42,
            prompts: oai.prompts,
            prompt_order: oai.prompt_order,
            bias_preset_selected: 'Default (none)',
        },
    ];
    const _names = settingNames ?? { [activeName]: 0 };

    const ctx = {
        chatCompletionSettings: oai,
        callGenericPopup,
        POPUP_TYPE: { CONFIRM: 1 },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: -1 },
        openai: {
            settings: _settings,
            settingNames: _names,
            hasUnsavedChanges,
            savePreset,
            applyByName: null,
        },
    };
    ctx.openai.applyByName = makeApplyByName(ctx);
    return ctx;
}

beforeEach(() => {
    __resetDirectorPresetSwapForTests();
});

describe('ensureDirectorPureSyntheticPreset', () => {
    test('registers synthetic preset into settings + settingNames on first call', () => {
        const ctx = makeCtx();
        const initialLen = ctx.openai.settings.length;
        ensureDirectorPureSyntheticPreset(ctx);
        expect(ctx.openai.settings).toHaveLength(initialLen + 1);
        expect(ctx.openai.settingNames[DIRECTOR_PURE_PRESET_NAME]).toBe(initialLen);
        expect(ctx.openai.settings[initialLen].prompts).toHaveLength(DIRECTOR_PURE_PRESET_BODY.prompts.length);
    });

    test('idempotent re-registration heals manual cache mutations in place', () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);
        const lenAfterFirst = ctx.openai.settings.length;
        const idx = ctx.openai.settingNames[DIRECTOR_PURE_PRESET_NAME];
        ctx.openai.settings[idx].temperature = 999;
        ensureDirectorPureSyntheticPreset(ctx);
        expect(ctx.openai.settings).toHaveLength(lenAfterFirst);
        expect(ctx.openai.settings[idx].temperature).toBe(DIRECTOR_PURE_PRESET_BODY.temperature);
    });

    test('does not throw when openai surface is missing', () => {
        expect(() => ensureDirectorPureSyntheticPreset({ openai: {} })).not.toThrow();
        expect(() => ensureDirectorPureSyntheticPreset({})).not.toThrow();
    });
});

describe('applyDirectorPresetSwap / restoreDirectorPresetSwap — round-trip', () => {
    test('apply routes the swap through ctx.openai.applyByName(DIRECTOR_PURE_PRESET_NAME)', async () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);

        expect(ctx.openai.applyByName).toHaveBeenCalledTimes(1);
        expect(ctx.openai.applyByName.mock.calls[0][0]).toBe(DIRECTOR_PURE_PRESET_NAME);
        expect(ctx.chatCompletionSettings.preset_settings_openai).toBe(DIRECTOR_PURE_PRESET_NAME);
    });

    test('restore routes the swap-back through ctx.openai.applyByName(originalName)', async () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);
        ctx.openai.applyByName.mockClear();

        restoreDirectorPresetSwap(ctx);

        expect(ctx.openai.applyByName).toHaveBeenCalledTimes(1);
        expect(ctx.openai.applyByName.mock.calls[0][0]).toBe('OrigPreset');
        expect(ctx.chatCompletionSettings.preset_settings_openai).toBe('OrigPreset');
    });

    test('full apply/restore cycle preserves settings-only keys (bias_presets regression guard)', async () => {
        // Bug 1: the old hand-rolled restore deleted any oai_settings key that
        // was missing from the original preset cache. `bias_presets` is the
        // settings-only logit-bias dictionary that lives only on oai_settings
        // (no preset body ever stores it). The restore wiped it, and the next
        // openai.js logit-bias check threw
        //   "Cannot read properties of undefined (reading 'Default (none)')"
        // when a sub-agent dispatched with chat_completion_source=openai.
        const ctx = makeCtx();
        const biasPresetsBefore = structuredClone(ctx.chatCompletionSettings.bias_presets);
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);
        restoreDirectorPresetSwap(ctx);

        expect(ctx.chatCompletionSettings.bias_presets).toEqual(biasPresetsBefore);
        expect(ctx.chatCompletionSettings.bias_preset_selected).toBe('Default (none)');
    });

    test('apply auto-heals a leaked snapshot by restoring before re-applying', async () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);
        await applyDirectorPresetSwap(ctx);

        // After the second apply, the active preset is the synthetic one again,
        // and a subsequent restore must still land on OrigPreset (not the
        // leaked synthetic name).
        ctx.openai.applyByName.mockClear();
        restoreDirectorPresetSwap(ctx);
        expect(ctx.openai.applyByName.mock.calls[0][0]).toBe('OrigPreset');
    });

    test('restore is a no-op when no apply is pending', () => {
        const ctx = makeCtx();
        ensureDirectorPureSyntheticPreset(ctx);
        const before = JSON.parse(JSON.stringify(ctx.chatCompletionSettings));
        restoreDirectorPresetSwap(ctx);
        expect(ctx.openai.applyByName).not.toHaveBeenCalled();
        expect(ctx.chatCompletionSettings).toEqual(before);
    });

    test('apply throws when synthetic preset is not registered', async () => {
        const ctx = makeCtx();
        // intentionally do NOT call ensureDirectorPureSyntheticPreset
        await expect(applyDirectorPresetSwap(ctx)).rejects.toThrow(/synthetic preset not registered/);
    });
});

describe('applyDirectorPresetSwap — unsaved-changes guard', () => {
    test('Cancel choice throws and applyByName is never called', async () => {
        const callGenericPopup = jest.fn(async () => -1);
        const ctx = makeCtx({ hasUnsavedChanges: () => true, callGenericPopup });
        ensureDirectorPureSyntheticPreset(ctx);

        await expect(applyDirectorPresetSwap(ctx)).rejects.toThrow(/director cancelled/);
        expect(ctx.openai.applyByName).not.toHaveBeenCalled();
        expect(ctx.chatCompletionSettings.preset_settings_openai).toBe('OrigPreset');
    });

    test('null popup result is treated as Cancel', async () => {
        const callGenericPopup = jest.fn(async () => null);
        const ctx = makeCtx({ hasUnsavedChanges: () => true, callGenericPopup });
        ensureDirectorPureSyntheticPreset(ctx);

        await expect(applyDirectorPresetSwap(ctx)).rejects.toThrow(/director cancelled/);
        expect(ctx.openai.applyByName).not.toHaveBeenCalled();
    });

    test('Save choice persists the dirty preset then proceeds with the swap', async () => {
        const savePreset = jest.fn(async () => {});
        const callGenericPopup = jest.fn(async () => 1);
        const ctx = makeCtx({ hasUnsavedChanges: () => true, callGenericPopup, savePreset });
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);
        expect(savePreset).toHaveBeenCalledWith('OrigPreset', ctx.chatCompletionSettings, false);
        expect(ctx.openai.applyByName.mock.calls[0][0]).toBe(DIRECTOR_PURE_PRESET_NAME);
    });

    test('Discard choice skips save and proceeds with the swap', async () => {
        const savePreset = jest.fn(async () => {});
        const callGenericPopup = jest.fn(async () => 0);
        const ctx = makeCtx({ hasUnsavedChanges: () => true, callGenericPopup, savePreset });
        ensureDirectorPureSyntheticPreset(ctx);

        await applyDirectorPresetSwap(ctx);
        expect(savePreset).not.toHaveBeenCalled();
        expect(ctx.openai.applyByName.mock.calls[0][0]).toBe(DIRECTOR_PURE_PRESET_NAME);
    });
});

describe('applyDirectorPresetSwap / restoreDirectorPresetSwap — card-bound origin', () => {
    // 这些 case 依赖 module-scope DOM globals(document / jQuery / CSS)。
    // 现有测试用 default node env(无 jsdom),我们只在 case 内手工 stub
    // 需要的最小面,`afterEach` 立即还原,不污染其他测试。
    let savedDocument;
    let savedJQuery;
    let savedCSS;

    function installDomStubs({ selectValue, hasOption }) {
        savedDocument = globalThis.document;
        savedJQuery = globalThis.jQuery;
        savedCSS = globalThis.CSS;

        // querySelector 对 ghost option 的存在性回答 hasOption;
        // getElementById 对 #settings_preset_openai 返回 { value }。
        const fakeSelect = { value: selectValue };
        globalThis.document = {
            getElementById: (id) => (id === 'settings_preset_openai' ? fakeSelect : null),
            querySelector: (sel) => {
                // 只识别 restoreDirectorPresetSwap 里那条 query。
                if (sel.startsWith('#settings_preset_openai option[value=')) {
                    return hasOption ? { value: selectValue } : null;
                }
                return null;
            },
        };

        const jqSpy = jest.fn((selector) => {
            expect(selector).toBe('#settings_preset_openai');
            return {
                val: jest.fn(function (v) { jqSpy._lastVal = v; return this; }),
                trigger: jest.fn(function (evt) { jqSpy._lastTrigger = evt; return this; }),
            };
        });
        // jQuery 也当函数用(不需要静态方法)。
        globalThis.jQuery = jqSpy;

        globalThis.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c) };
        return { jqSpy };
    }

    function restoreDomStubs() {
        globalThis.document = savedDocument;
        globalThis.jQuery = savedJQuery;
        globalThis.CSS = savedCSS;
    }

    afterEach(() => {
        restoreDomStubs();
    });

    test('apply 捕获 ghost select value 且 pendingSnapshot.origin === "character"', async () => {
        // 卡绑场景:activeName 是 stale 全局名,但 select 上是 ghost value。
        const ctx = makeCtx({ activeName: 'StaleGlobal' });
        // 注册 stale 全局到 settingNames/settings 让 applyByName 后续 restore
        // 分支不 throw(即便本 case 不走它)。
        ctx.openai.settingNames['StaleGlobal'] = 0;
        ensureDirectorPureSyntheticPreset(ctx);

        const ghostValue = '__luker_card__::' + encodeURIComponent('Aria.png') + '::' + encodeURIComponent('CardBoundSlot');
        installDomStubs({ selectValue: ghostValue, hasOption: true });

        await applyDirectorPresetSwap(ctx);

        const snapshot = __getPendingDirectorPresetSnapshotForTests();
        expect(snapshot).toEqual({
            activeName: 'StaleGlobal',
            ghostSelectValue: ghostValue,
            origin: 'character',
        });
        // apply 仍然把 director-pure 挂上去(与 global 分支一致)。
        expect(ctx.openai.applyByName).toHaveBeenCalledWith(DIRECTOR_PURE_PRESET_NAME, { forceChange: true });
    });

    test('restore 走 jQuery.val().trigger("change") 分支,不调 applyByName(activeName)', async () => {
        const ctx = makeCtx({ activeName: 'StaleGlobal' });
        ctx.openai.settingNames['StaleGlobal'] = 0;
        ensureDirectorPureSyntheticPreset(ctx);

        const ghostValue = '__luker_card__::' + encodeURIComponent('Aria.png') + '::' + encodeURIComponent('CardBoundSlot');
        const { jqSpy } = installDomStubs({ selectValue: ghostValue, hasOption: true });

        await applyDirectorPresetSwap(ctx);
        // apply 触发了 1 次 applyByName(director-pure)。清空以观察 restore 行为。
        ctx.openai.applyByName.mockClear();

        restoreDirectorPresetSwap(ctx);

        // 关键断言:restore 走 jQuery 分支,**未**调 applyByName(避免落到 stale 全局)。
        expect(ctx.openai.applyByName).not.toHaveBeenCalled();
        expect(jqSpy).toHaveBeenCalledWith('#settings_preset_openai');
        expect(jqSpy._lastVal).toBe(ghostValue);
        expect(jqSpy._lastTrigger).toBe('change');
    });

    test('restore 遇到 ghost <option> missing 时降级到 applyByName(activeName) 并 console.warn', async () => {
        const ctx = makeCtx({ activeName: 'StaleGlobal' });
        ctx.openai.settingNames['StaleGlobal'] = 0;
        ensureDirectorPureSyntheticPreset(ctx);

        const ghostValue = '__luker_card__::' + encodeURIComponent('Aria.png') + '::' + encodeURIComponent('CardBoundSlot');
        installDomStubs({ selectValue: ghostValue, hasOption: false });

        await applyDirectorPresetSwap(ctx);
        ctx.openai.applyByName.mockClear();

        // Use a wrapper on globalThis.console to bypass any spyOn quirks with ESM.
        const origWarn = console.warn;
        const warnCalls = [];
        console.warn = (...args) => { warnCalls.push(args); };
        try {
            restoreDirectorPresetSwap(ctx);
        } finally {
            console.warn = origWarn;
        }

        // Fallback:apply stale 全局。
        expect(ctx.openai.applyByName).toHaveBeenCalledTimes(1);
        expect(ctx.openai.applyByName.mock.calls[0][0]).toBe('StaleGlobal');
        // 记录了一条 warn(至少含 '[director]' 前缀 + ghostSelectValue)。
        expect(warnCalls.length).toBeGreaterThanOrEqual(1);
        const warnArgs = warnCalls[0];
        expect(String(warnArgs[0])).toMatch(/\[director\].*ghost option missing/);
        expect(warnArgs[1]).toMatchObject({ activeName: 'StaleGlobal', ghostSelectValue: ghostValue });
    });

    test('character origin skips unsaved-changes popup even when hasUnsavedChanges returns true', async () => {
        // Guard for the Task-3 popup-skip fix (assertion (a) in e2e 49).
        // Pre-fix, director-preset-swap called hasUnsavedChanges(activeName)
        // with the stale global name → global branch inside Task 2's
        // origin-aware detector saw live-vs-global diff and returned true →
        // popup fired and its "Save" branch would write the card slot body
        // into the wrong global preset. Fix: skip the guard entirely in
        // character origin (auto-sync already protects the user's edits).
        const callGenericPopup = jest.fn(async () => 0);
        const ctx = makeCtx({
            activeName: 'StaleGlobal',
            hasUnsavedChanges: () => true,
            callGenericPopup,
        });
        ctx.openai.settingNames['StaleGlobal'] = 0;
        ensureDirectorPureSyntheticPreset(ctx);

        const ghostValue = '__luker_card__::' + encodeURIComponent('Aria.png') + '::' + encodeURIComponent('CardBoundSlot');
        installDomStubs({ selectValue: ghostValue, hasOption: true });

        await applyDirectorPresetSwap(ctx);

        expect(callGenericPopup).not.toHaveBeenCalled();
        // Swap still happens.
        expect(ctx.openai.applyByName).toHaveBeenCalledWith(DIRECTOR_PURE_PRESET_NAME, { forceChange: true });
    });
});
