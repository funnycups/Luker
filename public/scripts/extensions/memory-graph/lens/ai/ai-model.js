// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers for the AI schema assistant (no DOM, no Luker imports).
// The conversation shape mirrors memory-graph's own schema studio so the
// tool-call history replays the same way: assistant messages carry
// `toolCalls` [{id,name,args}] and `toolResults` [{tool_call_id,content,status}].

import { i18n, i18nFormat, listSeparator } from '../i18n.js';

const READ_TOOLS = new Set(['mg_schema_read_fields']);
const EDIT_TEXT = {
    mg_schema_set_node_type: i18n('Edit type'),
    mg_schema_remove_node_type: i18n('Delete a type'),
    mg_schema_reorder_node_types: i18n('Reorder types'),
    mg_schema_read_fields: i18n('Read the current structure'),
};

export const MAX_ROUNDS = 8;
export const MAX_SESSIONS = 12;

export const makeId = (prefix = 'ml') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function isEditTool(name) {
    return String(name || '').startsWith('mg_schema_') && !READ_TOOLS.has(String(name));
}

/** Short label for a tool call, e.g. 'Edit type "Item"'. */
export function toolCallText(call) {
    const name = String(call?.name || '');
    const base = EDIT_TEXT[name] || (name.startsWith('world_') || name.includes('lorebook') ? i18n('Look up the lorebook') : i18n('Look up references'));
    const args = call?.args || {};
    const target = args.label || args.id || args.node_type || args.node_type?.label || args.node_type?.id || args.nodeType?.label || args.nodeType?.id || args.value?.label || args.value?.id || '';
    return target ? i18nFormat('${0} "${1}"', base, target) : base;
}

/** Messages the LLM sees: system prompt + replayable user/assistant turns. */
export function buildTaskMessages(systemPrompt, messages) {
    const out = [{ role: 'system', content: systemPrompt }];
    for (const m of messages || []) {
        const role = String(m?.role || '').toLowerCase();
        if (role !== 'user' && role !== 'assistant') continue;
        const content = String(m.content || '');
        const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        if (role === 'assistant' && calls.length) {
            const assistant = {
                role: 'assistant',
                content,
                tool_calls: calls.map(tc => ({
                    id: String(tc.id || ''),
                    type: 'function',
                    function: { name: String(tc.name || ''), arguments: JSON.stringify(tc.args || {}) },
                })),
            };
            if (m.reasoning) assistant.reasoning = m.reasoning;
            if (Array.isArray(m.reasoningBlocks) && m.reasoningBlocks.length) assistant.reasoning_blocks = m.reasoningBlocks;
            if (Array.isArray(m.reasoningDetails) && m.reasoningDetails.length) assistant.reasoning_details = m.reasoningDetails;
            out.push(assistant);
            const results = new Map((m.toolResults || []).map(r => [String(r.tool_call_id), r]));
            for (const tc of calls) {
                const r = results.get(String(tc.id));
                let serialized = '';
                try {
                    serialized = typeof r?.content === 'string' ? r.content : JSON.stringify(r?.content ?? { status: 'committed' });
                } catch { serialized = ''; }
                out.push({ role: 'tool', tool_call_id: String(tc.id || ''), content: serialized });
            }
            continue;
        }
        out.push({ role, content });
    }
    return out;
}

/**
 * Runs one user turn: keeps calling `round()` while the AI emits tool calls.
 * @param {(args: { messages: object[], live: object[], signal?: AbortSignal }) => Promise<{
 *   assistantText: string, reasoning?: string, reasoningBlocks?: any[], reasoningDetails?: any[],
 *   calls: { id: string, name: string, args: object, result: any, ok: boolean }[], live: object[] }>} round
 * @param {{ messages: object[] }} session mutated: assistant messages appended
 * @returns {Promise<{ live: object[], changed: boolean, rounds: number }>}
 */
