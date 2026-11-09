// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Profile setup: preset library, workflow structure, tools, skills and the
// lorebook filter. Structure edits go into the draft; preset actions and
// custom tools apply right away, like their counterparts in the orchestrator.

import { h, clear, put } from '../../../lens-shared/util.js';
import { i18n, i18nFormat, modeInfo, MODE_IDS } from '../i18n.js';
import { button, iconButton, checkRow, switchControl, sectionTitle, emptyState } from '../ui/components.js';
import {
    PROFILE, addAgendaAgent, addNode, addPresetEntry, addStage, addSubAgent, moveNode, moveStage,
    removeAgendaAgent, removeNode, removePresetEntry, removeStage, removeSubAgent, setDefaultTools,
    setNodeProp, setStageProp, withToolFlag,
} from '../model/edit.js';

const TOOL_GROUPS = [
    { id: 'note', verbs: ['open', 'close'] },
    { id: 'chat', verbs: ['read_range', 'search'] },
    { id: 'lorebook', verbs: ['world_book_list', 'list', 'search', 'get'] },
];
const DIRECTOR_GROUPS = [
    { id: 'collab', verbs: ['dispatch_subagent', 'dispatch_inline_subagent'] },
    { id: 'message', verbs: ['write_message', 'apply_message_patches'] },
];

export const isEditing = (el) => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') && el.contains(document.activeElement);

export function textInput(value, onCommit, { placeholder = '', type = 'text', disabled = false } = {}) {
    return h('input', { class: 'ol-input', type, value: value ?? '', placeholder, disabled, onChange: (event) => onCommit(event.target.value) });
}

export function textArea(value, onCommit, { rows = 4, disabled = false, onInput = false } = {}) {
    const el = h('textarea', { class: 'ol-textarea', rows, disabled, [onInput ? 'onInput' : 'onChange']: (event) => onCommit(event.target.value) });
    el.value = value ?? '';
    return el;
}

export function selectInput(options, value, onChange, { disabled = false } = {}) {
    const el = h('select', { class: 'ol-select', disabled, onChange: (event) => onChange(event.target.value) },
        options.map(option => h('option', { value: option.value, text: option.label })));
    el.value = value ?? '';
    return el;
}

export const formRow = (label, control) => h('label', { class: 'ol-form-row' }, h('span', { text: label }), control);

