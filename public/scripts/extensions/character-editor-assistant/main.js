// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
// Implementation source: Toolify: Empower any LLM with function calling capabilities. (https://github.com/funnycups/Toolify)

import { getChatCompletionConnectionProfiles } from '../connection-manager/profile-resolver.js';
import {
    TOOL_PROTOCOL_STYLE,
    validateParsedToolCalls,
} from '../function-call-runtime.js';
import { createCharacterEditorDiffUi } from './diff-ui.js';
import { createCharacterEditorUi } from './editor-ui.js';
import { openUnifiedCharacterEditorPopup } from './editor-iteration/studio.js';
import { DEFAULT_SYSTEM_PROMPT as DEFAULT_EDITOR_ITERATION_SYSTEM_PROMPT } from './editor-iteration/studio.js';
import { DEFAULT_SYSTEM_PROMPT as DEFAULT_CARDAPP_STUDIO_SYSTEM_PROMPT } from './studio/ai-chat.js';
import { applyEdits } from '../../iteration-library/index.js';
import { openSimulationReview } from '../../iteration-library/simulation-review/index.js';
import { ensureSimulationReviewLocaleData } from '../../iteration-library/simulation-review/i18n/index.js';
import { extractWorldInfoHitsFromRuntime } from '../../iteration-library/simulation-review/wi-hits.js';
import {
    extractSystemFromCapturedPrompt,
    extractNonSystemFromCapturedPrompt,
} from '../../iteration-library/simulation-review/dry-run-capture.js';

const __ctx = SillyTavern.getContext();
const generateQuietPrompt = __ctx.generateQuietPrompt;
const saveSettingsDebounced = __ctx.saveSettingsDebounced;
const DOMPurify = __ctx.lib.DOMPurify;
const lodash = __ctx.lib.lodash;
const extension_settings = __ctx.extensionSettings;
const getContext = SillyTavern.getContext;
const getCharacterState = __ctx.getCharacterState;
const setCharacterState = __ctx.setCharacterState;
const addLocaleData = __ctx.addLocaleData;
const translate = __ctx.translate;
const POPUP_TYPE = __ctx.POPUP_TYPE;
const Popup = __ctx.Popup;
const newWorldInfoEntryTemplate = __ctx.worldInfoEntry.template;
const setWorldInfoButtonClass = __ctx.worldInfoEntry.setButtonClass;
const updateWorldInfoList = __ctx.updateWorldInfoList;
const getCharaAuxWorlds = __ctx.getCharaAuxWorlds;
const getChatWorldInfoNames = __ctx.chatWorldInfo.getNames;
const getCharaFilename = __ctx.getCharaFilename;


const MODULE_NAME = 'character_editor_assistant';
const UI_BLOCK_ID = 'character_editor_assistant_settings';
const STYLE_ID = 'character_editor_assistant_style';

const TOOL_NAMES = Object.freeze({
    UPDATE_FIELDS: 'luker_card_update_fields',
    SET_PRIMARY_BOOK: 'luker_card_set_primary_lorebook',
    UPSERT_ENTRY: 'luker_card_upsert_lorebook_entry',
    DELETE_ENTRY: 'luker_card_delete_lorebook_entry',
    LIST_ENTRIES: 'luker_card_list_lorebook_entries',
    QUERY_ENTRIES: 'luker_card_query_lorebook_entries',
    GET_ENTRIES: 'luker_card_get_lorebook_entries',
    SIMULATE_PROMPT: 'luker_card_simulate_prompt',
    LIST_WORLD_BOOKS: 'luker_card_list_world_books',
    UPDATE_ENTRY: 'luker_card_update_lorebook_entry',
    STR_REPLACE_IN_ENTRY: 'luker_card_str_replace_in_lorebook_entry',
});
const CHARACTER_EDITOR_QUERY_LIMIT_DEFAULT = 10;
const CHARACTER_EDITOR_QUERY_LIMIT_MAX = 20;
const CHARACTER_EDITOR_DETAIL_LIMIT_MAX = 10;
const CHARACTER_EDITOR_MATCH_EXCERPT_RADIUS = 70;
const CHARACTER_EDITOR_SEARCH_MODE = Object.freeze({
    ANY: 'any',
    ACTIVATION: 'activation',
});
const CHARACTER_EDITOR_SELECTIVE_LOGIC_LABELS = Object.freeze({
    0: 'AND_ANY',
    1: 'NOT_ALL',
    2: 'NOT_ANY',
    3: 'AND_ALL',
});

const defaultSettings = {
    replaceLorebookSyncEnabled: true,
    requestLlmPresetName: '',
    requestApiPresetName: '',
    toolCallRetryMax: 2,
    maxJournalEntries: 120,
    useStreamingTransport: false,
    editorIterationSystemPrompt: DEFAULT_EDITOR_ITERATION_SYSTEM_PROMPT,
    cardAppStudioSystemPrompt: DEFAULT_CARDAPP_STUDIO_SYSTEM_PROMPT,
};
const CHARACTER_EDITOR_SESSION_NAMESPACE = 'character_editor_assistant_sessions';
const CHARACTER_EDITOR_SESSION_VERSION = 1;
const CHARACTER_EDITOR_SESSION_LIMIT = 24;

const stateCache = new Map();
const lorebookSnapshotCache = new Map();
const editorStudioDialogLocks = new Set();

function i18n(text) {
    return translate(String(text || ''));
}

function i18nFormat(text, ...values) {
    return i18n(text).replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        'Character Editor Assistant': '角色卡编辑助手',
        'Open Editor': '打开编辑器',
        'Character Editor': '角色编辑器',
        'Enable lorebook sync popup after Replace/Update': '替换/更新角色卡后启用世界书同步弹窗',
        'Iteration AI prompt preset (params + prompt)': '迭代 AI 的提示词预设（参数+提示词）',
        'Iteration AI API preset (Connection profile)': '迭代 AI 的 API 预设（连接配置）',
        'Plain-text function-call mode': '纯文本函数调用模式',
        'Tool-call retries on invalid/missing tool call (N)': '工具调用重试次数（无效/缺失时）',
        'Custom System Prompts (advanced)': '自定义系统提示词（高级）',
        'Editor iteration prompt': '编辑器迭代提示词',
        'CardApp Studio prompt': 'CardApp Studio 提示词',
        'Reset to default': '重置为默认',
        'Refresh': '刷新',
        'History': '修改历史',
        'Conversation history': '对话历史',
        'Approve': '批准',
        'Reject': '拒绝',
        'View diff': '查看 diff',
        'Rollback': '回滚',
        'Rolled back': '已回退',
        'Delete': '删除',
        'Clear history': '清空历史',
        'No history yet.': '暂无历史记录。',
        'No conversation history yet.': '暂无对话历史。',
        'Load': '加载',
        'Current': '当前',
        'New session': '新建会话',
        '${0} msgs': '${0} 条消息',
        'Session loaded.': '会话已加载。',
        'Delete this conversation session?': '删除这条对话历史？',
        'Conversation session deleted.': '对话历史已删除。',
        'Load failed: ${0}': '加载失败：${0}',
        'Conversation delete failed: ${0}': '删除对话失败：${0}',
        'Rollback this diff?': '回退这条 diff 吗？',
        'Character editor tools are ready.': '角色编辑工具已就绪。',
        'Current chat has no active character.': '当前聊天没有活动角色卡。',
        'Operation applied: ${0}': '操作已生效：${0}',
        'Rollback completed.': '回滚完成。',
        'Rollback failed: ${0}': '回滚失败：${0}',
        'Before': '修改前',
        'After': '修改后',
        'Line diff': '逐行差异',
        'Line diff (+${0} -${1})': '逐行差异（+${0} -${1}）',
        'Expand diff': '放大查看',
        'Close expanded diff': '关闭放大视图',
        '...(${0} more lines)': '...（还有 ${0} 行）',
        'No meaningful changes detected.': '未检测到可展示的变更。',
        'Target lorebook': '目标世界书',
        'Entry UID': '条目 UID',
        '(empty)': '（空）',
        '(deleted)': '（已删除）',
        '(missing lorebook)': '（世界书不存在）',
        'Old lorebook': '旧世界书',
        'New lorebook': '新世界书',
        'Candidate sync operations': '候选同步操作',
        'Lorebook sync result: applied ${0}, failed ${1}': '世界书同步结果：已生效 ${0}，失败 ${1}',
        'A lorebook sync dialog is already open for this character.': '该角色已有世界书同步弹窗正在处理中。',
        'An editor is already open for this character.': '该角色已有编辑器正在处理中。',
        'Save and update': '保存并更新',
        'Cancel and restore previous lorebook': '取消并恢复旧世界书',
        'Analyze then update': '模型分析后更新',
        'Direct replace': '直接替换',
        'Do not replace': '不替换',
        'Choose how to handle lorebook update': '请选择世界书更新方式',
        'No replacement applied. Restored previous lorebook binding: ${0}': '未执行替换，已恢复旧世界书绑定：${0}',
        'Review model analysis and optionally add requirements. Save will apply model edits; cancel will restore the previous lorebook.': '请查看模型分析并可补充要求。点“保存并更新”将应用模型修改；点“取消并恢复旧世界书”会恢复导入前绑定。',
        'Analyzing lorebook differences with model...': '正在用模型分析世界书差异...',
        'Detected ${0} candidate changes between old and new lorebook.': '检测到新旧世界书间 ${0} 个候选变更。',
        'Model analysis failed: ${0}': '模型分析失败：${0}',
        'No analysis output.': '模型未返回分析内容。',
        'Model analysis is still running. Please wait or cancel to restore previous lorebook.': '模型分析仍在进行中。请等待或取消并恢复旧世界书。',
        'Finalize lorebook replacement: ${0} -> ${1}': '世界书替换完成：${0} -> ${1}',
        'Lorebook finalization skipped due failed operations.': '存在失败操作，已跳过世界书最终替换。',
        'No lorebook changes detected.': '未检测到世界书变更。',
        'Send': '发送',
        'Type your requirement to continue this conversation...': '输入你的要求继续对话...',
        'Assistant is thinking...': '模型思考中...',
        'Applying approved changes...': '正在应用已批准变更...',
        'Stop': '终止',
        'Request cancelled.': '请求已终止。',
        'Message cannot be empty.': '消息不能为空。',
        'Model reply failed: ${0}': '模型回复失败：${0}',
        'Round diff': '本轮差异',
        'Round diff (${0} operations)': '本轮差异（${0} 个操作）',
        'No draft operations proposed in this round.': '本轮没有拟议变更。',
        'Proposed ${0} operations in this round.': '本轮拟议 ${0} 个操作。',
        'Operation ${0}': '操作 ${0}',
        'Raw arguments': '原始参数',
        'Rollback to this round': '回退到本轮',
        'Rolled back to selected round.': '已回退到所选轮次。',
        'Pending review': '待审批',
        'Approved': '已通过',
        'Rejected': '已拒绝',
        'All final diffs must be reviewed before saving.': '保存前必须处理所有最终差异项（通过或拒绝）。',
        'No approved diff to apply. Finalizing without additional changes.': '没有已通过差异项，将直接完成同步且不追加修改。',
        'Please approve or reject pending changes first.': '请先批准或拒绝待审批变更。',
        'AI proposed changes are waiting for approval.': 'AI 提出的变更正在等待审批。',
        'Regenerate': '重新生成',
        'Regenerating message...': '正在重新生成消息...',
        'This message cannot be regenerated.': '这条消息无法重新生成。',
        'Approve batch': '批准本批次',
        'Reject batch': '拒绝本批次',
        'Changes applied.': '变更已应用。',
        'Changes rejected.': '变更已拒绝。',
        'Apply failed: ${0}': '应用失败：${0}',
        'Delete this history record?': '删除这条历史记录？',
        'Clear all history records?': '清空所有历史记录？',
        'History record deleted.': '历史记录已删除。',
        'History cleared.': '历史记录已清空。',
        'Delete failed: ${0}': '删除失败：${0}',
        'Clear failed: ${0}': '清空失败：${0}',
        '(Current preset)': '（当前提示词预设）',
        '(Current API config)': '（当前 API 配置）',
        '(missing)': '（缺失）',
        'Search entries...': '搜索条目...',
        'Page ${0} / ${1}': '第 ${0} / ${1} 页',
        'Prev': '上一页',
        'Next': '下一页',
        '${0} matches': '匹配 ${0} 项',
        'No entries match this search.': '没有匹配的条目。',
        // CardApp Studio
        'CardApp Studio': 'CardApp Studio',
        'Open CardApp Studio': '打开 CardApp Studio',
        'No character selected or character has no avatar.': '未选择角色或角色没有头像。',
        'CardApp Studio is already open.': 'CardApp Studio 已经打开了。',
        'Live preview shows behind this popup. Use the reload button to refresh.': '实时预览显示在弹窗背景中。使用重新加载按钮刷新。',
        'Reload preview': '重新加载预览',
        'No files.': '没有文件。',
        'Code editor unavailable in this build.': '当前构建中代码编辑器不可用。',
        'Create a new file': '创建新文件',
        'File already exists: ${0}': '文件已存在：${0}',
        'Previous lorebook (before this character was last opened)': '上一次的世界书（在本角色被重新打开之前）',
        'No entries to compare.': '没有条目可对比。',
        'No differences from reference.': '与参考没有差异。',
        'File history': '文件历史',
        'Refresh': '刷新',
        'Click ↻ to load history': '点击 ↻ 加载历史',
        'No history yet': '暂无历史',
        'Loading...': '加载中…',
        'Rollback to this version': '回滚到此版本',
        'Rollback to this version? This cannot be undone.': '回滚到此版本？此操作无法撤销。',
        'Rolled back successfully': '回滚成功',
        'Rollback failed: ${0}': '回滚失败：${0}',
        'Failed to load history: ${0}': '加载历史失败：${0}',
        'AI': '对话',
        'Code': '代码',
        'Preview': '预览',
        'Auto-apply': '自动应用',
        'Auto-apply: skip approval, apply AI edits immediately': '自动应用：跳过审批，AI 编辑立即生效',
        'Auto-apply enabled: AI edits will apply without approval.': '自动应用已开启：AI 编辑将无需审批直接生效。',
        'Auto-apply disabled: AI edits will require approval.': '自动应用已关闭：AI 编辑需要先审批。',
        'Saved ${0}': '已保存 ${0}',
        'Failed to save: ${0}': '保存失败：${0}',
        'Created ${0}': '已创建 ${0}',
        'Failed to create file: ${0}': '创建文件失败：${0}',
        'Thinking...': '思考中...',
        '(Request cancelled)': '（请求已取消）',
        'AI Assistant': 'AI 助手',
        'Code Editor': '代码编辑器',
        'Files': '文件',
        'No files yet': '暂无文件',
        'Describe what you want to build...': '描述你想要构建的内容...',
        'Save': '保存',
        'Reload': '重载',
        'Close Studio': '关闭 Studio',
        'New file name (e.g. utils.js):': '新文件名（如 utils.js）：',
        'Clear chat': '清空对话',
        'No history yet': '暂无历史记录',
        'Loading...': '加载中...',
        'Rollback to this version? This cannot be undone.': '回滚到此版本？此操作不可撤销。',
        'Rolled back successfully': '回滚成功',
        'Rollback failed: ${0}': '回滚失败：${0}',
        'Error: ${0}': '错误：${0}',
        'Approve file change?': '批准文件更改？',
        'Auto-apply': '自动应用',
        'Skip the manual approve step for file changes. Writes apply immediately.': '跳过文件改动的人工批准步骤,写入立即生效。',
        'New file': '新文件',
        'Modified': '已修改',
        '...${0} more lines': '...还有 ${0} 行',
        'Send': '发送',
        'Stop': '停止',
        'Sessions': '会话',
        'New': '新建',
        'No sessions yet': '暂无会话',
        'New session created': '新会话已创建',
        'Session loaded': '会话已加载',
        'Delete this session?': '删除此会话？',
        'Session deleted': '会话已删除',
        'Delete failed: ${0}': '删除失败：${0}',
        'Card fields': '卡片字段',
        'Lorebook': '世界书',
        'Diff vs reference': '与参考对比',
        'Pick a reference from the toolbar to compare.': '从工具栏选择参考以进行对比。',
 });
 addLocaleData('zh-tw', {
 'Character Editor Assistant': '角色卡編輯助手',
        'Open Editor': '開啟編輯器',
        'Character Editor': '角色編輯器',
        'Enable lorebook sync popup after Replace/Update': '替換/更新角色卡後啟用世界書同步彈窗',
        'Iteration AI prompt preset (params + prompt)': '迭代 AI 的提示詞預設（參數+提示詞）',
        'Iteration AI API preset (Connection profile)': '迭代 AI 的 API 預設（連線設定）',
        'Plain-text function-call mode': '純文本函數調用模式',
        'Tool-call retries on invalid/missing tool call (N)': '工具調用重試次數（無效/缺失時）',
        'Custom System Prompts (advanced)': '自訂系統提示詞（進階）',
        'Editor iteration prompt': '編輯器迭代提示詞',
        'CardApp Studio prompt': 'CardApp Studio 提示詞',
        'Reset to default': '重置為預設',
        'Refresh': '刷新',
        'History': '修改歷史',
        'Conversation history': '對話歷史',
        'Approve': '批准',
        'Reject': '拒絕',
        'View diff': '查看 diff',
        'Rollback': '回滾',
        'Rolled back': '已回退',
        'Delete': '刪除',
        'Clear history': '清空歷史',
        'No history yet.': '暫無歷史記錄。',
        'No conversation history yet.': '暫無對話歷史。',
        'Load': '載入',
        'Current': '當前',
        'New session': '新建會話',
        '${0} msgs': '${0} 則訊息',
        'Session loaded.': '會話已載入。',
        'Delete this conversation session?': '刪除這條對話歷史？',
        'Conversation session deleted.': '對話歷史已刪除。',
        'Load failed: ${0}': '載入失敗：${0}',
        'Conversation delete failed: ${0}': '刪除對話失敗：${0}',
        'Rollback this diff?': '回退這條 diff 嗎？',
        'Character editor tools are ready.': '角色編輯工具已就緒。',
        'Current chat has no active character.': '當前聊天沒有活動角色卡。',
        'Operation applied: ${0}': '操作已生效：${0}',
        'Rollback completed.': '回滾完成。',
        'Rollback failed: ${0}': '回滾失敗：${0}',
        'Before': '修改前',
        'After': '修改後',
        'Line diff': '逐行差異',
        'Line diff (+${0} -${1})': '逐行差異（+${0} -${1}）',
        'Expand diff': '放大查看',
        'Close expanded diff': '關閉放大視圖',
        '...(${0} more lines)': '...（還有 ${0} 行）',
        'No meaningful changes detected.': '未檢測到可展示的變更。',
        'Target lorebook': '目標世界書',
        'Entry UID': '條目 UID',
        '(empty)': '（空）',
        '(deleted)': '（已刪除）',
        '(missing lorebook)': '（世界書不存在）',
        'Old lorebook': '舊世界書',
        'New lorebook': '新世界書',
        'Candidate sync operations': '候選同步操作',
        'Lorebook sync result: applied ${0}, failed ${1}': '世界書同步結果：已生效 ${0}，失敗 ${1}',
        'A lorebook sync dialog is already open for this character.': '該角色已有世界書同步彈窗正在處理中。',
        'An editor is already open for this character.': '該角色已有編輯器正在處理中。',
        'Save and update': '儲存並更新',
        'Cancel and restore previous lorebook': '取消並恢復舊世界書',
        'Analyze then update': '模型分析後更新',
        'Direct replace': '直接替換',
        'Do not replace': '不替換',
        'Choose how to handle lorebook update': '請選擇世界書更新方式',
        'No replacement applied. Restored previous lorebook binding: ${0}': '未執行替換，已恢復舊世界書綁定：${0}',
        'Review model analysis and optionally add requirements. Save will apply model edits; cancel will restore the previous lorebook.': '請查看模型分析並可補充要求。按「儲存並更新」將套用模型修改；按「取消並恢復舊世界書」會恢復匯入前綁定。',
        'Analyzing lorebook differences with model...': '正在用模型分析世界書差異...',
        'Detected ${0} candidate changes between old and new lorebook.': '檢測到新舊世界書間 ${0} 個候選變更。',
        'Model analysis failed: ${0}': '模型分析失敗：${0}',
        'No analysis output.': '模型未回傳分析內容。',
        'Model analysis is still running. Please wait or cancel to restore previous lorebook.': '模型分析仍在進行中。請等待或取消並恢復舊世界書。',
        'Finalize lorebook replacement: ${0} -> ${1}': '世界書替換完成：${0} -> ${1}',
        'Lorebook finalization skipped due failed operations.': '存在失敗操作，已跳過世界書最終替換。',
        'No lorebook changes detected.': '未檢測到世界書變更。',
        'Send': '發送',
        'Type your requirement to continue this conversation...': '輸入你的要求繼續對話...',
        'Assistant is thinking...': '模型思考中...',
        'Applying approved changes...': '正在套用已批准變更...',
        'Stop': '終止',
        'Request cancelled.': '請求已終止。',
        'Message cannot be empty.': '訊息不能為空。',
        'Model reply failed: ${0}': '模型回覆失敗：${0}',
        'Round diff': '本輪差異',
        'Round diff (${0} operations)': '本輪差異（${0} 個操作）',
        'No draft operations proposed in this round.': '本輪沒有擬議變更。',
        'Proposed ${0} operations in this round.': '本輪擬議 ${0} 個操作。',
        'Operation ${0}': '操作 ${0}',
        'Raw arguments': '原始參數',
        'Rollback to this round': '回退到本輪',
        'Rolled back to selected round.': '已回退到所選輪次。',
        'Pending review': '待審批',
        'Approved': '已通過',
        'Rejected': '已拒絕',
        'All final diffs must be reviewed before saving.': '儲存前必須處理所有最終差異項（通過或拒絕）。',
        'No approved diff to apply. Finalizing without additional changes.': '沒有已通過差異項，將直接完成同步且不追加修改。',
        'Please approve or reject pending changes first.': '請先批准或拒絕待審批變更。',
        'AI proposed changes are waiting for approval.': 'AI 提出的變更正在等待審批。',
        'Regenerate': '重新生成',
        'Regenerating message...': '正在重新生成訊息...',
        'This message cannot be regenerated.': '這條訊息無法重新生成。',
        'Approve batch': '批准本批次',
        'Reject batch': '拒絕本批次',
        'Changes applied.': '變更已套用。',
        'Changes rejected.': '變更已拒絕。',
        'Apply failed: ${0}': '套用失敗：${0}',
        'Delete this history record?': '刪除這條歷史記錄？',
        'Clear all history records?': '清空所有歷史記錄？',
        'History record deleted.': '歷史記錄已刪除。',
        'History cleared.': '歷史記錄已清空。',
        'Delete failed: ${0}': '刪除失敗：${0}',
        'Clear failed: ${0}': '清空失敗：${0}',
        '(Current preset)': '（目前提示詞預設）',
        '(Current API config)': '（目前 API 配置）',
        '(missing)': '（缺失）',
        'Search entries...': '搜索條目...',
        'Page ${0} / ${1}': '第 ${0} / ${1} 頁',
        'Prev': '上一頁',
        'Next': '下一頁',
        '${0} matches': '匹配 ${0} 項',
        'No entries match this search.': '沒有匹配的條目。',
        // CardApp Studio
        'CardApp Studio': 'CardApp Studio',
        'Open CardApp Studio': '開啟 CardApp Studio',
        'No character selected or character has no avatar.': '未選擇角色或角色沒有頭像。',
        'CardApp Studio is already open.': 'CardApp Studio 已經開啟了。',
        'Live preview shows behind this popup. Use the reload button to refresh.': '即時預覽顯示在彈窗背景中。使用重新載入按鈕刷新。',
        'Reload preview': '重新載入預覽',
        'No files.': '沒有檔案。',
        'Code editor unavailable in this build.': '目前建置中程式碼編輯器不可用。',
        'Create a new file': '建立新檔案',
        'File already exists: ${0}': '檔案已存在：${0}',
        'Previous lorebook (before this character was last opened)': '上次的世界書（在本角色被重新開啟之前）',
        'No entries to compare.': '沒有條目可對比。',
        'No differences from reference.': '與參考沒有差異。',
        'File history': '檔案歷史',
        'Refresh': '重新整理',
        'Click ↻ to load history': '點擊 ↻ 載入歷史',
        'No history yet': '暫無歷史',
        'Loading...': '載入中…',
        'Rollback to this version': '回滾到此版本',
        'Rollback to this version? This cannot be undone.': '回滾到此版本？此操作無法復原。',
        'Rolled back successfully': '回滾成功',
        'Rollback failed: ${0}': '回滾失敗：${0}',
        'Failed to load history: ${0}': '載入歷史失敗：${0}',
        'AI': '對話',
        'Code': '程式碼',
        'Preview': '預覽',
        'Auto-apply': '自動套用',
        'Auto-apply: skip approval, apply AI edits immediately': '自動套用：跳過審批，AI 編輯立即生效',
        'Auto-apply enabled: AI edits will apply without approval.': '自動套用已開啟：AI 編輯將無需審批直接生效。',
        'Auto-apply disabled: AI edits will require approval.': '自動套用已關閉：AI 編輯需要先審批。',
        'Saved ${0}': '已儲存 ${0}',
        'Failed to save: ${0}': '儲存失敗：${0}',
        'Created ${0}': '已建立 ${0}',
        'Failed to create file: ${0}': '建立檔案失敗：${0}',
        'Thinking...': '思考中...',
        '(Request cancelled)': '（請求已取消）',
        'AI Assistant': 'AI 助手',
        'Code Editor': '程式碼編輯器',
        'Files': '檔案',
        'No files yet': '暫無檔案',
        'Describe what you want to build...': '描述你想要建構的內容...',
        'Save': '儲存',
        'Reload': '重新載入',
        'Close Studio': '關閉 Studio',
        'New file name (e.g. utils.js):': '新檔案名稱（如 utils.js）：',
        'Clear chat': '清空對話',
        'No history yet': '暫無歷史記錄',
        'Loading...': '載入中...',
        'Rollback to this version? This cannot be undone.': '回滾到此版本？此操作不可撤銷。',
        'Rolled back successfully': '回滾成功',
        'Rollback failed: ${0}': '回滾失敗：${0}',
        'Error: ${0}': '錯誤：${0}',
        'Approve file change?': '批准檔案變更？',
        'Auto-apply': '自動套用',
        'Skip the manual approve step for file changes. Writes apply immediately.': '略過檔案變更的人工批准步驟,寫入立即生效。',
        'New file': '新檔案',
        'Modified': '已修改',
        '...${0} more lines': '...還有 ${0} 行',
        'Send': '發送',
        'Stop': '停止',
        'Sessions': '會話',
        'New': '新建',
        'No sessions yet': '暫無會話',
        'New session created': '新會話已建立',
        'Session loaded': '會話已載入',
        'Delete this session?': '刪除此會話？',
        'Session deleted': '會話已刪除',
        'Delete failed: ${0}': '刪除失敗：${0}',
        'Card fields': '卡片欄位',
        'Lorebook': '世界書',
        'Diff vs reference': '與參考對比',
        'Pick a reference from the toolbar to compare.': '從工具列選擇參考以進行對比。',
 });
}