export async function runTurn(round, session, { live, signal = null, onUpdate = null, maxRounds = MAX_ROUNDS } = {}) {
    const start = JSON.stringify(live);
    let current = live;
    let rounds = 0;
    while (rounds < maxRounds) {
        if (signal?.aborted) throw abortError();
        rounds++;
        const out = await round({ messages: session.messages, live: current, signal });
        const message = { id: makeId('msg'), role: 'assistant', content: String(out.assistantText || '').trim(), at: Date.now() };
        if (out.reasoning) message.reasoning = out.reasoning;
        if (out.reasoningBlocks?.length) message.reasoningBlocks = out.reasoningBlocks;
        if (out.reasoningDetails?.length) message.reasoningDetails = out.reasoningDetails;
        if (out.calls?.length) {
            message.toolCalls = out.calls.map(c => ({ id: c.id, name: c.name, args: c.args || {} }));
            message.toolResults = out.calls.map(c => ({ tool_call_id: c.id, content: c.result, status: c.ok ? 'ok' : 'fail' }));
        }
        session.messages.push(message);
        session.at = Date.now();
        current = Array.isArray(out.live) ? out.live : current;
        onUpdate?.(current, message);
        if (!out.calls?.length) break;
    }
    return { live: current, changed: JSON.stringify(current) !== start, rounds };
}

export function abortError() {
    const err = new Error('aborted');
    err.name = 'AbortError';
    return err;
}

export function newSession() {
    return { id: makeId('sess'), title: '', at: Date.now(), messages: [] };
}

