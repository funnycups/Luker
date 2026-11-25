// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';
import { extensionSettingsMock } from './_mocks/main-module-stack.js';

let activeChatFile = 'chat-compression-rollup-0';
const toastrErrors = [];
const toastrSuccesses = [];
const toastrInfos = [];

globalThis.toastr = {
    info: (msg) => { toastrInfos.push(String(msg || '')); return null; },
    success: (msg) => { toastrSuccesses.push(String(msg || '')); return null; },
    warning: () => null,
    error: (msg) => { toastrErrors.push(String(msg || '')); return null; },
    clear: () => {},
};

const baseLukerCtx = globalThis.Luker.getContext();
const customLukerCtx = new Proxy({
    constants: {
        promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        promptTypes: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
        wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        unset: Symbol('UNSET_VALUE'),
    },
    resolveChatStateTarget: (explicitTarget = null) => {
        if (explicitTarget && typeof explicitTarget === 'object') {
            return explicitTarget;
        }
        return {
            is_group: false,
            avatar_url: 'avatar.png',
            file_name: activeChatFile,
        };
    },
    saveSettings: () => Promise.resolve(),
    saveSettingsDebounced: () => {},
    extensionSettings: extensionSettingsMock,
    download: () => {},
    getFileText: () => Promise.resolve(''),
    getStringHash: () => '',
    worldInfoEntry: {
        template: {},
        setGlobalSelection: () => {},
    },
    stateErrors: baseLukerCtx.stateErrors,
    regex: baseLukerCtx.regex,
    getExtensionApi: baseLukerCtx.getExtensionApi,
    registerExtensionApi: () => {},
    translate: (s) => String(s ?? ''),
    addLocaleData: () => {},
    getCurrentLocale: () => 'en-US',
}, {
    get(target, prop) {
        if (prop in target) return target[prop];
        return baseLukerCtx[prop];
    },
});

globalThis.Luker = { getContext: () => customLukerCtx };
globalThis.st = globalThis.Luker;
globalThis.SillyTavern = globalThis.Luker;

let createEmptyStore;
let resetFloorStateInstance;
let createFloorStateWithDeps;
let configureOverrides;
let normalizeNodeTypeSchema;
let normalizeAdvancedSettings;
let defaultSettings;
let getDefaultNodeTypeSchema;
let applyExtractionOpsImpl;
let createNode;
let createRollupWithChildren;
let isRollupNode;
let summarizeRollupWithLLM;
let buildCompressionRuleMatcher;
let runCompressionLoop;
let runExtractionForStore;
let runManualCompression;
let ensureMemoryStoreLoaded;
let commitGraphUiMutation;
let getChatKey;
let getRawGraphJson;
let stopMemoryExtraction;

beforeAll(async () => {
    const persistence = await import('../../public/scripts/extensions/memory-graph/persistence.js');
    createEmptyStore = persistence.createEmptyStore;
    resetFloorStateInstance = persistence.resetFloorStateInstance;
    const floorStateMod = await import('../../public/scripts/floor-state.js');
    createFloorStateWithDeps = floorStateMod.createFloorStateWithDeps;
    const overrides = await import('../../public/scripts/extensions/memory-graph/character-overrides.js');
    configureOverrides = overrides.configure;
    const adv = await import('../../public/scripts/extensions/memory-graph/config-iteration/advanced-settings.js');
    normalizeAdvancedSettings = adv.normalizeAdvancedSettings;

    const main = await import('../../public/scripts/extensions/memory-graph/main.js');
    defaultSettings = main.defaultSettings;
    getDefaultNodeTypeSchema = main.getDefaultNodeTypeSchema;
    normalizeNodeTypeSchema = main.normalizeNodeTypeSchema;
    applyExtractionOpsImpl = main.applyExtractionOpsImpl;
    createNode = main._createNodeForTest;
    createRollupWithChildren = main.createRollupWithChildren;
    isRollupNode = main._isRollupNodeForTest;
    summarizeRollupWithLLM = main._summarizeRollupWithLLMForTest;
    buildCompressionRuleMatcher = main._buildCompressionRuleMatcherForTest;
    runCompressionLoop = main._runCompressionLoopForTest;
    runExtractionForStore = main._runExtractionForStoreForTest;
    runManualCompression = main.runManualCompression;
    ensureMemoryStoreLoaded = main.ensureMemoryStoreLoaded;
    commitGraphUiMutation = main.commitGraphUiMutation;
    getChatKey = main.getChatKey;
    getRawGraphJson = main.getRawGraphJson;
    stopMemoryExtraction = main.stopMemoryExtraction;
});

let chatCounter = 0;

function makeMomentSpec(overrides = {}) {
    return {
        id: 'moment',
        label: 'Memorable moment',
        tableName: 'moment_table',
        tableColumns: ['title', 'when', 'detail', 'meaning'],
        embeddingColumns: ['title', 'detail', 'meaning'],
        requiredColumns: ['title'],
        forceUpdate: false,
        editable: true,
        level: 'semantic',
        alwaysInject: false,
        latestOnly: false,
        primaryKeyColumns: [],
        compression: {
            mode: 'hierarchical',
            threshold: 2,
            fanIn: 2,
            maxDepth: 2,
            keepRecentLeaves: 0,
            rule: '',
            summarizeInstruction: '',
            ...(overrides.compression || {}),
        },
        ...overrides,
    };
}