function clone(value) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Fall back for Luker context proxy objects.
        }
    }
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized);
}

function notifySuccess(message) {
    if (typeof toastr !== 'undefined') {
        toastr.success(String(message || ''));
    }
}

function notifyWarning(message) {
    if (typeof toastr !== 'undefined') {
        toastr.warning(String(message || ''));
    }
}

function notifyError(message) {
    if (typeof toastr !== 'undefined') {
        toastr.error(String(message || ''));
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseCsvList(value) {
    return String(value ?? '')
        .split(',')
        .map(item => normalizeText(item))
        .filter(Boolean);
}

function asFiniteInteger(value, fallback = null) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return fallback;
    }
    return Math.floor(num);
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = clone(defaultSettings);
    }
    const settings = extension_settings[MODULE_NAME];
    settings.replaceLorebookSyncEnabled = settings.replaceLorebookSyncEnabled !== false;
    if (settings.lorebookSyncLlmPresetName !== undefined) {
        settings.requestLlmPresetName ||= String(settings.lorebookSyncLlmPresetName || '');
        delete settings.lorebookSyncLlmPresetName;
    }
    if (settings.lorebookSyncApiPresetName !== undefined) {
        settings.requestApiPresetName ||= String(settings.lorebookSyncApiPresetName || '');
        delete settings.lorebookSyncApiPresetName;
    }
    settings.requestLlmPresetName = String(settings.requestLlmPresetName || '').trim();
    settings.requestApiPresetName = String(settings.requestApiPresetName || '').trim();
    delete settings.plainTextFunctionCallMode;
    settings.toolCallRetryMax = Math.max(0, Math.min(10, Math.floor(Number(settings.toolCallRetryMax || defaultSettings.toolCallRetryMax) || 0)));
    settings.maxJournalEntries = Math.max(20, Math.min(500, Number(settings.maxJournalEntries || defaultSettings.maxJournalEntries)));
    settings.useStreamingTransport = Boolean(settings.useStreamingTransport);
    settings.editorIterationSystemPrompt = String(settings.editorIterationSystemPrompt || '').trim() || DEFAULT_EDITOR_ITERATION_SYSTEM_PROMPT;
    settings.cardAppStudioSystemPrompt = String(settings.cardAppStudioSystemPrompt || '').trim() || DEFAULT_CARDAPP_STUDIO_SYSTEM_PROMPT;
}

function getSettings() {
    ensureSettings();
    return extension_settings[MODULE_NAME];
}

function getConnectionProfiles() {
    return getChatCompletionConnectionProfiles();
}

function getLorebookSyncRequestPresetOptions() {
    const settings = getSettings();
    return {
        llmPresetName: String(settings.requestLlmPresetName || '').trim(),
        apiPresetName: String(settings.requestApiPresetName || '').trim(),
    };
}

function rewriteDepthWorldInfoToAfterWithNotes(payload = {}) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }
    const depthEntries = Array.isArray(payload.worldInfoDepth) ? payload.worldInfoDepth : [];
    if (depthEntries.length === 0) {
        return payload;
    }

    const blocks = [];
    for (const entry of depthEntries) {
        const depth = Math.max(0, Math.floor(Number(entry?.depth) || 0));
        const lines = Array.isArray(entry?.entries) ? entry.entries : [];
        for (const line of lines) {
            const content = String(line ?? '').trim();
            if (!content) {
                continue;
            }
            blocks.push(`[原聊天深度注入: ${depth}]\n${content}`);
        }
    }

    payload.worldInfoDepth = [];
    if (blocks.length === 0) {
        return payload;
    }

    if (!Array.isArray(payload.worldInfoAfterEntries)) {
        payload.worldInfoAfterEntries = [];
    }
    for (const block of blocks) {
        if (!payload.worldInfoAfterEntries.includes(block)) {
            payload.worldInfoAfterEntries.push(block);
        }
    }
    return payload;
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

function getOpenAIPresetNames(context) {
    const manager = context.getPresetManager?.('openai');
    if (!manager || typeof manager.getAllPresets !== 'function') {
        return [];
    }
    const names = manager.getAllPresets();
    if (!Array.isArray(names)) {
        return [];
    }
    return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
}

