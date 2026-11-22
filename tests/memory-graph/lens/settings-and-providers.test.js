/**
 * @jest-environment jsdom
 */
import './_mocks/luker-zh.js';
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { withMissing, withMissingProfiles, formatCadenceSummary } from '../../../public/scripts/extensions/memory-graph/lens/settings/settings-model.js';
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
                includeWorldInfoWithPreset: false,
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

    test('formatCadenceSummary produces a deterministic factual summary', () => {
        const text = formatCadenceSummary({
            updateEvery: 2,
            extractBatchTurns: 3,
            extractContextTurns: 5,
            extractExcludeRecentTurns: 1,
        });
        expect(text).toContain('2');
        expect(text).toContain('3');
        expect(text).toContain('5');
        expect(text).toContain('1');
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
                latestSeq: () => 5,
                stop: jest.fn(),
                fill: overrides.fill || jest.fn(async () => {}),
                rebuild: jest.fn(async () => {}),
                rebuildRecent: jest.fn(async () => {}),
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

    test('groups settings into 4 lifecycle sections with collapsed technical tuning', () => {
        const { view } = mountSettingsView();
        const sections = [...view.el.querySelectorAll('[data-settings-section]')].map(el => el.dataset.settingsSection);
        expect(sections).toEqual(['extraction', 'recall', 'operations', 'technical']);

        const techDetails = view.el.querySelector('[data-settings-section="technical"]');
        expect(techDetails.tagName).toBe('DETAILS');
        expect(techDetails.open).toBe(false);
        expect(techDetails.querySelector('[data-field-key="llmVisibleRecentMessages"]')).toBeNull();
        expect(view.el.querySelector('[data-field-key="recentRawTurns"]')).toBeNull();
    });

    test('renders 2x3 preset grid, live animated visualizer, and unified summary with no inline cadence inputs', () => {
        const { view } = mountSettingsView();
        const presetCards = [...view.el.querySelectorAll('[data-cadence-preset]')];
        expect(presetCards.map(el => el.dataset.cadencePreset)).toEqual(['every_1', 'balanced', 'saver', 'long_window', 'no_hide']);
        expect(view.el.querySelector('[data-cadence-preset="balanced"]').getAttribute('aria-pressed')).toBe('true');
        expect(view.el.querySelector('[data-cadence-custom]')).toBeTruthy();
        expect(view.el.querySelector('.ml-cadence-demo')).toBeTruthy();

        const summary = view.el.querySelector('.ml-settings-cadence-summary');
        expect(summary).toBeTruthy();
        expect(summary.textContent).toContain('2');
        expect(summary.textContent).toContain('5');
        expect(view.el.querySelector('[data-settings-section="extraction"] [data-field-key="updateEvery"]')).toBeNull();
        expect(view.el.querySelector('[data-settings-section="extraction"] [data-field-key="extractBatchTurns"]')).toBeNull();
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

    test('Custom card opens modal with all cadence/visibility/crawl inputs, live gap warning, and Cancel/Apply behavior', async () => {
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

        // Crawl inputs hidden until extractMode === 'crawl'
        expect(modal.querySelector('[data-field-key="extractCrawlMaxRounds"]')).toBeNull();
        const modeSelect = modal.querySelector('[data-field-key="extractMode"] select');
        modeSelect.value = 'crawl';
        modeSelect.dispatchEvent(new Event('change'));
        expect(modal.querySelector('[data-field-key="extractCrawlMaxRounds"]')).toBeTruthy();

        // Enter gapped combo (updateEvery = 3, llmVisibleRecentMessages = 3)
        const everyInput = modal.querySelector('[data-field-key="updateEvery"] input');
        const visInput = modal.querySelector('[data-field-key="llmVisibleRecentMessages"] input');
        everyInput.value = '3';
        everyInput.dispatchEvent(new Event('input'));
        visInput.value = '3';
        visInput.dispatchEvent(new Event('input'));
        expect(modal.querySelector('.ml-settings-gap-warning').hidden).toBe(false);

        // Apply writes to draft, highlights Custom card, shows gap warning in Section 1, and marks dirty
        const applyBtn = [...modal.querySelectorAll('footer button')].find(b => b.classList.contains('is-primary') || b.classList.contains('ml-btn-primary'));
        applyBtn.click();
        await flushMicrotasks();
        expect(app.root.querySelector('.ml-dialog')).toBeNull();
        expect(view.el.querySelector('[data-cadence-custom]').getAttribute('aria-pressed')).toBe('true');
        expect(view.el.querySelector('.ml-settings-gap-warning').hidden).toBe(false);
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
        expect(modal.querySelector('.ml-settings-cadence-summary').textContent).toContain('7');

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
