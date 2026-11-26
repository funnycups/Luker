// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings page: 5 lifecycle-aligned sections (Extraction Cadence & Floor
// Hiding with 2x3 preset grid + live animated visualizer + Custom modal,
// Extraction Mode & Crawl, Prompt Injection & Recall, Graph Operations & Data,
// collapsed Technical Tuning & Custom Prompts) plus value-diff dirty tracking
// and error surfacing.

import { h, clear, put } from '../../../../lens-shared/util.js';
import { escapeHtml } from '../../../../lib/html-escape.js';
import { renderFieldHelpButtonElement } from '../../../../lib/field-help-button.js';
import { createBehaviorSummary } from '../../../../lens-shared/behavior-summary.js';
import { CONFIG_FIELDS } from '../../config-iteration/fields.js';
import { resolveStartSeqFromFloor } from '../../primitives.js';
import { i18n, i18nFormat } from '../i18n.js';
import { button, checkRow, sectionTitle, segmented, switchControl } from '../ui/components.js';
import { confirmText, formField, openModal, selectInput } from '../panels/modal.js';
import {
    CADENCE_PRESETS,
    TECHNICAL_FIELDS,
    getDirtyAdvancedKeys,
    matchCadencePreset,
    withMissing,
    withMissingProfiles,
} from './settings-model.js';
import {
    buildMgMasterNoticeModel,
    buildMgExtractionSectionModel,
    buildMgCustomCadenceModalModel,
    buildMgExtractionModeModel,
    buildMgRecallSectionModel,
    buildMgTechnicalSectionModel,
    buildMgManualCompressionModalModel,
} from './behavior-summary-models.js';
import { typeDisplayName } from '../schema/schema-model.js';
import { createCadenceVisualizer } from './cadence-visualizer.js';
import { importPresetExample, openPresetDerivation, PRESET_EXAMPLES } from '../../../../lens-shared/preset-examples.js';

