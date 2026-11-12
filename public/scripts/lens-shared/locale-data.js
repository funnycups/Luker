// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Locale data for the helpers in util.js. Keys already provided by
// public/locales/{zh-cn,zh-tw}.json ("just now", "${0} min ago",
// "${0} hr ago") are intentionally omitted to prevent duplicate conflicts.

const ZH_CN = {
    'yesterday ${0}': '昨天 ${0}',
    '${0} days ago': '${0} 天前',
    '${0}/${1}': '${0}月${1}日',
};

const ZH_TW = {
    'yesterday ${0}': '昨天 ${0}',
    '${0} days ago': '${0} 天前',
    '${0}/${1}': '${0}月${1}日',
};

export function registerLensSharedLocaleData(addLocaleData) {
    addLocaleData('zh-cn', ZH_CN);
    addLocaleData('zh-tw', ZH_TW);
}
