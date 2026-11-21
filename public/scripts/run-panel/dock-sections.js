// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Renders the sections of one timeline segment (thinking, output, tool
// calls / results, planner decisions) as a readable step list with zero
// truncation of expanded details or parameters. All text uses textContent only.

import { h, put, copyText } from '../lens-shared/util.js';
import { iconButton } from '../lens-shared/ui.js';
import { icon } from './dock-icons.js';
import { i18n, agentName, toolName } from './dock-i18n.js';
import { parseMaybeJson, toolNameOf, plannerDecision } from './dock-model.js';

const KIND = {
    reasoning: { label: 'Model thinking', icon: 'brain' },
    text: { label: 'Output', icon: 'doc' },
    tool_call: { label: 'Tool call', icon: 'tool' },
    tool_result: { label: 'Tool result', icon: 'check' },
    note: { label: 'Planner decision', icon: 'review' },
    sub_agent: { label: 'Sub-agent dispatch', icon: 'user' },
    prompt: { label: 'Prompt', icon: 'pen' },
    image: { label: 'Image', icon: 'image' },
    error: { label: 'Error', icon: 'alert' },
    tool: { label: 'Tool', icon: 'tool' },
};
const LONG = 700;

function isSafeImageUrl(raw) {
    const url = String(raw || '').trim();
    if (!url) return false;
    return /^(?:\/(?!\/)|blob:|data:image\/|https?:\/\/)/i.test(url);
}

function distinctTitle(kind, rawTitle) {
    const t = String(rawTitle || '').trim();
    if (!t) return '';
    const meta = KIND[kind] || KIND.text;
    return t === i18n(meta.label) || t === meta.label ? '' : t;
}

function textBlock(text, { app, title = '', mono = false, collapsed = null } = {}) {
    const value = String(text ?? '');
    const long = value.length > LONG || value.split('\n').length > 14;
    const fold = collapsed ?? long;
    const pre = h('div', { class: `rp-textblock${mono ? ' is-mono' : ''}${fold ? ' is-folded' : ''}`, text: value });
    const more = long ? h('button', {
        type: 'button',
        class: 'lw-link rp-textblock-more',
        onClick: () => {
            const folded = pre.classList.toggle('is-folded');
            more.textContent = folded ? i18n('Expand all') : i18n('Collapse');
        },
        text: fold ? i18n('Expand all') : i18n('Collapse'),
    }) : null;
    return h('div', { class: 'rp-textwrap' }, pre,
        h('div', { class: 'rp-textblock-foot' }, more,
            app?.showText && value.length > 200 ? h('button', { type: 'button', class: 'lw-link', text: i18n('Inspect run'), onClick: () => app.showText(title || i18n('Output'), [{ title: '', text: value }]) }) : null));
}

function kvList(value) {
    if (!value || typeof value !== 'object') return null;
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i + 1), v]) : Object.entries(value);
    if (!entries.length) return null;
    return h('dl', { class: 'rp-kv' }, entries.map(([key, raw]) => {
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        return [h('dt', { text: key }), h('dd', { text })];
    }));
}

function stepHead(kind, title, status, extra = null) {
    const meta = KIND[kind] || KIND.text;
    return h('div', { class: 'rp-step-head' },
        h('span', { class: 'rp-step-icon', 'aria-hidden': 'true' }, icon(meta.icon, { size: 13 })),
        h('span', { class: 'rp-step-kind', text: i18n(meta.label) }),
        title ? h('span', { class: 'rp-step-title', text: title }) : null,
        status === 'running' ? h('span', { class: 'rp-step-live' }, h('span', { class: 'rp-pulse' }), h('span', { text: i18n('Running') })) : null,
        status === 'failed' ? h('span', { class: 'rp-step-fail', text: i18n('Failed') }) : null,
        h('span', { class: 'rp-spacer' }),
        extra);
}

function copyBtn(app, text) {
    if (!text) return null;
    return iconButton('copy', i18n('Copy'), async () => { if (await copyText(text)) app?.notify(i18n('Copied')); }, { className: 'is-sm', renderIcon: icon, size: 14 });
}

function plannerBlock(decision) {
    const parts = [];
    if (decision.todos.length) {
        parts.push(h('div', { class: 'rp-plan-group' },
            h('div', { class: 'rp-plan-label', text: i18n('To-do') }),
            h('ul', { class: 'rp-plan-list' }, decision.todos.map(todo => h('li', { dataset: { op: todo.op } },
                h('span', { class: 'rp-plan-op', text: todo.op === 'add' ? i18n('New to-do') : todo.op === 'drop' ? i18n('Drop') : todo.status === 'done' ? i18n('Complete') : i18n('Update') }),
                h('span', { text: todo.goal || todo.id }))))));
    }
    if (decision.dispatches.length) {
        parts.push(h('div', { class: 'rp-plan-group' },
            h('div', { class: 'rp-plan-label', text: i18n('Dispatched') }),
            h('ul', { class: 'rp-plan-list' }, decision.dispatches.map(d => h('li', null,
                h('span', { class: 'rp-plan-agent', text: agentName(d.agent) }),
                h('span', { text: d.brief }))))));
    }
    if (decision.finalize) parts.push(h('div', { class: 'rp-plan-final' }, icon('check', { size: 13 }), h('span', { text: i18n('Getting ready to wrap up') })));
    return parts.length ? h('div', { class: 'rp-plan' }, parts) : null;
}

