// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { createPluginI18n } from '../../lib/plugin-i18n.js';

const ZH_CN = {
    'CardApp (card enablement)': 'CardApp（本卡开关）',
    'Entry configured': '已配置入口文件',
};

const ZH_TW = {
    'CardApp (card enablement)': 'CardApp（本卡開關）',
    'Entry configured': '已設定入口檔案',
};

const PLUGIN_I18N = createPluginI18n({ 'zh-cn': ZH_CN, 'zh-tw': ZH_TW });

export function i18n(text) {
    return PLUGIN_I18N.translate(String(text || ''));
}

export function i18nFormat(text, ...values) {
    return PLUGIN_I18N.format(String(text || ''), ...values);
}
