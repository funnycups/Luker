// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings page: 4 lifecycle-aligned sections (Extraction Cadence & Floor
// Hiding with 2x3 preset grid + live animated visualizer + Custom modal,
// Prompt Injection & Recall, Graph Operations & Data, collapsed Technical
// Tuning & Custom Prompts) plus value-diff dirty tracking and error surfacing.

import { h, clear, put } from '../../../../lens-shared/util.js';
import { CONFIG_FIELDS } from '../../config-iteration/fields.js';
import { i18n, i18nFormat } from '../i18n.js';
import { button, checkRow, sectionTitle, switchControl } from '../ui/components.js';
import { confirmText, formField, openModal, selectInput } from '../panels/modal.js';
import {
    CADENCE_PRESETS,
    TECHNICAL_FIELDS,
    detectVisibilityGap,
    formatCadenceSummary,
    getDirtyAdvancedKeys,
    matchCadencePreset,
    withMissing,
    withMissingProfiles,
} from './settings-model.js';
import { createCadenceVisualizer } from './cadence-visualizer.js';
import { importPresetExample, openPresetDerivation, PRESET_EXAMPLES } from '../../../../lens-shared/preset-examples.js';

const REPAINT_KEYS = new Set(['recallMethod', 'ragUseRerank', 'ragUseQueryRewrite', 'recallInjectPosition']);
const CUSTOM_MODAL_KEYS = [
    'llmVisibleRecentMessages',
    'updateEvery',
    'extractBatchTurns',
    'extractContextTurns',
    'extractExcludeRecentTurns',
    'extractMode',
    'extractCrawlMaxRounds',
    'extractCrawlCandidateLimit',
    'extractCrawlMaxReads',
];
const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

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