function makeFloorStateHarness(chat, generateTaskImpl) {
    const partitions = new Map();
    function targetKey(target) {
        if (!target || typeof target !== 'object') return 'default';
        if (target.is_group) return `g:${String(target.id ?? '')}`;
        return `c:${String(target.avatar_url ?? '')}/${String(target.file_name ?? '')}`;
    }
    function partitionFor(target) {
        const key = targetKey(target);
        if (!partitions.has(key)) partitions.set(key, new Map());
        return partitions.get(key);
    }
    const buildObjectPatchOperationsAsync = async (prev, next) => {
        const { compare } = await import('../../public/scripts/util/fast-json-patch.js');
        return compare(prev ?? {}, next ?? {});
    };
    const getChatState = async (ns, options) => {
        const k = String(ns ?? '').trim().toLowerCase();
        const v = partitionFor(options?.target).get(k);
        return { ok: true, state: v == null ? null : structuredClone(v) };
    };
    const patchChatState = async (ns, ops, options) => {
        const k = String(ns ?? '').trim().toLowerCase();
        const part = partitionFor(options?.target);
        const current = part.get(k) ?? {};
        const { applyPatch } = await import('../../public/scripts/util/fast-json-patch.js');
        const next = structuredClone(current);
        applyPatch(next, ops, false, true);
        part.set(k, next);
        return true;
    };
    const updateChatState = async (ns, updater, options) => {
        const k = String(ns ?? '').trim().toLowerCase();
        const part = partitionFor(options?.target);
        const current = part.get(k) ?? null;
        const next = await updater(current == null ? null : structuredClone(current));
        if (next === null || next === undefined) {
            part.delete(k);
        } else {
            part.set(k, structuredClone(next));
        }
        return { ok: true, state: part.get(k) ?? null, updated: true };
    };

    const generateTask = jest.fn(generateTaskImpl);
    let floorStateInstance = null;

    const context = {
        chat,
        characters: [],
        characterId: null,
        worldNames: [],
        getChatState,
        patchChatState,
        updateChatState,
        buildObjectPatchOperationsAsync,
        createFloorState: async ({ namespace }) => {
            floorStateInstance = createFloorStateWithDeps({ namespace }, {
                getChatState,
                patchChatState: (...args) => context.patchChatState(...args),
                updateChatState: (...args) => context.updateChatState(...args),
                buildObjectPatchOperationsAsync,
                getChat: () => context.chat,
            });
            return floorStateInstance;
        },
        loadWorldInfo: async () => ({ entries: {} }),
        saveWorldInfo: async () => {},
        updateWorldInfoList: async () => {},
        generateTask,
    };

    return {
        context,
        generateTask,
        getFloorState: () => floorStateInstance,
    };
}

function makeChatForTurns(turnCount) {
    const chat = [];
    for (let i = 1; i <= turnCount; i += 1) {
        chat.push({ is_user: true, name: 'User', mes: `User turn ${i}` });
        chat.push({ is_user: false, name: 'Guide', mes: `Assistant turn ${i}` });
    }
    return chat;
}

