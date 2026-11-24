// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Request-inspector entries -> who probably sent them, secret redaction, and
// overview privacy gating. Pure.

const RULES = [
    // memory-graph
    { kind: 'memory', label: '记忆图 · 召回规划', test: /memory recall planner|recall_query_context|candidate_nodes/i },
    { kind: 'memory', label: '记忆图 · 提取', test: /dialogue_batch|memory (graph )?extract|extract(ion)? (batch|schema)|mg_upsert|luker_rpg_memory/i },
    { kind: 'memory', label: '记忆图 · 压缩', test: /rollup|summarize the (following|child)|compress(ion)? (rule|instruction)/i },
    // orchestrator / search / sd illustration
    { kind: 'orch', label: '编排', test: /luker_orch|orchestrat|agenda_planner|\bdirector\b.*\bdispatch/i },
    { kind: 'search', label: '联网搜索', test: /search_tools|luker_web_search|luker_search_agent|web_search|search agent/i },
    { kind: 'image', label: 'AI 插图 / 画室', test: /sd_read_run|sd_propose_|illustration_prompt|character_exploration|visualInspection/i },
    // iteration studios
    { kind: 'iterate', label: 'AI 迭代 · 记忆结构', test: /mg_schema_|schema iteration/i },
    { kind: 'iterate', label: 'AI 迭代 · 预设', test: /cpa_|completion preset assistant/i },
    { kind: 'iterate', label: 'AI 迭代 · 角色卡', test: /cea_|character editor assistant/i },
    { kind: 'iterate', label: 'AI 迭代 · 世界书', test: /lorebook_write|wb_world_|worldbook assistant/i },
    { kind: 'workbench', label: '工作台', test: /wb_(read|list|search|answer|ask|ok)|工作台/ },
];

function textOf(messages) {
    let out = '';
    for (const m of Array.isArray(messages) ? messages : []) {
        if (m?.role !== 'system' && out.length > 4000) break;
        const c = m?.content;
        if (typeof c === 'string') out += `\n${c.slice(0, 6000)}`;
        else if (Array.isArray(c)) out += `\n${c.map(p => (typeof p === 'string' ? p : p?.text || '')).join(' ').slice(0, 6000)}`;
    }
    return out;
}

/**
 * @param {object} entry inspector list item or detail (searchText / fullMessages)
 * @param {{ mainReplyIds?: Set<string> }} [hints] ids known to be the main reply
 * @returns {{ kind: string, label: string, guessed: boolean }}
 */
export function attribute(entry, { mainReplyIds = null } = {}) {
    if (mainReplyIds?.has(entry?.id)) return { kind: 'main', label: '主模型回复', guessed: false };
    if (entry?.type === 'image') return { kind: 'image', label: '生图', guessed: false };
    if (entry?.type === 'embedding') return { kind: 'embedding', label: '向量检索', guessed: false };
    const text = `${entry?.searchText || ''}\n${textOf(entry?.fullMessages)}`;
    for (const r of RULES) if (r.test.test(text)) return { kind: r.kind, label: r.label, guessed: true };
    // Plain chat requests with many messages are almost always the main reply.
    if ((entry?.messageCount || 0) >= 6) return { kind: 'main', label: '主模型回复', guessed: true };
    return { kind: 'other', label: '其他', guessed: true };
}

/**
 * Groups requests that belong to one generation: everything within `gapMs`
 * of each other, newest group first.
 */
export function groupByGeneration(entries, gapMs = 90e3) {
    const sorted = [...(entries || [])].sort((a, b) => a.timestamp - b.timestamp);
    const groups = [];
    let cur = null;
    for (const e of sorted) {
        const end = (cur?.end ?? 0);
        if (!cur || e.timestamp - end > gapMs) {
            cur = { start: e.timestamp, end: e.timestamp + (e.durationMs || 0), items: [] };
            groups.push(cur);
        }
        cur.items.push(e);
        cur.end = Math.max(cur.end, e.timestamp + (e.durationMs || 0));
    }
    return groups.reverse();
}

/** Short, key-free view of one request for the AI. */
export function describeRequest(e, attr = attribute(e)) {
    return {
        id: e.id,
        source: attr.label + (attr.guessed ? '（推测）' : ''),
        time: new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false }),
        model: e.model || '',
        status: e.status === 'error' || e.error ? `失败${e.httpStatus ? ` ${e.httpStatus}` : ''}` : e.status === 'running' ? '进行中' : '完成',
        error: e.error ? String(e.error).slice(0, 400) : '',
        durationMs: e.durationMs ?? null,
        tokens: e.usage ? { prompt: e.usage.prompt_tokens ?? null, completion: e.usage.completion_tokens ?? null } : null,
        messages: e.messageCount ?? null,
        finish: e.finishReason || '',
    };
}

