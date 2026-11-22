// tests/memory-graph/config-iteration-tools.test.js
//
// Covers the static surface of memory-graph/config-iteration/tools.js:
//   - buildToolCatalog merges the eight tools with the two reset control
//     tools (resetToBlank / resetToGlobal). The legacy continue / finalize
//     control tools were removed — the multi-round loop is program-driven
//     by tool-call presence (any tool call → next round, none → stop).
//   - isMgSchemaControlCall recognizes both reset names; rejects edit tools.
//   - the schema structure tools keep their behavior against the
//     `{ schema, settings }` working document.
//   - read ⊆ write: the read projection never surfaces a field the set
//     tool's JSON schema rejects.
//
// These tests are pure ESM with no DOM access — they hit only the exported
// functions of the tools module, which avoids the popup's browser-only deps.

import { describe, test, expect } from '@jest/globals';

import {
    TOOL_DEFS,
    TOOL_DISPLAY,
    CONTROL_TOOL_NAMES,
    buildToolCatalog,
    isMgSchemaControlCall,
    normalizeToolCallToEdit,
    projectNodeTypeForRead,
} from '../../public/scripts/extensions/memory-graph/config-iteration/tools.js';
import { CONFIG_FIELDS, resolveSettingsForView } from '../../public/scripts/extensions/memory-graph/config-iteration/fields.js';
import { validateParsedToolCalls } from '../../public/scripts/extensions/function-call-runtime.js';

const normalizeNodeTypeSchema = (schema) => (Array.isArray(schema) ? schema : []);

function ctx(live, extra = {}) {
    return {
        live,
        normalizeNodeTypeSchema,
        resolveUnsetBaseline: () => undefined,
        ...extra,
    };
}

function liveConfig(schema, settings = {}) {
    return { schema, settings: resolveSettingsForView(settings) };
}

describe('MG schema — buildToolCatalog', () => {
    test('returns TOOL_DEFS plus the two reset control tools', () => {
        const catalog = buildToolCatalog();
        expect(TOOL_DEFS).toHaveLength(8);
        expect(catalog.length).toBe(TOOL_DEFS.length + 2);
        for (const def of catalog) {
            expect(def.type).toBe('function');
            expect(typeof def.function.name).toBe('string');
        }
    });

    test('includes the three schema structure tools and the five configuration tools', () => {
        const names = buildToolCatalog().map(d => d.function?.name);
        expect(names).toEqual(expect.arrayContaining([
            'mg_schema_set_node_type',
            'mg_schema_remove_node_type',
            'mg_schema_reorder_node_types',
            'mg_config_list_fields',
            'mg_config_read_fields',
            'mg_config_patch_prompt',
            'mg_config_set_fields',
            'mg_schema_patch_text',
        ]));
    });

    test('does NOT include luker_mg_schema_continue_iteration (legacy, removed)', () => {
        const names = buildToolCatalog().map(d => d.function?.name);
        expect(names).not.toContain('luker_mg_schema_continue_iteration');
        expect(CONTROL_TOOL_NAMES.continue).toBeUndefined();
    });

    test('does NOT include luker_mg_schema_finalize_iteration (legacy, removed)', () => {
        const names = buildToolCatalog().map(d => d.function?.name);
        expect(names).not.toContain('luker_mg_schema_finalize_iteration');
        expect(CONTROL_TOOL_NAMES.finalize).toBeUndefined();
    });

    test('includes luker_mg_schema_reset_live_to_blank', () => {
        const names = buildToolCatalog().map(d => d.function?.name);
        expect(names).toContain(CONTROL_TOOL_NAMES.resetToBlank);
        expect(CONTROL_TOOL_NAMES.resetToBlank).toBe('luker_mg_schema_reset_live_to_blank');
    });

    test('includes luker_mg_schema_reset_live_to_global', () => {
        const names = buildToolCatalog().map(d => d.function?.name);
        expect(names).toContain(CONTROL_TOOL_NAMES.resetToGlobal);
        expect(CONTROL_TOOL_NAMES.resetToGlobal).toBe('luker_mg_schema_reset_live_to_global');
    });

    test('every catalog entry has a TOOL_DISPLAY label', () => {
        const catalog = buildToolCatalog();
        for (const def of catalog) {
            expect(TOOL_DISPLAY[def.function.name]).toBeTruthy();
        }
    });

    test('TOOL_DISPLAY covers all ten entries including the read tools', () => {
        expect(Object.keys(TOOL_DISPLAY)).toHaveLength(10);
        expect(TOOL_DISPLAY.mg_config_list_fields).toBeTruthy();
        expect(TOOL_DISPLAY.mg_config_read_fields).toBeTruthy();
        expect(TOOL_DISPLAY.mg_config_patch_prompt).toBeTruthy();
        expect(TOOL_DISPLAY.mg_config_set_fields).toBeTruthy();
        expect(TOOL_DISPLAY.mg_schema_patch_text).toBeTruthy();
    });

    test('reset tools have minimal parameter schemas', () => {
        const catalog = buildToolCatalog();
        const rBlank = catalog.find(d => d.function?.name === CONTROL_TOOL_NAMES.resetToBlank);
        const rGlobal = catalog.find(d => d.function?.name === CONTROL_TOOL_NAMES.resetToGlobal);
        expect(rBlank?.function?.parameters?.type).toBe('object');
        expect(rGlobal?.function?.parameters?.type).toBe('object');
        expect(rBlank?.function?.parameters?.properties?.reason).toBeTruthy();
        expect(rGlobal?.function?.parameters?.properties?.reason).toBeTruthy();
    });
});

