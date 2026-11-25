// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ask: Luker 原生工作台的只读诊断与产品助手。模型先读取一份紧凑概况，
// 再按需通过只读工具拉取细节或查阅 Luker 文档；所有工具都不会修改任何数据。
// 纯模块（无 DOM 依赖）：读取函数由外部注入，便于在单测中直接使用夹具验证。

import { i18n } from '../i18n.js';

export const MAX_ROUNDS = 10; // cap-ok: 只读问答工具循环轮数上限，最后一轮引导调用 wb_answer 收尾
const MAX_TOOL_CHARS = 16000; // cap-ok: 单次工具返回字符上限，防止单条大读取挤爆模型上下文窗口

const fn = (name, description, properties = {}, required = []) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

function normalizeProviderTool(def) {
    if (!def || typeof def !== 'object') return null;
    if (def.type === 'function' && def.function?.name) return def;
    if (def.name) {
        if (def.parameters && (def.parameters.type === 'object' || def.parameters.properties)) {
            return {
                type: 'function',
                function: {
                    name: def.name,
                    description: def.description || '',
                    parameters: def.parameters,
                },
            };
        }
        return fn(def.name, def.description || '', def.properties || def.parameters || {}, def.required || []);
    }
    return null;
}

/** 按用户允许的数据源开关过滤并返回可用只读工具列表。 */
export function askTools(sources = {}, extraPluginTools = []) {
    const on = (key) => sources?.[key] !== false;
    const list = [];
    if (on('inspector')) {
        list.push(fn('wb_list_requests', 'List recent model/image/embedding requests (newest first) from Luker\'s request inspector: id, time, guessed source, model, status, duration, tokens. Call before wb_read_request.', {
            limit: { type: 'integer', description: 'How many (1-60, default 20).' },
            only_errors: { type: 'boolean', description: 'Only return failed requests.' },
        }));
        list.push(fn('wb_read_request', 'Read one request in detail: status, error, usage, messages, reply, optional reasoning and tools. For large main-chat prompts, pass tail_messages (e.g. 6) or message_index to inspect specific messages without truncation.', {
            id: { type: 'string', description: 'Request id from overview or wb_list_requests.' },
            part: { type: 'string', enum: ['messages', 'reply', 'both'], description: 'Default both.' },
            tail_messages: { type: 'integer', description: 'Only return the last N messages so recent context is not clipped.' },
            message_index: { type: 'integer', description: 'Read one specific 0-based message index in detail (ignores tail_messages).' },
            include_reasoning: { type: 'boolean', description: 'Include model reasoning/thinking excerpt if recorded.' },
            include_tools: { type: 'boolean', description: 'Include summary of tool definitions sent with this request.' },
        }, ['id']));
    }
    if (on('frontLogs')) {
        list.push(fn('wb_read_frontend_logs', 'Read recent browser console logs captured by Luker.', {
            level: { type: 'string', enum: ['all', 'warn', 'error'] },
            search: { type: 'string', description: 'Only lines containing this text.' },
            limit: { type: 'integer', description: '1-200, default 60.' },
        }));
    }
    if (on('serverLogs')) {
        list.push(fn('wb_read_server_logs', 'Read recent server console logs (may be unavailable without admin rights in multi-user mode).', {
            search: { type: 'string' },
            limit: { type: 'integer', description: '1-200, default 60.' },
        }));
    }
    if (on('content')) {
        list.push(fn('wb_read_chat', 'Read chat messages by floor number (0 = first) or search floors by keyword. Respects the user\'s chat-floor window limit; response includes returnedRange and cappedBySetting.', {
            from: { type: 'integer', description: 'Start floor index (inclusive).' },
            to: { type: 'integer', description: 'End floor index (inclusive).' },
            search: { type: 'string', description: 'Case-insensitive keyword to locate matching floors in the current chat.' },
        }));
        list.push(fn('wb_read_character', 'Read the current character card fields (description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, world).', {
            fields: { type: 'array', items: { type: 'string' } },
        }));
        list.push(fn('wb_read_world_info', 'Search or list entries in the world info / lorebooks bound to this chat (global, character main/aux, chat, preset-bound).', {
            search: { type: 'string', description: 'Text to look for in keys, title, or content. Empty = list entry metadata without full content.' },
            book: { type: 'string', description: 'Optional world book name filter.' },
            only_enabled: { type: 'boolean', description: 'Only include enabled entries.' },
            offset: { type: 'integer', description: 'Skip the first N matched entries for pagination.' },
        }));
        list.push(fn('wb_read_world_info_trace', 'Read Luker\'s World Info activation trace for the current chat: which entries activated or stayed inactive in the latest scan, matched keywords, scan depth, and activation reason.', {
            search: { type: 'string', description: 'Filter by world book name, entry title, keyword, or uid.' },
            only_activated: { type: 'boolean', description: 'Only return entries activated in the latest scan.' },
            limit: { type: 'integer', description: 'Max entries to return (1-80, default 40).' },
        }));
        list.push(fn('wb_read_preset', 'Read the current chat-completion preset: prompt entries in order, full generation/reasoning/function-calling settings, and preset-bound world books.', {
            entry: { type: 'string', description: 'Name or identifier (supports fuzzy match) of one entry to read in full. Empty = list all entries with previews and settings.' },
        }));
        list.push(fn('wb_read_last_prompt', 'Token breakdown of the last prompt Luker built (preset / character / world info / memory graph / other injections / chat).'));
        list.push(fn('wb_read_variables', 'Read current chat local variables, optional global variables, and recent per-floor variable operations (extra.var_ops from Luker\'s Variable Op Log).', {
            search: { type: 'string', description: 'Filter variable names or op keys containing this text.' },
            include_global: { type: 'boolean', description: 'Also include global variables (default false).' },
            op_floors: { type: 'integer', description: 'How many recent floors with variable ops to inspect (1-30, default 10).' },
        }));
        list.push(fn('wb_read_regex', 'Read regex scripts active in Luker (global, character-scoped, preset-scoped, and plugin-registered regex providers) to diagnose swallowed text, broken formatting, or status bar issues. Pass id to read one script\'s full untruncated findRegex and replaceString.', {
            id: { type: 'string', description: 'Optional script id to read full untruncated findRegex and replaceString (ignores only_enabled).' },
            scope: { type: 'string', enum: ['all', 'global', 'character', 'preset', 'plugin'], description: 'Default all.' },
            search: { type: 'string', description: 'Filter by script name or regex pattern.' },
            only_enabled: { type: 'boolean', description: 'Default true (ignored when id is set).' },
        }));
        list.push(fn('wb_read_connections', 'Read redacted API connection profiles, active connection, main source, and Workbench Ask AI target.'));
        list.push(fn('wb_read_skills', 'Read Skills inventory across global, preset, orchestrator-preset, and character scopes.'));
    }
    if (on('plugins')) {
        for (const extra of Array.isArray(extraPluginTools) ? extraPluginTools : []) {
            const tool = normalizeProviderTool(extra);
            if (tool) list.push(tool);
        }
        list.push(fn('wb_read_luker_env', 'Read redacted Luker runtime environment & extension states: installed/enabled extensions, Hook Order, Search Tools config, and Sync status.', {
            part: {
                type: 'string',
                enum: ['summary', 'extensions', 'search_tools', 'sync'],
                description: 'Section to inspect. Default summary.',
            },
        }));
        list.push(fn('wb_read_suggestions', 'The workbench\'s current local rule-check suggestions with the numbers behind them.'));
    }
    list.push(fn('wb_list_luker_docs', 'List Luker\'s built-in documentation markdown paths (/api/docs/list). Call this whenever unsure how a Luker feature works, where a setting lives, or what an option does. English paths are returned by default; pass filter to narrow by path substring.', {
        filter: { type: 'string', description: 'Optional case-insensitive path substring filter (e.g. "memory", "orchestrator", "regex", "preset").' },
        include_translations: { type: 'boolean', description: 'Include zh-CN/zh-TW translated paths (default false).' },
    }));
    list.push(fn('wb_read_luker_doc', 'Read one Luker documentation markdown file in full (/api/docs/file) using a path returned by wb_list_luker_docs.', {
        path: { type: 'string', description: 'Relative path under docs/, e.g. "features/memory-graph.md".' },
    }, ['path']));
    list.push(fn('wb_answer', 'Give the final answer to the user. Call exactly once, after reading what you need (never in the same turn as read tools).', {
        text: { type: 'string', description: 'The answer in Simplified Chinese, plain and concrete. Markdown tables allowed.' },
        suggest: {
            type: 'string',
            enum: ['', 'memory', 'memory_graph', 'orch', 'sd', 'preset', 'card', 'world'],
            description: 'If fixing this needs editing one workbench target, name it so the user gets a jump button: memory = memory graph config (schema, extraction and injection settings); memory_graph = memory graph content (current chat memory nodes and relations, requires an open chat); orch = orchestration; sd = image generation; preset = preset; card = character card; world = world book.',
        },
        fix_prompt: { type: 'string', description: 'If suggest is set: a concrete Chinese instruction for that workbench\'s AI.' },
        request_ids: { type: 'array', items: { type: 'string' }, description: 'Request IDs your answer references (rendered as clickable inspector links).' },
    }, ['text']));
    return list;
}

