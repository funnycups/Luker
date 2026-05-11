/**
 * IterationStudio — shared i18n.
 *
 * The shell renders panel titles, button labels, status messages, and so on
 * from its own translation table — adapters only have to translate their
 * own bespoke strings (popup title, system prompt copy, action descriptions
 * returned from tool dispatchers, etc.).
 *
 * Locale registration is deferred until DOM-ready because
 * `addLocaleData` in `../i18n.js` no-ops with a warning if `localeData`
 * hasn't been fetched yet. iteration-studio modules get imported during
 * extension init which races with the async locale fetch; running
 * addLocaleData at module load was silently dropping every key here.
 */

import { addLocaleData, translate } from '../i18n.js';

export function i18n(text) {
    return translate(String(text || ''));
}

export function i18nFormat(key, ...values) {
    return i18n(key).replace(/\$\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
}

const ZH_CN_DATA = {
    'AI Iteration Studio': 'AI 迭代工作台',
    'Iteration source: ${0}': '迭代来源:${0}',
    'Global profile': '全局 profile',
    'Conversation': '对话',
    'Session history': '会话历史',
    'Tell the AI what to change...': '告诉 AI 要修改什么…',
    'Send to AI': '发送给 AI',
    'Stop': '终止',
    'Clear Session': '清空当前会话',
    'Apply to Global': '应用到全局',
    'Apply to Character': '应用到角色卡',
    'New session': '新建会话',
    'Close': '关闭',
    'Delete': '删除',
    'Delete this saved session?': '删除这个已保存的会话?',
    'AI iteration is running...': 'AI 迭代进行中…',
    'AI suggested changes are waiting for approval.': 'AI 提出的修改正在等待审批。',
    'AI iteration updated.': 'AI 迭代已更新。',
    'Running auto-continue...': '正在自动继续…',
    'Iteration session reset.': '当前会话已重置。',
    'New session created.': '已新建会话。',
    'Session loaded.': '会话已载入。',
    'Session deleted.': '会话已删除。',
    'Iteration run cancelled.': '迭代已取消。',
    'Iteration run failed: ${0}': '迭代失败:${0}',
    'Delete session failed: ${0}': '删除会话失败:${0}',
    'Applying approved changes...': '正在应用已批准的修改…',
    'Changes approved and applied.': '修改已批准并应用。',
    'Changes approved and applied. Waiting for your next instruction.': '修改已批准并应用。等待你的下一条指令。',
    'Changes rejected.': '修改已拒绝。',
    'Regenerating message...': '正在重新生成…',
    'Rolled back to selected round.': '已回滚到所选轮次。',
    'Apply failed: ${0}': '应用失败:${0}',
    '(No character card)': '(没有角色卡)',
    'No active character selected.': '当前未选择角色卡。',
    'Auto-apply': '自动应用',
    'Skip the manual approve step for tool calls. Changes apply immediately.': '跳过工具调用的手动批准步骤,修改立即生效。',
    'Auto-apply enabled.': '自动应用已开启。',
    'Auto-apply disabled.': '自动应用已关闭。',
    'Expand diff': '放大 diff',
    'Resize diff columns': '调整 diff 分栏',
    'Line diff (+${0} -${1})': '行级 diff (+${0} -${1})',
    'Line diff': '行级 diff',
    'Close expanded diff': '关闭放大的 diff',
    'Before': '修改前',
    'After': '修改后',
    '(missing)': '(缺失)',
    'Assistant': 'Assistant',
    'User': 'User',
    'System': 'System',
    'auto': '自动',
    'Profile changes': 'Profile 变更',
    'Refresh': '刷新',
    'Rollback to here': '回滚到这里',
    'Tools: ${0}': '工具:${0}',
    'Changes proposed by AI': 'AI 提议的修改',
    'Proposed tools: ${0}': '提议工具:${0}',
    'Approve & Apply': '批准并应用',
    'Reject': '拒绝',
    '(empty session)': '(空会话)',
    'No saved sessions yet.': '暂无已保存的会话。',
    'Character: ${0}': '角色卡:${0}',
    'Global': '全局',
    'Function output is invalid.': '函数输出无效。',
    'Executed ${0} operation(s).': '已执行 ${0} 项操作。',
    'Summary: ${0}': '总结:${0}',
    'Signal that another iteration is needed after the current tools complete. Use when more changes are pending.': '在当前工具执行完后表示还需要继续迭代。当还有改动要做时调用。',
    'Signal that the iteration is complete and no further changes are needed.': '表示迭代结束,不需要再继续。',
};

const ZH_TW_DATA = {
    'AI Iteration Studio': 'AI 迭代工作台',
    'Iteration source: ${0}': '迭代來源:${0}',
    'Global profile': '全域 profile',
    'Conversation': '對話',
    'Session history': '會話歷史',
    'Tell the AI what to change...': '告訴 AI 要修改什麼…',
    'Send to AI': '發送給 AI',
    'Stop': '終止',
    'Clear Session': '清空目前會話',
    'Apply to Global': '套用到全域',
    'Apply to Character': '套用到角色卡',
    'New session': '新建會話',
    'Close': '關閉',
    'Delete': '刪除',
    'Delete this saved session?': '刪除這個已儲存的會話?',
    'AI iteration is running...': 'AI 迭代進行中…',
    'AI suggested changes are waiting for approval.': 'AI 提出的修改正在等待批准。',
    'AI iteration updated.': 'AI 迭代已更新。',
    'Running auto-continue...': '正在自動繼續…',
    'Iteration session reset.': '目前會話已重設。',
    'New session created.': '已新建會話。',
    'Session loaded.': '會話已載入。',
    'Session deleted.': '會話已刪除。',
    'Iteration run cancelled.': '迭代已取消。',
    'Iteration run failed: ${0}': '迭代失敗:${0}',
    'Delete session failed: ${0}': '刪除會話失敗:${0}',
    'Applying approved changes...': '正在套用已批准的修改…',
    'Changes approved and applied.': '修改已批准並套用。',
    'Changes approved and applied. Waiting for your next instruction.': '修改已批准並套用。等待你的下一條指令。',
    'Changes rejected.': '修改已拒絕。',
    'Regenerating message...': '正在重新生成…',
    'Rolled back to selected round.': '已回滾到所選輪次。',
    'Apply failed: ${0}': '套用失敗:${0}',
    '(No character card)': '(沒有角色卡)',
    'No active character selected.': '目前未選擇角色卡。',
    'Auto-apply': '自動套用',
    'Skip the manual approve step for tool calls. Changes apply immediately.': '跳過工具呼叫的手動批准步驟,修改立即生效。',
    'Auto-apply enabled.': '自動套用已開啟。',
    'Auto-apply disabled.': '自動套用已關閉。',
    'Expand diff': '放大 diff',
    'Resize diff columns': '調整 diff 分欄',
    'Line diff (+${0} -${1})': '行級 diff (+${0} -${1})',
    'Line diff': '行級 diff',
    'Close expanded diff': '關閉放大的 diff',
    'Before': '修改前',
    'After': '修改後',
    '(missing)': '(缺失)',
    'Assistant': 'Assistant',
    'User': 'User',
    'System': 'System',
    'auto': '自動',
    'Profile changes': 'Profile 變更',
    'Refresh': '重新整理',
    'Rollback to here': '回滾到這裡',
    'Tools: ${0}': '工具:${0}',
    'Changes proposed by AI': 'AI 提議的修改',
    'Proposed tools: ${0}': '提議工具:${0}',
    'Approve & Apply': '批准並套用',
    'Reject': '拒絕',
    '(empty session)': '(空會話)',
    'No saved sessions yet.': '暫無已儲存的會話。',
    'Character: ${0}': '角色卡:${0}',
    'Global': '全域',
    'Function output is invalid.': '函式輸出無效。',
    'Executed ${0} operation(s).': '已執行 ${0} 項操作。',
    'Summary: ${0}': '總結:${0}',
    'Signal that another iteration is needed after the current tools complete. Use when more changes are pending.': '在目前工具執行完後表示還需要繼續迭代。當還有改動要做時呼叫。',
    'Signal that the iteration is complete and no further changes are needed.': '表示迭代結束,不需要再繼續。',
};

function applyLocaleData() {
    addLocaleData('zh-cn', ZH_CN_DATA);
    addLocaleData('zh-tw', ZH_TW_DATA);
}

if (typeof jQuery === 'function') {
    jQuery(applyLocaleData);
} else if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyLocaleData);
    } else {
        applyLocaleData();
    }
}
