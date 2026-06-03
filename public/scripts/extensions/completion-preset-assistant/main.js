// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { ensureSimulationReviewLocaleData } from '../../iteration-library/simulation-review/i18n/index.js';
import { Popup } from '../../popup.js';
import { escapeHtml } from '../../utils.js';
import { getChatCompletionConnectionProfiles } from '../connection-manager/profile-resolver.js';
import { cloneJsonValue, isPlainObject } from '../json-state-journal.js';
import { renderPresetHelpButton } from '../preset-help.js';
import { openCpaIterationStudio } from './cpa-iteration/studio.js';
import {
    buildBaseSystemPrompt,
    buildOrchestratorOptimizeModeBlock,
    buildJailbreakOnlyModeBlock,
} from './cpa-iteration/system-prompts.js';
import { openSkillManagerPanel } from '../../skills/skill-manager-panel.js';

const DEFAULT_CPA_BASE_SYSTEM_PROMPT = buildBaseSystemPrompt();
const DEFAULT_CPA_MODE_ORCHESTRATOR_OPTIMIZE = buildOrchestratorOptimizeModeBlock();
const DEFAULT_CPA_MODE_JAILBREAK_ONLY = buildJailbreakOnlyModeBlock();

const MODULE_NAME = 'completion_preset_assistant';
const UI_BLOCK_ID = 'completion_preset_assistant_settings';
const OPEN_BUTTON_ID = 'completion_preset_assistant_open';
const CREATE_BUTTON_ID = 'completion_preset_assistant_create';
const SKILLS_BUTTON_ID = 'completion_preset_assistant_bundle_skills';
const OPENAI_BUTTON_ID = 'completion_preset_assistant_openai_button';
const TOOL_CALL_RETRY_MAX = 10;

const defaultSettings = {
    requestLlmPresetName: '',
    requestApiPresetName: '',
    includeWorldInfo: false,
    toolCallRetryMax: 2,
    useStreamingTransport: false,
    iterBaseSystemPrompt: DEFAULT_CPA_BASE_SYSTEM_PROMPT,
    iterModePromptOrchestratorOptimize: DEFAULT_CPA_MODE_ORCHESTRATOR_OPTIMIZE,
    iterModePromptJailbreakOnly: DEFAULT_CPA_MODE_JAILBREAK_ONLY,
};

function clone(value, fallback = {}) {
    return cloneJsonValue(value, fallback);
}

function i18n(text) {
    return translate(String(text || ''));
}

function i18nFormat(text, ...values) {
    return i18n(text).replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}

function toInteger(value, fallback = 0) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.floor(num);
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = clone(defaultSettings);
    }
    const settings = extension_settings[MODULE_NAME];
    if (settings.requestApiProfileName !== undefined) {
        settings.requestApiPresetName ||= String(settings.requestApiProfileName || '');
        delete settings.requestApiProfileName;
    }
    settings.requestLlmPresetName = String(settings.requestLlmPresetName || '').trim();
    settings.requestApiPresetName = String(settings.requestApiPresetName || '').trim();
    settings.includeWorldInfo = settings.includeWorldInfo === true;
    settings.useStreamingTransport = settings.useStreamingTransport === true;
    settings.toolCallRetryMax = Math.max(0, Math.min(TOOL_CALL_RETRY_MAX, toInteger(settings.toolCallRetryMax, defaultSettings.toolCallRetryMax)));
    delete settings.iterSystemPrompt;
    settings.iterBaseSystemPrompt = String(settings.iterBaseSystemPrompt || '').trim() || DEFAULT_CPA_BASE_SYSTEM_PROMPT;
    settings.iterModePromptOrchestratorOptimize = String(settings.iterModePromptOrchestratorOptimize || '').trim() || DEFAULT_CPA_MODE_ORCHESTRATOR_OPTIMIZE;
    settings.iterModePromptJailbreakOnly = String(settings.iterModePromptJailbreakOnly || '').trim() || DEFAULT_CPA_MODE_JAILBREAK_ONLY;
}

