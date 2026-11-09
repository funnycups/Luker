// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Renders the sections of one timeline segment (thinking, output, tool
// calls / results, planner decisions) as a readable step list. All text is
// model output → textContent only.

import { h, put, copyText, truncate } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat, agentName, toolName } from '../i18n.js';
import { parseMaybeJson, toolNameOf, plannerDecision } from '../model/run.js';
import { iconButton } from '../ui/components.js';

const KIND = {
    reasoning: { label: 'Model thinking', icon: 'brain' },
    text: { label: 'Output', icon: 'doc' },
    tool_call: { label: 'Tool call', icon: 'tool' },
    tool_result: { label: 'Tool result', icon: 'check' },
    note: { label: 'Planner decision', icon: 'review' },
    sub_agent: { label: 'Sub-agent dispatch', icon: 'user' },
};
const LONG = 700;

/** Collapsible text block; long text starts folded. */
function textBlock(text, { app, title = '', mono = false, collapsed = null } = {}) {
    const value = String(text ?? '');
    const long = value.length > LONG || value.split('\n').length > 14;
    const fold = collapsed ?? long;
    const pre = h('div', { class: `ol-textblock${mono ? ' is-mono' : ''}${fold ? ' is-folded' : ''}`, text: value });
    const more = long ? h('button', {
        type: 'button',
        class: 'ol-linkbtn ol-textblock-more',
        onClick: () => {
            const folded = pre.classList.toggle('is-folded');
            more.textContent = folded ? i18n('Expand all') : i18n('Collapse');
        },
        text: fold ? i18n('Expand all') : i18n('Collapse'),
    }) : null;
    return h('div', { class: 'ol-textwrap' }, pre,
        h('div', { class: 'ol-textblock-foot' }, more,
            app && value.length > 200 ? h('button', { type: 'button', class: 'ol-linkbtn', text: i18n('View full screen'), onClick: () => app.showText(title || i18n('Output'), [{ title: '', text: value }]) }) : null));
}

/** Flat key/value list for small objects (tool args, results). */
function kvList(value) {
    if (!value || typeof value !== 'object') return null;
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i + 1), v]) : Object.entries(value);
    if (!entries.length) return null;
    return h('dl', { class: 'ol-kv' }, entries.slice(0, 12).map(([key, raw]) => {
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        return [h('dt', { text: key }), h('dd', { text: truncate(text, 400) })];
    }), entries.length > 12 ? h('dd', { class: 'ol-kv-more', text: i18nFormat('…and ${0} more', entries.length - 12) }) : null);
}

function stepHead(kind, title, status, extra = null) {
    const meta = KIND[kind] || KIND.text;
    return h('div', { class: 'ol-step-head' },
        h('span', { class: 'ol-step-icon', 'aria-hidden': 'true' }, icon(meta.icon, { size: 13 })),
        h('span', { class: 'ol-step-kind', text: i18n(meta.label) }),
        title ? h('span', { class: 'ol-step-title', text: title }) : null,
        status === 'running' ? h('span', { class: 'ol-step-live' }, h('span', { class: 'ol-pulse' }), h('span', { text: i18n('Running') })) : null,
        status === 'failed' ? h('span', { class: 'ol-step-fail', text: i18n('Failed') }) : null,
        h('span', { class: 'ol-spacer' }),
        extra);
}

function copyBtn(app, text) {
    if (!text) return null;
    return iconButton('copy', i18n('Copy'), async () => { if (await copyText(text)) app?.notify(i18n('Copied')); }, { className: 'ol-iconbtn-sm' });
}

