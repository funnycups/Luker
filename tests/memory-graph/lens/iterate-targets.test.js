/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import './_mocks/luker-zh.js';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { clearRegistry } from '../../../public/scripts/iteration-library/storage/target-registry.js';
import {
    runIterateTurn,
    createIterateBus,
    buildTurnChanges,
    commitTurnBatch,
} from '../../../public/scripts/workbench/model/iterate.js';
import { diffUnits } from '../../../public/scripts/workbench/model/units.js';
import { LOREBOOK_READ_TOOL_NAMES } from '../../../public/scripts/iteration-library/tools/lorebook-reads.js';
import { DEFAULT_CONFIG_ITER_SYSTEM_PROMPT } from '../../../public/scripts/extensions/memory-graph/config-iteration/system-prompt.js';
import { DEFAULT_GRAPH_ITER_SYSTEM_PROMPT } from '../../../public/scripts/extensions/memory-graph/graph-iteration/system-prompt.js';
import { normalizeStoreForRuntime } from '../../../public/scripts/extensions/memory-graph/persistence.js';
import { createMemoryGraphTarget, createMemoryConfigTarget } from '../../../public/scripts/extensions/memory-graph/lens/iterate-targets.js';

const mockZhLuker = globalThis.Luker;
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

const DEFAULT_SCHEMA = [
    {
        id: 'event',
        label: 'Event',
        tableName: 'event',
        tableColumns: ['summary', 'location'],
        embeddingColumns: ['summary'],
        columnHints: { summary: 'Concise summary', location: 'Where it happened' },
        requiredColumns: ['summary'],
        primaryKeyColumns: [],
        forceUpdate: true,
        editable: false,
        level: 'semantic',
        extractHint: 'Key events',
        extractionInstructions: 'One event per beat.',
        keywords: [],
        alwaysInject: true,
        latestOnly: false,
        ragPerTypeK: 0,
        recordsFloorRange: true,
        compression: {
            mode: 'hierarchical',
            threshold: 6,
            fanIn: 3,
            maxDepth: 6,
            keepRecentLeaves: 0,
            rule: '',
            summarizeInstruction: 'Summarize concisely.',
        },
    },
    {
        id: 'character_sheet',
        label: 'Character sheet',
        tableName: 'character_sheet',
        tableColumns: ['name', 'traits', 'state'],
        embeddingColumns: ['name', 'traits', 'state'],
        columnHints: { name: 'Canonical name' },
        requiredColumns: ['name'],
        primaryKeyColumns: ['name'],
        forceUpdate: false,
        editable: true,
        level: 'semantic',
        extractHint: 'Character profiles',
        extractionInstructions: 'Track characters.',
        extractEveryN: 2,
        keywords: ['hero'],
        alwaysInject: false,
        latestOnly: true,
        ragPerTypeK: 0,
        recordsFloorRange: false,
        compression: {
            mode: 'none',
            threshold: 6,
            fanIn: 3,
            maxDepth: 6,
            keepRecentLeaves: 0,
            rule: '',
            summarizeInstruction: '',
        },
    },
];

function simpleNormalizeSchema(list) {
    if (!Array.isArray(list) || list.length === 0) return clone(DEFAULT_SCHEMA);
    return list.map((item) => ({
        tableName: item.id,
        tableColumns: ['title'],
        embeddingColumns: Array.isArray(item.embeddingColumns) ? item.embeddingColumns : (item.tableColumns || ['title']),
        columnHints: item.columnHints || {},
        requiredColumns: item.requiredColumns || [],
        primaryKeyColumns: item.primaryKeyColumns || [],
        forceUpdate: Boolean(item.forceUpdate),
        editable: item.editable === undefined ? item.id !== 'event' : Boolean(item.editable),
        level: item.level || 'semantic',
        extractHint: item.extractHint || '',
        extractionInstructions: item.extractionInstructions || '',
        ...(item.forceUpdate ? {} : { extractEveryN: Math.max(1, Number(item.extractEveryN) || 1) }),
        keywords: Array.isArray(item.keywords) ? item.keywords : [],
        alwaysInject: Boolean(item.alwaysInject),
        latestOnly: Boolean(item.latestOnly),
        ragPerTypeK: Number(item.ragPerTypeK) || 0,
        recordsFloorRange: Boolean(item.recordsFloorRange),
        compression: {
            mode: item.compression?.mode || 'none',
            threshold: Number(item.compression?.threshold) || 6,
            fanIn: Number(item.compression?.fanIn) || 3,
            maxDepth: Number(item.compression?.maxDepth) || 6,
            keepRecentLeaves: Number(item.compression?.keepRecentLeaves) || 0,
            rule: item.compression?.rule || '',
            summarizeInstruction: item.compression?.summarizeInstruction || '',
        },
        ...item,
    }));
}