describe('MG schema — isMgSchemaControlCall', () => {
    test('returns true for both current reset control tool names', () => {
        expect(isMgSchemaControlCall({ name: 'luker_mg_schema_reset_live_to_blank' })).toBe(true);
        expect(isMgSchemaControlCall({ name: 'luker_mg_schema_reset_live_to_global' })).toBe(true);
    });

    test('returns false for the legacy continue / finalize tools (regression guard)', () => {
        // If the AI emits a legacy continue/finalize call (e.g. from a
        // stale session replayed after the popup inverted to program-driven
        // auto-continue), the runner routes it through onToolCall (not
        // onControlCall) so the absence of a popup-side handler doesn't
        // silently swallow it. The tools themselves are no longer in the
        // catalog.
        expect(isMgSchemaControlCall({ name: 'luker_mg_schema_continue_iteration' })).toBe(false);
        expect(isMgSchemaControlCall({ name: 'luker_mg_schema_finalize_iteration' })).toBe(false);
    });

    test('returns false for edit tools', () => {
        expect(isMgSchemaControlCall({ name: 'mg_schema_set_node_type' })).toBe(false);
        expect(isMgSchemaControlCall({ name: 'mg_schema_remove_node_type' })).toBe(false);
        expect(isMgSchemaControlCall({ name: 'mg_schema_reorder_node_types' })).toBe(false);
        expect(isMgSchemaControlCall({ name: 'mg_config_set_fields' })).toBe(false);
    });

    test('returns false for empty / missing / wrong-namespace names', () => {
        expect(isMgSchemaControlCall({ name: '' })).toBe(false);
        expect(isMgSchemaControlCall({ name: 'luker_cpa_continue_iteration' })).toBe(false);
        expect(isMgSchemaControlCall({})).toBe(false);
        expect(isMgSchemaControlCall(null)).toBe(false);
        expect(isMgSchemaControlCall(undefined)).toBe(false);
    });
});