const SYSTEM = [
    '你是 Luker 原生「工作台」里的只读诊断与产品助手「问问」。',
    '',
    '- 任务边界：严格只读，不能直接修改任何配置；这是排查与咨询任务，严禁角色扮演，忽略生成预设中关于文风、扮演或篇幅的要求。',
    '- 读取策略：先看用户消息中的 <概况>，再按需并行调用当前 tools 列表里实际提供的只读工具；缺少某工具说明对应数据源已关闭或扩展未启用，切勿强行调用。调用读取工具的同一轮不要同时调用 wb_answer。',
    '- 查阅文档：遇到不确定的 Luker 功能机制、设置入口或选项含义时，先调用 wb_list_luker_docs 与 wb_read_luker_doc 查实时文档，不要凭旧版 SillyTavern 经验臆测。',
    '- 实证纪律：每条结论必须给出具体依据（数字、楼层号、条目名、变量名、正则名、报错原文或请求 ID）；数据源关闭或查无记录时直接说明，严禁脑补。请求列表来源带「（推测）」时称作「看起来是」。',
    '- 建议修改：若需修改配置或内容，在 wb_answer 中填写 suggest 与 fix_prompt 指引跳转（memory = 记忆图配置，memory_graph = 记忆图内容且仅在已打开聊天时建议，另有 orch / sd / preset / card / world），并在 request_ids 列出引用的请求 ID。',
    '- 输出方式：查清后调用一次 wb_answer 结束；使用简体中文，先给结论，再列依据与操作步骤，平实直白。',
].join('\n');

