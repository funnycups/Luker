// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';
import { extensionSettingsMock } from './_mocks/main-module-stack.js';

const baseLukerCtx = globalThis.Luker.getContext();
const customLukerCtx = new Proxy({
    constants: {
        promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        promptTypes: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
        wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        unset: Symbol('UNSET_VALUE'),
    },
    resolveChatStateTarget: () => ({
        is_group: false,
        avatar_url: 'avatar.png',
        file_name: 'chat-rollup-projection-write-guard',
    }),
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
let defaultSettings;
let getDefaultNodeTypeSchema;
let createNode;
let createRollupWithChildren;
let isRollupNode;
let buildFocusTablesText;
let buildGraphNodeHints;
let buildGraphNodeRow;
let formatNodeBrief;
let applyExtractionOpsImpl;
let runExtractionForStore;

beforeAll(async () => {
    const persistence = await import('../../public/scripts/extensions/memory-graph/persistence.js');
    createEmptyStore = persistence.createEmptyStore;

    const main = await import('../../public/scripts/extensions/memory-graph/main.js');
    defaultSettings = main.defaultSettings;
    getDefaultNodeTypeSchema = main.getDefaultNodeTypeSchema;
    createNode = main._createNodeForTest;
    createRollupWithChildren = main.createRollupWithChildren;
    isRollupNode = main._isRollupNodeForTest;
    buildFocusTablesText = main._buildFocusTablesTextForTest;
    buildGraphNodeHints = main.buildGraphNodeHints;
    buildGraphNodeRow = main._buildGraphNodeRowForTest;
    formatNodeBrief = main.formatNodeBrief;
    applyExtractionOpsImpl = main.applyExtractionOpsImpl;
    runExtractionForStore = main._runExtractionForStoreForTest;
});

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

function makeSettingsWithSchema(nodeTypeSchema, extra = {}) {
    return {
        ...structuredClone(defaultSettings),
        enabled: true,
        autoCompressionEnabled: false,
        nodeTypeSchema,
        ...extra,
    };
}

beforeEach(() => {
    extensionSettingsMock.memory_graph = makeSettingsWithSchema([
        getDefaultNodeTypeSchema().find(s => s.id === 'event'),
        makeMomentSpec(),
    ]);
});

describe('buildFocusTablesText rollup vs leaf table split', () => {
    test('splits non-single-summary hierarchical type into Summaries rollup table first and leaf table second', () => {
        const momentSpec = makeMomentSpec();
        const settings = makeSettingsWithSchema([momentSpec]);
        const store = createEmptyStore();

        const m1 = createNode(store, {
            type: 'moment',
            title: 'Lantern Walk',
            fields: { title: 'Lantern Walk', when: 'Night 1', detail: 'Crossed the bridge together', meaning: 'Trust formed' },
            seqTo: 1,
        });
        const m2 = createNode(store, {
            type: 'moment',
            title: 'Rain Shelter',
            fields: { title: 'Rain Shelter', when: 'Night 2', detail: 'Shared cloak under eaves', meaning: 'Quiet comfort' },
            seqTo: 2,
        });
        const rollup = createRollupWithChildren(store, {
            type: 'moment',
            childIds: [m1.id, m2.id],
            summary: 'Early evenings built mutual trust.',
        });

        const text = buildFocusTablesText([m1, rollup, m2], settings, { tablePrefix: 'Core' });
        const summaryHeader = '[Table: Core moment_table (Summaries)]';
        const leafHeader = '[Table: Core moment_table]';

        const summaryPos = text.indexOf(summaryHeader);
        const leafPos = text.indexOf(leafHeader);
        expect(summaryPos).toBeGreaterThanOrEqual(0);
        expect(leafPos).toBeGreaterThan(summaryPos);

        const summarySection = text.slice(summaryPos, leafPos).trim();
        const leafSection = text.slice(leafPos).trim();

        expect(summarySection).toBe([
            '[Table: Core moment_table (Summaries)]',
            '| summary |',
            '| --- |',
            '| Early evenings built mutual trust. |',
        ].join('\n'));

        expect(leafSection).toBe([
            '[Table: Core moment_table]',
            '| title | when | detail | meaning |',
            '| --- | --- | --- | --- |',
            '| Lantern Walk | Night 1 | Crossed the bridge together | Trust formed |',
            '| Rain Shelter | Night 2 | Shared cloak under eaves | Quiet comfort |',
        ].join('\n'));

        expect(leafSection).not.toContain('Moment Summary L1 #1');
        expect(leafSection).not.toContain('Early evenings built mutual trust.');
    });

    test('emits only Summaries table when only rollups exist and only leaf table when only leaves exist', () => {
        const momentSpec = makeMomentSpec();
        const settings = makeSettingsWithSchema([momentSpec]);
        const store = createEmptyStore();

        const m1 = createNode(store, {
            type: 'moment',
            title: 'Lantern Walk',
            fields: { title: 'Lantern Walk', when: 'Night 1', detail: 'Crossed the bridge', meaning: 'Trust' },
            seqTo: 1,
        });
        const m2 = createNode(store, {
            type: 'moment',
            title: 'Rain Shelter',
            fields: { title: 'Rain Shelter', when: 'Night 2', detail: 'Shared cloak', meaning: 'Comfort' },
            seqTo: 2,
        });
        const rollup = createRollupWithChildren(store, {
            type: 'moment',
            childIds: [m1.id, m2.id],
            summary: 'Rollup-only arc summary.',
        });

        const rollupsOnly = buildFocusTablesText([rollup], settings, { tablePrefix: 'Core' });
        expect(rollupsOnly).toContain('[Table: Core moment_table (Summaries)]');
        expect(rollupsOnly).not.toContain('[Table: Core moment_table]\n');
        expect(rollupsOnly).toContain('| summary |');
        expect(rollupsOnly).toContain('| Rollup-only arc summary. |');

        const leavesOnly = buildFocusTablesText([m1, m2], settings, { tablePrefix: 'Core' });
        expect(leavesOnly).toContain('[Table: Core moment_table]');
        expect(leavesOnly).not.toContain('(Summaries)');
        expect(leavesOnly).toContain('| title | when | detail | meaning |');
        expect(leavesOnly).toContain('| Lantern Walk | Night 1 | Crossed the bridge | Trust |');
        expect(leavesOnly).toContain('| Rain Shelter | Night 2 | Shared cloak | Comfort |');
    });

    test('keeps single-summary schema (event) in a single table without (Summaries) split', () => {
        const eventSpec = getDefaultNodeTypeSchema().find(s => s.id === 'event');
        const settings = makeSettingsWithSchema([eventSpec]);
        const store = createEmptyStore();

        const e1 = createNode(store, {
            type: 'event',
            title: 'Summary 1',
            fields: { summary: 'Entered the market square.' },
            seqTo: 1,
        });
        const e2 = createNode(store, {
            type: 'event',
            title: 'Summary 2',
            fields: { summary: 'Purchased supplies.' },
            seqTo: 2,
        });
        const e3 = createNode(store, {
            type: 'event',
            title: 'Summary 3',
            fields: { summary: 'Met the courier at dusk.' },
            seqTo: 3,
        });
        const rollup = createRollupWithChildren(store, {
            type: 'event',
            childIds: [e1.id, e2.id],
            summary: 'Market preparations completed.',
        });

        const text = buildFocusTablesText([rollup, e3], settings, { tablePrefix: 'Core' });
        expect(text).not.toContain('(Summaries)');
        expect(text).toBe([
            '[Table: Core event_table]',
            '| summary |',
            '| --- |',
            '| Market preparations completed. |',
            '| Met the courier at dusk. |',
        ].join('\n'));
    });
});

describe('editable projection guard on rollups', () => {
    test('buildGraphNodeHints, buildGraphNodeRow, and formatNodeBrief emit editable: true for leaves and editable: false for rollups', () => {
        const momentSpec = makeMomentSpec({ editable: true });
        const schema = [momentSpec];
        const settings = makeSettingsWithSchema(schema);
        const store = createEmptyStore();

        const m1 = createNode(store, {
            type: 'moment',
            title: 'Leaf One',
            fields: { title: 'Leaf One', when: 'Day 1', detail: 'D1', meaning: 'M1' },
            seqTo: 1,
        });
        const m2 = createNode(store, {
            type: 'moment',
            title: 'Leaf Two',
            fields: { title: 'Leaf Two', when: 'Day 2', detail: 'D2', meaning: 'M2' },
            seqTo: 2,
        });
        const rollup = createRollupWithChildren(store, {
            type: 'moment',
            childIds: [m1.id, m2.id],
            summary: 'Combined moments.',
        });
        const visibleLeaf = createNode(store, {
            type: 'moment',
            title: 'Leaf Three',
            fields: { title: 'Leaf Three', when: 'Day 3', detail: 'D3', meaning: 'M3' },
            seqTo: 3,
        });

        const visibleHints = buildGraphNodeHints(store, schema, 0, { scope: 'visible' });
        const visibleRollupRow = visibleHints.find(row => row.id === rollup.id);
        const visibleLeafRow = visibleHints.find(row => row.id === visibleLeaf.id);
        expect(visibleRollupRow).toBeDefined();
        expect(visibleLeafRow).toBeDefined();
        expect(visibleRollupRow.editable).toBe(false);
        expect(visibleLeafRow.editable).toBe(true);

        const fullHints = buildGraphNodeHints(store, schema, 0, { scope: 'full' });
        expect(fullHints.find(row => row.id === m1.id)?.editable).toBe(true);
        expect(fullHints.find(row => row.id === rollup.id)?.editable).toBe(false);

        const schemaMap = new Map([['moment', momentSpec]]);
        expect(buildGraphNodeRow(m1, schemaMap).editable).toBe(true);
        expect(buildGraphNodeRow(rollup, schemaMap).editable).toBe(false);

        expect(formatNodeBrief(m1, settings).editable).toBe(true);
        expect(formatNodeBrief(rollup, settings).editable).toBe(false);
    });
});

describe('upsertSemanticNode rollup protection on op=create', () => {
    test('does not overwrite rollup when latestOnly=true with matching primaryKeyColumns', () => {
        const momentSpec = makeMomentSpec({
            latestOnly: true,
            primaryKeyColumns: ['title'],
        });
        const settings = makeSettingsWithSchema([momentSpec]);
        const store = createEmptyStore();

        const m1 = createNode(store, {
            type: 'moment',
            title: 'Old One',
            fields: { title: 'Old One', when: 'D1', detail: 'A', meaning: 'X' },
            seqTo: 1,
        });
        const m2 = createNode(store, {
            type: 'moment',
            title: 'Old Two',
            fields: { title: 'Old Two', when: 'D2', detail: 'B', meaning: 'Y' },
            seqTo: 2,
        });
        const rollup = createRollupWithChildren(store, {
            type: 'moment',
            childIds: [m1.id, m2.id],
            summary: 'Rollup summary',
        });

        const res = applyExtractionOpsImpl(store, [{
            op: 'create',
            type: 'moment',
            title: rollup.title,
            fields: { when: 'D3', detail: 'New leaf detail', meaning: 'New leaf meaning' },
        }], { maxSeq: 3, settings });

        expect(res.rejected).toEqual([]);
        expect(res.applied).toHaveLength(1);
        const createdId = res.applied[0].nodeId;
        expect(createdId).toBeTruthy();
        expect(createdId).not.toBe(rollup.id);

        const created = store.nodes[createdId];
        expect(isRollupNode(created)).toBe(false);
        expect(created.title).toBe(rollup.title);
        expect(created.fields.detail).toBe('New leaf detail');

        expect(rollup.archived).toBe(false);
        expect(rollup.fields).toEqual({ summary: 'Rollup summary' });
        expect(rollup.seqTo).toBe(2);
    });

    test('does not overwrite rollup when latestOnly=false with identical title', () => {
        const momentSpec = makeMomentSpec({ latestOnly: false });
        const settings = makeSettingsWithSchema([momentSpec]);
        const store = createEmptyStore();

        const m1 = createNode(store, {
            type: 'moment',
            title: 'Leaf A',
            fields: { title: 'Leaf A', when: 'D1', detail: 'A', meaning: 'X' },
            seqTo: 1,
        });
        const m2 = createNode(store, {
            type: 'moment',
            title: 'Leaf B',
            fields: { title: 'Leaf B', when: 'D2', detail: 'B', meaning: 'Y' },
            seqTo: 2,
        });
        const rollup = createRollupWithChildren(store, {
            type: 'moment',
            childIds: [m1.id, m2.id],
            summary: 'Original rollup summary',
        });

        const res = applyExtractionOpsImpl(store, [{
            op: 'create',
            type: 'moment',
            title: rollup.title,
            fields: { when: 'D3', detail: 'Fresh leaf', meaning: 'Fresh meaning' },
        }], { maxSeq: 3, settings });

        expect(res.rejected).toEqual([]);
        expect(res.applied).toHaveLength(1);
        const createdId = res.applied[0].nodeId;
        expect(createdId).not.toBe(rollup.id);
        expect(isRollupNode(store.nodes[createdId])).toBe(false);
        expect(rollup.fields).toEqual({ summary: 'Original rollup summary' });
        expect(rollup.seqTo).toBe(2);
    });

    test('does not overwrite rollup when explicit nodeId points to a rollup', () => {
        const momentSpec = makeMomentSpec({ latestOnly: false });
        const settings = makeSettingsWithSchema([momentSpec]);
        const store = createEmptyStore();

        const m1 = createNode(store, {
            type: 'moment',
            title: 'Leaf A',
            fields: { title: 'Leaf A', when: 'D1', detail: 'A', meaning: 'X' },
            seqTo: 1,
        });
        const m2 = createNode(store, {
            type: 'moment',
            title: 'Leaf B',
            fields: { title: 'Leaf B', when: 'D2', detail: 'B', meaning: 'Y' },
            seqTo: 2,
        });
        const rollup = createRollupWithChildren(store, {
            type: 'moment',
            childIds: [m1.id, m2.id],
            summary: 'Original rollup summary',
        });

        const res = applyExtractionOpsImpl(store, [{
            op: 'create',
            type: 'moment',
            nodeId: rollup.id,
            title: 'Should Be New Leaf',
            fields: { when: 'D3', detail: 'Leaf content', meaning: 'Leaf meaning' },
        }], { maxSeq: 3, settings });

        expect(res.rejected).toEqual([]);
        expect(res.applied).toHaveLength(1);
        const createdId = res.applied[0].nodeId;
        expect(createdId).not.toBe(rollup.id);
        expect(isRollupNode(store.nodes[createdId])).toBe(false);
        expect(rollup.title).toBe('moment Summary L1 #1');
        expect(rollup.fields).toEqual({ summary: 'Original rollup summary' });
        expect(rollup.seqTo).toBe(2);
    });
});

describe('applyExtractionOpsImpl rollup edit & delete rules', () => {
    function makeRollupStore() {
        const store = createEmptyStore();
        const m1 = createNode(store, {
            type: 'moment',
            title: 'M1',
            fields: { title: 'M1', when: 'D1', detail: 'A', meaning: 'X' },
            seqTo: 1,
        });
        const m2 = createNode(store, {
            type: 'moment',
            title: 'M2',
            fields: { title: 'M2', when: 'D2', detail: 'B', meaning: 'Y' },
            seqTo: 2,
        });
        const rollup = createRollupWithChildren(store, {
            type: 'moment',
            childIds: [m1.id, m2.id],
            summary: 'Initial summary',
        });
        return { store, m1, m2, rollup };
    }

    test('allows edit on rollup summary and top-level title', () => {
        const { store, rollup } = makeRollupStore();
        const res = applyExtractionOpsImpl(store, [{
            op: 'edit',
            nodeId: rollup.id,
            hasTitlePatch: true,
            title: 'Chapter 1',
            setFields: { summary: 'updated summary' },
        }], { maxSeq: 5 });

        expect(res.rejected).toEqual([]);
        expect(res.applied).toHaveLength(1);
        expect(rollup.title).toBe('Chapter 1');
        expect(rollup.fields).toEqual({ summary: 'updated summary' });
        expect(rollup.seqTo).toBe(5);
    });

    test('atomically rejects setFields containing non-summary keys without mutating title or summary', () => {
        const { store, rollup } = makeRollupStore();
        const originalTitle = rollup.title;

        const res = applyExtractionOpsImpl(store, [{
            op: 'edit',
            nodeId: rollup.id,
            hasTitlePatch: true,
            title: 'Should Not Apply',
            setFields: { summary: 'Should Not Apply', detail: 'leaf field' },
        }], { maxSeq: 5 });

        expect(res.applied).toEqual([]);
        expect(res.rejected).toHaveLength(1);
        expect(res.rejected[0].error.code).toBe('ROLLUP_FIELDS_RESTRICTED');
        expect(rollup.title).toBe(originalTitle);
        expect(rollup.fields).toEqual({ summary: 'Initial summary' });
        expect(rollup.seqTo).toBe(2);
    });

    test('atomically rejects clearFields containing non-summary keys without mutating title or summary', () => {
        const { store, rollup } = makeRollupStore();
        const originalTitle = rollup.title;

        const res = applyExtractionOpsImpl(store, [{
            op: 'edit',
            nodeId: rollup.id,
            hasTitlePatch: true,
            title: 'Should Not Apply',
            setFields: { summary: 'Should Not Apply' },
            clearFields: ['detail'],
        }], { maxSeq: 5 });

        expect(res.applied).toEqual([]);
        expect(res.rejected).toHaveLength(1);
        expect(res.rejected[0].error.code).toBe('ROLLUP_FIELDS_RESTRICTED');
        expect(rollup.title).toBe(originalTitle);
        expect(rollup.fields).toEqual({ summary: 'Initial summary' });
        expect(rollup.seqTo).toBe(2);

        const resBareClear = applyExtractionOpsImpl(store, [{
            op: 'edit',
            nodeId: rollup.id,
            clearFields: ['detail'],
        }], { maxSeq: 5 });
        expect(resBareClear.applied).toEqual([]);
        expect(resBareClear.rejected).toHaveLength(1);
        expect(resBareClear.rejected[0].error.code).toBe('ROLLUP_FIELDS_RESTRICTED');
    });

    test('op=delete on a rollup still succeeds', () => {
        const { store, rollup } = makeRollupStore();
        const res = applyExtractionOpsImpl(store, [{
            op: 'delete',
            nodeId: rollup.id,
        }], { maxSeq: 5 });

        expect(res.rejected).toEqual([]);
        expect(res.applied).toHaveLength(1);
        expect(store.nodes[rollup.id]).toBeUndefined();
    });
});

describe('extractNodesWithLLM via runExtractionForStore rollup edit rejection', () => {
    function makeChatContext(turnCount, generateTaskImpl) {
        const chat = [];
        for (let i = 1; i <= turnCount; i += 1) {
            chat.push({ is_user: true, name: 'User', mes: `User turn ${i}` });
            chat.push({ is_user: false, name: 'Guide', mes: `Assistant turn ${i}` });
        }
        return {
            chat,
            characters: [],
            characterId: null,
            worldNames: [],
            generateTask: jest.fn(generateTaskImpl),
        };
    }

    function seedMomentRollupStore() {
        const store = createEmptyStore();
        const m1 = createNode(store, {
            type: 'moment',
            title: 'First Meeting',
            fields: { title: 'First Meeting', when: 'Turn 1', detail: 'Met at gate', meaning: 'Beginning' },
            seqTo: 1,
        });
        const m2 = createNode(store, {
            type: 'moment',
            title: 'Second Pact',
            fields: { title: 'Second Pact', when: 'Turn 2', detail: 'Swore oath', meaning: 'Alliance' },
            seqTo: 2,
        });
        const rollup = createRollupWithChildren(store, {
            type: 'moment',
            childIds: [m1.id, m2.id],
            summary: 'Met and forged an alliance.',
        });
        store.appliedSeqTo = 2;
        store.loggedSeqTo = 2;
        store.seqCounter = 2;
        return { store, m1, m2, rollup };
    }

    test('rejects and retries when LLM tries to edit a moment rollup node, leaving rollup untouched', async () => {
        const momentSpec = makeMomentSpec({ editable: true });
        extensionSettingsMock.memory_graph = makeSettingsWithSchema([momentSpec], {
            extractBatchTurns: 1,
            extractContextTurns: 1,
            extractExcludeRecentTurns: 0,
            toolCallRetryMax: 1,
        });

        const { store, rollup } = seedMomentRollupStore();
        let attempt = 0;
        const capturedPrompts = [];
        const context = makeChatContext(3, async (opts) => {
            attempt += 1;
            capturedPrompts.push(opts.taskMessages);
            if (attempt === 1) {
                return {
                    toolCalls: [
                        {
                            name: 'luker_rpg_extract_moment_edit',
                            args: {
                                node_id: rollup.id,
                                title: 'Mutated Rollup Title',
                                set_fields: { detail: 'tampered leaf detail' },
                            },
                        },
                        { name: 'luker_rpg_extract_done', args: {} },
                    ],
                };
            }
            return {
                toolCalls: [
                    {
                        name: 'luker_rpg_extract_moment_create',
                        args: {
                            title: 'Third Moment',
                            when: 'Turn 3',
                            detail: 'Shared lantern',
                            meaning: 'Warmth',
                        },
                    },
                    { name: 'luker_rpg_extract_done', args: {} },
                ],
            };
        });

        const extracted = await runExtractionForStore(context, store, { force: true });
        expect(extracted).toBe(true);
        expect(context.generateTask).toHaveBeenCalledTimes(2);

        const retryTail = capturedPrompts[1][capturedPrompts[1].length - 1].content;
        expect(retryTail).toContain(`Unknown node_id "${rollup.id}"`);

        expect(rollup.title).toBe('moment Summary L1 #1');
        expect(rollup.fields).toEqual({ summary: 'Met and forged an alliance.' });
        expect(rollup.seqTo).toBe(2);

        const thirdMoment = Object.values(store.nodes).find(n => n.title === 'Third Moment');
        expect(thirdMoment).toBeDefined();
        expect(isRollupNode(thirdMoment)).toBe(false);
    });

    test('throws when retries are exhausted on disallowed rollup edit and leaves rollup untouched', async () => {
        const momentSpec = makeMomentSpec({ editable: true });
        extensionSettingsMock.memory_graph = makeSettingsWithSchema([momentSpec], {
            extractBatchTurns: 1,
            extractContextTurns: 1,
            extractExcludeRecentTurns: 0,
            toolCallRetryMax: 0,
        });

        const { store, rollup } = seedMomentRollupStore();
        const context = makeChatContext(3, async () => ({
            toolCalls: [
                {
                    name: 'luker_rpg_extract_moment_edit',
                    args: {
                        node_id: rollup.id,
                        title: 'Mutated Rollup Title',
                        set_fields: { detail: 'tampered leaf detail' },
                    },
                },
                { name: 'luker_rpg_extract_done', args: {} },
            ],
        }));

        await expect(runExtractionForStore(context, store, { force: true }))
            .rejects.toThrow(`Unknown node_id "${rollup.id}"`);
        expect(context.generateTask).toHaveBeenCalledTimes(1);
        expect(rollup.title).toBe('moment Summary L1 #1');
        expect(rollup.fields).toEqual({ summary: 'Met and forged an alliance.' });
        expect(rollup.seqTo).toBe(2);
    });
});