export function createSetupView(app) {
    const el = h('div', { class: 'ol-setup' });
    let quiet = false;
    let inventory = null;

    const target = () => app.snapshot()?.target || null;
    const profile = () => app.drafts.profile();
    const mode = () => target()?.mode || '';
    const editable = () => app.canEdit();
    const fail = (err) => app.notify(String(err?.message || err), { error: true });

    function structure(fn) {
        try {
            app.drafts.setProfile(fn(profile()));
        } catch (err) {
            fail(err);
        }
    }
    /** Text commits leave the DOM alone, so the control the user clicked next still exists. */
    function commit(agentId, field, value) {
        quiet = true;
        try {
            app.drafts.set(agentId, field, value);
        } catch (err) {
            fail(err);
        } finally {
            quiet = false;
        }
    }
    const jsonOf = (agentId, field) => {
        const text = app.drafts.get(agentId, field);
        return text ? JSON.parse(text) : null;
    };

    async function action(fn, done = '') {
        try {
            const result = await fn();
            if (result === false) return;
            if (done) app.notify(done);
            await app.reload();
        } catch (err) {
            fail(err);
        }
    }
    function cleanDrafts() {
        if (!app.drafts.count()) return true;
        app.notify(i18n('Save or discard your edits first.'), { error: true });
        return false;
    }
    const confirmDanger = async (title, text, label) => Boolean(await app.dialog.ask(title, h('p', { class: 'ol-dialog-text', text }), [{ label: i18n('Cancel'), value: '' }, { label, value: 'yes', danger: true }]));

    function pickFile() {
        return new Promise((resolve) => {
            const input = h('input', { type: 'file', accept: '.json,application/json', onChange: async () => resolve(input.files?.[0] ? await input.files[0].text() : null) });
            input.click();
        });
    }

    // ----- Preset bar -------------------------------------------------------
    function presetBar(t) {
        const presets = app.source.presets;
        if (t.mode === 'single') {
            return h('div', { class: 'ol-setup-bar' }, button(i18n('Reset Prompts to Defaults'), async () => {
                if (await confirmDanger(i18n('Reset Prompts to Defaults'), i18n('Reset the single-agent system prompt and user prompt template to defaults? This will overwrite the current values.'), i18n('Reset'))) {
                    await action(() => presets.resetSingle(), i18n('Single-agent prompts reset to defaults.'));
                }
            }, { className: 'ol-btn-sm' }));
        }
        if (t.scope === 'chat') return null;
        const list = presets.list(t);
        const select = h('select', {
            class: 'ol-select',
            'aria-label': i18n('Orchestration profile'),
            onChange: async (event) => {
                const option = event.target.selectedOptions[0];
                if (!cleanDrafts()) { render(true); return; }
                await action(() => presets.select(t, option.dataset.scope, option.value));
            },
        },
        list.character.length ? h('optgroup', { label: i18n('This character') }, list.character.map(p => h('option', { value: p.id, text: p.name, dataset: { scope: 'character' } }))) : null,
        h('optgroup', { label: i18n('General') }, list.global.map(p => h('option', { value: p.id, text: p.name, dataset: { scope: 'global' } }))));
        select.value = t.presetId;
        const named = (titleText, initial, run) => async () => {
            if (!cleanDrafts()) return;
            const name = await app.promptText(titleText, initial);
            if (name) await action(() => run(name));
        };
        const onCard = t.scope === 'character';
        return h('div', { class: 'ol-setup-bar' }, select,
            iconButton('plus', i18n('New'), named(i18n('Enter a name for the new preset'), '', name => presets.create(t, name)), { className: 'ol-iconbtn-sm' }),
            iconButton('copy', i18n('Duplicate'), named(i18n('Enter a name for the new preset'), '', name => presets.duplicate(t, name)), { className: 'ol-iconbtn-sm' }),
            iconButton('pen', i18n('Rename'), named(i18n('Rename'), app.snapshot().presetName, name => presets.rename(t, name)), { className: 'ol-iconbtn-sm' }),
            iconButton('trash', i18n('Delete'), async () => {
                if (cleanDrafts() && await confirmDanger(i18n('Delete'), i18nFormat('Delete preset "${0}"?', app.snapshot().presetName), i18n('Delete'))) await action(() => presets.remove(t));
            }, { className: 'ol-iconbtn-sm' }),
            button(i18n('Import'), async () => {
                if (!cleanDrafts()) return;
                try {
                    const text = await pickFile();
                    if (!text) return;
                    const parsed = presets.parseImport(t, text);
                    const name = await app.promptText(i18n('Enter a name for the imported preset'), parsed.defaultName);
                    if (name) await action(() => presets.importParsed(t, parsed, name), i18n('Imported preset.'));
                } catch (err) { fail(err); }
            }, { className: 'ol-btn-sm ol-btn-ghost' }),
            button(i18n('Export'), () => action(() => presets.exportActive(t), i18n('Exported preset.')), { className: 'ol-btn-sm ol-btn-ghost' }),
            onCard ? button(i18n('Save To Global'), () => { if (cleanDrafts()) action(() => presets.saveToGlobal(t), i18n('Global orchestration profile saved.')); }, { className: 'ol-btn-sm ol-btn-ghost' }) : null,
            !onCard && t.avatar ? button(i18n('Save To Character Override'), () => { if (cleanDrafts()) action(() => presets.saveToCharacter(t), i18n('Character orchestration override saved.')); }, { className: 'ol-btn-sm ol-btn-ghost' }) : null,
            onCard ? button(i18n('Clear presets from this card'), async () => {
                if (cleanDrafts() && await confirmDanger(i18n('Clear presets from this card'), i18n('Clear presets from this card'), i18n('Delete'))) await action(() => presets.clearCharacter(t), i18n('Character orchestration override removed.'));
            }, { className: 'ol-btn-sm ol-btn-ghost' }) : null,
            app.source.openIterationStudio ? button(i18n('Open AI Iteration Studio'), () => { if (cleanDrafts()) app.source.openIterationStudio(); }, { className: 'ol-btn-sm ol-btn-ghost', iconName: 'sparkle' }) : null,
            app.source.openSkillManager ? button(i18n('Manage skills...'), () => app.source.openSkillManager(), { className: 'ol-btn-sm ol-btn-ghost' }) : null);
    }

    function pinRow(t) {
        if (!t.avatar) return null;
        const options = [{ value: '', label: i18n('None') }, ...MODE_IDS.filter(id => id !== 'single').map(id => ({ value: id, label: modeInfo(id).label }))];
        return formRow(i18n('Mode pinned to this card'), selectInput(options, app.snapshot().cardPinnedMode || '', value => action(() => app.source.presets.pinMode(t, value))));
    }

    // ----- Tools ------------------------------------------------------------
    function customNames() {
        const own = customTools().map(tool => String(tool?.name || ''));
        const registry = (app.source.customToolEditor?.registry() || []).map(tool => String(tool?.name || tool));
        return [...new Set([...own, ...registry])].filter(Boolean);
    }

    function toolGrid(tools, onChange, m) {
        const value = tools || {};
        const flag = (id, label, checked) => checkRow({ checked, label, onChange: (on) => onChange(id, on) });
        const groups = [...TOOL_GROUPS, ...(m === 'director' ? DIRECTOR_GROUPS : [])];
        return h('div', { class: 'ol-setup-tools' },
            groups.map(group => h('div', { class: 'ol-setup-toolgroup' },
                h('span', { class: 'ol-setup-toolhead', text: group.id }),
                group.verbs.map(verb => flag(`${group.id}.${verb}`, verb, Boolean(value[group.id]?.[verb]))))),
            customNames().length ? h('div', { class: 'ol-setup-toolgroup' },
                h('span', { class: 'ol-setup-toolhead', text: i18n('Custom tools') }),
                customNames().map(name => flag(`custom.${name}`, name, value.custom?.[name] !== false))) : null);
    }

    function defaultToolsSection(t) {
        const m = t.mode;
        if (m === 'loop' || m === 'single') return null;
        const slot = m === 'spec' ? 'spec/defaultTools' : m === 'agenda' ? 'defaultTools' : 'tools';
        const tools = jsonOf(PROFILE, slot);
        const clearOverrides = m !== 'director';
        const edit = app.source.edit;
        return h('section', { class: 'ol-setup-section' },
            sectionTitle(i18n('Default tools'), h('span', { class: 'ol-insp-actions' },
                button(i18n('Enable all'), () => structure(p => setDefaultTools(m, p, edit.allTools(m, true))), { className: 'ol-btn-sm ol-btn-ghost' }),
                button(i18n('Disable all'), () => structure(p => setDefaultTools(m, p, m === 'director' ? edit.allTools(m, false) : null, { clearOverrides })), { className: 'ol-btn-sm ol-btn-ghost' }))),
            tools ? toolGrid(tools, (id, on) => commit(PROFILE, slot, JSON.stringify(withToolFlag(jsonOf(PROFILE, slot), id, on))), m) : null);
    }

    function agentExtras(agentId, t, { tools = true, skills = true, inherit = null } = {}) {
        const current = tools ? jsonOf(agentId, 'tools') : null;
        return [
            tools ? h('div', { class: 'ol-setup-override' },
                switchControl(i18n('Override default tools'), current !== null, (on) => {
                    const seed = inherit?.() || app.source.edit.baseTools();
                    app.drafts.set(agentId, 'tools', on ? JSON.stringify(seed) : '');
                }),
                current ? toolGrid(current, (id, on) => commit(agentId, 'tools', JSON.stringify(withToolFlag(jsonOf(agentId, 'tools'), id, on))), t.mode) : null) : null,
            skills ? skillChips(agentId, 'skills', t) : null,
        ];
    }

    function modeSkillSlot(m) {
        return m === 'spec' ? 'spec/skills' : 'skills';
    }

    function skillChips(agentId, field, t) {
        const skills = app.source.skills;
        if (!skills) return null;
        const host = h('div', { class: 'ol-setup-chips' });
        inventory ||= Promise.resolve(skills.inventory());
        const slot = modeSkillSlot(t.mode);
        const read = (id, key) => {
            const value = jsonOf(id, key);
            return { visible: Array.isArray(value?.visible) ? value.visible : [], deny: Array.isArray(value?.deny) ? value.deny : [] };
        };
        inventory.then((list) => {
            if (!host.isConnected) return;
            skills.mount(host, {
                value: read(agentId, field),
                inheritFrom: agentId === PROFILE ? undefined : read(PROFILE, slot),
                availableSkills: list,
                onChange: next => commit(agentId, field, JSON.stringify({ visible: next.visible, deny: next.deny })),
            });
        }).catch(fail);
        return host;
    }

    // ----- Spec ------------------------------------------------------------
    function specSection(t) {
        const p = profile();
        const stages = Array.isArray(p.spec?.stages) ? p.spec.stages : [];
        const presetIds = Object.keys(p.presets || {});
        const presetOptions = presetIds.map(id => ({ value: id, label: id }));
        const disabled = !editable();
        const moveButtons = (index, length, fn) => [
            iconButton('chevronUp', i18n('Move up'), () => structure(q => fn(q, -1)), { className: 'ol-iconbtn-sm', disabled: disabled || index === 0 }),
            iconButton('chevronDown', i18n('Move down'), () => structure(q => fn(q, 1)), { className: 'ol-iconbtn-sm', disabled: disabled || index === length - 1 }),
        ];
        const nodeEl = (node, si, ni, nodes) => {
            const raw = typeof node === 'string' ? { id: node, preset: node, type: 'worker', userPromptTemplate: '' } : node;
            const set = (key, value) => { quiet = true; structure(q => setNodeProp(q, si, ni, key, value)); quiet = false; };
            return h('details', { class: 'ol-setup-node' },
                h('summary', null, h('span', { class: 'ol-setup-name', text: raw.id }), h('span', { class: 'ol-spacer' }),
                    moveButtons(ni, nodes.length, (q, d) => moveNode(q, si, ni, d)),
                    iconButton('trash', i18n('Delete'), () => structure(q => removeNode(q, si, ni)), { className: 'ol-iconbtn-sm', disabled })),
                h('div', { class: 'ol-form' },
                    formRow(i18n('Node ID'), textInput(raw.id, v => set('id', v), { disabled })),
                    formRow(i18n('Agent preset'), selectInput(presetOptions, raw.preset, v => set('preset', v), { disabled })),
                    formRow(i18n('Node type'), selectInput([{ value: 'worker', label: i18n('Worker') }, { value: 'review', label: i18n('Review') }], raw.type || 'worker', v => set('type', v), { disabled })),
                    formRow(i18n('Task template'), textArea(raw.userPromptTemplate, v => set('userPromptTemplate', v), { disabled })),
                    agentExtras(raw.id, t, { inherit: () => jsonOf(PROFILE, 'spec/defaultTools') })));
        };
        const stageEl = (stage, si) => {
            const nodes = Array.isArray(stage.nodes) ? stage.nodes : [];
            const set = (key, value) => { quiet = true; structure(q => setStageProp(q, si, key, value)); quiet = false; };
            return h('div', { class: 'ol-setup-stage' },
                h('div', { class: 'ol-setup-stagehead' },
                    textInput(stage.id, v => set('id', v), { disabled }),
                    selectInput([{ value: 'serial', label: i18n('In order') }, { value: 'parallel', label: i18n('At once') }], stage.mode || 'serial', v => set('mode', v), { disabled }),
                    h('span', { class: 'ol-spacer' }),
                    moveButtons(si, stages.length, (q, d) => moveStage(q, si, d)),
                    iconButton('trash', i18n('Delete'), () => structure(q => removeStage(q, si)), { className: 'ol-iconbtn-sm', disabled })),
                nodes.map((node, ni) => nodeEl(node, si, ni, nodes)),
                button(i18n('Add node'), () => structure(q => addNode(q, si)), { iconName: 'plus', className: 'ol-btn-sm ol-btn-ghost', disabled }));
        };
        const library = presetIds.map(id => h('details', { class: 'ol-setup-node' },
            h('summary', null, h('span', { class: 'ol-setup-name', text: id }), h('span', { class: 'ol-spacer' }),
                iconButton('trash', i18n('Delete'), () => structure(q => removePresetEntry(q, id)), { className: 'ol-iconbtn-sm', disabled })),
            h('div', { class: 'ol-form' },
                formRow(i18n('Role prompt'), textArea(p.presets[id]?.systemPrompt, v => commitPreset(id, 'systemPrompt', v), { disabled })),
                formRow(i18n('Task template'), textArea(p.presets[id]?.userPromptTemplate, v => commitPreset(id, 'userPromptTemplate', v), { disabled })))));
        return [
            h('section', { class: 'ol-setup-section' }, sectionTitle(i18n('Workflow stages')), stages.map(stageEl),
                button(i18n('Add stage'), () => structure(addStage), { iconName: 'plus', className: 'ol-btn-sm', disabled })),
            h('section', { class: 'ol-setup-section' }, sectionTitle(i18n('Agent presets')), library,
                button(i18n('Add agent preset'), () => askId(id => structure(q => addPresetEntry(q, id))), { iconName: 'plus', className: 'ol-btn-sm', disabled })),
        ];
    }

    // A preset that no node uses has no agent field; a preset that one uses does.
    function commitPreset(id, key, value) {
        quiet = true;
        structure(q => ({ ...q, presets: { ...q.presets, [id]: { ...q.presets[id], [key]: value } } }));
        quiet = false;
    }

    async function askId(run) {
        const id = await app.promptText(i18n('New ID'), '');
        if (id) run(id);
    }

    // ----- Agenda / director / loop -----------------------------------------
    function agendaSection(t) {
        const p = profile();
        const ids = Object.keys(p.agents || {});
        const disabled = !editable();
        return [
            h('section', { class: 'ol-setup-section' }, sectionTitle(i18n('Agents')),
                formRow(i18n('Final agent'), selectInput(ids.map(id => ({ value: id, label: id })), p.finalAgentId, v => commit(PROFILE, 'finalAgentId', JSON.stringify(v)), { disabled })),
                ids.map(id => agentDetails(id, () => structure(q => removeAgendaAgent(q, id)), t, () => jsonOf(PROFILE, 'defaultTools'))),
                button(i18n('Add agent'), () => askId(id => structure(q => addAgendaAgent(q, id))), { iconName: 'plus', className: 'ol-btn-sm', disabled }),
                h('details', { class: 'ol-setup-node' }, h('summary', null, h('span', { class: 'ol-setup-name', text: i18n('Planner') })), agentExtras('agenda_planner', t, { tools: false }))),
            copyButton(t, i18n('Copy agents from spec')),
        ];
    }

    function directorSection(t) {
        const p = profile();
        const disabled = !editable();
        const inherit = () => jsonOf(PROFILE, 'tools');
        return h('section', { class: 'ol-setup-section' }, sectionTitle(i18n('Agents')),
            h('details', { class: 'ol-setup-node' }, h('summary', null, h('span', { class: 'ol-setup-name', text: i18n('Main agent') }), h('span', { class: 'ol-spacer' }),
                button(i18n('Reset to default'), async (event) => {
                    event.preventDefault();
                    if (await confirmDanger(i18n('Reset to default'), i18n('Reset main-agent system prompt to default? This overwrites the current text.'), i18n('Reset'))) {
                        app.drafts.set('main', 'system', app.source.edit.defaultMainPrompt(profile().subAgents || []));
                    }
                }, { className: 'ol-btn-sm ol-btn-ghost', disabled })),
            agentExtras('main', t, { inherit })),
            (p.subAgents || []).map(sub => agentDetails(sub.id, () => structure(q => removeSubAgent(q, sub.id)), t, inherit,
                formRow(i18n('Maximum tool-calling rounds'), textInput(app.drafts.get(sub.id, 'maxRounds'), v => commit(sub.id, 'maxRounds', v.trim() ? String(Math.max(1, Math.floor(Number(v)) || 1)) : ''), { type: 'number', disabled })))),
            button(i18n('Add sub-agent'), () => askId(id => structure(q => addSubAgent(q, id))), { iconName: 'plus', className: 'ol-btn-sm', disabled }));
    }

    function agentDetails(id, onRemove, t, inherit, extra = null) {
        return h('details', { class: 'ol-setup-node' },
            h('summary', null, h('span', { class: 'ol-setup-name', text: id }), h('span', { class: 'ol-spacer' }),
                iconButton('trash', i18n('Delete'), onRemove, { className: 'ol-iconbtn-sm', disabled: !editable() })),
            extra, agentExtras(id, t, { inherit }));
    }

    function loopSection(t) {
        const tools = jsonOf('loop_agent', 'tools') || {};
        return h('section', { class: 'ol-setup-section' }, sectionTitle(i18n('Agent tools')),
            toolGrid(tools, (id, on) => commit('loop_agent', 'tools', JSON.stringify(withToolFlag(jsonOf('loop_agent', 'tools'), id, on))), 'loop'));
    }

    function copyButton(t, label) {
        return h('section', { class: 'ol-setup-section' }, button(label, () => {
            try {
                const next = app.source.edit.convertFrom(t, profile());
                if (next) app.drafts.setProfile(next);
            } catch (err) { fail(err); }
        }, { className: 'ol-btn-sm', disabled: !editable() }));
    }

    function lorebookSection(t) {
        const slot = t.mode === 'spec' ? 'spec/lorebookFilter' : 'lorebookFilter';
        const value = jsonOf(PROFILE, slot) || {};
        const set = (key, text) => commit(PROFILE, slot, JSON.stringify({ ...(jsonOf(PROFILE, slot) || {}), [key]: text }));
        const disabled = !editable();
        return h('section', { class: 'ol-setup-section' }, sectionTitle(i18n('Lorebook filter')), h('div', { class: 'ol-form' },
            formRow(i18n('Book name pattern'), textInput(value.bookPattern, v => set('bookPattern', v), { disabled })),
            formRow(i18n('Entry name pattern'), textInput(value.entryPattern, v => set('entryPattern', v), { disabled }))));
    }

    // ----- Custom tools -----------------------------------------------------
    function customTools() {
        const base = app.drafts.base();
        const list = mode() === 'spec' ? base?.spec?.customTools : base?.customTools;
        return Array.isArray(list) ? list : [];
    }

    function customToolsSection(t) {
        if (t.scope === 'chat') return null;
        const editor = app.source.customToolEditor;
        const save = (tools) => action(() => app.source.presets.saveCustomTools(t, tools));
        const tools = customTools();
        const open = async (initial, index) => {
            const entry = await editor.open({ initial, nameInUse: name => tools.some((tool, i) => i !== index && tool.name === name) });
            if (!entry) return;
            const next = [...tools];
            if (index >= 0) next[index] = entry; else next.push(entry);
            await save(next);
        };
        const importDefaults = async () => {
            const names = new Set(tools.map(tool => String(tool?.name || '')));
            const collide = editor.defaults().map(tool => String(tool.name)).filter(name => names.has(name));
            const overwrite = collide.length > 0 && await confirmDanger(i18n('Import default custom tools'), i18nFormat('These default tools have the same name as tools already on this profile: ${0}. Overwrite them with the shipped defaults? Choose No to skip just those (your other defaults still import).', collide.join(', ')), i18n('Overwrite'));
            const draft = { customTools: tools.map(tool => ({ ...tool })) };
            editor.importDefaults(draft, { overwrite });
            await save(draft.customTools);
        };
        return h('section', { class: 'ol-setup-section' },
            sectionTitle(i18n('Custom tools'), h('span', { class: 'ol-insp-actions' },
                button(i18n('Add'), () => open(null, -1), { iconName: 'plus', className: 'ol-btn-sm ol-btn-ghost' }),
                button(i18n('Import default custom tools'), importDefaults, { className: 'ol-btn-sm ol-btn-ghost' }),
                button(i18n('SillyTavern tools'), async () => { await editor.bridge(); render(true); }, { className: 'ol-btn-sm ol-btn-ghost' }))),
            tools.map((tool, index) => h('div', { class: 'ol-setup-row' },
                h('span', { class: 'ol-setup-name', text: tool.name }), h('span', { class: 'ol-spacer' }),
                iconButton('pen', i18n('Edit'), () => open(tool, index), { className: 'ol-iconbtn-sm' }),
                iconButton('copy', i18n('Duplicate'), () => {
                    let name = `${tool.name}_copy`;
                    for (let n = 2; tools.some(item => item.name === name); n += 1) name = `${tool.name}_copy${n}`;
                    save([...tools, { ...tool, name }]);
                }, { className: 'ol-iconbtn-sm' }),
                iconButton('trash', i18n('Delete'), async () => {
                    if (await confirmDanger(i18n('Delete'), i18n('Remove this custom tool?'), i18n('Delete'))) save(tools.filter((_, i) => i !== index));
                }, { className: 'ol-iconbtn-sm' }))));
    }

    function render(force = false) {
        if (!force && isEditing(el)) return;
        const open = new Set([...el.querySelectorAll('details[open]')].map(node => node.querySelector('summary')?.textContent));
        clear(el);
        const t = target();
        if (!t) {
            put(el, emptyState('flow', i18n('Reading orchestration settings…')));
            return;
        }
        put(el, presetBar(t), t.mode === 'single' ? null : pinRow(t));
        if (t.mode === 'spec') put(el, specSection(t), copyButton(t, i18n('Copy agents from agenda')));
        if (t.mode === 'agenda') put(el, agendaSection(t));
        if (t.mode === 'director') put(el, directorSection(t));
        if (t.mode === 'loop') put(el, loopSection(t));
        if (t.mode !== 'single') {
            put(el, defaultToolsSection(t), customToolsSection(t), lorebookSection(t),
                h('section', { class: 'ol-setup-section' }, sectionTitle(i18n('Skills')), skillChips(PROFILE, modeSkillSlot(t.mode), t)));
        }
        el.querySelectorAll('details').forEach((node) => { if (open.has(node.querySelector('summary')?.textContent)) node.open = true; });
    }

    return {
        el,
        render: () => render(),
        onDraftChange() {
            if (!quiet) render(true);
        },
    };
}
