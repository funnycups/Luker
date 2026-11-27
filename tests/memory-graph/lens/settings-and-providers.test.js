/**
 * @jest-environment jsdom
 */
import './_mocks/luker-zh.js';
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { withMissing, withMissingProfiles } from '../../../public/scripts/extensions/memory-graph/lens/settings/settings-model.js';
import { createSettingsView } from '../../../public/scripts/extensions/memory-graph/lens/settings/settings-view.js';
import { createMemoryAskProvider, createMemorySuggestRuleProvider } from '../../../public/scripts/extensions/memory-graph/lens/providers.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

function flushMicrotasks() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function makeSettingsSnapshot(overrides = {}) {
    return {
        values: {
            enabled: true,
            autoExtractionEnabled: true,
            autoCompressionEnabled: true,
            recallEnabled: true,
            recallMethod: 'rag',
            embeddingProfileId: 'deleted-emb-id',
            rerankProfileId: 'deleted-rerank-id',
            ragUseRerank: true,
            ragUseQueryRewrite: false,
            vectorTopK: 20,
            hybridMaxResults: 15,
            ragDefaultPerTypeK: 0,
            ragRewriteApiPresetName: '',
            ragRewriteLlmPresetName: '',
            recallInjectPosition: 1,
            recallInjectDepth: 4,
            recallInjectRole: 0,
            recallApiPresetName: '',
            recallPresetName: '',
            extractApiPresetName: '',
            extractPresetName: '',
            requestApiPresetName: '',
            requestLlmPresetName: '',
            ...(overrides.values || {}),
        },
        options: {
            connections: ['MainAPI'],
            presets: ['DefaultPreset'],
            embeddingProfiles: [{ id: 'emb-1', name: 'Embed 1' }],
            rerankProfiles: [{ id: 'rr-1', name: 'Rerank 1' }],
            positions: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
            roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            compressibleTypes: [{ id: 'event', label: 'Event' }],
            ...(overrides.options || {}),
        },
        advanced: {
            values: {
                updateEvery: 2,
                extractBatchTurns: 2,
                extractContextTurns: 2,
                extractExcludeRecentTurns: 0,
                extractMode: 'oneshot',
                extractCrawlMaxRounds: 3,
                extractCrawlCandidateLimit: 40,
                extractCrawlMaxReads: 12,
                persistentInjectionMaxSeqDistance: 0,
                extractIncludeWorldInfo: true,
                recallIncludeWorldInfo: false,
                recallMaxIterations: 3,
                toolCallRetryMax: 2,
                rpmLimit: 0,
                recallQueryMessages: 4,
                llmVisibleRecentMessages: 5,
                extractConcurrent: false,
                extractCrawlSystemPrompt: 'crawl',
                extractTemplate: 'tmpl',
                extractEdgeRules: 'edge',
                recallRouteSystemPrompt: 'route',
                recallFinalizeSystemPrompt: 'fin',
                ragRewriteSystemPrompt: 'rw',
                configIterSystemPrompt: 'cfg',
                graphIterSystemPrompt: 'grp',
                ...(overrides.advancedValues || {}),
            },
            defaults: {
                updateEvery: 2,
                extractBatchTurns: 2,
                extractContextTurns: 2,
                extractExcludeRecentTurns: 0,
                extractMode: 'oneshot',
                llmVisibleRecentMessages: 5,
            },
            scope: 'global',
            hasAvatar: true,
            hasOverride: false,
            avatar: 'alice.png',
            characterName: 'Alice',
        },
    };
}

describe('settings-model helpers', () => {
    test('withMissingProfiles preserves deleted profile IDs with (missing) suffix', () => {
        const opts = withMissingProfiles(
            [{ id: 'emb-1', name: 'Embed 1' }],
            'deleted-id',
            '(unset)',
            '(missing)',
        );
        expect(opts).toEqual([
            { value: '', label: '(unset)' },
            { value: 'emb-1', label: 'Embed 1' },
            { value: 'deleted-id', label: 'deleted-id (missing)' },
        ]);
    });

    test('withMissing keeps string options and marks missing value', () => {
        expect(withMissing(['A'], 'B', '(none)', '(missing)')).toEqual([
            { value: '', label: '(none)' },
            { value: 'A', label: 'A' },
            { value: 'B', label: 'B (missing)' },
        ]);
    });
});