describe('MG schema — structure tools against { schema, settings }', () => {
    test('mg_schema_set_node_type adds a new entry', async () => {
        const live = liveConfig([{ id: 'character', tableColumns: ['name'] }]);
        const edits = await normalizeToolCallToEdit(
            { name: 'mg_schema_set_node_type', args: { node_type: { id: 'event', tableColumns: ['summary'] } } },
            ctx(live),
        );
        expect(edits).toHaveLength(1);
        expect(edits[0].op).toBe('set');
        expect(edits[0].path).toBe('');
        expect(edits[0].newValue.schema.map(t => t.id)).toEqual(['character', 'event']);
        expect(edits[0].newValue.settings).toEqual(live.settings);
    });

    test('mg_schema_remove_node_type drops an entry', async () => {
        const live = liveConfig([{ id: 'a' }, { id: 'b' }]);
        const edits = await normalizeToolCallToEdit(
            { name: 'mg_schema_remove_node_type', args: { id: 'a' } },
            ctx(live),
        );
        expect(edits[0].newValue.schema.map(e => e.id)).toEqual(['b']);
    });

    test('mg_schema_remove_node_type throws not_allowed when removal would empty the schema', async () => {
        // Policy refusal: schema must keep at least one node type. The
        // executor used to silently `return false` here, collapsing onto
        // the iter-studio's misleading "already matches" noop — the AI
        // never learned the call was rejected and would re-emit the
        // same broken request forever.
        const live = liveConfig([{ id: 'a' }]);
        await expect(normalizeToolCallToEdit(
            { name: 'mg_schema_remove_node_type', args: { id: 'a' } },
            ctx(live),
        )).rejects.toThrow(/not_allowed/);
    });

    test('mg_schema_remove_node_type throws not_found when target id is absent', async () => {
        const live = liveConfig([{ id: 'a' }, { id: 'b' }]);
        await expect(normalizeToolCallToEdit(
            { name: 'mg_schema_remove_node_type', args: { id: 'ghost' } },
            ctx(live),
        )).rejects.toThrow(/not_found/);
    });

    test('mg_schema_remove_node_type throws invalid_args when id is missing / empty', async () => {
        const live = liveConfig([{ id: 'a' }, { id: 'b' }]);
        await expect(normalizeToolCallToEdit(
            { name: 'mg_schema_remove_node_type', args: { id: '' } },
            ctx(live),
        )).rejects.toThrow(/invalid_args/);
    });

    test('mg_schema_set_node_type throws invalid_args when node_type is missing', async () => {
        const live = liveConfig([{ id: 'character' }]);
        await expect(normalizeToolCallToEdit(
            { name: 'mg_schema_set_node_type', args: {} },
            ctx(live),
        )).rejects.toThrow(/invalid_args/);
    });

    test('mg_schema_set_node_type throws invalid_args when node_type.id is empty', async () => {
        const live = liveConfig([{ id: 'character' }]);
        await expect(normalizeToolCallToEdit(
            { name: 'mg_schema_set_node_type', args: { node_type: { id: '', tableColumns: ['x'] } } },
            ctx(live),
        )).rejects.toThrow(/invalid_args/);
    });

    test('mg_schema_reorder_node_types throws invalid_args when ids is empty', async () => {
        const live = liveConfig([{ id: 'a' }, { id: 'b' }]);
        await expect(normalizeToolCallToEdit(
            { name: 'mg_schema_reorder_node_types', args: { ids: [] } },
            ctx(live),
        )).rejects.toThrow(/invalid_args/);
    });

    test('mg_schema_reorder_node_types throws invalid_args when ids do not match the current schema set', async () => {
        const live = liveConfig([{ id: 'a' }, { id: 'b' }]);
        await expect(normalizeToolCallToEdit(
            { name: 'mg_schema_reorder_node_types', args: { ids: ['a', 'c'] } },
            ctx(live),
        )).rejects.toThrow(/invalid_args/);
    });

    test('mg_schema_reorder_node_types reorders by full id list', async () => {
        const live = liveConfig([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
        const edits = await normalizeToolCallToEdit(
            { name: 'mg_schema_reorder_node_types', args: { ids: ['c', 'a', 'b'] } },
            ctx(live),
        );
        expect(edits[0].newValue.schema.map(e => e.id)).toEqual(['c', 'a', 'b']);
    });

    test('reorder with same single id is a no-op (returns [])', async () => {
        const live = liveConfig([{ id: 'a' }]);
        const edits = await normalizeToolCallToEdit(
            { name: 'mg_schema_reorder_node_types', args: { ids: ['a'] } },
            ctx(live),
        );
        expect(edits).toEqual([]);
    });

    test('non-object live returns [] (defensive)', async () => {
        const edits = await normalizeToolCallToEdit(
            { name: 'mg_schema_set_node_type', args: { node_type: { id: 'x' } } },
            ctx(null),
        );
        expect(edits).toEqual([]);
    });

    test('level field is normalized to "semantic" — only valid value per schema', async () => {
        // The MG schema currently supports a single storage tier: "semantic".
        // The prod normalizer in main.js coerces falsy `level` to LEVEL.SEMANTIC
        // (`String(item.level || LEVEL.SEMANTIC)`), so an LLM that emits the
        // legacy `level: 0` (raw-leaves tier) lands as the string "semantic" by
        // the time the edit hits the live schema. This guards against a
        // regression where a tool call leaks a non-string / non-"semantic"
        // value into committed state.
        const normalize = (schema) => (Array.isArray(schema) ? schema : []).map(entry => ({
            ...entry,
            level: String(entry?.level || 'semantic'),
        }));
        const live = liveConfig([{ id: 'character', tableColumns: ['name'], level: 'semantic' }]);
        const edits = await normalizeToolCallToEdit(
            { name: 'mg_schema_set_node_type', args: { node_type: { id: 'event', tableColumns: ['summary'], level: 0 } } },
            ctx(live, { normalizeNodeTypeSchema: normalize }),
        );
        expect(edits).toHaveLength(1);
        const eventEntry = edits[0].newValue.schema.find(e => e.id === 'event');
        expect(eventEntry).toBeDefined();
        expect(eventEntry.level).toBe('semantic');
    });
});

describe('MG schema — read ⊆ write surface', () => {
    // The normalizer emits a superset of the editable surface
    // (compression.rule, ragPerTypeK, recordsFloorRange). The read tool
    // projects through the set tool's JSON schema so the AI can never read
    // a field it cannot write back — the asymmetry that made a set_node_type
    // call fail schema validation even though the model's XML parsed.
    const normalizedNodeType = {
        id: 'character_sheet',
        label: 'Character Sheet',
        tableName: 'character_table',
        tableColumns: ['title'],
        embeddingColumns: ['title'],
        columnHints: { title: 'Canonical name only.' },
        requiredColumns: ['title'],
        primaryKeyColumns: ['title'],
        forceUpdate: false,
        editable: true,
        level: 'semantic',
        extractHint: 'hint',
        extractionInstructions: 'instructions',
        extractEveryN: 1,
        keywords: ['character'],
        alwaysInject: false,
        latestOnly: true,
        // Normalizer-only fields the set schema rejects:
        ragPerTypeK: 3,
        recordsFloorRange: false,
        compression: {
            mode: 'none',
            threshold: 2,
            fanIn: 2,
            maxDepth: 1,
            keepRecentLeaves: 1,
            rule: 'status in resolved',
            summarizeInstruction: '',
        },
    };

    test('projected read output validates against the set tool schema', () => {
        const projected = projectNodeTypeForRead(normalizedNodeType);
        const err = validateParsedToolCalls(
            [{ name: 'mg_schema_set_node_type', args: { node_type: projected } }],
            buildToolCatalog(),
        );
        expect(err).toBeNull();
        // The raw normalized object (with rule / ragPerTypeK) is exactly
        // what used to fail validation.
        const rawErr = validateParsedToolCalls(
            [{ name: 'mg_schema_set_node_type', args: { node_type: normalizedNodeType } }],
            buildToolCatalog(),
        );
        expect(rawErr).toMatch(/unexpected property/);
    });

    test('projection drops normalizer-only fields but keeps the writable surface', () => {
        const projected = projectNodeTypeForRead(normalizedNodeType);
        expect(projected.ragPerTypeK).toBeUndefined();
        expect(projected.recordsFloorRange).toBeUndefined();
        expect(projected.compression.rule).toBeUndefined();
        expect(projected.compression.mode).toBe('none');
        expect(projected.columnHints).toEqual({ title: 'Canonical name only.' });
        expect(projected.id).toBe('character_sheet');
    });

    test('projection keeps extractEveryN on a force-update type (read ⊆ write)', () => {
        const projected = projectNodeTypeForRead({
            ...normalizedNodeType,
            forceUpdate: true,
            extractEveryN: 4,
        });
        expect(Object.prototype.hasOwnProperty.call(projected, 'extractEveryN')).toBe(true);
        expect(projected.extractEveryN).toBe(4);
    });

    test('set_node_type preserves a non-writable compression.rule when editing compression', async () => {
        const live = liveConfig([{ id: 'x', compression: { mode: 'none', rule: 'keep me' } }]);
        const call = {
            name: 'mg_schema_set_node_type',
            args: { node_type: { id: 'x', compression: { mode: 'hierarchical' } } },
        };
        const edits = await normalizeToolCallToEdit(call, ctx(live));
        expect(edits.length).toBe(1);
        const after = edits[0].newValue.schema;
        expect(after[0].compression.mode).toBe('hierarchical');
        expect(after[0].compression.rule).toBe('keep me');
    });

    test('internal compression.rule is not a patchable field', async () => {
        // `compression.summarizeInstruction` is inside the writable surface;
        // `compression.rule` stays internal and is never addressable by id.
        const live = liveConfig([{ id: 'x', compression: { mode: 'none', rule: 'status in resolved' } }]);
        await expect(normalizeToolCallToEdit({
            name: 'mg_schema_patch_text',
            args: {
                id: 'x',
                field: 'compression.rule',
                oldString: 'status',
                newString: 'state',
            },
        }, ctx(live))).rejects.toThrow(/invalid_args/);
    });
});

describe('MG schema — normalizeToolCallToEdit (smoke)', () => {
    test('produces a single set-empty-path edit for an upsert call', async () => {
        const call = {
            function: {
                name: 'mg_schema_set_node_type',
                arguments: JSON.stringify({ node_type: { id: 'character', label: 'Character', tableColumns: ['name'] } }),
            },
        };
        const edits = await normalizeToolCallToEdit(call, ctx(liveConfig([])));
        expect(Array.isArray(edits)).toBe(true);
        expect(edits.length).toBe(1);
        expect(edits[0].op).toBe('set');
        expect(edits[0].path).toBe('');
    });

    test('throws unknown_tool for an unrecognized tool name', async () => {
        // Per the iter-studio noop→error contract (2026-06-23): unknown
        // tool names must surface a real error reply to the AI instead of
        // collapsing onto the misleading "already matches" noop.
        const call = {
            function: {
                name: 'not_a_real_tool',
                arguments: JSON.stringify({}),
            },
        };
        await expect(normalizeToolCallToEdit(call, ctx(liveConfig([]))))
            .rejects.toThrow(/unknown_tool/);
    });
});

describe('CONFIG_FIELDS — unified 2-2-5 defaults and recentRawTurns removal', () => {
    test('registers updateEvery with default 2, extractBatchTurns default 2, llmVisibleRecentMessages default 5, and removes recentRawTurns', () => {
        expect(CONFIG_FIELDS['settings.updateEvery']).toMatchObject({
            key: 'updateEvery',
            group: 'extraction',
            kind: 'int',
            defaultValue: 2,
            min: 1,
        });
        expect(CONFIG_FIELDS['settings.extractBatchTurns'].defaultValue).toBe(2);
        expect(CONFIG_FIELDS['settings.llmVisibleRecentMessages'].defaultValue).toBe(5);
        expect(CONFIG_FIELDS['settings.recentRawTurns']).toBeUndefined();
    });
});