function getSettings() {
    ensureSettings();
    return extension_settings[MODULE_NAME];
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        // Live UI strings owned by main.js
        'Completion Preset Assistant': '聊天补全预设助手',
        'Open Assistant': '打开助手',
        'Create New Preset': '新建预设',
        'Bundle skills with this preset': '将技能打包到此预设',
        'No preset is currently selected.': '当前未选择预设。',
        'Character-bound runtime presets are not directly editable.': '角色卡绑定的运行时预设暂不支持直接编辑。',
        'Enter a name for the new preset.': '请输入新预设名称。',
        'Preset already exists: ${0}': '预设已存在：${0}',
        'Preset created: ${0}': '已创建预设：${0}',
        'Create preset failed.': '创建预设失败。',
        'Iteration AI prompt preset (params + prompt)': '迭代 AI 的提示词预设（参数+提示词）',
        'Iteration AI API preset (Connection profile)': '迭代 AI 的 API 预设（连接配置）',
        'Include world info (simulate current chat)': '包含世界书信息（按当前聊天重新模拟）',
        'Use streaming transport (avoid timeout on slow APIs)': '使用流式传输（避免慢速 API 超时）',
        'Tool-call retries on invalid/missing tool call (N)': '工具调用重试次数（无效/缺失时）',
        'Iteration System Prompts (advanced)': '迭代系统提示词（高级）',
        'Base prompt (sent in every mode)': '基础提示词（每种模式都会发送）',
        'Mode addition — orchestrator-optimize': '模式追加 —— orchestrator-optimize',
        'Mode addition — jailbreak-only': '模式追加 —— jailbreak-only',
        'Reset to default': '重置为默认',
        'Current preset is not a stored chat completion preset. Please select a saved preset first.': '当前不是已保存的聊天补全预设，请先选择一个已保存预设。',
        'AI request failed: ${0}': '模型请求失败：${0}',
        '(none)': '（无）',
        '(current)': '（当前）',
        // Strings consumed by the iteration-studio adapter via deps.i18n
        'Compare with': '对比参考',
        'Compare with reference': '与参考预设比较',
        'Show full diff': '查看完整差异',
        'Show reference diff': '查看参考差异',
        'No edits to show for this message.': '此消息没有可显示的编辑。',
        'Pick a reference preset first.': '请先选择一个参考预设。',
        'Rollback to here': '回滚到这里',
        'Edits for message ${0}': '消息 ${0} 的编辑',
        'Live ↔ ${0}': '当前 ↔ ${0}',
        'rolled back': '已回滚',
        'edit(s)': '条编辑',
        'Editing mode': '编辑模式',
        'General editing': '通用编辑',
        'Adapt for orchestrator': '编排器适配',
        'Jailbreak-only': '仅保留破限',
    });
    addLocaleData('zh-tw', {
        'Completion Preset Assistant': '聊天補全預設助手',
        'Open Assistant': '開啟助手',
        'Create New Preset': '新建預設',
        'Bundle skills with this preset': '將技能打包到此預設',
        'No preset is currently selected.': '目前未選擇預設。',
        'Character-bound runtime presets are not directly editable.': '角色卡綁定的執行時預設暫不支援直接編輯。',
        'Enter a name for the new preset.': '請輸入新預設名稱。',
        'Preset already exists: ${0}': '預設已存在：${0}',
        'Preset created: ${0}': '已建立預設：${0}',
        'Create preset failed.': '建立預設失敗。',
        'Iteration AI prompt preset (params + prompt)': '迭代 AI 的提示詞預設（參數+提示詞）',
        'Iteration AI API preset (Connection profile)': '迭代 AI 的 API 預設（連線設定）',
        'Include world info (simulate current chat)': '包含世界書資訊（按目前聊天重新模擬）',
        'Use streaming transport (avoid timeout on slow APIs)': '使用串流傳輸（避免慢速 API 逾時）',
        'Tool-call retries on invalid/missing tool call (N)': '工具調用重試次數（無效/缺失時）',
        'Iteration System Prompts (advanced)': '迭代系統提示詞（進階）',
        'Base prompt (sent in every mode)': '基礎提示詞（每種模式都會傳送）',
        'Mode addition — orchestrator-optimize': '模式追加 —— orchestrator-optimize',
        'Mode addition — jailbreak-only': '模式追加 —— jailbreak-only',
        'Reset to default': '重置為預設',
        'Current preset is not a stored chat completion preset. Please select a saved preset first.': '目前不是已儲存的聊天補全預設，請先選擇一個已儲存預設。',
        'AI request failed: ${0}': '模型請求失敗：${0}',
        '(none)': '（無）',
        '(current)': '（目前）',
        'Compare with': '對比參考',
        'Compare with reference': '與參考預設比較',
        'Show full diff': '查看完整差異',
        'Show reference diff': '查看參考差異',
        'No edits to show for this message.': '此訊息沒有可顯示的編輯。',
        'Pick a reference preset first.': '請先選擇一個參考預設。',
        'Rollback to here': '回滾到這裡',
        'Edits for message ${0}': '訊息 ${0} 的編輯',
        'Live ↔ ${0}': '目前 ↔ ${0}',
        'rolled back': '已回滾',
        'edit(s)': '條編輯',
        'Editing mode': '編輯模式',
        'General editing': '通用編輯',
        'Adapt for orchestrator': '編排器適配',
        'Jailbreak-only': '僅保留破限',
    });
}

