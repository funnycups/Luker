// tests/mg-schema-iteration/tools.test.js
import { describe, test, expect, beforeAll } from '@jest/globals';

let TOOL_DEFS, TOOL_DISPLAY, normalizeToolCallToEdit, applyToolCallToSandbox, SESSIONS_BUCKET_KEY;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/memory-graph/schema-iteration/tools.js');
    ({ TOOL_DEFS, TOOL_DISPLAY, normalizeToolCallToEdit, applyToolCallToSandbox, SESSIONS_BUCKET_KEY } = mod);
});

const identity = (s) => s;
const callFn = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

describe('MG Schema — tools', () => {
    test('TOOL_DEFS has 3 entries with matching display labels', () => {
        expect(TOOL_DEFS).toHaveLength(3);
        for (const def of TOOL_DEFS) {
            expect(def.type).toBe('function');
            expect(TOOL_DISPLAY[def.function.name]).toBeTruthy();
        }
    });

    test('SESSIONS_BUCKET_KEY is a non-empty string', () => {
        expect(typeof SESSIONS_BUCKET_KEY).toBe('string');
        expect(SESSIONS_BUCKET_KEY.length).toBeGreaterThan(0);
    });

    test('mg_set_node_type adds a new entry', async () => {
        const live = [{ id: 'character', tableColumns: ['name'] }];
        const setTool = TOOL_DEFS.find(d => d.function.name.includes('set'));
        const edits = await normalizeToolCallToEdit(
            callFn(setTool.function.name, { node_type: { id: 'event', tableColumns: ['summary'] } }),
            { live, normalizeNodeTypeSchema: identity },
        );
        expect(edits).toHaveLength(1);
        expect(edits[0].op).toBe('set');
        expect(edits[0].path).toBe('');
        expect(edits[0].newValue.map(t => t.id)).toEqual(['character', 'event']);
    });

    test('mg_remove_node_type drops an entry', async () => {
        const live = [{ id: 'a' }, { id: 'b' }];
        const removeTool = TOOL_DEFS.find(d => d.function.name.includes('remove'));
        const edits = await normalizeToolCallToEdit(
            callFn(removeTool.function.name, { id: 'a' }),
            { live, normalizeNodeTypeSchema: identity },
        );
        expect(edits[0].newValue.map(e => e.id)).toEqual(['b']);
    });

    test('mg_remove_node_type throws not_allowed when removal would empty the schema', async () => {
        // Policy refusal: schema must keep at least one node type. The
        // executor used to silently `return false` here, collapsing onto
        // the iter-studio's misleading "already matches" noop — the AI
        // never learned the call was rejected and would re-emit the
        // same broken request forever.
        const live = [{ id: 'a' }];
        const removeTool = TOOL_DEFS.find(d => d.function.name.includes('remove'));
        await expect(normalizeToolCallToEdit(
            callFn(removeTool.function.name, { id: 'a' }),
            { live, normalizeNodeTypeSchema: identity },
        )).rejects.toThrow(/not_allowed/);
    });

    test('mg_remove_node_type throws not_found when target id is absent', async () => {
        const live = [{ id: 'a' }, { id: 'b' }];
        const removeTool = TOOL_DEFS.find(d => d.function.name.includes('remove'));
        await expect(normalizeToolCallToEdit(
            callFn(removeTool.function.name, { id: 'ghost' }),
            { live, normalizeNodeTypeSchema: identity },
        )).rejects.toThrow(/not_found/);
    });

    test('mg_remove_node_type throws invalid_args when id is missing / empty', async () => {
        const live = [{ id: 'a' }, { id: 'b' }];
        const removeTool = TOOL_DEFS.find(d => d.function.name.includes('remove'));
        await expect(normalizeToolCallToEdit(
            callFn(removeTool.function.name, { id: '' }),
            { live, normalizeNodeTypeSchema: identity },
        )).rejects.toThrow(/invalid_args/);
    });

    test('mg_set_node_type throws invalid_args when node_type is missing', async () => {
        const live = [{ id: 'character' }];
        const setTool = TOOL_DEFS.find(d => d.function.name.includes('set'));
        await expect(normalizeToolCallToEdit(
            callFn(setTool.function.name, {}),
            { live, normalizeNodeTypeSchema: identity },
        )).rejects.toThrow(/invalid_args/);
    });

    test('mg_set_node_type throws invalid_args when node_type.id is empty', async () => {
        const live = [{ id: 'character' }];
        const setTool = TOOL_DEFS.find(d => d.function.name.includes('set'));
        await expect(normalizeToolCallToEdit(
            callFn(setTool.function.name, { node_type: { id: '', tableColumns: ['x'] } }),
            { live, normalizeNodeTypeSchema: identity },
        )).rejects.toThrow(/invalid_args/);
    });

    test('mg_reorder_node_types throws invalid_args when ids is empty', async () => {
        const live = [{ id: 'a' }, { id: 'b' }];
        const reorderTool = TOOL_DEFS.find(d => d.function.name.includes('reorder'));
        await expect(normalizeToolCallToEdit(
            callFn(reorderTool.function.name, { ids: [] }),
            { live, normalizeNodeTypeSchema: identity },
        )).rejects.toThrow(/invalid_args/);
    });

    test('mg_reorder_node_types throws invalid_args when ids do not match the current schema set', async () => {
        const live = [{ id: 'a' }, { id: 'b' }];
        const reorderTool = TOOL_DEFS.find(d => d.function.name.includes('reorder'));
        await expect(normalizeToolCallToEdit(
            callFn(reorderTool.function.name, { ids: ['a', 'c'] }),
            { live, normalizeNodeTypeSchema: identity },
        )).rejects.toThrow(/invalid_args/);
    });

    test('unknown tool name throws unknown_tool', async () => {
        const live = [{ id: 'a' }];
        await expect(normalizeToolCallToEdit(
            callFn('mg_something_unsupported', {}),
            { live, normalizeNodeTypeSchema: identity },
        )).rejects.toThrow(/unknown_tool/);
    });

    test('mg_reorder_node_types reorders by full id list', async () => {
        const live = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const reorderTool = TOOL_DEFS.find(d => d.function.name.includes('reorder'));
        const edits = await normalizeToolCallToEdit(
            callFn(reorderTool.function.name, { ids: ['c', 'a', 'b'] }),
            { live, normalizeNodeTypeSchema: identity },
        );
        expect(edits[0].newValue.map(e => e.id)).toEqual(['c', 'a', 'b']);
    });

    test('reorder with same single id is a no-op (returns [])', async () => {
        const live = [{ id: 'a' }];
        const reorderTool = TOOL_DEFS.find(d => d.function.name.includes('reorder'));
        const edits = await normalizeToolCallToEdit(
            callFn(reorderTool.function.name, { ids: ['a'] }),
            { live, normalizeNodeTypeSchema: identity },
        );
        expect(edits).toEqual([]);
    });

    test('non-array live returns [] (defensive)', async () => {
        const setTool = TOOL_DEFS.find(d => d.function.name.includes('set'));
        const edits = await normalizeToolCallToEdit(
            callFn(setTool.function.name, { node_type: { id: 'x' } }),
            { live: null, normalizeNodeTypeSchema: identity },
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
        const setTool = TOOL_DEFS.find(d => d.function.name.includes('set'));
        // Mirror the live normalizer's level coercion: falsy → "semantic",
        // truthy → stringified. Anything else gets clamped to "semantic" for
        // this test since downstream code rejects non-"semantic" tiers.
        const normalize = (schema) => (Array.isArray(schema) ? schema : []).map(entry => ({
            ...entry,
            level: String(entry?.level || 'semantic'),
        }));
        const edits = await normalizeToolCallToEdit(
            callFn(setTool.function.name, {
                node_type: { id: 'event', tableColumns: ['summary'], level: 0 },
            }),
            { live: [{ id: 'character', tableColumns: ['name'], level: 'semantic' }], normalizeNodeTypeSchema: normalize },
        );
        expect(edits).toHaveLength(1);
        const eventEntry = edits[0].newValue.find(e => e.id === 'event');
        expect(eventEntry).toBeDefined();
        expect(eventEntry.level).toBe('semantic');
    });
});