function parsePromptRows(userPrompt) {
    return String(userPrompt || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

beforeEach(() => {
    chatCounter += 1;
    activeChatFile = `chat-compression-rollup-${chatCounter}`;
    resetFloorStateInstance();
    toastrErrors.length = 0;
    toastrSuccesses.length = 0;
    toastrInfos.length = 0;
    extensionSettingsMock.memory_graph = {
        ...structuredClone(defaultSettings),
        enabled: true,
        autoCompressionEnabled: true,
        nodeTypeSchema: getDefaultNodeTypeSchema(),
        extractBatchTurns: 1,
        extractContextTurns: 1,
        extractExcludeRecentTurns: 0,
        toolCallRetryMax: 0,
    };
    configureOverrides({
        MODULE_NAME: 'memory_graph',
        defaultSettings,
        normalizeNodeTypeSchema,
        normalizeAdvancedSettings,
        getSettings: () => extensionSettingsMock.memory_graph,
    });
});

describe('isRollupNode & createRollupWithChildren single-summary invariant', () => {
    test('isRollupNode identifies rollups by semanticRollup or positive semanticDepth', () => {
        expect(isRollupNode(null)).toBe(false);
        expect(isRollupNode({ semanticRollup: false, semanticDepth: 0 })).toBe(false);
        expect(isRollupNode({ semanticRollup: true, semanticDepth: 0 })).toBe(true);
        expect(isRollupNode({ semanticRollup: false, semanticDepth: 1 })).toBe(true);
        expect(isRollupNode({ semanticRollup: true, semanticDepth: 2 })).toBe(true);
    });

    test('createRollupWithChildren rejects empty/whitespace summary with BAD_ARGS', () => {
        const store = createEmptyStore();
        const c1 = createNode(store, { type: 'event', title: 'e1', fields: { summary: 'A' }, seqTo: 1 });
        const c2 = createNode(store, { type: 'event', title: 'e2', fields: { summary: 'B' }, seqTo: 2 });

        for (const badSummary of ['', '   \n\t ', undefined, null]) {
            let caught = null;
            try {
                createRollupWithChildren(store, {
                    type: 'event',
                    childIds: [c1.id, c2.id],
                    summary: badSummary,
                });
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeTruthy();
            expect(caught.code).toBe('BAD_ARGS');
        }
    });

    test('createRollupWithChildren writes strictly { summary } onto parent.fields even if extra fields are passed', () => {
        const store = createEmptyStore();
        const c1 = createNode(store, { type: 'moment', title: 'First gift', fields: { when: 'Day 1', detail: 'Gave ribbon', meaning: 'Trust' }, seqTo: 1 });
        const c2 = createNode(store, { type: 'moment', title: 'Rain walk', fields: { when: 'Day 2', detail: 'Shared coat', meaning: 'Warmth' }, seqTo: 2 });

        const parent = createRollupWithChildren(store, {
            type: 'moment',
            childIds: [c1.id, c2.id],
            summary: '  Shared ribbon and rain walk deepened trust.  ',
            fields: { when: 'Day 1-2', extra: 'should not persist' },
            label: 'Memorable moment',
        });

        expect(isRollupNode(parent)).toBe(true);
        expect(Object.keys(parent.fields)).toEqual(['summary']);
        expect(parent.fields.summary).toBe('Shared ribbon and rain walk deepened trust.');
    });
});

describe('summarizeRollupWithLLM', () => {
    test('serializes multi-column L0 leaf columns without phantom summary and calls luker_rpg_summary only', async () => {
        const spec = makeMomentSpec();
        const store = createEmptyStore();
        const m1 = createNode(store, {
            type: 'moment',
            title: 'Lantern exchange',
            fields: { title: 'Lantern exchange', when: 'Night 1', detail: 'Handed over brass lantern', meaning: 'Shared oath' },
            seqTo: 1,
        });
        const m2 = createNode(store, {
            type: 'moment',
            title: 'Harbor departure',
            fields: { title: 'Harbor departure', when: 'Dawn 2', detail: 'Promised to return before winter', meaning: 'Binding vow' },
            seqTo: 2,
        });

        const seenCalls = [];
        const context = {
            generateTask: jest.fn(async (opts) => {
                seenCalls.push(opts);
                return {
                    toolCalls: [{
                        name: 'luker_rpg_summary',
                        args: { summary: '  Brass lantern oath and dawn harbor promise sealed mutual bond.  ' },
                    }],
                };
            }),
        };

        const summary = await summarizeRollupWithLLM(
            context,
            extensionSettingsMock.memory_graph,
            spec,
            'Summarize moments.',
            [m1, m2],
        );

        expect(summary).toBe('Brass lantern oath and dawn harbor promise sealed mutual bond.');
        expect(seenCalls).toHaveLength(1);
        expect(seenCalls[0].tools.map(t => t.function.name)).toEqual(['luker_rpg_summary']);

        const userMsg = seenCalls[0].taskMessages.find(m => m.role === 'user');
        const rows = parsePromptRows(userMsg.content);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row).toHaveProperty('title');
            expect(row).toHaveProperty('when');
            expect(row).toHaveProperty('detail');
            expect(row).toHaveProperty('meaning');
            expect('summary' in row).toBe(false);
        }
        expect(rows[0].when).toBe('Night 1');
        expect(rows[1].detail).toBe('Promised to return before winter');
    });

    test('serializes summary and omits empty leaf columns for L1 rollup nodes', async () => {
        const spec = makeMomentSpec();
        const store = createEmptyStore();
        const r1 = createNode(store, {
            type: 'moment',
            title: 'Memorable moment Summary L1 #1',
            fields: { summary: 'First arc summary.' },
            semanticRollup: true,
            semanticDepth: 1,
            seqTo: 2,
        });
        const r2 = createNode(store, {
            type: 'moment',
            title: 'Memorable moment Summary L1 #2',
            fields: { summary: 'Second arc summary.' },
            semanticRollup: true,
            semanticDepth: 1,
            seqTo: 4,
        });

        const seenCalls = [];
        const context = {
            generateTask: jest.fn(async (opts) => {
                seenCalls.push(opts);
                return {
                    toolCalls: [{ name: 'luker_rpg_summary', args: { summary: 'Merged L2 arc.' } }],
                };
            }),
        };

        const summary = await summarizeRollupWithLLM(
            context,
            extensionSettingsMock.memory_graph,
            spec,
            'Summarize L1 moments.',
            [r1, r2],
        );

        expect(summary).toBe('Merged L2 arc.');
        const rows = parsePromptRows(seenCalls[0].taskMessages.find(m => m.role === 'user').content);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row).toHaveProperty('summary');
            expect('when' in row).toBe(false);
            expect('detail' in row).toBe(false);
            expect('meaning' in row).toBe(false);
        }
        expect(rows[0].summary).toBe('First arc summary.');
        expect(rows[1].summary).toBe('Second arc summary.');
    });

    test('serializes leaf columns for L0 child and summary for L1 child in mixed-depth group', async () => {
        const spec = makeMomentSpec();
        const store = createEmptyStore();
        const l0 = createNode(store, {
            type: 'moment',
            title: 'Bridge meeting',
            fields: { title: 'Bridge meeting', when: 'Night 3', detail: 'Exchanged cipher key', meaning: 'New alliance' },
            seqTo: 3,
        });
        const l1 = createNode(store, {
            type: 'moment',
            title: 'Memorable moment Summary L1 #1',
            fields: { summary: 'Earlier tavern vow.' },
            semanticRollup: true,
            semanticDepth: 1,
            seqTo: 2,
        });

        const seenCalls = [];
        const context = {
            generateTask: jest.fn(async (opts) => {
                seenCalls.push(opts);
                return {
                    toolCalls: [{ name: 'luker_rpg_summary', args: { summary: 'Combined flat arc.' } }],
                };
            }),
        };

        const summary = await summarizeRollupWithLLM(
            context,
            extensionSettingsMock.memory_graph,
            spec,
            'Summarize mixed depths.',
            [l1, l0],
        );

        expect(summary).toBe('Combined flat arc.');
        const rows = parsePromptRows(seenCalls[0].taskMessages.find(m => m.role === 'user').content);
        expect(rows).toHaveLength(2);

        const rollupRow = rows.find(r => r.id === l1.id);
        const leafRow = rows.find(r => r.id === l0.id);
        expect(rollupRow.summary).toBe('Earlier tavern vow.');
        expect('when' in rollupRow).toBe(false);
        expect('detail' in rollupRow).toBe(false);
        expect('meaning' in rollupRow).toBe(false);

        expect(leafRow.when).toBe('Night 3');
        expect(leafRow.detail).toBe('Exchanged cipher key');
        expect(leafRow.meaning).toBe('New alliance');
        expect('summary' in leafRow).toBe(false);
    });

    test('retries whitespace-only summary up to toolCallRetryMax times, throws without fallback, and aborts on first AbortError', async () => {
        const spec = makeMomentSpec();
        const store = createEmptyStore();
        const m1 = createNode(store, { type: 'moment', title: 'M1', fields: { detail: 'D1' }, seqTo: 1 });
        const m2 = createNode(store, { type: 'moment', title: 'M2', fields: { detail: 'D2' }, seqTo: 2 });

        const settingsWithRetries = {
            ...extensionSettingsMock.memory_graph,
            toolCallRetryMax: 2,
        };

        const retryCtx = {
            generateTask: jest.fn(async () => ({
                toolCalls: [{ name: 'luker_rpg_summary', args: { summary: '   \n ' } }],
            })),
        };

        await expect(
            summarizeRollupWithLLM(retryCtx, settingsWithRetries, spec, 'Summarize.', [m1, m2]),
        ).rejects.toThrow();
        expect(retryCtx.generateTask).toHaveBeenCalledTimes(3);

        const abortCtx = {
            generateTask: jest.fn(async () => {
                throw new DOMException('Aborted', 'AbortError');
            }),
        };
        const abortSettings = {
            ...extensionSettingsMock.memory_graph,
            toolCallRetryMax: 3,
        };
        await expect(
            summarizeRollupWithLLM(abortCtx, abortSettings, spec, 'Summarize.', [m1, m2]),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(abortCtx.generateTask).toHaveBeenCalledTimes(1);
    });
});

