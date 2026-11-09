// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Request-inspector entries → who probably sent them. The inspector only
// records the API kind (openai / claude …), so the caller is guessed from the
// messages' content. Every guess is labelled "guess" in the UI. Pure.

const RULES = [
    // memory-graph
    { kind: 'memory', label: '记忆图 · 召回规划', test: /memory recall planner|recall_query_context|candidate_nodes/i },
    { kind: 'memory', label: '记忆图 · 提取', test: /dialogue_batch|memory (graph )?extract|extract(ion)? (batch|schema)|mg_upsert|luker_rpg_memory/i },
    { kind: 'memory', label: '记忆图 · 压缩', test: /rollup|summarize the (following|child)|compress(ion)? (rule|instruction)/i },
    // orchestrator / search
    { kind: 'orch', label: '编排', test: /luker_orch|orchestrat|agenda_planner|\bdirector\b.*\bdispatch/i },
    { kind: 'search', label: '联网搜索', test: /search_tools|web_search|search agent/i },
    // iteration studios (native and ours)
    { kind: 'iterate', label: 'AI 迭代 · 记忆结构', test: /mg_schema_|schema iteration/i },
    { kind: 'iterate', label: 'AI 迭代 · 预设', test: /cpa_|completion preset assistant/i },
    { kind: 'iterate', label: 'AI 迭代 · 角色卡', test: /cea_|character editor assistant/i },
    { kind: 'workbench', label: '工作台', test: /wb_(read|ask|ok)|工作台/ },
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
 * @param {{ mainReplyIds?: Set<string> }} hints ids known to be the main reply
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
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer ***')
        .replace(/\b(api[_-]?key|token|secret|password|authorization)(["'\\\s:=]+)([^"'\\\s,;}{]{6,})/gi, '$1$2***')
        .replace(/https?:\/\/[^\s"'\\<>]+/gi, (url) => {
            try { const u = new URL(url); return `${u.protocol}//${u.hostname.replace(/^[^.]+(?=\.[^.]+\.)/, '*')}/…`; } catch { return '[地址]'; }
        });
}

const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|token|secret|password|authorization)$/i;

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

/** Applies the Ask settings to an overview before anything can read it. */
export function finishOverview(overview, { inspector = true, redactText = true } = {}) {
    const out = { ...overview };
    if (!inspector) delete out.最近的请求;
    return redactText ? redactValue(out) : out;
}
