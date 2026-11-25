// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { createPluginI18n } from '../../lib/plugin-i18n.js';

const ZH_CN = {
    // Live UI strings owned by main.js
    'Completion Preset Assistant': '聊天补全预设助手',
    'Open Assistant': '打开助手',
    'Open in Workbench': '在工作台中打开',
    'Workbench is unavailable.': '工作台当前不可用。',
    'Regenerate aborted': '重新生成已中止',
    'Regenerate aborted — could not roll back commit on ${0}: ${1}': '重新生成已中止——无法回退 ${0} 上的提交：${1}',
    'Edit': '编辑',
    'Edit and regenerate from here': '编辑并从此处重新生成',
    'Edit message — saving will regenerate from this turn:': '编辑消息——保存将从此轮开始重新生成：',
    'Create New Preset': '新建预设',
    'Bundle skills with this preset': '将 Skills 打包到此预设',
    'No preset is currently selected.': '当前未选择预设。',
    'Enter a name for the new preset.': '请输入新预设名称。',
    'Preset already exists: ${0}': '预设已存在：${0}',
    'Preset created: ${0}': '已创建预设：${0}',
    'Create preset failed.': '创建预设失败。',
    'Iteration AI prompt preset (params + prompt)': '迭代 AI 的提示词预设',
    'Iteration AI API preset (Connection profile)': '迭代 AI 的 API 预设',
    'Include world info (simulate current chat)': '包含世界书信息（按当前聊天重新模拟）',
    'Tool-call retries on invalid/missing tool call (N)': '工具调用重试次数（无效/缺失时）',
    'Iteration System Prompts (advanced)': '迭代系统提示词（高级）',
    'Advanced prompts': '高级提示词',
    'Iteration base prompt': '迭代基础提示词',
    'Orchestrator optimization mode prompt': '多智能体编排优化模式提示词',
    'Jailbreak-only mode prompt': '仅越狱模式提示词',
    'Base prompt (sent in every mode)': '基础提示词（每种模式都会发送）',
    'Mode addition — orchestrator-optimize': '模式追加 —— 多智能体编排适配',
    'Mode addition — jailbreak-only': '模式追加 —— 仅保留破限',
    'Reset to default': '重置为默认',
    'AI request failed: ${0}': '模型请求失败：${0}',
    '(none)': '（无）',
    '(current)': '（当前）',
    // Strings consumed by the iteration-studio adapter via deps.i18n
    'General editing': '通用编辑',
    'Adapt for orchestrator': '多智能体编排适配',
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
    'Clone preset': '复制预设',
    'Clone succeeded but session migration failed: ${0}': '复制成功，但会话迁移失败：${0}',
    'Session moved to "${0}"': '会话已迁移到「${0}」',
    // Patch-storage conflict UI (shared keys; each extension owns its locale table).
    'Cannot undo this change: the preset has been modified elsewhere.':
        '无法回退此次修改：预设的相关内容已经发生改变。',
    'Cannot undo this change: the memory graph schema has been modified elsewhere.':
        '无法回退此次修改：记忆图的相关内容已经发生改变。',
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
    'This change was saved by an older version and cannot be applied after a reload. Discard this step and request the change again.':
        '此修改由旧版本保存，重新加载后无法应用。请丢弃此步并重新请求修改。',
    'View raw record': '查看原始记录',
    'Completion Preset Assistant behavior summary': '聊天补全预设助手行为摘要',
    'Prompts & AI': '提示词与 AI',
    'All 3 iteration prompts': '全部 3 项迭代提示词',
    '${promptStatus} use built-in defaults — AI connection and preset are configured in Workbench → Settings.': '${promptStatus}均使用内置默认值 —— 连接与预设在工作台 → 设置中配置。',
    '${customCount} iteration prompts use custom overrides — AI connection and preset are configured in Workbench → Settings.': '${customCount} 项迭代提示词使用了自定义覆盖 —— 连接与预设在工作台 → 设置中配置。',
};