export function sessionTitle(text) {
    const line = String(text || '').trim().split('\n')[0];
    return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

/** Keeps the newest sessions, drops empty ones, caps the list. */
export function upsertSession(list, session) {
    const rest = (list || []).filter(s => s.id !== session.id);
    const next = session.messages.length ? [session, ...rest] : rest;
    return next.sort((a, b) => b.at - a.at).slice(0, MAX_SESSIONS);
}

/** Marks the edit tool results of the given message ids as rolled back. */
export function markRolledBack(messages, ids, payload) {
    const set = new Set(ids);
    for (const m of messages) {
        if (!set.has(m.id) || !Array.isArray(m.toolResults)) continue;
        const editIds = new Set((m.toolCalls || []).filter(c => isEditTool(c.name)).map(c => String(c.id)));
        for (const r of m.toolResults) {
            if (editIds.has(String(r.tool_call_id)) && r.status === 'ok') r.content = payload;
        }
        if (payload?.status === 'rolled_back' || payload?.status === 'rejected') m.rolledBack = true;
    }
}

// ----- Prompts for the structure tools (AI polish / improve this type) -----
//
// Two layers:
// - TASK: the bare minimum the tool needs to work (what to return, keep
//   column keys). Always sent.
// - BUILTIN: our optimisation guide — how memory-graph uses each part of a
//   type, what good hints look like, which switches suit what. Sent when
//   the built-in optimization prompt option is ticked (default on).
// The user's generation preset (e.g. a jailbreak preset) wraps both; we don't
// touch it. The guide therefore tells the model to ignore prose-style
// instructions from the preset for this task.

const BUILTIN_GUIDE = [
    i18n('[Nature of the task] This is a tool task for organizing the "memory structure", not storytelling. Preset requirements about style, narration, pacing or roleplay do not apply here; follow only the rules below.'),
    '',
    i18n('[How the memory system uses this] Facts from a roleplay chat are recorded as typed entries by an "extraction AI", and relevant entries are later recalled for the chat model.'),
    i18n('- Type description (extractHint): the extraction AI uses it to decide which facts belong to this type and when to create or update an entry. One or two sentences.'),
    i18n('- Record items (tableColumns) and each item\'s "prompt for the AI" (columnHints): the extraction AI follows them when filling the item. State what to fill in, format, length, allowed values, when to leave it empty, and how to write names and places so they match other types.'),
    i18n('- Required (requiredColumns): the extraction AI must fill these in. Only identifying items and the most essential facts; few and precise.'),
    i18n('- Always visible to the AI (alwaysInject): every entry is sent with every reply. Only for a few important things (plot threads, rules, ongoing promises); it uses up context.'),
    i18n('- Keep only the latest per name (latestOnly + primaryKeyColumns): one entry per subject, new information replaces the old. Suits "current state" types; the primary key must be an identifying item.'),
    i18n('- Merge into summaries automatically (compression hierarchical): old entries merge into summaries. Only for numerous, append-only types (such as events).'),
    '',
    i18n('[Good prompts for the AI] Specific, actionable and short (one to three sentences). Example: "Full name of the person, spelled the same as in the character type; write {{user}} for the user." Avoid vague "describe in detail". Keep existing constraints, macros (such as {{user}}), allowed value lists and references to other types.'),
    i18n('[Language] Everything people read (names, descriptions, prompts) must be in English; keep code-like tokens ({{user}}, table names) as they are.'),
];

const TASK = {
    columnHint: i18n('Task: rewrite the "prompt for the AI" of the item below so the extraction AI can follow it more easily. Call submit_text once and return only the rewritten prompt.'),
    typeIntro: i18n('Task: rewrite the description of the type below: what this memory type records and when to create or update an entry, in one or two sentences. Call submit_text once and return only the rewritten description.'),
    suggest: [
        i18n('Task: improve the memory type below so it records well and is useful. Call mg_schema_set_node_type once with the complete improved type (keep the id).'),
        i18n('Hard requirements: never change the key of an existing item (its prompt may change); do not remove existing items unless the user asks; new keys use snake_case English; do not send advanced fields such as extractionInstructions or keywords.'),
    ].join('\n'),
};

const SUGGEST_GUIDE = [
    i18n('[When improving a type]'),
    i18n('- Give a clear English name and a one or two sentence type description.'),
    i18n('- Usually 4 to 9 record items; the first identifies the entry (such as "display name"), and each item gets a specific prompt.'),
    i18n('- Choose the three switches carefully following the rules above; set the primary key when turning on "Keep only the latest per name".'),
    i18n('- Stay consistent with other types: use their spelling for people and places.'),
    i18n('- After the tool call, sum up your main idea in one English sentence.'),
];

export function rewriteSystemPrompt(kind, { builtin = true } = {}) {
    return [...(builtin ? [...BUILTIN_GUIDE, ''] : []), TASK[kind] || TASK.columnHint].join('\n');
}

export function suggestSystemPrompt({ builtin = true } = {}) {
    return [...(builtin ? [...BUILTIN_GUIDE, '', ...SUGGEST_GUIDE, ''] : []), TASK.suggest].join('\n');
}

export function rewriteUserPrompt({ kind, text, typeName = '', itemName = '', siblings = [] }) {
    const lines = [];
    if (typeName) lines.push(i18nFormat('Memory type: ${0}', typeName));
    if (itemName) lines.push(i18nFormat('Record item: ${0}', itemName));
    if (siblings.length) lines.push(i18nFormat('Other record items of this type: ${0}', siblings.slice(0, 40).join(listSeparator())));
    lines.push('', kind === 'typeIntro' ? i18n('Current description:') : i18n('Current prompt:'), String(text || '') || i18n('(empty, please write one)'));
    return lines.join('\n');
}

const briefType = (t) => {
    const hints = t.columnHints || {};
    const cols = (t.tableColumns || []).map(k => (hints[k] ? `${k}${i18nFormat(' (${0})', String(hints[k]).slice(0, 40))}` : k)).join(listSeparator());
    return i18nFormat('- ${0} "${1}": ${2}', t.id, t.label || t.id, cols);
};

export function suggestUserPrompt({ spec, others = [], request = '' }) {
    const current = spec ? {
        id: spec.id,
        label: spec.label,
        extractHint: spec.extractHint,
        tableColumns: spec.tableColumns,
        columnHints: spec.columnHints,
        requiredColumns: spec.requiredColumns,
        primaryKeyColumns: spec.primaryKeyColumns,
        alwaysInject: spec.alwaysInject,
        latestOnly: spec.latestOnly,
        compression: { mode: spec.compression?.mode || 'none' },
    } : {};
    return [
        i18nFormat('User request: ${0}', request.trim() || i18n('(none; judge from what this type is for and make it complete and useful)')),
        '',
        i18n('Type to improve (JSON):'),
        JSON.stringify(current, null, 2),
        '',
        i18n('Other types in the structure (for consistency):'),
        others.map(briefType).join('\n') || i18n('(none)'),
    ].join('\n');
}