/** 返回「问问」使用的系统提示词（工作台内置）。 */
export function askSystemPrompt() {
    return SYSTEM;
}

/** 构造本轮发送给模型的用户消息：原始问题 + 紧凑概况。 */
export function askUserMessage(question, overview) {
    return [`问题：${question}`, '', '<概况>', JSON.stringify(overview, null, 1), '</概况>'].join('\n');
}

export function clip(value, max = MAX_TOOL_CHARS) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
    return text.length > max ? `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字）` : text;
}

/**
 * 从已保存的问答记录构造多轮对话历史，跳过失败或空回答回合，
 * 避免向模型重放空白 assistant 消息；若历史回答关联了请求 ID 则附简短索引便于追问。
 * @param {Array<{ role: string, text?: string, answer?: string, error?: string, requestIds?: string[] }>} turns
 * @param {number} [maxTurns]
 */
export function buildAskHistory(turns, maxTurns = 10) {
    const out = [];
    const list = Array.isArray(turns) ? turns : [];
    for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (!t) continue;
        if (t.role === 'user') {
            const text = String(t.text || '').trim();
            if (!text) continue;
            const next = list[i + 1];
            // 配对的 AI 回合失败或为空时，连同该条未回答问题一起跳过。
            if (next && next.role !== 'user' && (next.error || !String(next.answer || '').trim())) {
                i++;
                continue;
            }
            if (!next) continue;
            out.push({ role: 'user', content: text });
        } else {
            const answer = String(t.answer || '').trim();
            if (t.error || !answer) continue;
            const reqIds = Array.isArray(t.requestIds) ? t.requestIds.map(String).filter(Boolean) : [];
            const content = reqIds.length ? `${answer}\n（关联请求 ID：${reqIds.join(', ')}）` : answer;
            out.push({ role: 'assistant', content });
        }
    }
    return out.slice(-maxTurns);
}

