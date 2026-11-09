// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-line, plain-language descriptions of what an agent is doing, for the
// side panel. Pure: no DOM.

import { truncate } from '../../../lens-shared/util.js';
import { i18n, i18nFormat, listSeparator, agentName, toolName } from '../i18n.js';
import { parseMaybeJson, toolNameOf, plannerDecision } from './run.js';

const quote = (value, max = 36) => i18nFormat('"${0}"', truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), max));
const count = (value) => (Array.isArray(value) ? value.length : value ? 1 : 0);

function hostOf(url) {
    try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return truncate(String(url || ''), 40); }
}

/** @returns {{ icon: string, text: string }} */
export function describeToolCall(name, rawArgs) {
    const args = parseMaybeJson(rawArgs);
    const a = args && typeof args === 'object' ? args : {};
    const n = String(name || '');
    const q = a.query ?? a.q ?? a.keyword ?? a.keywords;
    if (/(^|_)(web_search|agent_search)$/.test(n) || n === 'search_search') return { icon: 'search', text: q ? i18nFormat('Search the web ${0}', quote(q)) : i18n('Search the web') };
    if (/(^|_)(web_visit|agent_visit)$/.test(n) || n === 'search_visit') return { icon: 'external', text: a.url ? i18nFormat('Open ${0}', hostOf(a.url)) : i18n('Open web page') };
    if (/upsert_lorebook_entry$/.test(n)) return { icon: 'pen', text: a.title ? i18nFormat('Write to the lorebook ${0}', quote(a.title)) : i18n('Write lorebook entry') };
    if (/delete_lorebook_entry$/.test(n)) return { icon: 'trash', text: i18nFormat('Delete ${0} lorebook entries', count(a.entry_ids)) };
    if (/get_lorebook_entries$/.test(n)) return { icon: 'doc', text: i18nFormat('Read ${0} lorebook entries', count(a.entry_ids)) };
    switch (n) {
        case 'chat_search': return { icon: 'search', text: q ? i18nFormat('Search the chat ${0}', quote(q)) : i18n('Search the chat') };
        case 'chat_read_range': return { icon: 'doc', text: a.from != null && a.to != null ? i18nFormat('Read floors ${0}–${1}', a.from, a.to) : i18n('Read the chat') };
        case 'lorebook_search': return { icon: 'search', text: q ? i18nFormat('Search the lorebook ${0}', quote(q)) : i18n('Search the lorebook') };
        case 'lorebook_get': return { icon: 'doc', text: i18n('Read lorebook entry') };
        case 'dispatch_subagent':
        case 'dispatch_inline_subagent': {
            const id = a.subagentId || a.subagent_id || a.agent || '';
            return { icon: 'user', text: id ? i18nFormat('Dispatch ${0}', agentName(id)) : i18n('Dispatch a temporary agent') };
        }
        case 'await_subagents': return { icon: 'clock', text: count(a.handles) > 1 ? i18nFormat('Wait for ${0} agents', count(a.handles)) : i18n('Wait for agents') };
        case 'write_message': return { icon: 'pen', text: a.text ? i18nFormat('Write the text (${0} characters)', String(a.text).length) : i18n('Write the text') };
        case 'apply_message_patches': return { icon: 'pen', text: count(a.patches) ? i18nFormat('Revise the text in ${0} places', count(a.patches)) : i18n('Revise the text') };
        case 'finalize': return { icon: 'check', text: i18n('Wrap up') };
        case 'luker_orch_review_approve': return { icon: 'check', text: i18n('Review passed') };
        case 'luker_orch_request_rerun': return { icon: 'repeat', text: i18n('Send back for redo') };
        default:
            if (n.startsWith('memory_')) return { icon: 'search', text: q ? i18nFormat('${0} ${1}', toolName(n), quote(q)) : toolName(n) };
            return { icon: 'tool', text: toolName(n) };
    }
}

/**
 * Short readable excerpt of model output. YAML-ish "key: value" lines keep
 * the value; bullet markers are dropped. `tail` shows the end (streaming).
 */
export function previewText(body, { tail = false, max = 120 } = {}) {
    const lines = String(body ?? '')
        .split('\n')
        .map(line => line.trim().replace(/^[-*•]\s+/, '').replace(/^[A-Za-z_][\w-]*:\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter(line => line && !/^[[\]{}]+,?$/.test(line));
    if (!lines.length) return '';
    const text = (tail ? lines.slice(-3) : lines.slice(0, 3)).join(' · ');
    if (text.length <= max) return text;
    return tail ? `…${text.slice(-(max - 1))}` : truncate(text, max);
}

/**
 * What to show under an agent's row.
 * @returns {{ lines: {icon: string, text: string, muted?: boolean}[] }}
 */
export function segmentPreview(seg, mode) {
    const lines = [];
    if (!seg || seg.pending) return { lines: [{ icon: 'clock', text: i18n('Waiting'), muted: true }] };
    const running = seg.status === 'running';
    const sections = seg.sections || [];

    if (mode === 'agenda') {
        const decision = plannerDecision(sections.find(s => s.meta?.output));
        if (decision) {
            if (decision.dispatches.length) lines.push({ icon: 'user', text: i18nFormat('Dispatched ${0}', decision.dispatches.map(d => agentName(d.agent)).join(listSeparator())) });
            const added = decision.todos.filter(op => op.op === 'add').length;
            if (added) lines.push({ icon: 'plus', text: i18nFormat('Added ${0} to-dos', added) });
            if (decision.finalize) lines.push({ icon: 'check', text: i18n('Getting ready to wrap up') });
            return { lines };
        }
    }

    for (const section of sections) {
        if (section.kind !== 'tool_call') continue;
        const name = toolNameOf(section);
        const result = sections.find(s => s.kind === 'tool_result' && s.id === section.id.replace(/^tool-/, 'tool-result-'));
        const line = describeToolCall(name, section.meta?.args ?? section.body);
        if (result && (result.meta?.ok === false || result.status === 'failed')) line.text = i18nFormat('${0} [failed]', line.text);
        lines.push(line);
    }

    const text = sections.filter(s => s.kind === 'text' || s.kind === 'note').map(s => s.body).join('\n');
    const excerpt = previewText(text, { tail: running });
    // Director drafts go out through write_message; its text section is chatter.
    if (excerpt && (!lines.length || !running)) lines.unshift({ icon: 'doc', text: excerpt, quote: true });

    if (!lines.length) {
        const reasoning = sections.find(s => s.kind === 'reasoning')?.body;
        if (running) lines.push({ icon: 'brain', text: reasoning ? i18nFormat('Thinking · ${0}', previewText(reasoning, { tail: true, max: 90 })) : i18n('Working…'), muted: true });
        else if (sections.some(s => s.kind === 'note')) lines.push({ icon: 'review', text: i18n('Review result passed to the next step'), muted: true });
        else if (seg.status === 'failed') lines.push({ icon: 'alert', text: String(sections.find(s => s.meta?.err)?.meta?.err || i18n('Agent failed')) });
    }
    return { lines };
}