const ZH_TW = {
    'Completion Preset Assistant': '聊天補全預設助手',
    'Open Assistant': '開啟助手',
    'Open in Workbench': '在工作台中開啟',
    'Workbench is unavailable.': '工作台目前無法使用。',
    'Regenerate aborted': '重新產生已中止',
    'Regenerate aborted — could not roll back commit on ${0}: ${1}': '重新產生已中止——無法回退 ${0} 上的提交：${1}',
    'Edit': '編輯',
    'Edit and regenerate from here': '編輯並從此處重新產生',
    'Edit message — saving will regenerate from this turn:': '編輯訊息——儲存將從此輪開始重新產生：',
    'Create New Preset': '新建預設',
    'Bundle skills with this preset': '將 Skills 打包到此預設',
    'No preset is currently selected.': '目前未選擇預設。',
    'Enter a name for the new preset.': '請輸入新預設名稱。',
    'Preset already exists: ${0}': '預設已存在：${0}',
    'Preset created: ${0}': '已建立預設：${0}',
    'Create preset failed.': '建立預設失敗。',
    'Iteration AI prompt preset (params + prompt)': '迭代 AI 的提示詞預設',
    'Iteration AI API preset (Connection profile)': '迭代 AI 的 API 預設',
    'Include world info (simulate current chat)': '包含世界書資訊（按目前聊天重新模擬）',
    'Tool-call retries on invalid/missing tool call (N)': '工具調用重試次數（無效/缺失時）',
    'Iteration System Prompts (advanced)': '迭代系統提示詞（進階）',
    'Advanced prompts': '進階提示詞',
    'Iteration base prompt': '迭代基礎提示詞',
    'Orchestrator optimization mode prompt': '多智能體編排最佳化模式提示詞',
    'Jailbreak-only mode prompt': '僅越獄模式提示詞',
    'Base prompt (sent in every mode)': '基礎提示詞（每種模式都會傳送）',
    'Mode addition — orchestrator-optimize': '模式追加 —— 多智能體編排適配',
    'Mode addition — jailbreak-only': '模式追加 —— 僅保留破限',
    'Reset to default': '重置為預設',
    'AI request failed: ${0}': '模型請求失敗：${0}',
    '(none)': '（無）',
    '(current)': '（目前）',
    'General editing': '通用編輯',
    'Adapt for orchestrator': '多智能體編排適配',
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
    'Clone preset': '複製預設',
    'Clone succeeded but session migration failed: ${0}': '複製成功，但對話遷移失敗：${0}',
    'Session moved to "${0}"': '對話已遷移到「${0}」',
    // Patch-storage conflict UI (shared keys).
    'Cannot undo this change: the preset has been modified elsewhere.':
        '無法回退此次修改：預設的相關內容已經發生改變。',
    'Cannot undo this change: the memory graph schema has been modified elsewhere.':
        '無法回退此次修改：記憶圖的相關內容已經發生改變。',
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
    'This change was saved by an older version and cannot be applied after a reload. Discard this step and request the change again.':
        '此修改由舊版本儲存，重新載入後無法套用。請丟棄此步並重新請求修改。',
    'View raw record': '檢視原始記錄',
    'Completion Preset Assistant behavior summary': '聊天補全預設助手行為摘要',
    'Prompts & AI': '提示詞與 AI',
    'All 3 iteration prompts': '全部 3 項迭代提示詞',
    '${promptStatus} use built-in defaults — AI connection and preset are configured in Workbench → Settings.': '${promptStatus}均使用內建預設值 —— 連線與預設在工作台 → 設定中設定。',
    '${customCount} iteration prompts use custom overrides — AI connection and preset are configured in Workbench → Settings.': '${customCount} 項迭代提示詞使用了自訂覆寫 —— 連線與預設在工作台 → 設定中設定。',
};

const PLUGIN_I18N = createPluginI18n({ 'zh-cn': ZH_CN, 'zh-tw': ZH_TW });

export function i18n(text) {
    return PLUGIN_I18N.translate(String(text || ''));
}

export function i18nFormat(text, ...values) {
    return PLUGIN_I18N.format(String(text || ''), ...values);
}