function toolCallBody(name, args) {
    const value = parseMaybeJson(args);
    if (name === 'dispatch_subagent' || name === 'dispatch_inline_subagent') {
        const id = value?.subagentId || value?.subagent_id || value?.agent || value?.id || '';
        const task = value?.task || value?.task_brief || value?.brief || '';
        return h('div', { class: 'rp-dispatch' },
            id ? h('span', { class: 'rp-plan-agent', text: agentName(id) }) : null,
            task ? h('span', { class: 'rp-dispatch-task', text: String(task) }) : null);
    }
    if (typeof value === 'string') return value ? h('div', { class: 'rp-textblock is-mono', text: value }) : null;
    return kvList(value);
}

export function renderSections(sections, { app, mode, agentId } = {}) {
    const list = h('ol', { class: 'rp-steps' });
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
            content = err ? h('div', { class: 'rp-step-err', text: String(err) }) : body ? textBlock(body, { app, mono: true, collapsed: true, title }) : null;
        } else if (kind === 'note' && section.meta?.output && mode === 'agenda') {
            const decision = plannerDecision(section);
            content = decision ? plannerBlock(decision) : textBlock(body, { app, mono: true });
        } else if (kind === 'image') {
            title = distinctTitle('image', section.title);
            extra = null;
            const rawUrl = typeof section.meta?.imageUrl === 'string' ? section.meta.imageUrl.trim() : '';
            if (isSafeImageUrl(rawUrl)) {
                content = h('a', {
                    class: 'rp-step-image-link',
                    href: rawUrl,
                    target: '_blank',
                    rel: 'noopener',
                    style: { display: 'block', width: 'fit-content', maxWidth: '100%' },
                }, h('img', {
                    class: 'rp-step-image',
                    src: rawUrl,
                    alt: String(section.title || i18n('Image')),
                    loading: 'lazy',
                    style: {
                        display: 'block',
                        maxWidth: '100%',
                        maxHeight: '240px',
                        borderRadius: 'var(--lw-r-sm)',
                        border: '1px solid var(--lw-border)',
                        objectFit: 'contain',
                    },
                }));
            } else if (section.status === 'running') {
                content = h('div', { class: 'rp-step-wait', text: i18n('Generating image') });
            } else if (section.status === 'failed') {
                const errMsg = body || String(section.meta?.err || '');
                content = errMsg.trim() ? h('div', { class: 'rp-step-err', text: errMsg }) : null;
            } else if (section.status === 'aborted') {
                content = h('div', { class: 'rp-step-wait', text: i18n('Stopped') });
            } else {
                continue;
            }
        } else if (kind === 'prompt') {
            if (!body.trim()) continue;
            title = distinctTitle('prompt', section.title);
            content = textBlock(body, { app, title: String(section.title || i18n('Prompt')) });
        } else if (kind === 'error') {
            const errText = body || String(section.meta?.err || '');
            if (!errText.trim()) continue;
            title = distinctTitle('error', section.title);
            content = h('div', { class: 'rp-step-err', text: errText });
        } else if (kind === 'tool') {
            title = distinctTitle('tool', section.title);
            content = body.trim()
                ? textBlock(body, { app, mono: true, collapsed: true, title: String(section.title || i18n('Tool')) })
                : (section.status === 'running' ? h('div', { class: 'rp-step-wait', text: i18n('Generating…') }) : null);
            if (!content) continue;
        } else if (kind === 'reasoning') {
            if (!body.trim()) continue;
            content = textBlock(body, { app, collapsed: true, title: `${agentName(agentId)} · ${i18n('Model thinking')}` });
        } else {
            if (section.meta?.err && !body) {
                content = h('div', { class: 'rp-step-err', text: String(section.meta.err) });
            } else if (body.trim()) {
                content = textBlock(body, { app, title: `${agentName(agentId)} · ${i18n('Output')}` });
            } else if (section.status === 'running') {
                content = h('div', { class: 'rp-step-wait', text: i18n('Generating…') });
            } else if (kind === 'note') {
                content = h('div', { class: 'rp-step-wait', text: i18n('Review result passed to the next step') });
            } else {
                continue;
            }
        }
        put(list, h('li', { class: 'rp-step', dataset: { kind, status: section.status } },
            stepHead(kind, title, section.status, extra),
            content));
    }
    if (!list.firstChild) put(list, h('li', { class: 'rp-step is-empty', text: i18n('No output yet for this run') }));
    return list;
}