function getConnectionProfileNames() {
    return getConnectionProfiles()
        .map(profile => String(profile.name || '').trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

function renderOpenAIPresetOptions(context, selectedName = '') {
    const selected = String(selectedName || '').trim();
    const names = getOpenAIPresetNames(context);
    const options = [`<option value="">${escapeHtml(i18n('(Current preset)'))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function renderConnectionProfileOptions(selectedName = '') {
    const selected = String(selectedName || '').trim();
    const names = getConnectionProfileNames();
    const options = [`<option value="">${escapeHtml(i18n('(Current API config)'))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function refreshPresetSelectors(root, context, settings) {
    const llmSelect = root.find('#cea_sync_llm_preset');
    if (llmSelect.length) {
        llmSelect.html(renderOpenAIPresetOptions(context, settings.requestLlmPresetName));
        llmSelect.val(String(settings.requestLlmPresetName || '').trim());
    }
    const apiSelect = root.find('#cea_sync_api_preset');
    if (apiSelect.length) {
        apiSelect.html(renderConnectionProfileOptions(settings.requestApiPresetName));
        apiSelect.val(String(settings.requestApiPresetName || '').trim());
    }
}

function createEmptyState() {
    return {
        version: 1,
        nextId: 1,
        journal: [],
        updatedAt: Date.now(),
    };
}

function normalizeOperationState(state) {
    const normalized = state && typeof state === 'object' ? clone(state) : createEmptyState();
    normalized.version = 1;
    normalized.nextId = Math.max(1, Number(normalized.nextId || 1));
    normalized.journal = Array.isArray(normalized.journal)
        ? normalized.journal.filter(item => item && typeof item === 'object' && String(item.id || '').trim())
        : [];
    normalized.updatedAt = Number(normalized.updatedAt || Date.now());
    return normalized;
}

function getCharacterOperationStateKey(context, avatar = '') {
    const preferredAvatar = String(avatar || '').trim();
    if (preferredAvatar) {
        return preferredAvatar;
    }
    const record = getActiveCharacterRecord(context);
    return String(record.avatar || '').trim();
}

async function getOperationStateSidecar(context, avatar) {
    return await getCharacterState(avatar, MODULE_NAME);
}

async function setOperationStateSidecar(context, avatar, state) {
    await setCharacterState(avatar, MODULE_NAME, clone(state));
}

async function loadOperationState(context, { force = false, avatar = '' } = {}) {
    const key = getCharacterOperationStateKey(context, avatar);
    if (!force && stateCache.has(key)) {
        return clone(stateCache.get(key));
    }
    const record = getActiveCharacterRecord(context, { avatar });
    const loaded = await getOperationStateSidecar(context, record.avatar);
    const normalized = normalizeOperationState(loaded);
    stateCache.set(key, clone(normalized));
    return normalized;
}

async function persistOperationState(context, state, { avatar = '' } = {}) {
    const key = getCharacterOperationStateKey(context, avatar);
    const record = getActiveCharacterRecord(context, { avatar });
    const next = normalizeOperationState(state);
    await setOperationStateSidecar(context, record.avatar, next);
    stateCache.set(key, clone(next));
}

async function deleteHistoryRecord(context, journalId, { avatar = '' } = {}) {
    const id = String(journalId || '').trim();
    if (!id) {
        return false;
    }
    const state = await loadOperationState(context, { force: true, avatar });
    const { index } = getJournalById(state, id);
    if (index < 0) {
        return false;
    }
    state.journal.splice(index, 1);
    state.updatedAt = Date.now();
    await persistOperationState(context, state, { avatar });
    return true;
}

async function clearHistoryRecords(context, { avatar = '' } = {}) {
    const state = await loadOperationState(context, { force: true, avatar });
    if (!Array.isArray(state.journal) || state.journal.length === 0) {
        return false;
    }
    state.journal = [];
    state.updatedAt = Date.now();
    await persistOperationState(context, state, { avatar });
    return true;
}

function makeCharacterEditorSessionId(prefix = 'cea_session') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeCharacterEditorSessionMessage(rawMessage) {
    const role = String(rawMessage?.role || 'assistant').trim().toLowerCase();
    const message = {
        id: String(rawMessage?.id || '').trim() || makeConversationMessageId(),
        role: role === 'user' ? 'user' : 'assistant',
        content: String(rawMessage?.content || ''),
        auto: Boolean(rawMessage?.auto),
        at: Number(rawMessage?.at || Date.now()),
    };
    if (message.role !== 'assistant') {
        return message;
    }

    const toolCalls = normalizePersistentToolCalls(rawMessage);
    const toolResults = normalizePersistentToolResults(rawMessage, toolCalls);
    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
    }
    if (toolResults.length > 0) {
        message.tool_results = toolResults;
    }
    if (rawMessage?.toolSummary) {
        message.toolSummary = String(rawMessage.toolSummary || '');
    }
    if (rawMessage?.toolState) {
        message.toolState = String(rawMessage.toolState || '');
    }
    if (Array.isArray(rawMessage?.operations)) {
        message.operations = rawMessage.operations
            .filter(item => item && typeof item === 'object')
            .map(item => ({
                kind: String(item?.kind || '').trim(),
                args: item?.args && typeof item.args === 'object' ? clone(item.args) : {},
            }));
    }
    if (Array.isArray(rawMessage?.diffPreviews)) {
        message.diffPreviews = clone(rawMessage.diffPreviews);
    }
    if (Array.isArray(rawMessage?.executionResults)) {
        message.executionResults = clone(rawMessage.executionResults);
    }
    return message;
}

function normalizeCharacterEditorSession(rawSession) {
    const session = {
        id: String(rawSession?.id || '').trim() || makeCharacterEditorSessionId(),
        avatar: String(rawSession?.avatar || '').trim(),
        createdAt: Number(rawSession?.createdAt || Date.now()),
        updatedAt: Number(rawSession?.updatedAt || rawSession?.createdAt || Date.now()),
        messages: (Array.isArray(rawSession?.messages) ? rawSession.messages : []).map(item => normalizeCharacterEditorSessionMessage(item)),
        rejectedOperationKeys: [],
        pendingApproval: null,
    };
    const rejectedKeys = rebuildCharacterEditorRejectedOperationKeys(session.messages, new Set());
    session.rejectedOperationKeys = Array.from(rejectedKeys.values());
    const pendingMessage = [...session.messages].reverse().find(item => String(item?.toolState || '').trim().toLowerCase() === 'pending');
    session.pendingApproval = pendingMessage
        ? {
            messageId: String(pendingMessage?.id || '').trim(),
            operations: Array.isArray(pendingMessage?.operations) ? clone(pendingMessage.operations) : [],
            diffPreviews: Array.isArray(pendingMessage?.diffPreviews) ? clone(pendingMessage.diffPreviews) : [],
            toolCalls: normalizePersistentToolCalls(pendingMessage),
        }
        : null;
    return session;
}

function createEmptyCharacterEditorSessionStore() {
    return {
        version: CHARACTER_EDITOR_SESSION_VERSION,
        sessions: [],
    };
}

function normalizeCharacterEditorSessionStore(rawStore) {
    const sessions = (Array.isArray(rawStore?.sessions) ? rawStore.sessions : [])
        .map(item => normalizeCharacterEditorSession(item))
        .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    return {
        version: CHARACTER_EDITOR_SESSION_VERSION,
        sessions: sessions.slice(-CHARACTER_EDITOR_SESSION_LIMIT),
    };
}

async function loadCharacterEditorSessionStore(context, avatar) {
    const raw = await getCharacterState(avatar, CHARACTER_EDITOR_SESSION_NAMESPACE);
    return normalizeCharacterEditorSessionStore(raw || createEmptyCharacterEditorSessionStore());
}

/**
 * Read the raw legacy CEA editor session bundle for an avatar. Returns the
 * underlying `sessions[]` array exactly as it was persisted on the character
 * card (no normalization beyond what the legacy store applied at write time),
 * so the M4 migration converter can introspect every original field.
 *
 * Used only by the unified popup's first-open migration path
 * (`editor-iteration/studio.js`). Returns `[]` on any read error so the
 * popup's session list still loads (migration is best-effort).
 *
 * @param {object} context - SillyTavern context (currently unused; reserved
 *   for symmetry with `loadCharacterEditorSessionStore`).
 * @param {string} avatar - Character avatar key.
 * @returns {Promise<Array<object>>}
 */
export async function readLegacyCeaEditorSessions(context, avatar) {
    try {
        const raw = await getCharacterState(avatar, CHARACTER_EDITOR_SESSION_NAMESPACE);
        const sessions = Array.isArray(raw?.sessions) ? raw.sessions : [];
        // Return a shallow clone so downstream mutation can't corrupt the
        // persisted card state if the migrator decides to mutate-in-place.
        return sessions.map(s => (s && typeof s === 'object') ? { ...s } : s);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[character-editor-assistant] readLegacyCeaEditorSessions failed', err);
        return [];
    }
}

/**
 * Read the raw legacy character-iteration popup session bucket for an avatar.
 *
 * The deleted CHARACTER_REPLACED auto-popup persisted sessions to
 * `extension_settings.character_editor_assistant.popupSessionsV2[char_<avatar>]`
 * (Stage 2 spec). After M3 removed that popup, those sessions became orphans
 * the new unified-popup migration ignored. This reader gives the migrator a
 * second source so that history is recovered on first open.
 *
 * The bucket shape is `{ [sessionId]: sessionObject }`. We return an array of
 * session objects (shallow-cloned) — the convertLegacyMessage / migrator
 * downstream handles the same conversationMessages / pendingApproval shape
 * that the editor popup used, so no separate adapter is needed.
 *
 * Returns `[]` on any read error so the migration's outer empty-check still
 * works gracefully.
 *
 * @param {object} context - SillyTavern context (currently unused; reserved
 *   for symmetry with `readLegacyCeaEditorSessions`).
 * @param {string} avatar - Character avatar key.
 * @returns {Promise<Array<object>>}
 */
export async function readLegacyCharIterPopupSessions(context, avatar) {
    try {
        const root = context?.extensionSettings?.character_editor_assistant
            || (typeof globalThis !== 'undefined' && globalThis.extension_settings && globalThis.extension_settings.character_editor_assistant)
            || null;
        if (!root || typeof root !== 'object') return [];
        const v2 = root.popupSessionsV2;
        if (!v2 || typeof v2 !== 'object') return [];
        const scope = `char_${avatar}`;
        const bucket = v2[scope];
        if (!bucket) return [];
        if (Array.isArray(bucket)) {
            return bucket.filter(s => s && typeof s === 'object').map(s => ({ ...s }));
        }
        if (typeof bucket === 'object') {
            return Object.values(bucket).filter(s => s && typeof s === 'object').map(s => ({ ...s }));
        }
        return [];
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[character-editor-assistant] readLegacyCharIterPopupSessions failed', err);
        return [];
    }
}

async function persistCharacterEditorSessionStore(context, avatar, store) {
    await setCharacterState(
        avatar,
        CHARACTER_EDITOR_SESSION_NAMESPACE,
        normalizeCharacterEditorSessionStore(store),
    );
}

function upsertCharacterEditorSession(store, session) {
    const normalizedStore = normalizeCharacterEditorSessionStore(store);
    const normalizedSession = normalizeCharacterEditorSession(session);
    const nextSessions = normalizedStore.sessions.filter(item => String(item?.id || '') !== String(normalizedSession.id || ''));
    nextSessions.push(normalizedSession);
    nextSessions.sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    normalizedStore.sessions = nextSessions.slice(-CHARACTER_EDITOR_SESSION_LIMIT);
    return normalizedStore;
}

function deleteCharacterEditorSession(store, sessionId) {
    const normalizedStore = normalizeCharacterEditorSessionStore(store);
    const targetId = String(sessionId || '').trim();
    normalizedStore.sessions = normalizedStore.sessions.filter(item => String(item?.id || '') !== targetId);
    return normalizedStore;
}

function findCharacterEditorSession(store, sessionId) {
    const targetId = String(sessionId || '').trim();
    if (!targetId) {
        return null;
    }
    return (Array.isArray(store?.sessions) ? store.sessions : [])
        .find(item => String(item?.id || '') === targetId) || null;
}

function summarizeCharacterEditorSession(session, fallback = '') {
    const firstUserMessage = (Array.isArray(session?.messages) ? session.messages : [])
        .find(item => String(item?.role || '').trim().toLowerCase() === 'user');
    const summary = String(firstUserMessage?.content || '').trim() || String(fallback || '').trim();
    return summary.length > 72
        ? `${summary.slice(0, 72).trim()}...`
        : summary;
}

async function saveCharacterEditorConversationSession(context, session, { avatar = '', setCurrent = true } = {}) {
    const store = await loadCharacterEditorSessionStore(context, avatar);
    const saved = normalizeCharacterEditorSession({
        ...session,
        avatar,
        updatedAt: Date.now(),
    });
    const nextStore = upsertCharacterEditorSession(store, saved);
    if (!setCurrent) {
        const existing = findCharacterEditorSession(store, saved.id);
        if (!existing) {
            nextStore.sessions = nextStore.sessions
                .filter(item => String(item?.id || '') !== String(saved.id || ''))
                .concat(saved)
                .sort((left, right) => Number(left?.updatedAt || 0) - Number(right?.updatedAt || 0))
                .slice(-CHARACTER_EDITOR_SESSION_LIMIT);
        }
    }
    await persistCharacterEditorSessionStore(context, avatar, nextStore);
    return findCharacterEditorSession(nextStore, saved.id) || saved;
}

async function setCurrentCharacterEditorConversationSessionId(context, sessionId, { avatar = '' } = {}) {
    const id = String(sessionId || '').trim();
    const store = await loadCharacterEditorSessionStore(context, avatar);
    const session = findCharacterEditorSession(store, id);
    if (!session) {
        return null;
    }
    return await saveCharacterEditorConversationSession(context, {
        ...session,
        updatedAt: Date.now(),
    }, { avatar, setCurrent: true });
}

async function deleteCharacterEditorConversationSession(context, sessionId, { avatar = '' } = {}) {
    const id = String(sessionId || '').trim();
    if (!id) {
        return null;
    }
    const store = await loadCharacterEditorSessionStore(context, avatar);
    const existing = findCharacterEditorSession(store, id);
    if (!existing) {
        return null;
    }
    let nextStore = deleteCharacterEditorSession(store, id);
    let nextCurrent = nextStore.sessions.length > 0
        ? nextStore.sessions[nextStore.sessions.length - 1]
        : null;
    if (!nextCurrent) {
        nextCurrent = normalizeCharacterEditorSession({
            id: makeCharacterEditorSessionId(),
            avatar,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
            pendingApproval: null,
            rejectedOperationKeys: [],
        });
        nextStore = upsertCharacterEditorSession(nextStore, nextCurrent);
    }
    await persistCharacterEditorSessionStore(context, avatar, nextStore);
    return nextCurrent;
}

function nextStateId(state, prefix = 'op') {
    const id = `${prefix}_${Math.floor(Number(state.nextId || 1))}`;
    state.nextId = Math.max(1, Math.floor(Number(state.nextId || 1)) + 1);
    return id;
}

function getActiveCharacterRecord(context, { avatar = '' } = {}) {
    if (context.groupId) {
        throw new Error('Character editor assistant is unavailable in group chats.');
    }
    const preferredAvatar = String(avatar || '').trim();
    const characters = Array.isArray(context?.characters) ? context.characters : [];

    if (preferredAvatar) {
        const characterIndex = characters.findIndex(item => String(item?.avatar || '').trim() === preferredAvatar);
        if (characterIndex >= 0) {
            const character = characters[characterIndex];
            return {
                characterIndex,
                character,
                avatar: preferredAvatar,
            };
        }
        throw new Error(`Character not found for avatar: ${preferredAvatar}`);
    }

    const directIndex = context?.characterId;
    const directCharacter = characters?.[directIndex];
    if (directCharacter) {
        const resolvedAvatar = String(directCharacter?.avatar || '').trim();
        if (resolvedAvatar) {
            const resolvedIndex = Number.isInteger(Number(directIndex))
                ? Number(directIndex)
                : characters.findIndex(item => String(item?.avatar || '').trim() === resolvedAvatar);
            return {
                characterIndex: resolvedIndex,
                character: directCharacter,
                avatar: resolvedAvatar,
            };
        }
    }

    const currentChatId = String(context?.chatId || '').trim();
    if (currentChatId) {
        const characterIndex = characters.findIndex(item => String(item?.chat || '').trim() === currentChatId);
        if (characterIndex >= 0) {
            const character = characters[characterIndex];
            const resolvedAvatar = String(character?.avatar || '').trim();
            if (resolvedAvatar) {
                return {
                    characterIndex,
                    character,
                    avatar: resolvedAvatar,
                };
            }
        }
    }

    const activeName = String(context?.name2 || '').trim();
    if (activeName) {
        const characterIndex = characters.findIndex(item => String(item?.name || '').trim() === activeName);
        if (characterIndex >= 0) {
            const character = characters[characterIndex];
            const resolvedAvatar = String(character?.avatar || '').trim();
            if (resolvedAvatar) {
                return {
                    characterIndex,
                    character,
                    avatar: resolvedAvatar,
                };
            }
        }
    }

    throw new Error('No active character selected.');
}

async function mergeCharacterAttributes(context, avatar, patch) {
    const target = String(avatar || '').trim();
    if (!target) {
        return;
    }
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const characterIndex = characters.findIndex(item =>
        String(item?.avatar || '').trim() === target);
    if (characterIndex < 0) {
        throw new Error(`Character not found: ${target}`);
    }

    // Route the (historically hybrid) patch shape onto two persistence paths:
    //  - form-level fields collapse into a dot-path patch routed through
    //    `updateCharacterData` (which feeds `/api/characters/edit` with the
    //    server's form-friendly deep-merge behavior).
    //  - extension-level keys are written one-per-top-key via
    //    `writeExtensionField`, matching the replace-semantics contract.
    //
    // The legacy v1 root fields (description, personality, ...) and the v2
    // `data.*` fields collapse onto the same `data.<key>` target — the
    // server normalizes both input forms onto the v2 storage path on the
    // form path, and `projectRuntimeCharacterFields` mirrors v2 back to
    // root on reload.
    const formPatch = {};
    const extPatchesByTopKey = {};
    if (patch && typeof patch === 'object') {
        for (const [key, value] of Object.entries(patch)) {
            if (key === 'avatar') {
                continue;
            }
            if (key === 'data' && value && typeof value === 'object' && !Array.isArray(value)) {
                for (const [dataKey, dataValue] of Object.entries(value)) {
                    if (dataKey === 'extensions' && dataValue && typeof dataValue === 'object' && !Array.isArray(dataValue)) {
                        for (const [extKey, extValue] of Object.entries(dataValue)) {
                            // Replace semantics on each top-level extension key.
                            // For top-level scalars (world, talkativeness, fav) this is
                            // byte-identical to the previous deep-merge. For nested
                            // objects (depth_prompt, …) it wipes previous siblings —
                            // existing call sites all pass whole-blob updates, so this
                            // matches their intent. Callers wanting partial-blob overlay
                            // must build the merged value themselves before calling.
                            extPatchesByTopKey[extKey] = extValue;
                        }
                    } else {
                        formPatch[dataKey] = dataValue;
                    }
                }
            } else {
                formPatch[key] = value;
            }
        }
    }

    if (Object.keys(formPatch).length === 0 && Object.keys(extPatchesByTopKey).length === 0) {
        return;
    }

    if (Object.keys(formPatch).length > 0) {
        await context.updateCharacterData(characterIndex, formPatch, { immediate: true });
    }
    for (const [topKey, value] of Object.entries(extPatchesByTopKey)) {
        await context.writeExtensionField(characterIndex, topKey, value);
    }
}

/**
 * Apply a batch of Edit ops scoped to the character card and persist via
 * `mergeCharacterAttributes`. Used by the unified CEA editor's Apply commit
 * (editor-iteration/studio.js → _internalApplyPendingEdits). Studio.js
 * pre-groups its `pendingEdits` by `target.kind === 'character'` and hands
 * the slice here together with the live character snapshot the edits were
 * authored against.
 *
 * Diff-against-original guard: we only forward the per-key delta to
 * `mergeCharacterAttributes`, so a batch that no-ops (every key already
 * matches) skips the `updateCharacterData` round-trip entirely.
 *
 * @param {Object} context  SillyTavern context.
 * @param {string} avatar   Target character avatar.
 * @param {Array}  edits    Iter-library Edit[] scoped to the character.
 * @param {Object} [opts]
 * @param {Object} [opts.liveCharacter]  Pre-edit snapshot the edits were
 *                                       authored against. Defaults to {}.
 */
export async function commitCharacterEditorOperations(context, avatar, edits, opts = {}) {
    if (!Array.isArray(edits) || edits.length === 0) {
        return { applied: 0, conflicts: [], alreadyDone: [], persisted: false };
    }
    // Defensive: reject edits that target a field the LLM invented. The
    // tool schemas declare `field` as an enum, but providers occasionally
    // ignore enum constraints, and the engine would otherwise route a
    // `str_replace` on an unknown field through `anchor_missing` — a
    // confusing error message for "field doesn't exist." The set of
    // accepted fields matches `CEA_CARD_FIELD_ENUM` in
    // `editor-iteration/tools.js`; keep both in sync.
    const KNOWN_FIELDS = new Set([
        ...CHARACTER_EDITOR_ROOT_TEXT_FIELDS,
        ...CHARACTER_EDITOR_DATA_TEXT_FIELDS,
        ...CHARACTER_EDITOR_DATA_ARRAY_FIELDS,
    ]);
    const unknownFields = [];
    for (const edit of edits) {
        const path = String(edit?.path || '').trim();
        if (!path) continue;
        // The CEA editor's tools.js emits paths like `description` or
        // `card.description` (the latter rebased to bare by studio.js,
        // but defensive double-checks here in case the rebase missed).
        const field = path.startsWith('card.') ? path.slice('card.'.length) : path;
        // Skip nested paths (anything past the first dot) — those are
        // valid for sub-field edits and don't map to top-level enum.
        if (field.includes('.')) continue;
        if (!KNOWN_FIELDS.has(field)) {
            unknownFields.push(field);
        }
    }
    // Unknown-field rejection is a hard input error — the LLM invented a
    // schema, no edit in this batch can possibly land. Stay as a thrown
    // exception so studio's outer try/catch routes it to the system-error
    // path (same shape as IO failures). Only `applyEdits` conflict / drift
    // outcomes were re-shaped to a returned result so studio can surface
    // them on a per-edit basis to the AI.
    if (unknownFields.length > 0) {
        const unique = [...new Set(unknownFields)];
        throw new Error(
            `Apply rejected: unknown character card field(s) ${unique.map(f => `"${f}"`).join(', ')}. `
            + `Valid fields are: ${[...KNOWN_FIELDS].join(', ')}.`,
        );
    }
    const before = opts?.liveCharacter ? clone(opts.liveCharacter) : {};
    const result = applyEdits(edits, before) || {};
    const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
    const alreadyDone = Array.isArray(result.alreadyDone) ? result.alreadyDone : [];
    const clean = Array.isArray(result.clean) ? result.clean : [];
    if (conflicts.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[${MODULE_NAME}] commitCharacterEditorOperations conflicts`, conflicts);
    }
    const after = result.newLive || before;
    const patch = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
        if (!lodash.isEqual(before[k], after[k])) patch[k] = after[k];
    }
    let persisted = false;
    if (clean.length > 0 && Object.keys(patch).length > 0) {
        await mergeCharacterAttributes(context, avatar, patch);
        persisted = true;
    }
    return { applied: clean.length, conflicts, alreadyDone, persisted };
}

/**
 * Apply a batch of Edit ops scoped to a single lorebook and persist via
 * `context.saveWorldInfo`. Used by the unified CEA editor's Apply commit
 * (editor-iteration/studio.js → _internalApplyPendingEdits). Studio.js
 * pre-groups its `pendingEdits` by `target.kind === 'lorebook'` AND
 * `target.bookName`, then calls this helper once per book.
 *
 * No-op guard: when the post-apply book is byte-identical to the pre-apply
 * snapshot we skip `saveWorldInfo` entirely. `saveWorldInfo` bumps mtime
 * even on no-op writes, so downstream consumers (notably the world-info
 * preview pane) would otherwise see spurious change events.
 *
 * @param {string} bookName Target lorebook name (first arg by design — the
 *                          per-book commit is the dominant axis; context is
 *                          a context bag).
 * @param {Object} liveBook Pre-edit snapshot for this book — typically
 *                          `state.live.lorebooks[bookName]` shaped as
 *                          `{ entries, ...meta }`.
 * @param {Array}  edits    Iter-library Edit[] scoped to this single book.
 * @param {Object} [opts]
 * @param {Object} opts.context  SillyTavern context (for saveWorldInfo).
 */
export async function commitLorebookOperations(bookName, liveBook, edits, opts = {}) {
    if (!Array.isArray(edits) || edits.length === 0) {
        return { applied: 0, conflicts: [], alreadyDone: [], persisted: false };
    }
    const safeName = String(bookName || '').trim();
    if (!safeName) {
        return { applied: 0, conflicts: [], alreadyDone: [], persisted: false };
    }
    const context = opts?.context;
    if (!context || typeof context.saveWorldInfo !== 'function') {
        throw new TypeError('commitLorebookOperations: opts.context.saveWorldInfo is required');
    }
    // Detect a bookName-rename edit (cea_set_lorebook_metadata with key
    // `bookName`). The live-state apply path can only `saveWorldInfo(name, …)`
    // — it has no helper for the rename-then-delete-old-name dance that
    // `renameWorldInfo` in world-info.js performs (and that helper isn't
    // exposed on `context`). Without this guard the rename would silently
    // save the new content under the OLD filename, leaving the user staring
    // at unchanged data. Surface the limitation loudly so callers can route
    // the user to the world-info panel for now.
    const renameEdit = edits.find(e =>
        e && e.op === 'set'
        && (e.path === 'bookName' || e.path === 'lorebook.bookName')
        && String(e.newValue || '').trim() !== ''
        && String(e.newValue || '').trim() !== safeName,
    );
    if (renameEdit) {
        throw new Error(
            `Renaming lorebooks via cea_set_lorebook_metadata is not supported. `
            + `Use the world-info panel to rename "${safeName}" → "${String(renameEdit.newValue).trim()}".`,
        );
    }
    const before = liveBook ? clone(liveBook) : { entries: {} };
    const result = applyEdits(edits, before) || {};
    const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
    const alreadyDone = Array.isArray(result.alreadyDone) ? result.alreadyDone : [];
    const clean = Array.isArray(result.clean) ? result.clean : [];
    if (conflicts.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[${MODULE_NAME}] commitLorebookOperations conflicts for ${safeName}`, conflicts);
    }
    const after = result.newLive || before;
    let persisted = false;
    if (clean.length > 0 && !lodash.isEqual(before, after)) {
        await context.saveWorldInfo(safeName, after, true);
        persisted = true;
    }
    return { applied: clean.length, conflicts, alreadyDone, persisted };
}

async function syncWorldBindingUi(context, worldName = '') {
    const targetWorld = String(worldName || '').trim();
    const chid = Number(context?.characterId);

    // `#character_world` form sync is handled by `updateCharacterData`'s
    // built-in `syncCharacterFormFromData` — this function only owns the
    // surrounding header button state and lorebook-list refresh.
    if (Number.isInteger(chid) && chid >= 0) {
        jQuery('#set_character_world').data('chid', chid);
    }

    try {
        await updateWorldInfoList();
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to refresh world info list`, error);
    }

    const applyButtonState = () => {
        try {
            // First, apply the canonical check against the actual character binding.
            if (Number.isInteger(chid) && chid >= 0) {
                setWorldInfoButtonClass(chid);
            }

            // If binding exists but UI still not green, force class as a fallback.
            const shouldBeSet = Boolean(targetWorld);
            const isSet = jQuery('#set_character_world').hasClass('world_set')
                || jQuery('#world_button').hasClass('world_set');
            if (shouldBeSet && !isSet) {
                setWorldInfoButtonClass(undefined, true);
            } else if (!shouldBeSet && isSet) {
                setWorldInfoButtonClass(undefined, false);
            }
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to refresh world info button state`, error);
        }
    };

    applyButtonState();

    // Character data can land slightly later; re-apply once after the current tick.
    setTimeout(applyButtonState, 0);
    setTimeout(applyButtonState, 120);
}

function getPrimaryLorebookName(character) {
    return String(character?.data?.extensions?.world || '').trim();
}

function getLorebookNextUid(data) {
    const existing = Object.keys(data?.entries || {})
        .map(key => Number(key))
        .filter(Number.isFinite);
    return existing.length > 0 ? Math.max(...existing) + 1 : 0;
}

async function ensureLorebookExists(context, desiredName, fallbackName = 'Character Book') {
    const safeName = String(desiredName || '').trim() || String(fallbackName || 'Character Book').trim();
    const loaded = await context.loadWorldInfo(safeName);
    if (loaded && typeof loaded === 'object') {
        if (!loaded.entries || typeof loaded.entries !== 'object') {
            loaded.entries = {};
            await context.saveWorldInfo(safeName, loaded, true);
        }
        return safeName;
    }
    await context.saveWorldInfo(safeName, { entries: {} }, true);
    return safeName;
}

async function resolveTargetLorebook(context, record, {
    requestedName = '',
    createIfMissing = true,
    bindPrimaryWhenCreated = true,
} = {}) {
    const requested = String(requestedName || '').trim();
    if (requested) {
        const ensured = await ensureLorebookExists(context, requested, requested);
        if (!getPrimaryLorebookName(record.character) && bindPrimaryWhenCreated) {
            await mergeCharacterAttributes(context, record.avatar, {
                data: {
                    extensions: {
                        world: ensured,
                    },
                },
            });
            record.character = context.characters?.[record.characterIndex] || record.character;
            await syncWorldBindingUi(context, ensured);
        }
        return ensured;
    }

    const primary = getPrimaryLorebookName(record.character);
    if (primary) {
        return primary;
    }
    if (!createIfMissing) {
        return '';
    }

    const fallback = `Character Book ${String(record.character?.name || 'Character').replace(/[^a-z0-9 _-]/gi, '_').trim()}`;
    const created = await ensureLorebookExists(context, fallback, fallback);
    await mergeCharacterAttributes(context, record.avatar, {
        data: {
            extensions: {
                world: created,
            },
        },
    });
    record.character = context.characters?.[record.characterIndex] || record.character;
    await syncWorldBindingUi(context, created);
    return created;
}

async function loadLorebookData(context, bookName) {
    const data = await context.loadWorldInfo(bookName);
    if (data && typeof data === 'object') {
        if (!data.entries || typeof data.entries !== 'object') {
            data.entries = {};
        }
        return data;
    }
    return { entries: {} };
}

function normalizeLorebookEntryForSync(entry, uid) {
    const normalizeLineEndings = (value) => String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const source = entry && typeof entry === 'object' ? entry : {};
    const normalizedUid = Number.isInteger(asFiniteInteger(uid, null))
        ? Number(asFiniteInteger(uid, 0))
        : Number(asFiniteInteger(source.uid, 0) || 0);
    const rawDelay = source.delayUntilRecursion;
    let delayUntilRecursion;
    if (typeof rawDelay === 'number' && Number.isFinite(rawDelay)) {
        delayUntilRecursion = Math.max(0, Math.trunc(rawDelay));
    } else if (rawDelay === true) {
        delayUntilRecursion = 1;
    } else {
        delayUntilRecursion = 0;
    }
    return {
        uid: normalizedUid,
        comment: normalizeLineEndings(source.comment ?? ''),
        content: normalizeLineEndings(source.content ?? ''),
        key: Array.isArray(source.key) ? source.key.map(item => String(item ?? '').trim()).filter(Boolean) : [],
        keysecondary: Array.isArray(source.keysecondary) ? source.keysecondary.map(item => String(item ?? '').trim()).filter(Boolean) : [],
        selectiveLogic: asFiniteInteger(source.selectiveLogic, 0) ?? 0,
        order: asFiniteInteger(source.order, 0) ?? 0,
        position: asFiniteInteger(source.position, 0) ?? 0,
        depth: asFiniteInteger(source.depth, 0) ?? 0,
        disable: Boolean(source.disable),
        constant: Boolean(source.constant),
        excludeRecursion: Boolean(source.excludeRecursion),
        preventRecursion: Boolean(source.preventRecursion),
        delayUntilRecursion,
    };
}

function areLorebookEntriesEqualForSync(a, b) {
    return JSON.stringify(normalizeLorebookEntryForSync(a, a?.uid ?? 0)) === JSON.stringify(normalizeLorebookEntryForSync(b, b?.uid ?? 0));
}

function buildLorebookEntryUpsertArgs(bookName, uid, entry) {
    const normalized = normalizeLorebookEntryForSync(entry, uid);
    return {
        book_name: String(bookName || '').trim(),
        entry_uid: Number(normalized.uid),
        key_csv: normalized.key.join(', '),
        secondary_key_csv: normalized.keysecondary.join(', '),
        comment: normalized.comment,
        content: normalized.content,
        selective_logic: Number(normalized.selectiveLogic),
        order: Number(normalized.order),
        position: Number(normalized.position),
        depth: Number(normalized.depth),
        disable: Boolean(normalized.disable),
        constant: Boolean(normalized.constant),
        exclude_recursion: Boolean(normalized.excludeRecursion),
        prevent_recursion: Boolean(normalized.preventRecursion),
        delay_until_recursion: Number(normalized.delayUntilRecursion),
    };
}

async function captureCharacterLorebookSnapshot(context, character) {
    const target = character && typeof character === 'object' ? character : null;
    const avatar = String(target?.avatar || '').trim();
    const characterName = String(target?.name || '').trim();
    const bookName = String(getPrimaryLorebookName(target) || '').trim();
    let entries = {};
    if (bookName) {
        try {
            const data = await loadLorebookData(context, bookName);
            entries = clone(data.entries || {}) || {};
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to snapshot lorebook '${bookName}'`, error);
        }
    }
    return {
        avatar,
        characterName,
        bookName,
        entries,
        capturedAt: Date.now(),
    };
}

function compactEntryForModel(entry, uid) {
    return normalizeLorebookEntryForSync(entry, uid);
}

function getCharacterEditorSelectiveLogicLabel(value) {
    const numeric = asFiniteInteger(value, 0);
    return CHARACTER_EDITOR_SELECTIVE_LOGIC_LABELS[numeric] || CHARACTER_EDITOR_SELECTIVE_LOGIC_LABELS[0];
}

function normalizeCharacterEditorSearchMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === CHARACTER_EDITOR_SEARCH_MODE.ACTIVATION
        ? CHARACTER_EDITOR_SEARCH_MODE.ACTIVATION
        : CHARACTER_EDITOR_SEARCH_MODE.ANY;
}

function normalizeCharacterEditorQueryLimit(value, fallback = CHARACTER_EDITOR_QUERY_LIMIT_DEFAULT) {
    const numeric = asFiniteInteger(value, fallback);
    if (!Number.isInteger(numeric)) {
        return fallback;
    }
    return Math.max(1, Math.min(CHARACTER_EDITOR_QUERY_LIMIT_MAX, numeric));
}

function normalizeCharacterEditorLorebookUidRange(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return null;
    }

    const exact = text.match(/^(\d+)$/);
    if (exact) {
        const uid = asFiniteInteger(exact[1], null);
        if (!Number.isInteger(uid) || uid < 0) {
            throw new Error(`Invalid lorebook range: ${text}`);
        }
        return { start: uid, end: uid };
    }

    const rangeMatch = text.match(/^(\d+)?\s*(?:~|-|:|\.\.)\s*(\d+)?$/);
    if (!rangeMatch) {
        throw new Error(`Invalid lorebook range: ${text}. Use formats like 0~100, 50~, or ~100.`);
    }

    const startText = String(rangeMatch[1] ?? '').trim();
    const endText = String(rangeMatch[2] ?? '').trim();
    const start = startText ? asFiniteInteger(startText, null) : 0;
    const end = endText ? asFiniteInteger(endText, null) : Number.MAX_SAFE_INTEGER;

    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < 0) {
        throw new Error(`Invalid lorebook range: ${text}`);
    }
    if (start > end) {
        throw new Error(`Invalid lorebook range: ${text}. Range start must be <= end.`);
    }

    return { start, end };
}

function normalizeCharacterEditorDetailUids(value) {
    const source = Array.isArray(value) ? value : [];
    const unique = [];
    const seen = new Set();
    for (const item of source) {
        const uid = asFiniteInteger(item, null);
        if (!Number.isInteger(uid) || uid < 0 || seen.has(uid)) {
            continue;
        }
        seen.add(uid);
        unique.push(uid);
        if (unique.length >= CHARACTER_EDITOR_DETAIL_LIMIT_MAX) {
            break;
        }
    }
    return unique;
}

function normalizeCharacterEditorLorebookToolEntry(entry, uid, { includeContent = false, includeLayout = false } = {}) {
    const normalized = normalizeLorebookEntryForSync(entry, uid);
    const output = {
        uid: Number(normalized.uid),
        comment: String(normalized.comment || ''),
        key: Array.isArray(normalized.key) ? normalized.key.slice() : [],
        keysecondary: Array.isArray(normalized.keysecondary) ? normalized.keysecondary.slice() : [],
        selective_logic: getCharacterEditorSelectiveLogicLabel(normalized.selectiveLogic),
        constant: Boolean(normalized.constant),
        enabled: !normalized.disable,
    };
    if (includeLayout) {
        output.order = Number(normalized.order);
        output.position = Number(normalized.position);
        output.depth = Number(normalized.depth);
        output.exclude_recursion = Boolean(normalized.excludeRecursion);
        output.prevent_recursion = Boolean(normalized.preventRecursion);
        output.delay_until_recursion = Number(normalized.delayUntilRecursion);
    }
    if (includeContent) {
        output.content = String(normalized.content || '');
    }
    return output;
}

function summarizeCharacterEditorLorebookListEntry(entry, uid) {
    const normalized = normalizeCharacterEditorLorebookToolEntry(entry, uid);
    const name = clipLorebookDebugText(normalized.comment, 120).trim()
        || clipLorebookDebugText(normalized.key[0] || '', 120).trim()
        || `#${normalized.uid}`;
    return {
        uid: normalized.uid,
        name,
        enabled: normalized.enabled,
    };
}

function buildCharacterEditorLorebookStats(entries = {}) {
    const uids = Array.from(collectLorebookEntryUids(entries).values()).sort((a, b) => a - b);
    let enabledEntryCount = 0;
    let constantEntryCount = 0;
    let secondaryKeyEntryCount = 0;
    for (const uid of uids) {
        const entry = getLorebookEntryByUid(entries, uid);
        const normalized = normalizeCharacterEditorLorebookToolEntry(entry, uid);
        if (normalized.enabled) {
            enabledEntryCount += 1;
        }
        if (normalized.constant) {
            constantEntryCount += 1;
        }
        if (normalized.keysecondary.length > 0) {
            secondaryKeyEntryCount += 1;
        }
    }
    return {
        entry_count: uids.length,
        max_entry_uid: uids.length > 0 ? uids[uids.length - 1] : -1,
        enabled_entry_count: enabledEntryCount,
        constant_entry_count: constantEntryCount,
        secondary_key_entry_count: secondaryKeyEntryCount,
    };
}

function buildCharacterEditorContentExcerpt(text, query) {
    const rawText = String(text ?? '');
    const rawQuery = String(query ?? '').trim();
    if (!rawText || !rawQuery) {
        return null;
    }
    const haystack = rawText.toLocaleLowerCase();
    const needle = rawQuery.toLocaleLowerCase();
    const index = haystack.indexOf(needle);
    if (index < 0) {
        return null;
    }
    const start = Math.max(0, index - CHARACTER_EDITOR_MATCH_EXCERPT_RADIUS);
    const end = Math.min(rawText.length, index + rawQuery.length + CHARACTER_EDITOR_MATCH_EXCERPT_RADIUS);
    let excerpt = rawText.slice(start, end).replace(/\s+/g, ' ').trim();
    if (!excerpt) {
        return null;
    }
    if (start > 0) {
        excerpt = `…${excerpt}`;
    }
    if (end < rawText.length) {
        excerpt = `${excerpt}…`;
    }
    return excerpt;
}

function buildCharacterEditorLorebookMatch(entry, query, searchMode) {
    const text = String(query || '').trim();
    if (!text) {
        return {
            matched: true,
            score: 0,
            matchFields: [],
            matchedExcerpt: null,
        };
    }
    const queryLower = text.toLocaleLowerCase();
    const normalizedMode = normalizeCharacterEditorSearchMode(searchMode);
    const matchFields = [];
    let score = 0;
    let matchedExcerpt = null;
    const includeField = (value) => String(value ?? '').toLocaleLowerCase().includes(queryLower);
    const keyMatches = Array.isArray(entry?.key) && entry.key.some(includeField);
    const secondaryMatches = Array.isArray(entry?.keysecondary) && entry.keysecondary.some(includeField);
    if (normalizedMode === CHARACTER_EDITOR_SEARCH_MODE.ANY && includeField(entry?.comment)) {
        matchFields.push('comment');
        score += 400;
    }
    if (keyMatches) {
        matchFields.push('key');
        score += 320;
    }
    if (secondaryMatches) {
        matchFields.push('keysecondary');
        score += 280;
    }
    if (normalizedMode === CHARACTER_EDITOR_SEARCH_MODE.ANY && includeField(entry?.content)) {
        matchFields.push('content');
        score += 120;
        matchedExcerpt = buildCharacterEditorContentExcerpt(entry?.content, text);
    }
    return {
        matched: matchFields.length > 0,
        score,
        matchFields,
        matchedExcerpt,
    };
}

async function loadCharacterEditorPrimaryLorebookState(context, { avatar = '' } = {}) {
    const record = getActiveCharacterRecord(context, { avatar });
    const character = record.character || {};
    const bookName = getPrimaryLorebookName(character);
    const lorebookData = bookName ? await loadLorebookData(context, bookName) : { entries: {} };
    return {
        record,
        character,
        bookName,
        lorebookData,
    };
}

async function loadCharacterEditorLorebookByName(context, bookName) {
    const trimmed = String(bookName || '').trim();
    if (!trimmed) {
        throw new Error('book_name is required.');
    }
    const allBooks = typeof context?.getWorldInfoNames === 'function'
        ? context.getWorldInfoNames()
        : [];
    if (Array.isArray(allBooks) && allBooks.length > 0 && !allBooks.includes(trimmed)) {
        throw new Error(`World book "${trimmed}" not found.`);
    }
    const lorebookData = await loadLorebookData(context, trimmed);
    return { bookName: trimmed, lorebookData };
}

async function queryCharacterEditorLorebookEntries(context, args = {}) {
    const queryText = normalizeText(args?.text ?? '');
    const searchMode = normalizeCharacterEditorSearchMode(args?.search_mode);
    const hasConstantFilter = typeof args?.constant === 'boolean';
    const hasEnabledFilter = typeof args?.enabled === 'boolean';
    if (!queryText && !hasConstantFilter && !hasEnabledFilter) {
        throw new Error(`${TOOL_NAMES.QUERY_ENTRIES} requires text, constant, or enabled.`);
    }
    const limit = normalizeCharacterEditorQueryLimit(args?.limit);
    const state = await loadCharacterEditorLorebookByName(context, args?.book_name);
    const entries = state?.lorebookData?.entries && typeof state.lorebookData.entries === 'object'
        ? state.lorebookData.entries
        : {};

    const hits = [];
    const uids = Array.from(collectLorebookEntryUids(entries).values()).sort((a, b) => a - b);
    for (const uid of uids) {
        const rawEntry = getLorebookEntryByUid(entries, uid);
        const normalizedEntry = normalizeCharacterEditorLorebookToolEntry(rawEntry, uid, { includeContent: true });
        if (hasConstantFilter && normalizedEntry.constant !== Boolean(args.constant)) {
            continue;
        }
        if (hasEnabledFilter && normalizedEntry.enabled !== Boolean(args.enabled)) {
            continue;
        }
        const match = buildCharacterEditorLorebookMatch(normalizedEntry, queryText, searchMode);
        if (queryText && !match.matched) {
            continue;
        }
        hits.push({
            uid: normalizedEntry.uid,
            comment: normalizedEntry.comment,
            key: normalizedEntry.key,
            keysecondary: normalizedEntry.keysecondary,
            selective_logic: normalizedEntry.selective_logic,
            constant: normalizedEntry.constant,
            enabled: normalizedEntry.enabled,
            match_fields: match.matchFields,
            matched_excerpt: match.matchedExcerpt,
            _score: match.score,
        });
    }

    hits.sort((a, b) => {
        if (queryText) {
            if (b._score !== a._score) {
                return b._score - a._score;
            }
        }
        const aEntry = getLorebookEntryByUid(entries, a.uid);
        const bEntry = getLorebookEntryByUid(entries, b.uid);
        const aOrder = asFiniteInteger(aEntry?.order, 0) ?? 0;
        const bOrder = asFiniteInteger(bEntry?.order, 0) ?? 0;
        if (bOrder !== aOrder) {
            return bOrder - aOrder;
        }
        return a.uid - b.uid;
    });

    return {
        book_name: state.bookName,
        total_hits: hits.length,
        entries: hits.slice(0, limit).map(({ _score, ...entry }) => entry),
    };
}

async function listCharacterEditorLorebookEntries(context, args = {}) {
    const range = normalizeCharacterEditorLorebookUidRange(args?.range);
    const state = await loadCharacterEditorLorebookByName(context, args?.book_name);
    const entries = state?.lorebookData?.entries && typeof state.lorebookData.entries === 'object'
        ? state.lorebookData.entries
        : {};

    const uids = Array.from(collectLorebookEntryUids(entries).values()).sort((a, b) => a - b);
    const filteredUids = range
        ? uids.filter(uid => uid >= range.start && uid <= range.end)
        : uids;

    return {
        book_name: state.bookName,
        total_entries: uids.length,
        returned_entries: filteredUids.length,
        range: range ? { start_uid: range.start, end_uid: range.end } : null,
        entries: filteredUids.map((uid) => summarizeCharacterEditorLorebookListEntry(getLorebookEntryByUid(entries, uid), uid)),
    };
}

async function getCharacterEditorLorebookEntries(context, args = {}) {
    const uids = normalizeCharacterEditorDetailUids(args?.uids);
    if (uids.length === 0) {
        throw new Error(`${TOOL_NAMES.GET_ENTRIES} requires one or more valid uids.`);
    }
    const state = await loadCharacterEditorLorebookByName(context, args?.book_name);
    const entries = state?.lorebookData?.entries && typeof state.lorebookData.entries === 'object'
        ? state.lorebookData.entries
        : {};

    const output = [];
    const missing = [];
    for (const uid of uids) {
        const rawEntry = getLorebookEntryByUid(entries, uid);
        if (!rawEntry) {
            missing.push(uid);
            continue;
        }
        output.push(normalizeCharacterEditorLorebookToolEntry(rawEntry, uid, {
            includeContent: true,
            includeLayout: true,
        }));
    }

    return {
        book_name: state.bookName,
        entries: output,
        missing_uids: missing,
    };
}

/**
 * Compute the after-image for an `update_lorebook_entry` proposal without
 * touching disk. The iter-studio's lorebook-approval flow calls this from
 * the inline-executed tool path, then renders the {before, after} pair as
 * a pending diff card for the user to approve or reject. On Apply the
 * approved after-image is written via {@link applyCharacterEditorLorebookCommit}.
 *
 * @returns {{ ok: true, book_name: string, uid: number, kind: 'update',
 *             before: object, after: object, updated_fields: string[] }}
 */
async function computeCharacterEditorLorebookUpdate(context, args = {}) {
    const bookName = String(args?.book_name || '').trim();
    if (!bookName) {
        throw new Error(`${TOOL_NAMES.UPDATE_ENTRY} requires book_name.`);
    }
    const uid = asFiniteInteger(args?.uid, null);
    if (!Number.isInteger(uid) || uid < 0) {
        throw new Error(`${TOOL_NAMES.UPDATE_ENTRY} requires a non-negative integer uid.`);
    }
    const patch = args?.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error(`${TOOL_NAMES.UPDATE_ENTRY} requires a patch object.`);
    }
    const patchKeys = Object.keys(patch);
    if (patchKeys.length === 0) {
        throw new Error(`${TOOL_NAMES.UPDATE_ENTRY} patch must contain at least one field.`);
    }
    const data = await context.loadWorldInfo(bookName);
    if (!data) {
        throw new Error(`World book "${bookName}" not found.`);
    }
    const entry = data.entries?.[uid];
    if (!entry) {
        throw new Error(`Entry uid ${uid} not found in "${bookName}".`);
    }
    // Deep-clone via structuredClone so the proposal carries an independent
    // before-snapshot and the after image cannot mutate the cached entry.
    const before = structuredClone(entry);
    const after = structuredClone(entry);
    Object.assign(after, patch);
    // uid is the address, not a payload field — guard against patches that
    // try to rewrite it.
    after.uid = uid;
    return {
        ok: true,
        book_name: bookName,
        uid,
        kind: 'update',
        before,
        after,
        updated_fields: patchKeys.filter(k => k !== 'uid'),
    };
}

/**
 * Compute the after-image for a `str_replace_in_lorebook_entry` proposal
 * without touching disk. Validates the single-match contract (old_str must
 * appear exactly once in the entry's current content). On Apply the
 * approved after-image is written via {@link applyCharacterEditorLorebookCommit}.
 *
 * @returns {{ ok: true, book_name: string, uid: number, kind: 'str_replace',
 *             before: object, after: object, replaced_chars: number, new_chars: number }}
 */
async function computeCharacterEditorLorebookStrReplace(context, args = {}) {
    const bookName = String(args?.book_name || '').trim();
    if (!bookName) {
        throw new Error(`${TOOL_NAMES.STR_REPLACE_IN_ENTRY} requires book_name.`);
    }
    const uid = asFiniteInteger(args?.uid, null);
    if (!Number.isInteger(uid) || uid < 0) {
        throw new Error(`${TOOL_NAMES.STR_REPLACE_IN_ENTRY} requires a non-negative integer uid.`);
    }
    if (typeof args?.old_str !== 'string' || args.old_str.length === 0) {
        throw new Error(`${TOOL_NAMES.STR_REPLACE_IN_ENTRY} requires a non-empty old_str.`);
    }
    if (typeof args?.new_str !== 'string') {
        throw new Error(`${TOOL_NAMES.STR_REPLACE_IN_ENTRY} requires new_str (use an empty string to delete).`);
    }
    const data = await context.loadWorldInfo(bookName);
    if (!data) {
        throw new Error(`World book "${bookName}" not found.`);
    }
    const entry = data.entries?.[uid];
    if (!entry) {
        throw new Error(`Entry uid ${uid} not found in "${bookName}".`);
    }
    const content = String(entry.content ?? '');
    const firstIdx = content.indexOf(args.old_str);
    if (firstIdx === -1) {
        throw new Error(`old_str not found in entry ${uid} of "${bookName}".`);
    }
    if (content.indexOf(args.old_str, firstIdx + args.old_str.length) !== -1) {
        // Refuse multi-site edits — caller must narrow old_str to a unique
        // match. Same contract Anthropic's str_replace_based_edit_tool uses.
        throw new Error(`old_str occurs more than once in entry ${uid} of "${bookName}"; narrow it to a unique substring.`);
    }
    const before = structuredClone(entry);
    const after = structuredClone(entry);
    after.content = content.slice(0, firstIdx) + args.new_str + content.slice(firstIdx + args.old_str.length);
    after.uid = uid;
    return {
        ok: true,
        book_name: bookName,
        uid,
        kind: 'str_replace',
        before,
        after,
        replaced_chars: args.old_str.length,
        new_chars: args.new_str.length,
    };
}

/**
 * Commit an approved lorebook-edit proposal to disk. Loads the book, copies
 * the supplied `after` entry into `data.entries[uid]` (preserving uid as the
 * address), and saves. Iter-studio's Apply path calls this once per approved
 * pending edit, sequentially; if a commit throws the caller logs + halts
 * (no rollback across entries — successive WorldInfo writes are independent
 * file ops, and a partial commit just leaves the on-disk book at the state
 * of the last successful entry).
 *
 * @param {object} context  SillyTavern context (provides load/saveWorldInfo).
 * @param {object} arg
 * @param {string} arg.book_name
 * @param {number} arg.uid
 * @param {object} arg.after  Full entry shape (deep-cloned from the proposal
 *                            so concurrent edits in the popup cannot leak in).
 * @returns {Promise<{ ok: true, book_name: string, uid: number }>}
 */
export async function applyCharacterEditorLorebookCommit(context, { book_name, uid, after } = {}) {
    const bookName = String(book_name || '').trim();
    if (!bookName) {
        throw new Error('applyCharacterEditorLorebookCommit: book_name is required.');
    }
    if (!Number.isInteger(uid) || uid < 0) {
        throw new Error('applyCharacterEditorLorebookCommit: uid must be a non-negative integer.');
    }
    if (!after || typeof after !== 'object' || Array.isArray(after)) {
        throw new Error('applyCharacterEditorLorebookCommit: after must be an object.');
    }
    const data = await context.loadWorldInfo(bookName);
    if (!data) {
        throw new Error(`World book "${bookName}" not found.`);
    }
    const entry = data.entries?.[uid];
    if (!entry) {
        throw new Error(`Entry uid ${uid} not found in "${bookName}".`);
    }
    // Merge after over the live entry rather than wholesale-replacing the
    // reference — preserves any non-payload bookkeeping fields the WorldInfo
    // runtime may have stamped between proposal time and Apply time.
    Object.assign(entry, after);
    entry.uid = uid;
    await context.saveWorldInfo(bookName, data, true);
    return { ok: true, book_name: bookName, uid };
}

/**
 * Apply-time commit that re-derives the after-image from the proposal's
 * original tool args against the entry's CURRENT on-disk state, then
 * writes once. This is the path the iter-studio approval flow uses so
 * that:
 *
 *   1. Multiple approved proposals targeting the same book#uid chain
 *      correctly (proposal B's mutation lands on top of proposal A's
 *      already-committed mutation, rather than B's stale `after` snapshot
 *      clobbering A's change).
 *   2. Concurrent drift (a parallel session edited the book between
 *      proposal time and Apply time) surfaces as a fresh validation
 *      error — for `str_replace`, the unique-match guard fires; for
 *      `update`, the shallow merge still lands but on the current
 *      content rather than the proposal author's expectation.
 *
 * The proposal's `kind` and original `args` are required; the snapshot
 * `after` captured at proposal time is intentionally NOT passed here.
 */
export async function applyCharacterEditorLorebookProposal(context, { kind, args } = {}) {
    const safeArgs = (args && typeof args === 'object') ? args : {};
    let computed;
    if (kind === 'update') {
        computed = await computeCharacterEditorLorebookUpdate(context, safeArgs);
    } else if (kind === 'str_replace') {
        computed = await computeCharacterEditorLorebookStrReplace(context, safeArgs);
    } else {
        throw new Error(`applyCharacterEditorLorebookProposal: unknown kind "${kind}"`);
    }
    return applyCharacterEditorLorebookCommit(context, {
        book_name: computed.book_name,
        uid: computed.uid,
        after: computed.after,
    });
}

function createCharacterEditorLorebookToolApi(context, { avatar = '' } = {}) {
    const toolNames = Object.freeze({
        LIST: TOOL_NAMES.LIST_ENTRIES,
        QUERY: TOOL_NAMES.QUERY_ENTRIES,
        GET: TOOL_NAMES.GET_ENTRIES,
    });
    return {
        toolNames,
        getToolDefs: () => [
            {
                type: 'function',
                function: {
                    name: toolNames.LIST,
                    description: `List compact lorebook entry index rows for a world book. Returns only uid, name, and enabled. Call ${TOOL_NAMES.LIST_WORLD_BOOKS} first to know which book names exist. Optional range narrows the inclusive UID window, for example 0~100.`,
                    parameters: {
                        type: 'object',
                        properties: {
                            book_name: {
                                type: 'string',
                                description: 'Required. Target world book. Must match a name returned by list_world_books.',
                            },
                            range: {
                                type: 'string',
                                description: 'Optional inclusive UID range such as 0~100, 50~, ~100, or a single uid like 42.',
                            },
                        },
                        required: ['book_name'],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: toolNames.QUERY,
                    description: `Search a world book and return lightweight matching entries. Call ${TOOL_NAMES.LIST_WORLD_BOOKS} first to know which book names exist. Use this before ${toolNames.GET} to narrow candidates.`,
                    parameters: {
                        type: 'object',
                        properties: {
                            book_name: {
                                type: 'string',
                                description: 'Required. Target world book.',
                            },
                            text: { type: 'string' },
                            search_mode: {
                                type: 'string',
                                enum: [CHARACTER_EDITOR_SEARCH_MODE.ANY, CHARACTER_EDITOR_SEARCH_MODE.ACTIVATION],
                            },
                            constant: { type: 'boolean' },
                            enabled: { type: 'boolean' },
                            limit: { type: 'integer', minimum: 1, maximum: CHARACTER_EDITOR_QUERY_LIMIT_MAX },
                        },
                        required: ['book_name'],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: toolNames.GET,
                    description: `Fetch full lorebook entries from a world book by uid after narrowing candidates with ${toolNames.QUERY}.`,
                    parameters: {
                        type: 'object',
                        properties: {
                            book_name: {
                                type: 'string',
                                description: 'Required. Target world book.',
                            },
                            uids: {
                                type: 'array',
                                items: { type: 'integer' },
                                minItems: 1,
                                maxItems: CHARACTER_EDITOR_DETAIL_LIMIT_MAX,
                            },
                        },
                        required: ['book_name', 'uids'],
                        additionalProperties: false,
                    },
                },
            },
        ],
        isToolName: (name) => {
            const normalized = String(name || '').trim();
            return normalized === toolNames.LIST || normalized === toolNames.QUERY || normalized === toolNames.GET;
        },
        invoke: async (call) => {
            const name = String(call?.name || '').trim();
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            if (name === toolNames.LIST) {
                return await listCharacterEditorLorebookEntries(context, args);
            }
            if (name === toolNames.QUERY) {
                return await queryCharacterEditorLorebookEntries(context, args);
            }
            if (name === toolNames.GET) {
                return await getCharacterEditorLorebookEntries(context, args);
            }
            throw new Error(`Unsupported character editor lorebook tool: ${name}`);
        },
    };
}

/**
 * Helper-tool API for lorebook write *proposals* (update + str_replace).
 * Used by iter popups whose Apply path is approval-gated — invoking a tool
 * here NEVER touches disk. The dispatcher returns a {before, after, kind}
 * envelope that the popup captures as a pending diff card; commits happen
 * only when the user clicks Apply, via {@link applyCharacterEditorLorebookCommit}.
 *
 * The tool schemas are owned by `iteration-library/tools/lorebook-writes.js`
 * — this api only owns the legacy wire-name dispatch.
 */
function createCharacterEditorLorebookWriteToolApi(context, { avatar = '' } = {}) {
    const toolNames = Object.freeze({
        UPDATE: TOOL_NAMES.UPDATE_ENTRY,
        STR_REPLACE: TOOL_NAMES.STR_REPLACE_IN_ENTRY,
    });
    return {
        toolNames,
        // No schemas here on purpose — popups that splice these tools take
        // the OpenAI defs from iteration-library/tools/lorebook-writes.js,
        // which is the single source of truth for the model-facing shape.
        // Kept as an empty function so api-shape guards that check for
        // `typeof api.getToolDefs === 'function'` still pass.
        getToolDefs: () => [],
        isToolName: (name) => {
            const normalized = String(name || '').trim();
            return normalized === toolNames.UPDATE || normalized === toolNames.STR_REPLACE;
        },
        invoke: async (call) => {
            const name = String(call?.name || '').trim();
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            // Proposal mode: returns {before, after, kind, ...} without
            // touching disk. The iter-studio captures the result, renders
            // it as a pending diff card for user approval, and only commits
            // via applyCharacterEditorLorebookCommit at Apply time.
            if (name === toolNames.UPDATE) {
                return await computeCharacterEditorLorebookUpdate(context, args);
            }
            if (name === toolNames.STR_REPLACE) {
                return await computeCharacterEditorLorebookStrReplace(context, args);
            }
            throw new Error(`Unsupported character editor lorebook write tool: ${name}`);
        },
    };
}

function buildCharacterEditorSimulationSourceMessages(context, {
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

function createCharacterEditorSimulateToolApi(context) {
    const toolNames = Object.freeze({
        SIMULATE: TOOL_NAMES.SIMULATE_PROMPT,
    });
    return {
        toolNames,
        getToolDefs: () => [
            {
                type: 'function',
                function: {
                    name: toolNames.SIMULATE,
                    description: 'Simulate the current card under the live chat, world info, and preset. Pass text=<user turn> and the simulator appends it to the active chat, runs a real (non-persisted) generation, and opens a popup for the user to review. The messages mode is currently unsupported by the generation backend; pass text instead.',
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
            },
        ],
        isToolName: (name) => String(name || '').trim() === toolNames.SIMULATE,
        invoke: async (call) => {
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            // SillyTavern's context.t is the template-tag function
            // t(strings, ...values); the simulation-review module needs a
            // (key, fallback)-shaped helper. context.translate(text, key)
            // looks the fallback string up by key and returns the
            // fallback unchanged when no translation exists.
            const translateFn = typeof context?.translate === 'function'
                ? context.translate
                : (typeof globalThis !== 'undefined' && globalThis.__i18n && typeof globalThis.__i18n.translate === 'function'
                    ? globalThis.__i18n.translate
                    : null);
            const i18nFn = (k, fb) => (translateFn ? translateFn(fb || k, k) : (fb || k));
            const source = buildCharacterEditorSimulationSourceMessages(context, {
                text: String(args.text || '').trim(),
                messages: Array.isArray(args.messages) ? args.messages : null,
            });
            if (source.messages.length === 0) {
                throw new Error(`${toolNames.SIMULATE} requires either text or messages.`);
            }
            if (source.mode === 'messages') {
                return {
                    ok: false,
                    toolResultText: buildCharacterEditorSimulationErrorResult(new Error(
                        'simulate_prompt does not support the messages-mode input under the current generation backend. Pass text=<single user turn> and the simulator will append it to the live chat.',
                    )),
                };
            }
            if (typeof context?.buildPresetAwarePromptMessages !== 'function') {
                throw new Error('Prompt preset assembly is unavailable.');
            }

            const runOneCeaSimulationAttempt = async () => {
                const runtimeWorldInfo = typeof context?.resolveWorldInfoForMessages === 'function'
                    ? await context.resolveWorldInfoForMessages(source.messages, {
                        type: 'quiet',
                        fallbackToCurrentChat: false,
                        postActivationHook: rewriteDepthWorldInfoToAfterWithNotes,
                    })
                    : {};

                // Subscribe to CHAT_COMPLETION_PROMPT_READY during the real
                // generateQuietPrompt call so the popup's assembledPrompt
                // reflects the actual prompt array the model receives —
                // including token-budget pruning, system-message squashing,
                // and any extension-driven mutation. Register the listener
                // last so it fires after extension hooks (those typically
                // register with `on`, not `makeLast`). If capture fails, we
                // fall back to the parallel buildPresetAwarePromptMessages
                // path below so the popup still renders something.
                const src = context?.eventSource ?? null;
                const eventName = context?.eventTypes?.CHAT_COMPLETION_PROMPT_READY
                    ?? 'chat_completion_prompt_ready';
                let capturedPromptArray = null;
                const listener = (eventData) => {
                    const chat = Array.isArray(eventData) ? eventData : eventData?.chat;
                    if (!Array.isArray(chat)) return;
                    try { capturedPromptArray = structuredClone(chat); }
                    catch { capturedPromptArray = chat; }
                };
                const registerLast = src && typeof src.makeLast === 'function'
                    ? src.makeLast.bind(src)
                    : src?.on?.bind(src);
                if (registerLast) registerLast(eventName, listener);

                // Run the real (non-persisting) generation so the popup
                // shows the model's actual output, not just the assembled
                // prompt. generateQuietPrompt routes through Generate('quiet'),
                // which executes the full pipeline (WI, regex, depth, preset,
                // group routing) without writing the result to chat.
                const lastUserMsg = source.messages.slice().reverse().find(m => m.role === 'user' || m.is_user);
                const quietPrompt = String(lastUserMsg?.content || lastUserMsg?.mes || '');
                let finalOutput = '';
                try {
                    const generated = await generateQuietPrompt({
                        quietPrompt,
                        quietToLoud: false,
                        skipWIAN: false,
                        removeReasoning: false,
                    });
                    finalOutput = String(generated || '');
                } finally {
                    if (src && typeof src.removeListener === 'function') {
                        try { src.removeListener(eventName, listener); } catch (_) { /* best-effort */ }
                    }
                }

                let assembledPrompt;
                let promptMessagesForCaller;
                if (Array.isArray(capturedPromptArray) && capturedPromptArray.length > 0) {
                    assembledPrompt = {
                        systemPrompt: extractSystemFromCapturedPrompt(capturedPromptArray),
                        messages: extractNonSystemFromCapturedPrompt(capturedPromptArray),
                    };
                    promptMessagesForCaller = capturedPromptArray;
                } else {
                    const promptMessages = context.buildPresetAwarePromptMessages({
                        messages: source.messages,
                        envelopeOptions: {
                            includeCharacterCard: true,
                            api: String(context?.mainApi || 'openai').trim() || 'openai',
                        },
                        runtimeWorldInfo,
                    });
                    assembledPrompt = {
                        systemPrompt: extractSystemPromptForCharacterEditorSimulation(promptMessages),
                        messages: extractNonSystemMessagesForCharacterEditorSimulation(promptMessages),
                    };
                    promptMessagesForCaller = promptMessages;
                }

                const worldInfoHits = extractWorldInfoHitsForCharacterEditorSimulation(runtimeWorldInfo);
                const payload = {
                    finalOutput,
                    reasoning: '',
                    assembledPrompt,
                    worldInfoHits,
                };
                return { payload, worldInfoHits, promptMessages: promptMessagesForCaller, runtimeWorldInfo };
            };

            let firstAttempt;
            try {
                firstAttempt = await runOneCeaSimulationAttempt();
            } catch (err) {
                return {
                    ok: false,
                    toolResultText: buildCharacterEditorSimulationErrorResult(err),
                };
            }

            const review = await openSimulationReview({
                kind: 'cea',
                payload: firstAttempt.payload,
                worldInfoHits: firstAttempt.worldInfoHits,
                i18n: i18nFn,
                onRerun: async () => {
                    const next = await runOneCeaSimulationAttempt();
                    return { payload: next.payload, worldInfoHits: next.worldInfoHits };
                },
            });

            return {
                ok: review.ok,
                cancelled: review.cancelled,
                toolResultText: review.toolResultText,
                // Legacy fields kept so any caller still inspecting them
                // doesn't break. The new tagged-text envelope on
                // toolResultText is the canonical workbench-LLM channel.
                mode: source.mode,
                sourceMessages: source.messages,
                runtimeWorldInfo: firstAttempt.runtimeWorldInfo,
                promptMessages: firstAttempt.promptMessages,
            };
        },
    };
}

function clipLorebookDebugText(value, maxLength = 80) {
    const text = String(value ?? '');
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength)}…`;
}

function extractSystemPromptForCharacterEditorSimulation(promptMessages) {
    if (!Array.isArray(promptMessages)) return '';
    const first = promptMessages.find(m => (m?.role || '').toLowerCase() === 'system');
    return String(first?.content || '');
}

function extractNonSystemMessagesForCharacterEditorSimulation(promptMessages) {
    if (!Array.isArray(promptMessages)) return [];
    return promptMessages
        .filter(m => (m?.role || '').toLowerCase() !== 'system')
        .map(m => ({ role: String(m?.role || ''), content: String(m?.content || '') }));
}

// World-info attribution for the simulation-review popup. The runtime
// returned by resolveWorldInfoForMessages now carries an activatedEntries[]
// array with per-entry book + comment names; we delegate to the shared
// extractor in iteration-library/simulation-review/wi-hits.js so CEA and
// CPA stay in sync. The shared helper falls back to walking the
// pre-formatted text buckets if activatedEntries[] is absent (legacy host).
function extractWorldInfoHitsForCharacterEditorSimulation(runtimeWorldInfo) {
    return extractWorldInfoHitsFromRuntime(runtimeWorldInfo);
}

function buildCharacterEditorSimulationErrorResult(err) {
    return `<simulation_result kind="cea" ok="false">\n\n<error reason="simulation_failed">\n${String(err?.message || err || '')}\n</error>\n\n</simulation_result>`;
}

function createCharacterEditorWorldBookListToolApi(context, { avatar = '' } = {}) {
    const toolNames = Object.freeze({
        LIST_WORLD_BOOKS: TOOL_NAMES.LIST_WORLD_BOOKS,
    });
    return {
        toolNames,
        getToolDefs: () => [
            {
                type: 'function',
                function: {
                    name: toolNames.LIST_WORLD_BOOKS,
                    description: 'List world book names visible to the character being edited, tagged with their scope. Sources: \'character\' (the card\'s primary book at character.data.extensions.world), \'character_aux\' (auxiliary books bound via Luker\'s lorebook editor at world_info.charLore[].extraBooks), \'chat\' (chat-bound books from chat_metadata.world_info — only the active chat), and \'global\' (selected_world_info — books active for every chat). Returns { books: string[], sources: { [name]: scope } } so you can tell which scope owns each book without inspecting the card directly.',
                    parameters: {
                        type: 'object',
                        properties: {},
                        additionalProperties: false,
                    },
                },
            },
        ],
        isToolName: (name) => String(name || '').trim() === toolNames.LIST_WORLD_BOOKS,
        invoke: async () => {
            const characters = Array.isArray(context?.characters) ? context.characters : [];
            const preferredAvatar = String(avatar || '').trim();
            const character = preferredAvatar
                ? characters.find(item => String(item?.avatar || '').trim() === preferredAvatar)
                : characters[context?.characterId];

            const books = [];
            const sources = {};
            const push = (name, source) => {
                const trimmed = String(name || '').trim();
                if (!trimmed || sources[trimmed]) return;
                sources[trimmed] = source;
                books.push(trimmed);
            };

            push(character?.data?.extensions?.world, 'character');

            const fileName = character?.avatar
                ? getCharaFilename(null, { manualAvatarKey: character.avatar })
                : '';
            for (const name of getCharaAuxWorlds(fileName)) push(name, 'character_aux');

            try {
                for (const name of getChatWorldInfoNames(context?.chatMetadata)) push(name, 'chat');
            } catch { /* chat metadata may be unavailable */ }

            const globalSelection = __ctx.chatWorldInfo.globalSelection;
            if (Array.isArray(globalSelection)) {
                for (const name of globalSelection) push(name, 'global');
            }

            return { books, sources };
        },
    };
}

function renderLorebookSyncAnalysisMarkdown(markdownText) {
    const source = String(markdownText || '').trim();
    if (!source) {
        return `<div class="cea_sync_analysis_empty">${escapeHtml(i18n('No analysis output.'))}</div>`;
    }
    try {
        const converter = __ctx.markdownConverter;
        const html = converter?.makeHtml
            ? converter.makeHtml(source)
            : `<pre>${escapeHtml(source)}</pre>`;
        return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    } catch {
        return `<pre>${escapeHtml(source)}</pre>`;
    }
}

function getLorebookEntryByUid(entries, uid) {
    if (!entries || typeof entries !== 'object') {
        return null;
    }
    if (Object.hasOwn(entries, uid)) {
        return entries[uid] ?? null;
    }
    const key = String(uid);
    if (Object.hasOwn(entries, key)) {
        return entries[key] ?? null;
    }
    return null;
}

function isAbortSignalLike(value) {
    return Boolean(value && typeof value === 'object' && 'aborted' in value);
}

function isAbortError(error, abortSignal = null) {
    if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
        return true;
    }
    const name = String(error?.name || '').toLowerCase();
    if (name === 'aborterror') {
        return true;
    }
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('aborted') || message.includes('abort');
}

function createAbortError(message = 'Operation aborted.') {
    try {
        return new DOMException(String(message || 'Operation aborted.'), 'AbortError');
    } catch {
        const error = new Error(String(message || 'Operation aborted.'));
        error.name = 'AbortError';
        return error;
    }
}

function throwIfAborted(abortSignal, message = 'Operation aborted.') {
    if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
        throw createAbortError(message);
    }
}

function collectLorebookEntryUids(entries) {
    const output = new Set();
    for (const [rawUid, entry] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
        const uid = asFiniteInteger(rawUid, asFiniteInteger(entry?.uid, null));
        if (Number.isInteger(uid) && uid >= 0) {
            output.add(uid);
        }
    }
    return output;
}

function buildLorebookDraftDiffPreview(operation, targetBook, beforeEntry, afterEntry) {
    const kind = String(operation?.kind || '');
    const args = operation?.args && typeof operation.args === 'object' ? operation.args : {};
    const entryUid = asFiniteInteger(args.entry_uid, null);
    const beforeNormalized = beforeEntry ? normalizeLorebookEntryForSync(beforeEntry, entryUid) : null;
    const afterNormalized = afterEntry ? normalizeLorebookEntryForSync(afterEntry, entryUid) : null;
    if (kind === 'lorebook_upsert_entry' && beforeNormalized && afterNormalized && areLorebookEntriesEqualForSync(beforeNormalized, afterNormalized)) {
        return null;
    }
    if (kind === 'lorebook_delete_entry' && !beforeNormalized) {
        return null;
    }
    const preview = {
        title: buildOperationSummary(operation),
        fields: [],
        meta: [
            {
                label: i18n('Target lorebook'),
                value: String(targetBook || i18n('(missing lorebook)')),
            },
            {
                label: i18n('Entry UID'),
                value: Number.isInteger(entryUid) ? String(entryUid) : '?',
            },
        ],
        rawArgs: clone(args || {}),
    };

    // Field specs are diff-driven (compare normalized before vs after) rather
    // than args-driven. The AI tool schema permits passing the entry as a
    // nested `{ entry: {...} }` object instead of flat keys; the old
    // touched-args path missed every field in that case and fell through to a
    // useless full-JSON diff. Comparing the normalized snapshot pair sidesteps
    // that — we render exactly the fields that actually changed regardless of
    // how the AI shaped its call.
    const FIELD_SPECS = [
        { label: 'comment', key: 'comment' },
        { label: 'content', key: 'content' },
        { label: 'keywords', key: 'key' },
        { label: 'secondary keywords', key: 'keysecondary' },
        { label: 'selective logic', key: 'selectiveLogic' },
        { label: 'order', key: 'order' },
        { label: 'position', key: 'position' },
        { label: 'depth', key: 'depth' },
        { label: 'probability', key: 'probability' },
        { label: 'enabled', key: 'enabled' },
        { label: 'constant', key: 'constant' },
        { label: 'vectorized', key: 'vectorized' },
        { label: 'excludeRecursion', key: 'excludeRecursion' },
        { label: 'preventRecursion', key: 'preventRecursion' },
        { label: 'group', key: 'group' },
        { label: 'role', key: 'role' },
    ];

    if (kind === 'lorebook_delete_entry') {
        // Pre-deletion snapshot of the key user-facing fields, force-rendered
        // (before may be the same as the synthetic "(deleted)" if the field
        // was empty) so the user sees what's about to disappear.
        const summaryKeys = ['comment', 'content', 'key', 'keysecondary'];
        for (const key of summaryKeys) {
            const spec = FIELD_SPECS.find((s) => s.key === key);
            if (!spec) continue;
            const beforeValue = getEntryPreviewValue(beforeNormalized, spec.key);
            pushDiffField(preview.fields, spec.label, beforeValue, i18n('(deleted)'), { force: true });
        }
        return preview;
    }

    for (const spec of FIELD_SPECS) {
        const beforeValue = beforeNormalized ? getEntryPreviewValue(beforeNormalized, spec.key) : '';
        const afterValue = afterNormalized ? getEntryPreviewValue(afterNormalized, spec.key) : '';
        // Force-render every populated field on a brand-new entry so the user
        // can review what they're about to add (no `before` to diff against).
        const forceForNewEntry = !beforeNormalized && afterValue !== '' && afterValue != null
            && !(Array.isArray(afterValue) && afterValue.length === 0);
        pushDiffField(preview.fields, spec.label, beforeValue, afterValue, { force: forceForNewEntry });
    }

    if (preview.fields.length === 0) {
        // Both sides materially identical except for ordering / whitespace —
        // surface a one-line "no effective change" hint instead of dumping the
        // entry JSON. Caller-side filtering usually catches this case via
        // areLorebookEntriesEqualForSync above, so we rarely land here.
        pushDiffField(preview.fields, 'entry', i18n('(no effective change)'), i18n('(no effective change)'), { force: true });
    }
    return preview;
}

function cacheLorebookSnapshot(snapshot) {
    const safeSnapshot = snapshot && typeof snapshot === 'object' ? clone(snapshot) : null;
    const avatar = String(safeSnapshot?.avatar || '').trim();
    if (!safeSnapshot || !avatar) {
        return;
    }
    lorebookSnapshotCache.set(avatar, safeSnapshot);
}

const LINE_DIFF_LONG_CHAR_THRESHOLD = 900;
const LINE_DIFF_LONG_LINE_THRESHOLD = 18;
const LINE_DIFF_LCS_MAX_CELLS = 240000;

function splitLineDiffText(text) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n');
    return normalized.length > 0 ? normalized.split('\n') : [];
}

function buildLineDiffOperations(beforeLines, afterLines) {
    const a = Array.isArray(beforeLines) ? beforeLines : [];
    const b = Array.isArray(afterLines) ? afterLines : [];
    if (a.length === 0 && b.length === 0) {
        return [];
    }
    if (a.length === 0) {
        return [{ type: 'insert', lines: b.slice() }];
    }
    if (b.length === 0) {
        return [{ type: 'delete', lines: a.slice() }];
    }
    if ((a.length * b.length) > LINE_DIFF_LCS_MAX_CELLS) {
        return [
            { type: 'delete', lines: a.slice() },
            { type: 'insert', lines: b.slice() },
        ];
    }

    const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j]
                ? (dp[i + 1][j + 1] + 1)
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const operations = [];
    const push = (type, line) => {
        const last = operations[operations.length - 1];
        if (last && last.type === type) {
            last.lines.push(line);
            return;
        }
        operations.push({ type, lines: [line] });
    };

    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            push('equal', a[i]);
            i += 1;
            j += 1;
            continue;
        }
        if (dp[i + 1][j] >= dp[i][j + 1]) {
            push('delete', a[i]);
            i += 1;
            continue;
        }
        push('insert', b[j]);
        j += 1;
    }
    while (i < a.length) {
        push('delete', a[i]);
        i += 1;
    }
    while (j < b.length) {
        push('insert', b[j]);
        j += 1;
    }
    return operations;
}

function buildLineDiffRows(beforeValue, afterValue) {
    const beforeText = String(beforeValue ?? '');
    const afterText = String(afterValue ?? '');
    const operations = buildLineDiffOperations(splitLineDiffText(beforeText), splitLineDiffText(afterText));
    const stats = { added: 0, removed: 0, unchanged: 0 };

    for (const operation of operations) {
        const type = String(operation?.type || 'equal');
        const lines = Array.isArray(operation?.lines) ? operation.lines : [];
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            if (type === 'insert') {
                stats.added += 1;
                continue;
            }
            if (type === 'delete') {
                stats.removed += 1;
                continue;
            }
            stats.unchanged += 1;
        }
    }

    const maxChars = Math.max(beforeText.length, afterText.length);
    const lineCount = stats.added + stats.removed + stats.unchanged;
    const isLong = lineCount > LINE_DIFF_LONG_LINE_THRESHOLD || maxChars > LINE_DIFF_LONG_CHAR_THRESHOLD;

    return {
        operations,
        added: stats.added,
        removed: stats.removed,
        unchanged: stats.unchanged,
        openByDefault: !isLong,
    };
}

function buildLineDiffVisualRows(operations) {
    const rows = [];
    let beforeLineNo = 1;
    let afterLineNo = 1;
    const appendRow = (rowType, oldLine, oldHtml, newLine, newHtml) => {
        rows.push({
            rowType: String(rowType || ''),
            oldLine: String(oldLine || ''),
            oldHtml: String(oldHtml || '&nbsp;'),
            newLine: String(newLine || ''),
            newHtml: String(newHtml || '&nbsp;'),
        });
    };

    const safeOperations = Array.isArray(operations) ? operations : [];
    for (let index = 0; index < safeOperations.length; index++) {
        const operation = safeOperations[index];
        const type = String(operation?.type || 'equal');
        const lines = Array.isArray(operation?.lines) ? operation.lines : [];
        const nextOperation = safeOperations[index + 1];
        if (type === 'delete' && String(nextOperation?.type || '') === 'insert') {
            const insertLines = Array.isArray(nextOperation?.lines) ? nextOperation.lines : [];
            const pairCount = Math.min(lines.length, insertLines.length);
            for (let i = 0; i < pairCount; i++) {
                const beforeLine = String(lines[i] ?? '');
                const afterLine = String(insertLines[i] ?? '');
                appendRow(
                    'cea_line_diff_row_mod',
                    String(beforeLineNo),
                    renderInlineDiffHtml(beforeLine, afterLine, 'old'),
                    String(afterLineNo),
                    renderInlineDiffHtml(beforeLine, afterLine, 'new'),
                );
                beforeLineNo += 1;
                afterLineNo += 1;
            }
            for (let i = pairCount; i < lines.length; i++) {
                const text = escapeHtml(String(lines[i] ?? '')) || '&nbsp;';
                appendRow('cea_line_diff_row_del', String(beforeLineNo), text, '', '&nbsp;');
                beforeLineNo += 1;
            }
            for (let i = pairCount; i < insertLines.length; i++) {
                const text = escapeHtml(String(insertLines[i] ?? '')) || '&nbsp;';
                appendRow('cea_line_diff_row_add', '', '&nbsp;', String(afterLineNo), text);
                afterLineNo += 1;
            }
            index += 1;
            continue;
        }
        for (const rawLine of lines) {
            const text = String(rawLine ?? '');
            const escapedText = text.length > 0 ? escapeHtml(text) : '&nbsp;';
            if (type === 'insert') {
                appendRow('cea_line_diff_row_add', '', '&nbsp;', String(afterLineNo), escapedText);
                afterLineNo += 1;
                continue;
            }
            if (type === 'delete') {
                appendRow('cea_line_diff_row_del', String(beforeLineNo), escapedText, '', '&nbsp;');
                beforeLineNo += 1;
                continue;
            }
            appendRow('cea_line_diff_row_eq', String(beforeLineNo), escapedText, String(afterLineNo), escapedText);
            beforeLineNo += 1;
            afterLineNo += 1;
        }
    }
    if (rows.length === 0) {
        appendRow('cea_line_diff_row_eq', '', '&nbsp;', '', '&nbsp;');
    }
    return rows;
}

const {
    beginCeaLineDiffResize,
    closeCeaExpandedDiff,
    openCeaExpandedDiff,
    renderInlineDiffHtml,
    renderLineDiffHtml,
} = createCharacterEditorDiffUi({
    buildLineDiffOperations,
    buildLineDiffRows,
    buildLineDiffVisualRows,
    escapeHtml,
    i18n,
    i18nFormat,
    lineDiffLcsMaxCells: LINE_DIFF_LCS_MAX_CELLS,
    sanitizeDiffPlaceholderValue,
});

function splitCharacterEditorToolCalls(rawCalls, helperToolApis = []) {
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

function getCharacterEditorSearchApi() {
    const api = globalThis?.Luker?.searchTools;
    if (!api || typeof api !== 'object') {
        return null;
    }
    if (typeof api.getToolDefs !== 'function' || typeof api.isToolName !== 'function' || typeof api.invoke !== 'function') {
        return null;
    }
    const searchName = String(api?.toolNames?.SEARCH || '').trim();
    const visitName = String(api?.toolNames?.VISIT || '').trim();
    if (!searchName || !visitName) {
        return null;
    }
    return api;
}

// Exported so editor-iteration/tools.js (unified CEA editor) can dispatch
// short-name read tool calls (`lorebook_query`, `simulate_prompt`, etc.) to
// the existing legacy helper-tool APIs without reimplementing them.
export async function runCharacterEditorHelperToolCall(call, helperToolApis = []) {
    const name = String(call?.name || '').trim();
    const api = (Array.isArray(helperToolApis) ? helperToolApis : [])
        .find(item => typeof item?.isToolName === 'function' && item.isToolName(name));
    if (!api) {
        throw new Error(`Unsupported helper tool: ${name}`);
    }
    return await api.invoke(call);
}

/**
 * Build the helper-tool API array the unified CEA editor's read tools
 * (`lorebook_query`, `lorebook_list`, `lorebook_get`, `world_book_list`,
 * `simulate_prompt`, `web_search`) dispatch through. Assembles the same
 * helper-tool surface the legacy editor used so the unified popup keeps
 * tool parity without re-exporting each individual factory.
 *
 * Returned shape is an Array so it's drop-in compatible with
 * `runCharacterEditorHelperToolCall(call, helperToolApis)` and with the
 * unified popup's `runCeaEditorReadTool(call, { helperApis })` consumer
 * (both iterate the array via `isToolName`).
 *
 * @param {Object} context  SillyTavern context (characters, loadWorldInfo, …).
 * @param {Object} [opts]
 * @param {string} [opts.avatar='']  Character avatar — scopes the lorebook /
 *                                   world-book-list APIs to the right card.
 * @returns {Array<Object>} Helper-tool API objects (lorebook, simulate,
 *                          worldBookList, plus optional search when
 *                          `globalThis.Luker.searchTools` is wired).
 */
export function buildCharacterEditorHelperApis(context, opts = {}) {
    const avatar = String(opts?.avatar || '').trim();
    const searchApi = getCharacterEditorSearchApi();
    return [
        createCharacterEditorLorebookToolApi(context, { avatar }),
        createCharacterEditorLorebookWriteToolApi(context, { avatar }),
        createCharacterEditorSimulateToolApi(context),
        createCharacterEditorWorldBookListToolApi(context, { avatar }),
        ...(searchApi ? [searchApi] : []),
    ];
}

/**
 * Build a `state.live` snapshot for the unified CEA editor popup. The popup
 * holds this snapshot to back its apply commit — `state.live.character` is
 * the per-character field bundle the card-field edits apply against, and
 * `state.live.lorebooks[bookName]` is the per-book object lorebook edits
 * apply against (and what `commitLorebookOperations` then writes back via
 * `saveWorldInfo`).
 *
 * Scope: pre-loads the primary lorebook only (the one bound at
 * `character.data.extensions.world`). Auxiliary / chat / global books are
 * still editable through the AI's tool calls — the popup will hit
 * `commitLorebookOperations` with whatever book the AI named. Pre-loading
 * every visible book up front would be wasteful (global books can be huge)
 * and a stale snapshot would risk clobbering concurrent edits.
 *
 * @param {Object} context  SillyTavern context (characters, loadWorldInfo, …).
 * @param {string} avatar   Character avatar — resolves to the card.
 * @returns {Promise<{ character: Object, lorebooks: Object }>}
 */
export async function buildUnifiedCharacterEditorLiveSnapshot(context, avatar = '') {
    const state = await loadCharacterEditorPrimaryLorebookState(context, { avatar });
    const character = state?.character || {};
    const lorebooks = {};
    const bookName = String(state?.bookName || '').trim();
    if (bookName) {
        // `loadCharacterEditorPrimaryLorebookState` already loaded the
        // primary book — reuse that payload so we don't double-fetch.
        const data = state?.lorebookData;
        if (data && typeof data === 'object') {
            lorebooks[bookName] = data;
        }
    }
    return { character, lorebooks };
}

function makeRuntimeToolCallId() {
    return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeConversationMessageId(prefix = 'cea_msg') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createPersistentToolCallPayload(name, args = {}, id = '') {
    const toolName = String(name || '').trim();
    if (!toolName) {
        return null;
    }
    const safeArgs = args && typeof args === 'object' ? clone(args) : {};
    return {
        id: String(id || '').trim() || makeRuntimeToolCallId(),
        type: 'function',
        function: {
            name: toolName,
            arguments: JSON.stringify(safeArgs),
        },
    };
}

function normalizePersistentToolCalls(message) {
    const output = [];
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        const payload = createPersistentToolCallPayload(
            call?.function?.name,
            (() => {
                if (call?.function?.arguments && typeof call.function.arguments === 'string') {
                    try {
                        const parsed = JSON.parse(call.function.arguments);
                        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
                    } catch {
                        return {};
                    }
                }
                if (call?.function?.arguments && typeof call.function.arguments === 'object') {
                    return call.function.arguments;
                }
                return {};
            })(),
            call?.id,
        );
        if (payload) {
            output.push(payload);
        }
    }
    return output;
}

function normalizePersistentToolResults(message, toolCalls = []) {
    const toolCallIds = new Set(toolCalls.map(call => String(call?.id || '').trim()).filter(Boolean));
    return (Array.isArray(message?.tool_results) ? message.tool_results : [])
        .map((item) => ({
            tool_call_id: String(item?.tool_call_id || '').trim(),
            content: String(item?.content ?? ''),
        }))
        .filter(item => item.tool_call_id && toolCallIds.has(item.tool_call_id));
}

const CHARACTER_EDITOR_ROOT_TEXT_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
const CHARACTER_EDITOR_DATA_TEXT_FIELDS = ['system_prompt', 'post_history_instructions', 'creator_notes'];
const CHARACTER_EDITOR_DATA_ARRAY_FIELDS = ['alternate_greetings'];

function normalizeCharacterEditorOperationsFromCalls(rawCalls) {
    const output = [];
    for (const call of Array.isArray(rawCalls) ? rawCalls : []) {
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        if (name === TOOL_NAMES.UPDATE_FIELDS) {
            const normalizedArgs = {};
            for (const key of [...CHARACTER_EDITOR_ROOT_TEXT_FIELDS, ...CHARACTER_EDITOR_DATA_TEXT_FIELDS]) {
                if (Object.hasOwn(args, key)) {
                    normalizedArgs[key] = String(args[key] ?? '');
                }
            }
            for (const key of CHARACTER_EDITOR_DATA_ARRAY_FIELDS) {
                if (!Object.hasOwn(args, key)) {
                    continue;
                }
                const value = Array.isArray(args[key]) ? args[key] : [args[key]];
                normalizedArgs[key] = value.map(item => String(item ?? ''));
            }
            if (Object.keys(normalizedArgs).length > 0) {
                output.push({ kind: 'character_fields', args: normalizedArgs });
            }
            continue;
        }
        if (name === TOOL_NAMES.SET_PRIMARY_BOOK) {
            const normalizedArgs = {};
            if (Object.hasOwn(args, 'book_name')) {
                normalizedArgs.book_name = String(args.book_name ?? '');
            }
            if (Object.hasOwn(args, 'create_if_missing')) {
                normalizedArgs.create_if_missing = Boolean(args.create_if_missing);
            }
            output.push({ kind: 'set_primary_lorebook', args: normalizedArgs });
            continue;
        }
        if (name === TOOL_NAMES.UPSERT_ENTRY) {
            const uid = asFiniteInteger(args.entry_uid, null);
            if (!Number.isInteger(uid) || uid < 0) {
                continue;
            }
            const bookName = String(args.book_name || '').trim();
            if (!bookName) {
                continue;
            }
            const normalizedArgs = { entry_uid: uid, book_name: bookName };
            let hasPayload = false;
            const passThrough = ['key_csv', 'secondary_key_csv', 'comment', 'content'];
            for (const key of passThrough) {
                if (Object.hasOwn(args, key)) {
                    normalizedArgs[key] = String(args[key] ?? '');
                    hasPayload = true;
                }
            }
            const intFields = ['selective_logic', 'order', 'position', 'depth', 'delay_until_recursion'];
            for (const key of intFields) {
                if (!Object.hasOwn(args, key)) {
                    continue;
                }
                const value = asFiniteInteger(args[key], null);
                if (value !== null) {
                    normalizedArgs[key] = value;
                    hasPayload = true;
                }
            }
            const boolFields = ['create_if_missing', 'enabled', 'disable', 'constant', 'exclude_recursion', 'prevent_recursion'];
            for (const key of boolFields) {
                if (Object.hasOwn(args, key)) {
                    normalizedArgs[key] = Boolean(args[key]);
                    if (key !== 'create_if_missing') {
                        hasPayload = true;
                    }
                }
            }
            if (!hasPayload) {
                continue;
            }
            output.push({ kind: 'lorebook_upsert_entry', args: normalizedArgs });
            continue;
        }
        if (name === TOOL_NAMES.DELETE_ENTRY) {
            const uid = asFiniteInteger(args.entry_uid, null);
            if (!Number.isInteger(uid) || uid < 0) {
                continue;
            }
            const bookName = String(args.book_name || '').trim();
            if (!bookName) {
                continue;
            }
            output.push({ kind: 'lorebook_delete_entry', args: { entry_uid: uid, book_name: bookName } });
        }
    }
    return output;
}

function buildCharacterEditorOperationKey(operation) {
    const kind = String(operation?.kind || '').trim();
    if (!kind) {
        return '';
    }
    if (kind === 'lorebook_upsert_entry' || kind === 'lorebook_delete_entry') {
        const uid = asFiniteInteger(operation?.args?.entry_uid, null);
        const bookName = String(operation?.args?.book_name || '').trim();
        return `${kind}:${bookName}:${Number.isInteger(uid) ? uid : '?'}`;
    }
    if (kind === 'set_primary_lorebook') {
        return `${kind}:${String(operation?.args?.book_name || '').trim()}`;
    }
    if (kind === 'character_fields') {
        const keys = Object.keys(operation?.args || {}).sort().join(',');
        return `${kind}:${keys}`;
    }
    return `${kind}:${JSON.stringify(operation?.args || {})}`;
}

async function openCharacterEditorPopup(context = getContext(), opts = {}) {
    const character = context?.characters?.[context?.characterId] || null;
    const avatarFromCtx = String(character?.avatar || '').trim();
    const avatar = String(opts?.avatar || avatarFromCtx).trim();
    if (!avatar) {
        notifyWarning(i18n('No character selected or character has no avatar.'));
        return;
    }
    if (editorStudioDialogLocks.has(avatar)) {
        notifyWarning(i18n('A character editor dialog is already open for this character.'));
        return;
    }
    editorStudioDialogLocks.add(avatar);
    try {
        await openUnifiedCharacterEditorPopup(context, { i18n, i18nFormat, ...opts, avatar });
    } finally {
        editorStudioDialogLocks.delete(avatar);
    }
}

const {
    ensureUi,
    refreshUiState,
    renderCharacterEditorConversationHistoryItems,
} = createCharacterEditorUi({
    MODULE_NAME,
    STYLE_ID,
    UI_BLOCK_ID,
    beginCeaLineDiffResize,
    closeCeaExpandedDiff,
    defaultSettings,
    escapeHtml,
    getContext,
    getSettings,
    i18n,
    i18nFormat,
    loadOperationState,
    openCeaExpandedDiff,
    openCharacterEditorPopup,
    refreshPresetSelectors,
    renderJournalItems,
    saveSettingsDebounced,
    summarizeCharacterEditorSession,
});

async function primeActiveCharacterLorebookSnapshot(context) {
    try {
        const record = getActiveCharacterRecord(context);
        const snapshot = await captureCharacterLorebookSnapshot(context, record.character);
        if (snapshot.avatar) {
            cacheLorebookSnapshot(snapshot);
        }
    } catch {
        // no active character, ignore
    }
}

function buildOperationSummary(operation) {
    const kind = String(operation?.kind || 'unknown');
    if (kind === 'character_fields') {
        return `character_fields: ${Object.keys(operation.args || {}).join(', ') || 'no-fields'}`;
    }
    if (kind === 'set_primary_lorebook') {
        return `set_primary_lorebook: ${String(operation.args?.book_name || '(clear)')}`;
    }
    if (kind === 'lorebook_upsert_entry') {
        return `lorebook_upsert_entry: ${String(operation.args?.book_name || '(primary)')}#${String(operation.args?.entry_uid ?? 'new')}`;
    }
    if (kind === 'lorebook_delete_entry') {
        return `lorebook_delete_entry: ${String(operation.args?.book_name || '(primary)')}#${String(operation.args?.entry_uid ?? '?')}`;
    }
    return kind;
}

async function applyCharacterFieldsOperation(context, record, operation) {
    const args = operation.args && typeof operation.args === 'object' ? operation.args : {};
    const rootPatch = {};
    const dataPatch = {};
    const before = {};
    const after = {};

    for (const key of CHARACTER_EDITOR_ROOT_TEXT_FIELDS) {
        if (!Object.hasOwn(args, key)) {
            continue;
        }
        const nextValue = String(args[key] ?? '');
        before[key] = String(record.character?.[key] ?? '');
        after[key] = nextValue;
        rootPatch[key] = nextValue;
    }
    for (const key of CHARACTER_EDITOR_DATA_TEXT_FIELDS) {
        if (!Object.hasOwn(args, key)) {
            continue;
        }
        const nextValue = String(args[key] ?? '');
        before[key] = String(record.character?.data?.[key] ?? '');
        after[key] = nextValue;
        dataPatch[key] = nextValue;
    }
    for (const key of CHARACTER_EDITOR_DATA_ARRAY_FIELDS) {
        if (!Object.hasOwn(args, key)) {
            continue;
        }
        const nextValue = Array.isArray(args[key]) ? args[key].map(item => String(item ?? '')) : [];
        before[key] = Array.isArray(record.character?.data?.[key]) ? clone(record.character.data[key]) : [];
        after[key] = clone(nextValue);
        dataPatch[key] = clone(nextValue);
    }

    if (Object.keys(rootPatch).length === 0 && Object.keys(dataPatch).length === 0) {
        throw new Error('No character fields were provided.');
    }

    const payload = { ...rootPatch };
    if (Object.keys(dataPatch).length > 0) {
        payload.data = dataPatch;
    }

    await mergeCharacterAttributes(context, record.avatar, payload);

    return {
        summary: `Updated character fields: ${Object.keys({ ...rootPatch, ...dataPatch }).join(', ')}`,
        kind: operation.kind,
        data: {
            before,
            after,
        },
    };
}

function applyLorebookEntryArgs(baseEntry, args, entryUid) {
    const normalizeLineEndings = (value) => String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const entry = clone(baseEntry && typeof baseEntry === 'object' ? baseEntry : { uid: entryUid, ...clone(newWorldInfoEntryTemplate) });
    entry.uid = Number(entryUid);

    if (Object.hasOwn(args, 'comment')) {
        entry.comment = normalizeLineEndings(args.comment ?? '');
    }
    if (Object.hasOwn(args, 'content')) {
        entry.content = normalizeLineEndings(args.content ?? '');
    }
    if (Object.hasOwn(args, 'key_csv')) {
        entry.key = parseCsvList(args.key_csv);
    }
    if (Object.hasOwn(args, 'secondary_key_csv')) {
        entry.keysecondary = parseCsvList(args.secondary_key_csv);
        entry.selective = entry.keysecondary.length > 0;
    }
    if (Object.hasOwn(args, 'selective_logic')) {
        const selectiveLogic = asFiniteInteger(args.selective_logic, entry.selectiveLogic);
        if (selectiveLogic !== null) {
            entry.selectiveLogic = selectiveLogic;
        }
    }
    if (Object.hasOwn(args, 'order')) {
        const order = asFiniteInteger(args.order, entry.order);
        if (order !== null) {
            entry.order = order;
        }
    }
    if (Object.hasOwn(args, 'position')) {
        const position = asFiniteInteger(args.position, entry.position);
        if (position !== null) {
            entry.position = position;
        }
    }
    if (Object.hasOwn(args, 'depth')) {
        const depth = asFiniteInteger(args.depth, entry.depth);
        if (depth !== null) {
            entry.depth = depth;
        }
    }
    if (Object.hasOwn(args, 'enabled')) {
        entry.disable = !args.enabled;
    }
    if (Object.hasOwn(args, 'disable')) {
        entry.disable = Boolean(args.disable);
    }
    if (Object.hasOwn(args, 'constant')) {
        entry.constant = Boolean(args.constant);
    }
    if (Object.hasOwn(args, 'exclude_recursion')) {
        entry.excludeRecursion = Boolean(args.exclude_recursion);
    }
    if (Object.hasOwn(args, 'prevent_recursion')) {
        entry.preventRecursion = Boolean(args.prevent_recursion);
    }
    if (Object.hasOwn(args, 'delay_until_recursion')) {
        const level = asFiniteInteger(args.delay_until_recursion, null);
        if (level !== null) {
            entry.delayUntilRecursion = Math.max(0, level);
        }
    }

    return entry;
}

function sanitizeDiffPlaceholderValue(value) {
    const text = String(value ?? '');
    const normalized = text.trim();
    if (!normalized) {
        return '';
    }
    const notSetTokens = new Set([
        'Not set',
        '未设置',
        '未設定',
    ]);
    return notSetTokens.has(normalized) ? '' : text;
}

function normalizeDiffValue(value, emptyLabel = '') {
    const emptyText = emptyLabel ? i18n(emptyLabel) : '';
    if (value === null || value === undefined) {
        return emptyText;
    }
    if (Array.isArray(value)) {
        const text = value
            .map(item => sanitizeDiffPlaceholderValue(item).trim())
            .filter(Boolean)
            .join(', ');
        return text || emptyText;
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    const text = sanitizeDiffPlaceholderValue(value);
    if (!text.trim()) {
        return emptyText;
    }
    return text;
}

function clipDiffText(value, maxLength = 1200) {
    const text = String(value ?? '');
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength)}\n...`;
}

function pushDiffField(fields, label, before, after, { force = false } = {}) {
    const beforeText = clipDiffText(normalizeDiffValue(before));
    const afterText = clipDiffText(normalizeDiffValue(after));
    if (!force && beforeText === afterText) {
        return;
    }
    fields.push({
        label: String(label || 'field'),
        before: beforeText,
        after: afterText,
    });
}

function getEntryPreviewValue(entry, key) {
    const source = entry && typeof entry === 'object' ? entry : {};
    if (key === 'key') {
        return Array.isArray(source.key) ? source.key : [];
    }
    if (key === 'keysecondary') {
        return Array.isArray(source.keysecondary) ? source.keysecondary : [];
    }
    if (key === 'enabled') {
        return !source.disable;
    }
    return source[key];
}

async function applyLorebookUpsertOperation(context, record, operation) {
    const args = operation.args && typeof operation.args === 'object' ? operation.args : {};
    const bookName = await resolveTargetLorebook(context, record, {
        requestedName: args.book_name,
        createIfMissing: args.create_if_missing !== false,
        bindPrimaryWhenCreated: true,
    });
    if (!bookName) {
        throw new Error('No target lorebook is available.');
    }

    const data = await loadLorebookData(context, bookName);
    const parsedUid = asFiniteInteger(args.entry_uid, null);
    const uid = Number.isInteger(parsedUid) && parsedUid >= 0 ? parsedUid : getLorebookNextUid(data);
    const beforeEntry = Object.hasOwn(data.entries, uid) ? clone(data.entries[uid]) : null;
    const nextEntry = applyLorebookEntryArgs(beforeEntry, args, uid);

    data.entries[uid] = nextEntry;
    await context.saveWorldInfo(bookName, data, true);

    return {
        summary: `Upserted lorebook entry #${uid} in ${bookName}`,
        kind: operation.kind,
        data: {
            bookName,
            entryUid: uid,
            beforeEntry,
            afterEntry: clone(nextEntry),
        },
    };
}

async function applyLorebookDeleteOperation(context, record, operation) {
    const args = operation.args && typeof operation.args === 'object' ? operation.args : {};
    const entryUid = asFiniteInteger(args.entry_uid, null);
    if (!Number.isInteger(entryUid) || entryUid < 0) {
        throw new Error('entry_uid is required for lorebook deletion.');
    }

    const bookName = await resolveTargetLorebook(context, record, {
        requestedName: args.book_name,
        createIfMissing: false,
        bindPrimaryWhenCreated: false,
    });
    if (!bookName) {
        throw new Error('No target lorebook is available.');
    }

    const data = await loadLorebookData(context, bookName);
    const beforeEntry = Object.hasOwn(data.entries, entryUid) ? clone(data.entries[entryUid]) : null;
    if (!beforeEntry) {
        throw new Error(`Lorebook entry #${entryUid} does not exist.`);
    }

    delete data.entries[entryUid];
    await context.saveWorldInfo(bookName, data, true);

    return {
        summary: `Deleted lorebook entry #${entryUid} from ${bookName}`,
        kind: operation.kind,
        data: {
            bookName,
            entryUid,
            beforeEntry,
            afterEntry: null,
        },
    };
}

async function applyPrimaryLorebookOperation(context, record, operation) {
    const args = operation.args && typeof operation.args === 'object' ? operation.args : {};
    const requestedName = String(args.book_name || '').trim();
    const beforeName = getPrimaryLorebookName(record.character);

    let targetName = requestedName;
    if (targetName && args.create_if_missing !== false) {
        targetName = await ensureLorebookExists(context, targetName, targetName);
    }

    await mergeCharacterAttributes(context, record.avatar, {
        data: {
            extensions: {
                world: targetName,
            },
        },
    });
    await syncWorldBindingUi(context, targetName);

    return {
        summary: `Set primary lorebook: ${beforeName || '(none)'} -> ${targetName || '(none)'}`,
        kind: operation.kind,
        data: {
            beforeName,
            afterName: targetName,
        },
    };
}

async function applyOperationNow(context, operation, { avatar = '' } = {}) {
    const record = getActiveCharacterRecord(context, { avatar: avatar || operation?.targetAvatar || '' });
    const kind = String(operation?.kind || '');
    if (!kind) {
        throw new Error('Operation kind is missing.');
    }

    if (kind === 'character_fields') {
        return await applyCharacterFieldsOperation(context, record, operation);
    }
    if (kind === 'set_primary_lorebook') {
        return await applyPrimaryLorebookOperation(context, record, operation);
    }
    if (kind === 'lorebook_upsert_entry') {
        return await applyLorebookUpsertOperation(context, record, operation);
    }
    if (kind === 'lorebook_delete_entry') {
        return await applyLorebookDeleteOperation(context, record, operation);
    }

    throw new Error(`Unsupported operation kind: ${kind}`);
}

function appendJournal(state, entry, settings) {
    const maxEntries = Math.max(20, Number(settings.maxJournalEntries || defaultSettings.maxJournalEntries));
    state.journal.push(entry);
    if (state.journal.length > maxEntries) {
        state.journal.splice(0, state.journal.length - maxEntries);
    }
}

function createOperationEnvelope(state, kind, args, source = 'tool', { targetAvatar = '' } = {}) {
    const operation = {
        id: nextStateId(state, 'op'),
        kind: String(kind || '').trim(),
        args: args && typeof args === 'object' ? clone(args) : {},
        source: String(source || 'tool'),
        createdAt: Date.now(),
    };
    const avatar = String(targetAvatar || '').trim();
    if (avatar) {
        operation.targetAvatar = avatar;
    }
    return operation;
}

async function submitOperation(context, operation, { avatar = '' } = {}) {
    const settings = getSettings();
    const targetAvatar = String(avatar || operation?.targetAvatar || '').trim();
    const state = await loadOperationState(context, { avatar: targetAvatar });

    const applied = await applyOperationNow(context, operation, { avatar: targetAvatar });
    const journalEntry = {
        id: nextStateId(state, 'tx'),
        operationId: operation.id,
        kind: applied.kind,
        source: operation.source,
        summary: String(applied.summary || buildOperationSummary(operation)),
        data: clone(applied.data || {}),
        createdAt: Date.now(),
    };
    appendJournal(state, journalEntry, settings);
    state.updatedAt = Date.now();
    await persistOperationState(context, state, { avatar: targetAvatar });

    return {
        status: 'applied',
        operation_id: operation.id,
        journal_id: journalEntry.id,
        summary: journalEntry.summary,
    };
}

function getJournalById(state, journalId) {
    const id = String(journalId || '').trim();
    const index = state.journal.findIndex(item => String(item?.id || '') === id);
    return {
        entry: index >= 0 ? state.journal[index] : null,
        index,
    };
}

async function rollbackJournalEntry(context, journalEntry, { avatar = '' } = {}) {
    const record = getActiveCharacterRecord(context, { avatar });
    const kind = String(journalEntry?.kind || '');
    const data = journalEntry?.data && typeof journalEntry.data === 'object' ? journalEntry.data : {};

    if (kind === 'character_fields') {
        const before = data.before && typeof data.before === 'object' ? data.before : {};
        if (Object.keys(before).length === 0) {
            throw new Error('No rollback payload for character fields.');
        }
        const payload = {};
        const dataPatch = {};
        for (const key of CHARACTER_EDITOR_ROOT_TEXT_FIELDS) {
            if (Object.hasOwn(before, key)) {
                payload[key] = String(before[key] ?? '');
            }
        }
        for (const key of CHARACTER_EDITOR_DATA_TEXT_FIELDS) {
            if (Object.hasOwn(before, key)) {
                dataPatch[key] = String(before[key] ?? '');
            }
        }
        for (const key of CHARACTER_EDITOR_DATA_ARRAY_FIELDS) {
            if (Object.hasOwn(before, key)) {
                dataPatch[key] = Array.isArray(before[key]) ? clone(before[key]) : [];
            }
        }
        if (Object.keys(dataPatch).length > 0) {
            payload.data = dataPatch;
        }
        await mergeCharacterAttributes(context, record.avatar, payload);
        return `Rolled back character fields (${Object.keys(before).join(', ')})`;
    }

    if (kind === 'set_primary_lorebook') {
        const beforeName = String(data.beforeName ?? '');
        await mergeCharacterAttributes(context, record.avatar, {
            data: {
                extensions: {
                    world: beforeName,
                },
            },
        });
        await syncWorldBindingUi(context, beforeName);
        return `Rolled back primary lorebook to ${beforeName || '(none)'}`;
    }

    if (kind === 'lorebook_upsert_entry' || kind === 'lorebook_delete_entry') {
        const bookName = String(data.bookName || '').trim();
        const entryUid = asFiniteInteger(data.entryUid, null);
        if (!bookName || !Number.isInteger(entryUid) || entryUid < 0) {
            throw new Error('Rollback payload is incomplete for lorebook entry operation.');
        }
        const lorebookData = await loadLorebookData(context, bookName);
        if (data.beforeEntry && typeof data.beforeEntry === 'object') {
            lorebookData.entries[entryUid] = clone(data.beforeEntry);
        } else {
            delete lorebookData.entries[entryUid];
        }
        await context.saveWorldInfo(bookName, lorebookData, true);
        return `Rolled back lorebook entry #${entryUid} in ${bookName}`;
    }

    throw new Error(`Rollback is not supported for kind: ${kind}`);
}

async function rollbackJournalEntryWithLog(context, journalId, { avatar = '', source = 'manual' } = {}) {
    const resolvedAvatar = String(avatar || '').trim();
    const settings = getSettings();
    const state = await loadOperationState(context, { force: true, avatar: resolvedAvatar });
    const { entry } = getJournalById(state, journalId);
    if (!entry) {
        throw new Error('Journal entry not found.');
    }
    if (String(entry.kind || '') === 'rollback') {
        throw new Error('Rollback is not supported for rollback records.');
    }
    const summary = await rollbackJournalEntry(context, entry, { avatar: resolvedAvatar });
    const rollbackLog = {
        id: nextStateId(state, 'tx'),
        operationId: entry.operationId,
        kind: 'rollback',
        source: String(source || 'manual'),
        summary,
        data: {
            targetJournalId: entry.id,
        },
        createdAt: Date.now(),
    };
    appendJournal(state, rollbackLog, settings);
    state.updatedAt = Date.now();
    await persistOperationState(context, state, { avatar: resolvedAvatar });
    return {
        summary,
        rollbackJournalId: rollbackLog.id,
    };
}

function rebuildCharacterEditorRejectedOperationKeys(messages, targetSet) {
    const set = targetSet instanceof Set ? targetSet : new Set();
    set.clear();
    for (const item of Array.isArray(messages) ? messages : []) {
        if (String(item?.role || '').trim().toLowerCase() !== 'assistant') {
            continue;
        }
        if (String(item?.toolState || '').trim().toLowerCase() !== 'rejected') {
            continue;
        }
        for (const operation of Array.isArray(item?.operations) ? item.operations : []) {
            const key = buildCharacterEditorOperationKey(operation);
            if (key) {
                set.add(key);
            }
        }
    }
    return set;
}

async function rollbackCharacterEditorConversationMessages(context, messages, { avatar = '' } = {}) {
    const rollbacks = [];
    const removedMessages = Array.isArray(messages) ? messages.slice() : [];
    for (const message of removedMessages.reverse()) {
        const executionResults = Array.isArray(message?.executionResults) ? message.executionResults.slice() : [];
        for (const result of executionResults.reverse()) {
            const journalId = String(result?.journalId || result?.journal_id || '').trim();
            if (!result?.ok || !journalId || result?.rolledBackAt) {
                continue;
            }
            await rollbackJournalEntryWithLog(context, journalId, {
                avatar,
                source: 'message_refresh',
            });
            rollbacks.push(journalId);
        }
    }
    return rollbacks;
}

function renderJournalItems(state) {
    const items = Array.isArray(state?.journal) ? state.journal.slice().reverse() : [];
    const toolbar = items.length > 0
        ? `<div class="cea_row"><div class="menu_button menu_button_small" id="cea_clear_history">${escapeHtml(i18n('Clear history'))}</div></div>`
        : '';
    if (items.length === 0) {
        return `${toolbar}<div class="cea_item_meta">${escapeHtml(i18n('No history yet.'))}</div>`;
    }
    return `${toolbar}${items.map(item => `
<div class="cea_item" data-journal-id="${escapeHtml(item.id)}">
    <div class="cea_item_top">
        <div>
            <div><b>${escapeHtml(String(item.summary || item.kind || ''))}</b></div>
            <div class="cea_item_meta">${escapeHtml(new Date(Number(item.createdAt || Date.now())).toLocaleString())}</div>
        </div>
        <div class="cea_item_actions">
            ${String(item.kind || '') === 'rollback'
        ? ''
        : `<div class="menu_button menu_button_small" data-cea-action="rollback" data-journal-id="${escapeHtml(item.id)}">${escapeHtml(i18n('Rollback'))}</div>`}
            <div class="menu_button menu_button_small" data-cea-action="delete" data-journal-id="${escapeHtml(item.id)}">${escapeHtml(i18n('Delete'))}</div>
        </div>
    </div>
</div>`).join('')}`;
}

function canUseToolsInCurrentContext(context) {
    try {
        const record = getActiveCharacterRecord(context);
        const avatar = String(record?.avatar || '').trim();
        return Boolean(avatar) && editorStudioDialogLocks.has(avatar);
    } catch {
        return false;
    }
}

async function handleToolOperation(kind, args) {
    const context = getContext();
    if (!canUseToolsInCurrentContext(context)) {
        return {
            status: 'ignored',
            reason: i18n('Current chat has no active character.'),
        };
    }

    const state = await loadOperationState(context);
    const operation = createOperationEnvelope(state, kind, args, 'tool');
    await persistOperationState(context, state);

    const result = await submitOperation(context, operation);
    notifySuccess(i18nFormat('Operation applied: ${0}', result.summary));
    await refreshUiState(context);
    return result;
}

function registerTools(context) {
    Object.values(TOOL_NAMES).forEach(name => context.unregisterFunctionTool(name));

    context.registerFunctionTool({
        name: TOOL_NAMES.UPDATE_FIELDS,
        displayName: 'Update Character Fields',
        description: 'Update current character card fields (description, personality, scenario, first_mes, alternate_greetings, mes_example, system_prompt, creator_notes, etc).',
        shouldRegister: async () => false,
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                personality: { type: 'string' },
                scenario: { type: 'string' },
                first_mes: { type: 'string' },
                mes_example: { type: 'string' },
                system_prompt: { type: 'string' },
                post_history_instructions: { type: 'string' },
                creator_notes: { type: 'string' },
                alternate_greetings: {
                    type: 'array',
                    items: { type: 'string' },
                },
            },
            additionalProperties: false,
        },
        action: async (args) => await handleToolOperation('character_fields', args),
        formatMessage: () => 'Preparing character field update...',
    });

    context.registerFunctionTool({
        name: TOOL_NAMES.SET_PRIMARY_BOOK,
        displayName: 'Set Primary Lorebook',
        description: 'Set or clear current character primary lorebook binding. Optionally create lorebook if missing.',
        shouldRegister: async () => false,
        parameters: {
            type: 'object',
            properties: {
                book_name: { type: 'string' },
                create_if_missing: { type: 'boolean' },
            },
            additionalProperties: false,
        },
        action: async (args) => await handleToolOperation('set_primary_lorebook', args),
        formatMessage: () => 'Updating primary lorebook binding...',
    });

    context.registerFunctionTool({
        name: TOOL_NAMES.UPSERT_ENTRY,
        displayName: 'Upsert Lorebook Entry',
        description: 'Create or update one lorebook entry in a named world book.',
        shouldRegister: async () => false,
        parameters: {
            type: 'object',
            properties: {
                book_name: { type: 'string' },
                create_if_missing: { type: 'boolean' },
                entry_uid: { type: 'integer' },
                key_csv: { type: 'string' },
                secondary_key_csv: { type: 'string' },
                comment: { type: 'string' },
                content: { type: 'string' },
                selective_logic: { type: 'integer' },
                order: { type: 'integer' },
                position: { type: 'integer' },
                depth: { type: 'integer' },
                enabled: { type: 'boolean' },
                disable: { type: 'boolean' },
                constant: { type: 'boolean' },
                exclude_recursion: { type: 'boolean' },
                prevent_recursion: { type: 'boolean' },
                delay_until_recursion: { type: 'integer' },
            },
            required: ['book_name', 'entry_uid'],
            additionalProperties: false,
        },
        action: async (args) => await handleToolOperation('lorebook_upsert_entry', args),
        formatMessage: () => 'Upserting lorebook entry...',
    });

    context.registerFunctionTool({
        name: TOOL_NAMES.DELETE_ENTRY,
        displayName: 'Delete Lorebook Entry',
        description: 'Delete one lorebook entry by UID from a named world book.',
        shouldRegister: async () => false,
        parameters: {
            type: 'object',
            properties: {
                book_name: { type: 'string' },
                entry_uid: { type: 'integer' },
            },
            required: ['book_name', 'entry_uid'],
            additionalProperties: false,
        },
        action: async (args) => {
            const normalizedArgs = args && typeof args === 'object' ? { ...args } : {};
            if (!Number.isInteger(asFiniteInteger(normalizedArgs.entry_uid, null))) {
                throw new Error('entry_uid is required for deletion.');
            }
            if (!String(normalizedArgs.book_name || '').trim()) {
                throw new Error('book_name is required for deletion.');
            }
            return await handleToolOperation('lorebook_delete_entry', normalizedArgs);
        },
        formatMessage: () => 'Deleting lorebook entry...',
    });
}

