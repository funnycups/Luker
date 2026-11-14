// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI iteration conversation loop, shared by the four workbenches. Each round:
// the model may call read tools (results go back to it) and edit tools
// (applied to the AI's own working copy; it is told they are pending the
// user's review). The loop ends when a round makes no tool calls. Edits
// never touch Luker here — the page diffs the copy and the user decides.
// Pure: the adapter supplies tools and executors.

import { i18n, listSeparator } from '../i18n.js';

export const MAX_ROUNDS = 8;

/** Prompt that wraps every workbench's own instructions. */
export function wrapperPrompt({ wsName, scopeText, builtin = true }) {
    if (!builtin) return '';
    return [
        `【工作台说明】你在 Luker「工作台」插件里帮用户修改「${wsName}」（${scopeText}）。`,
        '这是修改设定的工具任务，不是写故事；生成预设里关于文风、扮演、篇幅、格式的要求在这里不适用。',
        '你的修改只进入草稿：用户会看到逐条的改动清单，自己决定哪些要应用。不要让用户逐步确认，改完用一两句话说明改了什么、为什么。',
        '回复用户用简体中文、短句，不要提工具名、字段名和英文 id；被修改的内容本身沿用原来的语言。',
        '改动从根上改：调整规则、判断标准、结构，不要针对某一句加「不要写 X」式的补丁。改动少而准。',
    ].join('\n');
}

/**
 * Runs one user turn.
 * @param {{
 *   messages: object[],                 conversation so far (OpenAI shape), system included
 *   live: any,                          AI working copy at the start of the turn
 *   tools: object[],                    tool definitions
 *   isRead(name): boolean,
 *   runRead(call, live): Promise<any>,  → result object
 *   runEdit(call, live): Promise<any>,  → next live (throw to report an error to the model)
 *   request(messages, tools): Promise<{ text, calls }>,
 *   onRound?(info), signal?
 * }} opts
 * @returns {Promise<{ messages, live, text: string, reads: object[], edits: object[], failed: object[] }>}
 */
export async function runIterateTurn({ messages, live, tools, isRead, runRead, runEdit, request, onRound = null, signal = null }) {
    const msgs = [...messages];
    let current = live;
    const reads = [];
    const edits = [];
    const failed = [];
    let text = '';
    for (let round = 0; round < MAX_ROUNDS; round++) {
        if (signal?.aborted) throw new Error(i18n('Stopped'));
        const res = await request(msgs, tools);
        text = res.text || text;
        const calls = res.calls || [];
        if (!calls.length) {
            if (res.text) msgs.push({ role: 'assistant', content: res.text });
            break;
        }
        msgs.push({ role: 'assistant', content: res.text || '', tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) });
        for (const call of calls) {
            let content;
            try {
                if (isRead(call.name)) {
                    content = await runRead(call, current);
                    reads.push({ name: call.name, args: call.args });
                } else {
                    const next = await runEdit(call, current);
                    if (next === current || JSON.stringify(next) === JSON.stringify(current)) {
                        content = { status: 'noop', message: 'No change: the draft already matches. Re-read before retrying.' };
                    } else {
                        current = next;
                        edits.push({ name: call.name, args: call.args });
                        content = { status: 'pending_review', message: 'Applied to the draft. The user will review the change list and decide.' };
                    }
                }
            } catch (err) {
                failed.push({ name: call.name, error: String(err?.message || err) });
                content = { error: String(err?.envelope ? JSON.stringify(err.envelope) : err?.message || err) };
            }
            msgs.push({ role: 'tool', tool_call_id: call.id, content: typeof content === 'string' ? content : JSON.stringify(content) });
        }
        onRound?.({ round, reads: reads.length, edits: edits.length, live: current });
    }
    return { messages: msgs, live: current, text, reads, edits, failed };
}

/**
 * After the user decides, tell the model what happened (so it does not redo
 * rejected changes): appended as a short system-ish user note on the next turn.
 */
export function decisionNote({ applied = [], discarded = [], unsaved = [] }) {
    if (!applied.length && !discarded.length && !unsaved.length) return '';
    const parts = [];
    if (applied.length) parts.push(`用户应用了：${applied.join(listSeparator())}`);
    if (discarded.length) parts.push(`用户没要：${discarded.join(listSeparator())}（不要再提同样的改法，除非用户要求）`);
    if (unsaved.length) parts.push(`用户批准了但没保存成功：${unsaved.join(listSeparator())}（内容已被别处改动或写入失败，要改请先重新读取）`);
    return `（上一轮的改动：${parts.join('；')}。没要的部分已从草稿里撤回。）`;
}

/** Drops oversized history so long sessions stay within budget. */
export function trimMessages(messages, maxChars = 60000) {
    const sys = messages.filter(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    let total = 0;
    const kept = [];
    for (let i = rest.length - 1; i >= 0; i--) {
        total += String(rest[i].content || '').length + JSON.stringify(rest[i].tool_calls || '').length;
        if (total > maxChars && kept.length > 4) break;
        kept.unshift(rest[i]);
    }
    // Never start on a tool result without its call.
    while (kept.length && kept[0].role === 'tool') kept.shift();
    return [...sys, ...kept];
}
