// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Orchestration settings that are not tied to one agent: default model,
// run limits, capsule injection and the iteration AI.

import { h, clear, put } from '../../../lens-shared/util.js';
import { i18n } from '../i18n.js';
import { button, checkRow, sectionTitle, emptyState } from '../ui/components.js';
import { formRow, isEditing, selectInput, textArea, textInput } from './setup-view.js';

const PROMPTS = [
    ['iterModePromptSpec', 'Spec mode iteration prompt', 'spec'],
    ['iterModePromptLoop', 'Loop mode iteration prompt', 'loop'],
    ['iterModePromptDirector', 'Director mode iteration prompt', 'director'],
    ['iterModePromptAgenda', 'Agenda mode iteration prompt', 'agenda'],
];

export function createSettingsView(app) {
    const el = h('div', { class: 'ol-setup' });

    function render() {
        if (isEditing(el)) return;
        clear(el);
        const access = app.source.settings;
        const snapshot = app.snapshot();
        if (!access || !snapshot) {
            put(el, emptyState('gear', i18n('Reading orchestration settings…')));
            return;
        }
        const values = access.values();
        const set = (key) => (value) => access.set(key, value);
        const opts = app.modelOptions();
        const options = (names, value) => [{ value: '', label: i18n('Current') }, ...[...new Set([...names, value].filter(Boolean))].map(name => ({ value: name, label: name }))];
        const number = (label, key) => formRow(i18n(label), textInput(values[key], set(key), { type: 'number' }));
        const section = (title, ...children) => h('section', { class: 'ol-setup-section' }, sectionTitle(i18n(title)), h('div', { class: 'ol-form' }, children));
        const reset = (key, text) => button(i18n('Reset to default'), () => { access.set(key, text); render(); }, { className: 'ol-btn-sm ol-btn-ghost' });
        const defaults = access.promptDefaults();

        const profile = snapshot.profile || {};
        const target = snapshot.target;
        const limit = (label, value, toPatch) => formRow(i18n(label), textInput(value, v => app.guard(() => access.setLimit(target, toPatch(Math.max(1, Math.floor(Number(v)) || 1)))), { type: 'number', disabled: target?.scope === 'chat' }));
        const limits = [];
        if (snapshot.mode === 'director') {
            limits.push(
                limit('Maximum tool-calling rounds', profile.maxRounds, n => ({ maxRounds: n })),
                limit('Maximum concurrent sub-agents', profile.maxConcurrentSubagents, n => ({ maxConcurrentSubagents: n })),
                limit('Maximum total sub-agent runs per turn', profile.maxTotalSubagentRuns, n => ({ maxTotalSubagentRuns: n })),
                checkRow({ checked: Boolean(profile.discardOnAbort), label: i18n('Discard partial message on abort'), onChange: on => app.guard(() => access.setLimit(target, { discardOnAbort: on })) }));
        } else if (snapshot.mode === 'agenda') {
            limits.push(
                limit('Planner max rounds', profile.limits?.plannerMaxRounds, n => ({ plannerMaxRounds: n })),
                limit('Max concurrent agents', profile.limits?.maxConcurrentAgents, n => ({ maxConcurrentAgents: n })),
                limit('Max total agent runs', profile.limits?.maxTotalRuns, n => ({ maxTotalRuns: n })));
        } else if (snapshot.mode === 'loop') {
            limits.push(
                limit('Loop max rounds', profile.max_rounds, n => ({ max_rounds: n })),
                limit('Loop wall-clock budget (seconds)', Math.round(Number(profile.wall_clock_budget_ms || 300000) / 1000), n => ({ wall_clock_budget_ms: Math.max(10, n) * 1000 })));
        } else {
            limits.push(number('Node tool iteration max rounds', 'nodeIterationMaxRounds'), number('Review rerun max rounds', 'reviewRerunMaxRounds'));
        }

        const P = Luker.getContext().constants.wiPosition;
        const positions = [[P.before, 'Before Character Definitions'], [P.after, 'After Character Definitions'], [P.ANTop, 'Before Author\'s Note'], [P.ANBottom, 'After Author\'s Note'], [P.EMTop, 'Before Example Messages'], [P.EMBottom, 'After Example Messages'], [P.atDepth, 'At Chat Depth']].map(([value, label]) => ({ value: String(value), label: i18n(label) }));
        const atDepth = Number(values.capsuleInjectPosition) === Number(P.atDepth);

        put(el,
            section('Default API and prompt preset',
                formRow(i18n('Connection profile'), selectInput(options(opts.connections, values.llmNodeApiPresetName), values.llmNodeApiPresetName, set('llmNodeApiPresetName'))),
                formRow(i18n('Generation preset'), selectInput(options(opts.presets, values.llmNodePresetName), values.llmNodePresetName, set('llmNodePresetName'))),
                checkRow({ checked: values.includeWorldInfoWithPreset, label: i18n('Include world info in agent prompts'), onChange: set('includeWorldInfoWithPreset') })),
            section('Runtime limits', ...limits),
            section('Cross-mode limits',
                number('Recent assistant turns for orchestration', 'maxRecentMessages'),
                number('Tool-call retries on invalid/missing tool call', 'toolCallRetryMax'),
                number('RPM limit (0 = unlimited)', 'rpmLimit')),
            snapshot.mode === 'director' ? null : section('Capsule injection',
                formRow(i18n('Injection position'), selectInput(positions, String(values.capsuleInjectPosition), (value) => { access.set('capsuleInjectPosition', value); render(); })),
                atDepth ? number('Injection depth', 'capsuleInjectDepth') : null,
                atDepth ? formRow(i18n('Injection role'), selectInput([{ value: '0', label: i18n('System') }, { value: '1', label: i18n('User') }, { value: '2', label: i18n('Assistant') }], String(values.capsuleInjectRole), set('capsuleInjectRole'))) : null,
                formRow(i18n('Custom instruction'), textArea(values.capsuleCustomInstruction, set('capsuleCustomInstruction')))),
            section('AI Iteration Studio configuration',
                formRow(i18n('Connection profile'), selectInput(options(opts.connections, values.requestApiPresetName), values.requestApiPresetName, set('requestApiPresetName'))),
                formRow(i18n('Generation preset'), selectInput(options(opts.presets, values.requestLlmPresetName), values.requestLlmPresetName, set('requestLlmPresetName'))),
                formRow(i18n('Iteration AI base system prompt'), textArea(values.requestSystemPrompt, set('requestSystemPrompt'), { rows: 6 })),
                reset('requestSystemPrompt', defaults.request),
                PROMPTS.map(([key, label, id]) => [formRow(i18n(label), textArea(values[key], set(key), { rows: 6 })), reset(key, defaults[id])])));
    }

    return { el, render };
}