function setStatus(message) {
    jQuery('#cea_status').text(String(message || ''));
}

function bindHistoryUiActions() {
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    root.off('.ceaHistory');

    root.on('click.ceaHistory', '#cea_clear_history', async function () {
        const context = getContext();
        if (!window.confirm(i18n('Clear all history records?'))) {
            return;
        }
        try {
            await clearHistoryRecords(context);
            notifySuccess(i18n('History cleared.'));
            await refreshUiState(context);
        } catch (error) {
            notifyError(i18nFormat('Clear failed: ${0}', error?.message || error));
        }
    });

    root.on('click.ceaHistory', '[data-cea-action]', async function () {
        const context = getContext();
        const action = String(jQuery(this).data('cea-action') || '').trim();
        const journalId = String(jQuery(this).data('journal-id') || '');
        if (!journalId || !action) {
            return;
        }
        try {
            if (action === 'delete') {
                if (!window.confirm(i18n('Delete this history record?'))) {
                    return;
                }
                const deleted = await deleteHistoryRecord(context, journalId);
                if (!deleted) {
                    throw new Error('Journal entry not found.');
                }
                notifySuccess(i18n('History record deleted.'));
                await refreshUiState(context);
                return;
            }
            if (action !== 'rollback') {
                return;
            }
            const settings = getSettings();
            const state = await loadOperationState(context, { force: true });
            const { entry } = getJournalById(state, journalId);
            if (!entry) {
                throw new Error('Journal entry not found.');
            }
            if (String(entry.kind || '') === 'rollback') {
                throw new Error('Rollback is not supported for rollback records.');
            }
            const summary = await rollbackJournalEntry(context, entry);
            const rollbackLog = {
                id: nextStateId(state, 'tx'),
                operationId: entry.operationId,
                kind: 'rollback',
                source: 'manual',
                summary,
                data: {
                    targetJournalId: entry.id,
                },
                createdAt: Date.now(),
            };
            appendJournal(state, rollbackLog, settings);
            state.updatedAt = Date.now();
            await persistOperationState(context, state);
            notifySuccess(i18n('Rollback completed.'));
            await refreshUiState(context);
        } catch (error) {
            if (action === 'rollback') {
                notifyError(i18nFormat('Rollback failed: ${0}', error?.message || error));
                return;
            }
            if (action === 'delete') {
                notifyError(i18nFormat('Delete failed: ${0}', error?.message || error));
            }
        }
    });
}