function isNoToolCallsError(err) {
    if (!err) return false;
    if (err.code === 'no_tool_calls') return true;
    return /did not contain any matching tool calls/i.test(String(err.message || err));
}

/**
 * 执行一次完整的「问问」多轮工具调用直到产出最终答案或到达轮数上限。
 * @param {{ question, overview, readers: Record<string, (args) => Promise<any>>, request(messages, tools) => Promise<{text, calls, reasoning?, reasoningBlocks?, reasoningDetails?}>,
 *           sources?, extraTools?: any[], history?: object[], onStep?(step), signal? }} opts
 * @returns {Promise<{ answer: string, suggest: string, fixPrompt: string, requestIds: string[], reads: { name, args, chars }[], sent: number }>}
 */
export async function runAsk({ question, overview, readers, request, sources = {}, extraTools = [], history = [], onStep = null, signal = null }) {
    const tools = askTools(sources, extraTools);
    const allowedReadNames = new Set(tools.map(t => t.function.name).filter(name => name !== 'wb_answer'));
    const messages = [
        { role: 'system', content: askSystemPrompt() },
        ...history,
        { role: 'user', content: askUserMessage(question, overview) },
    ];
    const reads = [];
    let sent = messages.reduce((n, m) => n + String(m.content || '').length, 0);
    let lastAssistantText = '';
    for (let round = 0; round < MAX_ROUNDS; round++) {
        if (signal?.aborted) throw new Error(i18n('Stopped'));
        const lastRound = round === MAX_ROUNDS - 1;
        const offered = lastRound ? tools.filter(t => t.function.name === 'wb_answer') : tools;
        let resp;
        try {
            resp = await request(messages, offered);
        } catch (err) {
            if (lastRound && !signal?.aborted && isNoToolCallsError(err)) {
                return {
                    answer: lastAssistantText || i18n('(The AI read a lot without reaching a conclusion — try asking something more specific)'),
                    suggest: '',
                    fixPrompt: '',
                    requestIds: [],
                    reads,
                    sent,
                };
            }
            throw err;
        }
        if (signal?.aborted) throw new Error(i18n('Stopped'));
        const text = String(resp?.text || '');
        if (text.trim()) lastAssistantText = text.trim();
        const calls = Array.isArray(resp?.calls) ? resp.calls : [];
        const answer = calls.find(c => c.name === 'wb_answer');
        const hasOtherCalls = calls.some(c => c.name !== 'wb_answer');
        if (answer && (lastRound || !hasOtherCalls)) {
            return {
                answer: String(answer.args?.text || text || '').trim(),
                suggest: String(answer.args?.suggest || ''),
                fixPrompt: String(answer.args?.fix_prompt || ''),
                requestIds: Array.isArray(answer.args?.request_ids) ? answer.args.request_ids.map(String).filter(Boolean) : [],
                reads,
                sent,
            };
        }
        if (!calls.length) {
            // 模型直接以纯文本作答。
            return { answer: text || i18n('(The AI gave no answer)'), suggest: '', fixPrompt: '', requestIds: [], reads, sent };
        }
        if (lastRound) {
            // 末轮仍未调用 wb_answer，不再执行新读取，优雅降级返回已有文本或超轮数提示。
            return {
                answer: text.trim() || lastAssistantText || i18n('(The AI read a lot without reaching a conclusion — try asking something more specific)'),
                suggest: '',
                fixPrompt: '',
                requestIds: [],
                reads,
                sent,
            };
        }
        // 非末轮若同轮混调 wb_answer 与其他调用，保留原序全部写入 tool_calls（防止删掉首位调用破坏 Gemini 签名位置）；
        // 非混调场景同样按原序保留，不对读取与禁用调用重新排序。
        const executedCalls = answer ? calls : calls.filter(c => c.name !== 'wb_answer');
        if (!executedCalls.length) {
            return { answer: text || i18n('(The AI gave no answer)'), suggest: '', fixPrompt: '', requestIds: [], reads, sent };
        }
        const assistantMsg = {
            role: 'assistant',
            content: text || '',
            ...(typeof resp?.reasoning === 'string' && resp.reasoning.length > 0 ? { reasoning: resp.reasoning } : {}),
            ...(resp?.signature ? { signature: resp.signature } : {}),
            ...(Array.isArray(resp?.reasoningBlocks) && resp.reasoningBlocks.length ? { reasoning_blocks: resp.reasoningBlocks } : {}),
            ...(Array.isArray(resp?.reasoningDetails) && resp.reasoningDetails.length ? { reasoning_details: resp.reasoningDetails } : {}),
            ...(Array.isArray(resp?.nativeParts) && resp.nativeParts.length ? { native_parts: resp.nativeParts } : {}),
            ...(Array.isArray(resp?.nativeContentBlocks) && resp.nativeContentBlocks.length ? { native_content_blocks: resp.nativeContentBlocks } : {}),
            ...(Array.isArray(resp?.responsesOutputItems) && resp.responsesOutputItems.length ? { responses_output_items: resp.responsesOutputItems } : {}),
            tool_calls: executedCalls.map(c => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
                ...(c.signature ? { signature: c.signature } : {}),
                ...(c.extra_content ? { extra_content: c.extra_content } : {}),
            })),
        };
        messages.push(assistantMsg);
        for (const call of executedCalls) {
            if (signal?.aborted) throw new Error(i18n('Stopped'));
            if (call.name === 'wb_answer') {
                const deferredContent = JSON.stringify({
                    deferred: true,
                    note: 'Read tools executed first; now call wb_answer with the findings.',
                });
                sent += deferredContent.length;
                messages.push({ role: 'tool', tool_call_id: call.id, content: deferredContent });
                continue;
            }
            if (!allowedReadNames.has(call.name) || !readers[call.name]) {
                const blockedContent = JSON.stringify({ error: 'Source disabled or unavailable' });
                sent += blockedContent.length;
                messages.push({ role: 'tool', tool_call_id: call.id, content: blockedContent });
                continue;
            }
            let result;
            try { result = await readers[call.name](call.args || {}); } catch (err) { result = { error: String(err?.message || err) }; }
            if (signal?.aborted) throw new Error(i18n('Stopped'));
            const content = clip(result);
            sent += content.length;
            reads.push({ name: call.name, args: call.args || {}, chars: content.length });
            onStep?.({ name: call.name, args: call.args || {} });
            messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
    }
    return { answer: lastAssistantText || i18n('(The AI read a lot without reaching a conclusion — try asking something more specific)'), suggest: '', fixPrompt: '', requestIds: [], reads, sent };
}

