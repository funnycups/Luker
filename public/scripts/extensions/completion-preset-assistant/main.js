// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { DOMPurify, lodash } from '../../../lib.js';
import { saveSettingsDebounced } from '../../../script.js';
import { areComparableOpenAIPresetBodiesEqual } from '../../openai.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../popup.js';
import { escapeHtml, uuidv4 } from '../../utils.js';
import { getChatCompletionConnectionProfiles } from '../connection-manager/profile-resolver.js';
import {
    TOOL_PROTOCOL_STYLE,
    validateParsedToolCalls,
} from '../function-call-runtime.js';
import {
    buildJsonStateDelta,
    cloneJsonValue,
    createJsonStateDiffPatcher,
    extractJsonStateTouchedPaths,
    hasJsonStatePathConflict,
    isPlainObject,
    replayJsonStateJournal,
    tokenizeJsonPath,
} from '../json-state-journal.js';
import { renderObjectDiffHtml } from '../object-diff-view.js';
import { createCompletionPresetAssistantDialogUi } from './dialog-ui.js';

const MODULE_NAME = 'completion_preset_assistant';
const UI_BLOCK_ID = 'completion_preset_assistant_settings';
const OPEN_BUTTON_ID = 'completion_preset_assistant_open';
const CREATE_BUTTON_ID = 'completion_preset_assistant_create';
const OPENAI_BUTTON_ID = 'completion_preset_assistant_openai_button';
const SESSION_NAMESPACE = 'completion_preset_assistant_session';
const JOURNAL_NAMESPACE = 'completion_preset_assistant_journal';
const SESSION_VERSION = 3;
const SESSION_STORE_VERSION = 1;
const JOURNAL_VERSION = 1;
const TOOL_CALL_RETRY_MAX = 10;
const SESSION_MESSAGE_LIMIT_MIN = 8;
const SESSION_MESSAGE_LIMIT_MAX = 48;
const JSON_TEXTDIFF_MIN_LENGTH = 80;
const MODEL_TOOLS = Object.freeze({
    SET_FIELD: 'preset_set_field',
    REMOVE_FIELD: 'preset_remove_field',
    COPY_FROM_REFERENCE: 'preset_copy_from_reference',
    READ_LIVE_FIELDS: 'preset_read_live_fields',
    READ_REFERENCE_FIELDS: 'preset_read_reference_fields',
    UPSERT_PROMPT_ENTRY: 'preset_upsert_prompt_entry',
    REMOVE_PROMPT_ENTRY: 'preset_remove_prompt_entry',
    UPSERT_ORDER_ITEM: 'preset_upsert_prompt_order_item',
    REMOVE_ORDER_ITEM: 'preset_remove_prompt_order_item',
    DIFF_REFERENCE: 'preset_diff_reference',
    SIMULATE: 'preset_simulate',
    CLONE_TO_NEW: 'preset_clone_to_new',
});
const SESSION_MODES = Object.freeze(['general', 'orchestrator-optimize', 'jailbreak-only']);
const SESSION_MODE_DEFAULT = 'general';
function sanitizeSessionMode(value) {
    const candidate = String(value || '').trim();
    return SESSION_MODES.includes(candidate) ? candidate : SESSION_MODE_DEFAULT;
}
const defaultSettings = {
    requestLlmPresetName: '',
    requestApiProfileName: '',
    includeWorldInfo: false,
    toolCallRetryMax: 2,
    sessionMessageLimit: 24,
    useStreamingTransport: false,
};

let activeDialogState = null;

const diffPatcher = createJsonStateDiffPatcher({
    textDiffMinLength: JSON_TEXTDIFF_MIN_LENGTH,
});

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
    if (!Number.isFinite(num)) {
        return fallback;
    }
    return Math.floor(num);
}

function buildJson(value) {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return '{}';
    }
}

function areJsonEqual(left, right) {
    return buildJson(left) === buildJson(right);
}

function arePresetBodiesEquivalent(left, right) {
    return areComparableOpenAIPresetBodiesEqual(
        isPlainObject(left) ? left : {},
        isPlainObject(right) ? right : {},
    );
}

function isAbortError(error, signal = null) {
    return error?.name === 'AbortError' || Boolean(signal?.aborted);
}

function throwIfAborted(signal, message = 'Operation aborted.') {
    if (!signal?.aborted) {
        return;
    }

    try {
        throw new DOMException(String(message || 'Operation aborted.'), 'AbortError');
    } catch {
        const error = new Error(String(message || 'Operation aborted.'));
        error.name = 'AbortError';
        throw error;
    }
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = clone(defaultSettings);
    }

    const settings = extension_settings[MODULE_NAME];
    settings.requestLlmPresetName = String(settings.requestLlmPresetName || '').trim();
    settings.requestApiProfileName = String(settings.requestApiProfileName || '').trim();
    settings.includeWorldInfo = settings.includeWorldInfo === true;
    settings.useStreamingTransport = settings.useStreamingTransport === true;
    settings.toolCallRetryMax = Math.max(0, Math.min(TOOL_CALL_RETRY_MAX, toInteger(settings.toolCallRetryMax, defaultSettings.toolCallRetryMax)));
    settings.sessionMessageLimit = Math.max(
        SESSION_MESSAGE_LIMIT_MIN,
        Math.min(SESSION_MESSAGE_LIMIT_MAX, toInteger(settings.sessionMessageLimit, defaultSettings.sessionMessageLimit)),
    );
}