const REPAINT_KEYS = new Set(['recallMethod', 'ragUseRerank', 'ragUseQueryRewrite', 'recallInjectPosition']);
const CUSTOM_MODAL_KEYS = [
    'llmVisibleRecentMessages',
    'updateEvery',
    'extractBatchTurns',
    'extractContextTurns',
    'extractExcludeRecentTurns',
];
const CUSTOM_MODAL_FIELD_SET = new Set(CUSTOM_MODAL_KEYS);
const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function escapeAttr(value) {
    const str = String(value);
    return typeof globalThis.CSS?.escape === 'function'
        ? globalThis.CSS.escape(str)
        : str.replace(/["\\]/g, '\\$&');
}

function clampByField(key, rawValue, fallback) {
    const def = CONFIG_FIELDS[`settings.${key}`];
    const isBlank = rawValue === '' || rawValue === null || rawValue === undefined
        || (typeof rawValue === 'string' && rawValue.trim() === '');
    const num = isBlank ? NaN : Number(rawValue);
    let value = Math.floor(Number.isFinite(num) ? num : Number(fallback ?? def?.defaultValue ?? 0));
    if (def && Number.isFinite(def.min)) value = Math.max(def.min, value);
    if (def && Number.isFinite(def.max)) value = Math.min(def.max, value);
    return value;
}

/**
 * @param {object} app
 * @param {object} source
 * @param {{ onDirtyChange?: ((count: number) => void) | null }} [options]
 */
export function createSettingsView(app, source, { onDirtyChange = null } = {}) {
    const el = h('div', { class: 'ml-settings' });
    let view = null;
    let needsReload = true;
    let advanced = null;
    let savedAdvanced = null;
    let advancedRevision = 0;
    let lastNotifiedDirtyCount = 0;
    let techOpen = false;
    let busy = false;
    let debugQuery = '';
    let lastError = '';
    let stickyBarEl = null;

    const cadenceVisualizer = createCadenceVisualizer({}, { autoPlay: true });
    const statusEl = h('div', { class: 'ml-settings-status', role: 'status' });
    const errorEl = h('div', { class: 'ml-settings-error', role: 'alert', hidden: true });

    const masterSummary = createBehaviorSummary({
        id: 'mg-master-notice',
        ariaLabel: i18n('Memory Graph status summary'),
        build: () => (view ? buildMgMasterNoticeModel({ enabled: view.values.enabled }) : null) || { tone: 'dormant', rows: [] },
    });
    const extractionSummary = createBehaviorSummary({
        id: 'mg-extraction',
        ariaLabel: i18n('Extraction cadence and floor hiding summary'),
        build: () => view && advanced
            ? buildMgExtractionSectionModel({ values: view.values, advanced, options: view.options })
            : { tone: 'dormant', rows: [] },
        resolveField: (fieldKey, scopeEl) => {
            if (!scopeEl) return [];
            if (CUSTOM_MODAL_FIELD_SET.has(fieldKey)) {
                const activeCard = scopeEl.querySelector('.ml-preset-card.is-active');
                return activeCard ? [activeCard] : [];
            }
            return scopeEl.querySelectorAll(`[data-field-key="${escapeAttr(fieldKey)}"]`);
        },
        onTokenActivate: (fields) => {
            const modalField = fields.find(k => CUSTOM_MODAL_FIELD_SET.has(k));
            if (!modalField) return false;
            openCustomCadenceModal({ focusField: modalField });
            return true;
        },
    });
    const extractionModeSummary = createBehaviorSummary({
        id: 'mg-extraction-mode',
        ariaLabel: i18n('Extraction mode summary'),
        build: () => advanced ? buildMgExtractionModeModel({ advanced }) : { tone: 'dormant', rows: [] },
    });
    const recallSummary = createBehaviorSummary({
        id: 'mg-recall',
        ariaLabel: i18n('Prompt injection and recall summary'),
        build: () => view && advanced
            ? buildMgRecallSectionModel({ values: view.values, advanced, options: view.options })
            : { tone: 'dormant', rows: [] },
    });
    const technicalSummary = createBehaviorSummary({
        id: 'mg-technical',
        ariaLabel: i18n('Technical tuning summary'),
        build: () => view && advanced
            ? buildMgTechnicalSectionModel({ values: view.values, advanced })
            : { tone: 'dormant', rows: [] },
    });

    function syncAllSummaries() {
        if (!view || !advanced) return;
        masterSummary.el.hidden = Boolean(view.values.enabled);
        masterSummary.update();
        extractionSummary.update();
        extractionModeSummary.update();
        recallSummary.update();
        technicalSummary.update();
    }

    const dirtyKeys = () => getDirtyAdvancedKeys(advanced, savedAdvanced);
    const dirtyCount = () => dirtyKeys().length;

    function notifyDirtyIfChanged() {
        const count = dirtyCount();
        if (count !== lastNotifiedDirtyCount) {
            lastNotifiedDirtyCount = count;
            onDirtyChange?.(count);
        }
    }

    const unsubscribeStatus = source.ops?.onStatus?.((text) => { statusEl.textContent = text; }) || (() => {});
    const unsubscribeSettings = source.settings?.subscribe?.(() => {
        needsReload = true;
        if (!el.isConnected || editingHere() || busy) return;
        if (dirtyCount() === 0) {
            reload();
        } else {
            refreshOptionsOnly();
        }
    }) || (() => {});

    function syncErrorBanner() {
        errorEl.textContent = lastError;
        errorEl.hidden = !lastError;
    }

    function surfaceError(err) {
        const msg = String(err?.message || err || i18n('Operation failed'));
        lastError = msg;
        syncErrorBanner();
        app.showToast?.(msg, { error: true });
    }

    function clearError() {
        if (!lastError) return;
        lastError = '';
        syncErrorBanner();
    }

    function reload() {
        try {
            view = source.settings.read();
            savedAdvanced = clone(view.advanced.values);
            advanced = clone(view.advanced.values);
            needsReload = false;
            cadenceVisualizer.setParams(advanced);
            paint();
            notifyDirtyIfChanged();
        } catch (err) {
            clear(el);
            surfaceError(err);
            put(el, h('div', { class: 'ml-settings-inner' }, errorEl));
        }
    }

    function refreshOptionsOnly() {
        try {
            const latest = source.settings.read();
            if (view) {
                view.options = latest.options;
                view.values = latest.values;
            } else {
                view = latest;
            }
            paint();
        } catch (err) {
            surfaceError(err);
        }
    }

    function setValue(key, value) {
        view.values[key] = source.settings.set(key, value);
        if (REPAINT_KEYS.has(key)) paint();
        else syncAllSummaries();
    }

    const fieldWrap = (key, control) => {
        const node = control;
        if (node instanceof Element) node.dataset.fieldKey = key;
        return node;
    };

    const toggle = (key, label) => fieldWrap(key, switchControl(label, view.values[key], (value) => { setValue(key, value); if (!REPAINT_KEYS.has(key)) paint(); }));
    const pick = (key, label, options, help = null) => {
        const field = fieldWrap(key, formField(label, selectInput(options, view.values[key], (value) => setValue(key, value))));
        if (help) {
            field.querySelector('.lw-field-label').append(renderFieldHelpButtonElement({
                title: i18n(help.title),
                bodyHtml: escapeHtml(i18n(help.body)),
            }));
        }
        return field;
    };
    const setValue2 = (key, value) => (setValue(key, value), view.values[key]);
    const number = (key, label, min, max) => fieldWrap(key, formField(label, h('input', {
        class: 'ml-schema-input', type: 'number', min, max, step: 1, value: String(view.values[key] ?? ''),
        onChange: (event) => {
            event.target.value = String(setValue2(key, event.target.value));
        },
    })));

    function onAdvancedFieldMutated() {
        advancedRevision += 1;
        syncStickyBar();
        notifyDirtyIfChanged();
        syncAllSummaries();
    }

    const advNumber = (key, label, min, max) => fieldWrap(key, formField(label, h('input', {
        class: 'ml-schema-input', type: 'number', min, max, step: 1, value: String(advanced[key] ?? ''),
        onInput: (event) => {
            advanced[key] = event.target.value === '' ? '' : Number(event.target.value);
            onAdvancedFieldMutated();
        },
    })));
    const advCheck = (key, label) => fieldWrap(key, checkRow({
        checked: Boolean(advanced[key]),
        label,
        onChange: (value) => {
            advanced[key] = value;
            onAdvancedFieldMutated();
        },
    }));

    const connectionOptions = (key) => withMissing(view.options.connections, view.values[key], i18n('(Current API config)'), i18n('(missing)'));
    const presetOptions = (key) => withMissing(view.options.presets, view.values[key], i18n('(Current preset)'), i18n('(missing)'));
    const embeddingProfileOptions = () => withMissingProfiles(view.options.embeddingProfiles, view.values.embeddingProfileId, i18n('(unset)'), i18n('(missing)'));
    const rerankProfileOptions = () => withMissingProfiles(view.options.rerankProfiles, view.values.rerankProfileId, i18n('(unset)'), i18n('(missing)'));

    const presetActions = (key) => {
        const exampleName = PRESET_EXAMPLES.pluginOnly;
        const installed = Boolean(view?.options?.presets?.includes(exampleName));
        return h('div', { class: 'ml-preset-actions' },
            button(installed ? i18n('Re-import example') : i18n('Import example'), () => run(async () => {
                const ok = await importPresetExample(exampleName);
                if (!ok) return;
                refreshOptionsOnly();
                setValue(key, exampleName);
            }), { className: 'ml-btn-ghost ml-btn-sm', disabled: busy }),
            button(i18n('Derive from an existing preset'), () => {
                openPresetDerivation('jailbreak-only').catch(surfaceError);
            }, { className: 'ml-btn-ghost ml-btn-sm', disabled: busy }));
    };
    const presetField = (key, label) => h('div', { class: 'ml-preset-field' },
        pick(key, label, presetOptions(key)),
        presetActions(key));

    const group = (...children) => h('section', { class: 'ml-aiset-group' }, children);
    const fields = (...children) => h('div', { class: 'ml-aiset-fields' }, children);

    let activeModalCleanup = null;

    function applyCadencePreset(preset) {
        advancedRevision += 1;
        Object.assign(advanced, preset.values);
        cadenceVisualizer.setParams(advanced);
        paint();
        notifyDirtyIfChanged();
    }

    function openCustomCadenceModal({ focusField = '' } = {}) {
        activeModalCleanup?.();
        const draft = {};
        for (const key of CUSTOM_MODAL_KEYS) {
            draft[key] = advanced[key];
        }

        function resolvedDraftPreview() {
            return {
                llmVisibleRecentMessages: clampByField('llmVisibleRecentMessages', draft.llmVisibleRecentMessages, advanced.llmVisibleRecentMessages),
                updateEvery: clampByField('updateEvery', draft.updateEvery, advanced.updateEvery),
                extractBatchTurns: clampByField('extractBatchTurns', draft.extractBatchTurns, advanced.extractBatchTurns),
                extractContextTurns: clampByField('extractContextTurns', draft.extractContextTurns, advanced.extractContextTurns),
                extractExcludeRecentTurns: clampByField('extractExcludeRecentTurns', draft.extractExcludeRecentTurns, advanced.extractExcludeRecentTurns),
            };
        }

        const modalViz = createCadenceVisualizer(draft, { autoPlay: true });
        const modalSummary = createBehaviorSummary({
            id: 'mg-custom-cadence-modal',
            ariaLabel: i18n('Custom cadence and floor hiding summary'),
            build: () => buildMgCustomCadenceModalModel({
                draft: resolvedDraftPreview(),
                autoExtractionEnabled: view?.values?.autoExtractionEnabled,
            }),
        });

        let modalPulseTimer = 0;
        let modalCleaned = false;
        function cleanupModal() {
            if (modalCleaned) return;
            modalCleaned = true;
            clearTimeout(modalPulseTimer);
            modalPulseTimer = 0;
            modalSummary.destroy();
            modalViz.destroy();
            if (activeModalCleanup === cleanupModal) activeModalCleanup = null;
        }
        activeModalCleanup = cleanupModal;

        function syncModalPreview() {
            const preview = resolvedDraftPreview();
            modalSummary.update();
            modalViz.setParams(preview);
        }

        const modalNumber = (key, label, min, max) => fieldWrap(key, formField(label, h('input', {
            class: 'ml-schema-input',
            type: 'number',
            min,
            max,
            step: 1,
            value: String(draft[key] ?? ''),
            onInput: (event) => {
                draft[key] = event.target.value === '' ? '' : Number(event.target.value);
                syncModalPreview();
            },
        })));

        const content = h('div', { class: 'ml-aiset ml-custom-cadence-modal' },
            modalSummary.el,
            fields(
                modalNumber('llmVisibleRecentMessages', i18n('Hide old floors — keep latest N messages visible (0 = off)'), CONFIG_FIELDS['settings.llmVisibleRecentMessages'].min, CONFIG_FIELDS['settings.llmVisibleRecentMessages'].max),
                modalNumber('updateEvery', i18n('Update every N assistant turns'), CONFIG_FIELDS['settings.updateEvery'].min, undefined),
                modalNumber('extractBatchTurns', i18n('Extract batch assistant turns'), CONFIG_FIELDS['settings.extractBatchTurns'].min, undefined),
                modalNumber('extractContextTurns', i18n('Extract context assistant turns'), CONFIG_FIELDS['settings.extractContextTurns'].min, CONFIG_FIELDS['settings.extractContextTurns'].max),
                modalNumber('extractExcludeRecentTurns', i18n('Exclude latest N assistant turns from graph extraction'), CONFIG_FIELDS['settings.extractExcludeRecentTurns'].min, undefined),
            ),
            modalViz.el,
        );
        modalSummary.bindScope(content);
        modalSummary.update();

        const closeModal = openModal(app, {
            title: i18n('Custom Cadence & Floor Hiding'),
            content,
            okLabel: i18n('Apply'),
            wide: true,
            onOk() {
                advancedRevision += 1;
                advanced.llmVisibleRecentMessages = clampByField('llmVisibleRecentMessages', draft.llmVisibleRecentMessages, advanced.llmVisibleRecentMessages);
                advanced.updateEvery = clampByField('updateEvery', draft.updateEvery, advanced.updateEvery);
                advanced.extractBatchTurns = clampByField('extractBatchTurns', draft.extractBatchTurns, advanced.extractBatchTurns);
                advanced.extractContextTurns = clampByField('extractContextTurns', draft.extractContextTurns, advanced.extractContextTurns);
                advanced.extractExcludeRecentTurns = clampByField('extractExcludeRecentTurns', draft.extractExcludeRecentTurns, advanced.extractExcludeRecentTurns);
                cleanupModal();
                cadenceVisualizer.setParams(advanced);
                paint();
                notifyDirtyIfChanged();
                return true;
            },
        });

        if (focusField) {
            requestAnimationFrame(() => {
                const key = String(focusField);
                const wrap = [...content.querySelectorAll('[data-field-key]')].find(n => n.dataset.fieldKey === key);
                const input = wrap?.querySelector('input, select, textarea');
                if (input) {
                    input.focus?.({ preventScroll: true });
                    input.select?.();
                }
                if (wrap) {
                    wrap.classList.remove('luker-bsum-field-pulse');
                    void wrap.offsetWidth;
                    wrap.classList.add('luker-bsum-field-pulse');
                    clearTimeout(modalPulseTimer);
                    modalPulseTimer = setTimeout(() => {
                        modalPulseTimer = 0;
                        wrap.classList.remove('luker-bsum-field-pulse');
                    }, 1200);
                }
            });
        }

        // Clean up the modal visualizer's interval and summary listeners whenever the modal closes via Cancel/Escape/backdrop.
        const observer = typeof MutationObserver === 'function'
            ? new MutationObserver(() => {
                if (!modalViz.el.isConnected) {
                    cleanupModal();
                    observer.disconnect();
                }
            })
            : null;
        observer?.observe(app.root, { childList: true });
        void closeModal;
    }

    // ---- Section 1: Extraction Cadence & Floor Hiding --------------------
    function extractionSection() {
        const activePresetId = matchCadencePreset(advanced);
        const isCustomActive = activePresetId === null;
        const customEvery = Math.max(1, Math.floor(Number(advanced.updateEvery) || 2));
        const customBatch = Math.max(1, Math.floor(Number(advanced.extractBatchTurns) || 2));
        const customVisible = Math.max(0, Math.floor(Number.isFinite(Number(advanced.llmVisibleRecentMessages)) ? Number(advanced.llmVisibleRecentMessages) : 5));

        const customLine1 = isCustomActive
            ? i18nFormat('Every ${0} · batch ${1}', customEvery, customBatch)
            : i18n('Manual numbers');
        const customLine2 = isCustomActive
            ? (customVisible <= 0 ? i18n('Keep full history') : i18nFormat('Hide past ${0} msgs', customVisible))
            : i18n('Context & exclusions');

        const presetCards = CADENCE_PRESETS.map(preset => h('button', {
            type: 'button',
            class: `ml-preset-card ${activePresetId === preset.id ? 'is-active' : ''}`.trim(),
            dataset: { cadencePreset: preset.id },
            'aria-pressed': String(activePresetId === preset.id),
            onClick: () => applyCadencePreset(preset),
        },
        h('span', { class: 'ml-preset-card-title', text: i18n(preset.titleKey) }),
        h('span', { class: 'ml-preset-card-line', text: i18n(preset.cadenceKey) }),
        h('span', { class: 'ml-preset-card-line is-sub', text: i18n(preset.hidingKey) })));

        const customCard = h('button', {
            type: 'button',
            class: `ml-preset-card is-custom ${isCustomActive ? 'is-active' : ''}`.trim(),
            dataset: { cadenceCustom: 'true' },
            'aria-pressed': String(isCustomActive),
            onClick: () => openCustomCadenceModal(),
        },
        h('span', { class: 'ml-preset-card-title', text: i18n('Custom…') }),
        h('span', { class: 'ml-preset-card-line', text: customLine1 }),
        h('span', { class: 'ml-preset-card-line is-sub', text: customLine2 }));

        cadenceVisualizer.setParams(advanced);

        return h('section', { class: 'ml-aiset-group ml-settings-section', dataset: { settingsSection: 'extraction' } },
            sectionTitle(i18n('Extraction Cadence & Floor Hiding')),
            extractionSummary.el,
            toggle('autoExtractionEnabled', i18n('Auto extraction')),
            toggle('autoCompressionEnabled', i18n('Auto compression')),
            fields(
                pick('extractApiPresetName', i18n('Extract API preset (Connection profile)'), connectionOptions('extractApiPresetName')),
                presetField('extractPresetName', i18n('Extract preset (params + prompt)'))),
            advCheck('extractIncludeWorldInfo', i18n('Include world info in extraction requests')),
            h('div', { class: 'ml-preset-grid-block' },
                h('div', { class: 'ml-aiset-label', text: i18n('Cadence & floor-hiding presets') }),
                h('div', { class: 'ml-preset-grid', role: 'group', 'aria-label': i18n('Cadence & floor-hiding presets') },
                    ...presetCards,
                    customCard)),
            cadenceVisualizer.el);
    }

    // ---- Section 2: Extraction Mode & Crawl ------------------------------
    function extractionModeSection() {
        const isCrawl = String(advanced.extractMode || 'oneshot') === 'crawl';
        const modeField = fieldWrap('extractMode', formField(i18n('Extraction graph mode'), selectInput([
            { value: 'oneshot', label: i18n('One-shot (full graph input)') },
            { value: 'crawl', label: i18n('Crawl (LLM-explored local slice)') },
        ], isCrawl ? 'crawl' : 'oneshot', (value) => {
            advancedRevision += 1;
            advanced.extractMode = value === 'crawl' ? 'crawl' : 'oneshot';
            paint();
            notifyDirtyIfChanged();
        })));

        return h('section', { class: 'ml-aiset-group ml-settings-section', dataset: { settingsSection: 'extraction-mode' } },
            sectionTitle(i18n('Extraction Mode & Crawl')),
            extractionModeSummary.el,
            fields(modeField),
            isCrawl ? fields(
                advNumber('extractCrawlMaxRounds', i18n('Crawl max rounds'), CONFIG_FIELDS['settings.extractCrawlMaxRounds'].min, CONFIG_FIELDS['settings.extractCrawlMaxRounds'].max),
                advNumber('extractCrawlCandidateLimit', i18n('Crawl candidate limit (0 = unlimited)'), CONFIG_FIELDS['settings.extractCrawlCandidateLimit'].min, CONFIG_FIELDS['settings.extractCrawlCandidateLimit'].max),
                advNumber('extractCrawlMaxReads', i18n('Crawl read budget'), CONFIG_FIELDS['settings.extractCrawlMaxReads'].min, CONFIG_FIELDS['settings.extractCrawlMaxReads'].max),
            ) : null);
    }

    // ---- Section 3: Prompt Injection & Recall ----------------------------
    function recallSection() {
        const { values, options } = view;
        const rag = values.recallMethod === 'rag';
        const atDepth = Number(values.recallInjectPosition) === Number(options.positions.atDepth);
        const p = options.positions;
        return h('section', { class: 'ml-aiset-group ml-settings-section', dataset: { settingsSection: 'recall' } },
            sectionTitle(i18n('Prompt Injection & Recall')),
            recallSummary.el,
            toggle('recallEnabled', i18n('Enable recall injection')),
            h('div', { class: 'ml-settings-subblock' },
                h('div', { class: 'ml-aiset-label', text: i18n('Persistent Injection') }),
                fields(
                    advNumber('persistentInjectionMaxSeqDistance', i18n('Persistent injection recency horizon (assistant turns, 0 = no limit)'), 0))),
            h('div', { class: 'ml-settings-subblock' },
                h('div', { class: 'ml-aiset-label', text: i18n('On-Demand Recall') }),
                pick('recallMethod', i18n('Recall method'), [
                    { value: 'llm', label: i18n('LLM Recall (default)') },
                    { value: 'rag', label: i18n('RAG Vector Recall (vector + optional rerank + optional rewrite)') },
                ]),
                rag ? fields(
                    pick('embeddingProfileId', i18n('Embedding profile'), embeddingProfileOptions()),
                    number('vectorTopK', i18n('Vector pre-filter Top-K'), 5, 100),
                    number('hybridMaxResults', i18n('Max recall results'), 3, 50),
                    number('ragDefaultPerTypeK', i18n('Default per-type quota'), 0, 50)) : null,
                rag ? toggle('ragUseRerank', i18n('Enable rerank')) : null,
                rag && values.ragUseRerank ? pick('rerankProfileId', i18n('Rerank profile'), rerankProfileOptions()) : null,
                rag ? toggle('ragUseQueryRewrite', i18n('Enable query rewrite (extra LLM call)')) : null,
                rag && values.ragUseQueryRewrite ? fields(
                    pick('ragRewriteApiPresetName', i18n('Query rewrite API preset (Connection profile)'), connectionOptions('ragRewriteApiPresetName')),
                    presetField('ragRewriteLlmPresetName', i18n('Query rewrite prompt preset'))) : null,
                !rag ? fields(
                    pick('recallApiPresetName', i18n('Recall API preset (Connection profile)'), connectionOptions('recallApiPresetName')),
                    presetField('recallPresetName', i18n('Recall preset (params + prompt)'))) : null,
                !rag ? advCheck('recallIncludeWorldInfo', i18n('Include world info in recall requests')) : null),
            h('div', { class: 'ml-settings-subblock' },
                h('div', { class: 'ml-aiset-label', text: i18n('Placement & Debug') }),
                pick('recallInjectPosition', i18n('Injection position'), [
                    [p.before, 'Before Character Definitions'], [p.after, 'After Character Definitions'],
                    [p.ANTop, 'Before Author\'s Note'], [p.ANBottom, 'After Author\'s Note'],
                    [p.EMTop, 'Before Example Messages'], [p.EMBottom, 'After Example Messages'],
                    [p.atDepth, 'At Chat Depth'],
                ].map(([value, label]) => ({ value: String(value), label: i18n(label) })), { title: 'About Injection position', body: 'Injection position help body' }),
                atDepth ? fields(
                    number('recallInjectDepth', i18n('Injection depth'), 0, 10000),
                    pick('recallInjectRole', i18n('Injection role'), [
                        [options.roles.SYSTEM, 'System'], [options.roles.USER, 'User'], [options.roles.ASSISTANT, 'Assistant'],
                    ].map(([value, label]) => ({ value: String(value), label: i18n(label) })))) : null,
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
                    button(i18n('View Last Injection'), () => app.showInjection(), { className: 'ml-btn-ghost' }))));
    }

    // ---- Section 4: Graph Operations & Data ------------------------------
    async function run(task) {
        if (busy) return;
        clearError();
        busy = true;
        paint();
        try {
            await task();
        } catch (err) {
            surfaceError(err);
        } finally {
            busy = false;
            paint();
            app.refresh();
        }
    }

    const openStudio = (open) => {
        clearError();
        Promise.resolve().then(open).catch(surfaceError).finally(() => app.refresh());
    };

    const action = (label, task, options = {}) => button(label, task, { disabled: busy, className: 'ml-btn-ghost', ...options });

    function askRebuildRange() {
        const range = source.ops.rebuildRange();
        const latest = Number(range?.latestSeq || 0);
        if (latest <= 0) {
            surfaceError(new Error(i18n('No assistant turns available to rebuild.')));
            return;
        }
        const minFloor = Number.isInteger(range.minFloor) ? range.minFloor : 0;
        const maxFloor = Number.isInteger(range.maxFloor) ? range.maxFloor : 0;
        const assistantFloors = Array.isArray(range.assistantFloors) ? range.assistantFloors : [];

        let mode = 'recent';
        let recentValue = String(Math.min(20, latest)); // cap-ok: initial default input value clamped to available chat turns; max is latest
        let floorValue = String(maxFloor);

        const modeOptions = [
            { value: 'recent', label: i18n('Rebuild Recent') },
            { value: 'from_floor', label: i18n('From Floor') },
        ];
        const modeSlot = h('div');
        const labelEl = h('span', { class: 'lw-field-label' });
        const input = h('input', { class: 'ml-schema-input', type: 'number', step: 1 });
        const field = h('label', { class: 'lw-field' }, labelEl, input);
        const previewEl = h('div', { class: 'ml-settings-note' });

        function parseNonNegInt(raw) {
            const trimmed = String(raw ?? '').trim();
            return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
        }

        function updatePreview() {
            const parsed = parseNonNegInt(input.value);
            if (parsed === null) {
                previewEl.textContent = '';
                previewEl.hidden = true;
                return;
            }
            let fromFloor = null;
            let toFloor = maxFloor;
            let turnCount = 0;
            if (mode === 'recent') {
                if (parsed < 1 || parsed > latest) {
                    previewEl.textContent = '';
                    previewEl.hidden = true;
                    return;
                }
                const startSeq = latest - parsed + 1;
                fromFloor = assistantFloors[startSeq - 1];
                toFloor = assistantFloors[latest - 1];
                turnCount = parsed;
            } else {
                const startSeq = resolveStartSeqFromFloor(assistantFloors, parsed);
                if (startSeq === null) {
                    previewEl.textContent = '';
                    previewEl.hidden = true;
                    return;
                }
                fromFloor = parsed;
                toFloor = assistantFloors[latest - 1];
                turnCount = latest - startSeq + 1;
            }
            if (!Number.isInteger(fromFloor) || !Number.isInteger(toFloor)) {
                previewEl.textContent = '';
                previewEl.hidden = true;
                return;
            }
            previewEl.textContent = fromFloor === toFloor
                ? i18nFormat('Will rebuild floor ${0} (${1} assistant turn(s)).', fromFloor, turnCount)
                : i18nFormat('Will rebuild floors ${0}-${1} (${2} assistant turn(s)).', fromFloor, toFloor, turnCount);
            previewEl.hidden = false;
        }

        function syncModeUi() {
            put(clear(modeSlot), segmented(modeOptions, mode, (nextMode) => {
                if (mode === 'recent') recentValue = input.value;
                else floorValue = input.value;
                mode = nextMode;
                syncModeUi();
                input.focus({ preventScroll: true });
            }, { ariaLabel: i18n('Rebuild mode') }));

            if (mode === 'recent') {
                labelEl.textContent = i18nFormat('Rebuild recent assistant turns: enter N (1-${0}).', latest);
                input.min = '1';
                input.max = String(latest);
                input.value = recentValue;
            } else {
                labelEl.textContent = i18nFormat('Rebuild from floor N (${0}-${1}).', minFloor, maxFloor);
                input.min = String(minFloor);
                input.max = String(maxFloor);
                input.value = floorValue;
            }
            updatePreview();
        }

        input.addEventListener('input', () => {
            if (mode === 'recent') recentValue = input.value;
            else floorValue = input.value;
            updatePreview();
        });
        syncModeUi();

        openModal(app, {
            title: i18n('Rebuild Range'),
            content: h('div', { class: 'ml-aiset' }, modeSlot, field, previewEl),
            okLabel: i18n('Start Rebuild'),
            wide: false,
            onOk() {
                const value = parseNonNegInt(input.value);
                if (mode === 'recent') {
                    if (value === null || value < 1 || value > latest) {
                        app.notify(i18nFormat('Please enter a valid integer between 1 and ${0}.', latest));
                        return false;
                    }
                    void run(() => source.ops.rebuildRecent(value));
                    return true;
                }
                if (value === null || resolveStartSeqFromFloor(assistantFloors, value) === null) {
                    app.notify(i18nFormat('Please enter a valid integer between ${0} and ${1}.', minFloor, maxFloor));
                    return false;
                }
                void run(() => source.ops.rebuildFromFloor(value));
                return true;
            },
        });
    }

    function askCompress() {
        const types = view.options.compressibleTypes;
        if (!types.length) {
            surfaceError(new Error(i18n('No compressible types in current schema.')));
            return;
        }
        activeModalCleanup?.();
        const displayTypes = types.map(item => ({
            ...item,
            displayLabel: typeDisplayName(item),
        }));
        const selected = new Set(displayTypes.map(item => item.id));
        const draft = {
            scope: 'older',
            excludeRecent: 2,
            mode: 'schema',
            roundLimitMode: 'unlimited',
            maxRoundsPerType: 3,
            selectedTypeIds: [...selected],
        };

        const modalSummary = createBehaviorSummary({
            id: 'mg-manual-compress-modal',
            ariaLabel: i18n('Manual compression summary'),
            build: () => buildMgManualCompressionModalModel({ draft, types: displayTypes }),
        });

        let cleanedUp = false;
        function cleanupModal() {
            if (cleanedUp) return;
            cleanedUp = true;
            modalSummary.destroy();
            if (activeModalCleanup === cleanupModal) activeModalCleanup = null;
        }
        activeModalCleanup = cleanupModal;

        let excludeField = null;
        let roundsField = null;
        function syncModalState() {
            if (excludeField) excludeField.hidden = draft.scope !== 'older';
            if (roundsField) roundsField.hidden = draft.roundLimitMode !== 'limited';
            modalSummary.update();
        }

        const scope = selectInput([
            { value: 'older', label: i18n('Older nodes only (exclude recent N assistant turns)') },
            { value: 'all', label: i18n('All nodes') },
        ], draft.scope, (value) => {
            draft.scope = value;
            syncModalState();
        });
        const excludeRecent = h('input', {
            class: 'ml-schema-input',
            type: 'number',
            min: 0,
            step: 1,
            value: String(draft.excludeRecent),
            onInput: (event) => {
                draft.excludeRecent = event.target.value === '' ? '' : Number(event.target.value);
                syncModalState();
            },
        });
        const mode = selectInput([
            { value: 'schema', label: i18n('Use schema thresholds') },
            { value: 'force', label: i18n('Force compress (ignore threshold)') },
            { value: 'flat', label: i18n('Force compress across depths (ignore hierarchy)') },
        ], draft.mode, (value) => {
            draft.mode = value;
            syncModalState();
        });
        const roundLimitMode = selectInput([
            { value: 'unlimited', label: i18n('Compress until done') },
            { value: 'limited', label: i18n('Stop after N merges per type') },
        ], draft.roundLimitMode, (value) => {
            draft.roundLimitMode = value;
            syncModalState();
        });
        const rounds = h('input', {
            class: 'ml-schema-input',
            type: 'number',
            min: 1,
            step: 1,
            value: String(draft.maxRoundsPerType),
            onInput: (event) => {
                draft.maxRoundsPerType = event.target.value === '' ? '' : Number(event.target.value);
                syncModalState();
            },
        });

        const scopeField = fieldWrap('scope', formField(i18n('Compression scope'), scope));
        excludeField = fieldWrap('excludeRecent', formField(i18n('Exclude recent assistant turns'), excludeRecent));
        const modeField = fieldWrap('mode', formField(i18n('Compression mode'), mode));
        const roundLimitField = fieldWrap('roundLimitMode', formField(i18n('Stop rule'), roundLimitMode));
        roundsField = fieldWrap('maxRoundsPerType', formField(i18n('Max merges per type'), rounds));
        const typesField = h('div', { class: 'ml-aiset-field', dataset: { fieldKey: 'selectedTypeIds' } },
            h('span', { class: 'ml-aiset-label', text: i18n('Types to compress') }),
            displayTypes.map(item => checkRow({
                checked: true,
                label: item.displayLabel,
                onChange: (value) => {
                    if (value) selected.add(item.id);
                    else selected.delete(item.id);
                    draft.selectedTypeIds = displayTypes.filter(t => selected.has(t.id)).map(t => t.id);
                    syncModalState();
                },
            })));

        const content = h('div', { class: 'ml-aiset ml-manual-compress-modal' },
            modalSummary.el,
            scopeField,
            excludeField,
            modeField,
            roundLimitField,
            roundsField,
            typesField);
        modalSummary.bindScope(content);
        syncModalState();

        openModal(app, {
            title: i18n('Manual Compression'),
            content,
            okLabel: i18n('Apply Manual Compression'),
            onOk() {
                if (draft.selectedTypeIds.length === 0) {
                    app.notify(i18n('Select at least one type to compress.'));
                    return false;
                }
                const maxRoundsPerType = draft.roundLimitMode === 'limited'
                    ? Math.max(1, Math.floor(Number(draft.maxRoundsPerType) || 1))
                    : null;
                cleanupModal();
                void run(() => source.ops.compress({
                    scope: draft.scope,
                    mode: draft.mode,
                    excludeRecent: Math.max(0, Math.floor(Number(draft.excludeRecent) || 0)),
                    maxRoundsPerType,
                    selectedTypeIds: draft.selectedTypeIds.slice(),
                }));
                return true;
            },
        });

        const observer = typeof MutationObserver === 'function'
            ? new MutationObserver(() => {
                if (!content.isConnected) {
                    cleanupModal();
                    observer.disconnect();
                }
            })
            : null;
        observer?.observe(app.root, { childList: true });
    }

    function askRawEdit() {
        clearError();
        void source.ops.readRawEdit().then((base) => {
            const area = h('textarea', { class: 'ml-schema-input ml-settings-json', rows: 22, text: base.text });
            const error = h('div', { class: 'ml-settings-error', role: 'alert', hidden: true });
            let applying = false;
            openModal(app, {
                title: i18n('Edit graph JSON'),
                content: h('div', null, area, error),
                okLabel: i18n('Apply Graph'),
                async onOk() {
                    if (applying) return false;
                    applying = true;
                    error.hidden = true;
                    try {
                        const saved = await source.ops.applyRawJson(area.value.trim(), base);
                        if (saved) app.refresh();
                        return saved;
                    } catch (err) {
                        error.textContent = String(err?.message || err);
                        error.hidden = false;
                        return false;
                    } finally {
                        applying = false;
                    }
                },
            });
        }).catch(surfaceError);
    }

    function statsLine() {
        try {
            const stats = source.ops.stats();
            return i18nFormat('nodes=${0}, edges=${1}, messages=${2}, source=${3}, semantic=${4}', stats.nodeCount, stats.edgeCount, stats.messageCount, stats.sourceMessageCount, stats.levelCount.semantic);
        } catch {
            return '';
        }
    }

    function operationsSection() {
        const ops = source.ops;
        const actions = (...children) => h('div', { class: 'ml-settings-actions' }, children);
        const rebuildRangeBtn = action(i18n('Rebuild Range'), askRebuildRange);
        rebuildRangeBtn.dataset.rebuildRange = 'true';
        return h('section', { class: 'ml-aiset-group ml-settings-section', dataset: { settingsSection: 'operations' } },
            sectionTitle(i18n('Graph Operations & Data')),
            h('div', { class: 'ml-settings-stats', text: statsLine() }),
            actions(
                action(i18n('Fill Graph'), () => run(ops.fill)),
                action(i18n('Rebuild Graph'), () => confirmText(app, { title: i18n('Rebuild Graph'), lines: [i18n('Rebuild the whole graph from this chat?')], okLabel: i18n('Rebuild Graph'), danger: true, onOk: () => { void run(ops.rebuild); } })),
                rebuildRangeBtn,
                action(i18n('Manual Compress'), askCompress),
                action(i18n('Fill Missing'), () => run(() => ops.vectors('incremental'))),
                action(i18n('Full Rebuild'), () => run(() => ops.vectors('full')))),
            actions(
                action(i18n('Export Graph'), () => run(ops.exportGraph)),
                action(i18n('Import Graph'), () => run(ops.importGraph)),
                action(i18n('View graph JSON'), () => {
                    clearError();
                    void ops.rawJson()
                        .then(text => app.openStatus(i18n('View graph JSON'), [{ title: i18n('Graph'), text }]))
                        .catch(surfaceError);
                }),
                action(i18n('Edit graph JSON'), askRawEdit),
                action(i18n('Reset Chat'), () => confirmText(app, { title: i18n('Reset Chat'), lines: [i18n('Reset current chat memory graph? This cannot be undone.')], okLabel: i18n('Reset'), danger: true, onOk: () => { void run(ops.reset); } }), { className: 'ml-btn-danger' })),
            actions(
                button(i18n('AI Edit Memory Graph Config'), () => openStudio(ops.openConfigStudio), { iconName: 'sparkle', disabled: busy }),
                button(i18n('AI Edit Memory Graph Content'), () => openStudio(ops.openGraphStudio), { iconName: 'sparkle', disabled: busy })));
    }

    // ---- Section 5: Technical Tuning & Custom Prompts (collapsed) --------
    function technicalControl(field) {
        const label = i18n(field.label);
        if (field.kind === 'bool') {
            return fieldWrap(field.key, checkRow({
                checked: advanced[field.key],
                label,
                onChange: (value) => { advanced[field.key] = value; onAdvancedFieldMutated(); },
            }));
        }
        if (field.kind === 'text') {
            const input = h('textarea', {
                class: 'ml-schema-input',
                rows: 8,
                text: String(advanced[field.key] ?? ''),
                onInput: (event) => { advanced[field.key] = event.target.value; onAdvancedFieldMutated(); },
            });
            return fieldWrap(field.key, h('div', {},
                formField(label, input),
                button(i18n('Reset to default'), () => {
                    advanced[field.key] = view.advanced.defaults[field.key];
                    input.value = advanced[field.key];
                    onAdvancedFieldMutated();
                }, { className: 'ml-btn-ghost' })));
        }
        return fieldWrap(field.key, formField(label, h('input', {
            class: 'ml-schema-input',
            type: 'number',
            min: field.min,
            max: field.max,
            step: 1,
            value: String(advanced[field.key] ?? ''),
            onInput: (event) => {
                advanced[field.key] = event.target.value === '' ? '' : Number(event.target.value);
                onAdvancedFieldMutated();
            },
        })));
    }

    function technicalSection() {
        const visible = TECHNICAL_FIELDS.filter(field => !field.when || field.when(view.values));
        return h('details', {
            class: 'ml-aiset-group ml-settings-section ml-settings-details',
            dataset: { settingsSection: 'technical' },
            open: techOpen || null,
            onToggle: (event) => { techOpen = event.target.open; },
        },
        h('summary', { class: 'ml-settings-summary' }, h('span', { text: i18n('Technical Tuning & Custom Prompts') })),
        h('div', { class: 'ml-settings-details-body' },
            technicalSummary.el,
            fields(
                pick('requestApiPresetName', i18n('Iteration AI API preset (Connection profile)'), connectionOptions('requestApiPresetName')),
                presetField('requestLlmPresetName', i18n('Iteration AI prompt preset (params + prompt)'))),
            fields(...visible.filter(field => field.kind === 'int').map(technicalControl)),
            visible.filter(field => field.kind === 'bool').map(technicalControl),
            visible.filter(field => field.kind === 'text').map(technicalControl)));
    }

    async function saveAdvanced(work, doneText) {
        const savedRevision = advancedRevision;
        clearError();
        try {
            await work();
            app.notify?.(doneText);
            if (advancedRevision === savedRevision) {
                reload();
            } else {
                const latest = source.settings.read();
                if (view) {
                    view.options = latest.options;
                    view.values = latest.values;
                    view.advanced = latest.advanced;
                } else {
                    view = latest;
                }
                savedAdvanced = clone(latest.advanced.values);
                if (editingHere()) {
                    needsReload = true;
                    statusEl.textContent = source.ops.status();
                    syncErrorBanner();
                    syncStickyBar();
                    syncAllSummaries();
                    notifyDirtyIfChanged();
                } else {
                    needsReload = false;
                    paint();
                    notifyDirtyIfChanged();
                }
            }
        } catch (err) {
            surfaceError(err);
        }
    }

    function discardAdvanced() {
        if (needsReload) {
            reload();
            return;
        }
        advanced = clone(savedAdvanced);
        cadenceVisualizer.setParams(advanced);
        paint();
        notifyDirtyIfChanged();
    }

    function renderStickyBarContent(barEl) {
        if (!barEl || !view) return;
        const info = view.advanced;
        const count = dirtyCount();
        const isDirty = count > 0;
        barEl.classList.toggle('is-dirty', isDirty);
        const scopeText = info.hasOverride ? i18nFormat('Character override: ${0}', info.characterName || '') : i18n('Global');
        const dirtyText = count === 1 ? i18n('1 unsaved change') : i18nFormat('${0} unsaved changes', count);

        const discardBtn = isDirty
            ? button(i18n('Discard changes'), () => discardAdvanced(), { className: 'ml-btn-ghost' })
            : null;
        if (discardBtn) discardBtn.dataset.settingsAction = 'discard';

        clear(barEl);
        put(barEl,
            h('div', { class: 'ml-settings-sticky-meta' },
                h('span', { class: 'ml-settings-stats', text: scopeText }),
                isDirty ? h('span', { class: 'ml-settings-dirty-pill', role: 'status' },
                    h('span', { class: 'ml-settings-dirty-dot', 'aria-hidden': 'true' }),
                    h('span', { text: dirtyText })) : null),
            discardBtn,
            button(i18n('Reset Advanced Settings'), () => confirmText(app, {
                title: i18n('Reset Advanced Settings'),
                lines: [i18n('Reset advanced settings editor to default? This will overwrite current unsaved advanced edits.')],
                okLabel: i18n('Reset'),
                danger: true,
                onOk: () => {
                    advancedRevision += 1;
                    advanced = clone(info.defaults);
                    cadenceVisualizer.setParams(advanced);
                    paint();
                    notifyDirtyIfChanged();
                },
            }), { className: 'ml-btn-ghost' }),
            button(i18n('Clear Character Advanced Override'), () => saveAdvanced(() => source.settings.clearAdvanced(info.avatar), i18n('Cleared')), { className: 'ml-btn-ghost', disabled: !info.hasOverride }),
            button(i18n('Save Advanced to Character'), () => saveAdvanced(() => source.settings.saveAdvanced(advanced, 'character', info.avatar), i18n('Saved')), { disabled: !info.hasAvatar }),
            button(i18n('Save Advanced to Global'), () => saveAdvanced(() => source.settings.saveAdvanced(advanced, 'global'), i18n('Saved')), { className: 'ml-btn-primary' }));
    }

    function syncStickyBar() {
        renderStickyBarContent(stickyBarEl);
    }

    function scopeSaveBar() {
        stickyBarEl = h('div', { class: 'ml-settings-actions ml-settings-sticky' });
        renderStickyBarContent(stickyBarEl);
        return stickyBarEl;
    }

    function paint() {
        const scroll = el.scrollTop;
        statusEl.textContent = source.ops.status();
        syncErrorBanner();
        clear(el);
        const masterHidden = Boolean(view.values.enabled);
        masterSummary.el.hidden = masterHidden;
        const enabledGroup = group(
            toggle('enabled', i18n('Enabled')),
            masterHidden ? null : masterSummary.el,
            statusEl,
            errorEl,
            busy ? button(i18n('Stop'), () => source.ops.stop(), { iconName: 'x', className: 'ml-btn-danger' }) : null,
            h('p', { class: 'ml-settings-note', text: i18n('The AI Workbench uses to edit these settings is selected in Workbench → Settings.') }),
        );
        const sec1 = extractionSection();
        const sec2 = extractionModeSection();
        const sec3 = recallSection();
        const sec4 = operationsSection();
        const sec5 = technicalSection();
        put(el, h('div', { class: 'ml-settings-inner' },
            enabledGroup,
            sec1,
            sec2,
            sec3,
            sec4,
            sec5,
            scopeSaveBar()));
        masterSummary.bindScope(masterHidden ? null : enabledGroup);
        masterSummary.update();
        extractionSummary.bindScope(sec1);
        extractionSummary.update();
        extractionModeSummary.bindScope(sec2);
        extractionModeSummary.update();
        recallSummary.bindScope(sec3);
        recallSummary.update();
        technicalSummary.bindScope(sec5);
        technicalSummary.update();
        el.scrollTop = scroll;
    }

    const editingHere = () => el.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

    return {
        id: 'settings',
        el,
        render() {
            if (!view || (needsReload && dirtyCount() === 0 && !editingHere() && !busy)) reload();
        },
        invalidate() { needsReload = true; },
        dirtyCount,
        destroy() {
            activeModalCleanup?.();
            masterSummary.destroy();
            extractionSummary.destroy();
            extractionModeSummary.destroy();
            recallSummary.destroy();
            technicalSummary.destroy();
            cadenceVisualizer.destroy();
            unsubscribeStatus();
            unsubscribeSettings();
        },
    };
}