describe('settings-view UX reorganization & bug fixes', () => {
    const mountedViews = [];
    beforeEach(() => {
        for (const v of mountedViews.splice(0)) v.destroy?.();
        document.body.innerHTML = '';
        globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
    });
    afterEach(() => {
        for (const v of mountedViews.splice(0)) v.destroy?.();
    });

    function mountSettingsView(overrides = {}) {
        const snap = makeSettingsSnapshot(overrides.snap);
        const app = {
            root: document.createElement('div'),
            showToast: jest.fn(),
            notify: jest.fn(),
            refresh: jest.fn(),
            openStatus: jest.fn(),
            showInjection: jest.fn(),
        };
        const listeners = [];
        const source = {
            settings: {
                read: jest.fn(() => clone(snap)),
                set: jest.fn((k, v) => {
                    snap.values[k] = v;
                    return v;
                }),
                saveAdvanced: jest.fn(async () => {}),
                clearAdvanced: jest.fn(async () => {}),
                subscribe: jest.fn((cb) => {
                    listeners.push(cb);
                    return () => {};
                }),
            },
            ops: {
                status: () => 'Idle',
                onStatus: () => () => {},
                stats: () => ({ nodeCount: 10, edgeCount: 4, messageCount: 8, sourceMessageCount: 8, levelCount: { semantic: 10 } }),
                latestSeq: () => 3,
                rebuildRange: overrides.rebuildRange || (() => ({ latestSeq: 3, minFloor: 0, maxFloor: 4, assistantFloors: [0, 2, 4] })),
                stop: jest.fn(),
                fill: overrides.fill || jest.fn(async () => {}),
                rebuild: jest.fn(async () => {}),
                rebuildRecent: overrides.rebuildRecent || jest.fn(async () => {}),
                rebuildFromFloor: overrides.rebuildFromFloor || jest.fn(async () => {}),
                compress: jest.fn(async () => {}),
                reset: jest.fn(async () => {}),
                vectors: jest.fn(async () => {}),
                exportGraph: jest.fn(async () => {}),
                importGraph: jest.fn(async () => {}),
                recallDebug: jest.fn(async () => ({ selectedNodes: [], trace: [] })),
                rawJson: overrides.rawJson || jest.fn(async () => '{}'),
                readRawEdit: jest.fn(async () => ({ chatKey: 'c1', text: '{}' })),
                applyRawJson: jest.fn(async () => true),
                openConfigStudio: jest.fn(async () => {}),
                openGraphStudio: jest.fn(async () => {}),
            },
        };
        const onDirtyChange = overrides.onDirtyChange || jest.fn();
        const view = createSettingsView(app, source, { onDirtyChange });
        mountedViews.push(view);
        app.root.appendChild(view.el);
        document.body.appendChild(app.root);
        view.render();
        return { app, source, view, snap, listeners, onDirtyChange };
    }

    test('groups settings into 5 lifecycle sections with standalone extraction-mode and collapsed technical tuning', () => {
        const { view } = mountSettingsView();
        const sections = [...view.el.querySelectorAll('[data-settings-section]')].map(el => el.dataset.settingsSection);
        expect(sections).toEqual(['extraction', 'extraction-mode', 'recall', 'operations', 'technical']);

        const techDetails = view.el.querySelector('[data-settings-section="technical"]');
        expect(techDetails.tagName).toBe('DETAILS');
        expect(techDetails.open).toBe(false);
        expect(techDetails.querySelector('[data-field-key="llmVisibleRecentMessages"]')).toBeNull();
        expect(view.el.querySelector('[data-field-key="recentRawTurns"]')).toBeNull();
        expect(view.el.querySelector('[data-field-key="includeWorldInfoWithPreset"]')).toBeNull();
    });

    test('places extraction world-info toggle in extraction section and recall toggle in recall section only for LLM recall', () => {
        const { view: ragView } = mountSettingsView({ snap: { values: { recallMethod: 'rag' } } });
        expect(ragView.el.querySelector('[data-settings-section="extraction"] [data-field-key="extractIncludeWorldInfo"]')).toBeTruthy();
        expect(ragView.el.querySelector('[data-settings-section="recall"] [data-field-key="recallIncludeWorldInfo"]')).toBeNull();
        expect(ragView.el.querySelector('[data-field-key="includeWorldInfoWithPreset"]')).toBeNull();

        const { view: llmView } = mountSettingsView({ snap: { values: { recallMethod: 'llm' } } });
        expect(llmView.el.querySelector('[data-settings-section="extraction"] [data-field-key="extractIncludeWorldInfo"]')).toBeTruthy();
        expect(llmView.el.querySelector('[data-settings-section="recall"] [data-field-key="recallIncludeWorldInfo"]')).toBeTruthy();
        expect(llmView.el.querySelector('[data-field-key="includeWorldInfoWithPreset"]')).toBeNull();
    });

    test('renders 2x3 preset grid, live animated visualizer, and live Style A behavioral summary with no inline cadence inputs', () => {
        const { view } = mountSettingsView();
        const presetCards = [...view.el.querySelectorAll('[data-cadence-preset]')];
        expect(presetCards.map(el => el.dataset.cadencePreset)).toEqual(['every_1', 'balanced', 'saver', 'long_window', 'no_hide']);
        expect(view.el.querySelector('[data-cadence-preset="balanced"]').getAttribute('aria-pressed')).toBe('true');
        expect(view.el.querySelector('[data-cadence-custom]')).toBeTruthy();
        expect(view.el.querySelector('.ml-cadence-demo')).toBeTruthy();

        const summary = view.el.querySelector('[data-settings-section="extraction"] .luker-bsum');
        expect(summary).toBeTruthy();
        expect(summary.textContent).toContain('2');
        expect(summary.textContent).toContain('5');
        expect(view.el.querySelector('[data-settings-section="extraction"] [data-field-key="updateEvery"]')).toBeNull();
        expect(view.el.querySelector('[data-settings-section="extraction"] [data-field-key="extractBatchTurns"]')).toBeNull();
        expect(view.el.querySelector('[data-settings-section="extraction-mode"] .luker-bsum')).toBeTruthy();
        expect(view.el.querySelector('[data-settings-section="recall"] .luker-bsum')).toBeTruthy();
        expect(view.el.querySelector('[data-settings-section="technical"] .luker-bsum')).toBeTruthy();
    });

    test('clicking a preset card marks sticky bar dirty with count and Discard reverts to clean', () => {
        const { view, onDirtyChange } = mountSettingsView();
        expect(view.dirtyCount()).toBe(0);
        expect(view.el.querySelector('.ml-settings-sticky').classList.contains('is-dirty')).toBe(false);

        view.el.querySelector('[data-cadence-preset="saver"]').click();
        expect(view.el.querySelector('[data-cadence-preset="saver"]').getAttribute('aria-pressed')).toBe('true');
        expect(view.dirtyCount()).toBe(3); // updateEvery, extractBatchTurns, llmVisibleRecentMessages
        const sticky = view.el.querySelector('.ml-settings-sticky');
        expect(sticky.classList.contains('is-dirty')).toBe(true);
        expect(sticky.textContent).toContain('3');
        expect(onDirtyChange).toHaveBeenCalledWith(3);

        const discardBtn = view.el.querySelector('[data-settings-action="discard"]');
        expect(discardBtn).toBeTruthy();
        discardBtn.click();
        expect(view.dirtyCount()).toBe(0);
        expect(view.el.querySelector('.ml-settings-sticky').classList.contains('is-dirty')).toBe(false);
        expect(view.el.querySelector('[data-cadence-preset="balanced"]').getAttribute('aria-pressed')).toBe('true');
    });

    test('renders extraction mode and crawl inputs in standalone section independent of cadence presets', () => {
        const { view } = mountSettingsView();
        const modeSection = view.el.querySelector('[data-settings-section="extraction-mode"]');
        expect(modeSection).toBeTruthy();
        expect(modeSection.querySelector('[data-field-key="extractMode"] select').value).toBe('oneshot');
        expect(modeSection.querySelector('[data-field-key="extractCrawlMaxRounds"]')).toBeNull();
        expect(modeSection.querySelector('[data-field-key="extractCrawlCandidateLimit"]')).toBeNull();
        expect(modeSection.querySelector('[data-field-key="extractCrawlMaxReads"]')).toBeNull();

        // Switching to crawl reveals all 3 crawl inputs and marks sticky bar dirty
        const modeSelect = modeSection.querySelector('[data-field-key="extractMode"] select');
        modeSelect.value = 'crawl';
        modeSelect.dispatchEvent(new Event('change'));

        const updatedSection = view.el.querySelector('[data-settings-section="extraction-mode"]');
        const roundsInput = updatedSection.querySelector('[data-field-key="extractCrawlMaxRounds"] input');
        const candInput = updatedSection.querySelector('[data-field-key="extractCrawlCandidateLimit"] input');
        const readsInput = updatedSection.querySelector('[data-field-key="extractCrawlMaxReads"] input');
        expect(roundsInput).toBeTruthy();
        expect(candInput).toBeTruthy();
        expect(readsInput).toBeTruthy();
        expect(view.dirtyCount()).toBe(1);

        // Editing a crawl input keeps focus and updates dirty count in place
        readsInput.focus();
        readsInput.value = '18';
        readsInput.dispatchEvent(new Event('input'));
        expect(document.activeElement).toBe(readsInput);
        expect(view.dirtyCount()).toBe(2);

        // Clicking a cadence preset leaves extractMode and crawl parameters untouched
        view.el.querySelector('[data-cadence-preset="saver"]').click();
        const afterPreset = view.el.querySelector('[data-settings-section="extraction-mode"]');
        expect(afterPreset.querySelector('[data-field-key="extractMode"] select').value).toBe('crawl');
        expect(afterPreset.querySelector('[data-field-key="extractCrawlMaxReads"] input').value).toBe('18');
    });

    test('Custom card opens modal with only cadence/visibility inputs, live gap warning, and Cancel/Apply behavior', async () => {
        const { app, view } = mountSettingsView();
        view.el.querySelector('[data-cadence-custom]').click();

        const modal = app.root.querySelector('.ml-dialog');
        expect(modal).toBeTruthy();
        expect(modal.querySelector('[data-field-key="llmVisibleRecentMessages"] input')).toBeTruthy();
        expect(modal.querySelector('[data-field-key="updateEvery"] input')).toBeTruthy();
        expect(modal.querySelector('[data-field-key="extractBatchTurns"] input')).toBeTruthy();
        expect(modal.querySelector('[data-field-key="extractContextTurns"] input')).toBeTruthy();
        expect(modal.querySelector('[data-field-key="extractExcludeRecentTurns"] input')).toBeTruthy();
        expect(modal.querySelector('.ml-cadence-demo')).toBeTruthy();

        // Extraction mode & crawl inputs live in their own section, not inside the cadence modal
        expect(modal.querySelector('[data-field-key="extractMode"]')).toBeNull();
        expect(modal.querySelector('[data-field-key="extractCrawlMaxRounds"]')).toBeNull();

        // Enter gapped combo (updateEvery = 3, llmVisibleRecentMessages = 3)
        const everyInput = modal.querySelector('[data-field-key="updateEvery"] input');
        const visInput = modal.querySelector('[data-field-key="llmVisibleRecentMessages"] input');
        everyInput.value = '3';
        everyInput.dispatchEvent(new Event('input'));
        visInput.value = '3';
        visInput.dispatchEvent(new Event('input'));
        expect(modal.querySelector('.luker-bsum .luker-bsum-warn.is-warn')).toBeTruthy();

        // Apply writes to draft, highlights Custom card, shows gap warning in Section 1, and marks dirty
        const applyBtn = [...modal.querySelectorAll('footer button')].find(b => b.classList.contains('is-primary') || b.classList.contains('ml-btn-primary'));
        applyBtn.click();
        await flushMicrotasks();
        expect(app.root.querySelector('.ml-dialog')).toBeNull();
        expect(view.el.querySelector('[data-cadence-custom]').getAttribute('aria-pressed')).toBe('true');
        expect(view.el.querySelector('[data-settings-section="extraction"] .luker-bsum .luker-bsum-warn.is-warn')).toBeTruthy();
        expect(view.dirtyCount()).toBeGreaterThan(0);

        // Reopen modal, tweak, then Cancel leaves draft unchanged
        const countBefore = view.dirtyCount();
        view.el.querySelector('[data-cadence-custom]').click();
        const modal2 = app.root.querySelector('.ml-dialog');
        const everyInput2 = modal2.querySelector('[data-field-key="updateEvery"] input');
        everyInput2.value = '9';
        everyInput2.dispatchEvent(new Event('input'));
        const cancelBtn = [...modal2.querySelectorAll('footer button')][0];
        cancelBtn.click();
        expect(view.dirtyCount()).toBe(countBefore);
        expect(view.el.querySelector('[data-cadence-custom]').textContent).toContain('3');
        view.destroy();
    });

    test('clicking cadence/hiding tokens in Section 1 opens Custom modal focused on that field and hovering highlights active preset card', () => {
        const { app, view } = mountSettingsView();
        const section1 = view.el.querySelector('[data-settings-section="extraction"]');
        const activePreset = section1.querySelector('[data-cadence-preset="balanced"]');
        const visibleTok = section1.querySelector('[data-bsum-fields="llmVisibleRecentMessages"]');
        expect(visibleTok).toBeTruthy();

        // Hovering cross-scope token highlights active preset card
        visibleTok.dispatchEvent(new Event('pointerenter'));
        expect(activePreset.classList.contains('luker-bsum-field-linked')).toBe(true);
        visibleTok.dispatchEvent(new Event('pointerleave'));
        expect(activePreset.classList.contains('luker-bsum-field-linked')).toBe(false);

        // Clicking token opens Custom modal with summary card at top and focuses + pulses that input
        visibleTok.click();
        const modal = app.root.querySelector('.ml-dialog');
        expect(modal).toBeTruthy();
        expect(modal.querySelector('.ml-custom-cadence-modal .luker-bsum')).toBeTruthy();
        const visWrap = modal.querySelector('[data-field-key="llmVisibleRecentMessages"]');
        const visInput = visWrap.querySelector('input');
        expect(document.activeElement).toBe(visInput);
        expect(visWrap.classList.contains('luker-bsum-field-pulse')).toBe(true);

        // Typing inside modal updates the modal summary live without stealing focus
        visInput.value = '9';
        visInput.dispatchEvent(new Event('input'));
        expect(document.activeElement).toBe(visInput);
        expect(modal.querySelector('.ml-custom-cadence-modal .luker-bsum').textContent).toContain('9');
        view.destroy();
    });

    test('master enabled: false shows dormant notice in Enabled group while keeping Sections 1-5 live; enabled: true omits master notice from DOM; !recallEnabled keeps placement active', () => {
        const { view: enabledView } = mountSettingsView({
            snap: {
                values: {
                    enabled: true,
                },
            },
        });
        expect(enabledView.el.querySelector('[data-bsum-id="mg-master-notice"]')).toBeNull();

        // Toggling Memory Graph off mounts mg-master-notice; toggling back on omits it again
        const enabledSwitch = enabledView.el.querySelector('[data-field-key="enabled"][role="switch"]');
        expect(enabledSwitch).toBeTruthy();
        enabledSwitch.click();
        const mountedNotice = enabledView.el.querySelector('[data-bsum-id="mg-master-notice"]');
        expect(mountedNotice).toBeTruthy();
        expect(mountedNotice.hidden).toBe(false);
        expect(mountedNotice.classList.contains('is-dormant')).toBe(true);

        enabledView.el.querySelector('[data-field-key="enabled"][role="switch"]').click();
        expect(enabledView.el.querySelector('[data-bsum-id="mg-master-notice"]')).toBeNull();

        const { view } = mountSettingsView({
            snap: {
                values: {
                    enabled: false,
                    recallEnabled: false,
                    recallInjectPosition: 6,
                },
            },
        });
        const masterNotice = view.el.querySelector('[data-bsum-id="mg-master-notice"]');
        expect(masterNotice).toBeTruthy();
        expect(masterNotice.hidden).toBe(false);
        expect(masterNotice.classList.contains('is-dormant')).toBe(true);

        // Sections 1-3 remain live active cards
        expect(view.el.querySelector('[data-settings-section="extraction"] .luker-bsum.is-active')).toBeTruthy();
        expect(view.el.querySelector('[data-settings-section="extraction-mode"] .luker-bsum.is-active')).toBeTruthy();

        // Recall section dims RAG controls when !recallEnabled but keeps placement controls un-dimmed
        const recallSec = view.el.querySelector('[data-settings-section="recall"]');
        expect(recallSec.querySelector('[data-field-key="recallMethod"]').classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(recallSec.querySelector('[data-field-key="recallInjectPosition"]').classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(recallSec.querySelector('[data-field-key="recallInjectDepth"]').classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(recallSec.querySelector('[data-field-key="recallInjectRole"]').classList.contains('luker-bsum-field-dormant')).toBe(false);
    });

    test('editing a Technical input updates dirty bar in place without losing focus and clears when reverted', () => {
        const { view } = mountSettingsView();
        const rpmInput = view.el.querySelector('[data-field-key="rpmLimit"] input');
        rpmInput.focus();
        rpmInput.value = '30';
        rpmInput.dispatchEvent(new Event('input'));
        expect(document.activeElement).toBe(rpmInput);
        expect(view.dirtyCount()).toBe(1);
        expect(view.el.querySelector('.ml-settings-sticky').classList.contains('is-dirty')).toBe(true);

        rpmInput.value = '0';
        rpmInput.dispatchEvent(new Event('input'));
        expect(document.activeElement).toBe(rpmInput);
        expect(view.dirtyCount()).toBe(0);
        expect(view.el.querySelector('.ml-settings-sticky').classList.contains('is-dirty')).toBe(false);
    });

    test('marks deleted embeddingProfileId and rerankProfileId with (missing)', () => {
        const { view } = mountSettingsView();
        const embSelect = view.el.querySelector('[data-field-key="embeddingProfileId"] select');
        const rrSelect = view.el.querySelector('[data-field-key="rerankProfileId"] select');
        expect(embSelect).toBeTruthy();
        expect(rrSelect).toBeTruthy();
        expect([...embSelect.options].some(o => o.value === 'deleted-emb-id' && o.textContent.includes('deleted-emb-id'))).toBe(true);
        expect([...rrSelect.options].some(o => o.value === 'deleted-rerank-id' && o.textContent.includes('deleted-rerank-id'))).toBe(true);
    });

    test('shows import and derive actions beside preset fields', () => {
        const { view } = mountSettingsView({ snap: { options: { presets: ['plugin-only', 'DefaultPreset'] } } });
        const actions = view.el.querySelectorAll('.ml-preset-actions');
        expect(actions.length).toBe(2);
        expect(view.el.textContent).toContain('重新导入示例');
        expect(view.el.textContent).toContain('从现有预设派生');
        expect(view.el.textContent).toContain('修改这些配置所用的 AI 在工作台 → 设置中选择。');
    });

    test('surfaces async run errors and rawJson rejections via toast and persistent error banner without paint() wiping them', async () => {
        const fill = jest.fn(async () => { throw new Error('fill boom'); });
        const rawJson = jest.fn(async () => { throw new Error('rawJson boom'); });
        const { app, view } = mountSettingsView({ fill, rawJson });

        const fillBtn = [...view.el.querySelectorAll('button')].find(b => b.textContent.includes('生成图') || b.textContent.includes('Fill Graph'));
        fillBtn.click();
        await flushMicrotasks();

        expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('fill boom'), expect.objectContaining({ error: true }));
        const errBanner = view.el.querySelector('.ml-settings-error');
        expect(errBanner).toBeTruthy();
        expect(errBanner.textContent).toContain('fill boom');

        const rawBtn = [...view.el.querySelectorAll('button')].find(b => b.textContent.includes('查看图谱 JSON') || b.textContent.includes('View graph JSON'));
        rawBtn.click();
        await flushMicrotasks();

        expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('rawJson boom'), expect.objectContaining({ error: true }));
        expect(view.el.querySelector('.ml-settings-error').textContent).toContain('rawJson boom');
    });

    test('clearing floor-hiding input in Custom modal keeps previous value on Apply instead of silently disabling hiding', async () => {
        const { app, view } = mountSettingsView({
            snap: {
                advancedValues: {
                    updateEvery: 3,
                    extractBatchTurns: 3,
                    llmVisibleRecentMessages: 7,
                },
            },
        });
        view.el.querySelector('[data-cadence-custom]').click();
        const modal = app.root.querySelector('.ml-dialog');
        const visInput = modal.querySelector('[data-field-key="llmVisibleRecentMessages"] input');
        expect(visInput.value).toBe('7');

        visInput.value = '';
        visInput.dispatchEvent(new Event('input'));
        expect(modal.querySelector('.ml-custom-cadence-modal .luker-bsum').textContent).toContain('7');

        const applyBtn = [...modal.querySelectorAll('footer button')].find(b => b.classList.contains('is-primary') || b.classList.contains('ml-btn-primary'));
        applyBtn.click();
        await flushMicrotasks();

        // Must retain 7 (saver preset), NOT silently flip to 0 (no_hide)
        expect(view.el.querySelector('[data-cadence-preset="saver"]').getAttribute('aria-pressed')).toBe('true');
        expect(view.dirtyCount()).toBe(0);
    });

    test('cadence visualizer pauses stepping while an ancestor container is hidden', () => {
        jest.useFakeTimers();
        try {
            const { app, view } = mountSettingsView();
            const demo = view.el.querySelector('.ml-cadence-demo');
            const initialStep = demo.dataset.step;

            // Hide ancestor wrapper (mirrors inactive .ml-view or collapsed wb-win)
            app.root.hidden = true;
            jest.advanceTimersByTime(10_000);
            expect(demo.dataset.step).toBe(initialStep);

            // Unhide ancestor → stepping resumes
            app.root.hidden = false;
            jest.advanceTimersByTime(3_000);
            expect(demo.dataset.step).not.toBe(initialStep);
        } finally {
            jest.useRealTimers();
        }
    });

    test('Discard changes reloads fresh settings when an external update arrived while dirty', () => {
        const { view, snap, listeners } = mountSettingsView();
        view.el.querySelector('[data-cadence-preset="saver"]').click();
        expect(view.dirtyCount()).toBe(3);

        // External commit updates saved settings while the view is dirty
        snap.advanced.values.rpmLimit = 42;
        listeners.forEach(fn => fn());

        // Still preserves local draft until Discard
        expect(view.dirtyCount()).toBe(3);

        // Clicking Discard must load the fresh saved rpmLimit (42), not stale 0
        view.el.querySelector('[data-settings-action="discard"]').click();
        expect(view.dirtyCount()).toBe(0);
        expect(view.el.querySelector('[data-field-key="rpmLimit"] input').value).toBe('42');
    });

    test('refreshes profile options when source subscription fires', () => {
        const { view, snap, listeners } = mountSettingsView();
        expect(listeners.length).toBe(1);
        snap.options.connections.push('BrandNewProfile');
        listeners[0]();
        const connSelect = view.el.querySelector('[data-field-key="extractApiPresetName"] select');
        expect([...connSelect.options].some(o => o.value === 'BrandNewProfile')).toBe(true);
    });

    test('partial rebuild modal supports both recent N turns and starting from floor N', async () => {
        const rebuildRecent = jest.fn(async () => {});
        const rebuildFromFloor = jest.fn(async () => {});
        const { app, view } = mountSettingsView({ rebuildRecent, rebuildFromFloor });

        const opsBtn = [...view.el.querySelectorAll('[data-settings-section="operations"] button')]
            .find(b => b.dataset.rebuildRange === 'true');
        expect(opsBtn).toBeTruthy();

        // 1) Recent mode submits rebuildRecent(2)
        opsBtn.click();
        let modal = app.root.querySelector('.ml-dialog');
        expect(modal).toBeTruthy();
        const modeBtns = [...modal.querySelectorAll('.lw-seg-btn')];
        expect(modeBtns).toHaveLength(2);
        expect(modeBtns[0].getAttribute('aria-pressed')).toBe('true');

        let input = modal.querySelector('input[type="number"]');
        input.value = '2';
        input.dispatchEvent(new Event('input'));
        expect(modal.querySelector('.ml-settings-note').textContent).toContain('2-4');

        let okBtn = [...modal.querySelectorAll('footer button')].find(b => b.classList.contains('is-primary'));
        okBtn.click();
        await flushMicrotasks();
        expect(rebuildRecent).toHaveBeenCalledWith(2);
        expect(app.root.querySelector('.ml-dialog')).toBeNull();

        // 2) Switch to from-floor mode, verify validation (blank & out-of-range), then submit floor 0 and user floor 1
        opsBtn.click();
        modal = app.root.querySelector('.ml-dialog');
        modal.querySelectorAll('.lw-seg-btn')[1].click();
        expect(modal.querySelectorAll('.lw-seg-btn')).toHaveLength(2);
        expect(modal.querySelectorAll('.lw-seg-btn')[1].getAttribute('aria-pressed')).toBe('true');

        input = modal.querySelector('input[type="number"]');
        expect(input.min).toBe('0');
        expect(input.max).toBe('4');
        expect(input.value).toBe('4');

        // Blank input must NOT coerce to 0
        input.value = '';
        input.dispatchEvent(new Event('input'));
        okBtn = [...modal.querySelectorAll('footer button')].find(b => b.classList.contains('is-primary'));
        okBtn.click();
        await flushMicrotasks();
        expect(rebuildFromFloor).not.toHaveBeenCalled();
        expect(app.notify).toHaveBeenCalled();
        expect(app.root.querySelector('.ml-dialog')).toBeTruthy();

        // Floor 0 is valid and invokes rebuildFromFloor(0)
        app.notify.mockClear();
        input.value = '0';
        input.dispatchEvent(new Event('input'));
        expect(modal.querySelector('.ml-settings-note').textContent).toContain('0-4');
        okBtn.click();
        await flushMicrotasks();
        expect(rebuildFromFloor).toHaveBeenCalledWith(0);
        expect(app.root.querySelector('.ml-dialog')).toBeNull();

        // User floor 1 is valid and maps to 2 assistant turns (floors 1-4)
        opsBtn.click();
        modal = app.root.querySelector('.ml-dialog');
        modal.querySelectorAll('.lw-seg-btn')[1].click();
        input = modal.querySelector('input[type="number"]');
        input.value = '1';
        input.dispatchEvent(new Event('input'));
        expect(modal.querySelector('.ml-settings-note').textContent).toContain('1-4');
        expect(modal.querySelector('.ml-settings-note').textContent).toContain('2');
        okBtn = [...modal.querySelectorAll('footer button')].find(b => b.classList.contains('is-primary'));
        okBtn.click();
        await flushMicrotasks();
        expect(rebuildFromFloor).toHaveBeenCalledWith(1);
    });

    test('partial rebuild surfaces error when no assistant turns are rebuildable', () => {
        const { app, view } = mountSettingsView({
            rebuildRange: () => ({ latestSeq: 0, minFloor: 0, maxFloor: -1, assistantFloors: [] }),
        });
        const opsBtn = [...view.el.querySelectorAll('[data-settings-section="operations"] button')]
            .find(b => b.dataset.rebuildRange === 'true');
        expect(opsBtn).toBeTruthy();
        opsBtn.click();
        expect(app.root.querySelector('.ml-dialog')).toBeNull();
        expect(app.showToast).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: true }));
    });

    test('manual compression modal renders live summary, hides conditional fields, and submits unlimited or limited merges', async () => {
        const { app, source, view } = mountSettingsView({
            snap: {
                options: {
                    compressibleTypes: [{
                        id: 'chronicle_mark',
                        label: 'Chronicle Mark',
                        mode: 'hierarchical',
                        threshold: 5,
                        fanIn: 3,
                        maxDepth: 10,
                        keepRecentLeaves: 3,
                    }],
                },
            },
        });
        const compressBtn = [...view.el.querySelectorAll('[data-settings-section="operations"] button')]
            .find(b => b.textContent.includes('手动压缩') || b.textContent.includes('Manual Compress'));
        expect(compressBtn).toBeTruthy();
        compressBtn.click();

        let modal = app.root.querySelector('.ml-manual-compress-modal');
        expect(modal).toBeTruthy();

        const summary = modal.querySelector('.luker-bsum[data-bsum-id="mg-manual-compress-modal"]');
        expect(summary).toBeTruthy();
        expect(summary.querySelectorAll('.luker-bsum-row')).toHaveLength(3);
        expect(summary.textContent).toContain('Chronicle Mark');
        expect(summary.textContent).toContain('5');
        expect(summary.textContent).toContain('3');
        expect(summary.textContent).toContain('10');

        const excludeWrap = modal.querySelector('[data-field-key="excludeRecent"]');
        const roundsWrap = modal.querySelector('[data-field-key="maxRoundsPerType"]');
        expect(excludeWrap.hidden).toBe(false);
        expect(roundsWrap.hidden).toBe(true);

        // Switching scope to 'all' hides excludeRecent and updates summary live
        const scopeSelect = modal.querySelector('[data-field-key="scope"] select');
        scopeSelect.value = 'all';
        scopeSelect.dispatchEvent(new Event('change'));
        expect(excludeWrap.hidden).toBe(true);

        // Switching stop rule to 'limited' reveals maxRoundsPerType and updates summary without losing focus
        const limitSelect = modal.querySelector('[data-field-key="roundLimitMode"] select');
        limitSelect.value = 'limited';
        limitSelect.dispatchEvent(new Event('change'));
        expect(roundsWrap.hidden).toBe(false);

        const roundsInput = roundsWrap.querySelector('input');
        roundsInput.focus();
        roundsInput.value = '7';
        roundsInput.dispatchEvent(new Event('input'));
        expect(document.activeElement).toBe(roundsInput);
        expect(summary.textContent).toContain('7');

        // Unchecking the only type surfaces a warning and blocks submission
        const typeCheck = modal.querySelector('[data-field-key="selectedTypeIds"] button[role="checkbox"]');
        typeCheck.click();
        expect(summary.classList.contains('is-warn')).toBe(true);
        let okBtn = [...app.root.querySelectorAll('.ml-dialog footer button')].find(b => b.classList.contains('is-primary'));
        okBtn.click();
        await flushMicrotasks();
        expect(app.notify).toHaveBeenCalled();
        expect(source.ops.compress).not.toHaveBeenCalled();
        expect(app.root.querySelector('.ml-dialog')).toBeTruthy();

        // Re-check type, switch back to unlimited, and submit -> maxRoundsPerType: null
        typeCheck.click();
        expect(summary.classList.contains('is-warn')).toBe(false);
        limitSelect.value = 'unlimited';
        limitSelect.dispatchEvent(new Event('change'));
        expect(roundsWrap.hidden).toBe(true);
        okBtn.click();
        await flushMicrotasks();
        expect(source.ops.compress).toHaveBeenCalledWith({
            scope: 'all',
            mode: 'schema',
            excludeRecent: 2,
            maxRoundsPerType: null,
            selectedTypeIds: ['chronicle_mark'],
        });
        expect(app.root.querySelector('.ml-dialog')).toBeNull();

        // Reopen and submit limited mode with 4 merges
        source.ops.compress.mockClear();
        compressBtn.click();
        modal = app.root.querySelector('.ml-manual-compress-modal');
        const limitSelect2 = modal.querySelector('[data-field-key="roundLimitMode"] select');
        limitSelect2.value = 'limited';
        limitSelect2.dispatchEvent(new Event('change'));
        const roundsInput2 = modal.querySelector('[data-field-key="maxRoundsPerType"] input');
        roundsInput2.value = '4';
        roundsInput2.dispatchEvent(new Event('input'));
        okBtn = [...app.root.querySelectorAll('.ml-dialog footer button')].find(b => b.classList.contains('is-primary'));
        okBtn.click();
        await flushMicrotasks();
        expect(source.ops.compress).toHaveBeenCalledWith({
            scope: 'older',
            mode: 'schema',
            excludeRecent: 2,
            maxRoundsPerType: 4,
            selectedTypeIds: ['chronicle_mark'],
        });
    });
});