/** Removes things that look like secrets before text goes to the model. */
export function redact(text) {
    return String(text ?? '')
        .replace(/\b(sk|pk|rk|ak)-[A-Za-z0-9_-]{12,}\b/g, '$1-***')
        .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, 'AIza***')
        .replace(/\bhf_[A-Za-z0-9]{10,}\b/g, 'hf_***')
        .replace(/\bghp_[A-Za-z0-9]{10,}\b/g, 'ghp_***')
        .replace(/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, 'github_pat_***')
        .replace(/\bgsk_[A-Za-z0-9]{10,}\b/g, 'gsk_***')
        .replace(/\bxai-[A-Za-z0-9-]{10,}\b/g, 'xai-***')
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer ***')
        .replace(/\b(authorization(?:\s*(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?|\s+))Basic\s+[^\s"'\\,;}{]+/gi, '$1Basic ***')
        .replace(/\bBasic\s+(?:[A-Za-z0-9+/]{8,}={0,2}|[A-Za-z0-9+/=]*[=0-9+/][A-Za-z0-9+/=]*)/g, 'Basic ***')
        .replace(/\b([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|authorization|cookie))((?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)(?!(?:Bearer|Basic)\s+\*\*\*)([^"'\\\s,;}{]{4,})/gi, '$1$2***')
        .replace(/\b(?:https?|wss?):\/\/[^\s"'\\<>]+/gi, (url) => {
            try {
                const u = new URL(url);
                return `${u.protocol}//${u.hostname.replace(/^[^.]+(?=\.[^.]+\.)/, '*')}/…`;
            } catch {
                return '[地址]';
            }
        });
}

const SECRET_KEY = /(?:^|[_-]|[a-z])(?:api[_-]?key|token|secret|password|authorization|cookie)$/i;

function parseJsonText(text) {
    if (!/^\s*[[{]/.test(text)) return null;
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

/**
 * `redact` applied value by value, so the result keeps its shape. A string
 * that is itself JSON is cleaned as data and stays valid JSON.
 */
export function redactValue(value) {
    if (typeof value === 'string') {
        const nested = parseJsonText(value);
        return nested ? JSON.stringify(redactValue(nested)) : redact(value);
    }
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'string' && v && SECRET_KEY.test(k) ? '***' : redactValue(v)]));
    }
    return value;
}

/** Wraps every reader so what it hands the model passes through the same redaction. */
export function redactReaders(readers, enabled) {
    if (!enabled) return readers;
    return Object.fromEntries(Object.entries(readers).map(([name, read]) => [name, async (args) => {
        const value = await read(args);
        return value === undefined ? value : redactValue(JSON.parse(JSON.stringify(value)));
    }]));
}

const CONTENT_OVERVIEW_KEYS = ['聊天', '角色卡', '预设', '连接', '提示词', '世界书', '变量', '正则', 'chat', 'character', 'preset', 'connection', 'promptBudget', 'worldBooks', 'variables', 'regex'];
const INSPECTOR_OVERVIEW_KEYS = ['最近的请求', 'requests'];
const FRONT_LOGS_OVERVIEW_KEYS = ['调试日志开关', 'frontendLogs', 'debugLogging'];
const PLUGIN_OVERVIEW_KEYS = ['记忆图', '编排', '图像生成', '扩展', '环境', 'extensions', 'plugins', 'environment'];

/** Applies the Ask settings (sources + redaction) to an overview before sending. */
export function finishOverview(overview, {
    sources = null,
    inspector,
    frontLogs,
    content,
    plugins,
    pluginKeys = [],
    redactText = true,
} = {}) {
    const out = overview && typeof overview === 'object' ? { ...overview } : {};
    const src = sources && typeof sources === 'object' ? sources : {};
    const allow = (key, explicit) => (explicit !== undefined ? explicit !== false : src[key] !== false);

    if (!allow('inspector', inspector)) {
        for (const k of INSPECTOR_OVERVIEW_KEYS) delete out[k];
    }
    if (!allow('frontLogs', frontLogs)) {
        for (const k of FRONT_LOGS_OVERVIEW_KEYS) delete out[k];
    }
    if (!allow('content', content)) {
        for (const k of CONTENT_OVERVIEW_KEYS) delete out[k];
    }
    if (!allow('plugins', plugins)) {
        for (const k of [...PLUGIN_OVERVIEW_KEYS, ...(Array.isArray(pluginKeys) ? pluginKeys : [])]) {
            delete out[k];
        }
    }
    return redactText ? redactValue(out) : out;
}