function formatGapWarning(gap) {
    if (!gap?.hasGap) return '';
    return i18nFormat(
        'Visibility gap warning: up to ${0} unextracted turns can be hidden before extraction runs. Keep at least ${1} recent messages visible (or set 0 to disable hiding).',
        gap.maxUnextracted,
        gap.minRecommendedVisible,
    );
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
    let lastNotifiedDirtyCount = 0;
    let techOpen = false;
    let busy = false;
    let debugQuery = '';
    let lastError = '';
    let stickyBarEl = null;
    let cadenceSummaryEl = null;
    let gapWarningEl = null;

    const cadenceVisualizer = createCadenceVisualizer({}, { autoPlay: true });
    const statusEl = h('div', { class: 'ml-settings-status', role: 'status' });
    const errorEl = h('div', { class: 'ml-settings-error', role: 'alert', hidden: true });

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
    }

    const fieldWrap = (key, control) => {
        const node = control;
        if (node instanceof Element) node.dataset.fieldKey = key;
        return node;
    };

    const toggle = (key, label) => fieldWrap(key, switchControl(label, view.values[key], (value) => { setValue(key, value); paint(); }));
    const pick = (key, label, options) => fieldWrap(key, formField(label, selectInput(options, view.values[key], (value) => setValue(key, value))));
    const setValue2 = (key, value) => (setValue(key, value), view.values[key]);
    const number = (key, label, min, max) => fieldWrap(key, formField(label, h('input', {
        class: 'ml-schema-input', type: 'number', min, max, step: 1, value: String(view.values[key] ?? ''),
        onChange: (event) => {
            event.target.value = String(setValue2(key, event.target.value));
        },
    })));

    function onAdvancedFieldMutated() {
        syncStickyBar();
        notifyDirtyIfChanged();
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

    function syncCadenceFeedback() {
        if (cadenceSummaryEl) {
            cadenceSummaryEl.textContent = formatCadenceSummary(advanced);
        }
        if (gapWarningEl) {
            const gap = detectVisibilityGap(advanced);
            const text = formatGapWarning(gap);
            gapWarningEl.textContent = text;
            gapWarningEl.hidden = !text;
        }
        cadenceVisualizer.setParams(advanced);
    }

    function applyCadencePreset(preset) {
        Object.assign(advanced, preset.values);
        cadenceVisualizer.setParams(advanced);
        paint();
        notifyDirtyIfChanged();
    }

    function openCustomCadenceModal() {
        const draft = {};
        for (const key of CUSTOM_MODAL_KEYS) {
            draft[key] = advanced[key];
        }

        const modalViz = createCadenceVisualizer(draft, { autoPlay: true });
        const modalSummaryEl = h('p', { class: 'ml-settings-cadence-summary', text: formatCadenceSummary(draft) });
        const initialGapText = formatGapWarning(detectVisibilityGap(draft));
        const modalGapEl = h('div', { class: 'ml-settings-gap-warning', role: 'alert', hidden: !initialGapText, text: initialGapText });
        const crawlWrap = h('div', { class: 'ml-aiset-fields' });

        function resolvedDraftPreview() {
            return {
                llmVisibleRecentMessages: clampByField('llmVisibleRecentMessages', draft.llmVisibleRecentMessages, advanced.llmVisibleRecentMessages),
                updateEvery: clampByField('updateEvery', draft.updateEvery, advanced.updateEvery),
                extractBatchTurns: clampByField('extractBatchTurns', draft.extractBatchTurns, advanced.extractBatchTurns),
                extractContextTurns: clampByField('extractContextTurns', draft.extractContextTurns, advanced.extractContextTurns),
                extractExcludeRecentTurns: clampByField('extractExcludeRecentTurns', draft.extractExcludeRecentTurns, advanced.extractExcludeRecentTurns),
            };
        }

        function syncModalPreview() {
            const preview = resolvedDraftPreview();
            modalSummaryEl.textContent = formatCadenceSummary(preview);
            const gapText = formatGapWarning(detectVisibilityGap(preview));
            modalGapEl.textContent = gapText;
            modalGapEl.hidden = !gapText;
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

        function paintCrawlFields() {
            clear(crawlWrap);
            const isCrawl = String(draft.extractMode || 'oneshot') === 'crawl';
            crawlWrap.hidden = !isCrawl;
            if (!isCrawl) return;
            put(crawlWrap,
                modalNumber('extractCrawlMaxRounds', i18n('Crawl max rounds'), CONFIG_FIELDS['settings.extractCrawlMaxRounds'].min, CONFIG_FIELDS['settings.extractCrawlMaxRounds'].max),
                modalNumber('extractCrawlCandidateLimit', i18n('Crawl candidate limit'), CONFIG_FIELDS['settings.extractCrawlCandidateLimit'].min, CONFIG_FIELDS['settings.extractCrawlCandidateLimit'].max),
                modalNumber('extractCrawlMaxReads', i18n('Crawl read budget'), CONFIG_FIELDS['settings.extractCrawlMaxReads'].min, CONFIG_FIELDS['settings.extractCrawlMaxReads'].max),
            );
        }

        const modeField = fieldWrap('extractMode', formField(i18n('Extraction graph mode'), selectInput([
            { value: 'oneshot', label: i18n('One-shot (full graph input)') },
            { value: 'crawl', label: i18n('Crawl (LLM-explored local slice)') },
        ], String(draft.extractMode || 'oneshot'), (value) => {
            draft.extractMode = value;
            paintCrawlFields();
        })));

        paintCrawlFields();

        const content = h('div', { class: 'ml-aiset ml-custom-cadence-modal' },
            fields(
                modalNumber('llmVisibleRecentMessages', i18n('Hide old floors — keep latest N messages visible (0 = off)'), CONFIG_FIELDS['settings.llmVisibleRecentMessages'].min, CONFIG_FIELDS['settings.llmVisibleRecentMessages'].max),
                modalNumber('updateEvery', i18n('Update every N assistant turns'), CONFIG_FIELDS['settings.updateEvery'].min, undefined),
                modalNumber('extractBatchTurns', i18n('Extract batch assistant turns'), CONFIG_FIELDS['settings.extractBatchTurns'].min, undefined),
                modalNumber('extractContextTurns', i18n('Extract context assistant turns'), CONFIG_FIELDS['settings.extractContextTurns'].min, CONFIG_FIELDS['settings.extractContextTurns'].max),
                modalNumber('extractExcludeRecentTurns', i18n('Exclude latest N assistant turns from graph extraction'), CONFIG_FIELDS['settings.extractExcludeRecentTurns'].min, undefined),
            ),
            fields(modeField),
            crawlWrap,
            modalViz.el,
            modalSummaryEl,
            modalGapEl,
        );

        const closeModal = openModal(app, {
            title: i18n('Custom Cadence & Floor Hiding'),
            content,
            okLabel: i18n('Apply'),
            wide: true,
            onOk() {
                advanced.llmVisibleRecentMessages = clampByField('llmVisibleRecentMessages', draft.llmVisibleRecentMessages, advanced.llmVisibleRecentMessages);
                advanced.updateEvery = clampByField('updateEvery', draft.updateEvery, advanced.updateEvery);
                advanced.extractBatchTurns = clampByField('extractBatchTurns', draft.extractBatchTurns, advanced.extractBatchTurns);
                advanced.extractContextTurns = clampByField('extractContextTurns', draft.extractContextTurns, advanced.extractContextTurns);
                advanced.extractExcludeRecentTurns = clampByField('extractExcludeRecentTurns', draft.extractExcludeRecentTurns, advanced.extractExcludeRecentTurns);
                advanced.extractMode = String(draft.extractMode || 'oneshot') === 'crawl' ? 'crawl' : 'oneshot';
                advanced.extractCrawlMaxRounds = clampByField('extractCrawlMaxRounds', draft.extractCrawlMaxRounds, advanced.extractCrawlMaxRounds);
                advanced.extractCrawlCandidateLimit = clampByField('extractCrawlCandidateLimit', draft.extractCrawlCandidateLimit, advanced.extractCrawlCandidateLimit);
                advanced.extractCrawlMaxReads = clampByField('extractCrawlMaxReads', draft.extractCrawlMaxReads, advanced.extractCrawlMaxReads);
                modalViz.destroy();
                cadenceVisualizer.setParams(advanced);
                paint();
                notifyDirtyIfChanged();
                return true;
            },
        });

        // Clean up the modal visualizer's interval whenever the modal closes via Cancel/Escape/backdrop.
        const observer = typeof MutationObserver === 'function'
            ? new MutationObserver(() => {
                if (!modalViz.el.isConnected) {
                    modalViz.destroy();
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
            : i18n('Context & mode');

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

        cadenceSummaryEl = h('p', { class: 'ml-settings-cadence-summary', text: formatCadenceSummary(advanced) });
        const gapText = formatGapWarning(detectVisibilityGap(advanced));
        gapWarningEl = h('div', { class: 'ml-settings-gap-warning', role: 'alert', hidden: !gapText, text: gapText });
        cadenceVisualizer.setParams(advanced);

        return h('section', { class: 'ml-aiset-group ml-settings-section', dataset: { settingsSection: 'extraction' } },
            sectionTitle(i18n('Extraction Cadence & Floor Hiding')),
            toggle('autoExtractionEnabled', i18n('Auto extraction')),
            toggle('autoCompressionEnabled', i18n('Auto compression')),
            fields(
                pick('extractApiPresetName', i18n('Extract API preset (Connection profile)'), connectionOptions('extractApiPresetName')),
                presetField('extractPresetName', i18n('Extract preset (params + prompt)'))),
            h('div', { class: 'ml-preset-grid-block' },
                h('div', { class: 'ml-aiset-label', text: i18n('Cadence & floor-hiding presets') }),
                h('div', { class: 'ml-preset-grid', role: 'group', 'aria-label': i18n('Cadence & floor-hiding presets') },
                    ...presetCards,
                    customCard)),
            cadenceVisualizer.el,
            cadenceSummaryEl,
            gapWarningEl);
    }

    // ---- Section 2: Prompt Injection & Recall ----------------------------
    function recallSection() {
        const { values, options } = view;
        const rag = values.recallMethod === 'rag';
        const atDepth = Number(values.recallInjectPosition) === Number(options.positions.atDepth);
        const p = options.positions;
        return h('section', { class: 'ml-aiset-group ml-settings-section', dataset: { settingsSection: 'recall' } },
            sectionTitle(i18n('Prompt Injection & Recall')),
            toggle('recallEnabled', i18n('Enable recall injection')),
            h('div', { class: 'ml-settings-subblock' },
                h('div', { class: 'ml-aiset-label', text: i18n('Persistent Injection') }),
                h('p', { class: 'ml-settings-note', text: i18n('Types marked Always Visible and events are persistently injected without waiting for recall. Setting a recency horizon moves older entries back to the recall candidate pool.') }),
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
                    presetField('recallPresetName', i18n('Recall preset (params + prompt)'))) : null),
            h('div', { class: 'ml-settings-subblock' },
                h('div', { class: 'ml-aiset-label', text: i18n('Placement & Debug') }),
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
                    ].map(([value, label]) => ({ value: String(value), label: i18n(label) })))) : null,
                advCheck('includeWorldInfoWithPreset', i18n('Include world info')),
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

    // ---- Section 3: Graph Operations & Data ------------------------------
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

    function askRebuildRecent() {
        const latest = source.ops.latestSeq();
        if (latest <= 0) {
            surfaceError(new Error(i18n('No assistant turns available to rebuild.')));
            return;
        }
        // cap-ok: initial default input value clamped to available chat turns; max is latest
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
        if (!types.length) {
            surfaceError(new Error(i18n('No compressible types in current schema.')));
            return;
        }
        const scope = selectInput([{ value: 'all', label: i18n('All nodes') }, { value: 'older', label: i18n('Older nodes only (exclude recent N assistant turns)') }], 'older');
        const excludeRecent = h('input', { class: 'ml-schema-input', type: 'number', min: 0, step: 1, value: '2' });
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
        return h('section', { class: 'ml-aiset-group ml-settings-section', dataset: { settingsSection: 'operations' } },
            sectionTitle(i18n('Graph Operations & Data')),
            h('div', { class: 'ml-settings-stats', text: statsLine() }),
            actions(
                action(i18n('Fill Graph'), () => run(ops.fill)),
                action(i18n('Rebuild Graph'), () => confirmText(app, { title: i18n('Rebuild Graph'), lines: [i18n('Rebuild the whole graph from this chat?')], okLabel: i18n('Rebuild Graph'), danger: true, onOk: () => { void run(ops.rebuild); } })),
                action(i18n('Rebuild Recent'), askRebuildRecent),
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
                button(i18n('AI Configure Memory Graph'), () => openStudio(ops.openConfigStudio), { iconName: 'sparkle', disabled: busy }),
                button(i18n('AI Edit Graph'), () => openStudio(ops.openGraphStudio), { iconName: 'sparkle', disabled: busy })));
    }

    // ---- Section 4: Technical Tuning & Custom Prompts (collapsed) --------
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
            fields(
                pick('requestApiPresetName', i18n('Iteration AI API preset (Connection profile)'), connectionOptions('requestApiPresetName')),
                presetField('requestLlmPresetName', i18n('Iteration AI prompt preset (params + prompt)'))),
            fields(...visible.filter(field => field.kind === 'int').map(technicalControl)),
            visible.filter(field => field.kind === 'bool').map(technicalControl),
            visible.filter(field => field.kind === 'text').map(technicalControl)));
    }

    async function saveAdvanced(work, doneText) {
        clearError();
        try {
            await work();
            app.notify?.(doneText);
            reload();
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
        put(el, h('div', { class: 'ml-settings-inner' },
            group(
                toggle('enabled', i18n('Enabled')),
                statusEl,
                errorEl,
                busy ? button(i18n('Stop'), () => source.ops.stop(), { iconName: 'x', className: 'ml-btn-danger' }) : null,
                h('p', { class: 'ml-settings-note', text: i18n('The AI Workbench uses to edit these settings is selected in Workbench → Settings.') })),
            extractionSection(),
            recallSection(),
            operationsSection(),
            technicalSection(),
            scopeSaveBar()));
        el.scrollTop = scroll;
    }

    const editingHere = () => el.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

    void syncCadenceFeedback;

    return {
        id: 'settings',
        el,
        render() {
            if (!view || (needsReload && dirtyCount() === 0 && !editingHere() && !busy)) reload();
        },
        invalidate() { needsReload = true; },
        dirtyCount,
        destroy() {
            cadenceVisualizer.destroy();
            unsubscribeStatus();
            unsubscribeSettings();
        },
    };
}