describe('buildCompressionRuleMatcher', () => {
    test('evaluates leaf-column clauses on L0 leaves and passes them on L1 rollups while checking rollup-applicable clauses at all depths', () => {
        const leafResolved = {
            id: 'q1',
            type: 'quest',
            title: 'Find key',
            semanticRollup: false,
            semanticDepth: 0,
            seqTo: 4,
            fields: { status: 'resolved', summary: '' },
        };
        const leafActive = {
            id: 'q2',
            type: 'quest',
            title: 'Guard gate',
            semanticRollup: false,
            semanticDepth: 0,
            seqTo: 5,
            fields: { status: 'active', summary: 'in progress' },
        };
        const rollupWithSummary = {
            id: 'r1',
            type: 'quest',
            title: 'Quest Summary L1 #1',
            semanticRollup: true,
            semanticDepth: 1,
            seqTo: 6,
            fields: { summary: 'Completed earlier quests.' },
        };
        const rollupAtSeq5 = {
            id: 'r2',
            type: 'quest',
            title: 'Quest Summary L1 #2',
            semanticRollup: true,
            semanticDepth: 1,
            seqTo: 5,
            fields: { summary: '' },
        };

        const statusMatcher = buildCompressionRuleMatcher('status = resolved');
        expect(statusMatcher.valid).toBe(true);
        expect(statusMatcher.test(leafResolved)).toBe(true);
        expect(statusMatcher.test(leafActive)).toBe(false);
        expect(statusMatcher.test(rollupWithSummary)).toBe(true);

        const depthMatcher = buildCompressionRuleMatcher('semantic_depth = 0');
        expect(depthMatcher.test(leafResolved)).toBe(true);
        expect(depthMatcher.test(rollupWithSummary)).toBe(false);

        const isRollupMatcher = buildCompressionRuleMatcher('is_rollup = false');
        expect(isRollupMatcher.test(leafResolved)).toBe(true);
        expect(isRollupMatcher.test(rollupWithSummary)).toBe(false);

        const hasSummaryMatcher = buildCompressionRuleMatcher('has(summary)');
        expect(hasSummaryMatcher.test(leafResolved)).toBe(false);
        expect(hasSummaryMatcher.test(leafActive)).toBe(true);
        expect(hasSummaryMatcher.test(rollupWithSummary)).toBe(true);
        expect(hasSummaryMatcher.test(rollupAtSeq5)).toBe(false);

        const seqMatcher = buildCompressionRuleMatcher('seq_to != 5');
        expect(seqMatcher.test(leafResolved)).toBe(true);
        expect(seqMatcher.test(leafActive)).toBe(false);
        expect(seqMatcher.test(rollupWithSummary)).toBe(true);
        expect(seqMatcher.test(rollupAtSeq5)).toBe(false);
    });
});

