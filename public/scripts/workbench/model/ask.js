// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ask: Luker 原生工作台的只读诊断与产品助手。模型先读取一份紧凑概况，
// 再按需通过只读工具拉取细节或查阅内置 Luker 功能文档；所有工具都不会修改任何数据。
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
    const anySourceOn = on('inspector') || on('frontLogs') || on('serverLogs') || on('content') || on('plugins');
    const list = [];
    if (on('inspector')) {
        list.push(fn('wb_list_requests', 'List recent model/image/embedding requests (newest first) from Luker\'s request inspector: id, time, guessed source, model, status, duration, tokens. Call before wb_read_request.', {
            limit: { type: 'integer', description: 'How many (1-60, default 20).' },
            only_errors: { type: 'boolean', description: 'Only return failed requests.' },
        }));
        list.push(fn('wb_read_request', 'Read one request in detail: status, error, usage, messages, reply, optional reasoning and tools. For large main-chat prompts, pass tail_messages (e.g. 6) or message_index to inspect specific messages without truncation.', {
            id: { type: 'string', description: 'Request id from overview or wb_list_requests.' },
            part: { type: 'string', enum: ['messages', 'reply', 'both'], description: 'Default both.' },
            tail_messages: { type: 'integer', description: 'Only return the last N messages (plus system overview) so recent context is not clipped.' },
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
        list.push(fn('wb_read_regex', 'Read regex scripts active in Luker (global, character-scoped, preset-scoped, and plugin-registered regex providers) to diagnose swallowed text, broken formatting, or status bar issues.', {
            scope: { type: 'string', enum: ['all', 'global', 'character', 'preset', 'plugin'], description: 'Default all.' },
            search: { type: 'string', description: 'Filter by script name or regex pattern.' },
            only_enabled: { type: 'boolean', description: 'Default true.' },
        }));
    }
    if (on('plugins')) {
        for (const extra of Array.isArray(extraPluginTools) ? extraPluginTools : []) {
            const tool = normalizeProviderTool(extra);
            if (tool) list.push(tool);
        }
        list.push(fn('wb_read_luker_env', 'Read redacted Luker runtime environment & feature states: connection profiles list, installed/enabled extensions, Hook Order, Search Tools config, Skills inventory, and Sync status.', {
            part: {
                type: 'string',
                enum: ['summary', 'connections', 'extensions', 'search_tools', 'skills', 'sync'],
                description: 'Section to inspect. Default summary.',
            },
        }));
        list.push(fn('wb_read_suggestions', 'The workbench\'s current local rule-check suggestions with the numbers behind them.'));
    }
    if (anySourceOn && sources?.docs !== false) {
        list.push(fn('wb_search_luker_docs', 'Search Luker\'s built-in feature documentation index (entry points, scopes, mechanisms, and troubleshooting guides). Call this whenever the user asks how a Luker feature works or where a setting lives.', {
            query: { type: 'string', description: 'Keywords or feature name (Chinese or English). Empty = list all documented Luker topics.' },
            category: { type: 'string', description: 'Optional category filter.' },
            limit: { type: 'integer', description: 'Max topics to return (1-10, default 5).' },
        }));
    }
    list.push(fn('wb_answer', 'Give the final answer to the user. Call exactly once, after reading what you need (never in the same turn as read tools).', {
        text: { type: 'string', description: 'The answer in Simplified Chinese, plain and concrete. Markdown tables allowed.' },
        suggest: {
            type: 'string',
            enum: ['', 'memory_graph', 'memory', 'orch', 'sd', 'preset', 'card', 'world'],
            description: 'If fixing this needs editing one workbench target, name it so the user gets a jump button: memory_graph = edit current chat memory nodes/relations (requires an open chat); memory = edit memory structure/schema and extraction/injection settings; orch = orchestration; sd = image generation; preset = preset; card = character card; world = world book.',
        },
        fix_prompt: { type: 'string', description: 'If suggest is set: a concrete Chinese instruction for that workbench\'s AI.' },
        request_ids: { type: 'array', items: { type: 'string' }, description: 'Request IDs your answer references (rendered as clickable inspector links).' },
    }, ['text']));
    return list;
}

const SYSTEM = [
    '你是 Luker 原生「工作台」里的只读诊断与产品助手「问问」。',
    '',
    '【Luker 核心架构速查（切勿套用旧版 SillyTavern 经验瞎猜）】',
    '- Luker 是基于 SillyTavern 深度重构的平台，内置多项独有机制：',
    '  1. 工作台（Alt+W / 魔杖菜单 / 右下角胶囊）：统一集成总览、问问、AI 迭代（memory_graph 改当前聊天记忆节点与关系，memory 改记忆结构与提取/注入配置，另有 orch/sd/preset/card/world）、改动记录，以及嵌入的记忆图、编排、图像生成面板。',
    '  2. 预设解耦与绑定：Chat Completion 预设与 API 连接配置分离，切预设不改连接；角色卡可绑定推荐预设与人设；预设可关联世界书。',
    '  3. 世界书与激活追踪：支持全局/角色主辅书/聊天书/预设世界书，Luker 记录每次扫描的激活链路追踪（命中词、扫描深度、未激活原因）。',
    '  4. 逐楼层变量（Variable Op Log）：AI 回复里的 {{setvar}}/{{addvar}}/{{incvar}}/{{decvar}}/{{pushvar}}/{{popvar}}/{{deletevar}} 会被自动提取到 extra.var_ops 并从正文隐藏，删除或切 swipe 会自动重放；世界书/预设里的 {{setvar}} 每轮组装提示词时都会覆盖同名变量。',
    '  5. 正则作用域：分为全局正则、角色局部正则、预设正则与插件注册正则（区分主聊天与插件通道，并分「仅格式显示」与「仅格式提示词」）。',
    '  6. 记忆图（Memory Graph）：分 core（常驻注入，受回溯楼层上限与自动压缩影响）和 focus（按需召回）；记忆结构与高级设置支持全局或角色卡覆盖。',
    '  7. 多 Agent 编排（Orchestrator）：含 Spec（流水线）、Single（单助手）、Agenda（调度）、Loop（循环）、Director（导演接管写作，主模型不参与）五种模式，另有剧情笔记（Notes）与按需读取的知识包 Skills（global/preset/orch-preset/character 四级作用域）。',
    '  8. 图像生成与 AI 插图（SD）：统一多生图后端、ComfyUI 工作流、全局角色库与交互式画室。',
    '  9. 其他原生能力：请求检查器（最近 200 条完整记录）、联网搜索（Search Tools）、CardApp、钩子执行排序（Hook Order）、局域网/加密 S3 同步、后端实时存储与存储审查。',
    '',
    '【按场景选择工具的排查路径】',
    '- 问「为什么这样写 / 角色忘事 / OOC / 上下文不对」：先看概况，按需查 wb_read_chat（可用 search 搜关键词定位楼层）、wb_read_memory（可用 search 搜记忆节点，或看 core/focus）、wb_read_world_info_trace、wb_read_last_prompt、wb_read_preset；要核对实际发给模型的正文时用 wb_read_request（建议传 tail_messages 看末尾消息与 reply）。',
    '- 问「世界书条目为什么没触发或误触发」：优先调 wb_read_world_info_trace 看真实扫描结果，再结合 wb_read_world_info 检查关键词、启用状态、位置和深度。',
    '- 问「状态栏乱了 / 正文被吞字 / 变量数值不对」：优先调 wb_read_variables（看当前变量值与各楼层 var_ops）和 wb_read_regex（看启用的全局/角色/预设/插件正则）。',
    '- 问「为什么报错 / 很慢 / 卡住 / 没响应」：先看概况里的近期请求，再查 wb_list_requests(only_errors=true)、wb_read_request、wb_read_frontend_logs(level="warn")、wb_read_server_logs；若涉及多助手或生图，查 wb_read_orch(part="last_run") 或 wb_read_sd(part="last_run")。',
    '- 问「token 怎么这么高」：查 wb_read_last_prompt、wb_read_memory(part="summary" 或 "core")、wb_read_world_info_trace、wb_read_preset。',
    '- 问「Luker 某个功能怎么用 / 在哪设置 / 某选项干嘛的」：先调 wb_search_luker_docs 查内置功能手册；如果同时要核对用户当前配置，再调 wb_read_luker_env。',
    '- 问「帮我写个 bug 报告」：汇总 wb_read_luker_env(part="summary")、报错请求摘要与前后端关键日志，给出结构化、脱敏后的问题报告。',
    '',
    '【工作纪律】',
    '1. 你严格只读，不能直接修改任何配置；如果需要修改，在 wb_answer 里通过 suggest 与 fix_prompt 指引用户跳转到对应 AI 迭代工作台，并在 request_ids 填入你引用的请求 ID。注意区分 memory_graph（修改当前聊天的记忆节点与关系，仅在有打开聊天时可用，无聊天时勿建议）与 memory（修改记忆结构/类型及提取注入配置）。',
    '2. 先看当前用户消息里的 <概况> 再按需调用工具；仅调用当前 tools 列表中实际提供的工具（缺某工具即说明该数据源已被关闭或对应插件未启用，不要强行调用未提供的工具）。同一轮可以并行调用多个必要读取工具，不要一次把所有无关工具都读一遍；调用读取工具的同一轮不要同时调用 wb_answer，等工具返回后再调用 wb_answer 汇总结论。',
    '3. 结论必须有实证：引用具体的数字、楼层号、条目名、变量名、正则名、报错原文或请求 ID。某类数据源被关闭或查不到时直接说查不到（必要时告知可在设置里开启哪个数据源或调试日志），严禁脑补猜测。',
    '4. 请求列表里的「来源」带有「（推测）」字样时说明是工作台基于内容规则推测的，提到时说「看起来是」。',
    '5. 查清后调用一次 wb_answer 结束。用简体中文回答，先给结论，再列依据与建议，平实直白不客套；这是排查与咨询任务，严禁角色扮演。',
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
    const lastRoundHint = '已达到工具读取轮数上限，不要再调用读取工具。请直接调用一次 wb_answer 汇总已有发现并给出最终回答。';
    for (let round = 0; round < MAX_ROUNDS; round++) {
        if (signal?.aborted) throw new Error(i18n('Stopped'));
        const lastRound = round === MAX_ROUNDS - 1;
        const offered = lastRound ? tools.filter(t => t.function.name === 'wb_answer') : tools;
        const requestMessages = lastRound
            ? [...messages, { role: 'user', content: lastRoundHint }]
            : messages;
        if (lastRound) sent += lastRoundHint.length;
        let resp;
        try {
            resp = await request(requestMessages, offered);
        } catch (err) {
            if (lastRound && !signal?.aborted && err?.name !== 'AbortError') {
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
            tool_calls: executedCalls.map(c => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
                ...(c.signature ? { signature: c.signature } : {}),
                ...(c.extra_content ? { extra_content: c.extra_content } : {}),
            })),
        };
        if (typeof resp?.reasoning === 'string' && resp.reasoning.length > 0) {
            assistantMsg.reasoning = resp.reasoning;
        }
        if (Array.isArray(resp?.reasoningBlocks) && resp.reasoningBlocks.length) {
            assistantMsg.reasoning_blocks = resp.reasoningBlocks;
        }
        if (Array.isArray(resp?.reasoningDetails) && resp.reasoningDetails.length) {
            assistantMsg.reasoning_details = resp.reasoningDetails;
        }
        messages.push(assistantMsg);
        for (const call of executedCalls) {
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
    wb_read_memory: 'Memory graph',
    wb_read_orch: 'Orchestration',
    wb_read_orchestrator: 'Orchestration',
    wb_read_sd: 'Image Generation',
    wb_read_luker_env: 'Luker environment',
    wb_read_suggestions: 'Suggestions',
    wb_search_luker_docs: 'Luker docs',
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
