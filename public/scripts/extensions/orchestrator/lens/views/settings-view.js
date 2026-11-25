// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Orchestration settings that are not tied to one agent: default model,
// run limits, capsule injection and the iteration AI.

import { h, clear, put } from '../../../../lens-shared/util.js';
import { escapeHtml } from '../../../../lib/html-escape.js';
import { renderFieldHelpButtonElement } from '../../../../lib/field-help-button.js';
import { createBehaviorSummary } from '../../../../lens-shared/behavior-summary.js';
import { i18n } from '../i18n.js';
import { button, checkRow, sectionTitle, emptyState } from '../ui/components.js';
import { formRow, isEditing, selectInput, textArea, textInput } from './setup-view.js';
import { importPresetExample, openPresetDerivation, exampleNameForMode, PRESET_EXAMPLES } from '../../../../lens-shared/preset-examples.js';
import {
    buildOrchDefaultModelSummary,
    buildOrchRuntimeLimitsSummary,
    buildOrchCrossModeLimitsSummary,
    buildOrchCapsuleSummary,
} from '../model/behavior-summary-models.js';

const PROMPTS = [
    ['iterModePromptSpec', 'Spec mode iteration prompt', 'spec'],
    ['iterModePromptLoop', 'Loop mode iteration prompt', 'loop'],
    ['iterModePromptDirector', 'Director mode iteration prompt', 'director'],
    ['iterModePromptAgenda', 'Agenda mode iteration prompt', 'agenda'],
];

const intAtLeast = (min, fallback) => (value) => Math.max(min, Math.floor(Number(value) || fallback));
const PREVIEW_RULES = {
    nodeIterationMaxRounds: intAtLeast(1, 40),
    reviewRerunMaxRounds: intAtLeast(0, 0),
    maxRecentMessages: intAtLeast(1, 14),
    toolCallRetryMax: intAtLeast(0, 0),
    rpmLimit: intAtLeast(0, 0),
    capsuleInjectDepth: intAtLeast(0, 0),
};

function fieldWrap(key, control) {
    if (control instanceof Element) control.dataset.fieldKey = key;
    return control;
}

