// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Locale data for the helpers in util.js.

const ZH_CN = {
    'just now': '刚刚',
    '${0} min ago': '${0} 分钟前',
    '${0} hr ago': '${0} 小时前',
    'yesterday ${0}': '昨天 ${0}',
    '${0} days ago': '${0} 天前',
    '${0}/${1}': '${0}月${1}日',
};

const ZH_TW = {
    'just now': '剛才',
    '${0} min ago': '${0} 分鐘前',
    '${0} hr ago': '${0} 小時前',
    'yesterday ${0}': '昨天 ${0}',
    '${0} days ago': '${0} 天前',
    '${0}/${1}': '${0}月${1}日',
};

export function registerLensSharedLocaleData(addLocaleData) {
    addLocaleData('zh-cn', ZH_CN);
    addLocaleData('zh-tw', ZH_TW);
}