function makeConfigHarness({
    avatar = 'alice.png',
    charName = 'Alice',
    groupId = null,
    schemaOverride = null,
    advancedOverride = null,
    globalSettings = {},
    books = {},
} = {}) {
    const characters = avatar
        ? [{
            avatar,
            name: charName,
            data: {
                extensions: {
                    world: Object.keys(books)[0] || '',
                    memory_graph: {
                        ...(schemaOverride ? { schemaOverride: clone(schemaOverride) } : {}),
                        ...(advancedOverride ? { advancedOverride: clone(advancedOverride) } : {}),
                    },
                },
            },
        }]
        : [];
    const mgSettings = {
        nodeTypeSchema: clone(DEFAULT_SCHEMA),
        recallMaxIterations: 3,
        recentRawTurns: 2,
        ...clone(globalSettings),
    };
    const invalidateMock = jest.fn();
    const syncRegexMock = jest.fn();
    let failSaveSettings = false;
    let failWriteExtension = false;

    const ctx = {
        groupId,
        characterId: avatar ? 0 : -1,
        characters,
        constants: { unset: Symbol.for('test.unset') },
        extensionSettings: { memory_graph: mgSettings },
        translate: (s) => String(s ?? ''),
        getCurrentLocale: () => 'en',
        loadWorldInfo: jest.fn(async (bookName) => books[bookName] ? clone(books[bookName]) : null),
        saveSettings: jest.fn(async (_delay, opts) => {
            if (failSaveSettings) return;
            opts?.onSaved?.();
        }),
        writeExtensionField: jest.fn(async (idx, key, val, opts) => {
            if (failWriteExtension) {
                if (opts?.requireSaved) throw new Error('disk write denied');
                return;
            }
            const ch = characters[idx];
            if (!ch) return;
            ch.data ||= {};
            ch.data.extensions ||= {};
            const cleaned = {};
            for (const [k, v] of Object.entries(val || {})) {
                if (v !== ctx.constants.unset) cleaned[k] = clone(v);
            }
            ch.data.extensions[key] = cleaned;
        }),
    };

    const getCharData = (av) => {
        const ch = characters.find(c => c.avatar === av);
        return ch?.data?.extensions?.memory_graph || {};
    };

    const deps = {
        getSettings: () => mgSettings,
        getDefaultNodeTypeSchema: () => clone(DEFAULT_SCHEMA),
        normalizeNodeTypeSchema: simpleNormalizeSchema,
        invalidateLatestRecallSnapshot: invalidateMock,
        syncGenerationVisibleHistoryRuntimeRegexScripts: syncRegexMock,
        getCharacterSchemaOverrideByAvatar: (_c, av) => {
            const s = getCharData(av).schemaOverride;
            return Array.isArray(s) && s.length ? clone(s) : null;
        },
        getCharacterAdvancedOverrideByAvatar: (_c, av) => {
            const a = getCharData(av).advancedOverride;
            return a && typeof a === 'object' && Object.keys(a).length ? clone(a) : null;
        },
        getEffectiveNodeTypeSchema: (_c, s = mgSettings) => {
            if (!ctx.groupId && ctx.characterId >= 0) {
                const av = characters[ctx.characterId]?.avatar;
                const ov = getCharData(av).schemaOverride;
                if (Array.isArray(ov) && ov.length) return simpleNormalizeSchema(ov);
            }
            return simpleNormalizeSchema(s?.nodeTypeSchema);
        },
        getEffectiveSettings: (_c, s = mgSettings) => {
            const base = { ...s };
            if (!ctx.groupId && ctx.characterId >= 0) {
                const av = characters[ctx.characterId]?.avatar;
                const adv = getCharData(av).advancedOverride;
                if (adv) Object.assign(base, adv);
            }
            return base;
        },
        getSchemaScopeInfo: (_c, s = mgSettings) => {
            const av = !ctx.groupId && ctx.characterId >= 0 ? String(characters[ctx.characterId]?.avatar || '') : '';
            const ov = av ? getCharData(av).schemaOverride : null;
            const hasOverride = Array.isArray(ov) && ov.length > 0;
            return {
                avatar: av,
                hasAvatar: Boolean(av),
                characterName: av ? charName : '',
                hasOverride,
                scope: hasOverride ? 'character' : 'global',
                schema: hasOverride ? simpleNormalizeSchema(ov) : simpleNormalizeSchema(s?.nodeTypeSchema),
            };
        },
        persistCharacterSchemaOverride: jest.fn(async (c, av, schema, opts) => {
            const idx = characters.findIndex(ch => ch.avatar === av);
            if (idx < 0) return false;
            const prev = getCharData(av);
            await c.writeExtensionField(idx, 'memory_graph', { ...prev, schemaOverride: simpleNormalizeSchema(schema) }, opts);
            return true;
        }),
        removeCharacterSchemaOverride: jest.fn(async (c, av, opts) => {
            const idx = characters.findIndex(ch => ch.avatar === av);
            if (idx < 0) return false;
            const prev = getCharData(av);
            if (!Object.hasOwn(prev, 'schemaOverride')) return true;
            await c.writeExtensionField(idx, 'memory_graph', { ...prev, schemaOverride: c.constants.unset }, opts);
            return true;
        }),
        persistCharacterAdvancedOverridePatch: jest.fn(async (c, av, patch = {}, opts) => {
            const idx = characters.findIndex(ch => ch.avatar === av);
            if (idx < 0) return false;
            const prev = getCharData(av);
            const nextAdv = { ...(prev.advancedOverride || {}), ...(patch.set || {}) };
            for (const k of patch.unset || []) delete nextAdv[k];
            await c.writeExtensionField(idx, 'memory_graph', {
                ...prev,
                advancedOverride: Object.keys(nextAdv).length ? nextAdv : c.constants.unset,
            }, opts);
            return true;
        }),
    };

    return {
        ctx,
        deps,
        mgSettings,
        characters,
        invalidateMock,
        syncRegexMock,
        setFailSaveSettings: (v) => { failSaveSettings = v; },
        setFailWriteExtension: (v) => { failWriteExtension = v; },
    };
}

beforeEach(() => {
    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
    }
    document.body.innerHTML = '';
    clearRegistry();
    globalThis.Luker = mockZhLuker;
});

afterEach(() => {
    clearRegistry();
    jest.restoreAllMocks();
});

