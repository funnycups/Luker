// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Right-hand detail panel for the selected agent: what it does, its prompts,
// model routing and tools, and what it produced in the current run.

import { h, clear, put, copyText } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat, agentName, agentRole, toolName, modeInfo, statusLabel } from '../i18n.js';
import { formatDuration } from '../model/run.js';
import { iconButton, emptyState, button } from '../ui/components.js';
import { agentAvatar, toneOf } from '../views/flow-view.js';
import { renderSections } from '../views/sections.js';
import { textField, routingField } from './field-editor.js';
import { fieldLabel } from '../model/edit.js';

const PROMPT_PREVIEW = 420;

export function createInspector(app) {
    const bodyEl = h('div', { class: 'ol-insp-body' });
    const el = h('aside', { class: 'ol-inspector', 'aria-label': i18n('Details') }, bodyEl);

    function promptBlock(title, text) {
        const value = String(text || '').trim();
        if (!value) return null;
        const long = value.length > PROMPT_PREVIEW;
        return h('section', { class: 'ol-insp-section' },
            h('div', { class: 'ol-section-title' }, h('span', { text: title }),
                h('span', { class: 'ol-insp-actions' },
                    iconButton('copy', i18n('Copy'), async () => { if (await copyText(value)) app.notify(i18n('Copied')); }, { className: 'ol-iconbtn-sm' }),
                    long ? iconButton('fit', i18n('View full screen'), () => app.showText(`${agentName(app.state().selectedAgent)} · ${title}`, [{ title: '', text: value }]), { className: 'ol-iconbtn-sm' }) : null)),
            h('div', { class: `ol-prompt${long ? ' is-clamped' : ''}`, text: value }));
    }

    // Editable view of one field: draft value vs stored value.
    function field(id, key, title) {
        const drafts = app.drafts;
        const fields = app.fieldsOf(id);
        if (!fields.includes(key)) return null;
        const value = drafts.get(id, key);
        const original = drafts.changeFor(id, key)?.before ?? value;
        if (!value && !app.canEdit()) return null;
        return textField({
            app,
            title,
            value,
            original,
            editable: app.canEdit(),
            fullTitle: `${agentName(id)} · ${title}`,
            onChange: (next) => drafts.set(id, key, next),
            aiAction: app.source.ai ? () => app.openAi(i18nFormat('Improve the ${1} of "${0}":', agentName(id), fieldLabel(key))) : null,
        });
    }

    function routingEditable(id, agent) {
        const fields = app.fieldsOf(id);
        if (!fields.includes('api') && !fields.includes('preset')) return routing(agent);
        const opts = app.modelOptions();
        const rows = ['api', 'preset'].filter(key => fields.includes(key)).map(key => ({
            field: key,
            label: key === 'api' ? i18n('Connection profile') : i18n('Generation preset'),
            value: app.drafts.get(id, key),
            original: app.drafts.changeFor(id, key)?.before ?? app.drafts.get(id, key),
            options: key === 'api' ? opts.connections : opts.presets,
        }));
        return routingField({ rows, editable: app.canEdit(), fallback: i18n('Follow orchestration default'), onChange: (key, value) => app.drafts.set(id, key, value) });
    }

    function routing(agent) {
        const rows = [
            [i18n('Connection profile'), agent.apiPreset || i18n('Follow orchestration default'), !agent.apiPreset],
            [i18n('Generation preset'), agent.promptPreset || i18n('Follow orchestration default'), !agent.promptPreset],
        ];
        return h('section', { class: 'ol-insp-section' },
            h('div', { class: 'ol-section-title' }, h('span', { text: i18n('AI model') })),
            h('dl', { class: 'ol-kv is-wide' }, rows.map(([k, v, muted]) => [h('dt', { text: k }), h('dd', { class: muted ? 'is-muted' : '', text: v })])));
    }

    function toolsBlock(agent) {
        const own = agent.tools;
        const list = own ?? agent.inheritedTools ?? [];
        return h('section', { class: 'ol-insp-section' },
            h('div', { class: 'ol-section-title' }, h('span', { text: i18n('Agent tools') }), own === null && agent.inheritedTools ? h('span', { class: 'ol-insp-note', text: i18n('Uses the overall setting') }) : null),
            list.length
                ? h('div', { class: 'ol-toolcloud' }, list.map(name => h('span', { class: 'ol-chip', title: name, text: toolName(name) })))
                : h('p', { class: 'ol-muted', text: i18n('Uses no tools') }));
    }

    function editBar(id, agent) {
        if (!agent) return null;
        const reason = app.canEdit() ? '' : app.editBlockedReason();
        return h('div', { class: 'ol-insp-editbar' },
            app.source.ai ? h('button', { type: 'button', class: 'ol-btn ol-btn-sm', onClick: () => app.openAi(i18nFormat('See what could be improved in the settings of "${0}"', agentName(id))) }, icon('sparkle', { size: 13 }), h('span', { text: i18n('Let the AI improve this agent') })) : null,
            reason ? h('span', { class: 'ol-insp-note', text: reason }) : null);
    }

    function activity(agentId) {
        const run = app.run();
        if (!run) return null;
        const segs = run.segments.filter(seg => seg.agentId === agentId);
        if (!segs.length) return h('section', { class: 'ol-insp-section' },
            h('div', { class: 'ol-section-title' }, h('span', { text: i18n('Output of this run') })),
            h('p', { class: 'ol-muted', text: run.status === 'running' ? i18n('Waiting') : i18n('No output yet for this run') }));
        const selectedKey = app.state().selectedSegment;
        const seg = segs.find(item => item.key === selectedKey) || segs[segs.length - 1];
        return h('section', { class: 'ol-insp-section' },
            h('div', { class: 'ol-section-title' },
                h('span', { text: i18n('Output of this run') }),
                h('span', { class: 'ol-insp-note', text: [segs.length > 1 ? i18nFormat('${0} times in total', segs.length) : '', formatDuration(seg.duration), statusLabel(seg.status)].filter(Boolean).join(' · ') })),
            segs.length > 1 ? h('div', { class: 'ol-insp-attempts' }, segs.map((item, i) => h('button', {
                type: 'button',
                class: 'ol-attempt',
                dataset: { status: item.status },
                'aria-pressed': String(item === seg),
                onClick: () => app.selectSegment(item.key, agentId),
                text: String(i + 1),
            }))) : null,
            app.source.ai && run.status !== 'running' ? h('div', { class: 'ol-insp-diag' }, button(i18n('AI diagnosis of this step'), () => app.diagnose(run.key, run.segments.indexOf(seg) + 1), { iconName: 'target', className: 'ol-btn-sm' })) : null,
            renderSections(seg.sections, { app, mode: run.mode, agentId }));
    }

    function overview() {
        const flow = app.flow();
        if (!flow) return emptyState('flow', i18n('Pick an agent to see its settings and its output for this run.'));
        const info = modeInfo(flow.mode);
        const run = app.run();
        return h('div', { class: 'ol-insp-overview' },
            h('div', { class: 'ol-insp-head' },
                h('span', { class: 'ol-brand-mark', 'aria-hidden': 'true' }, icon('conductor', { size: 17 })),
                h('div', null, h('h3', { text: info.label }), h('span', { class: 'ol-insp-sub', text: info.hint }))),
            h('dl', { class: 'ol-kv is-wide' },
                h('dt', { text: i18n('Agent count') }), h('dd', { text: String(Object.keys(flow.agents).length) }),
                flow.mode === 'spec' || flow.mode === 'single' ? [h('dt', { text: i18n('Step count') }), h('dd', { text: String(flow.columns.length) })] : null,
                flow.presetName ? [h('dt', { text: i18n('Orchestration profile') }), h('dd', { text: flow.presetName })] : null,
                h('dt', { text: i18n('Applies to') }), h('dd', { text: flow.scopeLabel })),
            run?.finalText ? h('section', { class: 'ol-insp-section' },
                h('div', { class: 'ol-section-title' }, h('span', { text: i18n('Final result') }), iconButton('copy', i18n('Copy'), async () => { if (await copyText(run.finalText)) app.notify(i18n('Copied')); }, { className: 'ol-iconbtn-sm' })),
                h('div', { class: 'ol-prompt is-clamped', text: run.finalText })) : null,
            h('p', { class: 'ol-muted ol-insp-hint', text: i18n('Pick an agent to see its settings and its output for this run.') }));
    }

    function render() {
        clear(bodyEl);
        const id = app.state().selectedAgent;
        const flow = app.flow();
        if (!id) {
            put(bodyEl, overview());
            return;
        }
        const agent = flow?.agents?.[id] || null;
        put(bodyEl,
            h('div', { class: 'ol-insp-head', dataset: { tone: toneOf(id) } },
                agentAvatar(id, { size: 'lg' }),
                h('div', { class: 'ol-insp-titles' },
                    h('h3', { text: agentName(id) }),
                    agentName(id) !== id ? h('span', { class: 'ol-insp-id', text: id }) : null),
                h('span', { class: 'ol-spacer' }),
                iconButton('x', i18n('Close'), () => app.selectAgent(''), { className: 'ol-iconbtn-sm' })),
            agentRole(id) || agent?.description ? h('p', { class: 'ol-insp-role', text: agentRole(id) || agent.description }) : null,
            editBar(id, agent),
            // The run view shows the selected step in its own detail pane.
            app.state().view === 'run' ? null : activity(id),
            agent && app.draftsActive() ? [
                field(id, 'description', i18n('Agent description')),
                field(id, 'system', i18n('Role prompt (system prompt)')),
                field(id, 'task', i18n('Task template')),
                routingEditable(id, agent),
            ] : agent ? [
                agentRole(id) && agent.description ? promptBlock(i18n('Agent description'), agent.description) : null,
                promptBlock(i18n('Role prompt (system prompt)'), agent.systemPrompt),
                promptBlock(i18n('Task template'), agent.userPrompt),
                routing(agent),
            ] : null,
            agent ? toolsBlock(agent) : null,
            !agent ? h('p', { class: 'ol-muted', text: i18n('This agent is not in the current profile (it may have been dispatched ad hoc, or the profile changed).') }) : null);
    }

    return { el, render, onRunUpdate: () => { if (app.state().selectedAgent) render(); } };
}