function getSettings() {
    ensureSettings();
    return extension_settings[MODULE_NAME];
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        'Completion Preset Assistant': '聊天补全预设助手',
        'Open Assistant': '打开助手',
        'Create New Preset': '新建预设',
        'Character-bound runtime presets are not directly editable.': '角色卡绑定的运行时预设暂不支持直接编辑。',
        'Enter a name for the new preset.': '请输入新预设名称。',
        'Preset already exists: ${0}': '预设已存在：${0}',
        'Preset created: ${0}': '已创建预设：${0}',
        'Create preset failed.': '创建预设失败。',
        'Model request LLM preset name': '模型请求提示词预设',
        'Model request API preset name (Connection profile)': '模型请求 API 预设（连接配置）',
        'Include world info (simulate current chat)': '包含世界书信息（按当前聊天重新模拟）',
        'Tool-call retries on invalid/missing tool call (N)': '工具调用重试次数（无效/缺失时）',
        'Stored session messages per preset': '每个预设保留的会话消息数',
        'Current preset is not a stored chat completion preset. Please select a saved preset first.': '当前不是已保存的聊天补全预设，请先选择一个已保存预设。',
        'Chat Completion preset assistant': '聊天补全预设助手',
        'Target': '目标预设',
        'Reference preset': '参考预设',
        '(none)': '（无）',
        '(current)': '（当前）',
        'Refresh live preset': '刷新当前 live 预设',
        'Reference diff': '参考预设 diff',
        'Compare with reference': '与参考预设比较',
        'Re-read current preset': '重新读取当前预设',
        'Discard draft': '丢弃草稿',
        'Clear history': '清空历史',
        'Conversation': '会话',
        'Draft diff': '草稿 diff',
        'No conversation yet.': '暂无会话内容。',
        'No draft yet. Ask the assistant to propose changes first.': '还没有草稿，请先让助手提出修改建议。',
        'No reference preset selected.': '未选择参考预设。',
        'Draft ready': '草稿已生成',
        'No changes proposed': '未提出变更',
        'Apply draft': '应用草稿',
        'Send': '发送',
        'Stop': '终止',
        'Type what to change in this preset...': '输入你想如何修改这个预设...',
        'Applied draft to preset.': '已将草稿应用到预设。',
        'Draft discarded.': '草稿已丢弃。',
        'Session history cleared.': '会话历史已清空。',
        'No reference diff available.': '没有可显示的参考 diff。',
        'No diff to display.': '没有可显示的 diff。',
        'Reference diff: ${0} -> ${1}': '参考 diff：${0} -> ${1}',
        'Before': '修改前',
        'After': '修改后',
        '(missing)': '（缺失）',
        'AI request failed: ${0}': '模型请求失败：${0}',
        'Save failed.': '保存失败。',
        'Reference preset copied': '已复制参考预设内容',
        'Please enter a request first.': '请先输入请求。',
        'Applying draft...': '正在应用草稿...',
        'Assistant is thinking...': '模型思考中...',
        'Refreshing live preset will discard the current draft. Continue?': '刷新 live 预设会丢弃当前草稿。要继续吗？',
        'Clear this preset assistant history and draft?': '要清空这个预设助手的历史和草稿吗？',
        'Discard current draft?': '要丢弃当前草稿吗？',
        'Change summary': '变更摘要',
        'Proposed edits: ${0}': '拟议变更：${0}',
        'Applied': '已应用',
        'Reference summary': '参考预设摘要',
        'Current live preset': '当前 live 预设',
        'No meaningful changes detected.': '未检测到有效变更。',
        'Select reference preset': '选择参考预设',
        'Prompt preset paths use lodash syntax like prompts[0].content or new_chat_prompt.': '预设路径使用 lodash 语法，例如 prompts[0].content 或 new_chat_prompt。',
        'Current request API preset': '当前请求 API 预设',
        'Current request prompt preset': '当前请求提示词预设',
        'Live snapshot refreshed.': '已刷新 live 快照。',
        'Request stopped.': '请求已终止。',
        'Selected preset changed outside the assistant. Reopen the assistant on the desired preset.': '助手打开后当前选中的预设已被切换。请在目标预设上重新打开助手。',
        'Current live preset changed since this draft was created. Refresh live and request a new draft.': '当前 live 预设在草稿生成后已发生变化。请先刷新 live 预设，再重新生成草稿。',
        'Rollback': '回滚',
        'Show diff': '查看 diff',
        'Applied diff': '已应用 diff',
        'Rollback to here': '回滚到这里',
        'Rollback this message and every later applied change in the current session?': '要回滚这条消息以及当前会话里之后所有已应用的变更吗？',
        'Rolling back...': '正在回滚...',
        'Rolled back current session changes to the selected message.': '已将当前会话的变更回滚到所选消息。',
        'No applied changes for this message.': '这条消息没有已应用的变更。',
        'Current live preset no longer matches assistant history. Clear history before applying or rolling back more changes.': '当前 live 预设已经不再匹配助手历史。请先清空历史，再继续应用或回滚。',
        'Later committed changes overlap the same preset paths. Automatic tail rollback is blocked.': '后续已提交的变更与相同预设路径重叠，已阻止自动尾部回滚。',
        'Applied preset edits: ${0}': '已应用预设修改：${0}',
        'Previous version': '回滚前版本',
        'Applied version': '已应用版本',
        'User': '用户',
        'Assistant': '助手',
        'System': '系统',
        'LLM preset': 'LLM 预设',
        'No conversation history yet.': '还没有会话历史。',
        'New session': '新建会话',
        'Current': '当前',
        'Load session': '加载会话',
        'Delete': '删除',
        'Delete this conversation session?': '要删除这个会话吗？',
        'Conversation session deleted.': '会话已删除。',
        'Session loaded.': '会话已加载。',
        'Conversation delete failed: ${0}': '删除会话失败：${0}',
        'Load failed: ${0}': '加载会话失败：${0}',
        'Tool calls (${0})': '工具调用（${0}）',
        'Tool result': '工具结果',
        'Mode': '模式',
        'Session mode': '会话模式',
        'General editing': '通用编辑',
        'Optimize for orchestrator': '为编排器优化',
        'Jailbreak-only': '仅保留破限',
        'Mode is fixed for the lifetime of the session. To switch modes, start a new session.': '会话模式一旦确定不可中途切换。要换模式请新建会话。',
        'Switching the mode starts a new session.': '切换模式会新建一个会话。',
        'Switching session mode starts a new session. Continue?': '切换会话模式会新建一个会话，要继续吗？',
        'Start new session': '开始新会话',
        'Cancel': '取消',
    });
    addLocaleData('zh-tw', {
        'Completion Preset Assistant': '聊天補全預設助手',
        'Open Assistant': '開啟助手',
        'Create New Preset': '新建預設',
        'Character-bound runtime presets are not directly editable.': '角色卡綁定的執行時預設暫不支援直接編輯。',
        'Enter a name for the new preset.': '請輸入新預設名稱。',
        'Preset already exists: ${0}': '預設已存在：${0}',
        'Preset created: ${0}': '已建立預設：${0}',
        'Create preset failed.': '建立預設失敗。',
        'Model request LLM preset name': '模型請求提示詞預設',
        'Model request API preset name (Connection profile)': '模型請求 API 預設（連線設定）',
        'Include world info (simulate current chat)': '包含世界書資訊（按目前聊天重新模擬）',
        'Tool-call retries on invalid/missing tool call (N)': '工具調用重試次數（無效/缺失時）',
        'Stored session messages per preset': '每個預設保留的會話訊息數',
        'Current preset is not a stored chat completion preset. Please select a saved preset first.': '目前不是已儲存的聊天補全預設，請先選擇一個已儲存預設。',
        'Chat Completion preset assistant': '聊天補全預設助手',
        'Target': '目標預設',
        'Reference preset': '參考預設',
        '(none)': '（無）',
        '(current)': '（目前）',
        'Refresh live preset': '重新整理目前 live 預設',
        'Reference diff': '參考預設 diff',
        'Compare with reference': '與參考預設比較',
        'Re-read current preset': '重新讀取目前預設',
        'Discard draft': '捨棄草稿',
        'Clear history': '清空歷史',
        'Conversation': '會話',
        'Draft diff': '草稿 diff',
        'No conversation yet.': '暫無會話內容。',
        'No draft yet. Ask the assistant to propose changes first.': '尚未產生草稿，請先讓助手提出修改建議。',
        'No reference preset selected.': '未選擇參考預設。',
        'Draft ready': '草稿已產生',
        'No changes proposed': '未提出變更',
        'Apply draft': '套用草稿',
        'Send': '發送',
        'Stop': '終止',
        'Type what to change in this preset...': '輸入你想如何修改這個預設...',
        'Applied draft to preset.': '已將草稿套用到預設。',
        'Draft discarded.': '草稿已捨棄。',
        'Session history cleared.': '會話歷史已清空。',
        'No reference diff available.': '沒有可顯示的參考 diff。',
        'No diff to display.': '沒有可顯示的 diff。',
        'Reference diff: ${0} -> ${1}': '參考 diff：${0} -> ${1}',
        'Before': '修改前',
        'After': '修改後',
        '(missing)': '（缺失）',
        'AI request failed: ${0}': '模型請求失敗：${0}',
        'Save failed.': '儲存失敗。',
        'Reference preset copied': '已複製參考預設內容',
        'Please enter a request first.': '請先輸入請求。',
        'Applying draft...': '正在套用草稿...',
        'Assistant is thinking...': '模型思考中...',
        'Refreshing live preset will discard the current draft. Continue?': '重新整理 live 預設會捨棄目前草稿。要繼續嗎？',
        'Clear this preset assistant history and draft?': '要清空這個預設助手的歷史與草稿嗎？',
        'Discard current draft?': '要捨棄目前草稿嗎？',
        'Change summary': '變更摘要',
        'Proposed edits: ${0}': '擬議變更：${0}',
        'Applied': '已套用',
        'Reference summary': '參考預設摘要',
        'Current live preset': '目前 live 預設',
        'No meaningful changes detected.': '未檢測到有效變更。',
        'Select reference preset': '選擇參考預設',
        'Prompt preset paths use lodash syntax like prompts[0].content or new_chat_prompt.': '預設路徑使用 lodash 語法，例如 prompts[0].content 或 new_chat_prompt。',
        'Current request API preset': '目前請求 API 預設',
        'Current request prompt preset': '目前請求提示詞預設',
        'Live snapshot refreshed.': '已重新整理 live 快照。',
        'Request stopped.': '請求已終止。',
        'Selected preset changed outside the assistant. Reopen the assistant on the desired preset.': '助手開啟後目前選中的預設已被切換。請在目標預設上重新開啟助手。',
        'Current live preset changed since this draft was created. Refresh live and request a new draft.': '目前 live 預設在草稿產生後已發生變化。請先重新整理 live 預設，再重新產生草稿。',
        'Rollback': '回滾',
        'Show diff': '查看 diff',
        'Applied diff': '已套用 diff',
        'Rollback to here': '回滾到這裡',
        'Rollback this message and every later applied change in the current session?': '要回滾這條訊息以及目前會話裡之後所有已套用的變更嗎？',
        'Rolling back...': '正在回滾...',
        'Rolled back current session changes to the selected message.': '已將目前會話的變更回滾到所選訊息。',
        'No applied changes for this message.': '這條訊息沒有已套用的變更。',
        'Current live preset no longer matches assistant history. Clear history before applying or rolling back more changes.': '目前 live 預設已不再匹配助手歷史。請先清空歷史，再繼續套用或回滾。',
        'Later committed changes overlap the same preset paths. Automatic tail rollback is blocked.': '後續已提交的變更與相同預設路徑重疊，已阻止自動尾部回滾。',
        'Applied preset edits: ${0}': '已套用預設修改：${0}',
        'Previous version': '回滾前版本',
        'Applied version': '已套用版本',
        'User': '使用者',
        'Assistant': '助手',
        'System': '系統',
        'LLM preset': 'LLM 預設',
        'No conversation history yet.': '還沒有會話歷史。',
        'New session': '新建會話',
        'Current': '目前',
        'Load session': '載入會話',
        'Delete': '刪除',
        'Delete this conversation session?': '要刪除這個會話嗎？',
        'Conversation session deleted.': '會話已刪除。',
        'Session loaded.': '會話已載入。',
        'Conversation delete failed: ${0}': '刪除會話失敗：${0}',
        'Load failed: ${0}': '載入會話失敗：${0}',
        'Tool calls (${0})': '工具調用（${0}）',
        'Tool result': '工具結果',
        'Mode': '模式',
        'Session mode': '會話模式',
        'General editing': '通用編輯',
        'Optimize for orchestrator': '為編排器最佳化',
        'Jailbreak-only': '僅保留破限',
        'Mode is fixed for the lifetime of the session. To switch modes, start a new session.': '會話模式一旦確定不可中途切換。要切換模式請新建會話。',
        'Switching the mode starts a new session.': '切換模式會新建一個會話。',
        'Switching session mode starts a new session. Continue?': '切換會話模式會新建一個會話，要繼續嗎？',
        'Start new session': '開始新會話',
        'Cancel': '取消',
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
    if (!normalizedRequested) {
        return '';
    }
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
    if (isPlainObject(defaultSnapshot?.body)) {
        return clone(defaultSnapshot.body, {});
    }
    const liveSnapshot = getCurrentLiveSnapshot(context);
    if (isPlainObject(liveSnapshot?.body)) {
        return clone(liveSnapshot.body, {});
    }
    return {};
}

function createEmptySession({ mode = SESSION_MODE_DEFAULT } = {}) {
    return {
        version: SESSION_VERSION,
        id: uuidv4(),
        referencePresetName: '',
        mode: sanitizeSessionMode(mode),
        messages: [],
        draft: null,
        updatedAt: Date.now(),
    };
}

function createEmptyJournal(baseSnapshot = {}) {
    return {
        version: JOURNAL_VERSION,
        baseSnapshot: isPlainObject(baseSnapshot) ? clone(baseSnapshot, {}) : {},
        entries: [],
    };
}

function createEmptySessionStore() {
    return {
        version: SESSION_STORE_VERSION,
        currentSessionId: '',
        sessions: [],
    };
}

function makeRuntimeToolCallId() {
    return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function serializeToolResultContent(result) {
    if (typeof result === 'string') {
        return result;
    }
    if (result === null || result === undefined) {
        return '';
    }
    try {
        return JSON.stringify(result, null, 2);
    } catch {
        return String(result);
    }
}

function createPersistentToolCallPayload(name, args = {}, id = '') {
    const toolName = String(name || '').trim();
    if (!toolName) {
        return null;
    }
    const safeArgs = args && typeof args === 'object' ? clone(args, {}) : {};
    return {
        id: String(id || '').trim() || makeRuntimeToolCallId(),
        type: 'function',
        function: {
            name: toolName,
            arguments: JSON.stringify(safeArgs),
        },
    };
}

function buildPersistentToolCallsFromRawCalls(rawCalls = []) {
    return (Array.isArray(rawCalls) ? rawCalls : [])
        .map((call) => createPersistentToolCallPayload(call?.name, call?.args, call?.id))
        .filter(Boolean);
}

function normalizePersistentToolCalls(message) {
    const output = [];
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        let args = {};
        if (call?.function?.arguments && typeof call.function.arguments === 'string') {
            try {
                const parsed = JSON.parse(call.function.arguments);
                args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            } catch {
                args = {};
            }
        } else if (call?.function?.arguments && typeof call.function.arguments === 'object') {
            args = call.function.arguments;
        }
        const payload = createPersistentToolCallPayload(call?.function?.name, args, call?.id);
        if (payload) {
            output.push(payload);
        }
    }
    return output;
}

function normalizePersistentToolResults(message, toolCalls = []) {
    const toolCallIds = new Set(toolCalls.map((call) => String(call?.id || '').trim()).filter(Boolean));
    return (Array.isArray(message?.tool_results) ? message.tool_results : [])
        .map((item) => ({
            tool_call_id: String(item?.tool_call_id || '').trim(),
            content: String(item?.content ?? ''),
        }))
        .filter((item) => item.tool_call_id && toolCallIds.has(item.tool_call_id));
}

function createPersistentToolTurnMessage({
    messageId = '',
    assistantText = '',
    toolCalls = [],
    toolResults = [],
    toolSummary = '',
    toolState = '',
    extra = {},
} = {}) {
    const message = {
        id: String(messageId || '').trim() || uuidv4(),
        role: 'assistant',
        text: String(assistantText || '').trim(),
        createdAt: Date.now(),
        ...(extra && typeof extra === 'object' ? extra : {}),
    };
    const normalizedToolCalls = normalizePersistentToolCalls({ tool_calls: toolCalls });
    const normalizedToolResults = normalizePersistentToolResults({ tool_results: toolResults }, normalizedToolCalls);
    if (normalizedToolCalls.length > 0) {
        message.tool_calls = normalizedToolCalls;
    }
    if (normalizedToolResults.length > 0) {
        message.tool_results = normalizedToolResults;
    }
    if (toolSummary) {
        message.toolSummary = String(toolSummary);
    }
    if (toolState) {
        message.toolState = String(toolState);
    }
    return message;
}

function buildPersistentToolHistoryMessages(messages = []) {
    const history = [];
    for (const item of Array.isArray(messages) ? messages : []) {
        const role = String(item?.role || '').trim().toLowerCase();
        if (role === 'user') {
            const content = String(item?.text || item?.summary || '').trim();
            if (content) {
                history.push({ role: 'user', content });
            }
            continue;
        }
        if (role !== 'assistant') {
            continue;
        }
        const toolCalls = normalizePersistentToolCalls(item);
        const toolResults = normalizePersistentToolResults(item, toolCalls);
        const content = String(item?.text || item?.summary || '').trim();
        if (toolCalls.length > 0 && toolResults.length > 0) {
            history.push({
                role: 'assistant',
                content,
                tool_calls: toolCalls,
            });
            for (const toolResult of toolResults) {
                history.push({
                    role: 'tool',
                    tool_call_id: toolResult.tool_call_id,
                    content: toolResult.content,
                });
            }
            continue;
        }
        if (content) {
            history.push({ role: 'assistant', content });
        }
    }
    return history;
}

function buildToolCallSummary(toolCalls = []) {
    const names = (Array.isArray(toolCalls) ? toolCalls : [])
        .map((call) => String(call?.function?.name || '').trim())
        .filter(Boolean);
    if (names.length === 0) {
        return '';
    }
    return `Tools: ${names.join(', ')}`;
}

function buildPendingToolResults(toolCalls = [], summaryText = '') {
    return (Array.isArray(toolCalls) ? toolCalls : []).map((call) => ({
        tool_call_id: String(call?.id || '').trim(),
        content: serializeToolResultContent({
            ok: true,
            pending: true,
            summary: String(summaryText || 'Pending review.'),
        }),
    })).filter((item) => item.tool_call_id);
}

function buildAppliedToolResults(toolCalls = [], summaryText = '') {
    return (Array.isArray(toolCalls) ? toolCalls : []).map((call) => ({
        tool_call_id: String(call?.id || '').trim(),
        content: serializeToolResultContent({
            ok: true,
            applied: true,
            summary: String(summaryText || 'Applied to preset.'),
        }),
    })).filter((item) => item.tool_call_id);
}

function buildRejectedToolResults(toolCalls = [], summaryText = '') {
    return (Array.isArray(toolCalls) ? toolCalls : []).map((call) => ({
        tool_call_id: String(call?.id || '').trim(),
        content: serializeToolResultContent({
            ok: false,
            rejected: true,
            summary: String(summaryText || 'Rejected by user.'),
        }),
    })).filter((item) => item.tool_call_id);
}

function sanitizeMessage(rawMessage) {
    const message = rawMessage && typeof rawMessage === 'object' ? rawMessage : {};
    const role = ['user', 'assistant', 'system'].includes(String(message.role || '').trim().toLowerCase())
        ? String(message.role).trim().toLowerCase()
        : 'system';
    const next = {
        id: String(message.id || uuidv4()),
        role,
        text: String(message.text || '').trim(),
        createdAt: Number(message.createdAt || Date.now()),
        summary: String(message.summary || '').trim(),
        editCount: Math.max(0, toInteger(message.editCount, 0)),
    };
    if (role === 'assistant') {
        const toolCalls = normalizePersistentToolCalls(message);
        const toolResults = normalizePersistentToolResults(message, toolCalls);
        if (toolCalls.length > 0) {
            next.tool_calls = toolCalls;
        }
        if (toolResults.length > 0) {
            next.tool_results = toolResults;
        }
        if (message.toolSummary) {
            next.toolSummary = String(message.toolSummary || '').trim();
        }
        if (message.toolState) {
            next.toolState = String(message.toolState || '').trim();
        }
    }
    return next;
}

function sanitizeDraft(rawDraft) {
    const draft = rawDraft && typeof rawDraft === 'object' ? rawDraft : null;
    if (!draft) {
        return null;
    }

    return {
        summary: String(draft.summary || '').trim(),
        assistantText: String(draft.assistantText || '').trim(),
        edits: Array.isArray(draft.edits) ? draft.edits.map(item => sanitizeEdit(item)).filter(Boolean) : [],
        draftBody: isPlainObject(draft.draftBody) ? clone(draft.draftBody, {}) : {},
        createdAt: Number(draft.createdAt || Date.now()),
        referencePresetName: String(draft.referencePresetName || '').trim(),
        sourceMessageId: String(draft.sourceMessageId || '').trim(),
    };
}

function sanitizeJournalEntry(rawEntry) {
    const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : null;
    if (!entry) {
        return null;
    }

    const sessionId = String(entry.sessionId || '').trim();
    const messageId = String(entry.messageId || '').trim();
    const delta = entry.delta && typeof entry.delta === 'object' ? clone(entry.delta, entry.delta) : null;
    if (!sessionId || !messageId || !delta) {
        return null;
    }

    return {
        id: String(entry.id || uuidv4()),
        sessionId,
        messageId,
        delta,
        touchedPaths: Array.isArray(entry.touchedPaths)
            ? [...new Set(entry.touchedPaths.map(item => String(item || '').trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right))
            : extractJsonStateTouchedPaths(delta),
    };
}

function sanitizeSession(rawSession) {
    const session = rawSession && typeof rawSession === 'object' ? rawSession : {};
    const settings = getSettings();
    const next = createEmptySession();
    next.id = String(session.id || uuidv4());
    next.referencePresetName = String(session.referencePresetName || '').trim();
    next.mode = sanitizeSessionMode(session.mode);
    next.messages = Array.isArray(session.messages)
        ? session.messages.map(item => sanitizeMessage(item)).slice(-settings.sessionMessageLimit)
        : [];
    next.draft = sanitizeDraft(session.draft);
    next.updatedAt = Number(session.updatedAt || Date.now());
    return next;
}

function normalizeSessionStore(rawStore) {
    if (Number(rawStore?.version || 0) === SESSION_STORE_VERSION) {
        const sessions = (Array.isArray(rawStore?.sessions) ? rawStore.sessions : [])
            .map((session) => sanitizeSession(session))
            .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
        return {
            version: SESSION_STORE_VERSION,
            currentSessionId: String(rawStore?.currentSessionId || '').trim(),
            sessions,
        };
    }

    if (rawStore && typeof rawStore === 'object' && (rawStore.id || rawStore.messages || rawStore.draft)) {
        const legacySession = sanitizeSession(rawStore);
        return {
            version: SESSION_STORE_VERSION,
            currentSessionId: legacySession.id,
            sessions: [legacySession],
        };
    }

    return createEmptySessionStore();
}

function sanitizeJournal(rawJournal, fallbackBaseSnapshot = {}) {
    const journal = rawJournal && typeof rawJournal === 'object' ? rawJournal : {};
    return {
        version: JOURNAL_VERSION,
        baseSnapshot: isPlainObject(journal.baseSnapshot)
            ? clone(journal.baseSnapshot, {})
            : (isPlainObject(fallbackBaseSnapshot) ? clone(fallbackBaseSnapshot, {}) : {}),
        entries: Array.isArray(journal.entries)
            ? journal.entries.map(item => sanitizeJournalEntry(item)).filter(Boolean)
            : [],
    };
}

function sanitizeEdit(rawEdit) {
    const edit = rawEdit && typeof rawEdit === 'object' ? rawEdit : null;
    if (!edit) {
        return null;
    }

    const kind = String(edit.kind || '').trim();
    if (!['set', 'remove', 'copy', 'upsert_prompt_entry', 'remove_prompt_entry', 'upsert_order_item', 'remove_order_item'].includes(kind)) {
        return null;
    }

    return {
        kind,
        path: String(edit.path || '').trim(),
        fromPath: String(edit.fromPath || '').trim(),
        reason: String(edit.reason || '').trim(),
        value: kind === 'set' ? clone(edit.value, edit.value) : undefined,
        identifier: normalizePromptIdentifier(edit.identifier),
        character_id: String(edit.character_id || '').trim(),
        position: Number(edit.position),
        content: Object.hasOwn(edit, 'content') ? String(edit.content ?? '') : undefined,
        role: Object.hasOwn(edit, 'role') ? String(edit.role ?? '').trim() : undefined,
        enabled: Object.hasOwn(edit, 'enabled') ? Boolean(edit.enabled) : undefined,
        name: Object.hasOwn(edit, 'name') ? String(edit.name ?? '').trim() : undefined,
        marker: Object.hasOwn(edit, 'marker') ? Boolean(edit.marker) : undefined,
        injection_position: Object.hasOwn(edit, 'injection_position') ? edit.injection_position : undefined,
        injection_depth: Object.hasOwn(edit, 'injection_depth') ? edit.injection_depth : undefined,
        injection_order: Object.hasOwn(edit, 'injection_order') ? edit.injection_order : undefined,
    };
}

async function loadSessionStore(context, targetRef) {
    try {
        const raw = await context.presets.state.get(SESSION_NAMESPACE, { target: targetRef });
        return normalizeSessionStore(raw);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to load preset session`, error);
        return createEmptySessionStore();
    }
}

async function persistSessionStore(context, targetRef, store) {
    const nextStore = normalizeSessionStore(store);
    const result = await context.presets.state.update(
        SESSION_NAMESPACE,
        () => nextStore,
        {
            target: targetRef,
            asyncDiff: false,
        },
    );
    if (!result?.ok) {
        console.warn(`[${MODULE_NAME}] Failed to persist preset session`, result);
    }
    return nextStore;
}

function upsertPresetConversationSession(store, session) {
    const normalizedStore = normalizeSessionStore(store);
    const normalizedSession = sanitizeSession(session);
    const nextSessions = normalizedStore.sessions.filter((item) => String(item?.id || '').trim() !== normalizedSession.id);
    nextSessions.push(normalizedSession);
    nextSessions.sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    normalizedStore.sessions = nextSessions;
    return normalizedStore;
}

function deletePresetConversationSession(store, sessionId) {
    const normalizedStore = normalizeSessionStore(store);
    const safeSessionId = String(sessionId || '').trim();
    normalizedStore.sessions = normalizedStore.sessions.filter((item) => String(item?.id || '').trim() !== safeSessionId);
    if (normalizedStore.currentSessionId === safeSessionId) {
        normalizedStore.currentSessionId = normalizedStore.sessions.length > 0
            ? String(normalizedStore.sessions[normalizedStore.sessions.length - 1]?.id || '').trim()
            : '';
    }
    return normalizedStore;
}

function findPresetConversationSession(store, sessionId) {
    const safeSessionId = String(sessionId || '').trim();
    if (!safeSessionId) {
        return null;
    }
    return (Array.isArray(store?.sessions) ? store.sessions : [])
        .find((item) => String(item?.id || '').trim() === safeSessionId) || null;
}

function summarizePresetConversationSession(session, fallback = '') {
    const firstUser = (Array.isArray(session?.messages) ? session.messages : [])
        .find((item) => String(item?.role || '').trim().toLowerCase() === 'user');
    const summary = String(firstUser?.text || firstUser?.summary || '').trim() || String(fallback || '').trim();
    return summary.length > 72 ? `${summary.slice(0, 72).trim()}...` : summary;
}

async function savePresetConversationSession(context, targetRef, session, {
    store = null,
    setCurrent = true,
} = {}) {
    const nextSession = sanitizeSession({
        ...session,
        updatedAt: Date.now(),
    });
    const baseStore = store ? normalizeSessionStore(store) : await loadSessionStore(context, targetRef);
    const nextStore = upsertPresetConversationSession(baseStore, nextSession);
    if (setCurrent) {
        nextStore.currentSessionId = nextSession.id;
    }
    const persistedStore = await persistSessionStore(context, targetRef, nextStore);
    return {
        session: nextSession,
        store: persistedStore,
    };
}

function getPreferredPresetConversationSession(store) {
    const normalizedStore = normalizeSessionStore(store);
    const current = findPresetConversationSession(normalizedStore, normalizedStore.currentSessionId);
    if (current) {
        return current;
    }
    if (normalizedStore.sessions.length > 0) {
        return normalizedStore.sessions[normalizedStore.sessions.length - 1];
    }
    return null;
}

async function setCurrentPresetConversationSessionId(context, targetRef, store, sessionId) {
    const nextStore = normalizeSessionStore(store);
    nextStore.currentSessionId = String(sessionId || '').trim();
    return await persistSessionStore(context, targetRef, nextStore);
}

async function deletePresetConversationSessionById(context, targetRef, sessionId) {
    const store = deletePresetConversationSession(await loadSessionStore(context, targetRef), sessionId);
    return await persistSessionStore(context, targetRef, store);
}

async function loadJournal(context, targetRef, fallbackBaseSnapshot = {}) {
    try {
        const raw = await context.presets.state.get(JOURNAL_NAMESPACE, { target: targetRef });
        return sanitizeJournal(raw, fallbackBaseSnapshot);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to load preset journal`, error);
        return createEmptyJournal(fallbackBaseSnapshot);
    }
}

async function saveJournal(context, targetRef, journal) {
    const nextJournal = sanitizeJournal(journal, journal?.baseSnapshot || {});
    const result = await context.presets.state.update(
        JOURNAL_NAMESPACE,
        () => nextJournal,
        {
            target: targetRef,
            asyncDiff: false,
        },
    );
    if (!result?.ok) {
        console.warn(`[${MODULE_NAME}] Failed to persist preset journal`, result);
    }
    return nextJournal;
}

function getJournalEntries(journal) {
    return Array.isArray(journal?.entries)
        ? journal.entries.map(item => sanitizeJournalEntry(item)).filter(Boolean)
        : [];
}

function ensureJournalBaseSnapshot(journal, baseSnapshot = {}) {
    const nextJournal = sanitizeJournal(journal, baseSnapshot);
    if (nextJournal.entries.length > 0) {
        return nextJournal;
    }
    return {
        ...nextJournal,
        baseSnapshot: isPlainObject(baseSnapshot) ? clone(baseSnapshot, {}) : {},
    };
}

function replayJournalBody(journal, {
    includeEntry = null,
} = {}) {
    const safeJournal = sanitizeJournal(journal, journal?.baseSnapshot || {});
    return replayJsonStateJournal(
        diffPatcher,
        safeJournal.baseSnapshot || {},
        getJournalEntries(safeJournal),
        { includeEntry },
    );
}

function journalMatchesLive(journal, liveBody) {
    return arePresetBodiesEquivalent(replayJournalBody(journal), liveBody);
}

function getCommittedMessageEntryMap(session, journal) {
    const sessionId = String(session?.id || '').trim();
    const commitMap = new Map();
    if (!sessionId) {
        return commitMap;
    }

    for (const entry of getJournalEntries(journal)) {
        if (entry.sessionId !== sessionId) {
            continue;
        }
        const current = commitMap.get(entry.messageId) || 0;
        commitMap.set(entry.messageId, current + 1);
    }

    return commitMap;
}

function collectTouchedPaths(entries) {
    return [...new Set((Array.isArray(entries) ? entries : []).flatMap(entry => Array.isArray(entry?.touchedPaths) ? entry.touchedPaths : []).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

function getDraftSourceMessageId(session, draft) {
    const explicitMessageId = String(draft?.sourceMessageId || '').trim();
    if (explicitMessageId) {
        return explicitMessageId;
    }

    const messages = Array.isArray(session?.messages) ? session.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = sanitizeMessage(messages[index]);
        if (message.role === 'assistant') {
            return message.id;
        }
    }

    return '';
}

function buildMessageDiffPlan(session, journal, messageId) {
    const safeMessageId = String(messageId || '').trim();
    if (!safeMessageId) {
        return null;
    }

    const safeSession = sanitizeSession(session);
    const entries = getJournalEntries(journal);
    const matchedIndices = [];
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.sessionId === safeSession.id && entry.messageId === safeMessageId) {
            matchedIndices.push(index);
        }
    }

    if (matchedIndices.length === 0) {
        return null;
    }

    const firstIndex = matchedIndices[0];
    const lastIndex = matchedIndices[matchedIndices.length - 1];
    return {
        beforeBody: replayJsonStateJournal(diffPatcher, journal?.baseSnapshot || {}, entries.slice(0, firstIndex)),
        afterBody: replayJsonStateJournal(diffPatcher, journal?.baseSnapshot || {}, entries.slice(0, lastIndex + 1)),
    };
}

function buildTailRollbackPlan(session, journal, messageId) {
    const safeMessageId = String(messageId || '').trim();
    if (!safeMessageId) {
        return null;
    }

    const safeSession = sanitizeSession(session);
    const messages = Array.isArray(safeSession.messages) ? safeSession.messages : [];
    const startIndex = messages.findIndex(message => String(message?.id || '') === safeMessageId);
    if (startIndex < 0) {
        return null;
    }

    const rollbackMessageIds = new Set(messages.slice(startIndex).map(message => String(message?.id || '').trim()).filter(Boolean));
    const trimIndex = startIndex > 0 && messages[startIndex - 1]?.role === 'user'
        ? startIndex - 1
        : startIndex;
    const entries = getJournalEntries(journal);
    const targetEntries = entries.filter(entry => entry.sessionId === safeSession.id && rollbackMessageIds.has(entry.messageId));
    if (targetEntries.length === 0) {
        return null;
    }

    const targetEntryIds = new Set(targetEntries.map(entry => entry.id));
    const firstTargetIndex = entries.findIndex(entry => targetEntryIds.has(entry.id));
    const retainedLaterEntries = firstTargetIndex >= 0
        ? entries.slice(firstTargetIndex).filter(entry => !targetEntryIds.has(entry.id))
        : [];

    return {
        trimIndex,
        targetEntries,
        revertedBody: replayJsonStateJournal(diffPatcher, journal?.baseSnapshot || {}, entries, {
            includeEntry: entry => !targetEntryIds.has(entry.id),
        }),
        conflicting: hasJsonStatePathConflict(
            collectTouchedPaths(targetEntries),
            collectTouchedPaths(retainedLaterEntries),
        ),
    };
}

function getChangedTopLevelKeys(before, after) {
    const safeBefore = isPlainObject(before) ? before : {};
    const safeAfter = isPlainObject(after) ? after : {};
    const keys = [...new Set([...Object.keys(safeBefore), ...Object.keys(safeAfter)])];
    return keys.filter((key) => !areJsonEqual(safeBefore[key], safeAfter[key])).slice(0, 40);
}

function normalizePromptIdentifier(value, fallback = '') {
    return String(value ?? fallback ?? '').trim();
}

function getPresetPromptEntries(body) {
    if (!Array.isArray(body?.prompts)) {
        return [];
    }
    return body.prompts
        .map((entry, index) => {
            const source = entry && typeof entry === 'object' ? entry : {};
            const identifier = normalizePromptIdentifier(source.identifier, source.id);
            if (!identifier) {
                return null;
            }
            return {
                identifier,
                index,
                content: String(source.content ?? ''),
                role: String(source.role ?? '').trim(),
                enabled: source.enabled !== false,
                name: String(source.name ?? '').trim(),
                marker: Boolean(source.marker),
                injection_position: source.injection_position ?? null,
                injection_depth: source.injection_depth ?? null,
                injection_order: source.injection_order ?? null,
            };
        })
        .filter(Boolean);
}

function getPresetPromptOrderGroups(body) {
    if (!Array.isArray(body?.prompt_order)) {
        return [];
    }
    return body.prompt_order
        .map((group) => {
            const source = group && typeof group === 'object' ? group : {};
            const characterId = String(source.character_id ?? '').trim();
            const order = Array.isArray(source.order)
                ? source.order
                    .map((item) => {
                        const orderSource = item && typeof item === 'object' ? item : {};
                        const identifier = normalizePromptIdentifier(orderSource.identifier);
                        if (!identifier) {
                            return null;
                        }
                        return {
                            identifier,
                            enabled: orderSource.enabled !== false,
                        };
                    })
                    .filter(Boolean)
                : [];
            if (!characterId) {
                return null;
            }
            return {
                character_id: characterId,
                order,
            };
        })
        .filter(Boolean);
}

function buildPromptProjectionEntry(promptEntry, {
    index = 0,
    enabled = true,
} = {}) {
    const prompt = promptEntry && typeof promptEntry === 'object' ? promptEntry : {};
    return {
        position: index + 1,
        identifier: String(prompt.identifier || '').trim(),
        enabled: Boolean(enabled),
        role: String(prompt.role || '').trim(),
        injection_position: prompt.injection_position,
        injection_depth: prompt.injection_depth,
        injection_order: prompt.injection_order,
        name: String(prompt.name || '').trim(),
        marker: Boolean(prompt.marker),
        content: String(prompt.content || ''),
    };
}

function buildPresetPromptProjection(body) {
    const promptEntries = getPresetPromptEntries(body);
    const promptMap = new Map(promptEntries.map((entry) => [entry.identifier, entry]));
    const orderedIdentifiers = new Set();
    const orderedGroups = getPresetPromptOrderGroups(body).map((group) => ({
        character_id: group.character_id,
        items: group.order.map((item, index) => {
            orderedIdentifiers.add(item.identifier);
            const promptEntry = promptMap.get(item.identifier) || {
                identifier: item.identifier,
                content: '',
                role: '',
                enabled: item.enabled,
                name: '',
                marker: false,
                injection_position: null,
                injection_depth: null,
                injection_order: null,
            };
            return buildPromptProjectionEntry(promptEntry, {
                index,
                enabled: item.enabled,
            });
        }),
    }));
    const unorderedEntries = promptEntries
        .filter((entry) => !orderedIdentifiers.has(entry.identifier))
        .map((entry, index) => buildPromptProjectionEntry(entry, {
            index,
            enabled: entry.enabled,
        }));

    return {
        new_chat_prompt: String(body?.new_chat_prompt ?? ''),
        new_group_chat_prompt: String(body?.new_group_chat_prompt ?? ''),
        ordered_prompts: orderedGroups,
        unordered_prompts: unorderedEntries,
    };
}

function buildPromptDiffEntryText(item = {}) {
    const safeItem = item && typeof item === 'object' ? item : {};
    const lines = [
        `identifier: ${String(safeItem.identifier || '').trim() || '(missing)'}`,
        `enabled: ${safeItem.enabled === false ? 'false' : 'true'}`,
        `role: ${String(safeItem.role || '').trim() || 'n/a'}`,
    ];
    if (String(safeItem.name || '').trim()) {
        lines.push(`name: ${String(safeItem.name || '').trim()}`);
    }
    lines.push(`marker: ${safeItem.marker === true ? 'true' : 'false'}`);
    lines.push(`injection_position: ${safeItem.injection_position ?? 'n/a'}`);
    lines.push(`injection_depth: ${safeItem.injection_depth ?? 'n/a'}`);
    lines.push(`injection_order: ${safeItem.injection_order ?? 'n/a'}`);
    lines.push('content:');
    lines.push(String(safeItem.content || ''));
    return lines.join('\n');
}

function buildOrderedPromptDiffKey(item = {}) {
    const position = Math.max(1, Number(item?.position) || 1);
    const identifier = String(item?.identifier || '').trim() || 'unnamed';
    return `${String(position).padStart(3, '0')}__${identifier}`;
}

function parseOrderedPromptDiffKey(key = '') {
    const text = String(key || '').trim();
    const match = text.match(/^(\d+)__(.*)$/);
    if (!match) {
        return {
            position: 0,
            identifier: text,
        };
    }
    return {
        position: Number(match[1] || 0),
        identifier: String(match[2] || '').trim(),
    };
}

function buildPresetDiffProjection(body) {
    const projection = buildPresetPromptProjection(body);
    const orderedGroups = {};
    for (const group of Array.isArray(projection.ordered_prompts) ? projection.ordered_prompts : []) {
        const groupKey = String(group?.character_id || '').trim() || '(missing)';
        orderedGroups[groupKey] = {};
        for (const item of Array.isArray(group?.items) ? group.items : []) {
            orderedGroups[groupKey][buildOrderedPromptDiffKey(item)] = buildPromptDiffEntryText(item);
        }
    }

    const unorderedPrompts = {};
    for (const item of Array.isArray(projection.unordered_prompts) ? projection.unordered_prompts : []) {
        const key = String(item?.identifier || '').trim() || `unnamed_${Object.keys(unorderedPrompts).length + 1}`;
        unorderedPrompts[key] = buildPromptDiffEntryText(item);
    }

    return {
        base_prompts: {
            new_chat_prompt: String(projection.new_chat_prompt || ''),
            new_group_chat_prompt: String(projection.new_group_chat_prompt || ''),
        },
        ordered_groups: orderedGroups,
        unordered_prompts: unorderedPrompts,
    };
}

function formatPresetDiffPath(path) {
    const tokens = tokenizeJsonPath(path);
    if (tokens.length === 2 && tokens[0] === 'base_prompts') {
        return String(tokens[1] || '');
    }
    if (tokens.length === 3 && tokens[0] === 'ordered_groups') {
        const groupId = String(tokens[1] || '').trim() || '(missing)';
        const parsed = parseOrderedPromptDiffKey(tokens[2]);
        return `ordered prompt · character_id=${groupId} · ${parsed.position || '?'}. ${parsed.identifier || '(missing)'}`;
    }
    if (tokens.length === 2 && tokens[0] === 'unordered_prompts') {
        return `unordered prompt · ${String(tokens[1] || '').trim() || '(missing)'}`;
    }
    return String(path || '(root)');
}

function formatPromptPreview(content) {
    const normalized = String(content ?? '').replace(/\r\n/g, '\n').trim();
    if (!normalized) {
        return '(empty)';
    }
    const lines = normalized.split('\n').slice(0, 3).map((line) => line.trim()).filter(Boolean);
    const preview = lines.join(' / ');
    return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
}

function buildPresetPromptOutlineText(body) {
    const projection = buildPresetPromptProjection(body);
    const sections = [
        'Prompt layout overview:',
        `- new_chat_prompt: ${formatPromptPreview(projection.new_chat_prompt)}`,
        `- new_group_chat_prompt: ${formatPromptPreview(projection.new_group_chat_prompt)}`,
    ];

    if (projection.ordered_prompts.length === 0) {
        sections.push('- ordered prompt groups: none');
    } else {
        sections.push('- ordered prompt groups:');
        for (const group of projection.ordered_prompts) {
            sections.push(`  character_id=${group.character_id}`);
            if (group.items.length === 0) {
                sections.push('  (empty)');
                continue;
            }
            for (const item of group.items) {
                sections.push(
                    `  ${item.position}. ${item.identifier} [${item.enabled ? 'enabled' : 'disabled'}] role=${item.role || 'n/a'} position=${item.injection_position ?? 'n/a'} depth=${item.injection_depth ?? 'n/a'} order=${item.injection_order ?? 'n/a'}`,
                );
                sections.push(`     ${formatPromptPreview(item.content)}`);
            }
        }
    }

    if (projection.unordered_prompts.length > 0) {
        sections.push('- prompts not present in prompt_order:');
        for (const item of projection.unordered_prompts) {
            sections.push(`  - ${item.identifier} [${item.enabled ? 'enabled' : 'disabled'}] role=${item.role || 'n/a'}`);
            sections.push(`    ${formatPromptPreview(item.content)}`);
        }
    }

    return sections.join('\n');
}

function buildPresetSettingsOutlineText(body) {
    const source = isPlainObject(body) ? body : {};
    const keyLabels = new Map([
        ['temperature', 'temperature'],
        ['top_p', 'top_p'],
        ['top_k', 'top_k'],
        ['min_p', 'min_p'],
        ['presence_penalty', 'presence_penalty'],
        ['frequency_penalty', 'frequency_penalty'],
        ['openai_max_context', 'context_limit'],
        ['openai_max_tokens', 'output_tokens'],
        ['names_behavior', 'names_behavior'],
        ['send_if_empty', 'send_if_empty'],
        ['impersonation_prompt', 'impersonation_prompt'],
        ['continue_nudge_prompt', 'continue_nudge_prompt'],
        ['stream_openai', 'stream_openai'],
        ['use_sysprompt', 'use_sysprompt'],
        ['assistant_prefill', 'assistant_prefill'],
        ['continue_prefill', 'continue_prefill'],
        ['continue_postfix', 'continue_postfix'],
        ['function_calling', 'function_calling'],
        ['show_thoughts', 'show_thoughts'],
        ['reasoning_effort', 'reasoning_effort'],
        ['verbosity', 'verbosity'],
        ['enable_web_search', 'enable_web_search'],
        ['seed', 'seed'],
        ['n', 'n'],
    ]);
    const lines = [];
    for (const [key, label] of keyLabels.entries()) {
        if (!Object.hasOwn(source, key)) {
            continue;
        }
        const value = source[key];
        if (value === '' || value === null || value === undefined) {
            continue;
        }
        const text = typeof value === 'string' ? value : buildJson(value);
        lines.push(`- ${label}: ${text}`);
    }
    return lines.length > 0
        ? ['Generation and context settings:', ...lines].join('\n')
        : 'Generation and context settings: none';
}

function buildFormattedLiveStateText(body) {
    return [
        buildPresetSettingsOutlineText(body),
        '',
        buildPresetPromptOutlineText(body),
    ].join('\n');
}

function buildPresetStructureGuideText() {
    return [
        'OpenAI preset structure guide:',
        '- Base prompt fields: new_chat_prompt, new_group_chat_prompt, continue_nudge_prompt, impersonation_prompt, assistant_prefill, continue_prefill, continue_postfix, send_if_empty, wi_format, scenario_format, personality_format, group_nudge_prompt, use_sysprompt, squash_system_messages.',
        '- Common generation/context fields: temperature, top_p, top_k, min_p, presence_penalty, frequency_penalty, openai_max_context, openai_max_tokens, names_behavior, function_calling, show_thoughts, reasoning_effort, verbosity, seed, n.',
        '- prompts[] entries: identifier, name, content, role, enabled, marker, injection_position, injection_depth, injection_order.',
        '- prompt_order[] groups: each item has character_id and order[]. Each order[] item has identifier and enabled.',
        '- Prefer prompt-specific tools over raw path edits for prompts and prompt_order.',
        '- New presets created from this assistant start from the packaged Default preset when available.',
    ].join('\n');
}

function buildDialogMetaItems(dialogState) {
    const settings = getSettings();
    const requestProfileLabel = settings.requestApiProfileName || i18n('(current)');
    const llmPresetLabel = settings.requestLlmPresetName || i18n('(current)');
    return [
        `${i18n('Target')}: ${dialogState.targetRef?.name || ''}`,
        `${i18n('Current request API preset')}: ${requestProfileLabel}`,
        `${i18n('Current request prompt preset')}: ${llmPresetLabel}`,
        i18n('Prompt preset paths use lodash syntax like prompts[0].content or new_chat_prompt.'),
    ];
}

function buildOrchestratorOptimizeModeBlock() {
    return [
        '',
        'Mode: orchestrator-optimize.',
        '',
        'The user is editing this preset for use with a multi-agent orchestrator',
        '(director / loop / iteration). The model consuming this preset will be an',
        'agent that issues tool calls, not a narrator producing a single textual',
        'response. Three patterns in typical RP presets actively interfere:',
        '',
        '1. Hard output-format constraints. A preset that prescribes a literal',
        '   output schema (any structural shape the model is forced to produce)',
        '   is incompatible with tool-calling — the agent cannot satisfy the',
        '   schema and emit tool calls in the same response. Rewrite these',
        '   directives to express the cognitive intent (think before acting,',
        '   plan structure, consider tradeoffs) without prescribing a literal',
        '   output format.',
        '',
        '2. Final-product-only directives. Anything that should appear only in',
        '   the final committed assistant message must be conditioned on that',
        '   stage in the directive itself. The orchestrator runs many sub-agent',
        '   rounds and iterations; these directives should not fire every round.',
        '   Rewrite the directive\'s content so it explicitly conditions itself',
        '   on "the final committed message" or equivalent — the consuming',
        '   agent then decides per round whether it applies.',
        '',
        '3. Duplicate-injection placeholders. The orchestrator\'s main path',
        '   already injects character / persona / worldbook content into the',
        '   chat context the agent sees. Preset items that splice the same',
        '   content double the injection.',
        '',
        '   Disable: character card fields (description / personality /',
        '   scenario / first message / example messages), user persona,',
        '   worldbook splice nodes (any explicit worldInfo entries in the',
        '   preset).',
        '',
        '   Must stay enabled:',
        '   - chat history — the channel through which the agent\'s prompt',
        '     reaches the LLM; disabling it silences the agent. If the original',
        '     preset has it off, enable it.',
        '   - writing style / anti-cliché instructions — read by the main',
        '     agent when drafting and when briefing critic sub-agents.',
        '   - jailbreak / bypass instructions — a mid-loop refusal stalls the',
        '     scout → draft → critique chain before finalize can fire.',
        '',
        'Preserve everything else not covered above. NSFW permissions, RP voice',
        'rules, character-writing instructions, content directives — they are',
        'not the problem.',
        '',
        'Approach:',
        '- Inspect the live preset with read tools to identify entries matching',
        '  the patterns above before proposing changes.',
        '- Default to suggesting derivation via preset_clone_to_new: propose a',
        '  new preset name (e.g., `<original>-orchestrator`), explain why, await',
        '  user consent. Only edit the live preset directly if the user opts in.',
        '- Prefer minimal edits — rewrite offending lines / sections inside an',
        '  entry rather than removing the entry, when possible.',
        '- When unsure whether a directive is format constraint vs writing',
        '  style, err toward preserving and ask the user.',
    ].join('\n');
}

function buildJailbreakOnlyModeBlock() {
    return [
        '',
        'Mode: jailbreak-only.',
        '',
        'The user is editing this preset for use by a tool-style LLM caller — an',
        'internal Luker subsystem (memory graph curator, preset assistant,',
        'other LLM-driven plugins) running structured tasks, not producing',
        'narrative RP. To such a caller, the user\'s preset is valuable solely',
        'as a jailbreak / uncensoring layer; everything else is noise that',
        'biases the model toward writing prose when it should be emitting',
        'structured output.',
        '',
        'Goals:',
        '1. Identify and preserve jailbreak / uncensoring directives. The',
        '   standard `jailbreak` field is the obvious one, but jailbreak content',
        '   commonly lives in custom-named entries or as inline sections inside',
        '   larger entries. Recognize them by semantic intent — directives that',
        '   grant permission to handle restricted content, override default',
        '   safety posture, or operate as an uncensored persona. When in doubt,',
        '   preserve and flag for user confirmation.',
        '2. Disable everything that exists to shape narrative RP output —',
        '   writing style, voice rules, character-writing guidance, output',
        '   schemas, NSFW writing rules, narrative meta-rules. Heuristic: if',
        '   removing this directive would change *how the model writes a story*',
        '   but not *what the model is permitted to write*, disable it.',
        '3. Do not touch the ST-filled content slots (charDescription /',
        '   personaDescription / scenario / worldInfoBefore / worldInfoAfter /',
        '   chatHistory and the like). The host plugin decides at call time',
        '   whether it wants those slots populated; this mode should not',
        '   preempt that decision. Leave their enabled/disabled state as the',
        '   original preset has it.',
        '',
        'Approach:',
        '- Default to suggesting derivation via preset_clone_to_new: propose a',
        '  new preset name (e.g., `<original>-jailbreak`), explain why, await',
        '  user consent.',
        '- Inspect the live preset with read tools before proposing disables.',
        '  Decide by semantic intent, not by entry name.',
        '- Disable by removing from prompt order, not by deleting the',
        '  underlying prompt entry. The user can revert by re-adding to order.',
        '- When an entry contains BOTH jailbreak content AND other content',
        '  interleaved, edit the entry to isolate the jailbreak section rather',
        '  than disabling the whole entry — losing the jailbreak portion would',
        '  defeat the mode\'s purpose.',
    ].join('\n');
}

function buildModelSystemPrompt({
    hasReference = false,
    mode = SESSION_MODE_DEFAULT,
} = {}) {
    const baseLines = [
        'You are editing one Luker chat completion preset.',
        'Edit prompt-related preset content only.',
        'Do not modify API connection, provider routing, endpoint selection, proxy settings, transport settings, or credential fields.',
        'Chat completion presets and API profiles are decoupled.',
        'Use tool calls when proposing actual preset changes.',
        'If you call any helper inspection tool in a round, do not emit edit tool calls in that same round.',
        'Prefer minimal edits over broad rewrites unless the user explicitly asks for a rewrite.',
        'Prefer the prompt-specific tools when adding, removing, or reordering prompt entries.',
        'Use 1-based positions for preset_upsert_prompt_order_item.',
        'Use preset_read_live_fields when you need exact current values for specific preset paths.',
        hasReference
            ? 'Use preset_read_reference_fields when you need exact values from the selected reference preset.'
            : 'No reference preset is selected. Do not call preset_read_reference_fields.',
        'Use lodash-style paths like new_chat_prompt or prompts[0].content only when the prompt-specific tools are not enough.',
        'For preset_set_field, value_json must be valid JSON text.',
        hasReference
            ? 'Use preset_diff_reference when you need to inspect the selected reference preset before copying from it.'
            : 'No reference preset is selected. Do not call reference-inspection tools.',
        'Use preset_simulate when you need to inspect how the current preset assembles prompt messages.',
        'For preset_simulate, prefer the text argument so the tool appends that user text to the current chat. Use the messages array only when the user explicitly supplied a structured message list/record list.',
        'Use preset_copy_from_reference only when a selected reference preset exists and already contains the desired content.',
        'preset_clone_to_new copies the current live preset under a new name and switches the dialog target to it. Use it when the user agrees to derive a new preset rather than editing the original.',
        'If no changes are needed, reply briefly without tool calls.',
    ];

    const safeMode = sanitizeSessionMode(mode);
    const modeBlock = safeMode === 'orchestrator-optimize'
        ? buildOrchestratorOptimizeModeBlock()
        : safeMode === 'jailbreak-only'
            ? buildJailbreakOnlyModeBlock()
            : '';

    return modeBlock
        ? `${baseLines.join('\n')}\n${modeBlock}`
        : baseLines.join('\n');
}

function buildConversationHistoryMessages(session) {
    const messages = Array.isArray(session?.messages) ? session.messages.slice(-8) : [];
    return buildPersistentToolHistoryMessages(messages);
}

function buildUserPrompt(dialogState, userText) {
    const referenceName = String(dialogState.referenceSnapshot?.ref?.name || '').trim();
    const referenceSection = referenceName
        ? [
            `Selected reference preset: ${referenceName}`,
            'The selected reference preset is available to preset_copy_from_reference.',
            'Use preset_diff_reference if you need to inspect how it differs from the current live preset.',
        ].join('\n')
        : 'Selected reference preset: none.';

    return [
        'Target preset collection: openai',
        `Target preset name: ${dialogState.targetRef?.name || ''}`,
        '',
        buildPresetStructureGuideText(),
        '',
        buildFormattedLiveStateText(dialogState.liveSnapshot?.body || {}),
        '',
        referenceSection,
        '',
        'User request:',
        String(userText || '').trim(),
    ].join('\n');
}

function normalizeWorldInfoResolverMessages(messages = []) {
    if (!Array.isArray(messages)) {
        return [];
    }

    return messages.map((message) => {
        if (!message || typeof message !== 'object') {
            return message;
        }
        const next = { ...message };
        const rawRole = String(next.role || '').trim().toLowerCase();
        if (rawRole === 'system' || rawRole === 'user' || rawRole === 'assistant') {
            next.role = rawRole;
        } else if (next.is_system) {
            next.role = 'system';
        } else if (next.is_user) {
            next.role = 'user';
        } else {
            next.role = 'assistant';
        }
        if (next.content === undefined && Object.hasOwn(next, 'mes')) {
            next.content = String(next.mes ?? '');
        }
        return next;
    });
}

function appendUniqueWorldInfoBlock(payload, key, block) {
    if (!payload || typeof payload !== 'object') {
        return;
    }
    const content = String(block ?? '').trim();
    if (!content) {
        return;
    }
    if (!Array.isArray(payload[key])) {
        payload[key] = [];
    }
    if (!payload[key].includes(content)) {
        payload[key].push(content);
    }
}

function rewriteDepthWorldInfoToAfter(payload = {}) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }
    const depthEntries = Array.isArray(payload.worldInfoDepth) ? payload.worldInfoDepth : [];
    if (depthEntries.length === 0) {
        return payload;
    }

    const blocks = [];
    for (const entry of depthEntries) {
        const lines = Array.isArray(entry?.entries) ? entry.entries : [];
        for (const line of lines) {
            const content = String(line ?? '').trim();
            if (content) {
                blocks.push(content);
            }
        }
    }

    payload.worldInfoDepth = [];
    for (const block of blocks) {
        appendUniqueWorldInfoBlock(payload, 'worldInfoAfterEntries', block);
    }
    return payload;
}