describe('legacy MG studio files are retired', () => {
    const repoRoot = resolvePath(process.cwd(), '..');

    test('deleted legacy studio.js and studio.css files do not exist', () => {
        expect(existsSync(resolvePath(repoRoot, 'public/scripts/extensions/memory-graph/config-iteration/studio.js'))).toBe(false);
        expect(existsSync(resolvePath(repoRoot, 'public/scripts/extensions/memory-graph/config-iteration/studio.css'))).toBe(false);
        expect(existsSync(resolvePath(repoRoot, 'public/scripts/extensions/memory-graph/graph-iteration/studio.js'))).toBe(false);
        expect(existsSync(resolvePath(repoRoot, 'public/scripts/extensions/memory-graph/graph-iteration/studio.css'))).toBe(false);
    });
});

describe('memory IterateTarget (config + schema)', () => {
    test('scopes reports global always and character only for non-group open character', async () => {
        const h1 = makeConfigHarness({ avatar: 'alice.png' });
        const t1 = createMemoryConfigTarget(() => h1.ctx, h1.deps);
        expect(await t1.scopes(h1.ctx)).toEqual({ global: true, character: true });

        const hGroup = makeConfigHarness({ avatar: 'alice.png', groupId: 'grp_1' });
        const tGroup = createMemoryConfigTarget(() => hGroup.ctx, hGroup.deps);
        expect(await tGroup.scopes(hGroup.ctx)).toEqual({ global: true, character: false });

        const hNone = makeConfigHarness({ avatar: '' });
        const tNone = createMemoryConfigTarget(() => hNone.ctx, hNone.deps);
        expect(await tNone.scopes(hNone.ctx)).toEqual({ global: true, character: false });
    });

    test('reads custom prompt from settings.configIterSystemPrompt (ignoring deprecated schemaIterSystemPrompt)', async () => {
        const h = makeConfigHarness({
            globalSettings: {
                schemaIterSystemPrompt: 'DEPRECATED SCHEMA PROMPT',
                configIterSystemPrompt: 'CUSTOM CONFIG ITER PROMPT',
            },
        });
        const target = createMemoryConfigTarget(() => h.ctx, h.deps);
        const prompt = await target.prompt({}, 'global', h.ctx);
        expect(prompt).toContain('CUSTOM CONFIG ITER PROMPT');
        expect(prompt).not.toContain('DEPRECATED SCHEMA PROMPT');

        const info = await target.promptInfo(h.ctx);
        expect(info.custom).toBe(true);
        expect(info.text).toBe('CUSTOM CONFIG ITER PROMPT');

        // Without configIterSystemPrompt, falls back to DEFAULT_CONFIG_ITER_SYSTEM_PROMPT even if schemaIterSystemPrompt is set
        delete h.mgSettings.configIterSystemPrompt;
        const defaultPrompt = await target.prompt({}, 'global', h.ctx);
        expect(defaultPrompt).toBe(DEFAULT_CONFIG_ITER_SYSTEM_PROMPT);
        expect((await target.promptInfo(h.ctx)).custom).toBe(false);
    });

    test('character scope exposes LOREBOOK_READ_TOOL_DEFS + mg_schema_* + mg_config_* and dispatches lorebook reads via runLorebookReadTool', async () => {
        const h = makeConfigHarness({
            avatar: 'alice.png',
            books: {
                AliceLore: {
                    entries: {
                        1: { uid: 1, comment: 'Magic rule', key: ['mana', 'rune'], content: 'Mana flows through ley lines.', disable: false, constant: true },
                    },
                },
            },
        });
        globalThis.Luker = { getContext: () => h.ctx };
        const target = createMemoryConfigTarget(() => h.ctx, h.deps);

        const globalTools = (await target.tools({}, 'global', h.ctx)).map(t => t.function.name);
        expect(globalTools).toContain('mg_config_list_fields');
        expect(globalTools).toContain('mg_config_read_fields');
        expect(globalTools).toContain('mg_schema_set_node_type');
        for (const lbTool of LOREBOOK_READ_TOOL_NAMES) {
            expect(globalTools).toContain(lbTool);
        }

        const charTools = (await target.tools({}, 'character', h.ctx)).map(t => t.function.name);
        for (const lbTool of LOREBOOK_READ_TOOL_NAMES) {
            expect(charTools).toContain(lbTool);
            expect(target.isRead(lbTool)).toBe(true);
        }

        const loaded = await target.load('character', h.ctx);
        const booksRes = await target.runRead({ id: 'lb1', name: 'world_book_list', args: {} }, loaded.live);
        expect(booksRes.books).toContain('AliceLore');

        const queryRes = await target.runRead({ id: 'lb2', name: 'lorebook_query', args: { book_name: 'AliceLore', text: 'mana' } }, loaded.live);
        expect(queryRes.total_hits).toBe(1);
        expect(queryRes.entries[0].uid).toBe(1);

        const getRes = await target.runRead({ id: 'lb3', name: 'lorebook_get', args: { book_name: 'AliceLore', uids: [1] } }, loaded.live);
        expect(getRes.entries[0].content).toContain('ley lines');

        const listFields = await target.runRead({ id: 'cf1', name: 'mg_config_list_fields', args: { group: 'recall' } }, loaded.live);
        expect(listFields.fields.some(f => f.path === 'settings.recallMaxIterations')).toBe(true);

        const readFields = await target.runRead({ id: 'cf2', name: 'mg_config_read_fields', args: { source: 'working', paths: ['schema[0].id', 'settings.recallMaxIterations'] } }, loaded.live);
        expect(readFields.values['schema[0].id']).toBe('event');
        expect(readFields.values['settings.recallMaxIterations']).toBe(3);
    });

    test('supports all nodeTypeSchemaParams, advanced settings, multi-edit diffUnits, global commit with saveSettingsChecked, and undo', async () => {
        const h = makeConfigHarness({ avatar: '' });
        const target = createMemoryConfigTarget(() => h.ctx, h.deps);
        const loaded = await target.load('global', h.ctx);
        const base = clone(loaded.live);

        // AI edits schema type with all advanced fields + adds a type + updates settings
        let ai = clone(base);
        ai = await target.runEdit({
            id: 'e1',
            name: 'mg_schema_set_node_type',
            args: {
                node_type: {
                    id: 'character_sheet',
                    label: 'Hero Sheet',
                    tableName: 'heroes',
                    tableColumns: ['name', 'traits', 'faction'],
                    embeddingColumns: ['name', 'faction'],
                    primaryKeyColumns: ['name'],
                    extractEveryN: 3,
                    keywords: ['hero', 'ally'],
                    forceUpdate: false,
                    editable: true,
                    extractionInstructions: 'Track faction allegiance carefully.',
                    compression: {
                        mode: 'hierarchical',
                        threshold: 10,
                        fanIn: 4,
                        maxDepth: 5,
                        keepRecentLeaves: 2,
                        summarizeInstruction: 'Fold old profiles.',
                    },
                },
            },
        }, ai);

        ai = await target.runEdit({
            id: 'e2',
            name: 'mg_config_set_fields',
            args: { set: { 'settings.recallMaxIterations': 5 } },
        }, ai);

        const changes = diffUnits(target.units(base), target.units(ai));
        expect(changes.map(c => c.key)).toEqual(expect.arrayContaining(['schema:character_sheet', 'settings:recallMaxIterations']));

        // Selective apply: apply only schema:character_sheet and settings:recallMaxIterations
        const next = target.rebuild(base, ai, ['schema:character_sheet', 'settings:recallMaxIterations']);
        const handle = await target.commit(loaded.target, base, next, ['schema:character_sheet', 'settings:recallMaxIterations']);

        expect(h.mgSettings.recallMaxIterations).toBe(5);
        const savedType = h.mgSettings.nodeTypeSchema.find(t => t.id === 'character_sheet');
        expect(savedType.primaryKeyColumns).toEqual(['name']);
        expect(savedType.extractEveryN).toBe(3);
        expect(savedType.keywords).toEqual(['hero', 'ally']);
        expect(savedType.embeddingColumns).toEqual(['name', 'faction']);
        expect(savedType.extractionInstructions).toBe('Track faction allegiance carefully.');
        expect(savedType.compression).toMatchObject({ mode: 'hierarchical', threshold: 10, fanIn: 4, maxDepth: 5, keepRecentLeaves: 2, summarizeInstruction: 'Fold old profiles.' });
        expect(h.invalidateMock).toHaveBeenCalledTimes(1);
        expect(h.syncRegexMock).toHaveBeenCalledTimes(1);

        // Undo reverts global settings and schema
        await handle.undo();
        expect(h.mgSettings.recallMaxIterations).toBe(3);
        const revertedType = h.mgSettings.nodeTypeSchema.find(t => t.id === 'character_sheet');
        expect(revertedType.extractEveryN).toBe(2);
        expect(h.invalidateMock).toHaveBeenCalledTimes(2);
    });

    test('character scope commit checks expectedAvatar, passes requireSaved: true, writes sparse overrides, and undo removes fresh schema override', async () => {
        const h = makeConfigHarness({ avatar: 'alice.png' });
        const target = createMemoryConfigTarget(() => h.ctx, h.deps);
        const loaded = await target.load('character', h.ctx);
        const base = clone(loaded.live);

        let ai = await target.runEdit({
            id: 'e1',
            name: 'mg_schema_set_node_type',
            args: { node_type: { id: 'quest', label: 'Quest', tableColumns: ['title', 'status'], primaryKeyColumns: ['title'] } },
        }, clone(base));
        ai = await target.runEdit({
            id: 'e2',
            name: 'mg_config_set_fields',
            args: { set: { 'settings.recentRawTurns': 6 } },
        }, ai);

        const keys = diffUnits(target.units(base), target.units(ai)).map(c => c.key);
        const next = target.rebuild(base, ai, keys);
        const handle = await target.commit(loaded.target, base, next, keys);

        expect(h.ctx.writeExtensionField).toHaveBeenCalledWith(
            0,
            'memory_graph',
            expect.objectContaining({
                advancedOverride: { recentRawTurns: 6 },
            }),
            { requireSaved: true },
        );
        expect(h.characters[0].data.extensions.memory_graph.schemaOverride.some(t => t.id === 'quest')).toBe(true);
        // Global settings untouched
        expect(h.mgSettings.recentRawTurns).toBe(2);
        expect(h.mgSettings.nodeTypeSchema.some(t => t.id === 'quest')).toBe(false);
        expect(h.invalidateMock).toHaveBeenCalledTimes(1);

        // If character switched before undo, undo rejects with character-changed
        h.characters[0].avatar = 'bob.png';
        await expect(handle.undo()).rejects.toMatchObject({ code: 'character-changed' });

        // Switch back and undo cleanly: removes schemaOverride because character had none before
        h.characters[0].avatar = 'alice.png';
        await handle.undo();
        expect(h.characters[0].data.extensions.memory_graph.schemaOverride).toBeUndefined();
        expect(h.characters[0].data.extensions.memory_graph.advancedOverride).toBeUndefined();

        // Expected avatar check on commit
        h.characters[0].avatar = 'bob.png';
        await expect(target.commit(loaded.target, base, next, keys)).rejects.toMatchObject({ code: 'character-changed' });
    });

    test('character commit fails closed when writeExtensionField throws under requireSaved: true', async () => {
        const h = makeConfigHarness({ avatar: 'alice.png' });
        h.setFailWriteExtension(true);
        const target = createMemoryConfigTarget(() => h.ctx, h.deps);
        const loaded = await target.load('character', h.ctx);
        const base = clone(loaded.live);
        const ai = await target.runEdit({
            id: 'e1',
            name: 'mg_config_set_fields',
            args: { set: { 'settings.recentRawTurns': 8 } },
        }, clone(base));
        const keys = ['settings:recentRawTurns'];
        await expect(target.commit(loaded.target, base, target.rebuild(base, ai, keys), keys))
            .rejects.toThrow(/disk write denied/);
        expect(h.mgSettings.recentRawTurns).toBe(2);
    });

    test('renderControls provides reset_to_blank and character reset_to_global matching control actions', async () => {
        const charSchema = [clone(DEFAULT_SCHEMA[0])];
        const h = makeConfigHarness({ avatar: 'alice.png', schemaOverride: charSchema });
        const target = createMemoryConfigTarget(() => h.ctx, h.deps);
        const loaded = await target.load('character', h.ctx);
        const onReload = jest.fn();

        const controls = target.renderControls({ live: loaded.live, scope: 'character', settings: {}, onReload });
        expect(controls).toBeInstanceOf(Node);
        const blankBtn = controls.querySelector('[data-wb-memory-control="reset-blank"]');
        const globalBtn = controls.querySelector('[data-wb-memory-control="reset-global"]');
        expect(blankBtn).not.toBeNull();
        expect(globalBtn).not.toBeNull();
        expect(globalBtn.disabled).toBe(false);

        // Click reset_to_blank: next load('character') starts with blank schema shell []
        blankBtn.click();
        expect(onReload).toHaveBeenCalledTimes(1);
        const blankLoaded = await target.load('character', h.ctx);
        expect(blankLoaded.live.schema).toEqual([]);

        // Click reset_to_global: removes character schema override, invalidates snapshot, reloads global
        globalBtn.click();
        await new Promise(r => setTimeout(r, 0));
        expect(h.deps.removeCharacterSchemaOverride).toHaveBeenCalledWith(h.ctx, 'alice.png', { requireSaved: true });
        expect(h.invalidateMock).toHaveBeenCalled();
        expect(onReload).toHaveBeenCalledTimes(2);
        const globalReloaded = await target.load('character', h.ctx);
        expect(globalReloaded.live.schema).toHaveLength(2);

        // AI-callable control tools work too
        const afterBlank = await target.runEdit({ id: 'rb', name: 'luker_mg_schema_reset_live_to_blank', args: {} }, globalReloaded.live);
        expect(afterBlank.schema).toEqual([]);
        expect(afterBlank.settings).toEqual(globalReloaded.live.settings);
    });

    test('renderPreview builds DOM nodes without innerHTML and highlights schema/settings diffs', async () => {
        const h = makeConfigHarness({ avatar: 'alice.png' });
        const target = createMemoryConfigTarget(() => h.ctx, h.deps);
        const loaded = await target.load('character', h.ctx);
        const ai = await target.runEdit({
            id: 'e1',
            name: 'mg_config_set_fields',
            args: { set: { 'settings.recallMaxIterations': 6 } },
        }, clone(loaded.live));
        const preview = target.renderPreview({ base: loaded.live, ai, target: loaded.target });
        expect(preview).toBeInstanceOf(Node);
        expect(preview.textContent).toContain('Event');
        expect(preview.textContent).toContain('召回最大轮数');
        expect(preview.textContent).toContain('6');
    });

    test('surfaces reset-global and reset-blank errors via onError/toastr instead of unhandled rejections', async () => {
        const charSchema = [clone(DEFAULT_SCHEMA[0])];
        const onError = jest.fn();
        const toastrError = jest.fn();
        globalThis.toastr = { error: toastrError };
        const h = makeConfigHarness({ avatar: 'alice.png', schemaOverride: charSchema });
        h.deps.removeCharacterSchemaOverride = jest.fn(async () => false);
        const target = createMemoryConfigTarget(() => h.ctx, { ...h.deps, onError });
        const loaded = await target.load('character', h.ctx);

        const controls = target.renderControls({
            live: loaded.live,
            scope: 'character',
            settings: {},
            onReload: async () => { throw new Error('reload failed'); },
        });
        const blankBtn = controls.querySelector('[data-wb-memory-control="reset-blank"]');
        const globalBtn = controls.querySelector('[data-wb-memory-control="reset-global"]');

        blankBtn.click();
        await new Promise(r => setTimeout(r, 0));
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('reload failed'));

        onError.mockClear();
        globalBtn.click();
        await new Promise(r => setTimeout(r, 0));
        expect(onError).toHaveBeenCalledWith(expect.stringMatching(/Failed to reset character schema override|清除角色配置覆盖失败/));

        // Without deps.onError, falls back to toastr.error
        const targetToast = createMemoryConfigTarget(() => h.ctx, h.deps);
        const controlsToast = targetToast.renderControls({ live: loaded.live, scope: 'character', settings: {}, onReload: jest.fn() });
        controlsToast.querySelector('[data-wb-memory-control="reset-global"]').click();
        await new Promise(r => setTimeout(r, 0));
        expect(toastrError).toHaveBeenCalled();
    });

    test('isolates scope metadata per loaded target across concurrent load() calls and cloned live docs', async () => {
        const h = makeConfigHarness({
            avatar: 'alice.png',
            books: {
                AliceLore: {
                    entries: {
                        1: { uid: 1, comment: 'Rule', key: ['mana'], content: 'Rule text', disable: false, constant: true },
                    },
                },
            },
        });
        globalThis.Luker = { getContext: () => h.ctx };
        const target = createMemoryConfigTarget(() => h.ctx, h.deps);

        const charLoaded = await target.load('character', h.ctx);
        const globalLoaded = await target.load('global', h.ctx);
        await target.tools(globalLoaded.live, 'global', h.ctx);

        // Even after global load + tools(), charLoaded.live still operates in character scope (both via WeakMap and via cloned live + helpers.target)
        const blankViaWeakMap = await target.runEdit({ id: 'rb1', name: 'luker_mg_schema_reset_live_to_blank', args: {} }, charLoaded.live);
        expect(blankViaWeakMap.schema).toEqual([]);

        const booksViaWeakMap = await target.runRead({ id: 'lb1', name: 'world_book_list', args: {} }, blankViaWeakMap);
        expect(booksViaWeakMap.books).toContain('AliceLore');

        const clonedCharLive = clone(charLoaded.live);
        const blankViaTarget = await target.runEdit(
            { id: 'rb2', name: 'luker_mg_schema_reset_live_to_blank', args: {} },
            clonedCharLive,
            { target: charLoaded.target },
        );
        expect(blankViaTarget.schema).toEqual([]);
        const booksViaTarget = await target.runRead(
            { id: 'lb2', name: 'world_book_list', args: {} },
            clone(clonedCharLive),
            { target: charLoaded.target },
        );
        expect(booksViaTarget.books).toContain('AliceLore');
    });

    test('prompt() and tools() read meta.hasOverride without re-calling getSchemaScopeInfo', async () => {
        const h = makeConfigHarness({ avatar: 'alice.png' });
        const scopeSpy = jest.fn(h.deps.getSchemaScopeInfo);
        h.deps.getSchemaScopeInfo = scopeSpy;
        globalThis.Luker = { getContext: () => h.ctx };
        const target = createMemoryConfigTarget(() => h.ctx, h.deps);

        const loaded = await target.load('character', h.ctx);
        expect(scopeSpy).toHaveBeenCalledTimes(1);

        // Prompt and tools use the WeakMap-cached meta without re-querying getSchemaScopeInfo.
        const promptNoOverride = await target.prompt(loaded.live, 'character', h.ctx);
        const toolsNoOverride = (await target.tools(loaded.live, 'character', h.ctx)).map(t => t.function.name);
        expect(scopeSpy).toHaveBeenCalledTimes(1);
        expect(promptNoOverride).toContain('This card has NO schema override yet');
        expect(toolsNoOverride).not.toContain('luker_mg_schema_reset_live_to_global');

        // Explicit extra.target with hasOverride: true drives both prompt and tools without re-querying.
        const explicitTarget = { scope: 'character', avatar: 'alice.png', hasOverride: true };
        const promptOverride = await target.prompt(clone(loaded.live), 'character', h.ctx, { target: explicitTarget });
        const toolsOverride = (await target.tools(clone(loaded.live), 'character', h.ctx, { target: explicitTarget })).map(t => t.function.name);
        expect(scopeSpy).toHaveBeenCalledTimes(1);
        expect(promptOverride).not.toContain('This card has NO schema override yet');
        expect(toolsOverride).toContain('luker_mg_schema_reset_live_to_global');
    });
});