function getConnectionProfileNames() {
    return getChatCompletionConnectionProfiles()
        .map(profile => String(profile?.name || '').trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
}

function getOpenAIPresetNames(context = getContext()) {
    const refs = Array.isArray(context?.presets?.list?.('openai')) ? context.presets.list('openai') : [];
    return refs
        .map(ref => String(ref?.name || '').trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
}

function renderSelectOptions(names, selectedName = '', includeBlank = true, blankLabel = '(none)') {
    const options = [];
    if (includeBlank) {
        options.push(`<option value="">${escapeHtml(i18n(blankLabel))}</option>`);
    }
    for (const name of names) {
        const selected = String(name || '') === String(selectedName || '') ? ' selected' : '';
        options.push(`<option value="${escapeHtml(String(name || ''))}"${selected}>${escapeHtml(String(name || ''))}</option>`);
    }
    return options.join('');
}

function getCurrentTargetRef(context = getContext()) {
    const ref = context?.presets?.getSelected?.('openai');
    return ref && typeof ref === 'object' ? clone(ref, null) : null;
}

function getCurrentLiveSnapshot(context = getContext()) {
    const snapshot = context?.presets?.getLive?.('openai');
    return snapshot && typeof snapshot === 'object' ? clone(snapshot, null) : null;
}

function getStoredDefaultSnapshot(context = getContext()) {
    const snapshot = context?.presets?.getStored?.({ collection: 'openai', name: 'Default' });
    return snapshot && typeof snapshot === 'object' ? clone(snapshot, null) : null;
}

function findCanonicalPresetName(names = [], requestedName = '') {
    const normalizedRequested = String(requestedName || '').trim().toLocaleLowerCase();
    if (!normalizedRequested) return '';
    return names.find((name) => String(name || '').trim().toLocaleLowerCase() === normalizedRequested) || '';
}

async function buildNewPresetBaseline(context = getContext()) {
    try {
        const manager = typeof context?.getPresetManager === 'function'
            ? context.getPresetManager('openai')
            : null;
        if (typeof manager?.getDefaultPreset === 'function') {
            const restored = await manager.getDefaultPreset('Default');
            if (restored?.isDefault && isPlainObject(restored?.preset)) {
                return clone(restored.preset, {});
            }
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to load packaged Default preset baseline`, error);
    }
    const defaultSnapshot = getStoredDefaultSnapshot(context);
    if (isPlainObject(defaultSnapshot?.body)) return clone(defaultSnapshot.body, {});
    const liveSnapshot = getCurrentLiveSnapshot(context);
    if (isPlainObject(liveSnapshot?.body)) return clone(liveSnapshot.body, {});
    return {};
}

async function handleCreateNewPreset() {
    const context = getContext();
    const requestedName = String(await Popup.show.input(
        i18n('Create New Preset'),
        i18n('Enter a name for the new preset.'),
        '',
    ) || '').trim();
    if (!requestedName) return;

    const existingName = findCanonicalPresetName(getOpenAIPresetNames(context), requestedName);
    if (existingName) {
        toastr.warning(i18nFormat('Preset already exists: ${0}', existingName));
        return;
    }

    try {
        const result = await context.presets.save(
            { collection: 'openai', name: requestedName },
            await buildNewPresetBaseline(context),
            { select: true },
        );
        if (!result?.ok || !result?.ref) {
            throw new Error(i18n('Create preset failed.'));
        }
        toastr.success(i18nFormat('Preset created: ${0}', result.ref.name || requestedName));
        await openCpaIteration();
    } catch (error) {
        toastr.error(i18nFormat('AI request failed: ${0}', error?.message || error));
        console.error(`[${MODULE_NAME}] Failed to create preset`, error);
    }
}

/**
 * Resolve the connection-profile name we should use as the `apiId` portion of
 * the preset scope when the user clicks "Bundle skills with this preset".
 *
 * Source of truth precedence (matches the orchestrator's per-agent override
 * pattern, which is what skill-resolution later reads at runtime):
 *   1. CPA's own `requestApiPresetName` if the user has set it explicitly.
 *   2. The active Connection Manager profile (chat completion mode).
 *   3. The chat completion source string ('openai', 'claude', etc.).
 *   4. Fallback to the literal 'openai'.
 *
 * The returned value is the same kind of string that the orchestrator passes
 * as `presetApiId` into `buildSkillRuntimeContext`, so a skill scoped to the
 * returned (apiId, presetName) pair will resolve at request-time without the
 * user having to re-key anything.
 *
 * @returns {string}
 */
function resolveActiveConnectionProfileName() {
    const settings = getSettings();
    const fromCpa = String(settings?.requestApiPresetName || '').trim();
    if (fromCpa) return fromCpa;

    try {
        const cm = extension_settings?.connectionManager;
        const profiles = Array.isArray(cm?.profiles) ? cm.profiles : [];
        const active = profiles.find(p => p && p.id === cm?.selectedProfile);
        const activeName = String(active?.name || '').trim();
        if (activeName) return activeName;
    } catch (_) { /* tolerate sparse extension settings */ }

    try {
        const ctx = getContext();
        const source = String(ctx?.chatCompletionSettings?.chat_completion_source || ctx?.mainApi || '').trim();
        if (source) return source;
    } catch (_) { /* tolerate missing context */ }

    return 'openai';
}

/**
 * Open the Skill Manager popup pre-filtered to the currently-selected preset.
 *
 * Surfaces the same Skill Manager that the orchestrator config exposes, but
 * seeded with `initialScope = preset/<apiId>/<presetName>` so the user lands
 * directly on the skills already bound to this preset. From there they can
 * Import / Create / Move skills into the preset scope, or switch to the
 * Browse-bundled tab to install bundled scaffolds.
 */
async function openBundleSkillsForCurrentPreset() {
    const context = getContext();
    const targetRef = getCurrentTargetRef(context);
    if (!targetRef || !targetRef.name) {
        toastr.warning(i18n('No preset is currently selected.'));
        return;
    }
    const apiId = resolveActiveConnectionProfileName();
    const initialScope = {
        kind: 'preset',
        apiId,
        name: String(targetRef.name),
    };
    try {
        await openSkillManagerPanel({ context, t: i18n, initialScope });
    } catch (e) {
        toastr.error(i18nFormat('AI request failed: ${0}', e?.message || e));
        console.error(`[${MODULE_NAME}] Failed to open Skill Manager`, e);
    }
}

async function openCpaIteration() {
    const context = getContext();

    const targetRef = getCurrentTargetRef(context);
    const liveSnapshot = getCurrentLiveSnapshot(context);
    if (!targetRef || !liveSnapshot?.stored) {
        toastr.warning(i18n('Current preset is not a stored chat completion preset. Please select a saved preset first.'));
        return;
    }    function getTargetRef() {
        const current = getCurrentTargetRef(context);
        return current || { collection: 'openai', name: targetRef.name };
    }

    await openCpaIterationStudio({
        i18n,
        i18nFormat,
        escapeHtml,
        context,
        getContext: () => context,
        getTargetRef,
        getReferencePresets: () => {
            const names = getOpenAIPresetNames(context);
            return names.map(name => ({ name }));
        },
        getReferencePresetBody: async (name) => {
            const ref = { collection: 'openai', name };
            const stored = context?.presets?.getStored?.(ref);
            if (stored?.body) return clone(stored.body, null);
            return await context.presets.get(ref);
        },
        shouldIncludeWorldInfo: () => Boolean(getSettings()?.includeWorldInfo),
        getSettings,
        saveSettingsDebounced,
        getRequestPresetOptions: () => ({
            llmPresetName: String(getSettings()?.requestLlmPresetName || '').trim(),
            apiPresetName: String(getSettings()?.requestApiPresetName || '').trim(),
        }),
        // `preset_clone_to_new` tool wiring. Snapshots the popup's current
        // target body (stored on disk, not the sandbox), saves it under
        // `newName`, and `select: true` flips the popup's target so the
        // AI's next edits land on the clone — matches the prompt-side
        // "derive before destructive edit" safety pattern.
        cloneAndSwitchTarget: async (newName) => {
            const trimmedName = String(newName || '').trim();
            if (!trimmedName) {
                return { ok: false, error: 'New preset name is required.' };
            }
            const ctx = getContext();
            const existing = findCanonicalPresetName(getOpenAIPresetNames(ctx), trimmedName);
            if (existing) {
                return { ok: false, error: `Preset already exists: ${existing}` };
            }
            const sourceRef = getTargetRef();
            if (!sourceRef) {
                return { ok: false, error: 'No source preset to clone.' };
            }
            const stored = ctx?.presets?.getStored?.(sourceRef);
            const sourceBody = isPlainObject(stored?.body)
                ? stored.body
                : await ctx.presets.get(sourceRef);
            if (!isPlainObject(sourceBody)) {
                return { ok: false, error: 'No source preset body to clone.' };
            }
            try {
                const result = await ctx.presets.save(
                    { collection: 'openai', name: trimmedName },
                    clone(sourceBody, {}),
                    { select: true },
                );
                if (!result?.ok || !result?.ref) {
                    return { ok: false, error: 'Save returned no ref.' };
                }
                return { ok: true };
            } catch (err) {
                return { ok: false, error: String(err?.message || err || 'clone failed') };
            }
        },
    });
}

function ensureOpenAiToolbarButton() {
    const toolbar = jQuery('#openai_api-presets .preset_manager_select_actions').first();
    if (!toolbar.length || toolbar.find(`#${OPENAI_BUTTON_ID}`).length) return;

    toolbar.append(`
<div id="${OPENAI_BUTTON_ID}" class="menu_button menu_button_icon completion-preset-assistant-open" title="${escapeHtml(i18n('Open Assistant'))}">
    <i class="fa-fw fa-solid fa-wand-magic-sparkles"></i>
</div>`);
}

function refreshUiState(context = getContext()) {
    ensureSettings();
    ensureOpenAiToolbarButton();
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) return;

    const settings = getSettings();
    root.find('#cpa_request_llm_preset').html(renderSelectOptions(getOpenAIPresetNames(context), settings.requestLlmPresetName, true, '(current)'));
    root.find('#cpa_request_api_preset').html(renderSelectOptions(getConnectionProfileNames(), settings.requestApiPresetName, true, '(current)'));
    root.find('#cpa_include_world_info').prop('checked', settings.includeWorldInfo === true);
    root.find('#cpa_use_streaming_transport').prop('checked', Boolean(settings.useStreamingTransport));
    root.find('#cpa_tool_retries').val(String(settings.toolCallRetryMax));
    root.find('#cpa_iter_base_system_prompt').val(String(settings.iterBaseSystemPrompt || ''));
    root.find('#cpa_iter_mode_orchestrator_optimize').val(String(settings.iterModePromptOrchestratorOptimize || ''));
    root.find('#cpa_iter_mode_jailbreak_only').val(String(settings.iterModePromptJailbreakOnly || ''));
}

function bindUi() {
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) return;

    root.off('.cpa');
    jQuery(document).off('.cpaOpen');

    root.on('click.cpa', `#${OPEN_BUTTON_ID}`, async function () {
        await openCpaIteration();
    });
    root.on('click.cpa', `#${CREATE_BUTTON_ID}`, async function () {
        await handleCreateNewPreset();
    });
    root.on('click.cpa', `#${SKILLS_BUTTON_ID}`, async function () {
        await openBundleSkillsForCurrentPreset();
    });
    root.on('change.cpa', '#cpa_request_llm_preset', function () {
        getSettings().requestLlmPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });
    root.on('change.cpa', '#cpa_request_api_preset', function () {
        getSettings().requestApiPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });
    root.on('change.cpa', '#cpa_include_world_info', function () {
        getSettings().includeWorldInfo = jQuery(this).prop('checked') === true;
        saveSettingsDebounced();
    });
    root.on('change.cpa', '#cpa_use_streaming_transport', function () {
        getSettings().useStreamingTransport = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });
    root.on('change.cpa', '#cpa_tool_retries', function () {
        getSettings().toolCallRetryMax = Math.max(0, Math.min(TOOL_CALL_RETRY_MAX, toInteger(jQuery(this).val(), defaultSettings.toolCallRetryMax)));
        saveSettingsDebounced();
        refreshUiState();
    });

    root.on('input.cpa change.cpa', '#cpa_iter_base_system_prompt', function () {
        getSettings().iterBaseSystemPrompt = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    root.on('input.cpa change.cpa', '#cpa_iter_mode_orchestrator_optimize', function () {
        getSettings().iterModePromptOrchestratorOptimize = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    root.on('input.cpa change.cpa', '#cpa_iter_mode_jailbreak_only', function () {
        getSettings().iterModePromptJailbreakOnly = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    root.on('click.cpa', '#cpa_reset_iter_base_system_prompt', function () {
        getSettings().iterBaseSystemPrompt = DEFAULT_CPA_BASE_SYSTEM_PROMPT;
        root.find('#cpa_iter_base_system_prompt').val(DEFAULT_CPA_BASE_SYSTEM_PROMPT);
        saveSettingsDebounced();
    });

    root.on('click.cpa', '#cpa_reset_iter_mode_orchestrator_optimize', function () {
        getSettings().iterModePromptOrchestratorOptimize = DEFAULT_CPA_MODE_ORCHESTRATOR_OPTIMIZE;
        root.find('#cpa_iter_mode_orchestrator_optimize').val(DEFAULT_CPA_MODE_ORCHESTRATOR_OPTIMIZE);
        saveSettingsDebounced();
    });

    root.on('click.cpa', '#cpa_reset_iter_mode_jailbreak_only', function () {
        getSettings().iterModePromptJailbreakOnly = DEFAULT_CPA_MODE_JAILBREAK_ONLY;
        root.find('#cpa_iter_mode_jailbreak_only').val(DEFAULT_CPA_MODE_JAILBREAK_ONLY);
        saveSettingsDebounced();
    });

    jQuery(document).on('click.cpaOpen', `#${OPENAI_BUTTON_ID}`, async function () {
        await openCpaIteration();
    });
}

function ensureUi(context = getContext()) {
    const host = jQuery('#extensions_settings2');
    if (!host.length) return;

    ensureOpenAiToolbarButton();
    if (jQuery(`#${UI_BLOCK_ID}`).length) {
        bindUi();
        refreshUiState(context);
        return;
    }

    host.append(`
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${escapeHtml(i18n('Completion Preset Assistant'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="cpa_row">
                <div id="${OPEN_BUTTON_ID}" class="menu_button">${escapeHtml(i18n('Open Assistant'))}</div>
                <div id="${CREATE_BUTTON_ID}" class="menu_button">${escapeHtml(i18n('Create New Preset'))}</div>
                <div id="${SKILLS_BUTTON_ID}" class="menu_button" title="${escapeHtml(i18n('Bundle skills with this preset'))}">
                    <i class="fa-fw fa-solid fa-cubes"></i> ${escapeHtml(i18n('Bundle skills with this preset'))}
                </div>
            </div>
            <div class="cpa_hint">${escapeHtml(i18n('Character-bound runtime presets are not directly editable.'))}</div>
            <label for="cpa_request_llm_preset">${escapeHtml(i18n('Iteration AI prompt preset (params + prompt)'))}${renderPresetHelpButton({ kind: 'iteration', targetSelectId: 'cpa_request_llm_preset' })}</label>
            <select id="cpa_request_llm_preset" class="text_pole"></select>
            <label for="cpa_request_api_preset">${escapeHtml(i18n('Iteration AI API preset (Connection profile)'))}</label>
            <select id="cpa_request_api_preset" class="text_pole"></select>
            <label class="checkbox_label"><input id="cpa_include_world_info" type="checkbox"/> ${escapeHtml(i18n('Include world info (simulate current chat)'))}</label>
            <label class="checkbox_label">
                <input id="cpa_use_streaming_transport" type="checkbox" />
                ${escapeHtml(i18n('Use streaming transport (avoid timeout on slow APIs)'))}
            </label>
            <label for="cpa_tool_retries">${escapeHtml(i18n('Tool-call retries on invalid/missing tool call (N)'))}</label>
            <input id="cpa_tool_retries" class="text_pole" type="number" min="0" max="${TOOL_CALL_RETRY_MAX}" step="1"/>
            <details class="cpa_prompt_overrides">
                <summary>${escapeHtml(i18n('Iteration System Prompts (advanced)'))}</summary>
                <label for="cpa_iter_base_system_prompt">${escapeHtml(i18n('Base prompt (sent in every mode)'))}</label>
                <textarea id="cpa_iter_base_system_prompt" class="text_pole textarea_compact" rows="10"></textarea>
                <div class="cpa_row">
                    <div class="menu_button" id="cpa_reset_iter_base_system_prompt">${escapeHtml(i18n('Reset to default'))}</div>
                </div>
                <label for="cpa_iter_mode_orchestrator_optimize">${escapeHtml(i18n('Mode addition — orchestrator-optimize'))}</label>
                <textarea id="cpa_iter_mode_orchestrator_optimize" class="text_pole textarea_compact" rows="8"></textarea>
                <div class="cpa_row">
                    <div class="menu_button" id="cpa_reset_iter_mode_orchestrator_optimize">${escapeHtml(i18n('Reset to default'))}</div>
                </div>
                <label for="cpa_iter_mode_jailbreak_only">${escapeHtml(i18n('Mode addition — jailbreak-only'))}</label>
                <textarea id="cpa_iter_mode_jailbreak_only" class="text_pole textarea_compact" rows="8"></textarea>
                <div class="cpa_row">
                    <div class="menu_button" id="cpa_reset_iter_mode_jailbreak_only">${escapeHtml(i18n('Reset to default'))}</div>
                </div>
            </details>
        </div>
    </div>
</div>`);

    bindUi();
    refreshUiState(context);
}

function getPresetEventCollection(event = null) {
    return String(event?.collection || event?.apiId || '').trim();
}

jQuery(async () => {
    registerLocaleData();
    ensureSimulationReviewLocaleData();
    ensureSettings();
    ensureUi();
    const context = getContext();
    context.eventSource.on(context.eventTypes.PRESET_CHANGED, (event) => {
        if (getPresetEventCollection(event) === 'openai') refreshUiState();
    });
    context.eventSource.on(context.eventTypes.PRESET_RENAMED, (event) => {
        if (getPresetEventCollection(event) === 'openai') refreshUiState();
    });
    context.eventSource.on(context.eventTypes.PRESET_DELETED, (event) => {
        if (getPresetEventCollection(event) === 'openai') refreshUiState();
    });
    const connectionProfileEvents = [
        context.eventTypes.CONNECTION_PROFILE_LOADED,
        context.eventTypes.CONNECTION_PROFILE_CREATED,
        context.eventTypes.CONNECTION_PROFILE_DELETED,
        context.eventTypes.CONNECTION_PROFILE_UPDATED,
    ].filter(Boolean);
    for (const eventName of connectionProfileEvents) {
        context.eventSource.on(eventName, () => refreshUiState());
    }
});
