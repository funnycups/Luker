// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings page: everything memory-graph can be configured with, plus the
// operations on the current chat's graph.

import { h, clear, put } from '../../../lens-shared/util.js';
import { i18n, i18nFormat } from '../i18n.js';
import { button, checkRow, segmented, switchControl } from '../ui/components.js';
import { confirmText, formField, openModal, selectInput } from '../panels/modal.js';
import { ADVANCED_FIELDS, withMissing } from './settings-model.js';

const TABS = [['recall', 'Recall'], ['extract', 'Extract'], ['graph', 'Graph'], ['advanced', 'Advanced']];
const REPAINT_KEYS = new Set(['recallMethod', 'ragUseRerank', 'ragUseQueryRewrite', 'recallInjectPosition']);

export function createSettingsView(app, source) {
    const el = h('div', { class: 'ml-settings' });
    let view = null;
    let tab = 'recall';
    let needsReload = true;
    let advanced = null;
    let advancedDirty = false;
    let busy = false;
    let debugQuery = '';
    const statusEl = h('div', { class: 'ml-settings-status', role: 'status' });
    const unsubscribe = source.ops?.onStatus?.((text) => { statusEl.textContent = text; }) || (() => {});

    function reload() {
        try {
            view = source.settings.read();
            advanced = structuredClone(view.advanced.values);
            advancedDirty = false;
            needsReload = false;
            paint();
        } catch (err) {
            clear(el);
            put(el, h('div', { class: 'ml-settings-status', text: String(err?.message || err) }));
        }
    }

    function setValue(key, value) {
        view.values[key] = source.settings.set(key, value);
        if (REPAINT_KEYS.has(key)) paint();
    }

    const toggle = (key, label) => switchControl(label, view.values[key], (value) => { setValue(key, value); paint(); });
    const pick = (key, label, options) => formField(label, selectInput(options, view.values[key], (value) => setValue(key, value)));
    const number = (key, label, min, max) => formField(label, h('input', {
        class: 'ml-schema-input', type: 'number', min, max, step: 1, value: String(view.values[key] ?? ''),
        onChange: (event) => { event.target.value = String(setValue2(key, event.target.value)); },
    }));
    const setValue2 = (key, value) => (setValue(key, value), view.values[key]);

    const connectionOptions = (key) => withMissing(view.options.connections, view.values[key], i18n('(Current API config)'), i18n('(missing)'));
    const presetOptions = (key) => withMissing(view.options.presets, view.values[key], i18n('(Current preset)'), i18n('(missing)'));
    const profileOptions = (list) => [{ value: '', label: i18n('(unset)') }, ...list.map(profile => ({ value: profile.id, label: profile.name }))];
    const group = (...children) => h('section', { class: 'ml-aiset-group' }, children);
    const fields = (...children) => h('div', { class: 'ml-aiset-fields' }, children);

    function recallTab() {
        const { values, options } = view;
        const rag = values.recallMethod === 'rag';
        const atDepth = Number(values.recallInjectPosition) === Number(options.positions.atDepth);
        const p = options.positions;
        return [
            group(
                pick('recallMethod', i18n('Recall method'), [
                    { value: 'llm', label: i18n('LLM Recall (default)') },
                    { value: 'rag', label: i18n('RAG Recall (vector + optional rerank + optional rewrite)') },
                ]),
                rag ? fields(
                    pick('embeddingProfileId', i18n('Embedding profile'), profileOptions(options.embeddingProfiles)),
                    number('vectorTopK', i18n('Vector pre-filter Top-K'), 5, 100),
                    number('hybridMaxResults', i18n('Max recall results'), 3, 50),
                    number('ragDefaultPerTypeK', i18n('Default per-type quota'), 0, 50)) : null,
                rag ? toggle('ragUseRerank', i18n('Enable rerank')) : null,
                rag && values.ragUseRerank ? pick('rerankProfileId', i18n('Rerank profile'), profileOptions(options.rerankProfiles)) : null,
                rag ? toggle('ragUseQueryRewrite', i18n('Enable query rewrite (extra LLM call)')) : null,
                rag && values.ragUseQueryRewrite ? fields(
                    pick('ragRewriteApiPresetName', i18n('Query rewrite API preset (Connection profile)'), connectionOptions('ragRewriteApiPresetName')),
                    pick('ragRewriteLlmPresetName', i18n('Query rewrite prompt preset'), presetOptions('ragRewriteLlmPresetName'))) : null,
                !rag ? fields(
                    pick('recallApiPresetName', i18n('Recall API preset (Connection profile)'), connectionOptions('recallApiPresetName')),
                    pick('recallPresetName', i18n('Recall preset (params + prompt)'), presetOptions('recallPresetName'))) : null),
            group(
                pick('recallInjectPosition', i18n('Injection position'), [
                    [p.before, 'Before Character Definitions'], [p.after, 'After Character Definitions'],
                    [p.ANTop, 'Before Author\'s Note'], [p.ANBottom, 'After Author\'s Note'],
                    [p.EMTop, 'Before Example Messages'], [p.EMBottom, 'After Example Messages'],
                    [p.atDepth, 'At Chat Depth'],
                ].map(([value, label]) => ({ value: String(value), label: i18n(label) }))),
                atDepth ? fields(
                    number('recallInjectDepth', i18n('Injection depth'), 0, 10000),
                    pick('recallInjectRole', i18n('Injection role'), [
                        [options.roles.SYSTEM, 'System'], [options.roles.USER, 'User'], [options.roles.ASSISTANT, 'Assistant'],
                    ].map(([value, label]) => ({ value: String(value), label: i18n(label) })))) : null),
            group(
                formField(i18n('Recall debug query'), h('input', { class: 'ml-schema-input', type: 'text', value: debugQuery, onInput: (event) => { debugQuery = event.target.value; } })),
                h('div', { class: 'ml-settings-actions' },
                    button(i18n('Run Recall Debug'), () => run(async () => {
                        const result = await source.ops.recallDebug(debugQuery);
                        if (result) {
                            app.openStatus(i18n('Run Recall Debug'), [
                                { title: i18nFormat('Recall ready. selected=${0}', result.selectedNodes.length), text: result.selectedNodes.map(node => `${node.id}  ${node.title || ''}`).join('\n') },
                                { title: i18n('Trace'), text: JSON.stringify(result.trace, null, 2) },
                            ]);
                        }
                    }), { disabled: busy }),
                    button(i18n('View Last Injection'), () => app.showInjection(), { className: 'ml-btn-ghost' }))),
        ];
    }

    function extractTab() {
        return [group(fields(
            pick('extractApiPresetName', i18n('Extract API preset (Connection profile)'), connectionOptions('extractApiPresetName')),
            pick('extractPresetName', i18n('Extract preset (params + prompt)'), presetOptions('extractPresetName')),
            number('updateEvery', i18n('Update every N assistant turns'), 1)))];
    }

    async function run(task) {
        if (busy) return;
        busy = true;
        paint();
        try {
            await task();
        } catch (err) {
            statusEl.textContent = String(err?.message || err);
        } finally {
            busy = false;
            paint();
            app.refresh();
        }
    }

    const openStudio = (open) => { Promise.resolve().then(open).catch((err) => { statusEl.textContent = String(err?.message || err); }).finally(() => app.refresh()); };

    const action = (label, task, options = {}) => button(label, task, { disabled: busy, className: 'ml-btn-ghost', ...options });

    function askRebuildRecent() {
        const latest = source.ops.latestSeq();
        if (latest <= 0) { statusEl.textContent = i18n('No assistant turns available to rebuild.'); return; }
        const input = h('input', { class: 'ml-schema-input', type: 'number', min: 1, max: latest, step: 1, value: String(Math.min(20, latest)) });
        openModal(app, {
            title: i18n('Rebuild Recent'),
            content: formField(i18nFormat('Rebuild recent assistant turns: enter N (1-${0}).', latest), input),
            okLabel: i18n('Rebuild Recent'),
            wide: false,
            onOk() {
                const turns = Number(input.value);
                if (!Number.isInteger(turns) || turns < 1 || turns > latest) {
                    app.notify(i18nFormat('Please enter a valid integer between 1 and ${0}.', latest));
                    return false;
                }
                void run(() => source.ops.rebuildRecent(turns));
                return true;
            },
        });
    }

    function askCompress() {
        const types = view.options.compressibleTypes;
        if (!types.length) { statusEl.textContent = i18n('No compressible types in current schema.'); return; }
        const scope = selectInput([{ value: 'all', label: i18n('All nodes') }, { value: 'older', label: i18n('Older nodes only (exclude recent N assistant turns)') }], 'older');
        const excludeRecent = h('input', { class: 'ml-schema-input', type: 'number', min: 0, step: 1, value: String(Math.max(0, Number(advanced.recentRawTurns || 0))) });
        const mode = selectInput([
            { value: 'schema', label: i18n('Use schema thresholds') },
            { value: 'force', label: i18n('Force compress (ignore threshold)') },
            { value: 'flat', label: i18n('Force compress across depths (ignore hierarchy)') },
        ], 'schema');
        const rounds = h('input', { class: 'ml-schema-input', type: 'number', min: 1, step: 1, value: '3' });
        const selected = new Set(types.map(item => item.id));
        openModal(app, {
            title: i18n('Manual Compression'),
            content: h('div', { class: 'ml-aiset' },
                formField(i18n('Compression scope'), scope),
                formField(i18n('Exclude recent assistant turns'), excludeRecent),
                formField(i18n('Compression mode'), mode),
                formField(i18n('Max rounds per type'), rounds),
                h('div', { class: 'ml-aiset-field' }, h('span', { class: 'ml-aiset-label', text: i18n('Types to compress') }),
                    types.map(item => checkRow({ checked: true, label: item.label, onChange: (value) => { if (value) selected.add(item.id); else selected.delete(item.id); } })))),
            okLabel: i18n('Apply Manual Compression'),
            onOk() {
                void run(() => source.ops.compress({
                    scope: scope.value,
                    mode: mode.value,
                    excludeRecent: Math.max(0, Math.floor(Number(excludeRecent.value) || 0)),
                    maxRoundsPerType: Math.max(1, Math.floor(Number(rounds.value) || 1)),
                    selectedTypeIds: [...selected],
                }));
                return true;
            },
        });
    }

    function askRawEdit() {
        void source.ops.readRawEdit().then((base) => {
            const area = h('textarea', { class: 'ml-schema-input ml-settings-json', rows: 22, text: base.text });
            const error = h('div', { role: 'alert' });
            let applying = false;
            openModal(app, {
                title: i18n('Edit graph JSON'),
                content: h('div', null, area, error),
                okLabel: i18n('Apply Graph'),
                async onOk() {
                    if (applying) return false;
                    applying = true;
                    try {
                        const saved = await source.ops.applyRawJson(area.value.trim(), base);
                        if (saved) app.refresh();
                        return saved;
                    } catch (err) {
                        error.textContent = String(err?.message || err);
                        return false;
                    } finally {
                        applying = false;
                    }
                },
            });
        }).catch((err) => { statusEl.textContent = String(err?.message || err); });
    }

    function statsLine() {
        try {
            const stats = source.ops.stats();
            return i18nFormat('nodes=${0}, edges=${1}, messages=${2}, source=${3}, semantic=${4}', stats.nodeCount, stats.edgeCount, stats.messageCount, stats.sourceMessageCount, stats.levelCount.semantic);
        } catch {
            return '';
        }
    }

    function graphTab() {
        const ops = source.ops;
        const actions = (...children) => h('div', { class: 'ml-settings-actions' }, children);
        return [
            group(
                h('div', { class: 'ml-settings-stats', text: statsLine() })),
            group(actions(
                action(i18n('Fill Graph'), () => run(ops.fill)),
                action(i18n('Rebuild Graph'), () => confirmText(app, { title: i18n('Rebuild Graph'), lines: [i18n('Rebuild the whole graph from this chat?')], okLabel: i18n('Rebuild Graph'), danger: true, onOk: () => { void run(ops.rebuild); } })),
                action(i18n('Rebuild Recent'), askRebuildRecent),
                action(i18n('Manual Compress'), askCompress),
                action(i18n('Fill Missing'), () => run(() => ops.vectors('incremental'))),
                action(i18n('Full Rebuild'), () => run(() => ops.vectors('full'))))),
            group(actions(
                action(i18n('Export Graph'), () => run(ops.exportGraph)),
                action(i18n('Import Graph'), () => run(ops.importGraph)),
                action(i18n('View graph JSON'), () => { void ops.rawJson().then(text => app.openStatus(i18n('View graph JSON'), [{ title: i18n('Graph'), text }])); }),
                action(i18n('Edit graph JSON'), askRawEdit),
                action(i18n('Reset Chat'), () => confirmText(app, { title: i18n('Reset Chat'), lines: [i18n('Reset current chat memory graph? This cannot be undone.')], okLabel: i18n('Reset'), danger: true, onOk: () => { void run(ops.reset); } }), { className: 'ml-btn-danger' }))),
            group(actions(
                button(i18n('AI Configure Memory Graph'), () => openStudio(ops.openConfigStudio), { iconName: 'sparkle', disabled: busy }),
                button(i18n('AI Edit Graph'), () => openStudio(ops.openGraphStudio), { iconName: 'sparkle', disabled: busy }))),
        ];
    }

    function advancedControl(field) {
        const label = i18n(field.label);
        const dirty = () => { advancedDirty = true; };
        if (field.kind === 'bool') return checkRow({ checked: advanced[field.key], label, onChange: (value) => { advanced[field.key] = value; dirty(); } });
        if (field.kind === 'select') {
            return formField(label, selectInput(field.options.map(([value, text]) => ({ value, label: i18n(text) })), advanced[field.key], (value) => { advanced[field.key] = value; dirty(); }));
        }
        if (field.kind === 'text') {
            return formField(label, h('textarea', { class: 'ml-schema-input', rows: 8, text: String(advanced[field.key] ?? ''), onInput: (event) => { advanced[field.key] = event.target.value; dirty(); } }));
        }
        return formField(label, h('input', {
            class: 'ml-schema-input', type: 'number', min: field.min, max: field.max, step: 1, value: String(advanced[field.key] ?? ''),
            onInput: (event) => { advanced[field.key] = Number(event.target.value); dirty(); },
        }));
    }

    async function saveAdvanced(work, doneText) {
        try {
            await work();
            app.notify(doneText);
            reload();
        } catch (err) {
            app.showToast(String(err?.message || err), { error: true });
        }
    }

    function advancedTab() {
        const info = view.advanced;
        const visible = ADVANCED_FIELDS.filter(field => !field.when || field.when(view.values));
        const scopeText = info.hasOverride ? i18nFormat('Character override: ${0}', info.characterName || '') : i18n('Global');
        return [
            group(fields(
                pick('requestApiPresetName', i18n('Iteration AI API preset (Connection profile)'), connectionOptions('requestApiPresetName')),
                pick('requestLlmPresetName', i18n('Iteration AI prompt preset (params + prompt)'), presetOptions('requestLlmPresetName')))),
            group(
                fields(...visible.filter(field => field.kind === 'int' || field.kind === 'select').map(advancedControl)),
                visible.filter(field => field.kind === 'bool').map(advancedControl),
                visible.filter(field => field.kind === 'text').map(advancedControl)),
            h('div', { class: 'ml-settings-actions ml-settings-sticky' },
                h('span', { class: 'ml-settings-stats', text: scopeText }),
                button(i18n('Reset Advanced Settings'), () => confirmText(app, {
                    title: i18n('Reset Advanced Settings'),
                    lines: [i18n('Reset advanced settings editor to default? This will overwrite current unsaved advanced edits.')],
                    okLabel: i18n('Reset'),
                    danger: true,
                    onOk: () => { advanced = structuredClone(info.defaults); advancedDirty = true; paint(); },
                }), { className: 'ml-btn-ghost' }),
                button(i18n('Clear Character Advanced Override'), () => saveAdvanced(() => source.settings.clearAdvanced(info.avatar), i18n('Cleared')), { className: 'ml-btn-ghost', disabled: !info.hasOverride }),
                button(i18n('Save Advanced to Character'), () => saveAdvanced(() => source.settings.saveAdvanced(advanced, 'character', info.avatar), i18n('Saved')), { disabled: !info.hasAvatar }),
                button(i18n('Save Advanced to Global'), () => saveAdvanced(() => source.settings.saveAdvanced(advanced, 'global'), i18n('Saved')), { className: 'ml-btn-primary' })),
        ];
    }

    function paint() {
        const scroll = el.scrollTop;
        statusEl.textContent = source.ops.status();
        clear(el);
        const body = { recall: recallTab, extract: extractTab, graph: graphTab, advanced: advancedTab }[tab]();
        put(el, h('div', { class: 'ml-settings-inner' },
            group(
                toggle('enabled', i18n('Enabled')),
                toggle('autoExtractionEnabled', i18n('Auto extraction')),
                toggle('autoCompressionEnabled', i18n('Auto compression')),
                toggle('recallEnabled', i18n('Enable recall injection')),
                statusEl,
                busy ? button(i18n('Stop'), () => source.ops.stop(), { iconName: 'x', className: 'ml-btn-danger' }) : null),
            segmented(TABS.map(([value, label]) => ({ value, label: i18n(label) })), tab, (value) => { tab = value; paint(); }, { ariaLabel: i18n('Settings') }),
            body));
        el.scrollTop = scroll;
    }

    const editingHere = () => el.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

    return {
        id: 'settings',
        el,
        render() {
            if (!view || (needsReload && !advancedDirty && !editingHere() && !busy)) reload();
        },
        invalidate() { needsReload = true; },
        destroy() { unsubscribe(); },
    };
}
