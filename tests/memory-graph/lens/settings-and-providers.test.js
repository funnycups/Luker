/**
 * @jest-environment jsdom
 */
import './_mocks/luker-zh.js';
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
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
            updateEvery: 2,
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
                extractBatchTurns: 2,
                extractContextTurns: 4,
                extractExcludeRecentTurns: 1,
                extractMode: 'oneshot',
                extractCrawlMaxRounds: 3,
                extractCrawlCandidateLimit: 40,
                extractCrawlMaxReads: 12,
                persistentInjectionMaxSeqDistance: 0,
                recentRawTurns: 2,
                includeWorldInfoWithPreset: false,
                recallMaxIterations: 3,
                toolCallRetryMax: 2,
                rpmLimit: 0,
                recallQueryMessages: 4,
                llmVisibleRecentMessages: 0,
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
                extractBatchTurns: 1,
                extractContextTurns: 4,
                extractExcludeRecentTurns: 0,
                extractMode: 'oneshot',
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
    beforeEach(() => {
        document.body.innerHTML = '';
        globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
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
        const view = createSettingsView(app, source);
        app.root.appendChild(view.el);
        document.body.appendChild(app.root);
        view.render();
        return { app, source, view, snap, listeners };
    }

    test('groups settings into 4 lifecycle sections with collapsed technical tuning', () => {
        const { view } = mountSettingsView();
        const sections = [...view.el.querySelectorAll('[data-settings-section]')].map(el => el.dataset.settingsSection);
        expect(sections).toEqual(['extraction', 'recall', 'operations', 'technical']);

        const techDetails = view.el.querySelector('[data-settings-section="technical"]');
        expect(techDetails.tagName).toBe('DETAILS');
        expect(techDetails.open).toBe(false);
    });

    test('displays deterministic cadence summary and shows crawl fields only when extractMode is crawl', () => {
        const { view } = mountSettingsView();
        const summary = view.el.querySelector('.ml-settings-cadence-summary');
        expect(summary).toBeTruthy();
        expect(summary.textContent).toContain('2');
        expect(summary.textContent).toContain('4');
        expect(summary.textContent).toContain('1');

        expect(view.el.querySelector('[data-field-key="extractCrawlMaxRounds"]')).toBeNull();
        const modeSelect = view.el.querySelector('[data-field-key="extractMode"] select');
        expect(modeSelect).toBeTruthy();
        modeSelect.value = 'crawl';
        modeSelect.dispatchEvent(new Event('change'));
        expect(view.el.querySelector('[data-field-key="extractCrawlMaxRounds"]')).toBeTruthy();
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
                    ...Array.from({ length: 55 }, (_, i) => ({ id: `e${i}`, type: 'event', archived: false, semanticDepth: 0, parentId: '' })),
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
            节点: 55,
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