describe('runCompressionLoop hierarchical & flat', () => {
    test('compresses moment L0->L1 and L1->L2 into single-summary rollups and unions floorRange in flat compression', async () => {
        const momentSpec = makeMomentSpec({
            compression: {
                mode: 'hierarchical',
                threshold: 2,
                fanIn: 2,
                maxDepth: 2,
                keepRecentLeaves: 0,
                rule: '',
                summarizeInstruction: '',
            },
        });
        const settings = {
            ...extensionSettingsMock.memory_graph,
            nodeTypeSchema: [momentSpec],
        };
        const store = createEmptyStore();
        const m1 = createNode(store, { type: 'moment', title: 'M1', fields: { title: 'M1', when: 'D1', detail: 'A', meaning: 'X' }, seqTo: 1, floorRange: { start: 1, end: 1 } });
        const m2 = createNode(store, { type: 'moment', title: 'M2', fields: { title: 'M2', when: 'D2', detail: 'B', meaning: 'Y' }, seqTo: 2, floorRange: { start: 2, end: 2 } });
        const m3 = createNode(store, { type: 'moment', title: 'M3', fields: { title: 'M3', when: 'D3', detail: 'C', meaning: 'Z' }, seqTo: 3, floorRange: { start: 3, end: 3 } });
        const m4 = createNode(store, { type: 'moment', title: 'M4', fields: { title: 'M4', when: 'D4', detail: 'D', meaning: 'W' }, seqTo: 4, floorRange: { start: 4, end: 4 } });

        let round = 0;
        const context = {
            generateTask: jest.fn(async () => {
                round += 1;
                return { toolCalls: [{ name: 'luker_rpg_summary', args: { summary: `Moment summary #${round}` } }] };
            }),
        };

        const changed = await runCompressionLoop(context, store, settings, { typeIds: ['moment'] });
        expect(changed).toBe(true);
        expect(context.generateTask).toHaveBeenCalledTimes(3);

        const rollups = Object.values(store.nodes).filter(isRollupNode);
        expect(rollups).toHaveLength(3);
        const l1s = rollups.filter(n => n.semanticDepth === 1);
        const l2s = rollups.filter(n => n.semanticDepth === 2);
        expect(l1s).toHaveLength(2);
        expect(l2s).toHaveLength(1);
        for (const r of rollups) {
            expect(Object.keys(r.fields)).toEqual(['summary']);
        }
        expect(l2s[0].floorRange).toEqual({ start: 1, end: 4 });
        expect([m1.parentId, m2.parentId, m3.parentId, m4.parentId].every(Boolean)).toBe(true);

        // Flat compression across mixed depths (add one more L0 leaf and flatten with the L2 root)
        const m5 = createNode(store, { type: 'moment', title: 'M5', fields: { title: 'M5', when: 'D5', detail: 'E', meaning: 'V' }, seqTo: 5, floorRange: { start: 5, end: 5 } });
        const flatChanged = await runCompressionLoop(context, store, settings, { typeIds: ['moment'], flatten: true });
        expect(flatChanged).toBe(true);
        const l3 = Object.values(store.nodes).find(n => n.semanticDepth === 3);
        expect(l3).toBeDefined();
        expect(Object.keys(l3.fields)).toEqual(['summary']);
        expect(l3.floorRange).toEqual({ start: 1, end: 5 });
        expect(l2s[0].parentId).toBe(l3.id);
        expect(m5.parentId).toBe(l3.id);
    });

    test('throws on generateTask failure leaving candidates intact, and recovers on retry call', async () => {
        const momentSpec = makeMomentSpec();
        const settings = {
            ...extensionSettingsMock.memory_graph,
            nodeTypeSchema: [momentSpec],
        };
        const store = createEmptyStore();
        const m1 = createNode(store, { type: 'moment', title: 'M1', fields: { detail: 'A' }, seqTo: 1 });
        const m2 = createNode(store, { type: 'moment', title: 'M2', fields: { detail: 'B' }, seqTo: 2 });

        const failingCtx = {
            generateTask: jest.fn(async () => {
                throw new Error('Upstream unavailable');
            }),
        };
        await expect(runCompressionLoop(failingCtx, store, settings, { typeIds: ['moment'] }))
            .rejects.toThrow('Upstream unavailable');
        expect(m1.parentId).toBe('');
        expect(m2.parentId).toBe('');
        expect(m1.archived).toBe(false);
        expect(m2.archived).toBe(false);
        expect(Object.values(store.nodes).filter(isRollupNode)).toHaveLength(0);

        const succeedingCtx = {
            generateTask: jest.fn(async () => ({
                toolCalls: [{ name: 'luker_rpg_summary', args: { summary: 'Recovered summary.' } }],
            })),
        };
        const changed = await runCompressionLoop(succeedingCtx, store, settings, { typeIds: ['moment'] });
        expect(changed).toBe(true);
        const rollups = Object.values(store.nodes).filter(isRollupNode);
        expect(rollups).toHaveLength(1);
        expect(m1.parentId).toBe(rollups[0].id);
        expect(m2.parentId).toBe(rollups[0].id);
    });

    test('skips automatic compression when autoCompressionEnabled is false', async () => {
        const momentSpec = makeMomentSpec();
        const settings = {
            ...extensionSettingsMock.memory_graph,
            autoCompressionEnabled: false,
            nodeTypeSchema: [momentSpec],
        };
        const store = createEmptyStore();
        createNode(store, { type: 'moment', title: 'M1', fields: { detail: 'A' }, seqTo: 1 });
        createNode(store, { type: 'moment', title: 'M2', fields: { detail: 'B' }, seqTo: 2 });

        const context = {
            generateTask: jest.fn(async () => ({
                toolCalls: [{ name: 'luker_rpg_summary', args: { summary: 'Should not run.' } }],
            })),
        };
        const changed = await runCompressionLoop(context, store, settings, { typeIds: ['moment'] });
        expect(changed).toBe(false);
        expect(context.generateTask).not.toHaveBeenCalled();
        expect(Object.values(store.nodes).filter(isRollupNode)).toHaveLength(0);
    });
});