export function createSettingsView(app) {
    const el = h('div', { class: 'ol-setup' });
    let liveMode = 'spec';
    let liveValues = {};
    let liveProfile = {};
    let liveOptions = { connections: [], presets: [] };
    let livePositionLabels = null;
    let liveRoleLabels = null;
    let liveAtDepthValue = null;
    let liveDefaultCustomInstruction = '';

    const defaultModelSummary = createBehaviorSummary({
        id: 'orch-default-model',
        ariaLabel: i18n('Default model and world info summary'),
        build: () => buildOrchDefaultModelSummary({ mode: liveMode, values: liveValues, options: liveOptions }),
    });
    const runtimeLimitsSummary = createBehaviorSummary({
        id: 'orch-runtime-limits',
        ariaLabel: i18n('Runtime limits summary'),
        build: () => buildOrchRuntimeLimitsSummary({ mode: liveMode, profile: liveProfile, values: liveValues }),
    });
    const crossModeLimitsSummary = createBehaviorSummary({
        id: 'orch-cross-mode-limits',
        ariaLabel: i18n('Cross-mode limits summary'),
        build: () => buildOrchCrossModeLimitsSummary({ mode: liveMode, values: liveValues }),
    });
    const capsuleSummary = createBehaviorSummary({
        id: 'orch-capsule-injection',
        ariaLabel: i18n('Capsule injection summary'),
        build: () => buildOrchCapsuleSummary({
            values: liveValues,
            positionLabels: livePositionLabels,
            roleLabels: liveRoleLabels,
            atDepthValue: liveAtDepthValue,
            defaultCustomInstruction: liveDefaultCustomInstruction,
        }),
    });

    function applyLiveLimitPatch(patch) {
        if (liveMode === 'agenda') {
            liveProfile = { ...liveProfile, limits: { ...(liveProfile?.limits || {}), ...patch } };
        } else {
            liveProfile = { ...liveProfile, ...patch };
        }
    }

    const unsubDockPrefs = globalThis.Luker?.getContext?.()?.runPanel?.subscribeRunDockPrefs?.(() => {
        if (el.isConnected) render();
    }) || null;

    function render() {
        if (isEditing(el)) return;
        clear(el);
        const access = app.source.settings;
        const snapshot = app.snapshot();
        if (!access || !snapshot) {
            defaultModelSummary.bindScope(null);
            runtimeLimitsSummary.bindScope(null);
            crossModeLimitsSummary.bindScope(null);
            capsuleSummary.bindScope(null);
            put(el, emptyState('gear', i18n('Reading orchestration settings…')));
            return;
        }
        const values = access.values();
        const opts = app.modelOptions();
        const defaults = access.promptDefaults();
        const profile = snapshot.profile || {};
        const target = snapshot.target;

        const P = Luker.getContext().constants.wiPosition;
        const positions = [[P.before, 'Before Character Definitions'], [P.after, 'After Character Definitions'], [P.ANTop, 'Before Author\'s Note'], [P.ANBottom, 'After Author\'s Note'], [P.EMTop, 'Before Example Messages'], [P.EMBottom, 'After Example Messages'], [P.atDepth, 'At Chat Depth']].map(([value, label]) => ({ value: String(value), label: i18n(label) }));
        const roleOptions = [{ value: '0', label: i18n('System') }, { value: '1', label: i18n('User') }, { value: '2', label: i18n('Assistant') }];
        const atDepth = Number(values.capsuleInjectPosition) === Number(P.atDepth);

        liveMode = snapshot.mode;
        liveValues = { ...values };
        liveProfile = JSON.parse(JSON.stringify(profile));
        liveOptions = opts || { connections: [], presets: [] };
        livePositionLabels = Object.fromEntries(positions.map(p => [p.value, p.label]));
        liveRoleLabels = Object.fromEntries(roleOptions.map(r => [r.value, r.label]));
        liveAtDepthValue = String(P.atDepth);
        liveDefaultCustomInstruction = String(defaults?.capsuleCustomInstruction || '');

        const set = (key, summary = null) => (value) => {
            const preview = PREVIEW_RULES[key] ? PREVIEW_RULES[key](value) : value;
            liveValues[key] = preview;
            access.set(key, value);
            summary?.update();
        };
        const options = (names, value) => [{ value: '', label: i18n('Current') }, ...[...new Set([...names, value].filter(Boolean))].map(name => ({ value: name, label: name }))];
        const number = (label, key, summary = null) => fieldWrap(key, formRow(i18n(label), textInput(values[key], set(key, summary), {
            type: 'number',
            onInput: summary
                ? (value) => {
                    liveValues[key] = PREVIEW_RULES[key] ? PREVIEW_RULES[key](value) : value;
                    summary.update();
                }
                : null,
        })));
        const section = (title, ...children) => h('section', { class: 'ol-setup-section' }, sectionTitle(i18n(title)), h('div', { class: 'ol-form' }, children));
        const summarizedSection = (title, summary, ...children) => h('section', { class: 'ol-setup-section' }, sectionTitle(i18n(title)), summary.el, h('div', { class: 'ol-form' }, children));
        const reset = (key, text, summary = null) => button(i18n('Reset to default'), () => {
            liveValues[key] = text;
            access.set(key, text);
            summary?.update();
            render();
        }, { className: 'ol-btn-sm ol-btn-ghost' });

        const presetActions = ({ key, name, deriveMode }) => {
            const installed = opts.presets.includes(name);
            return h('div', { class: 'ol-preset-actions' },
                button(installed ? i18n('Re-import example') : i18n('Import example'), async () => {
                    try {
                        const ok = await importPresetExample(name);
                        if (!ok) return;
                        access.set(key, name);
                        await app.reloadModelOptions();
                        render();
                    } catch (err) {
                        app.notify(String(err?.message || err), { error: true });
                    }
                }, { className: 'ol-btn-sm ol-btn-ghost' }),
                button(i18n('Derive from an existing preset'), async () => {
                    try {
                        await openPresetDerivation(deriveMode);
                    } catch (err) {
                        app.notify(String(err?.message || err), { error: true });
                    }
                }, { className: 'ol-btn-sm ol-btn-ghost' }));
        };

        const limit = (label, key, value, toPatch) => fieldWrap(key, formRow(i18n(label), textInput(
            value,
            (v) => {
                const patch = toPatch(Math.max(1, Math.floor(Number(v)) || 1));
                applyLiveLimitPatch(patch);
                runtimeLimitsSummary.update();
                app.guard(() => access.setLimit(target, patch));
            },
            {
                type: 'number',
                disabled: target?.scope === 'chat',
                onInput: (v) => {
                    const patch = toPatch(Math.max(1, Math.floor(Number(v)) || 1));
                    applyLiveLimitPatch(patch);
                    runtimeLimitsSummary.update();
                },
            },
        )));
        const limits = [];
        if (snapshot.mode === 'director') {
            limits.push(
                limit('Maximum tool-calling rounds', 'maxRounds', profile.maxRounds, n => ({ maxRounds: n })),
                limit('Maximum concurrent sub-agents', 'maxConcurrentSubagents', profile.maxConcurrentSubagents, n => ({ maxConcurrentSubagents: n })),
                limit('Maximum total sub-agent runs per turn', 'maxTotalSubagentRuns', profile.maxTotalSubagentRuns, n => ({ maxTotalSubagentRuns: n })),
                fieldWrap('discardOnAbort', checkRow({
                    checked: Boolean(profile.discardOnAbort),
                    label: i18n('Discard partial message on abort'),
                    onChange: on => {
                        applyLiveLimitPatch({ discardOnAbort: on });
                        runtimeLimitsSummary.update();
                        app.guard(() => access.setLimit(target, { discardOnAbort: on }));
                    },
                })));
        } else if (snapshot.mode === 'agenda') {
            limits.push(
                limit('Planner max rounds', 'plannerMaxRounds', profile.limits?.plannerMaxRounds, n => ({ plannerMaxRounds: n })),
                limit('Max concurrent agents', 'maxConcurrentAgents', profile.limits?.maxConcurrentAgents, n => ({ maxConcurrentAgents: n })),
                limit('Max total agent runs', 'maxTotalRuns', profile.limits?.maxTotalRuns, n => ({ maxTotalRuns: n })));
        } else if (snapshot.mode === 'loop') {
            limits.push(
                limit('Loop max rounds', 'max_rounds', profile.max_rounds, n => ({ max_rounds: n })),
                limit('Loop wall-clock budget (seconds)', 'wall_clock_budget_ms', Math.round(Number(profile.wall_clock_budget_ms || 300000) / 1000), n => ({ wall_clock_budget_ms: Math.max(10, n) * 1000 })));
        } else {
            limits.push(
                number('Node tool iteration max rounds', 'nodeIterationMaxRounds', runtimeLimitsSummary),
                number('Review rerun max rounds', 'reviewRerunMaxRounds', runtimeLimitsSummary));
        }

        const injectionPosition = () => {
            const row = fieldWrap('capsuleInjectPosition', formRow(i18n('Injection position'), selectInput(positions, String(values.capsuleInjectPosition), (value) => {
                liveValues.capsuleInjectPosition = value;
                access.set('capsuleInjectPosition', value);
                capsuleSummary.update();
                render();
            })));
            put(row.firstElementChild, renderFieldHelpButtonElement({
                title: i18n('About injection position'),
                bodyHtml: escapeHtml(i18n('Injection position help body')),
            }));
            return row;
        };
        const runPanelApi = Luker.getContext()?.runPanel;
        const dockPrefs = runPanelApi?.getRunDockPrefs?.() || { autoOpen: true, defaultSize: 'small' };

        const defaultModelSec = summarizedSection('Default API and prompt preset', defaultModelSummary,
            fieldWrap('llmNodeApiPresetName', formRow(i18n('Connection profile'), selectInput(options(opts.connections, values.llmNodeApiPresetName), values.llmNodeApiPresetName, set('llmNodeApiPresetName', defaultModelSummary)))),
            fieldWrap('llmNodePresetName', formRow(i18n('Generation preset'), selectInput(options(opts.presets, values.llmNodePresetName), values.llmNodePresetName, set('llmNodePresetName', defaultModelSummary)))),
            presetActions({ key: 'llmNodePresetName', name: exampleNameForMode(snapshot.mode), deriveMode: 'orchestrator-optimize' }),
            fieldWrap('includeWorldInfoWithPreset', checkRow({ checked: values.includeWorldInfoWithPreset, label: i18n('Include world info in agent prompts'), onChange: set('includeWorldInfoWithPreset', defaultModelSummary) })));

        const runPanelSec = section('Run panel',
            checkRow({ checked: dockPrefs.autoOpen !== false, label: i18n('Open automatically on run'), onChange: (on) => { runPanelApi?.setRunDockPrefs?.({ autoOpen: Boolean(on) }); render(); } }),
            formRow(i18n('Run panel default size'), selectInput([{ value: 'small', label: i18n('Small window') }, { value: 'large', label: i18n('Large window') }], dockPrefs.defaultSize === 'large' ? 'large' : 'small', (val) => { runPanelApi?.setRunDockPrefs?.({ defaultSize: val === 'large' ? 'large' : 'small' }); render(); })));

        const runtimeLimitsSec = summarizedSection('Runtime limits', runtimeLimitsSummary, ...limits);

        const crossModeSec = summarizedSection('Cross-mode limits', crossModeLimitsSummary,
            number('Recent assistant turns for orchestration', 'maxRecentMessages', crossModeLimitsSummary),
            number('Tool-call retries on invalid/missing tool call', 'toolCallRetryMax', crossModeLimitsSummary),
            number('RPM limit (0 = unlimited)', 'rpmLimit', crossModeLimitsSummary));

        const capsuleSec = snapshot.mode === 'director' ? null : summarizedSection('Capsule injection', capsuleSummary,
            injectionPosition(),
            atDepth ? number('Injection depth', 'capsuleInjectDepth', capsuleSummary) : null,
            atDepth ? fieldWrap('capsuleInjectRole', formRow(i18n('Injection role'), selectInput(roleOptions, String(values.capsuleInjectRole), set('capsuleInjectRole', capsuleSummary)))) : null,
            fieldWrap('capsuleCustomInstruction', formRow(i18n('Custom instruction'), textArea(values.capsuleCustomInstruction, set('capsuleCustomInstruction', capsuleSummary), {
                onInput: (value) => {
                    liveValues.capsuleCustomInstruction = value;
                    capsuleSummary.update();
                },
            }))),
            reset('capsuleCustomInstruction', defaults.capsuleCustomInstruction, capsuleSummary));

        put(el,
            h('p', { class: 'ol-setup-note', text: i18n('The AI Workbench uses to edit these settings is selected in Workbench → Settings.') }),
            defaultModelSec,
            runPanelSec,
            runtimeLimitsSec,
            crossModeSec,
            capsuleSec,
            app.source.editLastResult ? section('Latest Orchestration Result',
                button(i18n('Edit latest orchestration result text.'), async () => { if (await app.source.editLastResult()) await app.reload(); }, { iconName: 'pen' })) : null,
            section('AI Iteration Studio configuration',
                formRow(i18n('Connection profile'), selectInput(options(opts.connections, values.requestApiPresetName), values.requestApiPresetName, set('requestApiPresetName'))),
                formRow(i18n('Generation preset'), selectInput(options(opts.presets, values.requestLlmPresetName), values.requestLlmPresetName, set('requestLlmPresetName'))),
                presetActions({ key: 'requestLlmPresetName', name: PRESET_EXAMPLES.pluginOnly, deriveMode: 'jailbreak-only' }),
                formRow(i18n('Iteration AI base system prompt'), textArea(values.requestSystemPrompt, set('requestSystemPrompt'), { rows: 6 })),
                reset('requestSystemPrompt', defaults.request),
                PROMPTS.map(([key, label, id]) => [formRow(i18n(label), textArea(values[key], set(key), { rows: 6 })), reset(key, defaults[id])])));

        defaultModelSummary.bindScope(defaultModelSec);
        defaultModelSummary.update();
        runtimeLimitsSummary.bindScope(runtimeLimitsSec);
        runtimeLimitsSummary.update();
        crossModeLimitsSummary.bindScope(crossModeSec);
        crossModeLimitsSummary.update();
        capsuleSummary.bindScope(capsuleSec);
        if (capsuleSec) capsuleSummary.update();
    }

    return {
        el,
        render,
        destroy() {
            unsubDockPrefs?.();
            defaultModelSummary.destroy();
            runtimeLimitsSummary.destroy();
            crossModeLimitsSummary.destroy();
            capsuleSummary.destroy();
        },
    };
}