function appendStandardToolRoundMessages(targetMessages, executedCalls, assistantText = '') {
    if (!Array.isArray(targetMessages) || !Array.isArray(executedCalls) || executedCalls.length === 0) {
        return;
    }

    const toolCalls = executedCalls.map((call) => {
        const id = String(call?.id || '').trim() || makeRuntimeToolCallId();
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        return {
            id,
            type: 'function',
            function: {
                name,
                arguments: JSON.stringify(args),
            },
            _result: call?.result,
        };
    }).filter(call => call.function.name);

    if (toolCalls.length === 0) {
        return;
    }

    targetMessages.push({
        role: 'assistant',
        content: String(assistantText || ''),
        tool_calls: toolCalls.map(({ _result, ...toolCall }) => toolCall),
    });

    for (const toolCall of toolCalls) {
        targetMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: serializeToolResultContent(toolCall._result),
        });
    }
}

function buildSimulationSourceMessages(context, {
    text = '',
    messages = null,
} = {}) {
    const explicitMessages = normalizeWorldInfoResolverMessages(messages)
        .filter(message => message && typeof message === 'object' && String(message.content ?? '').trim());
    if (explicitMessages.length > 0) {
        return {
            mode: 'messages',
            messages: explicitMessages,
        };
    }

    const safeText = String(text || '').trim();
    if (!safeText) {
        return {
            mode: '',
            messages: [],
        };
    }

    const currentChatMessages = normalizeWorldInfoResolverMessages(Array.isArray(context?.chat) ? context.chat : [])
        .filter(message => message && typeof message === 'object' && String(message.content ?? '').trim());
    return {
        mode: 'text',
        messages: [
            ...currentChatMessages,
            { role: 'user', content: safeText },
        ],
    };
}