describe('runExtractionForStore fail-loud batch compression', () => {
    test('rejects when batch 1 compression throws after batch 1 extraction applied, and batch 2 never runs', async () => {
        const eventSpec = getDefaultNodeTypeSchema().find(s => s.id === 'event');
        extensionSettingsMock.memory_graph = {
            ...structuredClone(defaultSettings),
            enabled: true,
            autoCompressionEnabled: true,
            extractBatchTurns: 1,
            extractContextTurns: 1,
            extractExcludeRecentTurns: 0,
            toolCallRetryMax: 0,
            nodeTypeSchema: [{
                ...eventSpec,
                compression: {
                    mode: 'hierarchical',
                    threshold: 2,
                    fanIn: 2,
                    maxDepth: 2,
                    keepRecentLeaves: 0,
                    rule: '',
                    summarizeInstruction: '',
                },
            }],
        };

        const chat = makeChatForTurns(2);
        const store = createEmptyStore();
        let extractCalls = 0;
        let compressionCalls = 0;
        const onBatchAppliedCalls = [];

        const { context } = makeFloorStateHarness(chat, async (opts) => {
            const toolNames = (opts.tools || []).map(t => t.function.name);
            if (toolNames.includes('luker_rpg_summary')) {
                compressionCalls += 1;
                throw new Error('Batch 1 compression failed');
            }
            extractCalls += 1;
            return {
                toolCalls: [
                    { name: 'luker_rpg_extract_event_create', args: { summary: `Batch ${extractCalls} event A`, links: [], no_link_reason: 'standalone event' } },
                    { name: 'luker_rpg_extract_event_create', args: { summary: `Batch ${extractCalls} event B`, links: [], no_link_reason: 'standalone event' } },
                    { name: 'luker_rpg_extract_done', args: {} },
                ],
            };
        });

        await expect(
            runExtractionForStore(context, store, {
                force: true,
                onBatchApplied: async (info) => {
                    onBatchAppliedCalls.push(info);
                },
            }),
        ).rejects.toThrow('Batch 1 compression failed');

        expect(extractCalls).toBe(1);
        expect(compressionCalls).toBe(1);
        expect(onBatchAppliedCalls).toHaveLength(1);
        expect(onBatchAppliedCalls[0].endSeq).toBe(1);

        const events = Object.values(store.nodes).filter(n => n.type === 'event' && !isRollupNode(n));
        expect(events).toHaveLength(2);
        for (const ev of events) {
            expect(ev.parentId).toBe('');
            expect(ev.archived).toBe(false);
        }
        expect(Object.values(store.nodes).filter(isRollupNode)).toHaveLength(0);
    });
});

