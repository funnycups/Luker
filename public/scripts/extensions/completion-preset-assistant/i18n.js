// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { createPluginI18n } from '../../lib/plugin-i18n.js';

const ZH_CN = {
    // Live UI strings owned by main.js
    'Completion Preset Assistant': '聊天补全预设助手',
    'Open Assistant': '打开助手',
    'Open in Workbench': '在工作台中打开',
    'Workbench is unavailable.': '工作台当前不可用。',
    'Create New Preset': '新建预设',
    'Bundle skills with this preset': '将 Skills 打包到此预设',
    'No preset is currently selected.': '当前未选择预设。',
    'Enter a name for the new preset.': '请输入新预设名称。',
    'Preset already exists: ${0}': '预设已存在：${0}',
    'Preset created: ${0}': '已创建预设：${0}',
    'Create preset failed.': '创建预设失败。',
    'Advanced prompts': '高级提示词',
    'Iteration base prompt': '迭代基础提示词',
    'Orchestrator optimization mode prompt': '多智能体编排优化模式提示词',
    'Jailbreak-only mode prompt': '仅越狱模式提示词',
    'Reset to default': '重置为默认',
    'AI request failed: ${0}': '模型请求失败：${0}',
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
    'Create New Preset': '新建預設',
    'Bundle skills with this preset': '將 Skills 打包到此預設',
    'No preset is currently selected.': '目前未選擇預設。',
    'Enter a name for the new preset.': '請輸入新預設名稱。',
    'Preset already exists: ${0}': '預設已存在：${0}',
    'Preset created: ${0}': '已建立預設：${0}',
    'Create preset failed.': '建立預設失敗。',
    'Advanced prompts': '進階提示詞',
    'Iteration base prompt': '迭代基礎提示詞',
    'Orchestrator optimization mode prompt': '多智能體編排最佳化模式提示詞',
    'Jailbreak-only mode prompt': '僅越獄模式提示詞',
    'Reset to default': '重置為預設',
    'AI request failed: ${0}': '模型請求失敗：${0}',
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