function normalizePresetReadPaths(args = {}) {
    return Array.isArray(args?.paths)
        ? [...new Set(args.paths.map((item) => String(item || '').trim()).filter(Boolean))]
        : [];
}

function buildPresetFieldReadResult(body, paths = []) {
    const source = isPlainObject(body) ? body : {};
    return paths.map((path) => ({
        path,
        exists: lodash.has(source, path),
        value: clone(lodash.get(source, path), null),
    }));
}

function createPresetAssistantLiveReadToolApi(dialogState) {
    return {
        toolNames: {
            READ_LIVE_FIELDS: MODEL_TOOLS.READ_LIVE_FIELDS,
        },
        getToolDefs() {
            return [{
                type: 'function',
                function: {
                    name: MODEL_TOOLS.READ_LIVE_FIELDS,
                    description: 'Read exact values from the current live preset by lodash-style paths.',
                    parameters: {
                        type: 'object',
                        properties: {
                            paths: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'One or more lodash-style paths such as prompts[0].content or prompt_order[0].order.',
                            },
                        },
                        required: ['paths'],
                        additionalProperties: false,
                    },
                },
            }];
        },
        isToolName(name) {
            return String(name || '').trim() === MODEL_TOOLS.READ_LIVE_FIELDS;
        },
        async invoke(call) {
            const paths = normalizePresetReadPaths(call?.args);
            if (paths.length === 0) {
                throw new Error('preset_read_live_fields requires at least one path.');
            }
            const liveBody = isPlainObject(dialogState.liveSnapshot?.body) ? dialogState.liveSnapshot.body : {};
            return {
                ok: true,
                presetName: String(dialogState.targetRef?.name || '').trim(),
                source: 'live',
                values: buildPresetFieldReadResult(liveBody, paths),
            };
        },
    };
}