describe('runManualCompression workingStore isolation & fail-loud commits', () => {
    function makeSeededManualCompressionStore() {
        const store = createEmptyStore();
        applyExtractionOpsImpl(store, [
            { op: 'create', type: 'event', fields: { summary: 'E1' } },
        ], { maxSeq: 1, settings: extensionSettingsMock.memory_graph });
        applyExtractionOpsImpl(store, [
            { op: 'create', type: 'event', fields: { summary: 'E2' } },
        ], { maxSeq: 2, settings: extensionSettingsMock.memory_graph });
        applyExtractionOpsImpl(store, [
            { op: 'create', type: 'event', fields: { summary: 'E3' } },
        ], { maxSeq: 3, settings: extensionSettingsMock.memory_graph });
        applyExtractionOpsImpl(store, [
            { op: 'create', type: 'event', fields: { summary: 'E4' } },
        ], { maxSeq: 4, settings: extensionSettingsMock.memory_graph });
        store.appliedSeqTo = 4;
        store.loggedSeqTo = 4;
        store.seqCounter = 4;
        return store;
    }

    function configureEventSchema({ fanIn = 2, threshold = 2, maxDepth = 1 } = {}) {
        const baseEvent = getDefaultNodeTypeSchema().find(s => s.id === 'event');
        extensionSettingsMock.memory_graph = {
            ...structuredClone(defaultSettings),
            enabled: true,
            autoCompressionEnabled: true,
            toolCallRetryMax: 0,
            nodeTypeSchema: [{
                ...baseEvent,
                compression: {
                    mode: 'hierarchical',
                    threshold,
                    fanIn,
                    maxDepth,
                    keepRecentLeaves: 0,
                    rule: '',
                    summarizeInstruction: '',
                },
            }],
        };
    }

    test('fails on round 1 (completedRounds === 0): calls toastr.error, never toastr.success, leaves cached store untouched', async () => {
        configureEventSchema();
        const chat = makeChatForTurns(4);
        const { context, getFloorState } = makeFloorStateHarness(chat, async () => {
            throw new Error('Round 1 LLM failure');
        });

        await ensureMemoryStoreLoaded(context, { force: true });
        await commitGraphUiMutation(context, getChatKey(context), {
            afterStore: makeSeededManualCompressionStore(),
            replaceGraph: true,
            seq: 4,
        });

        await runManualCompression(context, extensionSettingsMock.memory_graph, {
            selectedTypeIds: ['event'],
            scope: 'all',
            mode: 'force',
            maxRoundsPerType: 5,
        });

        expect(toastrErrors).toHaveLength(1);
        expect(toastrErrors[0]).toMatch(/compress/);
        expect(toastrErrors[0]).toMatch(/Round 1 LLM failure/);
        expect(toastrSuccesses).toEqual([]);

        const cached = JSON.parse(getRawGraphJson(context));
        expect(Object.values(cached.nodes)).toHaveLength(4);
        expect(Object.values(cached.nodes).filter(isRollupNode)).toHaveLength(0);
        const persisted = await getFloorState().get();
        expect(Object.values(persisted.state.nodes).filter(isRollupNode)).toHaveLength(0);
    });

    test('succeeds round 1 then fails round 2: commits round 1 diff and calls toastr.error', async () => {
        configureEventSchema();
        const chat = makeChatForTurns(4);
        let call = 0;
        const { context, getFloorState } = makeFloorStateHarness(chat, async () => {
            call += 1;
            if (call === 1) {
                return { toolCalls: [{ name: 'luker_rpg_summary', args: { summary: 'Round 1 arc' } }] };
            }
            throw new Error('Round 2 LLM failure');
        });

        await ensureMemoryStoreLoaded(context, { force: true });
        await commitGraphUiMutation(context, getChatKey(context), {
            afterStore: makeSeededManualCompressionStore(),
            replaceGraph: true,
            seq: 4,
        });

        await runManualCompression(context, extensionSettingsMock.memory_graph, {
            selectedTypeIds: ['event'],
            scope: 'all',
            mode: 'force',
            maxRoundsPerType: 5,
        });

        expect(toastrErrors).toHaveLength(1);
        expect(toastrErrors[0]).toMatch(/Round 2 LLM failure/);
        expect(toastrSuccesses).toEqual([]);

        const cached = JSON.parse(getRawGraphJson(context));
        const rollups = Object.values(cached.nodes).filter(isRollupNode);
        expect(rollups).toHaveLength(1);
        expect(rollups[0].fields).toEqual({ summary: 'Round 1 arc' });
        expect(Object.values(cached.nodes).filter(n => !isRollupNode(n) && n.parentId === rollups[0].id)).toHaveLength(2);
        expect(Object.values(cached.nodes).filter(n => !isRollupNode(n) && !n.parentId)).toHaveLength(2);

        const persisted = await getFloorState().get();
        expect(Object.values(persisted.state.nodes).filter(isRollupNode)).toHaveLength(1);
    });

    test('succeeds round 1 then aborts on round 2: does not commit and leaves live cached store unchanged', async () => {
        configureEventSchema();
        const chat = makeChatForTurns(4);
        let call = 0;
        const { context, getFloorState } = makeFloorStateHarness(chat, async () => {
            call += 1;
            if (call === 1) {
                return { toolCalls: [{ name: 'luker_rpg_summary', args: { summary: 'Round 1 arc' } }] };
            }
            stopMemoryExtraction();
            throw new DOMException('Aborted', 'AbortError');
        });

        await ensureMemoryStoreLoaded(context, { force: true });
        await commitGraphUiMutation(context, getChatKey(context), {
            afterStore: makeSeededManualCompressionStore(),
            replaceGraph: true,
            seq: 4,
        });

        await runManualCompression(context, extensionSettingsMock.memory_graph, {
            selectedTypeIds: ['event'],
            scope: 'all',
            mode: 'force',
            maxRoundsPerType: 5,
        });

        expect(toastrErrors).toEqual([]);
        expect(toastrSuccesses).toEqual([]);

        const cached = JSON.parse(getRawGraphJson(context));
        expect(Object.values(cached.nodes)).toHaveLength(4);
        expect(Object.values(cached.nodes).filter(isRollupNode)).toHaveLength(0);
        for (const node of Object.values(cached.nodes)) {
            expect(node.parentId).toBe('');
        }

        const persisted = await getFloorState().get();
        expect(Object.values(persisted.state.nodes).filter(isRollupNode)).toHaveLength(0);
    });

    test('succeeds round 1, fails round 2, and partial commit fails: logs console.error and surfaces both errors via toastr.error', async () => {
        configureEventSchema();
        const chat = makeChatForTurns(4);
        let call = 0;
        const { context, getFloorState } = makeFloorStateHarness(chat, async () => {
            call += 1;
            if (call === 1) {
                return { toolCalls: [{ name: 'luker_rpg_summary', args: { summary: 'Round 1 arc' } }] };
            }
            throw new Error('Round 2 LLM failure');
        });

        await ensureMemoryStoreLoaded(context, { force: true });
        await commitGraphUiMutation(context, getChatKey(context), {
            afterStore: makeSeededManualCompressionStore(),
            replaceGraph: true,
            seq: 4,
        });

        const origPatchChatState = context.patchChatState;
        const origUpdateChatState = context.updateChatState;
        context.patchChatState = async () => {
            throw new Error('Disk write failed');
        };
        context.updateChatState = async () => {
            throw new Error('Disk write failed');
        };

        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        let errorCalls = [];
        try {
            await runManualCompression(context, extensionSettingsMock.memory_graph, {
                selectedTypeIds: ['event'],
                scope: 'all',
                mode: 'force',
                maxRoundsPerType: 5,
            });
            errorCalls = consoleErrorSpy.mock.calls.slice();
        } finally {
            context.patchChatState = origPatchChatState;
            context.updateChatState = origUpdateChatState;
            consoleErrorSpy.mockRestore();
        }

        expect(toastrErrors).toHaveLength(2);
        expect(toastrErrors.some(msg => /Failed to save completed compression rounds:/.test(msg) && /Memory save failed/.test(msg))).toBe(true);
        expect(toastrErrors.some(msg => /Memory graph operation failed \(compress\):/.test(msg) && /Round 2 LLM failure/.test(msg))).toBe(true);
        expect(toastrSuccesses).toEqual([]);

        const partialCommitLog = errorCalls.find(
            args => String(args[0]).includes('Failed to commit partial manual compression rounds'),
        );
        expect(partialCommitLog).toBeDefined();
        expect(partialCommitLog[1]).toBeInstanceOf(Error);

        const persisted = await getFloorState().get();
        expect(Object.values(persisted.state.nodes).filter(isRollupNode)).toHaveLength(0);
    });

    test('runs and commits manual compression when autoCompressionEnabled is false', async () => {
        configureEventSchema();
        extensionSettingsMock.memory_graph.autoCompressionEnabled = false;
        const chat = makeChatForTurns(4);
        let call = 0;
        const { context, generateTask, getFloorState } = makeFloorStateHarness(chat, async () => {
            call += 1;
            return { toolCalls: [{ name: 'luker_rpg_summary', args: { summary: `Manual arc #${call}` } }] };
        });

        await ensureMemoryStoreLoaded(context, { force: true });
        await commitGraphUiMutation(context, getChatKey(context), {
            afterStore: makeSeededManualCompressionStore(),
            replaceGraph: true,
            seq: 4,
        });

        await runManualCompression(context, extensionSettingsMock.memory_graph, {
            selectedTypeIds: ['event'],
            scope: 'all',
            mode: 'schema',
            maxRoundsPerType: 5,
        });

        expect(generateTask).toHaveBeenCalledTimes(2);
        expect(toastrErrors).toEqual([]);
        expect(toastrSuccesses).toHaveLength(1);
        expect(toastrSuccesses[0]).toMatch(/Manual compression completed/);

        const cached = JSON.parse(getRawGraphJson(context));
        const rollups = Object.values(cached.nodes).filter(isRollupNode);
        expect(rollups).toHaveLength(2);
        for (const leaf of Object.values(cached.nodes).filter(n => !isRollupNode(n))) {
            expect(leaf.parentId).toBeTruthy();
        }

        const persisted = await getFloorState().get();
        expect(Object.values(persisted.state.nodes).filter(isRollupNode)).toHaveLength(2);
    });
});