describe('Workbench providers for memory-graph', () => {
    test('AskProvider and SuggestRuleProvider produce expected snapshots, tools, and rules', async () => {
        const fakeCtx = {
            chat: [{ is_user: true }, ...Array.from({ length: 205 }, () => ({ is_user: false, mes: 'hi' }))],
            getCurrentChatId: () => 'chat_1',
            getTokenCountAsync: async (t) => String(t || '').length,
            chatMetadata: { memory_lens_tokens: { entries: [{ core: 200 }, { core: 200 }, { core: 200 }, { core: 200 }, { core: 200 }] } },
            getExtensionApi: (name) => name === 'memory-graph' ? {
                getSchemaScopeInfo: () => ({ schema: [{ id: 'event', compression: { mode: 'hierarchical', threshold: 6 } }], scope: 'global' }),
                getAdvancedScopeInfo: () => ({ settings: { persistentInjectionMaxSeqDistance: 0 }, scope: 'global' }),
                getLastRecallProjection: async () => ({ at: 1234, blocks: { corePacket: 'x'.repeat(1000), focusPacket: 'y'.repeat(50) } }),
            } : null,
        };
        const askProvider = createMemoryAskProvider(() => fakeCtx, {
            getSettings: () => ({}),
            ensureMemoryStoreLoaded: async () => ({ nodes: {} }),
            getMemoryGraphReadApi: () => ({
                listNodes: () => [
                    ...Array.from({ length: 55 }, (_, i) => ({ id: `e${i}`, type: 'event', archived: false, semantic_depth: 0, parent_id: '' })),
                    { id: 'e_merged', type: 'event', archived: false, semantic_depth: 0, parent_id: 'r_1' },
                    { id: 'r_1', type: 'event', archived: false, semantic_depth: 1, parent_id: '' },
                ],
            }),
        });

        const pSnap = await askProvider.getSnapshot(fakeCtx);
        expect(pSnap.installed).toBe(true);
        expect(pSnap.unmerged).toBe(55);
        expect(pSnap.core).toBe(1000);
        expect(askProvider.tools.map(t => t.function.name)).toEqual(['wb_read_memory']);
        expect(askProvider.overviewKey).toBe('记忆图');
        expect(await askProvider.getOverview(fakeCtx)).toEqual({
            节点: 57,
            常驻: 1000,
            本次召回: 50,
        });
        expect(await askProvider.readers.wb_read_memory({ part: 'core' }, fakeCtx)).toBe('x'.repeat(1000));
        expect(await askProvider.readers.wb_read_memory({ part: 'summary' }, { getExtensionApi: () => null })).toEqual({ error: '没有记忆图' });
        const summaryWithRecall = await askProvider.readers.wb_read_memory({ part: 'summary' }, { ...fakeCtx, getCurrentLocale: () => 'en-US' });
        expect(summaryWithRecall.lastRecall).toBe(new Date(1234).toLocaleString('en-US'));
        const summaryNoRecall = await askProvider.readers.wb_read_memory({ part: 'summary' }, {
            ...fakeCtx,
            getExtensionApi: () => ({
                getSchemaScopeInfo: () => ({ schema: [], scope: 'global' }),
                getAdvancedScopeInfo: () => ({ settings: {}, scope: 'global' }),
                getLastRecallProjection: async () => null,
            }),
        });
        expect(summaryNoRecall.lastRecall).toBe('尚未召回');

        const suggestProvider = createMemorySuggestRuleProvider();
        expect(suggestProvider.rules.map(r => r.id)).toEqual(['memory.coreHigh', 'memory.unmerged', 'memory.horizon']);
        const snap = { memory: pSnap, budget: { max: 4000 } };
        for (const rule of suggestProvider.rules) {
            expect(rule.check(snap)).toBeTruthy();
        }
    });
});