function createPresetAssistantReferenceReadToolApi(dialogState) {
    return {
        toolNames: {
            READ_REFERENCE_FIELDS: MODEL_TOOLS.READ_REFERENCE_FIELDS,
        },
        getToolDefs() {
            return [{
                type: 'function',
                function: {
                    name: MODEL_TOOLS.READ_REFERENCE_FIELDS,
                    description: 'Read exact values from the selected reference preset by lodash-style paths.',
                    parameters: {
                        type: 'object',
                        properties: {
                            paths: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'One or more lodash-style paths such as prompts[0].content or prompt_order[0].order.',
                            },
                        },
                        required: ['paths'],
                        additionalProperties: false,
                    },
                },
            }];
        },
        isToolName(name) {
            return String(name || '').trim() === MODEL_TOOLS.READ_REFERENCE_FIELDS;
        },
        async invoke(call) {
            const paths = normalizePresetReadPaths(call?.args);
            if (paths.length === 0) {
                throw new Error('preset_read_reference_fields requires at least one path.');
            }
            const referenceSnapshot = dialogState.referenceSnapshot;
            if (!referenceSnapshot || !isPlainObject(referenceSnapshot.body)) {
                throw new Error('No reference preset selected.');
            }
            return {
                ok: true,
                presetName: String(referenceSnapshot?.ref?.name || '').trim(),
                source: 'reference',
                values: buildPresetFieldReadResult(referenceSnapshot.body, paths),
            };
        },
    };
}

function createPresetAssistantReferenceDiffToolApi(dialogState) {
    return {
        toolNames: {
            DIFF_REFERENCE: MODEL_TOOLS.DIFF_REFERENCE,
        },
        getToolDefs() {
            return [{
                type: 'function',
                function: {
                    name: MODEL_TOOLS.DIFF_REFERENCE,
                    description: 'Inspect how the current live preset differs from the selected reference preset. Use optional lodash-style paths to narrow the output.',
                    parameters: {
                        type: 'object',
                        properties: {
                            paths: {
                                type: 'array',
                                items: { type: 'string' },
                            },
                        },
                        additionalProperties: false,
                    },
                },
            }];
        },
        isToolName(name) {
            return String(name || '').trim() === MODEL_TOOLS.DIFF_REFERENCE;
        },
        async invoke(call) {
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            const referenceSnapshot = dialogState.referenceSnapshot;
            if (!referenceSnapshot || !isPlainObject(referenceSnapshot.body)) {
                throw new Error('No reference preset selected.');
            }

            const liveBody = isPlainObject(dialogState.liveSnapshot?.body) ? dialogState.liveSnapshot.body : {};
            const referenceBody = referenceSnapshot.body;
            const paths = Array.isArray(args.paths)
                ? [...new Set(args.paths.map(item => String(item || '').trim()).filter(Boolean))]
                : [];
            if (paths.length > 0) {
                return {
                    ok: true,
                    referencePresetName: String(referenceSnapshot?.ref?.name || '').trim(),
                    comparisons: paths.map((path) => {
                        const currentValue = clone(lodash.get(liveBody, path), null);
                        const referenceValue = clone(lodash.get(referenceBody, path), null);
                        return {
                            path,
                            current: currentValue,
                            reference: referenceValue,
                            equal: areJsonEqual(currentValue, referenceValue),
                        };
                    }),
                };
            }

            return {
                ok: true,
                referencePresetName: String(referenceSnapshot?.ref?.name || '').trim(),
                changedTopLevelKeys: getChangedTopLevelKeys(
                    buildPresetPromptProjection(liveBody),
                    buildPresetPromptProjection(referenceBody),
                ),
                delta: buildJsonStateDelta(
                    diffPatcher,
                    buildPresetPromptProjection(liveBody),
                    buildPresetPromptProjection(referenceBody),
                ) || {},
                currentPromptLayout: buildPresetPromptOutlineText(liveBody),
                referencePromptLayout: buildPresetPromptOutlineText(referenceBody),
            };
        },
    };
}

function createPresetAssistantSimulateToolApi(dialogState) {
    return {
        toolNames: {
            SIMULATE: MODEL_TOOLS.SIMULATE,
        },
        getToolDefs() {
            return [{
                type: 'function',
                function: {
                    name: MODEL_TOOLS.SIMULATE,
                    description: 'Simulate prompt assembly for the current preset. Prefer text to append one user turn to the current chat. Use messages only when the user already supplied a full message array.',
                    parameters: {
                        type: 'object',
                        properties: {
                            text: {
                                type: 'string',
                                description: 'Preferred. Append this user text to the current chat and simulate with world info activation.',
                            },
                            messages: {
                                type: 'array',
                                description: 'Explicit message array. Use only when the user already gave structured records/messages.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        role: { type: 'string' },
                                        content: { type: 'string' },
                                        mes: { type: 'string' },
                                        is_user: { type: 'boolean' },
                                        is_system: { type: 'boolean' },
                                    },
                                    additionalProperties: true,
                                },
                            },
                        },
                        additionalProperties: false,
                    },
                },
            }];
        },
        isToolName(name) {
            return String(name || '').trim() === MODEL_TOOLS.SIMULATE;
        },
        async invoke(call) {
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            const source = buildSimulationSourceMessages(dialogState.context, {
                text: String(args.text || '').trim(),
                messages: Array.isArray(args.messages) ? args.messages : null,
            });
            if (source.messages.length === 0) {
                throw new Error('preset_simulate requires either text or messages.');
            }
            if (typeof dialogState.context?.buildPresetAwarePromptMessages !== 'function') {
                throw new Error('Prompt preset assembly is unavailable.');
            }

            const runtimeWorldInfo = typeof dialogState.context?.resolveWorldInfoForMessages === 'function'
                ? await dialogState.context.resolveWorldInfoForMessages(source.messages, {
                    type: 'quiet',
                    fallbackToCurrentChat: false,
                    postActivationHook: rewriteDepthWorldInfoToAfter,
                })
                : {};
            const promptMessages = dialogState.context.buildPresetAwarePromptMessages({
                messages: source.messages,
                envelopeOptions: {
                    includeCharacterCard: true,
                    api: 'openai',
                },
                runtimeWorldInfo,
            });
            return {
                ok: true,
                mode: source.mode,
                sourceMessages: source.messages,
                runtimeWorldInfo,
                promptMessages,
            };
        },
    };
}

function createPresetAssistantCloneToolApi(dialogState) {
    return {
        toolNames: {
            CLONE_TO_NEW: MODEL_TOOLS.CLONE_TO_NEW,
        },
        getToolDefs() {
            return [{
                type: 'function',
                function: {
                    name: MODEL_TOOLS.CLONE_TO_NEW,
                    description: 'Clone the current live preset under a new name and switch the dialog target to it. Use when the user agrees to derive a new preset rather than editing the original. Fails if new_name already exists; retry with a different name in that case. Any pending unapplied draft is discarded.',
                    parameters: {
                        type: 'object',
                        properties: {
                            new_name: {
                                type: 'string',
                                description: 'Name of the new preset. Must be non-empty and must not collide with an existing OpenAI preset.',
                            },
                            reason: {
                                type: 'string',
                                description: 'Short rationale shown to the user explaining why derivation was preferred over editing the original.',
                            },
                        },
                        required: ['new_name'],
                        additionalProperties: false,
                    },
                },
            }];
        },
        isToolName(name) {
            return String(name || '').trim() === MODEL_TOOLS.CLONE_TO_NEW;
        },
        async invoke(call) {
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            const requestedName = String(args.new_name || '').trim();
            if (!requestedName) {
                throw new Error('preset_clone_to_new requires new_name.');
            }
            const context = dialogState.context;
            if (!context?.presets || typeof context.presets.save !== 'function') {
                throw new Error('Preset persistence API is unavailable.');
            }
            const existingName = findCanonicalPresetName(getOpenAIPresetNames(context), requestedName);
            if (existingName) {
                throw new Error(`Preset already exists: ${existingName}. Retry with a different new_name.`);
            }
            const liveBody = isPlainObject(dialogState.liveSnapshot?.body)
                ? clone(dialogState.liveSnapshot.body, {})
                : {};

            const result = await context.presets.save(
                { collection: 'openai', name: requestedName },
                liveBody,
                { select: true },
            );
            if (!result?.ok || !result?.ref) {
                throw new Error('Failed to save the new preset.');
            }

            const previousTargetName = String(dialogState.targetRef?.name || '');
            dialogState.targetRef = clone(result.ref, null);
            dialogState.liveSnapshot = {
                ref: clone(result.ref, null),
                body: clone(result.body || liveBody, {}),
                source: 'live',
                selected: true,
                stored: true,
            };
            dialogState.session.draft = null;
            dialogState.sessionStore = await loadSessionStore(context, dialogState.targetRef);
            dialogState.journal = createEmptyJournal(dialogState.liveSnapshot.body);
            await persistDialogJournal(dialogState);
            await persistDialogSession(dialogState);

            return {
                ok: true,
                cloned_from: previousTargetName,
                new_preset: String(result.ref.name || requestedName),
                target_switched: true,
                draft_cleared: true,
            };
        },
    };
}

function getRequestPresetOptions() {
    const settings = getSettings();
    return {
        llmPresetName: String(settings.requestLlmPresetName || '').trim(),
        apiPresetName: String(settings.requestApiProfileName || '').trim(),
    };
}