describe('memory_graph IterateTarget (chat scope + graph-revision + vector sync)', () => {
    function makeGraphHarness({
        chatId = 'chat-1.jsonl',
        avatar = 'alice.png',
        initialNodes = {
            n_1: { id: 'n_1', type: 'character_sheet', level: 'semantic', title: 'Alice', seqTo: 1, fields: { name: 'Alice', traits: 'curious' }, archived: false },
            n_2: { id: 'n_2', type: 'location_state', level: 'semantic', title: 'Library', seqTo: 1, fields: { name: 'Library' }, archived: false },
        },
        initialEdges = [],
        vectorSyncShouldFail = false,
        commitSkip = null,
    } = {}) {
        let diskStore = normalizeStoreForRuntime({
            nodes: clone(initialNodes),
            edges: clone(initialEdges),
        });
        let activeChatKey = chatId ? `char:${avatar}:${chatId}` : '';
        const mgSettings = {
            nodeTypeSchema: clone(DEFAULT_SCHEMA),
            graphIterSystemPrompt: '',
            requestApiPresetName: 'Conn1',
            requestLlmPresetName: 'Preset1',
        };
        const commitMock = jest.fn(async (_c, _k, { afterStore }) => {
            if (commitSkip) return commitSkip;
            diskStore = normalizeStoreForRuntime(afterStore);
            return { skipped: false };
        });
        const vectorSyncMock = jest.fn(async () => {
            if (vectorSyncShouldFail) throw new Error('embed server down');
            return { skipped: false };
        });
        const onError = jest.fn();

        const ctx = {
            characterId: avatar ? 0 : -1,
            characters: avatar ? [{ avatar, name: 'Alice', data: { extensions: { world: '' } } }] : [],
            chat: [
                { is_user: true, mes: 'Hello Alice' },
                { is_user: false, mes: 'Alice waved in the library.' },
            ],
            getCurrentChatId: () => chatId,
            resolveChatStateTarget: () => (chatId ? { is_group: false, avatar_url: avatar, file_name: chatId } : null),
            translate: (s) => String(s ?? ''),
            getCurrentLocale: () => 'en',
        };

        const deps = {
            getSettings: () => mgSettings,
            getEffectiveSettings: () => mgSettings,
            getEffectiveNodeTypeSchema: () => clone(DEFAULT_SCHEMA),
            getChatKey: () => activeChatKey,
            ensureStoreSyncedWithChat: jest.fn(async () => (chatId ? normalizeStoreForRuntime(diskStore) : null)),
            commitGraphUiMutation: commitMock,
            syncGraphVectorsAfterMutation: vectorSyncMock,
            readChatRange: jest.fn(() => [{ seq: 1, role: 'assistant', content: 'Alice waved in the library.' }]),
            searchGraphSimilarNodes: jest.fn(async () => [{ nodeId: 'n_1', score: 0.9 }]),
            getMemoryGraphWriteApi: (working) => ({
                createNode: async ({ type, title, fields, links }) => {
                    const id = `n_${Object.keys(working.nodes).length + 1}`;
                    working.nodes[id] = { id, type, level: 'semantic', title: title || id, seqTo: 1, fields: fields || {}, archived: false };
                    for (const l of links || []) {
                        working.edges.push({ from: id, to: l.targetNodeId, type: l.relation });
                    }
                    return { id };
                },
                editNode: async ({ id, setFields, clearFields, title }) => {
                    const n = working.nodes[id];
                    if (!n) return { ok: false, error: { code: 'not_found' } };
                    if (title !== undefined) n.title = title;
                    n.fields ||= {};
                    Object.assign(n.fields, setFields || {});
                    for (const k of clearFields || []) delete n.fields[k];
                    return { ok: true, changed: true };
                },
                deleteNode: async ({ id }) => {
                    delete working.nodes[id];
                    working.edges = working.edges.filter(e => e.from !== id && e.to !== id);
                    return { ok: true };
                },
                archiveNode: async ({ id }) => {
                    if (working.nodes[id]) working.nodes[id].archived = true;
                    return { ok: true };
                },
                upsertLinks: async ({ source, links }) => {
                    let applied = 0;
                    for (const l of links) {
                        const exists = working.edges.some(e => e.from === source.id && e.to === l.targetNodeId && e.type === l.relation);
                        if (!exists) {
                            working.edges.push({ from: source.id, to: l.targetNodeId, type: l.relation });
                            applied++;
                        }
                    }
                    return { applied };
                },
                deleteLinks: async ({ source, target, relation }) => {
                    const before = working.edges.length;
                    working.edges = working.edges.filter(e => !(e.from === source.id && e.to === target.id && e.type === relation));
                    return { removed: before - working.edges.length };
                },
            }),
        };

        return {
            ctx,
            deps,
            mgSettings,
            commitMock,
            vectorSyncMock,
            onError,
            getDiskStore: () => diskStore,
            setChatKey: (k) => { activeChatKey = k; },
        };
    }

    test('scopes enables chat only when active chat exists, and prompt reads graphIterSystemPrompt', async () => {
        const hOpen = makeGraphHarness({ chatId: 'c1.jsonl' });
        const tOpen = createMemoryGraphTarget(() => hOpen.ctx, hOpen.deps);
        expect(await tOpen.scopes(hOpen.ctx)).toEqual({ chat: true });

        expect(await tOpen.prompt({}, 'chat', hOpen.ctx)).toBe(DEFAULT_GRAPH_ITER_SYSTEM_PROMPT);
        hOpen.mgSettings.graphIterSystemPrompt = 'CUSTOM GRAPH PROMPT';
        expect(await tOpen.prompt({}, 'chat', hOpen.ctx)).toBe('CUSTOM GRAPH PROMPT');

        const hClosed = makeGraphHarness({ chatId: '' });
        const tClosed = createMemoryGraphTarget(() => hClosed.ctx, hClosed.deps);
        expect(await tClosed.scopes(hClosed.ctx)).toEqual({ chat: false });
    });

    test('runs multi-round graph read + write via ProposalBus graph-revision, commits, syncs vectors, and supports undo', async () => {
        const h = makeGraphHarness();
        const target = createMemoryGraphTarget(() => h.ctx, { ...h.deps, onError: h.onError });
        const loaded = await target.load('chat', h.ctx);
        const bus = createIterateBus({ proposalKinds: target.proposalKinds });

        let round = 0;
        const turnRes = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'update Alice and link her to Library' }],
            live: clone(loaded.live),
            tools: await target.tools(loaded.live, 'chat', h.ctx),
            bus,
            proposalKinds: target.proposalKinds,
            isRead: (n) => target.isRead(n),
            runRead: (call, live, helpers) => target.runRead(call, live, helpers),
            runEdit: (call, live, helpers) => target.runEdit(call, live, helpers),
            request: async () => {
                round++;
                if (round === 1) {
                    return { text: '', calls: [{ id: 'r1', name: 'mg_graph_list_nodes', args: {} }] };
                }
                if (round === 2) {
                    return {
                        text: '',
                        calls: [
                            { id: 'w1', name: 'mg_graph_edit_node', args: { node_id: 'n_1', set_fields: { traits: 'brave' } } },
                            { id: 'w2', name: 'mg_graph_upsert_links', args: { source_node_id: 'n_1', links: [{ target_node_id: 'n_2', relation: 'occurred_at' }] } },
                        ],
                    };
                }
                return { text: 'Updated Alice and added link.', calls: [] };
            },
        });

        expect(turnRes.reads).toHaveLength(1);
        expect(turnRes.proposalIds).toHaveLength(2);

        const changes = buildTurnChanges({
            base: loaded.live,
            ai: turnRes.live,
            units: target.units,
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: target.proposalKinds,
        });
        expect(changes).toHaveLength(2);
        expect(changes.every(c => c.proposalKind === 'graph-revision')).toBe(true);

        const handle = await commitTurnBatch({
            target,
            targetRef: loaded.target,
            base: loaded.live,
            ai: turnRes.live,
            keys: changes.map(c => c.key),
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: target.proposalKinds,
        });

        expect(h.getDiskStore().nodes.n_1.fields.traits).toBe('brave');
        expect(h.getDiskStore().edges).toEqual([{ from: 'n_1', to: 'n_2', type: 'occurred_at' }]);
        // Node changed -> vector sync called once; edge-only second proposal skipped vector sync
        expect(h.vectorSyncMock).toHaveBeenCalledTimes(1);
        expect(h.onError).not.toHaveBeenCalled();

        // Preview renders staged node and link changes without innerHTML
        const previewEl = target.renderPreview({ base: loaded.live, ai: turnRes.live, target: loaded.target });
        expect(previewEl).toBeInstanceOf(Node);
        expect(previewEl.textContent).toContain('Alice');
        expect(previewEl.textContent).toContain('occurred_at');

        // Undo rolls back both proposals
        await handle.undo();
        expect(h.getDiskStore().nodes.n_1.fields.traits).toBe('curious');
        expect(h.getDiskStore().edges).toEqual([]);
    });

    test('surfaces syncGraphVectorsAfterMutation errors cleanly via onError without failing graph persistence', async () => {
        const h = makeGraphHarness({ vectorSyncShouldFail: true });
        const target = createMemoryGraphTarget(() => h.ctx, { ...h.deps, onError: h.onError });
        const loaded = await target.load('chat', h.ctx);
        const bus = createIterateBus({ proposalKinds: target.proposalKinds });

        let round = 0;
        const turnRes = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'edit Alice' }],
            live: clone(loaded.live),
            tools: await target.tools(loaded.live, 'chat', h.ctx),
            bus,
            proposalKinds: target.proposalKinds,
            isRead: (n) => target.isRead(n),
            runRead: (call, live, helpers) => target.runRead(call, live, helpers),
            runEdit: (call, live, helpers) => target.runEdit(call, live, helpers),
            request: async () => {
                round++;
                if (round === 1) {
                    return { text: '', calls: [{ id: 'w1', name: 'mg_graph_edit_node', args: { node_id: 'n_1', set_fields: { traits: 'bold' } } }] };
                }
                return { text: 'Done.', calls: [] };
            },
        });

        const changes = buildTurnChanges({
            base: loaded.live,
            ai: turnRes.live,
            units: target.units,
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: target.proposalKinds,
        });

        await commitTurnBatch({
            target,
            targetRef: loaded.target,
            base: loaded.live,
            ai: turnRes.live,
            keys: changes.map(c => c.key),
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: target.proposalKinds,
        });

        expect(h.getDiskStore().nodes.n_1.fields.traits).toBe('bold');
        expect(h.onError).toHaveBeenCalledWith(expect.stringContaining('embed server down'));
    });

    test('rejects commit when active chat changed before approval', async () => {
        const h = makeGraphHarness();
        const target = createMemoryGraphTarget(() => h.ctx, { ...h.deps, onError: h.onError });
        const loaded = await target.load('chat', h.ctx);
        const bus = createIterateBus({ proposalKinds: target.proposalKinds });

        let round = 0;
        const turnRes = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'edit Alice' }],
            live: clone(loaded.live),
            tools: await target.tools(loaded.live, 'chat', h.ctx),
            bus,
            proposalKinds: target.proposalKinds,
            isRead: (n) => target.isRead(n),
            runRead: (call, live, helpers) => target.runRead(call, live, helpers),
            runEdit: (call, live, helpers) => target.runEdit(call, live, helpers),
            request: async () => {
                round++;
                if (round === 1) {
                    return { text: '', calls: [{ id: 'w1', name: 'mg_graph_edit_node', args: { node_id: 'n_1', set_fields: { traits: 'bold' } } }] };
                }
                return { text: 'Done.', calls: [] };
            },
        });

        const changes = buildTurnChanges({
            base: loaded.live,
            ai: turnRes.live,
            units: target.units,
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: target.proposalKinds,
        });

        h.setChatKey('char:alice.png:other-chat.jsonl');
        await expect(commitTurnBatch({
            target,
            targetRef: loaded.target,
            base: loaded.live,
            ai: turnRes.live,
            keys: changes.map(c => c.key),
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: target.proposalKinds,
        })).rejects.toThrow();
        expect(h.commitMock).not.toHaveBeenCalled();
    });

    test('memory config targetKey stays invariant across character override creation while distinguishing avatar and scope', async () => {
        const h = makeConfigHarness({ avatar: 'alice.png' });
        const target = createMemoryConfigTarget(() => h.ctx, h.deps);
        const beforeOverride = await target.load('character', h.ctx);
        expect(beforeOverride.target.hasOverride).toBe(false);

        let ai = clone(beforeOverride.live);
        ai = await target.runEdit({
            id: 'e1',
            name: 'mg_schema_set_node_type',
            args: {
                node_type: {
                    id: 'character_sheet',
                    label: 'Hero Sheet',
                    tableName: 'heroes',
                    tableColumns: ['name', 'traits'],
                    embeddingColumns: ['name'],
                },
            },
        }, ai);
        const next = target.rebuild(beforeOverride.live, ai, ['schema:character_sheet']);
        await target.commit(beforeOverride.target, beforeOverride.live, next, ['schema:character_sheet']);

        const afterOverride = await target.load('character', h.ctx);
        expect(afterOverride.target.hasOverride).toBe(true);
        expect(target.targetKey(beforeOverride.target)).toBe(target.targetKey(afterOverride.target));
        expect(target.targetKey(beforeOverride.target)).not.toBe(
            target.targetKey({ scope: 'character', avatar: 'bob.png', hasOverride: true }),
        );
        expect(target.targetKey(beforeOverride.target)).not.toBe(
            target.targetKey({ scope: 'global', avatar: '', hasOverride: false }),
        );
    });
});