function plannerBlock(decision) {
    const parts = [];
    if (decision.todos.length) {
        parts.push(h('div', { class: 'ol-plan-group' },
            h('div', { class: 'ol-plan-label', text: i18n('To-do') }),
            h('ul', { class: 'ol-plan-list' }, decision.todos.map(todo => h('li', { dataset: { op: todo.op } },
                h('span', { class: 'ol-plan-op', text: todo.op === 'add' ? i18n('New to-do') : todo.op === 'drop' ? i18n('Drop') : todo.status === 'done' ? i18n('Complete') : i18n('Update') }),
                h('span', { text: todo.goal || todo.id }))))));
    }
    if (decision.dispatches.length) {
        parts.push(h('div', { class: 'ol-plan-group' },
            h('div', { class: 'ol-plan-label', text: i18n('Dispatched') }),
            h('ul', { class: 'ol-plan-list' }, decision.dispatches.map(d => h('li', null,
                h('span', { class: 'ol-plan-agent', text: agentName(d.agent) }),
                h('span', { text: d.brief }))))));
    }
    if (decision.finalize) parts.push(h('div', { class: 'ol-plan-final' }, icon('check', { size: 13 }), h('span', { text: i18n('Getting ready to wrap up') })));
    return parts.length ? h('div', { class: 'ol-plan' }, parts) : null;
}

function toolCallBody(name, args) {
    const value = parseMaybeJson(args);
    if (name === 'dispatch_subagent' || name === 'dispatch_inline_subagent') {
        const id = value?.subagentId || value?.subagent_id || value?.agent || value?.id || '';
        const task = value?.task || value?.task_brief || value?.brief || '';
        return h('div', { class: 'ol-dispatch' },
            id ? h('span', { class: 'ol-plan-agent', text: agentName(id) }) : null,
            task ? h('span', { class: 'ol-dispatch-task', text: truncate(task, 600) }) : null);
    }
    if (typeof value === 'string') return value ? h('div', { class: 'ol-textblock is-mono', text: truncate(value, 1200) }) : null;
    return kvList(value);
}

export function renderSections(sections, { app, mode, agentId } = {}) {
    const list = h('ol', { class: 'ol-steps' });
    for (const section of sections || []) {
        const kind = section.kind;
        const body = String(section.body || '');
        let content = null;
        let title = '';
        let extra = copyBtn(app, body);
        if (kind === 'tool_call') {
            const name = toolNameOf(section);
            title = toolName(name);
            content = toolCallBody(name, section.meta?.args ?? body);
            extra = null;
        } else if (kind === 'tool_result') {
            const name = toolNameOf(section);
            const ok = section.meta?.ok !== false && section.status !== 'failed';
            title = `${toolName(name)} · ${ok ? i18n('Succeeded') : i18n('Failed')}`;
            const err = section.meta?.err;
            content = err ? h('div', { class: 'ol-step-err', text: String(err) }) : body ? textBlock(body, { app, mono: true, collapsed: true, title }) : null;
        } else if (kind === 'note' && section.meta?.output && mode === 'agenda') {
            const decision = plannerDecision(section);
            content = decision ? plannerBlock(decision) : textBlock(body, { app, mono: true });
        } else if (kind === 'reasoning') {
            if (!body.trim()) continue;
            content = textBlock(body, { app, collapsed: true, title: `${agentName(agentId)} · ${i18n('Model thinking')}` });
        } else {
            if (section.meta?.err && !body) {
                content = h('div', { class: 'ol-step-err', text: String(section.meta.err) });
            } else if (body.trim()) {
                content = textBlock(body, { app, title: `${agentName(agentId)} · ${i18n('Output')}` });
            } else if (section.status === 'running') {
                content = h('div', { class: 'ol-step-wait', text: i18n('Generating…') });
            } else if (kind === 'note') {
                content = h('div', { class: 'ol-step-wait', text: i18n('Review result passed to the next step') });
            } else {
                continue;
            }
        }
        put(list, h('li', { class: 'ol-step', dataset: { kind, status: section.status } },
            stepHead(kind, title, section.status, extra),
            content));
    }
    if (!list.firstChild) put(list, h('li', { class: 'ol-step is-empty', text: i18n('No output yet for this run') }));
    return list;
}