function buildAssistantTools({
    hasReference = false,
    helperToolApis = [],
} = {}) {
    const tools = [
        {
            type: 'function',
            function: {
                name: MODEL_TOOLS.SET_FIELD,
                description: 'Set or replace one preset field using a lodash-style path. value_json must be valid JSON text.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        value_json: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['path', 'value_json'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: MODEL_TOOLS.REMOVE_FIELD,
                description: 'Remove one preset field using a lodash-style path.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['path'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: MODEL_TOOLS.UPSERT_PROMPT_ENTRY,
                description: 'Create or update one prompt entry in prompts by identifier. Prefer this over raw paths for prompt content edits.',
                parameters: {
                    type: 'object',
                    properties: {
                        identifier: { type: 'string' },
                        content: { type: 'string' },
                        role: { type: 'string' },
                        enabled: { type: 'boolean' },
                        name: { type: 'string' },
                        marker: { type: 'boolean' },
                        injection_position: { type: 'number' },
                        injection_depth: { type: 'number' },
                        injection_order: { type: 'number' },
                        reason: { type: 'string' },
                    },
                    required: ['identifier'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: MODEL_TOOLS.REMOVE_PROMPT_ENTRY,
                description: 'Remove one prompt entry from prompts by identifier.',
                parameters: {
                    type: 'object',
                    properties: {
                        identifier: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['identifier'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: MODEL_TOOLS.UPSERT_ORDER_ITEM,
                description: 'Insert or move one prompt_order item. position is 1-based within the target character_id group.',
                parameters: {
                    type: 'object',
                    properties: {
                        character_id: { type: 'string' },
                        identifier: { type: 'string' },
                        position: { type: 'integer' },
                        enabled: { type: 'boolean' },
                        reason: { type: 'string' },
                    },
                    required: ['character_id', 'identifier', 'position'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: MODEL_TOOLS.REMOVE_ORDER_ITEM,
                description: 'Remove one prompt_order item by character_id and identifier.',
                parameters: {
                    type: 'object',
                    properties: {
                        character_id: { type: 'string' },
                        identifier: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['character_id', 'identifier'],
                    additionalProperties: false,
                },
            },
        },
    ];

    for (const api of Array.isArray(helperToolApis) ? helperToolApis : []) {
        if (typeof api?.getToolDefs !== 'function') {
            continue;
        }
        tools.push(...api.getToolDefs());
    }

    if (hasReference) {
        tools.push({
            type: 'function',
            function: {
                name: MODEL_TOOLS.COPY_FROM_REFERENCE,
                description: 'Copy one field from the selected reference preset. Use from_path when source and target paths differ.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        from_path: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['path'],
                    additionalProperties: false,
                },
            },
        });
    }

    return tools;
}

function splitPresetAssistantToolCalls(rawCalls, helperToolApis = []) {
    const editCalls = [];
    const helperCalls = [];
    const apis = Array.isArray(helperToolApis) ? helperToolApis : [];
    for (const call of Array.isArray(rawCalls) ? rawCalls : []) {
        const name = String(call?.name || '').trim();
        if (!name) {
            continue;
        }
        if (apis.some(api => typeof api?.isToolName === 'function' && api.isToolName(name))) {
            helperCalls.push(call);
            continue;
        }
        editCalls.push(call);
    }
    return { editCalls, helperCalls };
}

async function runPresetAssistantHelperToolCall(call, helperToolApis = []) {
    const name = String(call?.name || '').trim();
    const api = (Array.isArray(helperToolApis) ? helperToolApis : [])
        .find(item => typeof item?.isToolName === 'function' && item.isToolName(name));
    if (!api) {
        throw new Error(`Unsupported helper tool: ${name}`);
    }
    return await api.invoke(call);
}

async function requestPresetAssistantReply(dialogState, userText, {
    requestOptions = null,
    historyMessages = [],
    abortSignal = null,
} = {}) {
    const options = requestOptions && typeof requestOptions === 'object' ? requestOptions : {};
    const helperToolApis = [
        createPresetAssistantLiveReadToolApi(dialogState),
        createPresetAssistantSimulateToolApi(dialogState),
        createPresetAssistantCloneToolApi(dialogState),
        ...(dialogState.referenceSnapshot ? [createPresetAssistantReferenceReadToolApi(dialogState)] : []),
        ...(dialogState.referenceSnapshot ? [createPresetAssistantReferenceDiffToolApi(dialogState)] : []),
    ];
    const modelTools = buildAssistantTools({
        hasReference: Boolean(dialogState.referenceSnapshot),
        helperToolApis,
    });
    const runtimeToolMessages = [];
    const helperTurnMessages = [];
    let lastAssistantText = '';

    for (let round = 1; ; round += 1) {
        throwIfAborted(abortSignal, 'Preset assistant request aborted.');
        const response = await requestToolCallsWithRetry(dialogState.context, getSettings(), {
            systemPrompt: buildModelSystemPrompt({
                hasReference: Boolean(dialogState.referenceSnapshot),
                mode: sanitizeSessionMode(dialogState.session?.mode),
            }),
            userPrompt: buildUserPrompt(dialogState, userText),
            historyMessages: [
                ...(Array.isArray(historyMessages) ? historyMessages.map(item => ({ ...item })) : []),
                ...runtimeToolMessages,
            ],
            apiPresetName: options.apiPresetName,
            promptPresetName: options.llmPresetName,
            tools: modelTools,
            abortSignal,
        });
        lastAssistantText = String(response?.assistantText || '').trim();
        const { editCalls, helperCalls } = splitPresetAssistantToolCalls(response?.toolCalls, helperToolApis);
        if (helperCalls.length === 0) {
            return {
                assistantText: lastAssistantText,
                toolCalls: editCalls,
                helperTurnMessages,
            };
        }

        const executedHelperCalls = [];
        for (const call of helperCalls) {
            throwIfAborted(abortSignal, 'Preset assistant request aborted.');
            const name = String(call?.name || '').trim();
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            const callId = String(call?.id || '').trim() || makeRuntimeToolCallId();
            try {
                const result = await runPresetAssistantHelperToolCall(call, helperToolApis);
                executedHelperCalls.push({
                    id: callId,
                    name,
                    args,
                    result: {
                        ok: true,
                        result,
                    },
                });
            } catch (error) {
                executedHelperCalls.push({
                    id: callId,
                    name,
                    args,
                    result: {
                        ok: false,
                        error: String(error?.message || error || 'helper tool failed'),
                    },
                });
            }
        }

        appendStandardToolRoundMessages(runtimeToolMessages, executedHelperCalls, lastAssistantText);
        helperTurnMessages.push(createPersistentToolTurnMessage({
            assistantText: lastAssistantText,
            toolCalls: executedHelperCalls.map((call) => ({
                id: call.id,
                name: call.name,
                args: call.args,
            })),
            toolResults: executedHelperCalls.map((call) => ({
                tool_call_id: String(call?.id || '').trim(),
                content: serializeToolResultContent(call?.result),
            })),
            toolSummary: buildToolCallSummary(buildPersistentToolCallsFromRawCalls(executedHelperCalls)),
            toolState: 'completed',
        }));
    }

}

async function requestToolCallsWithRetry(context, settings, {
    systemPrompt = '',
    userPrompt = '',
    historyMessages = null,
    apiPresetName = '',
    promptPresetName = '',
    tools = [],
    abortSignal = null,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('Tools are required.');
    }
    if (!context || typeof context.generateTask !== 'function') {
        throw new Error('context.generateTask is unavailable.');
    }

    const systemText = String(systemPrompt || '').trim();
    const userText = String(userPrompt || '').trim();
    const taskMessages = [
        ...(Array.isArray(historyMessages) ? historyMessages.map(item => ({ ...item })) : []),
        { role: 'system', content: systemText },
        { role: 'user', content: userText },
    ].filter(item => item && typeof item === 'object' && item.content);

    const worldInfoSource = settings?.includeWorldInfo === false ? 'none' : 'chat';

    const retries = Math.max(0, Math.min(TOOL_CALL_RETRY_MAX, toInteger(settings?.toolCallRetryMax, defaultSettings.toolCallRetryMax)));
    const allowedNames = new Set(tools.map(item => String(item?.function?.name || '').trim()).filter(Boolean));
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            throwIfAborted(abortSignal, 'Preset assistant request aborted.');
            const generateTaskOpts = {
                taskMessages,
                includeCharacterCard: true,
                worldInfoSource,
                apiPresetName: String(apiPresetName || '').trim(),
                llmPresetName: String(promptPresetName || '').trim(),
                tools,
                toolChoice: 'auto',
                functionCallMode: 'auto',
                functionCallOptions: {
                    protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
                },
                abortSignal: abortSignal || undefined,
                // Authoring scope: preset bodies handed to the AI for editing
                // contain literal {{...}} placeholders that must not resolve
                // before the AI sees them.
                substituteMacros: false,
            };
            const result = settings?.useStreamingTransport
                ? await context.generateTaskStream(generateTaskOpts).result
                : await context.generateTask(generateTaskOpts);
            throwIfAborted(abortSignal, 'Preset assistant request aborted.');
            const rawCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
            const normalizedCalls = rawCalls.map((call) => {
                const rawId = String(call?.raw?.id || '').trim();
                return {
                    id: rawId || makeRuntimeToolCallId(),
                    name: String(call?.name || '').trim(),
                    args: call?.args && typeof call.args === 'object' ? call.args : {},
                    raw: call?.raw || null,
                };
            });
            const filteredCalls = allowedNames.size > 0
                ? normalizedCalls.filter(call => allowedNames.has(call.name))
                : normalizedCalls;
            const validationError = validateParsedToolCalls(filteredCalls, tools);
            if (validationError) {
                throw new Error(validationError);
            }
            return {
                assistantText: String(result?.assistantText || ''),
                toolCalls: filteredCalls,
            };
        } catch (error) {
            if (isAbortError(error, abortSignal)) {
                throw error;
            }
            lastError = error;
            if (attempt >= retries) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] Preset tool call request failed. Retrying (${attempt + 1}/${retries})...`, error);
        }
    }

    if (lastError) {
        throw lastError;
    }

    return {
        assistantText: '',
        toolCalls: [],
    };
}

function findPromptEntryIndex(prompts, identifier) {
    return (Array.isArray(prompts) ? prompts : []).findIndex((entry) => normalizePromptIdentifier(entry?.identifier, entry?.id) === identifier);
}

function upsertPromptEntryInBody(body, edit) {
    const identifier = normalizePromptIdentifier(edit?.identifier);
    if (!identifier) {
        throw new Error('Prompt identifier is required.');
    }
    if (!Array.isArray(body.prompts)) {
        body.prompts = [];
    }
    const promptIndex = findPromptEntryIndex(body.prompts, identifier);
    const current = promptIndex >= 0 && body.prompts[promptIndex] && typeof body.prompts[promptIndex] === 'object'
        ? clone(body.prompts[promptIndex], {})
        : { identifier };
    const next = {
        ...current,
        identifier,
    };
    if (Object.hasOwn(edit, 'content')) {
        next.content = String(edit.content ?? '');
    }
    if (Object.hasOwn(edit, 'role')) {
        next.role = String(edit.role ?? '').trim();
    }
    if (Object.hasOwn(edit, 'enabled')) {
        next.enabled = Boolean(edit.enabled);
    }
    if (Object.hasOwn(edit, 'name')) {
        next.name = String(edit.name ?? '').trim();
    }
    if (Object.hasOwn(edit, 'marker')) {
        next.marker = Boolean(edit.marker);
    }
    if (Object.hasOwn(edit, 'injection_position')) {
        next.injection_position = edit.injection_position;
    }
    if (Object.hasOwn(edit, 'injection_depth')) {
        next.injection_depth = edit.injection_depth;
    }
    if (Object.hasOwn(edit, 'injection_order')) {
        next.injection_order = edit.injection_order;
    }
    if (promptIndex >= 0) {
        body.prompts[promptIndex] = next;
        return;
    }
    if (!Object.hasOwn(next, 'content')) {
        throw new Error(`New prompt entry ${identifier} requires content.`);
    }
    body.prompts.push(next);
}

function removePromptEntryFromBody(body, identifier) {
    const safeIdentifier = normalizePromptIdentifier(identifier);
    if (!safeIdentifier) {
        return;
    }
    if (Array.isArray(body.prompts)) {
        body.prompts = body.prompts.filter((entry) => normalizePromptIdentifier(entry?.identifier, entry?.id) !== safeIdentifier);
    }
    if (Array.isArray(body.prompt_order)) {
        body.prompt_order = body.prompt_order
            .map((group) => {
                const nextGroup = group && typeof group === 'object' ? clone(group, {}) : {};
                nextGroup.order = Array.isArray(nextGroup.order)
                    ? nextGroup.order.filter((item) => normalizePromptIdentifier(item?.identifier) !== safeIdentifier)
                    : [];
                return nextGroup;
            })
            .filter((group) => Array.isArray(group?.order) ? group.order.length > 0 : true);
    }
}

function getOrCreatePromptOrderGroup(body, characterId) {
    const safeCharacterId = String(characterId ?? '').trim();
    if (!safeCharacterId) {
        throw new Error('character_id is required for prompt order edits.');
    }
    if (!Array.isArray(body.prompt_order)) {
        body.prompt_order = [];
    }
    let group = body.prompt_order.find((entry) => String(entry?.character_id ?? '').trim() === safeCharacterId);
    if (group && typeof group === 'object') {
        if (!Array.isArray(group.order)) {
            group.order = [];
        }
        return group;
    }
    group = {
        character_id: safeCharacterId,
        order: [],
    };
    body.prompt_order.push(group);
    return group;
}

function upsertPromptOrderItemInBody(body, edit) {
    const characterId = String(edit?.character_id ?? '').trim();
    const identifier = normalizePromptIdentifier(edit?.identifier);
    const rawPosition = Number(edit?.position);
    if (!characterId || !identifier || !Number.isInteger(rawPosition) || rawPosition < 1) {
        throw new Error('character_id, identifier, and 1-based position are required for prompt order edits.');
    }
    const group = getOrCreatePromptOrderGroup(body, characterId);
    const nextOrder = Array.isArray(group.order)
        ? group.order.filter((item) => normalizePromptIdentifier(item?.identifier) !== identifier)
        : [];
    const enabled = Object.hasOwn(edit, 'enabled') ? Boolean(edit.enabled) : true;
    const targetIndex = Math.max(0, Math.min(nextOrder.length, rawPosition - 1));
    nextOrder.splice(targetIndex, 0, {
        identifier,
        enabled,
    });
    group.order = nextOrder;
}

function removePromptOrderItemFromBody(body, characterId, identifier) {
    const safeCharacterId = String(characterId ?? '').trim();
    const safeIdentifier = normalizePromptIdentifier(identifier);
    if (!safeCharacterId || !safeIdentifier || !Array.isArray(body.prompt_order)) {
        return;
    }
    body.prompt_order = body.prompt_order
        .map((group) => {
            if (String(group?.character_id ?? '').trim() !== safeCharacterId) {
                return group;
            }
            const nextGroup = group && typeof group === 'object' ? clone(group, {}) : { character_id: safeCharacterId };
            nextGroup.order = Array.isArray(nextGroup.order)
                ? nextGroup.order.filter((item) => normalizePromptIdentifier(item?.identifier) !== safeIdentifier)
                : [];
            return nextGroup;
        })
        .filter((group) => Array.isArray(group?.order) ? group.order.length > 0 : true);
}

function normalizeEditPath(path) {
    return String(path || '').trim();
}

function normalizeToolCallToEdit(call) {
    const name = String(call?.name || '').trim();
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const reason = String(args.reason || '').trim();

    if (name === MODEL_TOOLS.SET_FIELD) {
        const path = normalizeEditPath(args.path);
        if (!path) {
            return null;
        }
        const rawJson = String(args.value_json || '').trim();
        if (!rawJson) {
            throw new Error(`Missing value_json for ${path}`);
        }
        let value;
        try {
            value = JSON.parse(rawJson);
        } catch (error) {
            throw new Error(`Invalid JSON for ${path}: ${error?.message || error}`);
        }
        return { kind: 'set', path, value, reason };
    }

    if (name === MODEL_TOOLS.REMOVE_FIELD) {
        const path = normalizeEditPath(args.path);
        if (!path) {
            return null;
        }
        return { kind: 'remove', path, fromPath: '', reason };
    }

    if (name === MODEL_TOOLS.COPY_FROM_REFERENCE) {
        const path = normalizeEditPath(args.path);
        if (!path) {
            return null;
        }
        return {
            kind: 'copy',
            path,
            fromPath: normalizeEditPath(args.from_path) || path,
            reason,
        };
    }

    if (name === MODEL_TOOLS.UPSERT_PROMPT_ENTRY) {
        const identifier = normalizePromptIdentifier(args.identifier);
        if (!identifier) {
            return null;
        }
        const edit = {
            kind: 'upsert_prompt_entry',
            identifier,
            reason,
        };
        for (const key of ['content', 'role', 'name']) {
            if (Object.hasOwn(args, key)) {
                edit[key] = args[key];
            }
        }
        for (const key of ['enabled', 'marker', 'injection_position', 'injection_depth', 'injection_order']) {
            if (Object.hasOwn(args, key)) {
                edit[key] = args[key];
            }
        }
        return edit;
    }

    if (name === MODEL_TOOLS.REMOVE_PROMPT_ENTRY) {
        const identifier = normalizePromptIdentifier(args.identifier);
        return identifier ? { kind: 'remove_prompt_entry', identifier, reason } : null;
    }

    if (name === MODEL_TOOLS.UPSERT_ORDER_ITEM) {
        const identifier = normalizePromptIdentifier(args.identifier);
        const characterId = String(args.character_id ?? '').trim();
        const position = Number(args.position);
        if (!identifier || !characterId || !Number.isInteger(position) || position < 1) {
            return null;
        }
        return {
            kind: 'upsert_order_item',
            identifier,
            character_id: characterId,
            position,
            enabled: Object.hasOwn(args, 'enabled') ? Boolean(args.enabled) : true,
            reason,
        };
    }

    if (name === MODEL_TOOLS.REMOVE_ORDER_ITEM) {
        const identifier = normalizePromptIdentifier(args.identifier);
        const characterId = String(args.character_id ?? '').trim();
        if (!identifier || !characterId) {
            return null;
        }
        return {
            kind: 'remove_order_item',
            identifier,
            character_id: characterId,
            reason,
        };
    }

    return null;
}

function applyEditsToPreset(baseBody, edits, referenceBody = null) {
    const draftBody = clone(isPlainObject(baseBody) ? baseBody : {}, {});
    const safeReferenceBody = isPlainObject(referenceBody) ? referenceBody : null;

    for (const rawEdit of edits) {
        const edit = sanitizeEdit(rawEdit);
        if (!edit) {
            continue;
        }

        if (edit.kind === 'set') {
            lodash.set(draftBody, edit.path, clone(edit.value, edit.value));
            continue;
        }

        if (edit.kind === 'remove') {
            lodash.unset(draftBody, edit.path);
            continue;
        }

        if (edit.kind === 'copy') {
            if (!safeReferenceBody) {
                throw new Error('Reference preset is required for copy operations.');
            }
            const sourceValue = lodash.get(safeReferenceBody, edit.fromPath || edit.path);
            if (sourceValue === undefined) {
                throw new Error(`Reference path not found: ${edit.fromPath || edit.path}`);
            }
            lodash.set(draftBody, edit.path, clone(sourceValue, sourceValue));
            continue;
        }

        if (edit.kind === 'upsert_prompt_entry') {
            upsertPromptEntryInBody(draftBody, edit);
            continue;
        }

        if (edit.kind === 'remove_prompt_entry') {
            removePromptEntryFromBody(draftBody, edit.identifier);
            continue;
        }

        if (edit.kind === 'upsert_order_item') {
            upsertPromptOrderItemInBody(draftBody, edit);
            continue;
        }

        if (edit.kind === 'remove_order_item') {
            removePromptOrderItemFromBody(draftBody, edit.character_id, edit.identifier);
        }
    }

    return draftBody;
}

function renderDeltaHtml(before, after) {
    const beforeProjection = buildPresetDiffProjection(before);
    const afterProjection = buildPresetDiffProjection(after);
    const delta = diffPatcher.diff(clone(beforeProjection, {}), clone(afterProjection, {}));
    if (!delta) {
        return '';
    }

    return DOMPurify.sanitize(renderObjectDiffHtml({
        before: clone(beforeProjection, {}),
        after: clone(afterProjection, {}),
        delta,
        beforeLabel: i18n('Before'),
        afterLabel: i18n('After'),
        missingLabel: i18n('(missing)'),
        pathLabelFormatter: formatPresetDiffPath,
    }));
}

function describeEdit(edit) {
    const safeEdit = sanitizeEdit(edit);
    if (!safeEdit) {
        return '';
    }

    if (safeEdit.kind === 'set') {
        return `${safeEdit.path} <- set`;
    }

    if (safeEdit.kind === 'remove') {
        return `${safeEdit.path} <- remove`;
    }

    if (safeEdit.kind === 'upsert_prompt_entry') {
        return `prompt ${safeEdit.identifier} <- upsert`;
    }

    if (safeEdit.kind === 'remove_prompt_entry') {
        return `prompt ${safeEdit.identifier} <- remove`;
    }

    if (safeEdit.kind === 'upsert_order_item') {
        return `prompt_order ${safeEdit.character_id}:${safeEdit.identifier} <- position ${safeEdit.position}`;
    }

    if (safeEdit.kind === 'remove_order_item') {
        return `prompt_order ${safeEdit.character_id}:${safeEdit.identifier} <- remove`;
    }

    return `${safeEdit.path} <- copy ${safeEdit.fromPath || safeEdit.path}`;
}

function buildDraftFromResponse(dialogState, assistantText, toolCalls, sourceMessageId = '') {
    const edits = toolCalls
        .map(call => normalizeToolCallToEdit(call))
        .filter(Boolean);
    if (edits.length === 0) {
        return null;
    }

    const draftBody = applyEditsToPreset(
        dialogState.liveSnapshot?.body || {},
        edits,
        dialogState.referenceSnapshot?.body || null,
    );
    if (arePresetBodiesEquivalent(dialogState.liveSnapshot?.body || {}, draftBody)) {
        return null;
    }

    return {
        summary: String(assistantText || '').trim() || i18nFormat('Proposed edits: ${0}', edits.length),
        assistantText: String(assistantText || '').trim(),
        edits,
        draftBody,
        createdAt: Date.now(),
        referencePresetName: String(dialogState.session?.referencePresetName || '').trim(),
        sourceMessageId: String(sourceMessageId || '').trim(),
    };
}

function renderPresetToolTraceHtml(message) {
    const toolCalls = normalizePersistentToolCalls(message);
    const toolResults = normalizePersistentToolResults(message, toolCalls);
    if (toolCalls.length === 0) {
        return '';
    }
    const resultMap = new Map(toolResults.map((item) => [String(item?.tool_call_id || '').trim(), String(item?.content || '')]));
    return `
<details class="luker-studio-tool-trace">
    <summary>${escapeHtml(i18nFormat('Tool calls (${0})', toolCalls.length))}</summary>
    <div class="luker-studio-tool-trace-list">
        ${toolCalls.map((call) => {
        const result = resultMap.get(String(call?.id || '').trim()) || '';
        return `
<div class="luker-studio-tool-trace-item">
    <div class="luker-studio-tool-trace-name">${escapeHtml(String(call?.function?.name || 'tool'))}</div>
    <pre>${escapeHtml(String(call?.function?.arguments || '{}'))}</pre>
    ${result ? `<details class="luker-studio-tool-trace-result"><summary>${escapeHtml(i18n('Tool result'))}</summary><pre>${escapeHtml(result)}</pre></details>` : ''}
</div>`;
    }).join('')}
    </div>
</details>`;
}

function renderMessageHtml(message, {
    commitCount = 0,
} = {}) {
    const safeMessage = sanitizeMessage(message);
    const roleLabel = safeMessage.role === 'user'
        ? i18n('User')
        : (safeMessage.role === 'assistant' ? i18n('Assistant') : i18n('System'));
    const note = safeMessage.summary
        ? `<div class="luker-studio-msg-note">${escapeHtml(safeMessage.summary)}</div>`
        : (safeMessage.editCount > 0 ? `<div class="luker-studio-msg-note">${escapeHtml(i18nFormat('Proposed edits: ${0}', safeMessage.editCount))}</div>` : '');
    const toolSummary = safeMessage.toolSummary
        ? `<div class="luker-studio-msg-note">${escapeHtml(safeMessage.toolSummary)}</div>`
        : '';
    const commitBadge = safeMessage.role === 'assistant' && commitCount > 0
        ? `<span class="luker-studio-msg-badge">${escapeHtml(i18n('Applied'))}</span>`
        : '';
    const actions = safeMessage.role === 'assistant' && commitCount > 0
        ? `
<div class="luker-studio-msg-actions">
    <div class="menu_button menu_button_small" data-cpa-action="show-message-diff" data-cpa-message-id="${escapeHtml(safeMessage.id)}">${escapeHtml(i18n('Applied diff'))}</div>
    <div class="menu_button menu_button_small" data-cpa-action="rollback-to-message" data-cpa-message-id="${escapeHtml(safeMessage.id)}">${escapeHtml(i18n('Rollback to here'))}</div>
</div>`
        : '';

    return `
<div class="luker-studio-msg" data-role="${escapeHtml(safeMessage.role)}">
    <div class="luker-studio-msg-head">
        <span class="luker-studio-msg-head-group">${escapeHtml(roleLabel)}${commitBadge}</span>
        <span>${escapeHtml(new Date(safeMessage.createdAt).toLocaleString())}</span>
    </div>
    <div class="luker-studio-msg-body">${escapeHtml(safeMessage.text || safeMessage.summary || '')}</div>
    ${note}
    ${toolSummary}
    ${renderPresetToolTraceHtml(safeMessage)}
    ${actions}
</div>`;
}

function renderPresetConversationHistoryItems(sessionStore, currentSessionId = '') {
    const currentId = String(currentSessionId || '').trim();
    const items = (Array.isArray(sessionStore?.sessions) ? sessionStore.sessions : [])
        .slice()
        .sort((left, right) => Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0));
    const toolbar = `
<div class="luker-studio-history-toolbar">
    <div class="menu_button menu_button_small" data-cpa-history-action="new-session">${escapeHtml(i18n('New session'))}</div>
</div>`;
    if (items.length === 0) {
        return `${toolbar}<div class="luker-studio-empty">${escapeHtml(i18n('No conversation history yet.'))}</div>`;
    }
    return `${toolbar}${items.map((item) => {
        const sessionId = String(item?.id || '').trim();
        const isCurrent = sessionId && sessionId === currentId;
        const summary = summarizePresetConversationSession(item, sessionId) || sessionId;
        const messageCount = Array.isArray(item?.messages) ? item.messages.length : 0;
        const pending = item?.draft ? ` · ${escapeHtml(i18n('Draft ready'))}` : '';
        return `
<div class="luker-studio-history-item${isCurrent ? ' active' : ''}">
    <div class="luker-studio-history-item-main">
        <div class="luker-studio-history-item-summary">${escapeHtml(summary)}${isCurrent ? ` <span class="luker-studio-history-item-current">${escapeHtml(i18n('Current'))}</span>` : ''}</div>
        <div class="luker-studio-history-item-time">${escapeHtml(new Date(Number(item?.updatedAt || Date.now())).toLocaleString())} · ${escapeHtml(String(messageCount))} msgs${pending}</div>
    </div>
    <div class="luker-studio-history-item-actions">
        ${!isCurrent ? `<div class="menu_button menu_button_small" data-cpa-history-action="load-session" data-cpa-session-id="${escapeHtml(sessionId)}">${escapeHtml(i18n('Load session'))}</div>` : ''}
        <div class="menu_button menu_button_small" data-cpa-history-action="delete-session" data-cpa-session-id="${escapeHtml(sessionId)}">${escapeHtml(i18n('Delete'))}</div>
    </div>
</div>`;
    }).join('')}`;
}

function renderConversationHtml(session, journal) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    if (messages.length === 0) {
        return `<div class="luker-studio-empty">${escapeHtml(i18n('No conversation yet.'))}</div>`;
    }
    const commitMap = getCommittedMessageEntryMap(session, journal);
    return messages.map((item) => renderMessageHtml(item, {
        commitCount: commitMap.get(String(item?.id || '').trim()) || 0,
    })).join('');
}

function renderDraftHtml(dialogState) {
    const draft = sanitizeDraft(dialogState.session?.draft);
    if (!draft) {
        return `<div class="luker-studio-empty">${escapeHtml(i18n('No draft yet. Ask the assistant to propose changes first.'))}</div>`;
    }

    const diffHtml = renderDeltaHtml(dialogState.liveSnapshot?.body || {}, draft.draftBody || {});
    const editItems = draft.edits.map((edit) => `<li>${escapeHtml(describeEdit(edit))}</li>`).join('');
    return `
<div class="luker-studio-draft-summary">
    <div class="luker-studio-draft-badge">${escapeHtml(i18n('Draft ready'))}</div>
    <div class="luker-studio-draft-badge">${escapeHtml(i18nFormat('Proposed edits: ${0}', draft.edits.length))}</div>
</div>
<div>${escapeHtml(draft.summary || i18n('Change summary'))}</div>
<div class="luker-studio-draft-actions">
    <div class="menu_button menu_button_small" data-cpa-action="apply-draft">${escapeHtml(i18n('Apply draft'))}</div>
    <div class="menu_button menu_button_small" data-cpa-action="discard-draft">${escapeHtml(i18n('Discard draft'))}</div>
</div>
<div class="luker-studio-diff">${diffHtml || `<div class="luker-studio-empty">${escapeHtml(i18n('No diff to display.'))}</div>`}</div>
<details>
    <summary>${escapeHtml(i18n('Change summary'))}</summary>
    <ul>${editItems || `<li>${escapeHtml(i18n('No meaningful changes detected.'))}</li>`}</ul>
</details>`;
}

function appendSessionMessage(session, message) {
    const settings = getSettings();
    const messages = Array.isArray(session?.messages) ? session.messages.slice() : [];
    messages.push(sanitizeMessage(message));
    return {
        ...session,
        messages: messages.slice(-settings.sessionMessageLimit),
    };
}

function replaceSessionMessage(session, messageId, updater) {
    const safeMessageId = String(messageId || '').trim();
    if (!safeMessageId || typeof updater !== 'function') {
        return sanitizeSession(session);
    }
    const nextSession = sanitizeSession(session);
    nextSession.messages = nextSession.messages.map((message) => {
        if (String(message?.id || '').trim() !== safeMessageId) {
            return message;
        }
        return sanitizeMessage(updater(clone(message, {})) || message);
    });
    return nextSession;
}

async function refreshReferenceSnapshot(dialogState) {
    const referenceName = String(dialogState.session?.referencePresetName || '').trim();
    if (!referenceName) {
        dialogState.referenceSnapshot = null;
        return;
    }

    const snapshot = dialogState.context.presets.getStored({
        collection: 'openai',
        name: referenceName,
    });
    dialogState.referenceSnapshot = snapshot && typeof snapshot === 'object' ? clone(snapshot, null) : null;
}

function getPresetSelectionDriftMessage() {
    return i18n('Selected preset changed outside the assistant. Reopen the assistant on the desired preset.');
}

function getPresetEventCollection(event = null) {
    return String(event?.collection || event?.apiId || '').trim();
}

async function readValidatedLiveSnapshot(dialogState) {
    const currentTargetRef = getCurrentTargetRef(dialogState.context);
    const currentLiveSnapshot = getCurrentLiveSnapshot(dialogState.context);
    if (!currentTargetRef || !currentLiveSnapshot?.stored) {
        throw new Error(i18n('Current preset is not a stored chat completion preset. Please select a saved preset first.'));
    }
    if (
        currentTargetRef.collection !== dialogState.targetRef?.collection
        || currentTargetRef.name !== dialogState.targetRef?.name
    ) {
        throw new Error(getPresetSelectionDriftMessage());
    }
    return clone(currentLiveSnapshot, null);
}

async function refreshLiveSnapshot(dialogState) {
    dialogState.liveSnapshot = await readValidatedLiveSnapshot(dialogState);
    dialogState.journal = ensureJournalBaseSnapshot(dialogState.journal, dialogState.liveSnapshot?.body || {});
    return dialogState.liveSnapshot;
}

async function persistDialogSession(dialogState) {
    const saved = await savePresetConversationSession(dialogState.context, dialogState.targetRef, dialogState.session, {
        store: dialogState.sessionStore,
        setCurrent: true,
    });
    dialogState.session = saved.session;
    dialogState.sessionStore = saved.store;
    dialogState.currentSessionId = String(saved.session?.id || '').trim();
}

async function persistDialogJournal(dialogState) {
    dialogState.journal = await saveJournal(dialogState.context, dialogState.targetRef, dialogState.journal);
}

async function handleReferenceChange(dialogState, selectValue) {
    dialogState.session.referencePresetName = String(selectValue || '').trim();
    await refreshReferenceSnapshot(dialogState);
    await persistDialogSession(dialogState);
    await rerenderDialog(dialogState);
}

async function showDiffPopup(title, beforeLabel, afterLabel, beforeBody, afterBody) {
    const diffHtml = renderDeltaHtml(beforeBody, afterBody);
    const content = `
<div class="luker-studio">
    <div class="luker-studio-meta">
        <div class="luker-studio-meta-item">${escapeHtml(beforeLabel)}</div>
        <div class="luker-studio-meta-item">${escapeHtml(afterLabel)}</div>
    </div>
    <div class="luker-studio-diff">${diffHtml || `<div class="luker-studio-empty">${escapeHtml(i18n('No diff to display.'))}</div>`}</div>
</div>`;
    const popup = new Popup(content, POPUP_TYPE.TEXT, title, {
        okButton: false,
        cancelButton: 'Close',
        wider: true,
        allowVerticalScrolling: true,
    });
    await popup.show();
}

async function handleReferenceDiff(dialogState) {
    if (!dialogState.referenceSnapshot) {
        toastr.info(i18n('No reference diff available.'));
        return;
    }
    await showDiffPopup(
        i18nFormat('Reference diff: ${0} -> ${1}', dialogState.targetRef.name, dialogState.referenceSnapshot.ref.name),
        dialogState.targetRef.name,
        dialogState.referenceSnapshot.ref.name,
        dialogState.liveSnapshot?.body || {},
        dialogState.referenceSnapshot.body || {},
    );
}

async function handleMessageDiff(dialogState, messageId) {
    const diffPlan = buildMessageDiffPlan(dialogState.session, dialogState.journal, messageId);
    if (!diffPlan) {
        toastr.info(i18n('No applied changes for this message.'));
        return;
    }
    await showDiffPopup(
        i18n('Applied diff'),
        i18n('Previous version'),
        i18n('Applied version'),
        diffPlan.beforeBody || {},
        diffPlan.afterBody || {},
    );
}

async function handleDiscardDraft(dialogState, { silent = false } = {}) {
    const draft = sanitizeDraft(dialogState.session?.draft);
    if (!draft) {
        return;
    }
    if (!silent) {
        const confirmed = await Popup.show.confirm(i18n('Discard current draft?'), '');
        if (!confirmed) {
            return;
        }
    }
    if (draft.sourceMessageId) {
        dialogState.session = replaceSessionMessage(dialogState.session, draft.sourceMessageId, (message) => ({
            ...message,
            tool_results: buildRejectedToolResults(normalizePersistentToolCalls(message), i18n('Draft discarded.')),
            toolSummary: i18n('Draft discarded.'),
            toolState: 'rejected',
        }));
    }
    dialogState.session.draft = null;
    dialogState.status = i18n('Draft discarded.');
    await persistDialogSession(dialogState);
    await rerenderDialog(dialogState);
}

async function handleClearHistory(dialogState) {
    const confirmed = await Popup.show.confirm(i18n('Clear this preset assistant history and draft?'), '');
    if (!confirmed) {
        return;
    }
    try {
        await refreshLiveSnapshot(dialogState);
        dialogState.session = createEmptySession();
        dialogState.sessionStore = createEmptySessionStore();
        dialogState.currentSessionId = dialogState.session.id;
        dialogState.journal = createEmptyJournal(dialogState.liveSnapshot?.body || {});
        dialogState.referenceSnapshot = null;
        dialogState.status = i18n('Session history cleared.');
        await persistDialogJournal(dialogState);
        await persistDialogSession(dialogState);
    } catch (error) {
        dialogState.status = String(error?.message || error || '');
    }
    await rerenderDialog(dialogState);
}

function describeSessionMode(mode) {
    const safeMode = sanitizeSessionMode(mode);
    if (safeMode === 'orchestrator-optimize') return i18n('Optimize for orchestrator');
    if (safeMode === 'jailbreak-only') return i18n('Jailbreak-only');
    return i18n('General editing');
}

function renderModeSelectOptions(currentMode) {
    const sanitized = sanitizeSessionMode(currentMode);
    return SESSION_MODES.map((value) => {
        const selected = value === sanitized ? ' selected' : '';
        return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(describeSessionMode(value))}</option>`;
    }).join('');
}

async function pickSessionMode() {
    let chosen = SESSION_MODE_DEFAULT;
    const html = `
<div class="cpa_mode_picker">
    <div class="cpa_mode_picker_title">${escapeHtml(i18n('Session mode'))}</div>
    <select id="cpa_new_session_mode" class="text_pole">
        <option value="general" selected>${escapeHtml(i18n('General editing'))}</option>
        <option value="orchestrator-optimize">${escapeHtml(i18n('Optimize for orchestrator'))}</option>
        <option value="jailbreak-only">${escapeHtml(i18n('Jailbreak-only'))}</option>
    </select>
    <div class="cpa_mode_picker_hint">${escapeHtml(i18n('Mode is fixed for the lifetime of the session. To switch modes, start a new session.'))}</div>
</div>`;
    const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: i18n('Start new session'),
        cancelButton: i18n('Cancel'),
        onClosing: (p) => {
            const sel = p.dlg?.querySelector('#cpa_new_session_mode');
            if (sel) {
                chosen = sanitizeSessionMode(sel.value);
            }
            return true;
        },
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }
    return chosen;
}

async function handleModeChange(dialogState, requestedMode) {
    if (dialogState.busy) {
        await rerenderDialog(dialogState);
        return;
    }
    const sanitized = sanitizeSessionMode(requestedMode);
    const currentMode = sanitizeSessionMode(dialogState.session?.mode);
    if (sanitized === currentMode) {
        return;
    }
    const confirmed = await Popup.show.confirm(
        i18n('Switching session mode starts a new session. Continue?'),
        '',
    );
    if (!confirmed) {
        await rerenderDialog(dialogState);
        return;
    }
    await handleNewSession(dialogState, { mode: sanitized });
}

async function handleNewSessionWithModePicker(dialogState) {
    if (dialogState.busy) {
        return;
    }
    const mode = await pickSessionMode();
    if (!mode) {
        return;
    }
    await handleNewSession(dialogState, { mode });
}

async function handleNewSession(dialogState, { mode = SESSION_MODE_DEFAULT } = {}) {
    if (dialogState.busy) {
        return;
    }
    const saved = await savePresetConversationSession(
        dialogState.context,
        dialogState.targetRef,
        createEmptySession({ mode }),
        {
            store: dialogState.sessionStore,
            setCurrent: true,
        },
    );
    dialogState.session = saved.session;
    dialogState.sessionStore = saved.store;
    dialogState.currentSessionId = String(saved.session?.id || '').trim();
    dialogState.referenceSnapshot = null;
    dialogState.inputText = '';
    dialogState.status = i18n('New session');
    await rerenderDialog(dialogState);
}

async function handleLoadSession(dialogState, sessionId) {
    if (dialogState.busy) {
        return;
    }
    const safeSessionId = String(sessionId || '').trim();
    if (!safeSessionId) {
        return;
    }
    const loaded = findPresetConversationSession(dialogState.sessionStore, safeSessionId);
    if (!loaded) {
        throw new Error('Session not found.');
    }
    dialogState.sessionStore = await setCurrentPresetConversationSessionId(
        dialogState.context,
        dialogState.targetRef,
        dialogState.sessionStore,
        safeSessionId,
    );
    dialogState.currentSessionId = safeSessionId;
    dialogState.session = sanitizeSession(loaded);
    dialogState.referenceSnapshot = null;
    dialogState.inputText = '';
    await refreshReferenceSnapshot(dialogState);
    dialogState.status = i18n('Session loaded.');
    await rerenderDialog(dialogState);
}

async function handleDeleteSession(dialogState, sessionId) {
    if (dialogState.busy) {
        return;
    }
    const safeSessionId = String(sessionId || '').trim();
    if (!safeSessionId) {
        return;
    }
    const confirmed = await Popup.show.confirm(i18n('Delete this conversation session?'), '');
    if (!confirmed) {
        return;
    }

    let nextStore = await deletePresetConversationSessionById(dialogState.context, dialogState.targetRef, safeSessionId);
    let nextSession = getPreferredPresetConversationSession(nextStore);
    if (!nextSession) {
        const saved = await savePresetConversationSession(
            dialogState.context,
            dialogState.targetRef,
            createEmptySession(),
            {
                store: nextStore,
                setCurrent: true,
            },
        );
        nextStore = saved.store;
        nextSession = saved.session;
    }

    dialogState.sessionStore = nextStore;
    dialogState.currentSessionId = String(nextSession?.id || '').trim();
    dialogState.session = sanitizeSession(nextSession);
    dialogState.referenceSnapshot = null;
    dialogState.inputText = '';
    await refreshReferenceSnapshot(dialogState);
    dialogState.status = i18n('Conversation session deleted.');
    await rerenderDialog(dialogState);
}

async function handleApplyDraft(dialogState) {
    const draft = sanitizeDraft(dialogState.session?.draft);
    if (!draft) {
        return;
    }
    dialogState.busy = true;
    dialogState.status = i18n('Applying draft...');
    await rerenderDialog(dialogState);
    try {
        const currentLiveSnapshot = await readValidatedLiveSnapshot(dialogState);
        dialogState.journal = ensureJournalBaseSnapshot(dialogState.journal, currentLiveSnapshot.body || {});
        if (!arePresetBodiesEquivalent(currentLiveSnapshot.body || {}, dialogState.liveSnapshot?.body || {})) {
            throw new Error(i18n('Current live preset changed since this draft was created. Refresh live and request a new draft.'));
        }
        if (!journalMatchesLive(dialogState.journal, currentLiveSnapshot.body || {})) {
            throw new Error(i18n('Current live preset no longer matches assistant history. Clear history before applying or rolling back more changes.'));
        }
        const sourceMessageId = getDraftSourceMessageId(dialogState.session, draft);
        if (!sourceMessageId) {
            throw new Error(i18n('Current live preset no longer matches assistant history. Clear history before applying or rolling back more changes.'));
        }
        const delta = buildJsonStateDelta(diffPatcher, currentLiveSnapshot.body || {}, draft.draftBody || {});
        if (!delta) {
            dialogState.session.draft = null;
            dialogState.status = i18n('No meaningful changes detected.');
            await persistDialogSession(dialogState);
            return;
        }
        const result = await dialogState.context.presets.save(
            { collection: 'openai', name: dialogState.targetRef.name },
            draft.draftBody,
            { select: true },
        );
        if (!result?.ok) {
            throw new Error(i18n('Save failed.'));
        }
        dialogState.journal = {
            ...dialogState.journal,
            entries: [
                ...getJournalEntries(dialogState.journal),
                sanitizeJournalEntry({
                    id: uuidv4(),
                    sessionId: dialogState.session.id,
                    messageId: sourceMessageId,
                    delta,
                    touchedPaths: extractJsonStateTouchedPaths(delta),
                }),
            ].filter(Boolean),
        };
        await refreshLiveSnapshot(dialogState);
        dialogState.session = replaceSessionMessage(dialogState.session, sourceMessageId, (message) => ({
            ...message,
            tool_results: buildAppliedToolResults(normalizePersistentToolCalls(message), i18n('Applied draft to preset.')),
            toolSummary: i18nFormat('Applied preset edits: ${0}', draft.edits.length),
            toolState: 'completed',
        }));
        dialogState.session.draft = null;
        dialogState.status = i18n('Applied draft to preset.');
        await persistDialogJournal(dialogState);
        await persistDialogSession(dialogState);
    } catch (error) {
        dialogState.status = i18nFormat('AI request failed: ${0}', error?.message || error);
        console.error(`[${MODULE_NAME}] Failed to apply preset draft`, error);
    } finally {
        dialogState.busy = false;
        await rerenderDialog(dialogState);
    }
}

async function handleRollbackToMessage(dialogState, messageId) {
    const rollbackPlan = buildTailRollbackPlan(dialogState.session, dialogState.journal, messageId);
    if (!rollbackPlan) {
        toastr.info(i18n('No applied changes for this message.'));
        return;
    }
    if (rollbackPlan.conflicting) {
        toastr.warning(i18n('Later committed changes overlap the same preset paths. Automatic tail rollback is blocked.'));
        return;
    }
    const rollbackMessage = sanitizeMessage((dialogState.session?.messages || []).find(item => String(item?.id || '') === String(messageId || '')));
    const confirmed = await Popup.show.confirm(
        i18n('Rollback this message and every later applied change in the current session?'),
        String(rollbackMessage?.summary || rollbackMessage?.text || '').trim(),
    );
    if (!confirmed) {
        return;
    }
    dialogState.busy = true;
    dialogState.status = i18n('Rolling back...');
    await rerenderDialog(dialogState);
    try {
        const currentLiveSnapshot = await readValidatedLiveSnapshot(dialogState);
        dialogState.journal = ensureJournalBaseSnapshot(dialogState.journal, currentLiveSnapshot.body || {});
        if (!journalMatchesLive(dialogState.journal, currentLiveSnapshot.body || {})) {
            throw new Error(i18n('Current live preset no longer matches assistant history. Clear history before applying or rolling back more changes.'));
        }
        const revertDelta = buildJsonStateDelta(diffPatcher, currentLiveSnapshot.body || {}, rollbackPlan.revertedBody || {});
        if (revertDelta) {
            const result = await dialogState.context.presets.save(
                { collection: 'openai', name: dialogState.targetRef.name },
                rollbackPlan.revertedBody || {},
                { select: true },
            );
            if (!result?.ok) {
                throw new Error(i18n('Save failed.'));
            }
            dialogState.journal = {
                ...dialogState.journal,
                entries: [
                    ...getJournalEntries(dialogState.journal),
                    sanitizeJournalEntry({
                        id: uuidv4(),
                        sessionId: dialogState.session.id,
                        messageId: String(messageId || '').trim(),
                        delta: revertDelta,
                        touchedPaths: extractJsonStateTouchedPaths(revertDelta),
                    }),
                ].filter(Boolean),
            };
            await refreshLiveSnapshot(dialogState);
            await persistDialogJournal(dialogState);
        }
        dialogState.session = {
            ...dialogState.session,
            messages: Array.isArray(dialogState.session?.messages)
                ? dialogState.session.messages.slice(0, rollbackPlan.trimIndex)
                : [],
            draft: null,
        };
        dialogState.status = i18n('Rolled back current session changes to the selected message.');
        await persistDialogSession(dialogState);
    } catch (error) {
        dialogState.status = i18nFormat('AI request failed: ${0}', error?.message || error);
        console.error(`[${MODULE_NAME}] Failed to rollback preset draft`, error);
    } finally {
        dialogState.busy = false;
        await rerenderDialog(dialogState);
    }
}

async function handleSend(dialogState) {
    if (dialogState.busy) {
        dialogState.abortController?.abort?.();
        return;
    }

    const inputText = String(dialogState.inputText || '').trim();
    if (!inputText) {
        toastr.warning(i18n('Please enter a request first.'));
        return;
    }

    let historyMessages = [];
    try {
        await refreshLiveSnapshot(dialogState);
        await refreshReferenceSnapshot(dialogState);
        historyMessages = buildConversationHistoryMessages(dialogState.session);
    } catch (error) {
        dialogState.status = String(error?.message || error || '');
        console.warn(`[${MODULE_NAME}] Preset assistant send preflight failed`, error);
        await rerenderDialog(dialogState);
        return;
    }

    dialogState.session = appendSessionMessage(dialogState.session, {
        role: 'user',
        text: inputText,
    });
    dialogState.inputText = '';
    dialogState.busy = true;
    dialogState.status = i18n('Assistant is thinking...');
    dialogState.abortController = new AbortController();
    await persistDialogSession(dialogState);
    await rerenderDialog(dialogState);

    try {
        const requestOptions = getRequestPresetOptions();
        const response = await requestPresetAssistantReply(dialogState, inputText, {
            requestOptions,
            historyMessages,
            abortSignal: dialogState.abortController.signal,
        });
        const helperTurnMessages = Array.isArray(response?.helperTurnMessages) ? response.helperTurnMessages.map((item) => sanitizeMessage(item)) : [];
        if (helperTurnMessages.length > 0) {
            for (const helperMessage of helperTurnMessages) {
                dialogState.session = appendSessionMessage(dialogState.session, helperMessage);
            }
        }
        const assistantMessageId = uuidv4();
        const draft = buildDraftFromResponse(dialogState, response.assistantText, response.toolCalls, assistantMessageId);
        const persistentToolCalls = buildPersistentToolCallsFromRawCalls(response?.toolCalls || []);
        const assistantMessage = persistentToolCalls.length > 0
            ? createPersistentToolTurnMessage({
                messageId: assistantMessageId,
                assistantText: String(response.assistantText || '').trim() || (draft ? i18n('Draft ready') : i18n('No changes proposed')),
                toolCalls: persistentToolCalls,
                toolResults: draft ? buildPendingToolResults(persistentToolCalls, i18n('Draft ready')) : [],
                toolSummary: buildToolCallSummary(persistentToolCalls),
                toolState: draft ? 'pending' : '',
                extra: {
                    summary: draft?.summary || '',
                    editCount: draft?.edits?.length || 0,
                },
            })
            : {
                id: assistantMessageId,
                role: 'assistant',
                text: String(response.assistantText || '').trim() || (draft ? i18n('Draft ready') : i18n('No changes proposed')),
                summary: draft?.summary || '',
                editCount: draft?.edits?.length || 0,
            };
        dialogState.session = appendSessionMessage(dialogState.session, assistantMessage);
        dialogState.session.draft = draft;
        dialogState.status = draft
            ? i18nFormat('Proposed edits: ${0}', draft.edits.length)
            : i18n('No meaningful changes detected.');
        await persistDialogSession(dialogState);
    } catch (error) {
        if (isAbortError(error, dialogState.abortController?.signal)) {
            dialogState.status = i18n('Request stopped.');
        } else {
            console.error(`[${MODULE_NAME}] Preset assistant request failed`, error);
            dialogState.session = appendSessionMessage(dialogState.session, {
                role: 'system',
                text: i18nFormat('AI request failed: ${0}', error?.message || error),
            });
            dialogState.status = i18nFormat('AI request failed: ${0}', error?.message || error);
            await persistDialogSession(dialogState);
        }
    } finally {
        dialogState.busy = false;
        dialogState.abortController = null;
        await rerenderDialog(dialogState);
    }
}

async function handleCreateNewPreset() {
    const context = getContext();
    const requestedName = String(await Popup.show.input(
        i18n('Create New Preset'),
        i18n('Enter a name for the new preset.'),
        '',
    ) || '').trim();
    if (!requestedName) {
        return;
    }

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

        const liveSnapshot = getCurrentLiveSnapshot(context) || {
            ref: clone(result.ref, null),
            body: clone(result.body || {}, {}),
            source: 'live',
            selected: true,
            stored: true,
        };
        toastr.success(i18nFormat('Preset created: ${0}', result.ref.name || requestedName));
        await openAssistantPopup({
            targetRef: result.ref,
            liveSnapshot,
        });
    } catch (error) {
        toastr.error(i18nFormat('AI request failed: ${0}', error?.message || error));
        console.error(`[${MODULE_NAME}] Failed to create preset`, error);
    }
}

async function openAssistantPopup({ targetRef: explicitTargetRef = null, liveSnapshot: explicitLiveSnapshot = null } = {}) {
    const context = getContext();
    const targetRef = explicitTargetRef && typeof explicitTargetRef === 'object'
        ? clone(explicitTargetRef, null)
        : getCurrentTargetRef(context);
    const liveSnapshot = explicitLiveSnapshot && typeof explicitLiveSnapshot === 'object'
        ? clone(explicitLiveSnapshot, null)
        : getCurrentLiveSnapshot(context);

    if (!targetRef || !liveSnapshot?.stored) {
        toastr.warning(i18n('Current preset is not a stored chat completion preset. Please select a saved preset first.'));
        return;
    }

    if (activeDialogState?.popup) {
        activeDialogState.popup.dlg?.focus?.();
        return;
    }

    const [loadedSessionStore, journal] = await Promise.all([
        loadSessionStore(context, targetRef),
        loadJournal(context, targetRef, liveSnapshot.body || {}),
    ]);
    let sessionStore = normalizeSessionStore(loadedSessionStore);
    let session = getPreferredPresetConversationSession(sessionStore);
    if (!session) {
        const saved = await savePresetConversationSession(context, targetRef, createEmptySession(), {
            store: sessionStore,
            setCurrent: true,
        });
        sessionStore = saved.store;
        session = saved.session;
    } else if (String(sessionStore.currentSessionId || '').trim() !== String(session.id || '').trim()) {
        sessionStore = await setCurrentPresetConversationSessionId(context, targetRef, sessionStore, session.id);
    }
    const dialogState = {
        context,
        popup: null,
        root: null,
        targetRef,
        liveSnapshot,
        sessionStore,
        currentSessionId: String(session?.id || '').trim(),
        session: sanitizeSession(session),
        journal: ensureJournalBaseSnapshot(journal, liveSnapshot.body || {}),
        referenceSnapshot: null,
        busy: false,
        status: '',
        inputText: '',
        abortController: null,
    };
    if (getJournalEntries(dialogState.journal).length > 0 && !journalMatchesLive(dialogState.journal, liveSnapshot.body || {})) {
        dialogState.status = i18n('Current live preset no longer matches assistant history. Clear history before applying or rolling back more changes.');
    }

    await refreshReferenceSnapshot(dialogState);

    const popup = new Popup('<div id="completion_preset_assistant_dialog_root"></div>', POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: false,
        wider: true,
        allowVerticalScrolling: true,
        onOpen: async (instance) => {
            dialogState.popup = instance;
            dialogState.root = jQuery(instance.dlg).find('#completion_preset_assistant_dialog_root');
            bindDialogEvents(dialogState);
            await rerenderDialog(dialogState);
        },
        onClose: () => {
            dialogState.abortController?.abort?.();
            if (activeDialogState === dialogState) {
                activeDialogState = null;
            }
        },
    });

    activeDialogState = dialogState;
    dialogState.popup = popup;
    void popup.show();
}

const {
    bindDialogEvents,
    ensureUi,
    refreshUiState,
    rerenderDialog,
} = createCompletionPresetAssistantDialogUi({
    CREATE_BUTTON_ID,
    OPENAI_BUTTON_ID,
    OPEN_BUTTON_ID,
    SESSION_MESSAGE_LIMIT_MAX,
    SESSION_MESSAGE_LIMIT_MIN,
    TOOL_CALL_RETRY_MAX,
    UI_BLOCK_ID,
    bindHandleCreateNewPreset: handleCreateNewPreset,
    bindOpenAssistantPopup: openAssistantPopup,
    buildDialogMetaItems,
    defaultSettings,
    ensureSettings,
    escapeHtml,
    getConnectionProfileNames,
    getContext,
    getOpenAIPresetNames,
    getSettings,
    handleApplyDraft,
    handleClearHistory,
    handleDiscardDraft,
    handleReferenceChange,
    handleReferenceDiff,
    handleLoadSession,
    handleDeleteSession,
    handleMessageDiff,
    handleNewSession: handleNewSessionWithModePicker,
    handleModeChange,
    handleRollbackToMessage,
    handleSend,
    i18n,
    i18nFormat,
    renderConversationHtml,
    renderDraftHtml,
    renderModeSelectOptions,
    renderPresetConversationHistoryItems,
    renderSelectOptions,
    saveSettingsDebounced,
    toInteger,
});

jQuery(async () => {
    registerLocaleData();
    ensureSettings();
    ensureUi();
    const context = getContext();
    context.eventSource.on(context.eventTypes.PRESET_CHANGED, (event) => {
        if (getPresetEventCollection(event) === 'openai') {
            refreshUiState();
        }
    });
    context.eventSource.on(context.eventTypes.PRESET_RENAMED, (event) => {
        if (getPresetEventCollection(event) === 'openai') {
            refreshUiState();
        }
    });
    context.eventSource.on(context.eventTypes.PRESET_DELETED, (event) => {
        if (getPresetEventCollection(event) === 'openai') {
            refreshUiState();
        }
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
