// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

const __ctx = Luker.getContext();
const saveSettingsDebounced = __ctx.saveSettingsDebounced;
const extension_settings = __ctx.extensionSettings;
const getContext = Luker.getContext;
const addLocaleData = __ctx.addLocaleData;
const translate = __ctx.translate;
const Popup = __ctx.Popup;
const escapeHtml = __ctx.escapeHtml;
import { ensureSimulationReviewLocaleData } from '../../iteration-library/simulation-review/i18n/index.js';
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
        'Regenerate aborted': '重新生成已中止',
        'Regenerate aborted — could not roll back commit on ${0}: ${1}': '重新生成已中止——无法回退 ${0} 上的提交：${1}',
        'Edit': '编辑',
        'Edit and regenerate from here': '编辑并从此处重新生成',
        'Edit message — saving will regenerate from this turn:': '编辑消息——保存将从此轮开始重新生成：',
        'Create New Preset': '新建预设',
        'Bundle skills with this preset': '将 Skills 打包到此预设',
        'No preset is currently selected.': '当前未选择预设。',
        'Character-bound runtime presets are not directly editable.': '角色卡绑定的运行时预设暂不支持直接编辑。',
        'Enter a name for the new preset.': '请输入新预设名称。',
        'Preset already exists: ${0}': '预设已存在：${0}',
        'Preset created: ${0}': '已创建预设：${0}',
        'Create preset failed.': '创建预设失败。',
        'Iteration AI prompt preset (params + prompt)': '迭代 AI 的提示词预设（参数+提示词）',
        'Iteration AI API preset (Connection profile)': '迭代 AI 的 API 预设（连接配置）',
        'Include world info (simulate current chat)': '包含世界书信息（按当前聊天重新模拟）',
        'Tool-call retries on invalid/missing tool call (N)': '工具调用重试次数（无效/缺失时）',
        'Iteration System Prompts (advanced)': '迭代系统提示词（高级）',
        'Base prompt (sent in every mode)': '基础提示词（每种模式都会发送）',
        'Mode addition — orchestrator-optimize': '模式追加 —— 编排器适配',
        'Mode addition — jailbreak-only': '模式追加 —— 仅保留破限',
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
        // Shared iteration-library diff renderer strings (per-leaf cards,
        // list-op context strips, etc). Keys defined by
        // iteration-library/ui/diff.js + text-diff.js — translated here so
        // CPA diff cards aren't half-English.
        'Before': '修改前',
        'After': '修改后',
        'Line diff': '逐行差异',
        'Reorder ${0}': '重排 ${0}',
        '"${0}": [${1}] → [${2}]': '「${0}」：[${1}] → [${2}]',
        '[${0}] → [${1}]': '[${0}] → [${1}]',
        'Insert into ${0}': '向 ${0} 插入',
        '+ "${0}" (${1})': '+ 「${0}」（${1}）',
        '+ (${0})': '+ （${0}）',
        'Remove from ${0}': '从 ${0} 移除',
        '− "${0}" (at [${1}])': '− 「${0}」（位于 [${1}]）',
        '− at [${0}]': '− 位于 [${0}]',
        'after ${0}': '在 ${0} 之后',
        'before ${0}': '在 ${0} 之前',
        'at end': '在末尾',
        'Field updated': '字段更新',
        'Profile updated': '配置更新',
        'working profile': '工作配置',
        '(root)': '（根）',
        '(${0}${1} bytes)': '（${0}${1} 字节）',
        // Skill proposal cards (Bug 1 fix: skill authoring goes through
        // per-card user review before commit). Strings consumed by
        // cpa-iteration/studio.js's renderSkillPendingCard /
        // commitApprovedSkillEditsForCpa / buildApplyOutcomeUserText.
        'Update skill file': '更新 Skill 文件',
        'Update skill frontmatter': '更新 Skill 元信息',
        'Create skill': '新建 Skill',
        'Rename skill': '重命名 Skill',
        'Move skill scope': '移动 Skill 作用域',
        'Delete skill': '删除 Skill',
        'Approve': '通过',
        'Reject': '拒绝',
        'Undo decision': '撤销决定',
        'Approved': '已通过',
        'Rejected': '已拒绝',
        'Pending approval': '等待审核',
        'Name': '名称',
        'Scope': '作用域',
        '(unknown scope)': '（未知作用域）',
        'global': '全局',
        'preset:${0}': '预设：${0}',
        'character:${0}': '角色卡：${0}',
        'No content change': '内容无变化',
        'Plus ${0} additional file(s): ${1}': '另含 ${0} 个附加文件：${1}',
        'Skill "${0}" (${1}) will be deleted on Apply. All files removed; this cannot be undone.': '应用后将删除 Skill「${0}」（${1}），所有文件都会被移除；该操作无法撤销。',
        'Skill commit failed at ${0} (${1}): ${2}': 'Skill 提交失败：${0}（${1}）：${2}',
        'Skill commit halted: ${0} (${1}) failed (${2}). Remaining approved skill edits left in the pending list for retry.': 'Skill 提交中止：${0}（${1}）失败（${2}）。剩余已通过的 Skill 编辑保留在待审列表中供重试。',
        'Committed ${0} skill edit(s)': '已提交 ${0} 项 Skill 编辑',
        // Clone proposal cards (Bug 1 漏 A 修复:复制预设也走审批流程,
        // 同时把当前会话整体迁移到新预设——Bug 2 修复)。
        'Clone preset': '复制预设',
        'On Apply: a new preset "${0}" will be created as a copy of "${1}", the popup target will switch to it, and this conversation will be migrated to the new preset.':
            '应用后将以「${1}」为模板创建新预设「${0}」,弹窗目标会切换到新预设,当前会话也会一并迁移到该预设下。',
        'Cloned preset to "${0}"': '已复制预设到「${0}」',
        'Clone failed: cloneAndSwitchTarget is not available.': '复制失败：cloneAndSwitchTarget 不可用。',
        'Clone failed: ${0}': '复制失败：${0}',
        'Clone succeeded but session migration failed: ${0}': '复制成功,但会话迁移失败：${0}',
        'Session moved to "${0}"': '会话已迁移到「${0}」',
        // Patch-storage conflict UI (shared keys; each extension owns its locale table).
        'Cannot undo this change: the preset has been modified elsewhere.':
            '无法回退此次修改：预设的相关内容已经发生改变。',
        'Cannot undo this change: the memory graph schema has been modified elsewhere.':
            '无法回退此次修改：记忆图谱的相关内容已经发生改变。',
        'Cannot undo this change: the character card has been modified elsewhere.':
            '无法回退此次修改：角色卡的相关内容已经发生改变。',
        'Cannot undo this change: the world book has been modified elsewhere.':
            '无法回退此次修改：世界书的相关内容已经发生改变。',
        'Cannot undo this change: the profile has been modified elsewhere.':
            '无法回退此次修改：配置文件的相关内容已经发生改变。',
        'Cannot undo this change: the skills have been modified elsewhere.':
            '无法回退此次修改：技能的相关内容已经发生改变。',
        'Cannot show details for this change: related content has been modified.':
            '无法显示此步的修改详情：相关内容已经发生改变。',
        'Cannot continue editing in this session: the underlying content has changed. Please start a new session.':
            '无法继续在此次会话中修改：基础内容已变化，请新建会话。',
        'Discard this step anyway': '仍然丢弃此步',
        'Export change details': '导出修改详情',
        'View raw record': '查看原始记录',
        'Session "${0}" cannot be migrated to the new format. It has been skipped and is unavailable.':
            '会话「${0}」无法迁移到新格式，已跳过，该会话不可用。',
    });
    addLocaleData('zh-tw', {
        'Completion Preset Assistant': '聊天補全預設助手',
        'Open Assistant': '開啟助手',
        'Regenerate aborted': '重新產生已中止',
        'Regenerate aborted — could not roll back commit on ${0}: ${1}': '重新產生已中止——無法回退 ${0} 上的提交：${1}',
        'Edit': '編輯',
        'Edit and regenerate from here': '編輯並從此處重新產生',
        'Edit message — saving will regenerate from this turn:': '編輯訊息——儲存將從此輪開始重新產生：',
        'Create New Preset': '新建預設',
        'Bundle skills with this preset': '將 Skills 打包到此預設',
        'No preset is currently selected.': '目前未選擇預設。',
        'Character-bound runtime presets are not directly editable.': '角色卡綁定的執行時預設暫不支援直接編輯。',
        'Enter a name for the new preset.': '請輸入新預設名稱。',
        'Preset already exists: ${0}': '預設已存在：${0}',
        'Preset created: ${0}': '已建立預設：${0}',
        'Create preset failed.': '建立預設失敗。',
        'Iteration AI prompt preset (params + prompt)': '迭代 AI 的提示詞預設（參數+提示詞）',
        'Iteration AI API preset (Connection profile)': '迭代 AI 的 API 預設（連線設定）',
        'Include world info (simulate current chat)': '包含世界書資訊（按目前聊天重新模擬）',
        'Tool-call retries on invalid/missing tool call (N)': '工具調用重試次數（無效/缺失時）',
        'Iteration System Prompts (advanced)': '迭代系統提示詞（進階）',
        'Base prompt (sent in every mode)': '基礎提示詞（每種模式都會傳送）',
        'Mode addition — orchestrator-optimize': '模式追加 —— 編排器適配',
        'Mode addition — jailbreak-only': '模式追加 —— 僅保留破限',
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
        'Before': '修改前',
        'After': '修改後',
        'Line diff': '逐行差異',
        'Reorder ${0}': '重排 ${0}',
        '"${0}": [${1}] → [${2}]': '「${0}」：[${1}] → [${2}]',
        '[${0}] → [${1}]': '[${0}] → [${1}]',
        'Insert into ${0}': '向 ${0} 插入',
        '+ "${0}" (${1})': '+ 「${0}」（${1}）',
        '+ (${0})': '+ （${0}）',
        'Remove from ${0}': '從 ${0} 移除',
        '− "${0}" (at [${1}])': '− 「${0}」（位於 [${1}]）',
        '− at [${0}]': '− 位於 [${0}]',
        'after ${0}': '在 ${0} 之後',
        'before ${0}': '在 ${0} 之前',
        'at end': '在末尾',
        'Field updated': '欄位更新',
        'Profile updated': '設定更新',
        'working profile': '工作設定',
        '(root)': '（根）',
        '(${0}${1} bytes)': '（${0}${1} 位元組）',
        // Skill proposal cards (see zh-cn block for context).
        'Update skill file': '更新 Skill 檔案',
        'Update skill frontmatter': '更新 Skill 元資訊',
        'Create skill': '新建 Skill',
        'Rename skill': '重新命名 Skill',
        'Move skill scope': '移動 Skill 作用域',
        'Delete skill': '刪除 Skill',
        'Approve': '通過',
        'Reject': '拒絕',
        'Undo decision': '撤銷決定',
        'Approved': '已通過',
        'Rejected': '已拒絕',
        'Pending approval': '等待審核',
        'Name': '名稱',
        'Scope': '作用域',
        '(unknown scope)': '（未知作用域）',
        'global': '全域',
        'preset:${0}': '預設：${0}',
        'character:${0}': '角色卡：${0}',
        'No content change': '內容無變化',
        'Plus ${0} additional file(s): ${1}': '另含 ${0} 個附加檔案：${1}',
        'Skill "${0}" (${1}) will be deleted on Apply. All files removed; this cannot be undone.': '套用後將刪除 Skill「${0}」（${1}），所有檔案都會被移除；此操作無法撤銷。',
        'Skill commit failed at ${0} (${1}): ${2}': 'Skill 提交失敗：${0}（${1}）：${2}',
        'Skill commit halted: ${0} (${1}) failed (${2}). Remaining approved skill edits left in the pending list for retry.': 'Skill 提交中止：${0}（${1}）失敗（${2}）。剩餘已通過的 Skill 編輯保留在待審列表中供重試。',
        'Committed ${0} skill edit(s)': '已提交 ${0} 項 Skill 編輯',
        // Clone proposal cards (見 zh-cn 區塊說明)。
        'Clone preset': '複製預設',
        'On Apply: a new preset "${0}" will be created as a copy of "${1}", the popup target will switch to it, and this conversation will be migrated to the new preset.':
            '套用後將以「${1}」為範本建立新預設「${0}」,彈窗目標會切換到新預設,目前的對話也會一併遷移到該預設下。',
        'Cloned preset to "${0}"': '已複製預設到「${0}」',
        'Clone failed: cloneAndSwitchTarget is not available.': '複製失敗：cloneAndSwitchTarget 不可用。',
        'Clone failed: ${0}': '複製失敗：${0}',
        'Clone succeeded but session migration failed: ${0}': '複製成功,但對話遷移失敗：${0}',
        'Session moved to "${0}"': '對話已遷移到「${0}」',
        // Patch-storage conflict UI (shared keys).
        'Cannot undo this change: the preset has been modified elsewhere.':
            '無法回退此次修改：預設的相關內容已經發生改變。',
        'Cannot undo this change: the memory graph schema has been modified elsewhere.':
            '無法回退此次修改：記憶圖譜的相關內容已經發生改變。',
        'Cannot undo this change: the character card has been modified elsewhere.':
            '無法回退此次修改：角色卡的相關內容已經發生改變。',
        'Cannot undo this change: the world book has been modified elsewhere.':
            '無法回退此次修改：世界書的相關內容已經發生改變。',
        'Cannot undo this change: the profile has been modified elsewhere.':
            '無法回退此次修改：設定檔的相關內容已經發生改變。',
        'Cannot undo this change: the skills have been modified elsewhere.':
            '無法回退此次修改：技能的相關內容已經發生改變。',
        'Cannot show details for this change: related content has been modified.':
            '無法顯示此步的修改詳情：相關內容已經發生改變。',
        'Cannot continue editing in this session: the underlying content has changed. Please start a new session.':
            '無法繼續在此次會話中修改：基礎內容已變化，請新建會話。',
        'Discard this step anyway': '仍然丟棄此步',
        'Export change details': '匯出修改詳情',
        'View raw record': '檢視原始記錄',
        'Session "${0}" cannot be migrated to the new format. It has been skipped and is unavailable.':
            '會話「${0}」無法遷移到新格式，已跳過，該會話不可用。',
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
 * Open the Skill Manager popup pre-filtered to the currently-selected preset.
 *
 * Surfaces the same Skill Manager that the orchestrator config exposes, but
 * seeded with `initialScope = preset/<presetName>` so the user lands
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
    const initialScope = {
        kind: 'preset',
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
        // studio's commitApprovedCloneEditsForCpa can migrate the session
        // into the clone's bucket. Triggered at Apply time after the user
        // approves the pending clone card — not inline on the AI's tool
        // call.
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
        // Synchronous duplicate-name pre-check exposed to the dispatcher
        // so `preset_clone_to_new` can reject a doomed clone BEFORE
        // pushing a pending card the user would just have to discard.
        // Returns `{ exists: bool, canonical?: string }`. The dispatcher
        // never relies on this — if absent, the duplicate is caught when
        // cloneAndSwitchTarget runs at Apply time.
        checkPresetNameAvailable: (name) => {
            const trimmed = String(name || '').trim();
            if (!trimmed) return { exists: false };
            const canonical = findCanonicalPresetName(getOpenAIPresetNames(getContext()), trimmed);
            return canonical
                ? { exists: true, canonical }
                : { exists: false };
        },
        // Skill tool wiring. Provides the active preset name so the
        // studio's skill-prompt augmentation can tell the AI to default
        // new skills to this preset's scope — they then ride with the
        // preset on export. Mirrors `openBundleSkillsForCurrentPreset`'s
        // scope resolution so an AI-authored skill is visible to the same
        // skill manager view the user opens via "Bundle skills with this
        // preset".
        getSkillScopeHint: () => {
            const ref = getTargetRef();
            const presetName = String(ref?.name || '').trim();
            return { presetName };
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