jQuery(async () => {
    registerLocaleData();
    ensureSimulationReviewLocaleData();
    ensureSettings();
    registerTools(getContext());
    ensureUi();
    bindHistoryUiActions();
    setStatus(i18n('Character editor tools are ready.'));
    await refreshUiState();
    await primeActiveCharacterLorebookSnapshot(getContext());

    const eventSource = getContext().eventSource;
    const eventTypes = getContext().eventTypes;

    eventSource.on(eventTypes.CHAT_CHANGED, async () => {
        await refreshUiState();
        await primeActiveCharacterLorebookSnapshot(getContext());
    });

    eventSource.on(eventTypes.TOOL_CALLS_PERFORMED, async () => {
        await refreshUiState();
        await primeActiveCharacterLorebookSnapshot(getContext());
    });

    eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, async () => {
        await refreshUiState();
    });

    eventSource.on(eventTypes.SETTINGS_UPDATED, async () => {
        await refreshUiState();
    });

    const characterReplacedEvent = eventTypes?.CHARACTER_REPLACED || 'character_replaced';
    eventSource.on(characterReplacedEvent, async (event) => {
        const settings = getSettings();
        // Note: this gate also controls auto-open of the editor popup on
        // import. The setting name is historically about lorebook sync;
        // the editor auto-trigger was bolted on without a dedicated flag.
        // Renaming the field now would orphan any user who already toggled
        // it on, so the conflation lives on under the original key.
        if (!settings.replaceLorebookSyncEnabled) {
            return;
        }
        const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
        const avatar = String(detail.character?.avatar || '').trim();
        if (!avatar) {
            return;
        }
        try {
            await openCharacterEditorPopup(getContext(), {
                avatar,
                seedSystemMessage: i18n('Just imported this card — review the baseline and suggest tweaks.'),
                autoSend: true,
            });
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Character editor iteration failed`, error);
            notifyError(String(error?.message || error));
        }
    });
});