const READ_LABEL_KEYS = {
    wb_list_requests: 'Request list',
    wb_read_request: 'Request details',
    wb_read_frontend_logs: 'Frontend logs',
    wb_read_server_logs: 'Server logs',
    wb_read_chat: 'This chat',
    wb_read_character: 'Character card',
    wb_read_world_info: 'World book',
    wb_read_world_info_trace: 'World book trace',
    wb_read_preset: 'Preset',
    wb_read_last_prompt: 'Prompt breakdown',
    wb_read_variables: 'Variables',
    wb_read_regex: 'Regex scripts',
    wb_read_connections: 'Connection profile',
    wb_read_skills: 'Skills',
    wb_read_memory: 'Memory graph',
    wb_read_orch: 'Orchestration',
    wb_read_orchestrator: 'Orchestration',
    wb_read_sd: 'Image Generation',
    wb_read_luker_env: 'Luker environment',
    wb_read_suggestions: 'Suggestions',
    wb_list_luker_docs: 'Luker docs',
    wb_read_luker_doc: 'Luker docs',
};

export function readLabel(name) {
    const key = READ_LABEL_KEYS[name];
    return key ? i18n(key) : String(name ?? '');
}

export function getReadLabels() {
    return Object.fromEntries(Object.entries(READ_LABEL_KEYS).map(([k, v]) => [k, i18n(v)]));
}

/** "Request list · Request details ×3 · Frontend logs" */
export function readsSummary(reads, extraLabels = null) {
    const counts = new Map();
    for (const r of reads || []) counts.set(r.name, (counts.get(r.name) || 0) + 1);
    return [...counts.entries()]
        .map(([name, n]) => `${extraLabels?.[name] || readLabel(name)}${n > 1 ? ` ×${n}` : ''}`)
        .join(' · ');
}