describe('orchestrator-tools memory_compact_nodes schema & exec', () => {
    test('memory_compact_nodes schema omits fields and exec forwards only type, childIds, summary', async () => {
        const mod = await import('../../public/scripts/extensions/memory-graph/orchestrator-tools.js');
        const schema = mod.SCHEMAS.find(s => s.name === 'memory_compact_nodes');
        expect(Object.keys(schema.parameters.properties)).toEqual(['type', 'child_ids', 'summary']);
        expect(schema.parameters.required).toEqual(['type', 'child_ids', 'summary']);
        expect(schema.parameters.additionalProperties).toBe(false);

        const compactCalls = [];
        const ctx = {};
        mod.__setSessionForTest(ctx, {
            compactNodes: async (arg) => {
                compactCalls.push(arg);
                return { rollupNodeId: 'n_99' };
            },
        });
        const out = await schema.exec({
            type: 'moment',
            child_ids: ['n_1', 'n_2'],
            summary: 'Compacted summary.',
            fields: { extra: 'ignored' },
        }, ctx);
        expect(out).toEqual({ ok: true, rollup_node_id: 'n_99' });
        expect(compactCalls).toEqual([{
            type: 'moment',
            childIds: ['n_1', 'n_2'],
            summary: 'Compacted summary.',
        }]);
        mod.__clearSessionCacheForTest();
    });
});
