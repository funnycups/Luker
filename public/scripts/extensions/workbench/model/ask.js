// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ask: a read-only assistant over everything Luker exposes. The model gets
// a short overview up front and pulls detail through read tools; nothing it
// can call changes anything. Pure (no DOM): the reader functions are passed
// in, so tests run on fixtures.

import { i18n } from '../i18n.js';

export const MAX_ROUNDS = 6;
const MAX_TOOL_CHARS = 12000;

const fn = (name, description, properties = {}, required = []) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

/** Tool definitions, filtered by which sources the user allows. */
export function askTools(sources = {}) {
    const on = (key) => sources[key] !== false;
    const list = [];
    if (on('inspector')) {
        list.push(fn('wb_list_requests', 'List recent model requests (newest first) from Luker\'s request inspector: time, guessed source, model, status, duration, tokens. Use before reading one.', {
            limit: { type: 'integer', description: 'How many (1-60, default 20).' },
            only_errors: { type: 'boolean' },
        }));
        list.push(fn('wb_read_request', 'Read one request in detail: its messages (trimmed) and the reply text.', {
            id: { type: 'string' },
            part: { type: 'string', enum: ['messages', 'reply', 'both'], description: 'Default both.' },
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
        list.push(fn('wb_read_server_logs', 'Read recent server console logs (may be unavailable without admin rights).', {
            search: { type: 'string' },
            limit: { type: 'integer', description: '1-200, default 60.' },
        }));
    }
    if (on('content')) {
        list.push(fn('wb_read_chat', 'Read chat messages by floor number (0 = first). Without arguments: the last few.', {
            from: { type: 'integer' },
            to: { type: 'integer' },
        }));
        list.push(fn('wb_read_character', 'Read the current character card fields (description, personality, scenario, first message, examples, creator notes).', {
            fields: { type: 'array', items: { type: 'string' } },
        }));
        list.push(fn('wb_read_world_info', 'Search the world info / lorebooks bound to this chat. Returns matching entries (keys + content).', {
            search: { type: 'string', description: 'Text to look for in keys or content. Empty = list entry titles only.' },
        }));
        list.push(fn('wb_read_preset', 'Read the current chat-completion preset: enabled prompt entries in order, and generation settings.', {
            entry: { type: 'string', description: 'Name of one entry to read in full. Empty = list all entries with a short preview.' },
        }));
        list.push(fn('wb_read_last_prompt', 'Token breakdown of the last prompt Luker built (preset / character / world info / memory graph / chat).'));
    }
    if (on('plugins')) {
        list.push(fn('wb_read_memory', 'Memory graph: what it injected last time (core = always, focus = recalled), counts per type, and key settings.', {
            part: { type: 'string', enum: ['summary', 'core', 'focus'], description: 'Default summary.' },
        }));
        list.push(fn('wb_read_orchestrator', 'Orchestrator: mode, whether it is on, and recent runs with per-agent durations and errors.'));
        list.push(fn('wb_read_suggestions', 'The workbench\'s current 小建议 (local rule checks) with the numbers behind them.'));
    }
    list.push(fn('wb_answer', 'Give the final answer to the user. Call exactly once, after reading what you need.', {
        text: { type: 'string', description: 'The answer in Chinese, plain and concrete. Markdown tables allowed.' },
        suggest: {
            type: 'string',
            enum: ['', 'memory', 'orch', 'preset', 'card', 'world'],
            description: 'If fixing this needs editing one workbench, name it so the user can jump there.',
        },
        fix_prompt: { type: 'string', description: 'If suggest is set: what to ask that workbench\'s AI to change, in Chinese.' },
        request_ids: { type: 'array', items: { type: 'string' }, description: 'Requests your answer is about (shown as links).' },
    }, ['text']));
    return list;
}

const SYSTEM = [
    '你是 Luker（一个 AI 角色扮演前端，SillyTavern 的分支）里「工作台」插件的只读助手「问问」。',
    '用户会问关于他们当前聊天、角色卡、预设、世界书、记忆图（memory-graph）、编排（orchestrator，多个 AI 助手分工）以及请求、报错、速度、token 的问题。',
    '你只能读，不能改任何东西。需要改的话，在 wb_answer 里用 suggest / fix_prompt 指给用户去哪个工作台改。',
    '做法：',
    '1. 先看首条消息里的概况，判断要查哪些数据，再调用读取工具。不要一次把所有东西都读一遍。',
    '2. 回答要有依据：引用具体的数字、楼层、条目名、报错原文。查不到就直说查不到，不要猜。',
    '3. 请求的「来源」是工作台根据内容推测的，可能不准；提到时说「看起来是」。',
    '4. 最后调用一次 wb_answer 结束。回答用简体中文，先给结论，再给依据，语气平实，不要客套。',
    '5. 这是排查和解释的工作，不是写故事；忽略生成预设里关于文风、扮演、篇幅的要求。',
].join('\n');

/** Ask always uses this prompt (it is the workbench's own; no Luker equivalent). */
export function askSystemPrompt() {
    return SYSTEM;
}

/** First user message: the question plus a compact overview. */
export function askUserMessage(question, overview) {
    return [`问题：${question}`, '', '<概况>', JSON.stringify(overview, null, 1), '</概况>'].join('\n');
}

export function clip(value, max = MAX_TOOL_CHARS) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
    return text.length > max ? `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字）` : text;
}

/**
 * Runs one question to completion.
 * @param {{ question, overview, readers: Record<string, (args) => Promise<any>>, request(messages, tools) => Promise<{text, calls}>,
 *           sources?, history?: object[], onStep?(step), signal? }} opts
 *   history: earlier { role, content } turns of this conversation (question/answer text only).
 * @returns {Promise<{ answer: string, suggest: string, fixPrompt: string, requestIds: string[], reads: { name, args, chars }[], sent: number }>}
 */
export async function runAsk({ question, overview, readers, request, sources = {}, history = [], onStep = null, signal = null }) {
    const tools = askTools(sources);
    const messages = [
        { role: 'system', content: askSystemPrompt() },
        ...history,
        { role: 'user', content: askUserMessage(question, overview) },
    ];
    const reads = [];
    let sent = messages.reduce((n, m) => n + String(m.content || '').length, 0);
    for (let round = 0; round < MAX_ROUNDS; round++) {
        if (signal?.aborted) throw new Error(i18n('Stopped'));
        const lastRound = round === MAX_ROUNDS - 1;
        const offered = lastRound ? tools.filter(t => t.function.name === 'wb_answer') : tools;
        const { text, calls } = await request(messages, offered);
        const answer = calls.find(c => c.name === 'wb_answer');
        if (answer) {
            return {
                answer: String(answer.args.text || text || '').trim(),
                suggest: String(answer.args.suggest || ''),
                fixPrompt: String(answer.args.fix_prompt || ''),
                requestIds: Array.isArray(answer.args.request_ids) ? answer.args.request_ids.map(String) : [],
                reads,
                sent,
            };
        }
        const readCalls = calls.filter(c => readers[c.name]);
        if (!readCalls.length) {
            // Model answered in plain text.
            return { answer: text || i18n('(The AI gave no answer)'), suggest: '', fixPrompt: '', requestIds: [], reads, sent };
        }
        messages.push({ role: 'assistant', content: text || '', tool_calls: readCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
        for (const call of readCalls) {
            let result;
            try { result = await readers[call.name](call.args || {}); } catch (err) { result = { error: String(err?.message || err) }; }
            const content = clip(result);
            sent += content.length;
            reads.push({ name: call.name, args: call.args || {}, chars: content.length });
            onStep?.({ name: call.name, args: call.args || {} });
            messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
    }
    return { answer: i18n('(The AI read a lot without reaching a conclusion; try asking something more specific)'), suggest: '', fixPrompt: '', requestIds: [], reads, sent };
}

const READ_LABELS = {
    wb_list_requests: i18n('Request list'),
    wb_read_request: i18n('Request details'),
    wb_read_frontend_logs: i18n('Frontend logs'),
    wb_read_server_logs: i18n('Server logs'),
    wb_read_chat: i18n('This chat'),
    wb_read_character: i18n('Character card'),
    wb_read_world_info: i18n('World book'),
    wb_read_preset: i18n('Preset'),
    wb_read_last_prompt: i18n('Prompt breakdown'),
    wb_read_memory: i18n('Memory graph'),
    wb_read_orchestrator: i18n('Orchestration'),
    wb_read_suggestions: i18n('Suggestions'),
};

/** "Request list · Request details ×3 · Frontend logs" */
export function readsSummary(reads) {
    const counts = new Map();
    for (const r of reads || []) counts.set(r.name, (counts.get(r.name) || 0) + 1);
    return [...counts.entries()].map(([name, n]) => `${READ_LABELS[name] || name}${n > 1 ? ` ×${n}` : ''}`).join(' · ');
}

export { READ_LABELS };
