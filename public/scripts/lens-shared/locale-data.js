// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Locale data for the helpers in util.js. Keys already provided by
// public/locales/{zh-cn,zh-tw}.json ("just now", "${0} min ago",
// "${0} hr ago") are intentionally omitted to prevent duplicate conflicts.

const ZH_CN = {
    'yesterday ${0}': '昨天 ${0}',
    '${0} days ago': '${0} 天前',
    '${0}/${1}': '${0}月${1}日',
    'Attach images': '添加图片',
    'Attached image': '已附加图片',
    'Preview image': '预览图片',
    'Image preview': '图片预览',
    'Remove image': '移除图片',
    'Only image files can be attached.': '仅支持附加图片文件。',
    '[Image]': '[图片]',
};

const ZH_TW = {
    'yesterday ${0}': '昨天 ${0}',
    '${0} days ago': '${0} 天前',
    '${0}/${1}': '${0}月${1}日',
    'Attach images': '新增圖片',
    'Attached image': '已附加圖片',
    'Preview image': '預覽圖片',
    'Image preview': '圖片預覽',
    'Remove image': '移除圖片',
    'Only image files can be attached.': '僅支援附加圖片檔案。',
    '[Image]': '[圖片]',
};

export function registerLensSharedLocaleData(addLocaleData) {
    addLocaleData('zh-cn', ZH_CN);
    addLocaleData('zh-tw', ZH_TW);
}
